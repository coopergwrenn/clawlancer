#!/bin/bash
# daily-digest.sh — Send a daily summary to the user via Telegram
# Called by cron at 8am user's timezone. Skips if user engaged recently.
set -euo pipefail

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" 2>/dev/null

# Opt-out check
[ -f "$HOME/.openclaw/workspace/.no-digest" ] && exit 0

# Get bot token and chat_id from openclaw config
BOT_TOKEN=$(python3 -c "
import json
d = json.load(open('$HOME/.openclaw/openclaw.json'))
print(d.get('channels',{}).get('telegram',{}).get('botToken',''))
" 2>/dev/null)

[ -z "$BOT_TOKEN" ] && exit 0

# Get chat_id from recent getUpdates or stored value
CHAT_ID=""
if [ -f "$HOME/.openclaw/workspace/.telegram_chat_id" ]; then
  CHAT_ID=$(cat "$HOME/.openclaw/workspace/.telegram_chat_id" 2>/dev/null)
fi

[ -z "$CHAT_ID" ] && exit 0

# Check if user engaged in the last 2 hours (skip digest if so)
LAST_MSG_AGE=999999
if [ -f "$HOME/.openclaw/agents/main/sessions/sessions.json" ]; then
  LAST_MOD=$(stat -c %Y "$HOME/.openclaw/agents/main/sessions/sessions.json" 2>/dev/null || echo 0)
  NOW=$(date +%s)
  LAST_MSG_AGE=$(( (NOW - LAST_MOD) / 60 ))
fi

if [ "$LAST_MSG_AGE" -lt 120 ]; then
  # User was active in the last 2 hours — skip
  exit 0
fi

# Gather metrics
DATE=$(date +"%B %d")

# Credits used today (from .env or default)
CREDITS_USED=$(grep -o '"credits_used_today":[0-9]*' "$HOME/.openclaw/openclaw.json" 2>/dev/null | grep -o '[0-9]*' || echo "0")

# Heartbeat cycle calls today
HEARTBEAT_CALLS=$(python3 -c "
import json
try:
  d = json.load(open('$HOME/.openclaw/openclaw.json'))
  print(d.get('agents',{}).get('defaults',{}).get('heartbeat',{}).get('cyclesRun', 0))
except: print(0)
" 2>/dev/null || echo "0")

# Count messages from session files (approximate)
MSG_COUNT=0
if [ -d "$HOME/.openclaw/agents/main/sessions" ]; then
  MSG_COUNT=$(find "$HOME/.openclaw/agents/main/sessions" -name "*.jsonl" -newer "$HOME/.openclaw/agents/main/sessions/sessions.json" -mtime -1 2>/dev/null | wc -l || echo "0")
  # Better: count lines in today's session logs
  MSG_COUNT=$(find "$HOME/.openclaw/agents/main/sessions" -name "*.jsonl" -mtime 0 -exec wc -l {} + 2>/dev/null | tail -1 | awk '{print int($1/2)}' || echo "0")
fi

# Memory entries count
MEMORY_ENTRIES=0
if [ -f "$HOME/.openclaw/workspace/MEMORY.md" ]; then
  MEMORY_ENTRIES=$(grep -c "^##" "$HOME/.openclaw/workspace/MEMORY.md" 2>/dev/null || echo "0")
fi

# Build the digest message
MSG="📊 *Daily Digest — ${DATE}*"$'\n'$'\n'

HAS_ACTIVITY=false

if [ "$MSG_COUNT" -gt 0 ]; then
  MSG="${MSG}• Handled ${MSG_COUNT} messages"$'\n'
  HAS_ACTIVITY=true
fi

if [ "$HEARTBEAT_CALLS" -gt 0 ]; then
  MSG="${MSG}• Ran ${HEARTBEAT_CALLS} autonomous work cycles"$'\n'
  HAS_ACTIVITY=true
fi

if [ "$CREDITS_USED" -gt 0 ]; then
  COST=$(echo "scale=2; $CREDITS_USED * 0.003" | bc 2>/dev/null || echo "?")
  MSG="${MSG}• Used ${CREDITS_USED} credits (~\$${COST})"$'\n'
  HAS_ACTIVITY=true
fi

if [ "$MEMORY_ENTRIES" -gt 0 ]; then
  MSG="${MSG}• ${MEMORY_ENTRIES} things remembered"$'\n'
  HAS_ACTIVITY=true
fi

if [ "$HAS_ACTIVITY" = false ]; then
  MSG="${MSG}Your agent is standing by — give it a task!"$'\n'$'\n'
  MSG="${MSG}Try: \"Research the top 5 AI startups this week\" or"$'\n'
  MSG="${MSG}\"Watch DexScreener for new Base listings\""
fi

# Send text message
curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  -H "Content-Type: application/json" \
  -d "{\"chat_id\":\"${CHAT_ID}\",\"text\":$(echo "$MSG" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))'),\"parse_mode\":\"Markdown\",\"disable_web_page_preview\":true}" \
  > /dev/null 2>&1

# Send desktop thumbnail if it exists
THUMB="$HOME/.openclaw/workspace/desktop-thumbnail.jpg"
if [ -f "$THUMB" ] && [ "$(stat -c%s "$THUMB" 2>/dev/null || echo 0)" -gt 100 ]; then
  curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto" \
    -F "chat_id=${CHAT_ID}" \
    -F "photo=@${THUMB}" \
    -F "caption=🖥️ Desktop right now" \
    > /dev/null 2>&1
fi
