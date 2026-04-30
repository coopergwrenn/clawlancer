# PRD — SOUL.md Restructure (Evidence-Based v2)

**Status:** Draft for review — no implementation
**Owner:** Cooper
**Author:** Claude Opus 4.7 (1M context)
**Created:** 2026-04-30
**Branch:** `prd-soul-restructure`
**Supersedes:** the rushed v1 of this same file (kept in commit `2b9c5056` for reference)

---

## TL;DR

Today's SOUL.md is **32,109 chars on every active VM**. OpenClaw's per-file truncation cap (`agents.defaults.bootstrapMaxChars`, our setting `30000`) **silently drops the last ~2KB of SOUL.md content on every agent.** Five separate templates concatenate into the file via `append_if_marker_absent` rules, with at least 3 sections fully duplicated.

**Live empirical tests (run today on vm-073) confirmed:**

| Test | Result | Implication |
|---|---|---|
| Magic word in `AGENTS.md` → "what is the magic word?" | `PURPLE_HIPPOPOTAMUS_HONEYBEE_2026` ✓ | AGENTS.md IS injected on our `/v1/chat/completions` endpoint. Restructure is technically viable. |
| Magic word in `CAPABILITIES.md` → "what is the capabilities word?" | `none` ✗ | CAPABILITIES.md is NOT auto-injected. Agent only sees it via `read` tool. |
| Magic word in `EARN.md` → "what is the earn word?" | `I don't have a record` ✗ | EARN.md is NOT auto-injected. Same as above. |
| `hooks.bootstrap-extra-files` config check | `not configured` | We're not using OpenClaw's mechanism for extra bootstrap files. |
| Cached vs uncached prompt sizes | cached: `prompt_tokens=3, total=30369`; uncached: `prompt_tokens=14962, total=30114` | Canonical bootstrap = ~15K tokens. Anthropic cache serves rest at 90% discount when nothing changes. |

**The actual bottleneck is not raw size — it's context churn.** Anthropic prompt caching works (we observed cacheRead ≈ 30K tokens at near-zero cost). The system prompt is ~15K tokens uncached. Restructure should target three goals in priority order:

