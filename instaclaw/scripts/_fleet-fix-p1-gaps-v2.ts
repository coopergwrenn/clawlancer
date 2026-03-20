/**
 * Fleet fix P1 gaps v2 — Fixed marker detection.
 *
 * v37 stripped the old supplement but the reconciler couldn't re-append because
 * "Rule priority order" exists in the BASE SOUL.md template (not just the supplement).
 *
 * v38 fixes the marker to "INTELLIGENCE_INTEGRATED" which is unique to the supplement.
 * This script just runs reconcileVM() on all VMs — the reconciler will:
 * 1. See "INTELLIGENCE_INTEGRATED" is ABSENT from SOUL.md (was stripped by v37)
 * 2. Re-append the current supplement (with Sharing Files, deliver_file, Be selective)
 * 3. Set reserveTokensFloor=35000 (already done by v37)
 *
 * Also handles VMs that missed HEARTBEAT.md consolidation in v37.
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

const CONSOLIDATION_BLOCK = `

## Weekly Memory Consolidation (First Heartbeat on Sunday)

**Purpose:** Prevent MEMORY.md from growing unbounded and filling context.
1. Read MEMORY.md — if >20KB, consolidate:
   - Merge duplicate entries (same topic, different dates)
   - Remove entries older than 30 days with no recent references
   - Compress verbose entries to 1-2 line summaries
   - Keep all active project notes, user preferences, and financial data
2. Archive old completed tasks from memory/active-tasks.md (>7 days old)
3. Delete gateway logs older than 3 days: \`find /tmp/openclaw -name "*.log" -mtime +3 -delete\`
4. Target: keep MEMORY.md under 15KB after consolidation
`;

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

function sshConnect(vm: any): Promise<SSH2Client> {
  const privateKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");
  return new Promise((resolve, reject) => {
    const conn = new SSH2Client();
    const timer = setTimeout(() => reject(new Error("SSH connect timeout")), 15000);
    conn.on("ready", () => { clearTimeout(timer); resolve(conn); });
    conn.on("error", (e) => { clearTimeout(timer); reject(e); });
    conn.connect({
      host: vm.ip_address,
      port: vm.ssh_port || 22,
      username: vm.ssh_user || "openclaw",
      privateKey,
      readyTimeout: 15000,
    });
  });
}

interface Result {
  name: string;
  ok: boolean;
  heartbeatFixed: boolean;
  errors: string[];
  time: number;
}

async function fixVM(vm: any): Promise<Result> {
  const start = Date.now();
  const name = vm.name?.replace("instaclaw-", "") ?? vm.id;
  const errors: string[] = [];
  let heartbeatFixed = false;

  // Step 1: Fix HEARTBEAT.md if still missing consolidation block
  // (25 VMs had missing HEARTBEAT.md in v37 — reconciler may have created the file since then)
  try {
    const conn = await sshConnect(vm);
    const hasConsolidation = await sshExec(conn, `grep -c "Memory Consolidation" ~/.openclaw/workspace/HEARTBEAT.md 2>/dev/null || echo "0"`);
    if (parseInt(hasConsolidation) === 0) {
      const hbExists = await sshExec(conn, `test -f ~/.openclaw/workspace/HEARTBEAT.md && echo "YES" || echo "NO"`);
      if (hbExists === "YES" && !DRY_RUN) {
        const b64 = Buffer.from(CONSOLIDATION_BLOCK, 'utf-8').toString('base64');
        await sshExec(conn, `echo '${b64}' | base64 -d >> ~/.openclaw/workspace/HEARTBEAT.md`);
        heartbeatFixed = true;
      }
    }
    conn.end();
  } catch (e: any) {
    // SSH failed for HEARTBEAT fix — reconcileVM will still try
    errors.push(`heartbeat SSH: ${e.message}`);
  }

  // Step 2: Run reconcileVM() — the new marker "INTELLIGENCE_INTEGRATED" means
  // the reconciler will re-append the supplement on VMs where it was stripped by v37
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

  return { name, ok: errors.length === 0, heartbeatFixed, errors, time: Date.now() - start };
}

async function verify(vm: any): Promise<void> {
  const name = vm.name?.replace("instaclaw-", "") ?? vm.id;
  let conn: SSH2Client;
  try { conn = await sshConnect(vm); } catch (e: any) {
    console.log(`    ${name}: verify SSH failed (${e.message})`);
    return;
  }

  const script = `
echo "===SHARING==="
grep -c "Sharing Files" ~/.openclaw/workspace/SOUL.md 2>/dev/null || echo "0"
echo "===DELIVER==="
grep -c "deliver_file" ~/.openclaw/workspace/SOUL.md 2>/dev/null || echo "0"
echo "===SELECTIVE==="
grep -c "Be selective" ~/.openclaw/workspace/SOUL.md 2>/dev/null || echo "0"
echo "===CONSOLID==="
grep -c "Memory Consolidation" ~/.openclaw/workspace/HEARTBEAT.md 2>/dev/null || echo "0"
echo "===RTF==="
source ~/.nvm/nvm.sh && openclaw config get agents.defaults.compaction.reserveTokensFloor 2>&1
echo "===MARKER==="
grep -c "INTELLIGENCE_INTEGRATED" ~/.openclaw/workspace/SOUL.md 2>/dev/null || echo "0"
echo "===END==="
`;

  const raw = await sshExec(conn, script, 30000);
  conn.end();

  const section = (key: string): string => {
    const re = new RegExp(`===${key}===\\n([\\s\\S]*?)(?:\\n===|$)`);
    const m = raw.match(re);
    return m ? m[1].trim() : "";
  };

  const sharing = parseInt(section("SHARING")) || 0;
  const deliver = parseInt(section("DELIVER")) || 0;
  const selective = parseInt(section("SELECTIVE")) || 0;
  const consolid = parseInt(section("CONSOLID")) || 0;
  const rtf = section("RTF");
  const marker = parseInt(section("MARKER")) || 0;

  console.log(`    ${name}: Sharing=${sharing > 0 ? "✅" : "❌"} deliver_file=${deliver > 0 ? "✅" : "❌"} Be-selective=${selective > 0 ? "✅" : "❌"} Consolidation=${consolid > 0 ? "✅" : "❌"} RTF=${rtf} marker=${marker}`);
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log(`║  Fleet Fix P1 Gaps v2 — Manifest v${VM_MANIFEST.version} ${DRY_RUN ? "(DRY RUN)" : ""}                      ║`);
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("  Fix: Changed supplement marker from 'Rule priority order' to 'INTELLIGENCE_INTEGRATED'");
  console.log("  The reconciler will now re-append the supplement with Sharing Files, deliver_file, Be selective\n");

  const { data: vms } = await supabase
    .from("instaclaw_vms")
    .select("*")
    .eq("status", "assigned")
    .not("assigned_to", "is", null)
    .order("name");

  if (!vms?.length) { console.log("No assigned VMs found"); return; }
  console.log(`  Total assigned VMs: ${vms.length}`);

  if (TEST_FIRST) {
    const testVm = vms[0];
    console.log(`\n  --test-first: Testing on ${testVm.name}...`);
    const result = await fixVM(testVm);
    console.log(`  Result: ${result.ok ? "✅" : "❌"} ${result.name} (${result.time}ms)`);
    if (result.errors.length > 0) console.log(`    Errors: ${result.errors.join("; ")}`);

    console.log("\n  Verifying...");
    await verify(testVm);

    if (!result.ok) {
      console.log("\n  ❌ Test VM failed. Aborting.");
      return;
    }
    console.log("\n  ✅ Test VM passed. Proceeding with fleet...\n");
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
    console.log(` ${batchOk}✅ ${batchFailed > 0 ? batchFailed + "❌" : ""}`);
  }

  const elapsed = ((Date.now() - globalStart) / 1000).toFixed(1);

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  RESULTS                                                     ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`  Total: ${vms.length} | OK: ${ok} | Failed: ${failed}`);
  console.log(`  HEARTBEAT.md fixed: ${results.filter(r => r.heartbeatFixed).length}`);
  console.log(`  Time: ${elapsed}s`);

  if (failed > 0) {
    console.log("\n  Failed VMs:");
    results.filter(r => !r.ok).forEach(r => {
      console.log(`    ${r.name}: ${r.errors.join("; ")}`);
    });
  }

  // Verify 5 VMs
  console.log("\n=== Post-deploy verification (5 VMs) ===");
  const step = Math.floor(vms.length / 5);
  const verifyPicks = [vms[0], vms[step], vms[step*2], vms[step*3], vms[vms.length-1]];
  for (const vm of verifyPicks) {
    await verify(vm);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
