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
Full headless Chromium control. Navigate pages, take screenshots, click buttons, fill forms, extract structured data from dynamic pages. Use only when Tier 1 and Tier 2 cannot accomplish the task.

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

### Pattern 1: Navigate + Screenshot

Capture a visual snapshot of any web page.

```
User: "Take a screenshot of https://news.ycombinator.com"

Step 1: Navigate to the URL
  browser → navigate("https://news.ycombinator.com")

Step 2: Take screenshot
  browser → screenshot(name="hackernews-front-page")

Step 3: Deliver
  Return the screenshot image to the user with context:
  "Here is the Hacker News front page as of Feb 22, 2026."
```

Use cases: Visual audits, design reviews, capturing page state before/after changes, documenting errors.

### Pattern 2: Form Fill + Submit

Automate form interactions on public pages.

```
User: "Search for 'headless browser testing' on MDN Web Docs"

Step 1: Navigate to MDN
  browser → navigate("https://developer.mozilla.org")

Step 2: Fill search field
  browser → fill(selector="input[type='search']", value="headless browser testing")

Step 3: Submit form (press Enter or click search button)
  browser → click(selector="button[type='submit']")

Step 4: Wait for results and screenshot
  browser → screenshot(name="mdn-search-results")

Step 5: Extract result titles
  browser → evaluate("
    Array.from(document.querySelectorAll('.search-results h3'))
      .slice(0, 10)
      .map(el => ({ title: el.textContent, url: el.closest('a')?.href }))
  ")

Step 6: Deliver structured results to user
```

### Pattern 3: Data Extraction (Table Scraping)

Extract structured data from HTML tables.

```
User: "Get the list of S&P 500 companies from Wikipedia"

Step 1: Navigate
  browser → navigate("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies")

Step 2: Extract table data via JavaScript
  browser → evaluate("
    const rows = document.querySelectorAll('#constituents tbody tr');
    Array.from(rows).slice(0, 20).map(row => {
      const cells = row.querySelectorAll('td');
      return {
        symbol: cells[0]?.textContent?.trim(),
        company: cells[1]?.textContent?.trim(),
        sector: cells[3]?.textContent?.trim(),
        headquarters: cells[4]?.textContent?.trim()
      };
    }).filter(r => r.symbol);
  ")

Step 3: Format as table and deliver
  Present the data in a clean markdown table.
```

Use cases: Price comparison tables, leaderboards, financial data tables, product spec sheets, directory listings.

### Pattern 4: Multi-page Navigation

Navigate through a sequence of pages to gather information.

```
User: "Go to Product Hunt and get today's top 5 products"

Step 1: Navigate to Product Hunt
  browser → navigate("https://www.producthunt.com")

Step 2: Extract top 5 product names and links
  browser → evaluate("
    Array.from(document.querySelectorAll('[data-test=product-item]'))
      .slice(0, 5)
      .map(el => ({
        name: el.querySelector('h3')?.textContent?.trim(),
        tagline: el.querySelector('[data-test=tagline]')?.textContent?.trim(),
        url: el.querySelector('a')?.href
      }))
  ")

Step 3: Visit first product for details
  browser → navigate(firstProductUrl)

Step 4: Extract details
  browser → evaluate("
    ({
      title: document.querySelector('h1')?.textContent?.trim(),
      description: document.querySelector('[class*=description]')?.textContent?.trim(),
      upvotes: document.querySelector('[class*=vote]')?.textContent?.trim()
    })
  ")

Step 5: Screenshot the product page
  browser → screenshot(name="top-product-detail")

Step 6: Compile and deliver findings
```

### Pattern 5: Screenshot-based Visual Analysis

Use screenshots for visual comparison and analysis.

```
User: "Compare the homepage design of stripe.com and square.com"

Step 1: Navigate to Stripe
  browser → navigate("https://stripe.com")
  browser → screenshot(name="stripe-homepage", width=1280, height=900)

Step 2: Navigate to Square
  browser → navigate("https://square.com")
  browser → screenshot(name="square-homepage", width=1280, height=900)

Step 3: Analyze both screenshots
  Compare visual elements:
  - Layout structure (hero section, navigation, CTA placement)
  - Color palette and typography
  - Content hierarchy
  - Call-to-action prominence
  - Mobile-friendliness indicators

Step 4: Deliver comparison report with both screenshots
```

