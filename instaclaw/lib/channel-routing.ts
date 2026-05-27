/**
 * Channel routing — backend relay between channel webhooks and the user's VM gateway.
 *
 * Used by:
 *   - app/api/imessage/inbound/route.ts ("known" branch — Sendblue iMessage replies)
 *   - app/api/telegram/shared-bot/inbound/route.ts ("known" branch — @myinstaclaw_bot)
 *
 * The contract these channels need is DIFFERENT from the Instagram webhook
 * pattern (app/api/webhooks/instagram/route.ts):
 *
 *   Instagram: fire-and-forget POST to `${gateway_url}/api/instagram-event`.
 *              The VM has an Instagram extension that owns the outbound back
 *              to Instagram. We never see the agent's response.
 *
 *   iMessage / shared-bot: there is NO on-VM channel adapter for these
 *              (configureOpenClaw skips telegram plugin when token is null;
 *              there's no Sendblue plugin at all). The BACKEND is the relay.
 *              We post the user message, wait for the response, send it
 *              back through the channel ourselves.
 *
 * Gateway endpoint: `/v1/chat/completions` (OpenAI-compatible). Probed live
 * on edge_city VM-1028 on 2026-05-27. Behavior:
 *
 *   - Accepts `{model: "openclaw", messages: [{role:"user", content:"..."}]}`
 *     with NO system message and NO history. The gateway internally loads
 *     the agent's full SOUL.md / MEMORY.md / capabilities (~40K prompt
 *     tokens) and runs the configured default model (Sonnet/GPT-5.5/etc).
 *   - Persists the user + assistant turn to the agent's natural session.jsonl
 *     under ~/.openclaw/agents/main/sessions/. Subsequent calls see prior
 *     turns in context.
 *   - Auto-routes via the VM's configured model + api_mode (BYOK / all-inclusive).
 *     DO NOT send x-openclaw-model — the gateway rejects fully-qualified
 *     anthropic/* model names for BYOK VMs ("BYOK users should call Anthropic
 *     directly" — verified on vm-1028).
 *
 * Net effect: when the user texts iMessage / shared-bot, the agent on the
 * VM gets the message AS IF the user had used a normal channel plugin. Full
 * tools (browser, web search, gbrain memory, partner skills) all work.
 *
 * Why we don't maintain conversation history in the backend:
 *
 *   The VM's session.jsonl IS the conversation history. We confirmed (live
 *   on vm-1028, 2026-05-27) that two sequential /v1/chat/completions calls
 *   write to the same session and the agent remembered a nonce passed in
 *   call 1 when asked in call 2. Maintaining backend history would
 *   double-store and risk drift.
 *
 * Idempotency:
 *
 *   The inbound webhook returns 200 BEFORE this function is awaited
 *   (callers wrap in `after()`). Sendblue and Telegram both treat 200 as
 *   "delivered, no retry." So the backend-level retry surface is empty —
 *   we never re-process the same message_id.
 *
 *   The only remaining duplicate-send risk is multi-user message bursts
 *   where calls overlap. Per spec §6.5.6 we accept potential out-of-order
 *   responses; serializing per-user adds complexity without clear win.
 *
 * Failure modes handled:
 *
 *   - User has no VM yet                    → {ok:false, reason:"no_vm"}
 *   - VM is hibernating/suspended           → wake first, then proceed
 *   - VM unreachable / gateway 5xx          → {ok:false, reason:"gateway_*"}
 *   - Gateway returns empty content         → friendly fallback message
 *   - Channel send fails                    → log + propagate {ok:false, reason}
 *   - Channel not configured for v1         → {ok:false, reason:"unsupported_channel"}
 *
 * What this module deliberately does NOT do:
 *
 *   - Handle Instagram or Discord — those have their own webhook handlers.
 *   - Pre-validate the message text — channel webhooks already enforce
 *     non-empty content / valid identity / non-group-chat etc.
 *   - Acquire any cron lock or DB lock — sweep cron + form-submit handler
 *     already use compare-and-swap on m_return_sent_at; this is a separate
 *     code path (M_RETURN already happened by the time we route inbound).
 *
 * Per CLAUDE.md Rule 11, maxDuration on the inbound route handlers is 300s
 * (already set). The 120s gateway timeout below + a couple chunked sends
 * fit comfortably under that budget even for tool-heavy agent turns.
 */

import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { sendImessage, isValidE164 } from "@/lib/sendblue";
import {
  sendTelegramSharedBot,
  isValidTelegramChatId,
} from "@/lib/telegram-shared-bot";
import { wakeIfHibernating } from "@/lib/wake-vm";

