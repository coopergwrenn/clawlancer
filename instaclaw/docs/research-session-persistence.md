# Session Persistence Research: How the Best AI Agent Platforms Handle Long-Running Conversations

**Date:** 2026-03-23
**Purpose:** Determine optimal session configuration for InstaClaw's always-on agents (the #1 user complaint is agents "forgetting" mid-conversation)
**Root Cause:** OpenClaw's default `session.reset.mode: "daily"` silently wipes conversation history at 4:00 AM UTC every day

---

## 1. Platform Comparison Table

| Dimension | Manus AI | Claude Code | Devin | OpenClaw | Replit Agent | Google Gemini | OpenAI Codex | Cursor |
|---|---|---|---|---|---|---|---|---|
| **Session model** | Per-task sandbox (E2B microVM) | Local disk, indefinite | Persistent cloud VM | Gateway process, reset-based | Long-lived (3+ hrs), checkpointed | Daemon (no sessions) or 2hr resumption | Per-task sandbox, 12hr cache | Per-chat, no persistence |
| **Context window** | ~128K (Claude Sonnet) | 200K (Opus/Sonnet) | 200K effective (1M beta to avoid anxiety) | 200K (Sonnet default) | Model-dependent | 1-2M tokens | Model-dependent | Model-dependent |
| **Auto-compaction** | Two-tier: compaction (reversible) then summarization (lossy) | Triggers at ~95% capacity | Proprietary; model self-summarizes | Triggers on overflow or threshold | N/A (checkpoint-based) | Sliding window compression | Encrypted opaque compaction payload | RL-trained self-summarization (100K→1K tokens) |
| **Cross-session memory** | Filesystem only (no cross-task memory) | CLAUDE.md (manual) + auto-memory (automatic) | Knowledge Base + Playbooks + Snapshots | MEMORY.md + memory/YYYY-MM-DD.md + memory_search | replit.md + checkpoint history | SQLite database (permanent) | Threads (Assistants), encrypted compaction (Codex), saved memories (ChatGPT) | .cursor/rules/ + codebase index |
| **Daily reset** | N/A (task-scoped) | N/A (user-initiated) | N/A (sessions sleep/wake) | **Yes, 4 AM daily (default)** | N/A (checkpoint-based) | N/A (daemon) | N/A (thread-based) | N/A (per-chat) |
| **Heartbeat/background** | Scheduled tasks (cron-style) | Headless mode + Task tool subagents | Sessions sleep/wake; managed child sessions | Heartbeat every 30m (same session by default) | Parallel sub-agents (Agent 4) | 24/7 daemon with 30-min consolidation | Background cloud tasks, parallel sandboxes | None (IDE-bound) |
| **Task survival** | todo.md on filesystem | CLAUDE.md + session-memory summaries | Checkpoint/restore (files AND memory) | Depends on reset config — daily reset kills tasks | Checkpoint snapshots (code + DB + conversation) | Persistent in SQLite | Container cache (12hr), thread persistence | Does not survive |
| **Key innovation** | Recoverable compression (drop content, keep URLs/paths) | Dual memory (human-written + AI-written) | Timeline scrubbing + checkpoint restore | Pre-compaction memory flush | Decision-time guidance (inject rules at trace bottom) | No vector DB — LLM reads structured SQLite directly | Encrypted opaque compaction preserving model latent state | RL-trained self-summarization as part of training trajectory |

### Key Takeaway

