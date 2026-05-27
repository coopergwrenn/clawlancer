/**
 * ToolRouter credits + endpoint weights — PRD §7.11 Task K.2.
 *
 * Per-tier monthly grants and per-endpoint weights. The user-facing unit
 * is "premium searches" (Higgsfield-credit-style weighted abstraction).
 * Internally, 1 premium search ≈ $0.007 of platform x402 cost (the Exa
 * baseline). Weights for other endpoints scale to underlying cost ratios,
 * producing uniform ~93% margin across endpoint types at top-up tier.
 *
 * Source of truth: lib/toolrouter-credits.ts (TS) AND the RPC's
 * tier-grant CASE block in supabase/pending_migrations/<ts>_toolrouter_allocation.sql.
 * Both must agree. When tuning, update BOTH and Rule-64 the canary.
 */

export const TOOLROUTER_TIER_GRANTS = {
  free_trial: 20,
  starter: 60,
  pro: 400,
  power: 1500,
  byok: 60,
} as const;

export type TierName = keyof typeof TOOLROUTER_TIER_GRANTS;

export const TOOLROUTER_TOPUP_PACK = {
  pack_slug: "toolrouter_100",
  credits: 100,
  price_usd: 10,
  label: "100 premium searches — $10",
  envKey: "STRIPE_PRICE_TOOLROUTER_100",
} as const;

/**
 * Soft-hint threshold for M2 ("p.s. you're at about 80%..."). Wrapped
 * here so future tuning is a one-line constant change + manual M2 string
 * update (see §5.3.3 Issue 9 note).
 */
export const SOFT_HINT_THRESHOLD = 0.80;

/**
 * Per-endpoint weight table. PRD §5.3.7.
 *
 * Numbers are integers (premium-search units). Functions return an
 * integer per call when args (like depth or URL count) shift cost.
 *
 * Calibration: 1 unit ≈ $0.007 platform cost (Exa baseline). Manus deep
 * = $0.10 → 15 units. Browserbase = $0.02 → 3 units. AgentMail create
 * inbox = $2.01 → 287 units (high-cost one-time setup; intentional).
 */
type WeightFn = (args: Record<string, unknown> | null | undefined) => number;
type WeightValue = number | WeightFn;

export const TOOLROUTER_ENDPOINT_WEIGHTS: Readonly<Record<string, WeightValue>> = Object.freeze({
  // Search
  "exa.search": 1,
  "parallel.search": 2,

  // Extract — per-URL (cap of 20 URLs per call, defensive max 40 in case args.urls is huge)
  "parallel.extract": (args: Record<string, unknown> | null | undefined) => {
    const urls = (args?.urls as unknown[]) ?? [];
    const count = Array.isArray(urls) ? Math.max(1, Math.min(urls.length, 20)) : 1;
    return count * 2;
  },

  // Research (async — depth-priced)
  "manus.research": (args: Record<string, unknown> | null | undefined) => {
    const depth = (args?.depth as string) ?? "standard";
    if (depth === "quick") return 5;
    if (depth === "deep") return 15;
    return 8; // standard
  },
  "parallel.task": (args: Record<string, unknown> | null | undefined) => {
    const p = (args?.processor as string) ?? "base";
    return ({ lite: 3, base: 4, core: 6, pro: 16, ultra: 45 } as Record<string, number>)[p] ?? 4;
  },

  // Browser
  "browserbase.session": 3,

  // Email
  "agentmail.send_message": 3,
  "agentmail.reply_to_message": 3,
  "agentmail.create_inbox": 287,
  "agentmail.list_messages": 0,
  "agentmail.get_message": 0,

  // Travel
  "stabletravel.locations": 2,
  "stabletravel.google_flights_search": 5,
  "stabletravel.hotels_list": 4,
  "stabletravel.hotels_search": 5,
  "stabletravel.flightaware_flights": 5,
});

/**
 * Resolve the weight for a specific call. Unknown endpoint → 5 (safe
 * default; covers ~$0.05 worst-case).
 */
export function toolrouterWeight(endpointId: string, args?: Record<string, unknown> | null): number {
  const w = TOOLROUTER_ENDPOINT_WEIGHTS[endpointId];
  if (typeof w === "function") return w(args ?? {});
  if (typeof w === "number") return w;
  return 5;
}

/** Resolve the monthly grant for a tier name. Unknown tier → starter. */
export function toolrouterTierGrant(tier: string | null | undefined): number {
  if (tier && tier in TOOLROUTER_TIER_GRANTS) {
    return TOOLROUTER_TIER_GRANTS[tier as TierName];
  }
  return TOOLROUTER_TIER_GRANTS.starter;
}
