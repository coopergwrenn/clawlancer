/**
 * Fleet bump: agents.defaults.timeoutSeconds → 300.
 *
 * Same shape as _fleet-bump-bootstrap-max.ts but using the safer sequence we
 * learned the hard way today: STOP → SET → START rather than SET → RESTART.
 * The set+immediate-restart pattern raced with OpenClaw's startup-time
 * config-write and corrupted vm-544's openclaw.json (0-byte file).  With
 * stop-first, only one process writes openclaw.json at a time.
 *
 * Per-VM op (≤180s budget):
 *   1. SSH connect
 *   2. openclaw config get timeoutSeconds (capture pre-state)
 *   3. systemctl stop openclaw-gateway (5s settle)
 *   4. openclaw config set timeoutSeconds 300 (raw int, NOT string)
 *   5. systemctl start openclaw-gateway
 *   6. Poll /health for HTTP 200 (up to 150s — gateway needs ~30-90s startup)
 *   7. Verify config get returns 300
 *
 * Halt protection / filter / checkpoint: identical to bootstrap-max script.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { NodeSSH } from "node-ssh";

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
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const sshKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");

const CONCURRENCY = 5;
const WAVE_SIZE = 20;
const PER_VM_DEADLINE_MS = 180_000;
const HALT_FAILURE_RATE = 0.25;
const HEALTH_POLL_INTERVAL_MS = 10_000;
const HEALTH_POLL_MAX_ITER = 15; // 15 × 10s = 150s
const CHECKPOINT_PATH = "/tmp/fleet-timeout-seconds-progress.json";
const TARGET_VALUE = 300;

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const RESET = args.includes("--reset");
const ONLY = args.find((a) => a.startsWith("--only="))?.slice(7)?.split(",").map((s) => s.trim()).filter(Boolean);

interface Outcome {
  vmId: string; name: string; ip: string;
  status: "success" | "ssh_fail" | "verify_fail" | "restart_unhealthy" | "exec_fail" | "deadline";
  preValue: string | null; postValue: string | null;
  reason?: string; ts: string;
}
interface Checkpoint { startedAt: string; fleetSize: number; done: Record<string, Outcome>; }

function log(m: string) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`); }
function loadCp(): Checkpoint {
  if (RESET || !existsSync(CHECKPOINT_PATH)) return { startedAt: new Date().toISOString(), fleetSize: 0, done: {} };
  try { return JSON.parse(readFileSync(CHECKPOINT_PATH, "utf-8")); } catch { return { startedAt: new Date().toISOString(), fleetSize: 0, done: {} }; }
}
function saveCp(cp: Checkpoint) { writeFileSync(CHECKPOINT_PATH, JSON.stringify(cp, null, 2)); }

async function withDeadline<T>(fn: () => Promise<T>, ms: number): Promise<{ ok: true; v: T } | { ok: false; reason: string }> {
  let t: ReturnType<typeof setTimeout> | null = null;
  const dl = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error("deadline")), ms); });
  try { return { ok: true, v: await Promise.race([fn(), dl]) }; }
  catch (e) { return { ok: false, reason: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200) }; }
  finally { if (t) clearTimeout(t); }
}

async function bumpVM(vm: { id: string; name: string; ip_address: string; ssh_user: string | null }): Promise<Outcome> {
  const ssh = new NodeSSH();
  const username = vm.ssh_user || "openclaw";
  const base: Outcome = { vmId: vm.id, name: vm.name, ip: vm.ip_address, status: "success", preValue: null, postValue: null, ts: new Date().toISOString() };
  try {
    await ssh.connect({ host: vm.ip_address, username, privateKey: sshKey, readyTimeout: 12_000 });
  } catch (e) {
    return { ...base, status: "ssh_fail", reason: (e as Error).message.slice(0, 100) };
  }
  try {
    // SAFER SEQUENCE: stop → set (no gateway running) → start.
    // Avoids the concurrent-write race that corrupted vm-544 earlier today.
    const r = await ssh.execCommand(`
set -eu
source ~/.nvm/nvm.sh 2>/dev/null
export XDG_RUNTIME_DIR="/run/user/$(id -u)"

PRE=$(openclaw config get agents.defaults.timeoutSeconds 2>/dev/null || echo "(unset)")
echo "PRE=$PRE"

systemctl --user stop openclaw-gateway 2>&1 | head -2
sleep 5

openclaw config set agents.defaults.timeoutSeconds ${TARGET_VALUE} 2>&1 | head -3

# Validate JSON before restarting (Rule-22 spirit — never start a corrupted config)
python3 -c "import json; json.load(open(\\"$HOME/.openclaw/openclaw.json\\"))" 2>&1 | head -1

systemctl --user start openclaw-gateway 2>&1 | head -2

HEALTHY=no
for i in $(seq 1 ${HEALTH_POLL_MAX_ITER}); do
  sleep $((${HEALTH_POLL_INTERVAL_MS} / 1000))
  CODE=$(curl -sS --max-time 5 -o /dev/null -w "%{http_code}" http://localhost:18789/health 2>/dev/null || echo 000)
  if [ "$CODE" = "200" ]; then HEALTHY=yes; echo "HEALTH_OK_AT=$((i*${HEALTH_POLL_INTERVAL_MS}/1000))s"; break; fi
done
if [ "$HEALTHY" != "yes" ]; then echo "HEALTH_FAIL"; exit 50; fi

POST=$(openclaw config get agents.defaults.timeoutSeconds 2>/dev/null || echo "(unset)")
echo "POST=$POST"
if [ "$POST" != "${TARGET_VALUE}" ]; then echo "VERIFY_FAIL"; exit 51; fi
echo "OK"
`);

    const out = (r.stdout || "").trim();
    const preMatch = out.match(/PRE=(\S+)/);
    const postMatch = out.match(/POST=(\S+)/);
    base.preValue = preMatch?.[1] ?? null;
    base.postValue = postMatch?.[1] ?? null;
    if (r.code === 50) return { ...base, status: "restart_unhealthy", reason: "gateway not /health 200 within 150s" };
    if (r.code === 51) return { ...base, status: "verify_fail", reason: `post=${base.postValue} expected ${TARGET_VALUE}` };
    if (r.code !== 0) return { ...base, status: "exec_fail", reason: `exit=${r.code} stderr=${(r.stderr || "").slice(0, 150)}` };
    if (!out.includes("OK")) return { ...base, status: "exec_fail", reason: "no OK marker" };
    return base;
  } catch (e) {
    return { ...base, status: "exec_fail", reason: (e as Error).message.slice(0, 150) };
  } finally {
    try { ssh.dispose(); } catch { /* ignore */ }
  }
}

