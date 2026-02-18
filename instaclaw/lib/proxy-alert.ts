import { NextRequest } from "next/server";
import { getSupabase } from "./supabase";
import { sendAdminAlertEmail } from "./email";
import { logger } from "./logger";

const ALERT_THRESHOLD = 3;

/**
 * Track a proxy 401 (invalid gateway token) for alerting.
 * Looks up the VM by source IP, increments proxy_401_count,
 * and sends an admin alert when the threshold is reached.
 */
export async function trackProxy401(
  token: string,
  req: NextRequest
): Promise<void> {
  const supabase = getSupabase();

  // Try to identify the VM by the request's source IP
  const forwardedFor = req.headers.get("x-forwarded-for");
  const sourceIp = forwardedFor?.split(",")[0]?.trim();

  if (!sourceIp) {
    logger.warn("Proxy 401 with no source IP — cannot track", {
      route: "proxy-alert",
      tokenPrefix: token.slice(0, 8),
    });
    return;
  }

  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id, assigned_to, name, proxy_401_count")
    .eq("ip_address", sourceIp)
    .single();

  if (!vm) {
    logger.warn("Proxy 401 from unknown IP", {
      route: "proxy-alert",
      sourceIp,
      tokenPrefix: token.slice(0, 8),
    });
    return;
  }

  const newCount = (vm.proxy_401_count ?? 0) + 1;

  await supabase
    .from("instaclaw_vms")
    .update({ proxy_401_count: newCount })
    .eq("id", vm.id);

  logger.warn("Proxy 401 tracked", {
    route: "proxy-alert",
    vmId: vm.id,
    vmName: vm.name,
    count: newCount,
    sourceIp,
  });

  if (newCount >= ALERT_THRESHOLD) {
    await sendAdminAlertEmail(
      "Proxy 401 Alert — Repeated Auth Failures",
      `VM ${vm.id} (${vm.name ?? "unnamed"}, user: ${vm.assigned_to}) has hit ${newCount} consecutive proxy 401 errors.\n\nSource IP: ${sourceIp}\nToken prefix: ${token.slice(0, 8)}...\n\nThis likely means the gateway token on the VM doesn't match the DB. A repair/reconfigure may be needed.`
    );
  }
}

/**
 * Reset proxy_401_count to 0 for a VM after a successful proxy call.
 */
export async function resetProxy401Count(vmId: string): Promise<void> {
  const supabase = getSupabase();
  await supabase
    .from("instaclaw_vms")
    .update({ proxy_401_count: 0 })
    .eq("id", vmId);
}
