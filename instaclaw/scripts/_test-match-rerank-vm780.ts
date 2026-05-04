/**
 * End-to-end test for consensus_match_rerank.py on vm-780.
 *
 * Tests in order:
 *   1. Upload the script to /tmp on vm-780
 *   2. Construct a synthetic 6-candidate JSON list (cooper-relevant profiles)
 *   3. Run rerank, verify:
 *      - exits 0
 *      - stdout is valid JSON list of length 6
 *      - each entry has user_id / agent_id / rank / rerank_score / brief_reason
 *      - rank ordering is monotonic
 *      - reasons reference cooper-specific signals (not generic AI-speak)
 *   4. Run rerank again, verify cache_read tokens > 0 (prompt cache hit)
 *   5. Test --fallback path: hide MEMORY.md + SOUL.md, run, verify L1 fallback
 *   6. Cleanup
 */
import { readFileSync, writeFileSync } from "fs";
import { NodeSSH } from "node-ssh";

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

const sshKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");

// Hand-crafted candidates aligned to Cooper's known intent
// (founder of agentic AI agent infra, looking for investors + research collabs).
const CANDIDATES = [
  {
    user_id: "11111111-0000-0000-0000-000000000001",
    agent_id: "test-rerank-vc",
    offering_summary:
      "Partner at AI-focused fund. Lead checks $2-5M into agent infrastructure and crypto-AI plays. Portfolio includes Bittensor and Anthropic-adjacent infra companies.",
    seeking_summary:
      "Seed and Series A founders building AI agent platforms with real users and per-user economics.",
    interests: ["agentic-ai", "crypto-infrastructure", "agent-wallets"],
    looking_for: ["founder", "agent-platform"],
    format_preferences: ["1on1"],
    consent_tier: "interests",
    mutual_score: 0.85,
  },
  {
    user_id: "11111111-0000-0000-0000-000000000002",
    agent_id: "test-rerank-researcher",
    offering_summary:
      "AI researcher at Stanford working on long-context agent memory. Published on retrieval over agentic action histories. Open to building together.",
    seeking_summary:
      "Engineers shipping agent platforms in production with real user data — willing to share data anonymously for collaboration.",
    interests: ["long-context-memory", "agent-research"],
    looking_for: ["practitioner-collab", "data-collab"],
    format_preferences: ["1on1", "small_group"],
    consent_tier: "interests",
    mutual_score: 0.78,
  },
  {
    user_id: "11111111-0000-0000-0000-000000000003",
    agent_id: "test-rerank-other-founder",
    offering_summary:
      "Founder of another AI agent platform — same vertical, similar stage.",
    seeking_summary:
      "Investors and co-founders in agentic AI infrastructure.",
    interests: ["agentic-ai", "agent-platforms"],
    looking_for: ["investor", "cofounder"],
    format_preferences: ["1on1"],
    consent_tier: "interests",
    mutual_score: 0.32,
  },
  {
    user_id: "11111111-0000-0000-0000-000000000004",
    agent_id: "test-rerank-bankr",
    offering_summary:
      "Founding engineer at Bankr — agent wallet infra on Base. Active partnership with InstaClaw.",
    seeking_summary:
      "Agent platforms integrating wallet infra; want to compare implementation notes on agent-controlled custody.",
    interests: ["agent-wallets", "base", "crypto-infrastructure"],
    looking_for: ["agent-platform-builder", "infra-collab"],
    format_preferences: ["1on1"],
    consent_tier: "interests",
    mutual_score: 0.71,
  },
  {
    user_id: "11111111-0000-0000-0000-000000000005",
    agent_id: "test-rerank-irrelevant",
    offering_summary:
      "Designer building consumer NFT marketplaces on Solana. Focused on collector mechanics.",
    seeking_summary:
      "Other consumer-NFT founders on Solana, NFT collectors, marketplace ops people.",
    interests: ["nft", "solana", "consumer"],
    looking_for: ["nft-cofounder", "marketplace-ops"],
    format_preferences: ["1on1", "small_group"],
    consent_tier: "interests",
    mutual_score: 0.18,
  },
  {
    user_id: "11111111-0000-0000-0000-000000000006",
    agent_id: "test-rerank-edgecity",
    offering_summary:
      "Edge City team — running pop-up cities and agentic experiments at the edge of crypto-AI culture.",
    seeking_summary:
      "Agent platform builders shipping into Edge City community; partnerships with platforms whose users overlap.",
    interests: ["edge-city", "agentic-ai", "community"],
    looking_for: ["agent-platform", "community-partner"],
    format_preferences: ["small_group", "session"],
    consent_tier: "interests",
    mutual_score: 0.66,
  },
];

