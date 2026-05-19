/**
 * DELETE /api/auth/openai/disconnect
 *
 * Phase 1 design doc §6.3 — the user-initiated teardown of a ChatGPT
 * connection. Sets the user's chatgpt_oauth fields to NULL, flips any
 * of their VMs back from chatgpt_oauth → all_inclusive + Claude default
 * model, and bumps openai_token_version so the reconciler removes the
 * openai-codex profile from every VM's auth-profiles.json on the next tick.
 *
 * ─── Response shape standard (P2-A) ──────────────────────────────────────
 *
 * `{ status, message? }` matching the other OAuth routes:
 *
 *   status         | http | meaning
 *   ---------------|------|------------------------------------------
 *   "ok"           | 200  | disconnected (idempotent)
 *   "unauthorized" | 401  | no session
 *   "error"        | 500  | internal failure
 *
 * Day 2.5 (P2-A): changed from `{ok: boolean, error?: string}` so the UI
 * state machine across all 3 routes is a single `switch(status)`.
 *
 * ─── IMPORTANT — NO feature-flag gate ────────────────────────────────────
 *
 * Per Cooper's Day 1 instruction: "users should always be able to
 * disconnect a connected account, even if we've globally disabled new
 * connections." If we flipped the kill switch and a user wants out
 * BEFORE the graceful-downgrade cron reaches them, this route must
 * still work. Same reason a fire exit doesn't have a lock.
 *
 * Shared with the kill-switch cron: both call `disconnectUser` from
 * lib/openai-oauth-db.ts, so behavior is guaranteed identical (single
 * source of truth — same shape as lib/billing-status.ts per Rule 14).
 *
 * Phase 1 scope: LOCAL DELETE ONLY. We do NOT call OpenAI's token
 * revocation endpoint. Per Cooper's Day 1 answers (Open Question #5):
 * "local delete only for Phase 1. OpenAI revocation API is Phase 2."
 * Rationale: the user's refresh token becomes unusable from our side
 * (we delete it), and we never read it again. The OAuth token at
 * OpenAI's end will eventually expire naturally (~30d on refresh).
 *
 * Idempotent — disconnecting an already-disconnected user is a no-op
 * (NULL-ing already-NULL columns; the version bump is wasted but harmless).
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { disconnectUser } from "@/lib/openai-oauth-db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface OkResponse {
  status: "ok";
}
interface ErrorResponse {
  status: "unauthorized" | "error";
  message: string;
}
type Response = OkResponse | ErrorResponse;

export async function DELETE(): Promise<NextResponse<Response>> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { status: "unauthorized", message: "Sign in to manage your ChatGPT connection." },
      { status: 401 },
    );
  }
  const userId = session.user.id;

  const supabase = getSupabase();
  try {
    await disconnectUser(userId, supabase);
    logger.info("openai-oauth: user disconnected", {
      userId,
      source: "user_action",
    });
    return NextResponse.json({ status: "ok" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("openai-oauth: disconnect failed", {
      userId,
      error: msg.slice(0, 400),
    });
    return NextResponse.json(
      {
        status: "error",
        message:
          "Couldn't disconnect ChatGPT. Please try again — if this keeps happening, contact support.",
      },
      { status: 500 },
    );
  }
}
