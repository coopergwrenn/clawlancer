#!/usr/bin/env bash
# =============================================================================
# provision-vm.sh — Create a Hetzner VM, configure it, register in Supabase
#
# Usage:
#   ./scripts/provision-vm.sh <vm-name>              # snapshot mode (fast, ~2 min)
#   ./scripts/provision-vm.sh --fresh <vm-name>      # full install mode (~5 min)
#
# Modes:
#   Snapshot (default):  Creates VM from HETZNER_SNAPSHOT_ID, runs personalize-vm.sh
#   Fresh (--fresh):     Creates VM from ubuntu-24.04, runs install-openclaw.sh
#
# Prerequisites:
#   - ssh-agent loaded with ~/.ssh/instaclaw key
#   - instaclaw/.env.local with HETZNER_API_TOKEN, Supabase creds
#   - HETZNER_SNAPSHOT_ID in .env.local (for snapshot mode)
#   - jq installed
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

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------

FORCE_FRESH=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fresh)
      FORCE_FRESH=true
      shift
      ;;
    -*)
      fail "Unknown flag: $1"
      ;;
    *)
      VM_NAME="$1"
      shift
      ;;
  esac
done

: "${VM_NAME:?Usage: $0 [--fresh] <vm-name>}"

if [[ ! "${VM_NAME}" =~ ^[a-z0-9-]+$ ]]; then
  fail "VM name must contain only lowercase letters, numbers, and hyphens."
fi

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${REPO_ROOT}/instaclaw/.env.local"

if [[ ! -f "${ENV_FILE}" ]]; then
  fail "Missing ${ENV_FILE}."
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

: "${HETZNER_API_TOKEN:?Set HETZNER_API_TOKEN in ${ENV_FILE}}"
: "${NEXT_PUBLIC_SUPABASE_URL:?Set NEXT_PUBLIC_SUPABASE_URL in ${ENV_FILE}}"
: "${SUPABASE_SERVICE_ROLE_KEY:?Set SUPABASE_SERVICE_ROLE_KEY in ${ENV_FILE}}"

HETZNER_BASE="https://api.hetzner.cloud/v1"
SSH_KEY_PATH="${HOME}/.ssh/instaclaw"
SSH_KEY_NAME="instaclaw-deploy"
FIREWALL_NAME="instaclaw-firewall"
SERVER_TYPE="cpx21"
LOCATION="ash"
REGION="us-east"
SSH_OPTS="-o ConnectTimeout=5 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"

# Decide mode: snapshot (fast) vs fresh (full install)
if [[ "${FORCE_FRESH}" == true ]]; then
  MODE="fresh"
  IMAGE="ubuntu-24.04"
elif [[ -n "${HETZNER_SNAPSHOT_ID:-}" ]]; then
  MODE="snapshot"
  IMAGE="${HETZNER_SNAPSHOT_ID}"
else
  warn "HETZNER_SNAPSHOT_ID not set — falling back to fresh install."
  MODE="fresh"
  IMAGE="ubuntu-24.04"
fi

log "Mode: ${MODE} (image: ${IMAGE})"

# ---------------------------------------------------------------------------
# 1. Ensure ssh-agent
# ---------------------------------------------------------------------------

log "Checking SSH agent..."

if [[ -z "${SSH_AUTH_SOCK:-}" ]]; then
  warn "ssh-agent not running. Starting one..."
  eval "$(ssh-agent -s)"
fi

if ! ssh-add -l 2>/dev/null | grep -qi instaclaw; then
  log "Adding ${SSH_KEY_PATH} to ssh-agent..."
  ssh-add "${SSH_KEY_PATH}"
fi

log "SSH agent ready."

# ---------------------------------------------------------------------------
# 2. Look up Hetzner resource IDs
# ---------------------------------------------------------------------------

log "Looking up Hetzner resource IDs..."

hetzner() {
  curl -sf --connect-timeout 10 --max-time 30 "$@" -H "Authorization: Bearer ${HETZNER_API_TOKEN}"
}

SSH_KEY_ID=$(hetzner "${HETZNER_BASE}/ssh_keys" | \
  jq -r ".ssh_keys[] | select(.name==\"${SSH_KEY_NAME}\") | .id")

[[ -n "${SSH_KEY_ID}" && "${SSH_KEY_ID}" != "null" ]] || \
  fail "SSH key '${SSH_KEY_NAME}' not found in Hetzner."

