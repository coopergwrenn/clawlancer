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
 *   - [✓] BE-7: browser-relay-server.js + check-skill-updates.sh + cron
 *   - [ ] BE-8: agent-status + clawlancer SKILL.md
 *   - [✓] BE-9: mcporter clawlancer config
 *   - [ ] BE-10: pip install §17b.2 packages
 *   - [✓] BE-11: npm install §17b.2 packages
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
#
# CHAIN DISCIPLINE: every command is &&-chained so a failure aborts.
# Bash POSIX semantics suspend \`set -e\` inside conditional contexts
# (LHS of \`||\`), so a bare newline-separated block would silently
# swallow intermediate failures and the WARN would never fire. The
# heredoc is rewritten as \`printf\` so it can sit cleanly inside the
# && chain (bash can't continue a heredoc through \`\\<newline>&&\`).
{ loginctl enable-linger openclaw \\
    && mkdir -p /etc/systemd/system/ssh.service.d \\
    && printf '[Service]\\nOOMScoreAdjust=-900\\n' > /etc/systemd/system/ssh.service.d/oom-protect.conf \\
    && systemctl daemon-reload ; } || echo "[\$(date -u +%FT%TZ)] WARN: BE-1 (linger + sshd OOM-protect) partial failure — reconciler heals oom-protect.conf on next tick; linger is NOT reconciler-healed (manual fix needed on first reboot)"

