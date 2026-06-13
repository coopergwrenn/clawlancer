/**
 * cron/dns-zone-gc — GoDaddy DNS zone garbage collector.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Per-VM TLS subdomains are `<vm.id>.vm.instaclaw.io` A records created by
 * `createVMDNSRecord` during configure. Until 2026-06-13, NOTHING deleted
 * them when a VM was retired — `deleteVMDNSRecord` (lib/godaddy.ts) had zero
 * callers. Records accumulated until the GoDaddy zone hit its 500-record
 * hard cap (`ZONE_LIMIT_EXCEEDED`), at which point NO new VM (fresh provision
 * OR restore) could get a DNS record and its web/dashboard/proxy path was
 * silently dead. A one-time prune on 2026-06-13 removed 309 stale records
 * (zone 479 → 170); this cron prevents re-accumulation forever.
 *
 * WHY RECONCILIATION (not just event-driven cleanup)
 * ──────────────────────────────────────────────────
 * Event-driven `deleteVMDNSRecord` calls are wired into the retire paths
 * (freeze, reaper, admin-terminate) for immediacy — but event-driven-ONLY
 * is the partial-fix trap (CLAUDE.md Rule 14): a path that's missed, or a
 * new retire path added later, silently leaks records again. This sweep
 * observes END STATE (a record is stale iff its VM is gone/retired), so it
 * CANNOT miss a path — present or future. It is also the ONLY mechanism that
 * can clean `no-db-row` orphans (admin-terminate deletes the DB row, so
 * there is no row left to drive a retroactive event cleanup). This is the
 * Rule 47 continuous-reconciliation pattern applied to DNS.
 *
 * SAFETY (Rule 85 — never destroy from an unproven-complete set)
 * ─────────────────────────────────────────────────────────────
 *  - COMPLETE-SET, COUNT-ASSERTED fetch of instaclaw_vms (the table exceeds
 *    1000 rows — a bare PostgREST select silently truncates at the 1000-row
 *    cap and would mis-classify live VMs past row 1000 as `no-db-row`,
 *    deleting their records). If the fetch is incomplete, empty, or errors,
 *    we ABORT and delete NOTHING (fail closed). This is the exact guard the
 *    2026-06-10 orphan-reaper incident lacked.
 *  - A record is prunable IFF its UUID has no DB row OR the row's status is
 *    in {terminated, failed, frozen, destroyed}. An `assigned` VM (including
 *    hibernating/suspended sleep states, which carry status='assigned') is
 *    NEVER pruned. Frozen records are safe to prune: thaw re-runs
 *    configureOpenClaw → createVMDNSRecord re-creates the record.
 *  - PER-RUN CAP bounds blast radius. Steady state deletes ~0. If the sweep
 *    wants to delete more than the cap, something is wrong → it deletes up
 *    to the cap and fires a P0 alert rather than nuking.
 *  - Idempotent: GoDaddy 404 on delete = already gone = success. 429 =
 *    rate-limit → bounded backoff. Any other non-2xx → STOP (no blind retry
 *    into a half-deleted zone).
 *
 * ROLLOUT (Rule 17 shadow-first)
 * ──────────────────────────────
 * Gated behind `DNS_GC_ENABLED`. Default (unset/"false") = REPORT mode:
 * classifies + alerts what it WOULD delete, deletes nothing. Flip
 * `DNS_GC_ENABLED=true` (Vercel env) to activate autonomous deletion once
 * proven. Event-driven cleanup at the retire paths keeps the zone clean in
 * the meantime; this sweep is the backstop + the no-db-orphan cleaner.
 *
 * Schedule: every 2h (vercel.json). With ~330 records of headroom post-prune
 * and a modest retire rate, 2h cadence keeps the zone far below the cap.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { sendAdminAlertEmail } from "@/lib/email";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CRON_NAME = "dns-zone-gc";
const ROUTE = "cron/dns-zone-gc";
const DOMAIN = "instaclaw.io";
const GODADDY_API = "https://api.godaddy.com/v1";

// A VM is RETIRED (its subdomain is dead) when its status is one of these.
// Everything else — assigned (incl. hibernating/suspended), ready,
// provisioning — is KEPT.
export const RETIRED_STATUSES = new Set(["terminated", "failed", "frozen", "destroyed"]);

/**
 * The load-bearing safety predicate. A `<uuid>.vm` DNS record is prunable IFF
 * its VM is gone (no DB row → status undefined) OR retired. An `assigned` VM —
 * including hibernating/suspended sleep states, which carry status='assigned'
 * with health_status reflecting the sleep — is NEVER prunable. Pure + exported
 * for unit testing (scripts/_test-dns-zone-gc.ts).
 */
export function isRecordPrunable(status: string | undefined): boolean {
  if (status === undefined) return true; // no DB row → orphan
  return RETIRED_STATUSES.has(status);
}

