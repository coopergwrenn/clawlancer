# PRD: API Cost Optimization — Context Engineering for InstaClaw Agents

**Author:** Cooper Wrenn + Claude (Opus 4.6)
**Date:** 2026-04-05
**Status:** Phase 1 SHIPPED (April 5, 2026). PRD updated April 6 with corrected token measurements.
**Priority:** P0 — directly impacts unit economics and company viability
**Estimated Impact:** ~$736/mo from prompt caching (revised down from $7,714 — see Section 2.5 correction)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [Research Findings — What the Best Teams Do](#3-research-findings)
4. [Architecture Options Analyzed](#4-architecture-options-analyzed)
5. [Recommended Implementation Plan](#5-recommended-implementation-plan)
6. [Success Metrics](#6-success-metrics)
7. [Risk Mitigation](#7-risk-mitigation)
8. [Technical Implementation Details](#8-technical-implementation-details)
9. [Open Questions](#9-open-questions)
10. [Appendices](#10-appendices)

---

## 1. Executive Summary

### The Discovery

On April 5, 2026, during the infrastructure upgrade project (Phases 1-3 complete), we discovered that **Anthropic prompt caching was not enabled** anywhere in our stack. We initially estimated 189,380 tokens of system context per call — but production measurement revealed the actual system prompt is only **14,836 tokens** (OpenClaw already uses compact skill loading). Caching was enabled the same day.

### Current State (Updated April 6, 2026)

| Metric | Value |
|--------|-------|
| Monthly Anthropic API spend | ~$7,500-9,000/mo projected* |
| System prompt per call | 14,836 tokens (8% of input) |
| Conversation history per call | ~170,000 tokens avg (92% of input) |
| Prompt caching | **ENABLED** (shipped April 5) |
| April MTD cost (6 days) | $2,248.48 |
| Daily steady state (Apr 6) | ~$250-300/day |
| Fleet MRR | $7,355/mo |

*Apr 1-4 costs were heavily inflated: restart storms (230+ VMs restarting 100s of times, each = fresh 15K token context at full price), 150 non-paying VMs still active (~18% of usage), and resize operations restarting every VM. Real steady-state is closer to the Apr 5-6 numbers (~$250-300/day = $7,500-9,000/mo). As the month progresses with no further disruptions, the daily average will come down.

### What Was Done

| Action | Impact | Status |
|--------|--------|--------|
| Enable prompt caching in proxy | ~$736/mo savings on system prompt | **SHIPPED** Apr 5 |
| Delete 150 non-paying VMs | ~18% fewer API calls | **SHIPPED** Apr 3 |
| Fix restart storms | Eliminated 100s of fresh-context API calls/day | **SHIPPED** Apr 2 |
| strip-thinking.py session cap (200KB) | Limits conversation history growth | **SHIPPED** (manifest v32+) |
| Cross-session memory hook | Haiku for summaries, not Sonnet | **SHIPPED** Apr 6 (manifest v56) |

### The Bottom Line

The original PRD estimated $7,714/mo in caching savings based on a 189K token system prompt. **The actual system prompt is only 14,836 tokens (92% smaller than estimated).** Caching saves ~$736/mo — meaningful but not transformative. The real cost driver is conversation history (92% of input tokens), which is managed by compaction + session archiving, not caching.

---

## 2. Problem Statement

### 2.1 Current Context Window Breakdown

Every API call to Anthropic includes a system prompt constructed by OpenClaw on each VM. This system prompt contains:

| Component | Characters | Tokens (est.) | % of Context | Description |
|-----------|-----------|---------------|-------------|-------------|
| SKILL.md files (23 skills) | 371,109 | ~92,777 | 49% | Full skill instructions for all skills |
| references/*.md (35 files) | 322,568 | ~80,642 | 43% | API docs, strategy guides, templates, examples |
| Workspace files (11 files) | 63,845 | ~15,961 | 8% | SOUL.md, MEMORY.md, USER.md, EARN.md, etc. |
| **TOTAL** | **757,522** | **~189,380** | **100%** | Sent on EVERY API call |

**189,380 tokens × $3.00/M = $0.567 just for the system context.** Before the user even says a word.

### 2.2 Why April Was Expensive

The $1,874 bill for April 1-5 was inflated by several factors:

| Factor | Impact | Details |
|--------|--------|---------|
| Restart storms (Apr 1-2) | HIGH | 230+ VMs restarting 100s of times/day. Each restart = fresh context = full 189K tokens at FULL price (cache wiped) |
| 150 non-paying VMs | MEDIUM | 18% of total API usage was from VMs serving no paying user (deleted Apr 3) |
| Resize operations (Apr 4) | MEDIUM | Every VM restarted during resize = fresh contexts |
| 16 user restorations (Apr 4) | LOW | configureOpenClaw calls for restored users |
| Claude Code usage | LOW | Infrastructure work using Claude Code on this API key |

**Daily cost breakdown:**

| Day | Cost | Event |
|-----|------|-------|
| Apr 1 | ~$400 | Restart storms, 230+ VMs |
| Apr 2 | ~$300 | Restart storms continuing |
| Apr 3 | ~$400 | Fixes deployed, 150 VMs deleted mid-day |
| Apr 4 | ~$400 | Resize operations (all VMs restarted) |
| Apr 5 | ~$200 (partial) | Steady state beginning |

**Anthropic Usage page stat:** 2.28 BILLION input tokens + 16.6 MILLION output tokens in just 5 days. The input:output ratio of 137:1 confirms that the system prompt (input) dominates cost, not agent responses (output). Reducing input tokens via caching is the #1 lever.

**Steady state estimate:** $250-350/day = $7,500-10,500/mo (post-fix, 169 VMs).

### 2.3 Per-Tier Cost Analysis (Without Caching)

Based on actual Anthropic billing calibrated against real usage data:

| Component | Starter | Pro | Power |
|-----------|---------|-----|-------|
| Linode VM (dedicated) | $29.00 | $29.00 | $29.00 |
| Monitoring + pool overhead | $4.98 | $4.98 | $4.98 |
| SaaS (Supabase, Vercel, Resend) | $1.29 | $1.29 | $1.29 |
| Anthropic API (weighted by usage) | $17.84* | $44.60* | $118.95* |
| MiniMax API | $4.76 | $4.76 | $4.76 |
| **Total cost per user** | **$57.87** | **$84.63** | **$158.98** |
| Current price | $29 | $99 | $299 |
| **Margin** | **-$28.87 (-100%)** | **+$14.37 (15%)** | **+$140.02 (47%)** |

*API costs weighted by Sonnet/Opus budget utilization per tier: Starter ~6 Anthropic calls/day, Pro ~15, Power ~40.

**Starter tier is deeply unprofitable.** Pro barely breaks even. Only Power generates meaningful margin.

### 2.4 Root Cause: Zero Prompt Caching

Verified on April 5, 2026 via direct testing:

```
TEST 1 — Without cache_control header:
  input_tokens: 3011
  cache_creation_input_tokens: 0
  cache_read_input_tokens: 0
  → NO CACHING. Full price on every call.

TEST 2 — With cache_control + beta header:
  Call 1: cache_creation_input_tokens: 3003 (cache write)
  Call 2: cache_read_input_tokens: 3003 (CACHE HIT — 90% discount!)
  → CACHING WORKS. Just not enabled.
```

**Confirmed:** OpenClaw does not use prompt caching (0 occurrences of `cache_control` in message-handler). Our proxy does not add it (0 occurrences). The `anthropic-beta: prompt-caching-2024-07-31` header is never sent.

### 2.5 CORRECTION: Actual System Prompt Size (Updated April 6, 2026)

**The 189,380 token estimate above was WRONG.** It was based on measuring files on disk (`wc -c` on SKILL.md + references + workspace files). In reality, OpenClaw does NOT send full SKILL.md files in the system prompt — it uses compact skill loading (names + descriptions + file paths), and agents read full skill content from disk on demand.

**Verified via production TOKEN_ANALYSIS logging (April 5-6):**

| Metric | Estimated (Section 2.1) | Actual (production) |
|--------|------------------------|---------------------|
| System prompt tokens | 189,380 | **14,836** (59,345 chars) |
| System prompt % of input | 95%+ | **~8%** |
| Conversation history % | ~5% | **~92%** |
| System prompt cost per call | $0.567 | **$0.045** |

**What this means for caching:**
- Caching the system prompt saves 90% on only ~8% of input tokens (not 95%)
- Estimated caching savings: **~$736/mo** (not $7,714/mo)
- The real cost driver is **conversation history** (92% of input tokens), which cannot be cached
- Conversation history is managed by OpenClaw's compaction system + strip-thinking.py session archiving

**Updated Anthropic billing (April 6, 2026 — from console):**

| Metric | Value |
|--------|-------|
| April MTD total cost | $2,248.48 (6 days) |
| Daily average (Apr 1-5, includes chaos) | ~$400/day |
| Daily steady state (Apr 6, post-caching) | ~$250-300/day |
| Projected monthly (steady state) | **$7,500-9,000/mo** |
| Input tokens MTD | ~2.7B |
| Output tokens MTD | ~19.3M |
| Input:output ratio | 139:1 |
| Models used | 95%+ Sonnet 4.6, trace Opus 4.6 + Haiku 4.5 |

**Phase 1 (prompt caching) is SHIPPED and working.** The savings are real but smaller than estimated because the system prompt is only 8% of input tokens. The remaining cost reduction opportunity is reducing conversation history size — which compaction, strip-thinking.py session archiving (200KB cap), and the cross-session memory system (v56) all address indirectly by keeping sessions cleaner.

---

## 3. Research Findings — What the Best Teams Do

Comprehensive research conducted April 5, 2026 across 12 major platforms and approaches.

### 3.1 Anthropic / Claude Code

**Source:** [Anthropic Engineering Blog](https://www.anthropic.com/engineering/advanced-tool-use), [Claude API Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool), Claude Code leaked source (github.com/ultraworkers/claw-code)

**Deferred Tool Loading:**
Claude Code had ~14-16K tokens of tool definitions. They introduced `defer_loading: true` which reduces this to **968 tokens** — the model sees only tool names + 1-line descriptions. Full schemas are loaded on-demand via a `ToolSearch` meta-tool.

- 85% reduction in tool context tokens
- Tool use accuracy IMPROVED from 79.5% to 88.1% (less noise = better selection)
- Requires `advanced-tool-use-2025-11-20` beta header
- Supported on Sonnet 4.5/4.6 and Opus 4.5/4.6 only

**Agent Skills Architecture:**
Anthropic's blog "Equipping Agents for the Real World with Agent Skills" describes their recommended pattern:

> "Progressive disclosure is the core design principle that makes Agent Skills flexible and scalable. Skills let Claude load information only as needed, so agents with a filesystem and code execution tools don't need to read the entirety of a skill into their context window."

Their recommended flow:
1. Load a skill index (names + descriptions) into the system prompt
2. Agent reads full skill content from filesystem on demand
3. References stay as separate files, read only when needed

**Prompt Caching:**
Anthropic's caching system requires:
1. Beta header: `anthropic-beta: prompt-caching-2024-07-31`
2. System content wrapped in: `cache_control: {"type": "ephemeral"}`
3. Static content FIRST in the prompt (before dynamic conversation)

Pricing:
- Cache write: 1.25x normal input price ($3.75/M for Sonnet)
- Cache read: 0.1x normal input price ($0.30/M for Sonnet)
- TTL: 5 minutes (refreshed on each cache hit)

**Key finding:** Claude Code achieves ~98% cost reduction through aggressive prompt caching combined with deferred tool loading.

**Claude Code Leaked Source Analysis (github.com/ultraworkers/claw-code):**

From the actual Claude Code implementation:

1. **Two-tier tool architecture:** `mvp_tool_specs()` (~40 core tools always loaded) vs `deferred_tool_specs()` (hundreds of tools, loaded on demand via `ToolSearch`). The `GlobalToolRegistry.definitions()` only returns MVP tools — deferred tools are never in API calls.

2. **System prompt boundary:** Claude Code splits its system prompt at `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` — everything above is static and cacheable (role instructions, behavioral rules), everything below is per-session (environment, project context, CLAUDE.md files). This maximizes server-side cache hits.

3. **System prompt is TINY:** ~1,500-4,500 tokens total. Static sections ~1,000 tokens. Instruction files budgeted at 12K chars max (4K per file). Compare to our 189K tokens — **we load 40-120x more context than Claude Code.**

4. **Client-side completion cache:** FNV-1a hash of (model + system + tools + messages). Cached responses returned without API call within 30s TTL. Tracks "unexpected cache breaks" to detect prompt instability.

5. **Auto-compaction at 100K input tokens:** Summarizes old messages, keeps 4 recent, hard limits summaries to 1,200 chars / 24 lines. Structured priority-based line selection.

6. **Instruction file budget enforcement:** `MAX_INSTRUCTION_FILE_CHARS = 4,000` per file, `MAX_TOTAL_INSTRUCTION_CHARS = 12,000` total. Our skills are 371K chars — **31x over Claude Code's budget.**

**The most important pattern for us:** The `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` approach. Structure our system prompt as: [static behavioral instructions + skill index (cached)] → BOUNDARY → [per-user SOUL.md, MEMORY.md, workspace (dynamic)]. This is exactly what Approach A does when we wrap the system prompt with `cache_control`.

### 3.2 Manus AI

**Source:** [Context Engineering for AI Agents: Lessons from Building Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)

**Critical Insight — The Cache Paradox:**
Manus discovered that **dynamically changing which tools/skills are loaded per call HURTS cost efficiency** because it invalidates the prompt cache. Their approach:

- Keep ALL tools in the prompt at ALL times (preserving KV-cache)
- Use a state machine + logit masking to prevent the model from selecting irrelevant tools
- Tool names use consistent prefixes (`browser_*`, `shell_*`) for group-level masking
- **KV-cache hit rate is their #1 cost metric** — cache invalidation is more expensive than large context

**File System as Infinite Memory:**
- Large observations and reference data go to disk, only a pointer stays in context
- Agent reads files back on demand
- 100:1 input-to-output token ratio is typical

**Task Recitation:**
- Continuously updated `todo.md` keeps goals in the model's recent attention window
- Combats "lost in the middle" effects for long contexts

**Applicability to InstaClaw:**
Manus's approach validates Approach A (pure caching). For our architecture, keeping all skills loaded with caching is likely optimal because:
1. Skills are identical across users (potential cross-user cache sharing)
2. Cache invalidation from dynamic loading costs more than the larger context
3. Our proxy is the perfect place to add caching without changing OpenClaw

### 3.3 OpenClaw Native Features

**Source:** [OpenClaw Context Docs](https://docs.openclaw.ai/concepts/context), [DeepWiki: OpenClaw Skills System](https://deepwiki.com/openclaw/openclaw/5.2-skills-system), [GitHub Issue #46623](https://github.com/openclaw/openclaw/issues/46623)

**maxSkillsPromptChars:**
OpenClaw has a three-tier skill loading strategy:

| Mode | Trigger | What's Loaded | Token Impact |
|------|---------|---------------|-------------|
| **Full Format** | Total skills < maxSkillsPromptChars | Complete SKILL.md + references | 189K tokens (our current state) |
| **Compact Format** | Total skills > maxSkillsPromptChars | Name + description + file path only | ~2-5K tokens |
| **Truncated Compact** | Even compact exceeds limit | Binary search to fit max headers | ~1-2K tokens |

**Our configuration:**
- `maxSkillsPromptChars`: **500,000** (we overrode the default of **30,000**)
- `bootstrapMaxChars`: 30,000
- `bootstrapTotalMaxChars`: 150,000 (default)

**Why we overrode it:** In an earlier sprint, lowering maxSkillsPromptChars caused **3 fleet-wide outages** because skills were silently truncated. The 500K override was a safety measure to ensure all skills always load in Full Format.

**The implication:** OpenClaw already has Compact Format built in. If we carefully set maxSkillsPromptChars to a value that triggers Compact Format (e.g., 10K-50K), skills would load as lightweight headers and agents would read full SKILL.md from disk when needed. But this carries risk — the previous outages make this a careful testing scenario.

**Community Tool:**
[openclaw-token-optimizer](https://github.com/openclaw-token-optimizer/openclaw-token-optimizer) — replaces all tools with a single `search_available_tools()` meta-tool. Skills are loaded lazily on demand. Claims 50-80% token savings. Uses Anthropic prompt caching markers for 90% discount on static context.

### 3.4 RouteLLM (LMSYS / UC Berkeley)

**Source:** [RouteLLM Paper](https://arxiv.org/abs/2406.18665), [GitHub](https://github.com/lm-sys/RouteLLM)

RouteLLM is a framework for cost-efficient LLM routing. Key findings:

- **Matrix factorization router** achieves 95% of GPT-4 quality while routing only 14% of calls to GPT-4
- Overall cost reduction: 35-85% depending on workload
- Four router architectures:
  1. Matrix Factorization (best for quality/cost tradeoff)
  2. BERT classifier
  3. Causal LLM router
  4. Similarity-weighted ranking

**Applicability:** We already have model routing (Sonnet/Opus/Haiku budgets per tier + MiniMax for heartbeats). RouteLLM could further optimize by routing simple queries to Haiku ($0.80/M vs $3/M for Sonnet) instead of using tier budgets. Estimated additional savings: 20-40% on the remaining Anthropic spend after caching.

### 3.5 Prompt Caching Deep Dive

**Cross-Provider Comparison:**

| Feature | Anthropic | OpenAI | Google Gemini |
|---------|-----------|--------|---------------|
| Caching type | Explicit (cache_control) | Automatic | Both |
| Read discount | 90% | 50-90% | 90% |
| Write premium | 25% | None | 25% |
| TTL | 5 min (ephemeral) / 1 hr (persistent) | Auto-managed | ~5 min |
| Min tokens | 1,024 (Sonnet), 2,048 (Opus) | Varies | 32,768 |
| Breakpoints | Up to 4 per prompt | N/A | N/A |

**The Golden Rule:** Static content FIRST, dynamic content LAST. Any change to the prefix invalidates the entire cache. This means:
- System prompt (static): cached ✅
- Conversation history (dynamic): NOT cached ✅ (it's after the prefix)
- Skills in deterministic order: cached across calls ✅

**Anthropic's Extended Caching (Jan 2025):**
Added 1-hour persistent caching with 2x write premium. For our use case, the 5-minute ephemeral cache is sufficient — users typically send messages more frequently than every 5 minutes within a session.

### 3.6 LLMLingua (Microsoft Research)

**Source:** [LLMLingua Paper](https://arxiv.org/abs/2310.05736), [LLMLingua-2](https://arxiv.org/abs/2403.12968)

Prompt compression framework:

- **LLMLingua:** 20x compression with 1.5% performance loss
- **LongLLMLingua:** 21.4% RAG improvement at 25% of tokens
- **LLMLingua-2:** 3-6x faster, data-distillation approach

**Applicability:** High potential for compressing skill reference docs before loading. However, prompt caching is a simpler and higher-impact first step. LLMLingua is a Phase 6 optimization.

### 3.7 Hermes / Nous Research

**Source:** NousResearch GitHub, Hermes 2 Pro / Hermes 3 model cards

Deep analysis of Hermes's tool calling approach:

- Uses ChatML format with XML-like `<tools>` tags for tool definitions
- Tool definitions are JSON schemas inside the tags — **no token savings over standard Anthropic/OpenAI formats**
- Token cost per tool definition: ~130-140 tokens (same as Anthropic)
- **No built-in tool routing** — all tools must be loaded in every call
- Community patterns for Hermes multi-tool:
  1. Two-stage routing (cheap classifier → expensive executor)
  2. Tool clustering by category
  3. Compressed tool descriptions (~40-50 tokens vs ~130)

**Key Finding:** Hermes validates that the solution must be at the application architecture level, not the prompt format level. There are no format tricks that reduce tool context significantly — the fix is structural (caching, progressive loading, or routing).

### 3.8 Industry Economics

| Company | Metric | Implication |
|---------|--------|-------------|
| AI app gross margins (2026 avg) | 52% | InstaClaw at -100% is far below industry |
| GitHub Copilot | Lost $20/user/month at $10 sub | Even $20 loss/user is unsustainable |
| Cursor | ~$2B ARR, ~100% on AI costs | High revenue can mask thin margins temporarily |
| Perplexity | Saves ~$1M/year self-hosting one feature | Self-hosting ROI kicks in at $50-100K/mo API spend |
| Anthropic pricing trend | 10x cheaper in 18 months | Costs will decrease — but we can't wait |

**InstaClaw's position:** At -100% margin, every new user makes us lose MORE money. Fixing API costs is prerequisite to sustainable growth.

### 3.9 Devin (Cognition Labs)

**Source:** [Devin Annual Performance Review 2025](https://cognition.ai/blog/devin-annual-performance-review-2025)

- Multi-model swarm: Planner (reasoning), Coder (code-specialized), Critic (adversarial reviewer)
- Each model sees only the context it needs
- Repository indexing: auto-indexes repos into searchable wikis
- Agent queries the index rather than loading full files

### 3.10 Perplexity

**Source:** [Perplexity Computer Explained](https://www.buildfastwithai.com/blogs/what-is-perplexity-computer)

- Multi-model routing: orchestrates 19 different AI models via meta-router
- Their CTO stated MCP tool schema consumes up to **72% of context window** — so they moved away from MCP to direct REST/CLI calls
- Sub-agent architecture for complex tasks

### 3.11 Cursor / Windsurf

- Both build full semantic indexes of the codebase on first open
- Queries retrieve relevant code without loading entire files
- Context layers: global rules > project summaries > task-specific references > auto-enrichment
- Windsurf's M-Query: custom retrieval method that beats cosine similarity
- User reports confirm quality degrades at 70-90% context utilization — we start at ~100%

---

## 4. Architecture Options Analyzed

### 4.1 Approach A: Pure Caching (Manus Way)

**What it is:** Add Anthropic prompt caching headers to our proxy. Keep the existing 189K token system prompt unchanged. The system prompt becomes cached after the first call in each session — subsequent calls pay 90% less for the system context.

**Implementation:**
1. Add `prompt-caching-2024-07-31` to the `anthropic-beta` header in proxy/route.ts
2. Convert the `system` field from string to array with `cache_control: {"type": "ephemeral"}`

**Cost Model:**

```
Per Sonnet call (current — no caching):
  System: 189,000 × $3.00/M = $0.567
  User msg: 2,000 × $3.00/M = $0.006
  Output: 800 × $15.0/M = $0.012
  TOTAL: $0.585

Per Sonnet call (cache WRITE — first call):
  System: 189,000 × $3.75/M = $0.709
  User msg + output: $0.018
  TOTAL: $0.727

Per Sonnet call (cache READ — subsequent calls):
  System: 189,000 × $0.30/M = $0.057
  User msg + output: $0.018
  TOTAL: $0.075

Savings per cached call: $0.585 - $0.075 = $0.510 (87%)
```

**Fleet-wide (calibrated against $375/day actual):**
- ~641 Anthropic calls/day
- ~107 sessions/day (cache writes): 107 × $0.727 = $77.80
- ~534 subsequent calls/day (cache reads): 534 × $0.075 = $40.05
- **Daily: $117.85 → Monthly: $3,536**
- **Savings: $7,714/mo (69%)**

| Metric | Value |
|--------|-------|
| Monthly cost | $3,536 |
| Monthly savings vs current | $7,714 |
| Reduction | 69% |
| Effort | LOW (30 minutes, 2 code changes) |
| Risk | ZERO — identical API calls, just cheaper |
| Cache hit rate | ~83% (5/6 calls per session) |

### 4.2 Approach B: Compact Skills + Caching

**What it is:** Lower OpenClaw's `maxSkillsPromptChars` from 500,000 to 10,000. This triggers OpenClaw's built-in Compact Format, which loads skills as name + description + file path only (~2-5K tokens instead of 93K). Agents read full SKILL.md from disk when needed. Combined with prompt caching on the smaller prefix.

**System prompt:** ~20K tokens (workspace 16K + compact skill headers 2K + overhead 2K)

**Cost Model:**

```
Per Sonnet call (cache READ on 20K prefix):
  System: 20,000 × $0.30/M = $0.006
  Skill file read (when needed): ~5,000 × $3.00/M = $0.015
  User msg + output: $0.018
  TOTAL: ~$0.039
```

**Fleet-wide:**
- 641 calls/day
- Cache writes: 107 × $0.094 = $10.06
- Cache reads: 534 × $0.024 = $12.82
- Skill file reads: ~300 × $0.015 = $4.50
- **Daily: $27.38 → Monthly: $821**
- **Savings: $10,429/mo (93%)**

| Metric | Value |
|--------|-------|
| Monthly cost | $821 |
| Monthly savings vs current | $10,429 |
| Reduction | 93% |
| Effort | MEDIUM (config change + cache headers + fleet push + testing) |
| Risk | MEDIUM — Compact Format caused 3 outages previously |
| Cache hit rate | ~83% (prefix never changes) |

**Risk detail:** The 3 previous outages occurred because skills were silently truncated and agents lost capability. Compact Format should NOT truncate — it loads names + descriptions for all skills. The outages likely came from Truncated Compact mode or from the skill limit being set too low for even compact headers. Careful testing with progressive limit reduction (500K → 200K → 100K → 50K → 10K) on a canary VM would identify the safe threshold.

### 4.3 Approach C: Tiered Context Architecture (Cooper's Hybrid Concept)

**What it is:** A four-layer context system inspired by the best of Manus (stable prefix), Anthropic (progressive disclosure), and our unique VM-based architecture:

**Layer 0 — Always Loaded, Cache-Stable (~20K tokens):**
- Core workspace files: SOUL.md (27K chars), MEMORY.md, USER.md, IDENTITY.md, EARN.md
- SKILLS-INDEX.md: 1-2 line descriptions of all 23 skills
- Instructions: "Read full skill content from `~/.openclaw/skills/<name>/SKILL.md` when needed"
- This is the immutable prefix that gets cached at 90% discount

**Layer 1 — Session-Sticky Skills:**
- When a user's conversation activates a skill (e.g., mentions trading), the agent reads the full SKILL.md via filesystem tools
- The content appears in the conversation (tool result), NOT in the system prompt
- The system prompt prefix doesn't change → cache stays valid
- Once loaded, the skill content is in the conversation context for the rest of the session

**Layer 2 — On-Demand References:**
- references/*.md NEVER loaded into context
- Agent reads them from disk when it needs API docs, strategy guides, or examples
- `~/.openclaw/skills/<name>/references/` is always available on the filesystem

**Layer 3 — Heartbeat Isolation:**
- Heartbeats use MiniMax with minimal context (~2K tokens)
- No skills, no conversation history
- Already implemented in current architecture

**Cost model:** Essentially identical to Approach B (~$821/mo) because the system prompt size and caching behavior are the same. The difference is in how skills are loaded (session-sticky vs per-call read).

| Metric | Value |
|--------|-------|
| Monthly cost | $821-$1,100 |
| Monthly savings | $10,150-$10,429 |
| Reduction | 90-93% |
| Effort | HIGH (requires skill index creation, system prompt modification, testing) |
| Risk | MEDIUM (agent may miss skills if index descriptions are vague) |

### 4.4 Approach D: Cross-User Cache Sharing (THE NOVEL APPROACH)

**What it is:** An InstaClaw-specific innovation leveraging our unique architecture — all 105+ users share a single Anthropic API key through our centralized proxy. The skills portion of the system prompt (93K tokens) is **identical across all users.** By restructuring the system prompt so skills come first (as a separate cached content block), we enable cross-user cache sharing.

**How it works:**

Anthropic's cache key is based on:
1. The API key (shared across all users via our proxy)
2. The exact prefix content

If we structure the system prompt as two content blocks:

```json
{
  "system": [
    {
      "type": "text",
      "text": "[ALL SKILLS — identical for every user]",
      "cache_control": {"type": "ephemeral"}
    },
    {
      "type": "text", 
      "text": "[WORKSPACE — per-user: SOUL.md, MEMORY.md, USER.md, etc.]"
    }
  ]
}
```

The first block (93K tokens of skills) gets cached and shared across ALL users' API calls. With 641 calls/day across 105 users, the skills cache stays permanently hot. Only the per-user workspace portion (16K tokens) is unique.

**Why this is only possible for InstaClaw:**
- We have a centralized proxy (one API key for all users)
- Skills are deployed identically to all VMs (same content, same order)
- Per-user customization (SOUL.md, MEMORY.md) is in a SEPARATE content block
- Most agent platforms don't have this architecture — they use per-user API keys or serverless functions

**Cost Model:**

```
Skills (93K tokens): Cached across all users
  Write: Once every 5 min (1 user keeps it hot) = ~288 writes/day
  Reads: 641 - 288 = ~353 reads/day at $0.30/M
  
Workspace (16K tokens): Per-user, NOT cached
  Always full price: 641 × 16K × $3/M = $30.77/day

User msg + output: $0.018 × 641 = $11.54/day

Skills write cost: 288 × 93K × $3.75/M = $100.44/day
Skills read cost: 353 × 93K × $0.30/M = $9.84/day
Workspace cost: $30.77/day
User + output: $11.54/day

TOTAL DAILY: $152.59 → MONTHLY: $4,578
```

Wait — this is actually MORE expensive than Approach A because the workspace portion (16K tokens) loses caching. In Approach A, the ENTIRE system prompt (skills + workspace) is cached per-user — both portions get the 90% discount within a session.

**Revised analysis:** Cross-user sharing on skills is beneficial when:
- Users have very short sessions (1-2 messages, no intra-session cache warmup)
- Many users are active simultaneously (keeping the shared cache hot)

For our usage pattern (avg 6 calls/session), per-user caching (Approach A) is actually more efficient because it caches the ENTIRE system prompt including workspace.

**Revised verdict:** Approach D is less cost-effective than Approach A for our current usage patterns. It becomes advantageous at scale (500+ users) where the shared skills cache serves more users between TTL refreshes. Filed as a future optimization.

| Metric | Value |
|--------|-------|
| Monthly cost | $4,578 (less efficient than Approach A for current fleet) |
| Monthly savings | $6,672 |
| Reduction | 59% |
| Effort | MEDIUM-HIGH |
| Risk | MEDIUM |
| **Best for** | **500+ users (future)** |

**Potentially publishable:** "Multi-tenant prompt cache sharing via proxy-level system prompt decomposition" — novel contribution to the field, even if not optimal for our current scale.

### 4.5 Comparison Table

| Approach | Monthly Cost | Savings | Reduction | Effort | Risk | Best For |
|----------|-------------|---------|-----------|--------|------|----------|
| Current (no caching) | $11,250 | — | — | — | — | — |
| **A: Pure Caching** | **$3,536** | **$7,714** | **69%** | **LOW** | **ZERO** | **Today** |
| B: Compact + Cache | $821 | $10,429 | 93% | MEDIUM | MEDIUM | Week 3 |
| C: Tiered Context | $821-1,100 | $10,150-10,429 | 90-93% | HIGH | MEDIUM | Month 2 |
| D: Cross-User Cache | $4,578 | $6,672 | 59% | MED-HIGH | MEDIUM | 500+ users |
| A + Skill Trimming | $2,475 | $8,775 | 78% | LOW-MED | LOW | Week 2 |

**Winner for today: Approach A.** Zero risk, 30-minute implementation, $7,714/mo savings.

---

## 5. Recommended Implementation Plan

### Phase 1: Enable Prompt Caching (Day 1 — IMMEDIATE)

**What:** Add Anthropic prompt caching to our proxy. Two code changes.

**Changes in `instaclaw/app/api/gateway/proxy/route.ts`:**

1. Add `prompt-caching-2024-07-31` to the `anthropic-beta` header (line ~826):
```typescript
// After the interleaved-thinking beta header logic:
if (!existing.includes("prompt-caching-2024-07-31")) {
  providerHeaders["anthropic-beta"] = existing
    ? `${existing},prompt-caching-2024-07-31`
    : "prompt-caching-2024-07-31";
}
```

2. Wrap the `system` field with `cache_control` (before `providerBody = JSON.stringify(parsedBody)`):
```typescript
// Convert system string to cached content block
if (typeof parsedBody?.system === "string" && parsedBody.system.length > 4096) {
  parsedBody.system = [
    {
      type: "text",
      text: parsedBody.system,
      cache_control: { type: "ephemeral" },
    },
  ];
}
```

**Testing:**
1. Deploy to staging/preview branch first
2. Test on vm-059 (Cooper's VM)
3. Verify `cache_creation_input_tokens` appears in first response
4. Verify `cache_read_input_tokens` appears in subsequent responses
5. Monitor Anthropic console for 24 hours
6. Deploy to production

**Expected impact:** $7,714/mo savings (69% reduction in Anthropic API costs)

**Rollback:** Remove the two code changes. Zero residual impact.

### Phase 2: Skill Trimming (Week 1-2)

**What:** Reduce the size of the cached prefix by trimming bloated skills and removing unnecessary content. Smaller prefix = cheaper cache writes.

**Action items (in order of impact):**

1. **Delete duplicate polymarket/ directory** — exact copy of prediction-markets/references/ (4 files, ~47K chars of pure waste). Already confirmed duplicate.

2. **Remove language-teacher references** — 112K chars across 6 files, built specifically for ONE user (Renata). Represents 15% of entire context. Options:
   a. Move to a separate directory that OpenClaw doesn't auto-load
   b. Condense into a summary file (10K chars max)
   c. Remove entirely — the SKILL.md (20K) still has teaching instructions

3. **Compress top 5 largest SKILL.md files:**
   - prediction-markets/SKILL.md: 42K → target 25K (remove inline API examples)
   - motion-graphics/SKILL.md: 36K → target 20K (remove template examples)
   - dgclaw/SKILL.md: 22K → target 15K (condense strategy section)
   - sjinn-video/SKILL.md: 22K → target 14K
   - code-execution/SKILL.md: 20K → target 14K

4. **Move all references/*.md to a non-auto-loaded directory:**
   - Rename `references/` to `docs/` or `knowledge/` across all skills
   - Verify OpenClaw doesn't auto-load from these directories
   - Add instructions to SKILL.md: "Read reference docs from `./docs/` when needed"
   - Impact: removes 81K tokens (43% of context) from every call

**Expected impact:** 30-50% reduction in system prompt size → 30-50% cheaper cache writes → additional $1,000-2,000/mo savings on top of Phase 1.

### Phase 3: Compact Skills Evaluation (Week 3)

**What:** Test OpenClaw's built-in Compact Format by lowering `maxSkillsPromptChars`.

**Approach:**
1. Test on canary VM (vm-059) ONLY
2. Progressive reduction: 500K → 300K → 200K → 100K → 50K → 10K
3. At each level, verify:
   - Agent can list available skills
   - Agent can invoke a specific skill when asked
   - Agent handles multi-skill conversations
   - No silent skill truncation
4. Find the sweet spot where Compact Format activates cleanly

**If successful:** Deploy fleet-wide via manifest v56+ config push.

**Expected impact:** If we reach 10K limit with Compact Format + caching: $821/mo total API cost (93% reduction).

**Risk mitigation:** Always test on canary first. Have the current 500K config as immediate rollback. Monitor agent quality for 48 hours before fleet push.

### Phase 4: Model Routing Optimization (Month 2)

**What:** Evaluate routing more queries to Haiku (10x cheaper than Sonnet) and reducing Sonnet/Opus budget limits.

**Approach:**
1. Analyze: what % of queries are simple enough for Haiku?
2. Test: does Haiku handle common user queries acceptably?
3. If yes: increase the share of queries routed to Haiku
4. Consider RouteLLM-style matrix factorization router

**Expected impact:** 20-40% additional reduction on remaining Anthropic spend.

### Phase 5: Cross-User Cache Sharing (Month 2-3)

**What:** Implement Approach D when user count exceeds 250+.

**Approach:**
1. Parse system prompt in proxy to identify skills vs workspace boundary
2. Split into two content blocks: skills (cached, shared) + workspace (per-user)
3. Ensure deterministic skill ordering across all VMs
4. Test with multiple simultaneous users

**Expected impact:** Diminishing returns at current scale, but significant at 500+ users.

### Phase 6: Advanced Optimizations (Month 3+)

- LLMLingua prompt compression evaluation
- RAG-based skill knowledge loading
- Session-aware context management
- Self-hosting evaluation (threshold: $50-100K/mo API spend)
- Anthropic batch API for non-real-time tasks

---

## 6. Success Metrics

### Primary Metrics

| Metric | Current | Phase 1 Target | Phase 2 Target | Phase 3 Target |
|--------|---------|---------------|---------------|---------------|
| Monthly Anthropic spend | $11,250 | <$4,000 | <$3,000 | <$1,000 |
| Cache hit rate | 0% | >80% | >85% | >90% |
| Effective cost per Sonnet call | $0.585 | <$0.10 | <$0.05 | <$0.03 |
| Fleet gross margin | -100% | 2%+ | 15%+ | 50%+ |

### Secondary Metrics

| Metric | Target |
|--------|--------|
| cache_creation_input_tokens per day | <200 (one per session) |
| cache_read_input_tokens per day | >400 (majority of calls) |
| P95 latency (no degradation) | <5s response time |
| Skill invocation accuracy | No decrease from baseline |

### Guard Rails

| Guard Rail | Threshold | Action |
|-----------|-----------|--------|
| Agent response quality | Any reported degradation | Rollback immediately |
| Skill invocation accuracy | <90% correct skill selection | Rollback, improve index |
| User complaints ("agent is dumber") | >3 in 24 hours | Investigate and rollback if needed |
| Cache hit rate drops below 50% | <50% | Investigate prefix stability |
| API error rate increase | >1% of calls | Rollback, check header formatting |

---

## 7. Risk Mitigation

### Phase 1 Risks (Pure Caching)

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|-----------|
| Beta header rejected by API | Very Low | Medium | Test on staging first; header is well-documented |
| System prompt as array breaks OpenClaw | Low | High | Test on canary VM; verify OpenClaw handles array system prompt in responses |
| Cache invalidation between calls | Low | Low | Monitor cache_read_input_tokens; debug if <50% hit rate |
| Cost INCREASE on cache writes | None | None | 1.25x write + 0.1x reads is ALWAYS cheaper for 2+ calls/session |

**Rollback plan:** Remove the two code changes, redeploy. Zero residual impact.

### Phase 2 Risks (Skill Trimming)

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|-----------|
| Removing important skill content | Medium | High | Review each change with Cooper; keep originals as backups |
| Agent can't find references on disk | Low | Medium | Test filesystem reads on canary VM first |
| Renata loses language teacher quality | Medium | Low | Communicate with affected user before changing |

### Phase 3 Risks (Compact Skills)

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|-----------|
| Silent skill truncation (previous 3 outages) | Medium | Critical | Progressive testing at each threshold level |
| Agent doesn't read SKILL.md from disk | Medium | High | Verify Compact Format includes file paths |
| Quality degradation from 2-step skill loading | Low | Medium | Test with diverse conversation types |

---

## 8. Technical Implementation Details

### 8.1 File Paths

| File | Purpose | Changes Needed |
|------|---------|---------------|
| `instaclaw/app/api/gateway/proxy/route.ts` | Main API proxy | Phase 1: add caching headers |
| `instaclaw/lib/vm-manifest.ts` | VM configuration manifest | Phase 2/3: maxSkillsPromptChars |
| `instaclaw/skills/*/SKILL.md` | Skill instructions | Phase 2: trimming |
| `instaclaw/skills/*/references/*.md` | Skill reference docs | Phase 2: move to non-loaded dir |

### 8.2 Phase 1 Code Changes (Exact Diff)

**File:** `instaclaw/app/api/gateway/proxy/route.ts`

**Change 1:** Add prompt caching beta header (after line ~830):
```typescript
// Add prompt caching beta header for Anthropic calls
const betaForCaching = "prompt-caching-2024-07-31";
if (!providerHeaders["anthropic-beta"]?.includes(betaForCaching)) {
  providerHeaders["anthropic-beta"] = providerHeaders["anthropic-beta"]
    ? `${providerHeaders["anthropic-beta"]},${betaForCaching}`
    : betaForCaching;
}
```

**Change 2:** Wrap system prompt with cache_control (before line ~835 `providerBody = ...`):
```typescript
// Enable prompt caching: wrap system prompt as cached content block
// This makes the static system context (skills, workspace) cache at 90% discount
// Only the first call per session pays full price; subsequent calls get cache reads
if (parsedBody?.system && typeof parsedBody.system === "string" && parsedBody.system.length > 4096) {
  parsedBody.system = [
    {
      type: "text",
      text: parsedBody.system,
      cache_control: { type: "ephemeral" },
    },
  ];
}
```

**Change 3:** Log cache metrics for monitoring (in the response handling section):
```typescript
// Log cache metrics for cost monitoring
if (responseData?.usage) {
  const cacheCreate = responseData.usage.cache_creation_input_tokens ?? 0;
  const cacheRead = responseData.usage.cache_read_input_tokens ?? 0;
  if (cacheCreate > 0 || cacheRead > 0) {
    logger.info("CACHE_METRICS", {
      route: "gateway/proxy",
      vmId: vm.id,
      cacheCreate,
      cacheRead,
      inputTokens: responseData.usage.input_tokens,
      model: requestedModel,
    });
  }
}
```

### 8.3 How OpenClaw Constructs the System Prompt

From codebase analysis:

1. OpenClaw reads all workspace files (`~/.openclaw/workspace/*.md`)
2. OpenClaw reads all skill files (`~/.openclaw/skills/*/SKILL.md` + `references/*.md`)
3. These are concatenated into a single string
4. The string is sent as the `system` field in the Anthropic API call
5. OpenClaw routes through our proxy (configured in `openclaw.json`: `models.providers.anthropic.baseUrl: "https://instaclaw.io/api/gateway"`)
6. Our proxy receives `parsedBody.system` as a string and forwards to Anthropic

**Key insight:** The system prompt is a SINGLE STRING when it reaches our proxy. We can transform it into an ARRAY of content blocks with `cache_control` before forwarding. This is transparent to OpenClaw — it sends a string, we forward an array, Anthropic accepts both.

### 8.4 Prompt Caching Test Results (April 5, 2026)

```
Test 1 — WITHOUT cache_control (current behavior):
  API call with 3,011 token system prompt
  Response: input_tokens=3011, cache_creation=0, cache_read=0
  → No caching at all

Test 2 — WITH cache_control + beta header:
  Call 1: cache_creation_input_tokens=3003, cache_read=0 (WRITE)
  Call 2: cache_creation=0, cache_read_input_tokens=3003 (READ — 90% discount!)
  → Caching works perfectly when enabled
```

---

## 9. Open Questions

1. **Does Anthropic's cache key include the full API key hash?** If yes, all calls through our proxy share the same cache namespace — enabling cross-user cache sharing on identical prefixes (Approach D).

2. **What's the exact boundary between skills and workspace in OpenClaw's system prompt?** Needed for Approach D (splitting into two content blocks). Can we detect a delimiter, or do we need to parse based on known markers (e.g., SKILL.md headers)?

3. **Can we add multiple `cache_control` breakpoints within the system array?** Anthropic allows up to 4. We could cache skills and workspace separately, enabling cross-user sharing on skills while keeping per-user workspace uncached.

4. **Should heartbeats use Haiku instead of MiniMax?** MiniMax is cheap (~$0.001/call) but doesn't contribute to Anthropic cache warming. If heartbeats used Haiku through Anthropic (with the same cached prefix), they'd keep the cache warm between user messages.

5. **What's the Anthropic batch API pricing?** Could heartbeats and background tasks use batch API (typically 50% cheaper) for non-real-time operations?

6. **Does OpenClaw's Compact Format include the file system path for each skill?** If not, the agent won't know WHERE to read the full SKILL.md. This is critical for Phase 3.

7. **How deterministic is OpenClaw's skill loading order?** For caching to work across restarts, skills must be concatenated in the same order every time. If OpenClaw loads from filesystem (alphabetical by directory), this is deterministic. If it uses a config-driven order, we need to verify it's stable.

---

## 10. Appendices

### Appendix A: Full Skill Size Breakdown

| Skill | SKILL.md | references/*.md | Total | % of All Skills |
|-------|----------|----------------|-------|----------------|
| prediction-markets | 41,914 | 53,904 | 95,818 | 13.8% |
| language-teacher | 20,170 | 111,608 | 131,778 | 19.0% |
| motion-graphics | 35,953 | 8,654 | 44,607 | 6.4% |
| dgclaw | 22,481 | 36,469 | 58,950 | 8.5% |
| sjinn-video | 21,826 | 25,003 | 46,829 | 6.8% |
| higgsfield-video | 15,072 | 27,890 | 42,962 | 6.2% |
| web-search-browser | 18,142 | 17,248 | 35,390 | 5.1% |
| code-execution | 20,373 | 7,474 | 27,847 | 4.0% |
| ecommerce-marketplace | 17,543 | 8,650 | 26,193 | 3.8% |
| marketplace-earning | 22,889 | 22,889* | 45,778 | 6.6% |
| financial-analysis | 13,723 | 6,057 | 19,780 | 2.9% |
| email-outreach | 16,370 | 3,030 | 19,400 | 2.8% |
| competitive-intelligence | 13,156 | 5,098 | 18,254 | 2.6% |
| voice-audio-production | 13,856 | 3,376 | 17,232 | 2.5% |
| social-media-content | 11,867 | 4,855 | 16,722 | 2.4% |
| computer-dispatch | 15,997 | 0 | 15,997 | 2.3% |
| brand-design | 10,309 | 3,252 | 13,561 | 2.0% |
| instagram-automation | 12,470 | 0 | 12,470 | 1.8% |
| x-twitter-search | 10,117 | 0 | 10,117 | 1.5% |
| solana-defi | 8,516 | 0 | 8,516 | 1.2% |
| agentbook | 6,363 | 0 | 6,363 | 0.9% |
| clawlancer | 1,319 | 0 | 1,319 | 0.2% |
| agent-status | 683 | 0 | 683 | 0.1% |
| **TOTAL** | **371,109** | **322,568** | **693,677** | **100%** |

*marketplace-earning references not separately measured; included in SKILL.md total.

**Anomalies:**
- **bankr** has NO SKILL.md file — only 366K of reference docs in `references/` and subdirectories. These may or may not be loading into context depending on how OpenClaw handles skills without a SKILL.md.
- **motion-graphics** has a 301MB `node_modules/` directory inside its `assets/` folder (11,204 files). These are NOT loaded into LLM context (only `.md` files are) but waste 301MB of disk per VM.

**Top 3 skills by total size consume 40% of all skill content:**
1. language-teacher: 131K (19%)
2. prediction-markets: 96K (14%)
3. dgclaw: 59K (9%)

### Appendix B: Top 5 Biggest References Files

| File | Size | Content |
|------|------|---------|
| language-teacher/lesson-templates.md | 58K | 8 full lesson templates with complete exercises. Built for ONE user (Renata). |
| dgclaw/strategy-playbook.md | 33K | DegenClaw trading strategy guide. Competitive edge material. |
| language-teacher/common-mistakes-pt-en.md | 27K | Portuguese→English error patterns for Brazilian speakers. |
| language-teacher/common-mistakes-en-pt.md | 22K | English→Portuguese error patterns. |
| language-teacher/common-mistakes-es-en.md | 22K | Spanish→English error patterns. |

**Language teacher references alone: 162K chars = 23% of total skill content.** These are loaded into EVERY call for EVERY user, even though only one user (Renata) uses this skill.

### Appendix C: Prompt Caching Test Results

**Test environment:** Direct Anthropic API calls from vm-059 on April 5, 2026.

**Test 1 — Without caching (current behavior):**
```json
Request: {
  "model": "claude-sonnet-4-6",
  "system": "You are a helpful assistant. [repeated 500x = 3K tokens]",
  "messages": [{"role": "user", "content": "say ok"}]
}
Response.usage: {
  "input_tokens": 3011,
  "output_tokens": 4,
  "cache_creation_input_tokens": 0,
  "cache_read_input_tokens": 0
}
```

**Test 2 — With caching enabled:**
```json
Request: {
  "model": "claude-sonnet-4-6",
  "system": [{"type": "text", "text": "...[same content]...", "cache_control": {"type": "ephemeral"}}],
  "messages": [{"role": "user", "content": "say ok"}]
}
Headers: { "anthropic-beta": "prompt-caching-2024-07-31" }

Call 1 Response.usage: {
  "input_tokens": 8,
  "cache_creation_input_tokens": 3003,  // CACHE WRITE
  "cache_read_input_tokens": 0
}

Call 2 Response.usage (3 seconds later): {
  "input_tokens": 8,
  "cache_creation_input_tokens": 0,
  "cache_read_input_tokens": 3003  // CACHE HIT — 90% discount!
}
```

### Appendix D: April API Cost Breakdown

| Date | Daily Cost | VMs Active | Key Events |
|------|-----------|-----------|------------|
| Apr 1 | ~$400 | 230+ | Restart storms (286+ restarts on some VMs) |
| Apr 2 | ~$300 | 230+ | Restart storms continuing |
| Apr 3 | ~$400 | 230→80 | Fixes deployed, 150 VMs deleted mid-day |
| Apr 4 | ~$400 | 169 | Resize operations (all VMs restarted) |
| Apr 5 | ~$200* | 169 | Steady state, partial day |
| **Total** | **$1,874** | | |

*Partial day — projected full day ~$250.

**Pre-fix (Apr 1-2):** $350/day avg with 230 VMs = $1.52/VM/day
**Post-fix (Apr 5):** ~$250/day with 169 VMs = $1.48/VM/day

Steady state estimate: $250-350/day = **$7,500-10,500/mo**

### Appendix E: Research Sources and Links

| Source | URL | Key Finding |
|--------|-----|-------------|
| Anthropic: Tool Search Tool | platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool | Deferred loading: 968 tokens vs 14-16K |
| Anthropic: Prompt Caching | platform.claude.com/docs/en/build-with-claude/prompt-caching | 90% read discount, 25% write premium |
| Anthropic: Agent Skills | anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills | Progressive disclosure as core principle |
| Anthropic: Advanced Tool Use | anthropic.com/engineering/advanced-tool-use | defer_loading: true |
| Anthropic: Context Engineering | anthropic.com/engineering/effective-context-engineering-for-ai-agents | Static-first, dynamic-last |
| Manus AI: Context Engineering | manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus | KV-cache as #1 metric, filesystem as memory |
| OpenClaw: Context Docs | docs.openclaw.ai/concepts/context | maxSkillsPromptChars, Compact Format |
| OpenClaw: Skills System | deepwiki.com/openclaw/openclaw/5.2-skills-system | Full/Compact/Truncated modes |
| RouteLLM | arxiv.org/abs/2406.18665 | 95% quality at 14% GPT-4 usage |
| LLMLingua | arxiv.org/abs/2310.05736 | 20x compression, 1.5% performance loss |
| MindStudio: Token Optimization | mindstudio.ai/blog/ai-agent-token-cost-optimization-multi-model-routing | Two-tier model routing |
| Lindy AI Architecture | zenml.io/llmops-database/evolution-from-open-ended-llm-agents-to-guided-workflows | "Put Shoggoth in a small box" |
| Claude Code Source (leaked) | github.com/ultraworkers/claw-code | Actual tool search and caching implementation |
| Devin Performance Review | cognition.ai/blog/devin-annual-performance-review-2025 | Multi-model swarm, repository indexing |
| Perplexity Computer | buildfastwithai.com/blogs/what-is-perplexity-computer | 19 models, MCP consumes 72% context |
| AI Agent Cost 2026 | moltbook-ai.com/posts/ai-agent-cost-optimization-2026 | Industry benchmarks |
| Prompt Caching Cost Reduction | medium.com/ai-software-engineer/anthropic-just-fixed-the-biggest-hidden-cost | Auto-caching analysis |

---

## Implementation Plan Summary

| Phase | What | When | Savings | Cumulative |
|-------|------|------|---------|-----------|
| **1** | **Enable prompt caching** | **Day 1** | **$7,714/mo** | **$7,714** |
| 2 | Trim skills + move references | Week 1-2 | $1,000-2,000 | $8,714-9,714 |
| 3 | Compact skills evaluation | Week 3 | $1,000-3,000 | $9,714-12,714 |
| 4 | Model routing optimization | Month 2 | $1,000-3,000 | $10,714-15,714 |
| 5 | Cross-user cache sharing | Month 2-3 | Variable | Variable |
| 6 | Advanced (LLMLingua, RAG, self-host) | Month 3+ | Variable | Variable |

**Phase 1 alone gets us from -$7,345/mo margin to ~$0 (breakeven).**
**Phase 1 + price raise ($49/$149/$399) gets us to +$3,742/mo (34% margin).**

---

*End of PRD. This document is the single source of truth for API cost optimization. Update as phases are implemented and costs are measured.*
