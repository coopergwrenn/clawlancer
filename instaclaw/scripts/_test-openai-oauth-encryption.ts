#!/usr/bin/env tsx
/**
 * Round-trip + tamper-detection + key-rotation + AAD-binding tests for
 * the OAuth token encryption helper.
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
 *   9. Edge cases (empty plaintext)
 *  10. Bad input types (numbers, etc.)
 *  11. AAD validation (empty string, non-string)
 *  12. AAD tenant isolation (encrypt-with-A decrypt-with-B fails)
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

// All non-AAD-specific tests use this fixed user-id-like AAD so we're
// exercising the WITH-AAD code path consistently. AAD-specific tests
// (sections 11-12) use distinct values to verify isolation.
const TEST_AAD = "user-id-fixture-00000000-0000-0000-0000-000000000001";

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
  const ct = encryptSecret(plaintext, TEST_AAD);
  const recovered = decryptSecret(ct, TEST_AAD);
  assert(recovered === plaintext, `round-trip ${label} (${plaintext.length} chars)`);
  assert(ct.startsWith("v1$"), `round-trip ${label} has v1 prefix`);
}

// 2. Tamper detection
console.log("\n2. Tamper detection:");
{
  const ct = encryptSecret("important-token", TEST_AAD);
  // Flip a byte in the base64 portion (after the "v1$" prefix).
  const prefix = ct.indexOf("$");
  const tail = ct.slice(prefix + 1);
  // Modify the first byte of the base64 (this corrupts the IV).
  const tampered = `${ct.slice(0, prefix + 1)}${tail[0] === "A" ? "B" : "A"}${tail.slice(1)}`;
  expectThrows(
    "tamper in IV byte throws DecryptError",
    () => decryptSecret(tampered, TEST_AAD),
    DecryptError,
  );
}
{
  const ct = encryptSecret("important-token", TEST_AAD);
  // Modify a byte in the middle (likely the auth tag or ciphertext).
  const tampered = ct.slice(0, -4) + "ZZZZ";
  expectThrows(
    "tamper in tail throws DecryptError",
    () => decryptSecret(tampered, TEST_AAD),
    DecryptError,
  );
}

// 3. Wrong key — pretend the ciphertext is from a key version we don't have
console.log("\n3. Wrong key version:");
{
  const ct = encryptSecret("a-secret", TEST_AAD);
  const ctAsV99 = ct.replace(/^v1\$/, "v99$"); // re-prefix to a key version that has no env
  expectThrows(
    "decrypt with unknown key version throws KeyMissingError",
    () => decryptSecret(ctAsV99, TEST_AAD),
    KeyMissingError,
  );
}

// 4. Malformed prefix
console.log("\n4. Malformed prefix:");
expectThrows(
  "missing $ throws DecryptError",
  () => decryptSecret("v1nodelim", TEST_AAD),
  DecryptError,
);
expectThrows(
  "non-v prefix throws KeyIdInvalidError",
  () => decryptSecret("k1$abc==", TEST_AAD),
  KeyIdInvalidError,
);
expectThrows(
  "v0 throws KeyIdInvalidError",
  () => decryptSecret("v0$abc==", TEST_AAD),
  KeyIdInvalidError,
);
expectThrows(
  "v with non-numeric throws KeyIdInvalidError",
  () => decryptSecret("vfoo$abc==", TEST_AAD),
  KeyIdInvalidError,
);

// 5. Truncated ciphertext
console.log("\n5. Truncated ciphertext:");
expectThrows(
  "too-short ciphertext throws DecryptError",
  () => decryptSecret("v1$AAAA", TEST_AAD), // way less than IV+TAG bytes
  DecryptError,
);

// 6. Key rotation: encrypt with v1, switch CURRENT to v2, decrypt v1 still works
console.log("\n6. Key rotation:");
{
  const v1Ciphertext = encryptSecret("legacy-token", TEST_AAD);
  process.env.OPENAI_OAUTH_KEY_CURRENT = "v2";
  // New encrypts go to v2.
  assert(getCurrentKeyId() === "v2", "getCurrentKeyId reflects new env");
  const v2Ciphertext = encryptSecret("new-token", TEST_AAD);
  assert(v2Ciphertext.startsWith("v2$"), "new encrypt uses v2");
  assert(v1Ciphertext.startsWith("v1$"), "old ciphertext still has v1 prefix");
  // Both still decrypt cleanly (same AAD as encrypt).
  assert(
    decryptSecret(v1Ciphertext, TEST_AAD) === "legacy-token",
    "v1 ciphertext decrypts under v2-CURRENT",
  );
  assert(
    decryptSecret(v2Ciphertext, TEST_AAD) === "new-token",
    "v2 ciphertext decrypts under v2-CURRENT",
  );
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
  const a = encryptSecret("identical-plaintext", TEST_AAD);
  const b = encryptSecret("identical-plaintext", TEST_AAD);
  assert(a !== b, "two encrypts of same plaintext (same AAD) produce different ciphertexts");
}

// 9. Empty plaintext round-trip is exact
console.log("\n9. Edge cases:");
{
  const ct = encryptSecret("", TEST_AAD);
  const rec = decryptSecret(ct, TEST_AAD);
  assert(rec === "", "empty string round-trips to empty string");
}

// 10. Type-check defensive throws on bad plaintext / serialized input
console.log("\n10. Bad input types:");
expectThrows(
  // @ts-expect-error intentional bad input
  "encryptSecret with number plaintext throws TypeError",
  () => encryptSecret(123, TEST_AAD),
  TypeError,
);
expectThrows(
  // @ts-expect-error intentional bad input
  "decryptSecret with number serialized throws TypeError",
  () => decryptSecret(123, TEST_AAD),
  TypeError,
);

// 11. AAD validation
console.log("\n11. AAD validation:");
expectThrows(
  "encryptSecret with empty-string AAD throws TypeError",
  () => encryptSecret("plaintext", ""),
  TypeError,
);
expectThrows(
  // @ts-expect-error intentional bad input
  "encryptSecret with non-string AAD throws TypeError",
  () => encryptSecret("plaintext", 42),
  TypeError,
);
expectThrows(
  "decryptSecret with empty-string AAD throws TypeError",
  () => decryptSecret(encryptSecret("plaintext", TEST_AAD), ""),
  TypeError,
);
expectThrows(
  // @ts-expect-error intentional bad input
  "decryptSecret with non-string AAD throws TypeError",
  () => decryptSecret(encryptSecret("plaintext", TEST_AAD), null),
  TypeError,
);

// 12. AAD tenant isolation — THE security guarantee P2-B was added for.
// An attacker with DB write access who copies user A's ciphertext into
// user B's row cannot make it decrypt under B's id.
console.log("\n12. AAD tenant isolation:");
const USER_A = "user-00000000-0000-0000-0000-00000000aaaa";
const USER_B = "user-00000000-0000-0000-0000-00000000bbbb";
{
  const aSecret = "this-is-user-As-token";
  const ctForA = encryptSecret(aSecret, USER_A);
  // Decrypting with the SAME aad works.
  assert(
    decryptSecret(ctForA, USER_A) === aSecret,
    "encrypt(A) + decrypt(A) round-trips successfully",
  );
  // Decrypting with a DIFFERENT aad throws — auth-tag verification fails
  // because the AAD was bound at encrypt time.
  expectThrows(
    "encrypt(A) + decrypt(B) throws DecryptError (tenant isolation)",
    () => decryptSecret(ctForA, USER_B),
    DecryptError,
  );
}
{
  // Edge case: AAD that differs by a single byte still fails.
  const ct = encryptSecret("payload", "user-X");
  expectThrows(
    "decrypt with 1-byte-different AAD throws DecryptError",
    () => decryptSecret(ct, "user-Y"),
    DecryptError,
  );
}

// ─── Summary ─────────────────────────────────────────────────────────────
console.log(`\n=== Results ===`);
console.log(`PASS: ${pass}`);
console.log(`FAIL: ${fail}`);
if (failures.length > 0) {
  console.log(`\nFailures:`);
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
