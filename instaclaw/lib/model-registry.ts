/**
 * lib/model-registry.ts - THE single source of truth for the model catalog.
 *
 * Before this file, the catalog was spread across 7 hardcoded lists that drifted
 * independently (3 copies of MODEL_OPTIONS with different labels, MODEL_INFO in
 * the tooltip component, ALLOWED_MODELS in the update-model route, the
 * toOpenClawModel map in ssh.ts, etc.). This registry collapses the
 * DISPLAY + VALIDATION + MAPPING surfaces into one place with an EXPLICIT
 * per-model credit weight (the money guardrail - no model gets a
 * substring-guessed weight; see CLAUDE.md "model browser" PRD).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS REGISTRY DOES NOT TOUCH (deliberate scope boundary):
 *
 *   • Live billing. The proxy computes cost_weight from `routingDecision.tier`
 *     mapped to {1,4,19} inline (app/api/gateway/proxy/route.ts:1762-1765 +
 *     :1815). It does NOT read this registry. `creditWeight` here governs
 *     (a) the tooltip display ("N credits per message"), (b) cron cost
 *     projection (lib/cron-guard.ts), and (c) FUTURE per-model billing once
 *     credit users' explicit picks are honored (the held "D1(B)" workstream).
 *     A registry weight is NOT a live charge until that ships.
 *
 *   • The router. lib/models.ts:TIER_MODELS still owns which model each tier
 *     auto-routes to. This registry is the catalog the PICKER shows; the
 *     router decides what a credit user actually gets.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * COST WEIGHTS (verified against lib/credit-constants.ts:MODEL_COST_WEIGHTS):
 *   minimax 0.2 · haiku 1 · sonnet 4 · opus 19
 * Any NEW model added here MUST carry an explicit `creditWeight`. Do not rely
 * on a substring fallback - that is exactly the bug the registry prevents
 * (e.g. "claude-fable-5" substring-falls-through to haiku=1, billing the
 * priciest model as the cheapest).
 */

export type ModelProvider = "anthropic";

export interface ModelEntry {
  /** Canonical InstaClaw model id (Anthropic wire format, bare - no provider prefix). */
  id: string;
  provider: ModelProvider;
  /** Coarse family for grouping in the browser. */
  family: "haiku" | "sonnet" | "opus" | "fable";
  /** Short display label used by the composer picker (e.g. "Sonnet 4.6"). */
  displayName: string;
  /** Vendor-prefixed label used on settings / dashboard (e.g. "Claude Sonnet 4.6"). */
  displayNameWithVendor: string;
  /**
   * EXPLICIT credit weight (credits charged per message IF this model is the
   * billed model). Verified against credit-constants. Never substring-guessed.
   */
  creditWeight: number;
  /** OpenClaw provider/model wire format (what lands in agents.defaults.model.primary). */
  openclawId: string;
  /**
   * User-selectable in the model picker. Internal models (heartbeat router's
   * minimax) are present for openclaw-id mapping coverage but never shown.
   */
  selectable: boolean;
  /**
   * Shown to CREDIT (all-inclusive) users. The BYOK-gate: credit users see only
   * the models the router actually honors (the auto-tier set); the full version
   * ladder + Fable are BYOK-only until D1(B) ships (router honoring explicit
   * picks for credit users). A model with creditVisible=false is still
   * `selectable` for BYOK users in the step-5 modal. As of step 4 this stays
   * the current 3 so the live composer picker is byte-identical (the modal +
   * the post-D1(A) flip to Opus 4.8 land in step 5).
   */
  creditVisible: boolean;
  /**
   * Previous-generation model kept for continuity. The step-5 modal collapses
   * legacy entries under their family so the catalog stays scannable.
   */
  legacy?: boolean;
  /**
   * Tier-gating flag - UNWIRED as of the registry refactor. Surfaced here so a
   * future "Fable to Pro+" decision is a one-field change (see PRD follow-up 2).
   * null = available to all tiers.
   */
  minTier: null | "starter" | "pro" | "power";
  /** Per-model tooltip copy. Dash-free per the no-em-dash standing rule. */
  tooltip: { desc: string; cost: string };
}

/**
 * The catalog. Step-1 registry refactor populates ONLY the currently-shipping
 * 3 selectable models (byte-identical to the pre-registry MODEL_OPTIONS) plus
 * the internal minimax entry (for toOpenClawModel coverage). New models
 * (Fable 5, Opus 4.8/4.7, legacy Sonnet/Opus 4.5) are added in a follow-up
 * step gated on the locked Fable weight + D1 decision.
 */
