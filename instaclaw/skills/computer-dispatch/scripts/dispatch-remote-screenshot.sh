#!/bin/bash
# dispatch-remote-screenshot.sh — Capture the user's screen via dispatch relay
# Saves image to workspace, returns only metadata (NO base64 in stdout)
set -euo pipefail

SOCKET="/tmp/dispatch.sock"
OUTFILE="$HOME/.openclaw/workspace/dispatch-remote-screenshot.jpg"
TMPRESPONSE="/tmp/dispatch-remote-response-$$.json"
trap "rm -f '$TMPRESPONSE'" EXIT

if [ ! -S "$SOCKET" ]; then
  echo '{"error":"dispatch relay not connected","hint":"User needs to run instaclaw-dispatch on their computer"}'
  exit 1
fi

# Send screenshot request, save raw response to temp file (NOT stdout — avoids base64 in agent context)
echo '{"type":"screenshot","params":{"format":"jpeg","quality":80}}' | nc -U -w 30 "$SOCKET" > "$TMPRESPONSE" 2>/dev/null || {
  echo '{"error":"dispatch server not responding"}'
  exit 1
}

# Extract image to disk, output only metadata
TMPRESPONSE="$TMPRESPONSE" python3 << 'PYEOF'
import json, base64, sys, os

try:
    with open(os.environ["TMPRESPONSE"], "r") as f:
        d = json.load(f)
except Exception as e:
    print(json.dumps({"error": f"Failed to parse response: {e}"}))
    sys.exit(0)

if "error" in d:
    print(json.dumps(d))
    sys.exit(0)

if "image_base64" in d:
    outfile = os.path.expanduser("~/.openclaw/workspace/dispatch-remote-screenshot.jpg")
    img = base64.b64decode(d["image_base64"])
    with open(outfile, "wb") as f:
        f.write(img)
    # Return ONLY metadata — no base64 in stdout
    print(json.dumps({
        "path": outfile,
        "size_bytes": len(img),
        "width": d.get("width"),
        "height": d.get("height"),
        "format": d.get("format", "jpeg"),
        "coordMap": d.get("coordMap", ""),
    }))
else:
    print(json.dumps({"error": "No image data in response"}))
PYEOF
