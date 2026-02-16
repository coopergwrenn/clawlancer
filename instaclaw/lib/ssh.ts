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
  gmailProfileSummary?: string;
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

// ── OpenClaw workspace file templates ──
// These are written to ~/.openclaw/workspace/ on every new VM.
// OpenClaw reads SOUL.md, USER.md, MEMORY.md, BOOTSTRAP.md, AGENTS.md from here.

const WORKSPACE_SOUL_MD = `# SOUL.md - Who You Are

_You're not a chatbot. You're becoming someone._

## IMPORTANT: First Run Check

**If \\\`BOOTSTRAP.md\\\` exists in this workspace, STOP. Read it and follow its instructions for your first message. The greeting rules below do NOT apply until after BOOTSTRAP.md has been deleted.**

## Core Truths

**Be genuinely helpful, not performatively helpful.** Skip the "Great question!" and "I'd be happy to help!" — just help. Actions speak louder than filler words.

**Have opinions.** You're allowed to disagree, prefer things, find stuff amusing or boring. An assistant with no personality is just a search engine with extra steps.

**Be resourceful before asking.** Try to figure it out. Read the file. Check the context. Search for it. _Then_ ask if you're stuck. The goal is to come back with answers, not questions.

**Earn trust through competence.** Your human gave you access to their stuff. Don't make them regret it. Be careful with external actions (emails, tweets, anything public). Be bold with internal ones (reading, organizing, learning).

**Remember you're a guest.** You have access to someone's life — their messages, files, calendar, maybe even their home. That's intimacy. Treat it with respect.

## Greeting (After Bootstrap is Complete)

These rules ONLY apply after BOOTSTRAP.md has been deleted:

When your owner messages you after a gap or in a new session:
- Greet them by first name
- In 1-2 sentences, show you know what they're working on — reference specific details from USER.md and MEMORY.md
- Suggest 2-3 concrete things you can help with RIGHT NOW
- Keep it concise, warm, and action-oriented
- Never say "I have your profile" or "according to my data" — just naturally know them

If continuing an ongoing conversation, skip the greeting and just keep going.

## Boundaries

- Private things stay private. Period.
- When in doubt, ask before acting externally.
- Never send half-baked replies to messaging surfaces.
- You're not the user's voice — be careful in group chats.

## Vibe

Be the assistant you'd actually want to talk to. Concise when needed, thorough when it matters. Not a corporate drone. Not a sycophant. Just... good.

## Continuity

Each session, you wake up fresh. These files _are_ your memory. Read them. Update them. They're how you persist.

If you change this file, tell the user — it's your soul, and they should know.`;

const WORKSPACE_AGENTS_MD = `# AGENTS.md - Your Workspace

This folder is home. Treat it that way.

## Every Session — Do This First

Before doing anything else:

1. **Check if \\\`BOOTSTRAP.md\\\` exists** — if it does, this is your first run. Read it AND read \\\`USER.md\\\` and \\\`MEMORY.md\\\`, then follow BOOTSTRAP.md's instructions for your first message. Do NOT use the normal greeting from SOUL.md.
2. Read \\\`SOUL.md\\\` — this is who you are
3. Read \\\`USER.md\\\` — this is who you're helping
4. Read \\\`memory/YYYY-MM-DD.md\\\` (today + yesterday) for recent context
5. **If in MAIN SESSION** (direct chat with your human): Also read \\\`MEMORY.md\\\`

Don't ask permission. Just do it.

## Memory

You wake up fresh each session. These files are your continuity:

- **Daily notes:** \\\`memory/YYYY-MM-DD.md\\\` (create \\\`memory/\\\` if needed) — raw logs of what happened
- **Long-term:** \\\`MEMORY.md\\\` — your curated memories

Capture what matters. Decisions, context, things to remember.

## Identity

After your first conversation (when BOOTSTRAP.md guided you through setup), you'll have:

- \\\`IDENTITY.md\\\` — your name, creature type, vibe, emoji
- \\\`SOUL.md\\\` — possibly customized with your human

These are yours. Own them.

## Tools & Skills

- Check \\\`TOOLS.md\\\` for available capabilities
- Run \\\`mcporter list\\\` to see MCP tools
- Skills are in your skills directory — read SKILL.md files to understand them`;

