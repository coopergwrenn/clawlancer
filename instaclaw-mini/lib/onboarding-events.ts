import { supabase } from "./supabase";

/**
 * Onboarding journey event types. Mirrors the type defined in the main
 * instaclaw app at instaclaw/lib/onboarding-events.ts. Both apps write to
 * the same Supabase table (instaclaw_onboarding_events).
 *
 * Mini-app insert sites:
 *   world_id_verified  → markWorldIdVerified() flow
 *   payment_completed  → agent/provision after delegation confirmed
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
 * Append a single onboarding event. Failures are non-fatal: a console warn,
 * never an exception that propagates back to the caller. Analytics writes
 * MUST NOT break user-facing flows.
 */
export async function logOnboardingEvent(params: {
  userId: string;
  eventType: OnboardingEventType;
  vmId?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    const { error } = await supabase().from("instaclaw_onboarding_events").insert({
      user_id: params.userId,
      vm_id: params.vmId ?? null,
      event_type: params.eventType,
      metadata: params.metadata ?? null,
    });
    if (error) {
      console.warn("[onboarding-events] insert failed (non-fatal)", {
        eventType: params.eventType,
        userId: params.userId,
        vmId: params.vmId ?? null,
        error: String(error),
      });
    }
  } catch (err) {
    console.warn("[onboarding-events] threw (non-fatal)", {
      eventType: params.eventType,
      userId: params.userId,
      error: String(err),
    });
  }
}
