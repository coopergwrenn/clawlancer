/**
 * GET /api/cron/usage-anomaly-check
 *
 * Hourly monitor that compares last-hour usage_log distribution to a
 * same-hour-last-week baseline and fires admin alerts on anomalies. The
 * three signals it watches:
 *
 *   1. CRITICAL — user→minimax: rows where call_type='user' AND model
 *      contains 'minimax'. Post-Bug-B-fix (commit 6db05d8e), this should
 *      be exactly 0 forever. Any non-zero count means the proxy's
 *      isManualMessage short-circuit isn't firing somewhere — silent
 *      regression of the 7,653-msg-over-7-days silent-downgrade bug.
 *
 *   2. WARNING — volume drop: total rows in last hour < 30% of the same
 *      hour 7 days ago. The 2026-05-11 MiniMax-1008 cascade dropped
 *      fleet-wide usage_log volume to near-zero within 5 min. Catching
 *      this gives us a 15-60 min lead on the next cascade vs waiting for
 *      a paying user to report a dead bot.
 *
 *   3. WARNING — cost spike: total cost_weight in last hour > 2× baseline.
 *      Cost-spike could mean (a) Bug-B-fix is over-shooting (legitimate
 *      heartbeats routing to Sonnet at 20× MiniMax cost), (b) genuine
 *      organic traffic growth (positive signal but worth knowing), or
 *      (c) a runaway agent (cron loop, fork bomb of API calls).
 *
 * Why same-hour-7-days-ago and not same-hour-yesterday:
 *   - usage_log retention is 14 days, plenty of headroom.
 *   - Weekly seasonality (weekday vs weekend) dominates hourly seasonality
 *     for this fleet (paying users mostly chat M-F evenings).
 *   - 7-day baseline naturally handles weekend dips.
 *
 * Dedup: max 1 email per condition per hour via instaclaw_admin_alert_log
 * (key = "usage_anomaly_check:<condition>").
 *
 * Schedule: hourly at minute 7 (lets usage_log writes from the top-of-hour
 * settle before we aggregate — cleaner numbers than running at minute 0).
 * Lock: 10 minutes (well above expected runtime of ~5s).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { logger } from "@/lib/logger";
import { sendAdminAlertEmail } from "@/lib/email";

export const dynamic = "force-dynamic";
// Two SELECTs against an indexed table (vm_id, created_at DESC). Generous
// timeout to absorb growth.
export const maxDuration = 60;

const CRON_NAME = "usage-anomaly-check";
const CRON_LOCK_TTL_SECONDS = 600;
const ONE_HOUR_MS = 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * ONE_HOUR_MS;

// Thresholds (tunable)
const VOLUME_DROP_PCT = 0.30;   // alert if last-hour < 30% of baseline
const COST_SPIKE_X = 2.0;       // alert if last-hour cost > 2× baseline
const MIN_BASELINE_ROWS = 50;   // skip volume/cost alerts if baseline window had too few rows (noisy)
const USER_TO_MINIMAX_ALERT_THRESHOLD = 1; // any non-zero count is interesting

// Signal 5 (credit_pack orphan) tuning — see INC-20260602 postmortem.
// Grace period: a purchase whose ledger row hasn't landed yet may simply be
// mid-delivery (synchronous webhook + Stripe-retry latency). 15 min is well
// beyond the webhook's normal sub-second processing AND beyond a typical
// Stripe retry, so anything older than this with no ledger row is a genuine
// orphan: paid, credits not delivered.
const CREDIT_ORPHAN_GRACE_MS = 15 * 60 * 1000;
// Lookback window: bound the scan to recent purchases so the query stays
// cheap and we don't re-alert forever on an ancient un-fixable row (e.g. a
// purchase whose VM was later deleted). 7 days catches anything that slipped
// past same-day attention; older orphans age out (still detectable via the
// ad-hoc SQL in the postmortem if ever needed).
const CREDIT_ORPHAN_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

interface Stats {
  totalRows: number;
  totalCostWeight: number;
  userToMinimax: number;
  byModelClass: Record<string, number>;
  byCallType: Record<string, number>;
}

function modelClass(model: string | null): string {
  if (!model) return "other";
  const m = model.toLowerCase();
  if (m.includes("minimax")) return "minimax";
  if (m.includes("haiku")) return "haiku";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("opus")) return "opus";
  return "other";
}

async function fetchStats(supabase: ReturnType<typeof getSupabase>, startIso: string, endIso: string): Promise<Stats> {
  const stats: Stats = {
    totalRows: 0,
    totalCostWeight: 0,
    userToMinimax: 0,
    byModelClass: {},
    byCallType: {},
  };
  // Paginate — usage_log can have tens of thousands of rows per hour at scale.
  let from = 0;
  const pageSize = 1000;
  for (;;) {
    const { data, error } = await supabase
      .from("instaclaw_usage_log")
      .select("model,call_type,cost_weight")
      .gte("created_at", startIso)
      .lt("created_at", endIso)
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const r of data as Array<{ model: string | null; call_type: string | null; cost_weight: string | number | null }>) {
      stats.totalRows += 1;
      stats.totalCostWeight += Number(r.cost_weight ?? 0);
      const cls = modelClass(r.model);
      stats.byModelClass[cls] = (stats.byModelClass[cls] ?? 0) + 1;
      stats.byCallType[r.call_type ?? "?"] = (stats.byCallType[r.call_type ?? "?"] ?? 0) + 1;
      if (r.call_type === "user" && cls === "minimax") {
        stats.userToMinimax += 1;
      }
    }
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return stats;
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const lockAcquired = await tryAcquireCronLock(CRON_NAME, CRON_LOCK_TTL_SECONDS);
  if (!lockAcquired) {
    logger.info("usage-anomaly-check: lock held, skipping", { route: `cron/${CRON_NAME}` });
    return NextResponse.json({ skipped: "lock_held" });
  }

  const startedAt = Date.now();
  try {
    const supabase = getSupabase();
    const now = Date.now();

    // Last-hour window (current hour, capped at "now" — partial-hour OK since we
    // also compare to a partial-hour-7-days-ago window for fairness).
    const lastHourStart = new Date(now - ONE_HOUR_MS).toISOString();
    const lastHourEnd = new Date(now).toISOString();
    // Baseline: same window 7 days ago.
    const baselineStart = new Date(now - ONE_HOUR_MS - SEVEN_DAYS_MS).toISOString();
    const baselineEnd = new Date(now - SEVEN_DAYS_MS).toISOString();

    const [lastHour, baseline] = await Promise.all([
      fetchStats(supabase, lastHourStart, lastHourEnd),
      fetchStats(supabase, baselineStart, baselineEnd),
    ]);

    const elapsedMs = Date.now() - startedAt;

    logger.info("usage-anomaly-check: stats", {
      route: `cron/${CRON_NAME}`,
      window: { last_hour_start: lastHourStart, baseline_start: baselineStart },
      last_hour_rows: lastHour.totalRows,
      last_hour_cost: lastHour.totalCostWeight,
      last_hour_user_to_minimax: lastHour.userToMinimax,
      baseline_rows: baseline.totalRows,
      baseline_cost: baseline.totalCostWeight,
      elapsed_ms: elapsedMs,
    });

    const alerts: Array<{ severity: "critical" | "warning"; condition: string; subject: string; body: string }> = [];

    // ─── Signal 1: user→minimax (CRITICAL) ───
    if (lastHour.userToMinimax >= USER_TO_MINIMAX_ALERT_THRESHOLD) {
      alerts.push({
        severity: "critical",
        condition: "user_to_minimax",
        subject: `[InstaClaw CRITICAL] ${lastHour.userToMinimax} user msgs routed to MiniMax in last hour`,
        body: [
          `${lastHour.userToMinimax} rows in instaclaw_usage_log had call_type='user' AND model contains 'minimax' in the last hour.`,
          ``,
          `Post-fix expected: ZERO. Any non-zero count means the Bug B fix (proxy isManualMessage short-circuit) is not firing somewhere.`,
          ``,
          `Baseline (same hour 7 days ago): ${baseline.userToMinimax} (was high pre-fix — should be the historical baseline now).`,
          ``,
          `Investigate:`,
          `  - Did a deploy revert app/api/gateway/proxy/route.ts (commit 6db05d8e)?`,
          `  - Is there a code path that bypasses the isManualMessage check (e.g., a new bypass header)?`,
          `  - Which VMs are affected? SELECT vm_id, count(*) FROM instaclaw_usage_log`,
          `    WHERE created_at > NOW() - INTERVAL '1 hour' AND call_type='user' AND model ILIKE '%minimax%'`,
          `    GROUP BY vm_id ORDER BY count DESC LIMIT 10;`,
          ``,
          `Last-hour distribution by model_class: ${JSON.stringify(lastHour.byModelClass)}`,
          `Last-hour distribution by call_type: ${JSON.stringify(lastHour.byCallType)}`,
        ].join("\n"),
      });
    }

    // ─── Signal 2: volume drop (WARNING) ───
    // Skip if baseline is too small (low-traffic period, noisy ratio)
    if (baseline.totalRows >= MIN_BASELINE_ROWS) {
      const volumeRatio = lastHour.totalRows / baseline.totalRows;
      if (volumeRatio < VOLUME_DROP_PCT) {
        alerts.push({
          severity: "warning",
          condition: "volume_drop",
          subject: `[InstaClaw WARN] usage_log volume dropped to ${(volumeRatio * 100).toFixed(0)}% of last-week baseline`,
          body: [
            `Last hour: ${lastHour.totalRows} rows (cost-weight ${lastHour.totalCostWeight.toFixed(0)})`,
            `Same hour 7 days ago: ${baseline.totalRows} rows (cost-weight ${baseline.totalCostWeight.toFixed(0)})`,
            `Ratio: ${(volumeRatio * 100).toFixed(1)}% (alert threshold: <${(VOLUME_DROP_PCT * 100).toFixed(0)}%)`,
            ``,
            `Possible causes:`,
            `  - Upstream cascade (MiniMax or Anthropic returning errors at high rate — those calls don't reach usage_log)`,
            `  - Fleet-wide gateway issue (mass restart, deploy regression)`,
            `  - VM provisioning halted (no new VM activity)`,
            `  - Genuine low-traffic period (holiday, conference, weekend dip)`,
            ``,
            `Distribution comparison:`,
            `  Last hour    model_class: ${JSON.stringify(lastHour.byModelClass)}`,
            `  Last hour    call_type:   ${JSON.stringify(lastHour.byCallType)}`,
            `  Baseline     model_class: ${JSON.stringify(baseline.byModelClass)}`,
            `  Baseline     call_type:   ${JSON.stringify(baseline.byCallType)}`,
            ``,
            `Investigate first:`,
            `  1. Check Vercel logs for /api/gateway/proxy 5xx rate in the last hour`,
            `  2. Check admin_alert_log for any unrelated alerts in the same window`,
            `  3. SSH a sample of healthy VMs and check journal for gateway errors`,
          ].join("\n"),
        });
      }
    }

    // ─── Signal 3: cost spike (WARNING) ───
    if (baseline.totalCostWeight >= 10) {
      const costRatio = lastHour.totalCostWeight / baseline.totalCostWeight;
      if (costRatio > COST_SPIKE_X) {
        alerts.push({
          severity: "warning",
          condition: "cost_spike",
          subject: `[InstaClaw WARN] usage cost ${costRatio.toFixed(1)}× last-week baseline`,
          body: [
            `Last hour cost-weight: ${lastHour.totalCostWeight.toFixed(0)} (${lastHour.totalRows} rows)`,
            `Baseline cost-weight:  ${baseline.totalCostWeight.toFixed(0)} (${baseline.totalRows} rows)`,
            `Ratio: ${costRatio.toFixed(2)}× (alert threshold: >${COST_SPIKE_X}×)`,
            ``,
            `Possible causes (in order of likelihood):`,
            `  - Genuine traffic growth — check daily-active-VMs metric (positive signal)`,
            `  - Bug-B fix over-shoot — heartbeats misclassified as user msgs, routed to Sonnet/Opus at 4-19× MiniMax cost`,
            `  - Runaway agent — a single VM stuck in a tool-call loop`,
            `  - A new feature with heavy LLM usage (e.g., gbrain expansion if rolled out fleet-wide)`,
            ``,
            `Per-VM concentration check (run this SQL):`,
            `  SELECT vm_id, sum(cost_weight) AS cost FROM instaclaw_usage_log`,
            `  WHERE created_at > NOW() - INTERVAL '1 hour'`,
            `  GROUP BY vm_id ORDER BY cost DESC LIMIT 10;`,
            ``,
            `If the top 3 VMs account for >50% of the spike → likely a runaway agent.`,
            `If the spike is fleet-wide and even → likely Bug-B-fix over-shoot or organic growth.`,
            ``,
            `Distribution by call_type:`,
            `  Last hour: ${JSON.stringify(lastHour.byCallType)}`,
            `  Baseline:  ${JSON.stringify(baseline.byCallType)}`,
          ].join("\n"),
        });
      }
    }

    // ─── Signal 4: per-VM infrastructure call rate (CRITICAL — Rule 69) ───
    // Surfaces a SINGLE VM whose infrastructure-call cost exceeds
    // INFRA_RATE_ALERT_THRESHOLD per hour. The expected baseline is single-
    // digit cost_weight per VM per hour (strip-thinking periodic summary
    // fires every 2h per session; even at 10 sessions × 2 calls each = 20
    // cost/hour worst-case at haiku cost=1). Anything over the threshold
    // suggests:
    //   - a future cron caller forgot to send `x-call-kind: infrastructure`
    //     and is being misclassified upstream (the 2026-05-28 incident
    //     pattern — though we'd catch THAT one via signal 1/3 too)
    //   - the throttle gates in strip-thinking.py / pre-archive hook are
    //     no longer firing correctly (regression of the PERIODIC_SUMMARY_
    //     V1_RESHRINK fix or the dedupe-seconds logic)
    //   - a legitimate new infrastructure cron is firing too hot and needs
    //     its own dedup
    // We surface the top-3 offenders directly in the alert so operators can
    // act without a SQL session. Added 2026-05-28 (Rule 69, Phase 3).
    {
      const INFRA_RATE_ALERT_THRESHOLD = 200; // cost_weight per VM per hour
      const { data: infraRows, error: infraErr } = await supabase
        .from("instaclaw_usage_log")
        .select("vm_id,cost_weight")
        .eq("call_type", "infrastructure")
        .gte("created_at", lastHourStart)
        .lt("created_at", lastHourEnd);
      if (infraErr) {
        logger.warn("usage-anomaly-check: infrastructure rate query failed (non-fatal)", {
          route: `cron/${CRON_NAME}`,
          error: infraErr.message,
        });
      } else if (infraRows && infraRows.length > 0) {
        const byVm = new Map<string, number>();
        for (const r of infraRows as Array<{ vm_id: string; cost_weight: string | number | null }>) {
          byVm.set(r.vm_id, (byVm.get(r.vm_id) ?? 0) + Number(r.cost_weight ?? 0));
        }
        const overThreshold = Array.from(byVm.entries())
          .filter(([, cost]) => cost >= INFRA_RATE_ALERT_THRESHOLD)
          .sort((a, b) => b[1] - a[1]);
        if (overThreshold.length > 0) {
          const top3 = overThreshold.slice(0, 3)
            .map(([vmId, cost]) => `  ${vmId}: ${cost.toFixed(0)} cost_weight in last hour`)
            .join("\n");
          alerts.push({
            severity: "critical",
            condition: "infrastructure_rate",
            subject: `[InstaClaw CRITICAL] ${overThreshold.length} VM(s) exceed infrastructure-call rate ${INFRA_RATE_ALERT_THRESHOLD}/h`,
            body: [
              `${overThreshold.length} VM(s) had >= ${INFRA_RATE_ALERT_THRESHOLD} cost_weight of`,
              `call_type='infrastructure' usage_log rows in the last hour.`,
              ``,
              `Expected baseline: single-digit cost_weight per VM per hour`,
              `(strip-thinking periodic summary at 2h interval, haiku cost=1).`,
              ``,
              `Top 3 offenders:`,
              top3,
              ``,
              `Likely causes (in order):`,
              `  - A NEW infrastructure caller is firing too hot and needs its own throttle`,
              `  - Strip-thinking dedupe gates regressed (check PERIODIC_RECENT_DEDUPE_SECONDS,`,
              `    PRE_ARCHIVE_SUMMARY_RECENT_THRESHOLD, last_periodic_summary_ts staleness)`,
              `  - A VM's session-state is producing thousands of small jsonl files`,
              `    that each trigger pre-archive summary independently`,
              ``,
              `Per-VM cost cap (INFRASTRUCTURE_DAILY_BUDGET=500) caps daily blowout`,
              `at 500 cost_weight per VM per day — so the hourly rate matters as`,
              `an early-warning signal, not as a blast-radius cap.`,
              ``,
              `Drill-down SQL:`,
              `  SELECT vm_id, sum(cost_weight) AS cost`,
              `  FROM instaclaw_usage_log`,
              `  WHERE created_at > NOW() - INTERVAL '1 hour'`,
              `    AND call_type = 'infrastructure'`,
              `  GROUP BY vm_id ORDER BY cost DESC LIMIT 10;`,
              ``,
              `Then for the top offender, group by prompt_hint to see which caller:`,
              `  SELECT substr(prompt_hint, 1, 60) AS hint, count(*), sum(cost_weight)`,
              `  FROM instaclaw_usage_log`,
              `  WHERE vm_id = '<top-vm>' AND call_type = 'infrastructure'`,
              `    AND created_at > NOW() - INTERVAL '1 hour'`,
              `  GROUP BY hint ORDER BY count(*) DESC;`,
            ].join("\n"),
          });
        }
      }
    }

    // ─── Signal 5: orphan credit-pack purchases (CRITICAL — INC-20260602) ───
    // A paid credit_pack purchase whose credits never reached the customer.
    // The detection: an instaclaw_credit_purchases row (idempotency claim,
    // written first by the webhook) with NO matching instaclaw_credit_ledger
    // row (written by instaclaw_add_credits, the step that actually grants).
    // This is precisely the 35-day silent outage we just fixed (a duplicate
    // instaclaw_add_credits overload → PGRST203 → handler 500 → credits
    // never applied). That bug went undetected for 35 days because nothing
    // watched purchase→ledger consistency. This signal closes that gap: any
    // future orphan surfaces within ~1 hour instead of via a customer report.
    //
    // Match key is (vm_id, reference_id=stripe_payment_intent) — exactly the
    // dedup key the webhook's orphan-recovery branch uses. We scan a bounded
    // recent window and skip purchases inside the grace period (legit
    // in-flight deliveries). Cheap: credit_purchases is tiny (tens of rows).
    {
      const orphanCutoff = new Date(now - CREDIT_ORPHAN_GRACE_MS).toISOString();
      const lookbackStart = new Date(now - CREDIT_ORPHAN_LOOKBACK_MS).toISOString();
      const { data: purchases, error: purchErr } = await supabase
        .from("instaclaw_credit_purchases")
        .select("vm_id, stripe_payment_intent, credits_purchased, amount_cents, created_at")
        .gte("created_at", lookbackStart)
        .lt("created_at", orphanCutoff);
      if (purchErr) {
        logger.warn("usage-anomaly-check: credit_purchases query failed (non-fatal)", {
          route: `cron/${CRON_NAME}`,
          error: purchErr.message,
        });
      } else if (purchases && purchases.length > 0) {
        // Pull the ledger rows for the same window's PIs and diff in memory.
        // reference_id holds the stripe_payment_intent for credit_pack grants.
        const { data: ledgerRows, error: ledgerErr } = await supabase
          .from("instaclaw_credit_ledger")
          .select("vm_id, reference_id")
          .gte("created_at", lookbackStart)
          .like("reference_id", "pi_%");
        if (ledgerErr) {
          logger.warn("usage-anomaly-check: credit_ledger query failed (non-fatal)", {
            route: `cron/${CRON_NAME}`,
            error: ledgerErr.message,
          });
        } else {
          const ledgerSet = new Set(
            (ledgerRows ?? []).map((r) => `${r.vm_id}|${r.reference_id}`)
          );
          const orphans = (purchases as Array<{
            vm_id: string;
            stripe_payment_intent: string;
            credits_purchased: number;
            amount_cents: number;
            created_at: string;
          }>).filter((p) => !ledgerSet.has(`${p.vm_id}|${p.stripe_payment_intent}`));

          if (orphans.length > 0) {
            const totalDollars = orphans.reduce((s, o) => s + (o.amount_cents ?? 0), 0) / 100;
            const totalCredits = orphans.reduce((s, o) => s + (o.credits_purchased ?? 0), 0);
            const detail = orphans
              .slice(0, 10)
              .map((o) => `  ${o.created_at.slice(0, 19)}  vm=${o.vm_id.slice(0, 8)}  ${o.credits_purchased}cr  $${(o.amount_cents / 100).toFixed(2)}  ${o.stripe_payment_intent}`)
              .join("\n");
            alerts.push({
              severity: "critical",
              condition: "credit_pack_orphan",
              subject: `[InstaClaw CRITICAL] ${orphans.length} paid credit-pack purchase(s) with NO credits delivered ($${totalDollars.toFixed(2)})`,
              body: [
                `${orphans.length} row(s) in instaclaw_credit_purchases (paid, idempotency claimed)`,
                `have NO matching instaclaw_credit_ledger entry, and are older than the`,
                `${CREDIT_ORPHAN_GRACE_MS / 60000}-minute delivery grace period.`,
                ``,
                `These are PAYING CUSTOMERS who were charged but did not receive credits.`,
                `Total: ${totalCredits} credits / $${totalDollars.toFixed(2)} across ${orphans.length} purchase(s).`,
                ``,
                `This is the INC-20260602 bug class (instaclaw_add_credits RPC failure`,
                `between the purchase-row insert and the ledger grant). Root cause then`,
                `was a duplicate RPC overload (PGRST203); fixed by dropping the 3-param`,
                `version + passing p_source explicitly. A recurrence means either that`,
                `regressed, or a NEW failure mode sits between purchase-insert and`,
                `ledger-grant in app/api/billing/webhook/route.ts:handleCreditPackPurchase.`,
                ``,
                `Orphans (up to 10 shown):`,
                detail,
                ``,
                `FIX (per orphan, after confirming the Stripe charge is real):`,
                `  SELECT public.instaclaw_add_credits(`,
                `    '<vm_id>'::uuid, <credits>, '<stripe_payment_intent>', 'stripe');`,
                `  -- idempotent on reference_id; safe to re-run. Verify a ledger row`,
                `  -- appears and credit_balance increments.`,
                ``,
                `Then investigate WHY the webhook didn't apply them — check Vercel logs`,
                `for app/api/billing/webhook 5xx and the RPC error message.`,
              ].join("\n"),
            });
          }
        }
      }
    }

    // ─── Dispatch alerts (with per-condition dedup) ───
    const oneHourAgo = new Date(now - ONE_HOUR_MS).toISOString();
    for (const a of alerts) {
      const alertKey = `${CRON_NAME}:${a.condition}`;
      const { count: dupCount } = await supabase
        .from("instaclaw_admin_alert_log")
        .select("id", { count: "exact", head: true })
        .eq("alert_key", alertKey)
        .gte("sent_at", oneHourAgo);
      const isFirstFireThisHour = (dupCount ?? 0) === 0;
      if (isFirstFireThisHour) {
        await sendAdminAlertEmail(a.subject, a.body).catch((e) => {
          logger.error("usage-anomaly-check: email send failed", { error: String(e), condition: a.condition });
        });
      }
      await supabase.from("instaclaw_admin_alert_log").insert({
        alert_key: alertKey,
        vm_count: 0,
        details: isFirstFireThisHour ? `sent: ${a.subject.slice(0, 100)}` : `suppressed (dedup)`,
      });
      logger.info("usage-anomaly-check: alert", {
        route: `cron/${CRON_NAME}`,
        condition: a.condition,
        severity: a.severity,
        dispatched: isFirstFireThisHour,
      });
    }

    return NextResponse.json({
      ok: true,
      last_hour: lastHour,
      baseline: baseline,
      alerts_fired: alerts.length,
      elapsed_ms: elapsedMs,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("usage-anomaly-check: unhandled error", { route: `cron/${CRON_NAME}`, error: msg });
    return NextResponse.json({ error: "unhandled", details: msg }, { status: 500 });
  } finally {
    await releaseCronLock(CRON_NAME);
  }
}