FIREWALL_ID=$(hetzner "${HETZNER_BASE}/firewalls" | \
  jq -r ".firewalls[] | select(.name==\"${FIREWALL_NAME}\") | .id")

[[ -n "${FIREWALL_ID}" && "${FIREWALL_ID}" != "null" ]] || \
  fail "Firewall '${FIREWALL_NAME}' not found in Hetzner."

log "SSH Key ID: ${SSH_KEY_ID}, Firewall ID: ${FIREWALL_ID}"

# ---------------------------------------------------------------------------
# 3. Build cloud-init user_data (snapshot mode only)
# ---------------------------------------------------------------------------

USER_DATA_B64=""

if [[ "${MODE}" == "snapshot" ]]; then
  # Cloud-init runs as root on first boot — personalizes the snapshot
  USER_DATA=$(cat <<'CLOUD_INIT'
#!/bin/bash
set -euo pipefail

OPENCLAW_USER="openclaw"
OPENCLAW_HOME="/home/${OPENCLAW_USER}"
CONFIG_DIR="${OPENCLAW_HOME}/.openclaw"
CREDS_DIR="${CONFIG_DIR}/creds"
ENCRYPTION_KEY_FILE="${CONFIG_DIR}/.vault_key"

# 1. Regenerate SSH host keys
rm -f /etc/ssh/ssh_host_* 2>/dev/null || true
dpkg-reconfigure openssh-server 2>/dev/null || ssh-keygen -A

# 2. Regenerate machine-id
systemd-machine-id-setup

# 3. Generate per-VM encryption key
mkdir -p "${CONFIG_DIR}" "${CREDS_DIR}"
chown "${OPENCLAW_USER}:${OPENCLAW_USER}" "${CONFIG_DIR}" "${CREDS_DIR}"
chmod 700 "${CREDS_DIR}"
openssl rand -base64 32 > "${ENCRYPTION_KEY_FILE}"
chmod 400 "${ENCRYPTION_KEY_FILE}"
chown "${OPENCLAW_USER}:${OPENCLAW_USER}" "${ENCRYPTION_KEY_FILE}"

# 4. Write placeholder config
cat > "${CONFIG_DIR}/openclaw.json" <<'EOF'
{
  "_note": "Placeholder config. Run configure-vm.sh to set up this instance.",
  "telegram": { "bot_token": "" },
  "api": { "mode": "all_inclusive", "key_encrypted": true },
  "gateway": { "token": "", "port": 8080, "bind": "127.0.0.1" }
}
EOF
chown "${OPENCLAW_USER}:${OPENCLAW_USER}" "${CONFIG_DIR}/openclaw.json"
chmod 600 "${CONFIG_DIR}/openclaw.json"

# 5. Reset fail2ban
rm -f /var/lib/fail2ban/fail2ban.sqlite3 2>/dev/null || true
systemctl restart fail2ban 2>/dev/null || true

# 6. Restart Caddy (stop+start to avoid reload hang)
systemctl stop caddy 2>/dev/null || true
sleep 1
systemctl start caddy 2>/dev/null || true

# 7. Restart SSH
if systemctl is-active ssh.service &>/dev/null; then
  systemctl restart ssh
elif systemctl is-active sshd.service &>/dev/null; then
  systemctl restart sshd
fi

# 8. Signal completion
touch /tmp/.instaclaw-personalized
CLOUD_INIT
)
  USER_DATA_B64=$(echo "${USER_DATA}" | base64 | tr -d '\n')
fi

# ---------------------------------------------------------------------------
# 4. Create the server
# ---------------------------------------------------------------------------

log "Creating Hetzner server '${VM_NAME}' (${SERVER_TYPE}, ${MODE}, ${LOCATION})..."

CREATE_BODY="{
  \"name\": \"${VM_NAME}\",
  \"server_type\": \"${SERVER_TYPE}\",
  \"image\": \"${IMAGE}\",
  \"location\": \"${LOCATION}\",
  \"ssh_keys\": [${SSH_KEY_ID}],
  \"firewalls\": [{\"firewall\": ${FIREWALL_ID}}]"

if [[ -n "${USER_DATA_B64}" ]]; then
  CREATE_BODY="${CREATE_BODY}, \"user_data\": \"${USER_DATA_B64}\""
fi

CREATE_BODY="${CREATE_BODY}}"

