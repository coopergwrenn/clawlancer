import { NextRequest, NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe";
import { getSupabase } from "@/lib/supabase";
import { sendPaymentFailedEmail, sendCanceledEmail, sendPendingEmail, sendTrialEndingEmail, sendAdminAlertEmail } from "@/lib/email";
import { logger } from "@/lib/logger";

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
    logger.error("Webhook signature verification failed", { error: String(err), route: "billing/webhook" });
    try {
      await sendAdminAlertEmail(
        "Stripe Webhook Signature Failure",
        `Webhook signature verification failed.\nError: ${String(err)}`
      );
    } catch {
      // Non-fatal
    }
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
          payment_status: "current",
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
          // VM assigned — fire-and-forget configuration.
          // The configure endpoint runs in its own serverless invocation,
          // so we don't need to await it. This prevents the webhook from
          // timing out (Stripe expects a response within ~20s).
          fetch(
            `${process.env.NEXTAUTH_URL}/api/vm/configure`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Admin-Key": process.env.ADMIN_API_KEY ?? "",
              },
              body: JSON.stringify({ userId }),
            }
          ).catch((err) => {
            logger.error("VM configure fire-and-forget failed", { error: String(err), route: "billing/webhook", userId });
          });
        }
        // If no VM available, send pending email
        if (!vm) {
          const { data: user } = await supabase
            .from("instaclaw_users")
            .select("email")
            .eq("id", userId)
            .single();
          if (user?.email) {
            try {
              await sendPendingEmail(user.email);
            } catch (emailErr) {
              logger.error("Failed to send pending email", { error: String(emailErr), route: "billing/webhook", userId });
            }
          }
        }
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
          .update({ status: "canceled", payment_status: "current" })
          .eq("user_id", sub.user_id);

        // Reclaim the VM
        await supabase.rpc("instaclaw_reclaim_vm", {
          p_user_id: sub.user_id,
        });

        // Send cancellation email
        const { data: user } = await supabase
          .from("instaclaw_users")
          .select("email")
          .eq("id", sub.user_id)
          .single();

        if (user?.email) {
          try {
            await sendCanceledEmail(user.email);
          } catch (emailErr) {
            logger.error("Failed to send canceled email", { error: String(emailErr), route: "billing/webhook" });
          }
        }
      }

      break;
    }

    case "invoice.payment_failed": {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const invoice = event.data.object as any;
      const customerId = invoice.customer as string;

      // Update subscription payment status to past_due
      const { data: sub } = await supabase
        .from("instaclaw_subscriptions")
        .select("user_id")
        .eq("stripe_customer_id", customerId)
        .single();

      if (sub) {
        await supabase
          .from("instaclaw_subscriptions")
          .update({ payment_status: "past_due" })
          .eq("user_id", sub.user_id);

        // Send payment failed email
        const { data: user } = await supabase
          .from("instaclaw_users")
          .select("email")
          .eq("id", sub.user_id)
          .single();

        if (user?.email) {
          try {
            await sendPaymentFailedEmail(user.email);
          } catch (emailErr) {
            logger.error("Failed to send payment failed email", { error: String(emailErr), route: "billing/webhook" });
          }
        }
      }

      break;
    }

    case "invoice.payment_succeeded": {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const invoice = event.data.object as any;
      const customerId = invoice.customer as string;

      // Clear past_due status on successful payment
      await supabase
        .from("instaclaw_subscriptions")
        .update({ payment_status: "current" })
        .eq("stripe_customer_id", customerId);

      break;
    }

    case "customer.subscription.trial_will_end": {
      const subscription = event.data.object;
      const customerId = subscription.customer as string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const trialEnd = (subscription as any).trial_end as number | undefined;
      const daysLeft = trialEnd
        ? Math.max(0, Math.ceil((trialEnd * 1000 - Date.now()) / (1000 * 60 * 60 * 24)))
        : 3;

      const { data: sub } = await supabase
        .from("instaclaw_subscriptions")
        .select("user_id")
        .eq("stripe_customer_id", customerId)
        .single();

      if (sub) {
        const { data: user } = await supabase
          .from("instaclaw_users")
          .select("email")
          .eq("id", sub.user_id)
          .single();

        if (user?.email) {
          try {
            await sendTrialEndingEmail(user.email, daysLeft);
          } catch (emailErr) {
            logger.error("Failed to send trial ending email", { error: String(emailErr), route: "billing/webhook" });
          }
        }
      }

      break;
    }
  }

  return NextResponse.json({ received: true });
}
