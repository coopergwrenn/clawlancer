#!/usr/bin/env bash
# install-gbrain.sh — Per-VM gbrain installer (HTTP sidecar architecture).
#
# Source of truth: instaclaw/docs/prd/gbrain-http-fleet-rewrite-plan-2026-05-16.md
# Implements:      CLAUDE.md Rule 35 (HTTP sidecar architecture)
# Supersedes:      stdio v0.28.1 installer (commit 2ea5b71 era, May 2026)
# Pinned target:   gbrain v0.36.3.0 (commit 1d5f69f)
#                  Previous: v0.35.0.0 (baf1a47). Bumped 2026-05-19 after
#                  in-place-upgrade canary on vm-050 validated the path.
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
#   ALREADY_INSTALLED                              when 5-invariant idempotency passes
#   BEARER_SYNCED                                  when Phase A6 surgical recovery ran
#   UPGRADE_COMPLETE                               when Phase J in-place upgrade ran
#   INSTALL_COMPLETE                               on full Phase B-H install end-to-end
#   RESULT_OK / RESULT_FAIL                        from verify-gbrain-mcp.py at H
#
# Phases:
#   A  pre-flight (backup + key checks + disk ≥10GB + 5-invariant idempotency early-exit)
#   A6 bearer-mismatch surgical recovery (Rule 58 — preserves brain, no wipe)
#   J  in-place version upgrade (preserves brain.pglite) — triggers when EXISTING
#      version differs from GBRAIN_PINNED_VERSION AND brain has data. Skips B-H.
#      Has full rollback path on failure. New 2026-05-19 for v0.35→v0.36 upgrades.
#   B  install Bun (with unzip prereq) [preserved from stdio era — FRESH install only]
#   C  clone gbrain to ~/gbrain (CANONICAL path per Garry's INSTALL_FOR_AGENTS.md)
#   C2 apply instaclaw patches (checkpoint MCP tool — CLAUDE.md Rule 54)
#   D  bun install + bun link + 4-segment version verify
#   E  PGLite fresh init + bearer token mint + systemd unit + sidecar start (WIPES brain)
#   F  HTTP smoke test (/health, /mcp initialize+tools/list with bearer, ext-IP refusal)
#   G  wire openclaw mcp set gbrain (streamable-http) + verify-after-set + hot-reload + gateway health
#   H  real round-trip via verify-gbrain-mcp.py (HTTP harness) — the load-bearing gate
#   I  install CHECKPOINT cron + ExecStop drop-in (CLAUDE.md Rule 54)
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
#  25   FATAL_BEARER_SYNC_* (FAILED / VERIFY_FAILED / GATEWAY_UNHEALTHY)
#       — Phase A surgical recovery path (BEARER_MISMATCH_DETECTED) ran but failed.
#       See "Phase A6: bearer-mismatch surgical recovery" below for details.
#  26   FATAL_UPGRADE_PRECHECK_FAILED, FATAL_UPGRADE_BACKUP_FAILED
#       — Phase J: pre-flight or brain backup failed before any state change.
#  27   FATAL_UPGRADE_CHECKOUT_FAILED — Phase J: git checkout of target commit failed.
#  28   FATAL_UPGRADE_BUN_FAILED — Phase J: bun install failed on new version.
#  29   FATAL_UPGRADE_NO_PATCH — Phase J: patch file not co-deployed.
#  30   FATAL_UPGRADE_PATCH_INCOMPATIBLE — Phase J: patch doesn't apply to new operations.ts;
#       needs rebase. Rollback to old version executed automatically.
#  31   FATAL_UPGRADE_PATCH_APPLY_FAILED — Phase J: patch --check passed but apply or verify failed.
#  32   FATAL_UPGRADE_FAILED — Phase J: new gbrain didn't reach healthy /health=200.
#       Rollback executed; check rollback_health for current state.
#  33   FATAL_UPGRADE_VERSION_MISMATCH — Phase J: post-restart gbrain reports unexpected version.
#  34   FATAL_UPGRADE_VERIFY_PUT_PAGE_FAILED — Phase J: write round-trip failed
#       post-upgrade. Likely embedding-config issue. NO auto-rollback; operator investigates.
#  35   FATAL_PHASE_I_NO_CRON_SCRIPT — Phase I: pglite-checkpoint.sh not co-deployed.
#       Was a WARN until 2026-05-20 canary surfaced 15/15 VMs missing the checkpoint
#       cron + ExecStop drop-in because the TS reconciler didn't upload the cron
#       script. Now HARD-FAIL so reconciler sees the error + retries.
#  36   FATAL_PHASE_C2_NO_PATCH_FILE — Phase C2: 0001-add-checkpoint-mcp-tool.patch
#       not co-deployed. Was a WARN until 2026-05-20 canary surfaced 15/15 VMs missing
#       src/core/checkpoint-operation.ts → MCP `checkpoint` tool absent → cron's
#       call to it fails. Now HARD-FAIL.
#  37   FATAL_PHASE_C2_PATCH_{APPLY,CHECK,VERIFY}_FAILED — Phase C2: patch found and
#       co-deployed but the actual `git apply` failed, OR `git apply --check` failed
#       even after self-heal of half-applied state. Was a WARN-and-continue branch
#       until 2026-05-21 vm-517/602/634 incident — three VMs landed in half-applied
#       state (file present, import missing) after Phase B's `git checkout -- .`
#       reset operations.ts but left untracked checkpoint-operation.ts in place.
#       Phase C2 now self-heals half-applied state (delete orphan file, re-apply
#       patch cleanly) AND hard-fails on any remaining apply failure so the
#       reconciler doesn't mark install successful with a missing CHECKPOINT tool.
#
# Co-deployed file requirement (ALL must be uploaded by the TS wrapper alongside
# this script, available at /tmp/<basename> at exec time — checked at each phase):
#   verify-gbrain-mcp.py                          — Phase H gate (FATAL_VERIFY_PY_MISSING)
#   pglite-checkpoint.sh                          — Phase I cron + ExecStop (FATAL_PHASE_I_NO_CRON_SCRIPT)
#   0001-add-checkpoint-mcp-tool.patch            — Phase C2 patch (FATAL_PHASE_C2_NO_PATCH_FILE)
# Each phase refuses to silently skip when its co-deployed file is missing.
#
# Usage (from TS wrapper or stepGbrain reconciler step):
#   GBRAIN_PINNED_COMMIT=1d5f69f GBRAIN_PINNED_VERSION=0.36.3.0 bash install-gbrain.sh

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

