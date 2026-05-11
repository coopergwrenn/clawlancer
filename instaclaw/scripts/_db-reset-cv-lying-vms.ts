/**
 * Phase 4 (P1-1): one-time DB cv-reset for the 10 lying-DB VMs identified
 * by the 2026-05-11 lying-DB census re-run (post-1fb249d5 fixes).
 *
 * Why: my Fix B (stepSystemdUnit verify-after-write) and Fix C
 * (stepPrctlSubreaper drop-in rollback) PREVENT future lying. But VMs
 * already at cv=91 with lying state are excluded by the reconciler's
 * `lt(config_version, 91)` filter — they sit there forever. cv-reset
 * forces the fixed reconciler to re-process them.
 *
 * Target value: cv=85. That's behind v86 (TasksMax=120), v87 (prctl-
 * subreaper), v88 (build-essential gcc), v89, v90, v91. Reconciler will
 * re-run all step* functions including the just-fixed verify-after-write
 * paths. If the underlying issue is real (e.g., gateway dead), the new
 * code surfaces it as result.errors → pushFailed gate at route.ts:280
 * holds cv at 85. Next cycle retries naturally.
 *
 * Excluded: VMs in PARTIAL_LIE_OTHER bucket whose config is actually
 * correct and only the gateway is in a transient state (vm-902, vm-320).
 * cv-reset would just churn them.
 *
 * Usage:
 *   npx tsx scripts/_db-reset-cv-lying-vms.ts             # dry-run
 *   npx tsx scripts/_db-reset-cv-lying-vms.ts --apply
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

for (const f of ["/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local"]) {
  for (const l of readFileSync(f, "utf-8").split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) {
      process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const APPLY = process.argv.includes("--apply");
const RESET_TO_CV = 85;

// From 2026-05-11 lying-DB census re-run after 1fb249d5 fixes:
//   TOTAL_LIE (6):           T=75, no v86/v87/v88
//   PARTIAL_LIE_DROPIN (1):  T=120 OK, drop-in present, prctl pkg MISSING (v87 partial)
//   PARTIAL_LIE_OTHER (1):   vm-512 — T=120 OK, but prctl pkg+drop-in BOTH missing
//                            (gateway also dead — disk-full incident from earlier today)
//   SCHEMA_ZERO_LIE (2):     T=4666 (no override.conf at all) + everything missing
const TARGETS: Array<{ name: string; shape: string; reason: string }> = [
  { name: "instaclaw-vm-511", shape: "TOTAL_LIE",         reason: "T=75 + gcc/prctl all missing" },
  { name: "instaclaw-vm-907", shape: "TOTAL_LIE",         reason: "T=75 + prctl missing (gcc OK)" },
  { name: "instaclaw-vm-910", shape: "TOTAL_LIE",         reason: "T=75 + gcc/prctl all missing" },
  { name: "instaclaw-vm-912", shape: "TOTAL_LIE",         reason: "T=75 + gcc/prctl all missing" },
  { name: "instaclaw-vm-914", shape: "TOTAL_LIE",         reason: "T=75 + gcc/prctl all missing" },
  { name: "instaclaw-vm-916", shape: "TOTAL_LIE",         reason: "T=75 + gcc/prctl all missing" },
  { name: "instaclaw-vm-905", shape: "PARTIAL_LIE_DROPIN", reason: "T=120, drop-in OK, prctl pkg MISSING (Fix C target)" },
  { name: "instaclaw-vm-512", shape: "PARTIAL_LIE_OTHER", reason: "T=120 OK but prctl pkg+drop-in MISSING; gateway dead (disk-full earlier)" },
  { name: "instaclaw-vm-895", shape: "SCHEMA_ZERO_LIE",   reason: "T=4666 (no override.conf ever) + all missing" },
  { name: "instaclaw-vm-901", shape: "SCHEMA_ZERO_LIE",   reason: "T=4666 (no override.conf ever) + all missing" },
];

async function main() {
  console.log(`\n=== Phase 4: cv-reset for lying-DB VMs ${APPLY ? "(APPLY)" : "(DRY-RUN)"} ===`);
  console.log(`Target cv: ${RESET_TO_CV} (forces reconciler to re-evaluate v86, v87, v88, v89, v90, v91)\n`);

  const { data: vms, error } = await sb
    .from("instaclaw_vms")
    .select("id, name, config_version, health_status, ip_address, assigned_to")
    .in("name", TARGETS.map((t) => t.name));

  if (error || !vms) {
    console.error("query failed:", error?.message);
    process.exit(1);
  }

  console.log(`Resolved ${vms.length}/${TARGETS.length} VMs from DB:\n`);
  for (const t of TARGETS) {
    const vm = vms.find((v) => v.name === t.name);
    if (!vm) {
      console.log(`  ⚠️  ${t.name.padEnd(22)} NOT FOUND in DB`);
      continue;
    }
    const arrow = vm.config_version > RESET_TO_CV ? `${vm.config_version} → ${RESET_TO_CV}` : `${vm.config_version} (already ≤ target, no change)`;
    console.log(`  ${t.shape.padEnd(20)} ${t.name.padEnd(22)} cv=${arrow}  health=${vm.health_status}  reason: ${t.reason}`);
  }

  // Filter to VMs that actually need a downgrade (skip if already < target)
  const toReset = vms.filter((v) => v.config_version > RESET_TO_CV);
  console.log(`\nVMs needing reset: ${toReset.length}/${vms.length}`);

  if (!APPLY) {
    console.log(`\nDRY-RUN — no changes made. Re-run with --apply to commit.`);
    return;
  }
  if (toReset.length === 0) {
    console.log(`\nNothing to apply — all targets already at or below cv=${RESET_TO_CV}.`);
    return;
  }

  console.log(`\nApplying UPDATE config_version=${RESET_TO_CV}...`);
  const ids = toReset.map((v) => v.id);
  const { error: updErr, count } = await sb
    .from("instaclaw_vms")
    .update({ config_version: RESET_TO_CV }, { count: "exact" })
    .in("id", ids);

  if (updErr) {
    console.error("update failed:", updErr.message);
    process.exit(1);
  }

  console.log(`OK — reset ${count ?? "?"} VMs to cv=${RESET_TO_CV}.`);
  console.log(`\nWhat happens next:`);
  console.log(`  1. reconcile-fleet cron will pick these VMs up on next tick (every 3 min, oldest-cv-first ordering puts them at the queue HEAD).`);
  console.log(`  2. Reconciler runs all step* functions with the 1fb249d5 verify-after-write fixes.`);
  console.log(`  3. Fix B (stepSystemdUnit) detects TasksMax=75 mismatch + writes override.conf + verifies systemctl runtime value matches.`);
  console.log(`  4. Fix C (stepPrctlSubreaper) detects drop-in/package mismatch + atomically rolls back orphaned drop-in.`);
  console.log(`  5. If verify-after-write succeeds: cv bumps back to 91.`);
  console.log(`  6. If verify-after-write fails: result.errors populated, pushFailed gate holds cv at 85, error visible in cron logs.`);
  console.log(`\nMonitor:  re-run scripts/_lying-db-census.ts in ~10-30 min to see drop in lying-DB rate.`);
}

main().then(() => process.exit(0));
