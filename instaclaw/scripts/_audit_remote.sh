#!/bin/bash
# Audit script — uploaded to a VM via SFTP and executed by
# _full-configureOpenClaw-audit.ts. Emits key=value lines for every check.
yn() { local k=$1; shift; if eval "$@" >/dev/null 2>&1; then echo "$k=yes"; else echo "$k=no"; fi; }
v()  { local k=$1; shift; local out; out=$(eval "$@" 2>/dev/null | head -1); echo "$k=$out"; }

# === ~/.openclaw/scripts/ ===
yn scripts.strip_thinking    "test -x \$HOME/.openclaw/scripts/strip-thinking.py"
yn scripts.vm_watchdog       "test -x \$HOME/.openclaw/scripts/vm-watchdog.py"
yn scripts.silence_watchdog  "test -x \$HOME/.openclaw/scripts/silence-watchdog.py"
yn scripts.push_heartbeat    "test -x \$HOME/.openclaw/scripts/push-heartbeat.sh"
yn scripts.auto_approve      "test -x \$HOME/.openclaw/scripts/auto-approve-pairing.py"

# === ~/scripts/ ===
yn home.dispatch_server      "test -f \$HOME/scripts/dispatch-server.js"
yn home.gateway_watchdog     "test -f \$HOME/scripts/gateway-watchdog.sh"
yn home.dispatch_screenshot  "test -x \$HOME/scripts/dispatch-screenshot.sh"
yn home.dispatch_remote_exec "test -x \$HOME/scripts/dispatch-remote-exec.sh"
yn home.connection_info      "test -x \$HOME/scripts/dispatch-connection-info.sh"
yn home.deliver_file         "test -x \$HOME/scripts/deliver_file.sh"
yn home.notify_user          "test -x \$HOME/scripts/notify_user.sh"
yn home.xmtp_agent           "test -f \$HOME/scripts/xmtp-agent.mjs"

# === ~/.openclaw/workspace/ ===
yn ws.SOUL_md            "test -s \$HOME/.openclaw/workspace/SOUL.md"
yn ws.MEMORY_md          "test -f \$HOME/.openclaw/workspace/MEMORY.md"
yn ws.BOOTSTRAP_md       "test -f \$HOME/.openclaw/workspace/BOOTSTRAP.md"
yn ws.EARN_md            "test -f \$HOME/.openclaw/workspace/EARN.md"
yn ws.CAPABILITIES_md    "test -f \$HOME/.openclaw/workspace/CAPABILITIES.md"
yn ws.QUICK_REFERENCE_md "test -f \$HOME/.openclaw/workspace/QUICK-REFERENCE.md"
yn ws.TOOLS_md           "test -f \$HOME/.openclaw/workspace/TOOLS.md"
yn ws.WALLET_md          "test -f \$HOME/.openclaw/workspace/WALLET.md"
yn ws.memory_dir         "test -d \$HOME/.openclaw/workspace/memory"
yn ws.session_log        "test -f \$HOME/.openclaw/workspace/memory/session-log.md"
yn ws.active_tasks       "test -f \$HOME/.openclaw/workspace/memory/active-tasks.md"

# === Config files ===
yn cfg.openclaw_json    "test -s \$HOME/.openclaw/openclaw.json"
yn cfg.exec_approvals   "test -s \$HOME/.openclaw/exec-approvals.json"
yn cfg.exec_full_sec    'grep -q "\"security\".*\"full\"" $HOME/.openclaw/exec-approvals.json'
yn cfg.dotenv           "test -s \$HOME/.openclaw/.env"
yn cfg.dotenv_token     'grep -q "^GATEWAY_TOKEN=." $HOME/.openclaw/.env'
yn cfg.pin_file         "test -s \$HOME/.openclaw/.openclaw-pinned-version"
v  cfg.pin_value        "cat \$HOME/.openclaw/.openclaw-pinned-version"
yn cfg.auth_profiles    "test -s \$HOME/.openclaw/agents/main/agent/auth-profiles.json"
yn cfg.auth_anthropic   'grep -q "anthropic:default" $HOME/.openclaw/agents/main/agent/auth-profiles.json'
yn cfg.system_prompt    "test -s \$HOME/.openclaw/agents/main/agent/system-prompt.md"

# === Skills ===
yn skill.dispatch       "test -d \$HOME/.openclaw/skills/computer-dispatch"
yn skill.dispatch_md    "test -s \$HOME/.openclaw/skills/computer-dispatch/SKILL.md"
yn skill.dgclaw         "test -d \$HOME/.openclaw/skills/dgclaw"
yn skill.newsworthy     "test -d \$HOME/.openclaw/skills/newsworthy"
yn skill.bankr          "test -d \$HOME/.openclaw/skills/bankr"

