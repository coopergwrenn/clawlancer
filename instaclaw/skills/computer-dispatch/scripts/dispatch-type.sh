#!/bin/bash
# dispatch-type.sh "text" — Type text via xdotool (handles spaces + special chars)
set -euo pipefail
export DISPLAY=:99

TEXT=${1:?Usage: dispatch-type.sh "text"}
xdotool type --delay 12 -- "$TEXT"
echo "{\"success\":true,\"action\":\"type\"}"