# A5: idempotency check — FIVE-state HTTP sidecar invariants (Rule 35 + Rule 58).
#
# All five MUST be true to short-circuit to ALREADY_INSTALLED. Any miss means
# this VM is in a partial/wrong state and we re-install. The fail-open posture
# is intentional (per Cooper's 2026-05-16 review): we'd rather reinstall an
# already-fine VM than skip a half-broken one.
#
# 5th invariant — bearer match across openclaw.json and ~/.gbrain/openclaw-bearer-token.txt —
# was added 2026-05-18 after the vm-050 incident where the legacy STDIO installer
# (pre-2026-05-16-13:08-EDT, no Phase G) left a permanent bearer mismatch. Without
# this 5th check, a partial-completion failure (Phase E succeeds + Phase G fails)
# also leaves a permanent mismatch that never self-heals: Phase A's 4-invariant
# short-circuit declares the VM "fine" while the gateway returns server_error on
# every gbrain MCP call. The bearer-match invariant + the A6 surgical recovery
# path below close that gap.
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
# Bearer cross-consumer match — added 2026-05-18 per Rule 58.
# Read both consumers (disk file + openclaw.json) and compare. The disk file is
# the source of truth (it's what was written at mint time and what gbrain hashes
# into access_tokens); openclaw.json is what the gateway sends. They MUST match
# for the gateway to authenticate. `2>/dev/null` on each so missing files yield
# empty strings (which won't match any non-empty bearer — clean fall-through).
EXISTING_DISK_BEARER=$(cat "$HOME/.gbrain/openclaw-bearer-token.txt" 2>/dev/null || echo "")
EXISTING_GW_BEARER=$(jq -r '.mcp.servers.gbrain.headers.Authorization // ""' "$HOME/.openclaw/openclaw.json" 2>/dev/null | sed 's/^Bearer //')

if [ "$EXISTING_VERSION" = "$GBRAIN_PINNED_VERSION" ] && \
   [ "$EXISTING_TRANSPORT" = "streamable-http" ] && \
   [ "$EXISTING_SERVICE" = "active" ] && \
   [ "$EXISTING_PORT" = "1" ] && \
   [ -n "$EXISTING_DISK_BEARER" ] && \
   [ "$EXISTING_DISK_BEARER" = "$EXISTING_GW_BEARER" ]; then
  echo "ALREADY_INSTALLED version=$EXISTING_VERSION transport=streamable-http service=active port=loopback bearer=synced"
  exit 0
fi

# ─── A6: bearer-mismatch surgical recovery (Rule 58, vm-050 class) ───
#
# Triggers when the first 4 invariants pass but the bearer-match (5th invariant)
# fails. The VM is otherwise healthy — gbrain.service is up at the correct
# version, transport is correctly streamable-http, port is bound to loopback —
# but openclaw.json's bearer header doesn't match the on-disk bearer file.
#
# Three known root causes:
#   1. LEGACY: STDIO-era install (pre-2026-05-16 13:08 EDT) didn't run Phase G,
#      so openclaw.json kept its old bearer while ~/.gbrain/openclaw-bearer-token.txt
#      held a freshly-minted post-wipe value. This is what bit vm-050 on
#      2026-05-18 — see incident notes for forensic timeline.
#   2. PARTIAL: A previous install completed Phase E (mint + INSERT to
#      access_tokens) but failed/timed-out before Phase G (openclaw mcp set).
#      Leaves disk+access_tokens with NEW bearer, openclaw.json with OLD bearer.
#   3. DRIFT: openclaw.json was hand-edited or rewritten by another script that
#      didn't sync to the on-disk bearer.
#
# Recovery action: rewrite ONLY the Authorization header in openclaw.json via
# `openclaw config set` (atomic merge, leaves all other fields untouched).
# Restart the gateway — `mcp.servers.*` IS hot-reloadable per Rule 32, but the
# MCP HTTP client was constructed at gateway startup with the stale bearer;
# hot-reload alone updates config-in-memory but does NOT rebuild the client.
# Empirically verified on vm-050 2026-05-18.
#
# Does NOT wipe the brain — preserves PGLite contents, access_tokens (which
# already has the disk bearer's hash), user memory. This is the critical
# difference from "full reinstall via Phase B-H".
#
# All failure paths exit with code 25 (FATAL_BEARER_SYNC_*) so the operator
# can distinguish bearer-sync failures from full-install failures.
if [ "$EXISTING_VERSION" = "$GBRAIN_PINNED_VERSION" ] && \
   [ "$EXISTING_TRANSPORT" = "streamable-http" ] && \
   [ "$EXISTING_SERVICE" = "active" ] && \
   [ "$EXISTING_PORT" = "1" ] && \
   [ -n "$EXISTING_DISK_BEARER" ] && \
   [ "$EXISTING_DISK_BEARER" != "$EXISTING_GW_BEARER" ]; then
  echo "BEARER_MISMATCH_DETECTED disk_pfx=${EXISTING_DISK_BEARER:0:14}... gw_pfx=${EXISTING_GW_BEARER:0:14}..."

  # Atomic merge — only touches the Authorization leaf, doesn't touch transport,
  # url, connectionTimeoutMs, or anything outside the gbrain MCP entry.
  openclaw config set "mcp.servers.gbrain.headers.Authorization" "Bearer $EXISTING_DISK_BEARER" 2>&1 | tail -3
  SYNC_RC=$?
  if [ "$SYNC_RC" -ne 0 ]; then
    echo "FATAL_BEARER_SYNC_FAILED rc=$SYNC_RC"
    exit 25
  fi

  # Verify-after-set (Rule 10) — re-read disk to confirm the write landed.
  SYNCED_GW_BEARER=$(jq -r '.mcp.servers.gbrain.headers.Authorization // ""' "$HOME/.openclaw/openclaw.json" 2>/dev/null | sed 's/^Bearer //')
  if [ "$SYNCED_GW_BEARER" != "$EXISTING_DISK_BEARER" ]; then
    echo "FATAL_BEARER_SYNC_VERIFY_FAILED expected_pfx=${EXISTING_DISK_BEARER:0:14}... got_pfx=${SYNCED_GW_BEARER:0:14}..."
    exit 25
  fi

  # Gateway restart — required to rebuild the MCP HTTP client with the new
  # bearer. Hot-reload alone is INSUFFICIENT for header changes (empirical:
  # vm-050 2026-05-18 — config hot reload event fires, openclaw CLI explicitly
  # prints "Restart the gateway to apply", subsequent gbrain MCP calls still
  # fail with the old bearer until restart).
  echo "  restarting openclaw-gateway to rebuild MCP HTTP client..."
  systemctl --user restart openclaw-gateway 2>&1 | tail -3

  # Rule 5: verify gateway came back active + /health=200 within 30s. Six
  # iterations × 5s = 30s. If it never reaches health=200, the bearer sync
  # itself is correctly persisted on disk but the gateway is unhealthy for
  # some other reason (which subsequent reconcile steps will pick up).
  GW_HEALTHY=0
  for i in 1 2 3 4 5 6; do
    sleep 5
    GW_HEALTH=$(curl -sf -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:18789/health 2>/dev/null)
    if [ "$GW_HEALTH" = "200" ]; then
      GW_HEALTHY=1
      break
    fi
  done
  if [ "$GW_HEALTHY" != "1" ]; then
    echo "FATAL_BEARER_SYNC_GATEWAY_UNHEALTHY final_health=$GW_HEALTH"
    exit 25
  fi

  echo "BEARER_SYNCED disk_pfx=${EXISTING_DISK_BEARER:0:14}... gw_pfx=${SYNCED_GW_BEARER:0:14}... gw_health=$GW_HEALTH (brain preserved, no wipe)"
  exit 0
