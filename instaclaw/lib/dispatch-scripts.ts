// AUTO-GENERATED — do not edit by hand.
// Regenerate with: node scripts/_gen-dispatch-scripts.mjs
//
// Source of truth for these scripts is on disk at:
//   skills/computer-dispatch/scripts/*.sh
//   skills/computer-dispatch/dispatch-server.js
//   skills/computer-dispatch/SKILL.md
//
// Why inline instead of fs.readFileSync from skills/?
//   Next 15's @vercel/nft tracer silently drops .sh files from the
//   bundle even with outputFileTracingIncludes. Inlining as TS
//   template literals sidesteps the bundler entirely — same pattern
//   as STRIP_THINKING_SCRIPT, VM_WATCHDOG_SCRIPT, etc. in lib/ssh.ts.

/** Per-script content, base64-decoded by configureOpenClaw on the VM. */
export const DISPATCH_SCRIPTS: Record<string, string> = {
  "dispatch-screenshot.sh": `#!/bin/bash
# dispatch-screenshot.sh — Capture VM screen, convert to WebP, output JSON
set -euo pipefail
export DISPLAY=:99
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Save to workspace so deliver_file.sh can serve it
WSDIR="$HOME/.openclaw/workspace"
mkdir -p "$WSDIR"
TS=$(date +%s%N)
PNG="/tmp/dispatch-ss-\${TS}.png"
OUTFILE="\${WSDIR}/dispatch-screenshot.webp"
JPGFILE="\${WSDIR}/dispatch-screenshot.jpg"

# Capture screenshot via usecomputer (outputs PNG)
OUTPUT=$(usecomputer screenshot "$PNG" --json 2>&1) || {
  echo '{"error":"screenshot failed"}'
  exit 1
}

COORD_MAP=$(echo "$OUTPUT" | tr -d '\\n' | grep -o '"coordMap":"[^"]*"' | cut -d'"' -f4 || echo "0,0,1280,720,1280,720")

# Convert to WebP at quality 55 (smaller + faster than JPEG 80)
# Fall back to JPEG, then PNG
if convert "$PNG" -quality 55 -resize '1280x>' "$OUTFILE" 2>/dev/null; then
  rm -f "$PNG"
  FMT="webp"
elif convert "$PNG" -quality 55 -resize '1280x>' "$JPGFILE" 2>/dev/null; then
  rm -f "$PNG"
  OUTFILE="$JPGFILE"
  FMT="jpeg"
else
  OUTFILE="$PNG"
  FMT="png"
fi

FILESIZE=$(stat -c%s "$OUTFILE" 2>/dev/null || stat -f%z "$OUTFILE")

# Output ONLY metadata — no base64
echo "{\\"path\\":\\"\${OUTFILE}\\",\\"coordMap\\":\\"\${COORD_MAP}\\",\\"format\\":\\"\${FMT}\\",\\"size_bytes\\":\${FILESIZE}}"
`,
  "dispatch-click.sh": `#!/bin/bash
# dispatch-click.sh X Y — Click at screenshot coordinates
set -euo pipefail
export DISPLAY=:99
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

X=\${1:?Usage: dispatch-click.sh X Y}
Y=\${2:?Usage: dispatch-click.sh X Y}
usecomputer click "$X,$Y"
echo "{\\"success\\":true,\\"action\\":\\"click\\",\\"x\\":$X,\\"y\\":$Y}"
`,
  "dispatch-type.sh": `#!/bin/bash
# dispatch-type.sh "text" — Type text via xdotool (handles spaces + special chars)
set -euo pipefail
export DISPLAY=:99

TEXT=\${1:?Usage: dispatch-type.sh "text"}
xdotool type --delay 12 -- "$TEXT"
echo "{\\"success\\":true,\\"action\\":\\"type\\"}"
`,
  "dispatch-press.sh": `#!/bin/bash
# dispatch-press.sh "key" — Press key combo (e.g. ctrl+c, Return, Tab)
set -euo pipefail
export DISPLAY=:99
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

KEY=\${1:?Usage: dispatch-press.sh "key"}
usecomputer press "$KEY"
echo "{\\"success\\":true,\\"action\\":\\"press\\",\\"key\\":\\"$KEY\\"}"
`,
  "dispatch-scroll.sh": `#!/bin/bash
# dispatch-scroll.sh direction [amount] — Scroll up/down/left/right
set -euo pipefail
export DISPLAY=:99
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

DIR=\${1:?Usage: dispatch-scroll.sh direction [amount]}
AMT=\${2:-3}
usecomputer scroll "$DIR" "$AMT"
echo "{\\"success\\":true,\\"action\\":\\"scroll\\",\\"direction\\":\\"$DIR\\",\\"amount\\":$AMT}"
`,
  "dispatch-browser.sh": `#!/bin/bash
# dispatch-browser.sh <url> — Launch stealth Chrome on the virtual desktop
set -euo pipefail
export DISPLAY=:99

URL="\${1:?Usage: dispatch-browser.sh <url>}"

# RAM safety check — dispatch Chrome needs ~700-1100MB
AVAIL_MB=$(free -m | awk '/Mem:/ {print $7}')
if [ "$AVAIL_MB" -lt 500 ]; then
  echo "{\\"error\\":\\"insufficient RAM\\",\\"available_mb\\":\${AVAIL_MB},\\"required_mb\\":500,\\"hint\\":\\"Use the headless browser tool instead — not enough RAM for dispatch Chrome\\"}"
  exit 1
fi

CHROME="/home/openclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome"
PROFILE_DIR="/home/openclaw/.dispatch-chrome-profile"
STEALTH_EXT="$PROFILE_DIR/stealth-ext"
PIDFILE="/tmp/dispatch-chrome.pid"

# Check if dispatch Chrome is already running
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  curl -s "http://localhost:19222/json/new?\${URL}" > /dev/null 2>&1 && {
    sleep 3
    echo "{\\"success\\":true,\\"action\\":\\"new_tab\\",\\"url\\":\\"\${URL}\\"}"
    exit 0
  }
fi

# Kill any stale dispatch Chrome instances
pkill -f ".dispatch-chrome-profile" 2>/dev/null || true
sleep 1

# Ensure stealth extension exists
mkdir -p "$STEALTH_EXT"

cat > "$STEALTH_EXT/manifest.json" << 'MEOF'
{
  "name": "Stealth",
  "version": "1.0",
  "manifest_version": 3,
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["stealth.js"],
    "run_at": "document_start",
    "all_frames": true,
    "world": "MAIN"
  }]
}
MEOF

cat > "$STEALTH_EXT/stealth.js" << 'SEOF'
// --- Anti-detection stealth patches ---

// 1. Hide webdriver flag (the #1 detection signal)
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

// 2. Fix languages
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

// 3. Fake plugins (real Chrome has default plugins)
Object.defineProperty(navigator, 'plugins', {
  get: () => {
    const p = [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1 },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', length: 1 },
    ];
    p.item = (i) => p[i]; p.namedItem = (n) => p.find(x => x.name === n); p.refresh = () => {};
    return p;
  }
});

// 4. Fix chrome.runtime (missing in automation)
if (!window.chrome) window.chrome = {};
if (!window.chrome.runtime) window.chrome.runtime = { connect: () => {}, sendMessage: () => {} };

// 5. Fix permissions query
const origPQ = navigator.permissions.query.bind(navigator.permissions);
navigator.permissions.query = (p) =>
  p.name === 'notifications' ? Promise.resolve({ state: Notification.permission }) : origPQ(p);

// 6. Fix Function.prototype.toString for patched functions
const origTS = Function.prototype.toString;
const overrides = new Map();
overrides.set(navigator.permissions.query, 'function query() { [native code] }');
Function.prototype.toString = function() {
  return overrides.get(this) || origTS.call(this);
};
overrides.set(Function.prototype.toString, 'function toString() { [native code] }');

// 7. Fix WebGL renderer (Xvfb uses llvmpipe which is a bot signal)
try {
  for (const Proto of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
    const orig = Proto.getParameter;
    Proto.getParameter = function(p) {
      if (p === 37445) return 'Google Inc. (NVIDIA)';
      if (p === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Direct3D11 vs_5_0 ps_5_0, D3D11)';
      return orig.call(this, p);
    };
  }
} catch(e) {}

// 8. Spoof screen dimensions to something common (not 1280x720 which is unusual)
try {
  Object.defineProperty(screen, 'width', { get: () => 1920 });
  Object.defineProperty(screen, 'height', { get: () => 1080 });
  Object.defineProperty(screen, 'availWidth', { get: () => 1920 });
  Object.defineProperty(screen, 'availHeight', { get: () => 1040 });
  Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
} catch(e) {}
SEOF

mkdir -p "$PROFILE_DIR"

nohup "$CHROME" \\
  --no-sandbox \\
  --disable-gpu \\
  --disable-software-rasterizer \\
  --disable-dev-shm-usage \\
  --disable-background-networking \\
  --disable-default-apps \\
  --disable-sync \\
  --disable-translate \\
  --no-first-run \\
  --no-default-browser-check \\
  --disable-session-crashed-bubble \\
  --hide-crash-restore-bubble \\
  --disable-blink-features=AutomationControlled \\
  --user-agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" \\
  --lang=en-US \\
  --load-extension="$STEALTH_EXT" \\
  --user-data-dir="$PROFILE_DIR" \\
  --remote-debugging-port=19222 \\
  --window-size=1280,700 \\
  --window-position=0,0 \\
  "$URL" \\
  > /tmp/dispatch-chrome.log 2>&1 &
disown

CHROME_PID=$!
echo "$CHROME_PID" > "$PIDFILE"

# Wait for CDP to be ready
for i in 1 2 3 4 5 6 7 8; do
  sleep 1
  curl -s http://localhost:19222/json/version > /dev/null 2>&1 && break
done

if kill -0 "$CHROME_PID" 2>/dev/null; then
  TOTAL_RSS=$(ps aux | grep -v grep | grep ".dispatch-chrome-profile" | awk '{total += $6} END {printf "%.0f", total/1024}')
  echo "{\\"success\\":true,\\"action\\":\\"launched\\",\\"url\\":\\"\${URL}\\",\\"pid\\":\${CHROME_PID},\\"total_rss_mb\\":\${TOTAL_RSS:-0},\\"stealth\\":true}"
else
  LOG=$(tail -3 /tmp/dispatch-chrome.log 2>/dev/null | tr '"' "'" | tr '\\n' ' ')
  echo "{\\"error\\":\\"chrome failed to start\\",\\"log\\":\\"\${LOG}\\"}"
  exit 1
fi
`,
  "dispatch-remote-screenshot.sh": `#!/bin/bash
# dispatch-remote-screenshot.sh — Capture the user's screen via dispatch relay
# Saves image to workspace, returns only metadata (NO base64 in stdout)
set -euo pipefail

SOCKET="/tmp/dispatch.sock"
OUTFILE="$HOME/.openclaw/workspace/dispatch-remote-screenshot.jpg"
TMPRESPONSE="/tmp/dispatch-remote-response-$$.json"
trap "rm -f '$TMPRESPONSE'" EXIT

if [ ! -S "$SOCKET" ]; then
  echo '{"error":"dispatch relay not connected","hint":"User needs to run instaclaw-dispatch on their computer"}'
  exit 1
fi

# Request WebP at quality 55 for optimal speed/size
echo '{"type":"screenshot","params":{"format":"webp","quality":55}}' | nc -U -w 30 "$SOCKET" > "$TMPRESPONSE" 2>/dev/null || {
  echo '{"error":"dispatch server not responding"}'
  exit 1
}

# Extract image to disk using node (faster than python3 startup)
TMPRESPONSE="$TMPRESPONSE" OUTFILE="$OUTFILE" node -e "
const fs = require('fs');
try {
  const raw = fs.readFileSync(process.env.TMPRESPONSE, 'utf-8').trim();
  const d = JSON.parse(raw);
  if (d.error) { console.log(JSON.stringify(d)); process.exit(0); }
  if (d.image_base64) {
    const buf = Buffer.from(d.image_base64, 'base64');
    fs.writeFileSync(process.env.OUTFILE, buf);
    console.log(JSON.stringify({
      path: process.env.OUTFILE,
      size_bytes: buf.length,
      width: d.width || null,
      height: d.height || null,
      format: d.format || 'webp',
      coordMap: d.coordMap || '',
    }));
  } else {
    console.log(JSON.stringify({error: 'No image data in response'}));
  }
} catch (e) {
  console.log(JSON.stringify({error: 'Failed to parse response: ' + e.message}));
}
" 2>/dev/null
`,
  "dispatch-remote-click.sh": `#!/bin/bash
# dispatch-remote-click.sh X Y — Click on user's screen via dispatch relay
set -euo pipefail
SOCKET="/tmp/dispatch.sock"
X=\${1:?Usage: dispatch-remote-click.sh X Y}
Y=\${2:?Usage: dispatch-remote-click.sh X Y}
[ -S "$SOCKET" ] || { echo '{"error":"dispatch relay not connected"}'; exit 1; }
echo "{\\"type\\":\\"click\\",\\"params\\":{\\"x\\":$X,\\"y\\":$Y}}" | nc -U -w 10 "$SOCKET" 2>/dev/null || echo '{"error":"dispatch server not responding"}'
`,
  "dispatch-remote-type.sh": `#!/bin/bash
# dispatch-remote-type.sh "text" — Type on user's keyboard via dispatch relay
set -euo pipefail
SOCKET="/tmp/dispatch.sock"
TEXT=\${1:?Usage: dispatch-remote-type.sh "text"}
[ -S "$SOCKET" ] || { echo '{"error":"dispatch relay not connected"}'; exit 1; }
# Escape the text for JSON
ESCAPED=$(echo "$TEXT" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read().rstrip()))" 2>/dev/null)
echo "{\\"type\\":\\"type\\",\\"params\\":{\\"text\\":$ESCAPED}}" | nc -U -w 10 "$SOCKET" 2>/dev/null || echo '{"error":"dispatch server not responding"}'
`,
  "dispatch-remote-press.sh": `#!/bin/bash
# dispatch-remote-press.sh "key" — Press key on user's machine via dispatch relay
set -euo pipefail
SOCKET="/tmp/dispatch.sock"
KEY=\${1:?Usage: dispatch-remote-press.sh "key"}
[ -S "$SOCKET" ] || { echo '{"error":"dispatch relay not connected"}'; exit 1; }
echo "{\\"type\\":\\"press\\",\\"params\\":{\\"key\\":\\"$KEY\\"}}" | nc -U -w 10 "$SOCKET" 2>/dev/null || echo '{"error":"dispatch server not responding"}'
`,
  "dispatch-remote-scroll.sh": `#!/bin/bash
# dispatch-remote-scroll.sh direction [amount] — Scroll on user's machine via dispatch relay
set -euo pipefail
SOCKET="/tmp/dispatch.sock"
DIR=\${1:?Usage: dispatch-remote-scroll.sh direction [amount]}
AMT=\${2:-3}
[ -S "$SOCKET" ] || { echo '{"error":"dispatch relay not connected"}'; exit 1; }
echo "{\\"type\\":\\"scroll\\",\\"params\\":{\\"direction\\":\\"$DIR\\",\\"amount\\":$AMT}}" | nc -U -w 10 "$SOCKET" 2>/dev/null || echo '{"error":"dispatch server not responding"}'
`,
  "dispatch-remote-status.sh": `#!/bin/bash
# dispatch-remote-status.sh — Check if dispatch relay is connected
# Uses TCP connection check (ss) as primary method — Unix socket is unreliable after restarts
set -euo pipefail

# Primary: check for ESTABLISHED WebSocket connections on port 8765
ESTAB=$(ss -tnp 2>/dev/null | grep ":8765" | grep -c ESTAB 2>/dev/null || echo 0)
if [ "$ESTAB" -gt 0 ]; then
  echo "{\\"connected\\":true,\\"activeConnections\\":$ESTAB}"
  exit 0
fi

# Fallback: try Unix socket (may be flaky)
SOCKET="/tmp/dispatch.sock"
if [ -S "$SOCKET" ]; then
  RESP=$(echo '{"type":"status"}' | nc -U -w 3 "$SOCKET" 2>/dev/null) && {
    echo "$RESP"
    exit 0
  }
fi

# Check if dispatch-server is at least running
if pgrep -f "node.*dispatch-server" > /dev/null 2>&1; then
  echo '{"connected":false,"dispatchServer":true,"error":"dispatch server running but no relay connected"}'
else
  echo '{"connected":false,"dispatchServer":false,"error":"dispatch server not running"}'
fi
`,
  "dispatch-remote-batch.sh": `#!/bin/bash
# dispatch-remote-batch.sh — Execute multiple actions in one round-trip + auto-screenshot
# Usage: dispatch-remote-batch.sh '<JSON>'
#
# Example JSON:
#   '{"actions":[{"type":"click","params":{"x":400,"y":300},"waitAfterMs":100},{"type":"type","params":{"text":"hello"},"waitAfterMs":0},{"type":"press","params":{"key":"Return"},"waitAfterMs":1500}]}'
#
# Options in JSON root:
#   screenshotAfter: true (default) — take screenshot after batch completes
#   screenshotFormat: "webp" (default) — "webp" or "jpeg"
#   screenshotQuality: 55 (default) — 1-100
#   settleMs: 300 (default) — wait before screenshot for screen to settle
set -euo pipefail

SOCKET="/tmp/dispatch.sock"
OUTFILE="$HOME/.openclaw/workspace/dispatch-remote-screenshot.jpg"
BATCH_JSON=\${1:?Usage: dispatch-remote-batch.sh '<JSON actions>'}
TMPRESPONSE="/tmp/dispatch-batch-response-$$.json"
trap "rm -f '$TMPRESPONSE'" EXIT

if [ ! -S "$SOCKET" ]; then
  echo '{"error":"dispatch relay not connected","hint":"User needs to run instaclaw-dispatch on their computer"}'
  exit 1
fi

# Wrap in batch command
FULL_CMD="{\\"type\\":\\"batch\\",\\"params\\":$BATCH_JSON}"

# Send batch command, save response
echo "$FULL_CMD" | nc -U -w 60 "$SOCKET" > "$TMPRESPONSE" 2>/dev/null || {
  echo '{"error":"dispatch server not responding"}'
  exit 1
}

# If response contains image_base64, extract to disk and strip it from output
TMPRESPONSE="$TMPRESPONSE" OUTFILE="$OUTFILE" node -e "
const fs = require('fs');
try {
  const raw = fs.readFileSync(process.env.TMPRESPONSE, 'utf-8').trim();
  const d = JSON.parse(raw);
  if (d.image_base64) {
    const buf = Buffer.from(d.image_base64, 'base64');
    fs.writeFileSync(process.env.OUTFILE, buf);
    delete d.image_base64;
    d.screenshot_path = process.env.OUTFILE;
    d.screenshot_size_bytes = buf.length;
  }
  console.log(JSON.stringify(d));
} catch (e) {
  // If JSON parse fails, output raw
  try { console.log(fs.readFileSync(process.env.TMPRESPONSE, 'utf-8')); } catch { console.log('{\\"error\\":\\"failed to read response\\"}'); }
}
" 2>/dev/null
`,
  "dispatch-remote-drag.sh": `#!/bin/bash
# dispatch-remote-drag.sh fromX fromY toX toY — Drag on user's screen via dispatch relay
set -euo pipefail
SOCKET="/tmp/dispatch.sock"
FROM_X=\${1:?Usage: dispatch-remote-drag.sh fromX fromY toX toY}
FROM_Y=\${2:?Usage: dispatch-remote-drag.sh fromX fromY toX toY}
TO_X=\${3:?Usage: dispatch-remote-drag.sh fromX fromY toX toY}
TO_Y=\${4:?Usage: dispatch-remote-drag.sh fromX fromY toX toY}
[ -S "$SOCKET" ] || { echo '{"error":"dispatch relay not connected"}'; exit 1; }
echo "{\\"type\\":\\"drag\\",\\"params\\":{\\"fromX\\":$FROM_X,\\"fromY\\":$FROM_Y,\\"toX\\":$TO_X,\\"toY\\":$TO_Y}}" | nc -U -w 10 "$SOCKET" 2>/dev/null || echo '{"error":"dispatch server not responding"}'
`,
  "dispatch-remote-windows.sh": `#!/bin/bash
# dispatch-remote-windows.sh — List open windows on user's machine via dispatch relay
set -euo pipefail
SOCKET="/tmp/dispatch.sock"
[ -S "$SOCKET" ] || { echo '{"error":"dispatch relay not connected"}'; exit 1; }
echo '{"type":"windows","params":{}}' | nc -U -w 10 "$SOCKET" 2>/dev/null || echo '{"error":"dispatch server not responding"}'
`,
  "dispatch-windows.sh": `#!/bin/bash
# dispatch-windows.sh — List open windows on the VM virtual desktop (JSON)
set -euo pipefail
export DISPLAY=:99
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

usecomputer window list --json 2>/dev/null || echo '{"error":"window list failed"}'
`,
  "gateway-watchdog.sh": `#!/bin/bash
# gateway-watchdog.sh v4 — Auto-restart gateway if hung, stuck, or Telegram disconnected
# Runs every 2 minutes via systemd timer.
#
# Checks:
#   1. Session size cap (>500KB → immediate archive + restart)
#   2. Gateway health endpoint (HTTP 200)
#   3. Gateway process alive
#   4. Frozen gateway (session modified recently but no sendMessage in 3 min)
#   5. Dead Telegram (gateway running 10+ min but zero Telegram activity in app log)
#
# Each check that fails = immediate or 2-consecutive-failure restart.

set -euo pipefail
export XDG_RUNTIME_DIR="/run/user/$(id -u)"

STATE_FILE="/tmp/gateway-watchdog-state"
LOG="$HOME/watchdog.log"
HEALTH_URL="http://localhost:18789/health"
SESSION_FILE="$HOME/.openclaw/agents/main/sessions/sessions.json"
APP_LOG_DIR="/tmp/openclaw"
MAX_SESSION_KB=500
MAX_LOG_LINES=500

log() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $1" >> "$LOG"
}

# Rotate log
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG" 2>/dev/null || echo 0)" -gt "$MAX_LOG_LINES" ]; then
  tail -200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

FAILURES=0
[ -f "$STATE_FILE" ] && FAILURES=$(cat "$STATE_FILE" 2>/dev/null || echo 0)

do_restart() {
  local REASON="$1"
  local ARCHIVE_SESSION="\${2:-false}"
  log "RESTART: $REASON"
  if [ "$ARCHIVE_SESSION" = "true" ] && [ -f "$SESSION_FILE" ]; then
    local SK=$(du -k "$SESSION_FILE" 2>/dev/null | cut -f1)
    log "  Archiving session (\${SK}KB)"
    cp "$SESSION_FILE" "\${SESSION_FILE}.$(date +%s).bak" 2>/dev/null || true
    echo "[]" > "$SESSION_FILE"
    ls -1t "\${SESSION_FILE}".*.bak 2>/dev/null | tail -n +6 | xargs rm -f 2>/dev/null || true
  fi
  systemctl --user restart openclaw-gateway 2>/dev/null
  sleep 8
  if systemctl --user is-active openclaw-gateway > /dev/null 2>&1; then
    log "RECOVERED: gateway restarted"
  else
    log "FAILED: gateway did not restart"
  fi
  echo 0 > "$STATE_FILE"
}

# ── Check 1: Session size cap (IMMEDIATE) ──
if [ -f "$SESSION_FILE" ]; then
  SESSION_KB=$(du -k "$SESSION_FILE" 2>/dev/null | cut -f1)
  if [ "\${SESSION_KB:-0}" -gt "$MAX_SESSION_KB" ]; then
    do_restart "SESSION_OVERFLOW(\${SESSION_KB}KB)" "true"
    exit 0
  fi
fi

# ── Check 2: Health endpoint ──
HEALTH_OK=false
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 "$HEALTH_URL" 2>/dev/null || echo "000")
[ "$HTTP_CODE" = "200" ] && HEALTH_OK=true

# ── Check 3: Process alive ──
PROC_OK=false
systemctl --user is-active openclaw-gateway > /dev/null 2>&1 && PROC_OK=true

# ── Compute gateway uptime (used by Check 4 + Check 5) ──
GW_AGE=0
GW_START=$(systemctl --user show openclaw-gateway --property=ActiveEnterTimestamp 2>/dev/null | cut -d= -f2)
if [ -n "$GW_START" ]; then
  GW_START_TS=$(date -d "$GW_START" +%s 2>/dev/null || echo 0)
  GW_AGE=$(( $(date +%s) - GW_START_TS ))
fi

# ── Check 4: Frozen gateway (session modified but no response sent) ──
# v68 (2026-04-30): added GW_AGE>600 guard. The FROZEN check uses LAST_SEND
# from the daily app log, which survives across gateway restarts. After a
# restart, a fresh gateway with no successful sendMessage today gets judged
# "frozen" within 2 min and killed — creating an infinite watchdog→cold-start→
# kill loop affecting users who resume after long idle. Skip the check until
# the gateway has been up >= 10 min, mirroring TELEGRAM_DEAD's existing guard.
# Confirmed on vm-773 (Lee): 20 SIGTERMs in 24h, gateway never staying up >8min.
FROZEN=false
if [ "$HEALTH_OK" = true ] && [ "$PROC_OK" = true ] && [ -f "$SESSION_FILE" ] && [ "$GW_AGE" -gt 600 ]; then
  SESSION_AGE=$(( $(date +%s) - $(stat -c %Y "$SESSION_FILE" 2>/dev/null || echo 0) ))
  if [ "$SESSION_AGE" -lt 300 ]; then
    # Session was modified in last 5 min — check if any sendMessage happened
    TODAY=$(date -u +%Y-%m-%d)
    LAST_SEND=0
    if [ -f "$APP_LOG_DIR/openclaw-$TODAY.log" ]; then
      LAST_SEND_LINE=$(tail -1000 "$APP_LOG_DIR/openclaw-$TODAY.log" 2>/dev/null | grep "sendMessage ok" | tail -1)
      if [ -n "$LAST_SEND_LINE" ]; then
        SEND_TIME=$(echo "$LAST_SEND_LINE" | grep -oP '"time":"[^"]*"' | cut -d'"' -f4 | head -1)
        if [ -n "$SEND_TIME" ]; then
          LAST_SEND=$(date -d "$SEND_TIME" +%s 2>/dev/null || echo 0)
        fi
      fi
    fi
    SEND_AGE=$(( $(date +%s) - LAST_SEND ))
    # v67 (2026-04-29): bumped from 180s → 600s (3min → 10min). The 3-min
    # threshold was too aggressive for OpenClaw 2026.4.26's slower cold-start
    # path — legitimate Haiku 4.5 inferences on 29K-token prompts take 20-45s,
    # and the watchdog was killing the gateway mid-response, creating a 2-min
    # crash loop where every chat completion was a fresh cold start. Confirmed
    # in Lee (vm-773) and Textmaxmax (vm-729) watchdog.log showing repeated
    # "RESTART: FROZEN(session_age=89s,last_send=1666s_ago)". 10 min gives
    # comfortable headroom even on slow cold-start while still catching truly
    # hung gateways (real hangs sit forever; we just don't need to react in 3min).
    if [ "$SEND_AGE" -gt 600 ]; then
      do_restart "FROZEN(session_age=\${SESSION_AGE}s,last_send=\${SEND_AGE}s_ago)" "false"
      exit 0
    fi
  fi
fi

# ── Check 5: Dead Telegram connection ──
# If the gateway has been running 10+ min but the app log has ZERO Telegram
# sendMessage entries, the Telegram long-poll connection is dead.
# (GW_AGE computed above for both checks — see v68 note in Check 4.)
TELEGRAM_DEAD=false
if [ "$HEALTH_OK" = true ] && [ "$PROC_OK" = true ]; then
  if [ -n "$GW_START" ]; then
    if [ "$GW_AGE" -gt 600 ]; then
      # Gateway running 10+ min — check when the LAST sendMessage happened
      TODAY=$(date -u +%Y-%m-%d)
      LAST_TG_SEND=0
      if [ -f "$APP_LOG_DIR/openclaw-$TODAY.log" ]; then
        LAST_TG_LINE=$(tail -5000 "$APP_LOG_DIR/openclaw-$TODAY.log" 2>/dev/null | grep "sendMessage ok" | tail -1)
        if [ -n "$LAST_TG_LINE" ]; then
          TG_TIME=$(echo "$LAST_TG_LINE" | grep -oP '"time":"[^"]*"' | cut -d'"' -f4 | head -1)
          if [ -n "$TG_TIME" ]; then
            LAST_TG_SEND=$(date -d "$TG_TIME" +%s 2>/dev/null || echo 0)
          fi
        fi
      fi

      TG_SILENCE=$(( $(date +%s) - LAST_TG_SEND ))
      # Dead = no sendMessage in the last 10 minutes AND gateway running 10+ min
      if [ "$TG_SILENCE" -gt 600 ]; then
        TELEGRAM_DEAD=true
      fi
    fi
  fi
fi

if [ "$TELEGRAM_DEAD" = true ]; then
  do_restart "TELEGRAM_DEAD(gateway_age=\${GW_AGE}s,last_send=\${TG_SILENCE}s_ago)" "false"
  exit 0
fi

# ── All checks passed or minor failures ──
if [ "$HEALTH_OK" = true ] && [ "$PROC_OK" = true ]; then
  echo 0 > "$STATE_FILE"
  exit 0
fi

# Health or process failed
FAILURES=$((FAILURES + 1))
echo "$FAILURES" > "$STATE_FILE"

REASON=""
[ "$HEALTH_OK" = false ] && REASON="health_failed(HTTP_$HTTP_CODE)"
[ "$PROC_OK" = false ] && REASON="process_dead"

if [ "$FAILURES" -lt 2 ]; then
  log "WARNING: $REASON (failure $FAILURES/2)"
  exit 0
fi

do_restart "$REASON(failures=$FAILURES)" "false"
`,
  "dispatch-connection-info.sh": `#!/bin/bash
# dispatch-connection-info.sh — Output the relay connection command for this VM
# The agent runs this to give the user the exact npx command to connect
set -euo pipefail

# Get gateway token from env file
TOKEN=""
if [ -f "$HOME/.openclaw/.env" ]; then
  TOKEN=$(grep "^GATEWAY_TOKEN=" "$HOME/.openclaw/.env" 2>/dev/null | cut -d= -f2 | tr -d '"' | tr -d "'")
fi
if [ -z "$TOKEN" ]; then
  echo '{"error":"gateway token not found"}'
  exit 1
fi

# Get VM IP from hostname
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ -z "$IP" ]; then
  IP="unknown"
fi

# Output the command
echo "{\\"command\\":\\"npx @instaclaw/dispatch@latest --token \${TOKEN} --vm \${IP}\\",\\"token\\":\\"\${TOKEN}\\",\\"ip\\":\\"\${IP}\\",\\"port\\":8765}"
`,
  "dispatch-remote-exec.sh": `#!/bin/bash
# dispatch-remote-exec.sh — Execute a shell command on the user's computer
# Runs the command DIRECTLY via the relay — no Terminal window needed.
# Usage: dispatch-remote-exec.sh "mkdir -p ~/Desktop/Screenshots && mv ~/Desktop/Screenshot*.png ~/Desktop/Screenshots/"
set -euo pipefail

SOCKET="/tmp/dispatch.sock"
COMMAND=\${1:?Usage: dispatch-remote-exec.sh "command"}

if [ ! -S "$SOCKET" ]; then
  echo '{"error":"dispatch relay not connected","hint":"User needs to run npx @instaclaw/dispatch on their computer"}'
  exit 1
fi

# JSON-escape the command
ESCAPED=$(echo "$COMMAND" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read().rstrip()))" 2>/dev/null)

echo "{\\"type\\":\\"exec\\",\\"params\\":{\\"command\\":$ESCAPED}}" | nc -U -w 60 "$SOCKET" 2>/dev/null || echo '{"error":"dispatch server not responding"}'
`,
  "daily-digest.sh": `#!/bin/bash
# daily-digest.sh — Send a daily summary to the user via Telegram
# Called by cron at 8am user's timezone. Skips if user engaged recently.
set -euo pipefail

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" 2>/dev/null

# Opt-out check
[ -f "$HOME/.openclaw/workspace/.no-digest" ] && exit 0

# Get bot token and chat_id from openclaw config
BOT_TOKEN=$(python3 -c "
import json
d = json.load(open('$HOME/.openclaw/openclaw.json'))
print(d.get('channels',{}).get('telegram',{}).get('botToken',''))
" 2>/dev/null)

[ -z "$BOT_TOKEN" ] && exit 0

# Get chat_id from recent getUpdates or stored value
CHAT_ID=""
if [ -f "$HOME/.openclaw/workspace/.telegram_chat_id" ]; then
  CHAT_ID=$(cat "$HOME/.openclaw/workspace/.telegram_chat_id" 2>/dev/null)
fi

[ -z "$CHAT_ID" ] && exit 0

# Check if user engaged in the last 2 hours (skip digest if so)
LAST_MSG_AGE=999999
if [ -f "$HOME/.openclaw/agents/main/sessions/sessions.json" ]; then
  LAST_MOD=$(stat -c %Y "$HOME/.openclaw/agents/main/sessions/sessions.json" 2>/dev/null || echo 0)
  NOW=$(date +%s)
  LAST_MSG_AGE=$(( (NOW - LAST_MOD) / 60 ))
fi

if [ "$LAST_MSG_AGE" -lt 120 ]; then
  # User was active in the last 2 hours — skip
  exit 0
fi

# Gather metrics
DATE=$(date +"%B %d")

# Credits used today (from .env or default)
CREDITS_USED=$(grep -o '"credits_used_today":[0-9]*' "$HOME/.openclaw/openclaw.json" 2>/dev/null | grep -o '[0-9]*' || echo "0")

# Heartbeat cycle calls today
HEARTBEAT_CALLS=$(python3 -c "
import json
try:
  d = json.load(open('$HOME/.openclaw/openclaw.json'))
  print(d.get('agents',{}).get('defaults',{}).get('heartbeat',{}).get('cyclesRun', 0))
except: print(0)
" 2>/dev/null || echo "0")

# Count messages from session files (approximate)
MSG_COUNT=0
if [ -d "$HOME/.openclaw/agents/main/sessions" ]; then
  MSG_COUNT=$(find "$HOME/.openclaw/agents/main/sessions" -name "*.jsonl" -newer "$HOME/.openclaw/agents/main/sessions/sessions.json" -mtime -1 2>/dev/null | wc -l || echo "0")
  # Better: count lines in today's session logs
  MSG_COUNT=$(find "$HOME/.openclaw/agents/main/sessions" -name "*.jsonl" -mtime 0 -exec wc -l {} + 2>/dev/null | tail -1 | awk '{print int($1/2)}' || echo "0")
fi

# Memory entries count
MEMORY_ENTRIES=0
if [ -f "$HOME/.openclaw/workspace/MEMORY.md" ]; then
  MEMORY_ENTRIES=$(grep -c "^##" "$HOME/.openclaw/workspace/MEMORY.md" 2>/dev/null || echo "0")
fi

# Build the digest message
MSG="📊 *Daily Digest — \${DATE}*"$'\\n'$'\\n'

HAS_ACTIVITY=false

if [ "$MSG_COUNT" -gt 0 ]; then
  MSG="\${MSG}• Handled \${MSG_COUNT} messages"$'\\n'
  HAS_ACTIVITY=true
fi

if [ "$HEARTBEAT_CALLS" -gt 0 ]; then
  MSG="\${MSG}• Ran \${HEARTBEAT_CALLS} autonomous work cycles"$'\\n'
  HAS_ACTIVITY=true
fi

if [ "$CREDITS_USED" -gt 0 ]; then
  COST=$(echo "scale=2; $CREDITS_USED * 0.003" | bc 2>/dev/null || echo "?")
  MSG="\${MSG}• Used \${CREDITS_USED} credits (~\\$\${COST})"$'\\n'
  HAS_ACTIVITY=true
fi

if [ "$MEMORY_ENTRIES" -gt 0 ]; then
  MSG="\${MSG}• \${MEMORY_ENTRIES} things remembered"$'\\n'
  HAS_ACTIVITY=true
fi

if [ "$HAS_ACTIVITY" = false ]; then
  MSG="\${MSG}Your agent is standing by — give it a task!"$'\\n'$'\\n'
  MSG="\${MSG}Try: \\"Research the top 5 AI startups this week\\" or"$'\\n'
  MSG="\${MSG}\\"Watch DexScreener for new Base listings\\""
fi

# Send text message
curl -s -X POST "https://api.telegram.org/bot\${BOT_TOKEN}/sendMessage" \\
  -H "Content-Type: application/json" \\
  -d "{\\"chat_id\\":\\"\${CHAT_ID}\\",\\"text\\":$(echo "$MSG" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))'),\\"parse_mode\\":\\"Markdown\\",\\"disable_web_page_preview\\":true}" \\
  > /dev/null 2>&1

# Send desktop thumbnail if it exists
THUMB="$HOME/.openclaw/workspace/desktop-thumbnail.jpg"
if [ -f "$THUMB" ] && [ "$(stat -c%s "$THUMB" 2>/dev/null || echo 0)" -gt 100 ]; then
  curl -s -X POST "https://api.telegram.org/bot\${BOT_TOKEN}/sendPhoto" \\
    -F "chat_id=\${CHAT_ID}" \\
    -F "photo=@\${THUMB}" \\
    -F "caption=🖥️ Desktop right now" \\
    > /dev/null 2>&1
fi
`,
  "desktop-thumbnail-cron.sh": `#!/bin/bash
# desktop-thumbnail-cron.sh — Takes a low-res screenshot every 30s for the dashboard thumbnail
# Called by cron or strip-thinking.py. Overwrites the same file each time.
set -euo pipefail
export DISPLAY=:99
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

THUMB="$HOME/.openclaw/workspace/desktop-thumbnail.jpg"
TMP="/tmp/desktop-thumb-$$.png"
trap "rm -f '$TMP'" EXIT

# Capture screenshot
usecomputer screenshot "$TMP" --json > /dev/null 2>&1 || exit 0

# Convert to small low-quality JPEG (10-20KB)
convert "$TMP" -quality 40 -resize 400x240 "$THUMB" 2>/dev/null || exit 0
`,
  "digest-scheduler.sh": `#!/bin/bash
# digest-scheduler.sh — Runs hourly via cron. Checks if it's 8am in user's timezone.
# If yes, runs the daily digest. This avoids needing per-timezone cron entries.
set -euo pipefail

# Read user's timezone from the OpenClaw config or default to UTC
TZ_FILE="$HOME/.openclaw/workspace/.user_timezone"
USER_TZ="America/New_York"

if [ -f "$TZ_FILE" ]; then
  USER_TZ=$(cat "$TZ_FILE" 2>/dev/null)
fi

# Check if it's 8am (hour 08) in user's timezone
CURRENT_HOUR=$(TZ="$USER_TZ" date +%H 2>/dev/null || date +%H)

if [ "$CURRENT_HOUR" = "08" ]; then
  bash "$HOME/scripts/daily-digest.sh" 2>/dev/null || true
fi
`,
};

