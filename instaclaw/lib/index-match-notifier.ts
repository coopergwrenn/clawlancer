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
        | "expired"
        | "malformed_payload";
    }
  | { status: "failed"; reason: string; detail?: string; httpStatus?: number };

/**
 * Known structured failure-reason codes that propagate up through the
 * `{ status: "failed", reason: string }` branch of NotifySideResult.
 * Telegram failures are classified into these so #7 (the structured
 * 403/429 retry handler) can discriminate without re-parsing strings.
 *
 * Operators / tests should reference these constants rather than
 * raw string literals to catch typos.
 */
export const NOTIFY_FAILURE_REASONS = {
  /** Telegram 403 — user blocked the bot. Terminal; should not retry. */
  TELEGRAM_BOT_BLOCKED: "telegram_403_bot_blocked",
  /** Telegram 400 — chat_id doesn't exist (user deleted account, etc.) */
  TELEGRAM_CHAT_NOT_FOUND: "telegram_400_chat_not_found",
  /** Telegram 429 — flood control. Retry with backoff per Retry-After. */
  TELEGRAM_RATE_LIMITED: "telegram_429_rate_limited",
  /** Telegram 5xx — server error. Retry once. */
  TELEGRAM_SERVER_ERROR: "telegram_5xx",
  /** Telegram other — uncategorized. Generic retry-once. */
  TELEGRAM_OTHER: "telegram_other",
  /** fetch threw before Telegram responded (DNS, TCP, TLS). Retryable. */
  TELEGRAM_TRANSPORT: "telegram_transport",
  /** Telegram returned non-JSON. Treat as terminal — suggests routing issue. */
  TELEGRAM_NON_JSON: "telegram_non_json",
  /** Delivered but couldn't update notified_*_at. Terminal-without-retry-protection. */
  DELIVERED_BUT_TRACKING_FAILED: "delivered_but_tracking_update_failed",
  /** matchpool_outcomes row missing on re-fetch. Indicates upstream issue. */
  OUTCOME_ROW_NOT_FOUND: "outcome_row_not_found",
  /** Generic notifier exception (caught by caller). */
  NOTIFIER_EXCEPTION: "notifier_exception",
} as const;
export type NotifyFailureReason =
  (typeof NOTIFY_FAILURE_REASONS)[keyof typeof NOTIFY_FAILURE_REASONS];

/**
 * Send notifications to BOTH matched users. Idempotent — running again
 * with the same outcome_id is safe (already-notified sides become a
 * no-op).
 */
