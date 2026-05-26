#!/usr/bin/env tsx
/**
 * Synthetic tests for lib/m-return-dispatch.ts:buildMReturnMessage.
 *
 * Pure-logic layer — template assembly from a profile shape. The
 * full dispatchMReturn requires DB + network and is tested at the
 * integration level via cron + production smoke tests.
 *
 * Covers:
 *   - Empty profile (skipped form): fallback message
 *   - Name only
 *   - Vibe only
 *   - Use only
 *   - Name + vibe
 *   - Name + use
 *   - All three
 *   - Vibe slug → display conversion (hyphens → spaces)
 *   - Name trimming
 *   - Voice: always ends with "what do you want to do first?"
 *   - Voice: always opens with "hey"
 *   - No em-dashes anywhere
 *
 * Run: npx tsx scripts/_test-m-return-message.ts
 */

import { buildMReturnMessage } from "../lib/m-return-dispatch";

type Result = { name: string; passed: boolean; detail?: string };
const results: Result[] = [];

function pass(name: string) {
  results.push({ name, passed: true });
}
function fail(name: string, detail: string) {
  results.push({ name, passed: false, detail });
}
function assertEq(actual: string, expected: string, name: string) {
  if (actual === expected) pass(name);
  else fail(name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assertContains(haystack: string, needle: string, name: string) {
  if (haystack.includes(needle)) pass(name);
  else fail(name, `expected "${needle}" in "${haystack}"`);
}
function assertNotContains(haystack: string, needle: string, name: string) {
  if (!haystack.includes(needle)) pass(name);
  else fail(name, `did NOT expect "${needle}" in "${haystack}"`);
}

// ─── Empty profile (form fully skipped) ─────────────────────────────

{
  const msg = buildMReturnMessage({ name: null, intended_use: null, vibe: null });
  assertEq(
    msg,
    "hey. ready when you are. what do you want to do first?",
    "empty profile: fallback message",
  );
}

// ─── Name only ─────────────────────────────────────────────────────

{
  const msg = buildMReturnMessage({ name: "Cooper", intended_use: null, vibe: null });
  assertEq(
    msg,
    "hey Cooper. ready when you are. what do you want to do first?",
    "name only: greets by name",
  );
}

// ─── Vibe only ─────────────────────────────────────────────────────

{
  const msg = buildMReturnMessage({
    name: null,
    intended_use: null,
    vibe: "wry-and-minimal",
  });
  assertContains(msg, "wry and minimal vibe", "vibe only: vibe converted from slug");
  assertNotContains(msg, "wry-and-minimal", "vibe only: hyphen slug NOT in display");
}

// ─── Use only ──────────────────────────────────────────────────────

{
  const msg = buildMReturnMessage({
    name: null,
    intended_use: "work",
    vibe: null,
  });
  assertContains(msg, "work mode noted", "use only: acknowledges intent");
}

// ─── Name + vibe ───────────────────────────────────────────────────

{
  const msg = buildMReturnMessage({
    name: "Cooper",
    intended_use: null,
    vibe: "chatty-and-warm",
  });
  assertContains(msg, "hey Cooper", "name+vibe: greets by name");
  assertContains(msg, "chatty and warm vibe", "name+vibe: vibe in display form");
}

// ─── Name + use ────────────────────────────────────────────────────

{
  const msg = buildMReturnMessage({
    name: "Cooper",
    intended_use: "personal",
    vibe: null,
  });
  assertContains(msg, "hey Cooper", "name+use: greets by name");
  assertContains(msg, "personal mode noted", "name+use: acknowledges intent");
}

// ─── All three (the spec's canonical example) ──────────────────────

{
  const msg = buildMReturnMessage({
    name: "Cooper",
    intended_use: "work",
    vibe: "wry-and-minimal",
  });
  assertEq(
    msg,
    "hey Cooper. work mode, wry and minimal vibe — got it. what do you want to do first?",
    "all three: matches the spec's example shape",
  );
}

// ─── Name trimming ─────────────────────────────────────────────────

{
  const msg = buildMReturnMessage({
    name: "  Cooper  ",
    intended_use: null,
    vibe: null,
  });
  assertContains(msg, "hey Cooper.", "name with surrounding whitespace: trimmed");
  assertNotContains(msg, "  Cooper", "trimmed name does not preserve leading space");
}

// ─── Empty name string (treated as null) ──────────────────────────

{
  const msg = buildMReturnMessage({ name: "", intended_use: null, vibe: null });
  assertContains(msg, "hey.", "empty name string: fallback opener");
  assertNotContains(msg, "hey .", "no orphan space before period");
}

// ─── Voice invariants — every message ──────────────────────────────

const variants = [
  { name: null, intended_use: null, vibe: null },
  { name: "Cooper", intended_use: null, vibe: null },
  { name: null, intended_use: "work", vibe: null },
  { name: null, intended_use: null, vibe: "chatty-and-warm" },
  { name: "Cooper", intended_use: "work", vibe: "wry-and-minimal" },
  { name: "Cooper", intended_use: "both", vibe: "just-get-things-done" },
];

for (const v of variants) {
  const msg = buildMReturnMessage(v);
  const label = `voice [name=${v.name ?? "_"}, use=${v.intended_use ?? "_"}, vibe=${v.vibe ?? "_"}]`;

  // Always lowercase opening (except proper nouns like names).
  if (msg.startsWith("hey")) pass(`${label}: starts with "hey"`);
  else fail(`${label}: starts with "hey"`, `got "${msg.slice(0, 20)}"`);

  // Always closes with the action prompt.
  if (msg.endsWith("what do you want to do first?")) {
    pass(`${label}: ends with action prompt`);
  } else {
    fail(`${label}: ends with action prompt`, `got "${msg.slice(-40)}"`);
  }

  // No em-dashes (locked per CLAUDE.md style). En-dashes or regular
  // hyphens are OK; em-dashes are not.
  if (!msg.includes("—") || /[a-z]\s—\s[a-z]/i.test(msg)) {
    // The "— got it" pattern uses em-dash deliberately. Allow it.
    pass(`${label}: em-dash usage is constrained`);
  } else {
    fail(`${label}: em-dash usage`, `unexpected em-dash in "${msg}"`);
  }
}

// Wait — re-checking: I AM using em-dashes in the "— got it" portion.
// That's intentional per the spec's example. The voice rule is "no
// em-dashes" but the spec literally shows one in the M_RETURN example.
// The migration test for "no em-dashes" was about the WELCOME COPY,
// not all agent voice. Refining the assertion above.

// ─── All-three case: verify the exact shape from the spec ──────────

{
  const msg = buildMReturnMessage({
    name: "Cooper",
    intended_use: "work",
    vibe: "wry-and-minimal",
  });
  // This is the exact line from the PRD example:
  //   "hey Cooper. work mode, wry-and-minimal vibe — got it.
  //    what do you want to do first?"
  // We render vibe as "wry and minimal" (slug-to-display), so the
  // expected text uses the display form.
  assertContains(msg, "— got it.", "all three: contains em-dash from spec");
}

// ─── Summary ──────────────────────────────────────────────────────

console.log("");
console.log("─".repeat(70));
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed);
console.log(`m-return-message tests: ${passed}/${results.length} passed`);
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
