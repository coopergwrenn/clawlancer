/**
 * Frontier — autonomy spend gate (pure logic, no I/O).
 *
 * The single source of truth for "is this agent allowed to spend this much
 * right now?" Used by the VM-side `frontier.spend` tool (via a thin wrapper)
 * AND the dashboard `/api/agent-economy/policy` endpoint, so the same bands
 * are enforced in both places.
 *
 * Decision tiers (PRD instaclaw/docs/prd/agent-economy-os-2026-05-12.md §6.6):
 *   just_do_it — pre-approved, agent acts immediately
 *   ask_first  — post a Telegram 👍/👎 confirmation, wait for the human
 *   deny       — refuse outright (over hard ceiling, would drain, privacy, etc.)
 *
 * Safety properties this module guarantees (audit risk #2 + Rule 22):
 *   1. Daily cap is enforced on the AGGREGATE (spent_today + amount), so an
 *      agent cannot chain many sub-per-tx spends to blow past the daily cap.
 *   2. The wallet "never drain" floor is enforced — a spend that would drop the
 *      balance below the tier's min is denied regardless of the amount bands.
 *   3. Privacy mode is strict-read-only — ANY spend is denied while it's on.
 *   4. Unknown wallet balance never auto-approves: a would-be just_do_it with an
 *      unverifiable balance is downgraded to ask_first (fail-toward-human, not
 *      fail-toward-spend).
 *   5. $INSTACLAW stakers get 2x ceilings (the per-tx + per-day caps), but the
 *      drain floor is unchanged (a floor is not a ceiling).
 *
 * Pure + deterministic: no Date.now, no network, no DB. Trivially testable —
 * see scripts/_test-frontier-policy.ts.
 */

export type FrontierTier = "starter" | "pro" | "power";

export type SpendDecision = "just_do_it" | "ask_first" | "deny";

/** The per-tier autonomy bands. All amounts in USD. */
export interface TierBands {
  /** Below this per-tx AND below justDoItPerDay aggregate → just_do_it. */
  justDoItPerTx: number;
  justDoItPerDay: number;
  /** Above this per-tx OR above neverPerDay aggregate → deny. */
  neverPerTx: number;
  neverPerDay: number;
  /** Wallet must retain at least this much after the spend, else deny. */
  minWalletBalance: number;
}

/**
 * Defaults from PRD §6.6 (non-staker), EXCEPT minWalletBalance — flattened to a
 * flat $0.10 dust floor across all tiers (Slice B #2a, 2026-06-09). The wallet
 * reserve is now a true dust floor; the §16.5 low-balance warning (a live,
 * floor-relative Slice-A nudge — "about a day of spending left") is the runway
 * protection, replacing the old hard $2/$10/$25 stop. Fleet-wide on deploy, not
 * opt-in; benign direction (agent can spend nearer to empty) and reversible.
 */
export const DEFAULT_BANDS_BY_TIER: Record<FrontierTier, TierBands> = {
  starter: { justDoItPerTx: 1, justDoItPerDay: 5, neverPerTx: 10, neverPerDay: 25, minWalletBalance: 0.1 },
  pro: { justDoItPerTx: 5, justDoItPerDay: 25, neverPerTx: 50, neverPerDay: 200, minWalletBalance: 0.1 },
  power: { justDoItPerTx: 20, justDoItPerDay: 100, neverPerTx: 200, neverPerDay: 1000, minWalletBalance: 0.1 },
};

/** Stakers get 2x ceilings (caps), floor unchanged. */
const STAKER_CEILING_MULTIPLIER = 2;

/** Per-VM autonomy overrides (dashboard-set). Any subset of the bands. */
export type PolicyOverrides = Partial<Record<keyof TierBands, number>>;

/**
 * Apply user overrides to a band set. FOUR bands are TIGHTEN-ONLY — the dashboard
 * can make an agent more conservative, never more aggressive: neverPerTx / neverPerDay
 * (hard ceilings) can only go DOWN, the wallet floor can only go UP, and justDoItPerDay
 * (the no-ask DAILY band) can only go DOWN. The ONE band the user may RAISE is
 * justDoItPerTx — the per-transaction no-ask line — up to the hard per-tx ceiling
 * neverPerTx (the Slice-B §5 ceiling reversal: "grant a ceiling, the agent earns toward
 * it"). Raising it widens only WILLINGNESS to auto-spend per-transaction; the agent's
 * earned daily budget (decideAuthorization gate 2c) is the real, independent bound on
 * autonomous spend, so a high ceiling on a low-earned agent still ASKS. Invalid override
 * values (negative / non-finite / absent) silently fall back to the base (the agent
 * never ends up LESS safe because of a bad override).
 */
