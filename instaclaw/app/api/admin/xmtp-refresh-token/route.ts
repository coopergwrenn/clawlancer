import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/admin/xmtp-refresh-token
 *
 * Updates the gateway token in the XMTP agent's .env file WITHOUT
 * regenerating the wallet key — preserves the same XMTP address.
 * Then restarts the XMTP service.
 *
 * Body: { vmId: string }
 */
export async function POST(req: NextRequest) {
  const adminKey = req.headers.get("x-admin-key");
  if (adminKey !== process.env.ADMIN_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();
  let vmId: string;
  try {
    const body = await req.json();
    vmId = body.vmId;
  } catch {
    return NextResponse.json({ error: "vmId required" }, { status: 400 });
  }

  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, ssh_port, ssh_user, gateway_token")
    .eq("id", vmId)
    .single();

  if (!vm) {
    return NextResponse.json({ error: "VM not found" }, { status: 404 });
  }

  try {
    const { NodeSSH } = await import("node-ssh");
    const privateKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");

    const ssh = new NodeSSH();
    await ssh.connect({
      host: vm.ip_address,
      port: vm.ssh_port,
      username: vm.ssh_user,
      privateKey,
    });

    // Read current .env to get the wallet key (preserve it)
    const readEnv = await ssh.execCommand("cat ~/.openclaw/xmtp/.env 2>/dev/null || echo 'MISSING'");
    if (readEnv.stdout.includes("MISSING")) {
      ssh.dispose();
      return NextResponse.json({ error: "XMTP .env not found — run setup-xmtp-clean first" }, { status: 404 });
    }

    // Extract existing wallet key
    const walletKeyMatch = readEnv.stdout.match(/XMTP_WALLET_KEY=(.+)/);
    if (!walletKeyMatch) {
      ssh.dispose();
      return NextResponse.json({ error: "XMTP_WALLET_KEY not found in .env" }, { status: 500 });
    }

    // Rewrite .env with same wallet key but updated gateway token
    const envContent = [
      `XMTP_WALLET_KEY=${walletKeyMatch[1].trim()}`,
      `XMTP_ENV=production`,
      `GATEWAY_URL=http://localhost:18789`,
      `GATEWAY_TOKEN=${vm.gateway_token}`,
      `XMTP_DB_PATH=/home/openclaw/.openclaw/xmtp/db`,
    ].join("\n");

    await ssh.execCommand(
      `cat > ~/.openclaw/xmtp/.env << 'ENVEOF'\n${envContent}\nENVEOF`
    );

    // Restart the service
    const restart = await ssh.execCommand(
      'export XDG_RUNTIME_DIR="/run/user/$(id -u)" && systemctl --user restart instaclaw-xmtp && sleep 3 && systemctl --user is-active instaclaw-xmtp'
    );

    // Read the address (should be same as before)
    const addr = await ssh.execCommand("cat ~/.openclaw/xmtp/address 2>/dev/null || echo none");

    ssh.dispose();

    return NextResponse.json({
      success: true,
      serviceStatus: restart.stdout.trim(),
      xmtpAddress: addr.stdout.trim(),
      tokenPrefix: vm.gateway_token.slice(0, 8),
    });
  } catch (err) {
    logger.error("XMTP token refresh failed", { error: String(err), vmId });
    return NextResponse.json({ error: "Failed", detail: String(err) }, { status: 500 });
  }
}
