#!/usr/bin/env tsx
/**
 * _audit-canary-vs-manifest.ts — pre-bake gate that catches "vm-1019 has it,
 * manifest doesn't" drift before we cut a snapshot.
 *
 * Motivation (2026-05-24, Rule 65 night):
 *   Hours of canary work applied tons of state to vm-1019 via interactive
 *   `openclaw config set`, manual systemd edits, `npm install -g`, etc.
 *   Two config keys (typingMode/typingIntervalSeconds) lived on vm-1019 only
 *   for 4+ hours; would have been silently lost in the snapshot bake without
 *   Cooper's explicit catch. This script makes that catch mechanical.
 *
 * Usage:
 *   npx tsx scripts/_audit-canary-vs-manifest.ts                    # default vm-1019
 *   npx tsx scripts/_audit-canary-vs-manifest.ts instaclaw-vm-050   # any VM
 *   npx tsx scripts/_audit-canary-vs-manifest.ts --json             # machine-readable
 *
 * Exit codes:
 *   0 = no drift; ready to bake
 *   1 = drift detected; review + codify before bake
 *   2 = audit infrastructure failure (SSH unreachable, missing env, etc.)
 *
 * What it checks (in order of historical-miss frequency):
 *   1. openclaw.json config keys vs manifest.configSettings — biggest miss class
 *   2. systemd override.conf contents vs manifest.systemdOverrides
 *   3. crontab entries vs manifest.cronJobs[] markers + cronJobsRemove[]
 *   4. installed versions: openclaw, node, gbrain, prctl-subreaper
 *   5. requiredSentinels coverage in template files (strip-thinking.py, etc)
 *   6. (deferred) env vars in .env vs SECRET_ENV_VAR_SOURCES — TODO
 *
 * Rule 18: loads BOTH .env.local AND .env.ssh-key for SSH.
 * Rule 64: read-only audit. Does NOT mutate vm-1019 state. Safe to run anytime.
 */
import { readFileSync } from "fs";
import { NodeSSH } from "node-ssh";

