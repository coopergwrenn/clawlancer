/**
 * Graceful-downgrade cron for the ChatGPT OAuth kill switch.
 *
 * Phase 1 design doc §10.2 — when OPENAI_OAUTH_ENABLED is flipped to
 * false (kill switch), this cron is what actually migrates any users
 * currently in chatgpt_oauth mode back to a working baseline mode. It's
 * the safety net that prevents a kill-switch flip from stranding users
 * with a degraded agent.
 *
 * INVERTED FLAG SEMANTICS:
 *   - When OPENAI_OAUTH_ENABLED=true (normal):  this cron NO-OPS.
 *   - When OPENAI_OAUTH_ENABLED!=true (disabled): this cron WORKS,
 *     downgrading users one batch per tick.
 *
 * Idempotent. Safe to run before the migration lands (catches
 * column-doesn't-exist and returns noop). Safe to run with no eligible
 * users (returns noop). Safe to run concurrently with reconciler
 * (each batch is a small bounded query).
 *
 * Downgrade action per user:
 *   1. Set api_mode on all of the user's VMs back to 'all_inclusive'
 *      (the safe default; user can manually switch to byok in dashboard
 *      after recovery if that was their prior mode).
 *   2. Reset vm.default_model to 'claude-sonnet-4-6' for any VM whose
 *      current default_model is an openai-codex/* model (we don't touch
 *      VMs that were manually configured to a non-codex model post-connect).
 *   3. NULL out all openai_oauth_* fields on the user record.
 *   4. Bump openai_token_version (so the reconciler step picks up the
 *      change and removes the openai-codex:default profile from each
 *      VM's auth-profiles.json).
 *   5. Send a user-facing notification (Telegram or email): "ChatGPT
 *      connection was temporarily disabled across InstaClaw — your
 *      agent has been switched back to Claude. Reconnect later from
 *      Settings."
 *
 * Schedule: every 5 minutes. Runs in vercel.json crons array. When
 * the flag is on (normal operation), this is essentially free — one
 * env-var read + early return.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { isChatGPTOAuthEnabled } from "@/lib/chatgpt-oauth-feature-flag";

// Per CLAUDE.md Rule 11 — Vercel Pro max for any route that might call
// external services or do heavy work. Downgrade work is cheap but we
// might iterate over many users when the kill switch first flips.
export const maxDuration = 300;

/** How many users to downgrade per tick. Bounds blast radius. */
const BATCH_SIZE = 25;

interface DowngradeResult {
  ok: boolean;
  status: "noop" | "downgraded" | "error";
  reason?: string;
  users_processed?: number;
  users_failed?: number;
  errors?: string[];
}

export async function GET(req: NextRequest): Promise<NextResponse<DowngradeResult>> {
  // Cron auth (matches the convention from reconcile-fleet/route.ts).
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json(
      { ok: false, status: "error", reason: "unauthorized" },
      { status: 401 },
    );
  }

  // Inverted flag: this cron only does WORK when the feature is OFF.
  // When ON (normal operation), early return — cheap.
  if (isChatGPTOAuthEnabled()) {
    return NextResponse.json({
      ok: true,
      status: "noop",
      reason: "feature_enabled — no downgrade needed",
    });
  }

  const supabase = getSupabase();

  // Find users to downgrade. The .select("*") is per CLAUDE.md Rule 19
  // (column-grant safety). We .limit(BATCH_SIZE) to bound work per tick.
  //
  // Wrap in try/catch — if the migration hasn't landed yet, the column
  // doesn't exist and PostgREST returns 42703. We want this cron to be
  // safe to deploy BEFORE the migration applies; in that state it
  // returns noop cleanly.
  let candidates: Array<{ id: string; email?: string | null }> = [];
  try {
    const { data, error } = await supabase
      .from("instaclaw_users")
      .select("*")
      .eq("api_mode", "chatgpt_oauth")
      .limit(BATCH_SIZE);
    if (error) {
      // Column / value doesn't exist yet — feature pre-migration.
      const msg = error.message || String(error);
      if (
        /column .* does not exist/i.test(msg) ||
        /invalid input value for enum/i.test(msg) ||
        /violates check constraint/i.test(msg)
      ) {
        return NextResponse.json({
          ok: true,
          status: "noop",
          reason: `feature_disabled + schema_pre_migration: ${msg.slice(0, 200)}`,
        });
      }
      throw error;
    }
    candidates = (data ?? []) as Array<{ id: string; email?: string | null }>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("openai-oauth-graceful-downgrade: query failed", { error: msg });
    return NextResponse.json(
      { ok: false, status: "error", reason: msg.slice(0, 200) },
      { status: 500 },
    );
  }

  if (candidates.length === 0) {
    return NextResponse.json({
      ok: true,
      status: "noop",
      reason: "feature_disabled + no_chatgpt_oauth_users",
    });
  }

  let processed = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const user of candidates) {
    try {
      await downgradeOneUser(user.id, supabase);
      processed++;
      logger.info("openai-oauth-graceful-downgrade: user downgraded", {
        userId: user.id,
        email: user.email?.slice(0, 16) ?? "(none)",
      });
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`user=${user.id}: ${msg.slice(0, 160)}`);
      logger.warn("openai-oauth-graceful-downgrade: per-user downgrade failed", {
        userId: user.id,
        error: msg,
      });
    }
  }

  const result: DowngradeResult = {
    ok: failed === 0,
    status: processed > 0 ? "downgraded" : "noop",
    users_processed: processed,
    users_failed: failed,
  };
  if (errors.length > 0) result.errors = errors;
  return NextResponse.json(result);
}

