/**
 * One-time scan: Check all quarantined (status="failed") VMs and un-quarantine
 * any whose gateway HTTP health check responds 200.
 *
 * Catches false positives like Renata's VM-24 incident (Feb 20, 2026) where
 * transient SSH failures caused a healthy VM to be quarantined.
 *
 * Usage: npx tsx scripts/_scan-quarantined.ts [--dry-run]
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

// Load env
const envContent = readFileSync(resolve(".", ".env.local"), "utf-8");
for (const line of envContent.split("\n")) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) {
    process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, "");
  }
}

const dryRun = process.argv.includes("--dry-run");

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function main() {
  console.log(`Scanning quarantined VMs...${dryRun ? " (DRY RUN)" : ""}\n`);

  const { data: vms, error } = await sb
    .from("instaclaw_vms")
    .select("id, ip_address, name, assigned_to, ssh_fail_count, health_status")
    .eq("status", "failed")
    .not("ip_address", "is", null);

  if (error) {
    console.error("Failed to query VMs:", error.message);
    process.exit(1);
  }

  if (!vms?.length) {
    console.log("No quarantined VMs with IP addresses found.");
    return;
  }

  console.log(`Found ${vms.length} quarantined VM(s):\n`);

  let recovered = 0;
  let stillDead = 0;

  for (const vm of vms) {
    const label = `${vm.name ?? vm.id} (${vm.ip_address})`;
    process.stdout.write(`  ${label} ... `);

    try {
      const res = await fetch(`http://${vm.ip_address}:18789/health`, {
        signal: AbortSignal.timeout(10000),
      });

      if (res.ok) {
        console.log("HEALTHY — gateway responding");

        if (!dryRun) {
          const newStatus = vm.assigned_to ? "assigned" : "ready";
          await sb
            .from("instaclaw_vms")
            .update({
              status: newStatus,
              health_status: "healthy",
              ssh_fail_count: 0,
              last_health_check: new Date().toISOString(),
            })
            .eq("id", vm.id);

          console.log(`    -> Restored to status: "${newStatus}"`);
        } else {
          const newStatus = vm.assigned_to ? "assigned" : "ready";
          console.log(`    -> Would restore to status: "${newStatus}" (dry run)`);
        }
        recovered++;
      } else {
        console.log(`UNHEALTHY — HTTP ${res.status}`);
        stillDead++;
      }
    } catch (err: any) {
      console.log(`UNREACHABLE — ${err.message || err}`);
      stillDead++;
    }
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`Results: ${recovered} recovered, ${stillDead} still dead`);
  if (dryRun && recovered > 0) {
    console.log(`\nRe-run without --dry-run to apply changes.`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
