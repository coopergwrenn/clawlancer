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
#   A  pre-flight (backup + idempotency + read OPENAI_API_KEY and GBRAIN_ANTHROPIC_API_KEY from .env)
#   B  install Bun (with unzip prereq)
#   C  clone + checkout pinned commit
#   D  bun install + bun link
#   E  gbrain init --pglite
#   F  gbrain serve standalone probe
#   G  wire MCP via openclaw mcp set (hot reload — no restart)
#   H  put_page + query round-trip verification gate (real MCP behavior test)
#
# Co-deployed file requirement:
#   verify-gbrain-mcp.py must be uploaded by the TS wrapper alongside this
#   script, available at /tmp/verify-gbrain-mcp.py at exec time. Phase H aborts
#   if it's missing — install-gbrain.sh refuses to silently skip the gate.
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

# A3: prereqs — openclaw + API keys
which openclaw > /dev/null 2>&1 || { echo "FATAL_NO_OPENCLAW"; exit 2; }

# OpenAI key — for text-embedding-3-large (1536-dim, matches PGLite schema).
OPENAI_KEY=$(grep "^OPENAI_API_KEY=" "$HOME/.openclaw/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')
KEY_LEN=$(printf "%s" "$OPENAI_KEY" | wc -c)
[ "$KEY_LEN" -lt 20 ] && { echo "FATAL_NO_OPENAI_KEY"; exit 2; }

# Anthropic key — for gbrain expansion (Haiku) + chat (Sonnet). Per Gary's
# defaults in gbrain/src/core/ai/gateway.ts: DEFAULT_EXPANSION_MODEL =
# 'anthropic:claude-haiku-4-5-20251001', DEFAULT_CHAT_MODEL =
# 'anthropic:claude-sonnet-4-6-20250929'. Without this key, gbrain's
# gateway.ts:304 silently disables expansion (returns the original query) —
# search still works but at degraded quality.
#
# Stored under GBRAIN_ANTHROPIC_API_KEY (not ANTHROPIC_API_KEY) to avoid
# collision with OpenClaw's auth-profiles.json field of the same name, which
# is the per-VM gateway_token — NOT a real Anthropic key. We map this to
# ANTHROPIC_API_KEY in the gbrain MCP env block below.
ANTHROPIC_KEY=$(grep "^GBRAIN_ANTHROPIC_API_KEY=" "$HOME/.openclaw/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')
A_KEY_LEN=$(printf "%s" "$ANTHROPIC_KEY" | wc -c)
[ "$A_KEY_LEN" -lt 20 ] && { echo "FATAL_NO_ANTHROPIC_KEY"; exit 2; }

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
# Three intentional choices in this env block:
#
#   1. NO GBRAIN_EMBEDDING_DIMENSIONS. gbrain's PGLite schema hardcodes
#      `vector(1536)` in `gbrain/src/schema.sql`. Setting this env var to
#      anything OTHER than 1536 causes every `put_page` to fail with
#      "expected 1536 dimensions, not N" (the vm-050 bug, 2026-05-11).
#      Default (1536) matches schema. Omit the override entirely.
#
#   2. ANTHROPIC_API_KEY sourced from GBRAIN_ANTHROPIC_API_KEY on disk so
#      gbrain (which uses @anthropic-ai/sdk) sees a real Anthropic key. This
#      key is dedicated to gbrain — separate from the gateway proxy auth
#      flow OpenClaw uses for the agent's main chat completions.
#
#   3. GBRAIN_ANTHROPIC_MAX_INFLIGHT=3 caps concurrency to bound traffic
#      spikes during heavy graph ingestion. gbrain self-throttles at this
#      ceiling — protects both us and Anthropic from runaway parallelism.
GBRAIN_JSON_FILE="/tmp/gbrain-mcp-$TS.json"
OPENAI_KEY="$OPENAI_KEY" ANTHROPIC_KEY="$ANTHROPIC_KEY" python3 > "$GBRAIN_JSON_FILE" <<'PYEOF'
import json, os
print(json.dumps({
    "command": "/home/openclaw/.bun/bin/gbrain",
    "args": ["serve"],
    "env": {
        "OPENAI_API_KEY": os.environ["OPENAI_KEY"],
        "ANTHROPIC_API_KEY": os.environ["ANTHROPIC_KEY"],
        "GBRAIN_DATABASE_URL": "pglite:///home/openclaw/.gbrain/brain.pglite",
        "GBRAIN_EMBEDDING_MODEL": "openai:text-embedding-3-large",
        "GBRAIN_ANTHROPIC_MAX_INFLIGHT": "3",
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
# PHASE H: put_page + query round-trip verification gate
# ═════════════════════════════════════════════════════════════════════════════
# Phase F was just a "does the process start" probe. That catches "binary
# missing" but NOT the runtime issues that actually shipped to production:
#
#   - GBRAIN_EMBEDDING_DIMENSIONS / schema dim mismatch (vm-050, 2026-05-11)
#   - Missing OPENAI_API_KEY (embedding fails at put_page time)
#   - PGLite write failure (disk full, permission, schema migration stalled)
#   - MCP tool registration broken
#
# Phase H drives a real JSON-RPC put_page → query round-trip via gbrain's
# canonical verification harness (verify-gbrain-mcp.py). It fails the install
# if either tool errors or the put page isn't found by the subsequent query.
#
# Canonical source: instaclaw/scripts/verify-gbrain-mcp.py — uploaded by the
# TS wrapper to /tmp/verify-gbrain-mcp.py. Read-only at this point in the
# install. We copy to a TS-suffixed path so we don't fight other concurrent
# installs (unlikely on a single VM but cheap defense).
echo "PHASE_H_START"
VERIFY_PY_SRC=""
for candidate in "/tmp/verify-gbrain-mcp.py" "$(dirname "${BASH_SOURCE[0]}")/verify-gbrain-mcp.py"; do
  if [ -s "$candidate" ]; then VERIFY_PY_SRC="$candidate"; break; fi
done
if [ -z "$VERIFY_PY_SRC" ]; then
  echo "FATAL_VERIFY_PY_MISSING expected_at=/tmp/verify-gbrain-mcp.py"
  echo "hint: ensure _install-gbrain-on-vm.ts SFTPs verify-gbrain-mcp.py alongside install-gbrain.sh"
  openclaw mcp unset gbrain > /dev/null 2>&1
  exit 14
fi
VERIFY_PY="/tmp/verify-gbrain-mcp-$TS.py"
cp "$VERIFY_PY_SRC" "$VERIFY_PY"
chmod +x "$VERIFY_PY"

VERIFY_OUT=$(MARKER_TS="$TS" \
  OPENAI_API_KEY="$OPENAI_KEY" \
  ANTHROPIC_API_KEY="$ANTHROPIC_KEY" \
  GBRAIN_DATABASE_URL="pglite://$HOME/.gbrain/brain.pglite" \
  GBRAIN_EMBEDDING_MODEL="openai:text-embedding-3-large" \
  timeout 180 python3 "$VERIFY_PY" 2>&1)
VERIFY_RC=$?
# Tail the verify output for forensic visibility (capped — full output may be
# verbose if put_page is slow + retries chatter happens)
echo "$VERIFY_OUT" | tail -12

if [ "$VERIFY_RC" -ne 0 ]; then
  echo "FATAL_VERIFY_GATE_FAILED rc=$VERIFY_RC"
  openclaw mcp unset gbrain > /dev/null 2>&1
  exit 14
fi

# Final RESULT_OK / RESULT_FAIL line — leading whitespace tolerated (the
# helper writes it indented in some contexts)
RESULT_LINE=$(echo "$VERIFY_OUT" | grep -oE 'RESULT_(OK|FAIL)[^\n]*' | head -1)
if [ -z "$RESULT_LINE" ] || ! echo "$RESULT_LINE" | grep -q "^RESULT_OK"; then
  echo "FATAL_VERIFY_NO_RESULT_OK line='$RESULT_LINE'"
  openclaw mcp unset gbrain > /dev/null 2>&1
  exit 14
fi
echo "PHASE_H_OK $RESULT_LINE"

# ═════════════════════════════════════════════════════════════════════════════
# DONE
# ═════════════════════════════════════════════════════════════════════════════
echo "INSTALL_COMPLETE"
echo "  bun:      $(bun --version)"
echo "  gbrain:   $(gbrain --version | head -1)"
echo "  pglite:   $HOME/.gbrain/brain.pglite"
echo "  mcp:      registered (anthropic-wired)"
echo "  health:   $HEALTH"
echo "  verify:   $RESULT_LINE"
echo "  backup:   $TARBALL"
echo "  cfg_bak:  /tmp/openclaw.json.bak.$TS"
exit 0
