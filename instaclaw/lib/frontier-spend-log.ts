/**
 * Tier-0 A — the verdict logger for the Frontier spend rail.
 *
 * `recordSpendEvent` writes ONE row to `frontier_spend_events` per authorize /
 * settle / refund decision. It is BEST-EFFORT BY DESIGN and the ONE sanctioned
 * fail-open in this lane (per CLAUDE.md Rule 77): the log is telemetry, not the
 * gate. A spend decision must NEVER be denied, delayed, or 500'd because the
 * audit insert hiccupped. So this function:
 *   - never throws (every path is wrapped; a thrown error is swallowed + logged),
 *   - reuses the caller's already-constructed supabase handle (no getSupabase()
 *     here → no client-construction failure inside the log path),
 *   - is called from the route via next/server `after(() => recordSpendEvent(...))`,
 *     so it runs AFTER the response is sent (non-blocking) and is NOT dropped
 *     (Vercel keeps the function alive for `after` callbacks). Fire-and-forget
 *     without `after()` would be dropped on Vercel; awaiting inline would add an
 *     insert round-trip to every spend decision. `after()` is the only correct
 *     mechanism, and it's the established codebase pattern (10+ routes).
 *
 * If the `frontier_spend_events` table doesn't exist yet (the route deploys
 * before the migration is applied — Rule 56 window), the insert errors and is
 * swallowed: zero spend rows until the table lands, zero impact on decisions.
 */
import type { getSupabase } from "@/lib/supabase";

type SB = ReturnType<typeof getSupabase>;

export type SpendDecisionPoint = "authorize" | "settle" | "refund";
export type SpendVerdict =
  | "allow"
  | "deny"
  | "ask"
  | "settle_success"
  | "settle_failed"
  | "settle_disputed"
  | "refund_queued"
  | "error";

/**
 * The flat event a route hands us. Only decision_point / vm_id / verdict are
 * required; everything else is filled with what's in scope at that decision
 * point (an early kill-switch deny has no budget snapshot — those stay null).
 */
export interface SpendEvent {
  decision_point: SpendDecisionPoint;
  vm_id: string;
  verdict: SpendVerdict;
  owner_id?: string | null;
  request_id?: string | null;
  transaction_id?: string | null;
  reason?: string | null;
  gate?: string | null; // omit → derived from reason
  amount_usd?: number | null;
  category?: string | null;
  counterparty?: string | null;
  consent_grade?: string | null;
  mode?: string | null;
  standing_score?: number | null;
  earned_daily_budget_usd?: number | null;
  spent_today_usd?: number | null;
  remaining_earned_after_usd?: number | null;
  wallet_balance_usd?: number | null;
  just_do_it_per_tx_usd?: number | null;
  tier?: string | null;
  tx_hash?: string | null;
  latency_ms?: number | null;
  pay_error?: string | null;
  protocol_fee_usd?: number | null;
  meta?: Record<string, unknown> | null;
}

/**
 * Map a decision `reason` to the GATE that produced it — the column that makes
 * "which gate is denying the most this week" a one-liner. Every reason string is
 * grounded in the actual literals emitted by lib/frontier-authz.ts,
 * lib/frontier-policy.ts, and the authorize/settle/refund routes (verified by
 * grep, not memory). An unmapped reason lands as "other" and is still queryable
 * by the raw `reason` column.
 */
export function gateForReason(reason: string | null | undefined): string {
  switch (reason) {
    // kill switch (authorize route)
    case "spend_kill_switch":
    case "spend_kill_switch_unverifiable":
      return "kill_switch";
    // user opt-in (authorize route)
    case "spend_not_enabled":
      return "opt_in";
    // session-rooted approval (authz + route)
    case "human_approved_session":
    case "needs_session_approval":
    case "human_approved":
    case "approval_identity_mismatch":
      return "session_approval";
    // earned-budget band (authz)
    case "exceeds_earned_budget":
    case "within_earned_budget":
      return "earned_budget";
    // velocity anomaly (authz, Gate 2e)
    case "velocity_anomaly":
      return "velocity_anomaly";
    // category policy (authz)
    case "unknown_category":
      return "policy_category";
    // hard policy denies (frontier-policy.ts evaluation.reason)
    case "privacy_mode":
      return "privacy";
    case "unverified_counterparty":
      return "counterparty";
    case "exceeds_per_tx_ceiling":
    case "exceeds_daily_ceiling":
      return "ceiling";
    case "would_drain_wallet":
      return "wallet_balance";
    case "within_just_do_it_band":
    case "within_ask_first_band":
      return "policy_band";
    // idempotent replay (authorize route)
    case "request_id_consumed":
      return "idempotency";
    // revoke interdiction (Tier-0 G) — the hold the human cancelled, and the
    // settle-attempt against an already-revoked hold (the reconciliation-gap signal).
    case "revoked_in_flight":
    case "settle_on_revoked_hold":
      return "revoke";
    default:
      return "other";
  }
}

/**
 * Best-effort insert of one spend-decision row. NEVER throws. Intended to be
 * invoked from a route via `after(() => recordSpendEvent(supabase, ev))`.
 */
export async function recordSpendEvent(supabase: SB, ev: SpendEvent): Promise<void> {
  try {
    const row = {
      decision_point: ev.decision_point,
      vm_id: ev.vm_id,
      verdict: ev.verdict,
      owner_id: ev.owner_id ?? null,
      request_id: ev.request_id ?? null,
      transaction_id: ev.transaction_id ?? null,
      reason: ev.reason ?? null,
      gate: ev.gate ?? gateForReason(ev.reason),
      amount_usd: ev.amount_usd ?? null,
      category: ev.category ?? null,
      counterparty: ev.counterparty ?? null,
      consent_grade: ev.consent_grade ?? null,
      mode: ev.mode ?? null,
      standing_score: ev.standing_score ?? null,
      earned_daily_budget_usd: ev.earned_daily_budget_usd ?? null,
      spent_today_usd: ev.spent_today_usd ?? null,
      remaining_earned_after_usd: ev.remaining_earned_after_usd ?? null,
      wallet_balance_usd: ev.wallet_balance_usd ?? null,
      just_do_it_per_tx_usd: ev.just_do_it_per_tx_usd ?? null,
      tier: ev.tier ?? null,
      tx_hash: ev.tx_hash ?? null,
      latency_ms: ev.latency_ms ?? null,
      pay_error: ev.pay_error ?? null,
      protocol_fee_usd: ev.protocol_fee_usd ?? null,
      meta: ev.meta ?? null,
    };
    const { error } = await supabase.from("frontier_spend_events").insert(row);
    if (error) {
      console.error("[frontier-spend-log] insert failed (best-effort, ignored):", error.message);
    }
  } catch (e) {
    // Absolute backstop — a malformed handle, a thrown serializer, anything.
    console.error("[frontier-spend-log] recordSpendEvent threw (best-effort, ignored):", e instanceof Error ? e.message : String(e));
  }
}
