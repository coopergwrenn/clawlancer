/**
 * frontier-economy-readpath — the pure read-path logic behind the /economy
 * dashboard: the standing-tone decision (the honesty gate) and the row→shape
 * mappers the /state and /counterparties routes return.
 *
 * Everything here is a pure lift out of a component or route handler, kept
 * byte-equivalent to the inline logic it replaced so the surface renders
 * identically. The point of the lift is testability (these are the bits that
 * silently LIE — the gate if the standing computation drifts, the mappers if a
 * DB column is renamed) without a browser. Covered by
 * scripts/_test-economy-readpath.ts.
 *
 * NO React / motion imports — importable by client components AND the tsx test.
 */
import type { SpendCategory } from "@/lib/frontier-policy";
import type { CounterpartyTxn } from "@/lib/frontier-ledger";

// ─────────────────────────────────────────────────────────────────────────────
// Tier 1 — the standing-tone decision (the ≥550 honesty gate)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Leaving the "audit" level (frontier-standing.ts). UNVERIFIED_CAP=500 < this,
 * so score >= 550 ⟹ the agent is BOTH World-ID-verified AND above the audit
 * baseline — the only state where "earned" language is honest. A brand-new
 * agent computes to ~438; an unverified one is capped at 500. Both are below 550.
 */
export const EARNED_THRESHOLD = 550;

/**
 * The SINGLE source of the hero/card "how do we describe this standing" decision.
 * Both the active hero and the inline Standing card call this, so they can never
 * tell contradicting stories — not even in logic, not just in the threshold.
 *
 *  - "degraded": standing is unknown (read failed / not yet computed). Show no
 *    number, "updating". Never a fake value.
 *  - "earned": score >= 550 — verified AND above baseline. "earned" language ok.
 *  - "building": has a number but below 550 (incl. the 500 unverified cap and the
 *    438 floor). An honest starting point — "building from here", NEVER "earned".
 */
export function standingTone(score: number | null | undefined): "earned" | "building" | "degraded" {
  if (score == null) return "degraded";
  if (score >= EARNED_THRESHOLD) return "earned";
  return "building";
}

// ─────────────────────────────────────────────────────────────────────────────
// shared numeric coercion (PostgREST returns numeric columns as strings)
// ─────────────────────────────────────────────────────────────────────────────

