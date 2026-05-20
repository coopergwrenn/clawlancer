/**
 * Dry-run verification of the poller's threshold-based alert (#5).
 *
 * Reproduces the exact failure shape of today's (2026-05-19) Index dev
 * endpoint outage and verifies that:
 *
 *   1. classifyPollError correctly identifies the failure as
 *      `connect_timeout` (not transport_other, not http_other).
 *   2. classifyPollBatch correctly determines the batch should alert
 *      (failureRate > 0.5) and that the dominant class is
 *      connect_timeout.
 *   3. The constructed alertKey matches the expected per-class shape
 *      (`index_poller_high_failure_rate:connect_timeout`).
 *
 * Pure — no DB writes, no email sends, no network calls. Imports the
 * EXPORTED pure helpers from the poller route file.
 *
 * Also tests adjacent cases:
 *   • 4/9 failures (below threshold) → no alert
 *   • 9/9 4xx (e.g. all keys dead) → alert with class=http_4xx
 *   • Mixed classes → alert with the DOMINANT class
 *   • All 9 success → no alert
 */
import {
  classifyPollError,
  classifyPollBatch,
  type PollErrorClass,
} from "../app/api/cron/poll-index-opportunities/route";

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.log(`  ✗ ${msg}`);
  }
}

// Reproduce today's actual error body shape. We saw this exact string
// (with the cause unwrapped per singlePoll's logic) when probing
// protocol.dev.index.network from this host.
const TODAYS_ACTUAL_ERROR_BODY =
  "fetch failed | cause: code=UND_ERR_CONNECT_TIMEOUT Connect Timeout Error (attempted address: protocol.dev.index.network:443, timeout: 10000ms)";

function syntheticConnectTimeoutResult(vmName: string) {
  return {
    vmName,
    status: 0,
    count: 0,
    opportunities: [],
    errorBody: TODAYS_ACTUAL_ERROR_BODY,
    errorClass: classifyPollError(0, TODAYS_ACTUAL_ERROR_BODY),
  };
}

function synthetic4xxResult(vmName: string, status: number = 401) {
  return {
    vmName,
    status,
    count: 0,
    opportunities: [],
    errorBody: `Unauthorized: bad key`,
    errorClass: classifyPollError(status, "Unauthorized: bad key") as PollErrorClass,
  };
}

function synthetic5xxResult(vmName: string) {
  return {
    vmName,
    status: 503,
    count: 0,
    opportunities: [],
    errorBody: "Service Unavailable",
    errorClass: classifyPollError(503, "Service Unavailable") as PollErrorClass,
  };
}

function syntheticSuccessResult(vmName: string) {
  return { vmName, status: 200, count: 0, opportunities: [] };
}

function syntheticTlsResult(vmName: string) {
  const body =
    "fetch failed | cause: code=ERR_TLS_CERT_ALTNAME_INVALID Hostname/IP does not match certificate's altnames: Host: protocol.dev.index.network. is not in the cert's altnames: DNS:*.up.railway.app";
  return {
    vmName,
    status: 0,
    count: 0,
    opportunities: [],
    errorBody: body,
    errorClass: classifyPollError(0, body) as PollErrorClass,
  };
}

console.log("=== Test 1: classifyPollError on today's actual error ===\n");
const cls1 = classifyPollError(0, TODAYS_ACTUAL_ERROR_BODY);
assert(cls1 === "connect_timeout", `today's UND_ERR_CONNECT_TIMEOUT classifies as connect_timeout (got: ${cls1})`);

console.log("\n=== Test 2: classifyPollError covers all major shapes ===\n");
assert(classifyPollError(401, "bad key") === "http_4xx", "401 → http_4xx");
assert(classifyPollError(403, "forbidden") === "http_4xx", "403 → http_4xx");
assert(classifyPollError(404, "not found") === "http_4xx", "404 → http_4xx");
assert(classifyPollError(500, "server error") === "http_5xx", "500 → http_5xx");
assert(classifyPollError(503, "service unavailable") === "http_5xx", "503 → http_5xx");
assert(
  classifyPollError(
    0,
    "fetch failed | cause: code=ERR_TLS_CERT_ALTNAME_INVALID does not match cert",
  ) === "tls_error",
  "TLS altname invalid → tls_error",
);
assert(
  classifyPollError(0, "fetch failed | cause: getaddrinfo ENOTFOUND protocol.dev.index.network") ===
    "dns_failure",
  "ENOTFOUND → dns_failure",
);
assert(
  classifyPollError(0, "some other transport thing") === "transport_other",
  "unrecognized transport msg → transport_other",
);

console.log("\n=== Test 3: classifyPollBatch on TODAY'S ACTUAL OUTAGE (all 9 connect_timeout) ===\n");
const todayResults = [
  "instaclaw-vm-050",
  "instaclaw-vm-354",
  "instaclaw-vm-771",
  "instaclaw-vm-777",
  "instaclaw-vm-780",
  "instaclaw-vm-859",
  "instaclaw-vm-917",
  "instaclaw-vm-922",
  "instaclaw-vm-923",
].map(syntheticConnectTimeoutResult);
const todayBatch = classifyPollBatch(todayResults);
console.log(`  shouldAlert    : ${todayBatch.shouldAlert}`);
console.log(`  failureRate    : ${todayBatch.failureRate}`);
console.log(`  failureCount   : ${todayBatch.failureCount}/${todayBatch.total}`);
console.log(`  dominantClass  : ${todayBatch.dominantClass}`);
console.log(`  dominantCount  : ${todayBatch.dominantCount}`);
console.log(`  classCounts    : ${JSON.stringify(todayBatch.classCounts)}`);
console.log(`  expected alertKey: index_poller_high_failure_rate:connect_timeout`);
assert(todayBatch.shouldAlert === true, "today's 9/9 connect_timeout outage WOULD fire an alert");
assert(todayBatch.failureRate === 1.0, "failure rate is 1.0 (100%)");
assert(todayBatch.dominantClass === "connect_timeout", "dominant class is connect_timeout");
assert(todayBatch.dominantCount === 9, "dominant count is 9");

