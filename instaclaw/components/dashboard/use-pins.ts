"use client";

/**
 * usePins — the pin store for the sidebar Sessions index.
 *
 * ONE interface, two backends. Stage 1 is localStorage (per-device, ships now,
 * zero backend). Stage 2 swaps ONLY the internals of this hook to a server table
 * (`/api/sessions/pins` GET/POST/DELETE) with localStorage as an offline cache —
 * the consuming component depends solely on the `PinStore` interface below, so
 * the swap is a drop-in with no UI change.
 *
 * A PinKey is opaque + namespaced (`chat:<id>` / `task:<id>`): localStorage
 * stores the joined strings; a future server stores (session_type, session_id)
 * rows; both map to the identical `PinKey[]`.
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

const STORAGE_KEY = "instaclaw_pinned_sessions";

/** Build a PinKey from a session row's type + id. */
export function pinKey(type: SessionType, id: string): PinKey {
  return `${type}:${id}`;
}

/** Parse + sanitize the stored value — drop anything that isn't a valid PinKey. */
function readStorage(): PinKey[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: PinKey[] = [];
    for (const v of parsed) {
      if (typeof v === "string" && /^(chat|task):.+/.test(v) && !seen.has(v)) {
        seen.add(v);
        out.push(v as PinKey);
      }
    }
    return out;
  } catch {
    return [];
  }
}

function writeStorage(pins: PinKey[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pins));
  } catch {
    // best-effort (private mode / quota) — in-memory state still reflects the pin
  }
}

export function usePins(): PinStore {
  const [pins, setPins] = useState<PinKey[]>([]);
  const [ready, setReady] = useState(false);
  // Latest pins, readable inside the cross-tab listener without re-subscribing.
  const pinsRef = useRef<PinKey[]>([]);
  pinsRef.current = pins;

  // Hydrate from localStorage on mount.
  useEffect(() => {
    setPins(readStorage());
    setReady(true);
  }, []);

  // Cross-tab sync: the native `storage` event fires in OTHER tabs when this key
  // changes. (It does NOT fire in the writing tab — but there's a single sidebar
  // per tab, so same-tab multi-instance sync isn't needed. Stage 2 can add a
  // broadcast if a second surface ever consumes pins.)
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setPins(readStorage());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const isPinned = useCallback((key: PinKey) => pinsRef.current.includes(key), []);

  const togglePin = useCallback((key: PinKey) => {
    setPins((prev) => {
      const next = prev.includes(key)
        ? prev.filter((k) => k !== key)
        : [...prev, key];
      writeStorage(next); // optimistic + persisted in one step
      return next;
    });
  }, []);

  return { pins, isPinned, togglePin, ready };
}
