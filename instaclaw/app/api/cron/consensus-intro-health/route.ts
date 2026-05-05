/**
 * Consensus 2026 intro flow — periodic health check.
 *
 * Runs every 30 min via Vercel cron. Computes the last-hour activity
 * profile of agent_outreach_log and emits structured logs:
 *
 *   - INFO line with the metrics tuple (always emitted, greppable)
 *   - ERROR line if any threshold breach (alert-worthy)
 *
 * Operationally: grep Vercel logs for `consensus-intro-health` to get
 * an at-a-glance health pulse. Set up Vercel Log Drains → Slack/PagerDuty
 * to forward ERROR lines if you want pages.
 *
 * Thresholds (intentionally conservative for the launch window):
 *   - failure_rate > 0.30 AND total > 5      → failure rate alert
 *   - rate_limited_rate > 0.50 AND total > 10 → throttling alert
 *   - unacked_age_hours > 2 (any row)         → delivery stuck alert
 *   - poll_dup_rate > 0.80 AND polls > 5     → ack chain broken alert
 *
 * Auth: Vercel cron sends with a Bearer secret matching CRON_SECRET.
 * Public callers get 401.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { isOutreachEnabled, flagName } from "@/lib/outreach-feature-flag";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const WINDOW_HOURS = 1;
const MIN_VOLUME_FOR_RATE_ALERT = 5;
const FAILURE_RATE_THRESHOLD = 0.30;
const RATE_LIMITED_RATE_THRESHOLD = 0.50;
const STUCK_AGE_HOURS = 2;

function authorized(req: NextRequest): boolean {
  // Vercel cron sets `authorization: Bearer ${CRON_SECRET}` per the
  // platform convention. Accept either Bearer or x-cron-secret.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // No secret configured — allow only in dev. Refuse in production
    // so a public probe can't trigger the cron path.
    return process.env.NODE_ENV !== "production";
  }
  const auth = req.headers.get("authorization");
  if (auth === `Bearer ${secret}`) return true;
  const xCron = req.headers.get("x-cron-secret");
  if (xCron === secret) return true;
  return false;
}

interface Metrics {
  window_hours: number;
  total: number;
  by_status: Record<string, number>;
  by_ack_channel: Record<string, number>;
  failure_rate: number;
  rate_limited_rate: number;
  ack_rate: number;
  median_ack_seconds: number | null;
  oldest_unacked_hours: number | null;
  feature_enabled: boolean;
  alerts: string[];
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();
  const sinceIso = new Date(Date.now() - WINDOW_HOURS * 3600 * 1000).toISOString();

  // Pull the recent rows in one shot. Window is short, volume is
  // bounded by 20/24h-per-sender × active senders → tens to hundreds
  // of rows max during the conference. Single round trip is fine.
  const { data: rows, error } = await supabase
    .from("agent_outreach_log")
    .select("status, ack_channel, sent_at, ack_received_at")
    .gte("sent_at", sinceIso)
    .order("sent_at", { ascending: false })
    .limit(2000);

  if (error) {
    console.error(`consensus-intro-health: db_query_failed err=${error.message}`);
    return NextResponse.json({ error: "ledger query failed" }, { status: 503 });
  }

  const total = rows?.length || 0;
  const by_status: Record<string, number> = {};
  const by_ack_channel: Record<string, number> = {};
  const ack_durations: number[] = [];
  let oldestUnackedSentAt: string | null = null;

  for (const r of rows || []) {
    const s = (r.status as string) || "unknown";
    by_status[s] = (by_status[s] || 0) + 1;
    if (r.ack_channel) {
      const c = r.ack_channel as string;
      by_ack_channel[c] = (by_ack_channel[c] || 0) + 1;
    }
    if (r.ack_received_at && r.sent_at) {
      const d = (new Date(r.ack_received_at as string).getTime() - new Date(r.sent_at as string).getTime()) / 1000;
      if (d >= 0) ack_durations.push(d);
    }
    if (r.status === "sent" && !r.ack_received_at) {
      if (!oldestUnackedSentAt || (r.sent_at as string) < oldestUnackedSentAt) {
        oldestUnackedSentAt = r.sent_at as string;
      }
    }
  }

  const sortedDurs = ack_durations.slice().sort((a, b) => a - b);
  const median_ack_seconds = sortedDurs.length === 0 ? null : sortedDurs[Math.floor(sortedDurs.length / 2)];
  const oldest_unacked_hours = oldestUnackedSentAt
    ? (Date.now() - new Date(oldestUnackedSentAt).getTime()) / 3.6e6
    : null;

  const failed = (by_status["failed"] || 0) + (by_status["pending"] || 0);
  const failure_rate = total > 0 ? failed / total : 0;
  const rate_limited = by_status["rate_limited"] || 0;
  const rate_limited_rate = total > 0 ? rate_limited / total : 0;
  const acked = (by_status["sent"] || 0) > 0
    ? Object.values(by_ack_channel).reduce((a, b) => a + b, 0) / (by_status["sent"] || 1)
    : 0;

  const alerts: string[] = [];
  if (total >= MIN_VOLUME_FOR_RATE_ALERT && failure_rate > FAILURE_RATE_THRESHOLD) {
    alerts.push(`failure_rate=${(failure_rate * 100).toFixed(0)}% (${failed}/${total}) > threshold ${(FAILURE_RATE_THRESHOLD * 100).toFixed(0)}%`);
  }
  if (total >= MIN_VOLUME_FOR_RATE_ALERT * 2 && rate_limited_rate > RATE_LIMITED_RATE_THRESHOLD) {
    alerts.push(`rate_limited_rate=${(rate_limited_rate * 100).toFixed(0)}% (${rate_limited}/${total}) > threshold ${(RATE_LIMITED_RATE_THRESHOLD * 100).toFixed(0)}%`);
  }
  if (oldest_unacked_hours !== null && oldest_unacked_hours > STUCK_AGE_HOURS) {
    alerts.push(`oldest_unacked_hours=${oldest_unacked_hours.toFixed(1)} > ${STUCK_AGE_HOURS}h (delivery stuck somewhere)`);
  }
  const polled = by_ack_channel["polled"] || 0;
  if (polled > 5 && polled / Math.max(1, Object.values(by_ack_channel).reduce((a, b) => a + b, 0)) > 0.80) {
    alerts.push(`high poll-fallback rate ${(polled / Object.values(by_ack_channel).reduce((a, b) => a + b, 0) * 100).toFixed(0)}% (XMTP→ack path may be broken)`);
  }

  const metrics: Metrics = {
    window_hours: WINDOW_HOURS,
    total,
    by_status,
    by_ack_channel,
    failure_rate,
    rate_limited_rate,
    ack_rate: acked,
    median_ack_seconds,
    oldest_unacked_hours,
    feature_enabled: isOutreachEnabled(),
    alerts,
  };

  // Always-emit metrics line (greppable).
  console.log(
    `consensus-intro-health total=${total} sent=${by_status["sent"] || 0} failed=${failed} rl=${rate_limited} pending=${by_status["pending"] || 0} duplicate=${by_status["duplicate"] || 0} ` +
      `acked_telegram=${by_ack_channel["telegram"] || 0} acked_xmtp_user=${by_ack_channel["xmtp_user"] || 0} acked_pending=${by_ack_channel["pending"] || 0} acked_polled=${by_ack_channel["polled"] || 0} ` +
      `median_ack_s=${median_ack_seconds?.toFixed(1) ?? "null"} oldest_unacked_h=${oldest_unacked_hours?.toFixed(2) ?? "null"} ` +
      `enabled=${metrics.feature_enabled} flag=${flagName()}`,
  );

  // Alert lines — emit one ERROR per breach so log-drain rules can
  // page on the substring "consensus-intro-health ALERT".
  if (alerts.length > 0) {
    for (const a of alerts) {
      console.error(`consensus-intro-health ALERT: ${a}`);
    }
  }

  return NextResponse.json({ ok: true, metrics });
}
