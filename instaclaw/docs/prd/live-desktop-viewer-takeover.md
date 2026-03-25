# PRD: Live Agent Desktop Viewer & Takeover Mode

**Author:** Claude (Opus 4.6) + Cooper Wrenn
**Date:** 2026-03-25
**Status:** Draft — Research Complete
**Priority:** P1

---

## 1. Executive Summary

### The Problem

InstaClaw agents work on their own VM desktops via Xvfb, but users can't see what they're doing in real-time. The only visibility is through periodic screenshots the agent sends to Telegram. Users want to:

1. **Watch their agent work live** — see the desktop as the agent browses, clicks, types, and navigates. Like looking over someone's shoulder.
2. **Take control** — jump in, use the mouse/keyboard directly, fix something, then hand control back to the agent.

This is table stakes for computer-use AI. Manus, Anthropic's demo, E2B, OpenAI Operator — they all show the user a live view of what the agent is doing.

### What We're Building

A dashboard page (`/dashboard/live`) that embeds a live view of the agent's VM desktop. The user can watch the agent work in real-time, and optionally take over mouse/keyboard control.

---

## 2. Industry Research

### How Everyone Else Does It

**Every major implementation uses the exact same stack:**

```
Xvfb (virtual framebuffer)
  → x11vnc (captures framebuffer, serves VNC protocol)
    → websockify (bridges VNC → WebSocket)
      → noVNC (HTML5 VNC client in browser canvas)
```

| Product | Stack | Confirmed By |
|---------|-------|-------------|
| **Manus AI** | Xvfb + x11vnc + websockify + noVNC (via E2B) | E2B blog post, ai-manus open-source clone |
| **Anthropic Computer Use Demo** | Xvfb + x11vnc + noVNC (ports 5900/6080) | Official GitHub repo |
| **E2B Desktop Sandbox** | Xvfb + x11vnc + websockify + noVNC | Open-source at github.com/e2b-dev/desktop |
| **Bytebot** | Xfce + x11vnc + noVNC | GitHub repo |
| **OpenAI Operator** | Browser viewport streaming only (no full desktop) | Product docs |

There is no alternative approach worth considering. This is the standard.

### Why Not WebRTC?

WebRTC offers lower latency and better compression (VP9/AV1), but:
- Much more complex (signaling server, STUN/TURN, ICE negotiation)
- Requires GStreamer or PipeWire pipeline to capture Xvfb
- VNC has native input support (mouse/keyboard forwarding); WebRTC doesn't
- VNC's differential encoding already gives near-zero bandwidth for static screens
- Every competitor uses VNC, not WebRTC

**Verdict: Use VNC.** Switch to WebRTC only if bandwidth becomes a bottleneck (unlikely for our use case).

---

## 3. Architecture

```
┌──────────────────────────────────┐
│ User's Browser                    │
│                                    │
│  [Dashboard / Live View Page]      │
│  ┌────────────────────────┐       │
│  │  noVNC Canvas           │       │
│  │  (view-only or          │       │
│  │   interactive)          │       │
│  └──────┬─────────────────┘       │
│         │ wss://                   │
└─────────┼──────────────────────────┘
          │
          ▼
┌─────────────────────────────────────┐
│ VM (Linode Nanode, 4GB)              │
│                                      │
│  [Caddy] ─── wss:// ──→ [websockify :6080]
│                              │
│                              ▼
│                       [x11vnc :5901]
│                              │
│                              ▼
│                       [Xvfb :99 @ 1280x720]
│                              │
│                    [Openbox + Chrome + Apps]
│                              │
│                    [OpenClaw Gateway Agent]
└─────────────────────────────────────┘
```

### Components

| Component | Where | Role | RAM | Install Size |
|-----------|-------|------|-----|-------------|
| **Xvfb** | VM (already installed) | Virtual framebuffer | ~20 MB | Already there |
| **x11vnc** | VM (new) | Captures framebuffer, serves VNC | ~25 MB | ~2 MB apt |
| **websockify** | VM (new) | VNC → WebSocket bridge | ~8 MB | ~1 MB apt |
| **noVNC** | Browser (new) | HTML5 VNC viewer | 0 (client-side) | ~200 KB gzipped |
| **Caddy** | VM (already installed) | TLS termination, WebSocket proxy | Already there | Already there |
| **Total new server-side** | | | **~33 MB** | **~3 MB** |

### Auth Flow

1. User clicks "Live View" on dashboard
2. Frontend calls `GET /api/vm/live-session` (authenticated)
3. API generates a short-lived one-time token (valid 30s)
4. API returns: `{ wsUrl: "wss://vm-ip:6080", token: "abc123" }`
5. Frontend passes token to noVNC: `new RFB(container, wsUrl + "?token=" + token)`
6. websockify validates token via custom plugin before connecting to x11vnc
7. Connection established — user sees live desktop

### Port Layout

| Port | Service | Exposed? |
|------|---------|----------|
| :99 | Xvfb display | No (local only) |
| 5901 | x11vnc VNC server | No (localhost only) |
| 6080 | websockify WebSocket | Yes (through Caddy or direct) |

### Security

- **x11vnc** binds to `localhost` only — no direct VNC access from internet
- **websockify** validates one-time token before allowing connection
- **No VNC password** — auth handled entirely by token validation
- **TLS** via Caddy (existing infrastructure) or websockify's built-in SSL
- **One viewer at a time** — `x11vnc -shared` allows multiple, but we limit to one authenticated user

---

## 4. Takeover Mode

### How It Works

noVNC has a `viewOnly` property that can be toggled at runtime:

```typescript
rfb.viewOnly = true;   // Watch only — no mouse/keyboard sent
rfb.viewOnly = false;  // Full control — user's input goes to VM
```

