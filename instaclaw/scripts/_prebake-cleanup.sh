#!/usr/bin/env bash
# _prebake-cleanup.sh — Snapshot-bake VM cleanup (reusable, idempotent).
#
# Purpose
#   Wipe ALL per-VM state and disk bloat from a VM that is about to be imaged
#   into a Linode snapshot. The audit at instaclaw/docs/vm050-snapshot-audit
#   enumerates 30+ categories of contamination — this script handles every one.
#
# Sister tools (DO NOT confuse)
#   lib/ssh.ts:wipeVMForNextUser  — runtime wipe between paying customers.
#                                    Smaller scope; doesn't touch secrets, gbrain
#                                    PGLite, system caches, /var/log, etc.
#   _prebake-cleanup.sh (this)    — pre-snapshot wipe. Goes much deeper.
#                                    Safe to run only on a bake-mode VM.
#
# Safety
#   - Refuses to run unless `--confirm` or `--dry-run` is passed.
#   - With `--confirm`, refuses unless `~/.snapshot-bake-mode` marker exists,
#     UNLESS `--force` is also passed.
#   - Refuses to run if the gateway has had user activity in the last hour
#     (heuristic: any session jsonl newer than 1h), UNLESS `--force`.
#   - Never deletes /etc/ssh/ssh_host_* or /etc/machine-id (per CLAUDE.md;
#     cloud-init regenerates these on first boot from snapshot).
#   - Never deletes installed binaries (node, openclaw, bun, gbrain, chromium).
#   - Never deletes systemd unit files or unit drop-ins (other than .predit-*
#     and .bak backups of drop-ins).
#   - Sudo is required (we wipe /var/log + journal + apt cache). Script aborts
#     if `sudo -n true` fails.
#
# Usage
#   Dry-run preview (default — paranoid):
#     bash _prebake-cleanup.sh --dry-run
#
#   Real wipe (operator marks the VM as bake-mode first):
#     touch ~/.snapshot-bake-mode
#     bash _prebake-cleanup.sh --confirm
#
#   Override safety checks (only for rescue mode):
#     bash _prebake-cleanup.sh --confirm --force
#
# Flags
#   --dry-run            Print every action; no file changes. Mutex with --confirm.
#   --confirm            Actually delete. Mutex with --dry-run.
#   --force              Skip the marker + activity safety checks.
#   --keep-playwright    (default) Keep ~/.cache/ms-playwright (~622MB) — agents
#                        need Chromium browsers preinstalled.
#   --no-playwright      Wipe Playwright cache (re-downloads on demand).
#   --keep-skills        (default) Keep ~/.openclaw/skills/* (canonical state).
#   --wipe-all-skills    Remove all skills (forces re-clone on first reconcile).
#   --quiet              Less verbose. Section headers only.
#   -h, --help           Show this help.
#
# Exit codes
#   0  success
#   1  argument error
#   2  safety check failed (refused to run)
#   3  pre-flight: sudo missing
#   4  cleanup completed with errors (some operations failed)

set -uo pipefail

# ─── flags ──────────────────────────────────────────────────────────────────
DRY_RUN=false
CONFIRM=false
FORCE=false
KEEP_PLAYWRIGHT=true
KEEP_SKILLS=true
QUIET=false

usage() { sed -n '2,/^$/p' "$0" | sed 's/^# \?//'; }
die() { echo "FATAL: $*" >&2; exit "${2:-1}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)            DRY_RUN=true ;;
    --confirm)            CONFIRM=true ;;
    --force)              FORCE=true ;;
    --keep-playwright)    KEEP_PLAYWRIGHT=true ;;
    --no-playwright)      KEEP_PLAYWRIGHT=false ;;
    --keep-skills)        KEEP_SKILLS=true ;;
    --wipe-all-skills)    KEEP_SKILLS=false ;;
    --quiet)              QUIET=true ;;
    -h|--help)            usage; exit 0 ;;
    *)                    die "unknown arg: $1" 1 ;;
  esac
  shift
