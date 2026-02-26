#!/bin/bash
#
# fleet-push-memory-instructions.sh — Add memory persistence instructions to SOUL.md
#
# Usage:
#   ./instaclaw/scripts/fleet-push-memory-instructions.sh                    # All assigned VMs
#   ./instaclaw/scripts/fleet-push-memory-instructions.sh --canary 1.2.3.4   # Single VM
#   ./instaclaw/scripts/fleet-push-memory-instructions.sh --dry-run           # Show what would happen
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env.local"
SSH_ENV_FILE="${SCRIPT_DIR}/../.env.ssh-key"

CANARY_IP=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --canary) CANARY_IP="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    *) echo "Unknown: $1"; exit 1 ;;
  esac
done

# Load SSH key
if [[ -f "$SSH_ENV_FILE" ]]; then
  SSH_KEY_B64=$(grep "SSH_PRIVATE_KEY_B64" "$SSH_ENV_FILE" | sed 's/SSH_PRIVATE_KEY_B64="//' | sed 's/"$//')
else
  echo "ERROR: $SSH_ENV_FILE not found"; exit 1
fi

SSH_KEY_FILE=$(mktemp /tmp/ic-fleet-mem-XXXXXX)
echo "$SSH_KEY_B64" | base64 -d > "$SSH_KEY_FILE" 2>/dev/null || echo "$SSH_KEY_B64" | base64 -D > "$SSH_KEY_FILE"
chmod 600 "$SSH_KEY_FILE"
trap "rm -f $SSH_KEY_FILE /tmp/ic-inject-memory.py" EXIT

SSH_OPTS="-i $SSH_KEY_FILE -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o ServerAliveInterval=15"
SCP_OPTS="-i $SSH_KEY_FILE -o StrictHostKeyChecking=no -o ConnectTimeout=10"

# Load Supabase creds
source "$ENV_FILE" 2>/dev/null || true
SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL}"
SUPABASE_KEY="${SUPABASE_SERVICE_ROLE_KEY}"

# Get VM IPs
if [[ -n "$CANARY_IP" ]]; then
  VM_IPS=("$CANARY_IP")
  echo "=== Canary mode: $CANARY_IP ==="
else
  echo "=== Fetching assigned VMs ==="
  VM_IPS_RAW=$(curl -s "${SUPABASE_URL}/rest/v1/instaclaw_vms?gateway_token=not.is.null&select=ip_address&health_status=neq.configure_failed" \
    -H "apikey: ${SUPABASE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_KEY}" \
    | python3 -c "import sys,json; [print(v['ip_address']) for v in json.load(sys.stdin)]" 2>/dev/null)

  VM_IPS=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && VM_IPS+=("$line")
  done <<< "$VM_IPS_RAW"
  echo "Found ${#VM_IPS[@]} VMs"
fi

# Write the injector script locally
cat > /tmp/ic-inject-memory.py << 'PYEOF'
#!/usr/bin/env python3
"""Inject Memory Persistence section into SOUL.md."""
import os, sys

SOUL_PATH = os.path.expanduser("~/.openclaw/workspace/SOUL.md")
TASKS_PATH = os.path.expanduser("~/.openclaw/workspace/memory/active-tasks.md")

SECTION = """## Memory Persistence (CRITICAL)

**You forget everything when sessions rotate or the gateway restarts.** Your ONLY continuity is your workspace files. Treat writing to memory like saving your game — do it often or lose progress.

**After completing any task:**
1. Write a 2-3 sentence summary to `MEMORY.md` under a dated heading
2. Include: what was done, key decisions, and anything needed for follow-up
3. If the task is ongoing, write current status to `memory/active-tasks.md`

**At the end of every conversation (when the user goes quiet for a while):**
1. Update `memory/YYYY-MM-DD.md` with a summary of what happened today
2. If any tasks are in progress, update `memory/active-tasks.md`
3. If you learned something important about the user, add it to MEMORY.md

**When you wake up in a new session:**
1. Read MEMORY.md and memory/active-tasks.md FIRST
2. If active-tasks.md has in-progress work, pick up where you left off
3. Reference what you remember naturally — don't say "according to my files"

**Format for MEMORY.md entries:**
```
## YYYY-MM-DD — [Brief title]
[2-3 sentences: what happened, decisions made, follow-up needed]
```

**Format for active-tasks.md:**
```
# Active Tasks

## [Task name]
- Status: in-progress / waiting / blocked
- Context: [what is this about]
- Next step: [specific next action]
- Last updated: YYYY-MM-DD HH:MM
```

This is not optional. If you complete a task and don't log it, you WILL forget it next session.
"""

if not os.path.exists(SOUL_PATH):
    print("SKIP: no SOUL.md")
    sys.exit(0)

with open(SOUL_PATH) as f:
    content = f.read()

if "Memory Persistence (CRITICAL)" in content:
    print("SKIP: already present")
    sys.exit(0)

# Insert before "## Continuity" if it exists
if "## Continuity" in content:
    content = content.replace("## Continuity", SECTION + "\n## Continuity")
    print("OK: inserted before Continuity")
elif "## Learned Preferences" in content:
    content = content.replace("## Learned Preferences", SECTION + "\n## Learned Preferences")
    print("OK: inserted before Learned Preferences")
else:
    content += "\n" + SECTION
    print("OK: appended to end")

with open(SOUL_PATH, "w") as f:
    f.write(content)

# Create active-tasks.md if missing
if not os.path.exists(TASKS_PATH):
    os.makedirs(os.path.dirname(TASKS_PATH), exist_ok=True)
    with open(TASKS_PATH, "w") as f:
        f.write("# Active Tasks\n\n_No active tasks. Update this file when working on something._\n")
    print(" + created active-tasks.md")
PYEOF

SUCCESS=0
FAIL=0
SKIP=0

for IP in "${VM_IPS[@]}"; do
  [[ -z "$IP" ]] && continue

  if $DRY_RUN; then
    echo "[DRY-RUN] Would push memory instructions to $IP"
    ((SKIP++))
    continue
  fi

  echo -n "[$IP] "

  # SCP the script, run it, clean up
  scp $SCP_OPTS /tmp/ic-inject-memory.py "openclaw@${IP}:/tmp/ic-inject-memory.py" > /dev/null 2>&1
  RESULT=$(ssh $SSH_OPTS "openclaw@${IP}" "python3 /tmp/ic-inject-memory.py; rm -f /tmp/ic-inject-memory.py" 2>&1)

  STATUS=$(echo "$RESULT" | grep -E "^(OK|SKIP)" | head -1)
  if [[ -n "$STATUS" ]]; then
    echo "$STATUS"
    ((SUCCESS++))
  else
    echo "FAIL: $(echo "$RESULT" | tail -1)"
    ((FAIL++))
  fi
done

echo ""
echo "=== RESULTS ==="
echo "Success: $SUCCESS"
echo "Failed:  $FAIL"
echo "Skipped: $SKIP"
echo "Total:   ${#VM_IPS[@]}"
