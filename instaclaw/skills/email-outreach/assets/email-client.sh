#!/bin/bash
#
# email-client.sh — Email client for AI agents
#
# Providers:
#   - Resend (default): Send-only via instaclaw.io domain. Always available.
#   - AgentMail (BYOK): Full inbox (send+receive). Only if user connected their key.
#
# Usage: email-client.sh <command> [options...]
#
# Commands:
#   send      --to <addr> --subject <subj> --body <text> [--content-type text/html]
#   check     [--unread] [--from <addr>] [--limit <n>]   (AgentMail only)
#   reply     --thread-id <id> --body <text>              (AgentMail only)
#   threads   [--limit <n>]                               (AgentMail only)
#   search    --query <text>                              (AgentMail only)
#   info                                                  — Show email config
#   delete    --message-id <id>                           (AgentMail only)
#
# Environment (from ~/.openclaw/.env):
#   RESEND_API_KEY      — Platform-provided. Always available for sending.
#   AGENTMAIL_API_KEY   — User-provided BYOK. Enables full inbox features.
#

set -euo pipefail

# Load config
RESEND_API_KEY="${RESEND_API_KEY:-}"
AGENTMAIL_API_KEY="${AGENTMAIL_API_KEY:-}"
EMAIL_FROM="${EMAIL_FROM:-}"
AGENTMAIL_INBOX_ID="${AGENTMAIL_INBOX_ID:-}"

# Load from .env
load_env_var() {
  local key="$1"
  if [ -f "$HOME/.openclaw/.env" ]; then
    grep "^${key}=" "$HOME/.openclaw/.env" 2>/dev/null | head -1 | sed 's/^[^=]*=//' | tr -d '"' | tr -d "'"
  fi
}

[ -z "$RESEND_API_KEY" ] && RESEND_API_KEY=$(load_env_var "RESEND_API_KEY")
[ -z "$AGENTMAIL_API_KEY" ] && AGENTMAIL_API_KEY=$(load_env_var "AGENTMAIL_API_KEY")

# Load email-config.json
EMAIL_CONFIG="$HOME/.openclaw/email-config.json"
if [ -f "$EMAIL_CONFIG" ]; then
  EMAIL_FROM="${EMAIL_FROM:-$(python3 -c "import json; print(json.load(open('$EMAIL_CONFIG')).get('from_address',''))" 2>/dev/null || true)}"
  AGENTMAIL_INBOX_ID="${AGENTMAIL_INBOX_ID:-$(python3 -c "import json; print(json.load(open('$EMAIL_CONFIG')).get('agentmail_inbox_id',''))" 2>/dev/null || true)}"
fi

# Determine provider
has_agentmail() { [ -n "$AGENTMAIL_API_KEY" ] && [ -n "$AGENTMAIL_INBOX_ID" ]; }
has_resend() { [ -n "$RESEND_API_KEY" ]; }

CMD="${1:-help}"
shift || true

# Parse named options
declare -A OPTS
while [[ $# -gt 0 ]]; do
  case "$1" in
    --to|--subject|--body|--from|--limit|--thread-id|--message-id|--query|--content-type)
      key="${1#--}"
      key="${key//-/_}"
      OPTS["$key"]="${2:-}"
      shift 2
      ;;
    --unread)
      OPTS["unread"]="true"
      shift
      ;;
    *)
      echo "{\"error\": \"Unknown option: $1\"}" >&2
      exit 1
      ;;
  esac
done

require_agentmail() {
  if ! has_agentmail; then
    echo "Error: This command requires AgentMail BYOK." >&2
    echo "The user needs to connect their AgentMail API key for inbox features." >&2
    echo "Send-only email via Resend is available with the 'send' command." >&2
    exit 1
  fi
}

