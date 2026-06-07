#!/usr/bin/env tsx
/**
 * Tests for lib/frontier-economy-readpath.ts — the /economy read-path logic that
 * silently LIES if it drifts: the ≥550 standing-tone honesty gate (the thing two
 * builds got right), and the /state + /counterparties row→shape mappers (the
 * column-rename canary). All pure; no browser.
 *
 * The load-bearing assertion is "does 500 render earned" → it MUST be `building`.
 * Flip EARNED_THRESHOLD and this suite goes red (see the self-audit).
 *
 * Run: npx tsx scripts/_test-economy-readpath.ts   (exit 0 = all pass)
 */
import {
  standingTone,
  mapRecentTxn,
  aggregateWindows,
  mapCounterpartyTxn,
  type StateTxnRow,
  type CounterpartyDbRow,
} from "../lib/frontier-economy-readpath";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean): void {
  if (cond) passed++;
  else { failed++; console.error(`FAIL: ${label}`); }
}

const NOW = 1_800_000_000_000;
const hAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

// ─────────────────────────────────────────────────────────────────────────────
// standingTone — THE honesty gate. earned ⟺ verified AND above baseline (≥550).
// ─────────────────────────────────────────────────────────────────────────────
check("tone: 438 (brand-new floor) → building", standingTone(438) === "building");
check("tone: 500 (UNVERIFIED_CAP) → building — NOT earned", standingTone(500) === "building");
check("tone: 549 (just below gate) → building", standingTone(549) === "building");
check("tone: 550 (the gate) → earned", standingTone(550) === "earned");
check("tone: 551 → earned", standingTone(551) === "earned");
check("tone: 720 (assist) → earned", standingTone(720) === "earned");
check("tone: 850 (max) → earned", standingTone(850) === "earned");
check("tone: null → degraded (no fake number)", standingTone(null) === "degraded");
check("tone: undefined → degraded (defensive)", standingTone(undefined) === "degraded");
check("tone: 0 (below floor) → building", standingTone(0) === "building");

// ─────────────────────────────────────────────────────────────────────────────
// mapRecentTxn — one DB row → one activity-feed entry (column-rename canary).
// ─────────────────────────────────────────────────────────────────────────────
function srow(p: Partial<StateTxnRow>): StateTxnRow {
  return {
    id: "tx1", rail: "x402", direction: "spend",
    amount_usdc: "0.01", protocol_fee_usdc: "0",
    status: "settled", counterparty_address: null, counterparty_vm_id: null,
    response_summary: null, tx_hash: null,
    created_at: hAgo(1), settled_at: null, metadata: null, ...p,
  };
}
{
  const r = mapRecentTxn(srow({
    id: "abc", rail: "bazaar", direction: "earn", status: "refunded",
    counterparty_address: "0xfeed", counterparty_vm_id: "vm-9",
    response_summary: "ok", tx_hash: "0xhash", settled_at: "2026-01-01T00:00:00Z",
  }));
  check("recent: id/rail/direction/status pass through",
    r.id === "abc" && r.rail === "bazaar" && r.direction === "earn" && r.status === "refunded");
  check("recent: counterparty + tx + summary + settled_at pass through",
    r.counterparty_address === "0xfeed" && r.counterparty_vm_id === "vm-9" &&
    r.response_summary === "ok" && r.tx_hash === "0xhash" && r.settled_at === "2026-01-01T00:00:00Z");
}
{
  // numeric coercion: PostgREST string → number, round6.
  const r = mapRecentTxn(srow({ amount_usdc: "0.0250001", protocol_fee_usdc: "0.000002" }));
  check("recent: amount string coerced + round6 (0.0250001→0.025)", r.amount_usdc === 0.025);
  check("recent: protocol_fee string coerced + round6", r.protocol_fee_usdc === 0.000002);
}
{
  // metadata extraction (the decision-context fields the feed reads).
  const r = mapRecentTxn(srow({
    metadata: {
      category: "data", mode: "auto", result_used: true,
      score_at_authorize: 612, earned_budget_at_authorize: "1.25",
      latency_ms: "1340", endpoint: "https://anchor.com/v1/price", pay_error: "",
    },
  }));
  check("recent: category/mode/endpoint via mStr", r.category === "data" && r.mode === "auto" && r.endpoint === "https://anchor.com/v1/price");
  check("recent: result_used via mBool (true)", r.result_used === true);
  check("recent: standing via mNum (number)", r.standing_at_decision === 612);
  check("recent: earned_budget via mNum (numeric string)", r.earned_budget_at_decision === 1.25);
  check("recent: latency via mNum (numeric string)", r.latency_ms === 1340);
  check("recent: empty-string pay_error → null (mStr strips empty)", r.pay_error === null);
}
{
  // null metadata → every decision field null, never throws.
  const r = mapRecentTxn(srow({ metadata: null }));
  check("recent: null metadata → category/mode/endpoint/pay_error null",
    r.category === null && r.mode === null && r.endpoint === null && r.pay_error === null);
  check("recent: null metadata → result_used/standing/budget/latency null",
    r.result_used === null && r.standing_at_decision === null &&
    r.earned_budget_at_decision === null && r.latency_ms === null);
}

