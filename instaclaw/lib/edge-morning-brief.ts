/**
 * Morning brief — the daily Telegram message every Edge Esmeralda attendee
 * receives at 9 AM Pacific. This is the agent's primary touchpoint with
 * the human across the 28-day village. Per the master PRD §E2: "every
 * attendee sees this message every morning for 28 days."
 *
 * The voice is intentional and aligns with /edge/claim and
 * lib/index-match-notifier: lowercase comfortable, declarative,
 * agent-first-person, no exclamation marks. The agent itself is the
 * speaker — "morning.", "i found 3 overlaps overnight", "reply with a
 * name and i'll coordinate." Not a newsletter. Not a marketing push.
 * A note from your agent before you reach for the coffee.
 *
 * Three content shapes — adaptive on the data the gather step found:
 *
 *   RICH  — matches > 0. List up to 3 with the agent's reasoning.
 *   THIN  — no overnight matches but the user has an intent on file.
 *           Soft re-prompt for specificity.
 *   LEAN  — no intent on file (only reachable via /edge/intents's
 *           service-degraded escape hatch). Direct ask to add one.
 *
 * NOT in V1 (architected for, blocked on cross-terminal work):
 *
 *   • EdgeOS events for today (PRD §E2 spec): the Consensus terminal
 *     owns D3 — they're populating instaclaw_vms.edgeos_api_key from
 *     the configureOpenClaw flow but the column is mostly NULL today.
 *     gatherBriefData accepts an optional `events` array so the
 *     moment the population path ships, we wire a single call here.
 *
 * Send mechanism: direct via the VM's bot token + telegram_chat_id,
 * reusing sendTelegramMessage from lib/index-match-notifier. Same
 * categorized failure-mode surface (chat_not_found, bot_blocked,
 * rate_limited, server_error). chat_id auto-populates the first time
 * a user DMs their bot — users who haven't yet are skipped silently
 * (the next-day brief tries again).
 *
 * Defensive skips (no send, no error, just structured logging):
 *
 *   - VM not assigned or not healthy
 *   - VM has no telegram_chat_id (chat_id auto-populates eventually)
 *   - VM has no telegram_bot_token (shouldn't happen — Rule 34)
 *   - Today is outside the village window (May 30 → Jun 27, 2026)
 *
 * Operator escape hatch: pass `dryRun: true` to sendBriefToUser to get
 * the composed text back without actually pushing to Telegram. Used by
 * scripts/_test-edge-morning-brief.ts.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "./logger";
import {
  sendTelegramMessage,
  type TelegramSendResult,
} from "./index-match-notifier";
import { fetchUserMatchHistory, type CounterpartMatch } from "./edge-dashboard-data";

// ── Constants ───────────────────────────────────────────────────────────

const DASHBOARD_URL = "https://instaclaw.io/edge/dashboard";

/** 9 AM PT = 16:00 UTC during PDT. The cron schedule encodes this; we
 *  carry it as a Pacific-local string for day-of-week derivation. */
const VILLAGE_TIMEZONE = "America/Los_Angeles";

/** Edge Esmeralda 2026 window (inclusive). Defensive — the cron should
 *  also be deregistered after Jun 27, but until then this prevents
 *  stragglers from receiving briefs into July. */
const VILLAGE_START = new Date("2026-05-30T00:00:00-07:00");
const VILLAGE_END = new Date("2026-06-28T00:00:00-07:00"); // exclusive

/** Cap match lines so a single brief stays scannable + within Telegram's
 *  4096-char limit. 3 is the sweet spot — enough to feel curated,
 *  little enough to actually read in the first 10 seconds of the day. */
const MAX_MATCHES_IN_BRIEF = 3;

/** Per-match reason text cap (the agent's why-i-flagged-this string from
 *  matchpool_outcomes.reason_text). Anything beyond is truncated with an
 *  ellipsis on a word boundary. */
const REASON_MAX_CHARS = 140;

/** Last-resort message length guard. Telegram allows 4096 but we want to
 *  catch any composition path that runs away. Briefs that exceed this
 *  fall through to the minimal-fallback shape. */
const BRIEF_LENGTH_LIMIT = 2000;

/** Lookback window for "overnight" matches. Anything created within this
 *  window from `now` is included. 24h matches the daily-brief rhythm —
 *  yesterday morning's brief covered the prior 24h, today's covers since
 *  then, no overlap and no gaps. */
const OVERNIGHT_LOOKBACK_HOURS = 24;

// ── Public types ────────────────────────────────────────────────────────

