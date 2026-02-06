#!/usr/bin/env bash
# =============================================================================
# rebuild-snapshot.sh — Build a fresh InstaClaw base snapshot
#
# Usage:  ./scripts/rebuild-snapshot.sh
#
# What it does:
#   1. Creates a temporary VM from ubuntu-24.04
#   2. Runs install-openclaw.sh (full install)
#   3. Cleans the VM (logs, keys, history, etc.)
#   4. Powers off and creates a Hetzner snapshot
#   5. Deletes the temporary VM
#   6. Updates HETZNER_SNAPSHOT_ID in .env.local
#   7. Optionally deletes the old snapshot
#
# Run monthly to pick up security patches.
#
# Prerequisites:
#   - ssh-agent loaded with ~/.ssh/instaclaw key
#   - instaclaw/.env.local with HETZNER_API_TOKEN
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

: "${HETZNER_API_TOKEN:?Set HETZNER_API_TOKEN}"
: "${NEXT_PUBLIC_SUPABASE_URL:?Set NEXT_PUBLIC_SUPABASE_URL}"

HETZNER_BASE="https://api.hetzner.cloud/v1"
SSH_KEY_PATH="${HOME}/.ssh/instaclaw"
SSH_OPTS="-o ConnectTimeout=10 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"
OLD_SNAPSHOT_ID="${HETZNER_SNAPSHOT_ID:-}"
TEMP_VM_NAME="instaclaw-snapshot-builder-$(date +%s)"
TODAY=$(date +%Y-%m-%d)

hetzner() {
  curl -sf --connect-timeout 10 --max-time 30 "$@" -H "Authorization: Bearer ${HETZNER_API_TOKEN}"
}

# ---------------------------------------------------------------------------
# 1. Ensure ssh-agent
# ---------------------------------------------------------------------------

if [[ -z "${SSH_AUTH_SOCK:-}" ]]; then
  eval "$(ssh-agent -s)"
fi
if ! ssh-add -l 2>/dev/null | grep -qi instaclaw; then
  ssh-add "${SSH_KEY_PATH}"
fi

# ---------------------------------------------------------------------------
# 2. Look up Hetzner IDs
# ---------------------------------------------------------------------------

log "Looking up Hetzner resource IDs..."

SSH_KEY_ID=$(hetzner "${HETZNER_BASE}/ssh_keys" | jq -r '.ssh_keys[] | select(.name=="instaclaw-deploy") | .id')
FIREWALL_ID=$(hetzner "${HETZNER_BASE}/firewalls" | jq -r '.firewalls[] | select(.name=="instaclaw-firewall") | .id')

[[ -n "${SSH_KEY_ID}" && "${SSH_KEY_ID}" != "null" ]] || fail "SSH key not found"
[[ -n "${FIREWALL_ID}" && "${FIREWALL_ID}" != "null" ]] || fail "Firewall not found"

log "SSH Key: ${SSH_KEY_ID}, Firewall: ${FIREWALL_ID}"

# ---------------------------------------------------------------------------
# 3. Create temporary VM
# ---------------------------------------------------------------------------

log "Creating temporary VM '${TEMP_VM_NAME}'..."

RESPONSE=$(hetzner -X POST "${HETZNER_BASE}/servers" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"${TEMP_VM_NAME}\",
    \"server_type\": \"cpx21\",
    \"image\": \"ubuntu-24.04\",
    \"location\": \"ash\",
    \"ssh_keys\": [${SSH_KEY_ID}],
    \"firewalls\": [{\"firewall\": ${FIREWALL_ID}}]
  }")

SERVER_ID=$(echo "${RESPONSE}" | jq -r '.server.id')
[[ -n "${SERVER_ID}" && "${SERVER_ID}" != "null" ]] || fail "Failed to create VM: $(echo "${RESPONSE}" | jq -r '.error.message // "unknown"')"

log "Temp VM created: ID=${SERVER_ID}"

# ---------------------------------------------------------------------------
# 4. Wait for server
# ---------------------------------------------------------------------------

log "Waiting for server to boot..."

for _ in $(seq 1 24); do
  STATUS=$(hetzner "${HETZNER_BASE}/servers/${SERVER_ID}" | jq -r '.server.status')
  [[ "${STATUS}" == "running" ]] && break
  sleep 5
done

SERVER_IP=$(hetzner "${HETZNER_BASE}/servers/${SERVER_ID}" | jq -r '.server.public_net.ipv4.ip')
log "Server running: ${SERVER_IP}"

# ---------------------------------------------------------------------------
# 5. Wait for SSH and run install-openclaw.sh
# ---------------------------------------------------------------------------

log "Waiting for SSH..."

for _ in $(seq 1 24); do
  # shellcheck disable=SC2086
  ssh ${SSH_OPTS} "root@${SERVER_IP}" "echo ok" 2>/dev/null && break
  sleep 5
done

log "Uploading and running install-openclaw.sh (3-5 min)..."

# shellcheck disable=SC2086
scp ${SSH_OPTS} "${SCRIPT_DIR}/install-openclaw.sh" "root@${SERVER_IP}:/root/install-openclaw.sh"
# shellcheck disable=SC2086
ssh ${SSH_OPTS} "root@${SERVER_IP}" "bash /root/install-openclaw.sh"

log "Install complete."

# ---------------------------------------------------------------------------
# 6. Clean the VM for snapshotting
# ---------------------------------------------------------------------------

log "Cleaning VM for snapshot..."

