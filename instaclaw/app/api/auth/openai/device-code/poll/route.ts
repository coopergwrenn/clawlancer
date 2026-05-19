/**
 * POST /api/auth/openai/device-code/poll
 *
 * Phase 1 design doc §6.2 — the polling endpoint the dashboard modal
 * hits every `interval_seconds` (typically 5s) after the user starts a
 * connection.
 *
 * Body: { flow_id: string }
 *
 * ─── Response shape standard (P2-A) ──────────────────────────────────────
 *
 * Always `{ status: string, message?: string, ...extras }`.
 *
 *   status              | http | extras            | meaning
 *   --------------------|------|-------------------|------------------------
 *   "pending"           | 200  | -                 | keep polling
 *   "completed"         | 200  | plan_type, summary?| done; close modal
 *   "expired"           | 200  | -                 | 15-min window passed
 *   "denied"            | 200  | -                 | user denied at OpenAI
 *   "error"             | varies| -                | failure (5xx if our fault, 200 if OpenAI's)
 *   "not_found"         | 404  | -                 | flow_id doesn't exist
 *   "feature_disabled"  | 503  | -                 | kill switch on
 *   "unauthorized"      | 401  | -                 | no session
 *   "bad_request"       | 400  | -                 | body malformed
 *
 * ─── Body validation (P1-A) ──────────────────────────────────────────────
 *
 * validatePollRequestBody (in lib/openai-oauth-route-helpers.ts) handles
 * every wire-format misbehavior: null body, array, primitive, missing
 * flow_id, non-string flow_id, empty string. Each → 400 with a helpful
 * message. Audit finding P1-A: prior code's `as Record<string, unknown>`
 * cast meant `null` body → TypeError → 500.
 *
 * ─── Mark-completed retry + connected fallback (P1-D) ────────────────────
 *
 * 1. On case "completed": markDeviceFlowCompletedWithRetry (3 attempts,
 *    1s backoff). If all retries fail, tokens are still stored — we
 *    return completed and rely on fallback #2 on subsequent polls.
 *
 * 2. On case "pending" AND case "error" (the unhappy paths that USED to
 *    return pending/error without checking): re-read user.openai_oauth_
 *    access_token. If non-NULL, the user IS connected from a previous
 *    poll where mark-completed permanently failed (after retries). Return
 *    {status: "completed"} instead so the UI doesn't think they're stuck.
 *
 * Race semantics: two concurrent polls can both reach OpenAI, but only
 * one will get the authorization code (OpenAI's /deviceauth/token returns
 * 403 for the race-loser, mapped to "pending" by pollDeviceFlow). The
 * race-loser's next poll reads status=completed from our DB and returns
 * idempotently.
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
  getConnectedSummary,
  getDeviceFlow,
  markDeviceFlowCompletedWithRetry,
  markDeviceFlowFailed,
  storeOAuthTokens,
  type ConnectedSummary,
} from "@/lib/openai-oauth-db";
import { validatePollRequestBody } from "@/lib/openai-oauth-route-helpers";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface PendingResponse {
  status: "pending";
}
interface CompletedResponse {
  status: "completed";
  plan_type: string | null;
  summary?: ConnectedSummary;
}
interface TerminalResponse {
  status: "expired" | "denied" | "error" | "not_found";
  message?: string;
}
interface RejectedResponse {
  status: "feature_disabled" | "unauthorized" | "bad_request";
  message: string;
}
type Response =
  | PendingResponse
  | CompletedResponse
  | TerminalResponse
  | RejectedResponse;

export async function POST(req: NextRequest): Promise<NextResponse<Response>> {
  // 1. Auth
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { status: "unauthorized", message: "Sign in to continue." },
      { status: 401 },
    );
  }
  const userId = session.user.id;

  // 2. Feature flag
  if (!isChatGPTOAuthEnabled()) {
    return NextResponse.json(chatGPTOAuthDisabledPayload(), { status: 503 });
  }

  // 3. Body parse — wrapped because req.json() can throw on malformed bytes.
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json(
      { status: "bad_request", message: "Body must be valid JSON with a flow_id field." },
      { status: 400 },
    );
  }

  // 4. Body validate (P1-A) — guards null, array, non-object, missing/bad flow_id.
  const validation = validatePollRequestBody(rawBody);
  if (!validation.ok) {
    return NextResponse.json(
      { status: "bad_request", message: validation.message },
      { status: 400 },
    );
  }
  const flowId = validation.flowId;

  const supabase = getSupabase();

  // 5. Fetch + ownership check
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
      { status: "error", message: "Couldn't read connection state. Please try again." },
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

  // 6. Idempotent return for already-terminal rows
  if (flow.status === "completed") {
    return await respondCompleted(userId, supabase);
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

  // 7. Clock-side expiry check — even if OpenAI says pending, if our recorded
  //    deadline has passed, we treat it as expired and stop polling.
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

  // 8. Poll OpenAI
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
      { status: "error", message: "Couldn't reach OpenAI to check connection status. Please try again." },
      { status: 503 },
    );
  }

  // 9. Map OpenAI result → DB write + response.
  switch (pollResult.status) {
    case "pending":
      // P1-D fallback: maybe tokens were stored by a prior poll whose
      // mark-completed permanently failed. Check before returning pending.
      return await pendingOrCompletedFallback(userId, supabase);

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
      // P1-D fallback: before reporting error, check if user is actually
      // connected from a prior poll. If so, the "error" is a downstream
      // consequence of orphan flow state, not a real failure.
      {
        const fallback = await tryConnectedFallback(userId, supabase);
        if (fallback) return fallback;
      }
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
      // P1-D: store tokens FIRST. If this throws, the flow stays pending
      // and the browser's next poll will retry the whole sequence (idempotent
      // on the OpenAI side too — re-exchanging the same auth code returns
      // the same tokens... or 403 → pending, which the pending-fallback
      // catches via the connected-state check).
      try {
        const result = await storeOAuthTokens(userId, pollResult, supabase);
        logger.info("openai-oauth: tokens stored", {
          userId,
          flowId,
          tokenVersion: result.tokenVersion,
          planType: result.planType,
          // Prefix-only — bearer JWTs are SENSITIVE per Rule 53. 12 chars
          // of an RS256 JWT is the header (identical across all JWTs) so
          // there's no fingerprint leak; this is just for log-correlation.
          accessTokenPrefix: pollResult.tokens.accessToken.slice(0, 12),
          expiresAt: new Date(pollResult.tokens.expiresAtMs).toISOString(),
        });
        // P1-D fix 1: retry markDeviceFlowCompleted with backoff.
        const markResult = await markDeviceFlowCompletedWithRetry(flowId, supabase);
        if (!markResult.success) {
          logger.warn("openai-oauth: tokens stored but flow mark-completed failed after retries", {
            userId,
            flowId,
            attempts: markResult.attempts,
            lastError: markResult.lastError?.slice(0, 200),
          });
          // Tokens are stored — return completed anyway. The pending-fallback
          // on subsequent polls (P1-D fix 2) will catch any browser that
          // misses this response.
        }
        return NextResponse.json({
          status: "completed",
          plan_type: result.planType,
        });
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
          await markDeviceFlowFailed(
            flowId,
            "error",
            `store_failed: ${msg.slice(0, 200)}`,
            supabase,
          );
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
 * P1-D fallback shared between `case "pending"` and `case "error"`:
 * before returning the unhappy response, check if the user actually
 * has tokens stored. If yes, an earlier poll succeeded at storeOAuthTokens
 * but failed at markDeviceFlowCompleted (after retries) — the user IS
 * connected. Return completed instead.
 *
 * Returns the completed-response NextResponse if user is connected;
 * returns null if the caller should proceed with the unhappy response.
 */
