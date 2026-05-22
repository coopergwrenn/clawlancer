/**
 * POST /api/auth/openai/signup/poll
 *
 * The hot path of ChatGPT-as-signin. Session-less. Reads
 * anonymous_session_id from cookie, polls OpenAI, on completion does:
 *
 *   1. Identity resolution (find-or-create instaclaw_users row from
 *      claims.email + cookie context — see lib/openai-signup-db.ts:resolveSignupUser)
 *   2. Token storage via existing storeOAuthTokens helper
 *   3. Flow row update: status='completed' + resolved_user_id
 *   4. Mint one-shot signupToken (60s exp) — client uses this to invoke
 *      signIn("openai-device-code", {signupToken}) on the next step,
 *      which establishes a real NextAuth session via the Credentials
 *      provider registered in lib/auth.ts.
 *
 * RESPONSE SHAPE
 * ──────────────
 * Largely mirrors device-code/poll, but the "completed" case carries an
 * extra `signupToken` field that the connect path doesn't need (the
 * connect path already has a session).
 *
 *   status              | http | extras                       | meaning
 *   --------------------|------|------------------------------|----------------------
 *   "pending"           | 200  | -                            | keep polling
 *   "completed"         | 200  | plan_type, signupToken       | done; call signIn()
 *   "expired"           | 200  | -                            | 15-min window passed
 *   "denied"            | 200  | -                            | user denied at OpenAI
 *   "error"             | varies| message                     | failure
 *   "not_found"         | 404  | -                            | flow_id / cookie absent
 *   "feature_disabled"  | 503  | -                            | kill switch on
 *   "bad_request"       | 400  | -                            | body malformed
 *
 * SECURITY NOTES
 * ──────────────
 * - The `signupToken` field on the completed response is SENSITIVE per
 *   Rule 53. Never log the full value. Prefix only (12 chars) for forensic
 *   correlation.
 * - The 60s exp on the signupToken bounds replay risk. If the client
 *   delays calling signIn() past 60s (unlikely; the modal triggers it
 *   immediately on receiving the response), the signin will fail with
 *   the Credentials provider returning null → user back at /signin.
 * - The HTTPOnly anonymous_session_id cookie is the authorization gate
 *   for this route. Without it, we return not_found and refuse to mint
 *   a token. An attacker would need to steal the cookie to bypass —
 *   same risk surface as session-cookie theft.
 *
 * IDEMPOTENCY
 * ───────────
 * If the route is hit twice for the same anonymous_session_id (e.g., a
 * network retry mid-poll), the second call:
 *   - reads flow.status — if already 'completed', returns a FRESH
 *     signupToken (60s exp from now) without re-polling OpenAI. The
 *     client can call signIn() again. Token is short-lived so no
 *     long-tail replay risk.
 *   - if still pending (rare race), polls OpenAI again. The OpenAI side
 *     returns the SAME tokens for the SAME auth code, or 403 (race-loser)
 *     which we map to pending. Eventually one poll completes.
 */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import {
  isChatGPTOAuthEnabled,
  chatGPTOAuthDisabledPayload,
} from "@/lib/chatgpt-oauth-feature-flag";
import { pollDeviceFlow } from "@/lib/openai-oauth";
import { storeOAuthTokens } from "@/lib/openai-oauth-db";
import {
  getSignupFlow,
  markSignupFlowCompleted,
  markSignupFlowFailed,
  resolveSignupUser,
} from "@/lib/openai-signup-db";
import { signSignupToken } from "@/lib/openai-signup-token";
import { EDGE_VERIFIED_COOKIE_NAME } from "@/lib/edge-verified-cookie";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const SIGNUP_COOKIE_NAME = "openai_signup_session";

interface PendingResponse {
  status: "pending";
}
interface CompletedResponse {
  status: "completed";
  plan_type: string | null;
  signupToken: string;
}
interface TerminalResponse {
  status: "expired" | "denied" | "error" | "not_found";
  message?: string;
}
interface RejectedResponse {
  status: "feature_disabled" | "bad_request";
  message: string;
}
type Response =
  | PendingResponse
  | CompletedResponse
  | TerminalResponse
  | RejectedResponse;