done

$DRY_RUN || $CONFIRM || die "must pass --dry-run or --confirm" 1
$DRY_RUN && $CONFIRM && die "--dry-run and --confirm are mutually exclusive" 1

# ─── logging helpers ────────────────────────────────────────────────────────
TS() { date -u +'%H:%M:%S'; }
hdr() { echo; echo "═══ [$(TS)] $* ═══"; }
log() { $QUIET || echo "  [$(TS)] $*"; }
warn() { echo "  [$(TS)] ⚠ $*" >&2; }

# Track errors but never abort
ERRORS=0
run() {
  local label="$1"; shift
  if $DRY_RUN; then
    log "[DRY] $label: $*"
    return 0
  fi
  log "$label"
  if ! eval "$@" 2>/tmp/_prebake.err; then
    local rc=$?
    warn "$label exited with $rc: $(cat /tmp/_prebake.err 2>/dev/null | head -1)"
    ERRORS=$((ERRORS + 1))
  fi
  rm -f /tmp/_prebake.err
}

# Safe rm — never errors on missing files
rmf() {
  if $DRY_RUN; then
    for path in "$@"; do echo "  [DRY] rm -rf $path"; done
    return 0
  fi
  rm -rf "$@" 2>/dev/null || true
}

# Safe truncate
trunc() {
  if $DRY_RUN; then
    for path in "$@"; do echo "  [DRY] truncate -s 0 $path"; done
    return 0
  fi
  sudo truncate -s 0 "$@" 2>/dev/null || true
}

# ─── pre-flight ─────────────────────────────────────────────────────────────
hdr "Pre-flight"

# sudo check
if ! sudo -n true 2>/dev/null; then
  warn "Cached sudo missing — script needs sudo for /var/log + apt + journal."
  warn "Run \`sudo -v\` first, then re-run this script."
  exit 3
fi

# Safety: bake-mode marker
if $CONFIRM && ! $FORCE; then
  if [[ ! -f "$HOME/.snapshot-bake-mode" ]]; then
    die "Refusing: ~/.snapshot-bake-mode marker missing.
       Create it on the bake VM: touch ~/.snapshot-bake-mode
       Or override: --force" 2
  fi
fi

# Safety: recent user activity
if $CONFIRM && ! $FORCE; then
  recent=$(find "$HOME/.openclaw/agents/main/sessions" -maxdepth 1 -type f -name '*.jsonl' -mmin -60 2>/dev/null | head -1 || true)
  if [[ -n "$recent" ]]; then
    die "Refusing: recent user activity detected (session $recent modified < 1h).
       This looks like a live customer VM, not a bake VM. Override: --force" 2
  fi
fi

# Disk usage BEFORE
hdr "Disk usage BEFORE"
df -BM / | tail -1
$QUIET || du -BM -d 1 / 2>/dev/null | sort -rn | head -8

# ─── 1. Stop running services that hold file locks ──────────────────────────
hdr "1. Stop services (gateway + crons + browser)"
if $CONFIRM; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
  # User-level services — `--user` is correct (run under the openclaw user's
  # systemd-user instance).
  for svc in openclaw-gateway browser-relay-server dispatch-server \
             acp-seller acp-serve session-migration; do
    systemctl --user stop "$svc.service" 2>/dev/null || true
  done
  # System-level services — installed at /etc/systemd/system/, need `sudo`.
  # The 2026-05-13 bake-readiness audit caught the prior `systemctl --user
  # stop x11vnc.service` here — silent no-op because x11vnc is system-scoped
  # per cloud-init-snapshot-bake-requirements §10. openbox typically isn't
  # a systemd unit (started from Xvfb session) so it's not in this list; the
  # pkill below handles any stray process.
  for svc in x11vnc websockify xvfb; do
    sudo systemctl stop "$svc.service" 2>/dev/null || true
  done
  pkill -9 -f 'chrome.*remote-debugging-port' 2>/dev/null || true
  pkill -9 -f 'chromium' 2>/dev/null || true
  pkill -9 -f 'Xvfb' 2>/dev/null || true
  pkill -9 -f 'x11vnc' 2>/dev/null || true
  pkill -9 -f 'openbox' 2>/dev/null || true
  pkill -9 -f 'gbrain' 2>/dev/null || true
  # Crontab handled in step 12 — leave intact for now so cleanup tools that
  # might rely on cron-installed binaries still resolve.
