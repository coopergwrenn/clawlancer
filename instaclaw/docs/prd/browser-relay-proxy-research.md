# Browser Relay + Residential Proxy — Final Research Report

**Date:** 2026-03-13
**Author:** Claude (research for Cooper)
**Purpose:** PRD input for two features: (1) residential proxy integration, (2) Chrome extension relay

---

## 1. How the OpenClaw Extension Relay Works (Source Code Analysis)

### Architecture (3 components)

```
User's Chrome Browser                    VM (Linode)
┌─────────────────────┐          ┌──────────────────────────────┐
│  Chrome Extension    │◄──WS──► │  Extension Relay Server      │
│  (background.js)     │         │  (extension-relay.ts)         │
│  chrome.debugger API │         │  Port: gateway+3 (def 18792) │
│                      │         │         │                     │
│  - Attaches to tabs  │         │         ▼                     │
│  - Forwards CDP cmds │         │  Browser Control Service      │
│  - Sends CDP events  │         │  Port: gateway+2 (def 18791) │
│                      │         │         │                     │
│                      │         │         ▼                     │
│                      │         │  OpenClaw Gateway             │
│                      │         │  (receives agent tool calls)  │
└─────────────────────┘          └──────────────────────────────┘
```

### What background.js Does

The production extension (chengyixu fork = closest to official) uses `chrome.debugger` API (real CDP, not scripting injection):

1. **On startup:** Loads gateway token from `chrome.storage.local`, derives HMAC relay token, opens WebSocket to `ws://127.0.0.1:{port}/extension?token={hmac}`
2. **Auto-attaches ALL open tabs** via `chrome.debugger.attach(tabId, "1.3")` + `Page.enable`
3. **Receives CDP commands** from relay: `{ id, method: "forwardCDPCommand", params: { method, params, sessionId } }`
4. **Maps sessionId → tabId**, calls `chrome.debugger.sendCommand({tabId}, method, params)`
5. **Forwards CDP events** back: `{ method: "forwardCDPEvent", params: { method, params, sessionId } }`
6. **Handles special cases** locally: `Target.createTarget` → `chrome.tabs.create()`, `Target.closeTarget` → `chrome.tabs.remove()`, `Runtime.enable` → disable-first pattern to avoid stale state

### WebSocket Protocol

```
Extension → Relay:
  { method: "forwardCDPEvent", params: { method, params, sessionId } }  // CDP events
  { id: N, result: {...} }                                               // command responses
  { method: "pong" }                                                     // keepalive

Relay → Extension:
  { id: N, method: "forwardCDPCommand", params: { method, params, sessionId } }  // CDP commands
  { method: "ping" }                                                              // keepalive (5s)
```

### Authentication: HMAC-SHA256

The relay token is NOT the gateway token directly:
```javascript
// background-utils.js
async function deriveRelayToken(gatewayToken, port) {
  const key = await crypto.subtle.importKey('raw', encode(gatewayToken), {name:'HMAC', hash:'SHA-256'}, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, encode(`openclaw-extension-relay-v1:${port}`))
  return hexEncode(sig)
}
// Result: ws://127.0.0.1:18792/extension?token=<hex-hmac-sha256>
```

The same token scheme is used for HTTP endpoints (`/json/version`, `/json/list`, etc.) via `x-openclaw-relay-token` header.

### Gateway Handshake

After WebSocket connects, relay sends `connect.challenge`. Extension responds:
```json
{
  "method": "connect",
  "params": {
    "minProtocol": 3, "maxProtocol": 3,
    "client": { "id": "chrome-relay-extension", "version": "1.0.0" },
    "role": "operator",
    "scopes": ["operator.read", "operator.write"],
    "auth": { "token": "<gatewayToken>" }
  }
}
```

### MV3 Resilience

- **State persistence:** Attached tabs saved to `chrome.storage.session`, restored on service worker restart
- **Navigation re-attach:** Retry loop at [200, 500, 1000, 2000, 4000]ms after debugger detaches during page nav
- **Keepalive alarm:** Every 30s via `chrome.alarms`, checks relay health, triggers reconnect
- **Reconnect backoff:** `min(1000 * 2^attempt, 30000) + random(0..1000)` ms
- **Relay grace period:** 20s before closing CDP clients after extension disconnect

