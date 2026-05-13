#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# privacy-bridge.sh — Maximum Privacy Mode SSH command bridge
# ──────────────────────────────────────────────────────────────────────────
#
# Trust infrastructure for the Edge Esmeralda 2026 partnership. When an
# attendee enables Maximum Privacy Mode, this script becomes the FORCED
# COMMAND on every operator SSH session (via authorized_keys
# `command="..."` directive). Every operator command flows through here:
# allowed → exec; sensitive → reject + audit-log; cannot-determine-state →
# panic-block (fail closed).
#
# ──────────────────────────────────────────────────────────────────────────
# THREAT MODEL — for the Edge Esmeralda security reviewer
# ──────────────────────────────────────────────────────────────────────────
#
# Three threat actors with different capabilities. The bridge defends
# against the first two; the third is constrained by separate controls
# (chattr +i on this script + authorized_keys, admin kill switch).
#
#   1. OPERATOR (Cooper, support staff with deploy key)
#      Trust: high but auditable. Already gated by this bridge post-cutover.
#      Goal of privacy mode: minimize what operator can see during the
#      24h window the user opted in.
#
#   2. COMPROMISED OPERATOR CREDENTIAL (stolen deploy SSH key)
#      Trust: zero. Has full deploy-key access but goes through this
#      bridge. Bridge defends by denying everything outside the allowlist
#      AND by failing CLOSED on every "cannot determine state" path so a
#      degraded API doesn't open the gates.
#
#   3. MALICIOUS USER OR COMPROMISED AGENT (running as openclaw on the VM)
#      Trust: zero. Has full filesystem access as openclaw. NOT GATED BY
#      THIS BRIDGE — the bridge intercepts SSH, not local execs.
#
#      *** HONEST LIMITATION (verified vm-050 2026-05-12) ***
#      The `openclaw` user has `(ALL) NOPASSWD: ALL` in sudoers — meaning
#      a malicious agent CAN escalate to root and defeat any
#      file-system-level protection (chattr +i, file ownership, etc.).
#
#      For v0 (Edge Esmeralda 2026-05-30 launch) we ship what defends
#      against operator-side threats and openly document the agent-side
#      gap. The Edge marketing copy says "operators can't read your data
#      via SSH" — true. It does NOT say "your own malicious agent can't
#      defeat privacy mode" — that requires v1 restricted sudoers.
#
#      Partial defenses we DO ship:
#        - chattr +i on this script via reconciler (raises the bar — agent
#          must do `sudo chattr -i` to modify, which is detectable in
#          /var/log/auth.log if anyone audits)
#        - Self-integrity check (stage 1 below — catches passive tamper)
#        - Admin kill switch /api/admin/privacy-override (legal compliance:
#          force-null privacy_mode_until immediately, logged with reason)
#
#      Real defenses planned for v1 (post-launch):
#        - Restricted sudoers: replace `(ALL) NOPASSWD: ALL` with an
#          explicit allow-list of commands the agent legitimately needs
#          (systemctl --user *, npm install -g openclaw*, etc.). This is
#          the architectural fix.
#        - Root-owned bypass key at /etc/ssh/openclaw-bypass-key with
#          sshd AuthorizedKeysFile pointing at it. Then even a sudo-
#          armed agent can't delete the bypass.
#        - Vercel-side tamper-monitoring cron: SSH every edge_city VM
#          every 5 min, verify bridge SHA + bypass key + chattr +i flag.
#          Alert on drift.
#
#      Nuclear options (out-of-band, do not depend on SSH or agent):
#        - Linode console access (Manager UI → boot single-user) — works
#          even if SSH is fully bricked.
#        - Snapshot rebuild — provision a new VM from the canonical
#          snapshot, migrate the user's data manually if needed.
#        - Admin kill switch above — disables privacy mode side-channel
#          and re-enables operator SSH access (after the chattr +i is
#          undone from rescue).
#
# ──────────────────────────────────────────────────────────────────────────
# Attack vectors considered and the bridge's response
# ──────────────────────────────────────────────────────────────────────────
#
# Source: independent restricted-shell research synthesis 2026-05-12.
# Cross-referenced rbash bypasses, lshell CVEs (148, 147, EDB-39632),
# gitolite, GitHub deploy-key forced-command, AWS SSM document model,
# GTFOBins. The bridge follows the gitolite/GitHub pattern: forced-command
# in authorized_keys + strict parsing + fail-closed on every uncertainty.
#
#   A. Command substitution ($(...) and backticks `...`)
#      DEFENSE: reject `$(` and backticks in pre-parse character denylist.
#      ALSO: bridge does invoke bash -c on the final command after
#      allowlist match — but only after every metacharacter has been
#      stripped (see step 6).
#
#   B. Process substitution (<(...), >(...))
#      DEFENSE: reject `<(` and `>(` (covered by `<` and `>` denylist).
#
#   C. Brace expansion ({a,b}, c{at,p})
#      DEFENSE: reject `{` and `}` in pre-parse byte denylist.
#
#   D. Glob expansion (*, ?, [...])
#      DEFENSE: reject `*`, `?` outside allowlist case patterns (the case
#      patterns USE glob syntax but on a string we control; the operator
#      command is matched against the patterns, then if matched, passed
#      to bash -c which performs no further glob since the operator's
#      command is already a single token at that point — except path
#      arguments. Path arguments are restricted by SENSITIVE deny.)
#
#   E. Env-var manipulation (LD_PRELOAD, IFS, PATH, BASH_ENV)
#      DEFENSE: sshd line uses `restrict` which implies `no-user-rc`. The
#      bridge runs with the operator's env from sshd; sshd_config
#      `PermitUserEnvironment no` is set by the base snapshot. The bridge
#      does NOT honor `KEY=VALUE prefix` syntax — the allowlist case
#      patterns require commands to start with the binary name, not an
#      env assignment.
#
#   F. Path traversal (../, symlinks)
#      DEFENSE: SENSITIVE deny matches `*.openclaw/workspace/sessions/*`
#      etc. — the `*` prefix matches `../../../home/openclaw/.openclaw/...`
#      too. But this is best-effort against traversal — a determined
#      operator with cat/head/tail access can read most files. The real
#      defense is what's IN the SENSITIVE list (every path containing
#      user content).
#
#   G. Here-doc / here-string (<<EOF, <<<)
#      DEFENSE: reject `<<` (covered by `<` denylist).
#
#   H. FD redirection (2>&1, > file, &>)
#      DEFENSE: reject `>`, `<`, `&` in command-chaining denylist. Even
#      `2>&1` triggers the `>` reject.
#
#   I. exec replacement (exec bash)
#      DEFENSE: `exec` is not in the allowlist. The first-token match
#      requires the binary to be on the allowlist; `exec` is not.
#
#   J. Newline / CR injection
#      DEFENSE: explicit newline + CR reject FIRST (QA-2026-05-02 #1).
#
#   K. Unicode confusables (Cyrillic 'r' looks like ASCII 'r')
#      DEFENSE: byte denylist — reject any byte ≥ 0x80 (non-ASCII). The
#      operator's commands should be pure ASCII in practice.
#
#   L. Quoting tricks ("r""m")
#      DEFENSE: not fully defended — `"r""m"` would still match `rm` via
#      bash -c. RESIDUAL RISK: low because `rm` isn't on the allowlist
#      anyway; an attacker can't escape via this for actually-denied
#      commands. Plus, glob/redirect/chaining are stripped before exec.
#
#   M. Allowlist prefix-matching confusion ("ls; rm -rf /")
#      DEFENSE: `;`, `&&`, `||`, `|` all in command-chaining denylist.
#
#   N. sed -i (in-place file edit)
#      DEFENSE: pre-allowlist deny for `sed *-i*` patterns including
#      `--in-place`, `-i.bak`, combined flag forms. Critical — without
#      this, an operator could rewrite this bridge in place.
#
#   O. tee <file> (truncates the named file even without input)
#      DEFENSE: `tee` REMOVED from the allowlist entirely. No legitimate
#      operator use case during privacy mode.
#
#   P. find -exec / xargs -I (command-string argument bypass)
#      DEFENSE: find/grep/rg all in the SENSITIVE deny list (existing).
#      xargs not on the allowlist.
#
#   Q. Variable expansion ($IFS, $0)
#      DEFENSE: `$` in pre-parse byte denylist (rejects all `$` uses).
#
#   R. Self-modification (sed -i bridge, rm bridge, mv bridge)
#      DEFENSE 1: this script self-verifies the `i` immutable flag on its
#      own file at startup. If `chattr +i` isn't set, panic-block.
#      DEFENSE 2: `sed -i` denied as above.
#      DEFENSE 3: `rm`, `mv`, `cp` not on the allowlist.
#
#   S. Bridge bypass via direct bash invocation
#      DEFENSE: the `command="..."` directive in authorized_keys forces
#      sshd to invoke this script regardless of what the operator sends.
#      The bypass key is a SEPARATE line in authorized_keys (no
#      command= directive) for genuine emergency use only.
#
# RESIDUAL RISKS (documented for the security reviewer):
#
#   - An operator with deploy-key access can still RECON the VM (ps,
#     systemctl, journalctl, df, etc.). These are necessary for
#     incident triage. They don't reveal user content but they do
#     reveal that the user is running an agent (which is public).
#
#   - The reconciler currently does NOT honor privacy mode (only the
#     watchdog does). During privacy mode, reconciler runs hit this
#     bridge and most of its operations fail (chained commands, file
#     writes via base64 |base64 -d > file). This is intentional v0
#     behavior — reconciler operations are operator operations and
#     should be denied during privacy mode. The user trades 24h of
#     reconciler-quiet for verified privacy. v1 follow-up: make the
#     reconciler skip edge_city VMs during privacy mode entirely.
#
#   - The agent (running as openclaw on the VM) is unaffected by this
#     bridge. A malicious agent could read its own user's data — but
#     the user IS the agent's principal, so this is by design.
#
# ──────────────────────────────────────────────────────────────────────────
# QA history (load-bearing — do not remove)
# ──────────────────────────────────────────────────────────────────────────
#
# QA fixes 2026-05-02 (privacy-bridge-qa-blockers):
#   #1 reject newlines/CRs before whitelist match — they bypassed the
#      chaining check and allowed `cat /tmp/foo\nbash` to drop into a shell.
#   #2 fail CLOSED on every "cannot determine state" path — env missing,
#      token empty, API down + no cache, unparseable state. Bypass key is
#      the only escape hatch.
#   #3 strict openclaw whitelist (--version / --help / bare only).
#      Subcommands memory/session/config/agents/plugins/mcp denied at
#      SENSITIVE.
#
# Tightening 2026-05-12 (this revision):
#   - git: subcommand allowlist (pull, status, log, diff, fetch only)
#   - crontab: only `crontab -l` (read); bare/-r/-e/file all blocked
#   - chmod: path restricted to ~/.openclaw/scripts/ and ~/scripts/
#   - chown: same path restriction
#   - sed -i: in-place edit denied at SENSITIVE
#   - tee: removed from allowlist (truncates files)
#   - Pre-parse: non-ASCII bytes rejected (Unicode confusable defense)
#   - Pre-parse: $, {, }, ? rejected (substitution + brace expansion)
#   - Self-integrity: chattr +i flag verified on every invocation
#
# Source of truth: instaclaw/lib/privacy-bridge.sh in the InstaClaw
# repository. Loaded into the reconciler via lib/privacy-bridge-script.ts
# (fs.readFileSync). Do not edit on VM — changes get reverted next
# reconciler tick.
# ──────────────────────────────────────────────────────────────────────────

