/**
 * cron/bankr-signing-health — 60s active probe of Bankr's signing service.
 *
 * Motivated by INC-20260528: during a live ClawFi demo, Bankr's signing
 * service started returning 400 `signing_failed` and 502 `signing service
 * couldn't complete this transfer` across every transaction type. We had ZERO
 * observability — Cooper learned about the outage when his demo broke.
 *
 * Two parallel probes per minute:
 *
 *   1. PUBLIC: GET /public/doppler/creator-fees/<known-wallet> (no auth).
 *      Catches gross Bankr-side outages (DNS, edge, gateway).
 *
 *   2. PARTNER: GET /partner/wallets with X-Partner-Key header.
 *      Catches auth-layer regressions (rotated key, revoked partner,
 *      partner-side billing pause, gas-sponsorship balance $0 — Cooper's
 *      2026-05-27 incident).
 *
 * Each probe row is recorded to `instaclaw_bankr_probe_log` for forensic
 * trail. The cron then looks back at the last 3 rows: if ALL THREE are
 * not-ok AND none have been alerted within the last 6h, fire a P0 admin
 * alert (Rule 49 dedup pattern + Rule 67 — Anthropic-balance-style proactive
 * monitoring).
 *
 * Alert dedup key: `bankr-signing-health-down`. Single key fleet-wide;
 * Bankr is a single shared upstream so per-VM dedup makes no sense.
 *
 * Limitations:
 *
 *   - This probe does NOT exercise an actual signing operation, only the
 *     auth + read paths. The 2026-05-28 incident showed `bankr whoami`
 *     succeeding while real `bankr wallet transfer` returned 502. A
 *     true signing-path probe would require a low-value tx on a dedicated
 *     wallet — viable but more invasive. Phase 2 follow-up.
 *
 *   - Probe traffic from Vercel's serverless region (likely iad1) does not
 *     prove signing works from a fleet VM (Linode us-east). If Bankr's edge
 *     routes Vercel and Linode requests through different backend pools, a
 *     fleet-VM-side outage could be invisible to this probe. Phase 2: a
 *     pull-model probe FROM a sentinel VM on the fleet.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { sendAdminAlertEmail } from "@/lib/email";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BANKR_API_URL = "https://api.bankr.bot";
const PROBE_TIMEOUT_MS = 10_000;
const ALERT_DEDUP_KEY = "bankr-signing-health-down";
const ALERT_COOLDOWN_HOURS = 6;
const CONSECUTIVE_FAILURES_FOR_ALERT = 3;

// Known-good public address used for the no-auth doppler probe. This is
// vm-1043 (Cooper's demo VM); the doppler endpoint returns a stable JSON
// regardless of whether the wallet has activity, so it's a clean liveness
// signal.
const PROBE_WALLET = "0xd998a6dc14e5ec290b2a9f201d6a6c82a1dd38c4";

interface ProbeResult {
  ok: boolean;
  status: string; // "ok" | "http_<code>" | "timeout" | "exception"
  http_code: number;
  wall_ms: number;
  error: string;
}

async function probeEndpoint(url: string, headers?: Record<string, string>): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: "application/json", ...(headers ?? {}) },
    });
    clearTimeout(t);
    const status = res.ok ? "ok" : `http_${res.status}`;
    return {
      ok: res.ok,
      status,
      http_code: res.status,
      wall_ms: Date.now() - start,
      error: res.ok ? "" : `HTTP ${res.status}`,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: msg.toLowerCase().includes("abort") ? "timeout" : "exception",
      http_code: 0,
      wall_ms: Date.now() - start,
      error: msg.slice(0, 200),
    };
  }
}

async function runPublicProbe(): Promise<ProbeResult> {
  return probeEndpoint(`${BANKR_API_URL}/public/doppler/creator-fees/${PROBE_WALLET}`);
}

async function runPartnerProbe(): Promise<ProbeResult | null> {
  const partnerKey = process.env.BANKR_PARTNER_KEY;
  if (!partnerKey) {
    // No partner key configured — skip silently (the public probe is the
    // baseline). Don't log a warning here because a missing partner key on
    // the cron host is a deliberate operator state during initial rollout.
    return null;
  }
  return probeEndpoint(`${BANKR_API_URL}/partner/wallets`, {
    "X-Partner-Key": partnerKey,
  });
}

async function recordProbe(
  pub: ProbeResult,
  priv: ProbeResult | null,
): Promise<{ ok: boolean }> {
  // Definition of "probe ok": public MUST be ok. Partner is ok if either it
  // was skipped (no key configured) OR it returned ok. A partner-only failure
  // with public ok is a real concern (auth/billing layer) — still mark probe
  // failure.
  const ok = pub.ok && (priv === null || priv.ok);

  const supabase = getSupabase();
  await supabase.from("instaclaw_bankr_probe_log").insert({
    ok,
    public_status: pub.status,
    public_http: pub.http_code,
    public_wall_ms: pub.wall_ms,
    private_status: priv?.status ?? null,
    private_http: priv?.http_code ?? null,
    private_wall_ms: priv?.wall_ms ?? null,
    error: ok ? null : [pub.error, priv?.error].filter(Boolean).join(" | ").slice(0, 500),
  });

  return { ok };
}

async function maybeFireAlert(currentOk: boolean): Promise<{ alerted: boolean; reason: string }> {
  if (currentOk) {
    return { alerted: false, reason: "current probe ok" };
  }

  const supabase = getSupabase();

  // Check the last N consecutive rows. If they're all not-ok, fire.
  const { data: recent } = await supabase
    .from("instaclaw_bankr_probe_log")
    .select("ok, probed_at")
    .order("probed_at", { ascending: false })
    .limit(CONSECUTIVE_FAILURES_FOR_ALERT);

  if (!recent || recent.length < CONSECUTIVE_FAILURES_FOR_ALERT) {
    return { alerted: false, reason: `not enough history (${recent?.length ?? 0} rows)` };
  }
  if (recent.some((r) => r.ok)) {
    return { alerted: false, reason: "not yet 3 consecutive failures" };
  }

  // Check 6h dedup
  const cooldownAgoIso = new Date(
    Date.now() - ALERT_COOLDOWN_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const { data: alertRecent } = await supabase
    .from("instaclaw_admin_alert_log")
    .select("id")
    .eq("alert_key", ALERT_DEDUP_KEY)
    .gte("sent_at", cooldownAgoIso)
    .limit(1);
  if (alertRecent && alertRecent.length > 0) {
    return { alerted: false, reason: "within 6h dedup window" };
  }

  // Fire
  const sinceFirstFailureIso = recent[recent.length - 1].probed_at;
  const subject = `[P0] Bankr signing service DOWN — 3 consecutive probe failures`;
  const body =
    `cron/bankr-signing-health has observed 3 consecutive probe failures.\n\n` +
    `First failure (this streak):  ${sinceFirstFailureIso}\n` +
    `Probe interval:               60s\n` +
    `Probed wallet:                ${PROBE_WALLET}\n\n` +
    `BLAST RADIUS\n` +
    `------------\n` +
    `Bankr is the SHARED signing primitive for every InstaClaw agent. While\n` +
    `this is firing, fleet-wide:\n` +
    `  - Every onchain DeFi action (Morpho deposit, Aerodrome swap, etc.) fails\n` +
    `  - Wallet transfers fail\n` +
    `  - Token launches via /api/bankr/tokenize return 502 to the user\n` +
    `  - Read-only paths (balances, portfolio, token prices) continue to work\n\n` +
    `OPERATOR ACTIONS (in order)\n` +
    `---------------------------\n` +
    `1. Check Bankr partner dashboard: https://bankr.bot/partner\n` +
    `   - Gas sponsorship credit balance > $0?\n` +
    `   - Any "Needs Attention" badge?\n` +
    `   - Recent rate-limit / quota events?\n` +
    `   (2026-05-27 INC: a near-identical 502 cascade was caused by\n` +
    `    gas-sponsorship credits hitting $0, NOT a Bankr-side outage.)\n\n` +
    `2. If sponsorship credits are fine, contact Igor with these probe results\n` +
    `   plus any user-side request IDs (format: 01KSP...) from session jsonl.\n\n` +
    `3. Activate the platform circuit breaker:\n` +
    `     printf 'true' | npx vercel env add BANKR_MAINTENANCE production\n` +
    `   This gates new wallet provisioning + returns 503 with a maintenance\n` +
    `   notice to /api/bankr/tokenize. Read-only paths stay live.\n\n` +
    `4. Once Bankr is back up:\n` +
    `     printf 'false' | npx vercel env add BANKR_MAINTENANCE production\n\n` +
    `Next alert for this key suppressed for ${ALERT_COOLDOWN_HOURS}h.\n` +
    `Recent probe rows: SELECT * FROM instaclaw_bankr_probe_log ORDER BY probed_at DESC LIMIT 20;`;

  await supabase.from("instaclaw_admin_alert_log").insert({
    alert_key: ALERT_DEDUP_KEY,
    vm_count: 0,
    details: `bankr-signing-health: ${CONSECUTIVE_FAILURES_FOR_ALERT} consecutive failures`,
  });
  await sendAdminAlertEmail(subject, body);
  return { alerted: true, reason: "fired P0 alert" };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const start = Date.now();
  const [pub, priv] = await Promise.all([runPublicProbe(), runPartnerProbe()]);
  const { ok } = await recordProbe(pub, priv);
  const { alerted, reason } = await maybeFireAlert(ok);
  const wallMs = Date.now() - start;

  logger.info("bankr-signing-health: probe completed", {
    route: "cron/bankr-signing-health",
    ok,
    public_status: pub.status,
    public_http: pub.http_code,
    public_wall_ms: pub.wall_ms,
    private_status: priv?.status ?? "skipped",
    private_http: priv?.http_code ?? null,
    alerted,
    alert_reason: reason,
    wall_ms: wallMs,
  });

  return NextResponse.json({
    ok,
    public: pub,
    private: priv,
    alerted,
    alert_reason: reason,
    wall_ms: wallMs,
  });
}
