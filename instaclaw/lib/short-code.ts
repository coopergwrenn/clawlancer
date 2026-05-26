/**
 * Short-code generator for channel-onboarding pending_users rows.
 *
 * Welcome Message 3 sends a URL like `instaclaw.io/go/r7k2x` as a
 * standalone bubble in iMessage / Telegram. The 5-char code is the
 * lookup key on /go/:code → /auth?session=<id>.
 *
 * Properties of a good code for this purpose:
 *   - Short enough to read in a glance and tap accurately on mobile
 *     (5 chars at our scale; 36^5 = ~60M keyspace, room for 1000+
 *     concurrent in-flight signups without collision risk).
 *   - Lowercase alphanumeric only — URL-safe, no character escaping,
 *     no visually-confusing capitalization on iOS autocorrect.
 *   - Cryptographically random — non-guessable, so a bot scanning
 *     /go/aaaa, /go/aaab, etc. has 1-in-60M odds per try of hitting
 *     a real in-flight signup.
 *   - Unbiased — rejection sampling avoids the modulo-skew that
 *     plain `byte % 36` introduces.
 *
 * Why not nanoid / cuid / uuid:
 *   - nanoid adds a dependency for ~20 lines of code; not worth it.
 *   - cuid is longer than we want (visual weight in the message).
 *   - UUIDs are way too long for a bare-URL tappable bubble.
 *
 * Why not just `Math.random()`:
 *   - Not cryptographically secure. A motivated attacker could
 *     potentially predict future codes. Using node:crypto's
 *     randomBytes closes that risk for ~free.
 */

import { randomBytes } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
// Highest multiple of ALPHABET.length below 256, for rejection sampling.
// 256 / 36 = 7.11 → floor(7.11) × 36 = 252. Accept bytes [0, 252), reject [252, 256).
const REJECTION_THRESHOLD = Math.floor(256 / ALPHABET.length) * ALPHABET.length;

/**
 * Generate a cryptographically random short code.
 *
 * Default length is 5. The migration column is VARCHAR(8) so lengths
 * 4-8 are storage-compatible. The /go/:code resolver regex is
 * /^[a-z0-9]{4,8}$/ — also tolerant.
 *
 * Per-byte acceptance rate under rejection sampling: 252/256 ≈ 98.4%.
 * Expected total bytes for length=5: ~5.08. Negligible overhead.
 *
 * @param length Number of characters to produce. Default 5.
 * @returns Lowercase alphanumeric string of exactly `length` chars.
 */
export function generateShortCode(length: number = 5): string {
  if (length < 1 || length > 64) {
    throw new Error(`generateShortCode: length must be in [1, 64], got ${length}`);
  }

  let code = "";
  while (code.length < length) {
    // Pull bytes in small batches to amortize syscall cost.
    const bytes = randomBytes(length * 2);
    for (let i = 0; i < bytes.length && code.length < length; i++) {
      const byte = bytes[i];
      if (byte >= REJECTION_THRESHOLD) continue;
      code += ALPHABET[byte % ALPHABET.length];
    }
  }
  return code;
}

/**
 * Validate that a string matches our short-code format.
 * Used by the /go/:code resolver (also has its own regex) and by
 * any consumer that needs to sanity-check user input.
 */
export function isValidShortCode(code: unknown): code is string {
  return typeof code === "string" && /^[a-z0-9]{4,8}$/.test(code);
}
