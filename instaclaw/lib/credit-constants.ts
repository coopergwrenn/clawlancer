/**
 * Centralized credit system constants.
 *
 * Single source of truth for tier limits, model costs, and budget parameters.
 * Imported by: proxy route, cron-guard, model-router, billing pages.
 *
 * WARNING: If you change cost weights here, you MUST also update the SQL RPCs
 * in Supabase (instaclaw_check_limit_only, instaclaw_increment_usage) which
 * have their own copy of these weights in CASE statements.
 */

/** Daily display limits per subscription tier (user-visible). */
export const TIER_DISPLAY_LIMITS: Record<string, number> = {
  starter: 600,
  pro: 1000,
  power: 2500,
  internal: 5000,
};

/**
 * Internal limits = display limits. The buffer was removed (2026-04-10) because
 * it didn't actually let users send more messages — both buffer zone and hard
 * block returned the same upsell response in the proxy. The 200-unit buffer
 * was vestigial and confusing users (their count went past 1000 visibly).
 * Heartbeats have their own separate budget (HEARTBEAT_DAILY_BUDGET).
 */
export const TIER_INTERNAL_LIMITS: Record<string, number> = {
  starter: 600,
  pro: 1000,
  power: 2500,
  internal: 5000,
};

/**
 * Model cost weights in credit units per API call.
 * MiniMax is the cheapest; Opus is the most expensive.
 */
export const MODEL_COST_WEIGHTS: Record<string, number> = {
  minimax: 0.2,
  haiku: 1,
  sonnet: 4,
  opus: 19,
};

/** Tool continuation calls are charged at this fraction of the base model cost. */
export const TOOL_CONTINUATION_DISCOUNT = 0.2;

/** Heartbeat calls have a separate daily budget (in credit units). */
export const HEARTBEAT_DAILY_BUDGET = 100;

/** Maximum API calls per single heartbeat cycle. */
export const HEARTBEAT_CYCLE_CAP = 10;

/**
 * Resolve model cost weight from a model string.
 * Matches on substring (e.g. "claude-sonnet-4-6" → 4).
 */
export function getModelCostWeight(model: string): number {
  const m = model.toLowerCase();
  if (m.includes("minimax")) return MODEL_COST_WEIGHTS.minimax;
  if (m.includes("haiku")) return MODEL_COST_WEIGHTS.haiku;
  if (m.includes("sonnet")) return MODEL_COST_WEIGHTS.sonnet;
  if (m.includes("opus")) return MODEL_COST_WEIGHTS.opus;
  return MODEL_COST_WEIGHTS.haiku; // default
}
