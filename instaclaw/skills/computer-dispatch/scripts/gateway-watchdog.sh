#!/bin/bash
# gateway-watchdog.sh — Auto-restart gateway if hung, stuck, or context overflowing
# Runs every 2 minutes via systemd timer.
#
# Checks:
#   1. Session size cap (>500KB = context overflow imminent, immediate archive + restart)
#   2. Gateway health endpoint (HTTP 200)
#   3. Gateway process alive
#   4. Frozen gateway (process alive, health OK, but no log activity for 3+ min
#      AND session file modified recently = message received but never responded)
#
# Two consecutive failures on checks 2-3 = restart.
# Check 1 (session cap) and check 4 (frozen) = immediate restart.

set -euo pipefail
export XDG_RUNTIME_DIR="/run/user/$(id -u)"

STATE_FILE="/tmp/gateway-watchdog-state"
LOG="$HOME/watchdog.log"
HEALTH_URL="http://localhost:18789/health"
SESSION_FILE="$HOME/.openclaw/agents/main/sessions/sessions.json"
APP_LOG="/tmp/openclaw/openclaw-$(date -u +%Y-%m-%d).log"
MAX_SESSION_KB=500
MAX_LOG_LINES=500

log() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $1" >> "$LOG"
}

# Rotate log
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG" 2>/dev/null || echo 0)" -gt "$MAX_LOG_LINES" ]; then
  tail -200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

FAILURES=0
if [ -f "$STATE_FILE" ]; then
  FAILURES=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
fi

# ── Check 1: Session size cap (IMMEDIATE) ──
if [ -f "$SESSION_FILE" ]; then
  SESSION_KB=$(du -k "$SESSION_FILE" 2>/dev/null | cut -f1)
  if [ "${SESSION_KB:-0}" -gt "$MAX_SESSION_KB" ]; then
    log "SESSION_OVERFLOW: ${SESSION_KB}KB > ${MAX_SESSION_KB}KB — archiving and restarting"
    cp "$SESSION_FILE" "${SESSION_FILE}.$(date +%s).bak" 2>/dev/null || true
    echo "[]" > "$SESSION_FILE"
    ls -1t "${SESSION_FILE}".*.bak 2>/dev/null | tail -n +6 | xargs rm -f 2>/dev/null || true
    systemctl --user restart openclaw-gateway 2>/dev/null
    sleep 8
    log "SESSION_RECOVERED: gateway restarted with fresh context"
    echo 0 > "$STATE_FILE"
    exit 0
  fi
fi

# ── Check 2: Health endpoint ──
HEALTH_OK=false
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 "$HEALTH_URL" 2>/dev/null || echo "000")
[ "$HTTP_CODE" = "200" ] && HEALTH_OK=true

# ── Check 3: Process alive ──
PROC_OK=false
systemctl --user is-active openclaw-gateway > /dev/null 2>&1 && PROC_OK=true

# ── Check 4: Frozen gateway detection ──
# The gateway can be "alive" (health 200) but stuck on a hung LLM API call.
# Detect this by checking: has the app log had any telegram sendMessage in the last 3 min?
# AND has the session file been modified in the last 5 min (meaning a message was received)?
FROZEN=false
if [ "$HEALTH_OK" = true ] && [ "$PROC_OK" = true ]; then
  # Check if session was modified in the last 5 minutes (= message received)
  SESSION_RECENTLY_MODIFIED=false
  if [ -f "$SESSION_FILE" ]; then
    SESSION_AGE=$(( $(date +%s) - $(stat -c %Y "$SESSION_FILE" 2>/dev/null || echo 0) ))
    [ "$SESSION_AGE" -lt 300 ] && SESSION_RECENTLY_MODIFIED=true
  fi

  # Check if any sendMessage happened in last 3 minutes (in app log, not journal)
  RECENT_SEND=0
  if [ -f "$APP_LOG" ]; then
    THREE_MIN_AGO=$(date -u -d "3 minutes ago" +%Y-%m-%dT%H:%M 2>/dev/null || date -u +%Y-%m-%dT%H:%M)
    RECENT_SEND=$(tail -500 "$APP_LOG" 2>/dev/null | grep -c "sendMessage ok" || echo 0)
    # More precise: check only lines from the last 3 minutes
    # Use the timestamp in the log entries
    NOW_TS=$(date +%s)
    if [ "$RECENT_SEND" -gt 0 ]; then
      # Check if the LAST sendMessage was within 3 minutes
      LAST_SEND_LINE=$(tail -500 "$APP_LOG" 2>/dev/null | grep "sendMessage ok" | tail -1)
      if [ -n "$LAST_SEND_LINE" ]; then
        LAST_SEND_TIME=$(echo "$LAST_SEND_LINE" | grep -o '"time":"[^"]*"' | cut -d'"' -f4 | head -1)
        if [ -n "$LAST_SEND_TIME" ]; then
          LAST_SEND_TS=$(date -d "$LAST_SEND_TIME" +%s 2>/dev/null || echo 0)
          SEND_AGE=$(( NOW_TS - LAST_SEND_TS ))
          [ "$SEND_AGE" -gt 180 ] && RECENT_SEND=0  # Last send was >3 min ago
        fi
      fi
    fi
  fi

  # Frozen = session modified recently (message received) but no send in 3 min
  if [ "$SESSION_RECENTLY_MODIFIED" = true ] && [ "$RECENT_SEND" -eq 0 ]; then
    FROZEN=true
  fi
fi

# ── Decision ──
if [ "$HEALTH_OK" = true ] && [ "$PROC_OK" = true ] && [ "$FROZEN" = false ]; then
  echo 0 > "$STATE_FILE"
  exit 0
fi

# Something is wrong
FAILURES=$((FAILURES + 1))
echo "$FAILURES" > "$STATE_FILE"

REASON=""
[ "$HEALTH_OK" = false ] && REASON="health_failed(HTTP $HTTP_CODE)"
[ "$PROC_OK" = false ] && REASON="process_dead"
[ "$FROZEN" = true ] && REASON="frozen(session_modified=yes,last_send>3min)"

# Frozen detection = immediate restart (don't wait for 2 failures — user is waiting)
if [ "$FROZEN" = true ]; then
  log "FROZEN: $REASON — immediate restart (user is seeing typing indicator)"
  # Also archive session if it's over 200KB (may be contributing to the hang)
  if [ -f "$SESSION_FILE" ]; then
    SESSION_KB=$(du -k "$SESSION_FILE" 2>/dev/null | cut -f1)
    if [ "${SESSION_KB:-0}" -gt 200 ]; then
      log "  Archiving session (${SESSION_KB}KB)"
      cp "$SESSION_FILE" "${SESSION_FILE}.$(date +%s).bak" 2>/dev/null || true
      echo "[]" > "$SESSION_FILE"
    fi
  fi
  systemctl --user restart openclaw-gateway 2>/dev/null
  sleep 8
  systemctl --user is-active openclaw-gateway > /dev/null 2>&1 && log "RECOVERED: gateway restarted" || log "FAILED: gateway did not restart"
  echo 0 > "$STATE_FILE"
  exit 0
fi

if [ "$FAILURES" -lt 2 ]; then
  log "WARNING: $REASON (failure $FAILURES/2)"
  exit 0
fi

# Two consecutive failures for health/process — restart
log "RESTART: $REASON (failures=$FAILURES)"
systemctl --user restart openclaw-gateway 2>/dev/null
sleep 8
systemctl --user is-active openclaw-gateway > /dev/null 2>&1 && log "RECOVERED: gateway restarted" || log "FAILED: gateway did not restart"
echo 0 > "$STATE_FILE"
