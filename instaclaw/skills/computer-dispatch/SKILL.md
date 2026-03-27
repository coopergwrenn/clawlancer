---
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

**1. Shell commands over GUI — ALWAYS.** For file operations (create folders, move/copy/rename/delete files, organize, search), ALWAYS open Terminal and type shell commands. NEVER navigate Finder/Explorer GUI for file management. One shell command = 1 tool call. GUI navigation = 30+ tool calls and burns your entire context window.

Bad (wastes context, slow):
- Right-click desktop → New Folder → name it → drag files into it → 20 screenshots

Good (fast, cheap):
```bash
bash ~/scripts/dispatch-remote-type.sh "mkdir -p ~/Desktop/Screenshots && mv ~/Desktop/Screenshot*.png ~/Desktop/Screenshots/"
bash ~/scripts/dispatch-remote-press.sh "Return"
```

**2. Save task state every 5 actions.** During multi-step dispatch tasks, write your progress to `~/.openclaw/workspace/ACTIVE_TASK.md` every 5 actions so you can resume after context resets. Format:
```
## Active Task
Request: [what the user asked]
Status: IN_PROGRESS
Completed: [what's done]
Next: [exact next step]
Updated: [timestamp]
```

**3. Batch over single actions.** Use `dispatch-remote-batch.sh` to combine multiple actions into one round-trip. See Batch Command section below.

**4. Context budget limit.** If you've taken more than 10 screenshots for one task, STOP and reconsider your approach. You're probably doing something the wrong way (e.g. GUI navigation instead of shell commands). Switch to Terminal + shell commands immediately. Max 15 screenshots per task — after that, tell the user what's left and offer to continue in a fresh session.

## Two Modes

### Mode 1: Local Dispatch (Your VM Desktop)
Your VM has a virtual desktop (Xvfb at DISPLAY=:99, 1280x720, Openbox WM). Use this for:
- Opening websites with stealth Chrome (`dispatch-browser.sh`)
- Running GUI applications autonomously
- Tasks that don't need the user's computer

**Scripts:** `dispatch-screenshot.sh`, `dispatch-click.sh`, `dispatch-type.sh`, `dispatch-press.sh`, `dispatch-scroll.sh`, `dispatch-browser.sh`

### Mode 2: Remote Dispatch (User's Personal Computer)
When the user runs `instaclaw-dispatch` on their Mac/PC, you can control their actual computer. Use this for:
- User asks "do this on MY computer"
- Tasks that require the user's installed apps (Figma, Excel, Slack, etc.)
- Interacting with the user's logged-in sessions

**Scripts:** `dispatch-remote-screenshot.sh`, `dispatch-remote-click.sh`, `dispatch-remote-type.sh`, `dispatch-remote-press.sh`, `dispatch-remote-scroll.sh`

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
```bash
bash ~/scripts/dispatch-remote-status.sh
```
Returns `{"connected":true}` or `{"connected":false}`. If not connected, tell the user:
"To let me control your computer, run `npx @instaclaw/dispatch` in your terminal."

---

## Local Dispatch Commands (Your VM)

### Open a Website (Stealth Chrome)
```bash
bash ~/scripts/dispatch-browser.sh "https://example.com"
sleep 5
bash ~/scripts/dispatch-screenshot.sh
~/scripts/deliver_file.sh ~/.openclaw/workspace/dispatch-screenshot.jpg "Screenshot"
```
Has anti-Cloudflare stealth. Use for ANY website visit.

### Screenshot Your Desktop
```bash
bash ~/scripts/dispatch-screenshot.sh
```
Returns JSON with `path`, `coordMap`, `image_base64`. Send to user via `deliver_file.sh`.

### Click / Type / Press / Scroll
```bash
bash ~/scripts/dispatch-click.sh <x> <y>
bash ~/scripts/dispatch-type.sh "text"
bash ~/scripts/dispatch-press.sh "Return"
bash ~/scripts/dispatch-scroll.sh down 3
```

### Launch GUI Apps
```bash
DISPLAY=:99 xterm &
```

---

## Remote Dispatch Commands (User's Computer)

