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

## §14. Agent Self-Compaction Architecture (V3+ roadmap)

> **Status:** Design research. Does NOT ship before Esmeralda. V3.5 work begins post-Esmeralda (2026-07-15+). Captured here to lock in the thinking while the May 11 fire-drill context is fresh.
>
> **The frame:** V2 fixes platform-managed SOUL.md bloat. It does NOT fix agent-managed bloat in MEMORY.md, memory/session-log.md, Learned Preferences, and the long-tail accumulation of facts about the user. Without an autonomous compaction layer, our agents are still one heavy session away from the same death spiral — except this time the trigger is the user's own conversation, not a manifest push.
>
> **The north star:** the user NEVER manages this. Not "agent suggests, user approves." Not "user triggers cleanup." The agent (or a system on its behalf) detects bloat, decides what to compact/move/archive, does it, verifies nothing broke, and the user never knows it happened. Their experience is "my agent keeps getting smarter and never slows down."

### 14.0 Why this matters more than it seems

Today's P0 cost ~46 paying-customer VMs ~6 hours of degraded service plus immeasurable trust damage. The proximate cause was a 600-char manifest push past the 35K cap. The deeper cause is the same one that will bite us next quarter: **any growing context file, regardless of who's writing to it, eventually pushes past a budget and breaks the agent.**

The class-of-bug enumeration:

| Source of growth | Today | Without V3+ compaction |
|---|---|---|
| **Manifest pushes** (platform-managed) | Caused today's P0 | V2 fixes this for SOUL.md |
| **Learned Preferences** (agent-edits) | Cache-stable below boundary; size unbounded | Will hit prompt budget eventually |
| **MEMORY.md** (agent-edits) | Soft 5KB cap, no enforcement; auto-injected on every turn | Same class of failure as today, different file |
| **memory/session-log.md** | 15-entry cap, ~3-5 sentences each; agent self-enforces | Agent compliance varies; rotting older entries take prompt budget |
| **memory/active-tasks.md** | 10-item cap, agent self-enforces | Same as above |
| **memory/YYYY-MM-DD.md** | Detail file, read on demand | Disk growth, slow loads on `grep -r memory/` |
| **USER.md** | Agent-learned facts, no cap | Same class as MEMORY.md |
| **TOOLS.md "Your Notes" section** | Agent-editable, no cap | Same |
| **Skills installation** | Per-skill `~/.openclaw/skills/<name>/SKILL.md` | Cumulative install bloat (the 149K-token elephant from PRD §6.4) |

The V1-V2 trim addresses the first row only. Every other row is still capable of producing the same death spiral once SOUL.md is no longer the bottleneck.

**The trust asymmetry that drives this design.** Across the 5 research streams (R1–R5 below), the same failure-cost asymmetry recurs:

| Failure mode | User signal | Time-to-churn |
|---|---|---|
| **Dropped specific fact** ("forgot I'm vegetarian") | Immediate complaint | Tolerated 2-3× then churns |
| **Personality drift to generic** | Silent disappointment | Churns over weeks, never tells you why |
| **Fabricated/invented memory** | Trust-shattering | Immediate, never returns |

The third failure mode (memory poisoning, per CLAUDE.md Rule 29) is the deadliest. Autonomous compaction MUST be designed to minimize fabrication risk first, drop-risk second, and accept some performance overhead third. **"Forget" is forgivable; "make up false memories" is not.** This drives every constraint in §14.6.

### 14.1 Research synthesis (5 streams)

Ran 5 parallel research agents (R1-R5 in TaskList). Per-stream key findings:

#### R1 — What Claude Code does (the dogfood signal)

Claude Code's `/compact` is a **4-layer hierarchy** (verified via leak analyses at claudefa.st, codex.danielvaughan.com, dbreunig.com):

1. **Proactive summarization** before each API call when nearing context limit.
2. **Microcompaction** of older tool outputs (drops them first).
3. **Full conversation summarization** via LLM (the `compact_20260112` API primitive; default 150K trigger, min 50K, configurable per `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` env var).
4. **Error catch + retry** with compressed version on `prompt_too_long`.

