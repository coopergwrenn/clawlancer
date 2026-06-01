/**
 * cron/probe-toolrouter-balance — hourly probe of the ToolRouter credit
 * balance + runway alerting. PRD §4.9 + §7.8 Task H.
 *
 * Endpoint: GET https://toolrouter.world/v1/balance with Bearer auth.
 * Source: github.com/andy-t-wang/toolrouter apps/api/src/routes/ledger.routes.ts:51.
 * Returns the user-scoped credit balance (USD) for the API key we present.
 *
 * Alerting (per Rule 67 Anthropic-balance pattern):
 *   - WARN at 7-day estimated runway (balance / 7d-spend < 7)
 *   - P1   at 3-day estimated runway
 *   - P0   at <24h runway, daily-deduped via instaclaw_admin_alert_log
 *
 * Schedule: hourly via vercel.json crons.
 * Rule 11: maxDuration = 60 (single HTTP call, low budget needed).
 * Rule 39: every failure logs only — never blocks anything fleet-side.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { sendAdminAlertEmail } from "@/lib/email";
import { getToolRouterEnv } from "@/lib/toolrouter-client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PROBE_TIMEOUT_MS = 10_000;
const WARN_RUNWAY_DAYS = 7;
const P1_RUNWAY_DAYS = 3;
const P0_RUNWAY_DAYS = 1;

interface BalanceResponse {
  balance_usd?: number | string;
  balance?: number | string;
  available_usd?: number | string;
  // Tolerant of shape changes — toolrouter API may use any of these.
  [k: string]: unknown;
}

function parseBalanceUsd(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as BalanceResponse;
  for (const key of ["balance_usd", "available_usd", "balance"]) {
    const v = obj[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

async function fetchBalance(apiKey: string, apiUrl: string): Promise<{ ok: boolean; balanceUsd?: number; error?: string; http_code?: number }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${apiUrl}/v1/balance`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      return { ok: false, http_code: res.status, error: bodyText.slice(0, 200) };
    }
    const body = await res.json();
    const balanceUsd = parseBalanceUsd(body);
    if (balanceUsd === null) {
      return { ok: false, error: `unexpected response shape: ${JSON.stringify(body).slice(0, 200)}` };
    }
    return { ok: true, balanceUsd };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(t);
  }
}

async function estimateDailySpend(supabase: ReturnType<typeof getSupabase>): Promise<number> {
  // Read last 7 days of toolrouter call log, sum amount_usd. Returns
  // average daily spend in USD. If the table doesn't exist yet (pre-Task K)
  // OR has zero rows, returns 0 (no runway calculation possible).
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
  const { data, error } = await supabase
    .from("instaclaw_toolrouter_call_log")
    .select("amount_usd")
    .gte("ts", sevenDaysAgo);
  if (error || !data) return 0;
  const total = data.reduce((sum: number, row: any) => {
    const v = Number(row.amount_usd);
    return Number.isFinite(v) ? sum + v : sum;
  }, 0);
  return total / 7;
}

async function alertIfNew(
  supabase: ReturnType<typeof getSupabase>,
  alertKey: string,
  cooldownHours: number,
  subject: string,
  body: string,
): Promise<boolean> {
  const cooldownAgo = new Date(Date.now() - cooldownHours * 3600_000).toISOString();
  const { data } = await supabase
    .from("instaclaw_admin_alert_log")
    .select("id")
    .eq("alert_key", alertKey)
    .gte("created_at", cooldownAgo)
    .limit(1);
  if (data && data.length > 0) return false;
  await sendAdminAlertEmail(subject, body);
  await supabase.from("instaclaw_admin_alert_log").insert({
    alert_key: alertKey,
    created_at: new Date().toISOString(),
  });
  return true;
}

export async function GET(_request: NextRequest): Promise<NextResponse> {
  if (process.env.TOOLROUTER_ENABLED !== "true") {
    return NextResponse.json({ ok: true, skipped: "TOOLROUTER_ENABLED != 'true'" });
  }
  const env = getToolRouterEnv();
  if (!env) {
    return NextResponse.json({ ok: true, skipped: "TOOLROUTER_API_KEY not set or malformed" });
  }
  const result = await fetchBalance(env.apiKey, env.apiUrl);
  if (!result.ok || result.balanceUsd === undefined) {
    logger.warn("probe-toolrouter-balance: balance fetch failed", { result });
    return NextResponse.json({ ok: false, error: result.error || "fetch failed", http_code: result.http_code });
  }
  const balanceUsd = result.balanceUsd;
  const supabase = getSupabase();
  const dailySpend = await estimateDailySpend(supabase);
  const runwayDays = dailySpend > 0 ? balanceUsd / dailySpend : Infinity;
  logger.info("probe-toolrouter-balance: snapshot", {
    balance_usd: balanceUsd,
    daily_spend_usd: dailySpend,
    runway_days: runwayDays,
  });

  let alertFired: string | null = null;
  const baseBody = `ToolRouter balance: $${balanceUsd.toFixed(2)} USD.\n7-day avg spend: $${dailySpend.toFixed(2)}/day.\nEst. runway: ${Number.isFinite(runwayDays) ? runwayDays.toFixed(1) + " days" : "infinite (no recent spend)"}.\n\nTop up at https://toolrouter.world/dashboard.`;
  if (runwayDays < P0_RUNWAY_DAYS) {
    const sent = await alertIfNew(supabase, "toolrouter_balance_p0", 24, "[P0] ToolRouter balance < 24h runway", baseBody);
    if (sent) alertFired = "p0";
  } else if (runwayDays < P1_RUNWAY_DAYS) {
    const sent = await alertIfNew(supabase, "toolrouter_balance_p1", 24, "[P1] ToolRouter balance < 3-day runway", baseBody);
    if (sent) alertFired = "p1";
  } else if (runwayDays < WARN_RUNWAY_DAYS) {
    const sent = await alertIfNew(supabase, "toolrouter_balance_warn", 24, "[WARN] ToolRouter balance < 7-day runway", baseBody);
    if (sent) alertFired = "warn";
  }

  return NextResponse.json({
    ok: true,
    balance_usd: balanceUsd,
    daily_spend_usd: dailySpend,
    runway_days: Number.isFinite(runwayDays) ? runwayDays : null,
    alert_fired: alertFired,
  });
}
