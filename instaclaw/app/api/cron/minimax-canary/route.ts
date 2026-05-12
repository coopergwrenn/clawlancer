/**
 * GET /api/cron/minimax-canary
 *
 * 15-minute health canary for the MiniMax-M2.5 endpoint. Catches MiniMax
 * balance depletion + auth failure + transient outage within 15-45 minutes
 * instead of waiting for a paying-user cascade.
 *
 * Background
 * ----------
 * The 2026-05-11 incident: MiniMax balance silently hit $-0.01. Every
 * heartbeat call across the fleet started returning `500 {"error":
 * "insufficient balance (1008)"}`. Customers with Bug-A-stuck VMs (which we
 * later discovered was 61% of the fleet) were silently downgraded already —
 * when MiniMax went down, they instead got cascading failovers ending in
 * "Something went wrong." We discovered this only when paying users
 * complained 2+ hours later. We had no first-party signal that MiniMax was
 * down.
 *
 * This cron makes one minimal MiniMax call every 15 minutes (cheap — <$0.001
 * per call) and alerts on:
 *
 *   - HTTP non-200 → likely outage or auth failure
 *   - `insufficient balance (1008)` in response body → depletion (most
 *     important signal — fix is to top up the account)
 *   - HTTP 401 → MINIMAX_API_KEY revoked or rotated incorrectly
 *   - Empty content in 200 response → MiniMax returned but with no output
 *     (degraded mode worth knowing about)
 *
 * Escalation policy (uses instaclaw_admin_alert_log row count as the
 * consecutive-failure counter):
 *   - 1 failure in last 45 min  → log only (treat as transient noise)
 *   - 2 failures in last 45 min → log + admin_alert_log (still no email)
 *   - 3+ failures in last 45 min → P1 email alert (DEPLETION/OUTAGE)
 *
 * 45 min window catches 3 consecutive 15-min failures while tolerating one
 * occasional transient. False-positive rate on a healthy MiniMax should be
 * effectively 0.
 *
 * Schedule: every 15 minutes.
 * Lock: 5 minutes via instaclaw_cron_locks (well above 30s typical runtime).
 *
 * Cost: 1 call × 96/day × ~$0.0001 = ~$0.01/day. Negligible.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { logger } from "@/lib/logger";
import { sendAdminAlertEmail } from "@/lib/email";

export const dynamic = "force-dynamic";
// Single outbound HTTP request. 60s is generous; typical runtime ~1-2s.
export const maxDuration = 60;

const CRON_NAME = "minimax-canary";
const CRON_LOCK_TTL_SECONDS = 300;
const MINIMAX_API_URL = "https://api.minimax.io/anthropic/v1/messages";
const ALERT_WINDOW_MS = 45 * 60 * 1000; // 45 minutes
const EMAIL_THRESHOLD = 3;              // 3+ consecutive failures → email

type CanaryStatus = "healthy" | "depleted" | "auth_failed" | "outage" | "degraded_empty" | "config_missing";

interface CanaryResult {
  status: CanaryStatus;
  httpStatus: number;
  errorSubstr: string | null; // first 200 chars of error body if non-200
  responseText: string | null; // first 200 chars of response if 200
  latencyMs: number;
}

async function probeMiniMax(apiKey: string): Promise<CanaryResult> {
  const t0 = Date.now();
  const body = {
    model: "MiniMax-M2.5",
    max_tokens: 10,
    messages: [{ role: "user", content: "Reply with exactly: ok" }],
  };
  try {
    const r = await fetch(MINIMAX_API_URL, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${apiKey}`,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const latencyMs = Date.now() - t0;
    const text = await r.text();

    if (r.status === 401) {
      return { status: "auth_failed", httpStatus: r.status, errorSubstr: text.slice(0, 200), responseText: null, latencyMs };
    }
    if (r.status >= 500 || r.status === 402) {
      // Inspect body for MiniMax's "1008" depletion code
      if (text.includes("insufficient balance") || text.includes("1008")) {
        return { status: "depleted", httpStatus: r.status, errorSubstr: text.slice(0, 200), responseText: null, latencyMs };
      }
      return { status: "outage", httpStatus: r.status, errorSubstr: text.slice(0, 200), responseText: null, latencyMs };
    }
    if (r.status !== 200) {
      return { status: "outage", httpStatus: r.status, errorSubstr: text.slice(0, 200), responseText: null, latencyMs };
    }
    // 200 — check for non-empty content
    let hasContent = false;
    try {
      const parsed = JSON.parse(text);
      hasContent = Array.isArray(parsed.content) && parsed.content.some((b: { type?: string; text?: string }) =>
        (b.type === "text" && (b.text?.length ?? 0) > 0)
        || (b.type === "thinking" && Object.keys(b).length > 1)
      );
    } catch {
      hasContent = false;
    }
    return {
      status: hasContent ? "healthy" : "degraded_empty",
      httpStatus: r.status,
      errorSubstr: null,
      responseText: text.slice(0, 200),
      latencyMs,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: "outage", httpStatus: 0, errorSubstr: `fetch_err: ${msg}`, responseText: null, latencyMs: Date.now() - t0 };
  }
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const lockAcquired = await tryAcquireCronLock(CRON_NAME, CRON_LOCK_TTL_SECONDS);
  if (!lockAcquired) {
    logger.info("minimax-canary: lock held, skipping", { route: `cron/${CRON_NAME}` });
    return NextResponse.json({ skipped: "lock_held" });
  }

  const startedAt = Date.now();
  try {
    const apiKey = process.env.MINIMAX_API_KEY;
    if (!apiKey || apiKey.length < 20) {
      // Treat this as a P1-class config issue but don't email-spam — just log
      // and exit so the dashboard "last canary status" makes it obvious.
      logger.error("minimax-canary: MINIMAX_API_KEY missing or too short", {
        route: `cron/${CRON_NAME}`,
        key_len: apiKey?.length ?? 0,
      });
      return NextResponse.json({ error: "config_missing", key_len: apiKey?.length ?? 0 }, { status: 500 });
    }

    const result = await probeMiniMax(apiKey);
    const elapsedMs = Date.now() - startedAt;

    logger.info("minimax-canary: probe complete", {
      route: `cron/${CRON_NAME}`,
      status: result.status,
      http_status: result.httpStatus,
      latency_ms: result.latencyMs,
      elapsed_ms: elapsedMs,
    });

    // Healthy + degraded_empty → log + exit clean. We don't alert on
    // degraded_empty alone because it could be a legitimate max_tokens=10
    // truncation; only repeated failures escalate.
    if (result.status === "healthy") {
      return NextResponse.json({
        ok: true,
        status: result.status,
        http_status: result.httpStatus,
        latency_ms: result.latencyMs,
        response_preview: result.responseText,
      });
    }

    // ─── Failure path: count recent failures, escalate per policy ───
    const supabase = getSupabase();
    const alertKey = `${CRON_NAME}:failure`;
    const windowStart = new Date(Date.now() - ALERT_WINDOW_MS).toISOString();

    const { count: priorFailures } = await supabase
      .from("instaclaw_admin_alert_log")
      .select("id", { count: "exact", head: true })
      .eq("alert_key", alertKey)
      .gte("sent_at", windowStart);

    const failuresInWindow = (priorFailures ?? 0) + 1; // +1 for this fire

    // Always record the failure event so the count above stays accurate
    await supabase.from("instaclaw_admin_alert_log").insert({
      alert_key: alertKey,
      vm_count: 0,
      details: `status=${result.status} http=${result.httpStatus} latency=${result.latencyMs}ms err=${(result.errorSubstr ?? "").slice(0, 200)}`,
    });

    // Only send email at the threshold — dedup further fires this window
    if (failuresInWindow === EMAIL_THRESHOLD) {
      const subjectMap: Record<CanaryStatus, string> = {
        healthy: "(unreachable)",
        depleted: "[InstaClaw P1] MiniMax DEPLETED — insufficient balance (1008)",
        auth_failed: "[InstaClaw P1] MiniMax AUTH FAILED — MINIMAX_API_KEY rejected (401)",
        outage: "[InstaClaw P1] MiniMax OUTAGE — endpoint failing",
        degraded_empty: "[InstaClaw P1] MiniMax DEGRADED — empty responses for 45 min",
        config_missing: "[InstaClaw P1] MiniMax config missing",
      };
      const subject = subjectMap[result.status];
      const body = [
        `MiniMax canary has failed ${EMAIL_THRESHOLD} consecutive times in the last 45 minutes.`,
        ``,
        `Current status:   ${result.status}`,
        `HTTP status:      ${result.httpStatus}`,
        `Latency:          ${result.latencyMs} ms`,
        `Failures (45min): ${failuresInWindow}`,
        ``,
        `Response body (first 200 chars):`,
        `  ${result.errorSubstr ?? result.responseText ?? "(empty)"}`,
        ``,
        `Action by status:`,
        result.status === "depleted"
          ? `  Top up MiniMax balance at platform.minimax.io/user-center/payment/balance.\n  ${formatBlastRadius()}`
          : "",
        result.status === "auth_failed"
          ? `  MINIMAX_API_KEY was rejected. Verify the key in Vercel env vars vs. console.minimax.io.\n  If you rotated the key recently, the canary's old key is now stale — update Vercel env.`
          : "",
        result.status === "outage"
          ? `  MiniMax endpoint is down (status ${result.httpStatus}). Check status.minimax.io or hit the endpoint manually.\n  Heartbeats will fail across the fleet — Bug-A-fixed VMs will route user traffic to Anthropic instead (correct behavior); Bug-A-stuck VMs (the heartbeat-staleness-sweep cron should catch these) will see "Something went wrong" on user msgs.`
          : "",
        result.status === "degraded_empty"
          ? `  MiniMax returned 200 but with empty content. May indicate a model-side issue. Customer-visible impact: heartbeats produce no output (cycle ends with cycle_calls=1, doesn't loop). Low priority unless persistent.`
          : "",
        ``,
        `Investigate:`,
        `  - Last 5 admin_alert_log entries: SELECT * FROM instaclaw_admin_alert_log WHERE alert_key='${alertKey}' ORDER BY sent_at DESC LIMIT 5;`,
        `  - Recent heartbeat traffic: SELECT count(*) FROM instaclaw_usage_log WHERE model ILIKE '%minimax%' AND created_at > NOW() - INTERVAL '1 hour';`,
      ].filter(Boolean).join("\n");

      await sendAdminAlertEmail(subject, body).catch((e) => {
        logger.error("minimax-canary: email send failed", { error: String(e) });
      });
    }

    return NextResponse.json({
      ok: false,
      status: result.status,
      http_status: result.httpStatus,
      failures_in_45min: failuresInWindow,
      email_sent: failuresInWindow === EMAIL_THRESHOLD,
      error_substr: result.errorSubstr,
    });
  } finally {
    await releaseCronLock(CRON_NAME);
  }
}

function formatBlastRadius(): string {
  // Operator-facing reminder of what depletion means for customers.
  return [
    `Blast radius if depletion persists:`,
    `  - Bug-A-fixed VMs (the fleet majority post-2026-05-11): heartbeats fail, user msgs still work (route to Anthropic correctly)`,
    `  - Bug-A-stuck VMs (if any slip past the heartbeat-staleness-sweep cron): user msgs route to MiniMax → "Something went wrong"`,
    `  - Daily MiniMax burn at observed rate: ~$15-25/day. $100 top-up = 4-7 days runway.`,
  ].join("\n  ");
}
