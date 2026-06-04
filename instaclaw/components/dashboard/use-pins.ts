"use client";

/**
 * usePins — the pin store for the sidebar Sessions index.
 *
 * Stage 2 (server-backed): pins live in the `instaclaw_session_pins` table and
 * follow the user across devices, with localStorage retained as an OFFLINE
 * CACHE (instant first paint, no unpinned-flash). The `PinStore` interface
 * below is UNCHANGED from Stage 1 — only the internals of `usePins` swapped from
 * localStorage-as-source-of-truth to /api/sessions/pins-as-source-of-truth. The
 * consuming component (sessions-section.tsx) depends solely on this interface,
 * so the swap is a drop-in with no UI change.
 *
 * Freshness model:
 *   1. mount      — hydrate from localStorage cache FIRST (instant, ready=true,
 *                   no flash of "unpinned"), THEN GET /api/sessions/pins and
 *                   reconcile to server truth (cross-device pins appear/vanish).
 *   2. toggle     — optimistic: update state + cache immediately, then fire
 *                   POST (pin) / DELETE (unpin) best-effort. On write failure,
 *                   re-GET to reconcile back to server truth (undoes a rejected
 *                   optimistic change). On success, the optimistic state already
 *                   matches the server — no extra fetch.
 *   3. cross-tab  — the native `storage` event keeps the cache mirror in sync
 *                   across tabs in the same browser.
 *
 * A PinKey is opaque + namespaced (`chat:<id>` / `task:<id>`): the cache stores
 * the joined strings; the server stores (session_type, session_id) rows; the
 * GET endpoint returns the joined strings verbatim. All three map to the
 * identical `PinKey[]`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionType } from "./use-sessions";

export type PinKey = `${SessionType}:${string}`;

export interface PinStore {
  pins: PinKey[];
  isPinned: (key: PinKey) => boolean;
  togglePin: (key: PinKey) => void; // optimistic; instant UI
  ready: boolean; // hydrated yet — gates a flash of "unpinned" on first paint
}

const STORAGE_KEY = "instaclaw_pinned_sessions"; // now an offline cache, not the source of truth
const PINS_ENDPOINT = "/api/sessions/pins";

/** Build a PinKey from a session row's type + id. */
export function pinKey(type: SessionType, id: string): PinKey {
  return `${type}:${id}`;
}

/** Validate + dedupe an array of candidate pin keys (from cache OR server). */
function sanitizePins(raw: unknown): PinKey[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: PinKey[] = [];
  for (const v of raw) {
    if (typeof v === "string" && /^(chat|task):.+/.test(v) && !seen.has(v)) {
      seen.add(v);
      out.push(v as PinKey);
    }
  }
  return out;
}

/** Read the localStorage offline cache. */
function readCache(): PinKey[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return sanitizePins(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** Write the localStorage offline cache (best-effort). */
function writeCache(pins: PinKey[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pins));
  } catch {
    // best-effort (private mode / quota) — in-memory state still reflects the pin
  }
}

export function usePins(): PinStore {
  const [pins, setPins] = useState<PinKey[]>([]);
  const [ready, setReady] = useState(false);
  // Latest pins, readable inside callbacks/listeners without re-subscribing.
  const pinsRef = useRef<PinKey[]>([]);
  pinsRef.current = pins;
  // Coalesce concurrent reconcile GETs into one in-flight + one trailing.
  const reconcileInFlight = useRef(false);
  const reconcileQueued = useRef(false);

  // Reconcile to server truth (source of truth). Updates state + cache. Keeps
  // the last-good list on any transient failure — never blanks pins.
  const reconcile = useCallback(async () => {
    if (reconcileInFlight.current) {
      reconcileQueued.current = true;
      return;
    }
    reconcileInFlight.current = true;
    try {
      const res = await fetch(PINS_ENDPOINT);
      if (!res.ok) return; // transient (incl. 401 pre-auth) — keep cache-hydrated pins
      const serverPins = sanitizePins((await res.json())?.pins);
      setPins(serverPins);
      writeCache(serverPins);
    } catch {
      // offline / network blip — keep the cache-hydrated pins
    } finally {
      reconcileInFlight.current = false;
      if (reconcileQueued.current) {
        reconcileQueued.current = false;
        void reconcile();
      }
    }
  }, []);

  // Mount: hydrate cache FIRST (instant, no unpinned-flash), then reconcile.
  useEffect(() => {
    setPins(readCache());
    setReady(true);
    void reconcile();
  }, [reconcile]);

  // Cross-tab sync: the native `storage` event fires in OTHER tabs when the
  // cache key changes. Keeps the in-memory mirror coherent across tabs.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setPins(readCache());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const isPinned = useCallback((key: PinKey) => pinsRef.current.includes(key), []);

  const togglePin = useCallback(
    (key: PinKey) => {
      const currentlyPinned = pinsRef.current.includes(key);
      // Optimistic: update state + cache immediately for instant UI.
      // Prepend on add to mirror the server's created_at-desc order (display
      // order is recency-sorted downstream regardless, so this is purely for
      // internal array stability across the next reconcile).
      setPins((prev) => {
        const next = currentlyPinned
          ? prev.filter((k) => k !== key)
          : [key, ...prev.filter((k) => k !== key)];
        writeCache(next);
        return next;
      });
      // Fire the server write best-effort. On failure, reconcile back to truth.
      const write = currentlyPinned
        ? fetch(`${PINS_ENDPOINT}?key=${encodeURIComponent(key)}`, { method: "DELETE" })
        : fetch(PINS_ENDPOINT, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ key }),
          });
      write.then(
        (res) => {
          if (!res.ok) void reconcile();
        },
        () => void reconcile(),
      );
    },
    [reconcile],
  );

  return { pins, isPinned, togglePin, ready };
}
