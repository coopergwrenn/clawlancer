import { NextRequest, NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe";
import { getSupabase } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = req.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  const stripe = getStripe();
  const supabase = getSupabase();

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const userId = session.metadata?.instaclaw_user_id;
      const tier = session.metadata?.tier;
      const apiMode = session.metadata?.api_mode;

      if (!userId || !tier) break;

      // Create or update subscription record
      await supabase.from("instaclaw_subscriptions").upsert(
        {
          user_id: userId,
          tier,
          stripe_subscription_id: session.subscription as string,
          stripe_customer_id: session.customer as string,
          status: "active",
        },
        { onConflict: "user_id" }
      );

      // Check if user has pending config, if so trigger VM assignment
      const { data: pending } = await supabase
        .from("instaclaw_pending_users")
        .select("*")
        .eq("user_id", userId)
        .single();

      if (pending) {
        // Try to assign a VM
        const { data: vm } = await supabase.rpc("instaclaw_assign_vm", {
          p_user_id: userId,
        });

        if (vm) {
          // VM assigned — trigger configuration via internal call
          await fetch(
            `${process.env.NEXTAUTH_URL}/api/vm/configure`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ userId }),
            }
          );
        }
        // If no VM available, pending user stays in queue for cron to pick up
      }

      break;
    }

    case "customer.subscription.updated": {
      const subscription = event.data.object;
      const customerId = subscription.customer as string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const periodEnd = (subscription as any).current_period_end as number | undefined;

      await supabase
        .from("instaclaw_subscriptions")
        .update({
          status: subscription.status,
          ...(periodEnd
            ? { current_period_end: new Date(periodEnd * 1000).toISOString() }
            : {}),
        })
        .eq("stripe_customer_id", customerId);

      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object;
      const customerId = subscription.customer as string;

      // Find the user
      const { data: sub } = await supabase
        .from("instaclaw_subscriptions")
        .select("user_id")
        .eq("stripe_customer_id", customerId)
        .single();

      if (sub) {
        // Update subscription status
        await supabase
          .from("instaclaw_subscriptions")
          .update({ status: "canceled" })
          .eq("user_id", sub.user_id);

        // Reclaim the VM
        await supabase.rpc("instaclaw_reclaim_vm", {
          p_user_id: sub.user_id,
        });
      }

      break;
    }
  }

  return NextResponse.json({ received: true });
}
