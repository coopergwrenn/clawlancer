/**
 * cron/frontier-spend-health — fleet-aggregate health of the Frontier SPEND path (P2-6).
 *
 * A Frontier spend authorizes (gate + atomic reserve), signs via Bankr, pays an
 * x402 endpoint, then settles. At fleet scale a SYSTEMIC break — an x402 v2
 * envelope incompatibility, a Bankr signing regression, a facilitator outage —
 * shows up as a spike in settle-FAILED rows and/or orphaned pending holds. Every
 * such failure is already loud at the agent→user level ("the payment didn't go
 * through"), but until now nothing watched the FLEET aggregate, so a break
 * affecting many VMs at once would only surface through scattered user complaints.
 * This is the missing fleet-level signal (Rule 67 proactive-monitoring + Rule 49
 * dedup pattern), the push complement to the pull `_coverage-frontier.ts` query.
 *
 * Two independent checks over the last hour, SPEND rows only. A gate DENY never
 * inserts a ledger row, so a `failed` row is ALWAYS an authorized spend whose
 * pay/settle leg broke — never a correct refusal. That makes the failure rate a
 * clean signal: high failure rate = the rails are breaking, not the gate doing
 * its job.
 *
 *   1. FAILURE SPIKE — failed / (settled + failed) >= 50%, with >= 5 terminal
 *      spends in the window (the volume floor stops 1-2 unlucky failures from
 *      paging; at near-zero rollout volume this simply never trips).
 *   2. STUCK HOLDS — a spend still `pending` older than 60m. HOLD_TTL is 15m and a
 *      real sign+settle round-trip is seconds, so this is an orphaned reserve: the
 *      tool died between authorize and settle. Doesn't move money (the reserve
 *      ages out of the budget window) but a rising count is the canary that the
 *      pay→settle leg is breaking.
 *
 * Each check alerts INDEPENDENTLY and is 6h-deduped via instaclaw_admin_alert_log.
 *
 * `?dryRun=true` computes + returns the verdicts WITHOUT sending email or writing
 * the dedup row — safe to curl against prod to verify the logic (and a clean
 * operator spot-check).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { sendAdminAlertEmail } from "@/lib/email";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const HOUR_MS = 60 * 60 * 1000;
const MIN_TERMINAL_VOLUME = 5; // don't page on 1-2 unlucky failures
const FAILURE_RATE_THRESHOLD = 0.5; // >=50% of terminal spends failed
const STUCK_HOLD_MS = 60 * 60 * 1000; // pending spend older than this = orphan (HOLD_TTL is 15m)
const ALERT_COOLDOWN_HOURS = 6;
const FAILURE_ALERT_KEY = "frontier-spend-failure-spike";
const STUCK_ALERT_KEY = "frontier-spend-stuck-holds";

type SB = ReturnType<typeof getSupabase>;

/** Exact head count for a filtered frontier_transactions query. -1 on error (surfaced, never silently 0). */
async function cnt(
  sb: SB,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  build: (q: any) => any,
): Promise<number> {
  const { count, error } = await build(
    sb.from("frontier_transactions").select("*", { count: "exact", head: true }),
  );
  if (error) {
    logger.error("frontier-spend-health count failed", { error: error.message, code: error.code });
    return -1;
  }
  return count ?? 0;
}

/** True if no alert for `key` was sent within the cooldown window (so we may fire). */
async function canAlert(sb: SB, key: string, nowMs: number): Promise<boolean> {
  const cooldownAgoIso = new Date(nowMs - ALERT_COOLDOWN_HOURS * HOUR_MS).toISOString();
  const { data } = await sb
    .from("instaclaw_admin_alert_log")
    .select("id")
    .eq("alert_key", key)
    .gte("sent_at", cooldownAgoIso)
    .limit(1);
  return !(data && data.length > 0);
}

