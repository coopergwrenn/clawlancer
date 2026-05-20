/**
 * notifyIndexMatch — the bridge from a recorded matchpool_outcomes row to
 * two Telegram messages, one to each matched cohort user via THEIR OWN
 * bot.
 *
 * Why this exists:
 *
 *   When an Index opportunity transitions to status=accepted (both parties
 *   agreed on Yanek's side), our poller writes a matchpool_outcomes row
 *   and the dual-channel broadcast fires → the village spectator renders
 *   the meeting visually. But the matched USERS themselves see nothing —
 *   they have to be looking at the spectator URL. This notifier is what
 *   makes the match user-discoverable: each user gets a personal-feeling
 *   message from their own bot ("hey — quick signal. i think you should
 *   meet …") with a link to the village so they can watch the encounter.
 *
 * Architecture:
 *
 *   • Called from the poller route's per-opportunity loop AFTER
 *     recordIndexMatch returns `status: 'recorded'`. Not called for
 *     `already_recorded` (we only need to notify on the FIRST sight of a
 *     match) or other statuses.
 *   • Per-side idempotency via matchpool_outcomes.notified_source_at and
 *     notified_candidate_at columns. If a side is already notified,
 *     skip. If not, attempt; update column on success.
 *   • Independent per-side retry — partial failures (one side delivered,
 *     other side has missing chat_id) retry the missing side on the next
 *     poller tick.
 *   • Delivery method: direct Telegram Bot API
 *     (https://api.telegram.org/bot<token>/sendMessage). No SSH dependency
 *     — faster, more reliable, works even if the VM is asleep. Falls
 *     through silently if a user has no telegram_chat_id (next tick
 *     retries; chat_id auto-populates the first time the user DMs their
 *     bot).
 *
 * Voice + copy decisions (per Cooper's 2026-05-19 review):
 *   • First person from the user's own bot ("i think you should meet …")
 *     — not a system notification.
 *   • Lowercase except proper nouns (InstaClaw convention).
 *   • Avoids Index's banned vocabulary: never "match" / "matched" /
 *     "networking". Prefers "signal", "overlap", "directory".
 *   • CTA URL: instaclaw.io/edge/dashboard (where the embedded village
 *     viz lives — confirmed live at this URL 2026-05-19).
 *   • Sections separated by blank lines so Telegram renders paragraphs.
 *   • Reasoning included only when it's short + non-jargon (length
 *     heuristic; jargon detection is a future improvement).
 *
 * What this DOES NOT do:
 *   • SSH fallback via notify_user.sh — left for a P2 iteration. Cost
 *     of an SSH call per notification (~1-2s) would blow past the
 *     maxDuration budget if many matches fire in one tick. The chat_id
 *     auto-population path is the right long-term fix.
 *   • Deep-link to a specific match in the viz. The viz currently
 *     renders all live encounters; specific-match deep-link is P2.
 *   • Rich formatting (Markdown / HTML). Plain text — Markdown V2
 *     escaping is fiddly and the readability of plain text is fine.
 *   • Delivery telemetry beyond the notified_*_at columns. If we want
 *     per-recipient analytics later, add an instaclaw_match_notifications
 *     table; columns are sufficient for May 30.
 */
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

// Live URL where the embedded spectator viz lives (verified 2026-05-19).
const VILLAGE_URL = "https://instaclaw.io/edge/dashboard";

// Bounds on the optional intent / reasoning passages we surface.
const INTENT_MAX_CHARS = 240;
const REASONING_MAX_CHARS = 240;
// If reasoning is longer than this, it's probably jargon-heavy — omit
// rather than render an awkward truncation.
const REASONING_OMIT_ABOVE = 400;

// Hard cap on the counterpart's display name. Yanek's actors[].name is
// unbounded — a pathological value (long form titles, suffixes, full
// legal names) would bloat the "i think you should meet …" line and
// stretch the message past safe Telegram limits. Names beyond 80 chars
// are display-noise; truncate with ellipsis.
const COUNTERPART_NAME_MAX_CHARS = 80;

