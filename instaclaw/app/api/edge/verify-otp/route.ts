/**
 * POST /api/edge/verify-otp
 *
 * Final step of the Email-code auth path for /edge/claim. The user has:
 *   1. Passed silent /citizens verification (cookie set)
 *   2. Clicked "Email code" → /api/edge/start-email-login fired the OTP
 *   3. Received the 6-digit code in their inbox
 *
 * This endpoint:
 *   1. Re-verifies the signed edge_verified_email cookie (chain-of-custody)
 *   2. Validates the 6-digit code against EdgeOS authenticate endpoint
 *   3. Looks up or creates the instaclaw_users row (linked via email or
 *      created fresh with partner=edge_city + edge_verified_email)
 *   4. Mints a one-shot HMAC token (lib/edge-otp-token.ts)
 *   5. Returns { ok: true, otpToken } to the client
 *
 * The client then calls:
 *   signIn(EDGE_EMAIL_OTP_PROVIDER_ID, { otpToken, callbackUrl: "/plan" })
 *
 * NextAuth's Credentials provider's authorize() in lib/auth.ts verifies
 * the otpToken (HMAC + exp + audience) + does a DB lookup → returns the
 * user → mint session → user lands on /plan (Edge variant).
 * (2026-05-29: callbackUrl was /connect; updated as part of Cooper's
 * onboarding redesign that makes /plan the universal post-auth landing.)
 *
 * Why a one-shot token bridge (vs. just minting the session here):
 *   NextAuth v5 doesn't expose a server-side "create session from a known
 *   user" API. The Credentials provider's signIn() callback is the
 *   idiomatic bridge. The token is the small load-bearing artifact that
 *   crosses the boundary: our server (which knows the user) → NextAuth
 *   (which mints the session).
 *
 * Per-IP rate limit: 10 verify attempts per 15 min. Distinct from the
 * 5-per-15min start limit because users may legitimately mis-type the
 * code once or twice. EdgeOS authenticate also rate-limits per-code.
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateOTP } from "@/lib/edgeos-auth";
import { signEdgeOtpToken } from "@/lib/edge-otp-token";
import {
  verifyEdgeVerifiedCookie,
  EDGE_VERIFIED_COOKIE_NAME,
} from "@/lib/edge-verified-cookie";
import { getSupabase } from "@/lib/supabase";
import { tagUserAsPartner } from "@/lib/partner-tag";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const PARTNER_VALUE = "edge_city";

// Per-IP rate limit. Same shape as /api/edge/start-email-login. Higher
// ceiling (10 vs 5) because mis-typed codes are a real user-error mode.
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 10;
const ipBucket = new Map<string, number[]>();

function rateLimitOk(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const recent = (ipBucket.get(ip) ?? []).filter((t) => t > cutoff);
  if (recent.length >= RATE_LIMIT_MAX) return false;
  recent.push(now);
  ipBucket.set(ip, recent);
  return true;
}

interface SuccessResponse {
  ok: true;
  /** One-shot HMAC token to bridge to NextAuth. 60s TTL. The client
   * passes this as the `otpToken` credential to
   * `signIn(EDGE_EMAIL_OTP_PROVIDER_ID, { otpToken })`. */
  otpToken: string;
}

interface FailureResponse {
  ok: false;
  reason:
    | "no_cookie"
    | "email_mismatch"
    | "invalid_email"
    | "invalid_code"
    | "code_expired"
    | "rate_limited"
    | "api_error"
    | "server_error";
}

type Response = SuccessResponse | FailureResponse;

const SIX_DIGITS = /^\d{6}$/;

