import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { supabase } from "@/lib/supabase";
import { proxyToInstaclaw } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/agent/provision
 *
 * THE mini app equivalent of the web app's checkout/verify endpoint.
 * Does everything synchronously in the right order:
 *
 *   1. Confirm WLD delegation (if reference/txId provided)
 *   2. Assign VM (fast, <10s)
 *   3. Mark onboarding complete
 *   4. Trigger configure (fire-and-forget — 60-90s in background)
 *   5. Return immediately so user sees provisioning UI
 *
 * The web app does steps 1-3 synchronously in checkout/verify, then
 * configure runs with retries. We match that pattern exactly.
 */
export async function POST(req: Request) {
  try {
    const session = await requireSession();
    const body = await req.json().catch(() => ({}));

    // ── Step 1: Confirm WLD delegation (synchronous) ──
    if (body.reference && body.transactionId) {
      try {
        const confirmRes = await fetch(
          `${process.env.NEXT_PUBLIC_BASE_URL || ""}/api/delegate/confirm`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              reference: body.reference,
              transactionId: body.transactionId,
            }),
          }
        );
        if (!confirmRes.ok) {
          console.warn("[provision] Delegation confirm failed:", confirmRes.status);
        }
      } catch (err) {
        console.warn("[provision] Delegation confirm error:", err);
      }
    }

    // ── Step 2: Check if user already has a VM ──
    const { data: existingVm } = await supabase()
      .from("instaclaw_vms")
      .select("id, health_status, gateway_url")
      .eq("assigned_to", session.userId)
      .single();

    let vmId = existingVm?.id;

    if (!existingVm) {
      // ── Step 3: Assign VM (synchronous, <10s) ──
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

    // ── Step 4: Mark onboarding complete ──
    await supabase()
      .from("instaclaw_users")
      .update({ onboarding_complete: true })
      .eq("id", session.userId);

    // ── Step 5: Confirm pending delegations ──
    if (vmId) {
      await supabase()
        .from("instaclaw_wld_delegations")
        .update({
          status: "confirmed",
          confirmed_at: new Date().toISOString(),
          vm_id: vmId,
        })
        .eq("user_id", session.userId)
        .in("status", ["pending", "pending_confirmation"]);
    }

    // ── Step 6: Fire configure (background — don't wait) ──
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
