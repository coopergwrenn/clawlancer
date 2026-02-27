import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { startAcpServe, completeAcpAuth, type VMRecord } from "@/lib/ssh";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/virtuals/activate
 * Called after the user completes the Virtuals Protocol auth URL flow.
 * Tries startAcpServe first (key exists). If auth not completed, falls
 * back to completeAcpAuth using the stored authRequestId.
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
      .select("id, ip_address, ssh_port, ssh_user, agdp_enabled, acp_auth_request_id")
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

    // Try the fast path — key already exists on VM
    const serveResult = await startAcpServe(vm as VMRecord);
    if (serveResult.success) {
      logger.info("ACP serve activated (key existed)", {
        vmId: vm.id,
        route: "virtuals/activate",
      });
      return NextResponse.json(serveResult);
    }

    // Key doesn't exist — try completing auth via stored requestId
    const requestId = vm.acp_auth_request_id;
    if (!requestId) {
      logger.warn("ACP activate: no auth request ID stored", {
        vmId: vm.id,
        route: "virtuals/activate",
      });
      return NextResponse.json({
        success: false,
        error: "No authentication session found. Please toggle Virtuals off and on to start a new auth flow.",
      });
    }

    const authResult = await completeAcpAuth(vm as VMRecord, requestId);

    if (authResult.success) {
      // Clear the auth request ID now that auth is complete
      await supabase
        .from("instaclaw_vms")
        .update({ acp_auth_request_id: null })
        .eq("id", vm.id);

      logger.info("ACP auth completed and serve activated", {
        vmId: vm.id,
        route: "virtuals/activate",
      });
    } else {
      logger.warn("ACP auth completion failed", {
        vmId: vm.id,
        error: authResult.error,
        route: "virtuals/activate",
      });
    }

    return NextResponse.json(authResult);
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
