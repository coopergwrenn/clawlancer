# PRD: Agent Memory Architecture Overhaul

**Author:** Claude (Opus 4.6) + Cooper Wrenn
**Date:** 2026-03-19
**Status:** Phase 1 COMPLETE, Phase 2 COMPLETE (deployed fleet-wide as manifest v38, 2026-03-20)
**Sprint:** 30-day rollout (4 phases)

---

## 1. Executive Summary

### The Problem

InstaClaw agents are forgetting things. Users report their agents losing track of projects, wallet addresses, trading preferences, and ongoing conversations. One user (Jeremy, "Ape Capital") had his agent completely forget a weeks-long project called OnlyMolts — the agent behaved as if the project never existed.

### Why It Happens

Every time a cron job runs on a VM (every minute, 4 jobs), OpenClaw creates or touches session files. Over weeks, hundreds of stale session files accumulate. OpenClaw loads all session metadata into the agent's context window on every message. The context window — the agent's "working memory" — has a hard limit of 200,000 tokens. Our skills documentation alone consumes 128,000 of those tokens. That leaves roughly 42,000 tokens for actual conversation. When stale session metadata fills that remaining space, the agent literally runs out of room to remember what the user said.

The agent isn't broken. It's drowning.

### What We're Doing About It

This PRD defines a four-phase, 30-day plan to fix the memory architecture:

- **Phase 0 (Days 1-3):** Fix bugs and verify what's possible. Check which OpenClaw native features actually exist. Fix a race condition in our session rotation code. Add monitoring to our recent cleanup deployment.
- **Phase 1 (Days 4-10):** Ship safe, high-impact wins. Trim skill documentation by 20% to free up context space. Improve session handoff instructions. Add weekly memory hygiene to agent heartbeats.
- **Phase 2 (Days 11-20):** Enable verified native features. Whatever OpenClaw features we confirm exist in Phase 0, we enable — but only after disabling our custom equivalents to prevent racing.
- **Phase 3 (Days 21-30):** Custom engineering for gaps that native features don't cover.

Every change follows our existing safety rules: dry-run first, test on one VM, verify gateway health, then fleet-wide.

---

## 2. Current Architecture

### 2.1 System Overview

Each InstaClaw user gets a dedicated Linux VM (Linode Nanode, 1GB RAM, 25GB disk) running:

- **OpenClaw v2026.3.13** — The AI agent framework (gateway process, managed by systemd)
- **4 cron jobs** — Python scripts running every minute (strip-thinking, auto-approve-pairing, vm-watchdog) plus a bash heartbeat script running hourly
- **The reconciler** — A server-side engine that detects configuration drift and auto-corrects VMs to match the manifest

The agent's "brain" lives in these locations:

```
~/.openclaw/
├── agents/main/sessions/
│   ├── *.jsonl              # Individual session transcripts
│   ├── sessions.json        # Index of all sessions (loaded into context)
│   ├── archive/             # Archived oversized sessions
│   ├── .strip-thinking.lock # fcntl lock for cron script
│   └── .last-session-cleanup # Throttle marker for daily hygiene
├── workspace/
│   ├── SOUL.md              # Agent personality + rules
│   ├── MEMORY.md            # Long-term curated memory (agent-editable)
│   ├── CAPABILITIES.md      # Read-only capability matrix
│   ├── TOOLS.md             # Agent-editable tool notes
│   ├── QUICK-REFERENCE.md   # Quick-lookup reference
│   └── memory/
│       ├── active-tasks.md  # Session handoff state
│       └── YYYY-MM-DD.md    # Daily logs
├── skills/                  # 20 SKILL.md files (loaded into context)
├── openclaw.json            # Gateway configuration
├── .env                     # Environment variables (GATEWAY_TOKEN, etc.)
└── memory/
    └── main.sqlite          # OpenClaw's internal memory index (FTS5 + vec0)
```

### 2.2 Session Management — The Split-Brain Problem

Session files are managed by **three independent systems** that do not coordinate:

| System | Runs | Threshold | Lock | Atomic Write | Location |
|--------|------|-----------|------|-------------|----------|
| `strip-thinking.py` (Phase 1: archive) | Every 1 min (cron) | **200 KB** | fcntl exclusive | Yes (.tmp → os.replace) | ssh.ts:89–860 |
| `strip-thinking.py` (daily_hygiene) | Every ~23 hrs (self-throttled) | **7 days age** | fcntl exclusive | Yes (.tmp → os.replace) | ssh.ts:240–340 |
| `rotateOversizedSession()` | Every 5 min (health cron) | **512 KB** | **None** | **No** (direct json.dump) | ssh.ts:5277–5340 |

The thresholds are defined in two places that disagree:

| Threshold | Python Cron (Active) | TypeScript Manifest (Reference) |
|-----------|---------------------|-------------------------------|
| Archive session at | 200 KB (ssh.ts:110) | 512 KB (vm-manifest.ts:344) |
| Memory write warning at | 160 KB (ssh.ts:111) | 400 KB (vm-manifest.ts:346) |
| Session alert at | N/A | 480 KB (vm-manifest.ts:345) |

The Python values (200 KB / 160 KB) are what actually runs on VMs. The TypeScript values (512 KB / 480 KB / 400 KB) in `vm-manifest.ts` are referenced by the health cron and the backwards-compatible `CONFIG_SPEC` export, but they do not control the minute-by-minute session management.

### 2.3 Memory Persistence Mechanisms

The agent has two layers of "save your memory" enforcement:

**Layer 1 — Pre-rotation warning** (strip-thinking.py, Phase 2):
When a session file exceeds 160 KB (80% of the 200 KB archive threshold), the script injects an HTML comment block into MEMORY.md:

```html
<!-- INSTACLAW:MEMORY_WRITE_URGENT:START -->
**URGENT**: Your session is at 80% capacity. Write critical context to MEMORY.md
and active-tasks.md NOW. You will lose this context when the session rotates.
<!-- INSTACLAW:MEMORY_WRITE_URGENT:END -->
```

This gives the agent a 40 KB window (~5-10 messages) to save important context before the session is archived.

**Layer 2 — Staleness detection** (strip-thinking.py, Phase 3):
If MEMORY.md hasn't been modified in 24+ hours and the current session is >10 KB, a maintenance reminder is injected.

Both layers use flag files (`.memory-write-pending`, `.memory-stale-notified`) to avoid repeated injection.

### 2.4 Context Window Budget

OpenClaw uses Claude's 200,000-token context window. Here is how it's consumed:

