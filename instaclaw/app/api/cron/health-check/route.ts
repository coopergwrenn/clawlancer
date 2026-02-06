import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

// SSH health check to avoid self-signed TLS cert rejection
async function checkHealthViaSSH(
  vm: { ip_address: string; ssh_port: number; ssh_user: string }
): Promise<boolean> {
  try {
    if (!process.env.SSH_PRIVATE_KEY_B64) return false;
    const { NodeSSH } = await import("node-ssh");
    const ssh = new NodeSSH();
    await ssh.connect({
      host: vm.ip_address,
      port: vm.ssh_port,
      username: vm.ssh_user,
      privateKey: Buffer.from(
        process.env.SSH_PRIVATE_KEY_B64,
        "base64"
      ).toString("utf-8"),
    });
    const result = await ssh.execCommand(
      "curl -sf http://127.0.0.1:8080/health"
    );
    ssh.dispose();
    return result.code === 0;
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest) {
  // Verify cron secret
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();

  // Get all assigned VMs
  const { data: vms } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, ssh_port, ssh_user, gateway_url, health_status")
    .eq("status", "assigned")
    .not("gateway_url", "is", null);

  if (!vms?.length) {
    return NextResponse.json({ checked: 0 });
  }

  let healthy = 0;
  let unhealthy = 0;

  for (const vm of vms) {
    const isHealthy = await checkHealthViaSSH(vm);

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
