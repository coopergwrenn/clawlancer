/**
 * Shared signup classification + creation for channel-based inbound.
 *
 * Both the iMessage inbound webhook (`/api/imessage/inbound`) and the
 * Telegram shared bot webhook (`/api/telegram/shared-bot/inbound`) need
 * the exact same lookup chain when a message arrives:
 *
 *   1. Is this a KNOWN user? (user_channel_bindings row exists)
 *   2. Is there an IN-FLIGHT signup? (pending_users with consumed_at NULL)
 *   3. Otherwise, create a NEW pending_users row and welcome them.
 *
 * Per CLAUDE.md and spec §6.5.10, every step has to be race-safe — two
 * concurrent inbound requests for the same channel_identity must not
 * create two pending_users rows. The DB enforces this via a partial
 * unique index on (channel, channel_identity) WHERE consumed_at IS NULL.
 * We catch the 23505 here and re-resolve to the existing row.
 *
 * What this module deliberately does NOT do:
 *   - Send messages (the channel handler owns transport)
 *   - Verify webhook signatures (the channel handler owns auth)
 *   - Know anything about iMessage / Telegram / Discord specifics
 *
 * It's the pure DB layer. Channel handlers compose it with their
 * transport library (lib/sendblue.ts for iMessage, the Telegram Bot
 * API for shared bot).
 */

import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { generateShortCode } from "@/lib/short-code";

export type SignupChannel = "imessage" | "telegram" | "discord" | "slack";

/**
 * The four possible outcomes of `resolveInbound`.
 */
export type InboundResolution =
  | {
      kind: "known";
      userId: string;
      vmId: string | null;
    }
  | {
      kind: "in_flight";
      pendingId: string;
      shortCode: string;
      userId: string | null;
    }
  | {
      kind: "new";
      pendingId: string;
      shortCode: string;
    }
  | {
      kind: "error";
      error: string;
    };

/**
 * Look up whether this (channel, channel_identity) pair belongs to a
 * known user who already has a VM. Returns null if no binding exists.
 *
 * Uses .select("*") per CLAUDE.md Rule 19 (safety-critical reads should
 * not use column lists under RLS).
 */
async function findKnownUserBinding(
  channel: SignupChannel,
  channelIdentity: string,
): Promise<{ userId: string; vmId: string | null } | null> {
  const supabase = getSupabase();

  const { data: binding, error } = await supabase
    .from("instaclaw_user_channel_bindings")
    .select("*")
    .eq("channel", channel)
    .eq("channel_identity", channelIdentity)
    .maybeSingle();

  if (error) {
    logger.warn("[onboarding-signup] binding lookup failed", {
      channel,
      errorMessage: error.message,
    });
    return null;
  }

  if (!binding) return null;

  // Resolve the user's currently-assigned VM (if any). It's possible
  // for a binding to exist while the VM is in transit (frozen, mid-
  // reassignment); in that case vmId is null and the caller handles
  // it gracefully (we still know who the user is).
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id")
    .eq("assigned_to", binding.user_id)
    .eq("status", "assigned")
    .maybeSingle();

  return {
    userId: binding.user_id,
    vmId: vm?.id ?? null,
  };
}

/**
 * Look up an in-flight pending_users row for this channel identity.
 * "In-flight" = consumed_at IS NULL. A row with consumed_at IS NOT NULL
 * either successfully onboarded (and we should have found a binding
 * instead) or was reclaimed (Pass 6). In both cases, treat as if no
 * row exists.
 */
async function findInFlightPending(
  channel: SignupChannel,
  channelIdentity: string,
): Promise<{
  id: string;
  short_code: string | null;
  user_id: string | null;
} | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("instaclaw_pending_users")
    .select("*")
    .eq("channel", channel)
    .eq("channel_identity", channelIdentity)
    .is("consumed_at", null)
    .maybeSingle();

  if (error) {
    logger.warn("[onboarding-signup] in-flight lookup failed", {
      channel,
      errorMessage: error.message,
    });
    return null;
  }

  return data;
}

/**
 * Resolve an inbound message to one of {known, in_flight, new, error}.
 *
 * For the "new" case, creates a fresh pending_users row with a
 * cryptographically random short_code. The creation is race-safe:
 * if a concurrent request creates a row first, we catch the
 * unique-constraint violation and re-resolve to the existing row.
 *
 * Returns "error" only on a hard DB failure that should make the
 * webhook return 500 (Sendblue / Telegram will retry).
 */
export async function resolveInbound(
  channel: SignupChannel,
  channelIdentity: string,
): Promise<InboundResolution> {
  // Step 1: known user?
  const binding = await findKnownUserBinding(channel, channelIdentity);
  if (binding) {
    return { kind: "known", userId: binding.userId, vmId: binding.vmId };
  }

  // Step 2 + 3: find-or-create with bounded retry. Three attempts
  // handles every race scenario:
  //   - Existing row from a previous request → SELECT finds it
  //   - Concurrent INSERT wins the partial unique index race → next
  //     iteration's SELECT picks it up
  //   - short_code collision (1 in 60M) → next iteration mints a new one
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await findInFlightPending(channel, channelIdentity);
    if (existing && existing.short_code) {
      return {
        kind: "in_flight",
        pendingId: existing.id,
        shortCode: existing.short_code,
        userId: existing.user_id,
      };
    }

    // No in-flight row. Try to create one.
    const shortCode = generateShortCode();
    const supabase = getSupabase();
    const { data: inserted, error: insertErr } = await supabase
      .from("instaclaw_pending_users")
      .insert({
        channel,
        channel_identity: channelIdentity,
        short_code: shortCode,
        // tier defaults to whatever the column default is; the
        // /plan step sets the real tier when the user picks.
        // api_mode default is 'all_inclusive' per the column default.
      })
      .select()
      .single();

    if (!insertErr && inserted) {
      logger.info("[onboarding-signup] created new pending row", {
        channel,
        pendingId: inserted.id,
        shortCode,
      });
      return {
        kind: "new",
        pendingId: inserted.id,
        shortCode,
      };
    }

    // 23505 = unique_violation. Could be:
    //   (a) short_code collision (regenerate and retry)
    //   (b) (channel, channel_identity) in-flight collision — another
    //       webhook hit landed a microsecond before us. Next iteration's
    //       SELECT will pick up that row and we'll return in_flight.
    const code = (insertErr as { code?: string } | null)?.code;
    if (code === "23505") {
      logger.info("[onboarding-signup] 23505 on insert; retrying", {
        channel,
        attempt: attempt + 1,
      });
      continue;
    }

    // Non-unique-violation error. Bail out and surface so the webhook
    // can return 500 → Sendblue/Telegram retries.
    logger.error("[onboarding-signup] non-23505 insert error", {
      channel,
      errorMessage: insertErr?.message,
      errorCode: code,
    });
    return {
      kind: "error",
      error: insertErr?.message || "unknown DB error",
    };
  }

  // Three attempts exhausted. Should be statistically impossible at
  // our scale — 36^5 keyspace × 1000 users in flight ≈ 0.00002%
  // collision rate per attempt → ~10^-14 chance for 3 in a row.
  // If it happens, we have a real problem; surface for retry.
  logger.error("[onboarding-signup] exhausted 3 attempts to find/create row", {
    channel,
  });
  return {
    kind: "error",
    error: "exhausted retries finding/creating pending row",
  };
}
