#!/usr/bin/env bash
#
# setup-worktree.sh — create an isolated git worktree for a new Claude Code
# terminal session.
#
# Why: see instaclaw/docs/multi-terminal-git-worktree-setup.md.
# When multiple Claude Code terminals share a single working tree (/git/index),
# their staged files cross-contaminate. Each terminal needs its own worktree.
#
# Usage:
#   bash instaclaw/scripts/setup-worktree.sh <terminal-name> [branch]
#
# Examples:
#   bash instaclaw/scripts/setup-worktree.sh freeze-v2
#   bash instaclaw/scripts/setup-worktree.sh IR feat/IR-2026-05-16
#   bash instaclaw/scripts/setup-worktree.sh gbrain --symlink-env
#
# Flags:
#   --symlink-env       symlink .env.local + .env.ssh-key instead of copying
#                       (changes in main propagate immediately, no drift)
#   --no-npm-install    skip `npm install` (useful if you want to inspect first)
#   --dry-run           print what would happen; touch nothing
#   -h, --help          this help
#
# After it runs, cd into the new worktree:
#   cd /Users/cooperwrenn/wild-west-bots-<terminal-name>/instaclaw
#
# To clean up when done:
#   cd /Users/cooperwrenn/wild-west-bots
#   git worktree remove ../wild-west-bots-<terminal-name>
#   git branch -d feat/<terminal-name>-<date>  # if branch was never pushed

set -euo pipefail

# ─── Defaults ────────────────────────────────────────────────────────────

MAIN_REPO="/Users/cooperwrenn/wild-west-bots"
WORKTREE_PARENT="/Users/cooperwrenn"
SYMLINK_ENV=false
RUN_NPM_INSTALL=true
DRY_RUN=false

# ─── Args ────────────────────────────────────────────────────────────────

usage() {
  head -30 "$0" | sed -n '3,30p' | sed 's/^# //; s/^#//'
  exit "${1:-0}"
}

if [ $# -lt 1 ]; then usage 1; fi

TERMINAL_NAME=""
EXPLICIT_BRANCH=""

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage 0 ;;
    --symlink-env) SYMLINK_ENV=true; shift ;;
    --no-npm-install) RUN_NPM_INSTALL=false; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -*) echo "Unknown flag: $1" >&2; usage 1 ;;
    *)
      if [ -z "$TERMINAL_NAME" ]; then
        TERMINAL_NAME="$1"
      elif [ -z "$EXPLICIT_BRANCH" ]; then
        EXPLICIT_BRANCH="$1"
      else
        echo "Unexpected positional arg: $1" >&2; usage 1
      fi
      shift
      ;;
  esac
done

if [ -z "$TERMINAL_NAME" ]; then
  echo "ERROR: <terminal-name> is required" >&2
  usage 1
fi

# Validate terminal name (kebab-case, no slashes).
if ! [[ "$TERMINAL_NAME" =~ ^[a-z][a-z0-9-]*$ ]]; then
  echo "ERROR: terminal name must be lowercase kebab-case (got: $TERMINAL_NAME)" >&2
  exit 1
fi

# Build paths.
WT_PATH="${WORKTREE_PARENT}/wild-west-bots-${TERMINAL_NAME}"
WT_INSTACLAW="${WT_PATH}/instaclaw"
DATE_SUFFIX="$(date +%Y-%m-%d)"
BRANCH="${EXPLICIT_BRANCH:-feat/${TERMINAL_NAME}-${DATE_SUFFIX}}"

# ─── Preflight ───────────────────────────────────────────────────────────

echo "── setup-worktree.sh"
echo "    terminal:      ${TERMINAL_NAME}"
echo "    branch:        ${BRANCH}"
echo "    worktree path: ${WT_PATH}"
echo "    main repo:     ${MAIN_REPO}"
echo "    symlink env:   ${SYMLINK_ENV}"
echo "    npm install:   ${RUN_NPM_INSTALL}"
echo "    dry run:       ${DRY_RUN}"
echo

# Refuse if target dir exists.
if [ -e "$WT_PATH" ]; then
  echo "ERROR: target path already exists: $WT_PATH" >&2
  echo "  If a previous worktree creation failed, clean up:" >&2
  echo "    cd ${MAIN_REPO}" >&2
  echo "    git worktree remove ${WT_PATH} --force  # if git knows about it" >&2
  echo "    rm -rf ${WT_PATH}                       # to nuke from orbit" >&2
  echo "    git worktree prune" >&2
  exit 1
fi

# Refuse if main repo isn't where we expect.
if [ ! -d "${MAIN_REPO}/.git" ] && [ ! -f "${MAIN_REPO}/.git" ]; then
  echo "ERROR: ${MAIN_REPO} is not a git repository (or not where this script expects it)" >&2
  exit 1
