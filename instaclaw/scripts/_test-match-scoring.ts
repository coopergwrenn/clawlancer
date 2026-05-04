/**
 * End-to-end test for Component 6 (lib/match-scoring.ts) and the
 * matchpool_compute_topk_mutual RPC (migration 20260504b).
 *
 * Strategy: seed 6 fake users with hand-tuned 1024-dim sparse-basis
 * embeddings. Each user's offering and seeking embeddings are unit
 * vectors aligned with one of four orthogonal "concept" axes
 * (founder, investor, research, engineering). With orthogonal concept
 * vectors, cosine similarities are exactly 0 or 1 (or known sqrt(2)/2
 * for mixed concepts), making the geometric-mean math verifiable
 * by hand.
 *
 * Test cases (from caller A's perspective):
 *
 *   A.offering = founder,  A.seeking = investor
 *   B.offering = investor, B.seeking = founder       → mutual = 1.0 (perfect)
 *   C.offering = founder,  C.seeking = investor      → mutual = 0  (forward=0)
 *   D.offering = founder,  D.seeking = investor      → same as C
 *   E.offering = research, E.seeking = research      → mutual = 0  (forward=0)
 *   F.offering = engineer, F.seeking = research      → mutual = 0  (forward=0)
 *   H.offering = (investor + research)/√2,
 *   H.seeking  = (founder + research)/√2             → mutual = 0.5
 *
 * Expected order from A's POV: [B (1.0), H (~0.5)]. Everyone else
 * filtered out by `forward_score > 0 AND reverse_score > 0`.
 *
 * Additional asserts:
 *   - excludeUserIds works (pass B's id, B disappears from results)
 *   - consent_tier='hidden' rows are excluded (set H to hidden, H gone)
 *   - top_k limits returned rows
 *   - asymmetric "stalker" pattern (high forward, zero reverse) is
 *     correctly killed by geometric mean
 *
 * Cleanup: deletes the 7 test profiles + users at exit.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  const env = readFileSync(f, "utf-8");
  for (const l of env.split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

import { computeTopKMutual } from "../lib/match-scoring";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ─── Embedding helpers ──────────────────────────────────────────────

const DIMS = 1024;

/** Build a 1024-dim sparse unit vector with the given coordinates. */
function vec(coords: Record<number, number>): string {
  const v = new Array<number>(DIMS).fill(0);
  for (const [idx, val] of Object.entries(coords)) v[Number(idx)] = val;
  // No need to normalize callers — we pass already-unit-norm coords.
  return "[" + v.map((x) => (x === 0 ? "0" : x.toString())).join(",") + "]";
}

// Concept axes
const FOUNDER = 0;
const INVESTOR = 1;
const RESEARCH = 2;
const ENGINEER = 3;

// Pure-concept vectors
const v_founder = vec({ [FOUNDER]: 1 });
const v_investor = vec({ [INVESTOR]: 1 });
const v_research = vec({ [RESEARCH]: 1 });
const v_engineer = vec({ [ENGINEER]: 1 });

// Mixed-concept vectors (each component 1/√2 → unit-norm)
const SQRT2 = Math.SQRT1_2;
const v_inv_research = vec({ [INVESTOR]: SQRT2, [RESEARCH]: SQRT2 });
const v_founder_research = vec({ [FOUNDER]: SQRT2, [RESEARCH]: SQRT2 });

// ─── Test users ─────────────────────────────────────────────────────

const TEST_TAG = "matchscore-test-2026-05-04";

interface TestUser {
  id: string;
  agent_id: string;
  label: string;
  offering: string;
  seeking: string;
  offering_summary: string;
  seeking_summary: string;
  consent_tier?: string;
}

const USERS: TestUser[] = [
  {
    id: "aaaaaaaa-0000-0000-0000-00000000000a",
    agent_id: "test-agent-A",
    label: "A (caller, founder/investor)",
    offering: v_founder,
    seeking: v_investor,
    offering_summary: "founder of an AI agent platform",
    seeking_summary: "early-stage investors",
    consent_tier: "interests",
  },
  {
    id: "aaaaaaaa-0000-0000-0000-00000000000b",
    agent_id: "test-agent-B",
    label: "B (perfect match, investor/founder)",
    offering: v_investor,
    seeking: v_founder,
    offering_summary: "VC partner backing AI infra",
    seeking_summary: "founders building agent platforms",
    consent_tier: "interests",
  },
  {
    id: "aaaaaaaa-0000-0000-0000-00000000000c",
    agent_id: "test-agent-C",
    label: "C (no match, founder/investor — same as A)",
    offering: v_founder,
    seeking: v_investor,
    offering_summary: "another founder",
    seeking_summary: "another investor seeker",
    consent_tier: "interests",
  },
  {
    id: "aaaaaaaa-0000-0000-0000-00000000000d",
    agent_id: "test-agent-D",
    label: "D (no match, also founder/investor)",
    offering: v_founder,
    seeking: v_investor,
    offering_summary: "yet another founder",
    seeking_summary: "yet another investor seeker",
    consent_tier: "interests",
  },
  {
    id: "aaaaaaaa-0000-0000-0000-00000000000e",
    agent_id: "test-agent-E",
    label: "E (no match, research/research)",
    offering: v_research,
    seeking: v_research,
    offering_summary: "AI research collaborator",
    seeking_summary: "AI research collaborators",
    consent_tier: "interests",
  },
  {
    id: "aaaaaaaa-0000-0000-0000-00000000000f",
    agent_id: "test-agent-F",
    label: "F (asymmetric stalker, engineer/research)",
    offering: v_engineer,
    seeking: v_research,
    offering_summary: "infrastructure engineer",
    seeking_summary: "research collaborators",
    consent_tier: "interests",
  },
  {
    id: "aaaaaaaa-0000-0000-0000-0000000000aa",
    agent_id: "test-agent-H",
    label: "H (partial match, mixed concepts)",
    offering: v_inv_research,
    seeking: v_founder_research,
    offering_summary: "investor with research bent",
    seeking_summary: "founder-researchers",
    consent_tier: "interests",
  },
];

