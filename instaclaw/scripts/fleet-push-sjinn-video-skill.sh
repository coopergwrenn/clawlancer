#!/bin/bash
#
# fleet-push-sjinn-video-skill.sh — Deploy Sjinn AI Video Production skill to existing VMs
#
# Pushes: SKILL.md, sjinn-api.md, video-prompting.md, video-production-pipeline.md,
#          setup-sjinn-video.sh to all active VMs. Removes old SJINN_API_KEY (now server-side only).
#
# Usage:
#   fleet-push-sjinn-video-skill.sh --dry-run          — Preview what would be deployed
#   fleet-push-sjinn-video-skill.sh --canary            — Deploy to 1 VM, pause for approval
#   fleet-push-sjinn-video-skill.sh --all               — Deploy to all active VMs
#
# Requires:
#   - SUPABASE_SERVICE_ROLE_KEY in .env.local
#   - SSH access to VMs (keys in ~/.ssh/)
#
# MANDATORY: Always run --dry-run first, per CLAUDE.md rules.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILL_DIR="$PROJECT_ROOT/skills/sjinn-video"

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
  SSH_PRIVATE_KEY_B64="${SSH_PRIVATE_KEY_B64:-}"
fi
if [ -z "$SSH_PRIVATE_KEY_B64" ]; then
  echo "ERROR: SSH_PRIVATE_KEY_B64 not found in .env.ssh-key or environment" >&2
  exit 1
fi
SSH_KEY_FILE=$(mktemp)
echo "$SSH_PRIVATE_KEY_B64" | base64 -d > "$SSH_KEY_FILE"
chmod 600 "$SSH_KEY_FILE"
trap 'rm -f "$SSH_KEY_FILE"' EXIT

MODE="${1:---help}"

# Fetch active VMs
fetch_vms() {
  curl -s "${SUPABASE_URL}/rest/v1/instaclaw_vms?assigned_to=not.is.null&select=id,ip_address,ssh_user,name,hostname" \
    -H "apikey: $SUPABASE_KEY" \
    -H "Authorization: Bearer $SUPABASE_KEY"
}

deploy_to_vm() {
  local ip="$1" user="$2" vm_id="$3"

  echo "  Deploying to $vm_id ($user@$ip)..."

  # Read and base64-encode skill files
  local skill_md_b64 api_ref_b64 prompting_b64 pipeline_b64 setup_b64
  skill_md_b64=$(base64 < "$SKILL_DIR/SKILL.md")
  api_ref_b64=$(base64 < "$SKILL_DIR/references/sjinn-api.md")
  prompting_b64=$(base64 < "$SKILL_DIR/references/video-prompting.md")
  pipeline_b64=$(base64 < "$SKILL_DIR/references/video-production-pipeline.md")
  setup_b64=$(base64 < "$SKILL_DIR/scripts/setup-sjinn-video.sh")

  ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes -i "$SSH_KEY_FILE" "${user}@${ip}" bash -s <<REMOTE_SCRIPT
set -e

# Create directories
SKILL_DIR="\$HOME/.openclaw/skills/sjinn-video"
mkdir -p "\$SKILL_DIR/references" "\$SKILL_DIR/scripts" "\$HOME/scripts"
mkdir -p "\$HOME/workspace/videos" "\$HOME/workspace/tmp-media" "\$HOME/memory"

# Deploy skill files
echo '$skill_md_b64' | base64 -d > "\$SKILL_DIR/SKILL.md"
echo '$api_ref_b64' | base64 -d > "\$SKILL_DIR/references/sjinn-api.md"
echo '$prompting_b64' | base64 -d > "\$SKILL_DIR/references/video-prompting.md"
echo '$pipeline_b64' | base64 -d > "\$SKILL_DIR/references/video-production-pipeline.md"
echo '$setup_b64' | base64 -d > "\$HOME/scripts/setup-sjinn-video.sh"
chmod +x "\$HOME/scripts/setup-sjinn-video.sh"

# Remove old SJINN_API_KEY (now server-side only via proxy)
sed -i '/^SJINN_API_KEY=/d' "\$HOME/.openclaw/.env" 2>/dev/null || true

# Run setup script
bash "\$HOME/scripts/setup-sjinn-video.sh" 2>/dev/null || true

# Clean up old Kling skill if it exists
rm -rf "\$HOME/.openclaw/skills/kling-ai-video" 2>/dev/null || true

# Update Caddy config to add /tmp-media/ handler if Caddy is running
if command -v caddy &>/dev/null && [ -f /etc/caddy/Caddyfile ]; then
  if ! grep -q "tmp-media" /etc/caddy/Caddyfile 2>/dev/null; then
    # Insert tmp-media handler before reverse_proxy line
    sudo sed -i '/reverse_proxy/i\  handle /tmp-media/* {\n    root * /home/openclaw/workspace\n    file_server\n  }' /etc/caddy/Caddyfile 2>/dev/null || true
    sudo systemctl reload caddy 2>/dev/null || true
    echo "  Updated Caddy config with /tmp-media/ handler"
  fi
fi

echo "  Sjinn video skill deployed successfully"
REMOTE_SCRIPT

  echo "  ✓ $vm_id done"
}

