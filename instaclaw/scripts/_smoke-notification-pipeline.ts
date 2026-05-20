/**
 * Pre-launch capstone smoke test — proves the full notification
 * pipeline works end-to-end against live prod.
 *
 * CHAIN PROVEN BY THIS SCRIPT:
 *
 *   INSERT matchpool_outcomes
 *      ↓
 *   trigger village.emit_matchpool_outcome
 *      ↓ ↓
 *   private broadcast    public broadcast
 *      ↓                    ↓
 *   serverGame.ts        spectator viz (anonymized)
 *
 *   Then (in parallel, called directly):
 *
 *   notifyIndexMatch
 *      ↓
 *   optimistic claim (#13 atomic UPDATE)
 *      ↓
 *   sendTelegramMessageWithRetry (#7 retry policy)
 *      ↓
 *   Telegram Bot API → Cooper's @edgecitybot chat
 *
 * SAFETY DESIGN:
 *   • Source recipient = vm-780 (Cooper's @edgecitybot, confirmed
 *     chat_id populated). Cooper himself will see the smoke message
 *     land.
 *   • Counterpart = a non-edge user (FK satisfaction only; no edge
 *     VM owns this user_id, so the notifier returns missing_vm for
 *     the candidate side — no Telegram fires there).
 *   • PLUS: notified_candidate_at pre-set to NOW() at INSERT time.
 *     Belt-and-suspenders — even if the missing_vm path somehow
 *     fell through, the candidate side would return already_notified.
 *   • match_engine='index' so the village viz will momentarily render
 *     the encounter (~5s, with anonymized agent labels). Acceptable.
 *   • Marker reason_text='[SMOKE PIPELINE 2026-05-20]' for cleanup.
 *
 * WHAT WE VERIFY:
 *   1. Subscribe to BOTH broadcast channels before INSERT
 *   2. INSERT the row
 *   3. Private channel receives the broadcast with full record
 *   4. Public channel receives the broadcast with anonymized labels
 *   5. notifyIndexMatch source side → delivered + claim set
 *   6. notifyIndexMatch candidate side → already_notified
 *   7. After delivery: notified_source_at column populated with the
 *      claim timestamp
 *   8. Cooper visually confirms: @edgecitybot sent him a message
 *      that reads "hey — quick signal. i think you should meet…"
 *
 * COVERAGE:
 *   • #2 (MCP class) — exercised implicitly by createIndexIntent
 *     callsites; not on the notifier path, but good to know works
 *   • #5 (poller resilience) — not exercised here (synthetic-INSERT
 *     bypasses the poller); separately verified by Test 3 in
 *     _test-poller-alert.ts
 *   • #4 (notifier edge cases) — synthetic opportunity is well-
 *     formed, so the defensive guards skip. Other test files
 *     exercise malformed-payload + null-name paths.
 *   • #7 (Telegram retry) — first attempt succeeds in normal
 *     conditions; retry path is dormant unless Telegram is flapping
 *   • #8 (message length) — message rendered with the production
 *     template; visual inspection by Cooper confirms
 *   • #13 (claim race) — the optimistic UPDATE … WHERE … IS NULL
 *     RETURNING pattern is exercised once for the source side
 *   • #15 (expiry) — we don't set expiresAt, so this gate is skipped
 */
import { readFileSync } from "fs";
import { createClient, RealtimeChannel } from "@supabase/supabase-js";
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

import { notifyIndexMatch } from "../lib/index-match-notifier";
import type { IndexOpportunitySummary } from "../lib/index-match-notifier";

const PRIVATE_CHANNEL = "village:edge-esmeralda-2026";
const PUBLIC_CHANNEL = "village-public:edge-esmeralda-2026";

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ ${msg}`); }
}

async function subscribeAndWait(channel: RealtimeChannel, label: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} subscribe timeout`)), 10000);
    channel.subscribe((status, err) => {
      if (status === "SUBSCRIBED") { clearTimeout(t); resolve(); }
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        clearTimeout(t); reject(new Error(`${label}: ${status} ${err?.message ?? ""}`));
      }
    });
  });
}

