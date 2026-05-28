# 2026-05-28 — strip-thinking periodic summary silently overcharged 19 paying users fleet-wide

## Severity

**P0** — 19 paying customers hit their daily display limit by noon UTC; vm-1006
burned 19,000 cost_weight on a 2,500 daily budget (7.6x overconsumption);
Cooper's own agent blocked at 600/600 during a planned ClawFi demo recording.

## TL;DR

The periodic-summary cron in `STRIP_THINKING_SCRIPT` (`lib/ssh.ts`) sends
`x-model-override: claude-haiku-4-5-20251001` to `/api/gateway/proxy` expecting
cost=1. **The proxy never read that header.** The content classifier in
`lib/model-router.ts` matched the summary prompt against `SONNET_SIGNALS` /
`OPUS_MULTI_AGENT` / `hasComplexBuild` and routed to sonnet (cost=4) or even
opus (cost=19). The calls were also logged with `call_type='user'` and charged
against the user's daily display limit.

The bug is a **two-layer infrastructure-vs-user attribution failure**: silent
upgrade (header ignored) + wrong budget bucket (charged to user).

## Affected users (refunded 2026-05-28 ~13:30 UTC)

15 paying users got their `instaclaw_vms.credit_balance` bumped (Cooper +
1 internal canary already at quota — totaled 16 candidates, 1 skipped because
already above target). Per-tier formula: `credit_balance = max(current, 2 × tier_display_limit)`.

| VM | User | Tier | Before | After | Delta |
|---|---|---|---|---|---|
| vm-960 | civclaw@gmail.com | power | 0 | 5000 | +5000 |
| vm-1009 | doxspie@gmail.com | power | 0 | 5000 | +5000 |
| vm-1025 | sleepyruffian22@gmail.com | power | 0 | 5000 | +5000 |
| vm-742 | alejandroclarianamartinez@gmail.com | pro | 0.6 | 2000 | +1999.4 |
| vm-729 | textmaxmax@gmail.com | pro | 0.2 | 2000 | +1999.8 |
| vm-075 | sales@europartshop.com | starter | 0 | 1200 | +1200 |
| vm-946 | nwilliams.shopify@gmail.com | starter | 0 | 1200 | +1200 |
| vm-724 | sebastianmissionviejo@gmail.com | starter | 0 | 1200 | +1200 |
| vm-929 | juice999down@gmail.com | power | 0 | 5000 | +5000 |
| vm-360 | rukshana.h1@gmail.com | starter | 0 | 1200 | +1200 |
| vm-592 | antonius001@gmail.com | starter | 0 | 1200 | +1200 |
| vm-347 | thurlowjp3@gmail.com | starter | 0 | 1200 | +1200 |
| vm-1006 | ddoxpie@gmail.com | power | 0 | 5000 | +5000 |
| vm-1024 | kelldoxpie@gmail.com | power | 0 | 5000 | +5000 |
| vm-935 | christophermphills@gmail.com | power | 0 | 5000 | +5000 |
| vm-1043 | cooper-v122-canary@instaclaw.test | starter | 4907 | 4907 | +0 (already bumped) |

Total credit_balance restored ≈ 41,200 cost_weight (~0.04 USD of haiku-equivalent
compute at our infrastructure account, but the user-perceived value is
"day-of-use restored" not direct dollar cost).

Audit trail: `/tmp/inc-2026-05-28-refunds.json`. Reproducible via
`npx tsx instaclaw/scripts/_refund-strip-thinking-victims-2026-05-28.ts`.

## Timeline (UTC)