// ─────────────────────────────────────────────────────────────────────────────
// aggregateWindows — rolling-24h + lifetime, SETTLED-ONLY money.
// ─────────────────────────────────────────────────────────────────────────────
{
  const rows: StateTxnRow[] = [
    srow({ direction: "earn", amount_usdc: "0.50", status: "settled", created_at: hAgo(2) }),   // 24h earn
    srow({ direction: "spend", amount_usdc: "0.02", status: "settled", created_at: hAgo(2) }),  // 24h spend
    srow({ direction: "spend", amount_usdc: "0.03", status: "settled", created_at: hAgo(48) }), // lifetime only
    srow({ direction: "spend", amount_usdc: "9.99", status: "failed", created_at: hAgo(1) }),   // NOT counted
    srow({ direction: "earn", amount_usdc: "9.99", status: "pending", created_at: hAgo(1) }),   // NOT counted
  ];
  const a = aggregateWindows(rows, NOW, 500);
  check("agg: 24h earned = 0.50 (settled in-window only)", a.window_24h.earned_usdc === 0.5);
  check("agg: 24h spent = 0.02 (48h-old spend excluded)", a.window_24h.spent_usdc === 0.02);
  check("agg: 24h net = 0.48", a.window_24h.net_usdc === 0.48);
  check("agg: 24h transactions = 2 (earn + spend in-window)", a.window_24h.transactions === 2);
  check("agg: lifetime earned = 0.50", a.lifetime.earned_usdc === 0.5);
  check("agg: lifetime spent = 0.05 (incl. out-of-window)", a.lifetime.spent_usdc === 0.05);
  check("agg: lifetime net = 0.45", a.lifetime.net_usdc === 0.45);
  check("agg: failed/pending excluded from money entirely", a.lifetime.earned_usdc === 0.5 && a.lifetime.spent_usdc === 0.05);
  check("agg: hasTrackRecord true (has settled activity)", a.hasTrackRecord === true);
}
{
  // 24h window boundary: a settled spend at exactly `since` is IN-window (>=).
  const rows: StateTxnRow[] = [
    srow({ direction: "spend", amount_usdc: "1", status: "settled", created_at: new Date(NOW - 24 * 3_600_000).toISOString() }),       // exactly 24h → in
    srow({ direction: "spend", amount_usdc: "1", status: "settled", created_at: new Date(NOW - 24 * 3_600_000 - 1).toISOString() }),   // 1ms older → out
  ];
  const a = aggregateWindows(rows, NOW, 500);
  check("agg: boundary — row at exactly 24h is in-window (>= since)", a.window_24h.spent_usdc === 1 && a.window_24h.transactions === 1);
}
{
  // no settled rows → hasTrackRecord false (preserves first-run null standing).
  const a = aggregateWindows([srow({ status: "pending" }), srow({ status: "failed" })], NOW, 500);
  check("agg: no settled rows → hasTrackRecord false", a.hasTrackRecord === false);
  check("agg: no settled rows → zero money", a.lifetime.earned_usdc === 0 && a.lifetime.spent_usdc === 0);
}
{
  // truncated flag — only when at/above the scan cap.
  const under = aggregateWindows([srow({})], NOW, 500);
  const at = aggregateWindows(Array.from({ length: 3 }, () => srow({})), NOW, 3);
  check("agg: truncated false below scan cap", under.lifetime.truncated === false);
  check("agg: truncated true at scan cap", at.lifetime.truncated === true);
}

// ─────────────────────────────────────────────────────────────────────────────
// mapCounterpartyTxn — DB row → rollup input (the /counterparties canary).
// ─────────────────────────────────────────────────────────────────────────────
function crow(p: Partial<CounterpartyDbRow>): CounterpartyDbRow {
  return {
    direction: "spend", status: "settled", amount_usdc: "0.01",
    created_at: hAgo(1), counterparty_vm_id: null, counterparty_address: null, metadata: null, ...p,
  };
}
{
  const r = mapCounterpartyTxn(crow({
    direction: "spend", status: "settled", amount_usdc: "0.04",
    counterparty_vm_id: "vm-7", counterparty_address: "0xabc",
    metadata: { category: "data", endpoint: "https://a.com/x" },
  }));
  check("cp: valid category 'data' passes", r.category === "data");
  check("cp: endpoint passes", r.endpoint === "https://a.com/x");
  check("cp: settled status passes", r.status === "settled");
  check("cp: amountUsd coerced from string", r.amountUsd === 0.04);
  check("cp: createdAtMs = Date.parse", typeof r.createdAtMs === "number" && r.createdAtMs > 0);
  check("cp: vmId + address pass through", r.counterpartyVmId === "vm-7" && r.counterpartyAddress === "0xabc");
}
check("cp: invalid category 'banana' → null",
  mapCounterpartyTxn(crow({ metadata: { category: "banana" } })).category === null);
check("cp: missing category → null",
  mapCounterpartyTxn(crow({ metadata: {} })).category === null);
check("cp: empty-string endpoint → null",
  mapCounterpartyTxn(crow({ metadata: { endpoint: "  " } })).endpoint === null);
check("cp: null metadata → category + endpoint null, no throw",
  (() => { const r = mapCounterpartyTxn(crow({ metadata: null })); return r.category === null && r.endpoint === null; })());
check("cp: unknown status normalizes to 'failed' (conservative)",
  mapCounterpartyTxn(crow({ status: "weird" })).status === "failed");
check("cp: each known status passes through",
  (["pending", "settled", "failed", "disputed", "refunded"] as const).every(
    (s) => mapCounterpartyTxn(crow({ status: s })).status === s));
check("cp: direction 'earn' → earn",
  mapCounterpartyTxn(crow({ direction: "earn" })).direction === "earn");
check("cp: direction non-earn → spend",
  mapCounterpartyTxn(crow({ direction: "spend" })).direction === "spend");

console.log(`\neconomy-readpath: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
