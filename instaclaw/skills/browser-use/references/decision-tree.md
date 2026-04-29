# Decision Tree — When to Use browser-use

This is the deep version of the decision logic in `SKILL.md`. Read this when the SKILL.md summary doesn't cover your edge case.

## Two-layer model

InstaClaw agents have two browsing surfaces:

- **Layer 1 — Your own VM browser.** Headless Chromium running on the VM you live on. Zero user context: no cookies, no logins, no payment methods. Used for autonomous public-web tasks. The web-search-browser skill organizes Layer 1 into Tiers 1-3.5 (Brave Search → web_fetch → built-in browser → browser-use → Crawlee stealth).
- **Layer 2 — User's real Chrome via the relay extension.** A WebSocket bridge to the user's actual browser, with all their cookies, sessions, autofill, and payment methods. Used when you must act *as the user* on sites where they have an account. Triggered with `browser --profile chrome-relay` (Tier 4).

browser-use lives in Layer 1, at Tier 3.25. It does not touch the user's real browser. If a task needs the user's identity, browser-use is the wrong tool.

## Primary decision tree

```
Does the task require the USER's logged-in session?
  ├── YES → Layer 2 (Chrome relay)
  │         Examples: read my Gmail, post to my Twitter, check my bank balance,
  │         message someone on Slack, see my Amazon order history.
  │
  └── NO → Does the task require the USER's payment method?
          ├── YES → Layer 2 (Chrome relay)
          │         Examples: buy this for me, subscribe me to X, complete a paid checkout.
          │
          └── NO → Does the task involve user-specific personalization?
                  ├── YES → Layer 2 (Chrome relay)
                  │         Examples: see what's recommended to me on YouTube,
                  │         show what's in my cart, look at my watch history.
                  │
                  └── NO → Layer 1 (browser-use is the default)
                          Examples: research, price monitoring, public data extraction,
                          form filling on public lead-gen sites, comparison shopping
                          across N tabs, booking on a site that doesn't require a login.
```

## Within Layer 1: which tier?

```
Need a fact or to discover URLs?      → Tier 1 (web_search)
Need text from a known URL?           → Tier 2 (web_fetch)
Need to *interact* (click, fill)?     → Tier 3.25 (browser-use)         ← default for interaction
Tier 3.25 blocked by anti-bot?        → Tier 3.5 (crawlee-scrape)
Tier 3.5 also blocked?                → Tier 4 (relay) IF user can solve, else fail clearly
Need raw screenshot/eval/debug only?  → Tier 3 (built-in browser, fallback)
```

The built-in `browser` tool (Tier 3) stays available — it's the right tool for "open this page, evaluate this snippet of JS, give me one screenshot." It's the wrong tool for "do this 5-step task on a JS-heavy SPA," which is exactly what browser-use is for.

## Edge cases

### 1. Logged-in scraping of a public site

If the data is *publicly visible without a login*, use browser-use even if the site has logged-in features. Example: Twitter trends are public — browser-use is fine. The user's own feed is private — relay only.

**Test:** can a logged-out user in an incognito window see this data? If yes → browser-use. If no → relay.

### 2. The relay is offline (`/relay/extension/status` → connected:false)

Two cases:

- **Task does not need user identity.** Run on browser-use as normal.
- **Task does need user identity.** Tell the user the relay is disconnected and how to reconnect. Do not pretend to do the task with browser-use — it will produce wrong results (no cookies, different recommendations, anti-bot heat).

### 3. The user asks for something that mixes layers

Example: "Find the best laptop deals on Amazon and add the cheapest to my cart."

Split into two phases:
1. Research phase (browser-use): find the cheapest laptop matching the criteria. Public data, no login.
2. Action phase (relay): add to *the user's* cart, since "my cart" requires the user's session.

Always tell the user what you're going to do before you do the action phase, since it touches their account.

### 4. Anti-bot blocks browser-use

The block typically shows up as a Cloudflare interstitial, a 403, a DataDome challenge, or a CAPTCHA you can't solve. Escalation order:

1. Try browser-use again with `--no-headless` and a clearer task (sometimes headless detection is the issue).
2. Switch to Tier 3.5: `python3 ~/scripts/crawlee-scrape.py --url "URL" --mode light` (TLS fingerprint impersonation).
3. If `--mode light` fails: `--mode browser` (full Chromium with fingerprint randomization).
4. If Crawlee also fails:
   - If the user has the relay connected and can solve a CAPTCHA → use Tier 4.
   - Otherwise tell the user the site has hard anti-bot protection. Do not try to brute through it.

### 5. The user asks for something the skill should refuse

Mass account creation, bulk spam form submission, bypassing paywalls, payment manipulation. Refuse outright and explain. Don't try to find a workaround. See `budget-and-credits.md` §"Refusal rules."

### 6. The agent is uncertain

Default action: ask the user one clarifying question. Bad pattern: try browser-use, fail, switch to relay, fail, give up. Each attempt costs credits and time. One question is cheaper than three failed attempts.

Good ask:
> "I can do this two ways: (a) on my own VM (faster, public data only), or (b) through your real Chrome (uses your logged-in account). Which do you want?"

## Sub-decision: should this run inline or as a recurring task?

browser-use is well-suited to recurring background tasks (e.g., "check this page every 30 minutes for a price drop"). The `recurring-executor.ts` infrastructure can schedule these. When the user describes something that sounds recurring ("watch", "monitor", "alert me when"), ask whether it should be a one-shot or a recurring schedule before launching.

## Sub-decision: budget shape

| Task complexity | `--max-steps` | `--timeout-sec` | `--budget-usd` |
|---|---|---|---|
| Single page, single action | 5 | 60 | 0.10 |
| Multi-page extract, no forms | 10-15 | 120 | 0.30 |
| Form fill + confirm flow | 10-15 | 180 | 0.40 |
| Research across 5+ pages with synthesis | 20-25 | 300 | 1.00 |

Start at the lower bound for the task class. If the task fails on max-steps, the failure mode is clear (the wrapper says so). Increase deliberately, not preemptively.

## What this tool will NOT do (reinforcement)

- Will not log into accounts on the user's behalf — that's the relay.
- Will not solve CAPTCHAs.
- Will not bypass paywalls or licensing gates.
- Will not run multiple browser-use sessions concurrently on the same VM (single-session lock).
- Will not exceed the per-task hard caps (max-steps, timeout-sec).
- Will not visit blocklisted domains as the start URL.

If the user asks for any of these, surface the constraint and offer the correct alternative (usually: relay, or "this isn't possible from this VM").
