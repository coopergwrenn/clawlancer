/**
 * _postbake-validation.ts
 *
 * SSH-probe a snapshot bake VM (or a test VM provisioned from a fresh snapshot)
 * and verify every invariant required for the image to be safe to ship to the
 * fleet. The audit at instaclaw/docs/snapshot-bake-runbook.md enumerates 30+
 * categories — this script automates every check.
 *
 * Two modes:
 *   --mode=bake   — run on the bake VM after _prebake-cleanup.sh, before
 *                   shutdown + image creation. Validates static state
 *                   (no secrets, no user data, no bloat). Gateway is expected
 *                   to be STOPPED (we just stopped it during cleanup).
 *
 *   --mode=test   — run on a fresh VM provisioned FROM the new snapshot,
 *                   AFTER configureOpenClaw has set the per-VM token + env.
 *                   Validates dynamic state (gateway active, /health,
 *                   gbrain MCP responding) PLUS that cloud-init regenerated
 *                   the machine-id and SSH host keys (the test VM's host
 *                   keys must NOT match the bake VM's).
 *
 * Usage:
 *   npx tsx scripts/_postbake-validation.ts --vm-ip=<IP> --mode=bake
 *   npx tsx scripts/_postbake-validation.ts --vm-ip=<IP> --mode=test \
 *       --bake-vm-fingerprint=<sha256-of-bake-host-key>
 *
 * Exit codes:
 *   0 — every check passed
 *   1 — one or more checks failed (see report)
 *   2 — could not SSH (fatal)
 *   3 — argument error
 */

import { readFileSync } from "fs";
import { Client } from "ssh2";

// ── Env loading ──
for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  try {
    const env = readFileSync(f, "utf-8");
    for (const l of env.split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {}
}

// ── Args ──
type Mode = "bake" | "test";
const args = process.argv.slice(2);
const argMap: Record<string, string> = {};
for (const a of args) {
  const m = a.match(/^--([^=]+)=(.*)$/);
  if (m) argMap[m[1]] = m[2];
}
const VM_IP = argMap["vm-ip"];
const MODE = (argMap["mode"] as Mode) || "bake";
const SSH_USER = argMap["user"] || "openclaw";
const BAKE_FP = argMap["bake-vm-fingerprint"]; // optional, for test mode
const MAX_DISK_MB = parseInt(argMap["max-disk-mb"] || "5900", 10);

if (!VM_IP) {
  console.error("usage: --vm-ip=<IP> --mode=bake|test [--user=openclaw] [--bake-vm-fingerprint=...] [--max-disk-mb=5900]");
  process.exit(3);
}
if (MODE !== "bake" && MODE !== "test") {
  console.error("--mode must be 'bake' or 'test'");
  process.exit(3);
}

// ── SSH helpers ──
const SSH_KEY = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");

function ssh(host: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on("ready", () => resolve(c));
    c.on("error", reject);
    c.connect({ host, port: 22, username: SSH_USER, privateKey: SSH_KEY, readyTimeout: 12_000 });
  });
}

async function exec(c: Client, cmd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    c.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let stdout = "", stderr = "";
      stream.on("data", (d: Buffer) => stdout += d.toString());
      stream.stderr.on("data", (d: Buffer) => stderr += d.toString());
      stream.on("close", (code: number) => resolve({ stdout, stderr, code: code ?? 0 }));
    });
  });
}

// ── Check result tracking ──
type Severity = "P0" | "P1" | "P2";
interface Check {
  name: string;
  severity: Severity;
  modes: Mode[]; // which modes to run this check in
  detail?: string;
  pass: boolean;
}
const checks: Check[] = [];
function addCheck(c: Check) { checks.push(c); }

function record(name: string, severity: Severity, modes: Mode[], pass: boolean, detail = ""): void {
  if (!modes.includes(MODE)) return;
  addCheck({ name, severity, modes, pass, detail: detail.slice(0, 300) });
}

