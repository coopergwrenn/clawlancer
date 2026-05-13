/**
 * Manual bridge deploy — for VMs the reconciler hasn't caught up on yet.
 *
 * Use case: cron lock held elsewhere; we need specific VMs to have the
 * new bridge content + chattr +i before the cutover.
 *
 * Idempotent. Uses the shared `deployPrivacyBridge` helper (single
 * ssh.execCommand with backup + rollback). The vm-354 lockout
 * (2026-05-13) was caused by an earlier multi-step version; that bug
 * is fixed in the helper.
 *
 * Usage: tsx scripts/_manual-bridge-deploy.ts <vm-name> [--dry-run]
 *
 * Exit codes:
 *   0 = already_correct or deployed
 *   1 = failure (status + details printed)
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve } from "path";
import { readFileSync } from "fs";
import { connectSSH } from "../lib/ssh";
import { deployPrivacyBridge } from "../lib/privacy-bridge-deploy";

config({ path: resolve(process.cwd(), ".env.local") });
config({ path: resolve(process.cwd(), ".env.ssh-key") });

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const vmName = args.find((a) => !a.startsWith("--"));
  if (!vmName) {
    console.error("Usage: tsx scripts/_manual-bridge-deploy.ts <vm-name> [--dry-run]");
    process.exit(1);
  }

  const bridge = readFileSync(resolve(__dirname, "..", "lib", "privacy-bridge.sh"), "utf-8");
  console.log(`Target VM: ${vmName}`);
  console.log(`Dry run: ${dryRun ? "YES" : "NO"}`);
  console.log("");

  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const { data: vm, error } = await sb
    .from("instaclaw_vms")
    .select("*")
    .eq("name", vmName)
    .single();
  if (error || !vm) {
    console.error(`VM not found: ${vmName}: ${error?.message}`);
    process.exit(1);
  }
  if (vm.partner !== "edge_city") {
    console.error(`SAFETY: ${vmName} partner is "${vm.partner}", not "edge_city". Refusing.`);
    process.exit(1);
  }
  console.log(`VM: ${vm.name} (${vm.ip_address}) partner=${vm.partner} health=${vm.health_status}`);

  const ssh = await connectSSH(vm);
  try {
    const result = await deployPrivacyBridge(ssh, bridge, { dryRun });
    console.log(`\nstatus: ${result.status}`);
    if (result.finalSha) console.log(`final SHA: ${result.finalSha}`);
    if (result.finalAttrs) console.log(`final attrs: ${result.finalAttrs}`);
    console.log(`expected SHA: ${result.expectedSha}`);
    if (result.rawOutput) {
      console.log("\n--- raw output ---");
      console.log(result.rawOutput);
      console.log("--- end raw ---");
    }
    if (!result.ok) {
      console.error(`\n✗ FAILED: ${result.error ?? result.status}`);
      // Specific recovery hints for the lockout-risk case
      if (result.status === "chattr_failed_no_backup") {
        console.error(`\nLOCKOUT RISK on cutover VMs. Recovery: SSH via bypass key and run:`);
        console.error(`  sudo chattr +i /home/openclaw/.openclaw/scripts/privacy-bridge.sh`);
      }
      process.exit(1);
    }
    console.log(`\n✅ ${result.status === "already_correct" ? "Already correct — no changes" : "Deployed + locked + verified"}`);
  } finally {
    ssh.dispose();
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
