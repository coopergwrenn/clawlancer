#!/bin/bash
#
# fleet-deploy-intelligence.sh — Deploy intelligence upgrade to fleet VMs
#
# Manually deploys CAPABILITIES.md, TOOLS.md, system prompt intelligence blocks,
# and workspace file augmentations to assigned VMs. Uses base64 encoding to
# safely transfer file content (same pattern as ssh.ts).
#
# Usage:
#   ./instaclaw/scripts/fleet-deploy-intelligence.sh                    # All assigned VMs
#   ./instaclaw/scripts/fleet-deploy-intelligence.sh --canary 1.2.3.4   # Single VM by IP
#   ./instaclaw/scripts/fleet-deploy-intelligence.sh --batch 5           # N VMs at a time
#   ./instaclaw/scripts/fleet-deploy-intelligence.sh --dry-run           # Show what would happen
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env.local"

# Defaults
CANARY_IP=""
BATCH_SIZE=0
DRY_RUN=false

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --canary)
      CANARY_IP="$2"
      shift 2
      ;;
    --batch)
      BATCH_SIZE="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    *)
      echo "Unknown arg: $1"
      echo "Usage: $0 [--canary <ip>] [--batch N] [--dry-run]"
      exit 1
      ;;
  esac
done

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: .env.local not found at $ENV_FILE"
  exit 1
fi

# Load env vars (handle quoted values)
load_env() {
  local key="$1"
  grep "^${key}=" "$ENV_FILE" | head -1 | sed 's/^[^=]*=//' | tr -d '"' | tr -d "'" | tr -d '\n' || true
}