// ── env load (Rule 18) ────────────────────────────────────────────────
for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  try {
    for (const l of readFileSync(f, "utf-8").split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {}
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SSH_KEY_B64 = process.env.SSH_PRIVATE_KEY_B64!;
if (!SUPABASE_URL || !SUPABASE_KEY || !SSH_KEY_B64) {
  console.error("missing env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SSH_PRIVATE_KEY_B64");
  process.exit(2);
}

const args = process.argv.slice(2);
const vmName = args.find((a) => !a.startsWith("--")) ?? "instaclaw-vm-1019";
const asJson = args.includes("--json");

// ── manifest + ssh.ts constants ──────────────────────────────────────
import { VM_MANIFEST } from "../lib/vm-manifest";
import { OPENCLAW_PINNED_VERSION, NODE_PINNED_VERSION, PRCTL_SUBREAPER_PINNED_VERSION } from "../lib/ssh";

interface Finding {
  category: string;
  key: string;
  expected: string;
  actual: string;
  severity: "MISSING_IN_MANIFEST" | "MISSING_ON_VM" | "DRIFT" | "INFO";
}
const findings: Finding[] = [];

function addFinding(f: Finding) {
  findings.push(f);
}

// ── 1. fetch VM row ──────────────────────────────────────────────────
async function fetchVm(name: string): Promise<{ id: string; ip_address: string; ssh_port: number | null; ssh_user: string | null }> {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/instaclaw_vms?name=eq.${encodeURIComponent(name)}&select=id,ip_address,ssh_port,ssh_user`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
  );
  if (!r.ok) throw new Error(`supabase ${r.status}: ${await r.text()}`);
  const rows = (await r.json()) as Array<{ id: string; ip_address: string; ssh_port: number | null; ssh_user: string | null }>;
  if (rows.length === 0) throw new Error(`no VM named "${name}"`);
  return rows[0];
}

// ── 2. SSH + probe ───────────────────────────────────────────────────
async function probeVm(ip: string, port: number, user: string): Promise<{
  openclawJson: any;
  openclawVersion: string;
  nodeVersion: string;
  systemdOverride: string;
  crontab: string;
  stripThinkingSource: string;
  installedOpenclawPkgVersion: string;
  installedPrctlSubreaperVersion: string;
  gbrainPinnedCommit: string;
  gbrainServiceActive: boolean;
  pidsMax: string;
}> {
  const ssh = new NodeSSH();
  await ssh.connect({
    host: ip,
    port,
    username: user,
    privateKey: Buffer.from(SSH_KEY_B64, "base64").toString("utf-8"),
    readyTimeout: 15000,
  });

  const sh = async (cmd: string) => (await ssh.execCommand(cmd)).stdout;

  // Source NVM for openclaw + node version
  const nvmPrefix = ". ~/.nvm/nvm.sh >/dev/null 2>&1; ";
  const out = {
    openclawJson: JSON.parse(await sh("cat ~/.openclaw/openclaw.json")),
    openclawVersion: (await sh(nvmPrefix + "openclaw --version 2>&1")).trim(),
    nodeVersion: (await sh(nvmPrefix + "node --version 2>&1")).trim().replace(/^v/, ""),
    // Aggregate ALL .conf drop-ins (override.conf + 30-bun-path.conf +
    // 99-disable-bonjour.conf + prctl-subreaper.conf + future drop-ins).
    // Bonjour Environment lives in a separate drop-in, not override.conf —
    // missing this caused false positives in the first audit run.
    systemdOverride: await sh("cat ~/.config/systemd/user/openclaw-gateway.service.d/*.conf 2>/dev/null || echo '__MISSING__'"),
    crontab: await sh("crontab -l 2>/dev/null || echo '__NONE__'"),
    stripThinkingSource: await sh("cat ~/.openclaw/scripts/strip-thinking.py 2>/dev/null | head -3000"),
    installedOpenclawPkgVersion: (await sh(nvmPrefix + "jq -r .version $(npm root -g)/openclaw/package.json 2>/dev/null")).trim(),
    installedPrctlSubreaperVersion: (await sh(nvmPrefix + "jq -r .version $(npm root -g)/prctl-subreaper/package.json 2>/dev/null")).trim(),
    gbrainPinnedCommit: (await sh("cd ~/gbrain 2>/dev/null && git rev-parse --short HEAD 2>/dev/null || echo MISSING")).trim(),
    gbrainServiceActive: (await sh("systemctl --user is-active gbrain.service 2>/dev/null")).trim() === "active",
    pidsMax: (await sh(`GW_PID=$(systemctl --user show openclaw-gateway -p MainPID --value); CG=$(cat /proc/$GW_PID/cgroup 2>/dev/null | head -1 | cut -d: -f3); cat /sys/fs/cgroup$CG/pids.max 2>/dev/null || echo unknown`)).trim(),
  };
  ssh.dispose();
  return out;
}

// ── 3. compare config keys ────────────────────────────────────────────
function compareConfigSettings(vmCfg: any, manifestCfg: Record<string, string>) {
  // Flatten manifest config like "agents.defaults.typingMode" → expected value
  for (const [dottedKey, expectedVal] of Object.entries(manifestCfg)) {
    const actualVal = getDottedKey(vmCfg, dottedKey);
    const actualStr = actualVal === undefined ? "__MISSING__" : String(actualVal);
    if (actualStr !== expectedVal && actualStr !== "__MISSING__") {
      addFinding({
        category: "configSettings",
        key: dottedKey,
        expected: expectedVal,
        actual: actualStr,
        severity: "DRIFT",
      });
    } else if (actualStr === "__MISSING__") {
      addFinding({
        category: "configSettings",
        key: dottedKey,
        expected: expectedVal,
        actual: "(unset on VM)",
        severity: "MISSING_ON_VM",
      });
    }
  }

  // Reverse: any DEFINED keys on the VM that DON'T appear in the manifest = candidates for codification
  // We only flag keys under namespaces the manifest cares about (avoid noise from user state).
  // EXCLUSIONS: keys that are legitimately per-VM/per-user and should NEVER be codified in the manifest.
  // - agents.defaults.model.primary: per-VM user preference, set by stepChatGPTOAuthToken or stepDefaultModel
  // - any *.tokens / *.access: OAuth runtime state, per-VM
  // Maintained as a small denylist instead of broader filter to keep audit signal high.
  const PER_VM_EXCLUSIONS = new Set([
    "agents.defaults.model.primary",
  ]);
  const MANIFEST_NAMESPACES = ["agents.defaults", "messages", "channels.telegram.streaming", "discovery.mdns", "session"];
  const vmKeys = flattenKeys(vmCfg).filter((k) => MANIFEST_NAMESPACES.some((ns) => k.startsWith(ns)));
  for (const vmKey of vmKeys) {
    if (manifestCfg[vmKey] !== undefined) continue;
    if (PER_VM_EXCLUSIONS.has(vmKey)) continue;
    const vmVal = getDottedKey(vmCfg, vmKey);
    if (vmVal === null || vmVal === undefined) continue;
    // Skip if it's just an empty leaf / Note: in the snapshot some keys are
    // structurally present as null — those are OpenClaw defaults we shouldn't
    // care about. Only flag scalars that have a real value.
    if (typeof vmVal === "object") continue;
    addFinding({
      category: "configSettings",
      key: vmKey,
      expected: "(not in manifest — candidate for codification)",
      actual: String(vmVal),
      severity: "MISSING_IN_MANIFEST",
    });
  }
}

function flattenKeys(obj: any, prefix = ""): string[] {
  const out: string[] = [];
  if (obj === null || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj)) {
    const dotted = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      out.push(...flattenKeys(v, dotted));
    } else {
      out.push(dotted);
    }
  }
  return out;
}

function getDottedKey(obj: any, dotted: string): any {
  return dotted.split(".").reduce((acc, k) => (acc === undefined || acc === null ? undefined : acc[k]), obj);
}

// ── 4. compare systemd override ──────────────────────────────────────
function compareSystemdOverride(vmOverride: string, manifestOverrides: Record<string, string>) {
  if (vmOverride === "__MISSING__") {
    addFinding({ category: "systemd", key: "override.conf", expected: "(file present)", actual: "missing entirely", severity: "DRIFT" });
    return;
  }
  for (const [key, expectedVal] of Object.entries(manifestOverrides)) {
    // Strip newlines (some manifest values like Environment can have embedded \n)
    const expectedLines = expectedVal.split("\n");
    for (const line of expectedLines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Look for `<key>=<value>` or just the value-as-line
      const expectedLine = trimmed.includes("=") ? trimmed : `${key}=${trimmed}`;
      if (!vmOverride.includes(expectedLine)) {
        addFinding({
          category: "systemd",
          key,
          expected: expectedLine,
          actual: "(line not in override.conf)",
          severity: "MISSING_ON_VM",
        });
      }
    }
  }
}

// ── 5. compare cron ──────────────────────────────────────────────────
function compareCron(vmCrontab: string, manifestCron: Array<{ marker: string; command?: string }>, removeMarkers?: string[]) {
  for (const job of manifestCron) {
    if (!vmCrontab.includes(job.marker)) {
      addFinding({
        category: "cron",
        key: job.marker,
        expected: "(in crontab via manifest)",
        actual: "(missing)",
        severity: "MISSING_ON_VM",
      });
    }
  }
  if (removeMarkers) {
    for (const marker of removeMarkers) {
      // crontab line containing marker AND not starting with `#`
      const lines = vmCrontab.split("\n").filter((l) => l.includes(marker) && !l.trim().startsWith("#"));
      if (lines.length > 0) {
        addFinding({
          category: "cron",
          key: marker,
          expected: "(should be REMOVED per cronJobsRemove)",
          actual: `still active: ${lines[0].slice(0, 80)}`,
          severity: "DRIFT",
        });
      }
    }
  }
}

