#!/usr/bin/env tsx
/**
 * Round-trip + tamper-detection + key-rotation tests for the OAuth
 * token encryption helper.
 *
 * Run: npx tsx instaclaw/scripts/_test-openai-oauth-encryption.ts
 *
 * Test plan:
 *   1. Round-trip on representative plaintexts (empty, short, JWT-sized)
 *   2. Tamper detection — flip a byte, decrypt should throw DecryptError
 *   3. Wrong-key — decrypt with prefix that points at a key we don't have
 *      → KeyMissingError
 *   4. Malformed prefix → KeyIdInvalidError
 *   5. Truncated ciphertext → DecryptError
 *   6. Key rotation: encrypt with v1, switch CURRENT to v2, decrypt the
 *      old v1 ciphertext still works
 *   7. selfTest() passes
 *   8. Each encrypt produces a fresh random IV (no determinism)
 *   9. encryptSecret + decryptSecret on a Unicode payload
 *
 * Exit 0 on all pass, 1 on any failure.
 */

// Set env BEFORE importing the encryption module (it reads env at fn call time
// but we want determinism for the test run).
const TEST_KEY_V1 = "a".repeat(64); // 64 hex chars = 32 bytes
const TEST_KEY_V2 = "b".repeat(64);
process.env.OPENAI_OAUTH_KEY_CURRENT = "v1";
process.env.OPENAI_OAUTH_KEY_V1 = TEST_KEY_V1;
process.env.OPENAI_OAUTH_KEY_V2 = TEST_KEY_V2;

