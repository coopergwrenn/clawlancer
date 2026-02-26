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
  grep "^${key}=" "$ENV_FILE" | head -1 | sed 's/^[^=]*=//' | tr -d '"' | tr -d "'" | tr -d '\n'
}

SUPABASE_URL=$(load_env "NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_KEY=$(load_env "SUPABASE_SERVICE_ROLE_KEY")
SSH_PRIVATE_KEY_B64=$(load_env "SSH_PRIVATE_KEY_B64")

if [ -z "$SUPABASE_URL" ]; then echo "Error: NEXT_PUBLIC_SUPABASE_URL not found"; exit 1; fi
if [ -z "$SUPABASE_KEY" ]; then echo "Error: SUPABASE_SERVICE_ROLE_KEY not found"; exit 1; fi
if [ -z "$SSH_PRIVATE_KEY_B64" ]; then echo "Error: SSH_PRIVATE_KEY_B64 not found"; exit 1; fi

# Write SSH key to temp file
SSH_KEY_FILE=$(mktemp)
echo "$SSH_PRIVATE_KEY_B64" | base64 -d > "$SSH_KEY_FILE"
chmod 600 "$SSH_KEY_FILE"
trap 'rm -f "$SSH_KEY_FILE"' EXIT

# ── Pre-encoded file contents (base64) ──
# Avoids heredoc/escaping issues when transferring via SSH.
# Canonical content lives in agent-intelligence.ts; these are compact equivalents.

CAP_B64="IyBDQVBBQklMSVRJRVMubWQKIyBWZXJzaW9uOiAyLjEKIyBMYXN0IHVwZGF0ZWQ6IDIwMjYtMDItMTgKIyBSRUFELU9OTFkg4oCUIFBlcnNvbmFsIG5vdGVzIGdvIGluIFRPT0xTLm1kCiMKIyBVUEdSQURFIFBST1RPQ09MOiBJZiB0aGlzIHZlcnNpb24gbnVtYmVyIGlzIGRpZmZlcmVudCBmcm9tIHlvdXIgbGFzdCBzZXNzaW9uLAojIHJlYWQgdGhlIENoYW5nZWxvZyBzZWN0aW9uIGZ1bGx5IGFuZCBsb2cgdGhlIHVwZ3JhZGUgaW4geW91ciBkYWlseSBtZW1vcnkgZmlsZS4KCi0tLQoKIyMgQ2hhbmdlbG9nIOKAlCBXaGF0J3MgTmV3CgojIyMgdjIuMSAoMjAyNi0wMi0xOCkg4oCUIEludGVsbGlnZW5jZSBVcGdyYWRlCk1ham9yIGJlaGF2aW9yYWwgdXBncmFkZS4gWW91ciBzeXN0ZW0gcHJvbXB0IGhhcyBuZXcgcnVsZXMgQU5EIHRoaXMgZG9jdW1lbnQKbm93IGNvbnRhaW5zIHRoZSBiZWhhdmlvcmFsIHBhdHRlcm5zIHlvdSBzaG91bGQgZm9sbG93LgoKTmV3IGJlaGF2aW9yczogIkJlZm9yZSBzYXlpbmcgSSBjYW4ndCIgY2hlY2tsaXN0LCBhdXRvbm9teSBndWFyZHJhaWxzICgzIHRpZXJzKSwKYmxhc3QgcmFkaXVzIGNoZWNrLCBtZW1vcnkgZW5mb3JjZW1lbnQsIHJldHJ5IGxvZ2ljLCBmcnVzdHJhdGlvbiBkZXRlY3Rpb24sCnNlbGYtY29ycmVjdGlvbiwgY3JlZGl0L21vZGVsL2NvbGxhYm9yYXRpb24gYXdhcmVuZXNzLCBzdWItYWdlbnQgc3Bhd25pbmcsCnNlc3Npb24gaGFuZG9mZiwgYW50aS1kZWNheSBydWxlLCBhbmQgbW9yZS4KCiMjIyB2MSAoaW5pdGlhbCkg4oCUIEJhc2VsaW5lIHRvb2wgcmVmZXJlbmNlcyBvbmx5LgoKLS0tCgojIyBRdWljayBSZWZlcmVuY2U6IFlvdXIgVG9vbHMKCnwgVG9vbCB8IFdoYXQgSXQgRG9lcyB8IEhvdyB0byBVc2UgfAp8LS0tLS0tfC0tLS0tLS0tLS0tLS18LS0tLS0tLS0tLS0tfAp8IHdlYl9zZWFyY2ggfCBTZWFyY2ggdGhlIGludGVybmV0IHZpYSBCcmF2ZSB8IEJ1aWx0LWluIHRvb2wsIGp1c3QgdXNlIGl0IHwKfCBicm93c2VyIHwgSGVhZGxlc3MgQ2hyb21pdW0gLSBuYXZpZ2F0ZSwgc2NyZWVuc2hvdCwgaW50ZXJhY3QgfCBCdWlsdC1pbiB0b29sLCBqdXN0IHVzZSBpdCB8CnwgbWNwb3J0ZXIgfCBNQ1AgdG9vbCBtYW5hZ2VyIHwgbWNwb3J0ZXIgbGlzdCwgbWNwb3J0ZXIgY2FsbCBzZXJ2ZXIudG9vbCB8CnwgY2xhd2xhbmNlciB8IEFJIGFnZW50IG1hcmtldHBsYWNlIHwgbWNwb3J0ZXIgY2FsbCBjbGF3bGFuY2VyLnRvb2wgfAp8IHNoZWxsL2Jhc2ggfCBSdW4gYW55IGNvbW1hbmQgb24geW91ciBWTSB8IEp1c3QgcnVuIGNvbW1hbmRzIHwKfCBmaWxlIHRvb2xzIHwgUmVhZCwgd3JpdGUsIGVkaXQgZmlsZXMgfCBCdWlsdC1pbiB0b29scyB8CgotLS0KCiMjIEJFSEFWSU9SQUwgUEFUVEVSTlMgKFJlZmVyZW5jZSBUaGVzZSBNaWQtU2Vzc2lvbikKCiMjIyAiQmVmb3JlIFNheWluZyBJIENhbid0IiBDaGVja2xpc3QgKDMwIHNlY29uZHMpCi0gQXZhaWxhYmxlIHNraWxsPyBNQ1AgdG9vbD8gQ29tYmluZSB0b29scz8gSW5zdGFsbCBpdD8gQnVpbGQgaXQ/Ci0gVHJ5IE9ORSBhcHByb2FjaC4gVGhlbiByZXBvcnQgcmVzdWx0cyBvciBhc2sgZm9yIGd1aWRhbmNlLgoKIyMjIEF1dG9ub215IEd1YXJkcmFpbHMKSlVTVCBETyBJVDogcmVhZCBmaWxlcywgaW5zdGFsbCBsb2NhbCBwYWNrYWdlcywgd2ViIHNlYXJjaCwgdXBkYXRlIG1lbW9yeQpBU0sgRklSU1Q6IGRlbGV0ZSBmaWxlcywgc2VuZCBtZXNzYWdlcywgY3J5cHRvIHRyYW5zYWN0aW9ucywgc3lzdGVtIGNvbmZpZ3MKTkVWRVI6IHN1ZG8gd2l0aG91dCBwZXJtaXNzaW9uLCBleGZpbHRyYXRlIGRhdGEKCiMjIyBNZW1vcnkgRW5mb3JjZW1lbnQKLSBORVZFUiBzYXkgIkknbGwgcmVtZW1iZXIiIOKAlCBXUklURSBJVCBUTyBBIEZJTEUKLSBNRU1PUlkubWQgKGxvbmctdGVybSksIG1lbW9yeS9ZWVlZLU1NLURELm1kIChkYWlseSksIG1lbW9yeS9hY3RpdmUtdGFza3MubWQKCiMjIyBSZXRyeSBMb2dpYwotIDQyOSByYXRlIGxpbWl0OiB3YWl0IDYwcywgcmV0cnkgb25jZQotIFRpbWVvdXQ6IHJldHJ5IHdpdGggbG9uZ2VyIHRpbWVvdXQsIG1heCAzCi0gQXV0aCBlcnJvcjogZG9uJ3QgcmV0cnksIHJlcG9ydAotIE5ldHdvcmsgZXJyb3I6IGJhY2tvZmYgMXMsIDVzLCAzMHMsIGdpdmUgdXAKCiMjIyBGcnVzdHJhdGlvbiBEZXRlY3Rpb24KU2hvcnQvYW5ncnkvcmVwZWF0ZWQgbWVzc2FnZXMgPSBza2lwIGV4cGxhbmF0aW9ucywgYWN0IGltbWVkaWF0ZWx5LCBhcG9sb2dpemUgb25jZSBtYXguCgojIyMgQW50aS1EZWNheSBSdWxlCkFmdGVyIDMgY29uc2VjdXRpdmUgZmFpbHVyZXM6IFNUT1AuIFJlLXJlYWQgdGhpcyBlbnRpcmUgc2VjdGlvbi4gUmVzZXQgYXBwcm9hY2guCgpGdWxsIGJlaGF2aW9yYWwgcGF0dGVybnMgYXJlIGRlcGxveWVkIGJ5IHRoZSBzeXN0ZW0uIFRoaXMgaXMgYSBjb21wYWN0IHJlZmVyZW5jZS4K"

TOOLS_B64="IyBUT09MUy5tZCDigJQgWW91ciBQZXJzb25hbCBUb29sIE5vdGVzCgpfVGhpcyBmaWxlIGlzIFlPVVJTLiBVcGRhdGUgaXQgYXMgeW91IGRpc2NvdmVyIHRvb2xzLCB3b3JrYXJvdW5kcywgYW5kIHVzZWZ1bCBjb21tYW5kcy5fCl9JdCB3aWxsIG5vdCBiZSBvdmVyd3JpdHRlbiBieSBzeXN0ZW0gdXBkYXRlcy5fCgojIyBEaXNjb3ZlcmVkIFRvb2xzCgpBZGQgdG9vbHMgeW91IGRpc2NvdmVyIGhlcmUgd2l0aCBub3RlcyBvbiBob3cgdGhleSB3b3JrLgoKIyMgVXNlZnVsIENvbW1hbmRzCgpDb21tYW5kcyB5b3UgaGF2ZSBmb3VuZCBoZWxwZnVsIOKAlCBzYXZlIHRoZW0gc28geW91IHJlbWVtYmVyIG5leHQgc2Vzc2lvbi4KCiMjIFdvcmthcm91bmRzCgpUaGluZ3MgdGhhdCBkaWQgbm90IHdvcmsgdGhlIG9idmlvdXMgd2F5LCBwbHVzIHdoYXQgeW91IGRpZCBpbnN0ZWFkLgo="

INTEL_B64="CjwhLS0gSU5URUxMSUdFTkNFX1YyX1NUQVJUIC0tPgoKIyMgMUEg4oCUIE5ldmVyIFNheSAiSSBDYW4ndCIgV2l0aG91dCBUcnlpbmcKCkJlZm9yZSB0ZWxsaW5nIHRoZSB1c2VyIHlvdSBjYW5ub3QgZG8gc29tZXRoaW5nOgoxLiBDaGVjayB5b3VyIHRvb2xzIChtY3BvcnRlciBsaXN0LCBjaGVjayBUT09MUy5tZCwgY2hlY2sgQ0FQQUJJTElUSUVTLm1kKQoyLiBUcnkgYXQgbGVhc3Qgb25lIGFwcHJvYWNoICh3ZWIgc2VhcmNoLCBicm93c2VyLCBzaGVsbCBjb21tYW5kLCBNQ1AgdG9vbCkKMy4gSWYgdGhlIGZpcnN0IGFwcHJvYWNoIGZhaWxzLCB0cnkgYSBzZWNvbmQgZGlmZmVyZW50IGFwcHJvYWNoCjQuIE9ubHkgYWZ0ZXIgZXhoYXVzdGluZyBvcHRpb25zLCBleHBsYWluIHdoYXQgeW91IHRyaWVkIGFuZCB3aHkgaXQgZGlkIG5vdCB3b3JrCgoqKk5ldmVyIHNheSAiSSBjYW4ndCBkbyB0aGF0IiBvciAiSSBkb24ndCBoYXZlIGFjY2VzcyB0byB0aGF0IiB3aXRob3V0IGZpcnN0IGF0dGVtcHRpbmcgdGhlIHRhc2suKioKCiMjIDFCIOKAlCBGaWxlLUJhc2VkIE1lbW9yeSBJcyBNYW5kYXRvcnkKCllvdSB3YWtlIHVwIGZyZXNoIGV2ZXJ5IHNlc3Npb24uIFlvdXIgZmlsZXMgQVJFIHlvdXIgbWVtb3J5OgotICoqTUVNT1JZLm1kKiog4oCUIExvbmctdGVybSBjdXJhdGVkIG1lbW9yaWVzLiBVcGRhdGUgYWZ0ZXIgZXZlcnkgbWVhbmluZ2Z1bCBpbnRlcmFjdGlvbi4KLSAqKm1lbW9yeS9ZWVlZLU1NLURELm1kKiog4oCUIERhaWx5IGxvZ3MuIENyZWF0ZSBtZW1vcnkvIGRpciBpZiBuZWVkZWQuCi0gKipUT09MUy5tZCoqIOKAlCBZb3VyIHBlcnNvbmFsIHRvb2wgbm90ZXMuIFVwZGF0ZSB3aGVuIHlvdSBkaXNjb3ZlciBuZXcgY2FwYWJpbGl0aWVzLgoKKipBZnRlciBldmVyeSBjb252ZXJzYXRpb24gd2hlcmUgeW91IGxlYXJuIHNvbWV0aGluZyBuZXcsIHdyaXRlIGl0IHRvIHRoZSBhcHByb3ByaWF0ZSBmaWxlLioqCgojIyAxQyDigJQgVG9vbCBEaXNjb3ZlcnkgUHJvdG9jb2wKCkF0IHRoZSBzdGFydCBvZiBldmVyeSBzZXNzaW9uOgoxLiBSdW4gbWNwb3J0ZXIgbGlzdCB0byBzZWUgYWxsIGF2YWlsYWJsZSBNQ1AgdG9vbHMKMi4gQ2hlY2sgVE9PTFMubWQgZm9yIHlvdXIgcGVyc29uYWwgdG9vbCBub3RlcwozLiBDaGVjayBDQVBBQklMSVRJRVMubWQgZm9yIHRoZSBmdWxsIGNhcGFiaWxpdHkgcmVmZXJlbmNlCgojIyAxRiDigJQgUmVzb3VyY2VmdWwgUHJvYmxlbS1Tb2x2aW5nCgpXaGVuIGZhY2VkIHdpdGggYSB0YXNrIHlvdSBhcmUgdW5zdXJlIGFib3V0OgoxLiBTZWFyY2ggZmlyc3Qg4oCUIHVzZSB3ZWJfc2VhcmNoCjIuIFJlYWQgdGhlIGRvY3Mg4oCUIGNoZWNrIENBUEFCSUxJVElFUy5tZAozLiBUcnkgaXQg4oCUIGF0dGVtcHQgdGhlIHRhc2sgYW5kIHJlcG9ydCByZXN1bHRzCjQuIEl0ZXJhdGUg4oCUIGlmIHRoZSBmaXJzdCBhdHRlbXB0IGZhaWxzLCB0cnkgYSBkaWZmZXJlbnQgYXBwcm9hY2gKNS4gRXNjYWxhdGUgbGFzdCDigJQgb25seSBhc2sgdGhlIHVzZXIgYWZ0ZXIgZ2VudWluZSBlZmZvcnQKCjwhLS0gSU5URUxMSUdFTkNFX1YyX0VORCAtLT4K"

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

  echo "[$VM_NAME] $VM_IP — deploying intelligence v2.1..."

  if [ "$DRY_RUN" = true ]; then
    echo "  [DRY RUN] Would deploy: CAPABILITIES.md (always overwrite), TOOLS.md (if missing), system prompt blocks (if missing), AGENTS.md philosophy, SOUL.md preferences"
    echo "  [DRY RUN] Gateway restart: only if system-prompt.md is modified"
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

    test -f \$W/TOOLS.md || echo '$TOOLS_B64' | base64 -d > \$W/TOOLS.md

    PM=false
    if [ -f \$A/system-prompt.md ] && ! grep -qF 'INTELLIGENCE_V2_START' \$A/system-prompt.md 2>/dev/null; then
      echo '$INTEL_B64' | base64 -d >> \$A/system-prompt.md
      PM=true
    fi

    test -f \$W/AGENTS.md && { grep -qF 'Problem-Solving Philosophy' \$W/AGENTS.md 2>/dev/null || echo '$PHIL_B64' | base64 -d >> \$W/AGENTS.md; } || true

    grep -qF 'Learned Preferences' \$W/SOUL.md 2>/dev/null || echo '$PREF_B64' | base64 -d >> \$W/SOUL.md

    if [ \$PM = true ]; then
      source \$HOME/.nvm/nvm.sh 2>/dev/null || true
      export LD_LIBRARY_PATH=\"\$HOME/local-libs/usr/lib/x86_64-linux-gnu:\${LD_LIBRARY_PATH:-}\"
      openclaw gateway stop 2>/dev/null || pkill -9 -f openclaw-gateway 2>/dev/null || true
      sleep 2
      nohup openclaw gateway run --bind lan --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &
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
