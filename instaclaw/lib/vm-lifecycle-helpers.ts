/**
 * Helpers for the vm-lifecycle cron's Pass -1 (orphan reconciliation).
 *
 * Kept in a separate module from the route so the logic is unit-testable
 * and so the route file stays readable. See:
 *   - instaclaw/docs/prd-vm-cost-optimization.md (full spec)
 *   - instaclaw/app/api/cron/vm-lifecycle/route.ts (caller)
 */

import { connectSSH } from "./ssh";
import { logger } from "./logger";
import type { SupabaseClient } from "@supabase/supabase-js";

// ─── Constants ───────────────────────────────────────────────────────────

/**
 * Linode IDs we never touch — production infrastructure that doesn't have
 * an instaclaw_vms row by design (proxies, monitoring host).
 *
 * Hard-coded rather than DB-driven because: (a) these don't change often,
 * (b) DB-driven config could be corrupted/empty leading to mass deletion,
 * (c) belt-and-suspenders alongside whatever protected_resources table
 * we may add later.
 */
export const PROTECTED_INFRA_LINODE_IDS = new Set<string>([
  "93105031", // instaclaw-clob-proxy   (Toronto Polymarket proxy)
  "94293064", // clob-proxy-osaka       (Osaka backup proxy)
  "95430641", // instaclaw-monitoring   (Prometheus / Grafana host)
]);

/** Min Linode age before we'll consider it a candidate for orphan delete.
 *  Avoids race with replenish-pool: a brand-new Linode that just got
 *  created may not yet have a DB row inserted. 30 minutes is plenty of
 *  margin for the Linode → DB write cycle. */
export const ORPHAN_MIN_AGE_MINUTES = 30;

/** SSH activity check window — any session/workspace file modified inside
 *  this window means the user has been active recently and we should NOT
 *  touch the VM. */
export const ACTIVITY_WINDOW_DAYS = 7;

/** Per-cron-run cap on Pass -1 deletes. Same as MAX_DELETIONS_PER_CYCLE
 *  in the route, kept separately for clarity. Phase 2 ships conservative; we
 *  can lift this later. */
export const MAX_ORPHAN_DELETES_PER_RUN = 20;

const LINODE_PRICING: Record<string, number> = {
  "g6-nanode-1": 5, "g6-standard-1": 12, "g6-standard-2": 24,
  "g6-standard-4": 48, "g6-dedicated-2": 29, "g6-dedicated-4": 60,
  "g6-dedicated-8": 120, "g6-dedicated-16": 240,
};
export const linodeCost = (t: string) => LINODE_PRICING[t] ?? 30;

// ─── Types ───────────────────────────────────────────────────────────────

export interface LinodeInstance {
  id: number; label: string; status: string; type: string;
  created: string; ipv4: string[]; tags: string[];
}

export interface VmLifecycleSettings {
  orphanReconciliationEnabled: boolean;
  vmLifecycleV2Enabled: boolean;
}

// ─── Linode API helpers ──────────────────────────────────────────────────

async function linodeFetch(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`https://api.linode.com/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.LINODE_API_TOKEN}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok && res.status !== 200 && res.status !== 204) {
    const body = await res.text().catch(() => "");
    throw new Error(`Linode ${init?.method ?? "GET"} ${path} → HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export async function listAllLinodes(): Promise<LinodeInstance[]> {
  const all: LinodeInstance[] = [];
  let page = 1;
  while (true) {
    const d = (await linodeFetch(`/linode/instances?page=${page}&page_size=100`)) as {
      data: LinodeInstance[]; page: number; pages: number;
    };
    const items = d.data ?? [];
    if (!items.length) break;
    all.push(...items);
    if ((d.page ?? 1) >= (d.pages ?? 1)) break;
    page++;
  }
  return all;
}

export async function deleteLinodeInstance(linodeId: number): Promise<void> {
  await linodeFetch(`/linode/instances/${linodeId}`, { method: "DELETE" });
}

// ─── Settings reader ─────────────────────────────────────────────────────

/**
 * Read both lifecycle kill switches in a single round-trip. Cached values
 * are not used; every cron invocation re-reads so admin can flip a switch
 * in the dashboard and have it take effect on the NEXT run (≤6 hours).
 */
export async function readLifecycleSettings(
  supabase: SupabaseClient
): Promise<VmLifecycleSettings> {
  const { data } = await supabase
    .from("instaclaw_admin_settings")
    .select("setting_key, bool_value")
    .in("setting_key", ["orphan_reconciliation_enabled", "vm_lifecycle_v2_enabled"]);

  const map = new Map<string, boolean>();
  for (const row of data ?? []) {
    map.set(row.setting_key as string, row.bool_value === true);
  }

  return {
    orphanReconciliationEnabled: map.get("orphan_reconciliation_enabled") ?? false,
    vmLifecycleV2Enabled: map.get("vm_lifecycle_v2_enabled") ?? false,
  };
}

// ─── SSH activity check ──────────────────────────────────────────────────

/**
 * Returns true if the VM has had any session OR workspace file modified
 * within the last `windowDays` days. Used as a "user has been active
 * recently" check before any destructive action.
 *
 * On SSH failure (timeout, auth fail, host down), returns FALSE — these
 * orphans are precisely the ones with broken/stale OpenClaw and no real
 * user data. False is the safe default for pure orphans, but be cautious
 * if extending this to non-orphan code paths.
 */
export async function sshHasRecentActivity(
  ip: string,
  windowDays: number = ACTIVITY_WINDOW_DAYS,
  timeoutMs: number = 15_000,
): Promise<{ active: boolean; reason: string }> {
  if (!ip) return { active: false, reason: "no-ipv4" };
  const vmRecord = { id: ip, ip_address: ip, ssh_port: 22, ssh_user: "openclaw" };
  let ssh: Awaited<ReturnType<typeof connectSSH>> | null = null;
  // Track whether the timeout fired so we can dispose any SSH connection
  // that resolves AFTER we've given up. Without this the connection leaks
  // (Promise.race doesn't cancel losing branches).
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const connectPromise = connectSSH(
      vmRecord as Parameters<typeof connectSSH>[0],
      { skipDuplicateIPCheck: true },
    ).then((conn) => {
      if (timedOut) {
        // Race already lost. Don't leak — dispose immediately.
        try { conn?.dispose?.(); } catch { /* noop */ }
      }
      return conn;
    });
    ssh = (await Promise.race([
      connectPromise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error("ssh-connect-timeout"));
        }, timeoutMs);
      }),
    ])) as Awaited<ReturnType<typeof connectSSH>>;
    if (timer) clearTimeout(timer);
    const cmd =
      `find ~/.openclaw/agents/main/sessions -mtime -${windowDays} -name '*.jsonl' 2>/dev/null | head -1; ` +
      `find ~/.openclaw/workspace -mtime -${windowDays} -name '*.md' 2>/dev/null | head -1`;
    const r = await ssh.execCommand(cmd);
    const out = (r.stdout || "").trim();
    if (out) return { active: true, reason: `recent-files: ${out.split("\n")[0].slice(0, 100)}` };
    return { active: false, reason: "silent" };
  } catch (err) {
    return { active: false, reason: `ssh-fail: ${(err as Error).message.slice(0, 80)}` };
  } finally {
    if (timer) clearTimeout(timer);
    try { ssh?.dispose?.(); } catch { /* noop */ }
  }
}

