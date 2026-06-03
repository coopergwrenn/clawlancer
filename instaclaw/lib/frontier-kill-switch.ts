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
 * FAIL-OPEN on read error: a transient DB blip must not halt the whole fleet, and
 * authorize's own ledger read fails on the same blip anyway (→ 500, no spend happens).
 * The switch is a deliberate operator action; when engaged, the read normally succeeds.
 * Absent row = not engaged (the safe default — spend works until someone flips it on).
 */
import type { getSupabase } from "@/lib/supabase";

export const FRONTIER_SPEND_KILL_KEY = "frontier_spend_kill_switch";

type SB = ReturnType<typeof getSupabase>;

export async function isFrontierSpendKilled(supabase: SB): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("instaclaw_admin_settings")
      .select("bool_value")
      .eq("setting_key", FRONTIER_SPEND_KILL_KEY)
      .maybeSingle();
    if (error) return false; // fail-open (see header)
    return data?.bool_value === true;
  } catch {
    return false; // fail-open
  }
}
