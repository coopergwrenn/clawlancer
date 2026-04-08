import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { supabase, getAgentStatus } from "@/lib/supabase";
import { proxyToInstaclaw } from "@/lib/api";

/**
 * Create or extend a subscription record for WLD delegation users.
 *
 * Why: The suspend-check cron suspends VMs with no active subscription + 0 credits.
 * WLD users pay via on-chain delegation, not Stripe, so they have no subscription
 * record. Without this, every WLD user gets suspended once they burn through credits.
 *
 * Behavior:
 * - If no subscription exists → create one (tier=starter, status=active, period=delegation expiry)
 * - If WLD subscription exists (stripe_subscription_id starts with "wld_") → extend period
 * - If Stripe subscription exists → DON'T touch it (Stripe is the source of truth)
 * - If subscription was canceled → reactivate with new period
 *
 * The suspend-check cron has a matching pre-pass that cancels WLD subscriptions
 * past their period end, so expired WLD users get the normal suspension flow.
 */
async function ensureWLDSubscription(
  userId: string,
  delegation: { credits_granted: number; expires_at: string }
) {
  // Map credit amounts to subscription tiers (controls daily free message limit)
  // starter = 600/day, pro = 1000/day
  const tier = delegation.credits_granted >= 2000 ? "pro" : "starter";
  const delegationEnd = new Date(delegation.expires_at);

  const { data: existing } = await supabase()
    .from("instaclaw_subscriptions")
    .select("id, status, stripe_subscription_id, current_period_end")
    .eq("user_id", userId)
    .single();

  if (existing) {
    // Don't overwrite a real Stripe subscription — Stripe is the source of truth
    const isWLD = !existing.stripe_subscription_id || existing.stripe_subscription_id.startsWith("wld_");
    if (!isWLD) {
      console.log("[Confirm] User has Stripe subscription — not creating WLD sub");
      return;
    }

    // Extend the WLD subscription period
    // If currently active and not expired, add the new duration on top
    // If expired or canceled, start fresh from now
    const currentEnd = existing.current_period_end ? new Date(existing.current_period_end) : new Date(0);
    const isExpired = currentEnd < new Date();
    const newEnd = isExpired ? delegationEnd : new Date(currentEnd.getTime() + (delegationEnd.getTime() - Date.now()));

    await supabase()
      .from("instaclaw_subscriptions")
      .update({
        status: "active",
        payment_status: "current",
        tier,
        current_period_end: newEnd.toISOString(),
      })
      .eq("user_id", userId);

    console.log("[Confirm] WLD subscription extended:", { userId, tier, newEnd: newEnd.toISOString() });
  } else {
    // Create new WLD subscription record
    // stripe_subscription_id starts with "wld_" so we can identify WLD subs
    // in the suspend-check expiry pre-pass
    await supabase()
      .from("instaclaw_subscriptions")
      .insert({
        user_id: userId,
        stripe_customer_id: `wld_${userId.slice(0, 8)}`,
        stripe_subscription_id: `wld_${Date.now()}`,
        tier,
        status: "active",
        payment_status: "current",
        current_period_end: delegationEnd.toISOString(),
      });

    console.log("[Confirm] WLD subscription created:", { userId, tier, periodEnd: delegationEnd.toISOString() });
  }
}

interface TxPollResult {
  status: string;
  hash?: string;
  /** Raw token amount from chain (WLD has 18 decimals) */
  amount?: string;
}

async function pollTransactionStatus(
  transactionId: string,
  appId: string,
  apiKey: string,
  maxAttempts = 8,
  delayMs = 2500
): Promise<TxPollResult> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(
        `https://developer.worldcoin.org/api/v2/minikit/transaction/${transactionId}?app_id=${appId}&type=payment`,
        { headers: { Authorization: `Bearer ${apiKey}` } }
      );

      if (res.ok) {
        const data = await res.json();
        console.log(`[Confirm] Poll attempt ${i + 1}: status=${data.transaction_status}, amount=${data.token_amount ?? data.amount ?? "N/A"}`);
        if (data.transaction_status === "mined") {
          return {
            status: "mined",
            hash: data.transactionHash,
            amount: data.token_amount ?? data.amount ?? undefined,
          };
        }
        if (data.transaction_status === "failed") {
          return { status: "failed" };
        }
      } else {
        console.log(`[Confirm] Poll attempt ${i + 1}: HTTP ${res.status}`);
      }
    } catch (err) {
      console.log(`[Confirm] Poll attempt ${i + 1}: error`, err);
    }

    if (i < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return { status: "pending" };
}

