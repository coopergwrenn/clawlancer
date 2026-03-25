#!/bin/bash
# dispatch-remote-drag.sh fromX fromY toX toY — Drag on user's screen via dispatch relay
set -euo pipefail
SOCKET="/tmp/dispatch.sock"
FROM_X=${1:?Usage: dispatch-remote-drag.sh fromX fromY toX toY}
FROM_Y=${2:?Usage: dispatch-remote-drag.sh fromX fromY toX toY}
TO_X=${3:?Usage: dispatch-remote-drag.sh fromX fromY toX toY}
TO_Y=${4:?Usage: dispatch-remote-drag.sh fromX fromY toX toY}
[ -S "$SOCKET" ] || { echo '{"error":"dispatch relay not connected"}'; exit 1; }
echo "{\"type\":\"drag\",\"params\":{\"fromX\":$FROM_X,\"fromY\":$FROM_Y,\"toX\":$TO_X,\"toY\":$TO_Y}}" | nc -U -w 10 "$SOCKET" 2>/dev/null || echo '{"error":"dispatch server not responding"}'