Use cases: Competitive design audits, A/B test visual verification, accessibility checks, responsive design testing.

### Pattern 6: Login Flow (with Cookie Persistence)

Handle authenticated sessions on platforms where the user provides credentials.

```
User: "Log into my dashboard at https://app.example.com — my username is demo@test.com"

Step 1: Navigate to login page
  browser → navigate("https://app.example.com/login")

Step 2: Screenshot the login form
  browser → screenshot(name="login-page")

Step 3: Fill username
  browser → fill(selector="input[name='email']", value="demo@test.com")

Step 4: ASK the user for password (NEVER guess or assume)
  "I've entered your email. Please provide your password and I'll complete the login."

Step 5: After user provides password, fill it
  browser → fill(selector="input[name='password']", value="USER_PROVIDED_PASSWORD")

Step 6: Click login button
  browser → click(selector="button[type='submit']")

Step 7: Screenshot the result
  browser → screenshot(name="post-login-state")

Step 8: Confirm success or report errors
```

**CRITICAL RULES for Login Flows:**
- NEVER store, log, or repeat passwords back to the user
- ALWAYS ask the user for credentials — never assume or guess
- If 2FA is required, screenshot the 2FA prompt and ask the user for the code
- Do NOT attempt to bypass CAPTCHAs or bot detection
- Cookies persist within a single browser session only
- Sessions do not persist across conversations

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
| Fill out a form | `browser` | Requires element interaction |
| Take a visual screenshot | `browser` | Only browser captures rendered pages |
| Scrape a data table | `browser` | JS evaluation extracts structured data |
| Multi-page workflow | `browser` | Maintains session across navigations |
| Price comparison across sites | `web_search` + `browser` | Search finds URLs, browser extracts prices |
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
- Headless Chromium (browser tool) may be fingerprinted by advanced bot detection
- Sites using DataDome, PerimeterX, or Akamai Bot Manager may block the browser tool
- **Before giving up, escalate to Crawlee:** `python3 ~/scripts/crawlee-scrape.py --url "URL" --mode light` (try light first, then `--mode browser`)
- Crawlee uses TLS fingerprint impersonation and browser fingerprint randomization to bypass these protections
- If Crawlee also fails, then inform the user the site has strong anti-bot protection
- Do NOT modify the browser tool's fingerprints directly — use crawlee-scrape.py instead

### 6. Browser Tool Crashes or Failures
- If `browser → navigate(url)` returns "Browser failed" or any error, do NOT go silent.
- First try: `web_fetch(url)` — may get partial content without JS.
- Second try: `python3 ~/scripts/crawlee-scrape.py --url "URL" --mode light`
- Third try: `python3 ~/scripts/crawlee-scrape.py --url "URL" --mode browser`
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

## Chained Research Workflow

Multi-step research combining all three tiers.

```
User: "Research the top 3 AI code editors and compare their pricing"

STEP 1: Discover candidates (Tier 1 — Search)
  web_search("best AI code editors 2026 comparison")
  web_search("AI code editor pricing plans 2026")
  → Identify top 3: e.g., Cursor, Windsurf, Zed AI

STEP 2: Gather pricing pages (Tier 2 — Fetch)
  web_fetch("https://cursor.com/pricing")
  web_fetch("https://windsurf.com/pricing")
  web_fetch("https://zed.dev/pricing")
  → Extract pricing tiers from clean markdown

STEP 3: Handle JS-rendered pages (Tier 3 — Browser)
  If any pricing page requires JS to render:
  browser → navigate(pricing_url)
  browser → evaluate("
    Array.from(document.querySelectorAll('[class*=pricing], [class*=plan]'))
      .map(el => ({
        plan: el.querySelector('h2, h3')?.textContent?.trim(),
        price: el.querySelector('[class*=price]')?.textContent?.trim(),
        features: Array.from(el.querySelectorAll('li'))
          .map(li => li.textContent.trim())
      }))
  ")

STEP 4: Visual capture for comparison
  browser → screenshot each pricing page (name="cursor-pricing", etc.)

STEP 5: Compile comparison report
  - Markdown table: Editor | Free Tier | Pro Price | Team Price | Key Features
  - Pros/cons for each
  - Source URLs for verification
  - Date of data capture

STEP 6: Deliver to user
  Structured comparison with screenshots attached.
```

