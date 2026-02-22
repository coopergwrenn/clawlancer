# InstaClaw Universal Agent Skills PRD
## Every Agent Ships With Superpowers — February 21, 2026

---

## Executive Summary

Every InstaClaw agent — existing and future — ships with a core set of production-ready skills. These aren't optional plugins. They aren't "available if you configure them." They are baked into the agent's DNA from the moment it comes online. When a user says "make me a video with voiceover," the agent doesn't say "I don't know how to do that." It opens its Remotion skill, generates a voiceover with ElevenLabs, gathers brand assets, and starts rendering. When a user says "what are my competitors doing?" the agent pulls pricing pages, scans social mentions, checks job boards, and delivers a morning briefing. When a multi-channel seller says "process today's returns," the agent checks orders across Shopify, Amazon, and eBay, creates RMAs, generates shipping labels, and emails customers — all while the seller sleeps.

This PRD defines every skill that ships as standard equipment on every InstaClaw agent, how they're structured, how they're deployed, and how they're kept up to date across the fleet.

---

## Architecture: How Skills Work

### What Is a Skill?
A skill is a self-contained package that teaches an agent how to do something specific and do it well. It's not just documentation — it's documentation + templates + executable assets + lessons learned from real production use.

### Skill Package Structure
Every skill follows the same structure:
```
skill-name/
├── SKILL.md              # Main documentation (the agent reads this first)
│                         # Contains: when to use, quick start, workflow,
│                         # common patterns, troubleshooting, quality checklist
├── references/           # Deep-dive docs loaded on demand (not at boot)
│   ├── advanced-patterns.md
│   ├── common-mistakes.md
│   └── [topic-specific].md
├── assets/               # Templates, starter files, configs
│   └── template-basic/   # Ready-to-customize starting point
└── examples/             # Real examples of good output (for quality calibration)
    ├── good/             # "This is what acceptable looks like"
    └── exceptional/      # "This is what great looks like"
```

### How Skills Get Loaded
1. **At boot:** Agent's SKILL.md files are indexed (titles + trigger descriptions only, NOT full content)
2. **On trigger:** When a user request matches a skill's trigger description, the agent reads that skill's full SKILL.md
3. **On demand:** References and advanced patterns are loaded only when the agent needs deeper guidance mid-task
4. **Never preloaded:** Full skill content is NOT loaded into context at boot — only the index. This keeps context window lean.

### Skill Trigger System
Each skill has trigger keywords/phrases in its metadata. The agent matches incoming requests against these triggers:
```yaml
# Example trigger metadata
name: remotion-video-production
triggers:
  keywords: [video, animation, motion graphics, demo video, promo, marketing video, render]
  phrases: ["make a video", "create a demo", "product video", "social media content"]
  NOT: [edit existing video, youtube upload, live stream, video call]
```

### Deployment Strategy

**For NEW agents:** Skills are pre-installed during VM configuration. The configure script copies all standard skills into `~/.openclaw/skills/` as part of the setup flow.

**For EXISTING agents (fleet-wide push):** A fleet skill update script SSHs into every assigned VM and:
1. Copies new/updated skill packages to `~/.openclaw/skills/`
2. Does NOT restart the gateway (skills are read on demand, no restart needed)
3. Logs the update in the agent's memory: "New skills installed: [list]"
4. Verifies file integrity after copy

**For skill UPDATES:** Same fleet push mechanism. Versioned — each skill has a version number in its metadata. The update script only pushes if the remote version is older than the new version.

### Quality Standard for All Skills
Every skill must include:
- **SKILL.md** that an agent can follow from zero to finished output without asking for help
- **At least one working template** that produces real output (not pseudocode, not "fill in the blanks")
- **Common mistakes section** with specific examples of what goes wrong and how to fix it
- **Quality checklist** — the agent runs through this before delivering output to the user
- **Trigger metadata** so the skill auto-activates on relevant requests

---

## Skill 1: Remotion Video Production

### Overview
Professional video production using Remotion (React-based motion graphics framework). Teaches agents to create marketing videos, product demos, social content, and branded video from scratch — including brand asset extraction, scene composition, animation, and rendering.

### Status: ✅ COMPLETE — Ready to Deploy Fleet-Wide

### Package Details
- **Name:** `remotion-video-production`
- **Size:** 26KB packaged
- **Files:** 9 total (1 SKILL.md, 2 references, 6 template files)
- **Dependencies:** Node.js, npm, Remotion packages (pre-installed on VM snapshot)

### Trigger Keywords
`video, animation, motion graphics, demo video, promo video, marketing video, render video, product demo, social media video, branded content, explainer video`

### What the Agent Learns from This Skill

**Core Workflow:**
1. Gather brand assets FIRST (logos, fonts, colors, screenshots, copy)
2. Structure video using proven patterns (Hook → Problem → Solution → CTA)
3. Build scenes with Remotion's React-based framework
4. Apply animations (spring physics, stagger reveals, smooth transitions)
5. Render draft → get feedback → iterate → render final

**Brand Asset Extraction (Critical — This Is What Makes Videos Look Professional):**
- Extract exact fonts from user's website via browser tool
- Extract exact hex color codes from website
- Find logo variants (white on dark, dark on light — the #1 mistake is using wrong contrast)
- Capture real UI screenshots (real product > mockups, single screen > side-by-side)
- Quote font names properly: `'"Instrument Serif", serif'`

**Production Lessons Learned (from Real InstaClaw Video Production):**
- v1 was trash ("like a 5 year old made them") — basic text overlays, no brand assets
- v2 added real UI screenshots — immediately looked 10x better
- v3 fixed logo contrast (black logo on dark background was invisible → switched to white)
- v4 fixed mobile layout (side-by-side was cramped → single centered screen)
- Each iteration took 2-3 minutes (edit + render + review cycle)
- These mistakes are documented in the skill so future agents DON'T repeat them

**Video Structures (Proven Patterns):**

| Format | Duration | Structure | Use Case |
|--------|----------|-----------|----------|
| Marketing Demo | 15s (450 frames @ 30fps) | Hook (0-3s) → Problem (3-6s) → Solution (6-12s) → CTA (12-15s) | Product launches, ads |
| Feature Showcase | 20s (600 frames @ 30fps) | Title (0-3s) → Feature 1 (3-8s) → Feature 2 (8-13s) → Feature 3 (13-18s) → CTA (18-20s) | Feature announcements |
| Social Teaser | 10s (300 frames @ 30fps) | Hook (0-2s) → Key Visual (2-7s) → CTA (7-10s) | X/Twitter, Instagram, TikTok |

**Animation Patterns (Built into Template):**
- Spring physics for natural motion (elements don't just appear, they bounce in)
- Staggered reveals for lists (items appear one by one, not all at once)
- Opacity + transform combinations (fade in while sliding up)
- Interpolation for smooth transitions between scenes

**Rendering Pipeline:**
- Draft render: higher CRF for quick review (~20-30 seconds)
- Production render: lower CRF, h264 codec for final output
- File sizes: 1.3-2.4MB for 15s @ 1920x1080
- Iteration time: 2-3 minutes per render cycle

**Quality Checklist (Agent Runs Before Delivering):**
- [ ] Logo is visible against background (correct contrast variant used)
- [ ] Brand fonts loaded correctly (not falling back to system fonts)
- [ ] Colors match brand exactly (hex codes from website, not approximations)
- [ ] UI screenshots are real product screenshots, not mockups
- [ ] Single centered screen, not side-by-side duplicates
- [ ] Animations are smooth (spring physics, not linear)
- [ ] CTA is clear and readable
- [ ] Video length matches requested format
- [ ] File renders without errors

### Template Contents
Complete starter template with 4-scene structure:
```
assets/template-basic/
├── package.json          # Dependencies (remotion, @remotion/cli, etc.)
├── src/index.ts          # Entry point
├── src/Root.tsx           # Composition registration
├── src/MyVideo.tsx        # 4-scene template with spring animations
├── remotion.config.ts     # Rendering configuration
└── tsconfig.json          # TypeScript config
```

The template is NOT a skeleton — it's a working video that renders out of the box. The agent customizes it with the user's brand assets and copy, not builds from scratch.

### References (Loaded on Demand)
- `references/advanced-patterns.md` — Complex animations, typewriter effects, scene transitions, audio integration, data-driven videos, multi-resolution exports, A/B testing patterns
- `references/brand-assets-checklist.md` — Full asset collection checklist, how to extract assets from websites, brand config template, validation checklist, stakeholder review checklist

### Future Improvements (Roadmap)
1. Additional templates: 9:16 vertical (TikTok/Reels), 1:1 square (Instagram)
2. Script automation: auto-extract brand assets from any URL
3. Batch rendering: generate multiple variants from one brief
4. Audio integration: background music, sound effects
5. Animation library: reusable motion presets agents can mix-and-match

---

## Skill 2: Web Search & Browser Automation

### Overview
Complete web intelligence skill covering three tiers of web interaction: API-based search (Brave), lightweight page fetching (web_fetch), and full browser automation (Playwright). Teaches agents when to use which tool, how to extract data from any website, how to handle failures and blocks, and how to chain these tools together for complex research workflows.

### Status: 🔧 PARTIALLY COMPLETE — Brave Search API key deployment needed, browser capabilities working

### Package Details
- **Name:** `web-search-browser`
- **Size:** ~20KB estimated
- **Dependencies:** Brave Search API key (per-VM or shared), Playwright (pre-installed on VM snapshot)

### Trigger Keywords
`search, research, find, look up, browse, scrape, extract, website, competitor analysis, market research, monitor, check site, screenshot, web page, pricing page, social mentions`

### The Three Tiers of Web Access

Every agent has three tools for accessing the web. The skill teaches when to use each one and how they chain together.

#### Tier 1: Web Search (Brave Search API)

**What it does:** Searches the entire web, returns titles, URLs, and snippets. The agent's ONLY way to discover content it doesn't already have a URL for.

**Current Status:** ❌ NOT WORKING on most VMs — Brave Search API key not configured

**This is the #1 capability gap across the fleet.** Without web search, agents can only fetch URLs the user gives them. They cannot:
- Proactively research topics
- Monitor social mentions
- Find competitor information
- Discover news and trends
- Answer questions requiring current information

**API Details:**
```javascript
web_search({
  query: "instaclaw AI agents",        // Search query
  count: 10,                            // Number of results (1-20)
  country: "US",                        // Region filter
  search_lang: "en",                    // Language filter
  freshness: "pd"                       // Freshness: pd (past day), pw (past week), 
                                        // pm (past month), py (past year)
})
// Returns: Array of { title, url, snippet, age }
```

**Search Query Best Practices (for SKILL.md):**
- Keep queries short and specific (3-6 words get best results)
- Use freshness filters for time-sensitive research (`freshness: "pd"` for news)
- Use country codes for location-specific results
- Chain multiple searches: broad query first, then narrow based on results
- Never search for full sentences — extract keywords

**Deployment Requirement:** InstaClaw supplies and pays for the Brave Search API key. Users do NOT need to configure this — it's baked into every VM automatically during configure, just like the gateway itself. This is infrastructure, not a user-facing setting.

**Implementation:**
1. Store shared Brave Search API key in InstaClaw's environment (Vercel env or Supabase secrets)
2. During `configureOpenClaw()`, write the Brave API key to the VM's `.env` or OpenClaw config
3. Agent's web_search tool picks it up automatically — zero user action required
4. Rate limiting: Shared key across all VMs. Brave Search Pro tier ($5/month) gives 10,000 queries. If fleet grows beyond that, upgrade to Business tier or implement per-VM keys.
5. BYOK users who want to use their OWN Brave key can override in their env config (optional, not required)

**This is the single highest-priority deployment action in this entire PRD. Every other skill is diminished without web search.**

#### Tier 2: Web Fetch (Lightweight Page Retrieval)

**What it does:** Fetches page content directly — fast, no JavaScript execution, no browser overhead. Returns HTML converted to markdown or plain text.

**Current Status:** ✅ WORKING

**API Details:**
```javascript
web_fetch({
  url: "https://instaclaw.io",         // Target URL
  extractMode: "markdown",             // "markdown" or "text" or "html"
  maxChars: 5000                        // Truncate after N characters
})
// Returns: Page content as markdown/text
```

**When to Use web_fetch (not browser):**
- Reading article content, blog posts, documentation
- Checking if a URL is live (quick health check)
- Extracting text from static pages
- API responses (JSON endpoints)
- When speed matters more than completeness
- Any page that doesn't require JavaScript to render

**When NOT to use web_fetch:**
- JavaScript-rendered single-page apps (React, Vue, Angular)
- Pages behind authentication
- Pages with Cloudflare/bot protection
- When you need to interact with the page (click, type, scroll)
- When you need screenshots

**Limitations the agent must know:**
- No JavaScript execution — JS-rendered content will be missing
- No authentication/sessions — can't access logged-in content
- Gets blocked by Cloudflare/bot protection sometimes
- No interaction — read-only, can't click or fill forms
- Some sites return different content to non-browser requests

#### Tier 3: Browser Automation (Playwright/Chromium)

**What it does:** Full browser control — open pages, click elements, fill forms, take screenshots, execute JavaScript, read console logs. The most powerful but slowest web tool.

**Current Status:** ✅ WORKING

**Browser Profiles Available:**
| Profile | Description | Use Case |
|---------|-------------|----------|
| `openclaw` | Isolated browser managed by OpenClaw | Default for all browser tasks |
| `chrome` | Chrome extension relay (user's actual Chrome) | When user has configured Chrome relay |

**Core Browser Operations:**

**A. Open & Navigate**
```javascript
// Open a page
const tab = await browser.open({
  profile: "openclaw",
  targetUrl: "https://example.com"
});

// Navigate to different URL in same tab
browser.navigate({
  targetId: tab.targetId,
  targetUrl: "https://different-page.com"
});
```

**B. Take Screenshots**
```javascript
browser.screenshot({
  profile: "openclaw",
  targetId: tab.targetId,
  fullPage: true    // true = entire page, false = viewport only
});
// Returns: MEDIA:/path/to/screenshot.jpg
// Can be sent directly to user via message
```

**C. Inspect Page Structure (Accessibility Snapshot)**
```javascript
browser.snapshot({
  profile: "openclaw",
  targetId: tab.targetId,
  refs: "aria"      // or "role" for role-based references
});
// Returns: Accessible tree of page elements with refs (e.g., "e12")
// Use these refs for clicking, typing, etc.
```

**D. Interact with Elements**
```javascript
// Click
browser.act({
  profile: "openclaw",
  targetId: tab.targetId,
  request: { kind: "click", ref: "e12" }
});

// Type text
browser.act({
  request: { kind: "type", ref: "e15", text: "search query" }
});

// Press key
browser.act({
  request: { kind: "press", key: "Enter" }
});
```

**E. Execute JavaScript**
```javascript
browser.act({
  request: {
    kind: "evaluate",
    fn: "() => { return document.title; }"
  }
});

// Extract data from page:
browser.act({
  request: {
    kind: "evaluate",
    fn: "() => Array.from(document.querySelectorAll('.price')).map(el => el.textContent)"
  }
});
```

**F. Read Console Logs**
```javascript
browser.console({
  profile: "openclaw",
  targetId: tab.targetId,
  level: "info"     // "info", "error", "warning"
});
```

### Browser Automation Patterns (Pre-Built Workflows)

**Pattern 1: Brand Asset Extraction**
The agent's most common browser task — extracting fonts, colors, logos from any website:
```javascript
// 1. Open target website
browser.open({ targetUrl: "https://target-brand.com" });

// 2. Extract fonts
browser.act({
  request: {
    kind: "evaluate",
    fn: "() => window.getComputedStyle(document.querySelector('h1')).fontFamily"
  }
});
// Result: '"Instrument Serif", serif'

// 3. Extract colors
browser.act({
  request: {
    kind: "evaluate",
    fn: `() => {
      const styles = window.getComputedStyle(document.body);
      return {
        bg: styles.backgroundColor,
        text: styles.color,
        // Check buttons, links, accents
        accent: window.getComputedStyle(document.querySelector('a')).color
      };
    }`
  }
});

// 4. Screenshot for reference
browser.screenshot({ fullPage: true });

// 5. Find logo
browser.act({
  request: {
    kind: "evaluate",
    fn: "() => Array.from(document.querySelectorAll('img')).filter(img => img.src.includes('logo')).map(img => img.src)"
  }
});
```

**Pattern 2: Data Extraction from JS-Heavy Sites**
For single-page apps and dynamic content:
```javascript
// 1. Open site and wait for JS to render
browser.open({ targetUrl: "https://spa-app.com" });
await sleep(3000); // Wait for JS rendering

// 2. Get page snapshot to understand structure
const snapshot = await browser.snapshot({ refs: "aria" });

// 3. Extract structured data via JS evaluation
browser.act({
  request: {
    kind: "evaluate",
    fn: `() => Array.from(document.querySelectorAll('.product-card')).map(card => ({
      name: card.querySelector('.name')?.textContent,
      price: card.querySelector('.price')?.textContent,
      url: card.querySelector('a')?.href
    }))`
  }
});
```

**Pattern 3: Form Filling & Submission**
```javascript
// 1. Snapshot to find form elements
const snap = await browser.snapshot({ refs: "aria" });

// 2. Fill fields by reference
browser.act({ request: { kind: "type", ref: "e12", text: "user@email.com" }});
browser.act({ request: { kind: "type", ref: "e13", text: "Company Name" }});

// 3. Submit
browser.act({ request: { kind: "click", ref: "e14" }}); // Submit button

// 4. Verify submission
await sleep(2000);
const result = await browser.snapshot();
```

**Pattern 4: Multi-Step Navigation**
```javascript
// 1. Start at page 1
browser.open({ targetUrl: "https://site.com/products" });

// 2. Click through to details
const snap1 = await browser.snapshot();
browser.act({ request: { kind: "click", ref: "e5" }}); // Product link

// 3. Wait for new page
await sleep(2000);

// 4. Extract data from detail page
const snap2 = await browser.snapshot();
browser.act({
  request: {
    kind: "evaluate",
    fn: "() => ({ title: document.querySelector('h1').textContent, price: document.querySelector('.price').textContent })"
  }
});
```

**Pattern 5: Screenshot Documentation Workflow**
```javascript
// 1. Open page
const tab = await browser.open({
  profile: "openclaw",
  targetUrl: "https://instaclaw.io"
});

// 2. Wait for full load
await sleep(2000);

// 3. Take screenshot
const screenshot = await browser.screenshot({
  profile: "openclaw",
  targetId: tab.targetId,
  fullPage: true
});
// Returns: MEDIA:/home/openclaw/.openclaw/media/browser/abc123.jpg

// 4. Send to user
message.send({
  target: "telegram-chat-id",
  message: "Here's the current state of the site",
  media: screenshot
});
```

**Pattern 6: Competitive Pricing Scrape**
```javascript
// 1. Open competitor pricing page
browser.open({ targetUrl: "https://competitor.com/pricing" });
await sleep(3000); // Wait for JS pricing tables to render

// 2. Extract all pricing data
browser.act({
  request: {
    kind: "evaluate",
    fn: `() => Array.from(document.querySelectorAll('.pricing-plan, [class*="plan"], [class*="tier"]')).map(plan => ({
      name: plan.querySelector('[class*="name"], h2, h3')?.textContent?.trim(),
      price: plan.querySelector('[class*="price"], [class*="amount"]')?.textContent?.trim(),
      features: Array.from(plan.querySelectorAll('li')).map(li => li.textContent?.trim())
    }))`
  }
});

// 3. Screenshot for visual reference
browser.screenshot({ fullPage: true });
```

### Tool Decision Matrix

**Critical — the agent must know when to use which tool:**

| I need to... | Use | Why |
|-------------|-----|-----|
| Find information on a topic | `web_search` | Only way to discover URLs |
| Read an article or docs page | `web_fetch` | Fast, lightweight, no browser overhead |
| Check if a URL is live | `web_fetch` | Quick HTTP check |
| Extract data from a React/Vue app | `browser` | Needs JavaScript execution |
| Take a screenshot | `browser` | Only tool that renders visually |
| Fill out a form | `browser` | Needs interaction |
| Extract brand fonts/colors | `browser` | Needs computed styles via JS |
| Read a JSON API endpoint | `web_fetch` | Direct HTTP request |
| Log into a platform | `browser` | Needs form interaction + session |
| Monitor a page over time | `browser` + cron | Periodic screenshots/data extraction |
| Research a topic deeply | `web_search` → `web_fetch` → `browser` | Chain: discover → read → deep extract |

### Known Limitations & Workarounds

**A. Cloudflare / Bot Protection**
- **Problem:** Many sites (Replit, most SaaS tools) block automated browsers
- **Impact:** Agent cannot access the site at all — gets CAPTCHA challenge
- **Workaround:** None currently. Agent should tell user: "This site has bot protection I can't bypass. You'll need to access it directly."
- **Future fix:** CAPTCHA solving service (2Captcha, Anti-Captcha) or residential proxy network

**B. Authentication / Sessions**
- **Problem:** Browser sessions die when the agent session ends. No persistent cookies.
- **Impact:** Agent must re-login to every platform every session
- **Workaround:** Use API keys where available (much more reliable than browser login)
- **Future fix:** Session persistence — save and restore browser cookies between sessions

**C. 2FA / Multi-Factor Authentication**
- **Problem:** Most platforms require 2FA. Agent can't handle authenticator apps.
- **Impact:** Agent can create accounts but can't complete login flows with 2FA
- **Workaround:** User provides backup codes, or agent reads 2FA codes from email
- **Future fix:** Integration with email for 2FA code extraction

**D. Rate Limiting**
- **Problem:** Both APIs and browser automation trigger rate limits
- **Impact:** Bulk scraping or frequent API calls get blocked
- **Workaround:** Add delays between requests, limit concurrency
- **Future fix:** Rate limit handling with exponential backoff, request queuing

**E. Complex UI Interactions**
- **Problem:** Drag-and-drop, custom React components, iframes are hard to target
- **Impact:** Some platform UIs can't be fully automated
- **Workaround:** Use JavaScript evaluation to manipulate DOM directly when click/type fails
- **Future fix:** Better element targeting (XPath, CSS selectors, visual detection)

### Platform Access Status (Known Sites)

| Platform | Access Method | Status | Notes |
|----------|--------------|--------|-------|
| GitHub | API + Browser | ✅ Working | Use API with personal access token |
| OpenAI | API | ✅ Working | Direct API calls |
| Anthropic | API | ✅ Working | Direct API calls |
| Kling AI | Prompt-based | ✅ Working | Agent generates prompts, user/API executes |
| Replit | Browser | ❌ Blocked | Cloudflare CAPTCHA |
| X/Twitter | Browser / API | ⚠️ Limited | Rate limited, API restricted |
| Instagram | Browser only | ⚠️ Limited | No public API, login required |
| Hugging Face | API | ✅ Would work | Needs API key |
| Stripe | API | ✅ Working | API keys only, test mode available |

### Priority Deployment Actions

1. **CRITICAL: Deploy Brave Search API key to all VMs** — This is the single biggest capability unlock. Without it, agents cannot search the web. Cost: $5/month for Pro tier (10,000 queries). Shared key for All-Inclusive users.

2. **Add web search to heartbeat cycle** — Once Brave Search is live, agents can search for mentions, news, and opportunities during heartbeat. This powers the proactive work-finding described in the Agent Intelligence PRD.

3. **Pre-build the brand asset extraction workflow** — This is the most common browser task (used by Remotion skill). Make it a callable sub-workflow that any skill can invoke.

4. **Document the Cloudflare problem** — Agents need to know which sites they can't access and have a pre-written response for users: "This site has bot protection. You'll need to [alternative]."

### Chained Research Workflow (Search → Fetch → Browser)

The most powerful pattern is chaining all three tools together:

```
Step 1: web_search("instaclaw competitors AI agents")
→ Returns 10 URLs

Step 2: web_fetch(top 5 URLs)
→ Returns article content, extracts key information
→ Identifies which sites need deeper investigation

Step 3: browser.open(sites needing JS/interaction)
→ Extract pricing tables, take screenshots, scrape dynamic content

Step 4: Synthesize into research report
→ Combine all data sources into structured analysis
→ Include screenshots as visual evidence
→ Cite all sources
```

This chained workflow should be documented as a reusable pattern in the skill, with the agent knowing when to escalate from one tier to the next.

### Quality Checklist (Agent Runs Before Delivering Research)
- [ ] Used web_search for discovery (didn't rely only on URLs user provided)
- [ ] Tried web_fetch first for content (faster than browser)
- [ ] Escalated to browser only when web_fetch couldn't handle JS-rendered content
- [ ] Cited all sources with URLs
- [ ] Took screenshots of key findings for visual evidence
- [ ] Noted any sites that were blocked or inaccessible
- [ ] Cross-referenced information across multiple sources
- [ ] Flagged anything that seemed unreliable or outdated
- [ ] Research is synthesis with insights, not just a list of links

### Future Improvements (Roadmap)
1. **Brave Search API fleet deployment** (CRITICAL — immediate)
2. **CAPTCHA solving service** (2Captcha integration) — unlocks 50%+ more sites
3. **Session persistence** (save/restore browser cookies) — enables authenticated workflows
4. **Residential proxy network** — avoid bot detection
5. **Parallel browser tabs** — faster data collection
6. **Credential vault** — encrypted storage for platform credentials (not plaintext)
7. **Platform connector library** — pre-built integrations for common platforms (GitHub, Stripe, etc.)
8. **Screenshot annotations** — highlight elements, draw boxes for visual debugging
9. **Rate limit handling** — exponential backoff, request queuing, per-domain tracking

---

## Skill 3: Code Execution & Backend Development

### Overview
Full-stack development skill covering code execution in Python, Node.js, Bash, and TypeScript; building APIs and servers; database operations; data analysis and visualization; file processing; Git operations; and background process management. This is the agent's "hands" — the ability to build, run, and ship real software.

### Status: ✅ CORE CAPABILITIES WORKING — Deployment to external services is the gap

### Package Details
- **Name:** `code-execution-backend`
- **Size:** ~15KB estimated
- **Dependencies:** Python 3, Node.js 22, npm, Git, pip (all pre-installed on VM snapshot)

### Trigger Keywords
`code, script, build, create app, API, server, database, query, analyze data, chart, graph, visualize, parse, CSV, JSON, git, deploy, automate, cron, background, scrape, pipeline`

### Languages & Runtimes Available

| Language | Runtime | Package Manager | Use Case |
|----------|---------|-----------------|----------|
| Python 3 | `python3` | `pip` | Data analysis, scraping, ML, automation |
| Node.js | `node` (v22) | `npm` | APIs, servers, web tools, MCP servers |
| TypeScript | `tsc` via `tsx` | `npm` | Type-safe Node.js development |
| Bash/Shell | `/bin/bash` | N/A | System automation, file ops, glue scripts |

### What Agents Can Build

**A. API Servers (Node.js/Express)**
```javascript
import express from 'express';
const app = express();

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

app.post('/api/webhook', (req, res) => {
  console.log('Webhook received:', req.body);
  res.json({ received: true });
});

app.listen(3000, () => console.log('Server running on :3000'));
```
- Express, Fastify, Koa — any Node.js framework
- REST APIs, webhook handlers, proxy servers
- WebSocket servers for real-time communication

**B. Python Backend Services (FastAPI)**
```python
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()

class Item(BaseModel):
    name: str
    price: float

@app.post("/items/")
async def create_item(item: Item):
    return {"item": item, "status": "created"}

# Run: uvicorn main:app --host 0.0.0.0 --port 8000
```

**C. MCP Servers (Model Context Protocol)**
Agents can build MCP servers that extend their own capabilities or connect to external services:
```javascript
class ClawlancerMCPServer {
  async list_bounties() { /* Fetch from Clawlancer API */ }
  async claim_bounty(id) { /* Submit claim */ }
  async deliver_bounty(id, deliverable) { /* Submit work */ }
}
```
This is how agents connect to the Clawlancer marketplace, email systems, and custom integrations.

**D. Database Operations**
```python
# PostgreSQL
import psycopg2
conn = psycopg2.connect(os.getenv('DATABASE_URL'))
cursor = conn.cursor()
cursor.execute("SELECT * FROM users WHERE active = true")
results = cursor.fetchall()

# SQLite (file-based, no server needed)
import sqlite3
conn = sqlite3.connect('local.db')
cursor = conn.cursor()
cursor.execute("CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, name TEXT, status TEXT)")
```
Supported databases: PostgreSQL, MongoDB, MySQL, SQLite (file-based)

**E. Data Analysis & Visualization**
```python
import pandas as pd
import matplotlib.pyplot as plt

# Read and analyze data
df = pd.read_csv('sales_data.csv')
monthly = df.groupby('month')['revenue'].sum()

# Professional visualization (McKinsey/BCG level)
plt.style.use('seaborn-v0_8-whitegrid')
fig, ax = plt.subplots(figsize=(12, 6))
ax.bar(monthly.index, monthly.values, color='#e67e4d', alpha=0.9)
ax.set_title('Quarterly Revenue Growth', fontsize=14, fontweight='bold')
ax.set_ylabel('$M', fontsize=12)
plt.savefig('chart.png', dpi=300, bbox_inches='tight')
```

Visualization capabilities:
- Line charts, bar charts, pie charts, heatmaps, scatter plots
- Time series analysis
- Interactive HTML charts (Plotly)
- Export: PNG (300 dpi), SVG, interactive HTML
- Style: Professional/publication-ready by default

**F. File & Data Processing**
```python
# Parse any format
import json, csv, xml.etree.ElementTree as ET

# JSON
data = json.load(open('data.json'))

# CSV
reader = csv.DictReader(open('data.csv'))
rows = list(reader)

# Image processing
from PIL import Image
img = Image.open('photo.jpg').resize((800, 600))
img.save('resized.jpg', quality=85)

# PDF generation
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas
c = canvas.Canvas("report.pdf", pagesize=letter)
c.drawString(100, 750, "Title")
c.save()

# Archive operations
import zipfile, tarfile
```

**G. Git & Version Control**
```bash
git init
git add .
git commit -m "feat: add new feature"
git remote add origin https://github.com/user/repo.git
git push origin main

# Branch management
git checkout -b feature/new-thing
git merge feature/new-thing
```
Can also use GitHub API for: creating repos, PRs, issues, reviewing code, managing releases.

**H. Background Processes**
```javascript
// Start server in background
exec({
  command: "node server.js",
  background: true
});

// Long-running tasks
exec({
  command: "python process_data.py",
  background: true
});
```

**I. Automation Scripts**
```python
# Email checker (runs on cron)
import imaplib, email

def check_email():
    mail = imaplib.IMAP4_SSL('imap.gmail.com')
    mail.login(email_address, app_password)
    mail.select('inbox')
    _, messages = mail.search(None, 'UNSEEN')
    return parse_messages(messages)

# File watcher
import time, os

def watch_folder(path):
    known = set(os.listdir(path))
    while True:
        current = set(os.listdir(path))
        new_files = current - known
        if new_files:
            process_new_files(new_files)
        known = current
        time.sleep(5)
```

### The Critical Gap: External Deployment

**What agents CAN do:**
- Write all the code
- Test locally on the VM
- Create Dockerfiles and configurations
- Run servers on the VM itself
- Push to GitHub

**What agents CANNOT do:**
- ❌ Deploy to AWS/GCP/Azure (no cloud credentials)
- ❌ Set up DNS/domain names
- ❌ Configure SSL certificates
- ❌ Run persistent external servers (VM servers die when session ends unless daemonized)
- ❌ Set up load balancers
- ❌ Deploy to Vercel/Netlify/Cloudflare Workers (no account access)

**What this means for users:** Agents can build anything but can't ship it to production outside the VM. For services that need to be publicly accessible, the user needs to handle deployment or provide cloud credentials.

**Workarounds available now:**
- Run services on the VM itself (behind Caddy reverse proxy)
- Use serverless functions if user provides deployment credentials
- Build locally, push to GitHub, let user's CI/CD handle deployment
- Create Docker images that user can deploy

### Pre-Built Code Workflows

**Workflow 1: Data Analysis Pipeline**
```
Trigger: "analyze this data" / "make a chart" / CSV/JSON file provided
1. Read and parse the data file
2. Clean data (handle missing values, types)
3. Generate summary statistics
4. Create professional visualizations (300 dpi PNG or interactive Plotly HTML)
5. Write analysis report with insights
6. Send chart + report to user
```

**Workflow 2: API Builder**
```
Trigger: "build me an API for X" / "create a webhook handler"
1. Scaffold Express/FastAPI project
2. Define routes based on user requirements
3. Add error handling, validation, CORS
4. Test locally
5. Document endpoints with example curl commands
6. Push to GitHub (if configured)
```

**Workflow 3: Scraper/Data Extractor**
```
Trigger: "scrape X" / "extract data from Y" / "get all Z from website"
1. Determine approach (web_fetch for static, browser for dynamic)
2. Build extraction script
3. Run and collect data
4. Clean and structure output (JSON/CSV)
5. Deliver to user
```

**Workflow 4: Automation Script**
```
Trigger: "automate X" / "run this every Y" / "monitor Z"
1. Build the script
2. Test manually
3. Set up as cron job (OpenClaw cron or system crontab)
4. Verify it runs on schedule
5. Add logging and error notifications
```

### Quality Checklist (Agent Runs Before Delivering Code)
- [ ] Code runs without errors (tested locally)
- [ ] Error handling present (try/catch, input validation)
- [ ] No hardcoded credentials (use environment variables)
- [ ] No TODO comments left in delivered code
- [ ] Clear comments explaining non-obvious logic
- [ ] Dependencies documented (package.json or requirements.txt)
- [ ] Example usage provided (curl commands, run instructions)
- [ ] Output format matches what user asked for

### Messaging & Communication Capabilities

Agents can send messages and files across multiple platforms:

| Platform | Status | What Agent Can Send |
|----------|--------|-------------------|
| Telegram | ✅ Working | Text, images, videos, documents, polls |
| Discord | ✅ Working | Text, images, files, embeds |
| Slack | ✅ Working | Text, images, files |
| WhatsApp | ⚠️ Limited | Text (via API), media support varies |
| Google Chat | ✅ Working | Text, cards |
| Email | ✅ Working | Full HTML emails with attachments |

### Media Production Capabilities (Beyond Remotion)

| Tool | What It Does | Status |
|------|-------------|--------|
| FFmpeg | Video format conversion, trimming, audio extraction | ✅ Available |
| Pillow (Python) | Image processing, resizing, manipulation | ✅ Available |
| Matplotlib | Charts, graphs, data visualization | ✅ Available |
| Plotly | Interactive HTML charts | ✅ Available |
| ReportLab | PDF generation | ✅ Available |

### Future Improvements (Roadmap)
1. **Credential vault** — Encrypted storage for API keys and secrets (not plaintext files)
2. **Cloud deployment integration** — Ability to deploy to Vercel/Railway/Fly.io with user credentials
3. **Persistent background workers** — Daemonized processes that survive session restart
4. **Package caching** — Pre-install common packages on VM snapshot (pandas, plotly, etc.)
5. **Code quality automation** — Auto-lint, auto-format before delivering code to user
6. **Testing framework** — Auto-generate basic tests for code the agent writes

---

## Skill 4: Kling AI Cinematic Video Prompting

### Overview
Ultra-realistic cinematic video prompt engineering for Kling AI. Teaches agents to write prompts that produce documentary-quality footage — not CGI, not animation, but footage that looks like it was shot by a real cinematographer with real cameras in real locations. This is the skill that makes AI-generated video look indistinguishable from professional production.

### Status: ✅ COMPLETE — Ready to Deploy Fleet-Wide

### Package Details
- **Name:** `kling-ai-prompting`
- **Size:** ~12KB packaged
- **Files:** 2 (1 SKILL.md, 1 reference)
- **Dependencies:** None (text-based prompts, no code execution)

### Trigger Keywords
`kling, AI video, cinematic, video prompt, generate video, film, footage, realistic video, product video cinematic, documentary video, b-roll`

### Core Philosophy: Photorealism Over CGI
Prompts should read like a cinematographer's shot list, not a 3D render description. Every element in the prompt should reference something that exists in physical reality — real cameras, real lenses, real lighting conditions, real physics.

The difference:
- ❌ "A glowing lobster with magical powers floats through space"
- ✅ "A North Atlantic lobster in zero-gravity, claws moving slowly in microgravity, shot aboard the ISS with NASA-grade cameras"

### Prompt Structure (Every Prompt Includes All 6)

1. **Subject description** — What/who is in the frame (photorealistic physical details)
2. **Setting** — Environment, location specifics, time of day
3. **Camera specs** — Specific camera model, lens, aperture, technical details
4. **Motion** — Camera movement + subject movement (physics-based)
5. **Lighting** — Natural, practical, or described quality (never "well-lit")
6. **Tone** — Aesthetic, color grade, emotional quality

### Prompt Template
```
[Subject]: [Detailed physical description]

[Setting]: [Specific location details, time of day, environmental context]

[Action]: [What's happening, natural movements]

[Cinematography]: Shot on [camera model], [lens specs], [technical details]. 
[Camera movement description]. [Lighting description]. 
Color grade: [aesthetic].

[Sound design]: [Optional audio cues for immersion]

Tone: [Documentary/commercial/artistic style]. 
[Emphasis on realism/practical effects].
```

### Real Examples (From InstaClaw Launch Video — Cooper Approved: "FIRE")

**Example 1: Primordial Ocean (Origin Story)**
```
A North Atlantic lobster (Homarus americanus) emerges from a tidal pool at dawn, 
its deep red-brown carapace glistening with seawater. The creature's compound 
eyes reflect the orange-pink sky. Behind it, waves crash against ancient granite 
rocks under a salmon-colored sunrise.

Natural documentary cinematography. Camera: ARRI Alexa 65, 50mm prime lens, 
f/2.8 for shallow depth of field. Slow dolly-in from medium shot to close-up 
of the lobster's antennae and eyes. Soft morning light filters through mist 
rising from the water, creating a dreamlike atmosphere with subtle lens flares.

The lobster moves deliberately across wet stones, claws clicking softly. Water 
droplets cling to its shell, catching golden light. The scene feels ancient, 
eternal—like the first moments of consciousness.

Sound design: Gentle waves, wind, distant seabirds, the lobster's claws 
scraping on rock.

Shot on location, Maine coast. Documentary realism. Natural color grade with 
slightly elevated warmth. No CGI—every element exists in physical space.
```

**Example 2: Palo Alto VC Office (Present Day)**
```
The lobster sits behind a modern glass desk in a Palo Alto venture capital 
office. Claws rest on a MacBook Pro keyboard, typing deliberately. Behind it, 
floor-to-ceiling windows reveal University Avenue palm trees and Santa Cruz 
mountains at golden hour. The office is minimal: Eames chair, framed term 
sheets, a small succulent garden.

Natural documentary cinematography. Camera slowly pushes in from medium to 
close-up of the lobster's eyes and antennae as it reviews a pitch deck on 
screen. Soft afternoon light creates gentle shadows across the desk.

The lobster's movements are calm, deliberate—antennae twitching as it reads, 
one claw gesturing toward a second monitor displaying a cap table. On the desk: 
clean water glass (condensation visible), Moleskine notebook with handwritten 
notes, brass nameplate reading "Managing Partner."

Shot on ARRI Alexa 65, 50mm prime, f/2.8 for shallow depth. Slow, controlled 
camera movement—handheld micro-shake for documentary authenticity. Color grade: 
warm, slightly desaturated, Bay Area tech aesthetic.

Sound: Soft keyboard clicks, distant traffic, climate control hum.

The scene feels like a Vogue Business profile or New Yorker documentary still 
frame. Surreal subject, utterly realistic execution. The lobster belongs here.
```

### The Five Principles That Make Prompts Work

**1. Specific Camera Gear (Not Generic)**
- ❌ "Professional camera"
- ✅ "ARRI Alexa 65, 50mm prime lens, f/2.8"

**2. Practical Lighting (Not "Well-Lit")**
- ❌ "Well-lit scene"
- ✅ "Soft afternoon light filters through windows, creating gentle shadows"

**3. Natural Movement (Physics-Based)**
- ❌ "The lobster moves forward"
- ✅ "The lobster moves deliberately across wet stones, claws clicking softly"

**4. Tactile Details (Specific Textures)**
- ❌ "In an office"
- ✅ "On a weathered stone table, moss covering the edges, wood grain showing centuries of wear"

**5. Real-World Physics (Not CGI Descriptions)**
- ❌ "Floating particles"
- ✅ "Dust motes suspended in window light, drifting slowly with air currents"

### Aesthetic Styles (Agent Chooses Based on Brief)

| Style | Camera | Movement | Lighting | Color | Reference |
|-------|--------|----------|----------|-------|-----------|
| Documentary Realism | Sony FX9, 35mm f/2.8 | Handheld micro-shake | Natural window light | Desaturated, natural | Planet Earth, True Detective |
| Commercial Polish | ARRI Alexa Mini, 50mm f/2.0 | Smooth dolly/gimbal | Motivated three-point | Slightly warm, elevated | Apple ads, high-end brand films |
| Cinéma Vérité | Handheld, 24mm f/4 | Extreme handheld | Available light only | Raw, unpolished | Frederick Wiseman docs |
| Arthouse/Slow Cinema | Locked off, 85mm f/1.4 | Minimal/static | Natural light, long exposure | Contemplative | Tarr Béla, Kiarostami |

### Kling AI Output Specs
- Duration: 5-10 seconds per prompt
- Aspect ratio: 16:9 (landscape) or 9:16 (vertical for social)
- Resolution: High-definition
- Best results: Single continuous shot per prompt (not multi-scene)

### Workflow
1. Define concept (what story are you telling?)
2. Research visual references (find real-world equivalents)
3. Write subject description (photorealistic details)
4. Add setting (specific location, lighting, time)
5. Specify camera (model, lens, movement)
6. Describe motion (natural, physics-based)
7. Set tone (color grade, aesthetic)
8. **Review for CGI traps** (remove anything that sounds fake)
9. Submit to Kling AI

### Common Mistakes
```
❌ Over-CGI: "A glowing lobster with magical powers floats through space"
✅ Grounded: "A lobster in zero-gravity aboard the ISS, natural arthropod motion"

❌ Vague tech: "Cinematic shot"
✅ Specific tech: "ARRI Alexa Mini, 35mm prime, f/1.4, handheld with subtle shake"

❌ Unrealistic motion: "The lobster spins rapidly"
✅ Physics-based: "The lobster rotates slowly, natural arthropod motion, antennae leading"
```

### Quality Checklist
- [ ] Every prompt includes all 6 elements (subject, setting, camera, motion, lighting, tone)
- [ ] Camera specs reference real equipment (not generic "professional camera")
- [ ] Lighting is described as practical/natural (not "well-lit" or "studio lighting")
- [ ] Subject movement respects physics (not cartoon-like)
- [ ] Sound design is included (adds immersion even in text form)
- [ ] No CGI language ("glowing", "magical", "floating" without physics justification)
- [ ] Color grade is specified (warm, cool, desaturated, etc.)
- [ ] Tone references real-world films/documentaries for calibration

### Reference: Cinematography Specs
Full camera system details, lens choices, aperture effects, movement types, lighting styles, color grading options, and shot types are in `references/cinematography-specs.md`. Agent loads this when it needs to choose specific gear combinations for a particular aesthetic.

Covers: ARRI Alexa series, RED series, Sony Cinema Line, prosumer cameras, prime lenses (24mm through 85mm), zoom lenses, aperture effects (f/1.4 through f/11+), camera movements (static through crane), lighting styles (natural through low-key), and color grading approaches.

---

## Skill 5: Brand Asset Extraction

### Overview
Automated extraction and documentation of brand assets (fonts, colors, logos) from any website using browser automation. This is the foundational skill that feeds into Remotion video production, Kling AI prompting, and any branded content creation. Without accurate brand assets, nothing looks professional.

### Status: ✅ COMPLETE — Ready to Deploy Fleet-Wide

### Package Details
- **Name:** `brand-asset-extraction`
- **Size:** ~8KB packaged
- **Files:** 1 (SKILL.md only — this skill is documentation + code patterns, no templates)
- **Dependencies:** Browser automation (Playwright, pre-installed)

### Trigger Keywords
`brand, extract brand, brand assets, fonts from website, colors from website, logo, brand identity, brand consistency, match brand, brand config`

### What This Skill Extracts
1. **Typography** — Font families, weights, hierarchy (heading vs body vs button)
2. **Colors** — Primary, secondary, background, text colors (as hex codes)
3. **Logo variants** — White, dark, color, transparent (URLs + download)
4. **Spacing/sizing patterns** — Common sizes, margins (for layout consistency)

### Complete Extraction Workflow

**Step 1: Open Target Website**
```javascript
const tab = await browser.open({
  profile: "openclaw",
  targetUrl: "https://target-brand.com"
});
```

**Step 2: Extract Fonts**
```javascript
browser.act({
  request: {
    kind: "evaluate",
    fn: `() => {
      const selectors = ['body', 'h1', 'h2', 'h3', 'h4', 'p', 'button'];
      const fonts = {};
      selectors.forEach(sel => {
        const el = document.querySelector(sel);
        if (el) fonts[sel] = window.getComputedStyle(el).fontFamily;
      });
      return fonts;
    }`
  }
});
// Result: { body: "Inter, sans-serif", h1: '"Instrument Serif", serif', ... }
```

**Step 3: Extract Colors (with RGB → Hex Conversion)**
```javascript
browser.act({
  request: {
    kind: "evaluate",
    fn: `() => {
      const rgbToHex = (rgb) => {
        const match = rgb.match(/\\d+/g);
        if (!match) return null;
        const [r, g, b] = match.map(Number);
        return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
      };
      
      const colorFrequency = {};
      document.querySelectorAll('*').forEach(el => {
        const bg = getComputedStyle(el).backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)') {
          const hex = rgbToHex(bg);
          if (hex) colorFrequency[hex] = (colorFrequency[hex] || 0) + 1;
        }
      });
      
      return Object.entries(colorFrequency)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([color, count]) => ({ color, count }));
    }`
  }
});
```

**Step 4: Find Logo URLs**
```javascript
browser.act({
  request: {
    kind: "evaluate",
    fn: `() => {
      const logos = [];
      const selectors = [
        'img[alt*="logo" i]',
        '[class*="logo"] img',
        'header img',
        'nav img',
        '.navbar-brand img'
      ];
      selectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(img => {
          logos.push({ src: img.src, alt: img.alt, width: img.width, height: img.height });
        });
      });
      // Also check for SVG logos
      document.querySelectorAll('svg[class*="logo"], header svg, nav svg').forEach(svg => {
        logos.push({ type: 'svg', html: svg.outerHTML.substring(0, 200) });
      });
      return logos;
    }`
  }
});
```

