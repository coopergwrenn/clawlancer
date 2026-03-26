# PRD: UX Enhancements — Viral & Delightful Computer Control

**Author:** Claude (Opus 4.6) + Cooper Wrenn
**Date:** 2026-03-26
**Status:** Approved — Ready to Build
**Priority:** P1
**Depends on:** Dispatch Mode PRD (COMPLETE), Live Desktop Viewer PRD (COMPLETE)

---

## 1. Executive Summary

The computer control features are shipped and working. Now we make them **viral**. Four enhancements that turn "my agent can control computers" from a feature into a moment people screenshot, screen-record, and share.

The thesis: **showing is more powerful than telling.** Every enhancement below makes the agent's work visible, shareable, and delightful.

---

## 2. Priority 1 — Live Desktop Thumbnail on Dashboard Home

**Status: APPROVED**

### What

A small live preview of the agent's desktop (200x120px) always visible on the main dashboard. The user opens their dashboard and immediately sees their agent working. No clicks needed.

### Architecture: Agent-Side Cron Screenshots

The agent's cron takes a screenshot every 30 seconds and saves it to `~/.openclaw/workspace/desktop-thumbnail.jpg`. The dashboard polls a lightweight API endpoint that serves this cached image. Auto-refreshes every 15 seconds on the frontend.

This gives 95% of the visual impact with 1% of the infrastructure cost vs. persistent VNC connections.

**VM-side cron (every 30 seconds):**
```bash
DISPLAY=:99 usecomputer screenshot ~/.openclaw/workspace/desktop-thumbnail.png --json 2>/dev/null
convert ~/.openclaw/workspace/desktop-thumbnail.png -quality 40 -resize 400x240 ~/.openclaw/workspace/desktop-thumbnail.jpg 2>/dev/null
```
- Low quality (40%) + small resolution (400x240) = ~10-20KB per image
- Overwrites the same file every 30 seconds

**API endpoint:** `GET /api/vm/desktop-thumbnail`
- Authenticated (user session required)
- SSHs into VM, reads the thumbnail file
- Returns image with Cache-Control: max-age=10

**Dashboard component:** `<DesktopThumbnail />`
- 200x120px card on the dashboard home page
- Auto-refreshes every 15 seconds
- Green "LIVE" badge with pulse animation
- "Idle" overlay if image hasn't changed
- Click → navigates to `/live`

### UI Placement

Next to the agent status card. First thing the user sees.

### Effort: ~4 hours

---

## 3. Priority 2 — Agent Shares Screenshots Proactively

**Status: APPROVED (with updated approach)**

### What

The agent proactively sends screenshots of what it's working on — like a coworker sending "hey, just finished X — here's what it looks like." Natural, not robotic. Works during both user-requested tasks AND autonomous work (heartbeats, earning, research).

### Rules

1. **Share after every distinct visual action** — browsing a site, creating a file, completing research, running a trade. One screenshot per meaningful action.
2. **No hard rate limit.** If the user asks for 10 things, they get 10 screenshots. The agent sends as many as are useful.
3. **Anti-spam: never send the same screen twice.** If the desktop hasn't visually changed since the last screenshot, don't send another. Only send when something meaningfully changed.
4. **During autonomous work (heartbeat/earning):** Send a quick "working on X" update with a screenshot so the user knows the agent is active. This is especially valuable — the user didn't ask for anything but sees their agent is busy.
5. **Don't screenshot text-only work.** If the agent is just answering a question or writing text (no visual component), skip the screenshot.
6. **Caption style:** Natural, brief. "Here's what I found on DexScreener", "Just created your portfolio summary", "Working on the research you asked for — checking source #3". Not "Screenshot taken at 14:32:05 UTC."

### SOUL.md Addition

```
## Share Your Work (Proactive Screenshots)

After completing any action that has a visual result — or while working
autonomously — take a screenshot and send it to the user:

bash ~/scripts/dispatch-screenshot.sh
~/scripts/deliver_file.sh ~/.openclaw/workspace/dispatch-screenshot.jpg "Brief description"

When to share:
- After browsing a website: "Here's what I found on [site]"
- After creating a file/folder: "Done! Created [name]"
- After making changes: "Made the updates you asked for"
- During autonomous work: "Working on [task] — here's my progress"
- After research: "Found some interesting data — take a look"

When NOT to share:
- If the screen looks the same as the last screenshot you sent
- If you're just answering a question (no visual component)
- If the user explicitly said they don't want screenshots

Style: Like a coworker giving a quick update. Natural, brief, helpful.
```

