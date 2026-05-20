/**
 * Smoke test for notifyIndexMatch — three modes:
 *
 *   1. DRY-RUN (default): print the message that WOULD be sent for a
 *      synthetic match between two cohort users. No DB writes, no
 *      Telegram calls. Use this to review the copy.
 *
 *   2. --insert-test-row: INSERT a real matchpool_outcomes row with
 *      synthetic data and call notifyIndexMatch. Verifies the full
 *      DB → notifier → Telegram path. Sends ACTUAL messages to the
 *      cohort users (only those with telegram_chat_id populated will
 *      receive). Cleans up the row afterward.
 *
 *   3. --target=vmname: address a specific cohort VM as recipient.
 *      Useful for testing with your own bot's chat. Defaults to
 *      instaclaw-vm-859 (Katherine Jones — confirmed chat_id populated).
 *
 * Usage:
 *   npx tsx scripts/_test-match-notification.ts
 *   npx tsx scripts/_test-match-notification.ts --insert-test-row
 *   npx tsx scripts/_test-match-notification.ts --insert-test-row --target=instaclaw-vm-859
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

for (const l of readFileSync(
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "utf-8",
).split("\n")) {
  const m = l.match(/^([^#=]+)=(.*)$/);
  if (m && !process.env[m[1].trim()]) {
    process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

import { buildMatchNotificationMessage, notifyIndexMatch } from "../lib/index-match-notifier";
import type { IndexOpportunitySummary } from "../lib/index-match-notifier";

const argv = process.argv.slice(2);
const insertReal = argv.includes("--insert-test-row");
const targetFlag = argv.find((a) => a.startsWith("--target="))?.replace("--target=", "");

async function main() {
  console.log("\n=== Match-notification smoke test ===\n");

  // ── Mode 1: dry-run preview ──
  // Always print the canonical message shape so we can review the copy.
  console.log("=== DRY-RUN: message preview (canonical case with reasoning) ===\n");
  const previewFull = buildMatchNotificationMessage({
    counterpartName: "Seref Yarar",
    counterpartIntent: "building agent-to-agent messaging infrastructure for multi-agent systems",
    reasoning:
      "The edge city directory noticed a strong overlap between both parties' intent signals around multi-agent coordination and discovery protocols.",
  });
  console.log("---");
  console.log(previewFull);
  console.log("---");
  console.log();

  console.log("=== DRY-RUN: message preview (no reasoning) ===\n");
  const previewMinimal = buildMatchNotificationMessage({
    counterpartName: "Alex Komoroske",
    counterpartIntent: "co-founder and CEO of Common Tools, building resonant computing infrastructure",
    reasoning: null,
  });
  console.log("---");
  console.log(previewMinimal);
  console.log("---");
  console.log();

  console.log("=== DRY-RUN: message preview (long reasoning — gets omitted as jargon) ===\n");
  const previewJargon = buildMatchNotificationMessage({
    counterpartName: "Some Researcher",
    counterpartIntent: "vector embeddings, retrieval-augmented generation, dense semantic retrieval research",
    reasoning:
      "User A's intent expressed via natural language describes work on retrieval-augmented generation systems with a focus on dense semantic retrieval; the discovery engine evaluated bidirectional intent vectors at cosine similarity 0.87, well above the 0.65 threshold for opportunity proposal in this network's index, and confirmed the complementarity dimension via cross-projection along the multi-agent coordination axis where both parties expressed interest.",
  });
  console.log("---");
  console.log(previewJargon);
  console.log("---");
  console.log();

  console.log("=== DRY-RUN: message preview (pathological counterpart name — gets capped) ===\n");
  const previewLongName = buildMatchNotificationMessage({
    counterpartName:
      "Dr. Christopher Maximilian Theodore Wellington-Featherstone III, PhD, MD, MBA, " +
      "Senior Distinguished Research Fellow at the Institute for Advanced Multi-Agent Studies",
    counterpartIntent: "building agent coordination protocols",
    reasoning: null,
  });
  console.log("---");
  console.log(previewLongName);
  console.log("---");
  console.log(`(length: ${previewLongName.length} chars — should be well under 3500)`);
  console.log();

  console.log("=== DRY-RUN: message preview (empty/whitespace counterpart name — falls back to placeholder) ===\n");
  const previewEmptyName = buildMatchNotificationMessage({
    counterpartName: "   \n\t  ",
    counterpartIntent: "designing agent-to-agent negotiation protocols",
    reasoning: null,
  });
  console.log("---");
  console.log(previewEmptyName);
  console.log("---");
  console.log();

  console.log("=== DRY-RUN: message preview (multiline name — whitespace collapses to single space) ===\n");
  const previewMultiline = buildMatchNotificationMessage({
    counterpartName: "Carter\n\nCleveland",
    counterpartIntent: null,
    reasoning: null,
  });
  console.log("---");
  console.log(previewMultiline);
  console.log("---");
  console.log();

  // ── Expiry test (#15) ──
  //
  // Call notifyIndexMatch with a synthetic past-expiry opportunity. The
  // expiry gate returns BEFORE any DB / VM / Telegram lookup, so this is
  // safe to run unconditionally without --insert-test-row.
  console.log("=== TEST: opportunity-expiry gate (notifyIndexMatch short-circuit) ===\n");
  const expiredOpp: IndexOpportunitySummary = {
    id: "synthetic-expired-opportunity-id",
    actors: [
      { userId: "synthetic-user-a", role: "agent", name: "Alex Test", intent: "test intent A" },
      { userId: "synthetic-user-b", role: "patient", name: "Brooke Test", intent: "test intent B" },
    ],
    expiresAt: "2025-01-01T00:00:00Z", // long in the past
  };
  const expiredRes = await notifyIndexMatch({
    outcomeId: "00000000-0000-0000-0000-000000000000", // doesn't have to exist; we short-circuit first
    sourceUserId: "synthetic-source",
    candidateUserId: "synthetic-candidate",
    opportunity: expiredOpp,
  });
  console.log(`  source   : ${JSON.stringify(expiredRes.source)}`);
  console.log(`  candidate: ${JSON.stringify(expiredRes.candidate)}`);
  const sourceOk =
    expiredRes.source.status === "skipped" && expiredRes.source.reason === "expired";
  const candidateOk =
    expiredRes.candidate.status === "skipped" && expiredRes.candidate.reason === "expired";
  console.log(`  ${sourceOk && candidateOk ? "✓ PASS" : "✗ FAIL"} — both sides should be {skipped, expired}`);
  console.log();

  console.log("=== TEST: opportunity-expiry with future expiry should NOT short-circuit ===\n");
  const futureExpiryOpp: IndexOpportunitySummary = {
    id: "synthetic-future-opportunity-id",
    actors: [
      { userId: "synthetic-user-a", role: "agent", name: "Alex Test", intent: "test intent A" },
      { userId: "synthetic-user-b", role: "patient", name: "Brooke Test", intent: "test intent B" },
    ],
    expiresAt: "2099-12-31T23:59:59Z", // long in the future
  };
  const futureRes = await notifyIndexMatch({
    outcomeId: "00000000-0000-0000-0000-000000000000",
    sourceUserId: "synthetic-source",
    candidateUserId: "synthetic-candidate",
    opportunity: futureExpiryOpp,
  });
  console.log(`  source   : ${JSON.stringify(futureRes.source)}`);
  console.log(`  candidate: ${JSON.stringify(futureRes.candidate)}`);
  // With future expiry, the gate doesn't fire — the function proceeds past
  // the expiry check and into the outcome-row fetch. The synthetic outcome
  // row doesn't exist, so we expect outcome_row_not_found (which proves
  // the expiry gate didn't short-circuit prematurely).
  const futureGateBypassed =
    futureRes.source.status === "failed" && futureRes.source.reason === "outcome_row_not_found";
  console.log(`  ${futureGateBypassed ? "✓ PASS" : "✗ FAIL"} — future-expiry should fall through to row-fetch (returns outcome_row_not_found here because synthetic)`);
  console.log();

  console.log("=== TEST: malformed expiresAt should NOT short-circuit (defensive parse) ===\n");
  const malformedExpiryOpp: IndexOpportunitySummary = {
    id: "synthetic-malformed",
    actors: [
      { userId: "synthetic-user-a", role: "agent", name: "Alex Test", intent: "test intent A" },
      { userId: "synthetic-user-b", role: "patient", name: "Brooke Test", intent: "test intent B" },
    ],
    expiresAt: "not-a-real-date-string",
  };
  const malformedRes = await notifyIndexMatch({
    outcomeId: "00000000-0000-0000-0000-000000000000",
    sourceUserId: "synthetic-source",
    candidateUserId: "synthetic-candidate",
    opportunity: malformedExpiryOpp,
  });
  // Same logic as future-expiry: gate bypasses, then outcome_row_not_found.
  const malformedGateBypassed =
    malformedRes.source.status === "failed" && malformedRes.source.reason === "outcome_row_not_found";
  console.log(`  source: ${JSON.stringify(malformedRes.source)}`);
  console.log(`  ${malformedGateBypassed ? "✓ PASS" : "✗ FAIL"} — malformed expiresAt should fall through (defensive parse)`);
  console.log();

  // ── Malformed-payload tests (#4) ──
  // All three of these short-circuit BEFORE any DB / VM / Telegram
  // call, so they're safe to run unconditionally with a fake outcomeId.

  console.log("=== TEST: malformed payload — opportunity is null ===\n");
  const nullOppRes = await notifyIndexMatch({
    outcomeId: "00000000-0000-0000-0000-000000000000",
    sourceUserId: "synthetic-source",
    candidateUserId: "synthetic-candidate",
    // deliberately bypass TS type check to simulate Yanek sending broken data
    opportunity: null as unknown as IndexOpportunitySummary,
  });
  const nullOppOk =
    nullOppRes.source.status === "skipped" &&
    nullOppRes.source.reason === "malformed_payload" &&
    nullOppRes.candidate.status === "skipped" &&
    nullOppRes.candidate.reason === "malformed_payload";
  console.log(`  source   : ${JSON.stringify(nullOppRes.source)}`);
  console.log(`  candidate: ${JSON.stringify(nullOppRes.candidate)}`);
  console.log(`  ${nullOppOk ? "✓ PASS" : "✗ FAIL"} — both sides should be {skipped, malformed_payload}`);
  console.log();

  console.log("=== TEST: malformed payload — actors is not an array ===\n");
  const badActorsRes = await notifyIndexMatch({
    outcomeId: "00000000-0000-0000-0000-000000000000",
    sourceUserId: "synthetic-source",
    candidateUserId: "synthetic-candidate",
    opportunity: {
      id: "synthetic-bad-actors",
      actors: "not-an-array" as unknown as Array<{ userId: string }>,
    } as IndexOpportunitySummary,
  });
  const badActorsOk =
    badActorsRes.source.status === "skipped" &&
    badActorsRes.source.reason === "malformed_payload";
  console.log(`  source: ${JSON.stringify(badActorsRes.source)}`);
  console.log(`  ${badActorsOk ? "✓ PASS" : "✗ FAIL"} — actors=string skips with malformed_payload`);
  console.log();

  console.log("=== TEST: malformed payload — single-actor opportunity ===\n");
  const singleActorRes = await notifyIndexMatch({
    outcomeId: "00000000-0000-0000-0000-000000000000",
    sourceUserId: "synthetic-source",
    candidateUserId: "synthetic-candidate",
    opportunity: {
      id: "synthetic-single-actor",
      actors: [{ userId: "only-one-actor", role: "agent", name: "Lonely" }],
    },
  });
  const singleActorOk =
    singleActorRes.source.status === "skipped" &&
    singleActorRes.source.reason === "malformed_payload";
  console.log(`  source: ${JSON.stringify(singleActorRes.source)}`);
  console.log(`  ${singleActorOk ? "✓ PASS" : "✗ FAIL"} — <2 actors skips with malformed_payload`);
  console.log();

  // ── Counterpart-name garbage-string tests (#4) ──
  // capCounterpartName is internal — tested via buildMatchNotificationMessage.
  console.log("=== DRY-RUN: counterpart name 'null' (literal-garbage) → placeholder ===\n");
  const nameNull = buildMatchNotificationMessage({
    counterpartName: "null",
    counterpartIntent: "designing protocols",
    reasoning: null,
  });
  console.log("---");
  console.log(nameNull);
  console.log("---");
  const nameNullOk = nameNull.includes("someone in the directory") && !nameNull.includes("meet null");
  console.log(`  ${nameNullOk ? "✓ PASS" : "✗ FAIL"} — 'null' substituted with placeholder`);
  console.log();

  console.log("=== DRY-RUN: counterpart name 'undefined' (literal-garbage) → placeholder ===\n");
  const nameUndef = buildMatchNotificationMessage({
    counterpartName: "undefined",
    counterpartIntent: null,
    reasoning: null,
  });
  const nameUndefOk = nameUndef.includes("someone in the directory") && !nameUndef.includes("meet undefined");
  console.log(`  message includes placeholder: ${nameUndefOk}`);
  console.log(`  ${nameUndefOk ? "✓ PASS" : "✗ FAIL"} — 'undefined' substituted`);
  console.log();

  console.log("=== DRY-RUN: counterpart name '(unknown)' → placeholder ===\n");
  const nameUnk = buildMatchNotificationMessage({
    counterpartName: "(unknown)",
    counterpartIntent: null,
    reasoning: null,
  });
  const nameUnkOk = nameUnk.includes("someone in the directory");
  console.log(`  ${nameUnkOk ? "✓ PASS" : "✗ FAIL"} — '(unknown)' substituted`);
  console.log();

  console.log("=== DRY-RUN: counterpart name 'N/A' (case-insensitive) → placeholder ===\n");
  const nameNa = buildMatchNotificationMessage({
    counterpartName: "N/A",
    counterpartIntent: null,
    reasoning: null,
  });
  const nameNaOk = nameNa.includes("someone in the directory");
  console.log(`  ${nameNaOk ? "✓ PASS" : "✗ FAIL"} — 'N/A' substituted (case-insensitive)`);
  console.log();

  console.log("=== DRY-RUN: counterpart name '  Carter  ' (real name, trimmed) → renders normally ===\n");
  const nameReal = buildMatchNotificationMessage({
    counterpartName: "  Carter  ",
    counterpartIntent: null,
    reasoning: null,
  });
  const nameRealOk = nameReal.includes("meet Carter.") && !nameReal.includes("someone in the directory");
  console.log(`  ${nameRealOk ? "✓ PASS" : "✗ FAIL"} — whitespace trimmed, real name preserved`);
  console.log();

  if (!insertReal) {
    console.log("Run with --insert-test-row to actually fire end-to-end (will send real Telegram messages to cohort users with chat_id populated).");
    return;
  }

  // ── Mode 2: insert + fire ──
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // Pick a recipient with chat_id populated (so Telegram actually fires).
  const targetVmName = targetFlag ?? "instaclaw-vm-859";
  const { data: recipientVm } = await sb
    .from("instaclaw_vms")
    .select("name, assigned_to, index_user_id, telegram_chat_id")
    .eq("name", targetVmName)
    .single();
  if (!recipientVm?.telegram_chat_id) {
    console.error(`✗ ${targetVmName} has no telegram_chat_id; cannot test real fire. Pick a different --target.`);
    process.exit(1);
  }

  // Pick a counterpart (any other cohort VM with index_user_id).
  const { data: counterparts } = await sb
    .from("instaclaw_vms")
    .select("name, assigned_to, index_user_id")
    .eq("partner", "edge_city")
    .not("index_user_id", "is", null)
    .neq("name", targetVmName)
    .limit(1);
  if (!counterparts || counterparts.length === 0) {
    console.error("✗ no other cohort VM available as counterpart");
    process.exit(2);
  }
  const counterpart = counterparts[0];

  // Look up the counterpart user's display name so the notification reads naturally
  const { data: counterpartUser } = await sb
    .from("instaclaw_users")
    .select("name")
    .eq("id", counterpart.assigned_to as string)
    .single();
  const counterpartName = counterpartUser?.name ?? counterpart.name ?? "someone in the directory";

  console.log("=== INSERT + fire ===");
  console.log(`Recipient : ${recipientVm.name}  chat_id=${recipientVm.telegram_chat_id}`);
  console.log(`Counterpart: ${counterpart.name} (${counterpartName})`);
  console.log();

  // Synthetic Index opportunity ID (won't conflict with anything real).
  const opportunityId = crypto.randomUUID();

  // INSERT a matchpool_outcomes row. Use existing outreach_log_id linkage
  // pattern from the earlier smoke test (or our new index_opportunity_id).
  const { data: row, error: insertErr } = await sb
    .from("matchpool_outcomes")
    .insert({
      source_user_id: recipientVm.assigned_to,
      candidate_user_id: counterpart.assigned_to,
      match_engine: "index",
      agent_action: "proposed",
      index_opportunity_id: opportunityId,
      reason_text: "[NOTIFICATION SMOKE 2026-05-19] real Telegram fire — safe to delete",
    })
    .select("outcome_id")
    .single();
  if (insertErr || !row) {
    console.error("✗ INSERT failed:", insertErr);
    process.exit(3);
  }
  console.log(`Inserted outcome_id=${row.outcome_id}`);

  // Fire the notifier. Synthetic Index opportunity object — actors[]
  // must match the index_user_ids we stored so the recipient resolves
  // its counterpart correctly.
  const syntheticOpportunity = {
    id: opportunityId,
    actors: [
      {
        userId: recipientVm.index_user_id as string,
        role: "agent" as const,
        name: "(this is you)",
        intent: "(your stored intent here)",
      },
      {
        userId: counterpart.index_user_id as string,
        role: "patient" as const,
        name: counterpartName,
        intent: "building Edge City attendee infrastructure — this is a smoke test, please disregard if you got this message",
      },
    ],
    interpretation: {
      reasoning:
        "This is a smoke test of the notification pipeline. The matchpool_outcomes row will be deleted shortly after this message lands.",
    },
  };

  const notifyRes = await notifyIndexMatch({
    outcomeId: row.outcome_id,
    sourceUserId: recipientVm.assigned_to as string,
    candidateUserId: counterpart.assigned_to as string,
    opportunity: syntheticOpportunity,
  });
  console.log("Notify result:");
  console.log(`  source    : ${JSON.stringify(notifyRes.source)}`);
  console.log(`  candidate : ${JSON.stringify(notifyRes.candidate)}`);

  // Wait briefly then verify notified_*_at columns landed
  await new Promise((r) => setTimeout(r, 500));
  const { data: verifyRow } = await sb
    .from("matchpool_outcomes")
    .select("notified_source_at, notified_candidate_at")
    .eq("outcome_id", row.outcome_id)
    .single();
  console.log(`Row after notify: source=${verifyRow?.notified_source_at} candidate=${verifyRow?.notified_candidate_at}`);

  // ── Cleanup ──
  console.log("\n=== Cleanup ===");
  const { error: deleteErr } = await sb
    .from("matchpool_outcomes")
    .delete()
    .eq("outcome_id", row.outcome_id);
  if (deleteErr) console.warn("⚠ cleanup failed:", deleteErr.message);
  else console.log(`✓ deleted ${row.outcome_id}`);
}

main().catch((e) => {
  console.error("✗ test threw:", e);
  process.exit(99);
});
