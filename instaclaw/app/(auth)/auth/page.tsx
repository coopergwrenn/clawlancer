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
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { getStripe } from "@/lib/stripe";
import { getBillingStatusVerified } from "@/lib/billing-status";
import { logger } from "@/lib/logger";
import { AuthClient } from "./auth-client";
import { ContinuingAsClient } from "./continuing-as-client";

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

    // Fetch the authed user — needed for the re-onboarding guard AND the
    // "continuing as <email>" confirmation below.
    const { data: user } = await supabase
      .from("instaclaw_users")
      .select("email, partner, onboarding_complete")
      .eq("id", authSession.user.id)
      .maybeSingle();

    // ── Re-onboarding guard (2026-06-10 identity-hardening pass) ──
    // A fully-onboarded, paying user who re-enters the channel flow must NOT
    // re-run /plan — that re-checkout is what created the duplicate-Stripe-sub
    // class (launchanon01's 8 subs; Cooper's walkthrough sub). Short-circuit
    // to /dashboard BEFORE any bind or checkout. `isPaying` is checked
    // Stripe-truth via getBillingStatusVerified (Rule 14 single source of
    // truth) — NOT the drifted local DB status column (Cooper's row showed
    // "active" while Stripe said "trialing"). Once the billing_exempt Path 0
    // ships, this guard honors comp/founder accounts automatically (the check
    // flows through the same classify()).
    if (user?.onboarding_complete) {
      const { data: vmRow } = await supabase
        .from("instaclaw_vms")
        .select("id")
        .eq("assigned_to", authSession.user.id)
        .eq("status", "assigned")
        .maybeSingle();
      let paying = false;
      if (vmRow?.id) {
        try {
          const billing = await getBillingStatusVerified(supabase, getStripe(), vmRow.id);
          paying = billing?.isPaying ?? false;
        } catch (err) {
          // Stripe unreachable → do NOT short-circuit (fall through to the
          // confirmation). A failed billing check must never strand a real
          // returning customer, but it also must not wrongly skip the guard
          // for a paying one — so we let them confirm rather than re-checkout
          // silently. The confirm route + /plan's own existing-sub branch are
          // the backstops.
          logger.warn("[/auth] re-onboarding guard billing check threw — not short-circuiting", {
            route: "auth",
            userId: authSession.user.id,
            vmId: vmRow.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else if (user.partner) {
        // onboarding_complete + partner but no current assigned VM → still a
        // set-up sponsored account; /dashboard is the right home (and there's
        // no /plan re-checkout risk for partner users anyway).
        paying = true;
      }
      if (paying) {
        logger.info("[/auth] re-onboarding guard: onboarding_complete + paying → /dashboard (no re-bind, no checkout)", {
          route: "auth",
          userId: authSession.user.id,
          sessionId: safeSessionId,
        });
        redirect("/dashboard");
      }
    }

    // ── "continuing as <email>" confirmation (2026-06-10) ──
    // The binding + VM provisioning do NOT fire here anymore. We render the
    // confirmation; the user must explicitly confirm the account before we
    // bind the pending row to it (POST /api/auth/channel-confirm). This closes
    // the shared/stale-session wrong-account-binding hazard — the front door
    // ~1,000 Edge attendees touch first. "not you?" forces the OAuth picker.
    return <ContinuingAsClient email={user?.email ?? null} sessionId={safeSessionId} />;
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
