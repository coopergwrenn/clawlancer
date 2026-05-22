/**
 * POST /api/edge/start-email-login
 *
 * Part of the 2026-05-22 three-auth-paths refactor for /edge/claim.
 *
 * Called ONLY when the user picks the "Email code" auth path on the
 * verified-state screen. Fires the EdgeOS OTP email via
 * `requestEmailLoginOtp` (which wraps the third-party-login endpoint).
 *
 * Pre-conditions enforced server-side:
 *   1. Request body has a valid email shape.
 *   2. Signed `edge_verified_email` cookie is present + valid + matches the
 *      submitted email. This proves the user passed silent /citizens
 *      verification first. We refuse to fire OTPs for emails that haven't
 *      passed silent verify — prevents an attacker from using us as a free
 *      EdgeOS-OTP-spam relay (the 2026-05-22 EdgeOS rate-limit incident
 *      pre-shipping this rate-limit-protection design).
 *
 * Per-IP rate limit: 5 starts per 15 min (basic abuse guard against
 * scripted OTP-spam attempts even WITH a valid cookie). Implemented via
 * a simple in-memory Map keyed on the request's first x-forwarded-for IP
 * — best-effort across Vercel function instances (each cold-start has
 * its own Map) but adequate for the 1000-attendee scale.
 *
 * Returns:
 *   200 { ok: true, expiresInMinutes }  — OTP queued, user should check inbox
 *   400 { ok: false, reason: "no_cookie" }      — silent verify not done yet
 *   400 { ok: false, reason: "email_mismatch" } — cookie email != body email
 *   400 { ok: false, reason: "invalid_email" }  — body email shape invalid
 *   429 { ok: false, reason: "rate_limited" }   — too many starts (per-IP OR per-EdgeOS)
 *   503 { ok: false, reason: "api_error" }      — EdgeOS unreachable
 */
import { NextRequest, NextResponse } from "next/server";
import { requestEmailLoginOtp } from "@/lib/edgeos";
import {
  verifyEdgeVerifiedCookie,
  EDGE_VERIFIED_COOKIE_NAME,
} from "@/lib/edge-verified-cookie";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Per-IP rate limit. In-memory; survives across requests within a single
// warm function instance. Vercel cold-start = fresh Map; that's fine for
// our scale (rate limit "leaks" a few extra requests on cold-start, which
// is well within EdgeOS's own per-email rate limit).
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 min
const RATE_LIMIT_MAX = 5;
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
  expiresInMinutes: number | null;
}

interface FailureResponse {
  ok: false;
  reason:
    | "no_cookie"
    | "email_mismatch"
    | "invalid_email"
    | "rate_limited"
    | "api_error";
}

type Response = SuccessResponse | FailureResponse;

export async function POST(req: NextRequest) {
  // ── 1. Parse body ──
  let email: string;
  try {
    const body = (await req.json()) as { email?: unknown };
    if (typeof body?.email !== "string") {
      return NextResponse.json<Response>(
        { ok: false, reason: "invalid_email" },
        { status: 400 },
      );
    }
    email = body.email.trim().toLowerCase();
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

  // ── 2. Verify the silent-check cookie (chain-of-custody) ──
  // This is the load-bearing gate — we don't want to be a free EdgeOS-
  // OTP relay. If the user hasn't passed /api/edge/verify-ticket first
  // (which sets the signed cookie), refuse to fire the OTP.
  const cookieRaw = req.cookies.get(EDGE_VERIFIED_COOKIE_NAME)?.value ?? null;
  const cookieVerify = verifyEdgeVerifiedCookie(cookieRaw);
  if (!cookieVerify.ok || !cookieVerify.email) {
    logger.warn("start-email-login: no/invalid edge_verified cookie", {
      route: "api/edge/start-email-login",
      reason: cookieVerify.reason,
    });
    return NextResponse.json<Response>(
      { ok: false, reason: "no_cookie" },
      { status: 400 },
    );
  }
  if (cookieVerify.email !== email) {
    // Mismatch: the user's silent-verified email isn't the one they're
    // now asking to OTP. Refuse — could be a session-switch attack OR a
    // benign UI bug. Loud-log either way.
    logger.warn("start-email-login: cookie email != body email", {
      route: "api/edge/start-email-login",
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
    logger.warn("start-email-login: per-IP rate limit hit", {
      route: "api/edge/start-email-login",
      ip,
    });
    return NextResponse.json<Response>(
      { ok: false, reason: "rate_limited" },
      { status: 429 },
    );
  }

  // ── 4. Fire the OTP via EdgeOS third-party-login ──
  const otpResult = await requestEmailLoginOtp(email);

  if (otpResult.ok) {
    return NextResponse.json<Response>(
      { ok: true, expiresInMinutes: otpResult.expiresInMinutes },
      { status: 200 },
    );
  }

  // Map the failure reasons. The cookie chain proves they're a verified
  // attendee, so `not_attendee` here is a real divergence between
  // SimpleFi /citizens (passed) and EdgeOS third-party-login (rejected).
  // Surface as api_error rather than not_attendee — the gate already
  // approved them; this is an EdgeOS-side data drift.
  switch (otpResult.reason) {
    case "rate_limited":
      return NextResponse.json<Response>(
        { ok: false, reason: "rate_limited" },
        { status: 429 },
      );
    case "validation_error":
      return NextResponse.json<Response>(
        { ok: false, reason: "invalid_email" },
        { status: 400 },
      );
    case "not_attendee":
      logger.warn(
        "start-email-login: SimpleFi /citizens vs EdgeOS third-party-login divergence",
        {
          route: "api/edge/start-email-login",
          email,
        },
      );
      return NextResponse.json<Response>(
        { ok: false, reason: "api_error" },
        { status: 503 },
      );
    case "api_error":
    default:
      return NextResponse.json<Response>(
        { ok: false, reason: "api_error" },
        { status: 503 },
      );
  }
}
