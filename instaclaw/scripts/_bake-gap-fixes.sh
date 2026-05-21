#!/usr/bin/env bash
# _bake-gap-fixes.sh — bake-day patches for gaps surfaced by _postbake-validation.ts
#
# Runs on the BAKE VM *after* reconcile-to-v112 completes AND *before*
# _prebake-cleanup.sh wipes per-user state. Closes 9 genuine gaps that
# survive cleanup. Idempotent — safe to re-run.
#
# Discovery: ran _postbake-validation.ts --mode=bake against a cv=112
# pool VM (vm-626) on 2026-05-21 and found 24 P0 + 15 P1 fails. After
# subtracting per-user contamination (handled by _prebake-cleanup.sh)
# and stale validator expectations, 9 genuine bake gaps remained.
#
# Cross-reference vs the 22 §17b items Snapshot is adding to the bake
# recipe (see docs/cloud-init-snapshot-bake-requirements-2026-05-13.md
# §17b.2): ZERO OVERLAP. Snapshot covers missing scripts (skill-integrity,
# privacy-bridge, browser-relay-server, check-skill-updates), 3 skills
# (frontier, agent-status, clawlancer), 6 pip packages, 3 npm globals,
# 3 systemd unit files (xvfb, x11vnc, websockify). This script covers
# the post-2026-05-13 work that didn't make the original requirements
# doc: stepExecStartAlignment dispatch-server-side, bun install, gbrain
# MCP verification, PGLite Rule 54 trio (cron + script + ExecStop hook),
# imagemagick, nodejs apt-mark hold (vm-748 defense), and the gateway
# PATH drop-in for bun.
#
# Items #4 (agents.defaults.timeoutSeconds) and #11 (consensus_match_pipeline
# cron) from the original fail list were stale validator expectations and
# are corrected in the validator itself (same commit), NOT here.
#
# Usage
#   On the bake VM as the openclaw user, after reconcile completes:
#     bash _bake-gap-fixes.sh                # apply all fixes
#     bash _bake-gap-fixes.sh --dry-run      # preview without writing
#
# Exit codes
#   0  all fixes applied (idempotent re-runs land here)
#   4  one or more fixes failed verification (review WARN lines)
#   1  argument or pre-flight failure

set -uo pipefail
# Do NOT set -e — each fix must run independently. We aggregate errors.

# ─── flags ──────────────────────────────────────────────────────────────────
DRY_RUN=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    -h|--help) sed -n '2,/^$/p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "FATAL: unknown arg $1" >&2; exit 1 ;;
  esac
  shift
done

ERRORS=0
TS() { date -u +'%H:%M:%S'; }
hdr() { echo; echo "═══ [$(TS)] $* ═══"; }
ok() { echo "  ✓ $*"; }
info() { echo "  • $*"; }
warn() { echo "  ⚠ $*" >&2; ERRORS=$((ERRORS+1)); }

# Run-or-dry helper
do_run() {
  if $DRY_RUN; then
    echo "  [DRY] $*"
  else
    eval "$@"
  fi
}

# ─── pre-flight ─────────────────────────────────────────────────────────────
hdr "Pre-flight"
if [ "$(whoami)" != "openclaw" ]; then
  echo "FATAL: must run as the openclaw user (got: $(whoami))" >&2
  exit 1
fi

# Bake-mode marker is set by the runbook's §0.5 / §4.1 steps. Warn-only
# (don't block) — the operator may have removed it before running this.
[ -f "$HOME/.snapshot-bake-mode" ] || info "~/.snapshot-bake-mode marker absent (continuing anyway)"

# Need sudo for items 7 (apt install imagemagick) + 8 (apt-mark hold nodejs +
# rm /etc/apt/sources.list.d/nodesource.{sources,list}). Cache it now.
# Fixes 1-6 + 9 are user-scoped (~/.config/systemd/user, ~/.openclaw/scripts,
# crontab, ~/.bun) and don't need sudo.
if ! sudo -n true 2>/dev/null; then
  echo "  WARN: cached sudo missing — items 7 + 8 will fail." >&2
  echo "        Run \`sudo -v\` before re-running this script." >&2
fi

CUR_NODE=$(node --version 2>/dev/null || echo "")
info "current node: ${CUR_NODE:-<missing>}"
info "current bun:  $([ -x "$HOME/.bun/bin/bun" ] && "$HOME"/.bun/bin/bun --version 2>/dev/null || echo "<not installed>")"