### Relay Server Endpoints (extension-relay.ts)

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/` | HEAD/GET | No | Health check |
| `/extension/status` | GET | No | `{ connected: boolean }` |
| `/json/version` | GET | Yes | CDP version info |
| `/json` or `/json/list` | GET | Yes | Connected targets list |
| `/json/activate/<id>` | GET | Yes | Activate a target |
| `/json/close/<id>` | GET | Yes | Close a target |
| `/extension` | WS | Yes | Extension connects here |
| `/cdp` | WS | Yes | Playwright/CDP clients connect here |

### Three Forks Compared

| Feature | nocodebrain | chengyixu (production) | yoyo123-lang |
|---------|-------------|------------------------|--------------|
| CDP via `chrome.debugger` | No (uses `chrome.scripting`) | Yes | Yes |
| Auto-attach all tabs | No (manual per-tab) | Yes | No (active tab only) |
| HMAC auth | No | Yes | No |
| Gateway handshake | Simple `relay.handshake` | Full challenge/response | None |
| MV3 state persistence | No | Yes | No |
| Navigation re-attach | No | Yes (5 retries) | No |
| Reconnect on drop | Fixed 3s | Exponential backoff | None (manual) |

**The chengyixu fork is the production version.** It's the one to fork.

---

## 2. Forking the Extension for Remote VM Access

### The Problem

The relay is **loopback-only** by design:
- Extension connects to `ws://127.0.0.1:18792/extension`
- Relay server binds to `127.0.0.1`
- WebSocket upgrade rejected if remote IP is not loopback
- Origin check: only `chrome-extension://` origins allowed

This works when both Chrome and the gateway run on the same machine. Our VMs are on Linode — the user's Chrome is on their laptop.

### What Needs to Change

**Option A: Tunnel approach (no code changes to relay)**
- Use Caddy reverse proxy (already on every VM) to expose the relay port over HTTPS
- Add a route: `wss://vm-uuid.vm.instaclaw.io/relay/extension` → `ws://127.0.0.1:18792/extension`
- Extension settings change: point at `wss://vm-uuid.vm.instaclaw.io/relay/extension?token={hmac}` instead of `ws://127.0.0.1:18792/extension?token={hmac}`
- **Caddy handles TLS** — the WebSocket is encrypted in transit
- Relay server doesn't need changes — Caddy connects from loopback

**Option B: Modify relay bind + add TLS**
- Set `browser.relayBindHost: "0.0.0.0"` in openclaw.json (WSL2 flag already exists)
- Add firewall rules to only allow the user's IP
- This is more fragile and exposes the relay directly

**Recommendation: Option A (Caddy tunnel).** Zero relay code changes. Caddy is already deployed. Just add a route.

### Changes Required in the Extension

1. **Options page:** Replace "Relay Port" field with "Gateway URL" field (e.g., `https://1eac973f-xxxx.vm.instaclaw.io`)
2. **WebSocket URL builder:** Change from `ws://127.0.0.1:{port}/extension?token={hmac}` to `wss://{gatewayUrl}/relay/extension?token={hmac}`
3. **HMAC derivation:** Keep the same algorithm but the port in the message changes (or use the gateway URL as the message instead of port)
4. **Health check:** Change from `http://127.0.0.1:{port}/` to `https://{gatewayUrl}/relay/`
5. **Manifest host_permissions:** Add `https://*.vm.instaclaw.io/*`
6. **Branding:** Rename to "InstaClaw Browser Relay", update icons

### Caddy Config Addition (per VM)

```caddyfile
# In the existing Caddyfile for {uuid}.vm.instaclaw.io
handle /relay/* {
    uri strip_prefix /relay
    reverse_proxy 127.0.0.1:18792
}
```

### Security Considerations

- **TLS in transit:** Caddy handles HTTPS/WSS — no plaintext over internet
- **HMAC auth:** Extension still derives relay token from gateway token — unauthorized clients can't connect
- **Gateway handshake:** Still validates `auth.token` in the connect flow
- **Rate limiting:** Consider adding Caddy rate limits on the `/relay/` path
- **CORS:** Extension origin (`chrome-extension://`) is allowed by relay; Caddy passes it through

---

## 3. Residential Proxy Integration

### Confirmation: It IS That Simple

Adding proxy support to our headless Chrome is literally one Chrome launch flag:

```bash
chromium-browser --proxy-server=http://proxy-host:port
```

For authenticated proxies, add page-level auth:
```javascript
await page.authenticate({ username: 'user', password: 'pass' });
```

