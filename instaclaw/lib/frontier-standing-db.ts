/**
 * Frontier — load a VM's LIVE credit standing for read-only surfaces (the
 * dashboard). Mirrors EXACTLY the standing-input pipeline in
 * app/api/agent-economy/authorize/route.ts so the number the dashboard shows is
 * the SAME number the gate enforces — no stale rollup column, no drift.
 *
 * The computation itself is the pure `deriveTrackRecord` + `creditStanding` (same
 * functions the gate calls), so the two paths can only ever differ in their INPUT
 * fetch. This helper keeps that fetch faithful to the gate's, INCLUDING the
 * fail-CLOSED posture on a ledger-read error (it throws `LedgerReadError` rather
 * than swallow the error into an empty ledger — see below):
 *   1. recent ledger rows (same select, same RECENT_SCAN_LIMIT; read error ⇒ throw)
 *   2. same-human resolution (§7.3.1 #1 — counterparty VMs sharing the owner)
 *   3. owner World-ID verification (the sybil root of trust; unverified ⇒ capped)
 *
 * NOTE (consolidation follow-up, ops-followups): the authorize route still has
 * its own inline copy of this block. They use the same pure functions so the
 * COMPUTATION can't drift; only this fetch could. If you edit the gate's ledger
 * select / isSameHuman / worldId logic, mirror it here (and vice-versa) — or
 * better, refactor the gate to call this helper.
 */
import {
  toLedgerRow,
  reserveAwareSpentTodayUsd,
  type FrontierTxnDbRow,
} from "./frontier-ledger-db";
import { deriveTrackRecord } from "./frontier-ledger";
import { creditStanding, type CreditStanding } from "./frontier-standing";
import type { FrontierTier } from "./frontier-policy";

// Recent rows scanned for standing + reserve. MUST match RECENT_SCAN_LIMIT in
// app/api/agent-economy/authorize/route.ts (currently 500).
const RECENT_SCAN_LIMIT = 500;

const LEDGER_SELECT =
  "direction, status, amount_usdc, created_at, counterparty_vm_id, counterparty_address, verified_on_chain_at, metadata";

export interface VmStanding {
  standing: CreditStanding;
  /** Reserve-aware committed-today USD (settled + fresh holds) — the gate's spentToday. */
  spentTodayUsd: number;
  /** True if the VM has ≥ RECENT_SCAN_LIMIT rows (standing slightly understated). */
  truncated: boolean;
}

/**
 * Thrown when the recent-ledger read fails. Surfaced (not swallowed) so callers
 * match the gate's fail-CLOSED posture: on a transient DB error we do NOT know the
 * VM's true standing, so the authorize gate must return 500 (never let an
 * earned-budget agent spend as if it were fresh). Read-only dashboard callers
 * (/policy GET) catch it and degrade to an `autonomyError` snapshot.
 */
export class LedgerReadError extends Error {
  constructor(readonly dbError: unknown) {
    super("frontier ledger read failed");
    this.name = "LedgerReadError";
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function loadVmStanding(
  supabase: any,
  args: { vmId: string; ownerId: string; tier: FrontierTier; nowMs: number },
): Promise<VmStanding> {
  const { vmId, ownerId, tier, nowMs } = args;

  // 1. recent ledger (same select + limit as the gate). A read error is SURFACED,
  //    not swallowed: a swallowed error → `rawRows ?? []` → fresh-agent standing
  //    would let the authorize gate spend an earned-budget agent as if brand-new on
  //    a transient DB blip. Throwing lets the gate fail CLOSED (500) and /policy GET
  //    degrade to autonomyError. (Matches the gate's prior inline `if (rowsErr) 500`.)
  const { data: rawRows, error: rowsErr } = await supabase
    .from("frontier_transactions")
    .select(LEDGER_SELECT)
    .eq("vm_id", vmId)
    .order("created_at", { ascending: false })
    .limit(RECENT_SCAN_LIMIT);
  if (rowsErr) throw new LedgerReadError(rowsErr);
  const dbRows = (rawRows ?? []) as FrontierTxnDbRow[];

  // 2. same-human resolution — which counterparty VMs share our owner (self-dealing).
  const counterpartyVmIds = Array.from(
    new Set(dbRows.map((r) => r.counterparty_vm_id).filter((id): id is string => !!id)),
  );
  const sameHumanVms = new Set<string>();
  if (counterpartyVmIds.length > 0) {
    const { data: cpVms } = await supabase
      .from("instaclaw_vms")
      .select("id, assigned_to")
      .in("id", counterpartyVmIds);
    for (const cp of cpVms ?? []) {
      if (cp.assigned_to && cp.assigned_to === ownerId) sameHumanVms.add(cp.id as string);
    }
  }
  const isSameHuman = (id: string) => sameHumanVms.has(id);

  // 3. owner World-ID verification (missing row ⇒ unverified ⇒ capped at audit/500).
  const { data: ownerRow } = await supabase
    .from("instaclaw_users")
    .select("world_id_verified")
    .eq("id", ownerId)
    .maybeSingle();
  const ownerWorldIdVerified = ownerRow?.world_id_verified === true;

  // pure pipeline — identical to the gate
  const ledgerRows = dbRows.map(toLedgerRow);
  const trackRecord = {
    ...deriveTrackRecord(ledgerRows, { nowMs, isSameHuman }),
    worldIdVerified: ownerWorldIdVerified,
  };
  const standing = creditStanding(trackRecord, tier, { nowMs, isStaker: false });
  const spentTodayUsd = reserveAwareSpentTodayUsd(dbRows, { nowMs });

  return { standing, spentTodayUsd, truncated: dbRows.length >= RECENT_SCAN_LIMIT };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
