# PRD: UX Enhancements — Viral & Delightful Computer Control

**Author:** Claude (Opus 4.6) + Cooper Wrenn
**Date:** 2026-03-26
**Status:** Draft — Architecture Designed, Awaiting Review
**Priority:** P1
**Depends on:** Dispatch Mode PRD (COMPLETE), Live Desktop Viewer PRD (COMPLETE)

---

## 1. Executive Summary

The computer control features are shipped and working. Now we make them **viral**. Five enhancements that turn "my agent can control computers" from a feature into a moment people screenshot, screen-record, and share.

The thesis: **showing is more powerful than telling.** Every enhancement below makes the agent's work visible, shareable, and delightful.

---

## 2. Priority 1 — Live Desktop Thumbnail on Dashboard Home

### The Wow Factor

A small live preview of the agent's desktop (200x120px) always visible on the main dashboard. The user opens their dashboard and immediately sees their agent working — terminal commands running, browser pages loading, files being created. No clicks needed. It's always there.

### Architecture Decision: Polling vs. Live VNC

| Approach | Pros | Cons |
|----------|------|------|
| **Persistent noVNC at low res** | True live (cursor movement visible) | 1 WebSocket per dashboard session; 100 users = 100 concurrent VNC connections; battery drain on mobile |
| **Periodic screenshot polling** | Lightweight (1 HTTP request every 10-15s); no persistent connections; works on mobile; cacheable | Not truly "live" (10-15s delay); no cursor movement |
| **Agent-side cron screenshot** | Zero per-request overhead; VM saves screenshot every 30s to fixed path; API just serves static file | 30s delay; needs cron entry |

**Recommendation: Agent-side cron screenshot (Option C).**

The agent's `strip-thinking.py` cron already runs every minute. Add one line that takes a screenshot and saves it to `~/.openclaw/workspace/desktop-thumbnail.jpg`. The dashboard fetches this via a new API endpoint (`GET /api/vm/desktop-thumbnail`) that SSHs in and reads the file. The image auto-refreshes every 15 seconds on the frontend.

This gives 95% of the visual impact with 1% of the infrastructure cost. Users see their agent working. The 30-second delay is imperceptible — people don't stare at thumbnails for 30 seconds.

### Implementation

**VM-side (cron addition):**
```bash
# In strip-thinking.py or a separate cron entry (every 30 seconds):
DISPLAY=:99 usecomputer screenshot ~/.openclaw/workspace/desktop-thumbnail.png --json 2>/dev/null
convert ~/.openclaw/workspace/desktop-thumbnail.png -quality 40 -resize 400x240 ~/.openclaw/workspace/desktop-thumbnail.jpg 2>/dev/null
```
- Low quality (40%) + small resolution (400x240) = ~10-20KB per image
- Overwrites the same file every 30 seconds
- No accumulation, no cleanup needed

**API endpoint:** `GET /api/vm/desktop-thumbnail`
- Authenticated (requires user session)
- SSHs into VM, reads `~/.openclaw/workspace/desktop-thumbnail.jpg`
- Returns the image with Cache-Control: max-age=10
- If file doesn't exist, returns a placeholder image

**Dashboard component:** `<DesktopThumbnail />`
- Renders as a 200x120px card on the dashboard home page
- Auto-refreshes every 15 seconds via `setInterval` + `img.src = url + '?t=' + Date.now()`
- Green "LIVE" badge with pulse animation in top-right corner
- "Idle" overlay if the image hasn't changed in 2+ minutes (compare image hash)
- Click → navigates to `/live`
- Skeleton/loading state while first image loads

### UI Placement

The thumbnail sits in the dashboard overview section, next to the agent status card. It's the first thing the user sees after the agent name and health status.

```
┌─────────────────────────────────────────────────┐
│  Dashboard                                        │
│                                                   │
│  ┌──────────────────┐  ┌──────────────────────┐  │
│  │  Agent Status     │  │  ┌────────────────┐  │  │
│  │  ● Active         │  │  │  [thumbnail]   │  │  │
│  │  Credits: 847     │  │  │  200x120 live   │  │  │
│  │  Messages: 12     │  │  │  LIVE ●         │  │  │
│  │  Uptime: 3 days   │  │  └────────────────┘  │  │
│  └──────────────────┘  │  Click to expand       │  │
│                         └──────────────────────┘  │
└─────────────────────────────────────────────────┘
```

### Effort: ~4 hours
- 30 min: cron screenshot script + fleet deploy
- 1 hour: API endpoint (SSH + serve image)
- 2 hours: Dashboard component + styling
- 30 min: Testing + polish

---

## 3. Priority 2 — Agent Shares Screenshots Proactively

### The Share Moment

After completing any visual task, the agent takes a screenshot and sends it to the user with a caption. The user sees the result immediately in Telegram or the mini app chat. These screenshots are the moments people share on social media.

### Implementation

