#!/bin/bash
# gateway-watchdog.sh — Auto-restart gateway if hung, stuck, or context overflowing
# Runs every 2 minutes via systemd timer.
#
# Checks:
#   1. Gateway health endpoint (HTTP 200)
#   2. Gateway process is alive
#   3. Session size cap (>500KB = context approaching overflow, archive + restart)
#   4. Telegram stuck (received messages but no sent in 5 min)
#
# Two consecutive failures on checks 1-2 = restart.
# Session size cap = immediate restart (no waiting — prevents silent message drops).

set -euo pipefail
export XDG_RUNTIME_DIR="/run/user/$(id -u)"

STATE_FILE="/tmp/gateway-watchdog-state"
LOG="$HOME/watchdog.log"
HEALTH_URL="http://localhost:18789/health"
SESSION_FILE="$HOME/.openclaw/agents/main/sessions/sessions.json"
MAX_SESSION_KB=500   # 500KB — safe threshold before 200K token overflow
MAX_LOG_LINES=500

log() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $1" >> "$LOG"
}

# Rotate log
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG" 2>/dev/null || echo 0)" -gt "$MAX_LOG_LINES" ]; then
  tail -200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

# Read failure count
FAILURES=0
if [ -f "$STATE_FILE" ]; then
  FAILURES=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
fi

# ── Check 1: Session size cap (IMMEDIATE — prevents silent drops) ──
if [ -f "$SESSION_FILE" ]; then
  SESSION_KB=$(du -k "$SESSION_FILE" 2>/dev/null | cut -f1)
  if [ "${SESSION_KB:-0}" -gt "$MAX_SESSION_KB" ]; then
    log "SESSION_OVERFLOW: ${SESSION_KB}KB > ${MAX_SESSION_KB}KB — archiving session and restarting"

    # Archive the session (keep last 5 archives)
    ARCHIVE="${SESSION_FILE}.$(date +%s).bak"
    cp "$SESSION_FILE" "$ARCHIVE" 2>/dev/null || true
    echo "[]" > "$SESSION_FILE"

    # Clean old archives (keep last 5)
    ls -1t "${SESSION_FILE}".*.bak 2>/dev/null | tail -n +6 | xargs rm -f 2>/dev/null || true

    # Restart gateway for fresh context
    systemctl --user restart openclaw-gateway 2>&1 | while read -r line; do log "  systemctl: $line"; done
    sleep 8

    if systemctl --user is-active openclaw-gateway > /dev/null 2>&1; then
      log "SESSION_RECOVERED: gateway restarted with fresh context"
    else
      log "SESSION_RESTART_FAILED: gateway did not restart"
    fi
    echo 0 > "$STATE_FILE"
    exit 0
  fi
fi

# ── Check 2: Health endpoint ──
HEALTH_OK=false
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 "$HEALTH_URL" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  HEALTH_OK=true
fi

# ── Check 3: Process alive ──
PROC_OK=false
if systemctl --user is-active openclaw-gateway > /dev/null 2>&1; then
  PROC_OK=true
fi

# ── Check 4: Telegram stuck detection ──
TELEGRAM_STUCK=false
if [ "$HEALTH_OK" = true ] && [ "$PROC_OK" = true ]; then
  RECENT_SEND=$(journalctl --user -u openclaw-gateway --no-pager --since "5 minutes ago" 2>/dev/null | grep -c "sendMessage ok" || echo 0)
  RECENT_RECV=$(journalctl --user -u openclaw-gateway --no-pager --since "5 minutes ago" 2>/dev/null | grep -c "incoming message\|new message\|update.*message" || echo 0)

  if [ "$RECENT_RECV" -gt 0 ] && [ "$RECENT_SEND" -eq 0 ]; then
    TELEGRAM_STUCK=true
  fi
fi

# ── Decision ──
if [ "$HEALTH_OK" = true ] && [ "$PROC_OK" = true ] && [ "$TELEGRAM_STUCK" = false ]; then
  echo 0 > "$STATE_FILE"
  exit 0
fi

FAILURES=$((FAILURES + 1))
echo "$FAILURES" > "$STATE_FILE"

REASON=""
[ "$HEALTH_OK" = false ] && REASON="health_failed(HTTP $HTTP_CODE)"
[ "$PROC_OK" = false ] && REASON="process_dead"
[ "$TELEGRAM_STUCK" = true ] && REASON="telegram_stuck(recv=$RECENT_RECV,sent=$RECENT_SEND)"

if [ "$FAILURES" -lt 2 ]; then
  log "WARNING: $REASON (failure $FAILURES/2)"
  exit 0
fi

# Two consecutive failures — restart
log "RESTART: $REASON (failures=$FAILURES)"

# If stuck due to context, also archive session
if [ "$TELEGRAM_STUCK" = true ] && [ -f "$SESSION_FILE" ]; then
  SESSION_KB=$(du -k "$SESSION_FILE" 2>/dev/null | cut -f1)
  if [ "${SESSION_KB:-0}" -gt 200 ]; then
    log "  Also archiving session (${SESSION_KB}KB) since agent is stuck"
    cp "$SESSION_FILE" "${SESSION_FILE}.$(date +%s).bak" 2>/dev/null || true
    echo "[]" > "$SESSION_FILE"
  fi
fi

systemctl --user restart openclaw-gateway 2>&1 | while read -r line; do log "  systemctl: $line"; done
sleep 8

if systemctl --user is-active openclaw-gateway > /dev/null 2>&1; then
  NEW_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 "$HEALTH_URL" 2>/dev/null || echo "000")
  log "RECOVERED: gateway restarted (health=$NEW_CODE)"
  echo 0 > "$STATE_FILE"
else
  log "FAILED: gateway did not restart"
fi
