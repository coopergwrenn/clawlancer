/**
 * cron/probe-partner-secrets — P1-9 continuous-monitoring layer.
 *
 * Hourly cron that runs every registered partner-secret verifier and
 * alerts admins on any hard failure (shape_invalid, auth_failed,
 * endpoint_other, endpoint_5xx). Closes the surveillance gap that
 * allowed the EDGEOS_BEARER_TOKEN to be wrong for 34 days without any
 * signal: now any partner secret that goes bad — wrong format, rotated
 * partner-side without our update, or partner-side outage — fires an
 * admin alert within an hour.
 *
 * Dedup via instaclaw_admin_alert_log with a 6-hour cooldown PER FAILING
 * SECRET (each secret gets its own dedup key). That way an EDGEOS outage
 * doesn't suppress alerting on a separate BANKR key issue.
 *
 * Operator workflow on alert:
 *   1. Receive email with the failing envKey + status + http_code.
 *   2. Run `npx tsx scripts/_verify-partner-secrets.ts` to reproduce.
 *   3. If shape_invalid → fix the Vercel env var.
 *   4. If auth_failed   → rotate the secret with the partner.
 *   5. If endpoint_5xx  → wait it out / contact partner.
 *
 * Cost: one HTTP request per partner-secret per hour. With 3 secrets,
 * 72 requests/day total. Negligible.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { sendAdminAlertEmail } from "@/lib/email";
import { verifyAllPartnerSecrets, type VerifierStatus } from "@/lib/partner-secrets";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ALERT_COOLDOWN_HOURS = 6;
const HARD_FAILURE_STATUSES: VerifierStatus[] = [
  "shape_invalid",
  "auth_failed",
  "endpoint_other",
  "endpoint_5xx",
];

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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

  // Log every run for trail; only alert on hard failures.
  logger.info("probe-partner-secrets: completed", {
    route: "cron/probe-partner-secrets",
    total: results.length,
    ok: okCount,
    not_configured: notConfigured,
    hard_failures: hardFailures.length,
    soft_failures: softFailures.length,
    wall_ms: wallMs,
    // Surface failing secret names in the log for easy grep.
    failing_secrets: [...hardFailures, ...softFailures].map((r) => r.envKey),
  });

  // Per-secret alert dispatch (deduped 6h each). Fire-and-forget so a
  // slow email doesn't extend the function duration.
  if (hardFailures.length > 0) {
    const supabase = getSupabase();
    for (const failure of hardFailures) {
      void dispatchAlertIfNeeded(supabase, failure).catch((err) => {
        logger.error("probe-partner-secrets: alert dispatch failed", {
          envKey: failure.envKey,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  return NextResponse.json({
    ok: hardFailures.length === 0,
    total: results.length,
    ok_count: okCount,
    not_configured: notConfigured,
    hard_failures: hardFailures.length,
    soft_failures: softFailures.length,
    failing_secrets: [...hardFailures, ...softFailures].map((r) => ({
      envKey: r.envKey,
      status: r.status,
      http_code: r.http_code,
      error: r.error,
    })),
    wall_ms: wallMs,
  });
}

async function dispatchAlertIfNeeded(
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
  // Per-secret dedup key. Multiple distinct failing secrets each get
  // their own alert path.
  const dedupKey = `partner-secret-failed:${failure.envKey}`;
  const cooldownAgoIso = new Date(
    Date.now() - ALERT_COOLDOWN_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const { data: recent } = await supabase
    .from("instaclaw_admin_alert_log")
    .select("id")
    .eq("alert_key", dedupKey)
    .gte("sent_at", cooldownAgoIso)
    .limit(1);
  if (recent && recent.length > 0) {
    return; // suppressed by cooldown
  }

  const subject = `Partner secret FAILED verification: ${failure.envKey} (${failure.status})`;
  const body =
    `cron/probe-partner-secrets detected a partner-secret failure.\n\n` +
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
    `Next alert for THIS specific envKey will be suppressed for ${ALERT_COOLDOWN_HOURS}h.\n` +
    `Other failing secrets alert independently (per-secret dedup).`;

  await supabase.from("instaclaw_admin_alert_log").insert({
    alert_key: dedupKey,
    vm_count: 0,
    details: `${failure.envKey} status=${failure.status}`,
  });

  await sendAdminAlertEmail(subject, body);
}
