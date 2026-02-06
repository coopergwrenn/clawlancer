import { getSupabase } from "./supabase";

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
    privateKey: process.env.SSH_PRIVATE_KEY!,
  });
  return ssh;
}

export async function configureOpenClaw(
  vm: VMRecord,
  config: UserConfig
): Promise<{ gatewayUrl: string; gatewayToken: string; controlUiUrl: string }> {
  const ssh = await connectSSH(vm);

  try {
    // Generate gateway token
    const gatewayToken = crypto.randomUUID();

    // Build OpenClaw config
    const openclawConfig = {
      telegram: {
        bot_token: config.telegramBotToken,
      },
      api: {
        mode: config.apiMode,
        key:
          config.apiMode === "byok"
            ? config.apiKey
            : process.env.ANTHROPIC_API_KEY,
      },
      gateway: {
        token: gatewayToken,
        port: 8080,
      },
      tier: config.tier,
    };

    // Write config file
    await ssh.execCommand(
      `mkdir -p ~/.openclaw && cat > ~/.openclaw/openclaw.json << 'EOFCONFIG'
${JSON.stringify(openclawConfig, null, 2)}
EOFCONFIG`
    );

    // Restart docker gateway
    await ssh.execCommand("docker restart openclaw-gateway 2>/dev/null || docker compose -f ~/openclaw/docker-compose.yml up -d");

    const gatewayUrl = `http://${vm.ip_address}:8080`;
    const controlUiUrl = `http://${vm.ip_address}:3000`;

    // Update VM record
    const supabase = getSupabase();
    await supabase
      .from("instaclaw_vms")
      .update({
        gateway_url: gatewayUrl,
        gateway_token: gatewayToken,
        control_ui_url: controlUiUrl,
      })
      .eq("id", vm.id);

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
