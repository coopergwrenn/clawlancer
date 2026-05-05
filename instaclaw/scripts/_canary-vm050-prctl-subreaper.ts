/**
 * vm-050 canary install + smoke test for prctl-subreaper@0.1.0.
 *
 * What this DOES:
 *   1. Snapshot of vm-050 process state BEFORE (zombies, fork errors,
 *      gateway TasksCurrent, gateway main PID).
 *   2. `npm install -g prctl-subreaper@PINNED_VERSION` via NVM-sourced shell.
 *   3. Verify `prctl_subreaper.node` exists in $(npm root -g)/prctl-subreaper/build/Release/.
 *   4. Run a transient `node -e "..."` with NODE_PATH=$(npm root -g),
 *      assert require('prctl-subreaper').stats() returns
 *      {sup:true, running:true, pid: <some-pid>}.
 *   5. Snapshot AFTER (mostly to confirm gateway is still running and
 *      our transient process didn't leave anything weird).
 *
 * What this DOES NOT do (intentionally):
 *   - Write the systemd drop-in (Cooper's call to flip the gateway).
 *   - Restart openclaw-gateway.
 *   - Touch any other VM.
 *
 * Read-only against the gateway. Safe to run while vm-050 is serving traffic.
 */
import { readFileSync } from "fs";
import { Client } from "ssh2";
import { createClient } from "@supabase/supabase-js";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  const env = readFileSync(f, "utf-8");
  for (const l of env.split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const PINNED = "0.1.0";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SSH_KEY_B64 = process.env.SSH_PRIVATE_KEY_B64!;
if (!SSH_KEY_B64) { console.error("Missing SSH_PRIVATE_KEY_B64"); process.exit(1); }
const SSH_PRIVATE_KEY = Buffer.from(SSH_KEY_B64, "base64").toString("utf-8");
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

function sshExec(host: string, port: number, user: string, cmd: string, timeoutMs = 30_000): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const c = new Client();
    let stdout = "", stderr = "", code: number | null = null, finished = false;
    const finish = (e?: Error) => {
      if (finished) return;
      finished = true;
      try { c.end(); } catch {}
      if (e) reject(e); else resolve({ stdout, stderr, code });
    };
    const timer = setTimeout(() => finish(new Error(`ssh exec timeout after ${timeoutMs}ms`)), timeoutMs);
    c.on("ready", () => {
      c.exec(cmd, (err, stream) => {
        if (err) { clearTimeout(timer); return finish(err); }
        stream.on("data", (d: Buffer) => (stdout += d.toString()));
        stream.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
        stream.on("close", (exitCode: number) => { code = exitCode; clearTimeout(timer); finish(); });
      });
    });
    c.on("error", (e) => { clearTimeout(timer); finish(e); });
    c.connect({ host, port: port || 22, username: user || "openclaw", privateKey: SSH_PRIVATE_KEY, readyTimeout: 12_000, keepaliveInterval: 0 });
  });
}

const NVM = `source $HOME/.nvm/nvm.sh 2>/dev/null || source /usr/local/nvm/nvm.sh 2>/dev/null || true`;

const SNAPSHOT = `set +e
GW_PID=$(systemctl --user show -p MainPID --value openclaw-gateway 2>/dev/null)
TASKS_CUR=$(systemctl --user show -p TasksCurrent --value openclaw-gateway 2>/dev/null)
TASKS_MAX=$(systemctl --user show -p TasksMax --value openclaw-gateway 2>/dev/null)
ZCOUNT=$(ps axo stat 2>/dev/null | grep -c '^Z')
FORK24H=$(timeout 12 journalctl --user --since '24 hours ago' --no-pager 2>/dev/null | grep -ciE 'fork|EAGAIN|cannot allocate|resource temporarily')
HEALTH=$(curl -sf -m 4 http://localhost:18789/health 2>&1 | head -c 80)
echo "GW_PID=$GW_PID"
echo "TASKS_CUR=$TASKS_CUR"
echo "TASKS_MAX=$TASKS_MAX"
echo "ZCOUNT=$ZCOUNT"
echo "FORK24H=$FORK24H"
echo "HEALTH=$HEALTH"
echo "ZOMBIES_BEGIN"
ps axo pid,ppid,stat,etime,comm 2>/dev/null | awk '$3 ~ /Z/ {print}'
echo "ZOMBIES_END"
`;

function fmtKv(stdout: string, key: string): string {
  const m = stdout.match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].trim() : "<unset>";
}

