/**
 * Hourly cron — refresh ChatGPT OAuth access tokens approaching expiry.
 *
 * OpenAI's access_token TTL is ~30 days. This cron picks up users whose
 * tokens enter the 24-hour expiry window and refreshes them (which also
 * rotates the refresh_token). Each successful refresh bumps
 * user.openai_token_version, which triggers stepChatGPTOAuthToken on
 * the next reconcile tick to push the new token to the VM.
 *
 * ─── CRITICAL — Rule 53 — single-use refresh tokens ─────────────────────
 *
 * OpenAI's refresh tokens are SINGLE-USE. Two concurrent refresh attempts
 * for the same user → one succeeds, the other gets refresh_token_reused
 * which is a PERMANENT lockout until the user re-OAuths. This cron MUST
 * serialize all refresh attempts for a given user via instaclaw_cron_locks.
 *
 * The locking happens inside refreshUserToken (lib/openai-oauth-db.ts).
 * Per-user lock key: `openai-oauth-refresh:${userId}`. TTL 120s (enough
 * for one OpenAI round-trip + DB writes).
 *
 * Lock contention is handled gracefully — refreshUserToken returns
 * { status: "skipped_locked" } and the cron continues to the next user.
 * On the next hourly cycle, the lock will likely be free and the refresh
 * proceeds normally.
 *
 * ─── INVERTED FLAG SEMANTICS ────────────────────────────────────────────
 *
 * Runs ONLY when OPENAI_OAUTH_ENABLED=true. When the kill switch is OFF,
 * the graceful-downgrade cron is concurrently winding down user tokens,
 * and the refresh cron would just be wasted work. Pairs cleanly with
 * the graceful-downgrade cron (which runs ONLY when flag is OFF).
 *
 * ─── BLAST RADIUS ───────────────────────────────────────────────────────
 *
 * Per-cycle budget: BATCH_SIZE = 50 users. With ~50 currently-connected
 * users in beta + a few hundred at scale, that's well within Vercel's
 * 300s function budget (each refresh is ~2s sequential — 100s for 50).
 *
 * On permanent failure (reused/expired/revoked/account_mismatch),
 * refreshUserToken calls disconnectUser which NULLs the user's tokens
 * and switches their VM back to Claude on the next reconciler tick.
 * Self-clearing — the next refresh-cron query won't see the user.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { isChatGPTOAuthEnabled } from "@/lib/chatgpt-oauth-feature-flag";
import { refreshUserToken } from "@/lib/openai-oauth-db";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";

// Rule 11 — Vercel Pro max for any cron that calls external services.
export const maxDuration = 300;

/** Max users to refresh per cron tick. Bounds Vercel function duration. */
const BATCH_SIZE = 50;

/** Refresh tokens expiring within this window. */
const REFRESH_LOOKAHEAD_HOURS = 24;

interface CronResult {
  ok: boolean;
  status: "noop" | "ran" | "error";
  reason?: string;
  candidates?: number;
  refreshed?: number;
  skipped_no_token?: number;
  skipped_locked?: number;
  lockouts?: number;
  transient_failures?: number;
  decrypt_failures?: number;
  errors?: string[];
}

