# Cross-Session Memory & Conversation Continuity: Deep Research Report

**Date:** 2026-04-03
**Author:** Claude (Opus 4.6) + Cooper Wrenn
**Purpose:** Comprehensive survey of how production AI agent platforms handle cross-session memory — the #1 user complaint for InstaClaw
**Builds on:** `research-session-persistence.md` (2026-03-23) and `PRD-memory-architecture-overhaul.md` (completed 2026-03-24)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Claude Code — Deep Dive](#2-claude-code)
3. [ChatGPT Memory — Deep Dive](#3-chatgpt-memory)
4. [Manus AI — Deep Dive](#4-manus-ai)
5. [Character.ai / Replika — Deep Dive](#5-characterai--replika)
6. [Coding Agents: Devin, Cursor, Replit](#6-coding-agents)
7. [OpenClaw — Native Capabilities](#7-openclaw)
8. [Academic Research & Frameworks](#8-academic-research--frameworks)
9. [Comparative Analysis](#9-comparative-analysis)
10. [Recommendations for InstaClaw](#10-recommendations-for-instaclaw)

---

## 1. Executive Summary

After surveying 10+ platforms, 6 open-source frameworks, and 8 academic papers, one conclusion is clear: **every successful platform converges on the same three-layer architecture**, though they implement it differently:

| Layer | Function | Analogy | InstaClaw Equivalent |
|-------|----------|---------|---------------------|
| **Working Memory** | Current conversation context | CPU registers + RAM | OpenClaw session (200K window) |
| **Episodic Memory** | Specific past interactions, searchable | Disk cache | `memory/YYYY-MM-DD.md` + `memory_search` |
| **Semantic Memory** | Consolidated facts, preferences, rules | Indexed database | `MEMORY.md` + `SOUL.md` |

The key differentiator between platforms is **how they move information between layers** — particularly what happens when working memory overflows (compaction) and when sessions end (handoff). The platforms that solve this well (Claude Code, Devin, Letta/MemGPT) use active memory management: the agent itself decides what to keep, archive, or discard.

**The gap for InstaClaw:** We shipped the session persistence fix (v41, idle mode, 7-day timeout) and the memory architecture overhaul (v45, 52K token budget). But we still lack two critical capabilities that top platforms have:

1. **Pre-reset session summarization** — When a session eventually resets, context is deleted, not summarized (OpenClaw Issue #40418, still open)
2. **Active memory curation** — The agent does not proactively decide what to write to long-term memory before compaction fires; it relies on the pre-compaction memory flush, which is time-limited and lossy

---

## 2. Claude Code

### How It Works

Claude Code has the most well-documented memory architecture of any coding agent, and its source code has been extensively analyzed.

#### 2.1 Dual Memory System

Claude Code maintains two categories of persistent memory:

**Human-written memory (CLAUDE.md):**
- Loaded at session start from three locations: `~/.claude/CLAUDE.md` (global), `./CLAUDE.md` (project root), `./subdir/CLAUDE.md` (directory-specific)
- Survives compaction completely — after `/compact`, CLAUDE.md is re-read from disk and re-injected fresh
- Contains project rules, coding standards, architecture notes, workflow preferences
- Acts as the "semantic memory" layer — stable, high-value, human-curated

**AI-written memory (auto-memory):**
- Stored in `~/.claude/projects/<project-hash>/memory/MEMORY.md`
- Claude writes to this automatically when you correct it ("actually, we use tabs not spaces")
- Injected alongside CLAUDE.md at session start
- Acts as a persistent scratchpad for learned preferences

#### 2.2 Three-Tier Compaction Engine

The source code reveals a sophisticated 3-tier compaction system where **cache economics drive every architectural decision**:

**Tier 1 — MicroCompact (runs before every API call):**
- Lightweight, no model involved, zero cost
- Clears old tool results, keeping only the 5 most recent
- Replaces cleared results with `[Old tool result content cleared]`
- Uses `cache_edits` mechanism — surgical deletion by `tool_use_id` without invalidating the prompt cache
- Preserves the 90% cache discount (vs 1.25x cost of cache rewrites)

**Tier 2 — Server-Side Strategies (API-level):**
- Handles thinking block clearing and tool result trimming based on token thresholds
- Operates within the Anthropic API, not client-side
- Triggered when approaching context limits but before full summarization is needed

**Tier 3 — Full LLM Summarization (the expensive one):**
- Triggers when context reaches ~95% capacity (specifically: `effectiveContextWindowSize - 13,000`)
- For a 200K model, fires at approximately 187K tokens
- Produces a structured summary with 7 mandatory sections:
  1. Primary Request and Intent
  2. Key Technical Concepts
  3. Files and Code Sections Referenced
  4. Errors and Fixes Applied
  5. Current State and Next Steps
  6. Outstanding Questions
  7. Working Hypotheses

**Post-compaction reconstruction sequence:**
1. Boundary marker (compaction indicator)
2. The compacted summary
3. 5 most recently read files (capped at 50K tokens total)
4. Loaded skills
5. Tool definitions
6. CLAUDE.md project instructions (re-read from disk)

#### 2.3 What Survives Between Sessions

Between sessions (when you exit and restart Claude Code):
- **CLAUDE.md files** — always reloaded
- **Auto-memory (MEMORY.md)** — always reloaded
- **Nothing else** — conversation history is gone

This means Claude Code treats session continuity as a **solved problem through file-based memory**. There is no cross-session conversation history. The files ARE the memory.

#### 2.4 Token Cost

- Tier 1 (MicroCompact): ~0 tokens (no model call)
- Tier 2 (Server-side): Included in API response, no separate cost
- Tier 3 (Full summary): One full API call at context limit — roughly 200K input + 2-4K output tokens
- CLAUDE.md injection: Varies, typically 1-5K tokens per session start
- Auto-memory injection: Typically 500-2K tokens

#### 2.5 Key Insight for InstaClaw

Claude Code's approach is **aggressively simple**: files on disk are the only cross-session memory. No database, no vector store, no encrypted state. The sophistication is entirely in the within-session compaction (the 3-tier system) and in giving both humans and the AI the ability to write persistent notes.

**What InstaClaw already has that mirrors this:** MEMORY.md, memory/*.md, SOUL.md, memory_search
**What InstaClaw is missing:** The agent does not proactively write to memory before compaction. Claude Code's model is trained/prompted to do this; our agents need explicit SOUL.md instructions for pre-compaction memory writes.

---

## 3. ChatGPT Memory

### How It Works

ChatGPT has the most mature cross-conversation memory system of any consumer AI product. Reverse engineering efforts (December 2025, January 2026) have revealed its architecture in detail.

#### 3.1 Four Memory Layers

**Layer 1 — Saved Memories (explicit, user-visible):**
- Facts the model detects and stores: name, job, preferences, recurring themes
- Stored as a flat list of key-value-style statements
- User can view, edit, and delete via Settings > Personalization > Saved Memories
- Model creates these automatically via a `create_memory` tool call when it detects a persistent fact
- OpenAI has a set of criteria for what qualifies (identity, preferences, recurring instructions)

**Layer 2 — Topic Memory (implicit, not user-visible):**
- AI-generated summaries of recurring conversation themes
- Stored as structured JSON under a `topic_memory` key in the system prompt
- NOT editable by users through the UI
- Captures patterns like "user frequently asks about Python async patterns" or "user is building a real estate app"
- Automatically generated by periodic background processing of conversation history

**Layer 3 — Recent Conversations Summary (implicit, not user-visible):**
- Pre-computed dense summaries of recent chat history
- OpenAI periodically generates these from conversation logs
- Condensed hundreds of conversations into detailed paragraphs
- Injected as "User Knowledge Memories" in the system prompt

**Layer 4 — Current Session (standard context window):**
- The active conversation, managed with standard context windowing
- When conversations grow long, older messages are truncated

#### 3.2 How Memories Are Injected

Every ChatGPT prompt includes, in order:
1. System Instructions (OpenAI's base prompt)
2. Developer Instructions (for GPTs/custom setups)
3. Session Metadata (timestamp, user locale, device)
4. **User Memory block** — all Saved Memories + Topic Memory + Recent Conversation summaries
5. Current session messages
6. User's latest message

The memory block is injected into EVERY turn, regardless of relevance. This is a deliberately wasteful design based on the bet that context windows will keep growing and costs will keep falling.

#### 3.3 How Decisions Are Made: Remember vs. Forget

- **Remember:** Model calls `create_memory` tool when it detects identity facts, stated preferences, recurring instructions, or project context
- **Prioritization:** ChatGPT Plus/Pro automatically manages memory priority based on recency and frequency of mention
- **Forget:** Users manually delete; OpenAI does not auto-forget (except to consolidate redundant memories)
- **No relevance filtering:** All memories are injected always — no retrieval step, no RAG, no vector search

#### 3.4 Token Cost

- Memory injection: Estimated 2-10K tokens per turn (varies by memory size)
- No per-turn retrieval cost (no vector search, no embedding calls)
- Background summarization: Periodic batch processing cost (not per-turn)
- Total overhead: Roughly 3-8% of context window consumed by memory on every turn

#### 3.5 Key Insight for InstaClaw

ChatGPT's approach is **maximally simple at inference time** — dump everything into the prompt, always, with no retrieval logic. The complexity is pushed to background batch processing (summarization) and the model's own ability to call `create_memory`.

**Relevance to InstaClaw:** Our agents already have `MEMORY.md` (analogous to Saved Memories) and `memory/*.md` (analogous to Topic Memory). What we lack:
1. **Automatic memory creation** — ChatGPT's model calls `create_memory` without being asked; our agents only write to memory when explicitly instructed or when the pre-compaction flush fires
2. **Background summarization** — ChatGPT periodically processes conversation history offline; we have no offline summarization pipeline

---

## 4. Manus AI

### How It Works

Manus is a task-oriented agent platform (not a persistent companion), so its memory model is fundamentally different — but its context engineering innovations are directly applicable.

#### 4.1 File System as Infinite Memory

Manus's core insight: **the file system IS the memory system**. The agent writes intermediate results, plans, and notes to files, then loads only summaries into context. Full content remains accessible via file paths, achieving high compression while maintaining recoverability.

This is the "recoverable compression" pattern:
- Drop the content from context
- Keep the file path/URL
- The agent can re-read the file if it needs the details later
- Compression ratio: effectively unlimited (a 50KB analysis becomes a 200-byte file reference)

#### 4.2 todo.md as Attention Management

Manus creates a `todo.md` file for complex tasks and **rewrites it at the end of every context window**. This exploits recency bias — the model pays more attention to tokens near the end of the context. By constantly rewriting the task list, Manus "recites its objectives" into the most-attended position.

The todo.md also serves as a **cross-compaction handoff**. If context is compacted, the todo.md on disk preserves:
- What tasks are done (checked off)
- What tasks remain
- The current approach/strategy

#### 4.3 No Cross-Session Memory

Every Manus session starts fresh in a new sandbox. There is no cross-session memory system. For Manus, this is acceptable because tasks are typically completed within a single session. For enterprise use cases requiring long-term memory, they acknowledge that vector indexes become necessary.

#### 4.4 KV-Cache Optimization

Manus optimizes for the KV-cache by making context append-only:
- Tool definitions are fixed at the start (never reordered)
- New messages are only appended, never inserted
- This maximizes cache hit rates and reduces latency

#### 4.5 Two-Tier Compaction

1. **Compaction (reversible):** Drop tool outputs but keep file references; agent can re-read if needed
2. **Summarization (lossy):** Full LLM summary when compaction isn't enough

#### 4.6 Key Insight for InstaClaw

The todo.md pattern is **directly implementable** in our architecture. Our agents already have `memory/active-tasks.md` — but it's only written during session handoff instructions, not continuously rewritten. Making our agents rewrite their task list at the end of every major action would significantly improve continuity through compaction events.

---

## 5. Character.ai / Replika

### How It Works

Character.ai and Replika represent the "companion AI" category — platforms where relationship continuity is the entire product, not just a nice-to-have.

#### 5.1 Character.ai's Memory Problem

Character.ai has historically had the **worst memory** of any major platform:
- Memory resets at turn 21 on average
- 21% retention by turn 40 (4 out of 5 details lost)
- Context window is among the shortest tested
- No explicit cross-session memory until May 2025

**Chat Memories (May 2025):**
- Official feature that stores key facts across conversations
- Limited and frequently criticized by users
- Users report it helps with basic facts (character's name, user's name) but fails on nuanced relationship context

**PipSqueak model (late 2025):**
- New model architecture designed for longer coherence
- Better at staying "in character" for 30+ messages (vs 20 previously)
- Still no robust cross-session memory

#### 5.2 Replika's Approach

Replika takes a more structured approach:
- **Memory journal:** The AI maintains a diary of key relationship events
- **Personality profile:** Learned traits and preferences stored as structured data
- **Relationship state:** Tracks the evolving relationship dynamics
- No published architecture details, but user reports suggest ~5K token memory injection per session

#### 5.3 Community Workarounds

The Character.ai community has developed workarounds:
- **Lorebooks:** User-maintained character backstory documents injected into prompts
- **Memory extension tools:** Third-party browser extensions that capture and re-inject conversation highlights
- **Recap prompts:** Users manually ask the AI to summarize before long conversations end

#### 5.4 Key Insight for InstaClaw

Character.ai is a cautionary tale: **short context windows with no persistent memory destroy user trust**. Users will tolerate imperfect memory (ChatGPT's sometimes-wrong recalls) far more than total amnesia. The bare minimum for relationship-oriented AI is:
1. Remember the user's name and key facts
2. Remember what you were working on together
3. Acknowledge when you don't remember rather than confabulating

Our agents clear this bar via MEMORY.md + SOUL.md, but only if the agent proactively writes to memory before sessions end.

---

## 6. Coding Agents: Devin, Cursor, Replit

### 6.1 Devin

**Session Model:** Sessions sleep, never terminate. Can wake and resume at any checkpoint.

**Knowledge Base:**
- Persistent collection of tips, instructions, and organizational context
- Automatically recalled when relevant (implicit retrieval, not explicit search)
- Survives across all sessions — the agent's long-term institutional memory
- Users add knowledge items over time; Devin surfaces them contextually

**Playbooks:** Reusable task templates with embedded context. Editable mid-session.

**Checkpoint/Restore:**
- Full timeline scrubbing — rollback files AND memory to any past moment
- Useful for undoing wrong decisions, exploring alternatives, iterating on prompts
- The closest thing to "undo" in any AI agent platform

**Cross-Session Memory:** Knowledge Base items + accumulated Playbooks + session checkpoints. No automatic memory extraction from conversations.

**Token Cost:** Not published. Knowledge Base injection is estimated at 2-10K tokens depending on relevance matching.

**Key Innovation:** "Context anxiety" — Cognition discovered that models take shortcuts when they believe context is running low. Devin deliberately over-reports available context to prevent this. This finding is relevant for OpenClaw's compaction behavior.

### 6.2 Cursor (Composer 2)

**Self-Summarization via RL:**
- Cursor trained Composer to summarize its own context using reinforcement learning
- When hitting a fixed token-length trigger, Composer pauses, compresses context to ~1,000 tokens, continues
- **100K tokens compressed to 1K** — 100:1 compression ratio
- 50% less error than prompted summarization (the model learns what developers actually need)
- 5x more token-efficient than standard prompt-based summaries
- Reuses KV cache (stored intermediate computations from prior tokens)

**Training Methodology ("Compaction-in-the-Loop RL"):**
1. Model works on a long coding task
2. At a fixed token threshold, model must summarize its own context
3. Model continues working from the summary
4. RL reward is based on task completion quality AFTER summary
5. Over many iterations, the model learns to preserve exactly what matters for coding tasks

**Cross-Session Memory:**
- `.cursor/rules/` — project-level rules files (like CLAUDE.md)
- Codebase indexing — semantic index of the entire project
- No conversation memory across sessions
- Sessions degrade after ~2 hours due to model-reality desynchronization

**Token Cost:** Composer 2 at $0.50/M tokens — dramatically cheaper than frontier models. The self-summarization training amortizes compaction cost into the base model.

**Key Innovation:** RL-trained summarization > prompted summarization. If OpenClaw ever exposes a compaction customization hook, a fine-tuned summarizer would dramatically outperform the current prompted approach.

### 6.3 Replit Agent

**Decision-Time Guidance:**
- Inject situational instructions at key moments, NOT in the system prompt
- Nudges appear at the bottom of the trace (exploiting recency bias)
- 15% more parallel tool calls when guidance is at trace bottom vs system prompt
- Notifications, not context dumps — the agent is told errors exist and pulls logs itself

**Project Continuity:**
- `replit.md` — project-level AI instructions (analogous to CLAUDE.md)
- Snapshot Engine — captures entire state (code + DB + conversation) as checkpoints
- Agent works autonomously for 200+ minutes, building and testing
- Agents build continuously — "give 20 minutes of direction per day, wake up to new features"

**Cross-Session Memory:** Snapshot history + replit.md. No extracted conversation memory.

**Key Innovation:** Minimal injection at decision time > heavy injection at session start. This aligns with Manus's todo.md recitation strategy — put critical context where the model will attend to it most.

---

## 7. OpenClaw — Native Capabilities

### 7.1 What Exists Today (v2026.3.22+)

Based on our verified testing (v41-v45 deployment), OpenClaw provides:

| Feature | Status | Config Key | Notes |
|---------|--------|-----------|-------|
| Session reset (daily/idle) | Working | `session.reset.mode` | We use `idle` with 7-day timeout |
| Pre-compaction memory flush | Working | `compaction.memoryFlush.*` | Agent writes to MEMORY.md before compaction |
| Memory files (MEMORY.md) | Working | N/A (convention) | Loaded at session start |
| Daily memory logs | Working | N/A (convention) | `memory/YYYY-MM-DD.md` files |
| memory_search tool | Working | N/A (built-in) | FTS5 + vec0 semantic search over memory index |
| Heartbeat isolation | **Schema-rejected** | `heartbeat.isolatedSession` | NOT in v2026.2.24 schema; we use `heartbeat.session: "heartbeat"` |
| Compaction (auto) | Working | `compaction.enabled` | Fires on context overflow |
| Session maintenance | Working | `session.maintenance.*` | Prunes old sessions, enforces disk budget |
| Tool result pruning | Working | Cache-TTL based | Trims tool outputs after cache TTL expires |

### 7.2 What Does NOT Exist (Confirmed Gaps)

| Feature | Status | Issue |
|---------|--------|-------|
| Pre-reset session summarization | **Missing** | Issue #40418 (PR #50584 pending) |
| Persistent named sessions (survive gateway restart) | **Missing** | Issue #19780 |
| Session handoff on reset | **Missing** | No mechanism to summarize before delete |
| Custom compaction prompts | **Missing** | Cannot customize what the compaction summary preserves |
| Cross-session conversation search | **Partial** | `memory_search` indexes memory files, NOT session transcripts |
| Memory consolidation (background) | **Missing** | No offline processing of memories |

### 7.3 The Critical Gap: Session Reset = Data Destruction

When a session resets (either by idle timeout or user command):
1. Old session is **deleted, not compacted**
2. No summary is generated
3. No handoff mechanism exists
4. Only MEMORY.md and memory/*.md survive
5. The agent starts cold

This is the #1 architectural gap. Every other platform either avoids resets entirely (Claude Code, Devin) or generates a summary before reset (ChatGPT's background summarization).

---

## 8. Academic Research & Frameworks

### 8.1 Multi-Layered Memory Architectures (arXiv 2603.29194, March 2026)

This paper experimentally validates the three-tier memory model:

**Architecture:** Working memory (active context) + Episodic memory (specific interaction records) + Semantic memory (consolidated rules/patterns), with adaptive retrieval gating that decides which tier to query.

**Benchmarks (LOCOMO, LOCCO):**
- 46.85 Success Rate
- 0.618 overall F1, 0.594 multi-hop F1
- 56.90% six-period retention
- False memory rate reduced to 5.1%
- Context usage: 58.40% (efficient)

**Key finding:** Retention regularization (penalizing the model for forgetting previously-stored facts) is critical. Without it, new memories displace old ones.

### 8.2 Mem0 (arXiv 2504.19413, April 2025)

Production-ready memory layer, now the most-adopted open-source memory framework.

**Architecture:**
- **Extract phase:** Process messages + historical context to create candidate memories
- **Update phase:** Evaluate candidates against existing memories; apply store/update/delete via tool calls
- **Conversation summary module:** Async background process that periodically refreshes a dense summary of conversation history
- **Mem0g (graph variant):** Stores memories as directed labeled graphs (entity nodes + relationship edges)

**Benchmarks:**
- 26% relative improvement over OpenAI's memory on LLM-as-Judge metric
- 91% lower p95 latency than full-context approaches
- 90%+ token cost savings vs. stuffing full history into context

**Key finding:** Graph-based memory (Mem0g) adds ~2% over flat memory, but at significant complexity cost. For most use cases, flat extracted memories are sufficient.

### 8.3 Letta/MemGPT (OS-Inspired Self-Editing Memory)

The foundational paper (October 2023) that started the modern agent memory movement.

**Architecture (three tiers, OS-inspired):**
- **Core memory (RAM):** Always in-context, small, curated. Contains `persona` block (who the agent is) and `human` block (what the agent knows about the user). Agent edits these directly.
- **Archival memory (disk):** External vector store, queried via `archival_memory_search` tool. Unlimited size.
- **Recall memory (swap):** Conversation history, searchable via `conversation_search` and `conversation_search_date` tools.

**Self-Editing Tools:**
- `memory_replace` — overwrite a core memory block
- `memory_insert` — add to a core memory block
- `memory_rethink` — restructure core memory for better organization
- `archival_memory_insert` — write to long-term archive
- `archival_memory_search` — retrieve from archive

**Key Innovation:** The agent is not a passive consumer of retrieved context — it is an **active curator** of its own knowledge base. The agent decides what's important enough to keep in core memory vs. what to archive.

**Relevance to InstaClaw:** This is the most directly applicable framework. Our agents already have the infrastructure (MEMORY.md = core memory, memory/*.md = archival, memory_search = recall). What we lack is the **active curation behavior** — the agent proactively managing its own memory without being told to.

### 8.4 Google's Always-On Memory Agent (March 2026)

**Architecture:**
- Three specialist sub-agents: **Ingest** (process new information), **Consolidate** (background processing), **Query** (retrieve on demand)
- Memory stored in **SQLite** (not a vector database)
- LLM reads structured SQLite tables directly for retrieval
- 30-minute consolidation cycle runs in background

**Key finding:** "No vector database. No embeddings. Just an LLM that reads, thinks, and writes structured memory." For single-agent use cases with moderate memory volume, structured text in SQLite + LLM reasoning outperforms vector similarity search.

**Relevance to InstaClaw:** OpenClaw already has `memory/main.sqlite` with FTS5 + vec0. Google's approach validates that this is sufficient — we don't need a separate vector database.

### 8.5 Agentic Memory / AgeMem (February 2026)

Treats five memory operations as RL-optimized tool calls:
- **Store, Retrieve, Update, Summarize, Discard** — all callable tools
- Three-stage RL pipeline with step-wise GRPO
- Consistently outperforms baselines on five long-horizon benchmarks

**Key finding:** RL-optimized memory management > hand-crafted heuristics. The model learns when to store, when to forget, and when to consolidate — without human-designed rules.

### 8.6 JetBrains Research: Observation Masking (December 2025)

**Key finding:** Removing tool outputs while keeping reasoning traces (observation masking) matches or beats full LLM summarization for context management. This is cheaper and faster than generating summaries.

**Relevance to InstaClaw:** OpenClaw's Tier 1 compaction already does this (clearing old tool results). This research validates that approach as optimal for the first stage of context management.

### 8.7 ICLR 2026 MemAgents Workshop

The first major academic workshop dedicated to agent memory systems. Key themes:
- Episodic memory is the "missing piece" for long-term agents
- Most systems implement only 2 of 3 memory tiers well
- Tier transitions use crude heuristics — RL optimization is the frontier
- Benchmarks for non-i.i.d., long-horizon memory are still immature

### 8.8 IBM Recommendation

Hard token cap of ~20,000 tokens for memory stores. Beyond this, injection overhead outweighs memory benefits. Aligns with OpenClaw's `keepRecentTokens: 20000` default.

---

## 9. Comparative Analysis

### 9.1 Cross-Session Memory: How Each Platform Stores It

| Platform | Storage Mechanism | Human-Editable? | Agent-Editable? | Survives Restart? |
|----------|------------------|-----------------|-----------------|-------------------|
| **Claude Code** | CLAUDE.md + auto-memory (files) | Yes | Yes | Yes |
| **ChatGPT** | Saved Memories + Topic Memory (cloud DB) | Partial (saved only) | Yes (auto-create) | Yes |
| **Manus** | File system (todo.md, output files) | No (sandbox) | Yes | No (per-task) |
| **Character.ai** | Chat Memories (cloud DB) | Limited | Limited | Partially |
| **Devin** | Knowledge Base + Playbooks (cloud) | Yes | No | Yes |
| **Cursor** | .cursor/rules/ + codebase index | Yes | No | Yes |
| **Replit** | replit.md + snapshots | Yes | No | Yes |
| **Letta/MemGPT** | Core memory + archival (vector DB) | Via API | Yes (self-edit) | Yes |
| **Mem0** | Extracted memories (DB + optional graph) | Via API | Yes (auto-extract) | Yes |
| **OpenClaw** | MEMORY.md + memory/*.md + SQLite | Yes | Yes | Yes |
| **InstaClaw** | MEMORY.md + memory/*.md + SOUL.md | Yes (via SSH) | Yes | Yes |

### 9.2 What Gets Remembered vs. Forgotten

| Platform | Auto-Remember | Auto-Forget | User-Triggered Remember | Consolidation |
|----------|--------------|-------------|------------------------|---------------|
| **Claude Code** | Corrections, preferences | Nothing (manual) | CLAUDE.md edits | None |
| **ChatGPT** | Identity, preferences, recurring themes | Redundant memories consolidated | "Remember this" | Background batch |
| **Letta/MemGPT** | Agent-decided (via tools) | Agent-decided (via tools) | API-injected | Agent-initiated |
| **Mem0** | Extracted from every conversation | Conflicting/outdated consolidated | API-injected | Async background |
| **OpenClaw** | Pre-compaction flush | Session reset deletes all | Agent writes to memory files | None |
| **Google AOM** | Continuous ingestion | Consolidation merges/prunes | Manual ingestion | 30-min cycle |

### 9.3 Token Cost of Memory Systems

| Platform | Per-Turn Memory Overhead | Background Cost | Architecture Complexity |
|----------|------------------------|-----------------|----------------------|
| **Claude Code** | 1-5K (CLAUDE.md) | None | Low (files only) |
| **ChatGPT** | 2-10K (all memory blocks) | Periodic summarization | Medium (cloud DB) |
| **Manus** | ~0 (file references only) | None | Low (file system) |
| **Letta/MemGPT** | 2-8K (core memory block) | Vector indexing | High (vector DB + tools) |
| **Mem0** | 1-5K (extracted memories) | Async extraction | Medium (DB + optional graph) |
| **Google AOM** | Variable (LLM reads SQLite) | 30-min consolidation | Medium (SQLite + 3 sub-agents) |
| **OpenClaw/InstaClaw** | 2-8K (MEMORY.md + memory files) | None | Low (files + SQLite) |

### 9.4 Published Benchmarks

| System | Benchmark | Score | Notes |
|--------|-----------|-------|-------|
| Multi-Layer Memory (paper) | LOCOMO F1 | 0.618 | Three-tier with retrieval gating |
| Multi-Layer Memory (paper) | Six-period retention | 56.90% | With retention regularization |
| Multi-Layer Memory (paper) | False memory rate | 5.1% | Low confabulation |
| Mem0 | LLM-as-Judge vs OpenAI | +26% relative | Flat memory extraction |
| Mem0g | LLM-as-Judge vs Mem0 | +2% relative | Graph adds marginal value |
| Cursor self-summarization | Error vs prompted summary | -50% | RL-trained >> prompted |
| Cursor self-summarization | Token efficiency | 5x | 100K -> 1K tokens |
| Character.ai | Retention at turn 40 | 21% | Worst in class |

---

## 10. Recommendations for InstaClaw

### 10.1 What We Already Have (Post-Overhaul)

After the v41-v45 memory architecture overhaul:
- 52K token conversation budget (up from 32K)
- 7-day idle timeout (no more 4AM daily wipe)
- Pre-compaction memory flush enabled (8000 token threshold)
- MEMORY.md + memory/*.md + memory_search
- strip-thinking.py as sole session manager (race condition fixed)
- Memory health dashboard at /hq/memory-health

### 10.2 Recommended Next Steps (Priority Order)

#### Priority 1: Active Memory Curation via SOUL.md (Low effort, high impact)

**What:** Update SOUL.md to instruct agents to proactively write important context to memory files — not just during pre-compaction flush, but as a regular habit.

**Pattern from:** ChatGPT (auto `create_memory`), Letta/MemGPT (self-editing tools)

**Implementation:**
Add to SOUL.md:
```
## Memory Hygiene

After every significant interaction (new project discussed, preference learned, 
task completed, important decision made), write a brief note to memory:
- Use `memory/active-tasks.md` for in-progress work
- Use `MEMORY.md` for permanent facts about the user
- Use `memory/YYYY-MM-DD.md` for daily activity logs

Before ending any extended conversation (10+ messages), proactively update 
memory/active-tasks.md with current state so you can resume seamlessly.
```

**Token cost:** ~200 tokens of SOUL.md instruction. Memory writes are ~50-200 tokens each.
**Expected impact:** Significant improvement in post-compaction and post-reset continuity.

#### Priority 2: todo.md Recitation Pattern (Low effort, medium impact)

**What:** Instruct agents to maintain and rewrite `memory/active-tasks.md` at the end of every major action, not just at session boundaries.

**Pattern from:** Manus AI (todo.md recitation), Replit (decision-time guidance)

**Implementation:**
Add to SOUL.md:
```
## Task Recitation

When working on multi-step tasks, rewrite memory/active-tasks.md after each 
major step. Include:
- What's done (checked off)
- What's next
- Current approach/strategy
- Any blockers or open questions

This ensures continuity if your context is compacted mid-task.
```

**Token cost:** ~150 tokens of instruction + ~500 tokens per active-tasks.md rewrite.
**Expected impact:** Major improvement in task continuity through compaction events.

#### Priority 3: Pre-Reset Session Summary (Medium effort, high impact, blocked on OpenClaw)

**What:** When a session eventually resets (7-day idle timeout or user `/reset`), generate a summary and save it to `memory/session-summary-TIMESTAMP.md` before destroying the session.

**Pattern from:** ChatGPT (background summarization), Google AOM (consolidation cycle)

**Status:** OpenClaw Issue #40418 proposes this natively. PR #50584 is pending. If it ships, enable it. If not, we need a workaround.

**Workaround if #40418 doesn't ship:**
Add a cron job that detects stale sessions (approaching idle timeout) and injects a "summarize yourself" message before the reset fires. This is hacky but functional.

**Token cost:** One API call at session end (~50K input + 2K output).
**Expected impact:** Eliminates total context loss on session reset — the #1 remaining gap.

#### Priority 4: Background Memory Consolidation (Medium effort, medium impact)

**What:** A lightweight background process (cron or heartbeat extension) that periodically reviews memory files and consolidates them.

**Pattern from:** Google AOM (30-min consolidation), ChatGPT (periodic batch summarization), Mem0 (async conversation summary module)

**Implementation:**
- Run weekly via heartbeat or cron
- Read all `memory/YYYY-MM-DD.md` files from the past 30 days
- Generate a consolidated summary → write to `MEMORY.md`
- Prune daily files older than 30 days (archive, don't delete)

**Token cost:** One API call per week (~20K input + 2K output).
**Expected impact:** Prevents memory file bloat; ensures MEMORY.md stays current and concise.

#### Priority 5: Structured Memory Blocks (Higher effort, high impact, long-term)

**What:** Move from free-text MEMORY.md to structured memory sections that map to the three-tier model.

**Pattern from:** Letta/MemGPT (persona + human blocks), ChatGPT (Saved Memories + Topic Memory)

**Implementation:**
```markdown
# MEMORY.md

## User Profile
- Name: ...
- Preferences: ...
- Communication style: ...

## Active Projects
- Project A: status, last action, next step
- Project B: ...

## Learned Patterns
- User prefers X over Y when doing Z
- Trading style: ...

## Important Dates & Events
- ...
```

**Token cost:** Same as current MEMORY.md (2-5K tokens), but better organized.
**Expected impact:** More consistent memory quality; easier for the agent to update specific sections.

#### NOT Recommended (For Now)

- **Vector database / RAG pipeline:** Overkill for single-agent VMs. Google AOM and our existing SQLite + FTS5 + vec0 are sufficient.
- **RL-trained compaction:** Requires model fine-tuning. Cursor can do this because they train their own model. We use Anthropic's models as-is.
- **Graph-based memory (Mem0g):** Only 2% improvement over flat memory at significant complexity cost.
- **Encrypted opaque compaction (OpenAI style):** Proprietary to OpenAI's infrastructure; not implementable on OpenClaw.

### 10.3 Architecture Vision

```
┌─────────────────────────────────────────────────────┐
│                   Context Window (200K)               │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ │
│  │  SOUL.md      │ │  MEMORY.md   │ │  Skills      │ │
│  │  (identity)   │ │  (semantic)  │ │  (20 SKILL.md│ │
│  │  ~5K tokens   │ │  ~5K tokens  │ │  ~80K tokens)│ │
│  └──────────────┘ └──────────────┘ └──────────────┘ │
│  ┌──────────────┐ ┌──────────────────────────────┐   │
│  │ active-tasks  │ │     Conversation (working     │   │
│  │ (episodic)   │ │     memory) ~52K tokens       │   │
│  │ ~2K tokens   │ │                               │   │
│  └──────────────┘ └──────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
            │                    │
            ▼                    ▼ (compaction / flush)
┌──────────────────┐  ┌──────────────────┐
│  memory/*.md     │  │  memory_search   │
│  (episodic)      │  │  (SQLite FTS5)   │
│  daily logs      │  │  semantic recall  │
│  session summaries│  │  over all memory │
└──────────────────┘  └──────────────────┘
            │
            ▼ (weekly consolidation)
┌──────────────────┐
│  MEMORY.md       │
│  (semantic)      │
│  consolidated    │
│  long-term facts │
└──────────────────┘
```

### 10.4 Success Metrics

| Metric | Current | Target | How to Measure |
|--------|---------|--------|---------------|
| User reports of "agent forgetting" | ~2/week | <1/month | Support tickets + /hq dashboard |
| Post-compaction task continuity | Unknown | >80% task resume success | Manual testing on 10 multi-step tasks |
| Memory file freshness | Sporadic writes | Daily MEMORY.md updates | Audit file timestamps fleet-wide |
| Post-reset context recovery | 0% (total loss) | >60% key facts preserved | Test with planted facts before reset |
| Token overhead of memory | ~8K/turn | <10K/turn | Monitor via /hq/memory-health |

---

## Sources

### Platform Documentation & Engineering Blogs
- [Claude Code: How Claude Remembers Your Project](https://code.claude.com/docs/en/memory)
- [Claude Code: How Claude Code Works](https://code.claude.com/docs/en/how-claude-code-works)
- [Anthropic: Effective Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Anthropic: Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Anthropic: Compaction API Docs](https://platform.claude.com/docs/en/build-with-claude/compaction)
- [Anthropic: Memory Tool API Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)
- [OpenAI: Memory and New Controls for ChatGPT](https://openai.com/index/memory-and-new-controls-for-chatgpt/)
- [OpenAI: Compaction Guide](https://developers.openai.com/api/docs/guides/compaction)
- [OpenAI: Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq)
- [Manus: Context Engineering for AI Agents](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- [Devin: Session Insights & Release Notes](https://docs.devin.ai/release-notes)
- [Devin: Instructing Devin Effectively](https://docs.devin.ai/essential-guidelines/instructing-devin-effectively)
- [Cognition: Rebuilding Devin for Claude Sonnet 4.5](https://cognition.ai/blog/devin-sonnet-4-5-lessons-and-challenges)
- [Cursor: Training Composer for Longer Horizons (Self-Summarization)](https://cursor.com/blog/self-summarization)
- [Replit: Decision-Time Guidance](https://blog.replit.com/decision-time-guidance)
- [Replit: Inside Replit's Snapshot Engine](https://blog.replit.com/inside-replits-snapshot-engine)

### Reverse Engineering & Technical Analysis
- [Claude Code's Compaction Engine: What the Source Code Actually Reveals](https://barazany.dev/blog/claude-codes-compaction-engine)
- [Claude Code Context Buffer: The 33K-45K Token Problem](https://claudefa.st/blog/guide/mechanics/context-buffer-management)
- [Context Compaction Research: Claude Code, Codex CLI, OpenCode, Amp](https://gist.github.com/badlogic/cd2ef65b0697c4dbe2d13fbecb0a0a5f)
- [How ChatGPT Memory Works, Reverse Engineered](https://llmrefs.com/blog/reverse-engineering-chatgpt-memory)
- [Reverse Engineering ChatGPT's Updated Memory System (Julian Fleck)](https://medium.com/@j0lian/reverse-engineering-chatgpts-updated-memory-system-3cb9e82e5d21)
- [How ChatGPT Remembers You: A Deep Dive (Embrace The Red)](https://embracethered.com/blog/posts/2025/chatgpt-how-does-chat-history-memory-preferences-work/)
- [I Reverse Engineered ChatGPT's Memory System (Manthan)](https://manthanguptaa.in/posts/chatgpt_memory/)
- [Inside Claude Code Architecture (Penligent)](https://www.penligent.ai/hackinglabs/inside-claude-code-the-architecture-behind-tools-memory-hooks-and-mcp/)

### Academic Papers & Research
- [MemGPT: Towards LLMs as Operating Systems (arXiv 2310.08560)](https://arxiv.org/abs/2310.08560)
- [Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory (arXiv 2504.19413)](https://arxiv.org/abs/2504.19413)
- [Multi-Layered Memory Architectures for LLM Agents (arXiv 2603.29194)](https://arxiv.org/abs/2603.29194)
- [Memory for Autonomous LLM Agents: Mechanisms, Evaluation, and Emerging Frontiers (arXiv 2603.07670)](https://arxiv.org/html/2603.07670)
- [A-Mem: Agentic Memory for LLM Agents (arXiv 2502.12110)](https://arxiv.org/pdf/2502.12110)
- [Position: Episodic Memory is the Missing Piece for Long-Term LLM Agents (arXiv 2502.06975)](https://arxiv.org/pdf/2502.06975)
- [Memory in the Age of AI Agents: A Survey (Paper List)](https://github.com/Shichun-Liu/Agent-Memory-Paper-List)
- [ICLR 2026 MemAgents Workshop](https://openreview.net/pdf?id=U51WxL382H)
- [JetBrains Research: Efficient Context Management (Dec 2025)](https://blog.jetbrains.com/research/2025/12/efficient-context-management/)

### Frameworks & Tools
- [Letta (MemGPT) Platform](https://github.com/letta-ai/letta)
- [Mem0: Universal Memory Layer](https://github.com/mem0ai/mem0)
- [Google Always-On Memory Agent](https://github.com/GoogleCloudPlatform/generative-ai/tree/main/gemini/agents/always-on-memory-agent)
- [Engram: Persistent Memory for AI Coding Agents](https://github.com/Gentleman-Programming/engram)
- [Claude-Mem: Memory Plugin for Claude Code](https://github.com/thedotmack/claude-mem)
- [Anthropic Claude Code Issue #34556: Persistent Memory Across Compactions](https://github.com/anthropics/claude-code/issues/34556)

### OpenClaw Issues
- [Issue #40418: Automated session memory preservation](https://github.com/openclaw/openclaw/issues/40418)
- [Issue #19780: Persistent named sessions](https://github.com/openclaw/openclaw/issues/19780)
- [Issue #31322: Silent daily resets after v2026.2.26](https://github.com/openclaw/openclaw/issues/31322)
- [Issue #31435: Memory flush threshold too small](https://github.com/openclaw/openclaw/issues/31435)
- [Issue #19524: Extended thinking breaks compaction](https://github.com/openclaw/openclaw/issues/19524)
- [PR #50584: Pre-reset session summary](https://github.com/openclaw/openclaw/pull/50584)

### Industry Analysis
- [Context Anxiety: How AI Agents Panic (Inkeep)](https://inkeep.com/blog/context-anxiety)
- [Fighting Context Rot (Inkeep)](https://inkeep.com/blog/fighting-context-rot)
- [Letta Blog: Agent Memory — How to Build Agents that Learn](https://www.letta.com/blog/agent-memory)
- [Google PM Open-Sources Always-On Memory Agent (VentureBeat)](https://venturebeat.com/orchestration/google-pm-open-sources-always-on-memory-agent-ditching-vector-databases-for)
- [AI Memory Explained: What Perplexity, ChatGPT, Pieces, and Claude Remember (Pieces)](https://pieces.app/blog/types-of-ai-memory)
- [Best AI Agent Memory Frameworks 2026 (Atlan)](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/)
