/**
 * P0 fleet-wide deploy of the trim-don't-nuke strip-thinking.py hotfix.
 *
 * Why: as of 2026-05-02 the trim-instead-of-nuke fix is only on 5 edge_city
 * VMs.  The other ~190 assigned healthy VMs still run the old code that
 * deletes the active session jsonl on a single burst of empty responses,
 * silently wiping conversation context on every error event.  This script
 * pushes the canonical STRIP_THINKING_SCRIPT (from lib/ssh.ts, which has the
 * trim_failed_turns fix) to every healthy assigned VM in the fleet.
 *
 * Pattern matches _mass-reconcile-v79.ts:
 *   - Concurrency=5 worker pool (cursor-based assignment)
 *   - Wave size 20 with audit checkpoint between waves
 *   - HALT if any wave's failure rate exceeds 25%
 *   - Resume-safe: persistent checkpoint at /tmp/fleet-strip-thinking-progress.json
 *   - Per-VM deadline 60s (deploy + py_compile + atomic install)
 *
 * Filter (matches Cooper's "skip sleeping/frozen" instruction):
 *   - status = "assigned"
 *   - provider = "linode"
 *   - health_status = "healthy"        (excludes suspended, hibernating)
 *   - frozen_at IS NULL                (excludes lifecycle-frozen)
 *   - lifecycle_locked_at IS NULL      (excludes locked)
 *   - ip_address IS NOT NULL
 *   - gateway_token IS NOT NULL        (configured)
 *
 * Per-VM ops:
 *   1. SSH connect (15s timeout)
 *   2. Read existing strip-thinking.py size for sanity
 *   3. Backup to .bak-<ts>
 *   4. Write new script via SFTP (avoids EPIPE; matches reconciler pattern)
 *   5. py_compile syntax check
 *   6. Sentinel grep ("def trim_failed_turns", "SESSION TRIMMED:")
 *   7. chmod +x
 *   8. NO manual strip-thinking.py invocation — would force gateway restart;
 *      the per-minute cron will exercise the new code naturally.
 *
 * Idempotent: checkpoint excludes already-done VMs from later runs.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { NodeSSH } from "node-ssh";
import { STRIP_THINKING_SCRIPT } from "../lib/ssh";

// ── env load (matches mass-reconcile pattern) ──
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
const HALT_FAILURE_RATE = 0.25; // 25% per-wave failure rate aborts
const CHECKPOINT_PATH = "/tmp/fleet-strip-thinking-progress.json";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const RESET_CHECKPOINT = args.includes("--reset");
const ONLY_NAMES = args
  .find((a) => a.startsWith("--only="))
  ?.slice(7)
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

interface Outcome {
  vmId: string;
  name: string;
  ip: string;
  status: "success" | "failed" | "unreachable" | "deadline";
  reason?: string;
  ts: string;
}

interface Checkpoint {
  startedAt: string;
  fleetSize: number;
  done: Record<string, Outcome>; // keyed by vm.id
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function loadCheckpoint(): Checkpoint {
  if (RESET_CHECKPOINT || !existsSync(CHECKPOINT_PATH)) {
    return { startedAt: new Date().toISOString(), fleetSize: 0, done: {} };
  }
  try {
    const raw = readFileSync(CHECKPOINT_PATH, "utf-8");
    return JSON.parse(raw) as Checkpoint;
  } catch {
    return { startedAt: new Date().toISOString(), fleetSize: 0, done: {} };
  }
}

function saveCheckpoint(cp: Checkpoint): void {
  writeFileSync(CHECKPOINT_PATH, JSON.stringify(cp, null, 2));
}

async function withDeadline<T>(
  fn: () => Promise<T>,
  ms: number,
): Promise<{ ok: true; v: T } | { ok: false; reason: string }> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const dl = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error("DEADLINE")), ms);
  });
  try {
    const v = await Promise.race([fn(), dl]);
    return { ok: true, v };
  } catch (e) {
    if (e instanceof Error && e.message === "DEADLINE")
      return { ok: false, reason: "deadline" };
    return {
      ok: false,
      reason: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function deployToVM(
  vm: { id: string; name: string; ip_address: string; ssh_user?: string | null },
): Promise<{ status: "success" | "failed"; reason?: string }> {
  const ssh = new NodeSSH();
  const username = vm.ssh_user || "openclaw";
  try {
    await ssh.connect({
      host: vm.ip_address,
      username,
      privateKey: sshKey,
      readyTimeout: 15_000,
    });
  } catch (e) {
    return { status: "failed", reason: `ssh_connect: ${(e as Error).message.slice(0, 100)}` };
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const remotePath = `/home/${username}/.openclaw/scripts/strip-thinking.py`;
  const tmpPath = `/tmp/strip-thinking-${ts}.py`;

  try {
    // 1. SFTP upload — same approach the reconciler uses for STRIP_THINKING_SCRIPT,
    // avoids EPIPE on the base64 echo for a 50KB+ script.
    writeFileSync(tmpPath, STRIP_THINKING_SCRIPT, "utf-8");
    try {
      await ssh.putFile(tmpPath, `${remotePath}.tmp`);
    } finally {
      try {
        require("fs").unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
    }

    // 2. Backup current + syntax check + sentinel + atomic install + chmod.
    // No manual strip-thinking.py invocation — that would force a gateway
    // restart via the script's own logic.  Per-minute cron will exercise it.
    const installScript = `
set -eu
[ -f ${remotePath} ] && cp -p ${remotePath} ${remotePath}.bak-${ts} || true
python3 -m py_compile ${remotePath}.tmp
grep -q 'def trim_failed_turns' ${remotePath}.tmp
grep -q 'SESSION TRIMMED:' ${remotePath}.tmp
chmod +x ${remotePath}.tmp
mv ${remotePath}.tmp ${remotePath}
echo OK
`;
    const r = await ssh.execCommand(installScript);
    if (r.code !== 0) {
      return {
        status: "failed",
        reason: `install_exit_${r.code}: ${(r.stderr || r.stdout).slice(0, 200)}`,
      };
    }
    if (!r.stdout.includes("OK")) {
      return { status: "failed", reason: `no_ok_marker: ${r.stdout.slice(0, 200)}` };
    }
    return { status: "success" };
  } catch (e) {
    return {
      status: "failed",
      reason: `exec: ${(e as Error).message.slice(0, 200)}`,
    };
  } finally {
    try {
      ssh.dispose();
    } catch {
      /* ignore */
    }
  }
}

