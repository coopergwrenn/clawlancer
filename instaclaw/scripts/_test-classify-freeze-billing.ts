// Decision-level proof (Rule 82) for classifyFreezeBilling — the SoT freeze-billing
// primitive. Drives the REAL classifyFreezeBilling (→ getBillingStatusVerified) with
// fake supabase + stripe through every input shape, asserting the three verdict
// states are distinguished. Run: npx tsx scripts/_test-classify-freeze-billing.ts
import { classifyFreezeBilling } from "../lib/billing-status";

let pass = 0, fail = 0;
function check(label: string, got: string, want: string) {
  if (got === want) { pass++; console.log(`  OK   ${label} → ${got}`); }
  else { fail++; console.error(`  FAIL ${label} → got ${got}, want ${want}`); }
}

// Fake supabase: .from(t).select().eq() is a thenable {data} (subs) that ALSO
// has .single() (vms). vmRow null → single() returns an error (row not found).
function fakeSupabase(
  vmRow: any,
  subsRows: any[],
  exemptRow: any = { billing_exempt: false, billing_exempt_reason: null }, // clean non-exempt read
  exemptError: any = null,
) {
  return {
    from(table: string) {
      return {
        select() {
          return {
            eq() {
              return {
                single: async () =>
                  vmRow ? { data: vmRow, error: null } : { data: null, error: { message: "not found" } },
                // instaclaw_users comp-exempt read (fetchBillingExempt uses maybeSingle).
                maybeSingle: async () => ({ data: table === "instaclaw_users" ? exemptRow : null, error: exemptError }),
                then: (res: any) =>
                  res({ data: table === "instaclaw_subscriptions" ? subsRows : (vmRow ? [vmRow] : []), error: null }),
              };
            },
          };
        },
      };
    },
  } as any;
}
// Fake stripe: "throw" simulates an outage; otherwise returns a sub-like object.
function fakeStripe(behavior: "throw" | Record<string, any>) {
  return {
    subscriptions: {
      retrieve: async () => {
        if (behavior === "throw") throw new Error("Stripe unreachable (simulated outage)");
        return behavior;
      },
    },
  } as any;
}
const VM = (over: Record<string, any> = {}) => ({ id: "vm-x", assigned_to: "u1", credit_balance: 0, partner: null, api_mode: null, tier: null, ...over });

async function run() {
  // 1. VM row unreadable → unverifiable (can't classify)
  check("vm row not found", await classifyFreezeBilling(fakeSupabase(null, []), fakeStripe("throw"), "vm-x"), "unverifiable");

  // 2. unassigned VM → freezable (no billing relationship)
  check("unassigned vm", await classifyFreezeBilling(fakeSupabase(VM({ assigned_to: null }), []), fakeStripe("throw"), "vm-x"), "freezable");

  // 3. assigned, NO sub row → freezable (credits/partner DB-authoritative)
  check("assigned, no sub", await classifyFreezeBilling(fakeSupabase(VM(), []), fakeStripe("throw"), "vm-x"), "freezable");

  // 4. credit_balance > 0 → paying
  check("credits>0", await classifyFreezeBilling(fakeSupabase(VM({ credit_balance: 5 }), []), fakeStripe("throw"), "vm-x"), "paying");

  // 5. partner-tagged → paying
  check("partner set", await classifyFreezeBilling(fakeSupabase(VM({ partner: "edge_city" }), []), fakeStripe("throw"), "vm-x"), "paying");

  // 6. sub w/ stripe id, Stripe says ACTIVE → paying (verified)
  check("stripe active (verified)",
    await classifyFreezeBilling(fakeSupabase(VM(), [{ status: "active", stripe_subscription_id: "sub_1", updated_at: "2026-06-01" }]),
      fakeStripe({ status: "active", canceled_at: null, latest_invoice: { status: "paid" } }), "vm-x"), "paying");

  // 7. sub w/ stripe id, Stripe says CANCELED → freezable (verified non-paying)
  check("stripe canceled (verified)",
    await classifyFreezeBilling(fakeSupabase(VM(), [{ status: "active", stripe_subscription_id: "sub_1", updated_at: "2026-06-01" }]),
      fakeStripe({ status: "canceled", canceled_at: 1730000000, latest_invoice: null }), "vm-x"), "freezable");

  // 8. sub w/ stripe id, Stripe THROWS (outage) → unverifiable (stripeUnreachable)
  check("stripe outage on sub-bearing user",
    await classifyFreezeBilling(fakeSupabase(VM(), [{ status: "canceled", stripe_subscription_id: "sub_1", updated_at: "2026-06-01" }]),
      fakeStripe("throw"), "vm-x"), "unverifiable");

  // 9. sub WITHOUT stripe id, canceled → freezable (reliable; nothing to verify) — the
  //    case that a naive verified===false check would mis-flag as unverifiable.
  check("no-stripe-id canceled sub",
    await classifyFreezeBilling(fakeSupabase(VM(), [{ status: "canceled", stripe_subscription_id: null, updated_at: "2026-06-01" }]),
      fakeStripe("throw"), "vm-x"), "freezable");

  // 10. all-inclusive tier + active sub → paying
  check("all_inclusive + active",
    await classifyFreezeBilling(fakeSupabase(VM({ api_mode: "all_inclusive", tier: "pro" }), [{ status: "active", stripe_subscription_id: "sub_1", updated_at: "2026-06-01" }]),
      fakeStripe({ status: "active", canceled_at: null, latest_invoice: { status: "paid" } }), "vm-x"), "paying");

  // 11. all-inclusive tier but CANCELED (the live cohort shape) → freezable
  check("all_inclusive + canceled (live cohort)",
    await classifyFreezeBilling(fakeSupabase(VM({ api_mode: "all_inclusive", tier: "pro" }), [{ status: "active", stripe_subscription_id: "sub_1", updated_at: "2026-06-01" }]),
      fakeStripe({ status: "canceled", canceled_at: 1730000000, latest_invoice: null }), "vm-x"), "freezable");

  // 12. comp/founder billing_exempt=true (no sub) → paying (Path 0 grant, composed)
  check("comp-exempt account",
    await classifyFreezeBilling(fakeSupabase(VM(), [], { billing_exempt: true, billing_exempt_reason: "founder" }), fakeStripe("throw"), "vm-x"), "paying");

  // 13. exempt read ERRORS (DB blip) on an otherwise-non-paying user → unverifiable
  //     (compExemptVerified=false — a blip could be hiding a comp account; fail-closed)
  check("comp-exempt read errored",
    await classifyFreezeBilling(fakeSupabase(VM(), [], { billing_exempt: false }, { message: "users table read failed" }), fakeStripe("throw"), "vm-x"), "unverifiable");

  console.log(`\nclassifyFreezeBilling: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
run();
