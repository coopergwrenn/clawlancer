#!/usr/bin/env tsx
/**
 * _unquarantine-vm.ts — operator CLI to un-quarantine a VM after manual fix.
 *
 * Used after the reconcile-stuck-vms cron quarantines a VM (sets
 * `reconcile_quarantined_at` after 3 failed recovery attempts in 24h, see
 * app/api/cron/reconcile-stuck-vms/route.ts). Operator investigates, fixes
 * the root cause manually (SSH, restore from .clobbered, whatever), and
 * runs this to re-enable automation.
 *
 * What it does:
 *   1. Look up VM by name. Print current state.
 *   2. Clear `reconcile_quarantined_at` + `reconcile_last_error` on the row.
 *   3. Reset `health_fail_count` to 0 (so health-check doesn't immediately
 *      re-quarantine the VM with stale failure history).
 *   4. Delete the C-failure counter rows from `instaclaw_admin_alert_log`
 *      (pattern: `stuck_vm_reconcile_failure:<id>:*`). Otherwise the next
 *      C run would see 3+ failures already on the clock and immediately
 *      re-quarantine on the first new failure.
 *   5. Log to `instaclaw_vm_lifecycle_log` with action `unquarantine`.
 *   6. Print confirmation with the cleared state.
 *
 * Does NOT:
 *   - Restart the gateway. Operator should verify health independently.
 *   - Touch `reconcile_consecutive_failures` (main reconcile-fleet's
 *     counter — separate from C's counter; left alone).
 *   - Force a reconcile. The next reconcile-fleet tick (~3 min) will pick
 *     the VM up naturally if it's healthy + cv-stale.
 *
 * Usage:
 *   npx tsx instaclaw/scripts/_unquarantine-vm.ts instaclaw-vm-911
 *   npx tsx instaclaw/scripts/_unquarantine-vm.ts vm-911               (short form, prefix added)
 *   npx tsx instaclaw/scripts/_unquarantine-vm.ts --reason "Manually restored from .clobbered"
 *
 * Idempotent: if the VM isn't quarantined, prints a warning and exits 0
 * (the failure-counter cleanup still runs in case stale entries remain).
 */

import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

// Load env from .env.local
const ENV_FILE = "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local";
try {
  const env = readFileSync(ENV_FILE, "utf-8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
} catch (e) {
  console.error(`could not read ${ENV_FILE}:`, e);
  process.exit(1);
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// CLI parsing
const args = process.argv.slice(2);
let vmName: string | null = null;
let reason = "operator un-quarantine via _unquarantine-vm.ts";
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--reason" && i + 1 < args.length) {
    reason = args[i + 1];
    i++;
  } else if (a === "--help" || a === "-h") {
    console.log(
      `Usage: npx tsx instaclaw/scripts/_unquarantine-vm.ts <vm-name> [--reason "<text>"]\n\n` +
        `  vm-name: e.g. instaclaw-vm-911 or vm-911 (prefix auto-added)\n` +
        `  --reason: optional reason string logged to vm_lifecycle_log\n`,
    );
    process.exit(0);
  } else if (!a.startsWith("--")) {
    vmName = a;
  }
}

if (!vmName) {
  console.error("error: must provide a VM name as first arg");
  console.error("usage: npx tsx instaclaw/scripts/_unquarantine-vm.ts <vm-name>");
  process.exit(1);
}

// Auto-prefix "instaclaw-" if user passed "vm-911"
if (!vmName.startsWith("instaclaw-")) {
  vmName = `instaclaw-${vmName}`;
}