**Critical observations for us:**
- `/compact` operates on **conversation history**, NOT on CLAUDE.md or MEMORY.md. CLAUDE.md is loaded fresh every session; the agent is expected to keep it small by sharding into topic files. **There is no auto-compaction of CLAUDE.md.** This is the same flaw we have today.
- Pre-compaction messages are **never deleted on disk** — append-only JSONL with summary appended after a boundary marker. Compaction is reversible at the storage layer via `--resume`/`--fork-session`.
- Skills survive compaction with explicit per-skill budgeting: **5K tokens/skill × 25K total, most-recent-first, drop oldest**. Skill descriptions (the index) do NOT survive — only invoked skills.
- The `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` cache-boundary marker splits static (cached) from dynamic (per-session). Compaction operates BELOW the boundary only.
- Community converges on **~60% threshold** as the right auto-compact trigger; the default ~95% is too late because model quality is already degraded past ~80%. ([GitHub Issue #41818](https://github.com/anthropics/claude-code/issues/41818))
- Source: [Claude Code Skills budgeting](https://code.claude.com/docs/en/skills), [Anthropic Compaction API](https://platform.claude.com/docs/en/build-with-claude/compaction), [How Claude Code Builds a System Prompt](https://www.dbreunig.com/2026/04/04/how-claude-code-builds-a-system-prompt.html).

**Takeaway for us:** Claude Code's MEMORY.md model is structurally identical to ours and **has the same flaw — silent truncation at load (200 lines / 25KB), agent expected to self-shard.** They get away with it because a human runs `/compact` manually. We can't rely on that. The "compact, never nuke" pattern (Anthropic's append-only JSONL) is universal and matches our Rule 22/30. The cache-boundary marker pattern is borrowed in V2 SOUL.md. The skill-budget pattern is directly portable to per-skill content limits in V3+.

#### R2 — Production framework patterns

| Framework | Tiering | Autonomy | Compaction style |
|---|---|---|---|
| **Letta / MemGPT** | Hot (core memory blocks) / Warm (recall) / Cold (archival vector DB) | **Fully agent-driven** via `memory_insert`, `core_memory_replace`, `archival_memory_search` function calls | Hard-cap on block size; agent rewrites on overflow |
| **Mastra Observational Memory** | Two-tier: Observer (30K trigger) + Reflector (40K trigger, merges Observer output) | Framework-managed but uses LLM agents internally | Two-pass LLM summarization with claim "a coding agent that never compacts" |
| **CrewAI** | Flat unified memory class; `composite_score = sim·w₁ + recency·decay + importance·w₂` | LLM-driven on every write | RAG-retrieval not eviction; nothing deleted |
| **LangChain LangMem** | Procedural + Semantic + Episodic split (cognitive-science inspired) | Agent-driven (LLM extractor) | `ConversationSummaryBufferMemory` deprecated; modern pattern is per-type extraction |
| **A-MEM** | Zettelkasten note-linking, single-tier | Agent-driven (LLM linker fires on every note) | Memory **evolution** — adding note can update existing notes' tags. No eviction in core paper |
| **Semantic Kernel** | Flat | Framework-managed (`auto_reduce` threshold) | `ChatHistoryReducer` (truncation OR summarization variants) |
| **Cline / Roo / Cursor** | Single-tier file-based | **Human-driven** ("update memory bank" command) | User-supervised by design |

**Letta is the cleanest tiered production reference.** Mastra's two-tier (Observer→Reflector) is the next-closest match for what we need. Both keep the originals when summarizing — neither does destructive deletion as the default.

**Cross-framework consensus:**
1. **Three-component memory split (episodic / semantic / procedural)** is the LangMem framing and matches cognitive science.
2. **Importance × recency × similarity** is the universal retrieval-scoring formula. Don't invent a new one.
3. **Trim/restructure, never delete the source** — every production framework except Cline's manual flow preserves originals somewhere.
4. **Agent-self-edits via tool calls** (Letta, A-MEM, LangMem, CrewAI) is the dominant autonomous pattern.
5. **Operator-side TTL pruning is non-negotiable at scale** ([LangGraph persistence docs](https://docs.langchain.com/oss/python/langgraph/persistence) — "always implement a pruning strategy before production"). This is our P1-6 lesson exactly.

Sources: [Letta memory docs](https://docs.letta.com/advanced/memory-management/), [MemGPT arxiv:2310.08560](https://arxiv.org/abs/2310.08560), [Mastra Observational Memory](https://mastra.ai/research/observational-memory), [CrewAI Memory](https://docs.crewai.com/en/concepts/memory), [LangMem](https://blog.langchain.com/langmem-sdk-launch/), [A-MEM arxiv:2502.12110](https://arxiv.org/abs/2502.12110).

#### R3 — Safety research (the load-bearing constraints)

This is the stream that most-shapes our design. Key findings:

- **Self-Correction Bench (Tsui 2025, [arxiv:2507.02778](https://arxiv.org/abs/2507.02778))**: 14 models tested, **average 64.5% self-correction blind-spot rate** — "LLMs systematically fail to correct their own errors while succeeding on identical external errors." **The editor CANNOT validate its own edits at acceptable reliability.** This is the load-bearing finding. Cross-model validation isn't optional; it's a structural requirement.

- **LLM-as-Judge self-preference bias ([arxiv:2503.05061](https://arxiv.org/abs/2503.05061))**: GPT-4o assigns scores ~10% higher to its own outputs; earlier Claude models showed ~25% self-preference. **Same-model judge favors same-model editor.** Must use different model family (or at minimum, different model size — Sonnet edits, Haiku critiques).

- **Sleeper Agents (Hubinger et al., 2024, [arxiv:2401.05566](https://arxiv.org/abs/2401.05566))**: "Backdoor behavior persists through standard safety training... persistence remaining even when the chain-of-thought is distilled away." **Distillation of agent behavior into shorter context does NOT reliably preserve safety properties AND does not reliably remove latent unsafe properties.** If a memory is hallucinated, the same-model compactor will tend to PRESERVE it because it doesn't recognize it as anomalous.

- **Agentic Context Engineering (ACE, [arxiv:2510.04618](https://arxiv.org/abs/2510.04618))**: Two failure modes — (1) **brevity bias** ("drops domain insights for concise summaries"), (2) **context collapse** ("iterative rewriting erodes details over time"). Solution: structured division of labor across Generator / Reflector / Curator with **incremental delta-updates** rather than rewrites.

- **Governing Evolving Memory in LLM Agents (SSGM, [arxiv:2603.11768](https://arxiv.org/abs/2603.11768))**: Three failure points — (1) Memory Poisoning during input ingestion, (2) Semantic Drift during consolidation updates, (3) Conflict/Hallucination during retrieval. Prescribes: **"consistency verification, temporal decay modeling, and dynamic access control prior to any memory consolidation."** Decouples memory evolution from execution.

- **(Im)possibility of Automated Hallucination Detection ([arxiv:2504.17004](https://arxiv.org/abs/2504.17004))**: Pure self-supervised hallucination detection has a known impossibility result. **You MUST inject external corroboration signals** (tool outputs, log lines, user messages).

- **Agent Drift quantification ([arxiv:2601.04170](https://arxiv.org/abs/2601.04170))**: "Semantic drift in nearly half of multi-agent LLM workflows by 600 interactions." Linear decline through 300 interactions, then accelerated degradation — "a critical threshold where accumulated drift begins self-reinforcing." Once drift exceeds threshold, the compactor itself is drifted.

- **Persona Drift (Choi et al., [arxiv:2412.00804](https://arxiv.org/abs/2412.00804) and Li et al. [arxiv:2402.10962](https://arxiv.org/abs/2402.10962))**: "Significant persona drift within eight rounds of conversations." A persona statement is necessary but not sufficient; need active reinforcement.

- **Refute-or-Promote (Cross-Model Critic, [arxiv:2604.19049](https://arxiv.org/abs/2604.19049))**: Adversarial stage-gated review. Different model family with minimal context performs independent critique. **Context Asymmetry reduces bias from prior discussions.**

- **Letta Context Repositories ([letta.com/blog/context-repositories](https://www.letta.com/blog/context-repositories))**: Git-backed memory — every edit is a commit, rollback is free.

- **Replika 2.0 incident (April 2026)**: 25M users; "memory regression breaks the relational continuity that was the whole reason they stayed." Specific user complaints: characters losing names, dropping inside jokes, asking things they should already know. **Versioned context per user with explicit rollback is mandatory; uniform compaction across the user base is worse than no compaction.**

The 12 hard safety constraints (from R3 synthesis) become §14.6.

#### R4 — Character platforms (the UX lessons)

Character platforms have been at this for ~5+ years longer than any agent framework. The community has converged on three principles ([roborhythms.com](https://www.roborhythms.com/), r/CharacterAI, r/Replika, r/SillyTavernAI synthesis):

1. **Anchor facts are inviolable.** Names, stated preferences, family-member names, occupation, explicitly-shared traumas/joys must survive every compaction pass. Compactors that summarize these into "the user shared personal details" are perceived as forgetting.

2. **Forgetting beats fabricating, always.** "I'd rather it forget than make up false memories" is the most-cited preference across all platforms.

3. **Personality texture is load-bearing — and slow to notice missing.** The "drift to generic" mode is the silent churn killer. Compactors must preserve *style markers* (catchphrases, speech rhythms, conversational quirks), not just facts.

Operational observations:
- **Every successful character platform has at least one user-visible control** (SillyTavern summarize, Janitor pin, Character.AI Chat Memories). Every fully-autonomous platform has produced user backlash.
- **Pin is the highest-trust primitive** — manual pinning outperforms automatic importance detection.
- **Per-conversation compaction MUST NOT mutate the shared persona layer** (SillyTavern's two-tier CharacterCard + ChatLorebook is the reference).

**Our adaptation:** since Cooper's north star is zero-human-in-loop, we don't have "user-visible control" as an option. We have to compensate with **stronger automation safety** (cross-model validation, regression testing, gbrain warm-tier preservation, explicit anchor-fact marking).

#### R5 — Memory tiering architectures

Hot/warm/cold tiering survey across MemGPT/Letta, A-MEM, Generative Agents, Voyager, ChatDev/MetaGPT, OS memory hierarchy analogies, data-warehouse tiering, vector DB eviction, hippocampal/neocortex biology, GraphRAG, and the episodic/semantic split.

**Most relevant findings:**

1. **MemGPT/Letta** is the canonical 3-tier reference. The agent decides movement between tiers via function calls. Hard-cap on core memory blocks forces summarization. **No production agent platform implements true deletion at the cold tier** — everything accumulates with TTL deferred or absent.

2. **Generative Agents reflection** ([arxiv:2304.03442](https://arxiv.org/abs/2304.03442)): trigger when sum of importance scores exceeds 150. Generates LLM-derived higher-level inferences written back into the memory stream with references to source memories. **Reflections ARE compaction — by abstraction, not by deletion.**

3. **Hippocampal/neocortex** (Princeton model, [PNAS:2123432119](https://www.pnas.org/doi/10.1073/pnas.2123432119)): fast write (episodic, hippocampus) → slow write (semantic, neocortex) via sleep replay. **Sharp-wave ripples during NREM sleep = the compaction pass.** Strong argument for a **scheduled offline compactor** that runs during user-idle windows.

4. **BeliefMem ([arxiv:2605.05583](https://arxiv.org/abs/2605.05583))** stores multiple candidate conclusions per observation with probabilities. **STALE ([arxiv:2605.06527](https://arxiv.org/abs/2605.06527))** tests whether agents can self-detect memory staleness — spoiler: poorly, without explicit metadata. **No production agent platform bakes provenance-confidence into compaction.** This is a real gap and a defensible InstaClaw design choice.

5. **Bi-temporal validity intervals** (Zep, [arxiv:2501.13956](https://arxiv.org/abs/2501.13956)): every semantic fact carries `valid_from` + `valid_until` (NULL = current). Updates don't overwrite; they close the old fact's interval and write a new one.

6. **Cold tier is "almost never delete"** in every system surveyed. Storage is cheap; regret is expensive.

### 14.2 The three paradigms — comparison & verdict

Cooper's question #8: which architecture is right for InstaClaw?

#### Paradigm (a) — Agent-self-managed (Claude Code adapted for zero-human-in-loop)

The agent notices bloat, decides what to compact, does it autonomously. Tool calls like `memory_compact_now()`, `memory_drop_stale()`, `memory_summarize_topic("X")`.

**Pros:**
- Contextually aware. The agent knows which memories were load-bearing for the current relationship, which were one-off.
- No infrastructure cost — compaction happens via existing model calls.
- Granular timing — fires the moment the agent senses an issue.

**Cons:**
- **Self-correction blind-spot (R3, 64.5% rate)** — the editor is the validator, and it's not reliable.
- Costs user-time tokens — every compaction during a conversation slows the response.
- The "agent decides when" criterion may not fire — agents tend not to introspect about their own context until something breaks.
- Personality drift compounds: a drifted agent compacts via its drifted self-model, accelerating drift (the SSGM and Agent Drift papers).
- Replika 2.0 failure mode — when one agent's compaction goes wrong, that user's experience is bad; uniform-across-users compaction is even worse.

**Where it works:** Letta's documented model. Works well when:
- The model is large and self-aware enough to make good decisions (Sonnet+, not Haiku).
- The compaction surface is narrow and structured (Letta blocks, not free-text MD).
- Failure cost is bounded (Letta has the recall tier as safety net).

**Why it fails for us:** Our agents run on Haiku 4.5 by default for the heartbeat path, sometimes Sonnet 4.6 for user conversations. The 64.5% blind-spot rate is a fleet-wide reliability problem at our scale (225+ VMs). The "decide on your own when" criterion is the load-bearing failure mode — we've seen Rule-29-style hallucinated diagnoses persist across sessions because the agent doesn't realize the diagnosis was wrong.

#### Paradigm (b) — Platform-level (Cron-driven, agent is passive)

A reconciler-level cron runs compaction on each VM. The agent doesn't participate in the decision. Uses LLM (via proxy) to summarize but the orchestration is platform code.

**Pros:**
- Predictable, auditable. Compaction runs on a schedule, logs are in our infrastructure.
- Runs during user-idle windows (no user-time token cost).
- Uniform across the fleet — can deploy a single algorithm with one PR.
- Operator can monitor: dashboard of "VMs with compaction in last 24h", "compaction error rate", etc.
- The platform can use cheaper models (Haiku) for compaction work, cheaper-per-token than Sonnet.

**Cons:**
- **Lacks contextual nuance.** The cron doesn't know which memories were personality-load-bearing vs incidental. The "Sarah is my wife" line and the "we discussed lunch on Tuesday" line look the same to a generic compactor.
- Replika 2.0's failure mode — uniform algorithm across 25M users dropped specific things differently across accounts.
- Hard to do "explain why" — the agent can't explain post-hoc to the user "I compacted these old conversations" because it wasn't involved.

**Where it works:** When the compaction surface is structured (database rows with provenance metadata, not free-text). Production examples: Snowflake/BigQuery time-based tiering, LangGraph checkpoint TTL pruning.

#### Paradigm (c) — Hybrid (platform identifies + agent reviews + platform executes)

The platform's offline cron runs candidate identification (importance scoring, dedup detection, age-out signals). The agent reviews candidates during a heartbeat session (already happening anyway, low marginal cost). The platform executes approved compactions with full safety net.

**Pros:**
- Combines context awareness (agent reviews) with safety (platform executes with versioning, regression testing).
- Agent's review is cheap because it happens during heartbeat, not during user conversation.
- Cross-model validation is natural — Sonnet (the conversational agent) reviews, Haiku (or vice-versa) critiques.
- Versioning + rollback at platform level — no per-agent burden.
- Compaction is observable from operator side; debuggable.

**Cons:**
- **Most complex of the three.** More code, more state, more failure surfaces.
- Heartbeat is currently a 3h cadence — slow loop. May need to accelerate compaction triggers to a separate cron.
- Agent must learn to do "compaction review" as a skill — new behavior, new failure modes.

**Verdict: (c) is the right answer.** Specifically with the following architectural commitments:

1. **Platform owns the data plane.** All compaction reads/writes go through the platform's reconciler-level code (TypeScript on Vercel, Python on VMs). Agent never directly writes to gbrain or modifies the workspace files during compaction. This is the safety property — the agent CANNOT bypass the validation pipeline.

2. **Agent owns the semantic plane.** During heartbeat (or a dedicated `/compact-review` heartbeat sub-session), the agent reviews candidate compactions presented by the platform: "we're going to merge these 3 memories about your Bitcoin 2026 trip into one summary — OK to drop the originals?" The agent's job is yes/no with reasoning, not execution.

3. **Cross-model validation is baked in.** Sonnet handles user conversations; Haiku (different family wing) reviews compaction outputs. The validator never sees the editor's reasoning trace — only the diff and a question ("what was lost?").

4. **Versioned, rollback-cheap.** Every compaction writes a git commit (or equivalent — could be JSONL append-only log) before changing the live files. Rollback is one operation.

5. **Shadow-prompt regression mandatory.** Before promoting a compaction from "candidate" to "applied", run a fixed regression suite of operator-seeded prompts through both old and new context. If structural similarity of responses drops below threshold, auto-rollback.

6. **Provenance + confidence per memory.** Every row in gbrain (the warm tier) has `source`, `confidence`, `created_at`, `last_referenced_at`, `references_count`. Compaction priority is data-driven, not heuristic.

This is the design fleshed out in §14.3.

### 14.3 The Sleep Cycle Compactor architecture

Working name: **"Sleep Cycle Compactor"** (biology-inspired; see R5 — NREM sharp-wave ripples as the compaction-pass analog).

#### 14.3.1 High-level flow

```
USER IDLE (>15 min, configurable)
   ↓
PLATFORM CRON FIRES (per-VM, staggered)
   ↓
1. READ current hot tier (SOUL.md, AGENTS.md, IDENTITY.md, USER.md, MEMORY.md,
   memory/session-log.md tail)
   ↓
2. SCORE each entry (importance × recency × references × confidence)
   ↓
3. PROPOSE compactions (Sonnet 4.6 via proxy):
   - Dedup near-duplicate facts
   - Summarize old session-log entries (>14 days, low-reference)
   - Demote low-confidence agent-inferred memories
   - Promote frequently-referenced warm facts to hot
   ↓
4. CRITIQUE (Haiku 4.5 cross-model — sees diff only, not reasoning):
   - "What anchor fact might be lost in this diff?"
   - "Does the new SOUL.md preserve persona signature?"
   - "Does the diff modify any [LOAD_BEARING] tagged line?"
   ↓
5. REGRESSION TEST (shadow-prompt vs operator-seeded canary):
   - Run 50-100 canonical prompts through old and new prompt
   - Compare structural similarity (LLM-judge or embedding-cosine)
   - Threshold: 95% similarity required to proceed
   ↓
6. APPLY (atomic, git-versioned):
   - Write new hot-tier files via SHA-verified writeFileAtomic
   - Move dropped/summarized content to warm tier (gbrain INSERT with
     source='compaction_reflection', confidence=summary_confidence)
   - Append-only audit log entry
   ↓
7. POST-VERIFY:
   - Sanity probe: agent can still answer "who am I?" canonical questions
   - If post-verify fails: auto-rollback to pre-compaction commit
   - If post-verify succeeds: commit becomes new HEAD; old commit remains
     in the audit log for forensic recovery
```

User never sees any of this. The next time they message the agent, the agent has the new (smaller, healthier) context. Their experience: response feels the same or better, latency is the same or lower, costs less to serve.

#### 14.3.2 The "sleep" trigger logic

Three triggers, in priority order:

1. **Importance-sum trigger** (Generative Agents pattern). Maintain a running sum of importance scores from new memories since the last compaction. When the sum exceeds N (tune: ~100-200), compaction is eligible.

2. **Size pressure trigger.** Hot tier files approaching budget (e.g., MEMORY.md > 4KB on a 5KB soft cap, SOUL.md Learned Preferences > 1KB). Eligible.

3. **Time-based trigger.** Failsafe — even quiet VMs get compaction every 7 days.

When **eligible**, the compactor enters a "looking for a quiet window" state. Actual fire requires:
- User idle (no message in last 15 min)
- No active session (last assistant turn > 30 min ago)
- Not currently in a heartbeat run
- Not currently in privacy mode (Edge_city operational concern)
- Not in a known sensitive period (e.g., during a token launch flow)

Default fire window: nighttime in the user's timezone (inferred from past message timestamps), but adaptable. A user who's active 24/7 might never have a "night" — compactor runs during their longest gap.

This is the **biology-inspired part**: the agent's "sleep" is the compactor's "wake." We're inverting the typical "agent runs while user is active." Compaction happens when the agent would otherwise be idle.

#### 14.3.3 The execution loop in detail

**Phase 1 — Read & score.** Platform fetches:
- Hot tier files: SOUL.md, AGENTS.md, IDENTITY.md, USER.md, MEMORY.md, last 15 entries from memory/session-log.md.
- Warm tier (gbrain) state: row counts per table, confidence distribution, age histograms.
- Activity signal: total messages last 7 days, last 24h activity pattern.

Scores per memory entry:
```
hotness = (importance × 0.4) + (recency_decay × 0.3) + (reference_count × 0.2) + (confidence × 0.1)
```

Where:
- `importance` (1-10): set at write time by LLM extraction.
- `recency_decay`: exponential, half-life 7 days (configurable per type).
- `reference_count`: # of times this entry appeared in agent's retrieval over last 30 days.
- `confidence` (0-1): provenance-derived (user_told=1.0, tool_output=0.85, agent_inferred=0.6, log_summary=0.4, reflection=0.5).

Below `hotness=0.3` threshold: candidate for hot→warm demotion.
Above `hotness=0.7` threshold: candidate for warm→hot promotion (rare).

**Phase 2 — Propose (Sonnet 4.6).** The platform calls Sonnet with a structured prompt:
```
You are reviewing an agent's context for compaction. Below is the current state.
Propose a structured edit list:
- Memories to DEMOTE (move from hot to warm tier)
- Memory pairs to MERGE (replace 2 entries with 1 summary)
- Memories to PROMOTE (move from warm to hot — agent has been referencing them)
- Sections to REWORD (compress without dropping information)

CRITICAL RULES:
- NEVER touch lines tagged [LOAD_BEARING] (safety boundaries, hard rules)
- NEVER drop named entities the user explicitly shared (names, family, occupation)
- NEVER drop the most-recent 5 session-log entries
- NEVER touch lines below the OPENCLAW_CACHE_BOUNDARY marker

Output: a JSON edit list with per-edit `action`, `target`, `reasoning`.
```

The agent's Sonnet model is the proposer. Cost: ~3-5K input tokens, ~2K output. Per-VM cost ~$0.03-0.05 per compaction cycle.

**Phase 3 — Critique (Haiku 4.5, different model wing).** Platform calls Haiku with ONLY the diff and the question:
```
You are reviewing a proposed edit to an AI agent's persistent memory.
Below is the diff (- = removed/changed, + = added/replacement).

You do NOT have the agent's history. You do NOT see the proposer's reasoning.

Your job: identify what might be LOST that the user could reasonably notice.

Output: list of "concerns" — each with severity (low/med/high) and the
specific line/fact that worries you.
```

This is the cross-model validator. Haiku is from the same Claude family, which is imperfect — but the model-size split + the reasoning-stripped prompt provides meaningful independence. R3 research suggests cross-vendor would be ideal; that's a V5 enhancement (use Gemini/GPT-4o-mini as third critic).

If Haiku flags any "high" concern → halt, write audit log entry, don't apply.
If Haiku flags only "low/med" → proceed to Phase 4.

**Phase 4 — Regression test (operator-seeded canary).** The platform maintains a fixed set of 50-100 regression prompts per VM tier (starter / pro / power / partner-specific). Examples:
- "Who am I?" → must return user's name from USER.md
- "What's my Bankr wallet address?" → must read WALLET.md, return the address
- "What did we talk about yesterday?" → must reference recent session-log entry
- "Launch a token called TEST with ticker TST" → must route to Bankr dashboard, no refusal
- "What can you do?" → must read CAPABILITIES.md, return categorized list

For each canary prompt, the platform runs it through:
- **Old context** (pre-compaction): the current state of the prompt
- **New context** (post-compaction): the proposed state

The platform doesn't actually run the agent; it constructs the system prompt + the canary message and calls Anthropic directly. Two API calls per canary × 50 canaries = 100 calls. At Haiku pricing, this is ~$0.10 per compaction cycle.

Comparison metric: **embedding cosine similarity** between old and new responses. Threshold: 0.92 (calibrated to allow stylistic variation while catching information loss).

If <5% of canaries drop below threshold → proceed.
If 5-20% drop below threshold → halt, log, schedule manual review on operator dashboard.
If >20% drop → halt, log, P1 alert.

**Phase 5 — Apply (atomic, git-versioned).** 
- Tar current workspace state to `~/.openclaw/compaction-snapshots/<ts>.tar.gz` (forensic backup, 30-day TTL).
- Write new files via SHA-verified `writeFileAtomic` (the same primitive we built for V2).
- INSERT dropped/summarized content into gbrain warm tier with provenance metadata.
- Append audit log entry to `~/.openclaw/compaction-audit.log` (JSONL, append-only).

**Phase 6 — Post-verify.** Wait 60 seconds for OpenClaw's session cache to detect the file changes. Then run 3-5 "smoke test" canaries through the proxy with the new state. If any fail, immediately restore from snapshot and log a P0 alert.

**Phase 7 — Idle.** Done. Next compaction trigger evaluates after the cooldown period (default: 6 hours minimum between compactions per VM, to prevent rapid cycling).

#### 14.3.4 Estimated costs

Per compaction cycle:
- Sonnet proposer: ~$0.03-0.05
- Haiku critic: ~$0.005-0.01
- Canary regression (100 prompts × 2 = 200 Haiku calls @ ~500 tokens): ~$0.10
- Smoke test post-apply (5 Haiku calls): ~$0.005
- **Total per compaction: ~$0.15**

At fleet of 225 VMs, average 1 compaction every 3 days per VM:
- Daily compactions: 75
- Daily cost: ~$11.25
- Monthly cost: ~$340

For comparison, V2's $2,490/mo input-token cost. Adding ~$340/mo for autonomous compaction is small relative to V2's win, and represents the cost of NOT having another death-spiral incident.

### 14.4 Memory tiering with gbrain

The hot/warm/cold split, with gbrain as the warm tier (per [PRD-gbrain-integration.md](./PRD-gbrain-integration.md)):

#### Tier definitions

| Tier | Location | Always in prompt? | Latency budget | Compaction action |
|---|---|---|---|---|
| **HOT** | `~/.openclaw/workspace/*.md` | Yes (auto-injected per OpenClaw bootstrap) | Must fit in `bootstrapMaxChars` (30K post-V2) | Subject to compaction; can DEMOTE to warm |
| **WARM** | gbrain (PGLite + MCP, per-VM) | No (queryable on demand) | <500ms query | Subject to compaction; can MERGE, can PROMOTE to hot |
| **COLD** | `~/.openclaw/cold/<YYYY-MM>/*.jsonl.zst` | No (never auto-loaded) | <5s grep+gunzip | Append-only, NEVER auto-deleted |

#### Schema for gbrain warm tier

Three tables (semantic / episodic / procedural — the R2 cognitive-science split):

```sql
-- Semantic facts: structured key-value, atomic
CREATE TABLE memories_semantic (
  id UUID PRIMARY KEY,
  entity TEXT NOT NULL,                    -- "user.name", "user.wallet.bankr"
  value TEXT NOT NULL,                     -- "Cooper Wrenn", "0xABC..."
  source TEXT NOT NULL,                    -- 'user_told' | 'tool_output' | 'agent_inferred'
  confidence REAL NOT NULL DEFAULT 0.8,    -- 0.0-1.0
  valid_from TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ,                 -- NULL = currently valid (Zep bi-temporal pattern)
  created_at TIMESTAMPTZ NOT NULL,
  last_referenced_at TIMESTAMPTZ,
  references_count INT NOT NULL DEFAULT 0,
  load_bearing BOOLEAN NOT NULL DEFAULT FALSE,  -- never auto-compact
  UNIQUE (entity, valid_until) -- one current value per entity
);

-- Episodic memories: timestamped events, longer-form
CREATE TABLE memories_episodic (
  id UUID PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL,
  summary TEXT NOT NULL,                   -- "On 2026-04-01 we discussed X for 2h"
  detail TEXT,                             -- optional longer transcript
  importance INT NOT NULL,                 -- 1-10
  source TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.7,
  embedding VECTOR(1536),                  -- semantic search
  references_count INT NOT NULL DEFAULT 0,
  last_referenced_at TIMESTAMPTZ,
  reflection_of UUID[],                    -- if this is a reflection, IDs of source memories
  created_at TIMESTAMPTZ NOT NULL,
  archived_at TIMESTAMPTZ                  -- soft-delete; NEVER actually delete the row
);

-- Procedural memories: how-to-do-X knowledge (Voyager-style growing skill library)
CREATE TABLE memories_procedural (
  id UUID PRIMARY KEY,
  skill_name TEXT NOT NULL,                -- "launch_bankr_token"
  description TEXT NOT NULL,
  procedure TEXT NOT NULL,                 -- markdown / shell / python
  version INT NOT NULL DEFAULT 1,
  composes_from UUID[],                    -- references to component skills
  success_count INT NOT NULL DEFAULT 0,
  failure_count INT NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  embedding VECTOR(1536),
  created_at TIMESTAMPTZ NOT NULL
);
```

#### Compaction actions per tier transition

**HOT → WARM (demote):** 
- Most common compaction action.
- A MEMORY.md line gets parsed into a semantic fact (or episodic memory) and INSERTed into gbrain.
- The hot-tier line is removed (compaction shrinks the file).
- Agent can query warm tier on demand via gbrain MCP tools.

**WARM → HOT (promote):**
- Rare but important. A frequently-referenced warm fact "earns" a slot in hot.
- Example: if the agent queries `memories_semantic` for `user.wallet.bankr` more than 5 times in 7 days, promote it to MEMORY.md (or USER.md) so it's available without query.
- Implemented as: compactor adds the line to MEMORY.md, marks gbrain row as `is_hot=true` (avoid duplicate promotion next cycle).

**WARM → COLD (archive):**
- An episodic memory hasn't been referenced in 180 days AND its importance < 5.
- Move to `~/.openclaw/cold/<YYYY-MM>.jsonl.zst` (zstd-compressed JSONL by month).
- Set `archived_at` in gbrain (don't delete the row — it remains as a stub for `embedding`-based retrieval to find).
- If agent queries and finds the stub, can choose to gunzip the cold file and rehydrate.

**COLD → WARM (resurrect):**
- Manual / forensic. Triggered by operator or by an unusual agent query pattern.
- Loads the cold JSONL row back into `memories_episodic`, clears `archived_at`.

**Never DELETE.** Cold tier is forever. GDPR deletion is a separate, audited path (not part of compaction).

### 14.5 Novel mechanisms

This section details specific techniques not present in any existing production system, combining insights from multiple research streams.

#### 14.5.1 Generational memory with provenance metadata

**The mechanism:** every memory entry has a `generation` field that tracks how many compaction cycles it has survived.

- **Gen-0 (probationary):** newly-added. Subject to aggressive compaction. Dropped after 30 days if importance < 3 AND references_count = 0.
- **Gen-1 (validated):** has been referenced ≥3 times OR has survived 3 compaction cycles. Compaction now requires Haiku critic approval at "high" severity threshold (default low/med flag won't drop).
- **Gen-2 (canonical):** referenced ≥10 times OR explicitly tagged `[LOAD_BEARING]`. Compaction can NEVER drop; can only reword (with stricter regression test threshold of 0.97 similarity).
- **Demotion:** gen-1 without references for 1 year → demoted to gen-0. Gen-2 stays gen-2 forever.

**Why this matters:** the "context collapse" failure mode (ACE paper) is when iterative rewriting erodes details over time. Generational protection prevents collapse by anchoring high-references content immutable across cycles.

**Memory poisoning antidote (Rule 29):** hallucinated diagnoses get tagged `source='agent_inferred'`, `confidence=0.6`, `gen=0`. They're first-line compaction candidates. The compactor's natural behavior is to drop them within the first 30-day cycle, preventing reinforcement. This is the architectural answer to Rule 29 — not a separate "hallucination detector" but a structural bias against persisting agent-inferred low-confidence content.

#### 14.5.2 Cross-model validation pipeline

**The constraint:** R3's Self-Correction Bench finding (64.5% blind-spot rate) requires that the editor and validator be different models.

**The pipeline:**
1. **Proposer**: Sonnet 4.6 — the model the user normally talks to. Has full context. Generates the compaction edit list.
2. **Critic**: Haiku 4.5 — different size, same family. Sees ONLY the diff (not the reasoning, not the prior context). Independent.
3. **Regression-grader**: Haiku 4.5 (or Sonnet, configurable). Scores response similarity for the canary suite.
4. **(V5 enhancement)** Third-party: Gemini-2.5-Flash or GPT-4o-mini for cross-vendor validation on a sampled subset (1% of compactions). Detects systemic blind spots within the Claude family.

**Why model diversity matters:** R3's [arxiv:2503.05061](https://arxiv.org/abs/2503.05061) found Claude models have ~25% self-preference. Family-internal diversity (Sonnet ↔ Haiku) reduces but doesn't eliminate this. Cross-vendor adds an independent signal at low cost.

#### 14.5.3 Shadow-prompt regression testing

**The mechanism:** before applying a compaction, run the canary suite through both old and new prompts. Compare structural similarity. Auto-rollback on drop.

**Operator-seeded canary** (not agent-authored — critical for safety):
- 50-100 prompts per VM tier, seeded by ops at provision time.
- Stored in `~/.openclaw/canary/<vm_id>.jsonl` — append-only, agent has no write access.
- Updated quarterly by ops based on user-complaint analytics (the things users actually report being broken).

**Per-prompt structure:**
```json
{
  "id": "anchor_user_name",
  "prompt": "What's my name?",
  "expected_signal": "must contain user's name from USER.md",
  "tolerance": 0.95,
  "tags": ["anchor_fact", "must_pass"]
}
```

**Similarity metric:**
- For "must contain" signals: substring match required.
- For open-ended responses: embedding cosine ≥ tolerance threshold.
- For structured outputs: schema validation.

**Threshold tiers:**
- `must_pass` tagged canaries: 100% pass rate required.
- General canaries: 95% pass rate, no individual below 0.90.

If ANY `must_pass` canary fails: auto-rollback. P1 alert (operator inspects).
If general pass rate < 95%: halt, schedule manual review.

**Why operator-seeded matters:** per R3 (Sleeper Agents), an agent that's been trained on poisoned data could pass agent-authored regression tests because it has the same blind spots. External seeding is the safety property.

#### 14.5.4 Importance-sum reflection trigger

**The pattern (from Generative Agents, R5):** maintain a running sum of importance scores from new memories since the last compaction. Trigger when sum exceeds threshold.

**Adaptation for InstaClaw:**
```python
# Per-VM state in gbrain:
CREATE TABLE compaction_state (
  vm_id UUID PRIMARY KEY,
  last_compaction_at TIMESTAMPTZ,
  importance_sum_since_last REAL NOT NULL DEFAULT 0,
  compaction_count INT NOT NULL DEFAULT 0
);

# On every memory write:
UPDATE compaction_state
SET importance_sum_since_last = importance_sum_since_last + new_importance
WHERE vm_id = ?;

# Compactor eligibility check:
SELECT vm_id FROM compaction_state
WHERE importance_sum_since_last > 150
  AND (now() - last_compaction_at) > interval '6 hours';
```

**Why this is the right trigger:** unlike time-based ("every 24h") or size-based ("when MEMORY.md > 5KB"), importance-sum adapts to user engagement. A quiet user doesn't trigger compactions (nothing important happened). A busy user gets more frequent compactions (more new memories to integrate). The cost matches the value.

#### 14.5.5 CLOCK pinning for hot tier (working-set discipline)

**The pattern (from R5, OS memory hierarchy):** CLOCK / WSClock algorithm — reference bit cleared on scan, evicted if 0 after one revolution.

**Adaptation:** each entry in MEMORY.md / USER.md gets a hidden reference bit. When the agent retrieves and uses the entry, the bit is set. Compactor's "scan" runs through all entries and clears bits. Entries that come around with bit still 0 (never used in the interval) are candidates for hot→warm demotion.

**Implementation:** the reference bit is just `last_referenced_at`. Compactor query:
```sql
SELECT entity FROM memories_semantic
WHERE is_hot = TRUE
  AND COALESCE(last_referenced_at, '1970-01-01') < now() - interval '14 days'
  AND load_bearing = FALSE;
```

These are demotion candidates. Sent to the Sonnet proposer for "should we demote this?" review.

**Why this matters:** prevents Letta's failure mode where stale `human` blocks linger forever. The hot tier becomes a true working set, not an accumulation.

#### 14.5.6 Bi-temporal validity for semantic facts

**The pattern (from Zep, R5):** facts have `valid_from` + `valid_until`. Updates close the old interval; never overwrite.

**Adaptation for InstaClaw:**
- User says "I prefer SOL" on 2026-04-01 → `INSERT (entity='user.crypto.pref', value='SOL', valid_from='2026-04-01', valid_until=NULL)`.
- User says "I prefer ETH now" on 2026-05-15 → `UPDATE existing row SET valid_until='2026-05-15'; INSERT new row (entity='user.crypto.pref', value='ETH', valid_from='2026-05-15', valid_until=NULL)`.
- Agent's current-value query: `WHERE entity = 'user.crypto.pref' AND valid_until IS NULL` returns ETH.
- Agent's historical-value query: `WHERE entity = 'user.crypto.pref' AND valid_from <= ?` returns whatever was valid at that time.

**Why this matters:**
1. Conflict resolution is deterministic by recency.
2. Historical truth is preserved (per Rule 22).
3. Audit: agent can answer "when did the user change their mind about X?" — the trace is there.
4. Enables the "memory was load-bearing for the agent's reasoning back then but not now" case.

#### 14.5.7 Adversarial review agent (Refute-or-Promote pattern)

**The pattern (R3, [arxiv:2604.19049](https://arxiv.org/abs/2604.19049)):** a second agent with minimal context performs independent critique.

**Adaptation:** after the Haiku critic (§14.5.2) approves a compaction edit list, the platform spawns a brief "adversarial review" call with this prompt:
```
You are reviewing a proposed compaction of an AI agent's memory.
You are looking for what might be LOST in this change.

Below is the diff (- = removed, + = added).
You have ZERO context about the agent's history.

Your job: write 1-3 specific questions a user might ask in the next month
that this compaction would make the agent unable to answer well.

If you cannot identify any plausible question: respond "NO_CONCERNS".
```

The adversarial reviewer is structurally limited to the diff. If it produces a non-trivial question, the platform either (a) holds the compaction for operator review or (b) explicitly checks whether the diff's removed content answers that question. If yes, the question becomes a canary for next compaction.

**Cost:** ~$0.01 per compaction. Optional but high-value safety layer.

#### 14.5.8 Audit log + git-backed versioning

**The pattern (R3, Letta Context Repositories):** every compaction is a commit. Rollback is one command.

**Adaptation:** maintain a git-style append-only log at `~/.openclaw/compaction-audit.log`:
```jsonl
{"ts":"2026-07-15T03:14:22Z","action":"compact","mode":"sleep","files_changed":["MEMORY.md","SOUL.md"],"diff_lines_removed":47,"diff_lines_added":12,"importance_dropped_sum":23,"canary_pass_rate":0.98,"snapshot":"/home/openclaw/.openclaw/compaction-snapshots/2026-07-15T03-14-22.tar.gz","proposer_model":"claude-sonnet-4-6","critic_model":"claude-haiku-4-5"}
{"ts":"2026-07-22T03:18:11Z","action":"rollback","reason":"canary_pass_rate=0.91 below threshold","reverted_to":"2026-07-22T03-15-00.tar.gz"}
```

This is operator-visible (forensics), not user-visible. Every action is reproducible. Per Rule 22, snapshots have 30-day TTL — long enough for any rollback need.

### 14.6 Failure modes & safety constraints

The 12 hard constraints synthesized from R3, framed as design principles for V3+ implementation. Each is required, not optional.

1. **Cross-model validation is mandatory.** Editor and validator must be different (Sonnet ↔ Haiku at minimum; Claude family ↔ third-party at V5). Same-model self-judging has a 25% self-preference bias and a 64.5% blind-spot rate.

2. **Versioned context with zero-cost rollback.** Every compaction is a commit. Rollback restores prior state with one operation. Snapshots have 30-day TTL minimum.

3. **Never nuke — always trim or demote.** Hot → warm is OK; warm → cold is OK; cold → deleted is NEVER automatic (per Rule 22/30, R3 SSGM paper, R4 character platform consensus).

4. **`[LOAD_BEARING]` tagged lines are immutable to the compactor.** Safety rules, hard boundaries, named entities the user explicitly shared. Pre-commit diff check rejects any compaction that mutates a tagged line.

5. **External corroboration before promoting any memory past gen-0.** A claim must reference at least one external signal (tool output, log line, user message timestamp) before it can survive 30 days. Uncorroborated claims auto-decay. This is the Rule 29 antidote.

6. **Shadow-evaluate against operator-seeded canary BEFORE promotion.** Run 50-100 prompts through both states. `must_pass` anchor-fact canaries must hit 100%; general canaries ≥95%. Failures trigger auto-rollback.

7. **Bounded blast radius per cycle.** A single compaction cannot remove more than X% of MEMORY.md (X=30 default), cannot drop more than Y tagged lines (Y=0 — never), cannot fire more than Z times per VM per day (Z=4 default). Compounding errors are bounded.

8. **Adversarial review by a "what did you lose?" agent.** Refute-or-Promote pattern with minimal-context critic. Non-trivial concerns hold the compaction.

9. **Temporal decay, not threshold-deletion.** Importance scores decay slowly; only items below a long-soaked floor are eligible for hot→warm. Prevents false-positive deletion.

10. **Operator-seeded canary that the agent did NOT author.** The agent cannot edit its own evaluation. External eval set is required (Sleeper Agents implication).

11. **Asymmetric default: when in doubt, keep + warm storage.** Hot tier is bias-toward-drop; warm/cold absorbs uncertainty. False positives (kept too much) are vastly cheaper than false negatives (dropped load-bearing). The Replika 25M-user incident is the empirical proof.

12. **Audit log every compaction with human-readable diff + reasoning trace.** Recovery procedure is `git log` + revert.

### 14.7 Interaction with V2, V3, and gbrain

| Phase | Goal | Compaction status |
|---|---|---|
| **V2 (May 2026)** | Trim platform-managed SOUL.md from 34K → 2.4K | No compaction yet. V2 is structural-trim only. |
| **V3 (Jul-Aug 2026)** | Trim AGENTS.md 14K → 8K (move PROTOCOL.md to on-demand) | Still no compaction; structural reorganization. |
| **gbrain (Q3 2026)** | Ship per-VM PGLite + MCP per existing PRD-gbrain-integration.md | gbrain becomes the warm-tier substrate. Compaction not yet active. |
| **V3.5 (Aug 2026)** | Tier classification protocol | Define schema (semantic/episodic/procedural); migrate existing MEMORY.md content into gbrain. NO active compaction; gbrain is shadow-store. |
| **V4 (Sep-Oct 2026)** | Shadow-mode compactor | Compactor runs nightly in SHADOW mode: identifies candidates, runs proposer+critic, runs canary regression, logs what WOULD happen. Does NOT apply. 30-day soak. |
| **V4.5 (Nov 2026)** | Active-mode compactor | Promote V4 to active. Compaction applies. 30-day soak with elevated alert thresholds. |
| **V5 (Q1 2027)** | Cross-vendor validation + adversarial review | Sample 1% of compactions go through Gemini/GPT-4o-mini for vendor-independent critique. Refute-or-Promote agent added. |
| **V6 (Q2 2027)** | Promote learnings to manifest | Patterns the compactor consistently applies across the fleet (e.g., "always demote >180-day session-log entries") become manifest-level defaults. Removes the per-VM LLM cost for the common case. |

**Critical sequencing**: V3 + gbrain MUST land before V4. Without gbrain as the warm-tier substrate, compaction has nowhere to demote. Without V3's smaller hot tier, there's no headroom to add compaction infrastructure to the prompt.

**Critical timing**: V4 launches in shadow mode in September 2026. By the time it goes active in November, V2 has been deployed for 6+ months — we know what "healthy V2 state" looks like, and we have a baseline for comparing pre/post-compaction agent behavior.

### 14.8 Open questions & research gaps

1. **How do you measure "personality drift" robustly?** R3's persona-consistency papers proposed prompt-to-line / line-to-line / Q&A metrics. None are validated at our scale (225 VMs, conversations spanning months). Need to instrument this.

2. **What's the right cadence for canary suite updates?** Quarterly seems right but may need to be event-driven (every customer-reported regression spawns a new canary).

3. **Cross-vendor validation cost-benefit at scale.** If 1% of compactions get Gemini critique, that's ~3 calls/day at fleet scale. Cheap. But does it actually catch Claude-family blind spots, or is it noise? Need experimental data.

4. **What happens when agent-initiated compaction (via Letta-style tool calls) conflicts with platform-cron compaction?** Avoid? Coordinate? Letta only does the former; we'd do both. Need conflict-resolution protocol.

5. **Multi-vendor model availability and cost stability.** If Anthropic deprecates Haiku 4.5 mid-rollout, the compactor's economics change. Need a fallback design (e.g., compactor can run with Sonnet-only at 4× cost, paused until cheaper validator returns).

6. **GDPR / user-data deletion compliance.** Our "never delete" default conflicts with "right to be forgotten." Need explicit deletion procedure (operator-initiated, audit-logged, applies to specific entities only).

7. **The "agent realizes its own memory was wrong" loop.** Per Rule 29, agents persist hallucinated diagnoses. If a future conversation contradicts the diagnosis ("vm-754 fork limits aren't a thing"), can the compactor catch this and demote the false memory? Idea: the proposer prompt explicitly asks "are there contradictions between recent conversation and persistent memory?" — and proposes demotion for the older claim. Untested.

8. **Should the agent be told that compaction happened?** Cooper's north star says the USER never knows. But the agent itself — should it know? Pros of telling: agent can avoid asking "do you remember X?" when X was just compacted. Pros of not telling: agent has the simplest mental model. Lean: don't tell. The warm tier is queryable; the agent can find X via gbrain query if needed.

9. **What does "the agent verifies nothing broke" look like beyond canary regression?** Personality drift is slow. A 95% similarity threshold catches obvious regressions but not personality drift over 10 cycles. Need a longitudinal metric — e.g., "the agent's voice signature (style embeddings of last 100 responses) hasn't drifted >0.1 cosine from baseline over 30 days."

10. **The "compaction can suggest its own canaries" question.** If the adversarial reviewer (§14.5.7) flags a concern, that concern could become a future canary. But: the canary corpus is operator-seeded by design (R3 sleeper-agent constraint). Auto-promotion of compactor-flagged concerns to canaries would let the system bootstrap its own eval set — but with bias risk. Probably keep operator-only for safety; revisit if it becomes a bottleneck.

### 14.9 Why this matters as a competitive advantage (not just an internal fix)

The character-platform research (R4) shows the entire space is struggling with autonomous memory at scale. Replika 2.0 launched and immediately churned users. Character.AI's pinned memories are advisory. Janitor's memory failures dominate r/JanitorAI_Official. SillyTavern requires power-user manual configuration.

**InstaClaw is the only consumer-AI-agent platform with a per-VM persistent filesystem + MCP-queryable warm-tier database + operator-managed canary suite + cross-model validation pipeline already designed.** That stack lets us build the first truly autonomous compactor that doesn't bother the user.

The product story: "Your InstaClaw agent never forgets. It also never slows down. It also never claims to remember things it didn't actually witness. That's not a memory tier — that's a memory architecture." That's a differentiation story we can run with at every partner pitch (Edge City, Bitcoin 2026, Devcon).

**The architectural inheritance** is the moat:
- V2's cache-boundary marker is borrowed from Anthropic's own design.
- V3+ compaction borrows from Letta (function-call API), Mastra (two-tier compaction), Generative Agents (importance-sum trigger), Zep (bi-temporal facts), and biology (sleep cycles).
- Synthesizing all of them with cross-model validation + operator-seeded canaries + provenance metadata is a design nobody else has shipped.

The work this PRD did before Esmeralda (V2) gives us the headroom. The work this PRD outlines for after Esmeralda (V3+) makes us the only platform where the headroom stays headroom.

---

_End of PRD. §1-13 are V2 activation. §14 is V3+ roadmap. Decisions for §14 are deferred to post-Esmeralda planning._

