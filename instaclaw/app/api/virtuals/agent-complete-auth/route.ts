import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { lookupVMByGatewayToken } from "@/lib/gateway-auth";
import { completeAcpAuth, type VMRecord } from "@/lib/ssh";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/virtuals/agent-complete-auth
 *
 * Agent-facing endpoint: completes ACP auth after user clicked the auth URL.
 * Called by the agent via `curl` after the user confirms they authenticated.
 *
 * Auth: gateway token (same as proxy).
 * Body (optional): { authRequestId } — if not provided, reads from DB.
 * Returns: { success, error? }
 *
 * This does the heavy lifting SERVER-SIDE:
 * 1. Polls Virtuals API for auth completion (should be instant since user already clicked)
 * 2. Fetches/creates ACP agent
 * 3. Writes credentials to VM via SSH
 * 4. Starts acp-serve systemd service
 *
 * No long-running process on the VM needed.
 */
export async function POST(req: NextRequest) {
  try {
    const gatewayToken =
      req.headers.get("x-gateway-token") ||
      req.headers.get("x-api-key") ||
      req.headers.get("authorization")?.replace("Bearer ", "");

    if (!gatewayToken) {
      return NextResponse.json({ error: "Missing authentication" }, { status: 401 });
    }

    const vm = await lookupVMByGatewayToken(
      gatewayToken,
      "id, ip_address, ssh_port, ssh_user, assigned_to, acp_auth_request_id"
    );

    if (!vm) {
      return NextResponse.json({ error: "Invalid gateway token" }, { status: 401 });
    }

    // Get requestId from body or DB
    let requestId: string | null = null;
    try {
      const body = await req.json();
      requestId = body?.authRequestId || null;
    } catch {
      // No body — use DB value
    }

    if (!requestId) {
      requestId = vm.acp_auth_request_id;
    }

    if (!requestId) {
      return NextResponse.json({
        success: false,
        error: "No auth request ID found. Call /api/virtuals/agent-auth-url first to generate an auth URL.",
      }, { status: 400 });
    }

    logger.info("Agent completing ACP auth", {
      vmId: vm.id,
      requestId,
      route: "virtuals/agent-complete-auth",
    });

    // Complete auth server-side (polls Virtuals API, writes credentials to VM via SSH)
    const result = await completeAcpAuth(vm as VMRecord, requestId);

    if (result.success) {
      // Clear the auth request ID
      const supabase = getSupabase();
      await supabase
        .from("instaclaw_vms")
        .update({ acp_auth_request_id: null })
        .eq("id", vm.id);

      logger.info("Agent ACP auth completed successfully", {
        vmId: vm.id,
        route: "virtuals/agent-complete-auth",
      });
    } else {
      logger.warn("Agent ACP auth completion failed", {
        vmId: vm.id,
        error: result.error,
        route: "virtuals/agent-complete-auth",
      });
    }

    return NextResponse.json(result);
  } catch (err) {
    logger.error("Agent complete auth error", {
      error: String(err),
      route: "virtuals/agent-complete-auth",
    });
    return NextResponse.json(
      { error: "Failed to complete authentication" },
      { status: 500 }
    );
  }
}
