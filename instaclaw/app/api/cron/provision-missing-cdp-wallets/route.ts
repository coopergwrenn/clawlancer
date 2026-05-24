import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { provisionCdpWallet, isCdpConfigured } from "@/lib/cdp-wallet";
import { connectSSH } from "@/lib/ssh";

/**
 * Continuous safety net for CDP backup wallet coverage.
 *
 * Every 30 min, scan VMs that have status='assigned' but no
 * cdp_wallet_address and re-run provisionCdpWallet for them. Mirrors
 * /api/cron/provision-missing-bankr-wallets shape and concurrency.
 *
 * Three failure modes this catches:
 *   1. The vm/assign call to provisionCdpWallet returned null at
 *      assignment time (transient CDP API hiccup, missing env, etc.).
 *      DB stayed NULL. This run retries; if CDP is now configured
 *      and reachable, succeeds.
 *   2. Stripe webhook fired its CDP call but the DB write lost a
 *      race with another writer. Same as #1.
 *   3. Backfill for the existing fleet — every VM provisioned BEFORE
 *      this code shipped (~all current paying users) has
 *      cdp_wallet_address = NULL. This cron mints fresh CDP wallets
 *      for them at ~50 VMs per 30-min cycle.
 *
 * After provisioning, SSHes to write CDP_WALLET_ADDRESS to
 * ~/.openclaw/.env. Doesn't restart the gateway — the agent picks up
 * the env on the next session boundary, and the WALLET.md gets
 * rewritten on the next reconcile/file-drift cycle (Rule 47) so the
 * Bankr Outage Fallback instructions appear within ~5 min of the
 * .env line landing.
 *
 * CRITICAL DESIGN: NO isBankrMaintenance() gate. CDP is the precise
 * thing that backs Bankr up. Skipping this cron during a Bankr
 * outage would defeat the whole purpose. Mirrors the inverse of
 * /api/cron/provision-missing-bankr-wallets's maintenance gate.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CRON_NAME = "provision-missing-cdp-wallets";
const LOCK_TTL_SECONDS = 360;
const CONCURRENCY = 3;
const PER_RUN_LIMIT = 50;

interface CandidateVm {
  id: string;
  assigned_to: string;
  ip_address: string | null;
  ssh_port: number | null;
  ssh_user: string | null;
  cdp_wallet_address: string | null;
}

type ProcessResult =
  | { vmId: string; status: "provisioned" }
  | { vmId: string; status: "already-existed" }
  | { vmId: string; status: "env-only-fixup" }
  | { vmId: string; status: "skipped-no-ip" }
  | { vmId: string; status: "provision-null" }
  | { vmId: string; status: "ssh-failed"; error: string }
  | { vmId: string; status: "env-write-failed"; error: string };

/**
 * Idempotent .env update via grep/sed: replaces an existing
 * CDP_WALLET_ADDRESS line or appends a new one. Verifies the final
 * line count and returns ok/error. Same shape as the Bankr writeEnv.
 */
async function writeEnv(vm: CandidateVm, evmAddress: string): Promise<{ ok: boolean; error?: string }> {
  if (!vm.ip_address) return { ok: false, error: "no ip" };
  let ssh;
  try {
    ssh = await connectSSH({
      id: vm.id,
      ip_address: vm.ip_address,
      ssh_port: vm.ssh_port ?? 22,
      ssh_user: vm.ssh_user ?? "openclaw",
    });
  } catch (e: unknown) {
    return { ok: false, error: `ssh: ${e instanceof Error ? e.message : String(e)}` };
  }
  try {
    const r = await ssh.execCommand([
      'touch "$HOME/.openclaw/.env"',
      `A=${JSON.stringify(evmAddress)}`,
      'grep -q "^CDP_WALLET_ADDRESS=" "$HOME/.openclaw/.env" && sed -i "s|^CDP_WALLET_ADDRESS=.*|CDP_WALLET_ADDRESS=$A|" "$HOME/.openclaw/.env" || echo "CDP_WALLET_ADDRESS=$A" >> "$HOME/.openclaw/.env"',
      'chmod 600 "$HOME/.openclaw/.env"',
      'grep -E "^CDP_WALLET_ADDRESS=" "$HOME/.openclaw/.env" | wc -l',
    ].join('\n'));
    const count = parseInt((r.stdout || "0").trim(), 10);
    if (count < 1) return { ok: false, error: `expected 1 CDP_WALLET_ADDRESS line, got ${count}` };
    return { ok: true };
  } finally {
    ssh.dispose();
  }
}

