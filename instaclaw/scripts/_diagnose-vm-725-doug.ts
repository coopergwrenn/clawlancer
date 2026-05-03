/**
 * P0 emergency diagnostic for vm-725 (Doug Rathell, afd359@gmail.com).
 * Active user agent bricked — every Telegram message returns
 * "Something went wrong while processing your request", including /new.
 *
 * Hypotheses (in likelihood order):
 *   1. Gateway crashed and won't come up (config error from recent reconcile,
 *      bad systemd state, port collision, missing dist file).
 *   2. Strip-thinking.py hotfix triggered a restart that didn't recover
 *      cleanly on this VM specifically.
 *   3. Mass-reconcile-v79 in progress — config mismatch / strict-hold.
 *   4. Session corruption from humanrequired.shop scraping task — but
 *      /new should still work, so this alone shouldn't be the brick.
 *   5. SSH bridge / proxy auth issue — gateway up but proxy can't reach.
 *
 * Data to collect in one round-trip:
 *   - DB row for vm-725 (status, partner, gateway_url, config_version, health)
 *   - User row (afd359@gmail.com)
 *   - SSH gateway status, last 200 journal lines, errors-only since 1h ago
 *   - Session state (~/.openclaw/sessions, sessions.json, archive dir)
 *   - strip-thinking.py: deployed version + last 20 cron logs
 *   - openclaw process: running? port 18789 bound? RAM/CPU pressure?
 *   - Recent restart count (systemd)
 *   - Disk free + tmp free + .openclaw size
 *   - Gateway /health probe from inside the box
 */
import { readFileSync } from "fs";
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

