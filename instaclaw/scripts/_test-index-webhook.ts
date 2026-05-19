/**
 * End-to-end test harness for the Index Network webhook receiver.
 *
 * What it does:
 *   1. Pulls two real edge_city VMs' (index_user_id, user_id) pairs from
 *      instaclaw_vms — ideally two whose attendees are spectator-visible
 *      with motion routines so the encounter renders on-screen.
 *   2. Generates a synthetic opportunityId (UUID v4) so it doesn't conflict
 *      with anything Index has actually emitted.
 *   3. Builds the canonical payload shape the receiver parses by default.
 *   4. Signs it with INDEX_WEBHOOK_SECRET using HMAC-SHA256 (matching what
 *      the receiver expects).
 *   5. POSTs to https://instaclaw.io/api/webhook/index-encounter.
 *   6. Verifies the matchpool_outcomes row landed (with the expected
 *      index_opportunity_id, source_user_id, candidate_user_id, engine).
 *   7. Sleeps briefly so the dual-channel trigger fires and the
 *      encounter-engine on /spectator has time to visualize.
 *   8. Cleans up by deleting the test row.
 *
 * Idempotency tests:
 *   - Re-POSTing the same payload should return 200 + status='already_recorded'.
 *   - Both behaviors are asserted.
 *
 * Negative tests:
 *   - Missing signature → 401
 *   - Wrong signature → 401
 *   - Unparseable body → 400
 *   - Unknown index_user_id → 200 + status='skipped'
 *
 * Pre-reqs:
 *   - INDEX_WEBHOOK_SECRET set in Vercel prod env (printf, no newline).
 *   - .env.local pulled with `npx vercel env pull` to read it locally.
 *   - The deployed receiver actually live on https://instaclaw.io.
 *
 * Usage:
 *   npx tsx scripts/_test-index-webhook.ts
 *   npx tsx scripts/_test-index-webhook.ts --skip-negative   # positive cases only
 */
import { readFileSync, writeFileSync } from "fs";
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

const WEBHOOK_URL =
  process.env.INDEX_WEBHOOK_URL ?? "https://instaclaw.io/api/webhook/index-encounter";
const SIGNATURE_HEADER = "x-index-signature";

const skipNegative = process.argv.includes("--skip-negative");

let passed = 0;
let failed = 0;
const log = (s: string) => console.log(s);
const assert = (cond: boolean, msg: string) => {
  if (cond) {
    passed++;
    log(`  ✓ ${msg}`);
  } else {
    failed++;
    log(`  ✗ ${msg}`);
  }
};

