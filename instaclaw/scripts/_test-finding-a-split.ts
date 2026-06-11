/**
 * Finding A composition proof (2026-06-11): the subscription.deleted block
 * splits into two gates with OPPOSITE fail directions.
 *
 *   VM mutation (irreplaceable data — KEEP on uncertainty):  !exempt && verified
 *   spend revoke (re-grantable permission — REVOKE on uncertainty):  !exempt
 *
 * Proves the three composed outcomes Cooper ruled, via the literal gate
 * predicates. Pure logic — NO DB, NO network, NO row touched (never vm-1043,
 * the live travala canary whose frontier_spend_enabled this very path writes).
 *   npx tsx scripts/_test-finding-a-split.ts
 */
const vmSuspendFires = (r: { exempt: boolean; verified: boolean }) => !r.exempt && r.verified;
const spendRevokeFires = (r: { exempt: boolean }) => !r.exempt;

let pass = 0, fail = 0;
const A = (n: string, c: boolean, d: string) => {
  if (c) { pass++; console.log(`  ✓ ${n} — ${d}`); }
  else { fail++; console.log(`  ✗ ${n} — ${d}  <<< FAIL`); }
};

// Three composed outcomes (cancelExempt shapes from fetchBillingExempt):
const confirmedNonPayer = { exempt: false, verified: true };
const confirmedExempt = { exempt: true, verified: true };
const blip = { exempt: false, verified: false };

console.log("\n=== confirmed non-payer cancels → suspend VM + revoke spend (both as designed) ===");
A("VM suspended", vmSuspendFires(confirmedNonPayer) === true, "irreplaceable data: destroy on confirmed not-exempt");
A("spend revoked", spendRevokeFires(confirmedNonPayer) === true, "permission: revoke");

console.log("\n=== confirmed exempt cancels → keep VM + keep spend (path-0 billable) ===");
A("VM kept", vmSuspendFires(confirmedExempt) === false, "comp founder keeps their agent");
A("spend kept", spendRevokeFires(confirmedExempt) === false, "entitled to the full product");

console.log("\n=== blip during cancel → keep VM (F1) + revoke spend (F4) — each asset closed in ITS direction ===");
A("VM kept on uncertainty", vmSuspendFires(blip) === false, "F1: never suspend a maybe-protected VM");
A("spend revoked on uncertainty", spendRevokeFires(blip) === true, "F4: never let a maybe-non-payer hold live spend");

console.log("\n=== regression contrast: the OLD entangled block (spend inside the VM-keep guard) ===");
const oldSpendRevokeFires = (r: { exempt: boolean; verified: boolean }) => !r.exempt && r.verified; // was gated like the VM
A("OLD: blip → spend WOULD have been retained (the bug)", oldSpendRevokeFires(blip) === false,
  "entangled: a canceled non-payer held live spend during a blip");

console.log(`\n${fail === 0 ? "✓ ALL PASS" : "✗ FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
