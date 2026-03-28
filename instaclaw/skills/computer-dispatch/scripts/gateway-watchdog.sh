#!/bin/bash
# gateway-watchdog.sh v4 — Auto-restart gateway if hung, stuck, or Telegram disconnected
# Runs every 2 minutes via systemd timer.
#
# Checks:
#   1. Session size cap (>500KB → immediate archive + restart)
#   2. Gateway health endpoint (HTTP 200)
#   3. Gateway process alive
#   4. Frozen gateway (session modified recently but no sendMessage in 3 min)
#   5. Dead Telegram (gateway running 10+ min but zero Telegram activity in app log)
#
# Each check that fails = immediate or 2-consecutive-failure restart.

set -euo pipefail
export XDG_RUNTIME_DIR="/run/user/$(id -u)"

STATE_FILE="/tmp/gateway-watchdog-state"
LOG="$HOME/watchdog.log"
HEALTH_URL="http://localhost:18789/health"
SESSION_FILE="$HOME/.openclaw/agents/main/sessions/sessions.json"
APP_LOG_DIR="/tmp/openclaw"
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
[ -f "$STATE_FILE" ] && FAILURES=$(cat "$STATE_FILE" 2>/dev/null || echo 0)

do_restart() {
  local REASON="$1"
  local ARCHIVE_SESSION="${2:-false}"
  log "RESTART: $REASON"
  if [ "$ARCHIVE_SESSION" = "true" ] && [ -f "$SESSION_FILE" ]; then
    local SK=$(du -k "$SESSION_FILE" 2>/dev/null | cut -f1)
    log "  Archiving session (${SK}KB)"
    cp "$SESSION_FILE" "${SESSION_FILE}.$(date +%s).bak" 2>/dev/null || true
    echo "[]" > "$SESSION_FILE"
    ls -1t "${SESSION_FILE}".*.bak 2>/dev/null | tail -n +6 | xargs rm -f 2>/dev/null || true
  fi
  systemctl --user restart openclaw-gateway 2>/dev/null
  sleep 8
  if systemctl --user is-active openclaw-gateway > /dev/null 2>&1; then
    log "RECOVERED: gateway restarted"
  else
    log "FAILED: gateway did not restart"
  fi
  echo 0 > "$STATE_FILE"
}

# ── Check 1: Session size cap (IMMEDIATE) ──
if [ -f "$SESSION_FILE" ]; then
  SESSION_KB=$(du -k "$SESSION_FILE" 2>/dev/null | cut -f1)
  if [ "${SESSION_KB:-0}" -gt "$MAX_SESSION_KB" ]; then
    do_restart "SESSION_OVERFLOW(${SESSION_KB}KB)" "true"
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

# ── Check 4: Frozen gateway (session modified but no response sent) ──
FROZEN=false
if [ "$HEALTH_OK" = true ] && [ "$PROC_OK" = true ] && [ -f "$SESSION_FILE" ]; then
  SESSION_AGE=$(( $(date +%s) - $(stat -c %Y "$SESSION_FILE" 2>/dev/null || echo 0) ))
  if [ "$SESSION_AGE" -lt 300 ]; then
    # Session was modified in last 5 min — check if any sendMessage happened
    TODAY=$(date -u +%Y-%m-%d)
    LAST_SEND=0
    if [ -f "$APP_LOG_DIR/openclaw-$TODAY.log" ]; then
      LAST_SEND_LINE=$(tail -1000 "$APP_LOG_DIR/openclaw-$TODAY.log" 2>/dev/null | grep "sendMessage ok" | tail -1)
      if [ -n "$LAST_SEND_LINE" ]; then
        SEND_TIME=$(echo "$LAST_SEND_LINE" | grep -oP '"time":"[^"]*"' | cut -d'"' -f4 | head -1)
        if [ -n "$SEND_TIME" ]; then
          LAST_SEND=$(date -d "$SEND_TIME" +%s 2>/dev/null || echo 0)
        fi
      fi
    fi
    SEND_AGE=$(( $(date +%s) - LAST_SEND ))
    if [ "$SEND_AGE" -gt 180 ]; then
      do_restart "FROZEN(session_age=${SESSION_AGE}s,last_send=${SEND_AGE}s_ago)" "false"
      exit 0
    fi
  fi
fi

# ── Check 5: Dead Telegram connection ──
# If the gateway has been running 10+ min but the app log has ZERO Telegram
# sendMessage entries, the Telegram long-poll connection is dead.
TELEGRAM_DEAD=false
if [ "$HEALTH_OK" = true ] && [ "$PROC_OK" = true ]; then
  # How long has the gateway been running?
  GW_START=$(systemctl --user show openclaw-gateway --property=ActiveEnterTimestamp 2>/dev/null | cut -d= -f2)
  if [ -n "$GW_START" ]; then
    GW_START_TS=$(date -d "$GW_START" +%s 2>/dev/null || echo 0)
    GW_AGE=$(( $(date +%s) - GW_START_TS ))

    if [ "$GW_AGE" -gt 600 ]; then
      # Gateway running 10+ min — check for ANY Telegram activity
      TODAY=$(date -u +%Y-%m-%d)
      TG_ACTIVITY=0
      if [ -f "$APP_LOG_DIR/openclaw-$TODAY.log" ]; then
        # Check for any Telegram sends OR receives in the last 10 minutes of log
        TG_ACTIVITY=$(tail -3000 "$APP_LOG_DIR/openclaw-$TODAY.log" 2>/dev/null | grep -c "sendMessage ok\|telegram.*send\|incoming.*message" || echo 0)
      fi

      if [ "$TG_ACTIVITY" -eq 0 ]; then
        TELEGRAM_DEAD=true
      fi
    fi
  fi
fi

if [ "$TELEGRAM_DEAD" = true ]; then
  do_restart "TELEGRAM_DEAD(gateway_age=${GW_AGE}s,zero_telegram_activity)" "false"
  exit 0
fi

# ── All checks passed or minor failures ──
if [ "$HEALTH_OK" = true ] && [ "$PROC_OK" = true ]; then
  echo 0 > "$STATE_FILE"
  exit 0
fi

# Health or process failed
FAILURES=$((FAILURES + 1))
echo "$FAILURES" > "$STATE_FILE"

REASON=""
[ "$HEALTH_OK" = false ] && REASON="health_failed(HTTP_$HTTP_CODE)"
[ "$PROC_OK" = false ] && REASON="process_dead"

if [ "$FAILURES" -lt 2 ]; then
  log "WARNING: $REASON (failure $FAILURES/2)"
  exit 0
fi

do_restart "$REASON(failures=$FAILURES)" "false"
