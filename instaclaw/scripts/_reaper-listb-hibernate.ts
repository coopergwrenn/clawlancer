/**
 * List B reaper — hibernate the 4 Cooper-approved non-payers (2026-06-10).
 *
 *   vm-1077 (fbccciioy3746@hotmail.com)
 *   vm-036  (apexcougar52@gmail.com)
 *   vm-1087 (aksbabie@gmail.com)
 *   vm-1085 (weex.wt@gmail.com)
 *
 * All four: no_payment_signal + credits_zero + no_partner by full Rule-14
 * (lib/billing-status.ts). Hibernate is reversible — gateway stopped, Linode
 * running, data preserved; any payment wakes them via wake-paid-hibernating.
 *
 * Per Rule 14: re-verify each against getBillingStatusVerified (Stripe truth)
 * IMMEDIATELY before the destructive action. If any now classifies isPaying,
 * SKIP it loudly — do not hibernate a customer who paid since the dry-run.
 *
 * Mirrors suspend-check's hibernateVM: DB update FIRST (health_status,
 * suspended_at, last_health_check), then best-effort stopGateway.
 *
 *   npx tsx scripts/_reaper-listb-hibernate.ts
 *
 * Loads .env.local + .env.ssh-key (Rule 18 — stopGateway needs SSH key).
 */
import { readFileSync } from "fs";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots-sidebar/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots-sidebar/instaclaw/.env.ssh-key",
]) {
  try {
    const env = readFileSync(f, "utf-8");
    for (const l of env.split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* optional */
  }
}

import { createClient } from "@supabase/supabase-js";
import { getStripe } from "@/lib/stripe";
import { getBillingStatusVerified } from "@/lib/billing-status";
import { stopGateway, type VMRecord } from "@/lib/ssh";

const TARGETS = [
  "instaclaw-vm-1077",
  "instaclaw-vm-036",
  "instaclaw-vm-1087",
  "instaclaw-vm-1085",
];

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const stripe = getStripe();

  for (const name of TARGETS) {
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("*")
      .eq("name", name)
      .maybeSingle();

    if (!vm) {
      console.log(`[${name}] NOT FOUND — skip`);
      continue;
    }
    if (vm.health_status === "hibernating" || vm.health_status === "suspended") {
      console.log(`[${name}] already ${vm.health_status} — skip`);
      continue;
    }
    if (["terminated", "destroyed", "failed"].includes(vm.status)) {
      console.log(`[${name}] terminal status=${vm.status} — skip`);
      continue;
    }

    // Rule 14: Stripe-truth re-verify immediately before the destructive action.
    const billing = await getBillingStatusVerified(supabase, stripe, vm.id);
    if (billing?.isPaying) {
      console.log(
        `[${name}] PAYING NOW (${JSON.stringify(billing.reasons)}) — SKIP, do not hibernate`,
      );
      continue;
    }
    if (!billing) {
      console.log(`[${name}] billing status unverifiable — SKIP (fail-closed)`);
      continue;
    }

    // DB update FIRST (mirror hibernateVM), guarded against terminal rows.
    const { error: updErr } = await supabase
      .from("instaclaw_vms")
      .update({
        health_status: "hibernating",
        suspended_at: new Date().toISOString(),
        last_health_check: new Date().toISOString(),
      })
      .eq("id", vm.id)
      .not("status", "in", '("terminated","destroyed","failed")');
    if (updErr) {
      console.log(`[${name}] DB update FAILED: ${updErr.message} — skip stopGateway`);
      continue;
    }

    let gw = "stopped";
    try {
      await stopGateway(vm as VMRecord);
    } catch (e) {
      gw = `stop-failed (${String(e).slice(0, 60)})`;
    }

    console.log(
      `[${name}] HIBERNATED  reasons=${JSON.stringify(billing.reasons)}  gateway=${gw}`,
    );
  }

  console.log("\nList B reaper complete.");
}

main().then(() => process.exit(0));
