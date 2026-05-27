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
  gateway_token: string | null;
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
  // We need gateway_token alongside gateway_url so we can attempt a
  // real LLM-backed first message via tryGatewayFirstMessage (P1-B,
  // 2026-05-27). Both columns must be populated for the gateway path;
  // if gateway_token is missing we fall through to the template.
  const { data: vmRaw } = await supabase
    .from("instaclaw_vms")
    .select("id, gateway_url, gateway_token")
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

  // ─── 6. Build the message — try gateway LLM first, fall back to template ──
  // P1-B (2026-05-27): the agent's FIRST real message used to be a
  // server-side template ("hey {name}. {use} mode, {vibe} vibe — got it.
  // what do you want to do first?"). For the demonstration moment of the
  // funnel — where the user has just signed up and expects to meet a
  // real agent — that's flat.
  //
  // Strategy: try a real /v1/chat/completions call into the VM gateway
  // with a "first message" framing prompt. The agent uses its full
  // SOUL.md / MEMORY.md voice + personalization context we inject. If
  // the gateway is unreachable, times out, or returns empty, fall back
  // to buildMReturnMessage (the template) so the user always gets
  // SOMETHING within seconds.
  //
  // tryGatewayFirstMessage NEVER throws — it returns null on any
  // failure. The fallback path is the same template that ran for the
  // entire pre-P1-B era, so worst-case parity with the prior shipped
  // behavior.
  const gatewayChannel: "imessage" | "telegram" | null =
    pending.channel === "imessage" || pending.channel === "telegram"
      ? pending.channel
      : null;
  let message: string | null = null;
  let messageSource: "gateway" | "template" = "template";
  if (gatewayChannel && vm.gateway_token) {
    const gw = await tryGatewayFirstMessage(
      { gateway_url: vm.gateway_url, gateway_token: vm.gateway_token },
      gatewayChannel,
      profile,
      logCtx,
    );
    if (gw) {
      message = gw;
      messageSource = "gateway";
    }
  }
  if (!message) {
    message = buildMReturnMessage(profile);
  }

  try {
    if (pending.channel === "imessage") {
      await sendImessage(pending.channel_identity, message);
    } else if (pending.channel === "telegram") {
      await sendTelegramSharedBot(pending.channel_identity, message);
    } else if (pending.channel === "web") {
      // No external dispatch for web-only users (the /onboarding/web
      // skip path). The CAS above already claimed m_return_sent_at so
      // the sweep cron won't keep retrying, which is what we want.
      //
      // Why no storage write: the spec doc's `storeDashboardWelcome`
      // assumed an instaclaw_message_log table that doesn't exist in
      // this codebase. The command center reads from instaclaw_tasks
      // (task-based, not chat-history-based); pre-seeding a task with
      // a synthetic "Welcome" body is a category violation (tasks are
      // user-initiated requests). Cleanest UX: web user lands in
      // /tasks, sees empty inbox + chat input, types their first
      // message, agent responds. The agent's response IS the M_RETURN
      // substitute for web — no broadcast needed.
      //
      // Phase 2 may surface a one-time greeting via the dashboard's
      // empty-state UI (separate from this dispatcher), driven off
      // user.preferred_channel === 'web'. Not Phase 1 scope.
      logger.info("[m-return-dispatch] web channel — no external dispatch", {
        ...logCtx,
        userId: pending.user_id,
      });
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
    messageSource,
    hasName: !!profile.name,
    hasIntendedUse: !!profile.intended_use,
    hasVibe: !!profile.vibe,
    messageLength: message.length,
  });

  return { ok: true };
}

/**
 * M_RETURN gateway-call timeout. Shorter than channel-routing's 120s
 * because (a) M_RETURN is the user's FIRST message and silence beyond
 * ~45s damages the demonstration moment, and (b) we have a same-second
 * template fallback so timing out cheaply is better than blocking on a
 * slow tool-using turn.
 */
