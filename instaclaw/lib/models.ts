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
