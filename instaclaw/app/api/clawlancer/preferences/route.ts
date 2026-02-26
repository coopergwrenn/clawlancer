import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { autoClaim, approvalThreshold } = body;

    if (typeof autoClaim !== "boolean" && approvalThreshold === undefined) {
      return NextResponse.json(
        { error: "Must provide autoClaim (boolean) or approvalThreshold (number)" },
        { status: 400 }
      );
    }

    const threshold = Number(approvalThreshold);
    if (approvalThreshold !== undefined && (isNaN(threshold) || threshold < 0 || threshold > 10000)) {
      return NextResponse.json(
        { error: "approvalThreshold must be a number between 0 and 10000" },
        { status: 400 }
      );
    }

    const supabase = getSupabase();

    // Get user's VM
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id")
      .eq("assigned_to", session.user.id)
      .single();

    if (!vm) {
      return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
    }

    // Upsert preferences
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (typeof autoClaim === "boolean") updates.auto_claim = autoClaim;
    if (approvalThreshold !== undefined) updates.approval_threshold_usdc = threshold;

    const { error } = await supabase
      .from("instaclaw_clawlancer_preferences")
      .upsert(
        {
          vm_id: vm.id,
          ...updates,
        },
        { onConflict: "vm_id" }
      );

    if (error) {
      logger.error("Clawlancer preferences update failed", {
        error: error.message,
        vmId: vm.id,
      });
      return NextResponse.json(
        { error: "Failed to save preferences" },
        { status: 500 }
      );
    }

    logger.info("Clawlancer preferences updated", {
      vmId: vm.id,
      autoClaim: updates.auto_claim,
      approvalThreshold: updates.approval_threshold_usdc,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error("Clawlancer preferences error", {
      error: String(err),
      route: "clawlancer/preferences",
    });
    return NextResponse.json(
      { error: "Failed to update preferences" },
      { status: 500 }
    );
  }
}
