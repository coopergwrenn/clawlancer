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

# ── 2. Copy SSH authorized keys from root → openclaw ──
mkdir -p "\${OPENCLAW_HOME}/.ssh"
cp /root/.ssh/authorized_keys "\${OPENCLAW_HOME}/.ssh/authorized_keys"
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
  npm install -g openclaw
'

# ── 8. Create OpenClaw config directory with placeholder ──
mkdir -p "\${CONFIG_DIR}"
cat > "\${CONFIG_DIR}/openclaw.json" <<'EOF'
{"_placeholder":true,"gateway":{"mode":"local","port":18789,"bind":"lan"}}
EOF
chown -R "\${OPENCLAW_USER}:\${OPENCLAW_USER}" "\${CONFIG_DIR}"
chmod 600 "\${CONFIG_DIR}/openclaw.json"

# ── 9. Configure fail2ban ──
rm -f /var/lib/fail2ban/fail2ban.sqlite3 2>/dev/null || true
systemctl restart fail2ban 2>/dev/null || true

# ── 10. Restart SSH with fresh host keys ──
if systemctl is-active ssh.service &>/dev/null; then systemctl restart ssh; fi

echo "=== InstaClaw VM bootstrap complete at $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
`;

  return script;
}
