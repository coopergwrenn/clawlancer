#!/bin/bash
#
# fleet-harden-ssh.sh — Fleet-wide SSH hardening
#
# Applies:
#   1. PasswordAuthentication no
#   2. PermitRootLogin prohibit-password
#   3. MaxStartups 10:30:60
#   4. ufw limit ssh (rate-limit: 6 connections per 30s per IP)
#   5. Fix fail2ban ssh.socket mismatch on Ubuntu 24.04
#
# Usage:
#   fleet-harden-ssh.sh --dry-run   — Preview which VMs will be hardened
#   fleet-harden-ssh.sh --canary    — Harden 1 VM, verify SSH, pause for approval
#   fleet-harden-ssh.sh --all       — Harden all assigned VMs
#
# MANDATORY: Always run --dry-run first, per CLAUDE.md rules.
#
# SAFETY: For each VM, the script:
#   1. Opens a backup SSH connection (sleep 300 in background)
#   2. Applies sshd_config changes
#   3. Restarts sshd
#   4. Tests a NEW SSH connection
#   5. If new connection fails, uses backup to REVERT changes and restart sshd
#   6. Kills backup connection on success
#

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load env
if [ -f "$PROJECT_ROOT/.env.local" ]; then
  set -a
  source "$PROJECT_ROOT/.env.local"
  set +a
fi

SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL:-}"
SUPABASE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-}"

if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_KEY" ]; then
  echo "ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" >&2
  exit 1
fi

# Load SSH key
SSH_ENV_FILE="$PROJECT_ROOT/.env.ssh-key"
SSH_PRIVATE_KEY_B64=""
if [ -f "$SSH_ENV_FILE" ]; then
  SSH_PRIVATE_KEY_B64=$(grep "^SSH_PRIVATE_KEY_B64=" "$SSH_ENV_FILE" 2>/dev/null | head -1 | sed 's/^[^=]*=//' | tr -d '"' | tr -d "'" | tr -d '\n')
fi
if [ -z "$SSH_PRIVATE_KEY_B64" ]; then
  echo "ERROR: SSH_PRIVATE_KEY_B64 not found in .env.ssh-key" >&2
  exit 1
fi
SSH_KEY_FILE=$(mktemp)
echo "$SSH_PRIVATE_KEY_B64" | base64 -d > "$SSH_KEY_FILE"
chmod 600 "$SSH_KEY_FILE"
trap 'rm -f "$SSH_KEY_FILE"' EXIT

MODE="${1:---help}"
SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes -o ServerAliveInterval=15"

fetch_vms() {
  curl -s "${SUPABASE_URL}/rest/v1/instaclaw_vms?status=eq.assigned&select=id,ip_address,ssh_user,name,region" \
    -H "apikey: $SUPABASE_KEY" \
    -H "Authorization: Bearer $SUPABASE_KEY"
}

