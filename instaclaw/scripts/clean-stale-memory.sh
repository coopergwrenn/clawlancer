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