// Bound blast radius. Steady-state deletes ≈0; a large candidate set means
// either a backlog (first activation) or a bug — cap + alert, don't nuke.
const PER_RUN_CAP = 50;
// Surface a leak: if this many stale records exist, a retire path is missing
// its cleanup (or the cron hasn't been activated yet). Alert regardless of
// mode.
const LEAK_ALERT_THRESHOLD = 60;
const ALERT_DEDUP_KEY = "dns-zone-gc-stale";
const ALERT_DEDUP_HOURS = 6;
const ZONE_CAP = 500;

type GoDaddyRecord = { name: string; data: string; ttl?: number };

function gdHeaders() {
  const apiKey = process.env.GODADDY_API_KEY;
  const apiSecret = process.env.GODADDY_API_SECRET;
  if (!apiKey || !apiSecret) return null;
  return { Authorization: `sso-key ${apiKey}:${apiSecret}` };
}

/**
 * COUNT-asserted complete fetch of instaclaw_vms (id, status). Throws if the
 * fetched row count does not equal count(*) — the fail-closed Rule 85 guard.
 */
async function fetchAllVmRows(
  supabase: ReturnType<typeof getSupabase>,
): Promise<Map<string, string>> {
  const { count, error: countErr } = await supabase
    .from("instaclaw_vms")
    .select("id", { count: "exact", head: true });
  if (countErr) throw new Error(`count(*) failed: ${countErr.message}`);
  const expected = count ?? 0;
  if (expected === 0) {
    // Empty result is a red flag (Supabase hiccup / RLS) — never let it
    // make every DNS record look like a no-db-row orphan.
    throw new Error("count(*) returned 0 — refusing to classify (fail closed)");
  }
  const byId = new Map<string, string>();
  const page = 1000;
  for (let from = 0; from < expected; from += page) {
    const { data, error } = await supabase
      .from("instaclaw_vms")
      .select("id, status")
      .range(from, from + page - 1)
      .order("id");
    if (error) throw new Error(`page [${from}] failed: ${error.message}`);
    for (const row of data ?? []) byId.set(row.id as string, row.status as string);
  }
  if (byId.size !== expected) {
    throw new Error(
      `INCOMPLETE fetch: got ${byId.size}, count(*)=${expected} — aborting (Rule 85)`,
    );
  }
  return byId;
}

