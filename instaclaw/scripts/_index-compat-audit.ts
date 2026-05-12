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
  console.log("\n══ Index-integration schema audit ══\n");
  const interesting = ["matchpool_profiles","matchpool_deliberations","matchpool_outcomes","agent_outreach_log","matchpool_intros","matchpool_cached_top3"];
  for (const t of interesting) {
    const { data } = await sb.from(t).select("*").limit(1);
    if (!data) { console.log(`  ${t}: (no data, can't introspect)`); continue; }
    const cols = data.length ? Object.keys(data[0]) : [];
    const hasEngine = cols.some(c => c === "match_engine" || c === "engine" || c === "provider");
    const hasRequestId = cols.some(c => c === "request_id");
    const hasReason = cols.some(c => c === "reason_text" || c === "reason");
    console.log(`  ${t.padEnd(24)}  cols=${cols.length}  engine_col=${hasEngine?"✓":"✗"}  request_id=${hasRequestId?"✓":"✗"}  reason=${hasReason?"✓":"✗"}`);
    if (cols.length && !hasEngine && t !== "matchpool_cached_top3") {
      console.log(`    ⚠ no match_engine column — cannot A/B Index vs InstaClaw on this table`);
    }
  }
}
run().catch(e => { console.error(e); process.exit(1); });
