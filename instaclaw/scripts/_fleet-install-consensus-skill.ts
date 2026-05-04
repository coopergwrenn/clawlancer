/**
 * Fleet-install the consensus-2026 skill on every healthy assigned VM.
 *
 * 2026-05-04 launch day: Cooper wants the launch thread to link to
 * instaclaw.io (main page) instead of /consensus.  For that to work, every
 * existing VM (and every new signup, via the lib/ssh.ts gate-drop) needs the
 * consensus skill installed regardless of partner tag.
 *
 * What this script does, per VM:
 *   1. SSH in
 *   2. If ~/.openclaw/skills/consensus-2026 doesn't exist, git clone it
 *   3. Add a 30-min refresh cron (idempotent)
 *   4. Verify SKILL.md and data/sessions.json exist
 *
 * Pattern matches _fleet-push-strip-thinking-v80.ts:
 *   - Concurrency=5, wave=20, halt at 25%
 *   - Per-VM deadline 45s
 *   - Resume-safe checkpoint
 *   - No gateway restart needed (skill is read on-demand via SOUL.md guidance)
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
const PER_VM_DEADLINE_MS = 45_000;
const HALT_FAILURE_RATE = 0.25;
const CHECKPOINT_PATH = "/tmp/fleet-consensus-skill-progress.json";
const LOG_PATH = `/tmp/fleet-consensus-skill-${new Date().toISOString().slice(0, 10)}.log`;

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const RESET_CHECKPOINT = args.includes("--reset");

interface Outcome { vmId: string; name: string; ip: string; status: "success" | "failed" | "already_installed"; reason?: string; ts: string; }
interface Checkpoint { startedAt: string; fleetSize: number; done: Record<string, Outcome>; }

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try { writeFileSync(LOG_PATH, line + "\n", { flag: "a" }); } catch { /* ignore */ }
}

function loadCheckpoint(): Checkpoint {
  if (RESET_CHECKPOINT || !existsSync(CHECKPOINT_PATH)) return { startedAt: new Date().toISOString(), fleetSize: 0, done: {} };
  try { return JSON.parse(readFileSync(CHECKPOINT_PATH, "utf-8")) as Checkpoint; }
  catch { return { startedAt: new Date().toISOString(), fleetSize: 0, done: {} }; }
}
function saveCheckpoint(cp: Checkpoint): void { writeFileSync(CHECKPOINT_PATH, JSON.stringify(cp, null, 2)); }

async function withDeadline<T>(fn: () => Promise<T>, ms: number): Promise<{ ok: true; v: T } | { ok: false; reason: string }> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const dl = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("DEADLINE")), ms); });
  try { return { ok: true, v: await Promise.race([fn(), dl]) }; }
  catch (e) {
    if (e instanceof Error && e.message === "DEADLINE") return { ok: false, reason: "deadline" };
    return { ok: false, reason: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200) };
  } finally { if (timer) clearTimeout(timer); }
}

const INSTALL_SCRIPT = String.raw`
set -eu
SKILL_DIR="$HOME/.openclaw/skills/consensus-2026"
ALREADY_INSTALLED=0

if [ -d "$SKILL_DIR/.git" ] && [ -f "$SKILL_DIR/SKILL.md" ] && [ -f "$SKILL_DIR/data/sessions.json" ]; then
  # Already cloned + healthy. Just refresh cron and pull latest.
  cd "$SKILL_DIR" && git pull --ff-only -q 2>/dev/null || true
  ALREADY_INSTALLED=1
else
  # Fresh install (or clean up any partial state)
  rm -rf "$SKILL_DIR" 2>/dev/null || true
  mkdir -p "$HOME/.openclaw/skills"
  git clone --depth 1 https://github.com/coopergwrenn/consensus-2026-skill.git "$SKILL_DIR" 2>&1
fi

# Verify install
[ -f "$SKILL_DIR/SKILL.md" ] || { echo "ERR_NO_SKILL_MD"; exit 1; }
[ -f "$SKILL_DIR/data/sessions.json" ] || { echo "ERR_NO_DATA"; exit 1; }
SESSIONS=$(python3 -c "import json; d=json.load(open('$SKILL_DIR/data/sessions.json')); print(len(d.get('records', [])) if isinstance(d, dict) else len(d))" 2>/dev/null || echo "0")
[ "$SESSIONS" -ge 200 ] || { echo "ERR_LOW_SESSION_COUNT=$SESSIONS"; exit 1; }

# Idempotent cron — refresh every 30 min
(crontab -l 2>/dev/null | grep -v "consensus-2026-skill" | grep -v "skills/consensus-2026" ; echo "*/30 * * * * cd \$HOME/.openclaw/skills/consensus-2026 && git pull --ff-only -q 2>/dev/null") | crontab -

if [ "$ALREADY_INSTALLED" = "1" ]; then
  echo "ALREADY_INSTALLED sessions=$SESSIONS"
else
  echo "INSTALLED sessions=$SESSIONS"
fi
`;