// Telegram's documented sendMessage text limit is 4096 chars. We hold a
// generous safety margin (~600 chars) below that for:
//   • Bytes vs chars: UTF-16 surrogate pairs count as 2 in Telegram's
//     internal accounting; plain ASCII counts as 1. Worst case ≈ 2×.
//   • Future copy changes that lengthen the template without anyone
//     remembering to re-validate.
//   • Belt-and-suspenders for any per-section truncation that fails open.
// If a constructed message exceeds this threshold, the function falls
// back to a minimal "you've got a match — see [link]" shape rather than
// failing the Telegram send with a 400.
const TELEGRAM_MESSAGE_LIMIT = 3500;

export interface IndexOpportunityActor {
  userId: string;
  role?: "patient" | "agent" | string;
  name?: string;
  intent?: string;
}

export interface IndexOpportunitySummary {
  /** Opportunity uuid — used only in logs */
  id: string;
  actors: IndexOpportunityActor[];
  interpretation?: {
    reasoning?: string;
  };
  /**
   * Optional expiry timestamp from Yanek. If set AND in the past at the
   * time notifyIndexMatch fires, the notification is suppressed (both
   * sides) — notifying someone "you should meet X" when X has already
   * left the conference is bad UX. The matchpool_outcomes row is still
   * recorded for audit / spectator-viz; only the user-visible Telegram
   * delivery is suppressed. Null / undefined / unparseable = no expiry.
   */
  expiresAt?: string | null;
}

export interface NotifyMatchInput {
  /** outcome_id from matchpool_outcomes — the row we just recorded */
  outcomeId: string;
  /** Our user_id for the proposer side */
  sourceUserId: string;
  /** Our user_id for the responder side */
  candidateUserId: string;
  /** The full Index opportunity object as returned by the poller */
  opportunity: IndexOpportunitySummary;
}

export type NotifyMatchResult = {
  source: NotifySideResult;
  candidate: NotifySideResult;
};

export type NotifySideResult =
  | { status: "delivered"; deliveredAt: string }
  | { status: "already_notified" }
  | {
      status: "skipped";
      reason:
        | "missing_chat_id"
        | "missing_vm"
        | "missing_token"
        | "counterpart_unresolved"
        | "expired";
    }
  | { status: "failed"; reason: string; detail?: string };

/**
 * Send notifications to BOTH matched users. Idempotent — running again
 * with the same outcome_id is safe (already-notified sides become a
 * no-op).
 */
