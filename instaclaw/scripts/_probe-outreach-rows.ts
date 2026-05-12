import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
for (const f of ["/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local"]) {
  for (const l of readFileSync(f, "utf-8").split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
async function run() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data, error } = await sb.from("agent_outreach_log").select("*").order("sent_at", { ascending: false, nullsFirst: false });
  console.log("err:", error?.message, "rows:", data?.length);
  if (!data?.length) return;
  console.log(`\n--- All ${data.length} rows (newest first by sent_at) ---`);
  for (const r of data) {
    const rr = r as { outbound_user_id: string; target_user_id: string; sent_at?: string; ack_received_at?: string; ack_channel?: string; status: string; retry_count?: number };
    const sentAgeMin = rr.sent_at ? Math.floor((Date.now() - Date.parse(rr.sent_at)) / 1000 / 60) : null;
    console.log(`sent=${rr.sent_at?.slice(0,19) ?? "(null)"} (${sentAgeMin ?? "-"}m ago)  ${rr.outbound_user_id?.slice(0,8)} → ${rr.target_user_id?.slice(0,8)}  status=${rr.status}  ack_ch=${rr.ack_channel}  ack=${rr.ack_received_at ? "yes" : "no"}  retries=${rr.retry_count ?? 0}`);
  }

  console.log("\n--- ack_channel breakdown vs sent-age ---");
  const byChannel = new Map<string, { count: number; minAge: number; maxAge: number; ages: number[] }>();
  for (const r of data) {
    const rr = r as { ack_channel?: string; sent_at?: string };
    const ch = rr.ack_channel ?? "(null)";
    if (!byChannel.has(ch)) byChannel.set(ch, { count: 0, minAge: Infinity, maxAge: 0, ages: [] });
    const e = byChannel.get(ch)!;
    e.count++;
    if (rr.sent_at) {
      const ageMin = (Date.now() - Date.parse(rr.sent_at)) / 1000 / 60;
      e.ages.push(ageMin);
      e.minAge = Math.min(e.minAge, ageMin);
      e.maxAge = Math.max(e.maxAge, ageMin);
    }
  }
  for (const [ch, e] of byChannel) {
    const avg = e.ages.length ? (e.ages.reduce((a, b) => a + b, 0) / e.ages.length) : 0;
    console.log(`  ${ch.padEnd(12)} n=${e.count}  age_min=${(e.minAge === Infinity ? 0 : e.minAge).toFixed(0)}m  max=${e.maxAge.toFixed(0)}m  avg=${avg.toFixed(0)}m`);
  }
}
run().catch(e => { console.error("ERR:", e); process.exit(1); });
