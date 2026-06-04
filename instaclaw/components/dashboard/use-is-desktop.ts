"use client";

import { useState, useEffect } from "react";

/**
 * Desktop-breakpoint gate for the Phase 1 sidebar.
 *
 * The v2 sidebar is DESKTOP-ONLY for launch. Below `lg` (1024px) the dashboard
 * keeps rendering the existing top-nav exactly as it ships today — we don't
 * risk regressing mobile by burying nav behind a drawer. The right mobile
 * pattern is a separate, deliberate pass later.
 *
 * SSR + first paint return `false` ("unknown → treat as mobile → top-nav") on
 * purpose:
 *   - Mobile flag-on renders the top-nav from frame 0 → ZERO flash. (This is
 *     the priority: mobile must be provably unchanged.)
 *   - Flag-off is unaffected — the layout gate short-circuits on navMode before
 *     this value is ever read, so it never influences the flag-off render.
 *   - The only cost is a single frame of top-nav on a DESKTOP flag-on load
 *     (preview / opt-in only, never prod) before the rail mounts. Accepted.
 */
const LG_BREAKPOINT_PX = 1024;

export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(`(min-width: ${LG_BREAKPOINT_PX}px)`);
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  return isDesktop;
}
