#!/bin/bash
# dispatch-remote-scroll.sh direction [amount] — Scroll on user's machine via dispatch relay
set -euo pipefail
SOCKET="/tmp/dispatch.sock"
DIR=${1:?Usage: dispatch-remote-scroll.sh direction [amount]}
AMT=${2:-3}
[ -S "$SOCKET" ] || { echo '{"error":"dispatch relay not connected"}'; exit 1; }
echo "{\"type\":\"scroll\",\"params\":{\"direction\":\"$DIR\",\"amount\":$AMT}}" | nc -U -w 10 "$SOCKET" 2>/dev/null || echo '{"error":"dispatch server not responding"}'
