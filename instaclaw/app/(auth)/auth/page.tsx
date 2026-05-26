/**
 * /auth — channel-onboarding OAuth entry.
 *
 * This is the page users land on after tapping the Welcome 3 link
 * (iMessage / Telegram). Distinct from /signin in two ways:
 *
 *   1. It expects `?session=<pending_id>` — the pending_users row id
 *      that bridges the inbound webhook to the OAuth completion.
 *   2. Post-OAuth, it FIRES `assignOrProvisionUserVm` via `after()`
 *      so the VM is provisioning while the user enters their card on
 *      /plan. This is the §6.5.2 architectural change: assignment at
 *      OAuth complete, not at card-success.
 *
 * Flow:
 *   - User unauthenticated → render <AuthClient> (the OAuth picker UI).
 *   - User authenticated + valid session param → bind pending row +
 *     trigger VM provision + redirect to /plan (paid flow) or
 *     /onboarding/done (Edge partner flow, no card).
 *   - User authenticated + no session param → /dashboard (they landed
 *     here from a stale link; existing flow).
 *
 * What this DOES NOT touch:
 *   - /signin remains the canonical OAuth entry for non-channel flows
 *     (returning users, edge claim flow, direct dashboard nav). Zero
 *     behavior change there.
 *   - BYOB Telegram users hit /signup → /connect → /plan as today.
 */

import { redirect } from "next/navigation";
import { after } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { assignOrProvisionUserVm } from "@/lib/createUserVM";
import { logger } from "@/lib/logger";
import { AuthClient } from "./auth-client";

interface AuthPageProps {
  searchParams: Promise<{ session?: string }>;
}

export default async function AuthPage({ searchParams }: AuthPageProps) {
  const params = await searchParams;
  const sessionId = typeof params.session === "string" ? params.session : null;

  // Validate sessionId shape — must be a UUID. Belt-and-suspenders;
  // the /go/:code resolver always produces valid UUIDs but a hand-
  // crafted URL might not.
  const isValidUuid = sessionId
    ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)
    : false;

  const safeSessionId = isValidUuid ? sessionId : null;

  // Check existing NextAuth session.
  const authSession = await auth();

  // Branch 1: authenticated user, with a valid channel session.
  // Bind the pending row, fire VM assignment, redirect to next step.
  if (authSession?.user?.id && safeSessionId) {
    const supabase = getSupabase();

    // Fetch pending row + cross-check user → if pending.user_id is
    // already set to someone else, that's a hostile session-id swap
    // (someone forwarded their link to another person who OAuth'd).
    // We treat it as expired and fall through to dashboard.
    const { data: pending, error: pendingErr } = await supabase
      .from("instaclaw_pending_users")
      .select("*")
      .eq("id", safeSessionId)
      .maybeSingle();

    if (pendingErr) {
      logger.error("[/auth] pending lookup failed", {
        route: "auth",
        sessionId: safeSessionId,
        error: pendingErr.message,
      });
      // Don't block the user — fall through to dashboard. They'll be
      // an authed user on dashboard, which is a sensible recovery.
      redirect("/dashboard");
    }

    // Pending row not found, already consumed, or bound to another
    // user. Treat as stale link; send to dashboard.
    if (
      !pending ||
      pending.consumed_at ||
      (pending.user_id && pending.user_id !== authSession.user.id)
    ) {
      logger.info("[/auth] pending row stale or hostile; redirecting to dashboard", {
        route: "auth",
        sessionId: safeSessionId,
        userIdMatch: pending?.user_id === authSession.user.id,
        consumed: !!pending?.consumed_at,
      });
      redirect("/dashboard");
    }

    // Bind pending row → user. Idempotent if user_id was already set
    // to this user (re-render after refresh, etc.).
    if (pending.user_id !== authSession.user.id) {
      const { error: bindErr } = await supabase
        .from("instaclaw_pending_users")
        .update({ user_id: authSession.user.id })
        .eq("id", safeSessionId)
        // Race-safety: only bind if the row is still unconsumed AND
        // either unbound or bound to this same user. Prevents Pass 6
        // from racing with this UPDATE.
        .is("consumed_at", null);

      if (bindErr) {
        logger.error("[/auth] pending row bind failed", {
          route: "auth",
          sessionId: safeSessionId,
          userId: authSession.user.id,
          error: bindErr.message,
        });
        // Don't block the user — they're authed; send to dashboard.
        redirect("/dashboard");
      }
    }

    // §6.5.2 architectural shift: fire VM assignment AT OAUTH COMPLETE,
    // not at card capture. The 30-60s of card-entry time will overlap
    // with configureOpenClaw — by the time the user lands on
    // /onboarding/done, gateway_url is populated.
    //
    // Wrapped in after() so this redirect isn't blocked. If
    // assignOrProvisionUserVm throws, the existing process-pending
    // Pass 0 will recover (catches paid users with no VM); for
    // pre-payment users, Pass 6 will eventually reclaim the pending
    // row if VM never arrives.
    const userIdForAssignment = authSession.user.id;
    after(async () => {
      try {
        await assignOrProvisionUserVm(userIdForAssignment, { supabase });
        logger.info("[/auth] VM assignment fired via after() on OAuth complete", {
          route: "auth",
          userId: userIdForAssignment,
          sessionId: safeSessionId,
        });
      } catch (err) {
        logger.error("[/auth] assignOrProvisionUserVm threw in after()", {
          route: "auth",
          userId: userIdForAssignment,
          sessionId: safeSessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    // Decide next route: Edge users skip /plan (sponsored trial, no card).
    const { data: user } = await supabase
      .from("instaclaw_users")
      .select("partner")
      .eq("id", authSession.user.id)
      .maybeSingle();

    if (user?.partner === "edge_city") {
      redirect(`/onboarding/done?session=${safeSessionId}`);
    }

    // Standard paid flow → /plan with the session id preserved so
    // /plan can show channel-aware Stripe success redirect to
    // /onboarding/done (rather than the legacy /deploying).
    redirect(`/plan?channel=1&session=${safeSessionId}`);
  }

  // Branch 2: authenticated user, no session param. They reached /auth
  // from a stale link or direct nav. Send to dashboard — this is the
  // same behavior /signin uses for an authed user with no callbackUrl.
  if (authSession?.user?.id) {
    redirect("/dashboard");
  }

  // Branch 3: unauthenticated. Render the picker.
  return <AuthClient sessionId={safeSessionId} />;
}
