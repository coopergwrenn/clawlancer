/**
 * Decision-level tests for the Travala cancel/manage lane (Rule 31).
 * Hermetic: no network — mocks the supabase client + uses the REAL 2026-06-11
 * error-catalog bodies. Catches composition bugs, not just existence:
 *   - classify on isError tool-results (not r.ok) — the actual MCP shape
 *   - VM-A cannot resolve VM-B's booking (the ownership gate, before any MCP call)
 *   - the credit-note never touches the frontier ledger
 *   - bookingId regex doesn't false-positive on USDC/BASE/tx hashes
 *
 * Run: npx tsx scripts/_test-travala-cancel.ts
 */
import { readFileSync } from "node:fs";
import {
  classifyToolResult,
  extractBookingRef,
  parseCancelOutcome,
  lookupOwnedBooking,
  markCancelled,
  recordConfirmedBooking,
  isTravalaSpend,
  cancelMarkFor,
} from "../lib/travala-bookings";
import type { McpCallResult } from "../lib/travala-mcp";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ""}`); }
}
const toolErr = (text: string): McpCallResult => ({ ok: true, http_code: 200, result: { isError: true, content: [{ type: "text", text }] } });
const toolOk = (text: string): McpCallResult => ({ ok: true, http_code: 200, result: { isError: false, content: [{ type: "text", text }] } });

async function run() {
console.log("\n── A. classifyToolResult on the REAL captured catalog ──");
ok("cancel step-1 unknown id → not_found", classifyToolResult(toolErr("Failed to cancel booking: Failed to send cancellation OTP")).state === "not_found");
ok("cancel step-2 unknown id → not_found", classifyToolResult(toolErr("Failed to cancel booking: Booking not found")).state === "not_found");
ok("malformed -32602 → invalid_input", classifyToolResult(toolErr('MCP error -32602: Input validation error: Invalid arguments for tool travala_cancel_booking: [{"message":"Booking ID is required"}]')).state === "invalid_input");
ok("manage step-1 unknown id → not_found", classifyToolResult(toolErr("Failed to get booking details: Failed to send verification OTP\n\nPlease verify:\n- Booking ID is correct")).state === "not_found");
ok("success (OTP emailed) → ok", classifyToolResult(toolOk("A verification code was emailed to j***@example.com (expires in 600s).")).state === "ok");
ok("bad otp → bad_otp", classifyToolResult(toolErr("Invalid OTP. The code is incorrect or has expired.")).state === "bad_otp");
ok("already cancelled → already_cancelled", classifyToolResult(toolErr("This booking is already cancelled.")).state === "already_cancelled");
ok("transport down (ok:false) → upstream_error", classifyToolResult({ ok: false, error: "fetch failed" }).state === "upstream_error");
ok("unrecognised isError → upstream_error (surfaced verbatim)", (() => { const c = classifyToolResult(toolErr("Some brand-new Travala error nobody has seen")); return c.state === "upstream_error" && c.text.includes("brand-new"); })());
// ordering: a body that matches both 'already cancel' and 'not found' must pick already_cancelled
ok("ordering: already-cancelled wins over not-found", classifyToolResult(toolErr("This booking is already cancelled; booking not found in active set")).state === "already_cancelled");

console.log("\n── B. extractBookingRef (no false positives on USDC/BASE/tx) ──");
ok("MN5V9DWQ extracted", extractBookingRef("Your booking ref is MN5V9DWQ — confirmed.") === "MN5V9DWQ");
ok("ABCD1234 extracted", extractBookingRef("ref ABCD1234") === "ABCD1234");
ok("USDC not matched", extractBookingRef("Paid 219 USDC") === null);
ok("BASE not matched", extractBookingRef("on BASE network") === null);
ok("lowercase tx hash not matched", extractBookingRef("tx 0xabc123def456789") === null);
ok("empty/null → null", extractBookingRef("") === null && extractBookingRef(null) === null);

console.log("\n── C. parseCancelOutcome ──");
const oc = parseCancelOutcome("Booking cancelled. Refund amount: $180.00 after a cancellation fee of $20.00.");
ok("refund 180", oc.refundAmount === 180, `got ${oc.refundAmount}`);
ok("fee 20", oc.cancellationFee === 20, `got ${oc.cancellationFee}`);
const oc2 = parseCancelOutcome("Cancelled (non-refundable, no refund).");
ok("no amount → nulls (no false number)", oc2.refundAmount === null);

console.log("\n── D. ownership gate (VM-A cannot resolve VM-B's booking — before any MCP call) ──");
function mockSb(row: unknown) {
  return { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) }) } as never;
}
const rowB = { id: "r1", vm_id: "vm-B", user_id: "u-B", booking_id: "MN5V9DWQ", last_name: "Doe", email: "d@x.com", status: "confirmed" };
ok("VM-A querying VM-B's booking → null (gate blocks, no MCP)", (await lookupOwnedBooking(mockSb(rowB), "vm-A", "MN5V9DWQ")) === null);
ok("VM-B querying its own booking → row", (await lookupOwnedBooking(mockSb(rowB), "vm-B", "MN5V9DWQ"))?.id === "r1");
ok("no such booking → null", (await lookupOwnedBooking(mockSb(null), "vm-A", "ZZZZ9999")) === null);
ok("empty bookingId → null (no lookup)", (await lookupOwnedBooking(mockSb(rowB), "vm-A", "")) === null);

console.log("\n── E. credit-note discipline (refund_destination travala_credit, never wallet) ──");
let captured: Record<string, unknown> | null = null;
const capSb = { from: () => ({ update: (p: Record<string, unknown>) => { captured = p; return { eq: async () => ({ error: null }) }; } }) } as never;
await markCancelled(capSb, "r1", { refundAmount: 180, cancellationFee: 20, raw: { x: 1 } });
ok("status → cancelled", captured!.status === "cancelled");
ok("refund_destination → travala_credit (never wallet)", captured!.refund_destination === "travala_credit");

console.log("\n── F. structural: cancel path never touches the frontier ledger ──");
const libSrc = readFileSync(new URL("../lib/travala-bookings.ts", import.meta.url), "utf8");
const routeSrc = readFileSync(new URL("../app/api/travala/[op]/route.ts", import.meta.url), "utf8");
// strip comments — the §9 docstring legitimately NAMES the forbidden endpoints
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const libCode = stripComments(libSrc);
// the cancel-booking handler block only
const cancelBlock = stripComments(routeSrc.slice(routeSrc.indexOf('op === "cancel-booking"'), routeSrc.indexOf("// ── book-quote: the gated money path ──")));
// the real "touches the frontier ledger" signals — agent-economy endpoints,
// budget/credit mutation. (NOT a bare /refund: that legitimately appears in the
// refund-AMOUNT parser regex; this lane records a snapshot, it doesn't refund.)
ok("lib code makes no frontier-ledger / budget-credit call", !/agent-economy|credit_balance|increment_tier_usage|increment.*budget|getBillingStatus/i.test(libCode));
ok("cancel handler has NO kill-switch / toggle gate (bypass)", !/isTravalaBookingKilled|isTravalaBookingEnabled/.test(cancelBlock));
ok("cancel handler runs ownership lookup BEFORE mcpToolsCall", cancelBlock.indexOf("lookupOwnedBooking") < cancelBlock.indexOf("mcpToolsCall") && cancelBlock.indexOf("lookupOwnedBooking") > -1);
ok("cancel handler makes no frontier-ledger call", !/agent-economy|\/authorize|\/settle|\/refund/i.test(cancelBlock));

console.log("\n── G. recordConfirmedBooking — composite-unique race-catch (P1a) ──");
// no TRAVALA creds in the test env → book_status mint returns not_configured →
// extractBookingIdViaStatus no-ops (no network); bookingId comes from the regex.
delete process.env.TRAVALA_OAUTH_CLIENT_ID;
delete process.env.TRAVALA_OAUTH_CLIENT_SECRET;
// Sequence-scripted mock: existence-check (maybeSingle #0) → null; insert #0 →
// composite-unique violation; re-select (maybeSingle #1) → the race winner; update → ok.
function scriptedSb(s: { existing: unknown; insertErr?: string; reselect?: unknown }) {
  let ms = 0;
  let ins = 0;
  let updated: Record<string, unknown> | null = null;
  const api = {
    _updated: () => updated,
    from: () => ({
      select: () => {
        const chain: Record<string, unknown> = {
          eq: () => chain,
          or: () => ({ limit: async () => ({ data: [], error: null }) }),
          maybeSingle: async () => ({ data: ms++ === 0 ? s.existing : (s.reselect ?? null), error: null }),
          single: async () => ({ data: { id: "ins-row" }, error: null }),
        };
        return chain;
      },
      insert: () => ({ select: () => ({ single: async () => (ins++ === 0 && s.insertErr ? { data: null, error: { message: s.insertErr } } : { data: { id: "ins-row" }, error: null }) }) }),
      update: (p: Record<string, unknown>) => ({ eq: async () => { updated = p; return { error: null }; } }),
    }),
  };
  return api as never;
}
const recParams = {
  vmId: "vm-A", userId: "u-A",
  customer: { lastName: "Doe", email: "d@x.com" },
  packageId: "PKG1", sessionId: "SESS1",
  payResponseRaw: "Booking confirmed: ref MN5V9DWQ",
};
const race = await recordConfirmedBooking(scriptedSb({ existing: null, insertErr: 'duplicate key value violates unique constraint "instaclaw_travala_bookings_vm_pkg_sess_uniq"', reselect: { id: "winner-row" } }), recParams);
ok("race: composite-unique violation → recorded:true on the winner row", race.recorded === true && race.rowId === "winner-row", JSON.stringify(race));
const fresh = await recordConfirmedBooking(scriptedSb({ existing: null }), recParams);
ok("fresh insert → recorded:true with bookingId from pay-response regex", fresh.recorded === true && fresh.bookingId === "MN5V9DWQ", JSON.stringify(fresh));
const dupBooking = await recordConfirmedBooking(scriptedSb({ existing: null, insertErr: 'duplicate key value violates unique constraint "instaclaw_travala_bookings_booking_id_uidx"' }), recParams);
ok("booking_id collision → degrades to ref-less row (recorded, booking_id null)", dupBooking.recorded === true && dupBooking.bookingId === null, JSON.stringify(dupBooking));

console.log("\n── I. cancelMarkFor — the row must never contradict reality (GAP-2) ──");
// THE fix: already_cancelled at EITHER step marks the row cancelled, never cancel_failed.
ok("step 1 already_cancelled → cancelled (not failed, not none)", cancelMarkFor("already_cancelled", 1) === "cancelled");
ok("step 2 already_cancelled → cancelled (the old fall-through wrote cancel_failed)", cancelMarkFor("already_cancelled", 2) === "cancelled");
// the rest of the matrix:
ok("step 1 ok → cancel_requested (OTP sent)", cancelMarkFor("ok", 1) === "cancel_requested");
ok("step 2 ok → cancelled", cancelMarkFor("ok", 2) === "cancelled");
ok("step 2 bad_otp → none (stay cancel_requested for a fresh code)", cancelMarkFor("bad_otp", 2) === "none");
ok("step 1 not_found → none (nothing happened)", cancelMarkFor("not_found", 1) === "none");
ok("step 1 upstream_error → none", cancelMarkFor("upstream_error", 1) === "none");
ok("step 2 not_found → cancel_failed", cancelMarkFor("not_found", 2) === "cancel_failed");
ok("step 2 upstream_error → cancel_failed", cancelMarkFor("upstream_error", 2) === "cancel_failed");
ok("step 2 invalid_input → cancel_failed", cancelMarkFor("invalid_input", 2) === "cancel_failed");

console.log("\n── H. isTravalaSpend (reconciler cron cross-ref) ──");
ok("tags include travala → true", isTravalaSpend({ tags: ["travel", "hotel", "travala"] }) === true);
ok("category travel but no travala tag → false (precise)", isTravalaSpend({ category: "travel", tags: ["travel", "hotel"] }) === false);
ok("no metadata → false", isTravalaSpend(null) === false && isTravalaSpend(undefined) === false);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(1); });
