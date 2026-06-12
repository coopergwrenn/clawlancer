/**
 * Tier-0 A failure-mode tests (Rule 31). Pure/synthetic — no DB.
 *
 *   - gateForReason maps every code-grounded reason to its gate (and unknown → other)
 *   - recordSpendEvent NEVER throws: not on an insert error, not on a thrown
 *     insert, not on a structurally-broken supabase handle. This is the load-bearing
 *     property — the verdict log is the sanctioned fail-open (Rule 77); a spend
 *     decision must never break because the audit write hiccupped.
 *   - gate is derived from reason when not explicitly supplied.
 *
 * Run: npx tsx scripts/_test-frontier-spend-log.ts
 */
import { gateForReason, recordSpendEvent, type SpendEvent } from "../lib/frontier-spend-log";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── gateForReason: every emitted reason → its gate ──
console.log("gateForReason — code-grounded mapping:");
const REASON_GATE: Array<[string, string]> = [
  ["spend_kill_switch", "kill_switch"],
  ["spend_kill_switch_unverifiable", "kill_switch"],
  ["spend_not_enabled", "opt_in"],
  ["human_approved_session", "session_approval"],
  ["needs_session_approval", "session_approval"],
  ["human_approved", "session_approval"],
  ["approval_identity_mismatch", "session_approval"],
  ["exceeds_earned_budget", "earned_budget"],
  ["within_earned_budget", "earned_budget"],
  ["velocity_anomaly", "velocity_anomaly"],
  ["unknown_category", "policy_category"],
  ["privacy_mode", "privacy"],
  ["unverified_counterparty", "counterparty"],
  ["exceeds_per_tx_ceiling", "ceiling"],
  ["exceeds_daily_ceiling", "ceiling"],
  ["would_drain_wallet", "wallet_balance"],
  ["within_just_do_it_band", "policy_band"],
  ["within_ask_first_band", "policy_band"],
  ["request_id_consumed", "idempotency"],
];
for (const [reason, gate] of REASON_GATE) {
  check(`${reason} → ${gate}`, gateForReason(reason) === gate);
}
check("unknown reason → other", gateForReason("totally_made_up_reason") === "other");
check("null reason → other", gateForReason(null) === "other");
check("undefined reason → other", gateForReason(undefined) === "other");

// ── recordSpendEvent: NEVER throws ── (async IIFE — CJS harness has no TLA)
const ev: SpendEvent = { decision_point: "authorize", vm_id: "vm-1", verdict: "deny", reason: "exceeds_daily_ceiling" };
(async () => {
console.log("\nrecordSpendEvent — never throws (the sanctioned fail-open):");

// (a) insert returns an error object → swallowed, gate still derived
{
  let inserted: Record<string, unknown> | null = null;
  const sb = { from: () => ({ insert: async (row: Record<string, unknown>) => { inserted = row; return { error: { message: "table absent" } }; } }) } as never;
  let threw = false;
  try { await recordSpendEvent(sb, ev); } catch { threw = true; }
  check("insert returns {error} → does NOT throw", !threw);
  check("gate derived from reason on the built row", (inserted as Record<string, unknown> | null)?.gate === "ceiling");
  check("required fields present on the row", (inserted as Record<string, unknown> | null)?.decision_point === "authorize" && (inserted as Record<string, unknown> | null)?.verdict === "deny");
  check("absent optional fields default to null", (inserted as Record<string, unknown> | null)?.tx_hash === null && (inserted as Record<string, unknown> | null)?.standing_score === null);
}

// (b) insert THROWS → swallowed
{
  const sb = { from: () => ({ insert: async () => { throw new Error("connection reset"); } }) } as never;
  let threw = false;
  try { await recordSpendEvent(sb, ev); } catch { threw = true; }
  check("insert throws → does NOT throw", !threw);
}

// (c) structurally-broken handle (from() itself throws — e.g. a malformed/null client) → swallowed
{
  const sb = { from: () => { throw new Error("client is not constructed"); } } as never;
  let threw = false;
  try { await recordSpendEvent(sb, ev); } catch { threw = true; }
  check("broken handle (from() throws) → does NOT throw", !threw);
}

// (d) explicit gate override is respected (settle/refund don't pass a reason→gate)
{
  let inserted: Record<string, unknown> | null = null;
  const sb = { from: () => ({ insert: async (row: Record<string, unknown>) => { inserted = row; return { error: null }; } }) } as never;
  await recordSpendEvent(sb, { decision_point: "settle", vm_id: "vm-2", verdict: "settle_success", reason: "settle_success" });
  check("settle row built, verdict preserved", (inserted as Record<string, unknown> | null)?.verdict === "settle_success");
}

console.log(`\n=== ${passed} passed / ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
})();
