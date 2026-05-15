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
 *   - [✓] BE-5: skill clones + overlays (bankr, consensus, edge_city)
 *   - [ ] BE-6: @bankr/cli pinned install
 *   - [✓] BE-7: browser-relay-server.js + check-skill-updates.sh + cron
 *   - [ ] BE-8: agent-status + clawlancer SKILL.md
 *   - [✓] BE-9: mcporter clawlancer config
 *   - [✓] BE-10: pip install §17b.2 packages
 *   - [✓] BE-11: npm install §17b.2 packages
 *   - [✓] BE-12: xvfb/x11vnc/websockify systemd units (defensive idempotent)
 *   - [✓] BE-13: daemon-reload (folded into BE-12)
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

import { BANKR_SKILL_PATCH_MARKER } from "./ssh";
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
# 2026-05-15: agentbookAddress is now optional (Day 9-10 — on-VM-gen path
# omits it). TypeScript template literals render undefined as the literal
# string "undefined", which would corrupt the bash variable and the
# callback POST payload ("agentbookAddress":"undefined"). Coerce undefined
# → empty string here so the bash variable is "" and the callback POST
# sends "agentbookAddress":"" — which the receiver (Day 11-12 endpoint)
# skips, leaving instaclaw_vms.agentbook_wallet_address NULL until a
# future setup.sh on-VM derivation step (or a backfill cron) populates it.
AGENTBOOK_ADDRESS="${p.agentbookAddress ?? ""}"

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
# §1.7 BEST_EFFORT [BE-5]: clone external skills + apply InstaClaw overlays
# ════════════════════════════════════════════════════════════════════════
# Three external git-cloned skills. Each gets idempotent clone-if-missing
# + skill-specific overlays + auto-update cron (where applicable).
#
#   1. Bankr (universal) — github.com/BankrBot/skills
#      Snapshot already has it cloned (verified 2026-05-14 vm-944). The
#      idempotency check skips the clone on every existing snapshot.
#      But the snapshot does NOT apply InstaClaw's overlay — every
#      fleet VM today lacks the \`INSTACLAW_BANKR_PATCH_V1\` marker AND
#      has the clanker + base subdirs still present (misroute the agent
#      because clanker requires PRIVATE_KEY not configured on InstaClaw
#      and base is an empty placeholder). This block:
#       a) Deletes clanker + base unconditionally (idempotent — rm -rf
#          on absent dirs is a no-op).
#       b) Prepends BANKR_SKILL_PATCH_DIRECTIVE to bankr/bankr/SKILL.md
#          if marker absent. Atomic write via mktemp + cat + mv chain.
#          Re-runs are no-ops via the grep -q marker check.
#
#   2. Consensus 2026 (universal) — github.com/coopergwrenn/consensus-2026-skill.git
#      Cloned per signup (snapshot does NOT have it — verified 2026-
#      05-14). 30-min auto-update cron keeps the agenda/side-event
#      data fresh (repo re-bakes hourly via GitHub Actions). Cron
#      install idempotent via grep -v + re-add.
#
#   3. Edge Esmeralda (partner=edge_city only) — github.com/aromeoes/edge-agent-skill.git
#      Partner-gated via TARBALL FILE PRESENCE: buildPartnerOverlays
#      emits \`overlays/edge-instaclaw-overlay.md\` ONLY when partner
#      === "edge_city". setup.sh's \`if [ -f /tmp/.../edge-instaclaw-
#      overlay.md ]\` guard IS the partner gate. Inside, clone +
#      INSTACLAW_OVERLAY.md write (atomic via .tmp + mv; Tule's
#      upstream \`git pull --ff-only\` leaves untracked files alone) +
#      30-min auto-update cron. NO .env mutation here — Day 8a §1.6
#      already places EDGEOS_BEARER_TOKEN via the tarball's buildDotEnv.
#
# What breaks if BE-5 fails:
#   - Bankr overlay missing: agent has bankr SKILL.md but lacks the
#     InstaClaw-specific routing context → \`bankr launch\` may misroute.
#   - clanker/base subdirs present: agent reads them, gets confused
#     about which sub-skill to use, especially when the user asks
#     about "tokens" — could attempt clanker flow and fail on
#     missing PRIVATE_KEY.
#   - Consensus clone missing: agent can't answer "what's on the
#     Consensus agenda?" Loses universal feature.
#   - Edge clone missing (edge_city VMs only): Edge attendees can't
#     query the agenda, attendees, side events.
#
# CHAIN DISCIPLINE: rc-accumulator inside \`sudo -u openclaw bash -lc\`.
# \`set -e\` is suspended inside \`{ } || handler\` (Bug #1), so we use
# per-operation \`|| rc=1\` + terminal \`[ "\$rc" = "0" ]\`.
#
# Empirical verification (2026-05-14, vm-944):
#   - Consensus clone: <1s, SKILL.md 27041 bytes
#   - Edge clone: <1s, SKILL.md 8971 bytes
#   - Bankr overlay logic: first-run applies (marker added), second-run
#     skips (marker found) — atomic mv preserves SKILL.md on partial fail
#
# Runs as openclaw user (sudo -u + bash -lc) — same pattern as BE-7/
# BE-9/BE-10/BE-11. git clones land at the right ownership without
# explicit chown.
#
# NOT reconciler-healed today. Future P1 (matches the BE-11 fleet-
# heal pattern in commit bb12558d): add a reconciler step that
# applies bankr overlay + clones consensus + clones edge (when partner=
# edge_city). Existing fleet still missing these until then.
{ sudo -u openclaw bash -lc '
    rc=0

    # ── Bankr (universal) — clone, delete misroute subdirs, apply overlay ──
    if [ ! -d "\$HOME/.openclaw/skills/bankr" ]; then
      timeout 60 git clone --depth 1 https://github.com/BankrBot/skills "\$HOME/.openclaw/skills/bankr" 2>/dev/null || rc=1
    fi
    BANKR_SKILL_BASE="\$HOME/.openclaw/skills/bankr"
    BANKR_SKILL_MD="\$BANKR_SKILL_BASE/bankr/SKILL.md"
    if [ -d "\$BANKR_SKILL_BASE" ]; then
      # Idempotent subdir removal. clanker needs PRIVATE_KEY (not configured
      # on InstaClaw VMs); base is an empty placeholder. rm -rf on absent
      # dir is a no-op, so this is safe to re-run on every cycle.
      rm -rf "\$BANKR_SKILL_BASE/clanker" "\$BANKR_SKILL_BASE/base" 2>/dev/null || true
    fi
    if [ -f "\$BANKR_SKILL_MD" ] && ! grep -q "${BANKR_SKILL_PATCH_MARKER}" "\$BANKR_SKILL_MD"; then
      # Atomic overlay-prepend: mktemp → cat overlay → cat SKILL.md →
      # mv tmp to SKILL.md. && -chain so any failure aborts cleanly and
      # leaves SKILL.md untouched.
      BANKR_OVERLAY_TMP=\$(mktemp 2>/dev/null) \\
        && cat /tmp/instaclaw-config/overlays/bankr-overlay.md > "\$BANKR_OVERLAY_TMP" \\
        && cat "\$BANKR_SKILL_MD" >> "\$BANKR_OVERLAY_TMP" \\
        && mv "\$BANKR_OVERLAY_TMP" "\$BANKR_SKILL_MD" \\
        || rc=1
    fi

    # ── Consensus 2026 (universal) — clone + 30-min auto-update cron ──
    if [ ! -d "\$HOME/.openclaw/skills/consensus-2026" ]; then
      timeout 60 git clone --depth 1 https://github.com/coopergwrenn/consensus-2026-skill.git "\$HOME/.openclaw/skills/consensus-2026" 2>/dev/null || rc=1
    fi
    # Verify-after-clone: SKILL.md at top level (Rule 24 #1).
    [ -f "\$HOME/.openclaw/skills/consensus-2026/SKILL.md" ] || rc=1
    # Idempotent cron install: strip any prior entry (both legacy
    # "consensus-2026-skill" and current "skills/consensus-2026"
    # patterns — matches lib/ssh.ts:5560 byte-parity), then re-add.
    # \$HOME expands at assignment time → stored crontab line has
    # /home/openclaw literal (matches the BE-7 pattern).
    CRON_CONSENSUS="*/30 * * * * cd \$HOME/.openclaw/skills/consensus-2026 && git pull --ff-only -q 2>/dev/null"
    (crontab -l 2>/dev/null | grep -v "consensus-2026-skill" | grep -v "skills/consensus-2026"; echo "\$CRON_CONSENSUS") | crontab - 2>/dev/null || rc=1

    # ── Edge Esmeralda (partner=edge_city) — clone + overlay + cron ──
    # Partner gate: tarball emits overlays/edge-instaclaw-overlay.md
    # ONLY when partner=edge_city. File presence IS the gate.
    if [ -f /tmp/instaclaw-config/overlays/edge-instaclaw-overlay.md ]; then
      if [ ! -d "\$HOME/.openclaw/skills/edge-esmeralda" ]; then
        timeout 60 git clone --depth 1 https://github.com/aromeoes/edge-agent-skill.git "\$HOME/.openclaw/skills/edge-esmeralda" 2>/dev/null || rc=1
      fi
      # Verify-after-clone (Rule 24 #1).
      [ -f "\$HOME/.openclaw/skills/edge-esmeralda/SKILL.md" ] || rc=1
      # InstaClaw overlay write. Atomic via .tmp + mv. The upstream
      # git pull --ff-only leaves untracked files alone, so the overlay
      # survives across auto-update pulls.
      if [ -d "\$HOME/.openclaw/skills/edge-esmeralda" ]; then
        EDGE_OVERLAY_TMP="\$HOME/.openclaw/skills/edge-esmeralda/INSTACLAW_OVERLAY.md.tmp"
        cp /tmp/instaclaw-config/overlays/edge-instaclaw-overlay.md "\$EDGE_OVERLAY_TMP" \\
          && mv "\$EDGE_OVERLAY_TMP" "\$HOME/.openclaw/skills/edge-esmeralda/INSTACLAW_OVERLAY.md" \\
          || rc=1
      fi
      # Auto-update cron (idempotent install — matches lib/ssh.ts:5531
      # byte-parity).
      CRON_EDGE="*/30 * * * * cd \$HOME/.openclaw/skills/edge-esmeralda && git pull --ff-only -q 2>/dev/null"
      (crontab -l 2>/dev/null | grep -v "edge-agent-skill"; echo "\$CRON_EDGE") | crontab - 2>/dev/null || rc=1
    fi

    [ "\$rc" = "0" ]
  '
} || echo "[\$(date -u +%FT%TZ)] WARN: BE-5 (skill clones + InstaClaw overlays) partial failure. bankr overlay absence misroutes the agent on token / launch flows. consensus-2026 clone absence loses the universal Consensus 2026 agenda awareness. edge-esmeralda clone absence (edge_city only) breaks Edge attendee directory + agenda queries. NOT reconciler-healed today — manual fleet-push to recover until a reconciler step lands."

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
  # 2026-05-15: dual-source. The legacy SSH-configure path and explicit-key
  # callers pre-pack agent.key in the tarball — install it as before. The
  # cloud-init bootstrap+fetch path (post-decision "no private keys in our
  # DB ever") omits agent.key from the tarball and generates a fresh 32-byte
  # hex private key here via openssl rand. Either source yields the same
  # final state: /home/openclaw/.openclaw/wallet/agent.key, mode 600,
  # owned by openclaw:openclaw. CLOUD_INIT_AGENT_KEY_ONVM_GEN sentinel.
  #
  # Address derivation is intentionally NOT done here. Computing an EVM
  # address from a 32-byte secp256k1 private key requires keccak256(public
  # key) which isn't in stdlib openssl (Ethereum uses pre-standard Keccak,
  # not SHA3-256). node+viem and python+eth_account both work but aren't
  # in this CRITICAL block's hot-path dependency surface. A future cloud-
  # init-callback enhancement (Day 11-12) will derive on-VM and POST the
  # address to backfill instaclaw_vms.agentbook_wallet_address.
  if [ -f /tmp/instaclaw-config/home/openclaw/.openclaw/wallet/agent.key ]; then
    install -o openclaw -g openclaw -m 600 \\
      /tmp/instaclaw-config/home/openclaw/.openclaw/wallet/agent.key \\
      /home/openclaw/.openclaw/wallet/agent.key || rc=1
  else
    # umask 077 in subshell ensures the > redirect creates the file at
    # mode 600 directly (no transient world-readable window). The chown
    # finalizes ownership (file is initially root-owned since setup.sh
    # runs as root in cloud-init). chmod 600 is defensive — umask should
    # already cover it but verify.
    (umask 077 && openssl rand -hex 32 > /home/openclaw/.openclaw/wallet/agent.key) || rc=1
    chown openclaw:openclaw /home/openclaw/.openclaw/wallet/agent.key || rc=1
    chmod 600 /home/openclaw/.openclaw/wallet/agent.key || rc=1
  fi

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
# §1.21-23 BEST_EFFORT [BE-12 + BE-13]: defensive idempotent install of
#       VNC pipeline — xvfb / x11vnc / websockify systemd units +
#       apt deps + openbox bg + live-tokens placeholder + ufw / iptables
#       + Caddyfile /vnc/ patch
# ════════════════════════════════════════════════════════════════════════
# DEFENSIVE only. Empirically verified 2026-05-15 (vm-944 + vm-050) that
# the current snapshot has everything BE-12 would install: all 3 unit
# files present + active, all apt deps installed (xvfb, openbox,
# x11vnc, websockify, novnc, imagemagick), ufw + iptables rules in
# place. §17b.2 of the snapshot-bake-requirements doc claimed these
# unit files were MISSING — that audit was based on an older snapshot
# (or was outdated by the time BE-N work started).
#
# Why ship BE-12 anyway: defense against snapshot drift. If a future
# bake stops including these unit files (e.g., a new base image
# stripped them), BE-12 fills the gap. Every operation is idempotent —
# zero functional impact on the current fleet.
#
# Operations (dependency order, matching lib/ssh.ts:7107-7188):
#   1. apt install (idempotent — apt no-op when installed)
#   2. Write /etc/systemd/system/xvfb.service (canonical heredoc;
#      byte-identical to existing snapshot content per probe)
#   3. Write /etc/systemd/system/x11vnc.service
#   4. Write /etc/systemd/system/websockify.service
#   5. systemctl daemon-reload (BE-13 from the original plan, folded
#      here since BE-12 is the only thing that wants it)
#   6. enable + start all 3 services (idempotent on active services)
#   7. Start openbox window manager as openclaw user (DISPLAY=:99,
#      background; idempotent via pgrep check)
#   8. mkdir ~/.vnc + live-tokens placeholder file (websockify reads it)
#   9. ufw + iptables for port 6080 (VNC websocket) + 8765 (dispatch)
#      — idempotent
#  10. Caddyfile /vnc/ patch (guarded on file presence — Caddy is
#      installed separately via installCaddyTls for custom-domain
#      users only; the snapshot does not include Caddy, so this step
#      no-ops on most VMs)
#
# This block runs as ROOT (setup.sh's outer context — no \`sudo -u
# openclaw bash -lc\` wrapper because we need root for /etc/systemd
# writes + apt + systemctl daemon-reload + ufw + iptables). Where
# openclaw-user operations are needed (openbox, live-tokens), \`sudo -u
# openclaw\` is used inline.
#
# Rc-accumulator pattern. Local-operation failures (apt, systemd writes,
# daemon-reload, enable/start) push to result.errors → cv stays put on
# next reconcile cycle. Caddyfile patch is best-effort-skip-on-absence.
#
# NOT reconciler-healed today. If snapshot drift ever removes these
# files, the gap surfaces on the next fresh-VM provision (the cloud-
# init endpoint, which isn't live yet). For existing fleet: no impact
# (already has everything per empirical verification).
{
  rc=0

  # 1. apt install (defensive — every package already installed on
  # current snapshot per the 2026-05-15 probe). Idempotent: apt-get
  # install on satisfied packages is a no-op that exits 0 in <2s.
  timeout 180 apt-get install -y -qq \\
    xvfb xdotool libx11-dev libxext-dev libxtst-dev libpng-dev \\
    openbox imagemagick x11vnc websockify novnc \\
    >/dev/null 2>&1 || rc=1

  # 2. xvfb.service — virtual display at :99 (1280x720x24).
  # Heredoc body byte-identical to lib/ssh.ts:7118-7128.
  cat > /etc/systemd/system/xvfb.service << 'XVFBEOF'
[Unit]
Description=Xvfb Virtual Display for Dispatch Mode
After=network.target
[Service]
Type=simple
User=openclaw
ExecStart=/usr/bin/Xvfb :99 -screen 0 1280x720x24 -ac
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
XVFBEOF

  # 3. x11vnc.service — VNC server bound to Xvfb display :99.
  # Heredoc body byte-identical to lib/ssh.ts:7142-7154.
  cat > /etc/systemd/system/x11vnc.service << 'X11EOF'
[Unit]
Description=x11vnc VNC Server for Xvfb
After=xvfb.service
[Service]
Type=simple
User=openclaw
Environment=DISPLAY=:99
ExecStart=/usr/bin/x11vnc -display :99 -forever -shared -rfbport 5901 -localhost -noxdamage -nopw
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
X11EOF

  # 4. websockify.service — VNC-to-WebSocket bridge on port 6080.
  # Heredoc body byte-identical to lib/ssh.ts:7158-7169.
  cat > /etc/systemd/system/websockify.service << 'WSEOF'
[Unit]
Description=websockify VNC-to-WebSocket bridge
After=x11vnc.service
[Service]
Type=simple
User=openclaw
ExecStart=/usr/bin/websockify --web=/usr/share/novnc/ --token-plugin ReadOnlyTokenFile --token-source /home/openclaw/.vnc/live-tokens 6080
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
WSEOF

  # 5. daemon-reload picks up the unit-file changes (BE-13 from plan
  # — folded here since BE-12 is the only thing that needs it).
  systemctl daemon-reload || rc=1

  # 6. enable + start all 3 services. Idempotent: enable adds a
  # symlink if missing (no-op when already symlinked); start is a
  # no-op when service is already active.
  for svc in xvfb x11vnc websockify; do
    systemctl enable "\$svc" 2>/dev/null || rc=1
    systemctl is-active "\$svc" >/dev/null 2>&1 || systemctl start "\$svc" 2>/dev/null || rc=1
  done

  # 7. Start openbox window manager as openclaw user on DISPLAY=:99.
  # Idempotent: pgrep skips if already running. nohup + & detaches
  # so setup.sh proceeds without waiting.
  sudo -u openclaw bash -c 'pgrep -x openbox >/dev/null || (DISPLAY=:99 nohup openbox >/dev/null 2>&1 &)' || true

  # 8. ~/.vnc/live-tokens placeholder (websockify reads it; empty =
  # no VNC connections allowed until a live-session generates one).
  sudo -u openclaw mkdir -p /home/openclaw/.vnc
  sudo -u openclaw bash -c '[ -f /home/openclaw/.vnc/live-tokens ] || echo "# live session tokens" > /home/openclaw/.vnc/live-tokens'

  # 9. ufw + iptables for VNC websocket (6080) and dispatch (8765).
  # Idempotent: ufw allow on existing rule is a no-op; iptables -C
  # checks presence before -I insert. Errors swallowed because ufw
  # may not be active on every VM.
  ufw allow 6080/tcp >/dev/null 2>&1 || true
  ufw allow 8765/tcp >/dev/null 2>&1 || true
  iptables -C INPUT -p tcp --dport 6080 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport 6080 -j ACCEPT 2>/dev/null || true
  iptables -C INPUT -p tcp --dport 8765 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport 8765 -j ACCEPT 2>/dev/null || true

  # 10. Caddyfile /vnc/ proxy patch. Guarded on Caddyfile existence
  # — Caddy is installed only when the user adds a custom domain
  # (via installCaddyTls, not configureOpenClaw). The snapshot does
  # not include /etc/caddy/Caddyfile. When present, idempotent grep
  # skips re-add.
  if [ -f /etc/caddy/Caddyfile ] && ! grep -q "/vnc/" /etc/caddy/Caddyfile 2>/dev/null; then
    sed -i '/reverse_proxy localhost:18789/i \\  handle /vnc/* {\\n    uri strip_prefix /vnc\\n    reverse_proxy localhost:6080\\n  }' /etc/caddy/Caddyfile || rc=1
    systemctl reload caddy 2>/dev/null || true
  fi

  [ "\$rc" = "0" ]
} || echo "[\$(date -u +%FT%TZ)] WARN: BE-12 (VNC pipeline + ufw/iptables + Caddyfile /vnc/ patch) partial failure — current snapshot has everything in place, so this WARN only fires on snapshot drift. Without it: browser/dispatch mode features (live desktop viewer, VNC streaming) broken. Recovery: SSH and run the BE-12 bash from setup.sh, or wait for stepCaddyUIBlock (if applicable)."

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
# §1.17 BEST_EFFORT [BE-10]: pip install §17b.2 Python packages
# ════════════════════════════════════════════════════════════════════════
# Installs the Python deps that several skills depend on:
#   - crawlee[beautifulsoup,playwright]==1.5.0 (web-search-browser skill)
#   - web3, py-clob-client, eth-account, websockets, cryptography
#     (polymarket + AgentBook + prediction-markets stack)
#   - solders, base58, httpx (solana-defi stack)
#
# Same masked-failure pattern as BE-11: configureOpenClaw's parallel
# pip installs at lib/ssh.ts:7035-7051 use \`|| true\` which silently
# swallowed every install failure. Empirically verified on vm-944
# (2026-05-14): 7 of 9 §17b.2 packages were MISSING (cryptography +
# httpx came from a system-pre-install). Without these:
#   - web-search-browser skill: crawlee scrape-fallback fails
#   - prediction-markets (Polymarket / Kalshi): every trade call fails
#   - AgentBook (web3 + eth-account): registration impossible
#   - solana-defi: Solana RPC calls fail
#
# Idempotency: per-package \`pip show\` probe before install. crawlee
# additionally checks the version is exactly 1.5.0 (the load-bearing
# pin — crawlee 2.x has an incompatible API; web-search-browser
# breaks on it). Extras [beautifulsoup,playwright] are install-time
# only and persist once added — repeated \`pip install crawlee==1.5.0\`
# without extras won't remove them.
#
# Empirical install times (2026-05-14, vm-944, warm cache):
#   crawlee+extras: 5.3s
#   web3+4 others: 6.3s
#   solders+2 others: 1.4s
# Total: ~13s warm cache. 300s/180s timeouts give plenty of headroom
# for cold cache or slow network.
#
# Rc-accumulator inside sudo -u openclaw bash -lc (matches BE-11
# pattern). \`set -e\` is suspended inside \`{ } || handler\` (Bug #1),
# so per-package \`|| rc=1\` + terminal \`[ "\$rc" = "0" ]\` is the only
# pattern that correctly catches single-package failures.
#
# Pip bootstrap (first line): only runs if pip is missing. The
# snapshot already has pip 26+, so this is a no-op in practice —
# defensive against a future snapshot variant where pip isn't
# pre-installed (matches lib/ssh.ts:7025).
#
# NOT reconciler-healed today. Future P1: extend stepPythonPackages
# (lib/vm-reconcile.ts:3324) to cover these — mirrors the BE-11
# follow-up (commit bb12558d) that extended stepNpmPinDrift for npm
# globals. Existing fleet still missing these packages until then.
{ sudo -u openclaw bash -lc '
    # pip bootstrap (no-op when already present — every current snapshot has pip 26+)
    python3 -m pip --version >/dev/null 2>&1 || \\
      (curl -sS https://bootstrap.pypa.io/get-pip.py 2>/dev/null | python3 - --break-system-packages --quiet 2>/dev/null) || \\
      true

    rc=0

    # crawlee — PINNED 1.5.0. The web-search-browser skill imports
    # crawlee at a 1.x-compatible API; crawlee 2.x ships a breaking
    # change. Pinning is load-bearing for that skill.
    if ! python3 -m pip show crawlee 2>/dev/null | grep -q "^Version: 1.5.0\$"; then
      timeout 300 python3 -m pip install --quiet --break-system-packages "crawlee[beautifulsoup,playwright]==1.5.0" >/dev/null 2>&1 || rc=1
      python3 -m pip show crawlee 2>/dev/null | grep -q "^Version: 1.5.0\$" || rc=1
    fi

    # Group 2 (unpinned): polymarket + AgentBook + prediction-markets stack.
    for pkg in web3 py-clob-client eth-account websockets cryptography; do
      if ! python3 -m pip show "\$pkg" >/dev/null 2>&1; then
        timeout 180 python3 -m pip install --quiet --break-system-packages "\$pkg" >/dev/null 2>&1 || rc=1
        python3 -m pip show "\$pkg" >/dev/null 2>&1 || rc=1
      fi
    done

    # Group 3 (unpinned): solana-defi stack.
    for pkg in solders base58 httpx; do
      if ! python3 -m pip show "\$pkg" >/dev/null 2>&1; then
        timeout 180 python3 -m pip install --quiet --break-system-packages "\$pkg" >/dev/null 2>&1 || rc=1
        python3 -m pip show "\$pkg" >/dev/null 2>&1 || rc=1
      fi
    done

    [ "\$rc" = "0" ]
  '
} || echo "[\$(date -u +%FT%TZ)] WARN: BE-10 (pip install §17b.2 packages) partial failure — NOT reconciler-healed today. crawlee absence: web-search-browser skill scrape-fallback breaks. web3 / eth-account absence: AgentBook registration + prediction-markets broken. solders / base58 absence: solana-defi broken. Manual fleet-push to recover until stepPythonPackages is extended (P1)."

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
# Done: BE-1 (linger + sshd OOM-protect), BE-5 (skill clones + InstaClaw
# overlays: bankr + consensus + edge_city), BE-7 (browser-relay-server.js
# + check-skill-updates.sh + cron), BE-8 (agent-status + clawlancer
# SKILL.md via repo check-in), BE-9 (mcporter clawlancer config),
# BE-10 (pip install §17b.2 packages), BE-11 (npm install agentkit-cli
# + mcporter + usecomputer), BE-12+BE-13 (defensive idempotent VNC
# pipeline — xvfb/x11vnc/websockify units + apt deps + openbox +
# ufw/iptables + Caddyfile /vnc/ patch + daemon-reload folded).
# Pending (all skip/cosmetic/redundant): BE-2 (mkdir defenses), BE-3
# (privacy wipe), BE-4 (stop pre-existing gateway — redundant with
# §1.32 restart), BE-6 (@bankr/cli — reconciler heals via
# stepNpmPinDrift).
# All landed BEST_EFFORT steps follow:
#   { ... } || echo "[\$(date -u +%FT%TZ)] WARN: BE-N (label) — recovery"

echo "[\$(date -u +%FT%TZ)] setup.sh complete (CRITICAL + BE-1 + BE-5 + BE-7 + BE-9 + BE-10 + BE-11 + BE-12)"
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
  /** 2026-05-15: dual-source agent.key install (tarball-supplied OR on-VM
   *  openssl-generated). Anchor for tests asserting the on-VM-gen branch
   *  is present in the rendered setup.sh. Rule 23 sentinel. */
  AGENT_KEY_DUAL_SOURCE: "CLOUD_INIT_AGENT_KEY_ONVM_GEN",
  /** 2026-05-15: the actual openssl-rand command for on-VM key generation.
   *  If this drifts (e.g., someone "improves" to use a different RNG),
   *  tests will fail because the rendered output no longer contains this
   *  exact substring. */
  AGENT_KEY_OPENSSL_RAND: "openssl rand -hex 32 > /home/openclaw/.openclaw/wallet/agent.key",
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
  /** BE-10: pinned crawlee version (load-bearing — web-search-browser skill). */
  BE10_CRAWLEE_PIN: "crawlee[beautifulsoup,playwright]==1.5.0",
  /** BE-10: pip install pattern for unpinned packages. */
  BE10_PIP_INSTALL: "python3 -m pip install --quiet --break-system-packages",
  /** BE-10: per-package verify-after-install via pip show. */
  BE10_PIP_VERIFY: "python3 -m pip show",
  /** BE-5: bankr skill repo URL. */
  BE5_BANKR_REPO: "https://github.com/BankrBot/skills",
  /** BE-5: consensus-2026 skill repo URL. */
  BE5_CONSENSUS_REPO: "https://github.com/coopergwrenn/consensus-2026-skill.git",
  /** BE-5: edge-esmeralda skill repo URL (partner=edge_city only). */
  BE5_EDGE_REPO: "https://github.com/aromeoes/edge-agent-skill.git",
  /** BE-5: bankr overlay idempotency marker. */
  BE5_BANKR_MARKER: BANKR_SKILL_PATCH_MARKER,
  /** BE-5: 30-min auto-update cron schedule. */
  BE5_CRON_SCHEDULE: "*/30 * * * *",
  /** BE-5: partner-gate via tarball file presence. */
  BE5_PARTNER_GATE: "/tmp/instaclaw-config/overlays/edge-instaclaw-overlay.md",
  /** BE-12: canonical xvfb systemd unit path. */
  BE12_XVFB_SERVICE_PATH: "/etc/systemd/system/xvfb.service",
  /** BE-12: canonical x11vnc systemd unit path. */
  BE12_X11VNC_SERVICE_PATH: "/etc/systemd/system/x11vnc.service",
  /** BE-12: canonical websockify systemd unit path. */
  BE12_WEBSOCKIFY_SERVICE_PATH: "/etc/systemd/system/websockify.service",
  /** BE-12: VNC websocket port (websockify listens here for /vnc/* requests). */
  BE12_VNC_PORT: "6080",
  /** BE-12: canonical display number for Xvfb + openbox + x11vnc. */
  BE12_DISPLAY: "DISPLAY=:99",
  /** BE-12: live-tokens path that websockify reads. */
  BE12_LIVE_TOKENS_PATH: "/home/openclaw/.vnc/live-tokens",
  /** BE-12: Caddy proxy-block guard (only patch when Caddy is installed). */
  BE12_CADDY_GUARD: "[ -f /etc/caddy/Caddyfile ]",
} as const;
