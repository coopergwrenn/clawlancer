import type { SupabaseClient } from "@supabase/supabase-js";
import { startGateway, type VMRecord } from "@/lib/ssh";
import { logger } from "@/lib/logger";

export interface WakeResult {
  vmId: string;
  ok: boolean;
  reason?: string;
}

/**
 * Wake every sleeping VM owned by `userId`. Handles BOTH state names:
 *
 *   health_status='hibernating' — set by cron/suspend-check
 *   health_status='suspended'   — set by cron/health-check past_due path
 *
 * Same semantics: gateway stopped, Linode instance still running. Different
 * label depending on which cron fired (the Lesson 5 / 8 issue from the
 * original wake-bug RCA). The original version of this function only
 * handled 'hibernating' — it missed 16/17 stuck-paying users in the
 * 2026-05-02 backlog audit because they were in 'suspended'.
 *
 * Calls `startGateway` (SSH) and, on success, sets `health_status='healthy'`
 * + `last_health_check=NOW()` + clears `suspended_at` + resets watchdog
 * state. History fields (watchdog_last_restart_at, etc.) preserved.
 *
 * Best-effort by design — failures are logged but never thrown. Callers
 * (Stripe webhooks, WLD top-ups, defensive reconciler) MUST NOT fail their
 * primary operation if the wake fails: Stripe will retry the whole webhook
 * and double-credit the user, and the defensive reconciler cron catches
 * stranded VMs within 15 minutes anyway.
 *
 * Most users have at most one sleeping VM, but we iterate to handle the
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
  // Lesson 5: BOTH 'hibernating' AND 'suspended' — same semantics.
  const { data: vms, error } = await supabase
    .from("instaclaw_vms")
    .select("*")
    .eq("assigned_to", userId)
    .in("health_status", ["hibernating", "suspended"]);

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
          // VM is being resurrected — clear suspended_at since it's no
          // longer asleep. Audit trail preserved via watchdog_last_restart_at.
          suspended_at: null,
          // QA fix #1: reset watchdog state on successful wake. A previously
          // quarantined VM whose owner pays again must not stay quarantined
          // forever (would block all future watchdog restarts on it).
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
