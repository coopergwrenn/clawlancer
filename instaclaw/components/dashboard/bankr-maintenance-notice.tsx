"use client";

/**
 * Bankr maintenance notice — visual primitive for "wallet actions paused".
 *
 * Three variants for different placements:
 *
 *   - "card"      : standalone full-width glass card, used where the
 *                   "Tokenize Your Agent" CTA would otherwise sit.
 *                   Provides the primary "here's what's happening" surface.
 *
 *   - "inline"    : a single soft line inside an existing card. Used in
 *                   AgentWalletFundingCard between the explanation and
 *                   address rows — preserves the read-only utility of the
 *                   card (address + balance still visible) while explaining
 *                   why outbound actions don't currently work.
 *
 *   - "banner"    : compact horizontal pill for marketing /token page —
 *                   surfaces the pause without disrupting the hero.
 *
 * Design language: matches dashboard "glass" card pattern. Soft warm-gray
 * tinted background, NOT amber/yellow (warning = wrong message; we want
 * graceful pause, like Linear's maintenance states). Wrench icon in muted
 * tone. Lowercase copy per brand voice. No exclamation. No "apologize for
 * inconvenience". No mention of security incidents — pure infrastructure-
 * maintenance framing per Cooper directive.
 */

import { Wrench } from "lucide-react";

// Copy lives in one place — easier to tune later without grepping callsites.
const COPY = {
  card: {
    title: "wallet actions taking a short break",
    body: "addresses + balances are visible. token launches and outbound actions resume in the coming days as our infrastructure partner completes maintenance.",
  },
  inline:
    "fee claims are paused during scheduled maintenance — back in the coming days.",
  banner: "token launches paused for scheduled maintenance",
} as const;

// Shared warm-gray glass surface. Subtle wash on top of glass so the card
// feels distinct from a normal dashboard card without screaming. Tested
// against the cream page background — the wash sits ~1 step warmer than
// the rest of the surface, not yellow.
const SURFACE_TINT = "rgba(120,113,108,0.04)"; // stone-500 @ 4% — sub-perceptual warm
const SURFACE_TINT_INLINE = "rgba(120,113,108,0.06)";

interface MaintenanceProps {
  variant?: "card" | "inline" | "banner";
  /** Optional override for the body copy. Useful for context-specific framings. */
  body?: string;
  /** Optional override for the title (card variant only). */
  title?: string;
  className?: string;
}

export function BankrMaintenanceNotice({
  variant = "card",
  body,
  title,
  className = "",
}: MaintenanceProps) {
  if (variant === "inline") {
    return (
      <div
        className={`rounded-md px-3 py-2 flex items-start gap-2 ${className}`}
        style={{
          background: SURFACE_TINT_INLINE,
          border: "1px solid var(--border)",
        }}
        role="status"
        aria-live="polite"
      >
        <Wrench
          className="w-3.5 h-3.5 mt-0.5 shrink-0"
          style={{ color: "var(--muted)", opacity: 0.7 }}
          aria-hidden
        />
        <p
          className="text-xs leading-relaxed"
          style={{ color: "var(--muted)" }}
        >
          {body ?? COPY.inline}
        </p>
      </div>
    );
  }

  if (variant === "banner") {
    return (
      <div
        className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs ${className}`}
        style={{
          background: SURFACE_TINT,
          border: "1px solid var(--border)",
          color: "var(--muted)",
        }}
        role="status"
        aria-live="polite"
      >
        <Wrench className="w-3 h-3" style={{ opacity: 0.7 }} aria-hidden />
        <span>{body ?? COPY.banner}</span>
      </div>
    );
  }

  // variant === "card"
  return (
    <div
      className={`glass rounded-xl p-5 ${className}`}
      style={{
        background: SURFACE_TINT,
        border: "1px solid var(--border)",
      }}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        <div
          className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center"
          style={{
            background: "rgba(120,113,108,0.08)",
            border: "1px solid var(--border)",
          }}
        >
          <Wrench
            className="w-4 h-4"
            style={{ color: "var(--muted)" }}
            aria-hidden
          />
        </div>
        <div className="flex-1 min-w-0">
          <p
            className="text-sm font-medium mb-1"
            style={{ color: "var(--foreground)" }}
          >
            {title ?? COPY.card.title}
          </p>
          <p
            className="text-xs leading-relaxed"
            style={{ color: "var(--muted)" }}
          >
            {body ?? COPY.card.body}
          </p>
        </div>
      </div>
    </div>
  );
}
