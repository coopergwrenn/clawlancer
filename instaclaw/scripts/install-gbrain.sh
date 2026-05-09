#!/usr/bin/env bash
# install-gbrain.sh — Phase 1 per-VM gbrain installer.
#
# Source of truth: instaclaw/docs/prd/PRD-gbrain-phase1-design.md §3.2
# Uploaded to a target VM via SFTP by _install-gbrain-on-vm.ts, then executed.
#
# Usage (from TS wrapper):
#   GBRAIN_PINNED_COMMIT=2ea5b71 GBRAIN_PINNED_VERSION=0.28.1 bash install-gbrain.sh
#
# Phases (each prints PHASE_X_START and PHASE_X_OK or FATAL_*):
#   A  pre-flight (backup + idempotency)
#   B  install Bun (with unzip prereq)
#   C  clone + checkout pinned commit
#   D  bun install + bun link
#   E  gbrain init --pglite
#   F  gbrain serve standalone probe
#   G  wire MCP via openclaw mcp set (hot reload — no restart)
#
# Exit codes documented in the design doc §3.3.

set +e   # don't auto-exit; we handle errors per-phase
source ~/.nvm/nvm.sh
export PATH="$HOME/.bun/bin:$PATH"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"

# Required pinned values (passed via env from TS wrapper)
: "${GBRAIN_PINNED_COMMIT:?GBRAIN_PINNED_COMMIT required}"
: "${GBRAIN_PINNED_VERSION:?GBRAIN_PINNED_VERSION required}"

TS=$(date -u +%Y%m%dT%H%M%SZ)
echo "INSTALL_START ts=$TS commit=$GBRAIN_PINNED_COMMIT version=$GBRAIN_PINNED_VERSION"

# ═════════════════════════════════════════════════════════════════════════════
# PHASE A: pre-flight (backup + idempotency)
# ═════════════════════════════════════════════════════════════════════════════
echo "PHASE_A_START"

# A1: workspace backup per Rule 22
BACKUP_DIR=$HOME/.openclaw/session-backups
mkdir -p "$BACKUP_DIR"
TARBALL="$BACKUP_DIR/$TS-pre-gbrain.tar.gz"
tar -czf "$TARBALL" -C "$HOME" \
    .openclaw/workspace \
    .openclaw/agents/main/sessions/sessions.json \
    > /dev/null 2>&1
[ ! -f "$TARBALL" ] && { echo "FATAL_NO_BACKUP"; exit 1; }
tar -tzf "$TARBALL" > /dev/null 2>&1 || { echo "FATAL_BACKUP_CORRUPT"; exit 1; }

# A2: openclaw.json backup
cp "$HOME/.openclaw/openclaw.json" "/tmp/openclaw.json.bak.$TS"

