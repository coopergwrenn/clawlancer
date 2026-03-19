/**
 * Fix Ape Capital (Jeremy) — Session bloat cleanup
 * VM-379, user 771e586b-112e-4882-aa39-02ac5435e2aa
 *
 * Root cause: Cron job outputs accumulated as .jsonl session files.
 * OpenClaw loads ALL sessions into context, filling the window with cron garbage
 * instead of actual conversation memory → bot "forgot" OnlyMolts project.
 *
 * This script:
 * 1. Reports before-state (session count, sizes)
 * 2. Keeps only the most recently active session
 * 3. Deletes stale cron sessions + rebuilds sessions.json
 * 4. Cleans browser cache, gateway logs, old media, archives
 * 5. Restarts gateway
 * 6. Reports after-state + checks for OnlyMolts in MEMORY.md
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { Client as SSH2Client } from "ssh2";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const JEREMY_USER_ID = "771e586b-112e-4882-aa39-02ac5435e2aa";
const XDG = 'export XDG_RUNTIME_DIR="/run/user/$(id -u)"';

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

async function main() {
  console.log("=== Fix Ape Capital (Jeremy) — Session Bloat Cleanup ===\n");

  // 1. Find Jeremy's VM
  const { data: vms, error } = await supabase
    .from("instaclaw_vms")
    .select("id, name, ip_address, ssh_port, ssh_user, status")
    .eq("assigned_to", JEREMY_USER_ID)
    .in("status", ["assigned"]);

  if (error) { console.error("Query error:", error.message); return; }
  if (!vms?.length) { console.error("No VM found for Jeremy"); return; }

  const vm = vms[0];
  console.log(`VM: ${vm.name} (${vm.ip_address}), status: ${vm.status}\n`);

  const privateKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");

  const conn = new SSH2Client();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SSH timeout")), 15000);
    conn.on("ready", () => { clearTimeout(timer); resolve(); });
    conn.on("error", (e) => { clearTimeout(timer); reject(e); });
    conn.connect({
      host: vm.ip_address,
      port: vm.ssh_port || 22,
      username: vm.ssh_user || "openclaw",
      privateKey,
      readyTimeout: 15000,
    });
  });

  console.log("Connected via SSH.\n");

  // 2. Before-state
  console.log("── BEFORE STATE ──");
  const sessionCount = await sshExec(conn, "ls ~/.openclaw/agents/main/sessions/*.jsonl 2>/dev/null | wc -l");
  const sessionSize = await sshExec(conn, "du -sh ~/.openclaw/agents/main/sessions/ 2>/dev/null || echo 'N/A'");
  const indexSize = await sshExec(conn, "wc -c ~/.openclaw/agents/main/sessions/sessions.json 2>/dev/null || echo 'N/A'");
  const totalOcSize = await sshExec(conn, "du -sh ~/.openclaw/ 2>/dev/null || echo 'N/A'");
  console.log(`  Session files:    ${sessionCount}`);
  console.log(`  Sessions dir:     ${sessionSize}`);
  console.log(`  sessions.json:    ${indexSize}`);
  console.log(`  Total ~/.openclaw: ${totalOcSize}`);
  console.log();

  // 3. Find active sessions (modified in last 24h — keep all of them to avoid killing live conversations)
  const recentSessions = await sshExec(conn, `
    cd ~/.openclaw/agents/main/sessions 2>/dev/null || exit 0
    find . -maxdepth 1 -name '*.jsonl' -mtime -1 -printf '%f\n' 2>/dev/null | sort
  `);
  const keepList = recentSessions ? recentSessions.split("\n").filter(Boolean) : [];
  console.log(`Sessions modified in last 24h (KEEPING): ${keepList.length}`);
  for (const k of keepList) console.log(`  ✓ ${k}`);

  // If nothing modified in 24h, at minimum keep the single most recent file
  if (keepList.length === 0) {
    const fallback = await sshExec(conn, `cd ~/.openclaw/agents/main/sessions 2>/dev/null && ls -t *.jsonl 2>/dev/null | head -1`);
    if (fallback) {
      keepList.push(fallback);
      console.log(`  (fallback — keeping most recent: ${fallback})`);
    }
  }

  // 4. Delete .jsonl files older than 24h (stale cron sessions)
  let deleteResult: string;
  if (keepList.length > 0) {
    // Build find command that excludes all kept files
    const excludes = keepList.map(f => `! -name '${f}'`).join(" ");
    deleteResult = await sshExec(conn, `cd ~/.openclaw/agents/main/sessions && BEFORE=$(find . -maxdepth 1 -name '*.jsonl' ${excludes} | wc -l) && find . -maxdepth 1 -name '*.jsonl' ${excludes} -delete 2>/dev/null; echo "deleted $BEFORE stale sessions"`);
  } else {
    deleteResult = "no sessions found, skipping delete";
  }
  console.log(`Delete stale sessions: ${deleteResult}`);

  // 5. Rebuild sessions.json
  const rebuildPython = `python3 -c "
import json, os, glob
sessions_dir = os.path.expanduser('~/.openclaw/agents/main/sessions')
existing = set(os.path.basename(f).replace('.jsonl','') for f in glob.glob(sessions_dir + '/*.jsonl'))
sj_path = sessions_dir + '/sessions.json'
try:
    with open(sj_path) as f: sj = json.load(f)
    sj = {k:v for k,v in sj.items() if v.get('sessionId') in existing}
except: sj = {}
with open(sj_path, 'w') as f: json.dump(sj, f, indent=2)
print(f'sessions.json rebuilt: {len(sj)} entries')
"`;
  const rebuildResult = await sshExec(conn, rebuildPython);
  console.log(`Rebuild sessions.json: ${rebuildResult}`);

  // 6. Clean browser cache
  const cacheResult = await sshExec(conn, "rm -rf ~/.config/chromium/Default/Cache ~/.config/chromium/Default/Code\\ Cache ~/.config/chromium/Default/GPUCache 2>/dev/null && echo 'cleaned' || echo 'no cache'");
  console.log(`Browser cache: ${cacheResult}`);

  // 7. Truncate gateway logs
  const logResult = await sshExec(conn, `find /tmp/openclaw -name '*.log' -size +1M -exec sh -c 'tail -1000 "$1" > "$1.tmp" && mv "$1.tmp" "$1"' _ {} \\; 2>/dev/null; echo "done"`, 15000);
  console.log(`Gateway logs: ${logResult}`);

  // 8. Clean old media
  const mediaResult = await sshExec(conn, "find ~/.openclaw/media -type f -mtime +14 -delete 2>/dev/null; echo 'done'");
  console.log(`Old media: ${mediaResult}`);

  // 9. Clean session archives
  const archiveResult = await sshExec(conn, "find ~/.openclaw/agents/main/sessions/archive -type f -mtime +7 -delete 2>/dev/null; echo 'done'");
  console.log(`Session archives: ${archiveResult}`);

  // 10. Restart gateway
  console.log("\nRestarting gateway...");
  const restartResult = await sshExec(conn, `${XDG} && systemctl --user restart openclaw-gateway 2>&1 && echo "restarted" || echo "restart failed"`, 30000);
  console.log(`Gateway restart: ${restartResult}`);

  // Wait for gateway to come up
  let healthy = false;
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const health = await sshExec(conn, 'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:18789/health 2>/dev/null || echo "000"');
    if (health === "200") {
      console.log(`Gateway healthy after ${(i + 1) * 5}s`);
      healthy = true;
      break;
    }
    console.log(`  Waiting... (${health})`);
  }
  if (!healthy) {
    console.error("WARNING: Gateway did not come back healthy within 30s!");
  }

  // 11. After-state
  console.log("\n── AFTER STATE ──");
  const afterCount = await sshExec(conn, "ls ~/.openclaw/agents/main/sessions/*.jsonl 2>/dev/null | wc -l");
  const afterSize = await sshExec(conn, "du -sh ~/.openclaw/agents/main/sessions/ 2>/dev/null || echo 'N/A'");
  const afterIndex = await sshExec(conn, "wc -c ~/.openclaw/agents/main/sessions/sessions.json 2>/dev/null || echo 'N/A'");
  const afterTotal = await sshExec(conn, "du -sh ~/.openclaw/ 2>/dev/null || echo 'N/A'");
  console.log(`  Session files:    ${afterCount}`);
  console.log(`  Sessions dir:     ${afterSize}`);
  console.log(`  sessions.json:    ${afterIndex}`);
  console.log(`  Total ~/.openclaw: ${afterTotal}`);

  // 12. Check MEMORY.md for OnlyMolts
  console.log("\n── MEMORY CHECK ──");
  const memCheck = await sshExec(conn, "grep -i 'onlymolts\\|only.molts' ~/.openclaw/workspace/MEMORY.md 2>/dev/null || echo 'NOT FOUND'");
  console.log(`OnlyMolts in MEMORY.md: ${memCheck}`);

  // 13. If not found, check workspace for project files
  if (memCheck === "NOT FOUND") {
    const workspaceCheck = await sshExec(conn, "find ~/.openclaw/workspace -name '*molts*' -o -name '*onlymolts*' 2>/dev/null || echo 'none'");
    console.log(`OnlyMolts workspace files: ${workspaceCheck || "none"}`);

    // Also check session archive for any context
    const archiveCheck = await sshExec(conn, "grep -ril 'onlymolts\\|only.molts' ~/.openclaw/agents/main/sessions/archive/ 2>/dev/null | head -3 || echo 'none'");
    console.log(`OnlyMolts in archives: ${archiveCheck}`);
  }

  conn.end();
  console.log("\n=== Done ===");
}

main().catch(console.error);
