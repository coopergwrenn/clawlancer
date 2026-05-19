/**
 * POST /api/auth/openai/device-code/poll
 *
 * Phase 1 design doc §6.2 — the polling endpoint the dashboard modal
 * hits every `interval_seconds` (typically 5s) after the user starts a
 * connection. Returns a uniform `{ status, ... }` shape so the UI's
 * state machine can be a simple `switch (response.status)`.
 *
 * Body: { flow_id: string }
 *
 * Response shapes (status discriminator):
 *   - pending:    user hasn't authorized yet; keep polling
 *   - completed:  tokens stored; UI should close modal, show success
 *   - expired:    15-min window passed; UI should offer "Start over"
 *   - denied:     user clicked Deny in OpenAI's browser; UI should
 *                 explain and offer "Try again"
 *   - error:      something else failed; show the message
 *   - not_found:  flow_id doesn't exist or belongs to another user
 *   - feature_disabled: kill switch on (matches /start)
 *   - unauthorized: no session
 *
 * Race semantics: two concurrent polls can both reach OpenAI, but only
 * one will get the authorization code (OpenAI's /deviceauth/token returns
 * 403 for the race-loser, mapped to "pending" by pollDeviceFlow). The
 * race-loser's next poll reads status=completed from our DB and returns
 * idempotently. The race-WINNER might double-store tokens (if both polls
 * pass the row.status=pending check before either writes); this is
 * harmless — same tokens, an extra version bump. Documented in
 * lib/openai-oauth-db.ts.
 *
 * Order of writes on completion: storeOAuthTokens first, then
 * markDeviceFlowCompleted. If storeOAuthTokens throws, we mark the flow
 * as 'error' and the user can retry — better than the inverse, which
 * would leave a completed flow with no tokens.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import {
  isChatGPTOAuthEnabled,
  chatGPTOAuthDisabledPayload,
} from "@/lib/chatgpt-oauth-feature-flag";
import { pollDeviceFlow } from "@/lib/openai-oauth";
import {
  getDeviceFlow,
  markDeviceFlowCompleted,
  markDeviceFlowFailed,
  storeOAuthTokens,
} from "@/lib/openai-oauth-db";

export const dynamic = "force-dynamic";
// External API call (OpenAI deviceauth/token + exchange) — same 300s
// budget as the start route.
export const maxDuration = 300;

interface PendingResponse {
  status: "pending";
}
interface CompletedResponse {
  status: "completed";
  plan_type: string | null;
}
interface FailedResponse {
  status: "expired" | "denied" | "error" | "not_found";
  message?: string;
}
interface ErrorResponse {
  status: "feature_disabled" | "unauthorized" | "bad_request";
  message: string;
}
type Response = PendingResponse | CompletedResponse | FailedResponse | ErrorResponse;

export async function POST(req: NextRequest): Promise<NextResponse<Response>> {
  // Auth
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { status: "unauthorized", message: "Sign in to continue." },
      { status: 401 },
    );
  }
  const userId = session.user.id;

  // Feature flag
  if (!isChatGPTOAuthEnabled()) {
    return NextResponse.json(
      {
        status: "feature_disabled",
        message: chatGPTOAuthDisabledPayload().error.message,
      },
      { status: 503 },
    );
  }

  // Parse body
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { status: "bad_request", message: "Body must be JSON with a flow_id field." },
      { status: 400 },
    );
  }
  const flowId = typeof body.flow_id === "string" ? body.flow_id : null;
  if (!flowId) {
    return NextResponse.json(
      { status: "bad_request", message: "flow_id is required." },
      { status: 400 },
    );
  }

  const supabase = getSupabase();

  // Fetch + ownership check
  let flow;
  try {
    flow = await getDeviceFlow(flowId, userId, supabase);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("openai-oauth: device-code poll getDeviceFlow failed", {
      userId,
      flowId,
      error: msg.slice(0, 400),
    });
    return NextResponse.json(
      {
        status: "error",
        message: "Couldn't read connection state. Please try again.",
      },
      { status: 500 },
    );
  }
  if (!flow) {
    return NextResponse.json(
      {
        status: "not_found",
        message:
          "This connection flow doesn't exist or has expired. Click Connect to start a new one.",
      },
      { status: 404 },
    );
  }

  // Idempotent return for already-terminal rows
  if (flow.status === "completed") {
    // Pull cached plan_type back from the user row for the UI.
    const planType = await readUserPlanType(userId, supabase);
    return NextResponse.json({ status: "completed", plan_type: planType });
  }
  if (flow.status === "expired" || flow.status === "denied") {
    return NextResponse.json({
      status: flow.status,
      message: flow.status_message ?? undefined,
    });
  }
  if (flow.status === "error") {
    return NextResponse.json({
      status: "error",
      message: flow.status_message ?? undefined,
    });
  }

  // Clock-side expiry check — even if OpenAI says pending, if our recorded
  // deadline has passed, we treat it as expired and stop polling.
  if (new Date(flow.expires_at).getTime() <= Date.now()) {
    try {
      await markDeviceFlowFailed(flowId, "expired", null, supabase);
    } catch (err) {
      logger.warn("openai-oauth: failed to mark flow expired", {
        userId,
        flowId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return NextResponse.json({ status: "expired" });
  }

  // Poll OpenAI
  let pollResult;
  try {
    pollResult = await pollDeviceFlow(flow.device_auth_id, flow.user_code);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("openai-oauth: pollDeviceFlow threw", {
      userId,
      flowId,
      error: msg.slice(0, 400),
    });
    return NextResponse.json(
      {
        status: "error",
        message: "Couldn't reach OpenAI to check connection status. Please try again.",
      },
      { status: 503 },
    );
  }

  // Map OpenAI result → DB write + response. See openai-oauth.ts:DeviceCodePoll
  // for the discriminator.
  switch (pollResult.status) {
    case "pending":
      return NextResponse.json({ status: "pending" });

    case "expired":
      try {
        await markDeviceFlowFailed(flowId, "expired", null, supabase);
      } catch (err) {
        logger.warn("openai-oauth: failed to mark flow expired (post-poll)", {
          userId,
          flowId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return NextResponse.json({ status: "expired" });

    case "denied":
      try {
        await markDeviceFlowFailed(flowId, "denied", null, supabase);
      } catch (err) {
        logger.warn("openai-oauth: failed to mark flow denied", {
          userId,
          flowId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return NextResponse.json({
        status: "denied",
        message:
          "You clicked Deny on OpenAI's authorization screen. Click Connect to try again.",
      });

    case "error":
      try {
        await markDeviceFlowFailed(flowId, "error", pollResult.message.slice(0, 500), supabase);
      } catch (err) {
        logger.warn("openai-oauth: failed to mark flow error", {
          userId,
          flowId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      logger.warn("openai-oauth: pollDeviceFlow returned error status", {
        userId,
        flowId,
        message: pollResult.message.slice(0, 200),
      });
      return NextResponse.json({
        status: "error",
        message:
          "OpenAI couldn't complete the connection. Try again — if this keeps happening, " +
          "check that your ChatGPT account has Codex device-code login enabled.",
      });

    case "completed": {
      // Store tokens FIRST. If this throws, the flow stays pending and the
      // browser's next poll will retry the whole sequence (idempotent on
      // the OpenAI side too — re-exchanging the same auth code returns
      // the same tokens).
      try {
        const result = await storeOAuthTokens(userId, pollResult, supabase);
        logger.info("openai-oauth: tokens stored", {
          userId,
          flowId,
          tokenVersion: result.tokenVersion,
          planType: result.planType,
          // Prefix-only — bearer JWTs are SENSITIVE per Rule 53.
          accessTokenPrefix: pollResult.tokens.accessToken.slice(0, 12),
          // Same: expiration is informational (NOT sensitive) but we log
          // it in human-readable ISO format.
          expiresAt: new Date(pollResult.tokens.expiresAtMs).toISOString(),
        });
        try {
          await markDeviceFlowCompleted(flowId, supabase);
        } catch (err) {
          // Tokens are stored — mark-completed is just bookkeeping. Don't
          // fail the response over it; the row will be left as pending and
          // a future poll will read status=pending, hit OpenAI, get 403,
          // return pending, and the user's next-next poll will read the
          // user record and see they're connected (start route's
          // already_connected branch). Belt-and-suspenders.
          logger.warn("openai-oauth: tokens stored but flow mark-completed failed", {
            userId,
            flowId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return NextResponse.json({ status: "completed", plan_type: result.planType });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("openai-oauth: storeOAuthTokens failed", {
          userId,
          flowId,
          error: msg.slice(0, 400),
        });
        // Mark the flow as error so the UI can show a recoverable message
        // and stop the polling loop. The user re-clicks Connect to retry.
        try {
          await markDeviceFlowFailed(flowId, "error", `store_failed: ${msg.slice(0, 200)}`, supabase);
        } catch (markErr) {
          logger.warn("openai-oauth: also failed to mark flow error after store_failed", {
            userId,
            flowId,
            error: markErr instanceof Error ? markErr.message : String(markErr),
          });
        }
        return NextResponse.json(
          {
            status: "error",
            message:
              "We got your ChatGPT authorization but couldn't save it. Please try again — " +
              "if this keeps happening, contact support.",
          },
          { status: 500 },
        );
      }
    }
  }
}

/**
 * Read the cached chatgpt_plan_type for a user. Used by the already-completed
 * branch so the UI can display "Connected — ChatGPT Pro" without an extra
 * round-trip. Returns null on any error rather than failing the response
 * (the plan type is cosmetic, not load-bearing).
 */
async function readUserPlanType(
  userId: string,
  supabase: ReturnType<typeof getSupabase>,
): Promise<string | null> {
  try {
    const { data } = await supabase
      .from("instaclaw_users")
      .select("chatgpt_plan_type")
      .eq("id", userId)
      .single();
    const v = (data?.chatgpt_plan_type as string | null | undefined) ?? null;
    return v;
  } catch {
    return null;
  }
}
