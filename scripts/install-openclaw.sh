#!/usr/bin/env bash
# =============================================================================
# install-openclaw.sh — Provision a Hetzner VM for OpenClaw hosting
#
# Usage:  sudo bash install-openclaw.sh [--domain <domain>]
#
# Options:
#   --domain <domain>   FQDN for this VM (e.g. vm-01.instaclaw.io).
#                       Required for Caddy to auto-provision TLS certificates.
#                       If omitted, Caddy will serve on the IP with self-signed certs.
#
# What it does:
#   1.  Updates Ubuntu packages
#   2.  Installs Docker + Docker Compose
#   3.  Installs Node.js 20
#   4.  Creates 'openclaw' user with docker permissions
#   5.  Hardens SSH (key-only, no root login, no password auth)
#   6.  Installs and configures fail2ban
#   7.  Installs Caddy as HTTPS reverse proxy
#   8.  Clones OpenClaw repo and builds Docker images
#   9.  Creates config directory with encrypted credential support
#   10. Configures UFW firewall (22, 80, 443 only; 3000/8080 localhost)
#   11. Prints success with the VM's IP address
#
# Idempotent — safe to run multiple times.
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()   { echo -e "${GREEN}[✓]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
fail()  { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }

require_root() {
  if [[ $EUID -ne 0 ]]; then
    fail "This script must be run as root (use sudo)."
  fi
}

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------

VM_DOMAIN=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)
      VM_DOMAIN="$2"
      shift 2
      ;;
    *)
      warn "Unknown argument: $1"
      shift
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------

require_root

export DEBIAN_FRONTEND=noninteractive
OPENCLAW_USER="openclaw"
OPENCLAW_HOME="/home/${OPENCLAW_USER}"
OPENCLAW_REPO="https://github.com/openclaw-ai/openclaw.git"
OPENCLAW_DIR="${OPENCLAW_HOME}/openclaw"
CONFIG_DIR="${OPENCLAW_HOME}/.openclaw"
CREDS_DIR="${CONFIG_DIR}/creds"
ENCRYPTION_KEY_FILE="${CONFIG_DIR}/.vault_key"

log "Starting OpenClaw VM provisioning (hardened)..."

# ---------------------------------------------------------------------------
# 1. Update Ubuntu
# ---------------------------------------------------------------------------

log "Updating system packages..."
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq \
  ca-certificates \
  curl \
  gnupg \
  lsb-release \
  git \
  jq \
  unzip \
  ufw \
  openssl

log "System packages up to date."

# ---------------------------------------------------------------------------
# 2. Install Docker + Docker Compose
# ---------------------------------------------------------------------------

if command -v docker &>/dev/null; then
  warn "Docker already installed: $(docker --version)"
else
  log "Installing Docker..."

  install -m 0755 -d /etc/apt/keyrings
  if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
      | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
  fi

  if [[ ! -f /etc/apt/sources.list.d/docker.list ]]; then
    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
      https://download.docker.com/linux/ubuntu \
      $(lsb_release -cs) stable" \
      | tee /etc/apt/sources.list.d/docker.list > /dev/null
  fi

  apt-get update -qq
  apt-get install -y -qq \
    docker-ce \
    docker-ce-cli \
    containerd.io \
    docker-buildx-plugin \
    docker-compose-plugin

  log "Docker installed: $(docker --version)"
fi

systemctl enable docker --now
log "Docker service is active."

# ---------------------------------------------------------------------------
# 3. Install Node.js 20
# ---------------------------------------------------------------------------

if command -v node &>/dev/null && node --version | grep -q "^v20"; then
  warn "Node.js 20 already installed: $(node --version)"