fi

# ─── 2. Wipe secrets (.env, auth-profiles, gateway token, MCP env keys) ─────
hdr "2. Wipe secrets"

# .env + every backup variant
rmf "$HOME/.openclaw/.env" \
    "$HOME/.openclaw/.env.bak" \
    "$HOME/.openclaw/.env.bak.envpush."* \
    "$HOME/.openclaw/.env.bak.path-a."* \
    "$HOME/.openclaw/gateway.systemd.env" \
    "$HOME/.openclaw/gateway.systemd.env.bak"*

# Auth profiles (Anthropic + OpenAI keys) and pair backup
rmf "$HOME/.openclaw/agents/main/agent/auth-profiles.json" \
    "$HOME/.openclaw/agents/main/agent/auth-profiles.json.bak."* \
    "$HOME/.openclaw/agents/main/agent/auth-state.json" \
    "$HOME/.openclaw/agents/main/agent/auth-state.json.bak"*

# XMTP wallet (private key)
rmf "$HOME/.openclaw/xmtp"

# Device pairing
rmf "$HOME/.openclaw/identity"

# Exec-approvals socket token (regenerated by configureOpenClaw)
rmf "$HOME/.openclaw/exec-approvals.json" \
    "$HOME/.openclaw/exec-approvals.sock"

# VNC live tokens
rmf "$HOME/.vnc/live-tokens" "$HOME/.vnc/passwd"

# ─── 3. Scrub openclaw.json — replace secrets with placeholders ─────────────
hdr "3. Scrub openclaw.json (keep schema, replace secrets)"
if $CONFIRM && [[ -f "$HOME/.openclaw/openclaw.json" ]]; then
  python3 - <<'PY'
import json, pathlib, re

p = pathlib.Path.home() / ".openclaw/openclaw.json"
d = json.loads(p.read_text())

# Gateway token — configureOpenClaw will set per-VM
gw = d.setdefault("gateway", {}).setdefault("auth", {})
if "token" in gw:
    gw["token"] = "REPLACE_ON_CONFIGURE"

SECRET_KEY_RE = re.compile(
    r"(api_?key|_KEY|_TOKEN|token|secret|password|private_?key)",
    re.IGNORECASE,
)

def scrub(node):
    if isinstance(node, dict):
        for k, v in list(node.items()):
            if isinstance(v, str) and SECRET_KEY_RE.search(k):
                node[k] = "REPLACE_ON_CONFIGURE"
            else:
                scrub(v)
    elif isinstance(node, list):
        for x in node:
            scrub(x)

# MCP server env (gbrain has Anthropic + OpenAI keys inline)
for sname, sval in d.get("mcp", {}).get("servers", {}).items():
    if isinstance(sval, dict):
        scrub(sval.get("env", {}))

# Plugin entries (brave search api key, etc.)
for pname, pval in d.get("plugins", {}).get("entries", {}).items():
    if isinstance(pval, dict):
        scrub(pval.get("config", {}))

p.write_text(json.dumps(d, indent=2) + "\n")
print("  scrubbed:", p)
PY
else
  log "[DRY] would scrub $HOME/.openclaw/openclaw.json secrets"
fi
# Remove every backup of the config file
rmf "$HOME/.openclaw/openclaw.json.bak"* \
    "$HOME/.openclaw/openclaw.json.clobbered."*

