/**
 * SSR fetchers for /edge/dashboard's match-history + current-intent
 * sections. Pure server-side — runs in the Next.js page.tsx render
 * pass and passes data as props to the client dashboard.
 *
 * Two surfaces:
 *
 *   1. fetchUserMatchHistory(userId) — pulls the user's last 20
 *      matchpool_outcomes rows (engine='index'), resolves counterpart
 *      names from instaclaw_users in a single bulk query, returns a
 *      ready-to-render shape with bidirectional source/candidate
 *      mirroring already applied (so the consumer doesn't have to
 *      figure out "am I the source or the candidate" — it's already
 *      flipped to "here's the OTHER person").
 *
 *   2. fetchUserCurrentIntent(userId, apiKey) — calls Yanek's
 *      read_intents MCP tool for the current user, parses the SSE-
 *      wrapped response, returns the most-recent intent or null.
 *      Fails gracefully — Yanek's endpoint being down does NOT
 *      crash the dashboard.
 *
 * Pure helpers exported for unit testing:
 *   • cleanReasonText
 *   • pickConfidence
 *   • formatRelativeTime
 *   • resolveCounterpart
 */
import { getSupabase } from "@/lib/supabase";
import { callIndexMcpTool } from "@/lib/index-mcp-client";
import { logger } from "@/lib/logger";

// ── Types (exported — used by the component as prop types) ──────────

export interface CounterpartMatch {
  outcomeId: string;
  /** The OTHER user's id (already flipped by resolveCounterpart). */
  counterpartUserId: string;
  /** instaclaw_users.name for the counterpart, or "Anonymous" fallback. */
  counterpartName: string;
  /** Cleaned reasoning text (marker prefix stripped). null if absent. */
  reasonText: string | null;
  /** Confidence score in 0-1, picked from the best-available column. */
  scoreConfidence: number | null;
  /** ISO timestamp of the match record creation. */
  createdAt: string;
  /** True if the current user is the source; false if they're the candidate. */
  iAmSource: boolean;
}

export interface CurrentIntent {
  description: string;
  intentId: string | null;
  createdAt: string | null;
}

// ── Pure helpers (exported for unit testing) ────────────────────────

/**
 * Strip the "[index:poller] opportunity=<id> — " marker prefix that
 * `lib/index-match-recorder.ts` prepends to reason_text. The user
 * shouldn't see internal opportunity IDs.
 *
 * If the cleaned suffix is empty (no reasoning was supplied by Yanek
 * at record time), return null so the component can omit the section.
 */
export function cleanReasonText(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // \s*(.*?)\s*$ allows the suffix to be empty/whitespace — that's a
  // recorder case where Yanek didn't supply reasoning. We want null
  // returned then, not the marker-prefix garbage.
  const match = raw.match(/^\[index:[^\]]+\]\s+opportunity=[^\s]+\s+—\s*(.*?)\s*$/);
  const cleaned = (match ? match[1] : raw).trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Pick the best-available confidence score from the matchpool_outcomes
 * row. Priority: deliberation > mutual > rrf. Returns null if none are
 * present (Yanek doesn't always populate all three).
 */
export function pickConfidence(row: {
  deliberation_score?: number | null;
  mutual_score?: number | null;
  rrf_score?: number | null;
}): number | null {
  const candidates = [row.deliberation_score, row.mutual_score, row.rrf_score];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
  }
  return null;
}

/**
 * Render a Date as a relative-time string for the UI ("2h ago",
 * "yesterday", "Mar 15"). Falls back to absolute date for entries
 * older than 7 days.
 *
 * Clock-skew-safe — computes delta from Date.now() at render time.
 */
export function formatRelativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 2 * 86_400_000) return "yesterday";
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Given a matchpool_outcomes row and the current user's id, return
 * the COUNTERPART's user_id (the other side of the match) plus an
 * iAmSource flag. The notifier uses this same bidirectional pattern
 * (notifyOneSide is called twice with flipped recipient/counterpart);
 * matching it keeps the mental model consistent.
 *
 * If neither id matches, defaults to source (defensive — won't crash;
 * just produces a slightly-wrong card).
 */
export function resolveCounterpart(
  row: { source_user_id: string; candidate_user_id: string },
  currentUserId: string,
): { counterpartUserId: string; iAmSource: boolean } {
  if (row.source_user_id === currentUserId) {
    return { counterpartUserId: row.candidate_user_id, iAmSource: true };
  }
  return { counterpartUserId: row.source_user_id, iAmSource: false };
}

// ── Server-side fetchers ─────────────────────────────────────────────

/**
 * Fetch the user's last 20 Index matches with counterpart names
 * resolved. Two-step:
 *
 *   1. SELECT from matchpool_outcomes WHERE I'm source or candidate
 *   2. Bulk SELECT from instaclaw_users to resolve all counterpart names
 *      in one round-trip.
 *
 * Returns [] on error or empty result. The dashboard's empty state
 * handles "no matches yet" gracefully.
 */
