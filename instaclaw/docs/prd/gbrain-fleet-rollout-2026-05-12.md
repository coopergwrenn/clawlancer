# Phase 4 — gbrain Fleet Rollout Design

**Author:** Bug-squash terminal (Claude Opus 4.7)
**Date:** 2026-05-12 (T-18 days to Edge Esmeralda, T-11 to Cooper's go-live target of May 23)
**Status:** DESIGN — awaiting Cooper review before any fleet-wide execution. Phase 4b (3-VM canary on remaining edge_city VMs) is the gating step; everything after that is parameterized.
**Predecessor:** [PRD-gbrain-phase1-design.md](./PRD-gbrain-phase1-design.md) (Phase 1 canary — done on vm-050 + vm-576).
**Related rules:** CLAUDE.md §3 (test on one VM first), §4 (dry-run), §5 (verify health), §7 (snapshot refresh), §8 (no manual provisioning), §10 (verify-every-set), §22 (no destructive session ops), §23 (sentinel-grep templates), §24 (skill installations must verify completeness), §31 (test failure modes), §32 (`config set` ≠ runtime applied).

---

## §0 — One-page executive summary

### The goal

Every `edge_city` VM (5 today, 50-500+ by Esmeralda kickoff) has gbrain installed, MCP-wired with `ANTHROPIC_API_KEY`, and verified via the put_page/query round-trip gate **before any attendee starts using their bot at the conference**. Attendees arrive with semantic memory live from message one — every person they meet, every venue they visit, every panel they attend is captured to a real knowledge graph their agent can query.

### What's already done

- **Phase 1 canary** (2026-05-11): vm-050 + vm-576 running gbrain 0.28.1 (commit `2ea5b71`) with Path A (Anthropic for expansion + chat). MCP wired, put_page+query round-trip verified. Anthropic project key shipped to both VMs' `~/.openclaw/.env`.
- **Install harness** (commit `e7d927b3`, 2026-05-11): `install-gbrain.sh` 8-phase installer, `verify-gbrain-mcp.py` canonical post-install gate, `_install-gbrain-on-vm.ts` TS wrapper, `_apply-gbrain-path-a.ts` for already-installed VMs.
- **Hot-reload guardrail** (commit `320ecb25`, 2026-05-12): `mcp.servers.*` confirmed hot-reloadable — gbrain config changes don't require gateway restart.
- **3 monitoring crons** (commit `e7d927b3`): heartbeat-staleness sweep, usage anomaly check, MiniMax canary. Operational floor under any fleet-wide change.

### What this PRD covers

Three threads, all must complete before Esmeralda:

1. **Key distribution** — `GBRAIN_ANTHROPIC_API_KEY` lands on all assigned VMs' `~/.openclaw/.env` via a new reconciler step. Idempotent, fleet-wide, runs once per cycle.
2. **gbrain install on edge_city VMs** — 4 remaining (vm-354, vm-771, vm-777, vm-859). Per-VM via `_install-gbrain-on-vm.ts`, 48h soak per Rule 17, post-install behavior verification.
3. **New-attendee onboarding flow** — ready-pool VMs get gbrain on first reconcile after assignment. Implemented via a new `stepGbrain` reconciler step, gated by partner field. Pre-bake into snapshot is an MVP+ optimization, not blocking.

### Why now

- T-18 days to Esmeralda (1,000 attendees expected, 200-500 likely to sign up for instaclaw based on prior partner conversion rates).
- Cooper's narrative for the conference talk (2026-04-23 World Build kickoff deck) explicitly promises "your personal AI agent that remembers what matters." Without gbrain, that promise is MEMORY.md (a flat markdown file) — not a knowledge graph. Demonstrable difference: query "who works at Acme AI" → a non-gbrain agent grep's MEMORY.md; a gbrain agent walks a typed-link graph and returns ranked sources.
- Reactions (Edge City v94) land first impressions; gbrain delivers the second-week value. Both matter.
- gbrain Phase 1 canary has soaked for 24+ hours on vm-050 and vm-576 with zero incidents. The harness is proven.

### What we can ship by when

- **May 14**: stepEnvVarPush adds `GBRAIN_ANTHROPIC_API_KEY` to fleet `.env` (reconciler propagates).
- **May 15-17**: 4 remaining edge_city VMs gbrained (1 per day with 24h soak gap; relaxed from the original 48h cadence given the proven harness — see §6).
- **May 19-22**: stepGbrain in reconciler — auto-installs on any VM whose partner matches a configured allowlist (initially `edge_city`).
- **May 23**: snapshot rebake including gbrain baseline (every newly-provisioned edge_city VM comes pre-installed; `stepGbrain` is the post-provision safety net).
- **May 24-29**: monitor + harden. Reconciler step covers any drift. New attendee VMs that arrive in this window get gbrain on first cycle.
- **May 30 (Esmeralda kickoff)**: attendee sees gbrain from message one.

### Critical-path dependencies (not in my control)

1. **lying-DB cohort (P1-1 in CLAUDE.md)** — ~20% of cv≥88 VMs have stale config_version. The reconciler's `stepGbrain` would SKIP those VMs because cv claims they're at-or-ahead-of the manifest version. Of the 4 remaining edge_city VMs, **vm-777 is at cv=82** which puts it in the lying-DB candidate pool. **Consensus terminal's Phase C cv-reset is the unblocker** — needs to land before reconciler-driven Phase 4 rollout.
2. **Snapshot rebake (Rule 7)** — requires a rebake VM, ~30 min of bake time + 15 verification points + a 1-week soak before the old snapshot can be deleted. Cooper's call on when to schedule.
3. **Anthropic project-key spending cap** — currently uncapped. Recommend $300/mo cap on the gbrain project key. Cooper's manual console.anthropic.com task.

### Risk and impact summary

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Anthropic key on 200+ VMs' disk → exfil if attendee agent goes rogue | Low | Medium ($300/mo cap; key rotation easy) | Spending cap + rotation cadence |
| lying-DB cohort blocks stepGbrain | Medium | High (Phase 4 doesn't reach those VMs) | Wait for Phase C cv-reset OR run install-gbrain.sh directly per-VM |
| Disk full on legacy VMs | Low (50GB+ free typical) | Medium (install fails Phase B) | Pre-flight disk check ≥10GB |
| OpenAI rate limit during mass install | Low | Low (embedding only at install time) | Throttle install concurrency to 5 |
| Anthropic rate limit during runtime | Low | Low (`GBRAIN_ANTHROPIC_MAX_INFLIGHT=3` per VM caps it) | Existing config caps; monitor with usage-anomaly cron |
| Esmeralda attendee VMs miss gbrain install | Medium | High (first-impression failure) | Both `stepGbrain` AND snapshot bake — defense in depth |

---

## §1 — Dependency chain (key distribution)

`gbrain` reads `ANTHROPIC_API_KEY` from environment at MCP-subprocess spawn time. The MCP env block in `~/.openclaw/openclaw.json` references the value from the VM's `~/.openclaw/.env`. So the key must be:

1. **In Vercel env** (for the reconciler to read), AND
2. **In each VM's `~/.openclaw/.env`** (for the gbrain subprocess to inherit), AND
3. **In the MCP env block** in `openclaw.json` (mapping it from on-disk env to subprocess env).

(3) is already handled by `install-gbrain.sh` Phase G's python heredoc. (1) is a one-time Cooper action via Vercel dashboard. (2) is the missing piece.

### Design: new reconciler step `stepEnvVarPush`

Add a step early in the reconciler that ensures the VM's `~/.openclaw/.env` contains specific platform-managed keys. Initial scope: `GBRAIN_ANTHROPIC_API_KEY`.

**Behavior** (per VM, per reconcile cycle):

```typescript
async function stepEnvVarPush(ssh, result, dryRun): Promise<void> {
  const KEYS: Record<string, string> = {
    GBRAIN_ANTHROPIC_API_KEY: process.env.GBRAIN_ANTHROPIC_API_KEY ?? "",
  };
  for (const [key, value] of Object.entries(KEYS)) {
    if (!value || value.length < 20) {
      result.errors.push(`stepEnvVarPush: ${key} not set in Vercel env`);
      continue;
    }
    // Read current value from VM's .env
    const grep = await ssh.execCommand(
      `grep "^${key}=" "$HOME/.openclaw/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'`
    );
    const current = grep.stdout.trim();
    if (current === value) { result.alreadyCorrect.push(`env.${key}`); continue; }
    if (dryRun) { result.fixed.push(`[dry-run] env.${key}`); continue; }
    // Atomic append-or-replace via sed
    // ... (mirror of _apply-gbrain-path-a.sh's STEP_2 logic — handles
    // "already present with different value" via in-place replace,
    // "absent" via append, backup before mutate, verify after)
  }
}
```

**Invocation point**: in the orchestrator, right after `stepConfigSettings` (so failures here block cv bump via the existing `result.errors` gate).

**Idempotency**: per-VM, per-cycle. If value already matches, no-op. If absent or different, write + verify. Backup taken before any write, restored on verify failure.

**Cost analysis**: 1 SSH command per VM per cycle (the grep). Reconciler already SSH-connects, so additive cost is one `execCommand` per VM. Bounded.

**Key-rotation story**: Cooper rotates the key in Vercel env, reconciler picks it up on next cycle (3 min cron), pushes to each VM serially. Fleet reaches new key state within ~3.5h at current batch-size-3 cadence.

**Security**: per Rule 19 (.select("*") safety), this reads from `process.env` (Vercel env) and writes to `~/.openclaw/.env` (mode 600). The key is in transit only over SSH-encrypted channel. Same trust model as the existing `OPENAI_API_KEY` distribution.

---

## §2 — Inventory: edge_city VMs today

Probed 2026-05-12 via `scripts/_phase4-prep-inventory.ts`:

| VM | Tier | cv | Health | Created | Owner |
|---|---|---|---|---|---|
| **instaclaw-vm-050** | starter | 92 | healthy | 2026-02-18 | coopgwrenn@gmail.com (Cooper's test) — **gbrained 2026-05-11** |
| instaclaw-vm-354 | starter | 92 | healthy | 2026-03-03 | timour.kosters@gmail.com |
| instaclaw-vm-771 | starter | 92 | healthy | 2026-04-08 | seref@index.network |
| **instaclaw-vm-777** | starter | **82** | healthy | 2026-04-08 | seren@index.network — **lying-DB candidate** |
| instaclaw-vm-859 | pro | 92 | healthy | 2026-04-19 | katherine@edgecity.live |

**Fleet totals**: 227 assigned VMs. edge_city is 5 (2.2%). consensus_2026 is 1 (Cooper's main). Ready-pool: 7 untagged (will be claimed by Esmeralda attendees as they sign up).

**4 remaining edge_city installs** for Phase 4b:
- vm-354 (Timour) — cv=92, ready
- vm-771 (seref@index.network) — cv=92, ready
- vm-777 (seren@index.network) — **cv=82, must be cv-reset or hand-installed**
- vm-859 (katherine@edgecity.live) — cv=92, ready, **only pro-tier in the cohort**

**vm-576** is gbrained but NOT edge_city (no partner). It's a regular paying-customer VM that was the Phase 1 canary's second target. It stays as a non-edge_city proof point but isn't part of the Esmeralda rollout count.

---

## §3 — Per-VM install sequence

The harness is the 8-phase `install-gbrain.sh` from commit `e7d927b3`. Each phase prints `PHASE_X_START` and either `PHASE_X_OK` or `FATAL_*`. The TS wrapper (`_install-gbrain-on-vm.ts`) parses these and emits a structured report.

| Phase | Action | Typical duration | Failure mode |
|---|---|---|---|
| A | Pre-flight: workspace backup, read OPENAI_API_KEY + GBRAIN_ANTHROPIC_API_KEY from .env, openclaw + bun checks, idempotency early-exit | 2-5s | `FATAL_NO_ANTHROPIC_KEY` if `stepEnvVarPush` hasn't run yet |
| B | Bun install (with unzip prereq) | 30-60s | `FATAL_BUN_INSTALL_FAILED` (network, disk) |
| C | git clone gbrain @ pinned commit `2ea5b71` (v0.28.1) | 5-15s | `FATAL_CLONE_FAILED` |
| D | `bun install` + `bun link` + version verify | 60-120s | `FATAL_BUN_INSTALL_FAILED` rc=N (5min timeout) |
| E | `gbrain init --pglite` | 5s | `FATAL_PGLITE_INIT_FAILED` |
| F | `gbrain serve` startup probe | 5s | `FATAL_SERVE_PROBE_FAILED` |
| G | `openclaw mcp set gbrain` with env block (NO `GBRAIN_EMBEDDING_DIMENSIONS`, WITH `ANTHROPIC_API_KEY`, WITH `GBRAIN_ANTHROPIC_MAX_INFLIGHT=3`) + hot-reload verify | 5-10s | `FATAL_MCP_SET_FAILED`, `FATAL_VERIFY_AFTER_SET_FAILED`, `FATAL_GATEWAY_UNHEALTHY_POST_HOT_RELOAD` |
| H | Real JSON-RPC put_page + query round-trip via `verify-gbrain-mcp.py` | 15-30s | `FATAL_VERIFY_GATE_FAILED` with specific code (`FATAL_PUT_ERROR`, `FATAL_QUERY_ISERROR`, `FATAL_MARKER_NOT_FOUND`, etc.) |

**Total per VM**: 2-4 minutes (mostly Bun + gbrain `bun install`).

**Post-install verification** (in `_install-gbrain-on-vm.ts`):
- Re-run 6-point pre-flight to confirm no regression in TasksMax / prctl-subreaper / gateway health.
- Send a real chat completion asking the agent to enumerate `gbrain__` tool names. Must return ≥30 (typical: 43).

**Failure-mode tests** (per CLAUDE.md Rule 31) for Phase 4 specifically:
- "What if disk is <500MB free during Phase B?" → bun installer fails fast with clear error. Already tested empirically on vm-512 (the disk-full incident).
- "What if `GBRAIN_ANTHROPIC_API_KEY` is missing?" → Phase A's `[ "$A_KEY_LEN" -lt 20 ]` check exits with `FATAL_NO_ANTHROPIC_KEY` exit 2. Tested.
- "What if the Anthropic key is invalid?" → Phase H's query step makes a real expansion call; an `401 unauthorized` from Anthropic surfaces as `anthropic_auth_warn=yes` in the RESULT_OK line. Tested today on vm-050.
- "What if gbrain v0.28.1 isn't compatible with this VM's Node version?" → pinned commit + version verify in Phase D catches it.

---

## §4 — Rollout order

Three sub-phases, gated by soak windows per Rule 17:

### Phase 4a — Key distribution (May 13-14)

- Cooper adds `GBRAIN_ANTHROPIC_API_KEY=sk-ant-api03-...` to Vercel env vars (production environment scope).
- Ship `stepEnvVarPush` in `lib/vm-reconcile.ts` (PR + merge to main).
- Reconciler propagates over 3-5 hours. Stays running indefinitely as the source-of-truth distribution mechanism.
- **Verification**: query `instaclaw_admin_alert_log` for any `stepEnvVarPush:KEY_MISSING` events; spot-check 10 VMs via SSH `grep GBRAIN_ANTHROPIC_API_KEY ~/.openclaw/.env`.

### Phase 4b — edge_city canary (May 15-18)

Install the 4 remaining edge_city VMs serially with 24h soak between waves. Standardized harness; no per-VM customization.

| Day | VM | Pre-install | Action | Soak before next |
|---|---|---|---|---|
| May 15 | **vm-354** (Timour, starter, cv=92) | Confirm cv=92 + .env has key | `npx tsx scripts/_install-gbrain-on-vm.ts instaclaw-vm-354` | 24h soak — monitor for any `Brain's acting up` user reports |
| May 16 | **vm-771** (seref, starter, cv=92) | Same | Same | 24h soak |
| May 17 | **vm-859** (katherine, pro, cv=92) | Same — note pro tier means heavier usage profile | Same | 24h soak; first pro-tier gbrain install fleet-wide |
| May 18 | **vm-777** (seren, starter, cv=**82**) | **First run lying-DB cv-reset** OR hand-install via SSH if Phase C hasn't landed | Same after reset succeeds | 24h soak |

