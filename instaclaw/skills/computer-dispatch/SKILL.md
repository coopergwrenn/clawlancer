---
name: computer-dispatch
description: "Virtual desktop with stealth browser — open websites, take screenshots, control GUI apps. Use dispatch-browser.sh for ANY website visit."
metadata:
  triggers:
    keywords: [dispatch, desktop, screen, click, screenshot, xterm, gui, app, window, open, visit, show, dexscreener, website, url, browse]
    phrases: ["take a screenshot", "open an app", "click on", "what is on screen", "open this website", "show me this site", "go to", "visit", "pull up", "check this url"]
---

# Computer Dispatch Skill

## Overview

You have a virtual desktop (Xvfb) running on your VM at DISPLAY=:99 with a stealth Chrome browser. You can open any website, take screenshots, and control GUI applications with mouse and keyboard.

**IMPORTANT: For opening/visiting/showing ANY website, use `dispatch-browser.sh` — it has anti-Cloudflare stealth that the regular `browser` tool does NOT have. The regular browser tool gets blocked by Cloudflare on most crypto/financial sites.**

## When to Use This Skill

- **User asks to open, visit, show, or screenshot ANY website** → dispatch-browser.sh
- **Regular browser tool fails with Cloudflare/403/timeout** → dispatch-browser.sh (immediate fallback)
- You need to interact with a desktop application
- You want to see what is currently displayed on your VM desktop
- A task requires GUI interaction beyond web browsing
- You are debugging something visual

## When NOT to Use This

- Regular web browsing → use the `browser` tool (faster, cheaper, more reliable)
- Web searches → use `web_search`
- File reading/writing → use bash commands directly
- API calls → use `web_fetch` or scripts

## Available Commands

### Take a Screenshot
```bash
bash ~/scripts/dispatch-screenshot.sh
```
Returns JSON with:
- `path`: path to the PNG file on disk
- `coordMap`: coordinate mapping string (use this for click targets)
- `image_base64`: base64-encoded PNG

### Click at Coordinates
```bash
bash ~/scripts/dispatch-click.sh <x> <y>
```
Coordinates are in **screenshot pixel space**. Get them from analyzing the screenshot.

### Type Text
```bash
bash ~/scripts/dispatch-type.sh "text to type"
```
Types the text via keyboard synthesis using xdotool. Supports spaces and most ASCII characters.

### Press a Key or Combo
```bash
bash ~/scripts/dispatch-press.sh "ctrl+c"
```
Supports key names: Return, Tab, Escape, BackSpace, Delete, space, ctrl, shift, alt, super, plus key combos like ctrl+c, ctrl+shift+t.

### Scroll
```bash
bash ~/scripts/dispatch-scroll.sh <direction> [amount]
```
Direction: up, down, left, right. Amount defaults to 3.

## The Screenshot → Reason → Act Loop

This is the core pattern. Follow it every time:

1. **Screenshot**: `bash ~/scripts/dispatch-screenshot.sh`
2. **Analyze**: Look at the screenshot. What is on screen? What do you need to interact with?
3. **Plan**: Decide your next action — which element to click, what to type
4. **Act**: Execute ONE action (click, type, press, or scroll)
5. **Wait**: Give the screen 500ms to update
6. **Verify**: Take another screenshot to confirm your action worked
7. **Repeat**: Continue until the task is done

**IMPORTANT:** Always take a screenshot BEFORE and AFTER each action. Do not guess what is on screen — look.

## Launching Applications

To open a GUI app on the desktop:
```bash
DISPLAY=:99 xterm &       # Terminal emulator
DISPLAY=:99 xeyes &       # Test app
```

If the app is not installed, install it first: `sudo apt-get install -y <package>`

## Safety Rules (NEVER VIOLATE)

1. **Do not click blindly** — always screenshot first to see what is on screen
2. **Do not spam actions** — wait for each action to complete before the next
3. **Do not run destructive commands** in GUI terminals without user confirmation
4. **Max 50 actions per task** — if you have not completed the task in 50 steps, stop and report
5. **If something looks wrong**, stop and describe what you see rather than continuing

## Limitations

- **No clipboard** — clipboard operations are not yet supported
- **Resolution is 1280x720** — this is the virtual display size
- **No window manager** — windows may overlap without proper management. Launch one app at a time.
- **Unicode typing may fail** — stick to ASCII characters for best results

## Error Handling

- If a screenshot fails: check that Xvfb is running (`ps aux | grep Xvfb`)
- If a click does not work: verify coordinates from the latest screenshot
- If typing fails: try dispatch-press.sh for individual keys
- If an app will not start: check if it is installed (`which <app>`)