# ═══════════════════════════════════════════════════════════════════════════
# Fix 1/9 — dispatch-server.service Node-path alignment
# ═══════════════════════════════════════════════════════════════════════════
# Validator complained: "unit=v18.19.1 current=v22.22.2". The reconciler's
# stepExecStartAlignment handles the openclaw-gateway.service unit but not
# the dispatch-server.service unit. Rewrite the ExecStart line to point at
# the currently-installed Node binary. Idempotent: only rewrites if the
# current Node binary path is NOT already in the ExecStart line.
hdr "1/9 — dispatch-server.service Node-path alignment"
DSP_UNIT="$HOME/.config/systemd/user/dispatch-server.service"
if [ -z "$CUR_NODE" ]; then
  warn "no current node — skipping (install Node first)"
elif [ ! -f "$DSP_UNIT" ]; then
  info "dispatch-server.service unit absent — skip (will be deployed by configureOpenClaw or §17b path)"
else
  CUR_NODE_BIN="/home/openclaw/.nvm/versions/node/$CUR_NODE/bin/node"
  CURRENT_LINE=$(grep -E '^ExecStart=' "$DSP_UNIT" | head -1 || echo "")
  if [ -z "$CURRENT_LINE" ]; then
    warn "no ExecStart line in $DSP_UNIT — unit looks malformed"
  elif printf '%s' "$CURRENT_LINE" | grep -qF "$CUR_NODE_BIN"; then
    ok "ExecStart already uses $CUR_NODE_BIN"
  else
    OLD_VER=$(printf '%s' "$CURRENT_LINE" | sed -nE 's|.*/node/(v[0-9.]+)/.*|\1|p')
    [ -z "$OLD_VER" ] && OLD_VER="UNKNOWN"
    info "drift detected: $OLD_VER → $CUR_NODE"
    if [ ! -x "$CUR_NODE_BIN" ]; then
      warn "target $CUR_NODE_BIN not executable — skip (Node install incomplete)"
    elif $DRY_RUN; then
      echo "  [DRY] would rewrite ExecStart in $DSP_UNIT to use $CUR_NODE_BIN"
    else
      NEW_LINE="ExecStart=$CUR_NODE_BIN /home/openclaw/scripts/dispatch-server.js"
      BACKUP="$DSP_UNIT.bak.bake-gap-fix-$(date -u +%Y%m%dT%H%M%SZ)"
      cp "$DSP_UNIT" "$BACKUP"
      # Anchored on ".../node ... dispatch-server.js" so we don't accidentally
      # match other ExecStart= lines if the unit grows in the future.
      sed -i -E "s|^ExecStart=.*/node/v[0-9.]+/bin/node .*dispatch-server\.js.*|$NEW_LINE|" "$DSP_UNIT"
      POST=$(grep -E '^ExecStart=' "$DSP_UNIT" | head -1)
      if [ "$POST" = "$NEW_LINE" ]; then
        ok "rewrote ExecStart → $CUR_NODE (backup: $BACKUP)"
        systemctl --user daemon-reload 2>/dev/null || true
      else
        cp "$BACKUP" "$DSP_UNIT"
        warn "rewrite verify FAILED — restored backup. got=$POST"
      fi
    fi
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# Fix 2/9 — bun install
# ═══════════════════════════════════════════════════════════════════════════
# bun is required by gbrain (#!/usr/bin/env bun shebang in its CLI). The
# validator complained: bash: line 1: /home/openclaw/.bun/bin/bun: No such
# file or directory. Idempotent: skip if already installed.
hdr "2/9 — bun install"
if [ -x "$HOME/.bun/bin/bun" ]; then
  BUN_VER=$("$HOME"/.bun/bin/bun --version 2>/dev/null || echo "?")
  ok "bun already installed (version $BUN_VER)"
