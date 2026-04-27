import { getSupabase } from "./supabase";
import { logger } from "./logger";
import { PostHog } from "posthog-node";

// PostHog server-side singleton. Reused across warm function invocations.
// Returns null if no key is configured (dev/staging without analytics).
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
      flushAt: 1,         // send on every capture — no batching for serverless
      flushInterval: 0,   // disable interval-based flush
    });
  } catch {
    posthogClient = null;
  }
  return posthogClient;
}

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
  // ── 1. Supabase insert (source of truth for SQL queries / joins) ──
  try {
    const supabase = getSupabase();
    const { error } = await supabase.from("instaclaw_onboarding_events").insert({
      user_id: params.userId,
      vm_id: params.vmId ?? null,
      event_type: params.eventType,
      metadata: params.metadata ?? null,
    });
    if (error) {
      logger.warn("logOnboardingEvent: Supabase insert failed (non-fatal)", {
        eventType: params.eventType,
        userId: params.userId,
        vmId: params.vmId ?? null,
        error: String(error),
      });
    }
  } catch (err) {
    logger.warn("logOnboardingEvent: Supabase threw (non-fatal)", {
      eventType: params.eventType,
      userId: params.userId,
      error: String(err),
    });
  }

  // ── 2. PostHog parallel emit (funnel dashboard / cohort tooling) ──
  // Same 7 event names as the DB column — direct cross-reference.
  // Failures here are independent of the Supabase write above; either
  // surface can succeed alone.
  const ph = getPosthog();
  if (ph) {
    try {
      ph.capture({
        distinctId: params.userId,
        event: params.eventType,
        properties: {
          ...(params.metadata ?? {}),
          vm_id: params.vmId ?? null,
          source: "server",
        },
      });
      await ph.flush();
    } catch (err) {
      logger.warn("logOnboardingEvent: PostHog capture failed (non-fatal)", {
        eventType: params.eventType,
        userId: params.userId,
        error: String(err),
      });
    }
  }
}
