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

/** Defaults straight from PRD §6.6. Non-staker. */
export const DEFAULT_BANDS_BY_TIER: Record<FrontierTier, TierBands> = {
  starter: { justDoItPerTx: 1, justDoItPerDay: 5, neverPerTx: 10, neverPerDay: 25, minWalletBalance: 2 },
  pro: { justDoItPerTx: 5, justDoItPerDay: 25, neverPerTx: 50, neverPerDay: 200, minWalletBalance: 10 },
  power: { justDoItPerTx: 20, justDoItPerDay: 100, neverPerTx: 200, neverPerDay: 1000, minWalletBalance: 25 },
};

/** Stakers get 2x ceilings (caps), floor unchanged. */
const STAKER_CEILING_MULTIPLIER = 2;

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
}

export interface SpendEvaluation {
  decision: SpendDecision;
  /** Machine-readable reason, stable for logging/telemetry. */
  reason: string;
  /** The effective bands used (post-staker-multiplier) — for transparency. */
  effectiveBands: TierBands;
}

/** Apply the staker 2x ceiling multiplier (floor untouched). */
export function effectiveBands(tier: FrontierTier, isStaker: boolean): TierBands {
  const base = DEFAULT_BANDS_BY_TIER[tier];
  if (!isStaker) return base;
  return {
    justDoItPerTx: base.justDoItPerTx * STAKER_CEILING_MULTIPLIER,
    justDoItPerDay: base.justDoItPerDay * STAKER_CEILING_MULTIPLIER,
    neverPerTx: base.neverPerTx * STAKER_CEILING_MULTIPLIER,
    neverPerDay: base.neverPerDay * STAKER_CEILING_MULTIPLIER,
    minWalletBalance: base.minWalletBalance, // floor, not a ceiling — unchanged
  };
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
  const bands = effectiveBands(tier, ctx.isStaker ?? false);
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
