#!/bin/bash
# dispatch-remote-screenshot.sh — Capture the user's screen via dispatch relay
set -euo pipefail

SOCKET="/tmp/dispatch.sock"
OUTFILE="$HOME/.openclaw/workspace/dispatch-remote-screenshot.jpg"

if [ ! -S "$SOCKET" ]; then
  echo '{"error":"dispatch relay not connected","hint":"User needs to run instaclaw-dispatch on their computer"}'
  exit 1
fi

RESPONSE=$(echo '{"type":"screenshot","params":{"format":"jpeg","quality":80}}' | nc -U -w 30 "$SOCKET" 2>/dev/null) || {
  echo '{"error":"dispatch server not responding"}'
  exit 1
}

# Check for error
if echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if 'error' not in d else 1)" 2>/dev/null; then
  # Extract base64 image and save to workspace
  echo "$RESPONSE" | python3 -c "
import sys, json, base64
d = json.load(sys.stdin)
if 'image_base64' in d:
    img = base64.b64decode(d['image_base64'])
    with open('$OUTFILE', 'wb') as f:
        f.write(img)
    d['path'] = '$OUTFILE'
    d['size_bytes'] = len(img)
    del d['image_base64']
print(json.dumps(d))
" 2>/dev/null
else
  echo "$RESPONSE"
fi
