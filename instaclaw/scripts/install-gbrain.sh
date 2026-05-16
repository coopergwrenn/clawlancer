#!/usr/bin/env bash
# install-gbrain.sh — Per-VM gbrain installer (HTTP sidecar architecture).
#
# Source of truth: instaclaw/docs/prd/gbrain-http-fleet-rewrite-plan-2026-05-16.md
# Implements:      CLAUDE.md Rule 35 (HTTP sidecar architecture)
# Supersedes:      stdio v0.28.1 installer (commit 2ea5b71 era, May 2026)
# Pinned target:   gbrain v0.35.0.0 (commit baf1a47)
#
# Architecture summary (why HTTP sidecar):
#   The stdio architecture spawned `gbrain serve` per agent session, which paid a
#   90+ second cold-start every time (PGLite open + bun runtime + Anthropic SDK +
#   MCP handshake). On vm-050 this routinely killed sessions — OpenClaw's
#   connectionTimeoutMs fired, strip-thinking trimmed the broken session, and
#   users saw "Something went wrong". Plus a v0.28.1 stdin-EOF race condition
#   (fixed upstream in v0.34.1.0 via MCP_STDIO=1) intermittently killed handshakes
#   mid-init. The HTTP sidecar runs gbrain as a persistent systemd --user service
#   bound to loopback 127.0.0.1:3131, with OpenClaw connecting via streamable-http
#   transport + Bearer auth. vm-050 canary (2026-05-15): 564ms tool latency vs
#   90+s stdio cold-start, zero per-session spawn cost.
#
# Phases (parser-contract markers — DO NOT change these strings;
# _install-gbrain-on-vm.ts and lib/vm-reconcile.ts:stepGbrain both pattern-match
# against them):
#   PHASE_X_START / PHASE_X_OK / FATAL_*           on every phase boundary
#   ALREADY_INSTALLED                              when idempotency check passes
#   INSTALL_COMPLETE                               on full successful end-to-end
#   RESULT_OK / RESULT_FAIL                        from verify-gbrain-mcp.py at H
#
# Phases:
#   A  pre-flight (backup + key checks + disk ≥10GB + idempotency early-exit)
#   B  install Bun (with unzip prereq) [preserved from stdio era]
#   C  clone gbrain to ~/gbrain (CANONICAL path per Garry's INSTALL_FOR_AGENTS.md)
#   D  bun install + bun link + 4-segment version verify
#   E  PGLite fresh init + bearer token mint + systemd unit + sidecar start
#   F  HTTP smoke test (/health, /mcp initialize+tools/list with bearer, ext-IP refusal)
#   G  wire openclaw mcp set gbrain (streamable-http) + verify-after-set + hot-reload + gateway health
#   H  real round-trip via verify-gbrain-mcp.py (HTTP harness) — the load-bearing gate
#
# Exit code catalog (operator-debugging contract — preserved + extended from stdio era):
#   0   success (INSTALL_COMPLETE) or ALREADY_INSTALLED
#   1   FATAL_NO_BACKUP, FATAL_BACKUP_CORRUPT, FATAL_DISK_FULL
#   2   FATAL_NO_OPENCLAW, FATAL_NO_OPENAI_KEY, FATAL_NO_ANTHROPIC_KEY
#   3   FATAL_NO_UNZIP_NO_SUDO, FATAL_BUN_INSTALL_FAILED (Bun runtime)
#   4   FATAL_CLONE_FAILED, FATAL_GBRAIN_DIR_INACCESSIBLE
#   5   FATAL_CHECKOUT_DRIFT
#   6   FATAL_BUN_INSTALL_FAILED (gbrain deps)
#   7   FATAL_BUN_LINK_FAILED
#   8   FATAL_VERSION_MISMATCH
#   9   FATAL_PGLITE_INIT_FAILED
#  10   FATAL_TOKEN_MINT_FAILED
#  11   FATAL_TOKEN_HASH_MISMATCH
#  12   FATAL_SYSTEMD_UNIT_WRITE_FAILED
#  13   FATAL_SIDECAR_START_FAILED
#  14   FATAL_SIDECAR_HEALTH_FAILED
#  15   FATAL_SIDECAR_BOUND_PUBLIC          (security invariant — port not on 0.0.0.0)
#  16   FATAL_HTTP_SMOKE_FAILED
#  17   FATAL_MCP_SET_FAILED
#  18   FATAL_VERIFY_AFTER_SET_FAILED
#  19   FATAL_GATEWAY_UNHEALTHY_POST_HOT_RELOAD
#  20   FATAL_VERIFY_GATE_FAILED            (Phase H verify-gbrain-mcp.py failure)
#  21   FATAL_GATEWAY_ROLLBACK_TRIGGERED    (Rule 34 — silent config rollback by OpenClaw)
#  22   FATAL_VERIFY_PY_MISSING
#  23   FATAL_INSTALL_LOCK_HELD             (concurrent install attempt)
#  24   FATAL_PORT_OWNED_BY_OTHER_PROCESS   (port 3131 bound by non-our-sidecar PID)
#
# Co-deployed file requirement:
#   verify-gbrain-mcp.py must be uploaded by the TS wrapper alongside this script,
#   available at /tmp/verify-gbrain-mcp.py at exec time. Phase H aborts with
#   FATAL_VERIFY_PY_MISSING if absent — refuses to silently skip the gate.
#
# Usage (from TS wrapper or stepGbrain reconciler step):
#   GBRAIN_PINNED_COMMIT=baf1a47 GBRAIN_PINNED_VERSION=0.35.0.0 bash install-gbrain.sh

set +e   # don't auto-exit; we handle errors per-phase with explicit exit codes
source ~/.nvm/nvm.sh 2>/dev/null
export PATH="$HOME/.bun/bin:$PATH"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"

# Required pinned values (caller MUST set; script aborts via parameter-substitution)
: "${GBRAIN_PINNED_COMMIT:?GBRAIN_PINNED_COMMIT required}"
: "${GBRAIN_PINNED_VERSION:?GBRAIN_PINNED_VERSION required}"

TS=$(date -u +%Y%m%dT%H%M%SZ)
echo "INSTALL_START ts=$TS commit=$GBRAIN_PINNED_COMMIT version=$GBRAIN_PINNED_VERSION arch=http-sidecar"

# ─────────────────────────────────────────────────────────────────────────────
# Install lock — prevent concurrent installs on the same VM.
# Manual scripts and the reconciler can both attempt installs simultaneously
# (Rule 8 says not to, but defense-in-depth is cheap). flock guards against:
#   - PGLite lock contention if two installs race on `gbrain init --pglite`
#   - mcp.servers.gbrain partial write if two installs both `openclaw mcp set`
#   - systemd unit file corruption if two writes interleave
# Held for the script's lifetime; released by kernel on script exit (even crash).
# ─────────────────────────────────────────────────────────────────────────────
LOCK_FILE="/tmp/gbrain-install.lock"
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
  EXISTING_PID=$(cat "$LOCK_FILE" 2>/dev/null || echo unknown)
  echo "FATAL_INSTALL_LOCK_HELD existing_pid=$EXISTING_PID"
  exit 23
