/**
 * POST /api/edge/verify-ticket
 *
 * The verification gate that sits in front of the entire Edge Esmeralda
 * 2026 onboarding funnel. Two responsibilities:
 *
 *   1. Confirm that the submitted email is registered with EdgeOS as
 *      an EE26 attendee — protects sponsor-funded inference budget.
 *   2. Mint a 15-min HMAC-signed cookie that carries the verified email
 *      through the OAuth round-trip on /connect, so the auth callback
 *      can write `instaclaw_users.edge_verified_email` on session
 *      creation. That column has a partial UNIQUE index — DB-level
 *      enforcement of 1-agent-per-EdgeOS-email FOR EDGE ATTENDEES
 *      ONLY (non-Edge users keep multi-agent freedom by leaving the
 *      column NULL).
 *
 * Decision tree (in order, short-circuit on each):
 *
 *   a. Pre-flight email shape check (must contain '@', non-empty).
 *      → return `invalid_email` without DB or EdgeOS work.
 *
 *   b. DB already-claimed check:
 *        SELECT id FROM instaclaw_users
 *        WHERE edge_verified_email = $1 LIMIT 1
 *      If the row matches AND the current session.user.id is different
 *      (or absent), that email belongs to someone else — return
 *      `already_claimed`. If the current session.user.id IS the same,
 *      this is a benign re-verification (e.g., user came back to the
 *      page after a partial flow); fall through to mint a fresh cookie.
 *
 *   c. `lib/edgeos.ts:verifyAttendeeByEmail` — the EdgeOS round-trip.
 *      Returns one of:
 *        - { verified: true }
 *        - { verified: true, degraded: true } — partner API outage,
 *          we let through and log. Cookie still gets minted.
 *        - { verified: false, reason: "not_found" | … }
 *      On positive verification (with or without degradation): mint
 *      signed cookie + partner cookie, and IF a session exists, write
 *      the column immediately (avoids the OAuth callback responsibility
 *      for already-logged-in users hitting /edge/claim).
 *
 * Failure modes the route surfaces to the gate UI (response.reason):
 *   - "invalid_email" — pre-flight failed
 *   - "not_found"      — EdgeOS doesn't have the email
 *   - "already_claimed" — column unique-index already matches
 *   - "rate_limited"   — EdgeOS 429 (rare unless attacker)
 *   - "api_error"      — EdgeOS responded unexpectedly (NOT degraded — those let through)
 *   - "server_error"   — our DB or cookie minting blew up
 *
 * Middleware allow-list: this route is in `selfAuthAPIs` because we
 * accept anonymous callers (the gate runs pre-auth). Session check
 * happens inside the handler, used only to short-cut the DB write path
 * when a user is already authenticated.
 *
 * Cookie semantics:
 *   - `edge_verified_email` (signed, 15-min, httpOnly) — chain-of-custody
 *     from gate to auth callback. See lib/edge-verified-cookie.ts.
 *   - `instaclaw_partner` (plain, 7-day, sameSite=Lax) — existing
 *     mechanism that triggers Edge palette + edge-skill install for
 *     verified attendees. Mirrors POST /api/partner/tag's cookie shape.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { verifyAttendeeByEmail } from "@/lib/edgeos";
import {
  signEdgeVerifiedCookie,
  EDGE_VERIFIED_COOKIE_NAME,
  EDGE_VERIFIED_COOKIE_MAX_AGE_S,
} from "@/lib/edge-verified-cookie";
import { tagUserAsPartner } from "@/lib/partner-tag";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const PARTNER_COOKIE = "instaclaw_partner";
const PARTNER_COOKIE_MAX_AGE_S = 60 * 60 * 24 * 7;
const PARTNER_VALUE = "edge_city";

interface SuccessResponse {
  verified: true;
  degraded?: boolean;
  /** Email echoed back, lower-cased — useful for the verified UX state. */
  email: string;
}

interface FailureResponse {
  verified: false;
  reason:
    | "invalid_email"
    | "not_found"
    | "already_claimed"
    | "rate_limited"
    | "api_error"
    | "server_error";
}

type Response = SuccessResponse | FailureResponse;

