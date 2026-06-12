import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getStripe } from "@/lib/stripe";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

/** Credit pack definitions: credits → Stripe env var key. */
const CREDIT_PACKS: Record<string, { credits: number; label: string; envKey: string; target?: "messages" | "media" | "toolrouter" | "video" }> = {
  "50": { credits: 50, label: "50 messages — $5", envKey: "STRIPE_PRICE_CREDIT_50", target: "messages" },
  "200": { credits: 200, label: "200 messages — $15", envKey: "STRIPE_PRICE_CREDIT_200", target: "messages" },
  "500": { credits: 500, label: "500 messages — $30", envKey: "STRIPE_PRICE_CREDIT_500", target: "messages" },
  "media_500": { credits: 500, label: "500 credits — $4.99", envKey: "STRIPE_PRICE_MEDIA_500", target: "media" },
  "media_1200": { credits: 1200, label: "1200 credits — $9.99", envKey: "STRIPE_PRICE_MEDIA_1200", target: "media" },
  "media_3000": { credits: 3000, label: "3000 credits — $19.99", envKey: "STRIPE_PRICE_MEDIA_3000", target: "media" },
  // ToolRouter v1 top-up pack (PRD §7.11 Task K.5). 100 premium searches
  // for $10. Webhook handler at app/api/billing/webhook/route.ts routes
  // by metadata.target = "toolrouter" → instaclaw_add_toolrouter_searches.
  "toolrouter_100": { credits: 100, label: "100 premium searches — $10", envKey: "STRIPE_PRICE_TOOLROUTER_100", target: "toolrouter" },
  // Higgsfield video packs (launch build order §3.1). Sold as CLIPS; `credits`
  // is video-credits (1 premium clip = 13 vc, matching estimateVideoCredits).
  // Webhook routes target="video" → instaclaw_add_video_credits → video_credit_balance.
  // Headline "videos from 99¢" lives on the Taste pack; margin in the price.
  "video_taste":   { credits: 52,  label: "4 premium videos — $3.99",   envKey: "STRIPE_PRICE_VIDEO_TASTE",   target: "video" },
  "video_creator": { credits: 156, label: "12 premium videos — $14.99", envKey: "STRIPE_PRICE_VIDEO_CREATOR", target: "video" },
  "video_studio":  { credits: 416, label: "32 premium videos — $39.99", envKey: "STRIPE_PRICE_VIDEO_STUDIO",  target: "video" },
};

/** Recurring plans sold through this same buy endpoint (mode:"subscription" —
 *  packs are mode:"payment"). The video creator plan: $44.99/mo → 546 vc/mo
 *  granted on invoice.paid (lib/video-plan.ts; the discrimination gate keeps
 *  these subs out of every platform handler). One video plan per user. */
const VIDEO_PLANS: Record<string, { envKey: string; label: string }> = {
  video_plan_monthly: { envKey: "STRIPE_PRICE_VIDEO_PLAN_MONTHLY", label: "Video Creator Plan — $44.99/mo" },
};

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { pack, return_to } = (await req.json()) as { pack: string; return_to?: string };

    // The buyer returns to the page that sold them (routing rule: /videos is
    // the video seller, /billing the money hub, /dashboard legacy). Allow-list
    // only — never an open redirect.
    const RETURN_PATHS = new Set(["/dashboard", "/billing", "/videos"]);
    const returnPath = return_to && RETURN_PATHS.has(return_to) ? return_to : null;

    const planDef = VIDEO_PLANS[pack];
    const packDef = CREDIT_PACKS[pack];
    if (!packDef && !planDef) {
      return NextResponse.json(
        { error: `Invalid credit pack. Valid packs: ${[...Object.keys(CREDIT_PACKS), ...Object.keys(VIDEO_PLANS)].join(", ")}.` },
        { status: 400 }
      );
    }

    const priceId = process.env[(planDef ?? packDef)!.envKey];
    if (!priceId) {
      logger.error("Missing Stripe price ID for credit pack", { envKey: (planDef ?? packDef)!.envKey, route: "billing/credit-pack" });
      return NextResponse.json(
        { error: "Credit packs not yet configured" },
        { status: 500 }
      );
    }

    const supabase = getSupabase();

    // Get user + their VM
    const { data: user } = await supabase
      .from("instaclaw_users")
      .select("id, email, stripe_customer_id")
      .eq("id", session.user.id)
      .single();

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id")
      .eq("assigned_to", session.user.id)
      .single();

    if (!vm) {
      return NextResponse.json(
        { error: "No active instance. Deploy first." },
        { status: 400 }
      );
    }

    const stripe = getStripe();

    // Get or create Stripe customer
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

    // ── Video creator plan: recurring checkout (mode:"subscription"). ──
    // subscription_data.metadata carries the discrimination marker
    // (lib/video-plan.ts isVideoPlanSubscription's belt half — the price-id
    // match is the suspenders) so EVERY downstream webhook can tell this sub
    // from the platform sub. Identity/status sync rides subscription.created;
    // the allowance grant rides invoice.paid exclusively.
    if (planDef) {
      // One video plan per user: an active/past_due plan on their current VM
      // means a second subscription would double-bill.
      const { data: planVm } = await supabase
        .from("instaclaw_vms")
        .select("video_plan_status")
        .eq("id", vm.id)
        .single();
      if (planVm?.video_plan_status === "active" || planVm?.video_plan_status === "past_due") {
        return NextResponse.json(
          { error: "You already have the video creator plan. Manage it from the billing page." },
          { status: 409 }
        );
      }
      const planSession = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: "subscription",
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${origin}${returnPath ?? "/billing"}?plan=video_subscribed`,
        cancel_url: `${origin}${returnPath ?? "/billing"}`,
        metadata: {
          type: "video_plan",
          instaclaw_user_id: user.id,
          vm_id: vm.id,
        },
        subscription_data: {
          metadata: { plan_type: "video_creator_plan" },
        },
      });
      return NextResponse.json({ url: planSession.url });
    }

    const checkoutSession = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "payment",
      line_items: [{ price: priceId, quantity: 1 }],
      // pack id rides the success URL so the landing page's confirmation
      // toast can say WHAT was bought + show the fresh balance (user test #1
      // round two: "credits added" is generic; the system knows better).
      success_url: `${origin}${returnPath ?? "/dashboard"}?credits=purchased&pack=${encodeURIComponent(pack)}`,
      cancel_url: `${origin}${returnPath ?? "/dashboard"}`,
      metadata: {
        type: "credit_pack",
        instaclaw_user_id: user.id,
        vm_id: vm.id,
        credits: String(packDef!.credits),
        // target distinguishes which balance the webhook credits.
        // Defaults to "messages" for backward-compat with the 3 legacy
        // packs that pre-date the field. New ToolRouter pack sets this
        // explicitly so the webhook can route to instaclaw_add_toolrouter_searches.
        ...(packDef!.target ? { target: packDef!.target } : {}),
      },
    });

    return NextResponse.json({ url: checkoutSession.url });
  } catch (err) {
    logger.error("Credit pack checkout error", { error: String(err), route: "billing/credit-pack" });
    return NextResponse.json(
      { error: "Failed to create checkout session" },
      { status: 500 }
    );
  }
}
