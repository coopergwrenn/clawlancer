# gbrain routing architecture — decision doc

**Date**: 2026-05-19
**Status**: Analysis & recommendation. NO code yet.
**Companion**: [`gbrain-soul-routing-3-surface-analysis-2026-05-19.md`](./gbrain-soul-routing-3-surface-analysis-2026-05-19.md) — the gbrain terminal's existing 597-line proposal for `stepDeployGbrainSoulRouting` (v106). This doc takes a position on that proposal.

---

## TL;DR

1. **Architecturally, AGENTS.md is the right home for gbrain routing.** It's platform-managed operating-manual content; SOUL.md is user-customizable identity. The gbrain terminal's PRD adds duplicate routing to SOUL.md.
2. **Tactically, endorse the gbrain terminal's PRD anyway.** Esmeralda is in 11 days. The PRD is surgical, drift-aware, partner-gated, low-risk. The contradictory routing it eliminates (`MEMORY.md-first` in SOUL.md vs `gbrain-first` in AGENTS.md) is a real bug on 8 paying-customer VMs today.
3. **Track the duplication as P1 cleanup for post-Esmeralda.** Consolidate to AGENTS.md only; remove `## Memory Persistence (CRITICAL)` from SOUL.md entirely (across all 146 VMs, not just gbrain ones). Separate PR, separate validation.
4. **vm-050's SOUL.md is NOT structurally better than the AGENTS.md routing.** 13 gbrain mentions in vm-050's SOUL section vs 18 in canonical AGENTS block. The AGENTS block is more structured (8 sub-headers vs 1) and more comprehensive (adds "Proactive use" + "What goes where" table). vm-050 is the OUTLIER to canonicalize away from, not the gold standard to match.
5. **`MEMORY_FILING_SYSTEM_V2` does not exist as a constant or marker.** The string only appears as a `grep -c` sentinel inside `_push_gbrain_fix.ts` — it's checking whether vm-050's hand-deployed file has been tagged with a V2 marker. Cooper's mental model is right, the name is a misnomer.
6. **Two env-var gates must land in the bake checklist as P0**: `RECONCILE_SOUL_MIGRATION_ENABLED=true` (default OFF) and `GBRAIN_INSTALL_ENABLED=true` (currently set in prod, but the bake VM is partner=null so stepGbrain gates out — needs explicit partner-tag handling).
7. **`SOUL_MD_MEMORY_FILING_SYSTEM` (V1 supplement) should NOT be updated to mention gbrain.** It's a non-partner-gated supplement appended to every VM's SOUL.md. Adding gbrain language there would lie to the 137 non-gbrain VMs about tools they don't have.

---

## Decision matrix — what's Cooper's call vs determinable from code

| Decision | Who decides | Why |
|---|---|---|
| Endorse PRD v106 plan vs alternative single-source-AGENTS approach | **Cooper** | Trade-off is "ship 11 days before Esmeralda with known tech debt" vs "ship a deeper refactor that touches 146 VMs" — risk/timing call, not architectural |
| Whether to bake at `partner=edge_city` or widen `GBRAIN_PARTNER_ALLOWLIST` | **Cooper** | Strategic — do non-edge users get gbrain? Cost (memory + tokens) vs feature parity |
| Whether `RECONCILE_SOUL_MIGRATION_ENABLED` flips to default-true during bake | **Cooper** | Affects whether snapshot ships with V1 or V2 templates — strategic timing call |
| Drift-check semantics (PRD Open Q1) — sha-pin vs string-detect | Determinable from code | Recommendation: string-detect (`"gbrain__" in section`). More durable across future template bumps |
| Whether to keep BOTH SOUL.md and AGENTS.md gbrain blocks long-term (PRD Open Q4) | **Cooper** (for now) → P1 cleanup later | Endorse "both" for v106 (PRD's stance); track consolidation as P1 |
| Whether `configureOpenClaw` should call `injectGbrainSoulRoutingV1` | Determinable from code | Yes — closes the 3-5 min race window between assignment and first reconcile |
| Whether vm-050's hand-deploy should be canonicalized into the codebase | Determinable from code | Effectively yes — PRD's `GBRAIN_SOUL_ROUTING_V1_SECTION` constant IS vm-050's block. Drift settled by canonicalization. |

---

## Question 1: where should gbrain routing live?

### Functional answer

It doesn't matter for the agent's behavior. OpenClaw loads both `SOUL.md` and `AGENTS.md` as upfront context (`VALID_BOOTSTRAP_NAMES` includes both). The agent sees the union of their content on every session start. Putting routing in one vs the other vs both produces the same behavior, given equivalent content.

### Architectural answer

`AGENTS.md` is the correct home. Three reasons:

1. **Semantic role**: SOUL.md is "who you are" (identity, persona, user-customizable). AGENTS.md is "how you work" (operating manual, platform-managed). gbrain is a tool — operating-manual material. Putting routing in SOUL.md mixes platform concerns into identity content, which conflicts with the user-customization story.

2. **Drift management**:
   - SOUL.md is `create_if_missing` for the user (they customize the `## My Identity` section, learned preferences below the cache boundary, etc.). The reconciler patches SOUL.md surgically via marker-bounded blocks (Identity Patch v89, Platform V2 v91, Partner Stubs v92, etc.). Each patch increases the per-VM diff against the canonical template.
   - AGENTS.md V2 in the current code is fully template-driven (`WORKSPACE_AGENTS_MD_V2` interpolates `${GBRAIN_MEMORY_PROTOCOL_V1_AGENTS_BLOCK}` at module-load). Reconciler-owned content; cleaner to manage.
   - **The PRD's proposal adds a NEW patch family to SOUL.md.** Net effect: SOUL.md per-VM state diverges further from the canonical template.

3. **Content positioning vs cache boundary**:
   - V1 `WORKSPACE_SOUL_MD`: `OPENCLAW_CACHE_BOUNDARY` is at line 4280. The obsolete `## Memory Persistence (CRITICAL)` section starts at line 4297 — **below the boundary**.
   - "Below the boundary" means: re-tokenized every turn (no cache hit), but doesn't invalidate the static prefix above. Cost = full tokens per turn for that section.
   - For STATIC platform routing (gbrain protocol, never user-edited), the cache-efficient position is ABOVE the boundary. AGENTS.md doesn't have a cache boundary (it loads as a whole file in the static prefix per OpenClaw's bootstrap loader), so its content IS in the cached prefix. **AGENTS.md is the cache-efficient home for static platform routing.**

