/**
 * GET /api/partner/tag-redirect
 *
 * The "Sign in to claim it for Edge" path from /edge/claim. Designed as
 * a NextAuth `callbackUrl` target — clicked from a logged-out state by an
 * existing-InstaClaw-account holder who wants to tag their existing account
 * + VM as `edge_city`.
 *
 * Flow:
 *   1. User clicks "Sign in to claim it for Edge →" on /edge/claim.
 *   2. They land on /signin?callbackUrl=/api/partner/tag-redirect.
 *   3. Google OAuth completes; NextAuth 302s to this route.
 *   4. We read the session, call tagUserAsPartner(..., "edge_city"),
 *      set the cookie defensively, and 302 to /dashboard.
 *
 * Why a dedicated route vs. just relying on the lib/auth.ts signIn
 * callback's cookie-aware tagging? Because the cookie is NOT set when a
 * user clicks the "Sign in" link directly — they haven't been through
 * /edge's claim CTA. This route closes that gap by tagging on the
 * post-OAuth landing instead of pre-OAuth cookie write.
 *
 * Sibling of POST /api/partner/tag (which serves the cookie + JSON path).
 * Same allow-list semantics: validates partner internally; partner is
 * hard-coded to edge_city here since this route is dedicated to the
 * Edge Esmeralda BYO flow. To add another partner (Eclipse, etc.), copy
 * the route to /api/partner/<slug>-redirect.
 *
 * Middleware: allow-listed in middleware.ts:selfAuthAPIs (Rule 13). The
 * route handler itself enforces session — unauthenticated callers get
 * a 302 back to /signin with this URL as the callback.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { tagUserAsPartner } from "@/lib/partner-tag";
import {
  verifyEdgeVerifiedCookie,
  EDGE_VERIFIED_COOKIE_NAME,
} from "@/lib/edge-verified-cookie";
import { logger } from "@/lib/logger";

const PARTNER = "edge_city";
const PARTNER_COOKIE = "instaclaw_partner";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days — survives OAuth round-trip
const SELF_PATH = "/api/partner/tag-redirect";

function buildRedirect(req: NextRequest, target: string): NextResponse {
  const url = new URL(target, req.url);
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest) {
  const session = await auth();

  // ── Not authenticated → bounce to /signin with self as callback. ──
  // We do NOT set the partner cookie here. Prior to the EdgeOS gate
  // (2026-05-20) this route used to seed the cookie defensively. That
  // path bypassed verification — a non-attendee could click "Sign in
  // to claim it for Edge" directly, get the cookie set, sign in, and
  // be tagged as edge_city without proving an EE26 ticket. The fix:
  // require the signed `edge_verified_email` cookie below, which can
  // ONLY be minted by /api/edge/verify-ticket after a real EdgeOS hit.
  if (!session?.user?.id) {
    return buildRedirect(
      req,
      `/signin?callbackUrl=${encodeURIComponent(SELF_PATH)}`,
    );
  }

  // ── Gate enforcement: require a valid signed edge-verified cookie. ──
  // The cookie is minted by /api/edge/verify-ticket on a successful
  // EdgeOS attendee lookup, with a 15-min TTL — long enough to survive
  // the OAuth round-trip, short enough that a leaked cookie is
  // operationally useless.
  //
  // If the cookie is missing/expired/tampered, we bounce to
  // /edge/claim?error=must-verify-first. The user lands back at the
  // gate and re-verifies. Clear both cookies on the way out so a
  // half-state isn't carried.
  const cookieRaw = req.cookies.get(EDGE_VERIFIED_COOKIE_NAME)?.value;
  const cookieResult = verifyEdgeVerifiedCookie(cookieRaw);
  if (!cookieResult.ok || !cookieResult.email) {
    logger.warn("tag-redirect: edge_verified cookie missing or invalid", {
      route: "api/partner/tag-redirect",
      userId: session.user.id,
      reason: cookieResult.reason,
      hadCookie: !!cookieRaw,
    });
    const res = buildRedirect(req, "/edge/claim?error=must-verify-first");
    res.cookies.delete(PARTNER_COOKIE);
    res.cookies.delete(EDGE_VERIFIED_COOKIE_NAME);
    return res;
  }

  // Strict email match — the cookie must have been minted for the same
  // email the user just signed in with. Mirrors lib/auth.ts:signIn
  // callback's check. Known UX limitation: users whose EE26-registered
  // email differs from their Google account email will be blocked here.
  // For V1 launch we accept that trade-off (closes the enumeration
  // attack; if 10%+ of attendees report blockage post-launch, loosen +
  // add rate-limiting to verify-ticket as a hardening pass).
  const sessionEmail = session.user.email?.trim().toLowerCase() ?? null;
  if (!sessionEmail || cookieResult.email !== sessionEmail) {
    logger.warn("tag-redirect: cookie email != signin email", {
      route: "api/partner/tag-redirect",
      userId: session.user.id,
      cookieEmail: cookieResult.email,
      sessionEmail,
    });
    const res = buildRedirect(req, "/edge/claim?error=email-mismatch");
    res.cookies.delete(PARTNER_COOKIE);
    res.cookies.delete(EDGE_VERIFIED_COOKIE_NAME);
    return res;
  }

  // ── Authenticated + verified → tag, sync VM, set cookie, redirect. ──
  // The edge_verified_email column write happens in lib/auth.ts's signIn
  // callback (which fires immediately before this route on OAuth return)
  // — we DON'T re-write it here. Just the partner-tag step.
  const supabase = getSupabase();
  const result = await tagUserAsPartner(supabase, session.user.id, PARTNER);

  // Failure path: surface the error via a query param on /dashboard so the
  // operator (us) can grep for it in logs without showing a hard error UI.
  // The tag operation is idempotent — they can retry by clicking the link
  // again. Don't fail the redirect loudly.
  const destination = !result.ok
    ? "/dashboard?partner_tag_error=1"
    : result.hasVm
      ? "/dashboard"
      : "/plan"; // 2026-05-29: was /connect; Cooper's new onboarding
                 // flow sends Edge attendees (and everyone else) straight
                 // to /plan after auth — /connect is now an opt-in path
                 // via the "use the legacy setup" footnote on /plan.

  const res = buildRedirect(req, destination);
  res.cookies.set(PARTNER_COOKIE, PARTNER, {
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
    sameSite: "lax",
  });
  return res;
}
