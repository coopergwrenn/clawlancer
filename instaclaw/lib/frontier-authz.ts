/**
 * Frontier — the authorization decision (PRD §1 Invention 1, the keystone). Pure.
 *
 * This is the function that turns an earned number into power. The standing
 * engine (frontier-standing) computes how much autonomy an agent has earned; the
 * policy engine (frontier-policy) computes what its human has permitted. This
 * function composes them into a single verdict on a real, about-to-happen spend.
 *
 * It is, as far as we know, the first place where an autonomous agent's earned
 * track record of good economic decisions gates a real financial transaction.
 * So the logic is written to be read, not just run.
 *
 * THREE GATES, in strict precedence:
 *
 *   1. HARD DENY (policy). Privacy mode, per-tx / daily ceilings, wallet-drain,
 *      an explicitly human-BANNED category. Absolute. Not even a human approval
 *      in this same request can push past it — to lift a hard limit you change
 *      the policy, you don't override it per-spend. evaluateSpend already emits
 *      these as decision === "deny".
 *
 *   2. AUTONOMY. When the human is not in the loop (humanApproved=false), the
 *      spend must clear BOTH the policy's just_do_it band AND the agent's earned
 *      daily budget:
 *        - policy says ask_first            → bounce to the human
 *        - category can't be identified     → bounce to the human (unknown ≠ banned)
 *        - just_do_it but over earned budget→ bounce to the human  ← the keystone line
 *        - just_do_it and within earned     → AUTONOMOUS. the agent acts alone.
 *
 *   3. HUMAN-APPROVED. When the human approved this spend, the autonomy gate is
 *      moot (the authority is the human's, exercised above the agent's earned
 *      ceiling) — but the hard denies from gate 1 still bind. A human approving a
 *      single spend does not silently lift a configured ceiling or category ban.
 *
 * The earned-budget ceiling is always ≤ the policy's just_do_it daily band (the
 * standing engine caps it there), so for autonomous spend the earned budget is
 * the binding constraint by construction. A brand-new agent with a $0.10 earned
 * budget cannot auto-spend $1 even where the tier policy would allow it; it must
 * ask. As it accumulates good, non-self-dealt, used, undisputed decisions, its
 * earned budget grows and the same spend becomes autonomous. That is graduated
 * autonomy, and it is the answer to "the agent refuses to spend" (Rule 28): the
 * agent isn't refusing — it is exercising exactly the autonomy it has earned.
 *
 * A2A-NATIVE: this function is supplier-agnostic. Whether the counterparty is a
 * fleet agent or an external Bazaar endpoint changes the inputs upstream
 * (verification, category), never this logic.
 *
 * PURE: no I/O, no time, no randomness. Tests: scripts/_test-frontier-authz.ts.
 */

import type { SpendEvaluation } from "./frontier-policy";
import type { CreditStanding } from "./frontier-standing";

export type AuthorizationMode = "autonomous" | "human_approved";

/** What the agent should do next. */
export type AuthorizationOutcome = "just_do_it" | "ask_first" | "deny";

export interface AuthorizationInput {
  /** The policy verdict (frontier-policy.evaluateSpend). */
  evaluation: SpendEvaluation;
  /** The agent's current standing (frontier-standing.creditStanding). */
  standing: CreditStanding;
  /** Settled + fresh-pending spend already committed today (frontier-ledger-db). */
  reserveAwareSpentTodayUsd: number;
  /** The proposed spend, USD. */
  amountUsd: number;
  /**
   * LEGACY forgeable approval signal (the raw `human_approved` body bool). Kept for
   * backward-compat with callers/tests that predate the tiered model. When the
   * tiered fields below are absent, this alone reproduces the original behavior
   * (honored at any amount). New callers should pass `humanApprovedForgeable`
   * explicitly instead. (Lifts the autonomy gate, not hard denies.)
   */
  humanApproved?: boolean;
  /**
   * The raw `human_approved` body bool, named for what it is: FORGEABLE. The agent
   * can set it (the gateway token authenticates the VM, not the human's intent). In
   * the tiered model it is honored only below `justDoItPerTxUsd` once the flip lands;
   * before the flip it is honored at all amounts (phase 1, zero break). When honored
   * it yields reason "human_approved" -> the route fires the notify+revoke surface.
   */
  humanApprovedForgeable?: boolean;
  /**
   * UNFORGEABLE approval: a matching, fresh, identity-bound `approved` row exists in
   * instaclaw_frontier_spend_approvals (the human approved THIS spend from their
   * browser session). Honored at ALL amounts -- it is the strict superset of
   * authority. Yields reason "human_approved_session" -> no notification (the user
   * just approved in-browser).
   */
  sessionApproved?: boolean;
  /**
   * The tier's just_do_it per-tx band (evaluation.effectiveBands.justDoItPerTx) -- the
   * calibrated autonomy line that is the Model-C threshold. amount >= this is "above
   * threshold". Absent -> Infinity -> nothing is ever above threshold -> legacy
   * behavior (forgeable honored everywhere).
   */
  justDoItPerTxUsd?: number;
  /**
   * The phase-3 flip (env FRONTIER_REQUIRE_SESSION_APPROVAL_ABOVE_THRESHOLD). When
   * true, a forgeable approval at/above the threshold no longer authorizes -- it
   * returns ask_first reason "needs_session_approval". Default false = phase 1.
   */
  requireSessionAboveThreshold?: boolean;
  /**
   * Could the purchase's capability category be identified? An unidentifiable
   * category is not auto-spendable (it isn't a known-safe kind) but isn't banned
   * either — so it bounces to the human rather than denying. A human-BANNED
   * category arrives here already as evaluation.decision === "deny".
   */
  categoryKnown: boolean;
}