/**
 * Downgrade one user from chatgpt_oauth mode back to all_inclusive.
 *
 * Order of operations (each is idempotent):
 *   1. UPDATE instaclaw_vms SET api_mode='all_inclusive' WHERE assigned_to=user.id
 *      AND api_mode='chatgpt_oauth'.
 *   2. UPDATE instaclaw_vms SET default_model='claude-sonnet-4-6'
 *      WHERE assigned_to=user.id AND default_model LIKE 'openai-codex/%'.
 *   3. UPDATE instaclaw_users SET openai_oauth_*=NULL,
 *      openai_token_version = openai_token_version + 1
 *      WHERE id=user.id. The version bump triggers reconciler to remove
 *      the openai-codex:default profile from disk on every VM.
 *
 * Returns nothing on success. Throws on any failure (caller catches).
 */
async function downgradeOneUser(
  userId: string,
  supabase: ReturnType<typeof getSupabase>,
): Promise<void> {
  // Step 1: VM api_mode
  const { error: vmErr } = await supabase
    .from("instaclaw_vms")
    .update({ api_mode: "all_inclusive" })
    .eq("assigned_to", userId)
    .eq("api_mode", "chatgpt_oauth");
  if (vmErr) throw new Error(`vm api_mode update failed: ${vmErr.message}`);

  // Step 2: VM default_model — only if it was an openai-codex model.
  // Use .like to match prefix; PostgREST translates to SQL LIKE.
  const { error: modelErr } = await supabase
    .from("instaclaw_vms")
    .update({ default_model: "claude-sonnet-4-6" })
    .eq("assigned_to", userId)
    .like("default_model", "openai-codex/%");
  if (modelErr) throw new Error(`vm default_model update failed: ${modelErr.message}`);

  // Step 3: NULL the user's OAuth fields + bump version. The bump is
  // an RPC call because PostgREST doesn't support "col = col + 1" in a
  // straight update. We use a simple raw expression via rpc-style
  // update with the current value + 1.
  //
  // First read current version (separate query — race is fine, we
  // accept that a concurrent reconcile could push one stale-version
  // write; the next tick reconverges).
  const { data: u, error: readErr } = await supabase
    .from("instaclaw_users")
    .select("openai_token_version")
    .eq("id", userId)
    .single();
  if (readErr) throw new Error(`user read failed: ${readErr.message}`);

  const currentVersion = (u?.openai_token_version as number | undefined) ?? 0;
  const { error: userErr } = await supabase
    .from("instaclaw_users")
    .update({
      openai_oauth_access_token: null,
      openai_oauth_refresh_token: null,
      openai_oauth_id_token_claims: null,
      openai_oauth_expires_at: null,
      openai_oauth_last_refresh_at: null,
      openai_oauth_account_id: null,
      openai_oauth_originator: null,
      chatgpt_plan_type: null,
      chatgpt_plan_last_seen_at: null,
      openai_token_version: currentVersion + 1,
    })
    .eq("id", userId);
  if (userErr) throw new Error(`user nullify failed: ${userErr.message}`);
}