### Screenshot User's Screen
```bash
bash ~/scripts/dispatch-remote-screenshot.sh
```
Captures the user's actual screen. Returns JSON with `path` (saved to workspace) and `coordMap`. Send to user via `deliver_file.sh`.

### Click on User's Screen
```bash
bash ~/scripts/dispatch-remote-click.sh <x> <y>
```

### Type on User's Keyboard
```bash
bash ~/scripts/dispatch-remote-type.sh "text"
```

### Press Key on User's Machine
```bash
bash ~/scripts/dispatch-remote-press.sh "Return"
```

### Scroll on User's Machine
```bash
bash ~/scripts/dispatch-remote-scroll.sh down 3
```

### Drag on User's Screen
```bash
bash ~/scripts/dispatch-remote-drag.sh <fromX> <fromY> <toX> <toY>
```

### List Windows on User's Machine
```bash
bash ~/scripts/dispatch-remote-windows.sh
```

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
```bash
bash ~/scripts/dispatch-remote-batch.sh '{"actions":[{"type":"click","params":{"x":400,"y":300},"waitAfterMs":100},{"type":"type","params":{"text":"hello world"},"waitAfterMs":0},{"type":"press","params":{"key":"Return"},"waitAfterMs":1500}]}'
```

Returns JSON with both action results AND a screenshot (auto-captured after the batch). The screenshot is saved to `~/.openclaw/workspace/dispatch-remote-screenshot.jpg`.

### Batch Options:
- `screenshotAfter`: true (default) — auto-screenshot after batch
- `screenshotFormat`: "webp" (default) — smaller than JPEG
- `screenshotQuality`: 55 (default) — good enough for GUI analysis
- `settleMs`: 300 (default) — wait for screen to settle before screenshot
- `waitAfterMs` per action: milliseconds to wait after each action (default 50ms)

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
```bash
[ -f ~/.openclaw/workspace/.user-takeover ] && echo "USER_IN_CONTROL" || echo "OK"
```
If `.user-takeover` exists, **STOP all dispatch actions immediately**. The user is controlling the desktop via live view. Wait and check again in 10 seconds. When the file is removed, resume your work.

**Never fight the user for control.** If the takeover file exists, do not click, type, press, scroll, or take screenshots.

## Rate Limits

- **Max 10 commands per second** — the dispatch server enforces this. Batch commands count as 1 command.
- **Max 60 screenshots per minute** — each screenshot costs ~$0.003 in vision tokens.
- **Max 500 commands per relay session** — after 500 commands, the relay disconnects. Tell the user to reconnect if more work is needed.
- **Max 20 actions per batch** — individual batch actions are not rate-limited internally.
- **30-minute idle timeout** — if no commands for 30 minutes, the relay auto-disconnects.

**If a dispatch command returns an error containing "rate limit":** Tell the user: "I'm being rate limited on dispatch commands. I'll wait 30 seconds and try again." Then wait 30 seconds before retrying.

**Before EVERY remote dispatch command:** Check relay status first:
```bash
bash ~/scripts/dispatch-remote-status.sh
```
If `connected: false`, tell the user: "Your dispatch relay isn't connected. Run `npx @instaclaw/dispatch` in your terminal to connect."

## Sending Screenshots to Users (BOTH modes)

After taking a screenshot (local OR remote), ALWAYS send it to the user:
```bash
# Local screenshot:
bash ~/scripts/dispatch-screenshot.sh
~/scripts/deliver_file.sh ~/.openclaw/workspace/dispatch-screenshot.jpg "Desktop screenshot"

# Remote screenshot:
bash ~/scripts/dispatch-remote-screenshot.sh
~/scripts/deliver_file.sh ~/.openclaw/workspace/dispatch-remote-screenshot.jpg "Your Mac screenshot"
```

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
| "dispatch relay not connected" | User needs to run `npx @instaclaw/dispatch` |
| Screenshot fails (local) | Check Xvfb: `ps aux \| grep Xvfb` |
| Screenshot fails (remote) | User may need to grant Screen Recording permission |
| Click doesn't work | Verify coordinates from latest screenshot |
| dispatch-browser.sh won't launch | Check RAM: `free -m` (needs 500MB+ available) |
