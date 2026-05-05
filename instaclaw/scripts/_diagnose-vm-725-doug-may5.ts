/**
 * 2026-05-05 vm-725 (Doug Rathell) re-diagnosis. Sudo-free version.
 * Four threads from screenshots:
 *   1. PID FORK EXHAUSTION (recurrence)
 *   2. BANKR AWARENESS in SOUL.md
 *   3. CLAWLANCER SKILL on disk
 *   4. CREDIT EXHAUSTION via Stripe + DB
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
  console.log("══ Phase A: DB lookup ══\n");
  const { data: vm } = await sb.from("instaclaw_vms").select("*").eq("name", "instaclaw-vm-725").single();
  if (!vm) { console.error("vm-725 not found"); process.exit(1); }
  console.log(`VM: ${vm.name} (${vm.ip_address})`);
  console.log(`  health_status: ${vm.health_status}  config_version: ${vm.config_version}  agdp_enabled: ${vm.agdp_enabled}`);

  const { data: user } = await sb.from("instaclaw_users").select("*").eq("id", vm.assigned_to).single();
  console.log(`\nUser: ${user?.email}  id: ${user?.id}`);
  // Use Object.keys to find actual column names (they may differ)
  if (user) {
    const fields = ["tier", "api_mode", "payment_status", "credit_balance", "subscription_tier", "credits", "total_credits", "credit_balance_cents"];
    for (const f of fields) if ((user as any)[f] !== undefined) console.log(`  ${f}: ${(user as any)[f]}`);
  }

  console.log("\n══ Phase B: Stripe-verified billing ══");
  const billing = await getBillingStatusVerified(sb, stripe, vm.id);
  console.log(billing ? `  isPaying=${billing.isPaying} reasons=${billing.reasons.join(",")} status=${billing.details.stripeSubStatus}` : "  (could not load)");

  console.log("\n══ Phase C: SSH probes (sudo-free) ══\n");
  const ssh = await connectSSH(vm as any);
  try {
    console.log("── C1: PID state (instant probes only) ──");
    const c1 = await ssh.execCommand(
      `echo PIDS_TOTAL: $(ps -eLf 2>/dev/null | wc -l)
echo MY_PIDS: $(ps -u openclaw -o pid= 2>/dev/null | wc -l)
echo ULIMIT_U: $(ulimit -u)
echo ZOMBIES: $(ps axo stat 2>/dev/null | grep -c '^Z')
echo ZOMBIE_DETAILS:
ps axo pid,ppid,stat,user,comm 2>/dev/null | awk '$3 ~ /Z/' | head -10
echo TOP_PROCESS_COUNTS:
ps -eo comm 2>/dev/null | sort | uniq -c | sort -rn | head -10
echo PID_MONITOR_CRON:
crontab -l 2>/dev/null | grep -iE 'pid|fork|kill_zombies|reap' | head -5
echo PID_MONITOR_SCRIPTS:
grep -l 'pkill\\|defunct\\|kill_zombies' ~/.openclaw/scripts/*.py ~/.openclaw/scripts/*.sh 2>/dev/null
echo JOURNAL_LAST_HOUR_FORK:
journalctl --user --since '1 hour ago' --no-pager 2>/dev/null | grep -ciE 'fork|EAGAIN|cannot allocate'
echo JOURNAL_LAST_24H_FORK_COUNT:
timeout 20 journalctl --user --since '24 hours ago' --no-pager 2>/dev/null | grep -ciE 'fork|EAGAIN|cannot allocate'
`,
      { execOptions: { pty: false } }
    );
    console.log(c1.stdout);
    if (c1.stderr) console.log("stderr:", c1.stderr.slice(0, 300));

    console.log("\n── C2: Bankr awareness ──");
    const c2 = await ssh.execCommand(
      `echo SOUL_MD_BYTES: $(wc -c < ~/.openclaw/workspace/SOUL.md 2>/dev/null)
echo BANKR_MENTIONS: $(grep -ic bankr ~/.openclaw/workspace/SOUL.md 2>/dev/null)
echo BANKR_TOKEN_CONTEXT:
grep -niE 'bankr|tokenize|token.{0,20}launch' ~/.openclaw/workspace/SOUL.md 2>/dev/null | head -10
echo BANKR_SKILL_DIR:
ls -la ~/.openclaw/skills/bankr 2>&1 | head -5
echo BANKR_SUBSKILL_COUNT: $(find ~/.openclaw/skills/bankr -mindepth 1 -maxdepth 1 -type d -not -name .git 2>/dev/null | wc -l)
echo BANKR_SKILL_MD_FILES: $(find ~/.openclaw/skills/bankr -name SKILL.md 2>/dev/null | wc -l)
echo BANKR_PARTNER_KEY_IN_ENV: $(grep -c BANKR_PARTNER_KEY ~/.openclaw/.env 2>/dev/null)
`
    );
    console.log(c2.stdout);

    console.log("\n── C3: Clawlancer skill ──");
    const c3 = await ssh.execCommand(
      `echo ALL_SKILLS:
ls ~/.openclaw/skills 2>/dev/null
echo CLAWLANCER_DIRS:
ls -d ~/.openclaw/skills/*lawlanc* 2>&1
echo EARN_MD_BYTES: $(wc -c < ~/.openclaw/workspace/EARN.md 2>/dev/null)
echo EARN_BOUNTY_MENTIONS: $(grep -ic 'bounty\\|clawlancer' ~/.openclaw/workspace/EARN.md 2>/dev/null)
echo SOUL_CLAWLANCER_MENTIONS: $(grep -ic clawlancer ~/.openclaw/workspace/SOUL.md 2>/dev/null)
echo CAPABILITIES_BOUNTY_MENTIONS: $(grep -ic 'bounty\\|clawlancer' ~/.openclaw/workspace/CAPABILITIES.md 2>/dev/null)
`
    );
    console.log(c3.stdout);

    console.log("\n── C4: Gateway health right now ──");
    const c4 = await ssh.execCommand(
      `echo GATEWAY_ACTIVE: $(systemctl --user is-active openclaw-gateway 2>&1)
echo HEALTH_PROBE:
curl -sf -m 5 http://localhost:18789/health 2>&1 | head -c 300
echo
echo GATEWAY_LAST_10:
journalctl --user -u openclaw-gateway -n 10 --no-pager 2>/dev/null | tail -15
echo DISK:
df -h ~ | tail -1
echo MEMORY:
free -m | head -3
`
    );
    console.log(c4.stdout);
  } finally {
    ssh.dispose();
  }

  console.log("\n══ Phase D: Stripe sub detail ══");
  if (user?.email) {
    const customers = await stripe.customers.list({ email: user.email, limit: 5 });
    for (const c of customers.data) {
      console.log(`  Customer ${c.id} (${c.email})`);
      const subs = await stripe.subscriptions.list({ customer: c.id, status: "all", limit: 5 });
      for (const s of subs.data) {
        const cpe = new Date(s.current_period_end * 1000).toISOString();
        const te = s.trial_end ? new Date(s.trial_end * 1000).toISOString() : "-";
        console.log(`    ${s.id}: ${s.status} cpe=${cpe} trial_end=${te} cancel_at_pe=${s.cancel_at_period_end}`);
        console.log(`      items=${s.items.data.map(i => i.price.id).join(",")}`);
      }
    }
  }

  console.log("\n══ Phase E: Recent message/credit usage ══");
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const { count: msgCount } = await sb.from("instaclaw_messages")
    .select("*", { count: "exact", head: true })
    .eq("user_id", vm.assigned_to)
    .gte("created_at", since);
  console.log(`  messages last 30d: ${msgCount}`);
  const { data: creditEvents } = await sb.from("instaclaw_credit_events")
    .select("*").eq("user_id", vm.assigned_to).order("created_at", { ascending: false }).limit(15);
  console.log(`  recent credit events:`);
  for (const e of creditEvents ?? []) {
    console.log(`    ${e.created_at} ${e.event_type} delta=${e.delta} bal_after=${e.balance_after} ${e.note ?? ""}`);
  }
})().catch(e => { console.error("FATAL", e); process.exit(1); });
