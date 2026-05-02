import type { SupabaseClient } from "@supabase/supabase-js";
import { startGateway, type VMRecord } from "@/lib/ssh";
import { logger } from "@/lib/logger";

export interface WakeResult {
  vmId: string;
  ok: boolean;
  reason?: string;
}

/**
 * Wake every VM owned by `userId` whose `health_status='hibernating'`.
 *
 * Calls `startGateway` (SSH) and, on success, sets `health_status='healthy'`
 * + `last_health_check=NOW()`. Leaves `suspended_at` in place for audit.
 *
 * Best-effort by design — failures are logged but never thrown. Callers
 * (Stripe webhooks, WLD top-ups) MUST NOT fail their primary operation if
 * the wake fails: Stripe will retry the whole webhook and double-credit
 * the user, and the defensive reconciler cron (Fix D) will catch the
 * stranded VM within 15 minutes anyway.
 *
 * Most users have at most one hibernating VM, but we iterate to handle the
 * rare multi-VM-per-user case correctly.
 */
export async function wakeIfHibernating(
  supabase: SupabaseClient,
  userId: string,
  source: string,
): Promise<WakeResult[]> {
  const { data: vms, error } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, ssh_port, ssh_user, assigned_to, region")
    .eq("assigned_to", userId)
    .eq("health_status", "hibernating");

  if (error) {
    logger.error("wakeIfHibernating: lookup failed", { userId, source, error: error.message });
    return [];
  }
  if (!vms?.length) return [];

  const results: WakeResult[] = [];
  for (const row of vms) {
    const vm: VMRecord = {
      id: row.id,
      ip_address: row.ip_address,
      ssh_port: row.ssh_port,
      ssh_user: row.ssh_user,
      assigned_to: row.assigned_to,
      region: row.region ?? undefined,
    };
    try {
      const started = await startGateway(vm);
      if (!started) {
        logger.error("wakeIfHibernating: startGateway returned false", { vmId: vm.id, userId, source });
        results.push({ vmId: vm.id, ok: false, reason: "startGateway returned false" });
        continue;
      }

      const { error: updErr } = await supabase
        .from("instaclaw_vms")
        .update({
          health_status: "healthy",
          last_health_check: new Date().toISOString(),
        })
        .eq("id", vm.id);

      if (updErr) {
        logger.error("wakeIfHibernating: DB update failed after start", { vmId: vm.id, userId, source, error: updErr.message });
        results.push({ vmId: vm.id, ok: false, reason: `db update: ${updErr.message}` });
        continue;
      }

      logger.info("wakeIfHibernating: woke VM", { vmId: vm.id, userId, source });
      results.push({ vmId: vm.id, ok: true });
    } catch (err) {
      logger.error("wakeIfHibernating: threw", { vmId: vm.id, userId, source, error: err instanceof Error ? err.message : String(err) });
      results.push({ vmId: vm.id, ok: false, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
