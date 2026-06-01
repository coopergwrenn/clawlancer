/**
 * cron/reconcile-toolrouter-usage — hourly drift detector for the K.4
 * wrapper's record-usage POSTs. PRD §7.11 Task K.4 backstop.
 *
 * The K.4 wrapper observes every MCP tools/call response on each VM
 * and POSTs structuredContent to /api/agent/toolrouter/record-usage.
 * Most calls land cleanly. Some won't:
 *
 *   - VM had a network glitch when the wrapper tried to POST
 *   - Wrapper crashed mid-call (rare; SIGKILL during the POST)
 *   - InstaClaw was unreachable (deploy in progress, edge timeout)
 *   - GATEWAY_TOKEN was rotated and the wrapper had stale env
 *
 * The wrapper swallows POST failures silently (Cooper's mandate:
 * metering is secondary to functionality — the tool call must
 * succeed regardless of whether we recorded it). The cost of that
 * mandate is some allocation goes un-decremented; the user
 * effectively got a free call.
 *
 * This cron closes the gap. Every hour:
 *   1. GET https://toolrouter.world/v1/requests for our `tr_*` key
 *      (Bearer auth). Returns the per-call audit log for the
 *      last hour.
 *   2. Cross-reference each row's trace_id against
 *      instaclaw_toolrouter_call_log.
 *   3. For rows in ToolRouter's log that we DON'T have:
 *      → log a structured 'toolrouter-drift' event
 *      → if drift exceeds threshold, emit P1 admin alert
 *
 * We do NOT auto-backfill the missing rows because ToolRouter's audit
 * log doesn't include our end-user identity (per agent 2 research:
 * `requests.body` was explicitly dropped in their migration 0014).
 * Attribution lives only in the wrapper's report. Missing reports
 * are drift, and the operator investigates manually.
 *
 * Per CLAUDE.md cron pattern: middleware allows /api/cron, no explicit
 * auth check in the route. Rule 11: maxDuration = 60 (single paginated
 * fetch). Rule 39: every failure is logged-only; the wrapper continues
 * to handle the real-time path.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { sendAdminAlertEmail } from "@/lib/email";
import { getToolRouterEnv } from "@/lib/toolrouter-client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const FETCH_TIMEOUT_MS = 15_000;
// Pull the most recent N rows. ToolRouter paginates; we use ?limit=N
// (assumed parameter name based on common REST patterns). If the API
// uses a different name, parse the response and stop based on the
// oldest ts seen vs the lookback window.
const FETCH_LIMIT = 200;
// Lookback window: 65 minutes (5 min overlap with the previous hourly
// run, so a row arriving in the boundary window isn't missed).
const LOOKBACK_MINUTES = 65;
// Drift threshold for P1 alert. The hourly drift should be near zero
// in steady state. >5 missing rows in an hour is investigation-worthy.
const DRIFT_ALERT_THRESHOLD = 5;
const ALERT_DEDUP_KEY = "toolrouter_drift_p1";
const ALERT_DEDUP_HOURS = 6;

interface ToolRouterRequestRow {
  id?: string;
  trace_id?: string | null;
  endpoint_id?: string | null;
  ts?: string | null;
  charged?: boolean | null;
  path?: string | null;
  credit_captured_usd?: number | null;
}

/**
 * Best-effort fetch of the most recent N rows. Returns null on any
 * failure. The cron logs but doesn't throw — wrapper handles the
 * real-time path; the backstop is opportunistic.
 */