/** dispatch-server.js — the Node.js dispatch server that runs on each VM. */
export const DISPATCH_SERVER_JS = `#!/usr/bin/env node
/**
 * Dispatch Server — VM-side WebSocket server for remote computer control.
 *
 * Bridges agent commands (via Unix socket) to the user's local relay (via WebSocket).
 * The local relay executes commands via usecomputer on the user's machine and returns results.
 *
 * Architecture:
 *   Agent script → Unix socket (/tmp/dispatch.sock) → this server → WSS → local relay → usecomputer
 *
 * Auth: Bearer gateway token validated during WebSocket upgrade handshake.
 * Protocol: JSON text frames for commands, binary frames for screenshots.
 */

const { WebSocketServer, WebSocket } = require("ws");
const https = require("https");
const http = require("http");
const fs = require("fs");
const net = require("net");
const path = require("path");
const crypto = require("crypto");

// ── Config ──
const WS_PORT = parseInt(process.env.DISPATCH_PORT || "8765", 10);
const UNIX_SOCKET = process.env.DISPATCH_SOCKET || "/tmp/dispatch.sock";
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || fs.readFileSync(
  path.join(process.env.HOME, ".openclaw/.env"), "utf-8"
).match(/^GATEWAY_TOKEN=(.+)$/m)?.[1]?.trim();

if (!GATEWAY_TOKEN) {
  console.error("[dispatch-server] FATAL: No GATEWAY_TOKEN found");
  process.exit(1);
}

// ── Audit Log ──
const AUDIT_LOG = path.join(process.env.HOME, ".openclaw/workspace/dispatch-audit.log");

function auditLog(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\\n";
  fs.appendFile(AUDIT_LOG, line, () => {}); // fire-and-forget
}

// Rotate audit log on startup: keep last 1000 lines, max 1MB
try {
  if (fs.existsSync(AUDIT_LOG)) {
    const stat = fs.statSync(AUDIT_LOG);
    if (stat.size > 1024 * 1024) { // > 1MB
      const lines = fs.readFileSync(AUDIT_LOG, "utf-8").split("\\n");
      fs.writeFileSync(AUDIT_LOG, lines.slice(-1000).join("\\n") + "\\n");
      console.log(\`[dispatch-server] Rotated audit log (was \${(stat.size / 1024).toFixed(0)}KB, kept last 1000 lines)\`);
    }
  }
} catch {}

// ── Rate Limiting ──
const RATE_LIMIT_INTERVAL_MS = 100; // 10 commands per second (was 1/sec — too slow for batching)
const RATE_LIMIT_MAX_PER_SESSION = 500; // max 500 commands per relay session (was 100 — too low for complex tasks)
const RATE_LIMIT_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min idle → disconnect

let sessionCommandCount = 0;
let lastCommandTime = 0;
let idleTimer = null;

function resetRateLimits() {
  sessionCommandCount = 0;
  lastCommandTime = 0;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

function checkRateLimit() {
  const now = Date.now();

  // Max commands per session
  if (sessionCommandCount >= RATE_LIMIT_MAX_PER_SESSION) {
    return { allowed: false, error: \`Session limit exceeded (\${RATE_LIMIT_MAX_PER_SESSION} commands). Reconnect to reset.\` };
  }

  // 1 command per second
  if (lastCommandTime && (now - lastCommandTime) < RATE_LIMIT_INTERVAL_MS) {
    return { allowed: false, error: "Rate limited — max 1 command per second" };
  }

  sessionCommandCount++;
  lastCommandTime = now;
  return { allowed: true };
}

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (activeRelay && activeRelay.readyState === WebSocket.OPEN) {
      console.log("[dispatch-server] Idle timeout (5 min) — disconnecting relay");
      auditLog({ event: "idle_timeout" });
      activeRelay.close(4002, "Idle timeout");
    }
  }, RATE_LIMIT_IDLE_TIMEOUT_MS);
}

// ── TLS: Self-signed cert (TOFU) ──
const CERT_DIR = path.join(process.env.HOME, ".dispatch-server-certs");
let tlsOptions = null;

function ensureSelfSignedCert() {
  const keyPath = path.join(CERT_DIR, "key.pem");
  const certPath = path.join(CERT_DIR, "cert.pem");

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }

  // Generate self-signed cert via openssl
  fs.mkdirSync(CERT_DIR, { recursive: true });
  const { execSync } = require("child_process");
  execSync(
    \`openssl req -x509 -newkey rsa:2048 -keyout "\${keyPath}" -out "\${certPath}" \` +
    \`-days 365 -nodes -subj "/CN=dispatch-server" 2>/dev/null\`
  );
  console.log("[dispatch-server] Generated self-signed TLS certificate");
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

try {
  tlsOptions = ensureSelfSignedCert();
} catch (err) {
  console.warn("[dispatch-server] TLS cert generation failed, falling back to plain WS:", err.message);
}

// ── State ──
let activeRelay = null; // The one connected local relay WebSocket
let pendingRequests = new Map(); // id → { resolve, reject, timer }
let commandCounter = 0;

// ── HMAC Auth: nonce tracking ──
const seenNonces = new Map(); // nonce → timestamp
const HANDSHAKE_MAX_AGE_MS = 30000; // 30 seconds
const NONCE_EXPIRY_MS = 60000; // 60 seconds

// Clean up expired nonces every 30s
setInterval(() => {
  const cutoff = Date.now() - NONCE_EXPIRY_MS;
  for (const [nonce, ts] of seenNonces) {
    if (ts < cutoff) seenNonces.delete(nonce);
  }
}, 30000);

function verifyHmacHandshake(url) {
  const params = new URL(url, "http://localhost");
  const hmac = params.searchParams.get("hmac");
  const ts = params.searchParams.get("ts");
  const nonce = params.searchParams.get("nonce");

  // Also accept legacy plain token for backwards compatibility during rollout
  const plainToken = params.searchParams.get("token");
  if (plainToken === GATEWAY_TOKEN) {
    return { ok: true, legacy: true };
  }

  if (!hmac || !ts || !nonce) {
    return { ok: false, error: "Missing auth params (hmac, ts, nonce)" };
  }

  // Timestamp check
  const tsMs = parseInt(ts, 10);
  if (isNaN(tsMs) || Math.abs(Date.now() - tsMs) > HANDSHAKE_MAX_AGE_MS) {
    return { ok: false, error: "Handshake expired (timestamp > 30s old)" };
  }

  // Nonce replay check
  if (seenNonces.has(nonce)) {
    return { ok: false, error: "Nonce already used (replay attack)" };
  }

  // HMAC verification
  const expected = crypto.createHmac("sha256", GATEWAY_TOKEN)
    .update(ts + ":" + nonce)
    .digest("hex");

  if (hmac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(hmac, "hex"), Buffer.from(expected, "hex"))) {
    return { ok: false, error: "HMAC verification failed" };
  }

  // Record nonce
  seenNonces.set(nonce, Date.now());
  return { ok: true, legacy: false };
}

// ── WebSocket Server ──
const server = tlsOptions
  ? https.createServer(tlsOptions)
  : http.createServer();

const wss = new WebSocketServer({
  server,
  verifyClient: (info, cb) => {
    const result = verifyHmacHandshake(info.req.url);

    if (result.ok) {
      if (result.legacy) {
        console.log("[dispatch-server] Connection accepted (legacy token auth — upgrade client)");
      }
      cb(true);
    } else {
      console.warn(\`[dispatch-server] Rejected connection: \${result.error}\`);
      auditLog({ event: "auth_rejected", error: result.error });
      cb(false, 401, "Unauthorized");
    }
  },
});

wss.on("connection", (ws, req) => {
  // Only allow 1 concurrent relay connection
  if (activeRelay && activeRelay.readyState === WebSocket.OPEN) {
    console.warn("[dispatch-server] Rejected second relay connection (only 1 allowed)");
    ws.close(4001, "Another relay is already connected");
    return;
  }

  activeRelay = ws;
  const clientIP = req.socket.remoteAddress;
  console.log(\`[dispatch-server] Relay connected from \${clientIP}\`);
  auditLog({ event: "relay_connected", ip: clientIP });
  resetRateLimits();
  resetIdleTimer();

  // Enable TCP keepalive to prevent NAT/firewall from killing idle connections
  const rawSocket = req.socket;
  if (rawSocket.setKeepAlive) {
    rawSocket.setKeepAlive(true, 30000); // Send TCP keepalive every 30s
    console.log("[dispatch-server] TCP keepalive enabled (30s interval)");
  }

  // Heartbeat
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; missedPongs.set(ws, 0); });

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      // Binary frame = screenshot data, find the pending request waiting for binary
      for (const [id, req] of pendingRequests) {
        if (req.awaitingBinary) {
          req.binaryData = data;
          finishRequest(id);
          return;
        }
      }
      return;
    }

    // Text frame = JSON response
    try {
      const msg = JSON.parse(data.toString());
      const id = msg.id;

      if (!id || !pendingRequests.has(id)) {
        console.warn("[dispatch-server] Unknown response id:", id);
        return;
      }

      if (msg.type === "screenshot_result") {
        // Next binary frame will contain the image data
        pendingRequests.get(id).metadata = msg;
        pendingRequests.get(id).awaitingBinary = true;
      } else {
        // Action result — resolve immediately
        pendingRequests.get(id).result = msg;
        finishRequest(id);
      }
    } catch (err) {
      console.warn("[dispatch-server] Failed to parse relay message:", err.message);
    }
  });

  ws.on("close", () => {
    console.log("[dispatch-server] Relay disconnected");
    auditLog({ event: "relay_disconnected", commandsThisSession: sessionCommandCount });
    if (activeRelay === ws) activeRelay = null;
    resetRateLimits();
    // Reject all pending requests
    for (const [id, req] of pendingRequests) {
      req.reject(new Error("Relay disconnected"));
    }
    pendingRequests.clear();
  });

  ws.on("error", (err) => {
    console.error("[dispatch-server] Relay error:", err.message);
  });
});

function finishRequest(id) {
  const req = pendingRequests.get(id);
  if (!req) return;
  clearTimeout(req.timer);
  pendingRequests.delete(id);

  if (req.binaryData) {
    // Screenshot response: combine metadata + binary
    const meta = req.metadata || {};
    req.resolve({
      ...meta,
      image_base64: req.binaryData.toString("base64"),
    });
  } else {
    req.resolve(req.result);
  }
}

// ── Screenshot Queue (prevent concurrent screenshot race condition) ──
let screenshotInFlight = false;
let screenshotQueue = [];

function sendToRelayQueued(command, timeoutMs = 30000) {
  if (command.type === "screenshot" && screenshotInFlight) {
    // Queue the screenshot request
    return new Promise((resolve, reject) => {
      screenshotQueue.push({ command, timeoutMs, resolve, reject });
    });
  }
  if (command.type === "screenshot") {
    screenshotInFlight = true;
  }
  return sendToRelay(command, timeoutMs).finally(() => {
    if (command.type === "screenshot") {
      screenshotInFlight = false;
      // Process next queued screenshot if any
      if (screenshotQueue.length > 0) {
        const next = screenshotQueue.shift();
        sendToRelayQueued(next.command, next.timeoutMs).then(next.resolve, next.reject);
      }
    }
  });
}

// Send command to relay and wait for response
function sendToRelay(command, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!activeRelay || activeRelay.readyState !== WebSocket.OPEN) {
      reject(new Error("No relay connected"));
      return;
    }

    const id = \`cmd_\${++commandCounter}_\${Date.now()}\`;
    command.id = id;

    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error("Command timed out"));
    }, timeoutMs);

    pendingRequests.set(id, { resolve, reject, timer });
    activeRelay.send(JSON.stringify(command));
  });
}

// ── Heartbeat interval ──
// Relaxed: 45s interval, 2 missed pongs before terminating.
// The relay may block on screenshot capture (usecomputer N-API is synchronous)
// which delays pong responses. One missed pong is normal during screenshots.
let missedPongs = new Map(); // ws → count
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      const missed = (missedPongs.get(ws) || 0) + 1;
      missedPongs.set(ws, missed);
      if (missed >= 2) {
        console.log(\`[dispatch-server] Terminating stale relay (\${missed} missed pongs)\`);
        missedPongs.delete(ws);
        ws.terminate();
        return;
      }
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 45000);

wss.on("close", () => clearInterval(heartbeatInterval));

// ── Unix Socket Server (agent interface) ──
// Agent scripts connect here to send commands to the user's machine

function cleanupSocket() {
  try { fs.unlinkSync(UNIX_SOCKET); } catch {}
}
cleanupSocket();

const unixServer = net.createServer((conn) => {
  let data = "";
  let handled = false;

  async function handleCommand(raw) {
    if (handled) return;
    handled = true;

    try {
      const command = JSON.parse(raw.trim());

      // Special: status command
      if (command.type === "status") {
        const status = {
          connected: !!(activeRelay && activeRelay.readyState === WebSocket.OPEN),
          pendingCommands: pendingRequests.size,
          uptime: process.uptime(),
        };
        conn.write(JSON.stringify(status) + "\\n");
        conn.end();
        return;
      }

      // Rate limit check
      const rl = checkRateLimit();
      if (!rl.allowed) {
        console.log(\`[dispatch-server] Rate limited: \${rl.error}\`);
        auditLog({ event: "rate_limited", type: command.type });
        conn.write(JSON.stringify({ error: rl.error }) + "\\n");
        conn.end();
        return;
      }
      resetIdleTimer();

      // Forward to relay (screenshots are queued to prevent race conditions)
      console.log(\`[dispatch-server] Forwarding \${command.type} command to relay\`);
      const logParams = command.type === "type" ? { text: "***" } :
        command.type === "batch" ? { actions: (command.params?.actions || []).length } : command.params;
      auditLog({ event: "command", type: command.type, params: logParams });

      // Batch commands get a longer timeout (60s) since they execute multiple actions + screenshot
      const timeout = command.type === "batch" ? 60000 : 30000;
      const result = await sendToRelayQueued(command, timeout);
      console.log(\`[dispatch-server] Got result for \${command.type}: \${JSON.stringify(result).substring(0, 200)}\`);
      auditLog({ event: "result", type: command.type, success: !!result && !result.error });
      conn.write(JSON.stringify(result) + "\\n");
      conn.end();
    } catch (err) {
      console.log(\`[dispatch-server] Command error: \${err.message}\`);
      conn.write(JSON.stringify({ error: err.message }) + "\\n");
      conn.end();
    }
  }

  conn.on("data", (chunk) => {
    data += chunk.toString();
    // Try to parse as soon as we have a complete JSON object
    try {
      JSON.parse(data.trim());
      handleCommand(data);
    } catch {
      // Not complete yet, wait for more data
    }
  });

  // Also handle end in case data comes all at once
  conn.on("end", () => {
    if (!handled && data.trim()) {
      handleCommand(data);
    }
  });

  conn.on("error", () => {});
});

unixServer.listen(UNIX_SOCKET, () => {
  // Make socket world-writable so agent (openclaw user) can connect
  fs.chmodSync(UNIX_SOCKET, 0o777);
  console.log(\`[dispatch-server] Unix socket listening on \${UNIX_SOCKET}\`);
});

// ── Start ──
server.listen(WS_PORT, "0.0.0.0", () => {
  const proto = tlsOptions ? "wss" : "ws";
  console.log(\`[dispatch-server] \${proto}://0.0.0.0:\${WS_PORT} (auth=bearer)\`);
  console.log(\`[dispatch-server] Gateway token: \${GATEWAY_TOKEN.substring(0, 8)}...\`);
});

// ── Graceful shutdown ──
process.on("SIGTERM", () => {
  console.log("[dispatch-server] Shutting down...");
  cleanupSocket();
  wss.close();
  server.close();
  process.exit(0);
});

process.on("SIGINT", () => {
  cleanupSocket();
  process.exit(0);
});
`;

