/**
 * lib/cloud-init-setup-sh.ts — server-side generator for the setup.sh
 * bash script that runs INSIDE the cloud-init tarball, AFTER the bootstrap
 * extracts the tarball to /tmp/instaclaw-config.
 *
 * Architecture flow:
 *   1. Linode user_data carries the ~2.3KB bootstrap (lib/cloud-init-userdata.ts).
 *   2. Bootstrap fetches tarball via /api/vm/cloud-init-config.
 *   3. Bootstrap extracts to /tmp/instaclaw-config (root-owned staging).
 *   4. Bootstrap invokes /tmp/instaclaw-config/setup.sh — THIS file's output.
 *   5. setup.sh installs per-user files to ~/.openclaw/ with correct
 *      ownership/modes, RESTARTS the gateway (snapshot has a placeholder
 *      openclaw.json with a real gateway token — restart loads the new
 *      per-user token from the just-installed openclaw.json), POSTs the
 *      success callback.
 *   6. setup.sh's success → bootstrap touches /tmp/.instaclaw-ready →
 *      cloud-init-poll cron flips VM to status='ready' on next tick.
 *
 * Phase 1A Day 8a scope (THIS commit): the 5 CRITICAL steps per plan §4 +
 * Cooper's classification — steps 5, 6, 9, 32, 38. A VM provisioned with
 * only these CRITICAL steps lands functional (gateway up, callback succeeds,
 * cloud-init-poll marks VM healthy); the reconciler heals BEST_EFFORT
 * artifacts (skill clones, mcporter config, partner-stub SOUL.md inserts,
 * etc.) on its next tick.
 *
 * Phase 1A Day 8b scope (lands incrementally — one BE-N step per commit
 * per Cooper's 2026-05-14 discipline rules): 13 BEST_EFFORT steps + the
 * subset of §17b.2 missing files NOT covered by the reconciler's
 * stepFiles (manifest files[] heals most). True Day-8b-must-deploy:
 * browser-relay-server.js, check-skill-updates.sh + daily cron,
 * agent-status + clawlancer SKILL.md (frontier was committed
 * standalone at instaclaw/skills/frontier/SKILL.md → manifest's
 * skillsFromRepo walk picks it up). Each BE-N step uses the
 * `{ ... } || echo WARN ...` pattern — never `exit 1` (that's the
 * CRITICAL-step prerogative).
 *
 * Day 8b progress (update with each landing BE-N):
 *   - [✓] BE-1: linger + sshd OOM-protect drop-in
 *   - [ ] BE-2: mkdir defenses
 *   - [ ] BE-3: privacy wipe
 *   - [ ] BE-4: stop pre-existing gateway (likely redundant — under review)
 *   - [ ] BE-5: skill clones + overlays (bankr, consensus, edge_city)
 *   - [ ] BE-6: @bankr/cli pinned install
 *   - [ ] BE-7: browser-relay-server.js + check-skill-updates.sh + cron
 *   - [ ] BE-8: agent-status + clawlancer SKILL.md
 *   - [ ] BE-9: mcporter clawlancer config
 *   - [ ] BE-10: pip install §17b.2 packages
 *   - [ ] BE-11: npm install §17b.2 packages
 *   - [ ] BE-12: xvfb/x11vnc/websockify systemd units
 *   - [ ] BE-13: daemon-reload (lands with BE-12 — no-op without it)
 *
 * Snapshot inventory cross-reference (verified 2026-05-14 against vm-944,
 * a status=ready cv=0 VM — pure snapshot baseline):
 *   - ~/.openclaw/wallet/ does NOT exist on snapshot → setup.sh creates
 *     it via `install -d -m 700` before installing agent.key.
 *   - ~/.openclaw/openclaw.json + .env exist as placeholders with a
 *     placeholder gateway token → setup.sh overwrites both atomically
 *     via `install -m 600`. The gateway may already be running with the
 *     placeholder token at the moment setup.sh runs (snapshot's linger
 *     starts the user-systemd instance at boot, which starts openclaw-
 *     gateway with the placeholder config). Step 32 uses `systemctl
 *     --user restart` (NOT `start`) to ensure the new openclaw.json is
 *     loaded. If we used `start`, the running gateway with placeholder
 *     config would silently no-op and proxy → gateway would 401.
 *   - ~/.openclaw/agents/main/agent/ exists; auth-profiles.json +
 *     system-prompt.md are NOT on snapshot — setup.sh installs both.
 *   - ~/.openclaw/workspace/ exists with default placeholders for
 *     IDENTITY/USER/BOOTSTRAP/MEMORY (etc.) — setup.sh overwrites with
 *     the per-user content from the tarball.
 *
 * Security:
 *   - All TS-substituted params (userId, vmName, etc.) ALREADY passed
 *     validateTarballParams' shell-safety check. The wrapper bash quoting
 *     here is belt-and-suspenders.
 *   - callback_token is in setup.sh ONLY — never in Linode user_data.
 *     Tarball at-rest lifetime in /tmp is ~5 seconds (bootstrap rm -rf's
 *     /tmp/instaclaw-config after setup.sh exits).
 *
 * Worldclass discipline:
 *   - bash -n verifies syntax in the smoke test
 *   - Every CRITICAL step has the `|| { rm ready; touch failed; exit 1 }`
 *     block; per Rule 22 we never delete user state from setup.sh
 *   - Param substitutions are pinned in tests so a future regression in
 *     buildSetupSh's template fails loudly
 */

