"use client";

import { useEffect, useState } from "react";

/**
 * Nav-mode flag for the dashboard sidebar restructure (Phase 1).
 *
 * Resolution order (first match wins):
 *   1. `?nav=sidebar` / `?nav=topnav` query param — seeds localStorage so the
 *      choice persists across SPA navigation. Lets Cooper eyeball the sidebar
 *      on ANY deploy (incl. the preview URL) without touching env config.
 *   2. localStorage `instaclaw_nav_mode` — the persisted override from (1).
 *   3. `NEXT_PUBLIC_SIDEBAR_NAV === "true"` — the build-time default. Set this
 *      on the preview deployment to show the whole preview in sidebar mode;
 *      leave it UNSET in production so prod renders the top-nav.
 *
 * Rollback contract (Phase 1 non-negotiable): when nothing opts in
 * (no param, no storage, env unset) the resolved mode is "topnav" during BOTH
 * SSR and the first client render — so the flag-off path is byte-identical to
 * today with zero flash and no hydration mismatch. Flipping the env var off /
 * clearing storage / passing `?nav=topnav` is the instant rollback.
 *
 * The override only ever flips state AFTER mount (in the effect), and only when
 * someone has explicitly opted in — so an un-opted-in user never sees a flash.
 */
export type NavMode = "topnav" | "sidebar";

const STORAGE_KEY = "instaclaw_nav_mode";

const ENV_DEFAULT: NavMode =
  process.env.NEXT_PUBLIC_SIDEBAR_NAV === "true" ? "sidebar" : "topnav";

export function useNavMode(): NavMode {
  // SSR + first paint use the env default. With the flag off this is "topnav"
  // everywhere, so the flag-off render is byte-identical and flash-free.
  const [mode, setMode] = useState<NavMode>(ENV_DEFAULT);

  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const q = params.get("nav");
      if (q === "sidebar" || q === "topnav") {
        localStorage.setItem(STORAGE_KEY, q);
      }
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "sidebar" || stored === "topnav") {
        setMode(stored);
        return;
      }
    } catch {
      // localStorage / URL unavailable (SSR edge, private mode) — keep env default.
    }
    setMode(ENV_DEFAULT);
  }, []);

  return mode;
}
