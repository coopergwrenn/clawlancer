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
import { OPENCLAW_PINNED_VERSION, NODE_PINNED_VERSION } from "../lib/ssh";

// ── Env loading ──
// Resolve relative to the script's location so this works from any
// worktree or CI environment (was previously hardcoded to one path).
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname_local = typeof __dirname !== "undefined"
  ? __dirname
  : dirname(fileURLToPath(import.meta.url));
const repoInstaclaw = resolve(__dirname_local, "..");
for (const f of [
  resolve(repoInstaclaw, ".env.local"),
  resolve(repoInstaclaw, ".env.ssh-key"),
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

// Parse `pkg@1.2.3` (or bare `1.2.3`) into [1, 2, 3]. Returns null on malformed.
// Used by version-pin checks. Replaces the earlier per-pin regex approach
// that miscounted >9-patch-version releases (e.g., 0.3.10 vs 0.3.1).
function parseSemver(s: string): number[] | null {
  if (!s) return null;
  const m = s.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}
// True iff `actual` >= `min`, component-wise. Both must parse cleanly.
function semverGte(actual: string, min: string): boolean {
  const a = parseSemver(actual);
  const b = parseSemver(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
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
    // ─── 0. Operator-environment / cv-init protection (Cooper 2026-05-24) ──
    // The v113 cv-init bug Cooper remembers: LINODE_SNAPSHOT_CV defaults to
    // 0 in lib/ssh.ts:8931 if unset, which means configureOpenClaw sets
    // vm.config_version=0 on every fresh-from-snapshot VM. The reconciler
    // then runs the full v0→vMANIFEST delta on first message (3-15 min per
    // the post-mortem comment at lib/ssh.ts:8897-8903) — every Edge attendee's
    // first message overlaps with multiple gateway restarts. The fix shipped
    // 2026-05-23 in commit 1fb249d5 reads LINODE_SNAPSHOT_CV env var to
    // pre-set cv to the snapshot's encoded version.
    //
    // But operator cutover guidance in lib/bake/steps.ts only printed the
    // LINODE_SNAPSHOT_ID update line — operator can forget to update
    // LINODE_SNAPSHOT_CV in parallel, regressing to the cv=0 bug. This gate
    // enforces the operational contract from lib/ssh.ts:8920:
    //
    //   LINODE_SNAPSHOT_CV must be set, positive, and STRICTLY LESS THAN
    //   VM_MANIFEST.version (so reconciler's lt(cv, manifest) filter still
    //   includes new VMs and runs at least one cycle — preserves the
    //   lying-DB defense per Rule 23 / Rule 10).
    //
    // The validator inherits operator's local .env.local; that's the value
    // that NEW production VMs will get post-cutover. Run this BEFORE any
    // on-VM checks so a cv-misconfig fails the bake fast.
    let manifestVersion = 0;
    try {
      const manifestSrc = readFileSync(resolve(repoInstaclaw, "lib/vm-manifest.ts"), "utf-8");
      // Same regex as lib/bake/source-of-truth.ts:extractManifestVersion
      const startMatch = manifestSrc.match(/export\s+const\s+VM_MANIFEST\s*=\s*\{/);
      if (startMatch) {
        const after = manifestSrc.slice((startMatch.index ?? 0) + startMatch[0].length);
        const verMatch = after.match(/^[ \t]+version:\s*(\d+)\s*,/m);
        if (verMatch) manifestVersion = parseInt(verMatch[1], 10);
      }
    } catch {}
    const cvEnvRaw = process.env.LINODE_SNAPSHOT_CV;
    const cvEnvNum = cvEnvRaw === undefined ? NaN : Number(cvEnvRaw);
    const cvEnvSet = cvEnvRaw !== undefined && cvEnvRaw.trim() !== "";
    const cvEnvPositive = Number.isFinite(cvEnvNum) && cvEnvNum > 0;
    record("LINODE_SNAPSHOT_CV env var SET (prevents cv=0 → full reconcile on first message)",
      "P0", ["bake", "test"], cvEnvSet,
      cvEnvSet ? `set to '${cvEnvRaw}'` : "LINODE_SNAPSHOT_CV unset → configureOpenClaw fallback sets vm.cv=0 → every fresh VM does full v0→vMANIFEST delta (3-15 min)");
    record("LINODE_SNAPSHOT_CV is a positive integer",
      "P0", ["bake", "test"], cvEnvPositive,
      cvEnvPositive ? `cv=${cvEnvNum}` : `value='${cvEnvRaw}' not parseable as positive integer`);
    if (manifestVersion > 0 && cvEnvPositive) {
      // STRICT less-than per lib/ssh.ts:8920 operational contract.
      // cv === manifest is a soft regression: reconciler's lt() filter
      // excludes the new VMs until manifest bumps again. So we WARN at
      // equal (P1) and FAIL at greater (P0 — snapshot encodes a future
      // state the reconciler can't repair forward).
      record(`LINODE_SNAPSHOT_CV (${cvEnvNum}) < VM_MANIFEST.version (${manifestVersion}) — operational contract (strict)`,
        cvEnvNum >= manifestVersion ? (cvEnvNum > manifestVersion ? "P0" : "P1") : "P0",
        ["bake", "test"], cvEnvNum < manifestVersion,
        cvEnvNum > manifestVersion
          ? `cv=${cvEnvNum} > manifest=${manifestVersion} — reconciler will SKIP every new VM forever (cv filter is lt-manifest)`
          : cvEnvNum === manifestVersion
            ? `cv === manifest === ${cvEnvNum} — new VMs reconcile-skip until next manifest bump (bump VM_MANIFEST.version in same commit as bake cutover)`
            : "");
    }
    if (manifestVersion === 0) {
      record("VM_MANIFEST.version readable from lib/vm-manifest.ts",
        "P0", ["bake", "test"], false,
        "couldn't parse VM_MANIFEST.version — validator can't enforce cv operational contract");
    }
    console.log(`  Manifest version: ${manifestVersion}  |  LINODE_SNAPSHOT_CV env: ${cvEnvRaw ?? "<unset>"}\n`);

    // ─── 0b. Vercel cron count awareness (Cooper 2026-05-24 sweep) ──────────
    // Vercel Pro caps at 100 cron jobs per project (verified
    // 2026-05-24 against https://vercel.com/docs/cron-jobs/usage-and-pricing).
    // Approaching the limit is silent: deploy fails at 101 with a non-obvious
    // error. Track and warn well before. Today's count = 44 after the
    // CDP-wallet provisioning cron (commit ab9d5dd4) — 56 headroom.
    // P1 warn at 80; P0 fail at 100. Read from instaclaw/vercel.json.
    let cronCount = 0;
    try {
      const vercelJson = JSON.parse(readFileSync(resolve(repoInstaclaw, "vercel.json"), "utf-8"));
      cronCount = Array.isArray(vercelJson?.crons) ? vercelJson.crons.length : 0;
    } catch {}
    record(`Vercel cron count under 100 (Pro plan limit) — current=${cronCount}`,
      cronCount >= 100 ? "P0" : cronCount >= 80 ? "P1" : "P2", ["bake", "test"],
      cronCount > 0 && cronCount < 100,
      cronCount === 0 ? "couldn't parse vercel.json crons array"
        : cronCount >= 100 ? `${cronCount} crons exceeds Pro plan cap of 100 — next deploy WILL fail`
          : cronCount >= 80 ? `${cronCount} crons — within 20 of Pro cap; review before adding more`
            : "");

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
    // Version checks read from lib/ssh.ts so the validator auto-tracks pin
    // bumps. Previously hardcoded "2026.4.26" / "v22.22.2" — the literal
    // would silently false-fail on the next bump. Import from source of
    // truth: bumping OPENCLAW_PINNED_VERSION or NODE_PINNED_VERSION
    // alone is now enough — no separate validator update required.
    const nodeV = (await exec(c, `source ~/.nvm/nvm.sh 2>/dev/null && node --version`)).stdout.trim();
    const expectedNode = `v${NODE_PINNED_VERSION}`;
    record(`node ${expectedNode} pinned`, "P0", ["bake", "test"], nodeV === expectedNode, `got ${nodeV}`);

    const openclawV = (await exec(c, `source ~/.nvm/nvm.sh 2>/dev/null && openclaw --version`)).stdout.trim();
    record(`OpenClaw ${OPENCLAW_PINNED_VERSION} pinned`, "P0", ["bake", "test"], openclawV.includes(OPENCLAW_PINNED_VERSION), `got ${openclawV}`);

    const gccPresent = (await exec(c, `which gcc`)).code === 0;
    record("build-essential / gcc installed (v88)", "P0", ["bake", "test"], gccPresent, "gcc on PATH");

    const prctlDir = (await exec(c, `ls -d $(source ~/.nvm/nvm.sh; npm root -g)/prctl-subreaper 2>/dev/null`)).stdout.trim();
    record("prctl-subreaper npm package present (v87)", "P0", ["bake", "test"], prctlDir.length > 0, prctlDir);

    const prctlDropIn = (await exec(c, `cat ~/.config/systemd/user/openclaw-gateway.service.d/prctl-subreaper.conf 2>/dev/null`)).stdout;
    const prctlConfigOk = prctlDropIn.includes("--require prctl-subreaper") && prctlDropIn.includes(".nvm/versions/node");
    record("prctl-subreaper systemd drop-in present", "P0", ["bake", "test"], prctlConfigOk, "");

    // ─── 3. systemd override (TasksMax, MemoryMax, ExecStartPre/Post) ──────
    const override = (await exec(c, `cat ~/.config/systemd/user/openclaw-gateway.service.d/override.conf 2>/dev/null`)).stdout;
    // v120 (2026-05-24, commit 5450513a): TasksMax raised from 120 → infinity.
    // The artificial 120 cap was OURS — Ubuntu user.slice defaults to "infinity".
    // TasksMax counts THREADS not processes; a single Chromium headless session
    // uses 100+ threads, blowing past 120 during normal Chromium MCP burst.
    // Runaway protection still in place via MemoryMax=3500M cgroup kill +
    // OOMScoreAdjust=500 + prctl-subreaper. See CLAUDE.md Rule 65.
    record("TasksMax=infinity in override (v120 — removed artificial cap that throttled Chromium MCP)",
      "P0", ["bake", "test"], /TasksMax\s*=\s*infinity/i.test(override),
      override.match(/TasksMax\s*=\s*\S+/i)?.[0] ?? "TasksMax not set in override");
    record("MemoryMax=3500M", "P1", ["bake", "test"], /MemoryMax\s*=\s*3500M/.test(override), "");
    record("OOMScoreAdjust=500 in override", "P1", ["bake", "test"], /OOMScoreAdjust\s*=\s*500/.test(override), "");
    record("KillMode=mixed in override", "P1", ["bake", "test"], /KillMode\s*=\s*mixed/.test(override), "");
    // v100 (2026-05-15, commit d2f94536) REMOVED RuntimeMaxSec + RuntimeRandomizedExtraSec.
    // The 24h forced restart caused mid-conversation SIGTERM (vm-050 incident). The check
    // is now inverted: these lines MUST be absent from override.conf.
    record("v100: RuntimeMaxSec REMOVED from override (no scheduled 24h restart)", "P0", ["bake", "test"],
      !/RuntimeMaxSec/.test(override), "RuntimeMaxSec still present in override.conf");
    record("v100: RuntimeRandomizedExtraSec REMOVED from override", "P1", ["bake", "test"],
      !/RuntimeRandomizedExtraSec/.test(override), "RuntimeRandomizedExtraSec still present in override.conf");
    record("Environment=PARTNER_ID=INSTACLAW in override", "P2", ["bake", "test"], /PARTNER_ID=INSTACLAW/.test(override), "");
    // v115/v118 (2026-05-23): OPENCLAW_DISABLE_BONJOUR=true env var added
    // as SECOND gate against bonjour/mDNS discovery spawning ciao + racing
    // the gateway with SIGTERM (original v71 CIAO incident). First gate was
    // discovery.mdns.mode=off (in configSettings) — but cloud-init team
    // rediscovered 2026-05-22 (commit 4acc5280) that some upstream path
    // still spawned ciao despite the config-set. The env var gate is read
    // by OpenClaw via isTruthyEnvValue. Without this, gpt-5.5 reasoning
    // can be interrupted by ciao-spawned SIGTERM mid-call.
    record("Environment=OPENCLAW_DISABLE_BONJOUR=true in override (v115/v118 dual-gate)",
      "P0", ["bake", "test"], /Environment\s*=\s*OPENCLAW_DISABLE_BONJOUR\s*=\s*true/.test(override),
      override.match(/OPENCLAW_DISABLE_BONJOUR\s*=\s*\S+/)?.[0] ?? "OPENCLAW_DISABLE_BONJOUR not set — bonjour/ciao can spawn and SIGTERM-race the gateway (v71 incident)");
    // Memory-snapshot integration (v73): ExecStartPre restore + ExecStopPost pre-stop.
    // If missing, MEMORY.md is not preserved across gateway restarts — user-data loss.
    record("override: ExecStartPre calls memory-snapshot.sh restore", "P0", ["bake", "test"],
      /ExecStartPre.*memory-snapshot\.sh restore/.test(override), "");
    record("override: ExecStopPost calls memory-snapshot.sh pre-stop", "P0", ["bake", "test"],
      /ExecStopPost.*memory-snapshot\.sh pre-stop/.test(override), "");

    // ─── 3b. Stale-Node-path check (Discovery 2026-05-13 — gbrain terminal)
    // The prctl-subreaper.conf drop-in hardcodes NODE_PATH=${npmRoot} at write
    // time. If Node is later upgraded, the path points at the OLD version's
    // node_modules and the addon won't load. Verify it matches the CURRENT
    // `npm root -g`. Same risk class for dispatch-server.service ExecStart
    // and browser-relay-server.service.
    const npmRootRT = (await exec(c, `source ~/.nvm/nvm.sh 2>/dev/null && npm root -g`)).stdout.trim();
    const prctlPath = (prctlDropIn.match(/NODE_PATH="?([^"\n]+)"?/) || [])[1] || "";
    record("prctl-subreaper.conf NODE_PATH matches current npm root -g", "P0", ["bake", "test"],
      prctlPath.length > 0 && prctlPath === npmRootRT, `npm-root=${npmRootRT} drop-in=${prctlPath || "<unset>"}`);

    // dispatch-server.service has a frozen NODE_BIN_PATH from when configureOpenClaw
    // ran. Check the captured node version matches current.
    const nodeVerRT = nodeV.replace(/^v/, "");
    const dispatchUnit = (await exec(c, `cat ~/.config/systemd/user/dispatch-server.service 2>/dev/null`)).stdout;
    const dispatchPathMatch = dispatchUnit.match(/nvm\/versions\/node\/v?([\d.]+)\/bin/);
    if (dispatchPathMatch) {
      record("dispatch-server.service Node-version path matches current Node", "P0", ["bake", "test"],
        dispatchPathMatch[1] === nodeVerRT, `unit=v${dispatchPathMatch[1]} current=v${nodeVerRT}`);
    } else {
      // No version-pinned path found — could be dynamic. P2 informational.
      record("dispatch-server.service unit present", "P2", ["bake", "test"], dispatchUnit.length > 50, "");
    }

    // ─── 3c. sshd OOM protection drop-in (per Rule 16 / map §9.8) ─────────
    const sshdDropIn = (await exec(c, `sudo cat /etc/systemd/system/ssh.service.d/oom-protect.conf 2>/dev/null`)).stdout;
    record("sshd oom-protect.conf has OOMScoreAdjust=-900", "P0", ["bake", "test"],
      /OOMScoreAdjust\s*=\s*-900/.test(sshdDropIn), "");

    // ─── 3d. gateway-watchdog.timer disabled (v69) ────────────────────────
    const watchdogTimer = (await exec(c, `systemctl --user is-enabled gateway-watchdog.timer 2>&1`)).stdout.trim();
    const watchdogOk = watchdogTimer === "disabled" || watchdogTimer.includes("Failed to get unit") || watchdogTimer === "masked";
    record("gateway-watchdog.timer disabled (v69)", "P1", ["bake", "test"], watchdogOk, `is-enabled=${watchdogTimer}`);

    // ─── 3e. System-level services (xvfb, x11vnc, websockify) ─────────────
    for (const svc of ["xvfb.service", "x11vnc.service", "websockify.service"]) {
      const present = (await exec(c, `test -f /etc/systemd/system/${svc} && echo Y || echo N`)).stdout.trim() === "Y";
      record(`system unit /etc/systemd/system/${svc} present`, "P1", ["bake", "test"], present, "");
    }
    // In test mode, the user-level dispatch + browser-relay services should be active.
    if (MODE === "test") {
      for (const svc of ["dispatch-server", "browser-relay-server"]) {
        const status = (await exec(c, `systemctl --user is-active ${svc}.service 2>&1`)).stdout.trim();
        record(`${svc}.service active (test mode)`, "P0", ["test"], status === "active", `state=${status}`);
      }
    }

    // ─── 4. Workspace files (presence + bootstrap size budgets) ────────────
    //
    // OpenClaw 2026.4.26 loads exactly these 8 files as upfront context (see
    // VALID_BOOTSTRAP_NAMES in workspace-Ddypv-c6.js). CAPABILITIES.md / EARN.md /
    // QUICK-REFERENCE.md / WALLET.md exist on disk but are NOT upfront — the
    // agent reads them via filesystem tools when relevant. The pre-2026-05-18
    // version of this check incorrectly included CAPABILITIES.md in the
    // upfront sum AND compared against 40000 (the per-file cap), missing the
    // distinct 60000 total-cap (bootstrapTotalMaxChars, default 60000).
    //
    // Caps per runtime-schema-TpYHXgGk.js:3208-3220:
    //   bootstrapMaxChars      = per-FILE cap (default 12000, ours 40000)
    //   bootstrapTotalMaxChars = TOTAL cap across all bootstrap files (default 60000)
    // Template files: written by reconciler from manifest. Present in both
    // bake (post-reconcile-run-audit) and test (real VM post-provision) modes.
    const BOOTSTRAP_FILES_P0_TEMPLATE = ["SOUL.md", "AGENTS.md", "IDENTITY.md", "TOOLS.md", "HEARTBEAT.md", "MEMORY.md"];
    // Per-VM files: created by configureOpenClaw at real user assignment.
    // The bake VM has no real user — USER.md is absent BY DESIGN. The check
    // belongs in test mode (against a soak/real VM that has been configured).
    // Bake attempt 19 (2026-05-25) failed on this P0 — it shouldn't.
    const BOOTSTRAP_FILES_P0_PER_VM = ["USER.md"];
    const BOOTSTRAP_FILES_OPTIONAL = ["BOOTSTRAP.md"]; // legitimately may not exist
    const NON_BOOTSTRAP_WORKSPACE_FILES = ["CAPABILITIES.md", "EARN.md", "QUICK-REFERENCE.md", "WALLET.md"];
    // Combined for size-cap checks below (per-file + total)
    const BOOTSTRAP_FILES_P0 = [...BOOTSTRAP_FILES_P0_TEMPLATE, ...BOOTSTRAP_FILES_P0_PER_VM];

    for (const f of BOOTSTRAP_FILES_P0_TEMPLATE) {
      const present = (await exec(c, `test -f ~/.openclaw/workspace/${f}`)).code === 0;
      record(`workspace/${f} present (bootstrap-required)`, "P0", ["bake", "test"], present, "");
    }
    for (const f of BOOTSTRAP_FILES_P0_PER_VM) {
      const present = (await exec(c, `test -f ~/.openclaw/workspace/${f}`)).code === 0;
      // P0 in test (real VM should have it after configureOpenClaw)
      // — in bake, the file is absent BY DESIGN (no real user assigned).
      record(`workspace/${f} present (bootstrap-required, per-VM)`, "P0", ["test"], present, "");
    }
    for (const f of NON_BOOTSTRAP_WORKSPACE_FILES) {
      const present = (await exec(c, `test -f ~/.openclaw/workspace/${f}`)).code === 0;
      record(`workspace/${f} present (on-demand)`, "P1", ["bake", "test"], present, "");
    }

    // Per-file cap (bootstrapMaxChars=40000): each individual bootstrap file
    // must be ≤ 40000 chars or OpenClaw truncates it (a real, customer-visible
    // problem — partial truncation can drop critical content silently).
    const PER_FILE_CAP = 40000;
    const allBootstrap = [...BOOTSTRAP_FILES_P0, ...BOOTSTRAP_FILES_OPTIONAL];
    let bootstrapTotalBytes = 0;
    for (const f of allBootstrap) {
      const sizeOut = (await exec(c, `wc -c < ~/.openclaw/workspace/${f} 2>/dev/null || echo 0`)).stdout.trim();
      const size = parseInt(sizeOut, 10) || 0;
      if (size > 0) {
        bootstrapTotalBytes += size;
        record(`workspace/${f} ≤ bootstrapMaxChars=40000 (per-file cap)`, "P0", ["bake", "test"],
          size <= PER_FILE_CAP, `${size} chars`);
      }
    }

    // Total cap (bootstrapTotalMaxChars=60000 — default, NOT pinned in manifest
    // as of cv=105). If we ever pin a different value in the manifest, update
    // this constant in lockstep.
    const TOTAL_CAP = 60000;
    record(`upfront bootstrap total ≤ bootstrapTotalMaxChars=60000`, "P0", ["bake", "test"],
      bootstrapTotalBytes > 0 && bootstrapTotalBytes <= TOTAL_CAP,
      `${bootstrapTotalBytes} chars across ${allBootstrap.length} bootstrap files (cap ${TOTAL_CAP})`);

    // Warning band: total > 50000 means ≤10K headroom — operator should
    // notice and start thinking about trim before the next manifest bump.
    if (bootstrapTotalBytes > 50000 && bootstrapTotalBytes <= TOTAL_CAP) {
      record(`upfront bootstrap total has headroom warning (>50000, <60000)`, "P2", ["bake", "test"],
        false, `${bootstrapTotalBytes} chars — ${TOTAL_CAP - bootstrapTotalBytes} headroom`);
    }

    // IDENTITY.md is reset (no "Timmy" or other named persona)
    const identity = (await exec(c, `cat ~/.openclaw/workspace/IDENTITY.md 2>/dev/null`)).stdout;
    const isReset = !/Name:\s*[A-Z][a-zA-Z]+\s*\n/.test(identity) || /Configure on first/i.test(identity);
    record("IDENTITY.md reset (no named persona)", "P0", ["bake", "test"], isReset, isReset ? "" : "still contains a Name: line");

    // SOUL.md has InstaClaw platform identity marker (v89 / map §13 step #24)
    const soul = (await exec(c, `cat ~/.openclaw/workspace/SOUL.md 2>/dev/null`)).stdout;
    record("SOUL.md contains INSTACLAW_PLATFORM_V1 marker (v89+)", "P1", ["bake", "test"],
      /INSTACLAW_PLATFORM_V1/.test(soul), "");
    // SOUL.md OPENCLAW_CACHE_BOUNDARY marker (v72 — load-bearing for 1000x cheaper edits)
    record("SOUL.md contains OPENCLAW_CACHE_BOUNDARY marker (v72)", "P1", ["bake", "test"],
      /OPENCLAW_CACHE_BOUNDARY/.test(soul), "");
    // SOUL.md size — full enforcement against BOOTSTRAP_MAX_CHARS=40000 (per-file cap)
    // happens in §4 above, where every bootstrap file gets a P0 gate. This block
    // adds two early-warning P2 signals so operators see SOUL approaching the cap
    // before it actually truncates. Previously this was a P1 ≤35000 gate that
    // conflicted with the new §4 P0 ≤40000 gate — SOUL.md naturally grew to
    // 35689 over v82→v105, which would have caused every postbake run to report
    // a spurious P1 fail. The OpenClaw Upgrade Playbook's old "30K hard stop"
    // referenced the pre-2026-05-11 30000-char limit; BOOTSTRAP_MAX_CHARS was
    // raised to 40000 on 2026-05-11.
    const soulBytes = parseInt((await exec(c, `wc -c < ~/.openclaw/workspace/SOUL.md 2>/dev/null`)).stdout.trim() || "0", 10);
    if (soulBytes > 35000 && soulBytes <= 40000) {
      record(
        "SOUL.md approaching bootstrapMaxChars per-file cap (>35000, ≤40000)",
        "P2", ["bake", "test"], false,
        `${soulBytes} bytes — ${40000 - soulBytes} headroom before truncation`,
      );
    }

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
    // identity/ is RECREATED at first-boot by openclaw-gateway (creates
    // device.json — per-device identity). The snapshot SHIPS without
    // identity (pre-bake-cleanup wipes it; image is taken with gateway
    // STOPPED so no recreation). But once a VM provisions from the
    // snapshot, gateway autostarts and recreates ~/.openclaw/identity/.
    // The check is correctly asserting "wiped" on the bake VM (where
    // gateway is stopped), but the soak VM (which we also validate in
    // --mode=bake per the 2026-05-25 fix) has gateway running and identity
    // recreated. Demoted to P1 to allow both code paths. Snapshot quality
    // is still verified on the bake VM's post-bake-validate run (where
    // identity is genuinely absent because gateway is stopped).
    await assertAbsent(c, "identity/ wiped (snapshot ships absent; recreated at first-boot)",
                                                        "P1", ["bake"], "$HOME/.openclaw/identity");

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
    // `.consensus_intent.lock` is recreated at boot by consensus_intent_sync.py
    // cron (every 15 min — confirmed on production vm-1028: zero-byte file
    // mtime'd within the last cron tick). pre-bake-cleanup wipes it on the
    // bake VM (so the snapshot ships clean), but any provisioned VM
    // recreates it via cron. Demote to P1: snapshot quality verified on
    // bake VM; soak VM running production crons is acceptable steady-state.
    record("no stale .lock files under ~/.openclaw (recreated at first-boot by crons)",
      "P1", ["bake"], stale.stdout.trim() === "0", `${stale.stdout.trim()} stale locks`);

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

    // ─── 13. Crontab — full inventory per map §8 ──────────────────────────
    // Source of truth: docs/cloud-init-implementation-map.md §8 (9 manifest
    // crons + 1 universal git-pull + 1 SHM cleanup baked in snapshot).
    const cron = (await exec(c, `crontab -l 2>/dev/null`)).stdout;
    const edgeCount = (cron.match(/skills\/edge-esmeralda/g) || []).length;
    record("no edge-esmeralda cron entries", "P0", ["bake"], edgeCount === 0, `${edgeCount} entries`);
    const eclipseCount = (cron.match(/skills\/eclipse/g) || []).length;
    record("no eclipse cron entries", "P0", ["bake"], eclipseCount === 0, `${eclipseCount} entries`);

    // v114 (2026-05-23, commit a0f6b8a4): vm-watchdog REMOVED AGAIN +
    // actively scrubbed via cronJobsRemove[] (manifest line 2667-2668).
    // Background: v112 (2026-05-21) re-enabled vm-watchdog at AGENT_STALE_
    // MINUTES=15, but that produced a 30-min outage on vm-1016 on 2026-05-23
    // (watchdog killed a gateway mid-customer-flow). Cooper ordered second
    // removal, this time via cronJobsRemove which actively scrubs the entry
    // from existing crontabs (not just absent from cronJobs additions list).
    // Polarity inverted from v112 — now mirrors silence-watchdog: MUST be
    // absent from active (non-commented) cron entries. Script may still be
    // on disk (files[] still ships it for forensic compatibility); only the
    // cron wiring is gone.
    // Use ^[^#\n]*pattern/m to match only ACTIVE (non-commented) cron lines.
    const vmWatchdogActive = /^[^#\n]*vm-watchdog\.py/m.test(cron);
    record("v114 cron: vm-watchdog.py ABSENT from active cron (cronJobsRemove[])",
      "P0", ["bake", "test"], !vmWatchdogActive,
      vmWatchdogActive ? "vm-watchdog.py STILL active in cron (v114 cronJobsRemove not applied — caused 30-min vm-1016 outage on 2026-05-23)" : "");
    const silenceWatchdogActive = /^[^#\n]*silence-watchdog\.py/m.test(cron);
    record("v76 prune: silence-watchdog.py ABSENT from active cron",
      "P0", ["bake", "test"], !silenceWatchdogActive,
      silenceWatchdogActive ? "silence-watchdog.py STILL active in cron (v76 prune missing — stays removed per v112 + v114)" : "");

    // Required cron markers per map §8.
    const expectedCronMarkers: Array<{ pattern: RegExp; name: string; severity: Severity }> = [
      { pattern: /strip-thinking\.py/, name: "strip-thinking.py", severity: "P0" },
      { pattern: /ack-watchdog\.py/, name: "ack-watchdog.py (v95 Layer 3)", severity: "P0" },
      { pattern: /skill-integrity-check\.sh/, name: "skill-integrity-check.sh (Rule 24)", severity: "P0" },
      { pattern: /auto-approve-pairing\.py/, name: "auto-approve-pairing.py", severity: "P1" },
      { pattern: /push-heartbeat\.sh/, name: "push-heartbeat.sh", severity: "P1" },
      // v114 (2026-05-23): vm-watchdog REMOVED via cronJobsRemove[].
      // Previous v112 entry that required it PRESENT in cron has been
      // deleted — its absence is now enforced by the inverted-polarity
      // check at the line ~494-496 block above. Don't re-add.
      // consensus_match_pipeline.py was COMMENTED OUT in manifest cronJobs
      // (lib/vm-manifest.ts:2538-2540) per Component-3-deferral. The script
      // still exists on disk (used by other components), but no cron should
      // run it. Validator previously expected the cron entry — incorrect
      // post-v112. The script presence is still checked separately in
      // expectScripts (line 549) — that's correct, this cron expectation
      // was wrong.
      { pattern: /consensus_intent_sync\.py/, name: "consensus_intent_sync.py", severity: "P1" },
      { pattern: /openclaw memory index/, name: "openclaw memory index", severity: "P1" },
      { pattern: /workspace\/backups/, name: "workspace/backups cleanup", severity: "P2" },
      { pattern: /consensus-2026.*git pull/, name: "consensus-2026 git pull (universal)", severity: "P1" },
      { pattern: /SHM_CLEANUP/, name: "SHM_CLEANUP (snapshot-baked)", severity: "P2" },
    ];
    for (const m of expectedCronMarkers) {
      record(`cron entry: ${m.name}`, m.severity, ["bake", "test"], m.pattern.test(cron), "");
    }

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
    // Source of truth: docs/cloud-init-implementation-map.md §4 (17 scripts).
    // Severity-mapped per the bake-readiness audit 2026-05-13.
    const expectScripts: Array<{ name: string; severity: Severity }> = [
      // P0 — bake fails outright if missing
      { name: "strip-thinking.py", severity: "P0" },
      { name: "ack-watchdog.py", severity: "P0" },               // v95 Layer 3
      { name: "memory-snapshot.sh", severity: "P0" },            // used by gateway ExecStopPost/Pre — missing = silent memory loss
      { name: "skill-integrity-check.sh", severity: "P0" },      // Rule 24 self-heal cron
      // P1 — operational
      { name: "auto-approve-pairing.py", severity: "P1" },
      // vm-watchdog.py: present on disk AND in cron post-v112. The cron-
      // presence check at line ~495 enforces "MUST be in cron" with P0.
      // This entry just confirms the script file is on disk (P1 — cron
      // wiring is the load-bearing path).
      { name: "vm-watchdog.py", severity: "P1" },                // on-disk presence; cron-presence P0 above (v112 re-enable)
      // silence-watchdog.py: present on disk BUT NOT in cron. Stays
      // removed per v112 changelog (Phase 3 in-flight manifest replaces it).
      { name: "silence-watchdog.py", severity: "P1" },           // on-disk presence; v76 prune (no cron) checked at line ~498
      { name: "push-heartbeat.sh", severity: "P1" },
      { name: "generate_workspace_index.sh", severity: "P1" },
      { name: "consensus_match_pipeline.py", severity: "P1" },
      { name: "consensus_match_rerank.py", severity: "P1" },
      { name: "consensus_match_deliberate.py", severity: "P1" },
      { name: "consensus_match_consent.py", severity: "P1" },
      { name: "consensus_match_skill_toggle.py", severity: "P1" },
      { name: "consensus_intent_sync.py", severity: "P1" },
      { name: "consensus_intent_extract.py", severity: "P1" },
    ];
    for (const s of expectScripts) {
      const exists = (await exec(c, `test -f ~/.openclaw/scripts/${s.name}`)).code === 0;
      record(`scripts/${s.name} present`, s.severity, ["bake", "test"], exists, "");
    }
    // privacy-bridge.sh is partner-gated (edge_city only) — absent on bake VM
    await assertAbsent(c, "scripts/privacy-bridge.sh absent (bake is not edge_city)", "P2", ["bake"], "$HOME/.openclaw/scripts/privacy-bridge.sh");

    // browser-relay-server.js lives in ~/scripts/ NOT ~/.openclaw/scripts/
    record("~/scripts/browser-relay-server.js present", "P0", ["bake", "test"],
      (await exec(c, `test -f ~/scripts/browser-relay-server.js`)).code === 0, "");
    // deliver_file.sh / notify_user.sh / token-price.py — workspace-level scripts
    for (const s of ["deliver_file.sh", "notify_user.sh", "token-price.py"]) {
      const exists = (await exec(c, `test -f ~/scripts/${s}`)).code === 0;
      record(`~/scripts/${s} present`, "P1", ["bake", "test"], exists, "");
    }
    // dispatch-server.js + dispatch script count (Discovery #2 — inline pattern)
    record("~/scripts/dispatch-server.js present", "P0", ["bake", "test"],
      (await exec(c, `test -f ~/scripts/dispatch-server.js`)).code === 0, "");
    const dispatchCount = parseInt((await exec(c, `ls ~/scripts/*.sh 2>/dev/null | wc -l`)).stdout.trim() || "0", 10);
    record("dispatch .sh scripts in ~/scripts/ (expect ≥20)", "P1", ["bake", "test"], dispatchCount >= 20, `${dispatchCount} .sh files`);

    // strip-thinking.py has Rule 23 sentinels — all 10 required
    // (per docs/cloud-init-implementation-map.md §4). The bake-readiness
    // audit 2026-05-13 identified that only 2 were being checked, which
    // would silently miss a pre-v90 destructive-archive regression.
    const RULE23_SENTINELS = [
      "def trim_failed_turns",       // post-v85 trim path
      "SESSION TRIMMED:",            // post-v85 log line
      "def run_periodic_summary_hook", // periodic summary hook
      "PERIODIC_SUMMARY_V1",         // periodic summary marker
      "PRE_ARCHIVE_SUMMARY_V1",      // pre-archive summary marker
      "PERIODIC_SUMMARY_V1_RESHRINK", // re-shrink-after-summary marker
      "def compact_session_in_place_lines", // v90 Layer 1
      "SESSION COMPACTED:",          // v90 Layer 1 log line
      "def _extract_large_tool_results_to_cache", // v90 Layer 3
      "LAYER3_EXTRACTED:",           // v90 Layer 3 log line
      // v101 (2026-05-16, commit 48af5075): startup orphan tool_use repair
      "def run_startup_orphan_repair",
      "ORPHAN_REPAIR:",
      // Rule 45 (2026-05-14, commit eaf5617a): session-backup runaway fix
      "SESSION_BACKUP_COOLDOWN_SEC",
      "SESSION_BACKUP_MAX_PER_SESSION",
      // v120 (2026-05-24): OpenClaw 2026.5.20 compat guard. Per CLAUDE.md
      // Rule 65, we bake at OpenClaw 2026.4.26 (NOT 2026.5.20). This
      // sentinel marks the strip-thinking template as 2026.5.20-aware so
      // a future bake at 2026.5.20 picks up the compat fix automatically.
      // Source: lib/vm-manifest.ts:2200-2209 — files[] requiredSentinels.
      "STRIP_THINKING_v2026_5_20_COMPAT_v1",
      // v124 (2026-05-28, commit 27885f9b): periodic-summary LLM kill switch.
      // Fix for the fleet-wide credit overcharge that hit 19 paying users
      // 2026-05-28. Postmortem: docs/postmortems/2026-05-28-strip-thinking-
      // summary-overcharge.md. The constant is checked here for presence;
      // its actual value (must be True per Phase 2 fix, NOT False from
      // Phase 1 emergency state) is checked separately in §31a below.
      "STRIP_THINKING_LLM_KILL_SWITCH_2026_05_28",
    ];
    for (const sent of RULE23_SENTINELS) {
      const found = (await exec(c, `grep -c -F ${JSON.stringify(sent)} ~/.openclaw/scripts/strip-thinking.py 2>/dev/null`)).stdout.trim();
      record(`strip-thinking.py contains '${sent}'`, "P0", ["bake", "test"], parseInt(found, 10) >= 1, `${found} matches`);
    }

    // ─── 19. gbrain present (binary + MCP entry + env vars) ────────────────
    // gbrain installation contract:
    //   - bake mode: §3.4 BAKE-ONLY GBRAIN INSTALL runs install-gbrain.sh
    //     on the bake VM regardless of partner → gbrain MUST be installed.
    //   - test mode (fresh-from-snapshot): inherits gbrain from snapshot →
    //     gbrain MUST be installed.
    //   - operator-audit mode (--mode=test against an existing fleet VM):
    //     non-edge_city VMs may NOT have gbrain (stepGbrain in vm-reconcile.ts
    //     gates on GBRAIN_PARTNER_ALLOWLIST). Don't false-fail those.
    //
    // Detection: if ~/.config/systemd/user/gbrain.service exists, gbrain is
    // installed; if not, it isn't. Bake mode always P0 (contract is hard);
    // test mode downgrades to P2 if gbrain isn't installed (acceptable on
    // operator-audit against non-edge_city fleet VMs).
    const gbrainInstalled = (await exec(c, `test -f ~/.config/systemd/user/gbrain.service && echo Y || echo N`)).stdout.trim() === "Y";
    const gbrainGateSev: Severity = (MODE === "bake" || gbrainInstalled) ? "P0" : "P2";
    const gbrainNoteSuffix = (MODE === "test" && !gbrainInstalled)
      ? " (downgraded to P2 — gbrain not installed; acceptable on non-edge_city fleet VM)"
      : "";

    // bun is a gbrain prerequisite (install-gbrain.sh Phase B installs it).
    // Partner-gate it the same as gbrain itself: bake mode always P0 (§3.4
    // contract), test mode P0 if gbrain installed else P2 (acceptable on
    // operator-audit against non-edge_city fleet VM that doesn't run gbrain).
    const bunVer = (await exec(c, `~/.bun/bin/bun --version 2>&1`)).stdout.trim();
    record(`bun installed${gbrainNoteSuffix}`, gbrainGateSev, ["bake", "test"], /^1\./.test(bunVer), `bun=${bunVer}`);

    const gbrainSymlink = (await exec(c, `ls -la ~/.bun/bin/gbrain 2>&1`)).stdout;
    record(`gbrain binary symlink present${gbrainNoteSuffix}`, gbrainGateSev, ["bake", "test"], gbrainSymlink.includes("gbrain"), gbrainSymlink.slice(0, 100));

    const mcpEntry = (await exec(c, `python3 -c "import json; d=json.load(open('$HOME/.openclaw/openclaw.json')); print('gbrain' in d.get('mcp',{}).get('servers',{}))"`)).stdout.trim();
    // bake mode: strip-bearer EXPLICITLY removes mcp.servers.gbrain (per
    // §3.6 — per-VM bearer minted at first reconcile after assignment).
    // The snapshot is supposed to ship WITHOUT this entry; checking for
    // its presence in bake mode contradicts the strip-bearer step's intent.
    // test mode: real-VM should have it post-configureOpenClaw.
    record(`gbrain MCP entry in openclaw.json${gbrainNoteSuffix}`, gbrainGateSev, ["test"], mcpEntry === "True", "");

    // ─── 19b. gbrain ANTHROPIC_API_KEY architecture (Rule 35 EnvironmentFile) ──
    // Commit 2026-05-22 c9d3c5b1 migrated ANTHROPIC_API_KEY from inline
    // `Environment=ANTHROPIC_API_KEY=...` baked into the gbrain.service unit
    // to an `EnvironmentFile=-$HOME/.gbrain/.env` directive sourced from a
    // separate file (install-gbrain.sh Phase E5, lines 1166-1253). The OLD
    // inline architecture had a load-bearing bug: rotating
    // GBRAIN_ANTHROPIC_API_KEY in Vercel + pushing the new value via
    // stepEnvVarPush updated $HOME/.openclaw/.env but did NOT update the
    // gbrain.service unit — gbrain kept hitting Anthropic with the OLD key
    // until manual sed+restart healed it (~2.5 days drift observed
    // 2026-05-21 across the edge_city VMs).
    //
    // The NEW EnvironmentFile architecture sources the key from
    // $HOME/.gbrain/.env which IS updated by stepGbrainEnvSync + .env push.
    // Pre-existing edge VMs (vm-050, vm-922, vm-917 verified 2026-05-24)
    // are still on the OLD inline architecture and migrating via
    // stepGbrainEnvSync; the NEW bake MUST encode the NEW architecture
    // directly so fresh-from-snapshot VMs ship rotation-safe.
    //
    // These gates catch the regression: if install-gbrain.sh ever reverts
    // to inline-key emission, the snapshot ships broken rotation behavior.
    if (gbrainInstalled) {
      const gbrainUnitV2 = (await exec(c, `cat ~/.config/systemd/user/gbrain.service 2>/dev/null`)).stdout;
      const hasEnvFile = /EnvironmentFile\s*=-?\s*\$?\{?HOME\}?\/\.gbrain\/\.env/.test(gbrainUnitV2)
        || /EnvironmentFile\s*=-?\s*\/home\/openclaw\/\.gbrain\/\.env/.test(gbrainUnitV2);
      const hasInlineAnthropicKey = /^Environment\s*=\s*ANTHROPIC_API_KEY\s*=/m.test(gbrainUnitV2);
      record("gbrain.service uses EnvironmentFile architecture (Rule 35 / 2026-05-22 c9d3c5b1)",
        gbrainGateSev, ["bake", "test"], hasEnvFile,
        hasEnvFile ? "" : "gbrain.service missing EnvironmentFile=-$HOME/.gbrain/.env — rotation will silently fail (pre-c9d3c5b1 inline architecture)");
      record("gbrain.service has NO inline Environment=ANTHROPIC_API_KEY (legacy bug)",
        gbrainGateSev, ["bake", "test"], !hasInlineAnthropicKey,
        hasInlineAnthropicKey ? "inline Environment=ANTHROPIC_API_KEY found in gbrain.service — install-gbrain.sh regressed to pre-c9d3c5b1 architecture" : "");
      // $HOME/.gbrain/.env must exist + contain ANTHROPIC_API_KEY for the
      // EnvironmentFile directive to actually load the key. Optional `-`
      // prefix means missing-file boots gbrain without the key (embeds
      // will 401 instead of unit refusing to start) — so absence is a
      // real bug to surface, not a silent skip.
      const gbrainEnvProbe = (await exec(c, `test -f ~/.gbrain/.env && grep -c "^ANTHROPIC_API_KEY=sk-ant-" ~/.gbrain/.env 2>/dev/null || echo "no-file"`)).stdout.trim();
      record("~/.gbrain/.env present + contains ANTHROPIC_API_KEY=sk-ant- (Rule 35)",
        gbrainGateSev, ["bake", "test"], gbrainEnvProbe === "1",
        gbrainEnvProbe === "no-file"
          ? "~/.gbrain/.env file missing — EnvironmentFile directive will silently load nothing → embeds 401"
          : gbrainEnvProbe === "0"
            ? "~/.gbrain/.env present but no ANTHROPIC_API_KEY=sk-ant- line"
            : `count=${gbrainEnvProbe}`);
    }

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

      // TasksMax applied at runtime (v120: infinity, not 120)
      const tasksMaxRt = (await exec(c, `systemctl --user show openclaw-gateway -p TasksMax`)).stdout.trim();
      record("TasksMax=infinity applied at runtime (v120 — Chromium MCP burst protection)",
        "P0", ["test"], /TasksMax=infinity/i.test(tasksMaxRt), tasksMaxRt);

      // CDP wallet — per-VM backup wallet shipped 2026-05-24 (commit ab9d5dd4).
      // configureOpenClaw writes CDP_WALLET_ADDRESS to ~/.openclaw/.env at
      // assign time (lib/ssh.ts:6200-6202) when vm.cdp_wallet_address is set.
      // The /api/cron/provision-missing-cdp-wallets cron (every 30 min) is
      // the backfill safety net + DB↔disk drift fixup. Fresh-from-snapshot
      // VMs WITH a paying-user assignment should have this set within ~3 min
      // of configureOpenClaw. If it's missing on a test VM, either (a) the
      // /api/vm/assign path didn't mint CDP (env vars missing in Vercel,
      // CDP API down), or (b) the configureOpenClaw DB→disk write failed.
      // Both are bake-blocking surfaces.
      const cdpInEnv = (await exec(c, `grep -cE "^CDP_WALLET_ADDRESS=0x[a-fA-F0-9]{40}$" ~/.openclaw/.env 2>/dev/null || echo 0`)).stdout.trim();
      record("CDP_WALLET_ADDRESS in ~/.openclaw/.env (commit ab9d5dd4 backup-wallet)",
        "P0", ["test"], parseInt(cdpInEnv, 10) === 1,
        cdpInEnv === "0"
          ? "CDP_WALLET_ADDRESS missing from .env — paying user has no backup wallet when Bankr is in maintenance"
          : `count=${cdpInEnv}`);
    } else {
      // Gateway must be STOPPED on bake VM (we just stopped it during cleanup)
      const isActive = (await exec(c, `systemctl --user is-active openclaw-gateway 2>&1`)).stdout.trim();
      const okStates = ["inactive", "failed", "deactivating"];
      record("gateway stopped (bake mode)", "P1", ["bake"], okStates.includes(isActive), `state=${isActive}`);
    }

    // ─── 21. Config keys (v95 manifest — all 37 entries per map §6) ────────
    // Source of truth: docs/cloud-init-implementation-map.md §6 and
    // lib/vm-manifest.ts:1131-1352 (configSettings block).
    // The pre-2026-05-13 version of this validation checked only 14 keys —
    // bake-readiness audit identified 23 missing checks including 11 P0
    // (without which fleet behavior silently breaks). All 37 below.
    const expectKeys: Array<{ key: string; want: string; severity: Severity }> = [
      // ── P0 — missing/wrong = silent fleet failure ────────────────────────
      { key: "tools.exec.security", want: "full", severity: "P0" },                      // exec tool fails closed
      { key: "tools.exec.ask", want: "off", severity: "P0" },                            // agent stalls waiting for approval
      { key: "agents.defaults.sandbox.mode", want: "off", severity: "P0" },              // gateway needs Docker without this
      { key: "gateway.http.endpoints.chatCompletions.enabled", want: "true", severity: "P0" }, // OpenAI-compat endpoint
      { key: "discovery.mdns.mode", want: "off", severity: "P0" },                       // CIAO SIGTERM race (v71)
      { key: "session.maintenance.mode", want: "enforce", severity: "P0" },              // session pruning hard, not warn
      { key: "agents.defaults.heartbeat.every", want: "3h", severity: "P0" },            // heartbeat cadence
      { key: "agents.defaults.heartbeat.session", want: "heartbeat", severity: "P0" },   // isolate heartbeats (v41)
      { key: "agents.defaults.compaction.mode", want: "safeguard", severity: "P0" },     // compaction policy
      { key: "agents.defaults.compaction.reserveTokensFloor", want: "35000", severity: "P0" },
      { key: "commands.useAccessGroups", want: "false", severity: "P0" },                // agents callable without group gate
      // v112 (2026-05-21): bumped 300 → 1800 (30 min). Per Cooper's
      // changelog entry at lib/vm-manifest.ts:1614: "simple is better than
      // clever — 1800 covers everything OpenAI can throw at us." OpenAI's
      // gpt-5.5-pro server-side max is 10 min; 30 min is the generous
      // client-side ceiling. Per-request budgets via in-flight manifest
      // deferred to Phase 3.
      { key: "agents.defaults.timeoutSeconds", want: "1800", severity: "P0" },           // v112 (was "300" pre-v112)
      { key: "agents.defaults.bootstrapMaxChars", want: "40000", severity: "P0" },       // v92
      { key: "agents.defaults.compaction.maxActiveTranscriptBytes", want: "150000", severity: "P0" }, // v90 Layer 1
      { key: "channels.telegram.streaming.mode", want: "partial", severity: "P0" },      // v95
      { key: "channels.telegram.streaming.preview.toolProgress", want: "false", severity: "P0" }, // v95 leak guard
      { key: "channels.telegram.streaming.preview.chunk.minChars", want: "30", severity: "P0" },
      { key: "channels.telegram.streaming.preview.chunk.maxChars", want: "800", severity: "P0" }, // v95 Layer 2
      { key: "channels.telegram.streaming.preview.chunk.breakPreference", want: "sentence", severity: "P0" },
      { key: "messages.ackReactionScope", want: "all", severity: "P0" },                 // v95 Layer 1
      { key: "messages.ackReaction", want: "👀", severity: "P0" },
      { key: "messages.removeAckAfterReply", want: "false", severity: "P0" },
      // v119 (2026-05-23): EMERGENCY REVERT — was "true" in v95 spec but
      // upstream OpenClaw 2026.4.26 status-reaction emoji-rotation produced
      // a fleet-visible reaction-storm (👀→🤔→🔍→✍️→✅ cycling rapidly on
      // each turn). Disabled until upstream fix lands. The 👀 ack reaction
      // (messages.ackReaction above) stays — that's a single static emoji.
      { key: "messages.statusReactions.enabled", want: "false", severity: "P0" },
      { key: "session.reset.mode", want: "idle", severity: "P0" },                       // v41 — prevents 4 AM wipe
      { key: "session.reset.idleMinutes", want: "10080", severity: "P0" },               // 7-day idle
      // v118 (2026-05-23): typing keepalive — fires signalRunStart at run-begin
      // BEFORE the LLM call so Telegram shows "typing..." continuously while
      // gpt-5.5 reasons (3-30 min latency). agents.defaults.* are closure-
      // captured at agent-run init (Rule 32), so RESTART_REQUIRED_CONFIG_
      // PREFIXES was extended in v120 to include "agents.defaults." —
      // reconciler now restarts gateway when these change.
      { key: "agents.defaults.typingMode", want: "instant", severity: "P0" },            // v118 typing keepalive
      { key: "agents.defaults.typingIntervalSeconds", want: "3", severity: "P0" },       // v118 typing keepalive cadence
      // ── P1 — operational correctness ─────────────────────────────────────
      { key: "agents.defaults.compaction.memoryFlush.enabled", want: "true", severity: "P1" },
      { key: "agents.defaults.compaction.memoryFlush.softThresholdTokens", want: "8000", severity: "P1" },
      { key: "agents.defaults.compaction.recentTurnsPreserve", want: "10", severity: "P1" },
      { key: "agents.defaults.compaction.qualityGuard.enabled", want: "true", severity: "P1" },
      { key: "agents.defaults.compaction.qualityGuard.maxRetries", want: "2", severity: "P1" },
      { key: "agents.defaults.compaction.notifyUser", want: "true", severity: "P1" },
      { key: "agents.defaults.compaction.truncateAfterCompaction", want: "true", severity: "P1" },
      { key: "agents.defaults.memorySearch.enabled", want: "true", severity: "P1" },
      { key: "skills.limits.maxSkillsPromptChars", want: "500000", severity: "P1" },     // silent truncation if lower
      { key: "commands.restart", want: "true", severity: "P1" },
      { key: "channels.telegram.groupPolicy", want: "open", severity: "P1" },            // group chat usability
    ];
    for (const { key, want, severity } of expectKeys) {
      const got = (await exec(c, `source ~/.nvm/nvm.sh 2>/dev/null && openclaw config get "${key}" 2>&1`)).stdout.trim();
      const pass = got === want;
      record(`config ${key}=${want}`, severity, ["bake", "test"], pass, pass ? "" : `got=${got}`);
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
    // @bankr/cli npm pin (v62 — 0.3.1 minimum).
    // semverGte handles >9-patch versions correctly; previous regex was
    // brittle (would have falsely failed at 0.3.10+).
    const bankrCliV = (await exec(c, `source ~/.nvm/nvm.sh 2>/dev/null && npm ls -g --depth=0 @bankr/cli 2>/dev/null | grep -oE '@bankr/cli@[0-9]+\\.[0-9]+\\.[0-9]+'`)).stdout.trim();
    record("@bankr/cli pinned to 0.3.1+", "P1", ["bake", "test"],
      semverGte(bankrCliV, "0.3.1"),
      `installed=${bankrCliV || "<missing>"}`);

    // INSTACLAW_BANKR_PATCH_V1 marker in the bankr skill's SKILL.md (overlay applied)
    const bankrPatch = (await exec(c, `grep -c INSTACLAW_BANKR_PATCH_V1 ~/.openclaw/skills/bankr/bankr/SKILL.md 2>/dev/null || echo 0`)).stdout.trim();
    record("bankr SKILL.md has INSTACLAW_BANKR_PATCH_V1 overlay", "P2", ["bake", "test"], parseInt(bankrPatch, 10) >= 1, "");

    // Consensus skill — UNIVERSAL post-2026-05-04
    const consensusPresent = (await exec(c, `test -d ~/.openclaw/skills/consensus-2026 && echo Y || echo N`)).stdout.trim() === "Y";
    record("consensus-2026 skill cloned (universal)", "P1", ["bake", "test"], consensusPresent, "");

    // ─── 24. sudoers ───────────────────────────────────────────────────────
    const sudoers = (await exec(c, `sudo cat /etc/sudoers.d/openclaw 2>/dev/null`)).stdout;
    record("sudoers: openclaw NOPASSWD", "P0", ["bake", "test"], /openclaw\s+ALL=\(ALL\)\s+NOPASSWD/.test(sudoers), "");

    // ─── 25. cloud-init state cleared (so re-runs on new VM) ───────────────
    const cloudInstance = (await exec(c, `sudo ls /var/lib/cloud/instances 2>/dev/null | wc -l`)).stdout.trim();
    record("cloud-init instances dir cleared", "P1", ["bake"], cloudInstance === "0", `${cloudInstance} dirs`);

    // ─── 26. snapshot-bake-mode marker should NOT be present (cleanup removes it) ─
    await assertAbsent(c, "snapshot-bake-mode marker removed", "P2", ["bake"], "$HOME/.snapshot-bake-mode");

    // ─── 27. SNAPSHOT_BAKED gap-fill checks (per cloud-init-snapshot-bake-requirements-2026-05-13.md) ─
    // The cloud-init builder classifies these as SNAPSHOT_BAKED and skips deploying them at
    // first boot. If the snapshot is missing any, every new VM provisioned via cloud-init
    // starts broken until the reconciler catches up. The 46-check audit confirmed these
    // were gaps in the pre-2026-05-13 validation.

    // 27a — workspace files: full inventory per inventory §1 (5 fleet-wide files)
    for (const f of ["QUICK-REFERENCE.md", "TOOLS.md", "EARN.md"]) {
      const present = (await exec(c, `test -f ~/.openclaw/workspace/${f}`)).code === 0;
      record(`workspace/${f} present (SNAPSHOT_BAKED)`, "P1", ["bake", "test"], present, "");
    }

    // 27b — HEARTBEAT.md at agents/main/agent/ (inventory §2 — Cooper-flagged uncertainty)
    record("agents/main/agent/HEARTBEAT.md present", "P1", ["bake", "test"],
      (await exec(c, `test -f ~/.openclaw/agents/main/agent/HEARTBEAT.md`)).code === 0, "");
    const heartbeatContent = (await exec(c, `head -c 100 ~/.openclaw/agents/main/agent/HEARTBEAT.md 2>/dev/null`)).stdout;
    record("HEARTBEAT.md content begins with canonical heading", "P1", ["bake", "test"],
      /HEARTBEAT\.md\s*[—-]\s*Proactive Work Cycle/.test(heartbeatContent), heartbeatContent.slice(0, 60));

    // 27c — exec-approvals.json with security=full (inventory §12; gateway exec gates on this)
    // Per-VM file: created by configureOpenClaw at user assignment, and
    // explicitly wiped by _prebake-cleanup.sh (line 219-220) for security.
    // Bake VM has NO real user → file absent BY DESIGN in bake mode.
    // Bake attempt 19 (2026-05-25) failed P0 here — shouldn't.
    const execApprovals = (await exec(c, `cat ~/.openclaw/exec-approvals.json 2>/dev/null`)).stdout;
    record("exec-approvals.json present + security=full", "P0", ["test"],
      /"security"\s*:\s*"full"/.test(execApprovals), execApprovals.slice(0, 80));
    record("exec-approvals.json ask=off", "P1", ["test"],
      /"ask"\s*:\s*"off"/.test(execApprovals), "");

    // 27d — .openclaw-pinned-version matches OpenClaw version (inventory §12)
    const pinnedVerFile = (await exec(c, `cat ~/.openclaw/.openclaw-pinned-version 2>/dev/null`)).stdout.trim();
    record(".openclaw-pinned-version contents match installed OpenClaw", "P1", ["bake", "test"],
      pinnedVerFile.length > 0 && openclawV.includes(pinnedVerFile), `pinned=${pinnedVerFile} installed=${openclawV}`);

    // 27e — apt binaries that skills + dispatch require (inventory §7)
    for (const bin of ["ffmpeg", "jq", "xvfb-run", "xdotool", "x11vnc", "websockify",
                       "imagemagick", "openbox", "socat", "nc", "caddy", "fail2ban-client"]) {
      const present = (await exec(c, `which ${bin}`)).code === 0;
      // imagemagick CLI is `convert`/`magick`; xvfb-run is the wrapper; nc covers netcat-openbsd
      record(`apt binary: ${bin} on PATH`, "P1", ["bake", "test"], present, "");
    }
    // chromium-browser at the canonical path (inventory §7).
    // PER-MODE CONTRACT (corrected 2026-05-25 post-self-audit):
    //   bake/soak VMs: provisioned via createInstance() with NO user-data,
    //     so cloud-init's setup.sh never runs → no `pip install crawlee
    //     [playwright]` → no chromium symlink. Absent BY DESIGN. P2.
    //   real production VM: cloud-init's setup.sh installs chromium-1223
    //     and symlinks to /usr/local/bin/. Confirmed on vm-1026/27/28 (all
    //     from current snapshot 38977398). Operator running --mode=test
    //     against a real customer VM MUST flag a missing chromium — every
    //     browser-using skill (instagram-automation, frontier, computer-
    //     dispatch, competitive-intelligence) silently breaks otherwise. P0.
    const chromiumSymlinkOk = (await exec(c, `test -x /usr/local/bin/chromium-browser`)).code === 0;
    record("chromium-browser at /usr/local/bin/ (bake/soak — absent by design)",
      "P2", ["bake"], chromiumSymlinkOk, "");
    record("chromium-browser at /usr/local/bin/ (real VM via cloud-init setup.sh)",
      "P0", ["test"], chromiumSymlinkOk, "");
    // node_exporter binary present (reconciler stepNodeExporter heals if absent — P2 here)
    record("node_exporter binary on PATH", "P2", ["bake", "test"],
      (await exec(c, `which node_exporter`)).code === 0, "");

    // 27f — python3 packages (inventory §8) — import-test instead of `pip list` (pip can be slow)
    const pyImports = [
      { pkg: "openai", severity: "P1" as Severity },
      { pkg: "web3", severity: "P1" as Severity },
      { pkg: "py_clob_client", severity: "P1" as Severity },     // module name; pkg is py-clob-client
      { pkg: "solders", severity: "P1" as Severity },
      { pkg: "crawlee", severity: "P1" as Severity },
      { pkg: "eth_account", severity: "P1" as Severity },        // module name
    ];
    for (const { pkg, severity } of pyImports) {
      const probe = await exec(c, `python3 -c "import ${pkg}" 2>&1`);
      record(`python3 -c 'import ${pkg}' succeeds`, severity, ["bake", "test"], probe.code === 0,
        probe.code === 0 ? "" : probe.stderr.slice(-150));
    }

    // 27g — @worldcoin/agentkit-cli pin (inventory §9). Same semverGte fix
    // as the bankr-CLI check above.
    const agentkitV = (await exec(c, `source ~/.nvm/nvm.sh 2>/dev/null && npm ls -g --depth=0 @worldcoin/agentkit-cli 2>/dev/null | grep -oE '@worldcoin/agentkit-cli@[0-9]+\\.[0-9]+\\.[0-9]+'`)).stdout.trim();
    record("@worldcoin/agentkit-cli pinned to 0.1.3+", "P1", ["bake", "test"],
      semverGte(agentkitV, "0.1.3"),
      `installed=${agentkitV || "<missing>"}`);

    // 27h — mcporter present (inventory §9)
    const mcporterPath = (await exec(c, `source ~/.nvm/nvm.sh 2>/dev/null && which mcporter`)).stdout.trim();
    record("mcporter installed (npm global via NVM)", "P2", ["bake", "test"],
      mcporterPath.length > 0, mcporterPath || "<missing>");

    // 27i — loginctl linger enabled for openclaw user (inventory §13 — user systemd services need this)
    const linger = (await exec(c, `loginctl show-user openclaw 2>/dev/null | grep -E 'Linger='`)).stdout.trim();
    record("loginctl linger enabled for openclaw user", "P1", ["bake", "test"],
      /Linger=yes/.test(linger), linger || "<no Linger line>");

    // 27j — NVM default node points at the pinned version (inventory §13)
    // Label + regex track NODE_PINNED_VERSION so a future Node bump doesn't
    // silently mislabel. Escape regex specials (the literal dots in the
    // version string) so the test is anchored, not a loose match.
    const nvmDefault = (await exec(c, `cat ~/.nvm/alias/default 2>/dev/null`)).stdout.trim();
    const nodePinEsc = NODE_PINNED_VERSION.replace(/\./g, "\\.");
    const nvmRe = new RegExp(`^v?${nodePinEsc}$`);
    record(`NVM default alias points at v${NODE_PINNED_VERSION}`, "P1", ["bake", "test"],
      nvmRe.test(nvmDefault), `alias=${nvmDefault}`);

    // 27j.1 — crontab Node-path drift detection (silent-failure class — discovered
    // 2026-05-24 ultrathink sweep). The `openclaw memory index` cron entry was
    // installed with a HARDCODED Node binary path at the time of provision.
    // When NODE_PINNED_VERSION bumped from v22.22.0 → v22.22.2, NOTHING rewrites
    // the crontab. The cron silently runs `/.../v22.22.0/bin/openclaw memory
    // index` every 4 AM, the binary doesn't exist, cron exits non-zero into
    // /tmp/memory-index.log, agent's memory index never updates.
    // Confirmed silent failure on vm-1035 (pool VM from v113 snapshot) 2026-05-24.
    // Validator gates: the cron line MUST reference the current Node version.
    const memoryIndexCron = (await exec(c, `crontab -l 2>/dev/null | grep "openclaw memory index"`)).stdout.trim();
    if (memoryIndexCron.length > 0) {
      // Two valid cron forms:
      //   (a) Dynamic NVM-source form (canonical per vm-manifest cronJobs):
      //       `. /home/openclaw/.nvm/nvm.sh && openclaw memory index`
      //       — version-resilient, survives Node bumps.
      //   (b) Hardcoded-Node-path form (legacy, from older snapshots):
      //       `/home/openclaw/.nvm/versions/node/vX.Y.Z/bin/openclaw memory index`
      //       — stale on Node bump unless cron is rewritten.
      // The pre-existing v113 snapshot ships with form (b) referencing v22.22.0
      // (silent daily failure). _prebake-cleanup.sh now rewrites form (b) → (a)
      // during every bake. The validator accepts BOTH and only flags stale (b).
      const isDynamicForm = /\.\s*\/home\/openclaw\/\.nvm\/nvm\.sh\s*&&\s*openclaw\s+memory\s+index/.test(memoryIndexCron);
      const cronNodeVerMatch = memoryIndexCron.match(/nvm\/versions\/node\/v([\d.]+)\/bin/);
      if (isDynamicForm) {
        record("crontab `openclaw memory index` uses dynamic NVM sourcing",
          "P0", ["bake", "test"], true,
          "form: `. ~/.nvm/nvm.sh && openclaw memory index` — version-resilient");
      } else if (cronNodeVerMatch) {
        const cronNodeVer = cronNodeVerMatch[1];
        const cronNodeMatchesCurrent = cronNodeVer === nodeV.replace(/^v/, "");
        record("crontab `openclaw memory index` Node path matches current Node version",
          "P0", ["bake", "test"], cronNodeMatchesCurrent,
          cronNodeMatchesCurrent ? "" :
            `cron uses v${cronNodeVer} but current Node is ${nodeV} — daily 4AM memory index silently fails (rewrite to dynamic form via _prebake-cleanup)`);
      } else {
        record("crontab `openclaw memory index` has unknown shape",
          "P0", ["bake", "test"], false, `entry: ${memoryIndexCron.slice(0, 100)}`);
      }
    } else {
      record("crontab `openclaw memory index` entry present", "P1", ["bake", "test"],
        false, "no openclaw memory index entry in crontab");
    }

    // 27j.2 — /etc/sudoers.d/openclaw — passwordless sudo for the openclaw user.
    // Load-bearing for many reconciler steps: stepUfwRules (sudo ufw allow),
    // stepNodeExporter (sudo systemctl restart, sudo tee drop-in), apt operations,
    // /var/lib/node_exporter writes. NOT in vm-manifest:files[]. NOT written by
    // configureOpenClaw. Provisioned during cloud-init / bake recipe.
    // If absent → every sudo-requiring reconciler step silently fails.
    const sudoersHas = (await exec(c, `sudo -n test -f /etc/sudoers.d/openclaw && echo Y || echo N`)).stdout.trim();
    record("/etc/sudoers.d/openclaw present (passwordless sudo for openclaw user)",
      "P0", ["bake", "test"], sudoersHas === "Y",
      sudoersHas === "Y" ? "" : "/etc/sudoers.d/openclaw missing — sudo-requiring reconciler steps will silently fail");

    // 27j.3 — ufw rule 22/tcp (SSH). The 9100/tcp + 8765/tcp gates exist
    // (stepUfwRules + ensureUfwAllow) but the SSH-22 rule is set during the
    // bake recipe and never re-applied. If the snapshot encodes a ufw config
    // that ALLOWS by default and 22/tcp is missing → first ufw enforcement
    // tick kicks the operator out of SSH → unreachable VM. P0 — catastrophic.
    const ufw22 = (await exec(c, `sudo -n ufw status 2>/dev/null | grep -cE "^22/tcp"`)).stdout.trim();
    record("ufw 22/tcp (SSH) rule present (snapshot-only — no reconciler heal)",
      "P0", ["bake", "test"], parseInt(ufw22, 10) >= 1,
      ufw22 === "0" ? "ufw 22/tcp ALLOW rule MISSING — first ufw enforcement tick will block SSH forever" : "");

    // 27j.4 — /usr/local/bin/chromium-browser executable.
    // ORIGINAL CONTRACT (deprecated): "Custom Chromium binary installed during
    // bake. NOT in apt, NOT in manifest, NOT in configureOpenClaw."
    // ACTUAL CONTRACT (confirmed 2026-05-25 by SSH-probing vm-1026/27/28 —
    // all from current snapshot 38977398): Chromium gets installed at
    // FIRST-REAL-BOOT by cloud-init's setup.sh via
    // `pip install crawlee[playwright]==1.5.0` → playwright auto-downloads
    // chromium-1223 → symlink to /usr/local/bin/. NOT a snapshot-only install.
    //
    // The bake VM provisions WITHOUT user-data (no cloud-init/setup.sh path),
    // so the symlink is absent on the bake VM by-design. Same for soak.
    // Demote to P2 in both modes, matching the line-1042 sibling check.
    // P1 followup: integrate playwright install into the bake (heavy:
    // 250MB+ download) OR pass user-data to soak-provision so cloud-init
    // runs and installs chromium-browser. Until then, the snapshot ships
    // without chromium, and real-VM provisions install it via cloud-init.
    const chromiumVer = (await exec(c, `/usr/local/bin/chromium-browser --version 2>&1 | head -1`)).stdout.trim();
    const chromiumExecutable = /Chrome|Chromium/.test(chromiumVer) && /\d+\.\d+/.test(chromiumVer);
    // Same per-mode contract as the line-1076 sibling: P2 on bake/soak
    // (cloud-init/setup.sh path not run; chromium absent by design),
    // P0 on real-VM operator validation (real production VM MUST have it).
    record("/usr/local/bin/chromium-browser executable (bake/soak — absent by design)",
      "P2", ["bake"], chromiumExecutable,
      chromiumVer || "expected absent (installed via cloud-init/setup.sh on real provisions)");
    record("/usr/local/bin/chromium-browser executable (real VM via cloud-init setup.sh)",
      "P0", ["test"], chromiumExecutable,
      chromiumVer || "chromium-browser missing or non-executable");

    // 27j.5 — /usr/local/bin/openclaw-config-merge + openclaw-config-watchdog.
    // Custom shell scripts written at provision time (cloud-init / setup.sh)
    // or at configure time. Used by openclaw-config-watchdog cron entry
    // (every 5 min via sudo). If missing → config-watchdog cron entry calls
    // a missing binary → silent cron failure.
    for (const bin of ["openclaw-config-merge", "openclaw-config-watchdog"]) {
      const binProbe = (await exec(c, `test -x /usr/local/bin/${bin} && echo Y || echo N`)).stdout.trim();
      record(`/usr/local/bin/${bin} present + executable`,
        "P1", ["bake", "test"], binProbe === "Y",
        binProbe === "Y" ? "" : `/usr/local/bin/${bin} missing — referenced by cron / reconciler paths`);
    }

    // 27k — Rule 23 sentinels for additional scripts (inventory §3)
    // Per the inventory, these scripts have load-bearing sentinels too. The strip-thinking
    // sentinels are checked above (line ~357); these are the other safety-critical ones.
    const ADDITIONAL_SENTINELS: Array<{ script: string; sentinels: string[]; severity: Severity }> = [
      { script: "skill-integrity-check.sh", sentinels: ["verify_or_heal_git_skill", "SKILL_RECOVERED"], severity: "P0" }, // Rule 24
      { script: "ack-watchdog.py", sentinels: ["def is_turn_stalled", "ACK_WATCHDOG_SLOW_WARNING"], severity: "P0" },     // v95
    ];
    for (const { script, sentinels, severity } of ADDITIONAL_SENTINELS) {
      for (const sent of sentinels) {
        const found = (await exec(c, `grep -c -F ${JSON.stringify(sent)} ~/.openclaw/scripts/${script} 2>/dev/null`)).stdout.trim();
        record(`${script} contains '${sent}'`, severity, ["bake", "test"], parseInt(found, 10) >= 1, `${found} matches`);
      }
    }

    // 27l — check-skill-updates cron entry (inventory §11) — P2 because nothing breaks
    // if absent; check-skill-updates is a soft daily refresh
    record("cron entry: check-skill-updates", "P2", ["bake", "test"],
      /check-skill-updates\.sh/.test(cron), "");

    // ─── 28. Caddy /vnc/* reverse-proxy block (audit P1 follow-up) ───────
    // Map §9.9 — without this, live desktop viewer is unreachable from public URL.
    const caddyfile = (await exec(c, `sudo cat /etc/caddy/Caddyfile 2>/dev/null`)).stdout;
    const caddyVncOk = /handle\s+\/vnc\/?\*/.test(caddyfile) && /reverse_proxy\s+(localhost|127\.0\.0\.1):6080/.test(caddyfile);
    record("Caddyfile has /vnc/* reverse_proxy to :6080", "P1", ["bake", "test"], caddyVncOk,
      caddyVncOk ? "" : "Caddyfile missing /vnc/* handle block");
    // Caddy service active (the file alone is useless if Caddy isn't running)
    const caddyActive = (await exec(c, `sudo systemctl is-active caddy 2>&1`)).stdout.trim();
    record("caddy.service active", "P1", ["bake", "test"], caddyActive === "active", `state=${caddyActive}`);

    // ─── 30. Recent-incident gates (2026-05-13 → 2026-05-18) ─────────────
    // Every check below traces to a manifest version bump or production
    // incident in the past 5 days. The bake VM MUST satisfy all of these
    // OR the resulting snapshot ships a known-broken state to every new
    // VM provisioned from it.

    // 30a — vm-748 root cause (2026-05-18). NodeSource apt repo + nodejs
    // auto-upgrade to v24 caused 7+ day silent customer-down. Both must be
    // defended against permanently.
    const nodesourcePresent = (await exec(c, `test -f /etc/apt/sources.list.d/nodesource.sources && echo Y || echo N`)).stdout.trim();
    record("NodeSource apt repo ABSENT (vm-748 root cause)", "P0", ["bake", "test"],
      nodesourcePresent === "N", nodesourcePresent === "Y" ? "/etc/apt/sources.list.d/nodesource.sources still present — apt unattended-upgrade can install Node v24+" : "");

    const nodejsHeld = (await exec(c, `sudo apt-mark showhold 2>/dev/null | grep -c '^nodejs$'`)).stdout.trim();
    record("nodejs apt-marked hold (vm-748 defense-in-depth)", "P1", ["bake", "test"],
      nodejsHeld === "1", `apt-mark count=${nodejsHeld}`);

    // 30b — Gateway ExecStart MUST use NVM Node path, not /usr/bin/node.
    // vm-748 had ExecStart=/usr/bin/node and got v24 via NodeSource apt upgrade,
    // which couldn't load modules built for v22. The dispatch-server check at
    // §3b doesn't cover the gateway unit itself.
    const gatewayUnit = (await exec(c, `systemctl --user cat openclaw-gateway 2>/dev/null | grep -m1 '^ExecStart='`)).stdout.trim();
    record("gateway ExecStart uses NVM Node path (not /usr/bin/node)", "P0", ["bake", "test"],
      /ExecStart=\/home\/openclaw\/\.nvm\/versions\/node\/v22/.test(gatewayUnit),
      `got: ${gatewayUnit.slice(0, 120)}`);

    // 30c — v103 (commit 944068db, stepUfwRules) + v104 (commit 0ab38404,
    // ensureUfwAllow helper closing Rule 57 anti-pattern in dispatch):
    // ufw should have BOTH 9100/tcp (node_exporter) AND 8765/tcp (dispatch).
    // The 2026-05-15 IR incident: 8 fleet VMs had node_exporter listening but
    // no ufw rule — Prometheus scraped zero metrics for days. The bake VM
    // should have both rules on disk so new provisions don't depend on
    // the reconciler's first-tick to install them.
    const ufwStatus = (await exec(c, `sudo ufw status 2>&1`)).stdout;
    const ufwAvailable = !/command not found/.test(ufwStatus);
    if (ufwAvailable) {
      record("v103: ufw allow 9100/tcp rule present (stepUfwRules artifact)", "P0", ["bake", "test"],
        /9100\/tcp/.test(ufwStatus), `ufw status output: ${ufwStatus.slice(0, 100)}`);
      record("v104: ufw allow 8765/tcp rule present (dispatch ensureUfwAllow)", "P0", ["bake", "test"],
        /8765\/tcp/.test(ufwStatus), `ufw status output: ${ufwStatus.slice(0, 100)}`);
    } else {
      record("v103+v104: ufw installed (required for stepUfwRules + ensureUfwAllow)", "P0", ["bake", "test"], false,
        "ufw command not found");
    }

    // 30d — v101 (2026-05-16, commit 48af5075): startup orphan tool_use repair.
    // systemd ExecStartPre must invoke strip-thinking.py --startup-repair-active.
    const execStartPre = (await exec(c, `systemctl --user show openclaw-gateway --property=ExecStartPre 2>/dev/null`)).stdout.trim();
    record("v101: ExecStartPre includes --startup-repair-active",
      "P0", ["bake", "test"],
      /startup-repair-active/.test(execStartPre),
      execStartPre.slice(0, 150));

    // 30e — v102 (2026-05-17, commit ea026a6a): GBRAIN_MEMORY_PROTOCOL_V1
    // in AGENTS.md. Without this, Edge attendees see hallucinated saves
    // (Rule 28). Open + close markers should both be present.
    const agentsMarkerCount = parseInt(
      (await exec(c, `grep -c GBRAIN_MEMORY_PROTOCOL_V1 ~/.openclaw/workspace/AGENTS.md 2>/dev/null || echo 0`)).stdout.trim() || "0",
      10,
    );
    record("v102: AGENTS.md contains GBRAIN_MEMORY_PROTOCOL_V1 markers (open+close)",
      "P0", ["bake", "test"],
      agentsMarkerCount >= 2, `markers=${agentsMarkerCount} (expected ≥2)`);

    // v102 Rule 28 anti-hallucination directive
    const rule28Present = (await exec(c, `grep -c "MUST call .*gbrain__put_page.* BEFORE responding" ~/.openclaw/workspace/AGENTS.md 2>/dev/null || echo 0`)).stdout.trim();
    record("v102: AGENTS.md contains Rule 28 anti-hallucination directive",
      "P1", ["bake", "test"],
      parseInt(rule28Present, 10) >= 1, `count=${rule28Present}`);

    // 30f — Rule 54 (2026-05-16): gbrain.service KillSignal=SIGKILL.
    // SIGTERM corrupts PGLite (empirically verified on vm-050 2026-05-16).
    // install-gbrain.sh Phase E5 writes KillSignal=SIGKILL; if missing, any
    // operator-driven systemctl stop/restart corrupts the PGLite data dir.
    const gbrainUnit = (await exec(c, `cat ~/.config/systemd/user/gbrain.service 2>/dev/null`)).stdout;
    if (gbrainUnit.length > 0) {
      record("Rule 54: gbrain.service KillSignal=SIGKILL",
        "P0", ["bake", "test"],
        /^KillSignal\s*=\s*SIGKILL/m.test(gbrainUnit),
        "KillSignal=SIGTERM or absent — SIGTERM corrupts PGLite (Rule 54)");
    } else {
      // gbrain not installed (acceptable on non-edge_city bake) — skip
      record("Rule 54: gbrain.service unit present (skipped — gbrain not installed)",
        "P2", ["bake", "test"], true, "");
    }

    // 30g — v99 (2026-05-14): gateway-health-textfile artifacts.
    // gateway-health-textfile.sh feeds Prometheus's textfile_collector with
    // openclaw_gateway_up{}. Without it, the GatewayDown alert never fires.
    const ghtfScript = (await exec(c, `test -f ~/.openclaw/scripts/gateway-health-textfile.sh && echo Y || echo N`)).stdout.trim();
    record("v99: gateway-health-textfile.sh present", "P0", ["bake", "test"],
      ghtfScript === "Y", "missing — GatewayDown alert won't fire");
    const ghtfCron = (await exec(c, `crontab -l 2>/dev/null | grep -c gateway-health-textfile`)).stdout.trim();
    record("v99: gateway-health-textfile.sh cron entry present", "P0", ["bake", "test"],
      parseInt(ghtfCron, 10) >= 1, `count=${ghtfCron}`);
    const ghtfDir = (await exec(c, `test -d /var/lib/node_exporter/textfile_collector && echo Y || echo N`)).stdout.trim();
    record("v99: textfile_collector directory present", "P0", ["bake", "test"],
      ghtfDir === "Y", "/var/lib/node_exporter/textfile_collector missing");
    const ghtfDropIn = (await exec(c, `sudo test -f /etc/systemd/system/node_exporter.service.d/textfile.conf && echo Y || echo N`)).stdout.trim();
    record("v99: node_exporter textfile drop-in present", "P0", ["bake", "test"],
      ghtfDropIn === "Y", "drop-in missing — node_exporter won't read textfile dir");

    // 30h — Rule 45 (2026-05-14, commit eaf5617a): session-backup runaway fix.
    // The constants below are checked in the RULE23_SENTINELS array, but the
    // value matters too — if SESSION_BACKUP_MAX_PER_SESSION=999999 someone
    // disabled the cap. Check the actual values.
    const cooldownVal = (await exec(c, `grep -oE "SESSION_BACKUP_COOLDOWN_SEC\\s*=\\s*[0-9]+" ~/.openclaw/scripts/strip-thinking.py 2>/dev/null | head -1`)).stdout.trim();
    const capVal = (await exec(c, `grep -oE "SESSION_BACKUP_MAX_PER_SESSION\\s*=\\s*[0-9]+" ~/.openclaw/scripts/strip-thinking.py 2>/dev/null | head -1`)).stdout.trim();
    record("Rule 45: SESSION_BACKUP_COOLDOWN_SEC = 300", "P1", ["bake", "test"],
      /=\s*300\s*$/.test(cooldownVal), `got: ${cooldownVal || "missing"}`);
    record("Rule 45: SESSION_BACKUP_MAX_PER_SESSION = 50", "P1", ["bake", "test"],
      /=\s*50\s*$/.test(capVal), `got: ${capVal || "missing"}`);

    // 30i — Rule 47 (2026-05-14): file-drift cron exists in Vercel cron config.
    // This is fleet-level not on-VM, so we can't check it here directly. The
    // pre-bake-check covers the fleet side. (Documented for cross-reference.)

    // 30j — Rule 49 (2026-05-14): partner-secrets verifier — verified by
    // _pre-bake-check.ts before bake (fleet-level), not on-VM.

    // 30k — PGLite pg_control staleness (gbrain terminal finding, 2026-05-18).
    // Every gbrain sidecar running for more than a few hours leaves stale
    // pg_control on disk. If gbrain dies (SIGKILL, crash, VM reboot) WITHOUT
    // a prior explicit CHECKPOINT, the next cold-start panics with "invalid
    // resource manager ID in checkpoint record."
    //
    // Bake-mode check: for a properly-baked snapshot, EITHER
    //   (a) brain.pglite is absent/empty (gbrain never started on bake VM), OR
    //   (b) brain.pglite has a recovery.signal that proves a clean checkpoint
    //       (file present means PGLite would replay on next start — bad)
    //       — actually inverted: recovery.signal ABSENT means clean shutdown.
    //   (c) pg_control file present AND mtime within last 60s of last close
    //       (recent CHECKPOINT before snapshot).
    //
    // Simplest robust check: WAL files in pg_wal/ should not exceed 2 segments
    // (each segment is 16 MB by default); excess WAL = unflushed state.
    const pgliteDir = (await exec(c, `test -d ~/.gbrain/brain.pglite && echo Y || echo N`)).stdout.trim();
    if (pgliteDir === "Y") {
      // recovery.signal absent = last shutdown was clean
      const recoverySignal = (await exec(c, `test -f ~/.gbrain/brain.pglite/recovery.signal && echo PRESENT || echo absent`)).stdout.trim();
      record("PGLite recovery.signal absent (clean shutdown — gbrain term finding 2026-05-18)",
        "P0", ["bake"],
        recoverySignal === "absent",
        recoverySignal === "PRESENT" ? "recovery.signal present — pg_control stale, next start will PANIC" : "");

      // WAL segments — too many = unflushed state. Each segment defaults to 16 MB.
      // After a CHECKPOINT, old segments are recycled. >2 segments = no recent CHECKPOINT.
      const walSegs = parseInt(
        (await exec(c, `ls ~/.gbrain/brain.pglite/pg_wal/ 2>/dev/null | grep -cE '^[0-9A-F]{24}$' || echo 0`)).stdout.trim() || "0",
        10,
      );
      record("PGLite WAL ≤ 2 segments (recent CHECKPOINT before bake)",
        "P0", ["bake"],
        walSegs <= 2, `${walSegs} WAL segments — run CHECKPOINT before final close to compact`);
    } else {
      record("PGLite brain.pglite absent (gbrain never started on bake VM — acceptable for non-edge_city bake)",
        "P2", ["bake"], true, "");
    }

    // 30k.2 — pglite-checkpoint.sh script + cron + ExecStop hook
    // (commit 3f9b3015 — installed by install-gbrain.sh Phase I).
    // Without these, a fresh VM from the snapshot has no scheduled CHECKPOINT
    // and no ExecStop CHECKPOINT — pg_control will stale within hours and
    // any SIGKILL/OOM/reboot panics PGLite (mass-corruption risk per Rule 54).
    // The bake VM should have all three present so the snapshot ships with
    // the protection mechanism baked in.
    // Partner-gate per Rule 54 / Gate 7 (2026-05-24): pglite-checkpoint is
    // installed by install-gbrain.sh Phase I — only runs on edge_city VMs
    // at fleet time, BUT runs on every bake VM via §3.4. So bake-mode is
    // always P0; test-mode downgrades to P2 if gbrain absent (same rationale
    // as the gbrainGateSev guard at §19).
    const checkpointScript = (await exec(c, `test -x ~/.openclaw/scripts/pglite-checkpoint.sh && echo Y || echo N`)).stdout.trim();
    record(`PGLite CHECKPOINT script present + executable (Rule 54)${gbrainNoteSuffix}`,
      gbrainGateSev, ["bake", "test"],
      checkpointScript === "Y",
      checkpointScript === "Y" ? "" : "~/.openclaw/scripts/pglite-checkpoint.sh missing or non-executable");

    const checkpointCron = parseInt(
      (await exec(c, `crontab -l 2>/dev/null | grep -c "pglite-checkpoint.sh"`)).stdout.trim() || "0",
      10,
    );
    record(`PGLite CHECKPOINT cron entry installed (every 30 min, Rule 54)${gbrainNoteSuffix}`,
      gbrainGateSev, ["bake", "test"],
      checkpointCron >= 1,
      `crontab matches: ${checkpointCron} (expected ≥1)`);

    const gbrainDropIns = (await exec(c, `cat ~/.config/systemd/user/gbrain.service.d/*.conf 2>/dev/null; cat ~/.config/systemd/user/gbrain.service 2>/dev/null`)).stdout;
    const execStopPresent = /ExecStop=.*pglite-checkpoint\.sh/.test(gbrainDropIns);
    record(`PGLite CHECKPOINT ExecStop hook installed in gbrain.service (Rule 54)${gbrainNoteSuffix}`,
      gbrainGateSev, ["bake", "test"],
      execStopPresent,
      execStopPresent ? "" : "gbrain.service has no ExecStop=...pglite-checkpoint.sh hook — SIGKILL on reboot/OOM will leave stale pg_control");

    // ─── 29. Bun-in-gateway-PATH (audit P1 follow-up) ─────────────────────
    // Map §11 known-risk. Gbrain's shebang is `#!/usr/bin/env bun` — without bun on the
    // gateway's PATH at process-spawn time, MCP-call from gateway to gbrain fails.
    // Easiest robust check: the prctl-subreaper.conf drop-in (or some Environment= line)
    // includes ~/.bun/bin, OR the gateway's runtime environment shows it.
    const gwEnv = MODE === "test"
      ? (await exec(c, `systemctl --user show -p Environment openclaw-gateway 2>&1`)).stdout
      : "";
    const dropInsCat = (await exec(c, `cat ~/.config/systemd/user/openclaw-gateway.service.d/*.conf 2>/dev/null`)).stdout;
    // Bake-mode: gateway is stopped, so check whether any drop-in mentions ~/.bun/bin
    // (or the systemctl --user show output if we're in test mode).
    const bunPathSeen = /\.bun\/bin/.test(dropInsCat) || /\.bun\/bin/.test(gwEnv);
    record("openclaw-gateway has ~/.bun/bin on PATH (for gbrain shebang)", "P1", ["bake", "test"],
      bunPathSeen, bunPathSeen ? "" : "no drop-in or runtime env contains .bun/bin");

    // ─── 31. v123/v124/v125 manifest bump checks (post-v122 bake) ─────────
    // Added 2026-05-28 ahead of v126 bake. Every check maps directly to a
    // specific commit/incident:
    //
    //   - v123 (commit 95480af9): skip-to-command-center fleet rollout.
    //     Reconciler-only; no on-VM artifacts to verify here (stepWebOnlyUserAgents
    //     runs at per-user assignment, not on the bake VM).
    //
    //   - v124 (commit 27885f9b): strip-thinking periodic-summary LLM kill switch.
    //     19 paying users hit fleet-wide credit overcharge 2026-05-28.
    //     Postmortem: docs/postmortems/2026-05-28-strip-thinking-summary-overcharge.md.
    //     Snapshot MUST ship with PERIODIC_SUMMARY_LLM_ENABLED = True (the
    //     Phase 2 final state); False would mean we're shipping a snapshot
    //     at the Phase 1 emergency-kill state, silently disabling memory
    //     management on every fresh VM.
    //
    //   - v125 (commit 3e73be06): CLAUDE.md Rule 69 — proxy call_type taxonomy.
    //     Strip-thinking now sends x-call-kind: infrastructure +
    //     x-model-override: claude-haiku-4-5-20251001 so the proxy routes to
    //     haiku (cost=1) and bills a separate per-VM per-day
    //     INFRASTRUCTURE_DAILY_BUDGET=500 instead of the user's daily display
    //     limit. Without the header, the content router upgrades to sonnet/
    //     opus and charges the user (the 2026-05-28 incident root cause).
    //
    //   - Base DeFi MCP integration (commits dfbc36c5, 7111ad20, c6f1f767):
    //     6 base-* skills + AGENTS.md BASE_DEFI_ROUTING_V1 block.
    //
    //   - WETH9 wallet-limits (commit 2f0b77a6): smart-account can't unwrap
    //     WETH via WETH9.withdraw() (selector 0x2e1a7d4d) — content lives in
    //     base-uniswap + base-aerodrome SKILL.md.
    //
    //   - Bonjour drop-in baked into snapshot (Rule 62 P1 followup, 2026-05-28
    //     manifest addition): 99-disable-bonjour.conf now in
    //     vm-manifest.ts:files[] so fresh pool VMs ship with bonjour disabled
    //     from snapshot boot, not at user assignment.

    // 31a — v124 strip-thinking PERIODIC_SUMMARY_LLM_ENABLED value check.
    // Sentinel (the constant name) is checked in RULE23_SENTINELS above; this
    // adds the value check. Must be True (Phase 2 final), NOT False (Phase 1
    // emergency-kill that the postmortem documents).
    const periodicEnabled = (await exec(c,
      `grep -oE "PERIODIC_SUMMARY_LLM_ENABLED\\s*=\\s*(True|False)" ~/.openclaw/scripts/strip-thinking.py 2>/dev/null | head -1`,
    )).stdout.trim();
    record("v124: PERIODIC_SUMMARY_LLM_ENABLED = True (Phase 2 final state, not Phase 1 emergency)",
      "P0", ["bake", "test"],
      /=\s*True\s*$/.test(periodicEnabled),
      `got: ${periodicEnabled || "missing"}`);

    // 31b — v125 (Rule 69) x-call-kind: infrastructure header at every
    // strip-thinking call site. Without this, the proxy categorizes as 'user',
    // bills the user's daily display limit, and content-routes to sonnet/opus
    // (the 2026-05-28 incident root cause). Both _call_haiku_for_summary AND
    // run_session_end_hook send the header → expect ≥2 occurrences.
    const xCallKindCount = parseInt(
      (await exec(c,
        `grep -c "x-call-kind: infrastructure" ~/.openclaw/scripts/strip-thinking.py 2>/dev/null || echo 0`,
      )).stdout.trim() || "0",
      10,
    );
    record("v125 (Rule 69): x-call-kind: infrastructure header at all strip-thinking LLM call sites",
      "P0", ["bake", "test"],
      xCallKindCount >= 2,
      `${xCallKindCount} occurrences (expected ≥2 — one per call site)`);

    // 31c — v125 (Rule 69) x-model-override defense-in-depth.
    // Even if x-call-kind is somehow missing (regression), x-model-override
    // forces routing to haiku (cost=1) via routingCtx.explicitModelRequest.
    // Both call sites should send the header → expect ≥2.
    const xModelOverrideCount = parseInt(
      (await exec(c,
        `grep -c "x-model-override:" ~/.openclaw/scripts/strip-thinking.py 2>/dev/null || echo 0`,
      )).stdout.trim() || "0",
      10,
    );
    record("v125 (Rule 69): x-model-override header at all strip-thinking LLM call sites",
      "P0", ["bake", "test"],
      xModelOverrideCount >= 2,
      `${xModelOverrideCount} occurrences (expected ≥2)`);
    const haikuModelCount = parseInt(
      (await exec(c,
        `grep -c "claude-haiku-4-5-20251001" ~/.openclaw/scripts/strip-thinking.py 2>/dev/null || echo 0`,
      )).stdout.trim() || "0",
      10,
    );
    record("v125 (Rule 69): claude-haiku-4-5-20251001 is the forced model",
      "P0", ["bake", "test"],
      haikuModelCount >= 2,
      `${haikuModelCount} occurrences (expected ≥2)`);

    // 31d — Base DeFi 6 skill files (commits dfbc36c5 + follow-ups).
    // Each of base-aerodrome, base-avantis, base-moonwell, base-morpho,
    // base-uniswap, base-virtuals must have SKILL.md present on disk. The
    // bake VM deploys these via stepBaseSkills during reconcile-run-audit;
    // pre-bake-cleanup --keep-skills (default) preserves them; snapshot
    // captures them; fresh VMs from snapshot have them on first boot.
    for (const skill of [
      "base-aerodrome", "base-avantis", "base-moonwell",
      "base-morpho", "base-uniswap", "base-virtuals",
    ]) {
      const present = (await exec(c, `test -f ~/.openclaw/skills/${skill}/SKILL.md && echo Y || echo N`)).stdout.trim() === "Y";
      record(`Base DeFi: ~/.openclaw/skills/${skill}/SKILL.md present`,
        "P0", ["bake", "test"], present,
        present ? "" : "missing — Base MCP integration won't function on this VM");
    }

    // 31e — Base DeFi AGENTS.md routing block (commit dfbc36c5).
    // stepDeployBaseDefiRouting INSERTS the markers from
    // workspace-templates-v2.ts:
    //   BASE_DEFI_ROUTING_V1_BEGIN_MARKER = "<!-- BASE_DEFI_ROUTING_V1 -->"
    //   BASE_DEFI_ROUTING_V1_END_MARKER   = "<!-- /BASE_DEFI_ROUTING_V1 -->"
    // into AGENTS.md. The bake VM's reconcile MUST execute this step (called
    // twice in reconcileVM — orchestrator lines 446 + 921). Both markers must
    // be present (BEGIN + END count = 2).
    //
    // 2026-05-29 v126 bake fix: the prior regex was
    // `BASE_DEFI_ROUTING_V1_(BEGIN|END)` which looked for the literal strings
    // `BASE_DEFI_ROUTING_V1_BEGIN` / `BASE_DEFI_ROUTING_V1_END` — but those
    // suffixes don't appear in the marker text itself (only in the constant
    // names in workspace-templates-v2.ts). False-positive P0 blocked the
    // bake even though the reconciler had inserted the markers correctly.
    // Switched to counting the canonical sub-string `BASE_DEFI_ROUTING_V1`,
    // which appears in BOTH the BEGIN (`<!-- BASE_DEFI_ROUTING_V1 -->`) and
    // END (`<!-- /BASE_DEFI_ROUTING_V1 -->`) markers. Expected count = 2.
    const baseDefiMarkers = parseInt(
      (await exec(c,
        `grep -cE "BASE_DEFI_ROUTING_V1" ~/.openclaw/workspace/AGENTS.md 2>/dev/null || echo 0`,
      )).stdout.trim() || "0",
      10,
    );
    record("Base DeFi: AGENTS.md contains BASE_DEFI_ROUTING_V1 markers (BEGIN+END)",
      "P0", ["bake", "test"],
      baseDefiMarkers >= 2,
      `markers=${baseDefiMarkers} (expected ≥2 — one BEGIN, one END)`);

    // 31f — WETH wallet-limits content (commit 2f0b77a6).
    // The EIP-7702-delegated smart account can't call IWETH9.withdraw (selector
    // 0x2e1a7d4d) — internal address.transfer() forwards 2300 gas, wallet
    // receive() needs more. Content lives in base-uniswap + base-aerodrome
    // SKILL.md (verified by Bankr 502 incident triage 2026-05-28 —
    // docs/incidents/2026-05-28-bankr-502-outage.md timeline). At least 2
    // base-* SKILL.md files must mention IWETH9 OR 2e1a7d4d OR EIP-7702.
    const wethFiles = parseInt(
      (await exec(c,
        `grep -lE "IWETH9|2e1a7d4d|EIP-7702-delegated" ~/.openclaw/skills/base-*/SKILL.md 2>/dev/null | wc -l`,
      )).stdout.trim() || "0",
      10,
    );
    record("WETH limit: ≥2 base-*/SKILL.md files mention IWETH9/2e1a7d4d/EIP-7702",
      "P0", ["bake", "test"],
      wethFiles >= 2,
      `${wethFiles} files match (expected ≥2 — base-uniswap + base-aerodrome at minimum)`);

    // 31g — Bonjour drop-in baked into snapshot (Rule 62 P1 followup, 2026-05-28).
    // Before this change: drop-in only written by configureOpenClaw at user
    // assignment, so fresh pool VMs had a window where bonjour was NOT
    // disabled (vm-1019 2026-05-23 6-min first-message latency smoking gun).
    // After: vm-manifest.ts:files[] writes 99-disable-bonjour.conf during
    // reconcile, so the bake VM ships it into the snapshot. This check
    // verifies the file is on disk on the bake/soak VM.
    //
    // Note: §3 above checks the systemdOverrides Environment=
    // OPENCLAW_DISABLE_BONJOUR=true line in the override.conf (different
    // mechanism, same goal). The drop-in is the load-bearing one for fresh
    // pool VMs that haven't been configureOpenClaw'd yet — override.conf
    // can be missing the env line and the drop-in still kills bonjour.
    const bonjourDropIn = (await exec(c,
      `test -f ~/.config/systemd/user/openclaw-gateway.service.d/99-disable-bonjour.conf && echo Y || echo N`,
    )).stdout.trim();
    record("Rule 62: 99-disable-bonjour.conf drop-in present (snapshot-baked)",
      "P0", ["bake", "test"],
      bonjourDropIn === "Y",
      bonjourDropIn === "Y" ? "" : "drop-in absent — fresh VMs will see bonjour stall window before configureOpenClaw writes it");
    if (bonjourDropIn === "Y") {
      // Defensive: verify the canonical Environment= line is in the file.
      // Catches a partial-write / disk-error scenario where the file exists
      // but is empty or truncated (same anti-pattern as cloud-init §1.0.7
      // line 316-321 defense).
      const bonjourEnvLine = parseInt(
        (await exec(c,
          `grep -c "^Environment=OPENCLAW_DISABLE_BONJOUR=true" ~/.config/systemd/user/openclaw-gateway.service.d/99-disable-bonjour.conf 2>/dev/null || echo 0`,
        )).stdout.trim() || "0",
        10,
      );
      record("Rule 62: 99-disable-bonjour.conf has canonical Environment= line",
        "P0", ["bake", "test"],
        bonjourEnvLine >= 1,
        `count=${bonjourEnvLine} (expected ≥1 — partial-write would leave 0)`);
    }
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
