/**
 * Phase 4: Fleet-wide PID exhaustion correlation audit.
 *
 * For every healthy assigned VM, capture in one SSH round-trip:
 *   - Current PID count + ulimit -u
 *   - Zombie count (processes in 'Z' state)
 *   - User-journal fork-error count over last 24h (bounded with `timeout 15`)
 *   - vm-watchdog.py presence + cron-installed status (Saturday's PID fix)
 *   - openclaw user uptime (for context)
 *
 * Aggregate:
 *   - VMs with >0 fork errors in 24h
 *   - VMs missing vm-watchdog.py (which means Saturday's fix didn't land)
 *   - VMs with current zombies > 0
 *   - Any VM with PID count > 50% of ulimit -u (early warning)
 *
 * Output: per-VM TSV + JSON dump for follow-up.
 */
import { readFileSync, writeFileSync } from "fs";
import { connectSSH, type VMRecord } from "../lib/ssh";
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
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const PROBE = `set +e
PIDS=$(ps -eLf 2>/dev/null | wc -l)
ULIM=$(ulimit -u)
ZOM=$(ps axo stat 2>/dev/null | grep -c '^Z')
FORK24H=$(timeout 15 journalctl --user --since '24 hours ago' --no-pager 2>/dev/null | grep -ciE 'fork|EAGAIN|cannot allocate|resource temporarily')
WATCHDOG_PRESENT=N
[ -f /home/openclaw/.openclaw/scripts/vm-watchdog.py ] && WATCHDOG_PRESENT=Y
WATCHDOG_CRON=N
crontab -l 2>/dev/null | grep -q vm-watchdog.py && WATCHDOG_CRON=Y
NODE_PIDS=$(ps -eo comm 2>/dev/null | grep -c '^node$')
SHELL_FORKS=$(ps -eo comm 2>/dev/null | grep -cE '^(sh|bash|dash)$')
GATEWAY_UPTIME_S=$(systemctl --user show -p ActiveEnterTimestamp --value openclaw-gateway 2>/dev/null)
echo "PIDS=$PIDS ULIM=$ULIM ZOM=$ZOM FORK24H=$FORK24H WATCHDOG=$WATCHDOG_PRESENT CRON=$WATCHDOG_CRON NODE=$NODE_PIDS SHELLS=$SHELL_FORKS GW_UP=$GATEWAY_UPTIME_S"
`;

type Probe = {
  vm_name: string;
  partner: string | null;
  pids?: number;
  ulim?: number;
  zombies?: number;
  fork24h?: number;
  watchdog?: "Y" | "N";
  cron?: "Y" | "N";
  node?: number;
  shells?: number;
  gw_up?: string;
  ssh_error?: string;
};

async function probeVM(vm: VMRecord & { partner?: string | null; name?: string | null }): Promise<Probe> {
  const out: Probe = { vm_name: vm.name ?? "?", partner: vm.partner ?? null };
  let ssh;
  try {
    ssh = await connectSSH(vm);
  } catch (e) {
    out.ssh_error = e instanceof Error ? e.message : String(e);
    return out;
  }
  try {
    const r = await ssh.execCommand(PROBE, { execOptions: { pty: false } });
    const m = r.stdout.match(/PIDS=(\d+)\s+ULIM=(\d+)\s+ZOM=(\d+)\s+FORK24H=(\d+)\s+WATCHDOG=(Y|N)\s+CRON=(Y|N)\s+NODE=(\d+)\s+SHELLS=(\d+)\s+GW_UP=(\S+)?/);
    if (!m) {
      out.ssh_error = `parse failure: ${r.stdout.slice(0, 200)}`;
      return out;
    }
    out.pids = Number(m[1]);
    out.ulim = Number(m[2]);
    out.zombies = Number(m[3]);
    out.fork24h = Number(m[4]);
    out.watchdog = m[5] as "Y" | "N";
    out.cron = m[6] as "Y" | "N";
    out.node = Number(m[7]);
    out.shells = Number(m[8]);
    out.gw_up = m[9] || "";
  } finally {
    ssh.dispose();
  }
  return out;
}

