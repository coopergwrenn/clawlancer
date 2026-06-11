/**
 * Tier-0 G decision-tests (Rule 31) — revoke interdiction, mechanism C. Pure/synthetic.
 *
 * Decision-tests Cooper named:
 *   - revoke-vs-settle race (settle loses): the interdiction UPDATE guards on
 *     status='pending' — the same guard settle's CAS uses — so Postgres serializes
 *     them. We assert the guard is present (the property that makes the race safe).
 *   - revoke with zero pending holds: clean no-op (0 interdicted, n=0 copy, no events).
 *   - revoke mid-pay (interdicted, gap detector fires): the gap signal classifier
 *     fires when a settle attempt hits an already-revoked hold WITH a tx_hash.
 *   - idempotent double-revoke: the second revoke finds no pending holds → n=0
 *     (after the first revoke disabled future spend, no new pending hold can appear).
 *   - best-effort pre-migration: a CHECK violation → errored, 0 holds, no throw, n=0 copy.
 *
 * Plus: copy honesty (never implies a chargeback or a booking-cancel), event shape,
 * gate map.
 *
 * Run: npx tsx scripts/_test-frontier-revoke.ts
 */
import {
  runInterdiction,
  buildInterdictionEvents,
  revokeConfirmationCopy,
  isRevokedSettleGap,
  type InterdictedHold,
} from "../lib/frontier-revoke";
import { gateForReason } from "../lib/frontier-spend-log";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// Mock the supabase chain runInterdiction walks: from().update().eq().eq().eq().select().
// Records the eq() filters so we can assert the status='pending' guard. `result` is
// what select() resolves to; `throws` makes select() throw.
function mockSb(result: { data?: unknown; error?: unknown }, throws = false): { sb: never; eqCalls: Array<[string, unknown]> } {
  const eqCalls: Array<[string, unknown]> = [];
  const chain: Record<string, unknown> = {};
  chain.update = () => chain;
  chain.eq = (k: string, val: unknown) => { eqCalls.push([k, val]); return chain; };
  chain.select = async () => { if (throws) throw new Error("db down"); return result; };
  return { sb: { from: () => chain } as never, eqCalls };
}

