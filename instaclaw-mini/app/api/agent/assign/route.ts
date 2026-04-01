import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { supabase } from "@/lib/supabase";
import { proxyToInstaclaw } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/agent/assign
 *
 * Assigns a VM to the user IMMEDIATELY (fast, <5s).
 * Separated from configure so the user gets their agent right away.
 * Configure runs in the background afterward.
 *
 * This is the critical fix: assignment is fast and synchronous,
 * configuration is slow and asynchronous. Users never get stuck.
 */
export async function POST() {
  try {
    const session = await requireSession();

    // Step 1: Assign VM via instaclaw.io (fast — RPC + SSH check, <10s)
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
        { error: "No agents available right now. Please try again shortly." },
        { status: 503 }
      );
    }

    // Step 2: Mark onboarding complete (fast — direct DB update)
    await supabase()
      .from("instaclaw_users")
      .update({ onboarding_complete: true })
      .eq("id", session.userId);

    // Step 3: Confirm any pending WLD delegation (fast — direct DB update)
    await supabase()
      .from("instaclaw_wld_delegations")
      .update({
        status: "confirmed",
        confirmed_at: new Date().toISOString(),
        vm_id: assignData.vm?.id || null,
      })
      .eq("user_id", session.userId)
      .in("status", ["pending", "pending_confirmation"]);

    // Step 4: Fire configure in background (slow — 60-90s, don't wait)
    proxyToInstaclaw("/api/vm/configure", session.userId, {
      method: "POST",
      body: JSON.stringify({ userId: session.userId }),
    }).catch(() => {});

    return NextResponse.json({
      success: true,
      vmId: assignData.vm?.id,
    });
  } catch (err) {
    if (err instanceof Error && err.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("[agent/assign] Error:", err);
    return NextResponse.json({ error: "Assignment failed" }, { status: 500 });
  }
}
