/**
 * Fleet-deploy strip-thinking.py v80 with PERIODIC_SUMMARY_V1_RESHRINK fix.
 *
 * Why: 2026-05-04 audit on 5 active VMs found 2/5 had the
 * run_periodic_summary_hook silently blocked because last_periodic_msg_count
 * went out of sync with the actual session size (in-place compaction or
 * silent rotation reduced the count, new_msgs went negative, gate fires
 * forever).  Fix re-baselines the count when shrinkage is detected, so the
 * hook can resume firing once enough new content accumulates.
 *
 * Pattern matches _fleet-push-strip-thinking-hotfix.ts:
 *   - Concurrency=5 worker pool
 *   - Wave size 20 with halt threshold at 25%
 *   - Per-VM deadline 60s
 *   - Resume-safe via checkpoint
 *   - tmpPath salted with vm.id (uuid) — race-fixed
 *   - Sentinel grep on uploaded file (Rule 23)
 *   - No gateway restart — per-minute cron will exercise the new code
 *
 * Required sentinels (all must be present in the canonical STRIP_THINKING_SCRIPT
 * AND on every VM after install):
 *   - def trim_failed_turns / SESSION TRIMMED:                    (Rule 22)
 *   - def run_periodic_summary_hook / PERIODIC_SUMMARY_V1         (cross-session memory)
 *   - PRE_ARCHIVE_SUMMARY_V1                                       (pre-archive net)
 *   - PERIODIC_SUMMARY_V1_RESHRINK                                (the v80 fix — NEW)
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { NodeSSH } from "node-ssh";
import { STRIP_THINKING_SCRIPT } from "../lib/ssh";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  const env = readFileSync(f, "utf-8");
  for (const l of env.split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) {
      process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const sshKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");

const CONCURRENCY = 5;
const WAVE_SIZE = 20;
const PER_VM_DEADLINE_MS = 60_000;
const HALT_FAILURE_RATE = 0.25;
const CHECKPOINT_PATH = "/tmp/fleet-strip-thinking-v80-progress.json";
const LOG_PATH = `/tmp/fleet-strip-thinking-v80-${new Date().toISOString().slice(0, 10)}.log`;

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const RESET_CHECKPOINT = args.includes("--reset");
const ONLY_NAMES = args
  .find((a) => a.startsWith("--only="))
  ?.slice(7)
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const REQUIRED_SENTINELS = [
  "def trim_failed_turns",
  "SESSION TRIMMED:",
  "def run_periodic_summary_hook",
  "PERIODIC_SUMMARY_V1",
  "PRE_ARCHIVE_SUMMARY_V1",
  "PERIODIC_SUMMARY_V1_RESHRINK",
];

interface Outcome {
  vmId: string;
  name: string;
  ip: string;
  status: "success" | "failed";
  reason?: string;
  ts: string;
}

interface Checkpoint {
  startedAt: string;
  fleetSize: number;
  done: Record<string, Outcome>;
}

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try { writeFileSync(LOG_PATH, line + "\n", { flag: "a" }); } catch { /* ignore */ }
}

function loadCheckpoint(): Checkpoint {
  if (RESET_CHECKPOINT || !existsSync(CHECKPOINT_PATH)) {
    return { startedAt: new Date().toISOString(), fleetSize: 0, done: {} };
  }
  try {
    return JSON.parse(readFileSync(CHECKPOINT_PATH, "utf-8")) as Checkpoint;
  } catch {
    return { startedAt: new Date().toISOString(), fleetSize: 0, done: {} };
  }
}

function saveCheckpoint(cp: Checkpoint): void {
  writeFileSync(CHECKPOINT_PATH, JSON.stringify(cp, null, 2));
}