# ─── 4. Wipe user memory + sessions (Rule 22 compliant — bake context only) ─
hdr "4. Wipe sessions + per-user memory"
rmf "$HOME/.openclaw/agents/main/sessions" \
    "$HOME/.openclaw/agents/main/sessions-archive" \
    "$HOME/.openclaw/agents/main/sessions-backup" \
    "$HOME/.openclaw/agents/main/sessions-emergency-archive-"* \
    "$HOME/.openclaw/session-backups"
# Recreate empty dirs so the gateway can write on first boot
if $CONFIRM; then
  mkdir -p "$HOME/.openclaw/agents/main/sessions" \
           "$HOME/.openclaw/session-backups"
fi

# Agent-level user files (separate from workspace/)
rmf "$HOME/.openclaw/agents/main/agent/MEMORY.md" \
    "$HOME/.openclaw/agents/main/agent/SOUL.md" \
    "$HOME/.openclaw/agents/main/agent/HEARTBEAT.md" \
    "$HOME/.openclaw/agents/main/agent/system-prompt.md"

# Drop secondary agent dirs (multi-agent setups from previous user)
if $CONFIRM; then
  find "$HOME/.openclaw/agents/" -mindepth 1 -maxdepth 1 -type d ! -name main \
    -exec rm -rf {} + 2>/dev/null || true
fi

# ─── 5. gbrain user memory (PGLite recreates empty on first serve) ─────────
hdr "5. Wipe gbrain PGLite (recreated empty on first gbrain serve)"
rmf "$HOME/.gbrain/brain.pglite" \
    "$HOME/.gbrain/config.json" \
    "$HOME/.gbrain/logs"
# Keep ~/.gbrain/ as an empty dir so gbrain serve writes back to expected path
if $CONFIRM; then
  mkdir -p "$HOME/.gbrain"
fi

# ─── 6. Workspace: KEEP fleet-wide templates, RESET user-specific ──────────
hdr "6. Reset workspace identity (KEEP SOUL/AGENTS/CAPABILITIES, RESET others)"
# Files the operator's manifest manages (SOUL.md, AGENTS.md, CAPABILITIES.md,
# EARN.md, QUICK-REFERENCE.md, TOOLS.md) — leave alone. The reconciler is
# authoritative for these.

# Per-user identity files
rmf "$HOME/.openclaw/workspace/USER.md" \
    "$HOME/.openclaw/workspace/WALLET.md" \
    "$HOME/.openclaw/workspace/notification-log.jsonl" \
    "$HOME/.openclaw/workspace/dispatch-audit.log" \
    "$HOME/.openclaw/workspace/desktop-thumbnail.jpg" \
    "$HOME/.openclaw/workspace/.bootstrap_consumed"

# IDENTITY.md + MEMORY.md → reset to placeholders so configureOpenClaw / agent
# can write fresh on first boot
if $CONFIRM; then
  cat > "$HOME/.openclaw/workspace/IDENTITY.md" <<'IDENT'
# IDENTITY.md - Who Am I?

*Configure on first conversation with your human.*

You are an InstaClaw AI agent. Until your human gives you a name and
personality, introduce yourself as "an InstaClaw agent" and ask what
they'd like to call you.
IDENT
  cat > "$HOME/.openclaw/workspace/MEMORY.md" <<'MEM'
# Memory

<!-- RECENT_SESSIONS_START -->
## Recent Sessions (auto-updated)

*Empty — first boot.*

<!-- RECENT_SESSIONS_END -->
MEM
else
  log "[DRY] would write IDENTITY.md + MEMORY.md templates"
fi

# Cross-session memory files (session-log + active-tasks) → empty templates
if $CONFIRM; then
  mkdir -p "$HOME/.openclaw/workspace/memory"
  cat > "$HOME/.openclaw/workspace/memory/session-log.md" <<'EOF'
# Session Log

*Cross-session memory. Append a one-paragraph summary at the end of every conversation.*
EOF
  cat > "$HOME/.openclaw/workspace/memory/active-tasks.md" <<'EOF'