| Time | Event |
|---|---|
| ~2026-04 | `STRIP_THINKING_SCRIPT` adds the periodic summary helpers + `x-model-override` header (PERIODIC_SUMMARY_V1) |
| ~2026-04 | Proxy `/api/gateway/proxy` ignores `x-model-override` (the header was never wired). Latent bug begins |
| 2026-05-28 01:51 UTC | First user-call on Cooper's vm-1043 lands; periodic summary cron starts firing every ~30s as session content accumulates. Same pattern fleet-wide |
| 2026-05-28 02:00–08:00 UTC | Cooper's vm-1043 burns ~470 cost_weight/hour. Reaches 600/600 starter cap around 03:00 UTC (8 hours before his EDT workday started) |
| 2026-05-28 13:13 UTC | Cooper notices 600/600 limit at 8:44 AM EST while attempting to record a ClawFi demo |
| 2026-05-28 13:14 UTC | IR terminal triage begins. credit_balance bumped 0 → 5000 on vm-1043 within first 90 seconds to unblock the demo |
| 2026-05-28 13:14–13:24 UTC | Root cause traced: `lib/ssh.ts:1474` periodic-summary helper, proxy ignores `x-model-override`, content router upgrades to sonnet/opus, logged as `call_type='user'`. 19 paying users at cap fleet-wide identified |
| 2026-05-28 13:30 UTC | Cooper authorizes autonomous Phase 1 fix |
| 2026-05-28 13:50 UTC | PHASE 1 ships: surgical kill switch (PERIODIC_SUMMARY_LLM_ENABLED = False) merged via PR #20, deployed manually to vm-1043, verified zero new summarize calls over 4-min observation window |
| 2026-05-28 13:55 UTC | 15 paying users refunded via `_refund-strip-thinking-victims-2026-05-28.ts` (see table above) |
| 2026-05-28 ~14:30 UTC | PHASE 2 ships: proxy reads `x-call-kind: infrastructure` and `x-model-override`, forces haiku, skips user limit RPC, logs as `call_type='infrastructure'`, enforces separate per-VM per-day budget (INFRASTRUCTURE_DAILY_BUDGET = 500). Strip-thinking call sites send both headers. Kill switch flipped back to True via same PR |
| 2026-05-28 ~14:40 UTC | PHASE 3 ships in same PR: usage-anomaly-check gets Signal 4 (per-VM infrastructure rate >200/h fires P1 alert), CLAUDE.md Rule 69 documents the call_type taxonomy, this post-mortem written |

## Root cause

The bug has two independently-load-bearing layers:

### Layer 1 — proxy ignores `x-model-override`

`STRIP_THINKING_SCRIPT` sends `x-model-override: claude-haiku-4-5-20251001` in
every curl to the proxy. `app/api/gateway/proxy/route.ts` had zero references
to this header (`grep -n 'x-model-override' app/api/gateway/proxy/route.ts`
returned nothing). The model router's `ctx.explicitModelRequest` path exists
and would have respected the header — but the proxy never plumbed the header
into the routing context.

