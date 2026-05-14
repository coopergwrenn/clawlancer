/**
 * Interactive end-to-end test of the EdgeOS auth chain.
 *
 *   email → OTP → bearer → eos_live_*
 *
 * Defaults to the sandbox (api.dev.edgeos.world). Pass --prod to hit the
 * production API instead (not recommended unless verifying a real account).
 *
 * Usage:
 *   tsx scripts/_test-edgeos-auth-chain.ts --email you@example.com
 *   tsx scripts/_test-edgeos-auth-chain.ts --email you@example.com --prod
 *   tsx scripts/_test-edgeos-auth-chain.ts --email you@example.com --keep
 *       (default behavior is to revoke the test key at the end; --keep
 *        preserves it so you can keep poking at the events API)
 *
 * Side effects:
 *   - Causes an OTP email to be sent to the supplied address.
 *   - Creates an EdgeOS API key named "instaclaw-edge-test-<timestamp>".
 *   - By default revokes that key after listing it (cleanup); --keep skips.
 *
 * Does NOT touch any production VM or InstaClaw DB. Pure remote API test.
 */
import { createInterface } from "readline";
import {
  requestOTP,
  authenticateOTP,
  maskToken,
} from "../lib/edgeos-auth";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from "../lib/edgeos-api-keys";

const SANDBOX = "https://api.dev.edgeos.world";
const PROD = "https://api.edgeos.world";

function parseArgs(): { email: string; apiBase: string; keep: boolean } {
  const args = process.argv.slice(2);
  let email = "";
  let prod = false;
  let keep = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--email" && args[i + 1]) {
      email = args[++i];
    } else if (args[i] === "--prod") {
      prod = true;
    } else if (args[i] === "--keep") {
      keep = true;
    }
  }
  if (!email) {
    console.error("Usage: tsx scripts/_test-edgeos-auth-chain.ts --email <addr> [--prod] [--keep]");
    process.exit(1);
  }
  return { email, apiBase: prod ? PROD : SANDBOX, keep };
}

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const { email, apiBase, keep } = parseArgs();
  console.log(`API base: ${apiBase}`);
  console.log(`Email:    ${email}`);
  console.log("");

  // ── Step 1: request OTP ──
  console.log("→ Step 1: requestOTP(email)");
  const otpResult = await requestOTP(email, { apiBase });
  if (!otpResult.ok) {
    console.error(`✗ requestOTP failed: status=${otpResult.status} httpStatus=${otpResult.httpStatus}`);
    if (otpResult.raw) console.error(`  body: ${otpResult.raw}`);
    process.exit(2);
  }
  console.log(`✓ OTP email sent — message: ${otpResult.message ?? "(no message)"}`);
  console.log(`  expires in: ${otpResult.expiresInMinutes ?? "?"} minutes`);
  console.log("");

  // ── Step 2: prompt for OTP, authenticate ──
  const otp = await prompt("Enter the 6-digit OTP code from your email: ");
  if (!otp) {
    console.error("✗ no OTP entered");
    process.exit(2);
  }

  console.log(`→ Step 2: authenticateOTP(email, code)`);
  const authResult = await authenticateOTP(email, otp, { apiBase });
  if (!authResult.ok) {
    console.error(`✗ authenticateOTP failed: status=${authResult.status} httpStatus=${authResult.httpStatus}`);
    if (authResult.raw) console.error(`  body: ${authResult.raw}`);
    process.exit(3);
  }
  const bearer = authResult.accessToken;
  console.log(`✓ authenticated — token_type=${authResult.tokenType} bearer=${maskToken(bearer)}`);
  console.log("");

  // ── Step 3: create api-key with events:read ──
  const keyName = `instaclaw-edge-test-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  console.log(`→ Step 3: createApiKey(bearer, { name: "${keyName}", scopes: ["events:read"] })`);
  const createResult = await createApiKey(
    bearer,
    { name: keyName, scopes: ["events:read"] },
    { apiBase }
  );
  if (!createResult.ok) {
    console.error(`✗ createApiKey failed: status=${createResult.status} httpStatus=${createResult.httpStatus}`);
    if (createResult.raw) console.error(`  body: ${createResult.raw}`);
    process.exit(4);
  }
  const apiKey = createResult.apiKey;
  console.log(`✓ created — id=${apiKey.id} prefix=${apiKey.prefix}`);
  console.log(`  raw key (shown once): ${maskToken(apiKey.key)} — full key in env or log if you really need it`);
  console.log(`  scopes: ${apiKey.scopes.join(", ")}`);
  console.log("");

  // ── Step 4: list keys to verify the new one is present ──
  console.log("→ Step 4: listApiKeys(bearer)");
  const listResult = await listApiKeys(bearer, { apiBase });
  if (!listResult.ok) {
    console.error(`✗ listApiKeys failed: status=${listResult.status} httpStatus=${listResult.httpStatus}`);
    if (listResult.raw) console.error(`  body: ${listResult.raw}`);
    process.exit(5);
  }
  console.log(`✓ list returned ${listResult.apiKeys.length} keys`);
  const matching = listResult.apiKeys.find((k) => k.id === apiKey.id);
  if (matching) {
    console.log(`  ✓ created key is in the list: name=${matching.name} scopes=${matching.scopes.join(",")} revoked_at=${matching.revokedAt ?? "(active)"}`);
  } else {
    console.log("  ✗ created key NOT found in list — possible eventual-consistency lag");
  }
  console.log("");

  // ── Step 5: sanity probe the events endpoint with the eos_live_* ──
  console.log("→ Step 5: GET /api/v1/events/portal/events with the new eos_live_*");
  try {
    const eventsRes = await fetch(
      `${apiBase}/api/v1/events/portal/events?limit=1`,
      { headers: { Authorization: `Bearer ${apiKey.key}` } }
    );
    const eventsBody = await eventsRes.text();
    console.log(`  HTTP=${eventsRes.status}`);
    console.log(`  body (first 500): ${eventsBody.slice(0, 500)}`);
  } catch (err) {
    console.log(`  ✗ fetch error: ${err instanceof Error ? err.message : err}`);
  }
  console.log("");

  // ── Step 6: cleanup (unless --keep) ──
  if (keep) {
    console.log(`→ Step 6: SKIPPED (--keep) — test key persists. Revoke manually if you want.`);
    console.log(`  key id: ${apiKey.id}`);
    console.log(`  key:    ${apiKey.key}    ← ONLY shown here. Save it if you want to reuse.`);
  } else {
    console.log(`→ Step 6: revokeApiKey(bearer, ${apiKey.id}) — cleanup`);
    const revokeResult = await revokeApiKey(bearer, apiKey.id, { apiBase });
    if (!revokeResult.ok) {
      console.error(`  ✗ revoke failed: status=${revokeResult.status} httpStatus=${revokeResult.httpStatus}`);
      console.error(`  Manual cleanup needed: id=${apiKey.id}`);
      process.exit(6);
    }
    console.log("  ✓ revoked");
  }

  console.log("\n═══ all steps completed ═══");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(99);
});
