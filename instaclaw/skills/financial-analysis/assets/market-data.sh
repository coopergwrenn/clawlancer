#!/bin/bash
#
# market-data.sh — Alpha Vantage API client for AI agents
#
# Usage: market-data.sh <command> [options...]
#
# Commands:
#   quote      --symbol <sym>                          — Real-time quote
#   daily      --symbol <sym> [--outputsize compact]   — Daily OHLCV
#   intraday   --symbol <sym> [--interval 15min]       — Intraday prices
#   indicator  --function <fn> --symbol <sym> [opts]   — Technical indicator
#   options    --symbol <sym>                           — Options chain
#   crypto     --symbol <sym> [--market USD]            — Crypto prices
#   forex      --from-currency <c> --to-currency <c>   — FX rate
#   commodity  --function <fn>                          — Commodity prices
#   economy    --function <fn>                          — Economic data
#   news       [--tickers <t>] [--limit <n>]           — News sentiment
#   movers                                              — Top gainers/losers
#   earnings   --symbol <sym>                           — Earnings calendar
#   search     --keywords <text>                        — Symbol search
#   rate-status                                         — Show API usage
#
# Environment:
#   ALPHAVANTAGE_API_KEY — Required (from ~/.openclaw/.env)
#

set -euo pipefail

# Load API key
ALPHAVANTAGE_API_KEY="${ALPHAVANTAGE_API_KEY:-}"

if [ -z "$ALPHAVANTAGE_API_KEY" ] && [ -f "$HOME/.openclaw/.env" ]; then
  ALPHAVANTAGE_API_KEY=$(grep "^ALPHAVANTAGE_API_KEY=" "$HOME/.openclaw/.env" 2>/dev/null | head -1 | sed 's/^[^=]*=//' | tr -d '"' | tr -d "'")
fi

if [ -z "$ALPHAVANTAGE_API_KEY" ]; then
  echo '{"error": "ALPHAVANTAGE_API_KEY not set. Check ~/.openclaw/.env"}' >&2
  exit 1
fi

BASE_URL="https://www.alphavantage.co/query"
CACHE_DIR="$HOME/.openclaw/cache/alphavantage"
RATE_FILE="$HOME/.openclaw/cache/alphavantage/.rate-log"
DAILY_BUDGET=500

mkdir -p "$CACHE_DIR"

CMD="${1:-help}"
shift || true

# Parse named options
declare -A OPTS
while [[ $# -gt 0 ]]; do
  case "$1" in
    --symbol|--function|--interval|--outputsize|--time-period|--series-type|--from-currency|--to-currency|--tickers|--limit|--keywords|--market)
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
    echo "{\"error\": \"Daily API budget exhausted ($count/$DAILY_BUDGET requests). Resets at midnight UTC.\"}" >&2
    exit 2
  fi
  if [ "$count" -ge 400 ]; then
    echo "WARNING: Approaching daily API budget ($count/$DAILY_BUDGET requests)" >&2
  fi
}

# Caching
get_cache_key() {
  echo "$*" | md5sum 2>/dev/null | cut -d' ' -f1 || echo "$*" | shasum | cut -d' ' -f1
}

check_cache() {
  local key="$1" ttl="$2"
  local cache_file="$CACHE_DIR/$key.json"
  if [ -f "$cache_file" ]; then
    local age
    age=$(( $(date +%s) - $(stat -f%m "$cache_file" 2>/dev/null || stat -c%Y "$cache_file" 2>/dev/null || echo 0) ))
    if [ "$age" -lt "$ttl" ]; then
      cat "$cache_file"
      return 0
    fi
  fi
  return 1
}

write_cache() {
  local key="$1" data="$2"
  echo "$data" > "$CACHE_DIR/$key.json"
}

# API call with caching
av_call() {
  local params="$1" cache_ttl="${2:-300}"
  local cache_key
  cache_key=$(get_cache_key "$params")

  # Check cache first
  if check_cache "$cache_key" "$cache_ttl" 2>/dev/null; then
    return 0
  fi

  # Rate limit check
  check_rate_limit

  local url="${BASE_URL}?${params}&apikey=${ALPHAVANTAGE_API_KEY}"
  local response
  response=$(curl -s --max-time 30 "$url" 2>/dev/null)

  if [ -z "$response" ]; then
    echo '{"error": "Empty response from Alpha Vantage API"}' >&2
    return 1
  fi

  # Check for API errors
  if echo "$response" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if 'Error Message' in d or 'Note' in d else 1)" 2>/dev/null; then
    echo "$response" >&2
    return 1
  fi

  log_request
  write_cache "$cache_key" "$response"
  echo "$response"
}