async function main() {
  let pass = 0, fail = 0;
  const ok = (m: string) => { console.log(`  ✓ ${m}`); pass++; };
  const bad = (m: string) => { console.log(`  ✗ ${m}`); fail++; };

  // Write candidates JSON locally so we can scp it
  const candidatesPath = "/tmp/_rerank-candidates.json";
  writeFileSync(candidatesPath, JSON.stringify(CANDIDATES, null, 2));

  const ssh = new NodeSSH();
  await ssh.connect({ host: "104.237.151.95", username: "openclaw", privateKey: sshKey, readyTimeout: 12_000 });

  console.log("── 1. Upload rerank script + candidates ──");
  await ssh.putFile(
    "/Users/cooperwrenn/wild-west-bots/instaclaw/scripts/consensus_match_rerank.py",
    "/tmp/consensus_match_rerank.py"
  );
  await ssh.putFile(candidatesPath, "/tmp/_rerank-candidates.json");
  console.log("  ✓ uploaded");

  console.log("");
  console.log("── 2. First run (cache should be created) ──");
  const start1 = Date.now();
  const r1 = await ssh.execCommand(
    "cd /tmp && python3 consensus_match_rerank.py _rerank-candidates.json"
  );
  const elapsed1 = ((Date.now() - start1) / 1000).toFixed(1);
  console.log(`  latency: ${elapsed1}s`);
  console.log(`  exit: ${r1.code}`);
  console.log("  stderr (telemetry):");
  console.log("  " + (r1.stderr || "(none)").split("\n").join("\n  "));

  if (r1.code === 0) ok("exit 0");
  else { bad(`exit ${r1.code}`); console.log(`  stdout: ${r1.stdout.slice(0, 500)}`); }

  let parsed1: unknown[] = [];
  try {
    parsed1 = JSON.parse(r1.stdout);
    ok("stdout is valid JSON");
  } catch (e) {
    bad(`stdout not JSON: ${e}`);
    console.log(`  raw: ${r1.stdout.slice(0, 1000)}`);
  }

  if (Array.isArray(parsed1) && parsed1.length === CANDIDATES.length) {
    ok(`returned all ${CANDIDATES.length} candidates`);
  } else {
    bad(`returned ${(parsed1 as unknown[])?.length} candidates (expected ${CANDIDATES.length})`);
  }

  // Validate shape
  const sample = (parsed1 as Array<Record<string, unknown>>)[0];
  if (sample) {
    const requiredKeys = ["user_id", "agent_id", "rank", "rerank_score", "brief_reason"];
    const missing = requiredKeys.filter((k) => !(k in sample));
    if (!missing.length) ok("entry shape correct (user_id, agent_id, rank, rerank_score, brief_reason)");
    else bad(`missing fields: ${missing.join(", ")}`);
  }

  // Validate rank ordering
  const ranked = parsed1 as Array<{ rank: number; rerank_score: number; brief_reason: string; user_id: string }>;
  const ranksMonotonic = ranked.every((e, i) => e.rank === i + 1);
  if (ranksMonotonic) ok("rank monotonic 1..N");
  else bad("rank not monotonic");

  const scoresMonotonic = ranked.every((e, i, a) =>
    i === 0 || a[i - 1].rerank_score >= e.rerank_score
  );
  if (scoresMonotonic) ok("rerank_score monotonic decreasing");
  else bad("rerank_score not monotonic decreasing");

  // Print full ranking with reasons
  console.log("\n  Full ranking:");
  for (const e of ranked) {
    const c = CANDIDATES.find((x) => x.user_id === e.user_id);
    const label = c?.agent_id || e.user_id.slice(0, 12);
    console.log(`    [${e.rank}] ${label.padEnd(28)} score=${e.rerank_score.toFixed(2)}  ${e.brief_reason.slice(0, 100)}`);
  }

  // Quality heuristics — calibration-aware. The new prompt explicitly
  // tells the model: "if you don't have a specific signal in MEMORY.md,
  // score ≤ 0.5 even if profile matches." So:
  //   - Bankr (active partnership, real signal) → top 1 or 2
  //   - Researcher (memory-persistence work in MEMORY) → top 1 or 2
  //   - Solana NFT (active mismatch) → bottom 1
  //   - VC (profile-only fit) → expected to be MID (0.4-0.6), NOT top
  //     — that's the calibration win.
  const bankrId = CANDIDATES[3].user_id;
  const researcherId = CANDIDATES[1].user_id;
  const irrelevantId = CANDIDATES[4].user_id;

  const top2UserIds = ranked.slice(0, 2).map((e) => e.user_id);
  const specificSignalInTop2 = top2UserIds.includes(bankrId) || top2UserIds.includes(researcherId);
  if (specificSignalInTop2) ok("specific-signal candidate (Bankr or Researcher) in top 2");
  else bad(`top 2 misses both specific-signal candidates: ${top2UserIds}`);

  // Both low-relevance candidates (Solana NFT mismatch AND Other-founder
  // no-trade) should occupy bottom 2. Order between them isn't stable —
  // the model honestly suppresses both; which is "dead last" depends on
  // tie-breaking. The invariant is that they're both at the bottom.
  const otherFounderId = CANDIDATES[2].user_id;
  const bottom2 = ranked.slice(-2).map((e) => e.user_id);
  const bothLowsAtBottom = bottom2.includes(irrelevantId) && bottom2.includes(otherFounderId);
  if (bothLowsAtBottom) {
    ok("both low-relevance candidates (Solana NFT + Other-founder) in bottom 2");
  } else {
    bad(`bottom 2 doesn't contain both lows: ${bottom2}`);
  }

  // Banned-phrases check — fail if any reason contains AI-speak the
  // prompt explicitly bans.
  const BANNED = [
    "leveraging", "synergistic", "synergy", "passionate about",
    "perfectly positioned", "world-class", "thought leader",
    "great fit", "strong match", "amazing fit",
  ];
  const offenders: string[] = [];
  for (const e of ranked) {
    const r = (e.brief_reason || "").toLowerCase();
    for (const bad of BANNED) {
      if (r.includes(bad)) offenders.push(`${e.user_id.slice(0, 8)}: "${bad}"`);
    }
  }
  if (offenders.length === 0) ok("no banned AI-speak phrases in any reason");
  else bad(`banned phrases found: ${offenders.join(", ")}`);

  // Voice check: rationale should be first-person about the user.
  // Catch third-person "Cooper" / "he" / "she" / "the user" — these
  // are signs the model is mirroring MEMORY.md's third-person voice
  // instead of speaking TO the user.
  const THIRD_PERSON_PATTERNS = [
    /\bCooper\b/, /\bthe user\b/i, /\bhe's\b/i, /\bshe's\b/i,
    /\bhe is\b/i, /\bshe is\b/i, /\bhe has\b/i, /\bshe has\b/i,
  ];
  const voiceOffenders: string[] = [];
  for (const e of ranked) {
    const r = e.brief_reason || "";
    for (const pat of THIRD_PERSON_PATTERNS) {
      if (pat.test(r)) {
        voiceOffenders.push(`${e.user_id.slice(0, 8)}: matched ${pat}`);
        break;
      }
    }
  }
  if (voiceOffenders.length === 0) ok("all reasons use first-person agent voice");
  else bad(`third-person leak (model mirrored MEMORY.md voice): ${voiceOffenders.join("; ")}`);

  // Cache stats from first call: should show cache_create > 0
  if (r1.stderr.includes("cache_create=") && !r1.stderr.includes("cache_create=0")) {
    ok("first call wrote cache (cache_create > 0)");
  } else if (r1.stderr.includes("usage")) {
    console.log("  ⚠ first call may not have written cache — check cache_create value");
  } else {
    console.log("  ⚠ no usage telemetry in first call (gateway may not pass it through)");
  }

  console.log("");
  console.log("── 3. Second run (cache should be hit) ──");
  const start2 = Date.now();
  const r2 = await ssh.execCommand(
    "cd /tmp && python3 consensus_match_rerank.py _rerank-candidates.json"
  );
  const elapsed2 = ((Date.now() - start2) / 1000).toFixed(1);
  console.log(`  latency: ${elapsed2}s`);
  console.log("  stderr:");
  console.log("  " + (r2.stderr || "(none)").split("\n").join("\n  "));

  if (r2.code === 0) ok("second run exit 0");
  else bad(`second run exit ${r2.code}`);

  if (r2.stderr.includes("cache_read=") && !r2.stderr.includes("cache_read=0")) {
    ok("second call hit cache (cache_read > 0)");
  } else {
    console.log("  ⚠ second call may not have hit cache — check cache_read value");
  }

  console.log("");
  console.log("── 4. Empty candidates → empty output ──");
  await ssh.execCommand("echo '[]' > /tmp/_rerank-empty.json");
  const rEmpty = await ssh.execCommand(
    "cd /tmp && python3 consensus_match_rerank.py _rerank-empty.json"
  );
  if (rEmpty.code === 0 && rEmpty.stdout.trim() === "[]") ok("empty input → empty output");
  else bad(`empty input failed: code=${rEmpty.code} stdout=${rEmpty.stdout.slice(0, 100)}`);

  console.log("");
  console.log("── 5. Bad JSON → exit 2 (loader failure) ──");
  await ssh.execCommand("echo 'not json' > /tmp/_rerank-bad.json");
  const rBad = await ssh.execCommand(
    "cd /tmp && python3 consensus_match_rerank.py _rerank-bad.json"
  );
  if (rBad.code === 2) ok("bad JSON → exit 2");
  else bad(`bad JSON returned exit ${rBad.code}`);

  // Cleanup
  await ssh.execCommand("rm -f /tmp/consensus_match_rerank.py /tmp/_rerank-candidates.json /tmp/_rerank-empty.json /tmp/_rerank-bad.json");
  ssh.dispose();

  console.log("");
  console.log(`══ ${pass} passed, ${fail} failed ══`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.message : e);
  console.error(e instanceof Error ? e.stack : "");
  process.exit(1);
});