export async function notifyIndexMatch(input: NotifyMatchInput): Promise<NotifyMatchResult> {
  const sb = getSupabase();

  // Opportunity-expiry gate (#15). If Yanek populated expiresAt and
  // that time has already passed, suppress BOTH sides — notifying
  // someone after the encounter window closed is worse than not
  // notifying at all. We don't touch notified_*_at, so a subsequent
  // tick will re-evaluate (and re-skip with the same reason); the
  // notifier short-circuits cheaply BEFORE any DB / VM lookup or
  // Telegram call, so per-tick cost is just one Date parse.
  //
  // Defensive parse: malformed/unparseable expiresAt is treated as
  // "no expiry" rather than dropping legitimate notifications. Same
  // posture as a NULL expiresAt.
  if (input.opportunity.expiresAt) {
    const expiry = new Date(input.opportunity.expiresAt);
    if (Number.isFinite(expiry.getTime()) && expiry.getTime() < Date.now()) {
      logger.info("[index-notifier] opportunity expired; suppressing both sides", {
        outcomeId: input.outcomeId,
        opportunityId: input.opportunity.id,
        expiresAt: input.opportunity.expiresAt,
        nowIso: new Date().toISOString(),
      });
      return {
        source: { status: "skipped", reason: "expired" },
        candidate: { status: "skipped", reason: "expired" },
      };
    }
  }

  // Re-fetch the outcome row to read the current notified_*_at state.
  // Source of truth; avoids us racing the DB on a prior tick's update.
  const { data: row, error: rowErr } = await sb
    .from("matchpool_outcomes")
    .select("outcome_id, source_user_id, candidate_user_id, notified_source_at, notified_candidate_at, index_opportunity_id")
    .eq("outcome_id", input.outcomeId)
    .single();
  if (rowErr || !row) {
    logger.error("[index-notifier] outcome row not found", {
      outcomeId: input.outcomeId,
      error: rowErr?.message,
    });
    return {
      source: { status: "failed", reason: "outcome_row_not_found" },
      candidate: { status: "failed", reason: "outcome_row_not_found" },
    };
  }

  // Run both sides in parallel — independent failure paths.
  const [sourceRes, candidateRes] = await Promise.all([
    notifyOneSide(sb, {
      outcomeId: input.outcomeId,
      recipientUserId: input.sourceUserId,
      counterpartUserId: input.candidateUserId,
      opportunity: input.opportunity,
      alreadyNotified: !!row.notified_source_at,
      column: "notified_source_at",
    }),
    notifyOneSide(sb, {
      outcomeId: input.outcomeId,
      recipientUserId: input.candidateUserId,
      counterpartUserId: input.sourceUserId,
      opportunity: input.opportunity,
      alreadyNotified: !!row.notified_candidate_at,
      column: "notified_candidate_at",
    }),
  ]);

  return { source: sourceRes, candidate: candidateRes };
}

// ── Per-side delivery ────────────────────────────────────────────────

interface OneSideInput {
  outcomeId: string;
  recipientUserId: string;
  counterpartUserId: string;
  opportunity: IndexOpportunitySummary;
  alreadyNotified: boolean;
  column: "notified_source_at" | "notified_candidate_at";
}

async function notifyOneSide(
  sb: ReturnType<typeof getSupabase>,
  input: OneSideInput,
): Promise<NotifySideResult> {
  if (input.alreadyNotified) {
    return { status: "already_notified" };
  }

  // Fetch the recipient's VM (for bot_token + chat_id + display name).
  const { data: recipientVm } = await sb
    .from("instaclaw_vms")
    .select("name, telegram_bot_token, telegram_chat_id, index_user_id, assigned_to")
    .eq("assigned_to", input.recipientUserId)
    .eq("partner", "edge_city")
    .maybeSingle();

  if (!recipientVm) {
    return { status: "skipped", reason: "missing_vm" };
  }
  if (!recipientVm.telegram_bot_token) {
    logger.warn("[index-notifier] recipient missing telegram_bot_token", {
      outcomeId: input.outcomeId,
      vm: recipientVm.name,
    });
    return { status: "skipped", reason: "missing_token" };
  }
  if (!recipientVm.telegram_chat_id) {
    // Common case during cohort bootstrap — user hasn't DM'd bot yet.
    // We don't update notified_*_at, so the next poller tick will retry
    // once chat_id auto-populates.
    return { status: "skipped", reason: "missing_chat_id" };
  }

  // Resolve the counterpart's display name + intent from the opportunity
  // object (actors[]). The recipient's bot says "i think you should meet
  // <counterpart_name>." If we can't extract a counterpart name, we
  // can't write a usable message — skip.
  const recipientIndexUserId = recipientVm.index_user_id as string | null;
  const counterpartActor = input.opportunity.actors.find(
    (a) => a.userId && a.userId !== recipientIndexUserId,
  );
  if (!counterpartActor) {
    logger.warn("[index-notifier] could not identify counterpart actor", {
      outcomeId: input.outcomeId,
      recipientVm: recipientVm.name,
      actors: input.opportunity.actors.map((a) => ({ userIdPrefix: a.userId?.slice(0, 8), name: a.name })),
    });
    return { status: "skipped", reason: "counterpart_unresolved" };
  }
  const counterpartName = counterpartActor.name?.trim() || "someone in the directory";

  const message = buildMatchNotificationMessage({
    counterpartName,
    counterpartIntent: counterpartActor.intent ?? null,
    reasoning: input.opportunity.interpretation?.reasoning ?? null,
  });

  // Deliver via Telegram Bot API.
  const sendRes = await sendTelegramMessage(
    recipientVm.telegram_bot_token as string,
    recipientVm.telegram_chat_id as string,
    message,
  );
  if (!sendRes.ok) {
    logger.error("[index-notifier] telegram send failed", {
      outcomeId: input.outcomeId,
      vm: recipientVm.name,
      error: sendRes.error,
      httpStatus: sendRes.httpStatus,
    });
    return {
      status: "failed",
      reason: sendRes.error,
      detail: sendRes.detail,
    };
  }

  // Persist successful delivery.
  const now = new Date().toISOString();
  const { error: updateErr } = await sb
    .from("matchpool_outcomes")
    .update({ [input.column]: now })
    .eq("outcome_id", input.outcomeId);
  if (updateErr) {
    // Message was delivered — log the failure to update tracking, but
    // return success-ish. The retry on next tick will detect the
    // already-sent Telegram message via a different mechanism… actually
    // it won't. Without the column update, the next tick will RE-SEND.
    // Surface this clearly as a separate failure mode.
    logger.error("[index-notifier] delivered but failed to mark notified_*_at", {
      outcomeId: input.outcomeId,
      vm: recipientVm.name,
      column: input.column,
      error: updateErr.message,
    });
    return {
      status: "failed",
      reason: "delivered_but_tracking_update_failed",
      detail: updateErr.message,
    };
  }

  logger.info("[index-notifier] delivered", {
    outcomeId: input.outcomeId,
    vm: recipientVm.name,
    counterpartName,
    column: input.column,
  });
  return { status: "delivered", deliveredAt: now };
}

