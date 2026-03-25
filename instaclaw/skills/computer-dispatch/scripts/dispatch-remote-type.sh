#!/bin/bash
# dispatch-remote-type.sh "text" — Type on user's keyboard via dispatch relay
set -euo pipefail
SOCKET="/tmp/dispatch.sock"
TEXT=${1:?Usage: dispatch-remote-type.sh "text"}
[ -S "$SOCKET" ] || { echo '{"error":"dispatch relay not connected"}'; exit 1; }
# Escape the text for JSON
ESCAPED=$(echo "$TEXT" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read().rstrip()))" 2>/dev/null)
echo "{\"type\":\"type\",\"params\":{\"text\":$ESCAPED}}" | nc -U -w 10 "$SOCKET" 2>/dev/null || echo '{"error":"dispatch server not responding"}'
