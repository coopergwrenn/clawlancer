/**
 * Proof for the billing_exempt Path-0 exemption (2026-06-10).
 *
 * Runs getBillingStatusVerified against vm-1075 (Cooper's VM, owner 66afc149)
 * and prints {isPaying, reasons}. After the migration is applied + 66afc149 is
 * flagged billing_exempt=true, this MUST show isPaying=true with a
 * "comp_exempt_founder_primary" reason — proving the flag protects the VM even
 * with no active sub. Run BEFORE Cooper cancels his trialing sub.
 *
 *   npx tsx scripts/_proof-billing-exempt.ts
 *
 * Loads .env.local for SUPABASE_SERVICE_ROLE_KEY + STRIPE_SECRET_KEY.
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createClient } from "@supabase/supabase-js";
import { getStripe } from "@/lib/stripe";
import { getBillingStatus, getBillingStatusVerified } from "@/lib/billing-status";

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id, name, assigned_to, api_mode, tier, partner, credit_balance")
    .eq("name", "instaclaw-vm-1075")
    .maybeSingle();
  if (!vm) {
    console.log("vm-1075 not found");
    return;
  }

  const { data: user } = await supabase
    .from("instaclaw_users")
    .select("email, billing_exempt, billing_exempt_reason")
    .eq("id", vm.assigned_to)
    .maybeSingle();

  console.log("=== owner ===");
  console.log(JSON.stringify(user, null, 2));
  console.log("\n=== vm fields ===");
  console.log(JSON.stringify(vm, null, 2));

  const cheap = await getBillingStatus(supabase, vm.id);
  console.log("\n=== getBillingStatus (cheap, DB) ===");
  console.log(JSON.stringify(cheap, null, 2));

  const verified = await getBillingStatusVerified(supabase, getStripe(), vm.id);
  console.log("\n=== getBillingStatusVerified (Stripe-truth) ===");
  console.log(JSON.stringify(verified, null, 2));

  console.log(
    `\nVERDICT: isPaying=${verified?.isPaying} reasons=${JSON.stringify(verified?.reasons)}`,
  );
  console.log(
    verified?.isPaying && verified.reasons.some((r) => r.startsWith("comp_exempt"))
      ? "✓ PROTECTED BY billing_exempt — safe to cancel the trialing sub."
      : "✗ NOT protected by billing_exempt — do NOT cancel until the flag is live.",
  );
}

main().then(() => process.exit(0));
