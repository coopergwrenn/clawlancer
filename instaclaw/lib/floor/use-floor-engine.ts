"use client";

/**
 * The Floor — the engine hook (docs/prd/the-floor.md §10.1, §12).
 *
 * Owns the SIDE EFFECTS that drive the store: the activity poll and the logic
 * clock. Kept out of the store itself so lifecycle (start/stop/cleanup) is tied
 * to component mount, and out of the renderer so it runs even when the GPU is
 * resting (the director must keep advancing — e.g. perk-up → working, idle
 * escalation — regardless of whether a frame is being drawn).
 *
 * Two timers, two cadences:
 *   - POLL (~2s): fetch /api/floor/activity → store.pollOnce(). The MVP
 *     transport (PRD §10.1). v1 swaps this for Supabase Realtime with no other
 *     change. The magic moment's latency is bounded by this interval today
 *     (~0–2s); Realtime takes it sub-second.
 *   - CLOCK (~1s): store.tick(Date.now()) → advances time-based director
 *     transitions. Pure JS, no GPU — negligible cost. Coarse on purpose
 *     (human-perceptible beats, not animation frames).
 *
 * Battery: both timers PAUSE when the tab is hidden (visibilitychange) and
 * resume with an immediate catch-up poll when it returns. Combined with the
 * renderer's frameloop="demand", a backgrounded Floor costs ~nothing.
 */

import { useEffect } from "react";
import { useFloorStore } from "./store";

const POLL_MS = 2000;
const CLOCK_MS = 1000;

export function useFloorEngine(): void {
  useEffect(() => {
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let clockTimer: ReturnType<typeof setInterval> | null = null;

    const poll = () => {
      void useFloorStore.getState().pollOnce();
    };
    const clock = () => {
      useFloorStore.getState().tick(Date.now());
    };

    const start = () => {
      if (pollTimer || clockTimer) return; // already running
      poll(); // immediate first poll so the office isn't blank on open
      pollTimer = setInterval(poll, POLL_MS);
      clockTimer = setInterval(clock, CLOCK_MS);
    };

    const stop = () => {
      if (pollTimer) clearInterval(pollTimer);
      if (clockTimer) clearInterval(clockTimer);
      pollTimer = null;
      clockTimer = null;
    };

    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        start(); // resume + immediate catch-up poll
      }
    };

    // Only run while visible (don't start a poll loop on a hidden tab).
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, []);
}
