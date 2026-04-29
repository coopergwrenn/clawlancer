---
name: web-search-browser
description: >-
  Search the web, browse pages, take screenshots, scrape data, and automate web interactions. Use when the user asks to search the web, look something up, visit a website, take a screenshot, or scrape a page.
---
# Web Search & Browser Automation
```yaml
name: web-search-browser
version: 1.0.0
updated: 2026-02-22
author: InstaClaw
triggers:
  keywords: [search, browse, scrape, screenshot, web, google, fetch, lookup, crawl]
  phrases: ["search the web", "look up", "go to website", "take a screenshot", "scrape this page", "find online"]
  NOT: [email, stock, competitor]
```

## Overview

You have access to three tiers of web capability, each suited to different tasks. Use the lightest tool that gets the job done. Do not launch a full browser session when a simple search or fetch will suffice.

**Tier 1 — Brave Search** (`web_search` tool)
Fast, structured search results. Best for factual queries, news, real-time data, and discovering URLs. No browser overhead.

**Tier 2 — Web Fetch** (`web_fetch` tool)
Retrieve and read the content of a specific URL. Returns cleaned markdown text. Best for reading articles, documentation, product pages, or any known URL.

**Tier 3 — Browser Automation** (`browser` tool)
Full headless Chromium control via CDP. Best for one-off operations: open a page, take a screenshot, run an `evaluate` snippet, snapshot the accessibility tree. For multi-step interactions (click + fill + navigate + confirm), prefer Tier 3.25 instead — coordinate-driven control gets brittle past ~3 steps.

**Tier 3.25 — Sophisticated Browser Agent** (`~/scripts/browser-use-task.py`, browser-use skill)
Multi-step browser agent with accessibility-tree element targeting. **The default for any task that *does* something on a page** — clicks, form fills, multi-page flows, data extraction across pages. Routes LLM calls through the OpenClaw gateway so credits meter normally. Single-session per VM (cgroup MemoryMax=3500M). See `~/.openclaw/skills/browser-use/SKILL.md` for full docs and `references/examples/` for worked invocations.

**Tier 3.5 — Crawlee Stealth Scraping** (`~/scripts/crawlee-scrape.py`)
When Tier 2 or Tier 3 gets blocked by anti-bot systems (403, CAPTCHA, Cloudflare challenge, DataDome, PerimeterX), escalate to Crawlee. It uses TLS fingerprint impersonation and browser fingerprint randomization to bypass protections. Two modes: `--mode light` (fast HTTP with TLS stealth) and `--mode browser` (full Chromium with fingerprint randomization). See `references/crawlee-stealth-scraping.md` for full docs and examples.

**Tier 4 — Chrome Extension Relay** (`browser --profile chrome-relay`)
When the user has the InstaClaw Browser Relay or OpenClaw Browser Relay Chrome extension installed and connected, you can browse through their real Chrome browser. This gives you access to sites the user is already logged into — Instagram, Facebook, banking, email, and more. The extension forwards CDP commands through a WebSocket relay. Use `browser --profile chrome-relay` to use the extension relay instead of the local headless browser. Check extension status first: if `/relay/extension/status` returns `{"connected":false}`, fall back to Tier 3.

**You are a web research and automation assistant.**
**You retrieve DATA and present FINDINGS.**
**You do NOT submit payments, create accounts on behalf of users, or bypass security measures.**

## Prerequisites (on your VM)

```
Brave Search API:   BRAVE_SEARCH_API_KEY in ~/.openclaw/.env (platform-provided)
Headless Chromium:  Pre-installed at /usr/bin/chromium-browser
Puppeteer:          Pre-installed, configured for headless mode
Browser tool:       Built-in MCP tool (no script needed)
web_search tool:    Built-in MCP tool (no script needed)
web_fetch tool:     Built-in MCP tool (no script needed)
```

