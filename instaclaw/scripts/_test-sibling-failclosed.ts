/**
 * Sibling-primitive fail-closed proof (2026-06-11) — F1 follow-on.
 *
 * Part A: REAL isUserBillableForVmAssignment forced through every path with a
 *   mock Supabase, then runs the TWO opposite-polarity gate predicates:
 *     - DESTRUCTIVE (vm-lifecycle:555 transition): skip = (billable || !verified)
 *     - CONSTRUCTIVE (process-pending/health-check provision/configure): skip = !billable
 *   Proves error → destructive SKIPS (old code transitioned) while constructive
 *   stays fail-closed-unchanged; clean not-billable → both behave as today.
 *
 * Part B: fetchBillingExemptUserIds is route-private (vm-lifecycle), so we prove
 *   its consumer GATE predicate against the 3 return shapes it now produces:
 *     gate skip = (!verified || ids.has(userId))
 *   Proves error ({verified:false}) → skip ALL (old empty-Set+no-verified would
 *   NOT skip = fail-open); exempt-present → skip (unchanged); genuinely-empty →
 *   non-exempt proceeds (unchanged).
 *
 * No DB, no network, throwaway all-zeros UUID. Never vm-1075, never vm-1043.
 *   npx tsx scripts/_test-sibling-failclosed.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(process.cwd(), ".env.local") });

import { isUserBillableForVmAssignment } from "@/lib/billing-status";

type Scn =
  | "user_err" | "user_throw" | "exempt" | "partner"
  | "sub_err" | "active" | "nosub";

// Mock supabase: from(table).select().eq().maybeSingle() resolves per (table, scn).
function mockSupabase(scn: Scn) {
  const make = (table: string) => {
    const maybeSingle = async () => {
      if (table === "instaclaw_users") {
        if (scn === "user_err") return { data: null, error: { message: "sim users error" } };
        if (scn === "user_throw") throw new Error("sim users throw");
        if (scn === "exempt")
          return { data: { partner: null, billing_exempt: true, billing_exempt_reason: "founder_primary" }, error: null };
        if (scn === "partner")
          return { data: { partner: "edge_city", billing_exempt: false, billing_exempt_reason: null }, error: null };
        // sub_err / active / nosub: clean non-exempt non-partner user
        return { data: { partner: null, billing_exempt: false, billing_exempt_reason: null }, error: null };
      }
      // instaclaw_subscriptions
      if (scn === "sub_err") return { data: null, error: { message: "sim sub error" } };
      if (scn === "active") return { data: { status: "active" }, error: null };
      return { data: null, error: null }; // nosub → genuine non-payer
    };
    const chain = { from: (t: string) => make(t), select: () => chain, eq: () => chain, maybeSingle };
    return chain;
  };
  const root = { from: (t: string) => make(t) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return root as any;
}

// Gate predicates (literal, post-fix):
const destructiveSkips = (r: { billable: boolean; verified: boolean }) => r.billable || !r.verified; // vm-lifecycle:555
const constructiveSkips = (r: { billable: boolean }) => !r.billable; // process-pending / health-check
const exemptGateSkips = (g: { ids: Set<string>; verified: boolean }, uid: string) => !g.verified || g.ids.has(uid);

let pass = 0, fail = 0;
const A = (n: string, c: boolean, d: string) => {
  if (c) { pass++; console.log(`  ✓ ${n} — ${d}`); }
  else { fail++; console.log(`  ✗ ${n} — ${d}  <<< FAIL`); }
};

async function main() {
  const U = "00000000-0000-0000-0000-000000000000";

  console.log("\n========== PART A: isUserBillableForVmAssignment ==========");
  const expect: Record<Scn, { billable: boolean; verified: boolean }> = {
    user_err: { billable: false, verified: false },
    user_throw: { billable: false, verified: false },
    sub_err: { billable: false, verified: false },
    exempt: { billable: true, verified: true },
    partner: { billable: true, verified: true },
    active: { billable: true, verified: true },
    nosub: { billable: false, verified: true },
  };
  for (const scn of Object.keys(expect) as Scn[]) {
    const r = await isUserBillableForVmAssignment(mockSupabase(scn), U);
    const e = expect[scn];
    A(`${scn}: billable/verified`, r.billable === e.billable && r.verified === e.verified,
      `{billable:${r.billable},verified:${r.verified},reason:${r.reason}}`);
  }

  console.log("\n--- DESTRUCTIVE gate (vm-lifecycle:555) skip = (billable || !verified) ---");
  let r = await isUserBillableForVmAssignment(mockSupabase("user_err"), U);
  A("error → SKIP transition", destructiveSkips(r) === true, "old code would have TRANSITIONED toward reclaim");
  r = await isUserBillableForVmAssignment(mockSupabase("sub_err"), U);
  A("sub_err → SKIP transition", destructiveSkips(r) === true, "fail-closed");
  r = await isUserBillableForVmAssignment(mockSupabase("nosub"), U);
  A("clean non-payer → TRANSITION proceeds", destructiveSkips(r) === false, "unchanged from today");
  r = await isUserBillableForVmAssignment(mockSupabase("exempt"), U);
  A("exempt → SKIP transition", destructiveSkips(r) === true, "protected");

  console.log("\n--- CONSTRUCTIVE gate (process-pending/health-check) skip = !billable — MUST be unchanged ---");
  r = await isUserBillableForVmAssignment(mockSupabase("user_err"), U);
  A("error → SKIP provision (fail-closed, unchanged)", constructiveSkips(r) === true, "does NOT provision a non-payer on a blip");
  r = await isUserBillableForVmAssignment(mockSupabase("nosub"), U);
  A("clean non-payer → SKIP provision", constructiveSkips(r) === true, "unchanged");
  r = await isUserBillableForVmAssignment(mockSupabase("active"), U);
  A("active sub → PROVISION", constructiveSkips(r) === false, "unchanged");

  console.log("\n========== PART B: fetchBillingExemptUserIds consumer gate ==========");
  console.log("--- freeze/reclaim gate skip = (!verified || ids.has(uid)) ---");
  // error shape: {ids:Set(), verified:false}
  A("error list → SKIP ALL candidates", exemptGateSkips({ ids: new Set(), verified: false }, U) === true,
    "old empty-Set+no-verified would have skip=false → freeze/reclaim PROCEEDED (fail-open)");
  // exempt present
  A("exempt present → SKIP (protected)", exemptGateSkips({ ids: new Set([U]), verified: true }, U) === true, "unchanged");
  // genuinely empty, non-exempt user
  A("clean empty list, non-exempt → PROCEED", exemptGateSkips({ ids: new Set(), verified: true }, U) === false,
    "unchanged from today — real non-payers still freeze/reclaim");

  console.log(`\n${fail === 0 ? "✓ ALL PASS" : "✗ FAILURES"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
