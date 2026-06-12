/**
 * Decision tests for the Trips surface's pure logic (lib/travala-trips-view.ts).
 * Per the trips spec (ruled 2026-06-12): the countdown matrix, status→view incl.
 * cancel_failed, the canary-honest refund stub, and the row mapping.
 *
 * Run: npx tsx scripts/_test-trip-card-logic.ts
 */
import {
  countdownFor,
  fmtHm,
  nightsBetween,
  fmtDateRange,
  shortTx,
  statusView,
  refundView,
  toTripRow,
  type TripRow,
} from "../lib/travala-trips-view";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ""}`); }
}

const NOW = Date.parse("2026-06-12T12:00:00Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const H = 3_600_000;

console.log("\n── countdown matrix (calm staged pill: none / until / ticking / urgent / ended) ──");
const c72 = countdownFor(iso(72 * H), NOW, null);
ok(">48h → 'until' with absolute date, no ticking", c72.kind === "until" && c72.label.includes("free cancellation until"));
const c36 = countdownFor(iso(36 * H + 12 * 60_000), NOW, null);
ok("≤48h → ticking, not urgent, '36h 12m' math exact", c36.kind === "ticking" && !("urgent" in c36 && c36.urgent) && c36.label === "free cancellation ends in 36h 12m", JSON.stringify(c36));
const c11 = countdownFor(iso(11 * H), NOW, null);
ok("≤12h → ticking AND urgent", c11.kind === "ticking" && "urgent" in c11 && c11.urgent === true);
const cPast = countdownFor(iso(-2 * H), NOW, null);
ok("past deadline → 'ended', past tense, quiet", cPast.kind === "ended" && cPast.label.includes("window ended"));
const cNullP = countdownFor(null, NOW, "non-refundable rate");
ok("no deadline + policy → none with the policy string", cNullP.kind === "none" && cNullP.label === "cancellation policy: non-refundable rate");
const cNull = countdownFor(null, NOW, null);
ok("no deadline, no policy → honest absence", cNull.kind === "none" && cNull.label === "cancellation policy not recorded");
ok("unparseable deadline → none (never NaN labels)", countdownFor("garbage", NOW, null).kind === "none");
ok("boundary: exactly 48h → ticking (inclusive ≤)", countdownFor(iso(48 * H), NOW, null).kind === "ticking");
ok("fmtHm pads minutes ('5h 03m')", fmtHm(5 * H + 3 * 60_000) === "5h 03m");

console.log("\n── status → view (all four REAL states; plain language, never enum-speak) ──");
const conf = statusView("confirmed", "MN5V9DWQ");
ok("confirmed → ok tone + 'cancel this trip' prefilling the ref", conf.tone === "ok" && conf.action?.label === "cancel this trip" && conf.action.prefill.includes("MN5V9DWQ"));
const pend = statusView("cancel_requested", "MN5V9DWQ");
ok("cancel_requested → pending + finish-cancelling action + the code note", pend.tone === "pending" && pend.action?.label === "finish cancelling" && !!pend.note && pend.note.includes("code"));
const done = statusView("cancelled", "MN5V9DWQ");
ok("cancelled → done tone, NO action (calm terminal state)", done.tone === "done" && done.action === null);
const failed = statusView("cancel_failed", "MN5V9DWQ");
ok("cancel_failed → warn + honest note + check action (failure rendered honestly IS the feature)", failed.tone === "warn" && !!failed.note && failed.note.includes("may still be active") && failed.action?.label === "check this booking");
ok("no enum-speak in any badge", [conf, pend, done, failed].every((v) => !/_/.test(v.badge)));
ok("null bookingId → prefill still sensible", statusView("confirmed", null).action!.prefill.includes("my recent hotel booking"));
ok("unknown status → rendered honestly, no action", statusView("weird_state", "X").badge === "weird state");

console.log("\n── refund view (CANARY-HONEST: stub when unobserved, never guessed) ──");
const base: TripRow = toTripRow({ id: "1", vm_id: "v", user_id: "u", last_name: "D", email: "e", status: "cancelled", created_at: "2026-06-12T00:00:00Z" });
const rStub = refundView({ ...base, status: "cancelled", refundAmount: null });
ok("cancelled + no snapshot → the honest stub (no invented shape)", rStub.stub === true && rStub.line.includes("recorded once travala confirms"));
const rFull = refundView({ ...base, status: "cancelled", refundAmount: 80, cancellationFee: 4.5 });
ok("cancelled + snapshot → amount, fee, travala credit, never wallet", rFull.stub === false && rFull.line.includes("refund $80.00") && rFull.line.includes("$4.50 fee") && rFull.line.includes("travala travel credit") && rFull.line.includes("not to your wallet"));
const rNoFee = refundView({ ...base, status: "cancelled", refundAmount: 80, cancellationFee: 0 });
ok("zero fee → no fee clause", !rNoFee.line.includes("fee"));
ok("non-cancelled → empty", refundView({ ...base, status: "confirmed" }).line === "");

console.log("\n── display helpers + row mapping ──");
ok("nights: jun 24 → 26 = 2", nightsBetween("2026-06-24", "2026-06-26") === 2);
ok("nights: invalid order → null", nightsBetween("2026-06-26", "2026-06-24") === null);
ok("nights: nulls → null", nightsBetween(null, "2026-06-26") === null);
ok("date range lowercase 'jun 24 → jun 26'", fmtDateRange("2026-06-24", "2026-06-26") === "jun 24 → jun 26");
ok("shortTx truncates 0x… form", shortTx("0x4f7a2c9e8b1d6f3a5c0e7d2b") === "0x4f7a…7d2b");
ok("shortTx passes short/null through", shortTx(null) === null && shortTx("0xabc") === "0xabc");
const mapped = toTripRow({
  id: "x", booking_id: "ABCD1234", hotel_name: "H", status: "confirmed",
  display_price: "84.50", amount_usd_paid: "84.5", refund_amount: null,
  created_at: "2026-06-12T00:00:00Z", currency: null,
});
ok("PostgREST numeric-as-string coerced (Rule 21 class)", mapped.displayPrice === 84.5 && mapped.amountUsdPaid === 84.5);
ok("null currency defaults USD; empty strings → null", mapped.currency === "USD" && mapped.checkIn === null);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