export const MODEL_REGISTRY: ModelEntry[] = [
  {
    id: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    family: "haiku",
    displayName: "Haiku 4.5",
    displayNameWithVendor: "Claude Haiku 4.5",
    creditWeight: 1,
    openclawId: "anthropic/claude-haiku-4-5-20251001",
    selectable: true,
    creditVisible: true,
    minTier: null,
    tooltip: {
      desc: "Fastest and most efficient. Best for quick questions, simple lookups, and rapid back-and-forth.",
      cost: "1 credit per message",
    },
  },
  {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    family: "sonnet",
    displayName: "Sonnet 4.6",
    displayNameWithVendor: "Claude Sonnet 4.6",
    creditWeight: 4,
    openclawId: "anthropic/claude-sonnet-4-6",
    selectable: true,
    creditVisible: true,
    minTier: null,
    tooltip: {
      desc: "The balanced default. Strong at everyday writing, coding, and analysis without the heavier cost. The right pick when you're unsure.",
      cost: "4 credits per message",
    },
  },
  {
    id: "claude-opus-4-6",
    provider: "anthropic",
    family: "opus",
    displayName: "Opus 4.6",
    displayNameWithVendor: "Claude Opus 4.6",
    creditWeight: 19,
    openclawId: "anthropic/claude-opus-4-6",
    selectable: true,
    creditVisible: true,
    minTier: null,
    tooltip: {
      desc: "The most capable, for hard reasoning and complex multi-step work where getting it exactly right is worth the higher cost.",
      cost: "19 credits per message",
    },
  },
  {
    // D1(A) flagship: auto-routed for tier-3 traffic (TIER_MODELS[3]).
    // creditVisible flips to true (replacing 4.6) in step 5 alongside the modal.
    id: "claude-opus-4-8",
    provider: "anthropic",
    family: "opus",
    displayName: "Opus 4.8",
    displayNameWithVendor: "Claude Opus 4.8",
    creditWeight: 19,
    openclawId: "anthropic/claude-opus-4-8",
    selectable: true,
    creditVisible: false,
    minTier: null,
    tooltip: {
      desc: "The latest and most capable Opus. Best for the hardest reasoning and complex multi-step work where getting it exactly right matters most.",
      cost: "19 credits per message",
    },
  },
  {
    id: "claude-opus-4-7",
    provider: "anthropic",
    family: "opus",
    displayName: "Opus 4.7",
    displayNameWithVendor: "Claude Opus 4.7",
    creditWeight: 19,
    openclawId: "anthropic/claude-opus-4-7",
    selectable: true,
    creditVisible: false,
    minTier: null,
    tooltip: {
      desc: "Prior flagship Opus. Strong reasoning; pick Opus 4.8 unless you specifically need this version.",
      cost: "19 credits per message",
    },
  },
  {
    id: "claude-sonnet-4-5-20250929",
    provider: "anthropic",
    family: "sonnet",
    displayName: "Sonnet 4.5",
    displayNameWithVendor: "Claude Sonnet 4.5",
    creditWeight: 4,
    openclawId: "anthropic/claude-sonnet-4-5-20250929",
    selectable: true,
    creditVisible: false,
    legacy: true,
    minTier: null,
    tooltip: {
      desc: "Previous-generation balanced model. Kept for continuity; Sonnet 4.6 is the current default.",
      cost: "4 credits per message",
    },
  },
  {
    id: "claude-opus-4-5-20251101",
    provider: "anthropic",
    family: "opus",
    displayName: "Opus 4.5",
    displayNameWithVendor: "Claude Opus 4.5",
    creditWeight: 19,
    openclawId: "anthropic/claude-opus-4-5-20251101",
    selectable: true,
    creditVisible: false,
    legacy: true,
    minTier: null,
    tooltip: {
      desc: "Previous-generation Opus. Kept for continuity; Opus 4.8 is the current flagship.",
      cost: "19 credits per message",
    },
  },
  {
    // Fable 5 - most powerful, priciest. creditWeight 38 (margin-equivalent to
    // Opus 19: 2x Anthropic cost = 2x credits). MUST NEVER be auto-routed
    // (enforced by the AUTO_ROUTE_FORBIDDEN guard in lib/model-router.ts).
    // creditVisible:false until D1(B) - cost only rises on a deliberate pick.
    id: "claude-fable-5",
    provider: "anthropic",
    family: "fable",
    displayName: "Fable 5",
    displayNameWithVendor: "Claude Fable 5",
    creditWeight: 38,
    openclawId: "anthropic/claude-fable-5",
    selectable: true,
    creditVisible: false,
    minTier: null,
    tooltip: {
      desc: "The most powerful model available, for the most demanding work. Highest cost per message; pick it deliberately.",
      cost: "38 credits per message",
    },
  },
  {
    // Internal heartbeat-router model. NOT user-selectable. Present so
    // toOpenClawModel's map derives its minimax entry from the registry.
    id: "minimax-m2.5",
    provider: "anthropic",
    family: "haiku",
    displayName: "MiniMax M2.5",
    displayNameWithVendor: "MiniMax M2.5",
    creditWeight: 0.2,
    openclawId: "anthropic/minimax-m2.5",
    selectable: false,
    creditVisible: false,
    minTier: null,
    tooltip: { desc: "", cost: "" },
  },
];

/** Fast id -> entry lookup. */
const MODEL_BY_ID = new Map<string, ModelEntry>(MODEL_REGISTRY.map((m) => [m.id, m]));

