/**
 * vm-724 deep diagnostic — Phase 4 flagged this VM with 34 fork errors in
 * last 24h + 1 current zombie. Higher than any other VM in the audit.
 *
 * Probes:
 *   1. DB + user + billing context
 *   2. Process snapshot (tree, top by RSS, fork-heavy parents)
 *   3. Zombie identification (parent process, command, age)
 *   4. Last 24h fork-error journal sample (causes/sources)
 *   5. Cron audit — anything spawning excessive subshells?
 *   6. Gateway health
 *   7. Memory + load + uptime context
 *   8. Specific dgclaw / scripts that are heavy spawners
 */
import { readFileSync } from "fs";
import { connectSSH } from "../lib/ssh";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { getBillingStatusVerified } from "../lib/billing-status";

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
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

(async () => {
  const { data: vm } = await sb.from("instaclaw_vms").select("*").eq("name", "instaclaw-vm-724").single();
  if (!vm) { console.error("vm-724 not found"); process.exit(1); }

  console.log(`══ DB context ══`);
  console.log(`  ${vm.name} (${vm.ip_address})`);
  console.log(`  health=${vm.health_status} status=${vm.status} partner=${vm.partner ?? "-"} agdp=${vm.agdp_enabled ?? "-"} cv=${vm.config_version}`);

  const { data: user } = await sb.from("instaclaw_users").select("*").eq("id", vm.assigned_to).single();
  console.log(`\nUser: ${user?.email}`);
  for (const k of ["tier","api_mode","payment_status","credit_balance","partner","subscription_tier","credits","total_credits","credit_balance_cents"]) {
    if ((user as any)?.[k] !== undefined) console.log(`  ${k}: ${(user as any)[k]}`);
  }

  console.log(`\n══ Stripe-verified billing ══`);
  const billing = await getBillingStatusVerified(sb, stripe, vm.id);
  if (billing) console.log(`  isPaying=${billing.isPaying} reasons=${billing.reasons.join(",")} sub=${billing.details.stripeSubStatus}`);

  console.log(`\n══ SSH probes ══`);
  const ssh = await connectSSH(vm as any);
  try {
    const r = await ssh.execCommand(
      `echo === D1 process snapshot ===
echo PIDS_TOTAL: $(ps -eLf | wc -l)
echo MY_PIDS: $(ps -u openclaw -o pid= | wc -l)
echo ULIMIT_U: $(ulimit -u)
echo ZOMBIES: $(ps axo stat | grep -c '^Z')
echo TOP_PROCS_BY_COUNT:
ps -eo comm | sort | uniq -c | sort -rn | head -15
echo TOP_PROCS_BY_RSS:
ps -eo pid,ppid,rss,etime,comm --sort=-rss | head -15
echo === D2 zombie detail ===
ps axo pid,ppid,stat,user,etime,comm | awk '\$3 ~ /Z/' | head -10
echo D2_ZOMBIE_PARENTS:
for zpid in $(ps axo pid,stat | awk '\$2 ~ /Z/ {print \$1}'); do
  ppid=$(ps -p $zpid -o ppid= 2>/dev/null | tr -d ' ')
  pcmd=$(ps -p $ppid -o comm= 2>/dev/null)
  echo "  zombie pid=$zpid ppid=$ppid parent_cmd=$pcmd"
done
echo === D3 fork errors last 24h sample ===
timeout 20 journalctl --user --since '24 hours ago' --no-pager 2>/dev/null | grep -iE 'fork|EAGAIN|cannot allocate|resource temporarily' | head -20
echo D3_AGGREGATE_BY_PROCESS:
timeout 20 journalctl --user --since '24 hours ago' --no-pager 2>/dev/null | grep -iE 'fork|EAGAIN|cannot allocate' | grep -oE '^[A-Z][a-z]+ +[0-9]+ +[0-9:]+ [^ ]+ ([a-z0-9_-]+)\\[' | sort | uniq -c | sort -rn | head -10
echo === D4 crontab ===
crontab -l 2>/dev/null
echo === D5 gateway health ===
systemctl --user is-active openclaw-gateway 2>&1
curl -sf -m 5 http://localhost:18789/health 2>&1 | head -c 200; echo
echo === D6 memory + load ===
free -m | head -3
uptime
echo === D7 currently running shell scripts (potential spawners) ===
ps -eo pid,ppid,etime,cmd | grep -E 'bash|sh -c|dgclaw|cron' | grep -v grep | head -15
echo === D8 dgclaw cron entries ===
crontab -l 2>/dev/null | grep -i dgclaw | head -10
echo === D9 ~/dgclaw-skill if present ===
ls -la ~/dgclaw-skill 2>&1 | head -10
echo === D10 npm/node count ===
ps -eo comm 2>/dev/null | grep -cE '^node$|^npm$|^npx$'
`,
      { execOptions: { pty: false } }
    );
    console.log(r.stdout);
    if (r.stderr) console.log("\nstderr:", r.stderr.slice(0, 400));
  } finally {
    ssh.dispose();
  }
})().catch(e => { console.error("FATAL", e); process.exit(1); });
