#!/usr/bin/env bash
# changelog-append.sh — run the changelog generator in append-running mode.
# Safe to call from a git post-commit hook, a cron job, or by hand.
# - Only runs on the `main` branch (skips on feature branches).
# - Runs in background by default so it never blocks a commit.
# - Logs to instaclaw/docs/.changelog-append.log so failures don't get lost.
#
# Usage:
#   bash scripts/changelog-append.sh           # background, silent
#   bash scripts/changelog-append.sh --fg      # foreground, prints output
#   bash scripts/changelog-append.sh --force   # run even on non-main branches

set -u
trap '' PIPE

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.."
INSTACLAW_DIR="$REPO_ROOT/instaclaw"
LOG_PATH="$INSTACLAW_DIR/docs/.changelog-append.log"

FOREGROUND=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --fg|--foreground) FOREGROUND=1 ;;
    --force) FORCE=1 ;;
  esac
done

BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"

if [ "$FORCE" -eq 0 ] && [ "$BRANCH" != "main" ]; then
  # Quiet exit on non-main; we don't want feature-branch noise.
  exit 0
fi

run() {
  cd "$INSTACLAW_DIR" || exit 0
  {
    echo "==== $(date -u +'%Y-%m-%dT%H:%M:%SZ') branch=$BRANCH ===="
    npx tsx scripts/generate-changelog.ts --append-running 2>&1
  } >> "$LOG_PATH"
}

if [ "$FOREGROUND" -eq 1 ]; then
  run
else
  # Detach so a slow LLM-free generator doesn't slow git commit.
  ( run </dev/null >/dev/null 2>&1 & ) &
fi

exit 0
