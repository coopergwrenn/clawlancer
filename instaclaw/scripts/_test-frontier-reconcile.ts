#!/usr/bin/env tsx
/**
 * Tests for lib/frontier-reconcile.ts (refund-orphan detection + IN-chunking).
 * Run: npx tsx scripts/_test-frontier-reconcile.ts  (exit 0 = all pass)
 *
 * The chunker has a real off-by-one risk at the boundary, and the orphan diff
 * decides whether a refund silently stays un-queued — both worth pinning down.
 */
import { chunk, computeOrphanRefunds } from "../lib/frontier-reconcile";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean): void {
  if (cond) passed++;
  else { failed++; console.error(`FAIL: ${label}`); }
}

// ── chunk ──
check("empty → no chunks", chunk([], 3).length === 0);
check("exact multiple", JSON.stringify(chunk([1, 2, 3, 4], 2)) === JSON.stringify([[1, 2], [3, 4]]));
check("ragged last chunk", JSON.stringify(chunk([1, 2, 3, 4, 5], 2)) === JSON.stringify([[1, 2], [3, 4], [5]]));
check("size larger than array → one chunk", JSON.stringify(chunk([1, 2], 10)) === JSON.stringify([[1, 2]]));
check("size 1 → singletons", JSON.stringify(chunk([1, 2, 3], 1)) === JSON.stringify([[1], [2], [3]]));
{
  let threw = false;
  try { chunk([1], 0); } catch { threw = true; }
  check("size 0 throws", threw);
}
// no element lost or duplicated across chunks
{
  const src = Array.from({ length: 205 }, (_, i) => i);
  const flat = chunk(src, 50).flat();
  check("chunk preserves all elements in order", JSON.stringify(flat) === JSON.stringify(src));
  check("chunk count for 205/50 = 5", chunk(src, 50).length === 5);
}

// ── computeOrphanRefunds ──
check("none refunded → no orphans", computeOrphanRefunds([], ["x"]).length === 0);
check("all have retry → no orphans", computeOrphanRefunds(["a", "b"], ["a", "b"]).length === 0);
check("missing retry → orphan", JSON.stringify(computeOrphanRefunds(["a", "b", "c"], ["b"])) === JSON.stringify(["a", "c"]));
check("retry exists in any status counts (only absence is orphan)", computeOrphanRefunds(["a"], ["a"]).length === 0);
check("extra retry ids (no matching refund) are ignored", computeOrphanRefunds(["a"], ["a", "z", "y"]).length === 0);
check("order preserved", JSON.stringify(computeOrphanRefunds(["c", "a", "b"], [])) === JSON.stringify(["c", "a", "b"]));

console.log(`\nfrontier-reconcile: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
