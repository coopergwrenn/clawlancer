import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/admin/setup-xmtp-clean
 *
 * One-off endpoint: sets up a completely clean XMTP agent on vm-313
 * with a brand new wallet key and single DB directory.
 *
 * Requires X-Admin-Key header.
 */
export async function POST(req: NextRequest) {
  const adminKey = req.headers.get("x-admin-key");
  if (adminKey !== process.env.ADMIN_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const vmId = "1eac973f-1691-4700-a0ba-420f1956120c"; // vm-313
  const supabase = getSupabase();

  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, ssh_port, ssh_user, gateway_token")
    .eq("id", vmId)
    .single();

  if (!vm) {
    return NextResponse.json({ error: "VM not found" }, { status: 404 });
  }

  const results: string[] = [];

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
    results.push("SSH connected");

    // 1. Stop existing XMTP service
    const stopResult = await ssh.execCommand(
      'export XDG_RUNTIME_DIR="/run/user/$(id -u)" && systemctl --user stop instaclaw-xmtp 2>/dev/null; echo "stopped"'
    );
    results.push(`Stop service: ${stopResult.stdout.trim()}`);

    // 2. Generate a brand new Ethereum wallet key
    // Using Node.js crypto on the VM to generate a random 32-byte hex key
    const genKeyResult = await ssh.execCommand(
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
    const newWalletKey = genKeyResult.stdout.trim();
    if (!newWalletKey || newWalletKey.length !== 64) {
      ssh.dispose();
      return NextResponse.json({ error: "Failed to generate wallet key", detail: genKeyResult.stderr }, { status: 500 });
    }
    results.push(`New wallet key generated: ${newWalletKey.slice(0, 8)}...`);

    // 3. Completely remove old XMTP data (DB, keys, address files)
    const cleanResult = await ssh.execCommand(
      'rm -rf ~/.openclaw/xmtp ~/.xmtp /tmp/xmtp-* && echo "cleaned"'
    );
    results.push(`Clean old data: ${cleanResult.stdout.trim()}`);

    // 4. Create fresh XMTP directory and write .env
    const envContent = [
      `XMTP_WALLET_KEY=0x${newWalletKey}`,
      `XMTP_ENV=production`,
      `GATEWAY_URL=http://localhost:3000`,
      `GATEWAY_TOKEN=${vm.gateway_token}`,
      `XMTP_DB_PATH=/home/openclaw/.openclaw/xmtp/db`,
    ].join("\n");

    const writeEnvResult = await ssh.execCommand(
      `mkdir -p ~/.openclaw/xmtp && cat > ~/.openclaw/xmtp/.env << 'ENVEOF'\n${envContent}\nENVEOF\necho "env written"`
    );
    results.push(`Write .env: ${writeEnvResult.stdout.trim()}`);

    // 5. Ensure xmtp-agent.mjs is deployed
    const checkScript = await ssh.execCommand('ls -la ~/scripts/xmtp-agent.mjs 2>/dev/null || echo "missing"');
    results.push(`Script check: ${checkScript.stdout.trim()}`);

    if (checkScript.stdout.includes("missing")) {
      results.push("WARNING: xmtp-agent.mjs not found at ~/scripts/ — will attempt to create it");
      // The script is small enough to inline via SSH
      const scriptUrl = "https://raw.githubusercontent.com/coopergwrenn/clawlancer/main/instaclaw/skills/xmtp-agent/scripts/xmtp-agent.mjs";
      const deployResult = await ssh.execCommand(
        `source ~/.nvm/nvm.sh && mkdir -p ~/scripts && curl -sL "${scriptUrl}" -o ~/scripts/xmtp-agent.mjs && echo "deployed" || echo "deploy failed"`
      );
      results.push(`Deploy script: ${deployResult.stdout.trim()}`);
    }

    // 6. Ensure npm packages are installed
    const npmCheck = await ssh.execCommand(
      'cd ~/scripts && ls node_modules/@xmtp/agent-sdk 2>/dev/null && echo "xmtp-sdk-present" || echo "xmtp-sdk-missing"'
    );
    results.push(`NPM check: ${npmCheck.stdout.trim()}`);

    if (npmCheck.stdout.includes("missing")) {
      const installResult = await ssh.execCommand(
        'source ~/.nvm/nvm.sh && cd ~/scripts && npm install @xmtp/agent-sdk@latest 2>&1 | tail -5'
      );
      results.push(`NPM install: ${installResult.stdout.trim()}`);
    }

    // 7. Create/update systemd service
    const serviceContent = `[Unit]
Description=InstaClaw XMTP Agent
After=network.target

[Service]
Type=simple
ExecStart=/home/openclaw/.nvm/versions/node/v22.22.0/bin/node /home/openclaw/scripts/xmtp-agent.mjs
WorkingDirectory=/home/openclaw/scripts
EnvironmentFile=/home/openclaw/.openclaw/xmtp/.env
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target`;

    const writeServiceResult = await ssh.execCommand(
      `mkdir -p ~/.config/systemd/user && cat > ~/.config/systemd/user/instaclaw-xmtp.service << 'SVCEOF'\n${serviceContent}\nSVCEOF\necho "service written"`
    );
    results.push(`Write service: ${writeServiceResult.stdout.trim()}`);

    // 8. Reload and start the service
    const reloadResult = await ssh.execCommand(
      'export XDG_RUNTIME_DIR="/run/user/$(id -u)" && systemctl --user daemon-reload && systemctl --user start instaclaw-xmtp && sleep 3 && systemctl --user status instaclaw-xmtp --no-pager 2>&1 | head -15'
    );
    results.push(`Service status: ${reloadResult.stdout.trim()}`);

    // 9. Check the address file (written by the agent on startup)
    await new Promise((r) => setTimeout(r, 5000)); // Wait for agent to start
    const addrResult = await ssh.execCommand('cat ~/.openclaw/xmtp/address 2>/dev/null || echo "no address yet"');
    const xmtpAddress = addrResult.stdout.trim();
    results.push(`XMTP address: ${xmtpAddress}`);

    // 10. Check logs for any errors
    const logResult = await ssh.execCommand('tail -20 ~/.openclaw/logs/xmtp-agent.log 2>/dev/null || echo "no logs"');
    results.push(`Recent logs:\n${logResult.stdout.trim()}`);

    // 11. Update Supabase with new XMTP address
    if (xmtpAddress && xmtpAddress.startsWith("0x")) {
      await supabase
        .from("instaclaw_vms")
        .update({ xmtp_address: xmtpAddress })
        .eq("id", vmId);
      results.push(`DB updated with address: ${xmtpAddress}`);
    }

    ssh.dispose();

    return NextResponse.json({
      success: true,
      walletKeyPrefix: newWalletKey.slice(0, 8),
      xmtpAddress: xmtpAddress.startsWith("0x") ? xmtpAddress : null,
      steps: results,
    });
  } catch (err) {
    logger.error("XMTP setup failed", { error: String(err) });
    return NextResponse.json({
      error: "Setup failed",
      detail: String(err),
      steps: results,
    }, { status: 500 });
  }
}
