"use client";

/**
 * SessionsSection — the live Sessions index in the desktop sidebar rail.
 *
 * A dynamic variant of sidebar-shell's CollapsibleSection: same header / chevron
 * / iOS-spring / real-glass active pill (from sidebar-primitives), but the body
 * is a live list (loading / empty / Pinned + Recent) instead of static rows.
 *
 * - Data + freshness: useSessions (one refetch, event+poll+focus, frugal).
 * - Pins: usePins (PinStore — localStorage now, server-table swap later).
 * - Rows deep-link into /tasks (?v=chat&c= / ?v=tasks&t=); the active row (from
 *   the URL params passed down) gets the shared layoutId pill so the single pill
 *   travels between Command Center, Workspace/Account rows, and a Sessions row.
 * - Pin hydration + self-heal: a pinned session outside the live window is
 *   fetched by id (GET /api/chat/conversations/[id] | /api/tasks/[id]); a 404 or
 *   an archived conversation self-heals (drops the dead pin).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { MessageSquare, ListTodo, Pin, ChevronDown, Plus } from "lucide-react";
import {
  useSessions,
  rowFromConversation,
  rowFromTask,
  type SessionRow,
} from "./use-sessions";
import { usePins, type PinKey } from "./use-pins";
import {
  LIST_VARIANTS,
  ROW_VARIANTS,
  CHEVRON_SPRING,
  SidebarActivePill,
  SidebarRowHover,
} from "./sidebar-primitives";

// Hard cap the Sessions list at the 3 most-recent. NO in-rail scroll region —
// the rail is "a few recent + a door to the rest", and Command Center is the
// actual session browser. Pinned count toward the cap (pinned-first, then
// recent); the ACTIVE session is always kept visible even if it's older than the
// cap (the one case a hard cap would otherwise bite — losing your place in an
// old session). Fixed footprint → the nav below Sessions never reflows on
// session count OR scroll. Overflow lives behind "See all", shown only when
// there are genuinely more sessions than the cap displays.
const SESSIONS_CAP = 3;

/* ─── helpers ─────────────────────────────────────────────────────────────── */