Our VMs launch Chrome via the OpenClaw config at `browser.executablePath` with flags including `--no-sandbox`, `--headless`. Adding `--proxy-server` is a one-line config change.

### Where to Add It

In `instaclaw/lib/ssh.ts`, the `buildOpenClawConfig()` function (line ~1552) builds `browser` config:
```typescript
browser: {
  executablePath: "/home/openclaw/.cache/ms-playwright/chromium-.../chrome",
  headless: true,
  noSandbox: true,
  cdpPort: 18800,
  // ADD: proxyServer: "http://proxy-host:port"
}
```

OpenClaw's browser config supports custom launch args. Add to the config object or pass via `--proxy-server` in the launch args.

### Leak Prevention Required

Proxy alone is not enough. Without these, the site sees the real datacenter IP:

1. **WebRTC leak:** Add `--disable-webrtc` or `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`
2. **DNS leak:** Add `--proxy-bypass-list=""` (empty = all DNS goes through proxy)
3. **Canvas/WebGL fingerprinting:** Already partially handled by Crawlee's stealth plugin

### Provider Comparison (Updated)

| Provider | $/GB Residential | Min Commitment | Bandwidth Pool | API Quality | Notes |
|----------|-----------------|----------------|----------------|-------------|-------|
| **Bright Data** | $8.40/GB | $500/mo | Shared or dedicated | Best | Largest network (72M IPs), best geo-targeting |
| **Oxylabs** | $8.00/GB | $300/mo | Shared | Excellent | 100M IPs, good for e-commerce |
| **Smartproxy** | $7.00/GB | $75/mo | Shared | Good | Best value at lower tiers |
| **IPRoyal** | $5.50/GB | Pay-as-you-go | Shared | OK | Cheapest, smaller pool |
| **NetNut** | $6.00/GB | $300/mo | Shared or ISP | Good | ISP proxies (static residential) |
| **SOAX** | $6.99/GB | $99/mo | Shared | Good | Flexible geo-targeting |
| **Infatica** | $8.00/GB | $96/mo | Shared | OK | Mobile proxies available |

### Integration Architecture

```
User sends message → Agent decides to browse → OpenClaw launches Chrome
                                                     │
                                        ┌────────────┴───────────────┐
                                        │                            │
                                 No proxy needed            Proxy needed
                                 (Google, YouTube,          (Instagram, LinkedIn,
                                  general sites)             Reddit, etc.)
                                        │                            │
                                        ▼                            ▼
                                 Direct connection          --proxy-server=residential
                                 (datacenter IP)            (residential IP)
```

Decision logic: maintain a blocklist of domains that require residential proxy. When the browser tool targets one of these domains, launch Chrome with proxy flags.

---

## 4. Blocked Sites Audit (Live Test Results)

**Tested from:** instaclaw-vm-063 (45.33.63.105, Linode datacenter IP)
**Method:** curl with Chrome 120 User-Agent headers, following redirects, brotli/gzip decompression

| Site | HTTP Status | Body Size | Verdict | Notes |
|------|-------------|-----------|---------|-------|
| **Instagram** | 200 | 123 KB | SHELL ONLY | Returns app shell HTML, no profile content (login-gated SPA) |
| **Twitter/X** | 200 | 54 KB | PARTIAL | Returns SSR HTML with some content, but JS-gated features |
| **LinkedIn** | 999 | Small | BLOCKED | Custom 999 code = LinkedIn's anti-bot block. JS fingerprint page |
| **Reddit** | 403 | — | BLOCKED | Explicit 403 from datacenter IP |
| **Facebook** | 200 | 190 KB | SHELL ONLY | App shell returned, actual content requires login/JS |
| **TikTok** | 200 | 75 KB | ACCESSIBLE | Full HTML page returned |
| **Amazon** | 202 | 2 KB | CAPTCHA | Bot-check page, not real content |
| **Google Search** | 200 | 43 KB | ACCESSIBLE | Real search results HTML |
| **YouTube** | 200 | 74 KB | ACCESSIBLE | Full page HTML |
| **Zillow** | 403 | — | BLOCKED | PerimeterX (`px-captcha`) bot detection |
| **Indeed** | 403 | — | BLOCKED | "Security Check" page |

### Summary by Category

**Accessible from datacenter IP (no proxy needed):**
- Google Search, YouTube, TikTok, general websites

**Returns HTML shell but content requires JS/login (proxy helps marginally):**
- Instagram, Facebook, Twitter/X

