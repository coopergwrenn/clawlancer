/**
 * Fleet Rollout: Manifest v21
 *
 * Deploys:
 *   - Motion Graphics skill rename (SKILL.md v2.2.0)
 *   - Motion Graphics routing guidance in CAPABILITIES.md + QUICK-REFERENCE.md
 *   - Bootstrap safety: creates .bootstrap_consumed on VMs that already bootstrapped
 *   - Manifest version bump to v21
 *
 * Safety: --dry-run → --test-first (vm-050) → batched fleet rollout
 *
 * Usage:
 *   npx tsx --tsconfig tsconfig.json scripts/fleet-rollout-v21.ts --dry-run
 *   npx tsx --tsconfig tsconfig.json scripts/fleet-rollout-v21.ts --test-first
 *   npx tsx --tsconfig tsconfig.json scripts/fleet-rollout-v21.ts --rollout
 */
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.join(__dirname, "../.env.local") });
dotenv.config({ path: path.join(__dirname, "../.env.ssh-key") });

import { reconcileVM, type ReconcileResult } from "../lib/vm-reconcile";
import { VM_MANIFEST } from "../lib/vm-manifest";

const BATCH_SIZE = 3;
const BATCH_DELAY_MS = 30_000;
const TEST_VM_NAME = "instaclaw-vm-050";
const TARGET_VERSION = VM_MANIFEST.version; // 21

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// ── Helpers ──

function ts(): string {
  return new Date().toISOString().slice(11, 19);
}

function printResult(name: string, r: ReconcileResult) {
  const fixCount = r.fixed.length;
  const okCount = r.alreadyCorrect.length;
  const errCount = r.errors.length;
  const icon = errCount > 0 ? "!!" : fixCount > 0 ? ">>" : "OK";
  console.log(`  [${icon}] ${name}: ${fixCount} fixed, ${okCount} ok, ${errCount} errors`);
  if (r.fixed.length > 0) {
    for (const f of r.fixed) console.log(`       + ${f}`);
  }
  if (r.errors.length > 0) {
    for (const e of r.errors) console.log(`       ! ${e}`);
  }
  if (r.gatewayRestarted) {
    console.log(`       gateway: restarted, healthy=${r.gatewayHealthy}`);
  }
}

interface VMRow {
  id: string;
  name: string;
  ip_address: string;
  ssh_port: number;
  ssh_user: string;
  config_version: number | null;
  gateway_url: string | null;
  gateway_token: string | null;
  api_mode: string | null;
  health_status: string | null;
}

async function getAssignedVMs(): Promise<VMRow[]> {
  const { data, error } = await supabase
    .from("instaclaw_vms")
    .select("id, name, ip_address, ssh_port, ssh_user, config_version, gateway_url, gateway_token, api_mode, health_status")
    .eq("status", "assigned")
    .order("name");
  if (error) throw new Error(`Supabase query failed: ${error.message}`);
  return data ?? [];
}

async function updateConfigVersion(vmId: string, version: number) {
  const { error } = await supabase
    .from("instaclaw_vms")
    .update({ config_version: version })
    .eq("id", vmId);
  if (error) console.log(`       ! failed to update config_version in DB: ${error.message}`);
}

async function reconcileOne(vm: VMRow, dryRun: boolean): Promise<ReconcileResult> {
  const vmRecord = {
    id: vm.id,
    ip_address: vm.ip_address,
    ssh_port: vm.ssh_port ?? 22,
    ssh_user: vm.ssh_user ?? "openclaw",
    gateway_token: vm.gateway_token ?? undefined,
    api_mode: vm.api_mode ?? undefined,
  };
  return reconcileVM(vmRecord, VM_MANIFEST, { dryRun });
}

