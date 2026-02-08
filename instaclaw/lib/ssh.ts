import { getSupabase } from "./supabase";
import { generateGatewayToken } from "./security";
import { createDNSRecord } from "./hetzner";
import { logger } from "./logger";

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
  discordBotToken?: string;
  channels?: string[];
  braveApiKey?: string;
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
    if (config.telegramBotToken) {
      assertSafeShellArg(config.telegramBotToken, "telegramBotToken");
    }
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

    // Determine active channels
    const channels = config.channels ?? ["telegram"];

    // Build the configure script — runs OpenClaw CLI commands natively (no Docker)
    // Written to a temp file before execution so that pkill -f "openclaw gateway"
    // does not self-match the SSH process (whose cmdline would contain the full script).
    const scriptParts = [
      '#!/bin/bash',
      'set -eo pipefail',
      NVM_PREAMBLE,
      '',
      '# Kill any existing gateway process',
      'pkill -f "openclaw gateway" 2>/dev/null || true',
      'sleep 2',
      '',
    ];

    // Delete Telegram webhook if Telegram is enabled
    if (channels.includes("telegram") && config.telegramBotToken) {
      scriptParts.push(
        '# Delete any old Telegram webhook (we use long-polling)',
        `curl -s "https://api.telegram.org/bot${config.telegramBotToken}/deleteWebhook" > /dev/null 2>&1 || true`,
        ''
      );
    }

    scriptParts.push(
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
      `  --skip-channels --no-install-daemon || true`,
      '',
      '# Verify onboard produced a config file',
      'if [ ! -f ~/.openclaw/openclaw.json ]; then',
      '  echo "FATAL: openclaw onboard did not create config file" >&2',
      '  exit 1',
      'fi',
      ''
    );

    // Configure Telegram channel if enabled
    if (channels.includes("telegram") && config.telegramBotToken) {
      scriptParts.push(
        '# Configure Telegram channel (open DM policy for SaaS)',
        `openclaw config set channels.telegram.botToken '${config.telegramBotToken}'`,
        `openclaw config set channels.telegram.allowFrom '["*"]'`,
        'openclaw config set channels.telegram.dmPolicy open',
        'openclaw config set channels.telegram.groupPolicy allowlist',
        'openclaw config set channels.telegram.streamMode partial',
        ''
      );
    }

    // Configure Discord channel if enabled
    if (channels.includes("discord") && config.discordBotToken) {
      assertSafeShellArg(config.discordBotToken, "discordBotToken");
      scriptParts.push(
        '# Configure Discord channel',
        `openclaw config set channels.discord.botToken '${config.discordBotToken}'`,
        `openclaw config set channels.discord.allowFrom '["*"]'`,
        ''
      );
    }

    // Set model
    scriptParts.push(
      '# Set model',
      `openclaw config set agents.defaults.model.primary '${openclawModel}'`,
      ''
    );

    // Configure Brave web search if available
    const braveKey = config.braveApiKey || (config.apiMode === "all_inclusive" ? process.env.BRAVE_API_KEY : undefined);
    if (braveKey) {
      assertSafeShellArg(braveKey, "braveApiKey");
      scriptParts.push(
        '# Configure web search (Brave)',
        `openclaw config set tools.webSearch.provider brave`,
        `openclaw config set tools.webSearch.apiKey '${braveKey}'`,
        ''
      );
    }

    // Install Clawlancer skill
    scriptParts.push(
      '# Install Clawlancer MCP skill',
      'openclaw skill install clawlancer 2>/dev/null || true',
      ''
    );

    scriptParts.push(
      '# Start gateway in background',
      `nohup openclaw gateway run --bind lan --port ${GATEWAY_PORT} --force > /tmp/openclaw-gateway.log 2>&1 &`,
      '',
      '# Brief wait for gateway to begin initializing',
      'sleep 3',
      '',
      'echo "OPENCLAW_CONFIGURE_DONE"'
    );

    const script = scriptParts.join('\n');

    // Write script to temp file, then execute it — avoids pkill self-match issue
    await ssh.execCommand(`cat > /tmp/ic-configure.sh << 'ICEOF'\n${script}\nICEOF`);
    const result = await ssh.execCommand('bash /tmp/ic-configure.sh; EC=$?; rm -f /tmp/ic-configure.sh; exit $EC');

    if (result.code !== 0 || !result.stdout.includes("OPENCLAW_CONFIGURE_DONE")) {
      logger.error("OpenClaw configure failed", { error: result.stderr, stdout: result.stdout, route: "lib/ssh" });
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
      logger.error("Failed to update VM record", { error: String(vmError), route: "lib/ssh", vmId: vm.id });
      throw new Error("Failed to update VM record in database");
    }

    // Auto-setup TLS if Cloudflare DNS is configured (non-blocking)
    if (process.env.CLOUDFLARE_ZONE_ID && process.env.CLOUDFLARE_API_TOKEN) {
      try {
        const hostname = `${vm.id}.vm.instaclaw.io`;
        const recordId = await createDNSRecord(vm.id, vm.ip_address);
        if (recordId) {
          const tlsOk = await setupTLS(vm, hostname);
          if (tlsOk) {
            const httpsUrl = `https://${hostname}`;
            await supabase
              .from("instaclaw_vms")
              .update({
                gateway_url: httpsUrl,
                control_ui_url: httpsUrl,
              })
              .eq("id", vm.id);
            return { gatewayUrl: httpsUrl, gatewayToken, controlUiUrl: httpsUrl };
          }
        }
      } catch (tlsErr) {
        logger.warn("TLS setup skipped (non-fatal)", { error: String(tlsErr), route: "lib/ssh", vmId: vm.id });
      }
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
  if (gatewayToken) assertSafeShellArg(gatewayToken, "gatewayToken");
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
  if (gatewayToken) assertSafeShellArg(gatewayToken, "gatewayToken");
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
      '#!/bin/bash',
      NVM_PREAMBLE,
      `openclaw config set agents.defaults.model.primary '${openclawModel}'`,
      '# Restart gateway to pick up new model',
      'pkill -f "openclaw gateway" 2>/dev/null || true',
      'sleep 2',
      `nohup openclaw gateway run --bind lan --port ${GATEWAY_PORT} --force > /tmp/openclaw-gateway.log 2>&1 &`,
      'sleep 5',
    ].join('\n');

    await ssh.execCommand(`cat > /tmp/ic-update.sh << 'ICEOF'\n${script}\nICEOF`);
    const result = await ssh.execCommand('bash /tmp/ic-update.sh; EC=$?; rm -f /tmp/ic-update.sh; exit $EC');
    return result.code === 0;
  } finally {
    ssh.dispose();
  }
}