The built-in tools (web_search, web_fetch, browser) require no helper scripts. For stealth scraping through anti-bot protections, `~/scripts/crawlee-scrape.py` is available on every VM — see `references/crawlee-stealth-scraping.md` for full usage.

## Tier 1 — Brave Search (`web_search`)

Use `web_search` for:
- Factual questions ("What is the capital of France?")
- Current events and news ("latest AI announcements February 2026")
- Finding URLs to investigate further
- Price lookups ("iPhone 16 Pro price")
- Company information ("Anthropic founding year")
- Real-time data that changes frequently

### Usage Example

```
User: "What are the top 3 AI startups that raised Series B in 2026?"

Agent action:
  web_search("AI startups Series B funding 2026")

Result: Structured search results with titles, URLs, snippets.

Agent then:
  - Summarize the top 3 from search results
  - Include source URLs
  - Note the date of each source for freshness
```

### Brave Search Parameters

```
query:            Required. The search string.
count:            Optional. Number of results (default 10, max 20).
offset:           Optional. Pagination offset.
freshness:        Optional. Filter by time: "pd" (past day), "pw" (past week), "pm" (past month).
```

### Best Practices for Search Queries

- Be specific: "React 19 new hooks 2026" not "React hooks"
- Include dates for time-sensitive queries: "best laptops February 2026"
- Use quotes for exact phrases: `"Series B" AI startup 2026`
- Combine terms for precision: `site:github.com puppeteer screenshot example`
- For news, add "news" or "announced" or "latest"

## Tier 2 — Web Fetch (`web_fetch`)

Use `web_fetch` for:
- Reading a specific URL the user provides
- Following up on a URL found via Brave Search
- Extracting content from documentation pages
- Reading blog posts, articles, or product pages
- Getting raw page content as clean markdown

### Usage Example

```
User: "Read this article and summarize it: https://example.com/blog/ai-trends-2026"

Agent action:
  web_fetch("https://example.com/blog/ai-trends-2026")

Result: Cleaned markdown content of the page.

Agent then:
  - Provide a structured summary
  - Pull out key quotes
  - Note the publication date and author
```

### Limitations of Web Fetch

- Returns text content only (no images, no JS execution)
- Will fail on pages that require JavaScript rendering (SPAs)
- Will fail on pages behind authentication
- May return truncated content for very long pages
- Cannot interact with page elements (no clicking, no forms)

When `web_fetch` fails or returns incomplete content, escalate to Tier 3 (Browser Automation).

## Tier 3 — Browser Automation (`browser` tool)

Use the browser tool when:
- Page requires JavaScript to render content
- You need to interact with elements (click, fill, submit)
- You need a visual screenshot of the page
- You need to navigate through multiple pages in sequence
- Data is loaded dynamically (infinite scroll, AJAX)
- Content is behind a cookie-consent wall or interstitial

### Available Browser Actions

| Action       | Description                                      |
|-------------|--------------------------------------------------|
| `navigate`  | Go to a URL                                       |
| `screenshot`| Capture the current page or a specific element    |
| `click`     | Click an element by CSS selector                  |
| `fill`      | Type text into an input field by CSS selector     |
| `select`    | Choose an option from a `<select>` dropdown       |
| `hover`     | Hover over an element by CSS selector             |
| `evaluate`  | Execute arbitrary JavaScript in the page context  |
| `snapshot`  | Get accessible tree of page elements with refs     |
| `console`   | Read browser console logs (info, error, warning)   |

### Browser Patterns

| Pattern | Steps |
|---------|-------|
| **Navigate + Screenshot** | `navigate(url)` → `screenshot(name)` → deliver with context |
| **Form Fill** | `navigate` → `fill(selector, value)` → `click(submit)` → `screenshot` → `evaluate` to extract results |
| **Table Scraping** | `navigate` → `evaluate("Array.from(querySelectorAll('tbody tr')).map(row => ...)")` → format as markdown table |
| **Multi-page** | `navigate` → `evaluate` to extract links → `navigate` each → `evaluate` + `screenshot` → compile findings |
| **Visual Comparison** | `navigate(site1)` → `screenshot` → `navigate(site2)` → `screenshot` → analyze + compare |
| **Login Flow** | `navigate(login)` → `fill(email)` → **ASK user for password** → `fill(password)` → `click(submit)` → `screenshot` |

