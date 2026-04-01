import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { restartGateway } from "@/lib/ssh";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/admin/restart-unhealthy
 * One-shot batch restart for all assigned VMs with dead gateways.
 * Auth: CRON_SECRET bearer token.
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();

  const { data: unhealthyVms } = await supabase
    .from("instaclaw_vms")
    .select("*")
    .eq("status", "assigned")
    .eq("health_status", "unhealthy")
    .order("health_fail_count", { ascending: false });

  if (!unhealthyVms?.length) {
    return NextResponse.json({ message: "No unhealthy VMs", restarted: 0 });
  }

  const results: { name: string; ip: string; success: boolean; error?: string }[] = [];

  for (const vm of unhealthyVms) {
    try {
      const ok = await restartGateway(vm);
      results.push({ name: vm.name, ip: vm.ip_address, success: ok });

      if (ok) {
        await supabase
          .from("instaclaw_vms")
          .update({
            health_status: "healthy",
            health_fail_count: 0,
            last_health_check: new Date().toISOString(),
            last_gateway_restart: new Date().toISOString(),
          })
          .eq("id", vm.id);
      }

      logger.info("Batch restart attempt", {
        route: "admin/restart-unhealthy",
        vmId: vm.id,
        vmName: vm.name,
        success: ok,
      });
    } catch (err) {
      results.push({ name: vm.name, ip: vm.ip_address, success: false, error: String(err) });
    }
  }

  const succeeded = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  return NextResponse.json({
    total: unhealthyVms.length,
    succeeded,
    failed,
    results,
  });
}
