/**
 * P0 surgical recovery for vm-725 (Doug Rathell, afd359@gmail.com).
 *
 * Two fixes:
 *   1. Re-deploy the trim-not-nuke strip-thinking.py — mass-reconcile-v79 has
 *      a stale Node module cache (started before commit a495680d at 18:48 UTC)
 *      and overwrote my fleet hotfix back to the old session-nuking version
 *      when it processed vm-725 at 20:34 UTC.  vm-725 is already at
 *      config_version=79 in the DB so the reconciler is done with it and my
 *      re-deploy is safe — it won't get clobbered again on this VM.
 *   2. Raise `agents.defaults.timeoutSeconds: 90 → 300`.  OpenClaw 2026.4.26
 *      tightened model deadlines and Doug's first-turn cascade hits a 90s
 *      sonnet timeout on every prompt before falling back to haiku.  CLAUDE.md
 *      Upgrade Playbook explicitly calls out this failure mode.  300s matches
 *      Vercel-side maxDuration and the playbook canary spec (<30s under
 *      working conditions, but pad for the slow tail).
 *
 * Smoke after both fixes: /health probe + tail of recent telegram messages
 * to confirm Doug is actually getting non-error responses.
 *
 * Does NOT trim SOUL.md (separate fleet-wide concern).
 * Does NOT roll back OpenClaw (Cooper's decision).
 */
import { readFileSync } from "fs";
import { NodeSSH } from "node-ssh";
import { STRIP_THINKING_SCRIPT } from "../lib/ssh";

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

const TARGET = "45.33.74.65";
const sshKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");