/** Look up a registry entry by canonical id. */
export function getModelEntry(id: string): ModelEntry | undefined {
  return MODEL_BY_ID.get(id);
}

/** User-selectable models (full catalog, BYOK-visible), in catalog order. */
export const SELECTABLE_MODELS: ModelEntry[] = MODEL_REGISTRY.filter((m) => m.selectable);

/**
 * Models shown to CREDIT (all-inclusive) users - the auto-tier set the router
 * actually honors (BYOK-gate). The simple composer picker reads from this so it
 * stays the current 3 until step 5's modal + the post-D1(A) Opus-4.8 flip.
 */
export const CREDIT_VISIBLE_MODELS: ModelEntry[] = SELECTABLE_MODELS.filter((m) => m.creditVisible);

/**
 * `{ id, label }` shape for the composer picker (short labels). Credit-visible
 * set only, so the live picker is byte-identical to the pre-registry list.
 * Replaces the hardcoded MODEL_OPTIONS in tasks/page.tsx.
 */
export const MODEL_OPTIONS: { id: string; label: string }[] = CREDIT_VISIBLE_MODELS.map((m) => ({
  id: m.id,
  label: m.displayName,
}));

/**
 * `{ id, label }` shape with vendor prefix for settings / dashboard.
 * Replaces the hardcoded MODEL_OPTIONS in settings/page.tsx + dashboard/page.tsx.
 */
export const MODEL_OPTIONS_WITH_VENDOR: { id: string; label: string }[] = CREDIT_VISIBLE_MODELS.map(
  (m) => ({ id: m.id, label: m.displayNameWithVendor }),
);

/**
 * Allow-list of selectable model ids for the update-model route's hard gate.
 * Full catalog (so BYOK users + the step-5 modal can pick any real model);
 * the credit-user picker is gated separately via CREDIT_VISIBLE_MODELS.
 */
export const ALLOWED_MODEL_IDS: string[] = SELECTABLE_MODELS.map((m) => m.id);

/**
 * Ids of every model directly callable via the Anthropic API (the selectable
 * claude models; minimax is gateway-only, excluded by selectable=false).
 * lib/models.ts:ANTHROPIC_MODELS derives from this so the direct-API fallback
 * allow-list can never drift from the catalog (the D1(A) blast-radius seam:
 * routeModel must never return an id the fallback routes reject).
 */
export const DIRECT_API_MODEL_IDS: string[] = SELECTABLE_MODELS.map((m) => m.id);

/**
 * Coarse router tier (1=cheap, 2=mid, 3=flagship) per family. lib/models.ts:
 * MODEL_TIERS derives from this. Fable is flagship-class (3) but NEVER
 * auto-routed (guarded in lib/model-router.ts).
 */
export function familyTier(family: ModelEntry["family"]): 1 | 2 | 3 {
  switch (family) {
    case "haiku":
      return 1;
    case "sonnet":
      return 2;
    case "opus":
    case "fable":
      return 3;
  }
}

/** id -> router tier, derived from family across the whole registry. */
export const MODEL_TIER_BY_ID: Record<string, 1 | 2 | 3> = Object.fromEntries(
  MODEL_REGISTRY.map((m) => [m.id, familyTier(m.family)]),
);

/**
 * Tooltip info keyed by id, for the ModelInfoButton component.
 * `name` mirrors the short displayName.
 */
export function getModelTooltip(
  id: string,
): { name: string; desc: string; cost: string } | undefined {
  const m = MODEL_BY_ID.get(id);
  if (!m || !m.selectable) return undefined;
  return { name: m.displayName, desc: m.tooltip.desc, cost: m.tooltip.cost };
}

/**
 * Bare-id -> openclaw wire-format map, derived from the registry. Consumed by
 * lib/ssh.ts:toOpenClawModel for the known-model lookup branch. Adding a model
 * to the registry automatically extends this map (one source of truth), while
 * toOpenClawModel keeps its load-bearing pass-through + shell-safety + fallback
 * logic unchanged (see the vm-974 idempotency P0 comment in ssh.ts).
 */
export const MODEL_OPENCLAW_MAP: Record<string, string> = Object.fromEntries(
  MODEL_REGISTRY.map((m) => [m.id, m.openclawId]),
);

/**
 * Registry-first credit weight. Returns the EXPLICIT weight when the id is in
 * the registry; otherwise a conservative substring fallback (matches
 * credit-constants.ts:getModelCostWeight semantics) so unknown strings never
 * throw. NOT used by the live billing path (tier-based) - see file header.
 */
export function getRegistryCreditWeight(id: string): number {
  const entry = MODEL_BY_ID.get(id);
  if (entry) return entry.creditWeight;
  const m = id.toLowerCase();
  if (m.includes("minimax")) return 0.2;
  if (m.includes("haiku")) return 1;
  if (m.includes("sonnet")) return 4;
  if (m.includes("opus")) return 19;
  return 1; // default - haiku-equivalent
}