CREATE_RESPONSE=$(hetzner -X POST "${HETZNER_BASE}/servers" \
  -H "Content-Type: application/json" \
  -d "${CREATE_BODY}")

SERVER_ID=$(echo "${CREATE_RESPONSE}" | jq -r '.server.id')
SERVER_IP=$(echo "${CREATE_RESPONSE}" | jq -r '.server.public_net.ipv4.ip')

if [[ -z "${SERVER_ID}" || "${SERVER_ID}" == "null" ]]; then
  ERROR_MSG=$(echo "${CREATE_RESPONSE}" | jq -r '.error.message // "unknown error"')
  fail "Failed to create server: ${ERROR_MSG}"
fi

log "Server created: ID=${SERVER_ID}, IP=${SERVER_IP}"

# ---------------------------------------------------------------------------
# 5. Wait for server to be running
# ---------------------------------------------------------------------------

log "Waiting for server to be running..."

TIMEOUT=120
ELAPSED=0

while [[ ${ELAPSED} -lt ${TIMEOUT} ]]; do
  STATUS=$(hetzner "${HETZNER_BASE}/servers/${SERVER_ID}" 2>/dev/null | jq -r '.server.status' 2>/dev/null || echo "unknown")

  if [[ "${STATUS}" == "running" ]]; then
    SERVER_IP=$(hetzner "${HETZNER_BASE}/servers/${SERVER_ID}" 2>/dev/null | jq -r '.server.public_net.ipv4.ip' 2>/dev/null || echo "${SERVER_IP}")
    log "Server is running. IP: ${SERVER_IP}"
    break
  fi

  sleep 5
  ELAPSED=$((ELAPSED + 5))
  echo -n "."
done

[[ ${ELAPSED} -lt ${TIMEOUT} ]] || fail "Server did not start within ${TIMEOUT}s."

# ---------------------------------------------------------------------------
# 6. Wait for SSH access
# ---------------------------------------------------------------------------

if [[ "${MODE}" == "snapshot" ]]; then
  # Snapshot: SSH hardening already applied, connect as openclaw
  SSH_USER="openclaw"
else
  # Fresh: root is available before hardening
  SSH_USER="root"
fi

log "Waiting for SSH access (${SSH_USER}@${SERVER_IP})..."

TIMEOUT=120
ELAPSED=0

while [[ ${ELAPSED} -lt ${TIMEOUT} ]]; do
  # shellcheck disable=SC2086
  if ssh ${SSH_OPTS} "${SSH_USER}@${SERVER_IP}" "echo ok" 2>/dev/null; then
    log "SSH access confirmed (${SSH_USER})."
    break
  fi
  sleep 5
  ELAPSED=$((ELAPSED + 5))
  echo -n "."
done

[[ ${ELAPSED} -lt ${TIMEOUT} ]] || fail "SSH not available after ${TIMEOUT}s."

# ---------------------------------------------------------------------------
# 7. Configure the VM
# ---------------------------------------------------------------------------

START_TIME=${SECONDS}

if [[ "${MODE}" == "snapshot" ]]; then
  # Snapshot mode: wait for cloud-init personalization to complete
  log "Waiting for cloud-init personalization..."

  TIMEOUT=120
  ELAPSED=0

  while [[ ${ELAPSED} -lt ${TIMEOUT} ]]; do
    # shellcheck disable=SC2086
    if ssh ${SSH_OPTS} "openclaw@${SERVER_IP}" \
      "docker run --rm --privileged --pid=host alpine:3.19 nsenter -t 1 -m -u -i -n -- test -f /tmp/.instaclaw-personalized" 2>/dev/null; then
      log "Cloud-init personalization complete."
      break
    fi
    sleep 5
    ELAPSED=$((ELAPSED + 5))
    echo -n "."
  done

  if [[ ${ELAPSED} -ge ${TIMEOUT} ]]; then
    warn "Cloud-init signal not found. Running personalize-vm.sh as fallback..."
    PERSONALIZE_SCRIPT="${SCRIPT_DIR}/personalize-vm.sh"
    if [[ -f "${PERSONALIZE_SCRIPT}" ]]; then
      # shellcheck disable=SC2086
      scp ${SSH_OPTS} "${PERSONALIZE_SCRIPT}" "openclaw@${SERVER_IP}:/tmp/personalize-vm.sh"
      # shellcheck disable=SC2086
      ssh ${SSH_OPTS} "openclaw@${SERVER_IP}" \
        "docker run --rm --privileged --pid=host -v /tmp:/tmp:ro alpine:3.19 nsenter -t 1 -m -u -i -n -- bash /tmp/personalize-vm.sh"
    else
      warn "personalize-vm.sh not found. VM may need manual personalization."
    fi
  fi