fi
echo $$ > "$LOCK_FILE"

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE A: pre-flight (backup + key checks + disk + idempotency)
# ═══════════════════════════════════════════════════════════════════════════════
echo "PHASE_A_START"

# A1: workspace backup per Rule 22 (preserve user state before any destructive op)
# Tar workspace + sessions.json — small (~5MB), takes <2s, retained in
# ~/.openclaw/session-backups/ which is rotated by strip-thinking.py.
BACKUP_DIR="$HOME/.openclaw/session-backups"
mkdir -p "$BACKUP_DIR"
TARBALL="$BACKUP_DIR/$TS-pre-gbrain.tar.gz"
tar -czf "$TARBALL" -C "$HOME" \
    .openclaw/workspace \
    .openclaw/agents/main/sessions/sessions.json \
    > /dev/null 2>&1
if [ ! -f "$TARBALL" ]; then
  echo "FATAL_NO_BACKUP path=$TARBALL"
  exit 1
fi
# Integrity check — a corrupt tarball is worse than no tarball because it
# implies we'd silently fail to roll back on a Rule 22 incident.
if ! tar -tzf "$TARBALL" > /dev/null 2>&1; then
  echo "FATAL_BACKUP_CORRUPT path=$TARBALL"
  exit 1
fi

# A2: openclaw.json backup — captures pre-mutation state so an operator can
# manually restore if Phase G's openclaw mcp set goes wrong despite our
# rollback path. The reconciler also keeps .last-known-good (separate mechanism).
cp "$HOME/.openclaw/openclaw.json" "/tmp/openclaw.json.bak.$TS"

# A3: prereqs — openclaw CLI + API keys present in .env
# stepEnvVarPush (lib/vm-reconcile.ts) is the upstream source for these keys.
# If they're missing, it's a precondition failure — the reconciler will fix
# .env on the next cycle and stepGbrain retries.
if ! which openclaw > /dev/null 2>&1; then
  echo "FATAL_NO_OPENCLAW"
  exit 2
fi

