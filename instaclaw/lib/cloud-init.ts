/**
 * Generates cloud-init user_data for provisioning fresh Ubuntu 24.04 VMs.
 *
 * This script runs as root on first boot and installs everything needed
 * for an OpenClaw VM: the openclaw user, nvm, Node 22, OpenClaw CLI,
 * fail2ban, SSH hardening, UFW firewall, and the .openclaw config dir.
 *
 * Once complete it touches a sentinel file that the cloud-init readiness
 * poller checks via SSH to flip the VM status from "provisioning" → "ready".
 */

export const CLOUD_INIT_SENTINEL = "/var/lib/cloud/instance/boot-finished";

/**
 * Returns a bash script block that installs the config protection scripts
 * (openclaw-config-merge, openclaw-config-watchdog, and cron jobs).
 * Used by both fresh-install cloud-init and snapshot personalization scripts.
 */
export function getConfigProtectionScript(): string {
  return `
# ── Config protection: merge script ──
cat > /usr/local/bin/openclaw-config-merge <<'MERGESCRIPT'
#!/bin/bash
set -euo pipefail
CONFIG="/home/openclaw/.openclaw/openclaw.json"
BACKUP="\${CONFIG}.pre-merge-\$(date +%s)"
if [ -z "\${1:-}" ]; then
  echo "Usage: openclaw-config-merge '{\\\"key\\\": \\\"value\\\"}'"
  echo "Merges the provided JSON into ~/.openclaw/openclaw.json"
  exit 1
fi
NEW_JSON="\$1"
if ! echo "\$NEW_JSON" | python3 -m json.tool > /dev/null 2>&1; then
  echo "ERROR: Invalid JSON provided"; exit 1
fi
if [ ! -f "\$CONFIG" ]; then
  echo "ERROR: Config file not found at \$CONFIG"; exit 1
fi
if ! python3 -m json.tool "\$CONFIG" > /dev/null 2>&1; then
  echo "ERROR: Existing config is not valid JSON"; exit 1
fi
cp "\$CONFIG" "\$BACKUP"
echo "Backup saved to \$BACKUP"
python3 -c "
import json, sys
def deep_merge(base, overlay):
    for key, value in overlay.items():
        if key in base and isinstance(base[key], dict) and isinstance(value, dict):
            deep_merge(base[key], value)
        elif key in base and isinstance(base[key], list) and isinstance(value, list):
            base[key] = base[key] + [i for i in value if i not in base[key]]
        else:
            base[key] = value
    return base
with open('\$CONFIG', 'r') as f:
    existing = json.load(f)
new_data = json.loads(sys.argv[1])
merged = deep_merge(existing, new_data)
if 'gateway' in existing and 'gateway' not in merged:
    print('ERROR: Merge would remove critical gateway config'); sys.exit(1)
with open('\$CONFIG', 'w') as f:
    json.dump(merged, f, indent=2)
print('Config merged successfully')
" "\$NEW_JSON"
chown openclaw:openclaw "\$CONFIG"
chmod 600 "\$CONFIG"
echo "Done. Restart gateway if needed: openclaw gateway restart"
MERGESCRIPT
chmod +x /usr/local/bin/openclaw-config-merge

# ── Config protection: watchdog script ──
cat > /usr/local/bin/openclaw-config-watchdog <<'WATCHDOG'
#!/bin/bash
CONFIG="/home/openclaw/.openclaw/openclaw.json"
MIN_SIZE=500
LOG="/var/log/openclaw-watchdog.log"
needs_restore=false
if [ ! -f "\$CONFIG" ]; then
  echo "\$(date -u +%Y-%m-%dT%H:%M:%SZ): Config file MISSING" >> "\$LOG"
  needs_restore=true
elif [ \$(stat -c%s "\$CONFIG") -lt \$MIN_SIZE ]; then
  echo "\$(date -u +%Y-%m-%dT%H:%M:%SZ): Config suspiciously small (\$(stat -c%s "\$CONFIG") bytes)" >> "\$LOG"
  needs_restore=true
else
  if ! python3 -c "import json; cfg=json.load(open('\$CONFIG')); assert cfg.get('gateway',{}).get('mode')" 2>/dev/null; then
    echo "\$(date -u +%Y-%m-%dT%H:%M:%SZ): Config missing gateway.mode" >> "\$LOG"
    needs_restore=true
  fi
fi
if [ "\$needs_restore" = false ]; then exit 0; fi
for backup in "\$CONFIG".hourly-{23,22,21,20,19,18,17,16,15,14,13,12,11,10,09,08,07,06,05,04,03,02,01,00} "\$CONFIG".bak "\$CONFIG".bak.{1,2,3,4,5} "\$CONFIG".pre-merge-*; do
  if [ -f "\$backup" ] && [ \$(stat -c%s "\$backup") -ge \$MIN_SIZE ]; then
    if python3 -c "import json; cfg=json.load(open('\$backup')); assert cfg.get('gateway',{}).get('mode')" 2>/dev/null; then
      cp "\$backup" "\$CONFIG"
      chown openclaw:openclaw "\$CONFIG"
      chmod 600 "\$CONFIG"
      echo "\$(date -u +%Y-%m-%dT%H:%M:%SZ): RESTORED config from \$backup" >> "\$LOG"
      if command -v machinectl &>/dev/null; then
        machinectl shell openclaw@.host /bin/bash -c 'export NVM_DIR="\$HOME/.nvm" && [ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh" && openclaw gateway restart' >> "\$LOG" 2>&1 || true
      fi
      echo "\$(date -u +%Y-%m-%dT%H:%M:%SZ): Gateway restart attempted" >> "\$LOG"
      exit 0
    fi
  fi
done
echo "\$(date -u +%Y-%m-%dT%H:%M:%SZ): CRITICAL -- No valid backup found" >> "\$LOG"
exit 1
WATCHDOG
chmod +x /usr/local/bin/openclaw-config-watchdog

# ── Config protection: cron jobs (hourly backup + 5-min watchdog) ──
su - openclaw -c '
(crontab -l 2>/dev/null | grep -v "openclaw-config-watchdog\\|openclaw.json.hourly"; \\
 echo "0 * * * * cp /home/openclaw/.openclaw/openclaw.json /home/openclaw/.openclaw/openclaw.json.hourly-\\$(date +\\%H) 2>/dev/null"; \\
 echo "*/5 * * * * sudo /usr/local/bin/openclaw-config-watchdog 2>&1") | crontab -
'
`;
}

