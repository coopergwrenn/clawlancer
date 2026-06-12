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
import { bookStatusVerdict, denyNarrationFor, isRevokedSettleConflict, parseSnapshotArg } from "../skills/travala/scripts/travala-book.mjs";

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

  console.log("\n── denyNarrationFor: every deny tells the TRUE state + TRUE remedy (GAP-1) ──");
  const killN = denyNarrationFor("spend_kill_switch", 50);
  ok("kill switch → 'paused by the platform operator', NOT a limit claim", killN.includes("paused by the platform operator") && !killN.includes("over your travel spending limit"));
  const killUnv = denyNarrationFor("spend_kill_switch_unverifiable", 50);
  ok("kill unverifiable → precautionary-pause copy, NOT a limit claim", killUnv.includes("pauses spending as a precaution") && !killUnv.includes("over your travel spending limit"));
  // spend_not_enabled is UNREACHABLE for travel post-decouple (2026-06-12) —
  // reachable only against a stale pre-decouple server. The narration must be
  // honest about the unknown AND must NEVER send a hotel-booker to enable the
  // autonomous-spending switch (the exact conflation the decouple removed).
  const offN = denyNarrationFor("spend_not_enabled", 50);
  ok("spend_not_enabled → honest generic + dashboard pointer, no charge", offN.includes("Nothing was charged") && offN.includes("dashboard"));
  ok("spend_not_enabled → never instructs enabling autonomous spending", !offN.includes("Turn it on") && !offN.includes("autonomous spending is turned off"));
  const consN = denyNarrationFor("request_id_consumed", 50, "revoked");
  ok("request_id_consumed → 'already finalized' + surfaces consumed_status + no-recharge", consN.includes("already finalized") && consN.includes("revoked") && consN.includes("NOT charged you again"));
  const limN = denyNarrationFor("travel_ceiling_exceeded", 50);
  ok("limit-class default → keeps the original limit copy", limN.includes("over your travel spending limit (travel_ceiling_exceeded)"));

  // THE FUNDING ASK (Finding 2) — motivation first, exact need, exact path, no charge, no shame.
  const W = "0xd998a6dc14e5ec290b2a9f201d6a6c82a1dd38c4";
  const fundN = denyNarrationFor("would_drain_wallet", 84.5, undefined, W);
  ok("funding ask → leads with the found room (motivation first)", fundN.startsWith("I found your room."));
  ok("funding ask → exact need with cushion ($86 for an $84.50 room)", fundN.includes("about $86 USDC on Base"));
  ok("funding ask → FULL send-to address (copyable in one step, never truncated)", fundN.includes(W));
  ok("funding ask → dashboard path named", /dashboard under Wallet/i.test(fundN));
  ok("funding ask → no limit claim, no shame word", !/limit|unfortunately|sorry/i.test(fundN));
  const fundNoW = denyNarrationFor("would_drain_wallet", 84.5, undefined, undefined);
  ok("funding ask without wallet in env → still actionable via dashboard", /dashboard under Wallet/i.test(fundNoW) && !fundNoW.includes("undefined"));

  // category_not_allowed (Q1 REVERSED 2026-06-12: travel open to all tiers; the
  // Pro-paywall copy retired). Branch stays reachable via tightened per-VM
  // category overrides → an honest generic, NEVER a tier or limit claim.
  const proN = denyNarrationFor("category_not_allowed", 84.5);
  ok("category-off → honest generic, no tier claim, no Pro upsell", !/pro plan|billing|upgrade/i.test(proN) && proN.includes("switched off"));
  ok("category-off → names the path (spending settings) + no shame/limit words", /Spending settings/i.test(proN) && !/unfortunately|sorry|limit/i.test(proN));

  ok("every deny narration says nothing-was-charged or no-recharge", [killN, killUnv, offN, consN, fundN, proN].every((n) => /nothing was charged|not charged you again/i.test(n)));

  console.log("\n── isRevokedSettleConflict: the revoked-but-paid collision detector ──");
  ok("409 + 'hold is now revoked' → true", isRevokedSettleConflict(409, { error: "hold is now revoked; cannot settle as success" }) === true);
  ok("409 + other conflict (settled race) → false", isRevokedSettleConflict(409, { error: "hold is now success; cannot settle as failed" }) === false);
  ok("200 ok → false", isRevokedSettleConflict(200, { ok: true }) === false);
  ok("missing body → false (no crash)", isRevokedSettleConflict(409, undefined) === false);

  console.log("\n── tracker #8: parseSnapshotArg — bad snapshots are LOUD, good ones are quiet ──");
{
  const good = parseSnapshotArg(JSON.stringify({ hotelName: "memmo alfama", freeCancellationUntilUtc: "2026-06-24T15:00:00Z" }));
  ok("valid snapshot → parsed, NOT flagged (no crying wolf)", good.ignored === false && good.snapshot?.hotelName === "memmo alfama");
  const absent = parseSnapshotArg(undefined);
  ok("absent snapshot → quiet (caller chose not to pass one)", absent.ignored === false && absent.snapshot === undefined);
  ok("empty-string snapshot → quiet", parseSnapshotArg("").ignored === false);
  const bad = parseSnapshotArg("{hotelName: memmo");  // the silent-degrade case the tracker named
  ok("malformed JSON → FLAGGED + snapshot dropped", bad.ignored === true && bad.snapshot === undefined);
  ok("valid-JSON-but-not-an-object (\"42\") → FLAGGED (would record junk)", parseSnapshotArg("42").ignored === true);
  ok("\"null\" → FLAGGED", parseSnapshotArg("null").ignored === true);
  ok("a JSON array → FLAGGED (record expects an object)", parseSnapshotArg("[1,2]").ignored === true);
  ok("quoted string → FLAGGED", parseSnapshotArg('"oops"').ignored === true);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

run();
