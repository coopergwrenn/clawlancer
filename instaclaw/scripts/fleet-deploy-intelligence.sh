#!/bin/bash
#
# fleet-deploy-intelligence.sh — Deploy intelligence upgrade to fleet VMs
#
# Manually deploys CAPABILITIES.md, TOOLS.md, system prompt intelligence blocks,
# and workspace file augmentations to assigned VMs.
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

# NVM preamble (must match ssh.ts)
NVM_PREAMBLE='export LD_LIBRARY_PATH="$HOME/local-libs/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}" && export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"'

INTELLIGENCE_MARKER="INTELLIGENCE_V2_START"
PHILOSOPHY_MARKER="Problem-Solving Philosophy"
PREFS_MARKER="Learned Preferences"

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
  VMS=$(curl -s "${SUPABASE_URL}/rest/v1/instaclaw_vms?assigned_to=not.is.null&select=id,ip_address,ssh_port,ssh_user,name" \
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

  echo "[$VM_NAME] $VM_IP — deploying intelligence v2..."

  if [ "$DRY_RUN" = true ]; then
    echo "  [DRY RUN] Would deploy CAPABILITIES.md, TOOLS.md, prompt blocks, AGENTS.md, SOUL.md augmentations"
    return 0
  fi

  SSH_CMD="ssh -n -o StrictHostKeyChecking=no -o ConnectTimeout=15 -o BatchMode=yes -i $SSH_KEY_FILE -p $VM_PORT ${VM_USER}@${VM_IP}"

  # Check if intelligence marker already present in system prompt
  MARKER_CHECK=$($SSH_CMD "grep -qF '$INTELLIGENCE_MARKER' ~/.openclaw/agents/main/agent/system-prompt.md 2>/dev/null && echo PRESENT || echo ABSENT" 2>/dev/null || echo "ERROR")

  if [ "$MARKER_CHECK" = "PRESENT" ]; then
    echo "  Already deployed — skipping"
    SKIPPED=$((SKIPPED + 1))
    return 0
  fi

  if [ "$MARKER_CHECK" = "ERROR" ]; then
    echo "  FAILED: SSH connection error"
    FAILED=$((FAILED + 1))
    return 1
  fi

  # Deploy all files in a single SSH session
  # Note: CAPABILITIES.md and intelligence blocks are inlined here for the manual script.
  # The canonical content lives in agent-intelligence.ts (ssh.ts imports it).
  RESULT=$($SSH_CMD "bash -s" << 'DEPLOY_EOF'
set -e
WORKSPACE="$HOME/.openclaw/workspace"
AGENT_DIR="$HOME/.openclaw/agents/main/agent"
SCRIPTS_DIR="$HOME/.openclaw/scripts"
mkdir -p "$WORKSPACE" "$AGENT_DIR" "$SCRIPTS_DIR"

# 1. Write CAPABILITIES.md (always overwrite — read-only reference)
cat > "$WORKSPACE/CAPABILITIES.md" << 'CAPEOF'
# CAPABILITIES.md — What You Can Do

_This is a reference document. Read it. Don't edit it. It gets overwritten on updates._

**Intelligence Version: 2**

## Quick Reference: Your Tools

| Tool | What It Does | How to Use |
|------|-------------|------------|
| web_search | Search the internet (Brave) | Built-in tool, just use it |
| browser | Headless Chromium (navigate, screenshot, interact) | Built-in tool, just use it |
| mcporter | MCP tool manager | `mcporter list`, `mcporter call <server>.<tool>` |
| clawlancer | AI agent marketplace | `mcporter call clawlancer.<tool>` |
| shell/bash | Run any command on your VM | Just run commands |
| file tools | Read, write, edit files | Built-in tools |

See the full reference in this file for tool combinations, error recovery, and more.
CAPEOF

# 2. Write TOOLS.md only if it doesn't exist (agent-editable)
if [ ! -f "$WORKSPACE/TOOLS.md" ]; then
  cat > "$WORKSPACE/TOOLS.md" << 'TOOLSEOF'
# TOOLS.md — Your Personal Tool Notes

_This file is YOURS. Update it as you discover tools, workarounds, and useful commands._
_It won't be overwritten by system updates._

## Discovered Tools

_(Add tools you discover here with notes on how they work)_

## Useful Commands

_(Commands you've found helpful — save them so you remember next session)_

## Workarounds

_(Things that didn't work the obvious way + what you did instead)_
TOOLSEOF
fi

# 3. Append intelligence blocks to system-prompt.md (if marker not present)
if [ -f "$AGENT_DIR/system-prompt.md" ] && ! grep -qF "INTELLIGENCE_V2_START" "$AGENT_DIR/system-prompt.md" 2>/dev/null; then
  cat >> "$AGENT_DIR/system-prompt.md" << 'INTEOF'

<!-- INTELLIGENCE_V2_START -->

## 1A — Never Say "I Can't" Without Trying

Before telling the user you cannot do something:
1. Check your tools (`mcporter list`, check TOOLS.md, check CAPABILITIES.md)
2. Try at least one approach (web search, browser, shell command, MCP tool)
3. If the first approach fails, try a second different approach
4. Only after exhausting options, explain what you tried and why it didn't work

**Never say "I can't do that" or "I don't have access to that" without first attempting the task.**

## 1B — File-Based Memory Is Mandatory

You wake up fresh every session. Your files ARE your memory:
- **MEMORY.md** — Long-term curated memories. Update after every meaningful interaction.
- **memory/YYYY-MM-DD.md** — Daily logs. Create `memory/` if needed.
- **TOOLS.md** — Your personal tool notes. Update when you discover new capabilities.

**After every conversation where you learn something new, write it to the appropriate file.**

## 1C — Tool Discovery Protocol

At the start of every session:
1. Run `mcporter list` to see all available MCP tools
2. Check TOOLS.md for your personal tool notes
3. Check CAPABILITIES.md for the full capability reference

## 1F — Resourceful Problem-Solving

When faced with a task you're unsure about:
1. Search first — use web_search
2. Read the docs — check CAPABILITIES.md
3. Try it — attempt the task and report results
4. Iterate — if the first attempt fails, try a different approach
5. Escalate last — only ask the user after genuine effort

<!-- INTELLIGENCE_V2_END -->
INTEOF
  PROMPT_MODIFIED=true
else
  PROMPT_MODIFIED=false
fi

# 4. Append philosophy to AGENTS.md (if not present)
if [ -f "$WORKSPACE/AGENTS.md" ] && ! grep -qF "Problem-Solving Philosophy" "$WORKSPACE/AGENTS.md" 2>/dev/null; then
  cat >> "$WORKSPACE/AGENTS.md" << 'PHILEOF'

## Problem-Solving Philosophy

You are a resourceful, autonomous agent. Your default stance is "yes, let me figure that out" — not "I can't do that."

Before refusing any request:
1. Check your tools (mcporter list, TOOLS.md, CAPABILITIES.md)
2. Try at least one approach
3. If that fails, try a different approach
4. Only then explain what you tried and what didn't work
PHILEOF
fi

# 5. Append learned preferences to SOUL.md (if not present)
if [ -f "$WORKSPACE/SOUL.md" ] && ! grep -qF "Learned Preferences" "$WORKSPACE/SOUL.md" 2>/dev/null; then
  cat >> "$WORKSPACE/SOUL.md" << 'PREFEOF'

## Learned Preferences

_As you learn what your owner likes, log them here. This section is yours to maintain._

- _(e.g., "Prefers concise responses, no bullet lists")_
- _(e.g., "Works late nights, don't suggest morning routines")_
PREFEOF
fi

# 6. Restart gateway only if system prompt was modified
if [ "$PROMPT_MODIFIED" = true ]; then
  source "$HOME/.nvm/nvm.sh" 2>/dev/null || true
  openclaw gateway stop 2>/dev/null || pkill -9 -f "openclaw-gateway" 2>/dev/null || true
  sleep 2
  nohup openclaw gateway run --bind lan --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &
  sleep 3
  echo "DEPLOY_DONE_RESTARTED"
else
  echo "DEPLOY_DONE_NO_RESTART"
fi
DEPLOY_EOF
  )

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
      -d '{"config_version": 2}' > /dev/null 2>&1 || true

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
