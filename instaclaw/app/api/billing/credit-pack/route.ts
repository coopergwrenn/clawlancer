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

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { pack } = (await req.json()) as { pack: string };

    const packDef = CREDIT_PACKS[pack];
    if (!packDef) {
      return NextResponse.json(
        { error: `Invalid credit pack. Valid packs: ${Object.keys(CREDIT_PACKS).join(", ")}.` },
        { status: 400 }
      );
    }

    const priceId = process.env[packDef.envKey];
    if (!priceId) {
      logger.error("Missing Stripe price ID for credit pack", { envKey: packDef.envKey, route: "billing/credit-pack" });
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

    const checkoutSession = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "payment",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/dashboard?credits=purchased`,
      cancel_url: `${origin}/dashboard`,
      metadata: {
        type: "credit_pack",
        instaclaw_user_id: user.id,
        vm_id: vm.id,
        credits: String(packDef.credits),
        // target distinguishes which balance the webhook credits.
        // Defaults to "messages" for backward-compat with the 3 legacy
        // packs that pre-date the field. New ToolRouter pack sets this
        // explicitly so the webhook can route to instaclaw_add_toolrouter_searches.
        ...(packDef.target ? { target: packDef.target } : {}),
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