fi

echo "PHASE_A_OK backup=$TARBALL disk_avail_kb=$DISK_AVAIL_KB existing: V=$EXISTING_VERSION T=$EXISTING_TRANSPORT S=$EXISTING_SERVICE P=$EXISTING_PORT bearer_disk=${EXISTING_DISK_BEARER:0:14}... bearer_gw=${EXISTING_GW_BEARER:0:14}..."

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE J: in-place version upgrade (preserves brain.pglite)
# ═══════════════════════════════════════════════════════════════════════════════
#
# Triggers when an EXISTING gbrain install needs to move to a different
# GBRAIN_PINNED_COMMIT/VERSION without losing user data. Distinct from the
# Phase B-H fresh-install path (which wipes brain.pglite in Phase E2).
#
# Trigger conditions (all three must hold):
#   - EXISTING_VERSION != "missing"           (gbrain is installed at some version)
#   - EXISTING_VERSION != GBRAIN_PINNED_VERSION  (a different version than target)
#   - brain.pglite/PG_VERSION exists   (real brain with data, not stub)
#
# If ANY of those fail → fall through to Phase B-H (fresh install/wipe path).
#
# Procedure (numbered for matching to rollback path):
#   J1.  pre-flight: ensure gbrain.service is active
#   J2.  force CHECKPOINT via MCP (bound pg_control freshness for safe restart)
#   J3.  backup brain.pglite to ~/.gbrain/brain.pglite.pre-upgrade-<ts>.tar.gz
#   J4.  save OLD_HEAD for rollback + record pre-upgrade page_count for verify
#   J5.  stop gbrain.service cleanly (ExecStop fires another CHECKPOINT)
#   J6.  revert patch (git checkout -- operations.ts + rm checkpoint-operation.ts)
#   J7.  git fetch + checkout target commit
#   J8.  bun install (postinstall apply-migrations runs against the brain)
#   J9.  reapply patch (git apply --check first; on fail → ROLLBACK)
#   J10. write/update GBRAIN_EMBEDDING_DIMENSIONS=1536 drop-in (idempotent)
#   J11. start gbrain.service
#   J12. verify: /health 200, version matches target, put_page round-trip works
#
# Rollback triggers (any of):
#   - patch --check fails on new commit (J9)
#   - gbrain doesn't come healthy on new version (J11)
#   - put_page round-trip fails (J12)
#
# Rollback procedure:
#   R1. stop gbrain (clean if alive, SIGKILL if crash-looping)
#   R2. git checkout OLD_HEAD
#   R3. bun install (back to old deps)
#   R4. reapply patch (same patch — works idempotently on old version)
#   R5. start gbrain
#   R6. verify /health 200
#   R7. if still failing: restore brain.pglite from pre-upgrade tarball + retry
#   R8. emit FATAL_UPGRADE_FAILED with rollback outcome
#
# Detection — only run Phase J under the right conditions.
NEED_UPGRADE=0
if [ "$EXISTING_VERSION" != "missing" ] && \
   [ "$EXISTING_VERSION" != "$GBRAIN_PINNED_VERSION" ] && \
   [ -f "$HOME/.gbrain/brain.pglite/PG_VERSION" ]; then
  NEED_UPGRADE=1
fi

