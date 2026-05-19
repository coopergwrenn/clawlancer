#!/bin/bash
# pglite-checkpoint.sh — force PGLite CHECKPOINT via gbrain MCP admin tool.
#
# Runs:
#   1. Every 30 min via crontab (keeps pg_control fresh, bounds SIGKILL-safety window).
#   2. As gbrain.service ExecStop hook (graceful checkpoint before SIGKILL).
#
# See CLAUDE.md Rule 54 + instaclaw/scripts/gbrain-patches/0001-add-checkpoint-mcp-tool.patch.
#
# Exit 0 always — no cron-failure-spam. Outcomes logged structurally to
# ~/.openclaw/logs/pglite-checkpoint.log for forensic visibility.
set +e

# CRITICAL: export DBUS env so `systemctl --user` works in cron context.
# Without XDG_RUNTIME_DIR set, systemctl --user fails with "Failed to connect to bus".
# We hit this on the 2026-05-18 initial deployment — cron skipped every tick for 24h.
export XDG_RUNTIME_DIR="/run/user/$(id -u)"

PORT=3131
LOG_FILE="$HOME/.openclaw/logs/pglite-checkpoint.log"
mkdir -p "$HOME/.openclaw/logs"

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG_FILE"
}

BEARER=$(cat "$HOME/.gbrain/openclaw-bearer-token.txt" 2>/dev/null)
if [ -z "$BEARER" ]; then
  exit 0  # gbrain not installed; silent skip
fi

# Accept both "active" (cron tick during normal operation) AND "deactivating"
# (systemd is stopping the service, ExecStop hook mid-execution — process is
# still alive enough to handle the MCP HTTP call).
#
# Other states ("inactive", "failed", "activating") = MCP endpoint unreachable
# or about to be — skip silently and exit 0.
STATE=$(systemctl --user is-active gbrain.service 2>&1)
case "$STATE" in
  active|deactivating) ;;
  *)
    log "skip: state=$STATE"
    exit 0
    ;;
esac

RESP=$(curl -sS -X POST "http://127.0.0.1:$PORT/mcp" \
  -H "Authorization: Bearer $BEARER" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json,text/event-stream" \
  --max-time 60 \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"checkpoint","arguments":{}}}' 2>&1)

# Success detection: response must contain `\"ok\": true` (escaped inside SSE)
# AND must NOT contain `"isError":true` (gbrain's MCP error marker).
if echo "$RESP" | grep -qF '\"ok\": true' && ! echo "$RESP" | grep -qF '"isError":true'; then
  LATENCY=$(echo "$RESP" | grep -oE '\\"latency_ms\\":\s*[0-9]+' | head -1 | grep -oE '[0-9]+')
  log "ok latency_ms=${LATENCY:-?} state=$STATE"
else
  TRUNC=$(echo "$RESP" | head -c 200 | tr '\n' ' ')
  log "FAILED state=$STATE: $TRUNC"
fi

# Health probe: pg_control mtime check.
PG_CONTROL="$HOME/.gbrain/brain.pglite/global/pg_control"
if [ -f "$PG_CONTROL" ]; then
  MTIME=$(stat -c %Y "$PG_CONTROL")
  AGE_MIN=$(( ($(date +%s) - MTIME) / 60 ))
  if [ "$AGE_MIN" -gt 60 ]; then
    log "WARN: pg_control age=${AGE_MIN}min — exceeds 60min threshold"
  fi
fi

# Rotate log if >1MB
if [ -f "$LOG_FILE" ] && [ "$(stat -c %s "$LOG_FILE")" -gt 1048576 ]; then
  mv "$LOG_FILE" "$LOG_FILE.old"
  log "rotated"
fi

exit 0
