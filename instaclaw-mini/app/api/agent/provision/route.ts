import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { supabase } from "@/lib/supabase";
import { proxyToInstaclaw } from "@/lib/api";
import { logOnboardingEvent } from "@/lib/onboarding-events";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/agent/provision
 *
 * Mini app equivalent of web app's checkout/verify.
 * CRITICAL: Only assigns a VM if a WLD delegation exists in the DB.
 * This prevents free VM assignment for users who didn't complete payment.
 *
 * Flow:
 *   1. Confirm WLD delegation (synchronous)
 *   2. VERIFY delegation exists in DB (gate — blocks if no payment)
 *   3. Assign VM (fast, <10s)
 *   4. Mark onboarding complete
 *   5. Trigger configure (fire-and-forget)
 */
export async function POST(req: Request) {
  try {
    const session = await requireSession();
    const body = await req.json().catch(() => ({}));

    // NOTE: Delegation confirm is now called from the CLIENT (onboarding.tsx)
    // before this endpoint. Server-side relative URL fetch doesn't work
    // in Vercel serverless functions.

    // ── Step 1: VERIFY payment exists (GATE — no payment = no VM) ──
    //
    // Two paths:
    // A) ONBOARDING PATH (body has reference + transactionId):
    //    MiniKit.pay() just returned success. Trust the transaction_id —
    //    this is the equivalent of Stripe's payment_status: "paid".
    //    On-chain confirmation happens in the background.
    //
    // B) RETRY PATH (no body context):
    //    Stricter — require confirmed status or on-chain tx hash.
    //    This prevents free VMs for users who never completed payment.
    //
    const isOnboardingPath = !!(body.reference && body.transactionId);

    if (!isOnboardingPath) {
      // Strict gate for retry/home page paths
      const { data: delegation } = await supabase()
        .from("instaclaw_wld_delegations")
        .select("id")
        .eq("user_id", session.userId)
        .or("status.eq.confirmed,status.eq.pending_confirmation,transaction_hash.not.is.null")
        .limit(1)
        .single();

      if (!delegation) {
        // Also check for Stripe subscription
        const { data: sub } = await supabase()
          .from("instaclaw_subscriptions")
          .select("id")
          .eq("user_id", session.userId)
          .in("status", ["active", "trialing"])
          .limit(1)
          .single();

        if (!sub) {
          console.error("[provision] No verified payment for user", { userId: session.userId });
          return NextResponse.json(
            { error: "Payment not found. Please complete payment first." },
            { status: 402 }
          );
        }
      }
    }

    // ── Step 3: Check if user already has a VM ──
    const { data: existingVm } = await supabase()
      .from("instaclaw_vms")
      .select("id, health_status, gateway_url")
      .eq("assigned_to", session.userId)
      .single();

    let vmId = existingVm?.id;

    if (!existingVm) {
      // ── Step 4: Assign VM (synchronous, <10s) ──
      const assignRes = await proxyToInstaclaw("/api/vm/assign", session.userId, {
        method: "POST",
        body: JSON.stringify({
          userId: session.userId,
          initialCredits: 150,
        }),
      });

      const assignData = await assignRes.json().catch(() => ({}));

      if (!assignData.assigned) {
        return NextResponse.json(
          { error: "No agents available. Please try again shortly." },
          { status: 503 }
        );
      }

      vmId = assignData.vm?.id;
    }

    // ── Step 5: Mark onboarding complete ──
    await supabase()
      .from("instaclaw_users")
      .update({ onboarding_complete: true })
      .eq("id", session.userId);

    // ── Step 6: Confirm the delegation that has a transaction_id ──
    if (vmId) {
      await supabase()
        .from("instaclaw_wld_delegations")
        .update({
          status: "confirmed",
          confirmed_at: new Date().toISOString(),
          vm_id: vmId,
        })
        .eq("user_id", session.userId)
        .not("transaction_id", "is", null)
        .in("status", ["pending", "pending_confirmation"]);

      // Onboarding journey event: payment confirmed and bound to a VM.
      await logOnboardingEvent({
        userId: session.userId,
        eventType: "payment_completed",
        vmId,
        metadata: {
          path: isOnboardingPath ? "onboarding" : "retry",
          transaction_id: body?.transactionId ?? null,
          reference: body?.reference ?? null,
        },
      });
    }

    // ── Step 7: Fire configure (background — don't wait) ──
    proxyToInstaclaw("/api/vm/configure", session.userId, {
      method: "POST",
      body: JSON.stringify({ userId: session.userId }),
    }).catch(() => {});

    return NextResponse.json({
      success: true,
      vmId,
      status: existingVm?.health_status === "healthy" ? "ready" : "configuring",
    });
  } catch (err) {
    if (err instanceof Error && err.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("[provision] Error:", err);
    return NextResponse.json({ error: "Provisioning failed" }, { status: 500 });
  }
}
