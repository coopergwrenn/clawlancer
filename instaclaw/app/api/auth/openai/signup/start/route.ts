/**
 * POST /api/auth/openai/signup/start
 *
 * Session-less entry point for ChatGPT-as-signin. Parallels the existing
 * /api/auth/openai/device-code/start (post-signup connect from /settings)
 * but does NOT require a NextAuth session — the whole point is that the
 * user doesn't have one yet.
 *
 * RESPONSE SHAPE
 * ──────────────
 * Same as device-code/start so the modal (chatgpt-connect-modal.tsx) can
 * branch on mode without diverging its state machine:
 *
 *   status              | http | extras       | meaning
 *   --------------------|------|--------------|----------------------
 *   "pending"           | 200  | flow         | flow created; show code
 *   "feature_disabled"  | 503  | -            | kill switch on
 *   "codex_not_enabled" | 400  | -            | user's OpenAI account lacks device-code
 *   "upstream_timeout"  | 502  | -            | OpenAI auth service hung
 *   "service_unavailable"| 503 | -            | other OpenAI failure / network
 *
 * No "connected" state — that's a connect-mode-only concept (the modal
 * checks "is the user already linked to OpenAI", which requires a known
 * user; signup mode has no known user yet).
 *
 * COOKIE LIFECYCLE
 * ────────────────
 * Sets `openai_signup_session` as HTTPOnly + Secure + SameSite=Lax. Lifetime
 * is 15 minutes (matches OpenAI's device-code window). Path-scoped to
 * /api/auth/openai/signup so it's only sent to the start/poll routes.
 *
 * If the user closes the modal and re-clicks "Sign in with ChatGPT" later,
 * /signup/start mints a FRESH anonymous_session_id and overwrites the
 * cookie. The old signup_flows row stays in the DB until the cleanup cron
 * (15-min window) sweeps it. No reuse semantics — every click is fresh.
 *
 * FEATURE FLAG
 * ────────────
 * Gated on OPENAI_OAUTH_ENABLED (same flag as the connect path). Cooper
 * has confirmed it's live in production. If anyone flips it off, the route
 * returns 503 and the /signin UI's ChatGPT button can degrade gracefully.
 *
 * Rule 11: maxDuration = 300. The external call to OpenAI (startDeviceFlow)
 * has its own 10s timeout but we want Vercel headroom.
 */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import {
  isChatGPTOAuthEnabled,
  chatGPTOAuthDisabledPayload,
} from "@/lib/chatgpt-oauth-feature-flag";
import { startDeviceFlow, OpenAIRequestTimeoutError } from "@/lib/openai-oauth";
import {
  createSignupFlow,
  generateAnonymousSessionId,
  type SignupFlowRow,
} from "@/lib/openai-signup-db";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const SIGNUP_COOKIE_NAME = "openai_signup_session";
const SIGNUP_COOKIE_MAX_AGE_S = 60 * 15;

interface PendingResponse {
  status: "pending";
  flow: {
    id: string;
    user_code: string;
    verification_uri: string;
    interval_seconds: number;
    expires_at: string;
  };
}

interface ErrorResponse {
  status:
    | "feature_disabled"
    | "codex_not_enabled"
    | "upstream_timeout"
    | "service_unavailable";
  message: string;
}

type Response = PendingResponse | ErrorResponse;

export async function POST(): Promise<NextResponse<Response>> {
  // 1. Feature-flag gate. Same shape as device-code/start.
  if (!isChatGPTOAuthEnabled()) {
    return NextResponse.json(chatGPTOAuthDisabledPayload(), { status: 503 });
  }

  const supabase = getSupabase();

  // 2. Mint a fresh anonymous_session_id and the corresponding flow row.
  //    The cookie is set BEFORE we return so the client's next request
  //    (the first poll) has it. Order matters: insert first, then cookie
  //    — if the insert fails we don't want to leave the client with a
  //    cookie pointing at a row that doesn't exist.
  const anonymousSessionId = generateAnonymousSessionId();

  try {
    // 3. Talk to OpenAI to obtain the device-code start data.
    const started = await startDeviceFlow();

    // 4. Persist the flow.
    const flow = await createSignupFlow(anonymousSessionId, started, supabase);

    // 5. Set the HTTPOnly cookie. Path-scoped so it's only ever sent to
    //    /api/auth/openai/signup/*. Lifetime matches the device-code window.
    const cookieJar = await cookies();
    cookieJar.set(SIGNUP_COOKIE_NAME, anonymousSessionId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/api/auth/openai/signup",
      maxAge: SIGNUP_COOKIE_MAX_AGE_S,
    });

    logger.info("openai-signup: device flow started", {
      flowId: flow.id,
      // Prefix-only — Rule 53 + match openai-oauth/device-code/start logging
      anonymousSessionIdPrefix: anonymousSessionId.slice(0, 8),
      userCodePrefix: flow.user_code.slice(0, 4),
      expiresAt: flow.expires_at,
    });

    return NextResponse.json(toPendingResponse(flow));
  } catch (err) {
    // 6. Error mapping — mirrors device-code/start's handler for shape
    //    consistency with the modal state machine.
    if (err instanceof OpenAIRequestTimeoutError) {
      logger.warn("openai-signup: device-code start upstream timeout", {
        anonymousSessionIdPrefix: anonymousSessionId.slice(0, 8),
        message: err.message,
      });
      return NextResponse.json(
        {
          status: "upstream_timeout",
          message:
            "OpenAI's auth service is taking too long to respond. Please try again in a moment.",
        },
        { status: 502 },
      );
    }

    const msg = err instanceof Error ? err.message : String(err);
    logger.error("openai-signup: device-code start failed", {
      anonymousSessionIdPrefix: anonymousSessionId.slice(0, 8),
      error: msg.slice(0, 400),
    });

    if (/Codex access enabled/i.test(msg)) {
      return NextResponse.json(
        {
          status: "codex_not_enabled",
          message:
            "Your ChatGPT account doesn't have device-code login enabled. " +
            "In ChatGPT → Settings → Security, enable 'Device code authorization for Codex', then try again.",
        },
        { status: 400 },
      );
    }

    return NextResponse.json(
      {
        status: "service_unavailable",
        message:
          "Couldn't start the ChatGPT sign-in. Please try again in a minute — " +
          "OpenAI's auth service may be briefly unavailable.",
      },
      { status: 503 },
    );
  }
}

function toPendingResponse(flow: SignupFlowRow): PendingResponse {
  return {
    status: "pending",
    flow: {
      id: flow.id,
      user_code: flow.user_code,
      verification_uri: flow.verification_uri,
      interval_seconds: flow.interval_seconds,
      expires_at: flow.expires_at,
    },
  };
}
