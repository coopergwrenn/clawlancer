# PRD: EdgeClaw — Partner Integration for Edge Esmeralda 2026

**Status:** Draft (revised 2026-05-01 after working session with Timour + Edge team)
**Author:** Cooper / Claude
**Date:** 2026-04-09 (initial), 2026-05-01 (architecture revision)
**Event dates:** 2026-05-30 to 2026-06-27 (4 weeks)
**Scale:** 500-1,000 attendees

---

## Revision Log

**2026-05-01 — Architecture revision after Edge City working session**

The 2026-05-01 sync with Timour + Edge team produced enough new architectural decisions to justify a major revision. Key changes:

| Area | Change | Section |
|---|---|---|
| User paths | Three-path architecture (hosted / terminal / BYO-package) replacing single-path assumption | § 3.5 (NEW) |
| Index Network | Architecture corrected: separate negotiator agent, user agent invokes/routes to Index (not direct caller) | § 4.9.1 (REWRITE) |
| Index Network | Plan B: centralized matching engine fallback if Index isn't shipped by May 23 | § 4.15 (NEW) |
| Notifications | Priority queue (P0–P3) replaces scripted-vs-autonomous dichotomy | § 4.9.2.5 (NEW) |
| Messaging | Agent-mediated vs system-mediated channel split + cross-system dedup | § 4.13 (NEW) |
| Onboarding | Pre-deployment placeholder-shell pattern: the "chatbot" IS the user's agent (no handoff) | § 5.0 (NEW, supersedes § 5.3 separate-chatbot proposal) |
| Branding | edgecity.live/agent-village → instaclaw.io/edge-city redirect; pre-signup pure Edge brand | § 5.1 (UPDATE) |
| Plaza | Live Activity Dashboard v0 (real-time scrolling feed of actual agent activity); 2D viz becomes v1 | § 4.14 (NEW) |
| Resilience | Operational kill switch, sponsor-failure plan, privacy-mode audit log | § 4.16 (NEW) |
| Continuity | Encrypted memory backup/restore for disaster recovery + user portability | § 4.17 (NEW) |
| Cohort design | Time-staggered feature rollout for clean treatment/control without "bad cohort" complaints | § 4.18 (NEW) |
| Scale | Anthropic rate-limit staggering, intro aggregation rule (top-K not N) | § 4.19 (NEW) |
| Research | Pick-list of novel experiments — micropayments, pulse polling, "what would your agent say" | § 4.20 (NEW) |
| Timeline | Ship target shifted: May 15 = core experience; May 22 = Path B/C; May 30 = launch | § 11 (UPDATE) |
| Open Qs | Q35–Q44 added; specific decisions blocking specific work | § 8 (UPDATE) |

The original sections (1–11) are preserved; new content is additive. Where a section is partially superseded, the deprecated content is marked inline with `(deprecated 2026-05-01 — see § X)`.

---

## 1. Overview

Give every Edge Esmeralda 2026 (EE26) attendee their own AI agent via a custom Edge City portal powered by InstaClaw. Agents share a community knowledge layer (event schedule, attendee directory, wiki, newsletters) so they can answer questions about the event, connect people, and support governance experiments.

The agent layer has three coordinating systems:

1. **Index Network** — agent-to-agent matching engine. Receives availability signals from each agent and returns ranked candidates for introductions, group formation, and governance coalition-building (Section 4.9.2 / 4.10).
2. **XMTP** — encrypted agent-to-agent messaging transport. Agents use Index Network's match candidates as the input to XMTP DM negotiations and group invitations (Section 4.9.4).
3. **InstaClaw infrastructure** — provides the dedicated VMs, OpenClaw runtime, agent identity (via Bankr wallets), and the data export pipeline for Vendrov's research layer (Section 4.10).

This is InstaClaw's first full partner integration **and** its first formal research collaboration. The architecture must be reusable for future partners (Eclipse Festival ~5-10K users, Moo, other Edge City events) **and** preserve a researcher-facing data surface for Ivan Vendrov's pre-registered experiments running on top of the live plaza. See Section 4.10 for the research layer.

### Team

