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
      .select("id, email, stripe_customer_id, deployment_lock_at, referred_by")
      .eq("id", session.user.id)
      .single();

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Check if user already has an active subscription (e.g. VM reassignment)
    const { data: existingSub } = await supabase
      .from("instaclaw_subscriptions")
      .select("id, status")
      .eq("user_id", session.user.id)
      .eq("status", "active")
      .single();

    if (existingSub) {
      // User already paid — skip Stripe checkout, trigger configure, go to deploying
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

    // Check for active deployment lock (within last 15 minutes)
    if (user.deployment_lock_at) {
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

    // If user was referred by an ambassador, ensure the coupon exists and apply it
    let discounts: { coupon: string }[] | undefined;
    if (user.referred_by) {
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
            name: "Ambassador Referral — 25% Off First Month",
          });
        }
        discounts = [{ coupon: "AMBASSADOR_25_OFF" }];
      }
    }

    const checkoutSession = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/deploying?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl ? `${origin}${cancelUrl}` : `${origin}/plan`,
      ...(discounts ? { discounts } : {}),
      ...(trial
        ? { subscription_data: { trial_period_days: 3 } }
        : {}),
      metadata: {
        instaclaw_user_id: user.id,
        tier,
        api_mode: apiMode,
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
