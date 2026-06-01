/**
 * Synthetic tests for lib/toolrouter-client.ts.
 *
 * Run: npx tsx scripts/_test-toolrouter-client.ts
 *
 * Covers (PRD §7.1 Task A.2 acceptance):
 *   - getToolRouterEnv() — 5 env-var permutations
 *   - buildToolRouterMcpConfig() — stdio + streamable-http shapes, trailing-slash, shape errors
 *   - verifyToolRouterApiKey() — 8 fetch outcomes via global.fetch mock
 *
 * Total: 25 assertions. Mocks process.env and global.fetch; restores after
 * each scenario. No network calls.
 */

import {
  buildToolRouterMcpConfig,
  getToolRouterEnv,
  verifyToolRouterApiKey,
  type VerifyToolRouterResult,
} from "../lib/toolrouter-client";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function assert(cond: boolean, msg: string): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
  assert(actual === expected, `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const VALID_KEY = "tr_abcdefghijklmnop1234567890";
const TOO_SHORT = "tr_abc";
const NO_PREFIX = "abcdefghijklmnop1234567890";
const PLACEHOLDER = "tr_PLACEHOLDER_AWAITING_ANDY";

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const originalFetch = global.fetch;
function mockFetch(impl: typeof fetch): void {
  global.fetch = impl as typeof fetch;
}
function restoreFetch(): void {
  global.fetch = originalFetch;
}

/** Two-endpoint mock — verifier hits /health then /v1/endpoints. */
function mockTwoEndpoints(healthStatus: number, authStatus: number, authBody = ""): void {
  mockFetch(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    if (url.endsWith("/health")) {
      return new Response("ok", { status: healthStatus });
    }
    return new Response(authBody, { status: authStatus });
  });
}

async function run(): Promise<void> {
  console.log("─── getToolRouterEnv ───");

  await Promise.resolve(
    withEnv({ TOOLROUTER_API_KEY: undefined, TOOLROUTER_API_URL: undefined }, () => {
      assertEq(getToolRouterEnv(), null, "unset env returns null");
    }),
  );

  withEnv({ TOOLROUTER_API_KEY: "", TOOLROUTER_API_URL: undefined }, () => {
    assertEq(getToolRouterEnv(), null, "empty string returns null");
  });

  withEnv({ TOOLROUTER_API_KEY: NO_PREFIX, TOOLROUTER_API_URL: undefined }, () => {
    assertEq(getToolRouterEnv(), null, "missing tr_ prefix returns null");
  });

  withEnv({ TOOLROUTER_API_KEY: TOO_SHORT, TOOLROUTER_API_URL: undefined }, () => {
    assertEq(getToolRouterEnv(), null, "too-short key returns null");
  });

  withEnv({ TOOLROUTER_API_KEY: `${VALID_KEY}\n`, TOOLROUTER_API_URL: undefined }, () => {
    const env = getToolRouterEnv();
    assert(env !== null, "trailing-newline key trims and passes shape (Rule 6)");
    assertEq(env?.apiKey, VALID_KEY, "trailing-newline value trimmed");
  });

  withEnv({ TOOLROUTER_API_KEY: VALID_KEY, TOOLROUTER_API_URL: undefined }, () => {
    const env = getToolRouterEnv();
    assert(env !== null, "valid key + no URL: returns env");
    assertEq(env?.apiKey, VALID_KEY, "apiKey echoed back");
    assertEq(env?.apiUrl, "https://toolrouter.world", "defaults to toolrouter.world");
  });

  withEnv(
    { TOOLROUTER_API_KEY: VALID_KEY, TOOLROUTER_API_URL: "https://toolrouter.world/" },
    () => {
      const env = getToolRouterEnv();
      assertEq(env?.apiUrl, "https://toolrouter.world", "trailing slash stripped from URL");
    },
  );

  withEnv({ TOOLROUTER_API_KEY: "tr_value with space", TOOLROUTER_API_URL: undefined }, () => {
    assertEq(getToolRouterEnv(), null, "value with space fails shape (catches paste accidents)");
  });

  console.log("─── buildToolRouterMcpConfig ───");

  const stdio = buildToolRouterMcpConfig(VALID_KEY, "stdio");
  assert("command" in stdio, "stdio shape has command field");
  if ("command" in stdio) {
    assertEq(stdio.command, "toolrouter", "stdio command is 'toolrouter'");
    assertEq(stdio.args.length, 0, "stdio args is empty");
    assertEq(stdio.env.TOOLROUTER_API_KEY, VALID_KEY, "stdio env carries API key");
    assertEq(stdio.env.TOOLROUTER_API_URL, "https://toolrouter.world", "stdio env carries default URL");
  }

  const sh = buildToolRouterMcpConfig(VALID_KEY, "streamable-http");
  assert("transport" in sh, "streamable-http shape has transport field");
  if ("transport" in sh) {
    assertEq(sh.transport, "streamable-http", "transport is streamable-http");
    assertEq(sh.url, "https://toolrouter.world/mcp", "URL is /mcp");
    assertEq(sh.headers.Authorization, `Bearer ${VALID_KEY}`, "header has Bearer prefix");
    assertEq(sh.connectionTimeoutMs, 5000, "connectionTimeoutMs is 5000");
  }

  const stdioCustomUrl = buildToolRouterMcpConfig(VALID_KEY, "stdio", "https://staging.toolrouter.world/");
  if ("command" in stdioCustomUrl) {
    assertEq(
      stdioCustomUrl.env.TOOLROUTER_API_URL,
      "https://staging.toolrouter.world",
      "custom URL: trailing slash stripped",
    );
  }

  try {
    buildToolRouterMcpConfig(NO_PREFIX, "stdio");
    fail++;
    failures.push("buildToolRouterMcpConfig with malformed key should throw");
    console.error("  ✗ buildToolRouterMcpConfig with malformed key should throw");
  } catch (e: unknown) {
    assert(e instanceof Error, "buildToolRouterMcpConfig throws on malformed key");
  }

  console.log("─── verifyToolRouterApiKey ───");

  let r: VerifyToolRouterResult;

  r = await verifyToolRouterApiKey("");
  assertEq(r.status, "not_configured", "empty value: not_configured");
  assertEq(r.ok, false, "empty value: ok=false");

  r = await verifyToolRouterApiKey(NO_PREFIX);
  assertEq(r.status, "shape_invalid", "no-prefix value: shape_invalid");
  assert(!!r.error, "shape_invalid: error message populated");

  r = await verifyToolRouterApiKey(TOO_SHORT);
  assertEq(r.status, "shape_invalid", "too-short value: shape_invalid");

  // PLACEHOLDER passes shape (24 chars alphanumeric+underscore). The
  // real-world rejection happens server-side at /v1/endpoints with 401.
  mockTwoEndpoints(200, 401, "Unauthorized: invalid api key");
  r = await verifyToolRouterApiKey(PLACEHOLDER);
  assertEq(r.status, "auth_failed", "PLACEHOLDER passes shape but smoke-test 401s");
  assertEq(r.http_code, 401, "PLACEHOLDER: http_code=401 surfaced");

  mockTwoEndpoints(200, 200);
  r = await verifyToolRouterApiKey(VALID_KEY);
  assertEq(r.status, "ok", "happy path: /health 200 + /v1/endpoints 200 → ok");
  assertEq(r.http_code, 200, "ok: http_code=200");
  assertEq(r.ok, true, "ok: ok=true");

  mockTwoEndpoints(200, 401, "Unauthorized");
  r = await verifyToolRouterApiKey(VALID_KEY);
  assertEq(r.status, "auth_failed", "/health up + /v1/endpoints 401 → auth_failed");
  assertEq(r.http_code, 401, "401 response: http_code=401");
  assertEq(r.body_prefix, "Unauthorized", "401 response: body_prefix populated");

  mockTwoEndpoints(200, 403, "Forbidden");
  r = await verifyToolRouterApiKey(VALID_KEY);
  assertEq(r.status, "auth_failed", "403 response: auth_failed (same bucket as 401)");

  mockTwoEndpoints(500, 200);
  r = await verifyToolRouterApiKey(VALID_KEY);
  assertEq(r.status, "endpoint_5xx", "/health 500 → endpoint_5xx (short-circuits before auth)");
  assertEq(r.http_code, 500, "/health 5xx http_code surfaced");

  mockTwoEndpoints(200, 502);
  r = await verifyToolRouterApiKey(VALID_KEY);
  assertEq(r.status, "endpoint_5xx", "/v1/endpoints 502 → endpoint_5xx");

  mockTwoEndpoints(200, 418, "I'm a teapot");
  r = await verifyToolRouterApiKey(VALID_KEY);
  assertEq(r.status, "endpoint_other", "/v1/endpoints 418 → endpoint_other");
  assertEq(r.http_code, 418, "418 response: http_code=418");
  assertEq(r.body_prefix, "I'm a teapot", "418 response: body_prefix populated");

  // /health returning unexpected non-5xx, non-401/403 (e.g. 503 maintenance)
  mockTwoEndpoints(503, 200);
  r = await verifyToolRouterApiKey(VALID_KEY);
  assertEq(r.status, "endpoint_5xx", "/health 503 → endpoint_5xx");

  mockFetch(async () => {
    throw new TypeError("fetch failed: connection refused");
  });
  r = await verifyToolRouterApiKey(VALID_KEY);
  assertEq(r.status, "unreachable", "network error: unreachable");
  assert(!!r.error && r.error.includes("fetch failed"), "unreachable: error message populated");

  mockFetch(async () => {
    throw new DOMException("The operation was aborted", "AbortError");
  });
  r = await verifyToolRouterApiKey(VALID_KEY);
  assertEq(r.status, "unreachable", "timeout/abort: unreachable");

  restoreFetch();

  // ─── Summary ───
  console.log("");
  console.log(`${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

run().catch((e) => {
  console.error("test harness crashed:", e);
  process.exit(2);
});