async function main() {
  // 1. Look up VM
  const { data: vm, error: vmErr } = await supabase
    .from("instaclaw_vms")
    .select("*")
    .eq("name", vmName)
    .single();

  if (vmErr || !vm) {
    console.error(`error: VM "${vmName}" not found`);
    if (vmErr) console.error(`  supabase: ${vmErr.message}`);
    process.exit(1);
  }

  console.log("─── Current state ──────────────────────────────────────────");
  console.log(`  name:                            ${vm.name}`);
  console.log(`  id:                              ${vm.id}`);
  console.log(`  ip:                              ${vm.ip_address}`);
  console.log(`  health_status:                   ${vm.health_status}`);
  console.log(`  health_fail_count:               ${vm.health_fail_count ?? 0}`);
  console.log(`  config_version:                  ${vm.config_version}`);
  console.log(`  reconcile_quarantined_at:        ${vm.reconcile_quarantined_at ?? "(not quarantined)"}`);
  console.log(`  reconcile_consecutive_failures:  ${vm.reconcile_consecutive_failures ?? 0} (main reconcile counter — left alone)`);
  console.log(`  reconcile_last_error:            ${vm.reconcile_last_error?.slice(0, 80) ?? "(none)"}`);
  console.log(`  assigned_to:                     ${vm.assigned_to ?? "(unassigned)"}`);

  // Look up owner email for the lifecycle log
  let userEmail: string | null = null;
  if (vm.assigned_to) {
    const { data: u } = await supabase
      .from("instaclaw_users")
      .select("email")
      .eq("id", vm.assigned_to)
      .single();
    userEmail = u?.email ?? null;
  }

  const wasQuarantined = vm.reconcile_quarantined_at !== null;
  if (!wasQuarantined) {
    console.log("\nWARNING: VM is NOT currently quarantined. Proceeding with");
    console.log("         counter cleanup anyway in case stale alert_log rows exist.");
  }

  // 2 + 3. Clear quarantine + reset health_fail_count
  console.log("\n─── Clearing quarantine + resetting counters ───────────────");
  const { error: updErr } = await supabase
    .from("instaclaw_vms")
    .update({
      reconcile_quarantined_at: null,
      reconcile_last_error: null,
      health_fail_count: 0,
    })
    .eq("id", vm.id);

  if (updErr) {
    console.error(`error: failed to clear quarantine: ${updErr.message}`);
    process.exit(1);
  }
  console.log("  ✓ reconcile_quarantined_at → NULL");
  console.log("  ✓ reconcile_last_error → NULL");
  console.log("  ✓ health_fail_count → 0");

  // 4. Delete C-failure counter rows
  const failureKeyPrefix = `stuck_vm_reconcile_failure:${vm.id}:`;
  // Use range deletion via like-pattern: PostgREST supports filter operators on delete
  const { data: deletedRows, error: delErr } = await supabase
    .from("instaclaw_admin_alert_log")
    .delete()
    .like("alert_key", `${failureKeyPrefix}%`)
    .select("id"); // select() makes delete return the deleted rows so we can count

  if (delErr) {
    console.error(`error: failed to clear failure counter: ${delErr.message}`);
    process.exit(1);
  }
  console.log(`  ✓ stuck_vm_reconcile_failure entries cleared: ${deletedRows?.length ?? 0} rows`);

  // 5. Log to lifecycle
  const { error: logErr } = await supabase
    .from("instaclaw_vm_lifecycle_log")
    .insert({
      vm_id: vm.id,
      vm_name: vm.name,
      ip_address: vm.ip_address,
      user_id: vm.assigned_to,
      user_email: userEmail,
      action: "unquarantine",
      reason: `${reason}${wasQuarantined ? "" : " (NOTE: VM was not quarantined at time of clear; only counter cleanup ran)"}`,
      provider_server_id: vm.provider_server_id?.toString() ?? null,
    });

  if (logErr) {
    console.warn(`warning: failed to write lifecycle log: ${logErr.message}`);
    console.warn(`         (state changes above still applied — only the log entry failed)`);
  } else {
    console.log("  ✓ instaclaw_vm_lifecycle_log entry recorded");
  }

  // 6. Final summary
  console.log("\n─── Done ───────────────────────────────────────────────────");
  console.log(`  ${vm.name} is now eligible for automated reconciliation again.`);
  console.log("");
  console.log("  Next steps:");
  console.log("    - reconcile-fleet tick (~3 min) will pick the VM up if cv-stale");
  console.log("    - reconcile-stuck-vms tick (~30 min) will pick it up if unhealthy");
  console.log("    - health-check tick (~2 min) will re-probe and update health_status");
  console.log("");
  console.log("  If the underlying issue isn't fixed, the cron may re-quarantine");
  console.log("  in 1.5h (3 failures × 30 min cadence).");
}

main().catch((e) => {
  console.error("unexpected error:", e);
  process.exit(1);
});