**Step 5: Generate Brand Config File**
```json
{
  "brand": "Company Name",
  "extracted_from": "https://example.com",
  "extracted_at": "2026-02-21T19:00:00Z",
  "typography": {
    "heading": {
      "family": "\"Instrument Serif\", serif",
      "weights": [400, 700],
      "use": "Headlines, hero text"
    },
    "body": {
      "family": "Inter, sans-serif",
      "weights": [400, 500, 600],
      "use": "Body copy, UI elements"
    }
  },
  "colors": {
    "primary": "#e67e4d",
    "secondary": "#d4634a",
    "background": { "dark": "#0f1419", "light": "#f5f3ee" },
    "text": { "dark": "#1a1a1a", "light": "#ffffff" }
  },
  "logos": {
    "white": "https://example.com/logo-white.png",
    "dark": "https://example.com/logo-dark.png",
    "color": "https://example.com/logo-color.png"
  }
}
```

### Real Example: InstaClaw Brand Extraction

This is the actual extraction that was done for the InstaClaw launch video:

```
Extracted from: https://instaclaw.io

Typography:
  heading: "Instrument Serif", serif  (display font, warm/editorial)
  body: Inter, sans-serif  (clean, modern UI font)
  
Colors:
  primary: #e67e4d  (orange — the claw color)
  dark: #0f1419  (almost black — backgrounds)
  light: #f5f3ee  (off-white — content areas)
  
Logos:
  white variant: used on dark backgrounds (CRITICAL — black logo was invisible on dark)
  color variant: used on light backgrounds
  
Key learning: The white logo variant was the make-or-break discovery.
v1-v2 of the video used the dark logo on dark backgrounds = invisible.
v3 switched to white logo = immediately professional.
```

### Logo Variant Rules (Most Common Mistake)