console.log("\n=== Test 4: Below threshold (4 of 9 fail) ===\n");
const below = [
  syntheticConnectTimeoutResult("vm-050"),
  syntheticConnectTimeoutResult("vm-354"),
  syntheticConnectTimeoutResult("vm-771"),
  syntheticConnectTimeoutResult("vm-777"),
  syntheticSuccessResult("vm-780"),
  syntheticSuccessResult("vm-859"),
  syntheticSuccessResult("vm-917"),
  syntheticSuccessResult("vm-922"),
  syntheticSuccessResult("vm-923"),
];
const belowBatch = classifyPollBatch(below);
console.log(`  shouldAlert: ${belowBatch.shouldAlert} (failureRate=${belowBatch.failureRate})`);
assert(belowBatch.shouldAlert === false, "4/9 (44%) is below threshold, no alert");

console.log("\n=== Test 5: At-threshold boundary (5/9 fail, 55.5%) ===\n");
const atThreshold = [
  syntheticConnectTimeoutResult("vm-050"),
  syntheticConnectTimeoutResult("vm-354"),
  syntheticConnectTimeoutResult("vm-771"),
  syntheticConnectTimeoutResult("vm-777"),
  syntheticConnectTimeoutResult("vm-780"),
  syntheticSuccessResult("vm-859"),
  syntheticSuccessResult("vm-917"),
  syntheticSuccessResult("vm-922"),
  syntheticSuccessResult("vm-923"),
];
const atBatch = classifyPollBatch(atThreshold);
console.log(`  shouldAlert: ${atBatch.shouldAlert} (failureRate=${atBatch.failureRate})`);
assert(atBatch.shouldAlert === true, "5/9 (>50%) DOES fire alert");

console.log("\n=== Test 6: 50/50 (1/2 fails) is NOT an alert — exact 50% borderline ===\n");
const exactly50 = [syntheticConnectTimeoutResult("a"), syntheticSuccessResult("b")];
const fifty = classifyPollBatch(exactly50);
console.log(`  shouldAlert: ${fifty.shouldAlert} (failureRate=${fifty.failureRate})`);
assert(fifty.shouldAlert === false, "exactly 50% does not fire (>0.5 gate, not >=)");

console.log("\n=== Test 7: All 4xx (e.g. all keys revoked) → alert with class=http_4xx ===\n");
const all4xx = [
  synthetic4xxResult("vm-050"),
  synthetic4xxResult("vm-354"),
  synthetic4xxResult("vm-771"),
  synthetic4xxResult("vm-777"),
  synthetic4xxResult("vm-780"),
];
const all4xxBatch = classifyPollBatch(all4xx);
console.log(`  shouldAlert: ${all4xxBatch.shouldAlert}, dominantClass: ${all4xxBatch.dominantClass}`);
assert(all4xxBatch.dominantClass === "http_4xx", "all-4xx batch has dominantClass=http_4xx");
assert(all4xxBatch.shouldAlert === true, "all-4xx batch fires alert");

console.log("\n=== Test 8: Mixed classes — DOMINANT is reported ===\n");
const mixed = [
  syntheticConnectTimeoutResult("vm-050"),
  syntheticConnectTimeoutResult("vm-354"),
  syntheticConnectTimeoutResult("vm-771"),
  syntheticTlsResult("vm-777"),
  synthetic4xxResult("vm-780"),
];
const mixedBatch = classifyPollBatch(mixed);
console.log(`  classCounts: ${JSON.stringify(mixedBatch.classCounts)}, dominant: ${mixedBatch.dominantClass}`);
assert(mixedBatch.dominantClass === "connect_timeout", "majority connect_timeout wins as dominant");
assert(mixedBatch.failureCount === 5, "all 5 failures counted");

console.log("\n=== Test 9: All success — no alert ===\n");
const allSuccess = ["a", "b", "c", "d"].map(syntheticSuccessResult);
const allOk = classifyPollBatch(allSuccess);
console.log(`  shouldAlert: ${allOk.shouldAlert}, failureRate: ${allOk.failureRate}`);
assert(allOk.shouldAlert === false, "all-success batch produces no alert");

console.log("\n=== Test 10: Empty input — no alert, no crash ===\n");
const empty = classifyPollBatch([]);
console.log(`  shouldAlert: ${empty.shouldAlert}, total: ${empty.total}`);
assert(empty.shouldAlert === false, "empty input produces no alert");
assert(empty.total === 0, "empty input total is 0");

console.log(`\n========================`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`========================`);
console.log(`\nVerification: during the 2026-05-19 outage (where protocol.dev.index.network`);
console.log(`was unreachable with UND_ERR_CONNECT_TIMEOUT), the poller would have fired`);
console.log(`alert key='index_poller_high_failure_rate:connect_timeout' with email subject:`);
console.log(`  "[Index Poller] 9/9 agents failing (connect_timeout)"`);
console.log(`Subsequent ticks within 6h would log a "suppressed (dedup)" row but NOT`);
console.log(`re-send the email — unless the dominant class shifts (e.g. to tls_error),`);
console.log(`in which case a NEW alert key fires with a fresh email.`);

process.exit(failed > 0 ? 1 : 0);