else
  if $DRY_RUN; then
    echo "  [DRY] curl -fsSL https://bun.sh/install | bash"
  else
    info "installing bun via official installer..."
    curl -fsSL https://bun.sh/install | bash 2>&1 | tail -5
    if [ -x "$HOME/.bun/bin/bun" ]; then
      BUN_VER=$("$HOME"/.bun/bin/bun --version 2>/dev/null || echo "?")
      ok "bun installed (version $BUN_VER)"
    else
      warn "bun install failed — $HOME/.bun/bin/bun still missing"
    fi
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# Fix 3/9 — gbrain MCP entry verification (flag-only, no auto-fix)
# ═══════════════════════════════════════════════════════════════════════════
# Per Cooper's directive: verify the MCP entry is wired in openclaw.json.
# If absent, flag — don't auto-fix. install-gbrain.sh Phase H is the
# canonical writer (uses `openclaw config set mcp.servers.gbrain.*`).
# This script should NOT replicate that path; it should surface the gap
# so the bake operator runs install-gbrain.sh.
hdr "3/9 — gbrain MCP entry (verify-only, flag if absent)"
OPENCLAW_JSON="$HOME/.openclaw/openclaw.json"
if [ ! -f "$OPENCLAW_JSON" ]; then
  info "openclaw.json absent (cleanup may have wiped it — Phase H runs post-cleanup if needed)"
elif ! command -v jq >/dev/null 2>&1; then
  warn "jq missing — cannot verify mcp.servers.gbrain"
else
  GBR_TRANSPORT=$(jq -r '.mcp.servers.gbrain.transport // ""' "$OPENCLAW_JSON" 2>/dev/null)
  GBR_URL=$(jq -r '.mcp.servers.gbrain.url // ""' "$OPENCLAW_JSON" 2>/dev/null)
  if [ "$GBR_TRANSPORT" = "streamable-http" ] && [ -n "$GBR_URL" ]; then
    ok "mcp.servers.gbrain wired (transport=$GBR_TRANSPORT url=$GBR_URL)"
  elif [ -z "$GBR_TRANSPORT" ]; then
    warn "mcp.servers.gbrain MISSING — install-gbrain.sh Phase H has not run on this VM."
    info "Action: run \`bash scripts/install-gbrain.sh\` on the bake VM before imaging."
  else
    warn "mcp.servers.gbrain.transport unexpected: '$GBR_TRANSPORT' (expected 'streamable-http')"
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# Fix 4/9 — pglite-checkpoint.sh deployment (Rule 54)
# ═══════════════════════════════════════════════════════════════════════════
# Canonical source: instaclaw/scripts/pglite-checkpoint.sh
# Canonical SHA256: 75e1a3c33261e96332e9de429afafd8c6c0351ecd700fd06350c4d7f90de2cd4
# (compare on disk; only rewrite if absent or sha differs).
#
# The script is also embedded into install-gbrain.sh Phase I and gets
# deployed there. This block provides an independent path so the bake
# VM has it even if install-gbrain.sh failed Phase I or wasn't run.
hdr "4/9 — pglite-checkpoint.sh deployment (Rule 54)"
PCS_DEST="$HOME/.openclaw/scripts/pglite-checkpoint.sh"
PCS_EXPECTED_SHA="75e1a3c33261e96332e9de429afafd8c6c0351ecd700fd06350c4d7f90de2cd4"
mkdir -p "$HOME/.openclaw/scripts" "$HOME/.openclaw/logs"

# Write candidate to a tmp path, sha256-compare to disk, atomic replace
PCS_TMP="$PCS_DEST.tmp.bake-gap-fix"
# IMPORTANT: single-quoted heredoc — $VAR stays literal so the destination
# file expands them at runtime (not at heredoc-write time).
cat > "$PCS_TMP" <<'PCSEOF'
#!/bin/bash
# pglite-checkpoint.sh — force PGLite CHECKPOINT via gbrain MCP admin tool.
#
# Runs:
#   1. Every 30 min via crontab (keeps pg_control fresh, bounds SIGKILL-safety window).
#   2. As gbrain.service ExecStop hook (graceful checkpoint before SIGKILL).
#
# See CLAUDE.md Rule 54 + instaclaw/scripts/gbrain-patches/0001-add-checkpoint-mcp-tool.patch.
#
# Exit 0 always — no cron-failure-spam. Outcomes logged structurally to
# ~/.openclaw/logs/pglite-checkpoint.log for forensic visibility.
set +e

# CRITICAL: export DBUS env so `systemctl --user` works in cron context.
# Without XDG_RUNTIME_DIR set, systemctl --user fails with "Failed to connect to bus".
# We hit this on the 2026-05-18 initial deployment — cron skipped every tick for 24h.
export XDG_RUNTIME_DIR="/run/user/$(id -u)"

PORT=3131
LOG_FILE="$HOME/.openclaw/logs/pglite-checkpoint.log"
mkdir -p "$HOME/.openclaw/logs"

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG_FILE"
}