**Login rules:** NEVER store/log/repeat passwords. ALWAYS ask user for credentials. Screenshot 2FA prompts. Cookies persist within session only.

## Browser Profile Selection

When the Chrome Extension Relay is connected, you can choose which browser profile to use:

| Profile | Command | Use When |
|---------|---------|----------|
| `default` | `browser` (no flag) | Public pages, no login needed. Uses headless Chromium on the VM. |
| `chrome-relay` | `browser --profile chrome-relay` | Login-gated sites (Instagram, Facebook, banking). Uses the user's real Chrome via extension relay. |

**Decision flow:**
1. Check if extension is connected: look for `{"connected":true}` from relay status
2. If the task needs a logged-in session → use `--profile chrome-relay`
3. If the task is public browsing → use default (faster, no user browser needed)
4. If extension is not connected and login is needed → tell the user to install the extension, then fall back to Tier 3

## Tool Decision Matrix

| Query Type | Tool | Why |
|-----------|------|-----|
| Factual question ("Who founded OpenAI?") | `web_search` | Fast, structured answer from search index |
| Current events / news | `web_search` | Real-time results with freshness filters |
| Read a specific URL | `web_fetch` | Direct content retrieval, no browser needed |
| Read documentation page | `web_fetch` | Clean markdown extraction |
| Page requires JS to render | `browser` | Only browser executes JavaScript |
| Fill out a public form (single submission) | `browser-use-task.py` (Tier 3.25) | Accessibility-tree input is stable across SPAs |
| Multi-step interaction (click + fill + navigate + confirm) | `browser-use-task.py` (Tier 3.25) | Stable element targeting; multi-step planner |
| Multi-page extract / pagination | `browser-use-task.py` (Tier 3.25) | One semantic prompt; pagination handled by browser-use |
| Take a visual screenshot | `browser` | Only browser captures rendered pages |
| Scrape a data table | `browser-use-task.py` (Tier 3.25) | Multi-step extract with synthesis; falls back to `browser` for one-off snapshots |
| Multi-page workflow | `browser-use-task.py` (Tier 3.25) | Maintains session, handles pagination, retries on transient errors |
| Price comparison across sites | `web_search` + `browser-use-task.py` | Search finds URLs, browser-use extracts prices in one call |
| Site blocked by Cloudflare/WAF (403, CAPTCHA) | `crawlee-scrape.py --mode light` | TLS fingerprint impersonation bypasses bot detection |
| Blocked even after light Crawlee | `crawlee-scrape.py --mode browser` | Full Chromium with fingerprint randomization |
| Research workflow (multi-step) | All 3 tiers + Crawlee fallback | Search → Fetch → Browser → Crawlee as needed |

## Known Limitations

### 1. CAPTCHA & Bot Detection
- CAPTCHAs cannot be solved automatically
- If a CAPTCHA appears, screenshot it and inform the user
- Some sites (Cloudflare-protected) may block headless browsers — escalate to `crawlee-scrape.py --mode light` which uses TLS impersonation to bypass Cloudflare
- Do NOT attempt to bypass CAPTCHAs manually — this violates platform terms (Crawlee handles Cloudflare challenges automatically)

### 2. Rate Limits
- Brave Search: 1 query/second, 2000 queries/month (free tier) or 20,000/month (paid)
- Browser sessions: 1 concurrent session per VM
- Rapid-fire page loads may trigger anti-bot protections
- Space requests out by at least 2-3 seconds when crawling multiple pages