### Behavioral diff: vm-050 vs the other 8 — is there one?

**No material behavioral difference**, given the canonical AGENTS.md block is structurally richer than vm-050's SOUL.md section.

Side-by-side:

| Property | vm-050 SOUL.md mempersist section | canonical `GBRAIN_MEMORY_PROTOCOL_V1_AGENTS_BLOCK` |
|---|---|---|
| Size (bytes) | 3,144 | 4,259 |
| `gbrain` mentions | 13 | **18** |
| Top-level header | 1 (`## Memory Persistence (CRITICAL)`) | 1 (`## Memory Protocol — gbrain (PRIMARY long-term memory)`) |
| Sub-headers | 0 | **8** (`### Required behavior`, `### STORE`, `### RETRIEVE`, `### NEVER`, `### Banned patterns`, `### If gbrain is unavailable`, `### Proactive use`, `### What goes where`) |
| Anti-hallucination directive | Yes (banned patterns list) | Yes (more explicit "redo the work for real" framing) |
| `gbrain__submit_job` warning | Yes (single paragraph) | Yes (dedicated `### NEVER` section + bottom-table reinforcement) |
| "If gbrain is unavailable" handling | Yes (one line) | Yes (dedicated section) |
| Proactive-use guidance | No | **Yes (dedicated section)** |
| What-goes-where table | No | **Yes (7-row table)** |
| Read-at-session-start guidance | Yes | No (handled elsewhere in AGENTS.md V2) |
| Format-of-MEMORY.md entries guidance | No | No |

The other 8 edge VMs (with canonical AGENTS.md block only) actually have **richer, more structured gbrain routing** than vm-050 does (with both SOUL.md and AGENTS.md). The PRD's "make the other 8 match vm-050" framing is misleading — what it really does is **canonicalize vm-050's section into the codebase, then deploy it to the other 8**. After the PR lands, all 9 VMs will have:

- The AGENTS.md V2 block (richer, structured) — already there on all 9
- A SOUL.md `GBRAIN_SOUL_ROUTING_V1_SECTION` block (compact, prose-heavy) — newly added to 8, replaced on vm-050

The duplication is the architectural concern. The behavioral payoff is small: agent sees gbrain routing twice instead of once. Both versions are structurally consistent (no contradictions), so the duplication is noise-only, not behavior-breaking.

### Recommendation

**Endorse the PRD's "both" approach for v106. Open a P1 cleanup PR for post-Esmeralda to consolidate to AGENTS.md only.**