async function fireAlert(sb: SB, key: string, subject: string, body: string, details: string): Promise<void> {
  await sb.from("instaclaw_admin_alert_log").insert({ alert_key: key, vm_count: 0, details });
  await sendAdminAlertEmail(subject, body);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const dryRun = req.nextUrl.searchParams.get("dryRun") === "true";

  const sb = getSupabase();
  const nowMs = Date.now();
  const hourAgoIso = new Date(nowMs - HOUR_MS).toISOString();
  const stuckCutoffIso = new Date(nowMs - STUCK_HOLD_MS).toISOString();

  const settled = await cnt(sb, (q) =>
    q.eq("direction", "spend").gte("created_at", hourAgoIso).eq("status", "settled"));
  const failed = await cnt(sb, (q) =>
    q.eq("direction", "spend").gte("created_at", hourAgoIso).eq("status", "failed"));
  const stuck = await cnt(sb, (q) =>
    q.eq("direction", "spend").eq("status", "pending").lt("created_at", stuckCutoffIso));

  const terminal = Math.max(0, settled) + Math.max(0, failed);
  const failureRate = terminal > 0 ? failed / terminal : 0;
  const fired: string[] = [];

  // ── Check 1: failure spike ──
  const spikeBreached = terminal >= MIN_TERMINAL_VOLUME && failureRate >= FAILURE_RATE_THRESHOLD;
  if (spikeBreached) {
    const may = dryRun ? true : await canAlert(sb, FAILURE_ALERT_KEY, nowMs);
    if (may) {
      const subject = `[P1] Frontier spend failure spike — ${failed}/${terminal} (${(failureRate * 100).toFixed(0)}%) in 1h`;
      const body =
        `cron/frontier-spend-health detected an elevated SPEND failure rate over the last hour.\n\n` +
        `Settled:        ${settled}\n` +
        `Failed:         ${failed}\n` +
        `Failure rate:   ${(failureRate * 100).toFixed(1)}% (threshold ${(FAILURE_RATE_THRESHOLD * 100).toFixed(0)}%, min volume ${MIN_TERMINAL_VOLUME})\n\n` +
        `WHAT THIS MEANS\n` +
        `A 'failed' row is an AUTHORIZED spend whose pay/settle leg broke (gate denials\n` +
        `never insert a row), so this points at the rails, not the policy:\n` +
        `  - x402 envelope incompatibility with a facilitator (v1/v2 shape, header name)\n` +
        `  - Bankr signing regression (see cron/bankr-signing-health)\n` +
        `  - a specific high-traffic supplier endpoint down\n\n` +
        `OPERATOR ACTIONS\n` +
        `1. Run: npx tsx scripts/_coverage-frontier.ts  (per-status + stuck-hold view)\n` +
        `2. Inspect the failed rows' metadata for a common supplier/endpoint or pay_error:\n` +
        `   SELECT counterparty_address, response_summary, metadata FROM frontier_transactions\n` +
        `     WHERE direction='spend' AND status='failed' AND created_at > now() - interval '1 hour';\n` +
        `3. Check cron/bankr-signing-health alerts — a shared signing outage hits every spend.\n\n` +
        `Suppressed for ${ALERT_COOLDOWN_HOURS}h after this alert.`;
      if (!dryRun) await fireAlert(sb, FAILURE_ALERT_KEY, subject, body, `failure spike ${failed}/${terminal}`);
      fired.push("failure-spike");
    }
  }

  // ── Check 2: stuck (orphaned) spend holds ──
  const stuckBreached = stuck > 0;
  if (stuckBreached) {
    const may = dryRun ? true : await canAlert(sb, STUCK_ALERT_KEY, nowMs);
    if (may) {
      const subject = `[P1] Frontier stuck spend holds — ${stuck} orphaned reserve(s) > 60m`;
      const body =
        `cron/frontier-spend-health found ${stuck} spend hold(s) still 'pending' older than 60m.\n\n` +
        `HOLD_TTL is 15m and a real x402 sign+settle is seconds, so these are ORPHANED\n` +
        `reserves — the spend tool died between authorize and settle (crash, timeout,\n` +
        `gateway restart mid-flight). No money moved and they no longer count against\n` +
        `any budget, but a rising count means the pay→settle leg is breaking.\n\n` +
        `OPERATOR ACTIONS\n` +
        `1. Identify them:\n` +
        `   SELECT id, vm_id, amount_usdc, created_at, metadata FROM frontier_transactions\n` +
        `     WHERE direction='spend' AND status='pending' AND created_at < now() - interval '1 hour'\n` +
        `     ORDER BY created_at;\n` +
        `2. These never settled. Safe to leave (they age out of budget accounting) but a\n` +
        `   persistent backlog warrants tracing why settle never ran on those VMs.\n\n` +
        `Suppressed for ${ALERT_COOLDOWN_HOURS}h after this alert.`;
      if (!dryRun) await fireAlert(sb, STUCK_ALERT_KEY, subject, body, `${stuck} stuck holds`);
      fired.push("stuck-holds");
    }
  }

  const summary = {
    ok: true,
    dryRun,
    window: "1h",
    settled,
    failed,
    failureRate: Number(failureRate.toFixed(3)),
    stuckHolds: stuck,
    spikeBreached,
    stuckBreached,
    alertsFired: fired,
  };
  logger.info("frontier-spend-health tick", summary);
  return NextResponse.json(summary);
}
