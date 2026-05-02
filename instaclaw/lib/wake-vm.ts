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
 * (Stripe webhooks, WLD top-ups, defensive reconciler) MUST NOT fail their
 * primary operation if the wake fails: Stripe will retry the whole webhook
 * and double-credit the user, and the defensive reconciler cron catches
 * stranded VMs within 15 minutes anyway.
 *
 * Most users have at most one hibernating VM, but we iterate to handle the
 * rare multi-VM-per-user case correctly.
 *
 * Spec: instaclaw/docs/watchdog-v2-and-wake-reconciler-design.md
 * RCA: instaclaw/docs/wake-from-hibernation-bug-2026-05-02.md
 */
export async function wakeIfHibernating(
  supabase: SupabaseClient,
  userId: string,
  source: string,
): Promise<WakeResult[]> {
  // Lesson 7: select * to avoid silent column-grant / RLS empty rows.
  const { data: vms, error } = await supabase
    .from("instaclaw_vms")
    .select("*")
    .eq("assigned_to", userId)
    .eq("health_status", "hibernating");

  if (error) {
    logger.error("wakeIfHibernating: lookup failed", { userId, source, error: error.message });
    return [];
  }
  if (!vms?.length) return [];

  const results: WakeResult[] = [];
  for (const row of vms) {
    // Validate row shape before action (lesson 7).
    if (!row.id || !row.ip_address || !row.ssh_port || !row.ssh_user) {
      logger.error("wakeIfHibernating: row missing required SSH fields — skipping", {
        userId, source, vmId: row.id, hasIp: !!row.ip_address,
      });
      results.push({ vmId: row.id ?? "(unknown)", ok: false, reason: "row_shape_invalid" });
      continue;
    }
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
          // QA fix #1: reset watchdog state on successful wake. A previously
          // quarantined VM whose owner pays again must not stay quarantined
          // forever (would block all future watchdog restarts on it). Same
          // logic for failure counter + first_failure_at — fresh start.
          // History (watchdog_last_restart_at, watchdog_restart_attempts_24h)
          // is INTENTIONALLY preserved for forensics.
          watchdog_consecutive_failures: 0,
          watchdog_first_failure_at: null,
          watchdog_quarantined_at: null,
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
