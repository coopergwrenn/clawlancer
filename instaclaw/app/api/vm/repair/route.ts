import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { resyncGatewayToken, testProxyRoundTrip, restoreWorkspaceFromBackup } from "@/lib/ssh";
import { logger } from "@/lib/logger";

export const maxDuration = 120;

const REPAIR_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Two-phase repair:
 *   POST /api/vm/repair               — Phase 1: lightweight token resync (non-destructive)
 *   POST /api/vm/repair { deep: true } — Phase 2: full configure (destructive, needs confirmation)
 */
export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: { deep?: boolean } = {};
    try { body = await req.json(); } catch { /* empty body = phase 1 */ }

    const supabase = getSupabase();

    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, ssh_port, ssh_user, health_status, last_health_check, gateway_token, api_mode")
      .eq("assigned_to", session.user.id)
      .single();

    if (!vm) {
      return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
    }

    // Rate limit
    const lastCheck = vm.last_health_check
      ? new Date(vm.last_health_check).getTime()
      : 0;
    if (Date.now() - lastCheck < REPAIR_COOLDOWN_MS) {
      const retryAfter = Math.ceil(
        (lastCheck + REPAIR_COOLDOWN_MS - Date.now()) / 1000
      );
      return NextResponse.json(
        { error: "Repair was recently triggered. Please wait before trying again.", retryAfter },
        { status: 429 }
      );
    }

    // Update health status to show repairing state
    await supabase
      .from("instaclaw_vms")
      .update({ health_status: "unknown", last_health_check: new Date().toISOString() })
      .eq("id", vm.id);

    // ── Phase 2: Deep repair (full configure + restore) ──
    if (body.deep) {
      logger.info("Deep repair triggered by user", {
        route: "vm/repair",
        userId: session.user.id,
        vmId: vm.id,
      });

      // Fire full configure, then auto-restore workspace from backup
      try {
        const configRes = await fetch(`${process.env.NEXTAUTH_URL}/api/vm/configure`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Admin-Key": process.env.ADMIN_API_KEY ?? "",
          },
          body: JSON.stringify({ userId: session.user.id }),
        });
        const configData = await configRes.json();

        if (configRes.ok) {
          // Auto-restore workspace from backup after destructive configure
          let restoreResult = null;
          try {
            restoreResult = await restoreWorkspaceFromBackup(vm);
          } catch (restoreErr) {
            logger.warn("Workspace restore after deep repair failed", {
              error: String(restoreErr),
              vmId: vm.id,
            });
          }

          return NextResponse.json({
            repaired: true,
            method: "deep",
            restored: restoreResult?.restored ?? false,
            restoredFiles: restoreResult?.files ?? [],
          });
        }

        return NextResponse.json({
          repaired: false,
          method: "deep",
          error: configData.error || "Configure failed",
        }, { status: 500 });
      } catch (err) {
        logger.error("Deep repair failed", { error: String(err), vmId: vm.id });
        return NextResponse.json(
          { error: "Deep repair failed: " + String(err) },
          { status: 500 }
        );
      }
    }

    // ── Phase 1: Lightweight token resync (non-destructive) ──
    logger.info("Lightweight repair triggered by user", {
      route: "vm/repair",
      userId: session.user.id,
      vmId: vm.id,
      previousStatus: vm.health_status,
    });

    try {
      const { gatewayToken, healthy } = await resyncGatewayToken(vm, { apiMode: vm.api_mode ?? undefined });

      // Test proxy round-trip (only meaningful for all-inclusive VMs)
      let proxyOk = false;
      try {
        const proxyResult = await testProxyRoundTrip(gatewayToken);
        proxyOk = proxyResult.success;
      } catch { /* non-fatal */ }

      if (healthy && proxyOk) {
        await supabase
          .from("instaclaw_vms")
          .update({ health_status: "healthy" })
          .eq("id", vm.id);

        return NextResponse.json({
          repaired: true,
          method: "resync",
          healthy: true,
          proxyOk: true,
        });
      }

      // Resync didn't fully fix it — tell the client deep repair is needed
      return NextResponse.json({
        repaired: false,
        method: "resync",
        healthy,
        proxyOk,
        needsDeepRepair: true,
      });
    } catch (resyncErr) {
      logger.error("Lightweight resync failed", {
        error: String(resyncErr),
        vmId: vm.id,
      });

      // Resync failed entirely — tell client deep repair is needed
      return NextResponse.json({
        repaired: false,
        method: "resync",
        needsDeepRepair: true,
        error: String(resyncErr),
      });
    }
  } catch (err) {
    logger.error("VM repair error", { error: String(err), route: "vm/repair" });
    return NextResponse.json(
      { error: "Failed to start repair" },
      { status: 500 }
    );
  }
}
