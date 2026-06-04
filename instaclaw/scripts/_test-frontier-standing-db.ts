#!/usr/bin/env tsx
/**
 * Consolidation net — coverage for lib/frontier-standing-db.loadVmStanding, the
 * shared standing read that the authorize money-gate is about to call (replacing
 * its inline copy). This test is the safety net for that swap: it pins the FETCH
 * contract loadVmStanding must honor (which is where the gate's standing could
 * silently diverge), and the NEW fail-CLOSED error contract.
 *
 * Why a fetch-layer test (not a re-test of the standing math): loadVmStanding's
 * job is the INPUT fetch + plumbing into the pure pipeline (deriveTrackRecord +
 * creditStanding + reserveAwareSpentTodayUsd). The pure math is exhaustively
 * covered by _test-frontier-standing.ts / _test-frontier-authz.ts / -ledger.ts.
 * The risk this test guards is the fetch: the exact ledger select, RECENT_SCAN_LIMIT,
 * the same-human resolution query, the worldId read, truncation, the empty baseline,
 * and — the reason this consolidation exists — the ledger-read ERROR posture.
 *
 * THE LOAD-BEARING CASE: a ledger-read error throws LedgerReadError. The authorize
 * gate catches it → HTTP 500 (fail CLOSED — never spend as if the agent were fresh
 * on a DB blip); /policy GET's existing try/catch turns it into autonomyError. The
 * pre-fix loadVmStanding swallowed the error (rawRows ?? [] → fresh standing); a
 * blind swap would have flipped the money gate fail-closed → fail-degraded.
 *
 * Idiom mirrors scripts/_test-frontier-routes.ts (capturing mock-supabase, check(),
 * async IIFE — CJS compile, no TLA). Pure + deterministic; no DB / network.
 *
 * Run: npx tsx scripts/_test-frontier-standing-db.ts   (exit 0 = all pass)
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { loadVmStanding, LedgerReadError } from "../lib/frontier-standing-db";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${label}`);
  }
}

// The exact 8-col ledger select the gate uses — the contract loadVmStanding must match.
const LEDGER_COLS =
  "direction, status, amount_usdc, created_at, counterparty_vm_id, counterparty_address, verified_on_chain_at, metadata";

const ARGS = {
  vmId: "vm-1",
  ownerId: "owner-1",
  tier: "starter" as const,
  nowMs: Date.parse("2026-06-02T12:00:00.000Z"),
};

// minimal valid FrontierTxnDbRow
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    direction: "spend",
    status: "settled",
    amount_usdc: 0.5,
    created_at: "2026-06-01T10:00:00.000Z",
    counterparty_vm_id: null,
    counterparty_address: "0xseller",
    verified_on_chain_at: "2026-06-01T10:00:05.000Z",
    metadata: { used: true },
    ...over,
  };
}

// Capturing mock: routes from(table) to the right chain, records every call,
// and resolves the terminal method (limit / in / maybeSingle) with canned data.
function mockStanding(
  opts: { ledger?: { data?: unknown; error?: unknown }; cpVms?: { data?: unknown }; ownerRow?: { data?: unknown } } = {},
): { sb: any; calls: any[] } {
  const calls: any[] = [];
  const sb = {
    from(table: string) {
      if (table === "frontier_transactions") {
        const c: any = {};
        c.select = (s: string) => { calls.push({ table, op: "select", arg: s }); return c; };
        c.eq = (k: string, v: unknown) => { calls.push({ table, op: "eq", k, v }); return c; };
        c.order = (k: string, o: unknown) => { calls.push({ table, op: "order", k, o }); return c; };
        c.limit = async (n: number) => { calls.push({ table, op: "limit", n }); return opts.ledger ?? { data: [] }; };
        return c;
      }
      if (table === "instaclaw_vms") {
        const c: any = {};
        c.select = (s: string) => { calls.push({ table, op: "select", arg: s }); return c; };
        c.in = async (k: string, v: unknown) => { calls.push({ table, op: "in", k, v }); return opts.cpVms ?? { data: [] }; };
        return c;
      }
      if (table === "instaclaw_users") {
        const c: any = {};
        c.select = (s: string) => { calls.push({ table, op: "select", arg: s }); return c; };
        c.eq = (k: string, v: unknown) => { calls.push({ table, op: "eq", k, v }); return c; };
        c.maybeSingle = async () => opts.ownerRow ?? { data: null };
        return c;
      }
      throw new Error("unexpected table " + table);
    },
  };
  return { sb, calls };
}

(async () => {
  // ── happy: valid rows → standing computed; ledger fetch made to the exact contract ──
  {
    const rows = [row(), row({ direction: "earn", amount_usdc: 1 })];
    const { sb, calls } = mockStanding({ ledger: { data: rows }, ownerRow: { data: { world_id_verified: true } } });
    const r = await loadVmStanding(sb, ARGS);
    check("happy: earnedDailyBudgetUsd is finite", typeof r.standing.earnedDailyBudgetUsd === "number" && Number.isFinite(r.standing.earnedDailyBudgetUsd));
    check("happy: spentTodayUsd finite ≥ 0", typeof r.spentTodayUsd === "number" && r.spentTodayUsd >= 0);
    check("happy: truncated false (<500)", r.truncated === false);
    const led = calls.filter((c) => c.table === "frontier_transactions");
    check("happy: ledger select = 8-col contract", led.some((c) => c.op === "select" && c.arg === LEDGER_COLS));
    check("happy: ledger eq vm_id", led.some((c) => c.op === "eq" && c.k === "vm_id" && c.v === "vm-1"));
    check("happy: ledger order created_at desc", led.some((c) => c.op === "order" && c.k === "created_at" && (c.o as any)?.ascending === false));
    check("happy: ledger limit 500", led.some((c) => c.op === "limit" && c.n === 500));
    const usr = calls.filter((c) => c.table === "instaclaw_users");
    check("happy: worldId eq id=ownerId", usr.some((c) => c.op === "eq" && c.k === "id" && c.v === "owner-1"));
    check("happy: worldId select world_id_verified", usr.some((c) => c.op === "select" && String(c.arg).includes("world_id_verified")));
  }

  // ── empty ledger → fresh-agent floor (this is EXACTLY what the swallowed-error path
  //    would have produced — the bug this consolidation closes) ──
  {
    const { sb, calls } = mockStanding({ ledger: { data: [] }, ownerRow: { data: null } });
    const r = await loadVmStanding(sb, ARGS);
    check("empty: earnedDailyBudgetUsd === floor 0.1", r.standing.earnedDailyBudgetUsd === 0.1);
    check("empty: spentTodayUsd === 0", r.spentTodayUsd === 0);
    check("empty: truncated false", r.truncated === false);
    check("empty: no counterparties → instaclaw_vms NOT queried", !calls.some((c) => c.table === "instaclaw_vms"));
  }

  // ── truncation: ≥ 500 rows → truncated true (proves dbRows flows from fetch into the flag) ──
  {
    const rows = Array.from({ length: 500 }, () => row());
    const { sb } = mockStanding({ ledger: { data: rows }, ownerRow: { data: { world_id_verified: true } } });
    const r = await loadVmStanding(sb, ARGS);
    check("truncation: 500 rows → truncated true", r.truncated === true);
  }

  // ── same-human resolution: counterparty_vm_ids from the ledger → instaclaw_vms .in(id, [..]) ──
  {
    const rows = [row({ counterparty_vm_id: "cp-1" }), row({ counterparty_vm_id: "cp-2" }), row({ counterparty_vm_id: "cp-1" })];
    const { sb, calls } = mockStanding({
      ledger: { data: rows },
      cpVms: { data: [{ id: "cp-1", assigned_to: "owner-1" }] },
      ownerRow: { data: { world_id_verified: true } },
    });
    await loadVmStanding(sb, ARGS);
    const vmq = calls.find((c) => c.table === "instaclaw_vms" && c.op === "in");
    check(
      "same-human: instaclaw_vms .in(id, dedup counterparties)",
      !!vmq && vmq.k === "id" && Array.isArray(vmq.v) && vmq.v.length === 2 && vmq.v.includes("cp-1") && vmq.v.includes("cp-2"),
    );
    const vmsel = calls.find((c) => c.table === "instaclaw_vms" && c.op === "select");
    check("same-human: instaclaw_vms select id,assigned_to", !!vmsel && String(vmsel.arg).includes("assigned_to"));
  }

  // ── THE FIX — ledger-read error → throws LedgerReadError (authorize → 500; /policy GET → autonomyError) ──
  {
    const { sb } = mockStanding({ ledger: { error: { code: "PGRST500", message: "boom" } }, ownerRow: { data: null } });
    let threw: unknown = null;
    try {
      await loadVmStanding(sb, ARGS);
    } catch (e) {
      threw = e;
    }
    check("error: ledger read error → throws LedgerReadError (fail-CLOSED contract)", threw instanceof LedgerReadError);
  }

  console.log(`\nfrontier-standing-db: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
