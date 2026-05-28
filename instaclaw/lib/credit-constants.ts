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
 * Infrastructure calls (call_type='infrastructure') have a separate daily
 * budget in cost-weight units, distinct from both the user's display limit
 * and the heartbeat budget. Set generously (500) so legitimate periodic
 * tasks have plenty of headroom — Expected steady-state per VM:
 *   - strip-thinking periodic summary at PERIODIC_SUMMARY_INTERVAL=7200s
 *     (2 hours) per session × ~5 active sessions × 1 cost_weight (haiku)
 *     = ~60 cost_weight/day worst-case
 *   - pre-archive summary triggered on session-cap events: typically
 *     <10/day fleet-side
 *   - Any future infrastructure caller is also bounded by this cap
 * The cap exists primarily as a runaway-prevention measure. If a future
 * bug causes infrastructure calls to fire in a loop, the per-day cap
 * forces a hard stop at 500 cost_weight (~$0.125 worth of Anthropic
 * haiku usage on our infrastructure account) instead of allowing
 * unbounded burn.
 *
 * Added: 2026-05-28 (incident: STRIP_THINKING_LLM_KILL_SWITCH_2026_05_28).
 * See CLAUDE.md Rule 69 (call_type taxonomy) and docs/postmortems/
 * 2026-05-28-strip-thinking-summary-overcharge.md.
 */
export const INFRASTRUCTURE_DAILY_BUDGET = 500;

/**
 * The canonical model for infrastructure calls. Forced regardless of the
 * x-model-override header value (which is a defense-in-depth signal, not
 * a routing override for infrastructure calls). The proxy uses this so
 * that even if a buggy infrastructure caller forgets to set x-model-
 * override, OR sets it to an expensive model by mistake, the request is
 * still routed to haiku at cost=1.
 */
export const INFRASTRUCTURE_FORCED_MODEL = "claude-haiku-4-5-20251001";

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
