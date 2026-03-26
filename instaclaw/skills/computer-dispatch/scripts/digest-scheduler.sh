#!/bin/bash
# digest-scheduler.sh — Runs hourly via cron. Checks if it's 8am in user's timezone.
# If yes, runs the daily digest. This avoids needing per-timezone cron entries.
set -euo pipefail

# Read user's timezone from the OpenClaw config or default to UTC
TZ_FILE="$HOME/.openclaw/workspace/.user_timezone"
USER_TZ="America/New_York"

if [ -f "$TZ_FILE" ]; then
  USER_TZ=$(cat "$TZ_FILE" 2>/dev/null)
fi

# Check if it's 8am (hour 08) in user's timezone
CURRENT_HOUR=$(TZ="$USER_TZ" date +%H 2>/dev/null || date +%H)

if [ "$CURRENT_HOUR" = "08" ]; then
  bash "$HOME/scripts/daily-digest.sh" 2>/dev/null || true
fi
