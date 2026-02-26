import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { resyncGatewayToken, restoreWorkspaceFromBackup, testProxyRoundTrip } from "@/lib/ssh";
import { validateAdminKey } from "@/lib/security";
import { logger } from "@/lib/logger";

// Token resync is fast — no need for the 180s configure timeout
export const maxDuration = 60;

/**
 * Lightweight gateway token resync — fixes token mismatch without touching
 * agent personality, workspace, system prompt, or any other config.
 *
 * POST /api/vm/resync-token
 * Body: { vmId: string }
 * Optional: { vmId: string, restoreBackup: true } — also restores workspace from latest backup
 *
 * Requires admin API key (x-admin-key header).
 */
export async function POST(req: NextRequest) {
  if (!validateAdminKey(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { vmId, restoreBackup } = await req.json();

    if (!vmId || typeof vmId !== "string") {
      return NextResponse.json({ error: "vmId required" }, { status: 400 });
    }

    const supabase = getSupabase();

    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, ssh_port, ssh_user, name, assigned_to, gateway_token")
      .eq("id", vmId)
      .single();

    if (!vm) {
      return NextResponse.json({ error: "VM not found" }, { status: 404 });
    }

    if (!vm.ip_address) {
      return NextResponse.json({ error: "VM has no IP address" }, { status: 400 });
    }

    // Resync the token
    const { gatewayToken, healthy } = await resyncGatewayToken(vm);

    // Optionally restore workspace from backup
    let restoreResult = null;
    if (restoreBackup) {
      restoreResult = await restoreWorkspaceFromBackup(vm);
    }

    // Verify proxy round-trip
    let proxyOk = false;
    try {
      const proxyResult = await testProxyRoundTrip(gatewayToken);
      proxyOk = proxyResult.success;
    } catch {
      // Non-fatal — token is resynced even if proxy test fails
    }

    logger.info("Gateway token resynced", {
      route: "vm/resync-token",
      vmId: vm.id,
      vmName: vm.name,
      healthy,
      proxyOk,
      restored: restoreResult?.restored ?? false,
    });

    return NextResponse.json({
      resynced: true,
      healthy,
      proxyOk,
      restore: restoreResult,
    });
  } catch (err) {
    logger.error("Token resync failed", {
      error: String(err),
      route: "vm/resync-token",
    });
    return NextResponse.json(
      { error: "Token resync failed: " + String(err) },
      { status: 500 }
    );
  }
}
