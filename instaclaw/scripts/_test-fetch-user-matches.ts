/**
 * Integration test for fetchUserMatchHistory against live prod DB.
 *
 * Inserts 3 synthetic matchpool_outcomes rows with varied states:
 *   • Row A: user is SOURCE side, with full reasoning + scores
 *   • Row B: user is CANDIDATE side, no scores, no reasoning
 *   • Row C: different non-edge counterpart, only deliberation_score
 *
 * Then calls fetchUserMatchHistory(testUserId) and asserts:
 *   • Returns 3 rows in created_at-DESC order
 *   • Counterpart names resolved via instaclaw_users join
 *   • iAmSource correctly flipped per-row
 *   • Reason marker prefix stripped
 *   • Confidence picked via priority order
 *
 * SAFETY:
 *   • Uses NON-edge users for FK satisfaction (no real-cohort effects)
 *   • Synthetic index_opportunity_id UUIDs (random)
 *   • Marker reason_text='[FETCH-MATCHES TEST]' for cleanup
 *   • Row lifetime ~5s end-to-end
 *
 * Note: the village trigger DOES fire on these INSERTs (match_engine
 * filter is the spawn condition; we use match_engine='index'). The
 * encounter renders briefly in the live spectator viz with anonymized
 * non-edge labels. Acceptable cost for the regression coverage —
 * matches existing _test-village-broadcast-schema.ts pattern.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

for (const l of readFileSync(
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "utf-8",
).split("\n")) {
  const m = l.match(/^([^#=]+)=(.*)$/);
  if (m && !process.env[m[1].trim()]) {
    process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

import { fetchUserMatchHistory } from "../lib/edge-dashboard-data";

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ ${msg}`); }
}

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // Pick 3 non-edge users
  const { data: users, error } = await sb
    .from("instaclaw_users")
    .select("id, name, partner")
    .or("partner.is.null,partner.neq.edge_city")
    .limit(3);
  if (error || !users || users.length < 3) {
    console.error("✗ need 3 non-edge users:", error);
    process.exit(1);
  }
  const me = users[0].id as string;
  const them1 = users[1].id as string;
  const them2 = users[2].id as string;
  console.log(`Test user (acts as both source + candidate across rows):`);
  console.log(`  me     : ${me.slice(0, 8)}…  name=${users[0].name ?? "(none)"}`);
  console.log(`  them#1 : ${them1.slice(0, 8)}…  name=${users[1].name ?? "(none)"}`);
  console.log(`  them#2 : ${them2.slice(0, 8)}…  name=${users[2].name ?? "(none)"}\n`);

  // INSERT 3 rows with varied states + slightly-staggered timestamps
  // so the ORDER BY created_at DESC is predictable. Use natural
  // recorder-pattern reason_text (no test-only prefix wrapping); we
  // cleanup by index_opportunity_id in the deletes below.
  const rowAOpp = crypto.randomUUID();
  const rowBOpp = crypto.randomUUID();
  const rowCOpp = crypto.randomUUID();
  const testOpps = [rowAOpp, rowBOpp, rowCOpp];

  console.log("=== INSERT 3 synthetic matches ===\n");

  // Row C — oldest. Recorder pattern with empty suffix (Yanek didn't
  // supply reasoning at record time). Should clean to null.
  const { data: rowC } = await sb
    .from("matchpool_outcomes")
    .insert({
      source_user_id: me,
      candidate_user_id: them2,
      match_engine: "index",
      agent_action: "proposed",
      index_opportunity_id: rowCOpp,
      reason_text: `[index:poller] opportunity=${rowCOpp} — `,
      deliberation_score: 0.65,
      // mutual + rrf intentionally null
    })
    .select("outcome_id, created_at")
    .single();
  console.log(`  Row C (oldest, source=me, candidate=them#2, no-body reason): ${rowC?.outcome_id}`);
  await new Promise((r) => setTimeout(r, 1100));

  // Row B — middle. Same empty-body pattern; I'm the CANDIDATE here.
  const { data: rowB } = await sb
    .from("matchpool_outcomes")
    .insert({
      source_user_id: them1,
      candidate_user_id: me,
      match_engine: "index",
      agent_action: "proposed",
      index_opportunity_id: rowBOpp,
      reason_text: `[index:poller] opportunity=${rowBOpp} — `,
    })
    .select("outcome_id, created_at")
    .single();
  console.log(`  Row B (middle, source=them#1, candidate=me, no scores): ${rowB?.outcome_id}`);
  await new Promise((r) => setTimeout(r, 1100));

  // Row A — newest. Full scores + real reasoning that should survive
  // the marker-prefix strip in cleanReasonText.
  const rowAReason = `[index:poller] opportunity=${rowAOpp} — both parties are working on multi-agent coordination protocols and would benefit from connecting`;
  const { data: rowA } = await sb
    .from("matchpool_outcomes")
    .insert({
      source_user_id: me,
      candidate_user_id: them1,
      match_engine: "index",
      agent_action: "proposed",
      index_opportunity_id: rowAOpp,
      reason_text: rowAReason,
      deliberation_score: 0.87,
      mutual_score: 0.91,
      rrf_score: 0.75,
    })
    .select("outcome_id, created_at")
    .single();
  console.log(`  Row A (newest, source=me, candidate=them#1, full scores): ${rowA?.outcome_id}`);

  // Wait briefly to ensure timestamps are durable
  await new Promise((r) => setTimeout(r, 500));

  // ── Fetch via the lib ──
  console.log("\n=== Call fetchUserMatchHistory(me) ===\n");
  const matches = await fetchUserMatchHistory(me);

  // ── Filter to OUR test rows (other prod rows may exist) ──
  const ours = matches.filter(
    (m) => m.outcomeId === rowA?.outcome_id ||
           m.outcomeId === rowB?.outcome_id ||
           m.outcomeId === rowC?.outcome_id
  );
  console.log(`  total matches returned: ${matches.length}`);
  console.log(`  ours (filtered to our 3 test outcomes): ${ours.length}\n`);

  assert(ours.length === 3, "all 3 synthetic matches returned");

  // ── Test 1: Order is created_at DESC (newest first) ──
  console.log("=== Test 1: ordering ===");
  if (ours.length === 3) {
    assert(ours[0].outcomeId === rowA?.outcome_id, "newest (Row A) is first");
    assert(ours[1].outcomeId === rowB?.outcome_id, "middle (Row B) is second");
    assert(ours[2].outcomeId === rowC?.outcome_id, "oldest (Row C) is last");
  }

  // ── Test 2: iAmSource correctly flipped ──
  console.log("\n=== Test 2: iAmSource flipping ===");
  const m_a = ours.find((m) => m.outcomeId === rowA?.outcome_id);
  const m_b = ours.find((m) => m.outcomeId === rowB?.outcome_id);
  const m_c = ours.find((m) => m.outcomeId === rowC?.outcome_id);
  assert(m_a?.iAmSource === true, "Row A: I am source (iAmSource=true)");
  assert(m_b?.iAmSource === false, "Row B: I am candidate (iAmSource=false)");
  assert(m_c?.iAmSource === true, "Row C: I am source (iAmSource=true)");

  // ── Test 3: counterpart user_id correctly resolved ──
  console.log("\n=== Test 3: counterpart user_id ===");
  assert(m_a?.counterpartUserId === them1, "Row A counterpart = them#1");
  assert(m_b?.counterpartUserId === them1, "Row B counterpart = them#1 (I was candidate)");
  assert(m_c?.counterpartUserId === them2, "Row C counterpart = them#2");

  // ── Test 4: counterpart name resolved via join ──
  console.log("\n=== Test 4: counterpart name resolution ===");
  const them1Name = users[1].name ?? "Anonymous";
  const them2Name = users[2].name ?? "Anonymous";
  assert(m_a?.counterpartName === them1Name, `Row A name = "${them1Name}" (got: "${m_a?.counterpartName}")`);
  assert(m_b?.counterpartName === them1Name, `Row B name = "${them1Name}"`);
  assert(m_c?.counterpartName === them2Name, `Row C name = "${them2Name}"`);

  // ── Test 5: reason text stripped ──
  console.log("\n=== Test 5: reason text marker stripping ===");
  assert(
    m_a?.reasonText === "both parties are working on multi-agent coordination protocols and would benefit from connecting",
    "Row A reason stripped of marker prefix",
  );
  assert(m_b?.reasonText === null, "Row B reason is null (just marker, no body)");
  assert(m_c?.reasonText === null, "Row C reason is null (just marker, no body)");

  // ── Test 6: confidence picked correctly ──
  console.log("\n=== Test 6: confidence score picking ===");
  assert(m_a?.scoreConfidence === 0.87, "Row A: deliberation=0.87 wins (priority)");
  assert(m_b?.scoreConfidence === null, "Row B: no scores → null");
  assert(m_c?.scoreConfidence === 0.65, "Row C: deliberation=0.65 (only one set)");

  // ── Cleanup by opportunity_id (precise, no marker dependence) ──
  console.log("\n=== Cleanup ===");
  const { error: delErr } = await sb
    .from("matchpool_outcomes")
    .delete()
    .in("index_opportunity_id", testOpps);
  if (delErr) console.warn(`  ⚠ cleanup failed: ${delErr.message}`);
  else console.log(`  ✓ deleted 3 synthetic rows by opportunity_id`);

  console.log(`\n========================`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`========================`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("✗ test threw:", e);
  process.exit(99);
});