export interface AuthorizationDecision {
  /** True iff a hold should be reserved and the agent may proceed to pay. */
  authorized: boolean;
  /** How it was authorized (null when not authorized). */
  mode: AuthorizationMode | null;
  /** The surfaced verdict for the agent + dashboard. */
  outcome: AuthorizationOutcome;
  /** Stable machine reason (telemetry + agent branching). */
  reason: string;
  /** The earned daily budget that gated this spend. */
  earnedDailyBudgetUsd: number;
  /** Earned headroom remaining after this spend would post (can be negative when over-budget). */
  remainingEarnedAfterUsd: number;
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

export function decideAuthorization(input: AuthorizationInput): AuthorizationDecision {
  const { evaluation, standing, reserveAwareSpentTodayUsd, amountUsd, categoryKnown } = input;

  // Tiered approval inputs, with legacy-preserving defaults. When the tiered fields
  // are absent (pre-tiered callers/tests), `forgeable` falls back to the legacy
  // `humanApproved`, `threshold` is Infinity (nothing is "above"), and the flip is
  // off -- so the logic reduces EXACTLY to the original "humanApproved honored at any
  // amount" behavior.
  const sessionApproved = input.sessionApproved ?? false;
  const forgeable = input.humanApprovedForgeable ?? input.humanApproved ?? false;
  const justDoItPerTxUsd = input.justDoItPerTxUsd ?? Infinity;
  const requireSessionAboveThreshold = input.requireSessionAboveThreshold ?? false;
  const aboveThreshold = amountUsd >= justDoItPerTxUsd;

  const earned = standing.earnedDailyBudgetUsd;
  const projected = reserveAwareSpentTodayUsd + amountUsd;
  const base = {
    earnedDailyBudgetUsd: earned,
    remainingEarnedAfterUsd: round6(earned - projected),
  };

  // ── Gate 1: hard policy deny — absolute, human cannot override per-spend. ──
  if (evaluation.decision === "deny") {
    return { authorized: false, mode: null, outcome: "deny", reason: evaluation.reason, ...base };
  }

  // ── Gate 3 (checked before the autonomy gate): human in the loop, tiered. ──
  // Hard denies are already handled above; a human approval lifts only the autonomy
  // gate (ask_first band, unknown category, earned-budget ceiling), never a hard limit.
  //
  // Two tiers (Model C). Session approval is unforgeable (a matching browser-session
  // approval row), so it is honored at ANY amount. The forgeable raw bool is honored
  // below the threshold always, and above the threshold ONLY until the flip lands.
  if (sessionApproved) {
    return {
      authorized: true,
      mode: "human_approved",
      outcome: "just_do_it",
      reason: "human_approved_session",
      ...base,
    };
  }
  if (forgeable) {
    if (aboveThreshold && requireSessionAboveThreshold) {
      // Post-flip: at/above the calibrated autonomy line the agent's word is not
      // enough -- only the human's browser session speaks. Bounce to session approval.
      return { authorized: false, mode: null, outcome: "ask_first", reason: "needs_session_approval", ...base };
    }
    return {
      authorized: true,
      mode: "human_approved",
      outcome: "just_do_it",
      reason: "human_approved", // forgeable-honored -> the route fires notify + revoke
      ...base,
    };
  }

  // ── Gate 2: autonomy. The agent is acting alone; every condition must hold. ──

  // 2a. Policy itself wants a human in the loop.
  if (evaluation.decision === "ask_first") {
    return { authorized: false, mode: null, outcome: "ask_first", reason: evaluation.reason, ...base };
  }

  // 2b. Unknown category is not auto-spendable (not banned, but not known-safe).
  if (!categoryKnown) {
    return { authorized: false, mode: null, outcome: "ask_first", reason: "unknown_category", ...base };
  }

  // 2c. THE KEYSTONE. Policy permits it autonomously, but has the agent earned
  //     enough autonomy to cover it? If not, it must ask. This single comparison
  //     is where an earned track record becomes the right to spend.
  if (projected > earned) {
    return {
      authorized: false,
      mode: null,
      outcome: "ask_first",
      reason: "exceeds_earned_budget",
      ...base,
    };
  }

  // 2e. Velocity-anomaly ask (Slice B #5b). A burst of brand-new counterparties in
  //     the rolling window (frontier-ledger TrackRecord.anomalyFlag — the farming /
  //     compromised-agent signal, surfaced explicitly on CreditStanding) raises
  //     friction even within earned budget. ADDITIVE-ONLY: reached only on the
  //     otherwise-autonomous path (¬deny via Gate 1, ¬human via Gate 3, just_do_it +
  //     known category, AND within earned via 2c above), and returns ONLY ask_first
  //     — it never authorizes and never denies. Being downstream of 2c it cannot
  //     bypass the earned-budget keystone (an over-budget spend already returned at
  //     2c). A clean agent (anomalyFlag !== true) falls through to 2d byte-identically.
  if (standing.anomalyFlag === true) {
    return { authorized: false, mode: null, outcome: "ask_first", reason: "velocity_anomaly", ...base };
  }

  // 2d. Within policy AND within earned autonomy → the agent acts on its own.
  return {
    authorized: true,
    mode: "autonomous",
    outcome: "just_do_it",
    reason: "within_earned_budget",
    ...base,
  };
}