(async () => {
  // ── runInterdiction: the decision-tests ──
  console.log("runInterdiction — decision tests:");

  // zero pending → clean no-op
  {
    const { sb } = mockSb({ data: [], error: null });
    const r = await runInterdiction(sb, "vm-1");
    check("zero pending → 0 holds, not errored", r.holds.length === 0 && r.errored === false);
  }

  // multi-hold interdiction
  {
    const { sb } = mockSb({ data: [{ id: "h1", amount_usdc: "1.50" }, { id: "h2", amount_usdc: 2 }], error: null });
    const r = await runInterdiction(sb, "vm-1");
    check("two pending → 2 holds interdicted", r.holds.length === 2 && !r.errored);
  }

  // revoke-vs-settle race: the guard that makes it safe MUST be status='pending'
  {
    const { sb, eqCalls } = mockSb({ data: [], error: null });
    await runInterdiction(sb, "vm-9");
    const hasPendingGuard = eqCalls.some(([k, val]) => k === "status" && val === "pending");
    const hasVmGuard = eqCalls.some(([k, val]) => k === "vm_id" && val === "vm-9");
    const hasSpendGuard = eqCalls.some(([k, val]) => k === "direction" && val === "spend");
    check("race-safe: UPDATE guards on status='pending' (serializes vs settle CAS)", hasPendingGuard);
    check("scoped to this vm_id + direction='spend'", hasVmGuard && hasSpendGuard);
  }

  // idempotent double-revoke: second call finds no pending holds → 0 (same shape as zero-pending)
  {
    const { sb } = mockSb({ data: [], error: null });
    const r = await runInterdiction(sb, "vm-1");
    check("idempotent double-revoke → second finds 0 pending", r.holds.length === 0);
  }

  // best-effort: CHECK violation (pre-migration 'revoked' illegal) → errored, no throw, 0 holds
  {
    const { sb } = mockSb({ data: null, error: { code: "23514", message: "violates check constraint" } });
    let threw = false;
    let r: { holds: InterdictedHold[]; errored: boolean } = { holds: [], errored: false };
    try { r = await runInterdiction(sb, "vm-1"); } catch { threw = true; }
    check("pre-migration CHECK violation → errored, 0 holds, NO throw", !threw && r.errored && r.holds.length === 0);
  }

  // exception → swallowed
  {
    const { sb } = mockSb({}, true);
    let threw = false;
    try { await runInterdiction(sb, "vm-1"); } catch { threw = true; }
    check("interdiction exception → does NOT throw", !threw);
  }

  // ── buildInterdictionEvents ──
  console.log("\nbuildInterdictionEvents — one row per hold, complete trace:");
  {
    const holds: InterdictedHold[] = [{ id: "h1", amount_usdc: "3.25" }, { id: "h2", amount_usdc: null }];
    const evs = buildInterdictionEvents("vm-1", "owner-1", holds);
    check("one event per interdicted hold", evs.length === 2);
    check("verdict=deny, reason=revoked_in_flight", evs.every((e) => e.verdict === "deny" && e.reason === "revoked_in_flight"));
    check("carries transaction_id + amount (string→number coerced)", evs[0].transaction_id === "h1" && evs[0].amount_usd === 3.25);
    check("null amount stays null", evs[1].amount_usd === null);
    check("vm/owner threaded", evs[0].vm_id === "vm-1" && evs[0].owner_id === "owner-1");
  }

  // ── revokeConfirmationCopy: honesty invariants ──
  console.log("\nrevokeConfirmationCopy — honesty (never a chargeback, never a booking-cancel):");
  const CHARGEBACK = /refund|charge ?back|money back|returned to|reimburs|back to your wallet|reversed/i;
  for (const n of [0, 1, 3]) {
    const { body } = revokeConfirmationCopy(n);
    check(`n=${n}: states future spending is off`, /spending for this agent is now off/i.test(body));
    check(`n=${n}: NEVER implies money comes back (no chargeback language)`, !CHARGEBACK.test(body));
  }
  {
    const c0 = revokeConfirmationCopy(0).body;
    check("n=0: says no spends were in progress (no false cancellation claim)", /no spends were in progress/i.test(c0));
    const c1 = revokeConfirmationCopy(1).body;
    check("n=1: states exactly 1 cancelled, singular grammar", /\b1 pending payment that hadn't completed yet was cancelled/i.test(c1));
    check("n=1: explicit — can't reverse on-chain money", /can't reverse money that already left on-chain/i.test(c1));
    check("n=1: explicit — does not cancel a confirmed booking", /doesn't cancel a hotel booking/i.test(c1));
    const c3 = revokeConfirmationCopy(3).body;
    check("n=3: plural grammar (3 ... were cancelled)", /\b3 pending payments that hadn't completed yet were cancelled/i.test(c3));
  }

  // ── gateForReason + gap classifier ──
  console.log("\ngate map + reconciliation-gap classifier:");
  check("revoked_in_flight → gate 'revoke'", gateForReason("revoked_in_flight") === "revoke");
  check("settle_on_revoked_hold → gate 'revoke'", gateForReason("settle_on_revoked_hold") === "revoke");
  check("gap: settle_on_revoked_hold + tx_hash → TRUE (paid → reconcile)", isRevokedSettleGap("settle_on_revoked_hold", "0xabc123") === true);
  check("gap: settle_on_revoked_hold WITHOUT tx_hash → false (no money moved)", isRevokedSettleGap("settle_on_revoked_hold", null) === false);
  check("gap: other reason → false", isRevokedSettleGap("within_earned_budget", "0xabc") === false);

  console.log(`\n=== ${passed} passed / ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
})();