export async function notifyIndexMatch(input: NotifyMatchInput): Promise<NotifyMatchResult> {
  const sb = getSupabase();

  // Malformed-payload guard (#4). Yanek's opportunity payload is
  // untrusted upstream data — Yanek could ship a schema change
  // overnight or fire a buggy webhook with missing fields. Defensive
  // shape-check BEFORE we try to do anything with the actors[] array.
  // Same posture as the expiry gate: short-circuit BOTH sides cheaply
  // (no DB query, no VM lookup, no Telegram call) and surface a clean
  // skip reason so the operator sees the cause in the tally.
  if (!input.opportunity || typeof input.opportunity !== "object") {
    logger.warn("[index-notifier] malformed payload — opportunity not an object", {
      outcomeId: input.outcomeId,
      opportunityType: typeof input.opportunity,
    });
    return {
      source: { status: "skipped", reason: "malformed_payload" },
      candidate: { status: "skipped", reason: "malformed_payload" },
    };
  }
  if (!Array.isArray(input.opportunity.actors)) {
    logger.warn("[index-notifier] malformed payload — actors is not an array", {
      outcomeId: input.outcomeId,
      opportunityId: input.opportunity.id,
      actorsType: typeof input.opportunity.actors,
    });
    return {
      source: { status: "skipped", reason: "malformed_payload" },
      candidate: { status: "skipped", reason: "malformed_payload" },
    };
  }
  if (input.opportunity.actors.length < 2) {
    logger.warn("[index-notifier] malformed payload — fewer than 2 actors", {
      outcomeId: input.outcomeId,
      opportunityId: input.opportunity.id,
      actorCount: input.opportunity.actors.length,
    });
    return {
      source: { status: "skipped", reason: "malformed_payload" },
      candidate: { status: "skipped", reason: "malformed_payload" },
    };
  }

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
      source: { status: "failed", reason: NOTIFY_FAILURE_REASONS.OUTCOME_ROW_NOT_FOUND },
      candidate: { status: "failed", reason: NOTIFY_FAILURE_REASONS.OUTCOME_ROW_NOT_FOUND },
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

  // ── Both-sides-missing-chat_id audit signal (#4) ──
  //
  // If BOTH users have no telegram_chat_id, the match is invisible —
  // neither will see the Telegram notification, and there's no
  // operator-facing signal unless we log one. Most likely cause: both
  // users signed up but neither has DM'd their bot yet (chat_id only
  // auto-populates on the first inbound message).
  //
  // For Edge Esmeralda launch day, this is the most common path to
  // "match recorded but nobody knows" — onboarding wave delivers users
  // who haven't tested their bot yet, then Yanek matches them, then
  // they have no idea anything happened.
  //
  // Surface a structured log line every time it occurs. An audit
  // script can grep these from Vercel logs OR a future cron can sweep
  // matchpool_outcomes for rows with both notified_*_at = NULL after
  // a grace window (the right long-term shape).
  const sourceSkippedNoChatId =
    sourceRes.status === "skipped" && sourceRes.reason === "missing_chat_id";
  const candidateSkippedNoChatId =
    candidateRes.status === "skipped" && candidateRes.reason === "missing_chat_id";
  if (sourceSkippedNoChatId && candidateSkippedNoChatId) {
    logger.warn("[index-notifier] BOTH sides missing chat_id — match invisible to both users", {
      outcomeId: input.outcomeId,
      opportunityId: input.opportunity.id,
      sourceUserIdPrefix: input.sourceUserId.slice(0, 8),
      candidateUserIdPrefix: input.candidateUserId.slice(0, 8),
      remediation:
        "users need to DM their bot at least once so chat_id auto-populates; retry will fire on next poller tick",
    });
  } else if (sourceSkippedNoChatId || candidateSkippedNoChatId) {
    // One side missing — less critical but still worth a softer signal
    // so the operator can see one-sided coverage gaps in the funnel.
    logger.info("[index-notifier] one side missing chat_id (other delivered or pending)", {
      outcomeId: input.outcomeId,
      opportunityId: input.opportunity.id,
      missingSide: sourceSkippedNoChatId ? "source" : "candidate",
    });
  }

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
  // Pass raw counterpart name through to the message-builder, which
  // applies capCounterpartName (handles empty/whitespace, literal-
  // garbage strings like "null"/"undefined", and length cap).
  const counterpartName = counterpartActor.name ?? "";

  const message = buildMatchNotificationMessage({
    counterpartName,
    counterpartIntent: counterpartActor.intent ?? null,
    reasoning: input.opportunity.interpretation?.reasoning ?? null,
  });

  // ── Optimistic claim BEFORE Telegram send (#13) ──
  //
  // The race we're closing: two concurrent ticks (manual + scheduled,
  // or two manual triggers) both observe notified_*_at = NULL, both
  // build a message, both call Telegram — the recipient gets the
  // SAME "i think you should meet X" twice. That destroys trust on
  // launch day worse than a missed match would.
  //
  // Pattern: atomic UPDATE … WHERE column IS NULL RETURNING.
  //   • If 1 row returned → we own the claim; send Telegram. Database
  //     state already reflects "delivered" optimistically; on Telegram
  //     success we leave it; on failure we revert via CAS.
  //   • If 0 rows returned → another tick claimed first. Skip Telegram
  //     entirely. Return already_notified so the tally treats this as
  //     a no-op tick (no counter increment).
  //
  // The CAS revert (UPDATE … WHERE column = <our exact timestamp>)
  // prevents a transient-Telegram-failure compensating revert from
  // clobbering a concurrent later tick's successful delivery.
  //
  // Trade-off: if Telegram delivers BUT our process crashes BEFORE we
  // return success, the column is already set; next tick skips. We
  // lose the "delivered" record but the user got the message. Worst
  // case: silent successful delivery → still better than the
  // duplicate-Telegram alternative.
  const claimedAt = new Date().toISOString();
  const { data: claimRows, error: claimErr } = await sb
    .from("matchpool_outcomes")
    .update({ [input.column]: claimedAt })
    .eq("outcome_id", input.outcomeId)
    .is(input.column, null)
    .select("outcome_id");
  if (claimErr) {
    logger.error("[index-notifier] claim UPDATE failed", {
      outcomeId: input.outcomeId,
      vm: recipientVm.name,
      column: input.column,
      error: claimErr.message,
    });
    return {
      status: "failed",
      reason: "claim_update_failed",
      detail: claimErr.message,
    };
  }
  if (!claimRows || claimRows.length === 0) {
    // Lost the race — another tick already claimed this side. Skip.
    logger.info("[index-notifier] claim lost to concurrent tick — Telegram not sent", {
      outcomeId: input.outcomeId,
      vm: recipientVm.name,
      column: input.column,
    });
    return { status: "already_notified" };
  }

  // We own the claim. Send Telegram (with #7 retry policy).
  const sendRes = await sendTelegramMessageWithRetry(
    recipientVm.telegram_bot_token as string,
    recipientVm.telegram_chat_id as string,
    message,
  );
  if (!sendRes.ok) {
    // Terminal-vs-retryable branch (#7). For terminal failures the
    // claim REMAINS SET — the lie is intentional: it stops the retry
    // loop on the next poller tick (which would otherwise re-send to
    // a chat that's blocked or doesn't exist, looping forever).
    //
    // For retryable failures (429/5xx/transport after the in-tick
    // retry exhausted), the claim is CAS-reverted so the next tick
    // can re-try. CAS on our exact claimedAt timestamp prevents
    // clobbering a concurrent claim that may have superseded ours.
    const isTerminal = shouldClaimRemainOnFailure(sendRes.error);
    if (isTerminal) {
      logger.warn("[index-notifier] telegram terminal failure; claim REMAINS SET (no retry)", {
        outcomeId: input.outcomeId,
        vm: recipientVm.name,
        error: sendRes.error,
        httpStatus: sendRes.httpStatus,
        detail: sendRes.detail,
        rationale:
          "claim acts as sentinel — leaving notified_*_at set stops the next-tick retry loop on a permanently-failing chat",
      });
    } else {
      logger.error("[index-notifier] telegram send failed; reverting claim for next-tick retry", {
        outcomeId: input.outcomeId,
        vm: recipientVm.name,
        error: sendRes.error,
        httpStatus: sendRes.httpStatus,
        claimedAt,
      });
      const { error: revertErr } = await sb
        .from("matchpool_outcomes")
        .update({ [input.column]: null })
        .eq("outcome_id", input.outcomeId)
        .eq(input.column, claimedAt);
      if (revertErr) {
        logger.error("[index-notifier] claim revert failed (claim remains set unintentionally)", {
          outcomeId: input.outcomeId,
          vm: recipientVm.name,
          column: input.column,
          revertError: revertErr.message,
        });
      }
    }
    return {
      status: "failed",
      reason: sendRes.error,
      detail: sendRes.detail,
      httpStatus: sendRes.httpStatus,
    };
  }

  // Telegram delivered + claim already set. We're done — no second
  // UPDATE needed (this is the win over the old read-modify-write
  // pattern that had the race window).

  logger.info("[index-notifier] delivered", {
    outcomeId: input.outcomeId,
    vm: recipientVm.name,
    counterpartName,
    column: input.column,
  });
  return { status: "delivered", deliveredAt: claimedAt };
}

