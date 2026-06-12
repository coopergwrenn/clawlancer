/**
 * Travala booking gates — the two switches that decide whether an agent may
 * spend its human's money on a real hotel booking.
 *
 * There are TWO independent gates, mirroring the frontier-spend pair exactly
 * (lib/frontier-spend-optin.ts + lib/frontier-kill-switch.ts). Booking is a
 * brand-new, money-moving capability, so it ships OFF and stays OFF until the
 * owner deliberately turns it on:
 *
 *   1. PER-VM OPT-IN — `instaclaw_vms.travala_booking_enabled`. RETIRED from the
 *      booking path 2026-06-12 (north-star ruling): book-quote no longer reads it;
 *      the column is inert and the skills-page toggle goes informational. Kept
 *      here only for the legacy /api/skills/travala-booking surface. Historical
 *      semantics: FAIL-CLOSED — anything other than an explicit boolean
 *      `true` (undefined column, null, false, missing row) means NOT enabled. This
 *      is the user-owned switch — the agent may book ONLY if its owner flipped it
 *      on for that agent (each VM has its own wallet; the user owns the toggle).
 *
 *   2. GLOBAL EMERGENCY KILL — `instaclaw_admin_settings.travala_booking_kill_switch`
 *      (operator's "stop every booking fleet-wide RIGHT NOW" stop). FAIL-CLOSED on a
 *      read error (Tier-0 F, 2026-06-11): if the switch state can't be read (still
 *      erroring after one retry), booking is denied with reason
 *      `travala_booking_kill_switch_unverifiable`. The prior fail-OPEN had the same
 *      hole as the frontier switch — a transient blip on this read that recovers before
 *      the per-VM check would let an ENGAGED kill be bypassed (gate 1 reads the already-
 *      loaded vm row, so it does NOT catch a transient blip on THIS read). Booking real
 *      hotel rooms is the literal announce capability; its emergency brake fails CLOSED.
 *      Absent row = not engaged (the safe default — bookings work until an operator
 *      flips it on). See lib/kill-switch-core.ts for the shared fail-closed reader.
 *
 *   ENGAGE the emergency kill (stop the bleeding, no deploy, instant, fleet-wide):
 *     INSERT INTO instaclaw_admin_settings (setting_key, bool_value, notes)
 *     VALUES ('travala_booking_kill_switch', true, 'why')
 *     ON CONFLICT (setting_key) DO UPDATE SET bool_value=true, updated_at=now(), notes=EXCLUDED.notes;
 *
 *   RELEASE:
 *     UPDATE instaclaw_admin_settings SET bool_value=false, updated_at=now()
 *     WHERE setting_key='travala_booking_kill_switch';
 *
 * HISTORY (both halves of the original two-opt-in design are RETIRED):
 *   - 2026-06-12 AM (north-star ruling): the per-VM travala_booking_enabled
 *     toggle was removed from book-quote — the door is open; the money is gated
 *     where it matters. isTravalaBookingEnabled below survives ONLY for the
 *     dashboard card API's informational view; the column is inert.
 *   - 2026-06-12 PM (the travel decouple): frontier_spend_enabled no longer
 *     gates travel either — booking is human-approved spending, not autonomous
 *     spending (lib/frontier-spend-optin.ts spendMandateSatisfied).
 *
 * What ACTUALLY gates booking now: the global kill switch below (operator
 * emergency stop, checked first on every book-quote, fail-closed) + the
 * frontier travel evaluation (the per-booking unforgeable session tap, the
 * funded wallet via the drain guard, the $1200/$3000 ceilings, privacy mode,
 * the per-VM category override). See docs/prd/travala-fleet-flip-runbook and
 * skills/travala/references/booking-flow.md "The three gates".
 */
import type { getSupabase } from "@/lib/supabase";
import { readKillSwitchState, type KillSwitchState } from "@/lib/kill-switch-core";

export const TRAVALA_BOOKING_KILL_KEY = "travala_booking_kill_switch";

type SB = ReturnType<typeof getSupabase>;

/**
 * Gate 1 (per-VM opt-in). True ONLY if the owner explicitly enabled booking for
 * this agent. FAIL-CLOSED — strict `=== true` is the whole safety property.
 * Reads off the `vm` row already loaded by `lookupVMByGatewayToken(token, "*")`,
 * so there is no separate query to fail.
 */
export function isTravalaBookingEnabled(
  vm: { travala_booking_enabled?: boolean | null } | null | undefined,
): boolean {
  return vm?.travala_booking_enabled === true;
}

/**
 * Diagnostic state of the booking kill switch. "engaged" | "clear" |
 * "unverifiable". Prefer this at the booking call site so the deny reason can
 * distinguish a deliberate stop from a blind read (both deny — only "clear" allows).
 */
export function travalaBookingKillState(supabase: SB): Promise<KillSwitchState> {
  return readKillSwitchState(supabase, TRAVALA_BOOKING_KILL_KEY);
}

/**
 * Gate 2 (global emergency kill). True when booking must be halted — engaged OR
 * unverifiable (FAIL-CLOSED). Boolean convenience for callers that don't need the
 * diagnostic distinction.
 */
export async function isTravalaBookingKilled(supabase: SB): Promise<boolean> {
  return (await travalaBookingKillState(supabase)) !== "clear";
}
