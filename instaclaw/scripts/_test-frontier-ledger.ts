#!/usr/bin/env tsx
/**
 * Tests for lib/frontier-ledger.ts — the integrity-filtered derivations.
 * The wash-trade defenses (§7.3.1) are the load-bearing part; most cases here
 * are adversarial (self-dealing must NOT inflate standing).
 * Run: npx tsx scripts/_test-frontier-ledger.ts  (exit 0 = all pass)
 */
import {
  supplierIdOf,
  deriveTrackRecord,
  deriveSupplierStats,
  deriveCounterpartyRollup,
  type LedgerRow,
  type CounterpartyTxn,
} from "../lib/frontier-ledger";
import { mapTagsToCategory } from "../lib/frontier-policy";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean): void {
  if (cond) passed++;
  else { failed++; console.error(`FAIL: ${label}`); }
}

const NOW = 1_800_000_000_000;
const hAgo = (h: number) => NOW - h * 3_600_000;

function row(p: Partial<LedgerRow>): LedgerRow {
  return {
    direction: "spend", status: "settled", amountUsd: 0.01, createdAtMs: hAgo(1),
    counterpartyVmId: null, counterpartyAddress: null, endpoint: null, tags: [],
    resultUsed: true, verifiedOnChain: true, ...p,
  };
}

// ── supplierIdOf (canonical identity; unified Bazaar/fleet) ──
check("supplierId vm precedence", supplierIdOf({ counterpartyVmId: "abc", endpoint: "https://x.com/a", counterpartyAddress: "0x1" }) === "vm:abc");
check("supplierId url normalized (strip query, lowercase, trailing slash)",
  supplierIdOf({ counterpartyVmId: null, endpoint: "https://API.Anchor.com/v1/Price/?symbol=ETH", counterpartyAddress: null }) === "url:https://api.anchor.com/v1/price");
check("supplierId addr fallback", supplierIdOf({ counterpartyVmId: null, endpoint: null, counterpartyAddress: "0xABCD" }) === "addr:0xabcd");
check("supplierId null when nothing", supplierIdOf({ counterpartyVmId: null, endpoint: null, counterpartyAddress: null }) === null);

// ── mapTagsToCategory ──
check("tag->data", mapTagsToCategory(["price", "token"]) === "data");
check("tag->search", mapTagsToCategory(["web-search"]) === "search");
check("tag->inference", mapTagsToCategory(["llm", "gpt"]) === "inference");
check("tag->market", mapTagsToCategory(["polymarket"]) === "market");
check("tag->null unknown", mapTagsToCategory(["banana"]) === null);
check("tag->null empty", mapTagsToCategory([]) === null);

const sameHuman = (id: string) => id === "self-vm";
const opts = { nowMs: NOW, isSameHuman: sameHuman };

// ── WASH-TRADE DEFENSE (the critical part) ──
{
  // 10 settled spends all to the SAME-HUMAN counterparty → must contribute ZERO.
  const rows = Array.from({ length: 10 }, () => row({ counterpartyVmId: "self-vm", endpoint: "https://self.com/x" }));
  const tr = deriveTrackRecord(rows, opts);
  check("self-dealing: zero qualifying settlements", tr.qualifyingSettlements === 0);
  check("self-dealing: zero weighted settlements", tr.weightedSettlements === 0);
  check("self-dealing: zero distinct counterparties", tr.distinctCounterparties === 0);
  check("self-dealing: zero good decisions", tr.goodDecisions === 0);
}
{
  // Mix: 3 real distinct suppliers (settled+used) + 5 self-dealt → only the 3 count.
  const rows = [
    row({ counterpartyVmId: "peerA", endpoint: "https://a.com", tags: ["price"] }),
    row({ counterpartyVmId: "peerB", endpoint: "https://b.com", tags: ["search"] }),
    row({ counterpartyAddress: "0xext", endpoint: "https://c.com/api", tags: ["llm"] }),
    ...Array.from({ length: 5 }, () => row({ counterpartyVmId: "self-vm" })),
  ];
  const tr = deriveTrackRecord(rows, opts);
  check("mix: 3 qualifying settlements (self excluded)", tr.qualifyingSettlements === 3);
  check("mix: 3 distinct counterparties", tr.distinctCounterparties === 3);
  check("mix: 3 distinct categories", tr.distinctCategories === 3);
  check("mix: 3 good decisions", tr.goodDecisions === 3);
}

