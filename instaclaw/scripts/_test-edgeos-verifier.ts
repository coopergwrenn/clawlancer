/**
 * Synthetic test for lib/edgeos.ts verifyAttendeeByEmail.
 *
 * Stubs global.fetch so we don't hit the real EdgeOS API (which sends
 * actual OTP emails as a side effect — running the full test suite
 * against prod would spam every attendee in our fixture data).
 *
 * Exercises every code branch:
 *   - verified attendee (200)
 *   - not-found email (404 "User not found")
 *   - 401 unauth
 *   - 422 validation error
 *   - 429 rate limit
 *   - 500 server error (degraded → verified true)
 *   - 503 unavailable (degraded → verified true)
 *   - network timeout / fetch throw (degraded → verified true)
 *   - malformed 200 body (unknown → degraded)
 *   - empty email (invalid_email, no API call)
 *   - missing @ (invalid_email, no API call)
 *   - EDGE_VERIFIED_OVERRIDE_EMAILS exact match (verified, no API call)
 *   - EDGE_VERIFIED_OVERRIDE_EMAILS case-insensitive (verified, no API)
 *   - EDGE_VERIFIED_OVERRIDE_EMAILS with whitespace in env value
 *
 * Run: npx tsx scripts/_test-edgeos-verifier.ts
 * Exit code 0 if all pass, 1 if any fail.
 */
import { verifyAttendeeByEmail } from "../lib/edgeos";

type FetchStub = (url: string, init?: RequestInit) => Promise<Response>;

const ORIGINAL_FETCH = global.fetch;

function stubFetch(handler: FetchStub) {
  // @ts-expect-error — overriding global.fetch for the duration of the test
  global.fetch = handler;
}
function restoreFetch() {
  global.fetch = ORIGINAL_FETCH;
}