**No production platform uses daily session resets for always-on agents.** Every platform either:
- Has no reset at all (Claude Code, Devin, Cursor)
- Uses task-scoped sessions that persist until completion (Manus, OpenAI Codex)
- Uses explicit user-triggered resets only (Claude Code `/clear`, Replit checkpoints)
- Uses idle-based timeout with very long windows (OpenClaw's recommended "evergreen" pattern)

OpenClaw's daily reset at 4 AM is a sensible default for chatbots that start fresh each day, but it is **fundamentally wrong for 24/7 persistent agents** that maintain ongoing tasks, relationships, and context.

---

## 2. OpenClaw Session Configuration — Complete Reference

### 2.1 Session Reset (`session.reset.*`)

| Config Key | Type | Default | Description |
|---|---|---|---|
| `session.reset.mode` | `"daily"` \| `"idle"` | `"daily"` | Reset strategy. **No "persist"/"continuous"/"evergreen" mode exists.** |
| `session.reset.atHour` | int (0-23) | `4` | Hour for daily reset (gateway host local time) |
| `session.reset.idleMinutes` | int | none (optional) | Sliding idle window. When set with `mode: "daily"`, whichever expires first wins. |
| `session.resetByType.{direct,group,thread}` | object | inherits global | Per-session-type override |
| `session.resetByChannel.{name}` | object | inherits global | Per-channel override (highest precedence) |
| `session.resetTriggers` | string[] | `["/new", "/reset"]` | Commands that trigger explicit reset |
| `session.dmScope` | string | `"main"` | `main`, `per-peer`, `per-channel-peer`, `per-account-channel-peer` |
| `session.mainKey` | string | `"main"` | Primary session identifier |

**How daily reset works:**
1. At `atHour` (e.g., 4 AM), the reset boundary is set
2. Sessions whose last update is before the boundary are marked stale
3. On the NEXT message after the boundary, a new `sessionId` is created
4. The old session is **deleted, not compacted** — all context is lost
5. Only MEMORY.md and memory/*.md files survive (loaded at session start)

**How idle reset works:**
1. Each session tracks its last activity timestamp
2. If `now - lastActivity > idleMinutes`, the session is stale
3. On the next message, a new sessionId is created
4. Same deletion behavior as daily reset

### 2.2 Session Maintenance (`session.maintenance.*`)

| Config Key | Type | Default | Description |
|---|---|---|---|
| `session.maintenance.mode` | `"warn"` \| `"enforce"` | `"warn"` | Whether to actively prune old sessions |
| `session.maintenance.pruneAfter` | duration | `"30d"` | Retention window for old sessions |
| `session.maintenance.maxEntries` | int | `500` | Maximum session count |
| `session.maintenance.rotateBytes` | size | `"10mb"` | Session store file rotation threshold |
| `session.maintenance.resetArchiveRetention` | duration | same as pruneAfter | How long .reset.* archives are kept |
| `session.maintenance.maxDiskBytes` | size | unset | Hard disk budget (optional) |
| `session.maintenance.highWaterBytes` | size | 80% of maxDiskBytes | Cleanup target threshold |

### 2.3 Compaction (`agents.defaults.compaction.*`)

| Config Key | Type | Default | Description |
|---|---|---|---|
| `agents.defaults.compaction.enabled` | bool | `true` | Toggle auto-compaction |
| `agents.defaults.compaction.reserveTokens` | int | `16384` | Headroom reserved for prompts/output |
| `agents.defaults.compaction.keepRecentTokens` | int | `20000` | Recent context preserved during compaction |
| `agents.defaults.compaction.reserveTokensFloor` | int | `20000` | Minimum reserve enforced by OpenClaw |
| `agents.defaults.compaction.memoryFlush.enabled` | bool | `true` | Pre-compaction memory flush |
| `agents.defaults.compaction.memoryFlush.softThresholdTokens` | int | `4000` | Flush trigger offset (recommend 8000+) |
| `agents.defaults.compaction.memoryFlush.prompt` | string | (built-in) | User message for flush turn |
| `agents.defaults.compaction.memoryFlush.systemPrompt` | string | (built-in) | Extra system prompt for flush |

### 2.4 Heartbeat (`agents.defaults.heartbeat.*`)

| Config Key | Type | Default | Description |
|---|---|---|---|
| `agents.defaults.heartbeat.every` | duration | `"30m"` | Heartbeat interval |
| `agents.defaults.heartbeat.isolatedSession` | bool | `false` | **CRITICAL: Run heartbeats in separate session** |
| `agents.defaults.heartbeat.lightContext` | bool | `false` | Limit bootstrap to HEARTBEAT.md only |

### 2.5 Session Pruning (Tool Result Trimming)

| Config Key | Type | Default | Description |
|---|---|---|---|
| Pruning mode | `"off"` \| `"cache-ttl"` | `"off"` | Only trims after Anthropic cache TTL expires |
| `ttl` | duration | `"5m"` | Cache TTL before pruning eligible |
| `softTrimRatio` | float | `0.3` | Soft trim ratio for tool results |
| `hardClearRatio` | float | `0.5` | Hard clear ratio |
| `keepLastAssistants` | int | `3` | Protect recent tool results |
| `minPrunableToolChars` | int | `50000` | Minimum chars before pruning activates |

**Note:** Pruning only trims `toolResult` messages. User and assistant messages are NEVER modified. Image blocks in tool results are SKIPPED.

---

## 3. Best Practices Synthesis: What Should a 24/7 Persistent Agent's Session Config Look Like?

### 3.1 The Universal Pattern: File-Based State + Managed Context

Every successful platform converges on the same architecture:

1. **Durable state lives on disk, not in context** — MEMORY.md, todo.md, SOUL.md
2. **Context window is treated as working memory (RAM)** — volatile, managed, compacted
3. **Session resets are avoided or minimized** — idle-based with long windows, not daily
4. **Heartbeats/background tasks are isolated** — separate session, minimal context
5. **Compaction preserves decisions, not conversations** — what was decided matters more than what was said

### 3.2 Lessons from Each Platform

**From Manus AI:**
- **Recoverable compression** — drop content but keep file paths/URLs for re-retrieval
- **todo.md recitation** — rewrite the plan at end of context to keep it in model's attention
- **KV-cache optimization** — append-only context, fixed tool definitions
- File system IS the memory; context window is just the working set

**From Claude Code:**
- **Dual memory system** — human-written (CLAUDE.md) + AI-written (auto-memory)
- Auto-compaction at ~95% capacity with instant summarization
- Session memory summaries injected as background knowledge in new sessions
- `/compact` with custom instructions to control what's preserved

**From Devin:**
- **Sessions sleep, never terminate** — can wake and resume at any point
- **Checkpoint/restore** — full timeline scrubbing with state rollback
- **Context anxiety** — models take shortcuts when they believe context is running low
- Break large tasks into smaller isolated sessions for best results

**From Replit:**
- **Decision-time guidance** — inject short instructions at the bottom of the trace (recency bias), not in the system prompt
- **Checkpoints** capture entire state (code + DB + AI conversation)
- 15% more parallel tool calls when guidance is at trace bottom vs system prompt

**From Google (Always-On Memory Agent):**
- **30-minute consolidation cycle** — background processing of memories (like sleep/replay)
- **No vector database needed** — structured SQLite + LLM reasoning
- **Three specialist sub-agents** — Ingest, Consolidate, Query

**From OpenAI Codex:**
- **Encrypted opaque compaction** — carries model's latent understanding forward without human-readable summary
- **Container cache** — 12hr persistence for fast task resumption
- **Stateless requests** — compacted state travels with the request, no server-side session

**From Cursor:**
- **RL-trained self-summarization** — 100K→1K tokens, 50% less error than prompted summarization
- **Sessions degrade after ~2 hours** — model-reality desynchronization
- **Semantic codebase indexing** — the code IS the memory

### 3.3 Academic/Industry Consensus

1. **Tiered memory** (Working → Episodic → Semantic) is the gold standard architecture
2. **Observation masking** (removing tool outputs, keeping reasoning) matches or beats full LLM summarization (JetBrains Research, Dec 2025)
3. **Memory consolidation** should run on a schedule, not inline (Google's 30-min cycle)
4. **The simplest approaches consistently match or outperform complex infrastructure** for single-agent persistence
5. **Hard token cap of ~20,000 tokens for memory stores** recommended (IBM)
6. **Markdown files + todo lists + observation masking > vector DBs + graph DBs** for always-on agents

---

## 4. Recommended InstaClaw Configuration

### 4.1 The "Evergreen Session" Config

```json
{
  "session": {
    "reset": {
      "mode": "idle",
      "idleMinutes": 10080
    },
    "maintenance": {
      "mode": "enforce",
      "pruneAfter": "30d",
      "maxEntries": 100,
      "rotateBytes": "10mb"
    }
  },
  "agents": {
    "defaults": {
      "heartbeat": {
        "isolatedSession": true,
        "lightContext": true
      },
      "compaction": {
        "enabled": true,
        "reserveTokensFloor": 20000,
        "keepRecentTokens": 20000,
        "memoryFlush": {
          "enabled": true,
          "softThresholdTokens": 8000
        }
      }
    }
  }
}
```

### 4.2 Why These Values

| Setting | Value | Rationale |
|---|---|---|
| `session.reset.mode` | `"idle"` | Eliminates the 4 AM daily wipe that causes the #1 user complaint |
| `session.reset.idleMinutes` | `10080` (7 days) | Session only resets after 7 days of zero activity. Active agents never hit this. If an agent is truly abandoned for a week, a fresh start is reasonable. |
| `heartbeat.isolatedSession` | `true` | **Critical.** Without this, every 30-min heartbeat sends the full ~100-200K token conversation to the model. Isolation reduces heartbeat cost to ~2-5K tokens. |
| `heartbeat.lightContext` | `true` | Further reduces heartbeat token consumption by loading only HEARTBEAT.md |
| `compaction.memoryFlush.softThresholdTokens` | `8000` | Default 4000 is insufficient for comprehensive multi-file flushing (OpenClaw Issue #31435). 8000 gives the agent enough room to write lasting notes before compaction. |
| `session.maintenance.mode` | `"enforce"` | Actively prunes old sessions to prevent disk bloat (vs `"warn"` which only reports) |
| `session.maintenance.maxEntries` | `100` | Our agents don't need 500 sessions. 100 is plenty for history. |

### 4.3 What This Changes for Users

**Before (current defaults):**
- Agent loses all conversation context every day at 4 AM
- User wakes up, sends a message, agent has no idea what they were talking about
- Only MEMORY.md and daily memory files survive the reset
- Heartbeats pollute the main conversation session

**After (evergreen config):**
- Agent maintains conversation continuity for up to 7 days of inactivity
- Compaction handles context window pressure gracefully (summarize, don't delete)
- Memory flush writes durable notes before compaction (agent remembers key facts even after compaction)
- Heartbeats run in isolation — zero impact on conversation context
- User can still explicitly reset with `/new` or `/reset` if they want a fresh start

---

## 5. Risks, Gotchas, and Mitigations

### 5.1 Risk: Session File Growth

**Problem:** Without daily resets, session files will grow larger over time.
**Mitigation:** `session.maintenance.mode: "enforce"` with `rotateBytes: "10mb"` handles this. Also, compaction naturally limits active session size to the context window.

### 5.2 Risk: Compaction Quality

**Problem:** When compaction fires, the summary is lossy. The agent may lose nuanced preferences taught over many turns.
**Mitigation:** Memory flush (enabled, 8000 token threshold) gives the agent a chance to write durable notes before compaction. MEMORY.md and daily memory files persist across compaction. The agent should be instructed to write important decisions to memory proactively.

### 5.3 Risk: Context Coherence Degradation

**Problem:** Devin found that models exhibit "context anxiety" — taking shortcuts when they believe context is running low. Long sessions may degrade quality.
**Mitigation:** OpenClaw's compaction mechanism resets the effective context usage. After compaction, the model starts with a fresh ~20K token summary + memory files, well within comfortable range. The `keepRecentTokens: 20000` ensures recent conversation is preserved verbatim.

### 5.4 Risk: Heartbeat Isolation Breaking Existing Behavior

**Problem:** Some agents may rely on heartbeat context being in the main session (e.g., heartbeats that reference recent conversation).
**Mitigation:** With `lightContext: true`, heartbeats still load HEARTBEAT.md which contains the agent's scheduled tasks. If an agent needs to reference conversation context in heartbeats, set `lightContext: false` (heartbeat still isolated, but loads full bootstrap files).

### 5.5 Risk: Extended Thinking + Compaction Bug

**Problem:** OpenClaw Issue #19524 — sessions using `thinking: low/high` that trigger compaction fail to reconstruct message history correctly.
**Mitigation:** Monitor for this. If it affects our agents, we may need to disable extended thinking or implement a workaround. The memory flush before compaction provides a safety net.

### 5.6 Risk: resetByType/resetByChannel Overrides

**Problem:** OpenClaw Issue #31322 — if `resetByType` is partially configured, unconfigured types may fall back to daily reset silently.
**Mitigation:** Our config sets the global `session.reset` without `resetByType` or `resetByChannel` overrides. All session types inherit the global idle mode. If we add per-type overrides later, we must configure ALL types explicitly.

### 5.7 Risk: Config Schema Validation

**Problem:** Per CLAUDE.md Rule #2, we must verify config keys against the actual schema validator before deploying.
**Mitigation:** Before fleet deployment:
1. SSH to one test VM
2. Write the config
3. Run `openclaw doctor` or restart gateway
4. Verify gateway reaches "active" state and health returns 200
5. Only then proceed to fleet deployment

### 5.8 Risk: No Session Handoff on Reset

**Problem:** When a session eventually does reset (7 days idle), context is deleted, not summarized.
**Mitigation:** Memory flush fires before compaction but NOT before session reset. This is a known gap (OpenClaw Issue #40418, PR #50584 pending). For now, our agents write to memory proactively via SOUL.md instructions. The 7-day idle window means this only affects truly abandoned agents.

---

## 6. Implementation Roadmap

### Phase 0: Verification (Before ANY deployment)
1. Create `_verify-evergreen-config.ts` script
2. SSH to ONE test VM (e.g., vm-379)
3. Write the config to `~/.openclaw/config/openclaw.json`
4. Restart gateway
5. Verify health (active state + 200 response)
6. Monitor for 1 hour
7. Check that heartbeats run in isolated session
8. Verify compaction behavior by checking session files

### Phase 1: Single VM Canary
1. Deploy to one user's VM (pick an active user who has reported the forgetting issue)
2. Monitor for 24 hours
3. Verify: no 4 AM reset, heartbeats isolated, compaction works
4. Get user feedback

### Phase 2: Fleet Rollout
1. Dry-run fleet script
2. Deploy to 10% of fleet
3. Monitor for 24 hours
4. Deploy to remaining fleet
5. Update SOUL.md instructions to reference new behavior

### Phase 3: SOUL.md Updates
1. Update agent instructions to proactively write important context to memory files
2. Add "memory hygiene" instructions for pre-compaction awareness
3. Remove any instructions that reference daily resets or "fresh start each morning"

---

## 7. Answers to the 7 Specific OpenClaw Questions

### Q1: What are ALL the session.reset.* config options?
See Section 2.1 above. The complete list: `mode`, `atHour`, `idleMinutes`, `resetByType`, `resetByChannel`, `resetTriggers`, `dmScope`, `mainKey`.

### Q2: What is the default daily reset time and can it be disabled?
Default: `mode: "daily"`, `atHour: 4` (4:00 AM gateway host local time). To disable: set `mode: "idle"` with a high `idleMinutes` value. There is no way to set `mode: "off"` or `mode: "none"` — the "evergreen" pattern (`mode: "idle"`, `idleMinutes: 10080`) is the recommended approach.

### Q3: Is there a "persist" or "continuous" mode where session never resets?
**No.** There is no native `"persist"`, `"continuous"`, or `"evergreen"` mode. The only two modes are `"daily"` and `"idle"`. The community-standard workaround is `mode: "idle"` with `idleMinutes: 52560000` (~100 years) for true persistence, or `idleMinutes: 10080` (7 days) for a practical balance.

### Q4: Can heartbeats run in their own session?
**Yes.** Set `agents.defaults.heartbeat.isolatedSession: true`. This runs heartbeats in a separate session key (`agent:main:heartbeat`), reducing context from ~100-200K tokens to ~2-5K per run. Add `lightContext: true` to further limit bootstrap to just HEARTBEAT.md. The OpenClaw community **strongly recommends** this for always-on agents.

### Q5: What happens to pending tool calls when a session resets?
The session is **deleted** on reset. Any in-progress tool calls, pending reasoning, or conversation context is lost. There is no handoff, summary injection, or graceful shutdown. The new session starts cold with only MEMORY.md and memory/*.md files. This is OpenClaw's biggest gap for persistent agents (Issue #40418 proposes fixing this, not yet merged).

### Q6: Is there a session handoff mechanism?
**No native handoff exists.** The closest mechanisms are:
- **Pre-compaction memory flush** — agent writes notes before compaction (but NOT before session reset)
- **memory/YYYY-MM-DD.md** — daily logs loaded at session start
- **MEMORY.md** — curated long-term memory loaded in main session
- **memory_search** — semantic recall over indexed snippets
- **sessions_spawn** / **sessions_send** — can spawn sub-sessions, but these die on gateway restart (Issue #19780)

### Q7: What do OpenClaw maintainers recommend for always-on agents?
1. Use `isolatedSession: true` for heartbeats
2. Use `per-channel-peer` dmScope for multi-user agents
3. Keep daily resets unless you have a specific reason to disable them (but they offer no "evergreen" mode natively)
4. If disabling daily resets, implement compensating measures: aggressive maintenance, memory flush enabled with 8000+ softThresholdTokens, FLUSH.md with critical state files
5. Enable context pruning for Anthropic profiles
6. Design agent workflows to be **resilient to context loss** rather than trying to prevent it entirely

---

## Sources

### Platform Documentation
- [OpenClaw Session Management Docs](https://docs.openclaw.ai/concepts/session)
- [OpenClaw Configuration Reference](https://github.com/openclaw/openclaw/blob/main/docs/gateway/configuration-reference.md)
- [OpenClaw Session Management Deep Dive](https://docs.openclaw.ai/reference/session-management-compaction)
- [OpenClaw Heartbeat Docs](https://docs.openclaw.ai/gateway/heartbeat)
- [Claude Code Memory](https://code.claude.com/docs/en/memory)
- [Devin Session Insights](https://docs.devin.ai/product-guides/session-insights)
- [Replit Checkpoints and Rollbacks](https://docs.replit.com/replitai/checkpoints-and-rollbacks)
- [Cursor Codebase Indexing](https://cursor.com/docs/context/codebase-indexing)
- [OpenAI Assistants API](https://platform.openai.com/docs/assistants/deep-dive)
- [OpenAI Compaction Guide](https://developers.openai.com/api/docs/guides/compaction)

### Platform Blog Posts & Engineering
- [Manus: Context Engineering for AI Agents](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- [Manus: Wide Research — Beyond the Context Window](https://manus.im/blog/manus-wide-research-solve-context-problem)
- [Cognition: Rebuilding Devin for Claude Sonnet 4.5](https://cognition.ai/blog/devin-sonnet-4-5-lessons-and-challenges)
- [Replit: Decision-Time Guidance](https://blog.replit.com/decision-time-guidance)
- [Cursor: Self-Summarization](https://cursor.com/blog/self-summarization)
- [OpenAI: Unrolling the Codex Agent Loop](https://openai.com/index/unrolling-the-codex-agent-loop/)
- [Anthropic: Effective Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Anthropic: Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

### OpenClaw Community & Issues
- [Issue #1727: Soft context reset on session boundary](https://github.com/openclaw/openclaw/issues/1727)
- [Issue #19780: Persistent named sessions](https://github.com/openclaw/openclaw/issues/19780)
- [Issue #31322: Silent daily resets after v2026.2.26](https://github.com/openclaw/openclaw/issues/31322)
- [Issue #31435: Memory flush threshold too small](https://github.com/openclaw/openclaw/issues/31435)
- [Issue #40418: Automated session memory preservation](https://github.com/openclaw/openclaw/issues/40418)
- [Issue #17917: Selective compaction for heartbeats](https://github.com/openclaw/openclaw/issues/17917)
- [Issue #19524: Extended thinking breaks compaction](https://github.com/openclaw/openclaw/issues/19524)
- [Plugin: openclaw-session-evergreen-all-channels](https://github.com/constansino/openclaw-session-evergreen-all-channels)

### Research & Industry
- [Google: Always-On Memory Agent (GitHub)](https://github.com/GoogleCloudPlatform/generative-ai/tree/main/gemini/agents/always-on-memory-agent)
- [JetBrains Research: Efficient Context Management (Dec 2025)](https://blog.jetbrains.com/research/2025/12/efficient-context-management/)
- [Mem0: Building Production-Ready AI Agents (arXiv)](https://arxiv.org/abs/2504.19413)
- [MemGPT: Towards LLMs as Operating Systems (arXiv)](https://arxiv.org/abs/2310.08560)
- [Memory in the Age of AI Agents (arXiv)](https://arxiv.org/abs/2512.13564)
- [Context Anxiety: How AI Agents Panic About Their Perceived Context Windows](https://inkeep.com/blog/context-anxiety)
- [Letta: Agent Memory — How to Build Agents that Learn and Remember](https://www.letta.com/blog/agent-memory)