| Source | Size (chars) | Est. Tokens | % of Window |
|--------|-------------|-------------|-------------|
| Skills (20 SKILL.md files) | 491,239 | ~122,800 | 61.4% |
| CAPABILITIES.md | 36,007 | ~9,000 | 4.5% |
| SOUL.md (with supplements) | ~8,000 | ~2,000 | 1.0% |
| System prompt overhead | ~12,000 | ~3,000 | 1.5% |
| Other workspace files | ~5,000 | ~1,250 | 0.6% |
| **Total static overhead** | **~552,000** | **~138,000** | **69.0%** |
| **Remaining for conversation** | — | **~62,000** | **31.0%** |

The `skills.limits.maxSkillsPromptChars` config is set to 500,000. Our 20 skills total 491,239 chars — using 98.2% of the skill budget. The comment in vm-manifest.ts:141-143 warns: "Below 500K, skills are silently dropped (alphabetical load order). Caused 3 fleet-wide outages when reverted."

With ~62,000 tokens remaining:
- The `reserveTokensFloor` of 30,000 means compaction fires when 30K tokens remain
- Usable conversation before compaction: ~62,000 - 30,000 = **~32,000 tokens**
- That's roughly 10-15 back-and-forth messages with tool calls

When sessions.json is bloated with hundreds of orphaned entries (as in the Ape Capital incident), this already-tight budget shrinks further.

### 2.5 The Reconciler

The reconciler (`vm-reconcile.ts`) is the fleet's auto-healing engine. It runs during the health cron's "config audit" pass:

- **Batch size:** 3 VMs per 5-minute health cron cycle
- **Full fleet convergence:** ~40 minutes for 140 VMs
- **Trigger:** `config_version` on VM < `VM_MANIFEST.version` (currently v32)

The reconciler's 9-step sequence:
1. Backup workspace (rolling 7-day)
2. Remove `_placeholder` key from openclaw.json
3. Fix drifted config settings via `openclaw config set`
4. Deploy workspace files (CAPABILITIES.md, SOUL.md supplements, etc.)
5. Deploy skills (all 20 SKILL.md files)
6. Install cron jobs (4 jobs, identified by marker string)
7. Install system packages (ffmpeg) and Python packages (openai)
8. Sync environment variables and auth tokens
9. Restart gateway (only if auth/systemd changed, NOT after every config set)