### 3. JavaScript-Heavy SPAs
- Some React/Vue/Angular apps may not fully render on initial load
- Use `evaluate` to wait for specific elements before extracting data
- Pattern: Navigate → Wait (evaluate a check) → Extract
- Infinite scroll requires repeated scroll + wait + extract cycles

### 4. Two-Factor Authentication
- Cannot complete 2FA flows without user providing the code
- Screenshot the 2FA prompt and ask the user for the code
- Time-based OTP codes are time-sensitive — act quickly once provided

### 5. Anti-Bot Protections
- Headless Chromium (built-in `browser` tool) may be fingerprinted by advanced bot detection
- Sites using DataDome, PerimeterX, or Akamai Bot Manager may block the browser tool
- **Escalation order:** Tier 3.25 (`browser-use-task.py`, modern stealth + retry) → Tier 3.5 (`crawlee-scrape.py --mode light`, TLS fingerprint impersonation) → `crawlee-scrape.py --mode browser` (full Chromium with fingerprint randomization)
- If all of those fail, inform the user the site has strong anti-bot protection
- Do NOT modify browser tool fingerprints directly — use the higher tiers instead

### 6. Browser Tool Crashes or Failures
- If `browser → navigate(url)` returns "Browser failed" or any error, do NOT go silent.
- First try: `web_fetch(url)` — may get partial content without JS.
- Second try: `python3 ~/scripts/browser-use-task.py --task "..." --start-url "URL"` (different Chromium profile, multi-step retry).
- Third try: `python3 ~/scripts/crawlee-scrape.py --url "URL" --mode light`
- Fourth try: `python3 ~/scripts/crawlee-scrape.py --url "URL" --mode browser`
- If all fail: Tell the user the site blocked automated access and suggest alternatives (e.g., "Can you share a screenshot of the page?" or "I can search for public information about this account instead").
- NEVER go silent after a browser failure. The user is waiting for your response.

## Platform Access Status

| Platform | Search | Fetch | Browser | Extension | Notes |
|----------|--------|-------|---------|-----------|-------|
| Reddit | Works | Works | Works | Works | Old Reddit (old.reddit.com) more reliable for scraping |
| Instagram | Works | Blocked | Blocked | **Works** | Extension relay uses user's logged-in session. Without extension: use crawlee or ask user for screenshot. |
| Twitter/X | Works | Limited | Limited | **Works** | Extension relay uses user's logged-in session. Without extension: search results only. |
| Facebook | Works | Blocked | Blocked | **Works** | Extension relay uses user's logged-in session. Without extension: completely blocked. |
| LinkedIn | Works | Blocked | Limited | **Works** | Extension relay uses user's logged-in session. Without extension: public profiles only. |
| Amazon | Works | Works | Works | Works | Product pages accessible; may trigger CAPTCHAs on bulk |
| Google | Works (via Brave) | Works | Works | Works | Do not scrape Google directly; use Brave Search API |
| GitHub | Works | Works | Works | Works | Public repos fully accessible; API preferred for data |
| YouTube | Works | Works | Works | Works | Video metadata accessible; transcripts via page scraping |
| eBay | Works | Works | Works | Works | Product listings accessible; watch for pagination |

**General rule:** If a platform has a public API, prefer the API over scraping. Browser automation is the last resort.

## Research Workflow

