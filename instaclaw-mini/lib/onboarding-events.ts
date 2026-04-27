import { supabase } from "./supabase";
import { PostHog } from "posthog-node";

/**
 * Onboarding journey event types. Mirrors the type defined in the main
 * instaclaw app at instaclaw/lib/onboarding-events.ts. Both apps write to
 * the same Supabase table (instaclaw_onboarding_events) AND emit the same
 * named events to PostHog for funnel/cohort analysis.
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

// PostHog server-side singleton, reused across warm function invocations.
let posthogClient: PostHog | null | undefined = undefined;
function getPosthog(): PostHog | null {
  if (posthogClient !== undefined) return posthogClient;
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) {
    posthogClient = null;
    return null;
  }
  try {
    posthogClient = new PostHog(key, {
      host: process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com",
      flushAt: 1,
      flushInterval: 0,
    });
  } catch {
    posthogClient = null;
  }
  return posthogClient;
}

/**
 * Append a single onboarding event. Failures are non-fatal: a console warn,
 * never an exception that propagates back to the caller. Analytics writes
 * MUST NOT break user-facing flows. The Supabase insert and the PostHog
 * capture are independent — either can succeed alone.
 */
export async function logOnboardingEvent(params: {
  userId: string;
  eventType: OnboardingEventType;
  vmId?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  // ── 1. Supabase insert (source of truth for SQL queries / joins) ──
  try {
    const { error } = await supabase().from("instaclaw_onboarding_events").insert({
      user_id: params.userId,
      vm_id: params.vmId ?? null,
      event_type: params.eventType,
      metadata: params.metadata ?? null,
    });
    if (error) {
      console.warn("[onboarding-events] Supabase insert failed (non-fatal)", {
        eventType: params.eventType,
        userId: params.userId,
        vmId: params.vmId ?? null,
        error: String(error),
      });
    }
  } catch (err) {
    console.warn("[onboarding-events] Supabase threw (non-fatal)", {
      eventType: params.eventType,
      userId: params.userId,
      error: String(err),
    });
  }

  // ── 2. PostHog parallel emit (funnel dashboard / cohort tooling) ──
  const ph = getPosthog();
  if (ph) {
    try {
      ph.capture({
        distinctId: params.userId,
        event: params.eventType,
        properties: {
          ...(params.metadata ?? {}),
          vm_id: params.vmId ?? null,
          source: "mini-app",
        },
      });
      await ph.flush();
    } catch (err) {
      console.warn("[onboarding-events] PostHog capture failed (non-fatal)", {
        eventType: params.eventType,
        userId: params.userId,
        error: String(err),
      });
    }
  }
}
