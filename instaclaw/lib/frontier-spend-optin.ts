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

/** True ONLY if the owner explicitly enabled autonomous spend for this agent. Fail-closed. */
export function isFrontierSpendEnabled(
  vm: { frontier_spend_enabled?: boolean | null } | null | undefined,
): boolean {
  return vm?.frontier_spend_enabled === true;
}
