/**
 * The Floor — client state store (zustand). docs/prd/the-floor.md §10.1.
 *
 * Holds the director state (the brain, lib/floor/director.ts) plus the polling
 * cursor, connection status, and a short recent-events tail for the ticker.
 *
 * ── Architecture seam ───────────────────────────────────────────────────────
 *   poller (useFloorEngine hook) → ingestActivity()/tick() [PURE actions here]
 *     → director state → renderer reads via selectors (React) + getState() (frame loop)
 *
 * The store owns STATE + PURE TRANSITIONS. Timer lifecycle (poll interval, logic
 * clock, tab-visibility) lives in the `useFloorEngine` hook so cleanup is tied to
 * component mount. `pollOnce()` is the one impure action (a fetch) — it's a thin
 * wrapper around the pure `ingestActivity()`, which is what tests exercise.
 *
 * Render-on-demand (PRD §12): the renderer subscribes to a narrow selector and
 * calls R3F `invalidate()` whenever director state changes (the "kick"); the
 * frame loop self-sustains while animating and stops when settled. The store
 * deliberately knows NOTHING about R3F/invalidate — that coupling lives in the
 * scene component, keeping this module renderer-agnostic and testable.
 */

import { create } from "zustand";
import {
  applyEvent,
  applyTick,
  initialDirectorState,
  type DirectorState,
  type FloorEvent,
  type FloorStation,
  type FloorChannel,
} from "./director";
import {
  dedupeAgainstCursor,
  newestCursor,
  type ActivityCursor,
} from "./activity-window";

/** Wire shape returned by GET /api/floor/activity (chronological, oldest→newest). */
export interface ActivityRow {
  id: string;
  created_at: string;
  kind: FloorEvent["kind"];
  station: FloorStation | null;
  intensity: 1 | 2 | 3 | null;
  channel: FloorChannel | null;
  tool_name: string | null;
}

export type FloorStatus = "connecting" | "live" | "error" | "no_office";

/** A compact recent-event record for the ticker / history strip. */
export interface TickerEvent {
  id: string;
  kind: FloorEvent["kind"];
  station: FloorStation | null;
  channel: FloorChannel | null;
  at: number; // parsed ms
}

const RECENT_EVENTS_MAX = 12;

interface FloorState {
  vmId: string | null;
  status: FloorStatus;
  director: DirectorState;
  recentEvents: TickerEvent[];
  /** Composite (created_at, id) keyset cursor: the newest event we've folded.
   *  Sent back to the server so it returns only strictly-newer rows (H1 fix). */
  cursor: ActivityCursor | null;
  /** True once we've folded at least one poll (so we don't re-play history as
   *  fresh perk-ups on first load — see ingestActivity). */
  primed: boolean;

  // ── pure actions ──
  setStatus: (status: FloorStatus) => void;
  /** Fold a chronological batch of rows. The server has already filtered to
   *  strictly-new rows via the keyset cursor; the store folds them in order
   *  (first-load seeds from the newest only). Pure given `now`. Returns whether
   *  anything changed. */
  ingestActivity: (rows: ActivityRow[], now: number) => boolean;
  /** Advance time-based director transitions. Returns whether state changed. */
  tick: (now: number) => boolean;
  reset: (now: number) => void;

  // ── impure action (thin fetch wrapper around ingestActivity) ──
  pollOnce: () => Promise<void>;
}

function rowToEvent(row: ActivityRow): FloorEvent {
  return {
    kind: row.kind,
    station: row.station,
    intensity: row.intensity,
    channel: row.channel,
    toolName: row.tool_name,
  };
}

function rowToTicker(row: ActivityRow): TickerEvent {
  return {
    id: row.id,
    kind: row.kind,
    station: row.station,
    channel: row.channel,
    at: Date.parse(row.created_at),
  };
}

export const useFloorStore = create<FloorState>((set, get) => ({
  vmId: null,
  status: "connecting",
  director: initialDirectorState(Date.now()),
  recentEvents: [],
  cursor: null,
  primed: false,

  setStatus: (status) => set({ status }),

  ingestActivity: (rows, now) => {
    const { cursor, primed } = get();

    // The server already returns only rows strictly after our cursor. The one
    // client-side guard is dropping an exact cursor-id re-send (paranoia; a
    // correct keyset never yields it). We do NOT compare timestamps here — that
    // would risk ms-truncation dropping a real event (see activity-window.ts).
    const fresh = dedupeAgainstCursor(rows, cursor);

    if (fresh.length === 0) {
      // Nothing new. Mark primed on first contact so a future first event is
      // treated as live (not history), and advance the cursor if the server
      // gave us a baseline window.
      if (!primed) {
        const baseline = newestCursor(rows);
        set(baseline ? { primed: true, cursor: baseline } : { primed: true });
      }
      return false;
    }

    // FIRST LOAD GUARD: the very first poll returns a backlog (newest page). We
    // must NOT replay it as fresh perk-ups (Larry would frantically re-enact the
    // last hour). Seed the director from the most recent row only, set the
    // cursor to the newest, and let subsequent polls drive live behavior.
    let director = get().director;
    if (!primed) {
      const newest = fresh[fresh.length - 1];
      director = applyEvent(director, rowToEvent(newest), now);
      const recentEvents = [...fresh]
        .slice(-RECENT_EVENTS_MAX)
        .map(rowToTicker);
      set({
        director,
        recentEvents,
        cursor: newestCursor(fresh),
        primed: true,
      });
      return true;
    }

    // LIVE PATH: fold every new event in chronological order. THIS is where the
    // magic moment fires — a fresh message_in row flips the director to
    // `incoming`. Keyset draining guarantees the message_in is never skipped.
    for (const row of fresh) {
      director = applyEvent(director, rowToEvent(row), now);
    }
    const recentEvents = [...get().recentEvents, ...fresh.map(rowToTicker)].slice(
      -RECENT_EVENTS_MAX,
    );
    set({
      director,
      recentEvents,
      cursor: newestCursor(fresh),
    });
    return true;
  },

  tick: (now) => {
    const prev = get().director;
    const next = applyTick(prev, now);
    if (next === prev) return false; // pure no-op → skip the set (avoids churn)
    set({ director: next });
    return true;
  },

  reset: (now) =>
    set({
      vmId: null,
      status: "connecting",
      director: initialDirectorState(now),
      recentEvents: [],
      cursor: null,
      primed: false,
    }),

  pollOnce: async () => {
    try {
      // Send the keyset cursor so the server returns only strictly-new rows
      // (H1). No cursor on first load → server returns the newest page.
      const { cursor } = get();
      const qs = cursor
        ? `?since=${encodeURIComponent(cursor.ts)}&sinceId=${encodeURIComponent(cursor.id)}`
        : "";
      const res = await fetch(`/api/floor/activity${qs}`, {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) {
        set({ status: "error" });
        return;
      }
      const data = (await res.json()) as {
        vmId: string | null;
        activity: ActivityRow[];
        serverTime?: string;
      };
      if (data.vmId === null) {
        set({ status: "no_office", vmId: null });
        return;
      }
      // Use the client clock for director timing. (Server time is available for
      // future drift correction; MVP trusts local monotonic-ish wall clock,
      // which is fine for human-perceptible beats.)
      const now = Date.now();
      get().ingestActivity(data.activity ?? [], now);
      set({ vmId: data.vmId, status: "live" });
    } catch {
      set({ status: "error" });
    }
  },
}));