if [ "$NEED_UPGRADE" = "1" ]; then
  echo "PHASE_J_START existing=$EXISTING_VERSION target=$GBRAIN_PINNED_VERSION arch=in-place-upgrade"

  # ─── J1: pre-flight — gbrain.service must be active for CHECKPOINT to work ───
  if [ "$EXISTING_SERVICE" != "active" ]; then
    echo "  J1: gbrain.service not active (state=$EXISTING_SERVICE); attempting start..."
    systemctl --user start gbrain.service 2>&1
    sleep 5
    NEW_STATE=$(systemctl --user is-active gbrain.service 2>&1)
    if [ "$NEW_STATE" != "active" ]; then
      echo "FATAL_UPGRADE_PRECHECK_FAILED state=$NEW_STATE — service won't start, can't CHECKPOINT cleanly"
      echo "  hint: this VM may need pg_resetwal recovery before any upgrade attempt"
      exit 26
    fi
  fi

  # ─── J2: force CHECKPOINT to bound pg_control staleness ───
  J_BEARER=$(cat "$HOME/.gbrain/openclaw-bearer-token.txt" 2>/dev/null)
  if [ -z "$J_BEARER" ]; then
    echo "FATAL_UPGRADE_PRECHECK_FAILED no_bearer — can't call CHECKPOINT MCP"
    exit 26
  fi
  J_CHECKPOINT_RESP=$(curl -sS -X POST http://127.0.0.1:3131/mcp \
    -H "Authorization: Bearer $J_BEARER" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json,text/event-stream" \
    --max-time 30 \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"checkpoint","arguments":{}}}' 2>&1)
  if echo "$J_CHECKPOINT_RESP" | grep -qF '\"ok\": true'; then
    echo "  J2: CHECKPOINT ok (pg_control fresh)"
  else
    echo "  J2: WARN CHECKPOINT did not succeed; tail=$(echo "$J_CHECKPOINT_RESP" | head -c 150)"
    echo "  hint: gbrain may be at older version without checkpoint MCP tool — proceeding anyway"
  fi

  # ─── J3: backup brain.pglite (tarball, rotated retention) ───
  J_BACKUP="$HOME/.gbrain/brain.pglite.pre-upgrade-$TS.tar.gz"
  tar czf "$J_BACKUP" -C "$HOME/.gbrain" brain.pglite 2>/dev/null
  if [ ! -s "$J_BACKUP" ]; then
    echo "FATAL_UPGRADE_BACKUP_FAILED path=$J_BACKUP"
    exit 26
  fi
  J_BACKUP_SIZE=$(du -h "$J_BACKUP" | cut -f1)
  echo "  J3: backup=$J_BACKUP size=$J_BACKUP_SIZE"
  # Rotation: keep 3 most recent pre-upgrade backups
  ls -t "$HOME/.gbrain"/brain.pglite.pre-upgrade-*.tar.gz 2>/dev/null | tail -n +4 | xargs -r rm -f

  # ─── J4: snapshot OLD_HEAD + pre-upgrade stats for rollback + verify ───
  cd "$HOME/gbrain"
  OLD_HEAD=$(git rev-parse HEAD)
  echo "  J4: old_head=$OLD_HEAD"
  # page_count via MCP (for post-upgrade integrity check)
  J_STATS=$(curl -sS -X POST http://127.0.0.1:3131/mcp \
    -H "Authorization: Bearer $J_BEARER" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json,text/event-stream" \
    --max-time 15 \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_stats","arguments":{}}}' 2>&1)
  PAGE_COUNT_PRE=$(echo "$J_STATS" | grep -oE '\\"page_count\\": *[0-9]+' | grep -oE '[0-9]+' | head -1)
  PAGE_COUNT_PRE=${PAGE_COUNT_PRE:-unknown}
  echo "  J4: page_count_pre=$PAGE_COUNT_PRE"

  # ─── J5: stop gbrain cleanly (ExecStop fires CHECKPOINT, then SIGKILL) ───
  systemctl --user stop gbrain.service 2>&1
  sleep 3
  systemctl --user reset-failed gbrain.service 2>&1 > /dev/null
  echo "  J5: stopped (state=$(systemctl --user is-active gbrain.service))"

  # ─── J6: revert patch — clean working tree for git operations ───
  git checkout -- src/core/operations.ts 2>&1 | tail -2
  rm -f src/core/checkpoint-operation.ts
  J_STATUS=$(git status --short)
  if [ -n "$J_STATUS" ]; then
    echo "  J6: WARN working tree not clean post-revert: $J_STATUS"
    # Force clean — discard any other working-tree changes that aren't ours
    git checkout -- . 2>&1 | tail -2
  fi
  echo "  J6: patch reverted, working tree clean"

  # ─── J7: git fetch + checkout target commit ───
  git fetch origin 2>&1 | tail -3
  git checkout "$GBRAIN_PINNED_COMMIT" 2>&1 | tail -3
  # Use full SHA and compare first-7 of both sides — already-correct pattern
  # since J was authored (2026-05-19), but adding empty-value defensive checks
  # to match the strengthened Phase C verify (line ~703). Empty J_NEW_HEAD =
  # git rev-parse failed; empty GBRAIN_PINNED_COMMIT = env var not passed.
  J_NEW_HEAD=$(git rev-parse HEAD 2>/dev/null)
  if [ -z "$J_NEW_HEAD" ] || [ -z "$GBRAIN_PINNED_COMMIT" ] || \
     [ "${J_NEW_HEAD:0:7}" != "${GBRAIN_PINNED_COMMIT:0:7}" ]; then
    echo "FATAL_UPGRADE_CHECKOUT_FAILED expected=$GBRAIN_PINNED_COMMIT got=$J_NEW_HEAD"
    # ROLLBACK to OLD_HEAD
    git checkout "$OLD_HEAD" 2>&1 | tail -2
    bun install 2>&1 | tail -3 > /dev/null
    # Reapply patch on old version
    PATCH_FILE_R=""
    for c in "/tmp/0001-add-checkpoint-mcp-tool.patch" "$(dirname "${BASH_SOURCE[0]}")/gbrain-patches/0001-add-checkpoint-mcp-tool.patch"; do
      [ -s "$c" ] && PATCH_FILE_R="$c" && break
    done
    [ -n "$PATCH_FILE_R" ] && git apply "$PATCH_FILE_R" 2>&1 | tail -2
    systemctl --user start gbrain.service 2>&1
    exit 27
  fi
  echo "  J7: checked out $J_NEW_HEAD"

  # ─── J8: bun install (apply-migrations runs against brain) ───
  echo "  J8: bun install..."
  J_BUN_OUT=$(timeout 300 bun install 2>&1 | tail -10)
  J_BUN_RC=${PIPESTATUS[0]}
  echo "$J_BUN_OUT"
  if [ "$J_BUN_RC" -ne 0 ]; then
    echo "FATAL_UPGRADE_BUN_FAILED rc=$J_BUN_RC — rolling back"
    git checkout "$OLD_HEAD" 2>&1 | tail -2
    bun install 2>&1 | tail -3 > /dev/null
    systemctl --user start gbrain.service 2>&1
    exit 28
  fi

  # ─── J9: reapply patch (--check first, ROLLBACK if fails) ───
  PATCH_FILE_J=""
  for c in "/tmp/0001-add-checkpoint-mcp-tool.patch" "$(dirname "${BASH_SOURCE[0]}")/gbrain-patches/0001-add-checkpoint-mcp-tool.patch"; do
    [ -s "$c" ] && PATCH_FILE_J="$c" && break
  done
  if [ -z "$PATCH_FILE_J" ]; then
    echo "FATAL_UPGRADE_NO_PATCH — rolling back"
    git checkout "$OLD_HEAD" 2>&1 | tail -2
    bun install 2>&1 | tail -3 > /dev/null
    systemctl --user start gbrain.service 2>&1
    exit 29
  fi
  if ! git apply --check "$PATCH_FILE_J" 2>&1; then
    echo "FATAL_UPGRADE_PATCH_INCOMPATIBLE — patch needs rebase against $GBRAIN_PINNED_VERSION operations.ts; rolling back"
    git checkout "$OLD_HEAD" 2>&1 | tail -2
    bun install 2>&1 | tail -3 > /dev/null
    git apply "$PATCH_FILE_J" 2>&1 | tail -3
    systemctl --user start gbrain.service 2>&1
    exit 30
  fi
  git apply --verbose "$PATCH_FILE_J" 2>&1 | tail -5
  J_APPLY_RC=${PIPESTATUS[0]}
  # Verify-after-apply per Rule 58 discipline
  J_HAS_FILE=$([ -f src/core/checkpoint-operation.ts ] && echo 1 || echo 0)
  J_HAS_IMPORT=$(grep -c "import { checkpoint } from " src/core/operations.ts)
  if [ "$J_APPLY_RC" -ne 0 ] || [ "$J_HAS_FILE" != "1" ] || [ "$J_HAS_IMPORT" != "1" ]; then
    echo "FATAL_UPGRADE_PATCH_APPLY_FAILED rc=$J_APPLY_RC file=$J_HAS_FILE import=$J_HAS_IMPORT — rolling back"
    git checkout -- src/core/operations.ts 2>&1 | tail -2
    rm -f src/core/checkpoint-operation.ts
    git checkout "$OLD_HEAD" 2>&1 | tail -2
    bun install 2>&1 | tail -3 > /dev/null
    git apply "$PATCH_FILE_J" 2>&1 | tail -3
    systemctl --user start gbrain.service 2>&1
    exit 31
  fi
  echo "  J9: patch reapplied cleanly"

  # ─── J10: write/update GBRAIN_EMBEDDING_DIMENSIONS=1536 drop-in (idempotent) ───
  J_DIMS_DROPIN="$HOME/.config/systemd/user/gbrain.service.d/30-embedding-dimensions.conf"
  mkdir -p "$(dirname "$J_DIMS_DROPIN")"
  cat > "$J_DIMS_DROPIN" <<EOF