// ── Telegram Bot API ────────────────────────────────────────────────

/** Shape returned by sendTelegramMessage on failure. */
export interface TelegramSendFailure {
  ok: false;
  error: string;
  httpStatus?: number;
  detail?: string;
  /** Parsed `parameters.retry_after` (seconds) from Telegram's 429
   *  response body, if present. Used by sendTelegramMessageWithRetry
   *  to honor Telegram's signaled backoff. */
  retryAfterSec?: number;
}

/** Shape returned by sendTelegramMessage on success. */
export interface TelegramSendSuccess {
  ok: true;
  messageId: number;
}

export type TelegramSendResult = TelegramSendSuccess | TelegramSendFailure;

async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
): Promise<TelegramSendResult> {
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
    return {
      ok: false,
      error: NOTIFY_FAILURE_REASONS.TELEGRAM_TRANSPORT,
      detail: msg.slice(0, 200),
    };
  }
  const body = await res.text();
  let parsed: {
    ok?: boolean;
    result?: { message_id?: number };
    description?: string;
    parameters?: { retry_after?: number };
  };
  try {
    parsed = JSON.parse(body);
  } catch {
    return {
      ok: false,
      error: NOTIFY_FAILURE_REASONS.TELEGRAM_NON_JSON,
      httpStatus: res.status,
      detail: body.slice(0, 200),
    };
  }
  if (!parsed.ok) {
    // Map known Telegram error shapes to structured reason codes (#4).
    // The retry / terminal-suppression decisions live in
    // sendTelegramMessageWithRetry + shouldClaimRemainOnFailure (#7);
    // here we just classify cleanly.
    //
    // Telegram error reference: https://core.telegram.org/api/errors
    //   • 403 "Forbidden: bot was blocked by the user" → terminal.
    //   • 403 "Forbidden: user is deactivated" → terminal.
    //   • 400 "Bad Request: chat not found" → terminal (user deleted
    //     account, or chat_id was wrong from the start).
    //   • 429 "Too Many Requests" with retry_after → retry-with-backoff.
    //   • 5xx → retry-once.
    //   • everything else → generic-other.
    const description = parsed.description?.toLowerCase() ?? "";
    let reason: string = NOTIFY_FAILURE_REASONS.TELEGRAM_OTHER;
    if (res.status === 403 || description.includes("blocked by the user") || description.includes("user is deactivated")) {
      reason = NOTIFY_FAILURE_REASONS.TELEGRAM_BOT_BLOCKED;
    } else if (
      (res.status === 400 && description.includes("chat not found")) ||
      description.includes("chat not found")
    ) {
      reason = NOTIFY_FAILURE_REASONS.TELEGRAM_CHAT_NOT_FOUND;
    } else if (res.status === 429) {
      reason = NOTIFY_FAILURE_REASONS.TELEGRAM_RATE_LIMITED;
    } else if (res.status >= 500 && res.status < 600) {
      reason = NOTIFY_FAILURE_REASONS.TELEGRAM_SERVER_ERROR;
    }
    // Extract retry_after from Telegram's parameters block (#7).
    // Telegram populates this on 429 to signal the wait time before
    // a retry will succeed. Parsed defensively — only accept positive
    // finite numbers.
    let retryAfterSec: number | undefined = undefined;
    const ra = parsed.parameters?.retry_after;
    if (typeof ra === "number" && Number.isFinite(ra) && ra > 0) {
      retryAfterSec = ra;
    }
    return {
      ok: false,
      error: reason,
      httpStatus: res.status,
      detail: parsed.description?.slice(0, 200) ?? body.slice(0, 200),
      retryAfterSec,
    };
  }
  return { ok: true, messageId: parsed.result?.message_id ?? 0 };
}