### Research Workflow Rules

1. **Start with Search.** Always begin with `web_search` to discover URLs and context.
2. **Try Fetch before Browser.** `web_fetch` is faster and lighter. Use it first.
3. **Escalate to Browser only when needed.** JS rendering, interaction, or screenshots.
4. **Escalate to Crawlee when blocked.** If Tier 2/3 returns 403, CAPTCHA, or Cloudflare challenge, run `crawlee-scrape.py --mode light` before giving up. If light fails, try `--mode browser`.
5. **Cite your sources.** Every claim includes the URL where you found it.
6. **Note data freshness.** Include the date you retrieved the data.
7. **Cross-reference.** Check at least 2 sources for important facts.

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

Modern web apps (Instagram, LinkedIn, Facebook, Twitter, banking portals) are Single Page Applications that load content dynamically. The standard navigate → screenshot workflow fails on these because content loads asynchronously, element references go stale after interactions, and lazy-loaded content requires scrolling to appear. Follow this protocol for reliable SPA browsing.

### Rule 1: Always Wait Before Acting

After every `navigate` or `click` on an SPA, use `browser wait` with a selector before doing anything else. Never assume content has loaded.

```
WRONG:  browser → navigate("https://instagram.com/direct/inbox")
        browser → screenshot(name="dms")        ← page still loading, blank or spinner

RIGHT:  browser → navigate("https://instagram.com/direct/inbox")
        browser → wait(selector="[role='listbox'], [class*='inbox'], [class*='thread']", timeout=10000)
        browser → screenshot(name="dms")         ← content is loaded
```

Common wait selectors by platform:
| Platform | Wait For |
|----------|----------|
| Instagram DMs | `[role='listbox']`, `div[class*='inbox']`, `div[class*='thread']` |
| Instagram Feed | `article`, `div[role='feed']` |
| LinkedIn Feed | `.feed-shared-update-v2`, `div[data-urn]` |
| Facebook | `div[role='feed']`, `div[data-pagelet]` |
| Twitter/X | `article[data-testid='tweet']`, `div[data-testid='cellInnerDiv']` |

### Rule 2: Prefer Snapshots Over Screenshots for Data Extraction

Use `browser snapshot` (ARIA/accessibility tree) instead of `browser screenshot` when you need to extract text, find elements, or understand page structure. Snapshots return structured data; screenshots return pixels.

```
WRONG:  browser → screenshot(name="feed")
        # Then try to read text from the image — slow, error-prone

RIGHT:  browser → snapshot()
        # Returns structured text: links, buttons, headings, text content
        # Element refs like [ref=42] for clicking
```

When to use each:
- **`snapshot`**: Extracting text, finding clickable elements, reading lists/feeds, navigating menus
- **`screenshot`**: Visual verification, showing the user what a page looks like, debugging layout issues
- **Both**: Take a snapshot first to find the right elements, then screenshot for visual confirmation

### Rule 3: Re-Snapshot After Every Interaction

On SPAs, the DOM changes after clicks, scrolls, and form submissions. Element references (`[ref=N]`) from a previous snapshot are STALE after any interaction. Always take a fresh snapshot.

```
WRONG:  browser → snapshot()           → finds [ref=5] "Messages" button
        browser → click(ref=5)         → click succeeds
        browser → click(ref=12)        ← STALE! ref=12 may not exist anymore

RIGHT:  browser → snapshot()           → finds [ref=5] "Messages" button
        browser → click(ref=5)         → click succeeds
        browser → wait(selector="...", timeout=5000)
        browser → snapshot()           → FRESH refs after DOM update
        browser → click(ref=18)        ← valid ref from new snapshot
```

### Rule 4: Use JavaScript Evaluation for Scroll-to-Load Content

SPAs like Instagram and LinkedIn use infinite scroll. Content below the fold doesn't exist in the DOM until you scroll. Use `evaluate` to scroll and trigger lazy loading.

