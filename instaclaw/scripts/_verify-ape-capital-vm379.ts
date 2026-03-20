/**
 * _verify-ape-capital-vm379.ts — Verify Ape Capital's VM state + trigger manifest deploy
 *
 * Checks DB state + gateway health endpoint directly (no SSH needed).
 * Resets config_version to force reconciler to deploy latest manifest.
 *
 * Usage: npx tsx scripts/_verify-ape-capital-vm379.ts
 */

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env.local") });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
);

async function main() {
  console.log("=== Ape Capital VM-379 Verification ===\n");

  // Step 1: DB query
  console.log("--- Step 1: Database State ---");
  const { data: vms, error } = await supabase
    .from("instaclaw_vms")
    .select("id, name, status, health_status, assigned_to, ip_address, gateway_url, config_version, gateway_token")
    .eq("name", "instaclaw-vm-379");

  if (error || !vms || vms.length === 0) {
    console.error("Failed to find vm-379:", error?.message || "not found");
    process.exit(1);
  }
  const vm = vms[0];

  console.log(`  Name: ${vm.name}`);
  console.log(`  Status: ${vm.status}`);
  console.log(`  Health: ${vm.health_status}`);
  console.log(`  Config Version: ${vm.config_version ?? "NULL"}`);
  console.log(`  Assigned User: ${vm.assigned_to || "NONE"}`);
  console.log(`  IP: ${vm.ip_address}`);
  console.log(`  Gateway URL: ${vm.gateway_url}`);
  console.log(`  Has Gateway Token: ${vm.gateway_token ? "YES" : "NO"}`);
  console.log();

  // Step 2: Direct health endpoint check
  console.log("--- Step 2: Gateway Health ---");
  if (vm.gateway_url) {
    try {
      const healthRes = await fetch(`${vm.gateway_url}/health`, {
        signal: AbortSignal.timeout(10000),
      });
      const healthText = await healthRes.text();
      console.log(`  Status: ${healthRes.status}`);
      console.log(`  Response: ${healthText.slice(0, 500)}`);
    } catch (e: any) {
      console.log(`  Health check failed: ${e.message}`);
    }
  } else {
    console.log("  No gateway URL — cannot check health");
  }
  console.log();

  // Step 3: Force reconciler deployment by resetting config_version
  console.log("--- Step 3: Trigger Manifest Deploy ---");
  const { error: updateErr } = await supabase
    .from("instaclaw_vms")
    .update({ config_version: 0 })
    .eq("id", vm.id);

  if (updateErr) {
    console.log(`  Failed to reset config_version: ${updateErr.message}`);
  } else {
    console.log(`  Reset config_version from ${vm.config_version ?? "NULL"} → 0`);
    console.log("  The cron reconciler will deploy manifest v37 on next cycle (~1 min)");
  }

  // Summary
  console.log("\n=== Summary ===");
  const issues: string[] = [];
  if (vm.status !== "assigned") issues.push(`Status is ${vm.status}, expected assigned`);
  if (vm.health_status !== "healthy") issues.push(`Health is ${vm.health_status}`);
  if (!vm.gateway_token) issues.push("No gateway token");
  if (!vm.assigned_to) issues.push("Not assigned to any user");

  if (issues.length === 0) {
    console.log("  VM is in good shape. Manifest deploy triggered.");
    console.log("  notify_user.sh will be deployed by reconciler on next health cycle.");
  } else {
    console.log("  Issues found:");
    for (const issue of issues) {
      console.log(`    - ${issue}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