# Active Tasks

*Cross-session task tracking. Add tasks here when they're not finished in one session.*
EOF
  # Clear any backups left behind
  rm -f "$HOME/.openclaw/workspace/memory/MEMORY.md.bak"
fi

# Pre-v67 / pre-version backups in workspace
rmf "$HOME/.openclaw/workspace/SOUL.md.pre-"*.bak \
    "$HOME/.openclaw/workspace/CAPABILITIES.md.pre-"*.bak \
    "$HOME/.openclaw/workspace/AGENTS.md.pre-"*.bak

# Workspace skill-output dirs (per-user scratch)
rmf "$HOME/.openclaw/workspace/tmp-media" \
    "$HOME/.openclaw/workspace/tool-cache" \
    "$HOME/.openclaw/workspace/state" \
    "$HOME/.openclaw/workspace/competitive-intel" \
    "$HOME/.openclaw/workspace/ecommerce" \
    "$HOME/.openclaw/workspace/higgsfield" \
    "$HOME/.openclaw/workspace/social-content" \
    "$HOME/.openclaw/workspace/videos" \
    "$HOME/.openclaw/workspace/canvas" \
    "$HOME/.openclaw/workspace/.openclaw"
# Recreate empty per-skill dirs (manifest expects them — Rule 24 taxonomy)
if $CONFIRM; then
  mkdir -p "$HOME/.openclaw/workspace/tmp-media" \
           "$HOME/.openclaw/workspace/tool-cache" \
           "$HOME/.openclaw/workspace/state"
fi

# ─── 7. Browser session — wipe Chromium profile completely ─────────────────
hdr "7. Wipe browser profile (cookies, logins, history)"
rmf "$HOME/.openclaw/browser/openclaw/user-data" \
    "$HOME/.config/chromium" \
    "$HOME/.config/google-chrome"
if $CONFIRM; then
  mkdir -p "$HOME/.openclaw/browser/openclaw"
fi

# ─── 8. Partner-specific contamination ──────────────────────────────────────
hdr "8. Wipe partner-specific (edge-esmeralda, dgclaw-sibling, partner SSH keys)"
rmf "$HOME/.openclaw/skills/edge-esmeralda" \
    "$HOME/.openclaw/skills/eclipse" \
    "$HOME/dgclaw-skill"
# Strip partner SSH keys from authorized_keys (keep deploy keys only)
if $CONFIRM && [[ -f "$HOME/.ssh/authorized_keys" ]]; then
  grep -vE '(edge-city-privacy-bypass|eclipse-bypass|partner-bypass-|^$)' \
    "$HOME/.ssh/authorized_keys" > "$HOME/.ssh/authorized_keys.tmp"
  mv "$HOME/.ssh/authorized_keys.tmp" "$HOME/.ssh/authorized_keys"
  chmod 600 "$HOME/.ssh/authorized_keys"
fi
# If --wipe-all-skills, drop EVERY skill — reconciler will re-clone/install
if ! $KEEP_SKILLS; then
  rmf "$HOME/.openclaw/skills"
  if $CONFIRM; then mkdir -p "$HOME/.openclaw/skills"; fi
fi

# ─── 9. Telegram state ──────────────────────────────────────────────────────
hdr "9. Wipe Telegram polling state"
rmf "$HOME/.openclaw/telegram"

# ─── 10. Stale locks + per-VM state (.openclaw subdirs not handled above) ──
hdr "10. Wipe stale locks + per-VM state"
rmf "$HOME/.openclaw/.consensus_intent.lock" \
    "$HOME/.openclaw/.consensus_match.lock" \
    "$HOME/.openclaw/.consensus_intent_state.json" \
    "$HOME/.openclaw/.consensus_match_state.json" \
    "$HOME/.openclaw/cron" \
    "$HOME/.openclaw/memory" \
    "$HOME/.openclaw/delivery-queue" \
    "$HOME/.openclaw/devices" \
    "$HOME/.openclaw/flows" \
    "$HOME/.openclaw/polymarket" \
    "$HOME/.openclaw/logs" \
    "$HOME/.openclaw/acpx" \
    "$HOME/.openclaw/backups" \
    "$HOME/.openclaw/canvas" \
    "$HOME/.openclaw/media" \
    "$HOME/.openclaw/notifications" \
    "$HOME/.openclaw/tasks" \
    "$HOME/.openclaw/jobs.json" \
    "$HOME/.openclaw/jobs.json.bak" \
    "$HOME/.openclaw/jobs-state.json" \
    "$HOME/.openclaw/crontab.backup-"*
