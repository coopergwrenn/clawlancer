import { NextRequest, NextResponse, after } from "next/server";
import { getStripe, tierFromPriceId } from "@/lib/stripe";
import { getSupabase } from "@/lib/supabase";
import { assignVMWithSSHCheck, checkDuplicateIP, wipeVMForNextUser, stopGateway, restartGateway } from "@/lib/ssh";
import { sendPaymentFailedEmail, sendCanceledEmail, sendPendingEmail, sendTrialEndingEmail, sendAdminAlertEmail, sendVMReadyEmail } from "@/lib/email";
import { logger } from "@/lib/logger";

// Provision a Bankr wallet for a newly assigned VM.
// Non-fatal: if Bankr API is down, the agent still works (just without a wallet).
async function provisionBankrWallet(vmId: string, userId: string, vmIp: string) {
  const partnerKey = process.env.BANKR_PARTNER_KEY;
  if (!partnerKey) return; // Not configured — skip silently

  try {
    const res = await fetch("https://api.bankr.bot/partner/wallets", {
      method: "POST",
      headers: {
        "x-partner-key": partnerKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        idempotencyKey: `instaclaw_user_${userId}`,
        apiKey: {
          permissions: {
            agentApiEnabled: true,
            llmGatewayEnabled: false,
            readOnly: false,
          },
          allowedIps: [vmIp],
        },
      }),
    });

    // 409 = idempotency key already used — wallet already exists, treat as success
    if (!res.ok && res.status !== 409) {
      const errText = await res.text().catch(() => "unknown");
      logger.warn("Bankr wallet provisioning failed (non-fatal)", {
        status: res.status,
        error: errText,
        userId,
        vmId,
      });
      return;
    }

    const data = await res.json();
    const supabase = getSupabase();
    await supabase
      .from("instaclaw_vms")
      .update({
        bankr_wallet_id: data.id ?? null,
        bankr_evm_address: data.evmAddress ?? null,
        bankr_api_key_encrypted: data.apiKey ?? null, // TODO: encrypt before storing
      })
      .eq("id", vmId);

    logger.info("Bankr wallet provisioned", {
      vmId,
      userId,
      walletId: data.id,
      evmAddress: data.evmAddress,
    });
  } catch (err) {
    logger.warn("Bankr wallet provisioning error (non-fatal)", {
      error: String(err),
      userId,
      vmId,
    });
  }
}

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
            p_reference_id: paymentIntent,
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

      // Credit ambassador if this user was referred
      const referralCode = session.metadata?.referral_code;
      if (referralCode) {
        const { data: ambassador } = await supabase
          .from("instaclaw_ambassadors")
          .select("id, referral_count, earnings_total")
          .eq("referral_code", referralCode)
          .eq("status", "approved")
          .single();

        if (ambassador) {
          await supabase
            .from("instaclaw_ambassadors")
            .update({
              referral_count: (ambassador.referral_count ?? 0) + 1,
              earnings_total: Number(ambassador.earnings_total ?? 0) + 10,
            })
            .eq("id", ambassador.id);

          // Record paid conversion in referrals table.
          // Uses upsert on (ambassador_id, referred_user_id) unique constraint
          // to handle the race condition where auth.ts may have already inserted a row.
          try {
            const now = new Date().toISOString();
            const { data: existingRef } = await supabase
              .from("instaclaw_ambassador_referrals")
              .select("id")
              .eq("ambassador_id", ambassador.id)
              .eq("referred_user_id", userId)
              .limit(1)
              .single();

            if (existingRef) {
              // Update existing row (created by waitlist or auth.ts)
              await supabase
                .from("instaclaw_ambassador_referrals")
                .update({
                  paid_at: now,
                  converted_at: now,
                  commission_amount: 10,
                  commission_status: "pending",
                })
                .eq("id", existingRef.id);
            } else {
              // No existing row — insert, but handle unique constraint violation gracefully
              const { error: insertErr } = await supabase.from("instaclaw_ambassador_referrals").insert({
                ambassador_id: ambassador.id,
                referred_user_id: userId,
                ref_code: referralCode,
                signed_up_at: now,
                converted_at: now,
                paid_at: now,
                commission_amount: 10,
                commission_status: "pending",
              });

              // If auth.ts raced us and inserted first, update the existing row instead
              if (insertErr?.code === "23505") {
                await supabase
                  .from("instaclaw_ambassador_referrals")
                  .update({
                    paid_at: now,
                    converted_at: now,
                    commission_amount: 10,
                    commission_status: "pending",
                  })
                  .eq("ambassador_id", ambassador.id)
                  .eq("referred_user_id", userId);
              }
            }
          } catch (refErr) {
            logger.error("Failed to record paid referral", { error: String(refErr), route: "billing/webhook" });
          }

          logger.info("Ambassador referral credited", {
            route: "billing/webhook",
            ambassadorId: ambassador.id,
            referralCode,
            referredUserId: userId,
            earnings: 10,
          });
        }
      }

      // Check if user already has a VM (verification endpoint may have assigned already)
      const { data: existingVm } = await supabase
        .from("instaclaw_vms")
        .select("id")
        .eq("assigned_to", userId)
        .single();

      if (existingVm) {
        // Reactivate suspended VM on resubscription
        const { data: vmDetail } = await supabase
          .from("instaclaw_vms")
          .select("*")
          .eq("id", existingVm.id)
          .single();

        if (vmDetail?.health_status === "suspended") {
          try {
            await restartGateway(vmDetail);
            await supabase.from("instaclaw_vms").update({
              health_status: "unknown",
              suspended_at: null,
              last_health_check: new Date().toISOString(),
            }).eq("id", vmDetail.id);

            // Send welcome-back email
            const { data: resubUser } = await supabase
              .from("instaclaw_users").select("email").eq("id", userId).single();
            if (resubUser?.email) {
              sendVMReadyEmail(resubUser.email, `${process.env.NEXTAUTH_URL}/dashboard`).catch(() => {});
            }

            logger.info("Reactivated suspended VM on resubscription", {
              route: "billing/webhook", userId, vmId: vmDetail.id,
            });
          } catch (err) {
            logger.error("Failed to reactivate suspended VM on resubscription", {
              error: String(err), route: "billing/webhook", userId, vmId: vmDetail.id,
            });
          }
        } else {
          logger.info("VM already assigned, skipping webhook assignment", {
            route: "billing/webhook",
            userId,
            vmId: existingVm.id,
          });
        }
        break;
      }

      // NOTE: We no longer skip on deployment_lock_at. The verify endpoint
      // now runs configure inline, and the configure endpoint has its own
      // idempotency guard (skips if VM is already healthy + recently configured).
      // Letting the webhook proceed as a safety net ensures users don't get stuck
      // if the verify endpoint's configure call fails silently.

      // Try to assign a VM (with SSH pre-check to avoid dead VMs)
      const vm = await assignVMWithSSHCheck(userId);

      if (vm) {
        // Post-assignment verification: confirm the VM is actually assigned to this user.
        // Guards against race conditions where two webhooks assign concurrently.
        const { data: assignedVm } = await supabase
          .from("instaclaw_vms")
          .select("assigned_to")
          .eq("id", vm.id)
          .single();

        if (assignedVm?.assigned_to !== userId) {
          logger.error("CRITICAL: VM ownership mismatch after assignment — aborting configure", {
            route: "billing/webhook",
            userId,
            vmId: vm.id,
            actualOwner: assignedVm?.assigned_to,
          });
          sendAdminAlertEmail(
            "CRITICAL: VM Assignment Race Condition in Webhook",
            `VM ${vm.id} was assigned to user ${userId} but is now owned by ${assignedVm?.assigned_to}.\n\nConfigure was NOT triggered. User ${userId} needs manual intervention.`
          ).catch(() => {});
          break;
        }

        // Provision Bankr wallet for the agent (non-fatal — agent works without it)
        await provisionBankrWallet(vm.id, userId, vm.ip_address);

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
      // Fallback: use event timestamp if Stripe didn't include period end
      const periodEndResolved = periodEnd
        ? new Date(periodEnd * 1000).toISOString()
        : new Date(event.created * 1000).toISOString();

      // Detect tier changes (upgrades/downgrades) from the subscription's current price.
      // Stripe webhook payloads don't always expand items.data (especially for
      // Dashboard-initiated changes). Fall back to fetching the full subscription
      // from the Stripe API when items.data is missing.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let items = (subscription as any).items?.data as Array<{ price?: { id?: string } }> | undefined;
      if (!items || items.length === 0) {
        try {
          const fullSub = await getStripe().subscriptions.retrieve(subscription.id, {
            expand: ["items.data.price"],
          });
          items = fullSub.items?.data as Array<{ price?: { id?: string } }> | undefined;
          logger.info("Fetched subscription items from Stripe API (not in webhook payload)", {
            route: "billing/webhook",
            subscriptionId: subscription.id,
            itemCount: items?.length ?? 0,
          });
        } catch (err) {
          logger.error("Failed to fetch subscription from Stripe API", {
            route: "billing/webhook",
            subscriptionId: subscription.id,
            error: String(err),
          });
        }
      }
      const currentPriceId = items?.[0]?.price?.id;
      const newTier = currentPriceId ? tierFromPriceId(currentPriceId) : null;

      // Log when tier detection fails so we catch future mapping gaps
      if (!newTier && currentPriceId) {
        logger.warn("Unrecognized Stripe price ID — tier not updated", {
          route: "billing/webhook",
          subscriptionId: subscription.id,
          priceId: currentPriceId,
        });
      }
      if (!newTier && !currentPriceId) {
        logger.warn("No price ID found in subscription update — items may be missing", {
          route: "billing/webhook",
          subscriptionId: subscription.id,
          customerId,
        });
      }

      const subUpdates: Record<string, unknown> = {
        status: subscription.status,
        current_period_end: periodEndResolved,
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const deletedPeriodEnd = (subscription as any).current_period_end as number | undefined;

      // Find the user
      const { data: sub } = await supabase
        .from("instaclaw_subscriptions")
        .select("user_id")
        .eq("stripe_customer_id", customerId)
        .single();

      if (sub) {
        // Update subscription status + period end (was missing, causing null bug)
        await supabase
          .from("instaclaw_subscriptions")
          .update({
            status: "canceled",
            payment_status: "current",
            current_period_end: deletedPeriodEnd
              ? new Date(deletedPeriodEnd * 1000).toISOString()
              : new Date(event.created * 1000).toISOString(),
          })
          .eq("user_id", sub.user_id);

        // Stamp the VM with last_assigned_to so we can find it for future migration
        // if the user re-subscribes and gets a different VM
        const { data: userVm } = await supabase
          .from("instaclaw_vms")
          .select("id")
          .eq("assigned_to", sub.user_id)
          .single();

        if (userVm) {
          // Stamp last_assigned_to and clear telegram fields
          // (releases unique constraint so a future VM can reuse the token)
          await supabase
            .from("instaclaw_vms")
            .update({
              last_assigned_to: sub.user_id,
              telegram_bot_token: null,
              telegram_bot_username: null,
              telegram_chat_id: null,
            })
            .eq("id", userVm.id);

          // Suspend the VM (stop gateway, preserve data for 30 days)
          // The 30-day reclaim pass in health-check cron will wipe + reclaim later.
          const { data: fullVm } = await supabase
            .from("instaclaw_vms")
            .select("*")
            .eq("id", userVm.id)
            .single();

          if (fullVm) {
            try {
              await stopGateway(fullVm);
            } catch (err) {
              logger.error("Failed to stop gateway on subscription cancel", {
                error: String(err),
                route: "billing/webhook",
                vmId: userVm.id,
                userId: sub.user_id,
              });
            }

            await supabase
              .from("instaclaw_vms")
              .update({
                health_status: "suspended",
                suspended_at: new Date().toISOString(),
                last_health_check: new Date().toISOString(),
              })
              .eq("id", userVm.id);

            logger.info("VM suspended on subscription cancel (data preserved 30 days)", {
              route: "billing/webhook",
              vmId: userVm.id,
              userId: sub.user_id,
            });
          }
        }

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
            // Restart gateway directly (replaces unreliable fire-and-forget fetch)
            const { data: fullVm } = await supabase
              .from("instaclaw_vms").select("*").eq("id", vm.id).single();

            if (fullVm) {
              try {
                const restarted = await restartGateway(fullVm);
                if (restarted) {
                  await supabase.from("instaclaw_vms").update({
                    health_status: "unknown",
                    suspended_at: null,
                    last_health_check: new Date().toISOString(),
                  }).eq("id", fullVm.id);

                  logger.info("Reactivated suspended VM on payment success", {
                    route: "billing/webhook", userId: sub.user_id, vmId: fullVm.id,
                  });
                }
              } catch (err) {
                logger.error("Failed to restart suspended VM on payment success", {
                  error: String(err), route: "billing/webhook", userId: sub.user_id, vmId: vm.id,
                });
              }
            }

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

    case "charge.refunded": {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const charge = event.data.object as any;
      const customerId = charge.customer as string;

      if (customerId) {
        // Find the user via their subscription's stripe_customer_id
        const { data: sub } = await supabase
          .from("instaclaw_subscriptions")
          .select("user_id")
          .eq("stripe_customer_id", customerId)
          .single();

        if (sub) {
          // Find and void the referral commission for this user
          const { data: referralRow } = await supabase
            .from("instaclaw_ambassador_referrals")
            .select("id, ambassador_id, commission_amount, commission_status")
            .eq("referred_user_id", sub.user_id)
            .eq("commission_status", "pending")
            .limit(1)
            .single();

          if (referralRow) {
            // Void the commission
            await supabase
              .from("instaclaw_ambassador_referrals")
              .update({ commission_status: "void" })
              .eq("id", referralRow.id);

            // Decrement ambassador's earnings_total
            const commission = Number(referralRow.commission_amount ?? 0);
            if (commission > 0) {
              const { data: ambassador } = await supabase
                .from("instaclaw_ambassadors")
                .select("id, earnings_total")
                .eq("id", referralRow.ambassador_id)
                .single();

              if (ambassador) {
                await supabase
                  .from("instaclaw_ambassadors")
                  .update({
                    earnings_total: Math.max(0, Number(ambassador.earnings_total ?? 0) - commission),
                  })
                  .eq("id", ambassador.id);
              }
            }

            logger.info("Refund: ambassador commission voided", {
              route: "billing/webhook",
              userId: sub.user_id,
              referralId: referralRow.id,
              ambassadorId: referralRow.ambassador_id,
              commission,
            });
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
