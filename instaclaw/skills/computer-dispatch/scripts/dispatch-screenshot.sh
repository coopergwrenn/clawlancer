#!/bin/bash
# dispatch-screenshot.sh — Capture VM screen, convert to WebP, output JSON
set -euo pipefail
export DISPLAY=:99
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Save to workspace so deliver_file.sh can serve it
WSDIR="$HOME/.openclaw/workspace"
mkdir -p "$WSDIR"
TS=$(date +%s%N)
PNG="/tmp/dispatch-ss-${TS}.png"
OUTFILE="${WSDIR}/dispatch-screenshot.webp"
JPGFILE="${WSDIR}/dispatch-screenshot.jpg"

# Capture screenshot via usecomputer (outputs PNG)
OUTPUT=$(usecomputer screenshot "$PNG" --json 2>&1) || {
  echo '{"error":"screenshot failed"}'
  exit 1
}

COORD_MAP=$(echo "$OUTPUT" | tr -d '\n' | grep -o '"coordMap":"[^"]*"' | cut -d'"' -f4 || echo "0,0,1280,720,1280,720")

# Convert to WebP at quality 55 (smaller + faster than JPEG 80)
# Fall back to JPEG, then PNG
if convert "$PNG" -quality 55 -resize '1280x>' "$OUTFILE" 2>/dev/null; then
  rm -f "$PNG"
  FMT="webp"
elif convert "$PNG" -quality 55 -resize '1280x>' "$JPGFILE" 2>/dev/null; then
  rm -f "$PNG"
  OUTFILE="$JPGFILE"
  FMT="jpeg"
else
  OUTFILE="$PNG"
  FMT="png"
fi

FILESIZE=$(stat -c%s "$OUTFILE" 2>/dev/null || stat -f%z "$OUTFILE")

# Output ONLY metadata — no base64
echo "{\"path\":\"${OUTFILE}\",\"coordMap\":\"${COORD_MAP}\",\"format\":\"${FMT}\",\"size_bytes\":${FILESIZE}}"