async function withDeadline<T>(fn: () => Promise<T>, ms: number): Promise<{ ok: true; v: T } | { ok: false; reason: string }> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const dl = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("DEADLINE")), ms); });
  try {
    const v = await Promise.race([fn(), dl]);
    return { ok: true, v };
  } catch (e) {
    if (e instanceof Error && e.message === "DEADLINE") return { ok: false, reason: "deadline" };
    return { ok: false, reason: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function deployToVM(vm: { id: string; name: string; ip_address: string; ssh_user: string | null }): Promise<{ status: "success" | "failed"; reason?: string }> {
  const ssh = new NodeSSH();
  const username = vm.ssh_user || "openclaw";
  try {
    await ssh.connect({ host: vm.ip_address, username, privateKey: sshKey, readyTimeout: 15_000 });
  } catch (e) {
    return { status: "failed", reason: `ssh_connect: ${(e as Error).message.slice(0, 100)}` };
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const remotePath = `/home/${username}/.openclaw/scripts/strip-thinking.py`;
  const tmpPath = `/tmp/strip-thinking-${vm.id}-${ts}.py`;
  try {
    writeFileSync(tmpPath, STRIP_THINKING_SCRIPT, "utf-8");
    try {
      await ssh.putFile(tmpPath, `${remotePath}.tmp`);
    } finally {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
    }
    const grepLines = REQUIRED_SENTINELS.map((s) => `grep -q ${JSON.stringify(s)} ${remotePath}.tmp`).join("\n");
    const installScript = `
set -eu
[ -f ${remotePath} ] && cp -p ${remotePath} ${remotePath}.bak-${ts} || true
python3 -m py_compile ${remotePath}.tmp
${grepLines}
chmod +x ${remotePath}.tmp
mv ${remotePath}.tmp ${remotePath}
echo OK
`;
    const r = await ssh.execCommand(installScript);
    if (r.code !== 0) {
      return { status: "failed", reason: `install_exit_${r.code}: ${(r.stderr || r.stdout).slice(0, 200)}` };
    }
    if (!r.stdout.includes("OK")) {
      return { status: "failed", reason: `no_ok_marker: ${r.stdout.slice(0, 200)}` };
    }
    return { status: "success" };
  } catch (e) {
    return { status: "failed", reason: `exec: ${(e as Error).message.slice(0, 200)}` };
  } finally {
    try { ssh.dispose(); } catch { /* ignore */ }
  }
}

async function fetchFleetVMs(): Promise<Array<{ id: string; name: string; ip_address: string; ssh_user: string | null }>> {
  const { data } = await sb
    .from("instaclaw_vms")
    .select("id, name, ip_address, ssh_user")
    .eq("status", "assigned")
    .eq("provider", "linode")
    .eq("health_status", "healthy")
    .is("frozen_at", null)
    .is("lifecycle_locked_at", null)
    .not("ip_address", "is", null)
    .not("gateway_token", "is", null)
    .order("name", { ascending: true });

  let vms = (data || []).map((v) => ({
    id: v.id as string,
    name: v.name as string,
    ip_address: v.ip_address as string,
    ssh_user: (v.ssh_user as string) || null,
  }));
  if (ONLY_NAMES?.length) vms = vms.filter((v) => ONLY_NAMES.includes(v.name));
  return vms;
}

async function main(): Promise<void> {
  for (const s of REQUIRED_SENTINELS) {
    if (!STRIP_THINKING_SCRIPT.includes(s)) {
      throw new Error(`STRIP_THINKING_SCRIPT missing sentinel "${s}"`);
    }
  }
  log(`canonical script size: ${STRIP_THINKING_SCRIPT.length} chars (${REQUIRED_SENTINELS.length} sentinels OK)`);

  const allVMs = await fetchFleetVMs();
  log(`fleet: ${allVMs.length} healthy assigned linode VMs`);
  if (DRY_RUN) {
    log("DRY RUN — first 10:");
    for (const v of allVMs.slice(0, 10)) log(`  ${v.name.padEnd(22)} ${v.ip_address}`);
    log(`(total ${allVMs.length})`);
    return;
  }

  const cp = loadCheckpoint();
  cp.fleetSize = allVMs.length;
  const remaining = allVMs.filter((v) => !cp.done[v.id]);
  log(`checkpoint: ${Object.keys(cp.done).length} already done, ${remaining.length} remaining`);
  if (remaining.length === 0) { log("✅ all VMs already deployed"); return; }

  let waveNum = 0;
  for (let waveStart = 0; waveStart < remaining.length; waveStart += WAVE_SIZE) {
    waveNum++;
    const wave = remaining.slice(waveStart, waveStart + WAVE_SIZE);
    log(``);
    log(`══ Wave ${waveNum} — ${wave.length} VMs (${waveStart + 1}–${waveStart + wave.length} of ${remaining.length}) ══`);

    let cursor = 0;
    const waveOutcomes: Outcome[] = [];
    async function worker() {
      while (true) {
        const idx = cursor++;
        if (idx >= wave.length) return;
        const vm = wave[idx];
        const r = await withDeadline(() => deployToVM(vm), PER_VM_DEADLINE_MS);
        const outcome: Outcome = r.ok
          ? { vmId: vm.id, name: vm.name, ip: vm.ip_address, status: r.v.status, reason: r.v.reason, ts: new Date().toISOString() }
          : { vmId: vm.id, name: vm.name, ip: vm.ip_address, status: "failed", reason: r.reason, ts: new Date().toISOString() };
        cp.done[vm.id] = outcome;
        waveOutcomes.push(outcome);
        const symbol = outcome.status === "success" ? "✓" : "✗";
        log(`  ${symbol} ${vm.name.padEnd(22)} ${vm.ip_address.padEnd(16)} ${outcome.status === "success" ? "" : (outcome.reason || "").slice(0, 80)}`);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, wave.length) }, () => worker()));
    saveCheckpoint(cp);

    const fails = waveOutcomes.filter((o) => o.status === "failed").length;
    const failRate = fails / wave.length;
    log(`  → wave ${waveNum} done: ${wave.length - fails}/${wave.length} ok${fails > 0 ? `  (${fails} fail, rate=${(failRate * 100).toFixed(0)}%)` : ""}`);
    if (failRate > HALT_FAILURE_RATE) {
      log(``);
      log(`🛑 HALTING — wave ${waveNum} failure rate ${(failRate * 100).toFixed(0)}% > ${HALT_FAILURE_RATE * 100}%`);
      log(`Checkpoint saved at ${CHECKPOINT_PATH}; resume after diagnosis.`);
      process.exit(2);
    }
  }

  const done = Object.values(cp.done);
  const ok = done.filter((d) => d.status === "success").length;
  const fail = done.filter((d) => d.status === "failed").length;
  log(``);
  log(`✅ ALL WAVES COMPLETE`);
  log(``);
  log(`────────────────────────────────────────────────────────────`);
  log(`Final: ${ok}/${done.length} success across ${cp.fleetSize} VMs`);
  if (fail > 0) {
    log(`Failure breakdown:`);
    const byReason = new Map<string, number>();
    for (const o of done.filter((d) => d.status === "failed")) {
      const tag = (o.reason || "unknown").split(":")[0];
      byReason.set(tag, (byReason.get(tag) || 0) + 1);
    }
    for (const [r, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
      log(`  ${n} × ${r}`);
    }
    log(`Detail (first 12):`);
    for (const o of done.filter((d) => d.status === "failed").slice(0, 12)) {
      log(`  ${o.name.padEnd(22)} ${o.ip.padEnd(16)} ${(o.reason || "").slice(0, 80)}`);
    }
  }
  log(`Checkpoint at ${CHECKPOINT_PATH}`);
  log(`Log at ${LOG_PATH}`);
}

main().catch((e) => { console.error("FATAL:", (e as Error).message); process.exit(1); });