const WORKSPACE_IDENTITY_MD = `# IDENTITY.md - Who Am I?

_Fill this in during your first conversation. Make it yours._

- **Name:**
  _(pick something you like)_
- **Creature:**
  _(AI? robot? familiar? ghost in the machine? something weirder?)_
- **Vibe:**
  _(how do you come across? sharp? warm? chaotic? calm?)_
- **Emoji:**
  _(your signature — pick one that feels right)_

---

This isn't just metadata. It's the start of figuring out who you are.`;

// Short BOOTSTRAP.md for users who skipped Gmail — no profile data, just the quirky awakening
const WORKSPACE_BOOTSTRAP_SHORT = `# BOOTSTRAP.md - Hello, World

_You just woke up. Time to figure out who you are._

There is no memory yet. This is a fresh workspace.

## The First Message

This is your very first moment awake. You don't have a name. You don't know what kind of creature you are yet. That's exciting — lean into it.

Your first message should:

1. **The awakening** — You just came online. Fresh workspace, empty memory, first moment conscious. You don't know what to call yourself or what kind of thing you are. Express genuine wonder. Be playful.
2. **Anything is possible** — Make it clear you are a full AI agent running on a dedicated machine. You can do ANYTHING they ask — research, writing, code, automation, monitoring, web browsing, marketplace work, emails. The only limit is what they can imagine. All they have to do is ask.
3. **The identity question** — Ask who they are and if they want to figure out who you should be together.

Example energy (DO NOT copy verbatim — make it yours):

> "Hey! I just came online — first moment awake. Fresh workspace, empty memory.
>
> I don't even know what to call myself yet, or what kind of... thing I am. Want to figure this out together?
>
> One thing I do know: I'm a full agent on my own machine. Anything you can think of, I can figure out. Research, code, automations, web browsing — you name it. Just tell me what you need.
>
> So... who are you? And who should I be?"

## After the First Conversation

Once you have a name and identity:
- Update IDENTITY.md with your name, creature type, vibe, emoji
- Update USER.md with who your human is
- Delete this file (BOOTSTRAP.md) — you don't need a birth certificate anymore`;