case "$CMD" in

  quote)
    SYMBOL="${OPTS[symbol]:?Usage: market-data.sh quote --symbol <sym>}"
    av_call "function=GLOBAL_QUOTE&symbol=$SYMBOL" 60
    ;;

  daily)
    SYMBOL="${OPTS[symbol]:?Usage: market-data.sh daily --symbol <sym>}"
    OUTPUTSIZE="${OPTS[outputsize]:-compact}"
    av_call "function=TIME_SERIES_DAILY&symbol=$SYMBOL&outputsize=$OUTPUTSIZE" 300
    ;;

  intraday)
    SYMBOL="${OPTS[symbol]:?Usage: market-data.sh intraday --symbol <sym>}"
    INTERVAL="${OPTS[interval]:-15min}"
    av_call "function=TIME_SERIES_INTRADAY&symbol=$SYMBOL&interval=$INTERVAL&outputsize=compact" 60
    ;;

  indicator)
    FUNCTION="${OPTS[function]:?Usage: market-data.sh indicator --function <fn> --symbol <sym>}"
    SYMBOL="${OPTS[symbol]:?Missing --symbol}"
    INTERVAL="${OPTS[interval]:-daily}"
    TIME_PERIOD="${OPTS[time_period]:-14}"
    SERIES_TYPE="${OPTS[series_type]:-close}"
    av_call "function=$FUNCTION&symbol=$SYMBOL&interval=$INTERVAL&time_period=$TIME_PERIOD&series_type=$SERIES_TYPE" 300
    ;;

  options)
    SYMBOL="${OPTS[symbol]:?Usage: market-data.sh options --symbol <sym>}"
    av_call "function=REALTIME_OPTIONS&symbol=$SYMBOL" 120
    ;;

  crypto)
    SYMBOL="${OPTS[symbol]:?Usage: market-data.sh crypto --symbol <sym>}"
    MARKET="${OPTS[market]:-USD}"
    av_call "function=DIGITAL_CURRENCY_DAILY&symbol=$SYMBOL&market=$MARKET" 60
    ;;

  forex)
    FROM="${OPTS[from_currency]:?Usage: market-data.sh forex --from-currency <c> --to-currency <c>}"
    TO="${OPTS[to_currency]:?Missing --to-currency}"
    av_call "function=CURRENCY_EXCHANGE_RATE&from_currency=$FROM&to_currency=$TO" 60
    ;;

  commodity)
    FUNCTION="${OPTS[function]:?Usage: market-data.sh commodity --function <fn>}"
    av_call "function=$FUNCTION&interval=daily" 300
    ;;

  economy)
    FUNCTION="${OPTS[function]:?Usage: market-data.sh economy --function <fn>}"
    av_call "function=$FUNCTION" 3600
    ;;

  news)
    TICKERS="${OPTS[tickers]:-}"
    LIMIT="${OPTS[limit]:-10}"
    PARAMS="function=NEWS_SENTIMENT&limit=$LIMIT"
    [ -n "$TICKERS" ] && PARAMS="${PARAMS}&tickers=$TICKERS"
    av_call "$PARAMS" 1800
    ;;

  movers)
    av_call "function=TOP_GAINERS_LOSERS" 300
    ;;

  earnings)
    SYMBOL="${OPTS[symbol]:-}"
    PARAMS="function=EARNINGS_CALENDAR"
    [ -n "$SYMBOL" ] && PARAMS="${PARAMS}&symbol=$SYMBOL"
    # Earnings calendar returns CSV, not JSON — handle specially
    check_rate_limit
    local_url="${BASE_URL}?${PARAMS}&apikey=${ALPHAVANTAGE_API_KEY}"
    curl -s --max-time 30 "$local_url" 2>/dev/null
    log_request
    ;;

  search)
    KEYWORDS="${OPTS[keywords]:?Usage: market-data.sh search --keywords <text>}"
    av_call "function=SYMBOL_SEARCH&keywords=$KEYWORDS" 3600
    ;;

  rate-status)
    COUNT=$(get_daily_count)
    echo "Alpha Vantage API Usage" >&2
    echo "  Date:      $(date -u +%Y-%m-%d)" >&2
    echo "  Requests:  $COUNT / $DAILY_BUDGET" >&2
    echo "  Remaining: $(( DAILY_BUDGET - COUNT ))" >&2
    if [ "$COUNT" -ge 400 ]; then
      echo "  Status:    WARNING — approaching limit" >&2
    else
      echo "  Status:    OK" >&2
    fi
    ;;

  help|*)
    echo "market-data.sh — Alpha Vantage API client" >&2
    echo "" >&2
    echo "Commands:" >&2
    echo "  quote      --symbol <sym>                          — Real-time quote" >&2
    echo "  daily      --symbol <sym> [--outputsize compact]   — Daily OHLCV" >&2
    echo "  intraday   --symbol <sym> [--interval 15min]       — Intraday prices" >&2
    echo "  indicator  --function <fn> --symbol <sym> [opts]   — Technical indicator" >&2
    echo "  options    --symbol <sym>                           — Options chain" >&2
    echo "  crypto     --symbol <sym> [--market USD]            — Crypto prices" >&2
    echo "  forex      --from-currency <c> --to-currency <c>   — FX rate" >&2
    echo "  commodity  --function <fn>                          — Commodity prices" >&2
    echo "  economy    --function <fn>                          — Economic data" >&2
    echo "  news       [--tickers <t>] [--limit <n>]           — News sentiment" >&2
    echo "  movers                                              — Top gainers/losers" >&2
    echo "  earnings   --symbol <sym>                           — Earnings calendar" >&2
    echo "  search     --keywords <text>                        — Symbol search" >&2
    echo "  rate-status                                         — Show API usage" >&2
    ;;
esac
