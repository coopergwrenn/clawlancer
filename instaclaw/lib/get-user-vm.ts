import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "./logger";

/**
 * ALL new endpoints that look up a user's VM MUST use this helper.
 * Do not copy-paste the query. The terminal-state filter is load-bearing.
 *
 * Why this exists
 * ---------------
 * vm-lifecycle's delete pass sets status='terminated' but does NOT clear
 * assigned_to. So a naive `.eq("assigned_to", userId).single()` lookup will
 * return a terminated row long after the Linode has been destroyed. Operating
 * on that row will either:
 *
 *   (a) fail noisily — SSH to a deleted Linode hangs until timeout, burning
 *       the function budget, OR
 *   (b) silently resurrect it — any trailing UPDATE that sets health_status
 *       to "healthy"/"unknown" without a status guard puts the dead row back
 *       into candidate queries that filter on health_status alone.
 *
 * Both modes have shipped to production. The 2026-05-12 fleet audit found 5
 * VMs SSH-unreachable for 39–46 days still classified `health='healthy'`
 * because vm-lifecycle's delete only flipped status. See commit series for
 * the layered defenses:
 *
 *   39d0e237  initial source/query fix
 *   3914d05f  adjacent paths (deletes, resurrection, unfiltered reads)
 *   0d5499af  SQL guard (migration 062), cron-race UPDATEs, webhooks, top-5
 *
 * This helper centralizes the canonical lookup so no future endpoint can
 * forget the filter.
 *
 * When to use `includeTerminal: true`
 * -----------------------------------
 * ONLY for admin tooling that genuinely needs to inspect dead rows:
 *   - admin/vms detail pages showing termination history
 *   - lifecycle Pass -1 orphan reconciliation (already uses raw queries)
 *   - debugging scripts
 *
 * Any production code path that READS to then SSH, configure, restart, or
 * UPDATE the VM MUST leave includeTerminal at the default (false). Operating
 * on a dead Linode wastes budget and can resurrect health_status.
 */

export interface UserVmOptions {
  /**
   * Include rows with status IN ('terminated', 'destroyed', 'failed').
   * Default: false. See JSDoc on getUserVm for when to flip this.
   */
  includeTerminal?: boolean;
  /**
   * Custom column list. Defaults to `*` (Rule 19: select-star for safety-
   * critical reads dodges PostgREST column-grant misconfiguration). Pass a
   * narrow list only when you don't need the defense and want to minimize
   * payload size on a hot path.
   */
  columns?: string;
}

/**
 * Look up the live VM assigned to a user.
 *
 * Returns null if the user has no live VM (no row at all, OR only terminal
 * rows when includeTerminal is false). Returns the row on success. Errors
 * are logged and surfaced as null — callers handle "no VM" the same way
 * regardless of cause.
 *
 * Type parameter `T` lets callers narrow the return type to their column
 * subset. Defaults to `Record<string, any>` because the Supabase client in
 * this project is untyped (no generated Database type).
 */
export async function getUserVm<T = Record<string, unknown>>(
  supabase: SupabaseClient,
  userId: string,
  opts: UserVmOptions = {},
): Promise<T | null> {
  const columns = opts.columns ?? "*";
  let q = supabase
    .from("instaclaw_vms")
    .select(columns)
    .eq("assigned_to", userId);
  if (!opts.includeTerminal) {
    q = q.not("status", "in", '("terminated","destroyed","failed")');
  }
  const { data, error } = await q.maybeSingle();
  if (error) {
    logger.error("getUserVm: lookup failed", {
      userId,
      includeTerminal: !!opts.includeTerminal,
      error: error.message,
    });
    return null;
  }
  return (data as T | null) ?? null;
}
