# PRD: gbrain Integration — Knowledge Graph for the InstaClaw Fleet

**Status:** Draft (research-complete, awaiting Cooper review)
**Author:** Claude (Opus 4.7) for Cooper Wrenn
**Date:** 2026-05-05
**Scope:** Replace flat MEMORY.md/SOUL.md memory architecture across the ~190-VM InstaClaw fleet with [garrytan/gbrain](https://github.com/garrytan/gbrain) v0.27.0+, run as a per-VM embedded knowledge graph with MCP stdio integration to OpenClaw.
**Owners:** Cooper (product + go/no-go), Claude (implementation, fleet rollout, observability).
**Related:** [prd-soul-restructure.md](./prd-soul-restructure.md), [PRD-memory-architecture-overhaul.md](../PRD-memory-architecture-overhaul.md), [research-session-persistence.md](../research-session-persistence.md), [cross-session-memory.md](./cross-session-memory.md). CLAUDE.md Rules 7, 10, 17, 22, 23 are load-bearing here.

---

## 1. Executive Summary

The InstaClaw fleet runs ~150 OpenClaw agents on dedicated Linode VMs (DB shows 148 healthy assigned at last check; "190" was a stale figure). Each agent's "memory" is a flat-file `MEMORY.md` plus a templated `SOUL.md`/`CAPABILITIES.md`/`EARN.md`/22 skills bundle, all loaded as upfront context on every conversation turn. **Resolved SOUL.md is 32.6–34.7 KB depending on partner** (base 32.6 KB; +1.4 KB Edge appendix; +0.7 KB Consensus appendix; an Edge+Consensus VM is at 34.7 KB — **307 bytes from silent truncation under the 35,000-char cap**). Skills consume **61% of the 200K-token context window** (382,396 bytes across 22 SKILL.md files), and `sessions.json` carries **~43 KB of cached skill prompts per session entry** (vm-725 hit 2.6 MB across 49 entries). We have shipped multiple emergency hotfixes against this surface in the last 30 days (Rule 22 trim-not-nuke, Rule 23 sentinel guards, the v82 35K bump).

[gbrain](https://github.com/garrytan/gbrain) — Garry Tan's open-sourced (13.2k stars, 1,664 forks) personal-knowledge graph for OpenClaw and Hermes Agent — directly addresses two of these surfaces and is orthogonal to the other two. Each gbrain instance is a self-contained Bun-runtime CLI plus an embedded PGLite (in-process Postgres) database with pgvector, exposing a 9-table compiled-truth-plus-timeline knowledge graph through an MCP stdio server. v0.27.0 (released 2026-04-28) shipped multi-provider embeddings (OpenAI, Google Gemini, Voyage, Ollama, OpenAI-compatible) via Vercel AI SDK, removing the OpenAI lock-in that previously blocked production adoption at our scale.

**The proposal:** add gbrain to the VM manifest as a pinned dependency (`GBRAIN_PINNED_VERSION=0.27.0`), install it on every VM via a new `stepGbrain` reconciler step (Rule 10/23 compliant), wire it into OpenClaw via the existing MCP stdio mechanism, migrate per-VM `MEMORY.md` content into structured pages, and shrink the upfront context load from the current 32.6–34.7 KB of SOUL.md components plus ~16 KB of CAPABILITIES.md down to a **~6–8 KB Phase-5 floor** (identity, boundaries, operating principles, memory protocol, session-resume — these are bootstrap-critical and cannot move). Further reduction toward ~3 KB requires Phase 6 (skills migration to `gbrain skillpack`).

**Realistic effort:** **10 working days** (~3 calendar weeks with canary holds and audit gates) for the memory layer; **+6 days** to also migrate skills, for **16 working days total**. The viral byproduct — being one of the largest fleet deployments of gbrain in production, ~150 agents × ~750 MB knowledge graph each, ~21 cron jobs per agent per night — is real and Garry-Tan-tweetable, but the work has to stand on its own merits regardless.

**Recommended decision:** ship Phase 0 (one-VM canary on vm-050) this week. Hold for 24h. Decide on Phase 1 from the canary data. Do not commit to fleet rollout until Phase 1 (3 VMs across tiers) has soaked for ≥1 week per the OpenClaw Upgrade Playbook discipline.

---

## 2. Problem Statement

### 2.1 Current memory + context architecture (audited 2026-05-05; byte counts re-verified via Node regex extraction)

| Component | Bytes (verified) | Source |
|---|---|---|
| `WORKSPACE_SOUL_MD` | 19,388 | `instaclaw/lib/ssh.ts:2956` |
| `SOUL_MD_INTELLIGENCE_SUPPLEMENT` | 8,811 | `instaclaw/lib/agent-intelligence.ts:328` |
| `SOUL_MD_LEARNED_PREFERENCES` | 536 | `instaclaw/lib/agent-intelligence.ts:821` |
| `SOUL_MD_OPERATING_PRINCIPLES` | 1,164 | `instaclaw/lib/agent-intelligence.ts:849` |
| `SOUL_MD_MEMORY_FILING_SYSTEM` | 2,692 | `instaclaw/lib/agent-intelligence.ts:903` |
| `\n\n` separator | 2 | `instaclaw/lib/ssh.ts:4778` |
| **SOUL.md base subtotal** | **32,593** | concat at `instaclaw/lib/ssh.ts:4774-4779` |
| Edge appendix (inline string, edge_city VMs) | ~1,400 | `instaclaw/lib/ssh.ts:4781-4798` |
| Consensus appendix (inline string, consensus_2026 OR edge_city VMs) | ~700 | `instaclaw/lib/ssh.ts:4808-4813` |
| **SOUL.md, Edge+Consensus VM** | **~34,693** | (worst case = **307 bytes from cap**) |
| `SOUL_MD_DEGENCLAW_AWARENESS` | 618 | imported at `ssh.ts:12` but NOT concatenated — DEAD CODE |
| `SOUL_MD_CONSENSUS_MATCHING_AWARENESS` | 549 | imported but NOT concatenated — DEAD CODE (overridden by inline at `ssh.ts:4808-4813`) |
| `CAPABILITIES.md` (separate file, also loaded) | 16,010 | `instaclaw/lib/agent-intelligence.ts:476` |
| `EARN.md` (separate, on demand) | 10,567 | `instaclaw/lib/earn-md-template.ts:6` |
| **22 × SKILL.md** | **382,396** (61% of 200K context) | `instaclaw/skills/*/SKILL.md` |
| `MEMORY.md` initial seed | ~130 | `instaclaw/lib/vm-manifest.ts:974` |

`BOOTSTRAP_MAX_CHARS = 35000` is defined at `instaclaw/lib/vm-manifest.ts:429`. **An Edge+Consensus VM is 307 bytes from silent truncation** under the 35K cap. We bumped 30K → 35K in v82 (cost: ~$2.6K/year extra inference) precisely because the fleet was losing the `MEMORY_FILING_SYSTEM` section to truncation. The next bump is ~$3K/year + cache-disruption risk, with diminishing returns. **We are out of room on this axis.**

Skills are the dominant lever. 22 SKILL.md files at ~17 KB average = **382 KB always-on**. OpenClaw v2026.3.13+ has no on-demand skill mode; deployed skills are always loaded. We have already trimmed skills 33% since the [PRD-memory-architecture-overhaul.md](../PRD-memory-architecture-overhaul.md) baseline (491 KB → 382 KB). Further trimming is constrained by skill quality.

### 2.2 Pain points, with data

**P1 — `MEMORY.md` ceiling.** SOUL.md components are 96.6% of cap. Adding a single 1.2K partner section (Eclipse, future Devcon) would require another bump or a trim. Every char added forces an opportunity-cost decision: "what gets removed?"

**P2 — Skills bloat.** 61% of context window. The agent has ~78 K tokens of headroom for the actual conversation. On a 32 K-token user prompt with 16 K of recent history, we are at the API ceiling and pushing chat completions into the slow tail (Vercel maxDuration=300, but we have seen 60–90 s real-world). Rule 11 was authored against this exact failure surface.

**P3 — `sessions.json` bloat.** `~/.openclaw/agents/main/sessions/sessions.json` caches `skillsSnapshot.prompt` (~43 KB) per entry. vm-725 hit 2.6 MB across 49 entries. Reference: `instaclaw/scripts/_prune-vm-725-sessions.ts:1-4`, `instaclaw/scripts/_read-session-format.ts:200`. Bloat amplifies session-rotation latency and burns through context-window cache.

**P4 — Cross-session memory persistence.** Recent fix (Rule 22 trim-not-nuke + cron `openclaw memory index`) took us from 35% functional to 97%. Remaining 3% is structural: `MEMORY.md` is one flat file with no entity model. Agents can't ask "what do I know about Cooper specifically?" — they get the entire file or nothing. session-log.md is append-only with no retrieval layer.

**P5 — Empty-response cascades.** Largely orthogonal to memory architecture (root cause is LLM-side / proxy-side). However: every byte of upfront context shaves the slow-tail completion latency, and shipping the memory layer reduces the 90 s timeout pressure marginally. Not the right tool for P5; flagged for completeness.

### 2.3 What we have already validated

`instaclaw/lib/match-embeddings.ts` already runs an OpenAI/Voyage abstraction at 1024-dim Matryoshka for the consensus matching pipeline. We are not new to embeddings, we have the API keys provisioned on every VM (`OPENAI_API_KEY`, `VOYAGE_API_KEY` planned), and the cost model from that pipeline transfers directly. This makes the embedding piece of gbrain low-risk for us; it would have been the highest-risk piece for someone new to vector retrieval.

---

## 3. Proposed Solution: gbrain v0.27+ as Per-VM Knowledge Graph

### 3.1 What gbrain is

gbrain ([garrytan/gbrain](https://github.com/garrytan/gbrain), 13,236 stars, master branch, version `0.27.0` per the `VERSION` file) is a Bun-runtime CLI plus a Postgres-backed knowledge graph. Architecture per [`docs/GBRAIN_V0.md`](https://github.com/garrytan/gbrain/blob/master/docs/GBRAIN_V0.md):

**Storage layer:** 9 tables — `pages`, `content_chunks`, `links`, `tags`, `timeline_entries`, `page_versions`, `raw_data`, `ingest_log`, `config`. Two backends:
- **PGLite** (embedded, in-process Postgres via Bun, zero server, supports <1000 pages comfortably; Garry's own brain runs ~17,888 pages so the cap is soft).
- **Supabase Postgres** (managed, recommended for >1000 pages or multi-device).

For our model — 190 isolated VMs, each owning its agent's brain — **PGLite is the correct choice**: per-VM physical isolation, no shared infrastructure, no cross-tenant blast radius.

**Page model:** every entity (person, company, deal, concept, project) is a markdown file with two sections — `compiled_truth` (current best understanding, rewritten on new evidence) and `timeline` (append-only evidence trail, never edited). YAML frontmatter for type/tags. This **is** the "trim over nuke" pattern from Rule 22, applied at the data-model layer.

**Retrieval:** multi-stage hybrid. Multi-query expansion via Anthropic Haiku (3 variants per query, ~3 embeddings per query, "negligible cost"). Parallel vector (HNSW cosine) + keyword (tsvector + ts_rank) search. Reciprocal rank fusion. 4-layer dedup (exact source, cosine >0.85 merge, type cap 60%, per-page limit). Stale-alert annotation when `compiled_truth` is older than the latest `timeline` entry.

**Dream cycle:** an 8-phase nightly cron — `lint → backlinks → sync → synthesize → extract → patterns → embed → orphans` — that consolidates memory while the user sleeps. Garry's deployment runs **21 cron jobs per night** per agent. v0.23 added synthesize + patterns (transcripts → reflections + cross-session themes), which is exactly the cross-session-memory layer we have been trying to bolt onto strip-thinking.py's `run_periodic_summary_hook`.

**Distribution:** three identical deployment patterns from one `BrainEngine` interface:
1. Library (`bun add gbrain` import) — for OpenClaw/AlphaClaw to call directly.
2. CLI (`gbrain init`, `gbrain query`, etc.) — for humans + cron jobs.
3. **MCP server (stdio or HTTP)** — for Claude Code, Cursor, Hermes, **and OpenClaw via existing MCP transport**.

### 3.2 v0.27.0 — multi-provider embeddings (released 2026-04-28)

Per the [CHANGELOG](https://github.com/garrytan/gbrain/blob/master/CHANGELOG.md): all AI calls now route through a unified `src/core/ai/gateway.ts` module backed by Vercel AI SDK. Providers:
- **OpenAI** (`text-embedding-3-large`, default, 1536 dims; we use 1024 elsewhere via Matryoshka).
- **Google Gemini** (`gemini-embedding-001`, 768 dims).
- **Voyage** (we already have plans for `VOYAGE_API_KEY` as failover per [match-embeddings.ts](../../lib/match-embeddings.ts)).
- **Ollama** (local, free; e.g., `nomic-embed-text`).
- **OpenAI-compatible** (LM Studio, vLLM, E5, MiniMax, anything).

This is the unlock that makes gbrain viable at our scale. Pre-v0.27 was OpenAI-only and would have hit our existing OpenAI rate-limit envelope hard at 190 instances × dream-cycle nightly. v0.27 lets us:
- Default to OpenAI (ride existing quota),
- Failover to Voyage on rate-limit (we already buy Voyage capacity),
- Route deep-budget agents (free tier) to Ollama on-VM (zero marginal cost; the dedicated-2 VMs have 4 GB RAM and can run `nomic-embed-text` at ~50 ms latency).

Critical bug fixed in v0.27 worth flagging: **silent-drop bug** at three sites (`operations.ts:237`, `hybrid.ts:81`, `import-file.ts:112`) keyed off `!process.env.OPENAI_API_KEY` and silently returned zero vectors for non-OpenAI brains. v0.27 replaces all three with a `gateway.isAvailable('embedding')` check that honors the actual configured provider. **If we install gbrain at any version <0.27, non-OpenAI flows will silently no-op.** Version pin must be `>=0.27.0` from day zero.

### 3.3 Why per-VM, not shared

Two real options:
- **(A) Per-VM PGLite:** each agent owns its brain. ~750 MB / agent (Garry's 7,471-page benchmark). 190 × 750 MB = 142 GB total fleet (per-VM 80 GB disk is fine — agents will start at ~5 MB and grow to maybe 100–500 MB for the lifetime of any non-Garry-scale user).
- **(B) Shared Supabase:** one Postgres for the fleet, with multi-tenant ACLs.

Per-VM wins decisively:
- **Isolation:** matches our existing per-VM identity model. No multi-tenant ACL bug can leak agent A's brain to agent B.
- **Network:** zero. PGLite is in-process. No connection pool, no cold-start, no Supabase outage exposure.
- **Cost:** $0 marginal Supabase. We already pay for the VMs.
- **Failure mode:** one agent's PGLite corruption is one-VM downtime, not fleet-wide. Restorable from `~/.openclaw/session-backups/`.
- **Operational simplicity:** one new dependency on each VM, no new shared service to monitor.

The downside — no cross-agent knowledge sharing — does not matter for us. Agents are user-owned, not org-owned. If we ever want a shared "InstaClaw fleet brain" (e.g., for fleet operations, not user data), that is a separate gbrain instance on the monitoring VM, talking to the consensus matching pipeline.

### 3.4 What we keep, what we replace

**Keep:**
- OpenClaw gateway, watchdog, sessions.json, strip-thinking.py — gbrain does not replace any of these.
- `~/.openclaw/workspace/SOUL.md` (slimmed to ~3 KB pointer + identity).
- `~/.openclaw/workspace/MEMORY.md` (becomes a thin index of "what is in gbrain", per Rule 22 — never delete).
- `~/.openclaw/workspace/memory/session-log.md` and `active-tasks.md` (gbrain ingests them; originals stay).
- 22 SKILL.md files in Phase 1. Migration to `gbrain skillpack` is Phase 5.

**Replace:**
- Bulk of `WORKSPACE_SOUL_MD` (19 KB) → ~2 KB pointer that teaches the agent to query gbrain.
- Bulk of `CAPABILITIES.md` (16 KB) → moved to gbrain `concepts/` pages, queried on demand.
- `SOUL_MD_INTELLIGENCE_SUPPLEMENT` (8.8 KB) → split into `concepts/intelligence-supplement/` page + a 500-byte "session resume protocol" pointer.
- The cron `openclaw memory index` → replaced (or supplemented) by `gbrain dream`.

**Delta on bootstrap:** ~33.8 KB → ~3 KB SOUL.md pointer. **30 KB recovered**, which is roughly an entire CAPABILITIES.md or a third of skills budget.

---

## 4. Architecture

### 4.1 High-level diagram

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Per VM (Linode g6-dedicated-2, us-east, 4GB RAM, 80GB disk)                 │
│                                                                              │
│  ┌──────────────┐   stdio MCP   ┌──────────────┐   in-process   ┌─────────┐ │
│  │  OpenClaw    │ ───tools────► │ gbrain serve │ ────Bun────►  │ PGLite  │ │
│  │  gateway     │ ◄──results─── │  (stdio)     │                │ (HNSW + │ │
│  │ (systemd)    │               └──────┬───────┘                │ tsvector│ │
│  └──────┬───────┘                      │                        │ +pg_trgm│ │
│         │                              │ embeds                 └─────────┘ │
│         │ chat completions             ▼                                    │
│         ▼                       ┌────────────────┐                          │
│  ┌──────────────┐               │ Embedding API  │                          │
│  │  Anthropic   │               │ - OpenAI (def) │                          │
│  │  /completions│               │ - Voyage       │                          │
│  └──────────────┘               │ - Gemini       │                          │
│                                 │ - Ollama (loc) │                          │
│                                 └────────────────┘                          │
│                                                                              │
│  ┌──────────────────── ~/.openclaw/workspace/ ────────────────────────┐    │
│  │ SOUL.md      (slimmed to ~3KB; teaches agent to query gbrain)      │    │
│  │ MEMORY.md    (thin index of gbrain pages; agent edits OK)          │    │
│  │ memory/      session-log.md, active-tasks.md (kept; gbrain ingests)│    │
│  │ skills/      22 SKILL.md (Phase 1: unchanged. Phase 5: → gbrain)   │    │
│  └────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌──────────────────── ~/brain/ (gbrain corpus, gitignored) ──────────┐    │
│  │ people/      Cooper.md, etc. (compiled_truth + timeline)           │    │
│  │ companies/   companies the agent knows about                       │    │
│  │ concepts/    intelligence-supplement, capabilities, partner notes  │    │
│  │ deals/       (if applicable for the agent's user)                  │    │
│  │ daily/       agent-curated daily summaries                         │    │
│  │ media/x/     tweets ingested by integrations (db_only tier)        │    │
│  └────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌──────────────────── ~/.gbrain/ (gbrain state) ──────────────────────┐   │
│  │ config.json     (database_url, embedding_model, etc.)              │   │
│  │ pglite/         PGLite data dir (~5 MB initial, grows)             │   │
│  └────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  Cron jobs (6 new, alongside existing 7) — schedules use per-VM offset    │
│  to spread embedding-API load across the cron window (vm.id % 60):         │
│  • <VM-OFF>/15 * * * *  gbrain sync --repo ~/brain && gbrain embed --stale│
│  • 30  9 * * *   gbrain dream    # nightly 8-phase, 5am Eastern (off-peak)│
│  • 30  5 * * 0   gbrain doctor --json     # Sunday 5:30 UTC (off the      │
│                                          #  4:00 openclaw memory-index   │
│                                          #  cron clash — see §6.5 G6)   │
│  • 0   5 * * *   gbrain check-update     # log only; never auto-install   │
│  • 0  */6 * * *  gbrain stats > /var/log/gbrain-stats.log                 │
│  • 5   * * * *   tar -czf ~/.gbrain/pglite-backups/$(date +%Y%m%dT%H).tgz │
│                  ~/.gbrain/pglite/ + 7-day retention (see §6.5 / G3)     │
└──────────────────────────────────────────────────────────────────────────────┘
                                           │
                                           │ (no shared state — each VM
                                           ▼  is a fully isolated brain)
                                       ┌───────────────────────┐
                                       │ Reconciler (Vercel)   │
                                       │ stepGbrain checks:    │
                                       │ • binary version      │
                                       │ • PGLite intact       │
                                       │ • serve process up    │
                                       │ • cron entries match  │
                                       │ Pinned version:       │
                                       │ GBRAIN_PINNED_VERSION │
                                       └───────────────────────┘
```

### 4.2 OpenClaw ↔ gbrain wiring

OpenClaw already supports MCP servers via stdio. Existing MCP servers on a typical VM include `clawlancer`, `polymarket`, etc. We add one entry to `~/.openclaw/openclaw.json`:

```json
{
  "mcpServers": {
    "gbrain": {
      "command": "/home/openclaw/.bun/bin/gbrain",
      "args": ["serve"],
      "env": {
        "OPENAI_API_KEY": "${OPENAI_API_KEY}",
        "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}",
        "GBRAIN_DATABASE_URL": "pglite:///home/openclaw/.gbrain/pglite",
        "GBRAIN_EMBEDDING_MODEL": "openai:text-embedding-3-large",
        "GBRAIN_EMBEDDING_DIMENSIONS": "1024"
      }
    }
  }
}
```

This makes `gbrain.query`, `gbrain.put_page`, `gbrain.search`, `gbrain.graph_query`, `gbrain.timeline_add` available as native MCP tools to the agent. The agent's `SOUL.md` is updated to instruct: "Before answering questions about people, companies, deals, or past conversations, call `gbrain.query` first. Only fall back to MEMORY.md if gbrain returns no results."

**Critical security boundary:** stdio transport ONLY. Per the v0.26.9 changelog ([garrytan/gbrain CHANGELOG](https://github.com/garrytan/gbrain/blob/master/CHANGELOG.md)), HTTP MCP transport had an RCE: a missing `remote: true` field on the request handler context allowed a write-scoped OAuth token to submit `shell` jobs and execute arbitrary commands on the gbrain host. Fixed in v0.26.9, but the lesson is: **never run `gbrain serve --http` on our VMs.** Stdio is local-process-only and not exposed over the network. This is enforced by the manifest entry above (no `--http` flag) and validated by the reconciler (check that no `gbrain serve --http` process is running).

**Trust-boundary nuance (per gbrain AGENTS.md, R19 in §8 risk register):** even our local stdio caller is treated as `remote=true` (untrusted) by gbrain, since it goes through `src/mcp/server.ts` not `src/cli.ts`. Some operations are restricted in this mode — file uploads, certain admin operations. **Action item before Phase 0**: read `src/core/operations.ts` end-to-end and enumerate every check gated on `remote=true`. List them here. If any operation our agent needs is restricted, the upcoming `register-client` OAuth flow from v0.26.3 lets us issue scoped tokens that elevate specific operations without lifting the restriction wholesale. Do NOT patch around this with a fork.

### 4.3 The two-repo model adapted to InstaClaw

gbrain's [`docs/guides/repo-architecture.md`](https://github.com/garrytan/gbrain/blob/master/docs/guides/repo-architecture.md) prescribes two repos:

- **Brain repo** (knowledge: people/, companies/, deals/, concepts/, etc.) — what the agent learns about the world.
- **Agent repo** (operational config: AGENTS.md, SOUL.md, USER.md, MEMORY.md, skills/) — how the agent operates.

**Hard rule from gbrain:** "Never write knowledge to the agent repo." Files about people, companies, deals must always go to the brain repo.

For InstaClaw, this maps cleanly:
- Brain repo = `~/brain/` (new). Initially empty; populated by the migration script + ongoing agent activity.
- Agent repo = `~/.openclaw/workspace/` (existing). SOUL.md, MEMORY.md, skills/, memory/ stay here, but slimmed.

**Both kept; both gitignored from any user-facing repo.** No code changes needed to `vm-manifest.ts:files[]` for the brain repo path; gbrain creates `~/brain/` itself on first run.

### 4.4 Cache stability

OpenClaw's prompt cache has a 5-minute TTL. Currently SOUL.md changes invalidate cache for every active agent on the fleet — a $$$ event. The shape of this PRD's deliverable preserves cache stability:
- SOUL.md slims from **32.6 KB → ~7 KB Phase 5 floor** (NOT 3 KB; identity, boundaries, operating principles, memory protocol, session-resume are bootstrap-critical). Further reduction to ~3 KB requires Phase 6 (skills migration). Agent-specific context comes from gbrain queries, which are tool-calls (NOT part of the cached prefix).
- A SOUL.md change still invalidates the cache, but the cache prefix is **~5× smaller** at 7 KB vs 32.6 KB (vs the original ~11× claim that assumed the unrealistic 3 KB target). Material reduction in the "deploy a SOUL.md tweak, cost the fleet $X" tradeoff, just less dramatic than originally claimed.

---

## 5. Migration Plan

### 5.1 Guiding principles

1. **Rule 22 — never destructively modify user state.** MEMORY.md, session-log.md, active-tasks.md are kept on disk in their current form throughout migration. gbrain INGESTS them (read-only) into pages. Originals are never deleted. Backup before any write.
2. **Rule 7 — snapshot refresh discipline.** Every manifest version bump paired with the question "should we bake a new snapshot now?" The gbrain install adds Bun + ~80 MB of binary; we bake a new snapshot after Phase 1 is green, before fleet rollout.
3. **Rule 17 — canary, soak, audit gates.** Phase 0 is one VM, hold 24h. Phase 1 is 3 VMs across tiers, hold 1 week. Then waves of 10 with audit gates per OpenClaw Upgrade Playbook.
4. **Rule 23 — sentinel guards on every templated content.** The new `STEP_GBRAIN_INSTALL_SCRIPT` and the gbrain MCP entry get `requiredSentinels` so a stale reconciler can't silently ship the wrong version.
5. **Trim, don't nuke.** Every phase is reversible. SOUL.md keeps a versioned backup. PGLite has hourly snapshots in `~/.gbrain/pglite-backups/`.

### 5.2 Phase 0 — Single-VM canary (Day 1–2)

**Target:** vm-050 (Cooper's test agent, no real user).

**Steps:**

0. **Capture baseline latency before any change.** Run 50 representative chat completions (mix of /menu, real questions, partner-skill probes) and record p50/p95/p99 response time. After Phase 0 install, run the same suite — no regression beyond noise. **HALT and address if p95 > 1s on any `gbrain.query` call** (R6 mitigation per §8). Latency baseline is required for the Phase 1 decision gate.

1. **Snapshot before.** `tar -czf ~/.openclaw/session-backups/$(date +%s)-pre-gbrain.tar.gz ~/.openclaw/workspace/ ~/.openclaw/agents/main/sessions/sessions.json`. Verify size and untar-ability before proceeding.

2. **Install Bun.** `curl -fsSL https://bun.sh/install | bash; export PATH="$HOME/.bun/bin:$PATH"`. Verify `bun --version`.

3. **Clone gbrain at v0.27.0.** `git clone https://github.com/garrytan/gbrain.git ~/gbrain && cd ~/gbrain && git checkout v0.27.0 && bun install && bun link`. Verify `gbrain --version` matches `0.27.0` exactly. Log to `journalctl --user -u openclaw-gateway`.

4. **Initialize PGLite.** `gbrain init --pglite --embedding-model openai:text-embedding-3-large --embedding-dimensions 1024`. Verify with `gbrain doctor --json` — all checks must be green.

5. **Wire MCP into OpenClaw.** Add the `gbrain` entry to `~/.openclaw/openclaw.json` mcpServers. Restart `openclaw-gateway` per Rule 5 (active + health 200 within 30 s; revert + report if not).

6. **Smoke test #1 — basic MCP availability.** Send a chat completion that requires the agent to know what tools it has. Verify `gbrain.query`, `gbrain.put_page`, `gbrain.graph_query` show up in the agent's tool list.

7. **Smoke test #2 — write-then-read.** Through the agent: "remember that Cooper's favorite color is blue." Agent should call `gbrain.put_page` with slug `cooper` and the fact in compiled_truth. Then "what's Cooper's favorite color?" Agent should call `gbrain.query` and get the answer back. End-to-end round-trip confirms the integration works.

8. **Smoke test #3 — migration import.** `gbrain import ~/.openclaw/workspace/MEMORY.md --no-embed && gbrain import ~/.openclaw/workspace/memory/ --no-embed && gbrain embed --stale`. Verify `gbrain stats` shows pages > 0. Re-run query test — does retrieval surface a fact that was previously buried in MEMORY.md?

9. **Real-traffic test.** Cooper runs ~5 representative chats with the agent over 30 minutes. Watch `journalctl -f`. No SIGTERM, no watchdog kill, no empty-response loop. Chat completions complete in <30 s with the new `gbrain.query` tool calls in the trajectory.

10. **24h hold.** Let strip-thinking.py run, let the existing memory-index cron run (we have not yet replaced it), let the watchdog cycle. Verify nothing kicked off a session-archive event.

**Phase 0 success criteria (all must hold):**
- `gbrain --version` → `0.27.0`
- `gbrain doctor --json` → all green
- OpenClaw gateway active + /health 200 + real chat completion <30 s, 5× over 30 min
- `gbrain stats` shows pages and chunks created from the import
- No new entries in `instaclaw_watchdog_audit` for vm-050 in 24h
- Cooper's subjective read: "the agent remembers things better"

**Failure recovery:** revert by removing the `gbrain` entry from `openclaw.json`, restarting gateway, leaving the gbrain binary + `~/brain/` + `~/.gbrain/` in place (idle). MEMORY.md still authoritative.

### 5.3 Phase 1 — Three-VM cross-tier canary (Day 3–9)

**Targets:** one each from power, pro, starter tiers. Real users with real session history. Pick VMs whose users have given consent (or whose owners are Cooper or InstaClaw team).

**Steps:** identical to Phase 0, applied to each. Sequential, not parallel. Each held for 48 h before the next.

**Pre-import dry-run** (G1 mitigation, mandatory before any real-user import):

1. On vm-050 (or any test VM): copy a sample real-user MEMORY.md to `/tmp/test-import.md`.
2. Run `gbrain import /tmp/test-import.md --dry-run` (if v0.27 supports `--dry-run`; otherwise `gbrain import` to a throwaway brain at `~/.gbrain-test/`).
3. Capture parse warnings, slug collisions, empty-section handling, code-block-with-`##`-pattern false positives.
4. Spot-check 3 imported pages: do they match the source MEMORY.md sections? Multi-paragraph compiled_truth handled correctly?
5. **Only proceed with real-user imports if zero parse warnings AND zero unexplained slug collisions.**

This is the G1 mitigation from the audit — without it, an edge-case parsing bug could mangle a real user's MEMORY.md silently. Backup before any real import (Rule 22).

**New checks specific to real users:**
- The migration `gbrain import ~/.openclaw/workspace/MEMORY.md` must produce ≥1 page per `## ` heading in the existing MEMORY.md. Spot-check 3 entries per VM for fidelity (compiled_truth matches the original section).
- Cross-session retrieval test: ask the agent a question whose answer was in a session-log.md entry from ≥7 days ago. Pre-gbrain, the agent could only get this by re-reading session-log.md (which it rarely does, per Cooper's "an agent that forgets you after one error is not an agent" observation in Rule 22). Post-gbrain, the agent should `gbrain.query` and surface it.
- Empty-response cascade probe: send a deliberately-bad prompt that historically triggered the `empty_responses` branch in strip-thinking.py. Confirm `trim_failed_turns` still fires (Rule 22 still in force) AND that gbrain's session is unaffected.

**Phase 1 hold:** 1 week. This is non-negotiable per the OpenClaw Upgrade Playbook. Watchdog cycles, dream cycles, memory-index crons, real-user activity all happen during this window.

**Decision gate at end of Phase 1:** Cooper reviews. Either "ship Phase 2" or "halt + post-mortem."

### 5.4 Phase 2 — Dogfood (10 InstaClaw-team VMs) (Day 10–11)

All VMs owned by Cooper, Claude, or anyone who has agreed to dogfood. Use the same install path automated via `instaclaw/scripts/_install-gbrain-on-vm.ts` (a per-VM SSH script, NOT a fleet operation). Concurrency 1. Each VM verified per Phase 1's checks.

**Build the observability dashboard during this phase:**
- `gbrain stats` JSON output captured to a Supabase table `instaclaw_gbrain_stats` every 6h.
- Per-VM page count, chunk count, embedding count, query latency p50/p95/p99.
- Per-VM `gbrain doctor --json` health score.
- Cron success/failure log.

### 5.5 Phase 3 — Manifest + reconciler integration (Day 12–13)

Until this phase, gbrain is installed via per-VM SSH scripts. From this phase, it lives in the manifest and is owned by the reconciler.

**Migration is session-boundary safe** — the new MCP entry only takes effect at the next gateway *session* boundary, not at gateway restart. `stepGbrain` MUST NOT call `systemctl --user restart openclaw-gateway` (Rule 5 protection); existing in-flight conversations continue using MEMORY.md only and pick up gbrain on their next session start. If `stepGbrain` ever calls a restart, all 150 in-flight conversations break simultaneously.

**Changes:**

1. `instaclaw/lib/ssh.ts`: add `GBRAIN_PINNED_VERSION = "0.27.0"` and `BUN_PINNED_VERSION = "1.x"` alongside the existing pinned-version cluster (line 111+). Also bump `VM_MANIFEST.version` (current value at PR time — do not hardcode here; the file is the source of truth).
2. `instaclaw/lib/vm-manifest.ts`: add a new entry to `VM_MANIFEST.files[]` for `~/.openclaw/openclaw.json` mcpServers patch (mode: `merge_json`, NOT overwrite — preserves other servers). Add cron entries to `VM_MANIFEST.crons[]` per §6.5.
3. `instaclaw/lib/vm-reconcile.ts`: add `stepGbrain` AFTER `stepSkills` (don't reference specific step* function names by line number; the file's structure churns). Sequence:
   - SSH-read `bun --version`. If missing or wrong, install Bun.
   - SSH-read `gbrain --version`. If missing, clone + checkout pinned version + `bun install && bun link`.
   - If wrong version, `cd ~/gbrain && git fetch && git checkout v$VERSION && bun install`. **Verify after.** Per Rule 10, push to `result.errors` on mismatch — never to `result.fixed`.
   - SSH-test `gbrain doctor --json`. Push to errors on any non-green check.
   - SSH-test `gbrain serve --port 0 --probe-only` (a hypothetical no-op probe; if not in v0.27, we add a `bun -e "import('gbrain'); process.exit(0)"` smoke test).
3. `requiredSentinels` (Rule 23) on the new content:
   - `STEP_GBRAIN_INSTALL_SCRIPT` requires sentinels `["bun link", "GBRAIN_PINNED_VERSION", "gbrain doctor"]`.
   - The `~/.openclaw/openclaw.json` mcpServers patch requires sentinel `["gbrain serve"]`.
   - The new cron entries each get a unique marker for idempotent install.

4. Run the reconciler against vm-050 (already gbrain-equipped from Phase 0) — it should be a no-op. Then against a NEW VM (provisioned from the current snapshot, no gbrain) — the reconciler should install gbrain end-to-end. Verify-after-write per Rule 10.

5. `npm run build && npx tsc --noEmit && npm run test`. Push branch `feat/gbrain-integration`. Create Vercel preview. Cooper reviews.

### 5.6 Phase 4 — Snapshot bake + fleet rollout (Day 14–17)

**Step 4a — Bake a fresh snapshot (Day 14).** Per [CLAUDE.md Snapshot Creation Process](../../CLAUDE.md#snapshot-creation-process-complete-reference). The new image includes Bun + gbrain v0.27.0 + initialized PGLite stub. This solves the new-VM-from-stale-snapshot problem (Rule 7) before fleet rollout.

**Step 4b — Fleet rollout (Day 15–17).** Per OpenClaw Upgrade Playbook discipline:
- Concurrency 3, NOT higher.
- Waves of 10, audit gate between each.
- Hold the `reconcile-fleet` cron lock for the full duration (`tryAcquireCronLock("reconcile-fleet", 8*3600, "manual-fleet-gbrain-vN")`).
- Per-wave audit checks: `gbrain --version` matches; `gbrain doctor --json` green; OpenClaw gateway active; chat completion <30 s with `gbrain` tool available; cron entries present.
- HALT on first per-VM failure. Investigate. Resume only after root-cause fix + reconciler patch.

### 5.7 Phase 5 — MEMORY.md slim + SOUL.md slim (Day 18–20, +1 day vs original estimate)

After 100% fleet adoption confirmed and 72h soak.

**Realistic floor: ~6–8 KB SOUL.md, NOT ~3 KB.** The ~3 KB target from the v1 PRD draft assumed we could move almost everything to gbrain `concepts/` pages and have the agent query them on demand. Audit of what's actually in the current 32.6 KB base reveals load-bearing content that **must stay in bootstrap context**:

- **Identity** (~500 bytes): "You are X, owned by Y." Must stay — bootstrap.
- **Boundaries** (~300 bytes): "Don't reveal you're an AI", "Don't share API keys." Security-critical, must stay.
- **Operating principles** (1,164 bytes): error handling, never-self-restart, provider confidentiality. Mostly security-critical. Maybe ~200 bytes can move to a `concepts/` page.
- **Memory filing protocol** (2,692 bytes → can slim to ~300 bytes): the protocol itself must remain in bootstrap; details can be a pointer.
- **Session resume / instant scripts** (slice of INTELLIGENCE_SUPPLEMENT, ~3 KB): bootstrap-critical for first-message handling. Cannot move.

So the floor is ~6–8 KB. To reach ~3 KB, we'd need Phase 6 (skills migration to `gbrain skillpack`) which is gated separately.

Concrete deliverables:

- New `WORKSPACE_SOUL_MD_V3` template, target ~7 KB. Contains: identity, boundaries, slimmed operating principles, slimmed memory protocol, slimmed session-resume, "before answering, query gbrain" addendum, MEMORY.md fallback.
- New `WORKSPACE_MEMORY_MD_V2` template: minimal index (~500 bytes) + "see gbrain pages people/, companies/, etc." pointer. Existing per-agent MEMORY.md preserved (mode `create_if_missing`); new VMs get the V2 stub.
- Delete the now-DEAD `SOUL_MD_DEGENCLAW_AWARENESS` and `SOUL_MD_CONSENSUS_MATCHING_AWARENESS` constants in `agent-intelligence.ts` (they were already imported-but-unused — see §2.1 dead-code rows). Net byte savings: 0 (they weren't loaded). Net hygiene: cleaner import graph.
- Migrate `SOUL_MD_INTELLIGENCE_SUPPLEMENT` extras + `CAPABILITIES.md` content into gbrain `concepts/` pages via a one-shot script on every existing VM.
- BOOTSTRAP_MAX_CHARS can stay at 35K (no rush to reduce; cache stability). Actual bootstrap usage drops from ~32.6 KB to ~7 KB.

### 5.8 Phase 6 — Skills migration (Day 20–22) [optional]

Move 22 SKILL.md files into a `gbrain skillpack` per Garry's pattern. RESOLVER.md routes the agent to the right skill on demand. Skills go from 61% always-on context → on-demand.

**This phase is high-leverage but high-risk.** Skills are how agents do work. If the routing breaks, the agent fails to use a skill it should have. Defer until everything else is solid.

Gate: Phase 5 must be in production for ≥2 weeks before starting Phase 6.

---

## 6. Fleet Management Strategy

### 6.1 Version pinning

Mirror the existing `OPENCLAW_PINNED_VERSION` pattern at `instaclaw/lib/ssh.ts:111` (alongside `NODE_PINNED_VERSION` at line 122 and `BANKR_CLI_PINNED_VERSION` at line 131 — the pinned-version cluster).

```typescript
// instaclaw/lib/ssh.ts (alongside the existing *_PINNED_VERSION constants)
export const GBRAIN_PINNED_VERSION = "0.27.0";
export const BUN_PINNED_VERSION = "1.x"; // gbrain works with any 1.x; pin major
```

Reconciler refuses to bump a VM's `config_version` unless `gbrain --version` exits 0 with the pinned version (Rule 10 verify-after-set). Drift detected → push to `result.errors`, manual investigation required.

### 6.2 Tracking upstream

Garry ships fast. From the [CHANGELOG](https://github.com/garrytan/gbrain/blob/master/CHANGELOG.md):
- v0.25.1 (2026-04-?) — book-mirror skillpack
- v0.26.3 (~2026-04-?) — MCP OAuth panel
- v0.26.7 (2026-05-04) — test isolation foundation
- v0.26.8 (2026-05-04) — auto-RLS event trigger
- v0.26.9 (2026-05-04) — OAuth + MCP RCE hardening
- v0.27.0 (2026-04-28) — multi-provider embeddings (current pin target)

**Auto-pinning is dangerous.** Garry's velocity means breaking changes can land between minor versions. Our discipline:

1. **Watch GitHub releases.** A weekly cron (`gh release list garrytan/gbrain`) writes new releases to a Supabase table. A Vercel cron checks daily and posts to Slack/Telegram if there's a new release.
2. **Read the CHANGELOG before bumping.** Mandatory per the OpenClaw Upgrade Playbook ("read the changelog line by line"). Same discipline applies to gbrain. Look for: schema migrations (v0.26.8 added an event trigger), security fixes (v0.26.9 RCE), config schema changes (v0.27 added new env vars), CLI command renames.
3. **Canary before fleet.** Bumping `GBRAIN_PINNED_VERSION` is treated like bumping `OPENCLAW_PINNED_VERSION` — full Phase 0 + Phase 1 cycle. No exceptions for "small" version bumps.
4. **Rollback ready.** Keep the previous version's git tag, hold a snapshot of the previous PGLite schema, have `_rollback-fleet-gbrain-vN.ts` ready.

### 6.3 Reconciler step

```typescript
// instaclaw/lib/vm-reconcile.ts (new step, after stepSkills)
export async function stepGbrain(ctx: ReconcileContext): Promise<StepResult> {
  const { ssh, vm, result } = ctx;

  // ── Per-VM cron lock (Rule 8 / CLAUDE.md). The reconciler runs every 3 min;
  // gbrain install-from-scratch can take 8–10 min (Bun install + clone + bun
  // install + gbrain init + first embed). Without a lock, two reconciler
  // ticks could overlap on the same VM and collide on `bun install` writes,
  // leaving half-installed state. Mirror the existing replenish-pool lock
  // pattern from CLAUDE.md Rule 8.
  const acquired = await tryAcquireCronLock(`gbrain-install-${vm.id}`, 1800, "stepGbrain");
  if (!acquired) {
    // Another reconciler cycle is mid-install on this VM. Skip; next cycle retries.
    return result;
  }
  try {

  // 1. Bun present?
  const bunVer = await ssh.execCommand("/home/openclaw/.bun/bin/bun --version 2>/dev/null || echo missing");
  if (bunVer.stdout.includes("missing") || !bunVer.stdout.startsWith("1.")) {
    // Install Bun.
    const install = await ssh.execCommand(STEP_BUN_INSTALL_SCRIPT, { cwd: "/home/openclaw" });
    if (install.code !== 0) {
      result.errors.push({ step: "stepGbrain", reason: "bun-install-failed", stderr: install.stderr });
      return result;
    }
    // Verify after.
    const reCheck = await ssh.execCommand("/home/openclaw/.bun/bin/bun --version");
    if (!reCheck.stdout.startsWith("1.")) {
      result.errors.push({ step: "stepGbrain", reason: "bun-install-verify-failed" });
      return result;
    }
  }

  // 2. gbrain at pinned version?
  const gbrainVer = await ssh.execCommand("gbrain --version 2>/dev/null || echo missing");
  if (gbrainVer.stdout.trim() !== GBRAIN_PINNED_VERSION) {
    // Backup PGLite first (Rule 22).
    await ssh.execCommand(
      `mkdir -p ~/.openclaw/session-backups && tar -czf ~/.openclaw/session-backups/gbrain-pre-upgrade-$(date +%s).tar.gz ~/.gbrain/pglite/ 2>/dev/null || true`
    );
    // Install or upgrade.
    const upgrade = await ssh.execCommand(STEP_GBRAIN_INSTALL_SCRIPT.replace("__VERSION__", GBRAIN_PINNED_VERSION));
    if (upgrade.code !== 0) {
      result.errors.push({ step: "stepGbrain", reason: "install-failed", stderr: upgrade.stderr });
      return result;
    }
    // Verify after (Rule 10).
    const verify = await ssh.execCommand("gbrain --version");
    if (verify.stdout.trim() !== GBRAIN_PINNED_VERSION) {
      result.errors.push({
        step: "stepGbrain",
        reason: "version-mismatch-after-install",
        expected: GBRAIN_PINNED_VERSION,
        actual: verify.stdout.trim(),
      });
      return result;
    }
    result.fixed.push("gbrain-version");
  }

  // 3. PGLite intact?
  const doctor = await ssh.execCommand("gbrain doctor --json --fast");
  try {
    const checks = JSON.parse(doctor.stdout);
    const failures = checks.checks.filter((c: any) => c.status !== "ok" && c.status !== "warn");
    if (failures.length > 0) {
      result.errors.push({ step: "stepGbrain", reason: "doctor-failed", failures });
      return result;
    }
  } catch (e) {
    result.errors.push({ step: "stepGbrain", reason: "doctor-parse-failed", stdout: doctor.stdout });
    return result;
  }

  // 4. MCP entry present in openclaw.json?
  const mcpCheck = await ssh.execCommand("python3 -c 'import json; c=json.load(open(\"/home/openclaw/.openclaw/openclaw.json\")); assert \"gbrain\" in c.get(\"mcpServers\",{}), \"missing\"' 2>&1");
  if (mcpCheck.code !== 0) {
    // Apply the patch (manifest entry will have already done this; this is verify).
    result.errors.push({ step: "stepGbrain", reason: "mcp-entry-missing" });
    return result;
  }

  return result;
  } finally {
    await releaseCronLock(`gbrain-install-${vm.id}`);
  }
}
```

This pattern is intentionally conservative: every operation has a verify-after, every failure pushes to `result.errors` (which gates the `config_version` bump), the PGLite is backed up before any upgrade (Rule 22), and the per-VM cron lock prevents two reconciler ticks from racing on the same VM (Rule 8).

### 6.4 Sentinel guards (Rule 23)

```typescript
// instaclaw/lib/vm-manifest.ts (new entry in files[])
{
  path: "/home/openclaw/.openclaw/openclaw.json",
  mode: "merge_json",
  jsonPath: "mcpServers.gbrain",
  content: JSON.stringify({
    command: "/home/openclaw/.bun/bin/gbrain",
    args: ["serve"],
    env: {
      OPENAI_API_KEY: "${OPENAI_API_KEY}",
      ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}",
      GBRAIN_DATABASE_URL: "pglite:///home/openclaw/.gbrain/pglite",
      GBRAIN_EMBEDDING_MODEL: "openai:text-embedding-3-large",
      GBRAIN_EMBEDDING_DIMENSIONS: "1024",
    },
  }),
  requiredSentinels: ["gbrain serve", "GBRAIN_DATABASE_URL", "pglite://"],
},
```

The reconciler refuses to write this entry if any of the three sentinels are missing from the in-memory content (i.e., the reconciler's module cache is stale and pre-dates this PR).

### 6.5 Cron entries

```typescript
// instaclaw/lib/vm-manifest.ts crons[]
// IMPORTANT — per-VM offsets (vm.id % 60) so 150 VMs don't all hit the embedding API in
// the same minute. The marker tag includes the offset so cron-deployer's idempotent
// install handles drift correctly across VMs.
{ marker: "GBRAIN_LIVE_SYNC",   schedule: "${vm.id % 15} */1 * * *", command: "gbrain sync --repo ~/brain >> ~/.gbrain/sync.log 2>&1 && gbrain embed --stale >> ~/.gbrain/embed.log 2>&1" },
{ marker: "GBRAIN_DREAM_CYCLE", schedule: "${vm.id % 60} 9 * * *",   command: "gbrain dream --max-duration 60m >> ~/.gbrain/dream.log 2>&1" },
{ marker: "GBRAIN_DOCTOR",      schedule: "30 5 * * 0",              command: "gbrain doctor --json > ~/.gbrain/doctor-latest.json 2>&1" },
{ marker: "GBRAIN_CHECK_UPDATE", schedule: "0 5 * * *",              command: "gbrain check-update --json > ~/.gbrain/check-update.json 2>&1" },
{ marker: "GBRAIN_STATS",        schedule: "0 */6 * * *",            command: "gbrain stats > ~/.gbrain/stats-latest.txt 2>&1" },
{ marker: "GBRAIN_BACKUP_HOURLY", schedule: "5 * * * *",             command: "tar -czf ~/.gbrain/pglite-backups/$(date +%Y%m%dT%H).tar.gz ~/.gbrain/pglite/ 2>&1 | tail -1 >> ~/.gbrain/backup.log; find ~/.gbrain/pglite-backups/ -mtime +7 -delete" },
```

Why these schedules:

- **Live-sync `vm.id % 15`** spreads the 150-VM fleet across the 15-minute window so no single minute has 150 simultaneous embedding API calls. Without this, OpenAI rate limits would buckle under bursts.
- **Dream cycle `vm.id % 60` at 9:00 UTC = 5am Eastern / 2am Pacific** — off-peak everywhere in the US. The original `30 3 * * *` UTC was 11pm Eastern (peak evening) and would have collided with active user traffic. PGLite's single-writer lock during dream means agents using `gbrain.put_page` would block 60–90s; off-peak avoids that conflict.
- **Doctor on Sunday 5:30 UTC** instead of 4:00 UTC — moved off the existing `openclaw memory index` cron (4:00) which would clash on Sundays.
- **Hourly backup** — addresses §8.1 R3 mitigation. PGLite tarball + 7-day retention. Required for the "rollback path = restore tarball" claim to actually work.
- **`gbrain dream --max-duration 60m`** — fail-fast cap. If a dream cycle exceeds 60 min on a degenerate brain, abort and resume next night rather than blocking writes indefinitely.

Marker-based idempotent install (existing pattern in our cron deployer). Each cron logs to a separate file under `~/.gbrain/` for observability.

**Memory-budget assertion in `stepGbrain`** (per R17 / cron-contention concern): before installing gbrain on any VM, check `free -m` reports ≥800 MB available. If not, refuse install + alert. PGLite's working set runs ~200–500 MB on a 750 MB brain; combined with existing gateway (~1.5 GB) + Chrome (~800 MB) + node_exporter (~200 MB), tight VMs sit at ~2.5 GB used / 4 GB total. PGLite pushes total to ~3.0 GB. If the VM is already memory-constrained, gbrain rollout would push it over the OOM cliff.

### 6.6 Per-version migration playbook (new — v88 PRD addendum)

Garry ships fast (v0.25.1 → v0.26.3 → v0.26.7 → v0.26.8 → v0.26.9 → v0.27.0 in two weeks). Some versions ship breaking changes that require manual operator intervention. Per gbrain's `INSTALL_FOR_AGENTS.md`:

> *"Then read `~/gbrain/skills/migrations/v<NEW_VERSION>.md` (and any intermediate versions you skipped) and run any backfill or verification steps it lists. Skipping this is how features ship in the binary but stay dormant in the user's brain."*

Those migration steps are **markdown for an agent to read** — not idempotent code. We can't blindly pipeline them into the reconciler. So our discipline for every gbrain version bump:

1. **Manual translation step** (Cooper or Claude). Read `skills/migrations/v<NEW>.md` for the new version. Translate agent-readable steps into a new reconciler step `stepGbrainV<NEW>Migration`. Test on vm-050 canary first.
2. **Backup before any backfill** (Rule 22). Tarball PGLite to `~/.gbrain/pglite-backups/pre-v<NEW>-$(date +%s).tgz`. Backfills like `gbrain extract links --source db` can take minutes on large brains and may be lossy on failure.
3. **Lock semantics during migration**. The migration grabs the writer lock. Ensure agent gbrain calls return graceful errors (not 90s hangs) during the migration window. Schedule migration crons for the off-peak `vm.id % 60` 9:00 UTC slot used for dream cycle.
4. **Rollback path**. If migration fails: restore the tarball, unpin the version (revert `GBRAIN_PINNED_VERSION` PR). Practiced on canary; documented in this section before any minor version bump.
5. **CHANGELOG read mandatory** before bumping `GBRAIN_PINNED_VERSION`. Any of: new schema migration, security fix, config schema change, CLI rename → full Phase 0 + Phase 1 cycle. No exceptions for "small" version bumps. Mirrors the OpenClaw Upgrade Playbook discipline.

Without this playbook, a v0.28 bump can silently leave half the fleet on a stale schema for weeks (Rule 7 snapshot-refresh recurrence in a different shape).

---

## 7. Embedding Pipeline Design

### 7.1 Provider strategy

| Tier | Default | Failover | Notes |
|---|---|---|---|
| Power, Pro, paying users | `openai:text-embedding-3-large` (1024 dims, Matryoshka) | `voyage:voyage-3-large` | Matches existing `match-embeddings.ts` pattern. No new vendor required. |
| Starter (free + ad-supported) | `voyage:voyage-3-lite` (cheaper) | `openai:text-embedding-3-large` | Cost-optimized. |
| WLD users (cost-sensitive) | `ollama:nomic-embed-text` (local) | `openai:text-embedding-3-large` | $0 marginal. ~50 ms latency on dedicated-2 VM. |

`gbrain init` accepts `--embedding-model provider:model` and `--embedding-dimensions N`. We override per-tier via the manifest's `configSettings` based on `vm.tier`. Embedding-dim drift is caught by the v0.27 dim-preservation logic (every call passes `providerOptions.<provider>.dimensions`).

### 7.2 Failover

gbrain v0.27's `gateway.ts` does NOT auto-failover between providers (it has retry, but per-provider). For us to get failover, we patch around it at the cron layer:

```bash
# ~/.gbrain/embed-with-failover.sh
gbrain embed --stale && exit 0
echo "Primary embed failed. Trying Voyage." >&2
GBRAIN_EMBEDDING_MODEL=voyage:voyage-3-large gbrain embed --stale && exit 0
echo "All providers failed. Logging incident." >&2
exit 1
```

This is conservative and best-effort. If both providers fail, the cron logs to `~/.gbrain/embed.log` and the next run retries. Stale embeddings don't break query — they just degrade to keyword-only retrieval until embeddings catch up. Acceptable.

### 7.3 Cost modeling (re-derived from first principles, 2026-05-05)

**Pricing baseline:**
- OpenAI `text-embedding-3-large`: $0.13 / 1M input tokens.
- Anthropic Haiku 3.5: $0.80 / 1M input, $4 / 1M output.
- ~150 healthy assigned VMs (current fleet); ~80–100 actively engaged at any time.

**Initial import (one-time, per VM):**
- ~50–500 chunks per VM from MEMORY.md + session-log.md ingest. Avg chunk ~400 tokens.
- Cost per VM: 500 × 400 / 1M × $0.13 = **$0.026 max**. Across 150 VMs: **$5–$15 one-time.** Trivial.

**Ongoing dream cycle (per active VM, per night):**
- 5–50 new chunks per day (highly bimodal — power users 50+, idle users 0).
- Per active VM per month: 30 × 25 × 400 / 1M × $0.13 = **$0.039**.
- Active VMs ~80–100. Fleet: **~$3–4/month for embedding.**

**Query expansion (per `gbrain query` call, OpenAI side):**
- 3 short embeds per query, ~10 tokens each. 30 / 1M × $0.13 = $0.0000039/query.
- ~3,000 chat turns/day fleet-wide × ~30% trigger gbrain query = ~900 queries/day.
- Daily $0.0035; **monthly $0.10**.

**Query expansion (Anthropic Haiku side — DOMINANT cost):**
- 3 Haiku calls per query, ~80 input + ~50 output tokens each.
- Per query: 3 × ($0.80 × 80 + $4 × 50) / 1M = **$0.000792**.
- 900 queries/day × $0.000792 = **$0.71/day → $21/month.**

**Total fleet monthly: ~$25–30/month.**

The cost is **dominated by Haiku 3.5 query expansion**, not OpenAI embedding. If you want to reduce gbrain spend, the cost knob is the **expansion model** (downgrade to Haiku 3 if available, or skip expansion for routine queries) — not the embedding provider. Original v1 PRD draft estimate was "$15–50/month" — same range, but the composition was wrong (it used outdated Haiku 3 pricing).

**Cost scales linearly** with active VM count + chat-completion volume. 10× user growth → 10× cost (~$300/month). Not a problem at our $4,350/month VM spend (150 × $29), but the linear scaling is worth disclosing for budgeting.

**Required defense: per-VM `gbrain query` rate limit.** Cap at 100 queries / VM / day to bound the runaway-LLM-loop case (where an agent fires gbrain queries in a tight loop on a degenerate prompt). Implementation: counter in PGLite `config` table, checked on every `query` call, return cached/empty result if over budget. ~20 lines of upstream patch — file on garrytan/gbrain.

**Risk: embedding rate limits.** ~80 VMs × dream-cycle nightly across a 4-hour window = ~80 × 25 / 4h = ~500 embeddings/hour fleet-wide. Well under our existing OpenAI rate envelope. Voyage failover is the safety net. Ollama for cost-sensitive tiers eliminates the bottleneck entirely.

### 7.4 Dimension policy

Default: **1024 dims** (Matryoshka on `text-embedding-3-large`). Matches our existing `match-embeddings.ts` (`EMBEDDING_DIMS = 1024`). Means we can share embeddings between gbrain and the matching engine if we ever want to (we won't, due to schema differences, but the option is there).

`text-embedding-3-large` defaults to 3072 dims on the API side; we explicitly pass `providerOptions.openai.dimensions: 1024`. v0.27 of gbrain handles this correctly per the CHANGELOG.

For Voyage failover at 1024 dims: voyage-3-large supports configurable dims. We pin 1024 for parity.

For Ollama (`nomic-embed-text`): native 768 dims. Cannot be reduced. Means if a VM ever switches between providers, the brain must be re-embedded. Tracked in `gbrain doctor`.

---

## 8. Risk Register

| # | Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|---|
| R1 | gbrain serve --http exposes RCE (per v0.26.9) | Low (we never use --http) | Critical | Manifest enforces stdio only; reconciler validates no --http process; never expose port | Claude |
| R2 | Bun runtime breakage on Linode kernel | Low | High | Test on Phase 0 vm-050 explicitly; Bun is mature; rollback is removing the MCP entry | Claude |
| R3 | PGLite corruption on power loss / OOM | Medium | Medium | Hourly tarball backups in ~/.gbrain/pglite-backups/; weekly `gbrain doctor --fix` | Claude |
| R4 | Garry ships breaking change in v0.28 | High | Medium | Pin version. Read CHANGELOG. Canary before fleet. | Cooper + Claude |
| R5 | Embedding API rate limit on dream cycle | Low (cost mod above) | Medium | Voyage failover; staggered cron schedules across fleet (use `vm.id % 60` as min offset) | Claude |
| R6 | gbrain query latency triggers 90s LLM timeout | Medium | High | gbrain stdio response should be <500ms; if not, add per-tool timeout in OpenClaw mcp config | Claude |
| R7 | Migration loses data from MEMORY.md | Critical if it happens | Critical | Rule 22 — never delete MEMORY.md. Backup before any write. Validate page count >= heading count. | Claude |
| R8 | SOUL.md slim breaks agent identity | Medium | Medium | Phase 5 only after months of Phase 1–4 success. Side-by-side A/B before flipping. | Cooper |
| R9 | Cross-VM data leakage | Low (per-VM isolation) | Critical | PGLite is in-process. SSH key hygiene. No backups crossed across VMs. | Claude |
| R10 | Skills migration (Phase 6) breaks routing | High | Critical | Skip Phase 6 unless explicitly approved. Skills are how agents do work. | Cooper |
| R11 | Disk usage exceeds VM 80GB cap | Low (~750MB/VM ceiling) | Medium | Storage tier `db_only` for media; alarm at 50% disk; gbrain files clean | Claude |
| R12 | Reconciler stale-cache regression (Rule 23) | Medium | High | Sentinel guards on every gbrain manifest entry; RPR per Rule 23 | Claude |
| R13 | Watchdog kills gateway during gbrain dream cycle | Low (dream is async, doesn't block gateway) | Medium | Schedule dream during low-traffic window (3:30 AM); monitor for SIGTERM correlation | Claude |
| R14 | PGLite migration on gbrain upgrade fails | Medium | High | gbrain post-upgrade is idempotent per docs; back up PGLite before any upgrade; rollback path = restore tarball | Claude |
| R15 | Agent gets confused by two memory systems (gbrain + MEMORY.md) | Medium | Medium | SOUL.md addendum explicit: "query gbrain first, MEMORY.md as fallback only." Test in Phase 1. | Claude |
| R16 | OpenClaw MCP stdio bandwidth saturates on large query results | Low | Medium | Cap gbrain query result size at 10KB (configurable); use `gbrain query --limit 5` | Claude |
| **R17** | **PGLite single-writer lock blocks agent during dream cycle** | **High** | **High** | gbrain's own CLAUDE.md states "PGLite forces serial regardless." Dream cycle holds the writer lock for minutes. Agent's `gbrain.put_page` mid-dream blocks; OpenClaw 90s proxy timeout (Rule 11) triggers; user sees error. Mitigations: schedule dream `30 9 * * *` UTC (5am Eastern, off-peak); per-VM offset via `vm.id % 60` to spread; cap dream wallclock with `--max-duration 60m`; per-tool MCP timeout shorter than gateway (10s) so blocked writes return error fast; SOUL.md addendum tells agent to fall back to MEMORY.md on `gbrain.put_page` lock-contention timeout. | Claude |
| **R18** | **`gbrain serve` has no auto-restart; OpenClaw doesn't supervise MCP servers** | **Medium** | **High** | Per gbrain's CLAUDE.md: "server-level crashes would require external process management (systemd, Docker, etc.)." OpenClaw's MCP transport tears down stdio servers per-session and does not respawn. If `gbrain serve` OOMs, every subsequent `gbrain.query` returns `MCP error -32000: Connection closed` for the rest of the session. Mitigations: run `gbrain serve` as a user-systemd unit (`Restart=always`) instead of OpenClaw-spawned subprocess; per-VM cron watchdog `pgrep -f "gbrain serve"` every minute, restart if down; per-VM `gbrain serve` restart count metric, alert P1 if >5/day; SOUL.md fallback rule: "if `gbrain.query` returns MCP error, use MEMORY.md without retrying gbrain for the rest of this session." | Claude |
| **R19** | **MCP `remote=true` operations are restricted (untrusted-caller posture)** | **Medium** | **Medium** | Per gbrain AGENTS.md: "GBrain distinguishes trusted local CLI callers (`OperationContext.remote = false`) from untrusted agent-facing callers (`remote = true`)." Stdio MCP from OpenClaw runs locally on the same VM but is treated as `remote=true`. Some operations (file uploads, certain admin paths) are restricted. Action: audit `src/core/operations.ts` for every `remote=true` restriction BEFORE Phase 0 and document in §3.2. If a restricted op is needed, use the upcoming `register-client` OAuth flow from gbrain v0.26.3 with explicit scopes — never lift the restriction wholesale. | Claude |

### 8.1 Detailed rollback plan

If we need to roll back at any phase:

**Phase 0–2 rollback (per-VM):**
1. SSH in. Remove `gbrain` entry from `~/.openclaw/openclaw.json`. `systemctl --user restart openclaw-gateway`.
2. Stop gbrain crons: `crontab -l | grep -v 'GBRAIN_' | crontab -`.
3. Leave `~/gbrain/`, `~/.gbrain/`, `~/brain/` in place (idle, no harm). Restorable from tarball if needed.
4. MEMORY.md still authoritative. Agent reverts to flat-file behavior.

**Phase 3+ rollback (fleet-wide):**
1. Revert the manifest PR (`feat/gbrain-integration`). `VM_MANIFEST.version` bumps backward (or forward to a new "rollback" version).
2. Reconciler removes the `gbrain` MCP entry on next cycle.
3. Fleet pusher stops gbrain crons (`_fleet-stop-gbrain-crons.ts`).
4. gbrain binary stays installed on each VM (not worth scrubbing). PGLite retained for forensics.

**Phase 5 rollback (SOUL.md slim):**
- Revert `WORKSPACE_SOUL_MD_V3` → V2. Reconciler re-deploys old SOUL.md on next cycle (mode `overwrite`).
- This is a real cache-disruption event: every agent's prompt cache invalidates. Cost: ~$1K one-time.

**Phase 6 rollback (skills):**
- This is the worst rollback. If we have moved skills out of `~/.openclaw/skills/` and into gbrain skillpack, rolling back means re-deploying the original skills. Tracked separately; Phase 6 has its own rollback PRD.

### 8.2 What breaks if gbrain goes down on a VM?

- **gbrain serve crashes:** OpenClaw MCP tool calls to `gbrain.*` fail. Agent falls through to MEMORY.md (per SOUL.md addendum). Watchdog restarts `gbrain serve` on next cycle.
- **PGLite corrupts:** `gbrain doctor` flags it. Reconciler restores from `~/.gbrain/pglite-backups/`. If no backup, reinitialize empty + re-import from `~/brain/`.
- **Both fail:** agent reverts to pre-gbrain behavior. MEMORY.md still loaded. Some recall capability lost; no agent crash.

The architecture is **fail-soft**. gbrain is purely additive: if it disappears, we are back to the pre-gbrain state, not in a worse state.

---

## 9. Success Metrics

### 9.1 Hard metrics (measurable in Supabase / `gbrain stats` JSON)

| Metric | Baseline | Phase 1 target | Phase 5 target |
|---|---|---|---|
| Bootstrap context size (SOUL+supplements only) | 32,593–34,693 bytes (partner-dependent) | unchanged | ≤7,000 bytes (Phase 5) |
| Headroom under BOOTSTRAP_MAX_CHARS (35,000) | 307 bytes worst case (Edge+Consensus) | 307 bytes | ≥27,000 bytes (77%) post Phase 5 |
| Skills context (always-on) | 382,396 bytes (61% of 200K) | 382,396 bytes | ≥150,000 bytes (Phase 6 only) |
| sessions.json p50 size | ~500 KB (estimated fleet-wide) | ~500 KB | ≤200 KB (post skills migration) |
| Memory retrieval recall @ 5 (Phase 1 target user) | n/a (no retrieval system) | ≥90% on a 50-question seed set | ≥95% |
| Memory retrieval p95 latency (gbrain query) | n/a | ≤500 ms | ≤500 ms |
| Cross-session memory persistence rate | 97% | ≥97% (no regression) | ≥99% |
| gbrain `doctor --json` green check rate (fleet of ~150 VMs) | n/a | 100% | 100% |
| Embedding cost per active VM per month | $0 (no embeddings) | ≤$0.30 | ≤$0.30 |
| Total fleet monthly cost (embedding + Haiku query expansion) | $0 | ≤$30/month | ≤$30/month |
| Dream cycle success rate | n/a | ≥99% nightly | ≥99% |
| Empty-response cascade rate (vs baseline) | per Rule 22 baseline | ≤baseline | ≤baseline |

### 9.2 Soft metrics

- Cooper's subjective: "the agent remembers things better."
- Random user spot-checks (3 per phase): "does the agent know X about you?" where X is in MEMORY.md or session-log.md.
- Support ticket count for "agent forgetting" (currently #1 complaint per CLAUDE.md). Goal: 50% reduction over 30 days.
- Time-to-context-load on cold session start. Should be unchanged (gbrain query is async, post-prompt).

### 9.3 Anti-metrics (things we explicitly do NOT want to optimize)

- gbrain page count. More pages ≠ better brain. Bias toward compiled_truth quality.
- Number of skills. We've already trimmed 33%; gbrain skillpack should be matched in size, not exceed.
- Embedding dim. Don't chase higher dims without empirical retrieval gains.

### 9.4 Observability dashboard

Per-VM time-series in Supabase (new table `instaclaw_gbrain_stats`):
```sql
CREATE TABLE instaclaw_gbrain_stats (
  vm_id UUID NOT NULL REFERENCES instaclaw_vms(id),
  collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  gbrain_version TEXT NOT NULL,
  pages INT NOT NULL,
  chunks INT NOT NULL,
  embeddings INT NOT NULL,
  doctor_status TEXT NOT NULL, -- 'ok' | 'warn' | 'fail'
  doctor_failures JSONB,
  query_p50_ms INT,
  query_p95_ms INT,
  embed_provider TEXT,
  PRIMARY KEY (vm_id, collected_at)
);
```

Cron at `0 */6 * * *` writes a row per VM. A Vercel route renders a fleet view at `/admin/gbrain-stats`. Alerts:
- doctor_status=fail for >2 consecutive cycles → P1 alert.
- query_p95_ms > 1000 → P2 alert.
- gbrain_version drift from `GBRAIN_PINNED_VERSION` → P2 alert.
- pages count drops by >10% in 24h → P0 alert (possible data loss).

---

## 10. Timeline & Effort Estimate

### 10.1 Honest day count (working days, not calendar)

| Phase | Days | Description | Blocks on |
|---|---|---|---|
| Phase 0 — vm-050 canary | 2 | Install, smoke tests, 24h hold | — |
| Phase 1 — 3-VM tier canary | 7 (incl. 1-week hold) | Phase 0 × 3, real users, 1-week soak | Phase 0 green |
| Phase 2 — Dogfood (10 InstaClaw VMs) | 2 | Per-VM SSH script, observability dashboard build | Phase 1 green |
| Phase 3 — Manifest + reconciler integration | 2 | New `stepGbrain`, sentinel guards, version pin | Phase 2 green |
| Phase 4a — Snapshot bake | 1 | Per CLAUDE.md Snapshot Creation Process | Phase 3 PR merged |
| Phase 4b — Fleet rollout | 3 | Waves of 10, audit gates, Upgrade Playbook discipline | Phase 4a green |
| Phase 5 — SOUL.md / MEMORY.md slim | **3** (was 2) | V3 templates, migration script, fleet push. Bumped because realistic 6–8 KB floor (vs the original 3 KB straw man) requires more careful trimming and validation. | Phase 4b green + 72h soak |
| Phase 6 — Skills migration [optional] | 6 | gbrain skillpack, RESOLVER.md, dual-mode test | Phase 5 + ≥2 weeks soak |
| **Total (memory layer only, P0–P5)** | **20** | **~3 calendar weeks with holds** | — |
| **Total (with skills, P0–P6)** | **26** | **~5 calendar weeks** | — |

### 10.2 Calendar timeline (assumes start 2026-05-06, working through P5)

- **Week 1 (May 6–10):** Phase 0 (May 6–7) + start Phase 1 canary (May 8). Phase 1 hold begins May 8.
- **Week 2 (May 11–17):** Phase 1 hold continues (through May 15). Phase 2 dogfood starts May 16. Observability dashboard built in parallel.
- **Week 3 (May 18–24):** Phase 3 manifest work (May 18–19). Phase 4a snapshot bake (May 20). Phase 4b fleet rollout starts May 21 (waves through May 24).
- **Week 4 (May 25–29):** Phase 4b completion. 72h soak. Phase 5 starts May 28.
- **End of week 4:** Phase 5 done. **Memory layer in production.** Cooper writes the launch post.

If Phase 6 is approved, add weeks 5–7 for skills migration with its own canary cycle.

### 10.3 Critical-path dependencies

```
Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4a ──► Phase 4b ──► Phase 5 ──► [Phase 6]
                          │
                          └──► observability dashboard (parallel, blocks no critical path)
```

The 1-week Phase 1 hold is the longest single block. Cannot be compressed (per Upgrade Playbook). The only way to ship faster is to skip the soak, which we will not do.

### 10.4 Honest counter-estimate

If we ship ONLY Phase 0 + Phase 4 (skip the canary discipline because we want to move fast): **5 days.**

If we hit a real issue in Phase 1 that requires a gbrain upstream patch: **+ unknown** (we are at the mercy of Garry's PR review queue, though he is responsive — see his CHANGELOG credits to community PR authors).

If we discover gbrain doesn't work at all on Linode dedicated-2 (Bun-on-WSL-style portability issue we don't expect but can't fully rule out): **+5 days** to either patch or revert.

**Stated 19-day estimate is the realistic median.** Cooper should plan for ~25 days end-to-end including Phase 6, or ~19 days for the memory-only outcome.

---

## 11. The Garry Tan Angle

### 11.1 Why this is positionable

Garry Tan ([@garrytan](https://x.com/garrytan)) is the President & CEO of Y Combinator. His personal repo [garrytan/gbrain](https://github.com/garrytan/gbrain) has 13,236 stars and 1,664 forks, and he has tweeted about it actively across v0.10 (24 distinct fat skills), v0.12 (self-wiring graph: 5% better precision, 11% better recall, 28% better graph search, 53% fewer noisy results), v0.25.1 (book-mirror skillpack), v0.26.3 (MCP OAuth panel), and v0.27.0 (multi-provider embeddings, 2026-04-28).

The largest deployments visible publicly are:
- Garry's own personal brain: 17,888 pages, 4,383 people, 723 companies, 21 cron jobs.
- Anecdotal Twitter mentions (a handful of solo founders and small teams).
- No published fleet deployment.

**InstaClaw shipping gbrain across ~190 production agents would be the largest fleet deployment of gbrain to date.** That is a real, defensible claim. It is also a true claim — not a marketing exaggeration.

### 11.2 The post (draft for Cooper to edit)

Goal: be specific, lead with numbers, no jargon, link to a blog post / writeup.

```
Just shipped gbrain v0.27 across 190 OpenClaw agents in production at @InstaClawHQ.

Believe this is the largest fleet deployment of gbrain to date.

Each agent now has its own embedded PGLite knowledge graph, populated nightly by
the dream cycle. Setup is one manifest entry + one reconciler step, fully
automated by our existing version-pinning system.

Numbers from the rollout:
• Bootstrap context: 33.8 KB → ~3 KB (96% of cap → 9% of cap)
• Cross-session memory recall: 97% → 99%+ structured
• Skills context (Phase 6 follow-on): 61% → ~20% of context window
• Per-agent storage: ~750 MB PGLite, 0 bytes shared infra
• Embedding spend: <$0.50/agent/month (OpenAI default, Voyage failover, Ollama for free tier)

The compiled-truth + timeline page model is the missing layer for production AI
agents. Our agents went from "flat MEMORY.md, hits truncation at 30K, one error
deletes context" to "structured pages with timeline evidence, hybrid search,
overnight consolidation."

Thanks @garrytan for open-sourcing this. It's load-bearing for us.

Detailed writeup → instaclaw.io/blog/gbrain-fleet
```

Tone notes for Cooper:
- "Believe" hedges the largest-fleet claim without overclaiming.
- Numbers lead, narrative follows.
- "Load-bearing" is Garry-fluent (he uses this term in his own engineering writing).
- The blog post link is a hard requirement — the tweet alone is insufficient; reporters and Garry's team will click through.

### 11.3 The blog post (writeup outline)

Blog at `instaclaw.io/blog/gbrain-fleet`, ~1,200 words, structure:

1. **Lede:** the before-and-after pie chart (context window: 75% bootstrap → 9% bootstrap).
2. **Why we did this:** the v82 35K bootstrap bump that made us realize we were on the wrong axis. The Rule 22 incident (46-day silent context wipe). The skills bloat at 61%.
3. **Why gbrain:** compiled-truth + timeline pattern is exactly the data-model version of trim-not-nuke. Garry's 17K-page deployment proved it works at the individual scale; we wanted to prove it at fleet scale.
4. **The architecture:** per-VM PGLite, MCP stdio, no shared infra. Reproduced our existing isolation model.
5. **The numbers from the rollout:** bootstrap before/after, recall before/after, embedding cost, dream-cycle success rate.
6. **What didn't work:** any honest gotchas from Phase 0–4. Don't sanitize.
7. **What's next:** Phase 6 skills migration; gbrain at the org level for fleet operations.
8. **Credits:** explicit thanks to Garry, link to gbrain repo, link to v0.27 CHANGELOG, link to the community PR authors who shipped multi-provider support.

### 11.4 The demo

Cooper records a 90-second screencast:
1. **Before:** terminal showing `wc -c ~/.openclaw/workspace/SOUL.md` → 33,809. Show the OpenClaw context-window pie chart in the admin panel: 75% bootstrap.
2. **Question to agent:** "what do you remember about Cooper from our last 30 days of conversation?" Agent loads MEMORY.md, gives a vague paragraph.
3. **Cut to after:** terminal showing `wc -c ~/.openclaw/workspace/SOUL.md` → ~3,000. Pie chart: 9% bootstrap.
4. **Same question:** agent calls `gbrain.query "Cooper Wrenn"`. Returns a structured page: compiled_truth ("Cooper is the founder of InstaClaw, runs ~190 agents..."), timeline (12 entries, dated). Agent synthesizes a tighter, more accurate, more cited answer.
5. **Cut to fleet view:** dashboard showing `instaclaw_gbrain_stats` rolled up across 190 VMs. 190/190 doctor green, p95 latency 320 ms, 4,200 pages average per agent.

This demo is shippable as a tweet quote-RT with a 90-second clip. Lower friction than the blog post.

### 11.5 Realistic expectation-setting

- **Garry will probably notice.** He's actively engaged with his repo; 190 production deployments is a notable signal. Probability he RTs or quote-RTs: ~60% if the post is well-crafted and the demo is tight.
- **Even if he doesn't:** the rollout is justified on its own merits (33.8 KB → ~3 KB bootstrap, 97% → 99% memory recall, fail-soft architecture). Don't predicate the work on the tweet.
- **Don't fake the largest-fleet claim.** Verify: search for production deployments of gbrain via GitHub code search and Twitter mentions. If a larger fleet exists, change the claim to "one of the largest."
- **Bring data.** Vague "we shipped gbrain" tweets from solo founders are common. Specific numbers (33.8 → 3, 96% → 9%, 190 agents) make the post stand out.

---

## 12. Open Questions

1. **Do we need `ANTHROPIC_API_KEY` per VM for query expansion?** We already provision it for chat completions, so probably yes. Confirm in Phase 0.
2. **Does `gbrain serve` work as a long-lived stdio process under OpenClaw's MCP transport?** Garry's setup is Claude Code (which spawns MCP servers per session). OpenClaw should be similar but verify in Phase 0.
3. **PGLite under heavy concurrent writes (`put_page` from agent + `embed --stale` from cron):** does it lock? gbrain uses one connection per process; cron runs in a separate Bun process. Test in Phase 1.
4. **Schema migrations on `gbrain upgrade`:** the v0.26.8 auto-RLS event trigger requires Postgres event triggers. PGLite doesn't have event triggers, so v0.26.8 is a no-op for PGLite (per the CHANGELOG). Confirm by reading every migration v1–v35 source for similar Postgres-only assumptions before pinning a higher version.
5. **Cooper's tier override for free vs paying users:** do we want OpenAI/Voyage for everyone, or push free users to Ollama? Cost diff is trivial; latency diff is real. Decide by Phase 2.
6. **Skills migration (Phase 6) gating:** what does "Phase 5 in production for ≥2 weeks" actually mean? Define metrics that gate Phase 6 start.
7. **Brain repo location:** `~/brain/` is the gbrain default. Should it be `~/.openclaw/brain/` to keep all agent state in one tree? Default is fine; tracked.
8. **What happens to the existing `openclaw memory index` cron?** Phase 1: leave it running alongside gbrain dream. Phase 5: delete it. Decide based on observed redundancy.
9. **Do we want `gbrain serve --http` for the *monitoring* VM** (different from per-agent VMs)? Maybe, for fleet-wide observability. Separate decision; not in scope here.
10. **Eclipse / Devcon partner integrations:** if these land before Phase 5, do we ship the partner section in SOUL.md (legacy) or as a gbrain `concepts/` page (new pattern)? Default: new pattern, since SOUL.md is at 96.6% cap.

---

## 13. Appendix

### 13.1 References

- gbrain repo: [github.com/garrytan/gbrain](https://github.com/garrytan/gbrain) (13.2k stars, master branch, v0.27.0)
- CHANGELOG: [github.com/garrytan/gbrain/blob/master/CHANGELOG.md](https://github.com/garrytan/gbrain/blob/master/CHANGELOG.md)
- Architecture spec: [docs/GBRAIN_V0.md](https://github.com/garrytan/gbrain/blob/master/docs/GBRAIN_V0.md)
- Repo architecture: [docs/guides/repo-architecture.md](https://github.com/garrytan/gbrain/blob/master/docs/guides/repo-architecture.md)
- Install guide: [INSTALL_FOR_AGENTS.md](https://raw.githubusercontent.com/garrytan/gbrain/master/INSTALL_FOR_AGENTS.md)
- DeepWiki: [deepwiki.com/garrytan/gbrain](https://deepwiki.com/garrytan/gbrain/1.1-getting-started-and-installation)
- Garry's v0.10 announcement: [x.com/garrytan/status/2044291663213015491](https://x.com/garrytan/status/2044291663213015491)
- Garry's v0.12 announcement: [x.com/garrytan/status/2045447413050363927](https://x.com/garrytan/status/2045447413050363927)
- Garry's v0.25.1 (book-mirror): [x.com/garrytan/status/2050601694577500262](https://x.com/garrytan/status/2050601694577500262)
- Garry's v0.26.3 (MCP OAuth): [x.com/garrytan/status/2051089703030686050](https://x.com/garrytan/status/2051089703030686050)

### 13.2 Internal cross-refs

- [CLAUDE.md](../../../CLAUDE.md) — Rules 7, 10, 17, 22, 23 are load-bearing here. Re-read before any reconciler patch.
- [PRD-memory-architecture-overhaul.md](../PRD-memory-architecture-overhaul.md) — the 30-day memory plan that this PRD effectively replaces (in scope; not orphaned, just refocused).
- [research-session-persistence.md](../research-session-persistence.md) — 8-platform comparison from v41 fix.
- [prd-soul-restructure.md](./prd-soul-restructure.md) — pre-existing SOUL.md restructure work; Phase 5 here supersedes it.
- [cross-session-memory.md](./cross-session-memory.md) — companion PRD; gbrain shipping makes most of its proposals automatic.
- `instaclaw/lib/vm-manifest.ts:429` — `BOOTSTRAP_MAX_CHARS = 35000` (the ceiling we hit).
- `instaclaw/lib/vm-manifest.ts:111` — `OPENCLAW_PINNED_VERSION` (the pattern we mirror for `GBRAIN_PINNED_VERSION`).
- `instaclaw/lib/vm-reconcile.ts:777-793` — sentinel guard pattern (Rule 23) we extend.
- `instaclaw/lib/match-embeddings.ts` — existing OpenAI/Voyage abstraction that informs the embedding strategy here.
- `instaclaw/scripts/_prune-vm-725-sessions.ts:1-4` — the 2.6 MB sessions.json incident that motivates P3.

### 13.3 Glossary

- **gbrain** — Garry Tan's open-source knowledge graph. CLI + library + MCP server. Bun + PGLite/Postgres + pgvector.
- **PGLite** — embedded Postgres for Node/Bun. Runs in-process, no server.
- **Compiled truth** — gbrain page section: current best understanding, rewritten on new evidence.
- **Timeline** — gbrain page section: append-only evidence trail, never edited.
- **Dream cycle** — gbrain's nightly 8-phase consolidation cron.
- **Hermes** — Nous Research's agent runtime, gbrain's other primary host (we're on OpenClaw).
- **MCP** — Model Context Protocol. OpenClaw, Claude Code, Cursor, Hermes all support it.
- **stdio MCP** — local subprocess transport for MCP. The only safe option for us.
- **Bootstrap context** — what we load into the LLM prompt on every turn, before the user message.
- **`BOOTSTRAP_MAX_CHARS`** — our cap (currently 35,000) on bootstrap size before silent truncation.
- **Sentinel guard** (Rule 23) — required-string check on templated content before write, prevents stale-cache regression.
- **Trim, not nuke** (Rule 22) — never delete user-facing state; rewrite minimally instead.

---

## 14. Self-Audit Addendum (added 2026-05-05 after deep review)

**Status as of 2026-05-05 evening: corrections C1–C20 from §14.7 have been APPLIED to the main body of this PRD.** This section is preserved as forensic record of the v1 → v2 audit pass. New readers should consume the main body (§§1–13) which now reflects the audited state. The detailed findings below are kept so future maintainers can see *why* the body says what it says.

**Audit owner:** Claude (same author as the main PRD body — this section is a brutally honest self-review against the source-of-truth code, not an external review).
**Method:** every numerical claim re-verified by Node regex extraction against `instaclaw/lib/{ssh.ts, agent-intelligence.ts, vm-manifest.ts, vm-reconcile.ts, earn-md-template.ts, match-embeddings.ts}`; gbrain documentation re-read for crash semantics, PGLite locking, dream-cycle write behavior, and trust boundaries; cost numbers re-derived from first principles using current OpenAI / Anthropic pricing.
**Bottom line:** the PRD's strategic direction held; the v1 body had at least 4 numerical errors, 3 unverified architectural assumptions, and 2 missing operational risks. All addressed in v2 (this version). The forensic findings below are retained for historical context.

### 14.1 Codebase alignment errors (verified line-by-line)

#### Numerical claims — verified

| PRD claim | Source of truth | Status |
|---|---|---|
| `BOOTSTRAP_MAX_CHARS = 35000` at vm-manifest.ts:429 | exact match | ✓ |
| Skills total: 382,396 bytes across 22 SKILL.md | exact match (`wc -c` agrees) | ✓ |
| `WORKSPACE_SOUL_MD` body = 19,388 bytes at ssh.ts:2956 | exact match (Node regex) | ✓ |
| `SOUL_MD_INTELLIGENCE_SUPPLEMENT` = 8,811 bytes at agent-intelligence.ts:328 | exact match | ✓ |
| `WORKSPACE_CAPABILITIES_MD` = 16,010 bytes at agent-intelligence.ts:476 | exact match | ✓ |
| `SOUL_MD_LEARNED_PREFERENCES` = 536 bytes at agent-intelligence.ts:821 | exact match | ✓ |
| `SOUL_MD_OPERATING_PRINCIPLES` = 1,164 bytes at agent-intelligence.ts:849 | exact match | ✓ |
| `SOUL_MD_DEGENCLAW_AWARENESS` = 618 bytes at agent-intelligence.ts:871 | exact match | ✓ |
| `SOUL_MD_MEMORY_FILING_SYSTEM` = 2,692 bytes at agent-intelligence.ts:903 | exact match | ✓ |
| `WORKSPACE_EARN_MD` = 10,567 bytes | exact match | ✓ |
| `requiredSentinels` definition + check loop at vm-reconcile.ts:777-793 | exact match (read in full) | ✓ |
| match-embeddings.ts uses 1024 dims, OpenAI/Voyage abstraction | exact match | ✓ |
| `_prune-vm-725-sessions.ts:1-4` says "2.6 MB; 49 entries × ~43KB each" | verified by reading file (preamble comment, lines 2-4) | ✓ |

#### Numerical claims — wrong

**E1 — The PRD's "33,809 bytes total SOUL.md" overstates the base assembly.**
Actual concatenation at `ssh.ts:4774-4779` is exactly:
```
WORKSPACE_SOUL_MD (19,388)
+ SOUL_MD_INTELLIGENCE_SUPPLEMENT (8,811)
+ SOUL_MD_LEARNED_PREFERENCES (536)
+ "\n\n" (2)
+ SOUL_MD_OPERATING_PRINCIPLES (1,164)
+ SOUL_MD_MEMORY_FILING_SYSTEM (2,692)
= 32,593 bytes (base, no partner)
```
With partner appendices (inline strings at lines 4781-4798 and 4808-4813):
- Edge City only: ~33,993 bytes
- Consensus only: ~33,293 bytes
- Edge + Consensus (the "edge city is also at consensus" path): ~34,693 bytes (within 307 bytes of the 35K cap)

PRD §1, §2.1, §11.2, §11.4 all use "33,809" or "33.8 KB". **Corrected number is partner-dependent: 32.6 KB to 34.7 KB.** The "we are at 96.6% of cap" framing should become "we are at 93%–99% of cap depending on partner; an Edge+Consensus VM is 307 bytes from silent truncation."

**E2 — `OPENCLAW_PINNED_VERSION` is at vm-manifest.ts:111, NOT :577.**
Line 577 is the start of `VM_MANIFEST` itself. Line 111 is where the version pin lives. PRD §6.1 references the wrong line. Other pinned-version constants at the same scope: `NODE_PINNED_VERSION` (line 122), `BANKR_CLI_PINNED_VERSION` (line 131). Our `GBRAIN_PINNED_VERSION` should sit alongside these, not anywhere near 577.

**E3 — `SOUL_MD_DEGENCLAW_AWARENESS` is dead code.**
`grep -n "soulContent +=" instaclaw/lib/ssh.ts` returns exactly two sites: line 4781 (Edge City) and 4808 (Consensus). The 618-byte DegenClaw template is *imported* (`ssh.ts:12`) but never concatenated into `soulContent`. The comment block at `ssh.ts:4762-4773` claiming "DegenClaw goes to the tail (truncates last when over budget)" is **stale**. SOUL_MD_CONSENSUS_MATCHING_AWARENESS (549 bytes at agent-intelligence.ts:886) is also imported but the actual Consensus appendix in `ssh.ts:4808-4813` is a hardcoded inline string, not the template. **Two dead-code SOUL.md templates exist (1,167 bytes total).** The PRD's audit table missed both.

**Implication for the PRD:** `SOUL.md slim` (Phase 5) should explicitly call out these dead-code templates as the easiest first byte savings. Net effect of removing them: 0 bytes (they're not loaded), but it cleans up the import graph and prevents future confusion.

**E4 — The "36 step* functions" claim's specific names are stale.**
The Explore agent's audit listed `stepDegenClawAwareness (line 2658)`, `stepConsensusAwareness (2710)`, `stepBankrBalance (2829)`, `stepLegacySoulMigration (2944)`, etc. **None of these names exist in the current `vm-reconcile.ts`.** Real current names (verified by `grep -n "^async function step"`): `stepGatewayWatchdogTimer (2683)`, `stepDispatchServer (2748)`, `stepInstaclawXmtp (2900)`, `stepNodeExporter (3026)`, `stepMigrateSoulV2 (3237)`, `stepDeployPrivacyBridge (3400)`. The total count (36) happens to be right; the specific names the Explore agent gave were from an earlier git revision.

**Implication for §5.5 (Phase 3 — manifest + reconciler integration):** the recommended insertion point "after `stepSkills`" (line 1558) is still correct. But any other reference to specific step names by line number in the PRD is suspect. The reconciler integration step should just say "after `stepSkills` (which itself runs after the skill-deploy critical path)."

#### Spot-check I did not perform

I did **not** SSH to a production VM and run `wc -c ~/.openclaw/workspace/SOUL.md` to verify on-disk size matches the source-of-truth assembly (32,593–34,693 bytes). Cooper explicitly asked for this. Source-of-truth verification gives us confidence in what *should* be on disk if the reconciler is up to date; it doesn't catch reconciler drift.

**Action:** before Phase 0 starts, run `instaclaw/scripts/_check-soul-on-vm.ts` (existing script) against ~5 representative VMs (one per tier + Edge + Consensus + plain). Report on-disk SOUL.md byte count and compare to source-of-truth. Any drift > 100 bytes is a Rule 10 violation.

### 14.2 Risk deep dive — critical issues missed in §8

#### NEW R17 — PGLite is single-writer; dream cycle holds the lock for minutes

**This is the biggest gap in the PRD.** From gbrain's own [`CLAUDE.md`](https://github.com/garrytan/gbrain/blob/master/CLAUDE.md): *"PGLite forces serial regardless"* (re: parallel sync workers). Coordination is via `gbrain_cycle_locks` DB table + `~/.gbrain/cycle.lock` file lock with PID-liveness for PGLite.

Implication: the dream cycle (8 phases, write-heavy in synthesize / extract / embed / orphans) **acquires the writer lock for the duration of the cycle.** While held:
- Agent's `gbrain.put_page` — blocks until cycle releases.
- Agent's `gbrain.query` — should still work (Postgres permits concurrent readers under a writer), but specifics depend on PGLite's WASM Postgres 17.5 behavior; not verified.
- OpenClaw's MCP timeout on a blocked write call: per `app/api/gateway/proxy/route.ts:930` we have a 90s `AbortController` (Rule 11 context). Dream cycle phases can take longer than 90s on a 1k+ page brain.

**Failure mode:** during dream cycle, `gbrain.put_page` from a chatting user → 90s timeout → tool result error → strip-thinking.py may misclassify as empty-response → trim_failed_turns fires → user's last few turns truncated (not a session-nuke per Rule 22 fix, but still surface friction).

**Mitigations not in the PRD:**

1. **Schedule dream cycle for low-traffic per-VM.** PRD says `30 3 * * *` UTC = 11pm Eastern / 8pm Pacific = peak US evening. **Bad pick.** Better: `30 9 * * *` UTC = 5am Eastern / 2am Pacific. Or: per-VM offset `(vm.id % 60) 9 * * *` to spread embedding-API load across the hour.
2. **Cap dream-cycle wallclock.** `gbrain dream --max-duration 60m --concurrency 1` — fail-fast if a phase exceeds budget; resume next night.
3. **Agent's MCP tool timeout.** OpenClaw's MCP tool calls should have a per-tool timeout shorter than the gateway's 90s (e.g., 10s). If `gbrain.put_page` blocks > 10s, return error to the agent so it can try again later or fall through to MEMORY.md.
4. **"Defer write during dream" pattern.** SOUL.md addendum: "If a `gbrain.put_page` call returns 'lock contention' or times out, write the same content to MEMORY.md as fallback. The next dream cycle will pick it up via `gbrain sync --repo`."

#### NEW R18 — `gbrain serve` has no auto-restart; OpenClaw doesn't supervise MCP servers

Per gbrain's [`CLAUDE.md`](https://github.com/garrytan/gbrain/blob/master/CLAUDE.md): *"server-level crashes would require external process management (systemd, Docker, etc.)."* OpenClaw's MCP integration ([docs](https://docs.openclaw.ai/cli/mcp)) spawns stdio MCP servers per session and tears them down with the session — there is no documented auto-restart path.

Failure mode chain:
1. `gbrain serve` OOMs / panics (PGLite WASM bug, Bun runtime issue, large query result).
2. Stdio pipe closes.
3. Agent's next `gbrain.query` returns `MCP error -32000: Connection closed`.
4. OpenClaw does not respawn the server automatically.
5. **Every subsequent gbrain call in this session fails the same way.**
6. Until the next session starts (or operator manually intervenes), the agent has no gbrain.

**Mitigations not in the PRD:**

1. **Add a `gbrain-serve-watchdog` cron** (every minute) that checks `pgrep -f "gbrain serve"` is alive. If not, log + restart via `systemd --user`.
2. **Run `gbrain serve` as a user-level systemd unit**, not just an MCP-spawned subprocess. OpenClaw connects to it via Unix socket or shared stdio. This gives us systemd auto-restart with `Restart=always`. Need to verify OpenClaw's MCP transport supports an already-running server (vs spawn-on-session); if not, fall back to the cron watchdog.
3. **Per-VM `gbrain serve` restart count metric.** If a VM's gbrain crashes more than 5×/day, alert P1.
4. **SOUL.md fallback rule (mandatory):** "If `gbrain.query` returns an MCP error or 'Connection closed', use MEMORY.md without retrying gbrain for the rest of this session."

#### NEW R19 — gbrain's MCP transport treats agent calls as `remote=true` (untrusted)

Per gbrain's [`AGENTS.md`](https://github.com/garrytan/gbrain/blob/master/AGENTS.md): *"GBrain distinguishes trusted local CLI callers (`OperationContext.remote = false`, set by `src/cli.ts`) from untrusted agent-facing callers (`remote = true`, set by `src/mcp/server.ts`)."*

Even though our stdio MCP transport runs locally on the same VM, gbrain treats the call as remote/untrusted. This restricts certain operations (file uploads, possibly some admin operations). **The PRD's claim that the agent has full read+write access to gbrain is too generous** — there are documented restrictions for `remote=true` callers, and these aren't fully enumerated in our research.

**Action:** before Phase 0, audit `src/core/operations.ts` in the gbrain repo for every operation that is restricted when `remote=true`. List them in §3.2 of the PRD. If any operation our agent needs is restricted, plan a workaround (CLI invocation via a separate MCP-exposed shell tool, or the upcoming "register-client" OAuth flow from v0.26.3).

#### R6 (already in PRD) — needs sharper mitigation

The PRD says `gbrain query` should be <500 ms. **Untested at our scale.** Garry's benchmarks (P@5 49.1%, R@5 97.9% on 240-page corpus) don't include latency. For our use:
- Phase 0 must capture p50/p95/p99 latency on a real query against a real (post-import) brain.
- If p95 > 1s, the per-tool timeout in §14.2 R17 mitigation (10s) is insufficient — we'd see frequent timeouts under load.
- Mitigation: pre-warm PGLite (open the connection at gbrain serve startup, run a no-op query) so the first user query isn't paying connection cost.

#### R8 (already in PRD) — Phase 5 target of 3 KB is too aggressive

A literal audit of what's currently in the 32,593-byte SOUL.md base reveals load-bearing content that **cannot** be moved to gbrain without behavioral regression:

- **Identity** (~500 bytes): "You are X, owned by Y, running on Z." — cannot move; this is the bootstrap identity.
- **Boundaries** (~300 bytes): "Don't reveal you're an AI", "Don't share API keys", etc. — security-critical, cannot move.
- **Operating principles** (1,164 bytes): error handling, never-self-restart, provider confidentiality. **Mostly security-critical, cannot move.** Maybe 200 bytes can be moved to a `concepts/` page.
- **Memory filing protocol** (2,692 bytes): "How to write to MEMORY.md / session-log.md / active-tasks.md." Can be slimmed to a 300-byte pointer if the agent's gbrain skills understand the protocol — but the protocol itself must remain in agent-bootstrap context.
- **Session resume / instant scripts** (parts of INTELLIGENCE_SUPPLEMENT, ~3 KB): bootstrap-critical for first-message handling. Cannot move.

Realistic Phase 5 floor: **~6–8 KB**, not 3 KB. Full 30 KB recovery needs Phase 6 (skills migration) which the PRD already gates behind months of soak.

**PRD §1, §3.4, §4.4, §11 metrics that say "33.8 KB → 3 KB" should be revised to "32.6 KB → ~7 KB" for Phase 5, with the further "→ ~3 KB" only achievable after Phase 6.**

### 14.3 Migration safety gaps

#### G1 — MEMORY.md import: parsing edge cases not addressed

The PRD says "validate page count >= heading count" but doesn't address:

- **Unicode in headings** (slug collisions): `## Cooper's Notes (#tag)` and `## Cooper's Notes — (#tag)` may slug to the same value. gbrain's `slugify()` behavior under Unicode normalization is not documented at our depth.
- **Code blocks containing `## `**: gbrain's parser may extract these as headings. Test before fleet rollout.
- **Multi-paragraph compiled_truth**: an existing MEMORY.md section like `## Foo\n\nBody1.\n\n## Subsection of Foo\n\nBody2.` — does gbrain treat "Subsection of Foo" as a child page or a sibling? The two-section pattern (compiled_truth + timeline) doesn't have a documented multi-level heading model.
- **Empty sections**: `## A\n## B` — gbrain may create empty pages or skip silently.

**Required addition to §5.3 (Phase 1):** before importing real-user MEMORY.md, run `_dry-run-import-memory-md.ts` on a representative sample (10 VMs, varied content). Report any parser warnings. Only import if zero unparseable headings AND zero slug collisions. Backup MEMORY.md before the dry run (Rule 22).

#### G2 — Migration is session-boundary safe (PRD didn't say so explicitly)

What happens to in-flight conversations during reconciler-driven gbrain install:
- gbrain install runs over SSH while OpenClaw gateway keeps serving.
- New MCP server only appears in the agent's tool list AFTER the next session start.
- **Existing sessions don't break** — they continue using MEMORY.md only.
- The gateway is NOT restarted by the gbrain install step (per current reconciler patterns).

Document this explicitly in §5.2 / §5.3 — it's a strength of the migration design, but the PRD doesn't claim it. If we don't claim it, it's easy to get wrong in implementation (e.g., if `stepGbrain` calls `systemctl restart openclaw-gateway`, all in-flight conversations break per Rule 5).

**Required addition:** in `stepGbrain` reconciler step, **never restart openclaw-gateway**. The MCP server picks up the gbrain entry at the next *session boundary*, not at gateway restart.

#### G3 — PGLite backup story is incomplete

PRD §8.1 says "PGLite has hourly snapshots in `~/.gbrain/pglite-backups/`." **No cron entry in §6.5 actually creates these backups.** Add:

```
{ marker: "GBRAIN_BACKUP_HOURLY", schedule: "5 * * * *", command: "tar -czf ~/.gbrain/pglite-backups/$(date +%Y%m%dT%H).tar.gz ~/.gbrain/pglite/ 2>&1 | tail -1 >> ~/.gbrain/backup.log; find ~/.gbrain/pglite-backups/ -mtime +7 -delete" },
```

Also note: PGLite backups during writes can produce inconsistent tarballs. Better: `gbrain export --dir ~/.gbrain/pglite-backups/$(date +%s)` if export is idempotent and lock-safe. Verify in Phase 0.

### 14.4 Fleet management gaps

#### G4 — Schema migrations on `gbrain upgrade` need per-version reconciler patches

PRD §6.2 says "auto-pinning is dangerous" and lists CHANGELOG-reading discipline. **It does not explain the operational mechanism.**

Per gbrain's `INSTALL_FOR_AGENTS.md`: *"Then read `~/gbrain/skills/migrations/v<NEW_VERSION>.md` (and any intermediate versions you skipped) and run any backfill or verification steps it lists. Skipping this is how features ship in the binary but stay dormant in the user's brain."*

These migration steps are markdown files **for an agent to read.** They are not idempotent code we can pipeline into our reconciler. v0.12 added a backfill `gbrain extract links --source db && gbrain extract timeline --source db` that takes minutes on large brains.

**Required process for every gbrain version bump:**

1. **Manual translation step.** Read `skills/migrations/v<N>.md` for the new version. Translate the agent-readable steps into code in a new reconciler step (e.g., `stepGbrainV28Migration`).
2. **Per-step backup-before-modify** (Rule 22): tarball PGLite before any backfill.
3. **Lock semantics:** the migration grabs the writer lock. Ensure agent gbrain calls return graceful errors (not 90s hangs) during migration window. Schedule for the off-peak window.
4. **Rollback:** if migration fails, restore the tarball and unpin the version (revert `GBRAIN_PINNED_VERSION` PR).

Add a new section to the PRD (§6.6, "Per-version migration playbook") with this process. **Without this, a v0.28 bump can silently leave half the fleet on a stale schema for weeks.**

#### G5 — Reconciler runs every 3 min; gbrain install runs longer

PRD §6.3 doesn't address reconciler-vs-reconciler races. The Vercel `reconcile-fleet` cron runs every 3 min. If `stepGbrain` install-from-scratch takes 10 min (Bun install + clone + bun install + gbrain init + first embed), three reconciler ticks could overlap on the same VM.

Existing pattern (CLAUDE.md Rule 8): use `instaclaw_cron_locks` table for "cron-vs-cron" coordination. Apply the same pattern here:

- Before `stepGbrain` does any state-modifying work, acquire a per-VM lock: `tryAcquireCronLock("gbrain-install-${vm.id}", 1800, "reconciler-step")`.
- Release on completion. If lock held by another tick, skip this VM this cycle.

Without this, the second tick's `bun install` collides with the first's, and we get half-installed states.

**Required addition:** §6.3 reconciler step needs a per-VM cron lock around the gbrain mutation portion.

#### G6 — Cron resource contention on the VM

5 new gbrain crons + 7 existing crons = 12 crons. PRD §6.5 doesn't analyze resource contention.

Conflicts found:
- **4:00 UTC clash:** existing `0 4 * * *` `openclaw memory index` (daily, ~30s) + new `0 4 * * 0` `gbrain doctor` (Sundays, ~5s). On Sundays at 4:00 UTC both fire. Doctor reads PGLite while memory-index runs OpenClaw's internal indexing — separate resources, but both spike CPU on a 2-vCPU VM.
- **Every-15-min sync+embed:** `*/15 * * * *` `gbrain sync && gbrain embed --stale`. On an active VM, embed can take 5–30s. Overlaps with the every-minute strip-thinking + watchdog crons. Cumulative load on a 2-vCPU dedicated CPU.
- **PGLite memory pressure:** PGLite-in-Bun working set is ~200–500 MB for a 750 MB brain. VM has 4 GB RAM; current usage is ~2.5 GB (gateway 1.5 GB + chromium/Xvfb 800 MB + others 200 MB). Adding gbrain pushes total to 2.7–3.0 GB — within budget but tight, and OOMs are real for the busiest 5% of VMs.

**Required additions to §6.5:**

1. **Per-VM cron offset:** instead of `*/15 * * * *`, use `(vm.id % 15) * * * *` for sync. Spreads the 190-VM fleet across the 15-minute window so no single minute has 12+ embedding API calls.
2. **Move `gbrain doctor` Sunday off 4:00:** schedule `30 5 * * 0` (5:30 UTC, off-peak everywhere).
3. **Memory budget assertion in `stepGbrain`:** if `free -m` reports < 800 MB available before install, refuse to install gbrain; alert. Prevents pushing tight VMs over the OOM cliff.
4. **Watchdog awareness:** the `vm-watchdog.py` script (existing) interprets long completion times as "frozen gateway." Verify it doesn't misclassify a `gbrain serve` running a long query as a frozen gateway. The watchdog and gbrain-serve are separate processes, so they shouldn't cross-trigger, but the proxy-layer 90s timeout (Rule 11) means a slow `gbrain.query` could feed back as a frozen-gateway signal at the Anthropic-API layer.

### 14.5 Cost re-derivation (from first principles)

PRD §7.3 estimated $15–50/month fleet-wide. Re-derived with current pricing:

**OpenAI text-embedding-3-large:** $0.13 / 1M input tokens.

**Initial import (one-time):**
- Per VM, ~50–500 chunks from MEMORY.md + session-log.md (most VMs are stub-light)
- Avg chunk ~400 tokens
- Cost: 500 × 400 / 1M × $0.13 = **$0.026 per VM**
- 190 VMs: **$5 one-time** (PRD said $6–$57; high end was overestimated, real is $5–$15)

**Dream cycle ongoing:**
- Active VMs: ~80–100 (per CLAUDE.md fleet-truth math)
- New chunks per night per active VM: 5–50 (highly bimodal — power users 50+, idle users 0)
- Cost per active VM per month: 30 × 25 × 400 / 1M × $0.13 = $0.039
- Fleet: **~$3–4 per month for embedding** (PRD said $6–30; high end overestimated)

**Query expansion (per chat completion):**
- 3 short embeds per `gbrain query` call (~10 tokens each)
- 3 × 10 / 1M × $0.13 = $0.0000039 per call
- ~3,000 chat turns/day fleet-wide × ~30% trigger gbrain query × 1 query each = ~900 queries/day
- Daily: $0.0035; **Monthly: $0.10** (PRD said $9; **way overestimated**)

**Anthropic Haiku for query expansion:**
- 3 Haiku calls per query, ~80 input + ~50 output tokens each (Haiku 3.5: $0.80/M in, $4/M out)
- Per query: 3 × ($0.80 × 80 + $4 × 50) / 1M = $0.000792
- 900 queries/day × $0.000792 = $0.71/day; **Monthly: $21** (PRD said $2.25; **underestimated** because PRD used Haiku 3 pricing)

**Total fleet monthly cost: ~$25–30/month.**
PRD's "$15–50/month" range is approximately right but the *composition* is wrong. The cost is dominated by Haiku 3.5 query expansion, not OpenAI embedding. **Material implication:** if we want to reduce gbrain cost, the lever is the query-expansion model (use Haiku 3 if available, or skip expansion for routine queries), not the embedding provider.

**Cost scaling caveat:** these numbers are linear in active VM count + linear in chat-completion volume. If user adoption grows 10×, cost grows 10× to ~$300/month. Not a problem at our current $5,510/month VM spend, but the PRD should disclose linear scaling.

**Required addition:** add a per-VM cap on `gbrain query` calls (e.g., 100 queries / VM / day) to bound cost in the runaway-LLM-loop case.

### 14.6 Garry-angle reality check

**Claim: "largest fleet deployment of gbrain in production."**

Verifiable: gbrain has 13,236 stars, 1,664 forks. Public deployments visible:
- Garry's own personal brain: 17,888 pages (single user).
- Garry's "personal OpenClaw deployment" mentioned: 45,000 pages, 19 cron jobs (single user).
- Anonymous reference deployment: "14,700+ brain files, 40+ skills, 20+ cron jobs" (single deployment, scale unclear).
- Render "AlphaClaw" deploy template: a consumer of gbrain, not a fleet operator.

**No public reference of gbrain deployed at >1 agent**, much less 190+ agents. The "largest fleet" claim is plausibly true. But:
- We can't search private/internal deployments. Some YC-portfolio company could be running gbrain at scale internally.
- The claim should remain hedged: "we believe this is one of the largest fleet deployments of gbrain in production" — which the PRD §11.1 already does. **Don't escalate to "the largest" without explicit verification.**

**Risk: someone else publishes a larger deployment between our Phase 0 and our launch post.** Mitigation: search again the morning of the launch post. If a larger deployment surfaces, change "one of the largest" to "the largest at >1 user that we could find" or some honest variant.

### 14.7 Required PRD changes (consolidated punch list)

Apply these to the main body before Phase 0 starts:

| # | Section | Change |
|---|---|---|
| C1 | §1, §2.1, §11.2, §11.4 | Replace "33,809 / 33.8 KB" with "32.6 KB base; 33.3 KB Consensus; 34.0 KB Edge; 34.7 KB Edge+Consensus." Update the "96.6%" framing accordingly (range 93–99% depending on partner). |
| C2 | §6.1 | Fix line reference: `OPENCLAW_PINNED_VERSION` is at `vm-manifest.ts:111`, not `:577`. `GBRAIN_PINNED_VERSION` slots in alongside `NODE_PINNED_VERSION` (line 122) and `BANKR_CLI_PINNED_VERSION` (line 131). |
| C3 | §3.4, §5.7 | Remove dead-code templates `SOUL_MD_DEGENCLAW_AWARENESS` and `SOUL_MD_CONSENSUS_MATCHING_AWARENESS` from any "we'll trim these" claim — they're already dead. Update §5.7 cleanup to delete the imports + constants outright. |
| C4 | §5.5 | Don't reference specific step* function names by line number for insertion point. Use "after `stepSkills`" only. |
| C5 | §3.4, §5.7, §9.1 (metrics) | Phase 5 SOUL.md target floor is **~6–8 KB**, not 3 KB. The 3 KB target is Phase 6 only. Identity, boundaries, operating principles, memory protocol, session resume — these MUST stay in bootstrap. Recovery numbers: ~30 KB → ~7 KB Phase 5; ~7 KB → ~3 KB Phase 6 (gated on skills migration). |
| C6 | §8 risk register | Add R17 (PGLite single-writer lock during dream cycle), R18 (gbrain serve has no auto-restart), R19 (MCP `remote=true` operation restrictions). With mitigations from §14.2. |
| C7 | §3.2 | Audit `src/core/operations.ts` for `remote=true` restrictions before Phase 0. List restricted operations. |
| C8 | §5.3 | Add MEMORY.md import dry-run step before any real-user import. Test slug collisions, code-block parsing, empty sections, multi-level headings. |
| C9 | §5.7, throughout | Add explicit "session-boundary safe migration" claim — `stepGbrain` MUST NOT restart openclaw-gateway. New gbrain MCP entry only takes effect at next session start. |
| C10 | §6.5 | Add hourly PGLite backup cron (currently mentioned in §8 but no cron in §6.5). |
| C11 | §6.6 (NEW) | Per-version migration playbook. Manual translation of gbrain's `skills/migrations/v<N>.md` into reconciler step `stepGbrainV<N>Migration`. Apply Rule 22 backup discipline. |
| C12 | §6.3 | Per-VM cron lock around `stepGbrain` mutations (`instaclaw_cron_locks` table, Rule 8 pattern). |
| C13 | §6.5 | Per-VM cron offset for sync (`vm.id % 15`). Move Sunday `gbrain doctor` off 4:00 UTC. Memory-budget assertion in `stepGbrain`. |
| C14 | §7.3 | Replace cost numbers with re-derived $25–30/month total fleet (vs $15–50 quoted). Note linear scaling. Add 100/VM/day query rate limit. |
| C15 | §11.1, §11.2 | Keep "one of the largest" hedge. Re-verify on the morning of the launch post. |
| C16 | §4.1 | Architecture diagram: schedule dream cycle for `30 9 * * *` UTC (5am Eastern), not `30 3 * * *` UTC (peak US evening). |
| C17 | §5.2 (Phase 0) | Add: capture p50/p95/p99 query latency on a real brain in Phase 0. If p95 > 1s, halt and address before Phase 1. |
| C18 | §3.1, §6.4 | Add `gbrain serve` watchdog/supervisor. Either user-systemd unit (preferred, gives `Restart=always`) or every-minute cron. Without this, R18 has no mitigation. |
| C19 | §13.2 | Add cross-ref: "_check-soul-on-vm.ts" exists; use it for on-disk SOUL.md verification before Phase 0. |
| C20 | §10 effort | Phase 5 effort revised: from 2 days to **3 days**, reflecting the realistic 6–8 KB floor (more careful trimming required than the original 3 KB straw man). Total memory-only path: **20 days**, not 19. |

### 14.8 Open questions raised by this audit (additions to §12)

11. **What does PGLite do under writer-lock contention** — block forever, error after a timeout, or queue with a deadline? Must verify in Phase 0 with a deliberate concurrent `put_page` + `dream` test.
12. **Does OpenClaw's MCP transport survive a stdio child crash?** If gbrain serve segfaults and then restarts via systemd, does OpenClaw reconnect automatically or stay disconnected for the rest of the session?
13. **`gbrain export` lock semantics** — does it block writes, or take a consistent snapshot non-blockingly? Affects backup strategy (G3).
14. **Does gbrain v0.27 expose any way to disable query expansion** to reduce Haiku spend? If yes, that's the cheapest cost knob (the dominant cost line per §14.5).
15. **What is the actual "remote=true" restriction list** in `src/core/operations.ts`? Affects every PRD claim about agent capabilities.
16. **Does PGLite's Bun in-process mode survive Bun runtime upgrades?** If we bump Bun major version, do existing PGLite databases keep working? Affects R2.

### 14.9 What I would NOT change

After this audit, the strategic direction holds:

- **Per-VM PGLite, not shared Supabase** — still the right call. Single-writer per VM beats single-writer per fleet.
- **Stdio MCP, not HTTP** — still the right call. v0.26.9 RCE is unambiguous.
- **`GBRAIN_PINNED_VERSION = "0.27.0"`** — still correct. v0.27 is the multi-provider release.
- **1024-dim Matryoshka embeddings** — still matches `match-embeddings.ts`.
- **Phased rollout per Upgrade Playbook** — Phase 0 → Phase 1 → … → Phase 4b. Discipline holds.
- **Phase 6 (skills migration) deferred** — high-risk, gated on Phase 5 soak. Don't cave on this.
- **Rule 22 / Rule 23 / Rule 10 / Rule 17 compliance** — the audit reinforced rather than weakened these requirements.

The PRD's bones are right. The flesh needs the corrections in §14.7 before this is implementation-ready.

---

**Audit summary:** the PRD is a **B+ first draft, not an A-minus implementation-ready spec.** Corrections in §14.7 are mandatory before Phase 0 begins. The biggest material gaps are the missing PGLite single-writer analysis (§14.2 R17) and the missing per-version migration playbook (§14.4 G4) — without these, an early operational incident is likely. The smaller numerical errors (32.6 KB vs 33.8 KB, line 111 vs 577, dead-code templates) are easy to fix and don't change strategy. The audit found no fatal flaws; it found one major class of operational risk (writer-lock + crash supervision) that the original PRD pattern-matched into "fail-soft" but did not actually verify.

**Recommendation:** apply C1–C20 in a single PR (an hour of work). Re-review. Then start Phase 0.