async function processVm(vm: CandidateVm): Promise<ProcessResult> {
  if (!vm.ip_address) return { vmId: vm.id, status: "skipped-no-ip" };

  // CASE 1: already has a CDP wallet address but maybe not in .env —
  // run writeEnv only (no API call). Covers the "DB write succeeded,
  // SSH write failed at original provision time" case.
  if (vm.cdp_wallet_address) {
    const w = await writeEnv(vm, vm.cdp_wallet_address);
    return w.ok
      ? { vmId: vm.id, status: "env-only-fixup" }
      : { vmId: vm.id, status: "env-write-failed", error: w.error ?? "unknown" };
  }

  // CASE 2: needs a fresh CDP wallet. provisionCdpWallet handles its
  // own DB-first idempotency (so a race with vm/assign doesn't double-mint),
  // returns null on any non-fatal failure.
  const result = await provisionCdpWallet({
    vmId: vm.id,
    userId: vm.assigned_to,
  });
  if (!result) return { vmId: vm.id, status: "provision-null" };

  const w = await writeEnv(vm, result.evmAddress);
  if (!w.ok) {
    return { vmId: vm.id, status: "env-write-failed", error: w.error ?? "unknown" };
  }
  return {
    vmId: vm.id,
    status: result.alreadyExisted ? "already-existed" : "provisioned",
  };
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Silent skip when CDP env vars are absent (e.g., rolled-back env).
  // Same posture as bankr cron skipping when BANKR_PARTNER_KEY is unset.
  if (!isCdpConfigured()) {
    return NextResponse.json({ skipped: "cdp_not_configured" });
  }

  const lockAcquired = await tryAcquireCronLock(CRON_NAME, LOCK_TTL_SECONDS);
  if (!lockAcquired) {
    return NextResponse.json({ skipped: "lock_held" });
  }

  const startedAt = Date.now();
  try {
    const supabase = getSupabase();

    // Candidates: assigned VMs whose CDP wallet address is NULL.
    // The env-only-fixup case (cdp_wallet_address NOT NULL, .env missing
    // the line) is NOT covered by this filter — it's caught instead by
    // the file-drift / reconcile cycles via stepFiles + the SSH path,
    // plus a future Rule-58-style cross-consumer verifier (P1 followup).
    const { data: candidates, error: queryErr } = await supabase
      .from("instaclaw_vms")
      .select("id, assigned_to, ip_address, ssh_port, ssh_user, cdp_wallet_address")
      .eq("status", "assigned")
      .is("cdp_wallet_address", null)
      .not("ip_address", "is", null)
      .not("assigned_to", "is", null)
      .limit(PER_RUN_LIMIT);

    if (queryErr) {
      logger.error("provision-missing-cdp-wallets: query failed", {
        route: "cron/provision-missing-cdp-wallets",
        code: queryErr.code,
        error: queryErr.message,
      });
      return NextResponse.json({ error: "query_failed", details: queryErr.message }, { status: 500 });
    }

    const vms = (candidates ?? []) as CandidateVm[];
    if (vms.length === 0) {
      return NextResponse.json({ ok: true, scanned: 0, durationMs: Date.now() - startedAt });
    }

    const results: ProcessResult[] = [];
    for (let i = 0; i < vms.length; i += CONCURRENCY) {
      const batch = vms.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(batch.map(processVm));
      for (let j = 0; j < settled.length; j++) {
        const s = settled[j];
        if (s.status === "fulfilled") {
          results.push(s.value);
        } else {
          results.push({
            vmId: batch[j].id,
            status: "ssh-failed",
            error: `unhandled: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`,
          });
        }
      }
    }

    const counts = results.reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});

    logger.info("provision-missing-cdp-wallets: run complete", {
      route: "cron/provision-missing-cdp-wallets",
      scanned: vms.length,
      counts,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json({
      ok: true,
      scanned: vms.length,
      counts,
      durationMs: Date.now() - startedAt,
    });
  } finally {
    await releaseCronLock(CRON_NAME);
  }
}
