/**
 * M_RETURN — the agent's first message after the user finishes the
 * channel-onboarding web flow.
 *
 * Two trigger points share this dispatcher (per spec §6.5.7
 * invariant 4):
 *   1. /api/onboarding/done/submit — fired when the user taps Done
 *      or Skip. Fast path; M_RETURN arrives ~1s after submit if the
 *      VM gateway is ready.
 *   2. /api/cron/m-return-sweep — fired every minute by Vercel cron.
 *      Catches users who closed the tab without submitting, AND
 *      retries cases where the submit-handler dispatch failed.
 *
 * Both call `dispatchMReturn(pendingId, trigger)`. The function
 * encapsulates:
 *   - Looking up the pending row + verifying state
 *   - Verifying the VM has gateway_url populated
 *   - Reading user_profile for personalization injection
 *   - Building the agent's first message
 *   - Sending via Sendblue (iMessage) or Telegram Bot API
 *   - Compare-and-swap on m_return_sent_at — race-safe
 *
 * ─── M_RETURN content (v1 scope) ───
 *
 * The spec describes M_RETURN as "the real LLM response from the
 * agent." For v1 we ship a server-side templated message with
 * personalization injection from instaclaw_user_profile. The template
 * carries the same voice as the welcome burst (lowercase, comma+period
 * rhythm) and acknowledges whatever the user filled out:
 *
 *   With name + use + vibe: "hey {name}. {use} mode, {vibe} vibe — got it. what do you want to do first?"
 *   With name only:         "hey {name}. what do you want to do first?"
 *   Skip / no data:         "hey. ready when you are. what do you want to do first?"
 *
 * Future v2 may upgrade this to a real LLM call into the user's VM
 * gateway — but that requires either an OpenClaw endpoint that runs
 * the agent and returns the message string (we ARE the channel
 * adapter, so the agent can't deliver via its own plugins) OR a
 * custom on-VM endpoint. For Edge launch we ship the template.
 *
 * ─── Race-safety strategy ───
 *
 * Two CAS steps:
 *   1. (closed-tab case only) UPDATE consumed_at = NOW WHERE consumed_at IS NULL
 *   2. UPDATE m_return_sent_at = NOW WHERE m_return_sent_at IS NULL
 *
 * Step 1 only runs when sweep cron fires for a never-consumed row.
 * Step 2 always runs; whoever wins the CAS owns the send.
 *
 * If the send FAILS after step 2 succeeds, we roll back m_return_sent_at
 * to NULL (UPDATE ... WHERE m_return_sent_at = nowIso). If our process
 * dies between step 2 and rollback (rare — Vercel function timeout),
 * the row is stuck with m_return_sent_at set but no actual send. Worst
 * case: ~1 in N00 users gets stuck. Manual recovery via DB UPDATE.
 *
 * The risk of NOT doing CAS-first is sending duplicates if two crons
 * race. That's worse than the rare stuck case.
 */

import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { sendImessage } from "@/lib/sendblue";
import { sendTelegramSharedBot } from "@/lib/telegram-shared-bot";

export type MReturnDispatchResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "pending_not_found"
        | "no_user"
        | "no_channel"
        | "no_binding"
        | "no_vm"
        | "vm_not_ready"
        | "already_sent"
        | "consumed_race_lost"
        | "send_failed"
        | "unsupported_channel"
        | "error";
      detail?: string;
    };

export type MReturnTrigger = "form-submit" | "sweep-cron";

interface PendingRow {
  id: string;
  user_id: string | null;
  channel: string | null;
  channel_identity: string | null;
  consumed_at: string | null;
  m_return_sent_at: string | null;
  reclaimed_at: string | null;
}

interface VMRow {
  id: string;
  gateway_url: string | null;
}

interface ProfileRow {
  name: string | null;
  intended_use: string | null;
  vibe: string | null;
}

/**
 * Attempt to dispatch M_RETURN for the given pending row. Returns
 * immediately if the VM isn't ready or M_RETURN already fired — both
 * are normal states, not errors.
 *
 * Idempotent: calling repeatedly for the same pendingId after a
 * successful first dispatch returns `{ ok: false, reason: "already_sent" }`.
 *
 * @param pendingId The instaclaw_pending_users.id to dispatch for.
 * @param trigger Which entry point called us (form-submit | sweep-cron).
 */
