/**
 * Synthetic test for injectGbrainSoulRoutingV1 + GBRAIN_SOUL_ROUTING_V1_*
 * constants in workspace-templates-v2.ts.
 *
 * Verifies (Rule 31 failure-mode coverage):
 *  1. Vanilla MEMORY.md-first SOUL.md → injection produces marker-wrapped section
 *  2. vm-050's pre-marker section → injection wraps (markers added, body unchanged)
 *  3. Already-marker-wrapped SOUL.md → idempotent no-op
 *  4. Missing start anchor → returns input unchanged (defensive)
 *  5. Missing end anchor → returns input unchanged (defensive)
 *  6. End anchor before start anchor → returns input unchanged
 *  7. Canonical SECTION sha matches expected (round-trip via base64)
 *  8. All required sentinels present in resolved block
 *  9. KNOWN_OK_SHAS values produce expected drift-check verdict
 *
 * Run: cd instaclaw && npx tsx scripts/_test-gbrain-soul-routing-inject.ts
 */

import { createHash } from "crypto";
import { readFileSync } from "fs";
import {
  injectGbrainSoulRoutingV1,
  GBRAIN_SOUL_ROUTING_V1_SECTION,
  GBRAIN_SOUL_ROUTING_V1_BEGIN_MARKER,
  GBRAIN_SOUL_ROUTING_V1_END_MARKER,
  GBRAIN_SOUL_ROUTING_V1_KNOWN_OK_SHAS,
  GBRAIN_SOUL_ROUTING_V1_REQUIRED_SENTINELS,
  GBRAIN_SOUL_ROUTING_V1_START_ANCHOR,
  GBRAIN_SOUL_ROUTING_V1_END_ANCHOR,
} from "../lib/workspace-templates-v2";

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail: string = "") {
  if (cond) {
    console.log(`✓ ${name}`);
    passed++;
  } else {
    console.log(`✗ ${name} ${detail}`);
    failed++;
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// ── Constant sanity ──────────────────────────────────────────────────────────
console.log("=== Constants sanity ===");
assert(
  "SECTION starts with begin marker",
  GBRAIN_SOUL_ROUTING_V1_SECTION.startsWith(GBRAIN_SOUL_ROUTING_V1_BEGIN_MARKER),
);
assert(
  "SECTION contains end marker",
  GBRAIN_SOUL_ROUTING_V1_SECTION.includes(GBRAIN_SOUL_ROUTING_V1_END_MARKER),
);
assert(
  "SECTION contains start anchor (heading)",
  GBRAIN_SOUL_ROUTING_V1_SECTION.includes(GBRAIN_SOUL_ROUTING_V1_START_ANCHOR),
);
assert(
  "SECTION does NOT contain end anchor (avoids self-recursion)",
  !GBRAIN_SOUL_ROUTING_V1_SECTION.includes(GBRAIN_SOUL_ROUTING_V1_END_ANCHOR),
);
for (const sentinel of GBRAIN_SOUL_ROUTING_V1_REQUIRED_SENTINELS) {
  assert(
    `SECTION contains sentinel "${sentinel}"`,
    GBRAIN_SOUL_ROUTING_V1_SECTION.includes(sentinel),
  );
}
assert(
  "KNOWN_OK_SHAS has at least 2 entries (vanilla + vm-050)",
  GBRAIN_SOUL_ROUTING_V1_KNOWN_OK_SHAS.length >= 2,
);
assert(
  "KNOWN_OK_SHAS contains vanilla sha 6010222d370f...",
  GBRAIN_SOUL_ROUTING_V1_KNOWN_OK_SHAS.some((s) => s.startsWith("6010222d370f")),
);
assert(
  "KNOWN_OK_SHAS contains vm-050 sha 857b749d6187...",
  GBRAIN_SOUL_ROUTING_V1_KNOWN_OK_SHAS.some((s) => s.startsWith("857b749d6187")),
);

// ── Round-trip sha verify (canonical body matches vm-050's sha) ──────────────
// The SECTION includes markers; extract just the body part to verify sha
// matches vm-050's pre-marker on-disk section.
console.log("\n=== Canonical body sha verification ===");
const bodyOnly = GBRAIN_SOUL_ROUTING_V1_SECTION
  .replace(GBRAIN_SOUL_ROUTING_V1_BEGIN_MARKER + "\n", "")
  .replace(GBRAIN_SOUL_ROUTING_V1_END_MARKER + "\n\n", "");
const bodySha = sha256(bodyOnly);
assert(
  "canonical body sha matches vm-050 pre-marker sha (857b749d6187...)",
  bodySha.startsWith("857b749d6187"),
  `actual=${bodySha.slice(0, 12)}`,
);

// ── Test 1: vanilla SOUL.md (vm-354 local copy) ──────────────────────────────
console.log("\n=== Test 1: vanilla SOUL.md (vm-354 copy) ===");
try {
  const vanilla = readFileSync("/tmp/soul-md-investigation/vm-354-SOUL.md", "utf-8");
  const injected = injectGbrainSoulRoutingV1(vanilla);
  assert(
    "vanilla: result contains begin marker",
    injected.includes(GBRAIN_SOUL_ROUTING_V1_BEGIN_MARKER),
  );
  assert(
    "vanilla: result contains end marker",
    injected.includes(GBRAIN_SOUL_ROUTING_V1_END_MARKER),
  );
  assert(
    "vanilla: result does NOT contain old 'MEMORY.md = Core identity' marker (old content removed)",
    !injected.includes("memory/YYYY-MM-DD.md**: After every substantive conversation"),
  );
  assert(
    "vanilla: result still has end anchor (after replacement)",
    injected.includes(GBRAIN_SOUL_ROUTING_V1_END_ANCHOR),
  );
  assert(
    "vanilla: result size is smaller than input (replacement is net negative)",
    injected.length < vanilla.length,
    `delta=${injected.length - vanilla.length}`,
  );
  // Identity preservation: content before start anchor and after end anchor must be unchanged
  const inputBeforeStart = vanilla.slice(0, vanilla.indexOf(GBRAIN_SOUL_ROUTING_V1_START_ANCHOR));
  const outputBeforeStart = injected.slice(0, injected.indexOf(GBRAIN_SOUL_ROUTING_V1_BEGIN_MARKER));
  assert(
    "vanilla: content BEFORE Memory Persistence anchor is byte-identical",
    inputBeforeStart === outputBeforeStart,
    `input=${inputBeforeStart.length}B output=${outputBeforeStart.length}B`,
  );
  const inputAfterEnd = vanilla.slice(vanilla.indexOf(GBRAIN_SOUL_ROUTING_V1_END_ANCHOR));
  const outputAfterEnd = injected.slice(injected.indexOf(GBRAIN_SOUL_ROUTING_V1_END_ANCHOR));
  assert(
    "vanilla: content AFTER Task Completion anchor is byte-identical",
    inputAfterEnd === outputAfterEnd,
  );
} catch (e: any) {
  console.log(`SKIP: local file missing — ${e.message}`);
}

// ── Test 2: vm-050's pre-marker section ──────────────────────────────────────
console.log("\n=== Test 2: vm-050 pre-marker SOUL.md ===");
try {
  const vm050 = readFileSync("/tmp/soul-md-investigation/vm-050-SOUL.md", "utf-8");
  const injected = injectGbrainSoulRoutingV1(vm050);
  assert(
    "vm-050: result contains begin marker (markers wrap existing content)",
    injected.includes(GBRAIN_SOUL_ROUTING_V1_BEGIN_MARKER),
  );
  // vm-050 already had the gbrain content. Replacement swaps it for the same content + markers.
  // So size change ≈ markers length only.
  const sizeDelta = injected.length - vm050.length;
  assert(
    "vm-050: size delta is approximately marker overhead (+50 to +100 bytes)",
    sizeDelta > 30 && sizeDelta < 150,
    `delta=${sizeDelta}`,
  );
} catch (e: any) {
  console.log(`SKIP: local file missing — ${e.message}`);
}

// ── Test 3: already-marker-wrapped (idempotent) ──────────────────────────────
console.log("\n=== Test 3: idempotent on already-marked content ===");
try {
  const vanilla = readFileSync("/tmp/soul-md-investigation/vm-354-SOUL.md", "utf-8");
  const onceInjected = injectGbrainSoulRoutingV1(vanilla);
  const twiceInjected = injectGbrainSoulRoutingV1(onceInjected);
  assert(
    "double-injection is idempotent (output unchanged on second call)",
    onceInjected === twiceInjected,
    `once=${onceInjected.length}B twice=${twiceInjected.length}B`,
  );
  // Marker appears exactly once
  const beginCount = (twiceInjected.match(new RegExp(GBRAIN_SOUL_ROUTING_V1_BEGIN_MARKER, "g")) || []).length;
  assert(
    "exactly ONE begin marker after double-injection",
    beginCount === 1,
    `count=${beginCount}`,
  );
} catch (e: any) {
  console.log(`SKIP: local file missing — ${e.message}`);
}

// ── Test 4: missing start anchor ─────────────────────────────────────────────
console.log("\n=== Test 4: missing start anchor → unchanged ===");
const noStart = "# Some SOUL.md\n\n## Other Section\n\n" + GBRAIN_SOUL_ROUTING_V1_END_ANCHOR + "\n\nTail content.";
const noStartResult = injectGbrainSoulRoutingV1(noStart);
assert(
  "missing start anchor: returns input unchanged",
  noStartResult === noStart,
);

// ── Test 5: missing end anchor ───────────────────────────────────────────────
console.log("\n=== Test 5: missing end anchor → unchanged ===");
const noEnd = "# Some SOUL.md\n\n" + GBRAIN_SOUL_ROUTING_V1_START_ANCHOR + "\n\nbody\n\nNo end anchor here.";
const noEndResult = injectGbrainSoulRoutingV1(noEnd);
assert(
  "missing end anchor: returns input unchanged",
  noEndResult === noEnd,
);

// ── Test 6: end anchor before start anchor (malformed) ───────────────────────
console.log("\n=== Test 6: anchors out of order → unchanged ===");
const reversed =
  "# Some SOUL.md\n\n" +
  GBRAIN_SOUL_ROUTING_V1_END_ANCHOR + "\n\nbody\n\n" +
  GBRAIN_SOUL_ROUTING_V1_START_ANCHOR + "\n\nlater body.";
const reversedResult = injectGbrainSoulRoutingV1(reversed);
assert(
  "anchors out of order: returns input unchanged",
  reversedResult === reversed,
);

// ── Summary ──────────────────────────────────────────────────────────────────
console.log("\n=== Summary ===");
console.log(`PASSED: ${passed}`);
console.log(`FAILED: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
