/**
 * Deep triage of 3 representative paying-stuck VMs (cv<84, 33-87 days
 * since last reconcile, Stripe-verified paying). Goal: identify WHICH
 * reconciler step is failing — same on all 3 → fix at source; different
 * across all 3 → systemic detection needed (more impactful than any
 * single bug fix).
 *
 * For each VM: time SSH connect, run a sequence of probes that mirror
 * what the reconciler does. Note where each probe times out or errors.
 */
import { readFileSync } from "fs";
import { Client } from "ssh2";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  for (const l of readFileSync(f, "utf-8").split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) {
      process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}
const KEY = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");

const TARGETS = [
  { name: "instaclaw-vm-linode-05", ip: "172.104.15.84", tier: "starter", stuckDays: 86.8 },
  { name: "instaclaw-vm-657", ip: "69.164.213.209", tier: "pro", stuckDays: 36.1 },
  { name: "instaclaw-vm-733", ip: "172.104.15.146", tier: "power", stuckDays: 33.0 },
];

interface Probe {
  label: string;
  cmd: string;
  timeoutMs?: number;
}

const PROBES: Probe[] = [
  // === SYSTEM HEALTH ===
  { label: "uptime", cmd: "uptime" },
  { label: "disk", cmd: "df -h / | tail -1" },
  { label: "mem", cmd: "free -m | grep '^Mem:'" },
  { label: "load", cmd: "cat /proc/loadavg" },

  // === GATEWAY ===
  { label: "gw-active", cmd: "export XDG_RUNTIME_DIR=/run/user/$(id -u) && systemctl --user is-active openclaw-gateway 2>/dev/null" },
  { label: "gw-substate", cmd: "export XDG_RUNTIME_DIR=/run/user/$(id -u) && systemctl --user show openclaw-gateway -p SubState --value 2>/dev/null" },
  { label: "gw-restarts", cmd: "export XDG_RUNTIME_DIR=/run/user/$(id -u) && systemctl --user show openclaw-gateway -p NRestarts --value 2>/dev/null" },
  { label: "gw-health", cmd: "curl -s -m 5 -o /dev/null -w '%{http_code}' http://localhost:18789/health 2>/dev/null || echo 000" },

  // === RECONCILER FOOTPRINT (mtimes — when did reconciler last successfully write each?) ===
  { label: "mtime-openclaw-json", cmd: "stat -c '%y' ~/.openclaw/openclaw.json 2>/dev/null | cut -d. -f1" },
  { label: "mtime-soul-md", cmd: "stat -c '%y' ~/.openclaw/workspace/SOUL.md 2>/dev/null | cut -d. -f1" },
  { label: "mtime-strip-thinking", cmd: "stat -c '%y' ~/.openclaw/scripts/strip-thinking.py 2>/dev/null | cut -d. -f1" },
  { label: "mtime-override-conf", cmd: "stat -c '%y' ~/.config/systemd/user/openclaw-gateway.service.d/override.conf 2>/dev/null | cut -d. -f1 || echo MISSING" },
  { label: "mtime-prctl-dropin", cmd: "stat -c '%y' ~/.config/systemd/user/openclaw-gateway.service.d/prctl-subreaper.conf 2>/dev/null | cut -d. -f1 || echo MISSING" },

  // === MANIFEST-EXPECTED STATE (6-point check + extensions) ===
  { label: "tasks-max", cmd: "export XDG_RUNTIME_DIR=/run/user/$(id -u) && systemctl --user show openclaw-gateway -p TasksMax --value 2>/dev/null" },
  { label: "gcc", cmd: "command -v gcc 2>/dev/null && echo PRESENT || echo MISSING" },
  { label: "prctl-pkg", cmd: "source ~/.nvm/nvm.sh 2>/dev/null; npm ls -g --depth=0 prctl-subreaper 2>/dev/null | grep -oE 'prctl-subreaper@[0-9]+\\.[0-9]+\\.[0-9]+' | head -1 || echo MISSING" },
  { label: "openclaw-version", cmd: "source ~/.nvm/nvm.sh 2>/dev/null; openclaw --version 2>/dev/null | head -1 || echo MISSING" },
  { label: "node-version", cmd: "source ~/.nvm/nvm.sh 2>/dev/null; node --version 2>/dev/null" },
  { label: "bootstrap-max-chars", cmd: "grep -oE 'bootstrapMaxChars\": *[0-9]+' ~/.openclaw/openclaw.json 2>/dev/null | grep -oE '[0-9]+' | head -1 || echo MISSING" },
  { label: "compaction-mode", cmd: "grep -oE '\"mode\": *\"[^\"]+\"' ~/.openclaw/openclaw.json 2>/dev/null | head -1 || echo MISSING" },

  // === RECONCILE STEP BOTTLENECK PROBES ===
  // The classic slow steps: npm install (stepNpmPinDrift, stepPrctlSubreaper)
  // Test that the FOUNDATIONAL ops the reconciler depends on actually work
  { label: "nvm-current", cmd: "source ~/.nvm/nvm.sh 2>/dev/null && nvm current 2>/dev/null || echo BROKEN", timeoutMs: 8000 },
  { label: "npm-root-g", cmd: "source ~/.nvm/nvm.sh 2>/dev/null && npm root -g 2>/dev/null || echo BROKEN", timeoutMs: 8000 },
  { label: "openclaw-config-get-test", cmd: "source ~/.nvm/nvm.sh 2>/dev/null; openclaw config get agents.defaults.heartbeat.every 2>&1 | head -1", timeoutMs: 10000 },
  { label: "openclaw-config-set-noop", cmd: "source ~/.nvm/nvm.sh 2>/dev/null; openclaw config set agents.defaults.heartbeat.every 3h 2>&1 | head -1", timeoutMs: 10000 },

  // === JOURNAL — recent gateway errors (last 7 days) ===
  { label: "journal-errors-7d", cmd: "export XDG_RUNTIME_DIR=/run/user/$(id -u) && journalctl --user -u openclaw-gateway --since '7 days ago' --no-pager 2>/dev/null | grep -iE '(error|fail|timeout|killed|sigterm|exit code)' | tail -8" },

  // === RECENT RECONCILE ATTEMPT EVIDENCE ===
  // Look for telltale signs the reconciler tried + failed
  { label: "log-strip-thinking-recent", cmd: "ls -la ~/.openclaw/logs/strip-thinking.log 2>/dev/null | head -1 || echo NO_LOG" },
  { label: "openclaw-json-size", cmd: "stat -c %s ~/.openclaw/openclaw.json 2>/dev/null" },
  { label: "soul-md-size", cmd: "stat -c %s ~/.openclaw/workspace/SOUL.md 2>/dev/null" },
];

