/**
 * POST /api/auth/openai/device-code/start
 *
 * Phase 1 design doc §6.1 — the entry point of the Login-with-ChatGPT
 * flow. Session-protected (the middleware lets /api/auth/* through to
 * the route handler, which MUST do its own auth check; this is the
 * NextAuth-style pattern shared with /api/auth/world-id/* siblings).
 *
 * ─── Response shape standard (P2-A) ──────────────────────────────────────
 *
 * ALL responses match `{ status: string, message?: string, ...extras }`.
 * The UI state machine is a simple `switch (response.status)`.
 *
 *   status               | http | extras       | meaning
 *   ---------------------|------|--------------|------------------------------
 *   "pending"            | 200  | flow         | flow created or reused; show code
 *   "connected"          | 200  | summary      | user already connected
 *   "feature_disabled"   | 503  | -            | kill switch on
 *   "unauthorized"       | 401  | -            | no session
 *   "codex_not_enabled"  | 400  | -            | user's OpenAI account lacks device-code
 *   "upstream_timeout"   | 502  | -            | OpenAI auth service hung past timeout
 *   "service_unavailable"| 503  | -            | other OpenAI failure / network
 *
 * ─── Decision tree (P1-B) ────────────────────────────────────────────────
 *
 * decideStartAction (in lib/openai-oauth-route-helpers.ts) checks state
 * in THIS order:
 *
 *   1. Already connected? → return { status: "connected", summary }
 *   2. Fresh pending flow exists? → return { status: "pending", flow }
 *   3. Else mint new flow → return { status: "pending", flow }
 *
 * Connected wins over pending — see decideStartAction's header for why
 * (audit finding P1-B: prior code checked pending first, shadowing
 * connected state when a previous markDeviceFlowCompleted had failed).
 *
 * ─── Timeout handling (P1-C) ─────────────────────────────────────────────
 *
 * If startDeviceFlow throws OpenAIRequestTimeoutError (OpenAI's auth
 * endpoint hung past 10s), we return HTTP 502 with status="upstream_timeout".
 * Other errors fall through to 503 "service_unavailable".
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import {
  isChatGPTOAuthEnabled,
  chatGPTOAuthDisabledPayload,
} from "@/lib/chatgpt-oauth-feature-flag";
import { startDeviceFlow, OpenAIRequestTimeoutError } from "@/lib/openai-oauth";
import {
  createOrReuseDeviceFlow,
  type DeviceFlowRow,
  type ConnectedSummary,
} from "@/lib/openai-oauth-db";
import { decideStartAction } from "@/lib/openai-oauth-route-helpers";

// Per-user state — never cache.
export const dynamic = "force-dynamic";

// External API call (OpenAI deviceauth/usercode); typically <2s but Vercel
// Pro default is 60s and we want headroom for transient slowness. 300s is
// well over what's reachable here but matches Rule 11 across the codebase.
export const maxDuration = 300;

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

interface ConnectedResponse {
  status: "connected";
  summary: ConnectedSummary;
}

interface ErrorResponse {
  status:
    | "unauthorized"
    | "feature_disabled"
    | "codex_not_enabled"
    | "upstream_timeout"
    | "service_unavailable";
  message: string;
}

type Response = PendingResponse | ConnectedResponse | ErrorResponse;

export async function POST(): Promise<NextResponse<Response>> {
  // 1. Auth (Rule 13 — middleware bypasses /api/auth/*, handler enforces)
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      {
        status: "unauthorized",
        message: "Sign in to connect your ChatGPT subscription.",
      },
      { status: 401 },
    );
  }
  const userId = session.user.id;

  // 2. Feature-flag gate
  if (!isChatGPTOAuthEnabled()) {
    return NextResponse.json(chatGPTOAuthDisabledPayload(), { status: 503 });
  }

  const supabase = getSupabase();

  try {
    // 3. Decide what to do. Single helper, single source of truth for
    //    the decision order. Connected-first per P1-B.
    const action = await decideStartAction(userId, supabase);

    if (action.kind === "already_connected") {
      return NextResponse.json({ status: "connected", summary: action.summary });
    }

    if (action.kind === "reuse_pending") {
      return NextResponse.json(toPendingResponse(action.flow));
    }

    // 4. Mint new. startDeviceFlow throws on OpenAI 404/5xx/network/timeout;
    //    createOrReuseDeviceFlow handles the rare race where two parallel
    //    requests both reach this point.
    const started = await startDeviceFlow();
    const flow = await createOrReuseDeviceFlow(userId, started, supabase);

    logger.info("openai-oauth: device flow started", {
      userId,
      flowId: flow.id,
      // Prefix only — user_code is shown to the user but logs are
      // operator-visible and we don't want full codes drifting into
      // long-term storage.
      userCodePrefix: flow.user_code.slice(0, 4),
      expiresAt: flow.expires_at,
    });

    return NextResponse.json(toPendingResponse(flow));
  } catch (err) {
    // P1-C: dedicated branch for OpenAI timeouts → 502 (Bad Gateway).
    // Distinguishes "OpenAI is slow/down" from generic "we couldn't do
    // it" so the UI can show a more accurate retry message.
    if (err instanceof OpenAIRequestTimeoutError) {
      logger.warn("openai-oauth: device-code start upstream timeout", {
        userId,
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
    logger.error("openai-oauth: device-code start failed", {
      userId,
      error: msg.slice(0, 400),
    });

    // Map a few well-known causes to dedicated user messages.
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
          "Couldn't start the ChatGPT connection. Please try again in a minute — " +
          "OpenAI's auth service may be briefly unavailable.",
      },
      { status: 503 },
    );
  }
}

function toPendingResponse(flow: DeviceFlowRow): PendingResponse {
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
