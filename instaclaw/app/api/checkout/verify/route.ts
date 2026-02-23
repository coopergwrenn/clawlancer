import { NextRequest, NextResponse, after } from "next/server";
import { auth } from "@/lib/auth";
import { getStripe } from "@/lib/stripe";
import { getSupabase } from "@/lib/supabase";
import { assignVMWithSSHCheck } from "@/lib/ssh";
import { logger } from "@/lib/logger";

/**
 * Verify Stripe checkout session and trigger VM assignment immediately
 * This runs when user returns from Stripe, don't wait for webhook
 */
export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { sessionId } = (await req.json()) as { sessionId: string };

    if (!sessionId) {
      return NextResponse.json({ error: "Missing session ID" }, { status: 400 });
    }

    const stripe = getStripe();
    const supabase = getSupabase();

    // Fetch the checkout session from Stripe
    const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId);

    // Verify it belongs to this user
    if (checkoutSession.metadata?.instaclaw_user_id !== session.user.id) {
      logger.warn("Session user mismatch", {
        route: "checkout/verify",
        sessionUser: checkoutSession.metadata?.instaclaw_user_id,
        actualUser: session.user.id,
      });
      return NextResponse.json({ error: "Session mismatch" }, { status: 403 });
    }

    // Check if payment succeeded
    if (checkoutSession.payment_status !== "paid") {
      return NextResponse.json({
        verified: false,
        status: checkoutSession.payment_status,
      });
    }

    const userId = session.user.id;
    const tier = checkoutSession.metadata?.tier;
    const apiMode = checkoutSession.metadata?.api_mode;

    if (!tier) {
      return NextResponse.json({ error: "Missing tier metadata" }, { status: 400 });
    }

    // Update pending user with Stripe session ID (if not already set)
    await supabase
      .from("instaclaw_pending_users")
      .update({ stripe_session_id: sessionId })
      .eq("user_id", userId)
      .is("stripe_session_id", null);

    // Create or update subscription record
    const { error: subError } = await supabase.from("instaclaw_subscriptions").upsert(
      {
        user_id: userId,
        tier,
        stripe_subscription_id: checkoutSession.subscription as string,
        stripe_customer_id: checkoutSession.customer as string,
        status: "active",
        payment_status: "current",
      },
      { onConflict: "user_id" }
    );

    if (subError) {
      logger.error("Subscription upsert failed", {
        error: String(subError),
        route: "checkout/verify",
        userId,
      });
    }

    // Check if user already has a VM
    const { data: existingVm } = await supabase
      .from("instaclaw_vms")
      .select("id")
      .eq("assigned_to", userId)
      .single();

    if (existingVm) {
      return NextResponse.json({
        verified: true,
        status: "paid",
        vmAssigned: true,
      });
    }

    // Try to assign a VM (with SSH pre-check to avoid dead VMs)
    const vm = await assignVMWithSSHCheck(userId);

    if (!vm) {
      logger.warn("No VMs available", {
        route: "checkout/verify",
        userId,
      });
      return NextResponse.json({
        verified: true,
        status: "paid",
        vmAssigned: false,
        error: "no_vms",
      });
    }

    // VM assigned! Trigger configuration via after() to guarantee the
    // request survives past the response. A bare non-awaited fetch() can
    // be aborted when Vercel freezes the function after sending the response.
    after(async () => {
      // Retry up to 2 times (3 attempts total) with 5s backoff.
      // If all attempts fail, process-pending cron will pick it up.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const configRes = await fetch(`${process.env.NEXTAUTH_URL}/api/vm/configure`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Admin-Key": process.env.ADMIN_API_KEY ?? "",
            },
            body: JSON.stringify({ userId }),
          });
          if (configRes.ok) break;
          logger.warn("VM configure returned non-OK, retrying", {
            route: "checkout/verify",
            userId,
            attempt,
            status: configRes.status,
          });
        } catch (err) {
          logger.error("VM configure after() failed", {
            error: String(err),
            route: "checkout/verify",
            userId,
            attempt,
          });
        }
        if (attempt < 2) await new Promise(r => setTimeout(r, 5000));
      }
    });

    logger.info("Checkout verified and VM assigned", {
      route: "checkout/verify",
      userId,
      vmId: vm.id,
      tier,
      apiMode,
    });

    return NextResponse.json({
      verified: true,
      status: "paid",
      vmAssigned: true,
      vmId: vm.id,
    });
  } catch (err) {
    logger.error("Checkout verification error", {
      error: String(err),
      route: "checkout/verify",
    });
    return NextResponse.json(
      { error: "Verification failed" },
      { status: 500 }
    );
  }
}
