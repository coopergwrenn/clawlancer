#!/usr/bin/env tsx
/**
 * Synthetic tests for lib/sendblue.ts pure-logic layer.
 *
 * What this covers:
 *   - isValidE164: regex correctness across valid + invalid inputs.
 *   - getSendblueCredentials: throws when env unset; returns when set.
 *   - isSendblueConfigured: env-presence check.
 *   - SendblueError.message: NO phone number in the error string.
 *   - safeSendImessage: bad inputs (no fetch) return result types.
 *
 * What this does NOT cover (requires real Sendblue credentials):
 *   - sendImessage 2xx happy path
 *   - 5xx retry behavior
 *   - 4xx no-retry behavior
 *   - sendblueAccountInfo against the live API
 *
 * Run: npx tsx scripts/_test-sendblue-validation.ts
 *
 * Exit code: 0 if all pass, 1 if any fail. Prints a summary table.
 */

import {
  isValidE164,
  isSendblueConfigured,
  getSendblueCredentials,
  safeSendImessage,
  SendblueError,
} from "../lib/sendblue";

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

// ─── isValidE164 ──────────────────────────────────────────────────────

assertTrue(isValidE164("+14155551234"), "isValidE164: standard US +1 number");
assertTrue(isValidE164("+447911123456"), "isValidE164: UK +44 number");
assertTrue(isValidE164("+819012345678"), "isValidE164: Japan +81 number");
assertTrue(isValidE164("+12"), "isValidE164: minimum 2-digit number");
assertFalse(isValidE164("4155551234"), "isValidE164: missing +");
assertFalse(isValidE164("+04155551234"), "isValidE164: leading 0 after + (rejected)");
assertFalse(isValidE164("+abcdef"), "isValidE164: letters");
assertFalse(isValidE164(""), "isValidE164: empty string");
assertFalse(isValidE164("+"), "isValidE164: just a plus");
assertFalse(isValidE164("+1234567890123456"), "isValidE164: 16 digits (over the 15 max)");
assertFalse(isValidE164(undefined as unknown as string), "isValidE164: undefined");
assertFalse(isValidE164(null as unknown as string), "isValidE164: null");
assertFalse(isValidE164(12345 as unknown as string), "isValidE164: number");

// ─── isSendblueConfigured ─────────────────────────────────────────────

const savedKeyId = process.env.SENDBLUE_API_KEY_ID;
const savedSecretKey = process.env.SENDBLUE_API_SECRET_KEY;

delete process.env.SENDBLUE_API_KEY_ID;
delete process.env.SENDBLUE_API_SECRET_KEY;
assertFalse(isSendblueConfigured(), "isSendblueConfigured: both unset → false");

process.env.SENDBLUE_API_KEY_ID = "test-id";
assertFalse(isSendblueConfigured(), "isSendblueConfigured: only id set → false");

process.env.SENDBLUE_API_SECRET_KEY = "test-secret";
assertTrue(isSendblueConfigured(), "isSendblueConfigured: both set → true");

// ─── getSendblueCredentials ───────────────────────────────────────────

try {
  const creds = getSendblueCredentials();
  assertEq(creds.apiKeyId, "test-id", "getSendblueCredentials: returns apiKeyId");
  assertEq(creds.apiSecretKey, "test-secret", "getSendblueCredentials: returns apiSecretKey");
} catch (err) {
  fail("getSendblueCredentials: with both set", String(err));
}

delete process.env.SENDBLUE_API_KEY_ID;
try {
  getSendblueCredentials();
  fail("getSendblueCredentials: throws when id missing", "did not throw");
} catch (err) {
  if (err instanceof Error && err.message.includes("SENDBLUE_API_KEY_ID")) {
    pass("getSendblueCredentials: throws when id missing");
  } else {
    fail(
      "getSendblueCredentials: throws when id missing",
      `unexpected error: ${String(err)}`,
    );
  }
}

// ─── SendblueError: no phone in message ───────────────────────────────
// Restore env so we don't trip the credentials check before validation.
process.env.SENDBLUE_API_KEY_ID = "test-id";
process.env.SENDBLUE_API_SECRET_KEY = "test-secret";

(async () => {
  const dangerousPhone = "+14155551234"; // pretend this would leak if not redacted
  // Pass it as an INVALID phone (drop the +) so the regex fails and the
  // validation-throw fires. We then check the thrown message does NOT
  // contain the digits.
  const malformedButRecognizable = "4155551234"; // valid digits but missing +
  const res1 = await safeSendImessage(malformedButRecognizable, "test body");
  if (res1.ok) {
    fail("safeSendImessage: bad phone returns ok=false", "got ok=true");
  } else {
    const containsDigits = res1.error.includes("4155551234");
    if (!containsDigits) {
      pass("safeSendImessage: bad phone error does NOT leak digits");
    } else {
      fail(
        "safeSendImessage: bad phone error does NOT leak digits",
        `error contained digits: ${res1.error}`,
      );
    }
    assertEq(res1.status, 400, "safeSendImessage: bad phone returns status=400");
  }
  void dangerousPhone; // referenced for clarity even though we don't use it
})();

// ─── safeSendImessage: bad body ───────────────────────────────────────

(async () => {
  const res = await safeSendImessage("+14155551234", "");
  if (res.ok) {
    fail("safeSendImessage: empty body returns ok=false", "got ok=true");
  } else {
    assertEq(res.status, 400, "safeSendImessage: empty body returns status=400");
  }
})();

(async () => {
  const tooLong = "x".repeat(6000);
  const res = await safeSendImessage("+14155551234", tooLong);
  if (res.ok) {
    fail("safeSendImessage: oversized body returns ok=false", "got ok=true");
  } else {
    assertEq(res.status, 400, "safeSendImessage: oversized body returns status=400");
  }
})();

// ─── Class hierarchy ──────────────────────────────────────────────────

assertTrue(
  new SendblueError("test", 500) instanceof Error,
  "SendblueError instanceof Error",
);
assertTrue(
  new SendblueError("test", 500) instanceof SendblueError,
  "SendblueError instanceof SendblueError",
);

// ─── Restore env + print results ──────────────────────────────────────

setTimeout(() => {
  if (savedKeyId === undefined) delete process.env.SENDBLUE_API_KEY_ID;
  else process.env.SENDBLUE_API_KEY_ID = savedKeyId;
  if (savedSecretKey === undefined) delete process.env.SENDBLUE_API_SECRET_KEY;
  else process.env.SENDBLUE_API_SECRET_KEY = savedSecretKey;

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed);

  console.log("");
  console.log("─".repeat(70));
  console.log(`Sendblue validation tests: ${passed}/${results.length} passed`);
  console.log("─".repeat(70));

  for (const r of results) {
    const marker = r.passed ? "  ok" : "FAIL";
    console.log(`${marker}  ${r.name}${r.detail ? `\n        ${r.detail}` : ""}`);
  }

  if (failed.length > 0) {
    console.log("");
    console.log(`${failed.length} test(s) failed`);
    process.exit(1);
  }
  process.exit(0);
}, 100);