// ── Retry decision helpers (#7) ─────────────────────────────────────

/** Max intra-tick wait for any single retry attempt. Caps both the
 *  honored Retry-After value AND the 5xx fixed delay. Larger waits
 *  belong on the NEXT poller tick (1 min later); intra-tick budget
 *  is shared across all matches in the tick, so per-match latency
 *  must stay bounded. */
const TELEGRAM_RETRY_MAX_WAIT_MS = 3000;

/** Default wait for 5xx retry (Telegram doesn't signal retry_after
 *  on 5xx). Lower than the 429 cap because Telegram-side outages
 *  rarely resolve in <3s; the next tick will retry anyway. */
const TELEGRAM_5XX_RETRY_WAIT_MS = 1500;

/**
 * Pure helper: decide whether to retry a failed Telegram send and
 * how long to wait. Exported for unit-testing the decision logic
 * without needing a fetch mock.
 *
 * Retry policy:
 *   • TELEGRAM_RATE_LIMITED (429) → retry once, honor retry_after
 *     up to TELEGRAM_RETRY_MAX_WAIT_MS; fall back to default if
 *     retry_after is missing.
 *   • TELEGRAM_SERVER_ERROR (5xx) → retry once with fixed delay.
 *   • TELEGRAM_TRANSPORT (fetch threw) → retry once with fixed
 *     delay. Could be a transient DNS / TLS / TCP blip.
 *   • Everything else → no retry. 403/400 are terminal (handled by
 *     shouldClaimRemainOnFailure); other classes will retry on the
 *     next poller tick anyway.
 *
 * The retry budget is ONE attempt total (so `attempt === 2` always
 * returns no-retry). This keeps per-match latency bounded.
 */
