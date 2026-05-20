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
  if (!session?.user?.id) {
    const res = buildRedirect(
      req,
      `/signin?callbackUrl=${encodeURIComponent(SELF_PATH)}`,
    );
    // Set the cookie defensively so even if the user picks a different
    // signin path (Sign up rather than Sign in), lib/auth.ts's signIn
    // callback applies the partner tag on their first auth.
    res.cookies.set(PARTNER_COOKIE, PARTNER, {
      path: "/",
      maxAge: COOKIE_MAX_AGE_SECONDS,
      sameSite: "lax",
    });
    return res;
  }

  // ── Authenticated → tag, sync VM, set cookie defensively, redirect. ──
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
      : "/connect"; // they're authed but have no VM yet — /connect is the right next step

  const res = buildRedirect(req, destination);
  res.cookies.set(PARTNER_COOKIE, PARTNER, {
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
    sameSite: "lax",
  });
  return res;
}
