#!/bin/bash
#
# fleet-push-intel-skill.sh — Deploy competitive intelligence skill to existing VMs
#
# Pushes: SKILL.md, competitive-intel.sh, competitive-intel.py, intel-guide.md,
#          BRAVE_SEARCH_API_KEY to all active VMs.
#
# Usage:
#   fleet-push-intel-skill.sh --dry-run    — Preview deployment
#   fleet-push-intel-skill.sh --canary     — Deploy to 1 VM, pause for approval
#   fleet-push-intel-skill.sh --all        — Deploy to all active VMs
#
# Requires:
#   - SUPABASE_SERVICE_ROLE_KEY in .env.local
#   - BRAVE_SEARCH_API_KEY in .env.local
#   - SSH access to VMs (keys in ~/.ssh/)
#
# MANDATORY: Always run --dry-run first, per CLAUDE.md rules.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILL_DIR="$PROJECT_ROOT/skills/competitive-intelligence"

# Load env
if [ -f "$PROJECT_ROOT/.env.local" ]; then
  set -a
  source "$PROJECT_ROOT/.env.local"
  set +a
fi

SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL:-}"
SUPABASE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-}"
BRAVE_KEY="${BRAVE_SEARCH_API_KEY:-}"

if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_KEY" ]; then
  echo "ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" >&2
  exit 1
fi

if [ -z "$BRAVE_KEY" ]; then
  echo "ERROR: Missing BRAVE_SEARCH_API_KEY in .env.local" >&2
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

  local skill_md_b64 guide_b64 client_b64 analysis_b64
  skill_md_b64=$(base64 < "$SKILL_DIR/SKILL.md")
  guide_b64=$(base64 < "$SKILL_DIR/references/intel-guide.md")
  client_b64=$(base64 < "$SKILL_DIR/assets/competitive-intel.sh")
  analysis_b64=$(base64 < "$SKILL_DIR/assets/competitive-intel.py")

  local key_b64
  key_b64=$(echo -n "$BRAVE_KEY" | base64)

  ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "${user}@${ip}" bash -s <<REMOTE_SCRIPT
set -e

SKILL_DIR="\$HOME/.openclaw/skills/competitive-intelligence"
mkdir -p "\$SKILL_DIR/references" "\$SKILL_DIR/assets" "\$HOME/scripts"
mkdir -p "\$HOME/.openclaw/workspace/competitive-intel/snapshots"
mkdir -p "\$HOME/.openclaw/workspace/competitive-intel/reports/daily"
mkdir -p "\$HOME/.openclaw/workspace/competitive-intel/reports/weekly"
mkdir -p "\$HOME/.openclaw/cache/brave-search"

echo '$skill_md_b64' | base64 -d > "\$SKILL_DIR/SKILL.md"
echo '$guide_b64' | base64 -d > "\$SKILL_DIR/references/intel-guide.md"
echo '$client_b64' | base64 -d > "\$HOME/scripts/competitive-intel.sh"
echo '$analysis_b64' | base64 -d > "\$HOME/scripts/competitive-intel.py"
chmod +x "\$HOME/scripts/competitive-intel.sh" "\$HOME/scripts/competitive-intel.py"

touch "\$HOME/.openclaw/.env"
BV_KEY=\$(echo '$key_b64' | base64 -d)
grep -q "^BRAVE_SEARCH_API_KEY=" "\$HOME/.openclaw/.env" 2>/dev/null && \
  sed -i "s/^BRAVE_SEARCH_API_KEY=.*/BRAVE_SEARCH_API_KEY=\$BV_KEY/" "\$HOME/.openclaw/.env" || \
  echo "BRAVE_SEARCH_API_KEY=\$BV_KEY" >> "\$HOME/.openclaw/.env"

echo "  Intel skill deployed successfully"
REMOTE_SCRIPT

  echo "  done: $vm_id"
}

case "$MODE" in
  --dry-run)
    echo "=== DRY RUN: Competitive Intelligence Skill Deployment ==="
    echo ""
    echo "Files to deploy:"
    echo "  SKILL.md               -> ~/.openclaw/skills/competitive-intelligence/SKILL.md"
    echo "  intel-guide.md         -> ~/.openclaw/skills/competitive-intelligence/references/intel-guide.md"
    echo "  competitive-intel.sh   -> ~/scripts/competitive-intel.sh"
    echo "  competitive-intel.py   -> ~/scripts/competitive-intel.py"
    echo "  BRAVE_SEARCH_API_KEY   -> ~/.openclaw/.env"
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
    echo "Verify: ssh ${USER}@${IP} '~/scripts/competitive-intel.sh rate-status'"
    echo "If healthy, run: $0 --all"
    ;;

  --all)
    echo "=== FLEET DEPLOY: Competitive Intelligence Skill ==="
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
    echo "fleet-push-intel-skill.sh — Deploy competitive intelligence skill to fleet"
    echo ""
    echo "Usage:"
    echo "  $0 --dry-run   — Preview deployment (ALWAYS run first)"
    echo "  $0 --canary    — Deploy to 1 VM, verify, then --all"
    echo "  $0 --all       — Deploy to all active VMs"
    ;;
esac