// ─── Stripe re-check (authoritative) ─────────────────────────────────────

/**
 * Returns true if the user has an active or trialing Stripe subscription
 * RIGHT NOW. We re-check this in every safety-critical decision rather
 * than trusting cached `instaclaw_subscriptions` rows because webhook
 * lag can leave the cache stale by minutes-to-hours.
 *
 * Fail-CLOSED on errors: if the query fails (network, table missing,
 * schema-cache miss, etc.), we return TRUE — i.e., treat the user as if
 * they have a live sub so we DO NOT delete their VM during a partial
 * outage. Loud log so the failure is visible.
 */
export async function userHasLiveSubscription(
  supabase: SupabaseClient,
  userId: string | null,
): Promise<boolean> {
  if (!userId) return false;
  // Note: `instaclaw_subscriptions` IS the cached row — but it's the best
  // we have without a real Stripe SDK call. The webhook should keep it
  // current. If we see issues with stale data, swap this for a direct
  // Stripe API call (slower, costlier).
  // PostgREST returns code PGRST116 when zero rows — that's expected for
  // users who never paid (legitimately no sub). All OTHER errors are
  // failures we must fail-closed on.
  try {
    const { data, error } = await supabase
      .from("instaclaw_subscriptions")
      .select("status")
      .eq("user_id", userId)
      .single();
    if (error) {
      if (error.code === "PGRST116") return false; // no row → no sub
      logger.error("userHasLiveSubscription: query failed, FAILING CLOSED", {
        userId, code: error.code, message: error.message,
      });
      return true; // ← fail closed; pretend user IS paying so we skip
    }
    return data?.status === "active" || data?.status === "trialing";
  } catch (err) {
    logger.error("userHasLiveSubscription: threw, FAILING CLOSED", {
      userId, error: err instanceof Error ? err.message : String(err),
    });
    return true; // ← fail closed
  }
}

/**
 * Returns true if the VM record indicates a non-zero credit balance.
 * Wraps the trivial check in a function so callers don't repeat the
 * `?? 0` defensiveness. Per PRD safety rule 3: any VM whose user has
 * paid-in credits (including World mini app users) MUST be skipped from
 * destructive lifecycle operations.
 */
export function vmHasCredits(creditBalance: number | null | undefined): boolean {
  return (creditBalance ?? 0) > 0;
}

// ─── Forensic log writer ─────────────────────────────────────────────────

export interface OrphanLogEntry {
  linodeId: number;
  vmLabel: string | null;
  vmDbId: string | null;
  userId: string | null;
  userEmail: string | null;
  action:
    | "delete_db_dead"
    | "delete_no_db"
    | "delete_failed"
    | "skip_active"
    | "skip_credits"
    | "skip_safety"
    | "skip_too_young"
    | "skip_infra"
    | "skip_locked"
    | "skip_bad_date";
  reason: string;
  linodeCreatedAt: string | null;
  linodeTags: string[] | null;
  linodeType: string | null;
  monthlyCostUsd: number | null;
  runId: string;
  dryRun: boolean;
}

export async function logOrphan(
  supabase: SupabaseClient,
  entry: OrphanLogEntry,
): Promise<void> {
  try {
    await supabase.from("instaclaw_orphan_deletion_log").insert({
      linode_id: entry.linodeId,
      vm_label: entry.vmLabel,
      vm_db_id: entry.vmDbId,
      user_id: entry.userId,
      user_email: entry.userEmail,
      action: entry.action,
      reason: entry.reason,
      linode_created_at: entry.linodeCreatedAt,
      linode_tags: entry.linodeTags,
      linode_type: entry.linodeType,
      monthly_cost_usd: entry.monthlyCostUsd,
      run_id: entry.runId,
      cron_route: "cron/vm-lifecycle",
      dry_run: entry.dryRun,
    });
  } catch (err) {
    logger.error("vm-lifecycle: failed to write orphan log", {
      route: "cron/vm-lifecycle",
      runId: entry.runId,
      linodeId: entry.linodeId,
      error: String(err),
    });
  }
}

// Phase 2 — migration applied to production 2026-04-27, build retrigger.
