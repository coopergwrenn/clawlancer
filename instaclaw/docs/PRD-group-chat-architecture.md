# PRD: Group Chat Agent Architecture

**Author:** Claude (Opus 4.6) + Cooper Wrenn
**Date:** 2026-03-19
**Status:** Draft
**Companion PRD:** [PRD-memory-architecture-overhaul.md](./PRD-memory-architecture-overhaul.md)

---

## Problem Statement

### The Incident

An InstaClaw agent in a 6-member Telegram group chat created a CSV file, then two messages later said "I don't have any record of creating that." The agent hallucinated an explanation: "I don't retain memory across group chat sessions by design."

This is a production failure that directly destroys user trust. If an agent forgets what it did 30 seconds ago, no amount of personality or capability matters.

### Root Causes Identified

1. **SOUL.md told the agent to skip MEMORY.md in groups** (now fixed). The instruction "If in MAIN SESSION (direct chat with your human): Also read MEMORY.md" meant group sessions never loaded long-term memory. This was the most egregious cause and has been patched.

2. **sessions.json bloat consuming context window tokens.** OpenClaw loads an index of ALL sessions (DMs, groups, cron-created) into every context. With hundreds of stale session entries, this metadata alone can consume thousands of tokens.

3. **Skills consuming up to 128,000 tokens of context.** With 20 SKILL.md files loaded, the 200K token context window has roughly 42K tokens remaining for actual conversation. Group chats with multiple participants burn through this faster than DMs.

4. **No group-specific context optimization.** Groups are treated identically to DMs in terms of context loading, history limits, and memory access. But groups have fundamentally different usage patterns: more participants, shorter exchanges, higher message volume, and lower per-message context value.

### User Impact

- Agents appear incompetent in the highest-visibility setting (group chats with multiple people watching)
- Users lose trust and stop using group features
- Agents that work perfectly in DMs appear broken in groups, creating confusion about platform reliability

### Why Groups Are Harder Than DMs

| Dimension | DM | Group (6 members) |
|-----------|----|--------------------|
| Messages per hour | 5-15 | 30-100 |
| Context value per message | High (all directed at agent) | Low (many messages between humans) |
| Session .jsonl growth rate | Moderate | 3-6x faster |
| Time to hit 200KB archive threshold | Days | Hours |
| Who the agent is "talking to" | One person | Ambiguous without mention detection |
| Memory relevance | Everything is relevant | Must filter by topic/participant |

---

## Industry Research

### Discord AI Bots (Midjourney, ChatGPT, Claude)

**Midjourney** operates entirely within Discord and uses a per-channel, command-driven model. Each `/imagine` command is stateless -- there is no persistent memory between commands. Midjourney avoids the context problem entirely by treating every interaction as independent. Users can organize work into separate channels and threads, but the bot maintains no cross-interaction state. This works for image generation (where each prompt is self-contained) but is not applicable to conversational agents.

