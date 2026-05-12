/**
 * Two-part investigation:
 *
 *   Part A: Why only 8 users in matchpool_profiles?
 *     - Compare against instaclaw_users with skill enabled
 *     - Bucket by consent_tier
 *     - Check who DOESN'T have a profile (gap analysis)
 *
 *   Part B: 33% of outreaches have ack_channel='pending'. Why?
 *     - Drill into each pending row
 *     - Time-since-sent: are they within or past the retry window?
 *     - Cross-reference with receiver VM health
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

for (const f of ["/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local"]) {
  for (const l of readFileSync(f, "utf-8").split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) {
      process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

function header(s: string) {
  process.stdout.write(`\n${"═".repeat(s.length + 4)}\n  ${s}\n${"═".repeat(s.length + 4)}\n`);
}

async function run() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  header("Part A: matchpool_profiles population analysis");

  // Who's in the pool?
  const { data: profiles } = await sb.from("matchpool_profiles").select("*");
  process.stdout.write(`\n  Profiles total: ${profiles?.length ?? 0}\n\n`);
  if (profiles?.length) {
    process.stdout.write(`  By consent_tier:\n`);
    const byTier = new Map<string, number>();
    for (const p of profiles) {
      const tier = (p as { consent_tier?: string }).consent_tier ?? "(null)";
      byTier.set(tier, (byTier.get(tier) ?? 0) + 1);
    }
    for (const [t, n] of byTier) process.stdout.write(`    ${t}: ${n}\n`);

    process.stdout.write(`\n  By partner:\n`);
    const byPartner = new Map<string, number>();
    for (const p of profiles) {
      const partner = (p as { partner?: string }).partner ?? "(null)";
      byPartner.set(partner, (byPartner.get(partner) ?? 0) + 1);
    }
    for (const [t, n] of byPartner) process.stdout.write(`    ${t}: ${n}\n`);

    process.stdout.write(`\n  Per profile (truncated):\n`);
    for (const p of profiles) {
      const pp = p as { user_id: string; consent_tier?: string; partner?: string; offering_summary?: string; profile_version?: number };
      const summary = pp.offering_summary?.slice(0, 60) ?? "";
      process.stdout.write(`    ${pp.user_id.slice(0, 8)}  pv=${pp.profile_version}  tier=${pp.consent_tier}  partner=${pp.partner ?? "-"}  "${summary}…"\n`);
    }
  }

  // Who SHOULD be in the pool but isn't? Cross-reference with users who have the consensus skill toggled on.
  process.stdout.write(`\n  Cross-reference: who has consensus_skill enabled but no matchpool_profile?\n`);
  // The skill toggle state lives somewhere — let's find it. Likely in instaclaw_users or a per-user prefs table.
  const { data: usersSample } = await sb.from("instaclaw_users").select("*").limit(1);
  if (usersSample?.length) {
    const userCols = Object.keys(usersSample[0]);
    const skillCols = userCols.filter((c) => c.toLowerCase().includes("skill") || c.toLowerCase().includes("consensus") || c.toLowerCase().includes("matching"));
    process.stdout.write(`    instaclaw_users skill-related columns: ${skillCols.length ? skillCols.join(", ") : "(none found — toggle stored elsewhere)"}\n`);
  }

  // Partner-tagged user count
  const { count: edgeCityCount } = await sb.from("instaclaw_users").select("*", { count: "exact", head: true }).eq("partner", "edge_city");
  const { count: consensusCount } = await sb.from("instaclaw_users").select("*", { count: "exact", head: true }).eq("partner", "consensus_2026");
  const { count: anyPartnerCount } = await sb.from("instaclaw_users").select("*", { count: "exact", head: true }).not("partner", "is", null);

  process.stdout.write(`\n  Partner-tagged user counts (the eligible pool):\n`);
  process.stdout.write(`    partner='edge_city':       ${edgeCityCount ?? 0}\n`);
  process.stdout.write(`    partner='consensus_2026':  ${consensusCount ?? 0}\n`);
  process.stdout.write(`    partner != null (any):     ${anyPartnerCount ?? 0}\n`);
  process.stdout.write(`    matchpool_profiles count:  ${profiles?.length ?? 0}\n`);
  process.stdout.write(`    coverage: ${(((profiles?.length ?? 0) / Math.max(1, anyPartnerCount ?? 0)) * 100).toFixed(1)}% of partner-tagged users\n`);

  // Optional: check if matchpool_profiles has anyone NOT partner-tagged
  if (profiles?.length) {
    const userIds = profiles.map((p) => (p as { user_id: string }).user_id);
    const { data: matchedUsers } = await sb.from("instaclaw_users").select("id, email, partner, name").in("id", userIds);
    process.stdout.write(`\n  Who are the 8 users actually in the pool?\n`);
    for (const u of matchedUsers ?? []) {
      const uu = u as { id: string; email?: string; partner?: string; name?: string };
      process.stdout.write(`    ${uu.id.slice(0, 8)}  partner=${uu.partner ?? "-"}  ${uu.email ?? uu.name ?? "(no email)"}\n`);
    }
  }

  header("Part B: 33% pending-ACK drill-down");

  const { data: log } = await sb.from("agent_outreach_log").select("*").order("created_at", { ascending: false });
  if (!log?.length) return;

  const pending = log.filter((r) => (r as { ack_channel?: string }).ack_channel === "pending");
  process.stdout.write(`\n  Pending-ACK rows: ${pending.length}\n\n`);

  for (const r of pending) {
    const rr = r as {
      outbound_user_id: string; target_user_id: string; sent_at?: string;
      ack_received_at?: string; ack_channel?: string; status: string;
      retry_count?: number; created_at: string;
    };
    const sentAge = rr.sent_at ? Math.floor((Date.now() - Date.parse(rr.sent_at)) / 1000 / 60) : null;
    const ackAge = rr.ack_received_at ? Math.floor((Date.now() - Date.parse(rr.ack_received_at)) / 1000 / 60) : null;
    process.stdout.write(`    ${rr.outbound_user_id.slice(0, 8)} → ${rr.target_user_id.slice(0, 8)}  `);
    process.stdout.write(`sent_age=${sentAge ?? "-"}min  ack_age=${ackAge ?? "-"}min  retries=${rr.retry_count ?? 0}  status=${rr.status}\n`);
  }

  // Check whether the target VMs in these pending rows are healthy
  process.stdout.write(`\n  Are the receivers (target VMs) healthy?\n`);
  const targetUserIds = Array.from(new Set(pending.map((r) => (r as { target_user_id: string }).target_user_id)));
  const { data: vms } = await sb.from("instaclaw_vms").select("id, name, assigned_to, health_status, ip_address").in("assigned_to", targetUserIds);
  for (const v of vms ?? []) {
    const vv = v as { id: string; name: string; assigned_to: string; health_status: string; ip_address: string };
    process.stdout.write(`    ${vv.assigned_to.slice(0, 8)}  vm=${vv.name}  health=${vv.health_status}  ip=${vv.ip_address}\n`);
  }

  // Now the breakdown of ack channels by time-since-sent
  process.stdout.write(`\n  ACK channel breakdown vs time-since-sent:\n`);
  const byChannel = new Map<string, number[]>();
  for (const r of log) {
    const rr = r as { ack_channel?: string; sent_at?: string };
    if (!rr.sent_at) continue;
    const ageMin = (Date.now() - Date.parse(rr.sent_at)) / 1000 / 60;
    const ch = rr.ack_channel ?? "(no_channel)";
    if (!byChannel.has(ch)) byChannel.set(ch, []);
    byChannel.get(ch)!.push(ageMin);
  }
  for (const [ch, ages] of byChannel) {
    const minAge = Math.min(...ages);
    const maxAge = Math.max(...ages);
    const avgAge = ages.reduce((a, b) => a + b, 0) / ages.length;
    process.stdout.write(`    ${ch.padEnd(12)} n=${ages.length}  age_min=${minAge.toFixed(0)}m  age_max=${maxAge.toFixed(0)}m  age_avg=${avgAge.toFixed(0)}m\n`);
  }

  // Diagnostic: what does ack_channel='pending' actually mean per the route handler?
  process.stdout.write(`\n  Note: 'pending' was set by the outreach route at reserve time as the default.\n`);
  process.stdout.write(`        If the receiver later POSTs ack via /my-intros poll or direct ack call,\n`);
  process.stdout.write(`        the channel should update to 'polled' or 'telegram'. If it stays 'pending',\n`);
  process.stdout.write(`        either: (a) receiver-side ack never fired, or (b) ack_channel defaulted at\n`);
  process.stdout.write(`        insert and the column is sometimes never overwritten on later updates.\n`);
}
run().catch((e) => { console.error("FATAL:", e); process.exit(1); });
