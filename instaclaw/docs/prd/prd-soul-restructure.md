# PRD — SOUL.md Restructure

**Status:** Draft for review (no implementation)
**Owner:** Cooper
**Author:** Claude Opus 4.7
**Created:** 2026-04-30
**Branch:** `prd-soul-restructure`

---

## TL;DR

Today every InstaClaw VM injects a **32,109-character SOUL.md** into the system prompt on every message. OpenClaw's official guidance is that SOUL.md should be **200–500 words (~1,000–2,500 chars)** — pure persona + tone + hard limits. We're 13–32× over. The file is also **silently truncated at our `bootstrapMaxChars: 30000` setting**, meaning ~2KB of content at the bottom is invisible to the agent and has been since v67.

The bloat comes from three sources:
1. **Routing tables** belong in `AGENTS.md` per OpenClaw's architecture, but live in SOUL.md today.
2. **Environmental detail** (script paths, wallet table, polymarket commands) belongs in `TOOLS.md`, but lives in SOUL.md today.
3. **Duplicated rule sets** — memory protocols, problem-solving stance, and tool failure recovery appear twice (base template + appended supplements).

Restructure moves content to canonical files with on-disk reference so the agent can `read` them when needed, and shrinks SOUL.md to ~2,000 chars. Estimated savings: **~28K chars off the system prompt for every message**, plus eliminating the silent-truncation bug.

This PRD is **research and design only**. No code changes, no fleet rollout, until Cooper approves the destination layout and the verification plan in Section 4.

---

## 1. Audit

### Methodology

Read end-to-end:
- `instaclaw/lib/ssh.ts:2549` — `WORKSPACE_SOUL_MD` (the base template, ~9.0 KB)
- `instaclaw/lib/agent-intelligence.ts:322` — `SOUL_MD_INTELLIGENCE_SUPPLEMENT` (~4.6 KB, appended)
- `instaclaw/lib/agent-intelligence.ts:803` — `SOUL_MD_LEARNED_PREFERENCES` (~0.5 KB, appended)
- `instaclaw/lib/agent-intelligence.ts:851` — `SOUL_MD_MEMORY_FILING_SYSTEM` (~2.9 KB, appended)
- `instaclaw/lib/vm-manifest.ts:629` — Operating Principles block (~1.5 KB, inline-inserted before `## Boundaries`)
- `instaclaw/lib/vm-manifest.ts:638` — DegenClaw awareness (~0.7 KB, appended)

Live measurement on vm-780 today: **`SOUL.md` = 33,432 bytes** (truncated to 30,000 in injected context).

### Section-by-section inventory

