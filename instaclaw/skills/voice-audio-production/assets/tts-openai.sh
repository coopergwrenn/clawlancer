#!/bin/bash
#
# tts-openai.sh — Generate audio via OpenAI TTS API
#
# Usage:
#   tts-openai.sh "text to speak" [output.mp3] [voice] [model]
#
# Arguments:
#   text      — Text to convert to speech (required, or pipe via stdin)
#   output    — Output file path (default: /tmp/tts-output.mp3)
#   voice     — Voice ID: alloy, echo, fable, onyx, nova, shimmer (default: alloy)
#   model     — Model: tts-1 (fast), tts-1-hd (quality) (default: tts-1-hd)
#
# Environment:
#   OPENAI_API_KEY — Required. Set in ~/.openclaw/.env
#
# Examples:
#   tts-openai.sh "Hello world" hello.mp3
#   tts-openai.sh "Professional narration" output.mp3 onyx tts-1-hd
#   echo "Text from file" | tts-openai.sh - output.mp3 nova
#

set -euo pipefail

# Read text from argument or stdin
TEXT="${1:--}"
if [ "$TEXT" = "-" ]; then
  TEXT=$(cat)
fi

if [ -z "$TEXT" ]; then
  echo "Error: No text provided" >&2
  echo "Usage: tts-openai.sh \"text\" [output.mp3] [voice] [model]" >&2
  exit 1
fi

OUTPUT="${2:-/tmp/tts-output.mp3}"
VOICE="${3:-alloy}"
MODEL="${4:-tts-1-hd}"

# Load API key from environment or .env file
if [ -z "${OPENAI_API_KEY:-}" ]; then
  if [ -f "$HOME/.openclaw/.env" ]; then
    OPENAI_API_KEY=$(grep "^OPENAI_API_KEY=" "$HOME/.openclaw/.env" 2>/dev/null | head -1 | sed 's/^[^=]*=//' | tr -d '"' | tr -d "'")
  fi
fi

if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "Error: OPENAI_API_KEY not set. Add it to ~/.openclaw/.env" >&2
  exit 1
fi

# Validate voice
VALID_VOICES="alloy echo fable onyx nova shimmer"
if ! echo "$VALID_VOICES" | grep -qw "$VOICE"; then
  echo "Error: Invalid voice '$VOICE'. Valid: $VALID_VOICES" >&2
  exit 1
fi

# Validate model
if [ "$MODEL" != "tts-1" ] && [ "$MODEL" != "tts-1-hd" ]; then
  echo "Error: Invalid model '$MODEL'. Valid: tts-1, tts-1-hd" >&2
  exit 1
fi

CHAR_COUNT=${#TEXT}
echo "Generating audio: ${CHAR_COUNT} chars, voice=${VOICE}, model=${MODEL}" >&2

# Ensure output directory exists
mkdir -p "$(dirname "$OUTPUT")"

# Handle long text by splitting into segments
MAX_CHARS=4096
if [ "$CHAR_COUNT" -le "$MAX_CHARS" ]; then
  # Single request
  HTTP_CODE=$(curl -s -w "%{http_code}" -X POST "https://api.openai.com/v1/audio/speech" \
    -H "Authorization: Bearer $OPENAI_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$(python3 -c "import json; print(json.dumps({'model': '$MODEL', 'voice': '$VOICE', 'input': '''$TEXT'''}))" 2>/dev/null || echo "{\"model\":\"$MODEL\",\"voice\":\"$VOICE\",\"input\":$(echo "$TEXT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}")" \
    --output "$OUTPUT")

  if [ "$HTTP_CODE" != "200" ]; then
    echo "Error: OpenAI TTS API returned HTTP $HTTP_CODE" >&2
    if [ -f "$OUTPUT" ]; then
      cat "$OUTPUT" >&2
      rm -f "$OUTPUT"
    fi
    exit 1
  fi
else
  # Split into segments at sentence boundaries
  echo "Text exceeds ${MAX_CHARS} chars, splitting into segments..." >&2
  TMPDIR=$(mktemp -d)
  trap 'rm -rf "$TMPDIR"' EXIT

  # Use Python to split at sentence boundaries
  python3 -c "
import sys, os
text = '''$TEXT'''
max_chars = $MAX_CHARS
segments = []
current = ''
for sentence in text.replace('. ', '.|').replace('! ', '!|').replace('? ', '?|').split('|'):
    if len(current) + len(sentence) > max_chars and current:
        segments.append(current.strip())
        current = sentence
    else:
        current += sentence
if current.strip():
    segments.append(current.strip())
for i, seg in enumerate(segments):
    with open(f'$TMPDIR/segment_{i:03d}.txt', 'w') as f:
        f.write(seg)
print(len(segments))
" > "$TMPDIR/count.txt" 2>/dev/null

  SEGMENT_COUNT=$(cat "$TMPDIR/count.txt")
  echo "Split into $SEGMENT_COUNT segments" >&2

  CONCAT_LIST=""
  for SEG_FILE in "$TMPDIR"/segment_*.txt; do
    SEG_TEXT=$(cat "$SEG_FILE")
    SEG_NAME=$(basename "$SEG_FILE" .txt)
    SEG_OUTPUT="$TMPDIR/${SEG_NAME}.mp3"

    curl -s -X POST "https://api.openai.com/v1/audio/speech" \
      -H "Authorization: Bearer $OPENAI_API_KEY" \
      -H "Content-Type: application/json" \
      -d "$(echo "$SEG_TEXT" | python3 -c 'import json,sys; print(json.dumps({"model":"'"$MODEL"'","voice":"'"$VOICE"'","input":sys.stdin.read()}))')" \
      --output "$SEG_OUTPUT"

    if [ -n "$CONCAT_LIST" ]; then
      CONCAT_LIST="$CONCAT_LIST|$SEG_OUTPUT"
    else
      CONCAT_LIST="$SEG_OUTPUT"
    fi
    echo "  Generated segment: $SEG_NAME" >&2
  done

  # Concatenate all segments
  if echo "$CONCAT_LIST" | grep -q "|"; then
    # Multiple segments — use ffmpeg concat
    FILELIST="$TMPDIR/filelist.txt"
    echo "$CONCAT_LIST" | tr '|' '\n' | while read -r f; do
      echo "file '$f'"
    done > "$FILELIST"
    ffmpeg -y -f concat -safe 0 -i "$FILELIST" -c copy "$OUTPUT" 2>/dev/null
  else
    cp "$CONCAT_LIST" "$OUTPUT"
  fi
fi

# Verify output
if [ ! -f "$OUTPUT" ] || [ ! -s "$OUTPUT" ]; then
  echo "Error: Output file is empty or missing" >&2
  exit 1
fi

DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUTPUT" 2>/dev/null || echo "unknown")
FILE_SIZE=$(wc -c < "$OUTPUT" | tr -d ' ')

echo "OK: ${OUTPUT} (${DURATION}s, ${FILE_SIZE} bytes, ${CHAR_COUNT} chars)" >&2

# Log usage
if [ -f "$HOME/scripts/audio-usage-tracker.py" ]; then
  python3 "$HOME/scripts/audio-usage-tracker.py" track "$CHAR_COUNT" openai 2>/dev/null || true
fi
