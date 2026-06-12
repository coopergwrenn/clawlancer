/**
 * One-shot recovery: wake vm-1075 (Cooper's VM, owner 66afc149).
 *
 * vm-1075 was suspended by the billing webhook's customer.subscription.deleted
 * handler 3s after I canceled sub_1TgqO3 (19:56:01 -> suspended_at 19:56:04).
 * That webhook path suspends unconditionally and does NOT honor billing_exempt
 * (the exemption only guards getBillingStatus callers). 66afc149 IS
 * billing_exempt=true (comp_exempt_founder_primary), so this VM should never
 * have been put to sleep on cancel. wakeIfHibernating handles both
 * suspended/hibernating; loads .env.ssh-key for SSH (Rule 18).
 *
 *   npx tsx scripts/_wake-vm1075.ts
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
    /* file optional */
  }
}

import { createClient } from "@supabase/supabase-js";
import { wakeIfHibernating } from "@/lib/wake-vm";

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("name, health_status, assigned_to, ip_address")
    .eq("name", "instaclaw-vm-1075")
    .maybeSingle();
  if (!vm) {
    console.log("vm-1075 not found");
    return;
  }
  console.log("BEFORE:", JSON.stringify(vm));

  if (vm.health_status !== "suspended" && vm.health_status !== "hibernating") {
    console.log(`vm-1075 is ${vm.health_status} (not sleeping) — nothing to wake.`);
    return;
  }

  const results = await wakeIfHibernating(supabase, vm.assigned_to, "manual-recovery-vm1075-post-cancel");
  console.log("wake results:", JSON.stringify(results, null, 2));

  const { data: after } = await supabase
    .from("instaclaw_vms")
    .select("name, health_status, suspended_at")
    .eq("name", "instaclaw-vm-1075")
    .maybeSingle();
  console.log("AFTER:", JSON.stringify(after));
}

main().then(() => process.exit(0));
