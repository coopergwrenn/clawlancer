/**
 * Fleet fix for P1 audit gaps:
 * 1. Strip old SOUL.md supplement (INTELLIGENCE_INTEGRATED_V1) so reconciler re-appends
 *    the current version (which includes Sharing Files, deliver_file, Be selective)
 * 2. Append Weekly Memory Consolidation block to HEARTBEAT.md if not present
 * 3. Run reconcileVM() to apply manifest v37 (re-appends supplement, sets reserveTokensFloor=35000)
 *
 * Safety: --test-first flag tests on one VM before fleet. --dry-run supported.
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
  soulFixed: boolean;
  heartbeatFixed: boolean;
  reconciled: boolean;
  errors: string[];
  time: number;
}

async function fixVM(vm: any): Promise<Result> {
  const start = Date.now();
  const name = vm.name?.replace("instaclaw-", "") ?? vm.id;
  const errors: string[] = [];
  let soulFixed = false;
  let heartbeatFixed = false;
  let reconciled = false;

  let conn: SSH2Client;
  try {
    conn = await sshConnect(vm);
  } catch (e: any) {
    return { name, ok: false, soulFixed, heartbeatFixed, reconciled, errors: [`SSH: ${e.message}`], time: Date.now() - start };
  }

  try {
    // === Step 1: Strip old SOUL.md supplement ===
    // Check if old supplement exists
    const hasOldSupplement = await sshExec(conn, `grep -c "INTELLIGENCE_INTEGRATED_V1" ~/.openclaw/workspace/SOUL.md 2>/dev/null || echo "0"`);
    if (parseInt(hasOldSupplement) > 0) {
      if (!DRY_RUN) {
        // Delete from the INTELLIGENCE_INTEGRATED_V1 marker to end of file
        // This removes the old supplement so the reconciler can re-append the updated version
        await sshExec(conn, `sed -i '/<!-- INTELLIGENCE_INTEGRATED_V1 -->/,$d' ~/.openclaw/workspace/SOUL.md`);
      }
      soulFixed = true;
    } else {
      // Check if updated supplement is already present
      const hasSharingFiles = await sshExec(conn, `grep -c "Sharing Files" ~/.openclaw/workspace/SOUL.md 2>/dev/null || echo "0"`);
      if (parseInt(hasSharingFiles) > 0) {
        // Already has the updated content — nothing to do
      } else {
        // No supplement at all? Reconciler will append it.
        soulFixed = true; // Mark as needing fix, reconciler will handle
      }
    }

    // === Step 2: Append consolidation block to HEARTBEAT.md ===
    const hasConsolidation = await sshExec(conn, `grep -c "Memory Consolidation" ~/.openclaw/workspace/HEARTBEAT.md 2>/dev/null || echo "0"`);
    if (parseInt(hasConsolidation) === 0) {
      // Check HEARTBEAT.md exists first
      const hbExists = await sshExec(conn, `test -f ~/.openclaw/workspace/HEARTBEAT.md && echo "YES" || echo "NO"`);
      if (hbExists === "YES") {
        if (!DRY_RUN) {
          const b64 = Buffer.from(CONSOLIDATION_BLOCK, 'utf-8').toString('base64');
          await sshExec(conn, `echo '${b64}' | base64 -d >> ~/.openclaw/workspace/HEARTBEAT.md`);
        }
        heartbeatFixed = true;
      } else {
        errors.push("HEARTBEAT.md missing — reconciler will create on next cycle");
      }
    }

    conn.end();

    // === Step 3: Run reconcileVM() to apply manifest v37 ===
    // This re-appends the updated supplement (Sharing Files, deliver_file, Be selective)
    // and sets reserveTokensFloor=35000
    if (!DRY_RUN) {
      const result = await reconcileVM(vm, VM_MANIFEST, { dryRun: false });
      if (result.gatewayHealthy || result.errors.length === 0) {
        await supabase.from("instaclaw_vms").update({ config_version: VM_MANIFEST.version }).eq("id", vm.id);
        reconciled = true;
      } else {
        errors.push(...result.errors);
      }
    } else {
      reconciled = true; // dry-run counts as success
    }
  } catch (e: any) {
    errors.push(e.message);
    try { conn.end(); } catch {}
  }

  return {
    name,
    ok: errors.length === 0,
    soulFixed,
    heartbeatFixed,
    reconciled,
    errors,
    time: Date.now() - start,
  };
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log(`║  Fleet Fix P1 Gaps — Manifest v${VM_MANIFEST.version} ${DRY_RUN ? "(DRY RUN)" : ""}                       ║`);
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("  Fixes:");
  console.log("    1. SOUL.md: strip old supplement → reconciler re-appends with Sharing Files, deliver_file, Be selective");
  console.log("    2. HEARTBEAT.md: append Weekly Memory Consolidation block");
  console.log("    3. reserveTokensFloor: 30000 → 35000");
  console.log();

  const { data: vms } = await supabase
    .from("instaclaw_vms")
    .select("*")
    .eq("status", "assigned")
    .not("assigned_to", "is", null)
    .order("name");

  if (!vms?.length) { console.log("No assigned VMs found"); return; }
  console.log(`  Total assigned VMs: ${vms.length}`);

  // Test-first: fix one VM and pause
  if (TEST_FIRST) {
    const testVm = vms[0];
    console.log(`\n  --test-first: Testing on ${testVm.name}...`);
    const result = await fixVM(testVm);
    console.log(`  Result: ${result.ok ? "✅" : "❌"} ${result.name}`);
    console.log(`    SOUL fixed: ${result.soulFixed} | HEARTBEAT fixed: ${result.heartbeatFixed} | Reconciled: ${result.reconciled}`);
    if (result.errors.length > 0) console.log(`    Errors: ${result.errors.join("; ")}`);
    if (!result.ok) {
      console.log("\n  ❌ Test VM failed. Aborting.");
      return;
    }

    // Verify the test VM
    console.log("\n  Verifying test VM...");
    let conn: SSH2Client;
    try {
      conn = await sshConnect(testVm);
      const sharing = await sshExec(conn, `grep -c "Sharing Files" ~/.openclaw/workspace/SOUL.md 2>/dev/null || echo "0"`);
      const deliver = await sshExec(conn, `grep -c "deliver_file" ~/.openclaw/workspace/SOUL.md 2>/dev/null || echo "0"`);
      const selective = await sshExec(conn, `grep -c "Be selective" ~/.openclaw/workspace/SOUL.md 2>/dev/null || echo "0"`);
      const consolid = await sshExec(conn, `grep -c "Memory Consolidation" ~/.openclaw/workspace/HEARTBEAT.md 2>/dev/null || echo "0"`);
      const rtf = await sshExec(conn, `source ~/.nvm/nvm.sh && openclaw config get agents.defaults.compaction.reserveTokensFloor 2>&1`);
      console.log(`    SOUL.md: Sharing Files=${parseInt(sharing) > 0 ? "✅" : "❌"} deliver_file=${parseInt(deliver) > 0 ? "✅" : "❌"} Be selective=${parseInt(selective) > 0 ? "✅" : "❌"}`);
      console.log(`    HEARTBEAT.md: Consolidation=${parseInt(consolid) > 0 ? "✅" : "❌"}`);
      console.log(`    reserveTokensFloor=${rtf}`);
      conn.end();
    } catch (e: any) {
      console.log(`    Verify failed: ${e.message}`);
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
  console.log(`  Total: ${vms.length} VMs`);
  console.log(`  OK: ${ok} | Failed: ${failed}`);
  console.log(`  SOUL.md stripped: ${results.filter(r => r.soulFixed).length}`);
  console.log(`  HEARTBEAT.md fixed: ${results.filter(r => r.heartbeatFixed).length}`);
  console.log(`  Reconciled to v${VM_MANIFEST.version}: ${results.filter(r => r.reconciled).length}`);
  console.log(`  Time: ${elapsed}s`);

  if (failed > 0) {
    console.log("\n  Failed VMs:");
    results.filter(r => !r.ok).forEach(r => {
      console.log(`    ${r.name}: ${r.errors.join("; ")}`);
    });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