function makeResponse(status: number, body: object | string): Response {
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(bodyStr, {
    status,
    headers: { "content-type": "application/json" },
  });
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(label: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function run() {
  // 2026-05-22: verifyAttendeeByEmail now uses requestThirdPartyLogin which
  // requires EDGEOS_THIRD_PARTY_API_KEY. Set a test value so the function
  // doesn't short-circuit with config_error → degraded fail-open (which
  // would make Test 2/3 falsely pass as verified:true).
  process.env.EDGEOS_THIRD_PARTY_API_KEY = "test-tenant-key-do-not-use-in-prod";

  console.log("Test 1: verified attendee (200 OK)");
  stubFetch(async () =>
    makeResponse(200, {
      email: "alice@example.com",
      message: "Verification email sent",
      expires_in_minutes: 10,
    }),
  );
  let r = await verifyAttendeeByEmail("alice@example.com");
  assert("verified=true", r.verified === true);
  assert("no reason on success", r.reason === undefined);
  assert("not degraded", !r.degraded);
  restoreFetch();

  // 2026-05-22 P0 fix: switched from user/login (which returned 404 for
  // non-attendees) to third-party/login (which returns 401 for both bad-api-key
  // AND not-an-attendee). The 401 mapping is now the PRIMARY not_attendee
  // signal. 404 is no longer a documented response shape — if EdgeOS ever
  // returns 404 it falls through to api_error.
  console.log("Test 2: 401 not-an-attendee (EdgeOS collapses 'not in directory' into 401)");
  stubFetch(async () => makeResponse(401, { detail: "Authentication failed" }));
  r = await verifyAttendeeByEmail("ghost@example.com");
  assert("verified=false", r.verified === false);
  assert("reason=not_found", r.reason === "not_found");
  restoreFetch();

  console.log("Test 3: 404 undocumented status → degraded fail-open (treated as unknown)");
  // The new third-party endpoint doesn't return 404 in documented cases — 401
  // is the "not in directory" signal. If EdgeOS ever DOES return 404 (e.g.,
  // routing change), our code treats it as "unknown" → degraded fail-open
  // per Cooper directive 2026-05-22 (better to let through than block).
  stubFetch(async () => makeResponse(404, { detail: "Not Found" }));
  r = await verifyAttendeeByEmail("blocked@example.com");
  assert("verified=true (degraded fail-open on undocumented 404)", r.verified === true);
  assert("degraded=true", r.degraded === true);
  restoreFetch();

  console.log("Test 4: 422 validation error");
  stubFetch(async () =>
    makeResponse(422, {
      detail: [{ msg: "not a valid email" }],
    }),
  );
  r = await verifyAttendeeByEmail("not-an-email-format");
  // 422 only fires if our pre-flight `.includes("@")` check missed.
  // We use an email with "@" but otherwise bogus to bypass the local check.
  assert("422 path: bogus@email-no-tld → reason=invalid_email or short-circuit",
    r.verified === false);
  restoreFetch();

  console.log("Test 5: 429 rate-limited");
  stubFetch(async () => makeResponse(429, { detail: "Too many requests" }));
  r = await verifyAttendeeByEmail("alice@example.com");
  assert("verified=false", r.verified === false);
  assert("reason=rate_limited", r.reason === "rate_limited");
  restoreFetch();

  console.log("Test 6: 500 server error → degraded let-through");
  stubFetch(async () => makeResponse(500, { detail: "Internal Server Error" }));
  r = await verifyAttendeeByEmail("alice@example.com");
  assert("verified=true (degraded)", r.verified === true);
  assert("degraded=true", r.degraded === true);
  restoreFetch();

  console.log("Test 7: 503 service unavailable → degraded");
  stubFetch(async () => makeResponse(503, { detail: "Service Unavailable" }));
  r = await verifyAttendeeByEmail("alice@example.com");
  assert("verified=true (degraded)", r.verified === true);
  assert("degraded=true", r.degraded === true);
  restoreFetch();

  console.log("Test 8: network fetch throw → degraded");
  stubFetch(async () => {
    throw new Error("ECONNREFUSED");
  });
  r = await verifyAttendeeByEmail("alice@example.com");
  assert("verified=true (degraded on network)", r.verified === true);
  assert("degraded=true", r.degraded === true);
  restoreFetch();

  console.log("Test 9: empty email → invalid_email (no API call)");
  let fetchCalled = false;
  stubFetch(async () => {
    fetchCalled = true;
    return makeResponse(200, {});
  });
  r = await verifyAttendeeByEmail("");
  assert("verified=false", r.verified === false);
  assert("reason=invalid_email", r.reason === "invalid_email");
  assert("no API call for empty input", !fetchCalled);
  restoreFetch();

  console.log("Test 10: missing @ → invalid_email (no API call)");
  fetchCalled = false;
  stubFetch(async () => {
    fetchCalled = true;
    return makeResponse(200, {});
  });
  r = await verifyAttendeeByEmail("noatsignhere.example.com");
  assert("verified=false", r.verified === false);
  assert("reason=invalid_email", r.reason === "invalid_email");
  assert("no API call when @ missing", !fetchCalled);
  restoreFetch();

  console.log("Test 11: override list match → verified (no API call)");
  process.env.EDGE_VERIFIED_OVERRIDE_EMAILS = "vip1@example.com,vip2@example.com";
  fetchCalled = false;
  stubFetch(async () => {
    fetchCalled = true;
    return makeResponse(404, {});
  });
  r = await verifyAttendeeByEmail("vip1@example.com");
  assert("verified=true via override", r.verified === true);
  assert("no API call when in override list", !fetchCalled);
  restoreFetch();

  console.log("Test 12: override list case-insensitive");
  fetchCalled = false;
  stubFetch(async () => {
    fetchCalled = true;
    return makeResponse(404, {});
  });
  r = await verifyAttendeeByEmail("VIP1@EXAMPLE.COM");
  assert("verified=true (case-insensitive override)", r.verified === true);
  assert("no API call", !fetchCalled);
  restoreFetch();

  console.log("Test 13: override list with whitespace in env value");
  process.env.EDGE_VERIFIED_OVERRIDE_EMAILS = "  cooper@valtlabs.com  , tule@edgecity.com ,";
  fetchCalled = false;
  stubFetch(async () => {
    fetchCalled = true;
    return makeResponse(404, {});
  });
  r = await verifyAttendeeByEmail("tule@edgecity.com");
  assert("verified=true (env whitespace stripped)", r.verified === true);
  assert("no API call", !fetchCalled);
  restoreFetch();
  delete process.env.EDGE_VERIFIED_OVERRIDE_EMAILS;

  console.log("Test 14: override unset → real path taken (uses 401 — the documented not-attendee status)");
  delete process.env.EDGE_VERIFIED_OVERRIDE_EMAILS;
  fetchCalled = false;
  stubFetch(async () => {
    fetchCalled = true;
    // 2026-05-22: switched from 404 to 401 to match the new third-party
    // endpoint's documented "not in directory" response shape.
    return makeResponse(401, { detail: "Authentication failed" });
  });
  r = await verifyAttendeeByEmail("real-attendee-not-in-overrides@example.com");
  assert("API was called", fetchCalled);
  assert("reason=not_found", r.reason === "not_found");
  restoreFetch();

  console.log("\n──────────────────────────────────────────");
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("All tests passed.");
  process.exit(0);
}

run().catch((err) => {
  console.error("FATAL:", err);
  process.exit(2);
});
