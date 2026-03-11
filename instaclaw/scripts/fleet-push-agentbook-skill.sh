#!/bin/bash
#
# fleet-push-agentbook-skill.sh — Deploy AgentBook registration skill to existing VMs
#
# Pushes: SKILL.md, scripts/agentbook-check.py, scripts/agentbook-register.sh
# No API keys needed — AgentBook contract is public, relay is free.
#
# Usage:
#   fleet-push-agentbook-skill.sh --dry-run    — Preview deployment
#   fleet-push-agentbook-skill.sh --canary     — Deploy to first 3 VMs, pause for approval
#   fleet-push-agentbook-skill.sh --all        — Deploy to all active VMs
#
# MANDATORY: Always run --dry-run first, per CLAUDE.md rules.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILL_DIR="$PROJECT_ROOT/skills/agentbook"

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

fetch_vms() {
  curl -s "${SUPABASE_URL}/rest/v1/instaclaw_vms?gateway_token=not.is.null&status=neq.terminated&select=id,ip_address,ssh_user,name" \
    -H "apikey: $SUPABASE_KEY" \
    -H "Authorization: Bearer $SUPABASE_KEY"
}

deploy_to_vm() {
  local ip="$1" user="$2" vm_id="$3"

  echo "  Deploying to $vm_id ($user@$ip)..."

  local skill_md_b64 check_py_b64 register_sh_b64
  skill_md_b64=$(base64 < "$SKILL_DIR/SKILL.md")
  check_py_b64=$(base64 < "$SKILL_DIR/scripts/agentbook-check.py")
  register_sh_b64=$(base64 < "$SKILL_DIR/scripts/agentbook-register.sh")

  ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes -i "$SSH_KEY_FILE" "${user}@${ip}" bash -s <<REMOTE_SCRIPT
set -e

SKILL_DIR="\$HOME/.openclaw/skills/agentbook"
mkdir -p "\$SKILL_DIR/scripts" "\$HOME/scripts"

echo '$skill_md_b64' | base64 -d > "\$SKILL_DIR/SKILL.md"
echo '$check_py_b64' | base64 -d > "\$SKILL_DIR/scripts/agentbook-check.py"
echo '$register_sh_b64' | base64 -d > "\$SKILL_DIR/scripts/agentbook-register.sh"
echo '$check_py_b64' | base64 -d > "\$HOME/scripts/agentbook-check.py"
echo '$register_sh_b64' | base64 -d > "\$HOME/scripts/agentbook-register.sh"
chmod +x "\$HOME/scripts/agentbook-check.py" "\$HOME/scripts/agentbook-register.sh"

echo "  AgentBook skill deployed successfully"
REMOTE_SCRIPT

  echo "  done: $vm_id"
}

SUCCESS=0
FAILED=0

case "$MODE" in
  --dry-run)
    echo "=== DRY RUN: AgentBook Registration Skill Deployment ==="
    echo ""
    echo "Files to deploy:"
    echo "  SKILL.md                         -> ~/.openclaw/skills/agentbook/SKILL.md"
    echo "  scripts/agentbook-check.py       -> ~/.openclaw/skills/agentbook/scripts/agentbook-check.py"
    echo "                                   -> ~/scripts/agentbook-check.py"
    echo "  scripts/agentbook-register.sh    -> ~/.openclaw/skills/agentbook/scripts/agentbook-register.sh"
    echo "                                   -> ~/scripts/agentbook-register.sh"
    echo ""
    echo "No API keys or pip dependencies required."
    echo ""

    VMS=$(fetch_vms)
    COUNT=$(echo "$VMS" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
    echo "Active VMs: $COUNT"
    echo ""
    echo "Run with --canary to deploy to 3 VMs first, then --all for the rest."
    ;;

  --canary)
    echo "=== CANARY: Deploying to first 3 VMs ==="
    VMS=$(fetch_vms)

    echo "$VMS" | python3 -c "
import json, sys
vms = json.load(sys.stdin)
for v in vms[:3]:
    print(f\"{v['ip_address']} {v.get('ssh_user','openclaw')} {v['id']}\")
" 2>/dev/null | while read -r IP USER VM_ID; do
      if deploy_to_vm "$IP" "$USER" "$VM_ID"; then
        SUCCESS=$((SUCCESS + 1))
      else
        FAILED=$((FAILED + 1))
        echo "  FAILED: $VM_ID ($IP)" >&2
      fi
    done

    echo ""
    echo "=== CANARY COMPLETE ==="
    echo "Verify: ssh openclaw@<ip> 'ls ~/.openclaw/skills/agentbook/'"
    echo "If healthy, run: $0 --all"
    ;;

  --all)
    echo "=== FLEET DEPLOY: AgentBook Registration Skill ==="
    VMS=$(fetch_vms)

    echo "$VMS" | python3 -c "
import json, sys
vms = json.load(sys.stdin)
for v in vms:
    print(f\"{v['ip_address']} {v.get('ssh_user','openclaw')} {v['id']}\")
" 2>/dev/null | while read -r IP USER VM_ID; do
      if deploy_to_vm "$IP" "$USER" "$VM_ID"; then
        SUCCESS=$((SUCCESS + 1))
      else
        FAILED=$((FAILED + 1))
        echo "  FAILED: $VM_ID ($IP)" >&2
      fi
    done

    echo ""
    echo "=== FLEET DEPLOY COMPLETE (success=$SUCCESS, failed=$FAILED) ==="
    ;;

  --help|*)
    echo "fleet-push-agentbook-skill.sh — Deploy AgentBook registration skill to fleet"
    echo ""
    echo "Usage:"
    echo "  $0 --dry-run   — Preview deployment (ALWAYS run first)"
    echo "  $0 --canary    — Deploy to 3 VMs, verify, then --all"
    echo "  $0 --all       — Deploy to all active VMs"
    ;;
esac
