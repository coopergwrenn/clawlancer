#!/bin/bash
# session-heal-cron.sh — Auto-detect and fix corrupted OpenClaw session files
# Runs every 60s via crontab. Detects filename/header ID mismatches,
# archives corrupted files, and restarts the gateway with debounce.
#
# Deployed by InstaClaw fleet management. Do NOT edit on-VM.
# Version: 1.0.0

set -euo pipefail

SESSIONS_DIR="$HOME/.openclaw/agents/main/sessions"
HEAL_LOG="/tmp/session-heal.log"
DEBOUNCE_FILE="/tmp/session-heal-last-restart"
DEBOUNCE_SECS=120  # Don't restart if restarted in last 2 minutes

export XDG_RUNTIME_DIR="/run/user/$(id -u)"

log() {
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') $1" >> "$HEAL_LOG"
}

# Exit if sessions dir doesn't exist
[ -d "$SESSIONS_DIR" ] || exit 0

corrupted=0
corrupted_files=""

for f in "$SESSIONS_DIR"/*.jsonl; do
  [ -f "$f" ] || continue

  filename=$(basename "$f" .jsonl)
  # Read first line, extract session ID from JSON header
  header_id=$(head -1 "$f" 2>/dev/null | python3 -c '
import sys, json
try:
    d = json.loads(sys.stdin.read())
    if d.get("type") == "session":
        print(d.get("id", ""))
    else:
        print("")
except:
    print("PARSE_FAIL")
' 2>/dev/null || echo "PARSE_FAIL")

  # Skip if header couldn't be parsed (might be empty/new file)
  [ -z "$header_id" ] && continue
  [ "$header_id" = "PARSE_FAIL" ] && continue

  # Check for mismatch
  if [ "$filename" != "$header_id" ]; then
    corrupted=$((corrupted + 1))
    corrupted_files="$corrupted_files $filename"
    log "CORRUPTED: file=$filename header=$header_id"

    # Archive the corrupted file
    archive_dir="$SESSIONS_DIR/archive/auto-heal-$(date +%Y%m%d)"
    mkdir -p "$archive_dir"
    mv "$f" "$archive_dir/" 2>/dev/null || true
    # Also move any associated archived files
    mv "${f}.archived" "$archive_dir/" 2>/dev/null || true
    mv "${f}.reset."* "$archive_dir/" 2>/dev/null || true
    log "ARCHIVED: $filename -> $archive_dir/"
  fi
done

# If no corruption found, exit
[ "$corrupted" -eq 0 ] && exit 0

# Debounce: don't restart if we restarted recently
if [ -f "$DEBOUNCE_FILE" ]; then
  last_restart=$(cat "$DEBOUNCE_FILE" 2>/dev/null || echo "0")
  now=$(date +%s)
  elapsed=$((now - last_restart))
  if [ "$elapsed" -lt "$DEBOUNCE_SECS" ]; then
    log "DEBOUNCE: skipping restart (${elapsed}s since last, threshold=${DEBOUNCE_SECS}s)"
    exit 0
  fi
fi

# Restart gateway
log "RESTARTING: found $corrupted corrupted session file(s):$corrupted_files"
systemctl --user restart openclaw-gateway 2>/dev/null || true
date +%s > "$DEBOUNCE_FILE"

# Wait for gateway to come back
for i in $(seq 1 15); do
  sleep 2
  status=$(systemctl --user is-active openclaw-gateway 2>/dev/null || echo "unknown")
  if [ "$status" = "active" ]; then
    log "HEALED: gateway restarted successfully after ${i}x2s"
    exit 0
  fi
done

log "WARN: gateway did not reach active state after 30s"
