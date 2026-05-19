#!/usr/bin/env tsx
/**
 * OpenAI OAuth primitives test suite.
 *
 * Run: npx tsx instaclaw/scripts/_test-openai-oauth-primitives.ts
 *
 * Covers:
 *   - parseJwtClaims (with a constructed JWT matching the Phase 0 captured shape)
 *   - computeExpiresAt arithmetic
 *   - detectAccountMismatch (positive + negative)
 *   - startDeviceFlow (success, 404)
 *   - pollDeviceFlow (pending via 403/404, completed with chained exchange,
 *                     expired_token, access_denied, error)
 *   - refreshAccessToken (success, expired, reused, revoked, other,
 *                          network error)
 *
 * All HTTP calls are mocked via an injected fetch impl. No real OpenAI
 * traffic happens in this test. The Phase 0 spike verified the live
 * endpoints; this verifies our wrapper logic correctly classifies the
 * documented response shapes.
 */

import {
  startDeviceFlow,
  pollDeviceFlow,
  refreshAccessToken,
  parseJwtClaims,
  computeExpiresAt,
  detectAccountMismatch,
  OPENAI_CODEX_CLIENT_ID,
} from "../lib/openai-oauth";

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

function assertEq<T>(actual: T, expected: T, label: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    console.log(`  ✗ ${label}`);
    console.log(`     expected: ${JSON.stringify(expected)}`);
    console.log(`     actual:   ${JSON.stringify(actual)}`);
  }
}

// ─── Helpers: build synthetic JWTs and mock fetch ─────────────────────────

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf-8")
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function makeJwt(payload: Record<string, unknown>): string {
  // Header (we don't validate signature, but include for realism)
  const header = b64url({ alg: "RS256", typ: "JWT" });
  const body = b64url(payload);
  const sig = "fake-signature-not-verified";
  return `${header}.${body}.${sig}`;
}

/** Construct a JWT shaped exactly like Phase 0 captured. */
function phase0LikeJwt(plan = "plus", accountId = "acc-123", userId = "user-abc"): string {
  return makeJwt({
    "https://api.openai.com/auth": {
      chatgpt_plan_type: plan,
      chatgpt_account_id: accountId,
      chatgpt_user_id: userId,
      chatgpt_account_is_fedramp: false,
    },
    "https://api.openai.com/profile": { email: "user@example.invalid" },
    email: "user@example.invalid",
    exp: 1779144190,
    iat: 1779140590,
    iss: "https://auth.openai.com",
    aud: [OPENAI_CODEX_CLIENT_ID],
  });
}

interface MockResponseDescriptor {
  status: number;
  body: string | object;
}

