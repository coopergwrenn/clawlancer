/**
 * Decision-level tests for the x402 deterministic-nonce idempotency — the
 * B-window fix (2026-06-11 book-path audit). Hermetic, no network.
 *
 * Proves: (1) the nonce is deterministic per request_id + domain-separated (so a
 * retry re-submits the IDENTICAL authorization → on-chain exactly-once via USDC
 * authorizationState); (2) the --retry book-status verdict for ALL FOUR retry
 * timings from the audit drives the correct re-pay decision.
 *
 * Run: npx tsx scripts/_test-x402-nonce-idempotency.ts
 */
import { createHash } from "node:crypto";
import { nonceForRequest } from "../skills/frontier/scripts/frontier-spend-core.mjs";
import { bookStatusVerdict } from "../skills/travala/scripts/travala-book.mjs";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ""}`); }
}

function run() {
  console.log("\n── nonceForRequest: determinism + domain separation (the on-chain idempotency guard) ──");
  const rid = "req_abc123";
  const w = "0xWALLETabcDEF0000000000000000000000000000";
  ok("deterministic — same (request_id, wallet) → same nonce (retry re-submits identical auth)", nonceForRequest(rid, w) === nonceForRequest(rid, w));
  ok("different request_id → different nonce", nonceForRequest(rid, w) !== nonceForRequest("req_other", w));
  ok("different wallet → different nonce", nonceForRequest(rid, w) !== nonceForRequest(rid, "0xOTHER000000000000000000000000000000000000"));
  ok("wallet case-insensitive (lowercased before hashing)", nonceForRequest(rid, "0xABCdef0000000000000000000000000000000000") === nonceForRequest(rid, "0xabcDEF0000000000000000000000000000000000"));
  ok("format: 0x + 64 hex = bytes32", /^0x[0-9a-f]{64}$/.test(nonceForRequest(rid, w)));
  const noPrefix = "0x" + createHash("sha256").update(`${rid}:${w.toLowerCase()}`).digest("hex");
  ok("domain-separated — the fixed prefix IS in the hash input (can't collide with a bare sha256(request_id:wallet))", nonceForRequest(rid, w) !== noPrefix);
  ok("throws on missing inputs (no silent empty-nonce)", (() => { try { nonceForRequest("", w); return false; } catch { return true; } })());

  console.log("\n── bookStatusVerdict: the FOUR retry timings → re-pay decision ──");
  // response-lost: the pay landed on-chain but the HTTP response was lost; Travala
  // has the booking → status confirms → DON'T re-pay.
  ok("response-lost (status confirmed) → 'confirmed' → no re-pay", bookStatusVerdict('{"interpretation":"completed","body":"Booking confirmed MN5V9DWQ"}') === "confirmed");
  // settled-but-unconfirmed: on-chain settled, Travala's status lags → 'in_progress'
  // → DON'T re-pay (and the nonce makes it safe if we ever did).
  ok("settled-but-unconfirmed (status in_progress) → 'in_progress' → no re-pay (pending)", bookStatusVerdict('{"interpretation":"in_progress"}') === "in_progress");
  // in-flight: the original pay is still processing → 'in_progress' → no re-pay.
  ok("in-flight (status processing) → 'in_progress' → no re-pay", bookStatusVerdict('{"status":"processing, awaiting settlement"}') === "in_progress");
  // orphaned-hold: authorize reserved budget, the pay never took → no booking →
  // 'not_found' → SAFE to re-pay (same nonce makes even a late first attempt a no-op).
  ok("orphaned-hold (status not_found) → 'not_found' → safe to re-pay", bookStatusVerdict('{"interpretation":"not_found"}') === "not_found");
  ok("empty/garbage status → 'in_progress' (conservative: no re-pay)", bookStatusVerdict("") === "in_progress" && bookStatusVerdict(null as unknown as string) === "in_progress");

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

run();