export async function POST(): Promise<NextResponse<Response>> {
  // 1. Feature flag gate
  if (!isChatGPTOAuthEnabled()) {
    return NextResponse.json(chatGPTOAuthDisabledPayload(), { status: 503 });
  }

  // 2. Read anonymous_session_id from cookie
  const cookieJar = await cookies();
  const anonymousSessionId = cookieJar.get(SIGNUP_COOKIE_NAME)?.value ?? null;
  if (!anonymousSessionId) {
    return NextResponse.json(
      {
        status: "not_found",
        message:
          "No signup session in progress. Click 'Sign in with ChatGPT' to start.",
      },
      { status: 404 },
    );
  }

  const supabase = getSupabase();

  // 3. Look up the flow row
  let flow;
  try {
    flow = await getSignupFlow(anonymousSessionId, supabase);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("openai-signup: getSignupFlow failed", {
      anonymousSessionIdPrefix: anonymousSessionId.slice(0, 8),
      error: msg.slice(0, 400),
    });
    return NextResponse.json(
      {
        status: "error",
        message: "Couldn't read signup state. Please try again.",
      },
      { status: 500 },
    );
  }
  if (!flow) {
    return NextResponse.json(
      {
        status: "not_found",
        message:
          "Your signup session expired or doesn't exist. Click 'Sign in with ChatGPT' to start a new one.",
      },
      { status: 404 },
    );
  }

  // 4. Idempotent return for already-terminal rows.
  //    'completed' here means a prior poll resolved the user and stored
  //    tokens; we just need to mint a fresh signupToken so the client can
  //    establish a session.
  if (flow.status === "completed") {
    if (!flow.resolved_user_id) {
      // Defensive: completed status without resolved_user_id shouldn't be
      // possible (markSignupFlowCompleted writes both atomically). If
      // somehow we get here, surface as error rather than minting a token
      // pointing at a null user.
      logger.error("openai-signup: completed flow has no resolved_user_id", {
        flowId: flow.id,
      });
      return NextResponse.json(
        { status: "error", message: "Signup state is corrupt. Please try again." },
        { status: 500 },
      );
    }
    return respondCompleted(flow.resolved_user_id, supabase);
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

  // 5. Clock-side expiry check — same as device-code/poll
  if (new Date(flow.expires_at).getTime() <= Date.now()) {
    try {
      await markSignupFlowFailed(flow.id, "expired", null, supabase);
    } catch (markErr) {
      logger.warn("openai-signup: failed to mark flow expired", {
        flowId: flow.id,
        error: markErr instanceof Error ? markErr.message : String(markErr),
      });
    }
    return NextResponse.json({ status: "expired" });
  }

  // 6. Poll OpenAI
  let pollResult;
  try {
    pollResult = await pollDeviceFlow(flow.device_auth_id, flow.user_code);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("openai-signup: pollDeviceFlow threw", {
      flowId: flow.id,
      error: msg.slice(0, 400),
    });
    return NextResponse.json(
      {
        status: "error",
        message:
          "Couldn't reach OpenAI to check sign-in status. Please try again.",
      },
      { status: 503 },
    );
  }

  // 7. Map OpenAI result → response
  switch (pollResult.status) {
    case "pending":
      return NextResponse.json({ status: "pending" });

    case "expired":
      try {
        await markSignupFlowFailed(flow.id, "expired", null, supabase);
      } catch (markErr) {
        logger.warn("openai-signup: failed to mark flow expired (post-poll)", {
          flowId: flow.id,
          error: markErr instanceof Error ? markErr.message : String(markErr),
        });
      }
      return NextResponse.json({ status: "expired" });

    case "denied":
      try {
        await markSignupFlowFailed(flow.id, "denied", null, supabase);
      } catch (markErr) {
        logger.warn("openai-signup: failed to mark flow denied", {
          flowId: flow.id,
          error: markErr instanceof Error ? markErr.message : String(markErr),
        });
      }
      return NextResponse.json({
        status: "denied",
        message:
          "You clicked Deny on OpenAI's authorization screen. Click Sign in to try again.",
      });

    case "error":
      try {
        await markSignupFlowFailed(
          flow.id,
          "error",
          pollResult.message.slice(0, 500),
          supabase,
        );
      } catch (markErr) {
        logger.warn("openai-signup: failed to mark flow error", {
          flowId: flow.id,
          error: markErr instanceof Error ? markErr.message : String(markErr),
        });
      }
      logger.warn("openai-signup: pollDeviceFlow returned error status", {
        flowId: flow.id,
        message: pollResult.message.slice(0, 200),
      });
      return NextResponse.json({
        status: "error",
        message:
          "OpenAI couldn't complete the sign-in. Try again — if this keeps happening, " +
          "check that your ChatGPT account has Codex device-code login enabled.",
      });

    case "completed": {
      // 8. Identity resolution + token storage + flow update + token mint.
      //    This is the load-bearing block. Each sub-step has its own
      //    failure semantics; we map all hard failures to status=error.
      if (!pollResult.claims) {
        // Without claims we can't identify the user. Treat as error.
        logger.error("openai-signup: completed without claims — cannot resolve user", {
          flowId: flow.id,
        });
        try {
          await markSignupFlowFailed(
            flow.id,
            "error",
            "missing_claims_on_completion",
            supabase,
          );
        } catch {
          /* best effort */
        }
        return NextResponse.json(
          {
            status: "error",
            message:
              "OpenAI returned a completion without identity info. Please try signing in again.",
          },
          { status: 502 },
        );
      }

      // 8a. Read cookie context (partner, referral, edge_verified).
      //     These are root-path cookies set by /edge/claim and the partner
      //     portal flows. They're sent with this request because they
      //     match path=/ in the cookie jar.
      const partnerCookie =
        cookieJar.get("instaclaw_partner")?.value ?? null;
      const referralCode =
        cookieJar.get("instaclaw_referral_code")?.value ?? null;
      const edgeVerifiedCookieRaw =
        cookieJar.get(EDGE_VERIFIED_COOKIE_NAME)?.value ?? null;

      // 8b. Resolve user (find-or-create). Throws on hard DB errors.
      let resolved;
      try {
        resolved = await resolveSignupUser(
          pollResult.claims,
          {
            partnerCookie,
            referralCode,
            edgeVerifiedCookieRaw,
          },
          supabase,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("openai-signup: resolveSignupUser failed", {
          flowId: flow.id,
          error: msg.slice(0, 400),
        });
        try {
          await markSignupFlowFailed(
            flow.id,
            "error",
            `resolve_failed: ${msg.slice(0, 200)}`,
            supabase,
          );
        } catch {
          /* best effort */
        }
        return NextResponse.json(
          {
            status: "error",
            message:
              "We got your ChatGPT authorization but couldn't create your account. " +
              "Please try again — if this keeps happening, contact support.",
          },
          { status: 500 },
        );
      }

      // 8c. Store OAuth tokens on the user record. Reuses the existing
      //     helper (encrypted-token write + token_version bump).
      try {
        await storeOAuthTokens(resolved.userId, pollResult, supabase);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("openai-signup: storeOAuthTokens failed", {
          flowId: flow.id,
          userId: resolved.userId,
          error: msg.slice(0, 400),
        });
        // The user exists but tokens didn't save. They could still sign
        // in normally (we'll mint the signupToken below) but their VM
        // won't have the OpenAI BYOK token until they re-connect from
        // /settings. Surface as error so they retry — cleaner than
        // partial state.
        try {
          await markSignupFlowFailed(
            flow.id,
            "error",
            `store_failed: ${msg.slice(0, 200)}`,
            supabase,
          );
        } catch {
          /* best effort */
        }
        return NextResponse.json(
          {
            status: "error",
            message:
              "We got your ChatGPT authorization but couldn't save it. Please try again.",
          },
          { status: 500 },
        );
      }

      // 8d. Mark flow as completed. If this fails the tokens are still
      //     stored — the next poll's idempotent return will see flow
      //     status=pending (didn't update) and reach this branch again,
      //     re-running steps that are all idempotent.
      try {
        await markSignupFlowCompleted(flow.id, resolved.userId, supabase);
      } catch (markErr) {
        logger.warn("openai-signup: markSignupFlowCompleted failed (tokens stored, user resolved)", {
          flowId: flow.id,
          userId: resolved.userId,
          error: markErr instanceof Error ? markErr.message : String(markErr),
        });
        // Continue anyway — the user IS authorized; we just have a
        // dangling flow row. Cleanup cron handles it.
      }

      // 8e. Mint signupToken. If this fails the user has an account but
      //     no way to sign in via this flow — they'd have to use the
      //     Google path or re-try.
      const tokenResult = signSignupToken(resolved.userId);
      if (!tokenResult.ok || !tokenResult.token) {
        logger.error("openai-signup: signSignupToken failed", {
          flowId: flow.id,
          userId: resolved.userId,
          error: tokenResult.error,
        });
        return NextResponse.json(
          {
            status: "error",
            message:
              "Couldn't finalize sign-in. Please try again or use Google sign-in.",
          },
          { status: 500 },
        );
      }

      logger.info("openai-signup: completed", {
        flowId: flow.id,
        userId: resolved.userId,
        isNewUser: resolved.isNewUser,
        partnerApplied: resolved.partnerApplied,
        edgeVerifiedApplied: resolved.edgeVerifiedApplied,
        planType: pollResult.claims.chatgptPlanType ?? null,
        // Prefix only — token is session-equivalent (Rule 53)
        signupTokenPrefix: tokenResult.token.slice(0, 12),
      });

      return NextResponse.json({
        status: "completed",
        plan_type: pollResult.claims.chatgptPlanType ?? null,
        signupToken: tokenResult.token,
      });
    }
  }
}

/**
 * Idempotent return for a flow row that's ALREADY status=completed.
 * Mints a fresh signupToken (60s exp from now) pointing at the resolved
 * user. The client can call signIn() with this token.
 *
 * Plan_type lookup is best-effort — failures fall through to null.
 */
async function respondCompleted(
  resolvedUserId: string,
  supabase: ReturnType<typeof getSupabase>,
): Promise<NextResponse<CompletedResponse | TerminalResponse>> {
  let planType: string | null = null;
  try {
    const { data: u } = await supabase
      .from("instaclaw_users")
      .select("chatgpt_plan_type")
      .eq("id", resolvedUserId)
      .single();
    planType = (u?.chatgpt_plan_type as string | null | undefined) ?? null;
  } catch {
    /* cosmetic field — failures don't block */
  }

  const tokenResult = signSignupToken(resolvedUserId);
  if (!tokenResult.ok || !tokenResult.token) {
    logger.error("openai-signup: signSignupToken failed in respondCompleted", {
      resolvedUserId,
      error: tokenResult.error,
    });
    return NextResponse.json(
      {
        status: "error",
        message: "Couldn't finalize sign-in. Please try again.",
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    status: "completed",
    plan_type: planType,
    signupToken: tokenResult.token,
  });
}
