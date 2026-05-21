/**
 * Tests for reasoning-router.js
 *
 * Run with: npx tsx scripts/_test-reasoning-router.ts
 *
 * Validates:
 *   1. Heuristic taxonomy against a real-world corpus (50+ examples)
 *   2. In-message NL override detection (single-turn + persistent + clear)
 *   3. Session override file read/write/expire
 *   4. User preference file read
 *   5. extractLatestUserMessage shapes (string + array-of-blocks)
 *   6. Telemetry log append
 *   7. Performance (<5ms per classify call)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Use a sandbox HOME so tests don't touch the real ~/.openclaw on dev machines
const SANDBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "router-test-"));
process.env.HOME = SANDBOX_HOME;
// Clear node's HOME cache by re-requiring os... no, os.homedir() reads env each call
// Per https://nodejs.org/api/os.html#oshomedir — yes it reads $HOME/USERPROFILE.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const router = require("./reasoning-router.js");

let pass = 0;
let fail = 0;
const failures: string[] = [];

function assert(condition: unknown, label: string): void {
  if (condition) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  ✗ ${label}`);
  }
}

function clearState(): void {
  try {
    fs.rmSync(router._OVERRIDE_FILE, { force: true });
  } catch (_e) {
    /* ignore */
  }
  try {
    fs.rmSync(router._PREFERENCE_FILE, { force: true });
  } catch (_e) {
    /* ignore */
  }
}

// ── Corpus tests ─────────────────────────────────────────────────────────
// Real-world messages mapped to expected effort. Updates here drive policy.
// First column: expected effort. Second: message text.

interface Case {
  expect: "low" | "medium" | "high" | "xhigh";
  msg: string;
  note?: string;
}

