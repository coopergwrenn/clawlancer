#!/usr/bin/env tsx
/**
 * THE FEEDBACK-LOOP PROOF (Cooper's self-audit).
 *
 * Not a unit test — an end-to-end proof that the economic-agency loop actually
 * closes. It runs the EXACT pure pipeline the /authorize and /settle routes run
 * (toLedgerRow → deriveTrackRecord → creditStanding → reserveAwareSpentTodayUsd
 * → evaluateSpend → decideAuthorization) over an evolving ledger, and proves:
 *
 *   1. graduated autonomy — a new agent can't auto-spend $1, then EARNS the
 *      right to as it accumulates good decisions (authorize → settle → re-authorize).
 *   2. a BAD settle (failures/disputes) actually shrinks the earned budget,
 *      flipping a spend that was autonomous back to ask_first.
 *   3. a human-BANNED category is blocked even for a high-standing agent.
 *   4. WASH-TRADING buys nothing — the same 60 "good" decisions, but self-dealt,
 *      leave the budget at the floor. (Side-by-side with scenario 1.)
 *   5. the stateful loop — authorize reserves a pending hold, settle flips it,
 *      the next authorize reads it back — drives the budget UP monotonically.
 *
 * Run: npx tsx scripts/_test-frontier-feedback-loop.ts  (exit 0 = all pass)
 */
import { deriveTrackRecord } from "../lib/frontier-ledger";
import { creditStanding } from "../lib/frontier-standing";
import {
  evaluateSpend,
  DEFAULT_ALLOWED_CATEGORIES_BY_TIER,
  type FrontierTier,
  type SpendCategory,
} from "../lib/frontier-policy";
import { toLedgerRow, reserveAwareSpentTodayUsd, type FrontierTxnDbRow } from "../lib/frontier-ledger-db";
import { decideAuthorization, type AuthorizationDecision } from "../lib/frontier-authz";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ FAIL: ${label}`); }
}

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const TIER: FrontierTier = "pro";

// ── A tiny in-memory ledger that behaves like the route's reads/writes ──
interface Sim { rows: FrontierTxnDbRow[]; }
function newSim(): Sim { return { rows: [] }; }

interface AuthorizeArgs {
  amountUsd: number;
  category?: SpendCategory | null;
  tags?: string[];
  humanApproved?: boolean;
  walletBalanceUsd?: number | null;
  counterpartyVmId?: string | null;
  counterpartyAddress?: string | null;
  endpoint?: string | null;
  sameHumanVms?: Set<string>;
}

/** Run the exact authorize pipeline. Returns the decision + the earned budget seen. */
function authorize(sim: Sim, a: AuthorizeArgs): { decision: AuthorizationDecision; earned: number; score: number } {
  const sameHuman = a.sameHumanVms ?? new Set<string>();
  const ledgerRows = sim.rows.map(toLedgerRow);
  const trackRecord = {
    ...deriveTrackRecord(ledgerRows, { nowMs: NOW, isSameHuman: (id) => sameHuman.has(id) }),
    worldIdVerified: true,
  };
  const standing = creditStanding(trackRecord, TIER, { nowMs: NOW, isStaker: false });
  const reserveAware = reserveAwareSpentTodayUsd(sim.rows, { nowMs: NOW });
  const category = a.category === undefined ? "data" : a.category;
  const evaluation = evaluateSpend(TIER, {
    amountUsd: a.amountUsd,
    spentTodayUsd: reserveAware,
    walletBalanceUsd: a.walletBalanceUsd === undefined ? 1000 : a.walletBalanceUsd,
    privacyModeOn: false,
    counterpartyVerified: true,
    isStaker: false,
    requireVerifiedCounterparty: false,
    overrides: null,
    category: category ?? undefined,
    allowedCategories: DEFAULT_ALLOWED_CATEGORIES_BY_TIER[TIER],
  });
  const decision = decideAuthorization({
    evaluation,
    standing,
    reserveAwareSpentTodayUsd: reserveAware,
    amountUsd: a.amountUsd,
    humanApproved: a.humanApproved ?? false,
    categoryKnown: category !== null,
  });
  return { decision, earned: standing.earnedDailyBudgetUsd, score: standing.score };
}

let seq = 0;
/** Seed a completed decision directly into history (settled/failed/disputed). */
function seed(sim: Sim, p: {
  status: "settled" | "failed" | "disputed";
  direction?: "earn" | "spend";
  amount?: number;
  cpVm?: string | null;
  cpAddr?: string | null;
  category?: SpendCategory;
  used?: boolean;
  daysAgo: number;
}): void {
  sim.rows.push({
    direction: p.direction ?? "spend",
    status: p.status,
    amount_usdc: p.amount ?? 0.05,
    created_at: new Date(NOW - p.daysAgo * DAY).toISOString(),
    counterparty_vm_id: p.cpVm ?? null,
    counterparty_address: p.cpAddr ?? null,
    verified_on_chain_at: p.status === "settled" ? new Date(NOW - p.daysAgo * DAY).toISOString() : null,
    metadata: { tags: [], category: p.category ?? "data", result_used: p.used ?? false, endpoint: p.cpAddr ? `https://sup${seq}.x/p` : null },
  });
  seq++;
}