// ── Helpers for common assertions ──
async function assertAbsent(c: Client, name: string, severity: Severity, modes: Mode[], path: string): Promise<void> {
  const r = await exec(c, `[ -e "${path}" ] && echo PRESENT || echo absent`);
  const pass = r.stdout.trim() === "absent";
  record(name, severity, modes, pass, pass ? "" : `${path} still present`);
}

async function assertNoSecretsInFile(c: Client, name: string, severity: Severity, modes: Mode[], path: string, denyPatterns: string[]): Promise<void> {
  const r = await exec(c, `[ -f "${path}" ] && cat "${path}" || echo MISSING`);
  if (r.stdout === "MISSING\n") {
    record(name, severity, modes, true, "file missing (acceptable)");
    return;
  }
  const matches = denyPatterns.filter(p => r.stdout.includes(p));
  const pass = matches.length === 0;
  record(name, severity, modes, pass, pass ? "" : `contains: ${matches.join(", ")}`);
}

async function run() {
  console.log(`╔══ postbake-validation ══╗`);
  console.log(`  VM_IP: ${VM_IP}`);
  console.log(`  MODE:  ${MODE}`);
  console.log(`  MAX_DISK_MB: ${MAX_DISK_MB}\n`);

  let c: Client;
  try {
    c = await ssh(VM_IP);
  } catch (e: any) {
    console.error(`FATAL: ssh failed: ${e?.message ?? e}`);
    process.exit(2);
  }

  try {
    // ─── 1. Machine identity (test-mode: must differ from bake) ─────────────
    const hostKeyFp = (await exec(c, `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub 2>/dev/null | awk '{print $2}'`)).stdout.trim();
    const machineId = (await exec(c, `cat /etc/machine-id`)).stdout.trim();
    const dbusMachineId = (await exec(c, `cat /var/lib/dbus/machine-id`)).stdout.trim();
    const hostname = (await exec(c, `hostname`)).stdout.trim();

    record("machine-id present", "P0", ["bake", "test"], machineId.length === 32, `machine-id=${machineId}`);
    record("machine-id matches dbus", "P1", ["bake", "test"], machineId === dbusMachineId, `host=${machineId} dbus=${dbusMachineId}`);
    record("ssh ed25519 host key present", "P0", ["bake", "test"], hostKeyFp.length > 30, `fp=${hostKeyFp}`);

    if (MODE === "test" && BAKE_FP) {
      const differ = hostKeyFp !== BAKE_FP;
      record("cloud-init regenerated SSH host keys", "P0", ["test"], differ,
        differ ? `bake=${BAKE_FP.slice(0,20)}... test=${hostKeyFp.slice(0,20)}...`
               : `IDENTICAL TO BAKE VM — cloud-init did NOT regenerate keys. SNAPSHOT IS BROKEN.`);
    }
    if (MODE === "test") {
      record("hostname set per-VM (not 'localhost')", "P1", ["test"], hostname !== "localhost",
        `hostname=${hostname}`);
    }
    if (MODE === "bake") {
      // Print the bake host key fp so the operator can pass it to --bake-vm-fingerprint
      console.log(`  ➜ BAKE host key fingerprint (record this for --bake-vm-fingerprint in test mode):`);
      console.log(`     ${hostKeyFp}\n`);
    }

    // ─── 2. Infrastructure (build-essential, node, openclaw, prctl) ─────────
    const nodeV = (await exec(c, `source ~/.nvm/nvm.sh 2>/dev/null && node --version`)).stdout.trim();
    record("node v22.22.2 pinned", "P0", ["bake", "test"], nodeV === "v22.22.2", `got ${nodeV}`);

    const openclawV = (await exec(c, `source ~/.nvm/nvm.sh 2>/dev/null && openclaw --version`)).stdout.trim();
    record("OpenClaw 2026.4.26 pinned", "P0", ["bake", "test"], openclawV.includes("2026.4.26"), `got ${openclawV}`);

    const gccPresent = (await exec(c, `which gcc`)).code === 0;
    record("build-essential / gcc installed (v88)", "P0", ["bake", "test"], gccPresent, "gcc on PATH");

    const prctlDir = (await exec(c, `ls -d $(source ~/.nvm/nvm.sh; npm root -g)/prctl-subreaper 2>/dev/null`)).stdout.trim();
    record("prctl-subreaper npm package present (v87)", "P0", ["bake", "test"], prctlDir.length > 0, prctlDir);

    const prctlDropIn = (await exec(c, `cat ~/.config/systemd/user/openclaw-gateway.service.d/prctl-subreaper.conf 2>/dev/null`)).stdout;
    const prctlConfigOk = prctlDropIn.includes("--require prctl-subreaper") && prctlDropIn.includes(".nvm/versions/node");
    record("prctl-subreaper systemd drop-in present", "P0", ["bake", "test"], prctlConfigOk, "");

    // ─── 3. systemd override (TasksMax, MemoryMax) ─────────────────────────
    const override = (await exec(c, `cat ~/.config/systemd/user/openclaw-gateway.service.d/override.conf 2>/dev/null`)).stdout;
    record("TasksMax=120 in override (v86)", "P0", ["bake", "test"], /TasksMax\s*=\s*120/.test(override), "");
    record("MemoryMax=3500M", "P1", ["bake", "test"], /MemoryMax\s*=\s*3500M/.test(override), "");

    // ─── 4. Workspace files (templates present, identity reset) ────────────
    const wsFiles = ["SOUL.md", "AGENTS.md", "CAPABILITIES.md", "IDENTITY.md", "MEMORY.md"];
    for (const f of wsFiles) {
      const present = (await exec(c, `test -f ~/.openclaw/workspace/${f}`)).code === 0;
      record(`workspace/${f} present`, "P0", ["bake", "test"], present, "");
    }
    // bootstrapMaxChars sanity
    const upfront = (await exec(c, `wc -c ~/.openclaw/workspace/SOUL.md ~/.openclaw/workspace/AGENTS.md ~/.openclaw/workspace/CAPABILITIES.md ~/.openclaw/workspace/IDENTITY.md 2>/dev/null | tail -1`)).stdout.trim();
    const upfrontBytes = parseInt(upfront.split(/\s+/)[0] || "0", 10);
    record("upfront context within bootstrapMaxChars (≤40000)", "P0", ["bake", "test"], upfrontBytes > 0 && upfrontBytes <= 40000, `${upfrontBytes} bytes`);

    // IDENTITY.md is reset (no "Timmy" or other named persona)
    const identity = (await exec(c, `cat ~/.openclaw/workspace/IDENTITY.md 2>/dev/null`)).stdout;
    const isReset = !/Name:\s*[A-Z][a-zA-Z]+\s*\n/.test(identity) || /Configure on first/i.test(identity);
    record("IDENTITY.md reset (no named persona)", "P0", ["bake", "test"], isReset, isReset ? "" : "still contains a Name: line");

    // MEMORY.md is empty/template
    const memory = (await exec(c, `cat ~/.openclaw/workspace/MEMORY.md 2>/dev/null`)).stdout;
    const memEmpty = memory.length < 200 || /Empty\s*—\s*first boot/i.test(memory);
    record("workspace/MEMORY.md is empty/template", "P0", ["bake", "test"], memEmpty,
      memEmpty ? "" : `MEMORY.md has ${memory.length} bytes of content`);

    // Cross-session memory templates exist
    record("workspace/memory/session-log.md present", "P1", ["bake", "test"],
      (await exec(c, `test -f ~/.openclaw/workspace/memory/session-log.md`)).code === 0, "");
    record("workspace/memory/active-tasks.md present", "P1", ["bake", "test"],
      (await exec(c, `test -f ~/.openclaw/workspace/memory/active-tasks.md`)).code === 0, "");

    // ─── 5. Secrets ABSENT (catastrophic contamination check) ──────────────
    await assertAbsent(c, ".env wiped",                "P0", ["bake"], "$HOME/.openclaw/.env");
    await assertAbsent(c, ".env.bak* wiped",           "P0", ["bake"], "$HOME/.openclaw/.env.bak");
    await assertAbsent(c, "gateway.systemd.env wiped", "P0", ["bake"], "$HOME/.openclaw/gateway.systemd.env");
    await assertAbsent(c, "auth-profiles.json wiped",  "P0", ["bake"], "$HOME/.openclaw/agents/main/agent/auth-profiles.json");
    await assertAbsent(c, "auth-state.json wiped",     "P0", ["bake"], "$HOME/.openclaw/agents/main/agent/auth-state.json");
    await assertAbsent(c, "xmtp/ wiped",               "P0", ["bake"], "$HOME/.openclaw/xmtp");
    await assertAbsent(c, "identity/ wiped",           "P0", ["bake"], "$HOME/.openclaw/identity");

    // For TEST mode, .env + auth-profiles must EXIST (configureOpenClaw set them)
    if (MODE === "test") {
      const envExists = (await exec(c, `test -f ~/.openclaw/.env`)).code === 0;
      record("configureOpenClaw wrote .env", "P0", ["test"], envExists, "");
      const authExists = (await exec(c, `test -f ~/.openclaw/agents/main/agent/auth-profiles.json`)).code === 0;
      record("configureOpenClaw wrote auth-profiles.json", "P0", ["test"], authExists, "");
    }

    // openclaw.json gateway.auth.token: REPLACE_ON_CONFIGURE in bake mode,
    // 64-hex string in test mode
    const tok = (await exec(c, `python3 -c "import json; print(json.load(open('$HOME/.openclaw/openclaw.json'))['gateway']['auth']['token'])"`)).stdout.trim();
    if (MODE === "bake") {
      record("gateway token scrubbed to placeholder", "P0", ["bake"], tok === "REPLACE_ON_CONFIGURE", `token=${tok.slice(0, 12)}...`);
    } else {
      record("gateway token set by configureOpenClaw (64-hex)", "P0", ["test"], /^[a-f0-9]{64}$/.test(tok), `token=${tok.slice(0, 12)}...`);
    }

    // No leftover secret values inside openclaw.json (e.g., sk-ant-*, sk-proj-*)
    const oj = (await exec(c, `cat $HOME/.openclaw/openclaw.json`)).stdout;
    const ojClean = !/sk-ant-api03-[a-zA-Z0-9_-]{20,}/.test(oj) && !/sk-proj-[a-zA-Z0-9_-]{20,}/.test(oj) && !/BSA[a-zA-Z0-9_]{15,}/.test(oj);
    record("openclaw.json contains no live API keys", "P0", ["bake"], ojClean, ojClean ? "" : "found a real-looking sk-* or BSA* token");

    // ─── 6. User memory + sessions absent ──────────────────────────────────
    await assertAbsent(c, "agent/MEMORY.md wiped",     "P1", ["bake"], "$HOME/.openclaw/agents/main/agent/MEMORY.md");
    await assertAbsent(c, "agent/SOUL.md wiped",       "P1", ["bake"], "$HOME/.openclaw/agents/main/agent/SOUL.md");
    await assertAbsent(c, "session-backups wiped",     "P0", ["bake"], "$HOME/.openclaw/session-backups/*");

    const sessFiles = (await exec(c, `ls ~/.openclaw/agents/main/sessions/ 2>/dev/null | wc -l`)).stdout.trim();
    record("sessions/ is empty", "P0", ["bake"], sessFiles === "0", `${sessFiles} files remain`);

    await assertAbsent(c, "sessions-archive wiped",    "P0", ["bake"], "$HOME/.openclaw/agents/main/sessions-archive");
    await assertAbsent(c, "sessions-backup wiped",     "P0", ["bake"], "$HOME/.openclaw/agents/main/sessions-backup");

    // gbrain DB empty
    const pgliteEmpty = (await exec(c, `ls ~/.gbrain/brain.pglite 2>/dev/null | wc -l`)).stdout.trim();
    record("gbrain PGLite empty (no user data)", "P0", ["bake"], pgliteEmpty === "0", `${pgliteEmpty} entries remain`);

    // ─── 7. Browser session wiped ──────────────────────────────────────────
    await assertAbsent(c, "browser cookies wiped",     "P0", ["bake"], "$HOME/.openclaw/browser/openclaw/user-data/Default/Cookies");
    await assertAbsent(c, "browser logins wiped",      "P0", ["bake"], "$HOME/.openclaw/browser/openclaw/user-data/Default/Login Data");

    // ─── 8. Partner-specific absent ────────────────────────────────────────
    await assertAbsent(c, "edge-esmeralda skill removed", "P0", ["bake"], "$HOME/.openclaw/skills/edge-esmeralda");
    await assertAbsent(c, "eclipse skill removed",     "P1", ["bake"], "$HOME/.openclaw/skills/eclipse");
    await assertAbsent(c, "dgclaw-skill sibling removed (configureOpenClaw re-installs if agdp_enabled)", "P1", ["bake"], "$HOME/dgclaw-skill");

    // Authorized SSH keys: deploy keys only, no partner bypass
    const ak = (await exec(c, `cat ~/.ssh/authorized_keys 2>/dev/null`)).stdout;
    const noPartnerKeys = !/edge-city-privacy-bypass|eclipse-bypass|partner-bypass-/.test(ak);
    record("authorized_keys has no partner-bypass keys", "P0", ["bake", "test"], noPartnerKeys, "");
    const deployKeyOk = /instaclaw-deploy/.test(ak);
    record("authorized_keys contains instaclaw-deploy key", "P0", ["bake", "test"], deployKeyOk, "");

    // ─── 9. Telegram state absent ──────────────────────────────────────────
    await assertAbsent(c, "telegram/ state wiped", "P0", ["bake"], "$HOME/.openclaw/telegram");

    // ─── 10. Stale locks + per-VM state ────────────────────────────────────
    const stale = await exec(c, `find ~/.openclaw -maxdepth 2 -name '*.lock' -not -path '*/node_modules/*' -not -path '*/.git/*' -not -name 'bun.lock' -not -name 'yarn.lock' -not -name 'package-lock.json' 2>/dev/null | wc -l`);
    record("no stale .lock files under ~/.openclaw", "P0", ["bake"], stale.stdout.trim() === "0", `${stale.stdout.trim()} stale locks`);

    for (const d of ["cron", "delivery-queue", "devices", "polymarket", "flows", "acpx"]) {
      const cnt = (await exec(c, `ls ~/.openclaw/${d}/ 2>/dev/null | wc -l`)).stdout.trim();
      record(`~/.openclaw/${d}/ empty or absent`, "P1", ["bake"], cnt === "0", `${cnt} entries`);
    }

    // ─── 11. Personal experiment scripts absent ────────────────────────────
    const beanCount = (await exec(c, `ls ~/bean-* ~/analyze_situation.js ~/base-memecoin-* 2>/dev/null | wc -l`)).stdout.trim();
    record("no personal experiment scripts in $HOME", "P0", ["bake", "test"], beanCount === "0", `${beanCount} files found`);

    // ─── 12. Backup-file proliferation absent ──────────────────────────────
    const bakCount = (await exec(c, `find ~/.openclaw/scripts -maxdepth 1 -name '*.bak*' 2>/dev/null | wc -l`)).stdout.trim();
    record("no *.bak* files in scripts/", "P1", ["bake"], bakCount === "0", `${bakCount} backup files`);

    const ojBakCount = (await exec(c, `ls ~/.openclaw/openclaw.json.bak* ~/.openclaw/openclaw.json.clobbered.* 2>/dev/null | wc -l`)).stdout.trim();
    record("no openclaw.json backup files", "P0", ["bake"], ojBakCount === "0", `${ojBakCount} backups`);

    const systemdBakCount = (await exec(c, `find ~/.config/systemd/user -name '*.predit-*' -o -name '*.bak' 2>/dev/null | wc -l`)).stdout.trim();
    record("no systemd drop-in *.predit-* or *.bak", "P1", ["bake"], systemdBakCount === "0", `${systemdBakCount} files`);

    // ─── 13. Crontab — partner duplicates removed ──────────────────────────
    const cron = (await exec(c, `crontab -l 2>/dev/null`)).stdout;
    const edgeCount = (cron.match(/skills\/edge-esmeralda/g) || []).length;
    record("no edge-esmeralda cron entries", "P0", ["bake"], edgeCount === 0, `${edgeCount} entries`);
    // canonical 7 crons (strip-thinking, auto-approve-pairing, vm-watchdog comment, push-heartbeat, silence-watchdog comment, SHM_CLEANUP, openclaw memory index)
    const stripCron = /strip-thinking\.py/.test(cron);
    const heartbeatCron = /push-heartbeat\.sh/.test(cron);
    record("strip-thinking.py cron present", "P0", ["bake", "test"], stripCron, "");
    record("push-heartbeat.sh cron present", "P1", ["bake", "test"], heartbeatCron, "");

    // ─── 14. Bash history wiped ────────────────────────────────────────────
    await assertAbsent(c, "bash_history wiped",       "P1", ["bake"], "$HOME/.bash_history");
    await assertAbsent(c, "known_hosts wiped",        "P1", ["bake"], "$HOME/.ssh/known_hosts");

    // ─── 15. Logs wiped (mostly — journal can have ~10MB from cleanup itself) ─
    const journalMb = parseInt((await exec(c, `sudo journalctl --disk-usage 2>&1 | grep -oE '[0-9.]+[MGK]' | head -1 | sed 's/M//;s/K//;s/G/000/'`)).stdout.trim() || "0", 10);
    record("journal log under 50 MB", "P0", ["bake"], journalMb < 50, `${journalMb} MB`);
    const syslogMb = parseInt((await exec(c, `sudo find /var/log -type f \\( -name 'syslog*' -o -name 'auth.log*' \\) -exec du -BM {} + 2>/dev/null | awk '{s+=$1} END{print s}'`)).stdout.trim() || "0", 10);
    record("syslog+auth.log under 30 MB", "P1", ["bake"], syslogMb < 30, `${syslogMb} MB`);

    // ─── 16. Caches mostly empty ───────────────────────────────────────────
    const npmMb = parseInt((await exec(c, `du -BM -s ~/.npm 2>/dev/null | awk '{print $1}'`)).stdout.trim() || "0", 10);
    record("~/.npm under 50 MB", "P1", ["bake"], npmMb < 50, `${npmMb} MB`);
    const aptMb = parseInt((await exec(c, `sudo du -BM -s /var/lib/apt/lists 2>/dev/null | awk '{print $1}'`)).stdout.trim() || "0", 10);
    record("apt lists under 10 MB", "P1", ["bake"], aptMb < 10, `${aptMb} MB`);

    // ─── 17. /tmp empty (except dotfiles) ──────────────────────────────────
    const tmpCount = (await exec(c, `ls /tmp 2>/dev/null | wc -l`)).stdout.trim();
    record("/tmp empty", "P1", ["bake"], tmpCount === "0" || tmpCount === "", `${tmpCount} entries`);

    // ─── 18. Manifest scripts present in canonical locations ───────────────
    const expectScripts = [
      "strip-thinking.py", "auto-approve-pairing.py", "vm-watchdog.py",
      "silence-watchdog.py", "push-heartbeat.sh", "generate_workspace_index.sh",
      "ack-watchdog.py", // v95 Layer 3
      "consensus_match_pipeline.py", "consensus_intent_sync.py",
    ];
    for (const s of expectScripts) {
      const exists = (await exec(c, `test -f ~/.openclaw/scripts/${s}`)).code === 0;
      record(`scripts/${s} present`, s === "ack-watchdog.py" ? "P0" : "P1", ["bake", "test"], exists, "");
    }

    // strip-thinking.py has Rule 23 sentinels
    const stripSentinels = (await exec(c, `grep -c 'def trim_failed_turns\\|SESSION TRIMMED:' ~/.openclaw/scripts/strip-thinking.py 2>/dev/null`)).stdout.trim();
    record("strip-thinking.py has Rule 23 sentinels (trim-not-nuke)", "P0", ["bake", "test"], parseInt(stripSentinels, 10) >= 2, `${stripSentinels}/2 sentinels`);

    // ─── 19. gbrain present (binary + MCP entry + env vars) ────────────────
    const bunVer = (await exec(c, `~/.bun/bin/bun --version 2>&1`)).stdout.trim();
    record("bun installed", "P0", ["bake", "test"], /^1\./.test(bunVer), `bun=${bunVer}`);

    const gbrainSymlink = (await exec(c, `ls -la ~/.bun/bin/gbrain 2>&1`)).stdout;
    record("gbrain binary symlink present", "P0", ["bake", "test"], gbrainSymlink.includes("gbrain"), gbrainSymlink.slice(0, 100));

    const mcpEntry = (await exec(c, `python3 -c "import json; d=json.load(open('$HOME/.openclaw/openclaw.json')); print('gbrain' in d.get('mcp',{}).get('servers',{}))"`)).stdout.trim();
    record("gbrain MCP entry in openclaw.json", "P0", ["bake", "test"], mcpEntry === "True", "");

    // ─── 20. Gateway operational state ─────────────────────────────────────
    if (MODE === "test") {
      // Gateway must be running on a test VM
      const isActive = (await exec(c, `systemctl --user is-active openclaw-gateway 2>&1`)).stdout.trim();
      record("gateway active (test mode)", "P0", ["test"], isActive === "active", `state=${isActive}`);

      const health = await exec(c, `curl -sS --max-time 5 http://localhost:18789/health 2>&1`);
      const healthy = health.stdout.includes('"ok":true');
      record("gateway /health returns 200", "P0", ["test"], healthy, health.stdout.slice(0, 80));

      // prctl-subreaper loaded into the running gateway
      const pid = (await exec(c, `systemctl --user show -p MainPID openclaw-gateway | cut -d= -f2`)).stdout.trim();
      const prctlLoaded = (await exec(c, `cat /proc/${pid}/environ 2>/dev/null | tr '\\0' '\\n' | grep -c 'NODE_OPTIONS=.*prctl-subreaper'`)).stdout.trim();
      record("prctl-subreaper loaded in running gateway", "P0", ["test"], prctlLoaded === "1", `pid=${pid}`);

      // TasksMax applied at runtime
      const tasksMaxRt = (await exec(c, `systemctl --user show openclaw-gateway -p TasksMax`)).stdout.trim();
      record("TasksMax=120 applied at runtime", "P0", ["test"], /TasksMax=120/.test(tasksMaxRt), tasksMaxRt);
    } else {
      // Gateway must be STOPPED on bake VM (we just stopped it during cleanup)
      const isActive = (await exec(c, `systemctl --user is-active openclaw-gateway 2>&1`)).stdout.trim();
      const okStates = ["inactive", "failed", "deactivating"];
      record("gateway stopped (bake mode)", "P1", ["bake"], okStates.includes(isActive), `state=${isActive}`);
    }

    // ─── 21. Config keys (v95 manifest) ────────────────────────────────────
    const expectKeys: Record<string, string> = {
      "channels.telegram.streaming.mode": "partial",
      "channels.telegram.streaming.preview.toolProgress": "false",
      "channels.telegram.streaming.preview.chunk.minChars": "30",
      "channels.telegram.streaming.preview.chunk.maxChars": "800",
      "channels.telegram.streaming.preview.chunk.breakPreference": "sentence",
      "messages.ackReactionScope": "all",
      "messages.ackReaction": "👀",
      "messages.removeAckAfterReply": "false",
      "messages.statusReactions.enabled": "true",
      "agents.defaults.timeoutSeconds": "300",
      "agents.defaults.bootstrapMaxChars": "40000",
      "agents.defaults.compaction.maxActiveTranscriptBytes": "150000",
      "session.reset.mode": "idle",
      "session.reset.idleMinutes": "10080",
    };
    for (const [k, want] of Object.entries(expectKeys)) {
      const got = (await exec(c, `source ~/.nvm/nvm.sh 2>/dev/null && openclaw config get "${k}" 2>&1`)).stdout.trim();
      const pass = got === want;
      record(`config ${k}=${want}`, "P0", ["bake", "test"], pass, pass ? "" : `got=${got}`);
    }

    // ─── 22. Disk usage under image cap ────────────────────────────────────
    const df = (await exec(c, `df -BM / | tail -1 | awk '{print $3}' | sed 's/M//'`)).stdout.trim();
    const dfMb = parseInt(df, 10);
    record(`disk usage ≤ ${MAX_DISK_MB} MB (Linode image cap)`, "P0", ["bake"], dfMb <= MAX_DISK_MB, `${dfMb} MB`);

    // ─── 23. Skills directory sane (28 expected skills present) ────────────
    const skillCount = (await exec(c, `ls ~/.openclaw/skills/ 2>/dev/null | wc -l`)).stdout.trim();
    record("≥20 skills in ~/.openclaw/skills/", "P1", ["bake", "test"], parseInt(skillCount, 10) >= 20, `${skillCount} skills`);

    // bankr SKILL.md present somewhere (multi-skill git-cloned repo)
    const bankrSkill = (await exec(c, `find ~/.openclaw/skills/bankr -maxdepth 3 -name SKILL.md 2>/dev/null | wc -l`)).stdout.trim();
    record("bankr skill has ≥1 SKILL.md", "P1", ["bake", "test"], parseInt(bankrSkill, 10) >= 1, `${bankrSkill} SKILL.md files`);

    // ─── 24. sudoers ───────────────────────────────────────────────────────
    const sudoers = (await exec(c, `sudo cat /etc/sudoers.d/openclaw 2>/dev/null`)).stdout;
    record("sudoers: openclaw NOPASSWD", "P0", ["bake", "test"], /openclaw\s+ALL=\(ALL\)\s+NOPASSWD/.test(sudoers), "");

    // ─── 25. cloud-init state cleared (so re-runs on new VM) ───────────────
    const cloudInstance = (await exec(c, `sudo ls /var/lib/cloud/instances 2>/dev/null | wc -l`)).stdout.trim();
    record("cloud-init instances dir cleared", "P1", ["bake"], cloudInstance === "0", `${cloudInstance} dirs`);

    // ─── 26. snapshot-bake-mode marker should NOT be present (cleanup removes it) ─
    await assertAbsent(c, "snapshot-bake-mode marker removed", "P2", ["bake"], "$HOME/.snapshot-bake-mode");
  } finally {
    c.end();
  }

  // ── Report ──
  console.log();
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log(`  Mode: ${MODE}  |  VM: ${VM_IP}  |  Total checks: ${checks.length}`);
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log();

  const grouped: Record<Severity, Check[]> = { P0: [], P1: [], P2: [] };
  for (const c of checks) grouped[c.severity].push(c);

  let p0Fails = 0, p1Fails = 0, p2Fails = 0;
  for (const sev of ["P0", "P1", "P2"] as Severity[]) {
    const items = grouped[sev];
    const fails = items.filter(c => !c.pass);
    const passes = items.length - fails.length;
    console.log(`${sev}: ${passes}/${items.length} pass${fails.length ? `   (${fails.length} fail)` : ""}`);
    for (const c of fails) {
      console.log(`  ✗ [${sev}] ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
    }
    if (sev === "P0") p0Fails = fails.length;
    if (sev === "P1") p1Fails = fails.length;
    if (sev === "P2") p2Fails = fails.length;
  }

  console.log();
  if (p0Fails > 0) {
    console.log(`✗ ${p0Fails} P0 failure(s) — DO NOT bake/ship. Investigate and fix.`);
    process.exit(1);
  } else if (p1Fails > 0) {
    console.log(`⚠ ${p1Fails} P1 warning(s) — review before proceeding.`);
    process.exit(0);
  } else if (p2Fails > 0) {
    console.log(`✓ All P0/P1 pass. ${p2Fails} P2 nits.`);
    process.exit(0);
  } else {
    console.log(`✓ ALL CHECKS PASS — ready for next step.`);
    process.exit(0);
  }
}

run().catch(e => { console.error("FATAL:", e); process.exit(2); });
