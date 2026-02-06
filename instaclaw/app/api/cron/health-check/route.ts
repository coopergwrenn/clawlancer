import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { checkHealth } from "@/lib/ssh";

export async function GET(req: NextRequest) {
  // Verify cron secret
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();

  // Get all assigned VMs (include gateway_token for health check)
  const { data: vms } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, ssh_port, ssh_user, gateway_url, health_status, gateway_token")
    .eq("status", "assigned")
    .not("gateway_url", "is", null);

  if (!vms?.length) {
    return NextResponse.json({ checked: 0 });
  }

  let healthy = 0;
  let unhealthy = 0;

  for (const vm of vms) {
    const isHealthy = await checkHealth(vm, vm.gateway_token ?? undefined);

    const newStatus = isHealthy ? "healthy" : "unhealthy";
    if (isHealthy) healthy++;
    else unhealthy++;

    await supabase
      .from("instaclaw_vms")
      .update({
        health_status: newStatus,
        last_health_check: new Date().toISOString(),
      })
      .eq("id", vm.id);
  }

  return NextResponse.json({
    checked: vms.length,
    healthy,
    unhealthy,
  });
}