// ── good-decision (§7.3.2): settled ∧ used ∧ undisputed ∧ not-self-dealt ──
{
  const rows = [
    row({ counterpartyVmId: "p1", resultUsed: true }), // good
    row({ counterpartyVmId: "p2", resultUsed: false }), // settled but unused → wasteful
    row({ counterpartyVmId: "p3", status: "disputed" }), // dispute
  ];
  const tr = deriveTrackRecord(rows, opts);
  check("good-decision: 1 good", tr.goodDecisions === 1);
  check("good-decision: unused+disputed → 2 wasted", tr.wastedOrDisputed === 2);
  check("good-decision: 1 dispute counted", tr.disputes === 1);
}

// ── disputes count even when self-dealt (can't hide bad behavior via self-dealing) ──
{
  const tr = deriveTrackRecord([row({ counterpartyVmId: "self-vm", status: "disputed" })], opts);
  check("self-dealt dispute still counts", tr.disputes === 1 && tr.wastedOrDisputed === 1);
}

// ── earns & spends, tenure, spentToday window ──
{
  const rows = [
    row({ direction: "spend", amountUsd: 0.02, createdAtMs: hAgo(2), counterpartyVmId: "p1" }),
    row({ direction: "earn", amountUsd: 0.50, createdAtMs: hAgo(2), counterpartyVmId: "p2" }),
    row({ direction: "spend", amountUsd: 0.03, createdAtMs: hAgo(48), counterpartyVmId: "p3" }), // outside 24h
  ];
  const tr = deriveTrackRecord(rows, opts);
  check("earns and spends both true", tr.earns && tr.spends);
  check("spentToday only counts in-window settled spend", Math.abs(tr.spentTodayUsd - 0.02) < 1e-9);
  check("earnedToday in-window", Math.abs(tr.earnedTodayUsd - 0.50) < 1e-9);
  check("firstActivity is the oldest", tr.firstActivityAtMs === hAgo(48));
}

// ── anomaly: burst of brand-new counterparties (farming pattern) ──
{
  const rows = Array.from({ length: 6 }, (_, i) => row({ counterpartyVmId: `new${i}`, createdAtMs: hAgo(1) }));
  const tr = deriveTrackRecord(rows, opts);
  check("anomaly flag on new-counterparty burst", tr.anomalyFlag === true);
}
{
  // established: many txns with FEW counterparties over long time → no anomaly
  const rows = Array.from({ length: 20 }, (_, i) => row({ counterpartyVmId: i % 2 ? "p1" : "p2", createdAtMs: hAgo(100 + i) }));
  const tr = deriveTrackRecord(rows, opts);
  check("no anomaly for established low-diversity steady agent", tr.anomalyFlag === false);
}

// ── deriveSupplierStats ──
{
  const rows = [
    row({ counterpartyVmId: "p1", endpoint: "https://a.com", tags: ["price"], status: "settled", amountUsd: 0.01 }),
    row({ counterpartyVmId: "p1", endpoint: "https://a.com", tags: ["price"], status: "settled", amountUsd: 0.03 }),
    row({ counterpartyVmId: "p1", endpoint: "https://a.com", tags: ["price"], status: "failed" }),
    row({ counterpartyVmId: "self-vm", endpoint: "https://self.com", tags: ["price"], status: "settled" }), // excluded
  ];
  const stats = deriveSupplierStats(rows, opts);
  check("supplierStats: one supplier (self excluded)", stats.length === 1);
  check("supplierStats: 2 successes 1 failure", stats[0].successes === 2 && stats[0].failures === 1);
  check("supplierStats: avg cost over successes", Math.abs(stats[0].avgCostUsd - 0.02) < 1e-9);
  check("supplierStats: internal flag (vm: prefix)", stats[0].internal === true);
}