export async function dispatchMReturn(
  pendingId: string,
  trigger: MReturnTrigger,
): Promise<MReturnDispatchResult> {
  const supabase = getSupabase();
  const logCtx = { route: "lib/m-return-dispatch", pendingId, trigger };

  // ─── 1. Fetch pending row + verify shape ──
  const { data: pendingRaw, error: pendingErr } = await supabase
    .from("instaclaw_pending_users")
    .select(
      "id, user_id, channel, channel_identity, consumed_at, m_return_sent_at, reclaimed_at",
    )
    .eq("id", pendingId)
    .maybeSingle();

  if (pendingErr) {
    logger.error("[m-return-dispatch] pending lookup failed", {
      ...logCtx,
      error: pendingErr.message,
    });
    return { ok: false, reason: "error", detail: pendingErr.message };
  }

  if (!pendingRaw) {
    return { ok: false, reason: "pending_not_found" };
  }

  const pending = pendingRaw as PendingRow;

  // Reclaimed rows are dead — Pass 6 has already torn down the VM.
  if (pending.reclaimed_at) {
    return { ok: false, reason: "consumed_race_lost", detail: "reclaimed" };
  }

  // Already sent — caller is racing or retrying redundantly.
  if (pending.m_return_sent_at) {
    return { ok: false, reason: "already_sent" };
  }

  // Pending row must have a user_id + channel + identity at this point.
  // /auth's bind step writes user_id; the webhook writes channel + identity.
  if (!pending.user_id) {
    return { ok: false, reason: "no_user" };
  }
  if (!pending.channel || !pending.channel_identity) {
    return { ok: false, reason: "no_channel" };
  }

  // ─── 2. Closed-tab consumed_at claim (sweep cron only path) ──
  // If consumed_at is NULL, we're firing as the closed-tab catch-up.
  // Atomically claim consumed_at before doing any work. If we lose
  // the race (form submit fired between our SELECT and this UPDATE),
  // bail — the form submit will handle dispatch.
  const nowIso = new Date().toISOString();
  if (!pending.consumed_at) {
    const { data: consumedClaim, error: consumedErr } = await supabase
      .from("instaclaw_pending_users")
      .update({ consumed_at: nowIso })
      .eq("id", pendingId)
      .is("consumed_at", null)
      .select("id")
      .maybeSingle();

    if (consumedErr) {
      logger.error("[m-return-dispatch] consumed_at CAS failed", {
        ...logCtx,
        error: consumedErr.message,
      });
      return { ok: false, reason: "error", detail: consumedErr.message };
    }

    if (!consumedClaim) {
      return { ok: false, reason: "consumed_race_lost" };
    }
  }

  // ─── 3. Verify VM is ready ──
  const { data: vmRaw } = await supabase
    .from("instaclaw_vms")
    .select("id, gateway_url")
    .eq("assigned_to", pending.user_id)
    .eq("status", "assigned")
    .maybeSingle();

  const vm = vmRaw as VMRow | null;

  if (!vm) {
    return { ok: false, reason: "no_vm" };
  }

  if (!vm.gateway_url) {
    return { ok: false, reason: "vm_not_ready" };
  }

  // ─── 4. Read user_profile for personalization ──
  const { data: profileRaw } = await supabase
    .from("instaclaw_user_profile")
    .select("name, intended_use, vibe")
    .eq("user_id", pending.user_id)
    .maybeSingle();

  const profile: ProfileRow = profileRaw
    ? {
        name: (profileRaw as ProfileRow).name,
        intended_use: (profileRaw as ProfileRow).intended_use,
        vibe: (profileRaw as ProfileRow).vibe,
      }
    : { name: null, intended_use: null, vibe: null };

  // ─── 5. CAS on m_return_sent_at — atomic claim of "I own this send" ──
  const { data: mReturnClaim, error: mReturnClaimErr } = await supabase
    .from("instaclaw_pending_users")
    .update({ m_return_sent_at: nowIso })
    .eq("id", pendingId)
    .is("m_return_sent_at", null)
    .select("id")
    .maybeSingle();

  if (mReturnClaimErr) {
    logger.error("[m-return-dispatch] m_return_sent_at CAS failed", {
      ...logCtx,
      error: mReturnClaimErr.message,
    });
    return { ok: false, reason: "error", detail: mReturnClaimErr.message };
  }

  if (!mReturnClaim) {
    // Another caller claimed first. Not an error.
    return { ok: false, reason: "already_sent" };
  }

  // ─── 6. Build + send the message ──
  const message = buildMReturnMessage(profile);

  try {
    if (pending.channel === "imessage") {
      await sendImessage(pending.channel_identity, message);
    } else if (pending.channel === "telegram") {
      await sendTelegramSharedBot(pending.channel_identity, message);
    } else {
      // Discord / Slack not supported in v1 (waitlist only).
      await rollbackMReturnClaim(supabase, pendingId, nowIso);
      return { ok: false, reason: "unsupported_channel", detail: pending.channel };
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[m-return-dispatch] send failed; rolling back CAS", {
      ...logCtx,
      channel: pending.channel,
      error: detail,
    });
    await rollbackMReturnClaim(supabase, pendingId, nowIso);
    return { ok: false, reason: "send_failed", detail };
  }

  logger.info("[m-return-dispatch] sent", {
    ...logCtx,
    channel: pending.channel,
    hasName: !!profile.name,
    hasIntendedUse: !!profile.intended_use,
    hasVibe: !!profile.vibe,
    messageLength: message.length,
  });

  return { ok: true };
}

