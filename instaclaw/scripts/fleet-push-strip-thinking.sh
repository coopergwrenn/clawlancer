#!/bin/bash
#
# fleet-push-strip-thinking.sh — Deploy updated strip-thinking.py to all VMs
#
# The updated script adds:
# 1. Session size enforcement (archives sessions > 512KB)
# 2. Tool result truncation (caps individual results at 8000 chars)
# 3. Archive cleanup (removes archives older than 7 days)
#
# This prevents the "Context overflow: prompt too large for the model" error
# that occurs when sessions grow unbounded due to large tool results.
#
# Usage:
#   ./instaclaw/scripts/fleet-push-strip-thinking.sh                    # All assigned VMs
#   ./instaclaw/scripts/fleet-push-strip-thinking.sh --canary 1.2.3.4   # Single VM
#   ./instaclaw/scripts/fleet-push-strip-thinking.sh --dry-run           # Show what would happen
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

SSH_KEY_FILE=$(mktemp /tmp/ic-fleet-strip-XXXXXX)
echo "$SSH_KEY_B64" | base64 -d > "$SSH_KEY_FILE" 2>/dev/null || echo "$SSH_KEY_B64" | base64 -D > "$SSH_KEY_FILE"
chmod 600 "$SSH_KEY_FILE"
trap "rm -f $SSH_KEY_FILE /tmp/ic-strip-thinking-fleet.py" EXIT

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
  VM_IPS_RAW=$(curl -s "${SUPABASE_URL}/rest/v1/instaclaw_vms?assigned_to=not.is.null&select=ip_address&health_status=neq.configure_failed" \
    -H "apikey: ${SUPABASE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_KEY}" \
    | python3 -c "import sys,json; [print(v['ip_address']) for v in json.load(sys.stdin)]" 2>/dev/null)

  VM_IPS=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && VM_IPS+=("$line")
  done <<< "$VM_IPS_RAW"
  echo "Found ${#VM_IPS[@]} VMs"
fi

# Write the updated strip-thinking.py locally
cat > /tmp/ic-strip-thinking-fleet.py << 'PYEOF'
#!/usr/bin/env python3
"""Strip thinking blocks, truncate tool results, and cap session sizes.

1. Strips thinking blocks from assistant messages (prevents "Invalid signature" errors)
2. Truncates individual tool results larger than MAX_TOOL_RESULT_CHARS
3. Archives sessions exceeding MAX_SESSION_BYTES (prevents context overflow)

CRITICAL FIX (2026-02-23): Added session size enforcement. Previously only
warned about oversized sessions but never cleaned them. This caused Renata's
bot to hit "Context overflow: prompt too large for the model" when a session
grew to 4.4MB (97% tool results) with 0 compactions.

Uses atomic write (write to .tmp then os.replace) which is safe even if the
gateway is actively appending to the file."""
import json, os, glob, subprocess, fcntl, time, shutil

SESSIONS_DIR = os.path.expanduser("~/.openclaw/agents/main/sessions")
SESSIONS_JSON = os.path.join(SESSIONS_DIR, "sessions.json")
ARCHIVE_DIR = os.path.join(SESSIONS_DIR, "archive")
LOCK_FILE = os.path.join(SESSIONS_DIR, ".strip-thinking.lock")
MAX_SESSION_BYTES = 524288   # 512KB — archive sessions larger than this
MAX_TOOL_RESULT_CHARS = 8000  # Truncate individual tool results over this

total_stripped = 0
total_truncated = 0
archived_sessions = []

# Acquire exclusive lock to prevent concurrent runs
try:
    lock_fd = open(LOCK_FILE, "w")
    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except (IOError, OSError):
    exit(0)  # another instance is running

