import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { checkHealth, restartGateway } from "@/lib/ssh";
import { sendHealthAlertEmail } from "@/lib/email";
import { logger } from "@/lib/logger";

const ALERT_THRESHOLD = 3; // Send alert after 3 consecutive failures
const ADMIN_EMAIL = process.env.ADMIN_ALERT_EMAIL ?? "";

export async function GET(req: NextRequest) {
  // Verify cron secret
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();

  // Get all assigned VMs with a gateway URL (includes "configuring" VMs
  // that finished SSH setup but haven't passed health check yet)
  const { data: vms } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, ssh_port, ssh_user, gateway_url, health_status, gateway_token, health_fail_count, assigned_to, name")
    .eq("status", "assigned")
    .not("gateway_url", "is", null);

  if (!vms?.length) {
    return NextResponse.json({ checked: 0 });
  }

  let healthy = 0;
  let unhealthy = 0;
  let alerted = 0;
  let restarted = 0;

  for (const vm of vms) {
    const isHealthy = await checkHealth(vm, vm.gateway_token ?? undefined);
    const currentFailCount = vm.health_fail_count ?? 0;

    if (isHealthy) {
      healthy++;
      // Reset fail count on success
      await supabase
        .from("instaclaw_vms")
        .update({
          health_status: "healthy",
          last_health_check: new Date().toISOString(),
          health_fail_count: 0,
        })
        .eq("id", vm.id);
    } else {
      unhealthy++;
      const newFailCount = currentFailCount + 1;

      await supabase
        .from("instaclaw_vms")
        .update({
          health_status: "unhealthy",
          last_health_check: new Date().toISOString(),
          health_fail_count: newFailCount,
        })
        .eq("id", vm.id);

      // After ALERT_THRESHOLD consecutive failures, take action
      if (newFailCount === ALERT_THRESHOLD) {
        // Auto-restart gateway
        try {
          await restartGateway(vm);
          restarted++;
        } catch (err) {
          logger.error("Failed to restart gateway", { error: String(err), route: "cron/health-check", vmId: vm.id });
        }

        // Send alert email to user
        if (vm.assigned_to) {
          const { data: user } = await supabase
            .from("instaclaw_users")
            .select("email")
            .eq("id", vm.assigned_to)
            .single();

          if (user?.email) {
            try {
              await sendHealthAlertEmail(user.email, vm.name ?? vm.id);
              alerted++;
            } catch (emailErr) {
              logger.error("Failed to send health alert email", { error: String(emailErr), route: "cron/health-check", vmId: vm.id });
            }
          }
        }

        // Also alert admin
        if (ADMIN_EMAIL) {
          try {
            await sendHealthAlertEmail(
              ADMIN_EMAIL,
              `${vm.name ?? vm.id} (user: ${vm.assigned_to})`
            );
          } catch {
            // Non-fatal
          }
        }
      }
    }
  }

  return NextResponse.json({
    checked: vms.length,
    healthy,
    unhealthy,
    restarted,
    alerted,
  });
}
