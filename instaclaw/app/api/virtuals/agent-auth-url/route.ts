import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { lookupVMByGatewayToken } from "@/lib/gateway-auth";
import { getAcpAuthUrl } from "@/lib/acp-api";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * GET /api/virtuals/agent-auth-url
 *
 * Agent-facing endpoint: generates a fresh Virtuals Protocol auth URL.
 * Called by the agent via `curl` when the user wants to set up ACP/DegenClaw.
 *
 * Auth: gateway token (same as proxy).
 * Returns: { authUrl, authRequestId }
 *
 * The agent sends the authUrl to the user, who clicks it in their browser.
 * After auth, the agent calls /api/virtuals/agent-complete-auth to save credentials.
 */
export async function GET(req: NextRequest) {
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
      "id, ip_address, ssh_port, ssh_user, assigned_to"
    );

    if (!vm) {
      return NextResponse.json({ error: "Invalid gateway token" }, { status: 401 });
    }

    // Generate fresh auth URL
    const authData = await getAcpAuthUrl();

    // Store requestId in DB so agent-complete-auth can use it
    const supabase = getSupabase();
    await supabase
      .from("instaclaw_vms")
      .update({ acp_auth_request_id: authData.requestId })
      .eq("id", vm.id);

    logger.info("Agent requested ACP auth URL", {
      vmId: vm.id,
      requestId: authData.requestId,
      route: "virtuals/agent-auth-url",
    });

    return NextResponse.json({
      authUrl: authData.authUrl,
      authRequestId: authData.requestId,
    });
  } catch (err) {
    logger.error("Agent auth URL error", {
      error: String(err),
      route: "virtuals/agent-auth-url",
    });
    return NextResponse.json(
      { error: "Failed to generate auth URL" },
      { status: 500 }
    );
  }
}
