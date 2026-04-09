import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV for GCM
const AUTH_TAG_LENGTH = 16; // 128-bit auth tag

function getKey(): Buffer {
  const hex = process.env.BANKR_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("BANKR_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)");
  }
  return Buffer.from(hex, "hex");
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * Returns base64(iv + ciphertext + authTag).
 */
export function encryptBankrKey(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Pack: iv (12) + ciphertext (variable) + authTag (16)
  return Buffer.concat([iv, encrypted, authTag]).toString("base64");
}

/**
 * Decrypt a string encrypted by encryptBankrKey.
 * Input: base64(iv + ciphertext + authTag).
 */
export function decryptBankrKey(encrypted: string): string {
  const key = getKey();
  const buf = Buffer.from(encrypted, "base64");
  if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
    throw new Error("Invalid encrypted data: too short");
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(buf.length - AUTH_TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH, buf.length - AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final("utf-8");
}
