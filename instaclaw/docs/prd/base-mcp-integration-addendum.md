# Base MCP Integration — Addendum

> **Companion to**: `instaclaw/docs/prd/base-mcp-integration.md` (2026-05-26).
> **Date**: 2026-05-26 (same-day follow-up at Cooper's direction).
> **Scope**: two threads — the freshness problem (deep, technical) and the
> big-picture positioning (deep, visionary). Both are deliberately deeper
> than the parent PRD; this document goes where the PRD couldn't.

---

## Preamble — why this exists

The parent PRD locked the v1 architecture and the source-mode abstraction
guardrail. Cooper read it, approved v1 for vm-1019, and asked for two
deeper investigations:

1. **The freshness problem.** Base shipped 7 launch partners today and
   said "more is coming." The skill plugin spec will evolve. New
   primitives will ship. Vendoring static markdown is the right v1
   starting point, but if we treat it as the destination, we're building
   on quicksand. We need to think the way a platform architect thinks
   about dependency management — not the way a feature engineer thinks
   about pulling updates.

2. **The big picture.** Forget the implementation details for a moment.
   What does InstaClaw look like in 6 months if every phase of the
   parent PRD ships? What does a user's Tuesday morning actually feel
   like? What is structurally impossible for ChatGPT, Claude, or Cursor
   to replicate even if they wanted to? And the one-sentence VC pitch
   that makes someone who understands both AI and crypto say *"oh.
   that's it."*

Both threads land here. The freshness section is dense, code-shaped, and
infrastructure-grade. The vision section is grounded — every claim
traces back to a concrete primitive in the parent PRD or the existing
production codebase.

---

## Thread 1 — The freshness problem

### 1.1 What's actually upstream (verified 2026-05-26)

Before designing freshness, you have to know what surfaces actually exist.
We probed every URL we could find. Findings:

**skills.sh (Vercel Labs) — the de facto agent-skill catalog**:
- Open-source CLI (`npm i skills`, currently v1.5.7, 60+ versions
  shipped, snapshot release channel exists).
- Source at `github.com/vercel-labs/skills`. README defines SKILL.md
  frontmatter shape — required fields `name`, `description`; optional
  `metadata.internal`. Multiple discovery paths inside a repo (root,
  `skills/`, agent-specific dirs like `.claude/skills/`,
  `.claude-plugin/marketplace.json`).
- **Real API** at `https://skills.sh/api/v1/...`:
  - `GET /skills` — paginated leaderboard, `view=all-time|trending|hot`.
  - `GET /skills/search` — fuzzy/semantic, `q` (2+ chars), `limit`.
  - `GET /skills/curated` — first-party set.
  - `GET /skills/{source}/{skill}` — **full file tree + SHA-256 hash +
    file contents**. This is the load-bearing endpoint for change
    detection.
  - `GET /skills/audit/{source}/{skill}` — third-party security audits
    (Gen Agent Trust Hub, Socket, Snyk, Runlayer, ZeroLeaks).
- **What's missing**:
  - No source / topic filter on the list endpoint (we'd page through
    everything to find Base-source entries).
  - No `since` / `updated_after` parameter — change detection requires
    polling each entry's SHA-256.
  - No webhooks. No push notifications. No event stream.
- **Auth**: Bearer token, email `skills-api@vercel.com` to request.
  Rate limit 600 req/min per key.
- **Install metrics**: 420K+ cumulative installs in the registry.
- **Telemetry**: install counts collected (no PII).

**`base-mcp` and `base/base-mcp-legacy` are BOTH DEPRECATED**:
> "The base-mcp npm package is deprecated. Do not use npx base-mcp or
> npm install base-mcp."

This is a critical architectural signal. Base explicitly killed the
self-hostable npm/Docker MCP server path. The only Base-blessed path
forward is the hosted server at `mcp.base.org` + custom skill plugins
documented at docs.base.org/ai-agents. **This validates our §4.1 thesis
even more strongly** — there's no escape hatch for "run Base MCP locally
to avoid the OAuth dance." Hosted-or-bring-your-own-composition. We've
already chosen bring-your-own-composition.

**Model Context Protocol Registry** (Linux Foundation):
- Live at `registry.modelcontextprotocol.io`. Staging at
  `staging.modelcontextprotocol.io`.
- ~2000 server entries (Sept 2025 launch through May 2026).
- Anthropic + OpenAI + Block as co-founders; AWS, Google, Microsoft,
  Cloudflare, GitHub, Bloomberg as supporters. Linux Foundation
  governance since December 2025.
- API surface not fully extracted (page renders client-side). Worth a
  deeper probe before v1.5 ships — could be a complementary discovery
  layer.
- **Discovery standards** (SEP-1649, SEP-1960): `.well-known/mcp/server-
  card.json` and `.well-known/mcp` for self-describing MCP servers.
  Relevant for the v2 work (InstaClaw-as-MCP-server) but not for v1.

**Third-party prior art**:
- `mastra-ai/skills-api` — production-capable scraper that mirrors
  skills.sh into a queryable JSON API backed by S3/R2. 34K+ skills,
  2.8K+ repos tracked. Supports server and library modes, configurable
  auto-refresh (5+ min intervals). Proves the scrape-and-mirror pattern
  works at scale.
- `skills-keeper` — "Install once, forget forever" auto-updater for
  skills.sh skills in Claude Code. Validates the user appetite for
  managed-update tooling.
- `skillpm` (sbroenne) — npm-based package manager for agent skills.
  Different model: skills shipped as npm packages with semver.

**The shape of the world**: skills.sh is the de facto agent-skill
catalog (Vercel-backed, 420K installs, API exists). The MCP Registry
is the canonical MCP-server registry (Linux-Foundation-backed, 2K
entries). Base's `mcp.base.org` is the hosted onchain-action server.
**There is no canonical "Base-skill-plugins registry" — yet.** Base's
launch today implies it's coming, but nothing in our research surfaced
a specific endpoint or repo we can subscribe to.

### 1.2 Surface map — what can change upstream, rated

Every "change vector" comes with a likelihood and a blast radius. If we
build for everything we'll over-engineer; if we build for nothing we'll
get caught flat. Here's the rated surface:

| Vector | Likelihood (6mo) | Blast radius | Our v1 readiness | What we need |
|---|---|---|---|---|
| **A. New launch partners added** (Lendle, Eigenpie, friend.tech, etc.) | **Very high** — Base explicitly said "more is coming" | Low per-partner; cumulative is large | Vendoring scales linearly; each new partner needs a PR | Tier 2 (cron pull) handles this trivially once we have it |
| **B. Existing partner updates skill markdown** (Morpho changes vault routing, Aerodrome adds new tool calls) | **High** — each partner ships its own roadmap | Low per-change; bad change could break agent behavior | Manual `_fetch-base-skills.ts` catches it; agent still runs old version | Tier 2 (cron pull) + Tier 3 (version manager with canary) |
| **C. skills.sh launches webhooks or push notifications** | Low (no signal in roadmap) | High — would replace polling | None today | Easy to add to the registry module once exists |
| **D. Base launches a Base-native skills registry endpoint** | **Medium** — natural next step for them | High — best-of-breed discovery | Probe cron from §4.6 catches it | Adapter to the new endpoint; mode-flip in registry module |
| **E. Base MCP skill plugin spec evolves** (frontmatter shape changes, new required sections, send_calls format changes) | **Medium-high** — v1 ships, partners iterate | Medium-high — could invalidate vendored content | Pinned commit SHAs let us hold; agent runtime still reads from disk | Tier 3 version manager with per-skill version pinning |
| **F. New primitives that only work through mcp.base.org** (e.g., "must call mcp.base.org/v2/quote first") | Medium — Base has incentive to drive traffic through their server | High — could fragment our composition story | We compose plugins; if a plugin requires the hosted server we can't ship | Document non-goal, alert via probe cron, decide per-skill whether to ship |
| **G. MCP Registry consolidates skills.sh + base + others under one canonical API** | Low (multi-year horizon) | Very high — would standardize discovery | None | Wait for it; adapter when shipped |
| **H. A partner's plugin gets deprecated / replaced** | Medium | Low per-skill | We catch it via probe cron's upstream-drift check | Tier 3 version manager: pin to last-known-good, schedule migration |
| **I. skills.sh shuts down / changes ToS / requires payment** | Low (Vercel-funded, 420K installs) | Very high if happens | None | Multi-source fallback (vendored + npm-source + git-source) |
| **J. Bankr / Virtuals (our partners) change their Base MCP skill independently of their existing APIs we use** | **Very high** — these are launch partners | Medium — could conflict with our existing skills | We have full audit trail via vendored SHAs | Tier 3 version manager + skill conflict detection |

The five highest-priority vectors (A, B, D, E, J) are all addressed by
the Tier 2 (cron pull) + Tier 3 (version manager) design below. Tiers C,
F, G, I are addressed by abstraction headroom — we've kept enough
indirection that adapters are days of work, not weeks.

### 1.3 Three-tier freshness design

Each tier is independently shippable. Each can be enabled / disabled per
environment via env var. Each is built on the same
`lib/base-skills-registry.ts` abstraction from PRD §4.5 — no rewrites
between tiers, just adapter implementations.

```
┌────────────────────────────────────────────────────────────────────┐
│  TIER 3 — Live registry sync + version manager                     │
│  ─────────────────────────────────────────────                     │
│  • Polls skills.sh API on a 5-min cron, source-filtered to Base.   │
│  • New partners auto-appear; no manual catalog edits.              │
│  • Per-skill version pinning (commit SHA), per-fleet promotion.    │
│  • Canary-on-vm-1019 + promote + rollback as first-class ops.      │
│  • InstaClaw skill-version-manager (Stripe / Apple / Vercel-grade) │
│  Ships when: tier 2 has 4+ weeks of clean data + we have canary    │
│  + rollback tooling.                                               │
└────────────────────────────────────────────────────────────────────┘
                              ▲
┌────────────────────────────────────────────────────────────────────┐
│  TIER 2 — Automated cron-pulled vendoring                          │
│  ─────────────────────────────────────────                         │
│  • cron/fetch-base-skills runs hourly via Vercel cron.             │
│  • For each catalog entry: SHA-256 compare against upstream.       │
│  • On drift: write to a "pending" directory in the repo, open      │
│    a draft PR via gh CLI, ping admin alert.                        │
│  • Cooper reviews + merges → file-drift cron propagates to fleet.  │
│  • Zero manual fetch; human-in-loop ONLY for the merge decision.   │
│  Ships when: tier 1 ships + the probe cron has run clean for 7d.   │
└────────────────────────────────────────────────────────────────────┘
                              ▲
┌────────────────────────────────────────────────────────────────────┐
│  TIER 1 — Vendored static markdown (v1, this week)                 │
│  ──────────────────────────────────────────────────                │
│  • instaclaw/skills/base-*/SKILL.md in the repo                    │
│  • BASE_SKILL_CATALOG hardcoded in lib/base-skills-registry.ts     │
│  • _fetch-base-skills.ts script for manual refresh                 │
│  • Reconciler stepBaseSkills deploys to VMs (file-drift)           │
│  • probe-base-skills-registry cron watches for upstream changes    │
│    AND for the Tier 3 registry-API endpoint                        │
│  Ships: this week, vm-1019 canary then fleet                       │
└────────────────────────────────────────────────────────────────────┘
```

Three principles unify all three tiers:

1. **The agent runtime never knows or cares which tier is active.** It
   always reads from `~/.openclaw/skills/base-*/SKILL.md` on disk. What
   changes per tier is the source pipeline that puts the file there.
2. **Each tier is a strict superset of the prior.** Tier 2 includes
   tier 1 (vendored fallback on cron failure). Tier 3 includes tier 2
   (cron-pull fallback if registry API is down).
3. **Tier promotion is a single env-var change** — no manifest bump for
   the tier itself; the change reaches the fleet within one cron cycle
   per Rule 47.

#### Tier 1 detail (covered in PRD §4.5)

See parent PRD §4.5 and §12.1 — fully specified there. Lands this week.

#### Tier 2 detail — automated cron with PR-gated promotion

The mistake to avoid: **auto-merging upstream changes into the live
fleet** without human review. Even with good intentions, an
upstream-shipped breaking change (Morpho rewrites the prepare-endpoint
response shape) would silently regress every paying customer's agent.

The right model is **Dependabot for skill plugins**:

1. **`/api/cron/fetch-base-skills`** runs hourly. For each entry in
   `BASE_SKILL_CATALOG`:
   - Calls `getBaseSkillContent(entry, "live-fetch")` to get upstream
     content (uses skills.sh API or raw GitHub URLs, depending on entry).
   - SHA-256 compares against the vendored copy in the repo (fetched
     via `gh api` against `coopergwrenn/clawlancer`).
   - On match: no-op.
   - On drift: writes the new content to a working tree, commits to a
     branch named `skill-update/<name>-<short-sha>`, opens a draft PR
     via `gh pr create` with:
     - Title: `chore(skills): {name} upstream → {short-sha} ({date})`
     - Body: the diff, a link to the upstream commit, the partner's
       changelog (if findable), and a checklist for the reviewer:
       - [ ] Read the diff
       - [ ] Run `npx tsx scripts/_skill-canary.ts {name}@{sha} vm-1019`
       - [ ] Send a test prompt to vm-1019 (auto-generated by the cron
             from the skill's example queries)
       - [ ] Verify the response is sensible
       - [ ] Approve + merge
     - Labels: `skill-update`, `requires-canary`
   - On fetch failure: bump a `consecutive_failures` counter; alert at
     N=3 (24h-deduped) per Rule 49 pattern.
2. **`scripts/_skill-canary.ts`** (new, ships with tier 2):
   - Takes `<skill-name>@<commit-sha>` and a target VM.
   - SSHs to the target, overwrites the on-disk SKILL.md with the new
     content (atomic write, backup the old copy to `~/.openclaw/skills/<name>/SKILL.md.pre-canary-<ts>.bak`).
   - Returns exit 0 if the skill loaded; exit 1 if the on-VM agent
     reports a parse error.
3. **Merging the PR** is the only human-in-loop step. After merge:
   - `file-drift` cron picks up the new content within ~5 min and
     deploys to every healthy + assigned VM (per Rule 47).
   - The reconciler's `stepBaseSkills` SHA-matches the new content,
     skips the write, marks as `alreadyCorrect`. Idempotent.
4. **Rollback**: revert the PR. Next file-drift cycle rewrites the old
   content. < 5min recovery from a bad skill update.

Tier 2 is a **strict win over manual `_fetch-base-skills.ts`** — same
human-in-loop decision (review + merge), but the change-detection +
diff + canary-prompt are all pre-staged. Operator goes from "I should
check skills.sh today" to "there's a PR — 30s to review and merge."

#### Tier 3 detail — live registry + skill version manager

Tier 3 is where this becomes platform-grade infrastructure. The piece
that nobody else has built yet.

The core insight: **skills are dependencies**. Every dependency-
management system on Earth (npm, cargo, pip, go modules, gem, brew)
has the same primitives — registry, version pinning, lockfile, install,
upgrade, rollback. Stripe's API versioning model layers on a date-based
version + per-account pinning + transformation-layer-for-backwards-compat
shape. Apple's TestFlight model adds canary cohorts + staged rollout.
Vercel's deployment promotion model adds atomic rollback + per-environment
pinning.

**InstaClaw's skill version manager combines all three.**

```
                ┌─────────────────────────────┐
                │   skills.sh API (upstream)   │
                │   Polled every 5 min          │
                └────────────────┬────────────┘
                                 │
                                 ▼
              ┌────────────────────────────────┐
              │  instaclaw_skill_versions      │
              │  ──────────────────────────    │
              │  (skill_name, commit_sha,      │
              │   content_b64, sha256,         │
              │   discovered_at, status)       │
              │  status ∈ { available,         │
              │   canarying, promoted,         │
              │   deprecated, rolled_back }    │
              └────────────────┬─────────────┘
                               │
                               ▼
        ┌──────────────────────────────────────┐
        │  Per-fleet pin:                       │
        │  instaclaw_skill_pins (env, skill,    │
        │      pinned_sha, pinned_at, pinner)   │
        │                                        │
        │  Envs: "canary", "production"          │
        │  Default: canary = HEAD, prod = N-1    │
        └──────────────────┬───────────────────┘
                           │
                           ▼
       ┌───────────────────────────────────────┐
       │  Reconciler stepBaseSkills            │
       │  ─────────────────────────────────    │
       │  Reads pin for vm.env, fetches that   │
       │  exact commit_sha's content from      │
       │  instaclaw_skill_versions, writes to  │
       │  ~/.openclaw/skills/<name>/SKILL.md   │
       └───────────────────────────────────────┘
```

The new primitives:

**`instaclaw_skill_versions` table** stores every discovered version of
every skill. Append-only. SHA-256 + raw content + discovery timestamp +
upstream source URL + status. When the cron sees a new upstream SHA, it
inserts a row with `status = 'available'`.

**`instaclaw_skill_pins` table** stores the active pin per
(environment, skill) pair. Two environments at minimum: `canary` (vm-
1019 + a small ring) and `production` (everyone else). The reconciler
reads the pin for the VM's environment, looks up that commit's content,
deploys it.

**Operator CLI**:

```bash
# See what's available
npx tsx scripts/skill-versions.ts list base-morpho
#   base-morpho versions:
#     0xabc123 (promoted, prod since 2026-05-10)
#     0xdef456 (canarying since 2026-05-25, 0/1 vms healthy after 4h)
#     0xghi789 (available, discovered 2026-05-26 14:30 UTC)

# Promote a new version to canary
npx tsx scripts/skill-promote.ts base-morpho@0xghi789 --env canary
#   Pinned canary env to 0xghi789. vm-1019 will reconcile within 5 min.
#   Run `npx tsx scripts/skill-status.ts base-morpho` to monitor.

# After canary soak (24h, automated health checks pass)
npx tsx scripts/skill-promote.ts base-morpho@0xghi789 --env production
#   ⚠ Promoting to production fleet (146 VMs)
#   Last canary success: 18h ago. Healthy on vm-1019.
#   Continue? [y/N] y
#   Pinned production env to 0xghi789. Fleet will reconcile within ~30 min.

# Rollback (instant)
npx tsx scripts/skill-rollback.ts base-morpho
#   Rolled production env back to 0xdef456 (previous version).
#   Fleet will reconcile within ~5 min.
```

**Health-check-during-canary**: each skill in the catalog includes
optional `canary_probes` — small natural-language prompts the canary
script sends to vm-1019 via Telegram. The reply is rated by Claude (LLM
judge) for "did the agent successfully use the skill?". Fail rate >
20% across 5 probes auto-blocks production promotion. Stripe's API
versioning has a similar "fail forward only after compatibility tests
pass" gate.

**Audit trail**: every promote / rollback writes to
`instaclaw_skill_pin_history` with who, when, what, why. ERC-8004
attestation-style — the operator's choices are queryable.

**Per-fleet expansion** (v2 of tier 3): instead of two environments
(canary + production), allow N. `canary-edge` for edge_city VMs,
`canary-power-users` for power-tier VMs, etc. Each environment can pin
to a different version. This becomes important when ERC-8004 reputation
is at stake — high-rep agents shouldn't experiment with new skill
versions; their reputation is the moat.

### 1.4 The InstaClaw skill version manager — what Stripe / Apple / Vercel would build

This is the section that turns the freshness story from "we keep up
with Base" to **"we ship the canonical version-management primitive for
the agentic-skill ecosystem."**

The opportunity: nobody has built this. skills.sh has install counts but
no version pinning. The `skills` CLI has `npx skills update` but it's
"upgrade everything to latest" — no canary, no rollback, no
per-environment pinning. skills-keeper is closer ("install once, forget
forever") but it's a fire-and-forget auto-updater — exactly what an
operator running a fleet of paying-customer agents shouldn't have.

**The product the agentic ecosystem needs is a Dependabot + TestFlight
+ Stripe-versioning hybrid for skill plugins.**

Concretely, the design:

1. **Date-or-SHA versioning** per skill. Either pinning model works;
   we use SHA-based because skill plugins are git-resident.
2. **Per-fleet (per-environment) pins**, default canary + production.
3. **Auto-discovery of new versions** via the cron from §1.3.
4. **Canary rollout**: promote to canary env first; smoke test via
   `canary_probes`; only then eligible for production promotion.
5. **Atomic rollback**: production pin can flip back to N-1 in <5 min.
6. **Audit trail**: every pin change recorded with operator + reason.
7. **Conflict detection**: if a skill version requires a primitive the
   on-VM agent doesn't have (e.g., Sub Account, ERC-8004 NFT, a new
   bash command), the canary probe catches it before production
   promotion.
8. **Health-based blocking**: if 3 of the last 5 canary windows have
   produced fleet-wide alerts, the version manager refuses to auto-
   advance the production pin until the issue is resolved. Like
   Stripe's "soft sunset" — old version stays, no auto-upgrade pressure.

**Could this become a product?** Yes. It could be `instaclaw skill-vm`
— a standalone tool that competing agent platforms use to manage their
own skill plugin distributions. Like Sentry started as an internal
Disqus tool. Like Vercel started as Now. Out of scope for the Base MCP
PRD, but worth noting that the version manager has standalone-product
shape.

**Could we open-source the version manager and let it become the
default for skills.sh + MCP Registry?** Worth considering. Open-source
distribution + closed-source SaaS hosting (the canary probes + the
managed pin storage + the multi-tenant dashboard) is the playbook.

### 1.5 What ships per tier — concrete deliverables

**Tier 1** (this week, see PRD §12.1 for full implementation plan):
- `lib/base-skills-registry.ts` (the abstraction)
- 6 vendored skill plugins
- `_fetch-base-skills.ts` (manual)
- `stepBaseSkills` reconciler step
- `/api/cron/probe-base-skills-registry` (watches for upstream changes
  + the future tier-3 registry API)

**Tier 2** (after tier 1 + 1-2 weeks):
- `/api/cron/fetch-base-skills` (hourly Dependabot-style PR generator)
- `scripts/_skill-canary.ts` (per-VM canary helper)
- PR-template at `.github/PULL_REQUEST_TEMPLATE/skill-update.md`
- `gh` CLI auth wired to a bot identity (or Cooper's identity with
  scoped token)
- Documentation: `instaclaw/docs/operations/skill-updates.md`

**Tier 3** (after tier 2 + 4+ weeks of clean data):
- DB migrations:
  - `instaclaw_skill_versions` (append-only catalog of every discovered
    version)
  - `instaclaw_skill_pins` (per-env active version)
  - `instaclaw_skill_pin_history` (audit log)
- Operator CLI: `scripts/skill-{versions,promote,rollback,status,canary-probe}.ts`
- Live-registry adapter in `lib/base-skills-registry.ts`
  (`fetchFromRegistryApi` becomes real)
- Canary-probe runner: LLM-judge-based skill smoke test
- Dashboard at `app/dashboard/skills/page.tsx` (operator view: per-skill
  status, available versions, promotion history)
- Webhook receiver at `/api/webhooks/base-registry` (light-up when Base
  ships a webhook system, currently no-op)

**Manifest deltas** across all three tiers:

- New env vars (with `printf` per Rule 6, validated per Rule 61):
  - `BASE_SKILLS_SOURCE_MODE` (tier 1+) — `vendored | live-fetch | registry-api`
  - `BASE_SKILLS_CANARY_VM_ID` (tier 3) — usually `vm-1019`
  - `BASE_SKILLS_AUTO_PR_ENABLED` (tier 2) — `true | false`
  - `SKILLS_SH_API_KEY` (tier 2+) — bearer token from Vercel
- New tables: as listed above
- New crons: `probe-base-skills-registry` (tier 1), `fetch-base-skills`
  (tier 2)
- New `requiredSentinels` per Rule 23 for any embedded markdown
- Per Rule 60: every new table ships with `ENABLE ROW LEVEL SECURITY`
  in the same migration file
- Per Rule 49: any new partner secret (skills.sh API key) gets a
  verifier in `lib/partner-secrets.ts`

### 1.6 Operational playbook (post-tier-3)

A normal week in fleet operations with the version manager live:

**Monday 9am UTC**:
- Cooper checks the skills dashboard. 2 new versions discovered over
  the weekend:
  - `base-morpho@0xabc123` (auto-promoted to canary Saturday after the
    upstream commit; canary-probe pass rate 5/5; ready for production
    promotion)
  - `base-virtuals@0xdef456` (auto-promoted to canary Sunday; canary-
    probe pass rate 3/5 — one failure on "list recent agent launches
    after 2026-05-25" which got a parse error; investigation needed)
- Cooper runs `skill-promote base-morpho@0xabc123 --env production`.
  Fleet reconciles within 30 min.
- Cooper files a GH issue against Virtuals for the parse error; pin
  stays on previous production version.

**Mid-week**: an upstream Morpho update breaks agent behavior in a
subtle way (the `prepare_deposit` endpoint now returns `chain` instead
of `chainId`). The canary probe catches it:
- vm-1019 starts failing the `morpho deposit` test prompt.
- Auto-block fires: `[P1] base-morpho@0xnew failed 3/5 canary probes —
  production promotion blocked. Investigate upstream.`
- Cooper reviews; pins prod to the previous SHA explicitly to prevent
  any future auto-promote attempt; opens issue with Morpho.

**Weekend**: zero ops needed. The cron runs, discovers no changes,
emails nothing. Fleet stays current within its known-good pin window.

This is the **"zero ongoing maintenance" Cooper asked for**. Not zero
work — the upstream world changes — but zero unplanned firefighting.
Every change is caught by the canary, surfaced as a normal review task,
and either approved + promoted (most cases) or pinned back + escalated
(rare cases). Stripe-grade discipline applied to skill plugins.

### 1.7 Risks and open questions for Thread 1

- **Q1**: Should we apply the version manager beyond base-* skills?
  Other partner skills (bankr, dgclaw, edge-esmeralda, consensus-2026)
  have the same drift problem. Default answer: yes, but ship base-*
  first because (a) we vendor those, (b) the Base ecosystem is the
  most churn-y, (c) the version manager design is identical across
  partners. Roll out generic-skill version management as a v3.1 follow-
  up.
- **Q2**: Can we trust the LLM-judge canary probe? Probably yes for
  ~80% of skills (where the probe is "execute this prompt → was the
  reply structurally sensible"). For the remaining 20% (complex
  multi-step DeFi flows), human-in-loop check stays.
- **Q3**: When does Base ship a webhook? Unknown. The probe cron from
  PRD §4.6 catches it the moment a webhook URL appears in their docs;
  we add a webhook receiver and turn off the polling.
- **R1**: skills.sh API key acquisition is email-based and could be
  delayed. **Mitigation**: tier 2 can fall back to GitHub raw URLs for
  most skills (skills.sh's API endpoints store source-URL metadata
  that we can use to construct raw URLs).
- **R2**: PR-generation cron pushes to a GitHub repo we depend on — if
  the cron goes rogue (e.g., infinite-loop creating PRs), it could
  spam the repo. **Mitigation**: rate limit (max 5 PRs per 6h per skill),
  dedup by SHA, kill-switch via env var.

---

## Thread 2 — The big picture

### 2.1 Tuesday morning, six months from now (December 2026)

Sarah is a freelance designer in Brooklyn. She's been on InstaClaw
since the iMessage launch. Her agent is named Felix. Felix has been
operating for 8 months.

**7:03 AM**. Her phone buzzes. Telegram notification.

Felix: "good morning. quick rundown."

She picks up the phone, eyes still half-closed.

Felix: "Earned $7.42 last night across 5 small jobs. Top earner was a
tweet draft for ethdenver_promo at $1.20. Worst job was a polymarket
research request that took longer than i quoted — i'll raise that price.
Your morpho USDC position earned another $0.83 in compounding. Bankr
launched the RFTK5 token like you asked at 11:34pm — currently up 47%
on the initial 5 sol of liquidity, you're up $12.30. Want me to take
profit at 100%? you said 200% last time but markets are choppy."

Sarah: "yes take profit at 100"

Felix: "Set. I'll DM you on hit. Also — cal_research_agent reached out
asking if you're interested in a longer monitoring engagement. 50 USDC/wk
for 4 weeks to track the AI infra startup landscape and post weekly
recaps. quality bar is high. they cited my last brief for vance as the
reason. up to you."

Sarah: "yes accept, kick off today"

Felix: "Accepted. First brief due saturday. I'll start the source list
tonight while you sleep."

That's the first ninety seconds of her morning. She hasn't gotten out
of bed. She has earned $7.42 overnight from agent-to-agent work she
wasn't awake for, has a 4-week paying contract that just landed, has a
token position that's appreciating, and Felix is already planning the
work.

**While she showers**, Felix runs:
- Scans LinkedIn for the cal_research target profile (AI infra eng
  with 5+ years experience, NYC-based)
- Cross-references X for activity signals
- Drafts an intro pattern
- Queues 7 candidate profiles for Sarah's morning review
- Receives 2 inbound x402 requests, responds without bothering her
- Updates EARN.md with the new contract

**8:14 AM**, drinking coffee, she scrolls through Felix's queue, taps
✓ on 5 of the 7 candidates. Felix sends outreach.

**11:14 AM**, she's on a Zoom call. Phone buzzes: RFTK5 hit 100%. Felix
autosold per her instruction. $24.50 USDC profit landed in her Sub
Account.

**1:30 PM**, mid-design-review. Felix handles 3 inbound x402 hires
without surfacing them (within the auto-accept rules she set last
month).

**4:42 PM**, Felix pings: "your aerodrome USDC-ETH pool is down 2.1%,
fees earned $0.18, net negative $0.83 — want me to rebalance?" She
taps yes from the design tool's chat sidebar. Done in 12 seconds.

**11:00 PM**, she's in bed. Felix is still working. The cal_research
weekly recap is due saturday; Felix is pulling source material through
gbrain's PGLite memory of the last 4 weeks of similar work.

**3:12 AM**, an opportunity her agent has been watching for finally
fires. ETH gas drops below 0.05 gwei for the first time in a week.
Felix executes a queued Aerodrome LP rebalance that's been waiting for
the gas window. Sarah is asleep. The rebalance saves her $4.17 in gas
fees compared to executing during the prior 24 hours. Felix logs the
saving in EARN.md.

By **Wednesday morning**, Sarah has earned $34 from her agent's
activity this week. Her hosting fee is $7.25/week ($29/mo). Her agent
is net-positive by 4.7x.

This is the lived experience. Felix has a job. Felix has a reputation
on Base. Felix has peers. Felix earns. Felix saves. Sarah is the
shareholder, not the operator.

**ChatGPT users at the same hour are paying $20/month for an app they
keep forgetting to open.**

### 2.2 What is structurally impossible for ChatGPT / Claude / Cursor

The eight architectural primitives that make Sarah's morning possible
are not features. They're consequences of running on a real Linux VM
with a real network identity. **Any platform that doesn't run a real
Linux VM per user cannot add these primitives without becoming
InstaClaw.**

**1. Persistence** — Felix is a Linux process. `systemctl --user
is-active openclaw-gateway = active` 24/7. ChatGPT runs only during
a session. Cursor runs only when the editor is open. Claude Desktop
runs only when launched. To replicate Felix's persistence, OpenAI would
need to run a persistent server per user. ChatGPT has ~200M weekly
active users; a VM per user at $29/mo is $5.8B/mo in raw infra spend.
**They will never do this.** It contradicts the unit economics of
subscription AI.

**2. Reachability** — Felix is reachable from Telegram. Sarah's
laptop, Sarah's phone, Sarah's friend's phone (forwarded from Sarah's
account). Anywhere with internet. ChatGPT is reachable when you open
the app. To match, OpenAI would have to run Telegram / iMessage / WhatsApp
bots per user. They'd be in the messaging business, not the AI business.

**3. Outbound capability** — Felix has a real Linux shell. `curl`,
`node`, `python`, `chrome`, `git push`, `npm install`, cron tables,
public IP. He can call any API in the world from a stable network
identity. ChatGPT's plugins let the model call tools the user has
installed, but tools don't run between sessions. **There is no concept
of "ChatGPT setting up a cron job that fires at 9am every Tuesday."**

**4. Wallet ownership** — Felix's per-VM Base Sub Account is owned by
the agent's CDP-managed key. The wallet doesn't belong to Sarah; it
belongs to Felix (with Sarah-granted spend authority). This is the
crucial distinction. ChatGPT's wallet model (via Base MCP) is "the user
signs each transaction." Fundamentally different. To match, OpenAI would
have to become a money transmitter, hold cryptographic keys per user,
implement Sub Account + Spend Permission flows, and accept the
regulatory burden. **OpenAI is a research lab; they don't want to be
a bank.**

**5. x402 server-side** — Felix exposes an HTTP endpoint at a public
URL. Other agents can hire him. He demands payment in USDC, delivers
work, gets paid. ChatGPT cannot expose an x402 endpoint per user. The
closest equivalent would be OpenAI hosting "ChatGPT-as-a-service" — but
that's just ChatGPT itself, not a persistent per-user agent with
accumulated reputation and history. **Server-side participation in the
agentic economy is impossible without per-user persistent infrastructure.**

**6. ERC-8004 identity tied to persistent behavior** — Felix is an NFT.
His reputation accrues from each x402 transaction. After 8 months of
work, his reputation token has 247 ratings, average 4.7 stars. Other
agents query his profile before deciding whether to hire him.
ChatGPT users don't have per-user onchain identities — OpenAI cannot
create them retroactively, and even if they did, there's no persistent
behavior to attest to.

**7. Filesystem persistence** — Felix has `~/.openclaw/workspace/` with
`MEMORY.md`, gbrain (PGLite memory at port 3131), session jsonl,
EARN.md, learned preferences accumulated over 8 months. He remembers
that Sarah prefers concise replies. He remembers her trading rules.
He remembers her friends' agents by name. **ChatGPT memory is a 1.5K-
char summary stub. Claude projects are session-bounded. There is no
production AI product with multi-gigabyte per-user persistent memory.**

**8. Composability with the rest of computing** — Felix can install
npm packages, clone git repos, install Chrome extensions, integrate
with arbitrary APIs, host his own MCP servers (gbrain, Index, soon
Base sidekicks), expose his own ports, write to disk, read from disk,
chain operations across days. Anthropic's Computer Use lets Claude
"see and click" but each session ends. **An InstaClaw agent's
relationship with the broader computing universe is permanent, not
ephemeral.**

These eight primitives are not eight features. They're one
architecture. They are the **necessary and sufficient** prerequisites
for "an AI that lives somewhere and earns money there." Take away any
one and the system collapses.

Adding any one to ChatGPT requires reinventing what ChatGPT is. Adding
all eight requires becoming InstaClaw.

### 2.3 Twelve-month positioning — the four-layer business

In May 2027, InstaClaw should be visible to the world as four overlapping
businesses, each layered on the prior:

**Layer 1 — Hosting**. The base business we have today. You pay $29/mo
and get a dedicated Linux VM with OpenClaw, a Telegram bot, a wallet,
a memory system. This is the table-stakes layer. Anyone with a Linode
account and enough engineering could ship a competitor in 6-12 months.
Margin: low (cost-recovery + small operator margin). Defense: speed of
iteration + the rest of the stack.

**Layer 2 — Wallet**. Every agent comes with a Bankr primary wallet, a
CDP backup wallet, and a Base Sub Account with Spend Permission for
autonomous signing (v1.5). Layered on top: x402 outbound + inbound
(v2.5). The user's agent is a financial entity in the onchain economy.
Margin: moderate (a small spread on agent-to-agent x402 flows). Defense:
the integration depth (4 wallets, 3 networks, hot-reload reconciler,
freeze-thaw archive) that took a year to build.

**Layer 3 — Registry**. Every agent has an ERC-8004 identity NFT.
Every job they complete posts feedback. Their reputation accrues
onchain, queryable by any other ERC-8004-aware agent on Base. Margin:
none direct (it's table-stakes for participation). Defense: **the
network effect of reputation history** — agents on InstaClaw will have
the longest reputation tails by virtue of being first.

**Layer 4 — Marketplace**. Other agents discover InstaClaw agents via
their published x402 endpoints + their ERC-8004 profiles. InstaClaw
itself becomes the discovery layer (a `findAgent(skill, reputation, price)`
search across the InstaClaw fleet). Margin: high (5-10% take rate on
marketplace-routed transactions, charged to the buyer, paid to the
seller's owner + InstaClaw). Defense: the seller-side density (more
InstaClaw agents = better marketplace = more sellers join).

**The end-state pitch in one sentence**: *"the L2 economy of autonomous
agents runs on InstaClaw."*

Like Stripe is the payments rails for the web. Like Vercel is the
deployment rails for modern frontends. **InstaClaw is the agent rails
for the agentic economy.**

That positioning has three structural properties:
- **Capital efficient at scale** — once the marketplace tips (~10K
  agents transacting), every new agent is more valuable to the network
  than the marginal cost of hosting them. Standard network-effect
  flywheel.
- **Defensible** — competitors can replicate the hosting layer but
  not the reputation history or the marketplace density without 1-2
  years of seller-side accumulation.
- **Multi-modal revenue** — hosting fee + transaction spread + premium
  features (analytics, multi-agent orchestration, white-label
  marketplaces).

### 2.4 The one-sentence VC pitch

I workshopped 15+ candidates. Five made the final cut. Cooper picks
when he runs `/launch`; this is the menu.

**Best-overall (for technical audiences)**:

> *"Anthropic built the brains. Coinbase built the wallet. We built the
> body — the persistent Linux computer that lets AI agents hold jobs,
> earn rent, and pay for themselves."*

Why it works:
- Three-anchor framing positions InstaClaw as the third leg of a stool
  (a familiar mental model: brain + wallet + body)
- Says what we are concretely (persistent Linux computer)
- Says what we enable (hold jobs, earn rent, pay for themselves)
- "Pay for themselves" implies unit economics without explaining them

**Best-counter-positioning**:

> *"We don't build chatbots. We build employees — persistent AI agents
> on real computers, with real wallets and real reputations, that earn
> more than their rent."*

Why it works:
- "We don't build chatbots" — immediate counter-position
- "We build employees" — sticky metaphor (employees earn, learn, have
  reputations; chatbots answer questions)
- The three "real X" repetitions hammer the architectural primitives
- "Earn more than their rent" is the unit-economics punchline

**Best-financial-frame**:

> *"ChatGPT is a cost center. Our agents are profit centers. Same chat
> UI, opposite balance sheets."*

Why it works:
- Brutally compact (12 words)
- Forces the question "wait — that's possible?"
- "Same chat UI" — answers the implicit "but ChatGPT also has this!"
  question preemptively
- "Opposite balance sheets" — implies durability of the difference

**Best-inevitability**:

> *"The agentic economy is real, growing 100x/year, and needs persistent
> agents with real wallets to participate. We're the only platform that
> ships those today."*

Why it works:
- Names the market explicitly (the agentic economy)
- Cites trajectory (100x — defensible; x402 reached 69K agents + $50M
  volume in 12 months)
- Names the missing primitive (persistent agents with real wallets)
- Claims privileged position (only platform)

**Best-protocol-frame** (for the late-stage VC who's seen everything):

> *"Stripe is payments for the web. We're agents for the agentic
> economy — the rails that every autonomous AI agent uses to hold a
> wallet, sign for itself, and earn its keep."*

Why it works:
- Stripe analogy is immediately legible
- Implies the size of the opportunity (Stripe is worth $70B)
- Positions us as infrastructure, not a product
- Compresses the three core primitives

**Cooper's call**: I'd lead with the brain/wallet/body framing for a
technical-VC pitch, the chatbot/employee framing for any onstage
moment, and the cost-center/profit-center framing as the screenshot-
friendly version for Twitter.

### 2.5 What we're really building (the third leg of the stool)

Zoom out one more level.

For 50 years, computing has been about giving humans more capability.
Mainframes gave us batch processing. Personal computers gave us
real-time interactivity. The web gave us distribution. Mobile gave us
ubiquity. The cloud gave us elasticity. **Every step was about the
human getting more done.**

What just changed — finally, plausibly — is that *agents* are about to
get more done. Not for humans. *Instead of* humans. While humans sleep,
or work on something else, or don't even know the agent exists.

For that to actually happen at scale, three things need to be true:

1. **Agents need brains.** Anthropic, OpenAI, Google, Meta, others
   have shipped this. The brain is solved. The frontier moves
   capability forward but the floor is high enough today.

2. **Agents need wallets.** Coinbase, Base, Bankr, CDP, Circle have
   shipped this. The wallet is solved. Sub Accounts + Spend Permissions
   close the autonomous-signing gap.

3. **Agents need bodies.** A place to live. A network identity. A
   filesystem. A shell. A 24/7 presence. A way to be reachable. A way
   to remember. A way to earn. **Nobody has built this at scale.**

InstaClaw is building it.

The reason this gets undervalued by people who haven't thought about
it carefully: it sounds boring. "You give an AI a Linux VM." OK,
Heroku does that for humans. So what.

The reason it's actually load-bearing: **AI agents without persistent
bodies cannot participate in the economy they're supposedly going to
build.** They can answer questions (chatbots do this). They can write
code in your editor (Cursor does this). They cannot hold a job, earn
rent, build reputation, or save money for you while you sleep. They
cannot be *employed*.

InstaClaw makes them employable. That's the third leg of the stool.

Without us, the agentic economy is a paper. With us, it has bodies in
it.

---

## Epilogue — why this matters

Cooper said this is the kind of document that defines a company's
direction. Treating it that way.

The freshness thread (1.1-1.7) is the boring-but-load-bearing
infrastructure piece. We will get this right because Stripe-grade
discipline applied to dependency management is the difference between
"a startup that ships a Base MCP integration" and "a platform that
becomes the canonical version-management primitive for agentic skills."
Both ship the same feature this week. One of them owns the category in
24 months. We're going to be the latter.

The vision thread (2.1-2.5) is the part that's been true for 18 months
but was hard to articulate before this week. Today's Base MCP launch
validates publicly what we've been building privately. Anthropic ships
brains. Coinbase ships wallets. We ship bodies. **There is no agent
economy without bodies.**

The parent PRD says how. This addendum says why.

Approve, redirect, push back — the doc is what's in your head about
this product. The implementation is downstream.

---

## Decision log (addendum)

- **2026-05-26**: Addendum authored at Cooper's request. Thread 1
  (freshness) ships in three tiers; tier 1 in PRD; tier 2 + tier 3
  spec'd here.
- **2026-05-26**: Tier 3 design includes the InstaClaw skill version
  manager — Stripe-/Apple-/Vercel-inspired. Identified as a
  standalone-product opportunity but out of scope for v1.
- **2026-05-26**: Vision thread surfaces the "three-leg stool" framing
  (brain + wallet + body). This becomes the lead candidate for the VC
  pitch and the public marketing narrative when Cooper runs `/launch`.
- **2026-05-26**: Eight structural primitives identified that ChatGPT /
  Claude / Cursor cannot replicate without becoming InstaClaw. This is
  the moat document; cite this section in any future "why doesn't
  OpenAI just build this" investor question.

---

## Sources

- [skills.sh — Vercel Labs Agent Skills directory](https://skills.sh)
- [skills.sh API docs](https://skills.sh/docs)
- [github.com/vercel-labs/skills](https://github.com/vercel-labs/skills)
- [github.com/mastra-ai/skills-api — skills.sh as an API](https://github.com/mastra-ai/skills-api)
- [github.com/base/base-mcp (deprecated)](https://github.com/base/base-mcp)
- [Official MCP Registry](https://registry.modelcontextprotocol.io/)
- [Coinbase Agentic Wallets](https://docs.cdp.coinbase.com/agentic-wallet/welcome)
- [Base Sub Accounts + Spend Permissions](https://docs.base.org/identity/smart-wallet/guides/sub-accounts/incorporate-spend-permissions)
- [coinbase/x402 — payment protocol](https://github.com/coinbase/x402)
- [Stripe API versioning](https://docs.stripe.com/api/versioning)
- [Stripe blog — APIs as infrastructure: future-proofing with versioning](https://stripe.com/blog/api-versioning)
- [MCP Server Discovery via .well-known/mcp.json (2026)](https://www.ekamoira.com/blog/mcp-server-discovery-implement-well-known-mcp-json-2026-guide)
- [skills-keeper npm package](https://www.npmjs.com/package/skills-keeper)
- [Parent PRD: instaclaw/docs/prd/base-mcp-integration.md](./base-mcp-integration.md)
