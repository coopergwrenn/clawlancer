/**
 * Tier-0 G — revoke interdiction (red-team F3), mechanism C.
 *
 * Pure helpers for the revoke flow, kept out of the route so they're unit-testable
 * and so the user-facing honesty is enforced in one place:
 *   - revokeConfirmationCopy(n): the confirmation page text. MUST say "future
 *     spending stopped" + (when n>0) "N pending spend(s) cancelled", and MUST NEVER
 *     imply on-chain money comes back (revoke is not a chargeback) or that a hotel
 *     booking is undone (spend-revoke is not booking-cancel — that's the separate
 *     travala cancel-booking op).
 *   - buildInterdictionEvents(...): one frontier_spend_events row per interdicted
 *     hold (verdict=deny, reason=revoked_in_flight) carrying the hold's
 *     transaction_id + amount so the trace is complete.
 *
 * The interdiction itself (the UPDATE pending→revoked) is in the route: it must be
 * atomic on status='pending' (Postgres serializes it against settle's CAS — whoever
 * locks the row first wins, the other gets 0 rows), so it's expressed as a single
 * guarded UPDATE there. These helpers shape the trace + the copy around it.
 */
import type { getSupabase } from "@/lib/supabase";
import type { SpendEvent } from "@/lib/frontier-spend-log";

type SB = ReturnType<typeof getSupabase>;

/** A hold the interdiction UPDATE actually flipped pending→revoked (UPDATE ... RETURNING). */
export interface InterdictedHold {
  id: string;
  amount_usdc: number | string | null;
}

/**
 * The interdiction itself: one guarded UPDATE flipping every still-pending spend
 * hold for this VM to 'revoked'. Returns the rows that ACTUALLY flipped (the
 * interdicted set) + whether the UPDATE errored.
 *
 * Load-bearing safety: the `.eq("status","pending")` guard is what makes the
 * revoke-vs-settle race safe — settle's CAS guards on the same column, so Postgres
 * row-locking serializes them (whoever locks the row first wins; the loser gets 0
 * rows). NEVER widen this guard.
 *
 * BEST-EFFORT: never throws. A CHECK violation (pre-migration, 'revoked' not yet a
 * legal value) or any error → { holds: [], errored: true } → the caller logs and
 * proceeds (future-spend gate already flipped; no regression). This touches NO
 * on-chain money — it can only stop a hold from settling.
 */
export async function runInterdiction(
  supabase: SB,
  vmId: string,
): Promise<{ holds: InterdictedHold[]; errored: boolean }> {
  try {
    const { data, error } = await supabase
      .from("frontier_transactions")
      .update({ status: "revoked" })
      .eq("vm_id", vmId)
      .eq("direction", "spend")
      .eq("status", "pending")
      .select("id, amount_usdc");
    if (error) return { holds: [], errored: true };
    return { holds: (data ?? []) as InterdictedHold[], errored: false };
  } catch {
    return { holds: [], errored: true };
  }
}

/**
 * One spend-event per interdicted hold. decision_point='authorize' (the interdiction
 * denies a previously-authorized spend); the gate discriminator is reason →
 * 'revoke' (see gateForReason), so H's "revoke didn't interdict" query is
 * `WHERE reason='revoked_in_flight'`.
 */
export function buildInterdictionEvents(
  vmId: string,
  ownerId: string | null,
  holds: InterdictedHold[],
): SpendEvent[] {
  return holds.map((h) => ({
    decision_point: "authorize" as const,
    vm_id: vmId,
    owner_id: ownerId,
    verdict: "deny" as const,
    reason: "revoked_in_flight",
    transaction_id: h.id,
    amount_usd: h.amount_usdc === null ? null : Number(h.amount_usdc),
  }));
}

/**
 * The confirmation page copy. `n` = pending holds actually interdicted (the flipped
 * count, never a guess). Honesty invariants enforced + tested:
 *   - always states future spending is stopped,
 *   - states the exact N cancelled (omits the clause when N=0 — never claims a
 *     cancellation that didn't happen),
 *   - NEVER says/implies money is returned, refunded, or charged back,
 *   - NEVER implies a confirmed booking is undone.
 */
export function revokeConfirmationCopy(n: number): { title: string; body: string } {
  const safeN = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  if (safeN === 0) {
    return {
      title: "Spending turned off",
      body:
        "Autonomous spending for this agent is now off — it will ask before any further payments. " +
        "No spends were in progress to cancel. You can re-enable spending any time from your dashboard.",
    };
  }
  const noun = safeN === 1 ? "payment that hadn't completed yet" : "payments that hadn't completed yet";
  return {
    title: "Spending turned off",
    body:
      `Autonomous spending for this agent is now off, and ${safeN} pending ${noun} ${safeN === 1 ? "was" : "were"} cancelled before it went through. ` +
      "The agent will ask before any further payments. " +
      "Note: this stops payments that hadn't completed — it can't reverse money that already left on-chain, and it doesn't cancel a hotel booking that was already confirmed (use the booking's own cancel for that). " +
      "You can re-enable spending any time from your dashboard.",
  };
}

/**
 * Reconciliation-gap classifier for spend-health coverage: a settle attempt that
 * lost the CAS because the hold was already 'revoked', where the agent had PAID
 * (a tx_hash present, or a paid result). That's the "revoked-but-on-chain-paid"
 * window — the human revoked after the agent already broadcast payment; the money
 * left but the hold won't settle. Surfaced for manual on-chain reconciliation.
 */
export function isRevokedSettleGap(reason: string | null | undefined, txHash: string | null | undefined): boolean {
  return reason === "settle_on_revoked_hold" && typeof txHash === "string" && txHash.length > 0;
}
