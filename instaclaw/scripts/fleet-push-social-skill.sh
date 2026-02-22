#!/bin/bash
#
# fleet-push-social-skill.sh — Deploy social media content skill to existing VMs
#
# Pushes: SKILL.md, social-content.py, social-guide.md to all active VMs.
# No external API keys needed — content generation is local.
#
# Usage:
#   fleet-push-social-skill.sh --dry-run    — Preview deployment
#   fleet-push-social-skill.sh --canary     — Deploy to 1 VM, pause for approval
#   fleet-push-social-skill.sh --all        — Deploy to all active VMs
#
# MANDATORY: Always run --dry-run first, per CLAUDE.md rules.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILL_DIR="$PROJECT_ROOT/skills/social-media-content"

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

MODE="${1:---help}"

fetch_vms() {
  curl -s "${SUPABASE_URL}/rest/v1/virtual_machines?status=eq.active&select=id,ip_address,ssh_user" \
    -H "apikey: $SUPABASE_KEY" \
    -H "Authorization: Bearer $SUPABASE_KEY"
}

deploy_to_vm() {
  local ip="$1" user="$2" vm_id="$3"

  echo "  Deploying to $vm_id ($user@$ip)..."

  local skill_md_b64 guide_b64 content_b64
  skill_md_b64=$(base64 < "$SKILL_DIR/SKILL.md")
  guide_b64=$(base64 < "$SKILL_DIR/references/social-guide.md")
  content_b64=$(base64 < "$SKILL_DIR/assets/social-content.py")

  ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "${user}@${ip}" bash -s <<REMOTE_SCRIPT
set -e

SKILL_DIR="\$HOME/.openclaw/skills/social-media-content"
mkdir -p "\$SKILL_DIR/references" "\$SKILL_DIR/assets" "\$HOME/scripts"
mkdir -p "\$HOME/.openclaw/workspace/social-content"

echo '$skill_md_b64' | base64 -d > "\$SKILL_DIR/SKILL.md"
echo '$guide_b64' | base64 -d > "\$SKILL_DIR/references/social-guide.md"
echo '$content_b64' | base64 -d > "\$HOME/scripts/social-content.py"
chmod +x "\$HOME/scripts/social-content.py"

echo "  Social content skill deployed successfully"
REMOTE_SCRIPT

  echo "  done: $vm_id"
}

case "$MODE" in
  --dry-run)
    echo "=== DRY RUN: Social Media Content Skill Deployment ==="
    echo ""
    echo "Files to deploy:"
    echo "  SKILL.md           -> ~/.openclaw/skills/social-media-content/SKILL.md"
    echo "  social-guide.md    -> ~/.openclaw/skills/social-media-content/references/social-guide.md"
    echo "  social-content.py  -> ~/scripts/social-content.py"
    echo ""
    echo "No API keys required — content generation is local."
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
    FIRST=$(echo "$VMS" | python3 -c "
import json, sys
vms = json.load(sys.stdin)
if vms:
    v = vms[0]
    print(f\"{v['ip_address']} {v.get('ssh_user','agent')} {v['id']}\")
" 2>/dev/null)

    if [ -z "$FIRST" ]; then
      echo "No active VMs found" >&2
      exit 1
    fi

    read -r IP USER VM_ID <<< "$FIRST"
    deploy_to_vm "$IP" "$USER" "$VM_ID"

    echo ""
    echo "=== CANARY COMPLETE ==="
    echo "Verify: ssh ${USER}@${IP} 'python3 ~/scripts/social-content.py --help'"
    echo "If healthy, run: $0 --all"
    ;;

  --all)
    echo "=== FLEET DEPLOY: Social Media Content Skill ==="
    VMS=$(fetch_vms)

    echo "$VMS" | python3 -c "
import json, sys
vms = json.load(sys.stdin)
for v in vms:
    print(f\"{v['ip_address']} {v.get('ssh_user','agent')} {v['id']}\")
" 2>/dev/null | while read -r IP USER VM_ID; do
      deploy_to_vm "$IP" "$USER" "$VM_ID" || echo "  FAILED: $VM_ID ($IP)" >&2
    done

    echo ""
    echo "=== FLEET DEPLOY COMPLETE ==="
    ;;

  --help|*)
    echo "fleet-push-social-skill.sh — Deploy social media content skill to fleet"
    echo ""
    echo "Usage:"
    echo "  $0 --dry-run   — Preview deployment (ALWAYS run first)"
    echo "  $0 --canary    — Deploy to 1 VM, verify, then --all"
    echo "  $0 --all       — Deploy to all active VMs"
    ;;
esac