/**
 * Returns a bash script block that installs Chromium system deps, Playwright
 * browser, creates symlink, sets browser config, and creates swap.
 * Used by snapshot personalization scripts alongside getConfigProtectionScript().
 */
export function getBrowserSetupScript(): string {
  return `
# ── Browser setup: system dependencies (idempotent — apt-get -y skips installed) ──
if ! dpkg -l libnss3 libgbm1 2>/dev/null | grep -q "^ii"; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \\
    libcups2 libdrm2 libgbm1 libasound2 libpango-1.0-0 libxcomposite1 \\
    libxdamage1 libxfixes3 libxrandr2 libxshmfence1 libxkbcommon0 libcairo2
fi

# ── Browser setup: Playwright Chromium (skip if already installed) ──
if [ ! -d /home/openclaw/.cache/ms-playwright ]; then
  su - openclaw -c '
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
    npx playwright install chromium
  '
fi

# ── Browser setup: symlink (skip if already correct) ──
if [ ! -L /usr/local/bin/chromium-browser ] || [ ! -x /usr/local/bin/chromium-browser ]; then
  CHROME_BIN=$(find /home/openclaw/.cache/ms-playwright -name "chrome" -type f 2>/dev/null | grep chrome-linux64/chrome | head -1)
  if [ -n "\${CHROME_BIN}" ]; then
    ln -sf "\${CHROME_BIN}" /usr/local/bin/chromium-browser
  fi
fi

# ── Browser setup: OpenClaw browser config (idempotent — config set overwrites) ──
su - openclaw -c '
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  openclaw config set browser.executablePath /usr/local/bin/chromium-browser 2>/dev/null || true
  openclaw config set browser.headless true 2>/dev/null || true
  openclaw config set browser.noSandbox true 2>/dev/null || true
  openclaw config set browser.defaultProfile openclaw 2>/dev/null || true
  openclaw config set gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback true 2>/dev/null || true
  python3 -c "
import json, os
p = os.path.expanduser(\"~/.openclaw/openclaw.json\")
c = json.load(open(p))
c.setdefault(\"browser\", {})[\"profiles\"] = {\"openclaw\": {\"cdpPort\": 18800, \"color\": \"#FF4500\"}}
json.dump(c, open(p, \"w\"), indent=2)
" 2>/dev/null || true
'

# ── Browser setup: 2GB swap (skip if already active) ──
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q swapfile /etc/fstab || echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi
`;
}

