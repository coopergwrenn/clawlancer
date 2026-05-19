/**
 * AES-256-GCM encryption for OpenAI OAuth tokens.
 *
 * Mirrors lib/freeze-encryption.ts in cryptographic substance (same
 * algorithm, same IV/tag sizes, same key versioning) but exposes a
 * `string → string` API that's more convenient for token columns:
 *
 *   - Each encrypted column stores `<keyId>$<base64(IV+TAG+CIPHERTEXT)>`.
 *   - The keyId is encoded INTO the string, so no companion `<field>_keyId`
 *     column is needed. One DB column per encrypted field.
 *   - `decryptSecret(s, aad)` is self-sufficient w.r.t. key version — it
 *     parses the keyId from the prefix, loads the right key, decrypts.
 *     Version migration is automatic.
 *
 * Why a separate file from freeze-encryption.ts:
 *   - Different env-var prefix (OPENAI_OAUTH_KEY_* vs FREEZE_ARCHIVE_KEY_*).
 *   - Different storage shape (string with embedded keyId vs Buffer + keyId
 *     companion).
 *   - Touching freeze-encryption.ts is a production risk we don't need here.
 *   - If a third use case emerges, extract a shared low-level helper.
 *
 * Required env vars:
 *   - OPENAI_OAUTH_KEY_CURRENT       "v1" (or "v2", ...) — which key to use
 *                                     for new encrypts
 *   - OPENAI_OAUTH_KEY_V1            64-hex-char string = 32 raw bytes
 *   - OPENAI_OAUTH_KEY_V2            (during rotation, both v1 and v2 live)
 *   - ...
 *
 * Generate a new key:
 *   openssl rand -hex 32
 *
 * Wire format:
 *   "<keyId>$<base64>"
 *
 *   where base64 decodes to:
 *   [ IV (12 bytes) ][ AUTH_TAG (16 bytes) ][ CIPHERTEXT (variable) ]
 *
 * Overhead per encrypt: 28 bytes raw + base64 expansion (~37 chars), plus
 * the "v1$" prefix. For a 2 KB JWT this is ~3 KB encoded. Negligible.
 *
 * ─── AAD BINDING (mandatory) ─────────────────────────────────────────────
 *
 * encryptSecret(plaintext, aad) and decryptSecret(serialized, aad) BOTH
 * require an `aad` (Additional Authenticated Data) string. For OAuth
 * tokens stored on instaclaw_users, the aad MUST be the user_id. This
 * binds the ciphertext to the user record cryptographically:
 *
 *   - Encrypting under user A's aad and decrypting under user B's aad
 *     produces an auth-tag failure → DecryptError.
 *   - A DB-write attacker who swaps user A's encrypted token into user
 *     B's row cannot make it decrypt under B's aad — the swap is
 *     detected at the cipher layer, not just by application logic.
 *
 * The aad is authenticated but NOT encrypted (that's the standard AEAD
 * pattern — the user_id is already in plain sight on the user row, but
 * the AAD ensures the ciphertext was bound to it at encrypt time).
 *
 * AAD is mandatory (no default). Callers must explicitly choose the
 * binding context. Empty-string aad throws — silently binding to nothing
 * defeats the purpose.
 *
 * Failure semantics:
 *   - encryptSecret(): throws if OPENAI_OAUTH_KEY_CURRENT or its key var
 *                      is unset/malformed. Throws if aad is empty.
 *   - decryptSecret(): throws DecryptError on auth-tag failure (wrong
 *                      key, wrong aad, tamper, or corrupt blob) or
 *                      malformed input. Throws KeyMissingError on
 *                      unknown key id. Throws KeyIdInvalidError on
 *                      malformed prefix.
 *
 * Test coverage: scripts/_test-openai-oauth-encryption.ts.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

// ─── Constants ───────────────────────────────────────────────────────────

const ALGORITHM = "aes-256-gcm" as const;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID_PREFIX = "v";
const ENV_PREFIX = "OPENAI_OAUTH_KEY_";
const ENV_CURRENT = `${ENV_PREFIX}CURRENT`;
const SEPARATOR = "$";

/**
 * AAD used by the round-trip selfTest(). Internal — never use this as the
 * aad for a real token; tokens MUST use a context-meaningful value like
 * the user_id.
 */
const SELFTEST_AAD = "openai-oauth-encryption-selftest";

// ─── Errors ──────────────────────────────────────────────────────────────

export class DecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecryptError";
  }
}

