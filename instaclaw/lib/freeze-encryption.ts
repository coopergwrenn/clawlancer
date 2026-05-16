/**
 * AES-256-GCM encryption for freeze-v2 archive bundles.
 *
 * Why client-side encryption (PRD §6.4 / §16.5):
 *   - Tarballs contain user wallet private keys. Loss/theft = funds gone.
 *   - R2 server-side encryption is already on (Cloudflare default) — this
 *     is defense in depth, NOT a replacement for vendor encryption.
 *   - Server-side at-rest encryption protects against a Cloudflare data
 *     breach. Client-side adds protection against a Cloudflare insider /
 *     misconfigured R2 bucket / accidentally-public R2 token.
 *
 * Why key_id versioning from day 1:
 *   - The 3-year scale-debt audit (PRD §16.5) requires that we can rotate
 *     `FREEZE_ARCHIVE_KEY` annually without re-encrypting old archives.
 *   - Each encrypted blob's manifest.json records the `key_id` used to
 *     encrypt it (e.g., "v1", "v2"). The decrypt path looks up the right
 *     key for that id.
 *   - During rotation, BOTH keys (old + new) exist in Vercel env. New
 *     encrypts use the new key; decrypts of old archives use the old key.
 *   - This was a Cooper-approved refinement to Q5 — added in v1 to
 *     unblock v2 without later migration.
 *
 * Required env vars (per-key-version pattern):
 *   - FREEZE_ARCHIVE_KEY_CURRENT     "v1" (or "v2", "v3", ...) — which
 *                                     key to use for new encrypts
 *   - FREEZE_ARCHIVE_KEY_V1          64-hex-char string = 32 bytes raw
 *   - FREEZE_ARCHIVE_KEY_V2          (during rotation, both v1 and v2 live)
 *   - ... etc.
 *
 * Generate a new key:
 *   openssl rand -hex 32       # produces a 64-char hex string
 *
 * Wire format of an encrypted blob:
 *   [ IV (12 bytes) ][ AUTH_TAG (16 bytes) ][ CIPHERTEXT (variable) ]
 *
 *   - IV: 96-bit random per encrypt (standard for GCM)
 *   - AUTH_TAG: 128-bit (default for GCM in Node crypto)
 *   - CIPHERTEXT: same length as plaintext
 *
 * Total overhead: 28 bytes per encrypted object. Negligible vs our 5-50 MB
 * archive sizes.
 *
 * Key_id storage:
 *   - The key_id is NOT in the encrypted blob itself. It lives in the
 *     manifest.json that accompanies the blob (in the DB column
 *     `frozen_archive_manifest.encryption_key_id`).
 *   - Why not embed in the blob: keeps blob format simple, fails fast if
 *     manifest is lost (won't try to decrypt with the wrong key and
 *     produce garbage).
 *
 * Failure semantics:
 *   - encrypt(): throws if FREEZE_ARCHIVE_KEY_CURRENT or its key var is
 *                unset/malformed. Encryption itself can't fail.
 *   - decrypt(): throws DecryptError on auth-tag failure (tampered/wrong
 *                key/corrupted blob). Throws KeyMissingError on unknown
 *                key_id. Otherwise re-throws raw.
 *
 * Test coverage:
 *   - Smoke test in scripts/_verify-freeze-v2-infra.ts validates round-trip
 *     before any production use.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

// ─── Constants ───────────────────────────────────────────────────────────

const ALGORITHM = "aes-256-gcm" as const;
const KEY_BYTES = 32;    // 256 bits
const IV_BYTES = 12;     // 96 bits, standard for GCM
const TAG_BYTES = 16;    // 128 bits, default for GCM in Node
const KEY_ID_PREFIX = "v";

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
    super(`No encryption key found for key_id=${keyId}. Check FREEZE_ARCHIVE_KEY_${keyId.toUpperCase()} env var.`);
    this.name = "KeyMissingError";
    this.keyId = keyId;
  }
}

export class KeyIdInvalidError extends Error {
  constructor(keyId: string) {
    super(`Invalid key_id format: ${JSON.stringify(keyId)}. Expected "v<N>" where N is a positive integer.`);
    this.name = "KeyIdInvalidError";
  }
}

// ─── Key loading ─────────────────────────────────────────────────────────

/**
 * Validate a key_id string. Expects "v<N>" with N >= 1.
 * Throws KeyIdInvalidError if malformed.
 */
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

/**
 * Load the 32-byte key for the given key_id from Vercel env.
 * Throws KeyMissingError if unset, or descriptive error if malformed.
 */