# v0.36.x requires GBRAIN_EMBEDDING_DIMENSIONS env var alongside GBRAIN_EMBEDDING_MODEL.
# Without it, gateway.ts falls back to DEFAULT_EMBEDDING_DIMENSIONS=1280 (ZE zembed-1
# default), producing 1280-dim vectors that mismatch PGLite's 1536-dim 'embedding'
# column. Written by install-gbrain.sh Phase J during in-place upgrade.
[Service]
Environment=GBRAIN_EMBEDDING_DIMENSIONS=1536
EOF
  systemctl --user daemon-reload 2>&1
  echo "  J10: dims drop-in written; effective env includes:"
  systemctl --user show gbrain.service --property=Environment --value | tr ',' '\n' | grep -E "EMBEDDING" | sed 's/^/    /'

  # ─── J11: start gbrain.service on new version ───
  systemctl --user start gbrain.service 2>&1
  J_HEALTHY=0
  for i in $(seq 1 30); do
    HTTP=$(curl -sf -o /tmp/_j_health.json -w "%{http_code}" --max-time 2 http://127.0.0.1:3131/health 2>/dev/null)
    STATE=$(systemctl --user is-active gbrain.service)
    NR=$(systemctl --user show gbrain.service --property=NRestarts --value)
    if [ "$HTTP" = "200" ] && [ "$STATE" = "active" ]; then
      J_HEALTHY=1
      echo "  J11: ready after $((i*2))s (NRestarts=$NR)"
      break
    fi
    if [ "$NR" -gt 5 ] 2>/dev/null; then
      echo "  J11: CRASH LOOP NRestarts=$NR"
      break
    fi
    sleep 2
  done

  if [ "$J_HEALTHY" != "1" ]; then
    echo "FATAL_UPGRADE_START_FAILED — rolling back to $OLD_HEAD"
    systemctl --user stop gbrain.service 2>&1
    systemctl --user reset-failed gbrain.service 2>&1
    git checkout -- src/core/operations.ts 2>&1 | tail -2
    rm -f src/core/checkpoint-operation.ts
    git checkout "$OLD_HEAD" 2>&1 | tail -2
    bun install 2>&1 | tail -3 > /dev/null
    git apply "$PATCH_FILE_J" 2>&1 | tail -3
    # If brain was corrupted, restore from backup
    systemctl --user start gbrain.service
    sleep 5
    H_BACK=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:3131/health 2>/dev/null)
    if [ "$H_BACK" != "200" ]; then
      echo "  rollback start failed; restoring brain from tarball $J_BACKUP"
      systemctl --user stop gbrain.service 2>&1
      mv "$HOME/.gbrain/brain.pglite" "$HOME/.gbrain/brain.pglite.upgrade-failure-$TS"
      tar xzf "$J_BACKUP" -C "$HOME/.gbrain"
      systemctl --user start gbrain.service
      sleep 5
      H_BACK=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:3131/health 2>/dev/null)
    fi
    echo "FATAL_UPGRADE_FAILED rollback_health=$H_BACK"
    exit 32
  fi

  # ─── J12: verify version + put_page round-trip ───
  J_NEW_VER=$(gbrain --version 2>&1 | head -1)
  if ! echo "$J_NEW_VER" | grep -qF "$GBRAIN_PINNED_VERSION"; then
    echo "FATAL_UPGRADE_VERSION_MISMATCH expected=$GBRAIN_PINNED_VERSION got=$J_NEW_VER"
    exit 33
  fi
  # Slug must be lowercase + hyphens + digits per v0.36's validatePageSlug.
  # $TS uses YYYYMMDDTHHMMSSZ format which contains uppercase T/Z — invalid.
  # Use epoch seconds for an all-numeric slug suffix.
  J_TEST_SLUG="upgrade-verify-$(date -u +%s)"
  J_VERIFY=$(curl -sS -X POST http://127.0.0.1:3131/mcp \
    -H "Authorization: Bearer $J_BEARER" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json,text/event-stream" \
    --max-time 30 \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"put_page\",\"arguments\":{\"slug\":\"$J_TEST_SLUG\",\"content\":\"Upgrade verification page for Phase J on $TS.\"}}}" 2>&1)
  if ! echo "$J_VERIFY" | grep -qF "created_or_updated"; then
    echo "FATAL_UPGRADE_VERIFY_PUT_PAGE_FAILED — embedding dim mismatch or other write failure"
    echo "  response tail: $(echo "$J_VERIFY" | head -c 300)"
    # Don't auto-rollback — operator should investigate. The upgrade left state that
    # NEEDS attention but the brain is preserved via backup.
    exit 34
  fi

  # Verify page_count survived (or grew by 1 from the verify page)
  J_STATS_POST=$(curl -sS -X POST http://127.0.0.1:3131/mcp \
    -H "Authorization: Bearer $J_BEARER" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json,text/event-stream" \
    --max-time 15 \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_stats","arguments":{}}}' 2>&1)
  PAGE_COUNT_POST=$(echo "$J_STATS_POST" | grep -oE '\\"page_count\\": *[0-9]+' | grep -oE '[0-9]+' | head -1)
  echo "  J12: page_count pre=$PAGE_COUNT_PRE post=$PAGE_COUNT_POST"

  echo "UPGRADE_COMPLETE old=$EXISTING_VERSION new=$GBRAIN_PINNED_VERSION old_head=$OLD_HEAD new_head=$J_NEW_HEAD page_count=$PAGE_COUNT_POST backup=$J_BACKUP"

  # Phase J is a complete-install-equivalent — skip the Phase B-H fresh-install path.
  # The cron + ExecStop drop-ins should already be in place from prior install or
  # Phase I from a prior install-gbrain.sh run; Phase J doesn't re-install them
  # since they're orthogonal to the version upgrade. If they need re-deploying,
  # operator runs install-gbrain.sh again and Phase A's idempotency check passes.
  exit 0