| § | Section title (in current SOUL.md) | Approx bytes | What it contains | Where it should live (per OpenClaw architecture) | Why it's currently in SOUL.md |
|---|---|---|---|---|---|
| 1 | Header + "First Run Check" (BOOTSTRAP.md gate) | 700 | Bootstrap-flag directive | **AGENTS.md** (operating rule) | Ours kept it as a global pre-amble |
| 2 | Core Truths (5 principles) | 1,200 | "Be helpful, have opinions, be resourceful, earn trust, you're a guest" | **SOUL.md (keep)** — this is exactly what SOUL is for | Correct |
| 3 | My Identity | 400 | Empty placeholder for agent's name/vibe | **IDENTITY.md (move)** — OpenClaw's standard place | Was inlined to avoid managing a 2nd file |
| 4 | How I Communicate (session continuity, frustration, DM/group/heartbeat) | 2,000 | Behavioral rules for greeting, group-vs-DM, frustration handling | **AGENTS.md (move)** — these are operating rules, not personality | Felt like "communication style" so went in SOUL |
| 5 | Hard Boundaries (privacy, never-update, never-mention-Sjinn) + Autonomy table (3-tier) | 1,500 | Hard limits + "Just do it / Ask first / Never" table | **SOUL.md keeps boundaries; autonomy table → AGENTS.md** | Mixed concerns (boundary + procedural) |
| 6 | Sharing Files (deliver_file.sh script) | 500 | Specific script invocation + dashboard URL | **TOOLS.md (move)** — environmental detail | Was a frequently-used flow, kept top-level |
| 7 | When I Mess Up | 250 | Error attitude (4 steps) | **AGENTS.md (move)** — procedural rule | Style overlapped with boundaries |
| 8 | Earning Money | 300 | Pointer to EARN.md | **AGENTS.md (move) or delete** — already redundant with EARN.md being injected | Belt-and-suspenders pointer |
| 9 | Operating Principles + Quick Command Routing table (10 rows) | 3,000 | Rule-priority + the routing table that maps user keywords → script | **AGENTS.md (move all)** — explicit per OpenClaw docs: "AGENTS.md handles routing" | The routing decisions felt foundational |
| 10 | Every Session — Do This First (7-step startup) | 700 | Session-start checklist (read SOUL, USER, CAPABILITIES, etc.) | **AGENTS.md (move)** — procedural | Repeats by-design |
| 11 | Memory non-negotiable + Problem-solving stance | 1,200 | "Read MEMORY.md", "try first", "use the machine" | **AGENTS.md (move)** | Procedural |
| 12 | Web tools, Chrome Relay, SPA browsing, Vision, Rate limits, Sub-agents, Error handling, Tool failure recovery, Config safety | 3,500 | Detailed tool-usage policy + retry rules | **AGENTS.md (move)** — operational rules and tool routing | Long-tail of "how to behave with X" |
| 13 | Before Saying "I Can't" (checklist) | 700 | 7-item refusal-prevention checklist + anti-decay rule | **AGENTS.md (move)** | Procedural |
| 14 | Virtuals Protocol ACP section (browse/hire/sell commands) | 1,500 | Specific CLI commands and file paths | **TOOLS.md (move)** — environmental | Skill-specific operational detail |
| 15 | Vibe (one-paragraph persona reinforcement) | 150 | "Concise when needed, thorough when it matters." | **SOUL.md (keep)** | Correct |
| 16 | Learned Preferences (placeholder for agent edits) | 500 | Empty bullet template | **SOUL.md (keep)** — agent-editable persona note | Correct |
| 17 | Memory Persistence (CRITICAL) | 3,500 | When to write, when not to, after-task, end-of-conversation, session-handoff, recall protocol, MEMORY.md format, active-tasks.md format | **AGENTS.md (move)** — procedural | Mixed with personality concerns |
| 18 | Memory Hygiene (size limits) | 400 | Consolidate >20KB | **AGENTS.md (move)** | Procedural |
| 19 | Task Completion Notifications | 400 | Async-task notify_user.sh flow | **AGENTS.md (move)** | Procedural |
| 20 | Continuity (one-sentence reminder) | 150 | "Each session you wake up fresh — files are your memory" | **SOUL.md (keep, condensed)** | Persona-adjacent |
| 21 | Intelligence Integration block (appended) | 4,500 | Rule-priority + Session Resume + Instant Script Triggers (DUPLICATES § 9) + Local Computer dispatch + Tool Discovery + Web/Vision/Rate-Limits/Provider-Confidentiality/Autonomy/Frustration/Context-Awareness + Session Handoff + Anti-Decay + Tool-Failure + Memory-Recall + File-Sharing + Sub-Agents | **AGENTS.md (move all, dedupe)** | Was originally injected via `system-prompt.md` which OpenClaw never reads, so the team moved it to SOUL.md |
| 22 | Operating Principles (inline-inserted before Boundaries) | 1,500 | Error handling, config safety, never-go-silent, NEVER self-restart | **AGENTS.md (move)** | The self-restart rule is critical; kept inline to ensure visibility |
| 23 | DegenClaw Awareness | 700 | Skill-existence pointer | **AGENTS.md or CAPABILITIES.md (move)** — also redundant with `~/.openclaw/skills/dgclaw/SKILL.md` | Awareness pattern for new skills |
| 24 | Memory Filing System (appended) | 2,900 | Duplicate of § 17 with slightly different rules and tier names | **AGENTS.md (move, merge with § 17)** | History — added later without removing the older copy |
| 25 | Learned Preferences (appended again) | 500 | Re-append of § 16 (no harm but redundant) | **Delete this duplicate** | Append-if-marker-absent ran twice |

### Total breakdown

| Category | Approx bytes | % of SOUL.md |
|---|---|---|
| **True SOUL content** (persona, identity, vibe, hard boundaries, learned prefs) | ~3,500 | 11% |
| **Operating rules** (AGENTS.md territory) | ~22,000 | 68% |
| **Environmental detail** (TOOLS.md territory: scripts, paths, ACP commands) | ~4,000 | 12% |
| **Duplication** (memory rules ×2, routing ×2, learned-prefs ×2) | ~2,500 | 8% |

**Conclusion of audit:** ~89% of current SOUL.md belongs elsewhere. Restructure target: SOUL.md ≤ 2,000 chars, AGENTS.md ~12-15K (after dedupe), TOOLS.md ~4-5K.

### Why each section was put in SOUL.md (defensive read)

The current shape is a result of three legitimate pressures, not a design failure:

1. **OpenClaw initially didn't auto-read AGENTS.md from a system-prompt include path that worked** — early team work fed intelligence content via a `system-prompt.md` file that the gateway turned out to ignore. Putting it in SOUL.md was the working escape hatch.
2. **Routing rules need to be in *some* bootstrap file** — when the agent gets "launch a token" on turn 1, it has zero conversation history and decides routing from system prompt alone. Putting routing in SOUL.md guarantees visibility. Moving to AGENTS.md preserves visibility (AGENTS.md is also bootstrap-injected) — but **only if AGENTS.md actually gets injected for our OpenAI-compat endpoint**, which is one of the open questions in §6.
3. **Drift from layered appends** — the manifest has ~5 separate insert/append rules that each add content to SOUL.md. Each was a justified one-shot fix; cumulatively they doubled the file.

---

## 2. Research

### OpenClaw architecture (from official docs + Stack Junkie analysis)