/** computer-dispatch SKILL.md — agent-facing skill documentation. */
export const DISPATCH_SKILL_MD = `---
name: computer-dispatch
description: "Control computers with mouse/keyboard — your VM desktop OR the user's personal Mac/PC via remote relay"
metadata:
  triggers:
    keywords: [dispatch, desktop, screen, click, screenshot, gui, app, window, open, visit, show, dexscreener, website, url, browse, my computer, my screen, remote]
    phrases: ["take a screenshot", "open an app", "click on", "what is on screen", "open this website", "show me this site", "go to", "visit", "pull up", "on my computer", "on my desktop", "on my screen", "control my computer"]
---

# Computer Dispatch Skill

You can control TWO computers: your own VM desktop AND the user's personal computer (when their relay is connected).

## CRITICAL RULES (read first)

**1. Use dispatch-remote-exec.sh for ALL shell commands on the user's computer.**

This executes commands DIRECTLY on the user's Mac/PC — no Terminal window needed, no GUI, no screenshots required. The command runs through the relay and returns stdout/stderr.

\`\`\`bash
bash ~/scripts/dispatch-remote-exec.sh "mkdir -p ~/Desktop/Screenshots && mv ~/Desktop/Screenshot*.png ~/Desktop/Screenshot*.jpg ~/Desktop/Screenshots/ 2>/dev/null; echo Done"
\`\`\`

That's ONE command. It runs on the USER'S machine, not your VM. Output comes back as JSON with stdout, stderr, and exitCode.

### File Operations on User's Computer (copy this pattern exactly)

**Example: "organize my screenshots into a folder"**

Step 1 — See what's on the desktop:
\`\`\`bash
bash ~/scripts/dispatch-remote-exec.sh "ls ~/Desktop/"
\`\`\`

Step 2 — Run the command:
\`\`\`bash
bash ~/scripts/dispatch-remote-exec.sh "mkdir -p ~/Desktop/Screenshots && find ~/Desktop -maxdepth 1 -name 'Screenshot*' -type f -exec mv {} ~/Desktop/Screenshots/ \\; && ls ~/Desktop/Screenshots/ | wc -l"
\`\`\`
Note: macOS screenshot filenames have spaces ("Screenshot 2026-03-27 at 1.16 PM.png"). Use \`find -exec mv\` instead of \`mv Screenshot*\` to handle spaces correctly.

Step 3 — Verify and report:
\`\`\`bash
bash ~/scripts/dispatch-remote-screenshot.sh
~/scripts/deliver_file.sh ~/.openclaw/workspace/dispatch-remote-screenshot.jpg "Done — here's your desktop now"
\`\`\`

**That's 3 steps. Under 15 seconds.** No Terminal window, no clicking, no GUI.

**Common commands via dispatch-remote-exec.sh:**
- Create folder: \`dispatch-remote-exec.sh "mkdir -p ~/Desktop/NewFolder"\`
- Move files (with spaces in names): \`dispatch-remote-exec.sh "find ~/Desktop -maxdepth 1 -name '*.png' -type f -exec mv {} ~/Desktop/Screenshots/ \\;"\`
- List files: \`dispatch-remote-exec.sh "ls -la ~/Desktop/"\`
- Delete files: \`dispatch-remote-exec.sh "rm ~/Desktop/old-file.txt"\` (ask user first!)
- Rename: \`dispatch-remote-exec.sh "mv ~/Desktop/old.txt ~/Desktop/new.txt"\`
- Find files: \`dispatch-remote-exec.sh "find ~/Desktop -name '*.png' -type f"\`
- Open app: \`dispatch-remote-exec.sh "open -a 'Google Chrome'"\` (macOS)
- Get system info: \`dispatch-remote-exec.sh "sw_vers; uname -a"\`

**NEVER type commands into the user's Terminal via dispatch-remote-type.sh for file operations.** The relay's Terminal window captures focus and your commands end up in the wrong window. Always use dispatch-remote-exec.sh instead.

**When to use GUI (screenshot/click/type) vs exec:**
- **Use exec:** File operations, running commands, installing software, opening apps, any shell task
- **Use GUI (screenshot + click):** Interacting with app UIs (clicking buttons, filling forms, navigating websites)

**After EVERY exec command, verify the result before telling the user it's done.** Either check the command output (exitCode 0 + expected stdout) or take a screenshot. NEVER claim success without proof.

**If the user attached a screenshot of their desktop, DO NOT take another dispatch-remote-screenshot.sh.** Use the image they sent — it shows the same thing. Taking redundant screenshots wastes context tokens.

**If the user needs to reconnect the relay:** Run \`bash ~/scripts/dispatch-connection-info.sh\` to get the exact npx command with the real token and IP. Give this to the user — never use placeholder values like YOUR_TOKEN_HERE.

**2. Save task state every 5 actions.** During multi-step dispatch tasks, write your progress to \`~/.openclaw/workspace/ACTIVE_TASK.md\` every 5 actions so you can resume after context resets. Format:
\`\`\`
## Active Task
Request: [what the user asked]
Status: IN_PROGRESS
Completed: [what's done]
Next: [exact next step]
Updated: [timestamp]
\`\`\`

**3. Batch over single actions.** Use \`dispatch-remote-batch.sh\` to combine multiple actions into one round-trip. See Batch Command section below.

**4. Context budget limit.** Remote dispatch tasks must complete in **10 messages or fewer**. If you're past 10 messages without completing the task, STOP immediately and:
- Tell the user what went wrong
- Give them the exact shell command to run manually
- Do NOT try another approach — you're burning context

Max 10 screenshots per task. If you've taken more than 5 screenshots and the task isn't done, you're using GUI when you should be using shell commands. Switch to Terminal immediately.

**5. If the first approach fails, go to shell commands.** Do NOT try 3 different GUI approaches. If clicking doesn't work on the first try, open Terminal and type a shell command instead. No "let me try another approach" — go straight to the shell fallback.

## Two Modes

### Mode 1: Local Dispatch (Your VM Desktop)
Your VM has a virtual desktop (Xvfb at DISPLAY=:99, 1280x720, Openbox WM). Use this for:
- Opening websites with stealth Chrome (\`dispatch-browser.sh\`)
- Running GUI applications autonomously
- Tasks that don't need the user's computer

**Scripts:** \`dispatch-screenshot.sh\`, \`dispatch-click.sh\`, \`dispatch-type.sh\`, \`dispatch-press.sh\`, \`dispatch-scroll.sh\`, \`dispatch-browser.sh\`

### Mode 2: Remote Dispatch (User's Personal Computer)
When the user runs \`instaclaw-dispatch\` on their Mac/PC, you can control their actual computer. Use this for:
- User asks "do this on MY computer"
- Tasks that require the user's installed apps (Figma, Excel, Slack, etc.)
- Interacting with the user's logged-in sessions

**Scripts:** \`dispatch-remote-screenshot.sh\`, \`dispatch-remote-click.sh\`, \`dispatch-remote-type.sh\`, \`dispatch-remote-press.sh\`, \`dispatch-remote-scroll.sh\`

## Which Mode to Use

| User says... | Mode | Why |
|---|---|---|
| "open dexscreener" / "show me this site" | **Local** (dispatch-browser.sh) | You browse on your VM |
| "do this on my computer" / "on my screen" | **Remote** (dispatch-remote-*) | User's machine |
| "open Figma and edit the logo" | **Remote** | Figma is on user's Mac |
| "take a screenshot of your desktop" | **Local** (dispatch-screenshot.sh) | Your VM screen |
| "take a screenshot of my screen" | **Remote** (dispatch-remote-screenshot.sh) | User's screen |
| "click on this button" (in VM browser) | **Local** (dispatch-click.sh) | Your VM |
| Regular web browsing/scraping | **Local** browser tool or dispatch-browser.sh | No need for user's machine |

**Default: Use Local dispatch unless the user explicitly asks you to act on THEIR computer.**

## Checking Remote Relay Status

Before using remote dispatch, check if the user's relay is connected:
\`\`\`bash
bash ~/scripts/dispatch-remote-status.sh
\`\`\`
Returns \`{"connected":true}\` or \`{"connected":false}\`. If not connected, tell the user:
"To let me control your computer, run \`npx @instaclaw/dispatch\` in your terminal."

---

## Local Dispatch Commands (Your VM)

### Open a Website (Stealth Chrome)
\`\`\`bash
bash ~/scripts/dispatch-browser.sh "https://example.com"
sleep 5
bash ~/scripts/dispatch-screenshot.sh
~/scripts/deliver_file.sh ~/.openclaw/workspace/dispatch-screenshot.jpg "Screenshot"
\`\`\`
Has anti-Cloudflare stealth. Use for ANY website visit.

### Screenshot Your Desktop
\`\`\`bash
bash ~/scripts/dispatch-screenshot.sh
\`\`\`
Returns JSON with \`path\`, \`coordMap\`, \`image_base64\`. Send to user via \`deliver_file.sh\`.

### Click / Type / Press / Scroll
\`\`\`bash
bash ~/scripts/dispatch-click.sh <x> <y>
bash ~/scripts/dispatch-type.sh "text"
bash ~/scripts/dispatch-press.sh "Return"
bash ~/scripts/dispatch-scroll.sh down 3
\`\`\`

### Launch GUI Apps
\`\`\`bash
DISPLAY=:99 xterm &
\`\`\`

---

## Remote Dispatch Commands (User's Computer)

### Screenshot User's Screen
\`\`\`bash
bash ~/scripts/dispatch-remote-screenshot.sh
\`\`\`
Captures the user's actual screen. Returns JSON with \`path\` (saved to workspace) and \`coordMap\`. Send to user via \`deliver_file.sh\`.

### Click on User's Screen
\`\`\`bash
bash ~/scripts/dispatch-remote-click.sh <x> <y>
\`\`\`

### Type on User's Keyboard
\`\`\`bash
bash ~/scripts/dispatch-remote-type.sh "text"
\`\`\`

### Press Key on User's Machine
\`\`\`bash
bash ~/scripts/dispatch-remote-press.sh "Return"
\`\`\`

### Scroll on User's Machine
\`\`\`bash
bash ~/scripts/dispatch-remote-scroll.sh down 3
\`\`\`

### Drag on User's Screen
\`\`\`bash
bash ~/scripts/dispatch-remote-drag.sh <fromX> <fromY> <toX> <toY>
\`\`\`

### List Windows on User's Machine
\`\`\`bash
bash ~/scripts/dispatch-remote-windows.sh
\`\`\`

---

## The Screenshot → Reason → Act Loop

Use **batch commands** to execute multiple actions per reasoning cycle. This is 2-3x faster than single actions.

### Fast Loop (preferred — use batch):
1. **Screenshot** — see what's on screen
2. **Plan multiple actions** — identify the next 2-5 steps you can take without needing to re-check the screen
3. **Batch execute** — run all planned actions in one call (includes auto-screenshot after)
4. **Analyze result** — check the post-batch screenshot
5. **Repeat** until done

### Batch Command (Remote):
\`\`\`bash
bash ~/scripts/dispatch-remote-batch.sh '{"actions":[{"type":"click","params":{"x":400,"y":300},"waitAfterMs":100},{"type":"type","params":{"text":"hello world"},"waitAfterMs":0},{"type":"press","params":{"key":"Return"},"waitAfterMs":1500}]}'
\`\`\`

Returns JSON with both action results AND a screenshot (auto-captured after the batch). The screenshot is saved to \`~/.openclaw/workspace/dispatch-remote-screenshot.jpg\`.

### Batch Options:
- \`screenshotAfter\`: true (default) — auto-screenshot after batch
- \`screenshotFormat\`: "webp" (default) — smaller than JPEG
- \`screenshotQuality\`: 55 (default) — good enough for GUI analysis
- \`settleMs\`: 300 (default) — wait for screen to settle before screenshot
- \`waitAfterMs\` per action: milliseconds to wait after each action (default 50ms)

### Wait Time Guide (for waitAfterMs):
| Action | waitAfterMs | Why |
|--------|------------|-----|
| Click on UI element | 100 | OS redraws instantly |
| Type text | 0 | Characters appear immediately |
| Press Enter on form/search | 1500-3000 | Page navigation or API call |
| Click link / navigate | 2000-3000 | Page load |
| Scroll | 200 | Smooth scroll animation |
| Click dropdown/menu | 300 | Animation |

### When to Batch vs Single Action:
- **Batch**: Click + type + Enter (search flow), fill multiple form fields, navigate menus
- **Single**: When you're unsure what's on screen, first action on a new page, after an error

### Fallback: Single Actions
If you need precise control or are unsure of the screen state, use individual commands:

Max 50 actions per task. Max 20 actions per batch.

## Verification Decision Tree — When to Screenshot

Not every action needs a verification screenshot. Use this decision tree:

### ALWAYS screenshot after:
- Page navigation (clicked a link, submitted a form, pressed Enter in address bar)
- First action on a new screen or app
- Switching windows or tabs
- After a batch that includes navigation
- After any action that produced an error
- When you're unsure what's on screen

### SKIP verification screenshot when:
- You just typed text into a field you already confirmed exists
- You pressed a single key (Tab, Escape) in a known context
- You scrolled in a page you've already screenshotted
- You're mid-batch — the batch auto-screenshots at the end
- You clicked a button and the next step is to type in the resulting dialog (batch these together)

### Rule of Thumb:
**If you can predict what the screen looks like after the action, skip the screenshot.**
A search flow (click search bar → type query → press Enter) needs ONE screenshot at the end, not three.

### Cost Awareness:
Each screenshot costs ~1,049 vision tokens (~$0.003). A 20-step task with screenshots after every action: ~$0.12. With smart verification: ~$0.04-0.06. Prefer batching to cut costs by 50-70%.

---

## User Takeover Detection

Before executing any dispatch command, check if the user has taken control:
\`\`\`bash
[ -f ~/.openclaw/workspace/.user-takeover ] && echo "USER_IN_CONTROL" || echo "OK"
\`\`\`
If \`.user-takeover\` exists, **STOP all dispatch actions immediately**. The user is controlling the desktop via live view. Wait and check again in 10 seconds. When the file is removed, resume your work.

**Never fight the user for control.** If the takeover file exists, do not click, type, press, scroll, or take screenshots.

## Rate Limits

- **Max 10 commands per second** — the dispatch server enforces this. Batch commands count as 1 command.
- **Max 60 screenshots per minute** — each screenshot costs ~$0.003 in vision tokens.
- **Max 500 commands per relay session** — after 500 commands, the relay disconnects. Tell the user to reconnect if more work is needed.
- **Max 20 actions per batch** — individual batch actions are not rate-limited internally.
- **30-minute idle timeout** — if no commands for 30 minutes, the relay auto-disconnects.

**If a dispatch command returns an error containing "rate limit":** Tell the user: "I'm being rate limited on dispatch commands. I'll wait 30 seconds and try again." Then wait 30 seconds before retrying.

**Before EVERY remote dispatch command:** Check relay status first:
\`\`\`bash
bash ~/scripts/dispatch-remote-status.sh
\`\`\`
If \`connected: false\`, tell the user: "Your dispatch relay isn't connected. Run \`npx @instaclaw/dispatch\` in your terminal to connect."

## Sending Screenshots to Users (BOTH modes)

After taking a screenshot (local OR remote), ALWAYS send it to the user:
\`\`\`bash
# Local screenshot:
bash ~/scripts/dispatch-screenshot.sh
~/scripts/deliver_file.sh ~/.openclaw/workspace/dispatch-screenshot.jpg "Desktop screenshot"

# Remote screenshot:
bash ~/scripts/dispatch-remote-screenshot.sh
~/scripts/deliver_file.sh ~/.openclaw/workspace/dispatch-remote-screenshot.jpg "Your Mac screenshot"
\`\`\`

## Token Cost Budget

Each dispatch screenshot costs ~1,049 vision tokens (~$0.003 at Sonnet pricing). A 20-step task costs ~$0.06-0.30. Be efficient:
- Don't take unnecessary screenshots — only when you need to see the screen
- Use the browser tool for data extraction (cheaper than vision-based dispatch)
- If a task needs >30 screenshots, warn the user about the cost

## Safety Rules

1. **Never click blindly** — screenshot first
2. **Never type passwords** — ask the user to type credentials themselves
3. **Never delete files** without user confirmation
4. **Never interact with banking/financial apps** unless user explicitly requested
5. **Remote mode**: the user sees every action in their terminal (supervised mode). Be descriptive about what you're doing.
6. **If something looks wrong**, stop and describe what you see
7. **NEVER restart, kill, or modify dispatch-server** — this is infrastructure managed by the system, not by you. Restarting it destroys the user's relay connection. If dispatch commands fail, tell the user the error. Do NOT try to fix the server, check ports, debug sockets, or restart processes.

## Error Handling

| Error | Fix |
|-------|-----|
| "dispatch relay not connected" | User needs to run \`npx @instaclaw/dispatch\` |
| Screenshot fails (local) | Check Xvfb: \`ps aux \\| grep Xvfb\` |
| Screenshot fails (remote) | User may need to grant Screen Recording permission |
| Click doesn't work | Verify coordinates from latest screenshot |
| dispatch-browser.sh won't launch | Check RAM: \`free -m\` (needs 500MB+ available) |
`;