case "$MODE" in
  --dry-run)
    echo "=== DRY RUN: Sjinn AI Video Production Skill Deployment ==="
    echo ""
    echo "Files to deploy:"
    echo "  SKILL.md                        → ~/.openclaw/skills/sjinn-video/SKILL.md"
    echo "  sjinn-api.md                    → ~/.openclaw/skills/sjinn-video/references/sjinn-api.md"
    echo "  video-prompting.md              → ~/.openclaw/skills/sjinn-video/references/video-prompting.md"
    echo "  video-production-pipeline.md    → ~/.openclaw/skills/sjinn-video/references/video-production-pipeline.md"
    echo "  setup-sjinn-video.sh            → ~/scripts/setup-sjinn-video.sh"
    echo ""
    echo "Actions:"
    echo "  - Removes SJINN_API_KEY from VM .env (now server-side only via proxy)"
    echo "  - Remove old kling-ai-video skill directory"
    echo "  - Update Caddy config with /tmp-media/ static file handler"
    echo "  - Run setup script (creates dirs, cron jobs, video-history.json)"
    echo ""

    VMS=$(fetch_vms)
    COUNT=$(echo "$VMS" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
    echo "Active VMs: $COUNT"
    echo ""
    echo "Run with --canary to deploy to 1 VM first, then --all for the rest."
    ;;

  --canary)
    echo "=== CANARY: Deploying to first VM only ==="
    VMS=$(fetch_vms)

    if [ -n "${CANARY_IP:-}" ]; then
      # Target specific IP (passed from master fleet push)
      FIRST=$(echo "$VMS" | python3 -c "
import json, sys
vms = json.load(sys.stdin)
for v in vms:
    if v['ip_address'] == '${CANARY_IP}':
        print(f\"{v['ip_address']} {v.get('ssh_user','agent')} {v['id']}\")
        break
" 2>/dev/null)
    else
      FIRST=$(echo "$VMS" | python3 -c "
import json, sys
vms = json.load(sys.stdin)
if vms:
    v = vms[0]
    print(f\"{v['ip_address']} {v.get('ssh_user','agent')} {v['id']}\")
" 2>/dev/null)
    fi

    if [ -z "$FIRST" ]; then
      echo "No active VMs found" >&2
      exit 1
    fi

    read -r IP USER VM_ID <<< "$FIRST"
    deploy_to_vm "$IP" "$USER" "$VM_ID"

    echo ""
    echo "=== CANARY COMPLETE ==="
    echo "Verify on $VM_ID:"
    echo "  ssh ${USER}@${IP} 'cat ~/.openclaw/skills/sjinn-video/SKILL.md | head -5'"
    echo "  ssh ${USER}@${IP} 'grep GATEWAY_TOKEN ~/.openclaw/.env'"
    echo "  ssh ${USER}@${IP} 'grep SJINN_API_KEY ~/.openclaw/.env'  # should be empty"
    echo ""
    echo "If healthy, run: $0 --all"
    ;;

  --all)
    echo "=== FLEET DEPLOY: Sjinn AI Video Production Skill ==="
    VMS=$(fetch_vms)

    echo "$VMS" | python3 -c "
import json, sys
vms = json.load(sys.stdin)
for v in vms:
    print(f\"{v['ip_address']} {v.get('ssh_user','agent')} {v['id']}\")
" 2>/dev/null | while read -r IP USER VM_ID; do
      deploy_to_vm "$IP" "$USER" "$VM_ID" || echo "  ✗ FAILED: $VM_ID ($IP)" >&2
    done

    echo ""
    echo "=== FLEET DEPLOY COMPLETE ==="
    ;;

  --help|*)
    echo "fleet-push-sjinn-video-skill.sh — Deploy Sjinn AI Video Production skill to fleet"
    echo ""
    echo "Usage:"
    echo "  $0 --dry-run   — Preview deployment (ALWAYS run first)"
    echo "  $0 --canary    — Deploy to 1 VM, verify, then --all"
    echo "  $0 --all       — Deploy to all active VMs"
    ;;
esac
