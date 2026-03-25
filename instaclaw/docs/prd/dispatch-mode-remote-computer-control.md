# PRD: Dispatch Mode — Remote Computer Control

**Author:** Claude (Opus 4.6) + Cooper Wrenn
**Date:** 2026-03-24
**Status:** Phase 0 COMPLETE on vm-050 (canary)
**Priority:** P1

---

## 1. Executive Summary

### The Problem

InstaClaw agents live on dedicated Linux VMs 24/7. They can browse the web, trade on Polymarket, post on X, manage crypto wallets — but only through CLI tools and headless browser automation. They cannot:

1. **Control desktop applications** — trading terminals, IDEs, design tools, spreadsheets
2. **Interact with the user's personal computer** — the agent knows the user's full context (preferences, portfolio, schedule) but can't act on their behalf on their own machine
3. **Handle sites that detect headless Chrome** — sophisticated anti-bot systems (Polymarket CLOB, some banking sites) fingerprint headless browsers

Competitors are shipping computer-use features: Anthropic's Computer Use API, OpenAI Operator, Manus AI (cloud VMs with full desktops). InstaClaw agents are uniquely positioned to offer something none of them have: **an always-on agent that already knows you, controlling your computer when you need it**.

### What We're Building

**Dispatch Mode** — two products in one:

1. **Server-side** (Phase 1): Agent controls its own VM desktop via Xvfb + usecomputer. Enables autonomous 24/7 workflows with full GUI access.
2. **Client-side** (Phase 2): Agent controls the user's personal Mac/PC remotely via a local relay app. The "remote dispatch" feature — agent lives on its server but can reach into the user's desktop when needed.

### Key Constraint

Our VMs are 1GB Nanodes running Ubuntu. RAM is extremely tight (~630-1100MB used currently). Server-side desktop control adds ~25-35MB (Xvfb + WM), which is feasible, but switching Chrome to headed mode adds another ~50-100MB, which pushes us into heavy swap territory. Phase 1 must be RAM-conscious.

---

## 2. Industry Research

### 2.1 How Competitors Handle Computer Use

| Product | Architecture | Scope | User's Computer? | Latency/Action | Cost/Action |
|---------|-------------|-------|-------------------|-----------------|-------------|
| **Anthropic Computer Use** | API tool — model returns actions, dev executes | Full desktop | Dev's choice (local or cloud VM) | 3-10s (inc. 2s screenshot delay) | ~$0.003/screenshot |
| **OpenAI Operator** | Hosted Chromium on OpenAI servers | Browser only | No — sandboxed cloud browser | 3-8s | Included in $200/mo sub |
| **OpenAI CUA API** | API tool — same as Anthropic pattern | Full desktop or browser | Dev's choice | 3-8s | ~$0.003-0.004/screenshot |
| **Manus AI** | Firecracker microVM per task (via E2B) | Full Linux desktop | No — ephemeral cloud VM | Low (colocated) | ~$0.10-0.50/task |
| **Open Interpreter** | Local execution, LLM generates code | Full desktop | Yes — runs directly | 1-5s | Model-dependent |
| **Google Project Mariner** | Chrome extension + cloud reasoning | Browser tabs only | Hybrid (extension local, reasoning cloud) | Unknown | Google AI Ultra sub |
| **Browser-Use** (OSS) | Python + Playwright | Browser only | Yes (local) or cloud | 2-5s | Model-dependent |

### 2.2 Key Lessons

1. **Nobody has cracked safe remote control of a user's personal desktop.** Operator and Mariner dodge it (sandboxed browsers). Manus dodges it (cloud VMs). Anthropic/OpenAI APIs leave it to developers. Open Interpreter does it with minimal safety. This is greenfield.

2. **The screenshot→reason→act loop is universal.** Every implementation follows the same pattern: capture screen → send to vision model → model returns coordinates/actions → execute → repeat. The only variables are resolution, format, and coordinate mapping.

3. **Anthropic recommends 1024x768 for best accuracy.** Their reference implementation scales screenshots to XGA. Token cost at this resolution: ~1,049 tokens/screenshot (~$0.003 at Sonnet pricing). A 20-step task costs ~$0.15-0.30.

4. **Manus's "CodeAct" approach is interesting** — instead of pixel-level click/type, the model writes executable Python as its action mechanism. This is faster and more reliable for structured tasks but doesn't work for arbitrary GUI interaction.

