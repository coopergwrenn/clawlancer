import { getSupabase } from "./supabase";
import { generateGatewayToken, encryptApiKey } from "./security";

interface VMRecord {
  id: string;
  ip_address: string;
  ssh_port: number;
  ssh_user: string;
}

interface UserConfig {
  telegramBotToken: string;
  apiMode: "all_inclusive" | "byok";
  apiKey?: string;
  tier: string;
}

// Dynamic import to avoid Turbopack bundling issues with ssh2's native crypto
async function connectSSH(vm: VMRecord) {
  const { NodeSSH } = await import("node-ssh");
  const ssh = new NodeSSH();
  await ssh.connect({
    host: vm.ip_address,
    port: vm.ssh_port,
    username: vm.ssh_user,
    privateKey: Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, 'base64').toString('utf-8'),
  });
  return ssh;
}

export async function configureOpenClaw(
  vm: VMRecord,
  config: UserConfig
): Promise<{ gatewayUrl: string; gatewayToken: string; controlUiUrl: string }> {
  const ssh = await connectSSH(vm);

  try {
    const gatewayToken = generateGatewayToken();

    // Resolve the API key — for all-inclusive, use the platform key
    const apiKeyValue =
      config.apiMode === "byok"
        ? config.apiKey!
        : process.env.ANTHROPIC_API_KEY!;

    // Call configure-vm.sh on the VM. It handles encryption, config writing,
    // and container startup. The API key argument is 'ALL_INCLUSIVE' for
    // platform-provided keys (configure-vm.sh reads ANTHROPIC_API_KEY from env).
    const apiArg =
      config.apiMode === "byok" ? config.apiKey! : "ALL_INCLUSIVE";

    // For all-inclusive mode, set ANTHROPIC_API_KEY in the SSH environment
    const envPrefix =
      config.apiMode === "all_inclusive"
        ? `ANTHROPIC_API_KEY='${process.env.ANTHROPIC_API_KEY}' `
        : "";

    const result = await ssh.execCommand(
      `${envPrefix}bash ~/openclaw/scripts/configure-vm.sh '${config.telegramBotToken}' '${apiArg}' '${gatewayToken}'`
    );

    if (result.code !== 0) {
      console.error("configure-vm.sh failed:", result.stderr);
      throw new Error(`VM configuration failed: ${result.stderr}`);
    }

    // External URLs go through Caddy (HTTPS on 443)
    const gatewayUrl = `https://${vm.ip_address}`;
    const controlUiUrl = `https://${vm.ip_address}`;

    // Encrypt the BYOK API key before storing in the database
    const encryptedApiKey =
      config.apiMode === "byok" && config.apiKey
        ? await encryptApiKey(config.apiKey)
        : null;

    // Update VM record in Supabase
    const supabase = getSupabase();
    await supabase
      .from("instaclaw_vms")
      .update({
        gateway_url: gatewayUrl,
        gateway_token: gatewayToken,
        control_ui_url: controlUiUrl,
      })
      .eq("id", vm.id);

    // Store encrypted API key in pending_users if BYOK (for reconfiguration)
    if (encryptedApiKey) {
      await supabase
        .from("instaclaw_pending_users")
        .update({ api_key: encryptedApiKey })
        .eq("user_id", vm.ip_address); // Will be a no-op if row was already deleted
    }

    return { gatewayUrl, gatewayToken, controlUiUrl };
  } finally {
    ssh.dispose();
  }
}

export async function waitForHealth(
  gatewayUrl: string,
  maxAttempts = 30,
  intervalMs = 2000
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      // Health check goes through Caddy at /health (no auth required)
      const res = await fetch(`${gatewayUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return true;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

export async function restartGateway(vm: VMRecord): Promise<boolean> {
  const ssh = await connectSSH(vm);
  try {
    const result = await ssh.execCommand(
      "docker restart openclaw-gateway 2>/dev/null || docker compose -f ~/openclaw/docker-compose.yml restart"
    );
    return result.code === 0;
  } finally {
    ssh.dispose();
  }
}