```
# Scroll down to load more content
browser → evaluate("window.scrollTo(0, document.body.scrollHeight)")
browser → wait(timeout=2000)    ← wait for new content to load
browser → snapshot()            ← now includes newly loaded content

# Scroll inside a specific container (e.g., Instagram DM thread)
browser → evaluate("
  const container = document.querySelector('[role=\"listbox\"]');
  if (container) container.scrollTop = container.scrollHeight;
")
browser → wait(timeout=2000)
browser → snapshot()

# Load ALL messages in a thread (scroll to top repeatedly)
browser → evaluate("
  const container = document.querySelector('[role=\"listbox\"]');
  if (container) {
    container.scrollTop = 0;   // scroll to top to load older messages
  }
")
browser → wait(timeout=3000)   ← wait for older messages to load
```

### Rule 5: Extract Data via DOM Queries When Snapshots Are Incomplete

When `snapshot` returns truncated or incomplete content, use `evaluate` to extract data directly from the DOM.

```
# Extract all DM messages from Instagram thread
browser → evaluate("
  Array.from(document.querySelectorAll('[role=\"row\"], [class*=\"message\"]'))
    .map(el => ({
      text: el.textContent?.trim()?.substring(0, 500),
      time: el.querySelector('time')?.getAttribute('datetime') || ''
    }))
    .filter(m => m.text)
")

# Extract LinkedIn feed posts
browser → evaluate("
  Array.from(document.querySelectorAll('.feed-shared-update-v2'))
    .slice(0, 10)
    .map(el => ({
      author: el.querySelector('.update-components-actor__name')?.textContent?.trim(),
      content: el.querySelector('.update-components-text')?.textContent?.trim()?.substring(0, 300),
      reactions: el.querySelector('.social-details-social-counts__reactions-count')?.textContent?.trim()
    }))
")

# Extract Facebook feed posts
browser → evaluate("
  Array.from(document.querySelectorAll('[data-pagelet*=\"FeedUnit\"], div[role=\"article\"]'))
    .slice(0, 10)
    .map(el => ({
      text: el.textContent?.trim()?.substring(0, 500)
    }))
")
```

### Rule 6: Handle Navigation Failures Gracefully

SPAs often break the standard page lifecycle. Handle these edge cases:

```
# Page navigated but spinner persists → wait longer with fallback
browser → navigate("https://www.instagram.com/direct/inbox/")
browser → wait(selector="[role='listbox']", timeout=10000)
# If wait times out:
browser → evaluate("document.readyState")              ← check if page loaded at all
browser → evaluate("document.body.innerText.length")    ← check if any content rendered
browser → screenshot(name="debug-state")                ← visual inspection

# Element not found after wait → try alternate selectors
browser → wait(selector="div.inbox-container", timeout=5000)
# If fails:
browser → wait(selector="div[role='main']", timeout=5000)
# If still fails:
browser → snapshot()   ← see what IS on the page, adapt selectors
```

### Instagram DMs — Complete Workflow

This is the most common SPA task. Follow this exact pattern:

```
Step 1: Navigate to DM inbox
  browser → navigate("https://www.instagram.com/direct/inbox/")
  browser → wait(selector="[role='listbox'], div[class*='inbox']", timeout=15000)

Step 2: Snapshot the inbox to find conversations
  browser → snapshot()
  # Look for conversation names/previews in the snapshot

Step 3: Click into a specific conversation
  browser → click(ref=N)   ← ref from snapshot for the conversation
  browser → wait(selector="[role='row'], div[class*='message']", timeout=10000)

Step 4: Snapshot the thread
  browser → snapshot()
  # If thread is long, scroll to load more:

Step 5: Load older messages (if needed)
  browser → evaluate("
    const c = document.querySelector('[role=\"listbox\"], [class*=\"thread\"]');
    if (c) c.scrollTop = 0;
  ")
  browser → wait(timeout=3000)
  browser → snapshot()

Step 6: Extract all visible messages
  browser → evaluate("
    Array.from(document.querySelectorAll('[role=\"row\"], [class*=\"message\"]'))
      .map(el => el.textContent?.trim()?.substring(0, 500))
      .filter(Boolean)
  ")

Step 7: Send a message (if requested)
  browser → snapshot()   ← get fresh refs
  browser → fill(ref=N, value="Your message here")   ← message input ref
  browser → press(key="Enter")
  browser → wait(timeout=2000)
  browser → snapshot()   ← confirm message sent
```

