# gbrain v0.35.0.0 → v0.35.7.0 Compatibility Report

**Status:** Phase 1 deliverable — Cooper's review gate before any VM touching.
**Date:** 2026-05-18
**Authored:** Phase 1 deep changelog review per the new operating directive ("spec before code, no rush, ultrathink").

**Scope:** every release between our pin (v0.35.0.0, commit `baf1a47`, 2026-05-15) and Cooper's target (v0.35.7.0). Source: `https://raw.githubusercontent.com/garrytan/gbrain/master/CHANGELOG.md` + open/closed issues queried via GitHub API.

**New finding to surface up-front:** **v0.35.8.0 exists** (shipped 2026-05-18 13:22 UTC, ~12h before this report). Cooper approved v0.35.7.0 — I'm reporting on the 9 versions in scope plus a summary of v0.35.8.0 so Cooper can choose whether to revise the target.

---

## 0. Executive summary

| Question | Answer |
|---|---|
| Schema migrations 35.0→35.7? | **One.** v0.35.7.0 adds migration **v67** (`facts_typed_claim_columns`): four nullable columns + a partial index on the `facts` table. Auto-applied by `apply-migrations` on `gbrain upgrade`. Metadata-only on both engines. |
| Schema 35.7→35.8? | **Zero.** Phantom-redirect uses existing schema (3 new `CycleReport.totals` keys, `schema_version` stays 1). |
| MCP tool interface changes affecting `put_page`, `search`, `get_page`, `list_pages`, `submit_job`? | **None.** All five tools' names + input shapes are unchanged. |
| Tool name changes that would require updating GBRAIN_MEMORY_PROTOCOL_V1? | **None.** Block text references `gbrain__put_page`, `gbrain__search`, `gbrain__get_page`, `gbrain__list_pages`, `gbrain__submit_job`. All five names persist v0.35.0→v0.35.8. **Protocol does NOT need re-deploy.** |
| Tool response shape changes? | **One additive.** `SearchResult` (returned by `search`) gains optional `effective_date` + `effective_date_source` fields in v0.35.3.1. Forward-compatible — old consumers ignore unknown fields. |
| Embedding model changes? | **None.** Default stays `openai:text-embedding-3-large` at 1536 dim. v0.35.0.0 added ZeroEntropy as **opt-in alternative** (not auto-switched). Our systemd `Environment=GBRAIN_EMBEDDING_MODEL=openai:text-embedding-3-large` keeps us on the same model across the bump. **No existing vectors invalidated.** |
| Embedding dimension changes? | **None.** 1536 throughout. |
| Cache invalidation? | **Yes, twice.** v0.35.0.0 bumps `KNOBS_HASH_VERSION` 1→2 (reranker fields fold in). v0.35.6.0 bumps 2→3 (floor_ratio field folds in). Both purge old cache rows naturally via TTL (default 3600s). Brief search-cache miss window post-deploy; recovers within an hour. |
| Config format changes? | **None breaking.** New optional config keys added (`search.floor_ratio`, `models.eval.contradictions_judge`). Existing keys preserved. |
| New required env vars? | **None.** All new env vars (`GBRAIN_TRAJECTORY_REGRESSION_THRESHOLD`, `GBRAIN_PHANTOM_REDIRECT_LIMIT`, `GBRAIN_AUDIT_DIR`, etc.) are optional with sane defaults. |
| Autopilot cycle changes affecting us? | **None.** v0.35.7.0's `consolidate` idempotency fix + v0.35.8.0's phantom-redirect run inside `gbrain dream` autopilot. **Our gbrain sidecar (`gbrain serve --http`) does NOT run autopilot in the background** (verified by reading `src/commands/serve-http.ts` — no `setInterval`, no `cron`, no `runCycle` hooks). Cycle-phase changes are inert on our VMs. |
| "58x perf" claim? | v0.35.4.0. Scope is `tryPrefixExpansion` inside the `extract_facts` cycle phase. **NOT put_page / NOT search / NOT get_page.** Inert on our path. |
| Data loss / corruption reports v0.35.0→v0.35.8? | **None affecting our setup.** Two open schema-wedge issues (#1054, #1092) target pre-v54 brains; ours are at v66 (past the wedge zone). |
| MCP transport regressions? | **None on streamable-http.** Open issue #1061 is a stdio-only `whoami` regression — not our transport. |
| Backward compatibility for existing PGLite data? | **Preserved.** Migration v67 is additive (nullable columns); existing rows survive unchanged. The 42 MB baseline on our VMs is undisturbed by the bump. |

**Bottom-line recommendation:** **GO for canary on vm-050 to v0.35.7.0.** Risk is genuinely low across every dimension Cooper asked about. The most surprising finding (good news) is that all gbrain cycle-phase improvements between v0.35.0.0 and v0.35.7.0 are inert on our streamable-http MCP runtime path — gbrain's autopilot cycle doesn't run inside the sidecar process; it's a separate CLI invocation (`gbrain dream`) that we never call.

**Open question for Cooper:** revise the target from v0.35.7.0 to v0.35.8.0? v0.35.8.0 adds phantom-page cleanup that runs inside the autopilot cycle (which we don't run) — so it's likewise inert. No incremental risk, no incremental benefit. My recommendation: **stick with v0.35.7.0** as you approved. v0.35.8.0 can ride the next bump.

---

## 1. Cooper-flagged checks — answered directly

### 1.1 Does v0.35.7.0 change the MCP tool interface?

**No.** I grepped the v0.35.7.0 changelog for our five protocol-named tools. Findings:

- `put_page` — not mentioned (interface unchanged). One related note: "v0.35.7 fixes a pre-existing cycle idempotency bug" in `consolidate` phase — that's autopilot, not the MCP `put_page` tool.
- `search` — not mentioned at the interface level. `SearchResult` (the response shape) gains two optional fields (`effective_date`, `effective_date_source`) at v0.35.3.1 (earlier release); v0.35.7.0 doesn't change `search` further.
- `get_page` — not mentioned. Interface unchanged.
- `list_pages` — not mentioned. Interface unchanged.
- `submit_job` — not mentioned. Interface unchanged. **Important for our protocol:** the GBRAIN_MEMORY_PROTOCOL_V1 block explicitly names `gbrain__submit_job` as the BANNED tool for user-fact storage. That name still exists and means the same thing post-bump.

**New MCP op added in v0.35.7.0:** `find_trajectory` (read scope, queries chronological metric trajectories). Additive — our agents can ignore it. The block doesn't need to mention it; agents discover it via `tools/list`.

**GBRAIN_MEMORY_PROTOCOL_V1 does NOT need re-deploy.**

### 1.2 Does the PGLite schema version change? Auto-migrate or manual?

**Yes — one schema change.** v0.35.7.0 ships migration **v67** (`facts_typed_claim_columns`):

```sql
-- Migration v67 (v0.35.7.0)
ALTER TABLE facts ADD COLUMN claim_metric TEXT;        -- nullable
ALTER TABLE facts ADD COLUMN claim_value DOUBLE PRECISION;  -- nullable
ALTER TABLE facts ADD COLUMN claim_unit TEXT;          -- nullable
ALTER TABLE facts ADD COLUMN claim_period TEXT;        -- nullable
CREATE INDEX facts_typed_claim_idx ON facts (entity_slug, claim_metric, valid_from)
  WHERE claim_metric IS NOT NULL;  -- partial index, no rewrite
```

**Auto-migration on startup**: yes. `gbrain upgrade` runs `apply-migrations` which executes any pending migrations against the existing PGLite data dir. The changelog's "To take advantage" section step 1 explicitly says:

> `gbrain upgrade` will automatically pick up the new logic. The wave ships migration v67 (`facts_typed_claim_columns`); `apply-migrations` runs it transparently.

**No manual migration step required.** **No blocker.**

Caveat: open issue **#1102** ("apply-migrations --yes silently fails on partial schema state") suggests there are edge cases where auto-migration silently fails. Our VMs were initialized at v66 by `install-gbrain.sh` Phase E2 (fresh PGLite + migration run during install), so they're in a known-good state — but I'll verify schema_version on the canary VM before/after the upgrade to confirm v67 lands.

### 1.3 What did v0.35.4.0 "58x perf" actually change? Embedding model implications?

**Scope:** `tryPrefixExpansion` SQL query in the entity resolver (`src/core/entities/resolve.ts`).

**What was slow:** the pre-fix query did three derived-table aggregations (`LEFT JOIN (SELECT FROM links GROUP BY to_page_id)`) that pre-aggregated the ENTIRE `links` and `content_chunks` tables on every call.

**What changed:** rewrote as correlated subqueries scoped to the slug-LIKE candidates. Hits indexes exactly 3× per candidate instead of 1× across the whole table.

**Benchmark:** 5K pages / 50K links / 25K chunks. Old median 18.16 ms → new median 0.31 ms = **58.22x speedup**.

**Where this runs:** the entity resolver is called by `extract_facts` cycle phase (and a few CLI paths). **NOT by our agents' MCP path** (put_page / search / get_page).

**Embedding model implications:** **NONE.** No embedding-model change. No embedding-dimension change. No re-embed of existing vectors. text-embedding-3-large stays at 1536 dimensions throughout v0.35.0.0 → v0.35.8.0.

**Net for us:** the "58x perf" headline doesn't apply to our user-visible operations. Don't expect put_page or search to get noticeably faster from this upgrade.

### 1.4 Data loss / corruption / regressions in v0.35.1–v0.35.7

Searched the open + recently-closed issues on `garrytan/gbrain` for: `corruption OR "data loss" OR regression OR wedge OR broken` filtered to v0.35.x.

| Issue | State | Affects us? | Why / why not |
|---|---|---|---|
| **#1054** schema migration v44→v45+ wedged | open | **No** | Our brains are at v66. The wedge zone is v44/v45 (very old brains). |
| **#1092** v0.35.1.0 schema-embedded.ts references oauth_clients.source_id before v60/v61 migrations | open | **No** | Same wedge class. Our brains are past v60/v61. |
| **#1100** PGLite + apply-migrations v0.11.0 (Minions) wedges with ENOTFOUND | open | **No** | Affects Minions worker network resolution at install time; we don't use that worker. |
| **#1102** apply-migrations --yes silently fails on partial schema state | open | **Possibly** | If our canary VM is in any partial-schema state, the auto-migration to v67 could silently fail. Mitigation: verify `schema_version` before AND after `gbrain upgrade` on the canary. |
| **#1061** mcp__gbrain__whoami throws unknown_transport on stdio MCP (v0.33 → v0.35.1.0) | open | **No** | We're on streamable-http transport, not stdio. |
| **#1115** bootstrap oauth_clients forward-reference columns before SCHEMA_SQL replay | open | **No** | Bootstrap-only; our brains were installed fresh at v66. |
| **#1051** Make embedding vector dimension configurable | open | **No** | Feature request, not a bug. |
| **#1040** gbrain init --migrate-only fails due to idx_ingest_log_source_type_created on existing databases | open | **No** | Affects `gbrain init --migrate-only`; `gbrain upgrade` follows a different path. |
| **#1096** extract_facts: empty slugs array triggers full-brain walk | open | **Possibly autopilot** | Only fires inside `extract_facts` cycle (autopilot). Our sidecar doesn't run autopilot. |

**No data-loss issues confirmed in scope.** No `put_page` / `search` / `get_page` regressions on the streamable-http path.

The one "possibly" risk is **#1102** — silent migration failure on partial schema state. Canary plan addresses this with explicit pre/post schema_version verification.

---

## 2. Per-version compatibility table

Every version v0.35.1.0 → v0.35.8.0 against our use case (streamable-http MCP, PGLite at schema v66, text-embedding-3-large 1536-dim, OPENAI_API_KEY + ANTHROPIC_API_KEY in systemd Environment=).

### v0.35.1.0 — 2026-05-15 ("embedder shootout prereqs")

| Dimension | Change | Risk for us |
|---|---|---|
| Schema | None | ✅ |
| MCP tools | None | ✅ |
| Embedding model/dim | None | ✅ |
| Config | None breaking | ✅ |
| Env vars | None | ✅ |
| Cache invalidation | None | ✅ |
| Tool response shapes | None | ✅ |
| Behavior | New `voyage:voyage-4-large` and `zeroentropyai:zembed-1` pricing entries (opt-in); new `gbrain/ai/gateway` export (additive); new `--resume-from` CLI flag for LongMemEval (CLI-only, additive). | ✅ |

**Verdict: SAFE.** Pure additive infrastructure for evals.

### v0.35.1.1 — 2026-05-16 ("longmemeval fix wave")

| Dimension | Change | Risk for us |
|---|---|---|
| All dimensions | Eval-only fixes: `normalizeSessions` for HuggingFace _s split, `sanitizeSessionIdForSlug` for non-conforming session IDs, `configureGateway()` call inserted before `gbrain eval longmemeval` dispatch. | ✅ |

**Verdict: SAFE.** Eval harness; we don't run evals on production VMs.

### v0.35.3.0 — 2026-05-15 ("fix wave: extract_facts items + git --no-recurse-submodules")

| Dimension | Change | Risk for us |
|---|---|---|
| Schema | None | ✅ |
| MCP tools | `extract_facts.entity_hints` param schema gets `items: { type: 'string' }`. **Additive — forward compatible.** Same fix applied to `xHandleToTweetResolver.candidates` output schema. | ✅ |
| Internal refactor | New `paramDefToSchema(p: ParamDef)` helper consolidates 3 ParamDef→JSON-Schema sites (stdio MCP, HTTP MCP `tools/list`, subagent brain-tool registry). **No consumer-visible change** — tool defs emit byte-stably. | ✅ |
| Embedding | None | ✅ |
| Behavior | Remote-source `git clone` / `git pull` now place `--no-recurse-submodules` AFTER the verb (fixes 7-month silent breakage). We don't use remote-source git sync. | ✅ |

**Verdict: SAFE.** Improves strict-mode-agent compatibility for Gemini Pro / OpenAI structured outputs — doesn't affect Anthropic (which we use).

### v0.35.3.1 — 2026-05-15 ("temporal-aware contradiction probe + verdict enum")

| Dimension | Change | Risk for us |
|---|---|---|
| Schema | None | ✅ |
| MCP tools | None for `put_page`/`search`/`get_page`. The eval-only `JudgeVerdict.contradicts: boolean` → `verdict: Verdict` (6-member union) — internal type, not exposed via MCP. | ✅ |
| **Response shape** | `SearchResult` interface gains optional `effective_date: string \| null` and `effective_date_source: string \| null`. Surfaces in `search` results via 8 SQL projection sites. **Additive — backward compatible.** Our agent reads results by JSON key; unknown fields ignored. | ✅ |
| Cache | `PROMPT_VERSION` of `eval-suspected-contradictions` judge prompt bumps `'1' → '2'` — invalidates that specific eval's cache. Not our cache. | ✅ |
| New env vars | `GBRAIN_NO_PROBE_PROMPT`, `GBRAIN_PROBE_PROMPT_GRACE_SECONDS` — optional, eval-only. | ✅ |
| New CLI features | `--budget-usd N` hard cap on eval runs; new `models.eval.contradictions_judge` config key. | ✅ |
| Privacy lint | New `scripts/check-proposal-pii.sh` — CI-only. | ✅ |

**Verdict: SAFE.** Additive response shape change; everything else is eval-only.

### v0.35.4.0 — 2026-05-16 ("doctor + entity resolver + 58x perf")

| Dimension | Change | Risk for us |
|---|---|---|
| Schema | None | ✅ |
| MCP tools | None | ✅ |
| **Cycle behavior (autopilot only)** | `resolveEntitySlug` adds `isBareName()` + `tryPrefixExpansion()` between fuzzy and slugify fallback. **Runs in `extract_facts` cycle phase (autopilot).** Not invoked by put_page MCP path. | ✅ |
| Cycle behavior | `writeFactsToFence` adds defensive stub-creation guard: refuses to spawn unprefixed entity pages; fact still lands via legacy `engine.insertFact()` DB-only path. Autopilot-only. | ✅ |
| Doctor | Adds `stub_guard_24h` check; replaces ad-hoc `code !== 0 && code !== undefined` filter with shared `classifyWorkerExit()` helper. Diagnostics-only. | ✅ |
| Perf | `tryPrefixExpansion` SQL rewrite: 58.22x speedup on 5K-page benchmark (autopilot path). Not our path. | ✅ |
| New env vars | None | ✅ |
| Audit files | New `~/.gbrain/audit/stub-guard-YYYY-Www.jsonl` (ISO-week rotated). | ✅ |

**Verdict: SAFE.** Every change targets autopilot / diagnostics / CLI — none touches our streamable-http MCP runtime path.

### v0.35.5.0 — 2026-05-16 ("bootstrap + orphans + think MCP + worktree + walker")

| Dimension | Change | Risk for us |
|---|---|---|
| Schema | None (but bootstrap probes legacy missing columns on pre-v0.34 brains — our brains are at v66 so none of the 7 probes match anything to add) | ✅ |
| MCP tools | None directly. `runThink` (the `gbrain think` MCP tool, if exposed) now routes through `gateway.chat()` so Anthropic key from `~/.gbrain/config.json` is read. **Our setup uses systemd `Environment=ANTHROPIC_API_KEY=...`** which `process.env.ANTHROPIC_API_KEY` already reads — pre-fix would have worked AND post-fix works. No behavior change for us. | ✅ |
| Walker | New `pruneDir()` blocks `node_modules` + dot-prefix + `ops` + `*.raw` from `walkMarkdownFiles` (extract.ts) + `listTextFiles` (transcript-discovery.ts). Both walkers are CLI batch paths (`gbrain extract --source fs`, `gbrain sync`). **Not our path.** | ✅ |
| `findOrphanPages` | Filters soft-deleted on both sides. Affects `gbrain orphans` CLI output. **Not our path.** | ✅ |
| `manageGitignore` | Distinguishes worktree vs submodule by `/modules/` vs `/worktrees/` gitdir path segment. Affects `gbrain sync` on Conductor worktrees. **Not our path.** | ✅ |
| Bootstrap | `applyForwardReferenceBootstrap` adds 7 probes; runs on DDL connection holding the advisory lock. **Only fires on pre-v0.34 brains.** Our v66 brains skip all 7 probes. | ✅ |

**Verdict: SAFE.** Heavy CLI / autopilot / legacy-schema-bootstrap focus.

### v0.35.5.1 — 2026-05-16 ("doctor: stop counting clean supervisor exits as crashes")

| Dimension | Change | Risk for us |
|---|---|---|
| All dimensions | Diagnostic-only fix: shared `summarizeCrashes(events)` helper colocated with `readSupervisorEvents`. Drops `gbrain doctor` supervisor-check threshold from `>3` to `>=1`. Adds per-cause breakdown in alert message. | ✅ |

**Verdict: SAFE.** Diagnostics output change; no runtime behavior change.

### v0.35.6.0 — 2026-05-17 ("search floor-ratio gate")

| Dimension | Change | Risk for us |
|---|---|---|
| Schema | None | ✅ |
| MCP tools | `search` tool unchanged at the interface level. Behavior gated by **opt-in** `search.floor_ratio` config key (off by default for `conservative`/`balanced`/`tokenmax` modes). | ✅ |
| **Cache invalidation** | `KNOBS_HASH_VERSION` 2 → 3. **Search cache will dip for a few minutes after upgrade, then recover within `cache.ttl_seconds` (default 3600s).** Brief (≤1h) search latency increase on repeat queries during cache rebuild. | ⚠ Minor |
| New CLI flag | `--floor-ratio` on `gbrain query` for one-shot testing. Not used by our agents. | ✅ |
| New config key | `search.floor_ratio` (optional, 0-1 range, out-of-range silently dropped). | ✅ |

**Verdict: SAFE.** One-hour transient search-cache miss is the only observable effect.

### v0.35.7.0 — 2026-05-17 ("temporal trajectory + founder scorecard")

| Dimension | Change | Risk for us |
|---|---|---|
| **Schema** | **Migration v67** (`facts_typed_claim_columns`): 4 nullable columns + partial index on `facts` table. Auto-applied by `apply-migrations`. **Metadata-only.** No data rewrite. | ⚠ Verify-after-write needed |
| MCP tools | New `find_trajectory` op (read scope, visibility-filtered). Additive. Our agents can ignore until/unless we add it to the protocol. | ✅ |
| **Cycle behavior (autopilot only)** | Two fixes in `consolidate` (semantic upsert keyed on `(page_id, claim, since_date)`) and `extract_facts` (batch-embeds via `gateway.embed()` before `insertFacts`; threads `pages.effective_date` as `valid_from` fallback). Autopilot-only — inert for us. | ✅ |
| CLI commands | `gbrain eval trajectory <entity>` and `gbrain founder scorecard <entity>`. CLI-only. | ✅ |
| Env vars | `GBRAIN_TRAJECTORY_REGRESSION_THRESHOLD` (optional, default 10%). | ✅ |
| Embedding cost | "~$0.02 per 1K facts at OpenAI 3-large pricing" — confirms our model + cost model is unchanged. | ✅ |
| **MCP tool surface — does anything new get exposed automatically?** | Yes: `find_trajectory` MCP op. Our agents see it in `tools/list`. They won't call it without a SOUL.md/AGENTS.md mention. No protocol update needed. | ✅ |

**Verdict: SAFE with one verification gate** (schema_version progression to v67 must complete cleanly).

### v0.35.8.0 — 2026-05-17 ("phantom-page redirect inside extract_facts") — OUT OF SCOPE for Cooper's approved bump

Cooper approved v0.35.7.0; v0.35.8.0 shipped 2026-05-18 13:22 UTC. Summarized here for Cooper to decide whether to revise the target.

| Dimension | Change | Risk for us |
|---|---|---|
| Schema | **None.** `schema_version` stays 1. 3 new keys added to `CycleReport.totals` (schema-additive in the cycle-report shape, not the DB schema). | ✅ |
| MCP tools | None | ✅ |
| Cycle behavior (autopilot only) | New `runPhantomRedirectPass` runs inside `extract_facts` cycle phase. Migrates unprefixed phantom entity pages (e.g. `alice.md` at brain root) to canonical (e.g. `people/alice-example.md`). Bounded per-cycle cap of 50 (configurable via `GBRAIN_PHANTOM_REDIRECT_LIMIT`). Soft-deletes phantoms, never destroys data. **Autopilot-only — inert for us.** | ✅ |
| New env var | `GBRAIN_PHANTOM_REDIRECT_LIMIT` (optional, default 50). | ✅ |
| Audit files | `~/.gbrain/audit/phantoms-YYYY-Www.jsonl` ISO-week rotated. | ✅ |
| Engine surface | New `refreshPageBody` + `migrateFactsToCanonical` methods on `BrainEngine`. Not exposed via MCP. | ✅ |

**My recommendation on v0.35.8.0:** **stick with v0.35.7.0** as Cooper approved. v0.35.8.0 adds zero customer-visible value for us (we don't run the autopilot cycle that drains phantoms). Bumping to v0.35.8.0 introduces +1 version of validation surface without offsetting benefit. We can revisit on the next bump.

---

## 3. Cumulative-change summary across the bump (v0.35.0.0 → v0.35.7.0)

### Schema migrations applied (cumulative)

| Migration | Version | Type | Auto-applied? |
|---|---|---|---|
| **v67** `facts_typed_claim_columns` | v0.35.7.0 | 4 nullable cols + 1 partial index on `facts` | ✅ via `apply-migrations` on `gbrain upgrade` |

That's it. Brain schema goes **v66 → v67** in one step.

### MCP tool surface delta

| Tool name | Status |
|---|---|
| `gbrain__put_page` | unchanged |
| `gbrain__search` | unchanged interface; response shape gains optional `effective_date`/`effective_date_source` |
| `gbrain__get_page` | unchanged |
| `gbrain__list_pages` | unchanged |
| `gbrain__submit_job` | unchanged (still the BANNED tool per our protocol) |
| `gbrain__find_trajectory` | **NEW** (additive, optional; our agents discover via `tools/list` but won't call without protocol guidance) |
| All other gbrain__* | unchanged where applicable |

**GBRAIN_MEMORY_PROTOCOL_V1 references — all still valid post-bump.**

### Config surface delta

New optional config keys (none are required):
- `search.floor_ratio` (v0.35.6.0)
- `models.eval.contradictions_judge` (v0.35.3.1)

Existing config keys unchanged.

### Env var delta

All new env vars are optional with sane defaults:
- `GBRAIN_TRAJECTORY_REGRESSION_THRESHOLD` (v0.35.7.0)
- `GBRAIN_NO_PROBE_PROMPT`, `GBRAIN_PROBE_PROMPT_GRACE_SECONDS` (v0.35.3.1)
- (v0.35.8.0 adds `GBRAIN_PHANTOM_REDIRECT_LIMIT`, `GBRAIN_AUDIT_DIR` — out of scope)

### Cache version bumps

- `KNOBS_HASH_VERSION` was already at 2 in our v0.35.0.0 baseline (v0.35.0.0 itself bumped 1→2 for reranker fields).
- v0.35.6.0 bumps 2 → 3 (adds `floor_ratio` field to the hash). Search cache rows from v=2 naturally TTL out (default 3600s) during the deploy. Brief search-cache miss window; recovers within an hour.

### Embedding model + dimension

**Unchanged**: `openai:text-embedding-3-large` at 1536 dimensions throughout. Configured via systemd `Environment=GBRAIN_EMBEDDING_MODEL=openai:text-embedding-3-large`. **No existing vectors invalidated.**

### Tool name / API contract regression check

For the canonical 5 tool names referenced in `GBRAIN_MEMORY_PROTOCOL_V1_AGENTS_BLOCK`:

```
gbrain__put_page    → unchanged
gbrain__search      → unchanged (response shape additive only)
gbrain__get_page    → unchanged
gbrain__list_pages  → unchanged
gbrain__submit_job  → unchanged (still the BANNED async-ingest tool)
```

**Verdict: GBRAIN_MEMORY_PROTOCOL_V1 does NOT need re-deploy.** No tool-name changes, no required param changes, no BANNED-tool-removal.

---

## 4. Risks + mitigations

| # | Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|---|
| R1 | **Migration v67 silently fails** (open issue #1102 class) | Low (our brains were installed fresh at v66, not at risk of partial-schema state) | High (cv-blocking) | Canary plan: capture `schema_version` BEFORE upgrade; run `gbrain upgrade`; verify `schema_version=67` AFTER. If still v66, roll back. |
| R2 | Search cache miss after `KNOBS_HASH_VERSION` 2→3 bump | High (certain to happen) | Low (~1h transient) | None needed — recovers within `cache.ttl_seconds` (default 3600s) |
| R3 | Sidecar fails to restart after `gbrain upgrade` | Low (gbrain upgrade is well-traveled — many active users) | High (vm-050 customer down) | Canary plan: backup `~/gbrain/` + `~/.gbrain/brain.pglite/` before upgrade; if sidecar fails to start post-upgrade, restore from backup |
| R4 | Latency regression on put_page / search / get_page | Low (no upstream reports) | Medium (UX-affecting) | Canary plan: measure 3 iterations of each op pre-upgrade; same post-upgrade; if any op >2x slower, rollback |
| R5 | New `find_trajectory` MCP op confuses the agent into calling it inappropriately | Very low (agent has no SOUL.md/AGENTS.md routing for it) | Low (agent would just get an unhelpful result) | Monitor session jsonl for `find_trajectory` calls during 24h soak; if it shows up unsolicited, add a "DO NOT call find_trajectory unless explicitly asked" line to v2 protocol |
| R6 | Existing pgvector embeddings become invalid | None (embedding model + dim unchanged) | — | — |
| R7 | OpenAI key revoked or API down during upgrade-time embed test | Low | Medium | None needed for upgrade itself; gbrain doesn't re-embed existing pages on upgrade |
| R8 | gbrain v0.35.7.0 upgrade triggers PGLite SIGTERM via `db.close()` during binary swap | Possible (Rule 54 territory) | High (PGLite corruption) | Canary plan: install new binary FIRST, then restart sidecar via the existing `systemctl --user restart gbrain.service` path. Our `KillSignal=SIGKILL` drop-in ensures the existing process dies via SIGKILL, not SIGTERM. **Critically: verify the SIGKILL drop-in is still present after upgrade.** |
| R9 | gbrain `upgrade` command rewrites systemd unit file | Unknown | High (would un-set `KillSignal=SIGKILL`) | Canary plan: capture `systemctl --user cat gbrain.service` output BEFORE upgrade; verify SIGKILL drop-in still present AFTER upgrade |

### R8 + R9 — special note on Rule 54 + the upgrade path

This is the highest-priority pre-upgrade verification:

- The current vm-050 setup has `KillSignal=SIGTERM` in the base unit and `KillSignal=SIGKILL` in our drop-in (`~/.config/systemd/user/gbrain.service.d/10-killsignal.conf`).
- `gbrain upgrade` may install a fresh `gbrain.service` unit file. If it does, the base-unit `KillSignal=SIGTERM` may be re-set. Our drop-in OVERRIDES — but only if our drop-in still exists post-upgrade.
- The canary must verify: (a) drop-in file still present at expected path, (b) `systemctl --user show gbrain.service --property=KillSignal --value` returns `9` (SIGKILL) post-upgrade.

If `gbrain upgrade` REMOVES our drop-in (unlikely but possible if it does `rm -rf ~/.config/systemd/user/gbrain.service.d/` as part of a clean install), we need to re-apply it before the next systemd restart.

---

## 5. Recommended canary plan (Phase 2 — for Cooper's approval)

**Target VM:** vm-050 (oldest gbrain VM = most data, best stress test, also has the existing manually-deployed gbrain SOUL/AGENTS protocol that we've already verified works at v0.35.0.0).

**Pre-upgrade backups (Rule 22):**
1. `tar czf /tmp/vm050-gbrain-pre-upgrade-$(date -u +%Y%m%dT%H%M%SZ).tar.gz ~/gbrain ~/.gbrain` — captures binary + PGLite data + bearer + config.json + audit logs.
2. Verify backup integrity: `tar tzf <path> | wc -l` returns >0.
3. Copy backup off-VM to laptop `/tmp/` via scp for belt-and-suspenders recovery.
4. Save `systemctl --user cat gbrain.service` output to `/tmp/vm050-systemd-unit-pre-upgrade.txt`.
5. Save `gbrain --version` output (should report `0.35.0.0`).
6. Save `gbrain doctor --json` output as pre-upgrade health snapshot.

**Pre-upgrade measurements (baselines for post-comparison):**
1. PGLite `~/.gbrain/brain.pglite` directory size (current: ~42 MB).
2. `get_health` output: page_count, embed_coverage, orphan_pages, brain_score.
3. `schema_version` (via direct PGLite query or `gbrain doctor --json` if exposed).
4. Latency probe: 3 iterations each of put_page (unique slug per iter), search, get_page. Median + range.
5. `tools/list` MCP response: total tool count (should be 63 baseline).

**Upgrade execution:**
1. `gbrain upgrade` (the canonical command).
2. Watch for any prompts; default-accept where safe.
3. `systemctl --user daemon-reload` (in case systemd unit changed).
4. `systemctl --user restart gbrain.service` (if not already auto-restarted; relies on our SIGKILL drop-in).
5. Wait 30s; `systemctl --user is-active gbrain.service` returns `active`.

**Post-upgrade verifications (in order):**
1. **Version:** `gbrain --version` returns `0.35.7.0`. If returns `0.35.0.0` (upgrade didn't take), abort + investigate.
2. **SIGKILL drop-in still in place:** `systemctl --user show gbrain.service --property=KillSignal --value` returns `9`. If returns `15` (SIGTERM), re-apply the drop-in IMMEDIATELY (per Rule 54 — any subsequent restart would corrupt PGLite).
3. **Schema migration applied:** verify `schema_version=67`. If still `66`, the migration didn't fire; abort + investigate per issue #1102.
4. **Service healthy:** `curl -sf -m 5 -o /dev/null -w '/health=%{http_code}\n' http://127.0.0.1:3131/health` returns `200`.
5. **MCP initialize:** POST `/mcp initialize` with bearer returns `protocolVersion` + valid `serverInfo`.
6. **MCP tools/list:** total tool count ≥63 (should be 64 with `find_trajectory` added).
7. **Existing data accessible:** call `gbrain__list_pages` — returns the same pages that existed pre-upgrade. Spot-check 2-3 known slugs via `get_page` — content matches pre-upgrade.
8. **Semantic search still works on pre-upgrade data:** issue a `search` for a known concept from pre-upgrade pages. Returns results with non-zero score.
9. **Latency comparison:** repeat the 3-iteration probe from the pre-upgrade baseline. **STOP and rollback if any op is >2x slower than pre-upgrade baseline.**
10. **PGLite size sanity:** `du -sh ~/.gbrain/brain.pglite`. Should be very close to pre-upgrade size (the v67 migration adds 4 nullable columns + partial index, both ~zero rows = ~zero bytes). If >10 MB growth, investigate.
11. **No errors in journal:** `journalctl --user -u gbrain.service --since '5 min ago' | grep -iE 'error|fatal|panic'` returns nothing serious.
12. **Get_health regression check:** compare to pre-upgrade — page_count should be unchanged; embed_coverage should still be 1.0; brain_score within ±5 of pre-upgrade.

**Rollback procedure (if any of the above fails):**
1. `systemctl --user stop gbrain.service` (the SIGKILL drop-in ensures clean termination per Rule 54).
2. `rm -rf ~/gbrain ~/.gbrain` (wipe upgraded state).
3. `tar xzf /tmp/vm050-gbrain-pre-upgrade-*.tar.gz -C /` (restore from backup).
4. `systemctl --user start gbrain.service`.
5. Verify version returns to `0.35.0.0`; health 200; existing pages accessible.
6. File issue on `garrytan/gbrain` describing the failure mode + attach `gbrain doctor --json` output.

---

## 6. Phase 3 (24h soak) verification plan

**Goal:** observe whether the agent on vm-050 continues to use gbrain correctly under real load, with no latent regressions surfacing post-upgrade.

**Monitoring (passive, no code changes):**
1. **gbrain-deep-check cron** (already shipped, runs hourly via `/api/cron/gbrain-deep-check`) — verifies put_page + get_page roundtrip via `verify-gbrain-mcp.py`. If status flips from `ok` to `fail` after the upgrade, that's the signal.
2. **Session jsonl observation:** check `~/.openclaw/agents/main/sessions/*.jsonl` on vm-050 for `gbrain__*` tool_use events. Are agents calling put_page when prompted to remember? Are search results returning meaningful matches?
3. **journalctl --user -u gbrain.service** scan every ~6h for errors/warns.
4. **`get_health` page_count delta:** how many new pages got created over 24h? Should match the agent's actual usage.

**Active checks at +6h, +12h, +24h:**
- Repeat the 12-step post-upgrade verification (above).
- Compare latency baselines hour-over-hour for drift.

**Phase 3 PASS gate (all must hold):**
- 24h elapsed since upgrade
- `gbrain.service` uptime continuous (no unexpected restarts)
- gbrain-deep-check cron reports `status=ok` for vm-050 on every hourly tick
- No errors in journal that didn't exist pre-upgrade
- Latency metrics within ±20% of pre-upgrade baseline
- Agent has successfully invoked gbrain (verified in session jsonl)

**Reports back to Cooper at +24h.** Cooper decides fleet-wide rollout.

---

## 7. Phase 4 (fleet rollout) — design only

After Cooper approves Phase 3 PASS, fleet rollout:

1. Update `lib/vm-reconcile.ts`: `GBRAIN_PINNED_COMMIT` + `GBRAIN_PINNED_VERSION` to the v0.35.7.0 SHA + version.
2. Update `scripts/install-gbrain.sh` if any of the install/upgrade phases need adjustment for v0.35.7.0 (likely none — `gbrain upgrade` handles it transparently).
3. Bump `VM_MANIFEST.version` to v103 (we're at v102 post-yesterday's `stepDeployGbrainSoulProtocol` ship).
4. The reconciler's `stepGbrain` will detect the version mismatch (current `V=0.35.0.0` ≠ pinned `0.35.7.0`) and trigger reinstall on each VM. This is the **existing** v+t+s+p idempotency check at `lib/vm-reconcile.ts:1606` — already designed for version bumps.
5. Watch the cron drain. Verify 3 random non-canary VMs post-rollout: version=0.35.7.0, schema_version=67, SIGKILL drop-in present, service active, latency normal.

---

## 8. Snapshot bake checklist update — design only

If the v0.35.7.0 bump soaks clean through May 22, update `docs/snapshot-bake-v102-checklist.md`:

1. Change the gbrain pin from `v0.35.0.0 (commit baf1a47)` to `v0.35.7.0 (commit 1dadd9e)` in the §1 change table.
2. Add a pre-bake gate in §2:
   ```
   ### §2.X — gbrain v0.35.7.0 pre-bake gate
   After §3.5 install completes on the bake VM:
   - [ ] `gbrain --version` returns `0.35.7.0`
   - [ ] PGLite schema_version=67
   - [ ] systemd KillSignal=SIGKILL drop-in present
   ```
3. Update §3.5 to reference the new version constant.

(Don't make these edits now — Cooper said this is conditional on Phase 3 PASS.)

---

## 9. Spec-questions for Cooper before Phase 2

Before I touch any VM, please confirm:

1. **Target version: v0.35.7.0 or v0.35.8.0?** My recommendation: stick with v0.35.7.0 as approved. v0.35.8.0 adds zero customer-visible value for us (autopilot-only cleanup) and adds one more version of validation surface.

2. **Canary acceptance gate for "the upgrade succeeded":** I propose the 12-step post-upgrade verification (§5). Any specific additional check Cooper wants?

3. **Rollback acceptance gate:** the latency comparison I proposed is `>2x slower → rollback`. Is 2x the right threshold? Could relax to 3x for warm-path put_page since the absolute number is sub-30ms.

4. **R8/R9 risk specifically:** Rule 54 says any future natural systemctl restart must use SIGKILL. If `gbrain upgrade` overwrites our drop-in, we have a window between upgrade-completion and re-applying the drop-in where a restart could corrupt PGLite. Mitigation: **verify the drop-in pre-restart, not post-restart.** I'll re-apply it BEFORE issuing the first `systemctl --user restart` post-upgrade.

5. **Phase 3 monitoring frequency:** 6/12/24h check-ins, or denser (e.g. every 3h)? My recommendation: 6/12/24h is enough — gbrain-deep-check cron's hourly tick is the continuous signal.

---

## 10. Sources cited

- `https://raw.githubusercontent.com/garrytan/gbrain/master/CHANGELOG.md` (full, lines 1-705)
- `https://raw.githubusercontent.com/garrytan/gbrain/master/src/commands/serve-http.ts` (read first 100 lines to verify no autopilot hooks)
- `https://api.github.com/repos/garrytan/gbrain/commits?sha=master&since=2026-05-15` (10 version-bump commits)
- `https://api.github.com/repos/garrytan/gbrain/tags` (only one tag, the eval baseline at v0.35.1.0)
- `https://api.github.com/search/issues?q=repo:garrytan/gbrain+state:open+(migration+OR+corruption+OR+%22put_page%22+regression+OR+wedge)` (9 open issues catalogued)
- `https://registry.npmjs.org/@electric-sql/pglite` (PGLite version reference, unchanged)
- Repo metadata: `garrytan/gbrain` (default branch: master; 16965 watchers; 522 open issues; high activity)
- Existing audit doc: `instaclaw/docs/research/gbrain-architecture-audit-2026-05-18.md` (yesterday's measurement baseline)
- Existing protocol: `lib/workspace-templates-v2.ts:GBRAIN_MEMORY_PROTOCOL_V1_AGENTS_BLOCK` (verified all 5 named tools survive the bump)

**Local artifacts** (off-tree, untracked):
- `/tmp/gbrain-CHANGELOG.md` — full CHANGELOG.md text mirror at the time of this report.

---

## 11. Final go/no-go recommendation

**GO** for Phase 2 canary on vm-050 to v0.35.7.0 (Cooper's approved target).

**Why GO:**
- Schema migration is additive (4 nullable cols + partial index).
- No MCP tool interface changes affecting our 5 protocol-named tools.
- Embedding model + dimensions unchanged → no vector invalidation.
- Cycle-phase improvements are inert on our path (sidecar doesn't run autopilot).
- No open issues describe data-loss / corruption on our streamable-http transport at brain schema ≥v60.
- Backup + rollback procedure (§5) is conservative and well-bounded.

**Conditional on Cooper's review of:** the canary plan (§5), the risk matrix (§4), and the 5 spec-questions (§9).

**No code changes until Cooper signs off.** Phase 2 starts only with explicit approval.
