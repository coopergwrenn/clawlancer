---
name: browser-use
description: >-
  Sophisticated browser automation for the agent's own VM. Use for autonomous multi-step web tasks that don't require the user's logged-in session — research, monitoring, data extraction, form filling, comparison shopping, booking on public sites.
metadata:
  triggers:
    keywords: [browse, navigate, fill out, extract, monitor, watch, scrape, compare, book, search and find]
    phrases: ["fill out this form", "monitor this page", "find me the best", "extract data from", "compare prices on", "book a", "go through this website"]
    NOT: [my email, my account, log into, my Instagram, my Twitter, post for me, pay for]
---

# browser-use — Tier 3.25 in the web-search-browser ladder

This skill gives you a **structured, multi-step browser agent** running on your own VM. It uses the [browser-use](https://browser-use.com) Python package, which targets pages by accessibility tree (stable named elements) instead of screenshot coordinates. It is the right tool for **interacting with a page** — clicking, filling forms, navigating multi-step flows, extracting data across pages — when the user's logged-in session is not required.

It is **not** the Chrome relay. The Chrome relay (`browser --profile chrome-relay`, Tier 4) acts inside the user's real Chrome with their cookies and logins. browser-use runs on your VM, with zero user context.

## When to use this vs the other tiers

You have two browsing surfaces and a five-step ladder inside this VM. Pick the lightest tool that gets the job done.

| Need | Use |
|---|---|
| Fact, news, or URL discovery | `web_search` (Tier 1) |
| Read a known URL as text | `web_fetch` (Tier 2) |
| Single screenshot or one-off `evaluate` | built-in `browser` tool (Tier 3) |
| **Interact with a page** (click, fill, multi-step) | **`browser-use-task.py` (Tier 3.25 — this skill)** |
| Anti-bot wall (Cloudflare 403, DataDome, PerimeterX) | `crawlee-scrape.py` (Tier 3.5) |
| Site needs the user's logged-in account | `browser --profile chrome-relay` (Tier 4) |

**Default rule:** if the task is *do something on a page*, start with browser-use. If it gets blocked by anti-bot, escalate to Crawlee. If the site needs the user's account, route to the relay.

## Two-browser decision tree (which surface)

```
Does the task require the USER's logged-in session?
  ├── YES → Tier 4 (Chrome relay)
  │         (Gmail, X DMs, banking, personal Amazon, Slack, etc.)
  │
  └── NO → Does the task require the USER's payment method?
          ├── YES → Tier 4 (Chrome relay)
          │
          └── NO → Does the task involve user-specific personalization?
                  ├── YES → Tier 4 (Chrome relay)
                  │         (recommendations, watch history, cart)
                  │
                  └── NO → browser-use (Tier 3.25, this skill)
                          (research, monitoring, public data, bulk tasks)
```

Edge cases:
- **Logged-in scraping on a public site.** "Scrape Twitter trends" → browser-use. "Read my own Twitter feed" → relay.
- **Relay is offline.** Fall back to browser-use *only if* the task does not need user identity. Otherwise ask the user to reconnect the relay.
- **You're not sure.** Ask the user once. Don't try both surfaces and pick whichever didn't error.

See `references/decision-tree.md` for worked edge cases.

## How to invoke

```bash
python3 ~/scripts/browser-use-task.py \
  --task "Find the cheapest 1-bed apartment in Brooklyn under $2500 on Zillow, return JSON" \
  --start-url "https://zillow.com" \
  --max-steps 25 \
  --budget-usd 0.50 \
  --headless \
  --output-format json
```

Required:
- `--task` — natural-language description of what you want done. The more specific, the fewer steps the agent needs.

Optional (with defaults):
- `--start-url` — page to open first. If omitted, the task description should contain the URL.
- `--max-steps 25` — hard cap on agent iterations. **The primary safety lever.** Lower it for simple tasks (5-10) to save credits.
- `--budget-usd 1.00` — soft cost budget, reported in output. Pre-enforcement is via `--max-steps` and `--timeout-sec`; this is for tracking.
- `--timeout-sec 300` — hard wall-clock cap.
- `--headless` (default true) — run without a display. Use `--no-headless` only when debugging interactively.
- `--model claude-sonnet-4-6` — LLM for browser-use's planner. Routes through the OpenClaw gateway, so credits meter through your normal pipeline.

## Output shape

Always JSON, always single-line on stdout. Logs go to stderr.

```json
{
  "ok": true,
  "result": "<the agent's final answer, often a string or structured dict>",
  "steps": [...],
  "screenshots": [...],
  "cost_usd": 0.12,
  "wall_time_ms": 47800
}
```

On failure:
```json
{"ok": false, "error": "task exceeded --timeout-sec=300"}
```

Common failure messages:
- `"Another browser-use task is already running on this VM"` — single-session lock. Wait or kill the prior session.
- `"task exceeded --timeout-sec=N"` — task ran past wall-clock cap. Either raise `--timeout-sec` or simplify the task.
- `"start-url is on the blocklist: <domain>"` — the start URL is blocked. See `references/budget-and-credits.md` for the blocklist policy.
- `"browser-use not importable: ..."` — package not installed on this VM. Run `pip3 install --break-system-packages "browser-use>=0.1.0,<1.0.0"`.
- `"could not resolve gateway URL or token"` — env vars not set and `~/.openclaw/agents/main/agent/auth-profiles.json` missing or unreadable. The wrapper needs `GATEWAY_TOKEN` (and optionally `GATEWAY_URL`); without them it parses `auth-profiles.json` for `profiles["anthropic:default"]`.

## Caps and budgets

- **Concurrency:** 1 session per VM. Enforced via `flock` on `~/.cache/browser-use/session.lock`. If you need parallelism, run the tasks sequentially — concurrent Playwright Chromium instances can OOM the cgroup (`MemoryMax=3500M`).
- **Default per-task budget:** `--max-steps 25`, `--budget-usd 1.00`, `--timeout-sec 300`. For simple tasks lower max-steps aggressively.
- **Per-VM rate limits:** 60 tasks/hour, 500/day (enforced upstream). If you hit them, surface the limit to the user — don't burn through retrying.

See `references/budget-and-credits.md` for the cost model and abuse-pattern refusal rules.

## On failure, escalate

```
browser-use returns ok:false   → Read error.
  ├── "interrupted" / OOM       → Retry once with --max-steps cut in half.
  ├── 403 / Cloudflare / CAPTCHA → Tier 3.5: python3 ~/scripts/crawlee-scrape.py --url "URL" --mode light
  ├── crawlee also blocked       → Tier 4: relay if user can solve, else fail with a clear message
  └── timeout exceeded           → Simplify the task (split into 2 calls) before retrying
```

**Never go silent on failure.** Always tell the user what was attempted, what failed, and the next option.

## What this skill will refuse

The wrapper and the agent both refuse:

- **Mass account creation** ("create 100 accounts on…") — flagged as abuse.
- **Bulk form submission to spam endpoints** ("submit this form 1000 times") — flagged as abuse.
- **Bypassing payment, paywalls, or auth gates** — out of scope for this skill; the relay handles authenticated flows when the user authorizes.
- **CAPTCHA solving** — escalate to the relay so the user can solve.
- **Sites on the blocklist** (banking, payment processors, known abuse-prone targets). See `references/budget-and-credits.md`.

If the user asks for any of these, refuse and explain why. Don't try to find a workaround.

## Examples

Concrete copy-pasteable invocations are in `references/examples/`:

- `references/examples/price-monitoring.md` — watch a product page, alert on price change
- `references/examples/form-filling.md` — submit a public contact / lead-gen form
- `references/examples/data-extraction.md` — multi-page table scrape with synthesis
- `references/examples/multi-step-research.md` — research a topic across N pages

## Environment expectations (already set up on this VM)

- Python 3.11+ (Ubuntu 24.04 default = 3.12)
- `browser_use` Python package
- Playwright Chromium at `~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome` (also symlinked to `/usr/local/bin/chromium-browser`)
- OpenClaw gateway running locally — the wrapper routes browser-use's reasoning through it for credit metering
- `GATEWAY_TOKEN` in `~/.openclaw/.env`; `auth-profiles.json` at `~/.openclaw/agents/main/agent/auth-profiles.json` as fallback for the gateway URL

If any of the above is missing, the wrapper returns a clear `ok:false` error pointing at the fix.

## Source of truth

- This SKILL.md is the agent-facing summary.
- `references/decision-tree.md` is the deeper decision logic for edge cases.
- `references/budget-and-credits.md` is the cost model + blocklist policy + refusal rules.
- `references/examples/*.md` are worked examples.
- The PRD (`instaclaw/docs/prd/skill-browser-use-integration.md` in the repo) is the design source of truth.
