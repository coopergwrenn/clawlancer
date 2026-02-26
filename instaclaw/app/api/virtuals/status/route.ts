import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { checkAcpStatus, type VMRecord } from "@/lib/ssh";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Per-tier daily Virtuals credit limits. */
const VIRTUALS_LIMITS: Record<string, number> = {
  starter: 100,
  pro: 300,
  power: 1000,
};

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();

    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, ssh_port, ssh_user, agdp_enabled, tier, user_timezone")
      .eq("assigned_to", session.user.id)
      .single();

    if (!vm) {
      return NextResponse.json({ enabled: false, error: "No VM assigned" });
    }

    if (!vm.agdp_enabled) {
      return NextResponse.json({
        enabled: false,
        vmId: vm.id,
      });
    }

    // Get today's Virtuals usage from daily_usage table
    const tier = vm.tier || "starter";
    const userTz = vm.user_timezone || "America/New_York";
    const today = new Date().toLocaleDateString("en-CA", { timeZone: userTz });
    const virtualsLimit = VIRTUALS_LIMITS[tier] ?? 100;

    const { data: usageRow } = await supabase
      .from("instaclaw_daily_usage")
      .select("virtuals_count")
      .eq("vm_id", vm.id)
      .eq("usage_date", today)
      .single();

    const virtualsUsageToday = Number(usageRow?.virtuals_count ?? 0);

    // SSH to VM and check ACP status
    try {
      const status = await checkAcpStatus(vm as VMRecord & { tier?: string });

      return NextResponse.json({
        enabled: true,
        vmId: vm.id,
        authenticated: status.authenticated,
        serving: status.serving,
        walletAddress: status.walletAddress,
        agentName: status.agentName,
        offeringCount: status.offeringCount,
        authUrl: status.authUrl,
        virtualsUsageToday,
        virtualsLimit,
      });
    } catch (sshErr) {
      logger.warn("Virtuals status: SSH failed", {
        vmId: vm.id,
        error: String(sshErr),
      });
      return NextResponse.json({
        enabled: true,
        vmId: vm.id,
        authenticated: false,
        serving: false,
        virtualsUsageToday,
        virtualsLimit,
        error: "Could not connect to your agent instance. Try again in a moment.",
      });
    }
  } catch (err) {
    logger.error("Virtuals status error", {
      error: String(err),
      route: "virtuals/status",
    });
    return NextResponse.json(
      { error: "Failed to fetch Virtuals Protocol status" },
      { status: 500 }
    );
  }
}