async function tryConnectedFallback(
  userId: string,
  supabase: ReturnType<typeof getSupabase>,
): Promise<NextResponse<CompletedResponse> | null> {
  try {
    const summary = await getConnectedSummary(userId, supabase);
    if (summary.connected) {
      return NextResponse.json({
        status: "completed",
        plan_type: summary.planType ?? null,
        summary,
      });
    }
  } catch (err) {
    // Connected-check failure is non-fatal — let the caller fall back to
    // its original response. Just log so we know the safety net is itself
    // having issues.
    logger.warn("openai-oauth: connected-state fallback check failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return null;
}

/**
 * P1-D fallback at the pending branch: same logic as tryConnectedFallback
 * but the caller returns NextResponse{status:"pending"} if no fallback.
 */
async function pendingOrCompletedFallback(
  userId: string,
  supabase: ReturnType<typeof getSupabase>,
): Promise<NextResponse<PendingResponse | CompletedResponse>> {
  const completed = await tryConnectedFallback(userId, supabase);
  if (completed) return completed;
  return NextResponse.json({ status: "pending" });
}

/**
 * Idempotent completed-response for the flow.status='completed' branch.
 * Reads cached plan_type from the user record. Returns null in plan_type
 * (rather than failing) on any read error — plan type is cosmetic.
 */
async function respondCompleted(
  userId: string,
  supabase: ReturnType<typeof getSupabase>,
): Promise<NextResponse<CompletedResponse>> {
  let summary: ConnectedSummary | undefined;
  let planType: string | null = null;
  try {
    summary = await getConnectedSummary(userId, supabase);
    planType = summary.planType ?? null;
  } catch (err) {
    logger.warn("openai-oauth: respondCompleted summary read failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return NextResponse.json({ status: "completed", plan_type: planType, summary });
}