export async function updateSystemPrompt(
  vm: VMRecord,
  systemPrompt: string
): Promise<void> {
  const ssh = await connectSSH(vm);
  try {
    const promptDir = "$HOME/.openclaw/agents/main/agent";
    const promptFile = `${promptDir}/system-prompt.md`;

    if (!systemPrompt.trim()) {
      // Remove custom prompt to use OpenClaw's built-in default
      await ssh.execCommand(`${NVM_PREAMBLE} && rm -f ${promptFile}`);
    } else {
      // Use base64 encoding to safely transfer arbitrary content (avoids heredoc injection)
      const b64 = Buffer.from(systemPrompt, "utf-8").toString("base64");
      await ssh.execCommand(
        `${NVM_PREAMBLE} && mkdir -p ${promptDir} && echo '${b64}' | base64 -d > ${promptFile}`
      );
    }

    // Restart gateway to pick up changes
    const script = [
      '#!/bin/bash',
      NVM_PREAMBLE,
      'pkill -f "openclaw gateway" 2>/dev/null || true',
      'sleep 2',
      `nohup openclaw gateway run --bind lan --port ${GATEWAY_PORT} --force > /tmp/openclaw-gateway.log 2>&1 &`,
      'sleep 3',
    ].join('\n');
    await ssh.execCommand(`cat > /tmp/ic-sysprompt.sh << 'ICEOF'\n${script}\nICEOF`);
    await ssh.execCommand('bash /tmp/ic-sysprompt.sh; rm -f /tmp/ic-sysprompt.sh');
  } finally {
    ssh.dispose();
  }
}

