import { Info } from "lucide-react";

/**
 * Per-model copy for the model-picker info tooltip.
 *
 * CREDIT NUMBERS ARE LOAD-BEARING (money-facing; users act on them). They are
 * VERIFIED against the single source of truth: lib/credit-constants.ts
 * `MODEL_COST_WEIGHTS` = { haiku: 1, sonnet: 4, opus: 19 } (credit units per
 * API call; `getModelCostWeight()` matches model id by substring). If those
 * weights ever change, update the `cost` strings here in the same PR.
 *
 * Keyed by the exact MODEL_OPTIONS ids in app/(dashboard)/tasks/page.tsx.
 */
const MODEL_INFO: Record<string, { name: string; desc: string; cost: string }> = {
  "claude-haiku-4-5-20251001": {
    name: "Haiku 4.5",
    desc: "Fastest and most efficient. Best for quick questions, simple lookups, and rapid back-and-forth.",
    cost: "1 credit per message",
  },
  "claude-sonnet-4-6": {
    name: "Sonnet 4.6",
    desc: "The balanced default. Strong at everyday writing, coding, and analysis without the heavier cost. The right pick when you're unsure.",
    cost: "4 credits per message",
  },
  "claude-opus-4-6": {
    name: "Opus 4.6",
    desc: "The most capable, for hard reasoning and complex multi-step work where getting it exactly right is worth the higher cost.",
    cost: "19 credits per message",
  },
};

// Same opaque-glass shadow family as the picker popover + the "+" menu.
const TOOLTIP_SHADOW =
  "0 1px 2px rgba(0,0,0,0.04), 0 12px 32px -8px rgba(0,0,0,0.18), 0 0 0 1px rgba(0,0,0,0.05)";

/**
 * Quiet info affordance at the right of each model row. Hover (desktop) or tap
 * (mobile) surfaces a concise, opaque tooltip: positioning + verified credit cost.
 *
 * Rendered INSIDE the row <button>, so it is a <span role="button"> (never a
 * nested <button>, which is invalid DOM) and stops pointerdown+click propagation so it
 * NEVER triggers the row's model selection or press animation.
 */
export function ModelInfoButton({
  modelId,
  isOpen,
  onOpenChange,
}: {
  modelId: string;
  isOpen: boolean;
  onOpenChange: (id: string | null) => void;
}) {
  const info = MODEL_INFO[modelId];
  if (!info) return null;
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={`About ${info.name}`}
      className="relative flex items-center justify-center w-5 h-5 rounded-md shrink-0 cursor-help transition-opacity"
      style={{ color: "var(--muted)" }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onOpenChange(isOpen ? null : modelId);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.stopPropagation();
          e.preventDefault();
          onOpenChange(isOpen ? null : modelId);
        }
      }}
      // Hover only on a real mouse; touch taps go through onClick so the
      // synthetic pointerenter on tap doesn't double-toggle the tooltip.
      onPointerEnter={(e) => {
        if (e.pointerType === "mouse") onOpenChange(modelId);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === "mouse") onOpenChange(null);
      }}
    >
      <Info className="w-3.5 h-3.5" style={{ opacity: isOpen ? 1 : 0.7 }} />
      {isOpen && (
        <span
          role="tooltip"
          // Opens LEFT of the icon (the picker is right-anchored near the screen
          // edge → left keeps it on-screen), vertically centered on the row.
          // Opaque var(--card) + the picker's glass shadow, never translucent.
          // pointer-events-none so it never captures clicks or blocks the row.
          className="absolute right-full top-1/2 -translate-y-1/2 mr-2 w-56 rounded-xl p-3 text-left z-[70] pointer-events-none"
          style={{ background: "var(--card)", boxShadow: TOOLTIP_SHADOW }}
        >
          <span className="block text-xs leading-relaxed" style={{ color: "var(--foreground)" }}>
            {info.desc}
          </span>
          <span className="block text-[11px] mt-1.5 font-medium" style={{ color: "var(--accent)" }}>
            {info.cost}
          </span>
        </span>
      )}
    </span>
  );
}
