# InstaClaw: Browser Capability Upgrade — PRD

## Residential Proxy + Chrome Extension Relay

**Date:** March 13, 2026
**Author:** Cooper Wrenn
**Company:** Wild West Bots LLC

---

## 1. Overview

InstaClaw agents currently browse the web through headless Chrome on Linode VMs using datacenter IPs. Major platforms — Instagram, LinkedIn, Reddit, Amazon, Zillow, Indeed — block these IPs outright. When a user asks their agent to "check my Instagram DMs" or "look at this Reddit thread," the agent hits a wall, returns "Browser failed," and in some cases goes completely silent (the Jimmy incident, March 13 2026). This PRD covers two features that together unlock full web access for every agent:

**Layer 1: Residential Proxy** — Route headless Chrome through residential IPs to bypass datacenter blocks. Unlocks Reddit, LinkedIn public profiles, Amazon, Zillow, Indeed.

**Layer 2: Chrome Extension Relay** — Fork OpenClaw's extension so agents can browse through the user's actual Chrome browser with their real login sessions. Unlocks Instagram DMs, Facebook, banking, corporate intranets — anything the user is logged into.

### 1.1 Goals

- Eliminate "Browser failed" and silent-death errors when agents hit blocked sites
- Agents can access any publicly available website via residential proxy
- Agents can access login-gated sites through the user's own browser session via Chrome extension
- Smart routing: agent automatically picks the right browser mode per task
- Cost-efficient: proxy bandwidth only used for sites that require it
- Zero changes to the agent conversation UX — browsing just works

### 1.2 Non-Goals

- Building our own residential proxy network
- Modifying the OpenClaw gateway core (relay server stays as-is)
- Mobile browser support (Chrome desktop only for extension relay)
- Browser automation for sites that explicitly prohibit it via ToS (the agent will respect robots.txt and rate-limit itself)
- Changing the existing 4-tier web capability model (web_search → web_fetch → browser → crawlee)

---

## 2. Current State

### 2.1 The Jimmy Incident (March 13, 2026)

User (Cooper) asked Jimmy (@jimmmmmyyyyyybot, vm-065) to look at an Instagram profile (`instagram.com/aiwithremy`). What happened:

1. Agent received the message via Telegram long-polling
2. Agent escalated through the 4-tier model: web_search → web_fetch → browser tool
3. Headless Chrome on the VM navigated to Instagram
4. Instagram's aggressive bot detection blocked the datacenter IP, Chrome timed out after 30s
5. The browser MCP tool returned "Browser failed" error
6. **The agent went completely silent** — no error message, no fallback, no response

Root causes:
- **No proxy infrastructure** — Chrome uses the VM's raw datacenter IP (Linode, 45.33.x.x range)
- **No browser failure recovery** — SOUL.md had no "never go silent after tool error" rule (now fixed)
- **Instagram not in the blocked sites list** — SKILL.md didn't warn the agent that Instagram would fail (now fixed)
- **No alternative path** — even if the agent recovered, there's no way to access login-gated content from a datacenter

### 2.2 Current Browser Architecture

The OpenClaw gateway runs headless Chrome via a 4-tier model defined in `skills/web-search-browser/SKILL.md`:

| Tier | Tool | How It Works | Blocked By |
|------|------|-------------|------------|
| 1 | `web_search` (Brave API) | API call, no browser | Nothing |
| 2 | `web_fetch` | HTTP GET with headers | JS-rendered sites, login walls |
| 3 | `browser` (CDP) | Headless Chrome on VM, port 18800 | Datacenter IP blocks, login walls |
| 3.5 | `crawlee` (stealth) | Playwright + TLS fingerprint spoofing | Aggressive anti-bot (PerimeterX, etc.) |

**Key files:**
- `lib/ssh.ts:1569-1577` — `buildOpenClawConfig()` browser section: `executablePath`, `headless: true`, `noSandbox: true`, `cdpPort: 18800`
- `lib/ssh.ts:71-74` — `CHROME_CLEANUP` constant (kills stale Chrome processes)
- `lib/ssh.ts:4756` — `killStaleBrowser()` function (health cron kills Chrome if >30min or >40% RAM)
- `skills/web-search-browser/SKILL.md:18-31` — 4-tier escalation model
- `skills/web-search-browser/SKILL.md:397` — Platform Access Status table
- `skills/web-search-browser/assets/crawlee-scrape.py` — Crawlee stealth scraper (BeautifulSoup + Playwright modes)

### 2.3 Live Blocked Sites Audit (March 13, 2026)

Tested from instaclaw-vm-063 (45.33.63.105, Linode datacenter IP) using curl with Chrome 120 headers:

| Site | HTTP | Body | Verdict |
|------|------|------|---------|
| Instagram | 200 | 123 KB | **Shell only** — SPA login wall, no actual content |
| Twitter/X | 200 | 54 KB | **Partial** — SSR content available, JS features gated |
| LinkedIn | 999 | Tiny | **Blocked** — custom 999 anti-bot code, JS fingerprint page |
| Reddit | 403 | — | **Blocked** — explicit 403 from datacenter IP |
| Facebook | 200 | 190 KB | **Shell only** — app shell, content requires login/JS |
| TikTok | 200 | 75 KB | **Accessible** — full HTML returned |
| Amazon | 202 | 2 KB | **CAPTCHA** — bot-check page, not real content |
| Google | 200 | 43 KB | **Accessible** — real search results |
| YouTube | 200 | 74 KB | **Accessible** — full page |
| Zillow | 403 | — | **Blocked** — PerimeterX `px-captcha` |
| Indeed | 403 | — | **Blocked** — "Security Check" page |

**Summary:** 5 sites hard-blocked (LinkedIn, Reddit, Zillow, Indeed, Amazon), 3 return empty shells (Instagram, Facebook, Twitter/X), 3 fully accessible (Google, YouTube, TikTok).

### 2.4 What Each Layer Unlocks

| Site | Current | + Residential Proxy | + Extension Relay |
|------|---------|--------------------|--------------------|
| Reddit | 403 blocked | Accessible | Accessible + logged in |
| LinkedIn | 999 blocked | Public profiles work | Full access with login |
| Instagram | Shell only | Shell only (still login-gated) | **Full access with user's session** |
| Facebook | Shell only | Shell only (still login-gated) | **Full access with user's session** |
| Amazon | CAPTCHA | Product pages work | Logged-in prices, orders |
| Zillow | 403 blocked | Listings work | Saved searches, account features |
| Indeed | 403 blocked | Job listings work | Applied jobs, saved searches |
| Banking/corporate | N/A | N/A | **Full access with user's session** |