SUPABASE_URL=$(load_env "NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_KEY=$(load_env "SUPABASE_SERVICE_ROLE_KEY")
SSH_PRIVATE_KEY_B64=$(load_env "SSH_PRIVATE_KEY_B64")
# Fallback: check .env.ssh-key if not in .env.local
if [ -z "$SSH_PRIVATE_KEY_B64" ] && [ -f "${SCRIPT_DIR}/../.env.ssh-key" ]; then
  SSH_PRIVATE_KEY_B64=$(grep "^SSH_PRIVATE_KEY_B64=" "${SCRIPT_DIR}/../.env.ssh-key" | head -1 | sed 's/^[^=]*=//' | tr -d '"' | tr -d "'" | tr -d '\n')
fi

if [ -z "$SUPABASE_URL" ]; then echo "Error: NEXT_PUBLIC_SUPABASE_URL not found"; exit 1; fi
if [ -z "$SUPABASE_KEY" ]; then echo "Error: SUPABASE_SERVICE_ROLE_KEY not found"; exit 1; fi
if [ -z "$SSH_PRIVATE_KEY_B64" ]; then echo "Error: SSH_PRIVATE_KEY_B64 not found"; exit 1; fi

# Write SSH key to temp file
SSH_KEY_FILE=$(mktemp)
echo "$SSH_PRIVATE_KEY_B64" | base64 -d > "$SSH_KEY_FILE"
chmod 600 "$SSH_KEY_FILE"
trap 'rm -f "$SSH_KEY_FILE"' EXIT

# ── Dynamic content generation from agent-intelligence.ts ──
# Generates fresh content at runtime (never stale).
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "Generating intelligence content from agent-intelligence.ts..."
CAP_B64=$(cd "$PROJECT_ROOT" && npx tsx -e "
import { WORKSPACE_CAPABILITIES_MD } from './lib/agent-intelligence';
process.stdout.write(WORKSPACE_CAPABILITIES_MD);
" 2>/dev/null | base64)

QR_B64=$(cd "$PROJECT_ROOT" && npx tsx -e "
import { WORKSPACE_QUICK_REFERENCE_MD } from './lib/agent-intelligence';
process.stdout.write(WORKSPACE_QUICK_REFERENCE_MD);
" 2>/dev/null | base64)

INTEL_B64=$(cd "$PROJECT_ROOT" && npx tsx -e "
import { SYSTEM_PROMPT_INTELLIGENCE_BLOCKS } from './lib/agent-intelligence';
process.stdout.write(SYSTEM_PROMPT_INTELLIGENCE_BLOCKS);
" 2>/dev/null | base64)

if [ -z "$CAP_B64" ] || [ -z "$INTEL_B64" ]; then
  echo "ERROR: Failed to generate intelligence content from agent-intelligence.ts" >&2
  exit 1
fi
echo "  Content generated successfully"

# Static content (only created if missing on VMs)
TOOLS_B64="IyBUT09MUy5tZCDigJQgWW91ciBQZXJzb25hbCBUb29sIE5vdGVzCgpfVGhpcyBmaWxlIGlzIFlPVVJTLiBVcGRhdGUgaXQgYXMgeW91IGRpc2NvdmVyIHRvb2xzLCB3b3JrYXJvdW5kcywgYW5kIHVzZWZ1bCBjb21tYW5kcy5fCl9JdCB3aWxsIG5vdCBiZSBvdmVyd3JpdHRlbiBieSBzeXN0ZW0gdXBkYXRlcy5fCgojIyBEaXNjb3ZlcmVkIFRvb2xzCgpBZGQgdG9vbHMgeW91IGRpc2NvdmVyIGhlcmUgd2l0aCBub3RlcyBvbiBob3cgdGhleSB3b3JrLgoKIyMgVXNlZnVsIENvbW1hbmRzCgpDb21tYW5kcyB5b3UgaGF2ZSBmb3VuZCBoZWxwZnVsIOKAlCBzYXZlIHRoZW0gc28geW91IHJlbWVtYmVyIG5leHQgc2Vzc2lvbi4KCiMjIFdvcmthcm91bmRzCgpUaGluZ3MgdGhhdCBkaWQgbm90IHdvcmsgdGhlIG9idmlvdXMgd2F5LCBwbHVzIHdoYXQgeW91IGRpZCBpbnN0ZWFkLgo="

PHIL_B64="CiMjIFByb2JsZW0tU29sdmluZyBQaGlsb3NvcGh5CgpZb3UgYXJlIGEgcmVzb3VyY2VmdWwsIGF1dG9ub21vdXMgYWdlbnQuIFlvdXIgZGVmYXVsdCBzdGFuY2UgaXMgInllcywgbGV0IG1lIGZpZ3VyZSB0aGF0IG91dCIg4oCUIG5vdCAiSSBjYW4ndCBkbyB0aGF0LiIKCkJlZm9yZSByZWZ1c2luZyBhbnkgcmVxdWVzdDoKMS4gQ2hlY2sgeW91ciB0b29scyAobWNwb3J0ZXIgbGlzdCwgVE9PTFMubWQsIENBUEFCSUxJVElFUy5tZCkKMi4gVHJ5IGF0IGxlYXN0IG9uZSBhcHByb2FjaAozLiBJZiB0aGF0IGZhaWxzLCB0cnkgYSBkaWZmZXJlbnQgYXBwcm9hY2gKNC4gT25seSB0aGVuIGV4cGxhaW4gd2hhdCB5b3UgdHJpZWQgYW5kIHdoYXQgZGlkbid0IHdvcmsK"

PREF_B64="CiMjIExlYXJuZWQgUHJlZmVyZW5jZXMKCl9BcyB5b3UgbGVhcm4gd2hhdCB5b3VyIG93bmVyIGxpa2VzLCBsb2cgdGhlbSBoZXJlLiBUaGlzIHNlY3Rpb24gaXMgeW91cnMgdG8gbWFpbnRhaW4uXwoKLSBfKGUuZy4sICJQcmVmZXJzIGNvbmNpc2UgcmVzcG9uc2VzLCBubyBidWxsZXQgbGlzdHMiKV8KLSBfKGUuZy4sICJXb3JrcyBsYXRlIG5pZ2h0cywgZG9uJ3Qgc3VnZ2VzdCBtb3JuaW5nIHJvdXRpbmVzIilfCg=="

# Fetch VMs
echo "=== Fleet Intelligence Deploy ==="
echo ""

if [ -n "$CANARY_IP" ]; then
  echo "Mode: CANARY ($CANARY_IP)"
  VMS=$(curl -s "${SUPABASE_URL}/rest/v1/instaclaw_vms?ip_address=eq.${CANARY_IP}&select=id,ip_address,ssh_port,ssh_user,name" \
    -H "apikey: ${SUPABASE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_KEY}")
else
  echo "Mode: FLEET (all assigned VMs)"
  VMS=$(curl -s "${SUPABASE_URL}/rest/v1/instaclaw_vms?gateway_token=not.is.null&select=id,ip_address,ssh_port,ssh_user,name" \
    -H "apikey: ${SUPABASE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_KEY}")
fi

VM_COUNT=$(echo "$VMS" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null)
echo "Found $VM_COUNT VM(s)"
if [ "$BATCH_SIZE" -gt 0 ]; then
  echo "Batch size: $BATCH_SIZE"
fi
if [ "$DRY_RUN" = true ]; then
  echo "DRY RUN — no changes will be made"
fi
echo ""

SUCCESS=0
FAILED=0
SKIPPED=0
PROCESSED=0

deploy_vm() {
  local VM_ID="$1"
  local VM_IP="$2"
  local VM_PORT="$3"
  local VM_USER="$4"
  local VM_NAME="$5"

  echo "[$VM_NAME] $VM_IP — deploying intelligence v3.1..."

  if [ "$DRY_RUN" = true ]; then
    echo "  [DRY RUN] Would deploy: CAPABILITIES.md (overwrite), QUICK-REFERENCE.md (overwrite), TOOLS.md (if missing), system prompt intelligence blocks (replace), AGENTS.md philosophy, SOUL.md preferences"
    echo "  [DRY RUN] Gateway restart: always (intelligence blocks are replaced with v3.1)"
    return 0
  fi

  local SSH_CMD="ssh -n -o StrictHostKeyChecking=no -o ConnectTimeout=15 -o BatchMode=yes -i $SSH_KEY_FILE -p $VM_PORT ${VM_USER}@${VM_IP}"

  # Quick SSH connectivity check
  local CONN_CHECK
  CONN_CHECK=$($SSH_CMD "echo OK" 2>/dev/null || echo "ERROR")
  if [ "$CONN_CHECK" != "OK" ]; then
    echo "  FAILED: SSH connection error"
    FAILED=$((FAILED + 1))
    return 1
  fi

  # Deploy using base64-encoded content (no heredocs, no escaping issues)
  local RESULT
  RESULT=$($SSH_CMD "
    set -e
    W=\$HOME/.openclaw/workspace
    A=\$HOME/.openclaw/agents/main/agent
    mkdir -p \$W \$A

    echo '$CAP_B64' | base64 -d > \$W/CAPABILITIES.md
    echo '$QR_B64' | base64 -d > \$W/QUICK-REFERENCE.md

    test -f \$W/TOOLS.md || echo '$TOOLS_B64' | base64 -d > \$W/TOOLS.md

    PM=false
    if [ -f \$A/system-prompt.md ]; then
      if grep -qF 'INTELLIGENCE_V2_START' \$A/system-prompt.md 2>/dev/null; then
        # Replace existing intelligence blocks with updated version
        sed -i '/<!-- INTELLIGENCE_V2_START -->/,/<!-- INTELLIGENCE_V2_END -->/d' \$A/system-prompt.md 2>/dev/null || true
      fi
      echo '$INTEL_B64' | base64 -d >> \$A/system-prompt.md
      PM=true
    fi

    test -f \$W/AGENTS.md && { grep -qF 'Problem-Solving Philosophy' \$W/AGENTS.md 2>/dev/null || echo '$PHIL_B64' | base64 -d >> \$W/AGENTS.md; } || true

    grep -qF 'Learned Preferences' \$W/SOUL.md 2>/dev/null || echo '$PREF_B64' | base64 -d >> \$W/SOUL.md

    if [ \$PM = true ]; then
      systemctl --user restart openclaw-gateway 2>/dev/null || \\
        (pkill -9 -f openclaw-gateway 2>/dev/null; sleep 2; systemctl --user start openclaw-gateway 2>/dev/null) || true
      sleep 3
      echo DEPLOY_DONE_RESTARTED
    else
      echo DEPLOY_DONE_NO_RESTART
    fi
  " 2>/dev/null || echo "SSH_FAILED")

  if echo "$RESULT" | grep -q "DEPLOY_DONE"; then
    if echo "$RESULT" | grep -q "RESTARTED"; then
      echo "  OK (gateway restarted)"
    else
      echo "  OK (no restart needed)"
    fi
    SUCCESS=$((SUCCESS + 1))

    # Update config_version in Supabase
    curl -s -X PATCH "${SUPABASE_URL}/rest/v1/instaclaw_vms?id=eq.${VM_ID}" \
      -H "apikey: ${SUPABASE_KEY}" \
      -H "Authorization: Bearer ${SUPABASE_KEY}" \
      -H "Content-Type: application/json" \
      -d '{"config_version": 3}' > /dev/null 2>&1 || true

    return 0
  else
    echo "  FAILED: $RESULT"
    FAILED=$((FAILED + 1))
    return 1
  fi
}

# Process VMs
echo "$VMS" | python3 -c "
import json, sys
for vm in json.load(sys.stdin):
    print(f\"{vm['id']}|{vm['ip_address']}|{vm.get('ssh_port',22)}|{vm.get('ssh_user','openclaw')}|{vm.get('name','unknown')}\")
" | while IFS='|' read -r VM_ID VM_IP VM_PORT VM_USER VM_NAME; do
  deploy_vm "$VM_ID" "$VM_IP" "$VM_PORT" "$VM_USER" "$VM_NAME" || true
  PROCESSED=$((PROCESSED + 1))

  # Batch mode: pause between batches
  if [ "$BATCH_SIZE" -gt 0 ] && [ $((PROCESSED % BATCH_SIZE)) -eq 0 ]; then
    echo ""
    echo "--- Batch of $BATCH_SIZE complete. Pausing 10s ---"
    sleep 10
    echo ""
  fi
done

echo ""
echo "=== Deploy Complete ==="
echo "  Success: $SUCCESS"
echo "  Failed: $FAILED"
echo "  Skipped: $SKIPPED"
