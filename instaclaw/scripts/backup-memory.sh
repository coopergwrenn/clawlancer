#!/bin/bash
#
# backup-memory.sh — Per-VM encrypted memory backup. v0.
#
# Step 7 of the matching-engine-competitive-research §5.2 sequence.
# Tars the agent's workspace + sessions, encrypts with AES-256-CBC +
# PBKDF2 keyed on the VM's GATEWAY_TOKEN, retains a rolling 24-hour
# window of encrypted snapshots in ~/.openclaw/backups/.
#
# Trust narrative status (per the Edge strategy doc Bet #3):
#   v0 (this script): encryption-at-rest. The key is derived from
#     GATEWAY_TOKEN which InstaClaw issued, so a sufficiently-motivated
#     operator could decrypt. Honest framing: "your memory is encrypted
#     locally; if the VM dies your local backups die with it."
#   v1 (next PR): S3 upload via per-call presigned URLs. Survives VM
#     loss but key remains InstaClaw-derivable.
#   v2 (post-Edge): user-owned age keypair. Private key emailed at
#     provisioning; InstaClaw retains only the public key. Even
#     InstaClaw cannot decrypt v2 backups.
#
# Idempotent. Safe to re-run. Errors logged to ~/.openclaw/backup.log
# and exit code 1; cron-installation should use a tolerant wrapper
# so a single failure doesn't disable the cron entirely.
#
# Recommended cron entry (per-VM, installed via vm-manifest):
#   0 * * * * bash ~/.openclaw/scripts/backup-memory.sh >/dev/null 2>&1
#
# Restore: scripts/_restore-memory.sh (decrypt + untar)

set -euo pipefail

BACKUP_DIR="$HOME/.openclaw/backups"
LOG_FILE="$HOME/.openclaw/backup.log"
TIMESTAMP=$(date -u +%Y-%m-%dT%H-%M-%SZ)
TAR_PATH="$BACKUP_DIR/${TIMESTAMP}.tar.gz"
ENC_PATH="$BACKUP_DIR/${TIMESTAMP}.tar.gz.enc"

mkdir -p "$BACKUP_DIR"

log() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $1" >> "$LOG_FILE"
}

cleanup_on_error() {
  rm -f "$TAR_PATH" "$ENC_PATH"
}
trap cleanup_on_error ERR

# ── Source the encryption key ─────────────────────────────────────────
# GATEWAY_TOKEN is written to ~/.openclaw/.env by configureOpenClaw at
# VM provision. It's our v0 key material. v2 will switch to a user-
# owned age keypair (see header).
if [ ! -f "$HOME/.openclaw/.env" ]; then
  log "ERROR ~/.openclaw/.env not found"
  exit 1
fi

GATEWAY_TOKEN=$(grep '^GATEWAY_TOKEN=' "$HOME/.openclaw/.env" \
  | head -n 1 \
  | cut -d= -f2- \
  | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")

if [ -z "${GATEWAY_TOKEN:-}" ]; then
  log "ERROR GATEWAY_TOKEN missing from .env"
  exit 1
fi

# ── Tar workspace + sessions ──────────────────────────────────────────
# Includes:
#   ~/.openclaw/workspace/   — SOUL.md, MEMORY.md, CAPABILITIES.md, EARN.md,
#                              memory/, etc. The agent's persistent state.
#   ~/.openclaw/sessions/    — Conversation jsonls.
# Excludes:
#   ~/.openclaw/.env          — never archive secrets
#   ~/.openclaw/agents/       — auth-profiles.json is operator-restricted
#   *.tmp, *.pid, *.lock      — transient files; can race the backup
#   sessions.json.tmp         — strip-thinking.py's atomic-rename intermediate
if ! tar czf "$TAR_PATH" \
  --exclude='*.tmp' \
  --exclude='*.pid' \
  --exclude='*.lock' \
  -C "$HOME/.openclaw" \
  workspace sessions 2>>"$LOG_FILE"; then
  log "ERROR tar failed"
  exit 1
fi

TAR_SIZE=$(wc -c < "$TAR_PATH" 2>/dev/null || echo 0)

# ── Encrypt with AES-256-CBC + PBKDF2 ─────────────────────────────────
# openssl enc with -pbkdf2 derives the key from a passphrase via
# PBKDF2-SHA256 with random salt. The salt is embedded in the output
# (alongside the magic bytes). 100K iterations is the modern default
# for password-derived AES keys.
#
# Why CBC not GCM: openssl's CLI doesn't expose GCM cleanly (it requires
# manual IV + tag management). CBC + PBKDF2 is the conventional
# command-line pattern. We accept the unauthenticated-encryption tradeoff
# in v0; if a backup is corrupted, decrypt fails noisily. For v1 we
# move to a SDK-based encrypt path that supports GCM properly.
if ! openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -salt \
  -pass "pass:$GATEWAY_TOKEN" \
  -in "$TAR_PATH" -out "$ENC_PATH" 2>>"$LOG_FILE"; then
  log "ERROR encrypt failed"
  rm -f "$TAR_PATH"
  exit 1
fi

# Remove unencrypted intermediate.
rm -f "$TAR_PATH"

ENC_SIZE=$(wc -c < "$ENC_PATH" 2>/dev/null || echo 0)

# ── Rolling retention: keep last 24h of encrypted snapshots ──────────
# Hourly cron + 24-hour window = ~24 files. Each file is small (workspace
# is typically <5 MB compressed even after weeks of use), so disk usage
# stays bounded at ~120 MB worst case.
#
# `-mmin +1440` = older than 1440 minutes (24h). Always delete encrypted
# only (.enc); the unencrypted intermediate was already removed above.
find "$BACKUP_DIR" -name '*.tar.gz.enc' -type f -mmin +1440 -delete 2>>"$LOG_FILE" || true

# Count remaining backups for visibility.
BACKUP_COUNT=$(find "$BACKUP_DIR" -name '*.tar.gz.enc' -type f 2>/dev/null | wc -l | tr -d ' ')

log "OK $ENC_PATH tar=${TAR_SIZE}B enc=${ENC_SIZE}B retained=${BACKUP_COUNT}"