# A3: prereqs
which openclaw > /dev/null 2>&1 || { echo "FATAL_NO_OPENCLAW"; exit 2; }
OPENAI_KEY=$(grep "^OPENAI_API_KEY=" "$HOME/.openclaw/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')
KEY_LEN=$(printf "%s" "$OPENAI_KEY" | wc -c)
[ "$KEY_LEN" -lt 20 ] && { echo "FATAL_NO_OPENAI_KEY"; exit 2; }

# A4: idempotency — already correctly installed?
EXISTING_VERSION=$(gbrain --version 2>&1 | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
EXISTING_MCP=$(openclaw mcp show gbrain 2>&1 | grep -c '/home/openclaw/.bun/bin/gbrain')
if [ "$EXISTING_VERSION" = "$GBRAIN_PINNED_VERSION" ] && [ "$EXISTING_MCP" = "1" ]; then
  echo "ALREADY_INSTALLED version=$EXISTING_VERSION mcp=registered"
  exit 0
fi

echo "PHASE_A_OK backup=$TARBALL config_backup=/tmp/openclaw.json.bak.$TS"

# ═════════════════════════════════════════════════════════════════════════════
# PHASE B: install Bun (with unzip prereq)
# ═════════════════════════════════════════════════════════════════════════════
echo "PHASE_B_START"
if ! command -v bun > /dev/null 2>&1; then
  if ! command -v unzip > /dev/null 2>&1; then
    sudo apt-get install -y -qq unzip 2>&1 | tail -3
    command -v unzip > /dev/null 2>&1 || { echo "FATAL_NO_UNZIP_NO_SUDO"; exit 3; }
  fi
  curl -fsSL https://bun.sh/install | bash 2>&1 | tail -5
  export PATH="$HOME/.bun/bin:$PATH"
  command -v bun > /dev/null 2>&1 || { echo "FATAL_BUN_INSTALL_FAILED"; exit 3; }
fi
BUN_VERSION=$(bun --version)
echo "PHASE_B_OK bun=$BUN_VERSION"

# ═════════════════════════════════════════════════════════════════════════════
# PHASE C: clone + checkout pinned commit
# ═════════════════════════════════════════════════════════════════════════════
echo "PHASE_C_START"
if [ -d "$HOME/gbrain/.git" ]; then
  cd "$HOME/gbrain" || { echo "FATAL_GBRAIN_DIR_INACCESSIBLE"; exit 4; }
  git fetch origin 2>&1 | tail -3
else
  git clone https://github.com/garrytan/gbrain.git "$HOME/gbrain" 2>&1 | tail -3
  [ ! -d "$HOME/gbrain/.git" ] && { echo "FATAL_CLONE_FAILED"; exit 4; }
  cd "$HOME/gbrain"
fi
git checkout "$GBRAIN_PINNED_COMMIT" 2>&1 | tail -3
VERIFY_HEAD=$(git rev-parse --short HEAD)
[ "$VERIFY_HEAD" != "$GBRAIN_PINNED_COMMIT" ] && {
  echo "FATAL_CHECKOUT_DRIFT verify=$VERIFY_HEAD expected=$GBRAIN_PINNED_COMMIT"
  rm -rf "$HOME/gbrain"
  exit 5
}
echo "PHASE_C_OK head=$VERIFY_HEAD"

# ═════════════════════════════════════════════════════════════════════════════
# PHASE D: bun install + bun link
# ═════════════════════════════════════════════════════════════════════════════
echo "PHASE_D_START"
cd "$HOME/gbrain"
timeout 300 bun install 2>&1 | tail -5
BUN_INSTALL_RC=$?
[ "$BUN_INSTALL_RC" -ne 0 ] && {
  echo "FATAL_BUN_INSTALL_FAILED rc=$BUN_INSTALL_RC"
  rm -rf "$HOME/gbrain"
  exit 6
}
bun link 2>&1 | tail -3
command -v gbrain > /dev/null 2>&1 || {
  echo "FATAL_BUN_LINK_FAILED"
  rm -rf "$HOME/gbrain"
  exit 7
}
GBRAIN_INSTALLED_VERSION=$(gbrain --version 2>&1 | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
[ "$GBRAIN_INSTALLED_VERSION" != "$GBRAIN_PINNED_VERSION" ] && {
  echo "FATAL_VERSION_MISMATCH installed=$GBRAIN_INSTALLED_VERSION expected=$GBRAIN_PINNED_VERSION"
  rm -rf "$HOME/gbrain"
  exit 8
}
echo "PHASE_D_OK gbrain=$GBRAIN_INSTALLED_VERSION"

# ═════════════════════════════════════════════════════════════════════════════
# PHASE E: initialize PGLite
# ═════════════════════════════════════════════════════════════════════════════
echo "PHASE_E_START"
if [ ! -d "$HOME/.gbrain/brain.pglite" ]; then
  gbrain init --pglite 2>&1 | tail -10
  [ ! -d "$HOME/.gbrain/brain.pglite" ] && {
    echo "FATAL_PGLITE_INIT_FAILED"
    rm -rf "$HOME/.gbrain"
    exit 9
  }
fi
DOCTOR_HEALTH=$(gbrain doctor --json --fast 2>&1 | python3 -c "
import json, sys
try: print(json.load(sys.stdin).get('health_score', 0))
except: print(0)
")
echo "PHASE_E_OK health=$DOCTOR_HEALTH"
# Note: health < 90 is a WARN not a FATAL — Phase 0 baseline was 90 with 30+
# unrelated skill warnings. We accept anything >= 80.
[ "$DOCTOR_HEALTH" -lt 80 ] && echo "WARN_DOCTOR_BELOW_80 health=$DOCTOR_HEALTH"

# ═════════════════════════════════════════════════════════════════════════════
# PHASE F: gbrain serve standalone probe
# ═════════════════════════════════════════════════════════════════════════════
echo "PHASE_F_START"
SERVE_PROBE=$(timeout 5 gbrain serve < /dev/null 2>&1)
echo "$SERVE_PROBE" | grep -q "Starting GBrain MCP server" || {
  echo "FATAL_SERVE_PROBE_FAILED"
  echo "probe_output: $(echo "$SERVE_PROBE" | head -c 200)"
  exit 10
}
echo "PHASE_F_OK"

# ═════════════════════════════════════════════════════════════════════════════
# PHASE G: wire MCP via openclaw mcp set (hot reload — no restart)
# ═════════════════════════════════════════════════════════════════════════════
echo "PHASE_G_START"
GBRAIN_JSON_FILE="/tmp/gbrain-mcp-$TS.json"
OPENAI_KEY="$OPENAI_KEY" python3 > "$GBRAIN_JSON_FILE" <<'PYEOF'
import json, os
print(json.dumps({
    "command": "/home/openclaw/.bun/bin/gbrain",
    "args": ["serve"],
    "env": {
        "OPENAI_API_KEY": os.environ["OPENAI_KEY"],
        "GBRAIN_DATABASE_URL": "pglite:///home/openclaw/.gbrain/brain.pglite",
        "GBRAIN_EMBEDDING_MODEL": "openai:text-embedding-3-large",
        "GBRAIN_EMBEDDING_DIMENSIONS": "1024",
    },
}))
PYEOF

openclaw mcp set gbrain "$(cat "$GBRAIN_JSON_FILE")" 2>&1 | tail -3
SET_RC=$?
[ "$SET_RC" -ne 0 ] && {
  echo "FATAL_MCP_SET_FAILED rc=$SET_RC"
  exit 11
}

# Hot reload takes <1s; give it 2s for slow VMs
sleep 2

# Verify-after-set per Rule 10
SHOW=$(openclaw mcp show gbrain 2>&1)
if ! echo "$SHOW" | grep -q "/home/openclaw/.bun/bin/gbrain"; then
  echo "FATAL_VERIFY_AFTER_SET_FAILED"
  echo "show_output: $(echo "$SHOW" | head -c 200)"
  openclaw mcp unset gbrain > /dev/null 2>&1
  exit 12
fi

# Verify gateway still healthy (hot reload should not have broken it)
HEALTH=$(curl -s -m 3 -o /dev/null -w "%{http_code}" http://localhost:18789/health)
[ "$HEALTH" != "200" ] && {
  echo "FATAL_GATEWAY_UNHEALTHY_POST_HOT_RELOAD health=$HEALTH"
  openclaw mcp unset gbrain > /dev/null 2>&1
  exit 13
}

echo "PHASE_G_OK health=$HEALTH"

# ═════════════════════════════════════════════════════════════════════════════
# DONE
# ═════════════════════════════════════════════════════════════════════════════
echo "INSTALL_COMPLETE"
echo "  bun:      $(bun --version)"
echo "  gbrain:   $(gbrain --version | head -1)"
echo "  pglite:   $HOME/.gbrain/brain.pglite"
echo "  mcp:      registered"
echo "  health:   $HEALTH"
echo "  backup:   $TARBALL"
echo "  cfg_bak:  /tmp/openclaw.json.bak.$TS"
exit 0