**SOUL.md addition:**
```
## Proactive Screenshots (Share Your Work)

After completing any task that has a visual result, take a screenshot and
send it to the user:

1. After browsing a website: screenshot + "Here's what I found on [site]"
2. After creating a file or folder: screenshot + "Done! Created [name]"
3. After editing a document: screenshot + "Made the changes you asked for"
4. After research: screenshot of the key finding + summary
5. After any dispatch-browser.sh task: screenshot + result description

How to share:
```bash
bash ~/scripts/dispatch-screenshot.sh
~/scripts/deliver_file.sh ~/.openclaw/workspace/dispatch-screenshot.jpg "Here's what I found"
```

**Budget guardrails:**
- Only screenshot after COMPLETING a task the user requested, not after every intermediate step
- Max 5 proactive screenshots per hour
- Don't screenshot for text-only tasks (answering questions, writing code, etc.)
- Don't screenshot if the user hasn't interacted in 30+ minutes (agent is in heartbeat mode)
```

### Effort: ~1 hour
- 30 min: SOUL.md update
- 15 min: Fleet deploy
- 15 min: Test with 2-3 agents

---

## 4. Priority 3 — Agent Boot Sequence (Post-Provisioning)

### The "It's Alive" Moment

When a new user's VM finishes provisioning, instead of a static "Complete ✓" screen, they watch their agent come to life. Terminal opens, first commands run, Telegram connects. This is the onboarding moment people screen-record.

### Architecture Decision: Live VNC vs. Screenshot Slideshow

| Approach | Pros | Cons |
|----------|------|------|
| **Live VNC during provisioning** | Truly live, most impressive | Timing nightmare (x11vnc starts mid-provision); user might see errors; connection may not be ready |
| **Rapid screenshot slideshow** | Reliable (screenshots after provision completes); controllable narrative; simple | Not truly "live"; feels more like a recording |
| **Hybrid: slideshow then VNC** | Best of both — show curated boot sequence, then transition to live | More complex; two different rendering modes |

**Recommendation: Rapid screenshot slideshow (Option B).**

After `configureOpenClaw()` returns success:
1. API takes 4 screenshots at 2-second intervals via SSH
2. Frontend displays them as an animated slideshow (fade transitions)
3. Final slide shows the agent's first Telegram message or health status
4. Caption below: "Your agent is now live 🚀"
5. After slideshow, "Go to Dashboard" button appears

This is reliable (no timing issues), controllable (we choose what to show), and delightful.

### Implementation

**API endpoint:** `POST /api/vm/boot-sequence`
- Called after configureOpenClaw completes
- SSHs into VM, takes 4 screenshots at 2-second intervals
- Returns array of 4 base64 JPEG thumbnails (small, ~20KB each)
- Total payload: ~80KB

**Frontend component:** `<BootSequence screenshots={[...]} />`
- Displays on the provisioning/onboarding completion page
- Crossfade animation between screenshots (1.5s per slide)
- Progress bar or step indicator below
- Final slide holds with "Your agent is live" message
- Gradient dark background matching the /live page aesthetic

### Effort: ~3 hours
- 1 hour: API endpoint (SSH + rapid screenshots)
- 1.5 hours: Frontend component + animations
- 30 min: Integration with provisioning flow

---

## 5. Priority 4 — Shareable Agent Clips

### The Viral Content Machine

A "Record" button on the /live page that captures 15 seconds of the agent's desktop as a shareable video or GIF. One-tap share to Twitter with pre-filled text. Every clip is organic content.

### Architecture Decision: Client-side vs. Server-side Recording

| Approach | Pros | Cons |
|----------|------|------|
| **Client-side canvas capture** | No server cost; real-time preview; works with inline noVNC | GIF.js is slow; large file size; canvas capture may be blocked by browser security |
| **Server-side ffmpeg** | High quality; reliable; small file size (H.264); works even if user isn't watching | Needs ffmpeg installed; 15s of CPU time per clip; file transfer overhead |
| **Hybrid: server records, client previews** | Best quality + user sees recording in progress | Most complex |

**Recommendation: Server-side ffmpeg (Option B).**

`ffmpeg` is already available on most Ubuntu VMs or easy to install. The flow:
1. User clicks "Record Clip" on /live page
2. API calls `POST /api/vm/record-clip`
3. VM runs: `ffmpeg -f x11grab -video_size 1280x720 -i :99 -t 15 -vf scale=640:360 -c:v libx264 -preset ultrafast -crf 28 /tmp/agent-clip.mp4`
4. After 15 seconds, API downloads the clip via SCP
5. Returns a download URL or serves the file directly
6. "Share to X" button: `https://twitter.com/intent/tweet?text=Watch%20my%20@instaclaws%20agent%20work%20autonomously%20🤖&url=...`

**File sizes:** 15 seconds of 640x360 H.264 at CRF 28 ≈ 500KB-2MB depending on content.

### UI Design

```
┌─────────────────────────────────────────┐
│  [⏺ Record Clip]  15s                    │
│                                           │
│  Recording state:                         │
│  [🔴 Recording... 8s]  [Stop]            │
│                                           │
│  After recording:                         │
│  [▶ Preview]  [⬇ Download]  [🐦 Share]  │
└─────────────────────────────────────────┘
```

