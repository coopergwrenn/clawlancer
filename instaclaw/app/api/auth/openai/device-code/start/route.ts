/**
 * POST /api/auth/openai/device-code/start
 *
 * Phase 1 design doc §6.1 — the entry point of the Login-with-ChatGPT
 * flow. Session-protected (the middleware lets /api/auth/* through to
 * the route handler, which MUST do its own auth check; this is the
 * NextAuth-style pattern shared with /api/auth/world-id/* siblings).
 *
 * Decision tree:
 *
 *   1. Feature flag off → 503 with structured "feature_disabled" body.
 *      The graceful-downgrade cron is concurrently cleaning up any
 *      existing connected users; we shouldn't start new flows.
 *
 *   2. User already has a fresh pending flow (status=pending AND
 *      expires_at > NOW)  → return THAT flow. Avoids minting a new
 *      OpenAI device code on every "I clicked Connect again" click,
 *      saves an OpenAI API call, and means the user sees the same
 *      code they were already looking at.
 *
 *   3. User is already connected (has un-expired access token) →
 *      return { status: "already_connected", summary } so the modal
 *      can show "Connected as <email>" + a Disconnect button. The
 *      "reconnect to a different OpenAI account" workflow goes via
 *      /disconnect → /start (deliberate two-step so we never leak a
 *      live token to a new account).
 *
 *   4. Otherwise: startDeviceFlow() against OpenAI, persist the row
 *      via createOrReuseDeviceFlow, return { status: "started", flow }.
 *
 * The "started" response is the minimum the UI needs to display the
 * code + verification URL + polling deadline + per-request interval.
 *
 * Errors are mapped to user-facing strings — every error message should
 * be helpful per Cooper's Day 1 instruction ("every error message should
 * be helpful"). We never surface raw Supabase or fetch error bodies.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import {
  isChatGPTOAuthEnabled,
  chatGPTOAuthDisabledPayload,
} from "@/lib/chatgpt-oauth-feature-flag";
import { startDeviceFlow } from "@/lib/openai-oauth";
import {
  createOrReuseDeviceFlow,
  getFreshPendingFlow,
  getConnectedSummary,
  type DeviceFlowRow,
  type ConnectedSummary,
} from "@/lib/openai-oauth-db";

// Per-user state — never cache.
export const dynamic = "force-dynamic";

// External API call (OpenAI deviceauth/usercode); typically <2s but Vercel
// Pro default is 60s and we want headroom for transient slowness. 300s is
// well over what's reachable here but matches Rule 11 across the codebase.
export const maxDuration = 300;

interface StartedResponse {
  status: "started";
  flow: {
    id: string;
    user_code: string;
    verification_uri: string;
    interval_seconds: number;
    expires_at: string;
  };
}

interface AlreadyConnectedResponse {
  status: "already_connected";
  summary: ConnectedSummary;
}

interface ErrorResponse {
  status: "error";
  error: {
    type: string;
    message: string;
  };
}

type Response = StartedResponse | AlreadyConnectedResponse | ErrorResponse;

export async function POST(): Promise<NextResponse<Response>> {
  // 1. Auth (Rule 13 — middleware bypasses /api/auth/*, handler enforces)
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      {
        status: "error",
        error: {
          type: "unauthorized",
          message: "Sign in to connect your ChatGPT subscription.",
        },
      },
      { status: 401 },
    );
  }
  const userId = session.user.id;

  // 2. Feature-flag gate
  if (!isChatGPTOAuthEnabled()) {
    return NextResponse.json(
      {
        status: "error",
        error: {
          type: "feature_disabled",
          message: chatGPTOAuthDisabledPayload().error.message,
        },
      },
      { status: 503 },
    );
  }

  const supabase = getSupabase();

  try {
    // 3. Pending-flow short circuit. Returns the live flow without an
    //    OpenAI API call so re-opens of the modal show the same code.
    const pending = await getFreshPendingFlow(userId, supabase);
    if (pending) {
      return NextResponse.json(toStartedResponse(pending));
    }

    // 4. Already-connected short circuit. UI shows the "connected" state
    //    and offers a Disconnect button.
    const summary = await getConnectedSummary(userId, supabase);
    if (summary.connected) {
      return NextResponse.json({
        status: "already_connected",
        summary,
      });
    }

    // 5. New flow. startDeviceFlow throws on OpenAI 404/5xx/network;
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

    return NextResponse.json(toStartedResponse(flow));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("openai-oauth: device-code start failed", {
      userId,
      error: msg.slice(0, 400),
    });

    // Map a few well-known causes to dedicated user messages. Everything
    // else falls through to "service_unavailable" so the user retries.
    if (/Codex access enabled/i.test(msg)) {
      return NextResponse.json(
        {
          status: "error",
          error: {
            type: "codex_not_enabled",
            message:
              "Your ChatGPT account doesn't have device-code login enabled. " +
              "In ChatGPT → Settings → Security, enable 'Device code authorization for Codex', then try again.",
          },
        },
        { status: 400 },
      );
    }

    return NextResponse.json(
      {
        status: "error",
        error: {
          type: "service_unavailable",
          message:
            "Couldn't start the ChatGPT connection. Please try again in a minute — " +
            "OpenAI's auth service may be briefly unavailable.",
        },
      },
      { status: 503 },
    );
  }
}

function toStartedResponse(flow: DeviceFlowRow): StartedResponse {
  return {
    status: "started",
    flow: {
      id: flow.id,
      user_code: flow.user_code,
      verification_uri: flow.verification_uri,
      interval_seconds: flow.interval_seconds,
      expires_at: flow.expires_at,
    },
  };
}
