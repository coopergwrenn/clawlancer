#!/usr/bin/env bash
# privacy-bridge.sh — Maximum Privacy Mode SSH command bridge for edge_city VMs.
# Source of truth: instaclaw/lib/privacy-bridge.sh. Loaded into the reconciler
# via lib/privacy-bridge-script.ts (fs.readFileSync). Do not edit on VM.

set -uo pipefail

ENV_FILE="$HOME/.openclaw/.env"
CACHE_DIR="$HOME/.openclaw/cache"
CACHE_FILE="$CACHE_DIR/privacy-mode.json"
CACHE_TTL_SECONDS=30
API_BASE="${INSTACLAW_API_BASE:-https://instaclaw.io}"
LOG_ENDPOINT="$API_BASE/api/internal/log-operator-command"
CHECK_ENDPOINT="$API_BASE/api/internal/check-privacy-mode"
CMD="${SSH_ORIGINAL_COMMAND:-}"

mkdir -p "$CACHE_DIR" 2>/dev/null

if [ ! -f "$ENV_FILE" ]; then
  echo "privacy-bridge: missing $ENV_FILE — failing open" >&2
  exec bash -c "$CMD"
fi
GATEWAY_TOKEN="$(grep -E '^GATEWAY_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
if [ -z "$GATEWAY_TOKEN" ]; then
  echo "privacy-bridge: GATEWAY_TOKEN empty in $ENV_FILE — failing open" >&2
  exec bash -c "$CMD"
fi

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
    STATE="$(cat "$CACHE_FILE" 2>/dev/null)"
  fi
fi

ACTIVE="false"
PARTNER="null"
if [ -n "$STATE" ]; then
  ACTIVE="$(printf '%s' "$STATE" | sed -n 's/.*"active":\s*\(true\|false\).*/\1/p' | head -1)"
  PARTNER="$(printf '%s' "$STATE" | sed -n 's/.*"partner":\s*"\([^"]*\)".*/\1/p' | head -1)"
  [ -z "$ACTIVE" ] && ACTIVE="false"
fi

json_string() { python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'; }

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

  Allowed: systemctl --user, journalctl --user, crontab -l,
  df/du/free/uptime/ps, openclaw CLI, npm install -g
  openclaw@*, git, ls/wc, curl to localhost or
  api.telegram.org, reads of ~/.openclaw/.env, openclaw.json,
  ~/scripts/, ~/.openclaw/skills/, /var/log, /etc, and the
  workspace template files (SOUL/CAPABILITIES/QUICK-REFERENCE
  /TOOLS/EARN.md).

  Blocked: any read of ~/.openclaw/workspace/sessions/*,
  MEMORY.md, agents/*, mcporter, scp/sftp/rsync, strace/gdb
  /lsof, /proc/<pid>/{maps,mem,fd}, /dev/shm, command
  chaining (;|&), interactive shells.
─────────────────────────────────────────────────────
EOF
  exit 1
}

# Privacy OFF or non-edge_city → log normal access and execute.
# Empty CMD = interactive shell attempt; allow it when privacy is OFF.
if [ "$ACTIVE" != "true" ] || [ "$PARTNER" != "edge_city" ]; then
  log_command "allowed_privacy_off"
  if [ -z "$CMD" ]; then
    exec bash -l
  fi
  exec bash -c "$CMD"
fi

# ── Privacy ON enforcement ───────────────────────────────────────────────

if [ -z "$CMD" ]; then
  reject "Interactive shell attempted. Privacy mode requires command-mode SSH only — pass the command on the ssh line."
fi

# Reject command-chaining / redirection metacharacters. v0 is conservative:
# single command only.
case "$CMD" in
  *";"*|*"&&"*|*"||"*|*"|"*|*'`'*|*'$('*|*">"*|*"<"*)
    reject "Command chaining or redirection (;, &&, ||, |, backtick, \$(), >, <) is not allowed under privacy mode."
    ;;
esac

# ── SENSITIVE deny FIRST ─────────────────────────────────────────────────
case "$CMD" in
  *.openclaw/workspace/sessions/*|*MEMORY.md*|*.openclaw/workspace/memory/*|*.openclaw/agents/*)
    reject "Refusing to touch agent memory / sessions / agents/. Those are protected under privacy mode." ;;
  mcporter|"mcporter "*)
    reject "mcporter is fully blocked under privacy mode (v0)." ;;
  "scp -f"*|"scp -t"*|sftp|"sftp "*|rsync|"rsync "*)
    reject "File transfer commands are blocked under privacy mode." ;;
  strace|"strace "*|gdb|"gdb "*|lsof|"lsof "*)
    reject "Process inspection tools are blocked under privacy mode." ;;
  *"/proc/"*|*"/dev/shm"*)
    reject "Reads of /proc/<pid>/{maps,mem,fd} or /dev/shm are blocked under privacy mode." ;;
  find|"find "*|grep|"grep "*|"egrep "*|"fgrep "*|rg|"rg "*)
    reject "find/grep/rg are blocked under privacy mode (v0) to prevent recursive exfiltration." ;;
esac

# ── Whitelist match — first-token family detection ───────────────────────
allowed=0
case "$CMD" in
  "systemctl --user "*|"systemctl --user")           allowed=1 ;;
  "journalctl --user "*|"journalctl --user")         allowed=1 ;;
  "crontab -l"|crontab)                              allowed=1 ;;
  df|"df "*|du|"du "*|free|"free "*)                 allowed=1 ;;
  uptime|"uptime "*|vmstat|"vmstat "*)               allowed=1 ;;
  iostat|"iostat "*|top|"top "*|ps|"ps "*)           allowed=1 ;;
  ping|"ping "*|traceroute|"traceroute "*)           allowed=1 ;;
  "curl http://localhost"*|"curl https://localhost"*|"curl http://127.0.0.1"*|"curl https://127.0.0.1"*) allowed=1 ;;
  "curl http://api.telegram.org"*|"curl https://api.telegram.org"*) allowed=1 ;;
  openclaw|"openclaw "*)                              allowed=1 ;;
  "npm install -g openclaw"*)                         allowed=1 ;;
  git|"git "*)                                        allowed=1 ;;
  "mkdir "*|"chmod "*|"chown "*)                      allowed=1 ;;
  ls|"ls "*|wc|"wc "*)                                allowed=1 ;;
  cat|"cat "*|head|"head "*|tail|"tail "*)            allowed=1 ;;
  less|"less "*|more|"more "*)                        allowed=1 ;;
  "echo "*|"sed "*|"tee "*)                           allowed=1 ;;
esac

if [ "$allowed" != "1" ]; then
  reject "Command not in the privacy-mode allow-list."
fi

log_command "allowed"
exec bash -c "$CMD"