Why endorse despite the architectural concern:
- 11 days to Esmeralda. The PRD is surgical, validated against 9 SOUL.md samples, has a drift-check, mirrors a proven pattern.
- The single-source-AGENTS approach (my architectural preference) requires updating `WORKSPACE_SOUL_MD` to drop the section entirely, which affects 137 non-gbrain VMs (they have the section today and it's semantically correct for their no-gbrain state). Bigger blast radius, more validation.
- The PRD's `GBRAIN_SOUL_ROUTING_V1_SECTION` constant IS vm-050's content, which closes the drift. After v106, no VM has off-codebase content.

Why track the cleanup:
- Two sources of truth that overlap on ~80% of content. Drift over time is inevitable.
- ~6.6KB more in the agent's bootstrap context across SOUL+AGENTS (3.4KB SOUL block × cache-prefix cost; the AGENTS block is in the cached prefix). For 146 paying customers × thousands of turns, this is real spend.
- The architectural model (SOUL=identity, AGENTS=operating manual) is the right separation. Restoring it post-Esmeralda is structural debt service.

### Downstream changes if Cooper endorses the PRD

The PRD already enumerates the 4 files. Recap with cross-references:

1. **`instaclaw/lib/workspace-templates-v2.ts`** — add `GBRAIN_SOUL_ROUTING_V1_BEGIN`/`_END` markers, `GBRAIN_SOUL_ROUTING_V1_SECTION` constant (~3.4KB, from vm-050 mempersist), `injectGbrainSoulRoutingV1(text)` helper. Marker name `<!-- GBRAIN_SOUL_ROUTING_V1 -->`. PRD §"Files to change (4)" point 1.

2. **`instaclaw/lib/vm-reconcile.ts`** — new `stepDeployGbrainSoulRouting` near line 645 (right after `stepDeployGbrainSoulProtocol` at line 643). REPLACE pattern with drift-check (sha-pin OR string-detect — see Open Q1 below). Per Rule 39, push to `result.warnings` on Python failure / SSH issue; push to `result.errors` only on verify-after-write fail (so cv-bump is held only on truly-broken state, not on transient skips). PRD §"Files to change (4)" point 2.

3. **`instaclaw/lib/ssh.ts`** — `configureOpenClaw` post-assembly injection at line 6095. Gate: `vm.partner ∈ GBRAIN_PARTNER_ALLOWLIST && process.env.GBRAIN_INSTALL_ENABLED === "true"`. Closes the 3-5 min race window between VM assignment and first reconcile tick. PRD §"Files to change (4)" point 3.

4. **`instaclaw/lib/vm-manifest.ts`** — bump `version: 105 → 106`. Docblock entry for v106 (PRD has a draft at §"Changelog entry"). Per CLAUDE.md version-bump policy ([just landed in `373e408c`](../../../CLAUDE.md#version-bump-policy-when-to-bump-vm_manifestversion)), this is **MUST bump** because (a) new reconciler step, (b) `files[]` arguably unchanged but reconciler behavior changes.

5. **`scripts/_coverage-gbrain-soul-routing.ts`** (new, Rule 27) — SSH-grep `GBRAIN_SOUL_ROUTING_V1` across all healthy+assigned edge_city VMs. Print `N/9 (100%)`. Operator runs after v106 rollout.

6. **`scripts/_test-gbrain-soul-routing-inject.ts`** (new, Rule 31) — 5 synthetic cases per PRD §"Validation steps before deploy". Run BEFORE deploy.

7. **`CLAUDE.md` Manifest Version Changelog** — add v106 entry (mirrors the docblock).

8. **`snapshot-bake-v105-checklist.md`** — rename to v106 + add the gbrain env-var gates as P0 pre-flight (see Question 3 below).

### My one pushback on the PRD

**Replace the sha256-pinned drift-check with string-detect-based.**

PRD §"Python transform" hardcodes `KNOWN_VANILLA_SHA = "6010222d370f..."` and `KNOWN_VM050_SHA = "857b749d6187..."`. This is fragile to:
- Any future bump of `WORKSPACE_SOUL_MD`'s `## Memory Persistence (CRITICAL)` section (the vanilla sha changes; PRD's script would silently never replace)
- Any agent that edits the section even slightly (sha changes; PRD's script skips; operator needs to triage)

**Better approach**: detect drift by content semantics, not by sha equality.

```python
# In the section content, look for OBSOLETE markers OR the new marker.
HAS_NEW_MARKER = GBRAIN_SOUL_ROUTING_V1_BEGIN in current_section
HAS_OBSOLETE_MEMORY_MD_FIRST = ("MEMORY.md" in current_section
                                  and "gbrain__" not in current_section)

if HAS_NEW_MARKER:
    out({"status": "already-deployed"})   # idempotent

if HAS_OBSOLETE_MEMORY_MD_FIRST:
    # Safe to replace — section is the canonical pre-gbrain MEMORY.md-first version
    do_replace()

# Mixed state (user edited; contains gbrain references but no marker) — escalate
out({"status": "drift_detected", "section_size": len(current_section)})
```

This is what the gbrain terminal's PRD probably wants but didn't formalize. The sha-pin version is more conservative (fewer false positives) but the string-detect version is more durable. **My recommendation for the PR; Cooper can override.**

---

## Question 2: existing fleet (~148 VMs)

### Who has gbrain today?

Per the gbrain terminal's PRD §"Census" (data as of 2026-05-19 16:00 UTC):

```
Total healthy+assigned VMs: 146
By partner:
  none:        137  (no gbrain, never had it)
  edge_city:     9  (all on gbrain v0.36.3.0 commit 1d5f69f)
By config_version:
  cv=105:      146  (every VM caught up to current manifest)
```

`GBRAIN_PARTNER_ALLOWLIST` = `new Set(["edge_city"])` only (`lib/vm-reconcile.ts:128`).

`GBRAIN_INSTALL_ENABLED=true` is set in Vercel production env (proven empirically by 9 edge VMs having gbrain installed — the reconciler path requires both the env var AND a partner-allowlist match).

### Do all 9 edge VMs have the AGENTS.md routing block from v102?

**Yes — all 9 have `GBRAIN_MEMORY_PROTOCOL_V1` marker in AGENTS.md** (PRD §"AGENTS.md GBRAIN_MEMORY_PROTOCOL_V1 marker presence"). vm-050 redundantly has the same block twice (once from `_push_gbrain_fix.ts` hand-deploy, once from v102 reconciler step). Harmless redundancy.

### Is the canonical AGENTS.md block adequate, or does it need to be richer?

**The canonical AGENTS.md block is RICHER than vm-050's SOUL.md section.** 18 vs 13 gbrain mentions. 8 sub-headers vs 1. Adds Proactive-use and What-goes-where sections that vm-050's section doesn't have.

The user's earlier framing — "vm-050 has 9 mentions vs the other 8 with 5 mentions" — was counting `gbrain__put_page` specifically across both files. vm-050 has more because content is duplicated (SOUL + AGENTS). The other 8 have fewer because the same content lives in AGENTS only. Both routes the agent identically.

**Action**: no enhancement needed to the canonical AGENTS block. It's already the richer version. The PRD's "canonicalize vm-050's section as `GBRAIN_SOUL_ROUTING_V1_SECTION`" doesn't make the routing more capable — it just deploys the same-effective routing to a second location.

### Diff: what does vm-050 have that the other 8 don't?

Today (pre-v106):

- **In SOUL.md**: vm-050 has a 3,144-byte gbrain-first `## Memory Persistence (CRITICAL)` section. The other 8 have a 3,446-byte MEMORY.md-first version of the same header (bit-identical across all 8, sha `6010222d370f`). vm-050's version is SMALLER because the gbrain version is more compact.
- **In AGENTS.md**: all 9 identical (canonical `GBRAIN_MEMORY_PROTOCOL_V1_AGENTS_BLOCK` from v102, plus vm-050 has one extra hand-deployed copy).

The agent's behavior:
- vm-050: reads gbrain-first routing in SOUL, gbrain-first routing in AGENTS. Coherent, redundant.
- Other 8: reads MEMORY.md-first routing in SOUL, gbrain-first routing in AGENTS. **Contradictory.** This is the bug the PRD addresses.

The PRD's framing is correct: the other 8 have CONTRADICTORY routing today. vm-050 doesn't. The fix is to make the other 8 match vm-050's gbrain-coherent state.

The architectural concern (per Q1) is that "match vm-050" canonicalizes the duplication. An alternative is "make all 9 match the NON-CONTRADICTORY state without duplication" — which means removing the SOUL.md memory section entirely and letting AGENTS.md own routing. But that's the P1-cleanup path; not the v106 ship.

---

## Question 3: snapshot bake (May 23)

### Two P0 env-var gates for the bake checklist

Both gate steps default OFF in code. Both need to be confirmed during the bake reconcile:

**Gate A — `RECONCILE_SOUL_MIGRATION_ENABLED=true`** (`lib/vm-reconcile.ts:6905-6908`):
```ts
if (process.env.RECONCILE_SOUL_MIGRATION_ENABLED !== "true") {
  return;
}
```
Without this, `stepMigrateSoulV2` returns immediately. Bake VM keeps V1 templates → V1 SOUL.md + V1 AGENTS.md → V1 AGENTS.md has NO gbrain routing (zero gbrain mentions in V1 AGENTS.md, verified).

The v102 step (`stepDeployGbrainSoulProtocol`) still appends the gbrain block to V1 AGENTS.md via insert-before-`## Memory Protocol` fallback (`append at EOF` if header missing). But this only fires if `gbrain.service` is active — which requires Gate B.

**Gate B — `GBRAIN_INSTALL_ENABLED=true` AND partner allowlist match** (`lib/vm-reconcile.ts:1614-1624`):
```ts
if (!vm.partner || !GBRAIN_PARTNER_ALLOWLIST.has(vm.partner)) return;  // partner
if (strict) return;                                                     // strict mode
if (process.env.GBRAIN_INSTALL_ENABLED !== "true") return;             // env flag
```
The bake VM is a fresh nanode with `partner=null`. Even with the env var set, the partner gate skips. Bake VM gets no gbrain installed.

### Two strategic decisions for Cooper

**Decision 3.1**: should the bake VM be partner-tagged as `edge_city` during the bake?

| Option | Implication |
|---|---|
| Tag as `edge_city` during bake | Bake VM installs gbrain v0.36.3.0 via stepGbrain. Snapshot ships with gbrain pre-installed. Fresh VMs from snapshot have gbrain immediately at boot. **But:** all 137 non-gbrain VMs in production are provisioned from this snapshot — they'll have gbrain installed AND running by default, then `configureOpenClaw` doesn't tear it down. We'd have gbrain on 146 VMs (not the intended 9) without explicitly widening the allowlist. |
| Don't tag bake VM | Snapshot doesn't have gbrain. Fresh VMs from snapshot install gbrain on first reconcile tick after assignment (assuming they get assigned to an edge_city user). 3-5 min race window where gbrain isn't yet installed and the SOUL.md still says use MEMORY.md. Covered by the PRD's configureOpenClaw injection (writes the SOUL block at assign time even before gbrain installs). |
| Widen `GBRAIN_PARTNER_ALLOWLIST` to include `null` (and re-tag bake VM appropriately) | Gives gbrain to every paying user, not just edge_city. Strategic feature decision. |

**My recommendation**: don't tag the bake VM (Option 2). The PRD's `configureOpenClaw` injection covers the race window cleanly. Snapshot stays generic; non-gbrain VMs unaffected. If Cooper later widens the allowlist, existing snapshot still works (each VM installs gbrain via reconciler on tick).

**Decision 3.2**: should `RECONCILE_SOUL_MIGRATION_ENABLED=true` during bake?

| Option | Implication |
|---|---|
| Set to `true` during bake | Bake VM ends up on V2 templates (SOUL.md V2 + AGENTS.md V2 + IDENTITY.md). V2 AGENTS.md interpolates the gbrain block at module-load time, so the snapshot's AGENTS.md will literally contain the gbrain block bytes (even though the bake VM has no gbrain installed; the block is a static template). Fresh VMs from snapshot inherit V2 AGENTS.md with the block already present. |
| Leave at default `false` | Bake VM stays on V1 templates. Fresh VMs from snapshot inherit V1 AGENTS.md (no gbrain content). `stepDeployGbrainSoulProtocol` backfills the block on first reconcile, but only if `gbrain.service` is active — which requires Gate B passing. |

The two gates compound. If Gate A is OFF and the bake VM isn't partner-tagged (Option 2 of Decision 3.1), the bake snapshot ships V1 templates with zero gbrain content. Convergence depends entirely on post-assignment reconciler ticks.

**My recommendation**: set `RECONCILE_SOUL_MIGRATION_ENABLED=true` during the bake AND in Vercel production env. The V2 migration has been canary-tested on vm-733 (per the project memory note) with 13/15 behavior pass. Bake-time migration is a controlled environment (single VM, no users), so it's the safest place to flip. Then post-bake, leave it on so all newly-provisioned VMs ship with V2 from the bake snapshot.

### "If we DON'T set the env vars during bake, fresh VMs ship V1 — is V1 adequate?"

**V1 is adequate for non-gbrain VMs (which is what fresh-from-snapshot VMs are until assigned).** V1 AGENTS.md has no gbrain mentions, but it doesn't need them — fresh VMs don't have gbrain installed.

After assignment via `/api/vm/configure`:
- For non-edge users: gbrain isn't installed; V1 AGENTS.md is fine; SOUL.md's MEMORY.md-first guidance is fine.
- For edge_city users: gbrain installs on next reconcile tick (~3 min). v102 step backfills AGENTS.md with the gbrain block via `append-at-EOF` fallback (since V1 AGENTS.md has no `## Memory Protocol` header). PRD's v106 step backfills SOUL.md with `GBRAIN_SOUL_ROUTING_V1` block.

**Race window**: the user's first few messages (before first reconcile tick) could hit the obsolete SOUL.md routing. The PRD's `configureOpenClaw` injection at line 6095 closes this — at assignment time, if `vm.partner ∈ allowlist`, inject the gbrain SOUL block into SOUL.md before write. **This is critical for new edge_city users.**

### Should `SOUL_MD_MEMORY_FILING_SYSTEM` (V1 supplement) be updated to mention gbrain?

**No.** Here's why:

The V1 supplement at `lib/agent-intelligence.ts:903` is concatenated into the SOUL.md for EVERY VM at provision time (`configureOpenClaw` at line 6091-6095), and re-applied to every VM via the reconciler's `files[]` entry (`mode: append_if_marker_absent`, `marker: MEMORY_FILING_SYSTEM`).

It's NOT partner-gated. It lands on all 146 production VMs (the 137 non-gbrain ones included).

If we add gbrain content to it:
- The 137 non-gbrain VMs get gbrain routing that points at tools they don't have. The agent reads "primary fact store = gbrain" but no `gbrain__put_page` MCP tool exists. Agent makes the call, gets `tool not found`, and either falls back to MEMORY.md (correctly per the routing block's "If gbrain is unavailable" clause) or hallucinates a save (incorrectly, per Rule 28 anti-hallucination).
- Cooper's CLAUDE.md Rule 28 says: when describing a capability, make sure it works. The non-gbrain VMs would have a soft-described capability that doesn't actually exist.

**Correct action**: leave `SOUL_MD_MEMORY_FILING_SYSTEM` alone. The partner-gated injection path (PRD's v106 plan) is the right way to give gbrain VMs gbrain routing without lying to non-gbrain VMs.

If/when the allowlist widens to cover all paying users, the supplement can be deprecated entirely (replaced by the partner-gated block which now applies universally).

### Bake checklist additions (proposed text)

Add to `instaclaw/docs/snapshot-bake-v105-checklist.md` (rename to v106 first):

```markdown
### §3.X — gbrain routing env-var gates (P0 pre-flight)

Before running the bake reconcile, confirm these env vars are set on the bake-tooling machine (NOT on the bake VM itself — they gate reconciler behavior, which runs from Vercel/local):

| Env var | Required value | Source of truth | Effect if unset |
|---|---|---|---|
| `RECONCILE_SOUL_MIGRATION_ENABLED` | `"true"` | Vercel prod env + local `.env.local` for bake-tooling | stepMigrateSoulV2 returns immediately. Bake VM stays on V1 templates. |
| `GBRAIN_INSTALL_ENABLED` | `"true"` | Vercel prod env (currently set as of 2026-05-19) | stepGbrain returns immediately. Bake VM doesn't install gbrain. |
| `GBRAIN_PINNED_COMMIT` | `"1d5f69f"` | `lib/vm-reconcile.ts:136` | Required by install-gbrain.sh; install fails if unset. |
| `GBRAIN_PINNED_VERSION` | `"0.36.3.0"` | `lib/vm-reconcile.ts:137` | Required by install-gbrain.sh; install fails if unset. |

**Decision: should the bake VM be partner-tagged as `edge_city`?**

NO (default). Reasons:
1. Snapshot is generic — provisions both gbrain and non-gbrain VMs. Adding gbrain to the snapshot means non-gbrain VMs have it too, but they're not in the allowlist for upkeep, so it'd be unmanaged.
2. The PRD's `configureOpenClaw` injection at assign-time covers the 3-5 min race between assignment and first reconcile.
3. Future widening of GBRAIN_PARTNER_ALLOWLIST will install gbrain via reconciler tick — no snapshot dependency.

**Verification gate**: After bake reconcile completes, before powering off:
```bash
# Confirm V2 templates landed (V1 SOUL.md V1 markers absent, V2 markers present)
grep -q "OPENCLAW_CACHE_BOUNDARY" ~/.openclaw/workspace/SOUL.md && echo "V2 SOUL ✓" || echo "V1 SOUL — bake-blocker"
grep -q "GBRAIN_MEMORY_PROTOCOL_V1" ~/.openclaw/workspace/AGENTS.md && echo "AGENTS gbrain ✓" || echo "missing — bake-blocker"

# Confirm gbrain NOT installed (deliberate: snapshot is generic)
[ "$(systemctl --user is-active gbrain.service 2>&1)" = "inactive" ] || echo "gbrain installed unexpectedly — verify partner=null on bake VM"
```
```

---

## Question 4: new-VM onboarding (post-bake)

### Full assembly sequence (today, pre-v106)

```
User signs up at /signup or /edge-city
  → POST /api/onboarding/save → pending_users row
  → Stripe Checkout → /api/billing/webhook (subscription.created/updated)
  → POST /api/vm/assign
    → assignVM picks ready VM from pool (vm.status='ready', vm.assigned_to=NULL)
    → marks vm.assigned_to=<user.id>, vm.status='assigned'
    → triggers configure flow
  → POST /api/vm/configure
    → configureOpenClaw(ssh, vm)
      → composes SOUL.md = WORKSPACE_SOUL_MD V1 + SOUL_MD_INTELLIGENCE_SUPPLEMENT
                          + SOUL_MD_LEARNED_PREFERENCES + "\n\n"
                          + SOUL_MD_OPERATING_PRINCIPLES + SOUL_MD_MEMORY_FILING_SYSTEM
                            (lib/ssh.ts:6091-6095)
      → writes SOUL.md via base64 + cat (no gbrain content in any of those constants)
      → writes other workspace files (CAPABILITIES.md, EARN.md, MEMORY.md template,
                                       memory/session-log.md template, etc.)
      → atomically writes openclaw.json, .env, auth-profiles.json
      → starts openclaw-gateway via systemctl --user start
      → DB update: gateway_url, gateway_token, telegram_bot_token, health_status='healthy'
    → returns 200 to client; user sees "agent ready"
  → User sends first Telegram message
    → openclaw-gateway loads SOUL.md + AGENTS.md + CAPABILITIES.md + ... as upfront context
    → AGENT'S BOOTSTRAP CONTEXT AT THIS POINT (for edge_city user):
        - SOUL.md: MEMORY.md-first routing (obsolete, no gbrain mentions)
        - AGENTS.md V1 or V2 (depending on env gates): zero gbrain mentions in V1, gbrain block in V2 from template interpolation IF V2 is on
        - gbrain MCP server: not yet wired (gbrain not yet installed)
    → Agent processes message with this context
  → 3-5 min later, Vercel cron /api/cron/reconcile-fleet fires:
    → reconcileVM(ssh, vm)
      → stepGbrain (line 478): installs gbrain v0.36.3.0 (~70-165s)
      → stepFiles (line 492): re-applies marker-based supplements to SOUL.md
      → stepMigrateSoulV2 (line 504, gated): if enabled, migrates V1→V2
      → stepDeployGbrainSoulProtocol (line 643, gate=gbrain.service active): adds
        GBRAIN_MEMORY_PROTOCOL_V1 block to AGENTS.md
      → [PROPOSED] stepDeployGbrainSoulRouting (line 645): adds
        GBRAIN_SOUL_ROUTING_V1 block to SOUL.md, replacing obsolete section
      → bumps config_version
```

### Race window

For a fresh edge_city user, the race window is:
- **Start**: `POST /api/vm/configure` returns 200 (agent appears "ready" to user)
- **End**: first reconcile tick completes stepGbrain + stepDeployGbrainSoulProtocol + stepDeployGbrainSoulRouting

Duration: 0-180s (next reconcile tick fires every 3 min, plus 70-165s for stepGbrain to complete). Worst case: ~5 min from user's first message to gbrain being live.

During the race window:
- WITHOUT PRD changes: agent sees obsolete MEMORY.md-first SOUL routing + no gbrain block in AGENTS.md. Agent files first memory to MEMORY.md per the obsolete guidance.
- WITH PRD's `configureOpenClaw` injection: agent sees gbrain-first SOUL routing from the FIRST message. gbrain tools not yet available, so first `gbrain__put_page` call fails with `tool not found`. Per the routing block's "If gbrain is unavailable" clause, agent should report this honestly and queue the memory.

**Is the race-window degradation acceptable?**

For Esmeralda (9 paying edge users): yes, per PRD §"Race condition analysis". Their first message in a fresh session has a ~3-5 min window where gbrain isn't yet up. The agent's "If gbrain is unavailable" handling is the right response.

**Alternative**: configureOpenClaw could call `stepGbrain` synchronously before returning. This would make assignment slower (+70-165s) but eliminate the race. **Cooper's call** — likely not worth the assignment-latency cost; the configureOpenClaw injection is a clean 90% solution.

### Non-edge_city VMs that might get gbrain later

When `GBRAIN_PARTNER_ALLOWLIST` widens (e.g., adding `consensus_2026`, `eclipse`, or `null` for all paying users):

- Every existing VM matching the new allowlist gets gbrain installed on next reconcile tick (stepGbrain re-runs because the gate now passes; idempotent check via gbrain --version + transport + service active).
- v106's stepDeployGbrainSoulRouting also runs on these VMs (gate = gbrain.service active). The 137 currently-non-gbrain VMs' SOUL.md sections get the drift-check: most should match the vanilla sha (`6010222d370f`), so the replace succeeds.
- Same for AGENTS.md via v102 step.

**No new code path needed for partner widening — the existing reconciler picks it up.** This is the architectural correctness of the current design.

---

## Question 5: vm-050 drift reconciliation

### Current state

vm-050 has hand-deployed content in SOUL.md from `_push_gbrain_fix.ts` (2026-05-17). Specifically:
- SOUL.md `## Memory Persistence (CRITICAL)` section is the gbrain-first 3,144-byte version (sha `857b749d6187...`)
- AGENTS.md has the canonical `GBRAIN_MEMORY_PROTOCOL_V1` block PLUS a hand-deployed extra copy

This content does NOT come from any current template or reconciler step. If vm-050 ever:
- Gets re-provisioned: lost (snapshot doesn't have it)
- Gets reset via the SOUL.md reset path (`lib/ssh.ts:10253` writes WORKSPACE_SOUL_MD): lost
- Gets a future reconciler step that does `mode: "overwrite"` on SOUL.md: lost

This is technical debt.

### Does the PRD resolve it?

**Yes, completely.** The PRD's `GBRAIN_SOUL_ROUTING_V1_SECTION` constant is the canonical version of vm-050's section, codified into `lib/workspace-templates-v2.ts`. After v106 deploys:
- vm-050's SOUL.md gets the canonical version (drift-check sees `857b...` matches `KNOWN_VM050_SHA`, replace fires, vm-050's hand-deployed content is replaced with the same content but now marker-bounded)
- vm-050 no longer has off-codebase content — the marker block IS the codebase content
- Future re-provisions or resets will deploy the same block via the `configureOpenClaw` injection

The PRD §"Why replace vs insert" addresses this explicitly: REPLACE pattern with drift-check is what makes the drift reconcile cleanly.

### Should we canonicalize vm-050's content vs prefer the AGENTS.md block's structure?

**Canonicalize vm-050's exact content** (which is what the PRD does). Reasoning:
- The PRD's `GBRAIN_SOUL_ROUTING_V1_SECTION` is exactly vm-050's section (per PRD §"Files to change (4)" point 1).
- This is what's already proven in production on vm-050 (12 days of behavior).
- The AGENTS.md block stays as-is (more structured, more comprehensive) — it's a different file with a different role.

The "should SOUL.md content match AGENTS.md exactly?" question is the consolidation P1 — not v106.

### Drift acceptance vs reconciliation

For v106: **reconciliation** (canonicalize into codebase, deploy back to vm-050 with marker, remove off-codebase drift).

For the architectural cleanup PR (post-Esmeralda): consider removing the SOUL.md memory section entirely across all 146 VMs, leaving AGENTS.md as single-source. This requires:
- Updating `WORKSPACE_SOUL_MD` to drop the `## Memory Persistence (CRITICAL)` section
- New reconciler step `stepRemoveSoulMemorySection` (or extending v106's stepDeployGbrainSoulRouting with a "remove instead of replace" mode for non-gbrain VMs)
- Confirming AGENTS.md V1 has sufficient memory routing for non-gbrain VMs (today it has a brief `## Memory` section; might need expansion)
- Bigger blast radius (146 VMs vs 9). Hence post-Esmeralda.

---

## Open questions surfaced for Cooper (not in the gbrain terminal's PRD)

These are above-and-beyond what the gbrain terminal flagged. Cooper's call before the PR ships:

**Q-A**: drift-check by sha-pin or string-detect? My recommendation: string-detect (`"gbrain__" not in current_section` → safe to replace). More durable across future template changes.

**Q-B**: should `configureOpenClaw`'s injection synchronously install gbrain before returning, eliminating the 3-5 min race? My recommendation: no — adds 70-165s to assignment latency, and the "If gbrain is unavailable" routing handles the race gracefully. Skip the synchronous install.

**Q-C**: should `RECONCILE_SOUL_MIGRATION_ENABLED` flip to default-true in production AT THE BAKE WINDOW? Right now it's OFF in prod (per the PRD census). Flipping it requires a separate canary plan. My recommendation: turn it on Vercel prod env in the same window as v106 deploy, after vm-050 canary passes 24h soak. This avoids stacking changes.

**Q-D**: should the snapshot bake be deferred until v106 lands and proves stable? Bake is May 23 (4 days). v106 canary + soak + fleet rollout fits in 3-4 days. My recommendation: bake on schedule, v106 lands before the bake completes. If v106 is delayed, bake without v106 — fresh VMs get gbrain routing on first reconcile tick (3-5 min post-assignment), acceptable for the Esmeralda go-live timeline.

**Q-E**: P1 architecture cleanup post-Esmeralda — when? My recommendation: queue for first week of June. Removes the SOUL.md `## Memory Persistence (CRITICAL)` section across all 146 VMs, consolidates routing to AGENTS.md only. Saves ~3.4KB × 146 VMs in cached prompt prefix; restores SOUL=identity / AGENTS=manual architectural separation.

**Q-F**: should `_push_gbrain_fix.ts` (the script that hand-deployed vm-050) be archived now that v106 makes it obsolete? My recommendation: archive after v106 lands and vm-050 is verified converged. The script wrote to `/tmp/vm050-SOUL.md` and `/tmp/vm050-AGENTS.md` — local tmp files that no longer exist. The script alone won't reproduce vm-050's state. Tagging it `.archive` or moving to `scripts/archive/` preserves history without inviting future re-use.

---

## Recommended order of operations

If Cooper endorses the PRD + this doc's flags:

1. **Today/tomorrow** — Cooper reviews this doc + the PRD. Resolves Q-A through Q-F.
2. **Day 1** — gbrain terminal (or this terminal, if owned here) writes the v106 PR:
   - 4 files per PRD §"Files to change (4)"
   - Synthetic test (`_test-gbrain-soul-routing-inject.ts`) — 5 cases
   - Coverage script (`_coverage-gbrain-soul-routing.ts`)
   - Typecheck must pass
3. **Day 2** — one-VM canary on vm-050:
   - Sentinel grep confirms marker present, identity content unchanged
   - 24h soak with journal monitoring
4. **Day 3** — sequential rollout to remaining 8 edge VMs:
   - Per-VM pre/post sha capture for identity content (must be bit-identical)
   - Per-VM marker confirmation
5. **Day 3-4** — `RECONCILE_SOUL_MIGRATION_ENABLED=true` set in Vercel prod env (separate decision per Q-C). Canary on vm-733 (already proven per project memory) extended to 5 more VMs.
6. **Day 4** — snapshot bake on May 23 per the v106 checklist (env vars confirmed, bake VM not partner-tagged, V2 templates verified post-reconcile).
7. **Day 5+** — coverage script runs daily for 7 days, confirming no regression.
8. **Esmeralda May 30** — 9 edge_city VMs in steady state with gbrain routing in both SOUL.md and AGENTS.md.
9. **Post-Esmeralda (June)** — P1 cleanup PR per Q-E.

---

## What's NOT in scope for v106 (so I don't drift from the PRD)

- Updating `SOUL_MD_MEMORY_FILING_SYSTEM` to mention gbrain (would lie to non-gbrain VMs — Rule 28).
- Removing the `## Memory Persistence (CRITICAL)` section from `WORKSPACE_SOUL_MD` (bigger blast radius; P1 cleanup).
- Widening `GBRAIN_PARTNER_ALLOWLIST` beyond `edge_city` (strategic feature decision).
- Consolidating SOUL.md and AGENTS.md gbrain blocks into one (P1 cleanup).
- Moving the `## Memory Persistence (CRITICAL)` section above the OPENCLAW_CACHE_BOUNDARY (cache-efficiency optimization; separate concern).
- Adding fleet-wide P0 alerting on SOUL.md/AGENTS.md content drift (future Rule 27 coverage).

These are all real follow-ups. Tracked here so they don't get lost.

---

## Confidence assessment

- **Architecture analysis**: HIGH. The 4 distinct constants (`WORKSPACE_SOUL_MD`, `WORKSPACE_SOUL_MD_V2`, `WORKSPACE_AGENTS_MD`, `WORKSPACE_AGENTS_MD_V2`) and their interpolation/deployment paths are now mapped end-to-end.
- **gbrain terminal's PRD validity**: HIGH. The PRD is structurally sound, mirrors a proven pattern, has Rule compliance throughout, and handles the race window in `configureOpenClaw`.
- **My pushback (string-detect vs sha-pin)**: MEDIUM. Sha-pin is conservative; string-detect is more durable. Either works for v106; string-detect needs less maintenance across future template bumps. Cooper's call.
- **Bake gate analysis**: HIGH. Both env vars confirmed required, both confirmed default-off in production, both confirmed silently skip without error. The bake checklist absolutely needs them as P0.
- **vm-050 drift reconciliation**: HIGH. PRD's `GBRAIN_SOUL_ROUTING_V1_SECTION` directly codifies vm-050's exact section content, closing the off-codebase drift completely.
- **P1 cleanup plan**: MEDIUM. Direction is right (consolidate to AGENTS.md only), but the specifics (how non-gbrain VMs get memory routing after the SOUL.md section is removed) need more thought when that PR is drafted.

**Recommended next action**: Cooper reviews this doc + the PRD, resolves Q-A through Q-F, then approves implementation of v106 per the PRD's plan (with my string-detect modification if endorsed).
