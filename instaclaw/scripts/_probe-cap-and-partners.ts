/**
 * Pre-conference probe: per-receiver cap query against real users
 * + partner VM staleness audit. Output is the exact data the runbook
 * references at threshold time.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
for (const f of ["/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local"]) {
  for (const l of readFileSync(f, "utf-8").split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
async function run() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  console.log("══ Per-receiver cap query (live) ══\n");
  // Same query the reserve gate runs.
  const { data: partners } = await sb.from("instaclaw_vms")
    .select("name, assigned_to, telegram_chat_id, telegram_bot_username, partner")
    .in("partner", ["edge_city", "consensus_2026"]).order("name");
  const sinceIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  for (const v of partners || []) {
    if (!v.assigned_to) continue;
    const { count } = await sb.from("agent_outreach_log")
      .select("id", { count: "exact", head: true })
      .eq("target_user_id", v.assigned_to as string)
      .in("status", ["pending", "sent"])
      .gte("sent_at", sinceIso);
    console.log(`  ${(v.name as string).padEnd(22)} target_user=${(v.assigned_to as string).slice(0, 8)} cap=3 current=${count ?? 0}  ${count && count >= 3 ? "🛑 AT CAP" : count && count >= 2 ? "⚠ near cap" : "✓"}`);
  }

  console.log("\n══ Partner VM cv staleness ══\n");
  const fleetMax = await sb.from("instaclaw_vms")
    .select("config_version").eq("health_status", "healthy").order("config_version", { ascending: false }).limit(1);
  const max = fleetMax.data?.[0]?.config_version ?? 0;
  console.log(`  fleet_max_cv: ${max}`);
  for (const v of partners || []) {
    const { data: vmRow } = await sb.from("instaclaw_vms").select("config_version, health_status, last_health_check").eq("name", v.name as string).single();
    const cv = vmRow?.config_version as number;
    const drift = max - (cv || 0);
    const tag = drift === 0 ? "✓" : drift <= 2 ? "·" : "⚠";
    console.log(`  ${tag} ${(v.name as string).padEnd(22)} cv=${cv} drift=${drift}  health=${vmRow?.health_status}  last_check=${vmRow?.last_health_check}`);
  }

  console.log("\n══ agent_outreach_log breakdown (last 24h) ══\n");
  const { data: rows } = await sb.from("agent_outreach_log")
    .select("status, ack_channel, sent_at, ack_received_at")
    .gte("sent_at", sinceIso);
  const by_status: Record<string, number> = {};
  const by_channel: Record<string, number> = {};
  let acked = 0, total = 0;
  for (const r of rows || []) {
    total++;
    by_status[r.status as string] = (by_status[r.status as string] || 0) + 1;
    if (r.ack_channel) by_channel[r.ack_channel as string] = (by_channel[r.ack_channel as string] || 0) + 1;
    if (r.ack_received_at) acked++;
  }
  console.log(`  total: ${total}, acked: ${acked}, ack_rate: ${total > 0 ? (acked / total * 100).toFixed(0) : "n/a"}%`);
  console.log(`  by_status: ${JSON.stringify(by_status)}`);
  console.log(`  by_channel: ${JSON.stringify(by_channel)}`);

  console.log("\n══ Replenish-pool last fire ══\n");
  const { data: lock } = await sb.from("instaclaw_cron_locks").select("*").or("lock_name.eq.replenish-pool,cron_name.eq.replenish-pool").maybeSingle();
  if (lock) {
    const acquired = (lock.acquired_at || lock.locked_at) as string | null;
    console.log(`  last lock: ${acquired || "(unknown)"} holder=${lock.holder || "?"}`);
  } else {
    console.log("  no replenish-pool lock row found (cron may not have fired recently or table schema differs)");
  }
}
run().catch((e) => { console.error("FATAL:", e); process.exit(1); });
