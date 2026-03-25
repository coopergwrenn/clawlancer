/**
 * Deploy XMTP Agent Service to a single VM.
 *
 * Usage: npx tsx scripts/_deploy-xmtp-agent.ts <vm-name>
 * Example: npx tsx scripts/_deploy-xmtp-agent.ts instaclaw-vm-313
 *
 * Steps:
 * 1. SSH into the VM
 * 2. Install @xmtp/agent-sdk (requires Node 22+)
 * 3. Generate XMTP wallet key (or reuse existing)
 * 4. Deploy the xmtp-agent.mjs service file
 * 5. Create systemd service unit
 * 6. Start the service
 * 7. Read the XMTP address and write it to Supabase
 */

import { createClient } from "@supabase/supabase-js";
import { NodeSSH } from "node-ssh";
import { readFileSync } from "fs";
import { join } from "path";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SSH_KEY_B64 = process.env.SSH_PRIVATE_KEY_B64 || "";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function main() {
  const vmName = process.argv[2];
  if (!vmName) {
    console.error("Usage: npx tsx scripts/_deploy-xmtp-agent.ts <vm-name>");
    process.exit(1);
  }

  // 1. Get VM details from Supabase
  console.log(`[Deploy XMTP] Looking up ${vmName}...`);
  const { data: vm, error: vmErr } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, ssh_port, ssh_user, gateway_url, gateway_token")
    .eq("name", vmName)
    .single();

  if (vmErr || !vm) {
    console.error("VM not found:", vmErr?.message);
    process.exit(1);
  }

  console.log(`[Deploy XMTP] VM: ${vmName} (${vm.ip_address})`);

  // 2. SSH connection
  if (!SSH_KEY_B64) {
    console.error("SSH_PRIVATE_KEY_B64 not set");
    process.exit(1);
  }

  const ssh = new NodeSSH();
  const privateKey = Buffer.from(SSH_KEY_B64, "base64").toString("utf-8");

  await ssh.connect({
    host: vm.ip_address,
    port: vm.ssh_port || 22,
    username: vm.ssh_user || "openclaw",
    privateKey,
  });

  console.log("[Deploy XMTP] Connected via SSH");

  // Helper: run command with NVM loaded so we get Node 22
  const NVM_PREFIX = 'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && ';
  const run = async (cmd: string) => {
    return ssh.execCommand(NVM_PREFIX + cmd);
  };

  // 3. Check Node.js version
  const nodeVersion = (await run("node --version")).stdout.trim();
  console.log(`[Deploy XMTP] Node.js version: ${nodeVersion}`);
  const major = parseInt(nodeVersion.replace("v", "").split(".")[0]);
  if (major < 22) {
    console.error(`Node.js >= 22 required, got ${nodeVersion}`);
    ssh.dispose();
    process.exit(1);
  }

  // 4. Create XMTP directory
  await run("mkdir -p ~/.openclaw/xmtp");

  // 5. Generate or reuse XMTP wallet key
  const existingKey = (await run("cat ~/.openclaw/xmtp/.env 2>/dev/null")).stdout;
  let hasWalletKey = existingKey.includes("XMTP_WALLET_KEY=");

  if (!hasWalletKey) {
    console.log("[Deploy XMTP] Generating new XMTP wallet key...");
    // Generate a random private key using Node.js crypto
    const genKeyCmd = `node -e "
      const crypto = require('crypto');
      const walletKey = '0x' + crypto.randomBytes(32).toString('hex');
      const dbEncKey = '0x' + crypto.randomBytes(32).toString('hex');
      const env = [
        'XMTP_WALLET_KEY=' + walletKey,
        'XMTP_DB_ENCRYPTION_KEY=' + dbEncKey,
        'XMTP_ENV=production',
        'XMTP_DB_DIRECTORY=/home/openclaw/.openclaw/xmtp/data',
      ].join('\\n');
      process.stdout.write(env);
    "`;
    const genResult = await run(genKeyCmd);
    if (genResult.code !== 0) {
      console.error("Key generation failed:", genResult.stderr);
      ssh.dispose();
      process.exit(1);
    }
    await run(`cat > ~/.openclaw/xmtp/.env << 'XMTPENV'\n${genResult.stdout}\nGATEWAY_URL=${vm.gateway_url}\nGATEWAY_TOKEN=${vm.gateway_token}\nXMTPENV`);
    await run("chmod 600 ~/.openclaw/xmtp/.env");
    console.log("[Deploy XMTP] Wallet key generated and saved");
  } else {
    console.log("[Deploy XMTP] Existing XMTP wallet key found");
    // Update gateway URL/token in case they changed
    const hasGateway = existingKey.includes("GATEWAY_URL=");
    if (!hasGateway) {
      await run(`echo "GATEWAY_URL=${vm.gateway_url}" >> ~/.openclaw/xmtp/.env`);
      await run(`echo "GATEWAY_TOKEN=${vm.gateway_token}" >> ~/.openclaw/xmtp/.env`);
    }
  }

  // 6. Install @xmtp/agent-sdk
  console.log("[Deploy XMTP] Installing @xmtp/agent-sdk...");
  const installResult = await run(
    "cd ~/.openclaw/xmtp && npm init -y 2>/dev/null; npm install @xmtp/agent-sdk 2>&1 | tail -10"
  );
  console.log("[Deploy XMTP] Install output:", installResult.stdout);
  if (installResult.stderr && !installResult.stderr.includes("npm warn")) {
    console.warn("[Deploy XMTP] Install stderr:", installResult.stderr);
  }

  // 7. Deploy the agent script
  console.log("[Deploy XMTP] Deploying agent script...");
  const agentScript = readFileSync(
    join(process.cwd(), "skills/xmtp-agent/scripts/xmtp-agent.mjs"),
    "utf-8"
  );
  // Write via heredoc to avoid escaping issues
  const b64Script = Buffer.from(agentScript).toString("base64");
  await run(
    `echo '${b64Script}' | base64 -d > ~/.openclaw/xmtp/xmtp-agent.mjs`
  );

  // 8. Create systemd service
  console.log("[Deploy XMTP] Creating systemd service...");
  const serviceUnit = `[Unit]
Description=InstaClaw XMTP Agent
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/openclaw/.openclaw/xmtp
ExecStart=/home/openclaw/.nvm/versions/node/v22.22.0/bin/node /home/openclaw/.openclaw/xmtp/xmtp-agent.mjs
EnvironmentFile=/home/openclaw/.openclaw/xmtp/.env
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target`;

  const b64Service = Buffer.from(serviceUnit).toString("base64");
  await run(
    `mkdir -p ~/.config/systemd/user && echo '${b64Service}' | base64 -d > ~/.config/systemd/user/instaclaw-xmtp.service`
  );

  // 9. Enable and start service
  console.log("[Deploy XMTP] Starting service...");
  const dbusCmd = `export XDG_RUNTIME_DIR="/run/user/$(id -u)"`;
  await run(`${dbusCmd} && systemctl --user daemon-reload`);
  await run(`${dbusCmd} && systemctl --user enable instaclaw-xmtp`);
  await run(`${dbusCmd} && systemctl --user restart instaclaw-xmtp`);

  // Wait for it to start and get the address
  console.log("[Deploy XMTP] Waiting for XMTP address...");
  await new Promise((r) => setTimeout(r, 5000));

  // 10. Read the XMTP address
  const addrResult = await run("cat ~/.openclaw/xmtp/address 2>/dev/null");
  const xmtpAddress = addrResult.stdout.trim();

  if (!xmtpAddress || !xmtpAddress.startsWith("0x")) {
    // Check service status
    const statusResult = await run(
      `${dbusCmd} && systemctl --user status instaclaw-xmtp 2>&1 | tail -20`
    );
    console.error("[Deploy XMTP] Service status:", statusResult.stdout);
    const journalResult = await run(
      `${dbusCmd} && journalctl --user -u instaclaw-xmtp --no-pager -n 30 2>&1`
    );
    console.error("[Deploy XMTP] Journal:", journalResult.stdout);
    console.error("[Deploy XMTP] XMTP address not found. Service may have failed to start.");
    ssh.dispose();
    process.exit(1);
  }

  console.log(`[Deploy XMTP] XMTP Address: ${xmtpAddress}`);

  // 11. Write to Supabase
  const { error: updateErr } = await supabase
    .from("instaclaw_vms")
    .update({ xmtp_address: xmtpAddress })
    .eq("id", vm.id);

  if (updateErr) {
    console.error("[Deploy XMTP] Supabase update failed:", updateErr.message);
  } else {
    console.log(`[Deploy XMTP] ✓ xmtp_address written to Supabase for ${vmName}`);
  }

  // 12. Verify
  const { data: verifyVm } = await supabase
    .from("instaclaw_vms")
    .select("xmtp_address")
    .eq("id", vm.id)
    .single();

  console.log(`[Deploy XMTP] Verification: xmtp_address = ${verifyVm?.xmtp_address}`);

  ssh.dispose();
  console.log("[Deploy XMTP] Done!");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