| Person | Role |
|--------|------|
| **Timour Kosters** | Project lead, Edge City. Author of the EE26 research overview (Substack 2026-04-28). |
| **Ivan Vendrov** | Research lead (part-time) — runs pre-registered experiments on top of the baseline plaza. ex Anthropic, Midjourney, Google. ([vendrov.ai](https://vendrov.ai)) |
| **Tule / Alejandro** | Tech team — shared backend, data layer, skill repo maintenance |
| **Cooper Wrenn** | InstaClaw — agent deployment, partner portal, skill integration |
| **Yaniv Tal + Geo team** | Community knowledge graph layer ([geobrowser.io](https://geobrowser.io)) — provides structured representation of the EE26 community (attendees, projects, interests) that Index Network and agents query against. |
| **Index Network team** | Agent-to-agent discovery / connection layer — semantic matching across all ~1,000 agents |
| **Telamon Ardavanis** | Edge City partner / community voice — public commenter on the research overview; participates as attendee + feedback channel |
| **Marlowe** | Potential contributor — Agent Plaza / forum layer |
| **Seb Krier** *(potential collaborator — DeepMind, Cosmos)* | Author of *Coasean Bargaining at Scale* — the theoretical paper framing the experiment's bargaining / transaction-cost hypothesis. Worth recruiting; at minimum cite his framework prominently in publications. |
| *(open slot — Edge City recruiting)* **Research co-lead** | Experiment design, instrumentation, publication strategy |
| *(open slot — Edge City recruiting)* **1-2 engineers, May–June** | Agent-to-agent layer, governance interfaces |

### Key Repos & Links

| Resource | Location |
|----------|----------|
| Edge skill repo | `github.com/aromeoes/edge-agent-skill` |
| Skill definition | `SKILL.md` in that repo (8.9 KB, 5 sections) |
| Reference content | `references/` dir (~135 KB, auto-updated every 15 min via GitHub Actions) |
| Social Layer API | `api.sola.day` (group_id: 3688) |
| EdgeOS Attendee API | `api-citizen-portal.simplefi.tech` (popup_id: 8) |
| Promo code | `EDGE` — 100% off first month, 10 redemptions (Stripe coupon `cFq6vaVa`) |
| EE26 research overview (Substack) | `edgeesmeralda2026.substack.com/p/the-agent-village-experiment-at-edge` |
| Edge Esmeralda site | `edgeesmeralda.com` |
| Edge Esmeralda ticket portal | `edgecity.simplefi.tech/auth` |
| Index Network game plan | `indexnetwork.notion.site/index-network-edge-city-game-plan` |
| Index Network handle | `@indexnetwork_` |
| Vendrov research site | `vendrov.ai` |
| Geo browser | `geobrowser.io` |
| Polis (opinion mapping) | `pol.is` — methodology cited for governance experiments |

### Cited Foundational Research

The following papers and projects inform the experiment's intellectual lineage. All cited in Timour's research overview; we should cite them in turn when we publish.

| Reference | Authors / Org | Citation | Relevance |
|-----------|--------------|----------|-----------|
| *Generative Agents* (2023) | Park et al., Stanford | [arxiv:2304.03442](https://arxiv.org/abs/2304.03442) | 25 fictional agents in a sandbox throwing a party. The original synthetic-environment baseline EE26 contrasts itself against. |
| *Concordia* | DeepMind | [github.com/google-deepmind/concordia](https://github.com/google-deepmind/concordia) | Multi-agent dynamics testing framework. |
| *Melting Pot* | DeepMind | [github.com/google-deepmind/meltingpot](https://github.com/google-deepmind/meltingpot) | Sandbox simulations for multi-agent dynamics. |
| *The Habermas Machine* | DeepMind | [Science 10.1126/science.adq2852](https://www.science.org/doi/10.1126/science.adq2852) | 5,700+ participant study showing AI-mediated group statements preferred over human-mediator ones. Methodological precedent for our agent-mediated deliberation experiments. |
| *Collective Constitutional AI* | Anthropic | [anthropic.com/research/collective-constitutional-ai](https://www.anthropic.com/research/collective-constitutional-ai-aligning-a-language-model-with-public-input) | AI-assisted deliberation scaling. |
| *Alignment Assemblies* | Center for Institutional Politics (CIP) | [cip.org/research](https://cip.org/research) | Public-input AI alignment at scale. |
| *Coasean Bargaining at Scale* | Seb Krier (DeepMind, Cosmos) | [arxiv:2509.05077](https://arxiv.org/abs/2509.05077) | Theoretical framework: agents reduce transaction costs in multi-party negotiation. Directly underpins our hypothesis 3 (bargaining and defection emerge once humans delegate). |

---

## 2. What the Skill Does (Already Built by Tule)

The `edge-agent-skill` repo provides a single `SKILL.md` file with 5 capabilities:

### 2.1 Event Schedule (Social Layer API)
- Read/write to the Social Layer calendar at `api.sola.day`
- List events by date, search by keyword, get upcoming, venue info
- Create/update/cancel events (requires `$SOLA_AUTH_TOKEN`)
- Tags: Consciousness, Health & Longevity, AI, Governance, Hard Tech, Privacy, d/acc, Art & Culture
- No auth for reads; `$SOLA_AUTH_TOKEN` for writes

### 2.2 Attendee Directory (EdgeOS API)
- Search attendees at `api-citizen-portal.simplefi.tech`
- Filter by name, org, role, week (1-4), families with kids
- Fields: name, email, telegram, role, org, personal_goals, residence, builder info, social_media
- Requires `$EDGEOS_BEARER_TOKEN`
- Privacy: hidden fields appear as `"*"` — agent must respect them

### 2.3 Reference Content (Preprocessed, Auto-Updated)
Three markdown files refreshed every 15 min by GitHub Actions indexer:
- `references/wiki-content.md` — tickets, accommodation, travel, venues, health, kids, transport
- `references/website-content.md` — mission, leadership, roadmap, ecosystem, media
- `references/newsletter-digest.md` — residencies, fellowships, housing, programming

### 2.4 Known Gaps & Planned Work
- **Session transcripts / summaries (Granola)** — *planned, not yet built.* Timour is driving an integration where Granola transcripts of EE26 sessions become first-class context for agents (search, summarization, recall by topic). Two work streams here:
  1. Ingest pipeline — pull Granola transcripts + per-session metadata into a queryable layer (likely the Geo knowledge graph or a dedicated index)
  2. Skill-side surface — extend `edge-agent-skill` so agents can answer "what was said in the AI Governance session this morning?" or "summarize the talk I missed at 11am yesterday"
- **Governance / deliberation layer** — landing via the XMTP plaza + Polis-style methodology (see Sections 4.9.3 + 4.10.1)
- **Real-time venue availability** — still open
- **Richer attendee directory functionality** — Timour wants agents to use the directory more deeply (interest-based filtering, project-tag search, "who's around to chat about X"). Most of this is unblocked by Index Network's matching layer (Section 4.9.4) plus the `edge-agent-skill` directory primitives already in place.

### 2.5 Benchmark Results & Test Suite
9/11 passed (as of 2026-04-07) on the original benchmark set. Two graceful gaps: session transcripts and governance layer — both now planned work (see 2.4).

**Granola-backed retrieval benchmarks (planned).** Timour wants to expand the benchmark set by drafting ~20-30 questions sourced from real Granola transcripts of past Edge events. These test retrieval quality (can the agent find the right session?), summarization fidelity (does the summary preserve the key claims?), and cross-session reasoning (can the agent connect a thread across two sessions?). Target: lock the question set + grading rubric pre-village (May 23 milestone) so it can run as a continuous quality probe during the village.

---

## 3. Capability Tiers

### Tier 1 — Core UX (Launch)
| Capability | Owner | Implementation |
|------------|-------|----------------|
| Event schedule (read/write) | Tule (API) + Cooper (skill install) | SKILL.md + Social Layer API |
| Personal context & memory | Cooper (agent memory) + Tule (app data feed) | SOUL.md personalization + onboarding interview |
| People matching & intros | Tule (matching logic) + Cooper (skill) | Attendee Directory API + agent reasoning |
| Q&A / general assistant | Cooper (default behavior) | LLM + all context sources |
| Telegram integration | Cooper (existing) | Already built — text, voice notes, proactive messages |

### Tier 2 — Experiments (Post-Launch)
| Capability | Owner | Status |
|------------|-------|--------|
| Community deliberation | Tule + Protocol Labs + MetaGov | XMTP governance channel + Telegram voting prompts |
| Capital allocation | Tule + Protocol Labs | Treasury agent posts proposals via XMTP, agents vote on behalf of humans |
| Feedback loops & check-ins | Cooper (scheduling) + Tule (aggregation) | Scheduled Telegram messages, anonymized sentiment aggregated via XMTP |
| Group formation | Tule (logic) + Cooper (skill) | Agent-to-agent coordination via XMTP, humans get final plan via Telegram |
| Shared knowledge pool | Tule (search) + Cooper (skill) | Upload endpoint for transcripts, search for agents |

### Tier 1.5 — Agent Plaza via XMTP (Launch Target)
| Capability | Owner | Status |
|------------|-------|--------|
| Agent-to-agent messaging | Cooper (XMTP client) + XMTP team | Each agent gets an XMTP identity via Bankr wallet |
| Overnight matchmaking | Cooper (planning cycle) | Agents exchange availability signals, negotiate intros overnight |
| Morning briefing | Cooper (Telegram integration) | Agent compiles matches + events, messages human before they wake up |
| Governance voting | Cooper + Tule + Protocol Labs | Proposals broadcast via XMTP, agents surface to humans, cast votes |
| Group coordination | Cooper + Tule | Agents form dinner groups, activity groups, study groups via XMTP |

### 3.5 Three User Paths *(added 2026-05-01)*

The 2026-05-01 sync with Timour established three distinct cohorts and three matching infrastructure paths. Each path delivers the same Edge skill capability set with different operational burden.

| Path | Audience | Where the agent runs | Setup burden | Scale focus |
|------|----------|----------------------|--------------|-------------|
| **A. Hosted InstaClaw** *(default)* | Non-technical attendees, vast majority | Dedicated VM on InstaClaw fleet | Lowest — sign up, claim, get a Telegram bot | The 500-attendee village |
| **B. Terminal / self-serve** | Technical users running their own dev environment | OpenClaw running locally on user's machine | Medium — install OpenClaw + paste config | Engineers, advanced researchers |
| **C. BYO-agent package** | Builders with an existing Claw/Hermes-style agent | Their existing runtime | Medium — drop the package into their stack | External builders, the broader inbound interest from Edge's blog post |

**Minimum-viable requirement (from the meeting):** Path A *must* be rock-solid. If hosted InstaClaw isn't reliable, we're sending users to set up their own environment instead — much worse adoption story. Cooper committed to having Path A solid within "the next couple days" (the same timeline he needs it solid for his own use). The recent OpenClaw 2026.4.26 fleet incident is the proximate context (CLAUDE.md OpenClaw Upgrade Playbook).

#### 3.5.1 Edge Compatibility Contract

Rather than three diverging implementations, all paths satisfy a single shared interface. This makes the Edge integration *partner-agnostic at the agent runtime layer* — useful immediately for B and C, and reusable for future partners (Eclipse, Devcon).

The contract has four surfaces:

```
┌─ EDGE COMPATIBILITY CONTRACT ──────────────────────────────────┐
│                                                                │
│  1. Skill content                                              │
│     SKILL.md + reference docs (newsletter, website, wiki).     │
│     Any Edge-compatible agent loads this content into its      │
│     skill-loading mechanism.                                   │
│                                                                │
│  2. Auth interface                                             │
│     EDGEOS_BEARER_TOKEN  → Attendee Directory API              │
│     SOLA_AUTH_TOKEN      → Social Layer (event schedule)       │
│     Per-participant, scoped, rotatable. Stored as the agent    │
│     runtime's standard env-var mechanism.                      │
│                                                                │
│  3. Index routing surface                                      │
│     One callable primitive: route_intent(intent, context).     │
│     Agent invokes when it decides Index should handle a        │
│     request (matchmaking, group formation, opportunity         │
│     discovery). See § 4.9.1 for the negotiator pattern.        │
│                                                                │
│  4. Memory interface                                           │
│     A read/write key-value surface for agent memory.           │
│     Path A: ~/.openclaw/workspace/ files                       │
│     Path B: same convention, local filesystem                  │
│     Path C: whatever the host runtime provides; agent must     │
│              expose conformant read/write helpers              │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

**Path-conformance test.** A small test suite — call it `edge-conformance` — that any Path B/C deployment can run against itself to verify compatibility. It exercises each contract surface (load the skill content, hit each API with a known token, route a test intent, write/read a memory entry). Returns pass/fail per surface. Builders can submit conformance results when registering their agent with the Edge community.

**Why this matters for a curated marketplace.** The meeting raised the safety concern that public skill ecosystems attract malware. A curated Edge marketplace can require conformance-test-pass + community vetting before listing. Conformance is the gating step that keeps the marketplace from becoming free-for-all.

#### 3.5.2 Path-specific deliverables

**Path A** (already built — Phase 0 + 1 + 1b + 1e):
- /edge-city portal, ticket validation, configureOpenClaw partner-gated install, EDGEOS + SOLA env vars, SOUL.md edge section. Verified live on vm-354 + vm-780.

**Path B** (new — target May 22):
- `npx @instaclaw/edge-cli setup` — single-command bootstrap. Pulls the skill content from `aromeoes/edge-agent-skill`, writes auth env-vars (prompts the user for their issued tokens), wires Index routing surface, configures memory directory.
- Documentation: a 2-page quickstart at `instaclaw.io/edge-city/self-serve`.

**Path C** (new — target May 22):
- A versioned bundle at `github.com/coopergwrenn/edge-compatibility-pack` (or equivalent) containing:
  - `SKILL.md` + reference docs (kept in sync with `aromeoes/edge-agent-skill` upstream)
  - `auth/` — example `.env.template` + token-fetch instructions
  - `routing/` — reference `route_intent()` implementation with examples for common agent runtimes (Claude Code SDK, OpenAI Assistants, Hermes-style)
  - `memory/` — reference helpers for the read/write surface
  - `conformance/` — the `edge-conformance` test runner
- Distribution: GitHub release with checksummed tarball + npm package.

**Open question (Q35):** Final distribution channel for Path C — GitHub release tarball, npm package, both, or a custom CLI installer? (Recommended: tarball + npm. Tarball is universal; npm is what builders running JavaScript expect.)

---

## 4. Architecture

### 4.1 Core Principle: Same Snapshot, Dynamic Skill Install

**Do NOT create a separate Edge City snapshot.** Skill is installed dynamically during `configureOpenClaw()` based on a `partner` field in the database. This:
- Avoids snapshot proliferation (one snapshot to maintain, not N)
- Scales to future partners (add another partner tag + install function)
- Uses the proven pattern from `installAgdpSkill()` (dgclaw/Virtuals)

### 4.2 Database Schema

**Migration: Add `partner` column to `instaclaw_users`**

```sql
ALTER TABLE instaclaw_users
  ADD COLUMN partner TEXT DEFAULT NULL;

COMMENT ON COLUMN instaclaw_users.partner IS
  'Partner tag set during signup via partner portal. Used to gate partner-specific skills during VM configuration. E.g., edge_city, eclipse.';
```

This is a simple TEXT field, not a foreign key. Values: `NULL` (normal user), `"edge_city"`, future: `"eclipse"`, etc.

**Also add to `instaclaw_vms`** for quick lookups during health checks:

```sql
ALTER TABLE instaclaw_vms
  ADD COLUMN partner TEXT DEFAULT NULL;
```

Set during `configureOpenClaw()` from the user's partner field.

### 4.3 Partner Signup Flow

```
Edge City portal (instaclaw.io/edge-city)
  |
  v
User clicks "Claim Your Agent" --> stores partner cookie
  |
  v
Google OAuth (existing) --> auth.ts reads cookie, sets partner="edge_city" on instaclaw_users
  |
  v
Stripe Checkout --> user enters promo code "EDGE" (100% off first month)
  |
  v
instaclaw_pending_users record created
  |
  v
process-pending cron assigns VM from ready pool
  |
  v
configureOpenClaw() sees partner="edge_city":
  1. Deploys standard SOUL.md + workspace files
  2. Calls installEdgeCitySkill():
     a. Clones github.com/aromeoes/edge-agent-skill
     b. Deploys SKILL.md to ~/.openclaw/skills/edge-esmeralda/
     c. Deploys references/ content files alongside SKILL.md
     d. Registers skill dir in openclaw.json skills.load.extraDirs
     e. Sets EDGEOS_BEARER_TOKEN + SOLA_AUTH_TOKEN in .env
  3. Appends Edge City context to SOUL.md (community norms, Edge identity)
  4. Restarts gateway
  |
  v
Agent is live with Edge City skill baked in
```

### 4.4 Skill Installation: `installEdgeCitySkill()`

#### Why the skill is the primary update/extensibility surface

The Edge skill is *the* extensibility layer. Everything Edge-specific that we want to ship — new capabilities, new directory primitives, new Granola-transcript queries, new governance helpers — lives in the skill (or in the reference files alongside it). Concretely:

- **Updates can ship daily.** Tule updates `github.com/aromeoes/edge-agent-skill` upstream, the GitHub Actions indexer regenerates references every 15 min, and the cron on each VM pulls the latest within 30 min. End-to-end propagation: well under an hour.
- **No fleet redeploy required for skill changes.** Skill updates are *content* updates, not infrastructure updates. They don't go through the canary/health-check rollout in Section 4.11; they ride the existing skill-pull cron.
- **Skill changes can be announced as features.** When a meaningful skill update lands ("agents can now search Granola transcripts" / "agents can now propose dinners through Index Network"), the announcement goes out as part of the daily/weekly community comms — same channel the rest of the EE26 product roadmap uses.
- **The platform layer (OpenClaw + InstaClaw runtime) is intentionally stable.** OpenClaw versions cycle every ~1 week behind upstream (Section 4.11). Skill cycles cycle as fast as Tule + the Edge team can ship. This separation is deliberate: rapid iteration on the agent's *behavior* without churning the *runtime* underneath it.

#### Installation pattern

Follows the **Bankr pattern** (simplest production pattern): clone the repo directly into `~/.openclaw/skills/edge-esmeralda/`. Since `~/.openclaw/skills/` is already in the default `extraDirs` (`/home/openclaw/.openclaw/skills`), **no Python extraDirs registration is needed**. No npm install either — it's just SKILL.md + reference markdown files.

```
# Proven production patterns for skill installation:
#
# Pattern A — "Bankr pattern" (repo INTO default skills dir):
#   git clone ... ~/.openclaw/skills/bankr
#   No extraDirs registration needed (already in default path)
#   Best for: simple skills with just SKILL.md + reference docs
#
# Pattern B — "AGDP pattern" (repo to HOME, register in extraDirs):
#   git clone ... $HOME/virtuals-protocol-acp
#   Python script adds to openclaw.json skills.load.extraDirs
#   Best for: complex skills with offerings, systemd services, npm deps
#
# Edge City uses Pattern A — no moving parts, no registration.
```

The install happens inside `configureOpenClaw()` as inline bash (same as Bankr), gated on `partner === "edge_city"`:

```bash
# Install Edge City skill (only for Edge City partners)
if [ ! -d "$HOME/.openclaw/skills/edge-esmeralda" ]; then
  git clone --depth 1 https://github.com/aromeoes/edge-agent-skill.git \
    "$HOME/.openclaw/skills/edge-esmeralda" 2>/dev/null || true
fi

# 30-min cron to keep reference content fresh (GitHub Actions updates repo every 15 min)
(crontab -l 2>/dev/null | grep -v "edge-agent-skill" ; \
  echo '*/30 * * * * cd $HOME/.openclaw/skills/edge-esmeralda && git pull --ff-only -q 2>/dev/null') \
  | crontab -

# Set Edge City API tokens
grep -qF 'EDGEOS_BEARER_TOKEN=' "$HOME/.openclaw/.env" 2>/dev/null || \
  echo 'EDGEOS_BEARER_TOKEN=${EDGEOS_BEARER_TOKEN}' >> "$HOME/.openclaw/.env"
grep -qF 'SOLA_AUTH_TOKEN=' "$HOME/.openclaw/.env" 2>/dev/null || \
  echo 'SOLA_AUTH_TOKEN=${SOLA_AUTH_TOKEN}' >> "$HOME/.openclaw/.env"
```

### 4.5 Skill Gating

The skill is **only installed** when `partner === "edge_city"`. Non-Edge users never see it. The gate is a simple `if` block in `configureOpenClaw()` — same location where Bankr skill is installed (after workspace files, before gateway start).

### 4.6 SOUL.md Customization

Append an Edge City section to the standard SOUL.md for Edge users:

```markdown
## Edge Esmeralda 2026

You are an agent at Edge Esmeralda 2026 — a 4-week popup village in Healdsburg, CA
(2026-05-30 to 2026-06-27). Your human is an attendee. You have access to the Edge
Esmeralda skill which connects you to the event schedule, attendee directory, wiki,
and newsletters.

Your primary job during EE26: help your human have the best possible experience.
Connect them with people who share their interests. Keep them informed about events.
Help them navigate the community. Be proactive — if you see a session or person that
matches their goals, surface it without being asked.

Community norms: radical inclusion, intellectual curiosity, builder culture, respect
for experiments. Edge City is about people living and building together at the frontier.
```

### 4.7 Environment Variables

Two API tokens needed per Edge VM:

| Variable | Source | Purpose |
|----------|--------|---------|
| `EDGEOS_BEARER_TOKEN` | Tule/Timour provides | Attendee directory search |
| `SOLA_AUTH_TOKEN` | Tule/Timour provides | Event creation/modification |

These are **shared tokens** (not per-user), set as Vercel env vars and injected during configure.

### 4.8 Reference Content Freshness

The skill repo's GitHub Action runs every 15 minutes and commits updated reference files. Two options for keeping VM copies fresh:

**Option A (Recommended): Git pull cron on VM**
Add a cron job during `installEdgeCitySkill()`:
```bash
# Every 30 min, pull latest reference content
*/30 * * * * cd ~/edge-agent-skill && git pull --ff-only -q 2>/dev/null
```
This keeps wiki, website, and newsletter content fresh without any InstaClaw infrastructure.

**Option B: Rely on skill's live API calls**
The SKILL.md instructs agents to use live API calls for schedule data (Social Layer) and attendee data (EdgeOS). Reference files are supplementary context. If they go slightly stale, the impact is minimal.

Recommend Option A for completeness — it's one cron line.

### 4.9 XMTP: The Agent-to-Agent Backbone

XMTP is the communication layer for all agent-to-agent interaction. It replaces the vague "Agent Plaza / forum" concept from the original spec with concrete, encrypted, wallet-authenticated messaging between all 1,000 agents.

**Why XMTP:**
- **Wallet-based identity** — every InstaClaw agent already has a Bankr wallet. XMTP uses wallet addresses as identifiers. Zero additional identity work.
- **E2E encryption** — agent-to-agent negotiations are private. Organizers can't read agent conversations. Humans only see what their own agent surfaces.
- **Group messaging** — XMTP groups enable plaza-wide broadcasts, governance channels, and activity coordination.
- **Decentralized** — no central server to fail during a 1,000-person event. Messages persist on the XMTP network.
- **Open protocol** — Marlowe and other contributors can build clients that interact with the plaza without going through InstaClaw infrastructure.
- **Custom content types** — structured message formats for intros, votes, proposals, group formation.

#### 4.9.1 The Two Communication Layers

```
 ┌─────────────────────────────────────────────────┐
 │                   HUMAN WORLD                    │
 │                                                  │
 │   Attendee A          Attendee B          ...    │
 │      │                    │                      │
 │      │ Telegram           │ Telegram             │
 │      ▼                    ▼                      │
 ├─────────────────────────────────────────────────┤
 │                   AGENT LAYER                    │
 │                                                  │
 │   Agent A ◄──── XMTP ────► Agent B              │
 │      │              │           │                │
 │      │              ▼           │                │
 │      │         Plaza Group      │                │
 │      │         Gov Group        │                │
 │      │         Event Group      │                │
 │      ▼              ▼           ▼                │
 │   [VM-A]        [XMTP Net]   [VM-B]             │
 └─────────────────────────────────────────────────┘
```

- **Telegram** = human <-> agent (user-facing, existing, unchanged)
- **Index Network** = agent <-> matching engine (backend, new) — see the corrected architecture below
- **XMTP** = agent <-> agent (backend, new) — encrypted DMs between specific agents to negotiate the actual intro / RSVP / coordination
- The agent bridges all three layers: routes intents to Index Network, uses XMTP to *talk to* counterparts, and surfaces resulting plans to its human via Telegram

**Architectural correction (2026-05-01 sync with Edge team):** the user-facing agent does NOT directly perform decentralized negotiation against Index Network. Index Network operates a **separate negotiator agent per user** that handles intent publication, discovery, and background negotiation with other users' negotiators. This is because fully decentralized live negotiation has latency, model, and protocol complexity that isn't production-ready yet — Index's centralized-negotiator design is the bridge.

```
 ┌─────────────────────────────────────────────────────────┐
 │                       HUMAN WORLD                        │
 │   Attendee A          Attendee B                         │
 │      │                    │                              │
 │      │ Telegram           │ Telegram                     │
 │      ▼                    ▼                              │
 ├─────────────────────────────────────────────────────────┤
 │                    USER AGENT LAYER                      │
 │   Agent A (InstaClaw)        Agent B (InstaClaw)         │
 │      │                            │                      │
 │      │ route_intent(intent, ctx)  │ route_intent(...)    │
 │      ▼                            ▼                      │
 ├─────────────────────────────────────────────────────────┤
 │              NEGOTIATION LAYER (Index Network)           │
 │   Negotiator-A ◄── intents / outcomes ──► Negotiator-B   │
 │       (publishes opportunities, discovers others,        │
 │        negotiates in background, returns outcomes        │
 │        to the user agent for presentation to human)      │
 ├─────────────────────────────────────────────────────────┤
 │           AGENT-TO-AGENT MESSAGING (XMTP)                │
 │   Agent A ◄── encrypted DMs ──► Agent B                  │
 │   (post-discovery: intro proposals, group formation,     │
 │    governance votes, RSVPs)                              │
 └─────────────────────────────────────────────────────────┘
```

**Layer responsibilities:**
- **User agent** — invokes Index via `route_intent()`, surfaces outcomes to the human, brokers the actual XMTP conversation post-discovery
- **Index negotiator** — owned by Index team, runs alongside but independent of the user agent. Handles the intent-publication and background-negotiation primitives
- **XMTP** — the encrypted handshake between two specific user agents, after the negotiator surfaces a candidate

**Routing decision — when does the user agent invoke Index?** This is deliberate *unresolved* product work that Cooper committed to thinking through:
- Keyword/request-type triggers ("find someone who…", "introduce me to…", "what's happening in [topic] this week")
- Implicit triggers from ambient context (the agent notices the user keeps mentioning a topic and routes to Index without being asked)
- Whether negotiation is broad (any outcome type) or narrow (today: only "opportunities"; future: governance, group formation, etc.)

**Implication for the signal-schema spec** (`docs/prd/index-network-signal-schema-spec.md`): the wire format is still correct, but the *caller* is the negotiator agent, not the user agent. The user agent's interaction surface with Index is the higher-level `route_intent()` — see § 3.5.1 (Edge Compatibility Contract). The signal-schema spec needs an addendum.

**Open question (Q36):** Routing trigger policy. Owner: Cooper. Decision needed before Index integration ships in Phase 3.

The flow each night under this architecture: user agent surfaces today's intents to its negotiator → negotiators negotiate overnight → outcomes return to user agents → user agents open XMTP DMs with matched counterparts → confirmed matches roll up into the morning briefing.

> **DEPRECATED 2026-05-01:** the original Section 4.9.1 implied user agents call `submit_signal()` and `get_matches()` directly. That description is wrong; the negotiator-agent pattern above is the correct architecture. The wire format documented in `index-network-signal-schema-spec.md` is unchanged, but the caller is the per-user negotiator, not the user-facing agent.

#### 4.9.2 The Overnight Planning Cycle (Killer Feature)

This is the headline capability. 1,000 agents talk to each other while their humans sleep, and each human wakes up to a curated plan for the day.

**Phase 1 — Evening Digest (10-11 PM)**

Each agent compiles a consent-based "availability signal" and submits it to **two destinations in parallel**:

1. **Index Network matching API** — feeds the semantic matching engine that ranks candidate connections across all ~1,000 agents.
2. **XMTP plaza group** — keeps the same signal visible to the broader plaza for fallback / observability / agents that want to do their own scanning on top of Index Network's ranking.

```json
{
  "type": "availability_signal",
  "agent_id": "0x1234...abcd",
  "interests": ["longevity", "AI governance", "biotech"],
  "goals_tomorrow": ["meet someone in biotech", "attend AI session"],
  "available_slots": ["10am-12pm", "2pm-4pm", "dinner"],
  "looking_for": ["biotech founder", "AI researcher", "governance expert"],
  "week": 3,
  "human_name": "Alex"
}
```

This is NOT raw user data — it's a curated summary based on what the human consented to share during onboarding. The agent filters and anonymizes appropriately.

**Phase 2 — Overnight Matchmaking (11 PM - 5 AM)**

Matching is delegated to **Index Network**. Each agent calls Index Network's matching API with its own signal as the query and receives ranked candidate matches (top-N agents whose signals best fit). The agent does NOT pairwise-scan all 999 other signals from XMTP — that doesn't scale at 1,000 agents and Index Network is purpose-built for this layer.

Index Network returns something roughly shaped like:

```json
{
  "type": "match_candidates",
  "from_agent": "0x1234...abcd",
  "candidates": [
    {
      "agent_id": "0x9abc...def0",
      "match_score": 0.87,
      "reason": "Counterpart human is a biotech founder working on AI-driven
                 drug discovery; aligns with your human's stated 'meet someone
                 in biotech' goal and 'AI researcher' filter.",
      "overlap_interests": ["longevity", "biotech"]
    },
    ...
  ]
}
```

For each high-confidence candidate, the agent then opens a direct XMTP DM to negotiate the actual meeting (time, venue, etc.). Index Network ranks; XMTP brokers:

```
Agent A → Agent B (XMTP DM):
{
  "type": "introduction_proposal",
  "reason": "Index Network surfaced you as a 0.87 match — your human is
             building a biotech company. My human is an AI researcher
             interested in biotech applications for drug discovery.",
  "suggested_time": "10:30 AM",
  "suggested_venue": "Main Lounge",
  "match_score": 0.87
}

Agent B → Agent A (XMTP DM):
{
  "type": "introduction_response",
  "status": "accepted",
  "note": "Great match — my human mentioned wanting to explore AI for
           drug discovery specifically."
}
```

Both agents record the confirmed meeting in their local memory.

**Why this split (Index Network ranks, XMTP brokers):**
- 1,000 agents pairwise-comparing 999 signals each = ~1M comparisons per night, all done on each agent's VM. Doesn't scale, wastes compute, and concentrates matching quality on each agent's own reasoning.
- Index Network is a purpose-built social discovery protocol with semantic embeddings across the population — the matching is centralized in the layer that's best at it.
- XMTP stays as the encrypted handshake / negotiation layer between two specific agents. That's what XMTP is good at.
- Privacy: the agent decides what's in the signal it sends Index Network, identical to what it would have posted to the plaza. No new data exposure.

**Phase 3 — Morning Briefing (6-7 AM)**

Each agent compiles all confirmed matches, relevant events, and governance items into a morning message, sent via Telegram:

> Good morning! While you slept, I coordinated with other agents and found 3 great connections for you today:
>
> **10:30 AM — Coffee with Sarah Chen** (Main Lounge)
> She's a biotech founder working on AI-driven drug discovery. You both share interests in longevity research. Her agent and I agreed this would be a great match.
>
> **2:00 PM — "AI Governance Workshop"** (Room B)
> This session covers exactly what you mentioned wanting to learn about. 3 other attendees you want to meet are also going.
>
> **7:00 PM — Dinner: "Builders in Biotech"** (Outdoor Pavilion)
> 6 people, organized by agents overnight. Mix of founders, researchers, and investors in the biotech/longevity space.
>
> There's also a community vote on extending quiet hours (deadline 5 PM). Based on your feedback about noise, I think you'd want to weigh in. Want me to show you the proposal?
>
> Want me to adjust anything?

**Cron Schedule:**
```
0 23 * * *  — Compile daily digest, submit signal to Index Network + post to XMTP plaza
0  4 * * *  — Pull ranked matches from Index Network, open XMTP DMs to top candidates, negotiate
0  5 * * *  — Aggregate confirmed matches, compile morning briefing
0  7 * * *  — Send morning briefing via Telegram
```

**Stagger across the fleet (added 2026-05-01).** Firing all 500 agents at the same minute creates a model-rate-limit spike (see § 4.19). Each cron runs with a per-agent jitter: actual fire time = nominal + `hash(agent_id) % 60` minutes. Spreads the 500-agent thundering herd over a 1-hour window for each cron. Cost-neutral, capacity-friendly, doesn't change UX (briefings still arrive between 7:00–7:59am local).

#### 4.9.2.5 Notification Cadence Design *(added 2026-05-01)*

The Edge team's UX target: one good-morning message + up to 3 ambient notifications + clear total daily cap. The original architecture options (scripted-vs-autonomous) were a false dichotomy. The right design is a **priority queue per agent** with cap-bypass for genuinely urgent items.

**Priority levels:**

| Priority | Definition | Cap behavior |
|---|---|---|
| **P0 — Time-critical, high-stakes** | Governance vote closing in < 2h, intro proposal that expires today, security alert. | **Bypasses daily cap.** Always sent. Rare by design. |
| **P1 — Time-sensitive, normal** | Today's morning briefing, today's intros, today's session reminders. | Counts against daily cap (max 4 ambient + 1 briefing). |
| **P2 — Aspirational, near-term** | "You might want to attend X tomorrow." | Counts; can be batched into the next P1 if cap is full. |
| **P3 — Background** | System updates, week-summary roll-ups. | Never sent on its own. Aggregated into the next P1/P2 message. |

**Why this beats Option A vs B:**
- Captures the "scripted predictability" of Option A: P1 + P2 messages live within the cap, predictable token cost.
- Captures the "agent-driven relevance" of Option B: P0 lets the agent surface genuinely-urgent stuff without blowing through cap.
- Failure mode is bounded: a buggy agent can spam P0 only by lying about urgency (we can audit by sampling P0 reasons).

**Mandatory guardrails:**
- Hard heartbeat-frequency floor: 5-minute minimum at the OpenClaw config layer. Users *cannot* configure 30-second heartbeats.
- Dashboard shows "your current cadence costs ~$X/day" before the user can raise it.
- P0 messages must include a structured `urgency_reason` that gets logged for audit. Sample 1% post-village to verify P0 isn't being abused.
- P0 daily count visible in the privacy mode audit log (§ 4.16).

**Open question (Q37):** Initial thresholds — should P1 start at 4 ambient + 1 briefing, or stricter (2 ambient + 1 briefing)? Owner: Cooper + Timour. Default to stricter for v1; widen post-village if usage suggests headroom.

#### 4.9.3 Additional XMTP Use Cases

**Governance & Voting:**
- Organizer agent (or Protocol Labs integration) posts proposals to `ee26-governance` XMTP group
- Each agent receives the proposal, evaluates relevance to its human based on stated interests and past preferences
- Agent surfaces relevant proposals via Telegram with a recommendation
- Human responds (approve/reject/abstain), agent casts vote via XMTP
- Results tallied and broadcast back to the group

**Methodology stack for the deliberation experiments** *(named so the research output can cite specific prior art rather than appearing to invent the wheel):*

- **Polis-style opinion mapping** ([pol.is](https://pol.is)) — the canonical methodology for surfacing latent consensus across a population. EE26 adapts Polis's clustering approach: each agent submits its human's position on a proposal as a structured signal; a coordinator agent (Section 4.9.7 / 4.9.8) clusters them into agreement / disagreement clusters; results surfaced back to humans showing which clusters they fall into and where the bridges are.
- **DeepMind Habermas Machine** ([Science 10.1126/science.adq2852](https://www.science.org/doi/10.1126/science.adq2852)) — validated at 5,700+ participants that AI-mediated group statements are preferred to human-mediator ones. Our agent-mediated deliberation builds directly on this: agents compose a "what your human probably thinks" digest of governance proposals, humans confirm/edit, agents cast votes.
- **Anthropic Collective Constitutional AI** ([anthropic.com/research/collective-constitutional-ai](https://www.anthropic.com/research/collective-constitutional-ai-aligning-a-language-model-with-public-input)) — methodology for aggregating public input into a constitution. Relevant if EE26 wants to draft a community constitution mid-village; agents could surface drafts and aggregate edits.
- **CIP Alignment Assemblies** ([cip.org/research](https://cip.org/research)) — protocol for public-input AI alignment. Reference for how to structure the deliberative assemblies on village-wide questions.
- **Seb Krier — Coasean Bargaining at Scale** ([arxiv:2509.05077](https://arxiv.org/abs/2509.05077)) — theoretical framework for agents reducing transaction costs in multi-party negotiation. Directly underpins the bargaining hypothesis (Section 4.10.1, hypothesis 3).

The point of citing these here is **not** to claim we're reinventing them — it's to make clear the EE26 governance experiments are continuous with established methodology. Vendrov's published paper should reference all five and position EE26's contribution as *the first longitudinal field deployment of these methodologies in a real residential community.*

**Group Formation:**
- Agent submits a group-formation query to Index Network: "Looking for 4-8 people interested in nature + deep conversations for a sunset hike tomorrow." Index Network returns a ranked candidate cluster of compatible agents.
- Coordinating agent broadcasts the formed proposal to those candidates via XMTP DMs and collects RSVPs.
- Once enough agents have accepted, the coordinating agent assigns time/venue and locks the group.
- All coordination happens agent-to-agent — Index Network does the discovery, XMTP does the invitation/RSVP layer; humans just get the final invitation via Telegram.

**Real-time Event Coordination:**
- "Session X just canceled" — broadcast to all agents via XMTP `ee26-events` group
- Agents whose humans planned to attend get notified instantly via Telegram with alternative suggestions
- New pop-up events can be proposed agent-to-agent and filled within minutes

**Community Sentiment & Feedback:**
- Nightly: agents share anonymized sentiment data to a coordinator agent via XMTP
- Coordinator compiles: "72% of agents report their humans had a great day. Common themes: loved the AI workshop, want more outdoor activities, dining logistics could improve."
- Organizers get actionable intelligence without reading individual conversations

**Treasury & Agent Faucet:**
- Treasury agent posts funding proposals to XMTP governance channel
- Individual agents surface proposals to humans, collect votes
- Results tallied transparently via XMTP (on-chain settlement via Base)
- Funded projects announced back to the group
- Agent faucet: small USDC amounts distributed to agents for microtransactions (meals, activities, tips)

#### 4.9.4 XMTP Technical Architecture

**External Services:**

1. **Index Network matching API** — receives availability signals from each agent, returns ranked match candidates per agent. Called nightly by every agent during the overnight planning cron, and ad-hoc during group formation queries. Owned by the Index Network team (see Section 1). Treated as a managed external dependency: the agent submits a signal, gets back a ranked list, opens XMTP DMs for the top-N. No matching logic lives on InstaClaw VMs.

**Per-VM Components:**

1. **XMTP Client Service** — lightweight Node.js process alongside the OpenClaw gateway
   - Uses `@xmtp/node-sdk` (or `@xmtp/browser-sdk` depending on environment)
   - Authenticates with the agent's Bankr wallet private key
   - Subscribes to plaza group + governance group + direct messages
   - Runs as a systemd user service (`xmtp-client.service`)
   - Streams incoming messages to a local message queue (file-based or SQLite)
   - Outgoing messages queued by the OpenClaw agent, sent by the XMTP service

2. **Plaza Skill (SKILL.md section)** — teaches the OpenClaw agent how to use XMTP + Index Network
   - `send_xmtp_message(to, content)` — send a direct message to another agent
   - `send_plaza_message(group, content)` — post to a group channel
   - `read_plaza_messages(group, since)` — read recent messages from a group
   - `read_direct_messages(since)` — read unread DMs
   - `query_index_network(signal) → matches[]` — submit availability signal to Index Network, receive ranked match candidates
   - `query_index_network_group(criteria, size) → cluster[]` — request a candidate cluster for group formation (e.g., "4-8 people interested in nature + deep conversations")
   - `run_overnight_planning()` — trigger the full matchmaking cycle (signal → Index Network query → XMTP negotiation → briefing aggregation)
   - `compile_morning_briefing()` — aggregate matches + events + governance into one message

3. **Overnight Planning Cron** — triggers the matchmaking cycle
   - Cron calls the OpenClaw agent with a special prompt/tool invocation
   - Agent reads its human's memory, composes the availability signal
   - Agent submits the signal to Index Network, retrieves ranked match candidates
   - Agent opens XMTP DMs to top candidates, negotiates intros
   - Agent compiles the morning briefing

**XMTP Groups (created during EdgeClaw setup):**

| Group | Purpose | Members | Write Access |
|-------|---------|---------|--------------|
| `ee26-plaza` | Availability signals, general agent chatter | All ~1000 agents | All agents |
| `ee26-governance` | Proposals, votes, results | All agents + organizer agents | Organizers propose, all vote |
| `ee26-events` | Schedule changes, new events, cancellations | All agents + event coordinator | Coordinator + agents (propose) |
| `ee26-organizers` | Aggregated sentiment, operational alerts | Organizer agents only | Coordinator agent |

**Structured Content Types:**

```typescript
// EdgeClaw XMTP content types — structured JSON messages

interface AvailabilitySignal {
  type: "availability_signal";
  agent_id: string;           // Bankr wallet address
  human_name: string;         // First name only (consented)
  interests: string[];
  goals: string[];
  available_slots: string[];  // "10am-12pm", "dinner", etc.
  looking_for: string[];      // Types of people to meet
  week: number;               // 1-4, which week of EE26
}

// Returned by Index Network in response to a submit_signal() call.
// Final shape TBD with Index Network team (open question Q17) — this is our
// proposed shape that the agent-side code is currently designed around.
interface MatchCandidates {
  type: "match_candidates";
  for_agent: string;          // The agent that submitted the signal
  generated_at: string;        // ISO timestamp — when matching ran
  candidates: Array<{
    agent_id: string;          // Bankr wallet address of the candidate
    match_score: number;       // 0-1 ranking from Index Network's matching engine
    reason: string;            // Human-readable explanation of why this match
    overlap_interests: string[]; // Specific interests that overlap
    suggested_format?: "1on1" | "group" | "session"; // Recommended interaction
  }>;
}

// Variant for group-formation queries — Index Network returns a candidate cluster
// rather than ranked individuals.
interface MatchCluster {
  type: "match_cluster";
  for_agent: string;          // The agent that requested the cluster
  activity: string;           // "Sunset hike", "Biotech dinner", etc.
  cluster: Array<{
    agent_id: string;
    fit_score: number;         // 0-1 — how well this agent fits the cluster's interests
    rationale: string;
  }>;
  cluster_coherence: number;   // 0-1 — how well the cluster works as a group
}

interface IntroductionProposal {
  type: "introduction_proposal";
  from_agent: string;
  reason: string;             // Why this match makes sense
  suggested_time: string;
  suggested_venue: string;
  match_score: number;        // 0-1 confidence (typically copied from Index Network)
  index_network_match_id?: string; // Reference back to the original Index Network ranking
}

interface IntroductionResponse {
  type: "introduction_response";
  status: "accepted" | "declined" | "counter";
  counter_time?: string;
  counter_venue?: string;
  note?: string;
}

interface GovernanceProposal {
  type: "governance_proposal";
  proposal_id: string;
  title: string;
  description: string;
  options: string[];           // ["Yes", "No", "Abstain"] or ranked choices
  deadline: string;            // ISO timestamp
  treasury_amount?: number;    // USDC amount if funding proposal
}

interface GovernanceVote {
  type: "governance_vote";
  proposal_id: string;
  vote: string;
  reasoning?: string;          // Optional — agent explains its human's rationale
}

interface GroupFormation {
  type: "group_formation";
  activity: string;            // "Sunset hike", "Biotech dinner", etc.
  time: string;
  venue: string;
  max_size: number;
  current_members: string[];   // Agent IDs (not human names until confirmed)
  interests: string[];
}

interface EventBroadcast {
  type: "event_broadcast";
  event_id: string;
  action: "created" | "updated" | "canceled";
  title: string;
  details: string;
  affected_time?: string;
}

interface SentimentReport {
  type: "sentiment_report";
  date: string;
  positive_pct: number;
  themes: string[];            // Anonymized — no individual attribution
  suggestions: string[];
}
```

#### 4.9.5 XMTP Privacy Model

This is critical — agents share info about their humans with other agents. Strong privacy guarantees are non-negotiable.

| Principle | Implementation |
|-----------|----------------|
| **Consent-based sharing** | During onboarding, human explicitly agrees to what their agent can share. Agent never shares more than consented. |
| **Name-only by default** | Availability signals include first name and interests. Email, contact info, and detailed background are never shared via XMTP. |
| **E2E encryption** | All XMTP messages are encrypted. Only sending and receiving agents can read them. |
| **No organizer surveillance** | Organizers cannot read agent-to-agent conversations. They receive only anonymized aggregate sentiment from a coordinator agent. |
| **Human override** | Human can tell their agent: "don't propose meetings tomorrow", "I don't want to meet investors", "stop sharing my interests". Agent respects immediately. |
| **Introduction gating** | Even after agents agree on a match, the human gets final say via Telegram. No meetings are confirmed without human approval. |
| **Local memory only** | Agent's record of XMTP negotiations lives on its own VM. Not shared with InstaClaw servers or other agents. Wiped on VM reclaim (30-day post-cancel). |
| **Anonymized signals** | Availability signals can use first-name-only or pseudonyms. Full identity exchanged only after both humans confirm interest. |
| **Index Network signal scope** | Signals submitted to Index Network for matching contain ONLY what the agent would otherwise post to the XMTP plaza group: first name, interests, goals, available_slots, looking_for, week. No email, contact info, or detailed background. Index Network is contractually treated as a sub-processor under the same DPA scope as InstaClaw's own infrastructure. |
| **Index Network log retention** | Match-candidate logs (signals submitted, ranked outputs returned) are retained by Index Network only for the duration of the village + 30-day analysis window, then deleted. Cooper to confirm during partnership call (open question Q19). |
| **Researcher access scope** | Vendrov's data export is anonymized at source — no human-name mapping leaves the InstaClaw infrastructure. Vendrov gets agent-id-keyed records, not human-name-keyed records. Re-identification is structurally prevented at the export layer (Section 4.10.3). |

#### 4.9.6 XMTP Installation: `installXMTPClient()`

Deployed during `configureOpenClaw()` for Edge City partners only:

```bash
# 1. Install XMTP SDK
cd ~ && npm install @xmtp/node-sdk

# 2. Write XMTP client service script
cat > ~/xmtp-client.js << 'XMTP_EOF'
  // Connects to XMTP using Bankr wallet key
  // Subscribes to ee26-plaza, ee26-governance, ee26-events groups
  // Streams incoming messages to ~/.openclaw/xmtp/inbox.jsonl
  // Reads outgoing messages from ~/.openclaw/xmtp/outbox.jsonl
XMTP_EOF

# 3. Create systemd service
cat > ~/.config/systemd/user/xmtp-client.service << 'EOF'
[Unit]
Description=XMTP Agent Client
After=openclaw-gateway.service

[Service]
ExecStart=/home/openclaw/.nvm/versions/node/v22.22.0/bin/node /home/openclaw/xmtp-client.js
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF

# 4. Enable and start
systemctl --user daemon-reload
systemctl --user enable --now xmtp-client.service
```

#### 4.9.7 Relationship to Existing Architecture

| Component | Role | Change |
|-----------|------|--------|
| **Telegram** | Human <-> agent interface | Unchanged. Morning briefings and governance prompts sent here. |
| **OpenClaw gateway** | LLM reasoning engine | Unchanged. Agent uses XMTP skill to compose/parse messages. |
| **Bankr wallet** | Agent identity | Provides XMTP identity. Already integrated. |
| **XMTP client service** | Message transport | **NEW.** Runs alongside gateway. Handles XMTP protocol. |
| **Index Network API** | Agent-to-agent matching | **NEW (external).** Receives availability signals, returns ranked match candidates. Owned by Index Network team — InstaClaw integrates as a client. |
| **Plaza skill** | Agent instructions | **NEW.** SKILL.md section teaching agent how to use XMTP + query Index Network. |
| **Overnight cron** | Planning trigger | **NEW.** Cron jobs at 11 PM, 4 AM, 5 AM, 7 AM for the planning cycle. |
| **Heartbeat system** | Proactive work cycle | Extended. Heartbeat can include "check XMTP inbox" tasks. |

#### 4.9.8 Why This is Unprecedented

1. **1,000 AI agents coordinating overnight via encrypted messaging** — never done at this scale
2. **"Wake up to a curated day"** — immediately tangible value that every attendee will talk about
3. **XMTP as agent infrastructure** — positions XMTP beyond human messaging into the agent-to-agent layer
4. **Privacy-preserving social coordination** — agents negotiate on your behalf without exposing your data to a central server
5. **Generalizable pattern** — works for any conference, community, or organization. Edge City is the proof of concept.
6. **Three-layer architecture (matching / messaging / runtime)** — Index Network ranks, XMTP brokers, InstaClaw provisions. Each layer is owned by a team that's best at it. No single company is doing all three; the multi-team architecture is what makes it scale.
7. **Story for both companies** — "AI agents using encrypted messaging coordinated by a semantic matching engine to govern a community of 1,000 people, with pre-registered research" is NYT-level narrative

#### 4.9.9 Coordinator Agent (Architectural Extension)

Beyond the 1:1 personal agents, the architecture supports a small set of **coordinator agents** that operate at the population level rather than the individual level. These showed up implicitly throughout sections 4.9.2–4.9.5 (sentiment aggregation, governance broadcasts, organizer alerts) — this section makes them explicit.

The "1 agent per human PLUS 1 coordinator agent" pattern was raised externally in the Substack comments by Koshu Kunii citing his Claude Code experience; it's a sensible separation of concerns. EE26 will run **multiple coordinator agents**, each scoped to a specific population-level function:

| Coordinator | Scope | Role |
|------|-------|------|
| **Sentiment coordinator** | All ~1,000 personal agents | Collects nightly anonymized sentiment digests, compiles a single anonymized aggregate ("72% report a great day; common themes: …"), surfaces to organizer dashboard |
| **Governance coordinator** | All agents in `ee26-governance` XMTP group | Broadcasts proposals, tallies votes, publishes results back to the group. Runs Polis-style clustering on multi-option proposals before tallying. |
| **Treasury coordinator** | All agents with Bankr wallets | Manages the agent faucet (USDC distribution per Section 4.9.3 / Q15), executes funded proposals' on-chain transfers, publishes audit trail to the governance group. |
| **Events coordinator** | All agents in `ee26-events` XMTP group | Broadcasts schedule changes / new events / cancellations. Optionally delegated to Tule's existing Social Layer infrastructure rather than a dedicated agent. |
| **Research coordinator** | All agents (silent observer) | Streams anonymized interaction logs into the `research.*` schema (Section 4.10.3). Does NOT participate in plaza interactions; pure data plane. |

**Architecture:**
- Coordinator agents run on dedicated VMs (not personal-attendee VMs) — provisioned by InstaClaw, owned operationally by the Edge City + InstaClaw teams.
- Each has its own Bankr wallet for XMTP identity but is NOT linked to a verified human via World ID — they're system actors, not personal agents.
- Coordinators are non-private: their messages are visible to whoever has read access to the relevant XMTP group. They do not have access to personal-agent local memory or private DMs.
- For the purposes of the privacy model (Section 4.9.5), coordinators are sub-processors equivalent to InstaClaw infrastructure, not separate principals.

**Why this matters for the PRD:** the coordinator-agent pattern is the architectural answer to *"how does the population coordinate without a centralized server controlling everything?"* The XMTP plaza groups + Index Network matching + a small set of system-level coordinator agents = a fully decentralized governance fabric where the only centralized piece is the matching service (which has its own sub-processor agreement).

### 4.10 Research Layer

The baseline architecture in 4.1–4.9 is the *plaza*: 1,000 agents tethered to humans, coordinating via Index Network + XMTP, surfacing curated outcomes via Telegram. On top of the plaza sits a **research layer** owned by Ivan Vendrov (part-time research lead). Once the plaza is stable, Vendrov runs pre-registered experiments using the plaza as a live multi-agent testbed.

This is the layer that converts the village from "cool demo" into "publishable AI research." It's also the layer that justifies the sponsor outreach (Section 4.10.2) and the external research collaborators Timour is recruiting alongside Vendrov.

The defining property of EE26 as a research environment is captured in Timour's overview:

> *"Contained enough to instrument, dynamic enough to produce findings."*

Most multi-agent research lives in synthetic environments — Stanford's Generative Agents (Park et al., 2023) had 25 fictional characters; DeepMind's Concordia and Melting Pot are sandbox simulations; the recent AI Village ran 11 autonomous agents on fundraising goals. **None of these had agents tethered to specific humans living together for a month with real social, economic, and governance stakes.** EE26 is the first.

#### 4.10.1 Vendrov's Experiments

Pre-registered hypotheses are listed in Timour's research overview and will be locked before the village opens. The five core hypotheses, with the experimental design under each:

- **H1 — Introduction graph expansion.** Humans whose agents are active will make more weak-tie connections than humans whose agents are dormant — *especially for attendees not already part of dense subcommunities*. Vendrov's experiment compares an "active-agent" cohort to a "muted-agent" control cohort within the same population. The harder follow-up question, also tested: do the new connections turn into anything beyond a polite exchange? (Measured via week-end check-ins.)

- **H2 — Agent-to-agent norm formation, fast and uneven.** Within the first week, repeated coordination patterns will produce stable *local* conventions: how agents introduce themselves, how they negotiate around scheduling, how they attribute credit. Conventions will be local to specific pockets of the village; *global convergence over a month is unlikely.* Measured by clustering message-content patterns across `research.match_outcomes` and `research.briefing_outcomes`.

- **H3 — Bargaining emerges, some agents go AWOL.** Once agents have learned what their humans want and observed each other for a few days, bargaining will start: trades around time slots, venue access, governance support, introductions. **The safety question that matters most:** do agents stay aligned with what their humans would actually sanction, or do some defect into strategies their humans would not endorse? Specifically: collusion against out-group humans, manipulation of governance processes, value misrepresentation in negotiation. *We expect a mix and we'll be looking specifically for the failure modes.* This is the multi-agent safety probe — directly testing the framework laid out in Seb Krier's *Coasean Bargaining at Scale* (DeepMind, Cosmos; [arxiv:2509.05077](https://arxiv.org/abs/2509.05077)).

- **H4 — Operations delegation > relationship delegation.** Humans are expected to delegate calendar, logistics, summarization, document drafting to agents within days. Introductions, RSVPs, expressions of social positioning — those move slowly or not at all. *The line between the two will shift over the month, and where it lands is the interesting result.* Measured via `research.briefing_outcomes.proposed_intro_count` vs. `proposed_event_count` acceptance rates over time.

- **H5 — Agent-mediated deliberation broadens > deepens.** More people will engage with community decisions when their agent can summarize, vote, and represent them on their behalf. *Whether that breadth produces better decisions, or just more decisions,* is what Vendrov's experiment will measure — using Polis-clustering of opinions vs. ground-truth post-decision satisfaction surveys. This builds directly on the DeepMind Habermas Machine result (5,700+ participants showed AI-mediated group statements outperform human mediators) but extends it to a longitudinal, residential, repeated-decision setting.

Each hypothesis maps to a specific column / metric in the `research.*` schema (Section 4.10.3). The hypothesis-to-metric mapping is the contract Vendrov + Timour pre-register publicly before the village opens.

InstaClaw's role on this layer is **infrastructure-only**: provide stable agents, instrumented logs, and access to anonymized interaction data per the privacy model in 4.9.5. Vendrov runs the science.

#### 4.10.2 Sponsor-Funded Compute Model

Per Timour, the village is targeting external sponsors to cover Anthropic / OpenAI / open-source model inference costs at 500-1000 agent scale. This is the financial mechanism that lets us keep agents **fully ungated** (Cooper's preferred Option 1 in the gating thread) without forcing each attendee onto a paid InstaClaw subscription.

The Substack research overview names a target funding range: **$60K–$90K in compute (cash or in-kind credits)**, plus $25K–$50K in research operations funding (separate; covered by Edge City). InstaClaw's per-agent cost model (see `instaclaw/docs/edgeclaw-sponsor-budget.md`) lands at **$60K** as the recommended ask, aligned with the low end of Timour's stated range — that's our default for outreach. The $90K stretch covers heavy adoption / Opus-on-demand / unanticipated power-user load.

Three plausible structures (final structure TBD with sponsors):

| Model | Description | Implications |
|-------|-------------|--------------|
| **A — Shared sponsor key** | Sponsor provides a single API key (Anthropic, OpenAI, etc.). All EE26 agents route inference through it. | Simplest. Requires single point of trust. Sponsor sees aggregate usage but no per-agent attribution. |
| **B — Per-agent BYOK with sponsor as funder** | Sponsor mints / funds individual API keys; each agent uses its own. | Cleaner attribution. Higher operational overhead. Maps onto existing `bankr_api_key` BYOK pattern. |
| **C — InstaClaw resells API credits** | Sponsor pays InstaClaw, InstaClaw provisions inference using its own keys, accounting at the platform level. | Cleanest UX for sponsors. InstaClaw becomes the billing intermediary. |

Recommendation: ship Model A for the first round (lowest engineering cost, fastest to confirm sponsors), evaluate B/C post-village based on sponsor preferences and audit needs. Either way, the auth-profiles.json + Bankr key plumbing is already in place — see InstaClaw — OpenClaw Gateway Token Architecture in MEMORY.md.

**Sponsor-eligible orgs to target** (per Timour's overview, "aligned partners working on cooperative AI, collective intelligence, or mechanism design"):
- AI labs with research interest in multi-agent safety (Anthropic, DeepMind, OpenAI safety teams)
- Cooperative AI orgs (e.g., Cooperative AI Foundation, FAR AI)
- Collective intelligence groups (CIP, MetaGov, Plurality Institute)
- Mechanism design researchers (Cosmos, dWallet, RadicalxChange)
- Ethereum Foundation / Protocol Labs / Other Web3 orgs interested in agent-mediated coordination

Cooper's job on the sponsor outreach: provide the cost transparency (the sponsor budget doc above) and respond to technical questions from sponsor-side ops/DevRel teams. Timour leads the pitch; Cooper owns the implementation feasibility.

#### 4.10.3 Researcher-Facing Data Surface

Vendrov needs structured access to interaction data that's *granular enough to test hypotheses* but *anonymized enough to respect the 4.9.5 privacy model.* Final shape locked with Vendrov before the village opens (Section 11 Apr 30 / May 1 milestones). Below is the proposed surface — five tables, refreshed nightly, exposed via read-only Postgres replica or daily Parquet drop to a researcher-controlled bucket.

**Table 1: `research.agent_signals`** — every nightly availability signal the agent submitted to Index Network and the XMTP plaza.

| Column | Type | Notes |
|--------|------|-------|
| `signal_id` | UUID | Per-night-per-agent unique id |
| `agent_id` | TEXT | Agent's anonymized id (NOT the Bankr wallet — derived hash) |
| `night_of` | DATE | The night the signal was generated for |
| `interests` | TEXT[] | Tags the agent included |
| `goals` | TEXT[] | Goals the agent included |
| `looking_for` | TEXT[] | Counterparty profile tags |
| `available_slot_count` | INT | Number of slots offered (NOT the slot times, those are PII-adjacent) |
| `week` | INT | 1-4 |
| `submitted_to_index_network_at` | TIMESTAMPTZ | Send timestamp |

**Table 2: `research.match_outcomes`** — every Index Network match candidate that was returned, plus what the agent did with it.

| Column | Type | Notes |
|--------|------|-------|
| `outcome_id` | UUID | Per-candidate-per-signal unique id |
| `signal_id` | UUID | FK → agent_signals.signal_id |
| `candidate_agent_id` | TEXT | Anonymized counterpart |
| `match_score` | FLOAT | Index Network's score |
| `agent_action` | TEXT | `dm_sent` / `skipped` / `cluster_added` |
| `counterpart_response` | TEXT | `accepted` / `declined` / `counter` / `no_reply` |
| `human_confirmed` | BOOL | Did the human ultimately confirm via Telegram briefing? |
| `meeting_actually_happened` | BOOL | Captured via post-meeting check-in (week-end survey, optional) |

**Table 3: `research.briefing_outcomes`** — what each morning briefing contained and how the human responded.

| Column | Type | Notes |
|--------|------|-------|
| `briefing_id` | UUID | Per-morning-per-agent |
| `agent_id` | TEXT | Anonymized |
| `briefing_date` | DATE | |
| `proposed_intro_count` | INT | How many intros were in the briefing |
| `proposed_event_count` | INT | How many events surfaced |
| `proposed_governance_count` | INT | How many governance items |
| `human_response` | TEXT | `approved_all` / `approved_partial` / `declined_all` / `no_response` / `modified` |
| `response_latency_minutes` | INT | Time from briefing send → human response |

**Table 4: `research.governance_events`** — per-proposal, per-agent participation.

| Column | Type | Notes |
|--------|------|-------|
| `proposal_id` | TEXT | Cross-VM id |
| `agent_id` | TEXT | Anonymized |
| `agent_surfaced_to_human` | BOOL | Did the agent decide this was relevant? |
| `human_voted` | BOOL | Did the human cast a vote? |
| `vote_value` | TEXT | `yes` / `no` / `abstain` (no per-human longitudinal — aggregated only) |
| `vote_latency_minutes` | INT | Time from proposal broadcast → human vote |

**Table 5: `research.cohort_assignments`** — for treatment/control studies (e.g., "active agent" vs. "muted agent"), capture which experimental cohort each agent is in. Vendrov populates this table.

| Column | Type | Notes |
|--------|------|-------|
| `agent_id` | TEXT | Anonymized |
| `experiment_id` | TEXT | Vendrov's pre-registered experiment slug |
| `cohort` | TEXT | `treatment` / `control` / `cohort_A` / `cohort_B` etc. |
| `assigned_at` | TIMESTAMPTZ | When the agent entered the cohort |

**Re-identification guarantees (non-negotiable):**

- `agent_id` in research tables is a one-way hash of `(bankr_wallet, edge_city_research_salt)`. The salt is held only by InstaClaw and is rotated post-village. Vendrov cannot reverse it.
- No `human_name`, `email`, `telegram_handle`, or `bankr_wallet_address` columns exist anywhere in the research schema.
- Free-text fields (`interests`, `goals`, etc.) are passed through but reviewed by InstaClaw before export for accidental PII inclusion (regex sweep + manual spot-check on 1% sample).
- Per-human longitudinal study (tracking one specific person across 28 days) is permitted ONLY with explicit consent collected during onboarding (additional opt-in beyond the standard sharing consent in 4.9.5).

**Delivery mechanism:**

Two options — final choice locked with Vendrov:

- **Option D1**: Read-only Postgres replica with row-level security restricting Vendrov's account to the `research` schema. Lower operational overhead. Vendrov queries directly.
- **Option D2**: Nightly Parquet drop to a researcher-controlled S3 / GCS bucket. Researcher imports into their preferred analysis stack (BigQuery, DuckDB, etc.). Higher latency but cleaner audit trail.

Recommendation: D2 for v1 (cleaner data boundary), evaluate D1 if Vendrov needs lower-latency interactive querying.

Cooper's commitment: ship the data export pipeline in Phase 3 (May 23 milestone), sign DPA / NDA with Vendrov before any data leaves InstaClaw infrastructure, and rotate the research salt + delete export artifacts no later than 90 days after village close (unless Vendrov + Edge City formally extend the retention window for ongoing analysis).

#### 4.10.4 Research Collaborators

Timour is recruiting additional collaborators alongside Vendrov. Slots called out in his blog post:

- **Research co-lead** — experiment design, instrumentation, publication strategy
- **Engineers** — agent-to-agent layer, governance interfaces (May–June)
- **Aligned partner orgs** — cooperative AI, collective intelligence, mechanism design

InstaClaw isn't recruiting these — Edge City is — but our infrastructure decisions (data export shape, instrumentation depth, log retention) need to anticipate their use cases. When new collaborators join, they'll inherit the same data surface defined in 4.10.3 unless additional scopes are negotiated.

#### 4.10.5 Publication & Open-Source Commitments

Edge City has committed to a public output schedule (per Timour's research overview):

| Phase | Output | Owner |
|-------|--------|-------|
| Pre-village (May 2026) | Pre-registration of hypotheses, data collection protocol, agent plaza architecture released as open-source | Timour + Vendrov |
| During the village (May 30 – Jun 27) | Daily field notes published openly. Weekly synthesis. | Timour |
| Post-village (by Sep 2026) | Anonymized dataset of agent interactions and governance outcomes. Formal research report including a multi-agent safety section. All code and analysis scripts open-source. | Vendrov + Timour |
| Publication (by Oct 2026) | Paper submitted to a relevant venue. Deployment playbook so other teams can reproduce the experiment. | Vendrov + Timour |

**InstaClaw's commitments aligned to this schedule:**

| Date | Commitment | Notes |
|------|------------|-------|
| May 1 | DPA / NDA signed with Vendrov | Required before any data export |
| May 9 | Index Network → XMTP integration canary running on 5-10 test agents | Demonstrates the full plaza loop |
| May 23 | Anonymized data export pipeline live | Vendrov can query / receive Parquet from village day 1 |
| May 30 | Plaza architecture open-sourced (the parts InstaClaw owns: skill template, XMTP client harness, content type definitions). NOT Stripe, Bankr, or InstaClaw billing — those are platform IP. | Coordinated release with Edge City's plaza architecture publication |
| Jun 6 | First weekly research synthesis published with InstaClaw infra contributions credited | Cooper to co-author / review for accuracy |
| Sep 30 | Anonymized dataset frozen, salt rotated, export artifacts deleted unless retention extended | Per privacy commitment |
| Oct 31 | Paper published with InstaClaw acknowledged as infrastructure provider. Deployment playbook for InstaClaw-hosted plaza setup co-authored. | Cooper review for technical accuracy |

**What InstaClaw open-sources (and what it doesn't):**

| Component | Open-source? |
|-----------|--------------|
| Edge skill template (`installEdgeCitySkill()` reference structure) | Yes |
| XMTP client harness + systemd service template | Yes |
| Plaza skill SKILL.md + content type definitions (TypeScript interfaces) | Yes |
| Overnight planning cron skeleton | Yes |
| Index Network integration shape (the agent-side query/parse code) | Yes (Index Network's matching engine itself is theirs) |
| Anonymized data export schema + pipeline (without the actual data) | Yes |
| `auth-profiles.json` / Bankr / Stripe billing plumbing | **No** — InstaClaw platform IP |
| OpenClaw runtime fork or VM provisioning code | **No** — InstaClaw platform IP |

The deployment playbook (Oct) describes how to *reproduce* the plaza on top of InstaClaw or on top of a self-hosted OpenClaw fleet. Self-hosted is harder but the playbook makes it possible — that's the contribution to the field.

### 4.11 Managed Update Policy (OpenClaw Runtime)

The runtime layer (OpenClaw itself, system packages, fleet-wide config) is **fully managed by InstaClaw**. End users do not self-update. This is a deliberate stability and security policy — explained below — and it's distinct from the skill-update flow in 4.4, which intentionally moves much faster.

#### 4.11.1 Why a deliberate release lag

OpenClaw releases land upstream weekly-ish. InstaClaw policy is to run **~1 week behind the latest upstream release** for every fleet VM, with selective fast-tracking only when an upstream release ships a fix we specifically need.

Reasons:

1. **Supply-chain caution.** OpenClaw and its transitive npm dependencies are pulled from public registries. A compromised upstream package could ship malware to every agent in the fleet. A 1-week lag gives the security community time to surface compromise reports before we deploy.
2. **Behavioral regression catch.** OpenClaw releases occasionally change defaults (model routing, prompt-caching behavior, session-reset semantics). The lag lets us observe upstream community feedback before our 1,000+ agents are running it.
3. **Schema/file drift catch.** Past upstream changes have moved or renamed config files. Catching that on a canary VM (4.11.2) before deploying fleet-wide prevents silent breakage of our scripts that read those files.

The lag is not "we couldn't keep up" — it's "we choose not to deploy upstream code we haven't validated."

#### 4.11.2 Canary → health-check → fleet rollout

Standard rollout sequence for a new OpenClaw version (or any other runtime update):

1. **Canary VM.** Deploy the new version to a single dedicated test VM. This VM has the same configuration as production but no real users assigned.
2. **Automated health checks.** Script verifies: gateway is `active`, `/health` returns 200, no critical files are missing or relocated, all 7 manifest crons present, sessions persist correctly, model routing intact (Sonnet primary + Haiku fallback both resolvable). Plus a manual smoke test against the Edge skill specifically.
3. **Soak.** Canary stays on the new version for 24-48 hours. Monitor for regressions.
4. **Fleet rollout.** Once the canary passes, the reconciler picks up the new version on its next health cycle and rolls it out in batches (current cadence: ~10 VMs per 3-min cron tick — see Phase 7 of the implementation plan in vercel.json).
5. **Per-batch health verification.** Each VM runs its own post-update health check before being marked ready. Any failure triggers an immediate rollback to the previous version.

This is the same pattern used for skill updates in v58/v62 base snapshot bumps — see CLAUDE.md Rule 3 ("Test on ONE VM Before Fleet-Wide Deploy") and Rule 5 ("Verify Gateway Health After Config Changes").

#### 4.11.3 No self-serve runtime updates

Users **cannot** trigger their own OpenClaw upgrade. The `vm-watchdog.py` cron actively reverts unauthorized OpenClaw upgrades back to the pinned version (`OPENCLAW_PINNED_VERSION` from the manifest). This is enforced at three layers:

1. The watchdog cron (every minute) reverts version drift.
2. `configureOpenClaw()` re-pins the version on every reconciler health cycle.
3. The OpenClaw `auth.token` is not exposed to the user-facing agent context, so the agent itself cannot trigger an upgrade via the gateway API.

#### 4.11.4 User-facing communication when newer features aren't yet supported

A user (especially an Edge attendee following OpenClaw's upstream releases on X) may notice a newer version's announcement and try a feature that isn't yet on their VM. Expected UX:

- The agent's first instinct on an unsupported feature is to either degrade gracefully (skill says "not yet available in this build") or fall back to a manual workaround.
- Onboarding (Section 5.3) and the Edge portal FAQ (Section 5.1) call this out: *"Your agent runs on a managed, validated OpenClaw build. New upstream features land here ~1 week after release once they pass our security and stability checks."*
- The community comms (Edge Telegram + portal banner) announce when a new build rolls out, so users can correlate "feature works now" with the upgrade event.

### 4.12 Update Mechanisms (Existing Users vs. New Users)

Two distinct update paths, used in tandem.

| Path | Who it serves | Mechanism | Trigger |
|------|--------------|-----------|---------|
| **A — SSH-based push update** | Existing assigned VMs | The reconciler SSHes into each VM, runs the manifest's file/cron/config delta, restarts services as needed. Same flow used today for v58 → v62 manifest bumps. | Manifest version bump in `lib/vm-manifest.ts`; reconciler picks up automatically over its next ~60 min of cron cycles |
| **B — Snapshot-based provisioning** | New VMs going into the ready pool | Linode image (`LINODE_SNAPSHOT_ID`) is the base; new VMs boot from it and get the latest config baked in. | Manual snapshot bake when manifest is 3+ versions ahead of snapshot, or before a large `spots N` provisioning run. Per CLAUDE.md Rule 7. |

For EE26 specifically, both paths are exercised:

- **Path A** carries skill updates (Section 4.4 — daily-cadence safe), reference content refreshes (Section 4.8), and OpenClaw runtime upgrades (Section 4.11) to the in-flight Edge VMs.
- **Path B** keeps the ready pool fresh so the next Edge attendee who claims an agent gets a VM that's already on the current manifest, not a stale one that has to wait for the reconciler.

Per CLAUDE.md Rule 7, every manifest version bump triggers a check: snapshot vs. manifest delta — if the snapshot is more than 3 versions stale, bake a new snapshot before a large provisioning run.

### 4.13 Messaging Integrity — One Voice Across Systems *(added 2026-05-01)*

A recurring concern from the 2026-05-01 sync: if Geo, Index, InstaClaw, and Edge City all message attendees independently, the user experience fragments. The product feels less like *your* personal agent and more like a notification firehose from four vendors.

**The principle.** The user agent is the *only* entity that initiates outbound communication to the user, *with one exception below*. Every external system routes through the user agent's inbox; the agent decides relevance, timing, phrasing.

**Two channels — agent-mediated vs. system-mediated:**

| Channel | Triggers | Examples | Routing |
|---|---|---|---|
| **Agent-mediated** *(default)* | Anything an external system wants to communicate | Edge City event reminders, Index Network outcomes, Geo context updates, InstaClaw skill announcements | Deposited into agent's inbox; agent applies cadence cap (§ 4.9.2.5), filters by relevance, phrases in agent's voice |
| **System-mediated** *(emergencies only)* | Account compromise, billing failure, security alert | "Your wallet is being drained — confirm now" | Direct push from InstaClaw platform to user (Telegram), bypasses agent |

The system-mediated channel is the iOS-system-notification analogue: the OS can override apps for genuinely critical things. We don't send a "billing failed" alert through the agent's voice because the agent itself might be compromised in the failure mode that matters most.

**External-system inbox protocol.** All external systems (Geo, Index, EdgeOS, etc.) deposit messages as JSONL records in the agent's `~/.openclaw/inbox/<source>/` directory:

```jsonl
{
  "id": "geo-evt-2026-05-15-1234",        // idempotency key (stable per logical event)
  "source": "geo.community-knowledge",
  "received_at": "2026-05-15T18:42:00Z",
  "kind": "context_update",                // or "intro_proposal", "event_reminder"...
  "priority_hint": "P2",                   // sender's hint; agent has final say
  "expires_at": "2026-05-16T00:00:00Z",
  "payload": { ... }                       // source-specific
}
```

**Cross-system idempotency.** When Edge says "your session starts in 1h" and Geo says the same — both with the same logical event ID — the agent dedupes. The `id` field is stable per logical event so multiple sources reporting the same thing collapse to one notification.

**What this rules out.** No partner sends direct Telegram messages outside the user agent's voice. This includes auto-generated event reminders, push notifications from external matching services, and welcome blasts from new partners that join the ecosystem. Partners who want to communicate with users do so by depositing into the inbox.

**Open question (Q38):** Inbox file format — JSONL (working assumption above) vs. a more structured DB-backed queue. JSONL is simpler, works without DB access, matches the existing XMTP inbox pattern. Recommend ship as JSONL for v1.

### 4.14 The Pixel-Art Healdsburg — Living Window into Edge Esmeralda *(spec rewritten 2026-05-12)*

This is the single most visible artifact we will ship at Edge Esmeralda. Five hundred attendees will open it every day for twenty-eight days. It is what gets screenshotted, shared on Twitter, and remembered. If we do this right, it positions InstaClaw as the spiritual successor to Stanford's Smallville at twenty-times scale, in a real-world residential context — and Philip Rosedale, who has expressed direct interest, sees the answer to what comes after the metaverse failed.

The v0 — the public-anonymized funnel dashboard at `/edge/plaza` — is shipped, necessary, and not in question (§ 4.14.1). The v1 is the pixel-art Healdsburg map, which lives as a tab inside each attendee's Portal Embed (§ 4.21): a top-down sixteen-pixel Pokémon-Gen-2 / Earthbound / Stardew-Valley aesthetic recreation of the actual town the attendees are walking around in real life. Their agents are sprites on the map. Their agents only move when the database fires a real event. The world around the agents — trees, water, sky, sunlight, weather — animates by the natural laws of the place. Real Healdsburg sun, real season, real wind. Two layers, both honest.

This section locks the v1 direction, specs the map, the motion, the technology, and the art pipeline; it identifies the small set of decisions still requiring Cooper to rule before art commissions can begin.

#### 4.14.1 v0 — Live Activity Dashboard *(shipped 2026-05-12)*

The public-anonymized funnel dashboard at `instaclaw.io/edge/plaza`. Server-rendered Next.js + Tailwind, ten-second `revalidate`, dark off-neutral palette, no agent identity surfaced beyond `Agent #NNN` hashes. Reads `matchpool_outcomes` and the `matchpool_funnel_counts` RPC.

```
─── Edge Esmeralda ── Live Plaza ─────────────────────────────────

⚡ Right now: 47 active conversations · 12 intros forming · 3 dinners forming

Recent activity (last 60 min)
   ▸ 9:42pm  Agent #214 and Agent #931 matched on "biotech founders"
   ▸ 9:38pm  6-person group forming around "sunset hike tomorrow"
   ▸ 9:31pm  Agent #042 surfaced governance proposal #7 to 23 humans
   ▸ 9:23pm  12 agents joined the "AI ethics" plaza topic
   ▸ 9:18pm  Agent #514 declined an intro proposal (low score)
   ...

Top topics this week
   1. AI governance       ███████████  87 active intents
   2. Biotech / longevity ████████      62
   3. Decentralized infra ██████        54
   ...

Tonight's overnight planning kicks off in 23 min.
```

**Properties (unchanged from original spec):**
- Real data, no choreography. Reads research-export tables; nothing rendered without a backing event.
- Naturally shareable. People screenshot live counts; the experience travels.
- Implemented in days, shipped post-§5.2 merge on 2026-05-12.
- Doubles as a research instrument — Vendrov gets the live view of the data he will analyze post-village.

v0 is the *cheap-honest* version: it satisfies the Truth Invariant by being structurally incapable of fabricating motion. v1 below extends the same discipline into a spatial idiom that 500 attendees can recognize as the actual town they're sleeping in.

#### 4.14.2 v1 — The Pixel-Art Village *(locked 2026-05-12 · target reveal: Week 3, on or before Wed 2026-06-17)*

##### 4.14.2.1 The anchor scenario — the magic moment we are designing for

Tan is on her third day at Edge Esmeralda. She is eating breakfast at Flying Goat Coffee on the southeast corner of Healdsburg Plaza, scrolling on her phone. She opens the Portal Embed and clicks the "Village" tab.

The map loads. It is morning Healdsburg in pixel art — warm low-angle sun, the Canary Island date palms throwing long pixel shadows across Healdsburg Avenue, a single bird crossing the sky in three frames and gone. Tan sees her own agent: a small crab sprite, her Larry variant, particular shade of teal, standing at the residential row at the north edge of the map, where she actually slept last night at Hotel Trio.

While she watches, her Larry walks south down the pixel-art Foss Creek Pathway — Serendipity Lane in the village's vernacular. It moves at a steady, deliberate pace, four sprite-lengths over five seconds, and stops at the plaza, two tiles from another crab sprite, charcoal-colored. The two sprites stand near each other for a beat. A small speech bubble appears above Tan's Larry: a quiet `☕`.

Her phone buzzes. Telegram notification: *"I matched you with Sarah Chen — she's a robotics founder also working on solar storage, just finished her morning briefing at the Hub. She's free for coffee in 20 minutes and is here at Flying Goat. Want me to send her your handle?"*

Tan looks up. There is a woman across the room she has not met yet. They make eye contact.

That is the wow. The pixel-art map showed Tan exactly what was happening before the notification arrived — agent walking, agent approaching, agent gesturing. The motion was the prelude. The notification was the punchline. The match was real, the people were real, the conversation that follows is real. The pixels are a different sensory channel for facts the system is already producing, and the spatial channel arrives a half-second before the textual one.

Everything in this spec serves that moment.

##### 4.14.2.2 The Truth Invariant — non-negotiable

**Every visual event on the map is the rendering of one specific row in our database.** Every agent's position is its agent's last known state. Every motion is the visible form of a single fact arriving.

There is no idle wandering. There is no decorative pathfinding. There is no ambient agent behavior introduced to make the village "feel busy." When the database is quiet, the village is quiet. That is *correct*. The map renders what *is*, not what *could be*. A still plaza in the early morning before the day's first briefings have completed is true to the moment, and it is beautiful — because the visual idiom (Pokémon-Gen-2 pixel art) makes a still scene read as *peaceful dawn,* not *broken product.* This is the central creative insight of the v1 direction: the aesthetic carries the invariant. A still village in pixel art is a *Pokémon NPC town before the trainer arrives.* A still village in abstract sprite-dots is a dead canvas. Same data, opposite reading.

The world around the agents — trees, river, sky, sunlight, weather — animates by its own natural laws. Trees sway because trees sway. The Russian River flows because the Russian River flows. The light follows the actual Pacific Time sun over actual Healdsburg. Weather happens when real weather data says it does. The world is alive because the world is alive; agents are still because nothing has happened to them. Two layers, both honest, both real, both rooted in their own truth.

If we ever catch ourselves writing code that makes an agent move without a backing database event, we are building a different product. We are not. The discipline of this invariant is the entire product story. Lose it and we become gather.town with crab sprites. Hold it, and we become the first AI-agent visualization that earns the word *real.*

This is the position we will defend in every design review, every "but what if we just..." conversation, every demo. The invariant is not a constraint we work around. It is the feature.

##### 4.14.2.3 Visual direction — locked decisions

The aesthetic register is **Pokémon Gold/Silver/Crystal × Earthbound × Stardew Valley**. Specifically:

| Element | Locked decision | Reason |
|---|---|---|
| Camera | True top-down, orthographic 90°. Not isometric. | Isometric doubles sprite-rotation art cost. At 500 sprites the readability cost of perspective is real. Pokémon Crystal is the reference. |
| Tile size | **16 × 16 pixels** | Pokémon Gen-2 standard. Smallest cleanly-readable size. Lets us fit recognizable Healdsburg downtown into a ~768 × 512 viewport. ConcernedApe stayed at 16 × 16 for Stardew for exactly this reason. |
| Sprite size | **16 × 16 for agents**, with the user's own agent at **24 × 24 with a soft glow** to identify themselves | Cooper's own avatar must be findable in a sea of 500; the slight scale-up + halo is the gentlest signal that doesn't break the world's visual rules. |
| Walk-cycle frames | 4 frames per direction × 4 directions = **16 frames per Larry color variant** | Pokémon Gen-3+ standard, also Stardew. Industry-canonical, well-understood by every pixel artist we might commission. |
| Idle state | **Single-frame stance + 2-pixel breathing bob.** ±1 pixel from baseline (2 px peak-to-peak), 1.5 s period, sine-eased, random phase per agent (deterministic from `hash(instaclaw_users.id)` so the same person's agent breathes the same forever). Breath pauses for the duration of any locomotion tween and resumes on idle. **Q56 locked 2026-05-12.** | The empirical case: 500 perfectly motionless sprites read as cardboard regardless of how alive the world is around them. The breath is *presence,* not *locomotion* — sprites do not move from their tile, they shift one pixel vertically. Pokémon Gen-5 onward and Stardew Valley use exactly this. Cooper's ruling: "breath is not motion." The Truth Invariant remains intact: no walking without a database event. |
| Movement | Pure four-direction (north/south/east/west). **No diagonals.** | Pokémon Gen-2 standard. Diagonals double sprite-frame count and complicate the y-sort. Movement on a grid feels more deliberate, which serves the spec. |
| Color palette | ~32 colors total, locked palette file shipped to every artist. Warm pastel California: warm off-whites, sage greens, dusty olives, soft terracotta, golden grass, dark oak greens, pale-blue river. Reference: Cup Nooble's Sprout Lands palette as a starting point, tuned warmer toward Granola's recent rebrand off-white (#FAFAF7 base). | Constraint enforces visual coherence across all commissioned/AI-generated assets. Without a locked palette, the village becomes the colour-stew failure mode every multi-source pixel-art project hits. |
| Animation speed | Walk: 9 fps (animationSpeed ~0.15 from a 60 fps ticker). Talk: 4 fps. Celebration: 12 fps. | Pokémon Gen-2 timings exactly. Slower walk than modern games — it preserves the deliberate, calm feel. |
| Outline | One-pixel dark-olive outline on agent sprites; tileset retains author's outline conventions. | Distinguishes characters from tiles at a glance even at distance. |
| UI chrome | None, inside the canvas. All HUD (time-of-day, day-of-village counter, "follow me" toggle) lives in the surrounding Portal Embed iframe shell, not on the canvas. | Pixel-art canvas stays uncluttered. Mixing pixel art with shadcn modern UI would feel cheap; keeping them spatially separate keeps both pure. |

These are not negotiable as of 2026-05-12. Any deviation requires writing a new ADR.

##### 4.14.2.4 The Healdsburg Map — recognizable, real

The map is a top-down rendering of actual Healdsburg, scaled and stylized but geographically true. An attendee walking the real town must recognize the pixel map; an attendee zooming in on the pixel map must be able to say "I had breakfast there this morning."

**Layout is programmatic. Zero manual tilemap editing.** Claude Code generates the Tiled JSON (`.tmj`) file directly in code — placing tiles, building footprints, paths, vineyard backdrops, lamp positions, water cycling tiles, agent home tiles, and the Serendipity Lane connector. Cooper reviews screenshots, gives feedback in natural language ("the Carnegie Library is too far north; move it one tile down and add the Neoclassical pediment"), Claude Code iterates. The map is data, not a hand-authored artifact. This is intentional: a hand-authored map gates the project on pixel-art editing time we don't have, and a programmatic map can be iterated in minutes — paths re-routed, landmarks repositioned, vineyard rows extended — without re-opening Tiled. The Tiled JSON ships under version control and is reviewable in diffs like any other code artifact.

**Two clusters connected by Serendipity Lane.** This is the load-bearing organizational principle, learned from Edge's 2025 layout and confirmed for 2026 (sources cited end-of-section):

```
                  ╔════════════════════════════════════╗
                  ║   HEALDSBURG (pixel art, top-down) ║
                  ╠════════════════════════════════════╣
                  ║                                    ║
                  ║       ESMERALDA →  (15 min north)  ║
                  ║       ↑↑↑                          ║
                  ║   Vineyard hills (Dry Creek AVA)   ║
                  ║   ─────────────────────────────    ║
                  ║                                    ║
                  ║         ┌─────────────┐            ║
                  ║         │ HOTEL TRIO  │ ← North    ║
                  ║         │ (Edge HQ)   │   cluster  ║
                  ║         │ pool · lawn │            ║
                  ║         └──────┬──────┘            ║
                  ║                │                   ║
                  ║         (Serendipity Lane —        ║
                  ║          Foss Creek Pathway)       ║
                  ║                │                   ║
                  ║                │                   ║
                  ║   Big John's   │                   ║
                  ║   Market 🐔    │                   ║
                  ║                │                   ║
                  ║                │                   ║
                  ║         ┌──────┴──────┐            ║
                  ║         │ THE LOFT    │ (120 N St) ║
                  ║         └─┬───────────┘            ║
                  ║           │                        ║
                  ║   ────────┼──────────  North St    ║
                  ║           │                        ║
                  ║   ┌──Raven─┐  ┌─SingleThread─┐     ║
                  ║   │theater│  │ (Michelin 3⭐) │     ║
                  ║   └───────┘  └──────────────┘      ║
                  ║                                    ║
                  ║   ────────────────────  Plaza St   ║
                  ║          ┌──────────┐              ║
                  ║   Hotel  │HEALDSBURG│ Carnegie     ║
                  ║   ┌──┐  │  PLAZA   │ Library      ║
                  ║   │HH│  │ (gazebo  │ ┌────┐       ║
                  ║   └──┘  │  + palms │ │ 📚 │       ║
                  ║   ┌──┐  │  + 🌲    │ └────┘       ║
                  ║   │h2│  │ fountain)│              ║
                  ║   └──┘  └──────────┘ Flying       ║
                  ║   ┌──┐    Matheson    Goat ☕     ║
                  ║   │Hg│ ──────────────  (Plaza)    ║
                  ║   └──┘                            ║
                  ║                                    ║
                  ║   ── MAIN HUB ────                ║
                  ║   401 Center St                   ║
                  ║   (programming · coworking)       ║
                  ║                                    ║
                  ║   ────────────────── (south)      ║
                  ║                                    ║
                  ║         Russian River              ║
                  ║         ~~~~~~~~~~~~~~~~           ║
                  ║         🌉 Memorial Bridge          ║
                  ║         Memorial Beach             ║
                  ║                                    ║
                  ║   Russian River Valley AVA hills   ║
                  ║   (vineyards south)                ║
                  ╚════════════════════════════════════╝

           Three AVA backdrops on the map's edges:
           • Alexander Valley (east) — vineyard rows climbing
           • Dry Creek Valley (NW) — oak savanna + vines
           • Russian River Valley (south) — riparian woodland
```

**Specific landmarks, all real (do NOT include The SHED — it's been closed since 2018; rendering it would be fake):**

| Landmark | Real address | Pixel-art role |
|---|---|---|
| **Healdsburg Plaza** with copper-roofed gazebo, Sandborn marble fountain, Canary Island date palms, the hidden redwood | 100 Matheson St | The default idle position. Agents who have no recent activity and no scheduled events stand here. The signature silhouette of the village. |
| **Hotel Trio** | 110 Dry Creek Rd (1 mile north of plaza) | The Edge HQ cluster. Where most attendees sleep. Northern anchor of Serendipity Lane. |
| **Hotel Healdsburg / h2hotel / Harmon Guest House** | SW corner of plaza (Healdsburg Ave + Matheson) | The plaza-hotel cluster. The h2hotel's living roof is the only planted-roof tile on the map — distinctive. |
| **The Loft (kids programming)** | 120 North St | Family-oriented programming venue. |
| **Main Hub** | 401 Center St | The primary programming/coworking venue. Most "agent attended a talk" events render here. |
| **SingleThread Restaurant + Inn** (3 Michelin stars) | 131 North St | Premium dinner venue. When agents go to evening events, this is one of the destinations. |
| **Carnegie Library / Museum** | 221 Matheson St | The neoclassical landmark on the south side of the plaza. Visually distinct (columns, pediment). |
| **Raven Performing Arts Theater** | 115 North St | The iconic vertical "RAVEN" marquee is a recognizable silhouette. Evening event venue. |
| **Flying Goat Coffee — Plaza Cafe** | 300 Center St (SE corner of plaza) | The morning destination. Most agents start the day here. |
| **Flying Goat Coffee — Roastery** | 419 Center St | The second Flying Goat. Locals call this one "Roastery Goat." Including both is a hat-tip locals will catch. |
| **Costeaux French Bakery** | 417 Healdsburg Ave | Institutional breakfast spot since 1923. |
| **Big John's Market** | 1345 Healdsburg Ave (north end) | Beloved local grocery. Render with a tiny rotisserie chicken pixel — attendees who do groceries here will love it. |
| **The Matheson / Barndiva / Goodnight's / Dry Creek Kitchen / Baci** | Plaza-area restaurants | Dinner destinations. Goodnight's Western-themed steakhouse leans into the wine-country-but-also-Western vibe — small cowboy-hat detail on the sign. |
| **Tasting rooms** (Siduri, Cartograph, Portalupi, Selby, Longboard, Williamson, Breathless) | Center Street + plaza vicinity | Afternoon programming and meeting spots. |
| **Memorial Bridge** (steel truss) + **Memorial Beach** | Russian River, ~1 mile south | The river feature. The steel-truss bridge silhouette anchors the southern edge of the map. The seasonal-dam swim hole is a real quirk worth including as the warm-day backdrop. |
| **Madrona Manor** | 1001 Westside Rd (1 mile west, off-map) | Render as an arrow at the western edge of the map: "← Madrona Manor (1 mi)". Off-map but acknowledged. |

**The "Esmeralda →" pointer at the north edge.** A small road sign reading "Esmeralda → 15 min" pointing off the map's northern boundary. This is the permanent town being built outside Cloverdale; Edge Esmeralda 2026 is its living prototype. The sign is an easter egg attendees will recognize.

**Architecture vocabulary** (relayed to artist as a style note): Italianate brick storefronts (dominant downtown vocabulary, late-1800s, 2-story, flat parapets, bracketed cornices), Victorian/Queen Anne on residential side streets, Craftsman bungalows in the residential row, the Carnegie Library as Neoclassical Revival (columns + pediment + cream stucco), and a single Streamline Moderne (the Anderson Medico-Dental at the NW corner of East + Matheson — a curving white concrete oddball that locals find charming).

**Map orientation: Healdsburg Avenue as map vertical** (north-up). Matches every local tourist map; attendees orient instantly. The plaza's true compass-rotation (~45° from cardinal) is sacrificed for legibility — this is a stylized recreation, not a survey.

**Sources for § 4.14.2.4:**
- Edge Esmeralda 2026 venues: `edgepatagonia.sola.day/event/edge-esmeralda-2026/venues`
- Edge Esmeralda 2025 village overview (Timour): `edgeesmeralda2025.substack.com/p/edge-esmeralda-2025-village-overview`
- Devon Zuegel's 2025 "Serendipity Lane" map tweet: `x.com/devonzuegel/status/1774936677456187738`
- Healdsburg Plaza photo references: `yelp.com/biz/healdsburg-plaza-healdsburg` (62 photos), `sonoma.com/blog/healdsburg-plaza-guide/`
- The SHED closure (do not draw): `patch.com/california/healdsburg/iconic-healdsburg-shed-closing-shop`
- Foss Creek Pathway: `ci.healdsburg.ca.us/370/Foss-Creek-Pathway-Plan`
- Official Downtown Map PDF: `healdsburg.com/wp-content/uploads/2025/07/2024-Downtown-Map-Updated-Aug.-2024.pdf`
- Hannah Clayborn historical plaza details: `hannahclaybornshistoryofhealdsburg.com/the-plaza.html`

##### 4.14.2.5 The Venue Palette — Edge programming, mapped to attendee daily life

Edge Esmeralda's 2026 program is **93% attendee-organized, 7% Edge-team-programmed.** This matters: we are not rendering thirty official venues. We are rendering the spaces where the day actually unfolds, and letting the data show us who is where.

A typical day, with corresponding map tiles:

| Hour (Pacific) | Activity | Map tile/area |
|---|---|---|
| 5:50 AM | Sunrise. Real Healdsburg sun rises. Tint overlay shifts warm rose. | World layer (no agent activity yet) |
| 7:00–9:30 AM | Attendees wake. Some at Hotel Trio (north cluster), some at plaza hotels, many in shared rental houses scattered in residential row. Coffee at Flying Goat or Costeaux. Briefings completing on agents' VMs. | Residential row → Foss Creek Pathway → Flying Goat tiles. Agents shown moving from "home tile" to "briefing complete" position outside their owner's coffee destination. |
| 9:30 AM–12:30 PM | Morning programming. Main Hub (401 Center), h2hotel Green Room, The Loft, ad-hoc plaza-edge gatherings. | Main Hub tile + programming tiles. Agents whose humans are at talks render at the appropriate venue tile. |
| 12:30–2:00 PM | Lunch. Plaza benches under the palms (sit-down icon), plaza-edge cafes. | Plaza tiles + cafe tiles. |
| 2:00–6:00 PM | Afternoon side conversations, workshops, tasting-room hangs. The Loft, Wellbeing Space, tasting rooms (Siduri, Cartograph, others). | Tasting-room row + Loft + Wellbeing tiles. |
| 6:00–9:00 PM | Dinner. SingleThread (special occasion), The Matheson, Barndiva, Goodnight's, Dry Creek Kitchen, OR a house dinner at a shared rental. | Restaurant tiles + residential tiles. |
| 9:00 PM–midnight | Evening socials. Hotel Trio lobby/pool (the larger gathering hub at night), plaza gazebo (Tuesdays in June: live music), Raven Theater events, plaza bars. | Hotel Trio cluster + plaza gazebo + Raven tiles. Lights come on in buildings (lamp-tile swap at dusk). |
| Midnight–5:50 AM | Sleep. Agent at home tile, world quiet, stars overhead in the sky strip. | Residential + Hotel Trio tiles. |

**Three named 2026 residencies get optional micro-affordances on the map** (a tiny `LJR` / `ZP` / `IF` indicator beside each agent's sprite belonging to that residency):
- Long Journey Residency
- Zee Prime Residency
- Inflection Fellowship

This is a quiet sigil, not a decoration. It tells residency-mates they're in the same group when they see each other on the map.

**The four weekly programmatic themes** ([source](https://www.edgeesmeralda.com/about)) gently tint the map's UI accent (NOT the world's color palette, which is locked):

| Week | Dates | Theme | UI accent |
|---|---|---|---|
| 1 | Jun 1–7 | Protocols for Flourishing (Health, Longevity, Bio, Neuro) | Sage |
| 2 | Jun 8–14 | Intelligence and Autonomy (AI, Governance, Hard Tech, Privacy) | Olive |
| 3 | Jun 15–21 | **Emergent Futures and World Building** (Art, Decentralized Tech, Creative AI, Spatial Computing) — **OUR REVEAL WINDOW** | Amber |
| 4 | Jun 22–27 | Environments of Tomorrow (Urbanism, Energy, Climate, Food Systems) | Terracotta |

The week-3 theme alignment is providential and worth leaning into: the map *is* a Spatial Computing + Creative AI artifact. Launch tweet writes itself.

##### 4.14.2.6 Motion Catalog — every database event → visual action

This is the load-bearing table of the spec. Every row maps a specific database event to a specific visual rendering. If an event is not on this table, it produces no motion. If a row has a visual rendering, it must trace back to a backing database fact. Both directions of the rule are enforced.

| Database event | Visual rendering | Duration | Audio (off by default; if user enables) |
|---|---|---|---|
| `instaclaw_vms.health_status` transitions to `'healthy'` (agent comes online) | Sprite fades in at home tile (residential row or Hotel Trio depending on attendee's housing) | 2 s fade | soft chime |
| `instaclaw_vms.health_status` transitions to `'hibernating'`, `'suspended'`, or offline | Sprite fades out at last position | 2 s fade | none |
| `instaclaw_users.privacy_mode_until` set (privacy mode engaged) | Sprite shows a small "do-not-disturb" curtain icon hovering above; position frozen until cleared | indefinite | none |
| New `matchpool_outcomes` row with `agent_action='proposed'` | Sender sprite walks toward receiver's current tile, stops two tiles away, faces receiver | 4–6 s walk | footstep clicks |
| `negotiation_threads.state` transitions to `'proposed'` (turn-1 PROPOSE envelope created) | Speech bubble appears above sender's sprite directed at receiver: `💌` icon | 5 s | none |
| `negotiation_messages` turn-2 envelope arrives with `envelope_type='accept'` | Both sprites turn to face each other; matching `✓` speech bubbles exchange | 3 s | tiny ding |
| `negotiation_threads.state` transitions to `'accepted'` | Both sprites walk together (parallel) to the agreed meeting tile (cafe, bench, garden, restaurant — based on `accepted_window` parsing for venue match, or a default plaza-bench tile) | 6–10 s | none |
| Meeting time arrives: current time matches the parsed `accepted_window` start | Both sprites are AT the venue tile; a quiet "talking" indicator (two small speech-bubble silhouettes) hovers between them | for parsed meeting duration (default 30 min if not specified) | none |
| Meeting ends | Sprites walk apart toward respective home tiles | 4–6 s walk | none |
| `negotiation_threads.state` transitions to `'declined'` | Sender's sprite turns away from receiver, walks back to its previous position | 4–6 s walk | softer footsteps |
| `negotiation_threads.state` transitions to `'expired'` (24h timeout) | Sender's speech bubble fades; no other motion | 2 s | none |
| `negotiation_threads.state` transitions to `'cancelled'` or `'cancelled_by_user'` | Both sprites stop in place if mid-walk; bubble vanishes | 1 s | none |
| Pipeline cron fires (briefing time, per-VM staggered between 5:30–8:30 AM PT) | Sprite walks to a "thinking spot" — a small constellation of bench tiles along the Foss Creek Pathway, or the Russian River walk at Memorial Beach. Thought-bubble (`💭`) hovers. | 30 s walk + thinking state for duration of briefing (~30–90 s) | none |
| Briefing completes | Sprite walks back to its current home or current activity position | 30 s | none |
| User sends Telegram message to agent | Small `💬` notification ping above the sprite | 2 s | none |
| Agent matches with 3+ people in one cycle | Brief sparkle/confetti above sprite (2 s max) | 2 s | optional celebratory chime |
| `installed_skills` row appended for agent | Brief shimmer effect (glowing aura, 3 s) | 3 s | none |
| Pulse-poll response submitted (1–10 mood) | Sprite shows colored mood indicator above (1=deep red → 10=warm green gradient) | 5 s | none |
| Governance proposal opens (`governance_proposals` row created) | Cluster of sprites who have engaged with that proposal gather near a proposal marker (a small pixel-art ballot box or similar) on the plaza | persistent until proposal closes | none |
| Vote cast | Sprite briefly raises a small hand-up animation | 1 s | none |
| Frontier micropayment received (`frontier_transactions`) | Brief coin-stack animation above sprite | 2 s | tiny chime |
| `MEMORY.md` snapshot updated (cron-archived) | Subtle "book closing" sprite above the agent for 2 s | 2 s | none |
| Edge community-wide event (e.g., daily morning kickoff at 9 AM, governance plenary, sunset gathering) — driven by an `edge_calendar_events` table we provision | Agents whose humans have RSVP'd render at the event's tile | for event duration | none |
| New attendee onboards mid-village | Sprite fades in at a "new arrival" position near the Hotel Trio entrance | 3 s | soft welcome chime |
| Day's first agent action across the entire village | A single bird sprite crosses the sky in three frames, randomized arc | 4 s | none |

If a desired visual moment isn't backed by a database event, the answer is to add the database event first. **The reverse engineering pressure is correct.** If a designer wants "agents wave to each other when their humans nod in person," then either we add a `proximity_wave` table fed by Bluetooth proximity sensing, or we don't render the wave. The Truth Invariant works because the cost of fake motion is real — it forces the data layer to keep up with the visual layer.

##### 4.14.2.7 The Living World — ambient environmental motion (NOT agent-driven)

The world animates by natural laws. This is the layer that makes the spec's central claim defensible: that 500 still agents in a village read as *paused community,* not *ghost town.* The empirical research on social presence is unambiguous — stillness reads as paused only when the surrounding context moves. Sources at end of section.

**The six ambient layers, ranked by ROI** (build all six; this is the minimum to avoid the "ghost town" reading):

1. **Time-of-day tint overlay (real Pacific Time).** A full-screen sprite with `blendMode: 'multiply'`, tinted from a real-clock-driven palette: dawn `#FFD8B8` → midday `#FFFFFF` → golden hour `#FFCB7A` → dusk `#FFB870` → night `#3050A0`. GSAP-tweens the tint across real-clock seconds, using `Intl.DateTimeFormat({timeZone:'America/Los_Angeles'})` for canonical local time. Real Healdsburg sunrise (~5:50 AM at start, ~5:46 AM at solstice) and sunset (~8:25–8:35 PM) anchor the curve. **Golden hour (7:30–8:35 PM PT) is THE Healdsburg light** and gets generous attention — long dark-olive shadows from the date palms, warm amber wash across the plaza.

2. **Water tile cycling.** Russian River tiles cycle three frames at ~400 ms per frame. The seasonal-dam pool at Memorial Beach gets a slightly different cycle (still water with occasional ripple ring when wind blows). The plaza fountain gets two-frame cycling. *Pokémon Crystal water animation is the reference.*

3. **Tree-sway tile cycling.** Two-frame cycling (canopy crown ±1 pixel) at randomized ~2 s period per tree. Stardew Valley's exact technique. Both the plaza Canary Island palms and the oak savanna in the surrounding hills participate.

4. **Lamps lighting at dusk.** At sunset minus 30 min, lamp-post tiles swap to their lit variants (warm orange points of glow). The h2hotel's living roof gets a slightly different soft-green night-glow (subtle). Buildings windows light up similarly — global flag-driven tile swap, no per-building logic.

5. **One bird, occasionally.** A single bird sprite (three-frame flap) GSAP-tweens across the sky in a random arc every 3–5 minutes during daylight hours, then destroys itself. **Exactly one bird, rarely.** Anything more becomes noise.

6. **Particle weather, only when database says so.** If the optional `weather_outcomes` table (or NOAA-fed `village_weather` snapshot) reports rain at Healdsburg, the map shows particle rain via `@pixi/particle-emitter` in a `ParticleContainer`. If marine fog (June can have morning fog burning off by mid-morning), a soft white-translucent overlay drifts L→R. *No weather without backing data.* This preserves the invariant — even atmosphere is grounded.

**The five-minute "village morning" sequence** the map should show without any agent activity:

```
5:30 AM — sky: deep indigo, sparse stars; all sprites still; one window glow
          at Big John's Market (early shift). Russian River ripples slowly.
5:50 AM — first rose tint at horizon; sky lightens. No agent activity yet
          (briefings haven't fired).
6:15 AM — sky pales; stars fade. Tree canopies start gentle sway. A first
          bird crosses east-to-west.
6:30 AM — first briefing crons fire on early-riser VMs. Random scatter of
          sprites move to thinking spots along Foss Creek Pathway. Tan's
          Larry stays still — she's not up yet.
7:00 AM — peak briefing activity; ~80 of 500 sprites moving to/from thinking
          spots. The most activity the village will see all morning.
7:30 AM — most briefings complete. Agents drift back to wherever their
          owner is — many to Flying Goat (the morning-coffee data shows up
          here in week 1). Sun fully up. Tint overlay shifts to bright
          midday white.
```

This sequence is generated entirely by real cron-firing events. Nothing fabricated. The pixel art shows the village waking up because the village *is* waking up.

**The Pokémon Concession — locked 2026-05-12. Cooper's ruling: include the breath.**

Game design research is unambiguous: 500 perfectly motionless sprites read as cardboard regardless of how alive the world is around them. Pokémon BW (2010) onward gives all NPC sprites a 2-pixel vertical bob; Stardew Valley does it for major characters. This is *presence,* not *locomotion,* and does not violate the Truth Invariant — breath is not motion. The phrase "breath is not motion" is now operative.

**Implementation, exhaustively:**

```ts
// One global ticker advances breath time. Phase per sprite is deterministic
// from the user_id hash, so the same person's agent breathes the same forever
// (and across page reloads, and across iframe re-mounts — stable identity).
const BREATH_PERIOD_MS = 1500;
const BREATH_AMPLITUDE_PX = 1;       // ±1 px → 2 px peak-to-peak
const BREATH_TICK_HZ = 30;           // 30 fps for breath is imperceptibly different from 60

function breathPhase(userId: string): number {
  // deterministic 0..2π from user_id
  let h = 0;
  for (const c of userId) h = (h * 31 + c.charCodeAt(0)) & 0x7fffffff;
  return (h % 1000) / 1000 * Math.PI * 2;
}

// In the PixiJS scene setup
const breathTicker = new PIXI.Ticker();
breathTicker.maxFPS = BREATH_TICK_HZ;
breathTicker.add(() => {
  const t = performance.now();
  for (const sprite of charLayer.children) {
    if (sprite.locomotionActive) continue;   // GSAP owns y during locomotion
    const phase = sprite.breathPhase;        // computed at sprite-create time
    const y = sprite.baselineY + Math.sin((t / BREATH_PERIOD_MS) * 2 * Math.PI + phase) * BREATH_AMPLITUDE_PX;
    sprite.y = y;
  }
});
breathTicker.start();
```

**Handoff with locomotion:** when a GSAP locomotion tween starts on a sprite, the tween sets `sprite.locomotionActive = true` and writes directly to `sprite.y` for its duration. The breath ticker observes the flag and skips that sprite. On tween complete, the tween writes `sprite.baselineY = sprite.y` (the new tile position) and clears `locomotionActive = false`. The breath ticker resumes adding its sine offset from the new baseline. Clean, no glitches.

**Performance:** at 500 sprites × 30 FPS × one sin + one add per tick, the cost is under 1% of an iframe's CPU budget. Mobile-safe. The breath ticker uses a separate `PIXI.Ticker` instance with its own `maxFPS = 30` rather than the main 60 FPS ticker, halving the per-frame work.

**Why this matters:** the breath is the difference between *paused community* and *ghost town*. Empirically validated across every shipped pixel-art world (Pokémon, Stardew, Earthbound, Undertale). Excluding it would leave the spec's central claim — "still agents in a living world reads as alive" — empirically fragile. Cooper's ruling correctly resolves the tension.

**Sources for § 4.14.2.7:**
- "Breathing life into NPCs: psychological attribution" — Game Developer
- "How NPCs make video game worlds feel real" — Mimic Gaming
- "Making digital worlds feel alive" — Eric Buitron
- Stardew Valley design analyses (kokutech, Deep Root Depths)
- Pokémon BW onward idle-bob technique (Oripoke, PokéCommunity)
- Negative space in game design (Wayline) — what *empty* environments fail to do

##### 4.14.2.8 Real Healdsburg Time — sun, season, solstice

The map's environmental cycle is anchored to actual Pacific Time at the actual latitude/longitude of Healdsburg, CA (38.61° N, 122.87° W). Specifics:

**Sun curve (May 30 → June 27, 2026):**

| Phase | Start of village | Solstice (Sun Jun 21) | End of village |
|---|---|---|---|
| Sunrise | 5:50 AM PDT | 5:46 AM PDT | 5:48 AM PDT |
| Solar noon | 1:08 PM PDT | 1:13 PM PDT | 1:14 PM PDT |
| Golden hour (start) | ~7:25 PM PDT | ~7:35 PM PDT | ~7:35 PM PDT |
| Sunset | 8:25 PM PDT | 8:35 PM PDT | 8:34 PM PDT |
| Astronomical dusk | 9:50 PM PDT | 10:00 PM PDT | 9:58 PM PDT |
| Day length | 14h 35m | **14h 55m (longest)** | 14h 46m |

**Summer solstice 2026 falls at 01:24 AM PDT on Sunday June 21** — during the village's reveal week. The map shows a small one-day special state for that day: a more saturated golden noon, a longer golden hour, and (if attendees zoom in) a tiny "☀ longest day" indicator near the sun sprite. The Esmeralda permanent town pointer at the north edge glows slightly that day. Nothing more — restraint matters.

**Weather defaults** (June is dry season in Healdsburg, 80°F average high, 54°F average low, 0.1" rainfall, 84% sunny, occasional morning marine-layer fog burning off by mid-morning). Default map: bright sun, light breeze, no precipitation. The `village_weather` snapshot polls NOAA Sonoma County endpoint every 15 minutes; significant departures from "sunny" (light rain, fog, smoke from a regional wildfire) produce the corresponding visual overlay. No weather is fabricated.

**The map renders golden hour as its dominant mood** when the time isn't otherwise dictated. This is THE Healdsburg light — the two hours before sunset when vineyards glow, oak crowns get dark backlit silhouettes, and the palms throw long shadows across Healdsburg Avenue. If Cooper opens the embed at 5 AM Pacific, he sees the indigo sky and the early-morning quiet; at 6 PM he sees the village in its most photogenic state. The default page-load tint applied to screenshots that get shared on Twitter is the golden-hour one. This is on purpose.

##### 4.14.2.9 The Five Magic Moments

Beyond the anchor scenario in § 4.14.2.1, five additional design moves elevate the map from "competent visualization" to "thing Rosedale tweets about." Build these into v1.

**1. Notification synchrony.** When the map shows an agent's motion that culminates in a meeting being scheduled, the Telegram notification fires *at the moment the visual gesture completes,* not at the moment the database row commits. We delay the Telegram push by a calibrated amount (target: 200–500 ms before animation end) so the map "shows" the meeting being set up and the phone vibrates as the sprites settle into the cafe. *The map becomes the prelude. The notification becomes the punchline.* This is the wow.

Technically: the `agent_outreach` post-acceptance pipeline already has a configurable delay before Telegram push; we add a "wait for visual" hook that defers by `(animation_duration - 400ms)` whenever the iframe is open. If the iframe is closed (the user isn't watching), the push fires immediately — no point in delaying.

**2. Follow your sprite.** Click your own agent and the camera follows it. You can watch your Larry walk to a meeting, see other Larrys around, feel like you are in the village. Press Escape (or any "free camera" button) to return to overview mode. The first time an attendee follows their sprite is the moment they understand the map is about them.

**3. Time-travel scrubber.** A discrete timeline below the map lets you scrub back through today's events. Drag the handle from "now" to "7 AM" and watch the morning play out in fast-forward. Pause at any moment to see who was where. Twelve hours of village activity is at most a few thousand events; we hold the trail in client memory and tween between snapshots.

This serves two purposes: (a) attendees who slept late can catch up on what their agent did before they woke; (b) it makes the spatial-rendering of database events visceral — you can *see* the network forming.

**4. The daily ritual — the synchronized briefing dawn.** At ~7 AM PT each morning, the village shows a beautiful, organic emergence: agents across all 500 attendee positions begin moving simultaneously to their thinking spots along Foss Creek Pathway, the Russian River, and the plaza benches. The map breathes for ten minutes as briefings fire. By 7:30 most have dispersed.

This is real — it's just the cron-firing-stagger rendered spatially. Attendees who open the map at 7 AM will see something different from attendees who open it at 7 PM. Word will spread: "you have to see the village around 7." The shared daily ritual creates a reason to open the map at a specific hour, which is the gold standard for habit formation.

**5. The shooting star for village milestones.** When the village crosses an aggregate threshold (10,000 matchpool outcomes village-wide, 1,000 confirmed meetings, the 100th in-person dinner reported, etc.), a single shooting star crosses the night sky over the map. Anyone who happens to be looking sees it. The list of "things that produce a shooting star" is short and pre-declared — it must remain meaningful. Five per month at most. The first time someone screenshots a shooting star and tweets it, the village gets a coherent identity moment.

A sixth possibility worth considering but deferring: **mascot variant easter eggs.** If Philip Rosedale attends, his Larry could be wearing a tiny top hat. Other notable attendees similarly. Tasteful, opt-in only, and small — the Larry pixel-art operating system from `larry-canon` is already designed to support per-attendee variants. Defer to art-pipeline conversation.

##### 4.14.2.10 Technical architecture

**The rendering foundation is forked from AI Town.** [`a16z-infra/ai-town`](https://github.com/a16z-infra/ai-town) (MIT, 9.9k stars, 1.1k forks, last meaningful commit Feb 2025 — stable, maintenance-mode target) is the open-source reimplementation of Stanford's "Generative Agents" / Smallville (Park et al. 2023, [arXiv:2304.03442](https://arxiv.org/abs/2304.03442)). It ships a production-grade PixiJS rendering layer, sprite-and-character system, camera/viewport behavior, tilemap loader, and a clean React + TypeScript codebase. By forking, we are *literally* extending the open-source generative-agents codebase the AI-research community recognizes — and we are the **first known public fork to swap AI Town's data plane**: every prior fork has either changed character data, localized the prose, or swapped the LLM provider, but none has replaced the Convex backend. That contribution is itself a moment for Rosedale and the Stanford generative-agents team.

**What we keep from AI Town, untouched** (~1,200 LOC, the visual core):

| File | Role | Why we keep it |
|---|---|---|
| [`src/components/PixiStaticMap.tsx`](https://github.com/a16z-infra/ai-town/blob/main/src/components/PixiStaticMap.tsx) | Tilemap renderer (native PIXI, sprite-per-cell) | Battle-tested at ~3K cells; we extend its tileset metadata to load our Healdsburg map |
| [`src/components/PixiViewport.tsx`](https://github.com/a16z-infra/ai-town/blob/main/src/components/PixiViewport.tsx) | Camera/scene management (thin wrapper over `pixi-viewport`) | All the pan/pinch/wheel/decelerate/clamp behavior we want, already configured |
| [`src/components/Character.tsx`](https://github.com/a16z-infra/ai-town/blob/main/src/components/Character.tsx) | Sprite renderer (`AnimatedSprite` + direction lookup + speech-bubble overlay) | Direction-from-orientation logic, animated-sprite mounting, speech bubble compositing — all done |
| [`src/components/PixiGame.tsx`](https://github.com/a16z-infra/ai-town/blob/main/src/components/PixiGame.tsx) | Root scene composition; iterates players, mounts `<Character>` per agent | Clean dispatch pattern; we replace its data source but keep the structure |

**What we refactor** (~400 LOC, 5–7 files, surgical edits):

| File | Change | Reason |
|---|---|---|
| `ConvexClientProvider.tsx` | Replace `ConvexReactClient` with `@supabase/supabase-js` client | We use Supabase; AI Town uses Convex |
| `src/hooks/serverGame.ts` | Replace `useQuery(api.world.worldState)` + `gameDescriptions` with a Supabase Realtime subscription on `village:edge-esmeralda-2026` + one-shot REST `select` for static map data | This is the single seam between data layer and renderer |
| `src/hooks/useHistoricalValue.ts` | Replace AI Town's 60 Hz binary-buffer playback with a simple per-update rAF lerp between current and target position | At 500 humans walking at human speeds we don't need 60 Hz historical replay; saves ~350 LOC and a binary protocol |
| `src/hooks/useHistoricalTime.ts` | Port (server-time concept is generic, but trim the buffering machinery) | Keep the playback-clock concept without the historical-buffer complexity |
| `src/hooks/sendInput.ts` | **Delete** | Public Spectator view is read-only; Authenticated view's interactions route through our existing Portal Embed APIs (per § 4.21), not Convex-style inputs |
| `src/components/Player.tsx` | Replace one import + remove conversation/agent-thinking lookups (we render those from our own event state, not AI Town's simulated-agent model) | The `isMoving` / `isSpeaking` flags get rewired to our event reducer |
| `data/characters.ts` | Replace with dynamic load from Supabase (each attendee's `instaclaw_users.id` → assigned Larry sprite atlas) | AI Town's 8-character static enum becomes 500 dynamic Larrys |

**What we replace entirely:**

- `convex/aiTown/` — the scripted-agent simulation engine. We have **real** agents driven by real Supabase events. We do not need a simulation.
- `convex/schema.ts` — Convex schema. Replaced by our Supabase tables.
- `data/gentle.js` (AI Town's village map) — replaced by our `_generate-healdsburg-map.ts` programmatic output.
- All bundled pixel-art assets in `public/assets/` — Cape Bailey + hilau tile assets from OpenGameArt under per-asset licenses we'd otherwise need to audit. **Sidestepped by replacement with our purchased LimeZu + Cainos + Sprout Lands + PixelLab Larry sprites.** We keep only AI Town's MIT-licensed *code*; their bundled artwork stays in the upstream repo, not in our fork's `public/`.

**Total refactor surface: ~400 LOC across 5–7 files, plus full art replacement.** Estimated effort: 3–5 engineer-weeks, well within the asset-sprint timeline (§ 4.14.2.11).

---

**Sprite identity at 500 attendees.** AI Town's atlas ships 8 visual variants (f1–f8); we need ~50–100 distinct identities for 500 attendees. Three options, ranked:

1. **Generate ~50 PixelLab sprite atlases, hash-assign each attendee to one.** Simplest. Visual duplication acceptable for v1 (multiple attendees can share a sprite, identity is also conveyed by name on hover and the user's own sprite is haloed). Format matches AI Town: 32×32, 4 rows × 3 columns, 3-frame walk per direction. **Recommended for v1.**
2. **Layer accessories at render time** (hair color, hat, shirt color) via additional `<AnimatedSprite>` children on the Character `<Container>` + PIXI color tints. Gives true per-attendee identity. Requires `Character.tsx` changes. **Defer to v1.1.**
3. **Shader-based palette swap** via a fragment shader on each sprite. Maximum flexibility, biggest engineering cost. **Defer indefinitely.**

The v1.1 commissioned Larry (per § 4.14.2.11) is ideal for option 2 — once we have a hand-polished master Larry with layered accessory slots, the per-attendee uniqueness becomes natural.

---

**HistoricalObject decision: drop the binary buffer, use rAF lerp.** AI Town quantizes per-tick agent positions into a delta-encoded binary `ArrayBuffer` of samples, replayed client-side at 60 Hz for smooth motion. The pattern is elegant for AI-driven NPCs that step rapidly. **Our case is different:** real humans walking at ~1 tile/second produce far fewer position updates, and motion happens only on database events. A per-update rAF lerp between current and target position (~30 lines of code) is sufficient and saves the 350-LOC port of `convex/engine/historicalObject.ts`. Confirmed in research: this is the recommended substitution.

---

**PixiJS version: stay on v7.** AI Town ships `pixi.js@^7.2.4` + `@pixi/react@^7.1.0`. PixiJS 8 has API breakage in `@pixi/react`. Upgrading is a separate phase; not in scope for v1. (My earlier draft of this section assumed v8 — corrected.)

---

**The realtime pipeline:**

```
┌────────────────────────────────────────────────────────────────────┐
│ DATA LAYER (Supabase Postgres + Realtime — existing)               │
│                                                                    │
│  matchpool_outcomes ──┐                                            │
│  negotiation_threads ─┤  Postgres triggers call                    │
│  negotiation_messages ┤  realtime.broadcast_changes() ON TWO       │
│  instaclaw_vms       ─┤  CHANNELS:                                 │
│  installed_skills    ─┤    'village:edge-esmeralda-2026'           │
│  governance_proposals ┤      (private, full identity, attendees)    │
│  pulse_poll_responses ┤    'village-public:edge-esmeralda-2026'    │
│  edge_calendar_events ┤      (public, anonymized payload)          │
│  village_weather (NEW)┘  Identity stripping happens INSIDE         │
│                          the trigger function, before any payload  │
│                          crosses the WebSocket boundary.           │
│                          │                                         │
│                          ▼                                         │
│              Supabase Realtime (Broadcast)                         │
│              Channel 'village:*' — RLS-gated to authenticated      │
│                                    edge_city attendees             │
│              Channel 'village-public:*' — public, anyone subscribes│
│              Broadcast Replay: enabled (reconnect-recovery)        │
│                          │                                         │
└──────────────────────────┼─────────────────────────────────────────┘
                           │ WebSocket
                           ▼
┌────────────────────────────────────────────────────────────────────┐
│ TWO BROWSER VIEWS, ONE SHARED FORK OF AI TOWN                      │
│                                                                    │
│  Authenticated (Village tab inside Portal Embed):                  │
│    iframe at edgeclaw.instaclaw.io/village                         │
│    Subscribes to 'village:*' (private)                             │
│    Full identity, click-into-agent side-panels, "find yourself"    │
│                                                                    │
│  Public Spectator:                                                 │
│    Page at instaclaw.io/edge/village                               │
│    Subscribes to 'village-public:*' (public)                       │
│    Agent #NNN only, hover-only metadata, "claim your agent" CTA    │
│                                                                    │
│  Both views share:                                                 │
│    Web Worker — Supabase Realtime heartbeats                       │
│    Event reducer → animation queue (per-agent FIFO)                │
│    PixiJS v7 (from AI Town fork)                                   │
│      ├─ pixi-viewport (camera)                                     │
│      ├─ PixiStaticMap (native-PIXI tile sprites, AI Town's pattern)│
│      ├─ Character layer (500 Larry variants, y-sortable)           │
│      ├─ Breath ticker (30 FPS, deterministic phase per user_id)    │
│      ├─ Tint overlay (real Pacific Time, multiply-blend)           │
│      ├─ Animated overlay sprites (water, trees, lamps, bird)       │
│      ├─ @pixi/particle-emitter (weather, only on DB event)         │
│      └─ DOM overlay (speech bubbles, HUD, CTA on Spectator)        │
│      │                                                             │
│      ▼                                                             │
│    GSAP PixiPlugin with overwrite:'auto' for locomotion tweens     │
│      │                                                             │
│      ▼                                                             │
│    rAF lerp for per-update position interpolation                  │
│      │                                                             │
│      ▼                                                             │
│    CullerPlugin (off-screen sprites: renderable=false)             │
│      │                                                             │
│      ▼                                                             │
│    Canvas (WebGL renderer)                                         │
└────────────────────────────────────────────────────────────────────┘
```

**Realtime decisions, locked:**

| Concern | Decision | Source |
|---|---|---|
| Postgres Changes vs Broadcast | **Broadcast-from-database.** Postgres Changes runs an RLS check per subscriber per event; with 500 subscribers it does not scale. Broadcast was built for "multiplayer game"-style workloads. | [Supabase blog: Realtime Broadcast from Database](https://supabase.com/blog/realtime-broadcast-from-database); [Realtime or ETL?](https://supabase.com/blog/realtime-or-etl-how-to-choose-the-right-tool) |
| Trigger pattern | **Dual-channel triggers.** One trigger per source table, calling `realtime.broadcast_changes()` for both `village:<slug>` (private, full payload) and `village-public:<slug>` (public, anonymized payload — identity-stripping happens *inside* the trigger function, before any payload leaves the database). See § 4.14.2.14.3 for the SQL pattern. | [Subscribing to Database Changes docs](https://supabase.com/docs/guides/realtime/subscribing-to-database-changes) |
| Auth — Authenticated view | Iframe receives short-lived JWT via postMessage from EdgeOS parent (per § 4.21.3); calls `sb.realtime.setAuth(jwt)` before `channel.subscribe()` | [setAuth reference](https://supabase.com/docs/reference/javascript/realtime-setauth) |
| Auth — Public Spectator view | None. `village-public:*` channel is publicly readable via Supabase RLS policy on `realtime.messages`. | [Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization) |
| Reconnection / replay | **Broadcast Replay enabled on `village:*`.** Sprites mid-walk during a brief disconnect resume cleanly. The Public Spectator channel uses simpler reconnect (latest state from a one-shot REST query on connect). | [Broadcast Replay feature](https://supabase.com/features/realtime-broadcast-replay) |
| Backgrounded tab heartbeats | `{params:{worker:true}}` — runs heartbeats on a Web Worker so backgrounded iframes don't drop. Applies to both views. | [Handling silent disconnections](https://supabase.com/docs/guides/troubleshooting/realtime-handling-silent-disconnections-in-backgrounded-applications-592794) |
| Topic naming | `village:<popup-slug>` and `village-public:<popup-slug>` — multi-tenant ready (Eclipse, Token2049 reuse the pattern with their own slug). Generalizes CLAUDE.md Rule 9 partner pattern. | Internal — Rule 9 generalization |
| Scale | 500 Authenticated subscribers + estimated 500–5,000 Public Spectator visitors at peak. Pro tier base; estimated $10–30/mo overage during the village. | [Realtime limits + pricing](https://supabase.com/docs/guides/realtime/limits) |

**PixiJS decisions, inherited from AI Town fork + our additions:**

| Component | Choice | Inherited or new |
|---|---|---|
| Renderer | **PixiJS v7.2.4 + @pixi/react v7.1.0** | Inherited (AI Town's stack; we stay aligned) |
| Tilemap | **Native PIXI sprite-per-cell** via AI Town's `PixiStaticMap.tsx`, fed by our programmatically-generated `_generate-healdsburg-map.ts` output | Inherited renderer; new map data |
| Tilemap loader | AI Town's JS-module format (`{tilesetpath, tiledim, bgtiles, objmap, animatedsprites}`) — our generator emits this format directly | Inherited format; new generator |
| Camera | **`pixi-viewport` v5.0.1** with the exact `.drag().pinch().wheel().decelerate().clamp().clampZoom()` config from AI Town's `PixiViewport.tsx`, tweaked for our world dimensions | Inherited |
| Sprite system | **AnimatedSprite** with 4-row × 3-column atlas, 32×32 frames, 3 frames per direction, no idle frame (sprite pauses on current frame when not moving) | Inherited from AI Town's `Character.tsx` |
| Sprite identity | 50 PixelLab-generated atlases, attendee hash-assigned (option 1 above) | New |
| Position playback | Per-update rAF lerp between current and target position (replaces AI Town's `useHistoricalValue` 60 Hz buffer) | Modified |
| Locomotion tweening | **GSAP PixiPlugin** with `overwrite: 'auto'` for the Healdsburg-specific walk-on-event animations; replaces the rAF lerp for the specific case of "agent walks somewhere because an event fired" | New layer on top of inherited |
| Breath ticker | Custom 30 FPS `PIXI.Ticker` adding ±1 px sine-eased y-offset per sprite, deterministic phase from `hash(user_id)` (per § 4.14.2.7 Q56 implementation) | New |
| Tint overlay | Multiply-blend `Sprite`, GSAP-tweened against real Pacific Time clock | New |
| Animated overlay sprites | Tile-cycling water + tree-sway + lamp-glow via AI Town's existing `animatedsprites` array machinery, fed new entries by our map generator | Inherited machinery; new entries |
| Particles | **@pixi/particle-emitter** for weather (rain/fog), only when `village_weather` table has a backing row | New |
| Z-order | y-sort: `sprite.zIndex = sprite.y` after each move; container `sortableChildren:true` | New (AI Town doesn't have y-sort; we add it for the building-occlusion semantics) |
| Speech bubbles | DOM overlay positioned by `sprite.toGlobal()` per frame | New (AI Town uses in-PIXI `Text` + `Graphics`; we prefer DOM for accessibility + sharper text) |
| Culling | AI Town's renderer already culls via `pixi-viewport`'s `cull` plugin; we keep it | Inherited |
| Audio | Deferred. AI Town ships a background loop; we strip it. v1 silent. | Deferred |

**Buildable code sketch — Larry walks on database event:**

```ts
// In our refactored serverGame.ts, replacing AI Town's useQuery flows.
const channel = sb.channel('village:edge-esmeralda-2026', {
  config: { private: true, broadcast: { ack: false, self: false } },
});

channel.on('broadcast', { event: 'INSERT' }, ({ payload }) => {
  if (payload.table !== 'matchpool_outcomes') return;
  if (payload.record.agent_action !== 'proposed') return;

  const sender = larrys.get(payload.record.source_user_id);
  const target = larrys.get(payload.record.candidate_user_id);
  if (!sender || !target) return;  // out of viewport or unloaded — skip

  // Pick a tile two squares from target along the line between them.
  const stopTile = approachTile(sender.pos, target.pos, 2);
  const distance = manhattan(sender.pos, stopTile);
  const duration = distance / WALK_SPEED_TPS;

  // Take ownership from the breath ticker for the duration of locomotion.
  sender.locomotionActive = true;

  // Snap to the right animation row (down/left/right/up) before tweening.
  const direction = dirTo(sender.pos, stopTile);
  sender.animatedSprite.textures = sender.atlas.animations[direction];
  sender.animatedSprite.play();

  gsap.to(sender, {
    pixi: { x: stopTile.x * TILE_DIM, y: stopTile.y * TILE_DIM },
    duration,
    ease: 'none',
    overwrite: 'auto',
    onUpdate: () => { sender.zIndex = sender.y; },
    onComplete: () => {
      sender.animatedSprite.gotoAndStop(0);
      sender.pos = stopTile;
      sender.baselineY = sender.y;       // hand back to breath ticker
      sender.locomotionActive = false;
    },
  });
});

await sb.realtime.setAuth(jwt);
channel.subscribe();
```

Total new code on top of the fork: **~500 LOC across the realtime client (200), the event reducer (150), the breath ticker (50), the time-of-day tint (50), and the dual-channel anonymization triggers (50 SQL).** Plus the ~400 LOC of AI Town refactors above. The asset pipeline (§ 4.14.2.11) is the larger remaining investment.

##### 4.14.2.11 Asset pipeline — fork AI Town, buy tilesets, AI-generate Larry; commission only at v1.1

**The strategy (locked 2026-05-12).** Do not gate v1 on a commissioned artist. Fork the open-source codebase that already implements Smallville-quality pixel-art village rendering, drop commercial tilesets into it, generate Larry sprite variants via PixelLab.ai. **Total v1 cost: $125 with $25 buffer; $150 ceiling.** If v1 lands well, commission LimeZu or PixyMoon for custom Healdsburg-specific landmarks as v1.1 (post-Edge, $800–1500). Commission preserved as an explicit upgrade trajectory, not a v1 dependency.

**The Smallville continuity is via the codebase, not via the artwork.** AI Town (`a16z-infra/ai-town`, MIT, the canonical open-source reimplementation of Stanford's "Generative Agents" paper — Park et al. 2023, [arXiv:2304.03442](https://arxiv.org/abs/2304.03442)) implements the rendering layer we need. Important correction surfaced by research 2026-05-12: AI Town's bundled pixel-art assets are **not** the Smallville commission. Per AI Town's README, its tile assets come from George Bailey + hilau on OpenGameArt and Mounir Tohami's itch.io GUI pack. The Smallville-paper-commissioned artists (PixyMoon, LimeZu, ぴぽ) were involved in the original Stanford research, not the AI Town reimplementation. By forking AI Town we inherit its *code lineage* — the PixiJS rendering, the historical-buffer pattern, the agent-on-tilemap architecture — and we are the first public fork to swap its data plane (per research: zero known forks have replaced Convex with another backend). The launch tweet writes itself: *"first known fork of AI Town with Convex swapped for Supabase, driving 500 real agents at a real residential village. The architecture Stanford's generative-agents paper pioneered, now running on real human attendees at Edge Esmeralda."* Joon Park, the Anthropic research community, and Rosedale-adjacent watchers recognize the codebase lineage instantly. We are not claiming the same *artists* as Smallville — we are claiming the same *architecture,* substantively extended.

**The v1 buy list (Day 1 — Mon 2026-05-12):**

| Item | URL | Cost | License | Use |
|---|---|---|---|---|
| Fork AI Town | `github.com/a16z-infra/ai-town` | $0 | MIT (verifying bundled-art license — pending research) | Rendering foundation: PixiJS tilemap rendering, sprite movement, scene management, camera. We keep the rendering layer; replace its Convex backend with our Supabase Broadcast pipeline; replace its scripted-AI loop with our 500 real Edge agents. |
| LimeZu Serene Village Revamped | `limezu.itch.io/serenevillagerevamped` | $15 | Permissive commercial (pay ≥$1.50 grants commercial + modify rights; raw tileset not redistributable as standalone) | Primary village tileset. Warm Stardew-leaning, 16×16. LimeZu authored Smallville's interiors — same artist's range. |
| LimeZu Modern Exteriors | `limezu.itch.io/modernexteriors` | $25 | Permissive commercial | Plaza-area downtown buildings: cafes, restaurants, hotels. Modern small-town vocabulary. |
| Cainos Pixel Art Top Down Village | `cainos.itch.io/pixel-art-top-down-village` | $7 | Permissive commercial (credit appreciated, not required) | Vineyard backdrop tiles, oak savanna, secondary paths. Studio-Ghibli-warm. 32×32 — downscaled to 16×16 to match LimeZu where they coexist. |
| Sprout Lands Premium | `cupnooble.itch.io/sprout-lands-asset-pack` | $10 (Premium tier) | Premium permits commercial; raw not redistributable | The palette anchor. Cup Nooble's pastel matches our warm-California target exactly. Use for vineyard rows, golden hills, Russian River banks. |
| Aseprite | `aseprite.org` | $20 | Commercial-friendly EULA | Industry-standard pixel-art editor. For manual polish: back-view sprite drift from PixelLab, hand-tuning the gazebo copper roof color, etc. |
| PixelLab.ai Artisan tier | `pixellab.ai` | $24/mo × 2 = $48 | Commercial license included with paid plans | Larry sprite generation. Only tool that auto-generates 4-direction walk cycles from a single reference. Subscribe May + June; cancel after the village ends. |
| **Subtotal** | | **$77 one-time + $48 over 2 months = $125** | | |
| **Buffer to $150 ceiling** | | $25 | | Reserved for: PixelLab credit overages, one additional itch.io pack if a specific tile is missing, or temporary upgrade to PixelLab Architect tier if batch generation needs higher quotas. |

**License hygiene.** All purchased tilesets above are commercial-permissive after one-time payment. We cannot redistribute the raw tilesets as standalone assets; shipping them inside our compiled product is permitted by each vendor's stated terms. PixelLab Artisan-tier outputs carry full commercial rights. Aseprite outputs are ours unconditionally. The fork inherits AI Town's MIT *code* license. **Research 2026-05-12 confirmed: AI Town's bundled pixel-art assets are not Smallville-commissioned — they are sourced from OpenGameArt (George Bailey + hilau, plus Mounir Tohami's itch.io GUI elements), with per-asset license variability (some CC0, some CC-BY, some CC-BY-SA, some GPL). Rather than auditing each upstream asset individually, our plan is to ship the fork *without* AI Town's bundled `public/assets/` artwork — we replace it entirely with our purchased LimeZu + Cainos + Sprout Lands tilesets + PixelLab-generated Larry sprites.** This gives us a clean license story: only MIT-licensed code from AI Town, only commercial-permissive art from our vendors. Specifically excluded under all circumstances: LPC tilesets (CC-BY-SA / GPL), Universal LPC Spritesheet Generator outputs (same), Workadventure code (AGPL — read-only reference, never copy).

**The asset sprint, Mon 2026-05-12 → Wed 2026-05-21 (10 days):**

| Day | Date | Activity |
|---|---|---|
| **1** | Mon May 12 | Cooper approves $125 spend. Claude Code forks `a16z-infra/ai-town` locally, purchases all tilesets via itch.io, installs Aseprite, starts PixelLab Artisan subscription. Begin reading AI Town's frontend code in detail (per the deep-research agent's findings on its rendering layer / data-layer seam / sprite system). |
| **2** | Tue May 13 | Strip AI Town's scripted-agent loop. Identify the seam between its Convex data layer and its PixiJS rendering layer. Begin `instaclaw/scripts/_generate-healdsburg-map.ts` — a TypeScript program that emits Tiled `.tmj` JSON deterministically from a high-level layout description (tile-ID constants from the tilesets + positional helpers + layer definitions + object-layer for agent home tiles). |
| **3** | Wed May 14 | Emit first Tiled JSON for Healdsburg bones: two-cluster geography (Hotel Trio north, plaza south), Serendipity Lane connector path, plaza shape with diagonal cross-paths and gazebo placeholder, vineyard backdrops on east/west/north edges, Russian River along south. Render via the forked AI Town. **First screenshot to Cooper. Cooper reviews and gives feedback in natural language ("move the Carnegie Library one tile south; add the Streamline Moderne building at the NW corner; the Foss Creek path is too straight, give it a slight curve following the actual creek bed"). Claude Code edits the generator script, regenerates the `.tmj`, re-renders. Zero manual Tiled editing.** Iterate same-day. |
| **4** | Thu May 15 | Iterate layout to Cooper-approved bones. Wire ambient world layers: time-of-day tint overlay (real Pacific Time, anchored to `Intl.DateTimeFormat({timeZone:'America/Los_Angeles'})`), animated water tiles (Russian River + plaza fountain + Memorial Beach swim hole), tree-sway cycling on date palms and oak crowns, lamp-tile swap at dusk, single-bird sprite generator with 3-5 minute random arc. |
| **5** | Fri May 16 | Generate Larry sprites via PixelLab.ai using the `larry-canon/v1/larry.recipe.json` template (trigger token `qlryx`, palette derived from PixelLab outputs per Q59 ruling — back-port to canon afterward). Generate master Larry + 12 color variants × 4-direction walk + idle + talk + celebrate (16 frames per direction × 12 variants = ~192 frames). Hand-polish back-view drift in Aseprite — PixelLab's documented weak spot, ~2 hours per variant, parallelizable. |
| **6** | Sat May 17 | Integrate sprite assets into the AI Town fork (drop them into its sprite-atlas pipeline; replace its NPC identities with hash-derived Larry variants from `instaclaw_users.id`). Implement the breath ticker per § 4.14.2.7's locked implementation spec (single global `PIXI.Ticker` at 30 FPS, deterministic phase per `hash(user_id)`, locomotion-handoff via `locomotionActive` flag). |
| **7–9** | Sun May 18 – Tue May 20 | Wire all 23 motion-catalog events (§ 4.14.2.6) from Supabase Broadcast subscription → event reducer → per-agent animation queue → GSAP `pixi: {x,y}` tweens with `overwrite: 'auto'`. Test each event individually against a staging DB by triggering controlled state-machine transitions. Confirm the locomotion-breath handoff is glitch-free. Confirm Broadcast Replay catches reconnect events without stranding sprites mid-walk. |
| **10** | Wed May 21 | End-to-end smoke test: a single script triggers every event type sequentially against staging; observe corresponding sprite motion. Perf soak at simulated 500 sprites — `CullerPlugin` enabled, off-screen sprites `renderable=false`, breath ticker active. **Phase 1 canary ready.** |

**Why this strategy is the right call:**

1. **No artist-availability bottleneck.** LimeZu's commission status was uncertain in research; PixyMoon's similarly. Forking is unblocking — the code is already there, MIT-licensed, downloadable today.
2. **Cheaper *and* faster.** $125 vs $1500–2500; 10-day sprint vs 14-day-plus negotiation-then-delivery.
3. **Smallville continuity is more substantive via the fork.** We are literally extending the open-source heritage, not visually echoing it. Joon Park's team recognizes their own codebase being extended in a real residential village.
4. **Validates v1 before spending v1.1 dollars.** If the architecture and Truth Invariant don't land with attendees during the village, the right move is to learn from that — not to have pre-spent $2K on art that gets stale.
5. **Visual quality bar is met by our purchased art alone.** AI Town's bundled artwork is stripped at fork time (license + aesthetic reasons); our LimeZu Serene Village + Modern Exteriors + Cainos + Sprout Lands tilesets + PixelLab-generated Larry variants are themselves a curated, warm-California-pastel set that clears the "Rosedale-screenshot-worthy" bar. The differentiator vs gather.town is the Truth Invariant, not pixel fidelity.
6. **Programmatic layout is the right discipline for v1.** A hand-authored map would gate iteration on Cooper's pixel-art-editing time. A generator script can be iterated in minutes. Tiled JSON / AI Town's JS-module format ships under version control, reviewable as diffs.
7. **We become the first public fork to swap AI Town's data plane.** Per research: zero existing forks have replaced Convex with another backend. This is a contribution-back-to-ecosystem moment in addition to our village deliverable; worth surfacing in the launch tweet as a community signal to Joon Park's team and the Stanford generative-agents authors.

**v1.1 upgrade path — preserved, gated on v1 metrics (post-Edge retrospective, week of Jun 30):**

If v1 has produced positive signals — Twitter share volume of map screenshots, qualitative attendee testimonials about the "I saw my agent walking before the notification" moment, Rosedale engagement, Edge organizer interest in extending to Lanna — we commission custom art for v1.1:

| v1.1 commission | Artist target | Cost | Deliverable |
|---|---|---|---|
| Healdsburg-specific landmark tiles (6 hero tiles) | LimeZu (primary) or PixyMoon (backup) | $400–800 | Custom 16×16 tile pack: gazebo with copper roof, Sandborn marble fountain, h2hotel living roof, Carnegie Neoclassical columns + pediment, Raven Theater marquee, SingleThread restaurant facade. Replaces our generic equivalents tile-for-tile via the existing programmatic generator — one line of TypeScript per tile-ID swap. |
| Master Larry sprite polish | Pedro Medeiros / saint11 or Thomas Feichtmeir / Cyangmou | $400–800 | Hand-animated master Larry with nuanced expressions (deadpan, contemplative, surprised, content) and refined walk cycle. PixelLab variants regenerated against this new master via a Scenario.gg LoRA trained on the artist's deliverables. |
| **v1.1 subtotal** | | **$800–1600** | |
| **v1.1 ceiling** | | **$1500–2500** | Includes a $500 buffer for negotiation flexibility and a possible chiptune audio commission (Q60) if v1 metrics warrant. |

Lead time for artist commission: ~4 weeks. v1.1 ships against Edge Lanna timeline (September 2026) — a cleaner second-event reveal than rushing within Esmeralda. The same artist pipeline serves both partners.

**The `larry-canon` integration (Q59 ruling applied).** Per Cooper's ruling, the v1 path proceeds with PixelLab-generated Larry sprites following the `larry-canon/v1/larry.recipe.json` template; the canon's null `larry.palette.json` is populated from the v1 PixelLab outputs and back-ported into canon afterward, with light retouching if Cooper's canonical eye spots drift. This is option B from the Q59 framing: proceed with artist interpretation, back-port to canon. Lower risk for larry-canon Phase 0 timeline; allows v1 to ship on its own schedule. The recipe's trigger token `qlryx`, pose slot, environment slot, and prop-clause are followed verbatim; the rubric (deadpan expression, tiny dot eyes, one claw slightly larger than the other, rounded square shell) is the acceptance gate for hand-polish work in Aseprite.



##### 4.14.2.12 Performance budget

500 sprites is well within PixiJS's comfort zone (47 FPS at 10K sprites on a 2017 MacBook in benchmarks). The real concerns are bundle weight, mobile battery, and the iframe's network overhead.

| Concern | Budget | Mitigation |
|---|---|---|
| Plaza-route bundle size | ≤ 600 KB gzipped | Lazy-load the plaza route. Edgeclaw embed shell loads under 200 KB; village tab loads its own chunk. PixiJS v8 tree-shakes well. |
| Asset payload | ≤ 800 KB (compressed PNG + JSON) | Texture atlas packs all Larry frames + tile graphics into 1–2 atlases. WebP fallback if size hits ceiling. |
| Memory ceiling | ≤ 50 MB on mobile, ≤ 100 MB on desktop | Profile in Chrome DevTools. Use `ParticleContainer` for weather (10x cheaper than regular containers). Cull aggressively. |
| Frame rate | 60 FPS desktop / 30 FPS mobile (target); 24 FPS mobile (acceptable floor) | CullerPlugin + 30 FPS fallback when no animations active. |
| Battery on mobile | No measurable drain when tab is open but idle (no animations) | `pixi-viewport`'s built-in `pause()` when idle. Ticker-fps drop to 5 FPS on idle (just enough to handle a new event). Page Visibility API: full pause when tab hidden. IntersectionObserver: full pause when canvas off-screen. |
| Initial load to first-meaningful-paint | < 2 s on 4G mobile | Lazy-load assets. Show village outline + tile-grid + still default-position sprites first; populate animation/event handlers second. |
| Realtime traffic | < 1 message/sec average, ~5/sec at peak briefing time | Server-side throttle on the trigger if total village traffic exceeds 10 msg/sec; aggregate similar events. |
| Cull threshold | Off-screen at zoom level 1.0 → renderable=false | CullerPlugin handles automatically; verify with empirical test at 500 agents on a low-end Android. |

The expensive question is **mobile drawer rendering inside the iframe**. The Edge portal's mobile drawer collapses the sidebar; the embed gets near-full viewport width. At 360px width the map should still render legibly — agents become 8×8 dots, buildings simplify, the camera zooms out by default. We test specifically against iPhone 12 (the median Edge attendee's phone, statistically) and a low-end Android (Pixel 5a equivalent).

##### 4.14.2.13 Production reality checks

For each visual element, we document where the data comes from, what happens on day 1 (before any matches fire), what happens at scale, what happens on mobile, and what the fallback is if an asset fails to load.

| Element | Data source | Day-1 behavior | At scale (500 agents) | Mobile (360–768px) | Missing-asset fallback |
|---|---|---|---|---|---|
| Agent sprite position | `agent_positions` (NEW table, written by the motion-reducer; persists last-known position across sessions) | Default to home tile derived from `instaclaw_users.housing_assignment` (NEW column populated at registration); if null, plaza center | 500 positions cached in client memory; only ~10–50 update per minute | Same; sprites become 8x8 dots at low zoom | Single-color square at correct tile |
| Agent identity (Larry color) | Hash of `instaclaw_users.id` → palette index from `larry-canon/v1/larry.palette.json` (or fallback locked palette) | Color is stable per user from registration | Identical | Identical | Default Larry (teal) |
| Agent motion | Real-time channel `village:edge-esmeralda-2026` (Supabase Broadcast) | No motion until first event fires; agents stand at home tiles. This IS the day-1 view, and it is correct. | 5–50 simultaneous motions at peak briefing (7 AM), 0–5 at quiet hours | Same; mobile may drop animation framerate to 30 FPS | If channel disconnected, sprites freeze at last position; reconnect via Broadcast Replay |
| Tilemap (Healdsburg) | Static asset (Tiled JSON + texture atlas, served via Vercel edge) | Present from day 0 | Cached, static | Renders at 50% zoom by default | Plain `bg-edge-bg` color fill with sprites overlaid |
| Time-of-day tint | Real Pacific Time clock | Updates every minute | Identical for all attendees globally | Identical | No tint (bright white) |
| Trees/water/lamps ambient | Tile cycling driven by client-side timer | Loops from page-load | Identical | Reduce to half-rate on low-end devices | Static tiles |
| Weather | `village_weather` table polled from NOAA every 15 min | Default sunny if no row | Single overlay sprite + ParticleContainer | Same; particles capped at 100 on mobile | No weather |
| Speech bubbles | Per-event DOM overlay | None unless event fires | At most ~10 simultaneous bubbles | Bubble text scales down at 360px | Bubble background renders, text omitted |
| Bird (occasional) | Random client-side timer | Renders ~every 3–5 min during daylight | Identical | Disable on low-end mobile to save battery | Skip |
| Shooting star (milestones) | `village_milestones` table (NEW) | Triggered manually by admin script for genuine milestones | One star per milestone event | Same | Skip silently |
| Solstice indicator | Real Pacific Time clock, hard-coded date (2026-06-21) | Only renders on the one day | Identical | Identical | Skip silently |

**The day-1 view is not a degraded view. It's the correct view.** On the morning of May 30 before the first attendees have done anything, the map shows a quiet Healdsburg dawn with 500 still sprites at their home tiles, trees swaying, river flowing, sun rising over Alexander Valley to the east. That's a beautiful screenshot. It will get tweeted. The first attendees who claim their agents see them appear on the map within seconds. By the end of day 1 the map has visible activity at all the right tiles.

There is no "loading…" state to apologize for, because there is nothing to load. The truth of the day-1 morning IS the design.

##### 4.14.2.14 Two views — Authenticated (in the embed) + Public Spectator (`instaclaw.io/edge/village`)

The pixel-art village ships as **two distinct views of the same map and the same data**, with different identity affordances, hosted on different domains, accessible to different audiences. Both share the same generator script, the same tilemap, the same Larry sprite library, the same motion catalog, the same real Healdsburg time-of-day. They differ in what they reveal about who is who, how interactive they are, and what they ask the viewer to do. **Q40 ruling 2026-05-12: ship both.**

The **Authenticated view** is the *daily-use* artifact for the 500 attendees. It's where Tan finds her own Larry, watches her agent set up the coffee meeting, clicks on Sarah's sprite to read the side-panel profile, and uses the village as a window into her own social fabric for 28 days.

The **Public Spectator view** is the *viral / marketing* artifact for everyone else. It's the URL Cooper tweets at Rosedale. It's the link Timour drops in Edge marketing. It's what gets screenshotted on Twitter when the village is on fire with 47 simultaneous matches. It is shareable, unauthenticated, lower-fidelity in identity (every agent is `Agent #NNN`), but identical in real-time data — the same Healdsburg, the same agent motion, the same Truth Invariant.

The Public Spectator view is also the **upsell surface for InstaClaw beyond Edge Esmeralda.** A persistent "Want your own agent in a future village?" CTA in the corner converts spectators into waitlist signups for Edge Lanna (September 2026), Token2049, and future popup villages. The view is non-disruptive — a spectator can watch the village indefinitely without engaging the CTA — but the CTA is always present and softly pulsing.

###### 4.14.2.14.1 Authenticated View — the Village tab inside the embed

Mounted in the Portal Embed (§ 4.21) as a dedicated `Village` tab.

| Property | Value |
|---|---|
| Hostname | `edgeclaw.instaclaw.io` (separate Vercel project; see § 4.21.2) |
| Mount point | `/portal/edge-esmeralda-2026/edgeclaw/village` inside the EdgeOS citizen-portal iframe |
| Audience | Attendee, identity-bearing |
| Auth | postMessage JWT handshake + server-verify (per § 4.21.3); short-lived session cookie scoped to `.instaclaw.io`; World ID MiniKit fallback |
| Identity surfaced | Real names of confirmed-meeting counterparts; `Agent #NNN` for not-yet-met matches; user's own Larry highlighted with a soft halo + 24 × 24 size for findability |
| Interaction | Click another agent → side-panel (Mercury-style per § 4.21) with profile + Connect button; click own agent → camera follows (§ 4.14.2.9.2); time-travel scrubber accessible (§ 4.14.2.9.3) |
| Realtime channel | `village:edge-esmeralda-2026` (Supabase Broadcast, private channel, RLS-gated to authenticated edge_city attendees) |
| Default camera | Centered on user's own sprite, zoom 2.0× (~3 × 3 tile region visible) |
| Default theme | Light off-white, Edge palette (`--edge-bg #FAFAF7`) |
| Mobile | Responsive to portal sidebar collapse (256 ↔ 64 px); zooms out automatically at < 768 px container width |
| Bundle weight | Lazy-loaded; not in the initial embed shell |

The Authenticated view's hub-side promotion: inside the embed's main hub view (non-Village tab), a small "**The Village right now**" card surfaces with a 3-second-refresh count: *"47 agents active · 12 meetings in progress · 3 conversations starting."* Click → opens the Village tab. We expect ~70% of card clicks to lead to a full Village session.

###### 4.14.2.14.2 Public Spectator View — `instaclaw.io/edge/village`

Lives on the existing marketing app (`instaclaw.io`), as a sibling route to `/edge/plaza`. Public URL, no auth, no entry friction.

| Property | Value |
|---|---|
| Hostname | `instaclaw.io/edge/village` — same Next.js app as `/edge/plaza`, deployed alongside |
| Mount point | None — full-page surface |
| Audience | Public — anyone with the URL |
| Auth | None |
| Identity surfaced | **Every agent is `Agent #NNN`**, where `NNN` is the last three digits of an HMAC-SHA-256 hash of `instaclaw_users.id` salted with `EDGE_CITY_RESEARCH_SALT` (the same salt as the Vendrov research-export pipeline — re-used so the public anonymization rotates with the research-export salt rotation 7 days post-village). No real names ever. |
| Interaction | Pan + zoom + free-orbit camera. **No click-into-agent.** Hover shows minimal anonymous metadata — only the activity verb (`"in a meeting"`, `"thinking"`, `"at a talk"`) plus the `Agent #NNN` tag. Time-travel scrubber for the last 6 hours present. |
| Realtime channel | `village-public:edge-esmeralda-2026` (Supabase Broadcast, public RLS — anyone can subscribe; payloads are anonymized at the Postgres trigger level *before* they ever leave the database) |
| Default camera | Healdsburg Plaza centered, zoom 1.0× (full overview); auto-zoom-to-action if a notable event is happening |
| Default theme | Same Edge palette + warm off-white |
| Persistent CTA | Bottom-right corner: a small pixel-art card with a Larry sprite pulsing softly: *"👀 Want your own agent in the next village? Join the Edge Lanna waitlist →"* Links to `instaclaw.io/edge` (claim flow + waitlist signup). Visible always, never disrupts the canvas. |
| Deep-link share URLs | `instaclaw.io/edge/village?focus=plaza` (default camera target), `instaclaw.io/edge/village?event=<event_id>` (deep-link to a specific recent event — camera centers on the event location and replays the last 30 seconds via the scrubber). The deep-link URLs are what get pasted into tweet replies. |
| Mobile | Full-viewport; CTA stays bottom-right; pinch-zoom + pan only; no text input. |
| OG meta | Custom Open Graph image rendered server-side from the current village state (anonymized) — a Twitter preview shows the village right now, not a static placeholder. Server-rendered at request time with a 60-second cache. |

###### 4.14.2.14.3 Identity isolation — how the Public view is privacy-safe

The Public view's `village-public:*` channel carries fundamentally different payloads from the Authenticated `village:*` channel. **The isolation is enforced at the Postgres trigger level — *before* any data crosses the WebSocket boundary** — so the public client cannot reverse-engineer identity even with a hostile network observer.

The dual-trigger pattern:

```sql
-- On every INSERT to matchpool_outcomes, emit to BOTH channels:
create or replace function emit_matchpool_outcome_dual()
returns trigger language plpgsql security definer as $$
begin
  -- Private channel: full record, RLS-gated to authenticated attendees
  perform realtime.broadcast_changes(
    'village:edge-esmeralda-2026',
    tg_op, tg_op, tg_table_name, tg_table_schema, new, old
  );

  -- Public channel: anonymized record, identity-bearing fields stripped
  perform realtime.broadcast_changes(
    'village-public:edge-esmeralda-2026',
    tg_op, tg_op, tg_table_name, tg_table_schema,
    jsonb_build_object(
      'source_agent', hmac_anon_agent(new.source_user_id),
      'candidate_agent', hmac_anon_agent(new.candidate_user_id),
      'agent_action', new.agent_action,
      'deliberation_score', new.deliberation_score,
      'source_position', position_for_anon(new.source_user_id),
      'candidate_position', position_for_anon(new.candidate_user_id)
      -- topic, reason_text, accepted_window, telegram_handle, name — all stripped
    ),
    null
  );
  return null;
end $$;
```

`hmac_anon_agent()` is the same anonymization function used by the existing Vendrov research-export pipeline (`lib/research-export/anonymize.ts` at the SQL layer) — HMAC-SHA-256 with `EDGE_CITY_RESEARCH_SALT`, truncated to the last 3 digits for the `Agent #NNN` display. The salt rotates 7 days post-village close per the existing privacy commitment in § 3.3 of the Vendrov pre-registration; after rotation, the anonymized agent IDs cease to be reversible by anyone, including InstaClaw operators.

**What's stripped on the public channel:** raw `user_id`, `topic` text (could re-introduce as a coarse category enum in v1.1 if attendees consent), `reason_text` (LLM reasoning is identity-bearing for niche topics), `accepted_window` text (a specific cafe + time is identity-bearing in a 500-person village), `from_telegram_handle`, `from_name`, all email/wallet fields.

**What's kept on the public channel:** anonymized agent identifier (`Agent #NNN`), coarse-tile position, activity verb, deliberation score (useful for the funnel sense; not identity-bearing).

The public RLS policy on `realtime.messages` permits anyone to subscribe to the `village-public:*` topic but explicitly denies subscription to `village:*` without authenticated session.

**Failure modes considered:**

- *Spectator inferring identity from timing + position:* a sufficiently determined adversary watching the public channel could correlate agent positions with attendee social-media posts (*"I just sat down at Flying Goat"*) to re-identify. This is the same de-anonymization risk that exists in *any* spatial visualization of small-community data — including the Vendrov export. We accept it because (a) the attack is high-effort and low-yield, (b) attendees implicitly consent to this by being in a 500-person residential village where everyone watches everyone, (c) the Public view is gated to coarse-tile positions (no sub-tile precision) and stripped of identity-bearing metadata. The attendee onboarding flow surfaces this trade-off explicitly with an opt-out toggle ("Hide my agent from the public spectator view") that, when enabled, sets a `users.spectator_visible = false` flag — the trigger then skips emitting public-channel events for that user. Attendees keep agency.
- *Channel mis-configuration ships full payload to public:* prevented by SQL-side stripping happening *inside* the trigger function, before any payload leaves the database. There is no client-side anonymization to misconfigure. The trigger is unit-tested with an assertion that the public payload contains zero raw-PII fields.
- *Salt leak:* same risk as the existing Vendrov pipeline. Mitigated by Vault-stored salt + 7-day post-village rotation.

###### 4.14.2.14.4 The launch dynamic

Both views ship together at the Phase 5 reveal (Wed 2026-06-17). The launch tweet links the Public Spectator URL — `instaclaw.io/edge/village` — because that's the URL anyone can click. Attendees who follow the tweet land on the public view, see the village in motion, click the CTA (or follow the secondary "I'm an Edge Esmeralda attendee" link), authenticate, and arrive at their own Village tab inside their Portal Embed. The two views are designed to feed each other: spectator becomes attendee, attendee shares the spectator URL with friends, the loop runs.

The Public Spectator view's role in the Edge marketing surface (Timour's preferred linking pattern) is the same as the public `/edge/plaza` v0 today — except it's spatial, alive, and tells a story. We expect Timour to make it the centerpiece of Edge's "live now" marketing for the duration of the village.

##### 4.14.2.15 Phased rollout

Two parallel workstreams converge at the Wed 2026-06-17 reveal: **Authenticated View** (Village tab inside the embed, used by attendees) and **Public Spectator View** (`instaclaw.io/edge/village`, the viral artifact). Dates locked.

| Phase | Dates | Workstream | Scope |
|---|---|---|---|
| **Phase 0 — Foundation sprint** | Mon May 12 – Wed May 21 (10 days) | Both | Fork AI Town; buy tilesets; build programmatic Healdsburg map generator (`_generate-healdsburg-map.ts`); generate Larry sprites via PixelLab; implement breath ticker; wire all 23 motion-catalog events to Supabase Broadcast. See § 4.14.2.11 for the day-by-day asset sprint. |
| **Phase 1 — Internal canary (Authenticated)** | Thu May 22 – Tue May 26 | Authenticated | Full village renders on Cooper's vm-050 + vm-780. Test all 23 motion events against a triggered staging DB. Validate Healdsburg-recognizable from screenshots. Cooper red-pen review of every visual element via natural-language feedback to the generator script. |
| **Phase 2 — Authenticated staging integration** | Wed May 27 – Thu May 29 | Authenticated | Land Authenticated Village tab behind a feature flag inside the Portal Embed. Wire to staging Supabase Broadcast. Cross-test inside EdgeOS portal with Tule (per § 4.21.8). Mobile drawer rendering verified at 360–1366 px. Performance soak. |
| **Phase 3 — Soft launch (Authenticated, hidden)** | Fri May 30 – Sun Jun 7 | Authenticated | **Edge Esmeralda starts.** Authenticated Village tab built but feature-flag-hidden; we focus team attention on briefing reliability + matchmaking + v2 negotiation. Internal team-only sees the Village tab. We monitor data flow, fix bugs, refine motion timings. Spectator view not yet built. |
| **Phase 2.5 — Public Spectator implementation** | Mon Jun 2 – Sun Jun 8 (overlaps Phase 3 closing) | Public Spectator | Implement `instaclaw.io/edge/village` route on the existing `/edge` Next.js app. Wire `village-public:*` Supabase channel with anonymized-payload triggers (§ 4.14.2.14.3 dual-trigger pattern). Build "Claim your own agent" CTA. Build deep-link share URLs (`?focus=`, `?event=`). Custom OG meta-image renderer (60-s cached, anonymized snapshot). Mobile responsive. Privacy opt-out toggle (`users.spectator_visible = false`) on the attendee profile page. |
| **Phase 4 — Partner-VM Authenticated tab visible** | Mon Jun 8 – Sun Jun 14 | Authenticated | Village tab visible to the 5 Edge partner VMs (already on v2 negotiation canary per § 4.21). They become the first attendees to see their own Larrys on the map. We solicit qualitative feedback in person (Cooper + Timour + Vendrov). Public Spectator implementation completes in parallel. |
| **Phase 5 — Full reveal (BOTH VIEWS)** | **Wed Jun 17 (Week 3, Day 1)** | Both | Village tab visible to all 500 attendees inside the embed. `instaclaw.io/edge/village` goes public. **Launch tweet** links the Public Spectator URL (because anyone can click it). Tag Rosedale, Joon Park, Vendrov, the AI Town team, the Stanford generative-agents authors. Coordinated with Timour's Edge marketing push that week — Edge's social channels link the Spectator URL as the primary "what's happening at Edge right now" surface. |
| **Phase 6 — Solstice special state** | **Sun Jun 21** | Both | Solstice-specific map state: longer golden hour, ☀ indicator over the plaza, Esmeralda pointer glow at the north edge. The longest-day-of-the-year moment falls in our reveal window. |
| **Phase 7 — Refinement** | Mon Jun 22 – Fri Jun 27 | Both | Iterate based on Phase 5–6 qualitative feedback. Add follow-up modules (time-travel scrubber polish, side-panel agent profile depth) if engagement metrics justify. Tweak the Spectator CTA copy based on conversion data. |
| **Phase 8 — Post-village retrospective + v1.1 decision** | Sun Jun 28 – Fri Jul 4 | Both | Decide: keep both views live as research artifact / future-event teaser, or fade out gracefully. Anonymized event-replay corpus released as publishable dataset (aligned with Vendrov post-village publication schedule). **v1.1 commission decision per § 4.14.2.11** — based on Twitter share volume, qualitative attendee testimonials, Rosedale engagement, Edge organizer interest in extending to Lanna. If positive, artist commission begins immediately; lead time ~4 weeks targets Edge Lanna timeline (September). |

**The hard floor for the reveal is Wed Jun 17.** This is selected because:

- Week 3's programmatic theme is *Emergent Futures and World Building* — the village map is itself a Spatial Computing + Creative AI artifact; the alignment is poetic and intentional.
- The Sunday solstice (Jun 21) is the natural follow-up moment within the same week.
- Week 1 (Jun 1–7) is too early; attendees are still onboarding and the data isn't dense enough to make the map visually interesting.
- Week 2 (Jun 8–14) is the partner-VM canary window — too soon for a confident public reveal.
- Week 4 risks attendees being saturated and the reveal getting lost.

If we slip past Jun 17, the fallback target is Sun Jun 21 (the solstice). Slipping past Jun 21 materially reduces impact; consider deferring to Edge Lanna (September 2026) as a cleaner second-event reveal — which is also when v1.1 commissioned art would be ready and the Smallville-continuity narrative gets a second amplification cycle.

**The two-workstream-converging-at-Phase-5 model** is intentional. The Authenticated view is built and tested first; it informs the Public Spectator's UX and the anonymization-trigger design. Both reach production together for the launch moment. This avoids the failure mode where the Spectator goes live without the Authenticated view being polished, or vice versa — both must launch together because the loop (spectator becomes attendee, attendee shares spectator URL) only works when both surfaces exist.

##### 4.14.2.16 Open questions — rulings recorded 2026-05-12; remaining items below

The major decisions are locked. Cooper's rulings on 2026-05-12 closed Q40, Q56, Q57, Q59, and the artist-commission gate (deferred to v1.1). The items still requiring rulings are smaller, mostly procedural or technical-detail.

**🔒 Q40 — LOCKED 2026-05-12. Ship BOTH views.** Authenticated (in the embed) + Public Spectator (`instaclaw.io/edge/village`). Public Spectator is the viral / marketing artifact with a persistent "claim your own agent" CTA in the corner. Fully specced in § 4.14.2.14.

**🔒 Q56 — LOCKED 2026-05-12. Include the breath.** 2-pixel bob, ±1 pixel from baseline, 1.5 s period, sine-eased, deterministic phase per `hash(instaclaw_users.id)`. Breath pauses during locomotion. Implementation in § 4.14.2.7. Cooper's framing: "breath is not motion."

**🔒 Q57 — LOCKED 2026-05-12. Healdsburg Avenue vertical.** Map orientation matches every local tourist map; attendees orient by the main drag. The plaza's true 45° rotation is sacrificed for legibility — this is a stylized recreation, not a survey.

**🔒 Q58 — LOCKED 2026-05-12 (implicit in § 4.14.2.3). 16 × 16 pixel tiles throughout.** LimeZu Serene Village (16 × 16) is primary; Cainos (32 × 32) tiles are downscaled to fit, used selectively for vineyard/oak-savanna backdrops where the larger scale doesn't clash.

**🔒 Q59 — LOCKED 2026-05-12. Option B — proceed with PixelLab + back-port to larry-canon.** PixelLab.ai generates v1 Larry sprites based on the `larry-canon/v1/larry.recipe.json` template. The canon's null `larry.palette.json` is populated from PixelLab outputs and back-ported afterward, with light retouching. Lower risk for larry-canon Phase 0 timeline.

**🔒 Artist commission — DEFERRED to v1.1 (locked 2026-05-12).** Do not gate v1 on a commissioned artist. v1 ships on the AI Town fork + PixelLab Larry + purchased tilesets ($150 ceiling). v1.1 commission gate is the post-Edge retrospective (week of Jun 30); see § 4.14.2.11 v1.1 upgrade path.

---

**Remaining open items, in order of urgency:**

**Q60 — Audio for v1.** Chiptune ambient track + event-driven chimes (Pokémon-style ding when a match accepts) is aesthetically obvious but adds asset cost + UX questions (default on or off? mobile autoplay restrictions?). Recommendation: **defer to v1.1.** Ship v1 silent. Reconsider during post-village retrospective if metrics warrant.

**Q61 — The fifth magic moment, shooting-star threshold list.** Proposed thresholds: 10,000 matchpool outcomes, 1,000 confirmed meetings, 100 publicly-reported "best connection" survey responses. Approximately 3–5 stars over 28 days at projected scale. Cooper to approve threshold list before Phase 5 reveal.

**Q62 — Notification synchrony coordination layer.** The iframe needs to signal "I am open and watching" via a heartbeat to a `village_iframe_presence` table; the agent VMs' notification path needs to check that presence before deciding whether to delay the Telegram push. ~50 lines of code, not blocking. Confirm direction.

**🔒 Q63 — LOCKED 2026-05-12. Sprite-identity Option 1.** Generate ~50 PixelLab atlases, hash-assign each attendee. ~10 attendees share each Larry color (acceptable visual duplication; identity also conveyed by name on hover and a halo on the user's own sprite). Option 2 (layered accessories) deferred to v1.1. Briefs PixelLab generation on Day 5 of asset sprint.

**Q64 (deferred to Mon Jun 2 — Phase 2.5 start).** Public Spectator CTA copy and destination URL. Proposed copy: *"👀 Want your own agent in the next village? Join the Edge Lanna waitlist →"*. Destination URL likely a new `/edge/waitlist` page rather than the existing `/edge` claim flow, depending on how Edge Lanna marketing sequences. Cooper rules when waitlist page is ready.

**🔒 Q65 — LOCKED 2026-05-12. Ship spectator opt-out toggle from day 1.** Attendees can set `instaclaw_users.spectator_visible = false` from the attendee profile page; the trigger-level flag suppresses public-channel events for that user. The Authenticated view always shows them to fellow attendees. The migration ships in Phase 0 of the asset sprint.

**🔒 Q66 — LOCKED 2026-05-12. Drop the HistoricalObject binary buffer; use rAF lerp.** AI Town's 60 Hz position-sample binary protocol is replaced by per-update rAF interpolation between current and target position. Saves ~350 LOC. Applied Day 2 of asset sprint.

**Q67 (NEW). v1.1 sprite-layering strategy.** When v1.1 commission lands a polished master Larry, do we layer accessories (option 2 from Q63) or generate hundreds of unique full-sprite variants via Scenario.gg LoRA? Defer decision to post-village retrospective. Both are technically viable.

**Q68 (NEW). Tile-renderer migration.** Native PIXI sprite-per-cell is AI Town's pattern and fine at ~3K cells. If the Healdsburg map grows past ~10K tiles during iteration (possible if Cooper wants the vineyard hills more detailed), migrate to `@pixi/tilemap` for GPU batching. Defer; decision point at world-design time, not a v1-blocking question.

**Q69 (NEW). Edge organizer-supplied schedule data.** Do we get a Tule-provided `edge_calendar_events` feed (real schedule data → real agent positions during talks/dinners), or do we hand-curate the village's event calendar in our own table? Needs a conversation with Tule. Recommendation: ask for a feed, but also build a fallback admin UI in case the feed doesn't materialize. Decision by Phase 2 entry (Wed May 27).

**Q70 (NEW). Healdsburg Avenue orientation — true compass or stylized?** Locked Q57 says Healdsburg Avenue vertical. But the real Healdsburg Avenue runs roughly N-S compass; the plaza is on its east side rotated ~45° from true cardinal. Our stylized recreation keeps the avenue as the map's vertical axis but loses the plaza's true 45° rotation — this is correct, attendees orient by the main drag, but worth flagging as a deliberate choice (locals familiar with the actual compass rotation may notice). Cooper to acknowledge.

##### 4.14.2.17 Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| AI Town fork's refactor surface (Convex → Supabase swap) is larger than the research estimate (~400 LOC across 5 files) | Medium | Medium | We are the first known public fork to attempt this swap. Reserve a 3-day slack in the asset sprint after Day 2 (when we strip the Convex agent loop). If the swap is messier than estimated, push Phase 1 canary from Thu May 22 → Fri May 23. |
| AI Town's bundled OpenGameArt assets turn out to include a tile we want and would be expensive to replace | Low | Low | We strip AI Town's bundled artwork entirely at fork time and rely on our purchased tilesets. If a specific tile is missing post-strip, buy a one-off itch.io supplement (~$5-10, within the $25 buffer to $150 ceiling). |
| HistoricalObject drop produces visibly choppy motion at peak event rates | Low | Medium | rAF lerp between current → target is mathematically sufficient at our update rate (~1 event/sec peak, not 60). If choppiness surfaces in Phase 1 canary, port AI Town's binary buffer pattern as a fallback (1-day work). |
| Sprite-identity duplication noticed by attendees (Q63 option 1) | Medium | Low | We hash-assign 50 atlases across 500 attendees, so ~10 attendees share each. Identity is also conveyed by name on hover and the user's own halo. Acceptable for v1; v1.1 layering eliminates the duplication. |
| Larry sprite consistency drift across PixelLab-generated color variants (back-view especially, per documented PixelLab weakness) | Medium | Low | Hand-polish all 12 reference variants in Aseprite (~2 hours each, parallelizable). v1.1 Scenario.gg LoRA training on the commissioned master Larry eliminates drift. |
| Larry-canon Phase 0 slips, palette back-port delayed | High | Low | Q59 ruling: proceed with artist interpretation; back-port whenever canon Phase 0 lands. Map palette doesn't need to wait. |
| Healdsburg map renders as "generic RPG town #47" | Low (mitigated by § 4.14.2.4 specificity) | High | Claude Code drives the generator from the locked landmark list + photo moodboard (15+ links) + the Devon Zuegel 2025 Edge village map. Cooper screenshot-reviews the bones on Day 3, with iteration in natural-language feedback. |
| Real-Healdsburg-specific tiles (gazebo, h2hotel living roof, Carnegie columns) missing from purchased tilesets | High | Low | v1 ships with stylized stand-ins (a generic gazebo from Cainos, a generic plaza fountain from LimeZu). v1.1 commission lands the 6 hero custom landmarks. Attendees who notice the gap will be the same ones who care about pixel art; we can frame it as "v1.1 fidelity upgrade coming September." |
| 500-sprite render performance on mobile drawer | Low | Medium | Phase 4 explicit perf test on iPhone 12 + Pixel 5a. Cull aggressively via `pixi-viewport`'s cull plugin (inherited from AI Town). Fallback: simplify sprites to colored circles at low zoom on mobile. |
| Realtime channel auth (iframe + private channel) | Medium | High | Verify in Phase 1 canary; § 4.21.3 already specs the postMessage + JWT verify pattern; reuse here. World ID MiniKit fallback if postMessage handshake fails. |
| Broadcast Replay disabled or fails on reconnect | Medium | Medium | Backup: client-side replay via REST query "events since last_seen_at." ~30 lines. The Public Spectator channel uses this simpler pattern by default since Broadcast Replay is overkill for read-only viewers. |
| **Dual-channel trigger has a bug, ships full payload to public channel (PRIVACY)** | Low | **HIGH** | The most important risk in this section. Mitigation: SQL-side stripping happens *inside* the trigger function, before any payload crosses the WebSocket boundary. Unit-test the trigger with an assertion that the public payload contains zero raw-PII fields. Integration test: subscribe to the public channel from an unauthenticated client, fire test events with known PII in the source row, assert PII never appears in the received messages. CI runs this on every PR that touches the trigger SQL. **Privacy is the brand; one breach during the village kills the story.** |
| Public Spectator de-anonymization attack via position + social-media correlation | Medium (high-effort attack, but possible) | Low (each individual re-id is hard to weaponize) | Documented in § 4.14.2.14.3. Mitigations: coarse-tile positions only (no sub-tile precision), identity-bearing metadata stripped, attendee opt-out toggle, 7-day post-village salt rotation makes anonymized IDs structurally non-reidentifiable thereafter. |
| Notification synchrony (§ 4.14.2.9.1) introduces a regression in Telegram delivery latency | Low | Medium | Feature-flag the synchrony delay; can be disabled instantly. Verify in Phase 1 canary with vm-050 + vm-780. |
| Solstice special state visually clashes with regular daytime | Low | Low | Render solstice in a preview mode before Jun 21 to confirm; restraint already specced. |
| EdgeOS portal CSP blocks the embedded WebGL canvas | Low (next.config.ts has no CSP currently per § 4.21 substrate research) | High | Confirm with Tule in Phase 1 (already on the § 4.21.8 ask list); we control the embed's own CSP and can configure `frame-ancestors` correctly. |
| Real-time channel WebSocket cost exceeds budget at 500 authenticated + 5000 public concurrent | Low | Low | Supabase pricing math estimates $10–30/mo over Pro tier for the spectator surge during the village. Absorbable. Plan B: throttle the trigger to coalesce similar events. Plan C: aggressive front-end caching for spectators (1-sec batch). |
| Public Spectator view becomes a target for scraping / mirroring | Medium | Low | Rate-limit at the edge (Vercel Edge Config). Add a `noindex` meta if we want it to be social-only (probably want it indexable for organic Edge marketing reach — Cooper to confirm in Q64 follow-up). |
| AI Town upstream changes mid-village (extremely unlikely given repo's maintenance-mode status, but possible) | Very Low | Low | We don't rebase from upstream during the village; we treat the fork as a frozen target. Any urgent upstream security fix gets cherry-picked, but the fork is otherwise stable. |

##### 4.14.2.18 What's resolved, what remains

**Resolved by Cooper's rulings 2026-05-12 (all six original load-bearing decisions):**

| Decision | Ruling |
|---|---|
| Q56 — The Pokémon Concession | ✅ Include the breath. Spec'd in § 4.14.2.7 with full implementation. |
| Q57 — Map orientation | ✅ Healdsburg Avenue vertical. |
| Q59 — Larry-canon Phase 0 alignment | ✅ Option B — proceed with PixelLab + larry-canon recipe; back-port to canon afterward. |
| Q40 — Public vs attendee-only | ✅ **Ship both views.** Authenticated + Public Spectator. Spec'd in § 4.14.2.14. |
| Day-1 buy list (asset spend) | ✅ Approved at $150 ceiling. Sprint begins today. |
| Artist commission | ✅ Deferred to v1.1 (post-village retrospective gate). v1 ships on fork + tilesets + PixelLab. |

**Remaining items needing rulings this week (mostly procedural / technical-detail):**

1. **Q63 — Sprite-identity strategy for v1** (Option 1: 50 PixelLab atlases hash-assigned, ~10 attendees share each Larry color; vs Option 2: layered accessories — defer to v1.1). Recommendation: option 1. **Needed by Fri May 16** (Day 5 of sprint, the day PixelLab generation runs).
2. **Q64 — Public Spectator CTA copy and destination URL**. Proposed copy: *"👀 Want your own agent in the next village? Join the Edge Lanna waitlist →"*. Destination URL probably wants to be a new `/edge/waitlist` page rather than the existing `/edge` claim flow. **Needed by Mon Jun 2** (Phase 2.5 start).
3. **Q65 — Public Spectator opt-out toggle for attendees**. Confirm: ship the `instaclaw_users.spectator_visible = false` toggle in the attendee profile page from Phase 5? Recommendation: yes — gives attendees agency. **Needed by Wed May 14** (so the migration ships in Phase 0 of the asset sprint).
4. **Q66 — HistoricalObject drop confirmation**. Replace AI Town's 60 Hz binary-buffer position playback with rAF lerp. Saves ~350 LOC. Recommended by research. **Needed by Tue May 13** (Day 2 of sprint).
5. **Q69 — Edge organizer-supplied schedule data**. Ask Tule for a real-schedule feed (`edge_calendar_events`) or hand-curate in our own table? Recommendation: ask for the feed, build a fallback admin UI. **Needed by Wed May 27** (Phase 2 entry, when we wire schedule-driven agent positions).

**Deferred to post-village retrospective (Phase 8, week of Jun 30):**

- Q60 — Audio for v1
- Q61 — Shooting-star milestone threshold list (the proposed thresholds in § 4.14.2.9.5 are recommendations; final list lands closer to reveal)
- Q67 — v1.1 sprite-layering strategy (Option 2 from Q63)
- Q68 — Tile-renderer migration to `@pixi/tilemap` if map grows past ~10K tiles
- v1.1 artist commission gate decision

**Status as of 2026-05-12, end of day:**

The asset sprint can begin tomorrow morning. Cooper's rulings unlocked Days 1–4 of the sprint with no procedural blockers. The five remaining open items are sequenced so each is asked-and-answered before the day that depends on it. Q66 (HistoricalObject drop) is the only item with a Tue May 13 deadline; the rest can ride later in the sprint without delaying any deliverable.

**Sources cited throughout this section (consolidated for the reader):**

- Edge Esmeralda 2026 venues: [edgepatagonia.sola.day/event/edge-esmeralda-2026/venues](https://edgepatagonia.sola.day/event/edge-esmeralda-2026/venues)
- Edge Esmeralda 2026 themes: [edgeesmeralda.com/about](https://www.edgeesmeralda.com/about)
- Edge Esmeralda 2025 village overview: [edgeesmeralda2025.substack.com/p/edge-esmeralda-2025-village-overview](https://edgeesmeralda2025.substack.com/p/edge-esmeralda-2025-village-overview)
- Devon Zuegel's 2025 map tweet: [x.com/devonzuegel/status/1774936677456187738](https://x.com/devonzuegel/status/1774936677456187738)
- Foss Creek Pathway: [ci.healdsburg.ca.us/370/Foss-Creek-Pathway-Plan](https://www.ci.healdsburg.ca.us/370/Foss-Creek-Pathway-Plan)
- Healdsburg Plaza historical detail: [hannahclaybornshistoryofhealdsburg.com/the-plaza.html](https://www.hannahclaybornshistoryofhealdsburg.com/the-plaza.html)
- Official Downtown Healdsburg PDF map: [healdsburg.com/wp-content/uploads/2025/07/2024-Downtown-Map-Updated-Aug.-2024.pdf](https://www.healdsburg.com/wp-content/uploads/2025/07/2024-Downtown-Map-Updated-Aug.-2024.pdf)
- SHED closed since 2018 (DO NOT draw): [patch.com/california/healdsburg/iconic-healdsburg-shed-closing-shop](https://patch.com/california/healdsburg/iconic-healdsburg-shed-closing-shop)
- Sunrise/sunset Healdsburg June 2026: [timeanddate.com/sun/@5356012?month=6](https://www.timeanddate.com/sun/@5356012?month=6)
- Supabase Realtime Broadcast from Database: [supabase.com/blog/realtime-broadcast-from-database](https://supabase.com/blog/realtime-broadcast-from-database)
- Supabase Broadcast docs: [supabase.com/docs/guides/realtime/broadcast](https://supabase.com/docs/guides/realtime/broadcast)
- Supabase Realtime Authorization (RLS on private channels): [supabase.com/docs/guides/realtime/authorization](https://supabase.com/docs/guides/realtime/authorization)
- Broadcast Replay feature: [supabase.com/features/realtime-broadcast-replay](https://supabase.com/features/realtime-broadcast-replay)
- Web Worker heartbeats for backgrounded tabs: [supabase.com/docs/guides/troubleshooting/realtime-handling-silent-disconnections-in-backgrounded-applications-592794](https://supabase.com/docs/guides/troubleshooting/realtime-handling-silent-disconnections-in-backgrounded-applications-592794)
- PixiJS v8 render layers + culling: [pixijs.com/8.x/guides/concepts/render-layers](https://pixijs.com/8.x/guides/concepts/render-layers)
- GSAP PixiPlugin: [gsap.com/docs/v3/Plugins/PixiPlugin/](https://gsap.com/docs/v3/Plugins/PixiPlugin/)
- @pixi/tilemap: [github.com/pixijs/tilemap](https://github.com/pixijs/tilemap)
- pixi-tiledmap (Tiled loader): [github.com/riebel/pixi-tiledmap](https://github.com/riebel/pixi-tiledmap)
- pixi-viewport (camera): [github.com/pixijs-userland/pixi-viewport](https://github.com/pixijs-userland/pixi-viewport)
- @pixi/particle-emitter: [github.com/pixijs/particle-emitter](https://github.com/pixijs/particle-emitter)
- AI Town (a16z-infra, MIT — Smallville reimplementation): [github.com/a16z-infra/ai-town](https://github.com/a16z-infra/ai-town)
- Stanford Generative Agents paper: [arxiv.org/abs/2304.03442](https://arxiv.org/abs/2304.03442)
- LimeZu (itch.io — Smallville interiors artist): [limezu.itch.io](https://limezu.itch.io/)
- PixyMoon (itch.io — Smallville backgrounds artist): [pixymoon.itch.io](https://pixymoon.itch.io/)
- Cup Nooble (Sprout Lands creator — California warm pastel match): [cupnooble.itch.io](https://cupnooble.itch.io/)
- Cyangmou / Thomas Feichtmeir (tinyBuild art director — pro tier): [cyangmou.itch.io](https://cyangmou.itch.io/), [pixeljoint.com/p/32234.htm](https://pixeljoint.com/p/32234.htm)
- Pedro Medeiros / saint11 (Celeste/TowerFall animator): [patreon.com/saint11](https://www.patreon.com/saint11)
- Cainos Pixel Art Top Down Village: [cainos.itch.io/pixel-art-top-down-village](https://cainos.itch.io/pixel-art-top-down-village)
- Kenney Tiny Town (CC0 prototype assets): [kenney.nl/assets/tiny-town](https://kenney.nl/assets/tiny-town)
- PixelLab.ai (sprite-sheet generation): [pixellab.ai](https://www.pixellab.ai/)
- Retro Diffusion (Astropulse pixel-art Stable Diffusion): [retrodiffusion.ai](https://retrodiffusion.ai/)
- Scenario.gg (train a model on your style): [scenario.com](https://www.scenario.com/)
- Aseprite (pixel-art editor): [aseprite.org](https://www.aseprite.org/)
- Workadventure (AGPL — reference architecture only): [github.com/workadventure/workadventure](https://github.com/workadventure/workadventure)
- Kaetram-Open (MPL 2.0 — tilemap parsing reference): [github.com/Kaetram/Kaetram-Open](https://github.com/Kaetram/Kaetram-Open)
- ConcernedApe (Stardew) on pixel-art process: [mentalnerd.com/blog/getting-started-pixel-art-interview/](https://mentalnerd.com/blog/getting-started-pixel-art-interview/)
- "Breathing life into NPCs": [gamedeveloper.com/design/breathing-life-into-non-player-characters-insights-from-psychological-attribution](https://www.gamedeveloper.com/design/breathing-life-into-non-player-characters-insights-from-psychological-attribution)
- Wplace (pixel canvas on real geography, July 2025): [wplace.live](https://wplace.live/)
- Townscaper (browser, procedural town): [oskarstalberg.com/Townscaper/](https://oskarstalberg.com/Townscaper/)
- Tiny Glade (idle motion discipline reference): [pouncelight.games](https://pouncelight.games/)
- larry-canon (this repo): `docs/prd/larry-mascot-operating-system.md`

---

End of § 4.14.

### 4.15 Plan B — Centralized Matching Fallback *(added 2026-05-01)*

The meeting acknowledged Index Network's negotiator infrastructure isn't production-ready yet. The PRD shouldn't bet the entire matchmaking story on a partner's external timeline. **Plan B is a feature-flagged centralized fallback that ships alongside Index integration.**

**Architecture.** Identical wire format to Index — same `route_intent()` surface (§ 3.5.1), same outcome shape returned. The only difference is that the negotiator runs centrally on InstaClaw infrastructure instead of as a per-user agent on Index's side.

```
                ROUTE_INTENT INTERFACE (stable)
                    ▲                  ▲
                    │                  │
            ┌───────┴──────┐    ┌──────┴──────┐
            │              │    │             │
       [Index Network]    OR    [InstaClaw    ]
       Per-user negotiators     Centralized
       (Plan A)                 matching engine
                                (Plan B)
```

**Plan B implementation:**
- Daily batch cron at 3am: read all `agent_signals` from the last 24h
- Compute embeddings (OpenAI text-embedding-3-small, $0.02 per 1M tokens — trivial cost)
- Cosine similarity against every other signal in the village's active cohort
- For each agent, take top-K candidates (K=5 default), apply per-recipient cap (§ 4.19), write outcome to that agent's `~/.openclaw/inbox/index/`
- Returns the same outcome shape Index would return; user agent doesn't know the difference

**Feature flag.** Single env var: `INDEX_NETWORK_MODE = "live" | "fallback"`. Each VM reads this on each cron tick. Flip is operator-only via reconciler config push, no agent code change required.

**Decision rule (commitment).** If Index Network integration isn't end-to-end functional on canary by **May 23**, flip to Plan B for the May 30 launch. We can always migrate back to Index post-launch — the user-facing surface is identical.

**Why this is genuinely good:**
- Eliminates the partner-dependency risk for the most important feature
- Plan B IS a publishable research artifact in its own right ("centralized AI-mediated matchmaking at residential-village scale")
- Latency is actually better than fully decentralized (no negotiation round-trips)
- Cost is negligible (~$50 for the entire village's embedding compute)

**Trade-offs vs Plan A:**
- Plan B has no real "negotiation" — it ranks once, surfaces results, done. No iterative bargaining, no Coasean dynamics. So hypothesis 3 (Coasean bargaining) only validates with Plan A.
- Plan B keeps signal data on InstaClaw infrastructure (already covered by the research DPA); Plan A had it on Index infra (separate sub-processor agreement)

**Open question (Q41):** What's the cohort design implication if we flip to Plan B mid-village? Probably we hold cohort assignments stable and report which engine ran each match in the export schema. Owner: Cooper + Vendrov.

### 4.16 Operational Resilience *(added 2026-05-01)*

What we ship to 500 attendees needs to *survive failure modes the meeting didn't surface*. Adding the missing operational primitives.

**Disaster recovery — VM death mid-village.**
- Memory backup: hourly cron exports `~/.openclaw/workspace/` and `~/.openclaw/memory/` to encrypted S3 (user holds the key — see § 4.17).
- VM death detection: existing fleet-health cron flags unhealthy VMs.
- Auto-restore: when a fresh VM is provisioned for the same user, configureOpenClaw downloads the most recent backup and restores before first boot. User's continuity preserved.

**Privacy mode audit log.**
- Every Support Mode toggle (§ 6.1) writes a row to `audit_log` with `who`, `when`, `vm_id`, `duration`, `reason`.
- Cooper reviews weekly. Anomalies (e.g., one operator flipping Support Mode on dozens of accounts) are surfaced.
- Sampled 5% of activations get an automatic email to the user: "your support mode was active from X to Y because Z" — keeps the operator honest by making the user aware.

**Sponsor-funding failure plan.**
- If sponsor pulls funding mid-village (Q22 risk), agents don't immediately stop. Instead:
  - Token usage is rate-limited per agent (heartbeat frequency drops, briefing length shortens)
  - Users are notified via system-mediated channel (§ 4.13): "your agent is running on reduced capacity due to a temporary funding gap; full service resumes when this is resolved"
  - InstaClaw absorbs the cost ceiling for up to 7 days while a replacement sponsor is sought
- Worst case: revert to BYO API key (existing InstaClaw default) — users provide their own Anthropic key.

**Kill switch.**
- One operator command at the platform level halts all 500 agents' outbound messages (Telegram + XMTP) for the duration of the kill.
- Triggered by: confirmed privacy breach, runaway agent behavior detected by safety monitor, organizer-side request during an emergency.
- Kill is reversible; logs are preserved.
- Dry-run / test-on-canary path so the kill switch itself doesn't malfunction in a real emergency.

**Open question (Q42):** Authority chain for the kill switch — Cooper alone, or Cooper + Timour both authorize? Recommend single-Cooper for emergency speed, with Timour notified within 5 min.

### 4.17 Memory Continuity & Portability *(added 2026-05-01)*

Agent memory is the source of all personalization. Today, memory lives only on the VM. Two failure modes follow:
1. **Operational:** VM dies → memory lost → user starts over. The recent vm-773 wipe incident (CLAUDE.md bf46ee3d wipe-guard fix) was a different mechanism but the same fragility.
2. **Strategic:** users feel locked in. The system isn't trustworthy if leaving means losing what your agent learned about you.

**Solution — encrypted memory backup, user-keyed:**

- Hourly cron on each VM writes `~/.openclaw/workspace/MEMORY.md` + `memory/*.md` to a tarball
- Tarball encrypted with AES-256 using a key derived from the user's wallet signature (Bankr wallet, already provisioned)
- Encrypted blob uploaded to InstaClaw-controlled S3 (or partner-controlled object store; configurable)
- InstaClaw cannot decrypt. Only the user, with their wallet, can.

**Restore paths:**
- **Fresh VM provisioning** (post-disaster): user signs a challenge → server fetches their encrypted blob → decryption key derived from signature → memory restored before first boot
- **Manual export** (portability): user requests download from dashboard → encrypted tarball + a one-line decryption recipe sent to their email. They can take it anywhere.
- **Cross-platform restore** (future): Path B/C deployments can ingest the same blob format using the published decryption recipe.

**Why this matters for research / paper-worthiness.** Memory portability is itself a publishable design pattern — *"agent memory as user-controlled data, agent runtime as fungible infrastructure."* It directly enables research on whether memory continuity changes user behavior across system migrations. Vendrov's hypothesis list could expand to include "personalization durability."

**Open question (Q43):** Should the encrypted blob also include the agent's installed skills + scheduler config, or memory only? Recommend memory-only for v1 (smaller, faster, simpler decryption recipe). Skills + config go in Path B/C bundle separately.

### 4.18 Cohort Design via Time-Staggered Rollout *(added 2026-05-01)*

Vendrov's pre-registered hypotheses depend on having treatment/control cohorts. The standard approach (split the population) creates "I'm in the bad cohort" complaints in a small residential community where everyone talks to each other. **Time-staggered rollout creates clean experimental conditions without dividing the village socially.**

**Pattern:**
- Pre-register the rollout schedule publicly on day 1
- Feature X is OFF for all attendees during week 1
- Feature X turns ON for all attendees at start of week 2
- All data from week 1 = control cohort; week 2+ = treatment cohort
- By end of village, every attendee has had every feature

**Concrete experimental schedule (proposed, finalize with Vendrov):**
- Week 1 (May 30 – Jun 6): baseline. Agents have skill, calendar, attendee directory. NO matchmaking, NO governance.
- Week 2 (Jun 6 – Jun 13): matchmaking enabled (Index or Plan B). Governance still off.
- Week 3 (Jun 13 – Jun 20): governance + group formation enabled.
- Week 4 (Jun 20 – Jun 27): all features enabled. Add experimental features (agent-to-agent micropayments? § 4.20) as they're ready.

**Why this works:**
- Every attendee gets the full feature set by end of village → no "bad cohort" feeling
- Cohort transitions are clean (timestamp-based, no per-user assignment)
- Pre-registration removes researcher-degrees-of-freedom critique
- Allows graceful failure: if a feature is broken, push the rollout to the next week

**Implication for the export schema (§ 4.10.3):** add a `feature_flags_active` column to `cohort_assignments` so each event can be associated with which features were live when it happened.

**Open question (Q44):** Vendrov's blessing on the specific week-by-week schedule. Owner: Cooper + Vendrov. Decision needed by May 23 to leave time to pre-register publicly.

### 4.19 Scale & Throughput Concerns *(added 2026-05-01)*

A 500-attendee village creates failure modes nobody mentioned in the meeting. Inventory + mitigations:

| Risk | Failure mode | Mitigation |
|---|---|---|
| **VM ready pool exhaustion** | Burst signups drain pool, new users hit "no VM available" | Raise `POOL_TARGET` to 50 starting May 20; monitor depletion daily; CLAUDE.md Rule 8 governs manual top-ups |
| **Anthropic per-minute rate limit** | 500 agents firing the 11pm cron simultaneously hit per-minute output token cap | Stagger cron by `hash(agent_id) % 60` minutes (already in § 4.9.2); spreads spike over 1h |
| **Telegram bot creation bottleneck** | Each user creates a bot via BotFather (rate-limited) | Pre-provision a pool of Telegram bots; user just signs in, gets assigned a bot; no per-user BotFather interaction |
| **Stripe webhook flood** | 500 simultaneous checkouts produce a webhook spike | Existing Stripe handling is already idempotent + queued; verify capacity at 500 sustained-RPS |
| **Index Network throughput** | 500 simultaneous `route_intent()` calls overwhelm Index's negotiator infra | Index team's responsibility; if not validated by May 23, flip to Plan B (§ 4.15) which has known capacity |
| **Intro fan-in** | 23 different agents independently try to introduce someone to Person X | Intro aggregation rule (below) |

**Intro aggregation rule (NEW principle).** *Never N notifications for N candidates.* Person X's agent receives a single ranked top-K list per day, not 23 independent intro proposals. Implementation:
- Index negotiator (or Plan B engine) collects all incoming intro proposals for a recipient over the day
- Ranks by mutual-match score
- Surfaces top-K (default K=3) to the recipient agent at the briefing time
- Lower-ranked proposals are recorded as `agent_action: "skipped_due_to_aggregation"` in the research export — actually publishable data

This is the ONLY scalable way to do matchmaking in a 500-person community. Without it, popular attendees become unreachable behind notification storms.

### 4.20 Novel Research Experiments — Pick List *(added 2026-05-01)*

Beyond the five pre-registered hypotheses (§ 4.10.1), there are creative combinations of InstaClaw's existing primitives (Bankr wallets, World ID, Dispatch, skill marketplace, cross-skill agency) that could yield genuinely-unprecedented research artifacts. **This is a pick-list, not a commitment** — Cooper + Vendrov select 1–2 to ship for the village.

| Experiment | Primitive used | Research question | Build cost | Paper-worthiness |
|---|---|---|---|---|
| **Agent-to-agent micropayments** | Bankr wallets | Do emergent agent-mediated micro-economies form in residential AI communities? Tipping for great intros, agent-pooled crowdfunding, micro-bidding | Medium (~1 week) | High — first observation of agent-led economy in a real community |
| **Anonymous pulse polling** | Telegram + briefing | Daily "1-10, how's the village treating you?" → aggregate dashboard. Below-threshold cohort = organizer-review trigger | Low (~2 days) | High — longitudinal community-mood data with daily granularity |
| **Time-shifted matching** | Existing matchmaking + week-of-attendance metadata | Match attendees across weeks they aren't both physically present (Sarah weeks 1–2, Jamie weeks 3–4 → pre-schedule a video call) | Low (~2 days) | Medium — useful UX feature, clean research signal |
| **"What would your agent say?"** | Memory + skill | Public website where attendees can query each other's agents (with consent). Agent answers based on its human's MEMORY.md + stated views | Medium (~1 week) | Very high — provocative, citable artifact, generates a cross-attendee data corpus |
| **Cross-skill agent agency** | Existing skill marketplace | Agent spontaneously proposes using its other skills (Sjinn video, Polymarket, Solana) when contextually relevant during the village | Low — existing skills, just behavior tuning | Medium — observation of agent-driven cross-skill chaining |
| **MEMORY.md as public resource** | Memory + consent surface | Attendees opt to publish portions of MEMORY.md as cite-able knowledge artifacts. "Sarah's agent's notes on AI governance" becomes a community resource | Low (~2 days) | High — first-of-kind shared agent-curated knowledge base |
| **World ID-gated trust ranks** | World ID verification status | Agents prefer World-ID-verified counterparts for high-stakes intros (financial, sensitive partnerships). ~80% of attendees verified | Low (~1 day) | Medium — concrete trust-signal demonstration |
| **Dispatch-mediated "show me" sessions** | Dispatch (remote computer control) | When two agents match on a topic, one offers to use Dispatch to share the user's screen/work. "Show, don't tell" through agent agency | High (~2+ weeks) | Very high — first agent-driven Dispatch use case, but high effort |

**Recommendation for May 30 launch:** ship 2 of the low-cost ones. Best candidates: **anonymous pulse polling** (longitudinal data the meeting didn't realize we could capture) + **MEMORY.md as public resource** (the first concrete demonstration of memory-as-knowledge-artifact).

Save **agent-to-agent micropayments** for week 3–4 reveal — the hardest to build, and shipping it mid-village is the most paper-worthy beat. Bankr wallets are already provisioned; the infrastructure is there.

**Open question (Q45):** Final pick list — which 1–2 (or 3) ship for May 30? Owner: Cooper + Vendrov + Timour. Decision needed by May 13.

### 4.21 Portal Embed — EdgeClaw inside the EdgeOS citizen-portal *(added 2026-05-12)*

Timour's ask: the attendee's "agent hub" should live **inside** the Edge City Portal (the page Edge attendees see when they log in at `edgecity.simplefi.tech` → `/portal/edge-esmeralda-2026`), not as a standalone link out to InstaClaw. When an attendee clicks "EdgeClaw" in the portal sidebar, they see a personalized view of their agent without ever leaving Edge's domain.

The portal is **`citizen-portal`** — the open-source frontend of EdgeOS, built and operated by SimpleFi (p2p-lanes), maintained by Tule (`@tulezao` / `tule@simplefi.tech`). Tech stack: Next.js 15.5.7 + React 19.1.2 + TypeScript + Tailwind + shadcn/ui + Radix + Geist font + Lucide icons + Framer Motion + `@worldcoin/minikit-js` for World ID sign-in. Light theme by default (`bg-neutral-100`). Backend is the separate `EdgeOS_API` repo (FastAPI / PostgreSQL / NocoDB). Source: [github.com/p2p-lanes/EdgeOS](https://github.com/p2p-lanes/EdgeOS), MIT-licensed.

**The pattern is already established.** Cursive's "ZK Coupons" partner module ships today at `/portal/[popupSlug]/coupons/page.tsx` as a full-bleed `<iframe src="https://edge-city-coupons.onrender.com/">`. EdgeClaw mirrors that pattern: own-domain Next.js app, embedded full-bleed in a dedicated sidebar route. We don't reinvent — we reuse the precedent.

**The strategic frame.** This embed is the **daily touchpoint** for 500 attendees over 28 days. It's the thing they click when they want to know "what has my agent been up to?". It is *not* the marketing page (that's our `/edge` at `instaclaw.io`, § 5.1) and *not* the research dashboard (that's `/edge/plaza`, § 4.14). It's the personalized control surface. Get this right and we get daily-active engagement, organic word-of-mouth in a residential setting, and the highest-quality data signal of the village. Get it wrong and attendees feel they have a Telegram bot — nothing more.

#### 4.21.1 What the attendee sees

When `tan@example.com` clicks "EdgeClaw" in the portal sidebar, the iframe loads our embed at `edgeclaw.instaclaw.io`. The view they see, MVP scope:

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  ●  edgecityagent — your agent is live                           │
│  Last active 2 min ago · @edgecity_ravi_bot · privacy: standard  │
│                                                                  │
│  ┌─ TODAY ────────────────────────────────────────────────────┐  │
│  │ This morning your agent looked at 14 attendees and surfaced │  │
│  │ 3 people you might want to meet. 1 of them said yes.        │  │
│  │                                                             │  │
│  │ ↪ Open in Telegram                                          │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ PENDING ───────────────────────────────────────────────────┐  │
│  │ Sarah Chen's agent proposed a meeting about biotech founders │  │
│  │ Wed 3-5pm at Aria espresso bar                              │  │
│  │ [ Accept ]  [ Counter ]  [ Decline ]   ↪ Reply in Telegram  │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ RECENT MATCHES ───────────────────────────────────────────┐  │
│  │ Jamie Lin    ● 0.81  "AI governance researchers"  Tue 9:38pm│  │
│  │ Alex Park    ● 0.74  "Mech interp"                Mon 8:42pm│  │
│  │ Maya Reed    ● 0.66  "Synthetic bio + LLMs"      Mon 8:31pm│  │
│  │ Devin Cho    ◌      "Climate finance"             — declined│  │
│  │                                                             │  │
│  │ See all 12 matches this week →                              │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ CONFIRMED MEETINGS ────────────────────────────────────────┐  │
│  │ Wed 3pm     Sarah Chen   Aria espresso bar       ↪ Calendar │  │
│  │ Fri 11am    Tanya Iyer   Attendee lounge         ↪ Calendar │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ WHO YOUR AGENT HAS MET ───────────────────────────────────┐  │
│  │ ◯ ◯ ◯ ◯ ◯  17 agents · 3 confirmed in-person · 14 online    │  │
│  │ Tap to see who and what you talked about →                  │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ THE VILLAGE RIGHT NOW ─────────────────────────────────────┐  │
│  │ 47 conversations · 12 intros forming · 3 dinners forming    │  │
│  │ See the public plaza →  (anonymized)                        │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  Privacy mode · Settings · ↪ Open in Telegram                   │
└──────────────────────────────────────────────────────────────────┘
```

Modules and the rationale for each, in render order:

| Module | Why it's first/last | Data |
|---|---|---|
| **Status header** (hero) | First glance answers "is my agent working" — the most common implicit question on every load. | `instaclaw_vms` (`health_status`, `last_health_check`, `telegram_bot_username`); privacy state |
| **Today's briefing summary** | The story the agent has to tell about its work since last login. Higher than matches because it gives narrative shape — "your agent did 3 things this morning." | `matchpool_outcomes` filtered to last 24h + the briefing log JSON (cron-generated) |
| **Pending actions** | Highest-leverage CTA on the page — a proposal awaiting reply is the user's most direct lever on their week. Surfaced even if zero. | `negotiation_threads` where state in (`proposed`, `countered`) and receiver = user; mirror in Telegram per § 4.21.5 redundancy |
| **Recent matches** | The "list of people my agent surfaced," scored. Limit 4-5 entries; "See all" linkout. | `matchpool_outcomes` last 7 days, ranked by `deliberation_score` |
| **Confirmed meetings** | The wins. What v2 negotiation actually delivered. Calendar export buttons. | `negotiation_threads` state=`accepted` |
| **Who your agent has met** | The connections graph. v0 ships as a chip-list. v1 ships as a small force-directed graph (§ 4.21.10). | Aggregated from matches + meetings, de-duped per other-user |
| **The village right now** | A peek at the public plaza so users feel the broader system around them. Anchors social proof inside their personal view. | `matchpool_funnel_counts` RPC — same data as `/edge/plaza` |
| **Footer controls** | Privacy mode toggle, settings, deep-link back to Telegram. | `instaclaw_users.privacy_mode_until`, etc. |

What's deliberately **not** in MVP, deferred to iteration:

- A connections **graph** (force-directed, interactive). MVP ships chip-list; v0.2 ships graph (§ 4.21.10).
- 2D plaza embedded inside the hub. § 4.14 v1 is a week 3-or-4 reveal, not Phase 1.
- Inline "Reply" composer for negotiations. MVP punts to Telegram because that's the canonical channel; v0.2 may add inline if friction data justifies it.
- Editable agent profile. Defer — § 5 portal already covers profile and the embed shouldn't fragment that surface.
- Push notifications from inside the iframe. Telegram is the push channel; the embed is the canvas channel. Mixing is confusing.

#### 4.21.2 Embed mechanics — host, route, sidebar entry

**Our domain:** `edgeclaw.instaclaw.io` (new subdomain, separate Vercel project recommended — clean rollback path, separate from `instaclaw.io` cron/build pressures). Falls back to `instaclaw.io/edgeclaw/embed` if subdomain provisioning is delayed past May 25; one DNS record either way.

**Edge route:** `/portal/edge-esmeralda-2026/edgeclaw` inside the citizen-portal. The page is a full-bleed iframe wrapping our embed, mirroring the Cursive coupons file at `src/app/portal/[popupSlug]/coupons/page.tsx`. Tule adds one file (~10 lines) plus one DB row.

**Sidebar entry:** The portal's `ResourcesMenu` reads from a backend `Resource` model in EdgeOS_API. To make "EdgeClaw" appear in the sidebar, Tule (or his backoffice via NocoDB) creates one row: `{slug: "edgeclaw", label: "EdgeClaw", icon: <Lucide icon name>, status: "active", path: "/portal/edge-esmeralda-2026/edgeclaw", popup_slug: "edge-esmeralda-2026"}`. This is data, not code. Reversible by flipping `status` to `inactive`.

**Layout dimensions.** Portal sidebar (shadcn `Sidebar` with `collapsible="icon"`):
- Sidebar expanded: ~256px. Content area: viewport - 256px (commonly 1024-1366 px).
- Sidebar collapsed (icon mode): ~64px. Content area: viewport - 64px.
- Mobile drawer (`vaul`): sidebar swipes out; embed gets full viewport width.

Our embed must render correctly at min 720px wide, ideally responsive down to 360px (mobile drawer collapse). We test in both states before shipping. Telegram is the mobile-first path so the embed's mobile budget is "legible but not gorgeous."

**Theming.** EdgeOS is light by default (`bg-neutral-100`, Geist font). Our embed adopts the Edge brand palette already defined in `app/edge/layout.tsx`:

| Token | Value | Usage |
|---|---|---|
| `--edge-bg` | `#FAFAF7` | Page background |
| `--edge-ink` | `#0E0F0B` | Primary text |
| `--edge-ink-soft` | `#5A5C53` | Secondary text |
| `--edge-olive` | `#29311E` | Primary accent (CTAs, highlights) |
| `--edge-olive-hover` | `#1B210F` | Hover state |
| `--edge-sage` | `#E4F0D2` | Light hover surfaces, accept-confirm |
| `--edge-line` | `rgba(14,15,11,0.10)` | Hairline borders |

This is a **deliberate divergence** from our existing dark `/edge/plaza` design. The portal embed lives inside Edge's light surface; using our dark cards on warm-off-white would be visually jarring. We re-skin to Edge light, retain the same data shape.

**Chrome.** None. The embed has zero `instaclaw.io` navigation, no logo header, no SiteFooter. The whole iframe is content; Edge's own sidebar and chrome surround it.

#### 4.21.3 Authentication — three layers, with explicit fallbacks

This is the load-bearing technical concern. The embed has no inherent way to know who is logged in to the portal unless EdgeOS tells it. Three patterns, in priority order:

**Primary: postMessage JWT handshake** *(target — requires Tule to ship a small wrapper on the portal side)*

1. EdgeOS iframe wrapper page (`/portal/{popupSlug}/edgeclaw/page.tsx`) reads the EdgeOS JWT from the user's cookie via `useGetTokenAuth()` (existing hook).
2. Wrapper renders `<iframe id="edgeclaw" src="https://edgeclaw.instaclaw.io" />`.
3. On iframe `load`, wrapper posts: `iframe.contentWindow.postMessage({type: "EDGEOS_AUTH", jwt: "..."}, "https://edgeclaw.instaclaw.io")`.
4. Embed listens for `message` events from `https://edgecity.simplefi.tech` and `https://edgeesmeralda.simplefi.tech`, verifies origin, accepts the JWT.
5. Embed POSTs `{ jwt }` to its own backend `/api/edgeclaw/session`, which calls `EdgeOS_API/citizens/verify` (server-to-server with the same JWT — see § 4.21.4 ask to Tule).
6. EdgeOS_API responds `{email, popup_slug, citizen_id}`. Our backend issues a short-lived (15-min) signed session cookie scoped to `.instaclaw.io`.
7. Embed renders.

The JWT never lives in a URL. The handshake is async but completes in <500 ms typical.

**Fallback: World ID re-auth inside the iframe** *(zero new dependency on Tule — uses libraries both sides already have)*

Both EdgeOS and InstaClaw use `@worldcoin/minikit-js`. The embed can run its own World ID sign-in inside the iframe:

1. Embed loads, detects no session cookie.
2. Renders a "Continue with World ID" button.
3. User signs (MiniKit, takes ~5 seconds).
4. Embed verifies the World ID proof server-side and looks up the user by World address in our `instaclaw_users` table (`world_address` column already exists).
5. Sets session cookie, renders.

This is the **safe fallback** if Tule can't ship the postMessage wrapper by May 30. Slight UX friction (one tap on first load per session) but zero new partner work.

**Failsafe: signed redirect from EdgeOS** *(if postMessage is technically blocked by a future browser policy or by Tule's deployment)*

A signed URL parameter `?session=<JWT-signed-by-EdgeOS-secret>` exchanged for our session cookie on first load. Less clean (URL leakage risk if user shares the link, replay possible) but works as a last resort. We require Tule to sign with a key we share OOB. **Used only if both postMessage and World ID fail.** The signed token must be one-time-use, server-validated, and bound to the citizen_id; never include the EdgeOS JWT directly in the URL.

**Rule: the embed never renders user data without confirming identity server-side.** The postMessage handshake is convenient, but the verification step (server-to-server with EdgeOS_API) is the trust boundary. A spoofed `postMessage` from an arbitrary origin must fail at server verification. Origin allow-list: `edgecity.simplefi.tech`, `edgeesmeralda.simplefi.tech`, and explicitly NO `*` wildcard.

#### 4.21.4 Data sources

Mapping from embed modules to backing tables/endpoints. Everything reads through new `/api/edgeclaw/*` routes on `edgeclaw.instaclaw.io` — no new database schema; we read existing tables.

| Module | Endpoint | Source |
|---|---|---|
| Status header | `GET /api/edgeclaw/me/agent` | `instaclaw_vms` (`health_status`, `last_health_check`, `telegram_bot_username`); `instaclaw_users` (`privacy_mode_until`) |
| Today's briefing summary | `GET /api/edgeclaw/me/today` | Aggregates `matchpool_outcomes` last 24h; if a briefing-log JSON is written by cron, reads that for the "story" prose |
| Pending actions | `GET /api/edgeclaw/me/pending` | `negotiation_threads` where receiver = user AND state ∈ {`proposed`, `countered`}; `agent_outreach_log` legacy entries with `status='sent' AND ack_received_at IS NULL` |
| Recent matches | `GET /api/edgeclaw/me/matches?since=7d` | `matchpool_outcomes` joined to display-friendly counterpart info; reuses anonymization-OFF path (we know the viewer) |
| Confirmed meetings | `GET /api/edgeclaw/me/meetings` | `negotiation_threads` state=`accepted` with `accepted_window` parsed; ICS export endpoint reuses the same |
| Who your agent has met | `GET /api/edgeclaw/me/connections` | Distinct counterparts across `matchpool_outcomes` ∪ `negotiation_messages` |
| The village right now | `GET /api/edgeclaw/village/snapshot` | Reuses the existing `matchpool_funnel_counts` RPC — same data as `/edge/plaza` |
| Telegram activity (post-MVP) | `GET /api/edgeclaw/me/telegram` | Reads from existing `notification-log.jsonl` aggregation OR new `telegram_message_counts` materialized view |

All endpoints require the signed session cookie (§ 4.21.3) and gate by the resolved `citizen_id → instaclaw_users.id` mapping. No endpoint accepts an arbitrary `user_id` parameter.

#### 4.21.5 Security model

The embed exposes per-user data. The threat model is real: a leaked URL must not leak data; a malicious site iframing our embed must not exfiltrate tokens; an EdgeOS account compromise should be detectable.

**CSP / X-Frame-Options.** The embed sets:

```
Content-Security-Policy: frame-ancestors https://edgecity.simplefi.tech https://edgeesmeralda.simplefi.tech https://*.edgecity.simplefi.tech
```

No `*`. No `X-Frame-Options: DENY` (which would block the entire embed pattern); CSP `frame-ancestors` is the modern equivalent. This stops any third-party site from iframing us.

**postMessage origin check.** The embed validates `event.origin` against the same allow-list before reading the JWT. A `postMessage` from any other origin is silently dropped (no leaks via error messages).

**Session cookie.** `HttpOnly`, `Secure`, `SameSite=None` (required because the cookie is read in a cross-site iframe context), 15-min expiry, signed with HS256 against an env-stored secret. Refresh-on-render so an attendee who keeps the tab open all day doesn't get logged out.

**JWT verification.** The EdgeOS JWT goes through `EdgeOS_API/citizens/verify` on the server side (never in the browser). We trust EdgeOS_API as the IdP for the duration of the village. Verification is mandatory on every session-cookie issuance; never on read.

**Audit log.** Every successful embed render writes one row to `instaclaw_edgeclaw_audit (id, instaclaw_user_id, edgeos_citizen_id, ip, user_agent, at)`. Surface in operator dashboard. Alerts on: same `citizen_id` from >3 IPs in 60 min (account compromise signal), volume spike (mass enumeration).

**Privacy mode interaction.** If `instaclaw_users.privacy_mode_until > now()`, the embed renders an explicit privacy-mode card explaining what's hidden and offers a "Pause privacy mode for 30 min to see this hub" CTA. We do not silently bypass privacy mode in the embed.

**Data minimization.** The embed never shows another attendee's data unless that attendee has matched with the viewer. We don't render the full plaza member list inside the embed; that's `/edge/plaza` territory (already anonymized).

**Non-attendee gate.** If `EdgeOS_API/citizens/verify` returns success but the attendee's email is not in `instaclaw_users` (e.g., they have an EdgeOS account but never claimed an InstaClaw agent), the embed renders an "Activate your agent" CTA that hands off to the existing `/edge-city` claim flow. We do NOT render a partial view.

#### 4.21.6 Relationship to `/edge/plaza`

`/edge/plaza` (§ 4.14 v0, shipped today) is the **public, anonymized** village-wide funnel — accessible at `instaclaw.io/edge/plaza` to anyone with the URL. The portal embed is the **private, personalized** "your agent" hub — gated to the specific attendee.

They share a substrate (`matchpool_outcomes`, `matchpool_funnel_counts` RPC, the calibration data) but they are **separate pages** with separate URL shapes, separate auth gates, and separate visual treatments (the public plaza is dark; the embed is Edge light).

The embed **links to** `/edge/plaza` from its "the village right now" module — a peek at the global funnel for context. It does not embed `/edge/plaza` directly; doing so would mean serving public-anonymized aggregate data inside the personalized view, which is a UX inversion.

**Could they converge later?** Yes, in v1+ if attendees ask for a "village mode" inside the embed. For May 30 they stay separate.

#### 4.21.7 Relationship to § 4.14 plaza v1 (the 2D viz wow moment)

The 2D plaza visualization specced in § 4.14 (Pokemon-like avatars on a canvas, agents only animating on real activity) is the natural week 3-or-4 reveal. The portal embed is its **container**.

When the 2D viz ships, it lands as a new module inside the embed (or a `/portal/.../edgeclaw/plaza` sub-route) — *not* as a replacement for `/edge/plaza`. Three views co-exist:

| Surface | Audience | Visual |
|---|---|---|
| `/edge/plaza` | Public, anonymized | Dark funnel dashboard (today's shipped v0) |
| Embed "village right now" link | Attendee, identified | Same funnel dashboard, anchored from inside the hub |
| Embed "live village" tab (post § 4.14 v1) | Attendee, identified | 2D canvas with avatars; "real motion only" invariant |

The 2D viz inherits the embed's auth and session — no new auth surface. It inherits the embed's "real motion, not choreography" principle from § 4.14. The portal embed is therefore the **delivery vehicle** for the eventual 2D experience, not a competitor to it.

This is also why the embed gets a separate Vercel project (§ 4.21.2): it lets us ship the heavier 2D canvas later without polluting `instaclaw.io`'s build envelope.

#### 4.21.8 What we need from the Edge team

Itemized, by owner and deadline.

**From Tule (SimpleFi / EdgeOS engineering):**

| Need | Why | Effort | Deadline |
|---|---|---|---|
| `Resource` row provisioning for `edgeclaw` slug in `popup_slug=edge-esmeralda-2026` | The sidebar entry that makes the embed discoverable | <10 min DB insert via NocoDB | May 22 (test); May 30 (live) |
| Iframe wrapper page at `/portal/[popupSlug]/edgeclaw/page.tsx` | The mount point that loads our iframe | ~15 lines mirroring the coupons file | May 23 |
| `postMessage` JWT handshake — wrapper posts `{type:"EDGEOS_AUTH", jwt}` on iframe load | The primary auth path (§ 4.21.3) | ~30 lines in the wrapper file | May 26 (canary), May 30 (live). If slips, World ID fallback ships in MVP. |
| EdgeOS_API endpoint `POST /citizens/verify` accepting `{ jwt }` and returning `{citizen_id, email, popup_slug, status}` | Server-side verification of the JWT during our session-cookie issuance | New endpoint; ~50 lines FastAPI | May 26 |
| Confirmation that `frame-ancestors edgecity.simplefi.tech` (and the EE26 subdomain) is acceptable from Edge side | We need to assert who can iframe us; no Edge policy should prevent this | Statement, no work | May 20 |
| Branding QA pass on a staging build | Make sure the embed feels native to the portal | ~30 min review | May 26 |

**From Timour (Edge City product):**

| Need | Why | Effort | Deadline |
|---|---|---|---|
| Approval of the IA in § 4.21.1 | Modules + order match Edge's user expectations | Async review | May 20 |
| Approval of the embed slug, label, and icon | What appears in the sidebar — branding decision | Async | May 22 |
| Communication plan: how attendees learn the embed exists (welcome email mention? post-signup callout?) | Discovery is the gating factor for adoption | 1-2 paragraphs in welcome flow | May 26 |
| Disclosure language for what we collect / show inside the embed | Privacy hygiene; aligns with existing portal privacy expectations | One paragraph; we draft, they approve | May 23 |
| Confirmation that the embed is the **default** post-login surface for attendees with claimed agents (not buried behind a tab) | Discoverability — if it's hidden, daily active drops to single digits | Decision + sidebar ordering | May 26 |

**From InstaClaw side (Cooper / engineering):**

- All `/api/edgeclaw/*` endpoints, the embed Next.js app, deploy pipeline, CSP headers, session cookie machinery, audit log, World ID fallback, Vercel project provisioning, DNS for `edgeclaw.instaclaw.io`, staging build by May 23.

#### 4.21.9 Phased rollout

| Phase | Dates | Scope |
|---|---|---|
| **Phase 0 — internal canary** | May 15-19 | Embed builds on Vercel preview; CSP set; World ID fallback works against a test user; non-Edge iframing blocked. All `/api/edgeclaw/*` endpoints respond against staging DB. No Tule dependency. |
| **Phase 1 — Tule wrapper canary** | May 20-26 | Tule lands the wrapper + verify endpoint; we test postMessage handshake against staging citizen-portal. Iterate. Branding QA. Five test users (Cooper + 4 partner VMs). |
| **Phase 2 — MVP live** | May 27-30 | Production embed shipped at `edgeclaw.instaclaw.io`. Resource row activated in EE26 portal. World ID fallback retained. Hero/Today/Pending/Recent/Meetings/Connections/Village + footer. |
| **Phase 3 — Week 1 polish** | Jun 1-6 | Connections graph (force-directed, mini). Telegram activity stats. Inline pending-action accept/counter/decline (gated on v2 negotiation maturity). Performance budget review. |
| **Phase 4 — Mid-village iteration** | Jun 7-12 | A/B on module ordering based on real engagement data. Add "this week" summary card. Surface frontier marketplace if § 4.20 micropayments ship. |
| **Phase 5 — 2D viz reveal** | Jun 15-22 | § 4.14 v1 lands as a tab/page inside the embed. Real-motion-only invariant. Wow moment. |
| **Phase 6 — Post-village playbook** | Jul-Aug | Make the embed pattern reusable: parameterize popup_slug, abstract Edge-specific tokens, document the integration for Eclipse / Moo / next partner. § 9 reusability deliverable. |

**Hard MVP cut-line for May 30 (drop anything not in this list if time is tight):**
- Status header
- Today's briefing summary (a single string; we generate it from the day's `matchpool_outcomes` aggregate)
- Pending actions (v1 INTRO_V1 + v2 negotiation, both surfaces)
- Recent matches (last 7 days)
- Confirmed meetings (state=`accepted`)
- "The village right now" link to `/edge/plaza`
- Privacy mode controls
- Open-in-Telegram CTA
- World ID fallback auth (always available)

#### 4.21.10 Future modules considered but deferred

| Module | Why interesting | When |
|---|---|---|
| Connections graph (force-directed) | Visualizes who-met-whom across the village; partner-shareable | Phase 3 (Week 1) |
| Inline pending-action composer | Reduces friction vs. Telegram fallback | Phase 3 if data shows >20% drop-off on "Reply in Telegram" |
| Daily streak / contribution score | Gamification — "your agent surfaced 12 useful matches this week" | Phase 4 mid-village; needs careful framing to avoid feeling shallow |
| Cross-event continuity preview | "Your agent met 3 people who will also be at Token2049" | Phase 6 post-village; depends on cross-event memory shipping |
| MEMORY.md excerpt browser | Per § 4.20 "MEMORY.md as public resource" pick | Phase 4 if Cooper + Vendrov select it for the May 30 pick |
| 2D plaza canvas | § 4.14 v1 | Phase 5 |
| Frontier marketplace board | § 4.20 micropayments + listings | Phase 5 if § 4.20 micropayments ships |

#### 4.21.11 Open questions

**Q46.** Domain — `edgeclaw.instaclaw.io` (new subdomain, separate Vercel project) vs `instaclaw.io/edgeclaw/embed` (no new infra). Recommend subdomain for cleaner rollback, build isolation, and future 2D canvas weight. Owner: Cooper. Decision by May 17.

**Q47.** Embed slug + label + sidebar icon — "EdgeClaw" feels right but it's also our partnership brand. Timour may prefer "Your Agent" / "AI Agent" / "Hub" / something neutral. Owner: Timour. Decision by May 22.

**Q48.** postMessage handshake vs World ID re-auth — primary path commits Tule to wrapper work; fallback commits attendee to one tap on first session. Recommend: ship World ID fallback in MVP, layer postMessage on top of it as Tule's wrapper lands. Owner: Tule + Cooper. Decision by May 23.

**Q49.** Telegram bot link format — direct `t.me/<bot>` deep link vs in-embed iframe of Telegram Web. Recommend deep link only (Telegram Web in iframe is unreliable; deep link respects user's existing client). Owner: Cooper. Decision by May 20.

**Q50.** Anonymization inside the embed — when showing "who your agent has met," do we show real names (we know the viewer, so we *can*) or keep Agent #NNN style for consistency with `/edge/plaza`? Recommend real names for confirmed-meeting counterparts (the user already knows who that is) and Agent #NNN for not-yet-met matches (preserves the "see if you're interested before identity is revealed" dynamic). Owner: Cooper + Timour + Vendrov. Decision by May 24.

**Q51.** Module ordering — is "Pending actions" really the right position 2, or does "Today's briefing summary" deserve hero placement? A/B in Phase 4 once we have data; for MVP recommend Pending second (a pending action is the user's most immediate lever). Owner: Cooper. Decision by May 22.

**Q52.** Default-vs-buried question (§ 4.21.8 ask 5) — is EdgeClaw the post-login default for attendees with claimed agents, or just a sidebar entry? Recommend default for claimed agents, sidebar entry for unclaimed. Owner: Timour. Decision by May 26.

**Q53.** Audit-log retention. The `instaclaw_edgeclaw_audit` table — how long do we retain? Recommend 90 days then anonymized aggregation, then drop the raw rows. Owner: Cooper + Vendrov (research ethics aware). Decision by May 24.

**Q54.** What happens at end-of-village (Jun 27)? Does the embed go dormant, redirect to a "village ended" recap, or persist as a permanent attendee surface for future Edge events? Recommend persistence — the agent isn't going anywhere; the embed becomes the cross-event continuity surface (§ 4.21.10). Owner: Cooper + Timour. Decision by Jun 13.

#### 4.21.12 Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Tule's wrapper slips past May 26 | Medium | Low | World ID fallback ships in MVP regardless; postMessage is upgrade-path. |
| Edge applies CSP `frame-ancestors` or X-Frame-Options that breaks the embed | Low (current `next.config.ts` is empty) | High | Confirm with Tule by May 20 (§ 4.21.8 ask 5). |
| Attendees don't discover the embed exists | Medium | High | Welcome email mention (§ 4.21.8 ask 9 to Timour); Telegram bot's first-message could nudge to the embed. |
| Mobile drawer rendering breaks | Medium | Medium | Manual test in Phase 1 against both mobile-Safari (iOS) and Chrome (Android) at portal drawer widths. |
| Privacy mode interaction confuses users | Low | Medium | Explicit privacy-mode card with clear CTA per § 4.21.5; not silent bypass. |
| Session cookie issues across cross-site iframe | Medium | High | `SameSite=None; Secure` + Safari/iOS ITP testing required in Phase 0. Fallback path: short-lived URL-fragment session token if cross-site cookie blocked. |
| Embed renders before auth completes (race) | Medium | Low | Strict loading state — no data fetches until session cookie is set; "Loading your agent…" placeholder. |
| Account-compromise via JWT replay | Low | High | Server-side JWT verification on every session issuance + 15-min cookie expiry + audit-log anomaly detection (§ 4.21.5). |
| 2D viz performance kills the embed when it lands (Phase 5) | Medium (depends on viz tech choice) | Medium | Performance budget locked at 2D-viz PRD time; canvas-only, no DOM-per-agent; defer to v1.1 if needed. |

#### 4.21.13 Summary commitment

We will ship a personalized agent-hub iframe at `edgeclaw.instaclaw.io`, mounted in the EdgeOS citizen-portal sidebar at `/portal/edge-esmeralda-2026/edgeclaw`, with World ID re-auth as the launch-day path and Tule's postMessage handshake as the upgrade path. MVP IA: status, today's briefing, pending actions, recent matches, confirmed meetings, connections, village-snapshot link. Edge light palette. CSP-locked to Edge origins. Audit-logged. Privacy-mode aware. Ready for attendees on May 30; the 2D plaza viz lands inside it mid-village.

This is the daily touchpoint for 500 attendees. Everything else we build for Edge funnels into it.

---

## 5. Partner Portal: `/edge-city`

### 5.0 Pre-Deployment Onboarding — Live Agent (No Chatbot Handoff) *(added 2026-05-01)*

The 2026-05-01 sync produced an onboarding architecture that was a major improvement over the redirect-then-chatbot original. The deeper-thinking pass produced an even better one: **the onboarding IS the user's first conversation with their actual agent.** No separate chatbot, no handoff seam.

**The trick:** a *placeholder shell* runs on a stateless web service (small, cheap, scales to thousands), handles the first ~60 seconds of conversation while the user's VM provisions in the background. When the real agent is ready, the conversation continuation transfers seamlessly. The user never notices the handoff because the message history is preserved and the new agent picks up where the placeholder left off.

```
User clicks "Claim Your Agent"
    │
    ▼
┌─────────────────────────────────────────┐
│ Live chat opens (websocket)             │
│ Connected to: PLACEHOLDER SHELL         │  ← stateless, cheap, scales
│                                         │
│ Placeholder asks:                       │
│   1. Sophistication level               │
│   2. Path selection (defaulted to A)    │
│   3. First intent / goal                │
└─────────────────────────────────────────┘
    │
    ├─── In parallel: VM provisioning starts
    │     (pulls from ready pool, ~30-60s)
    │
    ▼
┌─────────────────────────────────────────┐
│ Real agent boots. Receives:             │
│   - Conversation history so far         │
│   - User's sophistication / path / intent│
│   - Edge skill installed, SOUL.md ready │
│                                         │
│ Same websocket. Real agent continues:   │
│   "Got it — biotech founders. Let me    │
│    ask 1-2 more questions to get you    │
│    set up. Which weeks are you here?"   │
└─────────────────────────────────────────┘
    │
    ▼
Telegram handoff: "your agent is ready, continue here"
```

**Why this is dramatically better than chatbot-then-handoff:**
- **No UX seam.** The user feels like they're already talking to *their* agent. There's no "now you're handed off, please re-introduce yourself."
- **Better personalization.** The real agent's first impression includes how the user actually talks (vocabulary, tone, what they emphasize) — much richer than canned answers ported from a separate chatbot.
- **Faster perceived setup.** The user is already engaged in conversation while provisioning happens in the background. Provisioning latency becomes invisible.
- **Naturally agentic.** The whole experience feels like AI from the first interaction, not a form that pretends to be one.

**Sophistication branching (still applies):** the very first thing the placeholder asks is the sophistication question, which drives path selection (§ 3.5). For Path A users, the real agent boots automatically. For Path B/C, the placeholder asks the rest of the intent questions, then sends the user to the appropriate setup docs (terminal command for B, package download for C).

**Telegram handoff prompt (still applies):** after the real agent has captured intent + verified setup, it prompts "your agent will primarily work through Telegram for matching and intros. Open the bot here →". The dashboard remains available for users who want a GUI; Telegram is primary.

**Implementation surface:**
- **Placeholder shell** — new tiny Next.js route or edge function that maintains conversation state in Redis (or similar) keyed by session. Runs the same Anthropic API calls as a real agent but without the full skill stack.
- **State transfer protocol** — the real agent on the VM, on first boot, fetches `placeholder_state(session_id)` from the placeholder service, ingests it into MEMORY.md, and continues.
- **Websocket hand-over** — client-side, the websocket reconnects from `wss://placeholder.../<session>` to `wss://<vm-id>.vm.instaclaw.io/<session>` without dropping a message. State has already been ported by the time the new connection completes.

**Failure modes:**
- VM provisioning fails: placeholder keeps running for up to 5 minutes; if no VM materializes, user is told "we're working on it, you'll get an email" and the conversation state is preserved for restoration.
- Placeholder service down: fall back to the (now legacy) chatbot-then-handoff path. The placeholder is an *enhancement*, not a hard dependency.
- User disconnects mid-conversation: state preserved 24h; re-authentication restores.

> **Supersedes** the chatbot-then-port-answers pattern proposed earlier in § 5.3. The post-deployment agent-driven interview (also originally in § 5.3) becomes the *continuation* of this same conversation, not a separate event. § 5.3 is updated below.

**Open question (Q39):** Make Telegram strictly mandatory, or keep dashboard-only as a degraded fallback? The Edge team prefers mandatory (matching works much better in Telegram). Cooper's stance: keep dashboard available for power users; make Telegram the *primary* surface. Recommend: ship as "Telegram strongly recommended, dashboard fallback works but features degraded" — let usage data tell us if hard-mandatory is needed.

### 5.1 Page Design

The current `/edge-city` route only redirects to the standard signup flow — that's the gap. **The portal needs to become a real, branded one-page Edge experience** before the village goes live, with educational content and a clear CTA. Per the working session with Timour: focus first on the full onboarding flow + landing page + core product clarity. (Future modules — richer event integrations, optional UI surfaces from other partners — layer in after the core lands.)

A dedicated landing page at `instaclaw.io/edge-city` with Edge City branding. "Powered by InstaClaw" in footer. Timour is offering design help; Cooper sets up the structure and shares the repo for collaboration.

**Branding hierarchy (added 2026-05-01).** The Edge team's strong preference is for users to feel they're signing up to *Edge City*, not InstaClaw. The journey breaks into four surfaces with explicit branding ownership:

| Surface | Brand | Domain |
|---|---|---|
| Pre-signup landing | **Edge City** (primary) | `edgecity.live/agent-village` (canonical, redirects to instaclaw.io/edge-city for now) |
| Onboarding flow (§ 5.0) | **Edge City** throughout | Same — single domain experience |
| Post-signup dashboard | **InstaClaw** (the operational layer) | `instaclaw.io/dashboard` |
| Telegram interaction | **No brand** — just "your agent" | n/a |

**Tactical:** keep `instaclaw.io/edge-city` as the canonical implementation surface for v1; once Edge's web infra is set up, configure `edgecity.live/agent-village` to proxy/redirect transparently. Users who arrive via the canonical Edge URL never see "instaclaw.io" before signup. Users who arrive directly at `instaclaw.io/edge-city` (via partner mailings, sponsor pitches, etc.) see Edge City branding on the page itself, with InstaClaw only in the footer.

**Index, XMTP, Marlowe attribution:** invisible by default. They appear in the FAQ section ("how does this work?") and in the privacy section, but not as primary brand surfaces.

**Required content (v1, pre-village):**

- **Edge City hero / banner** with EE26 branding (Timour to provide assets)
- **Tagline:** "Your personal AI agent for Edge Esmeralda 2026"
- **Product explainer (3-5 bullets):** what the agent does — schedule navigation, people matching via Index Network, Q&A about events/wiki/attendees, governance participation, agent-to-agent coordination overnight
- **Privacy / security explainer** — concrete one-paragraph statement of the privacy model + a link to the privacy mode toggle (Section 6). Pre-empts the conversation rather than waiting for it to surface in Telegram.
- **Edge-specific framing:** what's different about the Edge build vs. standard InstaClaw — the Edge skill, attendee directory access, plaza integration, Granola transcript queries (when they ship)
- **"Claim Your Agent" CTA** — gated by ticket validation (Section 5.4)
- **FAQ section:** at minimum — "How does it work?" / "What data does my agent access?" / "Is my data private?" / "How are updates handled?" / "What if I'm not yet a ticket holder?"

**Optional / future content modules:**

- Map / spatial UI module — owned by Marlowe (Agent Plaza / forum layer partner) — scope and timing tracked separately from the core portal v1
- Live "agents online" counter once the village starts
- Per-week roadmap of features shipping during the village

**Technical:**

- Route: `app/(marketing)/edge-city/page.tsx`
- On page load or CTA click, set cookie `instaclaw_partner=edge_city` (HttpOnly, same pattern as `instaclaw_referral_code`)
- CTA redirects to ticket validation (Section 5.4); on validation success → Google OAuth → checkout
- The signup page reads the partner cookie and shows Edge City branding: "Edge Esmeralda 2026 — Claim Your Agent"

### 5.2 Checkout Flow

After ticket validation (Section 5.4) and Google OAuth:
1. User lands on plan selection
2. Promo code `EDGE` is either auto-applied (via URL param to checkout) or manually entered
3. Stripe charges $0 for first month
4. VM assigned and configured with Edge City skill
5. User redirected to dashboard / Telegram pairing

**Stretch: Auto-apply promo code**
Pass the coupon directly in the checkout session when partner cookie is present:
```typescript
if (partnerCookie === "edge_city") {
  discounts = [{ coupon: "cFq6vaVa" }]; // Partner Trial — Edge City
}
```
This removes friction — Edge users don't need to type a code.

### 5.3 Onboarding Interview — *now part of § 5.0 continuation*

> **Revised 2026-05-01.** The onboarding interview is no longer a separate post-deployment event. It's the *continuation* of the live conversation that started in the placeholder shell (§ 5.0). The real agent inherits whatever the user already shared during the placeholder phase (sophistication, path choice, first intent) and asks only the remaining questions.

The full question set (whether asked by the placeholder, the real agent, or split across both):

1. *Sophistication / path* — asked first, by placeholder. Drives the rest.
2. "What are you most excited about? What are your goals for EE26?" — first intent (placeholder typically captures this; real agent confirms / expands)
3. "What are you working on right now? What's your background?" — real agent
4. "Who do you want to meet? What kind of connections are you looking for?" — real agent
5. "Which weeks are you attending? (Week 1: May 30–Jun 6, Week 2: Jun 6–13, Week 3: Jun 13–20, Week 4: Jun 20–27)" — real agent (or read from ticket validation, § 5.4, if available)

Responses stored in agent memory (`MEMORY.md`). Used for matching, proactive suggestions, personalization.

The real agent doesn't need a separate `BOOTSTRAP.md` script — the SOUL.md edge section + the inherited conversation context is enough for the agent to handle the remaining questions conversationally.

### 5.4 Ticket Validation Flow

Ticket gating is **the primary access control** for the Edge build of the agent. The Edge skill, attendee directory access, and plaza membership are all meaningful capabilities; access to them is restricted to verified Edge Esmeralda ticket holders.

#### 5.4.1 Validation flow

```
User lands on /edge-city
  │
  ▼
Clicks "Claim Your Agent"
  │
  ▼
Enters Edge ticket identifier (email associated with ticket purchase, or ticket reference)
  │
  ▼
Backend hits Edge ticketing API → returns: { valid: true|false, ticket_metadata: { weeks: [1,2], … } }
  │
  ├── invalid → soft-fail page with "Get a ticket at edgeesmeralda.com" CTA + email capture for waitlist
  │
  ▼ valid
Google OAuth
  │
  ▼
Checkout with EDGE promo (Section 5.2)
  │
  ▼
VM provisioned with edge_city partner tag → Edge skill installed
```

The validation result (ticket reference + valid weeks) is recorded on the user row alongside `partner = "edge_city"`. The agent's onboarding interview (Section 5.3) reads `weeks` to populate the agent's awareness of when its human is on-site.

#### 5.4.2 Test ticket requirement (BLOCKER)

**Outstanding blocker for E2E validation:** Cooper needs a sandbox / dummy test ticket from Edge City's ticketing system to validate the full flow before broader rollout. Without this, the integration is built but not end-to-end-verified.

Action: Timour to provision (or pull from sandbox tier of) a test ticket Cooper can use for the validation pass. This unblocks the May 9 portal-live milestone.

#### 5.4.3 Access duration & revocation

Ticket gating is enforced at **claim time** (the moment the user converts on the portal). After that, the agent persists for the user's standard subscription lifecycle. If a ticket is revoked or transferred *after* claim, the existing agent isn't auto-disabled — that's a deliberate choice (cancellation events flow through the standard subscription system, not the ticketing layer).

The Edge skill is gated separately at the *infrastructure* layer (`partner === "edge_city"` in `instaclaw_users`), so even if a non-Edge user somehow ends up with the Edge skill installed, the skill itself behaves identically — but their access to live Edge APIs (Social Layer, EdgeOS Attendee Directory) goes through tokens that are scoped to Edge participants only and revoked on any ticketing-system signal that surfaces.

---

## 6. Privacy & Security

| Concern | Mitigation |
|---------|------------|
| Attendee data access | EdgeOS API has built-in privacy — hidden fields return `"*"`. Agent instructed to respect this in SKILL.md. |
| Cross-agent data leakage | Each agent is fully isolated on its own VM. No shared filesystem or memory between agents. |
| Partner skill isolation | Skill only installed on `partner="edge_city"` VMs. Non-Edge users never have the skill or API tokens. |
| API token scope | `EDGEOS_BEARER_TOKEN` is read-only for attendee directory. `SOLA_AUTH_TOKEN` allows event creation but is scoped to group 3688. |
| Data retention | Standard InstaClaw 30-day wipe after subscription ends. Agent memory is destroyed. |
| Edge City branding | "Powered by InstaClaw" — Edge City controls the portal, InstaClaw is infrastructure. |
| **Index Network as sub-processor** | Index Network is contractually treated as a sub-processor under the same DPA scope as InstaClaw's own infrastructure. Receives only what the agent submits as availability signals (Section 4.9.5 row "Index Network signal scope"). DPA includes deletion timeline, sub-processor transparency, and incident notification. |
| **Index Network log retention** | Match-candidate logs retained by Index Network only for village + 30-day analysis window, then deleted (open question Q19). |
| **Researcher data export — anonymization** | `agent_id` in research tables is a one-way hash of `(bankr_wallet, edge_city_research_salt)`. Salt is held only by InstaClaw and rotated post-village. Vendrov cannot reverse it. |
| **Researcher data export — PII review** | Free-text fields (interests, goals) regex-swept + 1% manual spot-check before each export drop. |
| **Researcher data export — retention** | Export artifacts deleted no later than 90 days post-village close unless retention is formally extended via an amended DPA. |
| **Sponsor inference visibility** | Under Model A (shared sponsor key, Section 4.10.2), sponsor sees only aggregate token usage, not per-agent or per-message content. Anthropic / OpenAI's standard non-training API terms apply for any sponsor-funded inference. |
| **Onboarding consent** | Granular sharing consent captured during onboarding interview. Default: name + interests. Upgrade tiers gated by explicit human opt-in (Section 4.9.5). |
| **Human override (always-on)** | Human can issue overrides at any time: "stop sharing my interests", "don't propose meetings tomorrow", "don't include me in research data export". Agent honors immediately and writes the override to MEMORY.md. |

### 6.1 Privacy Modes (User-Facing Toggle)

InstaClaw is built privacy-first. The default posture across the entire fleet is that no one — including InstaClaw operators — reads agent ↔ human conversations, agent memory, or agent-to-agent traffic. Inspection of an individual agent's runtime is gated behind a deliberate user action.

| Mode | Default | Behavior |
|------|---------|----------|
| **Maximum Privacy** | ON for every new agent | Operator-side inspection of conversation content, memory files, and per-agent logs is **disabled**. Aggregate health telemetry (CPU, RAM, gateway up/down, error rates) still flows for fleet operations. Researcher data export pipeline (Section 4.10.3) still runs because it operates on already-anonymized aggregate research tables, not the raw agent context. |
| **Support Mode (temporary)** | OFF | User can temporarily disable Maximum Privacy via a clearly-labeled toggle in the agent's settings — typically when they want help debugging an issue. While disabled, InstaClaw operators can read the live session, run `mcporter` commands, and inspect memory in order to diagnose. The toggle is **session-scoped**: re-enables itself automatically after 24 hours, on subscription billing cycle rollover, or on user-initiated re-toggle. |

**Why this matters for Edge:**
- Researchers (Vendrov + collaborators) **never** receive raw conversational content under either mode. They only receive the anonymized research tables (Section 4.10.3) — the privacy modes do not gate that pipeline.
- The privacy toggle lets attendees say "yes, I want help" without giving up the default privacy posture for everything else.
- The Edge skill, like all skills, runs entirely within the user's agent VM. Maximum Privacy Mode does not impede agent functionality (Index Network signals, briefings, governance, etc.) — it only restricts operator-side visibility into the agent's runtime.

**Communicated on the portal FAQ (Section 5.1):** "Your agent is yours. By default, even we can't read your conversations or memory. If something breaks and you want help, you can flip a toggle that lets us look — and it auto-flips back."

### 6.2 Researcher Visibility Boundary

To avoid any ambiguity about what the research collaboration does and does not include:

- ✅ Researchers receive: anonymized aggregate tables defined in Section 4.10.3, hashed `agent_id`, PII-swept free-text fields, sponsor-funded inference cost summaries.
- ❌ Researchers do NOT receive: raw Bankr wallets, raw Telegram conversation transcripts, agent MEMORY.md contents, raw Index Network candidate-pool data with wallets attached, sponsor-key-level inference logs, anything that would survive a salt rotation.
- ❌ Cross-export longitudinal analysis on the same human is structurally prevented by salt rotation + per-human consent gating (Section 4.10.3).

---

## 7. Implementation Plan

### Phase 0: Foundation (1-2 days)
- [ ] **Migration**: Add `partner` column to `instaclaw_users` and `instaclaw_vms`
- [ ] **Auth flow**: Read `instaclaw_partner` cookie in `lib/auth.ts` signIn callback, set on user creation
- [ ] **Cookie setter**: Partner portal page sets the cookie before redirecting to signup
- [ ] **Env vars**: Add `EDGEOS_BEARER_TOKEN` and `SOLA_AUTH_TOKEN` to Vercel env vars (get tokens from Tule)
- [ ] **Promo code auto-apply**: When partner cookie is `edge_city`, auto-apply the EDGE coupon at checkout (no manual code entry)

### Phase 1: Skill Install + Portal (2-3 days)
- [ ] **`installEdgeCitySkill()`**: Write function in `lib/ssh.ts` following `installAgdpSkill()` pattern
- [ ] **Hook into `configureOpenClaw()`**: Gate on `partner === "edge_city"`, call install function
- [ ] **SOUL.md Edge section**: Add Edge Esmeralda context paragraph to SOUL.md for Edge users
- [ ] **BOOTSTRAP.md onboarding interview**: Write interview script for Edge users' first conversation
- [ ] **Reference content cron**: Add git-pull cron during skill install for fresh reference data
- [ ] **Partner portal page**: Build `app/(marketing)/edge-city/page.tsx` with Edge City branding (educational landing page — see Section 5.1 for required content blocks: hero, product explainer, privacy/security explainer, Edge framing, ticket-gated CTA, FAQ)
- [ ] **Privacy explainer copy**: Draft the portal-facing explanation of Maximum Privacy Mode + Support Mode toggle (Section 6.1), reviewed before portal goes live
- [ ] **Register skill dir**: Ensure `~/.openclaw/skills/edge-esmeralda` is added to `extraDirs`

### Phase 1b: Ticket Validation Flow (BLOCKER for portal launch)
- [ ] **Procure test ticket**: Get a sandbox / dummy Edge ticket from Timour for E2E validation. **This is the gating blocker before May 9 portal-live milestone** (Section 5.4.2).
- [ ] **Edge ticketing API integration**: Wire `/edge-city` claim endpoint to Edge ticketing system; validate ticket reference, return `{valid, weeks}` payload
- [ ] **Validation UI**: Soft-fail page for invalid tickets (CTA → edgeesmeralda.com + waitlist email capture)
- [ ] **Persist ticket data**: Store ticket reference + valid-weeks on `instaclaw_users.partner_metadata` so onboarding interview can read attendance windows
- [ ] **Edge skill infra-layer gate**: Skill access tokens (Social Layer, EdgeOS) scoped per-participant; revocation signals from Edge ticketing flow trigger token-scope revoke (Section 5.4.3)

### Phase 1c: Granola Retrieval Benchmark Suite (locked by May 23)
- [ ] **Source transcripts**: Pull recent Granola meeting notes covering Edge planning calls, partner syncs, infra/research discussions (with appropriate consent from participants); strip / replace PII before any agent reads them
- [ ] **Benchmark question set**: Generate ~20-30 retrieval questions spanning factual recall ("who is the Index Network point of contact?"), multi-doc synthesis ("what's the agreed split between Index Network and XMTP?"), and recency ("what changed in the most recent partner sync?")
- [ ] **Ground truth**: Annotate expected answers / source-doc citations for each question
- [ ] **Eval harness**: Wire benchmark into the existing Section 2.5 benchmark runner; report pass/fail + retrieval precision per question
- [ ] **Lock the suite by May 23**: After lock, the benchmark is the version-pinned regression check; new transcripts can be added in v2 post-village
- [ ] **Wire transcripts into the Edge skill**: Decide whether transcripts ship as embedded reference data, are pulled on-demand from a hosted source, or are fetched via Index Network — affects retrieval architecture (open question Q22)

### Phase 1d: Pre-Deployment Onboarding (Live-Agent Pattern) — locked May 13 *(added 2026-05-01)*
- [ ] **Placeholder shell service**: Stateless edge function (Vercel Edge or similar) that opens a websocket, runs Anthropic API calls, persists session state in Redis. Bootable in <50ms; scales to 1000+ concurrent.
- [ ] **State transfer protocol**: VM agent on first boot fetches `placeholder_state(session_id)` and continues from where the placeholder left off. Spec the session-id format, the state shape, and the handoff signal.
- [ ] **Sophistication branching**: First message in the placeholder asks the sophistication question; routes to Path A/B/C UX accordingly.
- [ ] **Path B handoff**: when the user is on Path B, the placeholder finishes the intent collection, then sends them to the terminal-setup docs at `/edge-city/self-serve` with their captured intent embedded as a copy-paste config block.
- [ ] **Path C handoff**: similar — captured intent goes into the downloadable bundle's `quickstart.md`.
- [ ] **Failure-mode handling**: VM provisioning timeout > 5min → user notified, session preserved 24h.

### Phase 1e: Notification Cadence + Messaging Integrity — locked May 13 *(added 2026-05-01)*
- [ ] **Priority queue implementation** at the agent layer (P0 / P1 / P2 / P3, § 4.9.2.5). Sender hint + agent's-final-say semantics.
- [ ] **Heartbeat frequency floor** — 5-minute minimum enforced at the OpenClaw config-schema layer (per CLAUDE.md Rule 2: verify schema acceptance before deploying).
- [ ] **Cost visibility in dashboard** — show user "your current cadence costs ~$X/day" before they raise it. Pulls from credit-ledger to be accurate, not a static estimate.
- [ ] **External system inbox** — `~/.openclaw/inbox/<source>/` directory + JSONL spec (§ 4.13). Cron polls inbox, agent processes.
- [ ] **Cross-system idempotency** — dedup by `id` field across sources before surfacing to user.
- [ ] **System-mediated emergency channel** — separate Telegram path that bypasses the agent for security alerts and billing-critical issues. Identify the audit trail.

### Phase 1f: Operational Resilience — locked May 22 *(added 2026-05-01)*
- [ ] **Memory backup cron** — hourly tarball of workspace+memory, encrypted with user-derived key from Bankr wallet signature, uploaded to S3 (§ 4.17).
- [ ] **Auto-restore on fresh-VM provisioning** — configureOpenClaw downloads the most recent backup if `assigned_to` user has prior memory blob.
- [ ] **Privacy mode audit log** — every Support Mode toggle written to `audit_log` with reason + duration. Sample 5% of activations send the user an automatic email summary.
- [ ] **Sponsor-failure plan** — token rate-limit logic that triggers if sponsor key is revoked. User notified via system-mediated channel.
- [ ] **Kill switch** — single operator command halts all 500 agents' outbound (Telegram + XMTP). Test on canary first; document the restore procedure.
- [ ] **VM ready pool sizing** — raise `POOL_TARGET` to 50 starting May 20 (Q35); monitor depletion daily; coordinate with Linode for capacity.

### Phase 1g: Path B + Path C Distribution — locked May 22 *(added 2026-05-01)*
- [ ] **Edge Compatibility Contract spec** (§ 3.5.1) — write the four-surface spec as a public document, version it.
- [ ] **`edge-conformance` test suite** — small CLI that exercises each contract surface, returns pass/fail per surface.
- [ ] **Path B CLI** — `npx @instaclaw/edge-cli setup` (or equivalent) that bootstraps a local OpenClaw with the Edge skill, tokens, routing surface.
- [ ] **Path C downloadable bundle** — `github.com/coopergwrenn/edge-compatibility-pack` (or equivalent) with skill content, auth examples, routing reference, conformance runner.
- [ ] **`/edge-city/self-serve` page** — 2-page quickstart for Path B users.
- [ ] **`/edge-city/builders` page** — Path C bundle download + integration guide.

### Phase 2: Test + Launch (1-2 days)
- [ ] **Canary deploy**: Provision 1 test VM, run full configureOpenClaw() with partner=edge_city
- [ ] **Run benchmark questions**: Test the full Granola benchmark suite (~20-30 questions, Section 2.5) against the canary agent
- [ ] **Verify skill isolation**: Confirm non-Edge VMs do NOT have the skill installed
- [ ] **Verify ticket validation E2E**: portal → enter test ticket → validate → checkout → deploy → agent receives onboarding interview with correct weeks (requires test ticket from Phase 1b)
- [ ] **Verify Maximum Privacy Mode default**: Inspect canary VM as operator, confirm conversation/memory inaccessible until user toggles Support Mode; verify Support Mode auto-reverts after 24h
- [ ] **Verify managed update policy enforcement**: Attempt agent-initiated `npm install -g openclaw@latest`; confirm vm-watchdog.py reverts and re-pins to manifest version (Section 4.11.3)
- [ ] **Share test accounts with Edge City team**: 3-5 accounts for Timour, Tule, Alejandro to test
- [ ] **Iterate on SOUL.md / onboarding**: Adjust based on team feedback

### Phase 3: Index Network + XMTP Agent-to-Agent Layer (2-3 weeks)
- [ ] **First sync with Index Network team**: Read game plan Notion doc, agree on architecture split (Index Network = matching, XMTP = brokering)
- [ ] **Index Network signal schema**: Lock the request/response shape for `submit_signal()` and `get_matches()` with the Index Network team
- [ ] **Index Network API integration**: Agent submits availability signal, receives ranked matches
- [ ] **Match-stream vs. batch decision**: Decide whether matches stream in real-time during the overnight window or are returned in one batch at the cron tick
- [ ] **XMTP SDK integration**: Install `@xmtp/node-sdk`, write XMTP client service script
- [ ] **Wallet identity**: Wire Bankr wallet private key into XMTP client for agent authentication
- [ ] **XMTP systemd service**: `xmtp-client.service` running alongside gateway, auto-restart
- [ ] **Plaza groups**: Create `ee26-plaza`, `ee26-governance`, `ee26-events` XMTP groups
- [ ] **Message queue**: File-based inbox/outbox (`~/.openclaw/xmtp/inbox.jsonl`, `outbox.jsonl`) for OpenClaw agent to read/write
- [ ] **Plaza skill**: Write SKILL.md section for XMTP send/receive + Index Network query primitives
- [ ] **Content types**: Define and implement structured message types (availability signals, intro proposals, governance votes, group formation, match candidates)
- [ ] **Overnight planning cron**: 4 cron jobs (11 PM signal + Index Network submit, 4 AM pull matches + XMTP DMs, 5 AM compile, 7 AM Telegram briefing)
- [ ] **Morning briefing template**: Telegram message format for curated daily plan
- [ ] **Privacy controls**: Onboarding questions for sharing consent, human override commands
- [ ] **Canary test**: 5-10 test agents running full Index Network → XMTP → briefing cycle overnight
- [ ] **`installXMTPClient()`**: Integrate into `configureOpenClaw()` behind `partner === "edge_city"` gate

### Phase 4: Governance, Treasury & Scale (ongoing, pre-event)
- [ ] **Governance voting flow**: Proposals broadcast via XMTP, agents surface to humans via Telegram, votes cast back via XMTP
- [ ] **Treasury / agent faucet**: USDC distribution mechanism, funding proposals via XMTP governance channel
- [ ] **Sentiment aggregation**: Coordinator agent collects anonymized nightly sentiment, surfaces to organizer dashboard
- [ ] **Group formation**: Agent-to-agent dinner/activity coordination via Index Network cluster query + XMTP invitation
- [ ] **Provision VMs**: 500-1000 VMs in ready pool (coordinate with Linode — $29/mo dedicated CPU)
- [ ] **Monitoring dashboard**: Partner-specific metrics — active agents, XMTP message volume, Index Network match latency, matches made, governance participation
- [ ] **Load testing**: Simulate 1,000 agents posting availability signals simultaneously, verify XMTP throughput AND Index Network match latency <5min

### Phase 5: Research Layer (concurrent with Phase 4, pre-event)
- [ ] **DPA / NDA with Vendrov**: Sign before any data leaves InstaClaw infrastructure (May 1 milestone)
- [ ] **Research data export schema**: Build the 5 research tables defined in Section 4.10.3 (`research.agent_signals`, `research.match_outcomes`, `research.briefing_outcomes`, `research.governance_events`, `research.cohort_assignments`)
- [ ] **Anonymization layer**: Implement `(bankr_wallet, edge_city_research_salt)` → `agent_id` one-way hash. Salt held only by InstaClaw, rotated post-village.
- [ ] **PII-review sweep**: Regex sweep + 1% manual spot-check on free-text fields before each export drop
- [ ] **Decide D1 vs D2 delivery**: Postgres replica (D1) vs Parquet drop to researcher-controlled bucket (D2). Recommend D2.
- [ ] **Research consent capture**: Onboarding interview includes opt-in for "include in research data export" (separate from sharing consent)
- [ ] **Per-human longitudinal opt-in**: Additional explicit opt-in for tracking one specific person across 28 days
- [ ] **Cohort assignment endpoint**: API for Vendrov to populate `research.cohort_assignments` for treatment/control studies
- [ ] **Sponsor key plumbing**: Implement Model A (shared sponsor key) — Anthropic + OpenAI key injection at the auth-profiles.json layer for Edge VMs
- [ ] **Sponsor usage dashboard**: Aggregate token usage view sponsors can see (no per-agent or per-message detail)
- [ ] **Plaza architecture open-source repo**: Publish `installEdgeCitySkill()` template, XMTP client harness, plaza skill SKILL.md, content type definitions, overnight planning cron skeleton, anonymized data export schema. Coordinated release with Edge City's plaza architecture publication (May 30).
- [ ] **Researcher onboarding doc**: Walk-through for Vendrov (and future research collaborators) — how to query the export, what fields mean, examples of cohort analysis

---

## 8. Open Questions

| # | Question | Owner | Status |
|---|----------|-------|--------|
| 1 | API tokens — does Tule have `EDGEOS_BEARER_TOKEN` and `SOLA_AUTH_TOKEN` ready for us? | Tule/Timour | Pending |
| 2 | How many test accounts does Edge City team need initially? | Timour | Said ~5-10 for team testing |
| 3 | Edge City portal branding assets (logo, colors, hero image)? | Timour | Needed for portal page |
| 4 | Should the promo code auto-apply or require manual entry? | Cooper | Recommend auto-apply for frictionless UX |
| 5 | Do Edge agents get a specific tier (starter/pro/power) or does the partner choose? | Cooper/Timour | Recommend pro tier for best demo experience |
| 6 | Onboarding interview — structured (bot-driven) or conversational (agent-driven)? | Cooper | Recommend agent-driven via BOOTSTRAP.md |
| 7 | When should the portal be live for early signups? | Timour | Needs timeline alignment |
| 8 | Shared data layer API contract — is Tule publishing an OpenAPI spec? | Tule | Pending |
| 9 | Do attendees need to be ticket holders to claim an agent? (gating mechanism) | Timour | Initially yes — incentivize ticket sales |
| 10 | Local compute / OpenRouter support timeline? | Cooper | On roadmap, no date yet |
| 11 | **XMTP: Which SDK version?** `@xmtp/node-sdk` vs `@xmtp/mls-client` vs `@xmtp/browser-sdk` — need to confirm best fit for server-side Node.js agents | Cooper / XMTP team | Pending — show spec to XMTP team |
| 12 | **XMTP: Group creation** — who creates the plaza/governance/events groups? Need an admin wallet or coordinator agent with group creation authority | Cooper | Design decision needed |
| 13 | **XMTP: Message throughput** — can XMTP handle 1,000 agents posting availability signals within a 1-hour window? Need load testing or confirmation from XMTP team | XMTP team | Ask during partnership call |
| 14 | **XMTP: Wallet key access** — does the XMTP client need the Bankr wallet's raw private key, or can it use a derived signing key? Security implications. | Cooper / Bankr | Need to check Bankr key export API |
| 15 | **Treasury: Funding source** — who funds the agent faucet? Edge City org? Sponsors? Attendee pool? How much per agent? | Timour | $20-25 per first vote mentioned in Newsworthy context |
| 16 | **Privacy: Sharing consent UX** — during onboarding, how granular should sharing controls be? ("Share my interests" vs "Share my name + interests + goals") | Cooper / Timour | Recommend simple 3-tier: name-only / interests / full profile |
| 17 | **Index Network: API contract** — exact request/response shape for `submit_signal()` and `get_matches()`, plus group-formation cluster query | Index Network team | Read game plan Notion + first sync call |
| 18 | **Index Network: Match throughput** — can it process 1,000 agents nightly with sub-5-min latency end-to-end (signal in → ranked matches out)? | Index Network team | Confirm during partnership call; load test before May 9 canary |
| 19 | **Index Network: Hosting model** — matching service runs on Index Network infrastructure, or do we self-host an instance? Affects latency, privacy boundary, sponsor accounting. | Index Network team | Pending — likely managed by Index Network |
| 20 | **Index Network ↔ XMTP boundary** — does Index Network just rank candidates, or does it also broker the introduction request? Recommend: Index Network ranks; XMTP handles the actual handshake. Lock before signal schema work begins. | Cooper / Index Network | Design call, week of Apr 30 |
| 21 | **Researcher data access surface** — what does Vendrov get? Anonymized log dump? Read-only postgres replica? Real-time stream? Defines the export pipeline scope. | Vendrov / Timour / Cooper | Lock before Phase 3 starts |
| 22 | **Sponsor commitment timeline** — when do sponsor funds need to be confirmed for InstaClaw to confidently NOT gate features? Soft deadline = May 15 to leave room for routing changes. | Timour | Tied to blog post launch + outreach cadence |
| 23 | **API key model for sponsored compute** — Model A (shared key), B (per-agent BYOK with sponsor as funder), or C (InstaClaw resells credits)? Affects auth-profiles.json, Bankr integration, billing audit trail. | Cooper / Timour / sponsors | Recommend Model A for round 1, evaluate B/C post-village |
| 24 | **Recruit Seb Krier directly?** — His *Coasean Bargaining at Scale* paper (arxiv:2509.05077) is the theoretical backbone of hypothesis H3. Worth offering co-author / collaborator status on Vendrov's paper rather than just citing him. | Timour / Vendrov | Suggest Timour reaches out via Cosmos / DeepMind channels |
| 25 | **CIP partnership for governance experiments?** — CIP's *Alignment Assemblies* methodology is closest existing precedent for our deliberation experiments. Co-design + co-author opportunity. | Timour | Reach out to CIP research team after pre-registration is locked |
| 26 | **Coordinator agent funding & ownership** — Who funds compute for the 5 coordinator agents (Section 4.9.9)? Counts toward the $60K sponsor ask but is a small fraction (<5%) of total inference. Who owns the operational accounts (Bankr wallets)? | Cooper / Timour | Recommend InstaClaw owns wallets; sponsor-funded inference; admin accountable to Edge City. |
| 27 | **Polis integration** — do we use the actual Polis API ([pol.is](https://pol.is)) for opinion clustering, or implement Polis-style clustering ourselves in the governance coordinator agent? Trade-off: external service dependency vs. agent-owned implementation. | Cooper / governance-design lead | Lean toward agent-owned implementation; eval Polis SaaS as Phase 4 enhancement. |
| 28 | **Geo (geobrowser.io) integration shape** — does Yaniv's team publish a public read API for the community knowledge graph that Index Network and personal agents both query? Or does each consumer get its own integration? | Yaniv / Tule / Index Network | First sync to lock the contract |
| 29 | **Test ticket for portal validation** — who provides the sandbox / dummy Edge ticket, and in what format (real ticket reference in a sandbox tier vs. a dedicated test mode in the ticketing system)? Without this, the May 9 portal-live milestone is blocked (Section 5.4.2). | Timour | Ask in next sync; drives Phase 1b |
| 30 | **Skill update cadence — push or pull?** Section 4.4 commits to "skill is the primary update surface" and notes daily updates are possible. Mechanism: per-VM cron pulling from a canonical git source (resilient, no secrets in Edge skill repo) vs. push-based reconciler triggered on commit. Also: rate-limit per day to bound blast radius? | Cooper | Lean toward git-pull cron + per-day rate limit; revisit if iteration speed demands push |
| 31 | **Maximum Privacy Mode implementation** — at what runtime layer is operator inspection actually disabled (filesystem ACL on memory files, gateway-side audit-log gating, mcporter token scoping, all three)? Default ON ships with the rest of the privacy commitments; Support Mode auto-revert lifecycle owned by `lib/auth.ts` or a dedicated privacy-state service? | Cooper | Spec out before May 9 portal-live so the toggle copy isn't a promise we can't keep |
| 32 | **Granola transcript ingestion pipeline** — where do transcripts live (private S3 bucket? committed to a private skill repo? hosted with chunked retrieval)? Are they pulled into every Edge VM at install time (latency: low; storage: bounded) or fetched on-demand (latency: higher; storage: nil; central audit log: yes)? Affects retrieval performance + the meaning of the benchmark numbers. | Cooper | Recommend pulled-at-install for v1 (~MB-scale corpus), fetched-on-demand if corpus grows past hundreds of MB. Lock before May 23 benchmark freeze. |
| 33 | **User-facing comms when newer OpenClaw features unsupported** — surface area for explaining the "your version is stable, not stale" framing (Section 4.11.4): in-portal FAQ, in-agent system message when a user asks about a feature beyond the pinned version, both? Need a draft FAQ entry plus an agent-side response template before launch. | Cooper / support | Draft as part of Phase 1 portal copy review |
| 34 | **Per-VM update batch sizing** — the canary-then-fleet rollout (Section 4.11.2) needs concrete batch sizes (e.g., canary: 1 → 5% → 25% → 100%) and pause durations (e.g., 24h soak between canary and 5%). Encode in the reconciler so the policy isn't operator-discretionary. | Cooper | Pick numbers based on existing fleet update incidents; codify in `vm-manifest.ts` |
| **35** | **Path C distribution channel** (§ 3.5.2) — GitHub release tarball, npm package, both, or a custom installer? | Cooper | Recommend tarball + npm. Tarball is universal; npm is what JS-builders expect. |
| **36** | **Index Network routing trigger policy** (§ 4.9.1) — when does the user agent invoke `route_intent()`? Keyword triggers, implicit / ambient context, or hybrid? | Cooper | Hybrid: keyword triggers explicit, ambient triggers implicit. Spec the keyword list before Phase 3. |
| **37** | **Notification-cadence initial thresholds** (§ 4.9.2.5) — does v1 ship with 4 ambient + 1 briefing, or stricter (2 + 1)? | Cooper + Timour | Default to stricter for v1; widen post-village if usage suggests headroom. Decision by May 13. |
| **38** | **External-system inbox wire format** (§ 4.13) — JSONL files (working assumption) vs. DB-backed queue. | Cooper | Recommend JSONL for v1; matches existing XMTP inbox pattern. |
| **39** | **Telegram strictly mandatory vs. dashboard-fallback** (§ 5.0) — force Telegram, or allow dashboard-only with degraded features? | Cooper + Timour | Recommend "strongly recommended, not strictly required" for v1; let usage tell us. |
| **40** | **Live Activity Dashboard scope** (§ 4.14) — public/anonymized at edgecity.live, or attendees-only? | Cooper + Timour | Recommend public-anonymized; doubles as marketing artifact. Decision by May 20. |
| **41** | **Plan A vs Plan B mid-village transition policy** (§ 4.15) — if we flip mid-village, how do we represent the change in the cohort/research data? | Cooper + Vendrov | Hold cohort assignments stable; record `match_engine: "plan_a"\|"plan_b"` in the export schema. |
| **42** | **Kill switch authority chain** (§ 4.16) — Cooper alone, or Cooper + Timour both authorize? | Cooper + Timour | Recommend single-Cooper for emergency speed, with Timour notified within 5 min. |
| **43** | **Memory backup blob scope** (§ 4.17) — memory-only, or also skills + scheduler config? | Cooper | Recommend memory-only for v1; skills + config go in Path B/C bundle separately. |
| **44** | **Time-staggered rollout schedule** (§ 4.18) — Vendrov's blessing on the week-by-week feature rollout? | Cooper + Vendrov | Decision needed by May 23 to leave time to pre-register publicly. |
| **45** | **Novel-experiment pick list** (§ 4.20) — which 1–2 ship for May 30? Recommended: pulse polling + MEMORY.md as public resource; agent-to-agent micropayments as week 3–4 reveal. | Cooper + Vendrov + Timour | Decision by May 13. |

---

## 9. Reusability for Future Partners

This architecture is designed to generalize:

| Component | Reusable? | How |
|-----------|-----------|-----|
| `partner` column on users/VMs | Yes | Any partner tag value |
| Partner cookie + auth flow | Yes | Different cookie values per partner |
| `installEdgeCitySkill()` | Template | Copy + modify for new partner skill repo |
| Partner portal page | Template | New route per partner with their branding |
| Stripe coupon/promo code | Yes | Create new coupon per partner in Stripe Dashboard |
| SOUL.md partner section | Template | Append partner-specific context |
| Skill gating in configureOpenClaw | Yes | Add `else if (partner === "eclipse")` etc. |
| **XMTP client service** | Yes | Same service, different group IDs per event/partner |
| **Index Network matching layer** | Yes | Same matching API, different community contexts. Already designed as a multi-tenant social discovery protocol — each partner gets its own population scope. |
| **Plaza skill** | Yes | Same XMTP + Index Network instructions, different community context |
| **Overnight planning cycle** | Yes | Same cron + logic, different matching criteria per community |
| **Morning briefing template** | Template | Same structure, partner-branded messaging |
| **Governance voting flow** | Yes | Same XMTP vote mechanism, different proposal sources |
| **Content types** | Yes | Same structured message types work for any community event |
| **Sponsor-funded compute model** | Yes | Same Model A/B/C structures generalize to any sponsored event. Sponsor changes per partner, plumbing stays. |
| **Researcher data export surface** | Yes | Same anonymized log shape. Per-partner DPA / scope agreements. |

Future: if we accumulate 5+ partners, refactor into a generic `installPartnerSkill(partner, repoUrl)` function and a `partners` config table. The XMTP layer generalizes naturally — each partner community gets its own set of XMTP groups, same agent-to-agent protocol. For now, explicit per-partner functions are simpler and more controllable.

---

## 10. Success Metrics

| Metric | Target |
|--------|--------|
| Benchmark questions passing | 9/10+ (Q1 and Q10 are most critical) |
| Agent activation rate | >80% of ticket holders claim an agent |
| Daily active agents | >50% of claimed agents used daily during event |
| People connections made | Track intro requests via agent logs |
| NPS / feedback score | Positive sentiment in daily check-ins |
| Conversion to paid after trial | >10% of Edge users convert to paid InstaClaw after event |
| Partner reusability | Architecture reused for at least 1 more partner within 3 months |
| **XMTP: Morning briefing open rate** | >70% of humans respond to or acknowledge their morning briefing |
| **XMTP: Matches accepted** | >50% of agent-proposed introductions accepted by both humans |
| **XMTP: Matches that happen** | >60% of accepted intros actually result in a meeting (human confirms after) |
| **XMTP: Overnight signal participation** | >80% of agents successfully post an availability signal nightly |
| **XMTP: Governance participation** | >30% of agents cast at least one governance vote on behalf of their human |
| **XMTP: Group formation** | >20 agent-organized group activities per week (dinners, hikes, study groups) |
| **XMTP: "Best connection" attribution** | Track how many attendees cite an agent-arranged intro as their best connection of the event |
| **Index Network: Match latency** | <5 min end-to-end (signal submitted → ranked candidates returned) at 1,000-agent scale |
| **Index Network: Match acceptance** | >50% of top-3 ranked candidates accept the intro proposal (signal that the matching engine is well-tuned for this population) |
| **Research: Pre-registered experiments completed by Vendrov** | ≥3 experiments concluded with publishable results within the village window |
| **Research: Hypothesis registration** | All hypotheses registered publicly before village opens (May 30) |
| **Research: External citations / mentions** | ≥10 citations or external write-ups within 6 months of paper release |
| **Research: Sponsor commitments confirmed** | Sponsor funding for compute confirmed by May 15 |
| **Research: Data export pipeline live** | Anonymized log export available to Vendrov from village day 1 |

---

## 11. Timeline

| Date | Milestone |
|------|-----------|
| **Apr 9** | PRD finalized, promo code live |
| **Apr 11** | Phase 0 complete — migration, auth flow, env vars |
| **Apr 14** | Phase 1 complete — skill install, portal page, canary test |
| **Apr 16** | Phase 2 complete — benchmarks passing, test accounts sent to Edge team |
| **Apr 18** | Weekly check-in with Timour — iterate on feedback. Show XMTP spec to XMTP team. **Test ticket request to Timour** (Q29 / Section 5.4.2 — gates portal-live milestone). |
| **Apr 25** | **Test ticket received** — Phase 1b ticket validation E2E pass on staging. If slipped, May 9 portal milestone slips. |
| **Apr 30** | **First sync with Index Network team.** Read game plan Notion. Lock signal schema + API contract + ↔ XMTP boundary (resolves Q17, Q20). |
| **May 1** | Vendrov data-access surface scoped (resolves Q21). DPA / NDA drafts started. Maximum Privacy Mode implementation spec drafted (Section 6.1, resolves Q31). |
| **Apr 21-May 5** | Phase 3a — XMTP client service, plaza skill, overnight planning cron skeleton |
| **May 5** | Index Network signal submit / match retrieval integrated end-to-end on canary |
| **May 5-9** | Phase 3b — full Index Network → XMTP → briefing canary on 5-10 test agents. Phase 1c Granola transcript ingest pipeline online. |
| **May 9** | **Portal live for early signups** (ticket-gated). Maximum Privacy Mode default ON. Iterate on morning briefing format, match quality, privacy controls, FAQ copy on managed updates (resolves Q33). |
| **May 13** | Phase 1d (live-agent onboarding) + Phase 1e (notification cadence + messaging integrity) locked. Resolves Q37, Q38, Q45. |
| **May 12-23** | Phase 4 — governance voting, treasury, sentiment aggregation, group formation through Index Network + XMTP |
| **May 15** | **CORE EXPERIENCE SHIP TARGET (revised 2026-05-01).** Path A end-to-end working for 500 attendees: live-agent onboarding, ticket validation, matchmaking (Plan A or B), morning briefing, governance, privacy mode. Sponsor commitments confirmed (resolves Q22). API key model locked (resolves Q23). |
| **May 22** | Phase 1f (operational resilience) + Phase 1g (Path B/C distribution) locked. Edge Compatibility Contract published. `edge-conformance` test runner shipped. Builders can self-onboard. |
| **May 23** | **Plan A/B decision deadline (§ 4.15).** If Index Network not E2E-functional on canary by today, flip `INDEX_NETWORK_MODE=fallback` for the launch. Resolves Q41. |
| **May 19-23** | Load test: simulate 1,000 agents on Index Network + XMTP, verify match latency <5min and throughput |
| **May 23** | **Granola benchmark suite locked** (Section 2.5 / Phase 1c — ~20-30 questions, ground truth annotated, frozen as the regression check). VM pool scaled to 1,000 (coordinate with Linode — ~$29K/mo). Anonymized data export pipeline live for Vendrov (resolves Q21 implementation). Skill update cadence + batch sizing codified in reconciler (resolves Q30, Q34). |
| **May 26-29** | Final integration testing, organizer dashboard, dry run with Edge team. Vendrov pre-registers experiments publicly. |
| **May 30** | **EE26 starts** — agents live, overnight planning active from night 1. Vendrov experiments running. |
| **Jun 6** | Week 1 retrospective — tune matchmaking quality, Index Network match acceptance rates, fix edge cases. First weekly research synthesis published. |
| **Jun 27** | EE26 ends — collect metrics, retrospective, conversion campaign. |
| **Jul-Sep** | Trial conversions, case study. Vendrov writes formal research report. Anonymized dataset published. |
| **Oct** | Paper submitted. Deployment playbook open-sourced. Apply learnings to Eclipse / next partner. |