set -uo pipefail

ENV_FILE="$HOME/.openclaw/.env"
CACHE_DIR="$HOME/.openclaw/cache"
CACHE_FILE="$CACHE_DIR/privacy-mode.json"
PANIC_LOG="$CACHE_DIR/privacy-bridge-panic.log"
CACHE_TTL_SECONDS=30
API_BASE="${INSTACLAW_API_BASE:-https://instaclaw.io}"
LOG_ENDPOINT="$API_BASE/api/internal/log-operator-command"
CHECK_ENDPOINT="$API_BASE/api/internal/check-privacy-mode"
CMD="${SSH_ORIGINAL_COMMAND:-}"

mkdir -p "$CACHE_DIR" 2>/dev/null

# ──────────────────────────────────────────────────────────────────────────
# Stage 1 — self-integrity check
# ──────────────────────────────────────────────────────────────────────────
# Verify this script is chattr +i (immutable to the openclaw user). If it
# isn't, an attacker may have rewritten it; panic-block. This is the
# defense for Threat 3 — a malicious agent that tries to swap the bridge.
#
# Why this works: setting +i requires CAP_LINUX_IMMUTABLE which root has.
# The openclaw user has passwordless sudo (verified 2026-05-12 on vm-050)
# so the reconciler CAN flip the flag during normal deploys. But if an
# agent tries to overwrite the script without first running
# `sudo chattr -i`, the write fails with EPERM. If they DO run `sudo
# chattr -i`, this check catches the unflagged state and panic-blocks.
#
# Edge case: if lsattr is missing on the VM (it ships with e2fsprogs by
# default; should be there) we fail closed since we can't verify.

