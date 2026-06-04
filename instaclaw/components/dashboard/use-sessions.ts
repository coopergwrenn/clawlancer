"use client";

/**
 * useSessions — the data layer for the sidebar Sessions index.
 *
 * Merges the two Command Center entity lists (web Chat conversations + Tasks)
 * into one recency-sorted list of `SessionRow`s. This is read-only over the two
 * EXISTING list endpoints — no new backend:
 *   - GET /api/chat/conversations  → { conversations } (updated_at DESC, ≤100, is_archived=false)
 *   - GET /api/tasks/list?limit=20  → { tasks }        (created_at DESC)
 *
 * THE SINGLE FRESHNESS MODEL (one refetch, four triggers, never three competing
 * loops):
 *   1. expand        — fetch when the section becomes enabled (expanded). A
 *                      collapsed section never fetches/polls (frugal).
 *   2. event bus     — window "instaclaw:sessions-changed", dispatched by the
 *                      Command Center page after any session mutation (new chat,
 *                      rename, archive, new task, status change). Instant rail
 *                      coherence without waiting for the poll.
 *   3. focus/visible — window "focus" + document visibilitychange→visible,
 *                      debounced so the two coalesce into one.
 *   4. poll          — every 30s, gated on (enabled AND document visible). No
 *                      polling while collapsed or backgrounded → zero idle noise.
 * All four funnel into ONE `refetch()` with an in-flight guard (coalesces
 * concurrent calls into a single trailing re-run). `refetch` never blanks the
 * list — only the first load shows `loading`; errors keep the last-good list.
 *
 * Identity / sort (collision-proof, stable):
 *   - uid = `${type}:${id}` — the two id spaces are namespaced, so a chat id and
 *     a task id can never collide; uid is the stable React key.
 *   - recency-desc by `recency` (updated_at epoch, fallback created_at, fallback
 *     0), tie-broken by uid so equal timestamps never reorder between renders.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type SessionType = "chat" | "task";

/** A task's lifecycle status (mirrors the Command Center page's TaskStatus). */
export type SessionTaskStatus =
  | "completed"
  | "in_progress"
  | "queued"
  | "failed"
  | "active"
  | "paused";

/** Normalized row — the only shape the Sessions UI renders from. */
export interface SessionRow {
  uid: string; // `${type}:${id}` — namespaced, collision-proof, stable React key
  type: SessionType;
  id: string; // raw entity id (for the deep-link param + single-item GET)
  title: string;
  updatedAt: string; // ISO
  recency: number; // epoch ms — the sort key
  statusHint?: SessionTaskStatus; // tasks only — drives the status-tinted glyph
  preview?: string; // last_message_preview (chat) | description (task) — optional
}

export interface UseSessions {
  sessions: SessionRow[]; // merged, deduped, recency-desc
  loading: boolean; // first load only
  error: boolean; // both endpoints failed (list kept last-good)
  refetch: () => void; // the single freshness entrypoint
}

/** Custom event the Command Center page dispatches on any session mutation. */
export const SESSIONS_CHANGED_EVENT = "instaclaw:sessions-changed";

const POLL_INTERVAL_MS = 30_000;
const FOCUS_DEBOUNCE_MS = 800;
const TASKS_LIMIT = 20;

/* ─── shape of the raw API rows we read (only the fields we use) ─────────── */

export interface RawConversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  last_message_preview?: string;
  is_archived?: boolean;
}

export interface RawTask {
  id: string;
  title: string;
  description?: string;
  status: SessionTaskStatus;
  created_at: string;
  updated_at: string;
}

/* ─── normalization + merge ──────────────────────────────────────────────── */

function recencyOf(updated?: string, created?: string): number {
  const u = updated ? Date.parse(updated) : NaN;
  if (!Number.isNaN(u)) return u;
  const c = created ? Date.parse(created) : NaN;
  return Number.isNaN(c) ? 0 : c;
}

