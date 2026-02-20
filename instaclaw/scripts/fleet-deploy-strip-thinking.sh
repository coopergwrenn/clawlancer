#!/bin/bash
# Fleet-deploy thinking block stripping script to all assigned VMs.
# This is the permanent fix for "Invalid signature in thinking block" errors.
# Deploys the script + sets up a per-minute cron job on each VM.

set -euo pipefail

# Load env
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../../.env.local"
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: .env.local not found at $ENV_FILE"
  exit 1
fi

source "$ENV_FILE"

SSH_KEY="$HOME/.ssh/instaclaw"
SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes"

# Get all assigned VMs
echo "Fetching assigned VMs..."
VMS=$(curl -s "${NEXT_PUBLIC_SUPABASE_URL}/rest/v1/instaclaw_vms?select=id,name,ip_address,ssh_port,ssh_user&status=eq.assigned" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}")

VM_COUNT=$(echo "$VMS" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
echo "Found $VM_COUNT assigned VMs"

# The stripping script (embedded)
read -r -d '' STRIP_SCRIPT << 'PYEOF' || true
#!/usr/bin/env python3
"""Strip thinking blocks from OpenClaw session files.
Prevents 'Invalid signature in thinking block' errors by removing
thinking blocks after each API response. The model still thinks on
the current turn -- we only strip from saved history."""
import json, os, time, glob, sys

SESSIONS_DIR = os.path.expanduser("~/.openclaw/agents/main/sessions")
SKIP_IF_MODIFIED_WITHIN = 10  # seconds -- avoid race with active writes

total_stripped = 0

for jsonl_file in glob.glob(os.path.join(SESSIONS_DIR, "*.jsonl")):
    mtime = os.path.getmtime(jsonl_file)
    if time.time() - mtime < SKIP_IF_MODIFIED_WITHIN:
        continue

    modified = False
    cleaned_lines = []

    try:
        with open(jsonl_file) as f:
            for line in f:
                try:
                    d = json.loads(line)
                    msg = d.get("message", {})
                    if msg and msg.get("role") == "assistant":
                        content = msg.get("content", [])
                        if isinstance(content, list):
                            new_content = [b for b in content
                                           if not (isinstance(b, dict) and b.get("type") == "thinking")]
                            if len(new_content) != len(content):
                                d["message"]["content"] = new_content
                                total_stripped += len(content) - len(new_content)
                                modified = True
                    cleaned_lines.append(json.dumps(d, ensure_ascii=False))
                except json.JSONDecodeError:
                    cleaned_lines.append(line.rstrip("\n"))

        if modified:
            tmp = jsonl_file + ".tmp"
            with open(tmp, "w") as f:
                for cl in cleaned_lines:
                    f.write(cl + "\n")
            os.replace(tmp, jsonl_file)
    except Exception:
        pass  # never crash the cron

if total_stripped > 0:
    print(f"Stripped {total_stripped} thinking blocks")
PYEOF

SCRIPT_B64=$(echo "$STRIP_SCRIPT" | base64)

SUCCESS=0
FAIL=0

# Process each VM
echo "$VMS" | python3 -c "
import json, sys
vms = json.load(sys.stdin)
for vm in vms:
    print(f\"{vm['ip_address']}|{vm.get('ssh_port', 22)}|{vm.get('ssh_user', 'openclaw')}|{vm.get('name', vm['id'])}\")
" > /tmp/strip-deploy-vms.txt

while IFS='|' read -r IP PORT USER NAME; do
  echo -n "  $NAME ($IP)... "

  if ssh $SSH_OPTS -p "$PORT" "$USER@$IP" "
    mkdir -p ~/.openclaw/scripts && \
    echo '$SCRIPT_B64' | base64 -d > ~/.openclaw/scripts/strip-thinking.py && \
    chmod +x ~/.openclaw/scripts/strip-thinking.py && \
    (crontab -l 2>/dev/null | grep -qF 'strip-thinking.py' || \
      (crontab -l 2>/dev/null; echo '* * * * * python3 ~/.openclaw/scripts/strip-thinking.py > /dev/null 2>&1') | crontab -) && \
    python3 ~/.openclaw/scripts/strip-thinking.py
  " < /dev/null 2>/dev/null; then
    echo "OK"
    SUCCESS=$((SUCCESS + 1))
  else
    echo "FAIL"
    FAIL=$((FAIL + 1))
  fi
done < /tmp/strip-deploy-vms.txt

rm -f /tmp/strip-deploy-vms.txt

echo ""
echo "Done: $SUCCESS succeeded, $FAIL failed out of $VM_COUNT VMs"
