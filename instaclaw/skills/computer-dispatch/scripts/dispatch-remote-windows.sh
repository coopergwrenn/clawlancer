#!/bin/bash
# dispatch-remote-windows.sh — List open windows on user's machine via dispatch relay
set -euo pipefail
SOCKET="/tmp/dispatch.sock"
[ -S "$SOCKET" ] || { echo '{"error":"dispatch relay not connected"}'; exit 1; }
echo '{"type":"windows","params":{}}' | nc -U -w 10 "$SOCKET" 2>/dev/null || echo '{"error":"dispatch server not responding"}'
