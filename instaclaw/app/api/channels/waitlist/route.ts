/**
 * POST /api/channels/waitlist
 *
 * Captures email + requested_channel from users who picked Discord
 * or Slack on /channels. Distinct from the legacy /api/waitlist
 * (landing-page email capture; gated by WAITLIST_MODE env). This
 * endpoint is always-open: channel waitlist signups must always
 * succeed regardless of WAITLIST_MODE.
 *
 * Storage: shares the instaclaw_waitlist table with the legacy
 * landing-waitlist rows. Channel rows are distinguished by
 * requested_channel IS NOT NULL (per the partial unique index
 * added in 20260526180000_onboarding_redesign_channels.sql).
 *
 * Auth: public (in selfAuthAPIs middleware allow-list). Rate-
 * limited by hashed IP — same ratchet as the legacy /api/waitlist.
 *
 * Body:
 *   email: string (E.164-like; validated against EMAIL_RE)
 *   requested_channel: "discord" | "slack"
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALLOWED_CHANNELS = new Set(["discord", "slack"]);
const RATE_LIMIT_PER_IP_PER_MINUTE = 5;

async function hashIP(ip: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(ip + "instaclaw-salt");
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function POST(req: NextRequest) {
  let body: { email?: unknown; requested_channel?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON" },
      { status: 400 },
    );
  }

  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const channel =
    typeof body.requested_channel === "string"
      ? body.requested_channel.trim().toLowerCase()
      : "";

  if (!EMAIL_RE.test(email)) {
    return NextResponse.json(
      { ok: false, error: "Please enter a valid email." },
      { status: 400 },
    );
  }

  if (!ALLOWED_CHANNELS.has(channel)) {
    return NextResponse.json(
      { ok: false, error: "Invalid channel." },
      { status: 400 },
    );
  }

  // Rate-limit by IP. Same ratchet as legacy /api/waitlist.
  const forwarded = req.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() ?? "unknown";
  const ipHash = await hashIP(ip);

  const supabase = getSupabase();
  const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();

  const { count: recentRequests } = await supabase
    .from("instaclaw_waitlist")
    .select("*", { count: "exact", head: true })
    .eq("ip_hash", ipHash)
    .gte("created_at", oneMinuteAgo);

  if (recentRequests !== null && recentRequests >= RATE_LIMIT_PER_IP_PER_MINUTE) {
    return NextResponse.json(
      { ok: false, error: "Too many requests. Try again in a minute." },
      { status: 429 },
    );
  }

  // INSERT — let the partial unique index catch dupes, surface as
  // "already on the list" rather than an error.
  const { error: insertErr } = await supabase
    .from("instaclaw_waitlist")
    .insert({
      email,
      requested_channel: channel,
      source: "channels-page",
      ip_hash: ipHash,
      referrer: req.headers.get("referer") ?? null,
    });

  if (insertErr) {
    // 23505 = unique_violation (already on the list for this channel)
    if ((insertErr as { code?: string }).code === "23505") {
      return NextResponse.json({
        ok: true,
        message: "you're already on the list — we'll email when it's ready.",
      });
    }

    logger.error("[/api/channels/waitlist] insert failed", {
      route: "channels/waitlist",
      email: email.slice(0, 3) + "***",
      channel,
      error: insertErr.message,
    });
    return NextResponse.json(
      { ok: false, error: "Couldn't save — try again." },
      { status: 500 },
    );
  }

  logger.info("[/api/channels/waitlist] signup", {
    route: "channels/waitlist",
    email: email.slice(0, 3) + "***",
    channel,
  });

  return NextResponse.json({
    ok: true,
    message: "on the list. we'll email when it's ready.",
  });
}