async function fetchVmDnsRecords(
  headers: Record<string, string>,
): Promise<GoDaddyRecord[]> {
  const res = await fetch(
    `${GODADDY_API}/domains/${DOMAIN}/records/A?limit=${ZONE_CAP}`,
    { headers },
  );
  if (!res.ok) {
    throw new Error(`GoDaddy list A records failed: ${res.status} ${await res.text()}`);
  }
  const all = (await res.json()) as GoDaddyRecord[];
  return all.filter((r) => r.name.endsWith(".vm"));
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const headers = gdHeaders();
  if (!headers) {
    logger.warn("dns-zone-gc: GoDaddy creds not configured, skipping", { route: ROUTE });
    return NextResponse.json({ ok: true, skipped: "no-godaddy-creds" });
  }

  const enabled = process.env.DNS_GC_ENABLED === "true";

  const acquired = await tryAcquireCronLock(CRON_NAME, 280, "cron");
  if (!acquired) {
    return NextResponse.json({ ok: true, skipped: "lock-held" });
  }

  const supabase = getSupabase();
  try {
    // 1. Complete-set VM fetch (fail-closed on any incompleteness).
    let byId: Map<string, string>;
    try {
      byId = await fetchAllVmRows(supabase);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error("dns-zone-gc: VM fetch failed — aborting (fail closed)", { route: ROUTE, error: msg });
      // This is the catastrophic-prevention guard. Alert loudly; delete nothing.
      await sendAdminAlertEmail(
        "[P1] dns-zone-gc aborted: VM set not provably complete",
        `The DNS GC refused to run because instaclaw_vms could not be fetched completely.\n` +
          `Deleting on an incomplete VM set would mis-classify live VMs as orphans (Rule 85).\n\nError: ${msg}`,
      ).catch(() => {});
      return NextResponse.json({ ok: false, aborted: "vm-fetch-incomplete", error: msg }, { status: 200 });
    }

    // 2. Pull the .vm A records.
    const vmRecords = await fetchVmDnsRecords(headers);
    const totalA = vmRecords.length;

    // 3. Classify. Prunable iff no DB row OR retired status. Assigned never pruned.
    const prunable: Array<{ name: string; ip: string; reason: string }> = [];
    let liveKept = 0;
    for (const rec of vmRecords) {
      const uuid = rec.name.replace(/\.vm$/, "");
      const status = byId.get(uuid);
      if (!isRecordPrunable(status)) {
        liveKept++; // assigned (incl. hibernating/suspended)/ready/provisioning — KEEP
        continue;
      }
      prunable.push({
        name: rec.name,
        ip: rec.data,
        reason: status === undefined ? "no-db-row" : `status=${status}`,
      });
    }

    const base = {
      route: ROUTE,
      mode: enabled ? "active" : "report",
      vmDnsRecords: totalA,
      liveKept,
      prunable: prunable.length,
    };
    logger.info("dns-zone-gc: classified", base);

    // 4. Leak / backlog alert (deduped) — fires in BOTH modes when stale
    //    records exceed the threshold. In report mode this is the signal to
    //    flip DNS_GC_ENABLED=true; in active mode (post-cap) it flags a
    //    retire path leaking faster than one run can clean.
    if (prunable.length >= LEAK_ALERT_THRESHOLD) {
      const dedupSince = new Date(Date.now() - ALERT_DEDUP_HOURS * 3600 * 1000).toISOString();
      const { data: recent } = await supabase
        .from("instaclaw_admin_alert_log")
        .select("id")
        .eq("alert_key", ALERT_DEDUP_KEY)
        .gte("sent_at", dedupSince)
        .limit(1);
      if (!recent || recent.length === 0) {
        const body = [
          `${prunable.length} stale <uuid>.vm DNS records detected (zone has ${totalA} .vm records; cap ${ZONE_CAP}).`,
          `Mode: ${enabled ? "ACTIVE (deleting up to " + PER_RUN_CAP + "/run)" : "REPORT-ONLY (DNS_GC_ENABLED unset)"}.`,
          ``,
          enabled
            ? `If this persists across runs, a retire path is leaking faster than the cap clears.`
            : `Flip DNS_GC_ENABLED=true in Vercel env to activate autonomous cleanup.`,
          ``,
          `By reason:`,
          `  no-db-row: ${prunable.filter((p) => p.reason === "no-db-row").length}`,
          `  terminated: ${prunable.filter((p) => p.reason === "status=terminated").length}`,
          `  failed: ${prunable.filter((p) => p.reason === "status=failed").length}`,
          `  frozen: ${prunable.filter((p) => p.reason === "status=frozen").length}`,
          `  destroyed: ${prunable.filter((p) => p.reason === "status=destroyed").length}`,
        ].join("\n");
        await supabase
          .from("instaclaw_admin_alert_log")
          .insert({ alert_key: ALERT_DEDUP_KEY, vm_count: prunable.length, details: body.slice(0, 1000) })
          .then(() => {}, () => {});
        await sendAdminAlertEmail("[P2] DNS zone GC: stale records accumulating", body).catch(() => {});
      }
    }

    // 5. Report mode — classify + alert, delete nothing.
    if (!enabled) {
      return NextResponse.json({ ...base, deleted: 0, note: "report-only (set DNS_GC_ENABLED=true to activate)" });
    }

    // 6. Active mode — delete up to the per-run cap.
    const overCap = prunable.length > PER_RUN_CAP;
    const batch = prunable.slice(0, PER_RUN_CAP);
    const deleted: string[] = [];
    for (const p of batch) {
      let attempt = 0;
      while (true) {
        const d = await fetch(`${GODADDY_API}/domains/${DOMAIN}/records/A/${p.name}`, {
          method: "DELETE",
          headers,
        });
        if (d.ok || d.status === 404) {
          deleted.push(p.name); // 404 = already gone = idempotent success
          break;
        }
        if (d.status === 429 && attempt < 4) {
          attempt++;
          await new Promise((r) => setTimeout(r, 2000 * attempt));
          continue;
        }
        // Any other non-2xx → STOP. Do not retry blind into a half-deleted zone.
        const errBody = await d.text();
        logger.error("dns-zone-gc: delete failed — stopping", {
          route: ROUTE, name: p.name, status: d.status, body: errBody.slice(0, 200), deletedSoFar: deleted.length,
        });
        return NextResponse.json(
          { ...base, deleted: deleted.length, stopped: true, lastError: { name: p.name, status: d.status } },
          { status: 200 },
        );
      }
      await new Promise((r) => setTimeout(r, 250)); // ~4/s, well under GoDaddy 60/min
    }

    logger.info("dns-zone-gc: swept", { ...base, deleted: deleted.length, overCap });
    return NextResponse.json({
      ...base,
      deleted: deleted.length,
      overCap,
      note: overCap ? `${prunable.length} candidates > cap ${PER_RUN_CAP}; remainder next run` : undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("dns-zone-gc: unexpected error", { route: ROUTE, error: msg });
    return NextResponse.json({ ok: false, error: msg }, { status: 200 });
  } finally {
    await releaseCronLock(CRON_NAME);
  }
}
