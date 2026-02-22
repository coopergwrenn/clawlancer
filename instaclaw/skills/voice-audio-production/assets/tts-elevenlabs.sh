#!/bin/bash
#
# tts-elevenlabs.sh — Generate audio via ElevenLabs TTS API
#
# Usage:
#   tts-elevenlabs.sh "text to speak" [output.mp3] [voice_id] [model]
#
# Arguments:
#   text      — Text to convert to speech (required, or pipe via stdin with -)
#   output    — Output file path (default: /tmp/tts-output.mp3)
#   voice_id  — ElevenLabs voice ID (default: 21m00Tcm4TlvDq8ikWAM = Rachel)
#   model     — Model ID (default: eleven_monolingual_v1)
#
# Environment:
#   ELEVENLABS_API_KEY — Required. Set in ~/.openclaw/.env
#
# Voice Discovery:
#   curl -s -H "xi-api-key: $ELEVENLABS_API_KEY" \
#     https://api.elevenlabs.io/v1/voices | python3 -m json.tool
#
# Common Voice IDs:
#   21m00Tcm4TlvDq8ikWAM — Rachel (neutral female)
#   ErXwobaYiN019PkySvjV — Antoni (male)
#   EXAVITQu4vr4xnSDxMaL — Bella (female)
#   MF3mGyEYCl7XYWbV9V6O — Elli (female, young)
#   TxGEqnHWrfWFTfGW9XjX — Josh (male, deep)
#   VR6AewLTigWG4xSOukaG — Arnold (male, narration)
#   pNInz6obpgDQGcFmaJgB — Adam (male, professional)
#
# Examples:
#   tts-elevenlabs.sh "Hello world" hello.mp3
#   tts-elevenlabs.sh "Professional narration" output.mp3 pNInz6obpgDQGcFmaJgB
#

set -euo pipefail

# Read text from argument or stdin
TEXT="${1:--}"
if [ "$TEXT" = "-" ]; then
  TEXT=$(cat)
fi

if [ -z "$TEXT" ]; then
  echo "Error: No text provided" >&2
  echo "Usage: tts-elevenlabs.sh \"text\" [output.mp3] [voice_id] [model]" >&2
  exit 1
fi

OUTPUT="${2:-/tmp/tts-output.mp3}"
VOICE_ID="${3:-21m00Tcm4TlvDq8ikWAM}"
MODEL="${4:-eleven_monolingual_v1}"

# Load API key from environment or .env file
if [ -z "${ELEVENLABS_API_KEY:-}" ]; then
  if [ -f "$HOME/.openclaw/.env" ]; then
    ELEVENLABS_API_KEY=$(grep "^ELEVENLABS_API_KEY=" "$HOME/.openclaw/.env" 2>/dev/null | head -1 | sed 's/^[^=]*=//' | tr -d '"' | tr -d "'")
  fi
fi

if [ -z "${ELEVENLABS_API_KEY:-}" ]; then
  echo "Error: ELEVENLABS_API_KEY not set. Add it to ~/.openclaw/.env" >&2
  echo "Tip: Try tts-openai.sh as a fallback" >&2
  exit 1
fi

CHAR_COUNT=${#TEXT}
echo "Generating audio: ${CHAR_COUNT} chars, voice=${VOICE_ID}, model=${MODEL}" >&2

# Check character limit (ElevenLabs has ~5000 char limit per request on some tiers)
MAX_CHARS=5000

# Ensure output directory exists
mkdir -p "$(dirname "$OUTPUT")"

if [ "$CHAR_COUNT" -le "$MAX_CHARS" ]; then
  # Single request
  BODY=$(python3 -c "
import json, sys
print(json.dumps({
    'text': sys.stdin.read(),
    'model_id': '$MODEL',
    'voice_settings': {
        'stability': 0.5,
        'similarity_boost': 0.75
    }
}))
" <<< "$TEXT")

  HTTP_CODE=$(curl -s -w "%{http_code}" -X POST \
    "https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}" \
    -H "xi-api-key: $ELEVENLABS_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$BODY" \
    --output "$OUTPUT")

  if [ "$HTTP_CODE" != "200" ]; then
    echo "Error: ElevenLabs API returned HTTP $HTTP_CODE" >&2
    if [ -f "$OUTPUT" ]; then
      cat "$OUTPUT" >&2
      rm -f "$OUTPUT"
    fi
    # Suggest fallback
    echo "" >&2
    echo "Fallback: Try tts-openai.sh instead" >&2
    exit 1
  fi
else
  # Split into segments at sentence boundaries
  echo "Text exceeds ${MAX_CHARS} chars, splitting into segments..." >&2
  TMPDIR=$(mktemp -d)
  trap 'rm -rf "$TMPDIR"' EXIT

  python3 -c "
import sys
text = sys.stdin.read()
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
" <<< "$TEXT" > "$TMPDIR/count.txt"

  SEGMENT_COUNT=$(cat "$TMPDIR/count.txt")
  echo "Split into $SEGMENT_COUNT segments" >&2

  FILELIST="$TMPDIR/filelist.txt"
  > "$FILELIST"

  for SEG_FILE in "$TMPDIR"/segment_*.txt; do
    SEG_TEXT=$(cat "$SEG_FILE")
    SEG_NAME=$(basename "$SEG_FILE" .txt)
    SEG_OUTPUT="$TMPDIR/${SEG_NAME}.mp3"

    BODY=$(python3 -c "
import json, sys
print(json.dumps({
    'text': sys.stdin.read(),
    'model_id': '$MODEL',
    'voice_settings': {
        'stability': 0.5,
        'similarity_boost': 0.75
    }
}))
" <<< "$SEG_TEXT")

    HTTP_CODE=$(curl -s -w "%{http_code}" -X POST \
      "https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}" \
      -H "xi-api-key: $ELEVENLABS_API_KEY" \
      -H "Content-Type: application/json" \
      -d "$BODY" \
      --output "$SEG_OUTPUT")

    if [ "$HTTP_CODE" != "200" ]; then
      echo "Error: Segment $SEG_NAME failed with HTTP $HTTP_CODE" >&2
      exit 1
    fi

    echo "file '$SEG_OUTPUT'" >> "$FILELIST"
    echo "  Generated segment: $SEG_NAME" >&2
  done

  # Concatenate all segments
  ffmpeg -y -f concat -safe 0 -i "$FILELIST" -c copy "$OUTPUT" 2>/dev/null
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
  python3 "$HOME/scripts/audio-usage-tracker.py" track "$CHAR_COUNT" elevenlabs 2>/dev/null || true
fi
