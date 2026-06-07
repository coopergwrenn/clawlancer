/**
 * Frontier — ledger derivations (pure). The single source of "the agent's
 * economic truth" read from `frontier_transactions`.
 *
 * WHY THIS EXISTS (PRD §2, §8.3): the credit-standing engine (frontier-standing),
 * the supplier rolodex (frontier-rolodex), the authorize gate, the score oracle,
 * and the fleet graph ALL need to turn the transaction ledger into economic facts.
 * If each re-derives, they drift — the Rule-14 "reinvented classification" bug
 * class, applied to money. So derivation lives here, once, tested once.
 *
 * AND this is where the wash-trade / sybil integrity lives (PRD §7.3.1 — "any
 * reputation oracle without cost-anchoring is sybil-fragile by design"). Every
 * positive economic signal is filtered here so self-dealing and low-trust
 * counterparties can never inflate standing. If you weaken a filter, you weaken
 * the whole reputation + earned-budget system. Treat as adversarial.
 *
 * PURE: rows in, structs out. No DB, no clock-of-record (caller passes `nowMs`),
 * no network. Trivially testable — see scripts/_test-frontier-ledger.ts.
 *
 * The caller (the authorize endpoint) is responsible for the I/O: fetch the rows,
 * resolve the same-human predicate (counterparty VM → same owner) and the
 * counterparty-score lookup, then hand them to these pure functions.
 */

import { mapTagsToCategory, type SpendCategory } from "./frontier-policy";

/** The subset of a `frontier_transactions` row the derivations read. */
export interface LedgerRow {
  direction: "earn" | "spend";
  status: "pending" | "settled" | "failed" | "disputed" | "refunded";
  amountUsd: number;
  createdAtMs: number;
  /** Fleet-agent counterparty (internal). Null for external Bazaar endpoints. */
  counterpartyVmId: string | null;
  /** Payee/payer wallet (external endpoints + on-chain parties). */
  counterpartyAddress: string | null;
  /** From metadata: the resource URL (external) — half of the supplier identity. */
  endpoint: string | null;
  /** From metadata: capability tags (Bazaar) for category derivation. */
  tags: string[];
  /** From metadata: did the agent actually USE the result? (§7.3.2 good-decision) */
  resultUsed: boolean;
  /** On-chain verified (chain-verify worker stamped verified_on_chain_at). */
  verifiedOnChain: boolean;
}