export async function updateApiKey(
  vm: VMRecord,
  apiKey: string
): Promise<void> {
  assertSafeShellArg(apiKey, "apiKey");

  const ssh = await connectSSH(vm);
  try {
    const script = [
      '#!/bin/bash',
      NVM_PREAMBLE,
      `openclaw config set auth.anthropicApiKey '${apiKey}'`,
      'pkill -f "openclaw gateway" 2>/dev/null || true',
      'sleep 2',
      `nohup openclaw gateway run --bind lan --port ${GATEWAY_PORT} --force > /tmp/openclaw-gateway.log 2>&1 &`,
      'sleep 3',
    ].join('\n');
    await ssh.execCommand(`cat > /tmp/ic-apikey.sh << 'ICEOF'\n${script}\nICEOF`);
    await ssh.execCommand('bash /tmp/ic-apikey.sh; rm -f /tmp/ic-apikey.sh');
  } finally {
    ssh.dispose();
  }
}

export async function updateEnvVars(
  vm: VMRecord,
  envVars: { name: string; value: string }[]
): Promise<void> {
  // Validate env var names (alphanumeric + underscore only)
  for (const v of envVars) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.name)) {
      throw new Error(`Invalid env var name: ${v.name}`);
    }
  }

  const ssh = await connectSSH(vm);
  try {
    // Build the .env file content and base64 encode to avoid heredoc injection
    const envContent = envVars
      .map((v) => `${v.name}=${v.value}`)
      .join('\n');
    const b64 = Buffer.from(envContent, "utf-8").toString("base64");

    // Write to OpenClaw's env file via base64 decode
    await ssh.execCommand(
      `echo '${b64}' | base64 -d > $HOME/.openclaw/.env`
    );
    await ssh.execCommand(`chmod 600 $HOME/.openclaw/.env`);
  } finally {
    ssh.dispose();
  }
}

export async function removeEnvVar(
  vm: VMRecord,
  varName: string
): Promise<void> {
  assertSafeShellArg(varName, "varName");

  const ssh = await connectSSH(vm);
  try {
    // Remove the specific line from .env
    await ssh.execCommand(
      `${NVM_PREAMBLE} && sed -i '/^${varName}=/d' $HOME/.openclaw/.env 2>/dev/null || true`
    );
  } finally {
    ssh.dispose();
  }
}

export async function getConversations(
  vm: VMRecord
): Promise<{ sessions: { id: string; preview: string; date: string }[] }> {
  const ssh = await connectSSH(vm);
  try {
    // List session files
    const result = await ssh.execCommand(
      `${NVM_PREAMBLE} && ls -t $HOME/.openclaw/agents/main/sessions/*.json 2>/dev/null | head -50`
    );
    if (result.code !== 0 || !result.stdout.trim()) {
      return { sessions: [] };
    }

    const files = result.stdout.trim().split('\n');
    const sessions: { id: string; preview: string; date: string }[] = [];

    for (const file of files.slice(0, 20)) {
      const id = file.split('/').pop()?.replace('.json', '') ?? '';
      // Get first message preview and modification date
      const preview = await ssh.execCommand(
        `head -c 500 "${file}" 2>/dev/null`
      );
      const stat = await ssh.execCommand(
        `stat -c '%Y' "${file}" 2>/dev/null || stat -f '%m' "${file}" 2>/dev/null`
      );

      let previewText = '';
      try {
        const parsed = JSON.parse(preview.stdout);
        if (Array.isArray(parsed)) {
          const firstUser = parsed.find((m: { role: string; content: string }) => m.role === 'user');
          previewText = firstUser?.content?.substring(0, 100) ?? '';
        }
      } catch {
        previewText = '';
      }

      sessions.push({
        id,
        preview: previewText,
        date: stat.stdout.trim()
          ? new Date(parseInt(stat.stdout.trim()) * 1000).toISOString()
          : '',
      });
    }

    return { sessions };
  } finally {
    ssh.dispose();
  }
}