import type { TarballParams } from "./cloud-init-tarball";

/**
 * Build the setup.sh body for this user's tarball. Pure function. Same
 * params → same output (modulo TS template substitutions — all params
 * pinned by validateTarballParams's shell-safety check before reaching
 * here).
 *
 * Output is ~3-4KB of bash. Mode 0o755 (set by the caller in
 * buildCloudInitTarball).
 *
 * Day 8a returned the CRITICAL-only template. Day 8b extends with
 * BEST_EFFORT steps — landing incrementally, one BE-N per commit.
 */
export function buildSetupSh(p: TarballParams): string {
  // Strip trailing slashes from nextauthUrl (validateTarballParams already
  // forbids ? and # but allows trailing /). The callback URL appends
  // /api/vm/cloud-init-callback unconditionally.
  const nextauthUrl = p.nextauthUrl.replace(/\/+$/, "");

  return `#!/bin/bash
# setup.sh — cloud-init second-stage setup for vm=${p.vmName} user=${p.userId}
# Generated by lib/cloud-init-setup-sh.ts at tarball-build time.
# Phase 1A Day 8a — CRITICAL steps 5/6/9/32/38 only. Day 8b adds BEST_EFFORT.
#
# setup.sh contract:
#   Runs as root after bootstrap extracts /tmp/instaclaw-config.tar.gz.
#   On success: touch /tmp/.instaclaw-ready, exit 0.
#   On failure: rm -f /tmp/.instaclaw-ready, touch /tmp/.instaclaw-failed, exit 1.
#   Bootstrap (the script that invoked us) cleans up /tmp/instaclaw-config/.

set -euo pipefail
mkdir -p /var/log
exec > >(tee -a /var/log/instaclaw-setup.log) 2>&1
trap 'EC=\$?; echo "[\$(date -u +%FT%TZ)] FATAL setup.sh line \$LINENO exit \$EC"; rm -f /tmp/.instaclaw-ready; touch /tmp/.instaclaw-failed; exit 1' ERR

# ── Params substituted at tarball-build time ──────────────────────────
# All values passed validateTarballParams' shell-safety check (no
# backticks, $, \\, quotes, whitespace, newlines, or CR). Safe to splice.
USER_ID="${p.userId}"
VM_NAME="${p.vmName}"
CALLBACK_TOKEN="${p.callbackToken}"
NEXTAUTH_URL="${nextauthUrl}"
AGENTBOOK_ADDRESS="${p.agentbookAddress}"

echo "[\$(date -u +%FT%TZ)] setup.sh starting (user=\$USER_ID vm=\$VM_NAME)"

# ════════════════════════════════════════════════════════════════════════
# §1.1 BEST_EFFORT [BE-1]: linger + sshd OOM-protect drop-in
# ════════════════════════════════════════════════════════════════════════
# Two independent safeties wired up before any service modification:
#
#   1. loginctl enable-linger openclaw — keeps the openclaw user's
#      systemd-user instance alive after cloud-init exits. Without it,
#      the openclaw-gateway user service stops at the next user-session
#      tear-down (or VM reboot). The reconciler does NOT heal linger; if
#      this step fails silently the VM works until first reboot, then the
#      gateway is gone and manual SSH-in is required to recover.
#
#   2. /etc/systemd/system/ssh.service.d/oom-protect.conf with
#      OOMScoreAdjust=-900 — protects sshd from the OOM killer during
#      memory-pressure events (e.g., a runaway agent process). Without
#      protection, OOM-killing sshd locks out admin access entirely.
#      The reconciler's stepShdOomProtection heals this on the next
#      ~3-min cycle, so a transient miss is recoverable; linger is not.
#
# Idempotency: enable-linger is a no-op when already set. oom-protect.conf
# is a canonical-content overwrite — the snapshot does not have it (per
# §17b inventory), and every future VM gets the same canonical bytes.
#
# systemctl daemon-reload picks up the drop-in for FUTURE sshd restarts;
# the currently-running sshd PID retains its old OOMScoreAdjust. We do
# NOT restart sshd here — cloud-init has root via Linode metadata, not
# SSH, so an sshd restart would interrupt no live session of ours, but
# it adds risk (a broken sshd config would brick admin access) for no
# immediate gain. The next routine sshd restart picks up the new score.
{
  loginctl enable-linger openclaw
  mkdir -p /etc/systemd/system/ssh.service.d
  cat > /etc/systemd/system/ssh.service.d/oom-protect.conf <<'OOMEOF'
[Service]
OOMScoreAdjust=-900
OOMEOF
  systemctl daemon-reload
} || echo "[\$(date -u +%FT%TZ)] WARN: BE-1 (linger + sshd OOM-protect) partial failure — reconciler heals oom-protect.conf on next tick; linger is NOT reconciler-healed (manual fix needed on first reboot)"

# ════════════════════════════════════════════════════════════════════════
# §1.5 CRITICAL: place openclaw.json + auth-profiles.json (mode 0600)
# ════════════════════════════════════════════════════════════════════════
# Both files carry tokens. openclaw.json has gateway.auth.token +
# channels.telegram.botToken; auth-profiles.json has the Anthropic key
# (or proxy gateway_token for all-inclusive). Mode 600 is non-negotiable.
# Failure here means the gateway can't start authenticated — fail loud.
{
  install -d -o openclaw -g openclaw -m 700 /home/openclaw/.openclaw
  install -d -o openclaw -g openclaw -m 700 /home/openclaw/.openclaw/agents
  install -d -o openclaw -g openclaw -m 700 /home/openclaw/.openclaw/agents/main
  install -d -o openclaw -g openclaw -m 700 /home/openclaw/.openclaw/agents/main/agent
  install -o openclaw -g openclaw -m 600 \\
    /tmp/instaclaw-config/home/openclaw/.openclaw/openclaw.json \\
    /home/openclaw/.openclaw/openclaw.json
  install -o openclaw -g openclaw -m 600 \\
    /tmp/instaclaw-config/home/openclaw/.openclaw/agents/main/agent/auth-profiles.json \\
    /home/openclaw/.openclaw/agents/main/agent/auth-profiles.json
} || {
  echo "[\$(date -u +%FT%TZ)] FATAL: step 5 (place openclaw.json + auth-profiles.json) failed"
  rm -f /tmp/.instaclaw-ready
  touch /tmp/.instaclaw-failed
  exit 1
}

# ════════════════════════════════════════════════════════════════════════
# §1.6 CRITICAL: place .env (mode 0600)
# ════════════════════════════════════════════════════════════════════════
# Contains GATEWAY_TOKEN + TELEGRAM_BOT_TOKEN + EDGEOS_BEARER_TOKEN (if
# edge_city) + BANKR_API_KEY (if set) + CLOB proxy endpoints + region.
# Gateway reads GATEWAY_TOKEN at startup; scripts read the others on demand.
{
  install -o openclaw -g openclaw -m 600 \\
    /tmp/instaclaw-config/home/openclaw/.openclaw/.env \\
    /home/openclaw/.openclaw/.env
} || {
  echo "[\$(date -u +%FT%TZ)] FATAL: step 6 (place .env) failed"
  rm -f /tmp/.instaclaw-ready
  touch /tmp/.instaclaw-failed
  exit 1
}

# ════════════════════════════════════════════════════════════════════════
# §1.9 CRITICAL: per-user workspace files + agent dir + wallet/agent.key
# ════════════════════════════════════════════════════════════════════════
# Five workspace .md files (mode 644): IDENTITY, WALLET, BOOTSTRAP +
# conditional USER.md, WORLD_ID.md, MEMORY.md. agent dir gets
# system-prompt.md + (conditional) MEMORY.md. wallet/agent.key is the
# AgentBook private key (mode 600 — never share). Conditional files are
# emitted by the tarball builder only when applicable (Gmail present,
# World ID set, etc.) — \`[ -f \$src ]\` guard handles absence cleanly.
{
  install -d -o openclaw -g openclaw -m 755 /home/openclaw/.openclaw/workspace
  install -d -o openclaw -g openclaw -m 700 /home/openclaw/.openclaw/wallet

  # Workspace .md files (universal: IDENTITY, WALLET, BOOTSTRAP;
  # conditional: USER, WORLD_ID, MEMORY)
  for f in IDENTITY.md WALLET.md BOOTSTRAP.md USER.md WORLD_ID.md MEMORY.md; do
    src="/tmp/instaclaw-config/home/openclaw/.openclaw/workspace/\$f"
    if [ -f "\$src" ]; then
      install -o openclaw -g openclaw -m 644 "\$src" \\
        "/home/openclaw/.openclaw/workspace/\$f"
    fi
  done

  # Agent dir files (system-prompt always; MEMORY conditional)
  install -o openclaw -g openclaw -m 644 \\
    /tmp/instaclaw-config/home/openclaw/.openclaw/agents/main/agent/system-prompt.md \\
    /home/openclaw/.openclaw/agents/main/agent/system-prompt.md
  if [ -f /tmp/instaclaw-config/home/openclaw/.openclaw/agents/main/agent/MEMORY.md ]; then
    install -o openclaw -g openclaw -m 644 \\
      /tmp/instaclaw-config/home/openclaw/.openclaw/agents/main/agent/MEMORY.md \\
      /home/openclaw/.openclaw/agents/main/agent/MEMORY.md
  fi

  # AgentBook wallet key (mode 600)
  install -o openclaw -g openclaw -m 600 \\
    /tmp/instaclaw-config/home/openclaw/.openclaw/wallet/agent.key \\
    /home/openclaw/.openclaw/wallet/agent.key
} || {
  echo "[\$(date -u +%FT%TZ)] FATAL: step 9 (workspace files + agent.key) failed"
  rm -f /tmp/.instaclaw-ready
  touch /tmp/.instaclaw-failed
  exit 1
}

# ════════════════════════════════════════════════════════════════════════
# §1.32 CRITICAL: RESTART gateway + verify /health 200 within 60s
# ════════════════════════════════════════════════════════════════════════
# CRITICAL: \`systemctl --user RESTART\` (not start). The snapshot's linger
# starts openclaw-gateway during boot with the placeholder openclaw.json —
# at the moment setup.sh runs, the gateway may ALREADY be running with the
# placeholder gateway.auth.token. We just overwrote openclaw.json (step 5)
# with the per-user token; \`start\` on a running unit is a no-op and the
# stale token would persist. Restart guarantees the new config is loaded.
#
# Fallback: if user systemd-instance isn't up yet (cold boot, linger
# didn't fire in time), \`systemctl --user restart\` exits non-zero. The
# \`is-active\` check then falls through to direct \`openclaw gateway run\`.
# 20×3s poll = 60s budget; if /health doesn't 200 in 60s, the gateway is
# broken — fail loud.
{
  sudo -u openclaw bash -lc '
    export XDG_RUNTIME_DIR=/run/user/\$(id -u)
    systemctl --user restart openclaw-gateway 2>/dev/null || true
    if ! systemctl --user is-active openclaw-gateway &>/dev/null; then
      pkill -9 -f "openclaw-gateway" 2>/dev/null || true
      sleep 1
      nohup openclaw gateway run --bind lan --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &
    fi
  '
  GATEWAY_OK=false
  for _attempt in \$(seq 1 20); do
    if sudo -u openclaw curl -s -m 2 http://localhost:18789/health >/dev/null 2>&1; then
      GATEWAY_OK=true
      break
    fi
    sleep 3
  done
  [ "\$GATEWAY_OK" = "true" ]
} || {
  echo "[\$(date -u +%FT%TZ)] FATAL: step 32 (gateway restart + health probe) failed"
  rm -f /tmp/.instaclaw-ready
  touch /tmp/.instaclaw-failed
  exit 1
}

# ── §1.37 sentinels (must precede callback so cloud-init-poll picks up ─
# the ready signal even if callback POST flakes briefly).
touch /tmp/.instaclaw-ready
echo "OPENCLAW_CONFIGURE_DONE"

# ════════════════════════════════════════════════════════════════════════
# §1.38 CRITICAL: callback POST to /api/vm/cloud-init-callback
# ════════════════════════════════════════════════════════════════════════
# 3 attempts × 10s timeout + 5s backoff = max ~35s. Callback consumes the
# one-time-use callback_token (atomic claim per PRD §5.3.1) and flips
# vm.health_status='healthy' + writes agentbook_wallet_address. If all 3
# fail, fail the whole setup → cloud-init-poll respawns via the cron's
# 30-min stuck-VM sweep.
#
# JSON body uses bash quoting (\\" inside "..." for literal "). The
# \$USER_ID / \$VM_NAME / \$AGENTBOOK_ADDRESS values are bash-substituted
# at runtime; the TS template substitution was done at the top of this
# file.
{
  CALLBACK_OK=false
  for _attempt in 1 2 3; do
    if curl -fsS -X POST "\$NEXTAUTH_URL/api/vm/cloud-init-callback" \\
        -H "Content-Type: application/json" \\
        -H "X-Cloud-Init-Callback-Token: \$CALLBACK_TOKEN" \\
        -d "{\\"userId\\":\\"\$USER_ID\\",\\"vmName\\":\\"\$VM_NAME\\",\\"agentbookAddress\\":\\"\$AGENTBOOK_ADDRESS\\",\\"status\\":\\"healthy\\"}" \\
        -m 10 > /dev/null 2>&1; then
      CALLBACK_OK=true
      break
    fi
    [ \$_attempt -lt 3 ] && sleep 5
  done
  [ "\$CALLBACK_OK" = "true" ]
} || {
  echo "[\$(date -u +%FT%TZ)] FATAL: step 38 (callback POST) failed after 3 attempts"
  rm -f /tmp/.instaclaw-ready
  touch /tmp/.instaclaw-failed
  exit 1
}

# ── Day 8b BEST_EFFORT steps land incrementally — see docstring ───────
# Done: BE-1 (linger + sshd OOM-protect).
# Pending: BE-2 (mkdir defenses), BE-3 (privacy wipe), BE-4 (stop pre-
# existing gateway — likely redundant with §1.32 restart, under review),
# BE-5 (skill clones), BE-6 (@bankr/cli), BE-7 (browser-relay-server.js
# + check-skill-updates.sh), BE-8 (agent-status + clawlancer SKILL.md),
# BE-9 (mcporter clawlancer config), BE-10 (pip), BE-11 (npm),
# BE-12 (xvfb/x11vnc/websockify systemd units), BE-13 (daemon-reload —
# lands with BE-12 since it's a no-op without unit-file changes).
# All follow the BEST_EFFORT pattern:
#   { ... } || echo "[\$(date -u +%FT%TZ)] WARN: BE-N (label) — recovery"

echo "[\$(date -u +%FT%TZ)] setup.sh complete (CRITICAL + BE-1 — Day 8a + Day 8b BE-1)"
exit 0
`;
}