const CORPUS: Case[] = [
  // === LOW — greetings, acks, status ============================================
  { expect: "low", msg: "yo", note: "single greeting" },
  { expect: "low", msg: "yoo", note: "Cooper's actual test case" },
  { expect: "low", msg: "yoooo" },
  { expect: "low", msg: "hey" },
  { expect: "low", msg: "hi" },
  { expect: "low", msg: "hello" },
  { expect: "low", msg: "sup" },
  { expect: "low", msg: "gm" },
  { expect: "low", msg: "gm ☀️" },
  { expect: "low", msg: "good morning" },
  { expect: "low", msg: "thanks!" },
  { expect: "low", msg: "thank you" },
  { expect: "low", msg: "ty" },
  { expect: "low", msg: "appreciate it" },
  { expect: "low", msg: "nice" },
  { expect: "low", msg: "cool" },
  { expect: "low", msg: "awesome" },
  { expect: "low", msg: "lol" },
  { expect: "low", msg: "ok" },
  { expect: "low", msg: "kk" },
  { expect: "low", msg: "?" },
  { expect: "low", msg: "??" },
  { expect: "low", msg: "did you get that?" },
  { expect: "low", msg: "are you there?" },
  { expect: "low", msg: "all good?" },
  { expect: "low", msg: "you good?" },
  { expect: "low", msg: "any update?" },
  // Long acknowledgment (length > 60 but still low-effort by intent)
  {
    expect: "low",
    msg: "hey just wanted to say thanks for that recommendation earlier, really appreciated it, hope you're doing well",
    note: "long acknowledgment — length > 60 chars but intent is low-effort",
  },
  { expect: "low", msg: "thanks for the help yesterday, really appreciated it" },
  { expect: "low", msg: "🙏🙏" },
  { expect: "low", msg: "❤️" },

  // === MEDIUM — default for unclassified normal questions =======================
  { expect: "medium", msg: "what's my wallet address?" },
  { expect: "medium", msg: "when is the next session?" },
  { expect: "medium", msg: "who is speaking at 3pm?" },
  { expect: "medium", msg: "remind me about lunch tomorrow" },
  { expect: "medium", msg: "log this idea: build a watchdog architecture" },
  { expect: "medium", msg: "send a thank you note to Tule" },
  { expect: "medium", msg: "what's 2 + 2", note: "trivial but not in social/ack/status taxonomy → medium" },
  { expect: "medium", msg: "tell me a joke", note: "ambiguous — could be creative but no 'write me' verb" },

  // === HIGH — analysis, creative, code, multi-part, long ========================
  {
    expect: "high",
    msg: "analyze the Edge Esmeralda schedule and recommend sessions for someone interested in AI agent infrastructure",
    note: "Cooper's complex-test case",
  },
  { expect: "high", msg: "compare React vs Vue for our use case" },
  { expect: "high", msg: "evaluate the tradeoffs of using ChatGPT OAuth vs API keys" },
  { expect: "high", msg: "which approach should I take for the watchdog redesign?" },
  { expect: "high", msg: "explain why GPT-5.5 reasoning takes so long on big prompts" },
  { expect: "high", msg: "what's the difference between low and high reasoning effort?" },
  { expect: "high", msg: "recommend the best vegetarian restaurant near Esmeralda" },
  { expect: "high", msg: "write me a haiku about Edge City" },
  { expect: "high", msg: "draft a thank-you email to the Edge organizers" },
  { expect: "high", msg: "compose a song about decentralized identity" },
  { expect: "high", msg: "brainstorm some names for a new AI agent product" },
  { expect: "high", msg: "```\nfunction broken() { throw new Error('x'); }\n```\nwhy is this throwing?" },
  { expect: "high", msg: "debug this stack trace: TypeError at line 42" },
  {
    expect: "high",
    msg: "send a thank-you to Tule and then also pin the venue address to my notes and remind me 30 minutes before",
    note: "multi-part task with multiple actions",
  },
  {
    expect: "high",
    msg: "I went to the conference yesterday and met some great people, but I'm now trying to figure out who to follow up with first because I have limited bandwidth and need to prioritize the highest-value connections",
    note: "long message (>30 words) — substantive even without explicit analysis keywords",
  },

  // === XHIGH — deep research / explicit thorough ===============================
  {
    expect: "xhigh",
    msg: "do a deep dive on every speaker at Edge Esmeralda and tell me which ones overlap with my interests in agent infrastructure, distributed systems, and crypto identity",
    note: "explicit 'deep dive' signal",
  },
  {
    expect: "xhigh",
    msg: "research the entire history of AI agent frameworks and give me a comprehensive overview",
    note: "research + comprehensive + everything",
  },
  {
    expect: "xhigh",
    msg: "walk me through everything I should know about preparing for Edge Esmeralda",
  },
  {
    expect: "xhigh",
    msg: "step by step, plan a strategy for maximizing my time at the conference",
  },
];

// ── NL override cases (separate from corpus to test override detection) ───
interface OverrideCase {
  msg: string;
  expectEffort: "low" | "medium" | "high" | "xhigh" | null;
  expectPersist: boolean | "clear";
  note?: string;
}

const OVERRIDE_CASES: OverrideCase[] = [
  // Single-turn
  { msg: "think harder about this and give me the best answer", expectEffort: "xhigh", expectPersist: false },
  { msg: "use maximum reasoning here", expectEffort: "xhigh", expectPersist: false },
  { msg: "really analyze this carefully", expectEffort: "xhigh", expectPersist: false },
  { msg: "be thorough about this one", expectEffort: "xhigh", expectPersist: false },
  { msg: "quick answer please", expectEffort: "low", expectPersist: false },
  { msg: "don't overthink this", expectEffort: "low", expectPersist: false },
  { msg: "tldr please", expectEffort: "low", expectPersist: false },
  // Persistent
  { msg: "stay in deep mode from now on", expectEffort: "xhigh", expectPersist: true },
  { msg: "be quick from now on", expectEffort: "low", expectPersist: true },
  // Clear
  { msg: "back to normal please", expectEffort: null, expectPersist: "clear" },
  { msg: "use auto mode", expectEffort: null, expectPersist: "clear" },
];

// ── Tests ─────────────────────────────────────────────────────────────────