---

## 3. Phase 1: Residential Proxy Integration

### 3.1 Architecture

```
Agent tool call: browser.navigate("reddit.com/r/technology")
        │
        ▼
OpenClaw Gateway checks domain against PROXY_DOMAINS list
        │
        ├── Domain NOT in list ──► Launch Chrome normally (datacenter IP)
        │
        └── Domain IN list ──► Launch Chrome with --proxy-server flag
                                    │
                                    ▼
                              Residential proxy provider
                              (Smartproxy / IPRoyal)
                                    │
                                    ▼
                              Target website sees residential IP
```

### 3.2 Implementation: Chrome Launch Flags

Adding proxy support is one Chrome launch flag plus leak prevention:

```bash
# Current launch (lib/ssh.ts:1569-1577)
chromium-browser --headless --no-sandbox --remote-debugging-port=18800

# New launch (when proxy needed)
chromium-browser --headless --no-sandbox --remote-debugging-port=18800 \
  --proxy-server=http://gate.smartproxy.com:10001 \
  --proxy-bypass-list="" \
  --disable-webrtc \
  --force-webrtc-ip-handling-policy=disable_non_proxied_udp
```

For authenticated proxies, page-level auth is set after Chrome launches:
```javascript
await page.authenticate({ username: 'user', password: 'pass' });
```

### 3.3 Files to Modify

| File | Line(s) | Action | Details |
|------|---------|--------|---------|
| `lib/ssh.ts` | 1552 | MODIFY | `buildOpenClawConfig()` — add proxy fields to browser config object |
| `lib/ssh.ts` | 1569-1577 | MODIFY | Browser config: add `proxyServer`, `proxyBypassList`, `disableWebRTC` fields |
| `lib/ssh.ts` | 1876 | MODIFY | `configureOpenClaw()` — read proxy env vars, pass to buildOpenClawConfig |
| `lib/ssh.ts` | 2013 | MODIFY | Where `braveKey` is resolved — add `proxyHost`, `proxyUser`, `proxyPass` resolution from env |
| `lib/ssh.ts` | 2582-2619 | ADD AFTER | Deploy proxy credentials to VM's `~/.openclaw/.env` (same pattern as BRAVE_SEARCH_API_KEY deployment) |
| `skills/web-search-browser/SKILL.md` | 397 | MODIFY | Update Platform Access Status table — mark Reddit, LinkedIn, Amazon, Zillow, Indeed as "Works (via proxy)" |
| `skills/web-search-browser/SKILL.md` | 338 | MODIFY | Tool Decision Matrix — add proxy routing guidance |
| `skills/web-search-browser/SKILL.md` | 356 | ADD AFTER | New "Proxy Routing" section in Known Limitations |
| `lib/ssh.ts` | 1085 | MODIFY | `WORKSPACE_SOUL_MD` — add instruction for agents to recognize proxy-required domains |
| `lib/agent-intelligence.ts` | 374 | MODIFY | `WORKSPACE_CAPABILITIES_MD` — add proxy as a capability |

### 3.4 Exact Config Change in buildOpenClawConfig()

**File:** `lib/ssh.ts:1569-1577`

**BEFORE:**
```typescript
browser: {
  executablePath: "/usr/local/bin/chromium-browser",
  headless: true,
  noSandbox: true,
  defaultProfile: "openclaw",
  profiles: {
    openclaw: { cdpPort: 18800, color: "#FF4500" },
  },
},
```

**AFTER:**
```typescript
browser: {
  executablePath: "/usr/local/bin/chromium-browser",
  headless: true,
  noSandbox: true,
  defaultProfile: "openclaw",
  profiles: {
    openclaw: { cdpPort: 18800, color: "#FF4500" },
    // Phase 1: proxy profile for blocked domains
    ...(proxyHost ? {
      proxy: {
        cdpPort: 18801,
        color: "#10B981",
        launchArgs: [
          `--proxy-server=${proxyHost}`,
          "--proxy-bypass-list=",
          "--disable-webrtc",
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        ],
      },
    } : {}),
  },
},
```

### 3.5 Environment Variables

| Variable | Example Value | Scope | Notes |
|----------|---------------|-------|-------|
| `PROXY_HOST` | `gate.smartproxy.com:10001` | Vercel + VM .env | Proxy server address |
| `PROXY_USER` | `sp_user_xxxxx` | Vercel + VM .env | Proxy auth username |
| `PROXY_PASS` | `sp_pass_xxxxx` | Vercel + VM .env | Proxy auth password. **Never log this.** |
| `PROXY_DOMAINS` | `linkedin.com,reddit.com,zillow.com,indeed.com,amazon.com,glassdoor.com,craigslist.org` | Vercel (propagated to SKILL.md) | Domains that require proxy routing |

**Deployment pattern:** Same as `BRAVE_SEARCH_API_KEY` (lib/ssh.ts:2612-2619). Base64-encode credentials, SSH to VM, write to `~/.openclaw/.env` via upsert:

```bash
grep -q '^PROXY_HOST=' ~/.openclaw/.env 2>/dev/null && \
  sed -i 's|^PROXY_HOST=.*|PROXY_HOST=gate.smartproxy.com:10001|' ~/.openclaw/.env || \
  echo 'PROXY_HOST=gate.smartproxy.com:10001' >> ~/.openclaw/.env
```

### 3.6 SKILL.md Domain Routing

**File:** `skills/web-search-browser/SKILL.md`, add after line 395 (Known Limitations section):

```markdown
### 7. Proxy Routing for Blocked Domains

Some sites block datacenter IPs. When browsing these domains, use the `proxy` browser profile:

**Proxy-required domains:**
- linkedin.com — returns 999 from datacenter IPs
- reddit.com — returns 403
- zillow.com — PerimeterX bot detection
- indeed.com — security check page
- amazon.com — CAPTCHA gate
- glassdoor.com — Cloudflare block
- craigslist.org — IP-based block

**How to use:** When the browser tool targets one of these domains, append `--profile proxy` to the browser command. The proxy profile routes through a residential IP automatically.

**If proxy also fails:** Fall back to `web_fetch` or `web_search`. Tell the user the site has aggressive bot protection and suggest alternatives.
```

### 3.7 Rollout Plan — Phase 1