async function fetchVMs() {
  const { data } = await sb.from("instaclaw_vms")
    .select("id, name, ip_address, ssh_user")
    .eq("status", "assigned").eq("provider", "linode").eq("health_status", "healthy")
    .is("frozen_at", null).is("lifecycle_locked_at", null)
    .not("ip_address", "is", null).not("gateway_token", "is", null)
    .order("name");
  let vms = (data || []).map((v) => ({ id: v.id as string, name: v.name as string, ip_address: v.ip_address as string, ssh_user: (v.ssh_user as string) || null }));
  if (ONLY?.length) vms = vms.filter((v) => ONLY.includes(v.name));
  return vms;
}

function summarize(cp: Checkpoint): void {
  const all = Object.values(cp.done);
  const ok = all.filter((o) => o.status === "success").length;
  const fails = all.filter((o) => o.status !== "success");
  log(`\n${"─".repeat(60)}`);
  log(`Final: ${ok}/${all.length} success across ${cp.fleetSize} VMs`);
  if (fails.length) {
    const byStatus = new Map<string, number>();
    for (const f of fails) byStatus.set(f.status, (byStatus.get(f.status) ?? 0) + 1);
    log(`Failure breakdown:`);
    for (const [k, v] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) log(`  ${v} × ${k}`);
    log(`Detail (first 12):`);
    for (const f of fails.slice(0, 12)) log(`  ${f.name.padEnd(20)} ${f.ip.padEnd(16)} ${f.status}: ${f.reason ?? ""}`);
  }
  log(`Checkpoint at ${CHECKPOINT_PATH}`);
}

async function main(): Promise<void> {
  const allVMs = await fetchVMs();
  log(`Fetched ${allVMs.length} healthy assigned linode VMs`);
  if (DRY_RUN) {
    log(`--dry-run: not connecting. First 10:`);
    for (const v of allVMs.slice(0, 10)) log(`  ${v.name.padEnd(20)} ${v.ip_address}`);
    return;
  }
  const cp = loadCp();
  cp.fleetSize = allVMs.length;
  const remaining = allVMs.filter((v) => !cp.done[v.id]);
  log(`Checkpoint: ${Object.keys(cp.done).length} already done, ${remaining.length} remaining`);
  if (remaining.length === 0) { summarize(cp); return; }

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
        const r = await withDeadline(() => bumpVM(vm), PER_VM_DEADLINE_MS);
        const outcome: Outcome = r.ok ? r.v : { vmId: vm.id, name: vm.name, ip: vm.ip_address, status: "deadline", preValue: null, postValue: null, reason: r.reason, ts: new Date().toISOString() };
        if (outcome.status === "success") log(`  ✓ ${vm.name.padEnd(20)} ${vm.ip_address}  pre=${outcome.preValue} post=${outcome.postValue}`);
        else log(`  ✗ ${vm.name.padEnd(20)} ${vm.ip_address}  ${outcome.status}: ${outcome.reason ?? ""}`);
        waveOutcomes.push(outcome);
        cp.done[vm.id] = outcome;
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, wave.length) }, () => worker()));
    saveCp(cp);
    const fails = waveOutcomes.filter((o) => o.status !== "success");
    const rate = fails.length / waveOutcomes.length;
    log(`  → wave ${waveNum} done: ${waveOutcomes.length - fails.length}/${waveOutcomes.length} ok` + (fails.length ? `  (${fails.length} fail, rate=${(rate * 100).toFixed(0)}%)` : ""));
    if (rate > HALT_FAILURE_RATE) {
      log(`\n⛔ HALT — wave ${waveNum} failure rate ${(rate * 100).toFixed(0)}% > ${(HALT_FAILURE_RATE * 100).toFixed(0)}%`);
      summarize(cp);
      process.exit(1);
    }
  }
  log("\n✅ ALL WAVES COMPLETE");
  summarize(cp);
}

main().catch((e) => { console.error(`FATAL: ${(e as Error).message}`); process.exit(1); });
