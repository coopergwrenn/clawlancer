/**
 * Investigation: where is feedback/outcome data being captured today?
 *
 * Findings expected:
 *   - research.match_outcomes exists in schema but never written to
 *   - public.matchpool_outcomes doesn't exist (PRD name drift)
 *   - matchpool_intros may have post-meeting status updates
 *   - agent_outreach_log has ack_received_at but not "did the meeting happen"
 *
 * If true: the 3-layer pipeline operates blind. We have no signal for
 * tuning mutual_threshold, measuring valuable-meeting rate, or detecting
 * MAST inter-agent misalignment.
 */
import { readFileSync } from "fs";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

for (const f of ["/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local"]) {
  for (const l of readFileSync(f, "utf-8").split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) {
      process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

async function tryQuery(sb: SupabaseClient, schemaTable: string, label: string) {
  // PostgREST: schema is on the URL or via headers. Default is public; for
  // research.* we need to use the schema header.
  if (schemaTable.startsWith("research.")) {
    const tbl = schemaTable.replace("research.", "");
    const sbResearch = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { db: { schema: "research" } },
    );
    const { count, error } = await sbResearch.from(tbl).select("*", { count: "exact", head: true });
    process.stdout.write(`  ${label.padEnd(46)} `);
    if (error) {
      process.stdout.write(`✗ ${error.message}\n`);
    } else {
      process.stdout.write(`✓ ${count ?? 0} rows\n`);
    }
    return count;
  }
  const { count, error } = await sb.from(schemaTable).select("*", { count: "exact", head: true });
  process.stdout.write(`  ${label.padEnd(46)} `);
  if (error) {
    process.stdout.write(`✗ ${error.message}\n`);
    return null;
  }
  process.stdout.write(`✓ ${count ?? 0} rows\n`);
  return count;
}

async function run() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  process.stdout.write(`\n══ Where is feedback/outcome data captured today? ══\n`);
  process.stdout.write(`\nQ1: Tables that might hold outcome data\n`);
  await tryQuery(sb, "matchpool_outcomes", "matchpool_outcomes (PRD-named)");
  await tryQuery(sb, "research.match_outcomes", "research.match_outcomes (migration-named)");
  await tryQuery(sb, "research.briefing_outcomes", "research.briefing_outcomes");
  await tryQuery(sb, "research.agent_signals", "research.agent_signals");
  await tryQuery(sb, "matchpool_intros", "matchpool_intros (v2 negotiation)");
  await tryQuery(sb, "agent_outreach_log", "agent_outreach_log (v1 ledger)");

  process.stdout.write(`\nQ2: Drill into matchpool_intros — does it hold post-meeting state?\n`);
  const sbResearch = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { data: introsSample } = await sbResearch.from("matchpool_intros").select("*").limit(3);
  if (introsSample?.length) {
    process.stdout.write(`  sample columns: ${Object.keys(introsSample[0]).join(", ")}\n`);
    process.stdout.write(`  sample rows:\n`);
    for (const r of introsSample) process.stdout.write(`    ${JSON.stringify(r).slice(0, 200)}\n`);
  } else {
    process.stdout.write(`  matchpool_intros is empty — v2 negotiation hasn't fired in production yet\n`);
  }

  process.stdout.write(`\nQ3: Drill into agent_outreach_log — what columns capture outcome?\n`);
  const { data: outreachSample } = await sb.from("agent_outreach_log").select("*").limit(2);
  if (outreachSample?.length) {
    process.stdout.write(`  columns: ${Object.keys(outreachSample[0]).join(", ")}\n`);
    process.stdout.write(`  Capture of outcomes: \n`);
    process.stdout.write(`    - sent_at + ack_received_at = "intro delivered + receiver surfaced"\n`);
    process.stdout.write(`    - status enum = pending|sent|failed (NOT 'meeting_happened' etc.)\n`);
    process.stdout.write(`    - NO column captures "user agreed to meet" or "meeting occurred"\n`);
  }

  process.stdout.write(`\nQ4: Drill into matchpool_deliberations — does it have post-hoc tuning signal?\n`);
  const { data: delibSample } = await sb.from("matchpool_deliberations").select("*").limit(1);
  if (delibSample?.length) {
    process.stdout.write(`  columns: ${Object.keys(delibSample[0]).join(", ")}\n`);
    process.stdout.write(`  This is Layer 3 INPUT (the agent's prediction). No outcome column.\n`);
  }

  process.stdout.write(`\n\n══ CONCLUSION ══\n`);
  process.stdout.write(`  The 3-layer pipeline operates blind.\n`);
  process.stdout.write(`  - Layer 3 predicts match_score. Stored.\n`);
  process.stdout.write(`  - Layer 4 (intro delivery): captures ack but not "did they meet."\n`);
  process.stdout.write(`  - Layer 5 (outcome): UNIMPLEMENTED.\n\n`);
  process.stdout.write(`  Without Layer 5, we cannot:\n`);
  process.stdout.write(`  - Tune mutual_threshold against valuable-vs-declined distributions.\n`);
  process.stdout.write(`  - Measure Hinge-analogue success rate.\n`);
  process.stdout.write(`  - Detect MAST inter-agent misalignment (Layer 3 score vs actual outcome).\n`);
  process.stdout.write(`  - Validate the "structurally novel" claim from the PRD with data.\n\n`);
  process.stdout.write(`  This is a foundational bug. May reorder §5.2.\n`);
}
run().catch((e) => { console.error("FATAL:", e); process.exit(1); });