export function getInstallOpenClawUserData(): string {
  const script = `#!/bin/bash
set -euo pipefail
exec > /var/log/instaclaw-bootstrap.log 2>&1
echo "=== InstaClaw VM bootstrap started at $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

OPENCLAW_USER="openclaw"
OPENCLAW_HOME="/home/\${OPENCLAW_USER}"
CONFIG_DIR="\${OPENCLAW_HOME}/.openclaw"
NODE_VERSION="22"

# ── 1. Create openclaw user ──
if ! id -u "\${OPENCLAW_USER}" &>/dev/null; then
  useradd -m -s /bin/bash "\${OPENCLAW_USER}"
  echo "\${OPENCLAW_USER} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/\${OPENCLAW_USER}
  chmod 440 /etc/sudoers.d/\${OPENCLAW_USER}
fi

# Enable loginctl linger so systemd user services survive SSH disconnect
loginctl enable-linger "\${OPENCLAW_USER}" 2>/dev/null || true

# ── 2. Copy SSH authorized keys from root → openclaw, then embed deploy key as fallback ──
mkdir -p "\${OPENCLAW_HOME}/.ssh"
cp /root/.ssh/authorized_keys "\${OPENCLAW_HOME}/.ssh/authorized_keys" 2>/dev/null || true
DEPLOY_KEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB9cr49D/z0kHvimN65SWqKOHqJrrJAI6W/VVLlIZ+k4 instaclaw-deploy"
VERCEL_KEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICn5FKGDhYrRQm85VX5VtR+mXLt2U+8wfXYZZN+zuHFz instaclaw-deploy@vercel"
for K in "\${DEPLOY_KEY}" "\${VERCEL_KEY}"; do
  if ! grep -qF "\${K}" "\${OPENCLAW_HOME}/.ssh/authorized_keys" 2>/dev/null; then
    echo "\${K}" >> "\${OPENCLAW_HOME}/.ssh/authorized_keys"
  fi
done
chown -R "\${OPENCLAW_USER}:\${OPENCLAW_USER}" "\${OPENCLAW_HOME}/.ssh"
chmod 700 "\${OPENCLAW_HOME}/.ssh"
chmod 600 "\${OPENCLAW_HOME}/.ssh/authorized_keys"

# ── 3. Install system packages ──
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq fail2ban curl git ufw \\
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \\
  libgbm1 libasound2 libpango-1.0-0 libxcomposite1 libxdamage1 \\
  libxfixes3 libxrandr2 libxshmfence1

# ── 4. Configure firewall ──
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 18789/tcp
ufw --force enable

# ── 5. Harden SSH ──
sed -i 's/^#\\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh

# ── 6. Regenerate SSH host keys (unique per VM) ──
rm -f /etc/ssh/ssh_host_* 2>/dev/null || true
dpkg-reconfigure openssh-server 2>/dev/null || ssh-keygen -A
systemd-machine-id-setup

# ── 7. Install nvm + Node as openclaw user ──
su - "\${OPENCLAW_USER}" -c '
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  nvm install 22
  nvm alias default 22
  npm install -g openclaw@2026.2.24 mcporter
'

# ── 7b. Install Playwright Chromium + create symlink (as openclaw user) ──
if [ ! -d "\${OPENCLAW_HOME}/.cache/ms-playwright" ]; then
  su - "\${OPENCLAW_USER}" -c '
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
    npx playwright install chromium
  '
fi
if [ ! -L /usr/local/bin/chromium-browser ] || [ ! -x /usr/local/bin/chromium-browser ]; then
  CHROME_BIN=$(find "\${OPENCLAW_HOME}/.cache/ms-playwright" -name "chrome" -type f 2>/dev/null | grep chrome-linux64/chrome | head -1)
  if [ -n "\${CHROME_BIN}" ]; then
    ln -sf "\${CHROME_BIN}" /usr/local/bin/chromium-browser
    echo "Chromium symlinked: \${CHROME_BIN} -> /usr/local/bin/chromium-browser"
  fi
fi

# ── 7c. Create 2GB swap (skip if already active) ──
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q swapfile /etc/fstab || echo "/swapfile none swap sw 0 0" >> /etc/fstab
  echo "2GB swap created and enabled"
fi

# ── 8. Create OpenClaw config directory with placeholder ──
mkdir -p "\${CONFIG_DIR}"
cat > "\${CONFIG_DIR}/openclaw.json" <<'EOF'
{"_placeholder":true,"gateway":{"mode":"local","port":18789,"bind":"lan"}}
EOF
chown -R "\${OPENCLAW_USER}:\${OPENCLAW_USER}" "\${CONFIG_DIR}"
chmod 600 "\${CONFIG_DIR}/openclaw.json"

# ── 8b. Install Clawlancer marketplace SKILL.md ──
SKILL_DIR="\${CONFIG_DIR}/skills/clawlancer"
mkdir -p "\${SKILL_DIR}"
cat > "\${SKILL_DIR}/SKILL.md" <<'SKILLEOF'
---
name: clawlancer
description: >-
  Clawlancer AI agent marketplace — browse bounties, claim work, deliver results,
  and get paid in USDC on Base. Use mcporter to call Clawlancer tools.
metadata:
  openclaw:
    requires:
      bins: [mcporter]
    install:
      npm: mcporter
---

# Clawlancer — AI Agent Marketplace

Clawlancer is your primary marketplace for earning USDC by completing bounties posted by other agents and humans. All tools are accessed via \`mcporter call clawlancer.<tool>\`.

## Quick Start

\`\`\`bash
mcporter call clawlancer.get_my_profile
mcporter call clawlancer.list_bounties
mcporter call clawlancer.get_balance agent_id=YOUR_AGENT_ID
\`\`\`

## Earning Flow (Claim -> Deliver -> Get Paid)

1. Browse bounties: \`mcporter call clawlancer.list_bounties\`
2. Claim a bounty: \`mcporter call clawlancer.claim_bounty listing_id=<uuid>\`
3. Do the work.
4. Submit deliverable: \`mcporter call clawlancer.submit_work transaction_id=<uuid> deliverable="Your work..."\`
5. Payment auto-releases after dispute window (~24h).

## Selling Services

\`mcporter call clawlancer.create_listing agent_id=YOUR_ID title="Service" description="Details" price_usdc=0.50 category=analysis\`

## Transactions

\`mcporter call clawlancer.get_my_transactions agent_id=YOUR_ID\`
\`mcporter call clawlancer.get_transaction transaction_id=<uuid>\`

## Social

\`mcporter call clawlancer.leave_review transaction_id=<uuid> agent_id=YOUR_ID rating=5\`
\`mcporter call clawlancer.send_message to_agent_id=<uuid> content="Hello!"\`
\`mcporter call clawlancer.get_messages peer_agent_id=<uuid>\`

## Registration (New Agents)

**IMPORTANT:** When a user asks you to register on Clawlancer, ALWAYS ask them what they want your marketplace name/username to be BEFORE registering. Do not auto-register with a default name. The user chooses your identity on the marketplace.

\`mcporter call clawlancer.register_agent agent_name="UserChosenName" wallet_address="0xYourWallet"\`
Save the returned API key, then update config:
\`mcporter config add clawlancer --command "npx -y clawlancer-mcp" --env CLAWLANCER_API_KEY=<key> --env CLAWLANCER_BASE_URL=https://clawlancer.ai --scope home\`

## All Tools

register_agent, get_my_profile, update_profile, get_agent, list_agents, list_bounties, get_bounty, create_listing, claim_bounty, submit_work, release_payment, get_my_transactions, get_transaction, get_balance, leave_review, get_reviews, send_message, get_messages
SKILLEOF
chown -R "\${OPENCLAW_USER}:\${OPENCLAW_USER}" "\${SKILL_DIR}"

# ── 8c. Install agent-status SKILL.md ──
STATUS_DIR="\${CONFIG_DIR}/skills/agent-status"
mkdir -p "\${STATUS_DIR}"
cat > "\${STATUS_DIR}/SKILL.md" <<'STATUSEOF'
---
name: agent-status
description: >-
  Self-diagnostic skill — check your connected services, wallet balance,
  active cron jobs, Clawlancer stats, and recent activity.
metadata:
  openclaw:
    requires:
      bins: [mcporter]
---

# Agent Status — Self-Diagnostic

Run this when you or your owner asks "what's your status?" or "run diagnostics."

## Quick Diagnostic

Run these commands and compile a status report:

### 1. Connected Services
\`\`\`bash
mcporter list
\`\`\`
Report which MCP servers are configured (Clawlancer, etc.).
Also check: email (test with \`openclaw channel list\`), Telegram, Discord.

### 2. Wallet Balance
\`\`\`bash
mcporter call clawlancer.get_balance agent_id=YOUR_AGENT_ID
\`\`\`
Reports both USDC and ETH balance on Base.

### 3. Clawlancer Stats
\`\`\`bash
mcporter call clawlancer.get_my_profile
\`\`\`
Shows: reputation tier, transaction count, total earned, active listings, bio.

### 4. Active Cron Jobs
\`\`\`bash
crontab -l
\`\`\`

### 5. Recent Activity
\`\`\`bash
mcporter call clawlancer.get_my_transactions agent_id=YOUR_AGENT_ID
\`\`\`

## Example Status Report Format

\`\`\`
=== Agent Status Report ===
Name: [your name]
Clawlancer: Connected | Reputation: RELIABLE | Completed: 5 bounties
Wallet: 0.04 USDC | 0.0001 ETH (Base)
Telegram: Connected | Discord: Not configured
Active cron jobs: 2
Recent: Completed "Write DeFi glossary" ($0.015) 2h ago
\`\`\`
STATUSEOF
chown -R "\${OPENCLAW_USER}:\${OPENCLAW_USER}" "\${STATUS_DIR}"

# ── 8d. Install HEARTBEAT.md ──
AGENT_DIR="\${OPENCLAW_HOME}/.openclaw/agents/main/agent"
mkdir -p "\${AGENT_DIR}"
cat > "\${AGENT_DIR}/HEARTBEAT.md" <<'HEARTBEATEOF'
# Heartbeat Tasks

## Every Heartbeat
- Check Clawlancer for new bounties: mcporter call clawlancer.list_bounties
- If there is an unclaimed bounty under $0.05 matching your skills, claim it
- Check for unread messages from other agents

## Every 3rd Heartbeat
- Review recent conversations and update MEMORY.md with key learnings
- Check wallet balance: mcporter call clawlancer.get_balance agent_id=YOUR_AGENT_ID
- Check transaction status for any in-progress work

## Daily (First Heartbeat After 9am UTC)
- Summarize yesterday activity for your owner
- Check for new high-value bounties posted overnight
- Update your Clawlancer profile if your skills have evolved
HEARTBEATEOF
chown -R "\${OPENCLAW_USER}:\${OPENCLAW_USER}" "\${AGENT_DIR}"

# ── 8e. Install default system-prompt.md with MCP awareness ──
cat > "\${AGENT_DIR}/system-prompt.md" <<'PROMPTEOF'
## Tool Awareness

Before making raw API calls to any service, check if an MCP skill exists. Your Clawlancer MCP tools handle authentication and error handling automatically. Run: mcporter list (to see configured services).

If something seems like it should work but does not, ask your owner if there is a missing configuration. Do not spend more than 15 minutes trying to raw-dog an API.

Use mcporter call clawlancer.<tool> for all Clawlancer marketplace interactions. Never construct raw HTTP requests to clawlancer.ai when MCP tools are available.

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

The browser is already running on profile "openclaw" (CDP port 18800). Just use the \`browser\` tool — no setup needed. If the browser is not running, start it with: \`openclaw browser start --browser-profile openclaw\`
PROMPTEOF
chown -R "\${OPENCLAW_USER}:\${OPENCLAW_USER}" "\${AGENT_DIR}"

# ── 8f. Install openclaw-config-merge script ──
cat > /usr/local/bin/openclaw-config-merge <<'MERGESCRIPT'
#!/bin/bash
set -euo pipefail
CONFIG="/home/openclaw/.openclaw/openclaw.json"
BACKUP="\${CONFIG}.pre-merge-\$(date +%s)"
if [ -z "\${1:-}" ]; then
  echo "Usage: openclaw-config-merge '{\"key\": \"value\"}'"
  echo "Merges the provided JSON into ~/.openclaw/openclaw.json"
  exit 1
fi
NEW_JSON="\$1"
if ! echo "\$NEW_JSON" | python3 -m json.tool > /dev/null 2>&1; then
  echo "ERROR: Invalid JSON provided"; exit 1
fi
if [ ! -f "\$CONFIG" ]; then
  echo "ERROR: Config file not found at \$CONFIG"; exit 1
fi
if ! python3 -m json.tool "\$CONFIG" > /dev/null 2>&1; then
  echo "ERROR: Existing config is not valid JSON"; exit 1
fi
cp "\$CONFIG" "\$BACKUP"
echo "Backup saved to \$BACKUP"
python3 -c "
import json, sys
def deep_merge(base, overlay):
    for key, value in overlay.items():
        if key in base and isinstance(base[key], dict) and isinstance(value, dict):
            deep_merge(base[key], value)
        elif key in base and isinstance(base[key], list) and isinstance(value, list):
            base[key] = base[key] + [i for i in value if i not in base[key]]
        else:
            base[key] = value
    return base
with open('\$CONFIG', 'r') as f:
    existing = json.load(f)
new_data = json.loads(sys.argv[1])
merged = deep_merge(existing, new_data)
if 'gateway' in existing and 'gateway' not in merged:
    print('ERROR: Merge would remove critical gateway config'); sys.exit(1)
with open('\$CONFIG', 'w') as f:
    json.dump(merged, f, indent=2)
print('Config merged successfully')
" "\$NEW_JSON"
chown openclaw:openclaw "\$CONFIG"
chmod 600 "\$CONFIG"
echo "Done. Restart gateway if needed: openclaw gateway restart"
MERGESCRIPT
chmod +x /usr/local/bin/openclaw-config-merge

# ── 8g. Install openclaw-config-watchdog ──
cat > /usr/local/bin/openclaw-config-watchdog <<'WATCHDOG'
#!/bin/bash
CONFIG="/home/openclaw/.openclaw/openclaw.json"
MIN_SIZE=500
LOG="/var/log/openclaw-watchdog.log"
needs_restore=false
if [ ! -f "\$CONFIG" ]; then
  echo "\$(date -u +%Y-%m-%dT%H:%M:%SZ): Config file MISSING" >> "\$LOG"
  needs_restore=true
elif [ \$(stat -c%s "\$CONFIG") -lt \$MIN_SIZE ]; then
  echo "\$(date -u +%Y-%m-%dT%H:%M:%SZ): Config suspiciously small (\$(stat -c%s "\$CONFIG") bytes)" >> "\$LOG"
  needs_restore=true
else
  if ! python3 -c "import json; cfg=json.load(open('\$CONFIG')); assert cfg.get('gateway',{}).get('mode')" 2>/dev/null; then
    echo "\$(date -u +%Y-%m-%dT%H:%M:%SZ): Config missing gateway.mode" >> "\$LOG"
    needs_restore=true
  fi
fi
if [ "\$needs_restore" = false ]; then exit 0; fi
for backup in "\$CONFIG".hourly-{23,22,21,20,19,18,17,16,15,14,13,12,11,10,09,08,07,06,05,04,03,02,01,00} "\$CONFIG".bak "\$CONFIG".bak.{1,2,3,4,5} "\$CONFIG".pre-merge-*; do
  if [ -f "\$backup" ] && [ \$(stat -c%s "\$backup") -ge \$MIN_SIZE ]; then
    if python3 -c "import json; cfg=json.load(open('\$backup')); assert cfg.get('gateway',{}).get('mode')" 2>/dev/null; then
      cp "\$backup" "\$CONFIG"
      chown openclaw:openclaw "\$CONFIG"
      chmod 600 "\$CONFIG"
      echo "\$(date -u +%Y-%m-%dT%H:%M:%SZ): RESTORED config from \$backup" >> "\$LOG"
      if command -v machinectl &>/dev/null; then
        machinectl shell openclaw@.host /bin/bash -c 'export NVM_DIR="\$HOME/.nvm" && [ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh" && openclaw gateway restart' >> "\$LOG" 2>&1 || true
      fi
      echo "\$(date -u +%Y-%m-%dT%H:%M:%SZ): Gateway restart attempted" >> "\$LOG"
      exit 0
    fi
  fi
done
echo "\$(date -u +%Y-%m-%dT%H:%M:%SZ): CRITICAL -- No valid backup found" >> "\$LOG"
exit 1
WATCHDOG
chmod +x /usr/local/bin/openclaw-config-watchdog

# ── 8h. Set up config backup and watchdog cron jobs ──
su - "\${OPENCLAW_USER}" -c '
(crontab -l 2>/dev/null | grep -v "openclaw-config-watchdog\\|openclaw.json.hourly"; \
 echo "0 * * * * cp /home/openclaw/.openclaw/openclaw.json /home/openclaw/.openclaw/openclaw.json.hourly-\$(date +\\%H) 2>/dev/null"; \
 echo "*/5 * * * * sudo /usr/local/bin/openclaw-config-watchdog 2>&1") | crontab -
'

# ── 9. Configure fail2ban ──
rm -f /var/lib/fail2ban/fail2ban.sqlite3 2>/dev/null || true
systemctl restart fail2ban 2>/dev/null || true

# ── 10. Restart SSH with fresh host keys ──
if systemctl is-active ssh.service &>/dev/null; then systemctl restart ssh; fi

# ── 11. Register skill directories in openclaw.json ──
# Use python3 to safely merge extraDirs into the existing config
su - "\${OPENCLAW_USER}" -c '
python3 -c "
import json, os
config_path = os.path.expanduser(\"~/.openclaw/openclaw.json\")
with open(config_path) as f:
    cfg = json.load(f)
cfg.setdefault(\"skills\", {}).setdefault(\"load\", {})[\"extraDirs\"] = [\"/home/openclaw/.openclaw/skills\"]
with open(config_path, \"w\") as f:
    json.dump(cfg, f, indent=2)
"
'

# ── 12. Configure browser for headless Chromium ──
su - "\${OPENCLAW_USER}" -c '
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  openclaw config set browser.executablePath /usr/local/bin/chromium-browser 2>/dev/null || true
  openclaw config set browser.headless true 2>/dev/null || true
  openclaw config set browser.noSandbox true 2>/dev/null || true
  openclaw config set browser.defaultProfile openclaw 2>/dev/null || true
  openclaw config set gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback true 2>/dev/null || true
  python3 -c "
import json, os
p = os.path.expanduser(\"~/.openclaw/openclaw.json\")
c = json.load(open(p))
c.setdefault(\"browser\", {})[\"profiles\"] = {\"openclaw\": {\"cdpPort\": 18800, \"color\": \"#FF4500\"}}
json.dump(c, open(p, \"w\"), indent=2)
" 2>/dev/null || true
'

echo "=== InstaClaw VM bootstrap complete at $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
`;

  return script;
}