// ── 6. compare installed versions ────────────────────────────────────
function compareVersions(vm: { openclawVersion: string; nodeVersion: string; installedOpenclawPkgVersion: string; installedPrctlSubreaperVersion: string; gbrainPinnedCommit: string }) {
  // openclaw: extract semver from "OpenClaw 2026.5.20 (sha)"
  const ocSemverMatch = vm.openclawVersion.match(/[\d.]+/);
  const ocActual = ocSemverMatch ? ocSemverMatch[0] : vm.openclawVersion;
  if (ocActual !== OPENCLAW_PINNED_VERSION) {
    addFinding({
      category: "versions",
      key: "openclaw",
      expected: OPENCLAW_PINNED_VERSION,
      actual: ocActual,
      severity: "DRIFT",
    });
  }
  if (vm.installedOpenclawPkgVersion && vm.installedOpenclawPkgVersion !== OPENCLAW_PINNED_VERSION) {
    addFinding({
      category: "versions",
      key: "openclaw/package.json",
      expected: OPENCLAW_PINNED_VERSION,
      actual: vm.installedOpenclawPkgVersion,
      severity: "DRIFT",
    });
  }
  if (vm.nodeVersion !== NODE_PINNED_VERSION) {
    addFinding({
      category: "versions",
      key: "node",
      expected: NODE_PINNED_VERSION,
      actual: vm.nodeVersion,
      severity: "DRIFT",
    });
  }
  if (vm.installedPrctlSubreaperVersion && vm.installedPrctlSubreaperVersion !== PRCTL_SUBREAPER_PINNED_VERSION) {
    addFinding({
      category: "versions",
      key: "prctl-subreaper",
      expected: PRCTL_SUBREAPER_PINNED_VERSION,
      actual: vm.installedPrctlSubreaperVersion,
      severity: "DRIFT",
    });
  }
}

