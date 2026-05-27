/**
 * cron/probe-toolrouter-registry — hourly probe for the future hosted
 * streamable-http MCP endpoint at toolrouter.world. PRD §7.9 Task I.
 *
 * Today the @worldcoin/toolrouter npm adapter speaks stdio. Andy's Q2 ask:
 * ship a hosted streamable-http MCP endpoint so InstaClaw can wire it
 * directly (no per-session npm spawn). This cron HEAD-probes a list of
 * guessed URLs; on the first 200 + JSON response, alerts so an operator
 * can plan flipping TOOLROUTER_TRANSPORT="streamable-http" via vercel env.
 *
 * Per Rule 64 we NEVER auto-flip — Cooper approves the mode change after
 * canary testing.
 *
 * Schedule: hourly via vercel.json crons.
 * Rule 11: maxDuration = 60.
 * Rule 39: never blocks anything fleet-side; pure observability.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { sendAdminAlertEmail } from "@/lib/email";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PROBE_TIMEOUT_MS = 5_000;
const ALERT_COOLDOWN_HOURS = 24;

const CANDIDATES: ReadonlyArray<string> = [
  "https://toolrouter.world/mcp",
  "https://toolrouter.world/v1/mcp",
  "https://toolrouter.world/api/mcp",
];

interface ProbeOutcome {
  url: string;
  hit: boolean;
  http_code?: number;
  content_type?: string;
}

async function probeOne(url: string): Promise<ProbeOutcome> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json, text/event-stream" },
      signal: ctrl.signal,
    });
    const ct = res.headers.get("content-type") || "";
    // Hit = HTTP 200/204/401 (auth-required is still a "service is alive"
    // signal) + a JSON-ish or SSE content type. 404 means not implemented.
    const liveStatus = res.status === 200 || res.status === 204 || res.status === 401 || res.status === 405;
    const liveCt = ct.includes("application/json") || ct.includes("text/event-stream");
    return { url, hit: liveStatus && liveCt, http_code: res.status, content_type: ct };
  } catch {
    return { url, hit: false };
  } finally {
    clearTimeout(t);
  }
}

async function alertIfNew(
  supabase: ReturnType<typeof getSupabase>,
  alertKey: string,
  subject: string,
  body: string,
): Promise<boolean> {
  const cooldownAgo = new Date(Date.now() - ALERT_COOLDOWN_HOURS * 3600_000).toISOString();
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
  const outcomes = await Promise.all(CANDIDATES.map(probeOne));
  const hit = outcomes.find((o) => o.hit);
  if (hit) {
    const supabase = getSupabase();
    const body = `Possible ToolRouter streamable-http MCP endpoint detected at:\n  ${hit.url}\n  HTTP ${hit.http_code} (${hit.content_type})\n\nReview at https://toolrouter.world. If confirmed:\n  printf 'streamable-http' | npx vercel env add TOOLROUTER_TRANSPORT production\nReconciler picks up the change on the next tick (~3 min). Canary on the active canary VM first (Rule 64).`;
    const alertKey = `toolrouter_streamable_http:${hit.url.replace(/[^a-z0-9]/gi, "_")}`;
    await alertIfNew(supabase, alertKey, "[P2] ToolRouter streamable-http MCP detected", body);
  }
  logger.info("probe-toolrouter-registry: complete", { outcomes });
  return NextResponse.json({ ok: true, outcomes });
}