fi

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE B: install Bun (PINNED to BUN_PINNED_VERSION)
#
# 2026-05-20: pinned to v1.3.13 after bun 1.3.14 regression broke module
# resolution for `bun run /tmp/script.ts` (cwd-based resolution stopped
# walking up from the script's directory to find node_modules). vm-602,
# vm-634 quarantined with `stepGbrain: TOKEN_MINT_FAILED rc=1` because
# Phase E's mint script (written to /tmp/) couldn't resolve
# @electric-sql/pglite from cwd ~/gbrain. All 9 working edge_city VMs
# have 1.3.13 (installed pre-regression on 2026-05-16). Pinning here
# closes the regression vector for new installs AND auto-heals existing
# VMs via the version-drift detection block below.
#
# Version-drift handling: if bun is already installed at a different
# version, reinstall the pinned version. This is the only way to fix
# the 3 quarantined VMs that already have 1.3.14 — Phase B used to be
# strictly idempotent on `command -v bun` presence, which meant a wrong
# version stayed wrong forever.
#
# To bump: change BUN_PINNED_VERSION here. The post-install verify
# block will fail loud if the bun installer ignored the pin (e.g.,
# upstream installer changed argument shape). Reviewers should re-test
# `bun run /tmp/file.ts` cwd-resolution on the new version before
# bumping — same test that surfaced this regression.
# ═══════════════════════════════════════════════════════════════════════════════
BUN_PINNED_VERSION="1.3.13"
echo "PHASE_B_START"
NEEDS_BUN_INSTALL=0
if ! command -v bun > /dev/null 2>&1; then
  NEEDS_BUN_INSTALL=1
  echo "  bun not installed — installing pinned v$BUN_PINNED_VERSION"
else
  CURRENT_BUN=$(bun --version 2>/dev/null)
  if [ "$CURRENT_BUN" != "$BUN_PINNED_VERSION" ]; then
    NEEDS_BUN_INSTALL=1
    echo "  bun version drift: current=$CURRENT_BUN expected=$BUN_PINNED_VERSION — reinstalling pinned"
  fi
fi
if [ "$NEEDS_BUN_INSTALL" = "1" ]; then
  if ! command -v unzip > /dev/null 2>&1; then
    sudo apt-get install -y -qq unzip 2>&1 | tail -3
    if ! command -v unzip > /dev/null 2>&1; then
      echo "FATAL_NO_UNZIP_NO_SUDO"
      exit 3
    fi
  fi
  curl -fsSL https://bun.sh/install | bash -s "bun-v$BUN_PINNED_VERSION" 2>&1 | tail -5
  export PATH="$HOME/.bun/bin:$PATH"
  if ! command -v bun > /dev/null 2>&1; then
    echo "FATAL_BUN_INSTALL_FAILED"
    exit 3
  fi
fi
BUN_VERSION=$(bun --version)
# Post-install verify: bun installer must have honored the pin. If not, this
# is a Rule 10 / Rule 23 territory — fail loud rather than silently shipping
# the wrong version and re-hitting the 1.3.14 regression on first install.
if [ "$BUN_VERSION" != "$BUN_PINNED_VERSION" ]; then
  echo "FATAL_BUN_INSTALL_FAILED version_mismatch expected=$BUN_PINNED_VERSION got=$BUN_VERSION"
  echo "  bun installer (https://bun.sh/install) may have changed its version-pin argument shape."
  exit 3
fi
echo "PHASE_B_OK bun=$BUN_VERSION (pinned)"

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
# Use full SHA via `git rev-parse HEAD` (not --short) so length is deterministic
# at 40 chars, then compare first-7 of both sides. This mirrors Phase J's
# verify pattern at line 471 and fixes the 2026-05-19 SHA-length-comparison
# bug: as the gbrain repo grows, `git rev-parse --short` auto-extends short
# SHAs to disambiguate (1d5f69f → 1d5f69fe), so naive string equality fails
# despite both refs pointing to the same commit. Empty values are caught
# defensively — an empty VERIFY_HEAD means git rev-parse failed, an empty
# GBRAIN_PINNED_COMMIT means the env var wasn't passed in.
VERIFY_HEAD=$(git rev-parse HEAD 2>/dev/null)
# Pinning verify — Rule 35 / May-12 PRD §5.7 (don't float on master,
# operator manually bumps after canary validation).
if [ -z "$VERIFY_HEAD" ] || [ -z "$GBRAIN_PINNED_COMMIT" ] || \
   [ "${VERIFY_HEAD:0:7}" != "${GBRAIN_PINNED_COMMIT:0:7}" ]; then
  echo "FATAL_CHECKOUT_DRIFT verify=$VERIFY_HEAD expected=$GBRAIN_PINNED_COMMIT"
  # Don't rm -rf here — operator may want the partial state for forensics.
  exit 5
fi
echo "PHASE_C_OK head=${VERIFY_HEAD:0:7} path=$HOME/gbrain"

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE C2: apply instaclaw patches (CLAUDE.md Rule 54 / Rule 58)
# ═══════════════════════════════════════════════════════════════════════════════
#
# After git checkout, before bun install, apply our local patches on top of
# garry's unmodified source. Currently one patch:
#
#   0001-add-checkpoint-mcp-tool.patch — adds a `checkpoint` MCP admin tool
#     that runs PGLite CHECKPOINT. Required to prevent the pg_control-staleness
#     bug documented in Rule 54 (vm-050 incident 2026-05-18). Once upstream
#     gbrain merges the equivalent PR, this patch becomes a no-op and we
#     remove this Phase C2 block.
#
# Patch file is co-deployed alongside install-gbrain.sh by the TS wrapper
# (similar to verify-gbrain-mcp.py). If absent, the install proceeds without
# the patch — operator will see the missing CHECKPOINT tool downstream and
# can re-run.
echo "PHASE_C2_START"
PATCH_FILE=""
for candidate in \
    "/tmp/0001-add-checkpoint-mcp-tool.patch" \
    "/tmp/checkpoint-patch.patch" \
    "$(dirname "${BASH_SOURCE[0]}")/gbrain-patches/0001-add-checkpoint-mcp-tool.patch"; do
  if [ -s "$candidate" ]; then PATCH_FILE="$candidate"; break; fi
done

if [ -z "$PATCH_FILE" ]; then
  # HARD FAIL (2026-05-20): was WARN until canary surfaced 15/15 VMs missing
  # src/core/checkpoint-operation.ts because the TS reconciler didn't upload
  # the patch file. Silent degradation here was the upstream cause of every
  # subsequent CHECKPOINT-tool call failing. Now require the patch to be
  # present so the reconciler retries instead of marking install successful.
  echo "FATAL_PHASE_C2_NO_PATCH_FILE — 0001-add-checkpoint-mcp-tool.patch not co-deployed."
  echo "  hint: TS wrapper must SFTP 0001-add-checkpoint-mcp-tool.patch to /tmp/ alongside install-gbrain.sh"
  exit 36