/** Options the caller wires from the DB (kept out of the pure core for testability). */
export interface DeriveOptions {
  nowMs: number;
  windowMs?: number; // rolling window for spentToday + velocity. Default 24h (aligns with /state).
  /**
   * True if this counterparty is bonded to the SAME World-ID human as the agent
   * (self-dealing). Such rows contribute ZERO to positive standing (§7.3.1 #1).
   * Caller resolves via counterparty_vm_id → instaclaw_vms.assigned_to.
   */
  isSameHuman: (counterpartyVmId: string) => boolean;
  /**
   * The counterparty's own credit score (0–850), for reputation-weighting
   * (§7.3.1 #3 — value = the counterparty's standing). Unknown/external → a
   * conservative floor so trading with zeros can't bootstrap a score.
   */
  counterpartyScore?: (supplierId: string) => number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Reputation-weight floor for unknown/external counterparties (§7.3.1 #3). */
const UNKNOWN_COUNTERPARTY_SCORE = 300; // FICO-floor; trading with zeros ≈ no credit
const REF_SCORE = 700; // a "good" counterparty; weight = score/REF, capped [0.3, 1.5]

/**
 * Canonical supplier identity — the abstraction that makes the spend pipeline
 * indifferent to Bazaar-vs-fleet-agent (PRD §2, Cooper's unified-interface point):
 *   - fleet agent  -> "vm:<counterpartyVmId>"
 *   - external x402 -> "url:<origin+path>" (normalized, query stripped) or "addr:<payTo>"
 */
export function supplierIdOf(row: Pick<LedgerRow, "counterpartyVmId" | "endpoint" | "counterpartyAddress">): string | null {
  if (row.counterpartyVmId) return `vm:${row.counterpartyVmId}`;
  if (row.endpoint) {
    try {
      const u = new URL(row.endpoint);
      return `url:${u.origin}${u.pathname}`.toLowerCase().replace(/\/+$/, "");
    } catch {
      return `url:${row.endpoint.toLowerCase()}`;
    }
  }
  if (row.counterpartyAddress) return `addr:${row.counterpartyAddress.toLowerCase()}`;
  return null;
}

/** Per-supplier reliability stats — the rolodex's raw data (consumed by frontier-rolodex). */
export interface SupplierStat {
  supplierId: string;
  capability: SpendCategory;
  /** successes / attempts (settled vs settled+failed+disputed). */
  successes: number;
  failures: number;
  totalSpentUsd: number;
  avgCostUsd: number;
  lastSeenMs: number;
  /** True if this supplier is a fleet agent (internal A2A) vs external Bazaar. */
  internal: boolean;
}

/**
 * The agent's economic track record — the input to the credit-standing engine.
 * Every field is integrity-filtered (§7.3.1): self-dealing excluded,
 * diversity counted on DISTINCT verified counterparties, reliability
 * reputation-weighted.
 */
export interface TrackRecord {
  // Settlement reliability (FICO 35%) — reputation-weighted, self-dealing excluded.
  qualifyingSettlements: number; // count of settled, non-self-dealt rows
  weightedSettlements: number; // Σ counterparty-rep-weight over settled (cost-anchored)
  failures: number;
  disputes: number;
  // Budget discipline (30%) — historical, not the live spentToday (that's a gate input).
  drainEvents: number; // times it ran the wallet near-empty (proxy: flagged rows) — v1 approximate
  // Tenure (15%)
  firstActivityAtMs: number | null;
  // Activity diversity (10%)
  distinctCounterparties: number; // distinct, verified, non-self-dealt
  distinctCategories: number;
  earns: boolean;
  spends: boolean;
  // Velocity / anomaly (10%)
  newCounterpartiesInWindow: number;
  anomalyFlag: boolean;
  // Identity / integrity
  worldIdVerified: boolean;
  // Earned-budget drivers (§7.3.2 good-decision): settled ∧ used ∧ undisputed ∧ not-self-dealt
  goodDecisions: number;
  wastedOrDisputed: number;
  // Live window (gate input, surfaced here for convenience)
  spentTodayUsd: number;
  earnedTodayUsd: number;
}

function repWeight(score: number): number {
  const w = score / REF_SCORE;
  return Math.max(0.3, Math.min(1.5, w));
}

/**
 * Derive the integrity-filtered track record from a VM's ledger rows.
 * Rows should be the VM's own transactions (any status, any direction).
 */
export function deriveTrackRecord(rows: LedgerRow[], opts: DeriveOptions): TrackRecord {
  const now = opts.nowMs;
  const windowMs = opts.windowMs ?? DAY_MS;
  const cpScore = opts.counterpartyScore ?? (() => UNKNOWN_COUNTERPARTY_SCORE);

  let qualifyingSettlements = 0;
  let weightedSettlements = 0;
  let failures = 0;
  let disputes = 0;
  let goodDecisions = 0;
  let wastedOrDisputed = 0;
  let firstActivityAtMs: number | null = null;
  let earns = false;
  let spends = false;
  let spentTodayUsd = 0;
  let earnedTodayUsd = 0;
  let anomalyFlag = false;

  const distinctCps = new Set<string>();
  const distinctCats = new Set<SpendCategory>();
  const cpFirstSeen = new Map<string, number>();

  for (const r of rows) {
    if (firstActivityAtMs === null || r.createdAtMs < firstActivityAtMs) firstActivityAtMs = r.createdAtMs;
    if (r.direction === "earn") earns = true;
    if (r.direction === "spend") spends = true;

    // Live rolling window (gate convenience).
    if (now - r.createdAtMs <= windowMs && r.status === "settled") {
      if (r.direction === "spend") spentTodayUsd += r.amountUsd;
      else earnedTodayUsd += r.amountUsd;
    }

    // §7.3.1 #1 — self-dealing (same-human counterparty) contributes ZERO to positive signals.
    const selfDealt = !!(r.counterpartyVmId && opts.isSameHuman(r.counterpartyVmId));
    const sid = supplierIdOf(r);

    if (r.status === "failed") failures += selfDealt ? 0 : 1;
    if (r.status === "disputed") {
      disputes += 1; // disputes count against you even if self-dealt
      wastedOrDisputed += 1;
    }

    if (r.status === "settled" && !selfDealt) {
      // §7.3.1 #4 cost-anchoring: only real value to distinct parties; #3 rep-weighting.
      qualifyingSettlements += 1;
      weightedSettlements += sid ? repWeight(cpScore(sid)) : repWeight(UNKNOWN_COUNTERPARTY_SCORE);
      if (sid) {
        distinctCps.add(sid);
        if (!cpFirstSeen.has(sid)) cpFirstSeen.set(sid, r.createdAtMs);
      }
      const cat = mapTagsToCategory(r.tags);
      if (cat) distinctCats.add(cat);
      // §7.3.2 — good decision: settled ∧ used ∧ undisputed ∧ not-self-dealt.
      if (r.resultUsed) goodDecisions += 1;
      else wastedOrDisputed += 1; // settled but never used = wasteful
    }
  }

  // §7.3.1 #5 velocity/anomaly: a burst of brand-new counterparties in the window.
  let newCounterpartiesInWindow = 0;
  for (const [, firstMs] of cpFirstSeen) {
    if (now - firstMs <= windowMs) newCounterpartiesInWindow += 1;
  }
  // Anomaly: many new counterparties relative to total history (circular/farming pattern).
  if (newCounterpartiesInWindow >= 5 && newCounterpartiesInWindow >= distinctCps.size * 0.8) {
    anomalyFlag = true;
  }

  return {
    qualifyingSettlements,
    weightedSettlements,
    failures,
    disputes,
    drainEvents: 0, // v1: drain tracked at the gate (wallet balance), not historically. Approximate.
    firstActivityAtMs,
    distinctCounterparties: distinctCps.size,
    distinctCategories: distinctCats.size,
    earns,
    spends,
    newCounterpartiesInWindow,
    anomalyFlag,
    worldIdVerified: false, // caller sets from AgentBook/World ID; default conservative
    goodDecisions,
    wastedOrDisputed,
    spentTodayUsd,
    earnedTodayUsd,
  };
}

/** Build per-supplier reliability stats for the rolodex (§7.3 — the agent's own memory). */
export function deriveSupplierStats(rows: LedgerRow[], opts: Pick<DeriveOptions, "isSameHuman">): SupplierStat[] {
  const byKey = new Map<string, SupplierStat>();
  for (const r of rows) {
    if (r.direction !== "spend") continue; // suppliers are who we BUY from
    if (r.counterpartyVmId && opts.isSameHuman(r.counterpartyVmId)) continue; // exclude self-dealing
    const sid = supplierIdOf(r);
    if (!sid) continue;
    const cap = mapTagsToCategory(r.tags) ?? "other";
    const key = `${sid}|${cap}`;
    const s = byKey.get(key) ?? {
      supplierId: sid,
      capability: cap,
      successes: 0,
      failures: 0,
      totalSpentUsd: 0,
      avgCostUsd: 0,
      lastSeenMs: 0,
      internal: sid.startsWith("vm:"),
    };
    if (r.status === "settled") {
      s.successes += 1;
      s.totalSpentUsd += r.amountUsd;
    } else if (r.status === "failed" || r.status === "disputed") {
      s.failures += 1;
    }
    s.lastSeenMs = Math.max(s.lastSeenMs, r.createdAtMs);
    byKey.set(key, s);
  }
  for (const s of byKey.values()) {
    s.avgCostUsd = s.successes > 0 ? s.totalSpentUsd / s.successes : 0;
  }
  return [...byKey.values()];
}

// ── per-counterparty relationship rollup (the /economy "who it works with" card) ──

/**
 * The minimal per-transaction input the counterparty rollup reads. The caller
 * maps a frontier_transactions row to this, taking `category` from the SAME
 * source the activity feed renders (metadata.category) so the card and the feed
 * never disagree about what a purchase was.
 */
export interface CounterpartyTxn {
  direction: "earn" | "spend";
  status: LedgerRow["status"];
  amountUsd: number;
  createdAtMs: number;
  counterpartyVmId: string | null;
  counterpartyAddress: string | null;
  endpoint: string | null;
  category: SpendCategory | null;
}

/**
 * One distinct counterparty the agent has worked with, summarized for display:
 * how many times, how many DELIVERED (settled) vs DIDN'T GO THROUGH (failed), what
 * it mostly bought there, and how recently. Identity (`endpoint`/vm/address) is
 * carried so the card derives the SAME label as the feed (serviceLabel).
 */
export interface CounterpartyRollup {
  /** canonical identity (vm:/url:/addr:) — the grouping + dedup key. */
  supplierId: string;
  endpoint: string | null;
  counterpartyVmId: string | null;
  counterpartyAddress: string | null;
  /** dominant (most-transacted) capability — what it mostly bought there. */
  category: SpendCategory;
  /** every capability seen with this counterparty. */
  categories: SpendCategory[];
  /** resolved spend attempts = delivered + didntGoThrough. */
  timesTransacted: number;
  /** settled — "delivered". */
  delivered: number;
  /** failed — "didn't go through". */
  didntGoThrough: number;
  /** total USD settled with this counterparty (real value exchanged). */
  totalSpentUsd: number;
  lastSeenMs: number;
  /** true if a fleet agent (vm:) vs external. */
  internal: boolean;
}

/**
 * Roll the agent's spend ledger up to one row PER COUNTERPARTY (not per
 * supplier×capability like deriveSupplierStats). Spend-side only (suppliers are
 * who we BUY from); self-dealing excluded (§7.3.1 #1 — a counterparty bonded to
 * the agent's own World-ID human can't pad the "relationships"); pending/disputed/
 * refunded rows are not counted in the delivered/didn't-go-through binary (only a
 * clean settled-vs-failed is a reliability signal). Pure: rows in, rollups out.
 */
export function deriveCounterpartyRollup(
  rows: CounterpartyTxn[],
  opts: Pick<DeriveOptions, "isSameHuman">,
): CounterpartyRollup[] {
  interface Acc {
    supplierId: string;
    endpoint: string | null;
    counterpartyVmId: string | null;
    counterpartyAddress: string | null;
    delivered: number;
    didntGoThrough: number;
    totalSpentUsd: number;
    lastSeenMs: number;
    repAtMs: number; // representative-identity recency: pick label from the most recent row
    internal: boolean;
    catCounts: Map<SpendCategory, number>;
  }
  const byId = new Map<string, Acc>();

  for (const r of rows) {
    if (r.direction !== "spend") continue; // suppliers = who we BUY from
    if (r.counterpartyVmId && opts.isSameHuman(r.counterpartyVmId)) continue; // §7.3.1 #1
    const delivered = r.status === "settled";
    const failed = r.status === "failed";
    if (!delivered && !failed) continue; // only resolved attempts are a reliability signal
    const sid = supplierIdOf(r);
    if (!sid) continue;

    let a = byId.get(sid);
    if (!a) {
      a = {
        supplierId: sid,
        endpoint: r.endpoint,
        counterpartyVmId: r.counterpartyVmId,
        counterpartyAddress: r.counterpartyAddress,
        delivered: 0,
        didntGoThrough: 0,
        totalSpentUsd: 0,
        lastSeenMs: 0,
        repAtMs: -1,
        internal: sid.startsWith("vm:"),
        catCounts: new Map(),
      };
      byId.set(sid, a);
    }
    if (delivered) {
      a.delivered += 1;
      a.totalSpentUsd += r.amountUsd;
    } else {
      a.didntGoThrough += 1;
    }
    a.lastSeenMs = Math.max(a.lastSeenMs, r.createdAtMs);
    if (r.createdAtMs >= a.repAtMs) {
      a.repAtMs = r.createdAtMs;
      a.endpoint = r.endpoint;
      a.counterpartyVmId = r.counterpartyVmId;
      a.counterpartyAddress = r.counterpartyAddress;
    }
    const cat = r.category ?? "other";
    a.catCounts.set(cat, (a.catCounts.get(cat) ?? 0) + 1);
  }

  const out: CounterpartyRollup[] = [];
  for (const a of byId.values()) {
    let domCat: SpendCategory = "other";
    let domN = -1;
    const categories: SpendCategory[] = [];
    for (const [cat, n] of a.catCounts) {
      categories.push(cat);
      if (n > domN) {
        domN = n;
        domCat = cat;
      }
    }
    out.push({
      supplierId: a.supplierId,
      endpoint: a.endpoint,
      counterpartyVmId: a.counterpartyVmId,
      counterpartyAddress: a.counterpartyAddress,
      category: domCat,
      categories,
      timesTransacted: a.delivered + a.didntGoThrough,
      delivered: a.delivered,
      didntGoThrough: a.didntGoThrough,
      totalSpentUsd: Math.round(a.totalSpentUsd * 1e6) / 1e6,
      lastSeenMs: a.lastSeenMs,
      internal: a.internal,
    });
  }
  out.sort((x, y) => y.timesTransacted - x.timesTransacted || y.lastSeenMs - x.lastSeenMs);
  return out;
}
