#!/bin/bash
# dispatch-remote-click.sh X Y — Click on user's screen via dispatch relay
set -euo pipefail
SOCKET="/tmp/dispatch.sock"
X=${1:?Usage: dispatch-remote-click.sh X Y}
Y=${2:?Usage: dispatch-remote-click.sh X Y}
[ -S "$SOCKET" ] || { echo '{"error":"dispatch relay not connected"}'; exit 1; }
echo "{\"type\":\"click\",\"params\":{\"x\":$X,\"y\":$Y}}" | nc -U -w 10 "$SOCKET" 2>/dev/null || echo '{"error":"dispatch server not responding"}'