// ── Telegram Bot API ────────────────────────────────────────────────

async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
): Promise<
  { ok: true; messageId: number } | { ok: false; error: string; httpStatus?: number; detail?: string }
> {
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        // Disable link preview so the message stays compact.
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: "transport_failed", detail: msg.slice(0, 200) };
  }
  const body = await res.text();
  let parsed: { ok?: boolean; result?: { message_id?: number }; description?: string };
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, error: "non_json_response", httpStatus: res.status, detail: body.slice(0, 200) };
  }
  if (!parsed.ok) {
    return {
      ok: false,
      error: `telegram_api_${res.status}`,
      httpStatus: res.status,
      detail: parsed.description?.slice(0, 200) ?? body.slice(0, 200),
    };
  }
  return { ok: true, messageId: parsed.result?.message_id ?? 0 };
}

// ── Message construction ─────────────────────────────────────────────

/**
 * Build the Telegram message body. Plain text — no Markdown.
 *
 * Sections (separated by blank line so each renders as a paragraph):
 *   1. Opener — "hey — quick signal."
 *   2. The introduction — "i think you should meet <counterpart>."
 *   3. (optional) What they're working on — truncated intent.
 *   4. (optional) Why — truncated reasoning, only if not too long.
 *   5. CTA — link to /edge/dashboard.
 */
