/**
 * Frontier — "what can this agent spend on its OWN, right now?" (pure).
 *
 * The dashboard must not imply more autonomy than the agent actually has. The
 * gate (frontier-policy.evaluateSpend + frontier-authz.decideAuthorization)
 * authorizes a single autonomous purchase iff ALL hold (humanApproved=false):
 *   - category known + allowed, not privacy mode
 *   - amount < justDoItPerTx                       (no-ask single-purchase ceiling)
 *   - spentToday + amount < justDoItPerDay         (no-ask daily band)
 *   - balance known AND balance - amount ≥ minWalletBalance   (drain floor)
 *   - spentToday + amount ≤ earnedDailyBudget      (THE keystone — earned autonomy)
 *   - and (route-level) the owner has opted in (frontier_spend_enabled)
 *
 * So the honest "headroom" is the BINDING MINIMUM of (earned remaining, daily-band
 * remaining, wallet − floor), zeroed when opt-in is off or balance is unreadable,
 * and the most useful thing to TELL the user is WHICH of those is the binding one.
 *
 * PURE + deterministic. The gate-consistency property is asserted in
 * scripts/_test-frontier-headroom.ts so this can never drift from what authorize does.
 */
import type { CreditStanding } from "./frontier-standing";
import type { TierBands } from "./frontier-policy";

export type HeadroomBinding =
  | "spend_disabled" // opt-in OFF — gate denies spend_not_enabled before anything else
  | "balance_unknown" // wallet balance unreadable — gate forces ask_first (never auto-spend blind)
  | "wallet" // wallet at/below the drain floor (or it's the smallest headroom)
  | "earned" // the agent's earned daily budget is the binding limit
  | "daily_limit"; // the no-ask daily band (what's left of it today) binds

export interface AutonomyHeadroom {
  spendEnabled: boolean;
  /** The agent's earned daily budget (the autonomy governor), USD. */
  earnedDailyBudgetUsd: number;
  /** Reserve-aware committed-today USD (the gate's spentToday). */
  spentTodayUsd: number;
  /** On-chain wallet balance, USD; null = unreadable. */
  walletBalanceUsd: number | null;
  earnedRemainingUsd: number;
  dailyLimitRemainingUsd: number;
  walletHeadroomUsd: number;
  /** No-ask single-purchase ceiling, capped by what's actually spendable today. */
  perPurchaseCapUsd: number;
  /**
   * Aggregate the agent COULD spend autonomously today if opted-in + balance known
   * = min(earnedRemaining, dailyLimitRemaining, walletHeadroom). Ignores the opt-in
   * gate so the OFF state can say "turn on to unlock ~$X".
   */
  potentialMaxTodayUsd: number;
  /**
   * Aggregate the agent CAN spend autonomously right now: 0 when opt-in is off or
   * balance is unreadable; else = potentialMaxTodayUsd. The honest headline number.
   */
  effectiveMaxTodayUsd: number;
  /** The single most-limiting factor on effectiveMaxTodayUsd. */
  binding: HeadroomBinding;
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Pick the binding factor = argmin, with the most-actionable message on ties. */
function pickBinding(
  earnedRemaining: number,
  dailyLimitRemaining: number,
  walletHeadroom: number,
): HeadroomBinding {
  const min = Math.min(earnedRemaining, dailyLimitRemaining, walletHeadroom);
  // wallet first (actionable: "fund the wallet"), then earned (the keystone story), then the daily cap.
  if (walletHeadroom <= min) return "wallet";
  if (earnedRemaining <= min) return "earned";
  return "daily_limit";
}

export function autonomousHeadroom(input: {
  spendEnabled: boolean;
  standing: Pick<CreditStanding, "earnedDailyBudgetUsd">;
  bands: Pick<TierBands, "justDoItPerTx" | "justDoItPerDay" | "minWalletBalance">;
  spentTodayUsd: number;
  walletBalanceUsd: number | null;
}): AutonomyHeadroom {
  const earned = input.standing.earnedDailyBudgetUsd;
  const spent = Math.max(0, input.spentTodayUsd);
  const balanceKnown =
    typeof input.walletBalanceUsd === "number" && Number.isFinite(input.walletBalanceUsd);

  const earnedRemaining = Math.max(0, r6(earned - spent));
  const dailyLimitRemaining = Math.max(0, r6(input.bands.justDoItPerDay - spent));
  const walletHeadroom = balanceKnown
    ? Math.max(0, r6((input.walletBalanceUsd as number) - input.bands.minWalletBalance))
    : 0;

  const potentialMaxToday = r6(Math.min(earnedRemaining, dailyLimitRemaining, walletHeadroom));
  const potentialBinding = pickBinding(earnedRemaining, dailyLimitRemaining, walletHeadroom);

  let effectiveMaxToday: number;
  let binding: HeadroomBinding;
  if (!input.spendEnabled) {
    effectiveMaxToday = 0;
    binding = "spend_disabled";
  } else if (!balanceKnown) {
    effectiveMaxToday = 0;
    binding = "balance_unknown";
  } else {
    effectiveMaxToday = potentialMaxToday;
    binding = potentialBinding;
  }

  return {
    spendEnabled: input.spendEnabled,
    earnedDailyBudgetUsd: r6(earned),
    spentTodayUsd: r6(spent),
    walletBalanceUsd: balanceKnown ? r6(input.walletBalanceUsd as number) : null,
    earnedRemainingUsd: earnedRemaining,
    dailyLimitRemainingUsd: dailyLimitRemaining,
    walletHeadroomUsd: walletHeadroom,
    perPurchaseCapUsd: r6(Math.min(input.bands.justDoItPerTx, effectiveMaxToday)),
    potentialMaxTodayUsd: potentialMaxToday,
    effectiveMaxTodayUsd: effectiveMaxToday,
    binding,
  };
}
