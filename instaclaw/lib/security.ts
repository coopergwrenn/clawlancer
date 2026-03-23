import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Gateway token generation
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically secure gateway token.
 * Uses Web Crypto API for randomness — safe for server-side use in Next.js.
 * Returns a 64-character hex string (256 bits of entropy).
 */
export function generateGatewayToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Generate a shorter token suitable for invite codes.
 * Format: XXXX-XXXX-XXXX (no 0/O, 1/I confusion).
 */
export function generateInviteCode(): string {
  const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);

  const parts: string[] = [];
  for (let p = 0; p < 3; p++) {
    let segment = "";
    for (let i = 0; i < 4; i++) {
      segment += CHARS[bytes[p * 4 + i] % CHARS.length];
    }
    parts.push(segment);
  }
  return parts.join("-");
}

// ---------------------------------------------------------------------------
// API key encryption / decryption
// ---------------------------------------------------------------------------

// The encryption key is derived from CREDENTIAL_ENCRYPTION_KEY env var using
// PBKDF2. This key is separate from the per-VM vault key used in the shell
// scripts — this one protects keys stored in the Supabase database.

const ALGORITHM = "AES-GCM";
const KEY_LENGTH = 256;
const IV_LENGTH = 12; // 96 bits, recommended for AES-GCM
const SALT_LENGTH = 16;
const PBKDF2_ITERATIONS = 100_000;

async function deriveKey(
  password: string,
  salt: Uint8Array
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt.buffer as ArrayBuffer,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: ALGORITHM, length: KEY_LENGTH },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Encrypt a plaintext string (e.g. an Anthropic API key).
 *
 * Returns a base64-encoded string containing: salt + iv + ciphertext.
 * The encryption key is derived from the CREDENTIAL_ENCRYPTION_KEY env var
 * using PBKDF2 with a random salt per encryption.
 *
 * This is used to encrypt API keys before storing them in Supabase.
 */
export async function encryptApiKey(plaintext: string): Promise<string> {
  const password = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!password) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY not set");
  }

  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await deriveKey(password, salt);

  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    key,
    new TextEncoder().encode(plaintext)
  );

  // Pack salt + iv + ciphertext into a single buffer
  const packed = new Uint8Array(
    SALT_LENGTH + IV_LENGTH + ciphertext.byteLength
  );
  packed.set(salt, 0);
  packed.set(iv, SALT_LENGTH);
  packed.set(new Uint8Array(ciphertext), SALT_LENGTH + IV_LENGTH);

  return btoa(String.fromCharCode(...packed));
}

/**
 * Decrypt a previously encrypted API key.
 * Input is the base64 string returned by encryptApiKey().
 */
export async function decryptApiKey(encrypted: string): Promise<string> {
  const password = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!password) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY not set");
  }

  const packed = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));

  const salt = packed.slice(0, SALT_LENGTH);
  const iv = packed.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const ciphertext = packed.slice(SALT_LENGTH + IV_LENGTH);

  const key = await deriveKey(password, salt);

  const plaintext = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv },
    key,
    ciphertext
  );

  return new TextDecoder().decode(plaintext);
}

// ---------------------------------------------------------------------------
// Auth token validation for API routes
// ---------------------------------------------------------------------------

/**
 * Validate the gateway auth token on an incoming request.
 * Checks the X-Gateway-Token header against the stored token for the VM.
 *
 * Usage in API routes:
 *   const valid = validateGatewayToken(req, expectedToken);
 *   if (!valid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
 */
export function validateGatewayToken(
  req: NextRequest,
  expectedToken: string
): boolean {
  const provided = req.headers.get("x-gateway-token");
  if (!provided || !expectedToken) return false;

  // Constant-time comparison to prevent timing attacks
  return timingSafeEqual(provided, expectedToken);
}

/**
 * Validate the cron secret on incoming cron job requests.
 * Checks the Authorization: Bearer <secret> header.
 */
export function validateCronSecret(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization");
  const expected = process.env.CRON_SECRET;
  if (!authHeader || !expected) return false;

  const provided = authHeader.replace(/^Bearer\s+/i, "");
  return timingSafeEqual(provided, expected);
}

/**
 * Validate an admin API key for internal service-to-service calls.
 * Checks X-Admin-Key header.
 */
export function validateAdminKey(req: NextRequest): boolean {
  const provided = req.headers.get("x-admin-key");
  const expected = process.env.ADMIN_API_KEY;
  if (!provided || !expected) return false;
  return timingSafeEqual(provided, expected);
}

// ---------------------------------------------------------------------------
// Mini App proxy token validation (X-Mini-App-Token)
// ---------------------------------------------------------------------------

/**
 * Validate and decode a mini app proxy token.
 * The token is a JWT signed with MINI_APP_PROXY_SECRET containing { userId, source: "mini-app" }.
 * Returns the userId if valid, null otherwise.
 *
 * This is used by API routes that accept requests proxied from the World mini app
 * (mini.instaclaw.io). The mini app signs short-lived (60s) per-user tokens so
 * there is no global admin key that can access all users' data.
 */
export async function validateMiniAppToken(
  req: NextRequest
): Promise<string | null> {
  const token = req.headers.get("x-mini-app-token");
  const secret = process.env.MINI_APP_PROXY_SECRET;
  if (!token || !secret) return null;

  try {
    // Decode JWT: header.payload.signature (HS256)
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    // Verify signature using Web Crypto HMAC
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const signatureInput = `${parts[0]}.${parts[1]}`;
    const signature = Uint8Array.from(
      atob(parts[2].replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0)
    );

    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      encoder.encode(signatureInput)
    );

    if (!valid) return null;

    // Decode payload
    const payload = JSON.parse(
      atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))
    );

    // Check expiry
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    // Check source
    if (payload.source !== "mini-app") return null;

    return payload.userId as string;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Constant-time string comparison
// ---------------------------------------------------------------------------

/**
 * Compare two strings in constant time to prevent timing attacks.
 * Always compares the full length of the longer string.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBuf = encoder.encode(a);
  const bBuf = encoder.encode(b);

  // Pad shorter to match longer
  const maxLen = Math.max(aBuf.length, bBuf.length);
  const aPadded = new Uint8Array(maxLen);
  const bPadded = new Uint8Array(maxLen);
  aPadded.set(aBuf);
  bPadded.set(bBuf);

  let result = 0;
  // XOR every byte — if any differ, result will be non-zero
  for (let i = 0; i < maxLen; i++) {
    result |= aPadded[i] ^ bPadded[i];
  }

  // Also check lengths match (prevents length-only leaks)
  result |= aBuf.length ^ bBuf.length;

  return result === 0;
}