// ── 7. compare requiredSentinels ─────────────────────────────────────
function compareSentinels(vmStripThinkingSource: string, manifestFiles: any[]) {
  const stripEntry = manifestFiles.find((f: any) => f.templateKey === "STRIP_THINKING_SCRIPT");
  if (!stripEntry?.requiredSentinels) return;
  for (const sentinel of stripEntry.requiredSentinels) {
    if (!vmStripThinkingSource.includes(sentinel)) {
      addFinding({
        category: "sentinels",
        key: sentinel,
        expected: "(present in strip-thinking.py)",
        actual: "(MISSING — Rule 23 violation)",
        severity: "MISSING_ON_VM",
      });
    }
  }
}

// ── 8. cgroup TasksMax / pids.max ────────────────────────────────────
function compareTasksMax(vmPidsMax: string, manifestTasksMax: string) {
  // cgroup file: "max" = infinity; numeric otherwise
  const vmEquivalent = vmPidsMax === "max" ? "infinity" : vmPidsMax;
  if (vmEquivalent !== manifestTasksMax) {
    addFinding({
      category: "cgroup",
      key: "pids.max (TasksMax)",
      expected: manifestTasksMax,
      actual: vmEquivalent,
      severity: "DRIFT",
    });
  }
}

// ── main ─────────────────────────────────────────────────────────────
async function main() {
  console.error(`[${new Date().toISOString().slice(0, 19)}Z] auditing ${vmName}…`);
  const vm = await fetchVm(vmName);
  console.error(`  → ip=${vm.ip_address}`);
  const probe = await probeVm(vm.ip_address, vm.ssh_port ?? 22, vm.ssh_user ?? "openclaw");
  console.error(`  → probe complete`);

  compareConfigSettings(probe.openclawJson, VM_MANIFEST.configSettings as Record<string, string>);
  compareSystemdOverride(probe.systemdOverride, VM_MANIFEST.systemdOverrides as Record<string, string>);
  compareCron(
    probe.crontab,
    VM_MANIFEST.cronJobs as Array<{ marker: string; command?: string }>,
    (VM_MANIFEST as any).cronJobsRemove as string[] | undefined,
  );
  compareVersions(probe);
  compareSentinels(probe.stripThinkingSource, VM_MANIFEST.files as any[]);
  const manifestTasksMax = (VM_MANIFEST.systemdOverrides as any).TasksMax;
  if (manifestTasksMax) compareTasksMax(probe.pidsMax, manifestTasksMax);

  // Output
  if (asJson) {
    console.log(JSON.stringify({ vm: vmName, ip: vm.ip_address, findings }, null, 2));
  } else {
    console.log("\n════════════════════════════════════════════════════════════════════════════");
    console.log(` AUDIT REPORT: ${vmName} (${vm.ip_address})`);
    console.log("════════════════════════════════════════════════════════════════════════════\n");
    const byCategory: Record<string, Finding[]> = {};
    for (const f of findings) {
      (byCategory[f.category] ??= []).push(f);
    }
    for (const [cat, fs] of Object.entries(byCategory)) {
      console.log(`── ${cat.toUpperCase()} (${fs.length} finding${fs.length !== 1 ? "s" : ""}) ─────────────`);
      for (const f of fs) {
        const sevIcon = { MISSING_IN_MANIFEST: "🟡", MISSING_ON_VM: "🔴", DRIFT: "🔴", INFO: "🔵" }[f.severity];
        console.log(`  ${sevIcon} ${f.severity}: ${f.key}`);
        console.log(`      expected: ${f.expected}`);
        console.log(`      actual:   ${f.actual}`);
      }
      console.log("");
    }
    if (findings.length === 0) {
      console.log("✅ NO DRIFT DETECTED — vm-1019 state matches manifest. Safe to bake.\n");
    } else {
      const critical = findings.filter((f) => f.severity !== "INFO").length;
      console.log(`⚠️  ${findings.length} finding(s) total, ${critical} actionable.`);
      console.log(`    🔴 MISSING_ON_VM / DRIFT: manifest expects it but VM lacks/differs — likely a deploy gap`);
      console.log(`    🟡 MISSING_IN_MANIFEST:  VM has it but manifest doesn't — candidates for codification (the gap-class that motivated this script)\n`);
    }
  }

  process.exit(findings.filter((f) => f.severity !== "INFO").length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("audit threw:", e);
  process.exit(2);
});