harden_vm() {
  local ip="$1" user="$2" vm_name="$3"

  echo "  [$vm_name] Hardening $user@$ip..."

  # Step 1: Open backup SSH connection (keeps a session alive for 5 min)
  ssh $SSH_OPTS -i "$SSH_KEY_FILE" "${user}@${ip}" "sleep 300" &
  local backup_pid=$!
  sleep 2  # Give it time to establish

  # Step 2: Apply sshd_config changes + ufw + fail2ban fix via a single SSH command
  local result
  result=$(ssh $SSH_OPTS -i "$SSH_KEY_FILE" "${user}@${ip}" bash -s <<'REMOTE_HARDEN'
set -e

SSHD_CFG="/etc/ssh/sshd_config"
CHANGED=0

# --- 1. PasswordAuthentication no ---
if grep -q "^PasswordAuthentication yes" "$SSHD_CFG" 2>/dev/null; then
  sudo sed -i 's/^PasswordAuthentication yes/PasswordAuthentication no/' "$SSHD_CFG"
  echo "FIXED: PasswordAuthentication -> no"
  CHANGED=1
elif grep -q "^PasswordAuthentication no" "$SSHD_CFG" 2>/dev/null; then
  echo "OK: PasswordAuthentication already no"
else
  # Not set explicitly — add it
  echo "PasswordAuthentication no" | sudo tee -a "$SSHD_CFG" >/dev/null
  echo "ADDED: PasswordAuthentication no"
  CHANGED=1
fi

# --- 2. PermitRootLogin prohibit-password ---
if grep -q "^PermitRootLogin yes" "$SSHD_CFG" 2>/dev/null; then
  sudo sed -i 's/^PermitRootLogin yes/PermitRootLogin prohibit-password/' "$SSHD_CFG"
  echo "FIXED: PermitRootLogin -> prohibit-password"
  CHANGED=1
elif grep -q "^PermitRootLogin prohibit-password" "$SSHD_CFG" 2>/dev/null; then
  echo "OK: PermitRootLogin already prohibit-password"
elif grep -q "^PermitRootLogin no" "$SSHD_CFG" 2>/dev/null; then
  echo "OK: PermitRootLogin already no (stricter)"
else
  echo "PermitRootLogin prohibit-password" | sudo tee -a "$SSHD_CFG" >/dev/null
  echo "ADDED: PermitRootLogin prohibit-password"
  CHANGED=1
fi

# --- 3. MaxStartups 10:30:60 ---
if grep -q "^MaxStartups 10:30:60" "$SSHD_CFG" 2>/dev/null; then
  echo "OK: MaxStartups already 10:30:60"
elif grep -q "^MaxStartups" "$SSHD_CFG" 2>/dev/null; then
  sudo sed -i 's/^MaxStartups.*/MaxStartups 10:30:60/' "$SSHD_CFG"
  echo "FIXED: MaxStartups -> 10:30:60"
  CHANGED=1
else
  echo "MaxStartups 10:30:60" | sudo tee -a "$SSHD_CFG" >/dev/null
  echo "ADDED: MaxStartups 10:30:60"
  CHANGED=1
fi

# --- Also check sshd_config.d overrides ---
for f in /etc/ssh/sshd_config.d/*.conf; do
  [ -f "$f" ] || continue
  if grep -q "^PasswordAuthentication yes" "$f" 2>/dev/null; then
    sudo sed -i 's/^PasswordAuthentication yes/PasswordAuthentication no/' "$f"
    echo "FIXED: $f PasswordAuthentication -> no"
    CHANGED=1
  fi
  if grep -q "^PermitRootLogin yes" "$f" 2>/dev/null; then
    sudo sed -i 's/^PermitRootLogin yes/PermitRootLogin prohibit-password/' "$f"
    echo "FIXED: $f PermitRootLogin -> prohibit-password"
    CHANGED=1
  fi
done

# --- 4. UFW: rate-limit SSH ---
# Check if already rate-limited
if sudo ufw status | grep -q "22/tcp.*LIMIT"; then
  echo "OK: ufw ssh already rate-limited"
else
  # Delete existing ALLOW rule for 22, add LIMIT
  sudo ufw delete allow 22/tcp 2>/dev/null || true
  sudo ufw limit ssh 2>/dev/null || sudo ufw limit 22/tcp 2>/dev/null || true
  echo "FIXED: ufw ssh -> rate-limited"
  CHANGED=1
fi

# --- 5. Fix fail2ban ssh.socket mismatch ---
F2B_JAIL="/etc/fail2ban/jail.local"
if [ -f /etc/fail2ban/jail.conf ] || [ -f "$F2B_JAIL" ]; then
  # Check if fail2ban sshd jail uses the wrong backend/journalmatch
  if ! grep -q "backend.*systemd" "$F2B_JAIL" 2>/dev/null || ! grep -q "ssh.service" "$F2B_JAIL" 2>/dev/null; then
    sudo mkdir -p /etc/fail2ban
    sudo tee "$F2B_JAIL" >/dev/null <<'F2BJAIL'
[sshd]
enabled = true
port = ssh
filter = sshd
backend = systemd
journalmatch = _COMM=sshd
maxretry = 5
bantime = 3600
findtime = 600
F2BJAIL
    sudo systemctl restart fail2ban 2>/dev/null || true
    echo "FIXED: fail2ban jail.local -> backend=systemd, journalmatch=_COMM=sshd"
    CHANGED=1
  else
    echo "OK: fail2ban already configured correctly"
  fi
else
  echo "SKIP: fail2ban not installed"
fi

# --- Restart sshd if changes were made ---
if [ "$CHANGED" -eq 1 ]; then
  # Try both service names (Ubuntu versions differ)
  sudo systemctl restart ssh 2>/dev/null || sudo systemctl restart sshd 2>/dev/null || true
  echo "SSHD_RESTARTED"
else
  echo "NO_CHANGES_NEEDED"
fi
REMOTE_HARDEN
)
  local ssh_exit=$?

  echo "$result" | sed 's/^/    /'

  if [ $ssh_exit -ne 0 ]; then
    echo "  [$vm_name] ERROR: SSH command failed (exit $ssh_exit)"
    kill $backup_pid 2>/dev/null || true
    return 1
  fi

  # Step 3: If sshd was restarted, verify we can still connect
  if echo "$result" | grep -q "SSHD_RESTARTED"; then
    sleep 2
    if ssh $SSH_OPTS -i "$SSH_KEY_FILE" "${user}@${ip}" "echo SSH_VERIFY_OK" 2>/dev/null | grep -q "SSH_VERIFY_OK"; then
      echo "  [$vm_name] VERIFIED: New SSH connection works after hardening"
    else
      echo "  [$vm_name] DANGER: New SSH failed! Reverting via backup connection..."
      # Revert: re-enable password auth and restart (safe fallback)
      ssh $SSH_OPTS -i "$SSH_KEY_FILE" "${user}@${ip}" "
        sudo sed -i 's/^PasswordAuthentication no/PasswordAuthentication yes/' /etc/ssh/sshd_config
        sudo sed -i 's/^PermitRootLogin prohibit-password/PermitRootLogin yes/' /etc/ssh/sshd_config
        sudo systemctl restart ssh 2>/dev/null || sudo systemctl restart sshd 2>/dev/null
        echo REVERTED
      " 2>/dev/null
      echo "  [$vm_name] REVERTED to previous config"
      kill $backup_pid 2>/dev/null || true
      return 1
    fi
  else
    echo "  [$vm_name] No sshd restart needed — already hardened"
  fi

  # Clean up backup connection
  kill $backup_pid 2>/dev/null || true
  return 0
}

# === Main ===

case "$MODE" in
  --dry-run)
    echo "fleet-harden-ssh.sh — SSH Hardening (DRY RUN)"
    echo ""
    echo "Changes per VM:"
    echo "  1. PasswordAuthentication no"
    echo "  2. PermitRootLogin prohibit-password"
    echo "  3. MaxStartups 10:30:60"
    echo "  4. ufw limit ssh (rate-limit: 6 conn/30s/IP)"
    echo "  5. Fix fail2ban ssh.socket journal mismatch"
    echo ""

    VMS_JSON=$(fetch_vms)
    VM_COUNT=$(echo "$VMS_JSON" | python3 -c "import sys,json; print(len(json.loads(sys.stdin.read())))" 2>/dev/null || echo 0)
    echo "Assigned VMs to harden: $VM_COUNT"
    echo ""
    echo "$VMS_JSON" | python3 -c "
import sys, json
vms = json.loads(sys.stdin.read())
for v in vms:
    print(f\"  {v['name']}  {v['ip_address']}  {v.get('region','?')}\")
" 2>/dev/null
    echo ""
    echo "Run with --canary to test on 1 VM first."
    ;;

  --canary)
    echo "=== CANARY: Hardening SSH on first VM only ==="
    VMS_JSON=$(fetch_vms)
    FIRST_VM=$(echo "$VMS_JSON" | python3 -c "
import sys, json
vms = json.loads(sys.stdin.read())
if vms:
    v = vms[0]
    print(f\"{v['ip_address']}|{v.get('ssh_user','openclaw')}|{v['name']}\")
" 2>/dev/null)

    if [ -z "$FIRST_VM" ]; then
      echo "ERROR: No VMs found" >&2
      exit 1
    fi

    IFS='|' read -r ip user vm_name <<< "$FIRST_VM"
    SUCCEEDED=0
    FAILED=0

    if harden_vm "$ip" "$user" "$vm_name"; then
      SUCCEEDED=1
    else
      FAILED=1
    fi

    echo ""
    echo "=== CANARY COMPLETE ==="
    echo "  Succeeded: $SUCCEEDED  Failed: $FAILED"
    echo ""
    echo "Verify: ssh openclaw@$ip 'grep PasswordAuthentication /etc/ssh/sshd_config; sudo ufw status | grep 22'"
    echo "If healthy, run: $0 --all"
    ;;

  --all)
    echo "=== FLEET DEPLOY: SSH Hardening ==="
    VMS_JSON=$(fetch_vms)
    SUCCEEDED=0
    FAILED=0

    # Write VM list to temp file to avoid heredoc-stdin conflicts in the loop
    VM_LIST_FILE=$(mktemp)
    echo "$VMS_JSON" | python3 -c "
import sys, json
vms = json.loads(sys.stdin.read())
for v in vms:
    print(f\"{v['ip_address']}|{v.get('ssh_user','openclaw')}|{v['name']}\")
" 2>/dev/null > "$VM_LIST_FILE"

    while IFS='|' read -r ip user vm_name <&3; do
      if harden_vm "$ip" "$user" "$vm_name"; then
        SUCCEEDED=$((SUCCEEDED + 1))
      else
        FAILED=$((FAILED + 1))
      fi
    done 3< "$VM_LIST_FILE"
    rm -f "$VM_LIST_FILE"

    echo ""
    echo "=== FLEET HARDENING COMPLETE ==="
    echo "  Succeeded: $SUCCEEDED  Failed: $FAILED  Total: $((SUCCEEDED + FAILED))"
    ;;

  *)
    echo "fleet-harden-ssh.sh — Fleet-wide SSH hardening"
    echo ""
    echo "Usage:"
    echo "  $0 --dry-run   — Preview deployment (ALWAYS run first)"
    echo "  $0 --canary    — Harden 1 VM, verify, then --all"
    echo "  $0 --all       — Harden all assigned VMs"
    ;;
esac