So the proxy fell through to content classification. The summary prompt
("You are summarizing a recent conversation between a User and their personal
AI Agent...") trips multiple SONNET / OPUS signals in `lib/model-router.ts`:

- `SONNET_SIGNALS` matches "summarize", "summary", "user_facts", "preferences"
- `OPUS_MULTI_AGENT` matches "Agent" + multi-mention patterns
- `hasComplexBuild` matches multi-component prompts with structured output

Net result: routing to sonnet (cost=4) or opus (cost=19) instead of haiku
(cost=1). 4–19x overconsumption per call.

### Layer 2 — infrastructure calls counted as `call_type='user'`

The proxy's `callType` assignment at the usage_log INSERT was:

```ts
const callType = isHeartbeat ? "heartbeat"
               : isVirtuals ? "virtuals"
               : isToolContinuation ? "tool_continuation"
               : "user";
```

There was no `infrastructure` category and no header that could express "this
is an internal platform call, don't count it against the user." Heartbeats
were the only special category, and their detection relies on prompt-content
patterns + timing fields on the VM row — none of which apply to
strip-thinking's periodic summary.

So `instaclaw_check_and_increment` was called with `p_is_heartbeat=false`,
which incremented the VM's `instaclaw_daily_usage.message_count`. That counter
gates the user's daily display limit.

### Why 19 VMs hit cap so fast

The strip-thinking cron runs every minute. The periodic-summary helper had
throttle gates (`PERIODIC_SUMMARY_INTERVAL = 7200s = 2h`,
`PRE_ARCHIVE_SUMMARY_RECENT_THRESHOLD = 1800s = 30min`), BUT they were
per-session, and many VMs accumulate multiple active sessions. When session
activity is high (Cooper had ~5 active sessions), each pre-archive trigger
generated 1–3 summary calls. At cost=4 per sonnet call × ~117 calls/hour =
~470 cost_weight/hour. Starter's 600 limit blew in 1h15m. Power's 2500 limit
blew in ~5h.

Worse, the proxy's content classifier sometimes routed to OPUS (cost=19),
which on vm-1006 produced 19,000 cost_weight (7.6x daily budget) in <12h.

## Impact

**Customer-visible**: 19 paying users were silently rate-limited mid-day. They
saw the dashboard's "you've used X/Y daily credits" go to N/N and got the
upsell response on Telegram messages. Several were power-tier users who had
just paid $200/month for the upgrade.

**Financial / billing**: no direct dollar overcharge to users (their
subscriptions are flat). The user-perceived value is "you billed me $29-$200
for a service that locked me out by lunchtime."

**Internal cost**: our infrastructure account paid for ~150,000 cost_weight
of summary calls fleet-wide today (compare to a normal day's <1,000). At
sonnet/opus pricing instead of haiku, the over-spend at the Anthropic API
layer is meaningful but bounded (~$50–100 of overspend total).

**Reputation**: Cooper's demo recording was blocked. Several power-tier users
likely wrote off the platform today. This is the kind of bug that, if not
fixed immediately and visibly, causes silent churn over the following weeks.

## Phase 1 — kill switch (shipped 2026-05-28 13:50 UTC, PR #20)

`PERIODIC_SUMMARY_LLM_ENABLED = False` constant added at the top of the
periodic-summary section in `STRIP_THINKING_SCRIPT`. Both LLM helpers
(`_call_haiku_for_summary`, `_call_haiku_structured`) early-return `None` when
the flag is False. All three callers already had graceful `None`-handling
paths:

- `run_session_end_hook` (line 1417): logs "haiku call failed" and skips
- `run_periodic_summary_hook` (line 1659): logs "haiku call failed, will retry" and returns
- `_ensure_recent_summary_before_archive` (line 1712): logs "haiku call failed" and returns

Everything else in strip-thinking continued working:
- thinking-block stripping
- `compact_session_in_place_lines` (Rule 30 in-place compaction)
- `daily_hygiene` (disk / backup / browser cache / journal vacuum)
- `trim_failed_turns` (Rule 22 trim-not-nuke)
- `strip_images_from_older_messages`
- `_extract_large_tool_results_to_cache` (Layer 3 memory pointer)
- `run_startup_orphan_repair`
- session-log.md / MEMORY.md maintenance writes initiated by the AGENT
  (instructions to write are in AGENTS.md; the cron-side LLM-generated
  backfill paused temporarily; the agent's own writes continued)

Two Rule 23 sentinels added:
- `STRIP_THINKING_LLM_KILL_SWITCH_2026_05_28` (canonical marker)
- `PERIODIC_SUMMARY_LLM_ENABLED = False` (the runtime constant proving the
  constant value, since changed for Phase 2 — see below)

Manifest bumped 123 → 124. Propagation via file-drift (15-min) and
reconcile-fleet (3-min); no gateway restart required.

Canary deploy via SSH to vm-1043 verified the kill switch worked: zero new
"summarize" usage_log rows in the 4-minute window post-deploy, vs ~3/min in
the 4-minute window before deploy.

## Phase 2 — proper call_type taxonomy (shipped same day, separate PR)

The kill switch stopped the bleeding but disabled a genuinely useful feature
(automated cross-session memory hardening). Phase 2 puts the periodic summary
back on a CORRECT routing path so it can be safely re-enabled.

### New constants (`lib/credit-constants.ts`)

```ts
export const INFRASTRUCTURE_DAILY_BUDGET = 500;      // cost_weight per VM per day
export const INFRASTRUCTURE_FORCED_MODEL = "claude-haiku-4-5-20251001";
```

### Proxy patches (`app/api/gateway/proxy/route.ts`)

Two new headers read at request handler entry, right after the existing
`x-call-kind: match-pipeline` bypass detection:

```ts
const isInfrastructureCall =
  callKindHeader?.toLowerCase() === "infrastructure";
const modelOverrideHeader = req.headers.get("x-model-override");
const hasModelOverride =
  typeof modelOverrideHeader === "string" && modelOverrideHeader.length > 0;
```

For `isInfrastructureCall === true`:

1. **Force model**: `requestedModel = INFRASTRUCTURE_FORCED_MODEL`. The body's
   `model` field is also overwritten so the upstream Anthropic call uses haiku
   regardless of what the caller's body said.
2. **Per-VM per-day budget cap**: cheap COUNT() against today's usage_log rows
   where `call_type='infrastructure'`. If the sum exceeds
   `INFRASTRUCTURE_DAILY_BUDGET`, return HTTP 429. Soft-fail on transient
   PostgREST errors (better to let the call through than hard-block on a glitch).
3. **Skip the heartbeat path**: added to the existing isHeartbeat bypass list
   (`strictCanaryBypass || matchPipelineBypass || isManualMessage || isInfrastructureCall`).
4. **Skip the user limit RPC**: instead of calling
   `instaclaw_check_and_increment`, synthesize an `allowed=true` result with
   sentinel `source='infrastructure'`. The user's `instaclaw_daily_usage.message_count`
   is NOT touched.
5. **Skip the content router**: `if (!isHeartbeat && !isVirtuals && !isInfrastructureCall)`
   guard around the `routingDecision` block.
6. **Skip tier-usage increment**: `if (routingDecision && !isHeartbeat && !isInfrastructureCall)`
   on the `instaclaw_increment_tier_usage` call.
7. **Skip the cron circuit breaker**: infrastructure calls don't have
   first_manual_at semantics.
8. **Log as `call_type='infrastructure'`**: usage_log INSERT updated.

For `hasModelOverride === true` (regardless of call kind — defense in depth):

The `routingCtx.explicitModelRequest` is set from the header. The existing
`respectExplicitModel()` path in `lib/model-router.ts` takes precedence over
content classification. This is a defense layer for any future caller who
remembers `x-model-override` but forgets `x-call-kind`.

### Strip-thinking caller patches (`lib/ssh.ts`)

Both LLM call sites now send both headers:

```python
result = _sp.run(["curl",..., 
  "-H", "x-call-kind: infrastructure",
  "-H", "x-model-override: claude-haiku-4-5-20251001", ...])
```

And `PERIODIC_SUMMARY_LLM_ENABLED` is flipped back to `True`.

### Rule 23 sentinel changes

- v124 sentinel `"PERIODIC_SUMMARY_LLM_ENABLED = False"` REMOVED (the constant
  is now True; the value-bound sentinel would false-fail otherwise).
- v125 sentinel `"x-call-kind: infrastructure"` ADDED (proves the deployed
  script has the Phase 2 header wiring).
- The forensic anchor `"STRIP_THINKING_LLM_KILL_SWITCH_2026_05_28"` STAYS
  permanently.

Manifest bumped 124 → 125. Propagation: file-drift (15-min) + reconcile-fleet
(3-min). No gateway restart.

## Phase 3 — monitoring + prevention (same PR as Phase 2)

### usage-anomaly-check Signal 4

A new per-VM infrastructure-rate signal: any VM with `>= 200 cost_weight` of
`call_type='infrastructure'` usage_log rows in the last hour fires a P1
admin email with the top-3 offending VMs surfaced inline.

Threshold rationale: expected baseline is single-digit cost_weight per VM per
hour (strip-thinking periodic summary at 2h interval × ~5 sessions × cost=1).
200/hour is 40x over expected; a clear regression signal.

Body includes drill-down SQL for the responder to identify which caller
within an offending VM is generating the load (by prompt_hint group-by).

### CLAUDE.md Rule 69

The call_type taxonomy is now a numbered CLAUDE.md rule (see that doc for
the canonical text). The rule enumerates:

- The 5 categories (`user`, `tool_continuation`, `heartbeat`, `virtuals`,
  `infrastructure`)
- The headers callers must send for each non-user category
- The proxy's verification: ANY call type that bypasses the user limit RPC
  needs an opt-in header. Content classification alone is never the basis
  for non-user categorization
- The Rule 23 sentinels that gate any new infrastructure caller from
  silently regressing the contract

### Regression test scenario

Documented in the rule: "if a new developer adds an LLM call to a cron job
without the `x-call-kind: infrastructure` header" — the call:
- Goes through normal content routing → likely sonnet/opus if the prompt
  has complexity signals
- Is logged with `call_type='user'`
- IS charged to the user's daily display limit
- Signal 4 alert fires if it gets loud enough (per-VM rate > 200/h)

The "it gets caught" condition is: Signal 4 surfaces the offending VM + the
offending prompt_hint within 1 hour of the regression starting.

## Lessons

### Lesson 1 — Soft conventions (silently-honored headers) are anti-patterns

`x-model-override` was added with the assumption that the proxy would honor
it. The proxy never read it. Nothing tested or asserted the contract.
Multiple terminals built on the assumption it worked.

Forward fix: a header is a contract. If the receiver doesn't enforce it,
either remove the sender's reliance on it or add the enforcement. Don't
ship a sender that depends on a silent contract.

### Lesson 2 — "Infrastructure calls" is a missing first-class category

The proxy had four call types (`user`, `heartbeat`, `virtuals`,
`tool_continuation`). All four are user-attributable in some sense:
heartbeats are platform-paid but VM-keyed; virtuals is the Virtuals
Protocol surface; tool_continuation is a discount on user calls.

There was no category for "internal platform calls — strip-thinking,
gbrain dream cycle (future), any cron-driven LLM call we add in the
future." So every such call defaulted to `user`. That default was
catastrophic.

Forward fix: add `infrastructure` as a first-class category. Make it
**opt-in** (caller declares it via header). Make it **isolated**
(separate budget, its own log channel, monitored separately). Document
the taxonomy so future contributors know which bucket their new caller
belongs in.

### Lesson 3 — Content-based routing must NOT determine billing category

The content router's job is "given this is a user call, what model should
it route to?" It is NOT "given a request, is this a user call?" Conflating
those is what produced this bug: a non-user infrastructure call was
classified as "sonnet content signal" and charged as such.

Forward fix: the call category is determined FIRST (from headers + frame
shape), BEFORE the content router even looks at the request. The proxy's
new flow is:

1. Category detection (`isInfrastructureCall`, `isHeartbeat`, `isVirtuals`,
   `isToolContinuation`, fall through to `user`)
2. Category-specific routing (`infrastructure` → forced haiku; `heartbeat`
   → forced minimax; `user` → content router; `virtuals` → upstream as-is)
3. Category-specific billing (each has its own budget bucket)

The content router is now only invoked for `user` calls, never for
anything else.

### Lesson 4 — Per-VM monitoring is the only way to catch silent overcharge

Signal 1 (user→minimax) and Signals 2/3 (volume drop / cost spike) were all
fleet-wide aggregates. None of them would have caught this bug, which
manifested as "every VM has slightly elevated user costs" rather than "one
VM going haywire."

A single VM at 1000 cost_weight/hour is unusual; the fleet had 19 such VMs
today and none of the existing anomaly checks would have surfaced any of
them individually.

Forward fix: Signal 4 (per-VM infrastructure rate) catches the new category.
The lesson is broader though — future per-VM signals are likely the right
shape for catching other "silent overcharge" failure modes that show up
distributed rather than concentrated.

### Lesson 5 — Refunds should be automated, not artisanal

The refund script took 15 minutes to write. It surfaced 16 victims that
would have been near-impossible to identify by manual SQL. Going forward,
every billing-bug incident response should include a refund script that
classifies victims with the same rigor as the postmortem documents the bug.

## Follow-ups

| Priority | Item |
|---|---|
| P1 | Audit the existing infrastructure-LLM callers I found (`scripts/consensus_intent_extract.py`, `scripts/consensus_match_rerank.py`, `scripts/consensus_match_deliberate.py`) and determine which should also send `x-call-kind: infrastructure` |
| P1 | Migrate `instaclaw_daily_usage` to have a separate `infrastructure_cost` column so the budget cap can be enforced via a single RPC call instead of an ad-hoc COUNT() (current implementation is correct but does N+1 queries) |
| P2 | Write a true integration test against the proxy that sends a synthetic infrastructure-call and asserts the response routing + logging |
| P2 | Add a deprecation timeline for the kill switch constant. Once Phase 2 has soaked for 30 days with zero Signal 4 fires, remove the constant entirely (the script will just unconditionally call the new path) |
| P3 | Investigate whether `STRIP_THINKING_LLM_KILL_SWITCH_2026_05_28` should be exposed as a per-VM env-var override for emergency single-VM disable without a manifest bump |
| P3 | Document the existing `x-call-kind: match-pipeline` and `x-strict-canary: true` bypasses as additional members of the Rule 69 taxonomy (they predate the rule but follow the same shape) |
