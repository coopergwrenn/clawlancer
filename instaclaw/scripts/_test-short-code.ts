#!/usr/bin/env tsx
/**
 * Synthetic tests for lib/short-code.ts.
 *
 * Covers:
 *   - generateShortCode default length 5
 *   - custom length parameter
 *   - alphabet restriction (only a-z0-9)
 *   - rejection of out-of-range length
 *   - statistical: 10000 codes have >95% uniqueness (collision rate sanity check)
 *   - isValidShortCode regex matching
 *
 * Run: npx tsx scripts/_test-short-code.ts
 */

import { generateShortCode, isValidShortCode } from "../lib/short-code";

type Result = { name: string; passed: boolean; detail?: string };
const results: Result[] = [];

function pass(name: string) {
  results.push({ name, passed: true });
}
function fail(name: string, detail: string) {
  results.push({ name, passed: false, detail });
}
function assertTrue(actual: boolean, name: string) {
  if (actual) pass(name);
  else fail(name, "expected true");
}
function assertFalse(actual: boolean, name: string) {
  if (!actual) pass(name);
  else fail(name, "expected false");
}
function assertEq<T>(actual: T, expected: T, name: string) {
  if (actual === expected) pass(name);
  else fail(name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ─── Default length + alphabet ────────────────────────────────────────

const code1 = generateShortCode();
assertEq(code1.length, 5, "default length is 5");
assertTrue(/^[a-z0-9]{5}$/.test(code1), `default code matches /^[a-z0-9]{5}$/ (got "${code1}")`);

// ─── Custom length ────────────────────────────────────────────────────

assertEq(generateShortCode(4).length, 4, "length 4 produces 4 chars");
assertEq(generateShortCode(8).length, 8, "length 8 produces 8 chars");
assertEq(generateShortCode(1).length, 1, "length 1 produces 1 char");
assertEq(generateShortCode(64).length, 64, "length 64 produces 64 chars");

// ─── Alphabet restriction across many samples ────────────────────────

const samples = Array.from({ length: 1000 }, () => generateShortCode());
const allValid = samples.every((s) => /^[a-z0-9]{5}$/.test(s));
assertTrue(allValid, "1000 samples all match alphabet+length regex");

// ─── Length bounds checking ───────────────────────────────────────────

try {
  generateShortCode(0);
  fail("length=0 throws", "did not throw");
} catch (err) {
  if (err instanceof Error && err.message.includes("length must be in")) {
    pass("length=0 throws");
  } else {
    fail("length=0 throws", `wrong error: ${String(err)}`);
  }
}

try {
  generateShortCode(65);
  fail("length=65 throws", "did not throw");
} catch {
  pass("length=65 throws");
}

try {
  generateShortCode(-1);
  fail("length=-1 throws", "did not throw");
} catch {
  pass("length=-1 throws");
}

// ─── Statistical uniqueness sanity ────────────────────────────────────
//
// For 10,000 codes from a 36^5 = 60,466,176 keyspace, expected collisions
// via birthday paradox is ~n²/(2K) = 10000²/(2*60M) = 0.83. So we should
// see 0-3 collisions in any given run. Asserting <50 is a very loose
// check that protects against a broken RNG that hits the same value
// constantly.

const N = 10_000;
const seen = new Set<string>();
let dupes = 0;
for (let i = 0; i < N; i++) {
  const c = generateShortCode();
  if (seen.has(c)) dupes++;
  seen.add(c);
}
const dupesPct = ((dupes / N) * 100).toFixed(3);
if (dupes < 50) {
  pass(`statistical uniqueness over ${N} samples (${dupes} dupes, ${dupesPct}%)`);
} else {
  fail(
    `statistical uniqueness over ${N} samples`,
    `${dupes} dupes is far above expected ~1 — RNG may be broken`,
  );
}

// ─── Distribution sanity — every alphabet char should appear ────────
//
// In 1000 codes × 5 chars = 5000 char-positions, each of the 36 alphabet
// chars should appear ~139 times. Even with rejection-sampling skew,
// every char should appear at least once.

const charCounts = new Map<string, number>();
for (const c of samples) {
  for (const ch of c) {
    charCounts.set(ch, (charCounts.get(ch) ?? 0) + 1);
  }
}
const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
const missing = alphabet.split("").filter((ch) => !charCounts.has(ch));
if (missing.length === 0) {
  pass("alphabet coverage: every char appears in 1000-code sample");
} else {
  fail(
    "alphabet coverage",
    `missing chars: ${missing.join(", ")} — RNG may be biased`,
  );
}

// ─── isValidShortCode ─────────────────────────────────────────────────

assertTrue(isValidShortCode("r7k2x"), "isValidShortCode: valid 5-char");
assertTrue(isValidShortCode("abcd"), "isValidShortCode: valid 4-char");
assertTrue(isValidShortCode("12345678"), "isValidShortCode: valid 8-char max");
assertFalse(isValidShortCode("abc"), "isValidShortCode: too short (3 chars)");
assertFalse(isValidShortCode("123456789"), "isValidShortCode: too long (9 chars)");
assertFalse(isValidShortCode("ABCDE"), "isValidShortCode: uppercase rejected");
assertFalse(isValidShortCode("ab-de"), "isValidShortCode: hyphen rejected");
assertFalse(isValidShortCode(""), "isValidShortCode: empty rejected");
assertFalse(isValidShortCode(12345 as unknown as string), "isValidShortCode: non-string rejected");
assertFalse(isValidShortCode(undefined), "isValidShortCode: undefined rejected");

// ─── Summary ──────────────────────────────────────────────────────────

console.log("");
console.log("─".repeat(70));
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed);
console.log(`short-code tests: ${passed}/${results.length} passed`);
console.log("─".repeat(70));
for (const r of results) {
  const marker = r.passed ? "  ok" : "FAIL";
  console.log(`${marker}  ${r.name}${r.detail ? `\n        ${r.detail}` : ""}`);
}
if (failed.length > 0) {
  console.log(`\n${failed.length} test(s) failed`);
  process.exit(1);
}
process.exit(0);
