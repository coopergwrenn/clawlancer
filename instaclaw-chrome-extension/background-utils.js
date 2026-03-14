/**
 * HMAC-SHA256 token derivation for relay authentication.
 * Derives a relay token from the gateway token using the standard
 * openclaw-extension-relay-v1 message format.
 */

const RELAY_PORT = 18792;
const RELAY_MESSAGE_PREFIX = "openclaw-extension-relay-v1";

/**
 * Derive the HMAC-SHA256 relay token from a gateway token.
 * @param {string} gatewayToken - The gateway token from the VM
 * @returns {Promise<string>} Hex-encoded HMAC-SHA256 signature
 */
async function deriveRelayToken(gatewayToken) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(gatewayToken),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const message = `${RELAY_MESSAGE_PREFIX}:${RELAY_PORT}`;
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