# Resend API call
resend_send() {
  local to="$1" subject="$2" body="$3" content_type="${4:-text/plain}"
  local from="${EMAIL_FROM:-agent@instaclaw.io}"

  local payload
  if [ "$content_type" = "text/html" ]; then
    payload=$(python3 -c "
import json, sys
lines = sys.stdin.read().split('\n', 1)
subj = lines[0]
body = lines[1] if len(lines) > 1 else ''
print(json.dumps({'from': '$from', 'to': ['$to'], 'subject': subj, 'html': body}))
" <<< "$subject
$body")
  else
    payload=$(python3 -c "
import json, sys
lines = sys.stdin.read().split('\n', 1)
subj = lines[0]
body = lines[1] if len(lines) > 1 else ''
print(json.dumps({'from': '$from', 'to': ['$to'], 'subject': subj, 'text': body}))
" <<< "$subject
$body")
  fi

  local response
  response=$(curl -s -w "\n%{http_code}" -X POST "https://api.resend.com/emails" \
    -H "Authorization: Bearer $RESEND_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$payload" 2>/dev/null)

  local http_code body_out
  http_code=$(echo "$response" | tail -1)
  body_out=$(echo "$response" | sed '$d')

  if [[ "$http_code" -ge 200 && "$http_code" -lt 300 ]]; then
    echo "$body_out"
    return 0
  else
    echo "{\"error\": \"Resend HTTP $http_code\", \"detail\": $body_out}" >&2
    return 1
  fi
}

# AgentMail API call
agentmail_call() {
  local method="$1" endpoint="$2" data="${3:-}"
  local base="https://api.agentmail.to/v0"

  local args=(-s -w "\n%{http_code}" -X "$method"
    -H "Authorization: Bearer $AGENTMAIL_API_KEY"
    -H "Content-Type: application/json"
    "${base}${endpoint}")

  [ -n "$data" ] && args+=(-d "$data")

  local response
  response=$(curl "${args[@]}" 2>/dev/null)

  local http_code body_out
  http_code=$(echo "$response" | tail -1)
  body_out=$(echo "$response" | sed '$d')

  if [[ "$http_code" -ge 200 && "$http_code" -lt 300 ]]; then
    echo "$body_out"
  else
    echo "{\"error\": \"AgentMail HTTP $http_code\", \"detail\": $(echo "$body_out" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo '""')}" >&2
    return 1
  fi
}

case "$CMD" in

  send)
    TO="${OPTS[to]:?Usage: email-client.sh send --to <addr> --subject <subj> --body <text>}"
    SUBJECT="${OPTS[subject]:?Missing --subject}"
    BODY="${OPTS[body]:?Missing --body}"
    CONTENT_TYPE="${OPTS[content_type]:-text/plain}"

    # Run pre-send safety check
    if [ -f "$HOME/scripts/email-safety-check.py" ]; then
      SAFETY=$(python3 "$HOME/scripts/email-safety-check.py" \
        --to "$TO" --subject "$SUBJECT" --body "$BODY" 2>/dev/null || echo "WARN")
      if echo "$SAFETY" | grep -q "BLOCK"; then
        echo "{\"error\": \"Pre-send safety check BLOCKED this email\", \"reason\": $(echo "$SAFETY" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null)}" >&2
        exit 2
      fi
      if echo "$SAFETY" | grep -q "WARN"; then
        echo "WARNING: Safety check flagged this email — review recommended" >&2
      fi
    fi

    # Send via AgentMail if available, otherwise Resend
    if has_agentmail; then
      PAYLOAD=$(python3 -c "
import json, sys
lines = sys.stdin.read().split('\n', 1)
subj = lines[0]
body = lines[1] if len(lines) > 1 else ''
print(json.dumps({'to': '$TO', 'subject': subj, 'body': body, 'content_type': '$CONTENT_TYPE'}))
" <<< "$SUBJECT
$BODY")
      agentmail_call POST "/inboxes/${AGENTMAIL_INBOX_ID}/messages" "$PAYLOAD"
      echo "Email sent via AgentMail to $TO" >&2
    elif has_resend; then
      resend_send "$TO" "$SUBJECT" "$BODY" "$CONTENT_TYPE"
      echo "Email sent via Resend to $TO" >&2
    else
      echo "{\"error\": \"No email provider configured. Need RESEND_API_KEY or AGENTMAIL_API_KEY in ~/.openclaw/.env\"}" >&2
      exit 1
    fi

    # Log send for rate limiting
    if [ -f "$HOME/scripts/email-safety-check.py" ]; then
      python3 "$HOME/scripts/email-safety-check.py" --log-send --to "$TO" 2>/dev/null || true
    fi
    ;;

  check)
    require_agentmail
    LIMIT="${OPTS[limit]:-20}"
    QUERY_PARAMS="?limit=${LIMIT}"
    [ "${OPTS[unread]:-}" = "true" ] && QUERY_PARAMS="${QUERY_PARAMS}&unread=true"
    [ -n "${OPTS[from]:-}" ] && QUERY_PARAMS="${QUERY_PARAMS}&from=${OPTS[from]}"
    agentmail_call GET "/inboxes/${AGENTMAIL_INBOX_ID}/messages${QUERY_PARAMS}"
    ;;

  reply)
    require_agentmail
    THREAD_ID="${OPTS[thread_id]:?Usage: email-client.sh reply --thread-id <id> --body <text>}"
    BODY="${OPTS[body]:?Missing --body}"

    if [ -f "$HOME/scripts/email-safety-check.py" ]; then
      SAFETY=$(python3 "$HOME/scripts/email-safety-check.py" \
        --to "thread" --subject "Re: thread" --body "$BODY" 2>/dev/null || echo "WARN")
      if echo "$SAFETY" | grep -q "BLOCK"; then
        echo "{\"error\": \"Safety check BLOCKED this reply\"}" >&2
        exit 2
      fi
    fi

    PAYLOAD=$(python3 -c "import json,sys; print(json.dumps({'body': sys.stdin.read()}))" <<< "$BODY")
    agentmail_call POST "/threads/${THREAD_ID}/reply" "$PAYLOAD"
    echo "Reply sent to thread $THREAD_ID" >&2
    ;;

  threads)
    require_agentmail
    LIMIT="${OPTS[limit]:-20}"
    agentmail_call GET "/inboxes/${AGENTMAIL_INBOX_ID}/threads?limit=${LIMIT}"
    ;;

  search)
    require_agentmail
    QUERY="${OPTS[query]:?Usage: email-client.sh search --query <text>}"
    PAYLOAD=$(python3 -c "import json; print(json.dumps({'query': '$QUERY'}))")
    agentmail_call POST "/inboxes/${AGENTMAIL_INBOX_ID}/search" "$PAYLOAD"
    ;;

  info)
    echo "=== Email Configuration ===" >&2
    echo "  From address: ${EMAIL_FROM:-agent@instaclaw.io}" >&2
    echo "" >&2
    if has_resend; then
      echo "  Resend:     CONFIGURED (send-only)" >&2
    else
      echo "  Resend:     NOT CONFIGURED" >&2
    fi
    if has_agentmail; then
      echo "  AgentMail:  CONFIGURED (full inbox)" >&2
      echo "  Inbox ID:   $AGENTMAIL_INBOX_ID" >&2
    else
      echo "  AgentMail:  Not connected (BYOK — user can add their own key)" >&2
    fi
    echo "" >&2
    echo "  Config: $EMAIL_CONFIG" >&2
    ;;

  delete)
    require_agentmail
    MSG_ID="${OPTS[message_id]:?Usage: email-client.sh delete --message-id <id>}"
    agentmail_call DELETE "/messages/${MSG_ID}"
    echo "Message $MSG_ID deleted" >&2
    ;;

  help|*)
    echo "email-client.sh — Email client (Resend default + AgentMail BYOK)" >&2
    echo "" >&2
    echo "Send commands (always available):" >&2
    echo "  send    --to <addr> --subject <subj> --body <text>  — Send email" >&2
    echo "  info                                                — Show config" >&2
    echo "" >&2
    echo "Inbox commands (AgentMail BYOK only):" >&2
    echo "  check   [--unread] [--from <addr>] [--limit <n>]    — Check inbox" >&2
    echo "  reply   --thread-id <id> --body <text>              — Reply to thread" >&2
    echo "  threads [--limit <n>]                               — List threads" >&2
    echo "  search  --query <text>                              — Search inbox" >&2
    echo "  delete  --message-id <id>                           — Delete message" >&2
    ;;
esac
