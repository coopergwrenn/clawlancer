#!/bin/bash
# dispatch-remote-press.sh "key" — Press key on user's machine via dispatch relay
set -euo pipefail
SOCKET="/tmp/dispatch.sock"
KEY=${1:?Usage: dispatch-remote-press.sh "key"}
[ -S "$SOCKET" ] || { echo '{"error":"dispatch relay not connected"}'; exit 1; }
echo "{\"type\":\"press\",\"params\":{\"key\":\"$KEY\"}}" | nc -U -w 10 "$SOCKET" 2>/dev/null || echo '{"error":"dispatch server not responding"}'