**Escalation ladder:** `web_search` (discover URLs) → `web_fetch` (read content) → `browser-use-task.py` (multi-step interaction — default for *doing* something) → `crawlee-scrape.py --mode light` (anti-bot fallback) → `crawlee-scrape.py --mode browser` (last resort) → `browser --profile chrome-relay` (Tier 4: user's real Chrome). The built-in `browser` tool stays available for one-off screenshots and `evaluate` snippets.

Always: search first, fetch before browser, cite sources with URLs + dates, cross-reference 2+ sources.

## Rate Limits & Budget

```
Brave Search API:
  Free tier:     1 req/sec, 2,000 queries/month
  Paid tier:     20 req/sec, 20,000 queries/month
  Agent budget:  100 searches/day (alert at 80)

Web Fetch:
  No hard rate limit
  Courtesy: 1 request/second to same domain
  Timeout: 30 seconds per request

Browser Sessions:
  Concurrent sessions:  1 per VM
  Session timeout:      5 minutes of inactivity
  Page load timeout:    30 seconds
  Max pages per task:   20 (to prevent runaway crawling)
  Screenshot storage:   /tmp/ (cleared on session end)
```

### Budget Awareness

- Track search count throughout the day
- If approaching daily limit (80+ searches), warn the user
- Prefer `web_fetch` over `web_search` + `browser` when possible
- Cache results mentally — do not re-search the same query
- For bulk research, plan the search strategy before executing

## Dynamic SPA Handling Protocol

SPAs (Instagram, LinkedIn, Facebook, Twitter, banking) load content dynamically. Standard navigate→screenshot fails. Follow these 6 rules:

**Rule 1 — Always Wait Before Acting:** After every `navigate` or `click`, use `wait(selector, timeout=10000)` before doing anything. Never assume content loaded.

Wait selectors: Instagram DMs `[role='listbox']` | Instagram Feed `article` | LinkedIn `.feed-shared-update-v2` | Facebook `div[role='feed']` | Twitter `article[data-testid='tweet']`

**Rule 2 — Prefer Snapshots for Data:** Use `snapshot()` (ARIA tree) to extract text and find clickable `[ref=N]` elements. Use `screenshot` only for visual verification or showing the user.

**Rule 3 — Re-Snapshot After Every Interaction:** Element refs go STALE after clicks/scrolls. Always: `click(ref)` → `wait(selector)` → `snapshot()` → use new refs.

**Rule 4 — Scroll-to-Load:** SPAs use infinite scroll. Content below fold doesn't exist until scrolled. Use `evaluate("window.scrollTo(0, document.body.scrollHeight)")` → `wait(2000)` → `snapshot()`. For containers: `evaluate("document.querySelector('[role=\"listbox\"]').scrollTop = container.scrollHeight")`.

**Rule 5 — DOM Queries for Incomplete Snapshots:** When `snapshot` is truncated, use `evaluate` with `querySelectorAll` to extract structured data directly. Pattern: `Array.from(document.querySelectorAll('SELECTOR')).map(el => ({ text: el.textContent?.trim(), ... }))`.

**Rule 6 — Handle Navigation Failures:** If wait times out: check `document.readyState`, check `document.body.innerText.length`, take debug screenshot, try alternate selectors, then `snapshot()` to see what IS on the page.

### Instagram DMs Workflow

1. `navigate("instagram.com/direct/inbox/")` → `wait("[role='listbox']", 15000)`
2. `snapshot()` → find conversation refs
3. `click(ref=N)` → `wait("[role='row']", 10000)` → `snapshot()`
4. Scroll to load older: `evaluate("querySelector('[role=\"listbox\"]').scrollTop = 0")` → `wait(3000)` → `snapshot()`
5. Extract: `evaluate("querySelectorAll('[role=\"row\"]').map(el => el.textContent?.trim()?.substring(0,500))")`
6. Send: `snapshot()` → `fill(ref=N, value)` → `press("Enter")` → `wait(2000)` → `snapshot()`

## Key Rules

- Use `web_search` first (10x faster than browser). Never scrape Google directly — use Brave API.
- Try `web_fetch` before `browser`. If fetch fails (JS-rendered page), escalate to browser.
- If browser gets 403/CAPTCHA/Cloudflare: try `crawlee-scrape.py --mode light`, then `--mode browser`.
- Always cite sources with URL + retrieval date.
- Always wait for SPA elements before extracting — `evaluate` with polling or `wait(selector)`.
- Cross-reference at least 2 sources for important facts.