else
  cd "$HOME/gbrain"
  # Idempotency: verify BOTH halves of the patch are applied, not just one half.
  # The patch adds (a) src/core/checkpoint-operation.ts (new file), and
  # (b) an import line in src/core/operations.ts. If only (a) is present and
  # (b) was reverted by an upstream pull, we'd be in a half-applied state
  # that compiles but the Operation never registers. Check BOTH.
  HAS_FILE=0
  HAS_IMPORT=0
  [ -f "$HOME/gbrain/src/core/checkpoint-operation.ts" ] && HAS_FILE=1
  grep -q "import { checkpoint } from './checkpoint-operation.ts'" "$HOME/gbrain/src/core/operations.ts" 2>/dev/null && HAS_IMPORT=1

  if [ "$HAS_FILE" = "1" ] && [ "$HAS_IMPORT" = "1" ]; then
    echo "PHASE_C2_OK patch_already_applied (file=$HAS_FILE import=$HAS_IMPORT, idempotent)"
  else
    # SELF-HEAL HALF-APPLIED STATE (2026-05-21 vm-517 / vm-602 / vm-634 incident):
    # When Phase B's `git checkout -- .` resets tracked operations.ts but leaves
    # untracked checkpoint-operation.ts in place, we land in HAS_FILE=1 +
    # HAS_IMPORT=0 — the "half-applied" state. `git apply --check` then fails
    # because the patch tries to ADD a file that exists. Pre-fix the half-applied
    # state by deleting the orphan file so `git apply` can re-apply cleanly.
    # The patch will recreate the file with identical content (it's pinned to a
    # commit; deterministic).
    if [ "$HAS_FILE" = "1" ] && [ "$HAS_IMPORT" = "0" ]; then
      echo "PHASE_C2_HEAL half-applied state detected (file=1 import=0) — deleting orphan file to allow re-apply"
      rm -f "$HOME/gbrain/src/core/checkpoint-operation.ts"
      HAS_FILE=0
    fi

    if git apply --check "$PATCH_FILE" 2>/dev/null; then
      # Clean apply path. Use PIPESTATUS so we capture git apply's exit code,
      # not tail's (which is always 0 unless given a bad arg).
      git apply --verbose "$PATCH_FILE" 2>&1 | tail -3
      APPLY_RC=${PIPESTATUS[0]}
      if [ "$APPLY_RC" -ne 0 ]; then
        # HARD FAIL (2026-05-21): was WARN, but a missing CHECKPOINT tool means
        # the pg_control cron will permanently FAIL with "Unknown: checkpoint",
        # which is the exact bug Rule 54 exists to prevent. Fail loud so the
        # reconciler retries instead of marking install successful.
        echo "FATAL_PHASE_C2_PATCH_APPLY_FAILED rc=$APPLY_RC — operations.ts likely diverged from pinned commit"
        echo "  hint: rebase 0001-add-checkpoint-mcp-tool.patch against current GBRAIN_PINNED_COMMIT"
        exit 37
      fi
      # Verify-after-apply: re-check both halves landed (Rule 10 / Rule 34 discipline).
      [ -f "$HOME/gbrain/src/core/checkpoint-operation.ts" ] && HAS_FILE=1
      grep -q "import { checkpoint } from './checkpoint-operation.ts'" "$HOME/gbrain/src/core/operations.ts" 2>/dev/null && HAS_IMPORT=1
      if [ "$HAS_FILE" = "1" ] && [ "$HAS_IMPORT" = "1" ]; then
        echo "PHASE_C2_OK patch_applied=$(basename "$PATCH_FILE") (file=$HAS_FILE import=$HAS_IMPORT)"
      else
        echo "FATAL_PHASE_C2_VERIFY_FAILED file=$HAS_FILE import=$HAS_IMPORT — apply returned 0 but verify failed"
        exit 37
      fi
    else
      # --check failed AND we're not in half-applied state (self-heal already ran).
      # Real conflict with upstream — patch needs rebase.
      echo "FATAL_PHASE_C2_PATCH_CHECK_FAILED file=$HAS_FILE import=$HAS_IMPORT — patch conflicts with upstream"
      echo "  hint: rebase 0001-add-checkpoint-mcp-tool.patch against current GBRAIN_PINNED_COMMIT"
      exit 37
    fi
  fi
fi

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

# Verify version matches pinning. 4-segment regex (Garry's convention:
# 0.35.0.0, 0.31.4.1) but NOT line-anchored — `gbrain --version` outputs
# "gbrain 0.35.0.0" with the binary name prefix, so a line-anchored
# `^[0-9]+...` would not match. The `(\.[0-9]+){3}` requires exactly 3
# trailing dot-segments, so it still rejects 3-segment legacy versions
# like "0.28.1". (Bug caught on 2026-05-16 live install of vm-354 —
# anchored regex matched zero and FATAL_VERSION_MISMATCH'd despite a
# successful install.)
GBRAIN_INSTALLED_VERSION=$(gbrain --version 2>&1 | head -1 | grep -oE '[0-9]+(\.[0-9]+){3}' | head -1)
[ -z "$GBRAIN_INSTALLED_VERSION" ] && GBRAIN_INSTALLED_VERSION="missing"
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

# Bun module resolution gotcha (2026-05-21 vm-602/634 incident):
# `bun run /tmp/script.ts` cannot resolve bare imports like '@electric-sql/pglite'
# even when CWD is $HOME/gbrain — bun resolves from the SCRIPT's directory, not
# CWD's package.json. The behavior is non-deterministic: it can succeed on VMs
# where bun's global install cache has been "primed" by prior Phase D `bun install`,
# but fails on cold-cache VMs. Placing the mint script INSIDE $HOME/gbrain makes
# bun resolve directly from $HOME/gbrain/node_modules — works deterministically.
# The bunfig.toml in $HOME/gbrain doesn't conflict (we don't run tests).
MINT_TS_PY="$HOME/gbrain/_mint-gbrain-token-$TS.ts"
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
# v0.36.x: BOTH env vars required. Without GBRAIN_EMBEDDING_DIMENSIONS, gateway.ts
# falls back to DEFAULT_EMBEDDING_DIMENSIONS=1280 (ZE zembed-1 default), producing
# 1280-dim vectors via OpenAI Matryoshka truncation that mismatch PGLite's 1536-dim
# 'embedding' column. Bug surfaced on 2026-05-19 vm-050 v0.36.3.0 canary.
Environment=GBRAIN_EMBEDDING_DIMENSIONS=1536
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
#
# CRITICAL: stderr MUST be redirected to /dev/null. Without `2>/dev/null`,
# bash's "bash: connect: Connection refused" error messages get captured
# into EXT_TEST (multi-line string), and the comparison `[ "$EXT_TEST" !=
# "REFUSED" ]` then compares a multi-line stderr-blob to "REFUSED" — never
# equal → false-positive FATAL_SIDECAR_BOUND_PUBLIC. (Bug caught on
# 2026-05-16 vm-354 retry install.)
EXT_IP=$(hostname -I | awk '{print $1}')
EXT_TEST=$(timeout 3 bash -c "</dev/tcp/$EXT_IP/3131" 2>/dev/null && echo OPEN || echo REFUSED)
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

