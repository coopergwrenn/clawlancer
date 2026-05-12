/**
 * Week-1 production data report — answers the 6 queries in the
 * matching-engine-competitive-research PRD §5.4.
 *
 * Read-only. Run with: npx tsx scripts/_matching-pipeline-week1-report.ts
 *
 * Queries:
 *   Q1. Mutual-score distribution for confirmed-valuable vs declined intros.
 *   Q2. Layer 3 deliberation latency at p50/p95.
 *   Q3. Layer 3 deliberation count per user per day (proxy for cost).
 *   Q4. Fraction of sent intros where ack_received_at is set.
 *   Q5. Fraction of confirmed meetings with rating_post_meeting >= 4.
 *   Q6. Match-score outliers: Layer 3 low but user accepted, or high but declined.
 *
 * Use .select("*") for safety-critical reads per CLAUDE.md Rule 19.
 */
import { readFileSync } from "fs";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
]) {
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
function sub(s: string) {
  process.stdout.write(`\n── ${s} ──\n`);
}

function bucket(values: number[], edges: number[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i];
    const hi = edges[i + 1];
    out[`${lo.toFixed(2)}-${hi.toFixed(2)}`] = values.filter((v) => v >= lo && v < hi).length;
  }
  // Catch the exact max value in the top bucket.
  if (edges.length >= 2) {
    const lastKey = `${edges[edges.length - 2].toFixed(2)}-${edges[edges.length - 1].toFixed(2)}`;
    out[lastKey] += values.filter((v) => v === edges[edges.length - 1]).length;
  }
  return out;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx];
}

async function probeSchema(sb: SupabaseClient, table: string): Promise<string[] | null> {
  // .select("*").limit(1) gets us a sample row, from which we can introspect columns
  // (per Rule 19 + Rule 20). Empty table is fine — we just won't get column names from this path.
  const { data, error } = await sb.from(table).select("*").limit(1);
  if (error) {
    process.stdout.write(`  ⚠ ${table}: ${error.message}\n`);
    return null;
  }
  if (!data?.length) return [];
  return Object.keys(data[0]);
}

async function q1_mutualScoreDistribution(sb: SupabaseClient) {
  sub("Q1. Mutual-score distribution (confirmed-valuable vs declined)");

  // matchpool_outcomes has: mutual_score, rating_post_meeting, counterpart_response, meeting_actually_happened
  // Build distributions for two cohorts:
  //   A. confirmed-valuable: rating_post_meeting >= 4
  //   B. declined: counterpart_response='declined'

  const { data: outcomes, error } = await sb.from("matchpool_outcomes").select("*");
  if (error) {
    process.stdout.write(`  schema mismatch: ${error.message}\n`);
    return;
  }
  process.stdout.write(`  total outcome rows: ${outcomes?.length ?? 0}\n`);
  if (!outcomes?.length) {
    process.stdout.write(`  (no data yet — table is empty or not yet populated)\n`);
    return;
  }

  const valuable = outcomes
    .filter((o) => (o as { rating_post_meeting?: number }).rating_post_meeting !== null && (o as { rating_post_meeting: number }).rating_post_meeting >= 4)
    .map((o) => Number((o as { mutual_score?: number }).mutual_score ?? 0));
  const declined = outcomes
    .filter((o) => (o as { counterpart_response?: string }).counterpart_response === "declined")
    .map((o) => Number((o as { mutual_score?: number }).mutual_score ?? 0));

  const edges = [0, 0.3, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.8, 1.0];

  process.stdout.write(`  confirmed-valuable (rating ≥4) n=${valuable.length}\n`);
  if (valuable.length) {
    const b = bucket(valuable, edges);
    for (const k of Object.keys(b)) process.stdout.write(`    [${k}] ${b[k]}\n`);
    process.stdout.write(`    median=${percentile(valuable, 0.5).toFixed(3)}  p25=${percentile(valuable, 0.25).toFixed(3)}  p75=${percentile(valuable, 0.75).toFixed(3)}\n`);
  }
  process.stdout.write(`  declined (counterpart='declined') n=${declined.length}\n`);
  if (declined.length) {
    const b = bucket(declined, edges);
    for (const k of Object.keys(b)) process.stdout.write(`    [${k}] ${b[k]}\n`);
    process.stdout.write(`    median=${percentile(declined, 0.5).toFixed(3)}  p25=${percentile(declined, 0.25).toFixed(3)}  p75=${percentile(declined, 0.75).toFixed(3)}\n`);
  }

  if (valuable.length && declined.length) {
    process.stdout.write(`\n  TUNING SIGNAL:\n`);
    process.stdout.write(`    valuable.p25 = ${percentile(valuable, 0.25).toFixed(3)} (most valuable matches above this)\n`);
    process.stdout.write(`    declined.p75 = ${percentile(declined, 0.75).toFixed(3)} (most decline cases below this)\n`);
    process.stdout.write(`    inflection-point candidate threshold: ${((percentile(valuable, 0.25) + percentile(declined, 0.75)) / 2).toFixed(3)}\n`);
    process.stdout.write(`    current threshold: 0.55 (foundation PRD default)\n`);
  } else {
    process.stdout.write(`\n  (insufficient cohort data to tune threshold — need both valuable and declined samples)\n`);
  }
}

