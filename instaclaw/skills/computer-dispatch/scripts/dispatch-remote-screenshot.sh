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

# Request WebP at quality 55 for optimal speed/size
echo '{"type":"screenshot","params":{"format":"webp","quality":55}}' | nc -U -w 30 "$SOCKET" > "$TMPRESPONSE" 2>/dev/null || {
  echo '{"error":"dispatch server not responding"}'
  exit 1
}

# Extract image to disk using node (faster than python3 startup)
TMPRESPONSE="$TMPRESPONSE" OUTFILE="$OUTFILE" node -e "
const fs = require('fs');
try {
  const raw = fs.readFileSync(process.env.TMPRESPONSE, 'utf-8').trim();
  const d = JSON.parse(raw);
  if (d.error) { console.log(JSON.stringify(d)); process.exit(0); }
  if (d.image_base64) {
    const buf = Buffer.from(d.image_base64, 'base64');
    fs.writeFileSync(process.env.OUTFILE, buf);
    console.log(JSON.stringify({
      path: process.env.OUTFILE,
      size_bytes: buf.length,
      width: d.width || null,
      height: d.height || null,
      format: d.format || 'webp',
      coordMap: d.coordMap || '',
    }));
  } else {
    console.log(JSON.stringify({error: 'No image data in response'}));
  }
} catch (e) {
  console.log(JSON.stringify({error: 'Failed to parse response: ' + e.message}));
}
" 2>/dev/null