function num(v: number | string | null | undefined): number {
  const n = typeof v === "string" ? parseFloat(v) : v ?? 0;
  return Number.isFinite(n as number) ? (n as number) : 0;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

// ─────────────────────────────────────────────────────────────────────────────
// Tier 2a — /state recent-row mapping + window aggregation
// ─────────────────────────────────────────────────────────────────────────────

const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface StateTxnRow {
  id: string;
  rail: string;
  direction: "earn" | "spend";
  amount_usdc: number | string; // PostgREST returns numeric as string
  protocol_fee_usdc: number | string;
  status: string;
  counterparty_address: string | null;
  counterparty_vm_id: string | null;
  response_summary: string | null;
  tx_hash: string | null;
  created_at: string;
  settled_at: string | null;
  metadata: Record<string, unknown> | null;
}

// Decision-context extractors from the authorize-time metadata jsonb. Guarded —
// metadata shape is owned by the spend skill and may be partial on older rows.
const mStr = (m: Record<string, unknown>, k: string): string | null =>
  typeof m[k] === "string" && (m[k] as string).trim() !== "" ? (m[k] as string) : null;
const mNum = (m: Record<string, unknown>, k: string): number | null => {
  const v = m[k];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const mBool = (m: Record<string, unknown>, k: string): boolean | null =>
  typeof m[k] === "boolean" ? (m[k] as boolean) : null;

/**
 * One transaction row → one activity-feed entry. The agent's economic state at
 * the moment it decided (standing + earned budget + outcome) is lifted out of
 * metadata so a row reads like a decision, not a line item.
 */
export function mapRecentTxn(r: StateTxnRow) {
  const m = (r.metadata ?? {}) as Record<string, unknown>;
  return {
    id: r.id,
    rail: r.rail,
    direction: r.direction,
    amount_usdc: round6(num(r.amount_usdc)),
    protocol_fee_usdc: round6(num(r.protocol_fee_usdc)),
    status: r.status,
    counterparty_address: r.counterparty_address,
    counterparty_vm_id: r.counterparty_vm_id,
    response_summary: r.response_summary,
    tx_hash: r.tx_hash,
    created_at: r.created_at,
    settled_at: r.settled_at,
    // decision context — the agent's economic state at the moment it decided
    category: mStr(m, "category"),
    mode: mStr(m, "mode"),
    result_used: mBool(m, "result_used"),
    standing_at_decision: mNum(m, "score_at_authorize"),
    earned_budget_at_decision: mNum(m, "earned_budget_at_authorize"),
    latency_ms: mNum(m, "latency_ms"),
    endpoint: mStr(m, "endpoint"),
    pay_error: mStr(m, "pay_error"),
  };
}

export interface EconomyWindows {
  window_24h: { earned_usdc: number; spent_usdc: number; net_usdc: number; transactions: number };
  lifetime: { earned_usdc: number; spent_usdc: number; net_usdc: number; truncated: boolean };
  // True once the agent has any settled earn/spend — gates whether reputation is
  // surfaced (a brand-new agent stays null so the first-run copy is preserved).
  hasTrackRecord: boolean;
}

/**
 * Rolling-24h + lifetime earn/spend/net from a single bounded fetch. Money
 * counts status='settled' only (refunded/failed/pending/disputed appear in the
 * feed but not the totals). `truncated` flags the (currently unreachable) scan
 * cap so the dashboard can fall back to rollup columns once volume grows.
 */
export function aggregateWindows(
  rows: readonly StateTxnRow[],
  nowMs: number,
  scanLimit: number,
): EconomyWindows {
  const since = nowMs - WINDOW_MS;
  let earned24h = 0, spent24h = 0, count24h = 0;
  let earnedLife = 0, spentLife = 0;
  for (const r of rows) {
    if (r.status !== "settled") continue;
    const amt = num(r.amount_usdc);
    const inWindow = Date.parse(r.created_at) >= since;
    if (r.direction === "earn") {
      earnedLife += amt;
      if (inWindow) { earned24h += amt; count24h++; }
    } else {
      spentLife += amt;
      if (inWindow) { spent24h += amt; count24h++; }
    }
  }
  return {
    window_24h: {
      earned_usdc: round6(earned24h),
      spent_usdc: round6(spent24h),
      net_usdc: round6(earned24h - spent24h),
      transactions: count24h,
    },
    lifetime: {
      earned_usdc: round6(earnedLife),
      spent_usdc: round6(spentLife),
      net_usdc: round6(earnedLife - spentLife),
      truncated: rows.length >= scanLimit,
    },
    hasTrackRecord: earnedLife > 0 || spentLife > 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier 2b — /counterparties row → rollup input mapping
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORIES: readonly SpendCategory[] = [
  "data",
  "search",
  "inference",
  "compute",
  "market",
  "media",
  "agent",
  "other",
];

const CP_STATUSES = ["pending", "settled", "failed", "disputed", "refunded"] as const;

export interface CounterpartyDbRow {
  direction: "earn" | "spend";
  status: string;
  amount_usdc: number | string; // PostgREST returns numeric as string
  created_at: string;
  counterparty_vm_id: string | null;
  counterparty_address: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * One DB row → the pure rollup's input. `category` from metadata.category (the
 * feed's source, validated against the allow-list); `endpoint` from
 * metadata.endpoint (the label's source). An unrecognized status normalizes to
 * "failed" (conservative — an unknown outcome is not a delivery).
 */
export function mapCounterpartyTxn(r: CounterpartyDbRow): CounterpartyTxn {
  const m = (r.metadata ?? {}) as Record<string, unknown>;
  const rawCat = typeof m.category === "string" ? (m.category as string) : null;
  const category = rawCat && (CATEGORIES as readonly string[]).includes(rawCat)
    ? (rawCat as SpendCategory)
    : null;
  const endpoint = typeof m.endpoint === "string" && m.endpoint.trim() !== "" ? (m.endpoint as string) : null;
  return {
    direction: r.direction === "earn" ? "earn" : "spend",
    status: (CP_STATUSES as readonly string[]).includes(r.status)
      ? (r.status as CounterpartyTxn["status"])
      : "failed",
    amountUsd: num(r.amount_usdc),
    createdAtMs: Date.parse(r.created_at),
    counterpartyVmId: r.counterparty_vm_id,
    counterpartyAddress: r.counterparty_address,
    endpoint,
    category,
  };
}