const callerId = USERS[0].id;
const userB_id = USERS[1].id;
const userH_id = USERS[6].id;

// ─── Test scaffolding ────────────────────────────────────────────────

let pass = 0, fail = 0;
const ok = (m: string) => { console.log(`  ✓ ${m}`); pass++; };
const bad = (m: string) => { console.log(`  ✗ ${m}`); fail++; };
const approxEq = (a: number, b: number, eps = 0.01) => Math.abs(a - b) < eps;

async function setup() {
  // Pre-cleanup in case a prior run died mid-test
  await cleanup(/* silent */ true);

  // Seed instaclaw_users rows
  const userRows = USERS.map((u) => ({
    id: u.id,
    email: `${u.label.split(" ")[0].toLowerCase()}-${TEST_TAG}@test.invalid`,
    name: `Test ${u.label}`,
  }));
  const { error: uErr } = await sb.from("instaclaw_users").insert(userRows);
  if (uErr) throw new Error(`seed users: ${uErr.message}`);

  // Seed matchpool_profiles rows
  const profRows = USERS.map((u) => ({
    user_id: u.id,
    agent_id: u.agent_id,
    offering_summary: u.offering_summary,
    seeking_summary: u.seeking_summary,
    interests: ["test"],
    looking_for: ["test"],
    format_preferences: ["1on1"],
    offering_embedding: u.offering,
    seeking_embedding: u.seeking,
    embedding_model: "test/synthetic@1024",
    consent_tier: u.consent_tier ?? "interests",
    profile_version: 1,
    intent_extracted_at: new Date().toISOString(),
    intent_extraction_confidence: 1.0,
  }));
  const { error: pErr } = await sb.from("matchpool_profiles").insert(profRows);
  if (pErr) throw new Error(`seed profiles: ${pErr.message}`);
}

async function cleanup(silent = false) {
  const ids = USERS.map((u) => u.id);
  // Delete profiles first (no FK from users to profiles, but matchpool_profiles
  // FKs into users with ON DELETE CASCADE — deleting users would also cascade,
  // but explicit is clearer)
  await sb.from("matchpool_profiles").delete().in("user_id", ids);
  await sb.from("instaclaw_users").delete().in("id", ids);
  if (!silent) console.log("  ✓ cleanup complete");
}

// ─── Tests ──────────────────────────────────────────────────────────

async function testBasicTopK() {
  console.log("\n── Test 1: basic top-K from A's POV ──");
  const matches = await computeTopKMutual(callerId, 10);
  console.log(`  returned ${matches.length} matches`);
  for (const m of matches) {
    const u = USERS.find((x) => x.id === m.user_id);
    console.log(`    ${u?.label ?? m.user_id}: fwd=${m.forward_score.toFixed(3)} rev=${m.reverse_score.toFixed(3)} mutual=${m.mutual_score.toFixed(3)}`);
  }

  // Expect: B (mutual=1), H (mutual~0.5). C/D/E/F filtered.
  if (matches.length === 2) ok("returned exactly 2 matches (C,D,E,F filtered)");
  else bad(`returned ${matches.length} matches (expected 2)`);

  if (matches[0]?.user_id === userB_id) ok("B is rank #1 (perfect match)");
  else bad(`rank #1 is not B (got ${matches[0]?.user_id})`);

  if (matches[0] && approxEq(matches[0].mutual_score, 1.0)) ok("B mutual_score ≈ 1.0");
  else bad(`B mutual_score = ${matches[0]?.mutual_score} (expected ≈1.0)`);

  if (matches[1]?.user_id === userH_id) ok("H is rank #2 (partial match)");
  else bad(`rank #2 is not H (got ${matches[1]?.user_id})`);

  // H's mixed concept vectors give fwd=rev=1/√2, so mutual = sqrt(0.5) = 1/√2 ≈ 0.707
  if (matches[1] && approxEq(matches[1].mutual_score, Math.SQRT1_2)) ok("H mutual_score ≈ 0.707 (sqrt(1/2))");
  else bad(`H mutual_score = ${matches[1]?.mutual_score} (expected ≈0.707)`);

  // Geometric mean sanity: H.fwd × H.rev should round-trip via sqrt
  if (matches[1]) {
    const expected = Math.sqrt(matches[1].forward_score * matches[1].reverse_score);
    if (approxEq(expected, matches[1].mutual_score, 0.001)) {
      ok(`H mutual = sqrt(fwd × rev) [${expected.toFixed(4)} vs ${matches[1].mutual_score.toFixed(4)}]`);
    } else {
      bad(`geometric mean mismatch: sqrt=${expected} but mutual=${matches[1].mutual_score}`);
    }
  }
}

