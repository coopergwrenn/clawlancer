/**
 * Index Network intent persistence — shared helper for the
 * optimistic-accept + back-fill path.
 *
 * BACKGROUND
 * ──────────
 *
 * Yanek's Index Network has two API surfaces:
 *
 *   1. POST /api/networks/<id>/signup   — mint a per-user API key
 *      Status: fixed 2026-05-23 morning by Yanek (TLS cert rotation +
 *      master-key reissue). Working end-to-end.
 *
 *   2. MCP `create_intent` tool (called via /mcp)  — register an intent
 *      in the discovery graph
 *      Status: BROKEN on Yanek's side as of 2026-05-23. Returns an
 *      "error" status code from our `createIndexIntent` lib (an
 *      "error" or "skipped" result.status). Yanek is "looking at the
 *      intent problem" per his Telegram message.
 *
 * The user's intent submit happens through both endpoints in sequence
 * via `createIndexIntent`:
 *   /signup (or short-circuit on cached key) → MCP create_intent
 *
 * Pre-fix, an "error" result returned 503 with "coming online soon"
 * to the user — they'd see the error, click the always-visible skip
 * link (which sets index_last_intent_at + queues the text), and
 * proceed. Usable but not delightful, and the success-state animation
 * never fires.
 *
 * OPTIMISTIC ACCEPT
 * ─────────────────
 *
 * When Yanek's MCP tool is the failure point (not user error, not
 * rate limit), we optimistically tell the user "your intent is
 * registered" and queue the text for back-fill via this helper.
 * When Yanek restores the tool, a one-shot replay script can grep
 * the structured logs + push each queued intent through
 * `createIndexIntent`.
 *
 * PERSISTENCE STRATEGY
 * ────────────────────
 *
 * Structured `logger.info` call with a well-known prefix:
 *   "[index-intent-queued] optimistic-accept ..."
 *
 * Replay shape: filter Vercel logs by the prefix, parse the JSON
 * fields (userId, description, reason, timestamp), iterate through
 * each, call `createIndexIntent({userId, description})`. Idempotency
 * is per-user-per-5-min via the existing rate-limit anchor — replay
 * a queued intent more than once and the second attempt rate-limits
 * (which is fine; just means the first replay won).
 *
 * Why not a DB table for the queue: would require a migration (CLAUDE.md
 * Rule 56 — migration files trigger build-pipeline-blocking verifier).
 * Tonight is a hotfix window; structured logs are durable enough
 * (Vercel retains 30d on Pro + the back-fill window for Yanek's fix
 * is expected to be hours, not days). When the dust settles a proper
 * `instaclaw_queued_index_intents` table is a clean follow-up.
 *
 * USED BY
 * ───────
 *   - /api/edge/intents/skip — user-initiated skip (always-visible link)
 *   - /api/edge/express-intent — optimistic-accept on Yanek-MCP error
 *
 * IDEMPOTENCY
 * ───────────
 * The helper is safe to call multiple times. It only does:
 *   1. logger.info (always emits — N calls = N log lines, which is
 *      INTENDED so the back-fill script sees every queue event)
 *   2. UPDATE index_last_intent_at = NOW() (idempotent — repeated
 *      writes within seconds of each other just keep the timestamp
 *      fresh)
 *
 * The caller is responsible for any rate-limit semantics (the
 * express-intent route's CAS claim, the skip route's "no rate limit
 * because user is escaping a broken state").
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "./logger";

export type QueueReason =
  | "user_skipped_voluntarily" // user clicked the "skip for now" link
  | "index_network_degraded" // service_unavailable from escape-hatch panel
  | "mcp_create_intent_error" // Yanek's MCP write-tool bug (the common case)
  | "mcp_create_intent_skipped" // skipped status from createIndexIntent for non-validation reasons
  | "unknown";

export interface QueueIntentForBackfillArgs {
  userId: string;
  /** The intent text the user typed. Empty string is acceptable (user
   *  skipped without typing); the helper logs a different shape in that
   *  case so the back-fill script can skip it. */
  description: string;
  /** Why this intent is being queued vs. successfully registered.
   *  Surfaces in logs for triage. */
  reason: QueueReason;
  /** Optional upstream-error detail for log correlation when the queue
   *  was caused by an Index Network failure. Max 200 chars logged. */
  detail?: string;
  /** Supabase client. Caller provides so we don't duplicate connection
   *  pools. */
  supabase: SupabaseClient;
}

export interface QueueResult {
  /** True if the index_last_intent_at write succeeded (the gate write
   *  the dashboard layout uses). False on DB error — the caller may
   *  still return success to the user since the log persistence is the
   *  recovery path. */
  gateMarked: boolean;
  /** True if we structurally logged the intent for back-fill (which is
   *  always true when description is non-empty + >=10 chars; empty
   *  descriptions are logged differently). */
  queued: boolean;
}

/**
 * Mark the intent gate as satisfied + persist the intent text for
 * later back-fill.
 *
 * Never throws — the caller's UX path proceeds regardless of helper
 * outcome. Caller can inspect the return value for observability but
 * shouldn't gate user-visible flow on it.
 */
export async function queueIntentForBackfill(
  args: QueueIntentForBackfillArgs,
): Promise<QueueResult> {
  const { userId, description, reason, detail, supabase } = args;
  const trimmed = (description ?? "").trim();
  const hasDescription = trimmed.length >= 10;

  // 1. Structured log — durable persistence + back-fill anchor.
  //    Prefix `[index-intent-queued]` is the grep target for the
  //    replay script. JSON fields are flat (no nested objects) so
  //    a one-liner awk + jq pipe can extract them.
  if (hasDescription) {
    logger.info("[index-intent-queued] queued for back-fill", {
      userId,
      description: trimmed,
      descriptionLength: trimmed.length,
      reason,
      detail: detail?.slice(0, 200),
      timestamp: new Date().toISOString(),
    });
  } else {
    logger.info("[index-intent-queued] no description to queue", {
      userId,
      reason,
      timestamp: new Date().toISOString(),
    });
  }

  // 2. Mark gate as satisfied — the dashboard layout's mandatory-intent
  //    redirect checks `instaclaw_users.index_last_intent_at`. Setting
  //    it to NOW() means the user is treated as "has submitted" by
  //    every downstream check.
  //
  //    Idempotent: re-running this UPDATE with the same userId just
  //    refreshes the timestamp (harmless). The rate-limit anchor on
  //    /api/edge/express-intent uses the same column and respects
  //    monotonic forward updates.
  //
  //    Don't throw on DB error — the helper's primary job (durable
  //    log persistence) succeeded above; the caller decides what to
  //    surface user-side.
  const { error: dbErr } = await supabase
    .from("instaclaw_users")
    .update({ index_last_intent_at: new Date().toISOString() })
    .eq("id", userId);

  if (dbErr) {
    logger.error("[index-intent-queued] gate write failed (logged-only)", {
      userIdPrefix: userId.slice(0, 8),
      err: dbErr.message,
      reason,
    });
    return { gateMarked: false, queued: hasDescription };
  }

  return { gateMarked: true, queued: hasDescription };
}
