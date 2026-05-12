#!/bin/bash
#
# _restore-memory.sh — Decrypt + untar a backup-memory.sh artifact.
#
# Mirror of backup-memory.sh. Takes an encrypted backup path + optional
# target directory; decrypts with the gateway_token-derived key; untars
# to target.
#
# Usage:
#   bash _restore-memory.sh BACKUP_FILE [TARGET_DIR]
#
#   BACKUP_FILE:  Path to .tar.gz.enc artifact (local path, after S3
#                 download if you have one).
#   TARGET_DIR:   Where to extract. Default: /tmp/openclaw-restore-<ts>
#                 (we don't overwrite ~/.openclaw/workspace by default
#                 — the user / admin manually copies in what they want).
#
# Required env:
#   GATEWAY_TOKEN — the gateway_token whose HKDF derives the key. Read
#                   from ~/.openclaw/.env if not set in env.
#
# Exit codes:
#   0  success
#   1  setup error (missing token, missing file)
#   2  decrypt failed (wrong key, corrupt file, etc.)
#   3  untar failed
#
# After restore, inspect TARGET_DIR/workspace and TARGET_DIR/sessions
# manually. The script does NOT auto-overwrite the live workspace —
# restore is always opt-in to avoid clobbering active state.

set -euo pipefail

if [ $# -lt 1 ]; then
  cat <<EOF >&2
Usage: $0 BACKUP_FILE [TARGET_DIR]

BACKUP_FILE:  Encrypted .tar.gz.enc artifact (from ~/.openclaw/backups/
              or S3 download).
TARGET_DIR:   Where to extract. Default: /tmp/openclaw-restore-<ts>.
EOF
  exit 1
fi

BACKUP_FILE="$1"
TARGET_DIR="${2:-/tmp/openclaw-restore-$(date -u +%Y%m%dT%H%M%SZ)}"

if [ ! -f "$BACKUP_FILE" ]; then
  echo "ERROR: backup file not found: $BACKUP_FILE" >&2
  exit 1
fi

# Source GATEWAY_TOKEN from env or .env.
if [ -z "${GATEWAY_TOKEN:-}" ]; then
  if [ -f "$HOME/.openclaw/.env" ]; then
    GATEWAY_TOKEN=$(grep '^GATEWAY_TOKEN=' "$HOME/.openclaw/.env" \
      | head -n 1 \
      | cut -d= -f2- \
      | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
  fi
fi

if [ -z "${GATEWAY_TOKEN:-}" ]; then
  echo "ERROR: GATEWAY_TOKEN not set in env and not found in ~/.openclaw/.env" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"
TAR_PATH="$(mktemp -t openclaw-restore-XXXXXX.tar.gz)"

# Decrypt (mirror of backup-memory.sh encrypt parameters).
if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 \
  -pass "pass:$GATEWAY_TOKEN" \
  -in "$BACKUP_FILE" -out "$TAR_PATH" 2>&1; then
  echo "ERROR: decrypt failed. Wrong gateway_token, or corrupted file." >&2
  rm -f "$TAR_PATH"
  exit 2
fi

# Untar to target.
if ! tar xzf "$TAR_PATH" -C "$TARGET_DIR" 2>&1; then
  echo "ERROR: untar failed." >&2
  rm -f "$TAR_PATH"
  exit 3
fi

rm -f "$TAR_PATH"

echo "Restored to: $TARGET_DIR"
echo ""
echo "Inspect contents:"
echo "  ls -la $TARGET_DIR/workspace/"
echo "  ls -la $TARGET_DIR/sessions/"
echo ""
echo "To replace LIVE workspace (destructive — review first):"
echo "  cp -a $TARGET_DIR/workspace/. \$HOME/.openclaw/workspace/"
echo "  cp -a $TARGET_DIR/sessions/. \$HOME/.openclaw/sessions/"