export function clampOverrides(base: TierBands, ov: PolicyOverrides): TierBands {
  const at = (v: number | undefined, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
  const neverPerTx = Math.min(base.neverPerTx, at(ov.neverPerTx, base.neverPerTx));
  const neverPerDay = Math.min(base.neverPerDay, at(ov.neverPerDay, base.neverPerDay));
  const minWalletBalance = Math.max(base.minWalletBalance, at(ov.minWalletBalance, base.minWalletBalance));
  // justDoItPerTx (the per-tx no-ask line) is USER-RAISABLE up to neverPerTx (§5
  // ceiling reversal) — the `base` cap is intentionally ABSENT so an override may
  // exceed the tier default. Math.min(neverPerTx, …) keeps it ≤ the hard per-tx
  // ceiling, so just_do_it can never exceed the deny line (neverPerTx). It is safe to
  // raise because the earned-budget gate (decideAuthorization 2c), which reads
  // justDoItPerDay — NOT justDoItPerTx — is the binding autonomous-spend limit.
  const justDoItPerTx = Math.min(neverPerTx, at(ov.justDoItPerTx, base.justDoItPerTx));
  const justDoItPerDay = Math.min(base.justDoItPerDay, at(ov.justDoItPerDay, base.justDoItPerDay), neverPerDay);
  return { justDoItPerTx, justDoItPerDay, neverPerTx, neverPerDay, minWalletBalance };
}

export interface SpendContext {
  amountUsd: number;
  /** Sum of today's already-settled + pending spends, in USD. */
  spentTodayUsd: number;
  /** Current spendable wallet balance in USD. null/undefined = unknown. */
  walletBalanceUsd?: number | null;
  /** True while Maximum Privacy Mode is on (operator can't audit → no spend). */
  privacyModeOn: boolean;
  /** Whether the counterparty is AgentBook/World-ID verified. */
  counterpartyVerified: boolean;
  /** Whether the owner holds the staking threshold (2x ceilings). */
  isStaker?: boolean;
  /**
   * Whether this spend requires a verified counterparty. Default true.
   * (Paying an arbitrary public x402 endpoint may set this false deliberately;
   * accepting funds / agent-to-agent commerce keeps it true.)
   */
  requireVerifiedCounterparty?: boolean;
  /** Per-VM dashboard overrides (tighten-only; see clampOverrides). */
  overrides?: PolicyOverrides | null;
  /** The capability category of this purchase (W3). Omit to skip the category gate. */
  category?: SpendCategory;
  /**
   * Categories the agent may buy autonomously (human-set; defaults per tier via
   * DEFAULT_ALLOWED_CATEGORIES_BY_TIER). Omit to skip the category gate
   * (backward-compatible). If provided, a `category` not in this list → deny.
   */
  allowedCategories?: readonly SpendCategory[];
}

export interface SpendEvaluation {
  decision: SpendDecision;
  /** Machine-readable reason, stable for logging/telemetry. */
  reason: string;
  /** The effective bands used (post-staker-multiplier) — for transparency. */
  effectiveBands: TierBands;
}

/**
 * Resolve the effective bands: tier defaults → staker 2x ceilings (floor
 * untouched) → tighten-only user overrides. Order matters: staking loosens,
 * overrides may only tighten what's left.
 */
export function effectiveBands(
  tier: FrontierTier,
  isStaker: boolean,
  overrides?: PolicyOverrides | null,
): TierBands {
  const base = DEFAULT_BANDS_BY_TIER[tier];
  const staked: TierBands = isStaker
    ? {
        justDoItPerTx: base.justDoItPerTx * STAKER_CEILING_MULTIPLIER,
        justDoItPerDay: base.justDoItPerDay * STAKER_CEILING_MULTIPLIER,
        neverPerTx: base.neverPerTx * STAKER_CEILING_MULTIPLIER,
        neverPerDay: base.neverPerDay * STAKER_CEILING_MULTIPLIER,
        minWalletBalance: base.minWalletBalance, // floor, not a ceiling — unchanged
      }
    : base;
  return overrides ? clampOverrides(staked, overrides) : staked;
}

/**
 * Evaluate a proposed spend against the tier's autonomy bands.
 *
 * Precedence (deny checks first, then the just_do_it / ask_first split):
 *   1. amount must be a positive finite number          → else deny(invalid_amount)
 *   2. privacy mode on                                  → deny(privacy_mode)
 *   3. counterparty required-but-unverified             → deny(unverified_counterparty)
 *   4. amount > neverPerTx                              → deny(exceeds_per_tx_ceiling)
 *   5. spentToday + amount > neverPerDay                → deny(exceeds_daily_ceiling)
 *   6. known balance and (balance - amount < minBal)   → deny(would_drain_wallet)
 *   7. amount < justDoItPerTx AND agg < justDoItPerDay  → just_do_it
 *      (but if balance is UNKNOWN, downgrade to ask_first — never auto-spend blind)
 *   8. otherwise                                        → ask_first
 */
export function evaluateSpend(tier: FrontierTier, ctx: SpendContext): SpendEvaluation {
  const bands = effectiveBands(tier, ctx.isStaker ?? false, ctx.overrides);
  const requireVerified = ctx.requireVerifiedCounterparty ?? true;
  const amount = ctx.amountUsd;
  const spentToday = ctx.spentTodayUsd;
  const agg = spentToday + amount;

  const result = (decision: SpendDecision, reason: string): SpendEvaluation => ({
    decision,
    reason,
    effectiveBands: bands,
  });

  // 1. Validate the amount.
  if (!Number.isFinite(amount) || amount <= 0) {
    return result("deny", "invalid_amount");
  }
  if (!Number.isFinite(spentToday) || spentToday < 0) {
    return result("deny", "invalid_spent_today");
  }

  // 2. Privacy mode → strict read-only.
  if (ctx.privacyModeOn) {
    return result("deny", "privacy_mode");
  }

  // 3. Counterparty trust.
  if (requireVerified && !ctx.counterpartyVerified) {
    return result("deny", "unverified_counterparty");
  }

  // 3.5 Category allowlist (W3) — a human-set safety boundary on WHAT may be
  // bought. Enforced only when both the purchase category and an allowlist are
  // provided (backward-compatible: omit either to skip).
  if (ctx.category && ctx.allowedCategories && !ctx.allowedCategories.includes(ctx.category)) {
    return result("deny", "category_not_allowed");
  }

  // 4–5. Hard ceilings (per-tx, then aggregate daily).
  if (amount > bands.neverPerTx) {
    return result("deny", "exceeds_per_tx_ceiling");
  }
  if (agg > bands.neverPerDay) {
    return result("deny", "exceeds_daily_ceiling");
  }

  // 6. Drain guard — only enforceable when balance is known.
  const balanceKnown =
    ctx.walletBalanceUsd !== null &&
    ctx.walletBalanceUsd !== undefined &&
    Number.isFinite(ctx.walletBalanceUsd);
  if (balanceKnown && (ctx.walletBalanceUsd as number) - amount < bands.minWalletBalance) {
    return result("deny", "would_drain_wallet");
  }

  // 7. just_do_it — strictly below both per-tx and daily just-do-it bands.
  const withinJustDoIt = amount < bands.justDoItPerTx && agg < bands.justDoItPerDay;
  if (withinJustDoIt) {
    // Never auto-approve a spend we can't verify funds for.
    if (!balanceKnown) {
      return result("ask_first", "just_do_it_but_balance_unknown");
    }
    return result("just_do_it", "within_just_do_it_band");
  }

  // 8. Everything else falls in the ask-first band.
  return result("ask_first", "within_ask_first_band");
}

// ───────────────────────────────────────────────────────────────────────────
// W3 — Category model (PRD §7.3 diversity factor + the spend category allowlist).
// A capability taxonomy + Bazaar-tag mapping + per-tier default allowlists. The
// allowlist is a SAFETY dimension: a human can restrict what KINDS of things the
// agent may buy ("data + search, never trading"). Categories also feed the
// activity-diversity factor of the credit score (frontier-ledger).
// ───────────────────────────────────────────────────────────────────────────

export type SpendCategory =
  | "data" // prices, feeds, datasets, weather, telemetry
  | "search" // web/search/scrape/intelligence
  | "inference" // LLM/GPU/model inference
  | "compute" // sandboxes, code execution, rendering
  | "market" // prediction markets, trading signals, on-chain market data
  | "media" // images, audio, video generation
  | "agent" // hiring another agent's service (A2A)
  | "other";

export const ALL_CATEGORIES: readonly SpendCategory[] = [
  "data", "search", "inference", "compute", "market", "media", "agent", "other",
];

/** Bazaar tag → category. First match wins; unknown tags → null (caller defaults to "other"). */
const TAG_CATEGORY_RULES: ReadonlyArray<[RegExp, SpendCategory]> = [
  [/price|feed|market[_-]?cap|ticker|ohlc|telemetry|weather|dataset|data\b/i, "data"],
  [/search|scrape|crawl|serp|web[_-]?search|intelligence|lookup/i, "search"],
  [/inference|llm|gpt|llama|mistral|embedding|model|completion|gpu/i, "inference"],
  [/compute|sandbox|exec|render|build|container/i, "compute"],
  [/prediction|polymarket|trade|trading|signal|defi|swap|orderbook/i, "market"],
  [/image|audio|video|tts|speech|music|render/i, "media"],
  [/agent|a2a|hire|delegate/i, "agent"],
];

/** Map a resource's tags to a single category (the first rule any tag matches). */
export function mapTagsToCategory(tags: string[] | null | undefined): SpendCategory | null {
  if (!tags || tags.length === 0) return null;
  for (const [re, cat] of TAG_CATEGORY_RULES) {
    if (tags.some((t) => re.test(t))) return cat;
  }
  return null;
}

/**
 * Default category allowlist per tier. Conservative-by-default: the categories an
 * agent may buy autonomously without an explicit human opt-in. "market" (trading
 * adjacency) is OFF by default at every tier — buying trading signals/DeFi actions
 * is the category most likely to cause harm, so it requires deliberate opt-in.
 * The human can widen or narrow this from the dashboard (stored as an override).
 */
export const DEFAULT_ALLOWED_CATEGORIES_BY_TIER: Record<FrontierTier, readonly SpendCategory[]> = {
  starter: ["data", "search", "agent"],
  pro: ["data", "search", "inference", "compute", "media", "agent"],
  power: ["data", "search", "inference", "compute", "media", "agent", "other"],
  // "market" intentionally excluded from all defaults — opt-in only.
};

/**
 * Resolve the EFFECTIVE autonomous-spend category allowlist for a VM, given the
 * tier default and an optional per-VM override (dashboard-set).
 *
 * TIGHTEN-ONLY, by the same safety philosophy as clampOverrides for the bands:
 * the override may only REMOVE categories from the tier default, never add one.
 * The effective set is therefore `tierDefault ∩ override`. Consequences:
 *   - override null/undefined        → the tier default, unchanged.
 *   - override present               → intersection; any category the user listed
 *                                       that isn't in their tier default is dropped
 *                                       (an agent can never autonomously buy a
 *                                       category above its tier — incl. "market",
 *                                       which is in NO tier default, so it can never
 *                                       be enabled via this path).
 *   - empty intersection             → allowed: the user turned everything off, so
 *                                       every categorized spend bounces to ask_first
 *                                       (uncategorized spends already do — authz 2b).
 *
 * Widening (especially opting INTO "market"/trading) is a deliberate risk decision,
 * NOT a free dashboard toggle — it would need a separate, explicitly-gated feature.
 * Keeping this tighten-only means the dashboard category control can never make an
 * agent able to autonomously spend on a riskier category than its tier permits.
 *
 * Pure + deterministic. Tests: scripts/_test-frontier-policy.ts.
 */
export function effectiveAllowedCategories(
  tier: FrontierTier,
  override: readonly SpendCategory[] | null | undefined,
): readonly SpendCategory[] {
  const tierDefault = DEFAULT_ALLOWED_CATEGORIES_BY_TIER[tier];
  if (!override) return tierDefault;
  const requested = new Set(override);
  return tierDefault.filter((c) => requested.has(c));
}