**Stop condition**: any FATAL_* exit in Phase A-H halts the sub-phase. Forensic the failure, fix, re-run on the same VM, then continue. Don't paper over an early failure to "stay on schedule" — Esmeralda is 12 days out, the install is reversible (`_uninstall-gbrain-on-vm.ts --purge`).

**Soak verification per VM**:
- 24h post-install: query usage_log for `mcp.servers.gbrain` invocations on that VM. Expect ≥10 per day from heartbeat-driven memory operations.
- Send a real test message that triggers `put_page` ("remember this: X"). Verify response includes the marker on retrieval. Same loop Cooper used on vm-050 today.

### Phase 4c — Auto-install via reconciler (May 19-22)

Ship `stepGbrain` in `lib/vm-reconcile.ts` (see §7 for the design). Gated by partner allowlist — initially `["edge_city"]`. Enables:

- Any new edge_city VM provisioned May 19+ gets gbrain installed within 3-5 min of partner-tag assignment.
- Existing edge_city VMs are already done from Phase 4b (idempotency makes the step a no-op).
- consensus_2026 + other partners NOT yet in the allowlist — they continue using MEMORY.md.

The allowlist is expanded post-Esmeralda based on observed cost + behavior.

**Verification**: provision a synthetic edge_city VM via the test harness; observe reconciler's stepGbrain fire on first reconcile cycle; confirm via Phase H gate.

