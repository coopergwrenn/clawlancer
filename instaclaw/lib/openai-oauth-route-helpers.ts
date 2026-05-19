/**
 * Shared helpers for the /api/auth/openai/* route handlers.
 *
 * Extracted from the routes themselves for two reasons:
 *
 *   1. Testability — these helpers are pure-ish (one supabase param,
 *      no Next.js machinery) so they can be unit-tested without
 *      mocking NextRequest / NextResponse / NextAuth.
 *
 *   2. Decision discipline — the start route's "what should we do?"
 *      logic was buggy before Day 2.5 (audit finding P1-B: pending check
 *      was running BEFORE connected check, so orphan pending rows
 *      shadowed the already-connected state). Centralizing it here with
 *      a discriminated union makes the decision tree explicit.
 *
 * Each helper is independently importable from its callsite — no
 * coupling between body-validation and decision-tree.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getConnectedSummary,
  getFreshPendingFlow,
  type ConnectedSummary,
  type DeviceFlowRow,
} from "./openai-oauth-db";

// ─── Poll request body validation (P1-A) ─────────────────────────────────

/**
 * Result type for validatePollRequestBody — discriminated union so the
 * route can `if (result.ok)` and use `result.flowId` or `result.message`
 * without type gymnastics.
 */
export type PollBodyValidation =
  | { ok: true; flowId: string }
  | { ok: false; message: string };

/**
 * Validate the body of a POST /api/auth/openai/device-code/poll request.
 *
 * Defensively handles every wire-format misbehavior:
 *   - body is null              → 400 "body must be a JSON object"
 *   - body is an array          → 400 "body must be a JSON object"
 *   - body is a primitive       → 400 "body must be a JSON object"
 *   - body.flow_id missing      → 400 "flow_id is required"
 *   - body.flow_id is not string→ 400 "flow_id must be a string"
 *   - body.flow_id is empty     → 400 "flow_id must be a non-empty string"
 *
 * Why this helper exists: the Day 2 route had `body = (await req.json())
 * as Record<string, unknown>` which is a runtime lie — if req.json()
 * returns null (valid JSON for the literal `null`), accessing
 * `body.flow_id` throws TypeError, which propagates as an unhelpful 500.
 * Audit finding P1-A.
 *
 * @param body Whatever req.json() returned — caller has already wrapped
 *             the parse call in try/catch and we trust this is a parsed
 *             JSON value (object, array, primitive, or null).
 */
export function validatePollRequestBody(body: unknown): PollBodyValidation {
  if (body === null || body === undefined) {
    return {
      ok: false,
      message: "Body must be a JSON object with a flow_id field. Got: null/undefined.",
    };
  }
  if (typeof body !== "object") {
    return {
      ok: false,
      message: `Body must be a JSON object with a flow_id field. Got: ${typeof body}.`,
    };
  }
  if (Array.isArray(body)) {
    return {
      ok: false,
      message: "Body must be a JSON object with a flow_id field. Got: array.",
    };
  }
  const obj = body as Record<string, unknown>;
  if (!("flow_id" in obj)) {
    return {
      ok: false,
      message: "flow_id is required.",
    };
  }
  if (typeof obj.flow_id !== "string") {
    return {
      ok: false,
      message: `flow_id must be a string. Got: ${typeof obj.flow_id}.`,
    };
  }
  if (obj.flow_id.length === 0) {
    return {
      ok: false,
      message: "flow_id must be a non-empty string.",
    };
  }
  return { ok: true, flowId: obj.flow_id };
}

// ─── Start route decision tree (P1-B) ────────────────────────────────────

/**
 * What the start route should do, after consulting DB state.
 * Discriminated union — the route's switch is exhaustive.
 */
export type StartAction =
  | { kind: "already_connected"; summary: ConnectedSummary }
  | { kind: "reuse_pending"; flow: DeviceFlowRow }
  | { kind: "mint_new" };

/**
 * Decide what the start route should do for the given user.
 *
 * IMPORTANT — ORDER MATTERS:
 *
 *   1. Connected check FIRST. Tokens-on-disk is the authoritative state.
 *      If the user has tokens, they're connected, regardless of whether
 *      a pending device-flow row exists from a previous incomplete
 *      attempt. This was the audit finding P1-B fix: prior code checked
 *      pending FIRST, which meant a previous markDeviceFlowCompleted
 *      failure (which leaves the row in 'pending' even though tokens
 *      are stored) would shadow the connected state on the next start
 *      attempt — user would see a stale code that OpenAI had already
 *      consumed.
 *
 *   2. Pending check SECOND. Only matters if user is NOT connected.
 *      If they have a fresh pending flow, return it so they see the
 *      same code on every modal re-open (saves a roundtrip to OpenAI).
 *
 *   3. Mint new LAST. The expected path for a fresh user.
 *
 * NOTE on expired-tokens-not-yet-refreshed: getConnectedSummary returns
 * connected=true based on access_token presence alone (NOT expires_at).
 * This is intentional — even if expired, the refresh cron (Day 16-18)
 * will refresh on its next tick. If the refresh fails permanently
 * (refresh_token_reused or similar), the cron itself NULLs the tokens
 * via disconnectUser, after which this helper returns mint_new. Single
 * source of truth: token presence on the user record.
 */
export async function decideStartAction(
  userId: string,
  supabase: SupabaseClient,
): Promise<StartAction> {
  // 1. Connected → authoritative.
  const summary = await getConnectedSummary(userId, supabase);
  if (summary.connected) {
    return { kind: "already_connected", summary };
  }
  // 2. Pending flow → resume polling.
  const pending = await getFreshPendingFlow(userId, supabase);
  if (pending) {
    return { kind: "reuse_pending", flow: pending };
  }
  // 3. Mint a new flow.
  return { kind: "mint_new" };
}
