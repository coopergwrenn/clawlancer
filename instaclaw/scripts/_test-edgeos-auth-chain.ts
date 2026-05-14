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
  EDGEOS_TENANT_EDGECITY_PROD,
  EDGEOS_TENANT_DEMO_SANDBOX,
} from "../lib/edgeos-auth";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  deterministicKeyName,
} from "../lib/edgeos-api-keys";
import { mintOrReuseApiKey } from "../lib/edgeos-mint";

const SANDBOX = "https://api.dev.edgeos.world";
const PROD = "https://api.edgeos.world";

function parseArgs(): {
  email: string;
  apiBase: string;
  tenantId: string;
  tenantLabel: string;
  keep: boolean;
} {
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
    console.error("  default tenant: demo sandbox (ea1aaa1d-…) on api.dev.edgeos.world");
    console.error("  --prod         : EdgeCity prod tenant (6018917b-…) on api.edgeos.world");
    process.exit(1);
  }
  return {
    email,
    apiBase: prod ? PROD : SANDBOX,
    tenantId: prod ? EDGEOS_TENANT_EDGECITY_PROD : EDGEOS_TENANT_DEMO_SANDBOX,
    tenantLabel: prod ? "EdgeCity (prod)" : "Demo (sandbox)",
    keep,
  };
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
  const { email, apiBase, tenantId, tenantLabel, keep } = parseArgs();
  const env = { apiBase, tenantId };
  console.log(`API base: ${apiBase}`);
  console.log(`Tenant:   ${tenantLabel} (${tenantId})`);
  console.log(`Email:    ${email}`);
  console.log("");

  // ── Step 1: request OTP ──
  console.log("→ Step 1: requestOTP(email)");
  // X-Tenant-Id is harmlessly accepted on auth endpoints; pass it so the
  // request shape matches the frontend interceptor exactly.
  const otpResult = await requestOTP(email, env);
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
  const authResult = await authenticateOTP(email, otp, env);
  if (!authResult.ok) {
    console.error(`✗ authenticateOTP failed: status=${authResult.status} httpStatus=${authResult.httpStatus}`);
    if (authResult.raw) console.error(`  body: ${authResult.raw}`);
    process.exit(3);
  }
  const bearer = authResult.accessToken;
  console.log(`✓ authenticated — token_type=${authResult.tokenType} bearer=${maskToken(bearer)}`);
  console.log("");

  // ── Step 3: create api-key with events:read (timestamped name) ──
  const keyName = `instaclaw-edge-test-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  console.log(`→ Step 3: createApiKey(bearer, { name: "${keyName}", scopes: ["events:read"] })`);
  const createResult = await createApiKey(
    bearer,
    { name: keyName, scopes: ["events:read"] },
    env
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
  const listResult = await listApiKeys(bearer, env);
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
  let eventCount: number | null = null;
  try {
    const eventsRes = await fetch(
      `${apiBase}/api/v1/events/portal/events?limit=5`,
      {
        headers: {
          Authorization: `Bearer ${apiKey.key}`,
          "X-Tenant-Id": tenantId,
        },
      }
    );
    const eventsBody = await eventsRes.text();
    console.log(`  HTTP=${eventsRes.status}`);
    if (eventsRes.ok) {
      try {
        const parsed = JSON.parse(eventsBody);
        const results = Array.isArray(parsed) ? parsed : (parsed.results ?? []);
        eventCount = results.length;
        console.log(`  ✓ returned ${eventCount} events`);
        if (eventCount > 0) {
          const first = results[0];
          console.log(`  first: id=${first.id} title=${JSON.stringify(first.title ?? "?")} start=${first.start_time ?? "?"}`);
        } else {
          console.log(`  ⚠ list returned [] — possible popup-membership gate, or no events in this popup yet`);
        }
      } catch {
        console.log(`  ✗ body not JSON: ${eventsBody.slice(0, 300)}`);
      }
    } else {
      console.log(`  body (first 500): ${eventsBody.slice(0, 500)}`);
    }
  } catch (err) {
    console.log(`  ✗ fetch error: ${err instanceof Error ? err.message : err}`);
  }
  console.log("");

  // ── Step 6: 409 / name_conflict exercise ──
  // Retry the SAME key name; expect status=name_conflict.
  console.log(`→ Step 6: createApiKey AGAIN with same name "${keyName}" — expect name_conflict`);
  const dupResult = await createApiKey(
    bearer,
    { name: keyName, scopes: ["events:read"] },
    env
  );
  if (dupResult.ok) {
    console.log(`  ✗ unexpected: duplicate create succeeded with id=${dupResult.apiKey.id}`);
    console.log(`    EdgeOS did NOT enforce name uniqueness — name_conflict handling is dead code on this backend`);
    console.log(`    Cleaning up the duplicate immediately...`);
    await revokeApiKey(bearer, dupResult.apiKey.id, env);
  } else if (dupResult.status === "name_conflict") {
    console.log(`  ✓ got name_conflict (http=${dupResult.httpStatus}) — categorization works`);
    console.log(`    raw: ${(dupResult.raw ?? "").slice(0, 200)}`);
  } else {
    console.log(`  ⚠ got status=${dupResult.status} (http=${dupResult.httpStatus}) — NOT name_conflict, NOT ok`);
    console.log(`    raw: ${(dupResult.raw ?? "").slice(0, 300)}`);
    console.log(`    This means EdgeOS uses a different status code for duplicates. Update NAME_CONFLICT_HINTS in lib/edgeos-api-keys.ts.`);
  }
  console.log("");

  // ── Step 7: mintOrReuseApiKey end-to-end (the high-level helper) ──
  // Uses the DETERMINISTIC name (instaclaw-edge-{vmName}) — simulates the
  // configureOpenClaw call site. First run should mint; second run with the
  // same vmName should hit name_conflict and return mode=existing.
  const fakeVmName = `test-mint-${Math.random().toString(36).slice(2, 8)}`;
  console.log(`→ Step 7a: mintOrReuseApiKey({ vmName: "${fakeVmName}" }) — first run, expect created`);
  const mint1 = await mintOrReuseApiKey(
    { bearer, vmName: fakeVmName, scopes: ["events:read"] },
    env,
    (e) => console.log(`     [telemetry] ${e.op} attempt=${e.attempt} ${e.details ?? ""}`)
  );
  let mintedKeyId: string | null = null;
  if (mint1.ok) {
    console.log(`  ✓ mode=${mint1.mode} id=${mint1.apiKey.id} prefix=${mint1.apiKey.prefix} fullKey=${mint1.fullKey ? maskToken(mint1.fullKey) : "(null)"}`);
    mintedKeyId = mint1.apiKey.id;
  } else {
    console.log(`  ✗ mint1 failed: ${mint1.status} ${mint1.detail ?? ""}`);
  }
  console.log("");

  console.log(`→ Step 7b: mintOrReuseApiKey({ vmName: "${fakeVmName}" }) — second run, expect mode=existing`);
  const mint2 = await mintOrReuseApiKey(
    { bearer, vmName: fakeVmName, scopes: ["events:read"], onConflict: "return_existing" },
    env,
    (e) => console.log(`     [telemetry] ${e.op} attempt=${e.attempt} ${e.details ?? ""}`)
  );
  if (mint2.ok) {
    if (mint2.mode === "existing") {
      console.log(`  ✓ mode=existing id=${mint2.apiKey.id} prefix=${mint2.apiKey.prefix} fullKey=${mint2.fullKey === null ? "(null as expected)" : "(unexpected!)"}`);
    } else {
      console.log(`  ⚠ mode=${mint2.mode} — expected 'existing' but got '${mint2.mode}'`);
    }
  } else {
    console.log(`  ✗ mint2 failed: ${mint2.status} ${mint2.detail ?? ""}`);
  }
  console.log("");

  // ── Step 8: cleanup (unless --keep) ──
  if (keep) {
    console.log(`→ Step 8: SKIPPED (--keep) — test keys persist. Revoke manually if you want.`);
    console.log(`  step-3 key id: ${apiKey.id}`);
    console.log(`  step-3 key:    ${apiKey.key}    ← ONLY shown here. Save it if you want to reuse.`);
    if (mintedKeyId) console.log(`  step-7 deterministic key id: ${mintedKeyId} (name "instaclaw-edge-${fakeVmName}")`);
  } else {
    console.log(`→ Step 8: cleanup`);
    const revoke1 = await revokeApiKey(bearer, apiKey.id, env);
    console.log(`  step-3 revoke: ${revoke1.ok ? "✓" : `✗ status=${revoke1.status}`}`);
    if (mintedKeyId) {
      const revoke2 = await revokeApiKey(bearer, mintedKeyId, env);
      console.log(`  step-7 revoke: ${revoke2.ok ? "✓" : `✗ status=${revoke2.status}`}`);
    }
  }

  console.log("\n═══ all steps completed ═══");
  console.log("");
  console.log("Summary of empirical findings (record these in the audit doc):");
  console.log(`  - X-Tenant-Id required for /api-keys POST: ${createResult.ok ? "NO (key minted with header set; cannot distinguish required vs harmlessly-accepted from one positive)" : "(test failed at step 3)"}`);
  console.log(`  - Duplicate-name status code: ${dupResult.ok ? "NOT ENFORCED (name uniqueness off)" : `${dupResult.status}/${dupResult.httpStatus}`}`);
  console.log(`  - Events list non-empty on first eos_live_*: ${eventCount !== null ? (eventCount > 0 ? `YES (${eventCount} events)` : "NO ([] returned)") : "(unknown)"}`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(99);
});