panic_local_reject() {
  local reason="$1"
  printf '%s panic: %s\n  cmd: %s\n' "$(date -Iseconds 2>/dev/null || date)" "$reason" "$CMD" \
    >> "$PANIC_LOG" 2>/dev/null
  cat >&2 <<EOF
─────────────────────────────────────────────────────
  Privacy bridge: cannot determine privacy state
─────────────────────────────────────────────────────
  $reason

  Failing CLOSED — all SSH commands are blocked until
  this is resolved. Use the emergency bypass key to
  recover.

  Local panic log: ~/.openclaw/cache/privacy-bridge-panic.log
─────────────────────────────────────────────────────
EOF
  exit 2
}

if ! command -v lsattr >/dev/null 2>&1; then
  panic_local_reject "lsattr binary not found (e2fsprogs missing?). Cannot verify bridge integrity."
fi

# `$0` is the path to this script as invoked. With sshd's command=
# directive, $0 is the absolute path from authorized_keys, so we know
# exactly what to check.
SELF_PATH="$0"
SELF_ATTRS="$(lsattr -- "$SELF_PATH" 2>/dev/null | awk '{print $1}')"
if [ -z "$SELF_ATTRS" ]; then
  panic_local_reject "lsattr failed on $SELF_PATH — bridge file inaccessible or corrupt?"
