#!/usr/bin/env bash
# uninstall-gbrain.sh — Phase 1 per-VM gbrain remover.
#
# Mirror of install-gbrain.sh. Designed for rollback if Phase 1 reveals
# issues we want to walk back from. Per CLAUDE.md Rule 22 ("trim, don't
# nuke"), defaults to SAFE mode — only removes the MCP entry. Use
# --purge to also delete ~/gbrain, ~/.gbrain, ~/brain.
#
# Usage (from TS wrapper):
#   bash uninstall-gbrain.sh           # safe — removes MCP entry only
#   bash uninstall-gbrain.sh --purge   # also deletes gbrain repo + PGLite
#
# Phases:
#   A  pre-flight (capture state + sanity)
#   B  openclaw mcp unset gbrain (hot reload, no restart)
#   C  verify removal + gateway still healthy
#   D  (--purge only) delete ~/gbrain ~/.gbrain ~/brain
#
# Exit codes:
#   0  success (or already-absent — idempotent)
#   1  openclaw CLI missing
#   2  mcp unset failed
#   3  verify failed (gbrain still showing in mcp list)
#   4  gateway unhealthy post hot-reload
#   5  --purge: failed to delete a directory

set +e
source ~/.nvm/nvm.sh
export PATH="$HOME/.bun/bin:$PATH"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"

PURGE=0
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    *) echo "WARN_UNKNOWN_ARG arg=$arg" ;;
  esac
done

TS=$(date -u +%Y%m%dT%H%M%SZ)
echo "UNINSTALL_START ts=$TS purge=$PURGE"

# ═════════════════════════════════════════════════════════════════════════════
# PHASE A: pre-flight
# ═════════════════════════════════════════════════════════════════════════════
echo "PHASE_A_START"
which openclaw > /dev/null 2>&1 || { echo "FATAL_NO_OPENCLAW"; exit 1; }

# Capture pre-state for the audit log
PRE_MCP_PRESENT=$(openclaw mcp show gbrain 2>&1 | grep -c '/home/openclaw/.bun/bin/gbrain')
PRE_HEALTH=$(curl -s -m 3 -o /dev/null -w "%{http_code}" http://localhost:18789/health 2>/dev/null || echo "no-response")
PRE_GBRAIN_INSTALLED=$(test -d "$HOME/.gbrain" && echo PRESENT || echo MISSING)
PRE_GBRAIN_REPO=$(test -d "$HOME/gbrain" && echo PRESENT || echo MISSING)
echo "PHASE_A_OK pre_mcp=$PRE_MCP_PRESENT pre_health=$PRE_HEALTH pre_data=$PRE_GBRAIN_INSTALLED pre_repo=$PRE_GBRAIN_REPO"

# Idempotency: if MCP entry is already absent, exit clean (unless --purge
# wants to also clean up the filesystem)
if [ "$PRE_MCP_PRESENT" = "0" ] && [ "$PURGE" = "0" ]; then
  echo "ALREADY_REMOVED (no mcp entry, no purge requested)"
  exit 0
fi

# Backup openclaw.json before mcp unset (in case we need to restore)
cp "$HOME/.openclaw/openclaw.json" "/tmp/openclaw.json.bak.uninstall.$TS"

# ═════════════════════════════════════════════════════════════════════════════
# PHASE B: openclaw mcp unset gbrain (hot reload — no restart)
# ═════════════════════════════════════════════════════════════════════════════
echo "PHASE_B_START"
if [ "$PRE_MCP_PRESENT" -gt "0" ]; then
  openclaw mcp unset gbrain 2>&1 | tail -3
  UNSET_RC=$?
  [ "$UNSET_RC" -ne 0 ] && {
    echo "FATAL_MCP_UNSET_FAILED rc=$UNSET_RC"
    exit 2
  }
  echo "PHASE_B_OK"
else
  echo "PHASE_B_SKIP (mcp entry already absent)"
fi

# ═════════════════════════════════════════════════════════════════════════════
# PHASE C: verify removal + gateway health (Rule 10)
# ═════════════════════════════════════════════════════════════════════════════
echo "PHASE_C_START"
# Allow hot reload to settle
sleep 2

POST_MCP_PRESENT=$(openclaw mcp show gbrain 2>&1 | grep -c '/home/openclaw/.bun/bin/gbrain')
if [ "$POST_MCP_PRESENT" != "0" ]; then
  echo "FATAL_MCP_STILL_PRESENT post=$POST_MCP_PRESENT"
  exit 3
fi

POST_HEALTH=$(curl -s -m 3 -o /dev/null -w "%{http_code}" http://localhost:18789/health 2>/dev/null || echo "no-response")
[ "$POST_HEALTH" != "200" ] && {
  echo "FATAL_GATEWAY_UNHEALTHY post_health=$POST_HEALTH"
  # Restore openclaw.json from pre-uninstall backup
  cp "/tmp/openclaw.json.bak.uninstall.$TS" "$HOME/.openclaw/openclaw.json"
  echo "ROLLBACK_RESTORE_DONE — try systemctl --user reload openclaw-gateway manually"
  exit 4
}
echo "PHASE_C_OK post_health=$POST_HEALTH"

# ═════════════════════════════════════════════════════════════════════════════
# PHASE D: --purge filesystem cleanup (OPTIONAL)
# ═════════════════════════════════════════════════════════════════════════════
if [ "$PURGE" = "1" ]; then
  echo "PHASE_D_START purge=1"
  # Pre-backup PGLite (Rule 22 — even on uninstall, keep data recoverable)
  if [ -d "$HOME/.gbrain" ]; then
    mkdir -p "$HOME/.openclaw/session-backups"
    tar -czf "$HOME/.openclaw/session-backups/$TS-gbrain-data.tar.gz" -C "$HOME" .gbrain 2>&1 | tail -3
    echo "data_backup=$HOME/.openclaw/session-backups/$TS-gbrain-data.tar.gz ($(du -h $HOME/.openclaw/session-backups/$TS-gbrain-data.tar.gz | cut -f1))"
  fi

  for d in "$HOME/.gbrain" "$HOME/gbrain" "$HOME/brain"; do
    if [ -d "$d" ]; then
      rm -rf "$d"
      if [ -d "$d" ]; then
        echo "FATAL_PURGE_FAILED dir=$d"
        exit 5
      fi
      echo "purged: $d"
    else
      echo "skip: $d (absent)"
    fi
  done
  echo "PHASE_D_OK"
fi

# ═════════════════════════════════════════════════════════════════════════════
# DONE
# ═════════════════════════════════════════════════════════════════════════════
echo "UNINSTALL_COMPLETE"
echo "  mcp_removed:     yes"
echo "  health:          $POST_HEALTH"
echo "  purged:          $PURGE"
echo "  config_backup:   /tmp/openclaw.json.bak.uninstall.$TS"
if [ "$PURGE" = "1" ]; then
  echo "  data_backup:     $HOME/.openclaw/session-backups/$TS-gbrain-data.tar.gz"
fi
exit 0