async function main(): Promise<void> {
  // 1. DB lookup
  const { data: vmRows } = await sb
    .from("instaclaw_vms")
    .select("*")
    .eq("name", "instaclaw-vm-725");
  const vm = vmRows?.[0];
  if (!vm) throw new Error("vm-725 not found in DB");
  console.log("=== DB: vm-725 ===");
  for (const k of [
    "id", "name", "ip_address", "status", "health_status", "config_version",
    "telegram_bot_username", "partner", "assigned_to", "tier", "subscription_status",
    "frozen_at", "lifecycle_locked_at", "configure_lock_at",
    "watchdog_consecutive_failures", "watchdog_quarantined_at", "cron_breaker_active",
    "last_health_check", "ssh_fail_count", "configure_attempts",
    "last_user_activity_at", "heartbeat_status", "heartbeat_last_at",
    "gateway_url", "control_ui_url",
  ]) {
    if (k in vm && vm[k] !== null && vm[k] !== undefined) {
      console.log(`  ${k}: ${typeof vm[k] === "string" && (vm[k] as string).length > 100 ? `<${(vm[k] as string).length}c>` : JSON.stringify(vm[k])}`);
    }
  }

  // User row
  const { data: user } = await sb
    .from("instaclaw_users")
    .select("id, email, partner, created_at")
    .eq("id", vm.assigned_to)
    .single();
  console.log("\n=== DB: user ===");
  console.log(`  ${JSON.stringify(user)}`);

  // 2. SSH
  console.log(`\n=== SSH ${vm.ip_address} ===`);
  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host: vm.ip_address, username: vm.ssh_user || "openclaw", privateKey: sshKey, readyTimeout: 12_000 });
  } catch (e) {
    console.log(`SSH connect failed as ${vm.ssh_user || "openclaw"}: ${(e as Error).message}`);
    try {
      await ssh.connect({ host: vm.ip_address, username: "root", privateKey: sshKey, readyTimeout: 12_000 });
    } catch (e2) {
      console.log(`SSH connect failed as root: ${(e2 as Error).message}`);
      throw new Error("Cannot SSH — VM may be down or networking blocked");
    }
  }

  const probes = [
    { label: "gateway is-active",       cmd: `systemctl --user is-active openclaw-gateway 2>&1; systemctl --user is-failed openclaw-gateway 2>&1` },
    { label: "gateway show",            cmd: `systemctl --user show openclaw-gateway --property=ActiveState,SubState,Result,ActiveEnterTimestamp,InactiveEnterTimestamp,NRestarts,ExecMainStatus,ExecMainCode,LoadState 2>&1` },
    { label: "port 18789 bound?",       cmd: `ss -tlnp 2>/dev/null | grep 18789 || echo "NOT BOUND"` },
    { label: "gateway /health (local)", cmd: `curl -sS --max-time 5 -o /dev/null -w "HTTP %{http_code} time=%{time_total}s\\n" http://localhost:18789/health 2>&1` },
    { label: "openclaw process count",  cmd: `pgrep -af openclaw | head -5; echo "---"; pgrep -af "openclaw-gateway|node.*openclaw" | wc -l` },
    { label: "journal last 60 (gateway)", cmd: `journalctl --user -u openclaw-gateway -n 60 --no-pager 2>&1` },
    { label: "journal errors since 30 min", cmd: `journalctl --user -u openclaw-gateway --since '30 min ago' --no-pager 2>&1 | grep -iE '(error|fail|fatal|abort|exit|signal|crash|kill)' | tail -30` },
    { label: "telegram-related events 30 min", cmd: `journalctl --user -u openclaw-gateway --since '30 min ago' --no-pager 2>&1 | grep -iE '(telegram|something went wrong|Hey Cooper|/new|process_message|incoming)' | tail -30` },
    { label: "recent restarts",         cmd: `journalctl --user -u openclaw-gateway --since '1 hour ago' --no-pager 2>&1 | grep -E "(Stopping|Starting|Started|Stopped)" | tail -20` },
    { label: "session jsonl files (active)", cmd: `ls -laht $HOME/.openclaw/agents/main/sessions/*.jsonl 2>/dev/null | head -10; echo "---"; cat $HOME/.openclaw/agents/main/sessions/sessions.json 2>/dev/null | head -50` },
    { label: "sessions archive recent", cmd: `ls -laht $HOME/.openclaw/agents/main/sessions/archive/ 2>/dev/null | head -15` },
    { label: "session-degraded flag",   cmd: `ls -la $HOME/.openclaw/agents/main/sessions/.session-degraded 2>/dev/null; cat $HOME/.openclaw/agents/main/sessions/.session-degraded 2>/dev/null` },
    { label: "circuit breaker flag",    cmd: `ls -la $HOME/.openclaw/agents/main/sessions/.circuit-breaker-tripped 2>/dev/null; cat $HOME/.openclaw/agents/main/sessions/.circuit-breaker-tripped 2>/dev/null` },
    { label: "strip-thinking.py version", cmd: `wc -l $HOME/.openclaw/scripts/strip-thinking.py; grep -c "def trim_failed_turns\\|SESSION TRIMMED:" $HOME/.openclaw/scripts/strip-thinking.py` },
    { label: "strip-thinking last cron output", cmd: `journalctl --user --since '10 min ago' --no-pager 2>&1 | grep -E "(SESSION DEGRADED|SESSION TRIMMED|SESSION QUALITY|Stripped|Restart|Gateway uptime)" | tail -15` },
    { label: "cron log",                cmd: `tail -30 /var/log/syslog 2>/dev/null | grep -iE "cron|strip-thinking" | tail -15; echo "---"; ls -la /tmp/strip-thinking* 2>/dev/null | head -10` },
    { label: "memory + disk",           cmd: `free -m | head -3; echo "---"; df -h $HOME 2>&1 | tail -2; echo "---"; du -sh $HOME/.openclaw 2>/dev/null; du -sh $HOME/.openclaw/sessions $HOME/.openclaw/agents/main/sessions 2>/dev/null` },
    { label: "OOM signals",             cmd: `dmesg 2>/dev/null | grep -iE "(killed|oom|out of memory)" | tail -10; echo "---"; journalctl --user --since '1 hour ago' --no-pager 2>&1 | grep -iE "oom|killed" | tail -10` },
    { label: "openclaw config (auth)",  cmd: `cat $HOME/.openclaw/openclaw.json | python3 -c "import json,sys; c=json.load(sys.stdin); print(json.dumps({'auth':c.get('gateway',{}).get('auth'),'agent':c.get('agent',{}).get('model'),'agents.defaults.timeoutSeconds':c.get('agents',{}).get('defaults',{}).get('timeoutSeconds')},indent=2))" 2>&1` },
    { label: "strict-mode + reconcile state", cmd: `echo "config_version on disk:"; cat $HOME/.openclaw/.config_version 2>/dev/null || echo "(no marker)"; echo "---"; ls -la $HOME/.openclaw/scripts/*.bak* 2>/dev/null | tail -5` },
    { label: "auth-profiles.json sane?", cmd: `cat $HOME/.openclaw/agents/main/agent/auth-profiles.json 2>/dev/null | python3 -c "import json,sys; p=json.load(sys.stdin).get('profiles',{}); [print(k,'baseUrl=',v.get('baseUrl'),'keyLen=',len(v.get('key','') or '')) for k,v in p.items()]" 2>&1` },
  ];

  for (const p of probes) {
    console.log(`\n--- ${p.label} ---`);
    const r = await ssh.execCommand(p.cmd, { execOptions: { pty: false } });
    if (r.stdout) console.log(r.stdout.trim().split("\n").slice(0, 80).join("\n"));
    if (r.stderr && r.stderr.trim()) {
      const e = r.stderr.trim().split("\n").slice(0, 5).join("\n");
      if (e) console.log(`STDERR: ${e}`);
    }
  }

  ssh.dispose();
}

main().catch((e) => {
  console.error(`FATAL: ${(e as Error).message}`);
  process.exit(1);
});
