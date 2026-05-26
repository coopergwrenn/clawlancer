import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getStripe, getPriceId, Tier, ApiMode } from "@/lib/stripe";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { tier, apiMode, trial, cancelUrl } = (await req.json()) as {
      tier: Tier;
      apiMode: ApiMode;
      trial?: boolean;
      cancelUrl?: string;
    };

    if (!["starter", "pro", "power"].includes(tier)) {
      return NextResponse.json({ error: "Invalid tier" }, { status: 400 });
    }
    if (!["all_inclusive", "byok"].includes(apiMode)) {
      return NextResponse.json({ error: "Invalid API mode" }, { status: 400 });
    }

    const priceId = getPriceId(tier, apiMode);
    const stripe = getStripe();
    const supabase = getSupabase();

    // Get or create Stripe customer
    const { data: user } = await supabase
      .from("instaclaw_users")
      .select("id, email, stripe_customer_id, deployment_lock_at, referred_by, invited_by, partner")
      .eq("id", session.user.id)
      .single();

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Check if user already has an active OR trialing subscription
    // (e.g. VM reassignment, or Edge attendee mid-trial clicking back).
    //
    // CRITICAL: this filter MUST include "trialing" alongside "active".
    // Without "trialing", an Edge attendee who completes Stripe checkout
    // and then somehow returns to /plan (browser back, refresh, deep
    // link) would not match here. The route would proceed to create a
    // SECOND Stripe Checkout Session, and if they completed that too,
    // they'd end up with two parallel subscriptions on the same Stripe
    // customer — both with trial_end = June 30 — and get DOUBLE-CHARGED
    // on the post-trial invoice date.
    //
    // The instaclaw_subscriptions table has UNIQUE(user_id) so the DB
    // only sees the latest sub after the webhook upsert, but the
    // earlier Stripe sub still exists on Stripe's side and bills
    // independently. The fix is here — refuse to start a new checkout
    // if the user is already in a billable Stripe state.
    const { data: existingSub } = await supabase
      .from("instaclaw_subscriptions")
      .select("id, status")
      .eq("user_id", session.user.id)
      .in("status", ["active", "trialing"])
      .maybeSingle();

    if (existingSub) {
      // User already paid OR is on an active trial — skip Stripe
      // checkout, trigger configure, go to deploying.
      const origin = req.headers.get("origin") ?? process.env.NEXTAUTH_URL!;
      fetch(`${process.env.NEXTAUTH_URL}/api/vm/configure`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Admin-Key": process.env.ADMIN_API_KEY ?? "",
        },
        body: JSON.stringify({ userId: session.user.id }),
      }).catch((err) => {
        logger.error("Configure fire-and-forget failed (existing sub)", {
          error: String(err),
          route: "billing/checkout",
          userId: session.user.id,
        });
      });
      return NextResponse.json({ url: `${origin}/deploying` });
    }

    // ─── Stripe back-button recovery (Charlie #4 audit fix 2026-05-22) ──
    //
    // The lock check below previously made the back-button case
    // unrecoverable: user clicked Continue → Stripe checkout → hit
    // browser-back → returned to /plan with a 15-minute "Deployment
    // already in progress" wall. They couldn't change plans, couldn't
    // retry, couldn't recover. For 1000 Edge attendees this would be
    // a Day-1 support flood — back-button after Stripe redirect is
    // a very common user instinct.
    //
    // The fix: before the lock check, find any OPEN Stripe checkout
    // sessions for this customer and expire them via Stripe's API.
    // Stripe's `checkout.sessions.expire()` is idempotent + safe to
    // call (returns the session in `expired` state). After expiring,
    // we clear the deployment_lock_at — the user can now create a
    // fresh checkout session with potentially-different plan tier.
    //
    // Why this is safe from double-payment: an expired Stripe session
    // cannot be paid. So even if the user has both the old URL and
    // the new URL open in two tabs, only the new one is payable. The
    // old one's "Pay" button at Stripe will reject.
    //
    // Degradation: if Stripe's list/expire APIs fail (network, rate
    // limit, etc.), we log + fall through to the original lock-wall
    // behavior. Better to show the user a stuck state than to risk
    // a real double-payment if expiration silently failed.
    let hadOpenSessions = false;
    if (user.stripe_customer_id && user.deployment_lock_at) {
      try {
        const openSessions = await stripe.checkout.sessions.list({
          customer: user.stripe_customer_id,
          status: "open",
          limit: 5,
        });
        for (const oldSession of openSessions.data) {
          try {
            await stripe.checkout.sessions.expire(oldSession.id);
            hadOpenSessions = true;
            logger.info("Expired prior open Stripe checkout session", {
              route: "billing/checkout",
              userId: user.id,
              sessionId: oldSession.id,
            });
          } catch (expireErr) {
            // Session may have already transitioned to a terminal state
            // (expired, complete) between our list and expire calls.
            // Stripe throws for those; safe to ignore — they can't be
            // paid anymore either way.
            logger.warn("Stripe session expire threw (likely already terminal)", {
              route: "billing/checkout",
              userId: user.id,
              sessionId: oldSession.id,
              error: String(expireErr),
            });
          }
        }
      } catch (listErr) {
        // Stripe list API failed. Don't crash; the lock-wall fallback
        // below will engage. User gets the old stuck state but no new
        // payment risk introduced.
        logger.warn("Stripe sessions.list failed, falling through to lock check", {
          route: "billing/checkout",
          userId: user.id,
          error: String(listErr),
        });
      }
    }

    // Check for active deployment lock (within last 15 minutes).
    // If we just expired prior open sessions, clear the lock too —
    // there's no in-flight checkout anymore for the lock to protect.
    if (hadOpenSessions) {
      await supabase
        .from("instaclaw_users")
        .update({ deployment_lock_at: null })
        .eq("id", user.id);
      // Don't enter the lock-check branch — we just cleared it.
      // Will be re-set below to mark the new checkout in flight.
    } else if (user.deployment_lock_at) {
      const lockAge = Date.now() - new Date(user.deployment_lock_at).getTime();
      const fifteenMinutes = 15 * 60 * 1000;

      if (lockAge < fifteenMinutes) {
        return NextResponse.json(
          {
            error: "Deployment already in progress. Please complete or wait for the current deployment to finish.",
            retryAfter: Math.ceil((fifteenMinutes - lockAge) / 1000),
          },
          { status: 409 }
        );
      }
      // Lock expired, will be cleared and renewed below
    }

    // Set deployment lock
    await supabase
      .from("instaclaw_users")
      .update({ deployment_lock_at: new Date().toISOString() })
      .eq("id", user.id);

    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { instaclaw_user_id: user.id },
      });
      customerId = customer.id;
      await supabase
        .from("instaclaw_users")
        .update({ stripe_customer_id: customerId })
        .eq("id", user.id);
    }

    const origin = req.headers.get("origin") ?? process.env.NEXTAUTH_URL!;

    // ─────────────────────────────────────────────────────────────────
    // Edge Esmeralda 2026 — sponsor-funded trial through June 30
    // ─────────────────────────────────────────────────────────────────
    //
    // Every Edge attendee gets a Stripe subscription with a fixed
    // trial_end anchored to June 30, 2026 midnight Pacific (07:00 UTC).
    // Card is collected at checkout. $0 is charged today. Auto-charges
    // $99/month starting June 30 unless they cancel.
    //
    // Why a fixed trial_end (not trial_period_days):
    // Every attendee gets the SAME end date regardless of signup date.
    // Predictable, fair, anchored to Pacific time (where they physically
    // are during the village). An attendee signing up May 30 vs June 25
    // both get charged June 30 — no awkward "first charge on a random
    // mid-July date" effect.
    //
    // Why this replaces the legacy EDGE_CITY_COUPON_ID coupon:
    // The coupon was 100% off FIRST INVOICE, which meant the first
    // charge timing varied per signup date AND the second month always
    // billed normally. trial_end gives us atomic "free until X, then
    // billed normally" semantics. Cleaner billing trail, clearer
    // attendee mental model, no double-discount risk.
    //
    // The June 30 timestamp is 1782802800 (Unix). Verified:
    //   $ date -ur 1782802800
    //   Tue Jun 30 07:00:00 UTC 2026
    //   = June 30, 2026 00:00 PT (Pacific Daylight)
    //
    // That's 3 days after Edge Esmeralda ends (June 27) — gives
    // attendees a buffer to decide whether to keep their agent.
    const EDGE_TRIAL_END_UTC = 1782802800;
    const isEdgeCity = user.partner === "edge_city";

    // Check if user redeemed a promotional invite with extended trial
    let trialDays = trial ? 3 : 0;
    if (trial && user.invited_by) {
      const { data: invite } = await supabase
        .from("instaclaw_invites")
        .select("created_by")
        .eq("code", user.invited_by.trim().toUpperCase())
        .single();
      if (invite?.created_by === "renata-friends-trial") {
        trialDays = 7;
      }
    }

    // Apply partner coupon or ambassador discount (mutually exclusive with promo code entry)
    let discounts: { coupon: string }[] | undefined;

    // Edge City attendees: NO coupon — trial_end supersedes (see comment
    // block above). The legacy EDGE_CITY_COUPON_ID env var is now
    // unused; left here intentionally as documentation of the prior
    // mechanism. Safe to remove from Vercel env after Edge Esmeralda 2026.
    //
    // (Previously: discounts = [{ coupon: process.env.EDGE_CITY_COUPON_ID }])

    if (!discounts && user.referred_by) {
      // Verify the referral code belongs to an active ambassador
      const { data: ambassador } = await supabase
        .from("instaclaw_ambassadors")
        .select("id")
        .eq("referral_code", user.referred_by)
        .eq("status", "approved")
        .single();

      if (ambassador) {
        // Ensure the coupon exists in Stripe (idempotent)
        try {
          await stripe.coupons.retrieve("AMBASSADOR_25_OFF");
        } catch {
          await stripe.coupons.create({
            id: "AMBASSADOR_25_OFF",
            percent_off: 25,
            duration: "once",
            name: "Ambassador 25% Off First Month",
          });
        }
        discounts = [{ coupon: "AMBASSADOR_25_OFF" }];
      }
    }

    // Build subscription_data trial block:
    // - Edge City: fixed trial_end = June 30 2026 00:00 PT (anchors
    //   every attendee to the same charge date regardless of signup).
    // - Promotional invite users: relative trial_period_days (3 or 7
    //   depending on which invite code).
    // - Edge takes precedence — if an Edge attendee also has an invite,
    //   the fixed end date wins (Edge IS the trial).
    //
    // Stripe API note: trial_end must be in the future. We don't guard
    // against EDGE_TRIAL_END_UTC being in the past here because once
    // the date passes, Edge Esmeralda 2026 is over — no new Edge
    // signups expected. If we ever run Edge again in a future year,
    // bump the constant + re-test.
    const subscriptionData: {
      trial_end?: number;
      trial_period_days?: number;
    } = {};
    if (isEdgeCity) {
      subscriptionData.trial_end = EDGE_TRIAL_END_UTC;
    } else if (trialDays > 0) {
      subscriptionData.trial_period_days = trialDays;
    }

    // ─── Channel-onboarding success_url branch (spec §6.5.2 + §6.5.4) ──
    //
    // The 2026-05-26 onboarding redesign introduced a new post-Stripe
    // landing page (/onboarding/done) that owns personalization + the
    // M_RETURN trigger for users who came in via iMessage / Telegram
    // shared bot. Detect channel-onboarding by reading the user's
    // most-recent unconsumed pending_users row:
    //
    //   - channel IS NOT NULL → channel onboarding → /onboarding/done
    //   - channel IS NULL (BYOB) OR no pending row → /deploying (legacy)
    //
    // We key on the MOST RECENT pending row (order by created_at DESC)
    // so a user with both an old BYOB row and a fresh channel row gets
    // routed by whichever signup attempt is current. Belt-and-suspenders
    // against stale rows.
    //
    // Stripe substitutes `{CHECKOUT_SESSION_ID}` with the actual session
    // id on redirect; the destination page uses it to call
    // /api/checkout/verify (existing) which finalizes the assignment.
    const { data: latestPending } = await supabase
      .from("instaclaw_pending_users")
      .select("id, channel")
      .eq("user_id", user.id)
      .is("consumed_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const isChannelOnboarding =
      !!latestPending && latestPending.channel !== null;

    const successUrl = isChannelOnboarding
      ? `${origin}/onboarding/done?session=${latestPending.id}&stripe={CHECKOUT_SESSION_ID}`
      : `${origin}/deploying?session_id={CHECKOUT_SESSION_ID}`;

    const checkoutSession = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl ? `${origin}${cancelUrl}` : `${origin}/plan`,
      // Always collect a payment method — even on $0 trials. Stripe's
      // default for `mode: "subscription"` is already `"always"`, but
      // we set it explicitly so the intent is locked in code. A future
      // engineer touching this block can't accidentally flip to
      // `"if_required"` (which would skip card collection on $0 trials,
      // breaking the entire Edge trial-billing model — they'd get a
      // free agent through June 30 with no card on file, then the
      // post-trial invoice would fail and we'd silently churn the
      // entire cohort on July 1).
      payment_method_collection: "always",
      // Stripe doesn't allow both discounts and allow_promotion_codes on the same session.
      // Ambassador referrals get a pre-applied discount; everyone else can enter a promo code.
      ...(discounts ? { discounts } : { allow_promotion_codes: true }),
      ...(Object.keys(subscriptionData).length > 0
        ? { subscription_data: subscriptionData }
        : {}),
      metadata: {
        instaclaw_user_id: user.id,
        tier,
        api_mode: apiMode,
        ...(isEdgeCity ? { edge_trial_end: String(EDGE_TRIAL_END_UTC) } : {}),
        ...(user.referred_by ? { referral_code: user.referred_by } : {}),
      },
    });

    return NextResponse.json({ url: checkoutSession.url });
  } catch (err) {
    logger.error("Checkout error", { error: String(err), route: "billing/checkout" });
    return NextResponse.json(
      { error: "Failed to create checkout session" },
      { status: 500 }
    );
  }
}