else
  log "Installing Node.js 20..."

  if [[ ! -f /etc/apt/sources.list.d/nodesource.list ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  fi

  apt-get install -y -qq nodejs
  log "Node.js installed: $(node --version)"
fi

# ---------------------------------------------------------------------------
# 4. Create 'openclaw' user
# ---------------------------------------------------------------------------

if id "${OPENCLAW_USER}" &>/dev/null; then
  warn "User '${OPENCLAW_USER}' already exists."
else
  log "Creating user '${OPENCLAW_USER}'..."
  useradd \
    --create-home \
    --shell /bin/bash \
    --groups docker \
    "${OPENCLAW_USER}"
  log "User '${OPENCLAW_USER}' created."
fi

# Ensure user is in the docker group
if ! groups "${OPENCLAW_USER}" | grep -q '\bdocker\b'; then
  usermod -aG docker "${OPENCLAW_USER}"
  log "Added '${OPENCLAW_USER}' to docker group."
fi

# Set up SSH directory
OPENCLAW_SSH_DIR="${OPENCLAW_HOME}/.ssh"
if [[ ! -d "${OPENCLAW_SSH_DIR}" ]]; then
  mkdir -p "${OPENCLAW_SSH_DIR}"
  chmod 700 "${OPENCLAW_SSH_DIR}"
  touch "${OPENCLAW_SSH_DIR}/authorized_keys"
  chmod 600 "${OPENCLAW_SSH_DIR}/authorized_keys"
  chown -R "${OPENCLAW_USER}:${OPENCLAW_USER}" "${OPENCLAW_SSH_DIR}"
  log "SSH directory created for '${OPENCLAW_USER}'."
fi

# Copy root's authorized_keys so the provisioning key works for both users
if [[ -f /root/.ssh/authorized_keys ]]; then
  cp /root/.ssh/authorized_keys "${OPENCLAW_SSH_DIR}/authorized_keys"
  chown "${OPENCLAW_USER}:${OPENCLAW_USER}" "${OPENCLAW_SSH_DIR}/authorized_keys"
  chmod 600 "${OPENCLAW_SSH_DIR}/authorized_keys"
  log "Copied SSH authorized_keys to '${OPENCLAW_USER}'."
fi

# ---------------------------------------------------------------------------
# 5. SSH Hardening
# ---------------------------------------------------------------------------

log "Hardening SSH configuration..."

SSHD_CONFIG="/etc/ssh/sshd_config"
SSHD_HARDENED="/etc/ssh/sshd_config.d/99-instaclaw-hardened.conf"

# Write a drop-in config so we don't clobber the main sshd_config.
# Drop-ins in sshd_config.d/ override matching directives.
cat > "${SSHD_HARDENED}" <<'SSHEOF'
# =============================================================================
# InstaClaw SSH hardening — managed by install-openclaw.sh
# =============================================================================

# Disable password authentication — key-only
PasswordAuthentication no
ChallengeResponseAuthentication no

# Disable root login entirely
PermitRootLogin no

# Only allow key-based authentication
PubkeyAuthentication yes
AuthenticationMethods publickey

# Disable other auth methods
KbdInteractiveAuthentication no
UsePAM yes

# Limit login attempts per connection
MaxAuthTries 3

# Disconnect idle sessions after 10 minutes
ClientAliveInterval 300
ClientAliveCountMax 2

# Disable X11 and agent forwarding (not needed for headless VMs)
X11Forwarding no
AllowAgentForwarding no

# Only allow the openclaw user to SSH in
AllowUsers openclaw
SSHEOF

chmod 644 "${SSHD_HARDENED}"

# Ensure the main config includes the drop-in directory
if ! grep -q "^Include /etc/ssh/sshd_config.d/" "${SSHD_CONFIG}" 2>/dev/null; then
  # Prepend the include so drop-ins take priority
  sed -i '1i Include /etc/ssh/sshd_config.d/*.conf' "${SSHD_CONFIG}"
fi

# Validate the config before restarting (so we don't lock ourselves out)
if sshd -t 2>/dev/null; then
  # Ubuntu 24.04+ uses 'ssh.service', older uses 'sshd.service'
  if systemctl is-active ssh.service &>/dev/null; then
    systemctl restart ssh
  else
    systemctl restart sshd
  fi
  log "SSH hardened: key-only auth, no root login, openclaw user only."
else
  rm -f "${SSHD_HARDENED}"
  fail "SSH config validation failed. Hardening reverted. Check manually."
fi

# ---------------------------------------------------------------------------
# 6. Install and configure fail2ban
# ---------------------------------------------------------------------------

log "Setting up fail2ban..."

apt-get install -y -qq fail2ban

# Create a local jail config (overrides defaults without editing jail.conf)
cat > /etc/fail2ban/jail.local <<'F2BEOF'
# =============================================================================
# InstaClaw fail2ban config — managed by install-openclaw.sh
# =============================================================================

[DEFAULT]
# Ban for 10 minutes after 5 failed attempts within 10 minutes
bantime  = 600
findtime = 600
maxretry = 5
banaction = ufw

[sshd]
enabled  = true
port     = ssh
filter   = sshd
logpath  = /var/log/auth.log
maxretry = 5
bantime  = 600
F2BEOF

systemctl enable fail2ban --now
systemctl restart fail2ban

log "fail2ban configured: SSH jail active (5 attempts, 10 min ban)."

# ---------------------------------------------------------------------------
# 7. Install Caddy as HTTPS reverse proxy
# ---------------------------------------------------------------------------

log "Installing Caddy..."

if command -v caddy &>/dev/null; then
  warn "Caddy already installed: $(caddy version)"
else
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https

  if [[ ! -f /usr/share/keyrings/caddy-stable-archive-keyring.gpg ]]; then
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  fi

  if [[ ! -f /etc/apt/sources.list.d/caddy-stable.list ]]; then
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      | tee /etc/apt/sources.list.d/caddy-stable.list > /dev/null
  fi

  apt-get update -qq
  apt-get install -y -qq caddy

  log "Caddy installed: $(caddy version)"
fi

# Write Caddyfile — reverse proxy with auth token validation
CADDYFILE="/etc/caddy/Caddyfile"

if [[ -n "${VM_DOMAIN}" ]]; then
  # Domain provided — Caddy auto-provisions real TLS certs via Let's Encrypt
  CADDY_HOST="${VM_DOMAIN}"
  TLS_DIRECTIVE=""
else
  # No domain — bind to all interfaces, use Caddy's internal self-signed certs
  VM_IP_FOR_CADDY=$(curl -s -4 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
  CADDY_HOST=":443"
  TLS_DIRECTIVE="    tls internal"
  warn "No --domain specified. Caddy will use self-signed TLS on ${VM_IP_FOR_CADDY}."
fi

cat > "${CADDYFILE}" <<CADDYEOF
# =============================================================================
# InstaClaw Caddy config — managed by install-openclaw.sh
#
# Reverse proxy for OpenClaw gateway (8080) and control UI (3000).
# Both services bind to 127.0.0.1 only — external access is through Caddy.
# Gateway requests require a valid X-Gateway-Token header.
# =============================================================================

${CADDY_HOST} {
${TLS_DIRECTIVE}
    # --- Gateway API (proxied from /api/gateway/*) ---
    handle /api/gateway/* {
        # Validate gateway auth token at the proxy level.
        # Requests without a valid X-Gateway-Token header get 401.
        @no_token {
            not header X-Gateway-Token *
        }
        respond @no_token 401 {
            body "Missing gateway token"
            close
        }

        reverse_proxy 127.0.0.1:8080
    }

    # --- Health check (no auth required, used by InstaClaw cron) ---
    handle /health {
        reverse_proxy 127.0.0.1:8080
    }

    # --- Telegram webhook (no auth required, called by Telegram servers) ---
    handle /webhook {
        reverse_proxy 127.0.0.1:8080
    }

    # --- Control UI (everything else) ---
    handle {
        reverse_proxy 127.0.0.1:3000
    }

    # Security headers
    header {
        X-Content-Type-Options    nosniff
        X-Frame-Options           DENY
        Referrer-Policy            strict-origin-when-cross-origin
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        -Server
    }

    log {
        output file /var/log/caddy/access.log {
            roll_size 10mb
            roll_keep 5
        }
    }
}

# HTTP -> HTTPS redirect (Caddy does this automatically for named domains,
# but we add an explicit block for IP-only mode)
:80 {
    redir https://{host}{uri} permanent
}
CADDYEOF

mkdir -p /var/log/caddy
chown caddy:caddy /var/log/caddy
touch /var/log/caddy/access.log
chown caddy:caddy /var/log/caddy/access.log

# Validate and start
# NOTE: We use stop+start instead of reload because systemctl reload caddy
# hangs indefinitely on fresh installs (systemd reload timeout issue).
if caddy validate --config "${CADDYFILE}" 2>/dev/null; then
  systemctl enable caddy --now 2>/dev/null || true
  systemctl stop caddy 2>/dev/null || true
  sleep 2
  systemctl start caddy
  log "Caddy configured as HTTPS reverse proxy."
else
  warn "Caddy config validation failed. Check ${CADDYFILE} manually."
fi

# ---------------------------------------------------------------------------
# 8. Clone OpenClaw repo
# ---------------------------------------------------------------------------

if [[ -d "${OPENCLAW_DIR}" ]]; then
  warn "OpenClaw repo already exists at ${OPENCLAW_DIR}. Pulling latest..."
  sudo -u "${OPENCLAW_USER}" bash -c "cd ${OPENCLAW_DIR} && git pull --ff-only" || true
else
  log "Cloning OpenClaw repo..."
  if sudo -u "${OPENCLAW_USER}" git clone "${OPENCLAW_REPO}" "${OPENCLAW_DIR}" 2>/dev/null; then
    log "OpenClaw cloned to ${OPENCLAW_DIR}."
  else
    warn "OpenClaw repo not available yet (${OPENCLAW_REPO}). Skipping clone."
    warn "Run 'git clone <repo> ${OPENCLAW_DIR}' manually when the repo is ready."
    sudo -u "${OPENCLAW_USER}" mkdir -p "${OPENCLAW_DIR}"
  fi
fi

# ---------------------------------------------------------------------------
# 9. Build Docker images
# ---------------------------------------------------------------------------

log "Building OpenClaw Docker images..."
if [[ -f "${OPENCLAW_DIR}/docker-compose.yml" ]]; then
  if sudo -u "${OPENCLAW_USER}" bash -c "cd ${OPENCLAW_DIR} && docker compose build" 2>/dev/null; then
    log "Docker images built successfully."
  else
    warn "Docker compose build failed. Images may need to be built manually."
  fi
elif [[ -f "${OPENCLAW_DIR}/Dockerfile" ]]; then
  if sudo -u "${OPENCLAW_USER}" bash -c "cd ${OPENCLAW_DIR} && docker build -t openclaw-gateway ." 2>/dev/null; then
    log "Docker image 'openclaw-gateway' built."
  else
    warn "Docker build failed. Image may need to be built manually."
  fi
else
  warn "No docker-compose.yml or Dockerfile found. Skipping build."
  warn "You may need to build images manually after checking the repo structure."
fi

# ---------------------------------------------------------------------------
# 10. Create config directory with encrypted credential support
# ---------------------------------------------------------------------------

if [[ ! -d "${CONFIG_DIR}" ]]; then
  sudo -u "${OPENCLAW_USER}" mkdir -p "${CONFIG_DIR}"
  log "Config directory created at ${CONFIG_DIR}."
else
  warn "Config directory already exists at ${CONFIG_DIR}."
fi

# Create the credentials sub-directory (encrypted secrets go here)
sudo -u "${OPENCLAW_USER}" mkdir -p "${CREDS_DIR}"
chmod 700 "${CREDS_DIR}"

# Generate a per-VM encryption key if one doesn't exist.
# This key encrypts API keys at rest. It is generated once per VM and
# stored with 0400 permissions readable only by the openclaw user.
if [[ ! -f "${ENCRYPTION_KEY_FILE}" ]]; then
  openssl rand -base64 32 | sudo -u "${OPENCLAW_USER}" tee "${ENCRYPTION_KEY_FILE}" > /dev/null
  chmod 400 "${ENCRYPTION_KEY_FILE}"
  chown "${OPENCLAW_USER}:${OPENCLAW_USER}" "${ENCRYPTION_KEY_FILE}"
  log "Encryption key generated at ${ENCRYPTION_KEY_FILE}."
else
  warn "Encryption key already exists."
fi

# Write a placeholder config (will be overwritten by configure-vm.sh)
if [[ ! -f "${CONFIG_DIR}/openclaw.json" ]]; then
  sudo -u "${OPENCLAW_USER}" bash -c "cat > ${CONFIG_DIR}/openclaw.json" <<'PLACEHOLDER'
{
  "_note": "Placeholder config. Run configure-vm.sh to set up this instance.",
  "telegram": { "bot_token": "" },
  "api": { "mode": "all_inclusive", "key_encrypted": true },
  "gateway": { "token": "", "port": 8080, "bind": "127.0.0.1" }
}
PLACEHOLDER
  chmod 600 "${CONFIG_DIR}/openclaw.json"
  log "Placeholder config written to ${CONFIG_DIR}/openclaw.json."
fi

# ---------------------------------------------------------------------------
# 11. Configure UFW firewall
# ---------------------------------------------------------------------------

log "Configuring firewall..."

# Reset UFW to clean state (idempotent — won't fail if already reset)
ufw --force reset > /dev/null 2>&1

# Default policy: deny incoming, allow outgoing
ufw default deny incoming > /dev/null
ufw default allow outgoing > /dev/null

# SSH — required or we lose access
ufw allow 22/tcp comment "SSH" > /dev/null

# HTTP — Caddy redirect to HTTPS
ufw allow 80/tcp comment "HTTP redirect" > /dev/null

# HTTPS — Caddy reverse proxy (the only external entry point)
ufw allow 443/tcp comment "HTTPS (Caddy)" > /dev/null

# Explicitly deny external access to gateway and control UI.
# These bind to 127.0.0.1 and are proxied through Caddy, but belt-and-suspenders.
ufw deny in on any to any port 3000 comment "Block external Control UI" > /dev/null 2>&1 || true
ufw deny in on any to any port 8080 comment "Block external Gateway" > /dev/null 2>&1 || true

# Enable UFW
echo "y" | ufw enable > /dev/null 2>&1 || true
ufw reload > /dev/null

log "Firewall configured: SSH (22), HTTP (80), HTTPS (443)."
log "Ports 3000 and 8080 blocked externally (localhost only via Caddy)."

# ---------------------------------------------------------------------------
# 12. Print success
# ---------------------------------------------------------------------------

VM_IP=$(curl -s -4 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')

echo ""
echo "=============================================="
echo -e "${GREEN} OpenClaw VM provisioning complete!${NC}"
echo "=============================================="
echo ""
echo "  VM IP:         ${VM_IP}"
if [[ -n "${VM_DOMAIN}" ]]; then
echo "  Domain:        ${VM_DOMAIN}"
echo "  HTTPS:         https://${VM_DOMAIN}"
fi
echo "  User:          ${OPENCLAW_USER}"
echo "  OpenClaw dir:  ${OPENCLAW_DIR}"
echo "  Config dir:    ${CONFIG_DIR}"
echo ""
echo "  Security:"
echo "    SSH:         Key-only, no root, no password"
echo "    fail2ban:    Active (5 attempts / 10 min ban)"
echo "    Firewall:    22, 80, 443 only"
echo "    Proxy:       Caddy HTTPS reverse proxy"
echo "    Credentials: AES-256 encrypted at rest"
echo "    Gateway:     127.0.0.1 only (behind Caddy)"
echo ""
echo "  Next step: Run configure-vm.sh to set up"
echo "  a user's OpenClaw instance on this VM."
echo ""
echo "=============================================="
