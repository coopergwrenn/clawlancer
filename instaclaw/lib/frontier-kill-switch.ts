/**
 * Frontier spend kill switch — the "oh god something's wrong at 2am" emergency stop.
 *
 * When a supplier turns malicious, a gate bug ships, or spend behaves wrong fleet-wide,
 * this halts ALL autonomous spend across every VM INSTANTLY — no deploy, no env change,
 * no reconcile. It's a single row in the existing `instaclaw_admin_settings` key/value
 * table, read by /authorize on every call:
 *
 *   ENGAGE (stop the bleeding):
 *     INSERT INTO instaclaw_admin_settings (setting_key, bool_value, notes)
 *     VALUES ('frontier_spend_kill_switch', true, 'why')
 *     ON CONFLICT (setting_key) DO UPDATE SET bool_value=true, updated_at=now(), notes=EXCLUDED.notes;
 *
 *   RELEASE:
 *     UPDATE instaclaw_admin_settings SET bool_value=false, updated_at=now()
 *     WHERE setting_key='frontier_spend_kill_switch';
 *
 * The next /authorize anywhere in the fleet sees the new value (no caching — instant by
 * design). When engaged, authorize returns deny(spend_kill_switch) for EVERY spend,
 * overriding even human_approved — it is an emergency stop, not a policy band.
 *
 * FAIL-CLOSED on read error (Tier-0 F, 2026-06-11): if the switch state cannot be read
 * (still erroring after one retry), authorize denies with `spend_kill_switch_unverifiable`.
 * The prior fail-OPEN had a hole — a transient blip on this read that recovered before the
 * downstream ledger read let an ENGAGED switch be bypassed for that request. On a money
 * rail under load, a false deny (agent retries) is far cheaper than a false allow. The
 * deny reason distinguishes "engaged" (operator stopped it) from "unverifiable" (we went
 * blind) so an operator can tell whether the brake is on or the DB is sick. See
 * lib/kill-switch-core.ts for the shared fail-closed reader.
 */
import type { getSupabase } from "@/lib/supabase";
import { readKillSwitchState, type KillSwitchState } from "@/lib/kill-switch-core";

export const FRONTIER_SPEND_KILL_KEY = "frontier_spend_kill_switch";

type SB = ReturnType<typeof getSupabase>;

/**
 * Diagnostic state of the frontier spend kill switch. "engaged" | "clear" |
 * "unverifiable". Prefer this at the authorize call site so the deny reason can
 * distinguish a deliberate stop from a blind read (both deny — only "clear" allows).
 */
export function frontierSpendKillState(supabase: SB): Promise<KillSwitchState> {
  return readKillSwitchState(supabase, FRONTIER_SPEND_KILL_KEY);
}

/**
 * True when autonomous spend must be halted — engaged OR unverifiable (FAIL-CLOSED).
 * Boolean convenience for callers that don't need the diagnostic distinction.
 */
export async function isFrontierSpendKilled(supabase: SB): Promise<boolean> {
  return (await frontierSpendKillState(supabase)) !== "clear";
}