async function q2_layer3Latency(sb: SupabaseClient) {
  sub("Q2. Layer 3 deliberation latency");

  // matchpool_deliberations has deliberated_at; matchpool_profiles has intent_extracted_at.
  // Deliberation latency = deliberated_at − intent_extracted_at for that user_profile_version.

  const { data: delibs, error } = await sb
    .from("matchpool_deliberations")
    .select("*")
    .order("deliberated_at", { ascending: false })
    .limit(2000);
  if (error) {
    process.stdout.write(`  matchpool_deliberations: ${error.message}\n`);
    return;
  }
  process.stdout.write(`  total deliberations (last 2000): ${delibs?.length ?? 0}\n`);
  if (!delibs?.length) {
    process.stdout.write(`  (no data yet)\n`);
    return;
  }

  // Need to join to matchpool_profiles by (user_id, profile_version) to get intent_extracted_at.
  const userIds = Array.from(new Set(delibs.map((d) => (d as { user_id: string }).user_id)));
  const { data: profiles, error: pErr } = await sb
    .from("matchpool_profiles")
    .select("*")
    .in("user_id", userIds);
  if (pErr) {
    process.stdout.write(`  matchpool_profiles join: ${pErr.message}\n`);
    return;
  }

  const profileByUser = new Map<string, { intent_extracted_at: string | null; profile_version?: number }>();
  for (const p of profiles ?? []) {
    profileByUser.set((p as { user_id: string }).user_id, p as { intent_extracted_at: string | null });
  }

  const latencies: number[] = [];
  for (const d of delibs) {
    const dd = d as { user_id: string; deliberated_at: string };
    const prof = profileByUser.get(dd.user_id);
    if (!prof?.intent_extracted_at) continue;
    const latencyMs = Date.parse(dd.deliberated_at) - Date.parse(prof.intent_extracted_at);
    if (latencyMs > 0 && latencyMs < 24 * 60 * 60 * 1000) latencies.push(latencyMs / 1000); // seconds, sane bounds
  }

  if (!latencies.length) {
    process.stdout.write(`  (could not compute latencies — intent_extracted_at may be null on profiles)\n`);
    return;
  }

  process.stdout.write(`  computed latencies n=${latencies.length} (intent_extracted_at → deliberated_at, seconds)\n`);
  process.stdout.write(`    p50: ${percentile(latencies, 0.5).toFixed(1)}s\n`);
  process.stdout.write(`    p75: ${percentile(latencies, 0.75).toFixed(1)}s\n`);
  process.stdout.write(`    p95: ${percentile(latencies, 0.95).toFixed(1)}s\n`);
  process.stdout.write(`    p99: ${percentile(latencies, 0.99).toFixed(1)}s\n`);
  process.stdout.write(`    max: ${Math.max(...latencies).toFixed(1)}s\n`);
  process.stdout.write(`  consensus addendum projected ~8-10s p95.\n`);

  // Caveat: this latency includes time the agent might be sleeping between
  // periodic_summary_hook ticks. Real Layer 3 LLM-call latency would need
  // a deliberation-started timestamp we don't have. Best proxy available.
  process.stdout.write(`\n  NOTE: this is intent→deliberation END-TO-END including pipeline cron cadence.\n`);
  process.stdout.write(`        Pure Layer 3 LLM-call latency would need a per-call timestamp we don't capture today.\n`);
}