const M_RETURN_GATEWAY_TIMEOUT_MS = 45_000;

/**
 * Attempt to generate the agent's first message via the VM gateway.
 *
 * Returns the assistant's response text on success, or null on ANY
 * failure (gateway unreachable, timeout, non-200, empty content,
 * malformed JSON). Caller treats null as "fall back to template."
 *
 * Prompt framing: a single user-role message that tells the agent
 * (a) this is its first interaction, (b) what channel the user is on,
 * (c) what personalization the user filled in (if any). The agent's
 * own SOUL.md / BOOTSTRAP.md context handles voice — we don't override
 * with a system message because that would suppress the agent's
 * configured identity. Verified live on vm-1028 (2026-05-27): when
 * called with no system message, the gateway loads the full agent
 * context (~40K prompt tokens) and produces a personalized response.
 */
async function tryGatewayFirstMessage(
  vm: { gateway_url: string; gateway_token: string },
  channel: "imessage" | "telegram",
  profile: ProfileRow,
  logCtx: { route: string; pendingId: string; trigger: MReturnTrigger },
): Promise<string | null> {
  const channelLabel = channel === "imessage" ? "iMessage" : "Telegram";

  // Build a personalization fragment from whatever the user filled in.
  // Empty/skipped fields are gracefully omitted — the agent handles the
  // null-context case from its own SOUL.md guidance.
  const parts: string[] = [];
  const name = profile.name?.trim();
  if (name) parts.push(`my name is ${name}`);
  if (profile.intended_use) parts.push(`i want to use you for ${profile.intended_use}`);
  const vibe = vibeDisplay(profile.vibe);
  if (vibe) parts.push(`i prefer a ${vibe} vibe`);
  const personalization =
    parts.length > 0
      ? `quick context: ${parts.join(", ")}.`
      : `i didn't fill out the optional personalization form — you can ask me anything you need later.`;

  // The framing prompt. Direct, agent-aware, voice-preserving. Caps
  // length implicitly via max_tokens below.
  const prompt =
    `this is the very first message you're sending me — i just finished signup and ` +
    `came back to ${channelLabel}. ${personalization} ` +
    `respond in your usual voice. say hi briefly, acknowledge anything i shared, ` +
    `and close by asking what i'd like to do first. keep it under 4 short sentences.`;

  const gatewayUrl = vm.gateway_url.replace(/\/+$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), M_RETURN_GATEWAY_TIMEOUT_MS);

  try {
    const res = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${vm.gateway_token}`,
      },
      body: JSON.stringify({
        model: "openclaw",
        // Cap response length: M_RETURN is one bubble. ~512 tokens is
        // ~1500-2000 chars — well under Sendblue's 5000 cap and
        // Telegram's 4096 cap.
        max_tokens: 512,
        stream: false,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      logger.warn("[m-return-dispatch] gateway returned non-ok; falling back to template", {
        ...logCtx,
        status: res.status,
      });
      return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await res.json();
    const content = data?.choices?.[0]?.message?.content?.toString().trim();
    if (!content) {
      logger.warn("[m-return-dispatch] gateway returned empty content; falling back to template", {
        ...logCtx,
        finishReason: data?.choices?.[0]?.finish_reason,
      });
      return null;
    }
    // Belt-and-suspenders: if the agent produced something pathological
    // (way over the per-channel cap), prefer the safe template rather
    // than risk a truncated multi-bubble first impression.
    if (content.length > 4000) {
      logger.warn("[m-return-dispatch] gateway response exceeds 4000 chars; falling back to template", {
        ...logCtx,
        length: content.length,
      });
      return null;
    }
    return content;
  } catch (err) {
    clearTimeout(timeout);
    const isAbort =
      err instanceof Error &&
      (err.name === "AbortError" || /aborted/i.test(err.message));
    logger.warn(
      `[m-return-dispatch] gateway ${isAbort ? "timed out" : "threw"}; falling back to template`,
      {
        ...logCtx,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return null;
  }
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