5. **Claude Desktop (Anthropic's own product) has the best UX model for user consent:**
   - Off by default, opt-in per session
   - Tiered access: view-only for browsers, click-only for terminals, full control for other apps
   - Visible activity indicator (hidden windows shown)
   - Per-app permission scoping

*Sources: [Anthropic Computer Use Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool), [Anthropic Reference Implementation](https://github.com/anthropics/anthropic-quickstarts/tree/main/computer-use-demo), [OpenAI CUA API](https://developers.openai.com/api/docs/guides/tools-computer-use), [Manus + E2B Architecture](https://e2b.dev/blog/how-manus-uses-e2b-to-provide-agents-with-virtual-computers), [Manus Deep Dive](https://hackmd.io/@emfs/Bki8EIAo1l)*

### 2.3 usecomputer Technical Analysis

`usecomputer` (github.com/remorses/kimaki) is a Zig-based desktop automation tool that provides the execution layer we need. Key findings from source code analysis:

| Aspect | Detail |
|--------|--------|
| **What it is** | CLI + Node.js N-API library for mouse, keyboard, screenshot, clipboard, window management |
| **Linux implementation** | X11/Xlib/XTest/XShm — requires `DISPLAY` env var |
| **macOS implementation** | CoreGraphics/CoreFoundation — requires Accessibility + Screen Recording permissions |
| **Screenshot scaling** | Auto-scales to max 1568px long edge (close to Anthropic's recommended 1024x768) |
| **Coordinate mapping** | coordMap string maps screenshot pixels ↔ desktop coordinates, handles multi-monitor and HiDPI |
| **Install** | `npm i -g usecomputer` — prebuilt binaries for linux-x64, darwin-arm64, darwin-x64 |
| **Dependencies** | Runtime: only `zod`. System (Linux): `libX11`, `libXext`, `libXtst`, `libpng` |
| **Networking** | **None.** Purely local. No HTTP/WebSocket/MCP server. |
| **Auth/security** | **None.** Relies on OS-level permissions. |
| **Clipboard** | **Not implemented** on any platform (returns NOT_SUPPORTED) |
| **Linux typing** | **ASCII only** — returns error for bytes ≥ 0x80 (significant limitation) |
| **macOS secure input** | **Not handled** — keyboard events silently fail on password fields |
| **Package size** | ~10-15MB with all platform binaries |

**Critical limitation for client-side:** usecomputer has zero remote capabilities. We must build the entire relay infrastructure ourselves.

**Critical limitation for Linux:** usecomputer `type` command cannot handle spaces (0x20) or non-ASCII characters — throws `UnknownKey` error. **Workaround: use `xdotool type` instead** (installed as part of Phase 0). dispatch-type.sh uses xdotool.

---

## 3. Architecture

### 3.1 Overview

```
Phase 1 (Server-Side):
┌─────────────────────────────────────┐
│ VM (Linode Nanode)                   │
│                                      │
│  [OpenClaw Gateway]                  │
│       ↕ (tool calls)                 │
│  [dispatch-local.sh]                 │
│       ↕ (usecomputer CLI)            │
│  [Xvfb :99 @ 1280x720]             │
│       ↕ (X11)                        │
│  [Chromium / Desktop Apps]           │
└─────────────────────────────────────┘

Phase 2 (Client-Side):
┌──────────────────┐         ┌─────────────────────────────────┐
│ User's Mac/PC     │   WSS   │ VM (Linode)                     │
│                    │◄───────►│                                  │
│ [@instaclaw/       │         │ [OpenClaw Gateway]               │
│  dispatch]         │         │      ↕ (tool calls)              │
│    ↕ (usecomputer) │         │ [dispatch-remote.sh]             │
│ [macOS Desktop]    │         │      ↕ (WebSocket client)        │
│                    │         │ [dispatch-ws-server]              │
└──────────────────┘         └─────────────────────────────────┘

Connection direction: User's machine (outbound WSS) → VM (public IP)
```

### 3.2 Phase 1: Server-Side Desktop Control

**Goal:** Agent can control a full GUI desktop on its own VM.

**Components:**

1. **Xvfb virtual framebuffer** — `Xvfb :99 -screen 0 1280x720x24 -ac`
   - RAM: ~15-25MB
   - Disk: ~2-3MB install
   - No window manager needed (Chromium runs fine without one)
   - Resolution: 1280x720 (good balance of detail vs screenshot size)

2. **usecomputer** — installed globally via npm
   - Used as CLI: `DISPLAY=:99 usecomputer screenshot /tmp/screen.png`
   - System deps: `apt install libx11-dev libxext-dev libxtst-dev libpng-dev`

3. **Dispatch scripts** — shell scripts in `~/scripts/` that the agent calls:
   - `dispatch-screenshot.sh` → captures screen, outputs base64 PNG
   - `dispatch-click.sh x y` → clicks at coordinates
   - `dispatch-type.sh "text"` → types text
   - `dispatch-press.sh "ctrl+c"` → presses key combo
   - `dispatch-scroll.sh up 3` → scrolls
   - `dispatch-windows.sh` → lists open windows (JSON)

4. **SKILL.md** — teaches the agent the screenshot→reason→act loop

**RAM budget on 1GB Nanode (Phase 1):**

| Process | Current | With Dispatch |
|---------|---------|---------------|
| OS + systemd | ~100MB | ~100MB |
| OpenClaw gateway | ~300MB | ~300MB |
| Chromium (headless) | ~400MB | ~400MB (keep headless) |
| Xvfb | 0 | ~20MB |
| Agent scripts | ~40MB | ~40MB |
| **Total** | ~840MB | ~860MB |

**Decision: Keep Chrome headless.** Xvfb is for non-browser GUI apps (terminal automation, file management, future desktop apps). Chrome continues using CDP for web tasks — it's faster, cheaper, and more reliable. The agent uses dispatch mode only when it needs GUI control that CDP can't provide.

### 3.3 Phase 2: Client-Side Remote Control

**Goal:** Agent controls the user's personal Mac/PC remotely.

**Components:**

#### 3.3.1 Local Relay App (`@instaclaw/dispatch`)

A Node.js CLI tool the user installs:

```bash
npm i -g @instaclaw/dispatch
instaclaw-dispatch          # First run: prompts for gateway token + VM IP
```

**What it does:**
1. Prompts for gateway token (pairs to their agent's VM)
2. Detects OS and checks permissions (Accessibility + Screen Recording on macOS)
3. Opens outbound WSS connection to the VM's dispatch server
4. Authenticates with gateway token via HMAC handshake
5. Listens for commands from the agent
6. Executes each command via `usecomputer` Node.js API
7. Returns results (screenshots as binary JPEG, action confirmations as JSON)
8. Auto-reconnects on connection loss (exponential backoff 1s→30s)

**Trust modes:**
- `supervised` (default): Before each action, prints what the agent wants to do. User presses Enter to approve or `n` to deny. Screenshot-only commands are auto-approved.
- `autonomous`: Agent acts freely. For power users who trust their agent.
- User can switch modes at runtime via keyboard command.

**Kill switch:** Ctrl+C immediately terminates the WebSocket connection and all pending actions. The agent is notified that dispatch mode was disconnected.

#### 3.3.2 VM-Side Dispatch Server

A lightweight WebSocket server running on the agent's VM:

- **Library:** `ws` (Node.js) — minimal overhead, binary frame support, battle-tested
- **Port:** 8765 (configurable)
- **TLS:** Self-signed cert initially; later, Let's Encrypt via `vm-XXX.dispatch.instaclaw.io` subdomains
- **Authentication:** Gateway token validated during WebSocket upgrade handshake

**Protocol:**

```
Command (VM → Local):
{
  "id": "cmd_a1b2c3",
  "type": "screenshot" | "click" | "type" | "press" | "scroll" | "drag" | "windows",
  "params": { ... },
  "description": "Taking a screenshot to see what's on your screen"  // For supervised mode
}

Response (Local → VM):
{
  "id": "cmd_a1b2c3",
  "type": "result",
  "success": true,
  "data": { ... }  // Action-specific response data
}

Screenshot Response (Local → VM):
Frame 1 (text): { "id": "cmd_a1b2c3", "type": "screenshot_result", "width": 1280, "height": 720, "format": "jpeg", "size": 187432, "coordMap": "0,0,1440,900,1280,720" }
Frame 2 (binary): <raw JPEG bytes>
```

Screenshots sent as JPEG at 80% quality (100-300KB) instead of PNG (500KB-2MB). For AI vision, JPEG at 80% is indistinguishable from lossless and reduces bandwidth 5-10x.

#### 3.3.3 Agent-Side Dispatch Scripts

Shell scripts in `~/scripts/` that the OpenClaw agent calls to control the user's computer:

```bash
# Take screenshot of user's screen
dispatch-remote-screenshot.sh
# Returns: base64-encoded JPEG + coordMap as JSON

# Click at coordinates on user's screen
dispatch-remote-click.sh 500 300
# Coordinates are in screenshot-space; coordMap handles mapping

# Type text on user's screen
dispatch-remote-type.sh "Hello world"

# Press key combo on user's screen
dispatch-remote-press.sh "cmd+s"

# Check if dispatch is connected
dispatch-remote-status.sh
# Returns: { "connected": true, "mode": "supervised", "os": "darwin", "lastSeen": "2026-03-24T..." }
```

Each script communicates with the local VM dispatch server via a Unix socket or localhost HTTP endpoint, which then relays to the user's machine via WebSocket.

#### 3.3.4 Dispatch Skill (SKILL.md)

Teaches the agent how to use dispatch mode. Key sections:

1. **When to use dispatch vs. browser tool** — dispatch for non-browser apps, authenticated sites, or when the user explicitly asks the agent to "do something on my computer"
2. **The screenshot→reason→act loop** — step-by-step pattern
3. **Coordinate system** — how coordMap works, always use it
4. **Supervised mode etiquette** — describe actions clearly, don't spam commands
5. **Error recovery** — if a click doesn't produce the expected result, take another screenshot and reassess
6. **Rate limits** — max 1 command/second, max 60 screenshots/minute
7. **What NOT to do** — never interact with password fields, never click "Delete" or "Format" without explicit confirmation, never access banking/financial apps unless the user specifically requested it

---

## 4. Security Model

### 4.1 Authentication

| Layer | Mechanism | Purpose |
|-------|-----------|---------|
| **WebSocket handshake** | Gateway token as bearer + HMAC(token, timestamp, nonce) | Prevents unauthorized connections |
| **Timestamp validation** | Reject handshakes with ts > 30s old | Prevents replay attacks |
| **Nonce tracking** | Server stores seen nonces for 60s | Prevents replay of valid handshakes |
| **TLS** | WSS (WebSocket over TLS) | Encrypts all data in transit |
| **Single connection** | Server accepts only 1 concurrent connection per gateway token | Prevents session hijacking |

### 4.2 Trust Boundaries

```
ZONE 1: User's Machine (highest trust required)
├── usecomputer has FULL mouse/keyboard/screenshot access
├── Accessibility permission grants this to Terminal.app (macOS)
├── All commands run with user's OS privileges
└── Kill switch: Ctrl+C immediately terminates everything

ZONE 2: Network (encrypted tunnel)
├── WSS connection (TLS 1.3)
├── Gateway token authentication
├── Binary screenshot data never touches third parties
└── No central relay server — direct VM ↔ user machine

ZONE 3: Agent's VM (moderate trust)
├── Agent decides what actions to take
├── Rate-limited to 1 command/second
├── SKILL.md prohibits dangerous actions
└── Dispatch scripts validate commands before sending
```

### 4.3 macOS Permission Model

**The "responsible process" problem:** When the user runs `instaclaw-dispatch` in Terminal.app, macOS attributes the Accessibility permission to Terminal.app — not to Node.js or our CLI. This means granting permission to our tool also grants it to every command run in that terminal.

**Mitigation options (ordered by effort):**

1. **Accept it** (Phase 2 MVP) — Document that the user grants Accessibility to their terminal. Most developers already have this enabled. Simple, no extra build step.

2. **Electron wrapper** (Phase 2.5) — Wrap the relay in a minimal Electron app. macOS scopes permission to the .app bundle. Better isolation, but adds ~150MB download size and build complexity.

3. **Native Swift wrapper** (Phase 3) — Tiny native macOS app that embeds the Node.js relay. Smallest footprint, best permission scoping, most build effort.

**Required macOS permissions:**

| Permission | Needed For | How to Grant | Persists? |
|------------|-----------|-------------|-----------|
| Accessibility | Mouse/keyboard synthesis | System Settings → Privacy → Accessibility → add Terminal.app | Yes, across reboots |
| Screen Recording | Screenshots via CoreGraphics | System Settings → Privacy → Screen Recording → add Terminal.app | Yes, but **Sequoia re-prompts monthly** |

**Onboarding UX:**

```
$ instaclaw-dispatch

🤠 InstaClaw Dispatch — Remote Computer Control

Checking permissions...
  ✗ Accessibility: NOT GRANTED
  ✗ Screen Recording: NOT GRANTED

To grant permissions:
  1. Open System Settings → Privacy & Security → Accessibility
  2. Click the + button and add Terminal.app (or iTerm, Warp, etc.)
  3. Repeat for Privacy & Security → Screen Recording

Press Enter after granting permissions to continue...
[user grants permissions]

  ✓ Accessibility: GRANTED
  ✓ Screen Recording: GRANTED

Enter your gateway token: ████████████████
Enter your VM address (e.g., vm-050.instaclaw.io): vm-050.instaclaw.io

Connecting to your agent...
  ✓ Connected to Richie on vm-050

Dispatch mode: SUPERVISED (agent will ask before each action)
  Press 'a' to switch to autonomous mode
  Press Ctrl+C to disconnect at any time

Waiting for agent commands...
```

### 4.4 Windows Considerations

Windows is dramatically simpler for permissions:
- `SendInput()` for keyboard/mouse requires no special permissions
- Screenshots via `BitBlt` / `PrintWindow` require no permissions
- UAC only matters if controlling an elevated (admin) process
- No monthly re-prompts
- Background persistence via Task Scheduler or startup folder

### 4.5 Dangerous Action Protections

Even in `autonomous` mode, certain actions should require explicit user confirmation:

| Action Category | Examples | Behavior |
|-----------------|---------|----------|
| **Destructive** | Delete, Format, Empty Trash | Always prompt, even in autonomous mode |
| **Financial** | Submit order, Confirm payment, Transfer funds | Always prompt |
| **Authentication** | Enter password, Approve 2FA | Always prompt |
| **System** | Shut down, Restart, Install software | Always prompt |
| **Normal** | Click, type, scroll, navigate | Prompt in supervised, auto in autonomous |
| **Passive** | Screenshot, window list | Always auto-approve |

The agent's SKILL.md encodes these rules. The local relay also maintains a blocklist of dangerous coordinates/text patterns as a second line of defense.

---

## 5. Technical Specification

### 5.1 Local Relay App (`@instaclaw/dispatch`)

**Package structure:**
```
packages/dispatch/
├── package.json            # @instaclaw/dispatch
├── tsconfig.json
├── bin/
│   └── instaclaw-dispatch  # Entry point (#!/usr/bin/env node)
├── src/
│   ├── index.ts            # CLI entry — args, onboarding, main loop
│   ├── auth.ts             # Token storage, HMAC handshake
│   ├── connection.ts       # WebSocket client, reconnection, heartbeat
│   ├── executor.ts         # Receives commands, calls usecomputer, returns results
│   ├── permissions.ts      # OS permission detection + guidance
│   ├── supervisor.ts       # Supervised mode — prompt user for approval
│   ├── screenshot.ts       # Screenshot capture + JPEG encoding + coordMap
│   ├── config.ts           # Persisted config (~/.instaclaw-dispatch/config.json)
│   └── types.ts            # Shared types
└── README.md
```

**Dependencies:**
```json
{
  "dependencies": {
    "usecomputer": "^0.1.2",
    "ws": "^8.18.0",
    "sharp": "^0.33.0",       // PNG→JPEG conversion (usecomputer only outputs PNG)
    "chalk": "^5.3.0",        // Terminal colors for UX
    "inquirer": "^9.2.0"      // Interactive prompts (onboarding)
  }
}
```

**Config file** (`~/.instaclaw-dispatch/config.json`):
```json
{
  "gatewayToken": "gw_...",
  "vmAddress": "vm-050.instaclaw.io",
  "port": 8765,
  "mode": "supervised",
  "screenshotFormat": "jpeg",
  "screenshotQuality": 80,
  "maxActionsPerMinute": 60
}
```

### 5.2 VM-Side Dispatch Server

**New systemd service:** `dispatch-server.service`
```ini
[Unit]
Description=InstaClaw Dispatch WebSocket Server
After=network.target

[Service]
Type=simple
ExecStart=/home/openclaw/.nvm/versions/node/v22.22.0/bin/node /home/openclaw/scripts/dispatch-server.js
Environment=DISPLAY=:99
Environment=GATEWAY_TOKEN=%GATEWAY_TOKEN%
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

**Server implementation** (`~/scripts/dispatch-server.js`):

Core logic (~200 lines):
1. Start WSS server on port 8765
2. On connection: validate gateway token via HMAC handshake
3. Accept only 1 concurrent connection
4. Expose local Unix socket at `/tmp/dispatch.sock` for agent scripts
5. Bridge: agent script → Unix socket → dispatch server → WebSocket → local relay → usecomputer → result → reverse path
6. Heartbeat ping/pong every 25 seconds
7. Log all commands for audit trail

### 5.3 Agent Dispatch Scripts

**`dispatch-remote-screenshot.sh`** (~30 lines):
```bash
#!/bin/bash
# Send screenshot request to dispatch server via Unix socket
RESPONSE=$(echo '{"type":"screenshot","params":{"format":"jpeg","quality":80}}' | \
  socat - UNIX-CONNECT:/tmp/dispatch.sock)

# Extract coordMap and base64 image from response
COORD_MAP=$(echo "$RESPONSE" | jq -r '.coordMap')
IMAGE_B64=$(echo "$RESPONSE" | jq -r '.image')

# Save screenshot for the agent to view
echo "$IMAGE_B64" | base64 -d > /tmp/dispatch-screenshot.jpg

# Output JSON for the agent
echo "{\"path\":\"/tmp/dispatch-screenshot.jpg\",\"coordMap\":\"$COORD_MAP\"}"
```

**`dispatch-remote-click.sh`** (~15 lines):
```bash
#!/bin/bash
X=$1; Y=$2
echo "{\"type\":\"click\",\"params\":{\"x\":$X,\"y\":$Y}}" | \
  socat - UNIX-CONNECT:/tmp/dispatch.sock
```

Similar scripts for `type`, `press`, `scroll`, `drag`, `windows`, `status`.

### 5.4 SKILL.md Structure

```markdown
---
name: computer-dispatch
description: "Control a remote computer (user's Mac/PC or VM desktop) via screenshots and mouse/keyboard"
metadata:
  triggers:
    keywords: [dispatch, computer, desktop, screen, click, remote, control]
    phrases: ["do this on my computer", "open the app", "click on", "take a screenshot of my screen"]
    NOT: [browser, web, search, navigate]
---

# Computer Dispatch Skill

## When to Use This Skill
- User asks you to do something on THEIR computer (not the web)
- You need to interact with a desktop application
- You need to handle a UI that the browser tool can't reach
- User says "on my screen", "on my desktop", "open [app name]"

## When NOT to Use This
- Regular web browsing → use the browser tool (faster, cheaper)
- ...

## The Screenshot → Reason → Act Loop
1. Take a screenshot: `bash ~/scripts/dispatch-remote-screenshot.sh`
2. Analyze the screenshot — identify what's on screen
3. Decide your next action — what to click/type to make progress
4. Describe what you're about to do (supervised mode shows this to the user)
5. Execute: `bash ~/scripts/dispatch-remote-click.sh <x> <y>`
6. Wait 500ms for the screen to update
7. Take another screenshot to verify
8. Repeat until the task is done

## Coordinate System
- Screenshots are auto-scaled. Always use the coordMap from the screenshot response.
- Coordinates in dispatch-remote-click.sh are in SCREENSHOT pixel space.
- The coordMap handles mapping to real desktop coordinates.

## Rate Limits
- Max 1 command per second
- Max 60 screenshots per minute
- If the user is in supervised mode, wait for their approval

## Safety Rules (NEVER VIOLATE)
1. NEVER type into password/credential fields
2. NEVER click Delete/Format/Empty Trash without explicit user confirmation
3. NEVER interact with banking or financial apps unless the user specifically requested it
4. NEVER submit payment forms or purchase confirmations without user approval
5. If unsure what's on screen, take a screenshot and describe it to the user before acting
6. If an action doesn't produce the expected result, STOP and reassess — don't retry blindly

## Error Handling
- If dispatch is disconnected: tell the user and stop
- If a command times out (>10s): take a screenshot, reassess
- If the screen looks wrong after an action: describe what you see, ask the user
```

### 5.5 Performance Expectations

| Metric | Server-Side (Phase 1) | Client-Side (Phase 2) |
|--------|----------------------|----------------------|
| Screenshot capture | ~50-200ms (Xvfb + XShm) | ~10-50ms (macOS CoreGraphics) |
| Screenshot encode (JPEG 80%) | ~20-50ms | ~20-50ms |
| Screenshot transfer | N/A (local) | ~20-100ms (200KB over internet) |
| Command execution | ~5-20ms | ~5-20ms |
| **Total per action** | ~75-270ms | ~55-220ms |
| **+ LLM reasoning** | +1-5s (Sonnet/Opus vision) | +1-5s |
| **End-to-end per step** | ~1.5-5.5s | ~1.5-5.5s |
| **Token cost per screenshot** | ~1,049 tokens (~$0.003) | ~1,049 tokens (~$0.003) |
| **20-step task cost** | ~$0.06-0.30 | ~$0.06-0.30 |

LLM vision inference dominates latency — the transport and execution layers are fast.

---

## 6. Comparison: Dispatch Mode vs. Existing Chrome Extension Relay

| Aspect | Chrome Extension Relay | Dispatch Mode (Client-Side) |
|--------|----------------------|---------------------------|
| **Scope** | Browser tabs only | Entire desktop |
| **Install** | Chrome Web Store extension | `npm i -g @instaclaw/dispatch` |
| **Permissions** | Chrome extension permissions | OS Accessibility + Screen Recording |
| **Auth** | Extension ↔ gateway pairing | Gateway token via WebSocket |
| **Protocol** | CDP commands via WebSocket | usecomputer commands via WebSocket |
| **Can control** | Web pages in Chrome | Any app, any window, full desktop |
| **User comfort** | Medium (limited to browser) | Lower initially (full desktop access) |
| **Anti-bot detection** | Still Chrome + CDP | Native input events (harder to detect) |
| **Existing users** | Already using it | New feature — adoption required |
| **Replaces relay?** | — | **No.** Relay is better for pure web tasks (direct DOM access vs. pixel-level vision) |

**Verdict:** Dispatch Mode does NOT replace the Chrome Extension Relay. The relay is superior for web-only tasks (faster, cheaper, more reliable via DOM access). Dispatch Mode complements it by adding desktop app control and serving as a fallback for sites that block CDP.

The agent's SKILL.md should teach it when to use each:
- **Web task, normal site** → browser tool (CDP, headless)
- **Web task, authenticated site** → Chrome Extension Relay
- **Web task, anti-bot site** → Dispatch Mode (native events bypass detection)
- **Desktop app** → Dispatch Mode
- **User asks "on my computer"** → Dispatch Mode

---

## 7. Phased Rollout

### Phase 0: Foundation (Week 1) — COMPLETE (2026-03-24)
- [x] Install Xvfb on canary VM (vm-050) — test with `DISPLAY=:99`
- [x] Install usecomputer on vm-050 — verify `usecomputer screenshot` works with Xvfb
- [x] Write dispatch-screenshot.sh, dispatch-click.sh, dispatch-type.sh, dispatch-press.sh, dispatch-scroll.sh
- [x] Write computer-dispatch/SKILL.md (server-side only)
- [x] Test: screenshot→click→type→verify loop works end-to-end on xterm
- [x] Measure RAM impact on vm-050
- [x] Set up Xvfb as systemd service (auto-start on boot)
- [x] Install xdotool as fallback for typing (usecomputer type can't handle spaces on Linux)

**Phase 0 Results (vm-050 @ 172.239.36.76):**
- **VM RAM**: 4GB (not 1GB as assumed — Linode Nanode 4GB)
- **RAM before**: 916 MB used / 3915 MB total
- **RAM after**: 989 MB used (+73 MB including apt cache, xterm, xdotool)
- **Xvfb RSS**: ~20 MB
- **Display**: 1280x720x24 on DISPLAY=:99
- **Screenshot**: Works — returns JSON with coordMap, captures full desktop
- **Click**: Works — usecomputer click X,Y
- **Type**: `usecomputer type` BROKEN on Linux for text with spaces (UnknownKey error for 0x20). **Workaround: `xdotool type`** works perfectly.
- **Press**: Works — usecomputer press Return/Tab/ctrl+c/etc.
- **Systemd service**: `xvfb.service` enabled, auto-restarts on failure
- **Deployed scripts**: dispatch-screenshot.sh, dispatch-click.sh, dispatch-type.sh (xdotool), dispatch-press.sh, dispatch-scroll.sh
- **Deployed skill**: `~/.openclaw/agents/main/agent/skills/computer-dispatch/SKILL.md`
- **NEXT**: Restart gateway so agent picks up the new skill, then test via Telegram

### Phase 1: Server-Side Fleet Deployment (Week 2-3) — COMPLETE (2026-03-25)
- [x] Deploy dispatch scripts to fleet via fleet-push (dispatch-fleet-push-v2.sh — single SCP + single SSH per VM)
- [x] Deploy computer-dispatch/SKILL.md + updated web-search-browser/SKILL.md to fleet
- [x] Deploy SOUL.md with MANDATORY dispatch-browser instructions to fleet
- [x] Canary (vm-313) → 5 VMs → full fleet (196 VMs)
- [x] Add Xvfb + usecomputer to configureOpenClaw() (baked into provisioning for new VMs)
- [ ] ~~Add `dispatch-server.service` systemd unit~~ — SKIPPED (not needed until Phase 2 client-side relay)
- [x] Monitor: RAM fine on all VMs (all 4GB Nanodes with ~3GB headroom)

**Phase 1 Results:**
- **Fleet deployment**: 196/196 VMs (100%) — 152 succeeded immediately, 37 needed gateway restart (5s health check timeout), 7 needed longer SSH timeout, 1 (vm-340) had pre-existing broken OpenClaw install (fixed: reinstalled to v2026.3.23)
- **RAM audit**: All assigned VMs are 4GB Nanodes (3915-3916MB total). No 1GB Nanodes in fleet. Dispatch adds ~30MB (Xvfb + openbox), stealth Chrome adds ~700-1100MB when running.
- **Stealth Chrome**: dispatch-browser.sh with `--disable-blink-features=AutomationControlled`, spoofed user-agent, and a Manifest V3 content_scripts extension that patches navigator.webdriver, plugins, WebGL renderer, permissions, chrome.runtime, and screen dimensions. Bypasses Cloudflare on DexScreener, CoinGecko, etc.
- **Openbox window manager**: Installed fleet-wide. Auto-sizes windows to fill 1280x720 display. xterm screenshots went from tiny corner box to full-screen.
- **dispatch-screenshot.sh**: Outputs JPEG (80% quality via ImageMagick), saves to `~/.openclaw/workspace/` for deliver_file.sh compatibility.
- **SOUL.md routing battle**: The `web-search-browser/SKILL.md` (329 lines) was overriding SOUL.md dispatch instructions. The agent kept using the headless browser tool which gets Cloudflare-blocked. Fixed by: (1) adding Tier 3.6 Dispatch Browser to web-search-browser SKILL.md, (2) updating its Tool Decision Matrix to route screenshots/Cloudflare sites to dispatch, (3) adding MANDATORY section at top of SOUL.md, (4) removing `NOT: [browser, web, url]` from computer-dispatch SKILL.md triggers that was suppressing dispatch for web requests.
- **Skipped**: dispatch-server.service (WebSocket relay for Phase 2 client-side) — not needed for server-side dispatch

### Phase 2: Client-Side MVP (Week 3-5)
- [ ] Build `@instaclaw/dispatch` local relay app
- [ ] Build VM-side WebSocket dispatch server (dispatch-server.js)
- [ ] Build remote dispatch scripts (dispatch-remote-*.sh)
- [ ] Update SKILL.md with remote dispatch instructions
- [ ] TLS: self-signed certs initially (user's relay trusts pinned cert)
- [ ] Test on Cooper's machine + vm-050 (Richie)
- [ ] Supervised mode only for MVP
- [ ] Publish `@instaclaw/dispatch` to npm (scoped under @instaclaw org)

### Phase 2.5: Polish & Security (Week 5-7)
- [ ] Add autonomous mode (behind confirmation prompt)
- [ ] Add dangerous action protections (financial, destructive, auth)
- [ ] Let's Encrypt certs via `vm-XXX.dispatch.instaclaw.io` subdomains
- [ ] Add audit logging (all commands logged with timestamps)
- [ ] Add connection status to instaclaw.io dashboard
- [ ] Windows support testing
- [ ] Onboarding wizard improvements based on user feedback

### Phase 3: Production & Scale (Week 7+)
- [ ] Native macOS wrapper (Electron or Swift) for better permission scoping
- [ ] Fleet-wide deployment of dispatch server
- [ ] Billing: dispatch mode actions counted against credits
- [ ] Analytics: track dispatch mode usage, success rates, failure modes
- [ ] User documentation on instaclaw.io
- [ ] Marketing: "Your agent can now control your computer"

---

## 8. Open Questions & Decisions Needed

### 8.1 Must Decide Before Building

1. **Port 8765 — is this safe to expose?** The VM firewall (ufw) currently allows only SSH (22) and the gateway port. We'd need to open 8765. Security implication: another attack surface on every VM, even for users who never use dispatch mode.
   - **Option A:** Always open port 8765, dispatch server always running. Simple, slightly wasteful.
   - **Option B:** Only start dispatch server and open port when user activates dispatch mode via dashboard. More secure, more complex.
   - **Recommendation:** Option B — dispatch should be opt-in.

2. **Screenshot format — JPEG or PNG?** usecomputer outputs PNG. We'd need `sharp` to convert to JPEG for bandwidth savings. This adds ~10MB to the relay app. Alternatively, we could send PNG and accept higher bandwidth.
   - **Recommendation:** JPEG via `sharp`. The 5-10x size reduction is worth the dependency.

3. **Anthropic Computer Use API vs. raw dispatch?** Instead of the agent calling dispatch scripts and then reasoning about screenshots in the normal conversation, we could use Anthropic's Computer Use tool API directly. This would give us their coordinate mapping, error recovery, and zoom features for free.
   - **Recommendation:** Use Anthropic's Computer Use API. It's purpose-built for this. The agent sends `computer_20251124` tool results, and Claude handles the rest. We just need to bridge the execution layer.

4. **Billing model for dispatch actions.** Each screenshot costs ~$0.003 in LLM tokens. A 20-step task costs ~$0.15-0.30. How do we charge?
   - **Option A:** Included in existing credit system (deducted from user's credits)
   - **Option B:** Separate dispatch credits (premium feature)
   - **Recommendation:** Option A for now — fold into existing credits. Revisit when usage data exists.

5. **Self-signed TLS vs. proper certs for Phase 2 MVP.** Let's Encrypt requires DNS records for each VM subdomain. Self-signed works but requires the relay app to trust unknown certs.
   - **Recommendation:** Self-signed for MVP with cert pinning. The relay stores the VM's cert fingerprint on first connection (TOFU — trust on first use, same as SSH). Proper certs in Phase 2.5.

### 8.2 Can Decide Later

- Electron/native wrapper for macOS permission scoping (Phase 3)
- Windows background service implementation (Phase 3)
- Central relay fallback for corporate firewalls that block non-standard ports (Phase 3)
- Multi-monitor support on user's machine (coordMap already handles it; UX needs work)
- VNC debug viewer for dispatch sessions (nice-to-have for support)

---

## 9. Non-Goals (Out of Scope)

1. **Replacing the Chrome Extension Relay** — Dispatch complements it, doesn't replace it.
2. **Streaming video of the user's screen** — We send static screenshots, not a live feed. This is computer use, not screen sharing.
3. **Mobile device control** — iOS/Android are out of scope. Desktop only.
4. **Multi-user dispatch** — One agent controls one user's machine. No "agent controls 5 users at once."
5. **Headless-to-headed Chrome migration** — We keep Chrome headless on VMs. Dispatch mode uses Xvfb for non-browser GUI apps only.
6. **Building our own usecomputer alternative** — We use the usecomputer library. If it breaks or has limitations, we contribute upstream or fork, not rewrite.

---

## 10. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **Users uncomfortable with AI desktop control** | High | Medium | Supervised mode default, clear UX, easy kill switch |
| **macOS Sequoia monthly Screen Recording re-prompt** | Certain | Low | Document it; consider Electron wrapper that avoids re-prompt |
| **usecomputer Linux ASCII-only typing** | Certain | Medium | Fall back to `xdotool type` for Unicode; contribute fix upstream |
| **1GB Nanode RAM too tight for Xvfb** | Low | Low | Xvfb is only ~20MB; keep Chrome headless |
| **Agent enters infinite click loop** | Medium | High | Rate limit (1/s), max 100 actions per task, timeout after 5 min |
| **Agent accidentally deletes user's files** | Low | Critical | Dangerous action blocklist in both SKILL.md and relay app |
| **WebSocket connection instability** | Medium | Low | Auto-reconnect with exponential backoff, command queuing |
| **Port 8765 as attack vector** | Low | Medium | Only open when dispatch is active; gateway token auth on handshake |
| **usecomputer breaks in future macOS update** | Medium | Medium | We depend on it but don't control it. Pin version, test on updates. |
| **Token cost surprise (too many screenshots)** | Medium | Medium | Budget cap in SKILL.md, credit deduction visible in dashboard |

---

## 11. Success Metrics

| Metric | Target (Phase 1) | Target (Phase 2) |
|--------|------------------|------------------|
| RAM overhead on 1GB Nanode | < 30MB | N/A (server-side only) |
| Agent task completion rate (dispatch) | > 60% | > 60% |
| Actions per successful task | < 25 | < 25 |
| Average latency per action | < 5s | < 6s |
| User opt-in rate (Phase 2) | N/A | > 20% of active users |
| User drop-off during permission setup | N/A | < 40% |
| Critical safety incidents | 0 | 0 |

---

## 12. Appendix: Technical References

### A. Anthropic Computer Use API Integration

Instead of building our own screenshot→reason→act loop from scratch, we should use Anthropic's `computer_20251124` tool type. The agent's API calls would include:

```json
{
  "type": "computer_20251124",
  "name": "computer",
  "display_width_px": 1280,
  "display_height_px": 720,
  "display_number": 0
}
```

The model returns structured `tool_use` blocks:
```json
{
  "type": "tool_use",
  "name": "computer",
  "input": {
    "action": "left_click",
    "coordinate": [450, 320]
  }
}
```

Our dispatch layer just needs to translate these into usecomputer calls. This gives us Anthropic's coordinate mapping, vision understanding, and error recovery for free.

**Open question:** Does OpenClaw support passing custom tool types to the Anthropic API? If not, we'd need to build the loop ourselves using the agent's normal conversation + dispatch scripts.

### B. usecomputer Node.js API Quick Reference

```typescript
import * as uc from 'usecomputer';

// Screenshot
const result = await uc.screenshot({ path: '/tmp/screen.png' });
// result: { path, coordMap, imageWidth, imageHeight, captureX, captureY, captureWidth, captureHeight }

// Click (uses coordMap to map screenshot pixels → desktop coords)
const point = uc.mapPointFromCoordMap({ x: 500, y: 300 }, result.coordMap);
await uc.click({ point, button: 'left', count: 1 });

// Type
await uc.typeText({ text: 'Hello world' });

// Press key combo
await uc.press({ key: 'cmd+s' });

// Scroll
await uc.scroll({ direction: 'down', amount: 3 });
```

### C. Xvfb Setup Commands

```bash
# Install
apt-get install -y xvfb libx11-dev libxext-dev libxtst-dev libpng-dev

# Start virtual display
Xvfb :99 -screen 0 1280x720x24 -ac &

# Set environment
export DISPLAY=:99

# Verify
usecomputer display list  # Should show one 1280x720 display
usecomputer screenshot /tmp/test.png  # Should produce a blank/desktop screenshot

# Optional: install a lightweight app to test with
apt-get install -y xterm
xterm &
usecomputer screenshot /tmp/xterm.png  # Should show xterm window
```

### D. Connection Flow Diagram

```
User installs relay:
  npm i -g @instaclaw/dispatch
  instaclaw-dispatch
    → Prompts for gateway token
    → Prompts for VM address
    → Checks macOS permissions
    → Saves config to ~/.instaclaw-dispatch/config.json

User starts dispatch:
  instaclaw-dispatch
    → Reads config
    → Opens WSS connection to vm-050.instaclaw.io:8765
    → Sends HMAC handshake: { token, timestamp, nonce, hmac }
    → Server validates → accepts connection
    → Prints "Connected to Richie. Supervised mode."

Agent uses dispatch:
  User: "Open my Figma file and export the logo"
  Agent: (reads SKILL.md, knows to use dispatch)
  Agent: bash ~/scripts/dispatch-remote-screenshot.sh
    → Script sends {"type":"screenshot"} to /tmp/dispatch.sock
    → dispatch-server.js forwards to user's machine via WebSocket
    → Local relay captures screenshot via usecomputer
    → Converts PNG→JPEG via sharp
    → Sends back: metadata frame + binary JPEG frame
    → dispatch-server.js receives, saves to /tmp/dispatch-screenshot.jpg
    → Script outputs { "path": "/tmp/dispatch-screenshot.jpg", "coordMap": "..." }
  Agent: [analyzes screenshot with vision] "I can see Figma is open with the logo file..."
  Agent: bash ~/scripts/dispatch-remote-click.sh 850 420
    → [same relay path]
    → Local relay: [supervised mode] "Agent wants to click at (850, 420) — 'Clicking the Export button in Figma'"
    → User presses Enter to approve
    → usecomputer executes click
    → Returns success
  Agent: bash ~/scripts/dispatch-remote-screenshot.sh
    → [verifies the export dialog opened]
  ... continues until task is done
```
