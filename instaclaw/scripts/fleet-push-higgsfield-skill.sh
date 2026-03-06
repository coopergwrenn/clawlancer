#!/usr/bin/env bash
# fleet-push-higgsfield-skill.sh — Deploy Higgsfield AI Video skill to fleet
#
# Usage:
#   ./instaclaw/scripts/fleet-push-higgsfield-skill.sh --dry-run   # Preview what would happen
#   ./instaclaw/scripts/fleet-push-higgsfield-skill.sh --canary     # Deploy to 1 VM, pause for approval
#   ./instaclaw/scripts/fleet-push-higgsfield-skill.sh --all        # Deploy to all VMs
#
# Deploys as DISABLED (.disabled suffix). Users enable via dashboard.

set -euo pipefail

MODE="${1:---dry-run}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILL_DIR="$REPO_ROOT/skills/higgsfield-video"

# ── Load environment ──────────────────────────────────────────────────────────
ENV_FILE="$REPO_ROOT/.env.local"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found"
  exit 1
fi

SUPABASE_URL=$(grep '^NEXT_PUBLIC_SUPABASE_URL=' "$ENV_FILE" | cut -d= -f2- | tr -d '"')
SUPABASE_KEY=$(grep '^SUPABASE_SERVICE_ROLE_KEY=' "$ENV_FILE" | cut -d= -f2- | tr -d '"')

if [[ -z "$SUPABASE_URL" || -z "$SUPABASE_KEY" ]]; then
  echo "ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local"
  exit 1
fi

# ── Load SSH key ──────────────────────────────────────────────────────────────
SSH_ENV_FILE="$REPO_ROOT/.env.ssh-key"
if [[ ! -f "$SSH_ENV_FILE" ]]; then
  echo "ERROR: $SSH_ENV_FILE not found"
  exit 1
fi

SSH_PRIVATE_KEY_B64=$(grep "^SSH_PRIVATE_KEY_B64=" "$SSH_ENV_FILE" 2>/dev/null | head -1 | sed 's/^[^=]*=//' | tr -d '"' | tr -d "'" | tr -d '\n')
if [[ -z "$SSH_PRIVATE_KEY_B64" ]]; then
  echo "ERROR: SSH_PRIVATE_KEY_B64 not found in .env.ssh-key"
  exit 1
fi
TEMP_KEY=$(mktemp)
echo "$SSH_PRIVATE_KEY_B64" | base64 -d > "$TEMP_KEY"
chmod 600 "$TEMP_KEY"
trap 'rm -f "$TEMP_KEY"' EXIT

# ── Fetch VMs ─────────────────────────────────────────────────────────────────
fetch_vms() {
  curl -s \
    -H "apikey: $SUPABASE_KEY" \
    -H "Authorization: Bearer $SUPABASE_KEY" \
    "$SUPABASE_URL/rest/v1/instaclaw_vms?status=neq.terminated&select=id,ip_address,ssh_user,gateway_token" \
    | python3 -c "import sys,json; vms=json.load(sys.stdin); [print(f\"{v['id']}|{v['ip_address']}|{v.get('ssh_user','root')}|{v.get('gateway_token','')}\") for v in vms if v.get('ip_address')]"
}

# ── Collect files to deploy ───────────────────────────────────────────────────
SKILL_FILES=(
  "SKILL.md"
  "scripts/higgsfield-setup.py"
  "scripts/higgsfield-generate.py"
  "scripts/higgsfield-character.py"
  "scripts/higgsfield-story.py"
  "scripts/higgsfield-audio.py"
  "scripts/higgsfield-edit.py"
  "scripts/higgsfield-status.py"
  "references/muapi-api.md"
  "references/cinema-controls.md"
  "references/model-selection-guide.md"
  "references/character-consistency.md"
  "references/storytelling-patterns.md"
  "references/safety-patterns.md"
)