# ════════════════════════════════════════════════════════════════════════
# §1.5 CRITICAL: place openclaw.json + auth-profiles.json (mode 0600)
# ════════════════════════════════════════════════════════════════════════
# Both files carry tokens. openclaw.json has gateway.auth.token +
# channels.telegram.botToken; auth-profiles.json has the Anthropic key
# (or proxy gateway_token for all-inclusive). Mode 600 is non-negotiable.
# Failure here means the gateway can't start authenticated — fail loud.
#
# CHAIN DISCIPLINE (Bug #1 fix 2026-05-14): bash POSIX suspends \`set -e\`
# inside \`{ } || handler\` blocks (verified empirically — \`set -e\` is
# ignored when the compound command sits on the LHS of \`||\`). A bare
# newline-separated block would mean: if \`install openclaw.json\` fails
# but \`install auth-profiles.json\` succeeds, the block exits 0 and the
# CRITICAL handler doesn't fire — gateway then restarts with the
# snapshot's PLACEHOLDER token while /health returns 200 and callback
# succeeds. The VM looks healthy; the user's bot is silently dead. To
# prevent that, every command is && -chained so the first failure aborts.
{ install -d -o openclaw -g openclaw -m 700 /home/openclaw/.openclaw \\
    && install -d -o openclaw -g openclaw -m 700 /home/openclaw/.openclaw/agents \\
    && install -d -o openclaw -g openclaw -m 700 /home/openclaw/.openclaw/agents/main \\
    && install -d -o openclaw -g openclaw -m 700 /home/openclaw/.openclaw/agents/main/agent \\
    && install -o openclaw -g openclaw -m 600 \\
         /tmp/instaclaw-config/home/openclaw/.openclaw/openclaw.json \\
         /home/openclaw/.openclaw/openclaw.json \\
    && install -o openclaw -g openclaw -m 600 \\
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
# Three universal .md files (mode 644): IDENTITY, WALLET, BOOTSTRAP —
# the tarball builder ALWAYS emits these; missing == builder bug; fail
# loud (Bug #2 fix 2026-05-14, no \`[ -f \$src ]\` guard). Three
# conditional .md files: USER.md (iff Gmail), WORLD_ID.md (iff
# worldIdNullifier), MEMORY.md (iff Gmail). Agent dir gets
# system-prompt.md (always) + (conditional) MEMORY.md. wallet/agent.key
# is the AgentBook private key (mode 600 — never share).
#
# CHAIN DISCIPLINE (Bug #1 fix 2026-05-14): bash POSIX suspends \`set -e\`
# inside \`{ } || handler\` blocks. The for-loop's install commands would
# silently swallow individual failures and the block's exit code would
# only reflect the LAST install (agent.key). To gate the block exit on
# ALL operations, we use an explicit \`rc=0 / rc=1 / [ "\$rc" = "0" ]\`
# accumulator — every install records its failure into rc, and the
# terminal test fires the CRITICAL handler if anything failed.
{
  rc=0
  install -d -o openclaw -g openclaw -m 755 /home/openclaw/.openclaw/workspace || rc=1
  install -d -o openclaw -g openclaw -m 700 /home/openclaw/.openclaw/wallet || rc=1

  # Universal .md files — fail loud if missing from tarball (Bug #2 fix).
  for f in IDENTITY.md WALLET.md BOOTSTRAP.md; do
    install -o openclaw -g openclaw -m 644 \\
      "/tmp/instaclaw-config/home/openclaw/.openclaw/workspace/\$f" \\
      "/home/openclaw/.openclaw/workspace/\$f" || rc=1
  done

  # Conditional .md files — skip cleanly if absent from tarball.
  for f in USER.md WORLD_ID.md MEMORY.md; do
    src="/tmp/instaclaw-config/home/openclaw/.openclaw/workspace/\$f"
    if [ -f "\$src" ]; then
      install -o openclaw -g openclaw -m 644 "\$src" \\
        "/home/openclaw/.openclaw/workspace/\$f" || rc=1
    fi
  done

  # Agent dir files (system-prompt universal; MEMORY conditional).
  install -o openclaw -g openclaw -m 644 \\
    /tmp/instaclaw-config/home/openclaw/.openclaw/agents/main/agent/system-prompt.md \\
    /home/openclaw/.openclaw/agents/main/agent/system-prompt.md || rc=1
  if [ -f /tmp/instaclaw-config/home/openclaw/.openclaw/agents/main/agent/MEMORY.md ]; then
    install -o openclaw -g openclaw -m 644 \\
      /tmp/instaclaw-config/home/openclaw/.openclaw/agents/main/agent/MEMORY.md \\
      /home/openclaw/.openclaw/agents/main/agent/MEMORY.md || rc=1
  fi

  # AgentBook wallet key (mode 600 — never share).
  install -o openclaw -g openclaw -m 600 \\
    /tmp/instaclaw-config/home/openclaw/.openclaw/wallet/agent.key \\
    /home/openclaw/.openclaw/wallet/agent.key || rc=1

  [ "\$rc" = "0" ]
} || {
  echo "[\$(date -u +%FT%TZ)] FATAL: step 9 (workspace files + agent.key) failed (rc=\$rc)"
  rm -f /tmp/.instaclaw-ready
  touch /tmp/.instaclaw-failed
  exit 1
}

# ════════════════════════════════════════════════════════════════════════
# §1.10 BEST_EFFORT [BE-7]: deploy browser-relay-server.js +
#       check-skill-updates.sh + daily 3am UTC cron
# ════════════════════════════════════════════════════════════════════════
# Two scripts the snapshot does NOT have (per §17b.2) AND that the
# reconciler does NOT manage via vm-manifest.ts:files[]. If we skip
# this step, only a manual fleet-push can heal these files.
#
# browser-relay-server.js: VM-side WebSocket server bound to localhost:18792.
# Caddy's /relay/* proxy targets it. Without this file, the Chrome
# extension shows "Cannot reach relay" — degraded feature for users who
# installed the extension. The systemd unit that runs this script
# (browser-relay-server.service) lands later via a future BE-N; until
# then the file sits on disk but doesn't auto-start. Rule 33 in the SSH
# path classifies browser_relay_deploy as critical=true (lib/ssh.ts:5926);
# cloud-init relaxes to BEST_EFFORT because failure here is recoverable
# (fleet-push or manual SSH-deploy) — the gateway still serves Telegram.
#
# check-skill-updates.sh: daily 3am UTC cron diff-checks the
# manifest.json from GitHub against installed pip versions and upgrades
# drifted packages. Cron install pattern mirrors lib/ssh.ts:6515-6516
# — \`grep -v\` strips any prior entry first, then \`echo | crontab -\`
# re-adds. Idempotent on re-run.
#
# Idempotency: \`install -m 755\` overwrites canonical bytes. The cron
# line's \$HOME expands at install time (inside the sudo'd bash) so the
# stored crontab entry has the literal /home/openclaw path — matches
# what configureOpenClaw emits today (byte-parity).
#
# CHAIN DISCIPLINE (Bug #1 fix 2026-05-14): every command is && -chained
# so an intermediate failure (e.g., \`install -d\` permission denied)
# aborts the block and fires the WARN. A bare newline-separated block
# would silently swallow earlier failures because bash POSIX suspends
# \`set -e\` inside \`{ } || handler\` (verified empirically).
{ install -d -o openclaw -g openclaw -m 755 /home/openclaw/scripts \\
    && install -d -o openclaw -g openclaw -m 755 /home/openclaw/.openclaw/logs \\
    && install -o openclaw -g openclaw -m 755 \\
         /tmp/instaclaw-config/home/openclaw/scripts/browser-relay-server.js \\
         /home/openclaw/scripts/browser-relay-server.js \\
    && install -o openclaw -g openclaw -m 755 \\
         /tmp/instaclaw-config/home/openclaw/scripts/check-skill-updates.sh \\
         /home/openclaw/scripts/check-skill-updates.sh \\
    && sudo -u openclaw bash -c '
      CRON_LINE="0 3 * * * /bin/bash \$HOME/scripts/check-skill-updates.sh >> \$HOME/.openclaw/logs/skill-updates.log 2>&1"
      (crontab -l 2>/dev/null | grep -v "check-skill-updates"; echo "\$CRON_LINE") | crontab -
    '
} || echo "[\$(date -u +%FT%TZ)] WARN: BE-7 (browser-relay-server.js + check-skill-updates.sh + cron) partial failure — browser-relay NOT reconciler-healed (Chrome extension feature degraded; operator fleet-push to recover); check-skill-updates cron skipped (pip-package drift accumulates over time)"

# ════════════════════════════════════════════════════════════════════════
# §1.18 BEST_EFFORT [BE-11]: install npm-global packages
#       @worldcoin/agentkit-cli@0.1.3 + mcporter + usecomputer
# ════════════════════════════════════════════════════════════════════════
# These three npm globals are SUPPOSED to be on the snapshot per
# CLAUDE.md "Snapshot Creation Process" §9 + snapshot-bake-requirements
# doc §9, but the 2026-05-14 probe found them MISSING on BOTH the pure
# snapshot (vm-944, cv=0) AND a fully-reconciled paying customer's VM
# (vm-050, cv=95). configureOpenClaw's existing install commands at
# lib/ssh.ts:7047 (agentkit-cli, parallel block) and lib/ssh.ts:7109
# (usecomputer) use \`|| true\` which silently swallowed every install
# failure for the lifetime of the fleet. mcporter has NO explicit
# install at all — line 5583 just says "mcporter is pre-installed
# globally" which is empirically false.
#
# BE-11 closes the gap: verify-after-install, no \`|| true\` masking,
# WARN visibility into partial failures. The reconciler does NOT cover
# these (stepNpmPinDrift only handles @bankr/cli + openclaw per
# lib/vm-reconcile.ts:2643) so cloud-init is the only deploy path
# besides manual fleet-push.
#
# What breaks if BE-11 fails:
#   - mcporter: agent can't call ANY MCP server. The clawlancer
#     SKILL.md (committed in BE-8) instructs the agent to use
#     \`mcporter call clawlancer.<tool>\` everywhere — without mcporter
#     installed, every Clawlancer-marketplace interaction fails.
#   - @worldcoin/agentkit-cli@0.1.3: AgentBook registration impossible.
#   - usecomputer: dispatch mode (browser automation) broken.
#
# CHAIN DISCIPLINE: rc-accumulator pattern inside the openclaw user's
# bash -lc. Each install (a) checks idempotency via \`npm ls -g\`, (b)
# wraps the install in \`timeout 180\` to bound the worst-case duration,
# (c) verifies the package is installed after the install command
# completes. Failures accumulate to rc; terminal \`[ "\$rc" = "0" ]\`
# gates the inner bash exit. With \`set -e\` suspended inside the
# enclosing \`{ } || handler\` (per Bug #1 audit), this is the only
# pattern that correctly fires the WARN on any single-package failure.
#
# Runs as openclaw user (sudo -u + bash -lc): -l sources .bashrc which
# loads NVM; the inner explicit NVM_DIR + nvm.sh source is belt-and-
# suspenders defense against stale .bashrc that doesn't auto-load NVM.
{ sudo -u openclaw bash -lc '
    export NVM_DIR="\$HOME/.nvm"
    [ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"

    rc=0

    # @worldcoin/agentkit-cli@0.1.3 — version-pinned (matches
    # lib/ssh.ts:7047). Pinning matters: a future-version tarball
    # might be unpublished from the npm registry; the pin makes the
    # install reproducible across re-runs.
    if ! npm ls -g @worldcoin/agentkit-cli --depth=0 2>/dev/null | grep -q "@worldcoin/agentkit-cli@0.1.3"; then
      timeout 180 npm install -g @worldcoin/agentkit-cli@0.1.3 >/dev/null 2>&1 || rc=1
      npm ls -g @worldcoin/agentkit-cli --depth=0 2>/dev/null | grep -q "@worldcoin/agentkit-cli@" || rc=1
    fi

    # mcporter — unpinned (matches the lib/ssh.ts implicit-install
    # assumption; the SSH path has no explicit install, just the
    # incorrect "pre-installed globally" comment).
    if ! npm ls -g mcporter --depth=0 2>/dev/null | grep -q "mcporter@"; then
      timeout 180 npm install -g mcporter >/dev/null 2>&1 || rc=1
      npm ls -g mcporter --depth=0 2>/dev/null | grep -q "mcporter@" || rc=1
    fi

    # usecomputer — unpinned (matches lib/ssh.ts:7109). Post-install
    # we chmod +x the prebuilt linux-x64 binary because npm does NOT
    # set the executable bit on prebuilt binaries (matches lib/ssh.ts:
    # 7110-7113).
    if ! npm ls -g usecomputer --depth=0 2>/dev/null | grep -q "usecomputer@"; then
      timeout 180 npm install -g usecomputer >/dev/null 2>&1 || rc=1
      npm ls -g usecomputer --depth=0 2>/dev/null | grep -q "usecomputer@" || rc=1
      NODE_VER=\$(node --version)
      UC_BIN="\$HOME/.nvm/versions/node/\${NODE_VER}/lib/node_modules/usecomputer/dist/linux-x64/usecomputer"
      [ -f "\$UC_BIN" ] && chmod +x "\$UC_BIN" || true
    fi

    [ "\$rc" = "0" ]
  '
} || echo "[\$(date -u +%FT%TZ)] WARN: BE-11 (npm install @worldcoin/agentkit-cli + mcporter + usecomputer) partial failure — NOT reconciler-healed (stepNpmPinDrift only covers @bankr/cli + openclaw). Without mcporter: ALL MCP server calls (Clawlancer marketplace, custom MCPs) fail. Without agentkit-cli: AgentBook registration impossible. Without usecomputer: dispatch/browser mode broken. Manual fleet-push to recover."

# ════════════════════════════════════════════════════════════════════════
# §1.16 BEST_EFFORT [BE-9]: configure clawlancer MCP server via mcporter
# ════════════════════════════════════════════════════════════════════════
# Wires up the clawlancer MCP server in mcporter's config so the agent
# can call \`mcporter call clawlancer.<tool>\`. The clawlancer SKILL.md
# (deployed by stepSkills from instaclaw/skills/clawlancer/ after BE-8
# commit d048c5d3) instructs the agent to use these mcporter calls
# everywhere. Without this config registered, every Clawlancer
# marketplace invocation fails with "Unknown server 'clawlancer'."
#
# Order note: this is plan §1.16 but lands AFTER BE-11 (plan §1.18)
# in setup.sh because BE-9 requires the mcporter binary which BE-11
# installs. The plan assumed mcporter was snapshot-baked (it isn't,
# per §17b inventory), so cloud-init must run BE-11 first.
#
# Idempotency: \`mcporter config remove clawlancer\` legitimately exits
# 1 when no prior config exists ("Server 'clawlancer' does not
# exist"); we swallow that with \`|| true\` (NOT the production-bug
# pattern — this is correct semantics for an "if-present-remove"
# command). The \`config add\` MUST succeed; we verify with
# \`config get clawlancer\` which exits 0 iff registered (cleaner
# than parsing \`config list\` output).
#
# Canonical config (matches lib/ssh.ts:5596-5603 byte-for-byte):
#   --command "npx -y clawlancer-mcp"
#   --env CLAWLANCER_API_KEY=         (empty — agent fills when
#                                      it self-registers via
#                                      \`register_agent\` flow)
#   --env CLAWLANCER_BASE_URL=https://clawlancer.ai
#   --scope home                       (writes to ~/.mcporter/mcporter.json)
#   --description "Clawlancer AI agent marketplace"
#
# Empirically verified 2026-05-14 on vm-944: install fresh and
# install-when-already-configured both return exit 0 (idempotent).
#
# NOT reconciler-healed today. The reconciler does not run
# \`mcporter config add\` for any server. Future P1: extend a
# reconciler step to cover this so existing-fleet VMs get the
# clawlancer config without a manual fleet-push.
{ sudo -u openclaw bash -lc '
    export NVM_DIR="\$HOME/.nvm"
    [ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"

    # Prereq check: BE-11 must have installed mcporter. If missing,
    # BE-9 cannot proceed — exit 1 so the outer WARN fires with the
    # right diagnostic.
    if ! command -v mcporter >/dev/null 2>&1; then
      echo "BE-9: mcporter not on PATH (BE-11 install must have failed) — skipping clawlancer config"
      exit 1
    fi

    rc=0

    # Remove any prior clawlancer config (idempotent; exits 1 when
    # config absent — that legitimate case is swallowed by || true).
    mcporter config remove clawlancer 2>/dev/null || true

    # Add the canonical clawlancer config.
    mcporter config add clawlancer \\
      --command "npx -y clawlancer-mcp" \\
      --env CLAWLANCER_API_KEY= \\
      --env CLAWLANCER_BASE_URL=https://clawlancer.ai \\
      --scope home \\
      --description "Clawlancer AI agent marketplace" >/dev/null 2>&1 || rc=1

    # Verify-after-add: \`config get\` exits 0 iff the server is
    # registered. Cleaner signal than parsing \`config list\` output.
    mcporter config get clawlancer >/dev/null 2>&1 || rc=1

    [ "\$rc" = "0" ]
  '
} || echo "[\$(date -u +%FT%TZ)] WARN: BE-9 (mcporter clawlancer config) failed — agent's mcporter calls to clawlancer.* will return 'Unknown server clawlancer'. Recovery: SSH as openclaw and re-run the mcporter config add clawlancer command from lib/ssh.ts:5596-5603."

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
# Done: BE-1 (linger + sshd OOM-protect), BE-7 (browser-relay-server.js
# + check-skill-updates.sh + cron), BE-8 (agent-status + clawlancer
# SKILL.md via repo check-in), BE-9 (mcporter clawlancer config), BE-11
# (npm install agentkit-cli + mcporter + usecomputer).
# Pending: BE-2 (mkdir defenses), BE-3 (privacy wipe), BE-4 (stop pre-
# existing gateway — under review, likely redundant), BE-5 (skill
# clones), BE-6 (@bankr/cli — reconciler heals via stepNpmPinDrift),
# BE-10 (pip), BE-12 (xvfb/x11vnc/websockify systemd units), BE-13
# (daemon-reload — lands with BE-12 since it's a no-op without unit-
# file changes).
# All follow the BEST_EFFORT pattern:
#   { ... } || echo "[\$(date -u +%FT%TZ)] WARN: BE-N (label) — recovery"

echo "[\$(date -u +%FT%TZ)] setup.sh complete (CRITICAL + BE-1 + BE-7 + BE-9 + BE-11)"
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
  /** BE-7: on-disk install path for browser-relay-server.js. */
  BE7_BROWSER_RELAY_PATH: "/home/openclaw/scripts/browser-relay-server.js",
  /** BE-7: on-disk install path for check-skill-updates.sh. */
  BE7_CHECK_SKILL_UPDATES_PATH: "/home/openclaw/scripts/check-skill-updates.sh",
  /** BE-7: cron-line fragment for the daily 3am UTC skill-updates check. */
  BE7_CRON_FRAGMENT: "0 3 * * * /bin/bash $HOME/scripts/check-skill-updates.sh",
  /** BE-11: pinned agentkit-cli version (must match lib/ssh.ts:7047). */
  BE11_AGENTKIT_PIN: "@worldcoin/agentkit-cli@0.1.3",
  /** BE-11: mcporter install sentinel — the literal install argument. */
  BE11_MCPORTER: "npm install -g mcporter",
  /** BE-11: usecomputer install sentinel. */
  BE11_USECOMPUTER: "npm install -g usecomputer",
  /** BE-11: usecomputer binary chmod for prebuilt linux-x64 binary. */
  BE11_USECOMPUTER_CHMOD: "chmod +x \"$UC_BIN\"",
  /** BE-9: mcporter add target — the clawlancer MCP server. */
  BE9_MCPORTER_ADD_NAME: "mcporter config add clawlancer",
  /** BE-9: canonical clawlancer command (npx -y clawlancer-mcp). */
  BE9_CLAWLANCER_COMMAND: '"npx -y clawlancer-mcp"',
  /** BE-9: verify-after-add primitive — config get exits 0 iff registered. */
  BE9_VERIFY: "mcporter config get clawlancer",
} as const;