export function rowFromConversation(c: RawConversation): SessionRow {
  return {
    uid: `chat:${c.id}`,
    type: "chat",
    id: c.id,
    title: c.title?.trim() || "New chat",
    updatedAt: c.updated_at,
    recency: recencyOf(c.updated_at, c.created_at),
    preview: c.last_message_preview || undefined,
  };
}

export function rowFromTask(t: RawTask): SessionRow {
  // "Processing..." is the page's placeholder title for an in-flight task; show
  // the same friendly label the page shows so the rail never reads "Processing..."
  const title =
    t.status === "in_progress" && (t.title === "Processing..." || !t.title?.trim())
      ? "Working on it…"
      : t.title?.trim() || "Untitled task";
  return {
    uid: `task:${t.id}`,
    type: "task",
    id: t.id,
    title,
    updatedAt: t.updated_at,
    recency: recencyOf(t.updated_at, t.created_at),
    statusHint: t.status,
    preview: t.description || undefined,
  };
}

/** Merge + stable recency-desc sort. Ids are unique per table → no intra-list dupes. */
export function mergeSessions(tasks: RawTask[], convs: RawConversation[]): SessionRow[] {
  const rows: SessionRow[] = [
    ...tasks.map(rowFromTask),
    ...convs.map(rowFromConversation),
  ];
  rows.sort((a, b) => {
    if (b.recency !== a.recency) return b.recency - a.recency;
    // deterministic tie-break so equal timestamps never reorder between renders
    return a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;
  });
  return rows;
}

/* ─── the hook ───────────────────────────────────────────────────────────── */

export function useSessions({ enabled }: { enabled: boolean }): UseSessions {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [error, setError] = useState(false);

  // In-flight guard: never two concurrent fetches; a call made while one is in
  // flight sets `queued` so exactly one trailing refetch runs on completion.
  const inFlight = useRef(false);
  const queued = useRef(false);

  const refetch = useCallback(async () => {
    if (inFlight.current) {
      queued.current = true;
      return;
    }
    inFlight.current = true;
    try {
      const [tRes, cRes] = await Promise.all([
        fetch(`/api/tasks/list?limit=${TASKS_LIMIT}`),
        fetch(`/api/chat/conversations`),
      ]);
      const tasks: RawTask[] = tRes.ok ? (await tRes.json()).tasks ?? [] : [];
      const convs: RawConversation[] = cRes.ok
        ? (await cRes.json()).conversations ?? []
        : [];
      // Only treat as error (and keep last-good) if BOTH failed; a partial
      // failure still renders the half that loaded.
      if (!tRes.ok && !cRes.ok) {
        setError(true);
      } else {
        setSessions(mergeSessions(tasks, convs));
        setError(false);
      }
    } catch {
      setError(true); // keep last-good list — never blank on a transient error
    } finally {
      setLoadedOnce(true);
      inFlight.current = false;
      if (queued.current) {
        queued.current = false;
        // one trailing run to capture changes that arrived mid-flight
        void refetch();
      }
    }
  }, []);

  // The single freshness model — all triggers funnel into `refetch`. Only wired
  // while `enabled` (section expanded); collapsed → no fetch, no listeners, no poll.
  useEffect(() => {
    if (!enabled) return;

    refetch(); // refresh on (re-)expand

    let focusTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedRefetch = () => {
      if (focusTimer) clearTimeout(focusTimer);
      focusTimer = setTimeout(() => void refetch(), FOCUS_DEBOUNCE_MS);
    };

    const onChanged = () => void refetch();
    const onFocus = () => debouncedRefetch();
    const onVisibility = () => {
      if (document.visibilityState === "visible") debouncedRefetch();
    };

    window.addEventListener(SESSIONS_CHANGED_EVENT, onChanged);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    const poll = setInterval(() => {
      if (document.visibilityState === "visible") void refetch();
    }, POLL_INTERVAL_MS);

    return () => {
      window.removeEventListener(SESSIONS_CHANGED_EVENT, onChanged);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(poll);
      if (focusTimer) clearTimeout(focusTimer);
    };
  }, [enabled, refetch]);

  return { sessions, loading: !loadedOnce, error, refetch };
}
