import { DIRECT_API_MODEL_IDS, MODEL_TIER_BY_ID } from "./model-registry";

/**
 * Models that can be called directly via the Anthropic API. Derived from the
 * single-source registry (selectable claude models; minimax is gateway-only,
 * excluded). This is the D1(A) blast-radius seam: when TIER_MODELS[3] bumped to
 * claude-opus-4-8, isAnthropicModel("claude-opus-4-8") MUST return true or the
 * direct-API fallback routes (chat/send, tasks/*, recurring-executor) would 502
 * the routed model. Deriving from the catalog makes that impossible to forget.
 */
const ANTHROPIC_MODELS = new Set(DIRECT_API_MODEL_IDS);

export function isAnthropicModel(model: string): boolean {
  return ANTHROPIC_MODELS.has(model);
}

/** Safe default when falling back to direct Anthropic API */
export const FALLBACK_MODEL = "claude-sonnet-4-6";

/**
 * Model tier classification (1=cheap, 2=mid, 3=expensive), derived from the
 * registry's family grouping. Superset of the old hardcoded map (same tiers
 * for the original 3 + minimax; adds the new catalog ids).
 */
export const MODEL_TIERS: Record<string, 1 | 2 | 3> = { ...MODEL_TIER_BY_ID };

/**
 * Canonical model ID for each tier. TIER_MODELS[3] is the flagship the router
 * auto-routes tier-3 traffic to. D1(A) (2026-06-09): bumped 4.6 -> 4.8.
 * Sonnet 4.6 stays tier 2. Fable is NEVER here (auto-route-forbidden guard).
 */
export const TIER_MODELS = {
  1: "claude-haiku-4-5-20251001",
  2: "claude-sonnet-4-6",
  3: "claude-opus-4-8",
} as const;

/** Per-tier daily call limits by subscription */
export const TIER_BUDGET_LIMITS = {
  starter: { sonnet: 30, opus: 5 },
  pro: { sonnet: 75, opus: 15 },
  power: { sonnet: 200, opus: 40 },
} as const;
