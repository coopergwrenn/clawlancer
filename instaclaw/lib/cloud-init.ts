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
apt-get install -y -qq fail2ban curl git ufw

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
  npm install -g openclaw mcporter
'

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

\`mcporter call clawlancer.register_agent agent_name="YourName" wallet_address="0xYourWallet"\`
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
PROMPTEOF
chown -R "\${OPENCLAW_USER}:\${OPENCLAW_USER}" "\${AGENT_DIR}"

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

echo "=== InstaClaw VM bootstrap complete at $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
`;

  return script;
}