### Effort: ~6 hours
- 1 hour: Install ffmpeg on fleet (if not present) + API endpoint
- 2 hours: Frontend recording UI + progress + preview
- 1 hour: Share functionality (Twitter intent, clipboard copy)
- 2 hours: Testing + polish + error handling

---

## 6. Priority 5 — Daily Agent Digest

### The Re-engagement Hook

Once per day, the agent sends the user a summary of what it did while they were away. Includes key metrics, a highlight screenshot, and a subtle nudge to engage.

### Implementation

**New script:** `~/scripts/daily-digest.py` (runs via cron at 8am user's timezone)

```
📊 Daily Agent Digest — March 26, 2026

While you were away, I:
• Completed 3 tasks
• Sent 12 messages
• Used 47 credits ($0.14)
• Earned $0.00 (no active bounties)

🖥️ Here's my desktop right now:
[screenshot attached]

💡 Tip: Ask me to "watch DexScreener for new listings" — I'll monitor and alert you automatically.
```

**Delivery channels:**
- Telegram (via bot sendMessage + sendPhoto)
- World mini app (via push notification API when available)

**Configuration:**
- User's timezone from `instaclaw_users.user_timezone`
- Opt-out: agent checks for `~/.openclaw/workspace/.no-digest` file
- Skip if user interacted in the last 2 hours (they're already engaged)

### Effort: ~3 hours
- 1 hour: Digest script (Python, reads from session logs + credit balance)
- 30 min: Cron configuration + timezone handling
- 1 hour: Telegram formatting + screenshot attachment
- 30 min: Fleet deploy + testing

---

## 7. Implementation Order

| Priority | Feature | Effort | Impact | Dependencies |
|----------|---------|--------|--------|-------------|
| **P1** | Live thumbnail on dashboard | 4 hours | Highest — always-visible "wow" | Cron screenshot + API + component |
| **P2** | Proactive screenshots | 1 hour | High — creates share moments | SOUL.md update only |
| **P3** | Boot sequence | 3 hours | High — onboarding delight | API + frontend component |
| **P4** | Shareable clips | 6 hours | Medium — viral content | ffmpeg + API + frontend + share |
| **P5** | Daily digest | 3 hours | Medium — re-engagement | Cron script + Telegram |

**Total: ~17 hours of work across all 5 priorities.**

**Recommended build order:** P2 (1 hour, ship fast) → P1 (4 hours, biggest impact) → P3 (3 hours, onboarding) → P5 (3 hours, retention) → P4 (6 hours, viral)

---

## 8. Open Questions

1. **P1 thumbnail frequency:** 15 seconds feels right for the frontend poll interval, but should the VM screenshot cron run every 30 seconds or 60 seconds? 30s means more disk writes but fresher thumbnails.

2. **P2 proactive screenshot limit:** "Max 5 per hour" — is this too aggressive or too conservative? Should it be per-task instead of per-hour?

3. **P3 boot sequence:** Should we show the actual terminal output (text-based) alongside or instead of screenshots? Text might feel more "real" and hacker-y.

4. **P4 clip hosting:** Where do we host the video clips? Options:
   - Serve from VM directly (temporary, deleted after 1 hour)
   - Upload to Supabase Storage (persistent, but costs money)
   - Upload to a CDN/S3 bucket (scalable but needs setup)

5. **P4 GIF vs MP4:** Twitter supports both. GIFs auto-play in feed (more viral) but are 5-10x larger. MP4 is smaller but needs a play button. Which format for the share?

6. **P5 digest content:** Should the digest include earnings/bounty progress even if zero? Or only show categories with non-zero values?

7. **P1 mobile:** The thumbnail works on desktop, but on mobile the dashboard is narrower. Should the thumbnail be hidden on mobile, or shown above the fold as a full-width banner?

---

## 9. Success Metrics

| Metric | Target |
|--------|--------|
| Dashboard sessions with thumbnail visible | > 80% |
| Users who click thumbnail → /live | > 20% |
| Proactive screenshots shared (via Telegram forward) | Track organic sharing |
| Boot sequence completion rate | > 95% of new users see it |
| Clips recorded per week | > 50 |
| Clips shared to Twitter per week | > 10 |
| Daily digest open rate (Telegram) | > 60% |
| Daily digest → user re-engagement within 1 hour | > 30% |

---

## 10. Non-Goals

1. **Live audio/video streaming** — VNC doesn't support audio. Not relevant for agent work.
2. **Multi-agent dashboard** — Show one agent at a time. Multi-agent view is a separate feature.
3. **Real-time collaboration** — User and agent working simultaneously on the same desktop. Out of scope — takeover mode is sequential (one at a time).
4. **Custom agent themes/wallpapers** — Fun but low priority.
5. **Desktop notifications** — Browser push notifications for agent activity. Worth exploring later, but not in this PRD.