# OpenAI key — for text-embedding-3-large (1536-dim, matches PGLite schema).
# `printf %s` instead of `echo -n` for POSIX-portable empty-string handling.
OPENAI_KEY=$(grep "^OPENAI_API_KEY=" "$HOME/.openclaw/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')
if [ "$(printf %s "$OPENAI_KEY" | wc -c)" -lt 20 ]; then
  echo "FATAL_NO_OPENAI_KEY"
  exit 2
fi

# Anthropic key — stored under GBRAIN_ANTHROPIC_API_KEY (NOT ANTHROPIC_API_KEY)
# to avoid collision with OpenClaw's auth-profiles ANTHROPIC_API_KEY, which is
# the per-VM gateway proxy token (NOT a real Anthropic key). We map this to
# ANTHROPIC_API_KEY in the gbrain systemd unit's Environment= block (Phase E).
ANTHROPIC_KEY=$(grep "^GBRAIN_ANTHROPIC_API_KEY=" "$HOME/.openclaw/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')
if [ "$(printf %s "$ANTHROPIC_KEY" | wc -c)" -lt 20 ]; then
  echo "FATAL_NO_ANTHROPIC_KEY"
  exit 2
fi

# A4: disk free check — gbrain install (bun + repo + node_modules + PGLite)
# needs ~500MB; we require ≥10GB free to leave headroom for runtime growth
# (session backups, PGLite WAL, etc.). Per May-12 PRD §5.3.
DISK_AVAIL_KB=$(df --output=avail / 2>/dev/null | tail -1 | tr -d ' ')
if [ -z "$DISK_AVAIL_KB" ] || [ "$DISK_AVAIL_KB" -lt 10485760 ]; then
  echo "FATAL_DISK_FULL avail_kb=$DISK_AVAIL_KB threshold_kb=10485760"
  exit 1
fi

# A5: idempotency check — four-state HTTP sidecar invariants (Rule 35).
#
# All four MUST be true to short-circuit to ALREADY_INSTALLED. Any miss means
# this VM is in a partial/wrong state and we re-install. The fail-open posture
# is intentional (per Cooper's 2026-05-16 review): we'd rather reinstall an
# already-fine VM than skip a half-broken one.
#
# Version detection: LENIENT regex captures any dotted version for diagnostic
# (so an operator reading the log sees "V=0.28.1" if stdio era is installed,
# not the confusing "V=missing"). The comparison below uses string equality
# against GBRAIN_PINNED_VERSION (e.g., "0.35.0.0"), so a 3-segment legacy
# detection still triggers re-install — we get correct behavior + useful
# diagnostic.
EXISTING_VERSION=$(gbrain --version 2>/dev/null | head -1 | grep -oE '[0-9]+(\.[0-9]+)+' | head -1)
[ -z "$EXISTING_VERSION" ] && EXISTING_VERSION="missing"
EXISTING_TRANSPORT=$(jq -r '.mcp.servers.gbrain.transport // ""' "$HOME/.openclaw/openclaw.json" 2>/dev/null)
EXISTING_SERVICE=$(systemctl --user is-active gbrain.service 2>/dev/null || echo missing)
# Port check: must be 127.0.0.1:3131. 0.0.0.0:3131 is a SECURITY violation
# and is detected separately as part of the install flow (Phase E7/F4).
# grep -c always outputs a count (0 on no match, N on match) — no need for
# `|| echo 0` fallback, which would create a multi-line "0\n0" capture that
# breaks downstream integer comparisons. (Bug caught during reviewer pass.)
EXISTING_PORT=$(ss -lnpt 2>/dev/null | grep -cE '127\.0\.0\.1:3131([[:space:]]|$)')

if [ "$EXISTING_VERSION" = "$GBRAIN_PINNED_VERSION" ] && \
   [ "$EXISTING_TRANSPORT" = "streamable-http" ] && \
   [ "$EXISTING_SERVICE" = "active" ] && \
   [ "$EXISTING_PORT" = "1" ]; then
  echo "ALREADY_INSTALLED version=$EXISTING_VERSION transport=streamable-http service=active port=loopback"
  exit 0
fi

echo "PHASE_A_OK backup=$TARBALL disk_avail_kb=$DISK_AVAIL_KB existing: V=$EXISTING_VERSION T=$EXISTING_TRANSPORT S=$EXISTING_SERVICE P=$EXISTING_PORT"

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE B: install Bun (with unzip prereq) — preserved verbatim from stdio era
# ═══════════════════════════════════════════════════════════════════════════════
echo "PHASE_B_START"
if ! command -v bun > /dev/null 2>&1; then
  if ! command -v unzip > /dev/null 2>&1; then
    sudo apt-get install -y -qq unzip 2>&1 | tail -3
    if ! command -v unzip > /dev/null 2>&1; then
      echo "FATAL_NO_UNZIP_NO_SUDO"
      exit 3
    fi
  fi
  curl -fsSL https://bun.sh/install | bash 2>&1 | tail -5
  export PATH="$HOME/.bun/bin:$PATH"
  if ! command -v bun > /dev/null 2>&1; then
    echo "FATAL_BUN_INSTALL_FAILED"
    exit 3
  fi
fi
BUN_VERSION=$(bun --version)
echo "PHASE_B_OK bun=$BUN_VERSION"

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE C: clone + checkout pinned commit
# ═══════════════════════════════════════════════════════════════════════════════
# CANONICAL install path: $HOME/gbrain (per Garry's INSTALL_FOR_AGENTS.md).
#
# We DELIBERATELY do NOT use the bun-global path
# ($HOME/.bun/install/global/node_modules/gbrain):
#   1. Rule 35 bans `bun install -g gbrain` — npm "gbrain" at v1.3.1 is a
#      typosquat (stormcolor/gbrain, "GPU JavaScript Library").
#   2. Garry's INSTALL_FOR_AGENTS.md explicitly warns: "Bun blocks the
#      top-level postinstall hook on global installs, so schema migrations
#      never run and the CLI aborts with Aborted() when it opens PGLite."
#   3. vm-050 was historically at the bun-global path; the move to ~/gbrain
#      normalizes the fleet to one canonical location.
#
# Phases C-D effectively migrate any bun-global gbrain install to ~/gbrain.
# The bun-global directory is NOT deleted (cheap to leave; would require sudo
# in some path-permissioning cases). The `bun link` in Phase D overwrites the
# ~/.bun/bin/gbrain symlink to point at ~/gbrain.
echo "PHASE_C_START"
if [ -d "$HOME/gbrain/.git" ]; then
  # Existing checkout — refresh + advance to pinned commit
  cd "$HOME/gbrain" || { echo "FATAL_GBRAIN_DIR_INACCESSIBLE"; exit 4; }
  # Discard any local modifications (chmod-only mode changes, accidental edits)
  # before fetch. Without this, fetch+checkout can be blocked by uncommitted
  # changes (we observed this on vm-050 — chmod +x on src/cli.ts).
  git checkout -- . 2>&1 | tail -3
  git fetch origin 2>&1 | tail -3
else
  # Fresh clone. Garry's repo is public; no auth needed.
  git clone https://github.com/garrytan/gbrain.git "$HOME/gbrain" 2>&1 | tail -3
  if [ ! -d "$HOME/gbrain/.git" ]; then
    echo "FATAL_CLONE_FAILED"
    exit 4
  fi
  cd "$HOME/gbrain" || { echo "FATAL_GBRAIN_DIR_INACCESSIBLE"; exit 4; }
fi
git checkout "$GBRAIN_PINNED_COMMIT" 2>&1 | tail -3
VERIFY_HEAD=$(git rev-parse --short HEAD)
# Pinning verify — Rule 35 / May-12 PRD §5.7 (don't float on master,
# operator manually bumps after canary validation).
if [ "$VERIFY_HEAD" != "$GBRAIN_PINNED_COMMIT" ]; then
  echo "FATAL_CHECKOUT_DRIFT verify=$VERIFY_HEAD expected=$GBRAIN_PINNED_COMMIT"
  # Don't rm -rf here — operator may want the partial state for forensics.
  exit 5
fi
echo "PHASE_C_OK head=$VERIFY_HEAD path=$HOME/gbrain"

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE D: bun install + bun link + version verify
# ═══════════════════════════════════════════════════════════════════════════════
echo "PHASE_D_START"
cd "$HOME/gbrain"

# Run `bun install` with a hard timeout (gbrain has many deps; cold first-run
# can take 60-120s, warm subsequent runs ~5s). The 5min ceiling is generous
# but bounded so a hung network doesn't burn the reconciler's per-VM budget.
timeout 300 bun install 2>&1 | tail -5
BUN_INSTALL_RC=$?
if [ "$BUN_INSTALL_RC" -ne 0 ]; then
  echo "FATAL_BUN_INSTALL_FAILED rc=$BUN_INSTALL_RC"
  # Don't rm -rf — the ~/gbrain dir may have partial node_modules that
  # `bun install` can resume from on next attempt (Bun's cache is shared).
  exit 6
fi

# Defensive: remove any prior `gbrain` symlink in ~/.bun/bin/. Without this,
# `bun link` from ~/gbrain may NOT update the symlink if it already points
# elsewhere (e.g., vm-050's historical bun-global path). The link is recreated
# below; rm-then-recreate is idempotent and avoids the "old symlink still
# resolves to old code" bug class.
rm -f "$HOME/.bun/bin/gbrain"

bun link 2>&1 | tail -3
if ! command -v gbrain > /dev/null 2>&1; then
  echo "FATAL_BUN_LINK_FAILED"
  exit 7
fi

# Verify version matches pinning. Strict 4-segment regex per Cooper's
# 2026-05-16 tightening — anchored, exact match, no partial-acceptance.
GBRAIN_INSTALLED_VERSION=$(gbrain --version 2>&1 | head -1 | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || echo missing)
if [ "$GBRAIN_INSTALLED_VERSION" != "$GBRAIN_PINNED_VERSION" ]; then
  echo "FATAL_VERSION_MISMATCH installed=$GBRAIN_INSTALLED_VERSION expected=$GBRAIN_PINNED_VERSION"
  exit 8
fi
GBRAIN_BIN_TARGET=$(readlink -f "$HOME/.bun/bin/gbrain" 2>/dev/null || echo unknown)
echo "PHASE_D_OK gbrain=$GBRAIN_INSTALLED_VERSION bin_target=$GBRAIN_BIN_TARGET"

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE E: PGLite fresh init + bearer token mint + systemd unit + sidecar start
# ═══════════════════════════════════════════════════════════════════════════════
echo "PHASE_E_START"

# ─── E1: stop existing gbrain processes (release PGLite lock + clear stdio orphans) ───
#
# PGLite is file-locked single-writer. Anything holding the lock makes Phase E3
# init fail. Three places to look:
#   1. The systemd service (gbrain.service) if a prior HTTP install partially
#      succeeded
#   2. Orphan stdio gbrain processes from the v0.28.1 era (`bun run .../cli.ts serve`
#      launched per-session by OpenClaw, may persist after gateway crashes)
#   3. Stale `gbrain serve --http` processes from a failed install attempt
#
# ⚠️  P0 (IR finding 2026-05-16): SIGTERM CORRUPTS the PGLite data directory.
# Counterintuitively, SIGKILL produces RECOVERABLE state — the PGLite WAL
# replays cleanly on next boot. The bug is NOT missing graceful-shutdown;
# gbrain has a proper handler (SIGTERM → engine.disconnect() → db.close() →
# releaseLock → process.exit(0)). The bug is INSIDE PGLite's db.close(): it
# writes something during close that corrupts the data directory so the
# next WASM init fails. Broken handler, not missing handler. Upstream issue
# pending; the fix probably lives in @electric-sql/pglite's shutdown path,
# not gbrain itself.
#
# Implications for this install path:
#   - SAFE here because Phase E2 WIPES PGLite immediately after stop (we don't
#     preserve the post-stop state). We use SIGKILL anyway to (a) avoid
#     leaving any corrupted state on disk between E1 and E2 that could be
#     mis-recovered by a manual rollback, and (b) match the unit file's
#     KillSignal=SIGKILL (Phase E5) so all stop paths converge on the same
#     signal.
#   - UNSAFE for any FUTURE code that does stop+restart WITHOUT wipe:
#     freeze-thaw flows, watchdog auto-restart, operator-driven service
#     restart. Such code MUST use SIGKILL (via KillSignal=SIGKILL in the
#     unit, or `systemctl kill --signal=SIGKILL`) — never SIGTERM.
#   - The right long-term fix is upstream: either fix gbrain's SIGTERM
#     handler, OR expose PGLite's native `engine.db.dumpDataDir("gzip")`
#     hot-backup as an HTTP/MCP admin endpoint so we can capture state
#     without stopping. (IR found dumpDataDir produces a hot backup without
#     stopping — see snapshot-bake doc for the freeze-thaw P2 followup.)
#
# pkill -f matches against full command line. Pattern matches both:
#   stdio era: `bun /home/openclaw/.bun/install/global/node_modules/gbrain/src/cli.ts serve`
#   HTTP era:  `/home/openclaw/.bun/bin/gbrain serve --http --port 3131`
# Our own bash script isn't a bun process so we don't risk killing ourselves.
# (The Phase E4 mint-token bun script runs LATER and the regex requires
# both 'gbrain' AND 'serve' to be in the command line — mint runs `bun run`
# on a file path that contains 'gbrain' but not 'serve'.)
pkill -KILL -f 'gbrain.*serve' 2>/dev/null
sleep 1  # let kernel reap PIDs + release PGLite file handles

# Now mark the systemd unit inactive (prevents Restart=always from
# respawning gbrain mid-install). Since the main PID is already gone via
# pkill -KILL above, `systemctl stop` becomes a no-op signal-wise — it
# transitions the unit state to inactive without sending SIGTERM to any
# live PID. This is the safe ordering.
systemctl --user stop gbrain.service 2>/dev/null
sleep 1

# Sanity check — fail loudly if anything is still holding gbrain alive
# (systemd may have respawned faster than we expected; some other process
# may be running gbrain serve outside systemd; etc.).
REMAINING=$(pgrep -f 'gbrain.*serve' 2>/dev/null | head -3 | tr '\n' ',')
if [ -n "$REMAINING" ]; then
  # One more SIGKILL pass + brief retry of stop. If still alive after this,
  # PGLite init in Phase E3 will fail with lock contention and we'll FATAL
  # at the right layer with a clear diagnostic.
  pkill -KILL -f 'gbrain.*serve' 2>/dev/null
  systemctl --user stop gbrain.service 2>/dev/null
  sleep 1
  REMAINING_AFTER=$(pgrep -f 'gbrain.*serve' 2>/dev/null | head -3 | tr '\n' ',')
  if [ -n "$REMAINING_AFTER" ]; then
    echo "WARN: gbrain processes still alive after 2x SIGKILL: pids=$REMAINING_AFTER (PGLite init will hard-fail if lock contention)"
  fi
fi

# ─── E2: wipe existing PGLite with safety backup ───
#
# Cooper's 2026-05-16 directive: edge_city test agents have expendable brain
# data, so wipe-on-install is authorized. But: backup before destroy ANYWAY —
# costs ~2s, gives us recovery if "expendable" was wrong. Backup retention
# capped at 3 most-recent (older deleted) to prevent disk creep on a VM that
# repeatedly fails+retries installs.
if [ -d "$HOME/.gbrain/brain.pglite" ]; then
  PGLITE_BACKUP="$HOME/.gbrain/brain.pglite.PRE-WIPE-$TS.tar.gz"
  tar czf "$PGLITE_BACKUP" -C "$HOME/.gbrain" brain.pglite 2>/dev/null
  echo "  pglite_backup=$PGLITE_BACKUP"
  rm -rf "$HOME/.gbrain/brain.pglite"

  # Cleanup: keep only 3 most recent backups to bound disk growth across retries.
  # `ls -t` sorts newest-first; tail -n +4 skips the first 3 (newest); rm deletes
  # the older tail. `2>/dev/null` swallows "no such file" on first run.
  ls -t "$HOME/.gbrain"/brain.pglite.PRE-WIPE-*.tar.gz 2>/dev/null | tail -n +4 | xargs -r rm -f
fi
# Remove old config so `gbrain init --pglite` creates fresh state.
# (config.json points to brain.pglite path; needs to regenerate.)
rm -f "$HOME/.gbrain/config.json"

# ─── E3: fresh PGLite init ───
#
# CRITICAL: must NOT have GBRAIN_DATABASE_URL set. v0.35.0.0 reads engine
# config from ~/.gbrain/config.json; if a pglite:// URL is in the env, the
# new code tries to parse it as a Postgres URL and dies with "Cannot connect
# to database". We unset both env vars here and run init from a clean shell.
#
# Hard timeout 60s: init runs migrations against a FRESH schema (~3-5s on
# typical hardware). If it's taking 60s, something is wrong (PGLite WASM
# stuck, disk I/O blocked, etc.) — better to fail fast at the right phase
# than wait for the outer GBRAIN_INSTALL_TIMEOUT_MS to fire on a hung step.
unset GBRAIN_DATABASE_URL DATABASE_URL
cd "$HOME/gbrain"
timeout 60 gbrain init --pglite 2>&1 | tail -10
INIT_RC=${PIPESTATUS[0]}
if [ "$INIT_RC" -eq 124 ]; then
  echo "FATAL_PGLITE_INIT_FAILED timeout_60s"
  exit 9
fi
if [ ! -d "$HOME/.gbrain/brain.pglite" ]; then
  echo "FATAL_PGLITE_INIT_FAILED no_dir rc=$INIT_RC"
  exit 9
fi
if [ ! -f "$HOME/.gbrain/config.json" ]; then
  echo "FATAL_PGLITE_INIT_FAILED no_config_json rc=$INIT_RC"
  exit 9
fi

# ─── E4: mint bearer token via direct PGLite INSERT ───
#
# Why direct INSERT (not `gbrain auth create`): v0.35.0.0's auth.ts imports
# `postgres` and tries to connect TCP :5432 — fails with ECONNREFUSED on
# PGLite installations. Upstream fix is one-line (use engine.executeRaw)
# but we don't ship until it's merged. Direct INSERT via @electric-sql/pglite
# is the canonical workaround until then. See PRD §Known Issue #1.
#
# Atomicity guarantee:
#   1. INSERT row in access_tokens with sha256(token)
#   2. Verify INSERT by re-reading the hash and comparing
#   3. ONLY THEN write the plaintext to a tmpfile + atomic rename
# This ordering means: if we crash between INSERT and file-write, next install
# attempt DELETES the row (line 1 of the script) before re-inserting — clean
# slate. If we crash after file-write, idempotency check on next install
# detects (V=ok, T=empty since no openclaw.json change yet) and re-installs.

MINT_TS_PY="/tmp/_mint-gbrain-token-$TS.ts"
cat > "$MINT_TS_PY" <<'TSEOF'
import { PGlite } from '@electric-sql/pglite';
import { createHash, randomBytes } from 'crypto';
import { writeFileSync, renameSync, chmodSync } from 'fs';

const NAME = 'openclaw-vm';
const HOME = process.env.HOME!;
const DB = `${HOME}/.gbrain/brain.pglite`;
const FILE = `${HOME}/.gbrain/openclaw-bearer-token.txt`;
const TMP_FILE = `${FILE}.tmp.${process.pid}`;

const db = new PGlite(DB);
await db.waitReady;
try {
  // Idempotent: any prior row gets removed before INSERT
  await db.query(`DELETE FROM access_tokens WHERE name = $1`, [NAME]);

  const token = 'gbrain_' + randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(token).digest('hex');
  await db.query(`INSERT INTO access_tokens (name, token_hash) VALUES ($1, $2)`, [NAME, hash]);

  // Verify INSERT by re-reading from DB and comparing hash
  const verify = await db.query<{ token_hash: string }>(
    `SELECT token_hash FROM access_tokens WHERE name = $1`,
    [NAME]
  );
  const db_hash = verify.rows[0]?.token_hash;
  if (db_hash !== hash) {
    // Marker first (parsable by parent bash), then exit with specific code.
    console.error(`TOKEN_HASH_MISMATCH db=${db_hash} expected=${hash}`);
    process.exit(11);
  }

  // Atomic file write: tmp + rename so a crash mid-write leaves either the
  // OLD token file in place (recoverable) or the NEW token file (correct).
  // Never a half-written file.
  writeFileSync(TMP_FILE, token, 'utf-8');
  chmodSync(TMP_FILE, 0o600);
  renameSync(TMP_FILE, FILE);

  console.log(`TOKEN_MINTED hash=${hash}`);
} catch (e) {
  console.error(`TOKEN_MINT_ERROR ${String(e instanceof Error ? e.message : e).slice(0, 200)}`);
  process.exit(12);
} finally {
  await db.close();
}
TSEOF

cd "$HOME/gbrain"
MINT_OUT=$(timeout 30 bun run "$MINT_TS_PY" 2>&1)
MINT_RC=$?
echo "$MINT_OUT" | tail -5

# Order matters: check hash-mismatch marker BEFORE the rc, because a hash
# mismatch causes process.exit(11) which makes MINT_RC=11. If we checked rc
# first, we'd fire the generic FATAL_TOKEN_MINT_FAILED and never reach the
# specific TOKEN_HASH_MISMATCH branch.
if echo "$MINT_OUT" | grep -q "^TOKEN_HASH_MISMATCH"; then
  echo "FATAL_TOKEN_HASH_MISMATCH"
  rm -f "$MINT_TS_PY"
  exit 11
fi
if [ "$MINT_RC" -ne 0 ]; then
  echo "FATAL_TOKEN_MINT_FAILED rc=$MINT_RC"
  rm -f "$MINT_TS_PY"
  exit 10
fi
if ! echo "$MINT_OUT" | grep -q "^TOKEN_MINTED "; then
  echo "FATAL_TOKEN_MINT_FAILED no_marker"
  rm -f "$MINT_TS_PY"
  exit 10
fi
rm -f "$MINT_TS_PY"

BEARER_TOKEN=$(cat "$HOME/.gbrain/openclaw-bearer-token.txt" 2>/dev/null)
if [ -z "$BEARER_TOKEN" ]; then
  echo "FATAL_TOKEN_MINT_FAILED empty_file"
  exit 10
fi

# ─── E5: write systemd user unit ───
#
# Critical details:
# - StartLimitIntervalSec / StartLimitBurst belong in [Unit], NOT [Service]
#   (systemd warns "Unknown key" and falls back to defaults if misplaced;
#   we saw this on vm-050 in May).
# - Environment= directives are processed by systemd at unit-start time;
#   values containing $ or backticks would be problematic IF the values
#   were heredoc-expanded by the SHELL. But here we use an EXPANDING heredoc
#   ($HOME etc. expand) WITHOUT command substitution, and API keys are
#   alphanumeric+dashes (no shell metacharacters in practice).
# - Resource limits (MemoryHigh=2G, MemoryMax=2500M, TasksMax=50) prevent a
#   misbehaving gbrain from starving the gateway. Sidecar's normal RSS is
#   ~300MB so 2-2.5G is comfortable headroom.
# - Restart=always means systemd respawns on ANY exit (including success).
#   For a long-running server this is correct; a graceful shutdown is itself
#   a "should restart" signal.
mkdir -p "$HOME/.config/systemd/user"
UNIT_FILE="$HOME/.config/systemd/user/gbrain.service"
cat > "$UNIT_FILE" <<UNITEOF
[Unit]
Description=GBrain MCP HTTP sidecar (persistent, loopback-only, Rule 35)
Documentation=https://github.com/garrytan/gbrain
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
WorkingDirectory=$HOME/gbrain
Environment=PATH=$HOME/.bun/bin:$HOME/.nvm/versions/node/v22.22.2/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=$HOME
Environment=OPENAI_API_KEY=$OPENAI_KEY
Environment=ANTHROPIC_API_KEY=$ANTHROPIC_KEY
Environment=GBRAIN_EMBEDDING_MODEL=openai:text-embedding-3-large
Environment=GBRAIN_ANTHROPIC_MAX_INFLIGHT=3
ExecStart=$HOME/.bun/bin/gbrain serve --http --port 3131
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=gbrain
MemoryHigh=2G
MemoryMax=2500M
TasksMax=50
TimeoutStopSec=15
# KillSignal=SIGKILL (NOT SIGTERM): per IR finding 2026-05-16, PGLite's
# db.close() corrupts the data directory on graceful shutdown. SIGKILL
# produces recoverable state where the WAL replays cleanly on next boot.
# Apply universally so operator-driven systemctl stop/restart/reload doesn't
# accidentally corrupt PGLite. Upstream PGLite fix pending; remove this when
# the close-path is fixed and we want graceful in-flight-HTTP-request drain.
KillSignal=SIGKILL

[Install]
WantedBy=default.target
UNITEOF

if [ ! -f "$UNIT_FILE" ]; then
  echo "FATAL_SYSTEMD_UNIT_WRITE_FAILED path=$UNIT_FILE"
  exit 12
fi
chmod 644 "$UNIT_FILE"

# ─── E6: enable + start sidecar ───
#
# daemon-reload is REQUIRED after writing a new unit file. Without it,
# systemd's unit cache doesn't see the new file and `systemctl enable` either
# fails with "unit not found" or operates on a stale cached unit.
systemctl --user daemon-reload 2>&1
systemctl --user enable gbrain.service 2>&1 | tail -3
systemctl --user start gbrain.service 2>&1

# ─── E7: poll for active + loopback bind + /health 200 (up to 30s) ───
#
# Three concurrent checks; all must pass:
#   active   — systemd reports the service started (no immediate crash)
#   bind     — port 3131 bound to 127.0.0.1 (NOT 0.0.0.0; security invariant)
#   health   — gbrain's /health returns 200 (PGLite opened, server listening)
#
# Also DETECT public bind early and fail with the specific exit code 15.
HEALTHY=0
for i in 1 2 3 4 5 6; do
  sleep 5
  S=$(systemctl --user is-active gbrain.service 2>/dev/null)
  PORT_LOOPBACK=$(ss -lnpt 2>/dev/null | grep '127\.0\.0\.1:3131' | head -1)
  PORT_PUBLIC=$(ss -lnpt 2>/dev/null | grep '0\.0\.0\.0:3131' | head -1)
  HEALTH=$(curl -sf -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:3131/health 2>/dev/null)
  echo "  iter=$i (t=+$((i*5))s) active=$S loopback=${PORT_LOOPBACK:+yes} public=${PORT_PUBLIC:+BAD} health=$HEALTH"

  # Security invariant — fail loudly if gbrain bound to 0.0.0.0 (any future
  # version regression that defaulted to 0.0.0.0 must NOT be silently
  # accepted; we'd be exposing the bearer-auth endpoint to the public
  # internet on port 3131).
  if [ -n "$PORT_PUBLIC" ]; then
    echo "FATAL_SIDECAR_BOUND_PUBLIC port=$PORT_PUBLIC"
    systemctl --user stop gbrain.service 2>/dev/null
    exit 15
  fi

  if [ "$S" = "active" ] && [ -n "$PORT_LOOPBACK" ] && [ "$HEALTH" = "200" ]; then
    HEALTHY=1
    break
  fi
done

if [ "$HEALTHY" != "1" ]; then
  # Forensic dump — systemctl status (last 15 lines) goes to stdout for
  # operator visibility. Journal stays on disk separately for deeper dive.
  STATUS_TAIL=$(systemctl --user status gbrain.service --no-pager 2>&1 | tail -15)
  echo "  status_tail: $(echo "$STATUS_TAIL" | tr '\n' '|')"
  # Distinguish "started but unhealthy" from "never started"
  if [ -n "$(ss -lnpt 2>/dev/null | grep ':3131')" ]; then
    echo "FATAL_SIDECAR_HEALTH_FAILED bound_but_health_failed"
    exit 14
  fi
  echo "FATAL_SIDECAR_START_FAILED active=$S health=$HEALTH"
  exit 13
fi

# ─── E8: verify the port IS owned by our systemd-managed PID ───
#
# Edge case: some unrelated process could have bound 3131 first, AND our
# sidecar could be "active" but not actually listening (in a different state).
# Parse `ss -lnpt` output for the PID column and compare to MainPID.
# Output format: `LISTEN 0  512  127.0.0.1:3131  0.0.0.0:*  users:(("bun",pid=4021438,fd=59))`
PORT_PID=$(ss -lnpt 2>/dev/null | grep '127\.0\.0\.1:3131' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
EXPECTED_PID=$(systemctl --user show gbrain.service -p MainPID --value)
if [ -z "$PORT_PID" ] || [ "$PORT_PID" != "$EXPECTED_PID" ]; then
  echo "FATAL_PORT_OWNED_BY_OTHER_PROCESS port_pid=$PORT_PID expected_pid=$EXPECTED_PID"
  systemctl --user stop gbrain.service 2>/dev/null
  exit 24
fi

echo "PHASE_E_OK bearer_prefix=${BEARER_TOKEN:0:14}... main_pid=$EXPECTED_PID port=127.0.0.1:3131"

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE F: HTTP smoke test (pre-MCP-flip validation)
# ═══════════════════════════════════════════════════════════════════════════════
#
# Why this exists: Phase E proved the sidecar is up + listening + healthy at the
# transport layer. Phase F proves it RESPONDS CORRECTLY to authenticated MCP
# calls. We don't want to flip openclaw.json to streamable-http only to find
# out a half-second later that the sidecar's MCP layer is broken.
#
# Four sub-checks:
#   F1  /health (no auth)         — already proven healthy in E7, sanity recheck
#   F2  /mcp initialize (auth)    — exercises Bearer auth + protocol negotiation
#   F3  /mcp tools/list (auth)    — exercises full auth + confirms tool surface
#   F4  external-IP refusal       — security invariant: port 3131 NOT public
echo "PHASE_F_START"

# F1: /health
HEALTH_BODY=$(curl -sf -m 3 http://127.0.0.1:3131/health 2>/dev/null)
if ! echo "$HEALTH_BODY" | grep -q '"status":"ok"'; then
  echo "FATAL_HTTP_SMOKE_FAILED phase=F1 body=$(echo "$HEALTH_BODY" | head -c 200)"
  exit 16
fi

# F2: /mcp initialize with bearer auth — exercises auth path end-to-end
INIT_PAYLOAD='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"install-gbrain","version":"1.0"}}}'
INIT_BODY=$(curl -sf -m 5 \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $BEARER_TOKEN" \
  -d "$INIT_PAYLOAD" \
  http://127.0.0.1:3131/mcp 2>/dev/null)
if ! echo "$INIT_BODY" | grep -q '"protocolVersion"'; then
  echo "FATAL_HTTP_SMOKE_FAILED phase=F2 body=$(echo "$INIT_BODY" | head -c 200)"
  exit 16
fi
if ! echo "$INIT_BODY" | grep -q '"name":"gbrain"'; then
  echo "FATAL_HTTP_SMOKE_FAILED phase=F2 server_name_wrong body=$(echo "$INIT_BODY" | head -c 200)"
  exit 16
fi

# F3: /mcp tools/list with bearer — confirms tool surface includes put_page.
#
# Tool counting: pipe grep -o output directly through `sort -u | wc -l`. This
# correctly produces 0 when there are no matches (no input → wc -l counts 0
# lines, not 1). DO NOT use `echo "$VAR" | wc -l` — empty $VAR + echo's
# trailing newline incorrectly yields 1.
TOOLS_BODY=$(curl -sf -m 5 \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $BEARER_TOKEN" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  http://127.0.0.1:3131/mcp 2>/dev/null)
TOOL_COUNT=$(echo "$TOOLS_BODY" | grep -oE '"name":"[a-z_]+"' | sort -u | wc -l | tr -d ' ')
if [ "$TOOL_COUNT" -lt 5 ]; then
  echo "FATAL_HTTP_SMOKE_FAILED phase=F3 tool_count=$TOOL_COUNT body=$(echo "$TOOLS_BODY" | head -c 200)"
  exit 16
fi
# put_page is the critical write tool — without it, gbrain can't persist memories.
if ! echo "$TOOLS_BODY" | grep -q '"name":"put_page"'; then
  TOOL_NAMES_FLAT=$(echo "$TOOLS_BODY" | grep -oE '"name":"[a-z_]+"' | sort -u | tr '\n' ',')
  echo "FATAL_HTTP_SMOKE_FAILED phase=F3 no_put_page tools=$TOOL_NAMES_FLAT"
  exit 16
fi

# F4: external-IP refusal — security invariant per Rule 35.
# Even if F1-F3 passed via loopback, the port could be ALSO bound publicly
# (dual-stack misconfig). Test by opening a TCP connection to the VM's
# external IP. Should REFUSE (firewall) or RESET (unbound interface).
EXT_IP=$(hostname -I | awk '{print $1}')
EXT_TEST=$(timeout 3 bash -c "</dev/tcp/$EXT_IP/3131" 2>&1 && echo OPEN || echo REFUSED)
if [ "$EXT_TEST" != "REFUSED" ]; then
  echo "FATAL_SIDECAR_BOUND_PUBLIC external_test=$EXT_TEST ext_ip=$EXT_IP"
  systemctl --user stop gbrain.service 2>/dev/null
  exit 15
fi

echo "PHASE_F_OK tools=$TOOL_COUNT ext_refused=yes loopback_health=200"

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE G: wire MCP via openclaw mcp set (streamable-http) + verify hot-reload
# ═══════════════════════════════════════════════════════════════════════════════
#
# This is the user-visible flip. After Phase G succeeds, the agent's MCP
# runtime will (on next session catalog build) connect to gbrain via HTTP
# instead of spawning stdio. The sidecar is already up + healthy from Phase E,
# so there's no cold-start window.
#
# Order matters:
#   G1  openclaw mcp unset gbrain      — clean transition stdio→HTTP
#   G2  build streamable-http JSON     — bearer token embedded
#   G3  capture journal cursor          — for hot-reload verification
#   G4  openclaw mcp set gbrain        — atomic write via openclaw CLI
#   G5  sleep 2                         — hot-reload window
#   G6  verify-after-set (Rule 10)     — re-read disk to confirm shape
#   G7  empirical hot-reload confirm   — journal grep + GATEWAY_ROLLBACK detect
#   G8  gateway health probe (Rule 5)  — gateway still up post-config-reload
#
# Rollback on any failure: openclaw mcp unset gbrain. Leaves the VM with NO
# gbrain MCP entry (preferable to a half-flipped state). Next reconcile retries.
echo "PHASE_G_START"

# G1: defensively unset (no-op if nothing set). Avoids merge ambiguity if a
# stdio-shape entry was lingering.
openclaw mcp unset gbrain 2>&1 | tail -3

# G2: build streamable-http JSON. Use python heredoc so we don't have to
# manually escape the bearer token in JSON. (Token is a 71-char hex string;
# no JSON special chars, but defense-in-depth via python's json.dumps.)
GBRAIN_JSON_FILE="/tmp/gbrain-mcp-http-$TS.json"
BEARER_TOKEN="$BEARER_TOKEN" python3 > "$GBRAIN_JSON_FILE" <<'PYEOF'
import json, os
print(json.dumps({
    "transport": "streamable-http",
    "url": "http://127.0.0.1:3131/mcp",
    "headers": {"Authorization": f"Bearer {os.environ['BEARER_TOKEN']}"},
    "connectionTimeoutMs": 5000,
}))
PYEOF
if [ ! -s "$GBRAIN_JSON_FILE" ]; then
  echo "FATAL_MCP_SET_FAILED phase=G2 reason=json_build"
  exit 17
fi

# G3: capture journal start epoch (timezone-immune) — for hot-reload grep window
JOURNAL_SINCE_EPOCH=$(date +%s)

# G4: apply via openclaw CLI (atomic-write + hot-reload trigger)
openclaw mcp set gbrain "$(cat "$GBRAIN_JSON_FILE")" 2>&1 | tail -3
SET_RC=$?
rm -f "$GBRAIN_JSON_FILE"
if [ "$SET_RC" -ne 0 ]; then
  echo "FATAL_MCP_SET_FAILED rc=$SET_RC"
  exit 17
fi

# G5: hot-reload window. The May-12 PRD §Decision Log confirms mcp.servers.*
# is hot-reloadable (the gateway's config-watcher emits
# "[reload] config hot reload applied" within <1s). Sleep 2s for slow VMs.
sleep 2

# G6: verify-after-set (Rule 10) — re-read disk and confirm the transport key
# is on disk. Cheap, deterministic. Catches the rare case where `openclaw mcp
# set` returned 0 but didn't actually write (config validator rejected our
# shape, atomic-rename failed, etc.).
DISK_TRANSPORT=$(jq -r '.mcp.servers.gbrain.transport // ""' "$HOME/.openclaw/openclaw.json" 2>/dev/null)
if [ "$DISK_TRANSPORT" != "streamable-http" ]; then
  echo "FATAL_VERIFY_AFTER_SET_FAILED disk_transport=$DISK_TRANSPORT"
  openclaw mcp unset gbrain > /dev/null 2>&1
  exit 18
fi
# Also confirm via the openclaw CLI's own view (catches in-memory state drift
# from disk state — the Rule 32 case).
SHOW=$(openclaw mcp show gbrain 2>&1)
if ! echo "$SHOW" | grep -q "streamable-http"; then
  echo "FATAL_VERIFY_AFTER_SET_FAILED show_no_streamable show=$(echo "$SHOW" | head -c 200)"
  openclaw mcp unset gbrain > /dev/null 2>&1
  exit 18
fi

# G7: empirical hot-reload confirm (Rule 32) + Rule 34 rollback detection.
#
# `journalctl --since "@<epoch>"` uses Unix-time absolute; timezone-immune
# (vs `--since "<date>"` which interprets in local time and can mismatch our
# UTC-captured TS).
#
# Two signals to detect:
#   `config hot reload applied`        — desired (hot-reload landed)
#   `GATEWAY_ROLLBACK_TRIGGERED`       — Rule 34 violation (config rolled back)
#
# Hot-reload not-detected is a WARN, not FATAL — timing windows can be flaky
# on slow VMs and the file write itself is the ground truth. But a rollback
# is ALWAYS fatal (it means our config was reverted out from under us).
JOURNAL_WINDOW=$(journalctl --user -u openclaw-gateway --since "@$JOURNAL_SINCE_EPOCH" --no-pager 2>&1 | tail -100)
if echo "$JOURNAL_WINDOW" | grep -q "GATEWAY_ROLLBACK_TRIGGERED"; then
  echo "FATAL_GATEWAY_ROLLBACK_TRIGGERED journal_tail=$(echo "$JOURNAL_WINDOW" | grep ROLLBACK | head -3 | tr '\n' '|')"
  openclaw mcp unset gbrain > /dev/null 2>&1
  exit 21
fi
# grep -c always outputs a count; no `|| echo 0` fallback needed (and the
# fallback would produce a multi-line capture that breaks the comparison
# below — same bug class as the EXISTING_PORT fix in Phase A).
HOT_RELOAD_HITS=$(echo "$JOURNAL_WINDOW" | grep -c "config hot reload applied")
if [ "$HOT_RELOAD_HITS" = "0" ]; then
  echo "  warn: 'config hot reload applied' not found in journal window (timing skew or slow watcher; not fatal)"
fi

# G8: gateway health (Rule 5). The hot-reload should NOT have broken the
# gateway. If it did (parse error, etc.), we want to know immediately —
# don't let Phase H proceed against an unhealthy gateway.
GW_HEALTH=$(curl -sf -m 3 -o /dev/null -w '%{http_code}' http://localhost:18789/health 2>/dev/null)
if [ "$GW_HEALTH" != "200" ]; then
  echo "FATAL_GATEWAY_UNHEALTHY_POST_HOT_RELOAD health=$GW_HEALTH"
  openclaw mcp unset gbrain > /dev/null 2>&1
  exit 19
fi

echo "PHASE_G_OK transport=streamable-http gw_health=$GW_HEALTH hot_reload_hits=$HOT_RELOAD_HITS"

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE H: real round-trip via verify-gbrain-mcp.py
# ═══════════════════════════════════════════════════════════════════════════════
#
# This is the load-bearing gate. Phases A-G prove "the install completed
# without errors." Phase H proves "a real agent could use this." It drives a
# put_page → get_page round-trip through the sidecar via HTTP+Bearer auth.
#
# THREE bug classes Phase F-G might miss that Phase H catches (per May-12 PRD):
#   1. embedding-dimension mismatch — put_page fails at embed time
#   2. PGLite schema corruption — put_page fails at INSERT
#   3. Bearer-token mismatch — auth fails on a real call (vs the smoke test's
#      shallow call that might have a different code path)
echo "PHASE_H_START"

# Locate verify script — uploaded by the TS wrapper to /tmp/verify-gbrain-mcp.py
# at install start. If missing, refuse to silently skip the gate.
VERIFY_PY_SRC=""
for candidate in \
    "/tmp/verify-gbrain-mcp.py" \
    "$(dirname "${BASH_SOURCE[0]}")/verify-gbrain-mcp.py"; do
  if [ -s "$candidate" ]; then VERIFY_PY_SRC="$candidate"; break; fi
done
if [ -z "$VERIFY_PY_SRC" ]; then
  echo "FATAL_VERIFY_PY_MISSING expected=/tmp/verify-gbrain-mcp.py"
  echo "hint: TS wrapper must SFTP verify-gbrain-mcp.py alongside install-gbrain.sh"
  openclaw mcp unset gbrain > /dev/null 2>&1
  exit 22
fi
# Copy to a TS-suffixed path so concurrent installs (unlikely but possible)
# don't fight over the same exec path.
VERIFY_PY="/tmp/verify-gbrain-mcp-$TS.py"
cp "$VERIFY_PY_SRC" "$VERIFY_PY"
chmod +x "$VERIFY_PY"

VERIFY_OUT=$(MARKER_TS="$TS" \
  GBRAIN_BEARER_TOKEN="$BEARER_TOKEN" \
  OPENAI_API_KEY="$OPENAI_KEY" \
  ANTHROPIC_API_KEY="$ANTHROPIC_KEY" \
  timeout 180 python3 "$VERIFY_PY" 2>&1)
VERIFY_RC=$?
# Tail for forensic visibility (full output is in calling-script's captured stdout)
echo "$VERIFY_OUT" | tail -12

if [ "$VERIFY_RC" -ne 0 ]; then
  echo "FATAL_VERIFY_GATE_FAILED rc=$VERIFY_RC"
  openclaw mcp unset gbrain > /dev/null 2>&1
  rm -f "$VERIFY_PY"
  exit 20
fi

# Parse the verify script's single RESULT line. Tolerates leading whitespace.
RESULT_LINE=$(echo "$VERIFY_OUT" | grep -oE 'RESULT_(OK|FAIL)[^\n]*' | head -1)
if [ -z "$RESULT_LINE" ] || ! echo "$RESULT_LINE" | grep -q "^RESULT_OK"; then
  echo "FATAL_VERIFY_GATE_FAILED no_result_ok line='$RESULT_LINE'"
  openclaw mcp unset gbrain > /dev/null 2>&1
  rm -f "$VERIFY_PY"
  exit 20
fi

# Cleanup the temp script copy
rm -f "$VERIFY_PY"

echo "PHASE_H_OK $RESULT_LINE"

# ═══════════════════════════════════════════════════════════════════════════════
# DONE
# ═══════════════════════════════════════════════════════════════════════════════
echo "INSTALL_COMPLETE"
echo "  bun:         $(bun --version)"
echo "  gbrain:      $GBRAIN_INSTALLED_VERSION (commit $VERIFY_HEAD)"
echo "  install_path: $HOME/gbrain"
echo "  pglite:      $HOME/.gbrain/brain.pglite"
echo "  sidecar:     active (pid=$(systemctl --user show gbrain.service -p MainPID --value))"
echo "  port:        127.0.0.1:3131 (loopback)"
echo "  transport:   streamable-http"
echo "  bearer:      ${BEARER_TOKEN:0:14}... (file=$HOME/.gbrain/openclaw-bearer-token.txt)"
echo "  workspace:   $TARBALL"
echo "  cfg_bak:     /tmp/openclaw.json.bak.$TS"
exit 0