# ── Deploy to a single VM ────────────────────────────────────────────────────
deploy_to_vm() {
  local vm_id="$1" ip="$2" ssh_user="$3"
  echo "  Deploying to $ip (VM $vm_id)..."

  # Build deploy script with base64-encoded files
  local deploy_script="#!/bin/bash
set -eo pipefail
HF_DIR=\"\$HOME/.openclaw/skills/higgsfield-video.disabled\"
mkdir -p \"\$HF_DIR/scripts\" \"\$HF_DIR/references\" \"\$HOME/.openclaw/workspace/higgsfield\"
"

  for f in "${SKILL_FILES[@]}"; do
    local local_path="$SKILL_DIR/$f"
    if [[ ! -f "$local_path" ]]; then
      echo "    WARNING: $local_path not found, skipping"
      continue
    fi
    local b64
    b64=$(base64 < "$local_path")
    deploy_script+="echo '$b64' | base64 -d > \"\$HF_DIR/$f\"
"
  done

  # chmod scripts
  deploy_script+='chmod +x "$HF_DIR/scripts/"*.py
echo "HIGGSFIELD_DEPLOY_DONE"
'

  ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o ServerAliveInterval=5 \
    -i "$TEMP_KEY" "$ssh_user@$ip" bash <<< "$deploy_script" 2>/dev/null

  if [[ $? -eq 0 ]]; then
    echo "    OK: $ip"
  else
    echo "    FAIL: $ip"
    return 1
  fi
}

# ── Mode switch ───────────────────────────────────────────────────────────────
case "$MODE" in
  --dry-run)
    echo "=== DRY RUN ==="
    echo ""
    echo "Files to deploy (as .disabled):"
    for f in "${SKILL_FILES[@]}"; do
      local_path="$SKILL_DIR/$f"
      if [[ -f "$local_path" ]]; then
        size=$(wc -c < "$local_path" | tr -d ' ')
        echo "  $f ($size bytes)"
      else
        echo "  $f (MISSING!)"
      fi
    done
    echo ""
    echo "Directories created on VM:"
    echo "  ~/.openclaw/skills/higgsfield-video.disabled/scripts/"
    echo "  ~/.openclaw/skills/higgsfield-video.disabled/references/"
    echo "  ~/.openclaw/workspace/higgsfield/"
    echo ""
    echo "No pip dependencies needed (pure stdlib Python)."
    echo ""
    echo "Fetching VM count..."
    VM_COUNT=$(fetch_vms | wc -l | tr -d ' ')
    echo "VMs to deploy: $VM_COUNT"
    echo ""
    echo "Run with --canary to deploy to 1 VM first."
    ;;

  --canary)
    echo "=== CANARY DEPLOY ==="
    CANARY_IP="${CANARY_IP:-}"

    if [[ -n "$CANARY_IP" ]]; then
      echo "Using CANARY_IP=$CANARY_IP"
      deploy_to_vm "canary" "$CANARY_IP" "root"
    else
      echo "Selecting first VM as canary..."
      FIRST_VM=$(fetch_vms | head -1)
      if [[ -z "$FIRST_VM" ]]; then
        echo "ERROR: No VMs found"
        exit 1
      fi
      IFS='|' read -r vm_id ip ssh_user _token <<< "$FIRST_VM"
      deploy_to_vm "$vm_id" "$ip" "$ssh_user"
    fi

    echo ""
    echo "Canary deploy complete. Verify on the VM, then run --all."
    echo "Press Enter to continue or Ctrl+C to abort..."
    read -r
    ;;

  --all)
    echo "=== FULL FLEET DEPLOY ==="
    echo "Fetching VMs..."
    VMS=$(fetch_vms)
    TOTAL=$(echo "$VMS" | wc -l | tr -d ' ')
    echo "Deploying to $TOTAL VMs..."
    echo ""

    SUCCESS=0
    FAIL=0
    while IFS='|' read -r vm_id ip ssh_user _token; do
      if deploy_to_vm "$vm_id" "$ip" "$ssh_user"; then
        ((SUCCESS++))
      else
        ((FAIL++))
      fi
    done <<< "$VMS"

    echo ""
    echo "=== DONE ==="
    echo "Success: $SUCCESS / $TOTAL"
    if [[ $FAIL -gt 0 ]]; then
      echo "Failed: $FAIL"
    fi
    ;;

  *)
    echo "Usage: $0 --dry-run | --canary | --all"
    exit 1
    ;;
esac
