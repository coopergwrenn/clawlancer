#!/bin/bash
# desktop-thumbnail-cron.sh — Takes a low-res screenshot every 30s for the dashboard thumbnail
# Called by cron or strip-thinking.py. Overwrites the same file each time.
set -euo pipefail
export DISPLAY=:99
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

THUMB="$HOME/.openclaw/workspace/desktop-thumbnail.jpg"
TMP="/tmp/desktop-thumb-$$.png"
trap "rm -f '$TMP'" EXIT

# Capture screenshot
usecomputer screenshot "$TMP" --json > /dev/null 2>&1 || exit 0

# Convert to small low-quality JPEG (10-20KB)
convert "$TMP" -quality 40 -resize 400x240 "$THUMB" 2>/dev/null || exit 0
