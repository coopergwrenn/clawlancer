#!/bin/bash
#
# fleet-push-strip-thinking.sh — Deploy updated strip-thinking.py to all VMs
#
# The updated script adds:
# 1. Session size enforcement (archives sessions > 512KB)
# 2. Tool result truncation (caps individual results at 8000 chars)
# 3. Archive cleanup (removes archives older than 7 days)
# 4. Layer 1: Pre-rotation memory write enforcement (injects into MEMORY.md at 400KB)
# 5. Layer 2: Memory staleness detection (24h+ without MEMORY.md update)
#
# This prevents context loss when sessions get archived, and ensures agents
# maintain their long-term memory across session rotations.
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
"""Strip thinking blocks, truncate tool results, cap session sizes, and enforce memory persistence.

1. Strips thinking blocks from assistant messages (prevents "Invalid signature" errors)
2. Truncates individual tool results larger than MAX_TOOL_RESULT_CHARS
3. Archives sessions exceeding MAX_SESSION_BYTES (prevents context overflow)
4. Layer 1: Pre-rotation memory write enforcement (injects into MEMORY.md at 400KB)
5. Layer 2: Memory staleness detection (24h+ without MEMORY.md update)

Uses atomic write (write to .tmp then os.replace) which is safe even if the
gateway is actively appending to the file."""
import json, os, glob, subprocess, fcntl, time, shutil
from datetime import datetime, timezone

SESSIONS_DIR = os.path.expanduser("~/.openclaw/agents/main/sessions")
SESSIONS_JSON = os.path.join(SESSIONS_DIR, "sessions.json")
ARCHIVE_DIR = os.path.join(SESSIONS_DIR, "archive")
LOCK_FILE = os.path.join(SESSIONS_DIR, ".strip-thinking.lock")
MAX_SESSION_BYTES = 524288   # 512KB — archive sessions larger than this
MEMORY_WARN_BYTES = 409600   # 400KB (80% of max) — trigger memory write request
MAX_TOOL_RESULT_CHARS = 8000  # Truncate individual tool results over this

# Workspace paths
WORKSPACE_DIR = os.path.expanduser("~/.openclaw/workspace")
MEMORY_MD = os.path.join(WORKSPACE_DIR, "MEMORY.md")
ACTIVE_TASKS_MD = os.path.join(WORKSPACE_DIR, "memory/active-tasks.md")

# Flag files (stored in sessions dir alongside .jsonl files)
MEMORY_FLAG = os.path.join(SESSIONS_DIR, ".memory-write-pending")
STALE_FLAG = os.path.join(SESSIONS_DIR, ".memory-stale-notified")

# Timing constants
MEMORY_FLAG_TTL = 300    # 5 minutes before giving up on memory write
STALE_HOURS = 24         # Memory considered stale after this many hours
STALE_MIN_SESSION_KB = 50  # Minimum session size (KB) to trigger staleness check

# MEMORY.md injection markers
MEM_URGENT_START = "<!-- INSTACLAW:MEMORY_WRITE_URGENT:START -->"
MEM_URGENT_END = "<!-- INSTACLAW:MEMORY_WRITE_URGENT:END -->"
MEM_STALE_START = "<!-- INSTACLAW:MEMORY_STALE:START -->"
MEM_STALE_END = "<!-- INSTACLAW:MEMORY_STALE:END -->"

MEM_URGENT_CONTENT = """
## \u26a0\ufe0f SESSION ROTATION IMMINENT \u2014 WRITE YOUR MEMORIES NOW

Your session file is at 80% capacity and WILL be archived soon (all context lost).

**You MUST do this RIGHT NOW before your next regular response:**
1. Update MEMORY.md with a structured summary:
   - Active projects and their current status
   - Key decisions made in this session
   - User preferences and patterns you have learned
   - Any pending tasks or commitments
2. Update memory/active-tasks.md if any tasks are in progress
3. After writing, continue your normal work

**Format your MEMORY.md entry like this:**
```
## [Today's Date] - Session Summary
### Active Projects
- [project]: [status, next steps]
### Key Decisions
- [decision and reasoning]
### Learned Preferences
- [preference]
```

This section will be automatically removed after you update MEMORY.md.
"""

