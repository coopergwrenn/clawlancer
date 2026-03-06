#!/bin/bash
#
# clean-stale-memory.sh — Remove known-stale patterns from agent memory files
#
# Agents sometimes write "proxy is down" or "trading broken" into memory,
# then read those notes in future sessions and refuse to trade even after
# the issue is fixed. This script removes those stale entries.
#
# Usage:
#   clean-stale-memory.sh              — Clean local memory
#   clean-stale-memory.sh --report     — Dry-run, show what would be cleaned
#

set -uo pipefail

# Find memory directories
MEMORY_DIRS=()
for dir in "$HOME/workspace/memory" "$HOME/.openclaw/workspace/memory" "$HOME/memory"; do
    [ -d "$dir" ] && MEMORY_DIRS+=("$dir")
done

if [ ${#MEMORY_DIRS[@]} -eq 0 ]; then
    echo "No memory directories found"
    exit 0
fi

MODE="${1:---clean}"

# Patterns that indicate stale infrastructure complaints
# These are things that get FIXED but agents keep remembering
BAD_PATTERNS=(
    "proxy.*down"
    "proxy.*unreachable"
    "proxy.*offline"
    "connection.*refused.*proxy"
    "CLOB.*blocked"
    "CLOB.*unreachable"
    "geo.block"
    "geoblock"
    "trading.*restricted"
    "Trading restricted"
    "CLI.*broken"
    "script.*broken"
    "script.*missing"
    "doesn't.*work"
    "can't.*trade"
    "cannot.*trade"
    "no.*trading.*script"
    "need.*API.*key"
    "need.*credentials"
    "insufficient.*balance.*stuck"
    "wallet.*stuck"
    "wallet.*broken"
    "can't.*deploy.*capital"
    "awaiting.*fix"
    "awaiting.*support"
    "403.*Forbidden"
    "Gamma API.*403"
    "blocked by geo"
    "Execution blocked"
)

CLEANED=0
REPORT=""

for dir in "${MEMORY_DIRS[@]}"; do
    for file in "$dir"/*.md; do
        [ -f "$file" ] || continue
        for pattern in "${BAD_PATTERNS[@]}"; do
            matches=$(grep -ci "$pattern" "$file" 2>/dev/null || true)
            matches=${matches:-0}
            matches=$(echo "$matches" | tr -d '[:space:]')
            if [ -n "$matches" ] && [ "$matches" -gt 0 ] 2>/dev/null; then
                if [ "$MODE" = "--report" ]; then
                    REPORT+="  Would remove $matches lines matching '$pattern' from $(basename "$file")\n"
                else
                    sed -i "/$pattern/Id" "$file"
                    REPORT+="  Removed $matches lines matching '$pattern' from $(basename "$file")\n"
                fi
                CLEANED=$((CLEANED + matches))
            fi
        done
    done
done

if [ "$CLEANED" -gt 0 ]; then
    echo "Cleaned $CLEANED stale lines from memory files"
    echo -e "$REPORT"
else
    echo "Memory clean — no stale entries found"
fi

# --- Rogue Polymarket infrastructure detection (alerting only, NOT auto-delete) ---
# Detects custom Polymarket scripts/bots agents may have built in workspace.
# Kalshi is excluded — users may have legitimate custom Kalshi setups.
WORKSPACE_DIR="$HOME/.openclaw/workspace"
ROGUE_LOG="$WORKSPACE_DIR/cleanup-log.md"
ROGUE_FOUND=0

if [ -d "$WORKSPACE_DIR" ]; then
    ROGUE_REPORT=""

    # Check for .py files containing polymarket/clob references (not in scripts/)
    while IFS= read -r pyfile; do
        [ -f "$pyfile" ] || continue
        if grep -qiE "polymarket|clob_client|ClobClient|py_clob_client" "$pyfile" 2>/dev/null; then
            ROGUE_REPORT+="  WARNING: Custom Polymarket script: $pyfile\n"
            ROGUE_FOUND=$((ROGUE_FOUND + 1))
        fi
    done < <(find "$WORKSPACE_DIR" -name "*.py" -not -path "*/node_modules/*" 2>/dev/null)

    # Check for .env files with Polymarket credentials
    while IFS= read -r envfile; do
        [ -f "$envfile" ] || continue
        if grep -qE "POLYMARKET|CLOB_SECRET|PRIVATE_KEY" "$envfile" 2>/dev/null; then
            ROGUE_REPORT+="  WARNING: Credentials file with Polymarket keys: $envfile\n"
            ROGUE_FOUND=$((ROGUE_FOUND + 1))
        fi
    done < <(find "$WORKSPACE_DIR" -name ".env*" -not -path "*/node_modules/*" 2>/dev/null)

    # Check for polymarket bot directories
    while IFS= read -r botdir; do
        ROGUE_REPORT+="  WARNING: Polymarket bot directory: $botdir\n"
        ROGUE_FOUND=$((ROGUE_FOUND + 1))
    done < <(find "$WORKSPACE_DIR" -type d -iname "*polymarket*bot*" 2>/dev/null)

    if [ "$ROGUE_FOUND" -gt 0 ]; then
        echo ""
        echo "⚠️  ROGUE POLYMARKET INFRASTRUCTURE DETECTED ($ROGUE_FOUND items)"
        echo -e "$ROGUE_REPORT"
        echo "These files were NOT auto-deleted. Review manually and remove if not user-created."

        # Log to cleanup-log.md for audit trail
        {
            echo ""
            echo "## $(date -u '+%Y-%m-%d %H:%M UTC') — Rogue Polymarket Infrastructure Detected"
            echo ""
            echo "$ROGUE_FOUND item(s) found. NOT auto-deleted — flagged for review."
            echo ""
            echo -e "$ROGUE_REPORT"
        } >> "$ROGUE_LOG"
    fi
fi