BEARER=$(cat "$HOME/.gbrain/openclaw-bearer-token.txt" 2>/dev/null)
if [ -z "$BEARER" ]; then
  exit 0  # gbrain not installed; silent skip
fi

# Accept both "active" (cron tick during normal operation) AND "deactivating"
# (systemd is stopping the service, ExecStop hook mid-execution — process is
# still alive enough to handle the MCP HTTP call).
#
# Other states ("inactive", "failed", "activating") = MCP endpoint unreachable
# or about to be — skip silently and exit 0.
STATE=$(systemctl --user is-active gbrain.service 2>&1)
case "$STATE" in
  active|deactivating) ;;
  *)
    log "skip: state=$STATE"
    exit 0
    ;;
esac

RESP=$(curl -sS -X POST "http://127.0.0.1:$PORT/mcp" \
  -H "Authorization: Bearer $BEARER" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json,text/event-stream" \
  --max-time 60 \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"checkpoint","arguments":{}}}' 2>&1)

# Success detection: response must contain `\"ok\": true` (escaped inside SSE)
# AND must NOT contain `"isError":true` (gbrain's MCP error marker).
if echo "$RESP" | grep -qF '\"ok\": true' && ! echo "$RESP" | grep -qF '"isError":true'; then
  LATENCY=$(echo "$RESP" | grep -oE '\\"latency_ms\\":\s*[0-9]+' | head -1 | grep -oE '[0-9]+')
  log "ok latency_ms=${LATENCY:-?} state=$STATE"
else
  TRUNC=$(echo "$RESP" | head -c 200 | tr '\n' ' ')
  log "FAILED state=$STATE: $TRUNC"
fi

# Health probe: pg_control mtime check.
PG_CONTROL="$HOME/.gbrain/brain.pglite/global/pg_control"
if [ -f "$PG_CONTROL" ]; then
  MTIME=$(stat -c %Y "$PG_CONTROL")
  AGE_MIN=$(( ($(date +%s) - MTIME) / 60 ))
  if [ "$AGE_MIN" -gt 60 ]; then
    log "WARN: pg_control age=${AGE_MIN}min — exceeds 60min threshold"
  fi
fi

# Rotate log if >1MB
if [ -f "$LOG_FILE" ] && [ "$(stat -c %s "$LOG_FILE")" -gt 1048576 ]; then
  mv "$LOG_FILE" "$LOG_FILE.old"
  log "rotated"
fi

exit 0
PCSEOF

TMP_SHA=$(sha256sum "$PCS_TMP" | awk '{print $1}')
if [ "$TMP_SHA" != "$PCS_EXPECTED_SHA" ]; then
  warn "embedded pglite-checkpoint.sh SHA mismatch — got $TMP_SHA expected $PCS_EXPECTED_SHA"
  warn "          the bake script's embedded copy is stale; regenerate from scripts/pglite-checkpoint.sh"
  rm -f "$PCS_TMP"
elif [ -f "$PCS_DEST" ] && [ "$(sha256sum "$PCS_DEST" | awk '{print $1}')" = "$PCS_EXPECTED_SHA" ]; then
  ok "pglite-checkpoint.sh already at canonical SHA — no rewrite needed"
  rm -f "$PCS_TMP"
else
  if $DRY_RUN; then
    echo "  [DRY] would mv $PCS_TMP → $PCS_DEST + chmod +x"
    rm -f "$PCS_TMP"
  else
    mv "$PCS_TMP" "$PCS_DEST"
    chmod +x "$PCS_DEST"
    POST_SHA=$(sha256sum "$PCS_DEST" | awk '{print $1}')
    if [ "$POST_SHA" = "$PCS_EXPECTED_SHA" ] && [ -x "$PCS_DEST" ]; then
      ok "deployed $PCS_DEST (sha=$POST_SHA, executable)"
    else
      warn "post-write verify failed: sha=$POST_SHA exec=$([ -x "$PCS_DEST" ] && echo yes || echo no)"
    fi
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# Fix 5/9 — PGLite CHECKPOINT crontab entry (Rule 54)
# ═══════════════════════════════════════════════════════════════════════════
# Every 30 min: bound pg_control staleness. Marker grep is the idempotency
# gate. The cron's marker is the substring "pglite-checkpoint.sh".
hdr "5/9 — PGLite CHECKPOINT crontab entry (every 30 min)"
CRON_LINE="*/30 * * * * bash \$HOME/.openclaw/scripts/pglite-checkpoint.sh"
if crontab -l 2>/dev/null | grep -q "pglite-checkpoint.sh"; then
  ok "crontab already has pglite-checkpoint entry"
else
  if $DRY_RUN; then
    echo "  [DRY] would add: $CRON_LINE"
  else
    (crontab -l 2>/dev/null; echo "$CRON_LINE") | crontab -
    if crontab -l 2>/dev/null | grep -q "pglite-checkpoint.sh"; then
      ok "crontab entry added"
    else
      warn "crontab add verify failed"
    fi
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# Fix 6/9 — gbrain.service ExecStop hook (Rule 54)
# ═══════════════════════════════════════════════════════════════════════════
# systemd drop-in that fires the CHECKPOINT script BEFORE SIGKILL on any
# controlled stop. Pairs with the 10-killsignal.conf drop-in that sets
# KillSignal=SIGKILL. Canonical content lifted from install-gbrain.sh:1657.
hdr "6/9 — gbrain.service ExecStop drop-in (Rule 54)"
DROPIN_DIR="$HOME/.config/systemd/user/gbrain.service.d"
DROPIN_PATH="$DROPIN_DIR/20-execstop-checkpoint.conf"
mkdir -p "$DROPIN_DIR"

# Heredoc — $HOME expands at write time so the drop-in has the absolute path.
DROPIN_NEW=$(cat <<EOF
# Rule 54 / Rule 58 — force CHECKPOINT before SIGKILL fires on controlled stop.
# Runs BEFORE KillSignal=SIGKILL (set by 10-killsignal.conf).
# TimeoutStopSec=30 leaves ample budget: CHECKPOINT <1s + HTTP RTT + 25s buffer.
[Service]
ExecStop=$HOME/.openclaw/scripts/pglite-checkpoint.sh
TimeoutStopSec=30
EOF
)

if [ -f "$DROPIN_PATH" ] && [ "$(cat "$DROPIN_PATH")" = "$DROPIN_NEW" ]; then
  ok "ExecStop drop-in already at canonical content"
else
  if $DRY_RUN; then
    echo "  [DRY] would write $DROPIN_PATH"
  else
    printf '%s\n' "$DROPIN_NEW" > "$DROPIN_PATH"
    if [ -f "$DROPIN_PATH" ] && grep -q 'ExecStop=.*pglite-checkpoint.sh' "$DROPIN_PATH" && grep -q 'TimeoutStopSec=30' "$DROPIN_PATH"; then
      systemctl --user daemon-reload 2>/dev/null || true
      ok "drop-in written: $DROPIN_PATH (daemon-reload OK)"
    else
      warn "drop-in write verify failed"
    fi
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# Fix 7/9 — imagemagick apt install
# ═══════════════════════════════════════════════════════════════════════════
# Needed for thumbnail generation in the desktop dispatch flow. Naturally
# idempotent — apt-get install on already-installed package is a no-op.
hdr "7/9 — imagemagick apt install"
if dpkg-query -W -f='${Status}' imagemagick 2>/dev/null | grep -q '^install ok installed$'; then
  ok "imagemagick already installed"
else
  if $DRY_RUN; then
    echo "  [DRY] sudo apt-get install -y imagemagick"
  else
    sudo apt-get install -y imagemagick >/dev/null 2>&1
    if dpkg-query -W -f='${Status}' imagemagick 2>/dev/null | grep -q '^install ok installed$'; then
      ok "imagemagick installed"
    else
      warn "imagemagick install failed (check apt-get output: \`sudo apt-get install -y imagemagick\`)"
    fi
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# Fix 8/9 — nodejs apt-mark hold + nodesource.sources removal (vm-748 defense)
# ═══════════════════════════════════════════════════════════════════════════
# vm-748 incident (2026-05-18 customer-down 7 days): NodeSource auto-upgraded
# system nodejs from v18 to v24 during an unattended-upgrades cycle. Gateway
# ExecStart pointed at /usr/bin/node (v18 at bake time) → v24 broke
# OpenClaw → silent customer outage. Defense: apt-mark hold + remove the
# NodeSource apt source entirely. Idempotent.
hdr "8/9 — nodejs apt-mark hold + nodesource.sources removal (vm-748 defense)"
if apt-mark showhold 2>/dev/null | grep -q '^nodejs$'; then
  ok "nodejs already apt-marked hold"
else
  if $DRY_RUN; then
    echo "  [DRY] sudo apt-mark hold nodejs"
  else
    sudo apt-mark hold nodejs 2>&1 | grep -v '^$' || true
    if apt-mark showhold 2>/dev/null | grep -q '^nodejs$'; then
      ok "nodejs apt-marked hold"
    else
      warn "apt-mark hold nodejs verify failed"
    fi
  fi
fi
NSRC_SOURCES="/etc/apt/sources.list.d/nodesource.sources"
NSRC_LIST="/etc/apt/sources.list.d/nodesource.list"
for SRC in "$NSRC_SOURCES" "$NSRC_LIST"; do
  if [ -f "$SRC" ]; then
    if $DRY_RUN; then
      echo "  [DRY] sudo rm -f $SRC"
    else
      sudo rm -f "$SRC"
      if [ ! -f "$SRC" ]; then
        ok "removed $SRC"
      else
        warn "rm $SRC failed"
      fi
    fi
  else
    ok "$SRC not present (already removed or never installed)"
  fi
done

# ═══════════════════════════════════════════════════════════════════════════
# Fix 9/9 — openclaw-gateway.service.d drop-in for ~/.bun/bin PATH
# ═══════════════════════════════════════════════════════════════════════════
# Gateway spawns MCP subprocesses; gbrain's CLI uses `#!/usr/bin/env bun`.
# Without ~/.bun/bin on the gateway's PATH, bun isn't resolvable and the
# spawn fails. Validator probe (_postbake-validation.ts:1041) matches
# `.bun/bin` in any drop-in OR the runtime gateway env.
hdr "9/9 — openclaw-gateway PATH drop-in (for gbrain bun shebang)"
GW_DROPIN_DIR="$HOME/.config/systemd/user/openclaw-gateway.service.d"
GW_DROPIN_PATH="$GW_DROPIN_DIR/30-bun-path.conf"
mkdir -p "$GW_DROPIN_DIR"

# Build target PATH: include bun, NVM Node bin (if Node detected), system bins.
if [ -n "$CUR_NODE" ]; then
  GW_PATH_LINE="Environment=PATH=$HOME/.bun/bin:$HOME/.nvm/versions/node/$CUR_NODE/bin:/usr/local/bin:/usr/bin:/bin"
else
  GW_PATH_LINE="Environment=PATH=$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"
fi

GW_DROPIN_NEW=$(cat <<EOF
# Rule 35 / install-gbrain.sh Phase D — ensure openclaw-gateway has bun
# on PATH so MCP subprocesses with #!/usr/bin/env bun shebangs resolve.
# Without this, gbrain (and any future bun-based MCP server) fails to
# spawn from the gateway process. Validator: _postbake-validation.ts:1041.
[Service]
$GW_PATH_LINE
EOF
)

if [ -f "$GW_DROPIN_PATH" ] && [ "$(cat "$GW_DROPIN_PATH")" = "$GW_DROPIN_NEW" ]; then
  ok "openclaw-gateway PATH drop-in already at canonical content"
else
  if $DRY_RUN; then
    echo "  [DRY] would write $GW_DROPIN_PATH"
  else
    printf '%s\n' "$GW_DROPIN_NEW" > "$GW_DROPIN_PATH"
    if grep -qF "$HOME/.bun/bin" "$GW_DROPIN_PATH" 2>/dev/null; then
      systemctl --user daemon-reload 2>/dev/null || true
      ok "drop-in written: $GW_DROPIN_PATH"
    else
      warn "drop-in write verify failed (bun PATH not found in file)"
    fi
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════════════════
hdr "Summary"
if [ "$ERRORS" -eq 0 ]; then
  echo "  ✓ All 9 bake-day gap fixes applied (or already idempotent-correct)."
  echo ""
  echo "  Next: re-run _postbake-validation.ts --mode=bake against this VM."
  echo "  Expected delta from baseline run: -7 to -9 P0/P1 failures."
  echo "  Items 4 (timeoutSeconds) and 11 (consensus_match_pipeline.py cron)"
  echo "  from the original fail list are stale validator expectations"
  echo "  (corrected in the validator in this same commit), not bake gaps."
  echo ""
  echo "  After this script completes successfully, the runbook's next step"
  echo "  is _prebake-cleanup.sh --confirm (per §4 of snapshot-bake-runbook.md)."
  exit 0
else
  echo "  ⚠ $ERRORS fix(es) failed verification — review WARN lines above."
  echo "  DO NOT proceed to _prebake-cleanup.sh until the underlying issue is resolved."
  exit 4
fi
