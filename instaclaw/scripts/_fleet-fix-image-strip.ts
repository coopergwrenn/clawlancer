/**
 * Fleet deploy v39 — Fix user-image stripping + memory warn TTL + telemetry logging.
 *
 * Changes in v39:
 * 1. strip_images_from_older_messages() now strips from ALL roles (user, assistant, toolResult)
 *    Previously only stripped from toolResult — user-sent images (91K+ base64) persisted forever
 * 2. MEMORY_FLAG_TTL increased from 5min to 30min (warning was being removed before agent saw it)
 * 3. IMAGE_KEEP_RECENT reduced from 3 to 2
 * 4. Added telemetry logging to ~/.openclaw/logs/strip-thinking.log
 *
 * Runs reconcileVM() on all assigned VMs which deploys the updated strip-thinking.py.
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.join(__dirname, '../.env.local') });
dotenv.config({ path: path.join(__dirname, '../.env.ssh-key') });

import { createClient } from "@supabase/supabase-js";
import { reconcileVM } from "../lib/vm-reconcile";
import { VM_MANIFEST } from "../lib/vm-manifest";
import "../lib/ssh";
import { Client as SSH2Client } from "ssh2";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const BATCH_SIZE = 10;
const DRY_RUN = process.argv.includes("--dry-run");
const TEST_FIRST = process.argv.includes("--test-first");

const privateKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");

function sshConnect(vm: any): Promise<SSH2Client> {
  return new Promise((resolve, reject) => {
    const conn = new SSH2Client();
    const timer = setTimeout(() => reject(new Error("timeout")), 15000);
    conn.on("ready", () => { clearTimeout(timer); resolve(conn); });
    conn.on("error", (e) => { clearTimeout(timer); reject(e); });
    conn.connect({ host: vm.ip_address, port: vm.ssh_port || 22, username: vm.ssh_user || "openclaw", privateKey, readyTimeout: 15000 });
  });
}

function sshExec(conn: SSH2Client, cmd: string, timeout = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeout);
    conn.exec(cmd, (err, stream) => {
      if (err) { clearTimeout(timer); return reject(err); }
      let out = "";
      stream.on("data", (d: Buffer) => (out += d.toString()));
      stream.stderr.on("data", (d: Buffer) => (out += d.toString()));
      stream.on("close", () => { clearTimeout(timer); resolve(out.trim()); });
    });
  });
}

interface Result {
  name: string;
  ok: boolean;
  errors: string[];
  time: number;
}

async function fixVM(vm: any): Promise<Result> {
  const start = Date.now();
  const name = vm.name?.replace("instaclaw-", "") ?? vm.id;
  const errors: string[] = [];

  try {
    if (!DRY_RUN) {
      const result = await reconcileVM(vm, VM_MANIFEST, { dryRun: false });
      if (result.gatewayHealthy || result.errors.length === 0) {
        await supabase.from("instaclaw_vms").update({ config_version: VM_MANIFEST.version }).eq("id", vm.id);
      } else {
        errors.push(...result.errors);
      }
    }
  } catch (e: any) {
    errors.push(e.message);
  }

  return { name, ok: errors.length === 0, errors, time: Date.now() - start };
}

async function verify(vm: any): Promise<void> {
  const name = vm.name?.replace("instaclaw-", "") ?? vm.id;
  let conn: SSH2Client;
  try { conn = await sshConnect(vm); } catch (e: any) {
    console.log(`    ${name}: verify SSH failed (${e.message})`);
    return;
  }

  const result = await sshExec(conn, `
echo "=== strip-thinking.py checks ==="
# Check IMAGE_KEEP_RECENT value
grep "IMAGE_KEEP_RECENT" ~/.openclaw/scripts/strip-thinking.py 2>/dev/null | head -1
# Check if it handles ALL roles
grep -c "role.*toolResult" ~/.openclaw/scripts/strip-thinking.py 2>/dev/null || echo "0"
echo "---"
grep "has_image" ~/.openclaw/scripts/strip-thinking.py 2>/dev/null | head -1
echo "---"
# Check MEMORY_FLAG_TTL
grep "MEMORY_FLAG_TTL" ~/.openclaw/scripts/strip-thinking.py 2>/dev/null | head -1
echo "---"
# Check LOG_FILE
grep "LOG_FILE" ~/.openclaw/scripts/strip-thinking.py 2>/dev/null | head -1
echo "---"
# Check log_telemetry function exists
grep -c "def log_telemetry" ~/.openclaw/scripts/strip-thinking.py 2>/dev/null || echo "0"
echo "---"
# Run it manually and show output
python3 ~/.openclaw/scripts/strip-thinking.py 2>&1
echo "---"
# Check log file was created
ls -la ~/.openclaw/logs/strip-thinking.log 2>/dev/null || echo "no log yet"
cat ~/.openclaw/logs/strip-thinking.log 2>/dev/null | tail -3
echo "---"
# Session sizes after run
ls -lSh ~/.openclaw/agents/main/sessions/*.jsonl 2>/dev/null | head -3
  `, 60000);

  console.log(`\n    ${name}:`);
  console.log(result.split("\n").map(l => "      " + l).join("\n"));
  conn.end();
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log(`║  Fleet Fix: Image Strip v39 ${DRY_RUN ? "(DRY RUN)" : ""}                             ║`);
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("  FIX 1: Strip user-sent images (was toolResult only)");
  console.log("  FIX 2: MEMORY_FLAG_TTL 5min → 30min");
  console.log("  FIX 3: Telemetry logging to strip-thinking.log\n");

  const { data: vms } = await supabase
    .from("instaclaw_vms")
    .select("*")
    .eq("status", "assigned")
    .not("assigned_to", "is", null)
    .order("name");

  if (!vms?.length) { console.log("No assigned VMs found"); return; }
  console.log(`  Total assigned VMs: ${vms.length}`);

  if (TEST_FIRST) {
    // Test on vm-379 (Ape Capital) since they have the image problem
    const testVm = vms.find(v => v.name === "instaclaw-vm-379") || vms[0];
    console.log(`\n  --test-first: Testing on ${testVm.name}...`);
    const result = await fixVM(testVm);
    console.log(`  Result: ${result.ok ? "OK" : "FAIL"} ${result.name} (${result.time}ms)`);
    if (result.errors.length > 0) console.log(`    Errors: ${result.errors.join("; ")}`);

    console.log("\n  Verifying...");
    await verify(testVm);

    if (!result.ok) {
      console.log("\n  Test VM failed. Aborting.");
      return;
    }
    console.log("\n  Test VM passed. Proceeding with fleet...\n");
  }

  const globalStart = Date.now();
  const results: Result[] = [];
  let ok = 0, failed = 0;

  for (let i = 0; i < vms.length; i += BATCH_SIZE) {
    const batch = vms.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(vms.length / BATCH_SIZE);
    process.stdout.write(`  Batch ${batchNum}/${totalBatches} (${batch.map(v => v.name?.replace("instaclaw-", "")).join(", ")})...`);

    const batchResults = await Promise.all(batch.map(vm => fixVM(vm)));
    results.push(...batchResults);

    const batchOk = batchResults.filter(r => r.ok).length;
    const batchFailed = batchResults.filter(r => !r.ok).length;
    ok += batchOk;
    failed += batchFailed;
    console.log(` ${batchOk} OK${batchFailed > 0 ? ` ${batchFailed} FAIL` : ""}`);
  }

  const elapsed = ((Date.now() - globalStart) / 1000).toFixed(1);

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  RESULTS                                                     ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`  Total: ${vms.length} | OK: ${ok} | Failed: ${failed}`);
  console.log(`  Time: ${elapsed}s`);

  if (failed > 0) {
    console.log("\n  Failed VMs:");
    results.filter(r => !r.ok).forEach(r => {
      console.log(`    ${r.name}: ${r.errors.join("; ")}`);
    });
  }

  // Verify 5 VMs
  console.log("\n=== Post-deploy verification (5 VMs) ===");
  const apeVm = vms.find(v => v.name === "instaclaw-vm-379");
  const step = Math.floor(vms.length / 4);
  const verifyPicks = [
    apeVm || vms[0],
    vms[step],
    vms[step*2],
    vms[step*3],
    vms[vms.length-1],
  ].filter((v, i, arr) => arr.indexOf(v) === i); // deduplicate

  for (const vm of verifyPicks) {
    await verify(vm);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