function makeMockFetch(
  responses: MockResponseDescriptor[] | ((url: string, init?: RequestInit) => MockResponseDescriptor),
): typeof fetch {
  let i = 0;
  const fn = (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const u = typeof url === "string" ? url : url.toString();
    const desc = Array.isArray(responses) ? responses[i++] : responses(u, init);
    if (!desc) {
      throw new Error(`mock fetch: no response configured for ${u}`);
    }
    const bodyStr = typeof desc.body === "string" ? desc.body : JSON.stringify(desc.body);
    return new Response(bodyStr, {
      status: desc.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return fn;
}

async function main() {
console.log("\n=== openai-oauth primitives test suite ===\n");

// ─── 1. parseJwtClaims ─────────────────────────────────────────────────────
console.log("1. parseJwtClaims:");
{
  const jwt = phase0LikeJwt("plus", "acc-XYZ", "user-ABC");
  const claims = parseJwtClaims(jwt);
  assert(claims !== null, "parses a valid JWT");
  assertEq(claims?.chatgptPlanType, "plus", "extracts chatgpt_plan_type");
  assertEq(claims?.chatgptAccountId, "acc-XYZ", "extracts chatgpt_account_id");
  assertEq(claims?.chatgptUserId, "user-ABC", "extracts chatgpt_user_id");
  assertEq(claims?.chatgptAccountIsFedramp, false, "extracts chatgpt_account_is_fedramp");
  assertEq(claims?.email, "user@example.invalid", "extracts email");
  assertEq(claims?.exp, 1779144190, "extracts exp");
  assertEq(claims?.iss, "https://auth.openai.com", "extracts iss");
}
{
  // Empty / garbage / wrong-shape inputs return null cleanly.
  assert(parseJwtClaims("") === null, "empty string → null");
  assert(parseJwtClaims("not.a.jwt.has.too.many.dots") === null, "wrong-shape → null");
  assert(parseJwtClaims("only-one-part") === null, "no-dots → null");
  assert(parseJwtClaims("hdr.notbase64!!.sig") === null, "non-base64 middle → null");
}
{
  // JWT with no chatgpt_* claims (e.g., from a different provider) still parses, returns undefined for those fields.
  const minimal = makeJwt({ sub: "user-foo", iss: "https://example.com" });
  const claims = parseJwtClaims(minimal);
  assert(claims !== null, "minimal JWT parses");
  assert(claims?.chatgptPlanType === undefined, "missing plan_type → undefined");
  assert(claims?.iss === "https://example.com", "extracts non-chatgpt iss");
}

// ─── 2. computeExpiresAt ─────────────────────────────────────────────────
console.log("\n2. computeExpiresAt:");
{
  const before = Date.now();
  const expires = computeExpiresAt(3600); // 1 hour
  const after = Date.now();
  assert(expires >= before + 3_600_000 && expires <= after + 3_600_000, "1h ahead of now (±ms)");
  assert(computeExpiresAt(0) <= Date.now(), "0s == now (or earlier due to clock tick)");
  assert(computeExpiresAt(-100) <= Date.now(), "negative coerces to now/past");
}
{
  let threw = false;
  try { computeExpiresAt(Number.NaN); } catch { threw = true; }
  assert(threw, "NaN throws TypeError");
}

// ─── 3. detectAccountMismatch ────────────────────────────────────────────
console.log("\n3. detectAccountMismatch:");
{
  const claims = parseJwtClaims(phase0LikeJwt("plus", "acc-NEW", "user-NEW"));
  assertEq(
    detectAccountMismatch(claims, "acc-NEW", "user-NEW"),
    null,
    "matching accountId + userId → null",
  );
  assertEq(
    detectAccountMismatch(claims, "acc-OLD", "user-NEW"),
    "account_mismatch",
    "different accountId → account_mismatch",
  );
  assertEq(
    detectAccountMismatch(claims, "acc-NEW", "user-OLD"),
    "account_mismatch",
    "different userId → account_mismatch",
  );
  assertEq(
    detectAccountMismatch(claims, null, null),
    null,
    "nothing cached → null (first refresh)",
  );
  assertEq(
    detectAccountMismatch(null, "acc-X", "user-Y"),
    null,
    "no new claims → null",
  );
}

// ─── 4. startDeviceFlow ──────────────────────────────────────────────────
console.log("\n4. startDeviceFlow:");
{
  const fetchImpl = makeMockFetch([
    {
      status: 200,
      body: {
        device_auth_id: "DA-abc-123",
        user_code: "92PM-PLU8N",
        interval: 5,
        expires_in: 900,
      },
    },
  ]);
  const result = await startDeviceFlow({ fetchImpl });
  assertEq(result.userCode, "92PM-PLU8N", "extracts user_code");
  assertEq(result.deviceAuthId, "DA-abc-123", "extracts device_auth_id");
  assert(result.verificationUri.endsWith("/codex/device"), "verification URI ends with /codex/device");
  assertEq(result.intervalMs, 5000, "intervalMs = interval * 1000");
  assertEq(result.expiresInMs, 900_000, "expiresInMs = expires_in * 1000");
}
{
  const fetchImpl = makeMockFetch([{ status: 404, body: { error: "not_found" } }]);
  let threw: Error | null = null;
  try { await startDeviceFlow({ fetchImpl }); } catch (e) { threw = e as Error; }
  assert(threw !== null, "404 throws");
  assert(
    threw?.message.includes("not available") || threw?.message.includes("Codex"),
    "404 message mentions Codex availability",
  );
}

// ─── 5. pollDeviceFlow ───────────────────────────────────────────────────
console.log("\n5. pollDeviceFlow:");
{
  const fetchImpl = makeMockFetch([{ status: 403, body: {} }]);
  const result = await pollDeviceFlow("DA-abc", "92PM-PLU8N", { fetchImpl });
  assertEq(result.status, "pending", "403 → pending");
}
{
  const fetchImpl = makeMockFetch([{ status: 404, body: {} }]);
  const result = await pollDeviceFlow("DA-abc", "92PM-PLU8N", { fetchImpl });
  assertEq(result.status, "pending", "404 → pending");
}
{
  // Successful poll: returns auth_code + code_verifier; pollDeviceFlow internally
  // exchanges at /oauth/token. Two mocked responses needed.
  const fetchImpl = makeMockFetch([
    {
      status: 200,
      body: { authorization_code: "ac-xyz", code_verifier: "cv-abc" },
    },
    {
      status: 200,
      body: {
        access_token: phase0LikeJwt("plus", "acc-1", "user-1"),
        refresh_token: "rf-test-1",
        id_token: phase0LikeJwt("plus", "acc-1", "user-1"),
        expires_in: 864000, // 10 days, matches Phase 0
      },
    },
  ]);
  const result = await pollDeviceFlow("DA-abc", "92PM-PLU8N", { fetchImpl });
  assertEq(result.status, "completed", "200 + valid exchange → completed");
  if (result.status === "completed") {
    assert(result.tokens.accessToken.length > 0, "completed has accessToken");
    assertEq(result.tokens.refreshToken, "rf-test-1", "completed has refreshToken");
    assert(result.tokens.expiresAtMs > Date.now(), "expiresAtMs is in future");
    assertEq(result.claims?.chatgptPlanType, "plus", "claims include plan_type");
  }
}
{
  const fetchImpl = makeMockFetch([
    { status: 400, body: { error: { code: "expired_token" } } },
  ]);
  const result = await pollDeviceFlow("DA-abc", "92PM-PLU8N", { fetchImpl });
  assertEq(result.status, "expired", "expired_token error → expired");
}
{
  const fetchImpl = makeMockFetch([
    { status: 400, body: { error: { code: "access_denied" } } },
  ]);
  const result = await pollDeviceFlow("DA-abc", "92PM-PLU8N", { fetchImpl });
  assertEq(result.status, "denied", "access_denied error → denied");
}
{
  const fetchImpl = makeMockFetch([
    { status: 500, body: { error: { code: "internal_error" } } },
  ]);
  const result = await pollDeviceFlow("DA-abc", "92PM-PLU8N", { fetchImpl });
  assertEq(result.status, "error", "500 → error");
}
{
  // Successful poll but exchange fails — should surface as error
  const fetchImpl = makeMockFetch([
    {
      status: 200,
      body: { authorization_code: "ac-xyz", code_verifier: "cv-abc" },
    },
    {
      status: 400,
      body: { error: "invalid_grant" },
    },
  ]);
  const result = await pollDeviceFlow("DA-abc", "92PM-PLU8N", { fetchImpl });
  assertEq(result.status, "error", "exchange failure → error");
}

// ─── 6. refreshAccessToken ───────────────────────────────────────────────
console.log("\n6. refreshAccessToken:");
{
  const fetchImpl = makeMockFetch([
    {
      status: 200,
      body: {
        access_token: phase0LikeJwt("plus", "acc-1", "user-1"),
        refresh_token: "rf-new-1",
        id_token: phase0LikeJwt("plus", "acc-1", "user-1"),
        expires_in: 864000,
      },
    },
  ]);
  const result = await refreshAccessToken("rf-old", { fetchImpl });
  assertEq(result.status, "success", "success on 200 + complete body");
  if (result.status === "success") {
    assertEq(result.tokens.refreshToken, "rf-new-1", "returns new refresh token");
    assertEq(result.claims?.chatgptPlanType, "plus", "claims extracted from id_token");
  }
}
{
  const fetchImpl = makeMockFetch([
    { status: 401, body: { error: { code: "refresh_token_expired" } } },
  ]);
  const result = await refreshAccessToken("rf-stale", { fetchImpl });
  assertEq(result.status, "failed", "refresh_token_expired → failed");
  if (result.status === "failed") assertEq(result.reason, "expired", "reason=expired");
}
{
  const fetchImpl = makeMockFetch([
    { status: 401, body: { error: { code: "refresh_token_reused" } } },
  ]);
  const result = await refreshAccessToken("rf-reused", { fetchImpl });
  assertEq(result.status, "failed", "refresh_token_reused → failed");
  if (result.status === "failed") assertEq(result.reason, "reused", "reason=reused (PERMANENT lockout)");
}
{
  const fetchImpl = makeMockFetch([
    { status: 401, body: { error: { code: "refresh_token_invalidated" } } },
  ]);
  const result = await refreshAccessToken("rf-revoked", { fetchImpl });
  assertEq(result.status, "failed", "refresh_token_invalidated → failed");
  if (result.status === "failed") assertEq(result.reason, "revoked", "reason=revoked");
}
{
  const fetchImpl = makeMockFetch([
    { status: 401, body: { error: { code: "some_other_code" } } },
  ]);
  const result = await refreshAccessToken("rf-other", { fetchImpl });
  assertEq(result.status, "failed", "unknown 401 → failed");
  if (result.status === "failed") assertEq(result.reason, "other", "reason=other");
}
{
  // Network error: fetch throws
  const fetchImpl = (async () => {
    throw new Error("getaddrinfo ENOTFOUND auth.openai.com");
  }) as typeof fetch;
  const result = await refreshAccessToken("rf-x", { fetchImpl });
  assertEq(result.status, "failed", "network error → failed");
  if (result.status === "failed") {
    assertEq(result.reason, "other", "network error → reason=other");
    assert(result.message.includes("Network error"), "network error message clear");
  }
}
{
  // 200 but malformed body
  const fetchImpl = makeMockFetch([
    { status: 200, body: { access_token: "only-access-no-others" } },
  ]);
  const result = await refreshAccessToken("rf-x", { fetchImpl });
  assertEq(result.status, "failed", "missing fields → failed");
  if (result.status === "failed") assertEq(result.reason, "other", "missing fields → reason=other");
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
}

main().catch((err) => {
  console.error("UNCAUGHT:", err);
  process.exit(1);
});