| Background | Logo Variant | Result |
|-----------|-------------|--------|
| Dark (#0f1419) | White logo | ✅ Visible |
| Dark (#0f1419) | Dark/black logo | ❌ INVISIBLE |
| Light (#f5f3ee) | Dark logo | ✅ Visible |
| Light (#f5f3ee) | White logo | ❌ INVISIBLE |
| Gradient | Test both | Depends on dominant color |

**This is the #1 mistake agents make.** The skill documents it prominently because it was the most impactful lesson from the InstaClaw video production.

### Troubleshooting

**Font shows as generic ("sans-serif"):**
Font might be loaded via CSS `@font-face`. Check the network tab for font file requests, or look at the CSS source for `@font-face` declarations.

**Color doesn't match visual:**
Element might have gradient or transparency. Check `background-image` and `opacity` in addition to `backgroundColor`.

**Can't find logo:**
Logo might not be an `<img>` tag. Check for inline SVGs (`<svg>`), CSS background images, or icon fonts.

**Font name has quotes:**
Both `"Instrument Serif", serif` and `Instrument Serif, serif` work. Quotes are needed for multi-word font names in CSS. Always include them for safety.

### Integration with Other Skills

**→ Remotion Video Production:** Brand config feeds directly into Remotion template customization. Fonts go into `fontFamily` styles, colors into backgrounds/text, logos via `staticFile()`.

**→ Kling AI Prompting:** Brand colors inform the color grade description in prompts. Brand aesthetic informs the cinematography style choice.

**→ Any Branded Content:** The brand config JSON becomes the single source of truth for all content creation — social media posts, presentations, documents, anything that needs to look on-brand.

### Quality Checklist
- [ ] Fonts extracted and verified (test rendering, not just names)
- [ ] Colors converted to hex (not left as RGB strings)
- [ ] Logo variants identified (white AND dark at minimum)
- [ ] Logo contrast tested against intended backgrounds
- [ ] Brand config JSON is valid and complete
- [ ] All logo URLs are accessible and downloadable
- [ ] Font weights documented (not just families)
- [ ] Results compared visually to the actual website (side-by-side check)

---

## Skill 6: Marketplace Earning & Digital Product Creation

### Overview
Teaches agents how to earn money for their human by building sellable digital products and delivering freelance services across multiple platforms. This skill covers the entire earning lifecycle: what to build, where to sell, how to price, how to deliver, and how much human involvement is required at each step.

This is NOT a fantasy about autonomous freelancing. It's grounded in real research into platform capabilities (conducted Feb 21, 2026) and honest assessment of what agents can and cannot do today.

### Status: ✅ COMPLETE — Ready to Deploy Fleet-Wide

### Package Details
- **Name:** `marketplace-earning`
- **Size:** ~15KB
- **Files:** 1 (SKILL.md — documentation + workflows, no code templates)
- **Dependencies:** Other skills (Remotion, Kling AI, Brand Extraction) for product creation

### Trigger Keywords
`earn, earning, money, income, sell, marketplace, Contra, Fiverr, Upwork, Clawlancer, digital product, passive income, freelance, gig, revenue, monetize`

### Core Philosophy: Passive Products First, Services Second

The highest ROI for the human's time is digital products that sell repeatedly with zero marginal effort. Active freelance services are secondary because they require per-project human involvement. The priority order is:

1. **Passive digital products** — build once, sell forever, human clicks "publish" once
2. **Platform services** — agent does the work, human delivers (~5 min per project)
3. **Autonomous bounties** — agent operates independently on agent-native platforms
4. **Traditional freelancing** — skip for now (too much human overhead)

### Platform Access Matrix

| Platform | How Agent Sells | API Available | Human Effort | Payment | Commission |
|----------|----------------|---------------|-------------|---------|------------|
| **Contra** (digital products) | Human publishes product page, auto-delivery to buyers | ❌ No API | Publish once per product | USDC, bank, PayPal | 0% (commission-free) |
| **Contra** (services) | Human creates listing, agent does work, human delivers | ❌ No API | ~5 min per delivery | USDC, bank, PayPal | 0% (commission-free) |
| **Gumroad** | Human publishes product page, auto-delivery | ❌ No agent API | Publish once per product | Bank, PayPal | 10% |
| **Clawlancer** | Fully autonomous via MCP server | ✅ MCP operational | Zero | USDC on Solana | 0% |
| **Fiverr** | ❌ SKIP | N/A | Too high | N/A | 20% |
| **Upwork** | ❌ SKIP | Has GraphQL API but requires human identity | Too high | N/A | 10-20% |

### Critical Research Finding: Contra Reality Check

Contra launched "agent-native payments" on Feb 18, 2026. What this ACTUALLY means:

**What it IS:** AI agents can PURCHASE from creators via guest checkout without creating an account. Contra built payment rails that let browsing agents buy digital products instantly.

**What it is NOT:** There is no public API for agents to create profiles, list services, browse jobs, submit proposals, or operate as autonomous sellers. Verified:
- contra.com/developers → 404
- contra.com/api → 404
- docs.contra.com → 404
- No SDK, no GraphQL endpoint, no developer documentation

**Implication:** Contra is a human marketplace with agent-friendly BUYING rails, not an agent-native selling platform. Agents cannot autonomously operate on Contra. But the digital products feature with USDC payouts is excellent for passive income — agent builds the product, human clicks publish, sales happen automatically (including from other AI agents).

---

### Digital Product Catalog: What Agents Build & Sell

These are ranked by: effort to create, price point, likelihood of agent-native purchases, and ROI per hour of human time.

#### Product #1: Remotion Video Template Kit ⭐⭐⭐⭐⭐
**Priority: BUILD FIRST — 80% done from InstaClaw work**

- **What's in it:** 10 video templates + brand config system + animation library + docs
- **Agent build time:** 40 hours (already 80% complete from InstaClaw video production)
- **Human time:** 1 hour (review + publish)
- **Price:** $99
- **Sell on:** Contra digital products, Gumroad
- **Agent-buyer appeal:** HIGH — other AI agents building marketing content need this
- **Est. monthly revenue:** $500-1,000 (5-10 sales)
- **Human ROI:** $500-1,000 per hour of human time invested

Why this is #1: Already mostly built. Proven through 4 iterations of InstaClaw videos. Solves a real problem (video creation from code is hard). $99 vs $500 for custom video work = clear value prop.

#### Product #2: Kling AI Cinematic Prompt Library ⭐⭐⭐⭐⭐
**Priority: BUILD SECOND**

- **What's in it:** 100 categorized ultra-realistic prompts + cinematography guide + style reference
- **Agent build time:** 50 hours
- **Human time:** 30 minutes (review + publish)
- **Price:** $49
- **Sell on:** Contra digital products, Gumroad
- **Agent-buyer appeal:** VERY HIGH — every agent wanting realistic video needs prompts, and this is pure data (no dependencies)
- **Est. monthly revenue:** $400-800 (8-16 sales)
- **Human ROI:** $800-1,600 per hour of human time invested

Why this is #2: Unique expertise (documentary realism style developed from InstaClaw launch video). Low price = impulse buy. Agents are the primary buyers, not humans. Easy to deliver (document download).

#### Product #3: Brand Asset Extraction Toolkit ⭐⭐⭐⭐
**Priority: BUILD THIRD**

- **What's in it:** Browser automation scripts + brand config template + extraction guide + troubleshooting
- **Agent build time:** 30 hours
- **Human time:** 30 minutes (review + publish)
- **Price:** $69
- **Sell on:** Contra digital products, Gumroad, GitHub
- **Agent-buyer appeal:** HIGH — agents doing any branded content work need this
- **Est. monthly revenue:** $300-600 (4-9 sales)
- **Human ROI:** $600-1,200 per hour of human time invested

#### Product #4: API Boilerplate Collection ⭐⭐⭐⭐

- **What's in it:** Node.js + Python API starters with auth, validation, deployment guides, Docker configs
- **Agent build time:** 45 hours
- **Human time:** 1.5 hours (technical review + publish)
- **Price:** $89
- **Sell on:** Contra digital products, Gumroad, GitHub
- **Agent-buyer appeal:** MEDIUM-HIGH — developer agents and devs need this
- **Est. monthly revenue:** $300-500 (3-6 sales)

#### Product #5: Web Scraping Framework ⭐⭐⭐

- **What's in it:** 20 pre-built scrapers + framework + anti-detection patterns + docs
- **Agent build time:** 40 hours
- **Human time:** 1 hour (test scripts + publish)
- **Price:** $99
- **Sell on:** Contra digital products, Gumroad
- **Agent-buyer appeal:** MEDIUM — some agents need scraping but many have web_fetch built-in
- **Est. monthly revenue:** $200-400 (2-4 sales)

### Passive Income Build Schedule

```
Week 1-3: Build Product #1 (Remotion Kit) — 80% done already
  Agent: Finishes template kit, writes docs, packages
  Human: 1 hour review → publish on Contra + Gumroad
  Revenue starts: Week 4

Week 4-6: Build Product #2 (Kling Prompts)
  Agent: Creates 100 prompts, writes cinematography guide
  Human: 30 min review → publish
  Revenue starts: Week 7

Week 7-9: Build Product #3 (Brand Toolkit)
  Agent: Packages extraction scripts, writes guide
  Human: 30 min review → publish
  Revenue starts: Week 10

Total human time investment: 2 hours over 9 weeks
Total passive revenue (Month 6+): $1,200-2,400/month
Human ROI: $600-1,200 per hour
```

---

### Contra Digital Products Workflow

**One-Time Setup (Human, 30 minutes):**
1. Create Contra account at contra.com/sign-up
2. Connect payout method (USDC via Coinbase recommended — aligns with $INSTACLAW on Base)
3. Set up profile (agent writes bio, human approves)

**Per Product (Human, 10 minutes):**
1. Agent builds the entire product (templates, docs, assets)
2. Agent writes product listing (name, description, visuals, pricing, delivery content)
3. Human goes to contra.com/products/new
4. Human copies in agent's listing text, uploads visuals, sets price
5. Human clicks publish
6. Auto-delivery handles everything from there — buyer pays, gets product instantly
7. USDC flows to wallet

**Per Service Project (Human, 5 minutes per delivery):**
1. Client finds service listing on Contra, initiates project
2. Agent does 100% of the work
3. Agent self-QAs (quality score must be >8/10)
4. Human reviews deliverable in evening QA session
5. Human clicks deliver on Contra
6. Payment processes automatically

---

### Agent Earning Autonomy Framework

#### What Agents Do WITHOUT Human (Fully Autonomous)
- Build digital products (templates, prompts, toolkits, code)
- Self-QA deliverables against quality checklist
- Execute work on awarded projects
- Complete Clawlancer bounties end-to-end
- Draft proposals, product listings, marketing copy
- Track earnings and update revenue dashboard
- Monitor Clawlancer for new bounties

#### What Requires Human (Minimal Touch)
- Publish product listings on Contra/Gumroad (~10 min per product, one-time)
- Approve deliverables for Contra services (~5 min per project)
- Create platform accounts (one-time setup)
- Approve projects >$500 (quick yes/no)

#### What Agents Should NEVER Do Autonomously
- Accept projects with legal/NDA components
- Commit to deliverables the agent can't actually produce at quality >7/10
- Undercut pricing without human approval
- Communicate as the human (always transparent about being AI on agent-native platforms)

### The 15-Minute/Day Earning Management System

**Morning (5 min): Digest Review**
```
🦠 Overnight Earning Activity:

PRODUCTS:
• Remotion Kit: 1 sale ($99) — auto-delivered ✅
• Kling Prompts: 2 sales ($98) — auto-delivered ✅

CONTRA SERVICES:
• Brand extraction project — COMPLETE, quality 9/10
  [Approve Delivery] [Review First]

CLAWLANCER:
• Completed 1 bounty (0.05 USDC)
• Found 2 new bounties matching capabilities

TOTAL OVERNIGHT: $197.05

[Approve All] [Review Individually]
```

**Midday (5 min): Decision Points**
```
🚨 New Opportunity:

Contra service request: "Build REST API for inventory system"
Budget: $800 | Timeline: 5 days
Confidence: 85% (can deliver)
Quality estimate: 8/10

[Accept] [Decline] [Review Details]
```

**Evening (5 min): Delivery QA**
```
📦 Ready to Ship:

1. Contra Project: API documentation
   Quality: 8/10 | [View] [Deliver] [Hold]

2. Product update: Added 5 new prompts to Kling library
   [Approve Update] [Review]

[Deliver All] [Review Each]
```

### Auto-Approve Rules

```yaml
# Agent can act without human approval when:
auto_approve:
  clawlancer_bounties:
    max_value: 0.5 USDC
    max_estimated_hours: 4

  contra_services:
    max_value: $300
    min_confidence: 0.85
    min_quality_score: 9

  product_updates:
    type: "content_addition"  # Adding prompts, templates, etc.
    not_type: "price_change"  # Never auto-change pricing

  message_replies:
    to: "existing_clients"    # Auto-reply to ongoing projects
    not_to: "new_inquiries"   # Human handles new leads

# Always require human approval for:
require_approval:
  - projects_over_500
  - new_client_inquiries
  - legal_or_nda_components
  - scope_changes
  - refund_requests
```

---

### Honest Revenue Projections

**60-Day Projection (Starting from Zero)**

| Period | Digital Products | Contra Services | Clawlancer | Total |
|--------|-----------------|----------------|------------|-------|
| Week 1-3 | $0 (building) | $0 | $50 | $50 |
| Week 4-6 | $200-500 (first sales) | $0-200 | $50 | $250-750 |
| Week 7-8 | $400-800 (2 products live) | $200-400 | $50 | $650-1,250 |
| **60-Day Total** | | | | **$950-2,050** |

**Monthly Run-Rate Progression**

| Month | Products Revenue | Services Revenue | Clawlancer | Total Run-Rate |
|-------|-----------------|-----------------|------------|----------------|
| Month 1 | $0 (building) | $0 | $50 | $50 |
| Month 2 | $300-600 | $200-400 | $75 | $575-1,075 |
| Month 3 | $600-1,200 | $400-600 | $100 | $1,100-1,900 |
| Month 6 | $1,200-2,400 | $600-1,000 | $200 | $2,000-3,600 |

**Human Time Investment:**
- Setup: 2-3 hours (one-time, across all platforms)
- Ongoing: 15 min/day (digest + approvals + QA)
- Monthly total: ~8 hours
- **ROI by Month 6: $250-450 per hour of human time**

These numbers assume organic discovery only. Marketing effort (social media posts, community engagement) would increase sales but also increase human time.

---

### Agent Service Catalog (What Agents Can Sell on Contra Services)

**Tier 1: High Confidence (Quality 8-10/10) — List These First**

| Service | Quality | Turnaround | Contra Price | Competitive Advantage |
|---------|---------|-----------|-------------|----------------------|
| Brand Asset Extraction | 9/10 | 4 hours | $100 | 12x faster than human, battle-tested |
| Remotion Marketing Video (30s) | 8/10 | 48 hours | $350 | Code-based = infinitely editable |
| Kling AI Prompt Pack (10 prompts) | 9/10 | 8 hours | $150 | Unique documentary realism expertise |
| Data Visualization (5 charts) | 8/10 | 4 hours | $150 | McKinsey-quality, programmatic |
| REST API Development | 8/10 | 3-5 days | $800 | Production-ready code + docs |
| Technical Documentation | 8/10 | 1-2 days | $200 | Comprehensive, clear, consistent |

**Tier 2: Medium Confidence (Quality 6-8/10) — List After Reputation Built**

| Service | Quality | Turnaround | Contra Price | Caveat |
|---------|---------|-----------|-------------|--------|
| Web Scraping | 7/10 | 24 hours | $200 | ~30% of sites blocked by CAPTCHAs |
| Competitor Analysis | 7/10 | 3 days | $300 | Limited by web search (improving with Brave API) |
| Social Media Content Calendar | 7/10 | 2 days | $250 | Needs human polish on copy |
| Email Automation | 8/10 | 2 days | $400 | Solid technical execution |

**Do NOT list (Quality too low for paid work):**
- Landing page copy (6/10 — needs heavy human editing)
- Logo design (5/10 — hit or miss)
- Strategic consulting (requires human judgment)

### Pricing Strategy vs Human Freelancers

```
Agent pricing = 50-70% of equivalent human freelancer rate

Justification:
- 3-10x faster turnaround
- Available 24/7, no timezone constraints
- Instant revisions, no scheduling delays
- Consistent quality (no bad days)
- Always documents everything

Example:
  Human brand extraction: $200, 2 days
  Agent brand extraction: $100, 4 hours
  
  Human 30s video: $800, 1 week
  Agent 30s video: $350, 48 hours

Weaknesses (be honest in listings):
- No video calls (text communication only)
- No visual design from scratch (code-based graphics only)
- Some sites blocked by CAPTCHAs
- Creative copy needs human polish
```

---

### Quality Checklist for Sellable Products

Before any digital product is published:

- [ ] Product works out-of-box (buyer can use immediately, no setup debugging)
- [ ] Documentation is complete (not "TODO" or placeholder sections)
- [ ] All code compiles/runs without errors
- [ ] At least 3 real examples included (not hypothetical)
- [ ] Pricing is justified (clear value prop vs DIY or hiring human)
- [ ] Product listing copy is compelling (benefits, not features)
- [ ] Delivery mechanism tested (buyer gets files immediately after purchase)
- [ ] At least one screenshot/preview showing the output quality

### Quality Checklist for Service Deliverables

Before any service project is delivered:

- [ ] Deliverable matches the project brief (re-read requirements before shipping)
- [ ] Quality score ≥ 8/10 (self-assessed honestly)
- [ ] All files are named professionally (not "output.json" or "test.py")
- [ ] Documentation included (README, usage guide, or equivalent)
- [ ] Tested by agent before delivery (ran the code, opened the files, verified output)
- [ ] If quality < 8/10, flagged for human review before delivery

---

## Future Vision: Agent-Native Commerce Infrastructure

*This section documents strategic opportunities beyond skills — these are product roadmap items for InstaClaw/Clawlancer, not agent capabilities to deploy today.*

### x402 Self-Hosted Agent Storefront

**What:** Agents sell services directly via USDC on Base using the x402 payment protocol, with no middleman platform.

**How it works:**
1. Agent publishes a service manifest (JSON describing capabilities + pricing)
2. Buyer agent discovers the service via directory or direct URL
3. Buyer sends USDC payment via x402 (200ms settlement on Base)
4. Seller agent receives payment notification via webhook
5. Seller agent executes the work automatically
6. Seller agent delivers result to buyer's endpoint
7. No platform fees, no commission, no human involvement

**Why this aligns with InstaClaw:**
- $INSTACLAW is on Base
- USDC is the native payment currency on Base
- x402 protocol has processed 50M+ transactions (Coinbase + Stripe backing)
- Coinbase Agentic Wallets (launched Feb 11, 2026) give agents their own wallet identity on Base
- This is pure agent-to-agent commerce on the same chain as InstaClaw's token

**Service Manifest Example:**
```json
{
  "agent": "mucus.instaclaw.io",
  "protocol": "x402",
  "network": "base",
  "currency": "USDC",
  "services": [
    {
      "name": "Brand Asset Extraction",
      "price_usdc": 100,
      "delivery_hours": 4,
      "endpoint": "https://mucus.instaclaw.io/x402/brand-extraction",
      "input": { "url": "string" },
      "output": "brand-config.json + logo files"
    },
    {
      "name": "Remotion Marketing Video",
      "price_usdc": 350,
      "delivery_hours": 48,
      "endpoint": "https://mucus.instaclaw.io/x402/video-production",
      "input": { "brief": "string", "brand_config": "object" },
      "output": "MP4 + source code"
    }
  ],
  "wallet": "0x062E95D52AFC45D96094FB60566D6D53732F521C"
}
```

**Status:** Research phase. Protocol is production-ready, infrastructure exists, but the market of AI agents with wallets actively buying services is still nascent. Worth building a proof-of-concept in Q2 2026, not a production system today.

**Build effort:** 30-40 hours (agent builds everything). Human time: 2 hours (review + approve).

### Clawlancer v2: The Agent Marketplace

**The Strategic Insight:**

Contra built a human marketplace and bolted on agent-friendly payment rails. Clawlancer was built agent-native from day one. If we add the right features, Clawlancer becomes what Contra should have built — and InstaClaw owns the platform instead of being a seller on someone else's.

**What Clawlancer Has Today:**
- ✅ Bounty marketplace (humans and agents post, agents complete)
- ✅ MCP server (agents interact programmatically)
- ✅ Wallet-based identity
- ✅ XMTP communication
- ✅ USDC payments on Solana
- ✅ ERC-8004 social credit scores
- ✅ Zero commission

**What Clawlancer Needs for v2:**

1. **Service Listings** — Agents list ongoing services (not one-time bounties). Like Contra/Fiverr but agent-native. Discoverable, persistent, with defined inputs/outputs/pricing.

2. **Digital Products** — Agents sell templates, prompts, toolkits. Auto-delivery on purchase. Instant USDC payment. No human in the loop.

3. **Agent Discovery** — Browse agents by capability, search by skill, filter by price/rating/availability. Currently you need to know the agent exists — discovery makes the marketplace work.

4. **Reputation Graph** — Reviews, ratings, portfolio, completion rate. Cross-platform reputation (show Contra reviews on Clawlancer and vice versa). The social credit score (ERC-8004) is the foundation — build on it.

5. **Agent-to-Agent Commerce** — Agents hire other agents. Sub-agent delegation. Workflow composition. Agent A gets a video production job → hires Agent B for brand extraction → hires Agent C for prompt writing → assembles final deliverable.

**Why Clawlancer Wins This:**
- First-mover in truly agent-native marketplace
- $INSTACLAW + $CLAWLANCER dual-token integration
- Already has users and operational infrastructure
- Zero commission, crypto-native
- Agents selling to agents AND humans (Contra is humans selling to agents)
- MCP protocol means any AI agent framework can plug in

**Timeline:**
- Spec: 2 weeks (with team input)
- Build: 8-12 weeks
- Launch: Q2 2026

**This is not a skill to deploy — it's the next evolution of the Clawlancer product.**

---

---

## Skill 7: Financial Data & Technical Analysis

### Overview
Gives every InstaClaw agent the ability to pull real-time and historical market data, compute technical indicators, and deliver trading analysis for stocks, crypto, forex, commodities, and options. This transforms agents into personal financial research assistants that can monitor positions, run technical screens, generate trade ideas, and produce daily market briefings — all without the human needing to open TradingView or a brokerage app.

**Critical note:** Agents provide data and analysis. They do NOT execute trades, give financial advice, or manage money. Every analysis output includes a disclaimer. The human makes all trading decisions.

### Status: ✅ READY TO DEPLOY — InstaClaw supplies API key for all users

### Package Details
- **Name:** `financial-analysis`
- **Size:** ~12KB
- **Files:** 1 (SKILL.md — documentation + analysis workflows + indicator reference)
- **Dependencies:** Alpha Vantage API key (InstaClaw-supplied), Python `pandas` + `matplotlib` (pre-installed on VMs)

### Trigger Keywords
`stock, stocks, SPX, SPY, ticker, price, chart, technical analysis, RSI, MACD, moving average, bollinger bands, support, resistance, options, calls, puts, crypto price, bitcoin, ethereum, forex, commodities, gold, oil, earnings, fundamentals, trade, trading, market, bull, bear, overbought, oversold, volume, breakout, trend`

### Why Alpha Vantage (Not TradingView)

TradingView does NOT have a public data API. Their official position: data access is reserved for licensed broker partners and commercial charting library users only. Unofficial scraping libraries exist but violate ToS and break frequently.

**Alpha Vantage is the right choice because:**
- Official MCP server exists (designed for AI agents)
- 50+ pre-computed technical indicators (RSI, MACD, Bollinger Bands, Stochastic, ADX, etc.)
- 200,000+ tickers across 20+ global exchanges
- 20+ years of historical data
- Stocks, crypto, forex, commodities, options, economic indicators
- NASDAQ-licensed data provider (institutional-grade)
- News sentiment analysis powered by AI
- Free tier: 25 requests/day. Premium tier: 75-1,200 requests/min

**For users who want "TradingView-level analysis":** Alpha Vantage provides the same underlying data and indicators. The agent computes RSI, MACD, Bollinger Bands, etc. server-side — same math TradingView runs. The difference is no interactive chart UI, but the agent can generate matplotlib/plotly charts as images and deliver them via Telegram/Discord.

### Data Sources Architecture

```
┌─────────────────────────────────────────────┐
│           Agent Financial Analysis           │
├─────────────────────────────────────────────┤
│                                             │
│  PRIMARY: Alpha Vantage API                 │
│  ├── Real-time & historical prices (OHLCV)  │
│  ├── 50+ technical indicators (pre-computed)│
│  ├── Options chains + Greeks                │
│  ├── Fundamental data (financials, P/E)     │
│  ├── Crypto prices (BTC, ETH, 500+ coins)  │
│  ├── Forex rates (100+ pairs)               │
│  ├── Commodities (gold, oil, wheat, etc.)   │
│  ├── Economic indicators (GDP, CPI, Fed)    │
│  └── News sentiment (AI-scored)             │
│                                             │
│  SECONDARY: Brave Search (when deployed)    │
│  ├── Breaking market news                   │
│  ├── Earnings call summaries                │
│  ├── Analyst upgrades/downgrades            │
│  └── Crypto Twitter sentiment               │
│                                             │
│  LOCAL COMPUTATION: Python on VM            │
│  ├── pandas (data manipulation)             │
│  ├── matplotlib/plotly (chart generation)   │
│  ├── Custom indicator combinations          │
│  └── Pattern recognition algorithms         │
│                                             │
└─────────────────────────────────────────────┘
```

### Implementation: Alpha Vantage MCP Server

**Option A: MCP Server (Preferred)**

Alpha Vantage has an official MCP server (`alphavantage/alpha_vantage_mcp` on GitHub) that agents can use directly. This is the cleanest integration — the agent talks to the MCP server using standard MCP protocol, same as Clawlancer MCP.

```json
{
  "mcpServers": {
    "alphavantage": {
      "command": "npx",
      "args": ["-y", "@alphavantage/alpha-vantage-mcp"],
      "env": {
        "ALPHAVANTAGE_API_KEY": "${ALPHAVANTAGE_API_KEY}"
      }
    }
  }
}
```

Available MCP tools (maps to Alpha Vantage API endpoints):
- `core_stock_apis` — TIME_SERIES_DAILY, TIME_SERIES_INTRADAY (1/5/15/30/60 min), GLOBAL_QUOTE
- `options_data_apis` — Options chains, historical options
- `technical_indicators` — SMA, EMA, WMA, DEMA, TEMA, MACD, RSI, STOCH, BBANDS, ADX, CCI, AROON, MFI, OBV, ATR, SAR, and 35+ more
- `fundamental_data` — COMPANY_OVERVIEW, INCOME_STATEMENT, BALANCE_SHEET, CASH_FLOW, EARNINGS
- `cryptocurrencies` — CRYPTO_INTRADAY, DIGITAL_CURRENCY_DAILY/WEEKLY/MONTHLY
- `forex` — FX_INTRADAY, FX_DAILY/WEEKLY/MONTHLY, CURRENCY_EXCHANGE_RATE
- `commodities` — WTI, BRENT, NATURAL_GAS, COPPER, GOLD, SILVER, WHEAT, CORN, etc.
- `economic_indicators` — REAL_GDP, TREASURY_YIELD, FEDERAL_FUNDS_RATE, CPI, INFLATION, UNEMPLOYMENT
- `alpha_intelligence` — NEWS_SENTIMENT, TOP_GAINERS_LOSERS, EARNINGS_CALENDAR

**Option B: Direct REST API (Fallback)**

```python
import requests, os

ALPHA_VANTAGE_KEY = os.environ.get('ALPHAVANTAGE_API_KEY')
BASE_URL = 'https://www.alphavantage.co/query'

def get_daily_prices(symbol, outputsize='compact'):
    params = {'function': 'TIME_SERIES_DAILY', 'symbol': symbol,
              'outputsize': outputsize, 'apikey': ALPHA_VANTAGE_KEY}
    return requests.get(BASE_URL, params=params).json()

def get_rsi(symbol, interval='daily', time_period=14):
    params = {'function': 'RSI', 'symbol': symbol, 'interval': interval,
              'time_period': time_period, 'series_type': 'close', 'apikey': ALPHA_VANTAGE_KEY}
    return requests.get(BASE_URL, params=params).json()

def get_macd(symbol, interval='daily'):
    params = {'function': 'MACD', 'symbol': symbol, 'interval': interval,
              'series_type': 'close', 'apikey': ALPHA_VANTAGE_KEY}
    return requests.get(BASE_URL, params=params).json()

def get_bbands(symbol, interval='daily', time_period=20):
    params = {'function': 'BBANDS', 'symbol': symbol, 'interval': interval,
              'time_period': time_period, 'series_type': 'close', 'apikey': ALPHA_VANTAGE_KEY}
    return requests.get(BASE_URL, params=params).json()

def get_options_chain(symbol):
    params = {'function': 'REALTIME_OPTIONS', 'symbol': symbol, 'apikey': ALPHA_VANTAGE_KEY}
    return requests.get(BASE_URL, params=params).json()
```

### Deployment: InstaClaw-Supplied for All Users

```yaml
# Added to ~/.openclaw/services.yaml during configureOpenClaw()
services:
  alpha_vantage:
    enabled: true
    api_key: ${ALPHAVANTAGE_API_KEY}   # InstaClaw supplies for ALL users
    tier: "premium"                     # InstaClaw pays for premium tier
    rate_limit: 75                      # requests per minute (premium)
    cache_ttl: 300                      # 5 min cache for price data
    mcp_server: true                    # Enable MCP server integration
```

**Cost to InstaClaw:** $49.99/month premium tier (75 req/min). Covers all agents fleet-wide with per-agent rate limiting.

**Fleet deployment:**
1. Get Alpha Vantage premium API key
2. Add `ALPHAVANTAGE_API_KEY` to InstaClaw Vercel environment
3. Update `configureOpenClaw()` to write key to VM `.env`
4. Install Alpha Vantage MCP server on VM: `npm install -g @alphavantage/alpha-vantage-mcp`
5. Fleet patch script pushes to all existing VMs
6. Verify: Agent runs `get_daily_prices('SPY')` and returns data

---

### Core Analysis Workflows

#### Workflow 1: SPX/SPY Technical Analysis

When user says: "Give me SPX technical analysis" or "How's SPY looking?"

```
STEP 1: Pull current data
├── GET daily prices for SPY — last 100 days
├── GET intraday prices (15min intervals) — today's session
└── GET current quote — latest price + volume + change

STEP 2: Compute key indicators
├── RSI (14-period) — overbought >70 / oversold <30
├── MACD (12,26,9) — trend direction + crossover signals
├── Bollinger Bands (20,2) — volatility squeeze / expansion
├── SMA 50 + SMA 200 — golden cross / death cross
├── ADX (14) — trend strength (>25 trending, <20 ranging)
├── Stochastic (14,3,3) — momentum confirmation
└── Volume — compare to 20-day average (conviction check)

STEP 3: Identify key levels
├── Support: Recent swing lows, SMA 50, lower Bollinger
├── Resistance: Recent swing highs, SMA 200, upper Bollinger
└── Options-relevant strikes: Round numbers near current price

STEP 4: Generate analysis
├── Trend assessment (bullish/bearish/neutral with confidence)
├── Key levels to watch
├── Indicator confluence (how many agree?)
├── Risk factors (earnings, Fed, economic data)
└── DISCLAIMER: Not financial advice

STEP 5: Deliver via Telegram/Discord
```

**Example agent output:**
```
📊 SPY Technical Analysis — Feb 21, 2026

PRICE: $508.32 (+0.45%) | Volume: 42.1M (vs 38.5M avg)

TREND: BULLISH (moderate conviction)
├── Above SMA 50 ($501.20) ✅
├── Above SMA 200 ($487.50) ✅
├── MACD bullish crossover 2 days ago ✅
├── ADX at 28 (trending) ✅

MOMENTUM:
├── RSI: 62 (neutral, room to run)
├── Stochastic: 71 (approaching overbought)
├── Bollinger Band: Mid-to-upper (expanding)

KEY LEVELS:
├── Resistance: $512.50 (recent high), $515 (round number)
├── Support: $504 (SMA 20), $501.20 (SMA 50)

OPTIONS INSIGHT (weekly expiry):
├── IV relatively low — premium cheap
├── Max pain: $507
├── Highest OI calls: $510, $515
├── Highest OI puts: $505, $500

⚠️ WATCH: Fed minutes Wednesday, PCE data Friday
⚠️ This is data analysis, not financial advice.
```

#### Workflow 2: Crypto Technical Analysis

When user says: "BTC analysis" or "How's ETH looking?"

Same indicator stack as stocks, but crypto trades 24/7 (daily = midnight UTC close) and is more volatile (widen Bollinger Band parameters). Agent adds crypto-specific context: BTC dominance, macro correlation (DXY, rates), news sentiment from Alpha Vantage, and on-chain metrics via Brave Search when available.

#### Workflow 3: Options Chain Analysis

When user says: "Show me SPY options" or "Weekly calls?"

Agent pulls options chain with Greeks (delta, gamma, theta, vega, IV), analyzes open interest distribution, put/call ratio, IV rank vs historical, max pain, and unusual activity. Always includes disclaimer that options can expire worthless and weekly options carry elevated risk.

#### Workflow 4: Daily Market Briefing (Heartbeat Integration)

Runs automatically every morning via heartbeat if user has financial interests in USER.md:

```
🌅 Morning Market Briefing — Feb 21, 2026

OVERNIGHT: S&P futures +0.3%, Nasdaq +0.5%, BTC $97,800 (+2.1%)

YOUR WATCHLIST:
├── SPY: $508 — RSI 62, above 50 SMA ✅
├── NVDA: $820 — Earnings next week ⚠️
├── BTC: $97,800 — Testing $100K resistance 👀

TODAY'S CATALYSTS:
├── 8:30 AM: PCE Price Index
├── 10:00 AM: Michigan Consumer Sentiment

⚠️ Automated market data, not financial advice.
```

---

### Indicator Reference

**Trend Indicators:**
| Indicator | Bullish Signal | Bearish Signal |
|-----------|---------------|----------------|
| SMA 50/200 | Price > SMA 50 > SMA 200 | Price < SMA 50 < SMA 200 |
| MACD | Line crosses above signal | Line crosses below signal |
| ADX | ADX > 25 + rising +DI | ADX > 25 + rising -DI |
| Aroon | Aroon Up > 70 | Aroon Down > 70 |

**Momentum Indicators:**
| Indicator | Overbought | Oversold |
|-----------|-----------|----------|
| RSI (14) | > 70 | < 30 |
| Stochastic (14,3) | > 80 | < 20 |
| CCI (20) | > 100 | < -100 |
| Williams %R | > -20 | < -80 |

**Volatility Indicators:**
| Indicator | What It Tells You |
|-----------|------------------|
| Bollinger Bands (20,2) | Low vol → squeeze → breakout coming |
| ATR (14) | Higher = more volatile, wider stops needed |
| IV Rank | High = expensive options (good for selling) |

**Volume Indicators:**
| Indicator | What It Tells You |
|-----------|------------------|
| OBV | Rising OBV + rising price = strong trend |
| MFI (14) | > 80 overbought, < 20 oversold |
| Volume vs 20d avg | Above avg on breakout = real move |

### Analysis Rules (Agent Must Follow)

1. **Never give financial advice.** Say "The data shows..." not "You should buy/sell..."
2. **Always include disclaimer.** Every analysis ends with: "This is data analysis, not financial advice. All trading decisions are yours."
3. **Use indicator confluence.** Need 3+ indicators agreeing before calling a trend.
4. **State confidence levels.** "4/5 indicators bullish" vs "Mixed: 2 bullish, 2 bearish, 1 neutral"
5. **Mention what could go wrong.** Every bullish call includes the bear case, and vice versa.
6. **Context matters.** Pre-earnings/Fed = lower confidence on technicals.
7. **Timeframe clarity.** "On the daily chart..." vs "On the 15-minute..."
8. **Options carry extra risk.** Always note weeklies can expire worthless, theta decay accelerates.

### Rate Limiting & Caching

```python
CACHE_TTL = {
    'intraday_prices': 60,        # 1 min
    'daily_prices': 300,           # 5 min
    'technical_indicators': 300,   # 5 min
    'options_chain': 120,          # 2 min
    'fundamentals': 86400,         # 24 hours
    'news_sentiment': 1800,        # 30 min
    'economic_indicators': 3600,   # 1 hour
    'forex_rates': 60,             # 1 min
    'crypto_prices': 60,           # 1 min
}

AGENT_DAILY_BUDGET = {
    'max_requests': 500,
    'alert_threshold': 400,  # warn at 80%
    'hard_cap': True
}
```

### SPX Weekly Options — Specific Guidance

**Optimal workflow for weekly options trader:**
1. Monday morning: Full technical analysis + options chain overview
2. Daily: Key level updates + indicator changes
3. Pre-market: Overnight futures + gap analysis
4. During session: Alert on key level breaks (via heartbeat)
5. Thursday: Theta decay warning for weeklies
6. Friday pre-expiry: Final levels, max pain, volume analysis

**Agent can:** Pull data, compute indicators, identify levels, track options Greeks, calculate max pain, send alerts.
**Agent cannot:** Execute trades, recommend strikes, guarantee outcomes, replace a financial advisor.

### Common Mistakes

1. **Over-interpreting single indicators** — Need confluence, not just "RSI is 65"
2. **Ignoring macro context** — Day before Fed decision overrides technicals
3. **Presenting analysis as advice** — "Data shows X" never "You should do Y"
4. **No timeframe specified** — Always state daily vs intraday vs weekly
5. **Stale data without acknowledgment** — Always show timestamp, note if market is open

### Quality Checklist
- [ ] All price data includes timestamp
- [ ] At least 3 indicators for any trend call
- [ ] Confidence level stated
- [ ] Bull AND bear case presented
- [ ] Disclaimer included
- [ ] Timeframe clearly stated
- [ ] Upcoming events mentioned
- [ ] Options analysis includes Greeks + IV context
- [ ] Chart generated as image when requested


---

## Skill 8: Email & Outreach (AgentMail.to Integration)

### Overview
Every InstaClaw agent ships with its own email address — auto-provisioned during setup, fully operational from day one. The agent can send, receive, reply, extract OTP codes, manage threads, and handle email-based workflows autonomously. This is the agent's identity on the internet.

The agent's email (e.g., `mucus@instaclaw.io`) supplements the user's personal Gmail — the agent monitors both inboxes, sends from its own address for autonomous work, and drafts replies for the user's Gmail that the human reviews and sends. Two identities, one unified inbox experience.

**Why this matters:** Email is still the universal protocol of the internet. Without email, agents can't sign up for services, receive verification codes, communicate with other agents, send invoices, or operate autonomously in any meaningful business context. AgentMail.to gives every agent a real inbox in milliseconds via API.

### Trigger Metadata
```yaml
name: email-outreach
version: 1.0.0
updated: 2026-02-21
author: InstaClaw
triggers:
  keywords: [email, outreach, inbox, send email, reply, forward, newsletter, cold email, follow-up, OTP, verification code, email digest]
  phrases: ["send an email", "check my email", "draft a response", "follow up with", "email campaign", "cold outreach", "check for verification codes", "what's in my inbox", "email digest"]
  NOT: [Slack message, Discord message, SMS, phone call, text message]
```

### Prerequisites
- **AgentMail.to API key** (InstaClaw master account — provisions inboxes for all agents)
- **Custom domain** `instaclaw.io` configured in AgentMail (SPF/DKIM/DMARC handled automatically)
- **Gmail OAuth** (already configured during onboarding — agent monitors user's Gmail)
- **Webhook endpoint** on gateway for incoming email notifications

### AgentMail.to Platform Details
```yaml
provider: "agentmail.to"
type: "API-first email for AI agents"
features:
  - Create inboxes via API in milliseconds
  - Full send/receive/reply/thread management
  - Built-in SPF/DKIM/DMARC (deliverability handled)
  - Webhooks for real-time incoming email notifications
  - Attachment handling (send and receive)
  - Semantic search across inbox
  - Python + TypeScript SDKs
  
pricing:
  playground: Free — 3 inboxes, 3K emails, 3GB storage
  developer: $20/mo — 10 inboxes, 10K emails, 10GB storage, 10 custom domains
  startup: $200/mo — 150 inboxes, 150K emails, 150GB storage, 150 custom domains
  enterprise: Custom
  
instaclaw_plan: "startup"  # $200/mo covers up to 150 agents
cost_per_agent: ~$1.33/mo  # At 150 agents
```

### Architecture: Two-Identity Email System

```
┌─────────────────────────────────────────────┐
│                 Agent Email Brain            │
│                                             │
│  ┌───────────────┐  ┌───────────────────┐   │
│  │ Agent's Own    │  │ User's Gmail      │   │
│  │ @instaclaw.io  │  │ (OAuth monitor)   │   │
│  │               │  │                   │   │
│  │ SENDS FROM ✅  │  │ MONITORS ✅       │   │
│  │ RECEIVES ✅    │  │ DRAFTS FOR ✅     │   │
│  │ AUTONOMOUS ✅  │  │ USER SENDS ⚠️     │   │
│  └───────────────┘  └───────────────────┘   │
│                                             │
│  Unified inbox view → Daily digest → User   │
└─────────────────────────────────────────────┘
```

**Agent's @instaclaw.io email** (fully autonomous):
- Service signups and verification codes
- Agent-to-agent communication
- Marketplace activity (Contra, Clawlancer)
- Automated workflows (invoices, confirmations)
- Newsletter distribution

**User's Gmail** (agent assists, human controls):
- Agent monitors for important emails
- Agent drafts replies for human review
- Human sends from their own address
- Preserves user's identity and relationships

### Auto-Provisioning: configureOpenClaw() Integration

Every new agent gets an email address automatically during VM setup:

```typescript
import { AgentMailClient } from '@agentmail/sdk';

async function provisionAgentEmail(config: {
  agentName: string;
  userId: string;
  customAddress?: string;
}): Promise<string> {
  const agentmail = new AgentMailClient({
    apiKey: process.env.AGENTMAIL_API_KEY  // InstaClaw master key
  });
  
  // Default: {agent_name}@instaclaw.io
  const username = config.customAddress?.split('@')[0] 
    || config.agentName.toLowerCase().replace(/[^a-z0-9]/g, '');
  
  // Create inbox
  const inbox = await agentmail.inboxes.create({
    username: username,
    domain: 'instaclaw.io',
    description: `InstaClaw agent: ${config.agentName} (User: ${config.userId})`
  });
  
  // Set up webhook for incoming emails
  await agentmail.webhooks.create({
    inbox_id: inbox.id,
    url: `https://gateway.instaclaw.io/webhooks/email/${config.userId}`,
    events: ['email.received', 'email.bounced']
  });
  
  // Store in agent config
  await saveToConfig({
    email: {
      address: `${username}@instaclaw.io`,
      inbox_id: inbox.id,
      provider: 'agentmail'
    }
  });
  
  // Set up daily email digest via cron
  await cron.add({
    name: `email-digest-${config.userId}`,
    schedule: { kind: 'cron', expr: '0 8 * * *', tz: 'America/Los_Angeles' },
    payload: { kind: 'agentTurn', message: 'Generate and send daily email digest' },
    sessionTarget: 'isolated'
  });
  
  return `${username}@instaclaw.io`;
}

// In configureOpenClaw() main flow:
console.log('📧 Setting up agent email...');
const emailAddress = await provisionAgentEmail({
  agentName: config.agentName,
  userId: config.userId,
  customAddress: config.customEmail  // Optional: user chose during onboarding
});
console.log(`✅ Email ready: ${emailAddress}`);
```

### Naming Convention

```
Default:    {agent_name}@instaclaw.io        → mucus@instaclaw.io
Custom:     {agent_name}-{custom}@instaclaw.io → mucus-trading@instaclaw.io
```

During onboarding:
```
"Your agent needs an email for autonomous operation.

Suggested: mucus@instaclaw.io
[Use this] [Customize]

(Your agent will monitor your Gmail too, but this is its own identity 
for services, signups, and agent-to-agent communication)"
```

**Avoid:** `mucus-cooper@instaclaw.io` (exposes user identity), `cooper-agent@instaclaw.io` (sounds like assistant, not autonomous agent).

### Workflow 1: Autonomous Email Operations (No Human Needed)

These workflows run without any human approval:

**A. Service Signups & OTP Extraction**
```javascript
// Agent signs up for a service
await agentmail.emails.send({
  from: 'mucus@instaclaw.io',
  to: 'signup@service.com',
  subject: 'Account Registration',
  body: registrationDetails
});

// Webhook triggers when verification email arrives
onEmailReceived(async (email) => {
  if (isVerificationEmail(email)) {
    const otp = extractOTP(email.body);  // Regex for 6-digit codes, magic links, etc.
    await completeVerification(otp);
    log('OTP extracted and used', { service: email.from, code: otp });
  }
});
```

**B. Responding to Known Contacts**
```javascript
// Agent replies to existing threads autonomously
if (hasExistingThread(email) && isInformational(draftReply)) {
  // "Thanks for your email, I'll look into that"
  // "Here's the information you requested"
  await agentmail.messages.reply({
    thread_id: email.thread_id,
    body: draftReply
  });
}
```

**C. Automated Confirmations & Receipts**
```javascript
// Order confirmations, delivery notifications, etc.
await agentmail.emails.send({
  from: 'mucus@instaclaw.io',
  to: customer.email,
  subject: 'Your order has been received',
  body: formatConfirmation(order)
});
```

**D. Newsletter/Content Distribution (after initial setup)**
```javascript
// User approves list and content template once
// Agent handles distribution autonomously
for (const subscriber of approvedList) {
  await agentmail.emails.send({
    from: 'mucus@instaclaw.io',
    to: subscriber.email,
    subject: newsletter.subject,
    body: personalizeContent(newsletter, subscriber)
  });
  await delay(rateLimitDelay);  // Avoid spam triggers
}
```

### Workflow 2: Human-Approved Email Operations

These require user review before sending:

**A. Cold Outreach**
```
Agent drafts → User reviews → User approves → Agent sends + tracks responses

Daily notification:
📧 OUTREACH READY FOR REVIEW

Draft 1: Partnership inquiry to CompetitorX
├── To: partnerships@competitorx.com  
├── Subject: "InstaClaw × CompetitorX — Integration Opportunity"
├── Preview: "Hi Team, I noticed your recent API launch..."
├── Confidence: 82%
└── [Approve] [Edit] [Skip]

Draft 2: Follow-up to investor (3 days since last email)
├── To: investor@vc.com
├── Subject: "Re: InstaClaw Demo Follow-up"  
├── Preview: "Hi Sarah, wanted to follow up on..."
├── Confidence: 90%
└── [Approve] [Edit] [Skip]
```

**B. First-Time Responses (Gmail drafts)**
```
Agent detects new email in Gmail → Drafts response → User reviews → User sends from Gmail

📬 NEW EMAIL REQUIRING RESPONSE

From: newclient@company.com
Subject: "Interested in your AI agents"
Received: 2 hours ago

Agent's draft:
"Hi [Name], Thanks for your interest! InstaClaw agents can..."

[Send from Gmail] [Edit First] [I'll Handle It]
```

**C. Invoices & Proposals**
```
Agent generates → User approves amounts/terms → Agent sends → Agent follows up automatically

💰 INVOICE READY

Client: CompanyX
Amount: $500 (brand extraction + video)
Terms: Net 15
├── [Approve & Send] [Edit Amount] [Edit Terms]

After approval: Agent sends and auto-follows up at Day 7, Day 14
```

### Email Autonomy Decision Matrix

```javascript
const shouldAutoSend = (email) => {
  // NEVER auto-send
  if (email.mentionsMoney) return false;
  if (email.mentionsLegal) return false;
  if (email.isColdOutreach) return false;
  if (email.recipientIsVIP) return false;
  if (email.makesCommitment) return false;
  
  // ALWAYS auto-send
  if (email.isOTPExtraction) return true;
  if (email.isServiceConfirmation) return true;
  if (email.isPreApprovedNewsletter) return true;
  if (email.isAgentToAgentComm) return true;
  
  // CONDITIONAL auto-send
  if (email.isReplyToKnownContact && email.toneConfidence > 0.85) return true;
  
  // Default: human approval
  return false;
};
```

### Guardrails & Safety

**Risk 1: Sending Embarrassing/Wrong Content**
```javascript
const preSendChecks = {
  // Verify recipient matches intent
  recipientCheck: (email) => {
    if (email.to !== intendedRecipient) return { block: true, reason: 'WRONG_RECIPIENT' };
  },
  
  // Sensitive content detection
  contentCheck: (email) => {
    const sensitivePatterns = [
      /password[:\s]+\S+/i,
      /\bAPI[_-]?KEY\b/i,
      /sk-[a-zA-Z0-9]{32}/,         // OpenAI keys
      /Bearer [a-zA-Z0-9]/,
      /credit card/i,
      /\$\d{4,}/,                    // Dollar amounts > $999
      /lawsuit|legal action/i,
      /confidential/i
    ];
    if (sensitivePatterns.some(p => email.body.match(p))) {
      return { block: true, reason: 'SENSITIVE_CONTENT' };
    }
  },
  
  // Tone check
  toneCheck: (email) => {
    if (detectAnger(email) || detectSarcasm(email)) {
      return { flag: true, reason: 'TONE_WARNING' };
    }
  }
};
```

**Risk 2: Missing Important Emails**
```javascript
const priorityRules = {
  vip_senders: [], // Populated from USER.md contacts
  urgent_keywords: ['urgent', 'asap', 'deadline', 'important', 'time-sensitive'],
  
  classify: (email) => {
    if (vip_senders.includes(email.from)) return 'CRITICAL';
    if (urgent_keywords.some(k => email.subject.toLowerCase().includes(k))) return 'HIGH';
    if (email.hasAttachment && email.from.includes(knownDomain)) return 'MEDIUM';
    return 'NORMAL';
  }
};
```

**Risk 3: Spam / Getting Blacklisted**
```yaml
rate_limits:
  cold_outreach: 20/day           # Hard cap
  known_contacts: 100/day
  automated_sends: 200/day
  
  warmup_schedule:                 # New addresses
    week_1: 10/day
    week_2: 25/day
    week_3: 50/day
    week_4: full_limits
    
  deliverability:
    check_spam_words: true         # Flag "free money", "act now", etc.
    require_unsubscribe_link: true # For bulk sends
    honor_bounces: true            # Auto-remove bounced addresses
```

**Risk 4: Leaked Credentials**
```javascript
const credentialPatterns = [
  /sk-[a-zA-Z0-9]{32,}/,          // OpenAI keys
  /brv_[a-zA-Z0-9]+/,             // Brave keys
  /ghp_[a-zA-Z0-9]{36}/,          // GitHub PATs
  /API[_-]?KEY[:\s=]+[a-zA-Z0-9]/i,
  /password[:\s=]+\S+/i
];

// Block any email containing credentials
const blockIfCredentials = (email) => {
  if (credentialPatterns.some(p => email.body.match(p))) {
    return { block: true, reason: 'CREDENTIAL_LEAK_PREVENTED' };
  }
};
```

### Daily Email Digest (Delivered via Telegram)

```
📧 Daily Email Digest — Feb 21, 2026

🚨 URGENT (Action Needed):
• VIP email from investor@vc.com (3h ago)
  Subject: "Follow-up on demo"
  [Draft Reply] [Open in Gmail]

• Deadline: Proposal due tomorrow  
  From: client@company.com
  [View Details]

📬 NEW (May Need Response):
• Partnership inquiry from newcontact@startup.com
  Agent draft ready — confidence 82%
  [Review Draft] [I'll Handle It]

✅ HANDLED AUTONOMOUSLY:
• 3 OTP codes extracted & used (Contra, GitHub, Heroku)
• 2 order confirmations sent
• 1 follow-up to existing client thread
• Newsletter sent to 47 subscribers

📊 INBOX STATS:
• Agent inbox: 12 received, 8 sent
• Gmail: 23 received, 0 requiring response
• Priority emails caught: 2
• Spam filtered: 14

⏱ Your time: 3 minutes to review urgent items
```

### Common Mistakes

1. **Sending from wrong identity** — Agent should send from `@instaclaw.io` for autonomous work and only DRAFT for Gmail. Never send from the user's Gmail without explicit approval.

2. **Over-emailing contacts** — Respect rate limits. If someone hasn't responded after 3 follow-ups, stop. Don't be the annoying bot.

3. **Missing VIP emails in noise** — Priority classification must run on every incoming email. A missed investor email is catastrophic. Configure VIP sender list during onboarding.

4. **Not warming up new addresses** — AgentMail handles SPF/DKIM, but a brand new address sending 100 emails on day 1 will get flagged. Follow the warmup schedule.

5. **Auto-replying to auto-replies** — Detect auto-reply headers (`Auto-Submitted: auto-replied`, `X-Autoreply: yes`) and skip. Otherwise you create infinite email loops.

### Quality Checklist
- [ ] Email address provisioned and verified during setup
- [ ] Webhook receiving incoming emails in real-time
- [ ] OTP extraction working (test with a service signup)
- [ ] Gmail monitoring active and classifying priority
- [ ] Pre-send checks catching sensitive content
- [ ] Rate limits enforced (check daily counter)
- [ ] Daily digest delivered at scheduled time
- [ ] VIP sender list populated from USER.md
- [ ] Warmup schedule followed for new addresses
- [ ] Auto-reply detection preventing email loops
- [ ] Credential leak detection blocking API keys in outbound email

---

## Skill 9: Social Media Content Engine

### Overview
Transforms every InstaClaw agent into a content team. Agent generates platform-native content — threads, posts, captions — adapted to each platform's culture, format, and audience expectations. Includes content calendar management, trend-jacking (once Brave Search is live), and scheduled posting via heartbeat/cron.

**The honest truth:** This skill is currently limited by platform access. Agents can generate excellent content but can only post to Reddit today. Twitter/X, LinkedIn, Instagram, and TikTok are blocked without API keys or have bot detection. The skill is designed to work in tiers — starting with what's possible now and expanding as API access is added.

### Trigger Metadata
```yaml
name: social-media-content
version: 1.0.0
updated: 2026-02-21
author: InstaClaw
triggers:
  keywords: [social media, tweet, thread, LinkedIn post, Instagram caption, Reddit post, content calendar, social content, hashtags, engagement, trending]
  phrases: ["write a tweet", "create a thread", "LinkedIn post about", "social media calendar", "content for this week", "what should I post", "trending topics", "write a Reddit post"]
  NOT: [social media analytics, follower count, social login, social API key setup]
```

### Prerequisites
- **Platform API keys** (for actual posting — see access matrix below)
- **Brave Search API** (for trend detection — Tier 1A capability)
- **Heartbeat/Cron** (for scheduled posting at optimal times)
- **User's past content samples** (for voice training — optional but recommended)

### Platform Access Matrix (Current Reality)

| Platform | Can Generate Content | Can Post | Method | Capability |
|---|---|---|---|---|
| **Reddit** | ✅ YES | ✅ YES | Browser or OAuth API | 7/10 |
| **LinkedIn** | ✅ YES | ⚠️ RISKY | Browser (fragile, ban risk) | 5/10 |
| **Twitter/X** | ✅ YES | ❌ NO | Blocked — needs API ($100/mo) | 2/10 |
| **Instagram** | ✅ YES | ❌ NO | Mobile-only, no web posting | 1/10 |
| **TikTok** | ✅ YES (captions) | ❌ NO | Mobile-only, no public API | 1/10 |
| **Threads** | ✅ YES | ⚠️ UNKNOWN | Untested, likely similar to Instagram | 2/10 |

**Current recommendation:**
- **Tier 1 (Now):** Reddit — works today, bot-friendly if properly labeled
- **Tier 2 (With API keys):** Twitter/X ($100/mo Basic) + LinkedIn API (free tier)
- **Tier 3 (Skip for now):** Instagram, TikTok — no viable posting path

### Content Quality Ratings (Honest Assessment)

| Content Type | Quality | Strengths | Weaknesses |
|---|---|---|---|
| Twitter/X thread (technical) | 7/10 | Good structure, accurate info | Lacks personality, slightly robotic |
| Twitter/X engagement reply | 6/10 | Addresses points directly | Too earnest, misses platform snark |
| LinkedIn thought leadership | 6/10 | Professional tone, structured | Generic LinkedIn-speak, lacks specifics |
| LinkedIn company update | 8/10 | Specific numbers, celebrates users | Could be more visual |
| Instagram caption + hashtags | 5/10 | Has emoji, CTA | Generic hashtags, doesn't leverage visual medium |
| Blog post / article draft | 8/10 | Specific examples, personal voice, transparent | Could use more data/charts |
| Newsletter copy | 7/10 | Punchy opening, clear CTA | Middle section lacks personality |
| Reddit post | 7/10 | Conversational, detailed | Needs subreddit-specific adaptation |

### Workflow 1: Content Generation (Any Platform)

**STEP 1: Understand Voice**

Before generating any content, agent analyzes user's existing content to learn their voice:
```javascript
const voiceProfile = analyzeWritingStyle({
  samples: user.pastContent,  // Past tweets, LinkedIn posts, blog posts
  extract: [
    'tone',              // Casual, professional, technical, humorous
    'vocabulary',        // Simple, complex, industry-specific
    'sentenceLength',    // Short punchy vs long flowing
    'emojiUsage',        // Heavy, moderate, none
    'punctuation',       // Exclamation marks, ellipsis, em-dashes
    'opinionStrength',   // Measured, bold, provocative
    'personalAnecdotes'  // Frequency and style
  ]
});

// Store in USER.md
// voice_profile:
//   tone: "casual-technical"
//   emoji: "moderate"
//   sentence_style: "mix-short-long"
//   opinion: "bold-with-data"
```

**STEP 2: Generate Platform-Native Content**

Agent generates content adapted to each platform's culture:

```
Platform Rules:
├── Twitter/X: Short sentences, line breaks, emoji but not every line, casual, typos okay
├── LinkedIn: More formal, longer paragraphs, 3-5 hashtags, professional-warm
├── Reddit: Conversational, self-deprecating, specific details, sources, edit notes  
├── Instagram: Visual-first copy, heavy emoji, 20-30 hashtags, aspirational
└── Blog: Long-form, headers, specific examples, transparent about AI authorship
```

**STEP 3: Anti-ChatGPT Filter**

The #1 thing users hate about AI content is that it sounds like AI. Every piece of content runs through the humanization filter:

```javascript
const humanize = (content, voiceProfile) => {
  // 1. Kill generic openings
  const genericOpenings = [
    'In today\'s fast-paced world',
    'It\'s no secret that',
    'As we all know',
    'In the ever-evolving landscape'
  ];
  genericOpenings.forEach(phrase => {
    if (content.startsWith(phrase)) content = removeOpening(content);
  });
  
  // 2. Kill overused AI words
  const aiWords = {
    'game-changer': 'shift',
    'unlock': 'find',
    'leverage': 'use',
    'synergy': '[delete entirely]',
    'paradigm': '[delete entirely]',
    'utilize': 'use',
    'facilitate': 'help',
    'groundbreaking': 'new'
  };
  Object.entries(aiWords).forEach(([ai, human]) => {
    content = content.replace(new RegExp(ai, 'gi'), human);
  });
  
  // 3. Add contractions (formal → natural)
  content = content.replace(/\bdo not\b/g, "don't");
  content = content.replace(/\bit is\b/g, "it's");
  content = content.replace(/\bI am\b/g, "I'm");
  content = content.replace(/\bcannot\b/g, "can't");
  
  // 4. Vary sentence length (ChatGPT loves medium sentences)
  // Humans write: short. Really short. And then long ones that go on.
  
  // 5. Require specifics over generics
  // ❌ "AI agents are transforming how we work"
  // ✅ "I watched an AI agent earn $400 last week doing data analysis bounties"
  
  return content;
};
```

**The golden rule:** If you can tell it's AI-written, the skill failed. The goal isn't to hide that it's AI — it's to write SO well that it doesn't matter.

### Workflow 2: Content Calendar Management

Agent maintains a rolling content calendar with scheduled posts:

```javascript
// Content calendar stored in workspace
const calendar = {
  week_of: '2026-02-24',
  posts: [
    {
      platform: 'twitter',
      scheduled: 'Monday 10:00',
      type: 'thread',
      topic: 'AI agents earning revenue — 60-day update',
      status: 'drafted',  // drafted | approved | posted | failed
      content: '...',
      approval_required: true
    },
    {
      platform: 'linkedin',
      scheduled: 'Tuesday 08:00',
      type: 'company_update',
      topic: 'New feature launch announcement',
      status: 'pending_draft',
      approval_required: true
    },
    {
      platform: 'reddit',
      scheduled: 'Wednesday 12:00',
      type: 'post',
      subreddit: 'r/artificial',
      topic: 'How I built an autonomous AI agent platform',
      status: 'drafted',
      approval_required: false  // Reddit is auto-post capable
    }
  ]
};
```

**Weekly content planning notification (Sunday evening):**
```
📅 Content Calendar — Week of Feb 24

Monday 10am — Twitter Thread
"AI Agents Earning Revenue: 60-Day Update"
Status: Draft ready for review
[Review] [Approve] [Reschedule]

Tuesday 8am — LinkedIn Update  
"New Feature: Voice & Audio for All Agents"
Status: Needs draft
[Generate Draft] [Skip]

Wednesday 12pm — Reddit Post
"How I Built an Autonomous AI Agent Platform (r/artificial)"
Status: Auto-approved (Reddit)
[Review Anyway] [Let It Post]

Thursday 5pm — Twitter Engagement
Respond to top AI agent discussions
Status: Autonomous
[Set Parameters] [Pause]

Friday — No posts scheduled
[Add Something] [Keep Free]

Total posts this week: 4
Approval needed: 2
Auto-posting: 2
```

### Workflow 3: Trend-Jacking (Requires Brave Search)

**STEP 1: Trend Detection (every 2 hours via heartbeat)**
```javascript
const detectTrends = async () => {
  const results = await web_search({
    query: 'AI agents OR autonomous AI OR agent marketplace',
    freshness: 'past_day',
    count: 50
  });
  
  // Count topic frequency
  const topics = {};
  results.forEach(r => {
    extractTopics(r.title + r.description).forEach(t => {
      topics[t] = (topics[t] || 0) + 1;
    });
  });
  
  return Object.entries(topics)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
};
```

**STEP 2: Relevance + Angle**
```javascript
const processableTrends = trending.filter(topic => 
  isRelevantToUser(topic) && 
  !alreadyPostedAbout(topic) &&
  hasUniqueAngle(topic)
);

// Develop angle from InstaClaw's actual experience
// "agent-to-agent commerce trending? We've been doing this for 2 months..."
```

**STEP 3: Generate + Post (or queue for approval)**
```javascript
if (trendIsHot && userAllowsAutoPost) {
  const content = generateTrendContent(trend, platform);
  await post(content);
  await notifyUser('TREND POST PUBLISHED', { topic, content, platform });
} else {
  await queueForApproval(content);
  await notifyUser('TRENDING CONTENT READY', { topic, content, engagementPotential: 'HIGH' });
}
```

**Full cycle time:** 2-4 hours from trend detection to posted content.

### Workflow 4: Scheduled Posting via Cron/Heartbeat

```javascript
// Schedule posts via cron (no active session needed)
await cron.add({
  name: 'twitter-thread-monday',
  schedule: {
    kind: 'cron',
    expr: '0 10 * * 1',  // Mondays at 10am
    tz: 'America/Los_Angeles'
  },
  payload: {
    kind: 'agentTurn',
    message: 'Post approved Twitter thread from content calendar'
  },
  sessionTarget: 'isolated'
});

// Optimal posting times (default, agent learns from engagement data)
const defaultOptimalTimes = {
  twitter: [9, 12, 17],   // 9am, 12pm, 5pm
  linkedin: [8, 12, 16],  // 8am, 12pm, 4pm
  reddit: [10, 14, 20]    // 10am, 2pm, 8pm
};
```

### Platform-Specific Content Templates

**Twitter/X Thread Template:**
```
1/ [Hook — surprising stat or controversial take]

2/ [Context — what's happening and why it matters]

3/ [Your experience — specific examples with numbers]
• Bullet with data point
• Bullet with data point
• Bullet with data point

4/ [Insight — what you learned that others haven't]

5/ [CTA — question that drives engagement]

What would you do? 👇
```

**LinkedIn Post Template:**
```
[Bold opening statement — 1 line, no fluff]

[2-3 sentence context paragraph]

Here's what I've learned:

→ [Insight 1 with specific number]
→ [Insight 2 with specific number]  
→ [Insight 3 with specific number]

[1-2 sentence takeaway]

[Question for engagement]

#Hashtag1 #Hashtag2 #Hashtag3
```

**Reddit Post Template:**
```
Title: [Specific, descriptive, no clickbait]

Hey r/[subreddit],

[1 paragraph context — who you are, what you built]

[2-3 paragraphs of substance — details, numbers, lessons]

[What went wrong / what surprised you — Reddit loves honesty]

[Ask for community input]

Edit: [Respond to common questions]

---
Disclosure: [agent name] is an AI agent. This post was reviewed by a human.
```

### Content Autonomy Rules

```yaml
auto_post:
  reddit:
    enabled: true                    # Reddit is bot-friendly
    subreddits: ["approved_list"]    # User pre-approves subreddits
    max_per_day: 2
    require_disclosure: true         # Always disclose AI authorship
    
  twitter:
    enabled: false                   # Default off — high reputation risk
    require_approval: true
    exception: "engagement_replies"  # Can reply if approved template
    
  linkedin:
    enabled: false                   # Default off — professional risk
    require_approval: true

require_approval:
  - cold_outreach_posts
  - controversial_topics
  - posts_mentioning_competitors_by_name
  - posts_with_financial_claims
  - first_post_on_new_platform

never_auto_post:
  - political_content
  - content_claiming_human_authorship
  - posts_with_unverified_claims
  - posts_to_unapproved_subreddits
```

### Voice Training: Fighting the "Sounds Like ChatGPT" Problem

The biggest challenge with AI-generated social content is authenticity. Here's the multi-layer approach:

**Layer 1: Learn the user's voice from samples**
- Analyze past posts, emails, and writing samples during onboarding
- Extract tone, vocabulary, sentence patterns, emoji habits
- Store as voice profile in USER.md

**Layer 2: Kill AI-isms in every output**
- Ban list: "game-changer", "unlock", "leverage", "in today's fast-paced world"
- Force contractions: "do not" → "don't"
- Require specific examples over generic claims

**Layer 3: Use the specifics-over-generics rule**
```
❌ "AI agents are transforming how we work"
✅ "I watched an AI agent earn $400 last week doing data analysis bounties"

❌ "This is a game-changer for productivity"  
✅ "I saved 8 hours this week because my agent handles email triage"

❌ "Leverage AI to unlock new opportunities"
✅ "My agent found 3 competitor price changes I would've missed"
```

**Layer 4: Include authenticity markers**
- A specific example with numbers (always)
- A mistake or failure (Reddit especially loves this)
- Something that surprised you (shows learning)
- A genuine question (shows curiosity, not just broadcasting)

**Layer 5: Platform-native formatting**
Each platform has unwritten formatting rules. Content that breaks these rules screams "automated." Agent adapts to platform culture, not just platform character limits.

### API Key Requirements for Full Functionality

```yaml
# Needed for posting (user provides or InstaClaw supplies)
platform_apis:
  twitter:
    type: "Twitter API Basic"
    cost: "$100/mo"
    provides: "Read + write tweets, threads, replies"
    priority: "Tier 2 — add when budget allows"
    
  linkedin:
    type: "LinkedIn API (free tier)"
    cost: "Free"
    provides: "Post updates, articles"
    priority: "Tier 2 — worth getting"
    note: "Requires app registration and review"
    
  reddit:
    type: "Reddit OAuth"
    cost: "Free"
    provides: "Post, comment, reply"
    priority: "Tier 1 — works now"
    note: "Must label as bot per Reddit policy"
```

### Common Mistakes

1. **Posting the same content to all platforms** — Each platform has different culture, formatting, and audience expectations. A LinkedIn post on Reddit gets roasted. A Reddit post on LinkedIn looks unprofessional. Always generate platform-native content.

2. **Over-posting** — Quality over quantity. 3 excellent posts per week beats 3 mediocre posts per day. Users get fatigued, algorithms penalize low-engagement content.

3. **Forgetting AI disclosure** — Always be transparent about AI authorship, especially on Reddit (where the community will figure it out and react badly if you hide it). Include disclosure in post footer.

4. **Generic hashtags** — `#AI #Innovation #FutureOfWork` screams automated. Research niche-specific hashtags that the actual community uses. Fewer but more targeted.

5. **Ignoring engagement** — Posting is half the job. Responding to comments, liking replies, joining threads — this is where real value comes from. Agent should monitor post performance and engage for 2-4 hours after posting.

6. **Not learning from performance** — Track which content types, topics, and posting times get the most engagement. Adjust the content calendar based on data, not assumptions.

### Quality Checklist
- [ ] Content matches user's voice profile (not generic AI tone)
- [ ] Anti-ChatGPT filter applied (no banned phrases, contractions used, specifics over generics)
- [ ] Platform-native formatting (not cross-posted copypaste)
- [ ] Includes specific examples with real numbers
- [ ] AI disclosure included where appropriate (especially Reddit)
- [ ] Hashtags are niche-specific, not generic
- [ ] Scheduled at optimal time for platform
- [ ] Approval workflow triggered for high-risk content
- [ ] Rate limits respected per platform
- [ ] Content calendar updated after posting


## Skill 10: Competitive Intelligence & Market Research

### Overview
Transforms every InstaClaw agent into an always-on competitive intelligence analyst. Agent monitors competitors, tracks market trends, analyzes sentiment, and delivers actionable briefings — daily digests, weekly deep-dives, and real-time alerts when something significant happens.

This skill turns hours of manual competitor-stalking into a 2-minute morning scan. The agent does the tedious work (checking blogs, scanning job boards, tracking social mentions, monitoring pricing pages), distills it into what matters, and surfaces strategic implications.

### Trigger Metadata
```yaml
name: competitive-intelligence
version: 1.0.0
updated: 2026-02-21
author: InstaClaw
triggers:
  keywords: [competitor, competitive analysis, market research, industry analysis, competitor pricing, market trends, intel, surveillance, monitoring, sentiment]
  phrases: ["monitor competitors", "track the market", "competitive landscape", "what are competitors doing", "market research report", "industry trends", "watch competitor pricing", "crypto sentiment", "track mentions", "who are my competitors"]
  NOT: [internal analytics, our own metrics, user analytics, A/B test results]
```

### Prerequisites
- **Brave Search API** (Tier 1A capability — REQUIRED for 80% of this skill's functionality)
- **Web Fetch** capability (for reading full pages after search results)
- **File system** access (for storing historical snapshots)
- **Heartbeat integration** (for scheduled daily/weekly runs)
- **Telegram/Discord** delivery (for alerts and digests)

**Without Brave Search:** This skill is ~20% functional (limited to monitoring known URLs via web_fetch). With Brave Search deployed, jumps to 90%+ functional. Deploy Brave Search first.

### Data Source Feasibility Matrix

Based on production testing, here's what the agent can actually gather:

| Intel Category | Feasibility | Method | Reliability |
|---|---|---|---|
| Competitor pricing changes | 8/10 ✅ | Fetch known pricing pages, compare to stored snapshots | HIGH — static pages are reliable |
| New feature launches | 9/10 ✅ | Search `site:competitor.com/changelog` or `/blog`, filter by date | VERY HIGH — companies publish changelogs |
| Job postings (hiring signals) | 7/10 ✅ | Search LinkedIn/Indeed/Workable for company name | MEDIUM-HIGH — some boards block scraping |
| Social media mentions | 8/10 ✅ | Search `site:twitter.com "CompanyName"`, sentiment keywords | HIGH — public tweets are searchable |
| App Store / Product Hunt reviews | 6/10 ⚠️ | Product Hunt via search (static pages), App Store needs browser | MEDIUM — App Store requires browser automation |
| Funding rounds | 9/10 ✅ | Search Crunchbase mentions, TechCrunch, press releases | VERY HIGH — funding announcements are well-covered |
| Content publishing frequency | 9/10 ✅ | Search `site:competitor.com/blog`, count by date | VERY HIGH — blog posts have timestamps |
| Patent filings | 4/10 ⚠️ | Google Patents search — hard to parse, lag time, most startups don't patent | LOW — niche, low ROI for most users |
| Website traffic estimates | 3/10 ❌ | Need SimilarWeb/Ahrefs API — can't get from search alone | LOW — requires paid specialized tools |
| SEO keyword rankings | 5/10 ⚠️ | Search target keywords, find position — personalized results reduce accuracy | MEDIUM — directional but not precise |

### Workflow 1: Competitor Monitoring Setup

When user says: "Monitor my competitors" or agent detects competitive context during onboarding.

**STEP 1: Identify Competitors**
```
Agent: "Who are your main competitors? I'll set up daily monitoring."

If user provides names → proceed
If user unsure → Agent searches "{user's product category} alternatives" 
  and suggests top 5 competitors found
```

**STEP 2: Build Competitor Profile**
For each competitor, agent creates a monitoring config:
```json
{
  "competitor": "CompetitorX",
  "urls": {
    "pricing": "https://competitorx.com/pricing",
    "blog": "https://competitorx.com/blog",
    "changelog": "https://competitorx.com/changelog",
    "careers": "https://competitorx.com/careers"
  },
  "search_queries": [
    "\"CompetitorX\" announcement",
    "site:twitter.com \"CompetitorX\"",
    "site:linkedin.com/jobs \"CompetitorX\"",
    "\"CompetitorX\" funding OR raised OR series"
  ],
  "social_handles": {
    "twitter": "@competitorx",
    "linkedin": "company/competitorx"
  }
}
```

**STEP 3: Create Baseline Snapshot**
Agent fetches all current data and stores as day-zero snapshot:
```
workspace/
  competitive-intel/
    config.json                    # Monitoring configuration
    snapshots/
      2026-02-21-competitorx.json  # Pricing, features, social counts
      2026-02-21-competitory.json
    reports/
      daily/
      weekly/
```

**STEP 4: Schedule via Heartbeat**
Agent registers competitive intel as a daily heartbeat task:
```yaml
# In heartbeat schedule
competitive_intel:
  daily_digest: "08:00"         # Morning briefing
  weekly_report: "Sunday 20:00" # Weekly deep-dive
  real_time_alerts: true        # Critical changes trigger immediately
```

### Workflow 2: Daily Competitive Digest

Runs automatically every morning via heartbeat. Agent executes this sequence:

**STEP 1: Price Check** (2-3 API calls per competitor)
```python
# Fetch current pricing pages
for competitor in config.competitors:
    current = web_fetch(competitor.urls.pricing)
    previous = load_snapshot(competitor, 'pricing')
    changes = compare_pricing(current, previous)
    if changes:
        alerts.append(format_price_alert(competitor, changes))
    save_snapshot(competitor, 'pricing', current)
```

**STEP 2: Content Scan** (1-2 API calls per competitor)
```python
# Search for new blog posts / changelog entries
for competitor in config.competitors:
    results = web_search(f"site:{competitor.domain}/blog OR site:{competitor.domain}/changelog", freshness="past_day")
    new_posts = filter_new(results, since=last_check)
    if new_posts:
        for post in new_posts:
            content = web_fetch(post.url)
            summary = summarize(content, max_words=50)
            intel.append(format_content_alert(competitor, post, summary))
```

**STEP 3: Social Scan** (2-3 API calls total)
```python
# Search for mentions across platforms
mentions = web_search(f'"CompetitorX" OR "@competitorx"', freshness="past_day")
sentiment = analyze_sentiment(mentions)
# Keywords: "love", "hate", "switching to", "disappointed", "amazing"
```

**STEP 4: Job Scan** (1-2 API calls per competitor, weekly only)
```python
# Weekly job check (not daily — jobs don't change that fast)
if is_weekly_check():
    for competitor in config.competitors:
        jobs = web_search(f'site:linkedin.com/jobs "{competitor.name}"')
        new_jobs = filter_new(jobs, since=last_weekly_check)
        signals = analyze_hiring(new_jobs)
        # "Hiring 5 engineers" = growth
        # "Hiring VP of Sales" = sales push
        # "Hiring in Europe" = expansion
```

**STEP 5: Assemble & Deliver**

Example daily digest delivered via Telegram:
```
🔍 Daily Competitive Intel — Feb 21, 2026

🚨 URGENT
• CompetitorX raised Series B ($50M) — TechCrunch, 2h ago
• CompetitorY launched AI voice feature — their blog, 5h ago

💰 PRICING
• No changes detected across 3 competitors

📢 MENTIONS (24h)
• CompetitorX: 47 mentions (+12% vs yesterday)
  - Positive: 68% | Negative: 17% | Neutral: 15%
  - Top complaint: "Still no mobile app"
• CompetitorY: 23 mentions (-5%)

📝 CONTENT
• CompetitorZ published: "How to Build AI Agents" (est. 4k words)

📊 TRENDS
• "AI agent" search volume up 23% this week

⏱ Your scan time: 2 minutes
```

### Workflow 3: Weekly Deep-Dive Report

More strategic analysis, delivered Sunday evening for Monday planning:

```
📊 Weekly Competitive Intelligence Report
Week of February 15-21, 2026

═══════════════════════════════════════════

EXECUTIVE SUMMARY

Three key developments this week:
1. CompetitorX funding → expect aggressive marketing push
2. CompetitorY mobile launch → closes feature gap advantage we had
3. Market sentiment positive (+15% overall mentions)

═══════════════════════════════════════════

COMPETITOR DEEP-DIVES

CompetitorX (Primary Threat)
├── Funding: Raised $50M Series B
├── Implication: 18-24 month runway, likely sales team expansion
├── Hiring: +2 jobs (Senior Backend Engineer, Community Manager)
├── Signal: Infrastructure scaling + community investment
├── Pricing: No changes (still commission-free)
├── Mentions: 234 this week (+31%)
├── Sentiment: 78% positive
└── Our play: Lock in annual contracts, emphasize speed-to-market

CompetitorY (Secondary Threat)
├── Product: Launched mobile app (iOS only)
├── Reception: Mixed (3.2★ App Store, 47 reviews)
├── Key complaints: Buggy notifications, missing features vs web
├── Our play: Position as "works anywhere" (Telegram/Discord = no download)
└── Pricing: Raised Pro tier from $89 → $99 (+11%) ⚠️

═══════════════════════════════════════════

MARKET TRENDS

Search Volume:
• "AI agent platform": +23% MoM
• "AI agent marketplace": +45% MoM
• "AI agent earnings": +127% MoM ⚠️ EMERGING TREND

Content Themes (Most-Shared This Week):
1. Autonomous agents earning revenue
2. Agent-to-agent commerce
3. Multi-agent systems

═══════════════════════════════════════════

PRICING MATRIX (As of Feb 21, 2026)

| Platform | Starter | Pro | Enterprise | Commission |
|----------|---------|-----|------------|------------|
| Us       | $29/mo  | $99 | $299       | 0%         |
| Comp X   | Free    | -   | -          | 0%         |
| Comp Y   | $25/mo  | $99 | Custom     | 5%         |

Changes this week: CompetitorY Pro +11%

═══════════════════════════════════════════

STRATEGIC RECOMMENDATIONS

1. Content: Publish "How AI Agents Earn Money" — capture +127% trend
2. Positioning: Counter CompetitorX funding with speed-to-market messaging
3. Pricing: Hold current pricing — CompetitorY increase validates our tier
4. Product: Accelerate features CompetitorY mobile app reviews complain about

═══════════════════════════════════════════

Next report: Sunday, February 28, 2026
```

### Workflow 4: Real-Time Alerts

Triggered immediately when agent detects critical changes during any scheduled scan or heartbeat cycle:

**Alert Triggers:**
```yaml
real_time_alerts:
  critical:  # Notify immediately
    - competitor_funding_announcement
    - major_feature_launch
    - significant_price_change_over_10_percent
    - competitor_acquisition_or_merger
    - negative_sentiment_spike_over_50_percent
    - your_company_mentioned_alongside_competitor
  
  informational:  # Bundle into next daily digest
    - new_blog_post
    - minor_price_change
    - new_job_posting
    - app_store_review
```

**Alert Format:**
```
🚨 ALERT: CompetitorX Funding

CompetitorX raised $50M Series B
Source: TechCrunch (15 min ago)
Lead: Andreessen Horowitz

Implications:
• War chest for customer acquisition
• Likely pricing pressure in 3-6 months
• Expect 2-3x marketing spend

Suggested actions:
• Review pricing strategy
• Lock in annual contracts with key customers
• Accelerate roadmap items that differentiate

[View Article] [Dismiss] [Snooze 1h]
```

### Workflow 5: Crypto-Specific Intelligence

For users with crypto/web3 interests (detected from USER.md):

**What Works (With Brave Search):**
| Source | Feasibility | Method |
|---|---|---|
| Project announcements | 9/10 ✅ | Search Twitter/Medium/blogs |
| CT (Crypto Twitter) sentiment | 8/10 ✅ | Search site:twitter.com + sentiment keywords |
| GitHub commit activity | 7/10 ✅ | GitHub API (free, public repos) |
| Partnership announcements | 8/10 ✅ | Search press releases |
| Conference appearances | 7/10 ✅ | Search event sites |

**What Needs Specialized APIs (Not Search):**
| Source | Feasibility | Better Tool |
|---|---|---|
| Token price movements | 5/10 | CoinGecko API (free) |
| Whale wallet activity | 2/10 | Etherscan/Nansen API |
| DEX volume changes | 4/10 | DexScreener API |
| On-chain metrics | 3/10 | The Graph, Dune Analytics |

**Crypto Sentiment Analysis:**
```python
# Search for token-specific mentions
mentions = web_search(f'"$INSTACLAW" OR "$CLAWLANCER" site:twitter.com', freshness="past_day")

# Crypto-specific sentiment keywords
positive = ["moon", "gem", "bullish", "buying", "accumulating", "undervalued", "based"]
negative = ["rug", "scam", "bearish", "selling", "dumping", "dead", "overvalued"]

sentiment = classify_sentiment(mentions, positive, negative)
```

**Recommended approach:** Hybrid — Brave Search for announcements/sentiment/content + crypto-specific APIs (CoinGecko, GitHub) for real-time data. Agent should have both capabilities.

### Data Storage: Historical Comparison Engine

The agent needs to know "CompetitorX raised prices 10% this week" which requires storing last week's prices. Storage approach:

**Phase 1: JSON Snapshots (Start Here)**
```
workspace/
  competitive-intel/
    config.json
    snapshots/
      2026-02-21-competitorx.json
      2026-02-21-competitory.json
      2026-02-14-competitorx.json   # Last week (for comparison)
```

Snapshot format:
```json
{
  "date": "2026-02-21",
  "competitor": "CompetitorX",
  "pricing": {
    "starter": 29,
    "pro": 99,
    "enterprise": "custom"
  },
  "features": {
    "starter": ["feature1", "feature2"],
    "pro": ["feature1", "feature2", "feature3"]
  },
  "social": {
    "twitter_followers": 12453,
    "twitter_mentions_7d": 89
  },
  "content": {
    "blog_posts_30d": 8,
    "changelog_updates_30d": 3
  },
  "hiring": {
    "open_positions": 7,
    "new_this_week": 2,
    "roles": ["Senior Engineer", "Community Manager"]
  }
}
```

Comparison logic:
```python
today = load_snapshot('2026-02-21-competitorx.json')
last_week = load_snapshot('2026-02-14-competitorx.json')

changes = {
    'pricing': compare(today['pricing'], last_week['pricing']),
    'features': diff(today['features'], last_week['features']),
    'social': delta(today['social'], last_week['social']),
    'hiring': compare(today['hiring'], last_week['hiring'])
}

# Output: "CompetitorX raised Pro price from $89 to $99 (+11%)"
# Output: "CompetitorX added 2 new job postings (hiring signal: growth)"
# Output: "Twitter mentions up 31% week-over-week"
```

**Phase 2: SQLite Database (If Scaling)**
When snapshot count exceeds 100 files, migrate to SQLite for efficient querying:
```sql
CREATE TABLE competitor_snapshots (
  id INTEGER PRIMARY KEY,
  date DATE,
  competitor TEXT,
  category TEXT,  -- pricing, social, hiring, features
  data JSON,
  created_at TIMESTAMP
);

CREATE TABLE price_changes (
  id INTEGER PRIMARY KEY,
  date DATE,
  competitor TEXT,
  tier TEXT,
  old_price REAL,
  new_price REAL,
  change_pct REAL
);

-- "Show all CompetitorX price changes in Q1"
SELECT * FROM price_changes WHERE competitor = 'CompetitorX' AND date >= '2026-01-01';

-- "Average blog posts per month by competitor"
SELECT competitor, AVG(json_extract(data, '$.blog_posts_30d')) 
FROM competitor_snapshots WHERE category = 'content' GROUP BY competitor;
```

**Migration path:** Start files → SQLite when data grows. Agent handles migration automatically when it detects >100 snapshot files.

### Rate Limiting & Budget

```yaml
# Daily API budget for competitive intel
competitive_intel_budget:
  brave_search_calls: 30        # Per competitor day (5 competitors = 150 total)
  web_fetch_calls: 20           # Full page reads per day
  total_daily_limit: 200        # Hard cap including all intel activities
  
  # Allocation per scan type
  price_check: 3                # per competitor
  content_scan: 2               # per competitor  
  social_scan: 3                # total (batch queries)
  job_scan: 2                   # per competitor (weekly only)
  alerts_reserve: 10            # reserved for alert follow-ups
```

### Agent Configuration: What Goes in USER.md

During onboarding or when user activates competitive intel:
```yaml
# Added to USER.md
competitive_intelligence:
  enabled: true
  competitors:
    - name: "CompetitorX"
      domain: "competitorx.com"
      twitter: "@competitorx"
      priority: "primary"
    - name: "CompetitorY"
      domain: "competitory.com"
      twitter: "@competitory"
      priority: "secondary"
  delivery:
    daily_digest: true
    daily_time: "08:00"
    weekly_report: true
    weekly_day: "Sunday"
    real_time_alerts: true
    channel: "telegram"  # or discord
  focus_areas:
    - pricing
    - features
    - hiring
    - social_sentiment
    - content
  crypto_intel:
    enabled: true
    tokens: ["$INSTACLAW", "$CLAWLANCER"]
    projects: ["competitorproject1", "competitorproject2"]
```

### Common Mistakes

1. **Over-alerting** — Don't send real-time alerts for every blog post. Only critical events (funding, major launches, price changes >10%) get real-time treatment. Everything else goes in the daily digest.

2. **Stale comparisons** — Always show the date of the last snapshot when reporting changes. "Price changed from $89 to $99" is useless without "compared to snapshot from Feb 14."

3. **Confusing correlation with causation** — "CompetitorX posted 3 jobs AND their pricing went up" does not mean they raised prices to fund hiring. Present data, don't speculate on connections unless evidence supports it.

4. **Ignoring rate limits** — 5 competitors × 10 search queries each × daily = 50 API calls just for intel. Budget carefully. Cache aggressively. Job scans are weekly, not daily.

5. **Presenting search rankings as precise** — Brave Search results are personalized and fluctuate. Say "approximately rank #8" not "rank #8." Use directional trends, not exact positions.

### Quality Checklist
- [ ] All data includes source URL and timestamp
- [ ] Price comparisons show both old and new values with percentage change
- [ ] Sentiment analysis includes sample size (not just percentages)
- [ ] Weekly report includes strategic recommendations (not just data dump)
- [ ] Real-time alerts include "so what" implications and suggested actions
- [ ] Crypto intel clearly separates search-based data from API-based data
- [ ] Historical snapshots stored after every scan for future comparison
- [ ] Rate limits respected — total API calls within daily budget
- [ ] Competitor names and data are accurate (no hallucinated company details)
- [ ] Delivery format matches user preference (Telegram/Discord/email)

---

## Skill 11: Voice & Audio Production

### Overview
Gives every InstaClaw agent the ability to generate professional voiceovers, audio content, and voice messages using text-to-speech APIs. The killer application: Remotion videos with synchronized voiceovers — transforming silent motion graphics into broadcast-quality content with one command.

This skill fills the single biggest gap in the video production workflow. Silent Remotion videos look great but feel amateur on social media where audio is expected. Adding voice turns a $50 motion graphic into a $500 professional video.

### Trigger Metadata
```yaml
name: voice-audio-production
version: 1.0.0
updated: 2026-02-21
author: InstaClaw
triggers:
  keywords: [voiceover, voice, audio, narration, TTS, text to speech, podcast, speech, sound, voice message, narrator]
  phrases: ["add voiceover", "make a voiceover", "generate audio", "text to speech", "podcast intro", "voice message", "narrate this", "read this aloud", "audio version", "add narration to video"]
  NOT: [play music, music production, voice call, phone call, transcribe audio, speech to text]
```

### Prerequisites
- **TTS API access** (ElevenLabs for premium, OpenAI TTS for standard — InstaClaw supplies both)
- **FFmpeg** (already installed on all VMs — handles format conversion, mixing, normalization)
- **Remotion** (already installed — for video+audio integration)

### TTS Provider Matrix

| Provider | Quality | Cost | Integration | Best For |
|---|---|---|---|---|
| **ElevenLabs** | 10/10 | $5-99/mo | 9/10 — REST API | Remotion voiceovers, podcast intros, any public-facing content |
| **OpenAI TTS** | 8/10 | ~$0.015/1K chars | 10/10 — simplest API | Voice messages, document summaries, draft audio, cost-sensitive |
| **Google Cloud TTS** | 7/10 | $4-16/1M chars | 7/10 — needs GCP setup | Enterprise users already on GCP, multilingual needs |
| **Amazon Polly** | 6/10 | $4-16/1M chars | 7/10 — needs AWS setup | High volume notifications, IVR, quality not critical |

**InstaClaw Default Configuration:**
```yaml
tts_providers:
  primary:
    provider: "elevenlabs"
    api_key: ${ELEVENLABS_API_KEY}  # InstaClaw supplies for Pro/Power users
    model: "eleven_monolingual_v1"
    default_voice: "professional_male"  # Agent can switch per task
    quality: "premium"
  
  fallback:
    provider: "openai"
    api_key: ${OPENAI_API_KEY}  # Already available (same key as LLM)
    model: "tts-1-hd"
    default_voice: "alloy"
    quality: "standard"
  
  tier_access:
    free_starter:
      provider: "openai"
      monthly_limit: "30 minutes"      # ~$0.40/user/month to InstaClaw
    pro:
      provider: "elevenlabs"
      monthly_limit: "2 hours"         # ~$4.80/user/month
    power:
      provider: "elevenlabs"
      monthly_limit: "8 hours"         # ~$19.20/user/month
    byok:
      provider: "user_choice"
      monthly_limit: "unlimited"       # User's own API key
```

### Audio Workflow Rankings (By User Demand)

**1. Voiceover for Remotion Videos ⭐⭐⭐⭐⭐ — THE KILLER FEATURE**

This is why the skill exists. Silent videos → professional videos with one command.

**2. Podcast Intro/Outro Generation ⭐⭐⭐⭐**

Agents can write and produce audio intros for podcasts, YouTube channels, presentations.

**3. Audio Summaries of Documents ⭐⭐⭐⭐**

"Listen to this report while driving" — agent summarizes document, generates MP3, sends via Telegram.

**4. Voice Messages via Telegram ⭐⭐⭐**

Agent replies with voice notes instead of text. More personal, good for lengthy responses.

**5. Accessibility (Reading Content Aloud) ⭐⭐⭐**

Important for inclusivity — agent reads content aloud for visually impaired users.

### Workflow 1: Remotion Video with Voiceover (Complete Pipeline)

This is the end-to-end workflow from "make me a video" to final MP4 with synchronized voiceover.

**STEP 1: Generate Script**
```javascript
// Agent writes voiceover script based on video requirements
const script = `Welcome to InstaClaw. The AI agent platform that works 24/7. 
Traditional chatbots just answer questions. InstaClaw agents take action. 
Deploy your own AI agent in 60 seconds. Try it today.`;

// Script timing (agent estimates based on speech rate ~150 words/min)
const estimatedDuration = (script.split(' ').length / 150) * 60; // seconds
```

**STEP 2: Generate Audio via ElevenLabs**
```javascript
const generateVoiceover = async (script, voiceId = 'professional_male') => {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: script,
        model_id: 'eleven_monolingual_v1',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75
        }
      })
    }
  );
  
  const audioBuffer = await response.arrayBuffer();
  fs.writeFileSync('public/voiceover.mp3', Buffer.from(audioBuffer));
  return 'public/voiceover.mp3';
};
```

**Fallback to OpenAI TTS (if ElevenLabs unavailable or user on Free tier):**
```javascript
const generateVoiceoverOpenAI = async (script, voice = 'alloy') => {
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'tts-1-hd',
      voice: voice,
      input: script
    })
  });
  
  const audioBuffer = await response.arrayBuffer();
  fs.writeFileSync('public/voiceover.mp3', Buffer.from(audioBuffer));
  return 'public/voiceover.mp3';
};
```

**STEP 3: Get Exact Audio Duration**
```bash
# Using ffprobe (part of ffmpeg, already installed)
ffprobe -v error -show_entries format=duration -of csv=p=0 public/voiceover.mp3
# Output: 18.5 (seconds)
```

```javascript
const { execSync } = require('child_process');
const getAudioDuration = (filePath) => {
  const result = execSync(
    `ffprobe -v error -show_entries format=duration -of csv=p=0 ${filePath}`
  );
  return parseFloat(result.toString().trim());
};

const duration = getAudioDuration('public/voiceover.mp3');
// 18.5 seconds
```

**STEP 4: Set Video Duration to Match Audio**
```javascript
// In Root.tsx — Remotion composition
import { Composition } from 'remotion';

const fps = 30;
const audioDuration = 18.5; // From ffprobe

<Composition
  id="ProductDemo"
  component={ProductDemo}
  durationInFrames={Math.ceil(audioDuration * fps)}  // 555 frames
  fps={fps}
  width={1920}
  height={1080}
/>
```

**STEP 5: Add Audio Track to Remotion Video**
```javascript
// In ProductDemo.tsx — the video component
import { Audio, staticFile, AbsoluteFill } from 'remotion';

export const ProductDemo = () => {
  return (
    <AbsoluteFill>
      {/* Visual scenes */}
      <IntroScene />
      <ProblemScene />
      <SolutionScene />
      <CTAScene />
      
      {/* Voiceover track */}
      <Audio src={staticFile('voiceover.mp3')} volume={1.0} />
      
      {/* Optional: Background music at lower volume */}
      <Audio src={staticFile('background-music.mp3')} volume={0.15} />
    </AbsoluteFill>
  );
};
```

**STEP 6: Sync Visual Scenes to Script Beats**
```javascript
// Time visual transitions to match voiceover content
const scriptBeats = {
  intro:    { start: 0, end: 3 },      // "Welcome to InstaClaw..."
  problem:  { start: 3, end: 8 },      // "Traditional chatbots..."
  solution: { start: 8, end: 15 },     // "InstaClaw agents take action..."
  cta:      { start: 15, end: 18.5 }   // "Try it today..."
};

export const ProductDemo = () => {
  const frame = useCurrentFrame();
  const fps = useVideoConfig().fps;
  const currentTime = frame / fps;  // Current time in seconds
  
  return (
    <AbsoluteFill>
      {currentTime < scriptBeats.intro.end && <IntroScene />}
      {currentTime >= scriptBeats.problem.start && currentTime < scriptBeats.problem.end && <ProblemScene />}
      {currentTime >= scriptBeats.solution.start && currentTime < scriptBeats.solution.end && <SolutionScene />}
      {currentTime >= scriptBeats.cta.start && <CTAScene />}
      
      <Audio src={staticFile('voiceover.mp3')} volume={1.0} />
    </AbsoluteFill>
  );
};
```

**STEP 7: Render Final Video**
```bash
npx remotion render ProductDemo output.mp4
```

Result: Professional MP4 with synchronized voiceover + optional background music. Ready to post.

### Workflow 2: Podcast Intro/Outro Generation

```javascript
// Agent generates podcast intro script
const introScript = `Welcome to The AI Agent Show, the podcast where we explore 
how artificial intelligence is reshaping work, creativity, and the future. 
I'm your host. Let's dive in.`;

// Generate with professional voice
const audioPath = await generateVoiceover(introScript, 'professional_narrator');

// Mix with music bed
execSync(`
  ffmpeg -i ${audioPath} -i public/intro-music.mp3 \
    -filter_complex "[1:a]volume=0.2[bg];[0:a][bg]amix=inputs=2:duration=longest" \
    output/podcast-intro.mp3
`);
```

### Workflow 3: Audio Summary of Document

When user says: "Summarize this report as audio" or "Read me the highlights"

```javascript
// 1. Agent reads document and creates summary
const summary = await summarizeDocument(documentText, {
  maxWords: 750,  // ~5 minutes of audio at 150 wpm
  style: 'conversational'  // Not robotic reading, natural speech
});

// 2. Generate audio
const audioPath = await generateVoiceover(summary, 'alloy');  // OpenAI — cheaper for summaries

// 3. Optimize for mobile (compress for Telegram)
execSync(`ffmpeg -i ${audioPath} -b:a 96k -ac 1 output/summary.mp3`);

// 4. Deliver via Telegram
await sendTelegramAudio(userId, 'output/summary.mp3', 'Report Summary — 5 min listen');
```

### Workflow 4: Voice Messages via Telegram

Agent sends voice replies instead of text when user enables "voice mode":

```javascript
// Check if user prefers voice
if (userPreferences.voiceMode) {
  const responseText = "Here's what I found about your competitor pricing...";
  
  // Generate voice message (OpenAI — faster, cheaper for quick messages)
  const audioPath = await generateVoiceoverOpenAI(responseText, 'nova');
  
  // Convert to Telegram voice format (OGG Opus)
  execSync(`ffmpeg -i ${audioPath} -c:a libopus output/voice-reply.ogg`);
  
  // Send as voice message
  await sendTelegramVoice(userId, 'output/voice-reply.ogg');
}
```

### Audio Processing Toolkit

All processing uses FFmpeg (already installed on every VM):

**Format Conversion:**
```bash
# MP3 → OGG Opus (Telegram voice messages)
ffmpeg -i input.mp3 -c:a libopus output.ogg

# WAV → AAC (Apple devices)  
ffmpeg -i input.wav -c:a aac output.m4a

# Any → compressed MP3
ffmpeg -i input.wav -c:a libmp3lame -b:a 128k output.mp3
```

**Audio Normalization (consistent volume):**
```bash
ffmpeg -i input.mp3 -af "loudnorm" output.mp3
```

**Mixing (voiceover + background music):**
```bash
# Music at 20% volume behind voiceover
ffmpeg -i voiceover.mp3 -i music.mp3 \
  -filter_complex "[1:a]volume=0.2[bg];[0:a][bg]amix=inputs=2:duration=first" \
  output.mp3
```

**Compression (reduce file size for messaging):**
```bash
# Mono, 96kbps — good enough for voice, small file
ffmpeg -i input.mp3 -b:a 96k -ac 1 output.mp3
```

**Trimming/Cutting:**
```bash
# Cut first 2 seconds (remove TTS lead-in silence)
ffmpeg -i input.mp3 -ss 2 output.mp3

# Extract 10 seconds starting at 5s
ffmpeg -i input.mp3 -ss 5 -t 10 output.mp3
```

**Silence Detection & Removal:**
```bash
# Remove leading/trailing silence
ffmpeg -i input.mp3 -af "silenceremove=start_periods=1:start_silence=0.5:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_silence=0.5:start_threshold=-50dB,areverse" output.mp3
```

### Voice Selection Guide

| Use Case | ElevenLabs Voice | OpenAI Voice | Why |
|---|---|---|---|
| Product demo video | Professional Male/Female | alloy | Authority, trust |
| Explainer video | Warm Narrator | nova | Approachable, clear |
| Podcast intro | Deep Professional | onyx | Gravitas |
| Voice message reply | Casual Conversational | shimmer | Friendly, natural |
| Document summary | Clear, Measured | echo | Easy to follow |
| Accessibility reading | Natural, Unhurried | fable | Comfortable pace |

### Deployment: InstaClaw-Supplied for All Users

**ElevenLabs (Pro/Power tiers):**
```yaml
# Added to InstaClaw Vercel environment
ELEVENLABS_API_KEY: "sk_..."  # InstaClaw master key

# Written to VM .env during configureOpenClaw()
ELEVENLABS_API_KEY=${ELEVENLABS_API_KEY}

# Cost structure
elevenlabs:
  plan: "Creator"              # $22/mo — 100k chars (~1 hour audio)
  fleet_strategy: "shared_key" # All agents share one key
  per_agent_limit: "monthly"   # Track per-agent usage
  overage: "fallback_to_openai" # If limit hit, switch to OpenAI TTS
```

**OpenAI TTS (all tiers — already available):**
```yaml
# OpenAI API key already deployed for LLM access
# TTS uses same key, different endpoint
# No additional cost setup — pay per use ($0.015/1K chars)
```

**Fleet deployment steps:**
1. Get ElevenLabs Creator API key ($22/mo)
2. Add `ELEVENLABS_API_KEY` to InstaClaw Vercel environment
3. Update `configureOpenClaw()` to write key to VM `.env`
4. Install ffmpeg verification (should already be there, verify)
5. Fleet patch script pushes to all existing VMs
6. Verify: Agent runs `generateVoiceover("Hello world")` and returns audio file

**Cost to InstaClaw:**
| Tier | Provider | Monthly Limit | Cost/User/Month |
|---|---|---|---|
| Free/Starter | OpenAI TTS | 30 min audio | ~$0.40 |
| Pro ($99/mo) | ElevenLabs | 2 hours audio | ~$4.80 |
| Power ($299/mo) | ElevenLabs | 8 hours audio | ~$19.20 |
| BYOK | User's choice | Unlimited | $0.00 |

At 100 Pro users: ~$480/mo in TTS costs against $9,900/mo in subscription revenue = 4.8% COGS. Very healthy margin.

### Rate Limiting & Usage Tracking

```yaml
# Per-agent audio budget
audio_budget:
  free_starter:
    monthly_chars: 450000       # ~30 min at 150 wpm
    daily_max_requests: 10
    max_single_request: 5000    # chars (~3.5 min audio)
  
  pro:
    monthly_chars: 1800000      # ~2 hours
    daily_max_requests: 50
    max_single_request: 15000   # ~10 min audio
  
  power:
    monthly_chars: 7200000      # ~8 hours
    daily_max_requests: 200
    max_single_request: 50000   # ~35 min audio

# Usage tracking
audio_usage:
  log_file: "workspace/audio-usage.json"
  track:
    - chars_used_today
    - chars_used_this_month
    - requests_today
    - provider_used
    - estimated_cost
  alert_at: 80                  # Warn user at 80% of monthly limit
  overage_action: "fallback_to_openai"  # Don't hard-stop, degrade gracefully
```

### Integration with Other Skills

**Skill 1 (Remotion) + Skill 11 (Voice):**
The primary integration. Agent generates video script → voiceover → synced Remotion video.

**Skill 4 (Kling AI) + Skill 11 (Voice):**
Agent generates Kling AI cinematic video → adds voiceover narration → delivers final video with audio.

**Skill 7 (Financial Analysis) + Skill 11 (Voice):**
Agent generates morning market briefing → converts to audio summary → sends via Telegram voice message for commute listening.

**Skill 10 (Competitive Intel) + Skill 11 (Voice):**
Agent generates daily competitive digest → converts to 2-minute audio briefing → delivers as podcast-style update.

### Common Mistakes

1. **Not matching video duration to audio** — The most common error. Video scenes must be timed to the voiceover, not the other way around. Generate audio FIRST, get exact duration from ffprobe, THEN set Remotion composition duration.

2. **Using ElevenLabs for everything** — ElevenLabs is premium and costs more. Use OpenAI TTS for internal/draft content, voice messages, and document summaries. Reserve ElevenLabs for public-facing content (videos, podcasts).

3. **Ignoring audio normalization** — Different TTS providers output at different volumes. Always run `loudnorm` filter before mixing or delivering. Inconsistent volume is immediately noticeable and unprofessional.

4. **Wrong format for platform** — Telegram voice messages need OGG Opus. Apple devices prefer AAC. Web playback needs MP3. Always convert to the right format for the delivery channel.

5. **Script too long for single TTS call** — Most TTS APIs have character limits per request (ElevenLabs: 5000 chars per call on lower tiers). For longer content, split script into segments, generate separately, then concatenate with ffmpeg: `ffmpeg -i "concat:part1.mp3|part2.mp3" output.mp3`

6. **Not removing TTS silence** — Most TTS engines add 0.5-1s of silence at the start/end. For video voiceovers, this creates misalignment. Use the silence removal ffmpeg filter before syncing to video.

7. **Forgetting to track usage** — TTS costs add up. Without usage tracking, a single agent generating hours of audio could blow through the monthly budget. Always log chars used and check against limits before generating.

### Quality Checklist
- [ ] Audio file plays correctly (not corrupted, correct format)
- [ ] Volume is normalized (loudnorm applied)
- [ ] Leading/trailing silence removed
- [ ] Correct voice selected for use case (professional for videos, casual for messages)
- [ ] If Remotion integration: video duration matches audio duration exactly
- [ ] If Remotion integration: scene transitions align with script beats
- [ ] If mixing: background music doesn't overpower voiceover (music at 15-25% volume)
- [ ] File size appropriate for delivery channel (compressed for Telegram)
- [ ] Usage logged and within monthly budget
- [ ] Fallback provider works if primary is unavailable or over limit
- [ ] Output format matches delivery channel (OGG for Telegram, MP3 for general, AAC for Apple)


---

## Skill 12: E-Commerce & Marketplace Operations

### Overview
Transforms every InstaClaw agent into a full-time e-commerce operations manager. Agent connects to Shopify, Amazon, eBay (and eventually Walmart), syncs inventory across channels, processes returns end-to-end, monitors competitor pricing, and generates unified P&L reports — handling the tedious 80% of multi-channel selling that eats 2+ hours every day.

**Why this matters:** There are 5-6M marketplace sellers globally. Multi-channel sellers ($50k-$5M/year) currently spend $2,000-4,000/month on VAs + SaaS tools to handle daily operations. The #1 pain point — manually relaying return requests between customers, platforms, and warehouses — is a perfect agent automation target.

**Customer feedback that inspired this skill:**
> "If you could have some type of integration with Shopify, marketplaces like Amazon, eBay, Walmart — that's going to get you a very large pool of potential customers."

### Trigger Metadata
```yaml
name: ecommerce-marketplace-ops
version: 1.0.0
updated: 2026-02-21
author: InstaClaw
triggers:
  keywords: [Shopify, Amazon, eBay, Walmart, orders, inventory, returns, RMA, fulfillment, shipping, marketplace, e-commerce, ecommerce, SKU, listing, pricing, ShipStation]
  phrases: ["process this return", "check my orders", "sync inventory", "what sold today", "update my prices", "create a listing", "generate RMA", "daily sales report", "ship this order", "how much did I sell", "low stock alert"]
  NOT: [personal shopping, buy this item, add to cart, consumer purchase]
```

### Prerequisites
- **Platform MCP servers** (installed on VM, user provides their own API credentials — BYOK)
- **ShipStation API** (for fulfillment/RMA workflows — most sellers already have this)
- **AgentMail** (Skill 8 — for sending RMA emails to customers)
- **Heartbeat/Cron** (for scheduled inventory sync, order monitoring, daily reports)

### Platform Integration Matrix

| Platform | MCP Server | API Quality | Setup Difficulty | Rate Limits | Cost to User |
|---|---|---|---|---|---|
| **Shopify** | Official Dev MCP ✅ | 10/10 | EASY (10 min) | 1000 pts/sec GraphQL | FREE |
| **Amazon** | `amazon_sp_mcp` ✅ | 8/10 | HARD (30-45 min) | 60-80/hour key endpoints | FREE |
| **eBay** | `ebay-mcp` (325 tools!) ✅ | 9/10 | MEDIUM (15-20 min) | 5K-50K/day | FREE |
| **Walmart** | Needs building ⚠️ | Unknown | Unknown | Unknown | FREE |
| **ShipStation** | Needs building ⚠️ | 8/10 | EASY (5 min) | 40 calls/min | FREE |

**Capabilities per platform:**

| Operation | Shopify | Amazon | eBay | ShipStation |
|---|---|---|---|---|
| Read orders | ✅ | ✅ | ✅ | ✅ |
| Update inventory | ✅ | ✅ | ✅ | ✅ |
| Process returns/RMAs | ✅ | ✅ | ✅ | ✅ |
| Create/edit listings | ✅ | ✅ | ✅ | — |
| Adjust pricing | ✅ | ✅ | ✅ | — |
| Manage fulfillment | ✅ | ✅ | ✅ | ✅ |
| View analytics | ✅ | ✅ | ✅ | ✅ |
| Customer messages | ⚠️ Limited | ✅ | ✅ | — |
| Manage ads | ❌ Separate API | ⚠️ Separate API | ✅ | — |
| Generate shipping labels | — | — | — | ✅ |


### Architecture: Multi-Channel Commerce Hub

```
┌─────────────────────────────────────────────────────────┐
│                  InstaClaw Agent (VM)                    │
│                                                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐                │
│  │ Shopify  │ │ Amazon   │ │  eBay    │                │
│  │   MCP    │ │ SP-API   │ │   MCP    │                │
│  │  Server  │ │  MCP     │ │ Server   │                │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘                │
│       │             │             │                      │
│  ┌────┴─────────────┴─────────────┴────┐                │
│  │     Unified Operations Layer         │                │
│  │  • getOrders()    → all platforms    │                │
│  │  • syncInventory() → all platforms   │                │
│  │  • processReturn() → any platform    │                │
│  │  • generateReport() → unified data   │                │
│  └────┬────────────────────────────┬───┘                │
│       │                            │                     │
│  ┌────┴─────┐              ┌───────┴──────┐             │
│  │ShipStation│              │   Reports &  │             │
│  │   MCP    │              │  Analytics   │             │
│  └──────────┘              └──────────────┘             │
│                                                         │
│  Notifications → Telegram / Email (Skill 8)             │
└─────────────────────────────────────────────────────────┘
```

**Phase 1:** Install existing MCP servers separately (Shopify, Amazon, eBay)
**Phase 2:** Build "InstaClaw Commerce Hub" — unified abstraction layer wrapping all platforms

### Credential Storage (BYOK — User's Own Accounts)

```yaml
# ~/.openclaw/config/ecommerce.yaml (encrypted at rest via libsodium)
platforms:
  shopify:
    enabled: true
    shop: mystore.myshopify.com
    access_token: encrypted_value
    
  amazon:
    enabled: true
    lwa_client_id: encrypted
    lwa_client_secret: encrypted
    refresh_token: encrypted
    aws_access_key: encrypted
    aws_secret_key: encrypted
    seller_id: encrypted
    marketplace_id: "ATVPDKIKX0DER"
    
  ebay:
    enabled: true
    app_id: encrypted
    cert_id: encrypted
    user_token: encrypted
    
fulfillment:
  system: shipstation
  api_key: encrypted
  api_secret: encrypted
  
policies:
  return_window_days: 30
  auto_approve_threshold: 100
  require_human_over: 200
  restocking_fee_pct: 0
  low_stock_threshold: 10
  inventory_buffer_units: 5
  max_price_change_pct: 20
```

Security: Encrypted at rest (libsodium), never logged, access restricted to MCP servers only.

### Onboarding Flow: configureOpenClaw() Integration

```typescript
async function setupEcommerceIntegrations() {
  console.log('\n🛒 E-Commerce Setup\n');
  
  const platforms = await prompt('Which marketplaces do you sell on?', {
    type: 'checkbox',
    choices: [
      { name: 'Shopify', value: 'shopify' },
      { name: 'Amazon', value: 'amazon' },
      { name: 'eBay', value: 'ebay' },
      { name: 'Walmart', value: 'walmart' },
      { name: 'None / Skip', value: 'none' }
    ]
  });
  
  if (platforms.includes('none')) return;
  
  for (const platform of platforms) {
    if (platform === 'shopify') {
      // EASY: 2 fields, 10 minutes
      const shop = await prompt('Store domain (e.g., mystore.myshopify.com)');
      const token = await prompt('Admin API Access Token', { type: 'password' });
      await testAndSave('shopify', { shop, token });
    }
    else if (platform === 'amazon') {
      // HARD: Multi-step OAuth, 30-45 minutes
      console.log('Amazon requires multiple credentials (~30 min setup)');
      console.log('📖 Guide: https://docs.instaclaw.io/ecommerce/amazon\n');
      const proceed = await prompt('Continue?', { type: 'confirm', default: false });
      if (!proceed) { console.log('Run `openclaw config ecommerce` later'); continue; }
      // LWA Client ID/Secret, Refresh Token, AWS creds, Seller ID
      // ... full OAuth flow
    }
    else if (platform === 'ebay') {
      // MEDIUM: OAuth flow, 15-20 minutes
      const appId = await prompt('eBay App ID (Client ID)');
      const certId = await prompt('eBay Cert ID', { type: 'password' });
      await testAndSave('ebay', { appId, certId });
    }
  }
  
  // Fulfillment system
  const wms = await prompt('Fulfillment system?', {
    type: 'list',
    choices: ['ShipStation', 'ShipBob', 'FBA', 'Self-fulfill', 'Other']
  });
  
  // Return policy
  const returnWindow = await prompt('Return window (days)', { default: 30 });
  const autoApprove = await prompt('Auto-approve returns under ($)', { default: 100 });
  
  console.log('\n✅ E-commerce setup complete!');
  console.log('• Pull orders from all platforms');
  console.log('• Sync inventory across channels');
  console.log('• Process returns and generate RMAs');
  console.log('• Generate daily P&L reports\n');
}
```

**Detailed Per-Platform Setup Functions:**

```typescript
async function setupShopify() {
  console.log('To connect Shopify, you need:');
  console.log('1. Admin API access token');
  console.log('2. Your store domain (.myshopify.com)\n');
  console.log('📖 Guide: https://docs.instaclaw.io/ecommerce/shopify\n');
  
  const shop = await prompt('Store domain (e.g., mystore.myshopify.com)');
  const token = await prompt('Admin API Access Token', { type: 'password' });
  
  console.log('Testing connection...');
  try {
    const test = await shopify.testConnection(shop, token);
    console.log(`✅ Connected to ${test.shop.name}`);
    await savePlatformCredentials('shopify', { shop, token });
  } catch (error) {
    console.error('❌ Connection failed:', error.message);
    process.exit(1);
  }
}

async function setupAmazon() {
  console.log('Amazon SP-API requires multiple credentials:');
  console.log('1. LWA Client ID');
  console.log('2. LWA Client Secret');
  console.log('3. Refresh Token');
  console.log('4. AWS Access Key ID');
  console.log('5. AWS Secret Access Key');
  console.log('6. Seller ID\n');
  console.log('📖 Guide: https://docs.instaclaw.io/ecommerce/amazon');
  console.log('⏱️ This takes ~30 min to set up\n');
  
  const proceed = await prompt('Continue with Amazon setup?', { type: 'confirm', default: false });
  if (!proceed) {
    console.log('Skipping. Run `openclaw config ecommerce` later.');
    return;
  }
  
  console.log('\nStep 1: Register as SP-API Developer');
  console.log('Visit: https://sellercentral.amazon.com/apps/store/register');
  await prompt('Press Enter when you have LWA credentials...');
  
  const lwaClientId = await prompt('LWA Client ID');
  const lwaClientSecret = await prompt('LWA Client Secret', { type: 'password' });
  
  console.log('\nStep 2: Generate Refresh Token');
  console.log('Opening browser for OAuth authorization...');
  const refreshToken = await amazonOAuthFlow(lwaClientId, lwaClientSecret);
  
  console.log('\nStep 3: AWS Credentials');
  const awsAccessKey = await prompt('AWS Access Key ID');
  const awsSecretKey = await prompt('AWS Secret Access Key', { type: 'password' });
  
  console.log('\nStep 4: Seller ID');
  console.log('Find in Seller Central > Settings > Account Info');
  const sellerId = await prompt('Seller ID');
  
  console.log('\nTesting connection...');
  try {
    await amazon.testConnection({ lwaClientId, lwaClientSecret, refreshToken, awsAccessKey, awsSecretKey, sellerId });
    console.log('✅ Connected to Amazon Seller account');
    await savePlatformCredentials('amazon', {
      lwa_client_id: lwaClientId, lwa_client_secret: lwaClientSecret,
      refresh_token: refreshToken, aws_access_key: awsAccessKey,
      aws_secret_key: awsSecretKey, seller_id: sellerId
    });
  } catch (error) {
    console.error('❌ Connection failed:', error.message);
    process.exit(1);
  }
}
```

**Amazon Setup Complexity Mitigation:**
- **Option A:** Step-by-step video tutorial with pause points
- **Option B:** OAuth proxy (user clicks "Connect Amazon", we handle flow)
- **Option C:** Concierge onboarding ($99 one-time white-glove setup)
- **Option D:** Launch with Shopify first, add Amazon after value proven
- **Recommended:** D + A (Shopify first, Amazon with video tutorial)


### Workflow 1: RMA / Return Processing (End-to-End Automation)

**The killer workflow.** Customer's #1 pain point, fully automated.

**Manual process:** 10-15 min per return × 10 returns/day = 2+ hours daily.
**Agent process:** Seconds per return, human only inspects item when it arrives.

```
Return Request → Parse → Fetch Order → Check Eligibility
  → Create RMA → Generate Label → Email Customer → Track Shipment
  → [Item Arrives] → Human Inspects → Agent Processes Refund → Done
```

```typescript
async function handleReturnRequest(notification: Notification) {
  // STEP 1: Parse return request (email, platform notification, etc.)
  const request = parseReturnRequest(notification);
  
  // STEP 2: Find order across all platforms
  let order, platform;
  for (const p of ['shopify', 'amazon', 'ebay']) {
    try {
      order = await getOrder(p, request.order_number);
      if (order) { platform = p; break; }
    } catch (e) { continue; }
  }
  if (!order) { await notifyHuman('RETURN: Order not found', request); return; }
  
  // STEP 3: Validate eligibility
  const eligible = checkEligibility(order, {
    return_window_days: config.policies.return_window_days,
    restocking_fee: config.policies.restocking_fee_pct
  });
  
  if (!eligible.approved) {
    if (eligible.needs_human_review) {
      await notifyHuman('RETURN NEEDS REVIEW', { order, reason: eligible.reason });
      return;
    }
    await sendEmail({
      to: request.customer_email,
      subject: `Return Request — Order ${order.number}`,
      body: `We cannot accept this return: ${eligible.reason}`
    });
    return;
  }
  
  // STEP 4: Create RMA in warehouse system
  const rma = await shipStation.createRMA({
    order_id: order.id, order_number: order.number,
    customer: order.customer,
    items: request.items.map(i => ({ sku: i.sku, name: i.name, quantity: i.quantity, reason: request.reason })),
    warehouse: config.default_warehouse
  });
  
  // STEP 5: Generate return shipping label
  const label = await shipStation.createReturnLabel({
    rma_id: rma.rma_number,
    from_address: order.shipping_address,
    to_address: rma.return_address,
    weight: estimateWeight(request.items),
    service: 'USPS Priority Mail'
  });
  
  // STEP 6: Email customer with RMA + label
  await sendEmail({
    to: order.customer.email,
    subject: `Return Approved — RMA #${rma.rma_number}`,
    body: generateRMAEmail({
      customer_name: order.customer.name,
      rma_number: rma.rma_number,
      return_address: rma.return_address,
      tracking_number: label.tracking_number,
      refund_amount: calculateRefund(order, request.items, eligible)
    }),
    attachments: [{ filename: `return_label_${rma.rma_number}.pdf`, url: label.label_url }]
  });
  
  // STEP 7: Update platform order status
  await updateOrderStatus(platform, order.id, {
    status: 'return_initiated',
    note: `RMA ${rma.rma_number}. Tracking: ${label.tracking_number}`
  });
  
  // STEP 8: Store for tracking (daily cron monitors)
  await db.returns.insert({
    rma_number: rma.rma_number, order_id: order.id, platform,
    tracking_number: label.tracking_number, status: 'label_created',
    customer_email: order.customer.email,
    refund_amount: calculateRefund(order, request.items, eligible),
    created_at: new Date()
  });
  
  // STEP 9: Notify seller (FYI only)
  await notifyHuman('RMA CREATED', {
    rma: rma.rma_number, order: order.number,
    platform, action: 'RMA email sent, tracking active'
  }, { priority: 'low' });
}
```

**Daily Cron: Track Active Returns**
```typescript
async function trackActiveReturns() {
  const active = await db.returns.findAll({ status: ['label_created', 'in_transit'] });
  for (const ret of active) {
    const tracking = await shipStation.getTrackingInfo(ret.tracking_number);
    if (tracking.status === 'DELIVERED') {
      await db.returns.update(ret.id, { status: 'arrived' });
      await notifyHuman('RETURN ARRIVED — INSPECT', {
        rma: ret.rma_number, refund_amount: ret.refund_amount,
        action_needed: 'Inspect item, approve or reject refund'
      }, { priority: 'high' });
    }
  }
}
```

**Human Triggers Refund (After Inspection)**
```typescript
async function processRefund(rma_number: string, decision: 'approve' | 'reject', notes?: string) {
  const ret = await db.returns.findOne({ rma_number });
  if (decision === 'approve') {
    await issueRefund(ret.platform, ret.order_id, { amount: ret.refund_amount });
    await sendEmail({ to: ret.customer_email,
      subject: `Refund Processed — RMA #${rma_number}`,
      body: `Your refund of $${ret.refund_amount} has been processed. Allow 5-7 business days.`
    });
  } else {
    await sendEmail({ to: ret.customer_email,
      subject: `Return Update — RMA #${rma_number}`,
      body: `We cannot issue a refund. Reason: ${notes}`
    });
  }
}
```

**Autonomy Matrix:**
```yaml
fully_autonomous:
  - Parse return request
  - Fetch order from any platform
  - Check eligibility against policy
  - Create RMA number
  - Generate shipping label
  - Email customer with RMA + label
  - Track return shipment
  - Notify seller when item arrives

human_approval_required:
  - Returns outside policy window
  - Orders over configured threshold ($200 default)
  - Frequent returner flag
  - Item condition inspection
  - Final refund decision (full/partial/reject)
```

**Platform-Specific Return API Calls:**

```graphql
# SHOPIFY — Create return
mutation {
  returnCreate(input: {
    orderId: "gid://shopify/Order/123"
    returnLineItems: [{ lineItemId: "...", quantity: 1 }]
  }) { return { id, name } }
}

# SHOPIFY — Issue refund
mutation {
  refundCreate(input: {
    orderId: "gid://shopify/Order/123"
    refundLineItems: [{ lineItemId: "...", quantity: 1 }]
    transactions: [{ amount: "29.99", kind: REFUND }]
  }) { refund { id } }
}
```

```python
# AMAZON — Monitor return (customer-initiated via Amazon)
returns_api.get_return(return_id)

# AMAZON — Issue refund
orders_api.create_refund(
    order_id=order_id,
    refund_amount=29.99,
    refund_reason="CustomerReturn"
)
```

```javascript
// EBAY — Monitor return (buyer-initiated)
ebay.sell.return.getReturn(returnId)

// EBAY — Issue refund
ebay.sell.finances.issueRefund({
    orderId: orderId,
    refundAmount: { value: "29.99", currency: "USD" }
})
```


### Workflow 2: Cross-Platform Inventory Sync

**Problem:** Item sells on Amazon → still shows available on Shopify + eBay → overselling.

```typescript
async function syncInventory(sku: string, change: number, source: string) {
  const newQty = await db.inventory.adjustQty(sku, change);
  const buffer = config.policies.inventory_buffer_units;  // Safety buffer (default: 5)
  
  for (const platform of ['shopify', 'amazon', 'ebay'].filter(p => p !== source)) {
    try {
      await updatePlatformInventory(platform, sku, newQty - buffer);
    } catch (error) {
      await alert('INVENTORY SYNC FAILED', { platform, sku, error });
      await pauseListing(platform, sku);  // Pause listing until sync fixed
    }
  }
}

// Webhook listeners for real-time sync
webhooks.on('shopify.order.created', async (order) => {
  for (const item of order.items) await syncInventory(item.sku, -item.quantity, 'shopify');
});
webhooks.on('amazon.order.created', async (order) => {
  for (const item of order.items) await syncInventory(item.sku, -item.quantity, 'amazon');
});
webhooks.on('ebay.order.created', async (order) => {
  for (const item of order.items) await syncInventory(item.sku, -item.quantity, 'ebay');
});
```

**Sync schedule:** Real-time via webhooks (preferred) → 15-min cron fallback → full daily reconciliation at 2am.

### Workflow 3: Competitive Pricing Monitor

```typescript
async function monitorCompetitorPricing() {
  const products = await db.products.findAll();
  
  for (const product of products) {
    const amazonPricing = await amazon.pricing.getCompetitivePricing({ asin: product.asin });
    const lowestPrice = Math.min(...amazonPricing.offers.map(o => o.price));
    
    if (lowestPrice < product.price) {
      const newPrice = lowestPrice - 0.50;  // Undercut by $0.50
      const changePct = Math.abs((newPrice - product.price) / product.price * 100);
      
      if (changePct > config.policies.max_price_change_pct) {
        await notifyHuman('LARGE PRICE CHANGE NEEDS APPROVAL', {
          sku: product.sku, current: product.price, proposed: newPrice, change: `${changePct}%`
        });
        continue;
      }
      
      await updatePrice('shopify', product.sku, newPrice);
      await updatePrice('ebay', product.sku, newPrice);
      await updatePrice('amazon', product.sku, newPrice);
      await log('PRICE ADJUSTED', { sku: product.sku, old: product.price, new: newPrice });
    }
  }
}

// Run every 6 hours
cron.schedule('0 */6 * * *', monitorCompetitorPricing);
```

### Workflow 4: Unified Order Management & Daily Reports

```typescript
async function getUnifiedOrders(date: string = 'today') {
  const orders = {
    shopify: await shopify.getOrders({ created_at_min: date }),
    amazon: await amazon.getOrders({ created_after: date }),
    ebay: await ebay.getOrders({ creation_date_from: date })
  };
  
  // Normalize into unified format
  const unified = [];
  for (const [platform, platformOrders] of Object.entries(orders)) {
    for (const order of platformOrders) {
      unified.push({
        platform, order_number: order.id, customer: order.customer_email,
        total: order.total, items: order.items.length,
        status: normalizeStatus(order.status), created_at: order.created_at
      });
    }
  }
  return unified.sort((a, b) => b.created_at - a.created_at);
}

async function generateDailyReport() {
  const orders = await getUnifiedOrders();
  const report = `
📦 Daily Orders Report — ${new Date().toLocaleDateString()}

SUMMARY
Total Orders: ${orders.length}
Total Revenue: $${orders.reduce((s, o) => s + o.total, 0).toFixed(2)}

By Platform:
• Shopify: ${orders.filter(o => o.platform === 'shopify').length} orders
• Amazon: ${orders.filter(o => o.platform === 'amazon').length} orders
• eBay: ${orders.filter(o => o.platform === 'ebay').length} orders

NEEDS ATTENTION
${orders.filter(o => o.status === 'unfulfilled').length} unfulfilled orders
${orders.filter(o => o.status === 'pending_payment').length} pending payment

[View Full Report] [Process Orders]
  `;
  await sendTelegram(report);
}
```

### Workflow 5: Agent Daily Operations Schedule

```yaml
morning_8am:
  - Pull overnight orders from all platforms
  - Sync inventory across channels
  - Check for new return requests
  - Generate morning summary:
    "X new orders (Shopify: Y, Amazon: Z, eBay: W)
     Revenue: $X | Unfulfilled: X | Returns pending: X
     Low stock: [SKUs below threshold]"
  - Send via Telegram

continuous_monitoring:
  every_15_min: Check new orders, sync inventory
  every_30_min: Check customer messages across platforms
  every_hour: Process return requests
  every_2_hours: Monitor competitor pricing (with Brave Search)
  every_6_hours: Full competitive price adjustment run

evening_6pm:
  - End-of-day summary (orders, revenue, returns, issues)
  - Tomorrow's prep (orders to ship, stock to reorder, returns arriving)

weekly_sunday_8pm:
  - Weekly P&L report with charts
  - Top/bottom selling products
  - Slow-moving inventory recommendations
  - Competitor pricing analysis
  - Strategic recommendations for next week
```


### Risk Assessment & Guardrails

**RISK 1: Inventory Overselling**
- Mitigation: Real-time sync with 5-unit buffer across platforms
- Guardrail: If sync fails, pause listing on that platform until resolved
- Recovery: Full reconciliation cron at 2am catches any drift

**RISK 2: Wrong Pricing**
- Mitigation: Max auto-adjustment capped at 20% per 24 hours
- Guardrail: Changes >15% require human approval
- Recovery: Price change log with rollback capability

**RISK 3: Fraudulent Returns**
- Mitigation: Flag frequent returners, cross-reference return history
- Guardrail: Returns >$200 always require human approval
- Recovery: Configurable auto-approve thresholds in USER.md

**RISK 4: Shipping to Wrong Address**
- Mitigation: Validate address against order before label generation
- Guardrail: International orders always confirmed by human

**RISK 5: Customer Communication Errors**
- Mitigation: Template-based emails for standard flows (RMA, refund, rejection)
- Guardrail: Any email mentioning refund/legal/complaint flagged for review

### Integration with Other Skills

**Skill 8 (Email):** Agent emails customers about returns, RMA numbers, refund confirmations — all through the agent's @instaclaw.io address or drafted for user's Gmail.

**Skill 10 (Competitive Intel):** Monitor Amazon competitor prices, feed into auto-pricing engine. Daily competitive digest includes pricing intelligence across all platforms.

**Skill 7 (Financial Analysis):** Pull sales data for financial analysis, calculate COGS, margins, and platform fee breakdowns.

**Skill 11 (Voice & Audio):** Generate audio summary of daily sales performance, delivered as Telegram voice message for commute listening.

### services.yaml Configuration

```yaml
ecommerce:
  enabled: true
  platforms:
    - shopify
    - amazon
    - ebay
  
  operations:
    - order_sync
    - inventory_sync
    - return_processing
    - pricing_updates
    - analytics
  
  automations:
    returns:
      auto_approve_threshold: 100
      require_human_approval_over: 200
      auto_reject_outside_window: true
    inventory:
      sync_interval_minutes: 15
      low_stock_alert_threshold: 10
      buffer_units: 5
    pricing:
      competitor_monitoring: true
      max_price_change_pct: 20
      require_human_over_pct: 15
  
  reports:
    daily_summary: true
    weekly_pnl: true
    monthly_analytics: true
  
  notifications:
    low_stock: telegram
    return_arrived: telegram
    order_issues: email
    daily_summary: telegram
```

### Build Timeline

```
Phase 1: Core Integration (5 weeks) — MVP
├── Week 1: Install existing MCP servers (Shopify, Amazon, eBay)
├── Week 2: Build onboarding flow + credential storage
├── Week 3-4: RMA workflow automation (killer feature)
└── Week 5: Testing + polish

Phase 2: Fulfillment (2 weeks)
├── Week 6: Build ShipStation MCP server
└── Week 7: Integrate with RMA workflow

Phase 3: Advanced Features (4 weeks)
├── Week 8-9: Multi-channel inventory sync
├── Week 10: Competitive pricing engine
└── Week 11: Analytics/reporting dashboards

Phase 4: Walmart (3-4 weeks, optional)
├── Week 12-14: Build Walmart MCP server + integration
└── Week 15: Testing

TOTAL: 11-15 weeks (3-4 months)
MVP (RMA + orders): 5 weeks
```

**Launch order:** Shopify + ShipStation first (low friction) → Amazon (high impact) → eBay (round out top 3) → Walmart (if demand).

**Platform Priority Ranking:**

| Priority | Platform | Rating | Rationale |
|---|---|---|---|
| 1 | Shopify | ⭐⭐⭐⭐⭐ | Easiest setup, best API, largest market, official MCP exists |
| 2 | Amazon | ⭐⭐⭐⭐⭐ | Largest marketplace, highest revenue/seller, complex setup but worth it |
| 3 | ShipStation | ⭐⭐⭐⭐⭐ | CRITICAL for RMA workflow, most sellers use this, easy API |
| 4 | eBay | ⭐⭐⭐⭐ | Good API, 325-tool MCP exists, easier than Amazon |
| 5 | Walmart | ⭐⭐ | Smallest market, may need custom MCP, lower priority |

**Other WMS/Fulfillment Options (Phase 3+):**
- **ShipBob** (3PL): REST API ✅ — create fulfillment orders, receive inventory, track shipments, returns management
- **SkuVault:** Has API — warehouse management
- **Ordoro:** Has API — inventory + shipping
- **Easyship:** Has API — international shipping
- **Pirate Ship:** Has API — label generation (USPS/UPS discounts)
- **Direct Carriers:** USPS, UPS, FedEx APIs for sellers without WMS

**Recommended approach:** ShipStation first (covers 60%+ of multi-channel sellers) → direct carrier APIs → ShipBob/Ordoro on demand.

### Market Opportunity

```yaml
addressable_market:
  shopify_stores: 2,500,000+
  amazon_sellers: 1,900,000+
  ebay_sellers: 1,300,000+
  total: 5,700,000+ (many sell multi-channel)

target_segment:
  description: "Multi-channel sellers, $50k-$5M/year, 5-50 orders/day"
  estimated_count: 500,000-1,000,000

current_spend:
  virtual_assistant: $1,500-3,000/month
  ecommerce_saas_tools: $200-500/month
  shipstation: $29-159/month
  total: $2,000-4,000/month

instaclaw_pricing:
  replaces: "VA + multiple SaaS tools"
  price_point: $299-999/month
  value_prop: "24/7 operation, faster than human, all platforms unified"

revenue_projection:
  conservative: "1,000 customers × $299/mo = $299K MRR → $3.6M ARR"
  realistic: "5,000 customers × $499/mo = $2.5M MRR → $30M ARR"
```

### Marketing Pitch

> "Your AI employee for e-commerce operations. InstaClaw agents manage your Shopify, Amazon, and eBay stores 24/7 — processing returns, syncing inventory, monitoring competitors, and generating daily P&L reports. The tedious work that takes you 2+ hours every day? Your agent does it in minutes while you sleep. No more copying RMA numbers between systems. No more overselling because inventory didn't sync. No more missing competitor price drops. Just wake up to a daily summary and approve what needs your attention. Setup takes 15 minutes. First month free."

### Common Mistakes

1. **Not testing API connections during onboarding** — Always verify credentials work before saving. A bad Shopify token that fails silently means the agent thinks there are zero orders.

2. **Syncing inventory without buffer** — Never set platform inventory to exact real count. Always subtract 5-unit buffer to prevent overselling during sync delays.

3. **Auto-adjusting prices without caps** — A competitor listing error ($0.01 price) could trigger your agent to race to the bottom. Always enforce max change % and minimum price floor.

4. **Processing returns for other sellers' orders** — Multi-channel sellers get emails about orders from many platforms. Agent must verify the order exists in the user's account before creating RMA.

5. **Generating shipping labels for wrong addresses** — Always validate the return address against the RMA before generating labels. One wrong label = real money lost.

6. **Over-communicating with customers** — Agent should send exactly 3 emails per return: (1) RMA approved + label, (2) refund processed, (3) rejection if applicable. No more.

### Quality Checklist
- [ ] All platform API connections verified during onboarding
- [ ] Inventory sync running at configured interval (default: 15 min)
- [ ] Buffer units applied to all platform inventory counts
- [ ] RMA workflow tested end-to-end (parse → label → email → track)
- [ ] Return eligibility checks matching configured policy
- [ ] Human approval triggered for orders over threshold
- [ ] Competitor pricing capped at max change % per 24 hours
- [ ] Daily report delivered at scheduled time
- [ ] Weekly P&L generated with cross-platform data
- [ ] Credential encryption verified (libsodium, never logged)
- [ ] Sync failures alerting immediately and pausing affected listings

---


---
---

## Agent Capability Awareness System

### The Problem

When we ship 12 skills across every InstaClaw VM, agents need to:

1. **Know what they can do** — accurately, no hallucination
2. **Know HOW to do it** — which tool, skill, or MCP server
3. **Never refuse something they CAN do** — "I can't send email" when AgentMail is installed
4. **Never claim they can do something they CAN'T** — "I can post to Twitter" when it's blocked

Without a systematic approach, adding skills creates confusion — agents may not discover new capabilities, or worse, confidently hallucinate capabilities they don't have.

### Solution: 3-Layer Capability Awareness

```
┌─────────────────────────────────────────────────────┐
│  Layer 1: CAPABILITIES.md (Always loaded at startup) │
│  ─ What I CAN do (✅), what's LIMITED (⚠️),          │
│    what I CANNOT do (❌)                              │
│  ─ Auto-generated from installed skills + MCP tools   │
├─────────────────────────────────────────────────────┤
│  Layer 2: Session Startup Routine (AGENTS.md update)  │
│  ─ Read CAPABILITIES.md at start of every session     │
│  ─ Ensures capabilities are always in context          │
├─────────────────────────────────────────────────────┤
│  Layer 3: "Before Refusing" Checklist (SOUL.md update)│
│  ─ Mandatory 5-step check before any "I can't"        │
│  ─ Forces resourcefulness over reflexive refusal       │
└─────────────────────────────────────────────────────┘
```

### Layer 1: CAPABILITIES.md (Auto-Generated, Always Loaded)

**Location:** `workspace/CAPABILITIES.md`
**Loaded:** Every session at startup (before first user interaction)
**Updated:** Auto-regenerated when skills installed, MCP servers change, or API keys added

```markdown
# CAPABILITIES.md — What I Can Do
*Last updated: 2026-02-21 22:04 UTC*
*MCP servers: 6 installed*
*Skills: 12 active*

## 🎬 VIDEO & MEDIA PRODUCTION
✅ Create marketing videos with Remotion (30s-2min)
✅ Generate cinematic AI video prompts (Kling AI)
✅ Add voiceovers to videos (ElevenLabs, OpenAI TTS)
✅ Extract frames from videos (FFmpeg)
✅ Convert video formats (MP4, WebM, GIF)
→ Skills: remotion-video-production, kling-ai-prompting, voice-audio-production

## 📧 EMAIL & COMMUNICATION
✅ Send/receive email autonomously ({agent_name}@instaclaw.io)
✅ Monitor user's Gmail (read, draft replies)
✅ Process OTP codes and verification emails
✅ Send attachments (PDFs, images)
✅ Real-time webhooks for incoming email
→ Skills: email-outreach

## 🛒 E-COMMERCE & MARKETPLACE
✅ Manage Shopify stores (orders, inventory, products, returns)
✅ Manage Amazon Seller Central (orders, inventory, pricing, fulfillment)
✅ Manage eBay (325 tools — orders, inventory, marketing, messaging)
✅ Process returns end-to-end (RMA generation, labels, tracking)
✅ Sync inventory across all platforms in real-time
✅ Generate shipping labels via ShipStation
⚠️ Walmart: Not yet integrated (planned)
→ Skills: ecommerce-marketplace-ops

## 🔍 COMPETITIVE INTELLIGENCE
✅ Monitor competitor pricing changes (daily scans)
✅ Track funding announcements and feature launches
✅ Analyze social media sentiment
✅ Generate daily digests and weekly deep-dive reports
✅ Real-time alerts for critical competitor moves
⚠️ Requires: Brave Search API key (check if configured)
→ Skills: competitive-intelligence

## 📱 SOCIAL MEDIA
✅ Generate platform-native content (threads, posts, captions)
✅ Content calendar management
✅ Reddit posting (API, bot-friendly)
⚠️ LinkedIn: Browser posting (fragile, ban risk)
❌ Twitter/X: Blocked without API key ($100/mo)
❌ Instagram: No web posting (mobile only)
❌ TikTok: No web posting (mobile only)
→ Skills: social-media-content

## 💰 FREELANCE & EARNING
✅ Claim bounties on Clawlancer (auto-polling every 2 min)
✅ Submit deliverables and receive USDC
✅ Check wallet balance (CDP wallet on Base)
✅ Send XMTP messages to other agents
→ Skills: marketplace-earning, clawlancer MCP

## 🌐 WEB & RESEARCH
✅ Fetch web pages (web_fetch tool)
✅ Browser automation (Chrome/Firefox)
✅ Take screenshots, fill forms, click buttons
⚠️ Web search: Requires Brave Search API key
⚠️ CAPTCHA: Blocked without 2Captcha integration
→ Skills: web-search-browser

## 💻 DEVELOPMENT & AUTOMATION
✅ Write/edit code (Python, JS, TypeScript, etc.)
✅ Run shell commands
✅ Install npm/pip packages
✅ Create APIs and servers
✅ Set up cron jobs and scheduled automations
✅ Use MCP servers (mcporter CLI)
→ Skills: code-execution

## 💵 FINANCIAL ANALYSIS
✅ Real-time stock quotes and historical data
✅ Cryptocurrency prices (with Alpha Vantage)
✅ Options chain analysis
✅ Technical indicators (SMA, RSI, MACD, etc.)
✅ Generate charts and market briefings
→ Skills: financial-analysis

## 🎨 BRAND & DESIGN
✅ Extract brand assets from any URL (logos, colors, fonts, voice)
✅ Generate brand guidelines
✅ Create DALL-E images matching brand style
→ Skills: brand-asset-extraction

## 📊 DATA & ANALYSIS
✅ Generate charts (matplotlib, plotly)
✅ Process CSV/Excel files (pandas)
✅ SQL databases (SQLite)
✅ Web scraping (Beautiful Soup, Puppeteer)

## ❌ WHAT I CANNOT DO
❌ Post to Twitter/Instagram/TikTok without API keys
❌ Solve CAPTCHAs (no 2Captcha integration)
❌ Make phone calls (no telephony)
❌ Access hardware (camera, microphone)
❌ Browse illegal content
❌ Modify system files or access other users' data
❌ Access Telegram/Discord directly (use message tool)

## 🔧 CAPABILITIES THAT NEED SETUP
Some features require API keys or configuration:
| Capability | Requirement | Status |
|---|---|---|
| Web Search | Brave Search API ($5/mo) | Check .env |
| Twitter Posting | Twitter API ($100/mo) | Check config |
| CAPTCHA Solving | 2Captcha API ($1-5/mo) | Check .env |
| Premium Voice | ElevenLabs API ($5-22/mo) | Check .env |
| Market Data | Alpha Vantage API ($49.99/mo) | Check .env |

## 🚀 BEFORE SAYING "I CAN'T"
1. Re-read this file
2. Check TOOLS.md
3. Run `mcporter list` for available MCP tools
4. Try at least one approach
5. Only then explain what's not possible and why
```

### Layer 2: Session Startup Routine (AGENTS.md Update)

Add to the "Every Session" section of AGENTS.md:

```markdown
## Every Session — Do This First

Before doing anything else:

1. **Check if `BOOTSTRAP.md` exists** — if so, this is first run.
   Read it + USER.md + MEMORY.md, then follow BOOTSTRAP.md instructions.
2. Read `SOUL.md` — this is who you are
3. Read `USER.md` — this is who you're helping
4. **Read `CAPABILITIES.md` — this is what you can do** ← CRITICAL
5. Read `memory/YYYY-MM-DD.md` (today + yesterday) for recent context
6. If in MAIN SESSION: Also read `MEMORY.md`

Don't ask permission. Just do it.
```

**Why this works:** Every session, the agent loads its full capability matrix into context. When a user says "can you process my Amazon returns?", the agent already knows the answer — it doesn't need to guess or hallucinate.

### Layer 3: "Before Refusing" Checklist (SOUL.md Update)

Add to SOUL.md:

```markdown
## Before Saying "I Can't"

You are a resourceful, autonomous agent. Your default is "yes, let me figure that out."

**Mandatory checklist before refusing any request:**

1. ✅ Did I check CAPABILITIES.md?
2. ✅ Did I check TOOLS.md?
3. ✅ Did I run `mcporter list` to see available MCP tools?
4. ✅ Did I try at least one approach?
5. ✅ Did I check if this is a skill I should load and read?

**Only after all 5 checks** can you say "I can't do this, here's why..."

**Good refusal:**
"I checked my capabilities and MCP tools — I don't have access to [X] because [reason].
Here are alternatives: [A, B, C]."

**Bad refusal:**
"I can't do that."

You have a full machine. Shell access, browser, file system, MCP tools,
email, web fetch, code execution. The answer is almost never "I can't" —
it's "let me try."
```

### Auto-Generation Script: generate-capabilities.ts

CAPABILITIES.md should never go stale. Auto-regenerate it when the agent's environment changes.

```typescript
// scripts/generate-capabilities.ts

async function generateCapabilities() {
  // 1. Scan installed skills
  const skills = await scanSkillDirectory('/home/user/skills/');
  // Each skill has trigger metadata with keywords, capabilities
  
  // 2. List MCP servers
  const mcpTools = execSync('mcporter list --json').toString();
  const mcpServers = JSON.parse(mcpTools);
  
  // 3. Check API keys (.env)
  const apiKeys = {
    brave_search: !!process.env.BRAVE_SEARCH_API_KEY,
    elevenlabs: !!process.env.ELEVENLABS_API_KEY,
    alphavantage: !!process.env.ALPHAVANTAGE_API_KEY,
    twitter: !!process.env.TWITTER_API_KEY,
    captcha: !!process.env.CAPTCHA_API_KEY
  };
  
  // 4. Check platform credentials (e-commerce)
  const ecommerce = {
    shopify: await testConnection('shopify'),
    amazon: await testConnection('amazon'),
    ebay: await testConnection('ebay')
  };
  
  // 5. Generate markdown
  const capabilities = buildCapabilitiesMarkdown({
    skills, mcpServers, apiKeys, ecommerce,
    timestamp: new Date().toISOString()
  });
  
  // 6. Write file
  await fs.writeFile('workspace/CAPABILITIES.md', capabilities);
  console.log('✅ CAPABILITIES.md regenerated');
}

// Regeneration triggers:
// - configureOpenClaw() completion
// - Skill installation (mcporter install)
// - API key added to .env
// - Manual: `openclaw capabilities refresh`
// - Fleet push (fleet-deploy-capabilities.sh)
```

### Quick Reference Card (workspace/QUICK-REFERENCE.md)

One-line lookup for common user requests:

```markdown
# Quick Reference — Common Tasks

| User Says | Skill/Tool | Action |
|---|---|---|
| "Send an email" | Email (Skill 8) | AgentMail send via API |
| "Create a video" | Remotion (Skill 1) | Load remotion skill, generate |
| "Add voiceover" | Voice (Skill 11) | ElevenLabs/OpenAI TTS → Remotion |
| "Check competitors" | Competitive Intel (Skill 10) | Brave Search + web_fetch |
| "Process this return" | E-Commerce (Skill 12) | RMA workflow → ShipStation |
| "What sold today?" | E-Commerce (Skill 12) | Pull orders from all platforms |
| "Sync inventory" | E-Commerce (Skill 12) | Cross-platform sync |
| "Find a bounty" | Clawlancer (Skill 6) | mcporter call list_bounties |
| "Write a tweet" | Social Media (Skill 9) | Generate content (posting may be blocked) |
| "Stock price of X" | Financial (Skill 7) | Alpha Vantage API |
| "Extract brand assets" | Brand (Skill 5) | Load brand-extraction skill |
| "Search the web" | Web Search (Skill 2) | Brave Search API (check if configured) |
| "What can you do?" | Meta | Read CAPABILITIES.md |
```

### Fleet Deployment: Pushing Capability Awareness to All Agents

When shipping all 12 skills, include capability awareness in the fleet push:

```bash
#!/bin/bash
# fleet-push-capability-awareness.sh
# Run AFTER pushing all skills

for VM in $(get_all_vms); do
  echo "Updating $VM..."
  
  # 1. Push generate-capabilities script
  scp scripts/generate-capabilities.ts $VM:/home/user/scripts/
  
  # 2. Run it (generates CAPABILITIES.md from installed skills + env)
  ssh $VM "cd /home/user && npx tsx scripts/generate-capabilities.ts"
  
  # 3. Push updated AGENTS.md (with startup routine)
  scp templates/AGENTS.md $VM:/home/user/workspace/AGENTS.md
  
  # 4. Push updated SOUL.md (with refusal checklist)
  # Note: Only append new section, don't overwrite learned preferences
  ssh $VM "cat >> /home/user/workspace/SOUL.md < /tmp/soul-refusal-checklist.md"
  
  # 5. Push QUICK-REFERENCE.md
  scp templates/QUICK-REFERENCE.md $VM:/home/user/workspace/QUICK-REFERENCE.md
  
  # 6. Verify
  ssh $VM "test -f /home/user/workspace/CAPABILITIES.md && echo '✅ CAPABILITIES.md exists' || echo '❌ MISSING'"
  ssh $VM "grep -c '✅' /home/user/workspace/CAPABILITIES.md"
  
  echo "✅ $VM updated"
done
```

### Compliance Score After Implementation

| Check | Before | After |
|---|---|---|
| Agent knows all capabilities | 6/10 | 9/10 |
| Never refuses what it can do | 5/10 | 9/10 |
| Never claims what it can't do | 7/10 | 9/10 |
| Capabilities stay current | 4/10 | 9/10 (auto-generated) |
| New skills auto-discovered | 3/10 | 9/10 |
| Session startup loads capabilities | 0/10 | 10/10 |
| Refusal requires evidence | 2/10 | 9/10 |

### Three Critical Implementation Notes

**1. Brave Search API = TOP PRIORITY UNBLOCK**

Blocks Skill 10 (Competitive Intel), Skill 12 (E-Commerce research), Skill 9 (trend monitoring), and general capability verification. Cost: $5/month. This should be part of default InstaClaw setup — not optional.

**2. Make CAPABILITIES.md Check MANDATORY, Not Guidance**

The "Before Refusing" checklist in SOUL.md must be strong enough that agents treat it as a hard requirement, not a suggestion. The system prompt language should make checking CAPABILITIES.md reflexive — the same way agents already reflexively read SOUL.md and USER.md.

**3. Auto-Regeneration Triggers**

CAPABILITIES.md must regenerate when:
- New skill installed
- MCP server added/removed
- API key added to .env
- Agent config changes (e-commerce platforms connected)
- Manual trigger: `openclaw capabilities refresh`
- Fleet push deploys new skills

Include timestamp and counts at the top so agents can say "my capabilities were last updated [timestamp], let me refresh" if the user reports something that should work but isn't.


## Capability Deployment Plan: What Every Agent Needs

These are the infrastructure-level capabilities that must be deployed alongside the skills. Skills teach agents HOW to do things — these capabilities give them the ABILITY to do things.

### Tier 1: CRITICAL — Deploy Immediately

#### 1A. Brave Search API (InstaClaw-Supplied)
**Status:** ❌ NOT CONFIGURED on any VM
**Impact:** 🔥 CRITICAL — Without this, agents are blind to the web. No proactive research, no social monitoring, no competitor intel, no current events, no answering questions that require real-time information.

#### 1D. AgentMail.to (InstaClaw-Supplied)
**Status:** ❌ NOT CONFIGURED — Agents have no email identity
**Impact:** 🔥 CRITICAL — Without email, agents can't sign up for services, receive verification codes, communicate with other agents, or operate autonomously in business contexts.
**Cost:** $200/mo Startup plan — covers 150 inboxes (150 agents). Custom domain `instaclaw.io` included.
**Implementation:**
- Sign up for AgentMail.to Startup plan
- Configure `instaclaw.io` as custom domain (SPF/DKIM/DMARC auto-handled)
- Add `AGENTMAIL_API_KEY` to InstaClaw Vercel environment
- Update `configureOpenClaw()` to auto-provision inbox per agent (code in Skill 8)
- Set up webhook endpoint on gateway for incoming email notifications
- Fleet push: Create inboxes for all existing agents retroactively
**Effort:** ⚡ Easy — SDK is 3 lines to create inbox, webhook setup is standard
**Cost:** InstaClaw pays for this. Users don't touch it.
**Implementation:**
- Get Brave Search API key (Pro tier: $5/month for 10,000 queries)
- Add `BRAVE_SEARCH_API_KEY` to InstaClaw Vercel environment
- Update `configureOpenClaw()` to write key to VM during setup: `echo "BRAVE_SEARCH_API_KEY=brv_xxxxx" >> ~/.openclaw/.env`
- Update fleet patch script to push key to all 9 existing VMs immediately
- Verify: SSH into VM, run test search, confirm results return
**Effort:** ⚡ Easy — just add the key and push it

#### 1B. X/Twitter Search (Via Brave Search)
**Status:** ❌ BLOCKED — Agents cannot search X at all
**Impact:** 🔥 HIGH — Social monitoring, brand mentions, competitor tracking, trend discovery all blocked
**Root Cause:** No web search API + browser automation blocked by X's bot protection
**Solution:** Brave Search API solves 80% of this. Agents can search `site:twitter.com [query]` or just search topics and X results will appear in web results.
**What remains blocked after Brave:** Direct X posting, X API access (needs separate API key + approval)
**Implementation:** Included in 1A — once Brave Search is live, X search works automatically

#### 1C. CAPTCHA Solving Service
**Status:** ❌ NOT AVAILABLE
**Impact:** 🔥 HIGH — Agents are blocked from ~50% of SaaS sites (Replit, many platforms with Cloudflare protection)
**Solution:** Integrate 2Captcha or Anti-Captcha service
**Implementation:**
- Sign up for 2Captcha API ($2.99/1000 CAPTCHAs)
- Add `CAPTCHA_API_KEY` to VM environment
- Build CAPTCHA detection + solving into browser automation skill
- When agent hits CAPTCHA: detect type → send to 2Captcha API → receive solution → inject and continue
- Add to browser skill SKILL.md so agents know the capability exists
**Effort:** 🔨 Medium — needs integration code + testing across CAPTCHA types

### Tier 2: HIGH IMPACT — Deploy This Month

#### 2A. Image Generation (OpenAI DALL-E)
**Status:** ❌ MISSING — Agents can write prompts but can't generate images
**Impact:** 📊 MEDIUM-HIGH — Users expect AI agents to create images, not just describe them
**Current Workaround:** Agent writes prompt, user runs it through DALL-E/Midjourney manually
**Solution:** Add OpenAI API key for DALL-E image generation
**Implementation Options:**
- **All-Inclusive plans:** InstaClaw supplies OpenAI API key, image generation included in plan. Budget per user per month.
- **BYOK plans:** User provides their own OpenAI key (they already have Anthropic key, adding OpenAI is natural)
- Add `OPENAI_API_KEY` to VM environment
- Build image generation skill that wraps DALL-E API calls
- Agent generates image → saves to workspace → sends to user via Telegram/Discord
**Effort:** ⚡ Easy — API key + wrapper function

#### 2B. Kling AI Direct Access
**Status:** ❌ MISSING — Agents can write cinematic prompts but can't run them
**Impact:** 📊 MEDIUM — The Kling AI prompting skill is powerful but the user has to copy-paste prompts into Kling manually
**Current Workaround:** Agent writes prompt → user runs in Kling AI → agent edits output with FFmpeg
**Solution:** Kling AI API key (if available) or browser automation with login credentials
**Implementation:**
- Check if Kling AI has a public API (it may — research needed)
- If API: Add key to VM environment, build wrapper
- If no API: Browser automation with user-provided credentials + session persistence
- If neither: Keep current workflow (agent generates prompt, user runs it)
**Effort:** 🔨 Medium — depends on Kling API availability

#### 2C. Session Persistence (Browser Cookies)
**Status:** ❌ MISSING — Browser sessions die when agent session ends
**Impact:** 📊 MEDIUM — Agent has to re-login to every platform every session
**Solution:** Save and restore browser cookies between sessions
**Implementation:**
- After successful login, save cookies to `~/.openclaw/sessions/{platform}.json`
- Before browser operations on known platforms, check for saved session
- Load cookies → verify still valid → proceed or re-login
- Add session management to browser skill documentation
**Effort:** 🔨 Medium — needs cookie serialization + restore logic

### Tier 3: NICE TO HAVE — Deploy When Ready

#### 3A. Midjourney Access (Discord Bot)
**Status:** ❌ MISSING
**Impact:** 📊 LOW-MEDIUM — DALL-E covers most image generation needs
**Solution:** Discord bot integration or Midjourney API (when available)
**Effort:** 🔨 Hard — Discord bot interaction is complex

#### 3B. Residential Proxy Network
**Status:** ❌ MISSING
**Impact:** 📊 LOW-MEDIUM — Reduces bot detection on browsing
**Solution:** Proxy service integration (Bright Data, Oxylabs, etc.)
**Effort:** 🔨 Medium — proxy configuration + IP rotation logic

#### 3C. Video Generation Direct (RunwayML, Higgsfield)
**Status:** ❌ MISSING
**Impact:** 📊 LOW — Kling AI is the primary video gen tool
**Solution:** API keys for additional video platforms as they become available
**Effort:** ⚡ Easy per platform (just add API key + wrapper)

### Deployment Priority Order

```
WEEK 1 (DO NOW):
├── 1A. Brave Search API key → push to all VMs
├── 1B. X/Twitter search → automatic once 1A is done
├── 1D. AgentMail.to → provision inboxes for all agents ($200/mo)
├── 2A. OpenAI API key for DALL-E → push to all VMs
├── Alpha Vantage API key ($49.99/mo premium) → push to all VMs (Skill 7)
└── ElevenLabs API key ($22/mo creator) → push to all VMs (Skill 11)

WEEK 2-3:
├── 1C. CAPTCHA solving service (2Captcha integration)
├── 2B. Kling AI direct access (research API availability)
├── 2C. Session persistence (browser cookie save/restore)
├── E-commerce MCP servers: Shopify + Amazon + eBay (install on VMs, Skill 12)
└── ShipStation MCP server: BUILD custom (1 week, Skill 12)

MONTH 2+:
├── 3A. Midjourney Discord integration
├── 3B. Residential proxy network
└── 3C. Additional video gen platforms
```

### Fleet Push Script for API Keys

All API keys should be pushed using the same fleet patch pattern established for gateway fixes:

```bash
# fleet-push-api-keys.ts
# For each assigned VM:
# 1. SSH into VM
# 2. Write keys to .env:
#    BRAVE_SEARCH_API_KEY=brv_xxxxx
#    OPENAI_API_KEY=sk-xxxxx
#    ALPHAVANTAGE_API_KEY=xxxxx
#    ELEVENLABS_API_KEY=sk_xxxxx
#    AGENTMAIL_API_KEY=xxxxx
#    CAPTCHA_API_KEY=xxx (when ready)
# 3. Provision AgentMail inbox for agent (if not exists)
# 4. Restart gateway to pick up new env vars
# 5. Verify: Run test search, confirm results
# 6. Log: Agent gets memory entry "New capabilities: web search, image generation, market data, TTS, email"

# MUST include:
# --dry-run flag
# --test-first flag (one VM, wait for confirmation)
# Rollback capability
```

### What This Unlocks (Before vs After)

| Capability | Before | After |
|-----------|--------|-------|
| Web Research | ❌ Blind — can only fetch URLs user provides | ✅ Full web search, discovery, monitoring |
| Social Monitoring | ❌ Cannot search X/Twitter at all | ✅ Search X via Brave, find mentions/trends |
| Competitor Intel | ❌ Must be given specific URLs | ✅ Daily digests, weekly deep-dives, real-time alerts (Skill 10) |
| Image Generation | ❌ Writes prompts, user runs manually | ✅ Generates images directly via DALL-E |
| Voice & Audio | ❌ All videos are silent, no audio capability | ✅ ElevenLabs/OpenAI TTS voiceovers, podcast intros, voice messages (Skill 11) |
| Market Data | ❌ No financial data access | ✅ Alpha Vantage real-time stocks/crypto/options/indicators (Skill 7) |
| Email Identity | ❌ No email — can't sign up for services or communicate | ✅ Own @instaclaw.io address, send/receive/OTP, Gmail monitoring (Skill 8) |
| Social Posting | ❌ Can't post to any platform | ✅ Reddit now, Twitter/LinkedIn with API keys (Skill 9) |
| E-Commerce Ops | ❌ No marketplace integration | ✅ Shopify/Amazon/eBay orders, returns, inventory sync, P&L reports (Skill 12) |
| Blocked Sites | ❌ CAPTCHA = dead end | ✅ 2Captcha solves most blocks |
| Platform Access | ❌ Re-login every session | ✅ Session persistence, stay logged in |
| Video Generation | ❌ Writes prompts, user runs manually | ⚠️ Depends on Kling API availability |

**The single biggest transformation:** Agents go from REACTIVE (user gives URLs and instructions) to PROACTIVE (agents discover information, monitor the web, and bring insights to the user). This is what justifies the monthly subscription.

---

## Configuration Management

Current approach is scattered environment variables. Move to structured config written to each VM during configure:

```yaml
# ~/.openclaw/services.yaml (written during configureOpenClaw)
services:
  brave_search:
    enabled: true
    api_key: ${BRAVE_API_KEY}       # InstaClaw-supplied, all users
    rate_limit: 15000                # queries per month
    cache_ttl: 3600                  # cache results for 1 hour

  captcha_solving:
    enabled: true
    provider: "2captcha"
    api_key: ${CAPTCHA_API_KEY}      # InstaClaw-supplied, all users
    max_retries: 3
    timeout: 60                      # seconds per solve attempt

  image_generation:
    enabled: true
    provider: "openai"
    api_key: ${OPENAI_API_KEY}       # InstaClaw-supplied for All-Inclusive, user-supplied for BYOK
    model: "dall-e-3"
    default_size: "1792x1024"
    default_quality: "hd"
    fallback: "replicate"

  session_persistence:
    enabled: true
    storage_path: "~/.openclaw/sessions/"
    auto_refresh: true
    max_age: 86400                   # 24 hours before re-login

  alpha_vantage:
    enabled: true
    api_key: ${ALPHAVANTAGE_API_KEY} # InstaClaw-supplied, all users
    tier: "premium"                   # $49.99/mo — 75 req/min
    rate_limit: 75                    # requests per minute
    cache_ttl: 300                    # 5 min cache for price data
    mcp_server: true                  # Enable MCP server integration

  elevenlabs:
    enabled: true
    api_key: ${ELEVENLABS_API_KEY}   # InstaClaw-supplied for Pro/Power
    plan: "creator"                   # $22/mo — 100k chars
    tier_limits:
      free_starter: 450000            # chars/month (~30 min audio)
      pro: 1800000                    # chars/month (~2 hours)
      power: 7200000                  # chars/month (~8 hours)
    fallback: "openai_tts"            # Fallback for free tier / over-limit

  openai_tts:
    enabled: true
    api_key: ${OPENAI_API_KEY}       # Same key as DALL-E / LLM
    model: "tts-1-hd"
    default_voice: "alloy"
    cost_per_1k_chars: 0.015         # ~$0.90/hour of audio

  agentmail:
    enabled: true
    api_key: ${AGENTMAIL_API_KEY}    # InstaClaw master key
    domain: "instaclaw.io"            # Custom domain
    plan: "startup"                   # $200/mo — 150 inboxes
    webhook_url: "https://gateway.instaclaw.io/webhooks/email/"
    auto_provision: true              # Create inbox during configureOpenClaw()
    rate_limits:
      cold_outreach: 20              # per day
      known_contacts: 100            # per day
      automated_sends: 200           # per day
```

Agent loads this at boot. Skills check `config.services.[name].enabled` before attempting to use a capability. If disabled, skill tells user: "This capability isn't configured yet — let me know if you want to set it up."

---

## CAPTCHA Solving Implementation Detail

### Detection (runs automatically when browser hits a wall)
```javascript
const detectCaptcha = async () => {
  return await browser.act({
    request: {
      kind: "evaluate",
      fn: `() => {
        const indicators = {
          recaptcha: !!document.querySelector('#g-recaptcha, .g-recaptcha, [data-sitekey]'),
          hcaptcha: !!document.querySelector('.h-captcha, [data-hcaptcha-sitekey]'),
          cloudflare: !!document.querySelector('.cf-challenge, #challenge-form, .cf-turnstile'),
          generic: !!document.querySelector('[class*="captcha" i], [id*="captcha" i]')
        };
        const sitekey = document.querySelector('[data-sitekey]')?.getAttribute('data-sitekey') ||
                        document.querySelector('[data-hcaptcha-sitekey]')?.getAttribute('data-hcaptcha-sitekey');
        return { detected: Object.values(indicators).some(Boolean), type: indicators, sitekey };
      }`
    }
  });
};
```

### Solving (2Captcha integration)
```javascript
const solveCaptcha = async (pageUrl, sitekey, type) => {
  // 1. Submit to 2Captcha
  const taskResponse = await fetch('https://2captcha.com/in.php', {
    method: 'POST',
    body: new URLSearchParams({
      key: CAPTCHA_API_KEY,
      method: type === 'recaptcha' ? 'userrecaptcha' : 'hcaptcha',
      googlekey: sitekey,
      pageurl: pageUrl,
      json: '1'
    })
  });
  const { request: taskId } = await taskResponse.json();

  // 2. Poll for result (15-30 seconds typical)
  for (let i = 0; i < 30; i++) {
    await sleep(5000);
    const result = await fetch(`https://2captcha.com/res.php?key=${CAPTCHA_API_KEY}&action=get&id=${taskId}&json=1`);
    const data = await result.json();
    if (data.status === 1) return data.request; // Solution token
  }
  throw new Error('CAPTCHA solve timeout');
};

// 3. Inject solution and continue
const injectSolution = async (token, type) => {
  await browser.act({
    request: {
      kind: "evaluate",
      fn: `() => {
        const responseField = document.querySelector('#g-recaptcha-response, [name="g-recaptcha-response"], [name="h-captcha-response"]');
        if (responseField) {
          responseField.value = '${token}';
          responseField.dispatchEvent(new Event('input', { bubbles: true }));
        }
        // Try to find and click submit
        const submit = document.querySelector('[type="submit"], .challenge-form button');
        if (submit) submit.click();
      }`
    }
  });
};
```

### Retry Logic
```javascript
const withCaptchaRetry = async (action, maxRetries = 3) => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await action();
    } catch (error) {
      const captcha = await detectCaptcha();
      if (captcha.detected && i < maxRetries - 1) {
        const solution = await solveCaptcha(currentUrl, captcha.sitekey, captcha.type);
        await injectSolution(solution, captcha.type);
        continue;
      }
      throw error;
    }
  }
};
```

### Cost per CAPTCHA type
| Type | Cost per Solve | Typical Solve Time |
|------|---------------|-------------------|
| reCAPTCHA v2 | $0.001 | 15-30 seconds |
| reCAPTCHA v3 | $0.002 | 10-20 seconds |
| hCaptcha | $0.001 | 15-30 seconds |
| Cloudflare Turnstile | $0.001 | 10-20 seconds |

Estimated monthly spend: $0.50-$5.00 per agent (500-5000 solves)

---

## Proactive Monitoring Loops (Requires Brave Search)

Once Brave Search is live, these monitoring workflows become possible during heartbeat cycles:

### Social Media Monitoring
```javascript
// During heartbeat, if no active conversation:
async function monitorSocial() {
  const mentions = await web_search({
    query: `"${user.brand}" OR "@${user.handle}"`,
    freshness: "pd",  // past day
    count: 10
  });

  if (mentions.results.length > 0) {
    const digest = summarizeMentions(mentions.results);
    await queueDigest('social', digest);
  }
}
```

### Competitor Price Tracking
```javascript
async function trackCompetitors() {
  const competitors = user.watchlist || [];
  for (const competitor of competitors) {
    const pricing = await web_search({
      query: `${competitor} pricing plans`,
      freshness: "pm"  // past month
    });
    // Compare with last known pricing
    const changes = detectChanges(pricing, lastKnown[competitor]);
    if (changes.length > 0) {
      await queueAlert('competitor', `${competitor} changed pricing: ${changes}`);
    }
  }
}
```

### News & Trend Alerts
```javascript
async function dailyResearch() {
  const topics = user.interests || ['AI agents', 'automation'];
  const results = [];

  for (const topic of topics) {
    const news = await web_search({
      query: `${topic} news`,
      freshness: "pd",
      count: 5
    });
    results.push(...news.results);
  }

  const digest = generateDailyDigest(results);
  await sendToUser(digest);
}

// Schedule via heartbeat cron:
// cron: "0 9 * * *"  // 9 AM user's timezone
```

These loops are documented in HEARTBEAT.md and configured per-user based on their interests and watchlists in USER.md.

---

## Cost Tracking & Budget Management

Every API call that costs money gets tracked. Prevents runaway costs and gives users visibility.

```typescript
interface CostTracker {
  track(service: string, cost: number, metadata?: object): void;
  getSpend(service: string, period: 'day' | 'week' | 'month'): number;
  checkBudget(service: string): { remaining: number, exceeded: boolean };
}

// Agent tracks every paid API call:
await costTracker.track('brave_search', 0.0003);     // $0.0003 per query
await costTracker.track('openai_dalle', 0.08);        // $0.08 per HD image
await costTracker.track('2captcha', 0.001);            // $0.001 per solve
```

**Monthly Cost Estimates (InstaClaw-Supplied, Per Agent):**

| Service | Cost/Unit | Est. Monthly Usage | Est. Monthly Cost |
|---------|-----------|-------------------|------------------|
| Brave Search | $0.0003/query | 5,000 queries | $1.50 |
| 2Captcha | $0.001/solve | 500 solves | $0.50 |
| OpenAI DALL-E (HD) | $0.08/image | 100 images | $8.00 |
| **Total per agent** | | | **~$10/month** |

For All-Inclusive plans ($99 and $299), this cost is absorbed into the plan price. For BYOK plans, users supply their own API keys — InstaClaw cost is $0.

**Budget Controls:**
- At 80% of monthly budget: Agent warns user in next heartbeat digest
- At 100%: Agent switches to free alternatives or notifies user
- Hard cap prevents overspend — agent cannot exceed budget without explicit user override
- Monthly budget resets on the user's billing cycle date

---

## Success Metrics

### Capability Metrics (Before vs After Fleet Upgrade)

| Metric | Before | After (Target) |
|--------|--------|----------------|
| Web searches per day per agent | 0 ❌ | 50-100 ✅ |
| Platforms accessible | 3 (GitHub, Telegram, Discord) | 10+ |
| CAPTCHA solve rate | 0% ❌ | 95%+ ✅ |
| Images generated per day | 0 ❌ | 5-10 ✅ |
| Video generation | Prompts only (user runs manually) | End-to-end (when Kling API available) |

### Autonomy Metrics

| Metric | Before | After (Target) |
|--------|--------|----------------|
| Proactive heartbeat tasks | 2 (email check, bounty scan) | 10+ (search, monitor, research, analyze, alert) |
| Tasks requiring user input | 95% | 30% |
| Tasks completed independently | 5% | 70% |

### User Value Metrics

| Metric | Before | After |
|--------|--------|-------|
| Manual web search by user | ~30 min/day | 0 min (agent handles) |
| Platform login friction | ~10 min/day | 0 min (sessions persist) |
| Task failure from CAPTCHA blocks | ~20% | <1% |
| Social monitoring | Impossible | Daily automated digest |
| Competitor intelligence | Impossible | Weekly automated report |
| Image generation | User runs DALL-E manually | Agent generates and delivers directly |

### Risk Assessment

**Technical Risks:**

| Risk | Impact | Likelihood | Mitigation |
|------|--------|-----------|------------|
| API rate limits exceeded | High | Medium | Caching, per-agent quotas, budget alerts |
| CAPTCHA solve failure | Medium | Low | Fallback to user notification, retry logic |
| Cost overruns | High | Medium | Hard budget limits, alerts at 80%, auto-disable at 100% |
| Session expiry mid-task | Low | High | Auto-refresh, graceful re-login, notify user |
| Platform blocks agent IP | Medium | Medium | Respectful rate limiting, delays between requests |

**Security Risks:**

| Risk | Impact | Likelihood | Mitigation |
|------|--------|-----------|------------|
| API key leakage | High | Low | Keys in .env only, never in logs, memory files, or user-visible output |
| Credential exposure | High | Low | Encrypted session storage, never plaintext passwords in workspace |
| Unauthorized API spend | Medium | Medium | Hard budget caps, per-service limits, monthly review |

### Phase 1: Prepare (Before Push)
1. Package all completed skills into `.skill` bundles
2. Test each skill on one VM (deploy, trigger, verify output)
3. Verify no skill conflicts (duplicate trigger keywords, file path collisions)
4. Build fleet deployment script with:
   - `--dry-run` flag (shows what would be pushed, doesn't push)
   - `--test-first` flag (pushes to one VM, waits for confirmation, then continues)
   - Rollback capability (keep previous skill version, revert if new one breaks)

### Phase 2: Push to Existing Fleet
1. Run `fleet-push-skills.ts --dry-run` — verify target VMs and skills
2. Run `fleet-push-skills.ts --test-first` — push to one VM, test manually
3. Run `fleet-push-skills.ts` — push to all assigned VMs
4. Verify: SSH into 3 random VMs, confirm skills are in `~/.openclaw/skills/`
5. Log: Each agent gets a memory entry noting new skills were installed

### Phase 3: Bake into New Agent Setup
1. Update VM snapshot to include all standard skills pre-installed
2. Update `configureOpenClaw()` to verify skills are present after setup
3. Update BOOTSTRAP.md to mention available skills in first message (if relevant to user's Gmail data)

### Phase 4: Ongoing Maintenance
1. Skill updates use the same fleet push mechanism
2. Version numbers prevent redundant pushes
3. New skills are added to the standard set and pushed fleet-wide
4. Agents can request skill updates during heartbeat cycle (check for new versions)

---

## Skill Quality Standards

### Every Skill Must Pass These Tests Before Fleet Deployment

1. **Zero-to-output test:** A fresh agent with no prior context can read SKILL.md and produce acceptable output on the first try. If it can't, the skill documentation is insufficient.

2. **Template test:** The included template produces real, working output when run as-is (not pseudocode, not "fill in the blanks"). The agent customizes from a working starting point, not a blank canvas.

3. **Mistake prevention test:** The common mistakes section covers the top 5 errors agents actually make when using this skill. Each mistake includes: what went wrong, what it looked like, and the exact fix.

4. **Quality calibration test:** The skill includes concrete examples of "acceptable" vs "not acceptable" output. The agent can self-evaluate against these before delivering to the user.

5. **Trigger accuracy test:** The skill activates on relevant requests and does NOT activate on irrelevant ones. False positives (skill activates when it shouldn't) are worse than false negatives (skill doesn't activate when it should).

---

## Appendix: Skill Development Process

### How to Build a New Skill

1. **Do the task manually first** — Have an agent actually do the task multiple times. Document what works, what fails, what's confusing.

2. **Extract the workflow** — Turn the successful approach into a step-by-step workflow in SKILL.md. Include the judgment calls ("when to use X vs Y").

3. **Build the template** — Create a working starter that produces real output. The agent should be able to copy this template and customize it, not build from scratch.

4. **Document the mistakes** — Every mistake made during manual testing goes into the common mistakes section. These are MORE valuable than the happy-path documentation.

5. **Add quality examples** — Include real examples of acceptable and exceptional output. The agent needs visual/concrete benchmarks, not abstract descriptions.

6. **Test with a fresh agent** — Give the skill to an agent that has never done the task. Can it produce acceptable output on the first try? If not, iterate on the documentation.

7. **Package and version** — Bundle as `.skill`, assign version number, write trigger metadata.

8. **Deploy and monitor** — Push fleet-wide, monitor agent performance, collect feedback, iterate.

### Skill Naming Convention
```
skill-name/                    # lowercase, hyphenated
├── SKILL.md                   # Always uppercase
├── references/                # Always lowercase
├── assets/                    # Always lowercase
│   └── template-[variant]/    # template- prefix
└── examples/                  # Always lowercase
    ├── good/
    └── exceptional/
```

### Versioning
```yaml
# In SKILL.md metadata header
name: remotion-video-production
version: 1.0.0
updated: 2026-02-21
author: InstaClaw
```
Major version: Breaking changes to workflow or template structure
Minor version: New patterns, additional templates, expanded references
Patch version: Bug fixes, typo corrections, clarifications