function timeAgo(iso: string | undefined | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w`;
}

function splitKey(key: PinKey): { type: "chat" | "task"; id: string } {
  const i = key.indexOf(":");
  return { type: key.slice(0, i) as "chat" | "task", id: key.slice(i + 1) };
}

function hrefFor(row: SessionRow): string {
  // ?c / ?t alone — presence implies the tab (the page reads them directly).
  return row.type === "chat" ? `/tasks?c=${row.id}` : `/tasks?t=${row.id}`;
}

/* ─── pin resolution + hydration + self-heal ──────────────────────────────── */

/**
 * Resolve pinned PinKeys → SessionRows. Rows in the live `sessions` window
 * resolve instantly; any pin outside the window is fetched by id once. A 404
 * (or an archived conversation) self-heals via `unpin`. Returns recency-desc.
 */
function usePinnedRows(
  pins: PinKey[],
  sessions: SessionRow[],
  unpin: (k: PinKey) => void,
): SessionRow[] {
  const byUid = useMemo(
    () => new Map(sessions.map((s) => [s.uid, s])),
    [sessions],
  );
  // uid → hydrated row (for pins not present in the live window)
  const [hydrated, setHydrated] = useState<Record<string, SessionRow>>({});
  // uids we've already attempted to fetch, so we never re-fetch in a loop
  const attempted = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    for (const key of pins) {
      const uid = key; // PinKey is exactly the uid format `type:id`
      if (byUid.has(uid)) continue; // present live — no fetch needed
      if (attempted.current.has(uid)) continue;
      attempted.current.add(uid);
      const { type, id } = splitKey(key);
      (async () => {
        try {
          if (type === "chat") {
            const res = await fetch(`/api/chat/conversations/${id}`);
            if (res.status === 404) {
              if (!cancelled) unpin(key);
              return;
            }
            if (!res.ok) return; // transient — leave unresolved, retry on change
            const { conversation } = await res.json();
            if (conversation?.is_archived) {
              if (!cancelled) unpin(key); // archived = soft-deleted → self-heal
              return;
            }
            if (!cancelled && conversation) {
              setHydrated((h) => ({ ...h, [uid]: rowFromConversation(conversation) }));
            }
          } else {
            const res = await fetch(`/api/tasks/${id}`);
            if (res.status === 404) {
              if (!cancelled) unpin(key);
              return;
            }
            if (!res.ok) return;
            const { task } = await res.json();
            if (!cancelled && task) {
              setHydrated((h) => ({ ...h, [uid]: rowFromTask(task) }));
            }
          }
        } catch {
          // transient network — allow a retry on the next pins/sessions change
          attempted.current.delete(uid);
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [pins, byUid, unpin]);

  return useMemo(() => {
    const rows = pins
      .map((key) => byUid.get(key) ?? hydrated[key])
      .filter((r): r is SessionRow => Boolean(r));
    rows.sort((a, b) =>
      b.recency !== a.recency
        ? b.recency - a.recency
        : a.uid < b.uid
          ? -1
          : a.uid > b.uid
            ? 1
            : 0,
    );
    return rows;
  }, [pins, byUid, hydrated]);
}

/* ─── a single session row ────────────────────────────────────────────────── */

function SessionRowItem({
  row,
  active,
  pinned,
  onTogglePin,
}: {
  row: SessionRow;
  active: boolean;
  pinned: boolean;
  onTogglePin: (key: PinKey) => void;
}) {
  const isInProgress = row.type === "task" && row.statusHint === "in_progress";
  const isFailed = row.type === "task" && row.statusHint === "failed";

  return (
    <Link
      href={hrefFor(row)}
      aria-current={active ? "page" : undefined}
      title={row.title}
      className="group relative flex shrink-0 items-center gap-3 px-3 h-9 rounded-lg text-sm transition-snappy transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#DC6743]/40"
      style={{
        color: active ? "var(--foreground)" : "var(--muted)",
        fontWeight: active ? 500 : 400,
      }}
    >
      {active ? <SidebarActivePill /> : <SidebarRowHover />}

      {/* type glyph (+ status dot for in-progress / failed tasks) */}
      <span className="relative z-10 flex items-center justify-center shrink-0">
        {row.type === "chat" ? (
          <MessageSquare className="w-[18px] h-[18px]" strokeWidth={active ? 2.25 : 2} />
        ) : (
          <ListTodo className="w-[18px] h-[18px]" strokeWidth={active ? 2.25 : 2} />
        )}
        {(isInProgress || isFailed) && (
          <span
            className={`absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full ${isInProgress ? "animate-pulse" : ""}`}
            style={{
              background: isFailed ? "#ef4444" : "#3b82f6",
              boxShadow: "0 0 0 2px #f5f3ee",
            }}
          />
        )}
      </span>

      <span className="relative z-10 truncate flex-1">{row.title}</span>

      {/* relative time — occupies the right slot at rest; yields to the pin
          toggle on hover (any row) AND whenever the row is pinned (the pin is
          then always visible), so the two never overlap. */}
      <span
        className={`relative z-10 shrink-0 text-[10px] tabular-nums transition-opacity ${
          pinned ? "opacity-0" : "opacity-70 group-hover:opacity-0"
        }`}
        style={{ color: "var(--muted)" }}
      >
        {timeAgo(row.updatedAt)}
      </span>

      {/* pin toggle — always visible (filled) when pinned; on hover otherwise */}
      <button
        type="button"
        aria-label={pinned ? "Unpin session" : "Pin session"}
        title={pinned ? "Unpin" : "Pin"}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onTogglePin(row.uid as PinKey);
        }}
        className={`absolute right-2 z-20 flex items-center justify-center w-5 h-5 rounded-md transition-all hover:bg-black/[0.06] active:scale-90 outline-none focus-visible:ring-2 focus-visible:ring-[#DC6743]/40 ${
          pinned ? "opacity-70" : "opacity-0 group-hover:opacity-60"
        } hover:!opacity-100`}
        style={{ color: pinned ? "#A8442A" : "var(--muted)" }}
      >
        <Pin className="w-3 h-3" fill={pinned ? "currentColor" : "none"} />
      </button>
    </Link>
  );
}

/* ─── skeleton row ────────────────────────────────────────────────────────── */

function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 px-3 h-9">
      <span className="w-[18px] h-[18px] rounded-md shrink-0" style={{ background: "rgba(0,0,0,0.06)" }} />
      <span className="h-2.5 rounded-full" style={{ background: "rgba(0,0,0,0.06)", width: "62%" }} />
    </div>
  );
}

/* ─── the section ─────────────────────────────────────────────────────────── */

export function SessionsSection({
  collapsed,
  onToggle,
  activeChatId,
  activeTaskId,
  onNewSession,
}: {
  collapsed: boolean;
  onToggle: () => void;
  activeChatId: string | null;
  activeTaskId: string | null;
  // The rail's "+" — pinned on the header, always visible. The shell owns the
  // routing (fork modal outside Command Center; straight-to-new inside it).
  onNewSession?: () => void;
}) {
  // Active-route protection: when a session is open, force the section open and
  // lock it (you can't collapse away your current session). Same pattern as
  // sidebar-shell's CollapsibleSection.
  const hasActive = Boolean(activeChatId || activeTaskId);
  const open = hasActive ? true : !collapsed;
  const locked = hasActive;

  const { sessions, loading } = useSessions({ enabled: open });
  const { pins, isPinned, togglePin, ready } = usePins();

  const pinnedRows = usePinnedRows(pins, sessions, togglePin);
  const pinnedUids = useMemo(() => new Set(pinnedRows.map((r) => r.uid)), [pinnedRows]);

  // The visible set: pinned first (they're the "kept" ones — pinning earns a
  // limited slot), then recent, hard-capped to SESSIONS_CAP. The ACTIVE session
  // is appended if it falls outside the cap, so you never lose your place in an
  // older chat/task. Max footprint = CAP rows (+1 only while you're actively in
  // an old session) — fixed and predictable, never growing with session count.
  const visibleRows = useMemo(() => {
    const recent = sessions.filter((s) => !pinnedUids.has(s.uid));
    const combined = [...pinnedRows, ...recent];
    const capped = combined.slice(0, SESSIONS_CAP);
    const activeUid = activeChatId
      ? `chat:${activeChatId}`
      : activeTaskId
        ? `task:${activeTaskId}`
        : null;
    if (activeUid && !capped.some((r) => r.uid === activeUid)) {
      const activeRow = combined.find((r) => r.uid === activeUid);
      if (activeRow) return [...capped, activeRow];
    }
    return capped;
  }, [sessions, pinnedRows, pinnedUids, activeChatId, activeTaskId]);

  // "See all" appears ONLY when there are genuinely more sessions than we show —
  // never a dead link with nothing behind it.
  const totalCount = useMemo(() => {
    const uids = new Set(sessions.map((s) => s.uid));
    pinnedRows.forEach((r) => uids.add(r.uid));
    return uids.size;
  }, [sessions, pinnedRows]);
  const hasOverflow = totalCount > visibleRows.length;

  const isActiveRow = (row: SessionRow) =>
    (row.type === "chat" && row.id === activeChatId) ||
    (row.type === "task" && row.id === activeTaskId);

  const showSkeleton = loading && sessions.length === 0 && pinnedRows.length === 0;
  const showEmpty =
    ready && !loading && sessions.length === 0 && pinnedRows.length === 0;

  return (
    <div className="mt-1">
      {/* Header — mirrors CollapsibleSection's header, plus the "+" new-session
          affordance pinned on it (always visible, understated, left of the
          chevron). A flex row of separate buttons so the "+" is its own action
          (no nested <button>) while the label + chevron both toggle collapse. */}
      <div className="group flex items-center w-full px-3 pt-1 pb-1.5 rounded-md gap-0.5">
        <button
          type="button"
          onClick={locked ? undefined : onToggle}
          aria-expanded={open}
          aria-disabled={locked || undefined}
          title={locked ? "Current section" : open ? "Collapse" : "Expand"}
          className={`flex items-center flex-1 min-w-0 text-left rounded outline-none focus-visible:ring-2 focus-visible:ring-[#DC6743]/40 ${
            locked ? "cursor-default" : "cursor-pointer"
          }`}
        >
          <span
            className="text-[10px] font-semibold uppercase tracking-[0.08em] select-none transition-colors"
            style={{ color: "var(--muted)", opacity: locked ? 0.7 : open ? 0.7 : 0.55 }}
          >
            Sessions
          </span>
        </button>

        {onNewSession && (
          <button
            type="button"
            onClick={onNewSession}
            aria-label="New session"
            title="New session"
            className="shrink-0 w-5 h-5 flex items-center justify-center rounded-md cursor-pointer transition-all hover:bg-black/[0.06] active:scale-90 outline-none focus-visible:ring-2 focus-visible:ring-[#DC6743]/40"
            style={{ color: "var(--muted)" }}
          >
            <Plus className="w-3.5 h-3.5 opacity-[0.65] transition-opacity group-hover:opacity-90 hover:!opacity-100" />
          </button>
        )}

        <button
          type="button"
          onClick={locked ? undefined : onToggle}
          aria-label={open ? "Collapse Sessions" : "Expand Sessions"}
          aria-disabled={locked || undefined}
          className={`shrink-0 flex items-center rounded outline-none focus-visible:ring-2 focus-visible:ring-[#DC6743]/40 ${
            locked ? "cursor-default" : "cursor-pointer"
          }`}
        >
          <motion.span
            className="flex items-center"
            animate={{ rotate: open ? 0 : -90 }}
            transition={CHEVRON_SPRING}
            style={{ opacity: locked ? 0.25 : 0.5 }}
          >
            <ChevronDown
              className="w-3.5 h-3.5 transition-opacity group-hover:opacity-100"
              style={{ color: "var(--muted)" }}
            />
          </motion.span>
        </button>
      </div>

      <motion.div
        initial={false}
        animate={open ? "open" : "closed"}
        variants={LIST_VARIANTS}
        style={{ overflow: "hidden" }}
        className="flex flex-col gap-0.5"
      >
        {showSkeleton && (
          <motion.div variants={ROW_VARIANTS}>
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </motion.div>
        )}

        {showEmpty && (
          <motion.div variants={ROW_VARIANTS}>
            <Link
              href="/tasks"
              className="block px-3 py-2 text-xs leading-snug rounded-lg transition-colors hover:bg-black/[0.03]"
              style={{ color: "var(--muted)" }}
            >
              No sessions yet — start one in Command Center →
            </Link>
          </motion.div>
        )}

        {/* Flat hard-capped list (SESSIONS_CAP + active). Pinned rows keep their
            filled-pin marker, so no subgroup headers are needed — which keeps
            the footprint FIXED (a "Pinned" header would otherwise pop in the
            moment you make your first pin) and the nav below anchored. */}
        {visibleRows.map((row) => (
          <motion.div key={row.uid} variants={ROW_VARIANTS}>
            <SessionRowItem
              row={row}
              active={isActiveRow(row)}
              pinned={isPinned(row.uid as PinKey)}
              onTogglePin={togglePin}
            />
          </motion.div>
        ))}

        {!showSkeleton && !showEmpty && hasOverflow && (
          <motion.div variants={ROW_VARIANTS}>
            <Link
              href="/tasks"
              className="flex items-center px-3 h-8 rounded-lg text-xs transition-colors hover:bg-black/[0.03]"
              style={{ color: "var(--muted)" }}
            >
              See all in Command Center →
            </Link>
          </motion.div>
        )}
      </motion.div>
    </div>
  );
}