# === Systemd ===
export XDG_RUNTIME_DIR=/run/user/$(id -u)
yn sysd.gateway_active        'systemctl --user is-active openclaw-gateway 2>&1 | grep -q "^active$"'
yn sysd.dispatch_unit         "test -f \$HOME/.config/systemd/user/dispatch-server.service"
yn sysd.dispatch_active       'systemctl --user is-active dispatch-server 2>&1 | grep -q "^active$"'
yn sysd.instaclaw_xmtp_unit   "test -f \$HOME/.config/systemd/user/instaclaw-xmtp.service"
yn sysd.instaclaw_xmtp_active 'systemctl --user is-active instaclaw-xmtp 2>&1 | grep -q "^active$"'
yn sysd.gw_watchdog_timer     'systemctl --user is-active gateway-watchdog.timer 2>&1 | grep -q "^active$"'

# === Crons ===
yn cron.shm_cleanup      'crontab -l 2>/dev/null | grep -q "SHM_CLEANUP"'
yn cron.strip_thinking   'crontab -l 2>/dev/null | grep -q "strip-thinking.py"'
yn cron.auto_approve     'crontab -l 2>/dev/null | grep -q "auto-approve-pairing.py"'
yn cron.vm_watchdog      'crontab -l 2>/dev/null | grep -q "vm-watchdog.py"'
yn cron.push_heartbeat   'crontab -l 2>/dev/null | grep -q "push-heartbeat.sh"'
yn cron.silence_watchdog 'crontab -l 2>/dev/null | grep -q "silence-watchdog.py"'
yn cron.memory_index     'crontab -l 2>/dev/null | grep -q "openclaw memory index"'

# === Ports ===
yn port.gateway_18789    'ss -tln 2>/dev/null | grep -q ":18789 "'
yn port.dispatch_8765    'ss -tln 2>/dev/null | grep -q ":8765 "'
yn port.novnc_6080       'ss -tln 2>/dev/null | grep -q ":6080 "'
yn port.node_exporter    'ss -tln 2>/dev/null | grep -q ":9100 "'

# === TLS certs ===
yn tls.dispatch_cert     "test -s \$HOME/.dispatch-server-certs/cert.pem"
yn tls.dispatch_key      "test -s \$HOME/.dispatch-server-certs/key.pem"

# === System binaries ===
yn bin.chromium          "test -x /usr/local/bin/chromium-browser || which chromium-browser"
yn bin.ffmpeg            "which ffmpeg"
yn bin.jq                "which jq"
yn bin.Xvfb              "which Xvfb"
yn bin.x11vnc            "which x11vnc"
yn bin.websockify        "which websockify"
yn bin.node_exporter     "which node_exporter"
yn bin.socat             "which socat"

# === Node ===
# Use nvm's actual default (`nvm which default`) instead of alphabetically-first
# glob. With multiple Node versions installed (e.g., v22.22.0 + v22.22.2 during
# the v64 bake), `head -1` picked v22.22.0 even though v22.22.2 was the active
# default — leading to a misleading nvm.node_version=v22.22.0 audit line on a
# VM that was actually running v22.22.2. Falls back to alphabetically-LAST glob
# if nvm sourcing fails (so single-version VMs still report correctly).
NPATH=$(. $HOME/.nvm/nvm.sh 2>/dev/null && nvm which default 2>/dev/null || ls -d $HOME/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1)
NDIR=$(dirname "$NPATH" 2>/dev/null)
yn nvm.node_v22          "echo \$NDIR | grep -q v22"
v  nvm.node_version      "$NPATH --version 2>/dev/null"
yn npm.openclaw          "ls -d \$HOME/.nvm/versions/node/*/lib/node_modules/openclaw 2>/dev/null | grep -q ."
yn npm.bankr_cli         "ls -d \$HOME/.nvm/versions/node/*/lib/node_modules/@bankr 2>/dev/null | grep -q ."
yn npm.ws_in_scripts     "test -d \$HOME/scripts/node_modules/ws"

yn host.linger_enabled   'loginctl show-user openclaw 2>/dev/null | grep -q Linger=yes'
yn gw.health_responds    'curl -sS -m 3 http://127.0.0.1:18789/health 2>/dev/null | grep -q "ok.*true"'
echo END
