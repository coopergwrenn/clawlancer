#!/bin/bash
# dispatch-browser.sh <url> — Launch stealth Chrome on the virtual desktop
set -euo pipefail
export DISPLAY=:99

URL="${1:?Usage: dispatch-browser.sh <url>}"

# RAM safety check — dispatch Chrome needs ~700-1100MB
AVAIL_MB=$(free -m | awk '/Mem:/ {print $7}')
if [ "$AVAIL_MB" -lt 500 ]; then
  echo "{\"error\":\"insufficient RAM\",\"available_mb\":${AVAIL_MB},\"required_mb\":500,\"hint\":\"Use the headless browser tool instead — not enough RAM for dispatch Chrome\"}"
  exit 1
fi

CHROME="/home/openclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome"
PROFILE_DIR="/home/openclaw/.dispatch-chrome-profile"
STEALTH_EXT="$PROFILE_DIR/stealth-ext"
PIDFILE="/tmp/dispatch-chrome.pid"

# Check if dispatch Chrome is already running
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  curl -s "http://localhost:19222/json/new?${URL}" > /dev/null 2>&1 && {
    sleep 3
    echo "{\"success\":true,\"action\":\"new_tab\",\"url\":\"${URL}\"}"
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

nohup "$CHROME" \
  --no-sandbox \
  --disable-gpu \
  --disable-software-rasterizer \
  --disable-dev-shm-usage \
  --disable-background-networking \
  --disable-default-apps \
  --disable-sync \
  --disable-translate \
  --no-first-run \
  --no-default-browser-check \
  --disable-session-crashed-bubble \
  --hide-crash-restore-bubble \
  --disable-blink-features=AutomationControlled \
  --user-agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" \
  --lang=en-US \
  --load-extension="$STEALTH_EXT" \
  --user-data-dir="$PROFILE_DIR" \
  --remote-debugging-port=19222 \
  --window-size=1280,700 \
  --window-position=0,0 \
  "$URL" \
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
  echo "{\"success\":true,\"action\":\"launched\",\"url\":\"${URL}\",\"pid\":${CHROME_PID},\"total_rss_mb\":${TOTAL_RSS:-0},\"stealth\":true}"
else
  LOG=$(tail -3 /tmp/dispatch-chrome.log 2>/dev/null | tr '"' "'" | tr '\n' ' ')
  echo "{\"error\":\"chrome failed to start\",\"log\":\"${LOG}\"}"
  exit 1
fi