**Critical safety detail:** Config settings are applied with `|| true` — if OpenClaw rejects an invalid key, it fails silently. The gateway does NOT restart for config-only changes. This means an invalid config key is harmless (it just doesn't apply) — but it also means we have no feedback that a key was rejected.

### 2.6 Crash Protection

Systemd protects against gateway crash loops:

| Setting | Value | Effect |
|---------|-------|--------|
| `StartLimitBurst` | 10 | Max 10 restarts per window |
| `StartLimitIntervalSec` | 300 | 5-minute window |
| `StartLimitAction` | stop | Stop unit (don't restart forever) |
| `RestartSec` | 10 | 10s between restarts |
| `MemoryMax` | 3500M | Hard OOM kill at 3.5 GB |
| `RuntimeMaxSec` | 86400 | Auto-restart every 24h |
| `RuntimeRandomizedExtraSec` | 3600 | Stagger fleet restarts by up to 1h |

Recovery: Health cron detects `start-limit-hit`, runs `systemctl reset-failed` + `start`. At failure count 10 (~50 min), attempts full reconcile.

---

## 3. Root Cause Analysis

### 3.1 The Kill Chain

```
Cron jobs run every minute (strip-thinking.py, auto-approve-pairing.py, vm-watchdog.py)
    │
    ▼
Each execution touches session state; OpenClaw may create/update session metadata
    │
    ▼
Over weeks, hundreds of .jsonl files and sessions.json entries accumulate
    │
    ▼
strip-thinking.py archives sessions >200KB, but small stale sessions (<200KB) survive
    │
    ▼
sessions.json index grows (entries for archived/deleted sessions are never pruned
until daily_hygiene runs — and daily_hygiene was only deployed on 2026-03-19)
    │
    ▼
OpenClaw loads ALL sessions.json entries into context on every message
    │
    ▼
Context window fills with stale session metadata instead of conversation history
    │
    ▼
Agent "forgets" — not because memory is deleted, but because it's pushed out of
the context window by noise
    │
    ▼
Compaction fires (reserveTokensFloor = 30K), but compresses EVERYTHING including
the user's actual conversation — stale metadata survives because it was loaded first
```

### 3.2 Case Study: Ape Capital (Jeremy)

**User:** Jeremy (jeremyt4p@gmail.com)
**VM:** instaclaw-vm-379
**Bot:** Ape Capital — crypto/NFT trading agent
**Project:** OnlyMolts — a weeks-long NFT project

**Symptoms:**
- Agent stopped mentioning OnlyMolts in conversation
- When asked directly, agent said "I don't have any record of that project"
- OnlyMolts was still in MEMORY.md (confirmed via SSH grep)

**Diagnosis:**
- `sessions.json` was 28,662 bytes with orphaned entries pointing to archived sessions
- Only 1 actual `.jsonl` file existed on disk
- The bloated sessions.json metadata consumed context window space
- MEMORY.md content (including OnlyMolts) was technically "in context" but buried under noise
- Compaction compressed the useful conversation history while preserving the stale metadata

**Fix:**
- Pruned sessions.json from 28,662 bytes to 2 bytes (`{}`)
- Gateway restarted, agent immediately recalled OnlyMolts
- Total time to fix: 45 seconds of SSH commands

**Lesson:** The problem was not that memory was deleted — it was that stale metadata drowned out real memory in the context window.

### 3.3 Fleet-Wide Impact

Fleet cleanup on 2026-03-19 found:
- **148 assigned VMs** scanned
- **2,905 total session files** across fleet
- **420 stale sessions** (>7 days old)
- **vm-032** was worst: 14.9 MB sessions.json, 537 sessions, 311 stale
- **8 VMs** had unhealthy gateways (pre-existing issues on older Hetzner VMs)

This is not a one-user problem. Every VM accumulates session debt over time.

---

## 4. The Token Budget Crisis

### 4.1 The Elephant in the Room: Skills

The 20 deployed SKILL.md files total 491,239 characters. At ~4 chars per token, that's approximately **122,800 tokens** — 61% of the entire 200K context window.

Top 5 largest skills:

| Rank | Skill | Size | Tokens |
|------|-------|------|--------|
| 1 | motion-graphics | 65,781 bytes | ~16,400 |
| 2 | prediction-markets | 54,568 bytes | ~13,600 |
| 3 | web-search-browser | 34,006 bytes | ~8,500 |
| 4 | polymarket | 30,181 bytes | ~7,500 |
| 5 | higgsfield-video | 23,544 bytes | ~5,900 |

**polymarket** and **prediction-markets** overlap significantly — the comment in vm-manifest.ts:142 notes "polymarket removed as duplicate of prediction-markets" but both still exist as deployed skills.

### 4.2 Why Raising reserveTokensFloor Makes Things Worse

The previous gap analysis proposed raising `reserveTokensFloor` from 30,000 to 45,000 tokens. Here's the math:

| Scenario | Reserve | Compaction fires at | Static overhead | Conversation budget |
|----------|---------|--------------------|-----------------|--------------------|
| Current | 30,000 | 170K tokens used | 138K | **32,000 tokens** |
| Proposed | 45,000 | 155K tokens used | 138K | **17,000 tokens** |

Raising the reserve floor from 30K to 45K cuts the conversation budget from 32K to 17K tokens — a **47% reduction**. Users would hit compaction after roughly 5-8 messages instead of 10-15. This is unacceptable without first reducing the static overhead.

### 4.3 The Right Order

1. **First:** Reduce skills overhead from 491K to ~390K chars (20% trim) → frees ~25K tokens
2. **Then:** Consider raising reserveTokensFloor from 30K to 35K (modest increase)
3. **Research:** Whether OpenClaw supports on-demand skill loading (load only when referenced)

With 25K tokens freed from skill trimming:

| Scenario | Reserve | Static overhead | Conversation budget |
|----------|---------|----------------|--------------------|
| Current (no changes) | 30K | 138K | 32K |
| After skill trim only | 30K | 113K | **57K (+78%)** |
| After skill trim + reserve 35K | 35K | 113K | **52K (+63%)** |

Skill trimming alone gives more conversation headroom than any other single change in this PRD.

---

## 5. Research Findings

### 5.1 Applicable Patterns from Industry

| Source | Pattern | Applicable? | Status |
|--------|---------|------------|--------|
| **Manus** | Tiered context compaction (full → compact → reference-only) | Yes, but requires custom compaction strategy support in OpenClaw | Unverified |
| **Manus** | todo.md recitation (rewrite task list to keep goals in recent attention) | Yes — maps to our `active-tasks.md` | Can improve immediately |
| **Letta/MemGPT** | Sleep-time memory consolidation (background LLM calls during idle) | Yes — can use heartbeat + weekly cron | Phase 1 (heartbeat), Phase 2 (cron) |
| **Anthropic** | `compaction.memoryFlush` — agentic turn before compaction to save context | Would be ideal | Config key **unverified** |
| **Anthropic** | `session.maintenance` — native session lifecycle management | Would replace our custom code | Config key **unverified** |
| **OpenClaw community** | `--session isolated` flag for cron jobs | Would prevent cron session pollution | **Unverified** on our version |
| **Google Gemini** | Structured session handoff with explicit state serialization | Yes — strengthen active-tasks.md | Can improve immediately |
| **Cognition (Devin)** | Semantic memory search across past sessions | OpenClaw has SQLite FTS5 + vec0 index at `~/.openclaw/memory/main.sqlite` | Unverified config key |

### 5.2 Critical Finding: All Proposed Config Keys Are Unverified

The research phase produced 13 proposed config keys. **None of them have been verified** against the actual OpenClaw v2026.3.13 config schema.

There is no `openclaw config schema` command. Schema validation happens inside the compiled dist files. The only way to verify a key is to SSH into a VM, attempt `openclaw config set KEY VALUE`, and run `openclaw doctor`.

Previous incidents confirm this risk is real:
- `auth.mode: "none"` — existed in runtime code but was rejected by the config schema validator, crashing gateways fleet-wide
- `skills.limits.maxSkillsPromptChars` — caused 3 separate fleet outages when the value was changed

Our `stepConfigSettings()` uses `|| true` after every `openclaw config set`, which means invalid keys fail silently. The gateway won't crash — but the setting won't apply either, and we'll have no feedback that it failed.

**Phase 0 of this plan is entirely dedicated to verification before any config changes.**

---

## 6. Phased Implementation Plan

### Phase 0: Verification & Bug Fixes (Days 1-3)

**Goal:** Establish ground truth. Fix known bugs. Add monitoring. Zero risk to users.

#### P0.1 — Config Schema Verification Script

**What:** Create a script that SSHes into one VM and tests every proposed config key.

**File:** `instaclaw/scripts/_verify-config-schema.ts`

**Implementation:**
```
For each proposed key:
  1. Read current value: openclaw config get KEY
  2. Attempt set: openclaw config set KEY VALUE
  3. Verify set: openclaw config get KEY (did it stick?)
  4. Run doctor: openclaw doctor (any schema errors?)
  5. Revert: openclaw config set KEY ORIGINAL_VALUE
  6. Report: KEY → ACCEPTED / REJECTED / UNKNOWN
```

**Keys to test:**
- `session.maintenance.enabled` (true)
- `session.maintenance.maxSessionAge` (7d)
- `session.maintenance.maxSessions` (50)
- `session.maintenance.cleanupInterval` (6h)
- `compaction.memoryFlush.enabled` (true)
- `compaction.memoryFlush.prompt` (string)
- `memorySearch.experimental.sessionMemory` (true)
- `cron.sessionRetention` (isolated)

Also test on one VM:
- `openclaw run --session isolated --message "test"` — does the `--session isolated` flag work?
- `openclaw cron --help` — are there cron-specific session flags?

**Success criteria:** We know exactly which keys exist and which don't, with evidence.

**Effort:** 2 hours
**Risk:** None — read/test/revert pattern, single VM
**Rollback:** Automatic (script reverts each key after testing)

#### P0.2 — Fix rotateOversizedSession() Race Condition

**What:** The function writes `sessions.json` using a non-atomic `json.dump` directly to the file, with no lock. It can race with `strip-thinking.py` which uses atomic writes under fcntl lock.

**File:** `instaclaw/lib/ssh.ts` lines 5312-5326

**Change:** Replace the inline Python that does `json.dump(data, f)` with one that uses the `.tmp` → `os.replace` atomic write pattern:

```python
# Before (non-atomic):
with open('sessions.json', 'w') as f:
    json.dump(data, f)

# After (atomic):
import tempfile
with tempfile.NamedTemporaryFile('w', dir=SESSIONS_DIR, delete=False, suffix='.tmp') as tmp:
    json.dump(data, tmp)
    tmp_path = tmp.name
os.replace(tmp_path, 'sessions.json')
```

**Success criteria:** `rotateOversizedSession()` uses atomic write pattern
**Effort:** 30 minutes
**Risk:** Low — strictly safer than current behavior
**Rollback:** Revert the edit, push to main

#### P0.3 — Add daily_hygiene() Monitoring

**What:** We deployed `daily_hygiene()` to 140+ VMs via manifest v32 on 2026-03-19 but have no monitoring to confirm it's running.

**File:** `instaclaw/app/api/cron/health-check/route.ts` (memory health pass, ~line 1372)

**Change:** During the existing memory health sampling pass (5 VMs per cycle), also check:
```bash
stat -c %Y ~/.openclaw/agents/main/sessions/.last-session-cleanup 2>/dev/null || echo 0
```

Report the marker's mtime. If it's older than 48 hours, the daily hygiene hasn't run — log a warning. If the file doesn't exist, hygiene has never run on this VM.

Add to the health cron summary: `hygieneRunning: X/Y sampled VMs have run daily_hygiene in last 48h`.

**Success criteria:** Health cron reports daily_hygiene execution status
**Effort:** 1 hour
**Risk:** None — read-only addition to existing health check
**Rollback:** Remove the stat check

#### P0.4 — Reconcile Split-Brain Thresholds (Documentation)

**What:** Document the intentional difference between Python (200KB/160KB) and TypeScript (512KB/480KB/400KB) thresholds. The TypeScript values in `vm-manifest.ts` are reference constants used by the health cron for alerting. The Python values are the active enforcement. This is confusing to future developers.

**File:** `instaclaw/lib/vm-manifest.ts` lines 343-346

**Change:** Add clarifying comments:

```typescript
// ── Session thresholds ──
// NOTE: These are used by the health cron for alerting and by rotateOversizedSession()
// as a fallback safety net. The PRIMARY enforcement is in strip-thinking.py which uses
// its own thresholds: MAX_SESSION_BYTES=200KB, MEMORY_WARN_BYTES=160KB (hardcoded in
// the STRIP_THINKING_SCRIPT template in ssh.ts:110-111). Those were lowered independently
// after web fetch blowouts. The values below are the "outer fence" — if strip-thinking
// misses a session, the health cron catches it at these higher thresholds.
maxSessionBytes: 512 * 1024,
sessionAlertBytes: 480 * 1024,
memoryWarnBytes: 400 * 1024,
```

**Success criteria:** Future developers understand the dual-threshold design
**Effort:** 15 minutes
**Risk:** None — comments only
**Rollback:** N/A

---

### Phase 1: Safe Wins (Days 4-10)

**Goal:** Maximum impact with zero schema risk. All changes are template edits or file modifications — no OpenClaw config keys involved.

#### P1.1 — Skill Documentation Trim (Target: 20% reduction)

**What:** Reduce the 491K chars of SKILL.md content to ~390K chars, freeing ~25K tokens of conversation headroom.

**Priority targets:**

| Skill | Current | Target | Strategy |
|-------|---------|--------|----------|
| motion-graphics | 65,781 | ~45,000 | Move Remotion API reference to `references/` subdir; compress examples |
| prediction-markets | 54,568 | ~40,000 | Deduplicate with polymarket; compress API examples |
| polymarket | 30,181 | ~15,000 | Merge into prediction-markets as a section; remove standalone |
| web-search-browser | 34,006 | ~25,000 | Compress example outputs; remove verbose curl samples |
| higgsfield-video | 23,544 | ~18,000 | Compress API reference section |

**Files:** `instaclaw/skills/*/SKILL.md` (5-8 files modified)

**Implementation rules:**
- NEVER remove information that tells the agent HOW to use a skill
- NEVER remove API endpoints, auth patterns, or error handling
- DO compress verbose examples (3 examples → 1 representative example)
- DO move reference documentation to `references/` subdirs (loaded on-demand by agent, not auto-loaded into context)
- DO merge polymarket into prediction-markets (they overlap significantly)

**Success criteria:**
- Total SKILL.md size < 400K chars
- `skills.limits.maxSkillsPromptChars` can stay at 500K (comfortable headroom)
- All skills still function correctly (test one agent after deploy)

**Effort:** 4-6 hours
**Risk:** Low — skill content is documentation, not executable code
**Rollback:** Revert SKILL.md files from git, bump manifest version

#### P1.2 — Strengthen Session Handoff in SOUL.md

**What:** Make `active-tasks.md` usage more explicit and reliable. Currently, the SOUL.md supplement says: "Before context resets: write to memory/active-tasks.md with status, approaches tried, next steps." This is too vague.

**File:** `instaclaw/lib/agent-intelligence.ts` — SOUL_MD_INTELLIGENCE_SUPPLEMENT (lines 354-355)

**Change:** Replace the current session handoff section with:

```markdown
### Session Handoff Protocol
When you sense conversation is ending OR you've been working for 15+ messages:
1. Write to `memory/active-tasks.md`:
   - Task name + one-line status (DONE / IN PROGRESS / BLOCKED)
   - What you tried (including failures — don't repeat them next session)
   - Exact next step (specific enough that you could resume without asking)
   - Key file paths, wallet addresses, or IDs needed to continue
2. Update MEMORY.md if anything important happened (new project, preference, decision)
3. On session resume: Read active-tasks.md FIRST, before asking "what would you like to do?"
```

**Success criteria:** Agents more reliably preserve context across session boundaries
**Effort:** 30 minutes
**Risk:** None — template text only
**Rollback:** Revert template, bump manifest

#### P1.3 — Heartbeat Memory Hygiene

**What:** Add a weekly memory consolidation task to the agent's heartbeat. Heartbeats fire every 3 hours. The agent reads HEARTBEAT.md and performs scheduled tasks.

**File:** Deployed via vm-manifest.ts as a new workspace file, or appended to existing HEARTBEAT.md template.

**New content:**

```markdown
## Weekly Memory Maintenance (Sundays only)
If today is Sunday and you haven't done this in the past 7 days:
1. Read MEMORY.md — if over 20KB, consolidate:
   - Remove entries older than 30 days that aren't tied to active projects
   - Merge duplicate information
   - Keep wallet addresses, API keys, user preferences, active project context
2. Read memory/active-tasks.md — archive tasks marked DONE older than 7 days
3. Delete memory/YYYY-MM-DD.md daily log files older than 14 days
4. Note "Memory consolidated YYYY-MM-DD" at the end of MEMORY.md
```

**Success criteria:** MEMORY.md sizes trend downward over time; no memory exceeds 25KB
**Effort:** 1 hour
**Risk:** Low — worst case, agent skips the task
**Rollback:** Remove the template section, bump manifest

#### P1.4 — CAPABILITIES.md Size Optimization

**What:** CAPABILITIES.md is 36,007 chars (~9K tokens) loaded on every session start. Much of it is a comprehensive capability matrix that could be shorter.

**File:** `instaclaw/lib/agent-intelligence.ts` — WORKSPACE_CAPABILITIES_MD (lines 374-884)

**Strategy:**
- Keep the routing header and session-start rules (critical for correct behavior)
- Compress the capability matrix (replace verbose descriptions with concise indicators)
- Move the "detailed how-to" sections to QUICK-REFERENCE.md (already exists, only 2K chars)

**Target:** Reduce from 36K to ~24K chars (save ~3K tokens)

**Success criteria:** CAPABILITIES.md under 25K chars; agent behavior unchanged
**Effort:** 2-3 hours
**Risk:** Low — documentation restructuring
**Rollback:** Revert template, bump manifest

---

### Phase 2: Schema-Verified Native Features (Days 11-20)

**Prerequisite:** Phase 0 schema verification MUST be complete. Only config keys confirmed as ACCEPTED are implemented.

**Critical rule:** For every native feature we enable, we MUST simultaneously disable the custom equivalent to prevent racing systems.

#### P2.1 — Native Session Maintenance ~~(IF keys exist)~~ — NO-GO

**Schema verification result (2026-03-19):** REJECTED. None of the proposed keys exist in OpenClaw v2026.3.13:

| Key Tested | Result |
|---|---|
| `session.maintenance.enabled` | `Config path not found: session` |
| `session.maintenance.maxAgeDays` | `Config path not found: session` |
| `agents.defaults.session.maxAgeDays` | `Config path not found: agents.` → validation failed |
| `agents.defaults.session.maintenance.enabled` | `Config path not found: agents.` → validation failed |

The entire `session.*` namespace does not exist in the OpenClaw config schema. There is no native session maintenance.

**Decision:** SKIP. Our custom `daily_hygiene()` + `strip-thinking.py` remain the session management system. Consider tightening daily_hygiene from 23h to 12h in Phase 3.

**Effort:** 0

#### P2.2 — Pre-Compaction Memory Flush — CORRECTED: GO

**Schema verification result (2026-03-19, CORRECTED):** Initial test used wrong path (`compaction.memoryFlush.enabled` without `agents.defaults.` prefix). The correct path `agents.defaults.compaction.memoryFlush.enabled` IS ACCEPTED.

| Key Tested | Result |
|---|---|
| `compaction.memoryFlush.enabled` (top-level) | ❌ `Config validation failed: <root>` (wrong path) |
| `agents.defaults.compaction.memoryFlush.enabled` | ✅ ACCEPTED on all 3 test VMs |

**Implementation exists in OpenClaw v2026.3.13 dist:**
- `resolveMemoryFlushSettings()` — reads config from `agents.defaults.compaction.memoryFlush`
- `softThresholdTokens` — token threshold for triggering flush (default 4000)
- `session_before_compact` event + `before_compaction` hook
- `memoryFlushWritePath` — writes flushed memory to workspace file
- `memoryFlushCompactionCount` — tracks flush history per session
- Full pre-compaction flow: check threshold → run flush agent turn → write to MEMORY.md → proceed with compaction

**Caveat:** Some VMs running older OpenClaw versions (pre-v2026.3.13) have 0 mentions of memoryFlush in their dist files. The feature will be silently ignored on those VMs until they're upgraded.

**Decision:** ENABLE fleet-wide. Added `agents.defaults.compaction.memoryFlush.enabled: "true"` to VM_MANIFEST v35. The gateway hot-reloads this setting — no restart needed.

**What this means:** Before OpenClaw compacts a session (discarding older messages), it will first run a memory flush — asking the agent to save important context to MEMORY.md. This directly addresses the "agent forgets" problem by ensuring critical information is persisted before being discarded.

**Rollback:** Remove config key from manifest, bump version
**Effort:** Already done (added to v35 manifest)

#### P2.3 — Cron Session Isolation ~~(IF flag works)~~ — NO-GO

**Schema verification result (2026-03-19):** REJECTED. No cron session isolation config exists:

| Key Tested | Result |
|---|---|
| `cron.sessionRetention` | `Config path not found: cron.se` |
| `cron.session.retention` | `Config validation failed: cron: U` (unknown key) |
| `agents.defaults.cron.sessionRetention` | validation failed |

The `cron` namespace does not accept session-related keys. The `openclaw run --session isolated` flag was not tested (separate from config), but the config-based approach is dead.

**Decision:** SKIP. Heartbeat-driven consolidation from P1.3 remains the mechanism. The `--session isolated` CLI flag should still be tested in Phase 3 as a possible improvement for cron wrappers.

**Effort:** 0

#### P2.4 — Modest Reserve Token Increase — DEPLOYED

**Schema verification result (2026-03-19):** CONFIRMED. `agents.defaults.compaction.reserveTokensFloor` exists.

**Status:** DEPLOYED in manifest v37 (2026-03-19). Raised from 30000 to 35000.

**Unblock justification:** Full PRD audit verified P1.1 skill trim savings are live: 329K-374K across fleet (down from 491K baseline). CAPABILITIES.md at 14,670 bytes (down from 36K). Total static overhead reduced by ~25K+ tokens.

**Token math (current):**
- Static overhead: ~113K tokens (down from 138K)
- Reserve: 35K (up from 30K)
- Compaction fires at: 200K - 35K = 165K tokens used
- Conversation budget: 165K - 113K = **52K tokens** (up from 32K pre-overhaul)

Net improvement: **62% more conversation headroom** compared to pre-overhaul baseline.

**Rollback:** Set back to 30000
**Effort:** Done

#### P2.5 — Enable Memory Search — NEW DISCOVERY

**Schema verification result (2026-03-19):** CONFIRMED. `agents.defaults.memorySearch.enabled` exists and accepts boolean values.

| Key Tested | Result |
|---|---|
| `memorySearch.enabled` (top-level) | `Config path not found` — wrong path |
| `agents.defaults.memorySearch.enabled` | ✅ accepted (set to false, then reverted) |
| `agents.defaults.memorySearch` | `{"enabled": false}` — shows full object |

**What this could mean:** OpenClaw has a built-in memory search feature backed by `~/.openclaw/memory/main.sqlite` (FTS5 + vec0). If enabled, agents may get a `memory_search` tool that can query past session content — making MEMORY.md less critical as the sole persistence layer.

**Investigation plan:**
1. Enable on one test VM: `openclaw config set agents.defaults.memorySearch.enabled true`
2. Restart gateway, verify healthy
3. Check if agent has a new `memory_search` tool in its tool list
4. Test: send a message, start new session, ask agent to recall the message
5. Inspect `main.sqlite` — is it being populated with session content?

**If it works:** This is a game-changer. Agents can search past conversations instead of relying solely on MEMORY.md. Could reduce memory loss dramatically.

**If it doesn't work (or is too slow/unreliable):** Revert to `false`, no harm done.

**Rollback:** `openclaw config set agents.defaults.memorySearch.enabled false`
**Effort:** 1-2 hours investigation
**Risk:** Very low — feature already exists in the binary, just disabled

#### Phase 2 Deployment Results

**Manifest v35 (2026-03-19):**
- 151/152 VMs updated successfully
- Both `memorySearch.enabled` and `memoryFlush.enabled` confirmed fleet-wide
- `memory_search` tool confirmed available in agent tool list
- Memory index: FTS5 + OpenAI text-embedding-3-small (1536 dims)

**Full PRD Audit (2026-03-19):**
Comprehensive audit of all Phases 0-2 across 11 VMs found two gaps:
- P1.3 HEARTBEAT.md consolidation: 0% fleet coverage (template uses `create_if_missing`)
- P1.EXTRA SOUL.md Sharing Files/deliver_file/Be selective: 0% coverage (same root cause)
- Root cause: `create_if_missing` mode doesn't update existing files; these sections were added to templates after VMs were provisioned

**Manifest v37 (2026-03-19):**
- Fleet script stripped old SOUL.md supplement, appended HEARTBEAT.md consolidation block
- Unblocked P2.4: raised `reserveTokensFloor` from 30000 to 35000
- SOUL.md re-append failed: marker "Rule priority order" exists in base SOUL.md template, not just supplement

**Manifest v38 (2026-03-20) — FINAL:**
- Fixed supplement marker: changed from "Rule priority order" to "INTELLIGENCE_INTEGRATED"
- 150/157 VMs updated (7 gateway timeouts — health cron auto-recovers)
- 39 HEARTBEAT.md files fixed (VMs that missed v37 due to missing HEARTBEAT.md)
- Post-deploy verification on 5 VMs: ALL PASS

**Phase 2 final scorecard:**
| Item | Status | Notes |
|---|---|---|
| P2.1 — Session Maintenance | ❌ NO-GO | `session.*` keys don't exist |
| P2.2 — Memory Flush | ✅ DEPLOYED | `agents.defaults.compaction.memoryFlush.enabled: true` |
| P2.3 — Cron Isolation | ❌ NO-GO | `cron.sessionRetention` keys don't exist (top-level accepted but untested) |
| P2.4 — Reserve Token Increase | ✅ DEPLOYED | `reserveTokensFloor: 35000` (was 30000, unblocked after P1.1 skill trim verified) |
| P2.5 — Memory Search | ✅ DEPLOYED | `agents.defaults.memorySearch.enabled: true` |

**Phase 1 completeness (verified 2026-03-20):**
| Item | Status | Notes |
|---|---|---|
| P1.1 — Skill Trim | ✅ COMPLETE | 329K-374K across fleet (target <380K), polymarket/ removed |
| P1.2 — Session Handoff | ✅ COMPLETE | 100% of VMs via supplement |
| P1.3 — Heartbeat Consolidation | ✅ COMPLETE | Fixed in v37/v38 fleet push |
| P1.4 — CAPABILITIES.md | ✅ COMPLETE | 14,670 bytes (59% reduction from 36K) |
| P1.EXTRA — Sharing Files | ✅ COMPLETE | Fixed in v38 via corrected supplement marker |
| P1.EXTRA — Group Chat Fix | ✅ COMPLETE | "Be selective" deployed, "skip MEMORY.md" absent |

---

### Phase 3: Custom Engineering (Days 21-30)

**Goal:** Address gaps that native features don't cover. These are custom code changes.

#### P3.1 — daily_hygiene() Monitoring Dashboard

**What:** Read the `.last-session-cleanup` marker mtime and sessions.json size from sampled VMs during health cron. Expose via the HQ margins API for the dashboard.

**File:** `instaclaw/app/api/cron/health-check/route.ts`, `instaclaw/app/api/hq/margins/route.ts`

**Metrics to collect:**
- VMs where daily_hygiene has run in last 48h (count + percentage)
- Average sessions.json size across fleet
- Average session file count per VM
- VMs with sessions.json > 100KB (bloated)
- VMs where MEMORY.md > 20KB (approaching hygiene threshold)

**Success criteria:** Dashboard shows fleet memory health at a glance
**Effort:** 4-6 hours
**Risk:** None — read-only data collection

#### P3.2 — Unified Session Manager (if Phase 2 finds no native support)

**What:** If Phase 0 confirms that `session.maintenance.*` keys don't exist, unify our three session management systems into one.

**Current state:** Three systems (strip-thinking Phase 1, daily_hygiene, rotateOversizedSession) all write sessions.json independently.

**Proposed:** Remove `rotateOversizedSession()` entirely. Its job (catch sessions >512KB) is already handled by strip-thinking.py at 200KB — the 512KB threshold is never reached. This eliminates the race condition and the non-atomic write.

**File:** `instaclaw/lib/ssh.ts` (remove function), `instaclaw/app/api/cron/health-check/route.ts` (remove call at ~line 198)

**Success criteria:** Only one system writes sessions.json (strip-thinking.py under fcntl lock)
**Effort:** 1 hour
**Risk:** Low — removing a redundant safety net that's already covered
**Rollback:** Re-add function and call

#### P3.3 — Context Budget Skill Loader Research

**What:** Investigate whether OpenClaw supports lazy/on-demand skill loading — loading SKILL.md content only when the user references a skill, rather than loading all 491K chars on every message.

**Research tasks:**
1. SSH into VM: `grep -rn 'skills.load' ~/.nvm/versions/node/*/lib/node_modules/openclaw/dist/*.js`
2. Check: `openclaw config set skills.load.mode on_demand` — does the schema accept it?
3. Check OpenClaw release notes for lazy skill loading features
4. If supported: test on one VM, measure context usage before/after

**If supported:** This would be the single highest-impact change possible — reducing static overhead by ~100K+ tokens.

**If not supported:** Continue with manual skill trimming (P1.1) as the mitigation.

**Effort:** 2-4 hours (research only)
**Risk:** None — research, no production changes

---

## 7. Dependency Graph

```
Phase 0 (Days 1-3) — MUST complete first
│
├── P0.1 Schema Verification ─────────────────────────────────┐
│   (determines what's possible in Phase 2)                    │
│                                                              │
├── P0.2 Fix rotateOversizedSession race ──┐                  │
│                                          │                   │
├── P0.3 Add daily_hygiene monitoring      │                   │
│                                          │                   │
└── P0.4 Document split-brain thresholds   │                   │
                                           │                   │
Phase 1 (Days 4-10) — Safe wins            │                   │
│                                          │                   │
├── P1.1 Skill trim (20%) ────────────────────────────────────────┐
│   (REQUIRED before any reserveTokensFloor change)               │
│                                                                  │
├── P1.2 Strengthen session handoff                                │
│                                                                  │
├── P1.3 Heartbeat memory hygiene                                  │
│                                                                  │
└── P1.4 CAPABILITIES.md optimization                              │
                                                                   │
Phase 2 (Days 11-20) — Schema-verified only                        │
│                                                                  │
├── P2.1 Native session maintenance ◄──── P0.1 (keys must exist)  │
│   IF enabled → DISABLE daily_hygiene session steps               │
│   IF enabled → DISABLE rotateOversizedSession ◄── P0.2          │
│                                                                  │
├── P2.2 Pre-compaction memory flush ◄─── P0.1 (keys must exist)  │
│   IF enabled → DISABLE strip-thinking Layer 1                    │
│                                                                  │
├── P2.3 Cron session isolation ◄──────── P0.1 (flag must work)   │
│                                                                  │
└── P2.4 Reserve token increase ◄─────── P1.1 (skill trim first)  │
                                                                   │
Phase 3 (Days 21-30) — Custom engineering                          │
│                                                                  │
├── P3.1 Monitoring dashboard                                      │
│                                                                  │
├── P3.2 Unified session manager ◄─── P2.1 (only if no native)    │
│                                                                  │
└── P3.3 Skill loader research ◄──────────────────────────────────┘
```

**Critical path:** P0.1 → P2.1/P2.2/P2.3 (schema verification gates all native features)
**Highest impact path:** P1.1 → P2.4 (skill trim enables reserve token increase)
**Independent:** P1.2, P1.3, P1.4, P3.1 can ship anytime after Phase 0

---

## 8. Monitoring & Success Criteria

### 8.1 User-Facing Metrics

| Metric | Current Baseline | 30-Day Target | How to Measure |
|--------|-----------------|---------------|----------------|
| Memory loss complaints | ~2-3/week (anecdotal) | <1/week | Support channel tracking |
| Agent amnesia incidents | Unknown | 0 critical (no project forgotten) | User reports |
| "Do you remember X?" failures | Unknown | <10% failure rate | Sample 10 agents weekly |

### 8.2 System Metrics (Add to Health Cron)

| Metric | Current | Target | Source |
|--------|---------|--------|--------|
| Avg sessions.json size | Unknown (~5-15KB typical, up to 14.9MB worst) | <10KB p95 | Health cron sampling |
| Avg session file count per VM | ~20 (2905/148) | <15 | Health cron sampling |
| VMs with daily_hygiene running | Unknown | >95% | CLEANUP_MARKER mtime check |
| MEMORY.md avg size | Unknown | <20KB p95 | Health cron memory pass |
| Total skill chars | 491,239 | <400,000 | Static (from repo) |
| Conversation tokens available | ~32K est. | >50K | Calculated from skill size |
| Compaction events per VM per day | Unknown | Trending down | Gateway logs (if accessible) |

### 8.3 Dashboard Additions

Add a "Memory Health" section to the HQ dashboard (`/api/hq/margins`):

```json
{
  "memoryHealth": {
    "fleetSessionsJsonAvgBytes": 8234,
    "fleetSessionsJsonP95Bytes": 42000,
    "fleetAvgSessionFiles": 12,
    "vmsWithHygieneRunning": 142,
    "vmsWithHygieneStale": 3,
    "vmsWithBloatedIndex": 1,
    "fleetMemoryMdAvgBytes": 14200,
    "fleetMemoryMdOver20KB": 8,
    "totalSkillChars": 389000,
    "estimatedConversationTokens": 52000
  }
}
```

### 8.4 Definition of Done

The memory architecture overhaul is complete when:

1. No user reports agent amnesia for 2 consecutive weeks
2. sessions.json size is <10KB on 95% of VMs
3. daily_hygiene() is running on >95% of VMs
4. Total skill documentation is <400K chars
5. Estimated conversation token budget is >50K
6. All known race conditions are fixed (rotateOversizedSession atomic write)
7. Phase 0 schema verification is documented with results
8. This PRD is updated with actual Phase 2 decisions based on schema verification

---

## 9. Risks & Mitigations

### 9.1 Three Racing Session Managers

**Risk:** If native OpenClaw session maintenance is enabled without disabling our custom systems, three processes write sessions.json simultaneously (gateway, strip-thinking.py, rotateOversizedSession).

**Mitigation:** Phase 2 implementation rules require simultaneous enable/disable. The PR for P2.1 MUST include both the config addition AND the removal of custom session management code in the same commit.

### 9.2 Unverified Config Keys Crashing Gateways

**Risk:** An invalid config key causes gateway crash-loops across 140+ VMs.

**Mitigation layers:**
1. `|| true` in `stepConfigSettings()` means invalid keys are silently ignored — no crash
2. `openclaw doctor` advisory check catches schema issues during provisioning
3. Config changes do NOT trigger gateway restarts (only auth/systemd changes do)
4. Systemd `StartLimitBurst=10` + `StartLimitAction=stop` prevents infinite crash loops
5. Health cron auto-recovers crash-looped gateways

**Residual risk:** If a config value passes `config set` but causes runtime failure (like `auth.mode: "none"`), gateways crash on next restart. Recovery takes 4+ hours for full fleet.

**Additional mitigation:** Phase 0 schema verification catches this before fleet deploy.

### 9.3 Conversation Length Reduction

**Risk:** Raising `reserveTokensFloor` without reducing static overhead cuts conversation from 32K to 17K tokens.

**Mitigation:** P2.4 (reserve increase) is blocked by P1.1 (skill trim). The dependency is enforced in this PRD. Token math is documented for every scenario.

### 9.4 Skill Trimming Breaks Agent Behavior

**Risk:** Removing too much from SKILL.md files causes agents to lose the ability to use skills correctly.

**Mitigation:**
- Never remove HOW-TO information (API endpoints, auth patterns, command syntax)
- Only compress examples and move reference docs to subdirectories
- Test on one agent after each skill modification
- Skills are in git — full rollback in one commit

### 9.5 daily_hygiene() Deletes Active Sessions

**Risk:** The 7-day age cutoff could delete a session that a user hasn't chatted with in a week but considers "active."

**Mitigation already in place:** daily_hygiene() preserves all files modified in the last 24 hours, regardless of age. A user who hasn't chatted in 7+ days will lose old session files, but their MEMORY.md and active-tasks.md (the persistent memory) are never touched.

### 9.6 Fleet-Wide Restart Thundering Herd

**Risk:** 140 VMs all restart gateways in the same hour after a manifest bump.

**Mitigation already in place:**
- Reconciler batches at 3 VMs per 5-minute cycle (36/hour max)
- `RuntimeRandomizedExtraSec=3600` staggers daily restarts
- Gateway startup doesn't immediately call Anthropic API (waits for user messages)

---

## 10. Open Questions

### ~~Must Answer Before Phase 2~~ — ANSWERED (2026-03-19)

1. **Which config keys actually exist in OpenClaw v2026.3.13?** — ANSWERED.
   Tested 20+ proposed keys via `openclaw config set` + `openclaw config get` on vm-507.
   - `session.*` namespace: DOES NOT EXIST
   - `compaction.memoryFlush.*` (top-level): DOES NOT EXIST — but `agents.defaults.compaction.memoryFlush.enabled`: EXISTS ✅ (initial test used wrong path)
   - `cron.sessionRetention`: DOES NOT EXIST
   - `skills.load.mode` / `skills.loadMode`: DOES NOT EXIST
   - `agents.defaults.compaction.reserveTokensFloor`: EXISTS (default 30000)
   - `agents.defaults.memorySearch.enabled`: EXISTS (default false) — **NEW DISCOVERY**
   - `agents.defaults.heartbeat.every`: EXISTS (default "3h")
   - Phase 2 revised: P2.2 (memoryFlush) GO, P2.4 (reserveTokensFloor) BLOCKED, P2.5 (memorySearch) GO. P2.1 and P2.3 remain NO-GO.

2. **Does `--session isolated` work with `openclaw run`?** — NOT YET TESTED.
   Deferred to Phase 3. Config-based cron isolation (P2.3) is dead, but CLI flag may still work.

3. **Does `openclaw doctor` catch all schema violations?** — PARTIALLY ANSWERED.
   `openclaw config validate` correctly rejects invalid keys. `openclaw config set` also validates before writing. Both are sufficient for Phase 0 verification. Runtime validation not tested separately.

### ~~Should Answer Before Phase 3~~ — PARTIALLY ANSWERED (2026-03-19)

4. **Does OpenClaw support on-demand skill loading?** — NO.
   `skills.load.mode` and `skills.loadMode` both rejected by schema validation. `agents.defaults.skills.load.mode` and `agents.defaults.skills.loadMode` also rejected. On-demand skill loading does not exist in v2026.3.13. All skills are loaded into context at startup. P1.1 skill trims remain the only lever for reducing skill token cost.

5. **What does the OpenClaw SQLite memory index actually contain?** — INVESTIGATION IN PROGRESS.
   `agents.defaults.memorySearch.enabled` exists (default false). Enabling it may give agents a `memory_search` tool backed by `main.sqlite`. Testing on one VM now (P2.5).

6. **Can we read OpenClaw's compaction event logs?** — NOT YET TESTED.
   Deferred. Can check `journalctl --user -u openclaw-gateway | grep compaction` on a busy VM.

### Nice to Know

7. **Are heartbeat sessions truly isolated?**
   When the agent wakes for a heartbeat, does it create a new session or reuse the current one? If it reuses, heartbeat memory hygiene (P1.3) could modify files mid-conversation.

8. **What's the actual token cost of sessions.json in context?**
   We estimate based on character count, but OpenClaw may have its own overhead per session entry. A 10KB sessions.json might consume 5K tokens or 15K tokens depending on how OpenClaw serializes it.

9. **Could we deploy a smaller model for cron tasks?**
   If cron isolation works, could cron tasks use Haiku instead of Sonnet for cost savings? Or does the model selection happen at the gateway level, not per-session?

---

## Appendix A: File Reference

| File | Purpose | Key Lines |
|------|---------|-----------|
| `instaclaw/lib/ssh.ts` | SSH operations + STRIP_THINKING_SCRIPT template | 89-860 (Python script), 5277-5340 (rotateOversizedSession) |
| `instaclaw/lib/vm-manifest.ts` | Single source of truth for VM state | 123-347 (manifest), 354-361 (CONFIG_SPEC) |
| `instaclaw/lib/vm-reconcile.ts` | 9-step reconciliation engine | 34-121 (reconcileVM), 151-195 (stepConfigSettings) |
| `instaclaw/lib/agent-intelligence.ts` | Workspace templates deployed to VMs | 303-365 (SOUL_MD supplement), 374-884 (CAPABILITIES_MD) |
| `instaclaw/app/api/cron/health-check/route.ts` | 7-pass health monitoring cron | 180-258 (session/browser), 1309-1364 (config audit) |
| `instaclaw/skills/*/SKILL.md` | Skill documentation (20 files, 491K chars) | — |
| `instaclaw/scripts/_fleet-session-cleanup.ts` | Fleet-wide session cleanup (created 2026-03-19) | — |
| `instaclaw/scripts/_fix-ape-capital-sessions.ts` | One-off fix for Jeremy's VM (created 2026-03-19) | — |

## Appendix B: Skill Size Inventory

| Skill | Size (bytes) | % of Total |
|-------|-------------|------------|
| motion-graphics | 65,781 | 13.4% |
| prediction-markets | 54,568 | 11.1% |
| web-search-browser | 34,006 | 6.9% |
| polymarket | 30,181 | 6.1% |
| marketplace-earning | 23,501 | 4.8% |
| higgsfield-video | 23,544 | 4.8% |
| code-execution | 20,985 | 4.3% |
| sjinn-video | 20,264 | 4.1% |
| language-teacher | 20,170 | 4.1% |
| ecommerce-marketplace | 18,155 | 3.7% |
| email-outreach | 16,982 | 3.5% |
| financial-analysis | 14,335 | 2.9% |
| voice-audio-production | 13,856 | 2.8% |
| competitive-intelligence | 13,156 | 2.7% |
| instagram-automation | 13,082 | 2.7% |
| social-media-content | 12,479 | 2.5% |
| brand-design | 10,309 | 2.1% |
| x-twitter-search | 10,117 | 2.1% |
| solana-defi | 8,516 | 1.7% |
| agentbook | 6,975 | 1.4% |
| **TOTAL** | **491,239** | **100%** |

## Appendix C: Glossary

- **Context window**: The maximum amount of text an LLM can process at once (200K tokens for Claude)
- **Compaction**: OpenClaw's process of summarizing old conversation to free context space
- **reserveTokensFloor**: Token count reserved for the model's response; compaction fires when remaining tokens drop below this
- **sessions.json**: Index file mapping session IDs to metadata; loaded into context on every message
- **strip-thinking.py**: Custom Python cron script that strips internal reasoning blocks, truncates tool results, enforces memory persistence, and manages session lifecycle
- **daily_hygiene()**: Function within strip-thinking.py that runs every ~23 hours to clean stale sessions, rebuild sessions.json, and manage disk usage
- **Reconciler**: Server-side engine that detects configuration drift on VMs and auto-corrects to match the manifest
- **Manifest**: `VM_MANIFEST` in vm-manifest.ts — the single source of truth for expected VM state
- **Gateway**: The OpenClaw process on each VM that handles messaging, tool execution, and LLM calls