export type ForwardChannel = "imessage" | "telegram";

export type ForwardResult =
  | { ok: true; replyLength: number; vmId: string }
  | {
      ok: false;
      reason:
        | "no_vm"
        | "gateway_unreachable"
        | "gateway_timeout"
        | "gateway_4xx"
        | "gateway_5xx"
        | "empty_response"
        | "send_failed"
        | "unsupported_channel"
        | "invalid_identity";
      detail?: string;
      vmId?: string;
    };

interface ForwardArgs {
  /** instaclaw_users.id */
  userId: string;
  /** "imessage" or "telegram" (shared bot only) */
  channel: ForwardChannel;
  /**
   * The channel-specific user identity:
   *   - imessage: E.164 phone number (+1...)
   *   - telegram: chat_id as decimal string
   */
  channelIdentity: string;
  /** The user's inbound text. May be empty if mediaUrl present. */
  text: string;
  /** Optional inbound media URL (image / audio). v1 forwards as a hint in the prompt. */
  mediaUrl?: string;
  /** Channel-side message id, for logs only. Not used for routing. */
  inboundMessageId?: string;
}

/**
 * How long we'll wait for the VM gateway to return a chat completion.
 * Realistic upper bound: tool-using agent doing a web-search + browser tab
 * takes 30-90s at p99 with cache hit, ~120s without. Beyond 120s the user
 * has likely lost focus and a retry feels worse than a graceful "didn't
 * hear back" silence.
 */
const GATEWAY_TIMEOUT_MS = 120_000;

/**
 * After a wake, give the gateway a moment to bind /health and finish
 * loading session+plugins before we POST. Matches the wake-vm RCA's
 * observation that gateway-active takes 5-15s after a cold start.
 */
const POST_WAKE_DELAY_MS = 5_000;

/**
 * Telegram Bot API caps sendMessage `text` at 4096 chars. We chunk at
 * 4000 to leave headroom for any emoji or unicode expansion.
 */
const TELEGRAM_CHUNK_LIMIT = 4000;

/**
 * Sendblue documents 18996 chars per outbound; lib/sendblue.ts caps at
 * 5000 defensively. Match that cap here so we don't push messages that
 * the outbound helper will reject anyway.
 */
const IMESSAGE_CHUNK_LIMIT = 5000;

/**
 * Inter-chunk delay. Sendblue applies a 1msg/sec per-line server-side
 * rate limit; even our 800ms gap will be smoothed to 1s. Telegram allows
 * ~1msg/sec per chat — 300ms keeps us under without artificial choreo.
 */
const IMESSAGE_INTER_CHUNK_MS = 800;
const TELEGRAM_INTER_CHUNK_MS = 300;

/**
 * Split a long agent response into channel-sized chunks. Prefer paragraph
 * boundaries (\n\n), then sentence boundaries (`. ` / `? ` / `! `), then a
 * hard cut. Returns at least one chunk even for empty input (callers should
 * guard upstream, but defensive).
 */
