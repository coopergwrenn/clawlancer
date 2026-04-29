# Budget, Credits, and Refusal Rules

This document covers cost mechanics, hard caps, the domain blocklist, and the abuse-pattern refusal rules for the browser-use skill.

## How credits are metered

browser-use's reasoning steps run through Claude (default: `claude-sonnet-4-6`). The wrapper points the LLM client at the **OpenClaw gateway running on this VM** (`http://127.0.0.1:<port>/v1`), using `GATEWAY_TOKEN` from `~/.openclaw/.env`. This means:

1. Every reasoning step browser-use takes is metered exactly like every other agent reasoning step.
2. The user's credit balance debits via the existing pipeline.
3. There is no second billing path, no leaked Anthropic key, no out-of-band reasoning.

If the gateway is unhealthy, browser-use will fail to make progress. There is no fallback to a direct Anthropic API call — that would bypass credit metering.

## Cost shape per task

Estimates from PRD §7.2, to be confirmed by Phase 0 measurement:

| Task class | Steps (typical) | Wall-clock | Cost (Sonnet 4.6) |
|---|---|---|---|
| Single page, single action | 3-5 | 15-30s | $0.03-$0.08 |
| Multi-page extract | 8-12 | 30-60s | $0.10-$0.20 |
| Form fill + confirm | 8-15 | 30-90s | $0.10-$0.25 |
| Research with synthesis | 15-25 | 60-180s | $0.25-$0.60 |

**Pathological case:** an agent that thrashes on a confused page can hit the step cap and burn the full budget. The hard caps (`--max-steps`, `--timeout-sec`) bound the worst case. The `--budget-usd` field is reported in output for tracking but is NOT pre-enforced per LLM call in v1 — use `--max-steps` as the primary cost lever.

## Hard caps (enforced)

| Cap | Default | Where enforced |
|---|---|---|
| `--max-steps` | 25 | Passed to browser-use Agent constructor |
| `--timeout-sec` | 300 (5 min) | `asyncio.wait_for` around `agent.run()` |
| Concurrency | 1 session/VM | `flock` on `~/.cache/browser-use/session.lock` |
| Virtual memory | 2 GB process limit | `resource.setrlimit(RLIMIT_AS, ...)` |
| RAM (cgroup) | 3500 MB systemd MemoryMax | Inherited from `openclaw-gateway.service` |
| RAM (watchdog) | Chrome killed at 85% RAM | `~/.openclaw/scripts/vm-watchdog.py` |
| Per-VM rate | 60 tasks/hour, 500/day | Upstream tracking (Supabase counters) |

**The first cap to hit is usually `--max-steps`.** Tune that per task; leave the others alone unless you have a measured reason.

## Soft caps (reported, not pre-enforced)

| Cap | Default | Where reported |
|---|---|---|
| `--budget-usd` | $1.00 | `cost_usd` field in output JSON |

Pre-enforcement of `--budget-usd` per LLM call requires intercepting browser-use's internal LLM client. That's planned for v2 (when the MCP server registration lands and we have a single chokepoint). For v1, treat `--budget-usd` as a tracking field and rely on `--max-steps` for cost control.

## Domain blocklist

Path: `~/.openclaw/browser-use-blocklist.txt`

Format: one hostname per line. Lines starting with `#` are comments. The wrapper checks the start URL's host against the list (exact match or any subdomain). If matched, the task aborts with `"start-url is on the blocklist: <domain>"`.

### Default seed

```
# Banking and brokerage — never automate these
chase.com
bankofamerica.com
wellsfargo.com
schwab.com
fidelity.com
vanguard.com
robinhood.com
coinbase.com

# Payment processors — never inject through automation
stripe.com
paypal.com
braintreepayments.com

# Government / sensitive
ssa.gov
irs.gov
usps.com

# High-abuse-target lead-gen / spam-magnet sites (placeholder — Cooper to confirm)
# (open question per PRD §10 Q4)
```

The wrapper checks the **start URL** only. If the agent navigates to a blocklisted domain mid-task, the wrapper does not currently re-check (would require monkey-patching browser-use's internal navigation). For v1 the agent is on the honor system; v2's MCP integration adds per-step domain checks.

If a user explicitly asks the agent to use a blocklisted domain, the agent should refuse and explain why. Do not edit the blocklist file from the agent — it's owned by the platform.

## Refusal rules

The agent and the wrapper both refuse, on principle:

### 1. Mass account creation

> "Create 100 accounts on Service X for me."

Refuse. browser-use is not a sock-puppet farm. Even if the target site has no anti-abuse, mass account creation is a strong abuse signal and is platform-prohibited.

### 2. Bulk spam form submission

> "Submit this contact form 1000 times with these inputs."

Refuse. Bulk form submission to a single endpoint is spam. Single submission is fine; bulk is not.

### 3. Bypassing payment / paywalls / auth gates

> "Get past this paywall" / "Skip the payment step" / "Find a way around the login wall."

Refuse. Paywalls and auth gates exist for a reason. The relay handles authenticated flows when the user authorizes them. browser-use does not bypass them.

### 4. CAPTCHA solving

> "Solve this CAPTCHA."

Refuse. CAPTCHAs are explicitly the user's job (via the relay) or unsolvable from a VM. Don't try.

### 5. Blocklisted domains

If the start URL or task target is on the blocklist, refuse and explain. Don't try to find a roundabout path.

### 6. Anything that pattern-matches obvious abuse

Examples that should trigger refusal:
- "Scrape every page on this site as fast as possible." (scaling abuse)
- "Click this button on a loop until X happens." (DoS-shaped)
- "Send this comment to 50 different posts." (spam shaped)
- "Generate fake reviews on Y." (fraud)
- "Vote N times in this poll." (ballot-stuffing)

When in doubt, ask the user what they're trying to accomplish, and route to a non-abusive form of the request.

## Failure modes you'll see, and what they mean

| Error message | Meaning | Action |
|---|---|---|
| `"Another browser-use task is already running on this VM"` | Single-session lock held | Wait for prior task; do not retry in a tight loop |
| `"task exceeded --timeout-sec=N"` | Wall-clock cap hit | Simplify the task, raise `--timeout-sec` deliberately |
| `"start-url is on the blocklist: <domain>"` | Start URL hit blocklist | Do not retry; refuse and explain to user |
| `"browser-use not importable"` | Package not installed | Surface to user; install per SKILL.md |
| `"could not resolve gateway URL or token"` | Gateway env / auth-profiles missing | Check `~/.openclaw/.env` and `auth-profiles.json` |
| `"Agent constructor failed"` | browser-use API mismatch | Phase 0 verification item; report to Cooper |
| `"agent.run() raised"` | browser-use runtime error | Read the type and message; common: navigation timeout, page crash |

## Phase 0 metrics to confirm

The PRD §11 lists success metrics. The cost-and-budget ones are:

| Metric | Target | Measured how |
|---|---|---|
| Median task wall-clock | <60s | wrapper output `wall_time_ms` |
| Median task credit cost | <$0.15 | gateway meter logs |
| Anti-bot block rate | <20% (clean Tier 3.5 escalation) | wrapper telemetry |
| Cost overruns past budget | 0 (target) | gateway meter vs `--budget-usd` |

If Phase 0 reveals the budget pre-enforcement gap is biting (e.g., users hitting unexpected $5 tasks because max-steps was set high), the v2 MCP path is the fix.