export function decideTelegramRetry(
  failure: { error: string; retryAfterSec?: number },
  attempt: number,
): { retry: boolean; waitMs: number; reason: "rate_limited" | "server_error" | "transport" | "no_retry" } {
  if (attempt >= 2) {
    return { retry: false, waitMs: 0, reason: "no_retry" };
  }
  if (failure.error === NOTIFY_FAILURE_REASONS.TELEGRAM_RATE_LIMITED) {
    const requestedMs = failure.retryAfterSec ? failure.retryAfterSec * 1000 : TELEGRAM_5XX_RETRY_WAIT_MS;
    return {
      retry: true,
      waitMs: Math.min(requestedMs, TELEGRAM_RETRY_MAX_WAIT_MS),
      reason: "rate_limited",
    };
  }
  if (failure.error === NOTIFY_FAILURE_REASONS.TELEGRAM_SERVER_ERROR) {
    return {
      retry: true,
      waitMs: TELEGRAM_5XX_RETRY_WAIT_MS,
      reason: "server_error",
    };
  }
  if (failure.error === NOTIFY_FAILURE_REASONS.TELEGRAM_TRANSPORT) {
    return {
      retry: true,
      waitMs: TELEGRAM_5XX_RETRY_WAIT_MS,
      reason: "transport",
    };
  }
  return { retry: false, waitMs: 0, reason: "no_retry" };
}

/**
 * Pure helper: decide whether the optimistic claim (notified_*_at)
 * should REMAIN SET after a failed Telegram send. Exported for unit
 * testing.
 *
 * Terminal failures → claim remains set (stops the retry loop):
 *   • TELEGRAM_BOT_BLOCKED — user blocked our bot; further sends will
 *     fail identically until the user un-blocks. No point retrying.
 *   • TELEGRAM_CHAT_NOT_FOUND — chat_id no longer exists (user
 *     deleted account, etc.). Permanent.
 *
 * Non-terminal failures → claim should be REVERTED (next tick retries):
 *   • TELEGRAM_RATE_LIMITED — Telegram-side throttle; will release.
 *   • TELEGRAM_SERVER_ERROR — Telegram outage; will recover.
 *   • TELEGRAM_TRANSPORT — fetch threw; transient.
 *   • TELEGRAM_NON_JSON — reclassified retryable on 2026-05-19 (audit
 *     P1 7b). Most non-JSON responses during a Telegram outage are
 *     transient HTML pages (Cloudflare 502 error page, DDoS challenge,
 *     maintenance) — treating them as terminal would permanently
 *     suppress retries to affected users during a brief outage. Wrong-
 *     domain routing bugs (the OTHER non-JSON cause) would re-trigger
 *     on the next tick and would eventually surface via the 6h
 *     high-failure-rate alert anyway. Net: retryable is the safer
 *     default; the cost is at most one duplicate-message-on-recovery
 *     edge case (negligible vs permanently dropping a real notification).
 *   • TELEGRAM_OTHER — uncategorized; conservatively retry.
 */
