import { NextRequest, NextResponse, after } from "next/server";
import { getStripe, tierFromPriceId } from "@/lib/stripe";
import { getSupabase } from "@/lib/supabase";
import { assignVMWithSSHCheck, checkDuplicateIP, wipeVMForNextUser, stopGateway, restartGateway, auditVMConfig } from "@/lib/ssh";
import { VM_MANIFEST } from "@/lib/vm-manifest";
import { sendPaymentFailedEmail, sendCanceledEmail, sendPendingEmail, sendTrialEndingEmail, sendAdminAlertEmail, sendVMReadyEmail } from "@/lib/email";
import { logger } from "@/lib/logger";
import { provisionBankrWallet } from "@/lib/bankr-provision";
import { thawVM } from "@/lib/vm-freeze-thaw";
import { randomUUID } from "node:crypto";

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

  // Credit-pack purchases run SYNCHRONOUSLY so an RPC failure can surface as
  // a non-2xx response and trigger Stripe's webhook retry. Subscription events
  // stay on the after()-deferred path because they perform SSH/configure work
  // that can exceed Stripe's 20s response window. Credit-pack handling is just
  // two DB calls + one RPC — well under the budget.
  //
  // Historical bug: 24 of 33 (72.7%) credit_pack purchases over 90 days were
  // orphaned — credit_purchases idempotency row written, ledger row missing.
  // Root cause: the prior `await supabase.rpc(...)` did not check `error`, so
  // any transient RPC failure was silently swallowed and the user received no
  // credits. Recovered manually 2026-04-28.
  if (event.type === "checkout.session.completed"
      && (event.data?.object as any)?.metadata?.type === "credit_pack") {
    try {
      await handleCreditPackPurchase(event.data.object);
    } catch (err) {
      logger.error("Credit pack webhook handler threw — returning 500 for Stripe retry", {
        route: "billing/webhook",
        error: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json({ error: "credit_pack_processing_failed" }, { status: 500 });
    }
    return NextResponse.json({ received: true });
  }

  // Everything else: respond to Stripe immediately and process in background
  // (prevents 499 timeouts since Stripe closes connections after ~20s).
  after(() => processEvent(event));

  return NextResponse.json({ received: true });
}

/**
 * Handle a credit_pack checkout.session.completed event.
 *
 * Idempotency strategy (two layers):
 *   1. UNIQUE(stripe_payment_intent) on instaclaw_credit_purchases prevents
 *      duplicate rows across webhook retries.
 *   2. The orphan-recovery branch below detects the case where the purchase
 *      row was claimed by a prior delivery but the subsequent RPC silently
 *      failed (the historical bug). On retry, this branch re-runs the credit
 *      add against the existing purchase row.
 *
 * Throws on any DB / RPC failure so the POST handler can return non-2xx and
 * Stripe will retry the webhook.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleCreditPackPurchase(session: any): Promise<void> {
  const supabase = getSupabase();
  const vmId = session.metadata?.vm_id as string | undefined;
  const credits = parseInt(session.metadata?.credits || "0", 10);
  const paymentIntent = session.payment_intent as string | undefined;

  if (!vmId || !(credits > 0) || !paymentIntent) {
    logger.error("Credit pack webhook: missing required metadata — cannot process", {
      route: "billing/webhook", vmId, credits, paymentIntent, sessionId: session.id,
    });
    // Return cleanly — retrying won't help, the metadata is permanently absent.
    // Admin alert so this doesn't disappear silently.
    sendAdminAlertEmail(
      "Credit Pack Webhook: Missing Metadata",
      `Stripe checkout session ${session.id} arrived with type=credit_pack but is missing required metadata.\nvm_id=${vmId}\ncredits=${credits}\npayment_intent=${paymentIntent}\n\nUser will not receive credits without manual intervention.`,
    ).catch(() => {});
    return;
  }

  // Try to claim this purchase by inserting the idempotency row.
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

  let mustAddCredits: boolean;
  if (insertErr) {
    // Insert failed. Distinguish duplicate-PI (expected retry) from a real DB error.
    // PostgREST returns code 23505 on UNIQUE violation.
    const isDuplicate = (insertErr as any).code === "23505"
      || /duplicate key/i.test(insertErr.message ?? "");
    if (!isDuplicate) {
      logger.error("Credit pack webhook: idempotency insert failed (non-duplicate)", {
        route: "billing/webhook", vmId, paymentIntent,
        error: insertErr.message, code: (insertErr as any).code,
      });
      throw new Error(`credit_pack_insert_failed: ${insertErr.message}`);
    }

    // Duplicate. Was the prior delivery's credit-add successful? Check the
    // ledger — if no row references this PI on this VM, the prior delivery
    // hit the historical silent-failure bug. We must add credits ourselves.
    const { data: ledgerRows, error: ledgerErr } = await supabase
      .from("instaclaw_credit_ledger")
      .select("id")
      .eq("vm_id", vmId)
      .eq("reference_id", paymentIntent)
      .limit(1);
    if (ledgerErr) {
      logger.error("Credit pack webhook: ledger probe failed during dedup check", {
        route: "billing/webhook", vmId, paymentIntent, error: ledgerErr.message,
      });
      throw new Error(`credit_pack_ledger_probe_failed: ${ledgerErr.message}`);
    }

    if (!ledgerRows || ledgerRows.length === 0) {
      logger.warn("Credit pack webhook: orphan recovery — purchase row exists, ledger empty, re-running credit-add", {
        route: "billing/webhook", vmId, paymentIntent, credits,
      });
      mustAddCredits = true;
    } else {
      logger.info("Credit pack webhook: duplicate — credits already in ledger, skipping", {
        route: "billing/webhook", vmId, paymentIntent, ledgerRowId: ledgerRows[0].id,
      });
      mustAddCredits = false;
    }
  } else if (!inserted) {
    // Indeterminate: no error and no row. Should not happen with .single() but
    // guard against it — surface so Stripe retries.
    logger.error("Credit pack webhook: insert returned no row and no error — indeterminate state", {
      route: "billing/webhook", vmId, paymentIntent,
    });
    throw new Error("credit_pack_insert_indeterminate");
  } else {
    // First delivery — we own the credit-add.
    mustAddCredits = true;
  }

  if (!mustAddCredits) return;

  const { data: newBalance, error: rpcErr } = await supabase.rpc("instaclaw_add_credits", {
    p_vm_id: vmId,
    p_credits: credits,
    p_reference_id: paymentIntent,
  });
  if (rpcErr) {
    logger.error("Credit pack webhook: instaclaw_add_credits RPC failed — throwing for Stripe retry", {
      route: "billing/webhook", vmId, paymentIntent, credits,
      error: rpcErr.message, code: (rpcErr as any).code,
    });
    throw new Error(`instaclaw_add_credits failed for vm=${vmId} pi=${paymentIntent}: ${rpcErr.message}`);
  }
  logger.info("Credit pack purchased — credits posted", {
    route: "billing/webhook", vmId, paymentIntent, credits, newBalance,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function processEvent(event: any) {
  const supabase = getSupabase();

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;

      // Credit-pack purchases are handled synchronously in POST() above
      // (so RPC failures can return non-2xx and trigger Stripe retry).
      // They never reach this deferred path.

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
            // Reactivation runs the same drift-repair primitive the reconciler
            // cron uses (auditVMConfig → reconcileVM). This is INSTEAD of the
            // previous `restartGateway + status="unknown"` minimal flip, which
            // left users on stale code (e.g. v58 silence-watchdog without the
            // telegram-origin fix) until the reconciler eventually picked them
            // up — typically minutes, sometimes longer if the reconciler had
            // skipped them via its old health_status="healthy" filter.
            //
            // NOT configureOpenClaw — that primitive's privacy-guard wipe at
            // lib/ssh.ts:3322-3361 deletes the user's own session/memory data
            // when it finds files. Same user resubscribing means files are
            // expected; running configureOpenClaw here would destroy their
            // history. auditVMConfig pushes manifest drift without wiping.
            //
            // skipGatewayRestart=false (the default) so the gateway IS started
            // here — that's the whole point of reactivation.
            const auditResult = await auditVMConfig(vmDetail, { strict: false });
            if (auditResult.errors.length > 0) {
              logger.warn("Reactivation audit had push errors — VM live but config drift remains", {
                route: "billing/webhook",
                userId,
                vmId: vmDetail.id,
                errors: auditResult.errors,
                fixed: auditResult.fixed,
              });
            } else {
              logger.info("Reactivation audit clean", {
                route: "billing/webhook",
                userId,
                vmId: vmDetail.id,
                fixed: auditResult.fixed.length,
                gatewayRestarted: auditResult.gatewayRestarted,
              });
            }
            // Belt-and-suspenders: ensure the gateway is running. If
            // auditVMConfig didn't restart it (no config drift detected),
            // a suspended VM may still have its gateway stopped from the
            // suspend cron. Always call restartGateway so the user can use
            // their VM immediately. Idempotent: if already running, just
            // bumps it.
            if (!auditResult.gatewayRestarted) {
              await restartGateway(vmDetail);
            }
            const updates: Record<string, unknown> = {
              // health-check cron will flip to 'healthy' once it confirms
              // the gateway is responsive.
              health_status: "unknown",
              suspended_at: null,
              last_health_check: new Date().toISOString(),
            };
            // Bump config_version only when audit was clean (same gate as
            // the reconciler). If errors remain, leave it for the reconciler
            // to retry.
            if (auditResult.errors.length === 0) {
              updates.config_version = VM_MANIFEST.version;
            }
            await supabase.from("instaclaw_vms").update(updates).eq("id", vmDetail.id);

            // Send welcome-back email
            const { data: resubUser } = await supabase
              .from("instaclaw_users").select("email").eq("id", userId).single();
            if (resubUser?.email) {
              sendVMReadyEmail(resubUser.email, `${process.env.NEXTAUTH_URL}/dashboard`).catch(() => {});
            }

            logger.info("Reactivated suspended VM on resubscription", {
              route: "billing/webhook", userId, vmId: vmDetail.id,
              auditFixed: auditResult.fixed.length,
              auditErrors: auditResult.errors.length,
              configVersionBumped: auditResult.errors.length === 0,
            });
          } catch (err) {
            logger.error("Failed to reactivate suspended VM on resubscription", {
              error: String(err), route: "billing/webhook", userId, vmId: vmDetail.id,
            });
            // Fall back to the old minimal path — at least restart the
            // gateway so the user can use their VM. Reconciler will pick up
            // the drift later.
            try {
              await restartGateway(vmDetail);
              await supabase.from("instaclaw_vms").update({
                health_status: "unknown",
                suspended_at: null,
                last_health_check: new Date().toISOString(),
              }).eq("id", vmDetail.id);
              logger.warn("Reactivation fell back to minimal restart-only path", {
                route: "billing/webhook", userId, vmId: vmDetail.id,
              });
            } catch (fallbackErr) {
              logger.error("Reactivation fallback also failed", {
                error: String(fallbackErr), route: "billing/webhook", userId, vmId: vmDetail.id,
              });
            }
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

        // Provision Bankr wallet for the agent (non-fatal — agent works without it).
        // Idempotency key `instaclaw_user_${userId}` means webhook retries return
        // the SAME wallet rather than minting duplicates.
        await provisionBankrWallet({
          vmId: vm.id,
          userId,
          vmIp: vm.ip_address,
          idempotencyKey: `instaclaw_user_${userId}`,
        });

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

      // Phase 3 — auto-thaw on subscription reactivation.
      //
      // If the user's new status is active/trialing AND they have a frozen
      // VM, provision a new instance from their personal snapshot. thawVM()
      // is a no-op if there's no frozen VM for the user, so it's safe to
      // call on every subscription.updated event without checking the prior
      // status (avoids missing edge cases like webhook retries where we
      // don't have the old status available).
      //
      // Wrapped in try/catch — a thaw failure must NOT block the webhook
      // (Stripe will retry the whole event, and a retry would just freeze
      // again on the next vm-lifecycle pass).
      if (subscription.status === "active" || subscription.status === "trialing") {
        try {
          const { data: subRow } = await supabase
            .from("instaclaw_subscriptions")
            .select("user_id")
            .eq("stripe_customer_id", customerId)
            .single();
          if (subRow?.user_id) {
            // Cheap pre-check before invoking the (heavy) thawVM provisioning
            // path — most subscription.updated events won't be reactivations.
            const { data: frozen } = await supabase
              .from("instaclaw_vms")
              .select("id")
              .eq("assigned_to", subRow.user_id)
              .eq("status", "frozen")
              .not("frozen_image_id", "is", null)
              .limit(1);
            if (frozen && frozen.length > 0) {
              const runId = randomUUID();
              logger.info("billing/webhook: triggering auto-thaw", {
                route: "billing/webhook",
                userId: subRow.user_id,
                subscriptionStatus: subscription.status,
                runId,
              });
              const result = await thawVM(supabase, subRow.user_id, false, runId);
              if (!result.success) {
                logger.error("billing/webhook: auto-thaw failed", {
                  route: "billing/webhook",
                  userId: subRow.user_id,
                  reason: result.reason,
                  runId,
                });
                sendAdminAlertEmail(
                  "VM Auto-Thaw Failed",
                  `User ${subRow.user_id} reactivated but auto-thaw failed.\nReason: ${result.reason}\nRun ID: ${runId}\n\nManual thaw: POST /api/admin/thaw-vm with { user_id: "${subRow.user_id}" }`,
                ).catch(() => {});
              } else {
                logger.info("billing/webhook: auto-thaw succeeded", {
                  route: "billing/webhook",
                  userId: subRow.user_id,
                  newIp: result.newIp,
                  runId,
                });
              }
            }
          }
        } catch (err) {
          logger.error("billing/webhook: auto-thaw threw", {
            route: "billing/webhook",
            customerId,
            error: err instanceof Error ? err.message : String(err),
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