MEM_STALE_CONTENT = """
## \u26a0\ufe0f MEMORY MAINTENANCE REQUIRED

Your MEMORY.md has not been updated in over 24 hours. Memory loss is the #1
complaint from users. Write a structured update NOW.

**Include:**
- Current project statuses
- Recent conversation summaries (key points, not transcripts)
- User preferences you have learned
- Any pending or in-progress tasks

Update memory/active-tasks.md too if applicable.

This section will be automatically removed after you update MEMORY.md.
"""

def inject_memory_section(path, marker_start, marker_end, content):
    """Append a clearly-marked section to MEMORY.md if not already present."""
    try:
        existing = ""
        if os.path.exists(path):
            with open(path) as f:
                existing = f.read()
        if marker_start in existing:
            return  # already injected
        new_content = existing.rstrip() + "\n\n" + marker_start + content + marker_end + "\n"
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            f.write(new_content)
        os.replace(tmp, path)
    except Exception as e:
        print(f"inject_memory_section failed: {e}")

def remove_memory_section(path, marker_start, marker_end):
    """Remove an injected section from MEMORY.md by marker strings."""
    try:
        if not os.path.exists(path):
            return
        with open(path) as f:
            content = f.read()
        if marker_start not in content:
            return
        start_idx = content.find(marker_start)
        end_idx = content.find(marker_end)
        if start_idx == -1 or end_idx == -1:
            return
        # Remove the section plus any surrounding blank lines
        before = content[:start_idx].rstrip()
        after = content[end_idx + len(marker_end):].lstrip()
        new_content = before + ("\n\n" + after if after else "\n")
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            f.write(new_content)
        os.replace(tmp, path)
    except Exception as e:
        print(f"remove_memory_section failed: {e}")

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
    largest_active_session = 0

    for jsonl_file in glob.glob(os.path.join(SESSIONS_DIR, "*.jsonl")):
        file_size = os.path.getsize(jsonl_file)
        session_id = os.path.basename(jsonl_file).replace(".jsonl", "")

        # ── Phase 1: Archive oversized sessions (>512KB) ──
        if file_size > MAX_SESSION_BYTES:
            os.makedirs(ARCHIVE_DIR, exist_ok=True)
            archive_name = f"{session_id}-overflow-{time.strftime('%Y%m%d-%H%M%S')}.jsonl"
            archive_path = os.path.join(ARCHIVE_DIR, archive_name)
            shutil.copy2(jsonl_file, archive_path)

            # Save archive metadata with memory compliance info
            try:
                line_count = 0
                with open(jsonl_file) as f:
                    for _ in f:
                        line_count += 1
                mem_size = os.path.getsize(MEMORY_MD) if os.path.exists(MEMORY_MD) else 0
                mem_mtime = datetime.fromtimestamp(os.path.getmtime(MEMORY_MD), tz=timezone.utc).isoformat() if os.path.exists(MEMORY_MD) else None
                flag_existed = os.path.exists(MEMORY_FLAG)
                # Check if agent complied: MEMORY.md mtime > flag mtime
                complied = False
                if flag_existed and os.path.exists(MEMORY_MD):
                    complied = os.path.getmtime(MEMORY_MD) > os.path.getmtime(MEMORY_FLAG)
                meta = {
                    "archive_reason": "size_exceeded",
                    "archived_at": datetime.now(timezone.utc).isoformat(),
                    "session_line_count": line_count,
                    "session_size_bytes": file_size,
                    "memory_md_size_bytes": mem_size,
                    "memory_md_last_modified": mem_mtime,
                    "active_tasks_exists": os.path.exists(ACTIVE_TASKS_MD),
                    "memory_write_requested": flag_existed,
                    "memory_write_complied": complied,
                }
                meta_path = os.path.join(ARCHIVE_DIR, f"{session_id}.meta.json")
                with open(meta_path, "w") as f:
                    json.dump(meta, f, indent=2)
            except Exception:
                pass

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

            # Clean up flags and injected sections
            for flag in [MEMORY_FLAG, STALE_FLAG]:
                try:
                    if os.path.exists(flag):
                        os.remove(flag)
                except Exception:
                    pass
            remove_memory_section(MEMORY_MD, MEM_URGENT_START, MEM_URGENT_END)
            remove_memory_section(MEMORY_MD, MEM_STALE_START, MEM_STALE_END)
            continue

        # Track largest active session for Layer 2 staleness check
        if file_size > largest_active_session:
            largest_active_session = file_size

        # ── Phase 2: Memory write enforcement (400KB-512KB) ──
        if file_size > MEMORY_WARN_BYTES:
            if not os.path.exists(MEMORY_FLAG):
                # First time crossing threshold — create flag and inject urgent message
                with open(MEMORY_FLAG, "w") as f:
                    f.write(str(time.time()))
                inject_memory_section(MEMORY_MD, MEM_URGENT_START, MEM_URGENT_END, MEM_URGENT_CONTENT)
                print(f"Memory write requested for session {session_id} ({file_size} bytes)")
            else:
                # Flag already exists — check compliance or timeout
                flag_mtime = os.path.getmtime(MEMORY_FLAG)
                mem_mtime = os.path.getmtime(MEMORY_MD) if os.path.exists(MEMORY_MD) else 0

                if mem_mtime > flag_mtime:
                    # Agent complied — MEMORY.md was updated after flag was created
                    print(f"Memory write compliance confirmed for session {session_id}")
                    os.remove(MEMORY_FLAG)
                    remove_memory_section(MEMORY_MD, MEM_URGENT_START, MEM_URGENT_END)
                elif time.time() - flag_mtime > MEMORY_FLAG_TTL:
                    # Timed out — agent didn't comply within 5 minutes
                    print(f"Memory write timed out for session {session_id} (flag age: {time.time() - flag_mtime:.0f}s)")
                    os.remove(MEMORY_FLAG)
                    remove_memory_section(MEMORY_MD, MEM_URGENT_START, MEM_URGENT_END)
                # else: still waiting, do nothing

        # ── Phase 3: Normal processing (strip thinking + truncate) ──
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

    # ── Layer 2: Memory staleness check (runs AFTER session loop) ──
    try:
        mem_exists = os.path.exists(MEMORY_MD)
        mem_mtime = os.path.getmtime(MEMORY_MD) if mem_exists else 0
        hours_since_update = (time.time() - mem_mtime) / 3600 if mem_exists else float("inf")
        min_session_bytes = STALE_MIN_SESSION_KB * 1024

        if hours_since_update > STALE_HOURS and largest_active_session > min_session_bytes and not os.path.exists(STALE_FLAG):
            # Memory is stale and there's active session content
            inject_memory_section(MEMORY_MD, MEM_STALE_START, MEM_STALE_END, MEM_STALE_CONTENT)
            with open(STALE_FLAG, "w") as f:
                f.write(str(time.time()))
            print(f"Memory stale notification injected (last update: {hours_since_update:.1f}h ago, largest session: {largest_active_session} bytes)")
        elif os.path.exists(STALE_FLAG):
            # Check if agent complied
            flag_mtime = os.path.getmtime(STALE_FLAG)
            if mem_exists and os.path.getmtime(MEMORY_MD) > flag_mtime:
                os.remove(STALE_FLAG)
                remove_memory_section(MEMORY_MD, MEM_STALE_START, MEM_STALE_END)
                print("Memory stale notification cleared — agent updated MEMORY.md")
    except Exception as e:
        print(f"Staleness check failed: {e}")

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
        for f in glob.glob(os.path.join(ARCHIVE_DIR, "*.meta.json")):
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