## Common Mistakes

### 1. Using Browser When Search Would Suffice
```
WRONG:  browser → navigate("https://google.com")
        browser → fill(selector="input", value="Python list comprehension")
        browser → click(selector="button")

RIGHT:  web_search("Python list comprehension syntax")
```
Search is 10x faster and does not consume browser resources.

### 2. Scraping Google Directly
```
WRONG:  browser → navigate("https://www.google.com/search?q=...")
        browser → evaluate("extract results")

RIGHT:  web_search("your query here")
```
Google blocks headless browsers aggressively. Brave Search API exists for this purpose.

### 3. Not Waiting for Dynamic Content
```
WRONG:  browser → navigate(spa_url)
        browser → evaluate("document.querySelector('.results').innerHTML")
        // Returns null because React hasn't rendered yet

RIGHT:  browser → navigate(spa_url)
        browser → evaluate("
          await new Promise(resolve => {
            const check = setInterval(() => {
              if (document.querySelector('.results')) {
                clearInterval(check);
                resolve();
              }
            }, 500);
            setTimeout(() => { clearInterval(check); resolve(); }, 10000);
          });
          document.querySelector('.results').innerHTML;
        ")
```
Always wait for elements to appear before extracting data from SPAs.

### 4. Ignoring Failed Fetches
```
WRONG:  web_fetch(url) → gets error/empty → report "I couldn't find information"

RIGHT:  web_fetch(url) → gets error → escalate to browser
        browser → navigate(url)
        browser → screenshot(name="page-state")
        browser → evaluate("document.body.innerText")
```
A failed fetch often means the page needs JS. Escalate, do not give up.

### 5. Not Citing Sources
```
WRONG:  "The iPhone 16 Pro starts at $999."

RIGHT:  "The iPhone 16 Pro starts at $999 (source: https://apple.com/iphone-16-pro/, retrieved Feb 22, 2026)."
```
Always include the URL and retrieval date. Web data changes constantly.

## Priority Deployment Actions

1. **CRITICAL: Deploy Brave Search API key to all VMs** — Single biggest capability unlock. Without it, agents cannot search the web. Cost: $5/month for Pro tier (10,000 queries). Shared key for All-Inclusive users.
2. **Add web search to heartbeat cycle** — Once Brave Search is live, agents can search for mentions, news, and opportunities during heartbeat. This powers proactive work-finding.
3. **Pre-build the brand asset extraction workflow** — Most common browser task (used by Remotion skill). Make it a callable sub-workflow that any skill can invoke.
4. **Document the Cloudflare problem** — Agents need to know which sites they can't access and have a pre-written response for users: "This site has bot protection. You'll need to [alternative]."

## Quality Checklist

- [ ] Used web_search for discovery (didn't rely only on URLs user provided)
- [ ] Tried web_fetch first for content (faster than browser)
- [ ] Escalated to browser only when web_fetch couldn't handle JS-rendered content
- [ ] Cited all sources with URLs
- [ ] Took screenshots of key findings for visual evidence
- [ ] Tried crawlee-scrape.py before reporting a site as blocked (403/CAPTCHA/Cloudflare)
- [ ] Noted any sites that were blocked even after Crawlee escalation
- [ ] Cross-referenced information across multiple sources
- [ ] Flagged anything that seemed unreliable or outdated
- [ ] Research is synthesis with insights, not just a list of links

## Future Improvements (Roadmap)

1. **Brave Search API fleet deployment** (CRITICAL — immediate)
2. **CAPTCHA solving service** (2Captcha integration) — unlocks 50%+ more sites
3. **Session persistence** (save/restore browser cookies) — enables authenticated workflows
4. **Residential proxy network** — avoid bot detection
5. **Parallel browser tabs** — faster data collection
6. **Credential vault** — encrypted storage for platform credentials (not plaintext)
7. **Platform connector library** — pre-built integrations for common platforms (GitHub, Stripe, etc.)
8. **Screenshot annotations** — highlight elements, draw boxes for visual debugging
9. **Rate limit handling** — exponential backoff, request queuing, per-domain tracking
