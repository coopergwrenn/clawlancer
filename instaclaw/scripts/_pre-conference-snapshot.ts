/**
 * Pre-conference state snapshot. Captures everything we'd want to
 * answer "was X true going in?" 24 hours from now.
 *
 * Each section prints concise, machine-greppable output. Compose into
 * a single audit blob via `npx tsx ... > snapshot.txt`.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

for (const f of ["/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local"]) {
  for (const l of readFileSync(f, "utf-8").split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  console.log("══ Pre-conference snapshot ══");
  console.log(`captured_at: ${new Date().toISOString()}`);
  console.log("");

  // ─ Pool state ─
  console.log("── Ready pool ──");
  const { count: ready } = await sb.from("instaclaw_vms").select("id", { count: "exact", head: true })
    .eq("health_status", "healthy").is("assigned_to", null);
  const { count: provisioning } = await sb.from("instaclaw_vms").select("id", { count: "exact", head: true })
    .eq("health_status", "provisioning");
  const { count: assigned } = await sb.from("instaclaw_vms").select("id", { count: "exact", head: true })
    .not("assigned_to", "is", null).eq("health_status", "healthy");
  console.log(`  ready_unassigned: ${ready}  (POOL_FLOOR=10  POOL_TARGET=15)`);
  console.log(`  provisioning:     ${provisioning}`);
  console.log(`  assigned_healthy: ${assigned}`);
  if ((ready || 0) < 10) console.log(`  ⚠ BELOW POOL_FLOOR — replenish-pool cron should kick in within 5 min`);

  // ─ Cron lock state ─
  console.log("\n── Cron locks (recent activity) ──");
  const { data: locks } = await sb.from("instaclaw_cron_locks").select("*");
  for (const l of locks || []) {
    const name = (l.cron_name || l.lock_name || l.name || "(unknown)") as string;
    const acquired = (l.acquired_at || l.locked_at || l.created_at) as string | null;
    const ageS = acquired ? (Date.now() - new Date(acquired).getTime()) / 1000 : -1;
    console.log(`  ${name.padEnd(24)} acquired=${acquired || "?"} age=${ageS.toFixed(0)}s holder=${l.holder || l.acquired_by || "?"}`);
  }

  // ─ Partner VMs ─
  console.log("\n── 5 partner VMs ──");
  const { data: partners } = await sb.from("instaclaw_vms")
    .select("name, partner, health_status, config_version, telegram_chat_id, xmtp_address, telegram_bot_username")
    .in("partner", ["edge_city", "consensus_2026"])
    .order("name");
  for (const v of partners || []) {
    const tg = v.telegram_chat_id ? "Y" : "N";
    const xm = v.xmtp_address ? "Y" : "N";
    console.log(`  ${(v.name as string).padEnd(22)} partner=${v.partner} cv=${v.config_version} tg_chat=${tg} xmtp=${xm} bot=@${v.telegram_bot_username || "-"}`);
  }

  // ─ Manifest version ─
  console.log("\n── Manifest version (highest config_version on healthy fleet) ──");
  const { data: maxCv } = await sb.from("instaclaw_vms")
    .select("config_version")
    .eq("health_status", "healthy")
    .order("config_version", { ascending: false })
    .limit(1);
  console.log(`  highest_cv: ${maxCv?.[0]?.config_version}`);

  // ─ Outreach ledger health ─
  console.log("\n── agent_outreach_log state ──");
  const { count: totalOutreach } = await sb.from("agent_outreach_log")
    .select("id", { count: "exact", head: true });
  const { count: unackedOutreach } = await sb.from("agent_outreach_log")
    .select("id", { count: "exact", head: true })
    .eq("status", "sent")
    .is("ack_received_at", null);
  const { count: acked24h } = await sb.from("agent_outreach_log")
    .select("id", { count: "exact", head: true })
    .gte("ack_received_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  console.log(`  total_rows:       ${totalOutreach}`);
  console.log(`  unacked_pending:  ${unackedOutreach}`);
  console.log(`  acked_last_24h:   ${acked24h}`);

  // ─ Matchpool size ─
  console.log("\n── Matchpool pool size ──");
  const { count: profiles } = await sb.from("matchpool_profiles")
    .select("user_id", { count: "exact", head: true });
  const { count: opted } = await sb.from("matchpool_profiles")
    .select("user_id", { count: "exact", head: true })
    .neq("consent_tier", "none");
  console.log(`  total_profiles:   ${profiles}  (incl. ghosts)`);
  console.log(`  opted_in_users:   ${opted}`);

  // ─ Recent pipeline activity (last hour) ─
  console.log("\n── Recent pipeline activity (last 1h) ──");
  const sinceIso = new Date(Date.now() - 3600 * 1000).toISOString();
  const { count: recentDelibs } = await sb.from("matchpool_deliberations")
    .select("id", { count: "exact", head: true })
    .gte("deliberated_at", sinceIso);
  const { count: recentTop3 } = await sb.from("matchpool_cached_top3")
    .select("user_id", { count: "exact", head: true })
    .gte("computed_at", sinceIso);
  console.log(`  deliberations:    ${recentDelibs}`);
  console.log(`  cached_top3:      ${recentTop3}`);

  // ─ Critical env vars (sanity check the Vercel side has them) ─
  console.log("\n── Critical env presence (local .env.local) ──");
  for (const k of [
    "LINODE_API_TOKEN",
    "LINODE_SNAPSHOT_ID",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "STRIPE_SECRET_KEY",
    "TELEGRAM_BOT_TOKEN",
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
  ]) {
    console.log(`  ${k.padEnd(30)} ${process.env[k] ? "Y" : "N"}`);
  }
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
