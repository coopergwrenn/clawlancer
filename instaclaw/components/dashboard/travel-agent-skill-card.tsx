"use client";

/**
 * Travel Agent skill card — the human-facing card in the Skills grid (Commerce).
 *
 * ⚠️ PRESENTATIONAL ONLY (deliberate, firewall-locked). This card renders the
 * Travala booking skill as a first-class, shipped-looking grid entry. It makes
 * ZERO network calls, has NO toggle handler, and imports NOTHING from the booking
 * lane. It is provably incapable of moving money: the money path (the
 * `/api/travala` backend, the per-VM `travala_booking_enabled` gate, the
 * `travala-book.mjs` payer) lives on the unmerged `feat/travala-x402-booking`
 * branch and is NOT present here. Flipping anything on this card cannot trigger a
 * spend on any VM, because there is nothing to flip — the right-side switch is a
 * presentational `<div>` (the same non-interactive pattern the platform already
 * uses for the built-in "Always On" toggle in SkillCard), not a button.
 *
 * When the booking lane ships (separate Cooper go), this card is replaced by the
 * interactive version (status fetch + real per-VM toggle) on that branch.
 *
 * Visual idiom is copied 1:1 from `SkillCard` (app/(dashboard)/skills/page.tsx)
 * so it sits in the grid natively: glass container, SkillOrb, title + pill,
 * line-clamped description, right-side switch.
 */
import { Globe } from "lucide-react";
import { SkillOrb } from "@/components/skill-orb";

// Travala brand teal — distinct from the neighbours (Solana purple, Shopify green,
// Virtuals purple, Clawlancer gold) so the eye lands here, white globe glyph inside.
const TRAVALA_TEAL = "#13B5C9";

export function TravelAgentSkillCard() {
  return (
    <div
      className="glass rounded-xl p-5 h-[120px] relative overflow-hidden"
      style={{ border: "1px solid var(--border)" }}
    >
      <div className="flex items-start gap-3.5">
        {/* Icon — teal orb + globe, matching the brand-glyph treatment of its neighbours */}
        <SkillOrb size="sm" color={TRAVALA_TEAL} icon={Globe} className="mt-0.5" />

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <h3 className="text-sm font-medium truncate">Travel Agent</h3>
            <span className="skill-pill is-blue shrink-0">Beta</span>
          </div>
          <p
            className="text-xs leading-relaxed line-clamp-2"
            style={{ color: "var(--muted)" }}
          >
            Books real hotels on Travala, you approve every spend
          </p>
        </div>

        {/* Presentational switch — a <div>, NOT a button. No handler, no state, no
            network. Rendered in the off position (knob left, dimmed) so the card
            reads as a real, in-beta skill that isn't switched on. This is the same
            non-interactive pattern SkillCard uses for its built-in "Always On"
            switch; it cannot be clicked into doing anything. */}
        <div
          className="relative w-12 h-7 rounded-full shrink-0"
          style={{
            background: "rgba(0,0,0,0.06)",
            boxShadow:
              "0 0 0 1px rgba(0,0,0,0.06), inset 0 2px 4px rgba(0,0,0,0.08)",
            opacity: 0.6,
          }}
          aria-hidden="true"
        >
          <span
            className="absolute top-1 left-1 w-5 h-5 rounded-full"
            style={{
              background:
                "linear-gradient(135deg, rgba(255,255,255,0.95), rgba(240,240,240,0.9))",
              boxShadow:
                "0 1px 3px rgba(0,0,0,0.12), 0 0 0 0.5px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.5)",
            }}
          />
        </div>
      </div>
    </div>
  );
}
