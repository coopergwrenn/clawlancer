/**
 * Phase 4 entry-point helper for freeze-v2.
 *
 * When a user with a frozen-v2 VM (status='frozen' + freeze_state='frozen'
 * + frozen_archive_path NOT NULL) becomes paying again (Stripe sub activates,
 * credit pack purchase, partner reactivation), this helper marks the row
 * for the thaw cron to pick up.
 *
 * Pattern: tiny + idempotent + non-throwing. Safe to call from any webhook
 * branch without try/catch — internal errors are logged but never propagate.
 *
 * The thaw cron itself (PRD §15.7, Phase 4 — not yet built) polls for rows
 * where freeze_state='thaw_pending' AND provisions a fresh VM, layers the
 * archive on, runs the rewire, marks the row healthy.
 *
 * Cooper's directive 2026-05-16-PM: "make sure [the thaw entry point]
 * exists even if Phase 4 doesn't." This is that hook. It does nothing
 * destructive — just flips a state column + sets a timestamp — so it's
 * safe to ship before Phase 4 ships. The thaw cron picks up at its own
 * pace once it exists; until then, rows accumulate in 'thaw_pending'
 * (visible to the operator dashboard / audit query).
 *
 * Distinction from the v1 thawVM call:
 *   - v1 (Linode-image): existing call sites at app/api/billing/webhook
 *     filter by frozen_image_id NOT NULL. v1 thaw runs SYNCHRONOUSLY in
 *     the webhook (slow; provisions a Linode + does the SSH rewire).
 *   - v2 (archive-based): this helper. Filters by frozen_archive_path
 *     NOT NULL + freeze_state='frozen'. ASYNC — just sets a state column;
 *     thaw cron does the actual provisioning at its own cadence.
 *
 * Both call sites can coexist until v1 is fully retired. A user with both
 * a frozen v1 (frozen_image_id set) AND a frozen v2 (frozen_archive_path
 * set) is impossible by construction: v1 and v2 are different freezes of
 * the same VM, never simultaneous.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "./logger";

/**
 * Mark all freeze-v2-frozen VMs owned by this user for thaw. Returns the
 * count of rows transitioned to 'thaw_pending'. Logs errors; never throws.
 *
 * @param supabase - Service-role client
 * @param userId - The user whose frozen VMs should be thawed
 * @param source - Free-form string for audit (e.g., "billing/webhook:subscription.created")
 */
export async function markThawPendingForV2User(
  supabase: SupabaseClient,
  userId: string | null,
  source: string,
): Promise<{ marked: number; error?: string }> {
  if (!userId) {
    return { marked: 0 };
  }
  try {
    // Idempotent: only flip rows currently at 'frozen' AND with a non-null
    // archive path. Rows already at 'thaw_pending' (or 'thawing', etc.)
    // are left alone — the thaw cron handles its own state advancement.
    //
    // CAS-style: WHERE freeze_state='frozen'. If the row's state has
    // already advanced (e.g., thaw cron picked it up between two webhook
    // events), this is a no-op for that row.
    const { data, error } = await supabase
      .from("instaclaw_vms")
      .update({
        freeze_state: "thaw_pending",
        thaw_requested_at: new Date().toISOString(),
      })
      .eq("assigned_to", userId)
      .eq("status", "frozen")
      .eq("freeze_state", "frozen")
      .not("frozen_archive_path", "is", null)
      .select("id, name");

    if (error) {
      logger.error("markThawPendingForV2User: update failed", {
        userId,
        source,
        error: error.message,
      });
      return { marked: 0, error: error.message };
    }

    const count = data?.length ?? 0;
    if (count > 0) {
      logger.info("markThawPendingForV2User: marked thaw_pending", {
        userId,
        source,
        count,
        vmIds: data?.map((r) => r.id).slice(0, 5),
      });
    }
    return { marked: count };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("markThawPendingForV2User: threw", { userId, source, error: msg });
    return { marked: 0, error: msg };
  }
}