### UI Design

The Live View page has a toggle button:

```
┌─────────────────────────────────────────────┐
│  [🟢 Live]  [👁 Watch Mode ▾]  [⛶ Fullscreen]  │
│                                               │
│  ┌─────────────────────────────────────────┐ │
│  │                                          │ │
│  │       Agent's Desktop (1280x720)        │ │
│  │                                          │ │
│  │    [Watching agent work...]              │ │
│  │                                          │ │
│  └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

Toggle states:
- **Watch Mode** (default): `viewOnly = true`. User sees the desktop, can't interact. Green "Live" indicator.
- **Take Over**: `viewOnly = false`. User's mouse/keyboard control the VM. Agent receives a signal to pause. Orange "You're in control" indicator.

### Agent Handoff Protocol

When user takes over:
1. Frontend calls `POST /api/vm/takeover` with `{ action: "start" }`
2. API SSHs into VM, writes a file: `~/.openclaw/workspace/.user-takeover`
3. Agent's SKILL.md/SOUL.md instructs: "If `.user-takeover` exists, pause all actions and wait"
4. User controls the desktop via noVNC

When user releases control:
1. Frontend calls `POST /api/vm/takeover` with `{ action: "stop" }`
2. API removes `~/.openclaw/workspace/.user-takeover`
3. Agent resumes normal operation

---

## 5. Resource Impact

### On 4GB Nanodes (current fleet)

| State | Current RAM | With Live View |
|-------|-------------|----------------|
| Baseline (gateway + Xvfb + openbox) | ~1.0 GB | ~1.0 GB |
| + x11vnc + websockify (always running) | — | +33 MB |
| + One viewer connected | — | +5 MB (negligible) |
| **Total** | ~1.0 GB | **~1.04 GB** |

33 MB total overhead. Trivial on 4GB VMs.

### Bandwidth

| Activity | Bandwidth | Per Hour |
|----------|-----------|----------|
| Screen idle | < 1 KB/s | ~3.6 MB |
| Agent browsing/clicking | 100-300 KB/s | 360 MB - 1 GB |
| Heavy page loads | 500 KB/s peak | ~1.8 GB |
| User takeover (interactive) | 200-500 KB/s | ~1 GB |

Linode includes generous bandwidth (1-8 TB/month depending on plan). Live viewing for 2 hours/day would use ~1-2 GB/day, ~30-60 GB/month. Well within limits.

---

## 6. Prototype Plan

### Phase 0: Proof of Concept on vm-050 (30 minutes)

1. `apt install -y x11vnc websockify`
2. Start x11vnc: `x11vnc -display :99 -forever -shared -rfbport 5901 -localhost -noxdamage -nopw &`
3. Start websockify: `websockify 6080 localhost:5901 &`
4. Open UFW: `ufw allow 6080/tcp`
5. Open browser: `http://vm-050-ip:6080/vnc.html`
6. **Verify:** Can we see the Xvfb desktop live? Can we click/type through the browser?

### Phase 1: Dashboard Integration (1-2 days)

1. Install `@novnc/novnc` or `react-vnc` in the instaclaw Next.js app
2. Create `/dashboard/live` page with noVNC canvas
3. Create `GET /api/vm/live-session` endpoint (generates one-time token, returns wsUrl)
4. Add x11vnc + websockify to `configureOpenClaw()` (new VMs get it automatically)
5. Fleet deploy x11vnc + websockify as systemd services
6. Add Caddy config to proxy wss:// to websockify (TLS termination)

### Phase 2: Takeover Mode (1 day)

1. Add Watch/Takeover toggle to the live view page
2. Create `/api/vm/takeover` endpoint
3. Add `.user-takeover` file detection to SKILL.md/SOUL.md
4. Test: user takes over → agent pauses → user releases → agent resumes

### Phase 3: Polish (1-2 days)

1. Connection status indicators (connecting, live, disconnected)
2. Fullscreen mode
3. Quality/compression settings for slow connections
4. World mini app integration (embed in mini app)
5. Auto-reconnect on connection drop
6. Session timeout (auto-disconnect after 30 minutes of inactivity)

---

## 7. Open Questions

1. **Always-on vs on-demand?** Should x11vnc + websockify run always (as systemd services), or only start when the user opens the live view?
   - **Recommendation:** Always-on. 33 MB is negligible, and startup delay would frustrate users.

2. **Port 6080 — direct or through Caddy?** Direct access requires opening another port. Through Caddy gives TLS for free but needs a Caddy config update.
   - **Recommendation:** Start with direct (port 6080 open). Add Caddy proxy in Phase 3 for proper TLS.

3. **Multiple viewers?** Can two people watch the same agent simultaneously?
   - **Recommendation:** No. One viewer at a time. Simpler auth, less bandwidth.

4. **Recording?** Should we record the desktop session for later playback?
   - **Recommendation:** Not in v1. Nice-to-have for Phase 3+.

---

## 8. Non-Goals

1. **Audio streaming** — VNC doesn't support audio. Not needed for agent work.
2. **File transfer through VNC** — use existing deliver_file.sh mechanism.
3. **Mobile-optimized viewer** — noVNC works on mobile but isn't great. Desktop-first.
4. **Multi-agent viewing** — one dashboard shows one agent. No split-screen.

---

## 9. Success Metrics

| Metric | Target |
|--------|--------|
| Connection time (click → live view) | < 3 seconds |
| Latency (user action → screen update) | < 200ms |
| Additional RAM per VM | < 50 MB |
| Bandwidth per hour (active viewing) | < 1 GB |
| User adoption (% who try live view) | > 40% |
| Takeover mode usage | > 10% of live view sessions |