import {
  encryptSecret,
  decryptSecret,
  DecryptError,
  KeyMissingError,
  KeyIdInvalidError,
  selfTest,
  getCurrentKeyId,
} from "../lib/openai-oauth-encryption";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function assert(cond: boolean, label: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  ✗ ${label}`);
  }
}

function expectThrows<T extends Error>(
  label: string,
  fn: () => unknown,
  errorClass: new (...args: never[]) => T,
): void {
  try {
    fn();
    fail++;
    failures.push(`${label} — expected ${errorClass.name}, no throw`);
    console.log(`  ✗ ${label} — expected ${errorClass.name}, no throw`);
  } catch (err) {
    if (err instanceof errorClass) {
      pass++;
      console.log(`  ✓ ${label} (threw ${errorClass.name})`);
    } else {
      fail++;
      failures.push(
        `${label} — expected ${errorClass.name}, got ${err instanceof Error ? err.constructor.name : typeof err}`,
      );
      console.log(
        `  ✗ ${label} — expected ${errorClass.name}, got ${err instanceof Error ? err.constructor.name : typeof err}`,
      );
    }
  }
}

console.log("\n=== openai-oauth-encryption test suite ===\n");

// 1. Round-trip on representative plaintexts
console.log("1. Round-trip:");
const payloads = [
  ["empty string", ""],
  ["short ascii", "sk-test-abc123"],
  ["JWT-sized", "eyJhbGciOiJSUzI1NiJ9." + "x".repeat(1800) + ".sig"],
  ["unicode", "héllo wörld 🦞 ψυχή"],
  ["with $ separator char in plaintext", "this$has$dollars"],
  ["with newlines", "line1\nline2\nline3\r\n"],
] as const;
for (const [label, plaintext] of payloads) {
  const ct = encryptSecret(plaintext);
  const recovered = decryptSecret(ct);
  assert(recovered === plaintext, `round-trip ${label} (${plaintext.length} chars)`);
  assert(ct.startsWith("v1$"), `round-trip ${label} has v1 prefix`);
}

// 2. Tamper detection
console.log("\n2. Tamper detection:");
{
  const ct = encryptSecret("important-token");
  // Flip a byte in the base64 portion (after the "v1$" prefix).
  const prefix = ct.indexOf("$");
  const tail = ct.slice(prefix + 1);
  // Modify the first byte of the base64 (this corrupts the IV).
  const tampered = `${ct.slice(0, prefix + 1)}${tail[0] === "A" ? "B" : "A"}${tail.slice(1)}`;
  expectThrows("tamper in IV byte throws DecryptError", () => decryptSecret(tampered), DecryptError);
}
{
  const ct = encryptSecret("important-token");
  // Modify a byte in the middle (likely the auth tag or ciphertext).
  const tampered = ct.slice(0, -4) + "ZZZZ";
  expectThrows("tamper in tail throws DecryptError", () => decryptSecret(tampered), DecryptError);
}

// 3. Wrong key — pretend the ciphertext is from a key version we don't have
console.log("\n3. Wrong key version:");
{
  const ct = encryptSecret("a-secret");
  const ctAsV99 = ct.replace(/^v1\$/, "v99$"); // re-prefix to a key version that has no env
  expectThrows(
    "decrypt with unknown key version throws KeyMissingError",
    () => decryptSecret(ctAsV99),
    KeyMissingError,
  );
}

// 4. Malformed prefix
console.log("\n4. Malformed prefix:");
expectThrows("missing $ throws DecryptError", () => decryptSecret("v1nodelim"), DecryptError);
expectThrows("non-v prefix throws KeyIdInvalidError", () => decryptSecret("k1$abc=="), KeyIdInvalidError);
expectThrows("v0 throws KeyIdInvalidError", () => decryptSecret("v0$abc=="), KeyIdInvalidError);
expectThrows(
  "v with non-numeric throws KeyIdInvalidError",
  () => decryptSecret("vfoo$abc=="),
  KeyIdInvalidError,
);

// 5. Truncated ciphertext
console.log("\n5. Truncated ciphertext:");
expectThrows(
  "too-short ciphertext throws DecryptError",
  () => decryptSecret("v1$AAAA"), // way less than IV+TAG bytes
  DecryptError,
);

// 6. Key rotation: encrypt with v1, switch CURRENT to v2, decrypt v1 still works
console.log("\n6. Key rotation:");
{
  const v1Ciphertext = encryptSecret("legacy-token");
  process.env.OPENAI_OAUTH_KEY_CURRENT = "v2";
  // New encrypts go to v2.
  assert(getCurrentKeyId() === "v2", "getCurrentKeyId reflects new env");
  const v2Ciphertext = encryptSecret("new-token");
  assert(v2Ciphertext.startsWith("v2$"), "new encrypt uses v2");
  assert(v1Ciphertext.startsWith("v1$"), "old ciphertext still has v1 prefix");
  // Both still decrypt cleanly.
  assert(decryptSecret(v1Ciphertext) === "legacy-token", "v1 ciphertext decrypts under v2-CURRENT");
  assert(decryptSecret(v2Ciphertext) === "new-token", "v2 ciphertext decrypts under v2-CURRENT");
  // Reset for downstream tests.
  process.env.OPENAI_OAUTH_KEY_CURRENT = "v1";
}

// 7. selfTest()
console.log("\n7. selfTest:");
{
  const result = selfTest();
  assert(result.ok === true, "selfTest returns ok=true");
  assert(result.keyId === "v1", "selfTest reports current keyId");
}

// 8. Fresh IV per encrypt (no determinism)
console.log("\n8. Random IV:");
{
  const a = encryptSecret("identical-plaintext");
  const b = encryptSecret("identical-plaintext");
  assert(a !== b, "two encrypts of same plaintext produce different ciphertexts");
}

// 9. Empty plaintext round-trip is exact
console.log("\n9. Edge cases:");
{
  const ct = encryptSecret("");
  const rec = decryptSecret(ct);
  assert(rec === "", "empty string round-trips to empty string");
}

// Type-check defensive throws
console.log("\n10. Bad input types:");
expectThrows(
  // @ts-expect-error intentional bad input
  "encryptSecret with number throws TypeError",
  () => encryptSecret(123),
  TypeError,
);
expectThrows(
  // @ts-expect-error intentional bad input
  "decryptSecret with number throws TypeError",
  () => decryptSecret(123),
  TypeError,
);

// ─── Summary ─────────────────────────────────────────────────────────────
console.log(`\n=== Results ===`);
console.log(`PASS: ${pass}`);
console.log(`FAIL: ${fail}`);
if (failures.length > 0) {
  console.log(`\nFailures:`);
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