# After SSH hardening, root is locked out. Use openclaw + docker nsenter.
# shellcheck disable=SC2086
ssh ${SSH_OPTS} "openclaw@${SERVER_IP}" "
docker run --rm --privileged --pid=host alpine:3.19 nsenter -t 1 -m -u -i -n -- bash -c '
# Logs
journalctl --vacuum-time=1s 2>/dev/null || true
find /var/log -type f -name \"*.log\" -exec truncate -s 0 {} \; 2>/dev/null || true
find /var/log -type f -name \"*.gz\" -delete 2>/dev/null || true
find /var/log -type f -name \"*.[0-9]\" -delete 2>/dev/null || true
truncate -s 0 /var/log/wtmp /var/log/btmp /var/log/lastlog 2>/dev/null || true

# History
for d in /root /home/*; do rm -f \"\$d/.bash_history\" \"\$d/.lesshst\" \"\$d/.viminfo\" 2>/dev/null; done

# Per-VM secrets
rm -f /home/openclaw/.openclaw/.vault_key
rm -f /home/openclaw/.openclaw/openclaw.json

# SSH host keys
rm -f /etc/ssh/ssh_host_*

# Cloud-init
rm -rf /var/lib/cloud/instances/* 2>/dev/null || true
truncate -s 0 /etc/machine-id 2>/dev/null || true

# Apt cache
apt-get clean -y 2>/dev/null || true
rm -rf /var/lib/apt/lists/*

# Temp
rm -rf /tmp/* /var/tmp/* 2>/dev/null || true
rm -f /root/install-openclaw.sh 2>/dev/null || true
'
"

log "VM cleaned."

# ---------------------------------------------------------------------------
# 7. Power off and snapshot
# ---------------------------------------------------------------------------

log "Powering off..."

hetzner -X POST "${HETZNER_BASE}/servers/${SERVER_ID}/actions/poweroff" \
  -H "Content-Type: application/json" > /dev/null

for _ in $(seq 1 12); do
  STATUS=$(hetzner "${HETZNER_BASE}/servers/${SERVER_ID}" | jq -r '.server.status')
  [[ "${STATUS}" == "off" ]] && break
  sleep 5
done

log "Creating snapshot..."

SNAP_RESPONSE=$(hetzner -X POST "${HETZNER_BASE}/servers/${SERVER_ID}/actions/create_image" \
  -H "Content-Type: application/json" \
  -d "{
    \"description\": \"instaclaw-base-${TODAY}\",
    \"type\": \"snapshot\",
    \"labels\": {\"purpose\": \"instaclaw-base\", \"created\": \"${TODAY}\"}
  }")

NEW_SNAPSHOT_ID=$(echo "${SNAP_RESPONSE}" | jq -r '.image.id')
[[ -n "${NEW_SNAPSHOT_ID}" && "${NEW_SNAPSHOT_ID}" != "null" ]] || fail "Snapshot creation failed"

log "Snapshot creating: ID=${NEW_SNAPSHOT_ID}"

for _ in $(seq 1 30); do
  STATUS=$(hetzner "${HETZNER_BASE}/images/${NEW_SNAPSHOT_ID}" | jq -r '.image.status')
  [[ "${STATUS}" == "available" ]] && break
  sleep 10
done

log "Snapshot ready: ${NEW_SNAPSHOT_ID}"

# ---------------------------------------------------------------------------
# 8. Delete temporary VM
# ---------------------------------------------------------------------------

log "Deleting temporary VM..."

hetzner -X DELETE "${HETZNER_BASE}/servers/${SERVER_ID}" > /dev/null
log "Temporary VM deleted."

# ---------------------------------------------------------------------------
# 9. Update .env.local
# ---------------------------------------------------------------------------

log "Updating HETZNER_SNAPSHOT_ID in .env.local..."

if grep -q "^HETZNER_SNAPSHOT_ID=" "${ENV_FILE}"; then
  sed -i.bak "s/^HETZNER_SNAPSHOT_ID=.*/HETZNER_SNAPSHOT_ID=${NEW_SNAPSHOT_ID}/" "${ENV_FILE}"
  rm -f "${ENV_FILE}.bak"
else
  echo "HETZNER_SNAPSHOT_ID=${NEW_SNAPSHOT_ID}" >> "${ENV_FILE}"
fi

log "HETZNER_SNAPSHOT_ID=${NEW_SNAPSHOT_ID}"

# ---------------------------------------------------------------------------
# 10. Optionally delete old snapshot
# ---------------------------------------------------------------------------

if [[ -n "${OLD_SNAPSHOT_ID}" && "${OLD_SNAPSHOT_ID}" != "${NEW_SNAPSHOT_ID}" ]]; then
  log "Deleting old snapshot ${OLD_SNAPSHOT_ID}..."
  hetzner -X DELETE "${HETZNER_BASE}/images/${OLD_SNAPSHOT_ID}" > /dev/null 2>&1 || true
  log "Old snapshot deleted."
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

echo ""
echo "=============================================="
echo -e "${GREEN} Snapshot Rebuilt!${NC}"
echo "=============================================="
echo "  New Snapshot ID:  ${NEW_SNAPSHOT_ID}"
echo "  Description:      instaclaw-base-${TODAY}"
echo "  .env.local:       Updated"
if [[ -n "${OLD_SNAPSHOT_ID}" ]]; then
echo "  Old Snapshot:     ${OLD_SNAPSHOT_ID} (deleted)"
fi
echo ""
echo "  Don't forget to update Vercel env vars:"
echo "    HETZNER_SNAPSHOT_ID=${NEW_SNAPSHOT_ID}"
echo ""
echo "=============================================="