else
  # Fresh mode: upload and run full install
  INSTALL_SCRIPT="${SCRIPT_DIR}/install-openclaw.sh"
  [[ -f "${INSTALL_SCRIPT}" ]] || fail "install-openclaw.sh not found."

  log "Uploading install-openclaw.sh..."
  # shellcheck disable=SC2086
  scp ${SSH_OPTS} "${INSTALL_SCRIPT}" "root@${SERVER_IP}:/root/install-openclaw.sh"

  log "Running install-openclaw.sh (3-5 minutes)..."
  # shellcheck disable=SC2086
  ssh ${SSH_OPTS} "root@${SERVER_IP}" "bash /root/install-openclaw.sh"
  log "install-openclaw.sh completed."

  # Verify openclaw user SSH (root is now locked out)
  log "Verifying SSH as openclaw..."
  TIMEOUT=30
  ELAPSED=0
  while [[ ${ELAPSED} -lt ${TIMEOUT} ]]; do
    # shellcheck disable=SC2086
    if ssh ${SSH_OPTS} "openclaw@${SERVER_IP}" "echo ok" 2>/dev/null; then
      log "SSH access confirmed (openclaw)."
      break
    fi
    sleep 3
    ELAPSED=$((ELAPSED + 3))
  done
fi

CONFIGURE_TIME=$((SECONDS - START_TIME))

# ---------------------------------------------------------------------------
# 8. Verify services
# ---------------------------------------------------------------------------

log "Verifying services..."

# shellcheck disable=SC2086
VERIFY=$(ssh ${SSH_OPTS} "openclaw@${SERVER_IP}" "
  echo \"caddy:\$(docker run --rm --privileged --pid=host alpine:3.19 nsenter -t 1 -m -u -i -n -- systemctl is-active caddy 2>/dev/null || echo unknown)\"
  echo \"docker:\$(docker info > /dev/null 2>&1 && echo active || echo inactive)\"
  echo \"vault_key:\$(test -f ~/.openclaw/.vault_key && echo present || echo missing)\"
  echo \"config:\$(test -f ~/.openclaw/openclaw.json && echo present || echo missing)\"
" 2>/dev/null || echo "verify failed")

echo "${VERIFY}" | while IFS= read -r line; do
  log "  ${line}"
done

# ---------------------------------------------------------------------------
# 9. Insert into Supabase
# ---------------------------------------------------------------------------

log "Inserting VM record into Supabase..."

SUPABASE_RESPONSE=$(curl -sf -X POST \
  "${NEXT_PUBLIC_SUPABASE_URL}/rest/v1/instaclaw_vms" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d "{
    \"ip_address\": \"${SERVER_IP}\",
    \"name\": \"${VM_NAME}\",
    \"hetzner_server_id\": \"${SERVER_ID}\",
    \"ssh_port\": 22,
    \"ssh_user\": \"openclaw\",
    \"status\": \"ready\",
    \"region\": \"${REGION}\",
    \"server_type\": \"${SERVER_TYPE}\"
  }")

VM_DB_ID=$(echo "${SUPABASE_RESPONSE}" | jq -r '.[0].id // .id // "unknown"')

log "VM inserted into Supabase: ${VM_DB_ID}"

# ---------------------------------------------------------------------------
# 10. Success
# ---------------------------------------------------------------------------

TOTAL_TIME=${SECONDS}

echo ""
echo "=============================================="
echo -e "${GREEN} VM Provisioned Successfully!${NC}"
echo "=============================================="
echo ""
echo "  Name:        ${VM_NAME}"
echo "  IP:          ${SERVER_IP}"
echo "  Hetzner ID:  ${SERVER_ID}"
echo "  DB ID:       ${VM_DB_ID}"
echo "  SSH User:    openclaw"
echo "  Region:      ${REGION}"
echo "  Mode:        ${MODE}"
echo ""
echo "  SSH:         ssh -i ~/.ssh/instaclaw openclaw@${SERVER_IP}"
echo "  Status:      ready"
echo ""
echo "  Timing:      ${CONFIGURE_TIME}s configure, ${TOTAL_TIME}s total"
echo ""
echo "=============================================="