async function main(): Promise<void> {
  if (!STRIP_THINKING_SCRIPT.includes("def trim_failed_turns") ||
      !STRIP_THINKING_SCRIPT.includes("SESSION TRIMMED:")) {
    throw new Error("Local STRIP_THINKING_SCRIPT missing the hotfix sentinels — abort.");
  }
  console.log(`[hotfix] script size: ${STRIP_THINKING_SCRIPT.length} chars (sentinels OK)`);

  const ssh = new NodeSSH();
  console.log(`[ssh] connecting to ${TARGET}…`);
  await ssh.connect({ host: TARGET, username: "openclaw", privateKey: sshKey, readyTimeout: 15_000 });

  // ── Phase 1: re-deploy strip-thinking.py with hotfix ──
  console.log("\n── 1. Re-deploy strip-thinking.py (was clobbered by mass-reconcile) ──");

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const remotePath = `/home/openclaw/.openclaw/scripts/strip-thinking.py`;
  const tmpLocal = `/tmp/strip-thinking-recover-${ts}.py`;
  require("fs").writeFileSync(tmpLocal, STRIP_THINKING_SCRIPT, "utf-8");
  await ssh.putFile(tmpLocal, `${remotePath}.tmp`);
  require("fs").unlinkSync(tmpLocal);

  const installRes = await ssh.execCommand(`
set -eu
[ -f ${remotePath} ] && cp -p ${remotePath} ${remotePath}.bak-${ts} || true
python3 -m py_compile ${remotePath}.tmp
grep -q 'def trim_failed_turns' ${remotePath}.tmp
grep -q 'SESSION TRIMMED:' ${remotePath}.tmp
chmod +x ${remotePath}.tmp
mv ${remotePath}.tmp ${remotePath}
echo "INSTALL_OK lines=$(wc -l < ${remotePath}) sentinels=$(grep -c 'def trim_failed_turns\\|SESSION TRIMMED:' ${remotePath})"
`);
  console.log(`  ${installRes.stdout.trim()}`);
  if (installRes.code !== 0) {
    console.error(`  STDERR: ${installRes.stderr.trim()}`);
    throw new Error("Install failed");
  }

  // ── Phase 2: raise timeoutSeconds to 300 ──
  console.log("\n── 2. Raise agents.defaults.timeoutSeconds: 90 → 300 ──");
  const cfgRes = await ssh.execCommand(`
source ~/.nvm/nvm.sh 2>/dev/null
which openclaw || echo "openclaw NOT FOUND"
openclaw config get agents.defaults.timeoutSeconds 2>&1 || true
openclaw config set agents.defaults.timeoutSeconds '"300"' 2>&1
openclaw config get agents.defaults.timeoutSeconds 2>&1
`);
  console.log(`  ${cfgRes.stdout.trim()}`);
  if (cfgRes.stderr) console.log(`  stderr: ${cfgRes.stderr.trim()}`);

  // ── Phase 3: gentle gateway restart (config reload) ──
  console.log("\n── 3. Restart gateway to pick up new timeout ──");
  const restartRes = await ssh.execCommand(`
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
systemctl --user restart openclaw-gateway 2>&1
sleep 5
for i in 1 2 3 4 5 6; do
  if curl -sS --max-time 3 -o /dev/null -w "" http://localhost:18789/health; then
    echo "gateway healthy after \${i}0s"
    exit 0
  fi
  sleep 10
done
echo "gateway still not healthy after 60s"
exit 1
`);
  console.log(`  ${restartRes.stdout.trim()}`);
  if (restartRes.code !== 0) {
    console.error(`  ⚠️  Gateway didn't come back cleanly: ${restartRes.stderr.trim()}`);
    // Don't throw — we want the smoke probe to give us full picture
  }

  // ── Phase 4: smoke probe ──
  console.log("\n── 4. Smoke: gateway state + recent telegram activity ──");
  const smokeCmds = [
    { label: "is-active",        cmd: `systemctl --user is-active openclaw-gateway` },
    { label: "gateway version",  cmd: `journalctl --user -u openclaw-gateway --since '2 min ago' --no-pager 2>&1 | grep -E "OpenClaw Gateway \\(v" | tail -1` },
    { label: "/health (local)",  cmd: `curl -sS --max-time 5 -o /dev/null -w "HTTP %{http_code} time=%{time_total}s\\n" http://localhost:18789/health` },
    { label: "config: timeoutSeconds applied", cmd: `python3 -c "import json; c=json.load(open('$HOME/.openclaw/openclaw.json')); print('timeoutSeconds=', c.get('agents',{}).get('defaults',{}).get('timeoutSeconds'))"` },
    { label: "strip-thinking.py has hotfix",   cmd: `wc -l $HOME/.openclaw/scripts/strip-thinking.py; grep -c 'def trim_failed_turns\\|SESSION TRIMMED:' $HOME/.openclaw/scripts/strip-thinking.py` },
    { label: "last 5 telegram-related events", cmd: `journalctl --user -u openclaw-gateway --since '15 min ago' --no-pager 2>&1 | grep -iE "telegram|something went wrong|sendMessage" | tail -10` },
    { label: "any embedded-run failures since 1 min ago", cmd: `journalctl --user -u openclaw-gateway --since '1 min ago' --no-pager 2>&1 | grep -iE "agent/embedded|FailoverError|incomplete|empty response" | tail -10` },
  ];
  for (const c of smokeCmds) {
    const r = await ssh.execCommand(c.cmd, { execOptions: { pty: false } });
    console.log(`\n  [${c.label}]`);
    if (r.stdout) console.log(`    ${r.stdout.trim().split("\n").slice(0, 8).join("\n    ")}`);
    if (r.stderr && r.stderr.trim()) console.log(`    stderr: ${r.stderr.trim().slice(0, 200)}`);
  }

  ssh.dispose();
  console.log(`\n${"=".repeat(60)}\nRecovery applied to vm-725. Gateway healthy, hotfix re-installed,\ntimeoutSeconds=300. Send a real Telegram to @Rafters5_bot to confirm.\n${"=".repeat(60)}`);
}

main().catch((e) => {
  console.error(`\nFATAL: ${(e as Error).message}`);
  process.exit(1);
});