**Hard-blocked by anti-bot (proxy required):**
- LinkedIn (999), Reddit (403), Zillow (403/PerimeterX), Indeed (403), Amazon (CAPTCHA)

### Impact Assessment

With residential proxy, we unlock:
- **Reddit** — currently 403, would work with residential IP
- **LinkedIn** — 999 block, residential + stealth headers would work for public profiles
- **Amazon** — CAPTCHA bypass with residential IP
- **Zillow, Indeed** — PerimeterX blocks datacenter IPs specifically
- **Instagram, Facebook** — still login-gated even with residential IP; proxy alone won't unlock private content

**The Chrome extension relay is the real unlock for Instagram/Facebook** — it uses the user's actual logged-in browser session, bypassing both IP blocks and login walls.

---

## 5. Cost Modeling (55 VMs)

### Usage Estimates

Not all VMs will use proxy simultaneously. Estimate based on usage patterns:

| Scenario | Active VMs/day | Proxy requests/VM/day | Avg page size | Daily bandwidth | Monthly bandwidth |
|----------|---------------|----------------------|---------------|-----------------|-------------------|
| Light | 20 | 10 pages | 2 MB | 400 MB | 12 GB |
| Medium | 35 | 25 pages | 2 MB | 1.75 GB | 52.5 GB |
| Heavy | 55 | 50 pages | 2 MB | 5.5 GB | 165 GB |

### Monthly Cost by Provider

| Provider | Light (12 GB) | Medium (52.5 GB) | Heavy (165 GB) |
|----------|---------------|-------------------|----------------|
| **Smartproxy** | $84/mo | $368/mo | $1,155/mo |
| **IPRoyal** | $66/mo | $289/mo | $908/mo |
| **SOAX** | $99/mo (min) | $367/mo | $1,153/mo |
| **Bright Data** | $500/mo (min) | $500/mo (min) | $1,386/mo |
| **Oxylabs** | $300/mo (min) | $420/mo | $1,320/mo |

### Recommendation

**Start with Smartproxy ($75/mo plan, 10 GB included)** or **IPRoyal (pay-as-you-go)**:
- No minimum commitment with IPRoyal
- Smartproxy has better reliability at $7/GB
- Scale up based on actual usage data
- Neither requires annual contracts

### Per-User Cost Pass-Through

At medium usage (25 proxy pages/day per active user):
- ~1.5 GB/user/month = **$10.50/user/month** at Smartproxy rates
- Could be included in Pro tier or charged as add-on
- Or: only enable proxy for blocked domains (reduces bandwidth 60-80%)

### Smart Proxy Routing (Cost Optimization)

Only route through proxy when needed:
```
PROXY_DOMAINS = [
  "linkedin.com", "reddit.com", "zillow.com", "indeed.com",
  "amazon.com", "glassdoor.com", "craigslist.org"
]
```

This reduces bandwidth by ~70% since most browsing (Google, YouTube, TikTok, general sites) works fine from datacenter IPs.

---

## 6. Phased Shipping Plan

### Phase 1: Residential Proxy (Ship in 1 week)

**What:** Add `--proxy-server` flag to Chrome launch when targeting blocked domains.

**Changes:**
1. `lib/ssh.ts` — `buildOpenClawConfig()`: Add proxy config to browser launch args
2. `lib/ssh.ts` — `configureOpenClaw()`: Accept proxy credentials from env vars
3. New env vars: `PROXY_HOST`, `PROXY_PORT`, `PROXY_USER`, `PROXY_PASS`
4. Domain blocklist in `SKILL.md` — agent knows when to request proxy mode
5. `SOUL.md` — instruction for agent to use proxy flag on blocked domains
6. WebRTC/DNS leak prevention flags added to Chrome launch

**Effort:** 2-3 days dev + 1-2 days testing
**Cost:** ~$75/mo (Smartproxy starter) to start
**Impact:** Unlocks Reddit, LinkedIn public profiles, Amazon, Zillow, Indeed