export interface BriefData {
  /** Pacific-local day-of-week string, lowercase. e.g. "tuesday". */
  dayLabel: string;
  /** The user's current intent description, if any. Surface for the
   *  LEAN-state copy that nudges them to add one. */
  hasIntent: boolean;
  /** Matches created in the last OVERNIGHT_LOOKBACK_HOURS, oldest-first
   *  in the brief listing (most recent appears LAST so it lands strongest
   *  in the reader's memory). Capped at MAX_MATCHES_IN_BRIEF when
   *  composed; extras surface as "+N more". */
  overnightMatches: CounterpartMatch[];
}

export interface ComposedBrief {
  text: string;
  shape: "rich" | "thin" | "lean";
  /** For telemetry — the cron route logs these so we can grep failure
   *  modes (e.g., a sudden dip in "rich" briefs = matching is broken). */
  metadata: {
    numOvernightMatches: number;
    truncatedMatches: number;
    lengthChars: number;
    hasIntent: boolean;
  };
}

export type SendBriefResult =
  | {
      sent: true;
      shape: ComposedBrief["shape"];
      messageId: number;
      lengthChars: number;
    }
  | {
      sent: false;
      reason:
        | "outside_village_window"
        | "vm_not_assigned"
        | "vm_unhealthy"
        | "missing_chat_id"
        | "missing_bot_token"
        | "user_not_edge"
        | "telegram_error"
        | "db_error"
        | "exception"
        | "dry_run";
      detail?: string;
      composedText?: string;
      shape?: ComposedBrief["shape"];
    };

// ── Pure helpers ────────────────────────────────────────────────────────

/**
 * Compute the lowercase day-of-week label in Pacific time. The cron fires
 * at 16:00 UTC = 9 AM Pacific during PDT — but during the small PDT/PST
 * crossover window (none during May 30 → Jun 27, but defensive) we still
 * want the day name to reflect what the attendee sees on their phone.
 */
export function pacificDayLabel(now: Date): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: VILLAGE_TIMEZONE,
  });
  return formatter.format(now).toLowerCase();
}

/**
 * Is `now` within [VILLAGE_START, VILLAGE_END)? Used to short-circuit
 * the cron after the village ends.
 */
export function isWithinVillageWindow(now: Date): boolean {
  return now >= VILLAGE_START && now < VILLAGE_END;
}

/**
 * Truncate `text` to `maxChars` on a word boundary with a soft ellipsis.
 * Returns null/empty for null/empty input — caller decides whether to
 * include the section at all.
 */
export function truncateOnWord(
  text: string | null | undefined,
  maxChars: number,
): string {
  if (!text) return "";
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const slice = trimmed.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > maxChars * 0.6) {
    return slice.slice(0, lastSpace) + "…";
  }
  // No clean word boundary in the visible window — fall back to hard cap.
  return slice + "…";
}

/**
 * Sanitize a counterpart name for inline rendering. Mirrors the
 * capCounterpartName logic in lib/index-match-notifier — collapse
 * whitespace, strip control chars, fall back to a placeholder for
 * empty/literal-garbage. The morning brief renders names plain (no
 * formatting), so we don't escape Markdown.
 */
export function sanitizeName(raw: string | null | undefined): string {
  if (!raw) return "someone in the directory";
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return "someone in the directory";
  const literalGarbage = new Set(["null", "undefined", "(unknown)", "n/a", "none"]);
  if (literalGarbage.has(collapsed.toLowerCase())) return "someone in the directory";
  // Cap at 80 chars for inline rendering.
  return collapsed.length <= 80 ? collapsed : truncateOnWord(collapsed, 80);
}

/**
 * Compose the brief text from gathered data. Pure — no I/O. The shape
 * branches on `overnightMatches.length` and `hasIntent`:
 *
 *   RICH (overnightMatches > 0): list up to 3, agent's reasoning inline.
 *   THIN (overnightMatches == 0 && hasIntent): soft re-prompt for
 *     specificity, no list.
 *   LEAN (!hasIntent — service-degraded escape only): ask for an intent.
 */