/**
 * Verify the on-chain WLD amount matches what we expected.
 * Returns true if amount is valid or if we can't verify (graceful degradation).
 * Returns false ONLY if we can confirm the amount is wrong.
 */
function verifyOnChainAmount(
  onChainAmount: string | undefined,
  expectedWld: number
): { valid: boolean; reason?: string } {
  if (!onChainAmount) {
    // API didn't return amount — log warning but don't block
    // (World Dev Portal may not always include this field)
    console.warn("[Confirm] On-chain amount not available from API — cannot verify amount");
    return { valid: true, reason: "amount_not_available" };
  }

  try {
    const expectedRaw = BigInt(expectedWld) * BigInt(10 ** 18);
    const actualRaw = BigInt(onChainAmount);

    // Allow 0.1% tolerance for rounding
    const tolerance = expectedRaw / BigInt(1000);
    const diff = actualRaw > expectedRaw
      ? actualRaw - expectedRaw
      : expectedRaw - actualRaw;

    if (diff > tolerance) {
      console.error(
        `[Confirm] AMOUNT MISMATCH: expected ${expectedRaw.toString()} (${expectedWld} WLD), got ${actualRaw.toString()}, diff=${diff.toString()}`
      );
      return { valid: false, reason: `expected ${expectedWld} WLD, got different amount` };
    }

    console.log(`[Confirm] Amount verified: ${expectedWld} WLD matches on-chain`);
    return { valid: true };
  } catch (err) {
    console.warn("[Confirm] Amount parse error:", err);
    // Can't parse — don't block, but log
    return { valid: true, reason: "parse_error" };
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    const { reference, transactionId, skipVerification } = await req.json();

    console.log("[Confirm] reference:", reference, "txId:", transactionId, "skip:", skipVerification);

    // Find the delegation record
    const { data: delegation, error: findErr } = await supabase()
      .from("instaclaw_wld_delegations")
      .select("*")
      .eq("transaction_id", reference)
      .eq("user_id", session.userId)
      .eq("status", "pending")
      .single();

    if (findErr || !delegation) {
      console.error("[Confirm] Delegation not found:", findErr);
      return NextResponse.json(
        { error: "Delegation record not found", detail: findErr?.message },
        { status: 404 }
      );
    }

    let txHash = transactionId;
    let onChainConfirmed = false;

    if (!skipVerification && transactionId) {
      const appId = process.env.NEXT_PUBLIC_APP_ID || "";
      const apiKey = process.env.DEV_PORTAL_API_KEY || "";

      const result = await pollTransactionStatus(transactionId, appId, apiKey);

      if (result.status === "mined") {
        onChainConfirmed = true;
        txHash = result.hash || transactionId;

        // C1 FIX: Verify on-chain amount matches expected WLD amount
        const amountCheck = verifyOnChainAmount(result.amount, delegation.amount_wld);
        if (!amountCheck.valid) {
          console.error("[Confirm] BLOCKED: Amount mismatch for delegation", delegation.id, amountCheck.reason);
          await supabase()
            .from("instaclaw_wld_delegations")
            .update({ status: "amount_mismatch", transaction_hash: txHash })
            .eq("id", delegation.id);
          return NextResponse.json(
            { error: "Payment amount does not match. Contact support." },
            { status: 400 }
          );
        }
      } else if (result.status === "failed") {
        await supabase()
          .from("instaclaw_wld_delegations")
          .update({ status: "failed", transaction_hash: txHash })
          .eq("id", delegation.id);
        return NextResponse.json(
          { error: "Transaction failed on-chain" },
          { status: 400 }
        );
      } else {
        // Still pending after retries — do NOT grant credits yet.
        // Mark as pending_confirmation so a background job can retry verification.
        await supabase()
          .from("instaclaw_wld_delegations")
          .update({ status: "pending_confirmation", transaction_hash: txHash })
          .eq("id", delegation.id);
        return NextResponse.json({
          success: false,
          pending: true,
          message: "Transaction is still confirming. Credits will be added automatically once confirmed.",
        });
      }
    }

    // Grant credits FIRST, then mark delegation confirmed
    // This ensures delegation is only "confirmed" after credits are truly added
    let agent = null;
    try {
      agent = await getAgentStatus(session.userId);
    } catch (err) {
      console.error("[Confirm] Agent lookup failed:", err);
    }

    if (agent) {
      // Atomic credit addition via RPC — prevents race conditions
      const rpcResult = await supabase()
        .rpc("instaclaw_add_credits", {
          p_vm_id: agent.id,
          p_credits: delegation.credits_granted,
          p_reference_id: `wld_delegation_${delegation.id}`,
          p_source: "wld",
        });

      let newBalance = rpcResult.data;
      let creditErr = rpcResult.error;

      // Fallback if p_source param not yet supported
      if (creditErr?.message?.includes("p_source")) {
        const fallback = await supabase()
          .rpc("instaclaw_add_credits", {
            p_vm_id: agent.id,
            p_credits: delegation.credits_granted,
            p_reference_id: `wld_delegation_${delegation.id}`,
          });
        newBalance = fallback.data;
        creditErr = fallback.error;
      }

      if (creditErr) {
        console.error("[Confirm] Credit RPC failed:", creditErr);
        // Mark delegation as failed so it can be retried
        await supabase()
          .from("instaclaw_wld_delegations")
          .update({ status: "credit_failed", transaction_hash: txHash })
          .eq("id", delegation.id);
        return NextResponse.json(
          { error: "Failed to add credits. Your payment was received — credits will be added shortly. Contact support if they don't appear within 5 minutes." },
          { status: 500 }
        );
      }

      console.log("[Confirm] Credits added:", delegation.credits_granted, "to vm:", agent.id, "new balance:", newBalance);

      // Create/extend subscription so suspend-check doesn't kill WLD users
      try {
        await ensureWLDSubscription(session.userId, delegation);
      } catch (subErr) {
        // Non-fatal — user has credits, subscription is a safety net
        console.error("[Confirm] WLD subscription upsert failed (non-fatal):", subErr);
      }

      // NOW mark delegation confirmed (credits were successfully added)
      await supabase()
        .from("instaclaw_wld_delegations")
        .update({
          status: onChainConfirmed ? "confirmed" : "pending_confirmation",
          transaction_hash: txHash,
          confirmed_at: new Date().toISOString(),
          vm_id: agent.id,
        })
        .eq("id", delegation.id);
    } else {
      // No agent yet — assign a VM from the pool, then configure it
      console.log("[Confirm] No agent found — assigning VM for user:", session.userId);
      try {
        // Step 1: Assign a VM
        const assignRes = await proxyToInstaclaw("/api/vm/assign", session.userId, {
          method: "POST",
          body: JSON.stringify({
            userId: session.userId,
            initialCredits: delegation.credits_granted,
          }),
        });
        const assignData = await assignRes.json().catch(() => ({}));
        console.log("[Confirm] VM assign result:", JSON.stringify(assignData));

        if (!assignData.assigned || !assignData.vm?.id) {
          console.error("[Confirm] VM assignment failed — no VMs available");
          return NextResponse.json(
            { error: "No agents available right now. Please try again later.", noVms: true },
            { status: 503 }
          );
        }

        // Step 2: Configure the assigned VM (await, don't fire-and-forget)
        try {
          const configRes = await proxyToInstaclaw("/api/vm/configure", session.userId, {
            method: "POST",
            body: JSON.stringify({ userId: session.userId }),
          });
          const configStatus = configRes.status;
          console.log("[Confirm] Configure returned:", configStatus);

          if (!configRes.ok) {
            console.error("[Confirm] Configure failed, but VM is assigned. Will retry on next health check.");
          }
        } catch (configErr) {
          console.error("[Confirm] Configure proxy error:", configErr);
          // VM is assigned but not configured — health check will retry
        }

        // Create/extend subscription so suspend-check doesn't kill WLD users
        try {
          await ensureWLDSubscription(session.userId, delegation);
        } catch (subErr) {
          console.error("[Confirm] WLD subscription upsert failed (non-fatal):", subErr);
        }

        // Mark delegation confirmed with vm_id
        await supabase()
          .from("instaclaw_wld_delegations")
          .update({
            status: onChainConfirmed ? "confirmed" : "pending_confirmation",
            transaction_hash: txHash,
            confirmed_at: new Date().toISOString(),
            vm_id: assignData.vm.id,
          })
          .eq("id", delegation.id);
      } catch (err) {
        console.error("[Confirm] VM assignment failed:", err);
        return NextResponse.json(
          { error: "VM assignment failed. Your WLD payment was received — contact support if your agent doesn't appear within 5 minutes." },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({
      success: true,
      creditsAdded: delegation.credits_granted,
      onChainConfirmed,
    });
  } catch (err) {
    const msg = err instanceof Error ? `${err.message}\n${err.stack}` : JSON.stringify(err);
    console.error("[Confirm] Error:", msg);
    return NextResponse.json(
      { error: "Failed to confirm delegation", detail: msg },
      { status: 500 }
    );
  }
}