# Find any *.lock under ~/.openclaw NOT inside skill node_modules or git refs
if $CONFIRM; then
  find "$HOME/.openclaw" -name '*.lock' \
    -not -path '*/node_modules/*' \
    -not -path '*/.git/*' \
    -not -name 'bun.lock' \
    -not -name 'yarn.lock' \
    -not -name 'package-lock.json' \
    -delete 2>/dev/null || true
fi
# Recreate dirs the manifest expects to exist
if $CONFIRM; then
  mkdir -p "$HOME/.openclaw/cron" \
           "$HOME/.openclaw/delivery-queue" \
           "$HOME/.openclaw/devices" \
           "$HOME/.openclaw/logs" \
           "$HOME/.openclaw/media/inbound" \
           "$HOME/.openclaw/media/outbound" \
           "$HOME/.openclaw/notifications" \
           "$HOME/.openclaw/tasks"
fi

# ─── 11. Personal experimentation scripts in $HOME (bean-*, snipers, etc.) ─
hdr "11. Wipe personal experiment scripts in \$HOME"
if $CONFIRM; then
  # Specific known patterns from the audit
  for pat in 'bean-*' 'analyze_situation.js' 'base-memecoin-*' 'claim_rewards.js' \
             'dexscreener-*' 'mining-log*' 'frontrun-*' 'snipe-*' 'swap-to-*' \
             'memecoin-*' 'retry-*.mjs' 'query-credits-*.ts'; do
    for f in "$HOME"/$pat; do
      [[ -e "$f" ]] && rm -f "$f"
    done
  done
fi

# ─── 12. Backup file proliferation ──────────────────────────────────────────
hdr "12. Wipe accumulated *.bak* / *.predit-* / *.clobbered.*"
if $CONFIRM; then
  find "$HOME/.openclaw/scripts" -maxdepth 1 \
    \( -name '*.bak' -o -name '*.bak.*' -o -name '*.bak-*' \) \
    -delete 2>/dev/null || true
  find "$HOME/.openclaw/scripts/__pycache__" -delete 2>/dev/null || true
  find "$HOME/.config/systemd/user" \
    \( -name '*.predit-*' -o -name '*.bak' -o -name '*.bak.*' \) \
    -delete 2>/dev/null || true
  find "$HOME/.openclaw" -maxdepth 2 \
    \( -name 'openclaw.json.bak*' -o -name 'openclaw.json.clobbered.*' \) \
    -delete 2>/dev/null || true
fi

# ─── 13. Crontab — drop partner-specific + duplicate entries ────────────────
hdr "13. Clean crontab (drop partner + duplicate entries)"
if $CONFIRM; then
  # Snapshot the existing crontab
  current=$(crontab -l 2>/dev/null || echo "")
  if [[ -n "$current" ]]; then
    new=$(echo "$current" \
      | grep -vE '(skills/edge-esmeralda|skills/eclipse|partner-skill-)' \
      | awk '!seen[$0]++' )
    echo "$new" | crontab -
    diff <(echo "$current") <(echo "$new") | head -20 || true
  fi
fi