// Sentinel constants exported for tests + future reconciler verification
// (Rule 23 pattern). Any future template drift that removes these signals
// would fail Phase 1B-2's byte-compare audit AND the wrapper's smoke test.
export const SETUP_SH_SENTINELS = {
  /** Top-level start marker — confirms the file is a buildSetupSh output. */
  HEADER: "Generated by lib/cloud-init-setup-sh.ts at tarball-build time.",
  /** Day-8a scope marker — removed when Day 8b's BEST_EFFORT steps land. */
  DAY_8A_SCOPE: "CRITICAL steps 5/6/9/32/38 only. Day 8b adds BEST_EFFORT.",
  /** Bash-error guard — confirms the ERR trap is in place (sets failed sentinel). */
  ERR_TRAP: 'trap \'EC=$?; echo "[$(date -u +%FT%TZ)] FATAL setup.sh line $LINENO exit $EC"; rm -f /tmp/.instaclaw-ready; touch /tmp/.instaclaw-failed; exit 1\' ERR',
  /** Ready sentinel emit — confirms success path completes correctly. */
  READY_SENTINEL: "touch /tmp/.instaclaw-ready",
  /** Configure-done marker — bootstrap looks for this in stdout. */
  CONFIGURE_DONE: 'echo "OPENCLAW_CONFIGURE_DONE"',
  /** Callback URL path — confirms callback step targets the right endpoint. */
  CALLBACK_PATH: "/api/vm/cloud-init-callback",
  /** Critical-step gateway-health probe — must hit localhost:18789/health. */
  GATEWAY_HEALTH_PROBE: "http://localhost:18789/health",
  /** BE-1: linger enable — gateway auto-start across reboots. */
  BE1_LINGER: "loginctl enable-linger openclaw",
  /** BE-1: sshd OOM-protect drop-in path. */
  BE1_OOM_DROP_IN_PATH: "/etc/systemd/system/ssh.service.d/oom-protect.conf",
  /** BE-1: canonical OOM score for sshd protection. */
  BE1_OOM_SCORE: "OOMScoreAdjust=-900",
} as const;
