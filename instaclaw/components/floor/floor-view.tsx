"use client";

/**
 * The Floor — the client view (docs/prd/the-floor.md §11 chrome, §24).
 *
 * The top-level client surface: runs the engine (poll + clock), mounts the 3D
 * canvas (dynamically, ssr:false — R3F needs WebGL), and renders the minimal
 * chrome around it (the live activity ticker, the share affordance, graceful
 * connecting / no-office / error states).
 *
 * Chrome philosophy (PRD §11): nothing competes with the crab. One live ticker
 * line, one share button, a title. The scene is the star.
 */

import { useMemo } from "react";
import dynamic from "next/dynamic";
import { useFloorStore } from "@/lib/floor/store";
import { useFloorEngine } from "@/lib/floor/use-floor-engine";
import { describeBehavior } from "@/lib/floor/director";

// R3F needs the browser — never SSR the canvas. A warm poster shows while the
// (small) 3D bundle loads, so the surface is never a blank box (§12).
const FloorCanvas = dynamic(() => import("./floor-canvas"), {
  ssr: false,
  loading: () => <ScenePoster label="Opening the office…" />,
});

function ScenePoster({ label }: { label: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-[#2a2018]">
      <div className="flex flex-col items-center gap-3 text-amber-100/70">
        <div className="text-4xl">🦀</div>
        <div className="text-sm">{label}</div>
      </div>
    </div>
  );
}

export function FloorView() {
  useFloorEngine();

  const status = useFloorStore((s) => s.status);
  const director = useFloorStore((s) => s.director);

  // Recomputes only when `director` identity changes (real transitions), not on
  // every poll — the store assigns a new director object only on change.
  const tickerLine = useMemo(() => describeBehavior(director), [director]);

  return (
    <div className="mx-auto flex h-[calc(100vh-4rem)] max-w-5xl flex-col gap-3 p-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-amber-50">The Floor</h1>
          <p className="text-xs text-amber-100/50">watch your agent work</p>
        </div>
        <ShareButton disabled={status !== "live"} />
      </div>

      {/* The stage */}
      <div className="relative flex-1 overflow-hidden rounded-2xl bg-[#2a2018] shadow-2xl ring-1 ring-amber-900/30">
        {/* M4: keep the WebGL canvas MOUNTED across connecting/live/error. A
            transient network blip flips status to "error" for one poll; tearing
            down the canvas would destroy the GPU context and re-init the whole
            scene on recovery — janky on mobile and can hit the browser's
            WebGL-context limit on repeated flaps. We mount the canvas for every
            state EXCEPT no_office (a genuine no-VM state that doesn't flap), and
            overlay the error as a small non-blocking toast so Larry stays
            visible underneath during a blip. */}
        {status === "no_office" ? (
          <ScenePoster label="Your office is being set up — check back in a few minutes." />
        ) : (
          <FloorCanvas />
        )}

        {/* Transient-error toast — overlaid, non-blocking; canvas keeps running. */}
        {status === "error" && (
          <div className="pointer-events-none absolute right-4 top-4 flex items-center gap-2 rounded-full bg-black/55 px-3 py-1.5 backdrop-blur-sm">
            <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
            <span className="text-xs font-medium text-amber-100/90">Reconnecting…</span>
          </div>
        )}

        {/* Live activity ticker — the one chrome line over the scene. */}
        {status === "live" && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/55 to-transparent px-5 py-4">
            <LiveDot />
            <span className="text-sm font-medium text-amber-50/90">{tickerLine}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function LiveDot() {
  return (
    <span className="relative flex h-2 w-2">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/70" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
    </span>
  );
}

function ShareButton({ disabled }: { disabled: boolean }) {
  // The share-card mechanic (PRD §15) is the next growth phase; the affordance
  // is planted now at the right spot. Wiring lands with the baked-card route.
  return (
    <button
      type="button"
      disabled={disabled}
      className="rounded-full bg-amber-500/90 px-4 py-1.5 text-sm font-medium text-amber-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
      onClick={() => {
        /* TODO(v1): generate + share the 9:16 card (§15). */
      }}
    >
      Share
    </button>
  );
}
