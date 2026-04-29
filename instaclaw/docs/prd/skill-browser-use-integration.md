# PRD: browser-use Skill — Sophisticated Browser Automation for Agent VMs

**Author:** Cooper Wrenn + Claude (Opus 4.7)
**Date:** 2026-04-28
**Status:** Draft — Awaiting Cooper review
**Priority:** P1
**Target manifest:** v65 (current: v64, snapshot `private/38496803`)
**Companion skill:** `web-search-browser` (existing tier ladder is edited, not replaced)

---

## 1. Executive Summary

InstaClaw agents have two browsing surfaces today:

1. **Layer 1 — Agent's own VM browser.** Headless Chromium driven by OpenClaw's built-in `browser` MCP tool (CDP on profile `openclaw`, port 18800), with Crawlee as a stealth fallback. Documented in `instaclaw/skills/web-search-browser/SKILL.md` as Tiers 1–3.5.
2. **Layer 2 — User's real Chrome.** A single Chrome extension at `instaclaw-chrome-extension/` (manifest name "InstaClaw Browser Relay" — "OpenClaw" mentions in SKILL.md are legacy artifacts) bridges WebSocket → CDP into the user's actual browser. Triggered with `browser --profile chrome-relay`. Documented as Tier 4.

Layer 1 is the bottleneck. The built-in `browser` tool drives Chromium primarily through screenshot reasoning + DOM evaluation. It works for static pages; it degrades on SPAs, multi-step forms, anti-bot fingerprinting, and any flow with branching state. The current escalation path (Crawlee at Tier 3.5) helps with anti-bot blocks but is HTTP-first — not a structured browsing agent.