async function testExcludeUserIds() {
  console.log("\n── Test 2: excludeUserIds filters out B ──");
  const matches = await computeTopKMutual(callerId, 10, { excludeUserIds: [userB_id] });
  if (!matches.find((m) => m.user_id === userB_id)) ok("B excluded");
  else bad("B still appears despite exclusion");
  if (matches.length === 1) ok("only H remains");
  else bad(`${matches.length} remain (expected 1)`);
}

async function testConsentTierHidden() {
  console.log("\n── Test 3: consent_tier='hidden' excludes the user ──");
  // Flip H to hidden
  await sb.from("matchpool_profiles").update({ consent_tier: "hidden" }).eq("user_id", userH_id);
  const matches = await computeTopKMutual(callerId, 10);
  if (!matches.find((m) => m.user_id === userH_id)) ok("H hidden, excluded");
  else bad("H still appears despite consent_tier='hidden'");
  // Restore
  await sb.from("matchpool_profiles").update({ consent_tier: "interests" }).eq("user_id", userH_id);
}

async function testTopKLimit() {
  console.log("\n── Test 4: k=1 returns only the top result ──");
  const matches = await computeTopKMutual(callerId, 1);
  if (matches.length === 1) ok("only 1 match returned");
  else bad(`${matches.length} returned (expected 1)`);
  if (matches[0]?.user_id === userB_id) ok("top result is B");
  else bad(`top result is ${matches[0]?.user_id}`);
}

async function testMinMutualScore() {
  console.log("\n── Test 5: minMutualScore=0.8 filters H but keeps B ──");
  // H's mutual is 0.707 (geometric mean of fwd=rev=1/√2). 0.8 threshold
  // sits above H but below B's 1.0.
  const matches = await computeTopKMutual(callerId, 10, { minMutualScore: 0.8 });
  if (matches.length === 1) ok("only B passes the 0.8 threshold");
  else bad(`${matches.length} passed (expected 1)`);
  if (matches[0]?.user_id === userB_id) ok("B is the only result");
  else bad(`got ${matches[0]?.user_id}`);
}

async function testFromBPerspective() {
  console.log("\n── Test 6: from B's POV, A is the perfect match ──");
  const matches = await computeTopKMutual(userB_id, 10);
  console.log(`  returned ${matches.length} matches from B`);
  for (const m of matches) {
    const u = USERS.find((x) => x.id === m.user_id);
    console.log(`    ${u?.label ?? m.user_id}: mutual=${m.mutual_score.toFixed(3)}`);
  }
  // From B's POV: B.seeking=founder. C/D also offer founder; their seeking=investor matches B.offering
  // So C, D, A should all be perfect matches (mutual=1.0), and H is partial.
  // E.offering=research, F.offering=engineer → both have fwd(B→E)=0 and fwd(B→F)=0 → filtered.
  const ids = matches.map((m) => m.user_id);
  if (ids.includes(callerId)) ok("A appears in B's matches");
  else bad("A missing from B's matches");
  if (matches.every((m) => m.mutual_score > 0)) ok("all returned matches have mutual_score > 0");
  else bad("some returned matches have mutual_score == 0");
}

async function testStalkerKilled() {
  console.log("\n── Test 7: asymmetric 'stalker' pattern is killed (E→F should fail) ──");
  // E.offering=research, E.seeking=research → forward(E→F) = cos(research, engineer) = 0
  // E→F mutual would be 0 from forward side; ALSO the geometric mean kills any asymmetric
  // pair regardless. Verify by querying from E's POV.
  const matches = await computeTopKMutual(USERS[4].id, 10);
  if (!matches.find((m) => m.user_id === USERS[5].id)) ok("F not in E's matches (asymmetric killed)");
  else bad("F appears in E's matches (asymmetric pair leaked through)");
}

async function main() {
  console.log("══ matchpool_compute_topk_mutual end-to-end test ══");

  console.log("\n── Setup: seeding 7 test users + profiles ──");
  await setup();
  console.log("  ✓ seeded");

  try {
    await testBasicTopK();
    await testExcludeUserIds();
    await testConsentTierHidden();
    await testTopKLimit();
    await testMinMutualScore();
    await testFromBPerspective();
    await testStalkerKilled();
  } catch (e) {
    console.error("\nFATAL during tests:", e instanceof Error ? e.message : e);
    fail++;
  }

  console.log("\n── Cleanup ──");
  await cleanup();

  console.log(`\n══ ${pass} passed, ${fail} failed ══`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error("FATAL:", e instanceof Error ? e.message : e);
  console.error(e instanceof Error ? e.stack : "");
  await cleanup(true);
  process.exit(1);
});