fi
if [ ! -f "${MAIN_REPO}/instaclaw/.env.local" ]; then
  echo "ERROR: ${MAIN_REPO}/instaclaw/.env.local missing — main worktree needs to have it before we can copy" >&2
  exit 1
fi

# ─── Step 1: git worktree add ────────────────────────────────────────────

run() {
  if [ "$DRY_RUN" = true ]; then
    echo "  DRY  $*"
  else
    echo "  RUN  $*"
    eval "$@"
  fi
}

echo "Step 1/5: git worktree add"
cd "$MAIN_REPO"
run "git fetch origin main 2>&1 | tail -2"

# Check if the branch already exists (re-entry case).
if git show-ref --verify --quiet "refs/heads/${BRANCH}"; then
  echo "  branch ${BRANCH} already exists locally — using it"
  run "git worktree add '${WT_PATH}' '${BRANCH}'"
else
  echo "  creating new branch ${BRANCH} off origin/main"
  run "git worktree add '${WT_PATH}' -b '${BRANCH}' origin/main"
fi

# ─── Step 2: copy or symlink env files ───────────────────────────────────

echo
echo "Step 2/5: env files"
if [ "$SYMLINK_ENV" = true ]; then
  run "ln -s '${MAIN_REPO}/instaclaw/.env.local' '${WT_INSTACLAW}/.env.local'"
  if [ -f "${MAIN_REPO}/instaclaw/.env.ssh-key" ]; then
    run "ln -s '${MAIN_REPO}/instaclaw/.env.ssh-key' '${WT_INSTACLAW}/.env.ssh-key'"
  fi
  echo "  symlinked — main's .env changes propagate immediately"
else
  run "cp '${MAIN_REPO}/instaclaw/.env.local' '${WT_INSTACLAW}/.env.local'"
  if [ -f "${MAIN_REPO}/instaclaw/.env.ssh-key" ]; then
    run "cp '${MAIN_REPO}/instaclaw/.env.ssh-key' '${WT_INSTACLAW}/.env.ssh-key'"
    run "chmod 600 '${WT_INSTACLAW}/.env.ssh-key'"
  fi
  echo "  copied (snapshot) — re-copy if main's .env updates"
fi

# ─── Step 3: npm install (optional) ──────────────────────────────────────

echo
echo "Step 3/5: npm install"
if [ "$RUN_NPM_INSTALL" = true ]; then
  if [ "$DRY_RUN" = true ]; then
    echo "  DRY  (cd '${WT_INSTACLAW}' && npm install --no-audit --no-fund)"
  else
    cd "$WT_INSTACLAW"
    NPM_TS=$(date +%s)
    npm install --no-audit --no-fund 2>&1 | tail -2
    NPM_DT=$(($(date +%s) - NPM_TS))
    echo "  npm install: ${NPM_DT}s"
    cd "$MAIN_REPO"
  fi
else
  echo "  skipped (--no-npm-install). Run 'npm install' inside the worktree before using TypeScript."
fi

# ─── Step 4: tsc smoke test ──────────────────────────────────────────────

echo
echo "Step 4/5: tsc --noEmit smoke test"
if [ "$RUN_NPM_INSTALL" = true ] && [ "$DRY_RUN" = false ]; then
  cd "$WT_INSTACLAW"
  TSC_TS=$(date +%s)
  if npx tsc --noEmit --pretty false 2>&1 | grep -v "^\.next" | head -5; then
    TSC_DT=$(($(date +%s) - TSC_TS))
    echo "  tsc: ${TSC_DT}s (empty above = clean)"
  fi
  cd "$MAIN_REPO"
else
  echo "  skipped (no npm install ran)"
fi

# ─── Step 5: next steps ──────────────────────────────────────────────────

echo
echo "Step 5/5: next steps for the operator"
cat <<EOF

──────────────────────────────────────────────────────────────────────────
SUCCESS. Your new worktree is at:

    ${WT_PATH}

Start using it:

    cd ${WT_INSTACLAW}

The branch is '${BRANCH}'. Commits / git ops from here are isolated from
all other worktrees — no more index collisions.

When ready to integrate:

    git push origin '${BRANCH}'
    gh pr create --base main           # or merge directly if small change

When done (back in the main repo):

    cd ${MAIN_REPO}
    git worktree remove '${WT_PATH}'
    git branch -d '${BRANCH}'          # only if branch was never pushed

Optional follow-ups (per your workflow):

  • Link Vercel project for this worktree (interactive auth):
        cd ${WT_INSTACLAW} && npx vercel link --yes --project instaclaw

  • Fresh secrets from Vercel (if .env.local drifts):
        cd ${WT_INSTACLAW} && npx vercel env pull --environment=production --yes

──────────────────────────────────────────────────────────────────────────
EOF