function runTests(): void {
  console.log("\n=== 1. Corpus heuristics ===");
  clearState();
  for (const c of CORPUS) {
    const dec = router._heuristicClassify(c.msg);
    const label = `[${c.expect}] "${c.msg.slice(0, 60)}${c.msg.length > 60 ? "…" : ""}"`;
    const ok = dec.effort === c.expect;
    if (!ok) {
      console.log(`  ✗ ${label} → got ${dec.effort} (${dec.reason})${c.note ? ` (note: ${c.note})` : ""}`);
      fail++;
      failures.push(`corpus: ${label} → got ${dec.effort}`);
    } else {
      console.log(`  ✓ ${label} → ${dec.effort} (${dec.reason})`);
      pass++;
    }
  }

  console.log("\n=== 2. Explicit NL override detection ===");
  for (const oc of OVERRIDE_CASES) {
    const ov = router._detectExplicitOverride(oc.msg);
    const label = `"${oc.msg.slice(0, 60)}"`;
    if (!ov) {
      console.log(`  ✗ ${label} → no override detected (expected effort=${oc.expectEffort})`);
      fail++;
      continue;
    }
    const effortOk = ov.effort === oc.expectEffort;
    const persistOk = ov.persist === oc.expectPersist;
    if (effortOk && persistOk) {
      console.log(`  ✓ ${label} → effort=${ov.effort} persist=${ov.persist}`);
      pass++;
    } else {
      console.log(`  ✗ ${label} → effort=${ov.effort} (expected ${oc.expectEffort}) persist=${ov.persist} (expected ${oc.expectPersist})`);
      fail++;
    }
  }

  console.log("\n=== 3. classifyMessage full path — user preference takes precedence ===");
  clearState();
  fs.mkdirSync(path.dirname(router._PREFERENCE_FILE), { recursive: true });
  fs.writeFileSync(router._PREFERENCE_FILE, "high");
  // Even on a "yoo", preference=high should override heuristics
  const decWithPref = router.classifyMessage("yoo");
  assert(decWithPref.effort === "high", `preference=high overrides heuristic 'low' for 'yoo'`);
  assert(decWithPref.reason.includes("user-preference"), `reason names user-preference`);
  // "auto" preference → falls through to router
  fs.writeFileSync(router._PREFERENCE_FILE, "auto");
  const decAuto = router.classifyMessage("yoo");
  assert(decAuto.effort === "low", `preference=auto falls through to heuristic (yoo → low)`);
  clearState();

  console.log("\n=== 4. classifyMessage — persistent session override flow ===");
  clearState();
  // First: user says "stay in deep mode"
  const dec1 = router.classifyMessage("stay in deep mode from now on");
  assert(dec1.effort === "xhigh", `'stay in deep mode' → xhigh`);
  assert(dec1.reason.includes("nl-override-persist"), `reason names nl-override-persist`);
  assert(fs.existsSync(router._OVERRIDE_FILE), `override file written`);
  // Next turn: a normal "yo" should now route to xhigh (session override active)
  const dec2 = router.classifyMessage("yo");
  assert(dec2.effort === "xhigh", `subsequent 'yo' inherits xhigh from session override`);
  assert(dec2.reason.includes("session-override"), `reason names session-override`);
  // User says "back to normal"
  const dec3 = router.classifyMessage("back to normal please");
  // After clearing, the message itself doesn't match a clear-rule heuristic; falls through.
  // "back to normal please" is 21 chars, has "please" but no match in patterns → default medium.
  assert(!fs.existsSync(router._OVERRIDE_FILE), `override file cleared`);
  // Next turn: 'yo' should now be low (no session override)
  const dec4 = router.classifyMessage("yo");
  assert(dec4.effort === "low", `after clear, 'yo' routes to low again`);
  clearState();

  console.log("\n=== 5. extractLatestUserMessage shapes ===");
  // Empty input
  assert(router.extractLatestUserMessage([]) === "", "empty array → empty string");
  assert(router.extractLatestUserMessage(null) === "", "null → empty string");
  assert(router.extractLatestUserMessage(undefined) === "", "undefined → empty string");
  // String content
  const inp1 = [{ role: "user", content: "hello" }];
  assert(router.extractLatestUserMessage(inp1) === "hello", "string content");
  // Array-of-blocks content (Codex shape)
  const inp2 = [{ role: "user", content: [{ type: "input_text", text: "hello world" }] }];
  assert(router.extractLatestUserMessage(inp2) === "hello world", "array-of-blocks (input_text)");
  // Multi-block content
  const inp3 = [{ role: "user", content: [{ type: "text", text: "part 1" }, { type: "text", text: "part 2" }] }];
  assert(router.extractLatestUserMessage(inp3) === "part 1 part 2", "multi-block concatenation");
  // Walk backwards past assistant messages
  const inp4 = [
    { role: "user", content: "first user" },
    { role: "assistant", content: "assistant reply" },
    { role: "user", content: "latest user" },
  ];
  assert(router.extractLatestUserMessage(inp4) === "latest user", "walks backward to find latest user");
  // Only assistant messages
  const inp5 = [{ role: "assistant", content: "x" }];
  assert(router.extractLatestUserMessage(inp5) === "", "no user message → empty");

  console.log("\n=== 6. Telemetry log append ===");
  clearState();
  // logDecision is called inside classifyMessage. Verify log file exists + has content.
  const logFile = path.join(SANDBOX_HOME, ".openclaw", "logs", "reasoning-router.log");
  try { fs.rmSync(logFile, { force: true }); } catch (_e) { /* ignore */ }
  router.classifyMessage("yo");
  router.classifyMessage("analyze the schedule");
  const logContent = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf-8").trim() : "";
  const lines = logContent.split("\n").filter((l) => l.length > 0);
  assert(lines.length === 2, `2 log entries (got ${lines.length})`);
  if (lines.length === 2) {
    const e1 = JSON.parse(lines[0]);
    const e2 = JSON.parse(lines[1]);
    assert(e1.effort === "low" && e2.effort === "high", `log entries have effort fields`);
    assert(typeof e1.ts === "number" && e1.ts > 1_000_000_000_000, `ts is ms epoch`);
  }
  clearState();

  console.log("\n=== 7. Performance — <5ms per call on a 1KB message ===");
  clearState();
  const bigMsg = "Lorem ipsum ".repeat(80); // ~960 chars
  const iters = 1000;
  const t0 = Date.now();
  for (let i = 0; i < iters; i++) {
    router.classifyMessage(bigMsg);
  }
  const elapsed = Date.now() - t0;
  const avgMs = elapsed / iters;
  assert(avgMs < 5, `avg ${avgMs.toFixed(3)}ms per classify (1000 iters in ${elapsed}ms)`);
  clearState();

  console.log("\n=== 8. Edge case: empty/null input ===");
  const decEmpty = router.classifyMessage("");
  assert(decEmpty.effort === "medium", `empty string → medium (default)`);
  const decNull = router.classifyMessage(null);
  assert(decNull.effort === "medium", `null → medium (default)`);
  const decUndef = router.classifyMessage(undefined);
  assert(decUndef.effort === "medium", `undefined → medium (default)`);

  console.log("\n=== 9. Edge case: extremely long message (10KB) ===");
  const huge = "x ".repeat(5000);
  const decHuge = router.classifyMessage(huge);
  // No keyword matches → 5000 words > 30 → high (long-message)
  assert(decHuge.effort === "high", `10KB of 'x' → high (long-message fallback)`);

  console.log("\n=== 10. Override + heuristic interaction ===");
  clearState();
  // Override with persistent + analysis keywords in same message
  const dec = router.classifyMessage("stay in deep mode from now on and also analyze the schedule");
  // Persistent override fires first (xhigh), heuristic doesn't run
  assert(dec.effort === "xhigh", `persistent override wins even over analysis keywords`);
  clearState();

  console.log("\n=== Cleanup sandbox ===");
  try {
    fs.rmSync(SANDBOX_HOME, { recursive: true, force: true });
    console.log(`  ✓ removed ${SANDBOX_HOME}`);
  } catch (e) {
    console.log(`  ! cleanup failed: ${e}`);
  }
}

runTests();

console.log(`\n=== Results ===`);
console.log(`PASS: ${pass}`);
console.log(`FAIL: ${fail}`);
if (fail > 0) {
  console.log(`\nFailures:`);
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
process.exit(0);
