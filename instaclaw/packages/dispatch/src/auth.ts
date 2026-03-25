/**
 * Auth — HMAC-based authentication for the dispatch WebSocket handshake.
 *
 * Protocol:
 *   Client sends: ?hmac=<hex>&ts=<unix_ms>&nonce=<random_hex>
 *   Server computes: HMAC-SHA256(gateway_token, ts + ":" + nonce)
 *   Server verifies: hmac matches, ts within 30s, nonce not seen before
 */
import crypto from "crypto";

const HANDSHAKE_MAX_AGE_MS = 30_000; // 30 seconds

/**
 * Generate auth params for WebSocket handshake (client-side).
 */
export function generateHandshake(gatewayToken: string): { hmac: string; ts: string; nonce: string } {
  const ts = String(Date.now());
  const nonce = crypto.randomBytes(16).toString("hex");
  const hmac = crypto.createHmac("sha256", gatewayToken)
    .update(ts + ":" + nonce)
    .digest("hex");
  return { hmac, ts, nonce };
}

/**
 * Build the WebSocket URL with auth query params.
 */
export function buildAuthUrl(vmAddress: string, port: number, gatewayToken: string): string {
  const { hmac, ts, nonce } = generateHandshake(gatewayToken);
  return `wss://${vmAddress}:${port}?hmac=${hmac}&ts=${ts}&nonce=${nonce}`;
}

/**
 * Verify auth params from WebSocket handshake (server-side).
 * Returns null on success, error string on failure.
 */
export function verifyHandshake(
  hmac: string,
  ts: string,
  nonce: string,
  gatewayToken: string,
  seenNonces: Map<string, number>
): string | null {
  // Timestamp check
  const tsMs = parseInt(ts, 10);
  if (isNaN(tsMs) || Math.abs(Date.now() - tsMs) > HANDSHAKE_MAX_AGE_MS) {
    return "Handshake expired (timestamp > 30s old)";
  }

  // Nonce replay check
  if (seenNonces.has(nonce)) {
    return "Nonce already used (replay attack)";
  }

  // HMAC verification
  const expected = crypto.createHmac("sha256", gatewayToken)
    .update(ts + ":" + nonce)
    .digest("hex");

  if (!crypto.timingSafeEqual(Buffer.from(hmac, "hex"), Buffer.from(expected, "hex"))) {
    return "HMAC verification failed";
  }

  // Record nonce (clean up old ones)
  seenNonces.set(nonce, Date.now());
  return null;
}

/**
 * Clean up expired nonces (call periodically).
 */
export function cleanupNonces(seenNonces: Map<string, number>, maxAgeMs = 60_000): void {
  const cutoff = Date.now() - maxAgeMs;
  for (const [nonce, ts] of seenNonces) {
    if (ts < cutoff) seenNonces.delete(nonce);
  }
}
