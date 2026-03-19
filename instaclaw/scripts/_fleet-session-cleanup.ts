/**
 * Fleet-wide session bloat cleanup
 *
 * Removes stale cron session files from all assigned VMs, rebuilds sessions.json,
 * cleans browser cache/logs/media, restarts gateways.
 *
 * Usage:
 *   npx tsx scripts/_fleet-session-cleanup.ts --dry-run     # Report only, no changes
 *   npx tsx scripts/_fleet-session-cleanup.ts --test-first   # Clean one VM, pause
 *   npx tsx scripts/_fleet-session-cleanup.ts --all          # Clean entire fleet
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { Client as SSH2Client } from "ssh2";

const DRY_RUN = process.argv.includes("--dry-run");
const TEST_FIRST = process.argv.includes("--test-first");
const ALL = process.argv.includes("--all");
const BATCH_SIZE = 10;
const XDG = 'export XDG_RUNTIME_DIR="/run/user/$(id -u)"';

if (!DRY_RUN && !TEST_FIRST && !ALL) {
  console.error("Usage: npx tsx scripts/_fleet-session-cleanup.ts [--dry-run | --test-first | --all]");
  console.error("  --dry-run     Report session counts without making changes");
  console.error("  --test-first  Clean one VM first, then stop for review");
  console.error("  --all         Clean all assigned VMs");
  process.exit(1);
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

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

interface CleanupResult {
  name: string;
  status: string;
  beforeCount?: number;
  afterCount?: number;
  beforeSize?: string;
  afterSize?: string;
  deletedCount?: number;
  indexSize?: number;
  staleCount?: number;
}

async function cleanVM(vm: any, privateKey: string): Promise<CleanupResult> {
  const label = vm.name ?? vm.id;
  let conn: SSH2Client | null = null;

  try {
    conn = new SSH2Client();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SSH timeout")), 10000);
      conn!.on("ready", () => { clearTimeout(timer); resolve(); });
      conn!.on("error", (e) => { clearTimeout(timer); reject(e); });
      conn!.connect({
        host: vm.ip_address,
        port: vm.ssh_port || 22,
        username: vm.ssh_user || "openclaw",
        privateKey,
        readyTimeout: 10000,
      });
    });

    // Before state
    const beforeCount = parseInt(await sshExec(conn, "ls ~/.openclaw/agents/main/sessions/*.jsonl 2>/dev/null | wc -l") || "0");
    const beforeSize = await sshExec(conn, "du -sh ~/.openclaw/agents/main/sessions/ 2>/dev/null | cut -f1") || "0";
    const indexSize = parseInt(await sshExec(conn, "wc -c < ~/.openclaw/agents/main/sessions/sessions.json 2>/dev/null || echo 0") || "0");
    const staleCount = parseInt(await sshExec(conn, "find ~/.openclaw/agents/main/sessions -maxdepth 1 -name '*.jsonl' -mtime +7 2>/dev/null | wc -l") || "0");

    if (DRY_RUN) {
      conn.end();
      return { name: label, status: "WOULD_CLEAN", beforeCount, beforeSize, indexSize, staleCount };
    }

    // Find sessions modified in last 24h (KEEP these — active conversations)
    const recentFiles = await sshExec(conn, `
      cd ~/.openclaw/agents/main/sessions 2>/dev/null || exit 0
      find . -maxdepth 1 -name '*.jsonl' -mtime -1 -printf '%f\\n' 2>/dev/null
    `);
    const keepList = recentFiles ? recentFiles.split("\n").filter(Boolean) : [];

    // Fallback: if nothing recent, keep at least the most recently modified file
    if (keepList.length === 0) {
      const fallback = await sshExec(conn, `cd ~/.openclaw/agents/main/sessions 2>/dev/null && ls -t *.jsonl 2>/dev/null | head -1`);
      if (fallback) keepList.push(fallback);
    }

    // Delete stale sessions (older than 7 days AND not in last 24h)
    let deletedCount = 0;
    if (keepList.length > 0) {
      const excludes = keepList.map(f => `! -name '${f}'`).join(" ");
      const result = await sshExec(conn, `cd ~/.openclaw/agents/main/sessions && BEFORE=$(find . -maxdepth 1 -name '*.jsonl' ${excludes} -mtime +7 | wc -l) && find . -maxdepth 1 -name '*.jsonl' ${excludes} -mtime +7 -delete 2>/dev/null; echo "$BEFORE"`);
      deletedCount = parseInt(result) || 0;
    }

    // Rebuild sessions.json
    await sshExec(conn, `python3 -c "
import json, os, glob
sessions_dir = os.path.expanduser('~/.openclaw/agents/main/sessions')
existing = set(os.path.basename(f).replace('.jsonl','') for f in glob.glob(sessions_dir + '/*.jsonl'))
sj_path = sessions_dir + '/sessions.json'
try:
    with open(sj_path) as f: sj = json.load(f)
    sj = {k:v for k,v in sj.items() if v.get('sessionId') in existing}
except: sj = {}
with open(sj_path, 'w') as f: json.dump(sj, f, indent=2)
print(f'rebuilt: {len(sj)} entries')
"`);

    // Clean browser cache
    await sshExec(conn, "rm -rf ~/.config/chromium/Default/Cache ~/.config/chromium/Default/Code\\ Cache ~/.config/chromium/Default/GPUCache 2>/dev/null");

    // Truncate gateway logs
    await sshExec(conn, `find /tmp/openclaw -name '*.log' -size +1M -exec sh -c 'tail -1000 "$1" > "$1.tmp" && mv "$1.tmp" "$1"' _ {} \\; 2>/dev/null`, 15000);

    // Clean old media
    await sshExec(conn, "find ~/.openclaw/media -type f -mtime +14 -delete 2>/dev/null");

    // Clean session archives
    await sshExec(conn, "find ~/.openclaw/agents/main/sessions/archive -type f -mtime +7 -delete 2>/dev/null");

    // Restart gateway
    await sshExec(conn, `${XDG} && systemctl --user restart openclaw-gateway 2>&1`, 30000);

    // Quick health check (wait up to 15s)
    let healthy = false;
    for (let i = 0; i < 3; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const health = await sshExec(conn, 'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:18789/health 2>/dev/null || echo "000"');
      if (health === "200") { healthy = true; break; }
    }

    // After state
    const afterCount = parseInt(await sshExec(conn, "ls ~/.openclaw/agents/main/sessions/*.jsonl 2>/dev/null | wc -l") || "0");
    const afterSize = await sshExec(conn, "du -sh ~/.openclaw/agents/main/sessions/ 2>/dev/null | cut -f1") || "0";

    conn.end();
    return {
      name: label,
      status: healthy ? "CLEANED" : "CLEANED_UNHEALTHY",
      beforeCount,
      afterCount,
      beforeSize,
      afterSize,
      deletedCount,
    };
  } catch (err: any) {
    conn?.end();
    return { name: label, status: `ERROR: ${err.message?.substring(0, 60)}` };
  }
}

async function main() {
  const mode = DRY_RUN ? "DRY RUN" : TEST_FIRST ? "TEST FIRST" : "ALL";
  console.log(`Fleet Session Cleanup (${mode})`);
  console.log("=".repeat(60));

  const { data: vms, error } = await supabase
    .from("instaclaw_vms")
    .select("id, name, ip_address, ssh_port, ssh_user")
    .eq("status", "assigned")
    .not("assigned_to", "is", null)
    .order("name");

  if (error) { console.error("Query error:", error.message); return; }
  if (!vms?.length) { console.log("No assigned VMs found."); return; }

  console.log(`Found ${vms.length} assigned VMs.\n`);

  const privateKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");

  if (TEST_FIRST) {
    const testVm = vms[0];
    console.log(`Testing on ${testVm.name} first...\n`);
    const result = await cleanVM(testVm, privateKey);
    console.log(`  ${result.name}: ${result.status}`);
    console.log(`    Before: ${result.beforeCount} sessions (${result.beforeSize})`);
    console.log(`    After:  ${result.afterCount} sessions (${result.afterSize})`);
    console.log(`    Deleted: ${result.deletedCount} stale sessions`);
    console.log("\nTest complete. Run with --all to continue with remaining VMs.");
    return;
  }

  // Process in batches
  const allResults: CleanupResult[] = [];
  let totalDeleted = 0;
  let errorCount = 0;
  let unhealthyCount = 0;

  for (let i = 0; i < vms.length; i += BATCH_SIZE) {
    const batch = vms.slice(i, i + BATCH_SIZE);
    console.log(`Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(vms.length / BATCH_SIZE)} (${batch.length} VMs)...`);
    const results = await Promise.all(batch.map(vm => cleanVM(vm, privateKey)));

    for (const r of results) {
      allResults.push(r);
      if (r.deletedCount) totalDeleted += r.deletedCount;
      if (r.status.startsWith("ERROR")) errorCount++;
      if (r.status === "CLEANED_UNHEALTHY") unhealthyCount++;

      // Log non-trivial results
      if (r.status.startsWith("ERROR") || r.status === "CLEANED_UNHEALTHY") {
        console.log(`  ${r.name}: ${r.status}`);
      } else if ((r.deletedCount ?? 0) > 0) {
        console.log(`  ${r.name}: ${r.beforeCount} → ${r.afterCount} sessions (deleted ${r.deletedCount})`);
      }
    }
  }

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("SUMMARY:");
  console.log(`  VMs processed:      ${allResults.length}`);
  console.log(`  Total sessions deleted: ${totalDeleted}`);
  console.log(`  Errors:             ${errorCount}`);
  console.log(`  Unhealthy after:    ${unhealthyCount}`);

  if (DRY_RUN) {
    const totalBefore = allResults.reduce((s, r) => s + (r.beforeCount ?? 0), 0);
    const totalStale = allResults.reduce((s, r) => s + (r.staleCount ?? 0), 0);
    console.log(`  Total sessions across fleet: ${totalBefore}`);
    console.log(`  Total stale (>7d):           ${totalStale}`);

    // Show sessions.json index sizes — highlight bloated ones
    console.log("\nsessions.json INDEX SIZES:");
    const sorted = [...allResults].sort((a, b) => (b.indexSize ?? 0) - (a.indexSize ?? 0));
    for (const r of sorted) {
      const sizeKB = ((r.indexSize ?? 0) / 1024).toFixed(1);
      const flag = (r.indexSize ?? 0) > 5000 ? " *** BLOATED" : "";
      console.log(`  ${r.name.padEnd(25)} ${String(sizeKB + "KB").padStart(10)}  sessions: ${r.beforeCount}  stale: ${r.staleCount}${flag}`);
    }
    console.log("\nRun with --test-first or --all to execute cleanup.");
  }

  // Log any errors/unhealthy VMs
  const problems = allResults.filter(r => r.status.startsWith("ERROR") || r.status === "CLEANED_UNHEALTHY");
  if (problems.length > 0) {
    console.log("\nPROBLEM VMs:");
    for (const p of problems) {
      console.log(`  ${p.name}: ${p.status}`);
    }
  }
}

main().catch(console.error);