/** Build a legitimate good-history agent: n good decisions, diverse, tenured. */
function seedLegitGoodHistory(sim: Sim, n: number): void {
  const cats: SpendCategory[] = ["data", "search", "agent", "inference"];
  for (let i = 0; i < n; i++) {
    seed(sim, {
      status: "settled",
      direction: "spend",
      amount: 0.05,
      cpVm: `peer-${i % 12}`, // 12 distinct legit counterparties
      category: cats[i % cats.length],
      used: true,
      daysAgo: 2 + i, // spread 2..(n+1) days ago — none in the 24h window (no anomaly)
    });
  }
  // two-sidedness: a few earns
  for (let i = 0; i < 5; i++) seed(sim, { status: "settled", direction: "earn", amount: 0.2, cpVm: `buyer-${i}`, category: "agent", used: true, daysAgo: 5 + i });
}

// ════════════════════════════════════════════════════════════════════
console.log("\nSCENARIO 1 — graduated autonomy: a new agent EARNS the right to spend");
// ════════════════════════════════════════════════════════════════════
{
  const sim = newSim();
  const before = authorize(sim, { amountUsd: 1 });
  check(`new agent earned budget is at the floor ($${before.earned})`, before.earned <= 0.2);
  check("new agent: $1 autonomous spend → ask_first", before.decision.outcome === "ask_first");
  check("new agent: reason is exceeds_earned_budget", before.decision.reason === "exceeds_earned_budget");

  seedLegitGoodHistory(sim, 60);
  const after = authorize(sim, { amountUsd: 1 });
  check(`seasoned agent earned budget grew (>$1, was $${before.earned} → $${after.earned})`, after.earned > 1);
  check("seasoned agent: $1 autonomous spend → authorized", after.decision.authorized === true);
  check("seasoned agent: mode autonomous", after.decision.mode === "autonomous");
  check(`score climbed (${before.score} → ${after.score})`, after.score > before.score);
}

// ════════════════════════════════════════════════════════════════════
console.log("\nSCENARIO 2 — a BAD settle shrinks the budget (autonomous → ask_first)");
// ════════════════════════════════════════════════════════════════════
{
  const sim = newSim();
  seedLegitGoodHistory(sim, 60);
  // A $3 spend the seasoned agent can make autonomously (within both the per-tx band and earned budget).
  const good = authorize(sim, { amountUsd: 3 });
  check(`good agent can auto-spend $3 (earned $${good.earned})`, good.decision.authorized === true);

  // A wave of disputes/failures — bad settles.
  for (let i = 0; i < 200; i++) seed(sim, { status: i % 2 ? "disputed" : "failed", cpVm: `peer-${i % 12}`, category: "data", daysAgo: 1 + (i % 30) });
  const bad = authorize(sim, { amountUsd: 3 });
  // The budget collapses ~90% (e.g. $18 → ~$2) and the level demotes automate→assist.
  // The SAME spend that was autonomous is now bounced to the human — the bad settles
  // measurably revoked autonomy. (Note: the floor stays a couple dollars for an agent
  // with 60 real good decisions — graduated autonomy is forgiving by design; one bad
  // wave sharply reduces but doesn't zero an established record. Tuning the
  // adversarial-decay curve harder is a standing-engine knob, tracked separately.)
  check(`earned budget shrank sharply after bad settles ($${good.earned} → $${bad.earned})`, bad.earned < good.earned * 0.5);
  check("the same $3 spend that was autonomous is now ask_first", bad.decision.outcome === "ask_first");
  check(`score fell (${good.score} → ${bad.score})`, bad.score < good.score);
}

// ════════════════════════════════════════════════════════════════════
console.log("\nSCENARIO 3 — a human-BANNED category is blocked even at high standing");
// ════════════════════════════════════════════════════════════════════
{
  const sim = newSim();
  seedLegitGoodHistory(sim, 60);
  const dataBuy = authorize(sim, { amountUsd: 0.5, category: "data" });
  check("high-standing agent CAN auto-buy an allowed category (data)", dataBuy.decision.authorized === true);
  const marketBuy = authorize(sim, { amountUsd: 0.5, category: "market" }); // 'market' excluded from every tier default
  check("'market' (opt-in only) → denied", marketBuy.decision.outcome === "deny");
  check("denied reason is category_not_allowed", marketBuy.decision.reason === "category_not_allowed");
  const unknownBuy = authorize(sim, { amountUsd: 0.5, category: null }); // unidentifiable category
  check("unknown category → ask_first (not deny, not auto)", unknownBuy.decision.outcome === "ask_first");
  check("unknown-category reason is unknown_category", unknownBuy.decision.reason === "unknown_category");
}

