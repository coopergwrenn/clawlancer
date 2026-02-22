#!/bin/bash
#
# fleet-push-video-skill.sh — Deploy Remotion video production skill to existing VMs
#
# Pushes: SKILL.md, template-basic/ (6 files), advanced-patterns.md, brand-assets-checklist.md
# No external API keys needed — Remotion is open-source and runs locally.
#
# Usage:
#   fleet-push-video-skill.sh --dry-run    — Preview deployment
#   fleet-push-video-skill.sh --canary     — Deploy to 1 VM, pause for approval
#   fleet-push-video-skill.sh --all        — Deploy to all active VMs
#
# MANDATORY: Always run --dry-run first, per CLAUDE.md rules.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILL_DIR="$PROJECT_ROOT/skills/video-production"

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

  # Encode all files
  local skill_md_b64 adv_b64 checklist_b64
  local pkg_b64 tsconfig_b64 remotion_cfg_b64 index_b64 root_b64 video_b64
  skill_md_b64=$(base64 < "$SKILL_DIR/SKILL.md")
  adv_b64=$(base64 < "$SKILL_DIR/references/advanced-patterns.md")
  checklist_b64=$(base64 < "$SKILL_DIR/references/brand-assets-checklist.md")
  pkg_b64=$(base64 < "$SKILL_DIR/assets/template-basic/package.json")
  tsconfig_b64=$(base64 < "$SKILL_DIR/assets/template-basic/tsconfig.json")
  remotion_cfg_b64=$(base64 < "$SKILL_DIR/assets/template-basic/remotion.config.ts")
  index_b64=$(base64 < "$SKILL_DIR/assets/template-basic/src/index.ts")
  root_b64=$(base64 < "$SKILL_DIR/assets/template-basic/src/Root.tsx")
  video_b64=$(base64 < "$SKILL_DIR/assets/template-basic/src/MyVideo.tsx")

  ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "${user}@${ip}" bash -s <<REMOTE_SCRIPT
set -e

SKILL_DIR="\$HOME/.openclaw/skills/video-production"
TMPL_DIR="\$SKILL_DIR/assets/template-basic/src"
mkdir -p "\$SKILL_DIR/references" "\$TMPL_DIR"

echo '$skill_md_b64' | base64 -d > "\$SKILL_DIR/SKILL.md"
echo '$adv_b64' | base64 -d > "\$SKILL_DIR/references/advanced-patterns.md"
echo '$checklist_b64' | base64 -d > "\$SKILL_DIR/references/brand-assets-checklist.md"
echo '$pkg_b64' | base64 -d > "\$SKILL_DIR/assets/template-basic/package.json"
echo '$tsconfig_b64' | base64 -d > "\$SKILL_DIR/assets/template-basic/tsconfig.json"
echo '$remotion_cfg_b64' | base64 -d > "\$SKILL_DIR/assets/template-basic/remotion.config.ts"
echo '$index_b64' | base64 -d > "\$TMPL_DIR/index.ts"
echo '$root_b64' | base64 -d > "\$TMPL_DIR/Root.tsx"
echo '$video_b64' | base64 -d > "\$TMPL_DIR/MyVideo.tsx"

echo "  Video production skill deployed successfully"
REMOTE_SCRIPT

  echo "  done: $vm_id"
}

case "$MODE" in
  --dry-run)
    echo "=== DRY RUN: Video Production Skill Deployment ==="
    echo ""
    echo "Files to deploy:"
    echo "  SKILL.md                -> ~/.openclaw/skills/video-production/SKILL.md"
    echo "  advanced-patterns.md    -> ~/.openclaw/skills/video-production/references/"
    echo "  brand-assets-checklist.md -> ~/.openclaw/skills/video-production/references/"
    echo "  template-basic/         -> ~/.openclaw/skills/video-production/assets/template-basic/"
    echo "    package.json, tsconfig.json, remotion.config.ts"
    echo "    src/index.ts, src/Root.tsx, src/MyVideo.tsx"
    echo ""
    echo "No API keys required — Remotion is open-source."
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
    echo "Verify: ssh ${USER}@${IP} 'ls ~/.openclaw/skills/video-production/'"
    echo "If healthy, run: $0 --all"
    ;;

  --all)
    echo "=== FLEET DEPLOY: Video Production Skill ==="
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
    echo "fleet-push-video-skill.sh — Deploy Remotion video production skill to fleet"
    echo ""
    echo "Usage:"
    echo "  $0 --dry-run   — Preview deployment (ALWAYS run first)"
    echo "  $0 --canary    — Deploy to 1 VM, verify, then --all"
    echo "  $0 --all       — Deploy to all active VMs"
    ;;
esac