(async () => {
  // 1. Look up vm-050.
  const { data: vm, error } = await sb.from("instaclaw_vms")
    .select("id,name,ip_address,ssh_port,ssh_user,partner,assigned_to,health_status,status")
    .eq("name", "instaclaw-vm-050")
    .single();
  if (error || !vm) { console.error("vm-050 lookup failed:", error); process.exit(1); }
  console.log(`Target: ${vm.name} @ ${vm.ip_address} (status=${vm.status} health=${vm.health_status})`);

  const host = vm.ip_address as string;
  const port = (vm.ssh_port as number) || 22;
  const user = (vm.ssh_user as string) || "openclaw";

  // 2. Pre-install snapshot.
  console.log("\n══ BEFORE SNAPSHOT ══");
  const before = await sshExec(host, port, user, SNAPSHOT, 30_000);
  if (before.code !== 0) {
    console.warn(`(snapshot returned exit ${before.code}; continuing)`);
  }
  for (const k of ["GW_PID", "TASKS_CUR", "TASKS_MAX", "ZCOUNT", "FORK24H", "HEALTH"]) {
    console.log(`  ${k.padEnd(10)} = ${fmtKv(before.stdout, k)}`);
  }
  const beforeZombieBlock = before.stdout.match(/ZOMBIES_BEGIN\n([\s\S]*?)\nZOMBIES_END/);
  if (beforeZombieBlock && beforeZombieBlock[1].trim()) {
    console.log("  zombies:");
    for (const line of beforeZombieBlock[1].trim().split("\n")) console.log(`    ${line}`);
  } else {
    console.log("  zombies:    (none)");
  }

  // 3. npm install -g prctl-subreaper@PINNED.
  console.log(`\n══ INSTALL prctl-subreaper@${PINNED} ══`);
  const install = await sshExec(
    host, port, user,
    `${NVM} && npm install -g prctl-subreaper@${PINNED} 2>&1`,
    240_000,
  );
  console.log(`  exit code: ${install.code}`);
  // npm prints noisy WARN/notice lines; show last few signal lines
  const installTail = install.stdout.trim().split("\n").slice(-8).join("\n");
  console.log("  install tail:");
  for (const line of installTail.split("\n")) console.log(`    ${line}`);
  if (install.code !== 0) {
    console.error("\n✗ npm install failed. Aborting canary.");
    process.exit(2);
  }

  // 4. Resolve global npm root + verify the native addon binary.
  console.log("\n══ VERIFY NATIVE ADDON COMPILED ══");
  const verify = await sshExec(
    host, port, user,
    `${NVM} && NPM_ROOT=$(npm root -g) && echo "NPM_ROOT=$NPM_ROOT" && find "$NPM_ROOT/prctl-subreaper/build/Release" -name '*.node' -type f 2>/dev/null | head -1 | sed 's/^/NODE_BINARY=/' && (cd "$NPM_ROOT/prctl-subreaper" && npm ls 2>&1 | head -3 | sed 's/^/PKG_TREE: /')`,
    20_000,
  );
  console.log(verify.stdout.split("\n").map(l => "  " + l).join("\n"));
  const npmRoot = fmtKv(verify.stdout, "NPM_ROOT");
  const nodeBinary = fmtKv(verify.stdout, "NODE_BINARY");
  if (!nodeBinary || nodeBinary === "<unset>") {
    console.error("\n✗ Native addon (.node binary) NOT FOUND after install. Likely cause: build-essential or python3 missing on the VM.");
    process.exit(3);
  }

  // 5. Smoke test.
  console.log("\n══ SMOKE TEST: require('prctl-subreaper').stats() ══");
  const smoke = await sshExec(
    host, port, user,
    `${NVM} && NODE_PATH='${npmRoot}' PRCTL_SUBREAPER_SILENT=1 node -e 'const s=require("prctl-subreaper"); const st=s.stats(); console.log(JSON.stringify({sup:s.isSupported(),running:st.running,pid:st.pid,interval:st.intervalMs,minAge:st.minAgeMs,reaped:String(st.reapedCount)}))' 2>&1`,
    20_000,
  );
  console.log(`  exit code: ${smoke.code}`);
  console.log("  output:    " + smoke.stdout.trim());
  let smokeOk = false;
  let smokeJson: any = null;
  try {
    const lines = smoke.stdout.trim().split("\n").filter(l => l.startsWith("{"));
    if (lines.length) smokeJson = JSON.parse(lines[lines.length - 1]);
    if (smokeJson && smokeJson.sup === true && smokeJson.running === true && typeof smokeJson.pid === "number") {
      smokeOk = true;
    }
  } catch (e) {
    console.error("  (could not parse JSON from smoke test output)");
  }
  if (!smokeOk) {
    console.error("\n✗ Smoke test FAILED. require('prctl-subreaper').stats() did not return {sup:true, running:true, pid:<n>}.");
    console.error("  Aborting before snapshot. Package is installed but appears non-functional.");
    process.exit(4);
  }

  // 6. Sanity: hold the smoke-test process alive long enough to confirm the
  //    reaper thread doesn't die immediately. Re-check stats after ~6s
  //    (one polling cycle + some headroom). Note this spawns a separate
  //    transient node — we're NOT keeping the original alive.
  console.log("\n══ STABILITY CHECK: spawn-then-recheck ══");
  const stab = await sshExec(
    host, port, user,
    `${NVM} && NODE_PATH='${npmRoot}' PRCTL_SUBREAPER_SILENT=1 node -e 'const s=require("prctl-subreaper"); setTimeout(() => { const st=s.stats(); console.log(JSON.stringify({running_after_6s:st.running, reaped:String(st.reapedCount)})); process.exit(0); }, 6000);' 2>&1`,
    20_000,
  );
  console.log(`  exit code: ${stab.code}`);
  console.log("  output:    " + stab.stdout.trim());

  // 7. After-snapshot.
  console.log("\n══ AFTER SNAPSHOT ══");
  const after = await sshExec(host, port, user, SNAPSHOT, 30_000);
  for (const k of ["GW_PID", "TASKS_CUR", "TASKS_MAX", "ZCOUNT", "FORK24H", "HEALTH"]) {
    console.log(`  ${k.padEnd(10)} = ${fmtKv(after.stdout, k)}`);
  }
  const afterZombieBlock = after.stdout.match(/ZOMBIES_BEGIN\n([\s\S]*?)\nZOMBIES_END/);
  if (afterZombieBlock && afterZombieBlock[1].trim()) {
    console.log("  zombies:");
    for (const line of afterZombieBlock[1].trim().split("\n")) console.log(`    ${line}`);
  } else {
    console.log("  zombies:    (none)");
  }

  // 8. Summary.
  console.log("\n══════════════════════════════════════════════════════════════════");
  console.log("                      vm-050 CANARY SUMMARY                      ");
  console.log("══════════════════════════════════════════════════════════════════");
  console.log(`  package:        prctl-subreaper@${PINNED}`);
  console.log(`  npm root:       ${npmRoot}`);
  console.log(`  native binary:  ${nodeBinary}`);
  console.log(`  smoke test:     ${smokeOk ? "PASSED ✓ (sup=true running=true)" : "FAILED ✗"}`);
  console.log(`  gateway PID:    ${fmtKv(before.stdout, "GW_PID")} → ${fmtKv(after.stdout, "GW_PID")}  (no restart triggered by canary)`);
  console.log(`  gateway tasks:  ${fmtKv(before.stdout, "TASKS_CUR")} → ${fmtKv(after.stdout, "TASKS_CUR")}  / ${fmtKv(after.stdout, "TASKS_MAX")}`);
  console.log(`  fork errors:    ${fmtKv(before.stdout, "FORK24H")} (24h baseline; gateway not yet using addon)`);
  console.log(`  zombies:        ${fmtKv(before.stdout, "ZCOUNT")} → ${fmtKv(after.stdout, "ZCOUNT")} (transient)`);
  console.log(`  health:         ${fmtKv(after.stdout, "HEALTH")}`);
  console.log("");
  console.log("Next steps (Cooper's call):");
  console.log("  (a) Verify the install survives a manual gateway restart. SSH:");
  console.log(`      ssh ${user}@${host}`);
  console.log(`      mkdir -p ~/.config/systemd/user/openclaw-gateway.service.d`);
  console.log(`      cat > ~/.config/systemd/user/openclaw-gateway.service.d/prctl-subreaper.conf <<'EOF'`);
  console.log(`      [Service]`);
  console.log(`      Environment="NODE_PATH=${npmRoot}"`);
  console.log(`      Environment="NODE_OPTIONS=--require prctl-subreaper"`);
  console.log(`      Environment="PRCTL_SUBREAPER_INTERVAL_MS=1000"`);
  console.log(`      Environment="PRCTL_SUBREAPER_MIN_AGE_MS=5000"`);
  console.log(`      EOF`);
  console.log(`      export XDG_RUNTIME_DIR="/run/user/$(id -u)" && systemctl --user daemon-reload && systemctl --user restart openclaw-gateway`);
  console.log(`      # then watch journalctl --user -u openclaw-gateway -f for ~30s`);
  console.log(`      curl -sf http://localhost:18789/health  # expect 200`);
  console.log("  (b) Hold 24h. Watch for fork errors / SIGTERM events.");
  console.log("  (c) Run instaclaw/scripts/_audit-fleet-zombie-classification.ts");
  console.log("      to verify reapedCount > 0 on vm-050 if any zombies surface.");
  console.log("  (d) After 24h soak: merge fleet/v87-prctl-subreaper to main.");
  console.log("");
  console.log("Rollback if anything regresses:");
  console.log(`      rm ~/.config/systemd/user/openclaw-gateway.service.d/prctl-subreaper.conf`);
  console.log(`      systemctl --user daemon-reload && systemctl --user restart openclaw-gateway`);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