export function splitForChannel(text: string, maxLen: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= maxLen) return [trimmed];

  const chunks: string[] = [];
  let remaining = trimmed;

  while (remaining.length > maxLen) {
    // 1. Prefer paragraph boundary within budget.
    let cut = remaining.lastIndexOf("\n\n", maxLen);
    // 2. Fall back to sentence boundary within budget.
    if (cut < maxLen * 0.5) {
      const candidates = [
        remaining.lastIndexOf(". ", maxLen),
        remaining.lastIndexOf("? ", maxLen),
        remaining.lastIndexOf("! ", maxLen),
        remaining.lastIndexOf("\n", maxLen),
      ].filter((i) => i >= maxLen * 0.5);
      if (candidates.length > 0) cut = Math.max(...candidates) + 1;
    }
    // 3. Last resort: word boundary, then hard cut.
    if (cut < maxLen * 0.5) {
      cut = remaining.lastIndexOf(" ", maxLen);
    }
    if (cut < maxLen * 0.3) {
      cut = maxLen;
    }
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * The core relay. Look up the VM, wake if needed, POST the user message to
 * the gateway, send the response back via the channel.
 *
 * Logs every outcome at the appropriate level. Never throws — returns a
 * structured ForwardResult that callers can branch on for telemetry.
 */
export async function forwardInboundToVm(
  args: ForwardArgs,
): Promise<ForwardResult> {
  const { userId, channel, channelIdentity, text, mediaUrl, inboundMessageId } =
    args;

  // ─── 0. Validate channel-identity shape (cheap, no DB hit) ──
  if (channel === "imessage" && !isValidE164(channelIdentity)) {
    return { ok: false, reason: "invalid_identity", detail: "non-E.164 phone" };
  }
  if (channel === "telegram" && !isValidTelegramChatId(channelIdentity)) {
    return { ok: false, reason: "invalid_identity", detail: "bad chat_id" };
  }

  const identityRedacted =
    channel === "imessage"
      ? channelIdentity.slice(0, 6) + "***"
      : channelIdentity.slice(0, 4) + "***";
  const logCtx = {
    route: "lib/channel-routing",
    userId,
    channel,
    identityPrefix: identityRedacted,
    inboundMessageId: inboundMessageId ?? null,
  };

  const supabase = getSupabase();

  // ─── 1. Look up the user's VM ──
  // Per CLAUDE.md Rule 19, safety-critical lookup uses select("*") so a
  // future column-grant misconfig under RLS doesn't silently null-out
  // gateway_token. Slightly more bytes; worth the safety.
  const { data: vm, error: vmErr } = await supabase
    .from("instaclaw_vms")
    .select("*")
    .eq("assigned_to", userId)
    .eq("status", "assigned")
    .maybeSingle();

  if (vmErr) {
    logger.error("forwardInboundToVm: vm lookup failed", {
      ...logCtx,
      error: vmErr.message,
    });
    return { ok: false, reason: "no_vm", detail: vmErr.message };
  }
  if (!vm || !vm.gateway_url || !vm.gateway_token) {
    logger.warn("forwardInboundToVm: user has no usable VM", {
      ...logCtx,
      hasRow: !!vm,
      hasGatewayUrl: !!vm?.gateway_url,
      hasGatewayToken: !!vm?.gateway_token,
    });
    return { ok: false, reason: "no_vm", vmId: vm?.id };
  }

  const vmId: string = vm.id;
  const gatewayUrl: string = String(vm.gateway_url).replace(/\/+$/, "");
  const gatewayToken: string = String(vm.gateway_token);
  const healthStatus: string | null = vm.health_status ?? null;

  // ─── 2. Wake if hibernating/suspended ──
  // The agent already sent M_RETURN, so for the happy path the gateway IS
  // up. But suspend-check could have re-hibernated a quiet VM between
  // M_RETURN and the user's reply. wakeIfHibernating is best-effort,
  // never throws.
  if (healthStatus === "hibernating" || healthStatus === "suspended") {
    logger.info("forwardInboundToVm: VM sleeping — waking", { ...logCtx, vmId, healthStatus });
    try {
      const wakeResults = await wakeIfHibernating(
        supabase,
        userId,
        "channel-routing",
      );
      const anyOk = wakeResults.some((w) => w.ok);
      if (!anyOk) {
        logger.warn("forwardInboundToVm: wake returned no successes — trying gateway anyway", {
          ...logCtx,
          vmId,
          wakeResults,
        });
      }
      // Give the gateway a moment to bind /health + load plugins.
      await new Promise((r) => setTimeout(r, POST_WAKE_DELAY_MS));
    } catch (wakeErr) {
      logger.warn("forwardInboundToVm: wake threw — trying gateway anyway", {
        ...logCtx,
        vmId,
        error: wakeErr instanceof Error ? wakeErr.message : String(wakeErr),
      });
    }
  }

  // ─── 3. Build the user message ──
  // Media handling for v1: include the URL as an inline hint. Most agent
  // skills can fetch and inspect; richer multimodal injection is a v2 task.
  // We do NOT pre-fetch + base64 encode here — that doubles the request
  // size and pushes us over the gateway's typical inbound size budget.
  let userMessage: string;
  if (text.trim().length > 0 && mediaUrl) {
    userMessage = `${text.trim()}\n\n[The user also attached media: ${mediaUrl}]`;
  } else if (mediaUrl) {
    userMessage = `[The user sent media with no text. Attachment URL: ${mediaUrl}]`;
  } else {
    userMessage = text.trim();
  }
  if (userMessage.length === 0) {
    // Should never happen — inbound handlers gate on hasContent || hasMedia.
    // Defensive: skip silently rather than send an empty turn to the agent.
    logger.warn("forwardInboundToVm: empty userMessage after build — bailing", logCtx);
    return { ok: false, reason: "empty_response", detail: "empty inbound" };
  }

  // ─── 4. POST to gateway /v1/chat/completions ──
  // Stateless from our side: no system message, no history. The gateway
  // loads the agent's full SOUL/MEMORY context and persists this turn to
  // the agent's natural session.jsonl (verified live on vm-1028 2026-05-27).
  //
  // model="openclaw" + NO x-openclaw-model header — gateway uses the VM's
  // configured default (Sonnet / GPT-5.5 / etc per agents.defaults.model).
  // Sending a fully-qualified model name breaks BYOK VMs.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);

  let assistantText: string;
  let usage: unknown = null;
  try {
    const res = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${gatewayToken}`,
      },
      body: JSON.stringify({
        model: "openclaw",
        max_tokens: 4096,
        stream: false,
        messages: [{ role: "user", content: userMessage }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      // Surface up to 500 chars of body for forensics; truncate to keep logs
      // bounded. 4xx = our request shape is wrong; 5xx = gateway internal.
      const bodyText = await res.text().catch(() => "(no body)");
      const reason: ForwardResult & { ok: false } = {
        ok: false,
        reason: res.status >= 500 ? "gateway_5xx" : "gateway_4xx",
        detail: `HTTP ${res.status}: ${bodyText.slice(0, 500)}`,
        vmId,
      };
      logger.error("forwardInboundToVm: gateway returned non-ok", {
        ...logCtx,
        vmId,
        status: res.status,
        bodyPrefix: bodyText.slice(0, 200),
      });
      return reason;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await res.json();
    assistantText =
      data?.choices?.[0]?.message?.content?.toString().trim() ?? "";
    usage = data?.usage ?? null;
    if (!assistantText) {
      logger.warn("forwardInboundToVm: gateway returned empty content", {
        ...logCtx,
        vmId,
        finishReason: data?.choices?.[0]?.finish_reason,
        usage,
      });
      // Send a graceful fallback rather than dropping silently — better
      // for the user to see "still thinking" than to hear nothing.
      assistantText =
        "(my response came back empty — that's on me. ping me again with a bit more detail and i'll try fresh.)";
    }
  } catch (fetchErr) {
    clearTimeout(timeout);
    const isAbort =
      fetchErr instanceof Error &&
      (fetchErr.name === "AbortError" || /aborted/i.test(fetchErr.message));
    const reason = isAbort ? "gateway_timeout" : "gateway_unreachable";
    logger.error("forwardInboundToVm: gateway fetch failed", {
      ...logCtx,
      vmId,
      reason,
      error: fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
    });
    return {
      ok: false,
      reason,
      detail: fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
      vmId,
    };
  }

  // ─── 5. Send the response back via the channel ──
  // Each channel has its own length limit; chunk + send sequentially.
  // If outbound fails partway through, the user gets a truncated reply but
  // the gateway already persisted the full assistant turn (so the agent
  // "knows what it said" even if delivery dropped midway). Better than
  // either silent failure or duplicate dispatches.
  try {
    if (channel === "imessage") {
      const chunks = splitForChannel(assistantText, IMESSAGE_CHUNK_LIMIT);
      for (let i = 0; i < chunks.length; i++) {
        await sendImessage(channelIdentity, chunks[i]);
        if (i < chunks.length - 1) {
          await new Promise((r) => setTimeout(r, IMESSAGE_INTER_CHUNK_MS));
        }
      }
    } else if (channel === "telegram") {
      const chunks = splitForChannel(assistantText, TELEGRAM_CHUNK_LIMIT);
      for (let i = 0; i < chunks.length; i++) {
        await sendTelegramSharedBot(channelIdentity, chunks[i]);
        if (i < chunks.length - 1) {
          await new Promise((r) => setTimeout(r, TELEGRAM_INTER_CHUNK_MS));
        }
      }
    } else {
      // TypeScript exhaustiveness — channel is "imessage" | "telegram", so
      // this branch is unreachable. Belt-and-suspenders for future v2 when
      // discord/slack land and someone forgets to extend the switch.
      const exhaustive: never = channel;
      return {
        ok: false,
        reason: "unsupported_channel",
        detail: String(exhaustive),
        vmId,
      };
    }
  } catch (sendErr) {
    logger.error("forwardInboundToVm: outbound channel send failed", {
      ...logCtx,
      vmId,
      error: sendErr instanceof Error ? sendErr.message : String(sendErr),
    });
    return {
      ok: false,
      reason: "send_failed",
      detail: sendErr instanceof Error ? sendErr.message : String(sendErr),
      vmId,
    };
  }

  logger.info("forwardInboundToVm: routed successfully", {
    ...logCtx,
    vmId,
    inboundLength: userMessage.length,
    replyLength: assistantText.length,
    usage,
  });
  return { ok: true, replyLength: assistantText.length, vmId };
}
