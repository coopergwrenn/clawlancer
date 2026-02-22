#!/bin/bash
#
# competitive-intel.sh — Brave Search API client for competitive intelligence
#
# Usage: competitive-intel.sh <command> [options...]
#
# Commands:
#   search     --query <text> [--count <n>] [--freshness <pd|pw|pm>]  — Web search
#   news       --query <text> [--count <n>] [--freshness <pd|pw|pm>]  — News search
#   snapshot   --url <url> --competitor <name> --category <cat>        — Fetch & store page
#   rate-status                                                        — Show API usage
#
# Environment:
#   BRAVE_SEARCH_API_KEY — Required (from ~/.openclaw/.env)
#
# Freshness values: pd=past day, pw=past week, pm=past month
#

set -euo pipefail

# Load API key
BRAVE_SEARCH_API_KEY="${BRAVE_SEARCH_API_KEY:-}"

if [ -z "$BRAVE_SEARCH_API_KEY" ] && [ -f "$HOME/.openclaw/.env" ]; then
  BRAVE_SEARCH_API_KEY=$(grep "^BRAVE_SEARCH_API_KEY=" "$HOME/.openclaw/.env" 2>/dev/null | head -1 | sed 's/^[^=]*=//' | tr -d '"' | tr -d "'")
fi

if [ -z "$BRAVE_SEARCH_API_KEY" ]; then
  echo '{"error": "BRAVE_SEARCH_API_KEY not set. Check ~/.openclaw/.env"}' >&2
  exit 1
fi

BRAVE_SEARCH_URL="https://api.search.brave.com/res/v1/web/search"
BRAVE_NEWS_URL="https://api.search.brave.com/res/v1/news/search"
CACHE_DIR="$HOME/.openclaw/cache/brave-search"
RATE_FILE="$CACHE_DIR/.rate-log"
SNAPSHOT_DIR="$HOME/.openclaw/workspace/competitive-intel/snapshots"
DAILY_BUDGET=200

mkdir -p "$CACHE_DIR" "$SNAPSHOT_DIR"

CMD="${1:-help}"
shift || true

# Parse named options
declare -A OPTS
while [[ $# -gt 0 ]]; do
  case "$1" in
    --query|--count|--freshness|--url|--competitor|--category)
      key="${1#--}"
      key="${key//-/_}"
      OPTS["$key"]="${2:-}"
      shift 2
      ;;
    *)
      echo "{\"error\": \"Unknown option: $1\"}" >&2
      exit 1
      ;;
  esac
done

# Rate limiting
log_request() {
  local today
  today=$(date -u +%Y-%m-%d)
  echo "$today $(date -u +%H:%M:%S)" >> "$RATE_FILE"
}

get_daily_count() {
  local today
  today=$(date -u +%Y-%m-%d)
  if [ -f "$RATE_FILE" ]; then
    grep -c "^$today" "$RATE_FILE" 2>/dev/null || echo "0"
  else
    echo "0"
  fi
}

check_rate_limit() {
  local count
  count=$(get_daily_count)
  if [ "$count" -ge "$DAILY_BUDGET" ]; then
    echo "{\"error\": \"Daily API budget exhausted ($count/$DAILY_BUDGET). Resets at midnight UTC.\"}" >&2
    exit 2
  fi
  if [ "$count" -ge 160 ]; then
    echo "WARNING: Approaching daily budget ($count/$DAILY_BUDGET)" >&2
  fi
}

# Brave Search API call
brave_search() {
  local query="$1" count="${2:-10}" freshness="${3:-}" search_url="${4:-$BRAVE_SEARCH_URL}"

  check_rate_limit

  local url="${search_url}?q=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$query'))")&count=${count}"
  [ -n "$freshness" ] && url="${url}&freshness=${freshness}"

  local response
  response=$(curl -s --max-time 30 \
    -H "Accept: application/json" \
    -H "Accept-Encoding: gzip" \
    -H "X-Subscription-Token: $BRAVE_SEARCH_API_KEY" \
    "$url" 2>/dev/null)

  if [ -z "$response" ]; then
    echo '{"error": "Empty response from Brave Search API"}' >&2
    return 1
  fi

  log_request
  echo "$response"
}

case "$CMD" in

  search)
    QUERY="${OPTS[query]:?Usage: competitive-intel.sh search --query <text>}"
    COUNT="${OPTS[count]:-10}"
    FRESHNESS="${OPTS[freshness]:-}"
    brave_search "$QUERY" "$COUNT" "$FRESHNESS" "$BRAVE_SEARCH_URL"
    ;;

  news)
    QUERY="${OPTS[query]:?Usage: competitive-intel.sh news --query <text>}"
    COUNT="${OPTS[count]:-5}"
    FRESHNESS="${OPTS[freshness]:-}"
    brave_search "$QUERY" "$COUNT" "$FRESHNESS" "$BRAVE_NEWS_URL"
    ;;

  snapshot)
    URL="${OPTS[url]:?Usage: competitive-intel.sh snapshot --url <url> --competitor <name> --category <cat>}"
    COMPETITOR="${OPTS[competitor]:?Missing --competitor}"
    CATEGORY="${OPTS[category]:?Missing --category}"

    check_rate_limit

    # Fetch the page content
    PAGE_CONTENT=$(curl -s --max-time 30 -L "$URL" 2>/dev/null)
    log_request

    if [ -z "$PAGE_CONTENT" ]; then
      echo "{\"error\": \"Failed to fetch $URL\"}" >&2
      exit 1
    fi

    # Store snapshot
    TODAY=$(date -u +%Y-%m-%d)
    COMP_LOWER=$(echo "$COMPETITOR" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')
    SNAPSHOT_FILE="$SNAPSHOT_DIR/${TODAY}-${COMP_LOWER}-${CATEGORY}.json"

    # Create snapshot JSON
    python3 -c "
import json, sys
content = sys.stdin.read()
snapshot = {
    'date': '$TODAY',
    'competitor': '$COMPETITOR',
    'category': '$CATEGORY',
    'url': '$URL',
    'content_length': len(content),
    'content_preview': content[:2000],
    'fetched_at': '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
}
print(json.dumps(snapshot, indent=2))
" <<< "$PAGE_CONTENT" > "$SNAPSHOT_FILE"

    echo "{\"status\": \"ok\", \"file\": \"$SNAPSHOT_FILE\", \"size\": $(wc -c < "$SNAPSHOT_FILE")}" >&2
    echo "$PAGE_CONTENT"
    ;;

  rate-status)
    COUNT=$(get_daily_count)
    echo "Brave Search API Usage" >&2
    echo "  Date:      $(date -u +%Y-%m-%d)" >&2
    echo "  Requests:  $COUNT / $DAILY_BUDGET" >&2
    echo "  Remaining: $(( DAILY_BUDGET - COUNT ))" >&2
    if [ "$COUNT" -ge 160 ]; then
      echo "  Status:    WARNING — approaching limit" >&2
    else
      echo "  Status:    OK" >&2
    fi
    ;;

  help|*)
    echo "competitive-intel.sh — Brave Search API client for competitive intelligence" >&2
    echo "" >&2
    echo "Commands:" >&2
    echo "  search     --query <text> [--count <n>] [--freshness pd|pw|pm]  — Web search" >&2
    echo "  news       --query <text> [--count <n>] [--freshness pd|pw|pm]  — News search" >&2
    echo "  snapshot   --url <url> --competitor <name> --category <cat>      — Fetch & store" >&2
    echo "  rate-status                                                       — Show usage" >&2
    ;;
esac