async function q3_layer3Cost(sb: SupabaseClient) {
  sub("Q3. Layer 3 deliberation count per user per day (cost proxy)");

  // Group matchpool_deliberations by (user_id, day) and count.
  const { data: delibs, error } = await sb
    .from("matchpool_deliberations")
    .select("user_id, deliberated_at, match_score")
    .order("deliberated_at", { ascending: false })
    .limit(10000);
  if (error) {
    process.stdout.write(`  matchpool_deliberations: ${error.message}\n`);
    return;
  }
  if (!delibs?.length) {
    process.stdout.write(`  (no data yet)\n`);
    return;
  }

  const byUserDay = new Map<string, number>();
  for (const d of delibs) {
    const dd = d as { user_id: string; deliberated_at: string };
    const day = dd.deliberated_at.slice(0, 10);
    const key = `${dd.user_id}::${day}`;
    byUserDay.set(key, (byUserDay.get(key) ?? 0) + 1);
  }

  const perUserDayCounts = Array.from(byUserDay.values());
  process.stdout.write(`  user-day buckets: ${perUserDayCounts.length} (each = N deliberations on one day for one user)\n`);
  process.stdout.write(`  deliberations per user-day:\n`);
  process.stdout.write(`    p50: ${percentile(perUserDayCounts, 0.5)}\n`);
  process.stdout.write(`    p75: ${percentile(perUserDayCounts, 0.75)}\n`);
  process.stdout.write(`    p95: ${percentile(perUserDayCounts, 0.95)}\n`);
  process.stdout.write(`    max: ${Math.max(...perUserDayCounts)}\n`);

  // PRD projected ~5 deliberations per refresh cycle, ~$0.035/cycle (Sonnet).
  // Estimated cost per deliberation: $0.035 / 5 = ~$0.007/deliberation (Sonnet, prompt-cached).
  const COST_PER_DELIBERATION_USD = 0.007;
  const totalDeliberations = perUserDayCounts.reduce((a, b) => a + b, 0);
  process.stdout.write(`  total deliberations in window: ${totalDeliberations}\n`);
  process.stdout.write(`  est. total cost (Sonnet, prompt-cached, $0.007/deliberation): $${(totalDeliberations * COST_PER_DELIBERATION_USD).toFixed(2)}\n`);
  process.stdout.write(`  PRD projection: $0.035/user/cycle. Production reality is from delibs/user/day × $0.007.\n`);
}

async function q4_ackRate(sb: SupabaseClient) {
  sub("Q4. Fraction of sent intros with ack_received_at set");

  const { data: log, error } = await sb.from("agent_outreach_log").select("*");
  if (error) {
    process.stdout.write(`  agent_outreach_log: ${error.message}\n`);
    return;
  }
  process.stdout.write(`  total outreach rows: ${log?.length ?? 0}\n`);
  if (!log?.length) {
    process.stdout.write(`  (no data yet)\n`);
    return;
  }

  const sent = log.filter((r) => (r as { status?: string }).status === "sent");
  const acked = sent.filter((r) => (r as { ack_received_at?: string | null }).ack_received_at !== null && (r as { ack_received_at?: string | null }).ack_received_at !== undefined);

  const failed = log.filter((r) => (r as { status?: string }).status === "failed");
  const pending = log.filter((r) => (r as { status?: string }).status === "pending");

  process.stdout.write(`  status breakdown:\n`);
  process.stdout.write(`    sent:     ${sent.length}\n`);
  process.stdout.write(`    failed:   ${failed.length}\n`);
  process.stdout.write(`    pending:  ${pending.length}\n`);

  if (sent.length) {
    const pct = ((acked.length / sent.length) * 100).toFixed(1);
    process.stdout.write(`\n  ACK rate (acked / sent): ${acked.length} / ${sent.length} = ${pct}%\n`);

    // Break down by ack_channel
    const channelCounts = new Map<string, number>();
    for (const r of acked) {
      const ch = (r as { ack_channel?: string | null }).ack_channel ?? "(null)";
      channelCounts.set(ch, (channelCounts.get(ch) ?? 0) + 1);
    }
    process.stdout.write(`  ack channels:\n`);
    for (const [ch, count] of channelCounts) {
      process.stdout.write(`    ${ch}: ${count}\n`);
    }
  }

  // Retry analysis
  const retries = log.filter((r) => ((r as { retry_count?: number }).retry_count ?? 0) > 0);
  process.stdout.write(`\n  retry analysis:\n`);
  process.stdout.write(`    rows with retry_count > 0: ${retries.length}\n`);
  if (retries.length) {
    const retryCounts = retries.map((r) => (r as { retry_count: number }).retry_count);
    process.stdout.write(`    avg retries among retried: ${(retryCounts.reduce((a, b) => a + b, 0) / retryCounts.length).toFixed(2)}\n`);
  }
}

