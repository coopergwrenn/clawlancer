#!/bin/bash
# dispatch-remote-status.sh — Check if dispatch relay is connected
# Uses TCP connection check (ss) as primary method — Unix socket is unreliable after restarts
set -euo pipefail

# Primary: check for ESTABLISHED WebSocket connections on port 8765
ESTAB=$(ss -tnp 2>/dev/null | grep ":8765" | grep -c ESTAB 2>/dev/null || echo 0)
if [ "$ESTAB" -gt 0 ]; then
  echo "{\"connected\":true,\"activeConnections\":$ESTAB}"
  exit 0
fi

# Fallback: try Unix socket (may be flaky)
SOCKET="/tmp/dispatch.sock"
if [ -S "$SOCKET" ]; then
  RESP=$(echo '{"type":"status"}' | nc -U -w 3 "$SOCKET" 2>/dev/null) && {
    echo "$RESP"
    exit 0
  }
fi

# Check if dispatch-server is at least running
if pgrep -f "node.*dispatch-server" > /dev/null 2>&1; then
  echo '{"connected":false,"dispatchServer":true,"error":"dispatch server running but no relay connected"}'
else
  echo '{"connected":false,"dispatchServer":false,"error":"dispatch server not running"}'
fi