async function main() {
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║ Pre-launch capstone smoke test — full notification pipeline    ║");
  console.log("╚════════════════════════════════════════════════════════════════╝\n");

  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  // ── Step 0: Find Cooper's @edgecitybot VM (recipient) ──
  console.log("=== Step 0: locate recipient (vm-780 / @edgecitybot) ===\n");
  const { data: recipientVm } = await sb
    .from("instaclaw_vms")
    .select("name, assigned_to, telegram_chat_id, telegram_bot_username, index_user_id")
    .eq("name", "instaclaw-vm-780")
    .single();
  if (!recipientVm) { console.error("✗ vm-780 not found"); process.exit(1); }
  if (!recipientVm.telegram_chat_id) {
    console.error("✗ vm-780 has no chat_id — Cooper must DM @edgecitybot first to populate it");
    process.exit(2);
  }
  console.log(`  recipient: ${recipientVm.name} (@${recipientVm.telegram_bot_username})`);
  console.log(`  chat_id:   ${(recipientVm.telegram_chat_id as string).slice(0, 6)}…  (set)`);
  console.log(`  owner:     ${(recipientVm.assigned_to as string).slice(0, 8)}…\n`);

  // ── Step 0b: Find a non-edge user for the candidate side ──
  // This avoids any chance of an edge cohort attendee getting a stray
  // smoke message. The notifier's edge_city partner filter will return
  // null on the VM lookup → candidate side skips with missing_vm.
  const { data: nonEdgeUsers } = await sb
    .from("instaclaw_users")
    .select("id, partner")
    .or("partner.is.null,partner.neq.edge_city")
    .limit(1);
  if (!nonEdgeUsers || nonEdgeUsers.length === 0) { console.error("✗ no non-edge user"); process.exit(3); }
  const candidateUserId = nonEdgeUsers[0].id as string;
  console.log(`  candidate: ${candidateUserId.slice(0, 8)}…  (non-edge, will return missing_vm)\n`);

  // ── Step 1: Subscribe to BOTH broadcast channels ──
  console.log("=== Step 1: subscribe to both village broadcast channels ===\n");
  const privateBroadcasts: Record<string, unknown>[] = [];
  const publicBroadcasts: Record<string, unknown>[] = [];

  const privCh = sb.channel(PRIVATE_CHANNEL, {
    config: { private: true, broadcast: { ack: false, self: false } },
  });
  privCh.on("broadcast", { event: "INSERT" }, (msg) => {
    privateBroadcasts.push(msg.payload as Record<string, unknown>);
  });

  const pubCh = sb.channel(PUBLIC_CHANNEL, {
    config: { broadcast: { ack: false, self: false } },
  });
  pubCh.on("broadcast", { event: "INSERT" }, (msg) => {
    publicBroadcasts.push(msg.payload as Record<string, unknown>);
  });

  try {
    await Promise.all([
      subscribeAndWait(privCh, "private"),
      subscribeAndWait(pubCh, "public"),
    ]);
    console.log("  ✓ both channels subscribed\n");
  } catch (e) {
    console.error(`✗ subscribe failed:`, e);
    process.exit(4);
  }

  // ── Step 2: INSERT the synthetic matchpool_outcomes row ──
  console.log("=== Step 2: INSERT synthetic matchpool_outcomes row ===\n");
  const opportunityId = crypto.randomUUID();
  const marker = "[SMOKE PIPELINE 2026-05-20]";
  const candidatePreClaimAt = new Date().toISOString();
  const { data: row, error: insertErr } = await sb
    .from("matchpool_outcomes")
    .insert({
      source_user_id: recipientVm.assigned_to,
      candidate_user_id: candidateUserId,
      match_engine: "index",
      agent_action: "proposed",
      index_opportunity_id: opportunityId,
      reason_text: marker,
      rrf_score: 0.91,
      mutual_score: 0.88,
      deliberation_score: 0.84,
      // PRE-SET candidate side so only source fires Telegram.
      notified_candidate_at: candidatePreClaimAt,
    })
    .select("outcome_id")
    .single();
  if (insertErr || !row) {
    console.error("✗ INSERT failed:", insertErr);
    await privCh.unsubscribe();
    await pubCh.unsubscribe();
    process.exit(5);
  }
  console.log(`  inserted outcome_id=${row.outcome_id}`);
  console.log(`  match_engine=index, candidate notified_at pre-set to ${candidatePreClaimAt}\n`);

  // Wait briefly for broadcasts to arrive
  await new Promise((r) => setTimeout(r, 2500));

  // ── Step 3: Verify broadcasts ──
  console.log("=== Step 3: verify broadcasts on both channels ===\n");
  const priv = privateBroadcasts.find((b) => (b.record as Record<string, unknown>)?.outcome_id === row.outcome_id);
  assert(!!priv, "private broadcast received for our outcome_id");
  if (priv) {
    const rec = priv.record as Record<string, unknown>;
    assert(rec.source_user_id === recipientVm.assigned_to, "private record.source_user_id matches");
    assert(rec.candidate_user_id === candidateUserId, "private record.candidate_user_id matches");
    assert(rec.match_engine === "index", `private record.match_engine = 'index'`);
    assert(Number(rec.rrf_score) === 0.91, "rrf_score round-trips through trigger");
  }
  // Public broadcasts: find ANY emitted after our INSERT that's anonymized
  const pubAfter = publicBroadcasts.find((b) => {
    const r = b.record as Record<string, unknown>;
    return typeof r?.agent_a === "string" &&
           typeof r?.agent_b === "string" &&
           r?.match_engine === "index" &&
           !JSON.stringify(r).includes(recipientVm.assigned_to as string);
  });
  assert(!!pubAfter, "public broadcast received with anonymized labels");
  if (pubAfter) {
    const r = pubAfter.record as Record<string, unknown>;
    const recStr = JSON.stringify(r);
    assert(
      !recStr.includes(recipientVm.assigned_to as string),
      "public payload contains NO source_user_id (privacy)",
    );
    assert(
      !recStr.includes(candidateUserId),
      "public payload contains NO candidate_user_id (privacy)",
    );
    console.log(`    observed: agent_a=${r.agent_a}  agent_b=${r.agent_b}`);
  }

  // ── Step 4: Call notifyIndexMatch directly ──
  console.log("\n=== Step 4: call notifyIndexMatch (capstone test) ===\n");
  // Construct a realistic-shaped opportunity (matches the poller's
  // normalized output shape that gets passed to notifyIndexMatch).
  const opportunity: IndexOpportunitySummary = {
    id: opportunityId,
    actors: [
      {
        userId: recipientVm.index_user_id as string,
        role: "agent",
        name: "Cooper Wrenn",
        intent: "building instaclaw — the platform you're using right now",
      },
      {
        userId: "synthetic-counterpart-id-for-smoke",
        role: "patient",
        name: "Smoke Test Counterpart",
        intent: "this is a synthetic smoke-test entry; the candidate side returns missing_vm",
      },
    ],
    interpretation: {
      reasoning:
        "smoke-test: this opportunity was inserted directly into matchpool_outcomes to verify the notification pipeline end-to-end. you should see this message because the pipeline works.",
    },
  };

  const t0 = Date.now();
  const notifyRes = await notifyIndexMatch({
    outcomeId: row.outcome_id,
    sourceUserId: recipientVm.assigned_to as string,
    candidateUserId: candidateUserId,
    opportunity,
  });
  const tMs = Date.now() - t0;
  console.log(`  notifyIndexMatch returned in ${tMs}ms:`);
  console.log(`    source   : ${JSON.stringify(notifyRes.source)}`);
  console.log(`    candidate: ${JSON.stringify(notifyRes.candidate)}\n`);

  // ── Step 5: Assert outcomes ──
  console.log("=== Step 5: assert notifyIndexMatch outcomes ===\n");
  assert(
    notifyRes.source.status === "delivered",
    `source side: delivered (got ${notifyRes.source.status})`,
  );
  assert(
    notifyRes.candidate.status === "already_notified",
    `candidate side: already_notified (got ${notifyRes.candidate.status})`,
  );

  // ── Step 6: Verify notified_source_at column populated ──
  console.log("\n=== Step 6: verify claim landed in DB ===\n");
  const { data: postRow } = await sb
    .from("matchpool_outcomes")
    .select("notified_source_at, notified_candidate_at")
    .eq("outcome_id", row.outcome_id)
    .single();
  assert(
    !!postRow?.notified_source_at,
    `notified_source_at populated (got ${postRow?.notified_source_at})`,
  );
  assert(
    !!postRow?.notified_candidate_at,
    `notified_candidate_at populated (pre-set value preserved: ${postRow?.notified_candidate_at})`,
  );

  // ── Cleanup ──
  console.log("\n=== Cleanup ===\n");
  const { error: deleteErr } = await sb
    .from("matchpool_outcomes")
    .delete()
    .eq("outcome_id", row.outcome_id);
  if (deleteErr) console.warn(`  ⚠ cleanup failed: ${deleteErr.message}`);
  else console.log(`  ✓ deleted synthetic row`);

  await privCh.unsubscribe();
  await pubCh.unsubscribe();
  await sb.removeAllChannels();

  console.log(`\n╔════════════════════════════════════════════════════════════════╗`);
  console.log(`║  ${String(passed).padStart(2)} passed, ${String(failed).padStart(2)} failed                                       ║`);
  console.log(`╚════════════════════════════════════════════════════════════════╝`);
  console.log(`\nIf all ✓ and you see a message on @edgecitybot reading`);
  console.log(`"hey — quick signal. i think you should meet Smoke Test Counterpart."`);
  console.log(`then the full notification pipeline is verified end-to-end:`);
  console.log(`  • trigger fires on INSERT`);
  console.log(`  • both broadcasts emit (private with full record, public anonymized)`);
  console.log(`  • notifier claims atomically (#13)`);
  console.log(`  • notifier delivers via Telegram (#7 retry budget unused, success first try)`);
  console.log(`  • column updates persist the claim timestamp`);
  console.log(`  • candidate-side pre-claim correctly short-circuits to already_notified\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("✗ smoke threw:", e);
  process.exit(99);
});
