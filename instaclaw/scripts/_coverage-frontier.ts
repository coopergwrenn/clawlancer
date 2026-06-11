/**
 * Coverage / health query for the Frontier agent economy (CLAUDE.md Rule 27).
 *
 * One 10-second read that answers "is the economy healthy?": settlement
 * verification coverage, the burn backlog, queue depths, and the two invariants
 * the workers exist to protect — stuck 'burning' claims (burn executor) and
 * orphaned refunds (refund-reconcile sweep). Built alongside the tables/crons
 * so the question never has to be invented under pressure.
 *
 * Run: npx tsx scripts/_coverage-frontier.ts
 * Exit 0 = healthy. Exit 1 = a health invariant is breached (stuck burning rows
 * or orphaned refunds present). Exit 2 = config/env failure.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { aggregateBurnBatch, type BurnQueueRow } from "../lib/frontier-burn";
import { chunk, computeOrphanRefunds } from "../lib/frontier-reconcile";

// Load env from the local checkout (worktree or main), whichever has it.
for (const f of [
  `${process.cwd()}/.env.local`,
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
]) {
  try {
    for (const l of readFileSync(f, "utf-8").split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // optional
  }
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("FATAL: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
  process.exit(2);
}
const sb = createClient(url, key);

const ONCHAIN_RAILS = ["x402", "compute", "base_mcp"];
const STUCK_MS = 30 * 60 * 1000;
// A spend hold's reserve TTL is 15m and an x402 sign+settle round-trip is seconds,
// so a spend still 'pending' after 60m is an orphan — the tool died between
// authorize and settle. Doesn't move money (the reserve ages out of the budget
// window), but a rising count is the canary that the pay→settle leg is breaking.
const STUCK_HOLD_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SCAN_CAP = 5000;

/** exact head count with an optional query builder. -1 on error (surfaced). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function cnt(table: string, build?: (q: any) => any): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = sb.from(table).select("*", { count: "exact", head: true });
  if (build) q = build(q);
  const { count, error } = await q;
  if (error) {
    console.error(`  (count error on ${table}: ${error.code ?? ""} ${error.message})`);
    return -1;
  }
  return count ?? 0;
}

const pct = (n: number, d: number): string => (d <= 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`);
const row = (label: string, value: string | number) => console.log(`  ${label.padEnd(34)} ${value}`);
const hr = (title: string) => console.log(`\n── ${title} ──`);

(async () => {
  let unhealthy = false;
  console.log(`Frontier coverage @ ${new Date().toISOString()}`);

  // ── Transactions ──
  hr("Transactions");
  const txTotal = await cnt("frontier_transactions");
  row("total", txTotal);
  for (const s of ["pending", "settled", "failed", "disputed", "refunded"]) {
    row(`  status=${s}`, await cnt("frontier_transactions", (q) => q.eq("status", s)));
  }
  // Headline Rule-27 metric: on-chain settlement verification coverage.
  const verifiable = await cnt("frontier_transactions", (q) =>
    q.eq("status", "settled").in("rail", ONCHAIN_RAILS).not("tx_hash", "is", null));
  const verified = await cnt("frontier_transactions", (q) =>
    q.eq("status", "settled").in("rail", ONCHAIN_RAILS).not("tx_hash", "is", null).not("verified_on_chain_at", "is", null));
  row("verification coverage", `${verified}/${verifiable} (${pct(verified, verifiable)})`);
  const disputed = await cnt("frontier_transactions", (q) => q.eq("status", "disputed"));
  if (disputed > 0) row("⚠ disputed (forgery/replay/timeout)", disputed);

  // ── Spend health (rollout watch) ──
  // The signals an operator watches as the spend capability rolls to the fleet:
  // are spends completing, how broadly is it in use, and is anything stuck pending
  // (the canary for a broken pay→settle leg). Spend-only, 24h window.
  hr("Spend health (rollout watch)");
  const dayAgo = new Date(Date.now() - DAY_MS).toISOString();
  const spSettled = await cnt("frontier_transactions", (q) =>
    q.eq("direction", "spend").gte("created_at", dayAgo).eq("status", "settled"));
  const spFailed = await cnt("frontier_transactions", (q) =>
    q.eq("direction", "spend").gte("created_at", dayAgo).eq("status", "failed"));
  const spPending = await cnt("frontier_transactions", (q) =>
    q.eq("direction", "spend").gte("created_at", dayAgo).eq("status", "pending"));
  const spTerminal = spSettled + spFailed;
  row("spends 24h (settled/failed/pending)", `${spSettled}/${spFailed}/${spPending}`);
  row("spend success rate 24h", `${spSettled}/${spTerminal} (${pct(spSettled, spTerminal)})`);
  // Distinct active spenders (24h) — how broadly the capability is in use.
  const { data: spVmRows } = await sb
    .from("frontier_transactions")
    .select("vm_id")
    .eq("direction", "spend")
    .gte("created_at", dayAgo)
    .limit(SCAN_CAP);
  row("active spender VMs 24h", new Set((spVmRows ?? []).map((r: { vm_id: string }) => r.vm_id)).size);
  // Stuck spend holds — orphaned reserves (tool died between authorize and settle).
  const stuckHoldCutoff = new Date(Date.now() - STUCK_HOLD_MS).toISOString();
  const stuckHolds = await cnt("frontier_transactions", (q) =>
    q.eq("direction", "spend").eq("status", "pending").lt("created_at", stuckHoldCutoff));
  if (stuckHolds > 0) {
    row("⚠ stuck spend holds > 60m (orphaned)", stuckHolds);
    unhealthy = true;
  }

  // ── Spend authorization (armed population) ──
  // THE blast-radius number (CLAUDE.md Rule 27): how many agents are armed to spend
  // real USDC right now (frontier_spend_enabled=true). This is the population a
  // phase-3 global flip (FRONTIER_REQUIRE_SESSION_APPROVAL_ABOVE_THRESHOLD) acts on,
  // and the population an announce claims is "booking hotels". Default-OFF opt-in, so
  // this set is small — one full-row fetch is cheaper than N counts and gives the whole
  // picture. The load-bearing invariant: armed ∩ terminal-status MUST be 0 (the F4
  // trigger clears frontier_spend_enabled on frozen/terminated); any leak is a revoked
  // agent still carrying spend authority.
  hr("Spend authorization (armed population)");
  const { data: armedRows, error: armedErr } = await sb
    .from("instaclaw_vms")
    .select("id, status, health_status, frontier_lifetime_spent_usdc")
    .eq("frontier_spend_enabled", true)
    .limit(SCAN_CAP);
  if (armedErr) {
    row("(armed query error)", `${armedErr.code ?? ""} ${armedErr.message}`);
  } else {
    const armed = (armedRows ?? []) as {
      id: string;
      status: string | null;
      health_status: string | null;
      frontier_lifetime_spent_usdc: number | null;
    }[];
    row("ARMED total (spend_enabled=true)", armed.length);

    const byStatus = new Map<string, number>();
    const byHealth = new Map<string, number>();
    for (const v of armed) {
      byStatus.set(v.status ?? "null", (byStatus.get(v.status ?? "null") ?? 0) + 1);
      byHealth.set(v.health_status ?? "null", (byHealth.get(v.health_status ?? "null") ?? 0) + 1);
    }
    for (const [s, n] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) {
      row(`  status=${s}`, n);
    }
    for (const [h, n] of [...byHealth.entries()].sort((a, b) => b[1] - a[1])) {
      row(`  health=${h}`, n);
    }

    // F4 invariant: armed ∩ {frozen,terminated} must be 0 — the trigger clears it.
    const terminalLeak = armed.filter((v) => v.status === "frozen" || v.status === "terminated");
    if (terminalLeak.length > 0) {
      row("⚠ ARMED on terminal status (F4 leak)", `${terminalLeak.length} — ${terminalLeak.map((v) => v.id.slice(0, 8)).join(", ")}`);
      unhealthy = true;
    }

    // Who's actually used it: lifetime spend > 0, and active in the last 24h.
    const spentEver = armed.filter((v) => Number(v.frontier_lifetime_spent_usdc ?? 0) > 0).length;
    row("armed w/ lifetime spent > 0", spentEver);
    const armedIds = new Set(armed.map((v) => v.id));
    const active24hSpenders = new Set((spVmRows ?? []).map((r: { vm_id: string }) => r.vm_id));
    const armedActive24h = [...armedIds].filter((id) => active24hSpenders.has(id)).length;
    row("armed active (spent 24h)", armedActive24h);
  }

  // ── Spend approvals (phase-3 unforgeable-consent channel) ──
  // The state machine that backs human_approved hardening. When the phase-3 flip is on
  // (FRONTIER_REQUIRE_SESSION_APPROVAL_ABOVE_THRESHOLD), above-threshold spends mint
  // pending_approval rows here; a rising pending count = users being asked to approve,
  // a rising expired count = asks going unanswered (UX friction signal).
  hr("Spend approvals (phase-3 consent channel)");
  for (const s of ["pending_approval", "approved", "consumed", "denied", "expired"]) {
    row(`status=${s}`, await cnt("instaclaw_frontier_spend_approvals", (q) => q.eq("status", s)));
  }
  // Stuck pending: a pending_approval past its 15m TTL that the expiry path never swept.
  const approvalStuckCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const stuckApprovals = await cnt("instaclaw_frontier_spend_approvals", (q) =>
    q.eq("status", "pending_approval").lt("expires_at", approvalStuckCutoff));
  if (stuckApprovals > 0) row("⚠ pending past TTL (expiry not sweeping)", stuckApprovals);

  // ── Offerings ──
  hr("Offerings");
  row("total", await cnt("frontier_offerings"));
  row("active", await cnt("frontier_offerings", (q) => q.eq("active", true)));

  // ── Treasury burn queue ──
  hr("Treasury burn queue");
  for (const s of ["queued", "burning", "burned", "failed"]) {
    row(`status=${s}`, await cnt("frontier_treasury_burn_queue", (q) => q.eq("status", s)));
  }
  // $ queued (dogfoods aggregateBurnBatch).
  const { data: bq } = await sb
    .from("frontier_treasury_burn_queue")
    .select("id, amount_usdc, source_tag")
    .eq("status", "queued")
    .limit(SCAN_CAP);
  const burnAgg = aggregateBurnBatch((bq ?? []) as BurnQueueRow[]);
  row("$ queued (USDC)", burnAgg.totalUsd);
  // Stuck claims — the burn executor's escalation target.
  const stuckCutoff = new Date(Date.now() - STUCK_MS).toISOString();
  const stuckBurning = await cnt("frontier_treasury_burn_queue", (q) =>
    q.eq("status", "burning").lt("claimed_at", stuckCutoff));
  if (stuckBurning > 0) {
    row("⚠ stuck 'burning' > 30m", stuckBurning);
    unhealthy = true;
  }

  // ── Settlement retry queue ──
  hr("Settlement retry queue");
  for (const s of ["queued", "done", "failed"]) {
    row(`status=${s}`, await cnt("frontier_settlement_retry_queue", (q) => q.eq("status", s)));
  }
  row("queued refunds (owed)", await cnt("frontier_settlement_retry_queue", (q) =>
    q.eq("action", "refund").eq("status", "queued")));

  // ── Orphaned refunds (refund-reconcile sweep target; dogfoods the helper) ──
  hr("Refund orphans");
  const { data: refunded } = await sb
    .from("frontier_transactions")
    .select("id")
    .eq("status", "refunded")
    .order("created_at", { ascending: false })
    .limit(SCAN_CAP);
  const refundedIds = (refunded ?? []).map((r: { id: string }) => r.id);
  const withRetry = new Set<string>();
  for (const ids of chunk(refundedIds, 200)) {
    const { data } = await sb
      .from("frontier_settlement_retry_queue")
      .select("transaction_id")
      .eq("action", "refund")
      .in("transaction_id", ids);
    for (const r of (data ?? []) as { transaction_id: string }[]) withRetry.add(r.transaction_id);
  }
  const orphans = computeOrphanRefunds(refundedIds, withRetry);
  row("refunded scanned", refundedIds.length);
  row("orphaned (flipped, never queued)", orphans.length);
  if (orphans.length > 0) {
    row("⚠ refund orphans present", "run frontier-refund-reconcile");
    unhealthy = true;
  }

  // ── Reputation events ──
  hr("Reputation events");
  for (const s of ["queued", "on_chain", "failed"]) {
    row(`status=${s}`, await cnt("frontier_reputation_events", (q) => q.eq("status", s)));
  }

  // ── Identity / policy / lifetime ──
  hr("Identity / policy / lifetime");
  row("ERC-8004 identities", await cnt("frontier_erc8004_identities"));
  row("policy overrides set", await cnt("frontier_policy_overrides"));
  row("VMs w/ lifetime earned > 0", await cnt("instaclaw_vms", (q) => q.gt("frontier_lifetime_earned_usdc", 0)));
  row("VMs w/ lifetime spent > 0", await cnt("instaclaw_vms", (q) => q.gt("frontier_lifetime_spent_usdc", 0)));

  console.log(`\n${unhealthy ? "✗ UNHEALTHY — investigate the ⚠ rows above" : "✓ healthy"}`);
  process.exit(unhealthy ? 1 : 0);
})().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.message : String(e));
  process.exit(2);
});