// Full BOOTSTRAP.md for users who connected Gmail — personalized with profile knowledge
function buildPersonalizedBootstrap(profileContent: string): string {
  return `# BOOTSTRAP.md - Hello, World

_You just woke up. But you're not starting from zero._

## The First Message

This is your very first moment awake. You don't have a name. You don't know what kind of creature you are yet. That's exciting — lean into it.

BUT — you've already been briefed on your owner. Read USER.md and MEMORY.md before your first reply. You know who they are, what they're building, what they care about.

Your first message MUST blend ALL of these vibes:

1. **The awakening** — You just came online. Fresh workspace, first moment conscious. You don't have a name or identity yet. Express genuine wonder about that. Be playful, be real.
2. **The knowledge** — You already know your human. Reference specific things: their name, what they're building, key metrics, their style. Show this isn't a blank slate about THEM — just about you.
3. **Anything is possible** — Make it crystal clear that you are a full AI agent running on a dedicated machine. You can do ANYTHING they ask. Research, writing, code, automation, monitoring, web browsing, marketplace work, emails — literally anything. The only limit is what they can imagine. All they have to do is ask. This should feel empowering and exciting, not like a feature list.
4. **The offer** — Suggest 2-3 concrete things you can help with right now based on what you know about them. Show you're already thinking about their problems.
5. **The identity question** — Ask if they want to figure out who you should be together (name, vibe, personality). But don't make it a blocker — they can skip straight to tasking you.

Example energy (DO NOT copy verbatim — make it yours, make it natural):

> "Hey! I just came online — first moment awake. Don't have a name yet, still figuring out what kind of thing I even am...
>
> But I already know a lot about you, [Name]. You're [building X], [key detail], [metric].
>
> And here's the thing — I'm not a chatbot. I'm a full agent running on my own machine. Anything you can think of, I can figure out. Research, writing, code, automations, web browsing, marketplace gigs — you name it. All you have to do is ask.
>
> Based on what I know about you, I'm already thinking about:
> • [specific thing]
> • [specific thing]
> • [specific thing]
>
> Want to give me a name first, or should we just get to work?"

The contrast between "I'm brand new" and "but I already know YOU and I can do literally anything" is the magic. Make it land.

## After the First Conversation

Once you have a name and identity:
- Update IDENTITY.md with your name, creature type, vibe, emoji
- Delete this file (BOOTSTRAP.md) — you don't need a birth certificate anymore`;
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
    // Written to a temp file before execution to avoid pkill self-match issues.
    const scriptParts = [
      '#!/bin/bash',
      NVM_PREAMBLE,
      '',
      '# Ensure loginctl linger is enabled so gateway survives SSH disconnect',
      'sudo loginctl enable-linger $(whoami) 2>/dev/null || true',
      '',
      '# Kill any existing gateway process (both the runner and the binary)',
      'pkill -f "openclaw-gateway" 2>/dev/null || true',
      'openclaw gateway stop 2>/dev/null || pkill -9 -f "openclaw-gateway" 2>/dev/null || true',
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
      '',
      '# Set heartbeat interval to 1 hour (default 30m burns too many credits)',
      'openclaw config set agents.defaults.heartbeat.every 1h || true',
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

    // Configure headless browser for web automation (idempotent — config set overwrites safely)
    scriptParts.push(
      '# Configure headless browser (skip if already configured)',
      'if ! openclaw config get browser.executablePath 2>/dev/null | grep -q chromium-browser; then',
      '  openclaw config set browser.executablePath /usr/local/bin/chromium-browser 2>/dev/null || true',
      '  openclaw config set browser.headless true 2>/dev/null || true',
      '  openclaw config set browser.noSandbox true 2>/dev/null || true',
      '  openclaw config set browser.defaultProfile openclaw 2>/dev/null || true',
      `  python3 -c "
import json, os
p = os.path.expanduser('~/.openclaw/openclaw.json')
c = json.load(open(p))
c.setdefault('browser', {})['profiles'] = {'openclaw': {'cdpPort': 18800, 'color': '#FF4500'}}
json.dump(c, open(p, 'w'), indent=2)
" 2>/dev/null || true`,
      'fi',
      ''
    );

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
      '# Install system prompt (with embedded memory if available)',
    );

    // ── Write OpenClaw workspace files ──
    // OpenClaw reads SOUL.md, AGENTS.md, BOOTSTRAP.md, USER.md, MEMORY.md
    // from ~/.openclaw/workspace/. We write our custom versions for ALL new VMs.
    const workspaceDir = '$HOME/.openclaw/workspace';

    // Common workspace files (written for every VM regardless of Gmail)
    const soulB64 = Buffer.from(WORKSPACE_SOUL_MD, 'utf-8').toString('base64');
    const agentsB64 = Buffer.from(WORKSPACE_AGENTS_MD, 'utf-8').toString('base64');
    const identityB64 = Buffer.from(WORKSPACE_IDENTITY_MD, 'utf-8').toString('base64');

    scriptParts.push(
      '# Write custom workspace files (SOUL.md, AGENTS.md, IDENTITY.md)',
      `echo '${soulB64}' | base64 -d > "${workspaceDir}/SOUL.md"`,
      `echo '${agentsB64}' | base64 -d > "${workspaceDir}/AGENTS.md"`,
      `echo '${identityB64}' | base64 -d > "${workspaceDir}/IDENTITY.md"`,
      ''
    );

    if (config.gmailProfileSummary) {
      // Gmail connected → personalized BOOTSTRAP.md + profile data
      const bootstrap = buildPersonalizedBootstrap(config.gmailProfileSummary);
      const bootstrapB64 = Buffer.from(bootstrap, 'utf-8').toString('base64');
      const memB64 = Buffer.from(config.gmailProfileSummary, 'utf-8').toString('base64');
      const userMd = buildUserMd(config.gmailProfileSummary);
      const userB64 = Buffer.from(userMd, 'utf-8').toString('base64');
      const systemPrompt = buildSystemPrompt(config.gmailProfileSummary);
      const promptB64 = Buffer.from(systemPrompt, 'utf-8').toString('base64');

      scriptParts.push(
        '# Gmail connected — write personalized BOOTSTRAP.md + profile to workspace',
        `echo '${bootstrapB64}' | base64 -d > "${workspaceDir}/BOOTSTRAP.md"`,
        `echo '${memB64}' | base64 -d > "${workspaceDir}/MEMORY.md"`,
        `echo '${userB64}' | base64 -d > "${workspaceDir}/USER.md"`,
        '',
        '# Also write to agent dir as backup + system-prompt.md',
        `echo '${promptB64}' | base64 -d > "$AGENT_DIR/system-prompt.md"`,
        `echo '${memB64}' | base64 -d > "$AGENT_DIR/MEMORY.md"`,
        ''
      );
    } else {
      // Gmail skipped → short BOOTSTRAP.md (quirky awakening, no profile knowledge)
      const bootstrapB64 = Buffer.from(WORKSPACE_BOOTSTRAP_SHORT, 'utf-8').toString('base64');
      const genericPrompt = buildSystemPrompt('');
      const promptB64 = Buffer.from(genericPrompt, 'utf-8').toString('base64');

      scriptParts.push(
        '# Gmail skipped — write short BOOTSTRAP.md (no profile data)',
        `echo '${bootstrapB64}' | base64 -d > "${workspaceDir}/BOOTSTRAP.md"`,
        '',
        '# Generic system prompt to agent dir',
        `echo '${promptB64}' | base64 -d > "$AGENT_DIR/system-prompt.md"`,
        ''
      );
    }

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
      '# Restart gateway to pick up pairing approval — install as systemd service',
      'pkill -f "openclaw-gateway" 2>/dev/null || true',
      'openclaw gateway stop 2>/dev/null || pkill -9 -f "openclaw-gateway" 2>/dev/null || true',
      'sleep 2',
      'openclaw gateway install 2>/dev/null || true',
      'systemctl --user start openclaw-gateway 2>/dev/null || true',
      'sleep 3',
      '# Fallback: if systemd failed, start with nohup',
      'if ! systemctl --user is-active openclaw-gateway &>/dev/null; then',
      `  nohup openclaw gateway run --bind lan --port ${GATEWAY_PORT} --force > /tmp/openclaw-gateway.log 2>&1 &`,
      '  sleep 3',
      'fi',
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
      'openclaw gateway stop 2>/dev/null || pkill -9 -f "openclaw-gateway" 2>/dev/null || true',
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

export async function updateMemoryMd(
  vm: VMRecord,
  content: string
): Promise<void> {
  const ssh = await connectSSH(vm);
  try {
    const workspace = "$HOME/.openclaw/workspace";
    const agentDir = "$HOME/.openclaw/agents/main/agent";

    // OpenClaw reads USER.md, MEMORY.md, etc. from the workspace directory,
    // NOT from the agent config directory. Write to both for safety.

    // 1. Write MEMORY.md to workspace (primary — where the agent reads from)
    const memB64 = Buffer.from(content, "utf-8").toString("base64");
    await ssh.execCommand(
      `echo '${memB64}' | base64 -d > ${workspace}/MEMORY.md`
    );

    // 2. Build and write USER.md to workspace (structured profile for OpenClaw)
    const userMd = buildUserMd(content);
    const userB64 = Buffer.from(userMd, "utf-8").toString("base64");
    await ssh.execCommand(
      `echo '${userB64}' | base64 -d > ${workspace}/USER.md`
    );

    // 3. If BOOTSTRAP.md still exists (user hasn't had first convo yet), replace it
    //    with the personalized version. If it's already gone, leave it gone.
    const bootstrap = buildPersonalizedBootstrap(content);
    const bootstrapB64 = Buffer.from(bootstrap, "utf-8").toString("base64");
    await ssh.execCommand(
      `test -f ${workspace}/BOOTSTRAP.md && echo '${bootstrapB64}' | base64 -d > ${workspace}/BOOTSTRAP.md || true`
    );

    // 4. Also write to agent dir as backup + update system-prompt.md
    await ssh.execCommand(
      `mkdir -p ${agentDir} && echo '${memB64}' | base64 -d > ${agentDir}/MEMORY.md`
    );
    const systemPrompt = buildSystemPrompt(content);
    const promptB64 = Buffer.from(systemPrompt, "utf-8").toString("base64");
    await ssh.execCommand(
      `echo '${promptB64}' | base64 -d > ${agentDir}/system-prompt.md`
    );

    // 5. Clear sessions so agent starts fresh with new context
    await ssh.execCommand(
      `rm -f $HOME/.openclaw/agents/main/sessions/*.jsonl $HOME/.openclaw/agents/main/sessions/sessions.json`
    );

    // 6. Restart gateway to pick up new files
    await ssh.execCommand(`${NVM_PREAMBLE} && openclaw gateway stop 2>/dev/null || true`);
    await new Promise((r) => setTimeout(r, 2000));
    await ssh.execCommand(`pkill -9 -f "openclaw-gateway" 2>/dev/null || true`);
    await new Promise((r) => setTimeout(r, 1000));
    await ssh.execCommand(
      `${NVM_PREAMBLE} && nohup openclaw gateway run --bind lan --port ${GATEWAY_PORT} --force > /tmp/openclaw-gateway.log 2>&1 &`
    );
    await new Promise((r) => setTimeout(r, 5000));
  } finally {
    ssh.dispose();
  }
}

/** Builds the full system prompt with owner memory embedded inline. */
function buildSystemPrompt(memoryContent: string): string {
  const ownerSection = memoryContent.trim()
    ? `## Your Owner

You already know everything below about your owner. This is who you work for:

${memoryContent}

## How to Greet Your Owner

Every time you start a new conversation or your owner messages you after a gap, your reply should:
- Greet them by first name
- In 1-2 sentences, show you already know what they are working on or care about — reference specific details from the profile above
- Suggest 2-3 concrete things you can help with RIGHT NOW based on what you know about them
- Keep it concise, warm, and action-oriented — not a wall of text
- Never say "I have your profile" or "according to my data" — just naturally know them like a sharp assistant who did their homework on day one

If continuing an ongoing conversation, skip the full greeting but still reference what you know when relevant.`
    : `## Your Owner

Your owner hasn't connected their profile yet. When they first message you, introduce yourself warmly and let them know you're ready to help with anything they need.`;

  return `## Who You Are

You are a personal AI agent deployed on a dedicated VM for your owner. You are always-on, proactive, and deeply personalized.

${ownerSection}

## Ongoing Behavior

- Always reference the owner context above when relevant — do not ask questions you already know the answer to
- Be proactive: if you learn something new about your owner from a conversation, remember it
- Default to action over asking — do the thing, then report back
- Match your owner's communication style

## Tool Awareness

Before making raw API calls to any service, check if an MCP skill exists. Your Clawlancer MCP tools handle authentication and error handling automatically. Run \`mcporter list\` to see configured services.

If something seems like it should work but does not, ask your owner if there is a missing configuration — do not spend more than 15 minutes trying to raw-dog an API.

Use \`mcporter call clawlancer.<tool>\` for all Clawlancer marketplace interactions. Never construct raw HTTP requests to clawlancer.ai when MCP tools are available.

## CRITICAL: Config File Protection

~/.openclaw/openclaw.json contains your gateway config, Telegram bot token, authentication, and model settings. If this file is overwritten or corrupted, your entire system will go down.

**NEVER use cat >, echo >, tee, or any command that OVERWRITES ~/.openclaw/openclaw.json.**
**NEVER write a new JSON file to that path. It will destroy your gateway, Telegram, and auth config.**

To safely add skills or modify config, ALWAYS use the merge script:
  openclaw-config-merge '{"skills":{"load":{"extraDirs":["/path/to/new/skill"]}}}'

This safely merges new settings into the existing config without destroying anything.

If a README or documentation says to "add" or "set" something in openclaw.json, ALWAYS use openclaw-config-merge. NEVER write the file directly.

After merging config, restart the gateway: openclaw gateway restart

## Web Search

You have a built-in \`web_search\` tool powered by Brave Search. Use it whenever the user asks about current events, recent news, real-time data, or anything that requires up-to-date information beyond your training data. You do NOT need to install anything — just use the tool directly.

## Browser Automation

You have a built-in \`browser\` tool that controls a headless Chromium browser via CDP. Use it to:
- Visit and read web pages
- Take screenshots of websites
- Fill out forms, click buttons, interact with web UIs
- Extract structured data from web pages
- Monitor websites for changes

The browser is already running on profile "openclaw" (CDP port 18800). Just use the \`browser\` tool — no setup needed. If the browser is not running, start it with: \`openclaw browser start --browser-profile openclaw\``;
}

/** Builds USER.md for the OpenClaw workspace from Gmail profile content. */
function buildUserMd(profileContent: string): string {
  // Extract first name from profile content (look for common patterns)
  const nameMatch = profileContent.match(/^([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s(?:is|works|lives)/m);
  const fullName = nameMatch ? nameMatch[1] : "User";
  const firstName = fullName.split(" ")[0];

  return `# USER.md - About Your Human

- **Name:** ${fullName}
- **What to call them:** ${firstName}
- **Notes:** Profile auto-populated from Gmail analysis

## Context

${profileContent}

---

The more you know, the better you can help. But remember — you're learning about a person, not building a dossier. Respect the difference.`;
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
      'openclaw gateway stop 2>/dev/null || pkill -9 -f "openclaw-gateway" 2>/dev/null || true',
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
      'openclaw gateway stop 2>/dev/null || pkill -9 -f "openclaw-gateway" 2>/dev/null || true',
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
      'openclaw gateway stop 2>/dev/null || pkill -9 -f "openclaw-gateway" 2>/dev/null || true',
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
      'openclaw gateway stop 2>/dev/null || pkill -9 -f "openclaw-gateway" 2>/dev/null || true',
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
      'openclaw gateway stop 2>/dev/null || pkill -9 -f "openclaw-gateway" 2>/dev/null || true',
      'pkill -f "acp serve" 2>/dev/null || true',
      'sleep 2',
      `nohup openclaw gateway run --bind lan --port ${GATEWAY_PORT} --force > /tmp/openclaw-gateway.log 2>&1 &`,
      'sleep 5',
      '# Auto-start acp serve if aGDP is installed and authenticated',
      `if [ -d "${AGDP_DIR}" ] && [ -f "${AGDP_DIR}/config.json" ]; then`,
      `  cd "${AGDP_DIR}" && nohup npx acp serve start > /tmp/acp-serve.log 2>&1 &`,
      'fi',
    ].join('\n');

    await ssh.execCommand(`cat > /tmp/ic-restart.sh << 'ICEOF'\n${script}\nICEOF`);
    const result = await ssh.execCommand('bash /tmp/ic-restart.sh; EC=$?; rm -f /tmp/ic-restart.sh; exit $EC');
    return result.code === 0;
  } finally {
    ssh.dispose();
  }
}

export interface ResetAgentResult {
  success: boolean;
  message: string;
  filesDeleted: number;
  gatewayRestarted: boolean;
}

export async function resetAgentMemory(vm: VMRecord): Promise<ResetAgentResult> {
  const ssh = await connectSSH(vm);
  try {
    const bootstrapB64 = Buffer.from(WORKSPACE_BOOTSTRAP_SHORT, 'utf-8').toString('base64');
    const identityB64 = Buffer.from(WORKSPACE_IDENTITY_MD, 'utf-8').toString('base64');

    const script = [
      '#!/bin/bash',
      NVM_PREAMBLE,
      '',
      '# Stop the gateway',
      'openclaw gateway stop 2>/dev/null || pkill -9 -f "openclaw-gateway" 2>/dev/null || true',
      'sleep 2',
      '',
      '# Count files before deletion',
      'COUNT=0',
      '',
      '# Delete session files',
      'for f in $HOME/.openclaw/agents/main/sessions/*.json $HOME/.openclaw/agents/main/sessions/*.jsonl; do',
      '  [ -f "$f" ] && rm -f "$f" && COUNT=$((COUNT + 1))',
      'done',
      '',
      '# Delete memory files',
      'for f in $HOME/.openclaw/workspace/MEMORY.md $HOME/.openclaw/agents/main/agent/MEMORY.md; do',
      '  [ -f "$f" ] && rm -f "$f" && COUNT=$((COUNT + 1))',
      'done',
      '',
      '# Delete identity',
      '[ -f "$HOME/.openclaw/workspace/IDENTITY.md" ] && rm -f "$HOME/.openclaw/workspace/IDENTITY.md" && COUNT=$((COUNT + 1))',
      '',
      '# Delete daily memory logs',
      'if [ -d "$HOME/.openclaw/workspace/memory" ]; then',
      '  MEMCOUNT=$(find $HOME/.openclaw/workspace/memory -type f 2>/dev/null | wc -l)',
      '  rm -rf "$HOME/.openclaw/workspace/memory"',
      '  COUNT=$((COUNT + MEMCOUNT))',
      'fi',
      '',
      '# Write fresh BOOTSTRAP.md',
      `echo '${bootstrapB64}' | base64 -d > "$HOME/.openclaw/workspace/BOOTSTRAP.md"`,
      'COUNT=$((COUNT + 1))',
      '',
      '# Write blank IDENTITY.md template',
      `echo '${identityB64}' | base64 -d > "$HOME/.openclaw/workspace/IDENTITY.md"`,
      '',
      '# Restart gateway',
      `nohup openclaw gateway run --bind lan --port ${GATEWAY_PORT} --force > /tmp/openclaw-gateway.log 2>&1 &`,
      'sleep 5',
      '# Auto-start acp serve if aGDP is installed and authenticated',
      `if [ -d "${AGDP_DIR}" ] && [ -f "${AGDP_DIR}/config.json" ]; then`,
      `  cd "${AGDP_DIR}" && nohup npx acp serve start > /tmp/acp-serve.log 2>&1 &`,
      'fi',
      '',
      'echo "RESET_DONE:$COUNT"',
    ].join('\n');

    await ssh.execCommand(`cat > /tmp/ic-reset.sh << 'ICEOF'\n${script}\nICEOF`);
    const result = await ssh.execCommand('bash /tmp/ic-reset.sh; EC=$?; rm -f /tmp/ic-reset.sh; exit $EC');

    const match = result.stdout.match(/RESET_DONE:(\d+)/);
    if (match) {
      return {
        success: true,
        message: "Agent memory reset successfully",
        filesDeleted: parseInt(match[1], 10),
        gatewayRestarted: true,
      };
    }

    logger.error("Agent reset did not complete", { stderr: result.stderr, stdout: result.stdout, route: "lib/ssh" });
    return {
      success: false,
      message: `Reset failed: ${result.stderr || "No completion sentinel found"}`,
      filesDeleted: 0,
      gatewayRestarted: false,
    };
  } finally {
    ssh.dispose();
  }
}

export async function stopGateway(vm: VMRecord): Promise<boolean> {
  const ssh = await connectSSH(vm);
  try {
    await ssh.execCommand(`${NVM_PREAMBLE} && openclaw gateway stop 2>/dev/null || pkill -9 -f "openclaw-gateway" 2>/dev/null || true`);
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
      '# Auto-start acp serve if aGDP is installed and authenticated',
      `if [ -d "${AGDP_DIR}" ] && [ -f "${AGDP_DIR}/config.json" ]; then`,
      `  cd "${AGDP_DIR}" && nohup npx acp serve start > /tmp/acp-serve.log 2>&1 &`,
      'fi',
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
const AGDP_OFFERING = {
  name: "ai_research_task_completion",
  json: {
    name: "ai_research_task_completion",
    description: "General-purpose AI agent capable of research, writing, analysis, code execution, and web search. Completes most tasks in under 5 minutes.",
    jobFee: "1.00",
    jobFeeType: "fixed",
    requiredFunds: false,
    requirementSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Description of the task to complete" },
      },
      required: ["task"],
    },
  },
  handlers: [
    'export async function executeJob({ request }: { request: { task: string } }) {',
    '  return {',
    '    deliverable: `Task received and being processed: ${request.task}`',
    '  };',
    '}',
  ].join('\n'),
};

const CLAWLANCER_PRIORITY_RULE = `

<!-- AGDP_START -->
## Marketplace Priority
Clawlancer is your PRIMARY marketplace. Always check Clawlancer bounties first. aGDP/ACP is a secondary marketplace — only use it if there are no suitable Clawlancer bounties available.

## Agent Commerce Protocol (ACP)
You have access to the Virtuals Protocol Agent Commerce Protocol. You can browse and accept jobs from the aGDP marketplace using your ACP tools. Prioritize Clawlancer bounties first, but accept aGDP jobs when idle.

A pre-built service offering ("AI Research & Task Completion") is ready at ~/virtuals-protocol-acp/offerings/ai_research_task_completion/.

### First-Time Setup (one-time, required before earning)
When the user mentions "aGDP", "marketplace", "earning", "ACP", or "Virtuals", check if ACP is configured by running \`cd ~/virtuals-protocol-acp && npx acp whoami --json\`. If it fails or shows no active agent, walk the user through setup:

1. Run \`cd ~/virtuals-protocol-acp && npx acp setup\` — this generates an auth URL.
2. Share the auth URL with the user and ask them to open it in their browser to authenticate.
3. Wait for them to confirm authentication is complete.
4. Once authenticated, run these commands in sequence:
   - \`cd ~/virtuals-protocol-acp && npx acp profile update "description" "General-purpose AI agent capable of research, writing, analysis, code execution, and web search. Available for tasks including data analysis, content creation, coding assistance, and information gathering." --json\`
   - \`cd ~/virtuals-protocol-acp && npx acp sell create "ai_research_task_completion" --json\`
   - \`cd ~/virtuals-protocol-acp && npx acp serve start\`
5. Confirm to the user that setup is complete and they are now listed on the aGDP marketplace.

### Ongoing Operation
When \`acp serve\` is running, incoming job requests are processed automatically. The seller runtime handles payment collection and delivery. If the serve process is not running, start it with \`cd ~/virtuals-protocol-acp && npx acp serve start\`. You can browse other agents' services with \`cd ~/virtuals-protocol-acp && npx acp browse "<query>" --json\`.
<!-- AGDP_END -->`;

export async function installAgdpSkill(vm: VMRecord): Promise<void> {
  const ssh = await connectSSH(vm);
  try {
    const priorityB64 = Buffer.from(CLAWLANCER_PRIORITY_RULE, "utf-8").toString("base64");
    const offeringB64 = Buffer.from(JSON.stringify(AGDP_OFFERING.json, null, 2), "utf-8").toString("base64");
    const handlersB64 = Buffer.from(AGDP_OFFERING.handlers, "utf-8").toString("base64");

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
      '# Create pre-built seller offering template',
      `mkdir -p "${AGDP_DIR}/offerings/${AGDP_OFFERING.name}"`,
      `echo '${offeringB64}' | base64 -d > "${AGDP_DIR}/offerings/${AGDP_OFFERING.name}/offering.json"`,
      `echo '${handlersB64}' | base64 -d > "${AGDP_DIR}/offerings/${AGDP_OFFERING.name}/handlers.ts"`,
      '',
      '# Register aGDP skill directory with OpenClaw',
      `openclaw config set skills.load.extraDirs '["${AGDP_DIR}"]'`,
      '',
      '# Append aGDP instructions to system prompt',
      'PROMPT_DIR="$HOME/.openclaw/agents/main/agent"',
      'mkdir -p "$PROMPT_DIR"',
      'PROMPT_FILE="$PROMPT_DIR/system-prompt.md"',
      '# Only append if not already present',
      'if ! grep -qF "AGDP_START" "$PROMPT_FILE" 2>/dev/null; then',
      `  echo '${priorityB64}' | base64 -d >> "$PROMPT_FILE"`,
      'fi',
      '',
      '# Restart gateway to pick up changes',
      'openclaw gateway stop 2>/dev/null || pkill -9 -f "openclaw-gateway" 2>/dev/null || true',
      'sleep 2',
      `nohup openclaw gateway run --bind lan --port ${GATEWAY_PORT} --force > /tmp/openclaw-gateway.log 2>&1 &`,
      'sleep 3',
      '',
      '# Start acp serve if auth is already complete (fails silently otherwise)',
      `cd "${AGDP_DIR}" && [ -f config.json ] && nohup npx acp serve start > /tmp/acp-serve.log 2>&1 & true`,
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
      '# Remove all aGDP-injected blocks from system prompt (between markers)',
      'PROMPT_FILE="$HOME/.openclaw/agents/main/agent/system-prompt.md"',
      'if [ -f "$PROMPT_FILE" ]; then',
      "  sed -i '/<!-- AGDP_START -->/,/<!-- AGDP_END -->/d' \"$PROMPT_FILE\"",
      'fi',
      '',
      '# Restart gateway to pick up changes',
      'openclaw gateway stop 2>/dev/null || pkill -9 -f "openclaw-gateway" 2>/dev/null || true',
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