function sign(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

function genUuid(): string {
  // Node 19+ has crypto.randomUUID — fall back to a manual v4 if not.
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : (() => {
        const b = crypto.randomBytes(16);
        b[6] = (b[6] & 0x0f) | 0x40;
        b[8] = (b[8] & 0x3f) | 0x80;
        const h = b.toString("hex");
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
      })();
}

async function main() {
  log("\n=== Index webhook E2E test ===\n");

  const secret = process.env.INDEX_WEBHOOK_SECRET;
  if (!secret) {
    console.error("✗ INDEX_WEBHOOK_SECRET not in env. Run `npx vercel env pull` first.");
    process.exit(1);
  }
  log(`INDEX_WEBHOOK_SECRET present (len=${secret.length})`);
  log(`Target: ${WEBHOOK_URL}\n`);

  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // ── Pick two real edge_city VMs with index_user_id populated ──
  // Prefer Carter + Katherine (we used them in the prior smoke test and
  // know they're spectator-visible).
  const { data: vms } = await sb
    .from("instaclaw_vms")
    .select("name, assigned_to, index_user_id")
    .eq("partner", "edge_city")
    .not("index_user_id", "is", null)
    .not("assigned_to", "is", null)
    .order("name");

  if (!vms || vms.length < 2) {
    console.error("✗ need ≥2 edge_city VMs with index_user_id set; found", vms?.length ?? 0);
    process.exit(2);
  }
  const carter = vms.find((v) => v.name === "instaclaw-vm-917"); // Carter Cleveland
  const katherine = vms.find((v) => v.name === "instaclaw-vm-859"); // Katherine Jones
  const vmA = carter ?? vms[0];
  const vmB = katherine ?? vms[1];

  log(`Pair:`);
  log(`  source    : ${vmA.name}  index_user_id=${vmA.index_user_id?.slice(0, 8)}…  user_id=${vmA.assigned_to?.slice(0, 8)}…`);
  log(`  candidate : ${vmB.name}  index_user_id=${vmB.index_user_id?.slice(0, 8)}…  user_id=${vmB.assigned_to?.slice(0, 8)}…\n`);

  const opportunityId = genUuid();
  const recordedOutcomeIds: string[] = [];

  // ── TEST 1: happy path — signed canonical payload → 200 recorded ──
  log("=== Test 1: signed canonical payload → recorded ===");
  const happyPayload = {
    event: "opportunity.accepted",
    occurredAt: new Date().toISOString(),
    data: {
      opportunityId,
      networkId: process.env.INDEX_NETWORK_ID,
      parties: [
        { userId: vmA.index_user_id, role: "proposer" },
        { userId: vmB.index_user_id, role: "responder" },
      ],
      scores: { rrf: 0.87, mutual: 0.92, deliberation: 0.78 },
    },
  };
  const body = JSON.stringify(happyPayload);
  const sig = sign(body, secret);

  const res1 = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", [SIGNATURE_HEADER]: sig },
    body,
  });
  const data1 = await res1.json().catch(() => ({}));
  assert(res1.status === 200, `HTTP 200 (got ${res1.status})`);
  assert(data1?.result?.status === "recorded", `result.status === 'recorded' (got ${JSON.stringify(data1?.result)})`);
  assert(!!data1?.result?.outcomeId, "result.outcomeId present");
  if (data1?.result?.outcomeId) recordedOutcomeIds.push(data1.result.outcomeId);

  // Verify the DB row
  const { data: row } = await sb
    .from("matchpool_outcomes")
    .select("outcome_id, source_user_id, candidate_user_id, match_engine, agent_action, index_opportunity_id, rrf_score, mutual_score, deliberation_score, reason_text")
    .eq("index_opportunity_id", opportunityId)
    .maybeSingle();
  assert(!!row, "row landed in matchpool_outcomes");
  assert(row?.match_engine === "index", `match_engine = 'index' (got ${row?.match_engine})`);
  assert(row?.index_opportunity_id === opportunityId, "index_opportunity_id matches");
  assert(row?.source_user_id === vmA.assigned_to, "source_user_id = mapped vmA user_id");
  assert(row?.candidate_user_id === vmB.assigned_to, "candidate_user_id = mapped vmB user_id");
  assert(row?.rrf_score === 0.87, "rrf_score persisted");

  // ── TEST 2: re-POST same payload → already_recorded ──
  log("\n=== Test 2: re-POST same payload → already_recorded ===");
  const res2 = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", [SIGNATURE_HEADER]: sig },
    body,
  });
  const data2 = await res2.json().catch(() => ({}));
  assert(res2.status === 200, `HTTP 200 (got ${res2.status})`);
  assert(
    data2?.result?.status === "already_recorded",
    `result.status === 'already_recorded' (got ${JSON.stringify(data2?.result)})`,
  );

  if (!skipNegative) {
    // ── TEST 3: missing signature → 401 ──
    log("\n=== Test 3: missing signature header → 401 ===");
    const res3 = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "opportunity.accepted", data: { opportunityId: genUuid() } }),
    });
    assert(res3.status === 401, `HTTP 401 (got ${res3.status})`);

    // ── TEST 4: bad signature → 401 ──
    log("\n=== Test 4: bad signature → 401 ===");
    const badBody = JSON.stringify({ event: "opportunity.accepted", data: { opportunityId: genUuid() } });
    const res4 = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [SIGNATURE_HEADER]: "0".repeat(64),
      },
      body: badBody,
    });
    assert(res4.status === 401, `HTTP 401 on bad sig (got ${res4.status})`);

    // ── TEST 5: unparseable payload → 400 ──
    log("\n=== Test 5: unparseable payload → 400 ===");
    const garbageBody = "this is not json";
    const garbageSig = sign(garbageBody, secret);
    const res5 = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", [SIGNATURE_HEADER]: garbageSig },
      body: garbageBody,
    });
    assert(res5.status === 400, `HTTP 400 (got ${res5.status})`);

    // ── TEST 6: unknown index_user_id → 200 skipped ──
    log("\n=== Test 6: unknown index_user_id → 200 skipped ===");
    const skipPayload = {
      event: "opportunity.accepted",
      data: {
        opportunityId: genUuid(),
        parties: [
          { userId: genUuid(), role: "proposer" },
          { userId: vmB.index_user_id, role: "responder" },
        ],
      },
    };
    const skipBody = JSON.stringify(skipPayload);
    const skipSig = sign(skipBody, secret);
    const res6 = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", [SIGNATURE_HEADER]: skipSig },
      body: skipBody,
    });
    const data6 = await res6.json().catch(() => ({}));
    assert(res6.status === 200, `HTTP 200 (got ${res6.status})`);
    assert(
      data6?.result?.status === "skipped" && data6?.result?.reason === "unknown_index_user",
      `result.status='skipped' reason='unknown_index_user' (got ${JSON.stringify(data6?.result)})`,
    );
  }

  // ── CLEANUP ──
  log("\n=== Cleanup ===");
  for (const oid of recordedOutcomeIds) {
    const { error } = await sb.from("matchpool_outcomes").delete().eq("outcome_id", oid);
    if (error) console.warn(`  ⚠ delete ${oid}: ${error.message}`);
    else log(`  ✓ deleted ${oid}`);
  }

  log("\n========================");
  log(`  ${passed} passed, ${failed} failed`);
  log("========================\n");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("✗ harness threw:", e);
  process.exit(99);
});