async function deployToVM(vm: { id: string; name: string; ip_address: string; ssh_user: string | null }): Promise<{ status: "success" | "already_installed" | "failed"; reason?: string }> {
  const ssh = new NodeSSH();
  const username = vm.ssh_user || "openclaw";
  try {
    await ssh.connect({ host: vm.ip_address, username, privateKey: sshKey, readyTimeout: 12_000 });
  } catch (e) {
    return { status: "failed", reason: `ssh: ${(e as Error).message.slice(0, 100)}` };
  }
  try {
    const r = await ssh.execCommand(INSTALL_SCRIPT);
    if (r.code !== 0) return { status: "failed", reason: `exit_${r.code}: ${(r.stderr || r.stdout).slice(0, 200)}` };
    if (r.stdout.includes("ALREADY_INSTALLED")) return { status: "already_installed" };
    if (r.stdout.includes("INSTALLED")) return { status: "success" };
    return { status: "failed", reason: `no_marker: ${r.stdout.slice(0, 200)}` };
  } catch (e) {
    return { status: "failed", reason: `exec: ${(e as Error).message.slice(0, 200)}` };
  } finally {
    try { ssh.dispose(); } catch { /* ignore */ }
  }
}

async function fetchFleetVMs(): Promise<Array<{ id: string; name: string; ip_address: string; ssh_user: string | null }>> {
  const { data } = await sb.from("instaclaw_vms")
    .select("id, name, ip_address, ssh_user")
    .eq("status", "assigned").eq("provider", "linode").eq("health_status", "healthy")
    .is("frozen_at", null).is("lifecycle_locked_at", null)
    .not("ip_address", "is", null).not("gateway_token", "is", null)
    .order("name", { ascending: true });
  return (data || []).map((v) => ({
    id: v.id as string, name: v.name as string, ip_address: v.ip_address as string,
    ssh_user: (v.ssh_user as string) || null,
  }));
}

async function main(): Promise<void> {
  const allVMs = await fetchFleetVMs();
  log(`fleet: ${allVMs.length} healthy assigned linode VMs`);
  if (DRY_RUN) {
    log(`DRY RUN — would install consensus-2026 skill on ${allVMs.length} VMs`);
    for (const v of allVMs.slice(0, 5)) log(`  ${v.name.padEnd(22)} ${v.ip_address}`);
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
        const sym = outcome.status === "success" ? "✓" : outcome.status === "already_installed" ? "·" : "✗";
        log(`  ${sym} ${vm.name.padEnd(22)} ${vm.ip_address.padEnd(16)} ${outcome.status === "failed" ? (outcome.reason || "").slice(0, 80) : outcome.status}`);
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
      process.exit(2);
    }
  }
  const done = Object.values(cp.done);
  const ok = done.filter((d) => d.status === "success").length;
  const cached = done.filter((d) => d.status === "already_installed").length;
  const fail = done.filter((d) => d.status === "failed").length;
  log(``);
  log(`✅ ALL WAVES COMPLETE`);
  log(`Final: ${ok} fresh installs, ${cached} already-installed, ${fail} failed across ${done.length} VMs`);
  if (fail > 0) {
    for (const o of done.filter((d) => d.status === "failed").slice(0, 12)) {
      log(`  ${o.name.padEnd(22)} ${o.ip.padEnd(16)} ${(o.reason || "").slice(0, 80)}`);
    }
  }
}

main().catch((e) => { console.error("FATAL:", (e as Error).message); process.exit(1); });
