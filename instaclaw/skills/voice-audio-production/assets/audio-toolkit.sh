#!/bin/bash
#
# audio-toolkit.sh — FFmpeg audio processing toolkit
#
# Usage: audio-toolkit.sh <command> [args...]
#
# Commands:
#   duration <file>                          — Get exact duration in seconds
#   normalize <input> <output>               — Normalize volume (EBU R128 loudnorm)
#   mix <voice> <music> <output> [vol]       — Mix voice + music (vol=music volume, default 0.2)
#   compress <input> <output>                — Compress for messaging (96k mono MP3)
#   convert <input> <output> [codec]         — Convert format (mp3/opus/aac/wav/flac)
#   trim <input> <output> <start> [duration] — Trim audio (start in seconds)
#   silence-remove <input> <output>          — Remove leading/trailing silence
#   concat <output> <file1> <file2> [...]    — Concatenate multiple audio files
#   info <file>                              — Show detailed audio info
#
# All commands use ffmpeg/ffprobe (pre-installed on all VMs).
#

set -euo pipefail

CMD="${1:-help}"
shift || true

case "$CMD" in

  duration)
    FILE="${1:?Usage: audio-toolkit.sh duration <file>}"
    if [ ! -f "$FILE" ]; then
      echo "Error: File not found: $FILE" >&2
      exit 1
    fi
    ffprobe -v error -show_entries format=duration -of csv=p=0 "$FILE"
    ;;

  normalize)
    INPUT="${1:?Usage: audio-toolkit.sh normalize <input> <output>}"
    OUTPUT="${2:?Usage: audio-toolkit.sh normalize <input> <output>}"
    if [ ! -f "$INPUT" ]; then
      echo "Error: Input file not found: $INPUT" >&2
      exit 1
    fi
    # Two-pass EBU R128 loudness normalization
    # First pass: analyze
    STATS=$(ffmpeg -i "$INPUT" -af "loudnorm=print_format=json" -f null /dev/null 2>&1 | \
      python3 -c "
import sys, json
lines = sys.stdin.read()
start = lines.rfind('{')
end = lines.rfind('}') + 1
if start >= 0 and end > start:
    d = json.loads(lines[start:end])
    print(f\"{d.get('input_i', '-24')},{d.get('input_tp', '-2')},{d.get('input_lra', '7')},{d.get('input_thresh', '-34')}\")
else:
    print('-24,-2,7,-34')
" 2>/dev/null || echo "-24,-2,7,-34")

    IFS=',' read -r MI MTP MLRA MTH <<< "$STATS"

    # Second pass: apply with measured values
    TMPFILE=$(mktemp --suffix=.mp3)
    ffmpeg -y -i "$INPUT" \
      -af "loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${MI}:measured_TP=${MTP}:measured_LRA=${MLRA}:measured_thresh=${MTH}" \
      "$TMPFILE" 2>/dev/null

    mv "$TMPFILE" "$OUTPUT"
    echo "Normalized: $OUTPUT" >&2
    ;;

  mix)
    VOICE="${1:?Usage: audio-toolkit.sh mix <voice> <music> <output> [volume]}"
    MUSIC="${2:?Usage: audio-toolkit.sh mix <voice> <music> <output> [volume]}"
    OUTPUT="${3:?Usage: audio-toolkit.sh mix <voice> <music> <output> [volume]}"
    VOLUME="${4:-0.2}"

    if [ ! -f "$VOICE" ]; then echo "Error: Voice file not found: $VOICE" >&2; exit 1; fi
    if [ ! -f "$MUSIC" ]; then echo "Error: Music file not found: $MUSIC" >&2; exit 1; fi

    ffmpeg -y -i "$VOICE" -i "$MUSIC" \
      -filter_complex "[1:a]volume=${VOLUME}[bg];[0:a][bg]amix=inputs=2:duration=first:dropout_transition=3" \
      "$OUTPUT" 2>/dev/null

    echo "Mixed: $OUTPUT (music at ${VOLUME} volume)" >&2
    ;;

  compress)
    INPUT="${1:?Usage: audio-toolkit.sh compress <input> <output>}"
    OUTPUT="${2:?Usage: audio-toolkit.sh compress <input> <output>}"
    if [ ! -f "$INPUT" ]; then echo "Error: Input file not found: $INPUT" >&2; exit 1; fi

    ffmpeg -y -i "$INPUT" -c:a libmp3lame -b:a 96k -ac 1 "$OUTPUT" 2>/dev/null
    ORIG_SIZE=$(wc -c < "$INPUT" | tr -d ' ')
    NEW_SIZE=$(wc -c < "$OUTPUT" | tr -d ' ')
    echo "Compressed: $OUTPUT (${ORIG_SIZE} → ${NEW_SIZE} bytes)" >&2
    ;;

  convert)
    INPUT="${1:?Usage: audio-toolkit.sh convert <input> <output> [codec]}"
    OUTPUT="${2:?Usage: audio-toolkit.sh convert <input> <output> [codec]}"
    CODEC="${3:-auto}"
    if [ ! -f "$INPUT" ]; then echo "Error: Input file not found: $INPUT" >&2; exit 1; fi

    EXT="${OUTPUT##*.}"

    if [ "$CODEC" = "auto" ]; then
      case "$EXT" in
        mp3)  CODEC="libmp3lame" ;;
        ogg)  CODEC="libopus" ;;
        opus) CODEC="libopus" ;;
        m4a)  CODEC="aac" ;;
        aac)  CODEC="aac" ;;
        wav)  CODEC="pcm_s16le" ;;
        flac) CODEC="flac" ;;
        *)    CODEC="copy" ;;
      esac
    fi

    ffmpeg -y -i "$INPUT" -c:a "$CODEC" "$OUTPUT" 2>/dev/null
    echo "Converted: $OUTPUT (codec: $CODEC)" >&2
    ;;

  trim)
    INPUT="${1:?Usage: audio-toolkit.sh trim <input> <output> <start> [duration]}"
    OUTPUT="${2:?Usage: audio-toolkit.sh trim <input> <output> <start> [duration]}"
    START="${3:?Usage: audio-toolkit.sh trim <input> <output> <start> [duration]}"
    DURATION="${4:-}"
    if [ ! -f "$INPUT" ]; then echo "Error: Input file not found: $INPUT" >&2; exit 1; fi

    if [ -n "$DURATION" ]; then
      ffmpeg -y -i "$INPUT" -ss "$START" -t "$DURATION" "$OUTPUT" 2>/dev/null
    else
      ffmpeg -y -i "$INPUT" -ss "$START" "$OUTPUT" 2>/dev/null
    fi
    echo "Trimmed: $OUTPUT (start=${START}s${DURATION:+, duration=${DURATION}s})" >&2
    ;;

  silence-remove)
    INPUT="${1:?Usage: audio-toolkit.sh silence-remove <input> <output>}"
    OUTPUT="${2:?Usage: audio-toolkit.sh silence-remove <input> <output>}"
    if [ ! -f "$INPUT" ]; then echo "Error: Input file not found: $INPUT" >&2; exit 1; fi

    ffmpeg -y -i "$INPUT" \
      -af "silenceremove=start_periods=1:start_silence=0.5:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_silence=0.5:start_threshold=-50dB,areverse" \
      "$OUTPUT" 2>/dev/null

    OLD_DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$INPUT" 2>/dev/null)
    NEW_DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUTPUT" 2>/dev/null)
    echo "Silence removed: $OUTPUT (${OLD_DUR}s → ${NEW_DUR}s)" >&2
    ;;

  concat)
    OUTPUT="${1:?Usage: audio-toolkit.sh concat <output> <file1> <file2> [...]}"
    shift
    if [ $# -lt 2 ]; then
      echo "Error: Need at least 2 files to concatenate" >&2
      exit 1
    fi

    TMPDIR=$(mktemp -d)
    trap 'rm -rf "$TMPDIR"' EXIT
    FILELIST="$TMPDIR/filelist.txt"

    for F in "$@"; do
      if [ ! -f "$F" ]; then
        echo "Error: File not found: $F" >&2
        exit 1
      fi
      echo "file '$(realpath "$F")'" >> "$FILELIST"
    done

    ffmpeg -y -f concat -safe 0 -i "$FILELIST" -c copy "$OUTPUT" 2>/dev/null
    echo "Concatenated $# files → $OUTPUT" >&2
    ;;

  info)
    FILE="${1:?Usage: audio-toolkit.sh info <file>}"
    if [ ! -f "$FILE" ]; then echo "Error: File not found: $FILE" >&2; exit 1; fi

    echo "=== Audio Info: $FILE ==="
    DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$FILE" 2>/dev/null)
    FORMAT=$(ffprobe -v error -show_entries format=format_name -of csv=p=0 "$FILE" 2>/dev/null)
    BITRATE=$(ffprobe -v error -show_entries format=bit_rate -of csv=p=0 "$FILE" 2>/dev/null)
    SAMPLE=$(ffprobe -v error -show_entries stream=sample_rate -of csv=p=0 "$FILE" 2>/dev/null)
    CHANNELS=$(ffprobe -v error -show_entries stream=channels -of csv=p=0 "$FILE" 2>/dev/null)
    SIZE=$(wc -c < "$FILE" | tr -d ' ')

    echo "  Duration:    ${DURATION}s"
    echo "  Format:      $FORMAT"
    echo "  Bitrate:     $((BITRATE / 1000))kbps"
    echo "  Sample Rate: ${SAMPLE}Hz"
    echo "  Channels:    $CHANNELS"
    echo "  File Size:   $SIZE bytes"
    ;;

  help|*)
    echo "audio-toolkit.sh — FFmpeg audio processing toolkit"
    echo ""
    echo "Commands:"
    echo "  duration <file>                          — Get duration in seconds"
    echo "  normalize <input> <output>               — EBU R128 loudness normalization"
    echo "  mix <voice> <music> <output> [vol]       — Mix voice + music"
    echo "  compress <input> <output>                — Compress for messaging (96k mono)"
    echo "  convert <input> <output> [codec]         — Convert format"
    echo "  trim <input> <output> <start> [duration] — Trim audio"
    echo "  silence-remove <input> <output>          — Remove silence"
    echo "  concat <output> <file1> <file2> [...]    — Join files"
    echo "  info <file>                              — Show audio info"
    ;;
esac
