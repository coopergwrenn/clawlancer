import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
for (const f of ["/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local"]) {
  for (const l of readFileSync(f, "utf-8").split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function check(t: string, c?: string) {
  const q = c ? sb.from(t).select(c).limit(0) : sb.from(t).select("*").limit(0);
  const { error } = await q;
  console.log(`${t}${c ? "." + c : ""}: ${error ? "MISSING (" + error.message.slice(0, 80) + ")" : "EXISTS"}`);
}
(async () => {
  await check("instaclaw_update_state");
  await check("negotiation_threads");
  await check("negotiation_messages");
  await check("matchpool_outcomes", "negotiation_thread_id");
  await check("negotiation_threads", "match_engine");
  await check("matchpool_deliberations", "deliberation_started_at");
  await check("matchpool_deliberations", "deliberation_completed_at");
  await check("agent_outreach_log", "pending_reason");
})();