export class KeyMissingError extends Error {
  public readonly keyId: string;
  constructor(keyId: string) {
    super(
      `No encryption key found for key_id=${keyId}. ` +
        `Check ${ENV_PREFIX}${keyId.toUpperCase()} env var (64 hex chars from \`openssl rand -hex 32\`).`,
    );
    this.name = "KeyMissingError";
    this.keyId = keyId;
  }
}

export class KeyIdInvalidError extends Error {
  constructor(keyId: string) {
    super(
      `Invalid key_id format: ${JSON.stringify(keyId)}. Expected "v<N>" where N is a positive integer.`,
    );
    this.name = "KeyIdInvalidError";
  }
}

// ─── Key loading ─────────────────────────────────────────────────────────

function validateKeyId(keyId: string): void {
  if (typeof keyId !== "string" || keyId.length === 0) {
    throw new KeyIdInvalidError(keyId);
  }
  if (!keyId.startsWith(KEY_ID_PREFIX)) {
    throw new KeyIdInvalidError(keyId);
  }
  const n = keyId.slice(KEY_ID_PREFIX.length);
  if (!/^[1-9][0-9]*$/.test(n)) {
    throw new KeyIdInvalidError(keyId);
  }
}

function loadKey(keyId: string): Buffer {
  validateKeyId(keyId);
  const envName = `${ENV_PREFIX}${keyId.toUpperCase()}`;
  const hex = process.env[envName];
  if (!hex) {
    throw new KeyMissingError(keyId);
  }
  const cleaned = hex.trim();
  if (!/^[0-9a-fA-F]+$/.test(cleaned)) {
    throw new Error(
      `${envName} is malformed: expected ${KEY_BYTES * 2} hex characters, got non-hex content.`,
    );
  }
  if (cleaned.length !== KEY_BYTES * 2) {
    throw new Error(
      `${envName} is the wrong length: expected ${KEY_BYTES * 2} hex characters ` +
        `(=${KEY_BYTES} bytes raw), got ${cleaned.length}. Generate with: openssl rand -hex ${KEY_BYTES}`,
    );
  }
  return Buffer.from(cleaned, "hex");
}

/**
 * Return the current key_id to use for new encrypts. Reads
 * OPENAI_OAUTH_KEY_CURRENT env (e.g., "v1") and validates format.
 */
export function getCurrentKeyId(): string {
  const id = process.env[ENV_CURRENT];
  if (!id) {
    throw new Error(
      `${ENV_CURRENT} env var is unset. Set it to the active key id (e.g., 'v1'). ` +
        `Also set ${ENV_PREFIX}V1 to a 64-hex-char value from \`openssl rand -hex 32\`. ` +
        `Back up the key offline — losing it makes existing tokens unrecoverable.`,
    );
  }
  validateKeyId(id);
  return id;
}

// ─── AAD validation ──────────────────────────────────────────────────────

/**
 * Validate the Additional Authenticated Data parameter. AAD is mandatory
 * and must be a non-empty string. Silently binding to an empty buffer
 * would defeat the security guarantee — make the misuse impossible.
 */
function validateAad(aad: string): Buffer {
  if (typeof aad !== "string") {
    throw new TypeError(
      `AAD must be a string, got ${typeof aad}. For OAuth tokens, pass the user_id.`,
    );
  }
  if (aad.length === 0) {
    throw new TypeError(
      "AAD must be a non-empty string. Empty AAD binds the ciphertext to nothing — " +
        "use the user_id for OAuth tokens (the scoping invariant we want enforced).",
    );
  }
  return Buffer.from(aad, "utf-8");
}

// ─── Operations ──────────────────────────────────────────────────────────

/**
 * Encrypt a plaintext string under the current key (OPENAI_OAUTH_KEY_CURRENT)
 * with AAD binding. The aad MUST be the same value passed to decryptSecret
 * later — for OAuth tokens, this is the user_id.
 *
 * @param plaintext - String to encrypt. Empty string is valid (the cipher
 *                    output is just the IV + tag with no ciphertext bytes).
 * @param aad - Mandatory binding context. For OAuth tokens stored on
 *              instaclaw_users, pass the user_id. Authenticated by the
 *              auth tag but not encrypted. Empty string throws.
 * @returns "<keyId>$<base64(IV+TAG+ENC)>" — store this in the DB column.
 */