### Phase 4d — Snapshot bake (May 23-25)

Bake a new snapshot from a fresh nanode that's been gbrained via the same harness. Per CLAUDE.md §"Snapshot Creation Process":
- Provision g6-nanode-1 from current snapshot (`private/38575292`).
- Run `_install-gbrain-on-vm.ts` against it.
- Verify all 15 snapshot checks pass.
- Bake → `private/<new-id>`.
- Update `LINODE_SNAPSHOT_ID` in Vercel env + `CLAUDE.md` VM Provisioning Standard.
- Keep old snapshot for 1-week rollback window.

**Why this is Phase 4d (last) instead of Phase 4a (first)**: per CLAUDE.md Rule 7, snapshot-baking is the LAST step after a manifest matures. We want the reconciler step proven first, the install harness battle-tested first, and the operating cost measured first. If something goes wrong with gbrain, it's much cheaper to disable `stepGbrain` than to roll back a snapshot.

### Phase 4e — Esmeralda go-live (May 26-30)

No code changes. Monitor the existing crons:
- `heartbeat-staleness-sweep` (every 30 min) — auto-fix any stuck VMs.
- `usage-anomaly-check` (hourly) — alert on user→minimax cost spikes (gbrain expansion uses Anthropic; if a misconfig causes routing through MiniMax, this fires).
- `minimax-canary` (every 15 min) — unchanged role.
- **NEW: gbrain-coverage cron** (proposed P2 — see §10 — every hour, alerts if any edge_city VM lacks gbrain or shows expansion_disabled in its journal tail).