export async function POST(req: NextRequest) {
  // ── 1. Parse body ──
  let email: string;
  let code: string;
  try {
    const body = (await req.json()) as { email?: unknown; code?: unknown };
    if (typeof body?.email !== "string" || typeof body?.code !== "string") {
      return NextResponse.json<Response>(
        { ok: false, reason: "invalid_email" },
        { status: 400 },
      );
    }
    email = body.email.trim().toLowerCase();
    code = body.code.trim();
  } catch {
    return NextResponse.json<Response>(
      { ok: false, reason: "invalid_email" },
      { status: 400 },
    );
  }
  if (!email || !email.includes("@")) {
    return NextResponse.json<Response>(
      { ok: false, reason: "invalid_email" },
      { status: 400 },
    );
  }
  if (!SIX_DIGITS.test(code)) {
    return NextResponse.json<Response>(
      { ok: false, reason: "invalid_code" },
      { status: 400 },
    );
  }

  // ── 2. Cookie chain-of-custody ──
  const cookieRaw = req.cookies.get(EDGE_VERIFIED_COOKIE_NAME)?.value ?? null;
  const cookieVerify = verifyEdgeVerifiedCookie(cookieRaw);
  if (!cookieVerify.ok || !cookieVerify.email) {
    logger.warn("verify-otp: no/invalid edge_verified cookie", {
      route: "api/edge/verify-otp",
      reason: cookieVerify.reason,
    });
    return NextResponse.json<Response>(
      { ok: false, reason: "no_cookie" },
      { status: 400 },
    );
  }
  if (cookieVerify.email !== email) {
    logger.warn("verify-otp: cookie email != body email", {
      route: "api/edge/verify-otp",
      cookieEmail: cookieVerify.email,
      bodyEmailDomain: email.split("@")[1] ?? "?",
    });
    return NextResponse.json<Response>(
      { ok: false, reason: "email_mismatch" },
      { status: 400 },
    );
  }

  // ── 3. Per-IP rate limit ──
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";
  if (!rateLimitOk(ip)) {
    return NextResponse.json<Response>(
      { ok: false, reason: "rate_limited" },
      { status: 429 },
    );
  }

  // ── 4. Validate the OTP via EdgeOS authenticate ──
  const authResult = await authenticateOTP(email, code);
  if (!authResult.ok) {
    switch (authResult.status) {
      case "invalid_code":
        return NextResponse.json<Response>(
          { ok: false, reason: "invalid_code" },
          { status: 400 },
        );
      case "rate_limited":
        return NextResponse.json<Response>(
          { ok: false, reason: "rate_limited" },
          { status: 429 },
        );
      case "validation_error":
        return NextResponse.json<Response>(
          { ok: false, reason: "invalid_code" },
          { status: 400 },
        );
      case "no_account":
        // The /citizens silent check said yes but EdgeOS authenticate
        // doesn't know about this account. Could happen if the user
        // exists in SimpleFi but never made an EdgeOS user account.
        // Surface as code_expired so the user re-tries (they'll get a
        // fresh OTP via the resend button).
        logger.warn(
          "verify-otp: EdgeOS authenticate returned no_account for /citizens-verified email",
          { route: "api/edge/verify-otp" },
        );
        return NextResponse.json<Response>(
          { ok: false, reason: "code_expired" },
          { status: 400 },
        );
      case "network":
      case "unknown":
      default:
        logger.error("verify-otp: EdgeOS authenticate unreachable", {
          route: "api/edge/verify-otp",
          status: authResult.status,
          httpStatus: authResult.httpStatus,
        });
        return NextResponse.json<Response>(
          { ok: false, reason: "api_error" },
          { status: 503 },
        );
    }
  }

  // ── 4.5. (Bonus) fetch citizen profile to persist telegram_handle ──
  //
  // SimpleFi's /citizens lookup returned the user's Telegram handle as
  // part of the silent-verify response (passed through to the frontend
  // via /api/edge/verify-ticket). We re-fetch it here at user-create
  // time so the handle lands in instaclaw_users.telegram_handle — used
  // by the matchpool identify-agent flow to attribute conversations to
  // the right user when their bot DMs them.
  //
  // Best-effort: any failure here is silently ignored. The user can still
  // sign in; we just won't have their telegram handle until they edit it
  // on /dashboard.
  let citizenTelegramHandle: string | null = null;
  try {
    const bearer = process.env.EDGEOS_BEARER_TOKEN;
    if (bearer) {
      const citizenRes = await fetch(
        `https://api-citizen-portal.simplefi.tech/citizens/email/${encodeURIComponent(email)}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${bearer}`,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (citizenRes.status === 200) {
        const citizenBody = (await citizenRes.json()) as {
          telegram?: string | null;
        };
        if (
          typeof citizenBody?.telegram === "string" &&
          citizenBody.telegram.trim().length > 0
        ) {
          citizenTelegramHandle = citizenBody.telegram.trim().replace(/^@/, "");
        }
      }
    }
  } catch (e) {
    logger.warn("verify-otp: citizen profile re-fetch failed (non-blocking)", {
      route: "api/edge/verify-otp",
      err: e instanceof Error ? e.message : String(e),
    });
  }

  // ── 5. Look up or create the instaclaw_users row ──
  //
  // Lookup strategy: by edge_verified_email column first (most precise —
  // they may have used the Email path on a prior session), then by
  // primary email (account-linking case — the user has an existing
  // InstaClaw account with the same email from a non-Edge signup).
  const supabase = getSupabase();

  let userId: string | null = null;

  // Lookup by edge_verified_email (their prior Email-path verifications).
  {
    const { data, error } = await supabase
      .from("instaclaw_users")
      .select("id")
      .eq("edge_verified_email", email)
      .maybeSingle();
    if (error) {
      logger.error("verify-otp: edge_verified_email lookup failed", {
        route: "api/edge/verify-otp",
        err: error.message,
      });
      return NextResponse.json<Response>(
        { ok: false, reason: "server_error" },
        { status: 500 },
      );
    }
    if (data?.id) userId = data.id as string;
  }

  // Account-linking: lookup by primary email. If they have an existing
  // account (e.g., signed up via Google with this same email at some
  // prior point), link Edge to it instead of creating a second row.
  if (!userId) {
    const { data, error } = await supabase
      .from("instaclaw_users")
      .select("id, edge_verified_email")
      .eq("email", email)
      .maybeSingle();
    if (error) {
      logger.error("verify-otp: email lookup failed", {
        route: "api/edge/verify-otp",
        err: error.message,
      });
      return NextResponse.json<Response>(
        { ok: false, reason: "server_error" },
        { status: 500 },
      );
    }
    if (data?.id) {
      userId = data.id as string;
      // Backfill the edge_verified_email column on the existing user. The
      // partial UNIQUE constraint on this column means another user might
      // already own this email — surface as 23505 if so.
      //
      // Also backfill telegram_handle if we have it from /citizens AND
      // the existing row doesn't have one. Don't overwrite an existing
      // telegram_handle — the user may have updated it via /dashboard.
      if (!data.edge_verified_email) {
        const updatePayload: { edge_verified_email: string; telegram_handle?: string } = {
          edge_verified_email: email,
        };
        if (citizenTelegramHandle) {
          updatePayload.telegram_handle = citizenTelegramHandle;
        }
        const { error: updErr } = await supabase
          .from("instaclaw_users")
          .update(updatePayload)
          .eq("id", userId)
          // Only fill telegram_handle if it's currently null. Defensive
          // OR-clause so we don't trip if the row's edge_verified_email
          // is already set to the same value.
          .or(`edge_verified_email.is.null,edge_verified_email.eq.${email}`);
        if (updErr && updErr.code !== "23505") {
          logger.warn(
            "verify-otp: backfill edge_verified_email failed (non-blocking)",
            {
              route: "api/edge/verify-otp",
              userId,
              err: updErr.message,
            },
          );
        }
      }
    }
  }

  // Create a fresh user if no existing row matched.
  if (!userId) {
    const { data, error } = await supabase
      .from("instaclaw_users")
      .insert({
        email,
        edge_verified_email: email,
        partner: PARTNER_VALUE,
        onboarding_complete: false,
        // Persist Telegram handle from /citizens (best-effort, may be null).
        // Used by the matchpool identify-agent flow + agent-side bot DMs
        // for first-message attribution.
        ...(citizenTelegramHandle
          ? { telegram_handle: citizenTelegramHandle }
          : {}),
      })
      .select("id")
      .single();
    if (error) {
      // 23505 on edge_verified_email = race with another insertion.
      // Re-lookup and proceed.
      if (error.code === "23505") {
        const { data: recheck } = await supabase
          .from("instaclaw_users")
          .select("id")
          .eq("edge_verified_email", email)
          .maybeSingle();
        if (recheck?.id) {
          userId = recheck.id as string;
        } else {
          logger.error("verify-otp: 23505 but recheck failed", {
            route: "api/edge/verify-otp",
            email,
          });
          return NextResponse.json<Response>(
            { ok: false, reason: "server_error" },
            { status: 500 },
          );
        }
      } else {
        logger.error("verify-otp: user insert failed", {
          route: "api/edge/verify-otp",
          email,
          err: error.message,
          code: error.code,
        });
        return NextResponse.json<Response>(
          { ok: false, reason: "server_error" },
          { status: 500 },
        );
      }
    } else {
      userId = data.id as string;
    }
  }

  if (!userId) {
    logger.error("verify-otp: userId still null after lookup + create", {
      route: "api/edge/verify-otp",
      email,
    });
    return NextResponse.json<Response>(
      { ok: false, reason: "server_error" },
      { status: 500 },
    );
  }

  // ── 6. Apply the partner tag (idempotent, defensive) ──
  // tagUserAsPartner is idempotent and never throws — safe fire-and-forget,
  // but we await it so the partner-gated downstream logic (skill install,
  // edge_city VM assignment) sees the tag before the session is minted.
  const tagResult = await tagUserAsPartner(supabase, userId, PARTNER_VALUE);
  if (!tagResult.ok) {
    logger.warn("verify-otp: partner-tag failed (non-blocking)", {
      route: "api/edge/verify-otp",
      userId,
      err: tagResult.error,
    });
  }

  // ── 7. Mint the one-shot OTP token ──
  const tokenResult = signEdgeOtpToken(userId);
  if (!tokenResult.ok || !tokenResult.token) {
    logger.error("verify-otp: HMAC token mint failed (NEXTAUTH_SECRET?)", {
      route: "api/edge/verify-otp",
      err: tokenResult.error,
    });
    return NextResponse.json<Response>(
      { ok: false, reason: "server_error" },
      { status: 500 },
    );
  }

  return NextResponse.json<Response>(
    { ok: true, otpToken: tokenResult.token },
    { status: 200 },
  );
}
