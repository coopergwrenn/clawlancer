import { getSupabase } from "./supabase";
import { logger } from "./logger";

/**
 * Onboarding journey event types. Append new ones here; the DB column is
 * unconstrained text so adding a new value requires no migration.
 *
 * Insert sites:
 *   world_id_verified     → instaclaw-mini markWorldIdVerified()
 *   payment_completed     → instaclaw-mini agent/provision (after delegation confirmed)
 *   vm_assigned           → instaclaw vm/assign route
 *   configure_started     → top of instaclaw vm/configure POST handler
 *   configure_completed   → just before successful configure response
 *   xmtp_setup_completed  → inside vm/configure after() block when setupXMTP returns success
 *   first_message_sent    → instaclaw admin/xmtp-greeting-recorded when wasNew=true
 */
export type OnboardingEventType =
  | "world_id_verified"
  | "payment_completed"
  | "vm_assigned"
  | "configure_started"
  | "configure_completed"
  | "xmtp_setup_completed"
  | "first_message_sent";

/**
 * Append a single onboarding event. Failures are non-fatal: a logged warn,
 * never an exception that propagates back to the caller. Analytics writes
 * MUST NOT break user-facing flows.
 *
 * Idempotency is intentionally NOT enforced: the table is an append-only log
 * and a given event may legitimately fire multiple times for the same user
 * (e.g., configure_started on a re-configure). Funnel queries use
 * MIN(created_at) for first-occurrence semantics.
 */
export async function logOnboardingEvent(params: {
  userId: string;
  eventType: OnboardingEventType;
  vmId?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    const supabase = getSupabase();
    const { error } = await supabase.from("instaclaw_onboarding_events").insert({
      user_id: params.userId,
      vm_id: params.vmId ?? null,
      event_type: params.eventType,
      metadata: params.metadata ?? null,
    });
    if (error) {
      logger.warn("logOnboardingEvent: insert failed (non-fatal)", {
        eventType: params.eventType,
        userId: params.userId,
        vmId: params.vmId ?? null,
        error: String(error),
      });
    }
  } catch (err) {
    logger.warn("logOnboardingEvent: threw (non-fatal)", {
      eventType: params.eventType,
      userId: params.userId,
      error: String(err),
    });
  }
}
