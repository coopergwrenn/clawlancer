#!/usr/bin/env tsx
/**
 * Tests for lib/frontier-burn.ts aggregateBurnBatch (the pure spend-amount core).
 *
 * Run: npx tsx scripts/_test-frontier-burn.ts  (exit 0 = all pass)
 *
 * This is the number that decides how much treasury USDC gets spent, so the
 * failure modes that matter: PostgREST numeric-as-string, non-positive/garbage
 * amounts being silently included, float drift, and null source tags.
 */
import { aggregateBurnBatch, executeBuyBurn, BurnNotStartedError, type BurnQueueRow } from "../lib/frontier-burn";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean): void {
  if (cond) passed++;
  else { failed++; console.error(`FAIL: ${label}`); }
}

const row = (id: string, amount: number | string, source: string | null = "x402_protocol_fee"): BurnQueueRow => ({
  id,
  amount_usdc: amount,
  source_tag: source,
});

// ── empty ──
{
  const b = aggregateBurnBatch([]);
  check("empty → 0 total", b.totalUsd === 0);
  check("empty → no ids", b.ids.length === 0);
  check("empty → no skipped", b.skipped === 0);
}

// ── PostgREST numeric-as-string ──
{
  const b = aggregateBurnBatch([row("a", "1.5"), row("b", "2.25")]);
  check("string amounts summed", b.totalUsd === 3.75);
  check("string amounts → 2 ids", b.ids.length === 2);
}

// ── mixed string/number ──
{
  const b = aggregateBurnBatch([row("a", 1), row("b", "2"), row("c", 0.5)]);
  check("mixed string/number summed", b.totalUsd === 3.5);
}

// ── non-positive / garbage skipped, never spent ──
{
  const b = aggregateBurnBatch([row("a", 5), row("b", 0), row("c", -3), row("d", "not-a-number"), row("e", "1")]);
  check("zero/negative/NaN skipped from total", b.totalUsd === 6); // 5 + 1
  check("only valid rows in ids", b.ids.length === 2 && b.ids.join(",") === "a,e");
  check("skipped counted", b.skipped === 3);
}

// ── per-source breakdown ──
{
  const b = aggregateBurnBatch([
    row("a", 1, "x402_protocol_fee"),
    row("b", 2, "compute_protocol_fee"),
    row("c", 3, "x402_protocol_fee"),
  ]);
  check("source x402 grouped", b.bySource["x402_protocol_fee"] === 4);
  check("source compute grouped", b.bySource["compute_protocol_fee"] === 2);
}

// ── null / blank source_tag → "unknown" (never a crash, never a lost row) ──
{
  const b = aggregateBurnBatch([row("a", 1, null), row("b", 2, "  ")]);
  check("null/blank source bucketed as unknown", b.bySource["unknown"] === 3);
  check("null-source rows still counted in total", b.totalUsd === 3);
}

// ── float drift rounded to USDC 6dp ──
{
  const b = aggregateBurnBatch([row("a", 0.1), row("b", 0.2)]);
  check("0.1 + 0.2 rounds clean to 0.3", b.totalUsd === 0.3);
}

// ── id order preserved (oldest-first claim relies on it) ──
{
  const b = aggregateBurnBatch([row("z", 1), row("y", 1), row("x", 1)]);
  check("ids preserved in input order", b.ids.join(",") === "z,y,x");
}

// ── executeBuyBurn is the throwing stub (gate is real) ──
(async () => {
  let threw: unknown = null;
  try {
    await executeBuyBurn({ totalUsdc: 10, bySource: {}, burnBatchId: "00000000-0000-0000-0000-000000000000" });
  } catch (e) {
    threw = e;
  }
  check("executeBuyBurn throws (not wired)", threw !== null);
  check("executeBuyBurn throws BurnNotStartedError (safe-to-release signal)", threw instanceof BurnNotStartedError);

  console.log(`\nfrontier-burn: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
