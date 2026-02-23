import { NextRequest, NextResponse, after } from "next/server";
import { getStripe, tierFromPriceId } from "@/lib/stripe";
import { getSupabase } from "@/lib/supabase";
import { assignVMWithSSHCheck } from "@/lib/ssh";
import { sendPaymentFailedEmail, sendCanceledEmail, sendPendingEmail, sendTrialEndingEmail, sendAdminAlertEmail, sendVMReadyEmail } from "@/lib/email";
import { logger } from "@/lib/logger";

// Give the function enough time for background processing via after().
// The response to Stripe is sent immediately (line 43) — maxDuration only
// controls how long the after() callback can run. Needs enough headroom for
// assignVMWithSSHCheck (~10s) + awaiting the configure endpoint (~50s).
export const maxDuration = 90;

export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = req.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  const stripe = getStripe();

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err) {
    logger.error("Webhook signature verification failed", { error: String(err), route: "billing/webhook" });
    sendAdminAlertEmail(
      "Stripe Webhook Signature Failure",
      `Webhook signature verification failed.\nError: ${String(err)}`
    ).catch(() => {});
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // Respond to Stripe immediately — process the event after the response is
  // sent. This prevents 499 timeouts (Stripe closes connections after ~20s).
  after(() => processEvent(event));

  return NextResponse.json({ received: true });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function processEvent(event: any) {
  const supabase = getSupabase();

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;

      // --- Handle credit pack purchases ---
      if (session.metadata?.type === "credit_pack") {
        const vmId = session.metadata.vm_id;
        const credits = parseInt(session.metadata.credits || "0", 10);
        const paymentIntent = session.payment_intent as string;

        if (vmId && credits > 0 && paymentIntent) {
          // Idempotency: insert purchase log first with UNIQUE constraint on
          // stripe_payment_intent. If this is a webhook retry, the insert will
          // return zero rows and we skip adding credits.
          const { data: inserted, error: insertErr } = await supabase
            .from("instaclaw_credit_purchases")
            .insert({
              vm_id: vmId,
              stripe_payment_intent: paymentIntent,
              credits_purchased: credits,
              amount_cents: session.amount_total ?? 0,
            })
            .select("id")
            .single();

          if (insertErr || !inserted) {
            // Duplicate payment_intent = webhook retry — skip credit addition
            logger.info("Credit pack webhook duplicate — skipping", {
              route: "billing/webhook",
              vmId,
              paymentIntent,
              error: insertErr ? String(insertErr) : "no row returned",
            });
            break;
          }

          // Only add credits if the insert succeeded (first delivery)
          await supabase.rpc("instaclaw_add_credits", {
            p_vm_id: vmId,
            p_credits: credits,
          });

          logger.info("Credit pack purchased", {
            route: "billing/webhook",
            vmId,
            credits,
            paymentIntent,
          });
        }
        break;
      }

      // --- Handle subscription checkout ---
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

      // Check if user already has a VM (verification endpoint may have assigned already)
      const { data: existingVm } = await supabase
        .from("instaclaw_vms")
        .select("id")
        .eq("assigned_to", userId)
        .single();

      if (existingVm) {
        logger.info("VM already assigned, skipping webhook assignment", {
          route: "billing/webhook",
          userId,
          vmId: existingVm.id,
        });
        break;
      }

      // Check deployment lock — the verify endpoint may already be handling assignment.
      // This prevents the race condition where both verify and webhook try to assign
      // a VM simultaneously.
      const { data: userLockCheck } = await supabase
        .from("instaclaw_users")
        .select("deployment_lock_at")
        .eq("id", userId)
        .single();

      if (userLockCheck?.deployment_lock_at) {
        const lockAge = Date.now() - new Date(userLockCheck.deployment_lock_at).getTime();
        if (lockAge < 5 * 60 * 1000) {
          logger.info("Deployment lock active (verify endpoint handling), skipping webhook assignment", {
            route: "billing/webhook",
            userId,
            lockAge: `${Math.round(lockAge / 1000)}s`,
          });
          break;
        }
      }

      // Try to assign a VM (with SSH pre-check to avoid dead VMs)
      const vm = await assignVMWithSSHCheck(userId);

      if (vm) {
        // VM assigned — trigger configuration with retry.
        // This runs inside after() so the Stripe response is already sent.
        // Retry up to 2 times (3 attempts total) with 5s backoff to handle
        // transient fetch failures that would otherwise leave the user stuck.
        let configured = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const configRes = await fetch(
              `${process.env.NEXTAUTH_URL}/api/vm/configure`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-Admin-Key": process.env.ADMIN_API_KEY ?? "",
                },
                body: JSON.stringify({ userId }),
              }
            );
            if (configRes.ok) {
              configured = true;
              break;
            }
            logger.warn("VM configure returned non-OK, retrying", {
              route: "billing/webhook",
              userId,
              attempt,
              status: configRes.status,
            });
          } catch (err) {
            logger.error("VM configure call failed", {
              error: String(err),
              route: "billing/webhook",
              userId,
              attempt,
            });
          }
          if (attempt < 2) await new Promise(r => setTimeout(r, 5000));
        }
        if (!configured) {
          logger.error("VM configure failed after 3 attempts — process-pending cron will retry", {
            route: "billing/webhook",
            userId,
            vmId: vm.id,
          });
          // Alert admin so they can investigate
          sendAdminAlertEmail(
            "VM Configure Failed After Checkout",
            `VM ${vm.id} (user: ${userId}) failed to configure after 3 webhook attempts.\n\nThe process-pending cron will retry automatically, but this may indicate an infrastructure issue.`
          ).catch(() => {});
        }
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

      break;
    }

    case "customer.subscription.updated": {
      const subscription = event.data.object;
      const customerId = subscription.customer as string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const periodEnd = (subscription as any).current_period_end as number | undefined;

      // Detect tier changes (upgrades/downgrades) from the subscription's current price
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items = (subscription as any).items?.data as Array<{ price?: { id?: string } }> | undefined;
      const currentPriceId = items?.[0]?.price?.id;
      const newTier = currentPriceId ? tierFromPriceId(currentPriceId) : null;

      const subUpdates: Record<string, unknown> = {
        status: subscription.status,
        ...(periodEnd
          ? { current_period_end: new Date(periodEnd * 1000).toISOString() }
          : {}),
        ...(newTier ? { tier: newTier } : {}),
      };

      await supabase
        .from("instaclaw_subscriptions")
        .update(subUpdates)
        .eq("stripe_customer_id", customerId);

      // If tier changed, also update the VM so the proxy uses the new daily limit
      if (newTier) {
        const { data: sub } = await supabase
          .from("instaclaw_subscriptions")
          .select("user_id")
          .eq("stripe_customer_id", customerId)
          .single();

        if (sub) {
          await supabase
            .from("instaclaw_vms")
            .update({ tier: newTier })
            .eq("assigned_to", sub.user_id);

          logger.info("Tier updated via subscription change", {
            route: "billing/webhook",
            userId: sub.user_id,
            newTier,
            priceId: currentPriceId,
          });
        }
      }

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

        // Stamp the VM with last_assigned_to so we can find it for future migration
        // if the user re-subscribes and gets a different VM
        const { data: userVm } = await supabase
          .from("instaclaw_vms")
          .select("id")
          .eq("assigned_to", sub.user_id)
          .single();

        if (userVm) {
          await supabase
            .from("instaclaw_vms")
            .update({ last_assigned_to: sub.user_id })
            .eq("id", userVm.id);
        }

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
        .select("user_id, payment_status, past_due_since")
        .eq("stripe_customer_id", customerId)
        .single();

      if (sub) {
        // Set past_due_since if not already set (first failure)
        const updates: Record<string, unknown> = { payment_status: "past_due" };
        if (!sub.past_due_since) {
          updates.past_due_since = new Date().toISOString();
        }

        await supabase
          .from("instaclaw_subscriptions")
          .update(updates)
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

      // Clear past_due status and timestamp on successful payment
      const { data: sub } = await supabase
        .from("instaclaw_subscriptions")
        .select("user_id, payment_status, status")
        .eq("stripe_customer_id", customerId)
        .single();

      if (sub) {
        await supabase
          .from("instaclaw_subscriptions")
          .update({
            payment_status: "current",
            past_due_since: null
          })
          .eq("stripe_customer_id", customerId);

        // If they were past_due AND subscription is still active, restart their VM if suspended.
        // A canceled subscription can still have a final invoice payment — don't restart in that case.
        if (sub.payment_status === "past_due" && sub.status === "active") {
          const { data: vm } = await supabase
            .from("instaclaw_vms")
            .select("id, health_status")
            .eq("assigned_to", sub.user_id)
            .single();

          if (vm?.health_status === "suspended") {
            // Fire-and-forget: restart VM + send email without blocking
            fetch(`${process.env.NEXTAUTH_URL}/api/vm/restart`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Admin-Key": process.env.ADMIN_API_KEY ?? "",
              },
              body: JSON.stringify({ userId: sub.user_id }),
            }).catch((err) => {
              logger.error("Failed to restart suspended VM", { error: String(err), route: "billing/webhook", userId: sub.user_id });
            });

            const { data: user } = await supabase
              .from("instaclaw_users")
              .select("email")
              .eq("id", sub.user_id)
              .single();

            if (user?.email) {
              sendVMReadyEmail(user.email, `${process.env.NEXTAUTH_URL}/dashboard`).catch((emailErr) => {
                logger.error("Failed to send VM restored email", { error: String(emailErr), route: "billing/webhook" });
              });
            }
          }
        }
      }

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
}