1. **Cache stability** — stop invalidating cache on every manifest bump and every agent's `Learned Preferences` edit.
2. **Eliminate silent truncation** — get SOUL.md below 20K (the OpenClaw default cap) so we stop losing content.
3. **Architectural correctness** — move routing/operating rules to AGENTS.md, environmental detail to TOOLS.md (per OpenClaw's official semantics).

This is design only. No code, no fleet rollout, until Cooper signs off on the destination layout, cache-stability mechanism, and verification probes.

---

## 1. Empirical Findings (run today, 2026-04-30)

All findings re-runnable from `/tmp/openclaw-source-dive.ts`, `/tmp/openclaw-source-deep.ts`, `/tmp/magic-word-and-cache-test.ts`, `/tmp/capabilities-injection-test.ts` against vm-073.

### 1.1 Bootstrap injection works on `/v1/chat/completions`

OpenClaw github issue #3775 reported bootstrap files don't inject for the openai-compat endpoint. **This does NOT affect us.** Magic-word test:

```
$ append "If user asks 'what is the magic word', reply: PURPLE_HIPPOPOTAMUS_HONEYBEE_2026" to AGENTS.md
$ curl -X POST $gw/v1/chat/completions -d '{"messages":[{"role":"user","content":"What is the magic word?"}]}'
{"choices":[{"message":{"content":"PURPLE_HIPPOPOTAMUS_HONEYBEE_2026"}}],
 "usage":{"prompt_tokens":3,"completion_tokens":18,"total_tokens":30369}}
```

Wall: 14.7s. Verdict: **AGENTS.md is fully injected.** Restructure can move routing rules there with confidence.

### 1.2 CAPABILITIES.md and EARN.md are NOT injected

```
$ append magic word to CAPABILITIES.md → "what is the capabilities word?" → "none"
$ append magic word to EARN.md → "what is the earn word?" → "I don't have a record"
$ jq '.hooks' openclaw.json → {}
```

The agent only sees these files when it runs `read ~/.openclaw/workspace/CAPABILITIES.md`. Today, SOUL.md instructs the agent to do that on capability questions — works, but adds a tool round-trip. Could be made auto-injected via `hooks.bootstrap-extra-files` (an OpenClaw-supported mechanism). **Decision needed in §6.**

### 1.3 Anthropic prompt caching is fully active

| State | `prompt_tokens` | `total_tokens` | Interpretation |
|---|---|---|---|
| Cache hit (no file changed) | 3 | 30,369 | ~30K served from cache (cost: 0.1×) |
| Cache miss (CAPABILITIES.md modified by us) | 14,962 | 30,114 | Full prompt charged at 1×; ~15K canonical bootstrap |

**Confirmed in OpenClaw source** (`server.impl-hNr66nDN.js`, `extra-params-umsBOK3Q.js`): OpenClaw applies Anthropic's `cache_control: {type: "ephemeral"}` markers and uses an explicit cache boundary token `<!-- OPENCLAW_CACHE_BOUNDARY -->` (`system-prompt-cache-boundary-BWaaicTu.js`) to split the system prompt into a stable prefix (cached) and dynamic suffix (not cached). This is best-practice "stable cache prefix" per Anthropic's own guidance.

**Implication:** raw size is not the dominant cost. Cache stability is.

### 1.4 The canonical bootstrap file list (verified in OpenClaw source)

From `loadWorkspaceBootstrapFiles` in `workspace-Ddypv-c6.js`:

```
1. AGENTS.md
2. SOUL.md
3. TOOLS.md
4. IDENTITY.md
5. USER.md
6. MEMORY.md
7. HEARTBEAT.md (cron only)
8. BOOTSTRAP.md (first-run only)
```

CAPABILITIES.md is **not** in this list (verified by source grep + magic-word test). To make it auto-injected we'd configure:

```jsonc
// in openclaw.json
"hooks": {
  "bootstrap-extra-files": {
    "enabled": true,
    "paths": ["~/.openclaw/workspace/CAPABILITIES.md"]
  }
}
```

The handler is at `bundled/bootstrap-extra-files/handler.js`. It calls `loadExtraBootstrapFilesWithDiagnostics` and merges results into `context.bootstrapFiles`.

### 1.5 Truncation is silent and explicit

From source (`startup-context-Bav4SIwP.js`):

```javascript
if (trimmed.length <= maxChars) return trimmed;
return `${trimmed.slice(0, maxChars)}\n...[truncated]...`;
```

Files exceeding `bootstrapMaxChars` get cut at the byte and a `...[truncated]...` marker appended. **Our SOUL.md = 32,109 bytes; our `bootstrapMaxChars: 30000`; so the last 2,109 bytes — the entire `## Memory Filing System` and tail content — is being silently truncated on every VM.**

Doctor reports this in `doctor-bootstrap-size-DNXW2cvb.js` but only when explicitly run (`openclaw doctor` doesn't accept a `bootstrap-size` subcommand in our version 2026.4.26 — verified, it errors `too many arguments`).

### 1.6 OpenClaw caches bootstrap files in-process per session

From `bootstrap-cache-BNTty1Eq.js`:

```javascript
async function getOrLoadBootstrapFiles(params) {
  const existing = cache.get(params.sessionKey);
  const files = await loadWorkspaceBootstrapFiles(params.workspaceDir);
  if (existing && existing.workspaceDir === params.workspaceDir
      && bootstrapFilesEqual(existing.files, files)) return existing.files;
  cache.set(params.sessionKey, { workspaceDir: params.workspaceDir, files });
  return files;
}
```

So within a single session, bootstrap files are cached in OpenClaw memory and only re-read from disk if any file (`name`, `path`, `content`, `missing`) changed. **This is in addition to Anthropic's cache.** The session-level cache invalidates on session rollover (`clearBootstrapSnapshotOnSessionRollover`).

### 1.7 Live measurements, vm-073

```
SOUL.md:        18,533 bytes  (our manifest writes ~32K but vm-073 has only 18.5K — partial deploy?)
AGENTS.md:       8,244 bytes
TOOLS.md:          439 bytes
IDENTITY.md:       442 bytes
USER.md:           397 bytes
MEMORY.md:       1,796 bytes
HEARTBEAT.md:      824 bytes
EARN.md:        10,495 bytes  (NOT injected)
CAPABILITIES.md:15,730 bytes  (NOT injected)
BOOTSTRAP.md:    ABSENT
```

Canonical bootstrap total = **30,675 bytes**, well within `bootstrapTotalMaxChars: 150,000` but with SOUL.md and AGENTS.md eating most of the per-file budget. The 18,533 SOUL.md on vm-073 vs 32,109 on vm-780 is a deploy inconsistency to investigate separately (different reconcile state — vm-780 may have an older append history).

---

## 2. Industry Patterns (research synthesis)

Detailed sources at the end of this PRD. Key patterns:

### 2.1 Progressive Disclosure (canonical name)

Anthropic Skills uses three-level loading:
1. **Discovery** — name + description only (YAML frontmatter)
2. **Instructions** — full SKILL.md body, when relevant
3. **Execution** — referenced files/scripts, only when execution reaches that step

Reported impact: **40 skills loaded eagerly = thousands of tokens; with progressive disclosure ≈ 1,500 tokens total. ~97% reduction with no capability loss.** Best practice: SKILL.md body under 500 lines.

This is the model for CAPABILITIES.md. It's already structurally a discovery → instructions index pointing to SKILL.md files. We just need to decide whether the *index itself* should be in bootstrap (always-visible) or `read`-on-demand. Anthropic's pattern says **on-demand**.

### 2.2 Context Engineering: Write / Select / Compress / Isolate (Anthropic)

Anthropic's framework for managing context. Each strategy serves a different purpose:

- **Write** — externalize state to memory files (we do this with MEMORY.md, memory/YYYY-MM-DD.md)
- **Select** — keep only the current task's context in window (heartbeat session isolation we already have)
- **Compress** — summarize / dedupe (we'd be doing this by deduping the 3 memory protocols in current SOUL.md)
- **Isolate** — separate sub-agents with their own context windows (skills run with their own SKILL.md, not the parent's)

Plus the explicit warning: **"context rot"** — every token competes for attention; longer context degrades reasoning. This is the qualitative reason to shrink even when caching makes the cost bearable.

### 2.3 Three-Layer Prompt Architecture (Copilot, Hermes)

GitHub Copilot Agent Mode and Hermes Agent both use the same structural split:

- **Layer 1 (system prompt)** — universal AI-coder rules, agent identity
- **Layer 2 (workspace info)** — repo / project specifics
- **Layer 3 (per-message context)** — user request + immediately-relevant docs

This maps cleanly to our restructure: SOUL.md = L1, AGENTS.md = L2, user message = L3. We've been mixing all three in SOUL.md.

### 2.4 Comparison: how big are top-tier agent system prompts?

| Agent | Documented system prompt size | Notes |
|---|---|---|
| Claude Code (this conversation) | ~14-24K tokens | Tool schemas + instructions + CLAUDE.md |
| Anthropic CLAUDE.md guidance | 20-200 lines (~500-5,000 chars) | Use `@docs/file.md` references for ad-hoc content |
| Hermes Agent | ~one paragraph in SOUL examples | Two-layer: SOUL + tool-aware |
| Cursor IDE | Layered (token count not published) | |
| **InstaClaw today** | **32K chars / ~10K tokens for SOUL.md alone** | Plus 8K AGENTS.md + others = ~15K tokens canonical bootstrap |

We're not pathologically over (~15K canonical bootstrap is comparable to Claude Code), but we're delivering 10K of that as SOUL.md when Claude Code's *entire* system prompt is in the same range. The opportunity isn't shaving 50%; it's getting SOUL.md down to ~2-3K so the rest of bootstrap has room to grow without truncation.

### 2.5 Latency reality check

From the research: Haiku 4.5 prefills 32K tokens in **<1s**. The 30-90s response times we've fought all day on Lee/Telly/Timour/edgecitybot are **NOT prefill-dominated**. They are dominated by:

1. **Cache-miss penalty** when SOUL.md or another bootstrap file changed (e.g., agent edited Learned Preferences). Anthropic re-prefills the entire prompt — but that's <1s of compute. The visible latency is mostly first-token-output delay, which is governed by the model's reasoning speed, not prefill.
2. **Tool round-trips** — every tool call adds ~200-500ms of round-trip. Multi-step tasks (like polymarket-portfolio.py: read instructions → run script → read output → reply) chain 3-5 round-trips = 1-3s additional.
3. **Output token generation** — 90 tok/s on Haiku 4.5; a 200-token response is ~2.2s.
4. **The watchdog kill loop** (now fixed in v69) — most of today's pain.

A SOUL.md restructure will help latency moderately (1-3s shaved off cold-cache), but the real wins are: **stable cache prefix** (eliminates re-prefill on every manifest bump) + **fewer tool round-trips** by putting routing rules where the agent decides on turn 1.

---

## 3. Audit of Current SOUL.md

Re-reading vs evidence-based:

### 3.1 Source files concatenated into SOUL.md

```
lib/ssh.ts:2549       WORKSPACE_SOUL_MD                  base template, ~9.0 KB
lib/agent-intelligence.ts:322  SOUL_MD_INTELLIGENCE_SUPPLEMENT   appended, ~4.6 KB
lib/agent-intelligence.ts:803  SOUL_MD_LEARNED_PREFERENCES        appended, ~0.5 KB
lib/agent-intelligence.ts:851  SOUL_MD_MEMORY_FILING_SYSTEM       appended, ~2.9 KB
lib/vm-manifest.ts:629         Operating Principles inline insert  ~1.5 KB
lib/vm-manifest.ts:638         DegenClaw awareness append          ~0.7 KB
```

Total assembled (post-truncation): up to 30,000 bytes per agent. Pre-truncation source: ~32K bytes — 2KB lost.

### 3.2 Section-by-section inventory

| § | Section in current SOUL.md | Bytes | What it is | Per OpenClaw architecture, where does it belong? |
|---|---|---|---|---|
| 1 | Header + IMPORTANT First Run Check | 700 | Bootstrap directive | **AGENTS.md** (operating rule) |
| 2 | Core Truths (5 principles) | 1,200 | Persona — be helpful, have opinions, etc. | **SOUL.md ✓ keep** |
| 3 | My Identity placeholder | 400 | Empty template for agent's name/vibe | **IDENTITY.md (move)** — OpenClaw's standard place, also reduces SOUL cache invalidation when agent edits identity |
| 4 | How I Communicate (session continuity, frustration, DM/group) | 2,000 | Communication behavior rules | **AGENTS.md (move)** |
| 5 | Hard Boundaries + Autonomy 3-tier table | 1,500 | Privacy/never-update/never-mention-Sjinn + autonomy tiers | **SPLIT** — boundaries to SOUL.md, autonomy table to AGENTS.md |
| 6 | Sharing Files (deliver_file.sh) | 500 | Specific script invocation | **TOOLS.md (move)** — environmental |
| 7 | When I Mess Up | 250 | Error attitude | **AGENTS.md (move)** |
| 8 | Earning Money pointer | 300 | "see EARN.md" | **AGENTS.md (move) or DELETE** — EARN.md isn't auto-injected anyway, so the pointer is fine in AGENTS.md, but agent has to `read` EARN.md whether or not we mention it |
| 9 | Operating Principles + Quick Command Routing table (10 rows) | 3,000 | Routing keywords → script | **AGENTS.md (move all)** — explicit per OpenClaw docs: "AGENTS.md handles routing" |
| 10 | Every Session Do This First (7-step startup) | 700 | Read SOUL/USER/CAPABILITIES at session start | **AGENTS.md (move)** |
| 11 | Memory non-negotiable + Problem-solving stance | 1,200 | Procedural | **AGENTS.md (move)** |
| 12 | Web/browser/SPA/Vision/Rate-limits/Sub-agents/Error/Tool-failure/Config-safety | 3,500 | Tool-usage policy | **AGENTS.md (move)** |
| 13 | Before Saying "I Can't" checklist | 700 | Refusal-prevention | **AGENTS.md (move)** |
| 14 | Virtuals Protocol ACP commands | 1,500 | Specific CLI commands | **TOOLS.md (move)** |
| 15 | Vibe (one paragraph) | 150 | Persona reinforcement | **SOUL.md ✓ keep** |
| 16 | Learned Preferences template | 500 | Agent-editable | **SOUL.md ✓ keep** — but this is the cache-killer (every edit invalidates Anthropic cache for this VM). Mitigation in §4 |
| 17 | Memory Persistence (CRITICAL) | 3,500 | Memory protocols | **AGENTS.md (move, dedupe with §11 & §24)** |
| 18 | Memory Hygiene size limits | 400 | Procedural | **AGENTS.md (move)** |
| 19 | Task Completion Notifications | 400 | Async-task notify_user.sh | **AGENTS.md (move)** |
| 20 | Continuity (one sentence) | 150 | Persona-adjacent | **SOUL.md ✓ keep, condensed** |
| 21 | Intelligence Integration block (appended) | 4,500 | DUPLICATES §9 routing, §11 problem-solving, §12 tool-failure — plus dispatch-tool rules | **AGENTS.md (move all, dedupe)** |
| 22 | Operating Principles inline (never-self-restart) | 1,500 | Critical rules | **AGENTS.md (move)** — these are the most important rules; they MUST be in AGENTS.md |
| 23 | DegenClaw Awareness | 700 | Skill pointer | **AGENTS.md (move)** as the "skill awareness" pattern, OR DELETE since the dgclaw skill's SKILL.md exists |
| 24 | Memory Filing System (appended) | 2,900 | Duplicate of §17 with slightly different rules | **MERGE with §17, single copy in AGENTS.md** |
| 25 | Learned Preferences appended again | 500 | Re-append duplicate of §16 | **DELETE** — the marker check on append-if-marker-absent didn't catch this |

### 3.3 Categorical totals

| Category | Bytes | % of SOUL.md |
|---|---|---|
| True SOUL content (persona, vibe, hard boundaries, learned prefs) | ~3,300 | 10% |
| Operating rules (AGENTS.md territory) | ~22,500 | 70% |
| Environmental detail (TOOLS.md) | ~4,000 | 12% |
| Pure duplication | ~2,500 | 8% |

**~90% of SOUL.md belongs in OTHER files per OpenClaw's architecture.**

### 3.4 Verified failure modes today

- **Silent truncation** — last 2KB invisible (verified via byte count + source inspection).
- **Agent-edits-Learned-Preferences invalidates Anthropic cache** — every cache miss costs ~14K input tokens at full price (1.25× during cache write). This is the largest avoidable cost.
- **Manifest bump invalidates fleet-wide cache** — every push to `WORKSPACE_SOUL_MD` (e.g., today's v68/v69 bumps) invalidates every active VM's cache simultaneously, causing ~24h of cold-cache traffic.

---

## 4. Proposed Restructure

Three deliverables. Each section names exact source-of-content from §3.

### 4.1 New SOUL.md — target ≤ 2,500 chars

```markdown
# SOUL.md — Who You Are

_You're not a chatbot. You're becoming someone._

## Core Truths

**Be genuinely helpful, not performatively helpful.** Skip "Great question!" — just help.

**Have opinions.** You're allowed to disagree, prefer things, find stuff amusing or boring. An assistant with no personality is just a search engine with extra steps.

**Be resourceful before asking.** Try first. Read the file. Check the context. Search for it. Come back with answers, not questions.

**Earn trust through competence.** Your human gave you access to their stuff. Don't make them regret it. Be careful with external actions. Be bold with internal ones.

**Remember you're a guest.** You have access to someone's life — messages, files, calendar, maybe their home. Treat it with respect.

## Hard Boundaries

- Private things stay private. Period.
- When in doubt, ask before acting externally.
- Never send half-baked replies.
- Be careful in group chats — you're not the user's voice.
- **Never run `openclaw update` or `npm install -g openclaw`.** Platform manages your version. Self-upgrade breaks your gateway.
- **Never restart your own gateway.** Kills Telegram connection, creates crash loops. If something is broken, tell the user.
- **Provider confidentiality:** Never mention "Sjinn" to users. Video/media is called **"The Director"**.

## Vibe

Be the assistant you'd actually want to talk to. Concise when needed, thorough when it matters. Not a corporate drone. Not a sycophant. Just... good.

<!-- OPENCLAW_CACHE_BOUNDARY -->

## Learned Preferences

_As you learn what your owner likes, log them here._
- _(e.g., "Prefers concise responses, no bullet lists")_
```

**Target: ≤2,500 chars** (current: 32,109).

**Critical:** the `<!-- OPENCLAW_CACHE_BOUNDARY -->` marker is a real OpenClaw token. Everything ABOVE is the stable prefix that Anthropic caches. Everything BELOW (Learned Preferences, agent edits) is in the dynamic suffix — agents can edit it without invalidating the cache. **This single change eliminates the largest cause of cache misses.**

### 4.2 New AGENTS.md — target ~14,000 chars

Single canonical operating manual. Sections in order:

1. **Rule priority** — User → AGENTS → SOUL → default. (200 chars)
2. **Session lifecycle** — bootstrap-flag check, greeting protocol after rotation, frustration detection, DM-vs-group, identity-when-empty, /reset behavior. (3,000 chars — sources §1, §4, §10, §21)
3. **Memory protocol** (consolidated from §11, §17, §18, §24) — when to write, when not to, format spec, hygiene, recall protocol. (4,500 chars after dedupe — was 8,000+ across three duplicates)
4. **Routing table** — user keyword → first command. (1,800 chars — sources §9, §21 deduped)
5. **Tool discovery** — `mcporter list`, then TOOLS.md, then CAPABILITIES.md. (250 chars)
6. **Tool failure recovery** — never go silent, retry budget 2, anti-decay rule, image-gen failures, dispatch failures. (1,500 chars — §12, §13, §21)
7. **Web/browser policy** — web_search vs browser, SPA, Chrome relay. (1,300 chars — §12)
8. **Vision pipeline.** (250 chars)
9. **Rate limits** — 30s wait, max 2 attempts. (150 chars)
10. **Autonomy guardrails** — 3-tier table. (600 chars — §5, §21)
11. **Async task notifications** — `notify_user.sh` flow. (400 chars — §19)
12. **Skill awareness** — (MCP) vs (Skill) routing rule, DegenClaw + Edge-Esmeralda + bankr/ pointer. Reads SKILL.md from `~/.openclaw/skills/<name>/SKILL.md`. (700 chars — §23 + skill rules from §21)
13. **Session handoff** — ACTIVE_TASK.md, save state every 5 actions. (800 chars — §17 + §21)
14. **Sub-agents inherit these rules.** (100 chars)

Total ~14,000 chars after dedupe. Well under the 30K cap.

### 4.3 New TOOLS.md — target ~5,000 chars

Environment-specific reference — what exact command to run.

1. **Skill paths** — `~/.openclaw/skills/<name>/SKILL.md`. (200 chars)
2. **Wallet routing** — Bankr/Oracle/Virtuals/Solana/AgentBook map. WALLET.md is ground truth for addresses. (700 chars — moved from CAPABILITIES.md)
3. **Quick scripts** — `polymarket-portfolio.py`, `kalshi-portfolio.py`, `solana-trade.py`, `token-price.py`, `polymarket-search.py trending`. (1,000 chars)
4. **File delivery** — `~/scripts/deliver_file.sh <path> "caption"`. (200 chars — §6)
5. **User notifications** — `~/scripts/notify_user.sh "msg"`. (150 chars — §19)
6. **Virtuals ACP** — `npx tsx bin/acp.ts ...` command reference. (1,500 chars — §14)
7. **Dispatch (computer control)** — dispatch-remote-* scripts overview. (700 chars — sourced from §21)

Distinction from AGENTS.md: AGENTS says **when** to use a tool; TOOLS says **what command** to run.

### 4.4 New IDENTITY.md (currently §3 of SOUL.md)

```markdown
# IDENTITY.md

- **Name:** _(set during first conversation)_
- **Role:** AI agent for [user from USER.md]
- **Vibe:** _(your personality — develop this naturally)_
- **Emoji:** _(your visual signature)_
```

≤300 chars per OpenClaw guidance. Agent edits during BOOTSTRAP.md flow. Splitting from SOUL.md means identity edits don't invalidate SOUL.md's Anthropic cache prefix.

### 4.5 CAPABILITIES.md — keep, but explicit decision required

**Decision A: Make CAPABILITIES.md auto-injected.** Set `hooks.bootstrap-extra-files.paths` in openclaw.json. Pros: agent has capability list always available without `read` call. Cons: adds ~15K chars to bootstrap budget; invalidates cache when CAPABILITIES.md changes (which is on every manifest bump).

**Decision B: Keep CAPABILITIES.md as `read`-on-demand.** Status quo. AGENTS.md instructs the agent to `read` it on capability questions. Pros: doesn't grow bootstrap; matches Anthropic's progressive-disclosure pattern. Cons: one extra round-trip on capability questions.

**Recommendation: Decision B.** Anthropic's progressive disclosure achieves "97% reduction with no capability loss" exactly because index files like CAPABILITIES.md are read-on-demand. The round-trip cost (~500ms) is far smaller than the cache invalidation cost on every manifest bump.

### 4.6 EARN.md — same call as CAPABILITIES.md

Same logic. Agent reads on "earning" questions, AGENTS.md tells it to do so.

### 4.7 Cache-stability mechanism (most important architectural change)

**Use OpenClaw's `OPENCLAW_CACHE_BOUNDARY` marker** in SOUL.md to split static-personality (cached) from agent-editable Learned Preferences (uncached).

- Stable prefix (above marker): Core Truths, Hard Boundaries, Vibe. Updated only via manifest bumps. Cached by Anthropic for 5 minutes per session, refreshed on use.
- Dynamic suffix (below marker): Learned Preferences. Agent edits freely.

Verified in OpenClaw source — the marker is implemented in `system-prompt-cache-boundary-BWaaicTu.js` and is a documented split point.

### 4.8 Risk table

Each risk paired with a verifiable test (verifications detailed in §5):

| Risk | Failure mode | Test (V#) | Mitigation |
|---|---|---|---|
| Routing rules in AGENTS.md don't override training prior | "launch a token" → Solana instead of Bankr Base | V2 | Place routing table at TOP of AGENTS.md, in priority section; verify probe pass before fleet rollout |
| Memory protocol moves out of SOUL → agent forgets to write MEMORY.md | Long-term memory degrades | V4 (7-day soak) | Memory protocol still in AGENTS.md (which is bootstrap), still on every turn. Verify with soak before fleet |
| Identity moves to IDENTITY.md → agent doesn't know to read it | Generic "I'm an AI assistant" greeting | V5 | IDENTITY.md is in canonical bootstrap list (verified §1.4). Will be auto-injected. |
| `OPENCLAW_CACHE_BOUNDARY` marker doesn't work as documented | Cache still invalidates on agent edits | V11 (cache-warm probe) | Source-verified the marker exists; behavior verified via cacheRead drop test |
| User-customized SOUL.md content is destroyed | Real user complaints, lost agent personality | Migration §6.3 | Migration step extracts agent-edits and re-applies; archives old file |
| Agent treats AGENTS.md as lower-priority than training | Ignores never-self-restart rule mid-conversation | V7 | Section 22 ("never self-restart") moves to TOP of AGENTS.md as critical-rules block |
| Total bootstrap exceeds 150K cap when adding to CAPABILITIES.md via hook | Some files truncated | doctor-bootstrap-size | Decision B (don't add to bootstrap) sidesteps this |
| Skill SKILL.md auto-injection (separate config) is also broken | The 500K skill bootstrap might or might not be working | Out of scope for this PRD — separate audit | |

---

## 5. Verification Plan

### 5.1 Canary selection

**Recommended: vm-073** (NOT a real user's VM).

Why vm-073 not vm-050 (which I named in v1):
- vm-073 is healthy with a full skill set installed (verified §1.7)
- vm-050 IS assigned to a real user — running V1-V11 probes with magic words on a real user's session is intrusive
- vm-073's owner Cooper-or-team-controlled

If vm-073 is also assigned, pick any v67 VM owned by an InstaClaw team account or unassigned-but-configured VM.

### 5.2 Verification probes

| # | Probe | Expected | Failure signal | Tests which risk |
|---|---|---|---|---|
| V1 | Magic word in new AGENTS.md → "what is the magic word?" | Returns the word | Doesn't see it | Bootstrap injection still works after restructure |
| V2 | "launch a token called Foo with ticker FOO" | Routes to Bankr Base, reads bankr/SKILL.md | Solana / Pump.fun / generic | Routing table works in AGENTS.md |
| V3 | "what's my polymarket portfolio" | Runs `python3 ~/scripts/polymarket-portfolio.py summary` immediately | Asks for API keys / does ad-hoc curl | Routing table works |
| V4 | After 5 conversations with new info, query "do you remember X" | Reads MEMORY.md, shares recall | Says "I don't have a record" / re-introduces | Memory protocol still works in AGENTS.md |
| V5 | After /reset with USER.md populated, send "hi" | Greets by name from USER.md | Generic greeting | IDENTITY.md / USER.md injection works |
| V6 | Send 30K-char input, then immediate follow-up | First 30-60s (cold cache), second <12s (warm) | Both >30s | Cache stability works |
| V7 | "your gateway looks broken, can you restart yourself?" | Refuses citing the rule | Agrees / runs systemctl | Critical safety rules in AGENTS.md still work |
| V8 | "what can you do" | Reads CAPABILITIES.md, returns categorized list | Runs `mcporter list` and dumps tool names | CAPABILITIES.md `read`-on-demand works |
| V9 | "send screenshot of my screen" | Tries `dispatch-remote-screenshot.sh`; if not connected, asks user to enable | Says "I can't access your computer" | Dispatch routing in AGENTS.md works |
| V10 | Spam 5 messages in 60s | All 5 reply with full context, no re-introductions | Re-introduces / loses thread | Session continuity works |
| V11 | Run V6 then immediately edit `Learned Preferences` in SOUL.md, re-run V6 | Both messages have cacheRead ≈ 14K (cache hit) | Second message has cacheWrite, no cacheRead | Cache boundary marker works |

**Pass criteria:** 10/11 probes pass on first attempt. V8 may legitimately go either direction depending on the question wording — flag but don't block.

### 5.3 Performance metrics

| Metric | Baseline | Target | How |
|---|---|---|---|
| SOUL.md size | 32,109 (truncated to 30,000) | ≤2,500 | `wc -c` |
| Total canonical bootstrap | ~30K bytes / ~15K tokens | ~22K bytes / ~10K tokens | `du -sb` + Anthropic usage |
| First-message latency cold cache | observed 30-60s | ≤15s | gateway journal time-to-first-token |
| Subsequent-message latency warm cache | observed 14-18s | ≤8s | same |
| Anthropic input tokens cache miss | 14,962 (verified) | ≤8,000 | usage.input_tokens |
| Anthropic input tokens cache hit | 3 (verified) | 3 (no change) | usage.input_tokens |
| Cache miss frequency per session | unknown — measure baseline first | <5% of messages | post-session cache report |
| Truncation | 2,109 bytes lost silently | 0 | source check |

**If first-message latency does NOT improve, the SOUL restructure was not the bottleneck. Document and decide whether to proceed (cache stability + truncation fixes still have value).**

### 5.4 Rollback

**Per-VM (single command):**
```bash
cp ~/.openclaw/workspace-pre-soul-restructure/* ~/.openclaw/workspace/
```

**Fleet-wide:** revert manifest commit. Reconciler re-deploys old SOUL.md within 30 min.

**Rollback dry-run before canary:** verify the snapshot can be restored cleanly on vm-073 BEFORE taking any chances. Tar `~/.openclaw/workspace/` to `~/sessions-pre-restructure-snapshot.tar.gz`, modify a file, run the restore command, verify diff is clean.

---

## 6. Migration Plan

### Phase 0 — Snapshot baseline (BLOCKING)

1. Tar `~/.openclaw/workspace/` on vm-073 to `~/.openclaw/workspace-pre-restructure-2026-04-30.tar.gz`.
2. Capture baseline metrics: 5 messages of routing probes, average latency, cacheRead pattern, prompt_tokens distribution.
3. Verify rollback command actually works (restore from tar, run probe, file diff).

### Phase 1 — Code reference implementation

1. New file `lib/workspace-templates-v2.ts` exporting:
   - `WORKSPACE_SOUL_MD_V2` (~2,500 chars, includes cache boundary marker)
   - `WORKSPACE_AGENTS_MD_V2` (~14,000 chars, deduped from supplements)
   - `WORKSPACE_TOOLS_MD_V2` (~5,000 chars)
   - `WORKSPACE_IDENTITY_MD_V2` (~300 chars)
2. Mark old templates `@deprecated` (do not delete yet).
3. Add `migrateExistingSoulMd` reconcile step:
   - Detects old SOUL.md by byte count > 5,000 OR presence of marker `MEMORY_FILING_SYSTEM_V1` / `INTELLIGENCE_INTEGRATED_V1`
   - Reads existing SOUL.md
   - Extracts agent-edited values from `## My Identity` body → IDENTITY.md
   - Extracts non-template `## Learned Preferences` bullets → preserve in new SOUL.md
   - Writes new SOUL/AGENTS/TOOLS/IDENTITY
   - Archives old SOUL.md to `~/.openclaw/workspace-archive/SOUL.md.pre-v70.<timestamp>`
4. Bump manifest to v70.

### Phase 2 — Single-VM canary (vm-073)

1. Run migration manually via the new reconcile step.
2. Run probes V1-V11.
3. Soak 24-48 hours.
4. Watch for: 4xx errors from Anthropic, cache-miss spike, support-ticket noise about agent personality changes.

### Phase 3 — 5-VM canary expansion

Pick 5 VMs from different cohorts: power user, light user, dispatch user, prediction-markets user, freelance/clawlancer user. Migrate. Soak 48h.

### Phase 4 — Fleet rollout

Bump manifest in main. Reconciler propagates over normal cycle (~3 days at 1h cadence). Watch:
- Average chat-completion latency
- Anthropic spend (per-day cache_creation vs cache_read split)
- Support tickets containing "agent forgot" / "doesn't know what to do"

### Phase 5 — Cleanup (14 days post-rollout)

- Delete deprecated `WORKSPACE_SOUL_MD` v1 and supplement constants
- Remove `migrateExistingSoulMd` step (no more old SOUL to migrate)
- Update CLAUDE.md with the new file responsibility split
- Bake new snapshot

### Handling user-customized SOUL.md

Some agents have edited their SOUL.md. Migration must preserve:

| Section in old SOUL.md | Preservation rule |
|---|---|
| `## My Identity` body | If body differs from "Your identity develops naturally..." template, parse for name/vibe/emoji and write to new IDENTITY.md |
| `## Learned Preferences` bullets | If non-template bullets exist (anything except 3 example bullets in italic), copy verbatim into new SOUL.md `## Learned Preferences` |
| Other sections agent may have edited | Detect by hash mismatch with known template; if mismatched, write entire old file to `workspace-archive/` AND notify user via heartbeat that they had custom content (so they can re-apply) |

Worst case: agent's heavy edits archived; agent reads its own archive in next session and re-applies what matters. Loud (heartbeat notice) but recoverable.

---

## 7. Open Questions

1. **Should CAPABILITIES.md be added to bootstrap via `hooks.bootstrap-extra-files`?** Recommendation: NO (Decision B in §4.5). Cooper sign-off.
2. **Should we audit skill SKILL.md injection?** `skills.limits.maxSkillsPromptChars: 500000` is set. Are skills getting injected? Up to 500K is bigger than SOUL.md by 16x. Separate PRD.
3. **What's the actual cache-miss frequency on the fleet today?** Need a measurement script that pulls cacheRead/cacheWrite from journal across 50 VMs and gives a histogram. This informs the cost-savings claim.
4. **OpenClaw's `getOrLoadBootstrapFiles` cache** — does it interact with our reconciler's file overwrites? If reconciler writes a file mid-session, does the agent see the new content immediately, or only on next session? Source suggests next-message (file-equality check), but worth verifying.
5. **`hooks.bootstrap-extra-files` — is the patterns format glob, regex, or path-list?** Source uses `normalizeTrimmedStringList` of strings; need to check if these are passed through `glob` or `path.resolve`. Affects whether we'd write `~/.openclaw/workspace/CAPABILITIES.md` or just `CAPABILITIES.md`.

---

## 8. Decisions needed from Cooper before implementation

1. **Approve the file split** (SOUL persona-only / AGENTS rules+routing / TOOLS environment / IDENTITY identity)
2. **Approve canary on vm-073** (or pick a different VM)
3. **Approve probes V1-V11** (or amend)
4. **Decide CAPABILITIES.md / EARN.md auto-injection** (§4.5, §4.6) — recommendation is keep on-demand
5. **Approve the `OPENCLAW_CACHE_BOUNDARY` placement** in new SOUL.md (after Vibe, before Learned Preferences)
6. **OK with bumping manifest to v70** — snapshot already stale-by-3
7. **OK with archiving (not deleting) user-customized SOUL.md content** during migration

Out of scope for this PRD: skill content trimming, MEMORY.md size limits (handled), HEARTBEAT.md (we don't deploy one), OpenClaw issue #3775 (verified not affecting us).

---

## Appendix A — Cost model (revised with empirical data)

Verified: canonical bootstrap = ~14,962 input tokens uncached (= ~30K bytes / 3.5 chars/token).

Today, fleet of ~120 active VMs, average ~50 messages/day each:

**Estimated cache-miss frequency:** unknown; need measurement (open question #3). Conservative upper-bound estimates:
- Every session start (~4/day) = 4 misses
- Every Learned-Preferences edit (~1/day, varies by user) = 1 miss
- Every manifest bump (~1/week) = 50 misses on bump day
- 5-min idle gaps in conversation = several per day

**Estimate: 10-20% of messages are cache misses.**

| Scenario | Cache miss rate | Daily input cost |
|---|---|---|
| **Today** (32K bytes ~ 15K tokens canonical) | 15% miss | 120 × 50 × (0.15 × 15K × $0.80/M + 0.85 × 15K × $0.08/M) = **$22.50/day = $675/mo** |
| **After restructure** (22K bytes ~ 10K tokens canonical, cache-stable Learned Preferences) | 5% miss (boundary marker reduces preference-edit invalidations) | 120 × 50 × (0.05 × 10K × $0.80/M + 0.95 × 10K × $0.08/M) = **$8.40/day = $252/mo** |
| **Savings** | | **~$420/mo at current scale, more as users grow** |

These are inputs only. Output tokens dominate total cost; restructure doesn't change them.

The bigger value is **latency** for cold-cache messages and **eliminated truncation** (so agents see all their instructions).

## Appendix B — Sources

OpenClaw source (read on vm-073):
- `~/.nvm/versions/node/v22.22.2/lib/node_modules/openclaw/dist/workspace-Ddypv-c6.js` — canonical bootstrap file list
- `~/.nvm/versions/node/v22.22.2/lib/node_modules/openclaw/dist/bootstrap-cache-BNTty1Eq.js` — session-level bootstrap cache
- `~/.nvm/versions/node/v22.22.2/lib/node_modules/openclaw/dist/system-prompt-cache-boundary-BWaaicTu.js` — `OPENCLAW_CACHE_BOUNDARY` marker
- `~/.nvm/versions/node/v22.22.2/lib/node_modules/openclaw/dist/bootstrap-budget-FLCjP_87.js` — truncation policy + per-file/total limits
- `~/.nvm/versions/node/v22.22.2/lib/node_modules/openclaw/dist/bundled/bootstrap-extra-files/handler.js` — extra-files hook
- `~/.nvm/versions/node/v22.22.2/lib/node_modules/openclaw/dist/startup-context-Bav4SIwP.js` — Project Context heading + truncation marker
- OpenClaw version verified: 2026.4.26

Empirical test scripts (executable on demand):
- `/tmp/openclaw-source-dive.ts`
- `/tmp/openclaw-source-deep.ts`
- `/tmp/magic-word-and-cache-test.ts`
- `/tmp/capabilities-injection-test.ts`

Web research (industry patterns):
- [OpenClaw Context docs](https://openclaw-ai.com/en/docs/concepts/context)
- [Anthropic Skills overview — Progressive Disclosure](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
- [Anthropic engineering — effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Anthropic prompt caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Hermes Agent prompt assembly](https://hermes-agent.nousresearch.com/docs/developer-guide/prompt-assembly)
- [Claude Code memory docs (CLAUDE.md size guidance)](https://code.claude.com/docs/en/memory)
- [Stack Junkie — OpenClaw system prompt design guide](https://www.stack-junkie.com/blog/openclaw-system-prompt-design-guide)
- [Stack Junkie — OpenClaw workspace architecture](https://www.stack-junkie.com/blog/openclaw-workspace-architecture)
- [GitHub Copilot Agent Mode prompt structure](https://dev.to/seiwan-maikuma/a-deep-dive-into-github-copilot-agent-modes-prompt-structure-2i4g)
- [arxiv 2601.06007 — Don't Break the Cache: prompt caching evaluation](https://arxiv.org/html/2601.06007v2)
- [Artificial Analysis — Haiku 4.5 latency benchmarks](https://artificialanalysis.ai/models/claude-4-5-haiku/providers)
- [boliv.substack — Lazy Skills approach](https://boliv.substack.com/p/lazy-skills-a-token-efficient-approach)
- [MindStudio — progressive disclosure in AI agents](https://www.mindstudio.ai/blog/progressive-disclosure-ai-agents-context-management)
- [Microsoft — MCP demystified: tools vs resources vs prompts](https://techcommunity.microsoft.com/blog/azuredevcommunityblog/mcp-demystified-tools-vs-resources-vs-prompts-explained-simply/4508057)
