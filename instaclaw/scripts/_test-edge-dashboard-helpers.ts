/**
 * Unit tests for the pure helpers in lib/edge-dashboard-data.ts.
 *
 * Covers:
 *   • cleanReasonText (marker-prefix stripping)
 *   • pickConfidence (score priority + null handling)
 *   • formatRelativeTime (relative-time rendering bands)
 *   • resolveCounterpart (bidirectional source/candidate mirroring)
 *   • parseIntentResponse (Yanek's read_intents response → CurrentIntent)
 *
 * Pure functions, no DB / no network. Runs in <1s.
 */
import {
  cleanReasonText,
  pickConfidence,
  formatRelativeTime,
  resolveCounterpart,
  parseIntentResponse,
} from "../lib/edge-dashboard-data";

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ ${msg}`); }
}

console.log("\n=== cleanReasonText ===\n");
assert(cleanReasonText(null) === null, "null → null");
assert(cleanReasonText(undefined) === null, "undefined → null");
assert(cleanReasonText("") === null, "empty string → null");
assert(cleanReasonText("   ") === null, "whitespace-only → null");
assert(
  cleanReasonText("[index:poller] opportunity=abc-123 — building agent infrastructure") ===
    "building agent infrastructure",
  "marker prefix stripped",
);
assert(
  cleanReasonText("[index:webhook] opportunity=xyz-456 — researching multi-agent protocols") ===
    "researching multi-agent protocols",
  "different source-tag stripped",
);
assert(
  cleanReasonText("[index:poller] opportunity=abc — ") === null,
  "marker with empty suffix → null",
);
assert(
  cleanReasonText("just plain reasoning, no marker") === "just plain reasoning, no marker",
  "non-marker text passes through",
);

console.log("\n=== pickConfidence ===\n");
assert(pickConfidence({}) === null, "no scores → null");
assert(
  pickConfidence({ deliberation_score: null, mutual_score: null, rrf_score: null }) === null,
  "all null → null",
);
assert(
  pickConfidence({ deliberation_score: 0.87, mutual_score: 0.91, rrf_score: 0.75 }) === 0.87,
  "deliberation wins when all present",
);
assert(
  pickConfidence({ deliberation_score: null, mutual_score: 0.91, rrf_score: 0.75 }) === 0.91,
  "mutual wins when deliberation null",
);
assert(
  pickConfidence({ deliberation_score: null, mutual_score: null, rrf_score: 0.75 }) === 0.75,
  "rrf used as fallback",
);
assert(
  pickConfidence({ deliberation_score: 0, mutual_score: 0.5, rrf_score: 0.3 }) === 0,
  "0 is a valid score (not falsy-pitfall)",
);
assert(
  pickConfidence({ deliberation_score: NaN, mutual_score: 0.5 }) === 0.5,
  "NaN skipped",
);
assert(
  pickConfidence({ deliberation_score: Infinity, mutual_score: 0.5 }) === 0.5,
  "Infinity skipped",
);

console.log("\n=== formatRelativeTime ===\n");
const nowIso = new Date().toISOString();
const minute = 60_000;
const hour = 3_600_000;
const day = 86_400_000;
assert(formatRelativeTime(nowIso) === "just now", "now → 'just now'");
assert(
  formatRelativeTime(new Date(Date.now() - 5 * minute).toISOString()) === "5m ago",
  "5min ago → '5m ago'",
);
assert(
  formatRelativeTime(new Date(Date.now() - 2 * hour).toISOString()) === "2h ago",
  "2h ago → '2h ago'",
);
assert(
  formatRelativeTime(new Date(Date.now() - 1.5 * day).toISOString()) === "yesterday",
  "~36h ago → 'yesterday'",
);
assert(
  formatRelativeTime(new Date(Date.now() - 3 * day).toISOString()) === "3d ago",
  "3 days ago → '3d ago'",
);
assert(
  formatRelativeTime("not-a-date") === "—",
  "invalid date → em-dash placeholder",
);

console.log("\n=== resolveCounterpart ===\n");
const me = "user-A";
const them = "user-B";
const sourceRow = { source_user_id: me, candidate_user_id: them };
const candidateRow = { source_user_id: them, candidate_user_id: me };

const res1 = resolveCounterpart(sourceRow, me);
assert(res1.counterpartUserId === them, "I am source → counterpart is candidate");
assert(res1.iAmSource === true, "iAmSource=true");

const res2 = resolveCounterpart(candidateRow, me);
assert(res2.counterpartUserId === them, "I am candidate → counterpart is source");
assert(res2.iAmSource === false, "iAmSource=false");

// Defensive: neither matches (shouldn't happen in practice — would
// indicate the SSR row-filter is buggy). Function returns the source
// as a deterministic fallback so the card renders something rather
// than crashing; iAmSource=false reflects "we couldn't actually
// confirm I'm the source."
const res3 = resolveCounterpart(
  { source_user_id: "other-X", candidate_user_id: "other-Y" },
  me,
);
assert(res3.counterpartUserId === "other-X", "deterministic fallback to source on no-match");
assert(res3.iAmSource === false, "iAmSource=false on no-match (defensive)");

console.log("\n=== parseIntentResponse ===\n");
assert(parseIntentResponse(null) === null, "null → null");
assert(parseIntentResponse(undefined) === null, "undefined → null");
assert(parseIntentResponse("string") === null, "non-object → null");
assert(parseIntentResponse({}) === null, "empty object → null");
assert(parseIntentResponse({ success: false }) === null, "success=false → null");
assert(parseIntentResponse({ success: true }) === null, "success=true but no data → null");
assert(
  parseIntentResponse({ success: true, data: { intents: [] } }) === null,
  "empty intents array → null",
);
assert(
  parseIntentResponse({ success: true, data: { intents: "not-array" } }) === null,
  "non-array intents → null",
);

const r1 = parseIntentResponse({
  success: true,
  data: {
    count: 1,
    intents: [{ id: "i-1", description: "building agent infrastructure", createdAt: "2026-05-20T10:00:00Z" }],
  },
});
assert(r1 !== null, "single intent parses");
assert(r1?.description === "building agent infrastructure", "description preserved");
assert(r1?.intentId === "i-1", "intentId preserved");
assert(r1?.createdAt === "2026-05-20T10:00:00Z", "createdAt preserved");

const r2 = parseIntentResponse({
  success: true,
  data: {
    count: 3,
    intents: [
      { id: "i-old", description: "older", createdAt: "2026-05-18T10:00:00Z" },
      { id: "i-newest", description: "newest", createdAt: "2026-05-20T15:00:00Z" },
      { id: "i-mid", description: "middle", createdAt: "2026-05-19T10:00:00Z" },
    ],
  },
});
assert(r2?.description === "newest", "picks the most-recent intent by createdAt");
assert(r2?.intentId === "i-newest", "matching id");

const r3 = parseIntentResponse({
  success: true,
  data: {
    intents: [{ description: "no id no timestamp" }],
  },
});
assert(r3?.description === "no id no timestamp", "missing optional fields still parse");
assert(r3?.intentId === null, "missing id → null");
assert(r3?.createdAt === null, "missing createdAt → null");

const r4 = parseIntentResponse({
  success: true,
  data: {
    intents: [{ id: "i-1", description: null }],
  },
});
assert(r4 === null, "intent with null description → null (would render badly)");

console.log(`\n========================`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`========================`);
process.exit(failed > 0 ? 1 : 0);