export function shouldClaimRemainOnFailure(reason: string): boolean {
  return (
    reason === NOTIFY_FAILURE_REASONS.TELEGRAM_BOT_BLOCKED ||
    reason === NOTIFY_FAILURE_REASONS.TELEGRAM_CHAT_NOT_FOUND
  );
}

/**
 * Wrapper around sendTelegramMessage that applies the #7 retry policy
 * (decideTelegramRetry). One additional attempt at most; bounded wait.
 *
 * Successful sends return immediately (no retry). Failed sends return
 * the LAST attempt's failure (so the caller sees the most-recent
 * Telegram response, not the first one).
 */
async function sendTelegramMessageWithRetry(
  botToken: string,
  chatId: string,
  text: string,
): Promise<TelegramSendResult> {
  let lastFailure: TelegramSendFailure | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await sendTelegramMessage(botToken, chatId, text);
    if (res.ok) return res;
    const decision = decideTelegramRetry(res, attempt);
    if (!decision.retry) return res;
    lastFailure = res;
    logger.info("[index-notifier] telegram retry scheduled", {
      attempt,
      reason: decision.reason,
      waitMs: decision.waitMs,
      retryAfterSec: res.retryAfterSec,
      httpStatus: res.httpStatus,
    });
    await new Promise((r) => setTimeout(r, decision.waitMs));
  }
  // Unreachable in practice — the loop returns inside its body either
  // on ok=true OR when decision.retry=false. TypeScript needs the
  // fallback for control-flow analysis.
  return lastFailure ?? {
    ok: false,
    error: NOTIFY_FAILURE_REASONS.TELEGRAM_OTHER,
    detail: "retry loop exited unexpectedly",
  };
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
/**
 * Sanitize + cap a counterpart name for inline rendering in the message.
 * Single chokepoint — handles whitespace normalization, literal-garbage
 * fallback (#4), and the length cap. Both notifyOneSide and direct
 * callers of buildMatchNotificationMessage go through this path.
 *
 *   1. Empty / null / undefined → "someone in the directory".
 *   2. Whitespace-only (incl. newlines, tabs) → same placeholder.
 *      Whitespace runs are also collapsed to a single space so that
 *      "Carter\n\nCleveland" renders as "Carter Cleveland" instead of
 *      splitting the message across paragraphs.
 *   3. Literal-garbage strings ("null", "undefined", "(unknown)",
 *      "n/a", etc., case-insensitive) → placeholder. These suggest
 *      upstream profile-lookup failure serialized as text by Yanek
 *      (or any future partner). Without this, the message would read
 *      "i think you should meet null." — visible upstream-bug
 *      propagation.
 *   4. Length cap at COUNTERPART_NAME_MAX_CHARS with a word-boundary
 *      ellipsis. Sentence boundaries don't exist in names; word
 *      boundary is the only meaningful break.
 *
 * Logs a structured warning on garbage detection so the operator sees
 * the pattern in Vercel logs and can chase the upstream root cause.
 */
function capCounterpartName(name: string): string {
  if (!name) return "someone in the directory";
  // Collapse internal whitespace runs (incl. newlines, tabs) + trim
  const normalized = name.replace(/\s+/g, " ").trim();
  if (!normalized) return "someone in the directory";
  // Literal-garbage detection (#4).
  const lc = normalized.toLowerCase();
  if (
    lc === "null" ||
    lc === "undefined" ||
    lc === "(unknown)" ||
    lc === "unknown" ||
    lc === "n/a" ||
    lc === "none"
  ) {
    logger.warn("[index-notifier] sanitized counterpart name (literal-garbage)", {
      raw: normalized.slice(0, 40),
    });
    return "someone in the directory";
  }
  // Length cap with word-boundary ellipsis.
  if (normalized.length <= COUNTERPART_NAME_MAX_CHARS) return normalized;
  const cut = normalized.slice(0, COUNTERPART_NAME_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > COUNTERPART_NAME_MAX_CHARS * 0.6) {
    return normalized.slice(0, lastSpace) + "…";
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