export async function getConversation(
  vm: VMRecord,
  sessionId: string
): Promise<{ messages: { role: string; content: string }[] }> {
  assertSafeShellArg(sessionId, "sessionId");

  const ssh = await connectSSH(vm);
  try {
    const result = await ssh.execCommand(
      `cat "$HOME/.openclaw/agents/main/sessions/${sessionId}.json" 2>/dev/null`
    );
    if (result.code !== 0) {
      return { messages: [] };
    }
    try {
      const messages = JSON.parse(result.stdout);
      return { messages: Array.isArray(messages) ? messages : [] };
    } catch {
      return { messages: [] };
    }
  } finally {
    ssh.dispose();
  }
}

export async function updateToolPermissions(
  vm: VMRecord,
  tools: Record<string, boolean>
): Promise<void> {
  // Validate tool names before interpolating into shell commands
  for (const name of Object.keys(tools)) {
    assertSafeShellArg(name, "toolName");
  }

  const ssh = await connectSSH(vm);
  try {
    const commands = Object.entries(tools).map(
      ([name, enabled]) =>
        `openclaw config set tools.${name}.enabled ${enabled}`
    );
    const script = [
      '#!/bin/bash',
      NVM_PREAMBLE,
      ...commands,
      'pkill -f "openclaw gateway" 2>/dev/null || true',
      'sleep 2',
      `nohup openclaw gateway run --bind lan --port ${GATEWAY_PORT} --force > /tmp/openclaw-gateway.log 2>&1 &`,
      'sleep 3',
    ].join('\n');
    await ssh.execCommand(`cat > /tmp/ic-tools.sh << 'ICEOF'\n${script}\nICEOF`);
    await ssh.execCommand('bash /tmp/ic-tools.sh; rm -f /tmp/ic-tools.sh');
  } finally {
    ssh.dispose();
  }
}

export async function manageCrontab(
  vm: VMRecord,
  action: 'list' | 'add' | 'remove',
  entry?: { schedule: string; command: string; description?: string }
): Promise<string[]> {
  // Validate inputs before interpolating into shell commands
  if (entry) {
    if (entry.schedule && !/^[0-9*\/,\-\s]+$/.test(entry.schedule)) {
      throw new Error("Invalid cron schedule characters");
    }
    if (entry.command) {
      assertSafeShellArg(entry.command, "crontabCommand");
    }
    if (entry.description && !/^[A-Za-z0-9 _.\-]+$/.test(entry.description)) {
      throw new Error("Invalid crontab description characters");
    }
  }

  const ssh = await connectSSH(vm);
  try {
    if (action === 'list') {
      const result = await ssh.execCommand(`${NVM_PREAMBLE} && crontab -l 2>/dev/null`);
      return result.stdout.trim() ? result.stdout.trim().split('\n') : [];
    }
    if (action === 'add' && entry) {
      const comment = entry.description ? `# ${entry.description}\n` : '';
      const line = `${entry.schedule} ${NVM_PREAMBLE} && ${entry.command}`;
      // Base64 encode the crontab addition to avoid shell injection
      const b64 = Buffer.from(`${comment}${line}`, "utf-8").toString("base64");
      await ssh.execCommand(
        `(crontab -l 2>/dev/null; echo '${b64}' | base64 -d) | crontab -`
      );
    }
    if (action === 'remove' && entry) {
      // Use fgrep (fixed string match) to avoid regex injection
      await ssh.execCommand(
        `crontab -l 2>/dev/null | grep -vF '${entry.command.replace(/'/g, "'\\''")}' | crontab -`
      );
    }
    return [];
  } finally {
    ssh.dispose();
  }
}