async function fetchToolRouterAuditLog(): Promise<ToolRouterRequestRow[] | null> {
  const env = getToolRouterEnv();
  if (!env) {
    logger.warn("reconcile-toolrouter-usage: TOOLROUTER_API_KEY not configured", {
      route: "cron/reconcile-toolrouter-usage",
    });
    return null;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `${env.apiUrl}/v1/requests?limit=${FETCH_LIMIT}`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${env.apiKey}`,
        Accept: "application/json",
      },
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const bodyTxt = await res.text().catch(() => "");
      logger.warn("reconcile-toolrouter-usage: GET /v1/requests non-2xx", {
        route: "cron/reconcile-toolrouter-usage",
        status: res.status,
        body_prefix: bodyTxt.slice(0, 200),
      });
      return null;
    }

    const data = await res.json();
    // Defensive parsing — the response shape isn't documented in our
    // research. Common shapes: {data: [...]}, {requests: [...]}, {items: [...]},
    // or just [...]. Walk the most-likely fields.
    let rows: unknown[] = [];
    if (Array.isArray(data)) rows = data;
    else if (Array.isArray(data?.data)) rows = data.data;
    else if (Array.isArray(data?.requests)) rows = data.requests;
    else if (Array.isArray(data?.items)) rows = data.items;
    else if (Array.isArray(data?.rows)) rows = data.rows;
    else {
      logger.warn("reconcile-toolrouter-usage: unrecognized response shape", {
        route: "cron/reconcile-toolrouter-usage",
        keys: typeof data === "object" && data ? Object.keys(data).slice(0, 10) : [],
      });
      return null;
    }

    return rows as ToolRouterRequestRow[];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn("reconcile-toolrouter-usage: fetch failed", {
      route: "cron/reconcile-toolrouter-usage",
      error: msg.slice(0, 200),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Dedup admin alerts via instaclaw_admin_alert_log (existing pattern
 * from Rule 67 / probe-toolrouter-balance). Returns true if the alert
 * should fire (not deduped); false if a recent identical alert is
 * still within the cooldown window.
 */
async function shouldFireAlert(key: string): Promise<boolean> {
  try {
    const supabase = getSupabase();
    const cutoff = new Date(Date.now() - ALERT_DEDUP_HOURS * 3600 * 1000).toISOString();
    const { data: recent } = await supabase
      .from("instaclaw_admin_alert_log")
      .select("id")
      .eq("alert_key", key)
      .gte("fired_at", cutoff)
      .limit(1);
    if (recent && recent.length > 0) return false;

    await supabase
      .from("instaclaw_admin_alert_log")
      .insert({ alert_key: key, fired_at: new Date().toISOString() });
    return true;
  } catch (e) {
    // If the dedup table is unavailable, fail-open (fire the alert)
    // so we don't silence real issues. Operator can tune.
    logger.warn("reconcile-toolrouter-usage: alert dedup table read failed; firing", {
      route: "cron/reconcile-toolrouter-usage",
      error: e instanceof Error ? e.message.slice(0, 200) : String(e),
    });
    return true;
  }
}

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const startedAt = Date.now();
  const result = {
    fetched: 0,
    with_trace_id: 0,
    matched_in_call_log: 0,
    missing_in_call_log: 0,
    alert_fired: false,
    duration_ms: 0,
  };

  const rows = await fetchToolRouterAuditLog();
  if (!rows) {
    result.duration_ms = Date.now() - startedAt;
    return NextResponse.json({ ok: false, reason: "fetch_failed", ...result });
  }
  result.fetched = rows.length;

  // Filter to last LOOKBACK_MINUTES — defensive in case the API
  // returns more than we asked. Also filter to rows with trace_id
  // (rows without it can't be cross-referenced — they'd always look
  // missing on our side).
  const lookbackCutoff = Date.now() - LOOKBACK_MINUTES * 60 * 1000;
  const candidateRows = rows.filter((r) => {
    if (!r.trace_id || typeof r.trace_id !== "string") return false;
    if (!r.ts) return true; // no ts → assume recent
    const ts = Date.parse(r.ts);
    return Number.isFinite(ts) && ts >= lookbackCutoff;
  });
  result.with_trace_id = candidateRows.length;

  if (candidateRows.length === 0) {
    result.duration_ms = Date.now() - startedAt;
    return NextResponse.json({ ok: true, ...result, note: "no_recent_rows" });
  }

  // Look up trace_ids in our call_log in one batch.
  const supabase = getSupabase();
  const traceIds = candidateRows.map((r) => r.trace_id as string);
  const { data: matched, error: lookupErr } = await supabase
    .from("instaclaw_toolrouter_call_log")
    .select("trace_id")
    .in("trace_id", traceIds);

  if (lookupErr) {
    logger.error("reconcile-toolrouter-usage: call_log lookup failed", {
      route: "cron/reconcile-toolrouter-usage",
      error_code: lookupErr.code,
      error_message: lookupErr.message.slice(0, 200),
    });
    result.duration_ms = Date.now() - startedAt;
    return NextResponse.json({ ok: false, reason: "db_lookup_failed", ...result });
  }

  const matchedTraceIds = new Set((matched ?? []).map((m) => m.trace_id as string));
  result.matched_in_call_log = matchedTraceIds.size;

  const missing = candidateRows.filter((r) => !matchedTraceIds.has(r.trace_id as string));
  result.missing_in_call_log = missing.length;

  // Log every missing trace_id (capped to avoid log spam).
  if (missing.length > 0) {
    const sample = missing.slice(0, 20).map((r) => ({
      trace_id: r.trace_id,
      endpoint_id: r.endpoint_id,
      charged: r.charged,
      ts: r.ts,
    }));
    logger.warn("reconcile-toolrouter-usage: missing call_log rows detected", {
      route: "cron/reconcile-toolrouter-usage",
      missing_count: missing.length,
      total_candidate: candidateRows.length,
      drift_pct: (missing.length / candidateRows.length * 100).toFixed(1),
      sample,
    });
  }

  // P1 alert if drift exceeds threshold.
  if (missing.length >= DRIFT_ALERT_THRESHOLD) {
    const fire = await shouldFireAlert(ALERT_DEDUP_KEY);
    if (fire) {
      result.alert_fired = true;
      const sampleTrace = missing.slice(0, 10).map((r) => r.trace_id).join(", ");
      await sendAdminAlertEmail(
        `[P1] ToolRouter wrapper drift: ${missing.length} unreported calls in last ${LOOKBACK_MINUTES}m`,
        [
          `The K.4 wrapper is missing record-usage POSTs.`,
          ``,
          `Hour summary:`,
          `  - ToolRouter audit rows (with trace_id):  ${candidateRows.length}`,
          `  - Matched in instaclaw_toolrouter_call_log: ${matchedTraceIds.size}`,
          `  - MISSING in our call_log:                  ${missing.length}`,
          `  - Drift:                                    ${(missing.length / candidateRows.length * 100).toFixed(1)}%`,
          ``,
          `Sample missing trace_ids (first 10):`,
          `  ${sampleTrace}`,
          ``,
          `Investigate:`,
          `  - Did /api/agent/toolrouter/record-usage 5xx on any windows? (Vercel logs)`,
          `  - Did the gateway proxy reject the wrapper's auth? (gateway_token rotation?)`,
          `  - Did any VM lose network connectivity during the hour? (cron health-check + journal)`,
          ``,
          `This alert is deduped for ${ALERT_DEDUP_HOURS}h. Next fire after ${new Date(Date.now() + ALERT_DEDUP_HOURS * 3600 * 1000).toISOString()}.`,
        ].join("\n"),
      ).catch((err) => {
        logger.error("reconcile-toolrouter-usage: alert email send failed", {
          route: "cron/reconcile-toolrouter-usage",
          error: err instanceof Error ? err.message.slice(0, 200) : String(err),
        });
      });
    }
  }

  result.duration_ms = Date.now() - startedAt;
  return NextResponse.json({ ok: true, ...result });
}