async function q5_valuableMeetingRate(sb: SupabaseClient) {
  sub("Q5. Fraction of confirmed meetings with rating_post_meeting >= 4");

  const { data: outcomes, error } = await sb.from("matchpool_outcomes").select("*");
  if (error) {
    process.stdout.write(`  matchpool_outcomes: ${error.message}\n`);
    return;
  }
  if (!outcomes?.length) {
    process.stdout.write(`  total outcome rows: 0 (no data yet)\n`);
    return;
  }
  process.stdout.write(`  total outcome rows: ${outcomes.length}\n`);

  const happened = outcomes.filter((o) => (o as { meeting_actually_happened?: boolean }).meeting_actually_happened === true);
  const rated = happened.filter((o) => (o as { rating_post_meeting?: number | null }).rating_post_meeting !== null && (o as { rating_post_meeting?: number | null }).rating_post_meeting !== undefined);
  const valuable = rated.filter((o) => ((o as { rating_post_meeting?: number }).rating_post_meeting ?? 0) >= 4);

  process.stdout.write(`  funnel:\n`);
  process.stdout.write(`    meetings_actually_happened:  ${happened.length}\n`);
  process.stdout.write(`    of which rated:              ${rated.length}\n`);
  process.stdout.write(`    of which rating >= 4:        ${valuable.length}\n`);

  if (rated.length) {
    const pct = ((valuable.length / rated.length) * 100).toFixed(1);
    process.stdout.write(`\n  valuable-meeting rate (rating≥4 / rated): ${pct}%\n`);
    process.stdout.write(`  Hinge's analogue: phone-number-exchange rate (off-platform completion).\n`);
    process.stdout.write(`  North-star target per foundation PRD §10.4: ≥30% of attendees "best connection".\n`);
  }
}

