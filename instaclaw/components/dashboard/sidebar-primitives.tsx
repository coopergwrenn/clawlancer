"use client";

/**
 * sidebar-primitives — the shared visual language of the desktop sidebar rail.
 *
 * Verbatim copies of sidebar-shell's visual language, consumed by the new
 * Sessions section so it reuses the EXACT iOS-feel section spring, the real-glass
 * active pill, and the rail color tokens. Values are byte-identical to what
 * shipped in the squish + glass passes.
 *
 * STAGE-1 NOTE: sidebar-shell keeps its own inline originals UNTOUCHED (zero
 * regression risk to the just-approved glass/squish during launch). These are
 * deliberate copies kept in sync by hand; the active pill travels between
 * sidebar-shell rows and Sessions rows because BOTH render layoutId
 * "sidebar-active-pill" (same string). Post-launch fast-follow: import these
 * into sidebar-shell to dedupe. Until then, any change here MUST mirror
 * sidebar-shell (and vice-versa).
 *
 * The active pill is a single shared `layoutId` element: whichever row is active
 * (Command Center, a Workspace/Account item, or a Sessions row) renders
 * <SidebarActivePill/>, and framer-motion animates the one pill smoothly between
 * them. Because only one row is ever active at a time, there's exactly one pill.
 */

import { motion } from "motion/react";

/* ─── Color tokens ────────────────────────────────────────────────────────── */

export const CORAL = "#DC6743";
// Darkened coral for text/icon ON coral-tinted glass — mirrors the .skill-pill
// is-green trick (text rgb(20,120,57) is darker than its radial fill) so the
// label stays legible over the translucent coral-under-glass material.
export const CORAL_TEXT = "#A8442A";
// The rail sits one notch recessed from the cream content (#f8f7f4) so the
// workspace reads with depth, not a flat plane split by a hairline. #f5f3ee is
// an existing InstaClaw tone (the landing/onboarding warm cream).
export const SIDEBAR_BG = "#f5f3ee";

/* ─── Motion: the iOS-feel section spring ─────────────────────────────────── */
// Lively, slight overshoot, settles fast, no wobble — the satisfying give of an
// iOS Settings section. These are the knobs to tune by feel on the live rail.
export const LIST_VARIANTS = {
  open: {
    height: "auto" as const,
    opacity: 1,
    transition: {
      height: { type: "spring" as const, stiffness: 520, damping: 32 },
      opacity: { duration: 0.18 },
      staggerChildren: 0.025,
      delayChildren: 0.04,
    },
  },
  closed: {
    height: 0,
    opacity: 0,
    transition: {
      height: { type: "spring" as const, stiffness: 560, damping: 40 },
      opacity: { duration: 0.12 },
      staggerChildren: 0.015,
      staggerDirection: -1 as const,
    },
  },
};
export const ROW_VARIANTS = {
  open: { opacity: 1, y: 0, transition: { type: "spring" as const, stiffness: 600, damping: 30 } },
  closed: { opacity: 0, y: -4, transition: { duration: 0.1 } },
};
export const CHEVRON_SPRING = { type: "spring" as const, stiffness: 600, damping: 30 };

/* ─── The shared active pill (single layoutId — travels between rows) ──────── */

export const ACTIVE_PILL_LAYOUT_ID = "sidebar-active-pill";

/**
 * Selected = an elevated near-white card lifted off the recessed rail
 * (Things/macOS sidebar language). Real glass: −75° white sheen ⊕ light-under-
 * glass radial + 4-layer glow-ring/shadow stack, border:none; faintly coral-
 * keyed so it reads as the warm "selected" surface, not a flat white box.
 */
export function SidebarActivePill() {
  return (
    <motion.div
      layoutId={ACTIVE_PILL_LAYOUT_ID}
      className="absolute inset-0 rounded-lg"
      style={{
        backgroundImage:
          "linear-gradient(-75deg, rgba(255,255,255,0.55), rgba(255,255,255,0.80), rgba(255,255,255,0.55)), " +
          "radial-gradient(120% 140% at 26% 22%, rgba(220,103,67,0.11) 0%, rgba(220,103,67,0.045) 55%, rgba(255,255,255,0) 100%)",
        backdropFilter: "blur(3px)",
        WebkitBackdropFilter: "blur(3px)",
        boxShadow:
          "rgba(0,0,0,0.05) 0px 1px 1.5px 0px inset, " +
          "rgba(255,255,255,0.70) 0px -1px 1.5px 0px inset, " +
          "rgba(0,0,0,0.10) 0px 2px 5px -1px, " +
          "rgba(255,255,255,0.55) 0px 0px 0.5px 1px inset",
      }}
      transition={{ type: "spring", stiffness: 420, damping: 36 }}
    />
  );
}

/** The subtle hover wash on a non-active row. */
export function SidebarRowHover() {
  return (
    <span
      className="absolute inset-0 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity duration-150"
      style={{ background: "rgba(255,255,255,0.6)" }}
    />
  );
}