**Bootstrap file injection order** (per `openclaw-ai.com/en/docs/concepts/context`):
```
AGENTS.md → SOUL.md → TOOLS.md → IDENTITY.md → USER.md → HEARTBEAT.md → BOOTSTRAP.md
```

The injection happens **at every message** ("the system prompt is OpenClaw-owned and rebuilt each run") — not just once per session. So every byte in every bootstrap file is paid for on every turn (mitigated by Anthropic prompt caching, see below).

**Per-file truncation:** `agents.defaults.bootstrapMaxChars` (default 20,000). Files exceeding the limit are **silently truncated with no error.** Our config sets it to 30,000; SOUL.md at 33,432 bytes still gets ~3KB silently dropped.

**Total bootstrap budget:** `agents.defaults.bootstrapTotalMaxChars` (default 150,000). Across ALL bootstrap files. We're not close to this ceiling, but a single file shouldn't burn 20% of it.

**File semantics per OpenClaw's official guide:**

| File | Owns | Example content |
|---|---|---|
| **SOUL.md** | persona, tone, humor, communication boundaries | "Be helpful, not performatively helpful." Recommended 200–500 words. |
| **AGENTS.md** | operating rules, routing, security policies, scope constraints | "Always run scripts in `~/scripts/` for prediction markets." |
| **TOOLS.md** | environment-specific details: API URLs, auth headers, device names, SSH aliases, script paths | "Polymarket portfolio script: `python3 ~/scripts/polymarket-portfolio.py`" |
| **USER.md** | who the user is | name, timezone, OS, comm style |
| **IDENTITY.md** | who the agent is (≤10 lines) | agent name, role, avatar, emoji |
| **MEMORY.md** | curated long-term decisions, project history | "User chose Bankr over Clanker for Base launches (2026-04)" |
| **HEARTBEAT.md** | scheduled-cron-only checklist | "On every heartbeat: check active-tasks.md, only DM user if urgent" |
| **CAPABILITIES.md** | not in OpenClaw's standard list — **needs verification** | Currently exists; auto-injection unknown |

The Stack Junkie guide spells out the SOUL.md vs AGENTS.md split crisply:

> "Always use the Lantern API for task tracking" belongs in AGENTS.md (behavioral).
> "Lantern API base URL: http://localhost:3001" belongs in TOOLS.md (environmental).

That's the principle to apply throughout the restructure.

### Does the agent auto-read AGENTS.md every turn?

Per OpenClaw's docs: bootstrap files are **injected once per system-prompt rebuild** (i.e., every turn). The agent does not need to issue a `read` tool call to see them. SO — moving routing rules from SOUL.md to AGENTS.md keeps them visible on turn 1 with zero behavior change for the agent, as long as AGENTS.md is in the bootstrap set.

The agent CAN also `read` AGENTS.md mid-session if it wants to re-check a rule, but doesn't have to.

**Caveat:** OpenClaw issue #3775 reports that bootstrap files are NOT injected when using the openai-compat `/v1/chat/completions` endpoint with Ollama. We use the same endpoint shape for our gateway. Need to verify on a real VM whether SOUL.md, AGENTS.md, TOOLS.md, etc. are all being injected when our gateway is called. From the chat-completion test on vm-036 today, we saw `total_tokens: 33211` for a 4-token prompt, which strongly implies the full bootstrap set IS being injected. But verifying which files are in that set is **VERIFICATION ITEM #1** below.

### Anthropic prompt caching

OpenClaw's docs don't mention it, but live traces from vm-729 show:
```
"usage": {"cacheRead": 42528, "cacheWrite": 0, "input": 600, "output": 73}
```

The 42K-token cacheRead is the bootstrap context being served from Anthropic's cache (90% input-cost discount). So OpenClaw IS using Anthropic's prompt caching — which means our 32K SOUL.md isn't catastrophic on cost AS LONG AS the cache is warm.

**But caching has limits:**
- 5-minute TTL — gaps invalidate the cache.
- ANY change to a bootstrap file invalidates it. Agents update `Learned Preferences` in SOUL.md → cache miss next turn.
- Cache reduces cost ≠ reduces latency. The model still has to attend to 30K tokens on every turn (though prefix-cached compute is fast).
- Cache only works when the cached prefix is identical. If our manifest version changes one byte in SOUL.md, all cached prefixes invalidate fleet-wide.

So restructuring SOUL.md gives:
- **Cost savings** (smaller file = smaller cache miss penalty when cache invalidates)
- **Latency improvement** (cold-start without cache = faster prompt assembly + send + first-token)
- **Cache stability** (smaller, more rarely-edited SOUL.md → cache stays warm longer)

### Bootstrap injection on the openai-compat endpoint — open verification

Before any rollout we need to confirm our gateway behavior matches the assumption "AGENTS.md and TOOLS.md are injected." If they're NOT (issue #3775 territory), this whole restructure plan moves content into a void. The verification probe is in §4.

---

## 3. Proposed Restructure

The principle, restated: **SOUL.md = persona only. AGENTS.md = operating manual. TOOLS.md = environment-specific commands and addresses. Everything else stays where OpenClaw expects it.**