try:
    for jsonl_file in glob.glob(os.path.join(SESSIONS_DIR, "*.jsonl")):
        file_size = os.path.getsize(jsonl_file)

        # Archive oversized sessions — prevents context overflow
        if file_size > MAX_SESSION_BYTES:
            session_id = os.path.basename(jsonl_file).replace(".jsonl", "")
            os.makedirs(ARCHIVE_DIR, exist_ok=True)
            archive_name = f"{session_id}-overflow-{time.strftime('%Y%m%d-%H%M%S')}.jsonl"
            shutil.copy2(jsonl_file, os.path.join(ARCHIVE_DIR, archive_name))
            os.remove(jsonl_file)
            archived_sessions.append(session_id)

            # Remove from sessions.json so gateway starts fresh
            try:
                with open(SESSIONS_JSON) as f:
                    sj = json.load(f)
                for key in list(sj.keys()):
                    if sj[key].get("sessionId") == session_id:
                        del sj[key]
                with open(SESSIONS_JSON, "w") as f:
                    json.dump(sj, f, indent=2)
            except Exception:
                pass
            continue

        modified = False
        cleaned_lines = []

        try:
            with open(jsonl_file) as f:
                for line in f:
                    try:
                        d = json.loads(line)
                        msg = d.get("message", {})

                        # Strip thinking blocks from assistant messages
                        if msg and msg.get("role") == "assistant":
                            content = msg.get("content", [])
                            if isinstance(content, list):
                                new_content = [b for b in content
                                               if not (isinstance(b, dict) and b.get("type") == "thinking")]
                                if len(new_content) != len(content):
                                    d["message"]["content"] = new_content
                                    total_stripped += len(content) - len(new_content)
                                    modified = True

                        # Truncate oversized tool results
                        if msg and msg.get("role") == "tool":
                            content = msg.get("content", [])
                            if isinstance(content, list):
                                for block in content:
                                    if isinstance(block, dict) and block.get("type") == "text":
                                        text = block.get("text", "")
                                        if len(text) > MAX_TOOL_RESULT_CHARS:
                                            block["text"] = text[:MAX_TOOL_RESULT_CHARS] + "\n... [truncated by session manager]"
                                            total_truncated += 1
                                            modified = True
                            elif isinstance(content, str) and len(content) > MAX_TOOL_RESULT_CHARS:
                                d["message"]["content"] = content[:MAX_TOOL_RESULT_CHARS] + "\n... [truncated by session manager]"
                                total_truncated += 1
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

    # Restart gateway if we archived sessions (forces fresh session)
    if archived_sessions:
        print(f"Archived {len(archived_sessions)} oversized session(s): {archived_sessions}")
        try:
            subprocess.run(["systemctl", "--user", "restart", "openclaw-gateway"], timeout=30)
            print("Gateway restarted after session archive")
        except Exception as e:
            print(f"Gateway restart failed: {e}")
    elif total_stripped > 0 or total_truncated > 0:
        print(f"Stripped {total_stripped} thinking blocks, truncated {total_truncated} tool results")
        # Only restart for thinking strip if gateway has been up >60min
        try:
            r = subprocess.run(
                ["systemctl", "--user", "show", "openclaw-gateway", "--property=ActiveEnterTimestamp"],
                capture_output=True, text=True, timeout=5
            )
            ts_str = r.stdout.strip().split("=", 1)[-1]
            if ts_str and ts_str != "n/a":
                from datetime import datetime, timezone
                ts = datetime.strptime(ts_str, "%a %Y-%m-%d %H:%M:%S %Z").replace(tzinfo=timezone.utc)
                uptime_mins = (datetime.now(timezone.utc) - ts).total_seconds() / 60
                if uptime_mins > 60:
                    print(f"Gateway uptime {uptime_mins:.0f}min > 60min, restarting to reload clean sessions")
                    subprocess.run(["systemctl", "--user", "restart", "openclaw-gateway"], timeout=30)
                else:
                    print(f"Gateway uptime {uptime_mins:.0f}min < 60min, skipping restart")
        except Exception as e:
            print(f"Restart check failed: {e}")

    # Clean up archives older than 7 days
    try:
        for f in glob.glob(os.path.join(ARCHIVE_DIR, "*.jsonl")):
            if time.time() - os.path.getmtime(f) > 7 * 86400:
                os.remove(f)
    except Exception:
        pass
finally:
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        lock_fd.close()
        os.unlink(LOCK_FILE)
    except Exception:
        pass
PYEOF

SUCCESS=0
FAIL=0
SKIP=0

for IP in "${VM_IPS[@]}"; do
  [[ -z "$IP" ]] && continue

  if $DRY_RUN; then
    echo "[DRY-RUN] Would push updated strip-thinking.py to $IP"
    ((SKIP++))
    continue
  fi

  echo -n "[$IP] "

  # SCP the script and verify
  if scp $SCP_OPTS /tmp/ic-strip-thinking-fleet.py "openclaw@${IP}:/home/openclaw/.openclaw/scripts/strip-thinking.py" > /dev/null 2>&1; then
    RESULT=$(ssh $SSH_OPTS "openclaw@${IP}" "chmod +x ~/.openclaw/scripts/strip-thinking.py && python3 -c \"import py_compile; py_compile.compile('/home/openclaw/.openclaw/scripts/strip-thinking.py', doraise=True)\" 2>&1 && echo OK" 2>&1)
    if echo "$RESULT" | grep -q "OK"; then
      echo "OK"
      ((SUCCESS++))
    else
      echo "FAIL (syntax): $(echo "$RESULT" | tail -1)"
      ((FAIL++))
    fi
  else
    echo "FAIL (scp)"
    ((FAIL++))
  fi
done

echo ""
echo "=== RESULTS ==="
echo "Success: $SUCCESS"
echo "Failed:  $FAIL"
echo "Skipped: $SKIP"
echo "Total:   ${#VM_IPS[@]}"
