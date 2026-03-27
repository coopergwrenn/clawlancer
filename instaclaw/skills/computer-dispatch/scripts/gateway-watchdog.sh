#!/bin/bash
# gateway-watchdog.sh — Auto-restart gateway if it's hung or unresponsive
# Runs every 2 minutes via systemd timer. Two consecutive failures = restart.
#
# Checks:
#   1. Gateway health endpoint (HTTP 200)
#   2. Gateway process is alive and not zombie
#   3. Telegram: if unread messages exist and no response in 5+ minutes → stuck
#
# State file: /tmp/gateway-watchdog-state (tracks consecutive failures)
# Log file: ~/watchdog.log

set -euo pipefail
export XDG_RUNTIME_DIR="/run/user/$(id -u)"

STATE_FILE="/tmp/gateway-watchdog-state"
LOG="$HOME/watchdog.log"
HEALTH_URL="http://localhost:18789/health"
MAX_LOG_LINES=500

log() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $1" >> "$LOG"
}

# Rotate log if too big
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG" 2>/dev/null || echo 0)" -gt "$MAX_LOG_LINES" ]; then
  tail -200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

# Read consecutive failure count
FAILURES=0
if [ -f "$STATE_FILE" ]; then
  FAILURES=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
fi

# Check 1: Health endpoint
HEALTH_OK=false
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 "$HEALTH_URL" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  HEALTH_OK=true
fi

# Check 2: Process alive
PROC_OK=false
if systemctl --user is-active openclaw-gateway > /dev/null 2>&1; then
  PROC_OK=true
fi

# Check 3: Telegram stuck detection
# If the gateway log has a "telegram sendMessage" in the last 5 minutes, it's responsive
TELEGRAM_STUCK=false
if [ "$HEALTH_OK" = true ] && [ "$PROC_OK" = true ]; then
  LAST_MSG_AGE=$(find /tmp/openclaw/ -name "*.log" -newer /tmp/gateway-watchdog-telegram-mark -print 2>/dev/null | head -1)
  # Check if any telegram sendMessage happened recently
  RECENT_SEND=$(journalctl --user -u openclaw-gateway --no-pager --since "5 minutes ago" 2>/dev/null | grep -c "sendMessage ok" || echo 0)
  RECENT_RECV=$(journalctl --user -u openclaw-gateway --no-pager --since "5 minutes ago" 2>/dev/null | grep -c "incoming message\|new message\|update.*message" || echo 0)

  # Stuck = received messages but sent zero responses in 5 minutes
  if [ "$RECENT_RECV" -gt 0 ] && [ "$RECENT_SEND" -eq 0 ]; then
    TELEGRAM_STUCK=true
  fi
fi

# Decision: restart or not
if [ "$HEALTH_OK" = true ] && [ "$PROC_OK" = true ] && [ "$TELEGRAM_STUCK" = false ]; then
  # All good — reset failure count
  echo 0 > "$STATE_FILE"
  exit 0
fi

# Something is wrong
FAILURES=$((FAILURES + 1))
echo "$FAILURES" > "$STATE_FILE"

REASON=""
[ "$HEALTH_OK" = false ] && REASON="health_endpoint_failed(HTTP $HTTP_CODE)"
[ "$PROC_OK" = false ] && REASON="process_not_active"
[ "$TELEGRAM_STUCK" = true ] && REASON="telegram_stuck(recv=$RECENT_RECV,sent=$RECENT_SEND)"

if [ "$FAILURES" -lt 2 ]; then
  log "WARNING: $REASON (failure $FAILURES/2 — will restart on next failure)"
  exit 0
fi

# Two consecutive failures — restart
log "RESTART: $REASON (failures=$FAILURES) — auto-restarting gateway"
systemctl --user restart openclaw-gateway 2>&1 | while read -r line; do log "  systemctl: $line"; done

# Wait for gateway to come back
sleep 8

if systemctl --user is-active openclaw-gateway > /dev/null 2>&1; then
  NEW_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 "$HEALTH_URL" 2>/dev/null || echo "000")
  log "RECOVERED: gateway restarted successfully (health=$NEW_CODE)"
  echo 0 > "$STATE_FILE"
else
  log "FAILED: gateway did not restart — manual intervention needed"
  echo "$FAILURES" > "$STATE_FILE"
fi
