/**
 * /go/:code — short-link resolver for channel-onboarding flow.
 *
 * Welcome Message 3 (the bare URL in its own iMessage / Telegram
 * bubble) points here. The user taps the link, lands on this route,
 * we look up the pending_users.short_code in the DB, and 302 to
 * /auth?session=<id>.
 *
 * Behavior table:
 *   - Malformed code (regex fail)    → 302 /?go=invalid
 *   - Code not found in DB           → 302 /?go=notfound
 *   - Code found, already consumed   → 302 /dashboard
 *   - Code found, still in-flight    → 302 /auth?session=<id>
 *
 * Public route: no auth required (per design — the URL itself is
 * the only credential). The middleware matcher in middleware.ts
 * does NOT include /go/*, so requests reach this handler directly.
 *
 * Why route.ts (not page.tsx):
 *   We want a clean 302 with no React render — the user taps, gets
 *   redirected immediately, no flash of content. Route Handlers
 *   return a Response; pages render UI.
 *
 * Why .select("*") over a column list:
 *   Per CLAUDE.md Rule 19, safety-critical reads use .select("*")
 *   to avoid silent column-grant gotchas under RLS. Here we need
 *   id + consumed_at + short_code itself, plus this is the entry
 *   point to onboarding — being wrong here means a paying user
 *   sees a broken link.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

// Short_code format: 4-8 chars, lowercase alphanumeric.
// Migration column: VARCHAR(8). Generator: 5 chars [a-z0-9].
// Tolerant of 4-8 in case we ever change the length and the user
// has an older link cached.
const SHORT_CODE_REGEX = /^[a-z0-9]{4,8}$/;

/**
 * 302 redirect with anti-caching + anti-indexing headers.
 *
 * Cache-Control: no-store prevents browsers and CDNs from caching
 * the redirect. We need every visit to re-resolve because the
 * underlying pending_users.consumed_at can change between visits
 * (active → consumed) — a cached 302 would send a returning user
 * to the wrong destination.
 *
 * X-Robots-Tag: noindex, nofollow keeps these URLs out of search
 * indexes if they ever leak (screenshotted, shared, etc.).
 */
function redirectWithNoCache(target: URL): NextResponse {
  const response = NextResponse.redirect(target, { status: 302 });
  response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
  response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return response;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code: rawCode } = await params;

  // iOS Safari and Telegram in-app browsers preserve URL case
  // exactly as the user tapped, but iMessage's auto-link sometimes
  // capitalizes the first letter when the URL is right after a
  // period. Normalize to lowercase before the regex + DB lookup.
  const code = (rawCode || "").toLowerCase().trim();

  if (!SHORT_CODE_REGEX.test(code)) {
    logger.warn("[/go] malformed short_code", {
      rawCodeLength: rawCode?.length ?? 0,
    });
    return redirectWithNoCache(new URL("/?go=invalid", req.url));
  }

  const supabase = getSupabase();

  const { data: pending, error } = await supabase
    .from("instaclaw_pending_users")
    .select("*")
    .eq("short_code", code)
    .maybeSingle();

  if (error) {
    logger.error("[/go] DB error looking up short_code", {
      code,
      errorMessage: error.message,
    });
    // Treat as not-found from the user's POV. We don't want to
    // leak DB state to the channel-onboarding flow.
    return redirectWithNoCache(new URL("/?go=notfound", req.url));
  }

  if (!pending) {
    logger.info("[/go] short_code not found", { code });
    return redirectWithNoCache(new URL("/?go=notfound", req.url));
  }

  // Already consumed (VM ready, M_RETURN fired). The link served
  // its purpose; the user is fully onboarded. Send them to the
  // dashboard — the auth-session check there will redirect to
  // /signin if they're not logged in, which is the right
  // affordance for a returning user revisiting an old link.
  if (pending.consumed_at) {
    logger.info("[/go] short_code already consumed; redirecting to dashboard", {
      code,
      consumedAt: pending.consumed_at,
    });
    return redirectWithNoCache(new URL("/dashboard", req.url));
  }

  // Active in-flight signup. Hand off to /auth with the session id
  // so the auth page can bind the OAuth result to this pending row.
  logger.info("[/go] resolved to active session; routing to /auth", {
    code,
    pendingId: pending.id,
    channel: pending.channel,
  });
  return redirectWithNoCache(
    new URL(`/auth?session=${pending.id}`, req.url),
  );
}