export async function POST(req: NextRequest) {
  // 1. Parse + shape-check input.
  let email: string;
  try {
    const body = (await req.json()) as { email?: unknown };
    if (typeof body?.email !== "string") {
      return NextResponse.json<Response>(
        { verified: false, reason: "invalid_email" },
        { status: 200 },
      );
    }
    email = body.email.trim().toLowerCase();
  } catch {
    return NextResponse.json<Response>(
      { verified: false, reason: "invalid_email" },
      { status: 200 },
    );
  }
  if (!email || !email.includes("@")) {
    return NextResponse.json<Response>(
      { verified: false, reason: "invalid_email" },
      { status: 200 },
    );
  }

  const supabase = getSupabase();
  const session = await auth();
  const sessionUserId = session?.user?.id ?? null;

  // 2. DB already-claimed check.
  const { data: existingClaim, error: existingErr } = await supabase
    .from("instaclaw_users")
    .select("id")
    .eq("edge_verified_email", email)
    .maybeSingle();
  if (existingErr) {
    logger.error("verify-ticket: DB already-claimed lookup failed", {
      route: "api/edge/verify-ticket",
      err: String(existingErr.message),
      code: existingErr.code,
    });
    return NextResponse.json<Response>(
      { verified: false, reason: "server_error" },
      { status: 500 },
    );
  }

  // If the email is already claimed by SOMEONE ELSE, block. If it's the
  // current session user (benign re-verification), fall through.
  if (existingClaim && existingClaim.id !== sessionUserId) {
    return NextResponse.json<Response>(
      { verified: false, reason: "already_claimed" },
      { status: 200 },
    );
  }

  // 3. EdgeOS round-trip (lib/edgeos handles overrides + degrade-on-outage).
  const verification = await verifyAttendeeByEmail(email);

  if (!verification.verified) {
    return NextResponse.json<Response>(
      {
        verified: false,
        reason:
          verification.reason === "not_found"
            ? "not_found"
            : verification.reason === "invalid_email"
              ? "invalid_email"
              : verification.reason === "rate_limited"
                ? "rate_limited"
                : "api_error",
      },
      { status: 200 },
    );
  }

  // 4. Verified path. Mint the signed cookie.
  const signResult = signEdgeVerifiedCookie(email);
  if (!signResult.ok || !signResult.cookie) {
    logger.error("verify-ticket: signed-cookie mint failed", {
      route: "api/edge/verify-ticket",
      err: signResult.error,
    });
    return NextResponse.json<Response>(
      { verified: false, reason: "server_error" },
      { status: 500 },
    );
  }

  const res = NextResponse.json<Response>(
    {
      verified: true,
      degraded: verification.degraded || undefined,
      email,
    },
    { status: 200 },
  );

  // Signed cookie: chain-of-custody to the auth signIn callback.
  res.cookies.set(EDGE_VERIFIED_COOKIE_NAME, signResult.cookie, {
    path: "/",
    maxAge: EDGE_VERIFIED_COOKIE_MAX_AGE_S,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });

  // Partner cookie: triggers Edge palette + reconciler-side skill install.
  res.cookies.set(PARTNER_COOKIE, PARTNER_VALUE, {
    path: "/",
    maxAge: PARTNER_COOKIE_MAX_AGE_S,
    sameSite: "lax",
  });

  // 5. If a session exists, write the column NOW (avoid the auth-callback
  //    responsibility for already-logged-in users completing verification
  //    on /edge/claim). The signIn callback path covers fresh signups.
  if (sessionUserId) {
    const { error: updateErr } = await supabase
      .from("instaclaw_users")
      .update({ edge_verified_email: email })
      .eq("id", sessionUserId)
      // Idempotent: skip if the column already matches (benign re-verify).
      .or(`edge_verified_email.is.null,edge_verified_email.eq.${email}`);
    if (updateErr) {
      // 23505 = unique violation = someone else already claimed this email
      // between our SELECT above and this UPDATE (race). Surface as
      // already_claimed; revoke the cookies we just set so the next
      // request doesn't carry stale verification.
      if (updateErr.code === "23505") {
        const conflict = NextResponse.json<Response>(
          { verified: false, reason: "already_claimed" },
          { status: 200 },
        );
        conflict.cookies.delete(EDGE_VERIFIED_COOKIE_NAME);
        conflict.cookies.delete(PARTNER_COOKIE);
        return conflict;
      }
      logger.error("verify-ticket: session-user column write failed", {
        route: "api/edge/verify-ticket",
        userId: sessionUserId,
        err: String(updateErr.message),
        code: updateErr.code,
      });
      // Don't fail the whole request — column write is a tighten-the-screws
      // step. The cookie chain still lets the auth callback retry on next
      // signIn. Log and continue.
    } else {
      // Apply partner tag inline too. tagUserAsPartner is idempotent and
      // never throws — safe to fire-and-forget but we await for log
      // consistency.
      const tagResult = await tagUserAsPartner(supabase, sessionUserId, PARTNER_VALUE);
      if (!tagResult.ok) {
        logger.warn("verify-ticket: partner tag failed (non-fatal)", {
          route: "api/edge/verify-ticket",
          userId: sessionUserId,
          err: tagResult.error,
        });
      }
    }
  }

  // 6. Structured telemetry — useful for funnel monitoring on launch day.
  logger.info("verify-ticket: success", {
    route: "api/edge/verify-ticket",
    emailDomain: email.split("@")[1] ?? "?",
    degraded: !!verification.degraded,
    hadSession: !!sessionUserId,
  });

  return res;
}