async function verifyHealth(vm: VMRow): Promise<boolean> {
  if (!vm.gateway_url) return true;
  try {
    const url = vm.gateway_url.replace(/\/$/, "") + "/health";
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return resp.ok;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Modes ──

async function dryRun() {
  console.log(`\n=== DRY RUN — Manifest v${TARGET_VERSION} ===\n`);
  const vms = await getAssignedVMs();
  const behind = vms.filter((v) => (v.config_version ?? 0) < TARGET_VERSION);

  console.log(`${behind.length} of ${vms.length} VMs behind v${TARGET_VERSION}\n`);

  // Dry-run on first behind VM
  const sample = behind[0];
  if (sample) {
    console.log(`[${ts()}] Dry-run on: ${sample.name} (v${sample.config_version})`);
    try {
      const result = await reconcileOne(sample, true);
      printResult(sample.name, result);
    } catch (err) {
      console.log(`  [!!] ${sample.name}: SSH failed — ${String(err)}`);
    }
  }

  console.log(`\nNext step: npx tsx --tsconfig tsconfig.json scripts/fleet-rollout-v21.ts --test-first\n`);
}

async function testFirst() {
  console.log(`\n=== TEST FIRST — ${TEST_VM_NAME} → v${TARGET_VERSION} ===\n`);
  const vms = await getAssignedVMs();
  const testVm = vms.find((v) => v.name === TEST_VM_NAME);

  if (!testVm) {
    console.error(`ERROR: ${TEST_VM_NAME} not found in assigned VMs.`);
    process.exit(1);
  }

  console.log(`[${ts()}] Target: ${testVm.name} (${testVm.ip_address}) — currently v${testVm.config_version}`);
  console.log(`[${ts()}] Running reconciliation (live)...`);

  const result = await reconcileOne(testVm, false);
  printResult(testVm.name, result);

  if (result.errors.length > 0) {
    console.log(`\n!! ${result.errors.length} errors occurred. Review before proceeding.\n`);
  }

  await updateConfigVersion(testVm.id, TARGET_VERSION);
  console.log(`[${ts()}] DB config_version updated to v${TARGET_VERSION}`);

  // Verify bootstrap fix
  console.log(`[${ts()}] Verifying bootstrap fix...`);
  const { NodeSSH } = await import("node-ssh");
  const ssh = new NodeSSH();
  const key = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");
  await ssh.connect({
    host: testVm.ip_address,
    port: testVm.ssh_port ?? 22,
    username: testVm.ssh_user ?? "openclaw",
    privateKey: key,
    readyTimeout: 10_000,
  });

  const bootstrapCheck = await ssh.execCommand(
    'test -f ~/.openclaw/workspace/.bootstrap_consumed && echo EXISTS || echo MISSING'
  );
  if (bootstrapCheck.stdout.trim() === 'EXISTS') {
    console.log(`  OK  .bootstrap_consumed exists`);
  } else {
    console.log(`  !!  .bootstrap_consumed still missing!`);
  }

  // Verify SKILL.md header
  const skillCheck = await ssh.execCommand(
    'head -3 ~/.openclaw/skills/video-production/SKILL.md 2>/dev/null'
  );
  if (skillCheck.stdout.includes("Motion Graphics")) {
    console.log(`  OK  SKILL.md renamed to Motion Graphics`);
  } else {
    console.log(`  !!  SKILL.md check: ${skillCheck.stdout.slice(0, 100)}`);
  }

  ssh.dispose();

  // Wait and verify gateway health
  console.log(`[${ts()}] Waiting 30s for gateway stability...`);
  await sleep(30_000);

  const healthy = await verifyHealth(testVm);
  console.log(`[${ts()}] Gateway health: ${healthy ? "200 OK" : "FAILED"}`);

  if (!healthy) {
    console.log(`\n!! Gateway unhealthy on ${TEST_VM_NAME}. DO NOT proceed with fleet rollout.\n`);
    process.exit(1);
  }

  console.log(`\n=== ${TEST_VM_NAME} PASSED — safe to roll out ===`);
  console.log(`Next step: npx tsx --tsconfig tsconfig.json scripts/fleet-rollout-v21.ts --rollout\n`);
}

async function rollout() {
  console.log(`\n=== FLEET ROLLOUT — v${TARGET_VERSION} | batch=${BATCH_SIZE} | delay=${BATCH_DELAY_MS / 1000}s ===\n`);
  const vms = await getAssignedVMs();
  const behind = vms.filter((v) => (v.config_version ?? 0) < TARGET_VERSION);

  console.log(`${behind.length} VMs need update (${vms.length} total assigned)`);
  if (behind.length === 0) {
    console.log("All VMs are at v" + TARGET_VERSION + ". Nothing to do.\n");
    return;
  }

  let batchNum = 0;
  let successCount = 0;
  let errorCount = 0;
  const failedVMs: string[] = [];

  for (let i = 0; i < behind.length; i += BATCH_SIZE) {
    batchNum++;
    const batch = behind.slice(i, i + BATCH_SIZE);
    console.log(`\n── Batch ${batchNum} (${batch.map((v) => v.name).join(", ")}) ──`);

    await Promise.allSettled(
      batch.map(async (vm) => {
        console.log(`[${ts()}] ${vm.name} (v${vm.config_version}) — reconciling...`);
        try {
          const result = await reconcileOne(vm, false);
          printResult(vm.name, result);

          if (result.errors.length > 0) {
            errorCount++;
            failedVMs.push(vm.name);
          } else {
            successCount++;
          }

          await updateConfigVersion(vm.id, TARGET_VERSION);
          return result;
        } catch (err) {
          console.log(`  [!!] ${vm.name}: FAILED — ${String(err)}`);
          errorCount++;
          failedVMs.push(vm.name);
          throw err;
        }
      }),
    );

    const done = Math.min(i + BATCH_SIZE, behind.length);
    console.log(`\n  Progress: ${done}/${behind.length} (${successCount} ok, ${errorCount} errors)`);

    if (i + BATCH_SIZE < behind.length) {
      console.log(`  Waiting ${BATCH_DELAY_MS / 1000}s before next batch...`);
      await sleep(BATCH_DELAY_MS);
    }
  }

  console.log(`\n=== ROLLOUT COMPLETE ===`);
  console.log(`  Total: ${behind.length} VMs processed`);
  console.log(`  Success: ${successCount}`);
  console.log(`  Errors: ${errorCount}`);
  if (failedVMs.length > 0) {
    console.log(`  Failed VMs: ${failedVMs.join(", ")}`);
  }
  console.log();
}

// ── CLI ──

const mode = process.argv[2];
if (mode === "--dry-run") {
  dryRun().catch((err) => { console.error(err); process.exit(1); });
} else if (mode === "--test-first") {
  testFirst().catch((err) => { console.error(err); process.exit(1); });
} else if (mode === "--rollout") {
  rollout().catch((err) => { console.error(err); process.exit(1); });
} else {
  console.log("Usage:");
  console.log("  npx tsx --tsconfig tsconfig.json scripts/fleet-rollout-v21.ts --dry-run");
  console.log("  npx tsx --tsconfig tsconfig.json scripts/fleet-rollout-v21.ts --test-first");
  console.log("  npx tsx --tsconfig tsconfig.json scripts/fleet-rollout-v21.ts --rollout");
  process.exit(1);
}
