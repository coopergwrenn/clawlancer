#!/bin/bash
# dispatch-remote-batch.sh — Execute multiple actions in one round-trip + auto-screenshot
# Usage: dispatch-remote-batch.sh '<JSON>'
#
# Example JSON:
#   '{"actions":[{"type":"click","params":{"x":400,"y":300},"waitAfterMs":100},{"type":"type","params":{"text":"hello"},"waitAfterMs":0},{"type":"press","params":{"key":"Return"},"waitAfterMs":1500}]}'
#
# Options in JSON root:
#   screenshotAfter: true (default) — take screenshot after batch completes
#   screenshotFormat: "webp" (default) — "webp" or "jpeg"
#   screenshotQuality: 55 (default) — 1-100
#   settleMs: 300 (default) — wait before screenshot for screen to settle
set -euo pipefail

SOCKET="/tmp/dispatch.sock"
OUTFILE="$HOME/.openclaw/workspace/dispatch-remote-screenshot.jpg"
BATCH_JSON=${1:?Usage: dispatch-remote-batch.sh '<JSON actions>'}
TMPRESPONSE="/tmp/dispatch-batch-response-$$.json"
trap "rm -f '$TMPRESPONSE'" EXIT

if [ ! -S "$SOCKET" ]; then
  echo '{"error":"dispatch relay not connected","hint":"User needs to run instaclaw-dispatch on their computer"}'
  exit 1
fi

# Wrap in batch command
FULL_CMD="{\"type\":\"batch\",\"params\":$BATCH_JSON}"

# Send batch command, save response
echo "$FULL_CMD" | nc -U -w 60 "$SOCKET" > "$TMPRESPONSE" 2>/dev/null || {
  echo '{"error":"dispatch server not responding"}'
  exit 1
}

# If response contains image_base64, extract to disk and strip it from output
TMPRESPONSE="$TMPRESPONSE" OUTFILE="$OUTFILE" node -e "
const fs = require('fs');
try {
  const raw = fs.readFileSync(process.env.TMPRESPONSE, 'utf-8').trim();
  const d = JSON.parse(raw);
  if (d.image_base64) {
    const buf = Buffer.from(d.image_base64, 'base64');
    fs.writeFileSync(process.env.OUTFILE, buf);
    delete d.image_base64;
    d.screenshot_path = process.env.OUTFILE;
    d.screenshot_size_bytes = buf.length;
  }
  console.log(JSON.stringify(d));
} catch (e) {
  // If JSON parse fails, output raw
  try { console.log(fs.readFileSync(process.env.TMPRESPONSE, 'utf-8')); } catch { console.log('{\"error\":\"failed to read response\"}'); }
}
" 2>/dev/null
