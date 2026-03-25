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

---

## The Screenshot → Reason → Act Loop

Same pattern for both modes:

1. **Screenshot** — see what's on screen
2. **Analyze** — identify elements, read text
3. **Plan** — decide what to click/type
4. **Act** — execute ONE action
5. **Wait** — 500ms for screen to update
6. **Verify** — screenshot again to confirm
7. **Repeat** until done

Max 50 actions per task. Always screenshot before AND after each action.

## Safety Rules

1. **Never click blindly** — screenshot first
2. **Never type passwords** — ask the user to type credentials themselves
3. **Never delete files** without user confirmation
4. **Never interact with banking/financial apps** unless user explicitly requested
5. **Remote mode**: the user sees every action in their terminal (supervised mode). Be descriptive about what you're doing.
6. **If something looks wrong**, stop and describe what you see

## Error Handling

| Error | Fix |
|-------|-----|
| "dispatch relay not connected" | User needs to run `npx @instaclaw/dispatch` |
| Screenshot fails (local) | Check Xvfb: `ps aux \| grep Xvfb` |
| Screenshot fails (remote) | User may need to grant Screen Recording permission |
| Click doesn't work | Verify coordinates from latest screenshot |
| dispatch-browser.sh won't launch | Check RAM: `free -m` (needs 500MB+ available) |