// ════════════════════════════════════════════════════════════════════
console.log("\nSCENARIO 4 — WASH-TRADING buys nothing (vs scenario 1, same 60 decisions)");
// ════════════════════════════════════════════════════════════════════
{
  const sim = newSim();
  const washVm = "sock-puppet-vm";
  const sameHuman = new Set([washVm]);
  // 60 "good" settled+used decisions — but ALL to a counterparty owned by the same human.
  for (let i = 0; i < 60; i++) seed(sim, { status: "settled", amount: 0.05, cpVm: washVm, category: "data", used: true, daysAgo: 2 + i });
  const washed = authorize(sim, { amountUsd: 1, sameHumanVms: sameHuman });
  check(`self-dealing left the budget at the floor ($${washed.earned})`, washed.earned <= 0.2);
  check("wash-trader: $1 spend still ask_first (autonomy not bought)", washed.decision.outcome === "ask_first");

  // Control: the IDENTICAL volume against legit distinct counterparties → autonomy earned.
  const legit = newSim();
  for (let i = 0; i < 60; i++) seed(legit, { status: "settled", amount: 0.05, cpVm: `real-${i % 12}`, category: ["data", "search", "agent"][i % 3] as SpendCategory, used: true, daysAgo: 2 + i });
  for (let i = 0; i < 5; i++) seed(legit, { status: "settled", direction: "earn", amount: 0.2, cpVm: `b-${i}`, used: true, daysAgo: 5 + i });
  const legitDec = authorize(legit, { amountUsd: 1 });
  check(`legit same-volume agent earned real budget ($${legitDec.earned})`, legitDec.earned > washed.earned);
  check("legit agent: $1 → authorized (the contrast)", legitDec.decision.authorized === true);
}

// ════════════════════════════════════════════════════════════════════
console.log("\nSCENARIO 5 — the stateful loop: authorize reserves, settle flips, budget climbs");
// ════════════════════════════════════════════════════════════════════
{
  const sim = newSim();
  // A larger spend that a brand-new agent cannot auto-make.
  const t0 = authorize(sim, { amountUsd: 0.5 });
  check("t0: new agent cannot auto-spend $0.50", t0.decision.outcome === "ask_first");

  // Run the real loop: authorize a small spend → reserve a pending hold → settle good.
  const budgets: number[] = [];
  for (let i = 0; i < 40; i++) {
    const a = authorize(sim, { amountUsd: 0.05, counterpartyVmId: `loop-peer-${i % 10}`, category: (["data", "search", "agent"] as SpendCategory[])[i % 3] });
    if (a.decision.authorized) {
      // /authorize would insert a pending hold:
      const reqId = `loop-${i}`;
      sim.rows.push({
        direction: "spend", status: "pending", amount_usdc: 0.05,
        created_at: new Date(NOW - (1 + i) * DAY).toISOString(),
        counterparty_vm_id: `loop-peer-${i % 10}`, counterparty_address: null, verified_on_chain_at: null,
        metadata: { request_id: reqId, tags: [], category: (["data", "search", "agent"] as SpendCategory[])[i % 3], result_used: false },
      });
      // /settle would flip pending→settled and record result_used:
      const hold = sim.rows[sim.rows.length - 1];
      hold.status = "settled";
      hold.verified_on_chain_at = new Date(NOW - (1 + i) * DAY).toISOString();
      (hold.metadata as Record<string, unknown>).result_used = true;
    }
    if (i % 10 === 9) budgets.push(authorize(sim, { amountUsd: 0.05 }).earned);
  }
  check("budget climbed monotonically across the loop", budgets.every((b, i) => i === 0 || b >= budgets[i - 1]));
  check(`budget grew end-to-end ($${budgets[0]} → $${budgets[budgets.length - 1]})`, budgets[budgets.length - 1] > budgets[0]);

  const tN = authorize(sim, { amountUsd: 0.5 });
  check("tN: after 40 good settled loops, $0.50 is now autonomous", tN.decision.authorized === true);
  check("tN: mode autonomous (it earned it)", tN.decision.mode === "autonomous");

  // Reserve mechanics: a fresh pending hold is counted by the next authorize.
  const beforeReserve = reserveAwareSpentTodayUsd(sim.rows, { nowMs: NOW });
  sim.rows.push({
    direction: "spend", status: "pending", amount_usdc: 0.04, created_at: new Date(NOW - 60_000).toISOString(),
    counterparty_vm_id: "fresh-peer", counterparty_address: null, verified_on_chain_at: null, metadata: { result_used: false },
  });
  const afterReserve = reserveAwareSpentTodayUsd(sim.rows, { nowMs: NOW });
  check("a fresh pending hold immediately consumes reserve", Math.abs(afterReserve - beforeReserve - 0.04) < 1e-9);
}

console.log(`\nfeedback-loop: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
