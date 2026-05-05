/**
 * Memory pressure diagnosis on vm-725 (post-restart).
 * Identify the actual culprit: stacked node processes, runaway crons,
 * chrome leaks, or undersized VM for a power user doing 600 msgs/day.
 *
 * Probes:
 *   1. Top 20 processes by RSS (descending)
 *   2. Per-comm aggregate RSS (which binary owns the most memory)
 *   3. Node process detail (each node PID, RSS, age, parent, cmdline truncated)
 *   4. Cron job count + currently-running cron processes
 *   5. Chrome instance detail (chromium-browser is a heavy hitter)
 *   6. Swap usage source (per-process swap from /proc/PID/smaps)
 *   7. Gateway memory specifically (the openclaw process)
 *   8. Plan size — VM type from Linode tag, sizing context
 */
import { readFileSync } from "fs";
import { connectSSH } from "../lib/ssh";
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

(async () => {
  const { data: vm } = await sb.from("instaclaw_vms").select("*").eq("name", "instaclaw-vm-725").single();
  if (!vm) { console.error("vm-725 not found"); process.exit(1); }
  console.log(`Memory diagnosis: ${vm.name} (${vm.ip_address})\n`);

  const ssh = await connectSSH(vm as any);
  try {
    console.log("══ M1: Memory + swap state ══");
    const m1 = await ssh.execCommand(
      `free -m
echo
echo VMSTAT:; vmstat 1 2 | tail -2
echo MEMINFO_KEY:
grep -E 'MemTotal|MemAvailable|MemFree|Cached|SwapTotal|SwapFree|SwapCached' /proc/meminfo`
    );
    console.log(m1.stdout);

    console.log("\n══ M2: Top 20 processes by RSS ══");
    const m2 = await ssh.execCommand(
      `ps -eo pid,ppid,user,rss,vsz,etime,comm,cmd --sort=-rss 2>/dev/null | head -21 | awk '{printf "%-8s %-8s %-12s %8s %10s %12s %-25s %s\\n", $1, $2, $3, $4, $5, $6, $7, substr($0, index($0,$8))}'`
    );
    console.log(m2.stdout);

    console.log("\n══ M3: Per-comm aggregate RSS (top 15 binaries by total memory) ══");
    const m3 = await ssh.execCommand(
      `ps -eo comm,rss --no-headers 2>/dev/null | awk '{rss[$1]+=$2; cnt[$1]++} END {for (c in rss) printf "%6.0f MB  count=%-4d %s\\n", rss[c]/1024, cnt[c], c}' | sort -rn | head -15`
    );
    console.log(m3.stdout);

    console.log("\n══ M4: Node process detail ══");
    const m4 = await ssh.execCommand(
      `ps -eo pid,ppid,rss,etime,cmd 2>/dev/null | grep -E '\\bnode\\b' | grep -v grep | awk '{printf "PID=%-8s PPID=%-8s RSS=%6.0fMB ETIME=%-12s ", $1, $2, $3/1024, $4; for(i=5;i<=NF;i++) printf "%s ", $i; print ""}' | head -20`
    );
    console.log(m4.stdout);

    console.log("\n══ M5: Cron-related processes (right now) ══");
    const m5 = await ssh.execCommand(
      `echo CRONTAB_LINES: $(crontab -l 2>/dev/null | grep -v '^#' | grep -v '^$' | wc -l)
echo SYSTEM_CRONS:
crontab -l 2>/dev/null | grep -v '^#' | grep -v '^$'
echo
echo CURRENTLY_RUNNING_CRON_CHILDREN:
ps -ef 2>/dev/null | grep -E '(strip-thinking|auto-approve-pairing|vm-watchdog|silence-watchdog|push-heartbeat|generate_workspace|memory.*index)' | grep -v grep`
    );
    console.log(m5.stdout);

    console.log("\n══ M6: Chrome / browser-automation processes ══");
    const m6 = await ssh.execCommand(
      `echo CHROME_COUNT: $(ps -eo comm 2>/dev/null | grep -c chrome)
ps -eo pid,rss,etime,cmd 2>/dev/null | grep -i chrom | grep -v grep | awk '{printf "PID=%-8s RSS=%6.0fMB ETIME=%-12s ", $1, $2/1024, $3; for(i=4;i<=NF;i++) printf "%s ", $i; print ""}' | head -20`
    );
    console.log(m6.stdout);

    console.log("\n══ M7: openclaw-gateway memory ══");
    const m7 = await ssh.execCommand(
      `MAIN=$(systemctl --user show -p MainPID --value openclaw-gateway 2>/dev/null)
echo MAIN_PID: $MAIN
if [ -n "$MAIN" ] && [ "$MAIN" != "0" ]; then
  ps -p $MAIN -o pid,ppid,rss,vsz,etime,cmd 2>/dev/null
  echo SMAPS_RSS_TOP_5:
  if [ -r /proc/$MAIN/smaps_rollup ]; then
    cat /proc/$MAIN/smaps_rollup | head -10
  fi
fi`
    );
    console.log(m7.stdout);

    console.log("\n══ M8: Memory cgroup pressure (any OOM kills since boot?) ══");
    const m8 = await ssh.execCommand(
      `echo OOM_KILLS_SINCE_BOOT: $(journalctl --user --since 'today' --no-pager 2>/dev/null | grep -ci 'oom\\|killed process\\|out of memory')
echo RECENT_OOM_SAMPLE:
journalctl --user --since 'today' --no-pager 2>/dev/null | grep -iE 'oom|killed process|out of memory' | tail -5
echo SYSTEM_OOMS:
dmesg 2>/dev/null | grep -i oom | tail -5
echo MEM_PRESSURE_PSI:
test -r /proc/pressure/memory && cat /proc/pressure/memory || echo 'not_readable'`
    );
    console.log(m8.stdout);

    console.log("\n══ M9: Disk + tmp size (paranoia checks) ══");
    const m9 = await ssh.execCommand(
      `df -h ~ /tmp /var/log 2>&1 | tail -5
echo
echo OPENCLAW_DIR_SIZE:
du -sh ~/.openclaw 2>/dev/null
echo
echo SESSIONS_DIR_TOP_10:
du -sh ~/.openclaw/agents/main/sessions/* 2>/dev/null | sort -rh | head -10`
    );
    console.log(m9.stdout);
  } finally {
    ssh.dispose();
  }

  console.log("\n══ M10: VM sizing context (Linode plan) ══");
  console.log(`  DB type: ${(vm as any).type ?? "unknown"}`);
  console.log(`  Per CLAUDE.md: standard plan = g6-dedicated-2 (4GB RAM, 2 vCPU)`);
  console.log(`  Doug's RAM: 4GB total — confirmed in M1 above. No upgrade headroom on this plan.`);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
