/**
 * Verification test for the optimistic-claim race-condition fix (#13).
 *
 * Exercises the load-bearing SQL primitive against prod's actual
 * matchpool_outcomes table:
 *
 *   1. INSERT a synthetic row with notified_source_at = NULL
 *   2. Run the optimistic-claim UPDATE — should claim (1 row returned)
 *   3. Run the SAME UPDATE again — should return 0 rows (already claimed)
 *   4. Verify the column has the FIRST claim's timestamp
 *   5. Run CAS revert with the EXACT claim timestamp — should clear (1 row)
 *   6. Run CAS revert with a DIFFERENT timestamp — should not match (0 rows)
 *   7. DELETE the synthetic row (cleanup)
 *
 * This proves the SQL pattern works against prod schema. The notifier
 * function (notifyOneSide) wires this primitive into the Telegram-send
 * flow; the wiring is straightforward but the claim primitive is what
 * actually prevents the duplicate Telegram.
 *
 * Safety:
 *   • Uses two real non-edge_city users for FK satisfaction.
 *   • Row is INSERTed with match_engine='index' but a synthetic
 *     index_opportunity_id that won't conflict with anything real.
 *   • reason_text marker "[NOTIFY-CLAIM-RACE TEST]" for cleanup.
 *   • Notifier is NOT invoked — only the SQL primitive — so no Telegram
 *     traffic, no village viz disruption.
 *   • Synthesizes an outcome row that exists for ~3 seconds total.
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

  // Pick 2 non-edge_city users for FK satisfaction
  const { data: users, error: userErr } = await sb
    .from("instaclaw_users")
    .select("id, partner")
    .or("partner.is.null,partner.neq.edge_city")
    .limit(2);
  if (userErr || !users || users.length < 2) {
    console.error("✗ couldn't find 2 non-edge_city users:", userErr);
    process.exit(1);
  }
  console.log(`Using non-edge user pair: ${users[0].id.slice(0, 8)}… + ${users[1].id.slice(0, 8)}…`);

  const indexOpportunityId = crypto.randomUUID();
  const marker = "[NOTIFY-CLAIM-RACE TEST]";

  // ── Setup: INSERT synthetic row ──
  console.log("\n=== Setup: INSERT synthetic matchpool_outcomes row ===");
  const { data: insertedRow, error: insertErr } = await sb
    .from("matchpool_outcomes")
    .insert({
      source_user_id: users[0].id,
      candidate_user_id: users[1].id,
      match_engine: "index",
      agent_action: "proposed",
      index_opportunity_id: indexOpportunityId,
      reason_text: marker,
    })
    .select("outcome_id, notified_source_at")
    .single();
  if (insertErr || !insertedRow) {
    console.error("✗ INSERT failed:", insertErr);
    process.exit(2);
  }
  const outcomeId = insertedRow.outcome_id;
  console.log(`  Inserted outcome_id=${outcomeId}, notified_source_at=${insertedRow.notified_source_at}`);
  assert(insertedRow.notified_source_at === null, "fresh row has notified_source_at = NULL");

  // ── Test 1: first claim succeeds ──
  console.log("\n=== Test 1: first optimistic-claim UPDATE ===");
  const claim1At = new Date().toISOString();
  const { data: claim1, error: claim1Err } = await sb
    .from("matchpool_outcomes")
    .update({ notified_source_at: claim1At })
    .eq("outcome_id", outcomeId)
    .is("notified_source_at", null)
    .select("outcome_id");
  if (claim1Err) {
    console.error("✗ claim1 errored:", claim1Err);
    await cleanup(sb, outcomeId);
    process.exit(3);
  }
  console.log(`  Returned ${claim1?.length ?? 0} row(s) with timestamp=${claim1At}`);
  assert((claim1?.length ?? 0) === 1, "first claim returns 1 row");

  // ── Test 2: second claim sees non-NULL, returns 0 rows ──
  console.log("\n=== Test 2: second optimistic-claim UPDATE (race) ===");
  const claim2At = new Date(Date.now() + 100).toISOString();
  const { data: claim2, error: claim2Err } = await sb
    .from("matchpool_outcomes")
    .update({ notified_source_at: claim2At })
    .eq("outcome_id", outcomeId)
    .is("notified_source_at", null)
    .select("outcome_id");
  if (claim2Err) {
    console.error("✗ claim2 errored:", claim2Err);
    await cleanup(sb, outcomeId);
    process.exit(4);
  }
  console.log(`  Returned ${claim2?.length ?? 0} row(s) — should be 0 (already claimed)`);
  assert((claim2?.length ?? 0) === 0, "second claim returns 0 rows (race lost)");

  // ── Test 3: verify the column has the FIRST claim's timestamp ──
  console.log("\n=== Test 3: verify column has FIRST claim's timestamp ===");
  const { data: rowAfter } = await sb
    .from("matchpool_outcomes")
    .select("notified_source_at")
    .eq("outcome_id", outcomeId)
    .single();
  console.log(`  notified_source_at = ${rowAfter?.notified_source_at}`);
  console.log(`  expected (claim1)  = ${claim1At}`);
  // Compare as Date instants — PostgREST returns "+00:00" form while JS
  // toISOString() returns "Z" form; same UTC instant, different strings.
  // The notifier's CAS revert relies on Postgres normalizing during the
  // WHERE comparison (Test 4 confirms this works).
  assert(
    new Date(rowAfter?.notified_source_at ?? "").getTime() === new Date(claim1At).getTime(),
    "column holds the FIRST claim's timestamp (Date-instant equality)",
  );

  // ── Test 4: CAS revert with exact timestamp succeeds ──
  console.log("\n=== Test 4: CAS revert with exact claim timestamp ===");
  const { data: revert1, error: revert1Err } = await sb
    .from("matchpool_outcomes")
    .update({ notified_source_at: null })
    .eq("outcome_id", outcomeId)
    .eq("notified_source_at", claim1At)
    .select("outcome_id");
  if (revert1Err) {
    console.error("✗ revert1 errored:", revert1Err);
    await cleanup(sb, outcomeId);
    process.exit(5);
  }
  console.log(`  Returned ${revert1?.length ?? 0} row(s)`);
  assert((revert1?.length ?? 0) === 1, "CAS revert with exact timestamp clears 1 row");

  // ── Test 5: re-claim now possible (post-revert) ──
  console.log("\n=== Test 5: re-claim possible after revert ===");
  const claim3At = new Date().toISOString();
  const { data: claim3 } = await sb
    .from("matchpool_outcomes")
    .update({ notified_source_at: claim3At })
    .eq("outcome_id", outcomeId)
    .is("notified_source_at", null)
    .select("outcome_id");
  console.log(`  Returned ${claim3?.length ?? 0} row(s)`);
  assert((claim3?.length ?? 0) === 1, "post-revert re-claim returns 1 row");

  // ── Test 6: CAS revert with WRONG timestamp returns 0 rows ──
  console.log("\n=== Test 6: CAS revert with wrong timestamp (anti-clobber) ===");
  const wrongTimestamp = new Date(Date.now() + 999999).toISOString();
  const { data: revertWrong } = await sb
    .from("matchpool_outcomes")
    .update({ notified_source_at: null })
    .eq("outcome_id", outcomeId)
    .eq("notified_source_at", wrongTimestamp)
    .select("outcome_id");
  console.log(`  Returned ${revertWrong?.length ?? 0} row(s) — should be 0 (wrong timestamp)`);
  assert((revertWrong?.length ?? 0) === 0, "CAS revert with wrong timestamp matches 0 rows");

  // ── Test 7: verify column STILL has the claim3 timestamp (anti-clobber worked) ──
  console.log("\n=== Test 7: column unchanged after wrong-timestamp revert ===");
  const { data: rowFinal } = await sb
    .from("matchpool_outcomes")
    .select("notified_source_at")
    .eq("outcome_id", outcomeId)
    .single();
  console.log(`  notified_source_at = ${rowFinal?.notified_source_at}`);
  assert(
    new Date(rowFinal?.notified_source_at ?? "").getTime() === new Date(claim3At).getTime(),
    "column still has claim3's timestamp (wrong-ts revert didn't clobber, Date-instant equality)",
  );

  // ── Cleanup ──
  await cleanup(sb, outcomeId);

  console.log(`\n========================`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`========================`);
  console.log(`\nThe SQL pattern (UPDATE … IS NULL RETURNING + CAS revert) handles`);
  console.log(`the race correctly: only ONE concurrent claim succeeds, and revert`);
  console.log(`can only clear OUR claim (not a later concurrent claim's).`);
  console.log(`\nThis is the load-bearing primitive for notifyOneSide's #13 fix.`);
  console.log(`The notifier wires it into the Telegram-send flow: claim → send →`);
  console.log(`revert-on-failure with the same CAS pattern.`);
  process.exit(failed > 0 ? 1 : 0);
}

async function cleanup(sb: ReturnType<typeof createClient>, outcomeId: string) {
  console.log("\n=== Cleanup ===");
  const { error } = await sb
    .from("matchpool_outcomes")
    .delete()
    .eq("outcome_id", outcomeId);
  if (error) console.warn(`  ⚠ cleanup failed: ${error.message}`);
  else console.log(`  ✓ deleted ${outcomeId}`);
}

main().catch((e) => {
  console.error("✗ test threw:", e);
  process.exit(99);
});