export function encryptSecret(plaintext: string, aad: string): string {
  if (typeof plaintext !== "string") {
    throw new TypeError(`encryptSecret: plaintext must be a string, got ${typeof plaintext}`);
  }
  const aadBuf = validateAad(aad);
  const keyId = getCurrentKeyId();
  const key = loadKey(keyId);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  // setAAD MUST be called before update()/final() per Node crypto docs.
  cipher.setAAD(aadBuf);
  const plaintextBuf = Buffer.from(plaintext, "utf-8");
  const encrypted = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const wire = Buffer.concat([iv, authTag, encrypted]);
  return `${keyId}${SEPARATOR}${wire.toString("base64")}`;
}

/**
 * Decrypt a serialized string produced by encryptSecret. The keyId is
 * parsed from the "v<N>$" prefix; the correct key is loaded automatically.
 * Old-version blobs continue to decrypt after key rotation, AS LONG AS
 * the same aad is provided.
 *
 * If you encrypted with aad="user-A-id" and decrypt with aad="user-B-id",
 * the auth-tag check fails → DecryptError. This is the cross-user-tenant
 * isolation guarantee.
 *
 * @param serialized - The full "<keyId>$<base64>" string from the DB.
 * @param aad - Mandatory binding context. Must match the value passed to
 *              encryptSecret. For OAuth tokens, pass the user_id.
 * @returns The original plaintext string.
 * @throws DecryptError on auth-tag failure (wrong key, wrong aad, tamper, corruption).
 * @throws KeyMissingError if the requested key version isn't in env.
 * @throws KeyIdInvalidError on malformed prefix.
 */
export function decryptSecret(serialized: string, aad: string): string {
  if (typeof serialized !== "string") {
    throw new TypeError(
      `decryptSecret: serialized must be a string, got ${typeof serialized}`,
    );
  }
  const aadBuf = validateAad(aad);
  const sepIdx = serialized.indexOf(SEPARATOR);
  if (sepIdx <= 0) {
    throw new DecryptError(
      `Invalid serialized format: missing "${SEPARATOR}" separator. ` +
        `Expected "<keyId>${SEPARATOR}<base64>". Got: ${serialized.slice(0, 32)}${serialized.length > 32 ? "..." : ""}`,
    );
  }
  const keyId = serialized.slice(0, sepIdx);
  const base64 = serialized.slice(sepIdx + 1);
  validateKeyId(keyId); // may throw KeyIdInvalidError
  const wire = Buffer.from(base64, "base64");
  if (wire.length < IV_BYTES + TAG_BYTES) {
    throw new DecryptError(
      `Ciphertext too short: got ${wire.length} bytes after base64-decode, ` +
        `expected at least ${IV_BYTES + TAG_BYTES} (${IV_BYTES}-byte IV + ${TAG_BYTES}-byte tag). ` +
        `Blob is corrupt or in an unexpected format.`,
    );
  }
  const key = loadKey(keyId); // may throw KeyMissingError
  const iv = wire.subarray(0, IV_BYTES);
  const authTag = wire.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const encrypted = wire.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  // setAAD MUST be called before setAuthTag/update/final per Node crypto docs.
  decipher.setAAD(aadBuf);
  decipher.setAuthTag(authTag);
  try {
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString("utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DecryptError(
      `AES-GCM authentication failed (key_id=${keyId}). Likely causes: ` +
        `(1) wrong key for this blob, (2) wrong AAD (e.g., decrypting user A's ` +
        `ciphertext with user B's id), (3) blob was tampered with after encryption, ` +
        `(4) blob is corrupt. Underlying: ${msg.slice(0, 120)}`,
    );
  }
}

/**
 * Round-trip self-test. Encrypts + decrypts a synthetic payload with a
 * constant internal AAD to verify the current key is configured and usable.
 * Throws on any failure.
 *
 * Call this at process boot or from a doctor endpoint. Cheap (~1ms).
 */
export function selfTest(): { keyId: string; ok: true } {
  const probe = `selfTest-${Date.now()}-${randomBytes(8).toString("hex")}`;
  const ciphertext = encryptSecret(probe, SELFTEST_AAD);
  const recovered = decryptSecret(ciphertext, SELFTEST_AAD);
  if (recovered !== probe) {
    throw new Error(
      `openai-oauth-encryption selfTest: round-trip produced different bytes ` +
        `(keyId=${getCurrentKeyId()}). This indicates a serious bug in encrypt/decrypt ` +
        `or key configuration. Probe: ${probe.slice(0, 16)}... Recovered: ${String(recovered).slice(0, 16)}...`,
    );
  }
  return { keyId: getCurrentKeyId(), ok: true };
}
