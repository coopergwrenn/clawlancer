/**
 * Frontier autonomous-spend opt-in — the user-owned switch (the §8.7 "mandate").
 *
 * Autonomous money-spending is OFF by default and only the user can turn it on. An
 * agent has spend authority ONLY if its owner explicitly enabled it for that agent.
 * The flag lives on `instaclaw_vms.frontier_spend_enabled` (per-agent, because each
 * VM has its own wallet; the user owns the toggle). The /authorize gate checks this
 * FIRST — before standing/budget/category/drain logic — and denies with reason
 * `spend_not_enabled` when it's not explicitly true.
 *
 * FAIL-CLOSED (the opposite of the C21 kill switch, which is fail-OPEN — and that
 * difference is deliberate):
 *   - kill switch: a DB blip must NOT halt the fleet → fail OPEN (don't kill on error).
 *   - this opt-in:  we must NEVER spend on an unreadable/absent/missing opt-in → fail
 *     CLOSED. Anything other than an explicit boolean `true` (undefined column,
 *     null, false, missing row) means NOT enabled = no autonomous spend.
 *
 * This reads off the `vm` row already loaded by `lookupVMByGatewayToken(token, "*")`,
 * so there is no separate query to fail: if the vm load itself failed, authorize has
 * already returned 401 (no spend). Strict `=== true` is the whole safety property.
 *
 * Future shape (not built now): this is the first per-agent spend preference; the
 * eventual home for the §5 Q1–Q4 per-user choices (budget override, category
 * allowlist, ask_first routing). Today it is only the boolean opt-in.
 */

import { isSessionRequiredCategory, type SpendCategory } from "@/lib/frontier-policy";

/** True ONLY if the owner explicitly enabled autonomous spend for this agent. Fail-closed. */
export function isFrontierSpendEnabled(
  vm: { frontier_spend_enabled?: boolean | null } | null | undefined,
): boolean {
  return vm?.frontier_spend_enabled === true;
}

/**
 * Is the user's spend mandate satisfied for THIS spend? (The travel decouple,
 * ruled 2026-06-12: hotel booking is not autonomous spending.)
 *
 * There are TWO forms of user mandate, and they gate DIFFERENT things:
 *
 *   1. The STANDING mandate — `frontier_spend_enabled` (above). "My agent may
 *      move my money on its own initiative." Required for every category where
 *      autonomous spend is possible.
 *
 *   2. The PER-SPEND mandate — the unforgeable browser-session approval tap
 *      (instaclaw_frontier_spend_approvals; lib/frontier-approval-io). "I
 *      approve THIS exact spend (amount@6dp + category + counterparty), now."
 *
 * For SESSION-REQUIRED categories (lib/frontier-policy.SESSION_REQUIRED_CATEGORIES
 * — travel), form 2 is the ONLY path money can move, by construction:
 *   - their band layer pins justDoItPerTx/PerDay to $0 (travelBands) → the
 *     autonomous path (authz Gate 2) is unreachable;
 *   - disallowForgeableApproval (red-team F2) → the forgeable human_approved
 *     bool can never authorize them;
 *   - so the only authorizing branch is Gate 3 reason "human_approved_session".
 * Demanding form 1 for these categories conflates two different powers: it adds
 * zero protection (the fresh tap is strictly stronger consent than a standing
 * toggle) and blocks a funded, approving user from a thing they're allowed to
 * do. So the mandate for a session-required category is satisfied STRUCTURALLY.
 *
 * GUARANTEED BY (the exemption and the guarantee share one source of truth, so
 * they cannot drift apart):
 *   - SESSION_REQUIRED_CATEGORIES drives BOTH this exemption AND the
 *     disallowForgeable hardening in the authorize route;
 *   - the Rule-31 invariant test (scripts/_test-frontier-session-decouple.ts)
 *     asserts every session-required category has $0 just-do-it bands under
 *     every tier AND under adversarial overrides;
 *   - the belt-and-braces reserve guard (frontier-authz.blocksUnmandatedReserve)
 *     refuses to reserve ANY non-session-approved spend when the standing
 *     mandate is absent — so even a future session-required category that
 *     somehow regained autonomous bands could not spend without the tap.
 *
 * Considered consequence (deliberate): a user who REVOKES the standing mandate
 * (revoke-spend / spend-settings off) can still book travel via fresh taps —
 * revoke withdraws the agent's autonomous authority; a tap is new, explicit,
 * per-spend consent. The user-facing "turn travel off" lever is the per-VM
 * category override (a Gate-1 hard deny that even a tap cannot override), and
 * the operator kill switches stop everything.
 *
 * Fail-closed inheritance: an unknown/null category is NOT session-required,
 * so it falls back to requiring the standing mandate (form 1).
 */
export function spendMandateSatisfied(
  vm: { frontier_spend_enabled?: boolean | null } | null | undefined,
  category: SpendCategory | null | undefined,
): boolean {
  return isFrontierSpendEnabled(vm) || isSessionRequiredCategory(category);
}