(async () => {
  const { data: pool } = await sb.from("instaclaw_vms")
    .select("id,name,ip_address,ssh_port,ssh_user,partner,assigned_to")
    .eq("status", "assigned")
    .eq("health_status", "healthy")
    .not("gateway_url", "is", null)
    .not("assigned_to", "is", null)
    .order("name");

  const targets = pool ?? [];
  console.log(`Phase 4 PID-exhaustion audit: ${targets.length} VMs (concurrency=10)...\n`);

  const results: Probe[] = new Array(targets.length);
  let cur = 0, done = 0;
  async function worker() {
    while (cur < targets.length) {
      const i = cur++;
      const v = targets[i];
      results[i] = await probeVM({
        id: v.id, ip_address: v.ip_address, ssh_port: v.ssh_port, ssh_user: v.ssh_user,
        partner: v.partner, name: v.name,
      } as any);
      done++;
      if (done % 10 === 0) console.log(`  progress ${done}/${targets.length}`);
    }
  }
  await Promise.all(Array.from({ length: 10 }, () => worker()));

  const ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const outPath = `/Users/cooperwrenn/wild-west-bots/instaclaw/scripts/_fleet-pid-audit-${ts}.json`;
  writeFileSync(outPath, JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2));

  const ok = results.filter(r => !r.ssh_error);
  const sshFail = results.filter(r => r.ssh_error);

  // Risk buckets
  const riskFork = ok.filter(r => (r.fork24h ?? 0) > 0).sort((a,b) => (b.fork24h ?? 0) - (a.fork24h ?? 0));
  const riskZombie = ok.filter(r => (r.zombies ?? 0) > 0);
  const noWatchdog = ok.filter(r => r.watchdog === "N");
  const noWatchdogCron = ok.filter(r => r.watchdog === "Y" && r.cron === "N");
  const highPid = ok.filter(r => r.pids && r.ulim && (r.pids / r.ulim) > 0.5);
  const veryHighPid = ok.filter(r => r.pids && r.ulim && (r.pids / r.ulim) > 0.8);

  console.log(`\n══════════════════════════════════════════════════════════════════════`);
  console.log(`  PHASE 4 — PID EXHAUSTION CORRELATION`);
  console.log(`══════════════════════════════════════════════════════════════════════`);
  console.log(`  VMs probed:                 ${results.length}`);
  console.log(`  SSH-reachable:              ${ok.length}`);
  console.log(`  SSH failures:               ${sshFail.length}`);
  console.log(``);
  console.log(`  ── Risk buckets ──`);
  console.log(`  >0 fork errors last 24h:    ${riskFork.length}  ${riskFork.length > 0 ? "← INVESTIGATE" : "✓"}`);
  console.log(`  >0 current zombies:         ${riskZombie.length}  ${riskZombie.length > 0 ? "← INVESTIGATE" : "✓"}`);
  console.log(`  vm-watchdog.py MISSING:     ${noWatchdog.length}  ${noWatchdog.length > 0 ? "← Saturday's fix didn't land" : "✓ all VMs covered"}`);
  console.log(`  watchdog present, NO cron:  ${noWatchdogCron.length}  ${noWatchdogCron.length > 0 ? "← cron not installed" : "✓"}`);
  console.log(`  PID count >50% of ulimit:   ${highPid.length}  ${highPid.length > 0 ? "← warning" : "✓"}`);
  console.log(`  PID count >80% of ulimit:   ${veryHighPid.length}  ${veryHighPid.length > 0 ? "← critical" : "✓"}`);
  console.log(``);

  if (sshFail.length > 0) {
    console.log(`── SSH failures (excluded from analysis) ──`);
    for (const r of sshFail.slice(0, 10)) console.log(`  ${r.vm_name.padEnd(22)} ${r.ssh_error?.slice(0, 80)}`);
    if (sshFail.length > 10) console.log(`  ... ${sshFail.length - 10} more`);
    console.log(``);
  }

  if (riskFork.length > 0) {
    console.log(`── VMs with fork errors in last 24h (top 20) ──`);
    console.log(`${"vm".padEnd(22)} ${"forks".padStart(7)} ${"pids".padStart(6)} ${"zom".padStart(4)} ${"node".padStart(5)} ${"shells".padStart(7)} ${"watchdog".padEnd(9)} cron`);
    for (const r of riskFork.slice(0, 20)) {
      console.log(`${r.vm_name.padEnd(22)} ${String(r.fork24h).padStart(7)} ${String(r.pids).padStart(6)} ${String(r.zombies).padStart(4)} ${String(r.node).padStart(5)} ${String(r.shells).padStart(7)} ${(r.watchdog ?? "?").padEnd(9)} ${r.cron}`);
    }
  }

  if (noWatchdog.length > 0) {
    console.log(`\n── VMs MISSING vm-watchdog.py (P1 — Saturday's PID fix didn't land) ──`);
    for (const r of noWatchdog.slice(0, 30)) console.log(`  ${r.vm_name.padEnd(22)} partner=${r.partner ?? "-"} pids=${r.pids} zombies=${r.zombies}`);
    if (noWatchdog.length > 30) console.log(`  ... ${noWatchdog.length - 30} more`);
  }

  if (noWatchdogCron.length > 0) {
    console.log(`\n── VMs with vm-watchdog.py present but NO cron entry ──`);
    for (const r of noWatchdogCron.slice(0, 20)) console.log(`  ${r.vm_name.padEnd(22)} partner=${r.partner ?? "-"}`);
  }

  if (riskZombie.length > 0) {
    console.log(`\n── VMs with current zombies ──`);
    for (const r of riskZombie) console.log(`  ${r.vm_name.padEnd(22)} zombies=${r.zombies}`);
  }

  if (veryHighPid.length > 0) {
    console.log(`\n── VMs at >80% of ulimit (CRITICAL) ──`);
    for (const r of veryHighPid) console.log(`  ${r.vm_name.padEnd(22)} pids=${r.pids}/${r.ulim} (${((r.pids!/r.ulim!)*100).toFixed(0)}%)`);
  }

  console.log(``);
  console.log(`  Raw results: ${outPath}`);
  console.log(`══════════════════════════════════════════════════════════════════════`);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
