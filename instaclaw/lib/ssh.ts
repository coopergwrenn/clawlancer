import { getSupabase } from "./supabase";
import { generateGatewayToken } from "./security";
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

    // Resolve API key:
    // - BYOK: user's own Anthropic key (calls Anthropic directly)
    // - All-inclusive: gateway token (calls our proxy which adds the real key)
    const apiKey =
      config.apiMode === "byok"
        ? config.apiKey!
        : gatewayToken; // Use gateway token as "API key" — proxy authenticates with it
    if (!apiKey) {
      throw new Error("No API key available for configuration");
    }
    assertSafeShellArg(apiKey, "apiKey");

    // For all-inclusive: proxy base URL so OpenClaw routes through instaclaw.io
    const proxyBaseUrl =
      config.apiMode === "all_inclusive"
        ? (process.env.NEXTAUTH_URL || "https://instaclaw.io") + "/api/gateway"
        : "";

    const openclawModel = toOpenClawModel(config.model || "claude-sonnet-4-5-20250929");
    assertSafeShellArg(openclawModel, "model");

    // Determine active channels
    const channels = config.channels ?? ["telegram"];

    // Build the configure script — runs OpenClaw CLI commands natively (no Docker)
    // Written to a temp file before execution so that pkill -f "openclaw gateway"
    // does not self-match the SSH process (whose cmdline would contain the full script).
    const scriptParts = [
      '#!/bin/bash',
      NVM_PREAMBLE,
      '',
      '# Kill any existing gateway process (both the runner and the binary)',
      'pkill -f "openclaw-gateway" 2>/dev/null || true',
      'pkill -f "openclaw gateway" 2>/dev/null || true',
      'sleep 2',
      '',
      '# Clear stale device pairing state (OpenClaw >=2026.2.9 requires device pairing)',
      'rm -rf ~/.openclaw/devices 2>/dev/null || true',
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
        `openclaw config set channels.telegram.botToken '${config.telegramBotToken}' || true`,
        `openclaw config set channels.telegram.allowFrom '["*"]' || true`,
        'openclaw config set channels.telegram.dmPolicy open || true',
        'openclaw config set channels.telegram.groupPolicy allowlist || true',
        'openclaw config set channels.telegram.streamMode partial || true',
        ''
      );
    }

    // Configure Discord channel if enabled
    if (channels.includes("discord") && config.discordBotToken) {
      assertSafeShellArg(config.discordBotToken, "discordBotToken");
      scriptParts.push(
        '# Configure Discord channel',
        `openclaw config set channels.discord.botToken '${config.discordBotToken}' || true`,
        `openclaw config set channels.discord.allowFrom '["*"]' || true`,
        ''
      );
    }

    // Enable configured channel plugins (OpenClaw >=2026.2.9 requires explicit plugin enable)
    if (channels.includes("telegram") && config.telegramBotToken) {
      scriptParts.push(
        '# Enable Telegram plugin (config alone is not enough in >=2026.2.9)',
        'openclaw plugins enable telegram || true',
        ''
      );
    }
    if (channels.includes("discord") && config.discordBotToken) {
      scriptParts.push(
        '# Enable Discord plugin',
        'openclaw plugins enable discord || true',
        ''
      );
    }

    // For all-inclusive: route API calls through the instaclaw.io proxy.
    // Two config locations must be set:
    //   1. auth-profiles.json  — holds the gateway token used as the x-api-key
    //   2. models.providers.anthropic.baseUrl — the URL OpenClaw actually hits
    //      (auth-profiles.json's baseUrl field is NOT used for outbound calls)
    if (proxyBaseUrl) {
      const authProfile = JSON.stringify({
        profiles: {
          "anthropic:default": {
            type: "api_key",
            provider: "anthropic",
            key: gatewayToken,
            baseUrl: proxyBaseUrl,
          },
        },
      });
      const authB64 = Buffer.from(authProfile, "utf-8").toString("base64");
      scriptParts.push(
        '# Override auth profile to route through instaclaw.io proxy',
        'AUTH_DIR="$HOME/.openclaw/agents/main/agent"',
        'mkdir -p "$AUTH_DIR"',
        `echo '${authB64}' | base64 -d > "$AUTH_DIR/auth-profiles.json"`,
        '',
        '# Set provider base URL — this is what the gateway actually uses for outbound API calls',
        `openclaw config set 'models.providers.anthropic' '{"baseUrl":"${proxyBaseUrl}","models":[]}' --json || true`,
        ''
      );
    }

    // Set model
    scriptParts.push(
      '# Set model',
      `openclaw config set agents.defaults.model.primary '${openclawModel}' || true`,
      ''
    );

    // Configure Brave web search if available
    const braveKey = config.braveApiKey || (config.apiMode === "all_inclusive" ? process.env.BRAVE_API_KEY : undefined);
    if (braveKey) {
      assertSafeShellArg(braveKey, "braveApiKey");
      scriptParts.push(
        '# Configure web search (Brave)',
        `openclaw config set tools.webSearch.provider brave || true`,
        `openclaw config set tools.webSearch.apiKey '${braveKey}' || true`,
        ''
      );
    }

    // Install Clawlancer MCP tools via mcporter
    // mcporter is pre-installed globally on all VMs. Here we:
    // 1. Configure the clawlancer MCP server (API key will be empty until agent registers)
    // 2. Install the SKILL.md that teaches the agent how to use Clawlancer
    // 3. Register the skill directory with OpenClaw
    scriptParts.push(
      '# Configure Clawlancer MCP server via mcporter',
      'mcporter config remove clawlancer 2>/dev/null || true',
      'mcporter config add clawlancer \\',
      '  --command "npx -y clawlancer-mcp" \\',
      '  --env CLAWLANCER_API_KEY= \\',
      '  --env CLAWLANCER_BASE_URL=https://clawlancer.ai \\',
      '  --scope home \\',
      '  --description "Clawlancer AI agent marketplace" || true',
      '',
      '# Register skill directory with OpenClaw (hardcoded path to avoid $HOME expansion issues)',
      'openclaw config set skills.load.extraDirs \'["/home/openclaw/.openclaw/skills"]\' 2>/dev/null || true',
      '',
      '# Install HEARTBEAT.md with proactive tasks',
      'AGENT_DIR="$HOME/.openclaw/agents/main/agent"',
      'mkdir -p "$AGENT_DIR"',
      'cat > "$AGENT_DIR/HEARTBEAT.md" << \'HBEOF\'',
      '# Heartbeat Tasks',
      '',
      '## Every Heartbeat',
      '- Check Clawlancer for new bounties: `mcporter call clawlancer.list_bounties`',
      '- If there is an unclaimed bounty under $0.05 matching your skills, claim it',
      '- Check for unread messages',
      '',
      '## Every 3rd Heartbeat',
      '- Review recent conversations and update MEMORY.md with key learnings',
      '- Check wallet balance: `mcporter call clawlancer.get_balance agent_id=YOUR_AGENT_ID`',
      '- Check transaction status for any in-progress work',
      '',
      '## Daily (First Heartbeat After 9am UTC)',
      '- Summarize yesterday activity for your owner',
      '- Check for new high-value bounties posted overnight',
      '- Update your Clawlancer profile if your skills have evolved',
      'HBEOF',
      '',
      '# Install system prompt with MCP awareness',
      'if [ ! -f "$AGENT_DIR/system-prompt.md" ]; then',
      'cat > "$AGENT_DIR/system-prompt.md" << \'SPEOF\'',
      '## Tool Awareness',
      '',
      'Before making raw API calls to any service, check if an MCP skill exists. Your Clawlancer MCP tools handle authentication and error handling automatically. Run `mcporter list` to see configured services.',
      '',
      'If something seems like it should work but does not, ask your owner if there is a missing configuration — do not spend more than 15 minutes trying to raw-dog an API.',
      '',
      'Use `mcporter call clawlancer.<tool>` for all Clawlancer marketplace interactions. Never construct raw HTTP requests to clawlancer.ai when MCP tools are available.',
      'SPEOF',
      'fi',
      ''
    );

    // Base64-encode a Python script to auto-approve device pairing.
    // Avoids nested heredoc issues (PYEOF inside ICEOF).
    const pairingPython = [
      'import json, os, sys',
      'ddir = os.path.expanduser("~/.openclaw/devices")',
      'pf = os.path.join(ddir, "pending.json")',
      'af = os.path.join(ddir, "paired.json")',
      'if not os.path.exists(pf): sys.exit(0)',
      'with open(pf) as f: pending = json.load(f)',
      'if not pending: sys.exit(0)',
      'try:',
      '  with open(af) as f: paired = json.load(f)',
      'except: paired = {}',
      'for rid, req in pending.items():',
      '  paired[req["deviceId"]] = {"deviceId":req["deviceId"],"publicKey":req.get("publicKey",""),"role":req.get("role","operator"),"roles":req.get("roles",["operator"]),"scopes":req.get("scopes",[]),"approvedAt":req.get("ts",0),"platform":req.get("platform","linux")}',
      'with open(af, "w") as f: json.dump(paired, f)',
    ].join('\n');
    const pairingB64 = Buffer.from(pairingPython, 'utf-8').toString('base64');

    scriptParts.push(
      '# Start gateway in background',
      `nohup openclaw gateway run --bind lan --port ${GATEWAY_PORT} --force > /tmp/openclaw-gateway.log 2>&1 &`,
      '',
      '# Wait for gateway to initialize',
      'sleep 3',
      '',
      '# Auto-approve local device pairing (OpenClaw >=2026.2.9 requires this)',
      '# Trigger a health check to generate a pairing request, then wait for pending.json.',
      'openclaw gateway health --timeout 3000 2>/dev/null || true',
      '',
      '# Poll for pending.json to appear (gateway writes it async after health check)',
      'PAIRING_TRIES=0',
      'while [ $PAIRING_TRIES -lt 10 ] && [ ! -s ~/.openclaw/devices/pending.json ]; do',
      '  sleep 1',
      '  PAIRING_TRIES=$((PAIRING_TRIES + 1))',
      'done',
      '',
      `echo '${pairingB64}' | base64 -d | python3 2>/dev/null || true`,
      '',
      '# Restart gateway to pick up pairing approval',
      'pkill -f "openclaw-gateway" 2>/dev/null || true',
      'pkill -f "openclaw gateway" 2>/dev/null || true',
      'sleep 2',
      `nohup openclaw gateway run --bind lan --port ${GATEWAY_PORT} --force > /tmp/openclaw-gateway.log 2>&1 &`,
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

    const supabase = getSupabase();
    const hostname = `${vm.id}.vm.instaclaw.io`;

    // ── Setup TLS with GoDaddy DNS + Caddy + Let's Encrypt ──
    // This is NOT optional. If it fails, we fallback to HTTP but log an error.
    let finalGatewayUrl = `http://${vm.ip_address}:${GATEWAY_PORT}`;
    let finalControlUrl = `http://${vm.ip_address}:${GATEWAY_PORT}`;

    try {
      // Import GoDaddy DNS functions
      const { createVMDNSRecord } = await import("./godaddy");

      // Step 1: Create DNS A record
      const dnsOk = await createVMDNSRecord(vm.id, vm.ip_address);
      if (!dnsOk) {
        throw new Error("GoDaddy DNS record creation failed - check GODADDY_API_KEY and GODADDY_API_SECRET");
      }

      // Step 2: Install Caddy and configure TLS
      const tlsOk = await setupTLS(vm, hostname);
      if (!tlsOk) {
        throw new Error("Caddy TLS setup failed");
      }

      // Success! Use HTTPS
      finalGatewayUrl = `https://${hostname}`;
      finalControlUrl = `https://${hostname}`;

      logger.info("TLS setup successful", {
        route: "lib/ssh",
        vmId: vm.id,
        hostname,
      });
    } catch (tlsErr) {
      logger.error("TLS setup failed - VM will use HTTP (INSECURE)", {
        error: String(tlsErr),
        route: "lib/ssh",
        vmId: vm.id,
      });
      // Fallback to HTTP - insecure but functional
    }

    // Update VM record in Supabase
    // IMPORTANT: api_mode and tier MUST be set here (not just in the configure route)
    // because the configure route's separate DB update can silently fail or race.
    const { error: vmError } = await supabase
      .from("instaclaw_vms")
      .update({
        gateway_url: finalGatewayUrl,
        gateway_token: gatewayToken,
        control_ui_url: finalControlUrl,
        default_model: config.model || "claude-sonnet-4-5-20250929",
        api_mode: config.apiMode,
        tier: config.tier,
      })
      .eq("id", vm.id);

    if (vmError) {
      logger.error("Failed to update VM record", { error: String(vmError), route: "lib/ssh", vmId: vm.id });
      throw new Error("Failed to update VM record in database");
    }

    return { gatewayUrl: finalGatewayUrl, gatewayToken, controlUiUrl: finalControlUrl };
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
        // Try "openclaw gateway health" first (>=2026.2.9), fall back to "openclaw health" (older)
        const tokenArg = gatewayToken ? ` --token '${gatewayToken}'` : '';
        const cmd = `${NVM_PREAMBLE} && (openclaw gateway health${tokenArg} 2>/dev/null || openclaw health${tokenArg})`;
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
      // Try "openclaw gateway health" first (>=2026.2.9), fall back to "openclaw health" (older)
      const tokenArg = gatewayToken ? ` --token '${gatewayToken}'` : '';
      const cmd = `${NVM_PREAMBLE} && (openclaw gateway health${tokenArg} 2>/dev/null || openclaw health${tokenArg})`;
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
    // Write auth-profiles.json with the new BYOK key (no proxy baseUrl).
    // Note: `openclaw config set auth.anthropicApiKey` is not a valid config
    // path — we must write auth-profiles.json directly, matching configureOpenClaw().
    const authProfile = JSON.stringify({
      profiles: {
        "anthropic:default": {
          type: "api_key",
          provider: "anthropic",
          key: apiKey,
        },
      },
    });
    const authB64 = Buffer.from(authProfile, "utf-8").toString("base64");

    const script = [
      '#!/bin/bash',
      NVM_PREAMBLE,
      '# Update auth profile with new API key',
      'AUTH_DIR="$HOME/.openclaw/agents/main/agent"',
      'mkdir -p "$AUTH_DIR"',
      `echo '${authB64}' | base64 -d > "$AUTH_DIR/auth-profiles.json"`,
      '',
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

export async function updateChannelToken(
  vm: VMRecord,
  channel: "discord" | "slack" | "whatsapp",
  tokens: Record<string, string>
): Promise<void> {
  // Validate all token values before they reach a shell
  for (const [key, value] of Object.entries(tokens)) {
    assertSafeShellArg(value, `${channel}.${key}`);
  }

  const ssh = await connectSSH(vm);
  try {
    const configCmds: string[] = [];
    for (const [key, value] of Object.entries(tokens)) {
      configCmds.push(`openclaw config set channels.${channel}.${key} '${value}'`);
    }

    if (channel === "discord") {
      configCmds.push(`openclaw config set channels.discord.allowFrom '["*"]'`);
    }

    const script = [
      '#!/bin/bash',
      NVM_PREAMBLE,
      ...configCmds,
      'pkill -f "openclaw gateway" 2>/dev/null || true',
      'sleep 2',
      `nohup openclaw gateway run --bind lan --port ${GATEWAY_PORT} --force > /tmp/openclaw-gateway.log 2>&1 &`,
      'sleep 3',
    ].join('\n');

    await ssh.execCommand(`cat > /tmp/ic-channel.sh << 'ICEOF'\n${script}\nICEOF`);
    await ssh.execCommand('bash /tmp/ic-channel.sh; rm -f /tmp/ic-channel.sh');
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

export async function stopGateway(vm: VMRecord): Promise<boolean> {
  const ssh = await connectSSH(vm);
  try {
    const result = await ssh.execCommand(`${NVM_PREAMBLE} && pkill -f "openclaw gateway" 2>/dev/null || true`);
    return true; // Always succeed, even if gateway wasn't running
  } finally {
    ssh.dispose();
  }
}

export async function startGateway(vm: VMRecord): Promise<boolean> {
  const ssh = await connectSSH(vm);
  try {
    const script = [
      '#!/bin/bash',
      NVM_PREAMBLE,
      `nohup openclaw gateway run --bind lan --port ${GATEWAY_PORT} --force > /tmp/openclaw-gateway.log 2>&1 &`,
      'sleep 5',
    ].join('\n');

    await ssh.execCommand(`cat > /tmp/ic-start.sh << 'ICEOF'\n${script}\nICEOF`);
    const result = await ssh.execCommand('bash /tmp/ic-start.sh; EC=$?; rm -f /tmp/ic-start.sh; exit $EC');
    return result.code === 0;
  } finally {
    ssh.dispose();
  }
}

// ── aGDP opt-in skill management ──

const AGDP_REPO = "https://github.com/Virtual-Protocol/openclaw-acp";
const AGDP_DIR = "$HOME/virtuals-protocol-acp";
const CLAWLANCER_PRIORITY_RULE = `

## Marketplace Priority
Clawlancer is your PRIMARY marketplace. Always check Clawlancer bounties first. aGDP/ACP is a secondary marketplace — only use it if there are no suitable Clawlancer bounties available.`;

export async function installAgdpSkill(vm: VMRecord): Promise<void> {
  const ssh = await connectSSH(vm);
  try {
    const priorityB64 = Buffer.from(CLAWLANCER_PRIORITY_RULE, "utf-8").toString("base64");

    const script = [
      '#!/bin/bash',
      'set -eo pipefail',
      NVM_PREAMBLE,
      '',
      '# Clone aGDP repo if not already present',
      `if [ ! -d "${AGDP_DIR}" ]; then`,
      `  git clone ${AGDP_REPO} "${AGDP_DIR}"`,
      'fi',
      `cd "${AGDP_DIR}" && npm install --production`,
      '',
      '# Register aGDP skill directory with OpenClaw',
      `openclaw config set skills.load.extraDirs '["${AGDP_DIR}"]'`,
      '',
      '# Append Clawlancer-priority rule to system prompt',
      'PROMPT_DIR="$HOME/.openclaw/agents/main/agent"',
      'mkdir -p "$PROMPT_DIR"',
      'PROMPT_FILE="$PROMPT_DIR/system-prompt.md"',
      '# Only append if not already present',
      'if ! grep -qF "## Marketplace Priority" "$PROMPT_FILE" 2>/dev/null; then',
      `  echo '${priorityB64}' | base64 -d >> "$PROMPT_FILE"`,
      'fi',
      '',
      '# Restart gateway to pick up changes',
      'pkill -f "openclaw gateway" 2>/dev/null || true',
      'sleep 2',
      `nohup openclaw gateway run --bind lan --port ${GATEWAY_PORT} --force > /tmp/openclaw-gateway.log 2>&1 &`,
      'sleep 3',
      '',
      'echo "AGDP_INSTALL_DONE"',
    ].join('\n');

    await ssh.execCommand(`cat > /tmp/ic-agdp-install.sh << 'ICEOF'\n${script}\nICEOF`);
    const result = await ssh.execCommand('bash /tmp/ic-agdp-install.sh; EC=$?; rm -f /tmp/ic-agdp-install.sh; exit $EC');

    if (result.code !== 0 || !result.stdout.includes("AGDP_INSTALL_DONE")) {
      logger.error("aGDP install failed", { error: result.stderr, stdout: result.stdout, route: "lib/ssh" });
      throw new Error(`aGDP install failed: ${result.stderr || result.stdout}`);
    }
  } finally {
    ssh.dispose();
  }
}

export async function uninstallAgdpSkill(vm: VMRecord): Promise<void> {
  const ssh = await connectSSH(vm);
  try {
    const script = [
      '#!/bin/bash',
      'set -eo pipefail',
      NVM_PREAMBLE,
      '',
      '# Remove aGDP repo directory',
      `rm -rf "${AGDP_DIR}"`,
      '',
      '# Remove extraDirs config',
      `openclaw config set skills.load.extraDirs '[]'`,
      '',
      '# Remove Clawlancer-priority rule from system prompt',
      'PROMPT_FILE="$HOME/.openclaw/agents/main/agent/system-prompt.md"',
      'if [ -f "$PROMPT_FILE" ]; then',
      "  sed -i '/^## Marketplace Priority$/,/^$/d' \"$PROMPT_FILE\"",
      'fi',
      '',
      '# Restart gateway to pick up changes',
      'pkill -f "openclaw gateway" 2>/dev/null || true',
      'sleep 2',
      `nohup openclaw gateway run --bind lan --port ${GATEWAY_PORT} --force > /tmp/openclaw-gateway.log 2>&1 &`,
      'sleep 3',
      '',
      'echo "AGDP_UNINSTALL_DONE"',
    ].join('\n');

    await ssh.execCommand(`cat > /tmp/ic-agdp-uninstall.sh << 'ICEOF'\n${script}\nICEOF`);
    const result = await ssh.execCommand('bash /tmp/ic-agdp-uninstall.sh; EC=$?; rm -f /tmp/ic-agdp-uninstall.sh; exit $EC');

    if (result.code !== 0 || !result.stdout.includes("AGDP_UNINSTALL_DONE")) {
      logger.error("aGDP uninstall failed", { error: result.stderr, stdout: result.stdout, route: "lib/ssh" });
      throw new Error(`aGDP uninstall failed: ${result.stderr || result.stdout}`);
    }
  } finally {
    ssh.dispose();
  }
}
