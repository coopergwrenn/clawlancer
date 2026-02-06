import { getSupabase } from "./supabase";
import { generateGatewayToken } from "./security";

interface VMRecord {
  id: string;
  ip_address: string;
  ssh_port: number;
  ssh_user: string;
  assigned_to?: string;
}

interface UserConfig {
  telegramBotToken: string;
  apiMode: "all_inclusive" | "byok";
  apiKey?: string;
  tier: string;
  model?: string;
}

// NVM preamble required before any `openclaw` CLI call on the VM.
// Node 22 is installed via nvm in userspace (no root/sudo access).
const NVM_PREAMBLE =
  'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"';

// OpenClaw gateway port (default for openclaw gateway run)
const GATEWAY_PORT = 18789;

// Strict input validation to prevent shell injection
function assertSafeShellArg(value: string, label: string): void {
  // Only allow alphanumeric, dashes, underscores, colons, dots, and slashes
  if (!/^[A-Za-z0-9_:.\-\/]+$/.test(value)) {
    throw new Error(`Invalid characters in ${label}`);
  }
}

// Map InstaClaw model IDs (Anthropic format) to OpenClaw provider/model format
function toOpenClawModel(model: string): string {
  const map: Record<string, string> = {
    "claude-haiku-4-5-20251001": "anthropic/claude-haiku-4-5",
    "claude-sonnet-4-5-20250929": "anthropic/claude-sonnet-4-5",
    "claude-opus-4-5-20250820": "anthropic/claude-opus-4-5",
    "claude-opus-4-6": "anthropic/claude-opus-4-6",
  };
  return map[model] || "anthropic/claude-sonnet-4-5";
}

// Dynamic import to avoid Turbopack bundling issues with ssh2's native crypto
async function connectSSH(vm: VMRecord) {
  if (!process.env.SSH_PRIVATE_KEY_B64) {
    throw new Error("SSH_PRIVATE_KEY_B64 not set");
  }
  const { NodeSSH } = await import("node-ssh");
  const ssh = new NodeSSH();
  await ssh.connect({
    host: vm.ip_address,
    port: vm.ssh_port,
    username: vm.ssh_user,
    privateKey: Buffer.from(process.env.SSH_PRIVATE_KEY_B64, 'base64').toString('utf-8'),
  });
  return ssh;
}

export async function configureOpenClaw(
  vm: VMRecord,
  config: UserConfig
): Promise<{ gatewayUrl: string; gatewayToken: string; controlUiUrl: string }> {
  if (config.apiMode === "byok" && !config.apiKey) {
    throw new Error("API key required for BYOK mode");
  }

  const ssh = await connectSSH(vm);

  try {
    const gatewayToken = generateGatewayToken();

    // Validate all inputs before building the shell command
    assertSafeShellArg(config.telegramBotToken, "telegramBotToken");
    assertSafeShellArg(gatewayToken, "gatewayToken");

    // Resolve API key: BYOK uses user's key, all-inclusive uses platform key
    const apiKey =
      config.apiMode === "byok"
        ? config.apiKey!
        : process.env.ANTHROPIC_API_KEY || "";
    if (!apiKey) {
      throw new Error("No API key available for configuration");
    }
    assertSafeShellArg(apiKey, "apiKey");

    const openclawModel = toOpenClawModel(config.model || "claude-sonnet-4-5-20250929");
    assertSafeShellArg(openclawModel, "model");

    // Build the configure script — runs OpenClaw CLI commands natively (no Docker)
    const script = [
      'set -eo pipefail',
      NVM_PREAMBLE,
      '',
      '# Kill any existing gateway process',
      'pkill -f "openclaw gateway" 2>/dev/null || true',
      'sleep 2',
      '',
      '# Delete any old Telegram webhook (we use long-polling)',
      `curl -s "https://api.telegram.org/bot${config.telegramBotToken}/deleteWebhook" > /dev/null 2>&1 || true`,
      '',
      '# Clean old config for fresh onboard',
      'rm -f ~/.openclaw/openclaw.json',
      '',
      '# Non-interactive onboard: sets up auth profile + base gateway config',
      `openclaw onboard --non-interactive --accept-risk \\`,
      `  --auth-choice apiKey \\`,
      `  --anthropic-api-key '${apiKey}' \\`,
      `  --gateway-bind lan \\`,
      `  --gateway-auth token \\`,
      `  --gateway-token '${gatewayToken}' \\`,
      `  --skip-channels --skip-skills --no-install-daemon`,
      '',
      '# Configure Telegram channel (open DM policy for SaaS)',
      `openclaw config set channels.telegram.botToken '${config.telegramBotToken}'`,
      `openclaw config set channels.telegram.allowFrom '["*"]'`,
      'openclaw config set channels.telegram.dmPolicy open',
      'openclaw config set channels.telegram.groupPolicy allowlist',
      'openclaw config set channels.telegram.streamMode partial',
      '',
      '# Set model',
      `openclaw config set agents.defaults.model.primary '${openclawModel}'`,
      '',
      '# Start gateway in background',
      `nohup openclaw gateway run --bind lan --port ${GATEWAY_PORT} --force > /tmp/openclaw-gateway.log 2>&1 &`,
      '',
      '# Brief wait for gateway to begin initializing',
      'sleep 3',
      '',
      'echo "OPENCLAW_CONFIGURE_DONE"',
    ].join('\n');

    const result = await ssh.execCommand(script);

    if (result.code !== 0 || !result.stdout.includes("OPENCLAW_CONFIGURE_DONE")) {
      console.error("OpenClaw configure failed:", result.stderr, result.stdout);
      throw new Error(`VM configuration failed: ${result.stderr || result.stdout}`);
    }

    // Gateway accessible directly on port 18789
    const gatewayUrl = `http://${vm.ip_address}:${GATEWAY_PORT}`;
    const controlUiUrl = `http://${vm.ip_address}:${GATEWAY_PORT}`;

    // Update VM record in Supabase
    const supabase = getSupabase();
    const { error: vmError } = await supabase
      .from("instaclaw_vms")
      .update({
        gateway_url: gatewayUrl,
        gateway_token: gatewayToken,
        control_ui_url: controlUiUrl,
        default_model: config.model || "claude-sonnet-4-5-20250929",
      })
      .eq("id", vm.id);

    if (vmError) {
      console.error("Failed to update VM record:", vmError);
      throw new Error("Failed to update VM record in database");
    }

    return { gatewayUrl, gatewayToken, controlUiUrl };
  } finally {
    ssh.dispose();
  }
}