export async function fetchUserMatchHistory(userId: string): Promise<CounterpartMatch[]> {
  const sb = getSupabase();
  // PostgREST .or() — composed with the .eq("match_engine") AND'd at
  // the top level so the WHERE clause is:
  //   (source = $1 OR candidate = $1) AND match_engine = 'index'
  const { data: rows, error } = await sb
    .from("matchpool_outcomes")
    .select("outcome_id, source_user_id, candidate_user_id, reason_text, deliberation_score, mutual_score, rrf_score, created_at")
    .or(`source_user_id.eq.${userId},candidate_user_id.eq.${userId}`)
    .eq("match_engine", "index")
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    logger.warn("[edge-dashboard-data] match fetch failed", {
      userIdPrefix: userId.slice(0, 8),
      error: error.message,
    });
    return [];
  }
  if (!rows || rows.length === 0) return [];

  // Bulk-resolve counterpart names in ONE query
  const counterpartIds = Array.from(
    new Set(
      rows.map(
        (r) =>
          resolveCounterpart(
            {
              source_user_id: r.source_user_id as string,
              candidate_user_id: r.candidate_user_id as string,
            },
            userId,
          ).counterpartUserId,
      ),
    ),
  );

  const { data: users } = await sb
    .from("instaclaw_users")
    .select("id, name")
    .in("id", counterpartIds);
  const nameMap = new Map<string, string>(
    (users ?? []).map((u) => [u.id as string, (u.name as string | null) ?? "Anonymous"]),
  );

  return rows.map((r) => {
    const { counterpartUserId, iAmSource } = resolveCounterpart(
      {
        source_user_id: r.source_user_id as string,
        candidate_user_id: r.candidate_user_id as string,
      },
      userId,
    );
    return {
      outcomeId: r.outcome_id as string,
      counterpartUserId,
      counterpartName: nameMap.get(counterpartUserId) ?? "Anonymous",
      reasonText: cleanReasonText(r.reason_text as string | null),
      scoreConfidence: pickConfidence({
        deliberation_score: r.deliberation_score as number | null,
        mutual_score: r.mutual_score as number | null,
        rrf_score: r.rrf_score as number | null,
      }),
      createdAt: r.created_at as string,
      iAmSource,
    };
  });
}

/**
 * Fetch the user's most-recent Index intent via the read_intents MCP
 * tool. Returns null on any failure — the dashboard gracefully omits
 * the section if Yanek's endpoint is down OR if the user hasn't
 * submitted yet.
 *
 * MCP response shape (per Yanek 2026-05-20 probe):
 *   {success: true, data: {count: N, intents: [...], message: "..."}}
 * intents[].description is the canonical field. createdAt for sorting.
 */
export async function fetchUserCurrentIntent(
  userId: string,
  apiKey: string | null,
): Promise<CurrentIntent | null> {
  if (!apiKey) return null;

  let res;
  try {
    res = await callIndexMcpTool({
      apiKey,
      toolName: "read_intents",
      toolArgs: {},
    });
  } catch (err) {
    logger.warn("[edge-dashboard-data] read_intents threw", {
      userIdPrefix: userId.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  if (!res.ok) {
    logger.warn("[edge-dashboard-data] read_intents not ok", {
      userIdPrefix: userId.slice(0, 8),
      error: res.error,
    });
    return null;
  }

  // MCP response is text-wrapped JSON inside content array
  const result = res.result as { content?: Array<{ type?: string; text?: string }> } | null;
  const text = result?.content?.find((c) => c.type === "text")?.text ?? "";
  if (!text) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    logger.warn("[edge-dashboard-data] read_intents non-json response", {
      userIdPrefix: userId.slice(0, 8),
      textPreview: text.slice(0, 200),
    });
    return null;
  }

  return parseIntentResponse(parsed);
}

/**
 * Pure helper: parse Yanek's read_intents JSON response → CurrentIntent
 * shape. Exported for unit testing without an MCP roundtrip.
 *
 * Defensive — every field is shape-checked. Unknown formats return null.
 */
export function parseIntentResponse(parsed: unknown): CurrentIntent | null {
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (p.success !== true) return null;
  const data = p.data as Record<string, unknown> | undefined;
  if (!data) return null;
  const intents = data.intents;
  if (!Array.isArray(intents) || intents.length === 0) return null;

  // Sort by createdAt desc (newest first) — pick the latest.
  // Defensive sort: if createdAt missing, treat as epoch=0.
  const sorted = [...intents].sort((a, b) => {
    const ta = a && typeof a === "object" && "createdAt" in a
      ? new Date((a as Record<string, unknown>).createdAt as string).getTime()
      : 0;
    const tb = b && typeof b === "object" && "createdAt" in b
      ? new Date((b as Record<string, unknown>).createdAt as string).getTime()
      : 0;
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  });
  const latest = sorted[0];
  if (!latest || typeof latest !== "object") return null;
  const l = latest as Record<string, unknown>;
  const description = typeof l.description === "string" ? l.description : null;
  if (!description) return null;

  return {
    description,
    intentId: typeof l.id === "string" ? l.id : null,
    createdAt: typeof l.createdAt === "string" ? l.createdAt : null,
  };
}
