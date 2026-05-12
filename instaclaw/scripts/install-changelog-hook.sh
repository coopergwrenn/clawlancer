#!/usr/bin/env bash
# install-changelog-hook.sh — install the git post-commit hook that
# appends every new commit on `main` to docs/changelog-running.md.
#
# Idempotent. Re-running replaces an existing hook only if it's the
# version this script installs (matches the sentinel below). If a
# different hook is present, it refuses to overwrite — you can pass
# --force to override.
#
# Usage:
#   bash scripts/install-changelog-hook.sh
#   bash scripts/install-changelog-hook.sh --force
#   bash scripts/install-changelog-hook.sh --uninstall

set -eu

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK_PATH="$REPO_ROOT/.git/hooks/post-commit"
SENTINEL="# INSTACLAW_CHANGELOG_HOOK_v1"

UNINSTALL=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --uninstall) UNINSTALL=1 ;;
    --force) FORCE=1 ;;
  esac
done

if [ "$UNINSTALL" -eq 1 ]; then
  if [ -f "$HOOK_PATH" ] && grep -q "$SENTINEL" "$HOOK_PATH"; then
    rm "$HOOK_PATH"
    echo "[install-hook] removed $HOOK_PATH"
  else
    echo "[install-hook] no instaclaw hook found; nothing to uninstall."
  fi
  exit 0
fi

if [ -f "$HOOK_PATH" ]; then
  if grep -q "$SENTINEL" "$HOOK_PATH"; then
    echo "[install-hook] existing instaclaw hook detected; re-installing."
  elif [ "$FORCE" -eq 0 ]; then
    echo "[install-hook] ERROR: $HOOK_PATH exists and is not ours."
    echo "[install-hook] Pass --force to overwrite, or move it aside."
    exit 1
  fi
fi

cat > "$HOOK_PATH" <<'EOF'
#!/usr/bin/env bash
# INSTACLAW_CHANGELOG_HOOK_v1
# Auto-installed by scripts/install-changelog-hook.sh.
# Runs the append-running changelog generator after every commit on main.

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"
[ -z "$REPO_ROOT" ] && exit 0

# Skip during rebase / merge / cherry-pick
if [ -d "$REPO_ROOT/.git/rebase-merge" ] || \
   [ -d "$REPO_ROOT/.git/rebase-apply" ] || \
   [ -f "$REPO_ROOT/.git/MERGE_HEAD" ] || \
   [ -f "$REPO_ROOT/.git/CHERRY_PICK_HEAD" ]; then
  exit 0
fi

bash "$REPO_ROOT/instaclaw/scripts/changelog-append.sh" >/dev/null 2>&1 &
exit 0
EOF

chmod +x "$HOOK_PATH"
echo "[install-hook] installed $HOOK_PATH"
echo "[install-hook] next commits on main will append to instaclaw/docs/changelog-running.md"
echo "[install-hook] tail the log at instaclaw/docs/.changelog-append.log"
