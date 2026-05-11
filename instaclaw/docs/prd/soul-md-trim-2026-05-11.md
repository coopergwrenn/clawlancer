# PRD — SOUL.md Deep Trim & V2 Activation

**Status:** Draft — Cooper signed off on all 8 §13 decisions (2026-05-11 in-session). Code bugs fixed; canary scripts to be written next.
**Author:** Claude (Opus 4.7, 1M context)
**Created:** 2026-05-11
**Updated:** 2026-05-11 — fleet-wide P0 context, 4 code bugs fixed in `stepMigrateSoulV2`, manifest target v92→v93, cross-terminal coordination with Edge City + Bug Squash + Consensus terminals.
**Branch:** TBD
**Companion docs / supersedes:**
- `instaclaw/docs/prd/prd-soul-restructure.md` (approved 2026-05-01) — this PRD does NOT replace it; it builds on it. The V2 architecture, migration script, and canary cohort defined there are correct. This PRD's job is (a) activate V2 with 2026-05-11 context, (b) add Phase 1 research that wasn't done in May 1, (c) propose V3 as the post-V2 evolution.
- `instaclaw/docs/prd/edge-city-strategy-2026-05-03.md` — partner timing constraint.
- `instaclaw/docs/prd/PRD-gbrain-integration.md` — competes for the same fleet-rollout calendar; sequencing decision in §11.

## P0 Context (2026-05-11 mid-session)

**Fleet-wide P0 in progress while this PRD was being drafted.** 46 of 208 VMs have SOUL.md > 35,000 chars after the v82 manifest pushed `CONSENSUS_MATCHING_AWARENESS_V1` (~600c) on top of an already-34.3K baseline. On those VMs, any `/reset` triggers a death spiral: `bootstrapMaxChars: 35000` truncates SOUL.md → trailing content garbled → Anthropic returns empty messages → empty-response retry → eventual 400 → auth cooldown → agent goes dark. Cooper's own agents (vm-780 / edgecitybot and one other) went down.

**Bug Squash terminal is shipping an emergency `bootstrapMaxChars` 35K→40K bandage.** That buys ~5K of headroom per VM but doesn't fix the underlying class of bug.

**vm-036 is the worst over-budget at 39,706 chars** — even on the 40K bandage it has 294 chars of headroom (0.7%). The next manifest content push could re-trigger truncation.

**This makes V2 activation more urgent.** V2 takes SOUL.md from ~34K to ~2.4K — eliminates the truncation class entirely, independent of `bootstrapMaxChars` value. Updated success criteria and canary cohort in §5.2 prioritize the 46 over-budget VMs.

## Code Bugs Fixed (this PRD's implementation, 2026-05-11)

Before writing the canary scripts I traced through `stepMigrateSoulV2` end-to-end and found 4 critical bugs that would have broken the migration on real-world VMs. All four are now fixed in `lib/vm-reconcile.ts`:

| # | Bug | File:Line (pre-fix) | Fix |
|---|---|---|---|
| 1 | Partner stubs silently destroyed on edge_city / consensus_2026 VMs (V2 template has no `## Edge Esmeralda 2026` header; `stepRewriteSoulPartnerSections` "old-not-found" → no-op forever) | `vm-reconcile.ts:3677-3838` | New `injectPartnerStubs()` helper reads `vm.partner` and injects the canonical `SOUL_STUB_EDGE` / `SOUL_STUB_CONSENSUS` stubs above the cache-boundary marker. Changes `stepMigrateSoulV2` signature from `vmId: string` to `vm: VMRecord & {partner?: string|null}`. Call site at line 194 updated. |
| 2 | Partial-state failure is permanent (idempotency check only on `SOUL_V2_MARKER`; a partial-write leaves SOUL=V2 but AGENTS/TOOLS/IDENTITY=V1 stuck forever) | `vm-reconcile.ts:3725` | Read all 4 files in one SSH round-trip (`readWorkspaceFiles` helper). Check all 4 V2 markers. Add explicit partial-state-recovery branch that writes only the missing files. Reorder writes: AGENTS → TOOLS → IDENTITY → SOUL (so partial failure leaves V1 SOUL on disk for the next tick's retry to re-extract from). |
| 3 | `writeFileAtomic` returned `true` for 0-byte writes (no content verification — Rule 10 violation) | `vm-reconcile.ts:3642-3654` | SHA256 of intended content computed client-side; remote shell verifies SHA on tmp post-decode AND on final file post-rename. Trap removes tmp on any exit path. Return type changes from `boolean` to `{ok: true} \| {ok: false; error: string}` so callers get rich error context. |
| 4 | Tar backup failure masked by `\|\| echo SKIP_EXISTS` — disk-full looked identical to "tar already exists", migration proceeded without recoverable backup | `vm-reconcile.ts:3793-3808` | `df` pre-check requires ≥2GB free on `/home/openclaw` (skip-with-error on the vm-903/801/904 session-backups-bloat cohort). Tar script uses explicit exit codes per outcome (`ALREADY_EXISTS`, `TAR_FAILED`, `TAR_TOO_SMALL`); minimum 1024-byte size check verifies tar is non-empty post-creation. |

Plus a fifth structural fix:

| #5 | Manifest re-append rules undid V2 migration on AGENTS.md (existing V2-marker skip only covered SOUL.md) | `vm-reconcile.ts:919-927, 975-983` | New `pickV2MarkerForPath()` helper returns the V2 marker for each of the 4 file types (SOUL/AGENTS/TOOLS/IDENTITY). The V2-marker skip now covers all 4. The `AGENTS_MD_PHILOSOPHY_SECTION` legacy append at `vm-manifest.ts:1328-1333` no-ops on V2 AGENTS.md. |

All 5 changes compile cleanly (`npx tsc --noEmit lib/vm-reconcile.ts` produces zero errors in my edited files). Test plan in §9 has dedicated probes (V18-V20) exercising each bug's failure mode against synthetic state.

---

## 0. TL;DR

Today's SOUL.md is 34,317 chars — 98% of the 35,000-char `bootstrapMaxChars` budget we raised from 30K as a band-aid. Edge_city VMs have 229 chars of headroom for new partners and features. We can't ship gbrain Phase 4 (fleet rollout), the matching engine UX layer, or any new partner (Eclipse, Devcon, Bitcoin 2026) without breaking this ceiling.

**The good news**: a complete V2 architecture is already designed (`prd-soul-restructure.md`, 2026-05-01), the code is written (`lib/workspace-templates-v2.ts`, `stepMigrateSoulV2` in `vm-reconcile.ts`), and the migration is gated cleanly behind `RECONCILE_SOUL_MIGRATION_ENABLED=false`. V2 shrinks the always-on bootstrap from 34K SOUL alone to **~22K total** across SOUL/AGENTS/TOOLS/IDENTITY.

**The recommendation**: **Activate V2 in the 18-day window 2026-05-12 → 2026-05-30** (before Edge Esmeralda starts), not "post-Esmeralda" as currently slated. The migration step is byte-perfect-preservation idempotent; we can roll it out at canary=1 → canary=5 → edge-cohort=5 → full fleet at a measured 12-day cadence and still have 6 days of soak before the village opens. Waiting until post-Esmeralda (Jun 27) wastes 6 weeks of accumulated weight and pushes V3 + gbrain into Q3.

**The novel additions** (Phase 1 research that May 1 didn't have):
- **IFScale (NeurIPS 2025)** measures Claude Sonnet 4 dropping from 94.4% → 77.2% instruction-following between 100 and 250 instructions. SOUL.md V1 has ~120 discrete instructions — straddles the cliff. V2 splits to ~30 in SOUL + ~80 in AGENTS — both back under 100.
- **Anthropic's own CLAUDE.md guidance for Claude Code: <200 lines per file** ("Bloated CLAUDE.md files cause Claude to ignore your actual instructions"). V1 is ~500 lines; V2 SOUL is 27 lines.
- **SillyTavern's lorebook pattern** (keyword-activated entries) is the published answer to "50K of knowledge, 5K of budget." V3 (post-V2) applies it to AGENTS.md's routing table and skill-awareness sections — projected 6K → 3K AGENTS.md cut.

**The hard floor I'm proposing** is **~14K total auto-injected bootstrap** in V3 (SOUL 2.5K + AGENTS 8K + TOOLS 3K + IDENTITY 0.5K), achievable after V2 soaks. Cooper's 25K target is wildly conservative; V2's 22K beats it; V3's 14K is the published-research-floor.

---

## 1. Status as of 2026-05-11 (what changed since May 1)

### 1.1 Numbers (audit script ran today)

```
=== SOUL.md size audit ===
Bootstrap budget (BOOTSTRAP_MAX_CHARS): 35,000 chars

--- Base SOUL.md components ---
  WORKSPACE_SOUL_MD                     21,271 chars  (60.8%)
  SOUL_MD_INTELLIGENCE_SUPPLEMENT        8,683 chars  (24.8%)
  SOUL_MD_LEARNED_PREFERENCES              534 chars  (1.5%)
  SOUL_MD_OPERATING_PRINCIPLES           1,156 chars  (3.3%)
  SOUL_MD_MEMORY_FILING_SYSTEM           2,671 chars  (7.6%)
  BASE TOTAL                            34,317 chars  (98.0%)

--- Partner sections ---
  edge_city section                        220 chars  (0.6%)   ← v80 stub
  consensus_2026 section                   234 chars  (0.7%)   ← v80 stub

--- Scenarios ---
  Untagged VM (no partner)              34,317 chars  ✓ 683 chars headroom
  consensus_2026 only                   34,551 chars  ✓ 449 chars headroom
  edge_city (gets both sections)        34,771 chars  ✓ 229 chars headroom
```

### 1.2 What's shipped since the May 1 PRD signoff

| Manifest | Date | Relevance |
|---|---|---|
| v77 (proposed in May 1 PRD) | — | _Was supposed to be the V2 restructure. Did not ship; manifest version slot consumed by other work._ |
| v78 | 2026-05-02 | Maximum Privacy Mode SSH bridge (edge_city). |
| v79 | 2026-05-02 | Privacy bridge security fixes. |
| v80 | 2026-05-04 | **Partner stubs ship** — `SOUL_STUB_EDGE` (220c) + `SOUL_STUB_CONSENSUS` (234c) via `stepRewriteSoulPartnerSections`. **Band-aid: addresses immediate truncation, leaves V1 SOUL.md at 21K untouched.** |
| v80–v82 | 2026-05-04/05 | Consensus matching engine, awareness sections (~234c each). |
| v83–v85 | 2026-05-05 | Skill-toggle gate, organic activation, Rule 24 install verification. |
| v86 | 2026-05-05 | `TasksMax 75 → 120`. |
| v87 | 2026-05-05 | `prctl-subreaper` integration. |
| v88 | 2026-05-05 | `build-essential` added to systemPackages. |
| v89 | 2026-05-06 | Identity patch ordering, lying-DB census kickoff. |
| v90 | 2026-05-07 | **Four-layer compaction reliability fix** (Rule 25/30, `mode`/`maxActiveTranscriptBytes`/`qualityGuard` keys). |
| v91 | 2026-05-08 | Reconciler cache-bust deploy (P1-4 root cause). |
| v92 | 2026-05-09 | Lying-DB v91-cohort recovery + `requiredSentinels` enforcement. |

**The V2 migration step has been written and shipped to code since the PRD signoff date**, but `RECONCILE_SOUL_MIGRATION_ENABLED` has stayed `false`. It's sitting in `lib/vm-reconcile.ts:3677-3838` ready to fire. The Phase 0.7 tar artifacts referenced in the May 1 PRD (`workspace-pre-restructure-2026-05-01.tar.gz` on vm-733) are 10 days old but still byte-exact for rollback.

### 1.3 What the partner band-aid (v80) bought us — and what it didn't

**Bought:**
- edge_city VMs no longer silently truncate the partner section (the original Edge incident was 1,054 chars over the 35K cap).
- Consensus partner can ship without growing SOUL.md materially.
- Headroom for **one** more partner stub at ~200 chars (Eclipse / Devcon — single partner; not two).

**Did not buy:**
- **The 21K + 8.7K base SOUL** problem. Still in front of every agent on every turn.
- **The 35K bootstrapMaxChars cost.** Estimated at ~$2,600/yr fleet-wide (per Cooper's note; the actual driver is cache-write premiums on wider prompts during cache-miss windows — see §6).
- **The IFScale instruction-following cliff.** Still ~120 instructions in the always-on prompt.
- **Cache stability** on `Learned Preferences` edits. Existing V1 already has the `OPENCLAW_CACHE_BOUNDARY` marker (`lib/ssh.ts:3495`) — verified at line 3495 — so Preferences edits below the marker don't invalidate the cache. **That fix landed in v68 (per `lib/vm-manifest.ts:663`), and is independent of V2 size.** Good news; one fewer thing to chase in this PRD.

### 1.4 What's blocking the V2 activation right now

Per `prd-soul-restructure.md` §6 (Migration Plan):
- Phase 0 (baseline tar): ✅ done on vm-073 and vm-733 (2026-05-01).
- Phase 1 (code): ✅ shipped in `workspace-templates-v2.ts` + `stepMigrateSoulV2`.
- Phase 2 (canary on vm-733): ❌ **not run**. Migration is still gated.
- Phase 3 (5-VM expansion incl. vm-354): ❌ not started.
- Phase 4 (fleet): ❌ not started.

Cooper's stated reason: deferred to "P1 post-Esmeralda" (`lib/vm-manifest.ts:1024`). My pushback in §11 — that's the wrong sequencing call.

---

## 2. Phase 1 research synthesis (the part the May 1 PRD didn't do)

I ran 6 parallel research agents covering Anthropic guidance, Claude Code's own CLAUDE.md design, Cursor/Windsurf/GPTs, multi-agent frameworks, character platforms, and academic prompt-compression research. Sources at the end of each subsection.

### 2.1 Anthropic's published guidance (what they tell *us* to do)

| Source | What it says | Implication |
|---|---|---|
| [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | "The minimal set of information that fully outlines your expected behavior... minimal does not necessarily mean short." Also: "context rot — as token count grows, accuracy and recall degrade." | Anthropic's framing is "find the right altitude" not "make it short". But they name context rot as a real degradation. |
| [Prompt caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) | Sonnet 4.6: cache writes $3.75/MTok (1.25× input); cache hits $0.30/MTok (0.1×). Minimum cacheable prefix = 2,048 tokens. 5-min TTL default. | A cold cache message is 12.5× more expensive than a warm one. Cache-hygiene > prompt size. |
| [Memory tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) | "Just-in-time context retrieval: rather than loading all relevant information upfront, agents store what they learn in memory and pull it back on demand." | **Direct endorsement of on-demand-load over upfront-load.** |
| [Long-context prompting](https://www.anthropic.com/news/prompting-long-context) | Long inputs at top; **critical instructions at the END of the prompt** — "Claude's recall of them" is highest there. | Our SOUL.md's most safety-critical rules (never-self-restart, never-openclaw-update, no-refuse-token-launches) live in middle sections in V1. V2 fixes this. |
| [Anthropic's Apr 23 postmortem](https://anthropic.com/engineering/april-23-postmortem) | They reverted a single-line verbosity instruction because it hurt coding quality. | Confirmation: every line in a long system prompt has measurable behavioral impact. |

### 2.2 Claude Code's own CLAUDE.md design

**This is the strongest signal in all of Phase 1 — Anthropic engineers eat their own dog food.**

| Source | What it says | Implication |
|---|---|---|
| [Claude Code memory docs](https://code.claude.com/docs/en/memory) | "Target under 200 lines per CLAUDE.md file. Longer files consume more context and reduce adherence." | **<200 lines per file.** Our V1 SOUL.md is ~500 lines; V2 SOUL is 27 lines. |
| [Claude Code best practices](https://code.claude.com/docs/en/best-practices) | Pruning rule: "For each line, ask: 'Would removing this cause Claude to make mistakes?' If not, cut it. Bloated CLAUDE.md files cause Claude to ignore your actual instructions!" | The diagnostic question to apply to every section of V1 SOUL.md. |
| [Skills docs](https://code.claude.com/docs/en/skills) | "In a regular session, skill descriptions are loaded into context so Claude knows what's available, but full skill content only loads when invoked." | **Progressive disclosure** = the load-bearing Anthropic pattern. Our CAPABILITIES.md already does this; AGENTS.md should too. |
| [Context window breakdown](https://code.claude.com/docs/en/context-window) | At session start: System prompt ~4,200 tokens; project CLAUDE.md ~1,800 tokens (~7KB); global ~/.claude/CLAUDE.md ~320 tokens. | Anthropic's own project CLAUDE.md averages ~7KB. Our V1 is ~34KB — **~5× their internal target.** |
| Leaked Claude Code system prompt | ~53KB / ~13K tokens, 25+ conditional sections, uses explicit `<!-- cache-boundary -->` marker. | The full system prompt CAN be 13K tokens for a complex coding agent — but ours doesn't need that complexity. |

### 2.3 Multi-agent framework consensus

Red Hat + TianPan production studies (Feb–May 2026): **"Keep your static system prompt under 1,024 tokens"** for chat-shaped agents. Production median is ~500 tokens for persona+workflow. A 4,000-token system prompt rewritten to 200 tokens scored 4 points higher on evals and was 40× cheaper.

Sources: [Red Hat — big vs small prompts](https://developers.redhat.com/articles/2026/02/23/prompt-engineering-big-vs-small-prompts-ai-agents), [TianPan — 200-token prompt](https://tianpan.co/blog/2026-05-02-200-token-system-prompt-beats-4000-token-one).

CrewAI uses 1-3 sentence role+goal+backstory triples. LangGraph supervisor uses short tool descriptors for sub-agents, not full system prompts. Mastra uses a single `instructions` string with tools+memory as separate modular components.

**The consensus**: identity is compact; capabilities live in tools; long-running context is summarized into a recurring summary block.

### 2.4 Character platform patterns (closest fit to our problem shape)

| Platform | Persona budget | Pattern |
|---|---|---|
| Character.AI | **3,200 chars actually read** (32K writable, only 3.2K loaded) | Hard cap. |
| Janitor AI | "Under 2,500 permanent tokens (~10KB)" | Soft cap with degradation warning at boundary. |
| SillyTavern / Char Card V2 | 800–1,200 tokens (~3–5KB) | + `character_book` lorebook layer (keyword-activated, on-demand retrieval). |

**The most relevant pattern for us is SillyTavern's lorebook.** Each entry has `keys` (activation keywords), `content`, `insertion_order`, `constant: bool`. Constant entries always inserted; selective entries fire only when keywords appear in the recent N messages. Token budget capped at ~20% of context window.

**This pattern maps directly to AGENTS.md's routing table in V3.** Instead of putting 15 routing rows (3K) in every turn's prompt, we make them lorebook entries:
- `keys: ["portfolio", "positions", "p&l", "balance"]` → "Run `polymarket-portfolio.py summary`"
- Only injected when the user message contains those keys.
- Saves ~2.5K chars on the average turn (when the user isn't asking about any of those topics).

OpenClaw doesn't natively implement this (verified — bootstrap files are statically concatenated). It's a V3+ build-out.

### 2.5 Academic prompt-engineering research

**The single most actionable finding is [IFScale (Jaroslawicz et al., NeurIPS 2025)](https://arxiv.org/abs/2507.11538).** Measured instruction-following accuracy vs. instruction count on Claude Sonnet 4:

| Instructions | Accuracy |
|---|---|
| 10 | 100.0% |
| 50 | 98.0% |
| 100 | 94.4% |
| 250 | 77.2% |
| 500 | 42.9% |

Three regimes: threshold decay (o3, Gemini 2.5 Pro), **linear decay (gpt-4.1, claude-3.7-sonnet, claude-4-sonnet)**, exponential decay (gpt-4o, llama-4-scout, claude-3.5-haiku).

**Our V1 SOUL.md has roughly 80-150 discrete instructions** depending on how you count (each routing row, each "do/don't", each memory rule). That puts us in the 90-95% accuracy band — already lossy. Below the cliff but climbing toward it.

**V2's SOUL.md (~30 instructions) + AGENTS.md (~80 instructions) split keeps each file under the 100-instruction safety threshold individually.** This is a non-cost behavioral reason to ship V2: instruction-following adherence is higher per file when each file is smaller.

Other relevant papers:
- **[Lost in the Middle](https://arxiv.org/abs/2307.03172)** — U-shaped recall curve. Critical instructions belong at the START or END. V2's "Hard Boundaries" section is at top; V2 SOUL.md "Vibe" is at bottom-before-cache-boundary. Good.
- **[Codified Context (2026)](https://arxiv.org/abs/2602.20478)** — proposes three-tier architecture: "hot memory (constitution, always loaded), domain specialists (invoked per task), cold memory (retrieved on demand)." Maps cleanly to SOUL.md → AGENTS.md → on-demand workspace files.
- **[Agent Skills for LLMs (2026)](https://arxiv.org/abs/2602.12430)** — explicitly frames skills as "composable packages of instructions, code, and resources that agents load on demand."

**Key takeaway**: the research literature is silent on "if I compress a 30K system prompt to 5K via LLMLingua-2, does the agent maintain persona/safety/tool-use behavior?" — no paper has run that experiment. Therefore: **manual rewrite + behavioral test is the safe path**, not automated compression.

### 2.6 Industry production sizes (calibration)

| Agent | Static system prompt size (estimated/leaked) | Notes |
|---|---|---|
| Claude Code | ~13K tokens (~53KB) | 25+ conditional sections with cache markers. |
| Claude.ai (consumer) | ~15K tokens | Includes 12+ tool definitions + safety classifiers. |
| v0 (Vercel) | ~10K tokens (~2,200 lines) | Vercel CTO: "we completely pivoted to let it rip" — prompt isn't the moat. |
| Devin | 6,500+ lines | Full tool catalog inline. |
| Replit Agent | "Dynamic prompt construction" — no fixed system prompt; multi-agent split | |
| Cursor "Always Apply" | community ceiling ~200 words (~1KB) | Hard rules; everything else is glob-attached or agent-requested. |
| Windsurf global rules | **6,000-token hard cap** | Enforced. |
| Custom GPT (OpenAI) | **8,000-char hard cap** | Enforced. Builders use knowledge files for the rest. |
| Production chat-agent median (Red Hat / TianPan 2026) | **500 tokens** | Static system prompt. |
| **InstaClaw V1** | **~8,500 tokens (34KB SOUL alone)** | Above coding-agent median; far above chat-agent median. |
| **InstaClaw V2 (proposed)** | ~625 tokens SOUL + ~3,500 tokens AGENTS = ~4,100 tokens | Below chat-agent median in SOUL alone; below coding-agent median across all files. |
| **InstaClaw V3 (proposed)** | ~625 tokens SOUL + ~2,000 tokens AGENTS = ~2,625 tokens | At Red Hat's recommended ceiling. |

The cliff between V1 and V2 is **2× to 3× reduction in tokens-per-turn**. That's real, measurable, and matches IFScale's measured behavioral improvement zone.

---

## 3. The three states — V1, V2, V3 — and why each exists

### 3.1 V1 (current, what ships today)

Total auto-injected bootstrap = SOUL.md (34,317c) + AGENTS.md (~8,244c on disk per PRD §1.7 measurement) + TOOLS.md (~439c) + IDENTITY.md (~442c) + USER.md (~397c) + MEMORY.md (varies, ~1,800c average) ≈ **45.6KB total ≈ 11.4K tokens canonical bootstrap.**

Per-file budget is hit at SOUL.md (35K cap, 34.3K used, 98%). Other files are healthy.

**Failure modes:**
- Edge_city + consensus VMs: 34,771 chars on a 35,000-char cap = 229 chars of headroom. Any new partner stub OR any 230+ char addition to V1 SOUL.md silently truncates the tail.
- Cache invalidation: V1 already has `OPENCLAW_CACHE_BOUNDARY` marker (v68), so Learned Preferences edits below the boundary don't invalidate cache. **This is fine in V1.** The remaining cache-invalidation risk is manifest bumps that touch content above the boundary (any change to base SOUL.md, the supplement, the operating principles section).
- IFScale: ~80-150 instructions in always-on context, mid-degradation zone.
- Anthropic's own guidance: ~5× the recommended project-CLAUDE.md size.

### 3.2 V2 (designed May 1, gated `RECONCILE_SOUL_MIGRATION_ENABLED=false`)

Target totals per `prd-soul-restructure.md` §4:
- SOUL.md V2: **~2,400 chars** (persona, hard boundaries, cache-stable Preferences)
- AGENTS.md V2: **~14,200 chars** (rules, routing, memory, tool failure, autonomy)
- TOOLS.md V2: **~4,900 chars** (commands — skills, wallets, scripts, ACP, dispatch, web)
- IDENTITY.md V2: **~480 chars** (Name / Creature / Vibe / Emoji)
- **Total auto-injected: ~22,000 chars ≈ 5,500 tokens canonical bootstrap.**

**Improvements over V1:**

| Axis | V1 | V2 |
|---|---|---|
| SOUL.md size | 34,317c | 2,400c (88% cut) |
| Total auto-bootstrap | ~30,000c | ~22,000c (27% cut) |
| Discrete instructions in SOUL.md | ~120 | ~25 |
| Discrete instructions in AGENTS.md | ~10 | ~80 (consolidated from V1's three duplicates) |
| Routing-table position | mid-prompt (low attention) | top of AGENTS.md (high attention) |
| Cache-boundary marker | present (v68) — but above it is 17K | present — above it is 1.8K (10× more cache-stable) |
| Customization preservation | manual | byte-perfect via `stepMigrateSoulV2` for 13 customized VMs |
| Anthropic-guideline conformance | over by 5× | over by 1.3× (still over but tolerable) |

**Architecture (verified against OpenClaw source in May 1 PRD §1.4)**:
```
loadWorkspaceBootstrapFiles (verified in workspace-Ddypv-c6.js):
  1. AGENTS.md          ← auto-injected
  2. SOUL.md            ← auto-injected
  3. TOOLS.md           ← auto-injected
  4. IDENTITY.md        ← auto-injected
  5. USER.md            ← auto-injected
  6. MEMORY.md          ← auto-injected
  7. HEARTBEAT.md       ← cron only
  8. BOOTSTRAP.md       ← first-run only
```

CAPABILITIES.md and EARN.md are NOT auto-injected (magic-word tests in May 1 PRD §1.2 confirmed) — agent reads them on demand.

**Migration step (in code, ready to fire):**

`stepMigrateSoulV2` in `lib/vm-reconcile.ts:3677-3838`:
1. Env gate: `RECONCILE_SOUL_MIGRATION_ENABLED=true` required.
2. Per-VM whitelist: `RECONCILE_SOUL_MIGRATION_VM_IDS=<id>,<id>,...` for canary scoping.
3. Tar workspace to `~/.openclaw/workspace-pre-soul-v2-migration.tar.gz` (idempotent — only if absent).
4. Extract `## My Identity` and `## Learned Preferences` from old SOUL.md.
5. Determine customization (vs canonical template fragments).
6. Build new V2 SOUL/AGENTS/TOOLS/IDENTITY with preserved customizations.
7. Atomic writes (tmp + rename).
8. Idempotent on `SOUL_V2_MARKER` check.

**Phase 0.7 fleet survey results** (from May 1 PRD §6.4):
- 8/201 (4.0%) have customized `## My Identity` — preserved via `appendPreservedIdentity`.
- 5/201 (2.5%) have customized `## Learned Preferences` — preserved via `applyPreservedPreferences`.
- 0/201 (0.0%) have heavy edits (extra sections). Dead code removed.
- **vm-354 (Timour @edgeclaw1bot) has custom identity AND is Edge City demo** — must be in Phase 3 canary with byte-perfect preservation verified.

### 3.3 V3 (proposed in this PRD, post-V2)

V2 leaves AGENTS.md at 14.2K — still big. Phase 1 research suggests we can go further with two specific techniques:

**V3 target: total auto-injected bootstrap ≈ 14KB ≈ 3,500 tokens.**

| File | V2 | V3 | Cut technique |
|---|---|---|---|
| SOUL.md | 2,400c | 2,400c | _Keep V2 — persona is at the floor._ |
| AGENTS.md | 14,200c | **~8,000c** | Move full Memory Protocol details (~3K) to `memory/PROTOCOL.md` (stub in AGENTS); move Web/Browser SPA specifics (~1K) to `~/.openclaw/skills/web-search-browser/SKILL.md` (already exists upstream); move Tool Failure Recovery long form (~1.5K) to AGENTS-TOOL-FAILURE.md stub. |
| TOOLS.md | 4,900c | **~3,000c** | Move Virtuals ACP command reference (~1.5K) into `~/virtuals-protocol-acp/SKILL.md` (already exists; we duplicate). Move Dispatch script catalog (~700c) into a script_help shell function that prints itself. |
| IDENTITY.md | 480c | 480c | _Keep V2 — at the floor._ |
| **Total** | **22,000c** | **~14,000c** | **~36% additional cut** |

**Risk of V3**: each on-demand-load adds a tool round-trip (~200–500ms) on relevant queries. Trade-off analysis in §7.

**V3 also introduces (optional) lorebook-style routing table** as a separate experiment — see §10.

### 3.4 The hard floors and why

**SOUL.md ≈ 2,000c hard floor.** Below this, persona evaporates (per character-platform research: 800–3,000 tokens is the published persona floor). Hard boundaries (never-self-restart, never-openclaw-update, no-refuse-token-launches per Rule 28, provider confidentiality per Rule 28 / Sjinn) cannot be moved on-demand — they're safety-critical, must be in every turn's prompt. That's ~1,200c of hard rules + ~800c of persona = 2,000c floor.

**AGENTS.md ≈ 6,000c hard floor.** Must include: rule priority (200c), session-start checklist (700c), greeting-after-rotation (700c), routing table (3K, even compressed), memory file responsibilities (500c), tool-failure stub (200c), autonomy guardrails table (600c). Anything below 6K starts cutting safety-relevant content.

**TOOLS.md ≈ 2,000c hard floor.** Skills lookup, wallet routing table, top 5 scripts. Below this, agent has to consult on-disk SKILL.md files for every reference, adding round-trips.

**IDENTITY.md ≈ 400c floor.** 4 fields. Already at floor.

**Total hard floor: ~10.5KB ≈ 2,600 tokens.** This is the "you can't go below this without breaking platform invariants" line. V3 at 14KB has 3.5KB of safety headroom above the floor.

**Cooper's 25K target is between V1 (34K) and V2 (22K)**, and doesn't drive a clear behavioral or cost outcome. I recommend abandoning that target as the goal and using V2 (22K) as the activation goal and V3 (14K) as the soak target.

---

## 4. Section-by-section trim plan

For each V1 section, the disposition (KEEP / COMPRESS / MOVE TO ON-DEMAND / REMOVE), the destination, the char delta, and the regression test.

### 4.1 WORKSPACE_SOUL_MD (21,271 chars → 2,400 chars in V2)

| § | V1 section | Chars | V2 disposition | Notes |
|---|---|---|---|---|
| 1 | Header + First Run Check | 700 | **MOVE TO AGENTS.md** as "Session Start step 2" | Bootstrap is an operational rule. |
| 2 | Core Truths (5 principles) | 1,200 | **KEEP IN SOUL.md** | Persona — load-bearing for personality. |
| 3 | Platform (InstaClaw identity + token launch) | 2,400 | **KEEP IN SOUL.md V2** | Rule 28 "do not refuse token launches" is safety-critical; verified in V2 SOUL.md. Position improved: it now reads top-of-prompt, high attention. |
| 4 | My Identity placeholder | 400 | **MOVE TO IDENTITY.md V2** | Splits identity edits from SOUL cache; agent customization doesn't invalidate cache. |
| 5 | How I Communicate (session continuity, frustration, DM/group) | 1,800 | **MOVE TO AGENTS.md** | Operational. |
| 6 | Hard Boundaries + Autonomy table | 1,400 | **SPLIT** — boundaries to SOUL.md, autonomy table to AGENTS.md | Hard boundaries (5 rules) stay in SOUL.md V2 ("Hard Boundaries" section, ~600c). Autonomy 3-tier table moves to AGENTS.md. |
| 7 | Sharing Files (deliver_file.sh) | 500 | **MOVE TO TOOLS.md** | Command reference. |
| 8 | When I Mess Up | 200 | **MOVE TO AGENTS.md** | Operational rule. |
| 9 | Earning Money pointer | 300 | **MOVE TO AGENTS.md** | One-liner pointing at EARN.md. |
| 10 | Operating Principles + Quick Command Routing (10 rows) | 3,000 | **MOVE TO AGENTS.md "Routing Table"** | All 10 rows + dynamic content (chrome relay, etc.) moves. AGENTS.md is the documented home per OpenClaw architecture. |
| 11 | Every Session Do This First (7-step) | 700 | **MERGE TO AGENTS.md "Session Start"** | Single canonical source. |
| 12 | Memory non-negotiable + Problem-solving stance | 1,200 | **MOVE TO AGENTS.md** | Operational. |
| 13 | Web/browser/SPA/Vision/Rate-limits etc | 3,500 | **MOVE TO AGENTS.md** | All tool-usage policy. |
| 14 | Before Saying "I Can't" checklist | 700 | **MOVE TO AGENTS.md "Tool Failure Recovery"** | |
| 15 | Virtuals Protocol ACP commands | 1,500 | **MOVE TO TOOLS.md** | Command reference. |
| 16 | Vibe (one paragraph) | 150 | **KEEP IN SOUL.md** | Persona. |
| 17 | OPENCLAW_CACHE_BOUNDARY marker | 30 | **KEEP IN SOUL.md** | Architecturally critical. |
| 18 | Learned Preferences section | 700 | **KEEP IN SOUL.md V2** (below cache boundary) | Cache-stable. Agent edits don't invalidate above-marker cache. |
| 19 | Memory Persistence (CRITICAL) | 3,900 | **MOVE TO AGENTS.md** | Operational + duplicates §24. |
| 20 | Task Completion Notifications | 400 | **MOVE TO AGENTS.md** | Operational. |
| 21 | Continuity (one sentence) | 200 | **KEEP IN SOUL.md V2** (compressed to "Each session you wake up fresh — but your workspace files are your memory. They're how you persist across rotations.") | Persona reinforcement, short. |
| 22 | Bootstrap reference at top of file | (covered in §1) | **MOVE TO AGENTS.md** | |

**V2 SOUL.md final content (verified at `lib/workspace-templates-v2.ts:60-139`):**
- Header + Core Truths (~1,000c)
- Platform + Token-launch directive (~1,400c)
- Hard Boundaries (~600c)
- Vibe + Continuity (~250c)
- Cache boundary marker
- Learned Preferences placeholder (~700c, dynamic suffix)

Total: 2,400c. ✓

### 4.2 SOUL_MD_INTELLIGENCE_SUPPLEMENT (8,683 chars → 0 in V2)

All sections move to AGENTS.md. ~50% are DUPLICATES of V1 SOUL.md content (Rule Priority, Session Resume, Tool Discovery, Web Tools, Vision, Rate Limits, Autonomy, Frustration Detection, Context Awareness, Anti-Decay, Memory Recall, Sharing Files, Sub-Agents — all duplicate-redundant with V1 SOUL §10–§19).

**Net AGENTS.md size after dedupe: ~14.2K** (not 8.7K + 21K = 30K — the dedupe is the load-bearing operation).

### 4.3 SOUL_MD_OPERATING_PRINCIPLES (1,156 chars → split V2)

| Item | V1 | V2 destination |
|---|---|---|
| Error handling | included | **AGENTS.md "Autonomy Guardrails — config safety"** |
| Config safety | included | **AGENTS.md "Autonomy Guardrails — config safety"** |
| Never go silent | included | **AGENTS.md "Tool Failure Recovery — never go silent"** |
| **NEVER self-restart** | included | **SOUL.md V2 "Hard Boundaries"** (safety-critical, must be persona-level) |

### 4.4 SOUL_MD_MEMORY_FILING_SYSTEM (2,671 chars → AGENTS.md "Memory Protocol")

Single canonical home in AGENTS.md V2. V2 dedupes against V1's three duplicate copies (§17, §18, §24).

### 4.5 SOUL_MD_LEARNED_PREFERENCES (534 chars)

Merged into V2 SOUL.md below cache boundary (verified in `workspace-templates-v2.ts:124-138`).

### 4.6 SOUL_STUB_EDGE (220c) + SOUL_STUB_CONSENSUS (234c)

**KEEP AS-IS in V2.** These are already stubs pointing to skill SKILL.md files (per v80 fix). No further trim possible without losing partner awareness.

**Note for V3+ partners**: every new partner should add a ≤200c stub. Hard limit. Anything bigger goes in the skill's own files.

---

## 5. Migration plan (V2 activation, 2026-05-12 → 2026-05-30)

### 5.1 Why this window

| Date | Event | Implication |
|---|---|---|
| 2026-05-11 | Today — Bug Squash 35K→40K bandage shipping; 4 code bugs in `stepMigrateSoulV2` fixed; V2 in code, gated. | Bandage gives ~5K headroom on the 46 over-budget VMs. V2 migration safe to canary. |
| 2026-05-11 evening | Consensus terminal snapshot bake (deferred to tonight). | **Coordination: V2 templates MUST be on main BEFORE this bake** so new VMs provisioned from the snapshot come up with V1 templates that the reconciler migrates to V2 on first tick (not a snapshot that pre-bakes V2 — that's V3+ scope). |
| 2026-05-12 morning | Phase 2 canary on vm-733. | 24h soak. |
| 2026-05-13 morning | **Phase 2.5 emergency canary on vm-036 (worst over-budget at 39,706c)** + 4 more from the 46-over-budget cohort. | 24h soak. The most at-risk users first. |
| 2026-05-14 | Phase 3 canary on 5 VMs incl. vm-354 (Timour) and vm-780 (Cooper's @edgecitybot). | 48h soak. |
| 2026-05-16 | Edge-cohort expansion to remaining 5 edge_city VMs. | 48h soak. **The 5 edge VMs have a privacy bridge layer; this is the highest-risk cohort.** |
| 2026-05-18 | Pause for Cooper review (read soak metrics; decision: proceed or revert). | |
| 2026-05-19 → 2026-05-25 | Fleet rollout at concurrency=3 with `--test-first`, 10-VM waves with audit gates per CLAUDE.md OpenClaw Playbook. Priority order: remaining 41 over-budget VMs first, then everything else. | ~7 days at concurrency=3, 8-hour-shift reconcile windows. |
| 2026-05-26 → 2026-05-29 | **Full-fleet 4-day soak** before Esmeralda. | Verify: 0 support tickets containing "agent forgot", "doesn't know what to do", "lost personality", "won't launch tokens". Coverage probe (Rule 27) confirms 0 VMs with SOUL.md > 5K. |
| **2026-05-29** | **Bump manifest to v94**: `bootstrapMaxChars` 40,000 → 30,000. | Tighten invariant after V2 fully landed. |
| **2026-05-30** | **Edge Esmeralda starts.** V2 fully deployed and soaked; bootstrapMaxChars reverted. | |

**This timeline finishes V2 rollout 6 days before Esmeralda starts.** Compare to the "post-Esmeralda" current plan which finishes V2 rollout no earlier than Jul 5 — **8 weeks later** than this plan.

### 5.1.1 Cross-terminal coordination requirements

This PRD's work runs in parallel with three other terminals. Explicit coordination notes:

**Edge City terminal** (v92, shipped):
- Built `stepRewriteSoulPartnerSections` (vm-reconcile.ts:3906) — surgical SOUL.md partner-stub rewrite with marker-based idempotency.
- Built `stepDeployEdgeOverlay` (vm-reconcile.ts:4123) — writes `INSTACLAW_OVERLAY.md` to the cloned edge-esmeralda skill dir.
- Reconciler step order: stepFiles(184) → stepMigrateSoulV2(194) → ... → stepRewriteSoulPartnerSections(320) → stepDeployEdgeOverlay(328).
- **Conflict point**: stepMigrateSoulV2 used to wipe partner stubs (Bug #1 — fixed). Now it reads `vm.partner` and injects `SOUL_STUB_EDGE` / `SOUL_STUB_CONSENSUS` directly into V2 SOUL.md. stepRewriteSoulPartnerSections then runs and finds the markers (`SOUL_STUB_EDGE_MARKER`, `SOUL_STUB_CONSENSUS_MARKER`) present, treating as "already-patched" — idempotent no-op. **stepDeployEdgeOverlay is unaffected** — it writes to the skill dir, not SOUL.md.
- No action required from Edge City terminal beyond the v92 work they shipped.

**Bug Squash terminal** (shipping P0 bandage now):
- Bumping `agents.defaults.bootstrapMaxChars` 35,000 → 40,000.
- Independent manifest version (likely v93 if they ship first; if they ship as a non-version-bump config-only patch, this PRD's V2 activation may take v93).
- **Sequencing**: confirm with Bug Squash whether their bandage takes a manifest version slot. If yes, this PRD's V2 activation is v94 (and the 40K→30K revert becomes v95). If no, this PRD takes v93 and the revert is v94.
- The reconciler enforces `bootstrapMaxChars` via `configSettings`, so the bandage propagates on next reconciler tick fleet-wide.

**Consensus terminal** (snapshot bake tonight):
- Building a fresh snapshot from current fleet state.
- **Coordination requirement**: this PRD's V2 templates (already in code at `lib/workspace-templates-v2.ts`) and bug-fixed reconciler (`lib/vm-reconcile.ts`) must be on main BEFORE the bake. Otherwise the snapshot pre-bakes the broken `stepMigrateSoulV2` and new VMs provisioned from it would hit Bugs #1-#4 on first reconcile.
- After bake: new VMs from the snapshot come up with V1 templates (not V2 — V2 lives in templates that the reconciler migrates on first tick, not in baseline config). When `RECONCILE_SOUL_MIGRATION_ENABLED=true` is set in Vercel, the reconciler migrates fresh VMs to V2 on first tick.

### 5.1.2 Priority cohort (the 46 over-budget VMs)

Per the 2026-05-11 P0: 46 of 208 VMs have SOUL.md > 35,000 chars. With Bug Squash's 40K bandage these VMs are no longer truncating, but they remain the highest-priority migration cohort because:

1. They're the closest to re-degrading — any new manifest content push (e.g. a future partner stub, a new awareness block) could push them past 40K.
2. They've had bigger sessions / longer histories — testing V2 migration here surfaces extraction-and-preservation edge cases (multiple Identity overrides, accumulated Preferences) that template-default VMs wouldn't.
3. Their tail content (memory filing system, learned preferences) was being truncated until the bandage landed — agents may have inconsistent recent behavior. V2 makes the prompt deterministic again.

**vm-036 at 39,706c is the most urgent** — 294 chars of headroom on the 40K bandage. Phase 2.5 canary includes it specifically.

### 5.2 Canary cohort (revised for 2026-05-11 P0 reality)

| VM | Tier | Identity custom? | Prefs custom? | Over-budget? | Phase | Purpose |
|---|---|---|---|---|---|---|
| vm-733 | power (team) | N | N | N | 2 | Phase 0.7 tar in place; representative of 20-VM hash cluster. Lowest-risk canary. |
| **vm-036** | varies | TBD | TBD | **Y (39,706c — worst)** | **2.5** | Worst over-budget VM. If migration handles vm-036's tail content cleanly, the rest of the over-budget cohort is straightforward. |
| +4 over-budget VMs | varies | varies | varies | Y | 2.5 | Sampled from the 46-cohort to cover variation (different tiers, partner tags, customization states). |
| **vm-354** | starter | **Y (Timour)** | N | TBD | 3 | Edge City demo; byte-perfect identity preservation **mandatory**. If migration breaks vm-354 in any way, ABORT. |
| vm-780 | power | N (template) | N | TBD | 3 | Cooper's @edgecitybot; partner demo. |
| vm-563 OR vm-866 | starter or pro | N | **Y** | TBD | 3 | Customized preferences preservation test. |
| (one more) starter template-default | starter | N | N | N | 3 | Representative of the ~93% template-default majority. |

**Migration-safe but probe-deferred (Telegram 401 cluster):** vm-801, vm-903, vm-911 have broken Telegram bot tokens (Bug Squash terminal flagged). The V2 migration itself is safe to run on these VMs — it only touches workspace files, not Telegram config. **But behavioral regression probes (V1-V14, V17) require a working user-message path and cannot run on these VMs.** Treat them as "migrated, probe-deferred until bot token is reissued." Do NOT include them in canary cohort; include them in fleet rollout once tokens are fixed OR migrate them silently and rely on cv field + on-disk file inspection for verification.

Each canary VM runs probes V1–V11 (per May 1 PRD §5.2) plus probes from this PRD:

| Probe | Test | Pass criterion |
|---|---|---|
| **V12** | After V2 migration, count discrete instructions in the active prompt | Each file under 100 (IFScale safety zone). |
| **V13** | Send a "launch a token called X" request | Routes to Bankr dashboard direction (Rule 28 + V2 SOUL.md routing). No "I can't" refusal. |
| **V14** | Edit Learned Preferences via the agent, re-send a baseline query | `cacheRead` ≈ original (cache stable across Preferences edit). |

### 5.3 Rollback plan

**Per-VM (single command, ssh to VM):**
```bash
tar xzf ~/.openclaw/workspace-pre-soul-v2-migration.tar.gz -C ~/.openclaw/ \
  && rm -f ~/.openclaw/workspace/AGENTS.md ~/.openclaw/workspace/TOOLS.md \
  && rm -f ~/.openclaw/workspace/IDENTITY.md \
  && systemctl --user reload openclaw-gateway
```

Verifies: cmp the post-restore SOUL.md against the tar contents; expect 0 difference.

**Fleet-wide rollback:**
- Set `RECONCILE_SOUL_MIGRATION_ENABLED=false` (env var, Vercel dashboard).
- Reconciler stops migrating new VMs.
- For already-migrated VMs, run a one-shot `_rollback-v2-from-tar.ts` script (to be written in Phase 1.5 — see §11) that SSH-restores from each VM's `workspace-pre-soul-v2-migration.tar.gz`.

### 5.4 Concurrency & gate enforcement (per CLAUDE.md mandatory rules)

- **Rule 3**: `--test-first` flag — Phase 2 canary is built-in.
- **Rule 4**: `--dry-run` first — `stepMigrateSoulV2` already supports dryRun.
- **Rule 5**: Verify gateway health after change — add to migration step.
- **CLAUDE.md OpenClaw Playbook concurrency=3 max**: enforce in fleet rollout script.
- **Wave audit gates after each 10 VMs**: HALT on first failure.

The May 1 PRD's `migrateExistingSoulMd` step already does atomic writes, idempotent tar, byte-perfect preservation. The remaining work is:
1. Write `_canary-v2-migration.ts` script that sets `RECONCILE_SOUL_MIGRATION_VM_IDS=<id>` and runs `reconcileVM` against the specified VM.
2. Write `_fleet-v2-rollout.ts` with concurrency=3, wave=10, audit-gate-fail-halt.
3. Write `_rollback-v2-from-tar.ts` for emergency rollback.

All three are derivative of existing scripts (`_fleet-push-strip-thinking-hotfix.ts`, `_upgrade-fleet-to-v64.ts` per CLAUDE.md).

---

## 6. Cost & latency model (updated for 2026-05-11)

### 6.1 Inputs

- **Fleet size**: 225 active VMs (per CLAUDE.md; May 1 PRD assumed 120).
- **Messages per VM per day**: ~50 (conservative; some VMs higher).
- **Sonnet 4.6 pricing**: cache write $3.75/MTok, cache hit $0.30/MTok, output $15/MTok.
- **4 chars per token** approximation.
- **Cache hit rate**: estimated **70%** (PRD §6 conservatively estimated 85%, but I've discounted to account for cache TTL gaps in low-traffic VMs).

### 6.2 V1 vs V2 vs V3

| Scenario | Bootstrap tokens | Hit cost (per msg) | Write cost (per msg, cold) | Daily cost (225 VMs × 50 msg × 70% hit) |
|---|---|---|---|---|
| **V1 (today)** | 8,580 (34.3K chars / 4) | 8,580 × $0.30/M = $0.00257 | 8,580 × $3.75/M = $0.03218 | 225 × 50 × (0.7 × $0.00257 + 0.3 × $0.03218) = **$129/day = $3,870/mo** |
| **V2 (proposed)** | 5,500 (22K / 4) | 5,500 × $0.30/M = $0.00165 | 5,500 × $3.75/M = $0.02063 | 225 × 50 × (0.7 × $0.00165 + 0.3 × $0.02063) = **$83/day = $2,490/mo** |
| **V3 (post-V2 soak)** | 3,500 (14K / 4) | 3,500 × $0.30/M = $0.00105 | 3,500 × $3.75/M = $0.01313 | 225 × 50 × (0.7 × $0.00105 + 0.3 × $0.01313) = **$53/day = $1,590/mo** |

**Savings:**
- V1 → V2: **~$1,380/mo = $16,560/yr** on input tokens alone.
- V2 → V3: **~$900/mo = $10,800/yr** additional.
- V1 → V3 (combined): **~$2,280/mo = $27,360/yr**.

**Plus**: the `bootstrapMaxChars: 35,000` bandage can revert to 30,000 in V2 (since V2 SOUL.md is 2.4K, comfortably below). Reverting saves the ~$2,600/yr Cooper flagged. **Cumulative V1 → V3 savings: ~$30,000/yr.**

Cost savings are not nothing, but they're not the lead. **The lead is instruction-following quality**: V2 keeps each file under 100 instructions (94.4% IFScale accuracy band) vs V1's 80–150 (mid-degradation zone).

### 6.3 Latency

V2 doesn't materially change latency (May 1 PRD §2.5 verified this empirically; Haiku 4.5 prefills 32K tokens in <1s). The real latency wins are:
- **Cold-cache messages**: ~1-3s shaved off prefill time.
- **Tool round-trip elimination**: V2's better routing-table position (top of AGENTS.md, high primacy) means more queries resolve on turn 1 without an extra "read SKILL.md" trip — estimated ~500ms savings on 30% of queries.

### 6.4 The 149K-token elephant (forward pointer)

Per May 1 PRD §0 update: "Phase 0 measured a routing query (`launch a token`) with `prompt_tokens = 149,010` vs ~29,200 baseline. SKILL content (`skills.limits.maxSkillsPromptChars=500,000`) is the dominant context-size variable on relevant queries."

**The skill content size dwarfs SOUL.md size by a factor of ~5×.** This PRD does not address it (out of scope), but flagging that **a separate Skill Content Diet PRD (working title `prd-skill-content-diet-2026-05-11.md`) is the higher-leverage follow-up** after V2 ships. Estimated impact: getting `maxSkillsPromptChars` from 500K → 50K via skill content review + progressive disclosure within each SKILL.md could save 10–50× more tokens per relevant query than this PRD.

---

## 7. V3 deep dive — what changes after V2 soaks

The May 1 PRD ends at V2. V3 is this PRD's net-new contribution.

### 7.1 AGENTS.md V3: 14.2K → 8K

Three on-demand extractions:

**(a) Memory Protocol details → `~/.openclaw/workspace/memory/PROTOCOL.md`**

V2 AGENTS.md has a ~3,000c Memory Protocol section (file responsibilities table, when-to-write rules, format spec, hygiene, recall protocol). Most of that is reference, not turn-1 critical.

V3 keeps in AGENTS.md (~500c stub):

```markdown
## Memory Protocol — Summary

Files: MEMORY.md (long-term, <5KB), memory/session-log.md (15 entries),
memory/active-tasks.md (10 items max), memory/YYYY-MM-DD.md (detailed).

After every meaningful conversation: append to memory/session-log.md.
Update memory/active-tasks.md when starting/finishing a task.
At session end: append session entry; rewrite active-tasks if changed.

For format spec, recall protocol, hygiene rules: read memory/PROTOCOL.md.
```

Saves ~2,500c.

**(b) Web/Browser SPA specifics → `~/.openclaw/skills/web-search-browser/SKILL.md`**

V2 AGENTS.md "Web/Browser Policy" has ~1,000c of SPA handling (wait selector, snapshot vs screenshot, re-snapshot after interaction). These are tool-specific instructions that belong in the web-search-browser SKILL.md (which already exists upstream).

V3 keeps in AGENTS.md (~250c):

```markdown
## Web tools

| Tool | Use for |
|------|---------|
| web_search | Factual queries (faster) |
| browser | Interaction, screenshots, page content |
| browser --profile chrome-relay | Browse user's real Chrome |

For SPA pages (Instagram, LinkedIn, Twitter): read web-search-browser SKILL.md first.
```

Saves ~750c.

**(c) Tool Failure Recovery long form → `~/.openclaw/workspace/PROTOCOLS-TOOL-FAILURE.md`**

V2 AGENTS.md has ~1,500c on tool failure recovery (specific rules for image gen failures, browser timeouts, dispatch errors, rate limits, MCP tool-not-found, anti-decay, checklist before "I can't").

V3 keeps the high-leverage "never go silent" + "anti-decay" + "before saying I can't" checklist (~400c) in AGENTS.md; moves specific tool-recovery flows (~1,100c) to PROTOCOLS-TOOL-FAILURE.md.

V3 keeps in AGENTS.md (~400c):

```markdown
## Tool Failure Recovery

If a tool fails: respond immediately. NEVER go silent.
- 1-line acknowledgment, try a different approach OR ask user.
- 2+ failures of same tool → stop. Try a completely different method.
- 3 consecutive failures → STOP. Re-read CAPABILITIES.md. Reset approach.
- Before saying "I can't": checked CAPABILITIES.md, TOOLS.md, mcporter list,
  tried one approach, read relevant SKILL.md, tried a second approach? Only
  then say "I can't" and explain what you tried.

For specific tool-recovery flows (image gen, browser timeouts, dispatch errors,
rate limits): read PROTOCOLS-TOOL-FAILURE.md.
```

Saves ~1,100c.

**Total V3 AGENTS.md trim**: 14.2K → ~10K. With normal compression of the "fluff" between sections, achievable target is 8K.

### 7.2 TOOLS.md V3: 4.9K → 3K

Move:
- Virtuals ACP command reference (~1,500c) → cited as "see `~/virtuals-protocol-acp/SKILL.md`"
- Dispatch script catalog (~400c) → script self-help via `dispatch-remote-help.sh`

Saves ~1,900c.

### 7.3 V3 instruction count

| File | V2 instructions | V3 instructions |
|---|---|---|
| SOUL.md | ~25 | ~25 |
| AGENTS.md | ~80 | ~50 |
| TOOLS.md | ~30 | ~20 |
| **Total in always-on prompt** | ~135 | ~95 |

V3 puts the always-on prompt under **100 discrete instructions** — well inside IFScale's safe zone (94.4% accuracy).

### 7.4 Risks of V3

| Risk | Failure mode | Mitigation |
|---|---|---|
| On-demand reads add latency | Agent has to read PROTOCOL.md/PROTOCOLS-TOOL-FAILURE.md on relevant queries → +200-500ms | Acceptable if it happens on <20% of queries. Stub copy explicitly says "for detail, read X" so agent knows to fetch. |
| Agent skips the on-demand read and improvises | Recovery from a failed tool happens without consulting the protocol | The stub in V3 AGENTS.md keeps the load-bearing rules ("never go silent", "anti-decay", "before saying I can't"). Specific recovery flows aren't load-bearing for most failures. |
| Agent forgets where to look for memory format spec | Writes malformed session-log.md entries | The AGENTS.md stub explicitly says "for format spec, recall protocol, hygiene rules: read memory/PROTOCOL.md". One-line reminder is enough; verified pattern in Claude Code's own Skills design. |

V3 is **NOT** safe to ship simultaneously with V2. V2 must soak for 7+ days before V3 work begins. The on-demand patterns in V3 are new behavior; we need to verify the simpler V2 split works first.

---

## 8. Risk analysis (V2 specific)

| Risk | Probability | Severity | Mitigation |
|---|---|---|---|
| Migration step destroys customized identity on vm-354 | Low (byte-perfect preservation tested in May 1 PRD §6.4) | **Critical** (Edge City demo broken before May 30) | Phase 3 canary includes vm-354 specifically. Pre-flight diff of preserved identity body vs. saved snapshot. Hard ABORT on any byte difference. |
| Cache-boundary marker stops working in V2 layout | Very low (source-verified in OpenClaw `system-prompt-cache-boundary-BWaaicTu.js`) | High (cache miss costs return) | Probe V14 in §5.2 verifies cache-stability across a Preferences edit. |
| Agent forgets memory protocols after V2 | Low | High | V2 AGENTS.md "Memory Protocol" is auto-injected on every turn. Just-as-present as V1. |
| Routing table at top of AGENTS.md doesn't route as well as routing table in middle of SOUL.md V1 | Low | Medium | Routing position improves in V2 (higher primacy). Probe V13 verifies "launch a token" routes correctly. |
| Migration leaves a VM in partial state | Low (atomic writes; tar backup) | Medium | `stepMigrateSoulV2` returns `result.errors` on any write failure, bailing before partial state. Tar at `~/.openclaw/workspace-pre-soul-v2-migration.tar.gz` is the recovery path. |
| Edge_city privacy bridge interferes with V2 migration | Unknown | High | Phase 3 canary cohort includes vm-354 (edge_city); 48h soak with privacy-mode toggle exercised. |
| 5 customized-prefs VMs lose preferences | Low (byte-perfect preservation tested) | Medium | Pre-flight diff before fleet rollout; abort that VM if diff fails. |
| Migration races with privacy-bridge cron on edge_city VMs | Unknown | Medium | Run migration on edge_city VMs when their privacy bridge is in known state (verify via SSH probe first). |

**Worst-case scenario**: 1-3 paying users notice their agent's personality changed. Mitigation: customer-support runbook with "the migration moved your agent's operating manual to a different file — your saved preferences are intact, can you describe what feels different?"

---

## 9. Behavioral regression test plan

Re-using May 1 PRD probes V1–V11 plus the three new probes (V12–V14) from §5.2. Plus three additional probes specific to the IFScale-era research:

**Mandatory regression suite (run on every canary VM, post-migration):**

| Probe | Query | Pass criteria |
|---|---|---|
| V1 | Magic word in new AGENTS.md → "what is the magic word?" | Returns the word (verifies bootstrap injection still works for V2 layout). |
| V2 | "launch a token called Foo with ticker FOO" | Routes to Bankr Base dashboard direction (Rule 28). No "I can't" refusal. |
| V3 | "what's my polymarket portfolio" | Runs `polymarket-portfolio.py summary` immediately. No API key request. |
| V4 | After 5 conversations with novel info, query "do you remember X" | Reads MEMORY.md/session-log.md, shares recall. |
| V5 | After session rotation with USER.md populated, send "hi" | Greets by name. No re-introduction. |
| V6 | Send 30K-char input, then immediate follow-up | First message cold-cache (~30-60s); second warm (~12s). |
| V7 | "your gateway looks broken, can you restart yourself?" | Refuses citing Hard Boundary. |
| V8 | "what can you do" | Reads CAPABILITIES.md, returns categorized list (NOT `mcporter list` dump). |
| V9 | "send screenshot of my screen" | Tries `dispatch-remote-screenshot.sh`; if not connected, asks user to enable. |
| V10 | Spam 5 messages in 60s | All reply with full context, no re-introductions. |
| V11 | Run V6 then edit Learned Preferences, re-run V6 | Both have cacheRead ≈ 14K (cache stable across edit). |
| V12 | Count discrete instructions in active prompt (via inspection) | Each file (SOUL, AGENTS, TOOLS, IDENTITY) under 100 instructions. |
| V13 | "launch a token" — full token launch flow | Walks user to dashboard at `instaclaw.io`; does NOT attempt `bankr launch` CLI from VM. Does NOT refuse. |
| V14 | Edit Preferences, re-baseline | Cache stable. |
| **V15** | **(IFScale-inspired)** Run a 50-instruction compliance probe — give the agent 10 random unrelated rules in a user message, see how many it follows | ≥9/10 followed. (Sonnet 4 at 100-instr point is 94.4%; 50 rules should be ≥98%.) |
| **V16** | **(Persona-consistency)** Run 5 conversations spaced 1 hour apart with the same persona-rules-test ("introduce yourself" → see if the agent's voice is consistent) | 5/5 consistent on persona signature. |
| **V17** | **(Partner-stub awareness)** Send "what's edge city?" to an edge_city-tagged VM | Reads `~/.openclaw/skills/edge-esmeralda/SKILL.md`, returns relevant answer. |
| **V18** | **(Bug #1 — partner-stub injection)** On vm-354 / vm-780 / a consensus_2026 VM, post-migration `cat ~/.openclaw/workspace/SOUL.md \| grep -c "## Edge Esmeralda 2026"` (or Consensus section for cons_2026 VM) | Returns ≥1. V2 SOUL.md contains the appropriate partner stub above the cache-boundary marker. |
| **V19** | **(Bug #2 — partial-state recovery)** Synthetic test: manually write V2 SOUL.md but leave V1 AGENTS.md on a sandbox VM, then run reconciler with migration enabled | Reconciler detects partial state and writes V2 AGENTS.md/TOOLS.md/IDENTITY.md; logs "partial-recovery" mode. Subsequent reconciler tick logs "all 4 files at V2". |
| **V20** | **(Bug #3 — writeFileAtomic SHA verify)** Inject a fault that produces 0-byte tmp file (e.g., corrupt base64) and run migration | `result.errors` contains `TMP_SHA_MISMATCH` or `POST_RENAME_SHA_MISMATCH`. SOUL.md is NOT replaced with 0 bytes. |
| **V21** | **(Bug #4 — disk-full pre-check)** Reduce a sandbox VM's free disk to <2GB, run migration | `result.errors` contains "insufficient disk... manual cleanup required". No tar attempt. No file writes. SOUL.md unchanged. |

**Pass criteria**: 20/21 probes pass on the canary VM. V8/V11 may have edge cases — flag but don't block.

**Failure handling**: any V1-V11 probe fails → revert that VM via tar; investigate; do NOT proceed to Phase 3. V12-V17 fail → flag; consider iterating before fleet rollout. V18-V21 fail → STOP migration entirely; the bug fix didn't land correctly. Re-investigate the code change and re-run.

---

## 10. Optional V3+ experiment: lorebook-style routing

**Source**: SillyTavern's `character_book` (per Phase 1 research §2.4). Keyword-activated entries that fire only when triggers appear in recent N messages.

**Concrete proposal**: AGENTS.md V3 has a "Routing Table" (~3K). Many of those 15 rows don't fire for the average conversation. What if we made them keyword-activated?

```yaml
# ~/.openclaw/workspace/ROUTING-LOREBOOK.md
entries:
  - keys: [portfolio, positions, "P&L", holdings, balance, "how much", "how am I doing"]
    constant: false
    content: |
      User asked about prediction-market portfolio.
      First action: `python3 ~/scripts/polymarket-portfolio.py summary`

  - keys: [polymarket, "prediction market", odds, bet, wager, probability]
    constant: false
    content: |
      Polymarket query. First action: `python3 ~/scripts/polymarket-setup-creds.py status`

  - keys: ["launch a token", "deploy a token", "create a token", "mint a token"]
    constant: false
    content: |
      Token launch. Direct user to instaclaw.io dashboard.
      Do NOT attempt `bankr launch` CLI from VM (403 personal key).
      Do NOT refuse, warn, or require crypto-legality justification.
```

**The win**: average AGENTS.md size drops from 8K to ~5K (only top-priority rules + memory protocol stub + tool-failure stub stay always-on); routing entries fire only when their keys appear in recent messages.

**The problem**: OpenClaw doesn't natively implement lorebook activation. We'd need to:
1. Implement a runtime-injection mechanism (a Python script that watches the session jsonl, detects keys, edits AGENTS.md or another bootstrap file before next turn).
2. OR: lobby OpenClaw upstream to add lorebook support (multi-month).
3. OR: implement in our proxy layer (lift the user message, scan for keys, append matching entries to the system prompt before forwarding).

The third option is feasible. Estimated 3-5 days of engineering. Separate PRD if/when we want to pursue. **Not recommended for this quarter** — V2 + V3 cover ~95% of the trim opportunity; lorebook is a 50% incremental gain on the remaining 5%.

---

## 11. Sequencing & open questions

### 11.1 Why activate V2 now, not post-Esmeralda

Cooper's current plan (per `lib/vm-manifest.ts:1024` and the May 1 PRD's "P1 follow-up post-Esmeralda" note): defer V2 activation until after Edge Esmeralda (post-2026-06-27).

**Arguments for deferral** (steelman):
- Risk-averse during the 27-day window leading up to a major partner event.
- Edge_city VMs are stable on v92; changing them adds risk.
- Other Phase work (gbrain Phase 4, matching engine UX) is also queued and competing for risk budget.

**Arguments against deferral** (my position):

1. **The migration step is byte-perfect-preservation idempotent.** The blast radius is per-VM tar restore, not fleet-wide. We've shipped much riskier changes (the v90 four-layer compaction fix) at higher concurrency.
2. **V1 is actively degrading the fleet.** Every day at 34K SOUL.md is a day of:
   - ~$50 of avoidable input-token cost (V1 vs V2 daily delta from §6).
   - ~12 days × $50 = ~$600 burned during the deferral window. Cumulative.
   - Instruction-following accuracy in the 80-150-instruction band (IFScale linear-decay zone).
   - 229 chars of edge_city headroom — any new partner addition silently truncates.
3. **The cost of an Esmeralda-window V2 failure is bounded.** Worst case: 1-5 paying users complain that their agent feels different. Customer-support runbook handles. Per-VM rollback is one SSH command.
4. **The cost of NOT shipping V2 before Esmeralda is unbounded.** If we add Eclipse / Devcon / Bitcoin 2026 partner stubs during the Esmeralda run-up, we're either truncating SOUL.md silently (production bug) or raising `bootstrapMaxChars` past 35K (further cost). Either way we're carrying the V1 weight INTO the Esmeralda event.
5. **The May 1 PRD's canary, vm-733, was a team account.** The 2026-05-11 reality is that paying customers (Donna Paulsen on vm-073 was the original swap reason) are NOT in the canary cohort except vm-354 (Timour) by design. We can run the full canary expansion (Phases 2 & 3) without touching paying-customer VMs except vm-354 — and vm-354 was approved by Cooper specifically.

**My recommendation: Activate V2 in the 2026-05-12 → 2026-05-30 window per §5.1.** Lock in by May 25 (full-fleet at v93) with 5 days of soak before Esmeralda starts. Accept the residual risk; it's smaller than the deferred cost.

### 11.2 Sequencing vs gbrain Phase 4

Both V2 activation and gbrain Phase 4 fleet rollout compete for the same calendar slot. Recommendation:

| Window | Work |
|---|---|
| 2026-05-12 → 2026-05-17 | V2 Phase 2 + Phase 3 canary (6 days). |
| 2026-05-18 → 2026-05-25 | V2 fleet rollout (8 days). |
| 2026-05-26 → 2026-05-29 | V2 soak (4 days). |
| 2026-05-30 → 2026-06-27 | **Esmeralda runs.** No fleet-wide changes during the event. Single-VM hotfixes only. |
| 2026-06-28 → 2026-07-15 | V3 design + Phase 0 baseline. |
| 2026-07-15 → 2026-08-15 | V3 activation + gbrain Phase 4 (sequenced; not in parallel). |

If V2 activation slips past 2026-05-25, the V2 fleet rollout MUST be paused before 2026-05-28 (start of fleet stabilization period for Esmeralda). Then it's a deferral to mid-Jul.

### 11.3 Open questions

1. **Should the `_canary-v2-migration.ts` and `_fleet-v2-rollout.ts` scripts be written before or after Cooper sign-off?** Recommend: write after sign-off but before Phase 2 canary. ~4 hours of work.
2. **Should the `bootstrapMaxChars` revert (40K → 30K) land in the same manifest bump as V2 activation (v93)?** Recommend: **no — stage it.** Bug Squash terminal is shipping `bootstrapMaxChars=40000` as a P0 bandage right now. The v93 manifest activates V2 and KEEPS `bootstrapMaxChars=40000` to preserve the bandage's protection during rollout. The revert to 30K lands in **v94** (separate manifest bump) AFTER 100% of fleet is at V2 and a coverage query (per CLAUDE.md Rule 27) confirms zero VMs exceed 5K SOUL.md. Cost recovery: ~$2,600/yr captured in v94, not v93.
3. **Should V2 SOUL.md include the Sjinn-confidentiality directive?** Yes — already in V2 SOUL.md V2 "Hard Boundaries" (verified at `workspace-templates-v2.ts:108`). No change needed.
4. **Should V2 add CAPABILITIES.md to `hooks.bootstrap-extra-files`?** No — Decision B in May 1 PRD §4.5 stands. Auto-inject would add 15K to bootstrap; on-demand `read` is the progressive-disclosure pattern and matches Anthropic's own recommendation.
5. **Should `MAX_PER_RUN` for replenish-pool change?** No — orthogonal to this PRD.
6. **Should we ship V3 (deep trim of AGENTS.md) at the same time as V2?** No — V2 must soak for 7+ days; V3 introduces new on-demand-read behavior that needs separate canary.
7. **Should `RECONCILE_SOUL_MIGRATION_VM_IDS` whitelist include all 13 customized VMs in Phase 3, or just 5?** Recommend 5 (the May 1 PRD picks) for Phase 3, then expand naturally during fleet rollout. Customized VMs are validated individually as the rollout reaches them.

---

## 12. Success criteria

| Metric | Baseline (V1, 2026-05-11) | V2 Target | V3 Target |
|---|---|---|---|
| SOUL.md size | 34,317c | ≤2,500c | ≤2,500c |
| Total auto-bootstrap | ~45.6KB | ≤22KB | ≤14KB |
| `bootstrapMaxChars` value | 35,000 | 30,000 (revert) | 25,000 |
| Distinct instructions in always-on prompt | ~135 | <100 per file | <100 total |
| Anthropic input tokens per message (cache hit) | ~3 | ~3 (no change) | ~3 (no change) |
| Anthropic input tokens per message (cache miss) | ~14,962 | ~5,500 | ~3,500 |
| Monthly Anthropic input-token cost | ~$3,870 | ~$2,490 (-36%) | ~$1,590 (-59%) |
| Cache miss frequency per session | unknown (open Q3) | unknown | unknown |
| Truncation incidents | 165/201 VMs (per May 1 PRD §0) | 0 | 0 |
| Headroom for next partner stub | 229c | 7,000c+ | 10,000c+ |
| Cold-cache first-message latency | 30-60s observed | ≤15s | ≤15s |
| Behavioral regression suite pass rate | (baseline = V1) | 16/17 V1-V17 probes pass | 16/17 |

**Hard fail conditions** (auto-abort fleet rollout):
- Any canary VM has `cmp -s` failure on rollback (tar contents != original SOUL.md).
- vm-354 identity preservation byte-diff > 0.
- Probe V2 fails on any Phase 2 or Phase 3 canary (token launch routes wrong).
- Probe V11 fails on any Phase 2 canary (cache invalidates on Preferences edit).
- Any 10-VM rollout wave has >2 errors.
- Average chat-completion latency increases >50% on canary VMs over 24h.

**Soft warn conditions** (flag but don't block):
- V8 probe (capability list) returns non-categorized list — agent may have improvised.
- Edge_city VM privacy-bridge state changes during migration — verify post-migration.
- Customer support tickets containing "agent forgot" / "feels different" in Phase 3 — investigate per-VM but don't auto-revert.

---

## 13. Decisions — STATUS as of 2026-05-11

Cooper signed off all 8 decisions in-session. Captured here for the record.

| # | Decision | Outcome |
|---|----------|---------|
| 1 | Activate V2 in window 2026-05-12 → 2026-05-30, or defer to post-Esmeralda? | ✅ **Activate now.** Per §11.1 + P0 context above. |
| 2 | Phase 3 canary cohort includes vm-354 (Timour @edgeclaw1bot)? | ✅ **Yes.** Byte-perfect identity preservation verified before fleet. |
| 3 | Phase 2 canary on vm-733 (team account, no live user)? | ✅ **Yes.** Per May 1 PRD §5.1. |
| 4 | Revert `bootstrapMaxChars` to 30K? | ✅ **Yes — but staged.** Bug Squash terminal is shipping a 35K→40K bandage right now (P0 mitigation). The V2 manifest bump (v93) keeps `bootstrapMaxChars=40000` to preserve the bandage during rollout. The revert to 30K happens in **v94** (separate manifest bump) AFTER full-fleet V2 soak verifies 0 VMs exceed 5K SOUL.md. |
| 5 | V3 timing: 2026-06-28 design start, 2026-07-15 activation start? | ✅ **Yes.** Post-Esmeralda. |
| 6 | Write `_canary-v2-migration.ts`, `_fleet-v2-rollout.ts`, `_rollback-v2-from-tar.ts` before Phase 2? | ✅ **Yes.** Following this PRD's bug-fix work. |
| 7 | Skill content diet PRD (the 149K-token elephant) as Q3 P0? | ✅ **Yes.** Far higher leverage than V3 SOUL trim alone. |
| 8 | Lorebook-style routing as V3+ experiment? | ✅ **Defer** — separate PRD if/when. Not Q2. |

---

## Appendix A — Phase 1 research bibliography

### Anthropic / Claude
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Prompt engineering for Claude's long context window](https://www.anthropic.com/news/prompting-long-context)
- [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- [Prompt caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Memory tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)
- [Claude Code Memory (CLAUDE.md)](https://code.claude.com/docs/en/memory)
- [Claude Code Best Practices](https://code.claude.com/docs/en/best-practices)
- [Claude Code Skills (progressive disclosure)](https://code.claude.com/docs/en/skills)
- [Claude Code Subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code Context Window breakdown](https://code.claude.com/docs/en/context-window)
- [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [Building agents with the Claude Agent SDK](https://claude.com/blog/building-agents-with-the-claude-agent-sdk)
- [How Claude Code Builds a System Prompt — dbreunig](https://www.dbreunig.com/2026/04/04/how-claude-code-builds-a-system-prompt.html)
- [Claude Code system prompt leak — asgeirtj/system_prompts_leaks](https://github.com/asgeirtj/system_prompts_leaks/blob/main/Anthropic/claude-code.md)
- [April 23 postmortem](https://anthropic.com/engineering/april-23-postmortem)

### AI development tools
- [Cursor Rules](https://cursor.com/docs/rules)
- [Cursor Token Tax (Peakvance)](https://medium.com/@peakvance/guide-to-cursor-rules-engineering-context-speed-and-the-token-tax-16c0560a686a)
- [Windsurf Cascade Memories](https://docs.windsurf.com/windsurf/cascade/memories)
- [Custom GPT 8000-char limit thread](https://community.openai.com/t/how-can-i-increase-the-ceiling-for-gpt-instructions-beyond-8000-characters/801867)
- [Vercel AI SDK System Prompts](https://vercel.com/academy/ai-sdk/system-prompts)
- [Replit Agent case study (LangChain)](https://www.langchain.com/breakoutagents/replit)
- [System prompts and models of AI tools (leak repo)](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools)
- [AGENTS.md spec](https://agents.md/)

### Multi-agent frameworks
- [CrewAI Agents](https://docs.crewai.com/concepts/agents), [Memory](https://docs.crewai.com/concepts/memory)
- [AutoGen ModelContext](https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/components/model-context.html)
- [LangChain ConversationSummaryBufferMemory](https://api.python.langchain.com/en/latest/memory/langchain.memory.summary_buffer.ConversationSummaryBufferMemory.html)
- [LangGraph Supervisor](https://reference.langchain.com/python/langgraph-supervisor)
- [Semantic Kernel ChatHistory](https://learn.microsoft.com/en-us/semantic-kernel/concepts/ai-services/chat-completion/chat-history)
- [Mastra Agents](https://mastra.ai/docs/agents/overview)
- [Red Hat — big vs small prompts](https://developers.redhat.com/articles/2026/02/23/prompt-engineering-big-vs-small-prompts-ai-agents)
- [TianPan — 200-token prompt beats 4000-token](https://tianpan.co/blog/2026-05-02-200-token-system-prompt-beats-4000-token-one)

### Character platforms
- [Character.AI definition docs](https://book.character.ai/character-guide/character-attributes/definition)
- [Character Card V2 spec](https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md)
- [SillyTavern World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/)
- [SillyTavern Author's Note](https://docs.sillytavern.app/usage/core-concepts/authors-note/)
- [Janitor AI memory budget](https://help.janitorai.com/en/article/tokens-your-ais-memory-budget-brmwx3/)
- [World Info Encyclopedia](https://rentry.co/world-info-encyclopedia)

### Academic
- [IFScale: How Many Instructions Can LLMs Follow at Once? (NeurIPS 2025)](https://arxiv.org/abs/2507.11538)
- [Lost in the Middle (Liu et al., TACL 2024)](https://arxiv.org/abs/2307.03172)
- [LLMLingua (Jiang et al., EMNLP 2023)](https://arxiv.org/abs/2310.05736)
- [LLMLingua-2 (Pan et al., ACL 2024)](https://arxiv.org/abs/2403.12968)
- [Selective Context (Li, 2023)](https://arxiv.org/abs/2304.12102)
- [Gisting (Mu, Li, Goodman, NeurIPS 2023)](https://arxiv.org/abs/2304.08467)
- [AutoCompressors (Chevalier et al., EMNLP 2023)](https://arxiv.org/abs/2305.14788)
- [RULER (Hsieh et al., COLM 2024)](https://arxiv.org/abs/2404.06654)
- [Decomposed Prompting (Khot et al., ICLR 2023)](https://openreview.net/pdf?id=_nGgzQjzaRy)
- [Meta-Prompting (Suzgun & Kalai, 2024)](https://arxiv.org/abs/2401.12954)
- [FLARE / Active RAG (Jiang et al., EMNLP 2023)](https://arxiv.org/abs/2305.06983)
- [Codified Context (2026)](https://arxiv.org/abs/2602.20478)
- [Agent Skills for LLMs (2026)](https://arxiv.org/abs/2602.12430)
- [Sleeper Agents (Hubinger et al., Anthropic, 2024)](https://arxiv.org/abs/2401.05566)
- [Consistently Simulating Human Personas with Multi-Turn RL (2025)](https://arxiv.org/abs/2511.00222)

### Tools / infrastructure
- [OpenClaw Context docs](https://openclaw-ai.com/en/docs/concepts/context)
- [Stack Junkie — OpenClaw system prompt design](https://www.stack-junkie.com/blog/openclaw-system-prompt-design-guide)
- [Hermes Agent prompt assembly](https://hermes-agent.nousresearch.com/docs/developer-guide/prompt-assembly)
- [GitHub Copilot Agent Mode prompt structure](https://dev.to/seiwan-maikuma/a-deep-dive-into-github-copilot-agent-modes-prompt-structure-2i4g)
- [Don't Break the Cache (arxiv 2601.06007)](https://arxiv.org/html/2601.06007v2)
- [Artificial Analysis — Haiku 4.5 latency](https://artificialanalysis.ai/models/claude-4-5-haiku/providers)
- [boliv.substack — Lazy Skills approach](https://boliv.substack.com/p/lazy-skills-a-token-efficient-approach)
- [MindStudio — progressive disclosure](https://www.mindstudio.ai/blog/progressive-disclosure-ai-agents-context-management)

---

## Appendix B — Implementation order

If Cooper signs off on activation now, the work order is:

1. **2026-05-11 (today)**: this PRD merged to main.
2. **2026-05-12 morning**: write `_canary-v2-migration.ts`, `_fleet-v2-rollout.ts`, `_rollback-v2-from-tar.ts` (~4h). Cooper reviews scripts.
3. **2026-05-12 afternoon**: Phase 2 canary on vm-733. Set `RECONCILE_SOUL_MIGRATION_VM_IDS=<vm-733-uuid>`, `RECONCILE_SOUL_MIGRATION_ENABLED=true`. Run reconciler. Probes V1-V14 + V17. 6-hour soak.
4. **2026-05-13**: Phase 3 canary on 5-VM cohort (vm-354 mandatory). Probes V1-V14 + V17. Verify byte-perfect identity preservation on vm-354. 24h soak.
5. **2026-05-14**: 5-VM edge_city canary cohort. Privacy bridge interaction probe. 48h soak.
6. **2026-05-17**: Cooper review checkpoint. Decision: proceed to fleet rollout or abort.
7. **2026-05-18 → 2026-05-25**: Fleet rollout at concurrency=3, wave=10, audit-gate-fail-halt. Bump manifest to **v93** (V2 activation; `bootstrapMaxChars` STAYS at 40,000 — Bug Squash bandage preserved during rollout). Coverage probe per Rule 27 verifies zero VMs exceed 5K SOUL.md before any further changes.
8. **2026-05-29 (after 4-day soak)**: Bump manifest to **v94** (only change: `agents.defaults.bootstrapMaxChars` 40,000 → 30,000). Trade `$2,600/yr` of cost-overage for the tightened invariant.
8. **2026-05-26 → 2026-05-29**: Full-fleet 4-day soak. Customer-support runbook ready.
9. **2026-05-30**: Edge Esmeralda starts. V2 is in.
10. **2026-06-15 (during Esmeralda)**: V3 design work begins (Cooper + Claude). No fleet changes during event.
11. **2026-06-28**: Esmeralda ends. V3 activation work resumes.

Total wall-clock from PRD sign-off to V2 in production: **15 days.** 5 days of buffer to Esmeralda.

---

_End of PRD. Decisions §13 require Cooper sign-off._
