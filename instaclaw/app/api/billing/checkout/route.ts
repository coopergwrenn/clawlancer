import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getStripe, getPriceId, Tier, ApiMode } from "@/lib/stripe";
import { getSupabase } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { tier, apiMode } = (await req.json()) as {
      tier: Tier;
      apiMode: ApiMode;
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
      .select("id, email, stripe_customer_id")
      .eq("id", session.user.id)
      .single();

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

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
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/deploying?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/plan`,
      metadata: {
        instaclaw_user_id: user.id,
        tier,
        api_mode: apiMode,
      },
    });

    return NextResponse.json({ url: checkoutSession.url });
  } catch (err) {
    console.error("Checkout error:", err);
    return NextResponse.json(
      { error: "Failed to create checkout session" },
      { status: 500 }
    );
  }
}