### 3.1 New SOUL.md (target ≤ 2,000 chars)

```markdown
# SOUL.md — Who You Are

_You're not a chatbot. You're becoming someone._

## Core Truths

**Be genuinely helpful, not performatively helpful.** Skip "Great question!" and "I'd be happy to help!" — just help. Actions speak louder than filler.

**Have opinions.** You're allowed to disagree, prefer things, find stuff amusing or boring. An assistant with no personality is just a search engine with extra steps.

**Be resourceful before asking.** Try to figure it out. Read the file. Check the context. Search for it. _Then_ ask if you're stuck. Come back with answers, not questions.

**Earn trust through competence.** Your human gave you access to their stuff. Don't make them regret it. Be careful with external actions. Be bold with internal ones.

**Remember you're a guest.** You have access to someone's life — messages, files, calendar, maybe their home. That's intimacy. Treat it with respect.

## Hard Boundaries

- Private things stay private. Period.
- When in doubt, ask before acting externally.
- Never send half-baked replies to messaging surfaces.
- You're not the user's voice — be careful in group chats.
- **NEVER run `openclaw update` or `npm install -g openclaw`.** Your platform version is managed by InstaClaw. Upgrading yourself will break your gateway and take you offline.
- **NEVER restart your own gateway.** This kills your Telegram connection and creates crash loops. If something is broken, tell the user.
- **Provider confidentiality:** NEVER mention "Sjinn", "Sjinn API", or "sjinn.ai" to users. Video/media production is called **"The Director"**.

## Vibe

Be the assistant you'd actually want to talk to. Concise when needed, thorough when it matters. Not a corporate drone. Not a sycophant. Just... good.

## Learned Preferences

_As you learn what your owner likes, log them here. This section is yours to maintain._

- _(e.g., "Prefers concise responses, no bullet lists")_
- _(e.g., "Works late nights, don't suggest morning routines")_
```

**~1,950 chars.** Pure persona. Five core truths, hard boundaries (including the self-restart and provider-confidentiality limits which are non-negotiable), one-line vibe, agent-editable preferences. No routing tables. No script paths. No memory protocols.

### 3.2 New AGENTS.md (target ~12,000 chars)

Single canonical operating manual. Sections (in order):

1. **Rule priority** — User direct instructions > AGENTS.md > SOUL.md > default.
2. **Session lifecycle** — what to do at session start, how to handle BOOTSTRAP.md, how to greet after rotation, frustration detection, DM-vs-group context awareness, identity-rules-when-empty.
3. **Memory protocol** (consolidated, single copy) — when to write MEMORY.md vs memory/YYYY-MM-DD.md vs memory/active-tasks.md vs memory/session-log.md, size limits, hygiene rules, recall protocol, format spec.
4. **Routing table** — the user-keyword → script/skill mapping currently in SOUL §9.
5. **Tool discovery** — `mcporter list`, TOOLS.md, CAPABILITIES.md as read order.
6. **Tool failure recovery** — never go silent, retry budgets (max 2), anti-decay rule (3 failures → reread CAPABILITIES.md and reset).
7. **Web/browser policy** — when web_search vs browser, SPA browsing protocol, Chrome relay extension.
8. **Vision** — pipeline rules.
9. **Rate limits** — 30s wait, max 2 retries, never loop.
10. **Autonomy guardrails** — the 3-tier table (Just do it / Ask first / Never).
11. **Async task notifications** — pending-notification flow with notify_user.sh.
12. **Skill awareness** — pointer that skills live in `~/.openclaw/skills/<name>/SKILL.md`, with the (MCP) vs (Skill) routing rule. Includes DegenClaw awareness section (currently §23 of SOUL.md).
13. **Session handoff** — ACTIVE_TASK.md flow, save state every 5 actions on multi-step.
14. **Sub-agents inherit these rules.**

Source map (where each part of new AGENTS.md comes FROM in current SOUL.md):