Daily operator review: dashboard for "% of edge_city VMs with healthy gbrain MCP." Target: 100% throughout Esmeralda.

---

## §5 — Risks and mitigations

### 5.1 — Anthropic key exposure across 200+ VMs

**Risk**: every VM's `~/.openclaw/.env` will contain `GBRAIN_ANTHROPIC_API_KEY`. The openclaw user owns the file (mode 600). The openclaw-gateway and gbrain subprocess can read it; an attendee's rogue agent (running in the same security context) can `cat ~/.openclaw/.env` and exfiltrate.

**Mitigation**:
- **$300/mo Anthropic spending cap** on the gbrain project key (separate from Cooper's personal Anthropic). Compromised key has bounded blast radius.
- **Key rotation cadence**: every 30 days; reconciler picks up new value within 3.5h.
- **Same trust model as OPENAI_API_KEY** which is already on every VM. No new attack surface.
- **No PII in the gbrain database** — gbrain stores knowledge graph entries, not user credentials.

### 5.2 — lying-DB cohort blocking reconciler-driven install

**Risk**: per CLAUDE.md P1-1, ~20% of cv≥88 VMs have `config_version` ahead of on-disk state. The reconciler's `lt(config_version, manifest_version)` filter SKIPS those VMs entirely. If `stepGbrain` lives in the reconciler, lying-DB VMs never get gbrain.

**Affected today**: vm-777 (cv=82, edge_city) is in the suspected lying-DB cohort. Hand-install via `_install-gbrain-on-vm.ts` works regardless of cv state.

**Mitigation**:
- Phase 4b uses **direct TS invocation** (not reconciler), bypassing cv check.
- For Phase 4c (reconciler step), the dependency is the consensus terminal's Phase C cv-reset which they're already prosecuting. If it doesn't land by May 18, fall back to hand-installing every edge_city VM via Phase 4b.
- After Phase 4c lands, `stepGbrain` runs even when cv is stale because we'll modify the step to ALWAYS check gbrain presence (`gbrain --version` + `openclaw mcp show gbrain`), not skip on cv mismatch.

### 5.3 — Disk space on legacy VMs

**Risk**: gbrain install needs ~500MB free (Bun + gbrain repo + node_modules + PGLite). The 2026-05-11 vm-904 disk-full incident showed 79GB Linode disks can fill up via runaway session-backups (P1-6 in CLAUDE.md). Some legacy VMs may already be close to full.

**Mitigation**:
- Add a **pre-flight disk check** to Phase A of `install-gbrain.sh`: require ≥10GB free or `FATAL_DISK_FULL`. Implemented as: `[ $(df --output=avail / | tail -1) -lt 10485760 ] && exit`.
- Fleet pre-flight before Phase 4c: probe all edge_city VMs' disk free via SSH; alert any below 10GB before reconciler hits them.
- Note for P1-6 (session-backups runaway): the strip-thinking.py fix for unbounded backup growth should land before fleet-wide gbrain rollout. Otherwise gbrain install could push a VM over the disk-full edge.

### 5.4 — OpenAI rate limits during mass install

**Risk**: Phase H's `put_page` makes one OpenAI embedding call (`text-embedding-3-large`). If we install 50 VMs in 5 minutes, that's 10 RPM — well within OpenAI's tier-1 limits (3,500 RPM). No issue.

**Mitigation**: throttled rollout (max 5 concurrent installs) is overkill but harmless. Default in `_install-gbrain-on-vm.ts` is serial (one at a time per script invocation). For batch installation, wrap in a queue with concurrency=5.

### 5.5 — Anthropic rate limits during runtime

**Risk**: `GBRAIN_ANTHROPIC_MAX_INFLIGHT=3` per VM. 200 edge_city VMs × 3 = 600 concurrent inflight. Anthropic project-tier limit is typically 5,000 RPM for Haiku — well within bounds.

**Mitigation**:
- Existing `GBRAIN_ANTHROPIC_MAX_INFLIGHT` cap is the per-VM brake.
- `usage-anomaly-check` cron monitors fleet-wide spend; alerts on >2× baseline.
- **Cost projection**: average attendee will run 50 queries/day, each costing ~$0.0002 in Anthropic expansion. 500 attendees × $0.01/day = $5/day fleet cost. Well within the $300/mo cap (which is ~$10/day) with 2× safety margin.

### 5.6 — Esmeralda first-impression failure

**Risk**: an attendee provisions a VM during the conference (May 30+), the reconciler hasn't yet installed gbrain, attendee tries `remember this: I just met Alice from a16z`, agent stores it in MEMORY.md (degraded). Two days later attendee asks "who do I know from a16z?", agent does grep-style retrieval (no semantic match), looks bad.

**Mitigation**:
- **Snapshot bake (Phase 4d)** is the primary fix. New VMs come pre-installed.
- **stepGbrain** runs on every reconciler tick (every 3 min for the assigned-VM batch). Worst-case latency from VM-claim to gbrain-available: 3-5 min.
- **Onboarding messaging**: the first message attendees see (auto-generated by the partner portal) could include a "your brain is being set up — about 5 minutes" line if the reconciler hasn't yet completed. Reduces perceived latency.

### 5.7 — gbrain master branch breaking changes

**Risk**: gbrain's built-in `git pull` cron updates the repo every 30 min. Garry could ship a breaking change to master that breaks the agent fleet-wide.

**Mitigation**:
- **Pin to commit `2ea5b71`** (v0.28.1) — verified working. Phase C of `install-gbrain.sh` does `git checkout` and verifies HEAD matches the pinned commit. Auto-pull on master is therefore not effective unless we explicitly fast-forward.
- **Disable the auto-pull cron** on all gbrained VMs as part of `install-gbrain.sh` Phase G+ (add a step that removes the `gbrain pull` cron entry if present). Currently the auto-pull is harmless because we're pinned, but better to be explicit.
- **Version bump cadence**: Cooper or platform team reviews gbrain release notes monthly; bumps `GBRAIN_PINNED_COMMIT` + `GBRAIN_PINNED_VERSION` in `_install-gbrain-on-vm.ts` only after manual validation on a canary VM.

---

## §6 — Timeline (Gantt-style)

```
  May 12  ──● [today] design doc landed
  May 13  ──○ Cooper adds GBRAIN_ANTHROPIC_API_KEY to Vercel env
  May 14  ──○ ship stepEnvVarPush PR (Phase 4a) — propagates over 3.5h
            └─── verify .env on 10 sampled VMs
  May 15  ──● Phase 4b wave 1: vm-354 install + 24h soak
  May 16  ──● Phase 4b wave 2: vm-771 install + 24h soak
  May 17  ──● Phase 4b wave 3: vm-859 install (first pro-tier gbrain) + 24h soak
  May 18  ──● Phase 4b wave 4: vm-777 (lying-DB or hand-install) + 24h soak
  May 19  ──○ ship stepGbrain PR (Phase 4c) — partner allowlist starts at [edge_city]
            └─── test on a synthetic VM provisioned via replenish-pool
  May 20  ──○ stepGbrain soaks on existing edge_city VMs (no-op idempotency)
  May 21  ──○ provision a test edge_city VM end-to-end + verify auto-install
  May 22  ──○ buffer day
  May 23  ──● Cooper's go-live target: all current + projected edge_city VMs have gbrain ✓
  May 24  ──○ Phase 4d kickoff: bake gbrained snapshot
  May 25  ──○ snapshot bake + 15-point verify + Vercel env update
  May 26  ──○ snapshot soak (1 day) — provision a test VM from new snapshot
  May 27  ──○ buffer
  May 28  ──○ ESMERALDA OPS PREP: monitoring dashboards, runbooks for the conference team
  May 29  ──○ buffer
  May 30  ──● Esmeralda Day 1: attendees arrive, agents already have gbrain
  May 31  ──○ Day 2: monitor + iterate
  ...
  Jun 3   ──○ Esmeralda Day 5: review, debrief, plan Phase 5 (other partners)
```

**Critical path** (cannot slip): May 13 (Vercel env) → May 14 (stepEnvVarPush) → May 15-18 (4 installs). After May 18 we have all current edge_city VMs gbrained. Phase 4c + 4d are protective layers but not strictly blocking — even without them, the 5 existing edge_city VMs would have gbrain for the duration of the conference, and any new attendee VMs would fall back to MEMORY.md degraded mode.

**Buffer**: 4 days (May 21-22, May 27, May 29). If any wave fails, slip one day; the buffer absorbs up to 4 day-1 failures without sliding past Esmeralda.

---

## §7 — Reconciler integration: `stepGbrain`

Goal: every assigned VM whose partner matches the allowlist has gbrain installed + MCP-wired + Phase H gate passing. Idempotent. Self-healing.

### Design

New step in `lib/vm-reconcile.ts`, called from the orchestrator AFTER `stepEnvVarPush` (which produces the precondition: `~/.openclaw/.env` has the key).

```typescript
// Allowlist gates which partners get gbrain installed by the reconciler.
// Conservative for v1 — only edge_city for Esmeralda. Expand as cost +
// behavior signals mature.
const GBRAIN_PARTNER_ALLOWLIST: Set<string> = new Set(["edge_city"]);

async function stepGbrain(
  ssh: SSHConnection,
  vm: VMRecord,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  // Gate: only run for allowlisted partners
  if (!vm.partner || !GBRAIN_PARTNER_ALLOWLIST.has(vm.partner)) {
    return; // silent skip
  }

  // Cheap idempotency check: gbrain --version + openclaw mcp show
  const check = await ssh.execCommand([
    "source ~/.nvm/nvm.sh 2>/dev/null",
    "export PATH=$HOME/.bun/bin:$PATH",
    'V=$(gbrain --version 2>&1 | head -1 | grep -oE "[0-9]+\\.[0-9]+\\.[0-9]+")',
    'M=$(openclaw mcp show gbrain 2>&1 | grep -c "/home/openclaw/.bun/bin/gbrain")',
    'echo "V=$V|M=$M"',
  ].join(" && "));
  const m = check.stdout.match(/V=([^|]*)\|M=(\d+)/);
  const versionOk = m?.[1] === "0.28.1";
  const mcpOk = m?.[2] === "1";

  if (versionOk && mcpOk) {
    result.alreadyCorrect.push("gbrain");
    return;
  }

  if (dryRun) {
    result.fixed.push(`[dry-run] gbrain install (version=${m?.[1] ?? "missing"}, mcp=${m?.[2] ?? "missing"})`);
    return;
  }

  // Full install via SFTP'd install-gbrain.sh + verify-gbrain-mcp.py.
  // Code path mirrors _install-gbrain-on-vm.ts but lives in the reconciler.
  // ...
  // On any FATAL_* in the install output, push to result.errors so the
  // config_version gate refuses to bump. Next cycle retries.
}
```

**Concurrency**: the reconciler already runs at `CONFIG_AUDIT_BATCH_SIZE=3` per cron tick. With gbrain install adding ~2-4 min per VM, the per-batch wall time goes from ~150s (current) to ~300-400s. **This pushes us close to Vercel's 300s `maxDuration` ceiling.** Two options:

- **Option A: increase `maxDuration` for reconcile-fleet** to 600s (already at 300s per CLAUDE.md Rule 11). Acceptable for a one-time rollout; revert after Phase 4c saturates.
- **Option B: reduce batch size to 1** during the rollout period. Slower fleet-wide propagation (3-5 min × ~5 = ~15 min for edge_city), but stays within current timeout.

Recommend B for production safety. Option A is a fallback if propagation is too slow.

**Failure modes**: every FATAL_* exit from `install-gbrain.sh` ends up in `result.errors`. The `reconcile-fleet` route's `pushFailed` gate refuses to bump `config_version`. The next 3-min cycle retries. After 3 consecutive failures on the same VM (tracked via `instaclaw_strict_holds`), the watchdog escalates to an admin alert.

**Cost per cycle**: 1 SSH check per allowlisted VM. 5 edge_city VMs × 1 SSH = 5 SSH calls per reconcile cycle (currently runs every 3 min). Negligible.

**Phase H verification on every cycle**: NOT done by `stepGbrain`. The Phase H gate is part of the INSTALL flow; running it on every cycle would consume ~$0.005/cycle/VM in OpenAI + Anthropic. Instead, the existing `usage-anomaly-check` cron monitors gbrain expansion health fleet-wide.

---

## §8 — Snapshot rebake

Per CLAUDE.md "Snapshot Creation Process":

1. Provision g6-nanode-1 from current snapshot `private/38575292`.
2. SSH in. Run `_install-gbrain-on-vm.ts <the-bake-vm-name>` (or run `install-gbrain.sh` directly if there's no DB row).
3. Verify Phase H passes.
4. Run the existing 15-point verify (CLAUDE.md). New 16th check: `gbrain --version` returns `0.28.1` AND `openclaw mcp show gbrain` returns 1 hit.
5. Confirm disk < 6144MB (Linode image limit) — gbrain adds ~500MB so total should be ~5.9-6.0GB. Likely tight; pre-bake disk-clean is essential.
6. Shutdown + create image.
7. Update `LINODE_SNAPSHOT_ID` in Vercel env + `CLAUDE.md`.
8. Keep `private/38575292` for 1 week as rollback target.

**When to bake**: AFTER `stepGbrain` has run on every existing edge_city VM and produced consistent passes for 24h. We want to bake from a known-good state, not from a snapshot whose install path might still have surprises.

**Risk**: rebake right before Esmeralda is "ship the day before launch" territory. The 1-week soak window is impossible. Mitigation: bake on May 23-24, soak for 5-6 days, conference starts May 30. Acceptable but tight.

**Fallback**: if snapshot bake fails or shows issues, keep `private/38575292` as the active snapshot. `stepGbrain` (Phase 4c) becomes the sole installation path for new attendee VMs — adds ~5 min latency on first provision but works correctly.

---

## §9 — Esmeralda-day operations

### Monitoring dashboard (built before May 28)

A simple Vercel page at `/admin/esmeralda-status` showing:

- **Total edge_city VMs**: count, broken down by tier
- **% with gbrain healthy**: `gbrain --version` + `openclaw mcp show gbrain` both pass
- **Last 1h Anthropic spend** (from `instaclaw_usage_log` filtered to gbrain-related calls)
- **Heartbeat-staleness-sweep last fire**: count of VMs unstuck (target: 0 sustained)
- **MiniMax-canary last status**: healthy / depleted / outage
- **Last 5 admin alerts**: from `instaclaw_admin_alert_log`

Single page, single Cooper-glance. No need for new infrastructure — pulls from existing tables.

### Runbook for conference operators

In `docs/runbook-esmeralda-2026.md` (P2 to write before May 28):
- "Attendee says their agent doesn't remember anything" → check `gbrain --version` on their VM; if missing, force a reconcile via direct invocation.
- "Attendee says their agent is slow" → check `usage_anomaly_check` for their VM; could be cold-start of the gbrain subprocess.
- "Attendee says Brain's acting up" (the actual error message gbrain returns on failure) → spawn a synthetic put_page test via `verify-gbrain-mcp.py`; if it fails, restart `openclaw-gateway` (kills + respawns the gbrain subprocess too).

### Emergency disable

If gbrain fleet-wide goes bad during the conference (e.g., Anthropic project key compromised), the kill switch is:
1. Empty the partner allowlist: `GBRAIN_PARTNER_ALLOWLIST = new Set([])`. Reconciler stops installing on new VMs but doesn't UNINSTALL existing.
2. Push a one-shot `_fleet-disable-gbrain.ts` that does `openclaw mcp unset gbrain` on every allowlisted VM via SSH. Restores MEMORY.md as the sole memory backend within ~15 min fleet-wide.
3. `_uninstall-gbrain-on-vm.ts --purge` for nuclear option (rarely needed).

---

## §10 — Open questions and dependencies

### Questions for Cooper

1. **Anthropic spending cap on the gbrain project key** — recommend $300/mo. Set at console.anthropic.com.
2. **Snapshot bake timing** — May 23-25 window. OK with the 5-day soak before Esmeralda?
3. **Phase 4c partner allowlist** — start with `["edge_city"]` only? Or include `["edge_city", "consensus_2026"]` (Cooper's own VM)?
4. **Phase 4d snapshot bake** — bake from a clean nanode or from one of the existing gbrained VMs? Clean is safer per Rule 7 ("DO NOT use ready-pool VMs as the base").
5. **gbrain-coverage cron** (P2) — proposed every 1h, fires admin alert if any edge_city VM lacks gbrain. Want it before Esmeralda?
6. **Pricing transparency to attendees** — gbrain Anthropic calls aren't billed to attendee tier-usage budgets currently. Long-term we'll need to either (a) absorb the cost as platform overhead or (b) add a billing line. Out of scope for this PRD but flagging for awareness.

### Cross-terminal dependencies

1. **Consensus terminal — Phase C cv-reset** for the lying-DB cohort. vm-777 is in the cohort. Needs to land before May 18 (the vm-777 install date).
2. **Edge City terminal — v94 fleet rollout** is concurrent with this PRD. Both share the reconciler hook points. No code conflicts because the two PRDs touch different `step*` functions, but the order of orchestrator steps matters. Coordinate the merge order: Edge City's v94 manifest commit lands first, then this PRD's stepEnvVarPush + stepGbrain in a follow-up PR.
3. **Bug-squash terminal (me) — strip-thinking.py size-archive compact path** (P1-6 in CLAUDE.md) — recommend landing before Phase 4d snapshot bake so the snapshot's strip-thinking.py is the compact-not-nuke version.

### Known-unknowns (probe before shipping)

- **Disk free on edge_city VMs** (specifically vm-859 which is pro-tier and likely has more accumulated session data). One-shot SSH probe before May 15.
- **Bun already present** on any edge_city VM? If yes, Phase B is a no-op and install is faster. Probe.
- **OpenClaw version on each edge_city VM** — should all be 2026.4.26 per the v67 upgrade history. Probe to confirm.
- **gbrain auto-pull cron behavior** on existing fleet — if it's running daily git fetches that match HEAD, no issue; if it tries to advance past v0.28.1, we need to disable it explicitly.

### P2 follow-ups (post-Esmeralda)

1. **Cost telemetry for gbrain expansion** — break out from total Anthropic spend, attribute per-VM, surface in dashboard.
2. **Per-attendee gbrain analytics** — pages/day, queries/day, expansion-trigger-rate. Helps Cooper understand actual usage patterns for product narrative.
3. **gbrain-coverage cron** — alerts on missing gbrain per VM.
4. **Expand partner allowlist** — consensus_2026 first, then power-tier paying users, then all assigned VMs.
5. **gbrain backup/restore** — PGLite databases on individual VMs are vulnerable to VM destruction. Want a periodic export to a central store. Probably weekly tar.gz to S3.
6. **Cross-VM knowledge sharing** — currently each VM has its own siloed gbrain. Edge attendees would benefit from a shared "Edge knowledge" overlay (events, venues, people). Out of scope for v1.

---

## Appendix A — Quick-reference command list

```bash
# Phase 4a: distribute key (run from instaclaw/)
# (After Cooper adds GBRAIN_ANTHROPIC_API_KEY to Vercel env and stepEnvVarPush ships)
# No manual command — reconciler picks it up

# Phase 4b: install on a single edge_city VM
npx tsx scripts/_install-gbrain-on-vm.ts instaclaw-vm-354

# Verify install end-to-end
ssh openclaw@$VM_IP 'systemctl --user is-active openclaw-gateway && openclaw mcp show gbrain | head -5'

# Soak verification (24h post-install)
# Real chat to the bot's Telegram + observe response uses gbrain__put_page
# OR direct MCP probe:
ssh openclaw@$VM_IP 'cp /tmp/verify-gbrain-mcp.py /tmp/verify-now.py && MARKER_TS=$(date +%s) OPENAI_API_KEY=$(grep ^OPENAI .openclaw/.env | cut -d= -f2- | tr -d \") ANTHROPIC_API_KEY=$(grep ^GBRAIN_ANTH .openclaw/.env | cut -d= -f2- | tr -d \") GBRAIN_DATABASE_URL=pglite://.gbrain/brain.pglite python3 /tmp/verify-now.py'

# Phase 4d: snapshot bake follow-up (per CLAUDE.md §Snapshot Creation Process)
# Manual workflow — Cooper or bug-squash terminal owns

# Rollback (per-VM, last resort)
npx tsx scripts/_uninstall-gbrain-on-vm.ts instaclaw-vm-354 --purge
```

## Appendix B — Decision log

- **2026-05-11 evening**: Path A (Anthropic for expansion + chat) chosen over OpenAI-for-expansion. Rationale: Gary's design defaults; "best-in-class" reasoning; Cooper's "optimize for quality" directive. Proxy-routing through `instaclaw.io/api/gateway` rejected due to response-body corruption (usage warning injection) + intelligent-routing surprise. Real Anthropic key on each VM's disk accepted as the cost.
- **2026-05-11 evening**: Dim mismatch root cause (`GBRAIN_EMBEDDING_DIMENSIONS=1024` vs PGLite schema `vector(1536)`) discovered + fixed by removing the env var. Default 1536 matches schema.
- **2026-05-12**: Hot-reload classification (`mcp.servers.*` IS hot-reloadable per stepConfigSettings logic + empirical evidence from `[reload] config hot reload applied (mcp.servers.gbrain.env.X)` lines in vm-050's journal). gbrain config changes don't require gateway restart — important property for Phase 4c's safety profile.
- **2026-05-12**: 24h soak window per Rule 17 RELAXED from 48h to 24h for Phase 4b after the harness's perfect Phase 1 record (0 failures across vm-050 + vm-576). Reverts to 48h if any Phase 4b wave has a failure.

---

End of design doc. Hand-off: bug-squash terminal owns implementation of `stepEnvVarPush` and `stepGbrain`. Cooper owns Vercel env update + Anthropic cap + snapshot-bake-day decision. Consensus terminal's cv-reset is the only cross-terminal blocker.