/**
 * Rollback m_return_sent_at to NULL — but only if we still own the
 * claim (m_return_sent_at === the nowIso we just set). If something
 * else set m_return_sent_at to a different timestamp since (impossible
 * in practice, but defensive), leave it alone.
 */
async function rollbackMReturnClaim(
  supabase: ReturnType<typeof getSupabase>,
  pendingId: string,
  nowIso: string,
): Promise<void> {
  try {
    await supabase
      .from("instaclaw_pending_users")
      .update({ m_return_sent_at: null })
      .eq("id", pendingId)
      .eq("m_return_sent_at", nowIso);
  } catch (err) {
    logger.error("[m-return-dispatch] rollback failed", {
      route: "lib/m-return-dispatch",
      pendingId,
      error: err instanceof Error ? err.message : String(err),
    });
    // We've sent the message AND can't roll back the CAS. The user
    // may get a duplicate on the next sweep tick if rollback wasn't
    // applied — but this only happens if BOTH the send AND the
    // rollback failed (rare). Manual recovery via DB UPDATE.
  }
}

/**
 * Convert a vibe slug to its display form.
 * Migration values: 'just-get-things-done' | 'chatty-and-warm' | 'wry-and-minimal'
 */
function vibeDisplay(slug: string | null): string | null {
  if (!slug) return null;
  return slug.replace(/-/g, " ");
}

/**
 * Build the M_RETURN message text from the user's profile.
 * Voice: lowercase, comma+period rhythm, agent-first-person.
 * Closes with "what do you want to do first?" — universal action prompt.
 *
 * Exported for unit testing.
 */
export function buildMReturnMessage(profile: ProfileRow): string {
  const name = profile.name?.trim() || null;
  const use = profile.intended_use;
  const vibe = vibeDisplay(profile.vibe);

  // Opening line
  const opener = name ? `hey ${name}.` : "hey.";

  // Personalization acknowledgment line (optional)
  let ackLine = "";
  if (use && vibe) {
    ackLine = ` ${use} mode, ${vibe} vibe — got it.`;
  } else if (use) {
    ackLine = ` ${use} mode noted.`;
  } else if (vibe) {
    ackLine = ` ${vibe} vibe — that's how i'll show up.`;
  } else if (name) {
    // Have a name but no other personalization — soft acknowledgment.
    ackLine = ` ready when you are.`;
  } else {
    // No personalization at all — short, warm.
    ackLine = ` ready when you are.`;
  }

  // Action prompt — same for everyone.
  const cta = ` what do you want to do first?`;

  return opener + ackLine + cta;
}

// sendTelegramSharedBot is imported from lib/telegram-shared-bot — same
// module the inbound webhook handler uses, so the outbound transport is
// shared and consistent.