export async function waitForHealth(
  vm: VMRecord,
  gatewayToken?: string,
  maxAttempts = 15,
  intervalMs = 4000
): Promise<boolean> {
  const ssh = await connectSSH(vm);
  try {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const cmd = gatewayToken
          ? `${NVM_PREAMBLE} && openclaw health --token '${gatewayToken}'`
          : `${NVM_PREAMBLE} && openclaw health`;
        const result = await ssh.execCommand(cmd);
        if (result.code === 0) return true;
      } catch {
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return false;
  } finally {
    ssh.dispose();
  }
}

export async function checkHealth(
  vm: VMRecord,
  gatewayToken?: string
): Promise<boolean> {
  try {
    const ssh = await connectSSH(vm);
    try {
      const cmd = gatewayToken
        ? `${NVM_PREAMBLE} && openclaw health --token '${gatewayToken}'`
        : `${NVM_PREAMBLE} && openclaw health`;
      const result = await ssh.execCommand(cmd);
      return result.code === 0;
    } finally {
      ssh.dispose();
    }
  } catch {
    return false;
  }
}

export async function updateModel(vm: VMRecord, model: string): Promise<boolean> {
  assertSafeShellArg(model, "model");
  const openclawModel = toOpenClawModel(model);
  assertSafeShellArg(openclawModel, "openclawModel");

  const ssh = await connectSSH(vm);
  try {
    const script = [
      NVM_PREAMBLE,
      `openclaw config set agents.defaults.model.primary '${openclawModel}'`,
      '# Restart gateway to pick up new model',
      'pkill -f "openclaw gateway" 2>/dev/null || true',
      'sleep 2',
      `nohup openclaw gateway run --bind lan --port ${GATEWAY_PORT} --force > /tmp/openclaw-gateway.log 2>&1 &`,
      'sleep 5',
    ].join('\n');

    const result = await ssh.execCommand(script);
    return result.code === 0;
  } finally {
    ssh.dispose();
  }
}

export async function restartGateway(vm: VMRecord): Promise<boolean> {
  const ssh = await connectSSH(vm);
  try {
    const script = [
      NVM_PREAMBLE,
      'pkill -f "openclaw gateway" 2>/dev/null || true',
      'sleep 2',
      `nohup openclaw gateway run --bind lan --port ${GATEWAY_PORT} --force > /tmp/openclaw-gateway.log 2>&1 &`,
      'sleep 5',
    ].join('\n');

    const result = await ssh.execCommand(script);
    return result.code === 0;
  } finally {
    ssh.dispose();
  }
}