# ─── 13.5. Crontab — rewrite stale hardcoded Node path cron entries ─────────
# The 'openclaw memory index' cron historically used a HARDCODED Node path
# (e.g. /home/openclaw/.nvm/versions/node/v22.22.0/bin/openclaw memory index).
# When Node bumps (v22.22.0 → v22.22.2), nothing rewrites the entry — the
# cron silently fails every 4 AM because the old binary path no longer
# exists. Confirmed silent fleet-wide failure on v113 snapshot (vm-1035 +
# bake VM 2026-05-25). The manifest's canonical form is dynamic NVM source.
# Rewrite during bake so the snapshot ships clean. Idempotent: if already
# in dynamic form, sed is a no-op.
hdr "13.5. Rewrite stale 'openclaw memory index' cron to dynamic NVM form"
if $CONFIRM; then
  current=$(crontab -l 2>/dev/null || echo "")
  # Only rewrite if a hardcoded-path entry exists AND no dynamic-form already.
  if echo "$current" | grep -q 'nvm/versions/node/v[0-9.]*/bin/openclaw memory index'; then
    log "Found stale hardcoded-path 'openclaw memory index' cron — rewriting to dynamic form"
    new=$(echo "$current" | sed -E \
      's|/home/openclaw/\.nvm/versions/node/v[0-9.]+/bin/openclaw memory index|. /home/openclaw/.nvm/nvm.sh \&\& openclaw memory index|')
    echo "$new" | crontab -
    log "Rewrite complete. New entry:"
    crontab -l | grep "openclaw memory index" | head -1
  else
    log "No stale 'openclaw memory index' cron found — already dynamic or absent"
  fi
fi

# ─── 14. Shell history + ssh known_hosts ────────────────────────────────────
hdr "14. Wipe shell history + ssh known_hosts"
rmf "$HOME/.bash_history" "$HOME/.zsh_history" "$HOME/.python_history" \
    "$HOME/.viminfo" "$HOME/.lesshst" "$HOME/.wget-hsts" "$HOME/.sqlite_history" \
    "$HOME/.ssh/known_hosts" "$HOME/.ssh/known_hosts.old" \
    "$HOME/.npm/_logs"
if $CONFIRM; then
  sudo rm -f /root/.bash_history /root/.python_history /root/.lesshst 2>/dev/null || true
  history -c 2>/dev/null || true
fi