export function composeBrief(data: BriefData): ComposedBrief {
  const { dayLabel, hasIntent, overnightMatches } = data;
  const numMatches = overnightMatches.length;

  // ── LEAN shape: no intent on file ─────────────────────────────
  if (!hasIntent) {
    const text = [
      `morning. ${dayLabel}.`,
      "",
      "i don't have an intent on file yet — that's how i know which overlaps to surface. tell me what you're here for and i'll start working.",
      "",
      `dashboard: ${DASHBOARD_URL}`,
    ].join("\n");
    return {
      text,
      shape: "lean",
      metadata: {
        numOvernightMatches: 0,
        truncatedMatches: 0,
        lengthChars: text.length,
        hasIntent: false,
      },
    };
  }

  // ── THIN shape: intent on file, zero new matches ──────────────
  if (numMatches === 0) {
    const text = [
      `morning. ${dayLabel}.`,
      "",
      "no new overlaps overnight — still listening. if you want me to tighten the focus, just tell me what kind of person you'd most want to meet.",
      "",
      `dashboard: ${DASHBOARD_URL}`,
    ].join("\n");
    return {
      text,
      shape: "thin",
      metadata: {
        numOvernightMatches: 0,
        truncatedMatches: 0,
        lengthChars: text.length,
        hasIntent: true,
      },
    };
  }

  // ── RICH shape: 1+ matches ────────────────────────────────────
  const shown = overnightMatches.slice(0, MAX_MATCHES_IN_BRIEF);
  const truncatedCount = Math.max(0, numMatches - MAX_MATCHES_IN_BRIEF);

  const matchLines = shown.map((m) => {
    const name = sanitizeName(m.counterpartName);
    const reason = truncateOnWord(m.reasonText, REASON_MAX_CHARS);
    return reason ? `— ${name}: ${reason}` : `— ${name}`;
  });

  const countPhrase =
    numMatches === 1
      ? "i found 1 overlap for you overnight"
      : `i found ${numMatches} overlaps for you overnight`;

  const sections: string[] = [
    `morning. ${dayLabel}.`,
    "",
    `${countPhrase}${truncatedCount > 0 ? ` — top ${MAX_MATCHES_IN_BRIEF}` : ""}:`,
    "",
    ...matchLines,
  ];
  if (truncatedCount > 0) {
    sections.push("");
    sections.push(`+ ${truncatedCount} more in your dashboard.`);
  }
  sections.push("");
  sections.push("reply with a name and i'll coordinate the intro.");
  sections.push("");
  sections.push(`dashboard: ${DASHBOARD_URL}`);

  let text = sections.join("\n");

  // Final-pass length guard — defense-in-depth for any future reason_text
  // length surge. Falls back to the minimal shape (names only, no reasons).
  if (text.length > BRIEF_LENGTH_LIMIT) {
    logger.warn("[edge-morning-brief] length over guard; falling back to minimal", {
      composedLength: text.length,
      limit: BRIEF_LENGTH_LIMIT,
      numMatches,
    });
    const minimalLines = shown.map((m) => `— ${sanitizeName(m.counterpartName)}`);
    text = [
      `morning. ${dayLabel}.`,
      "",
      `${countPhrase}:`,
      "",
      ...minimalLines,
      truncatedCount > 0 ? `\n+ ${truncatedCount} more in your dashboard.` : "",
      "",
      "reply with a name and i'll coordinate the intro.",
      "",
      `dashboard: ${DASHBOARD_URL}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  return {
    text,
    shape: "rich",
    metadata: {
      numOvernightMatches: numMatches,
      truncatedMatches: truncatedCount,
      lengthChars: text.length,
      hasIntent: true,
    },
  };
}

// ── Server-side gatherer ───────────────────────────────────────────────

/**
 * Pull the data the brief needs in two DB hits:
 *
 *   1. instaclaw_users — partner check + intent presence
 *      (index_last_intent_at NOT NULL = has expressed an intent)
 *   2. matchpool_outcomes via fetchUserMatchHistory — filtered to
 *      OVERNIGHT_LOOKBACK_HOURS via the createdAt field
 *
 * Does NOT fetch EdgeOS events — that's gated on D3 (Consensus terminal
 * owns) and intentionally left out of V1. When the column population
 * path ships, add the events fetch here and update composeBrief to
 * include them in the RICH/THIN shapes.
 */
export async function gatherBriefData(
  supabase: SupabaseClient,
  userId: string,
  now: Date,
): Promise<BriefData | null> {
  // 1. User row — partner + intent presence
  const { data: user, error: userErr } = await supabase
    .from("instaclaw_users")
    .select("partner, index_last_intent_at")
    .eq("id", userId)
    .maybeSingle();
  if (userErr) {
    logger.warn("[edge-morning-brief] user fetch failed", {
      userIdPrefix: userId.slice(0, 8),
      error: userErr.message,
    });
    return null;
  }
  if (!user || user.partner !== "edge_city") return null;

  // 2. Match history → filter to overnight window
  const allMatches = await fetchUserMatchHistory(userId);
  const cutoff = new Date(
    now.getTime() - OVERNIGHT_LOOKBACK_HOURS * 60 * 60 * 1000,
  );
  const overnightMatches = allMatches.filter((m) => {
    const created = new Date(m.createdAt);
    return Number.isFinite(created.getTime()) && created > cutoff;
  });

  return {
    dayLabel: pacificDayLabel(now),
    hasIntent: user.index_last_intent_at !== null,
    overnightMatches,
  };
}

// ── Top-level orchestrator ──────────────────────────────────────────────

/**
 * Compose and send the morning brief for a single user. The cron route
 * fans out to this in parallel (Promise.allSettled with concurrency cap).
 *
 * Skip reasons (returned with `sent: false`) are NOT errors — they're
 * structured outcomes that the cron logs but doesn't alert on. The only
 * alerting condition is `telegram_error` from a non-terminal Telegram
 * failure (rate_limited, 5xx), which the cron escalates if it sees a
 * fleet-wide pattern.
 */
export async function sendBriefToUser(
  supabase: SupabaseClient,
  userId: string,
  options: { dryRun?: boolean; now?: Date } = {},
): Promise<SendBriefResult> {
  const now = options.now ?? new Date();

  // ── Pre-flight: village window ──────────────────────────────────
  if (!isWithinVillageWindow(now)) {
    return { sent: false, reason: "outside_village_window" };
  }

  // ── 1. Find the user's assigned VM — need bot token + chat_id + health ──
  // Using .select("*") per Rule 19 — safety-critical read; we don't want
  // PostgREST silently dropping a column we expect.
  const { data: vmRows, error: vmErr } = await supabase
    .from("instaclaw_vms")
    .select("*")
    .eq("assigned_to", userId)
    .eq("partner", "edge_city")
    .eq("status", "assigned")
    .order("created_at", { ascending: false })
    .limit(1);
  if (vmErr) {
    return { sent: false, reason: "db_error", detail: vmErr.message };
  }
  const vm = vmRows?.[0];
  if (!vm) return { sent: false, reason: "vm_not_assigned" };

  // Health gate: hibernating + suspended are operationally identical to
  // "running but stopped gateway" — the agent can still receive a Telegram
  // message via direct API (we're bypassing the gateway). But unhealthy
  // VMs (configure_failed, frozen, etc.) shouldn't speak — a broken agent
  // sending a daily brief is more confusing than no brief.
  const healthOk = ["healthy", "hibernating", "suspended"].includes(
    String(vm.health_status ?? ""),
  );
  if (!healthOk) return { sent: false, reason: "vm_unhealthy", detail: String(vm.health_status) };

  const botToken = vm.telegram_bot_token as string | null;
  const chatId = vm.telegram_chat_id as string | null;
  if (!botToken) return { sent: false, reason: "missing_bot_token" };
  if (!chatId) {
    // Same soft-fail as index-match-notifier — chat_id auto-populates
    // when the user first DMs their bot. Skip today, retry tomorrow.
    return { sent: false, reason: "missing_chat_id" };
  }

  // ── 2. Gather + compose ─────────────────────────────────────────
  const data = await gatherBriefData(supabase, userId, now);
  if (!data) return { sent: false, reason: "user_not_edge" };

  const composed = composeBrief(data);

  // ── 3. Dry-run short-circuit ────────────────────────────────────
  if (options.dryRun) {
    return {
      sent: false,
      reason: "dry_run",
      composedText: composed.text,
      shape: composed.shape,
    };
  }

  // ── 4. Send via Telegram ────────────────────────────────────────
  let result: TelegramSendResult;
  try {
    result = await sendTelegramMessage(botToken, chatId, composed.text);
  } catch (err) {
    return {
      sent: false,
      reason: "exception",
      detail: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    };
  }

  if (!result.ok) {
    return {
      sent: false,
      reason: "telegram_error",
      detail: `${result.error}${result.detail ? `: ${result.detail.slice(0, 100)}` : ""}`,
      shape: composed.shape,
    };
  }

  logger.info("[edge-morning-brief] sent", {
    userIdPrefix: userId.slice(0, 8),
    shape: composed.shape,
    numMatches: composed.metadata.numOvernightMatches,
    lengthChars: composed.metadata.lengthChars,
    messageId: result.messageId,
  });

  return {
    sent: true,
    shape: composed.shape,
    messageId: result.messageId,
    lengthChars: composed.metadata.lengthChars,
  };
}