async function q6_outliers(sb: SupabaseClient) {
  sub("Q6. Match-score outliers (MAST Inter-Agent Misalignment)");

  // Get all deliberations
  const { data: delibs, error: dErr } = await sb
    .from("matchpool_deliberations")
    .select("*");
  if (dErr) {
    process.stdout.write(`  matchpool_deliberations: ${dErr.message}\n`);
    return;
  }
  if (!delibs?.length) {
    process.stdout.write(`  (no deliberation data yet)\n`);
    return;
  }

  // Get all outcomes
  const { data: outcomes, error: oErr } = await sb.from("matchpool_outcomes").select("*");
  if (oErr) {
    process.stdout.write(`  matchpool_outcomes: ${oErr.message}\n`);
    return;
  }

  // Build a map of (source_user_id, candidate_user_id) → outcome
  const outcomeByPair = new Map<string, { agent_action?: string; counterpart_response?: string; rating_post_meeting?: number | null }>();
  for (const o of outcomes ?? []) {
    const oo = o as { source_user_id: string; candidate_user_id: string };
    outcomeByPair.set(`${oo.source_user_id}::${oo.candidate_user_id}`, o as { agent_action?: string; counterpart_response?: string; rating_post_meeting?: number | null });
  }

  // Find outliers
  const lowScoreButAccepted: Array<{ user_id: string; candidate_user_id: string; match_score: number; outcome: { agent_action?: string; counterpart_response?: string } }> = [];
  const highScoreButDeclined: Array<{ user_id: string; candidate_user_id: string; match_score: number; outcome: { agent_action?: string; counterpart_response?: string } }> = [];

  for (const d of delibs) {
    const dd = d as { user_id: string; candidate_user_id: string; match_score: number };
    const out = outcomeByPair.get(`${dd.user_id}::${dd.candidate_user_id}`);
    if (!out) continue;

    if (dd.match_score < 0.5 && out.counterpart_response === "accepted") {
      lowScoreButAccepted.push({ user_id: dd.user_id, candidate_user_id: dd.candidate_user_id, match_score: dd.match_score, outcome: out });
    }
    if (dd.match_score > 0.8 && out.counterpart_response === "declined") {
      highScoreButDeclined.push({ user_id: dd.user_id, candidate_user_id: dd.candidate_user_id, match_score: dd.match_score, outcome: out });
    }
  }

  process.stdout.write(`  deliberations: ${delibs.length}\n`);
  process.stdout.write(`  outcomes:      ${outcomes?.length ?? 0}\n\n`);
  process.stdout.write(`  outliers (MAST inter-agent misalignment):\n`);
  process.stdout.write(`    Layer 3 score < 0.5 BUT user accepted:  ${lowScoreButAccepted.length}\n`);
  process.stdout.write(`    Layer 3 score > 0.8 BUT user declined:  ${highScoreButDeclined.length}\n`);

  if (lowScoreButAccepted.length || highScoreButDeclined.length) {
    process.stdout.write(`\n  These are the "MAST 36.9% inter-agent misalignment" failures from the PRD.\n`);
    process.stdout.write(`  Surface them and re-tune Layer 3 prompts if frequent.\n`);
  } else {
    process.stdout.write(`\n  No outliers detected. Layer 3 deliberation is well-correlated with outcomes,\n`);
    process.stdout.write(`  OR not enough completed-outcome data yet to detect them.\n`);
  }
}

async function meta(sb: SupabaseClient) {
  sub("META. Schema sanity check");
  for (const t of [
    "matchpool_profiles",
    "matchpool_deliberations",
    "matchpool_outcomes",
    "agent_outreach_log",
    "matchpool_cached_top3",
    "matchpool_intros",
    "matchpool_notifications",
  ]) {
    const cols = await probeSchema(sb, t);
    if (cols === null) continue;
    process.stdout.write(`  ${t.padEnd(28)} ${cols.length ? `${cols.length} cols: ${cols.slice(0, 6).join(", ")}${cols.length > 6 ? ", ..." : ""}` : "(empty table — schema unknown from sample)"}\n`);
  }

  sub("Population overview");
  for (const t of ["matchpool_profiles", "matchpool_deliberations", "matchpool_outcomes", "agent_outreach_log", "matchpool_intros"]) {
    const { count, error } = await sb.from(t).select("*", { count: "exact", head: true });
    if (error) {
      process.stdout.write(`  ${t.padEnd(28)} (${error.message})\n`);
      continue;
    }
    process.stdout.write(`  ${t.padEnd(28)} ${count ?? 0} rows\n`);
  }
}

async function run() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  header("Matching pipeline — week-1 production data report");
  process.stdout.write(`Report time: ${new Date().toISOString()}\n`);
  process.stdout.write(`Source: Consensus production (matchpool_* + agent_outreach_log)\n`);

  await meta(sb);
  await q1_mutualScoreDistribution(sb);
  await q2_layer3Latency(sb);
  await q3_layer3Cost(sb);
  await q4_ackRate(sb);
  await q5_valuableMeetingRate(sb);
  await q6_outliers(sb);

  process.stdout.write(`\nDone.\n`);
}
run().catch((e) => { console.error("FATAL:", e); process.exit(1); });
