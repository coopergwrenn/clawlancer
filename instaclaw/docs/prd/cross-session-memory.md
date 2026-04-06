# PRD: Cross-Session Memory — Persistent Agent Intelligence for InstaClaw

**Author:** Cooper Wrenn + Claude (Opus 4.6)
**Date:** 2026-04-06
**Status:** Draft — ready for review
**Priority:** P0 — #1 user complaint, directly impacts retention
**Estimated Impact:** Transforms agents from "chatbots that forget" to "personal AI that grows with you"

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [The Problem](#2-the-problem)
3. [Current Architecture — What's Broken](#3-current-architecture)
4. [Research Findings — What the Best Teams Do](#4-research-findings)
5. [Proposed Architecture — InstaClaw Memory System](#5-proposed-architecture)
6. [Implementation Plan](#6-implementation-plan)
7. [Token Cost Impact](#7-token-cost-impact)
8. [Success Metrics](#8-success-metrics)
9. [Risk Analysis](#9-risk-analysis)
10. [Appendices](#10-appendices)

---

## 1. Executive Summary

### The #1 User Complaint

> "My agent forgot everything. It's like meeting a stranger every week."

When a session expires (7-day idle timeout), gateway restarts, or the agent starts a new session, **all conversation context is lost.** The agent knows the user's name from MEMORY.md but has zero context about:
- What they were working on yesterday
- Ongoing projects and their status
- Promises the agent made ("I'll check on that tomorrow")
- Insights from recent conversations
- The user's communication style and preferences learned over time

**An agent that forgets everything every 7 days is not an agent — it's a chatbot.**

### The Discovery (April 6, 2026)

Our investigation revealed:
- SOUL.md already tells the agent "session continuity is your #1 priority — read MEMORY.md before responding"
- But MEMORY.md only has a static user profile (3,405 chars) — no recent context, no tasks, no session summaries
- The **memory search index was completely empty** until we manually rebuilt it
- **383 session files (177MB)** exist on disk — the history IS there, just not accessible to new sessions
- OpenClaw has `memoryFlush`, `memorySearch`, `previousSessionEntry` — the pieces exist but aren't wired together
- **No session-end summary is written when a session expires**

### The Fix

Build a **tiered file system** — not a single growing document — that separates identity from history from detail:

1. **MEMORY.md** — Lean core identity (<5K chars). Always in context. Rarely changes.
2. **SESSION-HISTORY.md** — Structured session log. Latest entry loaded on session start.
3. **TASKS.md** — Active task tracker. Loaded on session start.
4. **memory/ folder** — Detailed dated notes. On disk, searchable via SQLite index (RAG).

**The agent should be able to say "let me check what we discussed last Tuesday" and pull up that specific session file** — NOT have every session's details crammed into the context window.

**No massive infrastructure change needed.** The solution is primarily SOUL.md instructions + tiered file structure + keeping the memory index alive.

---

## 2. The Problem

### 2.1 What Users Experience

**Day 1:** User sets up their agent. Has a great 2-hour conversation about their crypto portfolio, trading strategy, and weekly goals. Agent learns everything.

**Day 8:** Session expires (7-day idle timeout). User messages agent.

**Agent responds:** "Hey! What's up?" — as if they've never met.

The user just paid $29-299/mo for a "personal AI that remembers everything" and it remembered nothing from their last conversation.

### 2.2 Why This Happens

The session lifecycle:

```
Session 1 (active conversation):
  System prompt (15K tokens) + conversation history (grows over time)
  → Agent knows everything: user's name, projects, preferences, recent work
  → MEMORY.md has static profile written during onboarding
  → Conversation history is ONLY in RAM (the messages array)

↓ Session expires (7-day idle / gateway restart / compaction) ↓

Session 2 (new session):
  System prompt (15K tokens) + EMPTY conversation history
  → Agent loads MEMORY.md (static profile from onboarding)
  → Agent has ZERO context about what happened in Session 1
  → Agent starts fresh: "Hey, what's up?"
```

**The gap:** Nothing from Session 1's conversation gets written to a persistent file that Session 2 can read.

### 2.3 What SHOULD Happen

```
Session 1 (active conversation):
  Agent learns: user is working on a Polymarket trading bot,
  has a meeting with Brian about Newsworthy on Thursday,
  prefers concise responses, and wants daily crypto briefings.

↓ Session ends → SESSION SUMMARY written to disk ↓

Session 2 (new session):
  Agent loads MEMORY.md (now includes session summary):
  "Cooper was building a Polymarket trading bot. He has a meeting
  with Brian (Newsworthy) on Thursday. He likes concise responses.
  He wants daily crypto market briefings. Last active April 5."
  
  → Agent responds: "Hey Cooper! How's the Polymarket bot coming
  along? Anything you need before your Thursday meeting with Brian?"
```

### 2.4 Scale of the Problem

- **170 agents** affected
- **105 paying users** — every one of them experiences this
- Session resets happen on average every 5-7 days per user
- Post-reset, users have to "re-train" their agent for 10-20 messages before it feels natural again
- This is the #1 reason users describe InstaClaw agents as "forgetting" — it's not a bug in memory, it's the complete absence of cross-session memory transfer

---

## 3. Current Architecture — What's Broken

### 3.1 What Persists Across Sessions

| Component | Persists? | Location | Content |
|-----------|-----------|----------|---------|
| MEMORY.md | ✅ Yes | `~/.openclaw/workspace/MEMORY.md` | Static user profile from onboarding (3,405 chars). Never updated. |
| SOUL.md | ✅ Yes | `~/.openclaw/workspace/SOUL.md` | Agent personality and behavioral rules (27K chars). |
| USER.md | ✅ Yes | `~/.openclaw/workspace/USER.md` | Basic user info (name, preferences) (2.2K chars). |
| Session files | ✅ Yes (on disk) | `~/.openclaw/agents/main/sessions/*.jsonl` | Full conversation history. 383 files, 177MB. But NOT loaded into new sessions. |
| Memory index | ❌ Broken | `~/memory/main.sqlite` | Was empty until manually rebuilt. Only indexes MEMORY.md (3 chunks). |
| Conversation context | ❌ Lost | In-memory only | Disappears when session ends. |
| Active tasks | ❌ Lost | In-memory only | No active-tasks.md file maintained. |
| Learned preferences | ❌ Lost | In-memory only | Communication style, topic interests, etc. |

### 3.2 OpenClaw Features We Have (But Aren't Using Well)

| Feature | Config | Status | Issue |
|---------|--------|--------|-------|
| `session.reset.mode: "idle"` | 10,080 min (7 days) | ✅ Working | Long timeout is good, but when it fires, everything is lost |
| `memoryFlush.enabled: true` | softThreshold: 8,000 tokens | ✅ Enabled | Should write important context to MEMORY.md during compaction — but MEMORY.md hasn't been updated |
| `memorySearch.enabled: true` | auto provider | ✅ Enabled | Index was empty (0 files). Just rebuilt — now has 1 file, 3 chunks. Needs more content to be useful. |
| `bootstrapMaxChars: 30000` | — | ✅ Set | Allows up to 30K chars of MEMORY.md content in new sessions. Plenty of room — we're only using 3.4K. |
| `compaction.reserveTokensFloor: 35000` | — | ✅ Set | Compaction fires when context exceeds this. Creates summaries. |
| `previousSessionEntry` | In OpenClaw source | ❓ Unknown | Exists in the code — may allow carrying forward session context. Not investigated. |

### 3.3 SOUL.md Already Has Instructions

SOUL.md line 27-33 says:

> **Session continuity is your #1 priority.** Sessions rotate for technical reasons — this does NOT mean you're meeting your owner for the first time.
> When your owner messages you after a session rotation:
> - Read MEMORY.md and recent memory/ files BEFORE responding
> - If you have ANY memory content about them, you ALREADY KNOW THEM
> - NEVER dump your memory back at them ("I know you work on X, Y, Z...")
> - If you can tell what they were last working on from memory files, reference it casually

**The instructions are right. The data is missing.** The agent IS told to read MEMORY.md, but MEMORY.md has nothing useful about recent conversations.

---

## 4. Research Findings — What the Best Teams Do

### 4.1 The Universal Pattern

Every successful platform converges on the same architecture:

1. **Durable state lives on disk, not in context** — MEMORY.md, todo.md, SOUL.md
2. **Context window is treated as working memory (RAM)** — volatile, managed, compacted
3. **Session resets are avoided or minimized** — idle-based with long windows, not daily
4. **Heartbeats/background tasks are isolated** — separate session, minimal context
5. **Compaction preserves decisions, not conversations** — what was decided matters more than what was said

### 4.2 Claude Code

**Source:** github.com/ultraworkers/claw-code (leaked source analysis)

**Key architecture:**
- **CLAUDE.md is the ONLY cross-session persistence** — a plain file re-read every session start
- **No auto cross-session bridging** — new sessions start clean with only CLAUDE.md context
- **Compaction creates structured XML summaries** containing: scope, tools used, recent requests, pending work, key files, and a timeline
- **Auto-compaction at 100K input tokens** — keeps 4 most recent messages, summarizes everything else
- **Summary compression:** 1,200 chars max, 24 lines max, priority-based line selection
- **`--resume latest`** loads the full previous session — but this is manual, not automatic
- **No auto-memory in open source** — the proprietary binary has MEMORY.md writing capability

**Key insight:** Claude Code's memory system is SIMPLE. Just a file on disk that gets re-read. No database, no embeddings, no complex architecture. The simplicity is the feature.

### 4.3 Manus AI

**Source:** manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus

- **File system IS the memory** — context window is just the working set
- **todo.md recitation** — rewrite the plan at end of context to keep it in model's attention
- **Recoverable compression** — drop content but keep file paths for re-retrieval
- Everything important gets written to a file; the context window loads from files as needed

### 4.4 ChatGPT Memory

- Extracts key facts from conversations automatically ("user prefers Python", "user works at Acme Corp")
- Stores as a flat list of facts, injected into every conversation
- Users can view, edit, and delete individual memories
- Max ~100 memories, each 1-2 sentences
- No session summaries — just atomic facts

### 4.5 Character.ai / Replika

- Relationship memory: tracks rapport, inside jokes, emotional context
- Character consistency: personality traits persist across sessions
- Conversation summaries: condensed recent interactions available to new sessions
- "Memory pinning" — users can mark important moments to always remember

### 4.6 Google (Always-On Memory Agent)

- **30-minute consolidation cycle** — background processing of memories (like sleep/replay)
- **No vector database needed** — structured SQLite + LLM reasoning
- Memories categorized: facts, preferences, events, relationships
- Consolidation merges duplicate/related memories

### 4.7 Devin (Cognition Labs)

- **Sessions sleep, never terminate** — can wake and resume at any point
- **Checkpoint/restore** — full timeline scrubbing with state rollback
- Break large tasks into smaller isolated sessions for best results

### 4.8 Replit Agent

- **Decision-time guidance** at the bottom of the conversation (recency bias), not in the system prompt
- **Checkpoints** capture entire state (code + DB + AI conversation)
- 15% more parallel tool calls when guidance is at trace bottom vs system prompt

### 4.9 MemGPT (Academic)

**Source:** memgpt.ai, "MemGPT: Towards LLMs as Operating Systems"

- Treats LLM as an operating system with virtual memory management
- **Main context** (fast, limited) vs **archival memory** (slow, unlimited)
- Agent decides when to page in/out memories
- Self-editing memory: agent can update its own memory files
- Conversation summaries stored in "recall memory"

---

## 5. Proposed Architecture — InstaClaw Memory System

### 5.1 Tiered File Architecture

Think of this as a **filing system, not a single growing document.** The agent can say "let me check what we discussed last Tuesday" and pull up that specific session file — instead of having every session's details crammed into the context window.

```
~/.openclaw/workspace/
├── MEMORY.md           ← Core identity. Always in context. <5K chars.
├── SESSION-HISTORY.md  ← Structured log of recent sessions. Read on demand.
├── TASKS.md            ← Active tasks. Read on session start.
└── memory/
    ├── 2026-04-05.md   ← Detailed session notes (dated files)
    ├── 2026-04-03.md
    ├── 2026-04-01.md
    └── ...             ← Searchable via SQLite memory index (RAG)
```

**What goes in the context window:** MEMORY.md (~5K chars) + latest SESSION-HISTORY.md entry (~500 chars) = ~5.5K chars total. Everything else stays on disk.

**What stays on disk:** Detailed session notes, old history, task archives. Agent reads them when needed using `memorySearch` (semantic retrieval) or direct file reads.

### 5.2 MEMORY.md — Core Identity (<5K chars, always in context)

MEMORY.md is **permanent, lean, and rarely changes.** It's the agent's foundational knowledge about the user — not a running log.

```markdown
# MEMORY.md

## About My User
Cooper Wrenn. Full-stack builder, crypto trader, AI experimenter.
Prefers concise responses, dislikes verbose explanations.
Active crypto portfolio — trades on Polymarket, follows Virtuals ecosystem.
Timezone: US Eastern.

## Key Preferences
- Direct communication, no fluff
- Likes daily crypto briefings
- Wants agent to be proactive about portfolio updates
- Prefers markdown formatting for summaries

## Important Relationships
- Brian Flynn (Newsworthy) — partnership, news curation skill
- Jeremy (Ape Capital) — investor, OnlyMolts bot
- Jess — power user, Polymarket focus

## Current Focus
Polymarket trading bot, DegenClaw competition, fleet monitoring.
```

**Rules:**
- Cap at 5,000 characters. If it exceeds, prune stale items.
- Only stores **stable facts** — things that are true across sessions.
- Updated rarely — when the agent learns a new permanent fact about the user.
- NEVER contains session summaries, task lists, or conversation logs.

### 5.3 SESSION-HISTORY.md — Structured Session Log (on disk, read on demand)

A chronological index of sessions. The agent reads the **latest entry** on session start for immediate context, and can scan older entries when the user references past work.

```markdown
# SESSION-HISTORY.md

## 2026-04-05 — Infrastructure Upgrade & Price Raise
Migrated all VMs to dedicated CPU. Fixed 16 paying users whose VMs were
accidentally deleted. Enabled Anthropic prompt caching. Published price
raise tweet. Open: finalize Stripe pricing ($49/$149/$399).

## 2026-04-03 — Fleet Stability
Restart storm fixes, watchdog v5 deployment, config drift fix,
exec-approvals fleet push. All 169 VMs healthy post-deploy.

## 2026-04-01 — Newsworthy Partnership
Met with Brian Flynn. PRD written for news curation skill.
First multi-chain skill (World Chain + Base). Brian considering
moving everything to Base — may simplify architecture.

## 2026-03-29 — DegenClaw Skill
Phase 1 code complete for Virtuals trading competition skill.
SKILL.md deployed to fleet. Pending: VM verification + canary deploy.
```

**Rules:**
- Each entry: date, title, 3-5 sentences. Max ~200 chars per entry.
- Keep last 10-15 entries in the file (~3K chars). Archive older to `memory/`.
- Agent writes a new entry at the end of every meaningful conversation.
- Only the latest entry gets loaded into context on session start (~200-500 chars).

### 5.4 TASKS.md — Active Task Tracker (read on session start)

Lightweight task file so the agent knows what's in progress across sessions.

```markdown
# TASKS.md — Active

- [ ] Finalize Stripe pricing ($49/$149/$399) — price raise announced for Apr 6
- [ ] Check Brian's response about Base-only migration
- [ ] Review DegenClaw competition results this week
- [ ] Run Supabase production migration for AgentBook

# Completed (last 5)
- [x] Migrate fleet to dedicated CPU (2026-04-05)
- [x] Enable Anthropic prompt caching (2026-04-05)
- [x] Deploy watchdog v5 to fleet (2026-04-03)
```

**Rules:**
- Max 10 active tasks. When completed, move to "Completed (last 5)".
- Agent updates this during and at end of conversations.
- Entire file loaded on session start (~1-2K chars).

### 5.5 memory/ Folder — Detailed Notes (on disk, searchable via index)

For anything too detailed for the lean files above. Dated session notes, project deep dives, research findings. The agent writes here when a conversation has substantial detail worth preserving.

```
memory/
├── 2026-04-05.md       "Infrastructure upgrade: 168 VMs migrated, 16 restored..."
├── 2026-04-03.md       "Fleet stability fixes: restart storm root cause was..."
├── 2026-04-01.md       "Newsworthy meeting notes: Brian wants news curation..."
├── polymarket-setup.md "Polymarket trading config: CLOB proxy in Toronto..."
└── portfolio-notes.md  "User's portfolio positions as of April 2026..."
```

**Rules:**
- One file per session (dated) or per topic (named).
- No size limit per file — this is the "archival" layer.
- Agent writes here for detailed context it might need later.
- **Never loaded into context automatically** — agent reads specific files on demand.
- Searchable via OpenClaw's `memorySearch` (SQLite + embeddings = RAG for personal memory).

### 5.6 How It All Flows

**End of Session (automatic via SOUL.md instructions):**
1. Agent writes a 3-5 sentence entry to SESSION-HISTORY.md
2. Agent updates TASKS.md (mark completed, add new)
3. If the conversation had substantial detail, write a dated file to `memory/`
4. If the agent learned a new permanent fact, update MEMORY.md (rare)

**Start of New Session (automatic via bootstrap):**
1. OpenClaw loads MEMORY.md into context (~5K chars, via `bootstrapMaxChars`)
2. SOUL.md tells agent to read the latest SESSION-HISTORY.md entry + TASKS.md
3. Agent has: who the user is + what happened last + what's in progress
4. Total context cost: ~7K chars (~1,750 tokens) — well within the 30K bootstrap budget
5. If user references something older, agent uses `memorySearch` or reads specific `memory/` files

**Progressive disclosure in action:** Context window stays lean. Details are on disk. Agent pulls them in only when needed — same pattern as how we load skill descriptions (names + summaries) instead of full SKILL.md files.

### 5.7 Memory Search as RAG Layer

OpenClaw's `memorySearch` (SQLite + embeddings) becomes the semantic search layer across all memory files:

- Indexes: MEMORY.md, SESSION-HISTORY.md, TASKS.md, all `memory/*.md` files
- When user says "what did we discuss about Polymarket last week?" → agent queries memory search → gets relevant chunks from `memory/2026-04-01.md` → reads the file → responds with context
- Daily cron rebuilds index: `openclaw memory index`
- No external vector DB needed — OpenClaw's built-in SQLite index is sufficient

### 5.8 The Implementation — SOUL.md Instructions

Add to SOUL.md:

```markdown
## Memory Management — Your Filing System

You have a tiered memory system. Keep it organized.

### On Session Start
1. MEMORY.md is already in your context (loaded automatically)
2. Read the LATEST entry in ~/.openclaw/workspace/SESSION-HISTORY.md
3. Read ~/.openclaw/workspace/TASKS.md
4. You now have: who they are + what happened last + what's active
5. NEVER ask "who are you?" or "what are you working on?" if any memory exists

### During Conversations
- When you learn a NEW PERMANENT FACT about the user → update MEMORY.md (rare)
- When a task is created/completed/changed → update TASKS.md
- When the user references past work you don't have context for → use memory search
  or read specific files from ~/memory/

### On Session End (when user says goodbye, or after extended silence)
1. Write a 3-5 sentence entry to SESSION-HISTORY.md (date + title + summary)
2. Update TASKS.md (mark done, add new)
3. If the conversation had substantial detail worth preserving, write a dated file
   to ~/memory/YYYY-MM-DD.md with the full context
4. Run: openclaw memory index (rebuilds search index)

### File Size Rules
- MEMORY.md: <5,000 chars. Core identity only. No session logs.
- SESSION-HISTORY.md: Keep last 10-15 entries. Archive older to ~/memory/.
- TASKS.md: Max 10 active tasks. Keep last 5 completed.
- memory/*.md: No limit. This is your archive.

### What Goes Where
| Information | File | Example |
|------------|------|---------|
| User's name, preferences, relationships | MEMORY.md | "Prefers concise responses" |
| What happened in a session | SESSION-HISTORY.md | "Apr 5: migrated fleet to dedicated CPU" |
| Active and recently completed tasks | TASKS.md | "[ ] Finalize Stripe pricing" |
| Detailed meeting notes, research, configs | memory/*.md | "polymarket-setup.md" |
| Old session entries (>15 sessions ago) | memory/*.md | "memory/2026-03-15.md" |
```

### 5.9 Session End Hook (Safety Net)

For guaranteed summaries even when the agent doesn't write one (timeout, crash, restart):

Create a lightweight script that detects session transitions and:
1. Reads the last 20 messages from the previous session file
2. Calls Haiku to generate a 3-5 sentence summary
3. Appends the summary to SESSION-HISTORY.md
4. Rebuilds the memory index

This is a fallback — the SOUL.md instructions handle the normal case.

---

## 6. Implementation Plan

### Phase 1: File Structure + SOUL.md Instructions (Day 1 — IMMEDIATE)

**What:** Deploy the tiered file system and SOUL.md memory instructions to all VMs.

**Changes:**
1. Create file templates on all assigned VMs:
   - `~/.openclaw/workspace/SESSION-HISTORY.md` (empty, with header)
   - `~/.openclaw/workspace/TASKS.md` (empty, with header)
   - `~/memory/` directory (mkdir -p)
2. Slim down existing MEMORY.md to <5K chars (remove anything that belongs in other files)
3. Add "Memory Management — Your Filing System" section to SOUL.md (from Section 5.8)
4. Deploy via manifest v56 + fleet push

**Effort:** Low — SOUL.md update + file creation + manifest bump
**Risk:** Very low — agents gain new behavior (file writing) but nothing breaks if they don't do it
**Impact:** High — agents immediately start maintaining tiered memory

### Phase 2: Memory Index + Daily Cron (Day 1)

**What:** Rebuild the memory search index on all VMs, index the new files, add daily cron.

**Changes:**
1. Fleet-push: `openclaw memory index` on all assigned VMs
2. Add daily cron: `0 5 * * * openclaw memory index >> /tmp/memory-index.log 2>&1`
3. Add to VM manifest (v56)

**Effort:** Low — fleet script + cron
**Risk:** None — memory search is read-only
**Impact:** Medium — enables semantic retrieval across all memory files (RAG for personal memory)

### Phase 3: Session End Hook — Safety Net (Week 1)

**What:** Lightweight script that auto-generates session summaries when the agent doesn't.

**Implementation:**
1. Detect session transition (new session file created in sessions/)
2. Check if agent already wrote to SESSION-HISTORY.md for this session (skip if yes)
3. Read last 20 messages from previous session
4. Call Haiku to generate 3-5 sentence summary
5. Append to SESSION-HISTORY.md
6. If detailed enough, also write dated file to `~/memory/`
7. Rebuild memory index

**Effort:** Medium — new script + cron
**Risk:** Low — worst case summary is redundant with what agent already wrote
**Impact:** High — guarantees session summaries even on crash/timeout/restart

### Phase 4: Memory Consolidation (Week 2-3)

**What:** Background process that periodically cleans up the filing system:
1. Prune SESSION-HISTORY.md to last 15 entries (archive older to `memory/`)
2. Merge duplicate facts in MEMORY.md
3. Remove stale tasks from TASKS.md
4. Rebuild memory index after cleanup

**Effort:** Medium
**Risk:** Medium — need to be careful not to delete important memories
**Impact:** Medium — prevents file bloat over time

### Phase 5: User-Facing Memory Controls (Month 2)

**What:** Let users view and manage their agent's memory via the dashboard:
- View MEMORY.md, SESSION-HISTORY.md, TASKS.md
- Pin important memories (never forget)
- Delete incorrect memories
- View and search memory/ archive
- Export all memory data

**Effort:** High — dashboard UI + API
**Risk:** Low
**Impact:** Medium — builds user trust in the memory system

---

## 7. Token Cost Impact

### 7.1 Memory in Context Window

Current MEMORY.md: 3,405 chars (~850 tokens)
Proposed in-context load: MEMORY.md (~5K) + latest SESSION-HISTORY.md entry (~500) + TASKS.md (~1.5K) = **~7K chars (~1,750 tokens)**

**Additional cost per call:** ~900 extra tokens × $0.30/M (cached) = $0.0003/call

**Monthly impact:** 641 calls/day × $0.0003 × 30 = **~$6/mo** — negligible.

The bootstrapMaxChars budget (30,000 chars) has 23K chars of headroom. The tiered approach uses **less** context than the original single-document proposal while providing better retrieval.

### 7.2 Session End Summary Cost

If we use Haiku to generate session summaries:
- 1 summary per session end × ~500 input tokens + ~200 output tokens
- Haiku pricing: $0.80/M input, $4/M output
- Cost per summary: ~$0.001
- ~100 session transitions/month across fleet: **~$0.10/mo** — negligible.

### 7.3 Memory Index Rebuild Cost

OpenClaw memory indexing uses OpenAI text-embedding-3-small:
- ~$0.02/M tokens for embedding
- ~3 chunks per MEMORY.md × 170 VMs = 510 chunks
- ~1K tokens per chunk: $0.01/rebuild
- Daily rebuilds: **~$0.30/mo** — negligible.

**Total memory system cost: ~$12/mo.** Less than the cost of one VM.

---

## 8. Success Metrics

### Primary

| Metric | Current | Target |
|--------|---------|--------|
| Users reporting "agent forgot everything" | ~30% of sessions | <5% |
| Session continuity quality (manual audit) | 0% (no context transferred) | >80% |
| MEMORY.md size | 3,405 chars (static, stale) | <5,000 chars (lean, current) |
| Memory files per agent | 1 (MEMORY.md only) | 4+ (MEMORY + SESSION-HISTORY + TASKS + memory/*.md) |
| Memory index chunks per agent | 3 (just profile) | 20-50 (all files indexed for semantic search) |

### Secondary

| Metric | Target |
|--------|--------|
| Session notes written per session | >80% of sessions |
| Open tasks tracked across sessions | >90% continuity |
| Time for agent to reference recent context | <first response (reads MEMORY.md on session start) |
| User satisfaction with agent memory | Survey: >7/10 |

### Guard Rails

| Guard Rail | Threshold | Action |
|-----------|-----------|--------|
| MEMORY.md grows beyond 5K chars | >5K | Agent prunes stale items; move detail to memory/ |
| SESSION-HISTORY.md exceeds 15 entries | >15 | Archive oldest entries to memory/ |
| TASKS.md exceeds 10 active items | >10 | Agent archives completed, prioritizes active |
| Agent overwrites critical MEMORY.md content | Any loss of "About My User" | SOUL.md rule: never delete profile section |
| Memory search returns irrelevant results | >3 user complaints | Audit index quality, adjust embedding model |
| Session summary quality is poor | Manual review shows garbage | Improve summary prompt or switch from Haiku to Sonnet |

---

## 9. Risk Analysis

### Phase 1 Risks

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|-----------|
| Agent writes session logs into MEMORY.md instead of SESSION-HISTORY.md | Medium | Low | SOUL.md "What Goes Where" table makes it explicit |
| Agent overwrites important memory content | Low | High | SOUL.md rule: "NEVER delete About My User section" |
| Agent doesn't follow memory instructions | Medium | Medium | Phase 3 hook as safety net |
| Memory content is low quality | Medium | Low | Better than nothing; will improve with prompt iteration |
| Files accumulate without cleanup | Low | Low | Phase 4 consolidation; SOUL.md size rules |

### Phase 3 Risks

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|-----------|
| Summary script fails silently | Medium | Low | Log errors, alert on 3+ consecutive failures |
| Haiku generates bad summary | Low | Low | Review first 10 summaries manually |
| Script reads wrong session file | Low | Medium | Careful file selection logic; test on canary |
| Duplicate summary (agent + hook both write) | Medium | Low | Hook checks if agent already wrote for this session |

---

## 10. Appendices

### Appendix A: Current MEMORY.md Content (vm-050)

```markdown
## About My User (from onboarding)

Cooper Wrenn is a young, ambitious full-stack developer and startup builder
who's constantly shipping projects and experimenting with the latest AI and
infrastructure tools. Based on his email patterns, he's deeply embedded in
the developer ecosystem—using Vercel, DigitalOcean, Resend, and Supabase
for deployment and infrastructure...

### Quick Profile
- Full-stack builder, shipping constantly
- Crypto trader and investor, active portfolio
- AI tool experimenter, trying everything
```

Total: 3,405 chars. Static. Written during onboarding. Never updated.

### Appendix B: Proposed File Templates

**MEMORY.md (core identity, <5K chars):**
```markdown
# MEMORY.md

## About My User
[Name. Role. Key traits. 2-3 sentences from onboarding.]

## Key Preferences
[Communication style, content preferences. Max 5 bullets.]

## Important Relationships
[Key people the user works with. Max 5 entries.]

## Current Focus
[1-2 sentences on what they're currently working on. Updated rarely.]
```

**SESSION-HISTORY.md (session log, last 10-15 entries):**
```markdown
# SESSION-HISTORY.md

## [YYYY-MM-DD] — [Session Title]
[3-5 sentence summary: topics, decisions, open items.]

## [YYYY-MM-DD] — [Session Title]
[3-5 sentence summary.]
```

**TASKS.md (active tasks):**
```markdown
# TASKS.md — Active

- [ ] [Task description] — [context/deadline]
- [ ] [Task description]

# Completed (last 5)
- [x] [Task] ([date])
```

### Appendix C: Session Data Available on Disk

| Metric | Value |
|--------|-------|
| Total session files | 383 |
| Total session data | 177 MB |
| Sessions with compaction summaries | 149 |
| sessions.json size | 273 KB |
| Average session file size | 462 KB |
| Oldest session | Feb 2026 |

This data EXISTS — it just isn't surfaced to new sessions. The session end hook (Phase 3) would read these files and extract summaries.

### Appendix D: OpenClaw Memory Config Reference

```json
{
  "session": {
    "reset": {
      "mode": "idle",
      "idleMinutes": 10080
    },
    "maintenance": {
      "mode": "enforce"
    }
  },
  "agents": {
    "defaults": {
      "bootstrapMaxChars": 30000,
      "compaction": {
        "reserveTokensFloor": 35000,
        "memoryFlush": {
          "enabled": true,
          "softThresholdTokens": 8000
        }
      },
      "memorySearch": {
        "enabled": true
      }
    }
  }
}
```

### Appendix E: Research Sources

| Source | Key Finding |
|--------|-------------|
| Claude Code (leaked source) | CLAUDE.md is only cross-session persistence. No auto bridging. Compaction creates XML summaries with scope/tools/requests/pending work. |
| Manus AI blog | File system IS the memory. todo.md recitation. KV-cache optimization. |
| ChatGPT Memory | Atomic fact extraction. ~100 memories, 1-2 sentences each. |
| Character.ai | Relationship memory: rapport, inside jokes, emotional context. |
| Google Always-On Memory Agent | 30-minute consolidation cycle. No vector DB needed — SQLite + LLM reasoning. |
| Devin | Sessions sleep, never terminate. Checkpoint/restore. |
| Replit Agent | Decision-time guidance at conversation bottom (recency bias). |
| MemGPT | LLM as OS with virtual memory. Main context vs archival memory. Self-editing memory. |
| OpenClaw docs | memoryFlush, memorySearch, bootstrapMaxChars, previousSessionEntry available. |

---

*End of PRD. This document is the single source of truth for cross-session memory. Update as phases are implemented and user feedback is collected.*
