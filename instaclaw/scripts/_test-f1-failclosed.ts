/**
 * F1 decision-level proof (2026-06-11): fetchBillingExempt fail-CLOSED on the
 * destroy side, fail-closed-on-grant preserved.
 *
 * Forces every path of the REAL fetchBillingExempt (imported from
 * lib/billing-status.ts) with a mock Supabase client, then runs the LITERAL
 * guard predicates the 4 suspend paths use to prove:
 *   - read ERROR / exception  → guard SKIPS (where the old code DESTROYED)
 *   - clean not-exempt read    → guard DESTROYS (unchanged from today)
 *   - clean exempt row         → guard SKIPS (unchanged)
 *   - GRANT side (classify reads `exempt` only): exempt stays FALSE on error
 *     → no false isPaying grant (documented fail-open-on-grant preserved)
 *
 * No DB, no network, throwaway userId — never touches vm-1075.
 *   npx tsx scripts/_test-f1-failclosed.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(process.cwd(), ".env.local") });

import { fetchBillingExempt } from "@/lib/billing-status";

// Minimal mock of the supabase chain fetchBillingExempt uses:
//   supabase.from(t).select(c).eq(col,val).maybeSingle() -> { data, error }
// `mode` controls what maybeSingle resolves/throws.
function mockSupabase(mode: "error" | "throw" | "norow" | "exempt" | "notexempt") {
  const maybeSingle = async () => {
    if (mode === "throw") throw new Error("simulated network timeout");
    if (mode === "error") return { data: null, error: { message: "simulated PostgREST error" } };
    if (mode === "norow") return { data: null, error: null };
    if (mode === "exempt")
      return { data: { billing_exempt: true, billing_exempt_reason: "founder_primary" }, error: null };
    // notexempt
    return { data: { billing_exempt: false, billing_exempt_reason: null }, error: null };
  };
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    maybeSingle,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return chain as any;
}

// The literal predicates the guards use post-fix:
const destroys = (r: { exempt: boolean; verified: boolean }) => !r.exempt && r.verified;
const skips = (r: { exempt: boolean; verified: boolean }) => r.exempt || !r.verified;
// What the OLD code did (collapsed {exempt:false} on error) — for contrast:
const oldDestroys = (exemptOnly: boolean) => !exemptOnly;

let pass = 0,
  fail = 0;
function assert(name: string, cond: boolean, detail: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name} — ${detail}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} — ${detail}  <<< FAIL`);
  }
}

async function main() {
  const U = "00000000-0000-0000-0000-000000000000"; // throwaway, no such user

  console.log("\n=== read ERROR (transient Supabase blip) ===");
  let r = await fetchBillingExempt(mockSupabase("error"), U);
  console.log("   ", JSON.stringify(r));
  assert("error → not destroy", destroys(r) === false, `destroys=${destroys(r)} (guard SKIPS)`);
  assert("error → skip", skips(r) === true, `skips=${skips(r)} logged loudly`);
  assert("error → OLD code WOULD have destroyed", oldDestroys(r.exempt) === true, "regression contrast");
  assert("error → grant side exempt stays FALSE", r.exempt === false, "no false isPaying grant");
  assert("error → reason sentinel", r.exemptReason === "unverifiable_read_error", `reason=${r.exemptReason}`);

  console.log("\n=== exception (throw) ===");
  r = await fetchBillingExempt(mockSupabase("throw"), U);
  console.log("   ", JSON.stringify(r));
  assert("throw → not destroy", destroys(r) === false, `destroys=${destroys(r)}`);
  assert("throw → skip", skips(r) === true, `skips=${skips(r)}`);
  assert("throw → grant side exempt FALSE", r.exempt === false, "no false grant");
  assert("throw → reason sentinel", r.exemptReason === "unverifiable_exception", `reason=${r.exemptReason}`);

  console.log("\n=== clean read, NO row (genuinely not exempt) ===");
  r = await fetchBillingExempt(mockSupabase("norow"), U);
  console.log("   ", JSON.stringify(r));
  assert("norow → DESTROYS (unchanged)", destroys(r) === true, `destroys=${destroys(r)} — suspends exactly as today`);
  assert("norow → not skip", skips(r) === false, `skips=${skips(r)}`);
  assert("norow → verified true", r.verified === true, "clean read");

  console.log("\n=== clean read, exempt row ===");
  r = await fetchBillingExempt(mockSupabase("exempt"), U);
  console.log("   ", JSON.stringify(r));
  assert("exempt → not destroy", destroys(r) === false, `destroys=${destroys(r)}`);
  assert("exempt → skip", skips(r) === true, `skips=${skips(r)}`);
  assert("exempt → reason passthrough", r.exemptReason === "founder_primary", `reason=${r.exemptReason}`);

  console.log("\n=== clean read, NON-exempt row (real non-payer) ===");
  r = await fetchBillingExempt(mockSupabase("notexempt"), U);
  console.log("   ", JSON.stringify(r));
  assert("notexempt → DESTROYS (unchanged)", destroys(r) === true, `destroys=${destroys(r)} — suspends exactly as today`);
  assert("notexempt → verified true", r.verified === true, "clean read");

  console.log(`\n${fail === 0 ? "✓ ALL PASS" : "✗ FAILURES"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
