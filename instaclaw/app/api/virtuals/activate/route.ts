import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { startAcpServe, type VMRecord } from "@/lib/ssh";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/virtuals/activate
 * Called after the user completes the Virtuals Protocol auth URL flow.
 * Verifies auth, creates the seller offering, and starts acp serve.
 */
export async function POST() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();

    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, ssh_port, ssh_user, agdp_enabled")
      .eq("assigned_to", session.user.id)
      .single();

    if (!vm) {
      return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
    }

    if (!vm.agdp_enabled) {
      return NextResponse.json(
        { error: "Virtuals Protocol is not enabled. Enable it first from the earn page." },
        { status: 400 }
      );
    }

    const result = await startAcpServe(vm as VMRecord);

    if (result.success) {
      logger.info("ACP serve activated", {
        vmId: vm.id,
        route: "virtuals/activate",
      });
    } else {
      logger.warn("ACP serve activation failed", {
        vmId: vm.id,
        error: result.error,
        route: "virtuals/activate",
      });
    }

    return NextResponse.json(result);
  } catch (err) {
    logger.error("Virtuals activate error", {
      error: String(err),
      route: "virtuals/activate",
    });
    return NextResponse.json(
      { error: "Failed to activate Virtuals Protocol" },
      { status: 500 }
    );
  }
}