export async function GET(req: NextRequest): Promise<NextResponse<CronResult>> {
  // Cron auth — matches convention from reconcile-fleet etc.
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json(
      { ok: false, status: "error", reason: "unauthorized" },
      { status: 401 },
    );
  }

  // Inverted flag pairing with graceful-downgrade cron.
  if (!isChatGPTOAuthEnabled()) {
    return NextResponse.json({
      ok: true,
      status: "noop",
      reason: "feature_disabled — graceful-downgrade cron is handling cleanup",
    });
  }

  // Cron-level lock — prevents two concurrent cron invocations from
  // racing for the same users. Per-user lock inside refreshUserToken is
  // the load-bearing one (Rule 53), but this cron-level lock keeps
  // overlapping invocations from each picking up the same user and
  // both seeing the per-user lock acquired → both reporting skipped_locked
  // on different parts of the batch.
  const cronLockAcquired = await tryAcquireCronLock(
    "refresh-openai-oauth-tokens",
    300,
    "vercel-cron",
  );
  if (!cronLockAcquired) {
    return NextResponse.json({
      ok: true,
      status: "noop",
      reason: "another refresh cron invocation in progress",
    });
  }

  try {
    const supabase = getSupabase();

    // Query users in the refresh window. .select("*") per Rule 19 —
    // column-grant safety. We filter on access_token NOT NULL (already
    // connected) AND expires_at < (now + window).
    const cutoffIso = new Date(
      Date.now() + REFRESH_LOOKAHEAD_HOURS * 60 * 60 * 1000,
    ).toISOString();
    let candidates: Array<{ id: string; email?: string | null }> = [];
    try {
      const { data, error } = await supabase
        .from("instaclaw_users")
        .select("*")
        .not("openai_oauth_access_token", "is", null)
        .lt("openai_oauth_expires_at", cutoffIso)
        .limit(BATCH_SIZE);
      if (error) {
        // Pre-migration safety net — if columns don't exist yet, no-op.
        const msg = error.message || String(error);
        if (/column .* does not exist/i.test(msg)) {
          return NextResponse.json({
            ok: true,
            status: "noop",
            reason: `schema_pre_migration: ${msg.slice(0, 200)}`,
          });
        }
        throw error;
      }
      candidates = (data ?? []) as Array<{ id: string; email?: string | null }>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("refresh-openai-oauth-tokens: query failed", { error: msg });
      return NextResponse.json(
        { ok: false, status: "error", reason: msg.slice(0, 200) },
        { status: 500 },
      );
    }

    if (candidates.length === 0) {
      return NextResponse.json({
        ok: true,
        status: "noop",
        reason: "no users in refresh window",
        candidates: 0,
      });
    }

    // Per-user refresh — sequential to avoid OpenAI rate limits + simplify
    // error accounting. Each call holds its own per-user lock; cron-level
    // lock keeps overlap-invocations from competing.
    let refreshed = 0;
    let skippedNoToken = 0;
    let skippedLocked = 0;
    let lockouts = 0;
    let transientFailures = 0;
    let decryptFailures = 0;
    const errors: string[] = [];

    for (const user of candidates) {
      try {
        const result = await refreshUserToken(user.id, supabase);
        switch (result.status) {
          case "refreshed":
            refreshed++;
            logger.info("refresh-openai-oauth-tokens: user refreshed", {
              userId: user.id,
              newVersion: result.newVersion,
              planType: result.planType,
            });
            break;
          case "skipped_no_token":
            skippedNoToken++;
            break;
          case "skipped_locked":
            skippedLocked++;
            break;
          case "lockout_disconnected":
            lockouts++;
            logger.warn("refresh-openai-oauth-tokens: user disconnected after refresh failure", {
              userId: user.id,
              reason: result.reason,
              message: result.message.slice(0, 200),
            });
            break;
          case "transient_failure":
            transientFailures++;
            errors.push(`user=${user.id}: transient ${result.reason} — ${result.message.slice(0, 120)}`);
            break;
          case "decrypt_failure":
            decryptFailures++;
            errors.push(`user=${user.id}: decrypt — ${result.message.slice(0, 120)}`);
            logger.error("refresh-openai-oauth-tokens: decrypt failure", {
              userId: user.id,
              message: result.message,
            });
            break;
        }
      } catch (err) {
        transientFailures++;
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`user=${user.id}: uncaught — ${msg.slice(0, 120)}`);
        logger.error("refresh-openai-oauth-tokens: uncaught error per user", {
          userId: user.id,
          error: msg,
        });
      }
    }

    const result: CronResult = {
      ok: true,
      status: "ran",
      candidates: candidates.length,
      refreshed,
      skipped_no_token: skippedNoToken,
      skipped_locked: skippedLocked,
      lockouts,
      transient_failures: transientFailures,
      decrypt_failures: decryptFailures,
    };
    if (errors.length > 0) result.errors = errors;
    return NextResponse.json(result);
  } finally {
    await releaseCronLock("refresh-openai-oauth-tokens");
  }
}