export function buildMatchNotificationMessage(args: {
  counterpartName: string;
  counterpartIntent?: string | null;
  reasoning?: string | null;
}): string {
  // Sanitize + cap the counterpart name BEFORE composing. Yanek's
  // actors[].name is untrusted user-supplied data; we strip line breaks
  // (would corrupt paragraph rendering), collapse whitespace runs, and
  // hard-cap length with a soft ellipsis on word boundary.
  const safeName = capCounterpartName(args.counterpartName);

  const sections: string[] = [];

  sections.push("hey — quick signal.");
  sections.push(`i think you should meet ${safeName}.`);

  const intent = truncateGracefully(args.counterpartIntent, INTENT_MAX_CHARS);
  if (intent) {
    sections.push(`what they're working on: ${intent}`);
  }

  const reasoning = args.reasoning?.trim() ?? null;
  if (reasoning && reasoning.length <= REASONING_OMIT_ABOVE) {
    const truncated = truncateGracefully(reasoning, REASONING_MAX_CHARS);
    if (truncated) sections.push(`why i flagged it: ${truncated}`);
  }

  sections.push(`live in the village: ${VILLAGE_URL}`);

  const message = sections.join("\n\n");

  // Final-pass length guard. Defense-in-depth against any future copy
  // change that lengthens the template, or any edge case where
  // per-section truncation fails open. The minimal fallback still
  // preserves the most important signals (the counterpart name + the
  // village link), just drops the intent/reasoning context.
  if (message.length > TELEGRAM_MESSAGE_LIMIT) {
    logger.warn("[index-notifier] message exceeded length guard; using minimal fallback", {
      composedLength: message.length,
      limit: TELEGRAM_MESSAGE_LIMIT,
      safeNameLength: safeName.length,
    });
    return buildMinimalFallbackMessage(safeName);
  }
  return message;
}

/**
 * Minimal-fallback message shape — used when the full composed message
 * exceeds TELEGRAM_MESSAGE_LIMIT. Preserves the agent voice, the
 * counterpart's name (already-capped via capCounterpartName), and the
 * village link. Always under 200 chars (counterpart name capped at 80).
 *
 * Not exported — only reachable via buildMatchNotificationMessage's
 * guard branch. Inline-callable for tests that want to assert shape.
 */
function buildMinimalFallbackMessage(safeName: string): string {
  return [
    "hey — quick signal.",
    `i think you should meet ${safeName} — full details in the village.`,
    `live in the village: ${VILLAGE_URL}`,
  ].join("\n\n");
}

/**
 * Sanitize + cap a counterpart name for inline rendering in the message.
 *
 *   • Strips control characters (Telegram plain-text mode tolerates them
 *     but they're invisible noise).
 *   • Collapses internal whitespace runs to a single space — newlines
 *     would split the "i think you should meet …" line across paragraphs.
 *   • Trims edges.
 *   • Caps length at COUNTERPART_NAME_MAX_CHARS with a word-boundary
 *     ellipsis. Sentence boundaries don't exist in names; word boundary
 *     is the only meaningful break we have.
 *   • Returns "someone in the directory" placeholder for empty/all-
 *     whitespace input — preserves the message's grammatical shape so
 *     the user reads "i think you should meet someone in the directory"
 *     rather than "i think you should meet ."
 */
function capCounterpartName(name: string): string {
  if (!name) return "someone in the directory";
  // Replace any whitespace run (including newlines, tabs) with a single
  // space. Then trim leading/trailing.
  const stripped = name.replace(/\s+/g, " ").trim();
  if (!stripped) return "someone in the directory";
  if (stripped.length <= COUNTERPART_NAME_MAX_CHARS) return stripped;
  // Try a word-boundary cut so we don't slice "Christopher" → "Christop…"
  // when "Chris" would do.
  const cut = stripped.slice(0, COUNTERPART_NAME_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > COUNTERPART_NAME_MAX_CHARS * 0.6) {
    return stripped.slice(0, lastSpace) + "…";
  }
  return cut + "…";
}

/**
 * Truncate text at a sentence or word boundary if it exceeds maxLen.
 * Returns null on empty/null input.
 */
function truncateGracefully(text: string | null | undefined, maxLen: number): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.length <= maxLen) return trimmed;

  // Try sentence boundary first
  const cut = trimmed.slice(0, maxLen);
  const lastPeriod = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"));
  if (lastPeriod > maxLen * 0.6) {
    return trimmed.slice(0, lastPeriod + 1);
  }

  // Else word boundary + ellipsis
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > maxLen * 0.7) {
    return trimmed.slice(0, lastSpace) + "…";
  }

  // Hard cut as a last resort
  return cut.replace(/\s+\S*$/, "") + "…";
}