**This PRD adds a `browser-use` skill** that wraps [browser-use](https://browser-use.com) (78K+ stars, MIT) as a new tier inside Layer 1. browser-use replaces screenshot-driven control with **accessibility-tree element targeting**: structured DOM with stable element IDs, named-field input, named-button click, multi-step task chaining with retry. It runs on the **Playwright Chromium that's already installed on every VM** (no new binary), uses **the OpenClaw gateway as its LLM endpoint** (so credit accounting flows through the existing meter), and ships as a **CLI wrapper** rather than a new MCP server in v1 (avoids the unverified `mcpServers` schema path per CLAUDE.md Rule 2).

This is **not** a replacement for the Chrome relay. The relay still owns "log into the user's accounts and act as them." browser-use owns "do everything else, autonomously, on the agent's own VM."

### What we're adding (and what we're explicitly NOT touching)

| Component | Action | Path |
|---|---|---|
| `browser-use` Python package | **Add** to `pythonPackages` + parallel pip block | `lib/vm-manifest.ts:700`, `lib/ssh.ts:5283-5306` |
| `instaclaw/skills/browser-use/` skill dir | **Create** — auto-deployed via `skillsFromRepo: true` | `lib/vm-manifest.ts:642` |
| `~/scripts/browser-use-task.py` wrapper | **Add** to `VM_MANIFEST.files` | new entry in files array |
| Tier insertion in `web-search-browser/SKILL.md` | **Edit existing** — insert as Tier 3.25 between built-in browser (Tier 3) and Crawlee (Tier 3.5) | `instaclaw/skills/web-search-browser/SKILL.md` |
| EARN.md entry | **Edit existing** | `lib/earn-md-template.ts` |
| Earn page channel | **Add** to `CHANNELS` array | `app/(dashboard)/earn/page.tsx` |
| Bump `VM_MANIFEST.version` | **Edit** 64 → 65 | `lib/vm-manifest.ts:383` |
| `cloud-init.ts` Playwright install | **Do not touch** — already runs `npx playwright install chromium` at lines 268-288 | unchanged |
| `cloud-init.ts` system deps (libnss3, libgbm1, etc.) | **Do not touch** — already installed at lines 231-234 | unchanged |
| OpenClaw built-in `browser` tool | **Do not touch** — Tier 3 stays as-is, demoted to "screenshot debug fallback" | unchanged |
| `mcpServers` block in `buildOpenClawConfig()` | **Do not add in v1.** Schema is unverified (no existing block in `lib/ssh.ts:2836`). v2 may add this once the CLI wrapper proves stable | unchanged |
| `dispatch-server.js` (computer-dispatch skill) | **Do not touch** — orthogonal (desktop control, not browser control) | unchanged |
| Crawlee (`~/scripts/crawlee-scrape.py`) | **Do not touch** — stays as Tier 3.5 anti-bot fallback | unchanged |
| Reconciler steps | **Do not touch** — `stepSkills` (#13), `stepFiles` (#5), `stepPythonPackages` (#16) auto-pick up the new skill via existing logic | `lib/vm-reconcile.ts` |

---

## 2. Problem Statement

### 2.1 What's broken today

The `web-search-browser` skill ladder (verified at `instaclaw/skills/web-search-browser/SKILL.md`):

```
Tier 1 — web_search        (Brave Search MCP, fast factual)
Tier 2 — web_fetch         (single URL fetch, markdown extraction)
Tier 3 — browser           (OpenClaw built-in, CDP on port 18800, profile "openclaw")
Tier 3.5 — crawlee-scrape  (~/scripts/crawlee-scrape.py, TLS+browser fingerprint stealth)
Tier 4 — browser --profile chrome-relay  (Layer 2: user's real Chrome via extension)
```

Tier 3 (built-in `browser`) drives Chromium via CDP. The agent uses it through a small set of primitives (navigate, screenshot, evaluate, click-by-coordinate). It doesn't expose structured accessibility-tree targeting, doesn't have a built-in multi-step planner, and doesn't include modern stealth flags. Failure modes seen in practice:

| Failure mode | Why Tier 3 fails | Why Tier 3.5 (Crawlee) fails |
|---|---|---|
| SPA forms with dynamic class names | Coordinate clicks miss after layout reflow | Crawlee browser mode similar; HTTP mode can't fill forms |
| Multi-step flows (login → nav → action → confirm) | Agent re-screenshots + re-reasons each step; error compounds | Crawlee is one-shot scrape, not a multi-step agent |
| JS-rendered content with delayed hydration | Agent screenshots before page is interactive | Same in browser mode |
| Pagination + extraction at scale | One LLM call per page; slow + expensive | Doesn't synthesize; pure scrape |
| File upload / download dialogs | OS dialogs invisible to coordinate control | Same |
| Sites with sophisticated anti-bot (DataDome, PerimeterX) | Stock Playwright fingerprint detected | Tier 3.5 *does* help here — keep it |
| CAPTCHA-gated sites | No solver | No solver |

The pattern: **Tier 3 is "look at the screen, click somewhere"; Tier 3.5 is "scrape this page through the wall." Neither is "do a multi-step task in a browser like a person would."** That's the gap browser-use fills.

### 2.2 Why now

- **DegenClaw + Newsworthy + Bankr partnerships** push agents into more web-driven workflows. Each partner has at least one UI-only flow (per project memory: `project_newsworthy_partnership.md`, `skill-degenclaw-trading-competition.md`, `project_bankr_partnership.md`).
- **Earn page** is expanding the catalog; browser-driven recurring tasks (price monitoring, booking, lead-gen) are an untapped earning surface.
- The Dispatch Mode PRD is **Phase 3 complete** on 199/200 VMs (per `docs/prd/dispatch-mode-remote-computer-control.md`), which solves the user-side desktop story. browser-use is the parallel upgrade for the VM-side browser.
- Adding browser-use is **a single tier insertion** plus a Python package, not an architectural rewrite. The existing infrastructure absorbs it cleanly.

---

## 3. Proposed Solution

### 3.1 Updated tier ladder (single insertion)

```
Tier 1 — web_search
Tier 2 — web_fetch
Tier 3 — browser            (built-in OpenClaw CDP — kept, demoted to "screenshot/debug fallback")
Tier 3.25 — browser-use     ← NEW. Default for any task that *does* something on a page.
Tier 3.5 — crawlee-scrape   (unchanged anti-bot stealth fallback)
Tier 4 — browser --profile chrome-relay   (Layer 2: user's real Chrome)
```

**Tier 3 stays.** The built-in tool is fine for "open a page, take a screenshot, evaluate this JS." Demoting it to fallback is a SKILL.md edit, not a code change.

### 3.2 Invocation: CLI wrapper (v1), MCP server (v2 maybe)

**v1: CLI wrapper.** `~/scripts/browser-use-task.py` is a thin shim that the agent calls via Bash:

```bash
python3 ~/scripts/browser-use-task.py \
  --task "Find the cheapest 1-bed apartment in Brooklyn under $2500 on Zillow, return JSON" \
  --start-url "https://zillow.com" \
  --max-steps 25 \
  --budget-usd 0.50 \
  --headless \
  --output-format json
```

The wrapper:
- Imports `browser_use.Agent` (their Python API).
- Configures the LLM client to point at the OpenClaw gateway (`http://127.0.0.1:${GATEWAY_PORT}/v1`) using `GATEWAY_TOKEN` from `~/.openclaw/.env`. This routes browser-use's reasoning through the same metered path as the user's main agent — no separate billing or out-of-band API key.
- Reuses the existing Playwright Chromium at `~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome` (already installed by `cloud-init.ts:268-288`).
- Uses a **separate user-data-dir** (`~/.cache/browser-use-profile/`) so it doesn't collide with the OpenClaw built-in tool's profile (`openclaw`, port 18800).
- Returns JSON with `result`, `steps`, `screenshots[]` (paths), `cost_usd`, `wall_time_ms`.
- Enforces hard caps: `--max-steps`, `--budget-usd`, `--timeout-sec`, peak-RSS via `prlimit`.
- Honors a domain blocklist at `~/.openclaw/browser-use-blocklist.txt`.

**Why CLI not MCP for v1:** `instaclaw/lib/ssh.ts:2836` (`buildOpenClawConfig()`) has top-level keys `wizard, browser, agents, session, messages, commands, channels, gateway, models, skills, plugins, tools` — **no `mcpServers` block exists today.** Adding one is a schema change that violates CLAUDE.md Rule 2 ("Verify Config Schema Before Changing Values") unless first verified on a canary VM. A CLI wrapper has zero schema risk and ships in days; the MCP path is a v2 follow-up once we've verified the schema accepts a `mcpServers` block on OpenClaw 2026.4.26.

**v2 (out of scope here, follow-up PRD):** browser-use ships an MCP server (`python -m browser_use.mcp`). Once the OpenClaw config schema is verified to accept `mcpServers`, register it for first-class tool calls.

### 3.3 Skill scaffolding

Created files (all auto-deployed via `skillsFromRepo: true` at `lib/vm-manifest.ts:642`):

```
instaclaw/skills/browser-use/
├── SKILL.md                              # Agent-facing instructions, tier positioning, examples
├── assets/
│   └── browser-use-task.py               # CLI wrapper deployed to ~/scripts/ via VM_MANIFEST.files
└── references/
    ├── decision-tree.md                  # When to use browser-use vs Tier 3 vs relay
    ├── budget-and-credits.md             # Cost model, step limits, blocklist policy
    └── examples/
        ├── price-monitoring.md
        ├── form-filling.md
        ├── data-extraction.md
        └── multi-step-research.md
```

**Reference files** must be added to `VM_MANIFEST.extraSkillFiles` (`lib/vm-manifest.ts:645`) — the reconciler doesn't auto-deploy `references/` and `assets/` directories without an explicit entry. Pattern verified against existing `dgclaw` and `motion-graphics` entries at lines 656-658.

**SKILL.md frontmatter** follows the existing pattern (verified against `web-search-browser/SKILL.md` and `computer-dispatch/SKILL.md`):

```yaml
---
name: browser-use
description: >-
  Sophisticated browser automation for the agent's own VM. Use for autonomous
  multi-step web tasks that don't require the user's logged-in session — research,
  monitoring, data extraction, form filling, comparison shopping, booking on public sites.
metadata:
  triggers:
    keywords: [browse, navigate, fill out, extract, monitor, watch, scrape, compare, book, search and find]
    phrases: ["fill out this form", "monitor this page", "find me the best", "extract data from", "compare prices on", "book a", "go through this website"]
    NOT: [my email, my account, log into, my Instagram, my Twitter, post for me, pay for]
---
```

The `NOT` triggers route the agent to the Chrome relay (Layer 2) instead — see §6.

### 3.4 Edits to existing skill (`web-search-browser/SKILL.md`)

Insert browser-use as Tier 3.25 between Tier 3 and Tier 3.5. Existing Tier 4 (relay) text is unchanged. The decision matrix near the bottom of that SKILL.md gets a new row.

---

## 4. Architecture

### 4.1 Where browser-use fits on the VM (verified against current state)

```
┌──────────────────────────────────────────────────────────────────────┐
│ VM (g6-dedicated-2, snapshot private/38496803, 4GB RAM, 80GB disk)   │
│                                                                       │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ openclaw-gateway.service (systemd --user)                      │  │
│  │  systemdOverrides: MemoryMax=3500M, MemoryHigh=3G, TasksMax=75 │  │
│  │  ├── Built-in browser tool (Tier 3) — Chromium CDP :18800      │  │
│  │  │   profile "openclaw"                                         │  │
│  │  ├── Brave Search plugin (plugins.entries.brave)                │  │
│  │  └── auth-profiles.json → loopback Anthropic proxy              │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ Playwright Chromium (SHARED — already installed cloud-init)    │  │
│  │  ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome       │  │
│  │  symlink: /usr/local/bin/chromium-browser → ↑                  │  │
│  │                                                                 │  │
│  │  Used by:                                                       │  │
│  │   ├── crawlee-scrape.py (Tier 3.5) — own profile per-call      │  │
│  │   ├── browser-use-task.py (Tier 3.25 NEW) — separate profile   │  │
│  │   │   user-data-dir: ~/.cache/browser-use-profile/             │  │
│  │   └── (NOT shared with OpenClaw built-in tool — that's :18800) │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ Xvfb :99 (1280x720x24)                                         │  │
│  │  └── Used by computer-dispatch skill for VM desktop control     │  │
│  │      browser-use runs HEADLESS by default — does not attach    │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ ~/scripts/browser-use-task.py  (CLI wrapper, NEW)              │  │
│  │ ~/.openclaw/skills/browser-use/SKILL.md  (auto-deployed)       │  │
│  │ ~/.openclaw/skills/browser-use/references/...                  │  │
│  │ ~/.openclaw/browser-use-blocklist.txt  (created on first run)  │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

### 4.2 What this corrects from a naive design

I want to flag the things that would be wrong if you didn't know the codebase:

- **"Install Playwright Chromium" — wrong.** It's already there. `cloud-init.ts:271-276` runs `npx playwright install chromium` on first boot; `crawlee[playwright]==1.5.0` reinforces it via Crawlee's pip install at `ssh.ts:5284`; `cloud-init.ts:280-285` symlinks it to `/usr/local/bin/chromium-browser`. **Adding a second Playwright install would be a no-op and could race-collide on the same `~/.cache/ms-playwright/` directory.**
- **"Add browser-use to the snapshot" — premature.** Disk math: the package alone is small (~20-50MB). The big part — Playwright Chromium — is already in the snapshot. So baking browser-use into v65 is fine and should slot in well under the 6144MB cap. We'll do it once it's fleet-stable.
- **"Register an MCP server" — schema-risky.** `mcpServers` is not in the current OpenClaw config (`lib/ssh.ts:2836` schema). Per CLAUDE.md Rule 2, untested schema keys can crash the gateway on startup (the `auth.mode: "none"` precedent). v1 ships as a CLI wrapper.
- **"Two Chromium binaries on the VM" — false.** There's one Chromium binary, used by three callers (OpenClaw built-in, Crawlee, browser-use). The collision risk is between **profiles / user-data-dirs**, not binaries. Each caller uses a separate profile.

### 4.3 Resource math (corrected)

| Component | RAM (idle) | RAM (peak) | Disk |
|---|---|---|---|
| openclaw-gateway (incl. built-in Chromium) | ~600MB | ~1.5GB (limit MemoryMax=3500M) | included in snapshot |
| browser-use Python package + deps | ~50MB | ~150MB | ~30-80MB |
| Playwright Chromium child (per browser-use task) | 0 | ~600-800MB peak | already present |
| Xvfb + dispatch + node_exporter + crons | ~200MB | ~400MB | included |
| **Total budget** | ~850MB | ~2.5-3GB | <100MB delta |

**Constraint:** systemd `MemoryMax=3500M` (`vm-manifest.ts:733`) is a hard cgroup OOM. browser-use fits, but only one task at a time. The wrapper enforces a **single-session lock** via `flock` on `~/.cache/browser-use/session.lock`.

**Disk delta is small enough to install on existing snapshot v64 fleet** without a new bake. New snapshot v65 is desirable (eliminates first-boot pip install latency) but not required for v1 launch.

### 4.4 LLM routing (preserves credit accounting)

`browser-use` accepts a `BaseLLM`-compatible client. We point it at the OpenClaw gateway:

```python
from browser_use import Agent
from browser_use.llm import ChatAnthropic

llm = ChatAnthropic(
    model="claude-sonnet-4-6",
    base_url=os.environ["GATEWAY_URL"],          # http://127.0.0.1:<port>/v1
    api_key=os.environ["GATEWAY_TOKEN"],         # from ~/.openclaw/.env
)
agent = Agent(task=task, llm=llm, max_steps=max_steps, headless=True)
result = await agent.run()
```

**Why this matters:** every reasoning step browser-use takes is metered exactly like every other agent reasoning step on the VM. The user's credit balance debits via the existing pipeline. There is no second billing path, no leaked Anthropic key, no out-of-band reasoning.

### 4.5 Integration with `vm-watchdog.py` (verified)

`vm-watchdog.py` (`lib/ssh.ts:1339-1700+`) already kills Chrome at 85% RAM (`RAM_KILL_CHROME_PCT=85`) and restarts the gateway at 95%. **browser-use's spawned Chromium is just another Chromium process** — the existing watchdog will kill it under pressure, no special wiring needed. We add one defensive line: the wrapper kills its own Playwright child on SIGTERM/SIGKILL so it doesn't leak after the watchdog acts.

---

## 5. Use Cases

| Use case | Today (Tier 3 / 3.5) | With browser-use (Tier 3.25) |
|---|---|---|
| Web research with synthesis | Brave + 2-3 web_fetch; misses JS | Multi-page navigate-and-extract, follows links, fills search filters |
| Price monitoring (Amazon, eBay, Zillow) | Coordinate clicks break weekly | Stable element targeting; pairs naturally with `recurring-executor.ts` |
| Form automation (lead gen, applications) | Read screenshot, find field, click, type, repeat | Accessibility tree → directly type into named field |
| Data extraction (multi-page tables) | Brittle, expensive | One semantic prompt; pagination handled by browser-use |
| Competitor analysis (pricing pages) | Manual page-by-page screenshots | Single task across N URLs |
| Content scraping (news, blogs, docs) | Crawlee for blocked sites; Tier 3 for the rest | browser-use handles JS; falls back to Crawlee on hard blocks |
| Booking / reservations (OpenTable, restaurants) | Coordinate-driven, flaky | Stable form-filling; multi-step calendar flows |
| Job board monitoring (Indeed, RemoteOK) | LinkedIn anti-bot blocks Tier 3 | Better fingerprint; still escalates to Crawlee on hard blocks |
| Polymarket UI for markets without API coverage | Manual screenshot + click | Direct interaction with the React app |
| Newsworthy curation (per partnership memory) | Brian's app may not have full API | Browser-driven voting/curation as fallback |
| Hourly price-check / report cron | OOM-prone with multiple Chromium | Short-lived sessions, clean teardown |

**Explicitly NOT building:**

- **CAPTCHA solving.** Tasks that hit a CAPTCHA escalate to the Chrome relay (let the human solve it).
- **Account creation at scale.** Flagged in §9 as abuse risk; rate-limited and domain-blocked.
- **Authenticated browsing on the agent's VM.** That's the relay's job. The VM does not store user credentials for third-party sites.

---

## 6. Two-Browser Decision Logic

The agent has two browsing surfaces. The decision must be cheap, deterministic, and documented in SKILL.md so the agent picks correctly without re-deriving the logic each turn.

### 6.1 Decision tree (rock-solid against verified architecture)

**Layer 1 — agent's own VM browser:**
- Headless Chromium running on the agent's VM
- Zero user context (no cookies, no logins, no payment methods)
- Used for autonomous public-web tasks
- Tools: Tier 1-3.5 of `web-search-browser` skill (Brave → web_fetch → built-in browser → browser-use → Crawlee)

**Layer 2 — user's real Chrome via relay:**
- Single Chrome extension at `instaclaw-chrome-extension/` (manifest name "InstaClaw Browser Relay")
- Bridges WebSocket → CDP into user's actual Chrome with all their cookies, sessions, autofill, payment methods
- Status check: `GET /relay/extension/status` returns `{"connected": boolean}` (verified at `instaclaw/app/api/vm/extension-status/route.ts`)
- Trigger: `browser --profile chrome-relay`
- Used when the agent must act *as the user* on sites they're logged into

```
Does the task require the USER's logged-in session?
  ├── YES → Layer 2 (Chrome relay)
  │         (Gmail, X DMs, banking, personal Amazon, Slack, etc.)
  │
  └── NO → Does the task require the USER's payment method?
          ├── YES → Layer 2 (Chrome relay)
          │         (purchases on user's account, paid subscriptions)
          │
          └── NO → Does the task involve user-specific personalization?
                  ├── YES → Layer 2 (Chrome relay)
                  │         (recommendations, watch history, cart contents)
                  │
                  └── NO → Layer 1 (browser-use by default)
                          (research, monitoring, public data, bulk tasks)
```

### 6.2 Within Layer 1: which tier?

```
Need a fact or URL?              → Tier 1 (web_search)
Need text from a known URL?      → Tier 2 (web_fetch)
Need to *interact* (click, fill)? → Tier 3.25 (browser-use)         ← default for interaction
Tier 3.25 blocked by anti-bot?   → Tier 3.5 (crawlee-scrape)
Tier 3.5 also blocked?           → Tier 4 (relay) if user can solve, else fail with clear error
Need raw screenshot/eval/debug?  → Tier 3 (built-in browser, fallback)
```

### 6.3 Edge cases

- **Logged-in scraping on a public site.** If the user wants public-only data ("scrape Twitter trends"), default to browser-use. If they want their own feed, use the relay.
- **Relay is offline.** Fall back to browser-use *only* if the task does not require user identity. Otherwise, ask the user to reconnect the relay (existing `/relay/extension/status` check).
- **Abuse-pattern requests** (mass account creation, ToS-prohibited scraping, payment manipulation). Refuse, regardless of which surface.
- **Agent uncertainty.** When the agent isn't sure which surface to use, **ask the user once.** Don't try both and pick the one that didn't error.

### 6.4 Decision-tree text in SKILL.md

The matrix above is duplicated as plain English in `instaclaw/skills/browser-use/SKILL.md` AND added as a new row in `web-search-browser/SKILL.md`'s decision table. Two skills, one source of truth (browser-use's references/decision-tree.md), short pointers in both SKILL.md files.

---

## 7. Technical Requirements

### 7.1 Runtime (verified against snapshot v64)

| Requirement | Status on snapshot `private/38496803` | Action |
|---|---|---|
| Python 3.11+ | Python 3.12 (Ubuntu 24.04 default) | None |
| `pip3 install --break-system-packages` | Pattern in use across `lib/ssh.ts` and `cloud-init.ts` | Reuse |
| Chromium binary | Playwright Chromium installed by `cloud-init.ts:268-288`, symlinked to `/usr/local/bin/chromium-browser` | None — reuse |
| Playwright Python | Brought in by `crawlee[beautifulsoup,playwright]==1.5.0` at `ssh.ts:5284` | Verify version compat with browser-use's Playwright requirement |
| System libs (libnss3, libgbm1, libxcomposite1…) | Installed by `cloud-init.ts:231-234` | None |
| Node 22.22.2 | Pinned in `cloud-init.ts:258` | Not needed by browser-use directly |
| OpenClaw gateway healthy | Required for LLM routing | Existing health monitoring covers this |

### 7.2 Resource budget per browser-use task

| Metric | Estimate | Hard cap (enforced in wrapper) |
|---|---|---|
| Peak RAM during task | 600-800MB | Kill at 1.2GB via `prlimit --rss` |
| Steps per task | 8-15 typical | 25 (`--max-steps`, configurable) |
| Wall-clock per task | 30-90s | 5 min (`--timeout-sec`, configurable) |
| Credit cost per task | $0.05-$0.20 (Sonnet 4.6 via gateway) | $1.00 default budget per task (`--budget-usd`) |
| Concurrent browser-use sessions | 1 | 1 (hard limit via `flock` on session.lock) |
| First-run pip install (post-deploy) | ~30-60s | n/a |
| Browser launch time | 2-5s | 30s timeout |

**Single-session lock matters**: with systemd `MemoryMax=3500M`, two concurrent Playwright Chromium instances would push the cgroup to OOM. The flock prevents that without changing systemd limits.

### 7.3 Dependencies to add

Diff against `lib/vm-manifest.ts:700`:

```typescript
- pythonPackages: ["openai"],
+ pythonPackages: ["openai", "browser-use"],
```

Diff against `lib/ssh.ts:5283-5306` (parallel pip block):

```diff
   '# 4. Solana DeFi pip deps',
   '(python3 -m pip install --quiet --break-system-packages solders base58 httpx websockets 2>/dev/null || true) &',
   'PID_SOLANA=$!',
+  '',
+  '# 5. browser-use (browser-use skill)',
+  '(python3 -m pip install --quiet --break-system-packages "browser-use>=0.1.0,<1.0.0" 2>/dev/null || true) &',
+  'PID_BROWSER_USE=$!',
   '',
-  '# 5. AgentBook agentkit-cli npm install',
+  '# 6. AgentBook agentkit-cli npm install',
   `(${NVM_PREAMBLE} && npm install -g @worldcoin/agentkit-cli@0.1.3 2>/dev/null || true) &`,
   'PID_AGENTKIT=$!',
   '',
   '# Wait for all parallel installs to complete',
-  'wait $PID_REMOTION $PID_CRAWLEE $PID_POLYMARKET $PID_SOLANA $PID_AGENTKIT 2>/dev/null',
+  'wait $PID_REMOTION $PID_CRAWLEE $PID_POLYMARKET $PID_SOLANA $PID_BROWSER_USE $PID_AGENTKIT 2>/dev/null',
   '',
+  '# Verify browser-use installed',
+  'if ! python3 -c "import browser_use" 2>/dev/null; then echo "BROWSER_USE_INSTALL_FAILED"; fi',
```

Note: pin **conservative version range** to avoid breakage on browser-use minor releases. Bump explicitly when validated.

### 7.4 Configuration knobs

| Env var / flag | Default | Source |
|---|---|---|
| `--headless` | `true` | wrapper default |
| `--max-steps` | `25` | wrapper default |
| `--budget-usd` | `1.00` | wrapper default |
| `--timeout-sec` | `300` | wrapper default |
| `BROWSER_USE_LLM_MODEL` | `claude-sonnet-4-6` | env var (overridable per call) |
| `BROWSER_USE_USER_DATA_DIR` | `~/.cache/browser-use-profile/` | env var |
| `BROWSER_USE_BLOCKLIST_FILE` | `~/.openclaw/browser-use-blocklist.txt` | env var |

Blocklist seeded with: banking, payment processors (stripe.com, paypal.com), known ToS-prohibited targets, anything Cooper flags.

---

## 8. Rollout Plan (CLAUDE.md Rule 3, 4, 5, 7 compliant)

### Phase 0 — Single-VM verification (Days 1-3) — **CLAUDE.md Rule 3**

- Pick a healthy VM (e.g., reuse the vm-379 canary pattern from session-persistence rollout).
- Manual install: `pip3 install --break-system-packages "browser-use>=0.1.0,<1.0.0"`.
- Run a fixed test suite of 10 tasks across the use-case categories.
- **Verify gateway stays healthy throughout** — `systemctl --user is-active openclaw-gateway` + `/health` 200 (CLAUDE.md Rule 5).
- Measure peak RSS, success rate, wall-clock, credit cost vs Tier 3 baseline on the same prompts.
- Verify Playwright user-data-dir collision behavior (run browser-use while built-in `browser` tool also has a session open).

**Exit criteria:** ≥80% task success on the test suite, no OOMs, no gateway restarts attributable to browser-use, credit cost within 2x of Tier 3 estimates.

### Phase 1 — Skill scaffolding + canary deploy (Week 1)

- Create `instaclaw/skills/browser-use/` directory and contents.
- Edit `web-search-browser/SKILL.md` to insert Tier 3.25.
- Add `browser-use` to `pythonPackages`.
- Add wrapper script to `VM_MANIFEST.files` with `mode: "overwrite"`.
- Add references to `VM_MANIFEST.extraSkillFiles`.
- Add pip install to the parallel install block in `configureOpenClaw()`.
- Bump `VM_MANIFEST.version` 64 → 65.
- **STOP and tell Cooper about snapshot staleness** (CLAUDE.md Rule 7).
- Reconciler picks up changes; canary rollout to ~5 VMs (re-use whatever the latest canary mechanism is — `--canary` flag was used on session persistence per memory).
- **Dry-run any fleet patch first** (CLAUDE.md Rule 4).
- Monitor for 48h: gateway health, RAM, OOMs, task success.

### Phase 2 — Fleet rollout (Week 2)

- Run dry-run on full fleet patch.
- After dry-run review, fleet-wide reconcile with `--test-first` semantics.
- Add browser-use channel to earn page (`app/(dashboard)/earn/page.tsx`) and EARN.md template.

### Phase 3 — Snapshot v65 bake (Week 3)

- Once manifest v65 is stable on the fleet for 7 days with no regressions, bake snapshot v65 per CLAUDE.md "Snapshot Creation Process".
- Disk delta is small (browser-use Python package only, ~30-80MB). Existing snapshot is 5506MB / 6144MB → comfortably fits.
- Update CLAUDE.md, `.env.local`, `reference_vm_provisioning.md`, MEMORY.md per Rule 7.

### Phase 4 — Optimization (Week 4+)

- Instrument credit cost per task by site, by use case.
- If a few sites dominate (Polymarket UI, Amazon, Zillow), build site-specific helpers in `references/` to cut steps per task.
- **v2 follow-up PRD:** verify `mcpServers` schema on canary, then register browser-use's MCP server for first-class tool calls (CLAUDE.md Rule 2 path).
- **Optional:** browser-use Cloud for residential IPs on tasks that hit hard anti-bot walls. Cost-gated, separate PRD if pursued.

### Skill toggle / credit weighting

- **No user-visible toggle in v1.** Skill is defense-in-depth, like Crawlee — always available.
- **Credit accounting:** routes through OpenClaw gateway → existing meter. No separate weighting.
- **Per-task budget cap:** `--budget-usd 1.00` default. Per-tier caps in Phase 4 if abuse is observed.

---

## 9. Risks

### 9.1 Resource exhaustion (cgroup OOM under MemoryMax=3500M)

- **Risk:** browser-use Chromium peaks at ~800MB while built-in OpenClaw Chromium is also running (managed by gateway). Two concurrent browsers + gateway overhead can hit MemoryMax.
- **Mitigation:**
  - Single-session `flock` in the wrapper.
  - `prlimit --rss=1228800` (1.2GB) wrapper cap kills runaway sessions.
  - vm-watchdog.py's existing 85% RAM Chrome-kill catches anything that escapes.
  - Phase 0 measurement gates the rollout. If peak >1GB consistently, do not ship.

### 9.2 Profile / user-data-dir collision

- **Risk:** browser-use, Crawlee, and the OpenClaw built-in tool all use Playwright Chromium. Sharing a user-data-dir would corrupt sessions.
- **Mitigation:** wrapper sets `BROWSER_USE_USER_DATA_DIR=~/.cache/browser-use-profile/`, distinct from Crawlee's per-call profile and from the built-in tool's `openclaw` profile.

### 9.3 OpenClaw config schema (Rule 2)

- **Risk:** v2 wants to register an MCP server. Untested config keys can crash the gateway (see CLAUDE.md `auth.mode: "none"` precedent).
- **Mitigation:** v1 ships as CLI wrapper, no config change. v2 verifies schema on a single canary VM (`openclaw config set mcpServers.browser-use.command python3` → confirm acceptance, confirm `is-active`) before any fleet roll.

### 9.4 Snapshot staleness (Rule 7)

- **Risk:** Bumping manifest to v65 makes snapshot v64 stale. New VMs from snapshot won't have browser-use until reconciler catches them (~5 min). Provisioning a large batch immediately after bump = stale VMs in user hands.
- **Mitigation:** STOP and tell Cooper after the bump (per Rule 7). Bake v65 in Phase 3 once stable.

### 9.5 Anti-detection ethics + ToS

- **Risk:** browser-use's stealth defaults are designed to look human. Some target sites' ToS prohibit automated access. Public-data scraping is generally legal in the US (hiQ v. LinkedIn) but ToS violations are a contractual gray area.
- **Mitigation:**
  - Domain blocklist baked into the skill (banking, payment, abuse-prone).
  - SKILL.md explicitly tells the agent **not** to bypass ToS for monetary harm.
  - Per-VM rate limits: max 60 browser-use tasks/hour, max 500/day.
  - Refuse tasks that pattern-match abuse ("create 100 accounts", "submit this form 1000 times").

### 9.6 Rate limiting / IP reputation

- **Risk:** All InstaClaw VMs are on Linode IPs. Abusive agents could get the entire `/24` blocked by Cloudflare/DataDome. CLOB proxy infrastructure (Toronto/Osaka) is precedent — geoblocking is real.
- **Mitigation:**
  - Per-domain rate limits per VM (wrapper-enforced).
  - Aggregate fleet rate limits per domain (Supabase counter).
  - Optional escalation to residential IPs for high-value tasks (Phase 4).
  - Monitor for sudden 403/429 spikes; auto-cool-down offending domain fleet-wide.

### 9.7 Cost overruns per task

- **Risk:** Pathological task (infinite scroll, agent loop) burns $5-10 in LLM calls before timing out.
- **Mitigation:** `--budget-usd 1.00` enforced in the wrapper before each LLM call. `--max-steps 25` and `--timeout-sec 300` as belt-and-suspenders.

### 9.8 OpenClaw gateway dependency

- **Risk:** If the gateway is unhealthy, browser-use's LLM calls fail (since they route through the gateway).
- **Mitigation:** Gateway health is already monitored. browser-use inherits the existing SLA. The wrapper has no fallback to direct Anthropic API — that would bypass credit metering. This is intentional.

### 9.9 Playwright version drift

- **Risk:** browser-use depends on a specific Playwright version. Crawlee pins Playwright via `crawlee[playwright]==1.5.0`. If browser-use needs a different Playwright version, pip resolution may fail or upgrade Crawlee's Playwright.
- **Mitigation:**
  - Phase 0 explicitly tests `pip install browser-use` on a VM that already has Crawlee.
  - If conflict: pin browser-use to a version compatible with Crawlee's Playwright, or install browser-use into a separate venv at `~/.cache/browser-use-venv/` (wrapper invokes that venv's Python).
  - The venv path is the safe default if any conflict appears in Phase 0.

### 9.10 Stale memory / version drift

- **Risk:** This PRD references manifest v64, snapshot `private/38496803`, OpenClaw 2026.4.26 — current as of 2026-04-28. Memory entries about browser-use install paths could rot.
- **Mitigation:** Save memory entries as **rules** (e.g., "browser-use installs via the parallel pip block in configureOpenClaw, reuses Playwright Chromium from cloud-init") rather than version-pinned facts.

---

## 10. Open Questions for Cooper

1. **CLI wrapper vs MCP for v1.** I recommend CLI wrapper (no `mcpServers` schema risk per Rule 2). Agree with the v2 follow-up plan to register the MCP server once schema is verified?
2. **Free-tier exposure.** Should browser-use be available to free-tier users, or paid-tier only? Free-tier is the abuse vector.
3. **Residential IPs.** browser-use Cloud / BrightData integration in scope here, or follow-up PRD? Adds material cost.
4. **Domain blocklist seed.** I'll seed it with banking/payment/known-spam-sensitive domains. Anything you want explicitly added or removed?
5. **Credit weighting.** Default is "no extra weight, gateway meters as usual." Worth adding a multiplier to cover Playwright Chromium VM time? Or measure first and decide in Phase 4?
6. **Snapshot timing.** Phase 3 bakes v65 7 days after manifest v65 stabilizes. If you want to bake earlier (e.g., tied to the next provisioning batch), say so and we shorten the soak.
7. **Venv vs system pip.** If Phase 0 surfaces any Playwright version conflict between Crawlee 1.5.0 and browser-use, do you prefer the `~/.cache/browser-use-venv/` isolation path, or a Crawlee version bump?

---

## 11. Success Metrics

End of Phase 2 (fleet rollout, ~Week 2):

| Metric | Target | How |
|---|---|---|
| Task success rate vs Tier 3 baseline | ≥1.5x improvement | Fixed 10-task suite, weekly run |
| OOM events on browser-use VMs | 0 | vm-watchdog.py + node_exporter |
| Gateway health regressions | 0 | Existing health monitoring |
| Median task wall-clock | <60s | wrapper trace logs |
| Median task credit cost | <$0.15 | gateway meter logs |
| Anti-bot block rate | <20% (clean Tier 3.5 escalation) | wrapper telemetry |
| User-reported "agent couldn't browse X" tickets | -50% | support backlog |

End of Phase 3 (snapshot v65):

| Metric | Target |
|---|---|
| First-boot pip install latency | 0s (vs ~30s in Phase 1-2) |
| Snapshot size | <6000MB |
| New VM provisions completing reconcile in <90s | ≥95% |

---

## 12. Out of Scope (For This PRD)

- CAPTCHA solving (escalate to Chrome relay).
- browser-use Cloud / residential IPs (separate cost-justification PRD if needed).
- Authenticated browsing on the agent's VM (the relay owns this).
- Long-running browser pools (Phase 4 optimization).
- Dashboard UI for browser-use task history (no UI in v1; agent's natural-language interface).
- MCP server registration (v2 follow-up PRD after schema verification).
- Cross-skill orchestration plumbing (works naturally via existing skill loading).
- Edits to `dispatch-server.js` or the `computer-dispatch` skill (orthogonal — desktop control, not browser).

---

## Appendix A — Concrete File-Level Changes

| File | Change | Lines |
|---|---|---|
| `instaclaw/lib/vm-manifest.ts` | `version: 64` → `65` | 383 |
| `instaclaw/lib/vm-manifest.ts` | `pythonPackages: ["openai"]` → `["openai", "browser-use"]` | 700 |
| `instaclaw/lib/vm-manifest.ts` | Add to `extraSkillFiles` array | 645-659 |
| `instaclaw/lib/vm-manifest.ts` | Add wrapper script to `files` array | (existing files array) |
| `instaclaw/lib/ssh.ts` | Insert `# 5. browser-use` parallel pip step | 5283-5306 |
| `instaclaw/lib/ssh.ts` | Add `PID_BROWSER_USE` to `wait` line | 5300 |
| `instaclaw/skills/browser-use/SKILL.md` | **NEW** | n/a |
| `instaclaw/skills/browser-use/assets/browser-use-task.py` | **NEW** | n/a |
| `instaclaw/skills/browser-use/references/decision-tree.md` | **NEW** | n/a |
| `instaclaw/skills/browser-use/references/budget-and-credits.md` | **NEW** | n/a |
| `instaclaw/skills/browser-use/references/examples/*.md` | **NEW (4 files)** | n/a |
| `instaclaw/skills/web-search-browser/SKILL.md` | Insert Tier 3.25 section + decision-table row | (existing tier sections) |
| `instaclaw/lib/earn-md-template.ts` | Add browser-use earning channel entry | (existing channels) |
| `instaclaw/app/(dashboard)/earn/page.tsx` | Add `browser-use` to `CHANNELS` array | (existing array) |

## Appendix B — Related Documents

- `instaclaw/skills/web-search-browser/SKILL.md` — existing tier ladder; this PRD inserts Tier 3.25.
- `instaclaw/skills/computer-dispatch/SKILL.md` — Layer 2 (relay) interface + dispatch.
- `instaclaw/docs/prd/dispatch-mode-remote-computer-control.md` — Phase 3 complete; companion PRD for the relay/desktop side.
- `instaclaw/docs/prd/skill-degenclaw-trading-competition.md` — recent skill-deployment template.
- `instaclaw/lib/vm-manifest.ts` — manifest source of truth (`skillsFromRepo`, `extraSkillFiles`, `pythonPackages`).
- `instaclaw/lib/ssh.ts` — `configureOpenClaw()` (lines 3347+) and parallel pip block (lines 5267-5306).
- `instaclaw/lib/cloud-init.ts` — system deps (231-234) and existing Playwright Chromium install (268-288).
- `instaclaw/lib/vm-reconcile.ts` — fleet reconciler 18-step pipeline.
- `CLAUDE.md` Rules 2, 3, 4, 5, 7 — schema verification, single-VM canary, dry-run, gateway health, snapshot refresh.
- Project memory: `reference_vm_provisioning.md`, `feedback_snapshot_refresh.md`.