# ─── 15. Logs (4GB journal + 3GB syslog — biggest single category) ──────────
hdr "15. Wipe logs"
if $CONFIRM; then
  sudo journalctl --rotate 2>&1 | tail -1 || true
  sudo journalctl --vacuum-time=1s --quiet 2>&1 | tail -1 || true
  sudo rm -rf /var/log/journal/* 2>/dev/null || true
  sudo find /var/log -type f \( -name '*.gz' -o -name '*.[0-9]' -o -name '*.old' \) -delete 2>/dev/null || true
  for f in /var/log/syslog /var/log/auth.log /var/log/kern.log /var/log/ufw.log \
           /var/log/btmp /var/log/wtmp /var/log/lastlog /var/log/faillog; do
    sudo truncate -s 0 "$f" 2>/dev/null || true
  done
else
  log "[DRY] would journalctl --vacuum-time=1s and rotate+truncate /var/log/*"
fi

# ─── 16. Package + build caches ─────────────────────────────────────────────
hdr "16. Wipe NPM / NVM / pip / APT caches"
if $CONFIRM; then
  source "$HOME/.nvm/nvm.sh" 2>/dev/null || true
  npm cache clean --force 2>&1 | tail -1 || true
  python3 -m pip cache purge 2>&1 | tail -1 || true
  sudo apt-get clean 2>&1 | tail -1 || true
  sudo rm -rf /var/lib/apt/lists/* 2>/dev/null || true
fi
rmf "$HOME/.cache/pip" \
    "$HOME/.cache/node-gyp" \
    "$HOME/.cache/google-chrome-for-testing" \
    "$HOME/.cache/mesa_shader_cache" \
    "$HOME/.cache/fontconfig" \
    "$HOME/.nvm/.cache" \
    "$HOME/.npm/_cacache" \
    "$HOME/.npm/_logs" \
    "/root/.cache/pip"
if ! $KEEP_PLAYWRIGHT; then
  rmf "$HOME/.cache/ms-playwright"
fi

# ─── 17. /tmp ───────────────────────────────────────────────────────────────
hdr "17. Wipe /tmp"
if $CONFIRM; then
  # Stop anything still binding sockets in /tmp
  pkill -9 -f 'tsx.*' 2>/dev/null || true
  sudo rm -rf /tmp/* /tmp/.[!.]* /tmp/..?* 2>/dev/null || true
fi

# ─── 18. /var/tmp ───────────────────────────────────────────────────────────
hdr "18. Wipe /var/tmp"
if $CONFIRM; then
  sudo rm -rf /var/tmp/* 2>/dev/null || true
fi

# ─── 19. Cloud-init artifacts that would carry instance ID through ─────────
hdr "19. Clear cloud-init instance state (so first boot re-runs config_ssh)"
# Per CLAUDE.md docs: DO NOT delete /etc/ssh/ssh_host_* or /etc/machine-id.
# Cloud-init regenerates them on first boot from snapshot when instance ID
# changes. We just clear the instance-specific cache so cloud-init sees the
# instance as new.
if $CONFIRM; then
  # Clean cloud-init's per-instance data (instance-id) so it re-runs init
  # modules on the new VM. v79 snapshot relies on this — keep it consistent.
  sudo rm -rf /var/lib/cloud/instances/* 2>/dev/null || true
  sudo rm -rf /var/lib/cloud/instance 2>/dev/null || true
  sudo rm -f /var/lib/cloud/data/instance-id 2>/dev/null || true
  sudo cloud-init clean --logs --seed 2>&1 | tail -1 || true
fi

# ─── 20. Final sweep — anything I may have missed ──────────────────────────
hdr "20. Final sweep (heuristic — any obvious cruft)"
if $CONFIRM; then
  # Anything looking like a per-VM secret backup that escaped
  find "$HOME" -maxdepth 3 -type f \
    \( -name '*.env.bak*' -o -name '*token*.bak' -o -name '*secret*.bak' \) \
    -delete 2>/dev/null || true
  # Any .DS_Store, ._* macos cruft (we'd see this if rsync'd from a Mac)
  find "$HOME" -name '.DS_Store' -o -name '._*' -delete 2>/dev/null || true
fi

# ─── Remove the bake-mode marker so this script can't accidentally re-run ──
if $CONFIRM; then
  rm -f "$HOME/.snapshot-bake-mode"
fi

# ─── Disk usage AFTER ───────────────────────────────────────────────────────
hdr "Disk usage AFTER"
df -BM / | tail -1
$QUIET || du -BM -d 1 / 2>/dev/null | sort -rn | head -8

# ─── Summary ────────────────────────────────────────────────────────────────
echo
if $DRY_RUN; then
  echo "═══ DRY RUN complete — no changes made ═══"
elif (( ERRORS > 0 )); then
  echo "═══ Cleanup complete with $ERRORS non-fatal warnings ═══"
  exit 4
else
  echo "═══ Cleanup complete — VM is ready to image ═══"
fi

# Reminder for the operator
cat <<'NEXT'

Next steps:
  1. Run validation: scp _postbake-validation.ts; bash test_locally
     OR run from operator laptop:
       npx tsx scripts/_postbake-validation.ts --vm-ip=<BAKE_IP> --mode=bake
  2. If validation passes, shutdown via Linode API and image:
       POST /v4/linode/instances/{ID}/shutdown
       POST /v4/images { disk_id, label, description }
  3. Provision a TEST VM from the new image and re-run validation:
       npx tsx scripts/_postbake-validation.ts --vm-ip=<TEST_IP> --mode=test
  4. Update LINODE_SNAPSHOT_ID in .env.local + Vercel env vars.
  5. Keep the previous snapshot for 1 week (rollback window).
NEXT
