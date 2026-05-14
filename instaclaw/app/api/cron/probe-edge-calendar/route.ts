/**
 * cron/probe-edge-calendar — P1-8 (Sola monitoring for Edge Esmeralda).
 *
 * Every 30 minutes, hits api.sola.day's event-list endpoint for the Edge
 * Esmeralda 2026 group (group_id=3688) and verifies a non-empty list of
 * events is returned. If Sola is down or returns 0 events, alerts admins
 * (deduped 1h via instaclaw_admin_alert_log).
 *
 * Why this matters:
 *   - aromeoes/edge-agent-skill (cloned to ~/.openclaw/skills/edge-esmeralda
 *     on every edge_city VM) reads ALL calendar data from api.sola.day.
 *     See lib/ssh.ts:5274+ for the verified-2026-05-14 details.
 *   - Sola reads are unauthenticated — if api.sola.day is reachable at all,
 *     the events should come back.
 *   - Edge Esmeralda runs through 2026-06-27. If Sola goes offline mid-event,
 *     every attendee's agent reports empty calendars and we get no signal
 *     until users complain.
 *
 * The probe is a single 5-second GET; no auth, no SSH, no node-ssh deps.
 * Very cheap (negligible $0.00x per tick). Worth running until Edge ends.
 *
 * Alert dedup: 1h cooldown (shorter than typical because Sola downtime is
 * actively customer-facing). Re-fires every hour while down, so we don't
 * forget about an ongoing outage.
 *
 * Disable after 2026-06-27: remove this cron entry from vercel.json. The
 * route can stay; just unschedule.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { sendAdminAlertEmail } from "@/lib/email";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const SOLA_URL =
  "https://api.sola.day/api/event/list?group_id=3688&start_date=2026-05-30&end_date=2026-06-27&limit=20";
const PROBE_TIMEOUT_MS = 10_000;

const ALERT_DEDUP_KEY = "sola-probe-failed";
const ALERT_COOLDOWN_HOURS = 1;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let status = "unknown";
  let httpCode = 0;
  let eventCount = 0;
  let errorMsg = "";
  const start = Date.now();

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch(SOLA_URL, {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(t);
    httpCode = res.status;
    if (!res.ok) {
      status = `http_${res.status}`;
      errorMsg = `Sola returned HTTP ${res.status}`;
    } else {
      const body = (await res.json()) as { events?: unknown[] };
      const events = Array.isArray(body?.events) ? body.events : [];
      eventCount = events.length;
      if (eventCount === 0) {
        status = "empty";
        errorMsg = "Sola returned 0 events for group_id=3688";
      } else {
        status = "ok";
      }
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    status = msg.toLowerCase().includes("abort") ? "timeout" : "exception";
    errorMsg = msg.slice(0, 200);
  }

  const wallMs = Date.now() - start;

  // Healthy → log info, return
  if (status === "ok") {
    logger.info("probe-edge-calendar: Sola healthy", {
      route: "cron/probe-edge-calendar",
      event_count: eventCount,
      http_code: httpCode,
      wall_ms: wallMs,
    });
    return NextResponse.json({ ok: true, event_count: eventCount, http_code: httpCode, wall_ms: wallMs });
  }

  // Failure path — log + alert (deduped)
  logger.error("probe-edge-calendar: Sola FAILED", {
    route: "cron/probe-edge-calendar",
    status,
    http_code: httpCode,
    error: errorMsg,
    wall_ms: wallMs,
  });

  void dispatchAlertIfNeeded(status, httpCode, errorMsg, wallMs).catch((err) => {
    logger.error("probe-edge-calendar: alert dispatch failed", {
      route: "cron/probe-edge-calendar",
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return NextResponse.json({
    ok: false,
    status,
    http_code: httpCode,
    error: errorMsg,
    wall_ms: wallMs,
  });
}

async function dispatchAlertIfNeeded(
  status: string,
  httpCode: number,
  errorMsg: string,
  wallMs: number,
): Promise<void> {
  const supabase = getSupabase();
  const cooldownAgoIso = new Date(
    Date.now() - ALERT_COOLDOWN_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const { data: recent } = await supabase
    .from("instaclaw_admin_alert_log")
    .select("id")
    .eq("alert_key", ALERT_DEDUP_KEY)
    .gte("sent_at", cooldownAgoIso)
    .limit(1);
  if (recent && recent.length > 0) {
    return; // within cooldown, skip email
  }

  const subject = `Sola (Edge Esmeralda calendar) probe FAILED — status=${status}`;
  const body =
    `cron/probe-edge-calendar detected a Sola failure.\n\n` +
    `status:      ${status}\n` +
    `http_code:   ${httpCode}\n` +
    `wall_ms:     ${wallMs}\n` +
    `error:       ${errorMsg}\n\n` +
    `Every edge_city VM reads its calendar data from api.sola.day. If this\n` +
    `outage persists, ALL Edge Esmeralda attendees see empty calendars.\n\n` +
    `Action:\n` +
    `  1. curl '${SOLA_URL}' — manually verify the failure\n` +
    `  2. Check Sola status (Twitter/Discord) for known outage\n` +
    `  3. Contact Tule (aromeoes/edge-agent-skill maintainer) if extended\n\n` +
    `Next alert in this category will be suppressed for ${ALERT_COOLDOWN_HOURS}h.`;

  await supabase.from("instaclaw_admin_alert_log").insert({
    alert_key: ALERT_DEDUP_KEY,
    vm_count: 0,
    details: `status=${status} http=${httpCode}`,
  });

  await sendAdminAlertEmail(subject, body);
}