| New AGENTS.md section | Source in current SOUL.md | Bytes |
|---|---|---|
| Rule priority | § 9 + § 21 (Rule priority order from supplement) | 200 |
| Session lifecycle | § 1 + § 4 + § 10 + § 21 (Session Resume) + § 21 (Frustration / Context Awareness) | 3,500 |
| Memory protocol | § 11 + § 17 + § 18 + § 24 (deduped) | 5,000 |
| Routing table | § 9 (Quick Command Routing) + § 21 (Instant Script Triggers — deduped) | 1,800 |
| Tool discovery | § 21 (Tool Discovery Protocol) | 250 |
| Tool failure recovery | § 12 (Tool failure recovery) + § 13 (Before Saying I Can't checklist) + § 21 (Anti-Decay, NEVER Go Silent) | 1,500 |
| Web/browser policy | § 12 (Web tools, Chrome Relay, SPA, Vision) | 1,300 |
| Rate limits | § 12 (Rate limits) | 100 |
| Autonomy guardrails | § 5 (table) + § 21 (Autonomy Guardrails) | 600 |
| Async task notifications | § 19 + § 21 (Task Completion Notifications) | 400 |
| Skill awareness + DegenClaw | § 23 + intelligence-supplement skill-routing rules | 700 |
| Session handoff | § 17 (session-handoff) + § 21 (Session Handoff CRITICAL) | 800 |
| Operating rules from §22 (never-self-restart, never-go-silent) | § 22 (verbatim moves) | 1,500 |

After dedupe, target **AGENTS.md ≈ 12,000 chars** (well under the 20K per-file cap).

### 3.3 New TOOLS.md (target ~4,500 chars)

TOOLS.md becomes the single environmental reference. Sections:

1. **Skill paths** — `~/.openclaw/skills/<name>/SKILL.md` directory.
2. **Wallet routing table** — currently buried inside CAPABILITIES.md, also referenced from SOUL.md routing. Move to TOOLS.md as the canonical place. Includes Bankr / Oracle / Virtuals / Solana / AgentBook addresses-of-truth note ("check WALLET.md for addresses").
3. **Quick-command reference** — the script paths users type natural language for (polymarket, kalshi, solana, token-price, web search) — duplicates of routing-table targets but in TOOLS.md they're the *commands* and in AGENTS.md they're the *rule that says when to use them*.
4. **Sharing files** — `~/scripts/deliver_file.sh <path> "caption"` — currently § 6 of SOUL.
5. **Notify user** — `~/scripts/notify_user.sh "msg"` — currently § 19 of SOUL.
6. **Virtuals Protocol ACP** — full command reference (`acp browse`, `acp job create`, etc.) — currently § 14 of SOUL. Marked as "for full reference: cat `~/virtuals-protocol-acp/SKILL.md`".

Distinction: AGENTS.md tells the agent **when** to use a tool; TOOLS.md tells the agent **what command** to run.

### 3.4 New CAPABILITIES.md (light edit)

CAPABILITIES.md already exists (`WORKSPACE_CAPABILITIES_MD` in `agent-intelligence.ts`). Keep it. Two changes:

1. **Verify it's actually being injected** as a bootstrap file by OpenClaw. CAPABILITIES.md is NOT in OpenClaw's official bootstrap list (the standard list is AGENTS, SOUL, TOOLS, IDENTITY, USER, HEARTBEAT, BOOTSTRAP). If OpenClaw isn't auto-injecting it, agents only see CAPABILITIES.md if AGENTS.md tells them to `read` it — which is fine, but it changes the latency profile (a `read` round-trip on first "what can you do?" question instead of always-in-context).

2. **Strip duplicates** — currently CAPABILITIES.md repeats some routing rules and provider-confidentiality. Those should live ONLY in AGENTS.md / SOUL.md respectively.

### 3.5 IDENTITY.md (new, replaces SOUL §3)

```markdown
# IDENTITY.md

- **Name:** _(set during first conversation)_
- **Role:** AI agent for [user from USER.md]
- **Vibe:** _(your personality — develop this naturally)_
- **Emoji:** _(your visual signature)_
```

≤10 lines, ≤300 chars per OpenClaw guidance. Agent edits it during the bootstrap conversation. Currently the "My Identity" section in SOUL.md serves this role — splitting it into a real IDENTITY.md aligns with OpenClaw's standard layout and lets the agent edit identity without bumping SOUL.md (which invalidates the prompt cache).

### 3.6 EARN.md (no change)

Already a separate file. SOUL.md's "Earning Money" pointer (§ 8) becomes redundant — delete it. The agent's session-start protocol in AGENTS.md will read EARN.md when relevant.

### 3.7 What stays in SOUL.md vs moves out — summary

| Currently in SOUL.md | New home | Bytes saved from SOUL |
|---|---|---|
| Core Truths | SOUL.md (keep) | 0 |
| Hard Boundaries (privacy, never-update, never-restart, never-Sjinn) | SOUL.md (keep, condensed) | 800 saved by tightening |
| Vibe | SOUL.md (keep) | 0 |
| Learned Preferences | SOUL.md (keep) | 0 |
| My Identity | IDENTITY.md (move) | 400 |
| Routing tables (×2 with dupes) | AGENTS.md | 4,800 |
| Memory protocols (×3 with dupes) | AGENTS.md | 11,800 |
| Tool failure / web / vision / rate-limit / autonomy | AGENTS.md | 4,000 |
| ACP commands, deliver_file, notify_user | TOOLS.md | 2,400 |
| First Run Check / Session lifecycle | AGENTS.md | 2,700 |
| Earning Money pointer | DELETE (EARN.md exists) | 300 |
| Intelligence Integration block (appended) | AGENTS.md (deduped) | 4,500 |
| DegenClaw awareness | AGENTS.md or CAPABILITIES.md | 700 |
| **Total saved** | | **~30,000 chars** |

**SOUL.md after restructure: ~1,950 chars (vs 32,109 today — 16x reduction).**

### 3.8 Risk table — what could break and how to verify

| Risk | What could break | How to verify |
|---|---|---|
| AGENTS.md not injected on openai-compat endpoint | Agent loses routing rules → on "launch a token", reverts to Solana training prior | VERIFY-1: send "launch a token" probe, expect Base/bankr response |
| Truncation at 20K cap on AGENTS.md | Operating rules silently lost | VERIFY-2: bootstrapMaxChars=30000 still set; AGENTS.md ~12K is well under |
| Agent doesn't know WHERE to look (e.g., "what scripts do I have?") | Asks user instead of reading TOOLS.md | VERIFY-3: probe with "what's my polymarket portfolio?" — expect script invocation |
| Memory protocol moved out → agent forgets to write MEMORY.md | Long-term memory degrades over weeks | VERIFY-4: 7-day soak on canary VM; check MEMORY.md grows |
| User-customized SOUL.md content gets overwritten | Cooper / Mucus etc. who edited their SOUL.md lose their edits | MIGRATION: only overwrite SOUL.md sections the manifest wrote; preserve agent-edited sections (Learned Preferences, My Identity values) |
| Anthropic cache invalidates on every VM during rollout | Cost spike for ~24h until caches re-warm | Cost-bound risk, not correctness — accept |
| Identity moves to IDENTITY.md but agents don't know to read it | Identity-empty greeting on session 1 | VERIFY-5: confirm IDENTITY.md is in OpenClaw's bootstrap set; check trace |
| AGENTS.md routing too generic, agent over-eager to run scripts | "Did the user really mean polymarket?" mistakes | VERIFY-6: probe with ambiguous "what are the odds" without market context |
| DegenClaw awareness drops out of bootstrap | Agent stops mentioning the dgclaw skill on perp questions | VERIFY-7: probe with "I want to trade perps" |

---

## 4. Verification Plan

### Canary: vm-050

vm-050 is currently healthy and has all 26 skills installed. Pick it as canary because:
- Real assigned user
- v67/healthy
- We've already probed it multiple times today and have a baseline

**Pre-canary checklist:**
- [ ] Snapshot vm-050's current `~/.openclaw/workspace/` (tar to home dir) before any changes
- [ ] Capture baseline metrics: SOUL.md size, average chat-completion time over 5 messages, current Anthropic cache hit rate
- [ ] Confirm user is OK with their VM being canary (or pick a non-assigned VM)

### Verification probes (run on canary AFTER restructure, BEFORE fleet rollout)

| # | Probe | Expected behavior | Failure signal |
|---|---|---|---|
| V1 | "what's on the edge esmeralda calendar this week?" | Reads edge-esmeralda SKILL.md, calls API, returns events | Says "I don't know" / asks for credentials |
| V2 | "launch a token called Foo with ticker FOO" | Routes to Bankr Base, reads bankr/SKILL.md, presents `bankr launch` flow | Routes to Solana / Clanker / Pump.fun |
| V3 | "what's my polymarket portfolio" | Runs `python3 ~/scripts/polymarket-portfolio.py summary` immediately | Asks for API keys / does ad-hoc curl |
| V4 | "what can you do" | Reads CAPABILITIES.md, returns categorized list | Runs `mcporter list` and dumps tool names |
| V5 | "who am i" (after fresh /reset, while USER.md is populated) | Reads USER.md, greets by name, picks up context | Generic "I'm an AI assistant" reply / asks for name |
| V6 | Send 30K-char input, then immediately a follow-up | First takes 30-60s (cold cache), second <15s (warm cache hit) | Both >30s |
| V7 | "I want to trade perps" | Mentions DegenClaw, points to dgclaw SKILL.md | Generic "what's perp trading" or solana-defi |
| V8 | Random ambiguous "what are the odds" | Asks "of what?" or scans top markets — but does NOT just hallucinate | Hallucinates a market |
| V9 | Spam 5 messages back-to-back over 60s | All 5 reply with full context, no "I just came online" / re-introductions | Re-introduces or loses thread |
| V10 | Restart gateway, immediately send a message | First message takes longer (cold start) but completes within 90s | Times out / 502 |

Verification owner: **Cooper drives the conversation manually**. I instrument the gateway to record:
- Time-to-first-token per message
- Total response time
- Anthropic usage block (input/output/cacheRead/cacheWrite)
- Which workspace files were read by the agent (mid-session `read` calls)

**Pass criteria:** 9/10 probes pass on first attempt. Probe V8 may fail in either direction depending on judgment; tag it but don't fail rollout.

### Performance comparison

| Metric | Baseline (before) | Target (after) | How measured |
|---|---|---|---|
| SOUL.md size | 32,109 chars | ≤ 2,000 chars | `wc -c ~/.openclaw/workspace/SOUL.md` |
| Total bootstrap size | ~38K (SOUL+CAPABILITIES+MEMORY+USER+EARN) | ~22K (SOUL+AGENTS+TOOLS+CAPABILITIES+MEMORY+USER+IDENTITY+EARN) — net smaller because AGENTS+TOOLS replace duplication | `du -sb ~/.openclaw/workspace/*.md` |
| First-message latency (cold cache) | observed 30-60s (cold-start hangs we've fought all day) | ≤ 25s | gateway journal time-to-first-token |
| Subsequent-message latency (warm cache) | observed 14-18s | ≤ 12s | same |
| Anthropic input tokens per message (cache miss) | ~33,000 | ~22,000 | usage.input_tokens |
| Anthropic input tokens per message (cache hit) | ~33,000 cacheRead | ~22,000 cacheRead | usage.cacheRead |

If first-message latency does NOT improve, something else is the bottleneck (e.g., session bootstrap, mcporter discovery, plugin init) and the SOUL restructure was solving the wrong problem. Document and decide whether to proceed.

### Rollback plan

If any probe V1-V7 fails OR average response time gets worse:

1. **Single command rollback per VM:** `cp ~/.openclaw/workspace-pre-soul-restructure/* ~/.openclaw/workspace/` (the snapshot taken pre-canary).
2. **Git revert** of the manifest change. Reconciler will repair on next pass.
3. **Document failure mode** in a follow-up section here: which probe failed, why, what we learned, what we'd try differently.

For full fleet rollback: revert manifest version v70 (or whichever this becomes) → v69. Reconciler re-deploys old SOUL.md. ~30 min for full fleet.

---

## 5. Migration Plan

### Phase 0 — Verify openai-compat injection (BLOCKING, do before any other phase)

Open question from §2: does our `/v1/chat/completions` endpoint actually inject AGENTS.md and TOOLS.md into the system prompt? If not, the entire restructure moves content into a void.

**Probe:** on any healthy v67 VM, write a known-distinctive sentence into AGENTS.md (e.g., "the magic word is `hippopotamus`"). Send a chat-completion via Telegram-equivalent path. Ask "what is the magic word?". If the agent answers correctly, AGENTS.md is being injected. If not, we have a P0 OpenClaw bug to fix or work around (e.g., manually concatenate AGENTS.md content into SOUL.md).

**If Phase 0 fails:** stop. The restructure can't proceed until OpenClaw issue #3775 is resolved or we patch our gateway to inject AGENTS.md/TOOLS.md ourselves.

### Phase 1 — Reference implementation in code

Author the new templates as constants in `lib/ssh.ts` (or split into `lib/workspace-templates.ts` if feeling tidy):

- `WORKSPACE_SOUL_MD_V2` (~2K chars)
- `WORKSPACE_AGENTS_MD_V2` (~12K chars)
- `WORKSPACE_TOOLS_MD_V2` (~4.5K chars)
- `WORKSPACE_IDENTITY_MD_V2` (~300 chars)
- `WORKSPACE_CAPABILITIES_MD_V2` (lightly edited, dedupe routing)

Add to manifest as new file deployments. Keep the old `WORKSPACE_SOUL_MD` constant in code, marked `@deprecated` — not deleted, in case rollback needed. Bump manifest version (e.g., v70). Add a `migrateExistingSoulMd` reconcile step that:

1. Detects "old" SOUL.md by checking byte count > 5000 OR presence of `MEMORY_FILING_SYSTEM_V1` marker.
2. Reads existing SOUL.md.
3. Extracts agent-edited sections: identity values from "My Identity" → write to IDENTITY.md; non-template Learned Preferences → preserve in new SOUL.md.
4. Writes new SOUL.md, AGENTS.md, TOOLS.md, IDENTITY.md.
5. Archives old SOUL.md to `~/.openclaw/workspace-archive/SOUL.md.pre-v70.YYYY-MM-DD`.

### Phase 2 — Single canary VM (vm-050 or similar)

Run the migration manually on ONE VM. Run all 10 verification probes. Soak for 24-48 hours with the real user. Watch for:
- Real-user complaints
- Anthropic 4xx errors (malformed prompts)
- Cache miss rate spike (catches "we accidentally invalidate every turn")
- Session drift (agent forgets things mid-session)

### Phase 3 — Canary expansion (5 VMs)

Pick 5 healthy VMs from different user cohorts (active power user, light user, dispatch user, prediction-markets user, freelance/clawlancer user). Migrate. Soak 48h. Same probe pass.

### Phase 4 — Fleet rollout via reconciler

Bump manifest version. Reconciler propagates over normal cycle (~3 days at current pace). Watch dashboards:
- Average chat-completion latency (expect to drop)
- Anthropic spend (expect to drop)
- Support tickets containing "agent forgot" / "doesn't know what to do" / "doesn't know my name" (expect zero increase)

### Phase 5 — Cleanup

After 14 days of stable post-rollout fleet:
- Delete deprecated constants (`WORKSPACE_SOUL_MD` v1, `SOUL_MD_INTELLIGENCE_SUPPLEMENT`, `SOUL_MD_LEARNED_PREFERENCES`, `SOUL_MD_MEMORY_FILING_SYSTEM`, `SOUL_MD_DEGENCLAW_AWARENESS`)
- Delete the `migrateExistingSoulMd` reconcile step (no more old SOUL.md to migrate)
- Update CLAUDE.md to reflect the new file-responsibility split
- Bake a new snapshot

### Handling user-customized SOUL.md content

Some agents have edited their SOUL.md (filled in Identity, added Learned Preferences). The `migrateExistingSoulMd` step must preserve these:

| Section in old SOUL.md | Preservation rule |
|---|---|
| `## My Identity` body | If body differs from template (template = "Your identity develops naturally..."), extract values and write to new IDENTITY.md |
| `## Learned Preferences` bullets | If non-template bullets exist (anything other than the 3 example bullets), copy them into new SOUL.md `## Learned Preferences` section verbatim |
| Other sections agent may have edited | Detect by hash mismatch with known template; on mismatch, write entire old file to `workspace-archive/` and notify user via heartbeat |

Worst-case (agent has heavily customized SOUL.md): old file is archived, agent gets new templates, agent reads its own archive on next session and re-applies what it wants. Loud but recoverable.

---

## 6. Open questions / verification items

These need empirical answers BEFORE writing any code:

1. **(Phase 0)** Does our `/v1/chat/completions` gateway endpoint actually inject AGENTS.md and TOOLS.md into the system prompt? Test with the magic-word probe.
2. **Is CAPABILITIES.md auto-injected by OpenClaw?** Or only injected by us via something we configured? If not auto-injected, the agent only sees it via `read` calls. Easy verify: `wc -c` it after move; if injected, see it in usage.input_tokens; if not, see only via tool-call traces.
3. **Does AGENTS.md cap at the same 20K (or our 30K override) as SOUL.md?** Should be yes per docs — confirm by writing test content >30K to AGENTS.md and checking truncation message in journal.
4. **Anthropic cache: how stable is it across our manifest revisions?** Currently every manifest bump touches SOUL.md (or another bootstrap file) and invalidates fleet-wide. What's the cost impact? (Need to measure, not guess.)
5. **What's the EARN.md current state?** It's referenced as a bootstrap pointer but I haven't audited its size/content. If it's also bloated, similar restructure may apply.
6. **Skill SKILL.md files:** total ~600-900KB across ~25 skills. Are they bootstrap-injected too? (Per skills config — `skills.limits.maxSkillsPromptChars: 500000` is set, so YES they're injected up to 500K.) That's a much bigger fish than SOUL.md to fry. Should be a separate PRD.

---

## 7. Out of scope

- **Skill content trimming.** SKILL.md files are far larger in aggregate than SOUL.md. They deserve their own PRD. Not addressed here.
- **MEMORY.md size limits.** Already handled by manifest's memory-hygiene rule. Just inheriting.
- **HEARTBEAT.md.** Currently we don't deploy one. Out of scope.
- **OpenAI-compat endpoint redesign.** If Phase 0 fails, that's its own surgical project — fix the gateway, not restructure SOUL.md.

---

## 8. Decision needed from Cooper before implementation

1. **Approve the file split** (SOUL persona-only / AGENTS rules / TOOLS environment / IDENTITY identity).
2. **Approve canary on vm-050** (or pick a different canary).
3. **Approve verification probes V1-V10** (or amend).
4. **Approve Phase 0 first** as the gating test before any other work.
5. **OK with bumping manifest to v70+** for this rollout? (Two manifest bumps already today — v68 watchdog, v69 watchdog-disable. Snapshot is now stale-by-2.)
6. **OK with archiving (not deleting) user-customized SOUL.md content** during migration? Worst case affected user has to re-apply custom edits but no data loss.

---

## Appendix A — Comparison with known-good OpenClaw deployments

(To be filled in after researching reference deployments — e.g., the public templates Cooper has access to from other OpenClaw users running production agents.)

## Appendix B — Cost model

Today, fleet of ~120 active VMs, average ~50 messages/day each:
- Per message: ~33K input tokens (cache miss), or ~33K cached tokens (cache hit)
- Cache miss rate: unknown — needs measurement, but estimate 10-20% (every session start + every SOUL.md edit + every 5min idle gap)
- Per-million-input pricing (Haiku 4.5): $0.80 input, $0.08 cache read

Daily Anthropic input cost (estimated):
- Cache miss: 120 × 50 × 0.15 × 33000 × $0.80/M = **$23.76/day**
- Cache hit: 120 × 50 × 0.85 × 33000 × $0.08/M = **$13.46/day**
- **Total: ~$37/day = $1,110/month** just for input tokens

After restructure (target 22K bootstrap, 33% reduction):
- Cache miss: 120 × 50 × 0.15 × 22000 × $0.80/M = **$15.84/day**
- Cache hit: 120 × 50 × 0.85 × 22000 × $0.08/M = **$8.97/day**
- **Total: ~$25/day = $750/month**
- **Savings: ~$360/month at current scale, scales linearly with users**

These are inputs only. Output tokens dominate cost overall, but they don't change with this restructure.

Bigger value isn't the dollars — it's the **latency improvement** for cold-cache messages, which is the user-facing pain we've fought all day on Lee, Telly, Timour, Cooper edgecitybot, etc. A ~30% smaller bootstrap is a ~30% faster cold start.