// ── deriveCounterpartyRollup (the /economy "who it works with" card) ──
function cpTxn(p: Partial<CounterpartyTxn>): CounterpartyTxn {
  return {
    direction: "spend", status: "settled", amountUsd: 0.01, createdAtMs: hAgo(1),
    counterpartyVmId: null, counterpartyAddress: null, endpoint: null, category: "data", ...p,
  };
}
const isSelf = (id: string) => id === "self-vm";
{
  const rows: CounterpartyTxn[] = [
    cpTxn({ counterpartyVmId: "p1", endpoint: "https://a.com", category: "data", status: "settled", amountUsd: 0.01, createdAtMs: hAgo(3) }),
    cpTxn({ counterpartyVmId: "p1", endpoint: "https://a.com", category: "data", status: "settled", amountUsd: 0.03, createdAtMs: hAgo(2) }),
    cpTxn({ counterpartyVmId: "p1", endpoint: "https://a.com", category: "search", status: "failed", createdAtMs: hAgo(1) }),
    cpTxn({ counterpartyVmId: "p2", endpoint: "https://b.com", category: "agent", status: "settled", amountUsd: 0.02 }),
    cpTxn({ counterpartyVmId: "self-vm", endpoint: "https://self.com", category: "data", status: "settled" }), // self-dealing
    cpTxn({ direction: "earn", counterpartyVmId: "p3", status: "settled", amountUsd: 1 }), // earn
    cpTxn({ counterpartyVmId: "p4", endpoint: "https://c.com", status: "pending" }), // unresolved
  ];
  const roll = deriveCounterpartyRollup(rows, { isSameHuman: isSelf });
  check("rollup: self-dealing counterparty excluded", !roll.some((r) => r.supplierId === "vm:self-vm"));
  check("rollup: earn-side counterparty excluded", !roll.some((r) => r.supplierId === "vm:p3"));
  check("rollup: pending-only counterparty excluded", !roll.some((r) => r.supplierId === "vm:p4"));
  check("rollup: count = 2 (p1, p2)", roll.length === 2);
  const p1 = roll.find((r) => r.supplierId === "vm:p1");
  check("rollup: p1 present", !!p1);
  check("rollup: p1 delivered=2, didntGoThrough=1", !!p1 && p1.delivered === 2 && p1.didntGoThrough === 1);
  check("rollup: p1 timesTransacted=3", !!p1 && p1.timesTransacted === 3);
  check("rollup: p1 dominant category = data", !!p1 && p1.category === "data");
  check("rollup: p1 categories include data + search", !!p1 && p1.categories.includes("data") && p1.categories.includes("search"));
  check("rollup: p1 totalSpent = settled only (0.04)", !!p1 && Math.abs(p1.totalSpentUsd - 0.04) < 1e-9);
  check("rollup: p1 internal (vm: prefix)", !!p1 && p1.internal === true);
  check("rollup: sorted most-worked-with first (p1 before p2)", roll[0].supplierId === "vm:p1");
}
{
  // external endpoint counterparty: url: identity, not internal, grouped across rows
  const rows: CounterpartyTxn[] = [
    cpTxn({ counterpartyVmId: null, endpoint: "https://anchor-x402.com/v1/price", category: "data", status: "settled", amountUsd: 0.001 }),
    cpTxn({ counterpartyVmId: null, endpoint: "https://anchor-x402.com/v1/price", category: "data", status: "failed" }),
  ];
  const roll = deriveCounterpartyRollup(rows, { isSameHuman: isSelf });
  check("rollup: external grouped to one url: id", roll.length === 1 && roll[0].supplierId.startsWith("url:"));
  check("rollup: external not internal", roll[0].internal === false);
  check("rollup: external delivered=1, didntGoThrough=1", roll[0].delivered === 1 && roll[0].didntGoThrough === 1);
}

console.log(`\nfrontier-ledger: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
