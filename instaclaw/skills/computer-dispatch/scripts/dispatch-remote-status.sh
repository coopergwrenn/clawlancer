#!/bin/bash
# dispatch-remote-status.sh — Check if dispatch relay is connected
set -euo pipefail
SOCKET="/tmp/dispatch.sock"
if [ ! -S "$SOCKET" ]; then
  echo '{"connected":false,"error":"dispatch server not running"}'
  exit 0
fi
echo '{"type":"status"}' | nc -U -w 10 "$SOCKET" 2>/dev/null || echo '{"connected":false,"error":"dispatch server not responding"}'