**Deployment:**
- Fleet patch to add proxy config to all VMs
- Test on 1 VM first (per CLAUDE.md rule #3)
- Roll out to fleet

### Phase 2: Chrome Extension Relay (Ship in 1 month)

**What:** Fork OpenClaw's extension, modify for remote VM access via Caddy tunnel.

**Changes:**
1. Fork chengyixu/openclaw-browser-relay as `instaclaw-chrome-extension`
2. Modify WebSocket URL builder: `wss://{gateway-url}/relay/extension?token={hmac}`
3. Add HMAC derivation using gateway token
4. Update manifest: permissions, host_permissions for `*.vm.instaclaw.io`
5. Build options page UI: "Enter your InstaClaw gateway URL" (pull from dashboard)
6. Caddy config: add `/relay/*` reverse proxy route to relay port
7. OpenClaw config: ensure `browser.defaultProfile: "chrome"` when extension connected
8. Dashboard UI: "Connect your browser" section with extension download link + setup guide
9. Chrome Web Store submission (or self-hosted .crx for now)

**Effort:** 2-3 weeks dev + 1 week testing/polish
**Cost:** Chrome Web Store developer fee ($5 one-time)
**Impact:** Full access to ANY site the user is logged into — Instagram, Facebook, banking, corporate intranets, etc.

**Key decisions needed:**
- Self-hosted vs Chrome Web Store (store takes 2-5 days review)
- Auto-attach all tabs vs opt-in per tab (privacy implications)
- How to handle the yellow "debugging" banner Chrome shows

### Phase 3: Smart Browser Mode Switching (Ship in 3 months)

**What:** Agent automatically picks the best browser mode per task.

```
User: "Check my Instagram DMs"
Agent thinks: Instagram → login required → needs user's session → Extension Relay mode
Agent: *switches to chrome profile, uses user's logged-in Instagram*

User: "Search for cheap flights on Google"
Agent thinks: Google → no login needed → works from datacenter → Managed mode
Agent: *uses headless Chrome directly, no proxy needed*

User: "Check Reddit for sentiment on $AAPL"
Agent thinks: Reddit → blocked from datacenter → needs residential IP → Managed + Proxy mode
Agent: *uses headless Chrome with residential proxy*
```

**Changes:**
1. Browser mode router: domain → mode mapping with user preferences
2. Per-profile proxy config (some profiles use proxy, some don't)
3. Extension connection status exposed to agent via tool
4. Graceful fallback chain: Extension → Proxy+Managed → Managed → web_fetch → web_search
5. Usage tracking: proxy bandwidth per user for billing
6. Dashboard: "Browser Capabilities" panel showing what's connected

**Effort:** 3-4 weeks dev
**Cost:** Infrastructure for proxy billing, extension maintenance
**Impact:** Seamless browsing experience — agent always picks the right tool

---

## Appendix: How Claude's Chrome Extension Compares

| Aspect | OpenClaw Extension | Claude for Chrome |
|--------|-------------------|-------------------|
| CDP version | 1.3 | 1.3 |
| Attach method | `chrome.debugger.attach` | `chrome.debugger.attach` |
| Auth | HMAC-SHA256 relay token | OAuth PKCE + API key |
| Connection | WebSocket to relay server | Native Messaging to CLI |
| Element targeting | CDP sessions mapped to tabs | `window.__claudeElementMap` with WeakRef |
| Screenshots | Via relay CDP forwarding | `Page.captureScreenshot` direct |
| Input | CDP `Input.dispatch*` via relay | CDP `Input.dispatch*` direct |
| Form filling | Via CDP | Direct DOM manipulation + events |
| Tab management | Auto-attach all tabs | New tabs only, grouped |
| Domain safety | None built-in | Pre-action `domain_info` API check |
| Login handling | Uses whatever session exists | Pauses and asks user at login pages |

**Key takeaway:** Both use the exact same CDP protocol (v1.3) and `chrome.debugger` API. The difference is transport — OpenClaw uses WebSocket relay, Claude uses Native Messaging. Our fork uses the relay approach which works over the network (critical for remote VMs).

---

## Appendix: Google Chrome DevTools MCP Server

Google's official `@anthropic/chrome-devtools-mcp` (now `chrome-devtools-mcp`) provides another integration path:

- Uses Puppeteer as CDP abstraction
- 29 browser tools (navigate, click, type, screenshot, snapshot, evaluate, etc.)
- Supports `--autoConnect` via `DevToolsActivePort` file detection
- Supports `--wsEndpoint` for remote Chrome connections
- Element addressing via accessibility tree UIDs

**Relevance to us:** This is what `driver: "existing-session"` uses in OpenClaw. It's the third browser mode — for users who want to connect an already-running Chrome without an extension. Less powerful than the extension relay (no auto-attach, no tab management) but zero-install.
