/**
 * Travala booking gates — the two switches that decide whether an agent may
 * spend its human's money on a real hotel booking.
 *
 * There are TWO independent gates, mirroring the frontier-spend pair exactly
 * (lib/frontier-spend-optin.ts + lib/frontier-kill-switch.ts). Booking is a
 * brand-new, money-moving capability, so it ships OFF and stays OFF until the
 * owner deliberately turns it on:
 *
 *   1. PER-VM OPT-IN — `instaclaw_vms.travala_booking_enabled` (the "Travel Agent"
 *      card toggle, item J). FAIL-CLOSED: anything other than an explicit boolean
 *      `true` (undefined column, null, false, missing row) means NOT enabled. This
 *      is the user-owned switch — the agent may book ONLY if its owner flipped it
 *      on for that agent (each VM has its own wallet; the user owns the toggle).
 *
 *   2. GLOBAL EMERGENCY KILL — `instaclaw_admin_settings.travala_booking_kill_switch`
 *      (operator's "stop every booking fleet-wide RIGHT NOW" stop). FAIL-OPEN on a
 *      read error, for the same reason the frontier kill switch is fail-open: a
 *      transient DB blip must not be misread as "killed", and the per-VM opt-in
 *      (gate 1, fail-closed) already prevents any booking on an unreadable vm row.
 *      Absent row = not engaged (the safe default — bookings work until an operator
 *      flips it on).
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
 * The booking backend (/api/travala book-quote) checks BOTH on every call: the
 * emergency kill first (cheap, fleet-wide), then the per-VM opt-in. Either gate
 * shut ⇒ no token is minted, no booking 402 is returned.
 *
 * NOTE: these gates govern BOOKING (the money move). They are orthogonal to the
 * frontier spend gate, which the same booking ALSO passes through (the agent's
 * pay leg calls /authorize with category:"travel"). Booking therefore requires
 * BOTH travala_booking_enabled AND frontier_spend_enabled — by design, two
 * deliberate user opt-ins for a capability that spends real money on a real
 * merchant. See instaclaw/docs/prd/travala-x402-booking-2026-06-10.md §5, §14-F.
 */
import type { getSupabase } from "@/lib/supabase";

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
 * Gate 2 (global emergency kill). True when an operator has engaged the
 * fleet-wide booking stop. FAIL-OPEN on read error (a DB blip must not be
 * misread as "killed"; gate 1 already protects the unreadable-vm case).
 */
export async function isTravalaBookingKilled(supabase: SB): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("instaclaw_admin_settings")
      .select("bool_value")
      .eq("setting_key", TRAVALA_BOOKING_KILL_KEY)
      .maybeSingle();
    if (error) return false; // fail-open (see header)
    return data?.bool_value === true;
  } catch {
    return false; // fail-open
  }
}
