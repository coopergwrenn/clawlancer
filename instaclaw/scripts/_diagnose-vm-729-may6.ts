/**
 * Re-diagnosis of vm-729 (Notboredclaw, Not Bored Kid) on 2026-05-06.
 *
 * User complaints from this morning's screenshots:
 *   - Agent opened a trade the user didn't authorize ($15 lost)
 *   - Gateway broken: "Something went wrong while processing your request"
 *   - /new and /restart commands both failing
 *   - Agent telling user to run "openclaw gateway restart" (not authorized)
 *   - Agent responding in Spanish
 *
 * READ-ONLY diagnostic. No mutation in this script. Captures:
 *   1. DB + user + billing context (extends previous trial to May 22)
 *   2. Gateway is-active + /health
 *   3. Last 50 gateway log lines (find the crash)
 *   4. CRONTAB — find any auto-trading entries (degenclaw-cycle, shot-clock-entry, etc)
 *   5. Recently-modified files in scripts/ (find trade-execution evidence)
 *   6. Hyperliquid trade artifacts in dgclaw logs
 *   7. Memory/sessions state (any "trade" / "Spanish" markers)
 *   8. Process tree (running cron children, agent state)
 *
 * Suspect: vm-729 has agdp_enabled=true. Did its install include auto-trading
 * crons (degenclaw-cycle.py, shot-clock-entry.py)?  If yes, those run every
 * few minutes WITHOUT user approval and could explain the $15 trade.
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
  const { data: vm } = await sb.from("instaclaw_vms").select("*").eq("name", "instaclaw-vm-729").single();
  if (!vm) { console.error("vm-729 not found"); process.exit(1); }

  console.log("══ Phase A: DB + user ══");
  console.log(`  ${vm.name} (${vm.ip_address})`);
  console.log(`  health=${vm.health_status} status=${vm.status} partner=${vm.partner ?? "-"} agdp=${vm.agdp_enabled ?? "-"} cv=${vm.config_version}`);
  const { data: user } = await sb.from("instaclaw_users").select("*").eq("id", vm.assigned_to).single();
  console.log(`\nUser: ${user?.email}  id: ${user?.id}`);

  console.log("\n══ Phase B: Billing ══");
  const billing = await getBillingStatusVerified(sb, stripe, vm.id);
  if (billing) console.log(`  isPaying=${billing.isPaying} reasons=${billing.reasons.join(",")} sub=${billing.details.stripeSubStatus}`);

  console.log("\n══ Phase C: SSH probes ══");
  const ssh = await connectSSH(vm as any);
  try {
    const r = await ssh.execCommand(
      `echo === C1 GATEWAY HEALTH ===
systemctl --user is-active openclaw-gateway 2>&1
curl -sf -m 5 http://localhost:18789/health 2>&1 | head -c 200; echo
echo === C2 LAST 50 GATEWAY LOG LINES ===
journalctl --user -u openclaw-gateway -n 50 --no-pager 2>/dev/null | tail -50
echo === C3 GATEWAY RESTART HISTORY 24H ===
journalctl --user -u openclaw-gateway --since '24 hours ago' --no-pager 2>/dev/null | grep -ciE 'started|stopped|restart|crash|exit|killed'
echo === C4 CRONTAB FULL ===
crontab -l 2>/dev/null
echo === C5 AUTO-TRADING SCRIPTS PRESENT ===
ls -la /home/openclaw/scripts/ 2>/dev/null | grep -iE 'degenclaw|shot-clock|auto-trade|trade-execution|hyperliquid|cycle|monitor' | head -20
echo === C6 RECENT TRADE LOGS ===
ls -lat /home/openclaw/logs/ 2>/dev/null | head -10
echo --- last 20 lines of any cycle/monitor log ---
for log in /home/openclaw/logs/*cycle* /home/openclaw/logs/*monitor* /home/openclaw/logs/*shot-clock* /home/openclaw/logs/*hardstop*; do
  [ -f "$log" ] && echo "=== $log ===" && tail -10 "$log" 2>/dev/null
done | head -80
echo === C7 RECENT FILES IN scripts/ ===
ls -lat /home/openclaw/scripts/ 2>/dev/null | head -15
echo === C8 dgclaw-skill INTEGRITY ===
ls -la ~/dgclaw-skill 2>&1 | head -10
test -d ~/dgclaw-skill/.git && (cd ~/dgclaw-skill && git log -1 --format='%h %s (%ai)') 2>&1 | head -3 || echo NO_GIT
echo === C9 PROCESS TREE (running crons + node) ===
ps -ef 2>/dev/null | grep -E 'cron|degenclaw|shot-clock|node|openclaw' | grep -v grep | head -25
echo === C10 dgclaw .env (key presence only) ===
test -f ~/dgclaw-skill/.env && echo FOUND_DGCLAW_ENV || echo NO_DGCLAW_ENV
test -f ~/agdp/config.json && echo FOUND_AGDP_CONFIG || echo NO_AGDP_CONFIG
echo === C11 MEMORY.md size + recent mtimes ===
ls -la ~/.openclaw/workspace/MEMORY.md ~/.openclaw/workspace/SOUL.md 2>&1 | head -3
echo === C12 SPANISH HINT ===
journalctl --user -u openclaw-gateway --since '24 hours ago' --no-pager 2>/dev/null | grep -iE 'spanish|espanol|hola|que pasa' | head -5
echo === C13 acp-serve / dgclaw service status ===
systemctl --user is-active acp-serve.service 2>&1
systemctl --user is-failed acp-serve.service 2>&1
echo === C14 recent ENOENT errors (Cooper hint) ===
journalctl --user --since '24 hours ago' --no-pager 2>/dev/null | grep -ciE 'ENOENT|no such file'
journalctl --user --since '24 hours ago' --no-pager 2>/dev/null | grep -iE 'ENOENT|no such file' | tail -5
`,
      { execOptions: { pty: false } }
    );
    console.log(r.stdout);
    if (r.stderr) console.log("\nstderr:", r.stderr.slice(0, 600));
  } finally {
    ssh.dispose();
  }
})().catch(e => { console.error("FATAL", e); process.exit(1); });