**ChatGPT Discord bots** (community-built, including OpenAI's reference implementation on GitHub) typically implement one of three session scoping strategies:

1. **Per-channel**: One conversation context per Discord channel. All users in the channel share the same context. This is the most common approach for community bots.
2. **Per-user**: Each user gets their own isolated context regardless of channel. Better for privacy but loses group conversation flow.
3. **Per-thread**: Discord threads (sub-conversations within channels) each get isolated context. This maps naturally to topic-based conversations.

Advanced implementations use **Redis-backed memory** with configurable scoping (per-user, per-channel, or per-thread). The n8n Discord AI chatbot template, for example, uses key-value storage indexed by channel ID and author ID to retrieve message history.

A common pattern is **sliding window context**: keep the last N messages (typically 10-20) rather than the full history. Some bots use **embedding-based retrieval** where each message is embedded and stored, then semantically similar past messages are retrieved when generating a response.

**Key lesson:** Discord bots that work well in group channels treat ambient messages differently from direct mentions. Midjourney only responds to slash commands. Conversational bots typically require `@mention` to respond in channels but respond to every message in DMs.

Sources:
- [OpenAI GPT Discord Bot (GitHub)](https://github.com/openai/gpt-discord-bot)
- [n8n Discord AI Chatbot with Redis Memory](https://n8n.io/workflows/5816-discord-ai-chatbot-with-gpt-4o-mini-and-redis-memory-persistence/)
- [GPT-3 Discord Bot Long Term Memory (GitHub)](https://github.com/reality-comes/GPT-3-Discord-Bot-Long-Term-Memory)
- [Midjourney Discord Overview](https://docs.midjourney.com/docs/midjourney-discord)

### Slack AI

Slack AI takes a permission-respecting, scope-aware approach to context management:

**Thread and channel summaries** are the primary interaction model. Rather than maintaining a persistent conversational agent per channel, Slack AI provides on-demand summarization of threads, channels, and custom date ranges. This avoids the multi-user context problem by treating each summarization request as a fresh query against stored messages.

**Real-Time Search (RTS) API** (closed beta as of 2025) provides secure, permission-respecting retrieval for agents. It replaces ad-hoc "message fetching" with scoped, context-aware access. The API is purpose-built for deep research across threads, supporting search across public channels, private channels, and DMs -- but only with appropriate permissions.

**MCP Server integration** acts as a toolbox that agents can use to search channels and threads, read conversation history, and post updates to the right place. An admin approves the connection and scopes access to specific workspaces and channels.

**Key lesson:** Slack treats the message store as an external knowledge base that agents query on demand, rather than loading full conversation history into context. This is the opposite of OpenClaw's approach of loading session transcripts into the context window.

Sources:
- [Guide to AI Features in Slack](https://slack.com/help/articles/25076892548883-Guide-to-AI-features-in-Slack)
- [Slack Agent-Ready APIs](https://salesforcedevops.net/index.php/2025/10/01/slack-agent-ready-apis/)
- [A Deep Dive into Slack AI in 2025](https://www.eesel.ai/blog/slack-ai)
- [Slack AI has arrived](https://slack.com/blog/news/slack-ai-has-arrived)

### OpenAI GPTs in Shared/Group Contexts

OpenAI launched Group Chats in ChatGPT in November 2025, supporting 2-20 participants. Their approach to multi-user context makes a strong design statement:

**Personal memory is completely disabled in group chats.** ChatGPT does not access your personal memory, does not create new memories from group conversations, and your personal memory is never shared with other participants. This is a deliberate privacy-first design choice.

**Group-specific custom instructions** can be set per group chat, allowing the group to define how ChatGPT should behave in that specific context (tone, personality, focus areas).

**No cross-session memory for groups.** Each group chat session starts fresh. OpenAI is "exploring offering more granular controls in the future so you can choose if and how ChatGPT uses memory with group chats."

**Shared Projects** (separate from Group Chats) offer an alternative model: Project memory keeps ChatGPT focused by drawing context only from conversations within the same project. Shared projects do not have access to any individual member's personal context, custom instructions, or memories outside the project. This creates a "shared workspace memory" pattern.

**Key lesson:** OpenAI explicitly chose to disable personal memory in groups for privacy reasons. But they offer group-level custom instructions as a substitute. Their Shared Projects feature provides the "shared workspace memory" pattern that could be relevant for InstaClaw group use cases.

Sources:
- [Group Chats in ChatGPT (OpenAI Help Center)](https://help.openai.com/en/articles/12703475-group-chats-in-chatgpt)
- [Introducing Group Chats in ChatGPT (OpenAI Blog)](https://openai.com/index/group-chats-in-chatgpt/)
- [Projects in ChatGPT (OpenAI Help Center)](https://help.openai.com/en/articles/10169521-projects-in-chatgpt)
- [ChatGPT Group Chats Practical Guide (eesel.ai)](https://www.eesel.ai/blog/chatgpt-group-chat)

### Claude for Teams

Anthropic's Claude for Teams (launched 2025) takes an opt-in, user-controlled approach:

**Memory is opt-in and user-controlled.** Unlike ChatGPT which proactively stores conversations, Claude's memory is designed from the start as an opt-in tool. Users can view and manage what Claude remembers through a memory summary interface.

**Team Projects** serve as shared workspaces where all team members can access the same documents, code, and context. Everyone works from the same knowledge base within a project.

**200K context window** allows processing of long documents and complex conversations, but there is no explicit multi-user session management -- each user has their own conversation thread, and collaboration happens through shared Projects rather than shared real-time conversations.

**Key lesson:** Claude for Teams solves multi-user context through shared knowledge bases (Projects) rather than shared conversations. Memory is strictly user-controlled with explicit opt-in. This aligns with a "shared workspace, private conversations" model.

Sources:
- [Anthropic Adds Memory and Privacy Controls to Claude AI](https://www.reworked.co/digital-workplace/claude-ai-gains-persistent-memory-in-latest-anthropic-update/)
- [Claude for Teams (sectionai.com)](https://www.sectionai.com/blog/claude-for-teams)
- [Anthropic Adds Memory to Claude Team and Enterprise (VentureBeat)](https://venturebeat.com/ai/anthropic-adds-memory-to-claude-team-and-enterprise-incognito-for-all)
- [Anthropic Projects Announcement](https://www.anthropic.com/news/projects)

### Manus AI

Manus AI provides the most directly relevant architecture for our use case, as it deals with collaborative multi-user sessions with a shared agent:

**Collaborative Sessions (Manus 1.5)** allow team members to join shared sessions and work together with the AI agent in real time. Multiple users can interact with the same agent simultaneously.

**Context Engineering Principles** from Manus are highly applicable:

1. **100:1 input-to-output token ratio** -- context management is the primary cost and performance bottleneck, not generation.

2. **KV-Cache Optimization** -- Keep prompt prefixes stable. Cached input tokens cost 0.30 USD/MTok vs 3 USD/MTok uncached (10x difference). Even a single-token change invalidates the cache from that point forward. Append-only context maximizes cache hits.

3. **Tool Masking** -- Rather than removing tools from context (which changes the prefix and invalidates cache), mask tool selection at the logit level during decoding. This preserves the stable prefix.

4. **File System as External Memory** -- Manus treats the file system as unlimited, persistent, externalized memory. The model writes to and reads from files on demand, rather than keeping everything in the context window.

5. **Context Compaction of Stale Results** -- Older tool results are replaced with compact summaries. Recent tool calls keep full detail to maintain output quality.

6. **Multi-Agent Context Isolation** -- A planner assigns tasks, a knowledge manager reviews conversations and determines what to persist to filesystem, and executor sub-agents perform tasks.

**Key lesson:** Manus's approach -- especially filesystem-as-memory, KV-cache-aware prompt construction, and stale result compaction -- directly addresses InstaClaw's context window crisis. The principle of keeping prefixes stable for cache efficiency is particularly important for group chats where message volume is high.

Sources:
- [Context Engineering for AI Agents: Lessons from Building Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- [Introducing Manus 1.5](https://manus.im/blog/manus-1.5-release)
- [Context Engineering in Manus (rlancemartin.github.io)](https://rlancemartin.github.io/2025/10/15/manus/)
- [Context Engineering Strategies for Production AI Agents (ZenML)](https://www.zenml.io/llmops-database/context-engineering-strategies-for-production-ai-agents)

### OpenClaw Native Group Chat Architecture

OpenClaw provides first-class Telegram group chat support with these key mechanisms:

**Session Key Routing:**
- DMs: `agent:{agentId}:telegram:{chatId}`
- Groups: `agent:{agentId}:telegram:group:{groupId}`
- Forum topics: `agent:{agentId}:telegram:group:{groupId}:topic:{threadId}`

Each group gets its own isolated session. Each forum topic within a group gets a further-isolated session. This is the correct foundation.

**groupPolicy options:**
- `open` -- any group member can trigger the bot
- `allowlist` (default) -- only users in `groupAllowFrom` can trigger
- `disabled` -- groups blocked entirely

**requireMention:** When true (default for groups), the bot only responds when explicitly mentioned via `@botusername` or patterns configured in `mentionPatterns`. Can be overridden per-group or per-topic.

**Per-Topic Agent Routing:** Each forum topic can route to a different agent by setting `agentId` in the topic config. Each topic gets its own isolated workspace, memory, and session.

**History Limits:** Groups use `channels.telegram.historyLimit` (default 50 messages) separately from DM `dmHistoryLimit`.

**Known Issues:**
- [Issue #14511](https://github.com/openclaw/openclaw/issues/14511): Isolated sessions from cron jobs accumulate indefinitely, causing sessions.json bloat and severe performance degradation.
- [Issue #14064](https://github.com/openclaw/openclaw/issues/14064): Sessions exceeding context window produce silent empty replies with no compaction triggered.
- [Issue #31494](https://github.com/openclaw/openclaw/issues/31494): Telegram topics get split into two main-thread sessions, causing context divergence.
- [Issue #28307](https://github.com/openclaw/openclaw/issues/28307): Group messages silently dropped with `groupPolicy: allowlist` + `groupAllowFrom` but no explicit groups config.

**Key lesson:** OpenClaw has the session isolation primitives we need (per-group, per-topic sessions). The problems are in how sessions.json indexes ALL sessions into context, how stale sessions accumulate, and how our custom layer (strip-thinking.py, SOUL.md instructions) interacts with these primitives.

Sources:
- [OpenClaw Telegram Documentation](https://docs.openclaw.ai/channels/telegram)
- [OpenClaw Session Management](https://docs.openclaw.ai/concepts/session)
- [OpenClaw Compaction Documentation](https://docs.openclaw.ai/concepts/compaction)
- [Session Management Compaction Reference (GitHub)](https://github.com/openclaw/openclaw/blob/main/docs/reference/session-management-compaction.md)
- [sessions.json bloat issue #14511](https://github.com/openclaw/openclaw/issues/14511)
- [Silent empty replies issue #14064](https://github.com/openclaw/openclaw/issues/14064)

---

## Academic Foundations

### Collaborative Memory with Dynamic Access Control

Rezazadeh et al. (2025) present the first formulation of memory sharing that explicitly accounts for fine-grained access asymmetries in multi-agent, multi-user systems. Their framework, "Collaborative Memory," maintains two memory tiers:

1. **Private memory** -- fragments visible only to their originating user
2. **Shared memory** -- selectively shared fragments, each carrying immutable provenance attributes (contributing agents, accessed resources, timestamps)

Access controls are encoded as bipartite graphs linking users, agents, and resources. This is directly relevant to InstaClaw's group chat problem: the agent's MEMORY.md contains private user context that should NOT be surfaced in group chats, while group-specific context (project status, shared decisions) should be accessible to all group members.

Source: [Collaborative Memory: Multi-User Memory Sharing in LLM Agents with Dynamic Access Control (arXiv 2505.18279)](https://arxiv.org/abs/2505.18279)

### Memory-as-a-Service (MaaS)

A related 2025 paper proposes decoupling contextual memory from localized state, encapsulating it as an independently callable, dynamically composable, and finely governable service module. This aligns with the architectural pattern of moving memory OUT of the context window and into an external service that the agent queries on demand.

Source: [Memory as a Service (MaaS): Rethinking Contextual Memory as Service-Oriented Modules for Collaborative Agents (arXiv 2506.22815)](https://arxiv.org/html/2506.22815v1)

### Multi-Party Dialogue and Turn-Taking

Research on multi-party dialogue systems shows that turn-taking mechanics from human conversation are effective in controlling dialogue among AI agents. The key challenges include:

- **Next-speaker selection**: In multi-party settings, the agent must decide when to speak and when to stay silent. AutoGen-style frameworks implement automatic next-speaker selection where the LLM estimates the next speaker's role based on conversation history.
- **Information asymmetry**: Different participants have access to different knowledge and permissions.
- **Consistency and synchronization**: Multi-agent memory must be role-filtered, versioned, and explainable.

Source: [Multi-Agent Collaboration Mechanisms: A Survey of LLMs (arXiv 2501.06322)](https://arxiv.org/html/2501.06322v1)

### Long-Horizon Memory for Multi-Party Collaborative Dialogues

A 2026 paper evaluates long-horizon conversational memory specifically for multi-party settings. The key finding: naive approaches to loading full conversation history fail at scale. Effective systems must implement:

- **Selective retrieval**: Only load context relevant to the current query/participant
- **Tiered memory**: Short-term (current session), medium-term (recent sessions), long-term (curated facts)
- **Attribution tracking**: Who said what, when, and in what context

Source: [Evaluating Long-Horizon Memory for Multi-Party Collaborative Dialogues (arXiv 2602.01313)](https://arxiv.org/html/2602.01313)

### Context Engineering as a Discipline

JetBrains Research (2025) and the Manus team have independently converged on treating context as a first-class system with its own architecture, lifecycle, and constraints. The principle of "scope by default" -- every model call sees only the minimum context required -- is the central design guideline.

Source: [Cutting Through the Noise: Smarter Context Management for LLM-Powered Agents (JetBrains Research)](https://blog.jetbrains.com/research/2025/12/efficient-context-management/)

---

## Gold Standard: What Great Group Chat AI Looks Like

Synthesizing all research, the ideal group chat AI agent exhibits these behaviors:

### 1. Context-Aware Responsiveness
- **Responds when mentioned**, stays silent for ambient human-to-human conversation
- Can be configured per-group to respond to all messages (small groups) or mention-only (large groups)
- Recognizes implicit mentions ("hey bot", custom name references) not just `@username`

### 2. Scoped Memory
- **Group memory** is separate from DM memory -- the agent knows different things in different contexts
- **Personal user context** (wallet addresses, preferences) from DMs is NEVER leaked into group responses
- **Group-shared context** (project status, group decisions) is persisted and recalled across sessions
- The agent can be asked "what did we decide about X?" and answer from group memory

### 3. Efficient Context Usage
- Group conversation history is loaded with **lower priority** than DM history (most group messages are human-to-human)
- **Sliding window** of recent messages (last 10-20) rather than full history
- **Stale context compaction** -- older tool results summarized, recent ones kept in full
- **Skills loaded on demand** rather than all 20 SKILL.md files pre-loaded

### 4. Participant Awareness
- Knows who said what (attribution)
- Can address specific users by name
- Understands that different users in the group may have different relationships with the agent

### 5. Graceful Degradation
- When context is running low, the agent prioritizes: (1) current conversation thread, (2) group memory, (3) recent history, (4) older history
- Never hallucinates "I don't remember" -- instead reads from memory files
- If uncertain, says "Let me check my notes" and actually reads MEMORY.md

---

## Current InstaClaw Architecture Analysis

### How Sessions Work Today

Each conversation context gets its own session in OpenClaw:

```
~/.openclaw/agents/main/sessions/
  sessions.json                    # Index of ALL sessions (loaded into every context)
  abc123.jsonl                     # DM with user (Telegram)
  def456.jsonl                     # Group chat session (Telegram group -100xxx)
  ghi789.jsonl                     # Cron job session (auto-approve-pairing)
  jkl012.jsonl                     # Cron job session (heartbeat)
  mno345.jsonl                     # Cron job session (vm-watchdog)
  archive/                         # Sessions archived after exceeding 200KB
```

The session key format follows OpenClaw conventions:
- DMs: `agent:main:telegram:{userId}`
- Groups: `agent:main:telegram:group:{groupId}`
- Cron/system: `agent:main:cli:{context}`

**The critical problem**: `sessions.json` is an index of ALL sessions. OpenClaw loads this index into every context window. So when the agent is responding in a group chat, it also has metadata about every DM session, every cron session, and every other group session loaded into context. This is wasted context.

### The Context Window Crisis

Current token budget for a group chat response:

| Component | Estimated Tokens | Notes |
|-----------|-----------------|-------|
| System prompt + SOUL.md | ~4,000 | Core personality and rules |
| CAPABILITIES.md | ~8,000 | Read-only capability matrix |
| 20 SKILL.md files | ~128,000 | Loaded regardless of relevance |
| sessions.json index | ~2,000-10,000 | Grows with stale sessions |
| Current session transcript | ~10,000-40,000 | The actual conversation |
| MEMORY.md | ~2,000-5,000 | Long-term memory (now loaded in groups) |
| memory/YYYY-MM-DD.md | ~1,000-3,000 | Daily logs |
| Tool definitions | ~3,000-5,000 | MCP tool schemas |
| **Total** | **~158,000-203,000** | Often exceeds 200K limit |
| **Available for response** | **0-42,000** | Critical shortage |

In a group chat with 6 members generating rapid-fire messages, the session transcript grows 3-6x faster than a DM. The agent hits the 200KB archive threshold within hours rather than days. When `strip-thinking.py` archives the session, the agent loses ALL in-session context and starts fresh, leading to the "I don't have any record of creating that" failure.

### Why Groups Are Worse Than DMs

1. **Higher message volume, lower signal density**: In a 6-person group, perhaps 20% of messages are directed at the agent. The other 80% are human-to-human conversation that still gets stored in the session transcript and consumes tokens.

2. **Faster session rotation**: Sessions hit the 200KB threshold in hours, not days. Each rotation loses in-session context. If the agent hasn't written to MEMORY.md before rotation, work is lost.

3. **Ambient message confusion**: Without strict mention detection, the agent may try to respond to messages not directed at it, wasting tokens on irrelevant context processing.

4. **Multi-user attribution challenges**: The agent sees messages from multiple users but doesn't always correctly attribute who said what, leading to confusion about task ownership.

5. **Skill loading waste**: All 20 SKILL.md files are loaded even if the group chat is about a single topic (e.g., a Polymarket trading group doesn't need the video production skill documentation).

### What the SOUL.md Fix Solved vs What Remains

**Solved:**
- MEMORY.md is now read in group sessions (previously skipped due to "If in MAIN SESSION" instruction)
- The agent can now access long-term memory in groups
- memory/YYYY-MM-DD.md daily logs are also loaded

**Remains unsolved:**
- sessions.json bloat (all sessions indexed into every context)
- Skill documentation consuming 128K tokens regardless of context
- No group-specific context optimization (same history limits, same compaction thresholds)
- No distinction between ambient messages and directed mentions in context priority
- No group-specific memory file (all context goes into shared MEMORY.md)
- Session rotation still causes abrupt context loss
- No pre-rotation memory persistence enforcement specific to groups

---

## Architecture Options

### Option 1: Scoped Context Loading with Group Memory Files (Recommended)

**Description:** Modify the context loading strategy to be session-type-aware. Group sessions load a lighter context footprint. Introduce per-group memory files that persist group-specific context separately from the user's personal MEMORY.md.

**How context scoping works:**
- Group sessions load a reduced set of SKILL.md files (only skills referenced in group config or recently used)
- Group sessions load a group-specific memory file (`memory/group-{groupId}.md`) instead of the full MEMORY.md
- sessions.json loading is scoped: group sessions only see the current group's session entry, not all sessions
- `dmHistoryLimit` and group `historyLimit` are configured independently (groups default to 20, DMs to 50)

**How mentions vs ambient messages are handled:**
- `requireMention: true` is the default for all groups
- When the agent is not mentioned, the message is stored in the session transcript but marked as "ambient" (lower priority for context retrieval)
- Custom mention patterns configured per-group in `mentionPatterns` array
- Agent responds to: `@botusername`, configured name patterns, direct replies to agent messages

**How memory is shared vs isolated:**
- Personal MEMORY.md is NOT loaded in group contexts (privacy protection, matching OpenAI's approach)
- Group memory file (`memory/group-{groupId}.md`) is shared context for that group
- Agent can be instructed to "remember this for the group" vs "remember this for me"
- Critical user-specific info (wallet addresses) is only available in DMs

**Files to change:**
- `/Users/cooperwrenn/wild-west-bots/instaclaw/lib/ssh.ts` -- Modify SOUL.md template to add group-specific instructions, modify `strip-thinking.py` to handle group memory files, add group memory file creation to `configureOpenClaw()`
- OpenClaw `openclaw.json` config -- Set per-group `historyLimit`, enable `requireMention`, configure `mentionPatterns`
- New file: `memory/group-{groupId}.md` template written during group onboarding

**Effort estimate:** 3-5 days for Phase 1 changes (SOUL.md + config), 5-8 days for Phase 2 (strip-thinking.py modifications, group memory files)

**Tradeoffs:**
- (+) Immediately reduces context pressure in groups
- (+) Privacy-preserving (personal memory not leaked to groups)
- (+) Works within existing OpenClaw primitives
- (-) Requires SOUL.md instruction changes (agent must understand when to use which memory file)
- (-) Group memory files need their own lifecycle management
- (-) Does not solve the fundamental sessions.json bloat problem for DMs

### Option 2: Aggressive Session Pruning with Context Compaction

**Description:** Instead of changing what gets loaded, aggressively prune what is stored. Implement Manus-style context compaction where older tool results and ambient messages are summarized in-place, keeping the session transcript lean enough that the full context window is never exhausted.

**How context scoping works:**
- Every 50 messages in a group session, run an automatic compaction pass
- Ambient messages (not directed at agent) are summarized into a single "group activity summary" entry
- Tool results older than 5 turns are replaced with compact summaries
- Session transcript stays under 50KB instead of growing to 200KB

**How mentions vs ambient messages are handled:**
- Same mention detection as Option 1
- Ambient messages are stored temporarily but compacted aggressively (summarized every 50 messages)
- Mentioned messages and agent responses are kept in full detail

**How memory is shared vs isolated:**
- Uses the existing MEMORY.md for all contexts (no separation)
- Relies on the agent's judgment about what to write to memory

**Files to change:**
- `/Users/cooperwrenn/wild-west-bots/instaclaw/lib/ssh.ts` -- Major rewrite of `strip-thinking.py` to add compaction logic, add ambient message detection, add group-specific compaction thresholds
- OpenClaw config -- Lower group `historyLimit` to 20, configure compaction settings if available natively

**Effort estimate:** 8-12 days (complex Python changes to strip-thinking.py, extensive testing required)

**Tradeoffs:**
- (+) Solves the token budget problem at the source (smaller sessions)
- (+) No new memory file types to manage
- (-) Compaction risks losing important context (summaries are lossy)
- (-) Ambient message detection in Python is fragile (regex on Telegram message format)
- (-) Higher complexity in strip-thinking.py which already has 6 responsibilities
- (-) Does not address privacy (personal MEMORY.md still loaded in groups)

### Option 3: External Memory Service with On-Demand Retrieval

**Description:** Move long-term memory out of the context window entirely. Implement a lightweight retrieval system (similar to Slack AI's approach and the "Memory-as-a-Service" pattern from academic research) where the agent queries memory on demand rather than having it pre-loaded.

**How context scoping works:**
- MEMORY.md, daily logs, and group memory are NOT loaded into context by default
- Instead, the agent has a `recall` tool that queries an external memory index
- The memory index uses OpenClaw's native SQLite FTS5 + vec0 for semantic search
- Only relevant memory fragments are loaded into context when the agent needs them

**How mentions vs ambient messages are handled:**
- Same as Option 1

**How memory is shared vs isolated:**
- Memory fragments are tagged with scope: `personal`, `group:{groupId}`, or `global`
- The `recall` tool filters by scope based on current session context
- Group sessions can only recall group-scoped and global-scoped memories

**Files to change:**
- `/Users/cooperwrenn/wild-west-bots/instaclaw/lib/ssh.ts` -- New MCP tool definition for `recall`, modify SOUL.md to instruct agent on memory tool usage, modify context loading to exclude memory files by default
- New script: Memory indexer that processes MEMORY.md and daily logs into the SQLite index
- OpenClaw config -- Register new MCP tool

**Effort estimate:** 12-18 days (new tool, indexer, testing, migration of existing memory)

**Tradeoffs:**
- (+) Most scalable long-term solution
- (+) Memory access is always relevant (semantic retrieval vs loading everything)
- (+) Works for both groups and DMs
- (+) Aligns with academic best practices and industry direction (Slack, Manus)
- (-) Highest implementation complexity
- (-) Agent must learn to use the recall tool (behavior change)
- (-) Adds latency for memory retrieval (extra tool call per memory access)
- (-) Depends on OpenClaw's SQLite memory system working correctly (needs verification)
- (-) Risk of agent not querying memory when it should

---

## Recommended Approach

### Phase 1 -- Quick Wins (Days 1-5)

These changes can be deployed immediately with low risk:

**1.1 Enable `requireMention: true` for all group chats**

Current config sets `groupPolicy: "allowlist"` but does not set `requireMention`. Add to `configureOpenClaw()` in ssh.ts:

```typescript
(ocConfig.channels as Record<string, unknown>).telegram = {
  botToken: config.telegramBotToken,
  allowFrom: ["*"],
  dmPolicy: "open",
  groupPolicy: "allowlist",
  streamMode: "partial",
  groups: {
    "*": {
      requireMention: true,
    }
  }
};
```

This prevents the agent from processing ambient messages in groups, immediately reducing context consumption and irrelevant responses.

**1.2 Lower group history limit**

Add to the groups wildcard config:

```json5
{
  groups: {
    "*": {
      requireMention: true,
      historyLimit: 20  // vs default 50
    }
  }
}
```

Groups keep 20 messages of history instead of 50, reducing token usage for the session transcript portion.

**1.3 Add group-specific instructions to SOUL.md**

Add a section to SOUL.md:

```markdown
## Group Chat Behavior

When you're in a group chat (not a DM):
- Only respond when mentioned or directly addressed
- Keep responses concise — others are watching
- Do NOT reference personal information from DMs
- Write group-relevant decisions and context to memory/group-notes.md
- Read memory/group-notes.md at the start of each group session
- If you're unsure whether a message is directed at you, stay silent
```

**1.4 Deploy mention patterns for agent names**

Many users refer to their agents by name (not `@username`). Add mention patterns:

```json5
{
  agents: {
    defaults: {
      groupChat: {
        mentionPatterns: []  // Populated per-agent from IDENTITY.md name field
      }
    }
  }
}
```

This requires reading the agent's configured name from identity data and adding it to mention patterns during `configureOpenClaw()`.

### Phase 2 -- Structural Fixes (Days 6-15)

**2.1 Group-specific memory file**

Create `memory/group-notes.md` as a lightweight, group-scoped memory file. Modify strip-thinking.py to:
- Inject a reminder to write to `memory/group-notes.md` when group sessions approach the archive threshold
- NOT inject the full MEMORY.md urgent write reminder in group contexts

**2.2 Conditional skill loading**

This is the highest-impact structural change. Currently, all 20 SKILL.md files are loaded into every context (~128K tokens). For groups:
- Load only skills referenced in the group's `skills` config
- If no skills are configured for the group, load only the top 3 most recently used skills
- This alone could free 80-100K tokens in group contexts

Implementation requires modifying how `configureOpenClaw()` sets per-group skill lists and potentially using OpenClaw's native per-topic `skills` configuration.

**2.3 sessions.json scoping**

Investigate OpenClaw's session store maintenance options:
- Enable `pruneStaleEntries()` if available natively
- Configure the Cron Session Reaper to auto-prune completed cron run sessions after 1 hour (instead of 24h default)
- Modify strip-thinking.py's `daily_hygiene()` to run sessions.json pruning more frequently (every 6 hours instead of every 23 hours)

### Phase 3 -- Full Vision (Days 16-30)

**3.1 Implement ambient message summarization**

For groups where `requireMention` is false (small, intimate groups), implement periodic summarization of ambient messages. Every N ambient messages, generate a one-line summary and replace the original messages in the session transcript.

**3.2 Group memory lifecycle**

- Auto-create `memory/group-{groupId}.md` when an agent first joins a group
- Add to strip-thinking.py: group memory file size management
- Add to SOUL.md: instructions for maintaining group memory (project status, decisions, action items)

**3.3 Evaluate external memory retrieval (Option 3)**

If Phase 1-2 deliver sufficient improvement, Option 3 becomes a future optimization. If context pressure remains critical after Phase 2, implement the `recall` tool approach as Phase 3.

**3.4 Cross-session context hints**

When the agent is mentioned in a group after a session rotation, automatically prepend a "context restoration" block:

```
[System: This is a group chat. Your previous session was archived.
Key context from previous session:
- You created a CSV file for user X
- Project Y status: in progress
- Last discussed topic: Z
Check memory/group-notes.md for full context.]
```

This requires strip-thinking.py to extract a summary before archiving.

---

## Context Scoping Design

### Per-Group Session (Current)

OpenClaw already creates one session per group (`agent:main:telegram:group:{groupId}`). This is correct and should not change.

### Memory Scoping Model

```
MEMORY.md (personal, DM-only)
  |
  +-- User preferences, wallet addresses, personal projects
  |
  +-- NEVER loaded in group contexts

memory/group-notes.md (group-shared)
  |
  +-- Group decisions, shared project status, action items
  |
  +-- Loaded ONLY in group sessions
  |
  +-- Agent writes here during group conversations

memory/YYYY-MM-DD.md (daily log, all contexts)
  |
  +-- Read in both DM and group sessions
  |
  +-- Agent writes session summaries here regardless of context type
```

### Context Loading by Session Type

```
DM Session:
  [System Prompt] + [SOUL.md] + [CAPABILITIES.md] + [All SKILL.md files]
  + [MEMORY.md] + [memory/today.md] + [memory/yesterday.md]
  + [sessions.json (current session only)] + [session transcript]

Group Session:
  [System Prompt] + [SOUL.md] + [CAPABILITIES.md] + [Relevant SKILL.md files only]
  + [memory/group-notes.md] + [memory/today.md]
  + [sessions.json (current session only)] + [session transcript (last 20 messages)]
```

Estimated token savings for group sessions:

| Component | Current | Proposed | Savings |
|-----------|---------|----------|---------|
| SKILL.md files | ~128,000 | ~20,000 (3 skills) | ~108,000 |
| MEMORY.md | ~3,000 | 0 (not loaded) | ~3,000 |
| sessions.json | ~5,000 | ~500 (scoped) | ~4,500 |
| History limit | 50 msgs (~15,000) | 20 msgs (~6,000) | ~9,000 |
| **Total savings** | | | **~124,500 tokens** |

This transforms the context budget from critically oversubscribed to having significant headroom.

---

## Mention Handling Design

### When to Respond

The agent should respond to a group message when ANY of these are true:

1. **Direct @mention**: Message contains `@botusername`
2. **Name mention**: Message contains the agent's configured name (from IDENTITY.md)
3. **Direct reply**: Message is a Telegram reply to one of the agent's messages
4. **Explicit command**: Message starts with `/` (slash commands)
5. **Custom patterns**: Message matches patterns in `mentionPatterns` config

The agent should stay SILENT when:

1. Message is human-to-human conversation with no mention
2. Message is a reaction/emoji response
3. Message is a media file with no text directed at the agent

### Mention Detection Implementation

OpenClaw handles mention detection natively when `requireMention: true` is set. The `mentionPatterns` configuration allows custom patterns. For InstaClaw:

```json5
{
  agents: {
    defaults: {
      groupChat: {
        mentionPatterns: [
          // Dynamically populated from IDENTITY.md during configureOpenClaw()
          // e.g., "dusty", "hey dusty", "dusty pete"
        ]
      }
    }
  }
}
```

### Edge Cases

- **Agent mentioned in a forwarded message**: Should NOT trigger a response (the mention is in forwarded context, not directed)
- **Multiple agents in a group**: Each agent should only respond to its own mentions (OpenClaw handles this via session routing)
- **Mention in image caption**: Should trigger response if text matches patterns

---

## Group Chat File Sharing

### Current Problem

When an agent creates a file (e.g., CSV, image) in a group chat, the file is saved to the VM filesystem but the delivery mechanism is the same as DMs. In groups:

1. The file path is mentioned in the response
2. If the Telegram bot has file-sending capability, it sends the file to the group
3. Other group members may not have context about why the file was created

### Proposed Design

**File delivery in groups should:**

1. Always include a brief description of what the file contains and who requested it
2. Use Telegram's reply-to feature to attach the file as a reply to the requesting message
3. Keep file references in `memory/group-notes.md` so the agent can recall them later

**Example interaction:**
```
User: @agent create a CSV of our trading positions
Agent: [replies to user's message] Here's the CSV of current trading positions.
       [attaches positions.csv]
       Saved to memory: created positions CSV for @user on 2026-03-19
```

---

## Interaction with Memory Architecture PRD

This PRD is a companion to [PRD-memory-architecture-overhaul.md](./PRD-memory-architecture-overhaul.md). The relationship:

### Shared Concerns

Both PRDs address the same root problem: agents running out of context window space. The Memory Architecture PRD focuses on the general case (all session types), while this PRD focuses specifically on group chat optimizations.

### Dependencies

| This PRD Phase | Depends On | From Memory PRD |
|----------------|------------|-----------------|
| Phase 1.2 (history limits) | Phase 0 verification | Confirm OpenClaw supports per-group historyLimit |
| Phase 2.2 (conditional skill loading) | Phase 1 skill trimming | Skill files should be trimmed first before conditional loading |
| Phase 2.3 (sessions.json scoping) | Phase 0 verification | Confirm which OpenClaw native session maintenance features exist |
| Phase 3.3 (external memory) | Phase 2 or 3 | Builds on the same SQLite memory infrastructure |

### Non-Conflicting Changes

These changes from this PRD can proceed independently:
- Phase 1.1 (`requireMention` configuration)
- Phase 1.3 (SOUL.md group instructions)
- Phase 1.4 (mention patterns)
- Phase 2.1 (group memory files)
- Phase 3.4 (cross-session context hints)

### Implementation Order

1. Memory Architecture PRD Phase 0 (verify OpenClaw features) -- FIRST
2. This PRD Phase 1 (quick wins) -- can start during Memory PRD Phase 0
3. Memory Architecture PRD Phase 1 (skill trimming, session handoff) -- before this PRD Phase 2
4. This PRD Phase 2 (conditional skill loading, group memory) -- after skill trimming
5. Both PRD Phase 3 work -- can proceed in parallel

---

## Open Questions

1. **Should group memory be visible to the user in the dashboard?** Currently, MEMORY.md is not exposed in the InstaClaw web UI. If we add group-specific memory files, should users be able to view/edit what their agent remembers about group conversations?

2. **How should `requireMention` interact with small groups?** In a 2-person "group" (user + agent), requiring mentions feels awkward. Should we auto-detect group size and adjust? Threshold at 3 members?

3. **Per-topic skill routing -- is it worth the complexity?** OpenClaw supports per-topic skill configuration. We could have a "trading" topic that only loads finance skills and a "creative" topic that only loads video skills. But this requires users to understand forum topics, which most Telegram users don't.

4. **What happens to existing sessions when we change history limits?** Lowering `historyLimit` from 50 to 20 for groups -- does OpenClaw retroactively truncate, or does it only apply to new messages? Need to verify.

5. **Should agents be able to cross-reference group and DM memory?** If a user asks in DMs "what did we decide in the group about X?", should the agent be able to read `memory/group-notes.md`? This breaks the privacy isolation but might be expected behavior since it's the same user asking their own agent.

6. **How do we handle group membership changes?** When a new member joins a group with existing context, should the agent acknowledge them? Should group memory include a "members" section?

7. **What's the right compaction threshold for groups?** The current 200KB archive threshold was tuned for DMs. Groups may need a lower threshold (100KB) with more aggressive compaction, or a higher threshold with better compaction (summarize ambient messages in place).

8. **OpenClaw native compaction for groups -- does it exist?** The documentation references `agents.defaults.compaction` settings. We need to verify whether this can be configured differently for group sessions vs DM sessions.

9. **KV-cache implications of our changes.** Per Manus's research, changing the prompt prefix invalidates the KV-cache. If we load different skills per group, we lose cache benefits across groups. Is the token savings worth the cache miss cost?

10. **How should the agent handle being added to a NEW group?** First-message experience in groups: should the agent introduce itself? Should it read existing group messages for context? Should it ask what the group wants it to do?
