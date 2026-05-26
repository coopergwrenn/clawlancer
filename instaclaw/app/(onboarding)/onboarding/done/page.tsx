/**
 * /onboarding/done — last web page in the channel-onboarding flow.
 *
 * User arrives here after:
 *   - Paid flow: Stripe Checkout success → /onboarding/done?session=...&stripe=...
 *   - Edge partner flow: /auth → /onboarding/done?session=... (no Stripe)
 *
 * Server-side responsibilities:
 *   1. Validate the user is authenticated.
 *   2. Validate session id ownership (pending_users.user_id matches session).
 *   3. If pending row consumed already (Pass 6 reclaim, or duplicate visit
 *      after submit), redirect appropriately.
 *   4. Hand off to the client with the data it needs to render the form.
 *
 * Per spec §6.5.6: this page is DISPOSABLE. User can close the tab
 * any time; the sweep cron will fire M_RETURN when their VM is ready.
 * The page exists to (a) celebrate, (b) capture optional personalization,
 * (c) provide a clean "head back to messages" handoff.
 */

import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { OnboardingDoneClient } from "./done-client";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PageProps {
  searchParams: Promise<{ session?: string; stripe?: string }>;
}

export default async function OnboardingDonePage({ searchParams }: PageProps) {
  const params = await searchParams;
  const rawSessionId = typeof params.session === "string" ? params.session : null;

  // Validate session id shape.
  const sessionId = rawSessionId && UUID_REGEX.test(rawSessionId) ? rawSessionId : null;

  // Auth — middleware already enforces signin for /onboarding/* but
  // we double-check so the page never renders without a known user.
  const authSession = await auth();
  if (!authSession?.user?.id) {
    redirect("/signin?callbackUrl=/dashboard");
  }
  const userId = authSession.user.id;

  // No session id? User landed here from outside the channel flow.
  // Send to dashboard — they're authenticated, that's the right home.
  if (!sessionId) {
    redirect("/dashboard");
  }

  const supabase = getSupabase();

  // Fetch pending row + verify ownership.
  const { data: pending, error: pendingErr } = await supabase
    .from("instaclaw_pending_users")
    .select("*")
    .eq("id", sessionId)
    .maybeSingle();

  if (pendingErr) {
    logger.error("[/onboarding/done] pending lookup failed", {
      route: "onboarding/done",
      userId,
      sessionId,
      error: pendingErr.message,
    });
    // Best-effort recovery: send to dashboard. They're paid + authed.
    redirect("/dashboard");
  }

  // Pending row not found — link is stale.
  if (!pending) {
    redirect("/dashboard");
  }

  // Hostile session-id (someone forwarded the link to another person).
  if (pending.user_id && pending.user_id !== userId) {
    logger.warn("[/onboarding/done] hostile session bind attempt", {
      route: "onboarding/done",
      userId,
      sessionId,
      pendingUserId: pending.user_id,
    });
    redirect("/dashboard");
  }

  // Already consumed — either successfully (user is refreshing the page
  // after submit) or reclaimed by Pass 6 (signup expired).
  if (pending.consumed_at) {
    if (pending.reclaimed_at) {
      // Pass 6 took it — VM is gone. Show the "expired" state via the
      // client component (better UX than redirect; user understands what
      // happened and what to do next).
      return (
        <OnboardingDoneClient
          sessionId={sessionId}
          initialState="expired"
          channel={pending.channel ?? "imessage"}
        />
      );
    }
    // Submitted already. Page-refresh case — show the post-submit "head
    // back to messages" state, no resubmit possible.
    return (
      <OnboardingDoneClient
        sessionId={sessionId}
        initialState="post-submit"
        channel={pending.channel ?? "imessage"}
      />
    );
  }

  // Read the user's existing profile (if any) to pre-fill the form
  // gracefully — e.g., if they tapped Submit but the request failed and
  // they hit the back button.
  const { data: existingProfile } = await supabase
    .from("instaclaw_user_profile")
    .select("name, intended_use, vibe")
    .eq("user_id", userId)
    .maybeSingle();

  // Read user.partner so the client can show Edge-specific copy if needed.
  const { data: user } = await supabase
    .from("instaclaw_users")
    .select("partner, name")
    .eq("id", userId)
    .maybeSingle();

  // Suggest a name from OAuth profile if the user didn't fill the form.
  // The agent will use this as a starting point in M_RETURN ("hey,
  // Cooper" etc) — they can correct it in the form.
  const suggestedName =
    existingProfile?.name ||
    user?.name?.trim().split(/\s+/)[0] || // first name from OAuth full name
    null;

  return (
    <OnboardingDoneClient
      sessionId={sessionId}
      initialState="form"
      channel={pending.channel ?? "imessage"}
      partner={user?.partner ?? null}
      suggestedName={suggestedName}
      existingProfile={
        existingProfile
          ? {
              name: existingProfile.name ?? null,
              intended_use: existingProfile.intended_use ?? null,
              vibe: existingProfile.vibe ?? null,
            }
          : null
      }
    />
  );
}
