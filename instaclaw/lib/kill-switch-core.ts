/**
 * Fleet-wide kill-switch core — the shared, FAIL-CLOSED reader behind every
 * "stop the bleeding" emergency stop (frontier spend, travala booking, and any
 * future money-moving capability).
 *
 * A kill switch is a single row in `instaclaw_admin_settings` (key/value), read
 * on the hot path of the capability it guards. The ONE safety property an
 * emergency brake must have: if you cannot determine its state, you must assume
 * it might be engaged and STOP. The earlier per-switch implementations failed
 * OPEN on a read error — the reasoning being "a transient DB blip must not halt
 * the fleet, and the capability's own ledger/vm read fails on the same blip
 * anyway." That reasoning has a hole: a TRANSIENT blip that hits only the
 * kill-switch read and then recovers before the downstream read lets an ENGAGED
 * switch be silently bypassed for that request. On a real-money rail under load,
 * "the emergency brake fails open" is not a risk worth carrying — the cost of a
 * false deny (one request bounced; the agent retries; self-heals) is trivial
 * next to the cost of a false allow (operator flipped the switch at 2am and a
 * blip let a spend through).
 *
 * So: FAIL-CLOSED. One retry absorbs a single transient hiccup; a read still
 * erroring after that returns "unverifiable", which every caller treats as
 * engaged (deny). Absent row = "clear" (the safe default — the capability works
 * until an operator deliberately flips the switch on).
 *
 * Engage (no deploy, instant, fleet-wide):
 *   INSERT INTO instaclaw_admin_settings (setting_key, bool_value, notes)
 *   VALUES ('<key>', true, 'why')
 *   ON CONFLICT (setting_key) DO UPDATE SET bool_value=true, updated_at=now(), notes=EXCLUDED.notes;
 * Release:
 *   UPDATE instaclaw_admin_settings SET bool_value=false, updated_at=now()
 *   WHERE setting_key='<key>';
 *
 * No caching — every call reads live, so engage/release is instant fleet-wide.
 */
import type { getSupabase } from "@/lib/supabase";

type SB = ReturnType<typeof getSupabase>;

/**
 * - "engaged"      — row present and bool_value === true (operator stopped it).
 * - "clear"        — row present-and-false, or absent (the safe default).
 * - "unverifiable" — read still failing after a retry; callers MUST fail closed.
 */
export type KillSwitchState = "engaged" | "clear" | "unverifiable";

/**
 * Read a kill switch from instaclaw_admin_settings, FAIL-CLOSED. One immediate
 * retry tolerates a single transient blip; a persistent failure → "unverifiable".
 * No delay between attempts — this is on the authorize/booking hot path and a
 * fail-closed deny is cheap, so we don't add latency chasing a slow recovery.
 */
export async function readKillSwitchState(supabase: SB, key: string): Promise<KillSwitchState> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data, error } = await supabase
        .from("instaclaw_admin_settings")
        .select("bool_value")
        .eq("setting_key", key)
        .maybeSingle();
      if (!error) return data?.bool_value === true ? "engaged" : "clear";
      // error set → transient; fall through to retry, then fail closed.
    } catch {
      // exception → transient; fall through to retry, then fail closed.
    }
  }
  return "unverifiable";
}

/** Convenience: any non-"clear" state means deny (engaged OR unverifiable). */
export function isKillSwitchBlocking(state: KillSwitchState): boolean {
  return state !== "clear";
}
