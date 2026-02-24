/** Models that can be called directly via the Anthropic API */
const ANTHROPIC_MODELS = new Set([
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-5-20250820",
  "claude-opus-4-6",
]);

export function isAnthropicModel(model: string): boolean {
  return ANTHROPIC_MODELS.has(model);
}

/** Safe default when falling back to direct Anthropic API */
export const FALLBACK_MODEL = "claude-haiku-4-5-20251001";

/** Model tier classification (1=cheap, 2=mid, 3=expensive) */
export const MODEL_TIERS: Record<string, 1 | 2 | 3> = {
  "claude-haiku-4-5-20251001": 1,
  "claude-sonnet-4-5-20250929": 2,
  "claude-opus-4-5-20250820": 3,
  "claude-opus-4-6": 3,
  "minimax-m2.5": 1,
};

/** Canonical model ID for each tier */
export const TIER_MODELS = {
  1: "claude-haiku-4-5-20251001",
  2: "claude-sonnet-4-5-20250929",
  3: "claude-opus-4-6",
} as const;

/** Per-tier daily call limits by subscription */
export const TIER_BUDGET_LIMITS = {
  starter: { sonnet: 30, opus: 5 },
  pro: { sonnet: 75, opus: 15 },
  power: { sonnet: 200, opus: 40 },
} as const;