function exec(host: string, cmd: string, timeoutMs: number): Promise<{ out: string; durationMs: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const c = new Client();
    let o = "";
    const start = Date.now();
    let timedOut = false;
    const tt = setTimeout(() => {
      timedOut = true;
      try { c.end(); } catch { /* noop */ }
      resolve({ out: "[TIMEOUT]", durationMs: Date.now() - start, timedOut: true });
    }, timeoutMs);
    c.on("ready", () => c.exec(cmd, (e, s) => {
      if (e) { clearTimeout(tt); c.end(); return resolve({ out: "err: " + e.message, durationMs: Date.now() - start, timedOut: false }); }
      s.on("data", (d: Buffer) => { o += d.toString(); });
      s.stderr.on("data", (d: Buffer) => { o += d.toString(); });
      s.on("close", () => { clearTimeout(tt); c.end(); resolve({ out: o, durationMs: Date.now() - start, timedOut }); });
    }));
    c.on("error", (e) => { clearTimeout(tt); resolve({ out: "cerr: " + e.message, durationMs: Date.now() - start, timedOut: false }); });
    c.connect({ host, port: 22, username: "openclaw", privateKey: KEY, readyTimeout: 8000 });
  });
}

async function probeVM(target: typeof TARGETS[number]) {
  console.log(`\n========================================`);
  console.log(`VM: ${target.name} (${target.ip})  tier=${target.tier}  stuckDays=${target.stuckDays}`);
  console.log(`========================================`);

  // First: time the SSH connect itself with a no-op probe.
  const sshT0 = Date.now();
  const echoTest = await exec(target.ip, "echo PING", 12000);
  const sshSetup = Date.now() - sshT0;
  console.log(`  ssh-connect+echo: ${sshSetup}ms  output=${echoTest.out.trim()}  timedOut=${echoTest.timedOut}`);
  if (echoTest.timedOut) {
    console.log(`  >>> SSH UNREACHABLE/SLOW — likely the reason reconciler fails. Skipping further probes.`);
    return;
  }

  for (const p of PROBES) {
    const r = await exec(target.ip, p.cmd, p.timeoutMs ?? 12000);
    const out = (r.out || "").trim().slice(0, 200).replace(/\n/g, " | ");
    const flag = r.timedOut ? " ⚠ TIMEOUT" : r.durationMs > 3000 ? ` ⚠ SLOW(${r.durationMs}ms)` : "";
    console.log(`  [${p.label.padEnd(28)}] ${r.durationMs.toString().padStart(5)}ms  ${out}${flag}`);
  }
}

async function main() {
  console.log(`\n=== DEEP TRIAGE: 3 paying-stuck VMs ===`);
  for (const t of TARGETS) {
    await probeVM(t);
  }
}

main().then(() => process.exit(0));