# G8: gateway health (Rule 5) with retry. The hot-reload should NOT have
# broken the gateway. If it did (parse error, etc.), we want to know
# immediately — don't let Phase H proceed against an unhealthy gateway.
#
# Retry up to 3 attempts × 3s spacing (P2 followup 2026-05-21 — fixed Bug E
# recurrence on vm-517 which re-quarantined 3 times overnight despite the
# gateway being healthy seconds later). Hot-reload completion timing is
# non-deterministic in OpenClaw 2026.4.26:
#   • config-watcher emits "config hot reload applied" within <1s (typical)
#     but on a loaded VM with active sessions, the gateway may briefly stop
#     serving /health while it swaps in the new MCP server config
#   • curl returns 000 (connection refused) for the ~1-5s window the gateway
#     is mid-swap — looks identical to "the gateway crashed" but isn't
#   • a single probe at this point catches the transient too aggressively
# Total budget: 3 attempts × (3s curl timeout + 3s sleep) ≈ ~12s worst case.
# Surface attempt count on success so future timing skew is visible.
GW_HEALTH=""
GW_HEALTH_ATTEMPTS=0
for ATTEMPT in 1 2 3; do
  GW_HEALTH_ATTEMPTS=$ATTEMPT
  GW_HEALTH=$(curl -sf -m 3 -o /dev/null -w '%{http_code}' http://localhost:18789/health 2>/dev/null)
  if [ "$GW_HEALTH" = "200" ]; then
    break
  fi
  # Don't sleep after the last attempt — pointless wait before fatal.
  if [ "$ATTEMPT" -lt 3 ]; then
    sleep 3
  fi
done
if [ "$GW_HEALTH" != "200" ]; then
  echo "FATAL_GATEWAY_UNHEALTHY_POST_HOT_RELOAD health=$GW_HEALTH attempts=$GW_HEALTH_ATTEMPTS"
  openclaw mcp unset gbrain > /dev/null 2>&1
  exit 19
fi

echo "PHASE_G_OK transport=streamable-http gw_health=$GW_HEALTH hot_reload_hits=$HOT_RELOAD_HITS gw_health_attempts=$GW_HEALTH_ATTEMPTS"

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
# PHASE I: install CHECKPOINT cron + ExecStop drop-in (CLAUDE.md Rule 54)
# ═══════════════════════════════════════════════════════════════════════════════
#
# Two-layer prevention against pg_control staleness:
#   1. crontab: every 30 min, force a CHECKPOINT via the gbrain MCP `checkpoint`
#      tool (added by the Phase C2 patch). Bounds SIGKILL-safety window to 30 min.
#   2. systemd ExecStop hook: force CHECKPOINT before SIGKILL fires on any
#      controlled stop. Pairs with the 10-killsignal.conf drop-in that enforces
#      KillSignal=SIGKILL.
#
# Both layers depend on the Phase C2 patch having applied. If it didn't (Phase
# C2 emitted a WARN), the cron will log FAILED entries to
# ~/.openclaw/logs/pglite-checkpoint.log — operator sees it on next audit.
# We still install the cron + drop-in regardless, so the protection lands
# automatically once the patch is rebased and re-deployed.
echo "PHASE_I_START"

mkdir -p "$HOME/.openclaw/scripts" "$HOME/.openclaw/logs" "$HOME/.config/systemd/user/gbrain.service.d"

# Locate the cron script — TS wrapper SFTPs it alongside install-gbrain.sh,
# or it lives next to this script in the instaclaw repo.
CRON_SCRIPT_SRC=""
for candidate in \
    "/tmp/pglite-checkpoint.sh" \
    "$(dirname "${BASH_SOURCE[0]}")/pglite-checkpoint.sh"; do
  if [ -s "$candidate" ]; then CRON_SCRIPT_SRC="$candidate"; break; fi
done

if [ -z "$CRON_SCRIPT_SRC" ]; then
  # HARD FAIL (2026-05-20): was WARN until canary surfaced 15/15 VMs missing
  # the CHECKPOINT cron + ExecStop drop-in because the TS reconciler didn't
  # upload pglite-checkpoint.sh. Silent degradation here = no Rule 54
  # protection (pg_control staleness, no graceful checkpoint on stop). Now
  # require the cron script to be present so the reconciler retries instead
  # of marking install successful.
  echo "FATAL_PHASE_I_NO_CRON_SCRIPT — pglite-checkpoint.sh not co-deployed."
  echo "  hint: TS wrapper must SFTP pglite-checkpoint.sh to /tmp/ alongside install-gbrain.sh"
  exit 35
else
  cp "$CRON_SCRIPT_SRC" "$HOME/.openclaw/scripts/pglite-checkpoint.sh"
  chmod +x "$HOME/.openclaw/scripts/pglite-checkpoint.sh"
  echo "  cron script: $HOME/.openclaw/scripts/pglite-checkpoint.sh"

  # Idempotent crontab install (every 30 min)
  if ! crontab -l 2>/dev/null | grep -q "pglite-checkpoint.sh"; then
    (crontab -l 2>/dev/null; echo "*/30 * * * * bash $HOME/.openclaw/scripts/pglite-checkpoint.sh") | crontab -
    echo "  crontab: installed (every 30 min)"
  else
    echo "  crontab: already installed (idempotent)"
  fi

  # systemd drop-in for ExecStop
  DROPIN="$HOME/.config/systemd/user/gbrain.service.d/20-execstop-checkpoint.conf"
  cat > "$DROPIN" <<EOF
# Rule 54 / Rule 58 — force CHECKPOINT before SIGKILL fires on controlled stop.
# Runs BEFORE KillSignal=SIGKILL (set by 10-killsignal.conf).
# TimeoutStopSec=30 leaves ample budget: CHECKPOINT <1s + HTTP RTT + 25s buffer.
[Service]
ExecStop=$HOME/.openclaw/scripts/pglite-checkpoint.sh
TimeoutStopSec=30
EOF
  systemctl --user daemon-reload 2>&1

  echo "  drop-in: $DROPIN"
  echo "  effective TimeoutStopSec: $(systemctl --user show gbrain.service --property=TimeoutStopUSec --value)"

  # Test run — force a CHECKPOINT now so pg_control is fresh from the moment
  # of install completion (not relying on the first cron tick to happen).
  bash "$HOME/.openclaw/scripts/pglite-checkpoint.sh" 2>&1 | tail -1 || true
  CHECKPOINT_LOG_TAIL=$(tail -1 "$HOME/.openclaw/logs/pglite-checkpoint.log" 2>/dev/null || echo "(no log)")
  echo "  test run: $CHECKPOINT_LOG_TAIL"
fi

echo "PHASE_I_OK"

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