**Pre-launch checklist:**
- [ ] Sign up for Smartproxy ($75/mo starter plan, 10 GB included)
- [ ] Verify proxy works: `curl -x http://user:pass@gate.smartproxy.com:10001 https://reddit.com` returns 200
- [ ] Set `PROXY_HOST`, `PROXY_USER`, `PROXY_PASS` in Vercel env vars
- [ ] Create preview branch with all code changes
- [ ] `npm run build` passes clean
- [ ] **Test on ONE VM first** (CLAUDE.md rule #3): deploy proxy config to vm-063
- [ ] SSH to vm-063, verify `~/.openclaw/.env` has proxy credentials
- [ ] From vm-063: `chromium-browser --headless --proxy-server=gate.smartproxy.com:10001 --dump-dom https://reddit.com/r/technology` returns real HTML (not 403)
- [ ] Verify gateway is active after config change (CLAUDE.md rule #5): `systemctl --user is-active openclaw-gateway` returns "active" AND `/health` returns 200
- [ ] Send test message to vm-063's agent: "Search Reddit for the latest posts about AI agents" — agent should return real content
- [ ] Monitor Smartproxy dashboard: confirm bandwidth usage matches expected (~2 MB per page)
- [ ] **Wait for manual approval** before fleet-wide deploy

**Fleet deployment:**
- [ ] Run fleet patch script with `--dry-run` first (CLAUDE.md rule #4)
- [ ] Review dry-run output
- [ ] Run fleet patch for real: deploy proxy env vars to all 55 assigned VMs
- [ ] Spot-check 3 random VMs: verify proxy credentials in `.env` and gateway health
- [ ] Push preview branch to main after approval

**Post-launch monitoring:**
- [ ] Watch Smartproxy bandwidth dashboard for 48 hours
- [ ] Monitor health cron for proxy-related gateway crashes
- [ ] Check that non-proxy browsing (Google, YouTube) still works from datacenter IP (no regression)

---

## 4. Phase 2: Chrome Extension Relay

### 4.1 Architecture

```
User's Laptop                              Linode VM
┌──────────────────────┐            ┌──────────────────────────────┐
│  Chrome Browser       │            │  Caddy (TLS)                 │
│  ┌──────────────────┐│            │  ┌──────────────────────────┐│
│  │ InstaClaw         ││  WSS/TLS  │  │ /relay/* → 127.0.0.1:    ││
│  │ Extension         ││◄─────────►│  │           18792           ││
│  │ (background.js)   ││            │  └──────────────────────────┘│
│  │                   ││            │  ┌──────────────────────────┐│
│  │ chrome.debugger   ││            │  │ Extension Relay Server   ││
│  │ .attach(tabId)    ││            │  │ (extension-relay.ts)     ││
│  └──────────────────┘│            │  │ Port 18792, loopback     ││
│                       │            │  └──────────────────────────┘│
│  User's logged-in     │            │  ┌──────────────────────────┐│
│  sessions (Instagram, │            │  │ OpenClaw Gateway          ││
│  Facebook, etc.)      │            │  │ Port 18789                ││
│                       │            │  │ Receives agent tool calls ││
└──────────────────────┘            │  │ browser --profile chrome  ││
                                     │  └──────────────────────────┘│
                                     └──────────────────────────────┘
```

**Key insight:** The relay server already runs on every VM at port 18792 (loopback). Caddy already handles TLS for `{uuid}.vm.instaclaw.io`. We just need to add a Caddy route that tunnels `/relay/*` to the relay port. The extension connects via `wss://` instead of `ws://127.0.0.1`. Zero relay server code changes.

### 4.2 How the Extension Works (Source Code Analysis)

Based on reading the actual source code from the chengyixu/openclaw-browser-relay fork (the production version):

**manifest.json:**
```json
{
  "manifest_version": 3,
  "permissions": ["debugger", "tabs", "activeTab", "storage", "alarms", "webNavigation"],
  "host_permissions": ["http://127.0.0.1/*", "http://localhost/*"],
  "background": { "service_worker": "background.js", "type": "module" }
}
```

**background.js — WebSocket connection:**
1. Loads gateway token from `chrome.storage.local`
2. Derives HMAC relay token: `HMAC-SHA256(gatewayToken, "openclaw-extension-relay-v1:{port}")` → hex
3. Opens WebSocket: `ws://127.0.0.1:{port}/extension?token={hmac}`
4. Sends `connect` handshake with `role: "operator"`, `scopes: ["operator.read", "operator.write"]`

**background.js — CDP forwarding:**
1. Relay sends: `{ id, method: "forwardCDPCommand", params: { method, params, sessionId } }`
2. Extension maps `sessionId` → Chrome `tabId`
3. Calls `chrome.debugger.sendCommand({tabId}, method, params)`
4. Returns result: `{ id, result }`
5. CDP events flow the opposite way via `chrome.debugger.onEvent` → `forwardCDPEvent`

**background.js — Auto-attach:**
- On startup + every 30s via `chrome.alarms`: queries all open tabs, attaches `chrome.debugger` to each navigable tab
- Navigation survival: re-attach retry loop at [200, 500, 1000, 2000, 4000]ms after debugger detaches during page navigation
- MV3 state persistence: attached tab state saved to `chrome.storage.session`, restored after service worker restart

**Authentication:** HMAC-SHA256 token derived from the gateway token (same token stored in `openclaw.json` and `instaclaw_vms.gateway_token`). The relay server validates this on WebSocket upgrade.

### 4.3 What We Fork and Change

**Fork:** `chengyixu/openclaw-browser-relay` → `instaclaw-chrome-extension` (our repo)

| Component | Current (OpenClaw) | Our Fork (InstaClaw) |
|-----------|-------------------|---------------------|
| WebSocket URL | `ws://127.0.0.1:18792/extension?token={hmac}` | `wss://{gatewayUrl}/relay/extension?token={hmac}` |
| HMAC message | `openclaw-extension-relay-v1:{port}` | `openclaw-extension-relay-v1:{port}` (unchanged — relay validates) |
| Options page | Port + token inputs | Gateway URL input (pulled from dashboard, e.g. `https://1eac973f-xxxx.vm.instaclaw.io`) |
| Health check | `http://127.0.0.1:{port}/` | `https://{gatewayUrl}/relay/` |
| manifest host_permissions | `http://127.0.0.1/*` | `https://*.vm.instaclaw.io/*` |
| Extension name | "OpenClaw Browser Relay" | "InstaClaw Browser Relay" |
| Auto-attach | All tabs | All tabs (configurable: opt-in per tab as privacy option) |
| Distribution | Self-hosted | Chrome Web Store ($5 one-time fee) |

### 4.4 Caddy Config Change

**File:** `lib/ssh.ts:5618` — the Caddyfile template

**BEFORE:**
```caddyfile
{hostname} {
  handle /.well-known/* {
    root * /home/openclaw
    file_server
  }
  handle /tmp-media/* {
    root * /home/openclaw/workspace
    file_server
  }
  reverse_proxy localhost:18789
}
```

**AFTER:**
```caddyfile
{hostname} {
  handle /.well-known/* {
    root * /home/openclaw
    file_server
  }
  handle /tmp-media/* {
    root * /home/openclaw/workspace
    file_server
  }
  handle /relay/* {
    uri strip_prefix /relay
    reverse_proxy localhost:18792
  }
  reverse_proxy localhost:18789
}
```

**Single line change** in the Caddyfile template string at `lib/ssh.ts:5618`. The `handle /relay/*` block goes before the catch-all `reverse_proxy` to ensure it matches first.

### 4.5 OpenClaw Config Change

**File:** `lib/ssh.ts:1569-1577` — add `chrome` profile for extension relay mode

**AFTER (with both proxy and extension profiles):**
```typescript
browser: {
  executablePath: "/usr/local/bin/chromium-browser",
  headless: true,
  noSandbox: true,
  defaultProfile: "openclaw",
  profiles: {
    openclaw: { cdpPort: 18800, color: "#FF4500" },
    ...(proxyHost ? {
      proxy: {
        cdpPort: 18801,
        color: "#10B981",
        launchArgs: [
          `--proxy-server=${proxyHost}`,
          "--proxy-bypass-list=",
          "--disable-webrtc",
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        ],
      },
    } : {}),
    chrome: {
      // Extension relay profile — no cdpPort, no executablePath
      // Uses extension-connected tabs via relay at port 18792
      color: "#3B82F6",
    },
  },
},
```

### 4.6 Files to Modify

| File | Line(s) | Action | Details |
|------|---------|--------|---------|
| `lib/ssh.ts` | 5618 | MODIFY | Caddyfile template — add `/relay/*` reverse proxy to port 18792 |
| `lib/ssh.ts` | 1569-1577 | MODIFY | `buildOpenClawConfig()` — add `chrome` profile for extension relay |
| `skills/web-search-browser/SKILL.md` | 18-31 | MODIFY | Add Tier 4: Extension Relay to the escalation model |
| `skills/web-search-browser/SKILL.md` | 397 | MODIFY | Platform Access Status — mark Instagram, Facebook as "Works (via extension)" |
| `lib/ssh.ts` | 1085 | MODIFY | `WORKSPACE_SOUL_MD` — add instruction for when to use extension relay vs managed browser |
| `lib/agent-intelligence.ts` | 374 | MODIFY | `WORKSPACE_CAPABILITIES_MD` — add extension relay as a capability |
| `app/(dashboard)/settings/page.tsx` | 608 | ADD AFTER | "Connect Your Browser" section — extension download link, setup instructions, connection status |
| `app/(dashboard)/dashboard/page.tsx` | 779 | ADD AFTER | Extension connection status indicator |
| **NEW FILE** | — | CREATE | `instaclaw-chrome-extension/` directory in repo (forked extension source) |
| **NEW FILE** | — | CREATE | `app/api/vm/extension-status/route.ts` — endpoint to check if extension is connected to a VM's relay |

### 4.7 Dashboard UI: "Connect Your Browser" Section

**File:** `app/(dashboard)/settings/page.tsx`

New section below the existing Gateway URL display (line 608):

```
┌─────────────────────────────────────────────────┐
│  🌐 Browser Extension                           │
│                                                  │
│  Connect your Chrome browser so your agent can   │
│  browse with your logged-in sessions.            │
│                                                  │
│  Status: ● Connected (3 tabs)                    │
│      or: ○ Not connected                         │
│                                                  │
│  [Install Extension]  [Setup Guide]              │
│                                                  │
│  Your Gateway URL (paste into extension):        │
│  ┌────────────────────────────────────────────┐  │
│  │ https://1eac973f-xxxx.vm.instaclaw.io     │  │
│  └────────────────────────────────────────────┘  │
│  [Copy]                                          │
└─────────────────────────────────────────────────┘
```

Extension status is polled via: `GET {gatewayUrl}/relay/extension/status` → `{ connected: boolean }` (existing relay endpoint, now exposed through Caddy).

### 4.8 Environment Variables

No new env vars for Phase 2. The extension uses the existing `gateway_token` from Supabase (same token the VM already has in `openclaw.json`). The user pastes their Gateway URL into the extension options page.

### 4.9 Rollout Plan — Phase 2

**Pre-launch checklist:**
- [ ] Fork chengyixu/openclaw-browser-relay into our repo
- [ ] Modify background.js: WebSocket URL builder, health check URL
- [ ] Modify manifest.json: host_permissions, name, icons
- [ ] Build extension: `npm run build` (if build system exists) or copy files directly
- [ ] Submit to Chrome Web Store (takes 2-5 business days for review)
- [ ] Modify Caddyfile template in `lib/ssh.ts:5618` — add `/relay/*` route
- [ ] Modify `buildOpenClawConfig()` — add `chrome` profile
- [ ] Build dashboard UI for extension setup
- [ ] `npm run build` passes clean
- [ ] **Test on ONE VM first** (CLAUDE.md rule #3):
  - [ ] Deploy updated Caddyfile to vm-063
  - [ ] Reload Caddy: `sudo systemctl reload caddy`
  - [ ] Verify `https://{uuid}.vm.instaclaw.io/relay/` returns 200
  - [ ] Install extension in Chrome, paste Gateway URL, enter gateway token
  - [ ] Extension badge shows "ON" (connected)
  - [ ] Send test message: "What tabs do I have open?" — agent should list Chrome tabs
  - [ ] Send test message: "Go to instagram.com and tell me what you see" — agent should access Instagram via extension
  - [ ] Verify gateway health (CLAUDE.md rule #5)
- [ ] **Wait for manual approval** before fleet deploy
- [ ] Self-hosted .crx for early testing (before Chrome Web Store approval)

**Fleet deployment:**
- [ ] Fleet patch: update Caddyfile on all VMs with `--dry-run` first (CLAUDE.md rule #4)
- [ ] Fleet patch for real: reload Caddy on all VMs
- [ ] Verify relay endpoint accessible on 3 random VMs
- [ ] Push to main after approval

---

## 5. Phase 3: Smart Browser Mode Switching

### 5.1 Architecture

The agent automatically picks the best browser mode based on the target domain and what's available:

```
Agent receives: "Check my Instagram DMs"
                    │
                    ▼
         ┌─── Is extension connected? ──── YES ──► Use chrome profile
         │           │                              (user's logged-in session)
         │           NO
         │           │
         │           ▼
         │    Is domain in PROXY_DOMAINS? ── YES ──► Use proxy profile
         │           │                               (residential IP)
         │           NO
         │           │
         │           ▼
         │    Use openclaw profile ──────────────► Managed headless Chrome
         │    (default, datacenter IP)              (works for most sites)
         │
         └─── Fallback chain: chrome → proxy → openclaw → crawlee → web_fetch → web_search
```

### 5.2 Decision Logic (SKILL.md Addition)

```markdown
## Browser Profile Selection

When using the browser tool, select the profile based on the task:

| Scenario | Profile | Why |
|----------|---------|-----|
| User asks to check THEIR account on a site | `chrome` (extension) | Needs user's login session |
| Browsing a proxy-required domain (Reddit, LinkedIn, etc.) | `proxy` | Datacenter IP is blocked |
| General browsing (Google, YouTube, news sites) | `openclaw` (default) | Works fine from datacenter |
| Extension not connected + login-required site | Tell user to install extension | No other path to logged-in content |

**Fallback chain:** If the selected profile fails, try the next one down:
1. `chrome` (extension relay) → 2. `proxy` (residential IP) → 3. `openclaw` (managed headless) → 4. `crawlee` (stealth scraper) → 5. `web_fetch` → 6. `web_search`
```

### 5.3 Files to Modify

| File | Action | Details |
|------|--------|---------|
| `skills/web-search-browser/SKILL.md` | MODIFY | Add Browser Profile Selection section, update Tool Decision Matrix |
| `lib/ssh.ts` (SOUL.md) | MODIFY | Add instruction: "Check extension status before choosing browser profile" |
| `lib/agent-intelligence.ts` (CAPABILITIES.md) | MODIFY | Document all three profiles and when to use each |
| `app/api/vm/extension-status/route.ts` | MODIFY | Return extension status + connected tab count (agent can check via tool) |

### 5.4 Rollout Plan — Phase 3

- [ ] Update SKILL.md with profile selection logic
- [ ] Update SOUL.md with browser mode awareness
- [ ] Fleet deploy updated SKILL.md and SOUL.md
- [ ] Test: ask agent "check my Instagram" without extension → should tell user to install extension
- [ ] Test: ask agent "search Reddit for AI news" → should use proxy profile
- [ ] Test: ask agent "search Google for weather" → should use default openclaw profile

---

## 6. Edge Cases & Failure Modes

### 6.1 Proxy Goes Down

**Scenario:** Smartproxy's infrastructure has an outage. Chrome hangs on proxy connection.

**Detection:** Chrome will timeout after the configured navigation timeout (30s default). The browser tool returns an error.

**Recovery:**
1. Agent receives browser error
2. Falls back to `openclaw` profile (direct datacenter connection) — may get a 403 but at least doesn't hang
3. If that also fails, falls back to `web_fetch` → `web_search`
4. Agent tells user: "I couldn't access Reddit right now. Here's what I found via web search instead."

**Mitigation:** Set Chrome `--proxy-connection-timeout=10000` flag. If proxy doesn't respond in 10s, Chrome fails fast instead of hanging 30s.

### 6.2 Extension Disconnects Mid-Task

**Scenario:** User closes Chrome or laptop goes to sleep while agent is browsing via extension.

**Detection:** The relay server detects WebSocket close. It has a **20-second grace period** (`DEFAULT_EXTENSION_RECONNECT_GRACE_MS`) before notifying CDP clients. If the extension reconnects within 20s (e.g., Chrome restarts), browsing resumes transparently.

**Recovery after 20s:**
1. Relay returns error to gateway for any pending CDP commands
2. Agent receives browser tool error
3. Agent falls back to `proxy` or `openclaw` profile
4. Agent tells user: "Your browser extension disconnected. I'm continuing with my built-in browser, but I won't have access to your logged-in sessions. Reconnect the extension when you're ready."

**Mitigation:** Extension has exponential backoff reconnect: `min(1000 * 2^attempt, 30000) + jitter`. It auto-reconnects when Chrome reopens.

### 6.3 WebSocket Connection Drops (Network Flap)

**Scenario:** User's WiFi drops briefly, WebSocket between extension and VM relay breaks.

**Detection:** WebSocket `onclose` event in extension. Caddy's reverse proxy returns 502 if relay is unreachable.

**Recovery:**
1. Extension detects close, starts reconnect with exponential backoff
2. Relay's 20s grace period buffers pending commands
3. If reconnect succeeds within 20s: zero impact, commands resume
4. If reconnect fails after 20s: agent falls back (same as 6.2)

**Mitigation:** Extension keepalive alarm fires every 30s, proactively checks relay health.

### 6.4 User Closes Chrome While Agent Is Browsing

**Scenario:** Agent is in the middle of filling out a form on Instagram via extension, user quits Chrome.

**Detection:** All `chrome.debugger` sessions terminate. Extension service worker gets shut down by Chrome.

**Recovery:**
1. Relay loses extension WebSocket
2. 20s grace period — Chrome won't reopen in time
3. Relay returns errors for all pending CDP commands
4. Agent receives errors, falls back to managed browser
5. Agent tells user what happened and what it managed to complete before disconnection

**Prevention:** Dashboard shows "Your agent is currently using your browser" indicator. Extension popup shows active task. Documentation warns: "Don't close Chrome while your agent is browsing."

### 6.5 Proxy Bandwidth Exhaustion

**Scenario:** Smartproxy plan runs out of included bandwidth mid-month.

**Detection:** Proxy returns 407 (Proxy Authentication Required) or connection refused.

**Recovery:** Same as 6.1 — fall back to direct datacenter connection.

**Mitigation:** Monitor bandwidth via Smartproxy API. Alert at 80% usage. Auto-upgrade plan or switch to pay-as-you-go at 90%.

### 6.6 Multiple Extensions Connected

**Scenario:** User installs extension on two Chrome profiles or two machines.

**Behavior:** The relay server accepts only one extension WebSocket at a time. Second connection replaces the first (the relay closes the old WebSocket). The first extension detects disconnection and shows "Disconnected — another instance took over."

**Prevention:** Options page shows "Connected" status. Dashboard shows connection source (IP, user agent).

### 6.7 Yellow "Debugging" Banner

**Behavior:** When `chrome.debugger.attach()` is called, Chrome shows a yellow banner: "InstaClaw Browser Relay started debugging this browser." This is a Chrome security feature and **cannot be suppressed**.

**Mitigation:**
- Onboarding guide explains what the banner means and that it's expected
- Extension popup has a "What's this yellow bar?" FAQ link
- Banner only appears while the extension is actively attached (disappears if user detaches or closes extension)
- Auto-attach can be disabled in extension options (user manually chooses which tabs to share)

### 6.8 HMAC Token Mismatch

**Scenario:** User's gateway token changes (e.g., via token rotation or admin resync). Extension has the old token.

**Detection:** Relay returns 401 on WebSocket upgrade. Extension shows "!" error badge.

**Recovery:** User re-enters gateway token in extension options. Or: extension options page has a "Refresh from Dashboard" button that fetches the current token via an authenticated API call.

### 6.9 Site Blocks Residential Proxy IP

**Scenario:** A site starts blocking Smartproxy's IP range (providers rotate IPs, but some sites are aggressive).

**Detection:** Still getting 403/CAPTCHA with proxy profile.

**Recovery:**
1. Agent falls back to crawlee stealth mode (TLS fingerprint spoofing)
2. If that fails, agent uses web_search as fallback
3. We switch proxy providers or use sticky residential sessions (same IP for longer periods)

---

## 7. Security Considerations

### 7.1 Proxy Credentials on VMs

**Risk:** Proxy credentials (`PROXY_USER`, `PROXY_PASS`) are stored in `~/.openclaw/.env` on every VM. If a VM is compromised, the attacker gets proxy access.

**Mitigations:**
- File permissions: `chmod 600 ~/.openclaw/.env` (already enforced by configureOpenClaw)
- VM isolation: each VM runs under a dedicated `openclaw` user, no root access
- Credential rotation: Smartproxy supports API key rotation. If a VM is compromised, rotate the key and fleet-deploy the new one
- Usage monitoring: Smartproxy dashboard shows per-request logs. Anomalous usage triggers alert.
- **No credit card info in proxy credentials** — Smartproxy billing is on our account, not per-VM

### 7.2 Extension Permissions

**Risk:** The extension requests `debugger` permission, which grants full CDP access to any attached tab. A malicious extension update could exfiltrate session cookies, passwords, or page content.

**Mitigations:**
- Chrome Web Store review process (all updates reviewed by Google)
- Extension source is open-source in our repo — auditable
- `host_permissions` limited to `https://*.vm.instaclaw.io/*` — extension can only connect to our VMs, not arbitrary servers
- Extension never touches page content directly — it only forwards CDP commands from the relay. The agent decides what to do, not the extension.
- User controls which tabs are attached (auto-attach can be disabled)
- Yellow debugging banner is visible proof that debugging is active

### 7.3 CDP Access Scope

**Risk:** Through the extension relay, the agent has full CDP access to the user's Chrome tabs. This includes `Runtime.evaluate` (arbitrary JS execution in page context), `Input.dispatchMouseEvent` (clicks), `Page.captureScreenshot` (screenshots of any page).

**Mitigations:**
- Agent's SOUL.md includes ethical guidelines — never access banking, healthcare, or sensitive sites without explicit user instruction
- Domain blocklist in SKILL.md: agent won't navigate to banking/financial sites unless specifically asked
- All CDP commands are logged by the gateway — auditable
- Extension shows which tabs are attached — user has visibility
- User can detach specific tabs or disconnect entirely at any time

### 7.4 WebSocket Relay Exposure

**Risk:** The Caddy `/relay/*` route exposes the relay server to the internet. Without auth, anyone could connect and control the user's browser.

**Mitigations:**
- HMAC-SHA256 token required on WebSocket upgrade — derived from the gateway token
- Gateway token is a 64-char hex string, cryptographically random
- Relay rejects connections without valid token (401)
- Caddy rate-limits connections (configurable)
- Relay only accepts one extension connection at a time
- Origin check: WebSocket upgrade rejected if Origin header is present and not `chrome-extension://`

### 7.5 Proxy Traffic Interception

**Risk:** The residential proxy provider can see all HTTP traffic passing through their servers.

**Mitigations:**
- HTTPS traffic is end-to-end encrypted — proxy sees the hostname (SNI) but not the content
- HTTP traffic is visible — but the agent should prefer HTTPS sites (SOUL.md instruction)
- Choose a reputable provider with a no-logging policy (Smartproxy, Oxylabs)
- For sensitive operations (banking, healthcare), use the extension relay instead of proxy — traffic goes directly from the user's browser, never through a proxy

---

## 8. Cost Analysis

### 8.1 Residential Proxy Costs

**Usage estimates** (55 assigned VMs):

| Scenario | Active VMs/day | Proxy pages/VM/day | Bandwidth/day | Monthly | Provider Cost |
|----------|---------------|-------------------|---------------|---------|---------------|
| Light | 20 | 10 | 400 MB | 12 GB | $84/mo (Smartproxy) |
| Medium | 35 | 25 | 1.75 GB | 52.5 GB | $368/mo (Smartproxy) |
| Heavy | 55 | 50 | 5.5 GB | 165 GB | $1,155/mo (Smartproxy) |

**Smart routing reduces this by ~70%:** Only proxy-required domains go through the proxy. Most browsing (Google, YouTube, TikTok, news sites) uses the free datacenter connection. Realistic monthly cost with smart routing:

| Scenario | Proxy bandwidth | Monthly cost |
|----------|----------------|--------------|
| Light | 3.6 GB | ~$25/mo |
| Medium | 15.8 GB | ~$111/mo |
| Heavy | 49.5 GB | ~$347/mo |

### 8.2 Chrome Extension Costs

| Item | Cost | Frequency |
|------|------|-----------|
| Chrome Web Store developer fee | $5 | One-time |
| Extension hosting / maintenance | $0 | Chrome Web Store hosts it |
| Caddy config change | $0 | No additional infrastructure |
| Relay server | $0 | Already running on every VM |

**Total extension cost: $5 one-time.** The relay server is already part of OpenClaw. Caddy is already deployed. The extension is the only new artifact.

### 8.3 Tier Pricing: Eat It or Pass Through?

**Recommendation: Eat the proxy cost for Pro tier, charge for Starter.**

| Tier | Monthly Price | Proxy Included? | Rationale |
|------|--------------|-----------------|-----------|
| Starter ($29/mo) | $29 | No — proxy disabled | Keep costs low. Starter users get the 4-tier model as-is. If they hit a blocked site, agent tells them to upgrade to Pro. |
| Pro ($99/mo) | $99 | Yes — proxy included | Pro already costs $99. Average proxy cost per Pro user at medium usage: ~$3.20/user/month ($111 / 35 active users). Easily absorbed into the $99 price. |

**Extension relay: included for all tiers.** It costs us nothing (user's own Chrome, user's own bandwidth). It's a huge selling point for Pro AND Starter users.

**Alternative considered: usage-based proxy billing.** Track bandwidth per user, charge overage. Rejected — adds billing complexity and confuses users. Better to include a generous allowance in Pro.

### 8.4 Total Infrastructure Cost Impact

| Component | Current Monthly | After Phase 1 | After Phase 2 |
|-----------|----------------|---------------|---------------|
| Proxy provider | $0 | $75-$347 | $75-$347 |
| Extension | $0 | $0 | $0 (+ $5 one-time) |
| VMs (unchanged) | ~$1,320 (55 × $24) | ~$1,320 | ~$1,320 |
| **Total** | **$1,320** | **$1,395-$1,667** | **$1,395-$1,667** |

At $99/mo Pro tier with 35 active users: **$3,465/mo revenue** vs **$1,667/mo max cost** = healthy margin.

---

## 9. Success Metrics

### Phase 1 (Proxy)

| Metric | Current | Target | How to Measure |
|--------|---------|--------|----------------|
| Reddit access success rate | 0% (403) | >95% | Gateway logs: browser tool success rate on reddit.com |
| LinkedIn access success rate | 0% (999) | >90% | Gateway logs: browser tool success rate on linkedin.com |
| "Browser failed" errors per day | ~5-10 | <1 | Health cron logs + agent error reports |
| Proxy bandwidth cost | $0 | <$150/mo | Smartproxy dashboard |
| Agent silent-death after browser error | ~2/week | 0 | Telegram message response rate audit |

### Phase 2 (Extension)

| Metric | Current | Target | How to Measure |
|--------|---------|--------|----------------|
| Extension installs (first 30 days) | 0 | 20+ | Chrome Web Store analytics |
| Instagram access via extension | Not possible | Working | User reports + gateway logs |
| Extension uptime (while Chrome open) | N/A | >99% | Relay connection logs |
| Average session duration (extension connected) | N/A | >30 min | Relay logs |

### Phase 3 (Smart Routing)

| Metric | Current | Target | How to Measure |
|--------|---------|--------|----------------|
| Correct browser profile selection | N/A | >90% of tasks | Agent decision audit (sample 100 tasks) |
| Proxy bandwidth waste (non-blocked domains through proxy) | N/A | <5% of proxy traffic | Smartproxy logs cross-referenced with PROXY_DOMAINS |
| User-reported browsing failures per week | ~5-10 | <1 | Support channel / Telegram reports |

---

## 10. Localhost Verification Checklist

### Phase 1 (Proxy)

- [ ] `npm run build` passes clean
- [ ] No new TypeScript errors in `lib/ssh.ts`
- [ ] `buildOpenClawConfig()` returns valid JSON when `proxyHost` is set
- [ ] `buildOpenClawConfig()` returns valid JSON when `proxyHost` is NOT set (no regression)
- [ ] Proxy credentials are never logged (grep for PROXY_PASS in console.log/logger calls)
- [ ] SKILL.md changes are valid Markdown, table renders correctly
- [ ] SOUL.md changes don't break the template string (no unescaped backticks)
- [ ] Fleet patch script supports `--dry-run` and `--test-first` flags
- [ ] Proxy env var deployment uses the same base64 upsert pattern as BRAVE_SEARCH_API_KEY

### Phase 2 (Extension)

- [ ] Extension loads in Chrome without errors (`chrome://extensions` → Developer mode → Load unpacked)
- [ ] Extension connects to a local test relay (start relay manually for testing)
- [ ] WebSocket URL correctly built as `wss://{url}/relay/extension?token={hmac}`
- [ ] HMAC derivation matches the relay's expected token (test with known inputs)
- [ ] Caddy config change doesn't break existing routes (health endpoint, media files still work)
- [ ] `npm run build` passes clean with Caddyfile template change
- [ ] Extension options page saves and loads gateway URL correctly
- [ ] Extension reconnects after WebSocket disconnect (kill relay, restart, verify reconnect)
- [ ] Chrome debugging banner appears when extension attaches (expected behavior)
- [ ] Settings page extension status section renders correctly

### Phase 3 (Smart Routing)

- [ ] Agent correctly selects `chrome` profile when extension is connected and task requires login
- [ ] Agent correctly selects `proxy` profile for proxy-required domains
- [ ] Agent correctly selects `openclaw` (default) for general browsing
- [ ] Fallback chain works: disconnect extension mid-task → agent falls back to proxy/managed
- [ ] SKILL.md profile selection table renders correctly

---

## 11. Implementation: Files Summary

### 11.1 All Files Modified (Across All Phases)

| File | Phase | Action | Details |
|------|-------|--------|---------|
| `lib/ssh.ts:1552-1577` | 1, 2 | MODIFY | `buildOpenClawConfig()` — proxy profile + chrome profile |
| `lib/ssh.ts:1876-2014` | 1 | MODIFY | `configureOpenClaw()` — proxy env var resolution |
| `lib/ssh.ts:2582-2619` | 1 | ADD AFTER | Proxy credential deployment to VM .env |
| `lib/ssh.ts:5618` | 2 | MODIFY | Caddyfile template — add `/relay/*` route |
| `lib/ssh.ts:1085` | 1, 2, 3 | MODIFY | `WORKSPACE_SOUL_MD` — proxy awareness, extension awareness, profile selection |
| `lib/agent-intelligence.ts:374` | 1, 2, 3 | MODIFY | `WORKSPACE_CAPABILITIES_MD` — proxy + extension capabilities |
| `skills/web-search-browser/SKILL.md:18-31` | 2 | MODIFY | Add Tier 4 (extension relay) to escalation model |
| `skills/web-search-browser/SKILL.md:338` | 1 | MODIFY | Tool Decision Matrix — proxy routing |
| `skills/web-search-browser/SKILL.md:356` | 1 | ADD AFTER | Proxy Routing section |
| `skills/web-search-browser/SKILL.md:397` | 1, 2 | MODIFY | Platform Access Status table |
| `app/(dashboard)/settings/page.tsx:608` | 2 | ADD AFTER | "Connect Your Browser" extension setup section |
| `app/(dashboard)/dashboard/page.tsx:779` | 2 | ADD AFTER | Extension connection status indicator |
| `app/(dashboard)/env-vars/page.tsx:23` | 1 | MODIFY | Add PROXY_HOST to suggestions list (for users bringing their own proxy) |

### 11.2 New Files

| File | Phase | Purpose |
|------|-------|---------|
| `instaclaw-chrome-extension/manifest.json` | 2 | Forked + modified extension manifest |
| `instaclaw-chrome-extension/background.js` | 2 | Forked + modified service worker |
| `instaclaw-chrome-extension/background-utils.js` | 2 | HMAC derivation (unchanged from upstream) |
| `instaclaw-chrome-extension/options.html` | 2 | Modified options page (Gateway URL input) |
| `instaclaw-chrome-extension/options.js` | 2 | Modified options logic |
| `app/api/vm/extension-status/route.ts` | 2 | Check if extension is connected to VM's relay |

### 11.3 Files NOT Changed

| File | Reason |
|------|--------|
| `lib/ssh.ts` — `restartGateway()` (line 5696) | Proxy config persists across restarts via openclaw.json |
| `lib/ssh.ts` — `killStaleBrowser()` (line 4756) | Chrome cleanup logic unchanged — kills by process, not by profile |
| `lib/ssh.ts` — `telegram-pre-start.sh` (line 3389) | Unrelated to browser capability |
| `app/api/cron/health-check/route.ts` | Health check logic unchanged — checks gateway, not browser profiles |
| `skills/web-search-browser/assets/crawlee-scrape.py` | Crawlee stays as Tier 3.5, unchanged |
| OpenClaw gateway core (`extension-relay.ts`) | Zero changes to relay server — Caddy handles the network bridging |

---

## 12. Timeline

| Phase | Scope | Effort | Ship Target |
|-------|-------|--------|-------------|
| **Phase 1** | Residential proxy | 2-3 days dev + 1-2 days testing | Week 1 (March 17-21) |
| **Phase 2** | Chrome extension relay | 2-3 weeks dev + 1 week testing | Month 1 (April 11) |
| **Phase 3** | Smart browser mode switching | 1 week dev | Month 2 (April 25) |

**Phase 1 can ship this week.** It's one Chrome flag, one env var deployment, one SKILL.md update, and one fleet patch. The proxy provider signup takes 10 minutes.

**Phase 2 is the big one.** Forking the extension, building the dashboard UI, Chrome Web Store submission, and end-to-end testing across multiple VMs. Caddy config change is trivial but needs careful fleet rollout.

**Phase 3 is a SKILL.md + SOUL.md change.** Once Phases 1 and 2 are deployed, the agent just needs instructions on when to use each profile. No new infrastructure.

---

## Appendix A: Residential Proxy Provider Comparison

| Provider | $/GB | Min Commitment | IP Pool | API Quality | Geo-Targeting | Notes |
|----------|------|----------------|---------|-------------|---------------|-------|
| **Smartproxy** | $7.00 | $75/mo | 55M+ | Good | Country, state, city | Best value at our scale. Recommended for Phase 1. |
| **IPRoyal** | $5.50 | Pay-as-you-go | 8M+ | OK | Country, state | Cheapest. Good for testing. Small pool may cause blocks. |
| **Bright Data** | $8.40 | $500/mo | 72M+ | Best | Country, state, city, ASN | Largest network. Overkill for Phase 1. Consider for scale. |
| **Oxylabs** | $8.00 | $300/mo | 100M+ | Excellent | Country, state, city | Enterprise-grade. Consider if Smartproxy has reliability issues. |
| **SOAX** | $6.99 | $99/mo | 30M+ | Good | Country, state | Flexible targeting. Decent middle ground. |
| **NetNut** | $6.00 | $300/mo | 20M+ | Good | Country, state | ISP proxies (static residential). Good for LinkedIn scraping. |
| **Infatica** | $8.00 | $96/mo | 15M+ | OK | Country | Mobile proxies available. Niche use cases. |

**Recommendation:** Start with **Smartproxy** ($75/mo, 10 GB included). If reliability issues arise, upgrade to **Bright Data** or **Oxylabs**.

---

## Appendix B: OpenClaw Extension Relay Protocol Reference

### WebSocket Messages (Extension ↔ Relay)

```
Extension → Relay:
  { method: "forwardCDPEvent", params: { method, params, sessionId } }  // CDP events from tabs
  { id: N, result: {...} }                                               // Command responses
  { method: "pong" }                                                     // Keepalive response

Relay → Extension:
  { id: N, method: "forwardCDPCommand", params: { method, params, sessionId } }  // CDP commands
  { method: "ping" }                                                              // Keepalive (5s interval)
```

### HMAC Token Derivation

```javascript
async function deriveRelayToken(gatewayToken, port) {
  const key = await crypto.subtle.importKey(
    'raw',
    encode(gatewayToken),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    encode(`openclaw-extension-relay-v1:${port}`)
  );
  return hexEncode(sig);
}
// WebSocket URL: wss://{gatewayUrl}/relay/extension?token={hmacHex}
```

### Gateway Handshake

```json
{
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": { "id": "instaclaw-browser-relay", "version": "1.0.0" },
    "role": "operator",
    "scopes": ["operator.read", "operator.write"],
    "auth": { "token": "<gatewayToken>" }
  }
}
```

### Relay Server Endpoints

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `HEAD /` | No | Health check (200) |
| `GET /extension/status` | No | `{ connected: boolean }` |
| `GET /json/version` | Yes | CDP version info |
| `GET /json/list` | Yes | Connected targets |
| `WS /extension` | Yes | Extension connects here |
| `WS /cdp` | Yes | CDP clients connect here |

---

## Appendix C: Chrome Extension Manifest (Our Fork)

```json
{
  "manifest_version": 3,
  "name": "InstaClaw Browser Relay",
  "version": "1.0.0",
  "description": "Connect Chrome to your InstaClaw agent for browsing with your logged-in sessions",
  "permissions": [
    "debugger",
    "tabs",
    "activeTab",
    "storage",
    "alarms",
    "webNavigation"
  ],
  "host_permissions": [
    "https://*.vm.instaclaw.io/*"
  ],
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "action": {
    "default_title": "InstaClaw Browser Relay"
  },
  "options_ui": {
    "page": "options.html",
    "open_in_tab": true
  },
  "icons": {
    "16": "icons/icon-16.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  }
}
```