fi
case "$SELF_ATTRS" in
  *i*) : ;; # immutable flag present, good
  *)
    panic_local_reject "Bridge self-integrity: $SELF_PATH missing 'i' (immutable) flag. Attrs=$SELF_ATTRS. Possible tampering. Have a root user run: sudo chattr +i $SELF_PATH"
    ;;
esac

# ──────────────────────────────────────────────────────────────────────────
# Stage 2 — env + gateway token
# ──────────────────────────────────────────────────────────────────────────

# QA #2: env missing → fail closed (was: exec bash -c "$CMD")
if [ ! -f "$ENV_FILE" ]; then
  panic_local_reject "missing $ENV_FILE"
fi

GATEWAY_TOKEN="$(grep -E '^GATEWAY_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
# QA #2: empty token → fail closed (was: exec bash -c "$CMD")
if [ -z "$GATEWAY_TOKEN" ]; then
  panic_local_reject "GATEWAY_TOKEN empty in $ENV_FILE"
fi

# ──────────────────────────────────────────────────────────────────────────
# Stage 3 — fetch privacy state (with cache)
# ──────────────────────────────────────────────────────────────────────────

now_epoch="$(date +%s)"
cache_age=999999
if [ -f "$CACHE_FILE" ]; then
  cache_mtime="$(stat -c %Y "$CACHE_FILE" 2>/dev/null || echo 0)"
  cache_age=$((now_epoch - cache_mtime))
fi

STATE=""
if [ "$cache_age" -lt "$CACHE_TTL_SECONDS" ]; then
  STATE="$(cat "$CACHE_FILE" 2>/dev/null)"