function loadKey(keyId: string): Buffer {
  validateKeyId(keyId);
  const envName = `FREEZE_ARCHIVE_KEY_${keyId.toUpperCase()}`;
  const hex = process.env[envName];
  if (!hex) {
    throw new KeyMissingError(keyId);
  }
  // Allow lowercase hex with optional whitespace (people copy-paste sloppily)
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
 * Return the current key_id to use for new encrypts.
 * Reads FREEZE_ARCHIVE_KEY_CURRENT env (e.g., "v1") and validates format.
 */
export function getCurrentKeyId(): string {
  const id = process.env.FREEZE_ARCHIVE_KEY_CURRENT;
  if (!id) {
    throw new Error(
      "FREEZE_ARCHIVE_KEY_CURRENT env var is unset. Set it to the active key id (e.g., 'v1'). " +
      "Also set FREEZE_ARCHIVE_KEY_V1 to a 64-hex-char value (openssl rand -hex 32).",
    );
  }
  validateKeyId(id);
  return id;
}

// ─── Operations ──────────────────────────────────────────────────────────

/**
 * Encrypt a plaintext buffer with AES-256-GCM. Uses the current key
 * (from FREEZE_ARCHIVE_KEY_CURRENT). Generates a fresh random IV per
 * call (NEVER reuse IVs with the same key — that breaks GCM security).
 *
 * @param plaintext - Buffer to encrypt (any length, including empty)
 * @returns
 *   - ciphertext: [IV (12)][AUTH_TAG (16)][ENC] — store this verbatim in R2
 *   - keyId: which key id was used (record this in the manifest)
 */
export function encrypt(plaintext: Buffer): { ciphertext: Buffer; keyId: string } {
  const keyId = getCurrentKeyId();
  const key = loadKey(keyId);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Wire format: [IV][TAG][CIPHERTEXT]
  const ciphertext = Buffer.concat([iv, authTag, encrypted]);
  return { ciphertext, keyId };
}

/**
 * Decrypt a ciphertext buffer using the key identified by key_id.
 *
 * @param ciphertext - Wire-format buffer: [IV (12)][AUTH_TAG (16)][ENC]
 * @param keyId - key_id from the manifest (e.g., "v1")
 * @returns Plaintext buffer
 * @throws DecryptError on auth-tag mismatch (tampered/wrong-key/corrupted)
 * @throws KeyMissingError if the requested key id has no env var
 */
export function decrypt(ciphertext: Buffer, keyId: string): Buffer {
  validateKeyId(keyId);
  if (ciphertext.length < IV_BYTES + TAG_BYTES) {
    throw new DecryptError(
      `Ciphertext too short: got ${ciphertext.length} bytes, expected at least ${IV_BYTES + TAG_BYTES} ` +
      `(${IV_BYTES}-byte IV + ${TAG_BYTES}-byte auth tag). Blob is corrupt or in an unexpected format.`,
    );
  }
  const key = loadKey(keyId);  // may throw KeyMissingError
  const iv = ciphertext.subarray(0, IV_BYTES);
  const authTag = ciphertext.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const encrypted = ciphertext.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch (err) {
    // Node throws a generic "Unsupported state or unable to authenticate data"
    // on auth-tag failure. Wrap to a typed error so callers can distinguish
    // "tampered/wrong-key/corrupted" from other crypto failures.
    const msg = err instanceof Error ? err.message : String(err);
    throw new DecryptError(
      `AES-GCM authentication failed (key_id=${keyId}). Likely causes: ` +
      `(1) wrong key for this blob, (2) blob was modified after encryption, ` +
      `(3) blob is corrupt. Underlying: ${msg.slice(0, 120)}`,
    );
  }
}

/**
 * Sanity-check that the current key is configured and usable. Encrypts
 * + decrypts a 32-byte test blob round-trip. Used by the smoke-test script
 * and by /api/admin/freeze-v2-doctor (future).
 *
 * @throws if encryption/decryption fails
 */
export function selfTest(): { keyId: string; ok: true } {
  const probe = randomBytes(32);
  const { ciphertext, keyId } = encrypt(probe);
  const recovered = decrypt(ciphertext, keyId);
  if (!recovered.equals(probe)) {
    throw new Error(
      `freeze-encryption selfTest: round-trip produced different bytes (key_id=${keyId}). ` +
      `This indicates a serious bug in encrypt/decrypt or key configuration.`,
    );
  }
  return { keyId, ok: true };
}