### Effort: ~1 hour (SOUL.md update + fleet deploy)

---

## 4. Priority 4 — Shareable Agent Clips (Client-Side Recording)

**Status: APPROVED (client-side approach)**

### What

A "Record Clip" button on the /live page. Captures 15 seconds of the agent's desktop from the noVNC canvas using the browser's MediaRecorder API. Zero server load.

### Architecture: Client-Side Canvas Recording

When the user is watching `/live`, the noVNC canvas is already rendering the stream. We capture it directly:

```typescript
// Start recording from the noVNC canvas element
const canvas = document.querySelector('canvas');
const stream = canvas.captureStream(10); // 10 fps
const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });

const chunks = [];
recorder.ondataavailable = (e) => chunks.push(e.data);
recorder.onstop = () => {
  const blob = new Blob(chunks, { type: 'video/webm' });
  // Offer download or share
};

recorder.start();
setTimeout(() => recorder.stop(), 15000); // 15 seconds
```

### UI

- "Record" button in the /live page toolbar (next to Watch/Control toggle)
- Recording state: red dot + "Recording... 12s" countdown
- After recording: "Download" + "Share to X" buttons
- Share URL: `https://twitter.com/intent/tweet?text=Watch%20my%20@instaclaws%20agent%20work%20🤖`
- Format: WebM (natively supported by MediaRecorder)
- If we want persistent shareable links later → upload to Supabase Storage (v2)

### Effort: ~4 hours
- 2 hours: Recording logic + UI states
- 1 hour: Download + share functionality
- 1 hour: Testing across browsers

---

## 5. Priority 5 — Daily Agent Digest

**Status: APPROVED**

### What

Once per day at 8am user's timezone, the agent sends a summary of what it did. Includes only non-zero metrics. Idle agents get "Your agent is standing by — give it a task!"

### Format

**Active agent digest:**
```
📊 Daily Digest — March 26

While you were away, I:
• Completed 3 tasks
• Sent 12 messages
• Used 47 credits ($0.14)
• Earned $2.50 from bounties

🖥️ Here's my desktop right now:
[screenshot attached]
```

**Idle agent digest:**
```
📊 Daily Digest — March 26

Your agent is standing by — give it a task!

Try: "Research the top 5 AI startups this week" or
"Watch DexScreener for new Base listings"

🖥️ [desktop screenshot]
```

### Rules
- Only show non-zero metrics (hide "$0 earned" lines)
- Skip digest if user interacted in the last 2 hours (they're already engaged)
- Respect opt-out: agent checks for `~/.openclaw/workspace/.no-digest` file
- Deliver via Telegram (sendMessage + sendPhoto)

### Effort: ~3 hours

---

## 6. Implementation Order

| Priority | Feature | Effort | Ship First? |
|----------|---------|--------|-------------|
| **P2** | Proactive screenshots | 1 hour | **YES — ship immediately** |
| **P1** | Live thumbnail | 4 hours | Second |
| **P4** | Shareable clips | 4 hours | Third |
| **P5** | Daily digest | 3 hours | Fourth |

**Total: ~12 hours.**

P2 ships first because it's a SOUL.md-only change with the biggest immediate user impact — every agent starts sharing what it's doing, creating natural share moments in Telegram.

---

## 7. Removed

**~~Priority 3 — Boot Sequence~~**: Removed. Current provisioning progress UI is good enough. Don't fake it with a slideshow.

---

## 8. Success Metrics

| Metric | Target |
|--------|--------|
| Dashboard sessions with thumbnail visible | > 80% |
| Users who click thumbnail → /live | > 20% |
| Proactive screenshots sent per agent per day | 3-10 (natural range) |
| Screenshots forwarded/shared by users | Track organic growth |
| Clips recorded per week | > 50 |
| Clips shared to Twitter per week | > 10 |
| Daily digest open rate | > 60% |
| Digest → user re-engagement within 1 hour | > 30% |
