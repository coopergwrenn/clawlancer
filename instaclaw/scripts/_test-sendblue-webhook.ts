#!/usr/bin/env tsx
/**
 * Synthetic tests for lib/sendblue-webhook.ts.
 *
 * Verifies the real Sendblue contract (not Stripe-style HMAC):
 *   - Webhook auth: shared secret in `sb-signing-secret` header,
 *     compared to SENDBLUE_WEBHOOK_SECRET via sha256-hashed
 *     constant-time equal.
 *   - Inbound payload uses snake_case (from_number, is_outbound, etc.)
 *     except for `accountEmail` which is camelCase (Sendblue quirk).
 *   - status="RECEIVED" identifies real inbound messages.
 *   - service field is "iMessage" or "SMS".
 *   - was_downgraded boolean indicates SMS fallback.
 *
 * Run: npx tsx scripts/_test-sendblue-webhook.ts
 */

import {
  extractInbound,
  verifySigningSecret,
} from "../lib/sendblue-webhook";

type Result = { name: string; passed: boolean; detail?: string };
const results: Result[] = [];

function pass(name: string) {
  results.push({ name, passed: true });
}
function fail(name: string, detail: string) {
  results.push({ name, passed: false, detail });
}
function assertEq<T>(actual: T, expected: T, name: string) {
  if (actual === expected) pass(name);
  else fail(name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assertTrue(actual: boolean, name: string) {
  if (actual) pass(name);
  else fail(name, "expected true");
}
function assertFalse(actual: boolean, name: string) {
  if (!actual) pass(name);
  else fail(name, "expected false");
}

// ─── extractInbound against the real Sendblue payload shape ───────────

{
  // The canonical example payload from Sendblue's docs.
  const real = extractInbound({
    accountEmail: "your-account@example.com",
    content: "Hello!",
    is_outbound: false,
    status: "RECEIVED",
    error_code: null,
    error_message: null,
    message_handle: "msg_abc123",
    date_sent: "2026-05-26T10:30:00Z",
    date_updated: "2026-05-26T10:30:00Z",
    from_number: "+14155551234",
    number: "+14072425197",
    to_number: "+14072425197",
    was_downgraded: false,
    media_url: null,
    message_type: "message",
    sendblue_number: "+14072425197",
    service: "iMessage",
    group_id: null,
  });
  assertEq(real.fromNumber, "+14155551234", "real payload: fromNumber");
  assertEq(real.content, "Hello!", "real payload: content");
  assertEq(real.isOutbound, false, "real payload: isOutbound false");
  assertEq(real.status, "RECEIVED", "real payload: status RECEIVED");
  assertEq(real.service, "iMessage", "real payload: service iMessage");
  assertEq(real.wasDowngraded, false, "real payload: wasDowngraded false");
  assertEq(real.messageType, "message", "real payload: messageType message");
  assertEq(real.messageHandle, "msg_abc123", "real payload: messageHandle");
  assertEq(real.mediaUrl, null, "real payload: mediaUrl null");
  assertEq(real.groupId, null, "real payload: groupId null");
}

// ─── Minimal payload (the actual docs example — fewer fields) ────────
//
// The "Copy Quickstart for LLM" shape is leaner than the full payload
// — only 7 fields. Verify extractInbound handles the absence of
// status/message_type/is_outbound/was_downgraded gracefully (returns
// null/false, no crash).
{
  const minimal = extractInbound({
    from_number: "+14155551234",
    to_number: "+14072425197",
    content: "Hey, got your message!",
    media_url: "https://storage.sendblue.co/abc",
    service: "iMessage",
    group_id: null,
    date_sent: "2026-05-26T10:30:00Z",
  });
  assertEq(minimal.fromNumber, "+14155551234", "minimal payload: fromNumber");
  assertEq(minimal.content, "Hey, got your message!", "minimal payload: content");
  assertEq(minimal.mediaUrl, "https://storage.sendblue.co/abc", "minimal payload: mediaUrl");
  assertEq(minimal.groupId, null, "minimal payload: groupId null");
  assertEq(minimal.service, "iMessage", "minimal payload: service");
  // The missing fields should default safely:
  assertEq(minimal.status, null, "minimal payload: missing status → null");
  assertEq(minimal.isOutbound, false, "minimal payload: missing is_outbound → false");
  assertEq(minimal.messageType, null, "minimal payload: missing message_type → null");
  assertEq(minimal.wasDowngraded, false, "minimal payload: missing was_downgraded → false");
}

// ─── Group chat message (must be skipped by the route) ───────────────
{
  const group = extractInbound({
    from_number: "+14155551234",
    to_number: "+14072425197",
    content: "Hey everyone!",
    service: "iMessage",
    group_id: "grp_abc123",
    date_sent: "2026-05-26T10:30:00Z",
  });
  assertEq(group.groupId, "grp_abc123", "group payload: groupId extracted");
  assertEq(group.fromNumber, "+14155551234", "group payload: fromNumber still extracted");
}

// ─── Media-only message (text empty, attachment present) ─────────────
{
  const mediaOnly = extractInbound({
    from_number: "+14155551234",
    to_number: "+14072425197",
    content: "",
    media_url: "https://storage.sendblue.co/screenshot.jpg",
    service: "iMessage",
    group_id: null,
  });
  assertEq(mediaOnly.content, null, "media-only: empty content → null");
  assertEq(mediaOnly.mediaUrl, "https://storage.sendblue.co/screenshot.jpg", "media-only: mediaUrl extracted");
}

// ─── Outbound echo (we should skip these) ─────────────────────────────

{
  const out = extractInbound({
    content: "echo of our send",
    is_outbound: true,
    status: "DELIVERED",
    from_number: "+14072425197", // our line
    to_number: "+14155551234",   // the user
    service: "iMessage",
    message_type: "message",
  });
  assertEq(out.isOutbound, true, "outbound echo: isOutbound true");
  assertEq(out.status, "DELIVERED", "outbound echo: status DELIVERED");
}

// ─── SMS fallback (Android user, or iMessage downgraded) ─────────────

{
  const sms = extractInbound({
    content: "from an android user",
    is_outbound: false,
    status: "RECEIVED",
    from_number: "+14155551234",
    was_downgraded: true,
    service: "SMS",
    message_type: "message",
  });
  assertEq(sms.service, "SMS", "SMS fallback: service");
  assertEq(sms.wasDowngraded, true, "SMS fallback: wasDowngraded true");
}

// ─── Reaction event (skip) ────────────────────────────────────────────

{
  const react = extractInbound({
    content: "❤",
    is_outbound: false,
    status: "RECEIVED",
    from_number: "+14155551234",
    message_type: "reaction",
    service: "iMessage",
  });
  assertEq(react.messageType, "reaction", "reaction: messageType");
}

// ─── Missing fields → null/false, never crash ────────────────────────

{
  const empty = extractInbound({});
  assertEq(empty.fromNumber, null, "missing: fromNumber null");
  assertEq(empty.content, null, "missing: content null");
  assertEq(empty.isOutbound, false, "missing: isOutbound false");
  assertEq(empty.status, null, "missing: status null");
  assertEq(empty.service, null, "missing: service null");
  assertEq(empty.wasDowngraded, false, "missing: wasDowngraded false");
  assertEq(empty.messageType, null, "missing: messageType null");
  assertEq(empty.messageHandle, null, "missing: messageHandle null");
}

// ─── Wrong types → defensive null/false ──────────────────────────────

{
  const bad = extractInbound({
    from_number: 12345 as unknown as string,
    content: { malformed: "object" } as unknown as string,
    is_outbound: "true" as unknown as boolean,
    status: 123 as unknown as string,
    service: null as unknown as string,
    was_downgraded: "true" as unknown as boolean,
  });
  assertEq(bad.fromNumber, null, "bad types: from_number non-string → null");
  assertEq(bad.content, null, "bad types: content non-string → null");
  assertEq(bad.isOutbound, false, "bad types: is_outbound non-bool → false");
  assertEq(bad.status, null, "bad types: status non-string → null");
  assertEq(bad.service, null, "bad types: service null → null");
  assertEq(bad.wasDowngraded, false, "bad types: was_downgraded non-bool → false");
}

// ─── Empty-string fields are equivalent to missing ───────────────────

{
  const blank = extractInbound({
    from_number: "",
    content: "",
    status: "",
    service: "",
    message_type: "",
    message_handle: "",
  });
  assertEq(blank.fromNumber, null, "empty string: fromNumber → null");
  assertEq(blank.content, null, "empty string: content → null");
  assertEq(blank.status, null, "empty string: status → null");
  assertEq(blank.service, null, "empty string: service → null");
  assertEq(blank.messageType, null, "empty string: messageType → null");
  assertEq(blank.messageHandle, null, "empty string: messageHandle → null");
}

// ─── verifySigningSecret (static-secret comparison, sha256-hashed) ───

// Synthetic test constant — NOT the production webhook secret.
// Any 30+ char string works here; the test exercises the comparison
// logic, not any specific secret value.
const PROD_SECRET = "test_synthetic_secret_for_unit_tests_only_xxxx";

assertTrue(
  verifySigningSecret(PROD_SECRET, PROD_SECRET),
  "verifySigningSecret: matching secrets accepted",
);

assertFalse(
  verifySigningSecret(PROD_SECRET, "different-secret"),
  "verifySigningSecret: different secrets rejected",
);

// Length differs — should still NOT crash + return false (sha256 hashing
// equalizes the comparison input length, but the post-hash bytes will
// differ).
assertFalse(
  verifySigningSecret("short", PROD_SECRET),
  "verifySigningSecret: length mismatch rejected (and no crash)",
);

assertFalse(
  verifySigningSecret(PROD_SECRET, "short"),
  "verifySigningSecret: length mismatch (other direction) rejected",
);

assertFalse(
  verifySigningSecret("", PROD_SECRET),
  "verifySigningSecret: empty provided rejected",
);

assertFalse(
  verifySigningSecret(PROD_SECRET, ""),
  "verifySigningSecret: empty expected rejected",
);

assertFalse(
  verifySigningSecret("", ""),
  "verifySigningSecret: both empty rejected",
);

assertFalse(
  verifySigningSecret(null as unknown as string, PROD_SECRET),
  "verifySigningSecret: null provided rejected (no crash)",
);

assertFalse(
  verifySigningSecret(PROD_SECRET, undefined as unknown as string),
  "verifySigningSecret: undefined expected rejected (no crash)",
);

assertFalse(
  verifySigningSecret(12345 as unknown as string, PROD_SECRET),
  "verifySigningSecret: numeric provided rejected (no crash)",
);

// Case sensitivity (secrets must match exactly)
assertFalse(
  verifySigningSecret(PROD_SECRET.toUpperCase(), PROD_SECRET),
  "verifySigningSecret: case-sensitive comparison",
);

// One-character difference at end (would defeat naive length-then-substring compare)
assertFalse(
  verifySigningSecret(PROD_SECRET.slice(0, -1) + "X", PROD_SECRET),
  "verifySigningSecret: last-char-different rejected",
);

// One-character difference at start
assertFalse(
  verifySigningSecret("X" + PROD_SECRET.slice(1), PROD_SECRET),
  "verifySigningSecret: first-char-different rejected",
);

// ─── Summary ──────────────────────────────────────────────────────────

console.log("");
console.log("─".repeat(70));
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed);
console.log(`sendblue-webhook tests: ${passed}/${results.length} passed`);
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