export async function listFiles(
  vm: VMRecord,
  path: string = "~/workspace"
): Promise<{ name: string; type: string; size: number; modified: string }[]> {
  assertSafeShellArg(path, "path");

  const ssh = await connectSSH(vm);
  try {
    const result = await ssh.execCommand(
      `ls -la --time-style='+%Y-%m-%dT%H:%M:%S' ${path} 2>/dev/null`
    );
    if (result.code !== 0) return [];

    const lines = result.stdout.trim().split('\n').slice(1); // skip "total X" line
    return lines
      .filter((l) => !l.startsWith('total'))
      .map((line) => {
        const parts = line.split(/\s+/);
        const type = parts[0].startsWith('d') ? 'directory' : 'file';
        const size = parseInt(parts[4]) || 0;
        const modified = parts[5] || '';
        const name = parts.slice(6).join(' ');
        return { name, type, size, modified };
      })
      .filter((f) => f.name !== '.' && f.name !== '..');
  } finally {
    ssh.dispose();
  }
}

export async function readFile(
  vm: VMRecord,
  filePath: string,
  maxBytes: number = 50000
): Promise<string> {
  assertSafeShellArg(filePath, "filePath");

  const ssh = await connectSSH(vm);
  try {
    const result = await ssh.execCommand(`head -c ${maxBytes} "${filePath}" 2>/dev/null`);
    return result.stdout;
  } finally {
    ssh.dispose();
  }
}

export async function setupTLS(
  vm: VMRecord,
  hostname: string
): Promise<boolean> {
  // Validate hostname: only allow valid DNS characters
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.\-]+$/.test(hostname)) {
    throw new Error("Invalid hostname characters");
  }

  const ssh = await connectSSH(vm);
  try {
    // Base64 encode the Caddyfile content to avoid heredoc injection
    const caddyfile = `${hostname} {\n  reverse_proxy localhost:${GATEWAY_PORT}\n}\n`;
    const b64Caddy = Buffer.from(caddyfile, "utf-8").toString("base64");

    const script = [
      '#!/bin/bash',
      'set -eo pipefail',
      '',
      '# Install Caddy if not already installed',
      'if ! command -v caddy &> /dev/null; then',
      '  sudo apt-get update -qq',
      '  sudo apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl',
      '  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null || true',
      '  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" | sudo tee /etc/apt/sources.list.d/caddy-stable.list > /dev/null',
      '  sudo apt-get update -qq',
      '  sudo apt-get install -y -qq caddy',
      'fi',
      '',
      '# Write Caddyfile via base64 to avoid injection',
      `echo '${b64Caddy}' | base64 -d | sudo tee /etc/caddy/Caddyfile > /dev/null`,
      '',
      '# Restart Caddy to pick up new config',
      'sudo systemctl restart caddy',
      'sudo systemctl enable caddy',
    ].join('\n');

    await ssh.execCommand(`cat > /tmp/ic-tls.sh << 'ICEOF'\n${script}\nICEOF`);
    const result = await ssh.execCommand('sudo bash /tmp/ic-tls.sh; EC=$?; rm -f /tmp/ic-tls.sh; exit $EC');
    return result.code === 0;
  } finally {
    ssh.dispose();
  }
}

export async function restartGateway(vm: VMRecord): Promise<boolean> {
  const ssh = await connectSSH(vm);
  try {
    const script = [
      '#!/bin/bash',
      NVM_PREAMBLE,
      'pkill -f "openclaw gateway" 2>/dev/null || true',
      'sleep 2',
      `nohup openclaw gateway run --bind lan --port ${GATEWAY_PORT} --force > /tmp/openclaw-gateway.log 2>&1 &`,
      'sleep 5',
    ].join('\n');

    await ssh.execCommand(`cat > /tmp/ic-restart.sh << 'ICEOF'\n${script}\nICEOF`);
    const result = await ssh.execCommand('bash /tmp/ic-restart.sh; EC=$?; rm -f /tmp/ic-restart.sh; exit $EC');
    return result.code === 0;
  } finally {
    ssh.dispose();
  }
}
