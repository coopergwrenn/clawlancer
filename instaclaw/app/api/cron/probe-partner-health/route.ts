/**
 * cron/probe-partner-health — combined hourly probe.
 *
 * Merger of two previously-separate routes (consolidated 2026-05-17 to free
 * a slot under Vercel's 40-cron cap):
 *
 *   1. Sola (Edge Esmeralda calendar) — was cron/probe-edge-calendar (every 30 min).
 *      Probes api.sola.day's event-list endpoint for group_id=3688. Every
 *      edge_city VM reads its calendar from Sola; a Sola outage produces
 *      empty calendars fleet-wide and is customer-facing during Edge.
 *   2. Partner secrets — was cron/probe-partner-secrets @ hourly. Runs every
 *      registered secret verifier (`lib/partner-secrets.ts`) to catch
 *      EDGEOS_BEARER_TOKEN-class regressions (wrong value, rotated secret,
 *      partner-side outage).
 *
 * Both probes are stateless, parallel-safe, and each has its own dedup key
 * in `instaclaw_admin_alert_log`, so they coexist without interaction.
 *
 * Sola probe cadence changed from 30 min → 60 min. Reasoning:
 *   - Alert dedup is 1h regardless. First 60-min probe after a Sola outage
 *     still alerts within the same hour as the old 30-min cadence (the
 *     second 30-min tick was always suppressed by dedup).
 *   - Edge Esmeralda runs through 2026-06-27. After that we can drop this
 *     half of the route entirely.
 *
 * Disable Sola probe path after 2026-06-27: remove the runSolaProbe()
 * call from this route. Keep the partner-secrets path — it's evergreen.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { sendAdminAlertEmail } from "@/lib/email";
import { verifyAllPartnerSecrets, type VerifierStatus } from "@/lib/partner-secrets";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ─────────────────────────────────────────────────────────────────────────────
// Sola probe — was cron/probe-edge-calendar
// ─────────────────────────────────────────────────────────────────────────────

const SOLA_URL =
  "https://api.sola.day/api/event/list?group_id=3688&start_date=2026-05-30&end_date=2026-06-27&limit=20";
const SOLA_PROBE_TIMEOUT_MS = 10_000;
const SOLA_ALERT_DEDUP_KEY = "sola-probe-failed";
const SOLA_ALERT_COOLDOWN_HOURS = 1;

interface SolaResult {
  ok: boolean;
  status: string;
  http_code: number;
  event_count: number;
  error: string;
  wall_ms: number;
}

async function runSolaProbe(): Promise<SolaResult> {
  let status = "unknown";
  let httpCode = 0;
  let eventCount = 0;
  let errorMsg = "";
  const start = Date.now();

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), SOLA_PROBE_TIMEOUT_MS);
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

  return {
    ok: status === "ok",
    status,
    http_code: httpCode,
    event_count: eventCount,
    error: errorMsg,
    wall_ms: Date.now() - start,
  };
}

async function dispatchSolaAlertIfNeeded(r: SolaResult): Promise<void> {
  const supabase = getSupabase();
  const cooldownAgoIso = new Date(
    Date.now() - SOLA_ALERT_COOLDOWN_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const { data: recent } = await supabase
    .from("instaclaw_admin_alert_log")
    .select("id")
    .eq("alert_key", SOLA_ALERT_DEDUP_KEY)
    .gte("sent_at", cooldownAgoIso)
    .limit(1);
  if (recent && recent.length > 0) return;

  const subject = `Sola (Edge Esmeralda calendar) probe FAILED — status=${r.status}`;
  const body =
    `cron/probe-partner-health detected a Sola failure.\n\n` +
    `status:      ${r.status}\n` +
    `http_code:   ${r.http_code}\n` +
    `wall_ms:     ${r.wall_ms}\n` +
    `error:       ${r.error}\n\n` +
    `Every edge_city VM reads its calendar data from api.sola.day. If this\n` +
    `outage persists, ALL Edge Esmeralda attendees see empty calendars.\n\n` +
    `Action:\n` +
    `  1. curl '${SOLA_URL}' — manually verify the failure\n` +
    `  2. Check Sola status (Twitter/Discord) for known outage\n` +
    `  3. Contact Tule (aromeoes/edge-agent-skill maintainer) if extended\n\n` +
    `Next alert in this category will be suppressed for ${SOLA_ALERT_COOLDOWN_HOURS}h.`;

  await supabase.from("instaclaw_admin_alert_log").insert({
    alert_key: SOLA_ALERT_DEDUP_KEY,
    vm_count: 0,
    details: `status=${r.status} http=${r.http_code}`,
  });
  await sendAdminAlertEmail(subject, body);
}

// ─────────────────────────────────────────────────────────────────────────────
// Partner secrets probe — was cron/probe-partner-secrets
// ─────────────────────────────────────────────────────────────────────────────

const PARTNER_ALERT_COOLDOWN_HOURS = 6;
const HARD_FAILURE_STATUSES: VerifierStatus[] = [
  "shape_invalid",
  "auth_failed",
  "endpoint_other",
  "endpoint_5xx",
];

interface PartnerSecretsResult {
  total: number;
  ok_count: number;
  not_configured: number;
  hard_failures_count: number;
  soft_failures_count: number;
  failing_secrets: Array<{
    envKey: string;
    status: VerifierStatus;
    http_code?: number;
    error?: string;
  }>;
  wall_ms: number;
}

async function runPartnerSecretsProbe(): Promise<PartnerSecretsResult> {
  const start = Date.now();
  const results = await verifyAllPartnerSecrets();
  const wallMs = Date.now() - start;

  const okCount = results.filter((r) => r.status === "ok").length;
  const notConfigured = results.filter((r) => r.status === "not_configured").length;
  const hardFailures = results.filter((r) =>
    HARD_FAILURE_STATUSES.includes(r.status),
  );
  const softFailures = results.filter(
    (r) =>
      r.status !== "ok" &&
      r.status !== "not_configured" &&
      !HARD_FAILURE_STATUSES.includes(r.status),
  );

  // Fire per-secret alerts (deduped 6h each)
  if (hardFailures.length > 0) {
    const supabase = getSupabase();
    for (const failure of hardFailures) {
      void dispatchPartnerSecretAlertIfNeeded(supabase, failure).catch((err) => {
        logger.error("probe-partner-health: partner-secret alert dispatch failed", {
          envKey: failure.envKey,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  return {
    total: results.length,
    ok_count: okCount,
    not_configured: notConfigured,
    hard_failures_count: hardFailures.length,
    soft_failures_count: softFailures.length,
    failing_secrets: [...hardFailures, ...softFailures].map((r) => ({
      envKey: r.envKey,
      status: r.status,
      http_code: r.http_code,
      error: r.error,
    })),
    wall_ms: wallMs,
  };
}

async function dispatchPartnerSecretAlertIfNeeded(
  supabase: ReturnType<typeof getSupabase>,
  failure: {
    envKey: string;
    label: string;
    status: VerifierStatus;
    http_code?: number;
    error?: string;
    body_prefix?: string;
  },
): Promise<void> {
  const dedupKey = `partner-secret-failed:${failure.envKey}`;
  const cooldownAgoIso = new Date(
    Date.now() - PARTNER_ALERT_COOLDOWN_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const { data: recent } = await supabase
    .from("instaclaw_admin_alert_log")
    .select("id")
    .eq("alert_key", dedupKey)
    .gte("sent_at", cooldownAgoIso)
    .limit(1);
  if (recent && recent.length > 0) return;

  const subject = `Partner secret FAILED verification: ${failure.envKey} (${failure.status})`;
  const body =
    `cron/probe-partner-health detected a partner-secret failure.\n\n` +
    `envKey:       ${failure.envKey}\n` +
    `label:        ${failure.label}\n` +
    `status:       ${failure.status}\n` +
    `http_code:    ${failure.http_code ?? "(no response)"}\n` +
    `error:        ${failure.error ?? "(none)"}\n` +
    `body_prefix:  ${failure.body_prefix ?? "(none)"}\n\n` +
    `Operator action:\n` +
    `  1. Run \`npx tsx scripts/_verify-partner-secrets.ts\` to reproduce locally.\n` +
    `  2. status=shape_invalid → fix the Vercel env value.\n` +
    `  3. status=auth_failed → rotate the secret with the partner.\n` +
    `  4. status=endpoint_5xx → partner-side outage; wait + contact partner.\n` +
    `  5. status=endpoint_other → check body_prefix for partner-specific error.\n\n` +
    `Next alert for THIS specific envKey will be suppressed for ${PARTNER_ALERT_COOLDOWN_HOURS}h.\n` +
    `Other failing secrets alert independently (per-secret dedup).`;

  await supabase.from("instaclaw_admin_alert_log").insert({
    alert_key: dedupKey,
    vm_count: 0,
    details: `${failure.envKey} status=${failure.status}`,
  });
  await sendAdminAlertEmail(subject, body);
}

// ─────────────────────────────────────────────────────────────────────────────
// Route handler — runs both probes in parallel
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const start = Date.now();
  const [solaResult, partnerSecretsResult] = await Promise.all([
    runSolaProbe(),
    runPartnerSecretsProbe(),
  ]);
  const wallMs = Date.now() - start;

  // Log every run for forensic trail
  logger.info("probe-partner-health: completed", {
    route: "cron/probe-partner-health",
    sola_ok: solaResult.ok,
    sola_status: solaResult.status,
    sola_event_count: solaResult.event_count,
    partner_total: partnerSecretsResult.total,
    partner_ok: partnerSecretsResult.ok_count,
    partner_hard_failures: partnerSecretsResult.hard_failures_count,
    partner_failing: partnerSecretsResult.failing_secrets.map((s) => s.envKey),
    wall_ms: wallMs,
  });

  // Fire Sola alert if it failed (fire-and-forget — partner alerts already
  // dispatched inside runPartnerSecretsProbe)
  if (!solaResult.ok) {
    logger.error("probe-partner-health: Sola FAILED", {
      route: "cron/probe-partner-health",
      ...solaResult,
    });
    void dispatchSolaAlertIfNeeded(solaResult).catch((err) => {
      logger.error("probe-partner-health: Sola alert dispatch failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  return NextResponse.json({
    ok: solaResult.ok && partnerSecretsResult.hard_failures_count === 0,
    sola: solaResult,
    partner_secrets: partnerSecretsResult,
    wall_ms: wallMs,
  });
}
