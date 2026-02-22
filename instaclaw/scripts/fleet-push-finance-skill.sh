#!/bin/bash
#
# fleet-push-finance-skill.sh — Deploy financial analysis skill to existing VMs
#
# Pushes: SKILL.md, market-data.sh, market-analysis.py, finance-guide.md,
#          ALPHAVANTAGE_API_KEY to all active VMs.
#
# Usage:
#   fleet-push-finance-skill.sh --dry-run          — Preview what would be deployed
#   fleet-push-finance-skill.sh --canary            — Deploy to 1 VM, pause for approval
#   fleet-push-finance-skill.sh --all               — Deploy to all active VMs
#
# Requires:
#   - SUPABASE_SERVICE_ROLE_KEY in .env.local
#   - ALPHAVANTAGE_API_KEY in .env.local
#   - SSH access to VMs (keys in ~/.ssh/)
#
# MANDATORY: Always run --dry-run first, per CLAUDE.md rules.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILL_DIR="$PROJECT_ROOT/skills/financial-analysis"

# Load env
if [ -f "$PROJECT_ROOT/.env.local" ]; then
  set -a
  source "$PROJECT_ROOT/.env.local"
  set +a
fi

SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL:-}"
SUPABASE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-}"
ALPHAVANTAGE_KEY="${ALPHAVANTAGE_API_KEY:-}"

if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_KEY" ]; then
  echo "ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" >&2
  exit 1
fi

if [ -z "$ALPHAVANTAGE_KEY" ]; then
  echo "ERROR: Missing ALPHAVANTAGE_API_KEY in .env.local" >&2
  exit 1
fi

MODE="${1:---help}"

# Fetch active VMs
fetch_vms() {
  curl -s "${SUPABASE_URL}/rest/v1/virtual_machines?status=eq.active&select=id,ip_address,ssh_user" \
    -H "apikey: $SUPABASE_KEY" \
    -H "Authorization: Bearer $SUPABASE_KEY"
}

deploy_to_vm() {
  local ip="$1" user="$2" vm_id="$3"

  echo "  Deploying to $vm_id ($user@$ip)..."

  # Read and base64-encode skill files
  local skill_md_b64 guide_b64 client_b64 analysis_b64
  skill_md_b64=$(base64 < "$SKILL_DIR/SKILL.md")
  guide_b64=$(base64 < "$SKILL_DIR/references/finance-guide.md")
  client_b64=$(base64 < "$SKILL_DIR/assets/market-data.sh")
  analysis_b64=$(base64 < "$SKILL_DIR/assets/market-analysis.py")

  # Base64-encode API key for safe transport
  local key_b64
  key_b64=$(echo -n "$ALPHAVANTAGE_KEY" | base64)

  ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "${user}@${ip}" bash -s <<REMOTE_SCRIPT
set -e

# Create directories
SKILL_DIR="\$HOME/.openclaw/skills/financial-analysis"
mkdir -p "\$SKILL_DIR/references" "\$SKILL_DIR/assets" "\$HOME/scripts"
mkdir -p "\$HOME/.openclaw/cache/alphavantage"

# Deploy skill files
echo '$skill_md_b64' | base64 -d > "\$SKILL_DIR/SKILL.md"
echo '$guide_b64' | base64 -d > "\$SKILL_DIR/references/finance-guide.md"
echo '$client_b64' | base64 -d > "\$HOME/scripts/market-data.sh"
echo '$analysis_b64' | base64 -d > "\$HOME/scripts/market-analysis.py"
chmod +x "\$HOME/scripts/market-data.sh" "\$HOME/scripts/market-analysis.py"

# Deploy API key
touch "\$HOME/.openclaw/.env"
AV_KEY=\$(echo '$key_b64' | base64 -d)
grep -q "^ALPHAVANTAGE_API_KEY=" "\$HOME/.openclaw/.env" 2>/dev/null && \
  sed -i "s/^ALPHAVANTAGE_API_KEY=.*/ALPHAVANTAGE_API_KEY=\$AV_KEY/" "\$HOME/.openclaw/.env" || \
  echo "ALPHAVANTAGE_API_KEY=\$AV_KEY" >> "\$HOME/.openclaw/.env"

echo "  Finance skill deployed successfully"
REMOTE_SCRIPT

  echo "  ✓ $vm_id done"
}

case "$MODE" in
  --dry-run)
    echo "=== DRY RUN: Financial Analysis Skill Deployment ==="
    echo ""
    echo "Files to deploy:"
    echo "  SKILL.md          → ~/.openclaw/skills/financial-analysis/SKILL.md"
    echo "  finance-guide.md  → ~/.openclaw/skills/financial-analysis/references/finance-guide.md"
    echo "  market-data.sh    → ~/scripts/market-data.sh"
    echo "  market-analysis.py → ~/scripts/market-analysis.py"
    echo "  ALPHAVANTAGE_API_KEY → ~/.openclaw/.env"
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
    echo "Verify on $VM_ID:"
    echo "  ssh ${USER}@${IP} '~/scripts/market-data.sh rate-status'"
    echo ""
    echo "If healthy, run: $0 --all"
    ;;

  --all)
    echo "=== FLEET DEPLOY: Financial Analysis Skill ==="
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
    echo "fleet-push-finance-skill.sh — Deploy financial analysis skill to fleet"
    echo ""
    echo "Usage:"
    echo "  $0 --dry-run   — Preview deployment (ALWAYS run first)"
    echo "  $0 --canary    — Deploy to 1 VM, verify, then --all"
    echo "  $0 --all       — Deploy to all active VMs"
    ;;
esac
