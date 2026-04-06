# PRD: Cross-Session Memory — Persistent Agent Intelligence for InstaClaw

**Author:** Cooper Wrenn + Claude (Opus 4.6)
**Date:** 2026-04-06
**Status:** Draft v3 — post-codebase-audit, post-bootstrap-verification
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
10. [Platform Comparison Matrix](#10-platform-comparison-matrix)
11. [Codebase Audit — Implementation Notes](#11-codebase-audit)
12. [Appendices](#12-appendices)

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

1. **MEMORY.md** — Lean core identity (<5K chars). Auto-loaded at bootstrap. Rarely changes.
2. **memory/session-log.md** — Structured session log. Agent reads on session start; auto-populated by Phase 3 hook.
3. **memory/active-tasks.md** — Active task tracker (ALREADY EXISTS). Agent reads on session start.
4. **memory/*.md** — Detailed dated notes. On disk, searchable via SQLite index (RAG).

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
├── MEMORY.md                  ← Core identity. Always in context. <5K chars.
└── memory/
    ├── session-log.md         ← Structured log of recent sessions (last 15)
    ├── active-tasks.md        ← Active tasks (ALREADY EXISTS — don't recreate)
    ├── 2026-04-05.md          ← Detailed session notes (dated files)
    ├── 2026-04-03.md
    ├── 2026-04-01.md
    ├── archive/               ← Old session-log entries moved here
    └── main.sqlite            ← OpenClaw memory search index (FTS5 + vec0)
```

**VERIFIED (April 6, vm-050):** `bootstrapMaxChars` loads ONLY 9 named files: AGENTS.md, SOUL.md, TOOLS.md, IDENTITY.md, USER.md, HEARTBEAT.md, BOOTSTRAP.md, MEMORY.md, memory.md. See `WorkspaceBootstrapFileName` enum in OpenClaw plugin-sdk/src/agents/workspace.d.ts. **`memory/*.md` files are NOT auto-loaded.** There is no config key to add extra bootstrap files.

**What goes in the context window automatically:** MEMORY.md only (~5K chars). Per-file limit: 30K chars. Total across all 9 files: 150K chars (`bootstrapTotalMaxChars`).

**What the agent reads on session start (via SOUL.md instruction + tool calls):** `memory/session-log.md` (~3K) + `memory/active-tasks.md` (~1K). This adds 2 file-read tool calls at session start (~2-3 seconds).

**What stays on disk (never in context unless requested):** Detailed dated notes (memory/YYYY-MM-DD.md), archived session entries. Agent reads them via `memorySearch` (semantic retrieval) or direct file reads.

**Defense in Depth — why this works even when agents don't read files:**
1. Phase 3 hook writes session summary to `memory/session-log.md` (automated, no agent needed)
2. Next heartbeat (≤3h) Phase 0 reads session-log.md → updates MEMORY.md with recent context
3. New session starts → MEMORY.md auto-loaded (contains recent context from heartbeat)
4. If agent ALSO reads session-log.md (SOUL.md instruction) → gets even more detail

**CRITICAL FINDING: `memory/active-tasks.md` DOES NOT EXIST on vm-050** despite SOUL.md instructions telling agents to maintain it since v41 (agent-intelligence.ts:419-437). HEARTBEAT.md Phase 0.5 reads it. The file is referenced but agents are not creating it. We must create the template via manifest AND rely on the Phase 3 hook + heartbeat as primary mechanisms, not SOUL.md compliance alone.

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

### 5.3 memory/session-log.md — Structured Session Log

A chronological index of sessions, stored in the `memory/` directory (indexed by memorySearch). NOT auto-loaded by bootstrap — agent reads it explicitly on session start per SOUL.md instructions, OR gets the content via heartbeat Phase 0 → MEMORY.md sync.

```markdown
# Session Log

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
- Each entry: date, title, 3-5 sentences. ~200 chars per entry.
- Keep last 15 entries in the file (~3K chars). Archive older to `memory/archive/`.
- Agent writes a new entry at the end of every meaningful conversation.
- NOT auto-loaded by bootstrap (only 9 named files are loaded — see Section 11.4).
- Agent reads explicitly on session start. Heartbeat Phase 0 syncs recent entries into MEMORY.md.

### 5.4 memory/active-tasks.md — ALREADY EXISTS, No Changes Needed

**This file already exists at `~/.openclaw/workspace/memory/active-tasks.md`.**

SOUL.md intelligence supplement (agent-intelligence.ts:419-437) already instructs agents to:
- Save task state every 5 actions to `ACTIVE_TASK.md`
- Update `memory/active-tasks.md` with completed work summary
- HEARTBEAT.md Phase 0.5 reads it for pending notifications

**We do NOT create a new TASKS.md file.** The existing file and instructions are sufficient. The only addition: SOUL.md memory filing instructions should reference it in the "What Goes Where" table so agents know it's the canonical task tracker.

**Existing format** (from agent-intelligence.ts:423-433):
```markdown
## Active Task
Request: [exact user request]
Status: IN_PROGRESS
Completed:
- [step 1 done]
- [step 2 done]
Next: [exact next step with specific details]
Data: [file paths, URLs, or other context needed to resume]
Updated: [YYYY-MM-DD HH:MM UTC]
```

### 5.5 memory/*.md — Detailed Notes (on disk, searchable via index)

For anything too detailed for the lean files above. Dated session notes, project deep dives, research findings. The agent writes here when a conversation has substantial detail worth preserving.

```
memory/
├── session-log.md      ← Session history (see 5.3)
├── active-tasks.md     ← Task tracker (already exists, see 5.4)
├── 2026-04-05.md       "Infrastructure upgrade: 168 VMs migrated, 16 restored..."
├── 2026-04-03.md       "Fleet stability fixes: restart storm root cause was..."
├── 2026-04-01.md       "Newsworthy meeting notes: Brian wants news curation..."
├── polymarket-setup.md "Polymarket trading config: CLOB proxy in Toronto..."
├── archive/            ← Old session-log entries
└── main.sqlite         ← OpenClaw memory search index (auto-managed)
```

**Rules:**
- One file per session (dated) or per topic (named).
- No size limit per file — this is the "archival" layer.
- Agent writes here for detailed context it might need later.
- All memory/*.md files are indexed by `memorySearch` (SQLite + embeddings).
- All memory/*.md files are included in bootstrapMaxChars budget — keep total reasonable.
- Searchable via OpenClaw's `memorySearch` (SQLite + embeddings = RAG for personal memory).

### 5.6 How It All Flows

**End of Session (automatic via SOUL.md instructions):**
1. Agent writes a 3-5 sentence entry to `memory/session-log.md`
2. Agent updates `memory/active-tasks.md` (mark completed, add new) — already instructed by existing SOUL.md
3. If the conversation had substantial detail, write a dated file to `memory/YYYY-MM-DD.md`
4. If the agent learned a new permanent fact, update MEMORY.md (rare)
5. Rewrite `memory/active-tasks.md` with current state (Manus todo.md recitation pattern — exploits recency bias for compaction survival)

**Start of New Session (bootstrap + explicit reads):**
1. OpenClaw auto-loads MEMORY.md into context (~5K chars, via `bootstrapMaxChars`)
2. SOUL.md tells agent to check ACTIVE_TASK.md first (existing Intelligence Supplement instruction)
3. SOUL.md tells agent to read `memory/session-log.md` + `memory/active-tasks.md` (2 tool calls, ~2-3 seconds)
4. Agent has: who the user is + what happened last + what's in progress
5. Total context cost after reads: ~9K chars (~2,250 tokens)
6. If user references something older, agent uses `memorySearch` or reads specific `memory/` files
7. **Fallback if agent skips reads:** MEMORY.md still contains recent context (updated by heartbeat Phase 0 every ≤3h)

**What already exists (no changes needed):**
- ACTIVE_TASK.md session resume → agent-intelligence.ts:330-340
- memory/active-tasks.md maintenance → agent-intelligence.ts:437
- HEARTBEAT.md Phase 0 memory maintenance → ssh.ts:3357-3362
- HEARTBEAT.md Sunday consolidation → ssh.ts:3426-3436
- strip-thinking.py memory urgency injection at 160KB → ssh.ts:111

**What's actually new:**
- `memory/session-log.md` — new file for session history
- SOUL.md memory filing instructions — new section
- Memory index rebuild cron — new cron job
- Phase 3 session-end hook — new script

### 5.7 Memory Search as RAG Layer

OpenClaw's `memorySearch` (SQLite + embeddings) becomes the semantic search layer across all memory files:

- Indexes: MEMORY.md + all `memory/*.md` files (session-log.md, active-tasks.md, dated notes)
- When user says "what did we discuss about Polymarket last week?" → agent queries memory search → gets relevant chunks from `memory/2026-04-01.md` → reads the file → responds with context
- Daily cron rebuilds index: `openclaw memory index`
- No external vector DB needed — OpenClaw's built-in SQLite index is sufficient

### 5.8 The Implementation — SOUL.md Instructions

**What already exists in SOUL.md** (no changes needed to these):
- Session Resume: check ACTIVE_TASK.md on every session start (agent-intelligence.ts:330-340)
- Session Handoff: save task state every 5 actions (agent-intelligence.ts:419-437)
- Learned Preferences: agent logs communication style (agent-intelligence.ts:783-797)
- Operating Principles: error handling, config safety, never go silent (vm-manifest.ts:472-477)

**New section to append to SOUL.md** (via `append_if_marker_absent`, marker: `MEMORY_FILING_SYSTEM`):

```markdown
<!-- MEMORY_FILING_SYSTEM_V1 -->

### Memory Filing System (CRITICAL — prevents context loss)

You maintain a tiered memory system. Think of it as a filing cabinet, not a notepad.

**MEMORY.md** = Core identity. Keep under 5,000 characters.
- Only stable facts: user profile, preferences, key relationships, current focus
- NOT session logs, NOT task lists, NOT conversation details
- Update rarely — only when you learn something permanently new about the user
- If MEMORY.md currently has session logs or task lists, move them to the correct file below

**memory/active-tasks.md** = Your task tracker (already exists — keep using it as instructed above).

**memory/session-log.md** = Session history. After EVERY meaningful conversation:
- Append: `## YYYY-MM-DD — [Topic]\n[3-5 sentence summary]`
- Include: key decisions, what was accomplished, what's still open
- Keep last 15 entries. When it exceeds 15, move oldest entries to memory/archive/

**memory/YYYY-MM-DD.md** = Detailed notes for complex sessions.
- Write here when a conversation has substantial detail worth preserving
- Meeting notes, research findings, configuration changes, trade details

**Before your first response in a new session:**
1. ACTIVE_TASK.md is already checked (Session Resume rule above)
2. Read the latest 2-3 entries from memory/session-log.md
3. Read memory/active-tasks.md
4. Reference recent context naturally — don't dump your memory at the user

**At end of conversation (user says goodbye, or extended silence):**
1. Append session entry to memory/session-log.md
2. Rewrite memory/active-tasks.md with current state (what's done, what's next)
3. If the conversation was detailed, write memory/YYYY-MM-DD.md
4. Only update MEMORY.md if you learned a new permanent fact

**What goes where:**
| Information | File |
|------------|------|
| "User prefers concise responses" | MEMORY.md |
| "Apr 5: migrated fleet to dedicated CPU" | memory/session-log.md |
| Active/completed tasks | memory/active-tasks.md |
| Full meeting notes, research, configs | memory/YYYY-MM-DD.md |

**Size rules:** MEMORY.md <5KB. session-log.md: max 15 entries. active-tasks.md: max 10 active items.
```

**Why a new section vs modifying existing:** The existing Session Resume and Session Handoff instructions handle the *task* case (ACTIVE_TASK.md). The Memory Filing System handles the *memory* case (everything else). They're complementary, not duplicative.

### 5.9 Session End Hook (Safety Net)

For guaranteed summaries even when the agent doesn't write one (timeout, crash, restart):

Create a lightweight addition to `strip-thinking.py` (already runs every minute) that:
1. Detects session transition: new session file created AND previous session has no matching entry in `memory/session-log.md`
2. Reads the last 20 user/assistant messages from the previous session JSONL file
3. Calls Haiku via the proxy to generate a 3-5 sentence summary
4. Appends the summary to `memory/session-log.md`
5. Prunes session-log.md to last 15 entries if needed

**Why strip-thinking.py:** It already runs every minute, already has file locking (fcntl), already manages session files, and already injects memory markers. Adding session-end detection is a natural extension — no new cron or script needed.

**Session file format** (JSONL, one JSON object per line):
```json
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"..."}]}}
```

The hook can reliably parse these — extract user/assistant text blocks, skip tool_use/tool_result/thinking blocks, concatenate the last 20 message texts.

**Edge case: credits hit 0, gateway stops, no new session created.** The hook won't fire. On resubscribe, `configureOpenClaw` should add a "check for unsummarized sessions" step.

This is a fallback — the SOUL.md instructions handle the normal case where the agent writes its own summary before the session ends.

---

## 6. Implementation Plan

### Phase 1: SOUL.md Instructions + session-log.md Template (Day 1 — IMMEDIATE)

**What:** Deploy the Memory Filing System SOUL.md section and create session-log.md on all VMs.

**Actual changes (smaller than originally scoped — we already have 80%):**
1. Add `MEMORY_FILING_SYSTEM_V1` section to SOUL.md (Section 5.8) via `append_if_marker_absent`
2. Create `~/.openclaw/workspace/memory/session-log.md` with header template (`create_if_missing`)
3. Bump manifest version to v56
4. Reconciler auto-pushes to fleet

**What we DON'T need to create (already exists):**
- `memory/active-tasks.md` — already deployed, SOUL.md already references it
- `memory/` directory — already exists on all assigned VMs
- Memory maintenance — HEARTBEAT.md Phase 0 already covers this (every 3h)
- Session resume — ACTIVE_TASK.md check already in Intelligence Supplement
- Weekly consolidation — HEARTBEAT.md Sunday cycle already covers this

**Implementation in vm-manifest.ts:**
```typescript
// Add to files array:
{
  remotePath: "~/.openclaw/workspace/memory/session-log.md",
  source: "inline",
  content: "# Session Log\n\n_Session summaries are appended here automatically._\n",
  mode: "create_if_missing",
},
// Add to SOUL.md entries:
{
  remotePath: "~/.openclaw/workspace/SOUL.md",
  source: "template",
  templateKey: "SOUL_MD_MEMORY_FILING_SYSTEM",
  mode: "append_if_marker_absent",
  marker: "MEMORY_FILING_SYSTEM",
},
```

**Effort:** Very low — one SOUL.md section + two file templates + manifest bump
**Risk:** Very low — agents gain a new behavior (session logging) but nothing breaks if they don't. Based on vm-050 audit, expect <50% agent compliance — that's fine, Phase 3 hook is the primary mechanism.
**Impact:** Medium alone (SOUL.md compliance uncertain) → High when combined with Phase 3 hook

### Phase 2: Memory Index Cron (Day 1)

**What:** Add daily memory index rebuild cron to all VMs.

**Changes:**
1. Add cron to manifest: `0 4 * * * /home/openclaw/.nvm/versions/node/v22.22.0/bin/openclaw memory index >> /tmp/memory-index.log 2>&1`
2. Fleet-push: `openclaw memory index` on all assigned VMs (one-time rebuild)
3. Bump manifest cron entries

**Implementation in vm-manifest.ts:**
```typescript
// Add to crons array:
{
  schedule: "0 4 * * *",
  command: "/home/openclaw/.nvm/versions/node/v22.22.0/bin/openclaw memory index >> /tmp/memory-index.log 2>&1",
  marker: "openclaw memory index",
},
```

**Effort:** Very low — one cron line
**Risk:** None — memory indexing is read-only, non-destructive
**Impact:** Medium — enables semantic retrieval across all memory files

### Phase 3: Session End Hook in strip-thinking.py (Week 1)

**What:** Add session-end detection to the existing strip-thinking.py script.

**Implementation:**
1. On each run, check if a new session file was created since last check
2. If yes, check if `memory/session-log.md` was updated today (agent already wrote summary)
3. If no summary exists, read last 20 user/assistant messages from previous session JSONL
4. Call Haiku via gateway proxy to generate 3-5 sentence summary
5. Append to `memory/session-log.md`
6. Prune session-log.md if >15 entries (move old to memory/archive/)
7. Track last-processed session in state file (`.session-summary-state`)

**Why strip-thinking.py:** Already runs every minute, has file locking, manages session files. Natural home for this.

**Effort:** Medium — Python code addition to existing script
**Risk:** Low — worst case summary is redundant with agent-written one
**Impact:** High — guarantees session summaries even on crash/timeout/restart

### Phase 4: Memory Consolidation + Guardrails (Week 2-3)

**What:** Harden the filing system with automatic enforcement.

**Changes:**
1. Add to strip-thinking.py: if MEMORY.md > 10KB, inject consolidation marker (similar to existing urgency injection at 160KB)
2. Lower health cron MEMORY_OVERSIZED alert from 25KB to 10KB
3. Add health cron check: `memory/session-log.md` entry count, alert if >20 entries (cleanup not happening)
4. Add to `configureOpenClaw`: "check for unsummarized sessions" on reactivation

**Effort:** Medium
**Risk:** Low — enforcement is advisory (marker injection), not destructive
**Impact:** Medium — prevents file bloat over time

### Phase 5: User-Facing Memory Controls (Month 2)

**What:** Let users view and manage their agent's memory via the dashboard:
- View MEMORY.md, session-log.md, active-tasks.md
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

**Bootstrap (auto-loaded):** Only MEMORY.md (~5K chars, ~1,250 tokens). Other memory files NOT auto-loaded (verified — see Section 11.4).

**Session start reads (agent tool calls):** session-log.md (~3K) + active-tasks.md (~1K) = ~4K chars (~1,000 tokens) via 2 file-read tool calls (~2-3 seconds latency).

**Additional cost per session start:** ~1,000 extra tokens × $3/M input = $0.003/session. ~100 session starts/month fleet-wide = **$0.30/mo** — negligible.

**bootstrapMaxChars budget:** 30K per file, 150K total across 9 named bootstrap files. MEMORY.md at 5K uses 17%. Plenty of room.

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
| Memory files per agent | 1-2 (MEMORY.md + maybe active-tasks.md) | 4+ (MEMORY + session-log + active-tasks + dated notes) |
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
| MEMORY.md grows beyond 5K chars | >5K | SOUL.md instructs agent to prune; strip-thinking.py injects consolidation marker at 10KB |
| session-log.md exceeds 15 entries | >15 | SOUL.md instructs agent to archive; Phase 3 hook enforces |
| active-tasks.md exceeds 10 active items | >10 | SOUL.md instructs agent to archive completed tasks |
| Total memory/*.md exceeds 50K chars | >50K | Disk bloat; weekly consolidation should prune; health cron alerts on dated file count |
| Agent overwrites critical MEMORY.md content | Any loss of "About My User" | SOUL.md rule: never delete profile section |
| Memory search returns irrelevant results | >3 user complaints | Audit index quality, adjust embedding model |
| Session summary quality is poor | Manual review shows garbage | Improve summary prompt or switch from Haiku to Sonnet |
| Memory index stale or corrupted | main.sqlite >48h old | Daily cron rebuilds; health cron alerts on staleness |
| Agent ignores filing instructions entirely | MEMORY.md growing, session-log.md empty | Phase 3 hook writes summaries regardless; health cron detects |

---

## 9. Risk Analysis

### CRITICAL FINDING: Agent Non-Compliance (Verified April 6, vm-050)

**vm-050 audit revealed agents are NOT following existing SOUL.md memory instructions:**
- `memory/active-tasks.md` — does NOT exist (never created despite instructions since v41)
- `MEMORY.md` — static from onboarding March 31, never updated by agent (only has strip-thinking.py injection markers)
- `memory/` directory — completely empty (no dated files, no task files)
- Memory index — only 3 chunks, all from MEMORY.md

**This means SOUL.md compliance alone is INSUFFICIENT.** The Phase 3 hook + heartbeat Phase 0 are PRIMARY mechanisms, not optional backups. The defense-in-depth chain is critical:
1. Phase 3 hook writes summary (automated, no agent needed)
2. Heartbeat Phase 0 syncs session-log.md → MEMORY.md (every ≤3h)
3. Bootstrap loads MEMORY.md (guaranteed)

### Phase 1 Risks

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|-----------|
| Agent ignores memory filing instructions entirely | **HIGH** (empirically proven on vm-050) | Medium | Phase 3 hook + heartbeat Phase 0 are the primary mechanisms; SOUL.md is additive, not critical path |
| Agent writes session logs into MEMORY.md instead of session-log.md | Medium | Low | SOUL.md "What Goes Where" table; heartbeat Phase 0 consolidation |
| Agent overwrites important memory content | Low | High | SOUL.md rule + configureOpenClaw backups (ssh.ts:3095) |
| Memory content is low quality | Medium | Low | Better than nothing; iterate on prompts |
| Agent doesn't read session-log.md on session start | **HIGH** (confirmed: memory/*.md NOT auto-loaded by bootstrap) | Medium | MEMORY.md still has recent context (via heartbeat Phase 0); explicit reads are bonus, not critical path |

### Rollback Plan

**Trigger signals for rollback:**
- Agent response quality degrades (incoherent, confused by instructions)
- Agent enters loop trying to read/write memory files instead of responding
- MEMORY.md gets corrupted (critical profile data deleted)
- Gateway crashes or errors related to new SOUL.md content

**What to revert:**
1. **SOUL.md section only:** Remove `MEMORY_FILING_SYSTEM_V1` marker and content from SOUL.md. This is a single reconciler step via `vm-manifest.ts` — remove the entry from the files array, bump manifest version, reconciler auto-pushes fleet-wide (~40 min).
2. **Files stay:** session-log.md and active-tasks.md templates are harmless empty files. Leave them.
3. **Cron stays:** Memory index cron is read-only, non-destructive. Leave it.

**Revert speed:** Manifest change → push to main → reconciler cycle (~40 min) → all VMs updated.

**Phase 3 hook revert:** If the session-end hook in strip-thinking.py causes issues, revert the script template in vm-manifest.ts. Reconciler pushes the old version fleet-wide.

**No manual intervention needed.** All changes are deployed via manifest + reconciler. Revert is a code change to vm-manifest.ts.

### Phase 3 Risks

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|-----------|
| Summary script fails silently | Medium | Low | Log errors to /tmp/session-summary.log; health cron detects stale state file |
| Haiku generates bad summary | Low | Low | Review first 10 summaries manually on canary |
| Script reads wrong session file | Low | Medium | Track session file by path in state file; use modification time ordering |
| Duplicate summary (agent + hook both write) | Medium | Low | Hook checks if session-log.md was modified today before generating |
| Haiku API call fails (rate limit, credits) | Low | Low | Retry once after 5s; skip this session if still fails; next session catches up |

### Edge Case Risks (from stress testing)

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|-----------|
| MEMORY.md exceeds 5K despite instructions | High | Medium | strip-thinking.py injection at 10KB (Phase 4); health cron alert at 10KB (lowered from 25KB) |
| session-log.md grows unbounded (agent never prunes) | Medium | Medium | Phase 3 hook prunes to 15 entries; HEARTBEAT.md Sunday consolidation; health cron alert at >20 entries |
| Abrupt session end (crash/restart/0 credits) | High | High | Phase 3 hook detects transitions; on resubscribe, configureOpenClaw checks for unsummarized sessions |
| Fresh user cold start (no files exist) | Every signup | None | session-log.md template created by manifest; MEMORY.md template exists; graceful degradation — SOUL.md says "if no memory exists, proceed normally" |
| Two sessions write to same file (race) | Low | Low | One gateway per VM; heartbeat isolated session; fcntl locks in strip-thinking.py; worst case: last-write-wins (both adding, not deleting) |
| Memory index corrupted | Low | Low | Daily cron rebuilds from scratch; agent can still read files directly without index |
| Suspended VM reactivates | Per reactivation | None | configureOpenClaw preserves memory for same user; only wipes on reassignment (ssh.ts:2956-2996) |
| bootstrapMaxChars (30K per file) exceeded | Very low | Medium | Only MEMORY.md is bootstrap-loaded; capped at 10KB by strip-thinking.py injection; health cron alerts at 25KB |
| SOUL.md instructions conflict with existing session resume | Low | Medium | New section complements (not replaces) existing Intelligence Supplement; tested on canary first |
| Agent confused by filing system instructions | Low | Low | Instructions are clear with table; agents already write to MEMORY.md and active-tasks.md; this just adds structure |

---

## 10. Platform Comparison Matrix

| Dimension | Claude Code | Manus | Letta/MemGPT | ChatGPT | Our Approach |
|-----------|------------|-------|--------------|---------|--------------|
| Cross-session persistence | CLAUDE.md only | None (fresh sandbox) | Core memory + archival | Cloud DB, all memories every turn | MEMORY.md + memory/*.md files |
| Compaction | 3-tier (MicroCompact → server → LLM summary) | 2-tier (drop tool output → LLM summary) | N/A (unlimited archival) | Background summarization | OpenClaw auto-compaction + memoryFlush |
| Task continuity | None | todo.md recitation at context end | Archival search | Injected every turn | ACTIVE_TASK.md + memory/active-tasks.md |
| Session summaries | Structured XML (7 sections) | N/A | Conversation search | Background batch processing | Phase 3 hook + SOUL.md instructions |
| Memory search | None | File reads | Vector store (archival) | No relevance filtering | SQLite + embeddings (memorySearch) |
| Self-editing memory | Auto-memory writes | File writes | memory_replace/insert tools | create_memory tool call | SOUL.md instructions (file writes) |
| Consolidation | None | None | None | Background processing | HEARTBEAT.md Sunday cycle (every 3h maintenance) |

**Where we're better:** Heartbeat-driven maintenance, session handoff (ACTIVE_TASK.md), fleet-scale operations, existing strip-thinking.py safety net.

**Where they're better:** Claude Code's MicroCompact (zero-cost cache-aware compaction), ChatGPT's reliability (all memories every turn), Letta's structured self-editing tools, Cursor's RL-trained compression (100K→1K).

**Key patterns adopted:**
- From Manus: todo.md recitation → "rewrite active-tasks.md at end of conversation" instruction
- From Claude Code: structured summary format → Phase 3 hook uses: topic, decisions, what's done, what's open
- From Letta: core vs archival separation → MEMORY.md (core, <5K) vs memory/*.md (archival, searchable)
- From ChatGPT: background processing → Phase 3 hook as reliability backstop
- From Google ADK: periodic consolidation → HEARTBEAT.md Phase 0 every 3h + Sunday consolidation

### 10.1 Deep Comparison: Retrieval Gap (Letta vs Us)

Letta has a 3-tier retrieval chain: core memory → recall memory (conversation search) → archival memory (vector search). The key piece we're MISSING is **recall memory** — the ability to search old conversation transcripts. Our `memorySearch` indexes ONLY memory/*.md files, NOT session JSONL files.

**Should we add it?** Not in Phase 1. Session files are 177MB across 383 files. Indexing them would be expensive and most content is tool results (web search, browser output) that aren't useful for memory. The Phase 3 hook captures the valuable content (human conversation summaries) and puts it in memory/session-log.md — which IS indexed. This is a pragmatic Letta approximation without the infrastructure cost.

**Future consideration:** If users frequently reference specific past conversations ("what did I say about X last week?"), add session-transcript indexing as Phase 6.

### 10.2 Deep Comparison: Auto-Memory (ChatGPT vs Us)

ChatGPT decides WHAT to remember automatically — the model calls `create_memory` when it detects persistent facts. Users don't have to ask.

**Can our agents do the same via SOUL.md?** Empirically NO — vm-050 proves agents ignore SOUL.md memory instructions. ChatGPT's `create_memory` works because it's a TOOL CALL that the model is fine-tuned to invoke, not a system prompt instruction.

**Our equivalent:** The Phase 3 hook + heartbeat Phase 0. These are automated processes that don't depend on agent compliance. They're closer to ChatGPT's "background batch processing" than SOUL.md instructions.

**Key insight:** Don't rely on agents to maintain their own memory. Build automated systems that do it FOR them. SOUL.md instructions are bonus (for agents that DO comply), not the primary mechanism.

### 10.3 Deep Comparison: Claude.ai Consumer Memory

Claude.ai uses **opt-in, user-controlled memory** — users explicitly save facts; no auto-extraction from conversations. "Projects" serve as shared workspaces with documents. This is intentionally minimal and user-controlled.

Our approach is more ambitious — **active agent-managed memory** — which is closer to Letta/MemGPT and ChatGPT than to Claude.ai's consumer product. The tradeoff: more infrastructure, but better user experience for always-on personal agents.

---

## 10.5 Validation Plan (A/B Testing)

### Canary Selection
Pick 10 VMs with active users (messages in last 48h) spanning different tiers:
- 3 Pro users ($149/mo) — high engagement
- 5 Basic users ($49/mo) — medium engagement
- 2 Free/trial users — low engagement

**Control group:** 10 similar VMs that do NOT receive the update.

### Deployment
1. Manually SSH into 10 canary VMs
2. Append SOUL_MD_MEMORY_FILING_SYSTEM section to SOUL.md
3. Create `memory/session-log.md` template
4. Create `memory/active-tasks.md` template (if doesn't exist)
5. Rebuild memory index: `openclaw memory index`
6. Do NOT deploy Phase 3 hook yet — test SOUL.md compliance first

### Measurement (after 48 hours)

| Metric | Pass | Fail |
|--------|------|------|
| session-log.md has ≥1 entry on ≥5/10 canary VMs | ≥5 VMs | <5 VMs |
| MEMORY.md updated (mtime changed) on ≥5/10 canary VMs | ≥5 VMs | <5 VMs |
| Control VMs have no session-log.md entries | 0 entries | Any entries |
| Agent references past session in conversation (manual check on 3 VMs) | ≥1 reference | 0 references |
| No agent errors, confusion, or degraded response quality | 0 reports | Any reports |

### Pass/Fail Criteria
- **PASS (proceed to fleet):** ≥5/10 canary VMs have session-log.md entries AND no degradation
- **PARTIAL PASS (proceed with Phase 3 hook as primary):** <5/10 VMs comply but no degradation → confirms SOUL.md alone isn't enough, Phase 3 hook is critical
- **FAIL (rollback):** Agent errors, confusion, or degraded quality on ≥2 VMs

### Expected Outcome
Based on vm-050 audit (agent doesn't follow existing memory instructions), we expect a **PARTIAL PASS** — some agents will comply, most won't. This validates that the Phase 3 hook + heartbeat chain is the primary mechanism, with SOUL.md as bonus. We proceed to Phase 3 regardless.

---

## 11. Codebase Audit — Implementation Notes

### 11.1 Existing Infrastructure (already deployed, no changes needed)

| Component | Location | What It Does |
|-----------|----------|-------------|
| ACTIVE_TASK.md resume | agent-intelligence.ts:330-340 | Check task file on every session start, resume if IN_PROGRESS |
| memory/active-tasks.md | agent-intelligence.ts:437 | Update with completed work summary |
| HEARTBEAT.md Phase 0 | ssh.ts:3357-3362 | Check MEMORY.md staleness every 3h, write update if >24h stale |
| HEARTBEAT.md Phase 0.5 | ssh.ts:3364-3370 | Read active-tasks.md, deliver pending notifications |
| Sunday consolidation | ssh.ts:3426-3436 | Weekly: if MEMORY.md >20KB, consolidate; archive old tasks; clean logs |
| strip-thinking.py | ssh.ts:89-969 | Every 1 min: archive sessions at 200KB, inject memory urgency at 160KB, strip thinking blocks |
| Memory staleness check | strip-thinking.py:840-862 | If MEMORY.md not updated in 24h, inject MEMORY_STALE marker |
| Workspace backup | ssh.ts:3095-3118 | Snapshot MEMORY.md, SOUL.md, sessions before any configureOpenClaw run |
| Privacy guard | ssh.ts:2956-2996 | Wipe previous user's data on VM reassignment |
| Health cron memory check | health-check/route.ts:1491-1547 | Alert: MEMORY_EMPTY (<500B), MEMORY_STALE (>72h), MEMORY_OVERSIZED (>25KB) |

### 11.2 Files to Create/Modify

| File | Change | Mode |
|------|--------|------|
| `vm-manifest.ts` | Add session-log.md template to files array | `create_if_missing` |
| `vm-manifest.ts` | Add SOUL_MD_MEMORY_FILING_SYSTEM to files array | `append_if_marker_absent` |
| `vm-manifest.ts` | Add memory index cron to crons array | marker-based idempotent |
| `agent-intelligence.ts` | Add SOUL_MD_MEMORY_FILING_SYSTEM constant | New export |
| `vm-manifest.ts` | Bump MANIFEST_VERSION to 56 | Number change |

### 11.3 OpenClaw Config — No Changes Needed

All memory config is correct. Verified:
- `bootstrapMaxChars: 30000` — loads MEMORY.md + memory/*.md (ssh.ts:2505)
- `memoryFlush.enabled: true, softThresholdTokens: 8000` — pre-compaction write (ssh.ts:2513-2514)
- `memorySearch.enabled: true` — semantic search (ssh.ts:2518)
- `session.reset.mode: "idle", idleMinutes: 10080` — 7-day idle (ssh.ts:2529-2530)
- `heartbeat.session: "heartbeat"` — isolated (ssh.ts:2509)

### 11.4 bootstrapMaxChars — DEFINITIVE (Verified April 6, vm-050)

**`WorkspaceBootstrapFileName` is a FIXED ENUM** (OpenClaw plugin-sdk/src/agents/workspace.d.ts):

| Bootstrap File | Auto-Loaded? | Current Size (vm-050) |
|---|---|---|
| AGENTS.md | ✅ Yes | 8,586 chars |
| SOUL.md | ✅ Yes | 27,176 chars |
| TOOLS.md | ✅ Yes | 439 chars |
| IDENTITY.md | ✅ Yes | 417 chars |
| USER.md | ✅ Yes | 2,216 chars |
| HEARTBEAT.md | ✅ Yes | 193 chars (workspace copy; full version at agents/main/agent/) |
| BOOTSTRAP.md | ✅ Yes | 0 (consumed) |
| MEMORY.md | ✅ Yes | 3,405 chars |
| **Total** | | **~42K chars** |

**NOT auto-loaded (confirmed):**
- `memory/session-log.md` ❌
- `memory/active-tasks.md` ❌
- `memory/YYYY-MM-DD.md` ❌
- CAPABILITIES.md ❌ (loaded as system prompt separately)
- EARN.md ❌
- QUICK-REFERENCE.md ❌

**Per-file limit:** `bootstrapMaxChars: 30000` (we configured). Default is 20000.
**Total limit:** `bootstrapTotalMaxChars: 150000` (default, not overridden). Current total ~42K = 28% of budget.

**There is NO `extraBootstrapFiles` config key.** The `loadExtraBootstrapFiles()` function exists in source but is called programmatically by plugins, not configurable via openclaw.json.

**`filterBootstrapFilesForSession()`:** Heartbeats with `lightContext: true` get ONLY HEARTBEAT.md. Regular sessions get all 9 files.

**Implication:** `memory/session-log.md` and `memory/active-tasks.md` require explicit agent reads (tool calls) on session start. SOUL.md instructions tell the agent to do this. If agent doesn't comply, the defense-in-depth chain (Hook → Heartbeat → MEMORY.md) ensures MEMORY.md still has recent context.

### 11.5 Fleet Push Strategy

**Deployment path:** vm-manifest.ts change → manifest version bump → reconciler detects drift → auto-pushes to fleet (every ~40 min cycle).

**Canary strategy:**
1. SSH into vm-050, manually create session-log.md and append SOUL.md section
2. Trigger a conversation, verify agent reads session-log.md on session start
3. Verify agent writes to session-log.md at end of conversation
4. Verify bootstrapMaxChars loads session-log.md content (check gateway logs)
5. If all pass → merge to main → reconciler pushes fleet-wide

### 11.6 Session File Format (for Phase 3 hook)

JSONL at `~/.openclaw/agents/main/sessions/*.jsonl`. Each line:
```json
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Hello"}]},"usage":{"input_tokens":100}}
```

Parse strategy for hook:
1. List session files by mtime: `ls -t ~/.openclaw/agents/main/sessions/*.jsonl`
2. Read the SECOND most recent file (previous session — newest is current)
3. Extract lines with `role: "user"` or `role: "assistant"`, skip `tool_use`/`thinking`
4. Take last 20 such lines → concatenate text → send to Haiku for summary

### 11.7 Cron Conflicts

No conflicts. Current crons run at: every minute (strip-thinking, watchdog, etc.), hourly (heartbeat). New memory index cron at 4 AM daily. strip-thinking.py's daily_hygiene runs at ~23h intervals (self-throttled). No overlap.

---

## 12. Appendices

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

**MEMORY.md template** (update in vm-manifest.ts:438-448):
```markdown
# MEMORY.md — Core Identity

## About My User
_[Will be populated from onboarding conversation]_

## Key Preferences
_[Communication style, content preferences — learned over time]_

## Current Focus
_[What they're working on right now]_
```

**memory/session-log.md template** (new, add to vm-manifest.ts):
```markdown
# Session Log

_Session summaries are appended here automatically._
```

**memory/active-tasks.md** — already exists, no template change needed. Format defined in agent-intelligence.ts:423-433.

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

### Appendix F: Phase 3 Python Implementation Spec

This code is added to `strip-thinking.py` (ssh.ts STRIP_THINKING_SCRIPT template). It runs every minute alongside existing session management.

```python
# ═══════════════════════════════════════════════════════════
# SESSION-END SUMMARY HOOK — detect session transitions,
# generate summaries, append to memory/session-log.md
# ═══════════════════════════════════════════════════════════

import json, os, time, subprocess, re
from pathlib import Path
from datetime import datetime, timezone

WORKSPACE = Path.home() / ".openclaw" / "workspace"
SESSIONS_DIR = Path.home() / ".openclaw" / "agents" / "main" / "sessions"
STATE_FILE = Path.home() / ".openclaw" / ".session-summary-state.json"
SESSION_LOG = WORKSPACE / "memory" / "session-log.md"
ARCHIVE_DIR = WORKSPACE / "memory" / "archive"
MAX_SESSION_LOG_ENTRIES = 15
GATEWAY_PROXY_URL = os.environ.get("INSTACLAW_API_URL", "https://instaclaw.io") + "/api/gateway/proxy"
GATEWAY_TOKEN = os.environ.get("GATEWAY_TOKEN", "")
MIN_MESSAGES_FOR_SUMMARY = 4  # Skip trivial sessions

def load_state():
    """Load last-processed session state."""
    try:
        return json.loads(STATE_FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {"last_session_file": None, "last_check_ts": 0}

def save_state(state):
    """Atomic state save."""
    tmp = str(STATE_FILE) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, str(STATE_FILE))

def get_session_files_by_mtime():
    """List session JSONL files sorted by modification time (newest first)."""
    files = list(SESSIONS_DIR.glob("*.jsonl"))
    return sorted(files, key=lambda f: f.stat().st_mtime, reverse=True)

def extract_messages(session_file, max_messages=20):
    """Extract last N user/assistant text messages from session JSONL."""
    messages = []
    try:
        with open(session_file, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                msg = entry.get("message", {})
                role = msg.get("role", "")
                if role not in ("user", "assistant"):
                    continue
                # Extract text from content blocks
                content = msg.get("content", "")
                if isinstance(content, str):
                    text = content
                elif isinstance(content, list):
                    text = " ".join(
                        block.get("text", "")
                        for block in content
                        if isinstance(block, dict) and block.get("type") == "text"
                    )
                else:
                    continue
                if text.strip():
                    messages.append({"role": role, "text": text.strip()[:500]})
    except (IOError, OSError):
        return []
    return messages[-max_messages:]  # Last N messages

def session_log_has_today_entry():
    """Check if session-log.md already has an entry for today."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    try:
        content = SESSION_LOG.read_text()
        return f"## {today}" in content
    except FileNotFoundError:
        return False

def generate_summary_via_haiku(messages):
    """Call Haiku via gateway proxy to generate a session summary."""
    if not GATEWAY_TOKEN:
        return None

    conversation = "\n".join(
        f"{'User' if m['role'] == 'user' else 'Agent'}: {m['text']}"
        for m in messages
    )

    prompt = f"""Summarize this conversation in 3-5 sentences. Focus on:
- What the user wanted / was working on
- Key decisions made
- What's still open / unfinished

Conversation:
{conversation}

Write ONLY the summary, no preamble."""

    payload = json.dumps({
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 300,
        "messages": [{"role": "user", "content": prompt}],
    })

    try:
        result = subprocess.run(
            ["curl", "-s", "--max-time", "30",
             "-H", f"Authorization: Bearer {GATEWAY_TOKEN}",
             "-H", "Content-Type: application/json",
             "-H", "x-model-override: claude-haiku-4-5-20251001",
             "-d", payload,
             GATEWAY_PROXY_URL],
            capture_output=True, text=True, timeout=35
        )
        if result.returncode != 0:
            return None
        resp = json.loads(result.stdout)
        content = resp.get("content", [])
        if content and isinstance(content, list):
            return content[0].get("text", "").strip()
    except (subprocess.TimeoutExpired, json.JSONDecodeError, KeyError, IndexError):
        return None
    return None

def append_to_session_log(summary):
    """Append a dated entry to memory/session-log.md."""
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    SESSION_LOG.parent.mkdir(parents=True, exist_ok=True)

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # Read existing content
    try:
        existing = SESSION_LOG.read_text()
    except FileNotFoundError:
        existing = "# Session Log\n"

    # Append new entry after header
    header_end = existing.find("\n\n")
    if header_end == -1:
        header_end = len(existing)
    header = existing[:header_end]
    body = existing[header_end:]

    new_entry = f"\n\n## {today} — Session Summary\n{summary}"
    updated = header + new_entry + body

    # Prune to MAX_SESSION_LOG_ENTRIES
    entries = re.findall(r"(## \d{4}-\d{2}-\d{2} —[^\n]*\n(?:(?!## \d{4}).)*)", updated, re.DOTALL)
    if len(entries) > MAX_SESSION_LOG_ENTRIES:
        # Archive old entries
        overflow = entries[MAX_SESSION_LOG_ENTRIES:]
        archive_file = ARCHIVE_DIR / f"session-log-archived-{today}.md"
        with open(archive_file, "a") as f:
            for entry in overflow:
                f.write(entry + "\n")
        # Keep only recent entries
        entries = entries[:MAX_SESSION_LOG_ENTRIES]
        updated = header + "\n" + "\n".join(entries)

    # Atomic write
    tmp = str(SESSION_LOG) + ".tmp"
    with open(tmp, "w") as f:
        f.write(updated)
    os.replace(tmp, str(SESSION_LOG))

def run_session_end_hook():
    """Main hook: detect session transition, generate summary if needed."""
    state = load_state()
    files = get_session_files_by_mtime()

    if len(files) < 2:
        return  # Need at least 2 sessions (current + previous)

    current_session = str(files[0])
    previous_session = str(files[1])

    # Check if we already processed this previous session
    if state.get("last_session_file") == previous_session:
        return  # Already processed

    # Check if the agent already wrote a session-log entry today
    if session_log_has_today_entry():
        # Agent handled it — just update state
        state["last_session_file"] = previous_session
        state["last_check_ts"] = int(time.time())
        save_state(state)
        return

    # Check if current session is actually new (created after previous)
    try:
        current_mtime = files[0].stat().st_mtime
        previous_mtime = files[1].stat().st_mtime
        if current_mtime - previous_mtime < 60:
            return  # Sessions too close together, likely not a real transition
    except OSError:
        return

    # Extract messages from previous session
    messages = extract_messages(previous_session)
    if len(messages) < MIN_MESSAGES_FOR_SUMMARY:
        # Trivial session, just mark as processed
        state["last_session_file"] = previous_session
        state["last_check_ts"] = int(time.time())
        save_state(state)
        return

    # Generate summary
    summary = generate_summary_via_haiku(messages)
    if summary:
        append_to_session_log(summary)

    # Update state regardless (don't retry on failure)
    state["last_session_file"] = previous_session
    state["last_check_ts"] = int(time.time())
    save_state(state)

# Called from strip-thinking.py main loop:
# try:
#     run_session_end_hook()
# except Exception as e:
#     # Never let the hook crash strip-thinking.py
#     with open("/tmp/session-summary-error.log", "a") as f:
#         f.write(f"{datetime.now().isoformat()} {e}\n")
```

**Error handling:** Every failure mode returns silently. The hook NEVER crashes strip-thinking.py. Errors logged to `/tmp/session-summary-error.log`. State file prevents re-processing.

**Detection method:** Compares modification times of the 2 most recent session files. If current session is significantly newer than previous, a transition occurred.

**Duplicate prevention:** Checks if session-log.md already has a `## YYYY-MM-DD` entry for today. If agent already wrote one, skips.

**Haiku call:** Goes through the gateway proxy (same auth as agent). Uses `x-model-override` header to force Haiku regardless of agent's configured model.

### Appendix G: MEMORY.md Migration Plan (Existing VMs)

**Current state (vm-050 audit):**
- MEMORY.md: 3,405 chars, static onboarding profile from March 31
- Contains strip-thinking.py injection markers (MEMORY_WRITE_URGENT + MEMORY_STALE)
- NO session-specific content to migrate

**Migration strategy: DO NOTHING to existing MEMORY.md files.**

1. Injection markers are auto-removed by strip-thinking.py when the agent updates MEMORY.md
2. The static onboarding profile IS the "core identity" we want — it's already the right content for the new structure
3. We don't add structured sections to existing files — let agents self-organize (they add headings naturally)
4. For NEW VMs only: the updated MEMORY.md template (Appendix B) has structured sections

**If a user's MEMORY.md has session logs mixed in** (some agents DO update MEMORY.md and put everything in it):
- The heartbeat Sunday consolidation (HEARTBEAT.md) already tells agents to prune MEMORY.md >20KB
- The new SOUL.md Memory Filing System instructions say: "If MEMORY.md currently has session logs or task lists, move them to the correct file"
- If the agent doesn't comply, the content stays in MEMORY.md — harmless, still gets loaded at bootstrap

**No forced migration. No data loss risk. Let the system converge naturally.**

---

*End of PRD. This document is the single source of truth for cross-session memory. Update as phases are implemented and user feedback is collected.*