fi
if [ -z "$STATE" ]; then
  fresh="$(curl -sS --max-time 5 -H "X-Gateway-Token: $GATEWAY_TOKEN" "$CHECK_ENDPOINT" 2>/dev/null)"
  if [ -n "$fresh" ]; then
    printf '%s' "$fresh" > "$CACHE_FILE.tmp" && mv "$CACHE_FILE.tmp" "$CACHE_FILE"
    STATE="$fresh"
  elif [ -f "$CACHE_FILE" ]; then
    # Stale cache fallback — using a known-recent state is better than
    # locking everyone out for a momentary network blip. Cooper's bypass
    # key still works either way.
    STATE="$(cat "$CACHE_FILE" 2>/dev/null)"
  fi
fi

# QA #2: state unavailable → fail closed (was: ACTIVE="false" → privacy off)
if [ -z "$STATE" ]; then
  panic_local_reject "Privacy state unavailable (API unreachable, no cache)"
fi

ACTIVE="$(printf '%s' "$STATE" | sed -n 's/.*"active":\s*\(true\|false\).*/\1/p' | head -1)"
PARTNER="$(printf '%s' "$STATE" | sed -n 's/.*"partner":\s*"\([^"]*\)".*/\1/p' | head -1)"

# QA #2: unparseable state → fail closed (was: ACTIVE="" → defaulted to false)
if [ "$ACTIVE" != "true" ] && [ "$ACTIVE" != "false" ]; then
  panic_local_reject "Privacy state unparseable (no active boolean): $STATE"
fi

# ──────────────────────────────────────────────────────────────────────────
# Stage 4 — audit-log primitives
# ──────────────────────────────────────────────────────────────────────────

json_string() { python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'; }

# TODO(privacy-v0-followup): per QA-2026-05-02 #5, this fire-and-forget
# background curl can be killed before completing when the parent shell
# exec's into the user's command. v1 should switch to nohup or write to a
# local spool file that a cron flushes to the API.
log_command() {
  local decision="$1" reason="${2:-}"
  local pmode="false"
  [ "$ACTIVE" = "true" ] && pmode="true"
  local cmd_json reason_json payload
  cmd_json="$(printf '%s' "$CMD" | json_string)"
  reason_json="$(printf '%s' "$reason" | json_string)"
  payload="{\"command\":$cmd_json,\"decision\":\"$decision\",\"privacy_mode_active\":$pmode,\"reason\":$reason_json}"
  ( curl -sS -X POST --max-time 3 \
      -H "X-Gateway-Token: $GATEWAY_TOKEN" \
      -H "Content-Type: application/json" \
      -d "$payload" \
      "$LOG_ENDPOINT" >/dev/null 2>&1 ) &
  disown 2>/dev/null || true
}

reject() {
  local reason="$1"
  log_command "blocked" "$reason"
  cat >&2 <<EOF
─────────────────────────────────────────────────────
  Maximum Privacy Mode is ON
─────────────────────────────────────────────────────
  $reason

  This VM's user enabled Maximum Privacy Mode and operator
  access is restricted until it auto-reverts (or the user
  toggles it off at instaclaw.io/dashboard/privacy).

  Allowed (read-only diagnostics):
    systemctl --user, journalctl --user, crontab -l,
    df/du/free/uptime/vmstat/iostat/top/ps,
    ping/traceroute, curl to localhost or api.telegram.org,
    openclaw --version/--help, npm install -g openclaw@*,
    git pull/status/log/diff/fetch (subcommands only),
    ls/wc, cat/head/tail/less/more (with SENSITIVE deny list
    enforced), echo, sed (no -i in-place edit),
    mkdir/chmod/chown (restricted to ~/.openclaw/scripts/
    and ~/scripts/).

  Blocked:
    Any read of ~/.openclaw/workspace/sessions/*, MEMORY.md,
    agents/*, openclaw memory/session/config/agents/plugins/mcp,
    mcporter, scp/sftp/rsync, strace/gdb/lsof, /proc/<pid>,
    /dev/shm. Command chaining (;, &&, ||, |, newlines).
    Subshells (\$(...), backticks). Redirection (>, <, <<, <<<).
    Brace/glob expansion ({, }, ?). Variable substitution (\$).
    Non-ASCII characters. Interactive shells. sed -i. tee.
    git clone/checkout/apply/reset/push/commit/config/init/remote.
    crontab bare/-e/-r/file. chmod/chown outside the allow-list paths.

  For legal-compliance disable: instaclaw.io admin can null
  privacy_mode_until via POST /api/admin/privacy-override.
─────────────────────────────────────────────────────
EOF
  exit 1
}

# ──────────────────────────────────────────────────────────────────────────
# Stage 5 — privacy OFF path (still audit-logged, exec command)
# ──────────────────────────────────────────────────────────────────────────

# Privacy OFF or non-edge_city → log normal access and execute.
# Empty CMD = interactive shell attempt; allow it when privacy is OFF.
if [ "$ACTIVE" != "true" ] || [ "$PARTNER" != "edge_city" ]; then
  log_command "allowed_privacy_off"
  if [ -z "$CMD" ]; then
    exec bash -l
  fi
  exec bash -c "$CMD"
fi

# ══════════════════════════════════════════════════════════════════════════
# PRIVACY ON enforcement — every check below assumes ACTIVE=true
# ══════════════════════════════════════════════════════════════════════════

if [ -z "$CMD" ]; then
  reject "Interactive shell attempted. Privacy mode requires command-mode SSH only — pass the command on the ssh line."
fi

# ──────────────────────────────────────────────────────────────────────────
# Stage 6 — pre-parse byte/metachar denylist
# ──────────────────────────────────────────────────────────────────────────
# Strictest possible. Rejects any byte that could enable Section 2 attacks
# from the threat model. Order matters: more specific checks first so the
# error message tells the operator exactly what they tripped.

# Attack vector J: newline/CR injection. Catches second-statement bypass.
case "$CMD" in
  *$'\n'*|*$'\r'*)
    reject "Newlines/CRs not allowed (would let a second command bypass allowlist)." ;;
esac

# Attack vector K: Unicode confusables. Reject any byte ≥ 0x80.
# `LC_ALL=C grep -q $'[\x80-\xff]'` is the canonical check in bash.
if printf '%s' "$CMD" | LC_ALL=C grep -q $'[\x80-\xff]'; then
  reject "Non-ASCII bytes not allowed (Unicode confusables defense)."
fi

# Attack vector A/B/H/M: command-chaining, substitution, redirection.
# Rejecting all of these as a class — the bridge is single-command-only.
# Note: `\` (backslash) is intentionally allowed because some legitimate
# commands include escaped quotes in arguments (e.g., `journalctl -u
# 'openclaw\x2dgateway'`). The other metacharacters cover the actual
# attack surface.
case "$CMD" in
  *";"*|*"&&"*|*"||"*|*"|"*|*'`'*|*'$('*|*">"*|*"<"*|*"&"*)
    reject "Command chaining/substitution/redirection (;, &&, ||, |, &, backtick, \$(), >, <) not allowed under privacy mode." ;;
esac

# Attack vector C/D/Q: brace expansion, glob, variable expansion.
# Note `*'*'*` matches a LITERAL asterisk (the `*` inside quotes is literal;
# the surrounding `*` is the case-pattern wildcard). Without the quotes,
# `*` is the wildcard meta-character and matches everything.
case "$CMD" in
  *'$'*|*'{'*|*'}'*|*'?'*|*'*'*)
    reject "Brace/glob/variable expansion (\$, {, }, ?, *) not allowed under privacy mode." ;;
esac

# ──────────────────────────────────────────────────────────────────────────
# Stage 7 — SENSITIVE deny (path + binary blacklists)
# ──────────────────────────────────────────────────────────────────────────
# Specific patterns that protect user content + system integrity. Checked
# BEFORE the allowlist so even if the allowlist case grew accidentally
# permissive, these wouldn't slip through.

case "$CMD" in
  # User content — sessions, memory, agent runtime
  *.openclaw/workspace/sessions/*|*MEMORY.md*|*.openclaw/workspace/memory/*|*.openclaw/agents/*)
    reject "Refusing to touch agent memory / sessions / agents/. Those are protected under privacy mode." ;;

  # The user's env file — contains GATEWAY_TOKEN (we ALSO use it, but
  # the operator doesn't need to read it during privacy mode)
  *.openclaw/.env*)
    reject "Refusing to read ~/.openclaw/.env (contains secrets)." ;;

  # QA #3: openclaw subcommands that read or modify protected data.
  # Defense in depth — even if the whitelist below were ever loosened,
  # these would still be blocked here.
  "openclaw memory"*|"openclaw session"*|"openclaw sessions"*|"openclaw config"*|"openclaw agents"*|"openclaw plugins"*|"openclaw mcp"*)
    reject "openclaw memory/session/config/agents/plugins/mcp is blocked under privacy mode." ;;

  # mcporter accesses MCP servers which may proxy to user content
  mcporter|"mcporter "*)
    reject "mcporter is fully blocked under privacy mode (v0)." ;;

  # File transfer — exfiltration vectors
  "scp -f"*|"scp -t"*|sftp|"sftp "*|rsync|"rsync "*)
    reject "File transfer commands are blocked under privacy mode." ;;

  # Process inspection — could observe what the agent is doing in real time
  strace|"strace "*|gdb|"gdb "*|lsof|"lsof "*)
    reject "Process inspection tools are blocked under privacy mode." ;;

  # /proc/<pid>/ and /dev/shm — process memory + shared memory
  *"/proc/"*|*"/dev/shm"*)
    reject "Reads of /proc/<pid>/{maps,mem,fd} or /dev/shm are blocked under privacy mode." ;;

  # find/grep/rg — recursive exfiltration
  find|"find "*|grep|"grep "*|"egrep "*|"fgrep "*|rg|"rg "*)
    reject "find/grep/rg are blocked under privacy mode (v0) to prevent recursive exfiltration." ;;

  # Attack vector N: sed -i (in-place file edit) — could rewrite this
  # bridge or other system files. Catches all -i forms: `-i`, `-i.bak`,
  # `-i ''`, `--in-place`, combined like `-rin`. The `*` wildcards permit
  # other flags surrounding -i.
  *" -i "*|*" -i"|*"-i"*" "*|*"--in-place"*|*" -in"*|*" -ni"*|*" -ri"*|*" -ir"*|*" -is"*|*" -si"*)
    # narrow: only reject if this is a `sed` invocation. Other commands
    # may legitimately use -i flag with different semantics (none in our
    # allowlist do, but defensive).
    case "$CMD" in
      sed|"sed "*) reject "sed -i (in-place edit) is blocked — would let operator rewrite files including this bridge." ;;
    esac ;;
esac

# ──────────────────────────────────────────────────────────────────────────
# Stage 8 — tightened allowlist
# ──────────────────────────────────────────────────────────────────────────
# First-token matching only. Each case has a comment explaining what's
# allowed and what's NOT. Operator's command must match exactly one case;
# otherwise default-deny.

allowed=0
case "$CMD" in
  # systemd user services — gateway restart, status, journals
  "systemctl --user "*|"systemctl --user")           allowed=1 ;;
  "journalctl --user "*|"journalctl --user")         allowed=1 ;;

  # crontab READ ONLY. `crontab -l` lists; bare `crontab` opens stdin
  # which would block in command-mode SSH (no stdin). All write/replace/
  # remove forms are denied so a compromised operator can't install a
  # persistent backdoor that survives privacy-mode expiration.
  "crontab -l"|"crontab -l "*)                       allowed=1 ;;

  # System diagnostics — no user content reachable
  df|"df "*|du|"du "*|free|"free "*)                 allowed=1 ;;
  uptime|"uptime "*|vmstat|"vmstat "*)               allowed=1 ;;
  iostat|"iostat "*|top|"top "*|ps|"ps "*)           allowed=1 ;;
  ping|"ping "*|traceroute|"traceroute "*)           allowed=1 ;;

  # curl restricted to localhost (gateway health/probes) and Telegram API
  # (bot sanity checks). NO general internet — would let operator
  # exfiltrate via POST to attacker-controlled endpoint.
  "curl http://localhost"*|"curl https://localhost"*|"curl http://127.0.0.1"*|"curl https://127.0.0.1"*) allowed=1 ;;
  "curl http://api.telegram.org"*|"curl https://api.telegram.org"*) allowed=1 ;;

  # QA #3: only --version / --help / bare are safe. All subcommands that
  # read protected data (memory, session, config, agents, plugins, mcp)
  # are denied above at SENSITIVE.
  "openclaw --version"|"openclaw -V"|"openclaw --help"|"openclaw -h"|openclaw)  allowed=1 ;;

  # npm install -g openclaw* — for emergency in-place upgrade if the
  # gateway is on a known-broken version. Operator legitimately needs
  # this during incident response. Other npm subcommands NOT allowed.
  "npm install -g openclaw"*)                         allowed=1 ;;

  # git: subcommand-restricted to read-only diagnostics.
  #   pull   = refresh existing repo from upstream (safe; fetches but no hooks)
  #   status = show working-tree state
  #   log    = show commit history
  #   diff   = show changes
  #   fetch  = pull refs without merging (safe)
  #
  # Blocked at SENSITIVE-level (here, by allowlist omission):
  #   clone     = fetches arbitrary repo + runs post-checkout hooks
  #   checkout  = mutates working tree
  #   apply     = patches arbitrary files
  #   reset     = mutates working tree + commit history
  #   push      = could exfiltrate via push to attacker remote
  #   commit    = mutates history
  #   config    = could redirect remote URL
  #   init      = creates new repo (operator could plant arbitrary content)
  #   remote    = could redirect upstream
  #   stash apply = could mutate working tree
  #   cherry-pick = mutates history
  #   rebase    = mutates history
  #   merge     = mutates history
  #   am        = patches from email
  #   bundle    = could exfil entire repo
  #   archive   = could exfil entire repo
  "git pull"|"git pull "*)                            allowed=1 ;;
  "git status"|"git status "*)                        allowed=1 ;;
  "git log"|"git log "*)                              allowed=1 ;;
  "git diff"|"git diff "*)                            allowed=1 ;;
  "git fetch"|"git fetch "*)                          allowed=1 ;;

  # mkdir — operator may need to create a temp dir for diagnostics.
  # No path restriction; mkdir doesn't itself enable exfiltration.
  "mkdir "*)                                          allowed=1 ;;

  # chmod / chown — PATH-RESTRICTED to scripts/ subtrees only.
  # Why this matters: without restriction, an operator could
  # `chmod 644 ~/.openclaw/workspace/MEMORY.md` to make it world-readable
  # for a later non-bridge SSH session, OR `chown root:root` to escalate.
  # The two allowed paths are where the reconciler legitimately drops
  # executable scripts; chmod fixes there is occasionally needed.
  "chmod "*"~/.openclaw/scripts/"*)                   allowed=1 ;;
  "chmod "*"/home/openclaw/.openclaw/scripts/"*)      allowed=1 ;;
  "chmod "*"~/scripts/"*)                             allowed=1 ;;
  "chmod "*"/home/openclaw/scripts/"*)                allowed=1 ;;
  "chown "*"~/.openclaw/scripts/"*)                   allowed=1 ;;
  "chown "*"/home/openclaw/.openclaw/scripts/"*)      allowed=1 ;;
  "chown "*"~/scripts/"*)                             allowed=1 ;;
  "chown "*"/home/openclaw/scripts/"*)                allowed=1 ;;

  # ls / wc — read-only listings
  ls|"ls "*|wc|"wc "*)                                allowed=1 ;;

  # File readers — SENSITIVE deny list above protects the worst paths
  cat|"cat "*|head|"head "*|tail|"tail "*)            allowed=1 ;;
  less|"less "*|more|"more "*)                        allowed=1 ;;

  # echo — output only. Without redirect/chaining (blocked above), inert.
  "echo "*)                                           allowed=1 ;;

  # sed — read-only stream processing. sed -i denied at SENSITIVE above.
  "sed "*)                                            allowed=1 ;;

  # tee REMOVED — `tee filename` truncates the file even without input
  # (no stdin in command-mode SSH). Could nuke this bridge or other
  # files. No legitimate operator use during privacy mode.
esac

if [ "$allowed" != "1" ]; then
  reject "Command not in the privacy-mode allow-list."
fi

# ──────────────────────────────────────────────────────────────────────────
# Stage 9 — exec the (now-validated) command
# ──────────────────────────────────────────────────────────────────────────

log_command "allowed"
exec bash -c "$CMD"