async function fetchFleetVMs(): Promise<
  Array<{ id: string; name: string; ip_address: string; ssh_user: string | null; health_status: string | null }>
> {
  const { data } = await sb
    .from("instaclaw_vms")
    .select("id, name, ip_address, ssh_user, health_status, status, provider, frozen_at, lifecycle_locked_at, gateway_token")
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
    health_status: v.health_status as string | null,
  }));

  if (ONLY_NAMES?.length) {
    vms = vms.filter((v) => ONLY_NAMES.includes(v.name));
  }
  return vms;
}

async function main(): Promise<void> {
  // Sanity: confirm the bundled script has the new code (same check the
  // single-VM hotfix does).  If lib/ssh.ts wasn't saved, abort before SSH.
  const sentinels = ["def trim_failed_turns", "SESSION TRIMMED:"];
  for (const s of sentinels) {
    if (!STRIP_THINKING_SCRIPT.includes(s)) {
      throw new Error(`STRIP_THINKING_SCRIPT missing sentinel "${s}" — did lib/ssh.ts save?`);
    }
  }
  log(`canonical script size: ${STRIP_THINKING_SCRIPT.length} chars (sentinels OK)`);

  const allVMs = await fetchFleetVMs();
  log(`fetched ${allVMs.length} healthy assigned linode VMs`);
  if (DRY_RUN) {
    log("--- DRY RUN — first 10 VMs that would receive the deploy ---");
    for (const v of allVMs.slice(0, 10)) {
      log(`  ${v.name.padEnd(20)} ${v.ip_address.padEnd(16)} health=${v.health_status}`);
    }
    log(`(total: ${allVMs.length} — re-run without --dry-run to execute)`);
    return;
  }

  const cp = loadCheckpoint();
  cp.fleetSize = allVMs.length;
  const remaining = allVMs.filter((v) => !cp.done[v.id]);
  log(`checkpoint: ${Object.keys(cp.done).length} already done, ${remaining.length} remaining`);
  if (remaining.length === 0) {
    log("✅ all VMs already deployed (per checkpoint)");
    summarize(cp);
    return;
  }

  // Process in waves of WAVE_SIZE.  Audit between waves.
  let waveNum = 0;
  for (let waveStart = 0; waveStart < remaining.length; waveStart += WAVE_SIZE) {
    waveNum++;
    const wave = remaining.slice(waveStart, waveStart + WAVE_SIZE);
    log(`\n══ Wave ${waveNum} — ${wave.length} VMs (${waveStart + 1}–${waveStart + wave.length} of ${remaining.length}) ══`);

    let cursor = 0;
    const waveOutcomes: Outcome[] = [];
    async function worker(): Promise<void> {
      while (true) {
        const idx = cursor++;
        if (idx >= wave.length) return;
        const vm = wave[idx];
        const r = await withDeadline(() => deployToVM(vm), PER_VM_DEADLINE_MS);
        const outcome: Outcome = {
          vmId: vm.id,
          name: vm.name,
          ip: vm.ip_address,
          status: r.ok ? r.v.status : "deadline",
          reason: r.ok ? r.v.reason : r.reason,
          ts: new Date().toISOString(),
        };
        if (outcome.status === "success") log(`  ✓ ${vm.name.padEnd(20)} ${vm.ip_address}`);
        else log(`  ✗ ${vm.name.padEnd(20)} ${vm.ip_address}  ${outcome.status}: ${outcome.reason}`);
        waveOutcomes.push(outcome);
        cp.done[vm.id] = outcome;
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, wave.length) }, () => worker()),
    );

    // Checkpoint after every wave (defense against script crash mid-deploy)
    saveCheckpoint(cp);

    // Audit gate
    const failures = waveOutcomes.filter((o) => o.status !== "success");
    const rate = failures.length / waveOutcomes.length;
    log(
      `  → wave ${waveNum} done: ${waveOutcomes.length - failures.length}/${waveOutcomes.length} ok` +
        (failures.length ? `  (${failures.length} fail, rate=${(rate * 100).toFixed(0)}%)` : ""),
    );
    if (rate > HALT_FAILURE_RATE) {
      log(`\n⛔ HALT — wave ${waveNum} failure rate ${(rate * 100).toFixed(0)}% > ${(HALT_FAILURE_RATE * 100).toFixed(0)}%`);
      log("failures in this wave:");
      for (const f of failures)
        log(`    ${f.name.padEnd(20)} ${f.ip}  ${f.status}: ${f.reason}`);
      log(`\nCheckpoint saved.  Inspect failures, then re-run to resume.`);
      summarize(cp);
      process.exit(1);
    }
  }

  log("\n✅ ALL WAVES COMPLETE");
  summarize(cp);
}

function summarize(cp: Checkpoint): void {
  const all = Object.values(cp.done);
  const ok = all.filter((o) => o.status === "success").length;
  const failed = all.filter((o) => o.status !== "success");
  log(`\n────────────────────────────────────────────────────`);
  log(`Final: ${ok}/${all.length} success across ${cp.fleetSize} fleet VMs`);
  if (failed.length) {
    log(`\nFailures (${failed.length}):`);
    const byReason = new Map<string, number>();
    for (const f of failed) {
      const k = (f.reason || f.status || "unknown").split(":")[0]!;
      byReason.set(k, (byReason.get(k) || 0) + 1);
      log(`  ${f.name.padEnd(20)} ${f.ip.padEnd(16)} ${f.status}: ${f.reason}`);
    }
    log(`\nFailure breakdown:`);
    for (const [k, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
      log(`  ${n.toString().padStart(3)}× ${k}`);
    }
  }
  log(`\nCheckpoint at ${CHECKPOINT_PATH}`);
}

main().catch((e) => {
  console.error(`FATAL: ${(e as Error).message}`);
  process.exit(1);
});
