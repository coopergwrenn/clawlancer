#!/bin/bash
# dispatch-remote-exec.sh — Execute a shell command on the user's computer
# Runs the command DIRECTLY via the relay — no Terminal window needed.
# Usage: dispatch-remote-exec.sh "mkdir -p ~/Desktop/Screenshots && mv ~/Desktop/Screenshot*.png ~/Desktop/Screenshots/"
set -euo pipefail

SOCKET="/tmp/dispatch.sock"
COMMAND=${1:?Usage: dispatch-remote-exec.sh "command"}

if [ ! -S "$SOCKET" ]; then
  echo '{"error":"dispatch relay not connected","hint":"User needs to run npx @instaclaw/dispatch on their computer"}'
  exit 1
fi

# JSON-escape the command
ESCAPED=$(echo "$COMMAND" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read().rstrip()))" 2>/dev/null)

echo "{\"type\":\"exec\",\"params\":{\"command\":$ESCAPED}}" | nc -U -w 60 "$SOCKET" 2>/dev/null || echo '{"error":"dispatch server not responding"}'
