# PRD — On-Demand Provisioning: Same Persistent VMs, One Code Path

**Status:** Approved in principle (2026-05-12). Revisions 1-8 applied per Cooper's review. Implementation is gated on Edge Esmeralda being live and stable — see §1.0.
**Author:** Claude (Opus 4.7, 1M context) + Cooper Wrenn
**Date:** 2026-05-12 (revised 2026-05-12 after Cooper's 8-revision review)
**Branch:** TBD (suggest `feat/on-demand-provisioning`); do NOT create until §1.0 gate clears.

**Related rules (all preserved by this proposal):** CLAUDE.md §1, §2, §3, §5, §7, §8, §10, §11, §22, §23, §24, §25, §26, §27, §32, §33, §34.

**Related PRDs (cross-checked for non-contradiction):**
- `PRD-memory-architecture-overhaul.md` (Status: ALL 14/14 COMPLETE, fleet-deployed) — the agent's memory architecture *is* the VM filesystem (`~/.openclaw/workspace/MEMORY.md`, `agents/main/sessions/`, `memory/main.sqlite`). This proposal preserves it; the persistent dedicated VM remains the substrate.
- `edgeclaw-partner-integration.md` §4.1 (Same Snapshot, Dynamic Skill Install) — the `partner === "edge_city"` gating semantic is preserved. Install timing moves from SSH-post-boot into cloud-init-at-boot; the gate itself is unchanged.
- `edgeclaw-partner-integration.md` §4.17 (Memory Continuity & Portability) — this proposal makes user-keyed memory backup MORE valuable, not less; it becomes the precondition for clean respawn.
- `drop-the-waitlist.md` (waitlist removal + pool architecture, 2026-03-13) — the pool/auto-scaling part of that PRD is what this PRD intends to retire. The "frictionless onboarding" outcome is preserved.
- `infrastructure-upgrade-dedicated-cpu.md` (Phases 1-3 COMPLETE) — Linode `g6-dedicated-2` substrate is unchanged. This PRD is orthogonal to provider.
- `PRD-gbrain-integration.md` + `PRD-gbrain-phase1-design.md` + `gbrain-fleet-rollout-2026-05-12.md` — gbrain is per-VM PGLite at `~/.openclaw/gbrain/`. Lives on VM disk. This proposal preserves the persistent VM disk, so gbrain rollout is unaffected.
- `prd-soul-restructure.md` + `soul-md-trim-2026-05-11.md` — SOUL.md V2 architecture. Workspace files still deployed; just from cloud-init userdata instead of SSH.
- `reconcile-deadline-structural-fix-2026-05-11.md` — reconciler keeps its role here as drift-repair for long-lived VMs.

**Non-goals (deliberately out of scope):**
- Changing the cloud provider. Linode `g6-dedicated-2` is the substrate; that decision is locked.
- Changing the VM-per-user model. Each agent keeps its own dedicated, persistent, always-on Linux environment. The dedicated VM *is the product*.
- Container-packing, microVM packing, sleep/wake, brain/body splits. All explored and rejected by Cooper (separate architectural conversation, this session).
- Memory portability implementation. Tracked in edgeclaw §4.17; this PRD makes it possible but doesn't ship it.
- Pricing changes. Unit economics improve passively via reduced operational complexity, but the cost-per-VM is unchanged (still ~$29/mo Linode dedicated).

---

## 1.0 Ship gate — AGGRESSIVE TIMELINE, FEATURE-FLAG-PROTECTED

**Revised 2026-05-12 (second pass).** Ship target: before Edge Esmeralda opens on **2026-05-30**. The feature flag + ≤5-min rollback is the safety mechanism. The old path is heavily battle-tested after today's session (Pass 0 starvation fix in `a527f867`, Rule 33 critical-failure gate, Rule 34 telegram-token reconciler, `listInstanceLabelsMatching` orphan defense). It is now the dependable fallback, not the rickety incumbent it was 24 hours ago.

### Timeline (18 days, Phase 1A → live)

| Phase | Window | What happens |
|---|---|---|
| **Phase 1A — build** | 2026-05-12 → 2026-05-24 (12 days) | All implementation. `buildCloudInitUserdata`, `createUserVM`, `cloud-init-callback`, `respawnVM`, the cloud-init-poll modifications, the failure-mode tests (`_test-cloud-init-userdata.ts`, `_test-webhook-branching.ts`), the Supabase migration. **No PR merged to `main` lands the new code without `USE_ON_DEMAND_PROVISIONING=false`** — the flag stays off until canary. Pre-implementation gate: `docs/cloud-init-implementation-map.md` complete and reviewed (see §1.0.1 below). |
| **Phase 1B — Cooper self-test** | 2026-05-25 → 2026-05-27 (3 days) | Flag enabled for `userId IN (cooper_test_user_ids)`. Cooper creates **multiple fresh-user signups** end-to-end. Each one walks: Stripe checkout → webhook → VM provisioned → telegram bot works → MEMORY.md initialized → all 7 mandatory crons running → callback_token consumed exactly once + replay rejected → reconciler's first cycle no-ops on the new VM (no drift to repair). Compare to a parallel old-path test signup for every parameter. Any divergence is a P0 fix. |
| **Phase 1C — Edge City partner canary** | 2026-05-28 → 2026-05-29 (2 days) | Flag enabled for `partner = "edge_city"` on **new signups only**. The 5 existing edge_city VMs are untouched. First early-arrival Edge Esmeralda users land on the new path. Cooper monitors `instaclaw_cloud_init_outcomes` table in real time; admin alert on any single failure during this window. Pre-rollout `_test-webhook-branching.ts` must pass all 7 branches. |
| **Phase 1D — Edge opens, new path live** | 2026-05-30 | Edge Esmeralda opens. If Phase 1B + 1C are green, the flag is flipped ON for all new signups. Old path remains live as fallback — every Stripe webhook still has the conditional. Replenish-pool stays at POOL_TARGET=15 through Edge (not retired until post-event); the cron continues so we have a warm fallback if the new path needs to be turned off. |
| **Phase 1E — pool retirement** | post-2026-06-27 (after Edge closes) | Only after Edge has ended cleanly do we disable `replenish-pool` and retire the pool. Pool retirement is a Phase-1E decision — independent of Phase 1A-1D's "ship the new path" milestone. |
| **Phase 2 — code deletion** | 2026-07-15+ (separate PRD) | After 30+ days of green metrics on the new path AND Edge has been over for ≥2 weeks, delete the dead code per §6 in a separate PRD. |

### Why this is safer than it looks

The reflexive concern is "shipping a new provisioning path 18 days before the biggest partner event of the year." That framing misses what the feature flag actually buys:

1. **Rollback is sub-5-minute and per-request.** Flipping `USE_ON_DEMAND_PROVISIONING=false` in Vercel routes the very next webhook through the old path. No deploy required.
2. **The fallback path is now battle-tested.** Today's session added the khomenko89 fix, Rule 33's critical-failure gate that writes `configure_failed` instead of leaving zombies, Rule 34's DB↔disk telegram verifier, and a bunch of release-path token clears. The old path's known failure modes are all hardened.
3. **Per-user feature-flagging.** Phase 1B is Cooper-only. Phase 1C is edge_city-only. Phase 1D is "all new signups but ANY single failure flips the flag for that user back to the old path." We never need to migrate already-provisioned VMs; they continue on whichever path they were born on.
4. **Process-pending stays running through the entire rollout per §10.0.** If the new path fails in a way that produces a "stuck user," process-pending's seven passes (including Pass 0's khomenko89 recovery) catch them. The old path's safety net is on for the new path's burn-in.
5. **Cloud-init-callback's atomic claim-and-invalidate (§5.3.1)** means a partially-failed new-path provision cannot leave a half-committed DB row. It either claims the callback and lands fully, or doesn't claim and gets respawned.

### What is NOT in this aggressive plan

- **No migration of existing VMs.** The 200+ existing users stay on the old path forever. We do not touch their state.
- **No pool retirement before Edge ends.** The pool continues to do its job until 2026-06-27+. Phase 1E is post-Edge.
- **No deletion of old code paths during Edge.** Dead-code deletion (Phase 2) is post-Edge by at least 30 days. The fallback must remain a live, exercised path through Edge.
- **No "I'll start writing code while finalizing the map."** §1.0.1 is a HARD gate; see below.

### 1.0.1 PRE-IMPLEMENTATION GATE — `docs/cloud-init-implementation-map.md` MUST exist and be reviewed

**Zero lines of `lib/cloud-init-userdata.ts` are written before** `docs/cloud-init-implementation-map.md` is complete, committed, and reviewed by Cooper. The map covers:

1. Every file/config/command `configureOpenClaw` writes to the VM (read line-by-line, all 2,817 lines).
2. Every skill in `instaclaw/skills/` with its partner gate, env-var needs, and deploy mechanism.
3. Every entry in `VM_MANIFEST.cronJobs`, `VM_MANIFEST.systemPackages`, `VM_MANIFEST.envVars`, `VM_MANIFEST.files`, `VM_MANIFEST.skills`.
4. Every workspace template (SOUL.md V2, CAPABILITIES.md, TOOLS.md, EARN.md, MEMORY.md, WALLET.md, AGENTS.md V2, IDENTITY.md V2) classified as static (snapshot-baked) or per-user (cloud-init must generate).
5. Every reconciler step in `vm-reconcile.ts` categorized:
   - **(a)** Verifies something `configureOpenClaw` writes — cloud-init MUST write this
   - **(b)** Drift-repair over time — cloud-init does not handle, reconciler always will
   - **(c)** Patches a `configureOpenClaw` omission — cloud-init MUST handle so the reconciler doesn't have to
6. Every cron job baked into the snapshot vs installed by `configureOpenClaw`.
7. Every per-user generator in `lib/agent-intelligence.ts`, `lib/earn-md-template.ts`, `lib/workspace-templates-v2.ts`.
8. The minimum-viable boot order dependency graph.

The map is the blueprint. The code is the construction. We do not start construction until the blueprint is reviewed.

---

## 1. Executive summary

### The thesis

The dedicated persistent always-on Linux VM is correct. The infrastructure is correct. **What needs to change is the code path that gets a user from "Stripe payment succeeded" to "working Telegram bot."** Today that path is six cron passes, three SSH endpoints, an SSH-based 2,817-line configuration function, and a pool of pre-warmed VMs. Tomorrow it is one Linode API call with a rich cloud-init userdata payload that bakes the user's identity into the VM at first boot.

Every failure mode this session enumerated traces back to the same root cause: **the system has too many code paths that can reach the same end state, and they race each other.** The pool races process-pending. Process-pending races the billing webhook. The reconciler races the health-check cron. The configure endpoint races itself. We've spent the last six weeks adding belts to suspenders (Rule 33's critical-failure gate, Rule 34's DB↔disk verifier, Pass 2c, Pass 3b) precisely because of how many ways the existing path can partially commit.

Cloud-init is one code path. It runs once, on the VM, at first boot. It either succeeds wholly or the VM is marked failed and respawned. There is no race because there is nothing to race against.

### What this proposal does

| Today (multi-path) | Tomorrow (single path) |
|---|---|
| Pool of pre-warmed VMs (replenish-pool cron, every 5 min) | No pool. VM created at signup time. |
| `cloud-init-poll` cron flips status `provisioning` → `ready` after sentinel | `cloud-init-poll` cron flips status `provisioning` → `healthy` after a richer sentinel. Same cron, different sentinel. |
| `process-pending` cron with 7 passes (orphan recovery, retry, release, auto-config, catch-all, cleanup) | No `process-pending` cron. The single failure mode left (cloud-init didn't finish in 5 min) is handled by respawning the VM, not by SSH-retrying configure. |
| `billing/webhook` inline-assigns from pool, calls `configureOpenClaw` via 2,817-line SSH-based function | `billing/webhook` calls `createUserVM(userId, ...)` which does ONE Linode API call with cloud-init userdata. Returns immediately. |
| `vm/configure` route (905 lines) coordinates SSH config, rate limiting, configure_lock, supplemental DB writes, critical-failure gate, ownership re-verify | `vm/configure` route shrinks to ~80 lines that handle the edge case of forced reconfigure (admin emergency reset). The happy path is gone — cloud-init does it. |
| `configureOpenClaw()` in `lib/ssh.ts` — 2,817 lines, 8 phases, 3 critical-marked failures | Becomes `buildCloudInitUserdata()` in `lib/cloud-init-userdata.ts` — ~900 lines of pure string-template construction. No SSH. No DB writes. Just a script. |
| `vm-reconcile.ts` runs 43 steps as drift-repair on every VM every 3 min via `reconcile-fleet` cron | Same `vm-reconcile.ts` runs the same 43 steps as drift-repair. Its real job. Unchanged. |
| 7+ crons coupled via DB state: replenish-pool, cloud-init-poll, process-pending (7 passes), reconcile-fleet, health-check, suspend-check, wake-paid-hibernating | 4 crons total: cloud-init-poll (simplified), reconcile-fleet, health-check, suspend-check. wake-paid-hibernating folds into health-check. |

### The unit economics question

Cooper's third constraint was "cost must come down from $29/mo." This proposal does not change the per-VM cost (the substrate is locked at Linode dedicated). What it changes is the **operational cost** of the platform:

1. **Engineering time spent on race conditions.** This session alone produced Rules 33 and 34, both of which are mitigations for the existing path's partial-commit footguns. Cloud-init's transactional semantics (all-or-nothing first boot) eliminates the class.
2. **Customer support time spent on stuck users.** The 8 stuck-onboarding users found 2026-05-12 didn't manifest as runtime crashes; they manifested as "my dashboard keeps redirecting me." That class of incident dies with the multi-path provisioning that produces it.
3. **Pool overhead.** `POOL_TARGET=15` ready VMs × $29/mo = $435/mo of "VMs sitting empty waiting for signups." For a fleet at ~190 paying users, that's a ~2% overhead. Small but real, and it scales linearly with `POOL_TARGET` (which Cooper has wanted to raise to 50 for Edge Esmeralda — that's $1,450/mo of overhead).

The "cost down from $29" requirement is more honestly answered by Phase 2 (Hetzner migration, separate PRD). This PRD is about getting the code into a shape where Phase 2 is straightforward — instead of porting 7 crons + a 2,817-line configure function to a new provider, you port a `buildCloudInitUserdata()` function and a `createUserVM()` function. Days, not weeks.

### Tradeoffs

| What we gain | What we give up |
|---|---|
| One code path. One failure mode. One thing to test. | Provisioning latency: 30-60s on cold-cloud-init boot vs. <1s pool-assign. (Mitigation: existing `/deploying` UI absorbs this; users tolerate 60s during checkout.) |
| Atomic VM lifecycle: cloud-init succeeded entirely or the VM is failed entirely. No partial-commit states. | Can't iterate per-user state via incremental SSH. (Mitigation: reconciler still does drift repair; runtime SSH paths still exist for admin tooling.) |
| Per-user configuration happens in one place, baked into userdata at provision time. Telegram token, partner, tier, model, channels all atomic with the VM itself. | Userdata size limits (Linode allows 65 KB pre-base64). Current snapshot userdata is ~14 KB. The richer userdata will be ~40-50 KB after we move the configure logic in. Within limits but close. (Mitigation: large templates fetched from a server at first-boot rather than embedded inline.) |
| The reconciler shifts from "first-time configure plus drift repair" (today it does both, badly, per the Explore findings) to "drift repair only." Cleaner mental model. | Existing 200+ VMs are not migrated. They run as-is forever (which is fine because the persistent VM is the product). The new code path only affects new signups. |
| Survives a Hetzner / cheaper-substrate migration as a single port surface. | Cloud-init userdata is per-provider. We need a `lib/providers/<name>/buildCloudInitUserdata.ts` per provider, but each is small (~900 lines). |

### Recommendation

Ship in two phases:

- **Phase 1 (this PRD, 4-6 weeks):** Build `buildCloudInitUserdata()` + `createUserVM()`. Wire `billing/webhook` to call the new path for NEW signups behind a feature flag (`USE_ON_DEMAND_PROVISIONING=true`). Keep the pool / process-pending / SSH-configure paths live as fallback. Cut over fully when canary metrics are green for 1 week.
- **Phase 2 (separate PRD, post-2026-06-30):** Delete the dead code. The pool, process-pending, the bulk of `configureOpenClaw`. Migration of existing VMs is opt-in only and motivated by features, never by infrastructure churn.

---

## 2. Current architecture (with file references)

Reading order: provisioning flow (§2.1) → pool feed (§2.2) → SSH configure (§2.3) → drift repair (§2.4) → cron landscape (§2.5).

### 2.1 The provisioning flow — there are six entry paths

A user can reach "VM assigned and configured" via any of these:

1. **Happy path (~95% of signups):** Stripe `checkout.session.completed` webhook → `billing/webhook` inline calls `assignVMWithSSHCheck(userId)` → calls `provisionBankrWallet` → fetches `/api/vm/configure` × 3 retries × 5s backoff. Times: T0 = Stripe webhook fires, T+1-3s VM assigned from pool, T+60-120s configure complete, user has working Telegram bot.
   - File: `instaclaw/app/api/billing/webhook/route.ts:225-571`
   - Entry to configure: `instaclaw/app/api/vm/configure/route.ts:15` (POST)

2. **Process-pending Pass 0 (orphan recovery):** Cron at `*/5 * * * *` discovers users with active sub + onboarding_complete=false + no VM. Calls `assignVMWithSSHCheck` + `/api/vm/configure`. This is the path that failed khomenko89 for 12 days due to `.limit(3)` with no ORDER BY (now fixed).
   - File: `instaclaw/app/api/cron/process-pending/route.ts:143-329`

3. **Process-pending Pass 1 (pending_users):** Users who created a pending_users row but webhook didn't complete. Same call chain as Pass 0.
   - File: `instaclaw/app/api/cron/process-pending/route.ts:331-407`

4. **Process-pending Pass 2/2b (configure retry):** VM exists, configure failed, `configure_attempts < MAX_CONFIGURE_ATTEMPTS`. Re-fetches `/api/vm/configure`.
   - File: `instaclaw/app/api/cron/process-pending/route.ts:409-522`

5. **Process-pending Pass 2c (release + requeue):** VM exists, `configure_attempts >= MAX_CONFIGURE_ATTEMPTS`. Releases VM back to pool, requeues user. This was the path that ALSO needed Rule 34's per-user state clear (telegram_bot_token + telegram_bot_username + telegram_chat_id null on release).
   - File: `instaclaw/app/api/cron/process-pending/route.ts:524-562`

6. **Process-pending Pass 3 / 3b (auto-config + catch-all):** Belt-and-suspenders for any VM that escaped the above. Various filters.
   - File: `instaclaw/app/api/cron/process-pending/route.ts:564-734`

These six paths converge on the same endpoint (`POST /api/vm/configure`) which then calls the same `configureOpenClaw()` function. The endpoint coordinates rate limiting, `configure_lock`, ownership re-verification, the Rule 33 critical-failure gate, supplemental DB writes, post-config TLS setup, and migration. The 905 lines of `vm/configure/route.ts` are entirely about coordinating these multiple-entry semantics.

### 2.2 The pool — replenish-pool and cloud-init-poll

The pool is pre-warmed VMs sitting in `status="ready"`, waiting to be picked up by `assignVMWithSSHCheck`.

**Pool feed:**
- File: `instaclaw/app/api/cron/replenish-pool/route.ts:51-203` (route handler)
- File: `instaclaw/lib/replenish-pool-logic.ts:70-125` (`decideAction()` — pure function)
- File: `instaclaw/lib/providers/linode.ts:227-287` (`createServer()`)
- Schedule: every 5 min (Vercel cron)
- Policy: floor=10, target=15, ceiling=30, critical_alert=3, max_per_run=10, cost_ceiling=500
- Lock: `instaclaw_cron_locks` table, TTL 360s
- VM name generator: `getNextVmNumber(dbNames ∪ linodeLabels)` at `instaclaw/lib/providers/hetzner.ts:210-220` (also used by Linode despite the name; the Linode-label-listing added 2026-05-12 prevents vm-925-class orphan collisions per CLAUDE.md)

**Boot-to-ready:**
- File: `instaclaw/app/api/cron/cloud-init-poll/route.ts:20-163`
- Schedule: every 2 min
- SSHes as root, looks for sentinel: `test -f ${CLOUD_INIT_SENTINEL} && [openclaw binary in $PATH] && [~/.openclaw dir exists]`
- Flips `status: provisioning → ready` when sentinel present
- 30-min timeout flips to `status: failed`
- The current cloud-init userdata generator: `getSnapshotUserData()` in `instaclaw/lib/providers/linode.ts:145-200` — regenerates SSH host keys, embeds deploy keys, creates placeholder openclaw.json, restarts ssh + fail2ban, installs `getConfigProtectionScript()` + `getBrowserSetupScript()` from `instaclaw/lib/cloud-init.ts`. ~50 lines. Does NOT do user-specific configuration.

### 2.3 The configure path — assignVMWithSSHCheck → configureOpenClaw

When the pool has a `status="ready"` VM and a user needs assignment, the chain is:

**Assignment (inline in webhook + every process-pending pass):**
- File: `instaclaw/lib/ssh.ts:4705` — `assignVMWithSSHCheck(userId, maxAttempts)`
- Picks Linode-only VM, runs SSH-pre-check (rejects dead-but-healthy-marked VMs), atomically updates `assigned_to=userId, assigned_at=now()`, runs `wipeVMForNextUser` as 4th privacy layer
- Inside configureOpenClaw's flow, also handles the privacy-guard wipe (lines 4870-5071 in ssh.ts)

**Configure (the bulk of the complexity):**
- File: `instaclaw/lib/ssh.ts:4834-7650` — `configureOpenClaw(vm, options, userId)` is **2,817 lines** in 8 phases, per the Explore agent's mapping:
  - Phase 1: Pre-flight SSH checks (lines 4846-4868)
  - Phase 2: Privacy guard query + conditional wipe (lines 4870-5071)
  - Phase 3: Config writes — `openclaw.json`, `auth-profiles.json`, `.env`, `WALLET.md` (lines 4937-5331)
  - Phase 4: Workspace + scripts + skill deploys (lines 5663-6329)
  - Phase 5: Cron installation (lines 6391-6413, iterates `VM_MANIFEST.cronJobs`)
  - Phase 6: Mega-script execution with `OPENCLAW_CONFIGURE_DONE` + `GATEWAY_ROLLBACK_TRIGGERED` sentinels (lines 7280-7350)
  - Phase 7: Gateway health check + atomic DB update (lines 7351-7498)
  - Phase 8: AgentBook wallet generation (lines 7410-7424)
- The atomic DB update writes: `gateway_url, gateway_token, control_ui_url, health_status="healthy", config_version=0, previous_gateway_token, agentbook_wallet_address`. This is the "VM is real" write.
- Per Rule 33, this write happens BEFORE supplemental writes (telegram_bot_username, partner, onboarding_complete=true, pending_users.consumed_at). Those happen back at the route layer (`vm/configure/route.ts:527-575`). The partial-commit between the two windows IS the trap state.
- **3 `recordFailure(..., critical: true)` calls:** dispatch_deploy (5740), browser_relay_deploy (5772), agentbook_wallet_generation (7430). Per Rule 33, any of these triggers the critical-failure gate in `vm/configure/route.ts:408-525`.

**Helpers exported from ssh.ts (~4,300 lines of helpers + ~3,600 lines of templates):**
- `checkDuplicateIP` (4552)
- `connectSSH` (4573)
- `assignVMWithSSHCheck` (4705)
- `auditVMConfig` (8349) — calls `reconcileVM` with strict=false
- `wipeVMForNextUser` (8426) — 4th-layer privacy wipe
- `stopGateway` (9886) / `startGateway` (9896) / `restartGateway` (9695)

### 2.4 The reconciler — vm-reconcile.ts

Drift-repair engine. Walks 43 `stepX(...)` functions in order. Today it runs on EVERY VM where `config_version < VM_MANIFEST.version`, every 3 minutes via the `reconcile-fleet` cron.

- File: `instaclaw/lib/vm-reconcile.ts` — 5,280 lines, 43 steps
- Entry: `reconcileVM(vm, manifest, options)` (line 179) → wrapped by `auditVMConfig` in ssh.ts:8349
- Cron route: `instaclaw/app/api/cron/reconcile-fleet/route.ts`
- Candidate filter: `status='assigned' AND provider='linode' AND health_status='healthy' AND config_version < VM_MANIFEST.version AND gateway_url IS NOT NULL AND reconcile_quarantined_at IS NULL`
- Batch size: `CONFIG_AUDIT_BATCH_SIZE = 3` (reduced 2026-05-05 from 10 — per-VM cost is ~150-300s post-v87/v88, doesn't fit in 300s Vercel budget at higher concurrency)
- Strict mode (`STRICT_RECONCILE_VM_IDS` env): per-key verify + canary probe; blocks `config_version` bump on `strictErrors.length > 0`; auto-quarantines at K=10 consecutive failures
- Non-strict (default): `result.errors` gate; same `pushFailed` semantics, less aggressive

**Key finding from the Explore agent's mapping:** *the reconciler does drift-repair only.* It assumes the VM is already provisioned. `stepConfigSettings` doesn't create `openclaw.json`, it diffs+fixes existing keys. `stepFiles` appends/inserts into existing SOUL.md, it doesn't initialize. The heal steps (stepBootstrapState, stepShmCleanupCron, stepDispatchServer, stepInstaclawXmtp, stepNodeExporter) detect missing state and re-deploy — but they're patching configureOpenClaw's silent omissions (estimated ~30% rate per the 2026-04-28 audit referenced in vm-reconcile.ts).

This means: if cloud-init does its job, ~30 of the 43 steps become structurally redundant. The reconciler shrinks to "drift over time" not "first-time-install backfill."

### 2.5 The cron landscape

| Cron | Schedule | Purpose | Lines |
|---|---|---|---|
| `replenish-pool` | every 5 min | Maintain `ready` pool [10, 15] with ceiling 30 | 422 |
| `cloud-init-poll` | every 2 min | Flip `provisioning → ready` on sentinel | 163 |
| `process-pending` | every 5 min | 7-pass orphan/retry/release/auto-config | 809 |
| `reconcile-fleet` | every 3 min | Drift-repair via vm-reconcile.ts | (route is ~300 lines) |
| `health-check` | every 5 min | VM health probe, billing-cache, watchdog v1 (gated off) | (route is ~600 lines) |
| `suspend-check` | every 5 min | past_due → hibernating | ~200 |
| `wake-paid-hibernating` | every 15 min | hibernating + isPaying → wake | ~150 |
| `watchdog` | every 5 min | Watchdog v2 (shadow mode) | ~400 |
| `recurring-tasks` | every 5 min | Scheduled-task fulfillment | ~250 |
| (10 more crons, less load-bearing) | various | various | various |

For this PRD, the load-bearing ones are: replenish-pool, cloud-init-poll, process-pending, reconcile-fleet. The others are unaffected.

---

## 3. Failure modes — every one Cooper named, with root cause

For each: the file(s) that produced the failure, the file(s) that fixed it (or didn't), and whether the proposed architecture prevents it structurally.

### 3.1 khomenko89 12-day wait (Pass 0 starvation, 2026-04-30 → 2026-05-12)

- **Symptom:** User paid 2026-04-30, pool was empty when her webhook fired, pending row deleted by Pass 4 before Pass 1 could assign. Pass 0 should have recovered her. Did not — for 12 days.
- **Root cause file:** `instaclaw/app/api/cron/process-pending/route.ts` (pre-fix). Pass 0 used `.limit(3)` with **no ORDER BY** and **no filter to exclude users who already had a VM**. Each cron tick returned 3 random "soft-incomplete" orphans (paid + have VM + onboarding_complete=false). The in-loop existingVm check skipped them. Loop exited with zero recoveries. The cron ran 3,456 times over 12 days and never picked her up.
- **Fix file:** `instaclaw/app/api/cron/process-pending/route.ts:143-329` (commit `a527f867`, 2026-05-12). Pre-fetch `assignedUserIds`, exclude via `.not("user_id","in",...)`, `ORDER BY instaclaw_users(partner) DESC NULLS LAST` then `created_at ASC`, `limit(30)` with `count:"exact"` for queue-depth observability.
- **Prevented structurally by new arch?** ✅ **YES.** There IS no Pass 0 because there is no "user paid but pool was empty so they're stuck waiting for a cron to discover them." The webhook creates the VM directly. If the Linode API call fails, the webhook returns 500 and Stripe retries the webhook itself. If the VM never reaches healthy, `cloud-init-poll` flips it to failed and a new lightweight respawn path creates a fresh VM. The "orphan paid user" class of bug doesn't exist because there's no orphan state to be in.

### 3.2 vm-925 orphan (replenish-pool blocked 3 days, 2026-05-09 → 2026-05-12)

- **Symptom:** Linode instance `id=97369836, label=instaclaw-vm-925` existed on Linode but had no DB row. Every replenish-pool tick generated the same colliding name (because the name generator queried only DB names), Linode 400'd with "Label must be unique," the tick aborted before provisioning anything. Pool stayed empty.
- **Root cause file:** `instaclaw/lib/providers/hetzner.ts:210-220` (`getNextVmNumber`) — was DB-only, didn't consult Linode-side labels. Plus `instaclaw/app/api/cron/replenish-pool/route.ts:251-422` (`provisionVMs`) — caught the label-collision error but `break`'d the batch instead of `continue`'ing to the next name, AND the original code's fire-and-forget `sendAdminAlertEmail` calls didn't write to the dedup log, so the visibility gap was real (288 fires/day × 8 errors/tick × 0 alerts surfacing).
- **Fix file:** `instaclaw/lib/providers/linode.ts:70-87` (`listInstanceLabelsMatching`, added 2026-05-12). Merges Linode labels with DB names before the name generator picks. Plus the AlertCollector pattern in `replenish-pool/route.ts:171-184` for digest emails.
- **Prevented structurally by new arch?** ✅ **YES.** There is no name generator that has to dedupe across DB and provider. Each Stripe checkout produces ONE Linode VM with a deterministic name derived from the user ID (e.g., `instaclaw-vm-${userId.slice(0,8)}` or just `instaclaw-vm-${randomUUID()}`). No batch creation, no name-counter contention, no orphan-collision class.

### 3.3 dispatch ENOENT (Vercel bundle missing .sh files, 2026-05-09 → 2026-05-12)

- **Symptom:** `configureOpenClaw` → `recordFailure("dispatch_deploy", critical=true)` on every configure attempt for ~120 hours straight, because the file `/ROOT/instaclaw/skills/computer-dispatch/scripts/dispatch-screenshot.sh` was missing from the deployed Vercel bundle. Next 15 `outputFileTracingIncludes` didn't pick up `.sh` files via the path glob shape that was used.
- **Root cause file:** `instaclaw/next.config.ts` (the `outputFileTracingIncludes` glob shape) + `instaclaw/lib/ssh.ts:~5736-5740` (the dispatch deploy step that does `fs.readFileSync('./skills/computer-dispatch/scripts/dispatch-screenshot.sh')` at SSH time).
- **Fix file:** Commit `b3d58bc4` ("inline dispatch scripts to bypass Next 15 NFT .sh bundling") — inlines the script bodies into the TypeScript module, eliminating the filesystem read at runtime.
- **Prevented structurally by new arch?** ✅ **YES.** With cloud-init userdata, the dispatch script bytes live in the snapshot (baked at snapshot bake time, not read from a Vercel deployment at runtime). The bundling problem doesn't exist because the runtime doesn't read these files — the VM does, from its own disk. The cloud-init userdata only needs to set per-user variables; the static dispatch scripts are already on the VM via the snapshot.

### 3.4 health-check clobbering configure_failed (race, ongoing)

- **Symptom:** `process-pending` Pass 2 marks a VM as `health_status="configure_failed"` and increments `configure_attempts`. Then `health-check` cron runs, sees the gateway is up (it's running, just misconfigured), and flips `health_status="healthy"`. Now Pass 2's filter (`health_status="configure_failed"`) misses the VM forever.
- **Root cause file:** `instaclaw/app/api/cron/health-check/route.ts` (multiple healthy-write sites). Mitigated by adding `.neq("health_status","configure_failed")` filter to 5 write sites + Pass 0 bucket logic for configure_failed VMs (this session's commits, 2026-05-12).
- **Prevented structurally by new arch?** ✅ **YES.** There is no `health_status="configure_failed"` state in the new architecture. A VM either reaches `healthy` via cloud-init or it does not. If it does not, the VM is destroyed (Linode API delete) and a fresh one is provisioned. The reconciler still does drift-repair for runtime issues, but it does not race a configure-retry cron because that cron doesn't exist.

### 3.5 Telegram token drift — disk vs DB (Rule 34, 8 VMs over 60 days)

- **Symptom:** DB has `telegram_bot_token` set, on-disk `openclaw.json` has no `channels.telegram.botToken`. Agent runs but Telegram doesn't connect. Caused by `configureOpenClaw`'s gateway-startup rollback path: when the new config triggered a gateway-start failure, bash script copied `openclaw.json.last-known-good` (the `{"_placeholder":true}` blob) over the new config. `OPENCLAW_CONFIGURE_DONE` was printed regardless of rollback. Route handler proceeded to write `telegram_bot_token` into the DB. DB↔disk diverged. 60 days of reachability.
- **Root cause file:** `instaclaw/lib/ssh.ts:7236-7253` (the rollback path) + `instaclaw/lib/ssh.ts:~7321` (the sentinel-handler that didn't differentiate rollback from success).
- **Fix file:** Same — `instaclaw/lib/ssh.ts` now throws on `GATEWAY_ROLLBACK_TRIGGERED` BEFORE the DB write (this session). Plus `stepTelegramTokenVerify` in `vm-reconcile.ts:1708-1814` as DB→disk self-heal (Rule 34).
- **Prevented structurally by new arch?** ✅ **YES.** Cloud-init is atomic: either all per-user config lands or the VM fails entirely. There is no "post-DB-write rollback to placeholder" path because the DB is only written AFTER cloud-init reports success (and the cloud-init script either succeeded or didn't run to completion; no in-between). The disk and DB cannot disagree because the DB only learns "VM is configured" after the script has finished writing the disk.

### 3.6 Release path leaking stale tokens (Rule 34 origin)

- **Symptom:** Released VMs (process-pending Pass 2c) went back to the ready pool with the prior user's `telegram_bot_token` + `telegram_bot_username` + `telegram_chat_id` still in the DB row. Next assignee inherited the prior user's Telegram identity until the next configure overwrote it (which, if it failed, never happened — see 3.4).
- **Root cause file:** `instaclaw/app/api/cron/process-pending/route.ts:547-554` (Pass 2c — the release update) and `instaclaw/app/api/vm/configure/route.ts:849-878` (the configure-route error catch path).
- **Fix file:** Same files — both now null-out the three Telegram fields on release (this session's commits).
- **Prevented structurally by new arch?** ✅ **YES.** There is no pool. There is no release-to-pool-then-reassign. If a VM fails its first configure, the VM is destroyed entirely. The next user gets a brand-new VM with no inherited state.

### 3.7 Zombie VMs (status=terminated, health=healthy)

- **Symptom:** DB rows with `status="terminated"` but `health_status="healthy"`. The two states diverged because different write paths (vm-lifecycle delete-pass vs health-check resurrect-pass) didn't gate against each other. ~10-30 zombies at any given time in the 220-row fleet.
- **Root cause files:** `instaclaw/app/api/cron/vm-lifecycle/route.ts` + `instaclaw/app/api/cron/health-check/route.ts` + `instaclaw/app/api/billing/webhook/route.ts:441-443` (the `.not("status","in",'("terminated","destroyed","failed")')` guard on every healthy-write — added piecewise as the failure mode surfaced).
- **Prevented structurally by new arch?** ✅ **MOSTLY YES.** With one provisioning code path, the `status` column has fewer transitions. The lifecycle states are: `provisioning` → `healthy` → `suspended` → `frozen` → `terminated`. There is no "ready" pool intermediate state. The cross-cron race surface shrinks. Some zombie potential remains (e.g., a delete + resubscribe race) but it's vastly reduced.

### 3.8 Pool drain under burst signup (100 signups in 1 hour)

- **Symptom:** Webhook drains pool to 0, subsequent signups fall back to Pass 0. With `MAX_PER_RUN=10` and 5-min cadence, replenish-pool refills 96 VMs/hour. Demand of 100/hour ≈ balanced; viral burst of 500/hour collapses to a queue.
- **Root cause:** the pool is a finite buffer. Reflexive mitigations: raise `MAX_PER_RUN`, raise `POOL_TARGET`, pre-warm before known events.
- **Prevented structurally by new arch?** ✅ **YES** (with caveat). No pool, no pool drain. Bursts are limited only by the Linode API throughput (which is generous: 1,200 requests/hour per account at small scale, plus there's no batch creation — each request is just one VM). Each signup is independent; 500 simultaneous signups create 500 independent Linode VM-create requests, each completing in ~30-60s. Caveat: a true viral spike (10,000/hour) would hit Linode account limits; that's a separate scaling conversation. The current 100-500/hour Edge Esmeralda burst is well within trivial.

### 3.9 Eight stuck-onboarding users (Rule 33 origin, 2026-05-09 → 2026-05-12)

- **Symptom:** `instaclaw_vms.assigned_to=userId, gateway_url=set, health_status="healthy"` but `instaclaw_users.onboarding_complete=false, instaclaw_pending_users.consumed_at=null`. Users trapped in `/dashboard → /connect → /plan → /deploying → /dashboard` loop. configureOpenClaw's atomic write landed; the supplemental writes in vm/configure/route.ts didn't (critical-failure gate returned 500 before reaching them).
- **Root cause files:** `instaclaw/app/api/vm/configure/route.ts:408-525` (the critical-failure gate, pre-fix) + the dashboard layout's redirect at `instaclaw/app/(dashboard)/layout.tsx`.
- **Fix files:** Same — both updated to write `configure_failed` + increment `configure_attempts` (so the retry machinery picks them up) and use a data-driven redirect based on VM state. Plus Rule 33 in CLAUDE.md.
- **Prevented structurally by new arch?** ✅ **YES.** The 8 stuck users existed because the atomic VM update (configureOpenClaw, in ssh.ts) and the supplemental DB updates (vm/configure/route.ts) were in two different code paths that could partially commit. In the new architecture, cloud-init does the disk writes and the DB write happens ONCE at the end (after cloud-init reports success). There is no partial-commit window between two writers because there is one writer.

### 3.10 Summary table

| Failure | Files responsible | Files that fixed it | New arch prevents? |
|---|---|---|---|
| khomenko89 Pass 0 starvation | process-pending/route.ts | process-pending/route.ts | ✅ Pass 0 doesn't exist |
| vm-925 orphan | replenish-pool + name gen | linode.ts (label-listing) | ✅ no pool, no name contention |
| dispatch ENOENT | next.config + ssh.ts | inline scripts | ✅ scripts live on VM disk |
| health-check clobbering | health-check + process-pending | filter guards | ✅ no configure_failed state |
| Telegram token drift | ssh.ts rollback path | rollback throws + reconciler verify | ✅ cloud-init is atomic |
| Release path leaks | process-pending + configure route | null-out on release | ✅ no release-to-pool |
| Zombie VMs | vm-lifecycle + health-check race | terminal-status guards | ✅ mostly — fewer transitions |
| Pool drain under burst | finite pool buffer | raise POOL_TARGET | ✅ no pool to drain |
| 8 stuck-onboarding users | configure route partial commit | Rule 33 + data-driven redirect | ✅ one writer, no partial commit |

**Common pattern:** every failure traces to a state held across multiple code paths that didn't agree on the source of truth. Cloud-init makes the VM disk the source of truth and writes the DB only at the end. The state distribution collapses.

---

## 4. The architectural insight

### 4.1 What configureOpenClaw actually does

The Explore agent's mapping in §2.3 enumerates 8 phases. Almost every step is one of:
1. **Generate a script or config string** (template construction, mostly pure)
2. **Write that string to the VM via SSH** (the network round trip is the slow + failure-prone part)
3. **Run a bash command on the VM via SSH** (apt install, npm install, systemctl, etc.)
4. **Verify a sentinel was emitted** (`OPENCLAW_CONFIGURE_DONE`, `GATEWAY_ROLLBACK_TRIGGERED`)

The interesting observation: **steps 2 and 3 are exactly what cloud-init does at first boot, but locally, as root, with no network round-trip.** Step 1 is unchanged. Step 4 becomes "did cloud-init's script finish?" — checkable via an SSH probe identical to the one cloud-init-poll already does.

In other words: configureOpenClaw is a 2,817-line bash script being constructed and shipped over SSH at runtime. Cloud-init lets us ship the same bash script via Linode's `metadata.user_data` API at VM-create time. The VM runs it locally during first boot. We never have to SSH in.

### 4.2 What this changes in failure semantics

**Today:** configureOpenClaw can fail in 8 ways (one per phase). Each failure is a partial-commit candidate. We mitigate with `OPENCLAW_CONFIGURE_DONE` sentinel + `recordFailure` + critical-failure gate + Rule 33 + Rule 34. These mitigations are necessary because the script is being run incrementally over SSH and the runtime can crash mid-execution.

**Tomorrow:** cloud-init runs the entire script in one bash process. There are only TWO failure modes:
1. The script ran to completion → succeeded
2. The script did not run to completion → failed

The script ends by writing a single sentinel file (`/tmp/.instaclaw-ready-${userId}`) and reporting health to a webhook. If neither happens within 5 minutes, the VM is failed and a respawn is triggered (one Linode API delete + one Linode API create).

There is no "partial success." There is no "configure_failed but gateway healthy." There is no "DB says one thing, disk says another."

### 4.3 What the userdata contains — concrete byte budget

Linode allows **65,536 bytes (64 KB)** of base64-encoded `user_data` per their docs. Base64 inflates by 4/3, so the pre-base64 limit is **~49,152 bytes (48 KB)**. Anything over that → API rejects the create-server call → we cannot provision.

#### What lives in the snapshot vs in userdata

The CLAUDE.md "Snapshot Creation Process" (step 4) bakes the static workspace files into the snapshot itself: `SOUL.md`, `CAPABILITIES.md`, `TOOLS.md`, `EARN.md`, `QUICK-REFERENCE.md`, `AGENTS.md`, `MEMORY.md`, all VM-side scripts (strip-thinking.py, vm-watchdog.py, silence-watchdog.py, etc.), and the 7 mandatory cron jobs. **These are already on the VM disk when cloud-init begins.**

Cloud-init's userdata writes ONLY what varies per user, not what's universal across the fleet. Concretely:

| Section | Measured / estimated bytes | Source |
|---|---|---|
| Bash header + `set -euo pipefail` + logging redirect | 200 | inline |
| SSH personalization (current `getSnapshotUserData()` body) | 2,200 | `lib/providers/linode.ts:148-197` |
| Per-user `openclaw.json` construction | 5,000 | `buildOpenClawConfig(params)` — telegram tokens, channels, model, tier, partner, gateway config (largest single block) |
| `auth-profiles.json` construction | 800 | gateway token + anthropic:default profile |
| `.env` writes (`GATEWAY_TOKEN`, `BANKR_WALLET_ADDRESS`, partner env vars) | 600 | per-user |
| AgentBook wallet generation script (openssl rand + viem EIP-55 derivation + key file write) | 1,500 | currently `lib/ssh.ts:7410-7424` |
| Partner-gated SOUL.md overlay — appends `## Edge Esmeralda 2026` section (only when `partner=edge_city`) | 1,200 | from `edgeclaw-partner-integration.md` §4.6 |
| Gmail profile summary overlay (only when user connected Gmail at onboarding) | 2,500 | dynamic, P95 size |
| Edge City skill install (`git clone github.com/aromeoes/edge-agent-skill.git`) | 600 | one bash block, per `edgeclaw §4.4` |
| Bankr CLI env-var injection (`BANKR_API_KEY`, etc. — only when bankr is enabled) | 400 | per-user |
| Workspace identity patch (per-user partner-tagged `## Platform` section in SOUL.md if not already present) | 500 | mirrors `stepInstaClawIdentityPatch` (vm-reconcile.ts:3525-3698) |
| Crontab re-assertion of the 7 mandatory crons (idempotent, marker-based — defense vs stale snapshot) | 1,500 | `VM_MANIFEST.cronJobs` |
| `systemctl --user daemon-reload && start openclaw-gateway` + health-check loop | 1,200 | bash, 30 × 2s probe |
| Callback POST to `/api/vm/cloud-init-callback` with `callback_token` (see §5.3) and `agentbook_address` | 600 | `curl` block |
| Final sentinel: `touch /tmp/.instaclaw-ready` + log truncate | 200 | inline |
| Padding / future per-user fields (gmail_insights, partner-tagged identity sections, etc.) | 2,000 | reserve |
| **Subtotal — happy path, edge_city + gmail user** | **21,000** | |
| **Subtotal — happy path, non-partner + no gmail** | **14,500** | |

Pre-base64: **~14.5-21 KB**. Post-base64: **~19-28 KB**. Comfortably under Linode's 48 KB pre-base64 ceiling.

#### What does NOT go in userdata (the explicit non-list)

Sized for reference. These live in the snapshot. The reconciler keeps them current after first boot via the existing drift-repair path.

| Template | Measured bytes | Why not in userdata |
|---|---|---|
| `WORKSPACE_SOUL_MD_V2` + supplements (the deployed SOUL.md) | ~26,000 | Baked in snapshot at bake time. Stale baseline gets healed by reconciler `stepFiles` within 3 min of next bump. |
| `WORKSPACE_AGENTS_MD_V2` | 19,017 | Same. |
| `WORKSPACE_CAPABILITIES_MD` | 15,744 | Same. |
| `WORKSPACE_EARN_MD` | 10,501 | Same. |
| `WORKSPACE_TOOLS_MD_V2` | 6,488 | Same. |
| `WORKSPACE_QUICK_REFERENCE_MD` | 2,028 | Same. |
| `WORKSPACE_IDENTITY_MD_V2` | 491 | Same. |
| VM-side scripts (strip-thinking.py, vm-watchdog.py, silence-watchdog.py, push-heartbeat.sh, auto-approve-pairing.py, generate_workspace_index.sh) | ~30,000 combined | Baked in snapshot at `~/.openclaw/scripts/`. Cron blocks in userdata only assert they're scheduled — they don't write the script bodies. |
| Skill repos (bankr, computer-dispatch, browser-relay, voice, language-teacher, etc.) | ~hundreds of KB combined | Already in snapshot at `~/.openclaw/skills/`. Updated via `git pull` cron, not userdata. |

**Workspace template sum (NOT shipped in userdata, but for honesty):** 26,000 + 19,017 + 15,744 + 10,501 + 6,488 + 2,028 + 491 = **80,269 bytes**. If we ever tried to ship the full workspace inline, we'd exceed Linode's limit by 30+ KB even before scripts and skills. We do not try. The snapshot does this job.

#### Implication: snapshot freshness is load-bearing

Because cloud-init's userdata relies on the snapshot containing current workspace baselines, **CLAUDE.md Rule 7 ("Snapshot Refresh After Manifest Bumps") becomes more load-bearing under this architecture, not less.** A stale snapshot means new VMs land with stale workspace baselines, and the user's first 0-3 minutes have stale content until the reconciler catches them up.

This is acceptable because:
1. It's the same staleness behavior as today — `configureOpenClaw` also relies on the snapshot for static workspace files.
2. The reconciler's 3-minute drift-repair window is already the SLO for "post-bake bumps land on existing fleet."
3. The userdata's crontab re-assertion (~1.5 KB block, listed above) is a defensive belt-and-suspenders: even if the snapshot doesn't have a particular cron, userdata installs it. So at minimum, the 7 mandatory crons are guaranteed regardless of snapshot staleness.

We do NOT introduce a "fetch full workspace from URL at first boot" pattern. That would add a network dependency at first boot (DNS, TLS, our CDN, our auth) — too many things that can fail before the agent is even alive. The snapshot-baked baseline + reconciler-driven drift-repair pattern handles the same case with no first-boot network dependency.

#### Failure mode: userdata size overflow (Rule 31 test)

A unit test in `scripts/_test-cloud-init-userdata.ts` (per Rule 31) generates the userdata for the largest realistic param combination:
- `partner=edge_city`
- `gmail_profile_summary` = P99 size (~6 KB)
- All channels enabled (telegram + discord + slack + whatsapp)
- All env-var partner blocks active

Asserts the resulting userdata length < **40,000 bytes pre-base64** (10% safety margin under Linode's 48 KB pre-base64 ceiling). If the assertion ever fires in CI, the PR doesn't merge until the offending section is trimmed or moved to snapshot-baked state.

#### Fallback contingency only (NOT primary path)

If a future PRD demands shipping content that simply must be per-user AND is too large for userdata (hypothetical: per-user-customized 30 KB SOUL section), the contingency is:

1. Cloud-init writes a placeholder `~/.openclaw/.first-boot-pending` marker
2. Reconciler's first-cycle sees the marker and fetches the per-user content from `/api/vm/first-boot-content/${userId}` with the gateway-token auth
3. Reconciler writes the content + removes the marker

**Failure modes of this contingency (why we avoid making it the primary path):**
- **Network dependency at first boot.** If our API is briefly down at the moment the reconciler ticks for this VM, the VM stays in "missing content" state for ≥3 min. Today's path has the same problem in a different shape, but moving to "snapshot + reconciler" eliminates this for the 99% case.
- **Auth chicken-and-egg.** The gateway token must be in the DB before the fetch can authenticate, but the fetch is what bootstraps the content the gateway needs. Solvable (gateway token is generated in `createUserVM`, so it's in the DB before cloud-init even starts), but introduces ordering constraints.
- **Reconciler queue contention.** First-boot fetches compete with drift-repair for the 3-VM-per-cycle batch budget. A signup burst could starve drift-repair on existing VMs.
- **Source of truth fragmentation.** If part of the workspace lives in snapshot and part in API, debugging "what's actually on this VM" requires checking two sources.

None of these are deal-breakers, but they're real. The primary path keeps content in the snapshot. The fetch-from-URL contingency only activates if a future PRD genuinely cannot fit content in userdata AND cannot bake it in the snapshot. As of this PRD, no such content exists.

### 4.4 What this doesn't change

- The snapshot baking process (CLAUDE.md `OpenClaw Upgrade Playbook`) is unchanged. The snapshot still contains the static state (Node, OpenClaw binary, npm packages, skill repos, system packages, default config protection scripts, baked-in cron jobs). Cloud-init handles only the per-user overlay.
- The reconciler (vm-reconcile.ts) is unchanged in its 43 steps. It just runs less often per VM, because there's less drift to fix (cloud-init landed everything correctly the first time).
- `VM_MANIFEST` is unchanged. It's the source of truth for both cloud-init (what to write at first boot) and the reconciler (what to verify on every cycle).
- The customer-facing UI is unchanged. `/connect`, `/plan`, `/deploying`, `/dashboard` all work as today. The `/deploying` polling already handles up-to-3-min waits; the new arch's typical wait is 60-120s, well within the existing UX budget.

---

## 5. Proposed architecture

### 5.1 The new code path (provisioning)

```
User clicks "Subscribe"
  ↓
Stripe checkout (existing)
  ↓
checkout.session.completed webhook fires
  ↓
billing/webhook calls createUserVM(userId, params)
  ↓
createUserVM:
  1. Fetch user profile (partner, tier, model preference, gmail summary, etc.)
  2. Fetch pending_users row (telegram_bot_token, telegram_bot_username, channels)
  3. Provision Bankr wallet via provisionBankrWallet (existing — returns wallet address)
  4. Generate gateway_token (randomBytes(32) hex) — long-lived; authenticates gateway-to-proxy and the VM's outbound calls FOR THE LIFE OF THE VM
  5. Generate callback_token (randomBytes(32) hex) — ONE-TIME-USE nonce, distinct from gateway_token; authenticates exactly one POST to /api/vm/cloud-init-callback and is invalidated on first successful use
  6. Build userdata string via buildCloudInitUserdata(userId, params, callback_token)
  7. Call linodeProvider.createServer({ name, userData })
  8. INSERT instaclaw_vms row with:
     - status: "provisioning"
     - assigned_to: userId  ← key difference from today: assigned at create time
     - assigned_at: now()
     - gateway_token: <generated>
     - cloud_init_callback_token: <generated>  ← new column, see §5.3
     - cloud_init_callback_consumed_at: NULL  ← set to now() on first successful callback
     - bankr_evm_address: <from provisionBankrWallet>
     - telegram_bot_token / telegram_bot_username / partner / tier / model / channels (per-user values written ATOMICALLY with the row insert)
     - config_version: VM_MANIFEST.version  ← cloud-init wrote the manifest version, no reconciler retry needed for first boot
  9. UPDATE instaclaw_pending_users SET consumed_at = now() WHERE user_id = userId
  10. UPDATE instaclaw_users SET onboarding_complete = true WHERE id = userId
  ↓
billing/webhook returns 200 to Stripe (after responding asynchronously per existing pattern)
  ↓
User redirected to /deploying
  ↓
/deploying polls /api/vm/status (existing endpoint)
  ↓
/api/vm/status:
  - Queries instaclaw_vms WHERE assigned_to = userId
  - If status = "provisioning": tells UI "still booting"
  - If status = "healthy": tells UI "go to dashboard"
  - If status = "failed": tells UI "retry" and triggers respawn (separate path, see 5.4)
  ↓
Meanwhile cloud-init-poll cron (every 2 min):
  - SSHes into VMs WHERE status = "provisioning"
  - Looks for /tmp/.instaclaw-ready sentinel (richer than today's CLOUD_INIT_SENTINEL)
  - On sentinel found: probe http://VM_IP:18789/health
  - If 200: UPDATE instaclaw_vms SET status="healthy", gateway_url=..., last_health_check=now()
  - If health probe fails: leave at "provisioning" for next cron cycle
  - If 30 min elapsed without sentinel: UPDATE status="failed", health_status="unhealthy"
  ↓
User now sees /dashboard with working Telegram bot
```

The key invariants:
- **One writer:** `createUserVM` is the only function that creates a VM row. No assign-from-pool race, no concurrent webhook race.
- **Atomic state:** the DB row's per-user fields and the VM's userdata are constructed in the same function call. They cannot disagree.
- **Linear progress:** `provisioning` → `healthy` is monotonic. There's no `configure_failed` intermediate (a failure means the VM is destroyed and respawned, not "the VM is healthy but configure didn't finish").
- **No SSH-from-Vercel for first-time configure:** Vercel only SSHes for `cloud-init-poll`'s sentinel probe (a single `test -f` command, ~2s) and for the reconciler's drift-repair (which runs at a leisurely cadence).

### 5.2 The new code path (drift repair, unchanged)

The reconciler keeps doing what it does today: every 3 min, the `reconcile-fleet` cron picks 3 VMs where `config_version < VM_MANIFEST.version`, walks the 43 steps, fixes any drift, bumps `config_version`. Unchanged.

The only difference is that NEW VMs land at `config_version = VM_MANIFEST.version` from cloud-init (because cloud-init wrote the current manifest version directly). They don't enter the reconciler queue until a future manifest bump rolls them in. This dramatically reduces reconciler load — today every NEW VM enters the queue at `config_version=0` (the configureOpenClaw "force re-verify" trick at ssh.ts:7475-7492) and walks all 43 steps once. Tomorrow new VMs skip that walk because cloud-init landed correctly.

### 5.3 What `buildCloudInitUserdata` looks like

```typescript
// instaclaw/lib/cloud-init-userdata.ts — NEW FILE

import { VM_MANIFEST } from "./vm-manifest";
import { /* templates */ } from "./agent-intelligence";

interface CloudInitParams {
  userId: string;
  vmName: string;
  gatewayToken: string;
  partner: string | null;
  tier: "starter" | "pro" | "power";
  apiMode: "all_inclusive" | "byok";
  model: string;
  channels: string[];
  telegramBotToken?: string;
  telegramBotUsername?: string;
  discordBotToken?: string;
  bankrEvmAddress?: string;
  bankrApiKey?: string;
  gmailProfileSummary?: string;
  worldIdNullifier?: string;
  // ... ~25 fields total
}

export function buildCloudInitUserdata(params: CloudInitParams): string {
  return `#!/bin/bash
set -euo pipefail
exec > >(tee -a /var/log/instaclaw-cloud-init.log) 2>&1
echo "[$(date -u +%FT%TZ)] cloud-init starting for user ${params.userId}"

# ── Phase 1: SSH personalization (existing snapshot logic) ──
${getSnapshotUserDataInline()}

# ── Phase 2: Per-user openclaw.json ──
cat > /home/openclaw/.openclaw/openclaw.json <<'EOF'
${buildOpenClawConfig(params)}
EOF
chown openclaw:openclaw /home/openclaw/.openclaw/openclaw.json
chmod 600 /home/openclaw/.openclaw/openclaw.json

# ── Phase 3: auth-profiles.json ──
mkdir -p /home/openclaw/.openclaw/agents/main/agent
cat > /home/openclaw/.openclaw/agents/main/agent/auth-profiles.json <<'EOF'
${buildAuthProfiles(params)}
EOF
chown -R openclaw:openclaw /home/openclaw/.openclaw/agents

# ── Phase 4: .env (gateway token, wallet, partner tokens) ──
cat >> /home/openclaw/.openclaw/.env <<'EOF'
GATEWAY_TOKEN=${params.gatewayToken}
BANKR_WALLET_ADDRESS=${params.bankrEvmAddress ?? ""}
${params.partner === "edge_city" ? `EDGEOS_BEARER_TOKEN=${process.env.EDGEOS_BEARER_TOKEN}` : ""}
${params.partner === "edge_city" ? `SOLA_AUTH_TOKEN=${process.env.SOLA_AUTH_TOKEN}` : ""}
EOF
chown openclaw:openclaw /home/openclaw/.openclaw/.env

# ── Phase 5: Workspace files (SOUL.md, CAPABILITIES.md, MEMORY.md, etc.) ──
${buildWorkspaceFiles(params)}

# ── Phase 6: AgentBook wallet generation (local on VM) ──
mkdir -p /home/openclaw/.openclaw/wallet
openssl rand -hex 32 > /home/openclaw/.openclaw/wallet/agent.key
chmod 600 /home/openclaw/.openclaw/wallet/agent.key
chown -R openclaw:openclaw /home/openclaw/.openclaw/wallet
# Derive EIP-55 address and report back via webhook
AGENTBOOK_ADDR=$(node -e '
  const { privateKeyToAccount } = require("/usr/local/lib/node_modules/viem/accounts");
  const fs = require("fs");
  const key = fs.readFileSync("/home/openclaw/.openclaw/wallet/agent.key","utf-8").trim();
  console.log(privateKeyToAccount("0x"+key).address);
')

# ── Phase 7: Partner-gated skill install ──
${params.partner === "edge_city" ? buildEdgeCitySkillInstall() : ""}

# ── Phase 8: Cron installation (idempotent, marker-based, runs locally now) ──
${buildCronInstalls()}

# ── Phase 9: Gateway start ──
sudo -u openclaw bash -lc '
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  systemctl --user daemon-reload
  systemctl --user start openclaw-gateway
'

# ── Phase 10: Health verification + sentinel + DB-callback ──
# Authentication: callback_token is a one-time-use nonce, NOT the long-lived
# gateway_token. The two have distinct threat models:
#
#   - gateway_token authenticates the gateway's ongoing API calls for the
#     life of the VM. It is necessarily in plaintext in ~/.openclaw/.env
#     and in the userdata script (which is preserved on disk as /var/lib/
#     cloud/instances/<id>/user-data.txt). If the VM is later compromised,
#     the attacker reads gateway_token and impersonates the gateway. That
#     is the normal threat envelope of any long-lived credential.
#
#   - callback_token authenticates exactly one POST: cloud-init's "I am
#     healthy" announcement. It is generated by createUserVM, embedded in
#     userdata, and INVALIDATED in the DB (cloud_init_callback_consumed_at
#     set to now()) the moment the first successful callback fires. After
#     that, the same token in the userdata file is dead bytes. An attacker
#     who compromises a VM later cannot replay the callback to mark
#     arbitrary other VMs as healthy.
#
# Using gateway_token for both purposes would mean: a compromised VM can
# call cloud-init-callback for ANY VM whose gateway_token it can guess
# (it can't easily, but the mathematical shape is wrong — long-lived
# credential used for a single transaction). Splitting them follows
# least-privilege.
for i in $(seq 1 30); do
  if curl -fsS http://localhost:18789/health >/dev/null 2>&1; then
    echo "[$(date -u +%FT%TZ)] gateway healthy"
    # Report back to webhook so the DB write completes
    curl -fsS -X POST "${process.env.NEXTAUTH_URL}/api/vm/cloud-init-callback" \\
      -H "Content-Type: application/json" \\
      -H "X-Cloud-Init-Callback-Token: ${params.callbackToken}" \\
      -d '{"userId":"${params.userId}","vmName":"${params.vmName}","agentbookAddress":"'$AGENTBOOK_ADDR'","status":"healthy"}'
    touch /tmp/.instaclaw-ready
    exit 0
  fi
  sleep 2
done

echo "[$(date -u +%FT%TZ)] gateway did not start within 60s"
touch /tmp/.instaclaw-failed
exit 1
`;
}
```

The above is illustrative. The real implementation will be ~900 lines after all the template construction is unrolled.

### 5.3.1 The cloud-init-callback endpoint — auth + invalidation

`POST /api/vm/cloud-init-callback` is the new endpoint cloud-init calls when the gateway is healthy. Auth is via the **one-time-use callback_token**, not the gateway token.

```typescript
// instaclaw/app/api/vm/cloud-init-callback/route.ts — NEW FILE
export async function POST(req: NextRequest) {
  const callbackToken = req.headers.get("X-Cloud-Init-Callback-Token");
  if (!callbackToken) return NextResponse.json({error: "missing token"}, {status: 401});

  const body = await req.json();
  const { userId, vmName, agentbookAddress, status } = body;

  const supabase = getSupabase();

  // Atomically claim the callback: row must have matching token AND not be consumed.
  // The UPDATE returns the row only if the WHERE conditions matched, giving us
  // atomic check-and-invalidate semantics at the database layer (no race
  // possible — postgres handles the locking).
  const { data: claimed, error: claimErr } = await supabase
    .from("instaclaw_vms")
    .update({
      cloud_init_callback_consumed_at: new Date().toISOString(),
      health_status: status === "healthy" ? "healthy" : "unhealthy",
      gateway_url: `http://${vmIp}:18789`,  // looked up from vmName
      agentbook_wallet_address: agentbookAddress,
      last_health_check: new Date().toISOString(),
    })
    .eq("assigned_to", userId)
    .eq("name", vmName)
    .eq("cloud_init_callback_token", callbackToken)
    .is("cloud_init_callback_consumed_at", null)  // ← refuses to claim twice
    .eq("status", "provisioning")  // ← refuses if VM was respawned in the interim
    .select("id")
    .single();

  if (claimErr || !claimed) {
    // Three possible reasons for no claim:
    //   1. Token doesn't match (wrong VM trying to callback)
    //   2. Token already consumed (replay attempt)
    //   3. VM is no longer in provisioning state (already respawned)
    // All return 401, no information leaked about which case.
    logger.warn("cloud-init-callback: claim failed", {
      route: "vm/cloud-init-callback",
      userId, vmName,
      reason: claimErr?.message ?? "no row claimed",
    });
    return NextResponse.json({error: "invalid token or already claimed"}, {status: 401});
  }

  logger.info("cloud-init-callback: VM marked healthy", {
    route: "vm/cloud-init-callback",
    userId, vmName, vmId: claimed.id, status,
  });

  return NextResponse.json({ok: true});
}
```

The atomic claim pattern is the heart of the security: the same `UPDATE ... WHERE token=X AND consumed_at IS NULL` query both verifies the token and invalidates it in a single round trip. Postgres's row-level locking ensures only one callback can succeed; a replay attempt (same token, second time) hits `consumed_at IS NOT NULL` and returns no row.

**Threat model verification:**

| Threat | Outcome |
|---|---|
| Attacker reads userdata from a compromised VM, replays the callback after `cloud-init-poll` has already consumed it | Token consumed → query returns no row → 401. Replay rejected. |
| Attacker tries the callback with a different VM's userId | `WHERE assigned_to = userId AND cloud_init_callback_token = X` won't match — different VMs have different tokens. 401. |
| Attacker tries the callback with a fabricated callback_token | Token isn't in the DB → no row → 401. |
| Attacker tries to mark an existing healthy VM as healthy again | VM's `status` is `"healthy"`, not `"provisioning"` → 401. |
| Attacker captures a callback in-flight (MITM on HTTPS — out of model, but) | TLS termination at Vercel; same threat as any plaintext-token-over-HTTPS endpoint. Standard mitigation. |
| Token leaks via cloud-init logs (`/var/log/cloud-init.log`) | Logs are root-readable on the VM. The VM's owner = the user. Token is single-use, already consumed. Useless. |
| Token leaks via `/var/lib/cloud/instances/<id>/user-data.txt` (Linode preserves userdata on disk) | Same — root-readable, single-use, already consumed. To prevent even this, cloud-init's final step truncates `/var/lib/cloud/instances/*/user-data.txt` (best-effort; not all paths writable). |

**One additional defensive layer:** the userdata script truncates its own copy of itself before exiting (`> /var/lib/cloud/instances/*/user-data.txt 2>/dev/null || true`), so the at-rest copy of the token is destroyed. cloud-init logs may still contain the token in fragments but are also truncated at script end (`: > /var/log/instaclaw-cloud-init.log`). The DB-side `cloud_init_callback_consumed_at IS NOT NULL` is the actual security boundary; on-disk truncation is hygiene.

### 5.4 The respawn path (replaces configure-retry)

If a VM fails cloud-init (sentinel not found within 30 min, or `/tmp/.instaclaw-failed` is present), the new lifecycle is:

```typescript
// instaclaw/app/api/cron/cloud-init-poll/route.ts (existing file, modified)

// For VMs that failed cloud-init:
//   1. Capture the cloud-init log (via SSH) for postmortem to instaclaw_cloud_init_outcomes
//   2. CHECK FLEET-WIDE CIRCUIT BREAKER (see below) — if tripped, halt + alert, do NOT respawn
//   3. Delete the Linode VM
//   4. Set status="failed", health_status="unhealthy" on the DB row
//   5. Enqueue respawn (call createUserVM with fresh state)
//   6. The user sees /deploying continue, extends ~60-120s
//   7. Per-user max 3 respawns; after that mark user as "stuck" + admin alert + dashboard message
```

The respawn path is structurally simpler than today's process-pending Pass 2 (one operation — destroy + recreate — instead of three). It also means the VM disk is always clean.

#### 5.4.1 Fleet-wide respawn circuit breaker

Per-user retry limits (max 3 respawns) catch the case where one user's params produce a bad userdata. **They do NOT catch the case where a bad template, a Linode region issue, or a snapshot bug breaks every new VM in the fleet.** Without a fleet-wide brake, a faulty change could create-and-destroy hundreds of VMs in an hour:

- Template bug shipped → first 5 VMs fail → each triggers respawn (5 more failed VMs) → those trigger respawns → exponential blow-up
- Linode region hiccup → every new VM times out at 30 min → respawn fires → those time out → more respawns → 100+ destroys/creates/hour
- Manifest typo → every cloud-init dies at the same line → fleet-wide death spiral

This is a true create-and-destroy loop, and Linode's API doesn't help us — we'd be cheerfully paying $0.04/hour × 100 short-lived VMs/hour and shifting the bill from $145/mo to $290/day before anyone noticed.

**The brake:**

```typescript
// instaclaw/lib/respawn-vm.ts — NEW FILE (see §7 file list)
export async function respawnVM(vmId: string, userId: string): Promise<RespawnResult> {
  const supabase = getSupabase();

  // ── Step 0: fleet-wide circuit breaker ──
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count: recentRespawns } = await supabase
    .from("instaclaw_cloud_init_outcomes")
    .select("id", { count: "exact", head: true })
    .eq("action", "respawn")
    .gte("created_at", oneHourAgo);

  const RESPAWN_RATE_LIMIT = parseInt(process.env.RESPAWN_RATE_LIMIT_HOUR ?? "10", 10);
  if ((recentRespawns ?? 0) >= RESPAWN_RATE_LIMIT) {
    // CIRCUIT BREAKER TRIPPED.
    //   - Do NOT respawn this VM
    //   - Mark user as "stuck" so they get a clear UI state
    //   - Alert admin with the full hour's outcomes for diagnosis
    //   - Once the admin clears the flag (manually set
    //     instaclaw_circuit_breakers.respawn_paused_until = NULL), respawns resume
    await sendAdminAlertEmail(
      "P0: Fleet-wide respawn circuit breaker TRIPPED",
      `${recentRespawns} respawns fired in the last hour (limit: ${RESPAWN_RATE_LIMIT}). ` +
        `New respawn for vm=${vmId} user=${userId} REFUSED until manual review. ` +
        `Likely causes: bad userdata template, Linode region issue, snapshot bug. ` +
        `Check: instaclaw_cloud_init_outcomes WHERE created_at > NOW() - INTERVAL '1 hour'`
    );
    await supabase.from("instaclaw_circuit_breakers").upsert({
      breaker_name: "respawn",
      tripped_at: new Date().toISOString(),
      tripped_count: recentRespawns,
      respawn_paused_until: null,  // null = paused indefinitely until admin resets
    }, { onConflict: "breaker_name" });
    return { ok: false, reason: "fleet_circuit_breaker_tripped" };
  }

  // ── Step 1+: proceed with respawn ──
  // ... (destroy old VM, createUserVM with fresh state, log outcome)
}
```

**The thresholds:**

| Knob | Default | Reasoning |
|---|---|---|
| `RESPAWN_RATE_LIMIT_HOUR` | 10 | Healthy steady-state respawn rate is near-zero. Even during a pathological Linode-API-blip with 100 signups/hour, individual respawns should be <5/hr. 10/hr is "definitely something is systemically wrong." |
| Per-user respawn cap | 3 | Mirrors today's `MAX_CONFIGURE_ATTEMPTS`. Same UX semantic. |
| Auto-reset | Never | Once tripped, an admin must manually `UPDATE instaclaw_circuit_breakers SET tripped_at = NULL WHERE breaker_name = 'respawn'`. Auto-reset risks the breaker flapping during the underlying outage. |
| Admin alert recipients | `coop@valtlabs.com` + paging on-call | P0 severity — paid customers are blocked. |

**What happens to users in flight while the breaker is tripped:**

- Their VM stays at `status="provisioning"`. The `/deploying` UI keeps polling.
- After ~5 minutes of no progress, the UI shows: "Your VM is taking longer than usual. We've notified the team. You'll get an email when it's ready."
- The admin's job is to diagnose root cause (template bug? Linode region? snapshot drift?), fix it, and reset the breaker. Once reset, the stuck users get their VMs in the next cron tick.
- No data is lost. No user gets a worse experience than today's "stuck onboarding" — actually better, because the UI explicitly communicates the delay rather than silently looping.

**Schema for the breaker:**

```sql
-- migration: add circuit breaker table
CREATE TABLE instaclaw_circuit_breakers (
  breaker_name TEXT PRIMARY KEY,
  tripped_at TIMESTAMPTZ,
  tripped_count INT,
  respawn_paused_until TIMESTAMPTZ,
  notes TEXT
);

-- migration: add cloud-init outcomes table for breaker observability + postmortems
CREATE TABLE instaclaw_cloud_init_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vm_id UUID REFERENCES instaclaw_vms(id) ON DELETE CASCADE,
  user_id UUID REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('initial_provision','respawn','admin_force')),
  status TEXT NOT NULL CHECK (status IN ('healthy','failed','timeout')),
  cloud_init_log_excerpt TEXT,
  failure_reason TEXT,
  duration_seconds INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cloud_init_outcomes_created ON instaclaw_cloud_init_outcomes(created_at DESC);
CREATE INDEX idx_cloud_init_outcomes_action_created ON instaclaw_cloud_init_outcomes(action, created_at DESC);
```

**This is its own observability surface.** The cloud-init-outcomes table powers a simple admin view (`/hq/cloud-init-outcomes`) that shows: total outcomes this hour, success rate, top failure reasons, time-to-healthy distribution. During canary cohorts (§13 Phase 1B-D) Cooper watches this table directly. Cheaper than wiring full Datadog/Sentry visibility for a 6-week migration window.

### 5.5 The frozen / thaw path (unchanged)

`thawVM` in `lib/vm-freeze-thaw.ts` provisions a new instance from the user's personal snapshot. This path is orthogonal to the on-demand provisioning change — it already does its own provisioning loop. Cooper has wanted it consolidated with the regular provisioning path; that's a separate PRD. For now, frozen users continue to use `thawVM` and that code stays.

---

## 6. What gets deleted (line counts)

| File | Lines | Rationale |
|---|---|---|
| `instaclaw/lib/replenish-pool-logic.ts` | 125 | No pool. Decision logic disappears. |
| `instaclaw/app/api/cron/replenish-pool/route.ts` | 422 | Cron is removed entirely. |
| `instaclaw/lib/providers/hetzner.ts` (`getNextVmNumber`, `formatVmName`) | ~30 | Name generator replaced by deterministic naming. |
| `instaclaw/app/api/cron/process-pending/route.ts` | 809 | All 7 passes deleted. The single "stuck user" backstop in Pass 0 moves to the cloud-init-callback failure handler (much narrower scope). |
| `instaclaw/lib/ssh.ts` (`configureOpenClaw` body) | ~2,817 | The SSH-based 8-phase pipeline moves into `buildCloudInitUserdata`. The wrapper function stays (for admin emergency reconfigure) but shrinks to ~80 lines. |
| `instaclaw/lib/ssh.ts` (`assignVMWithSSHCheck`) | ~150 | No pool to assign from. |
| `instaclaw/app/api/vm/configure/route.ts` | ~700 of 905 | Collapses to ~200 lines: admin-only emergency reconfigure that calls `auditVMConfig`. No critical-failure gate (no critical failures because no SSH configure). No supplemental writes (cloud-init does them). No rate limiting (no spam vector — admin-only). |
| `instaclaw/app/api/billing/webhook/route.ts` (the inline assign + configure retry loop, lines 462-570) | ~110 | Replaced by `createUserVM(userId, params)` call. |
| Various process-pending cron-related logic in health-check, wake-paid-hibernating | ~200 | Folds into smaller, narrower behaviors. |

**Estimated total deleted:** ~5,363 lines. This is a substantial reduction in surface area.

---

## 7. What gets created (new files, estimated line counts)

| File | Lines | Purpose |
|---|---|---|
| `instaclaw/lib/cloud-init-userdata.ts` | ~900 | `buildCloudInitUserdata(params)` + sub-builders (`buildOpenClawConfig`, `buildAuthProfiles`, `buildWorkspaceFiles`, `buildCronInstalls`, `buildEdgeCitySkillInstall`, etc.). Pure functions, no SSH, no DB. Asserts userdata size < 40KB pre-base64 (Rule 31). |
| `instaclaw/lib/create-user-vm.ts` | ~250 | `createUserVM(userId, params)` — the new one-and-only provisioning entry. Generates gateway_token + callback_token, wraps `provisionBankrWallet`, `buildCloudInitUserdata`, `linodeProvider.createServer`, the atomic DB row insert (including `cloud_init_callback_token`). |
| `instaclaw/app/api/vm/cloud-init-callback/route.ts` | ~200 | Webhook endpoint cloud-init calls when the gateway is healthy. Authenticates via the ONE-TIME-USE `callback_token` (distinct from `gateway_token`). Atomic claim-and-invalidate UPDATE (see §5.3.1). Writes `health_status="healthy"`, `gateway_url`, `agentbook_wallet_address`. Idempotent (replays rejected by `cloud_init_callback_consumed_at IS NULL` clause). |
| `instaclaw/app/api/cron/cloud-init-poll/route.ts` | +80 lines (modified) | Add failure-handler: VMs at `provisioning` for >30 min get destroyed + respawned via `respawnVM(vmId, userId)`. Capture cloud-init log via SSH to `instaclaw_cloud_init_outcomes` table for postmortem. Gates on `vm.created_via = "on_demand"` column so old-path VMs are unaffected. |
| `instaclaw/lib/respawn-vm.ts` | ~200 | `respawnVM(vmId, userId)` — destroy old + create new. **Includes the fleet-wide respawn circuit breaker (§5.4.1).** Checks `instaclaw_cloud_init_outcomes` for >10 respawns/hour, refuses if tripped, alerts admin. Per-user max 3 respawns. |
| `instaclaw/scripts/_test-cloud-init-userdata.ts` | ~300 | Failure-mode tests per Rule 31. Synthetic params + Linode-API stub. Verifies the generated bash script lints (`bash -n`), has all sentinels per Rule 23, has all required env vars, fits within 40 KB pre-base64 limit. Largest realistic param combination (`partner=edge_city`, P95 gmail summary, all channels, all partner blocks) MUST stay <40 KB. |
| `instaclaw/scripts/_test-webhook-branching.ts` | ~400 | Failure-mode tests for the 7-branch webhook conditional chain (§10.3.3). One test per branch. Mandatory before Phase 1B canary. |
| `instaclaw/scripts/_migrate-test-vm-to-on-demand.ts` | ~150 | One-off — creates a Cooper-test canary, walks the new path end-to-end, verifies all DB writes land, callback_token consumed exactly once, replay rejected, all sentinels fire. |
| `instaclaw/scripts/_provision-event-buffer.ts` | ~100 | One-off admin script (Q5/Q6 emergency buffer). Provisions N VMs with `event_buffer_tag = "<event_name>"`, `assigned_to = NULL`, `status = "healthy"` (after cloud-init lands), to be claimed by `billing/webhook` Branch A on first signups during an event. No replenish; manually run, manually torn down. |
| `instaclaw/scripts/_terminate-event-buffer.ts` | ~80 | Companion to `_provision-event-buffer.ts`. Tears down unclaimed `event_buffer_tag` VMs after the event ends. |
| Supabase migration | ~50 | `ALTER TABLE instaclaw_vms ADD COLUMN cloud_init_callback_token TEXT, ADD COLUMN cloud_init_callback_consumed_at TIMESTAMPTZ, ADD COLUMN created_via TEXT, ADD COLUMN event_buffer_tag TEXT;` + `CREATE TABLE instaclaw_cloud_init_outcomes` + `CREATE TABLE instaclaw_circuit_breakers` (schemas in §5.4.1). |

**Estimated total created:** ~2,710 lines (up from prior ~1,960 — additional surface from the callback_token security work, the webhook-branching tests, the event-buffer scripts, and the circuit breaker).

**Net change still solidly negative:** ~5,363 deleted − ~2,710 created = ~2,650 net lines deleted, with vastly cleaner failure semantics.

**Net change:** ~5,363 deleted, ~1,960 created = ~3,400 net lines deleted. Plus the operational savings (one path to test, debug, monitor).

---

## 8. What stays unchanged

- `instaclaw/lib/vm-manifest.ts` — source of truth for both cloud-init and reconciler.
- `instaclaw/lib/vm-reconcile.ts` — the 43-step drift-repair engine. Runs less often per VM (because cloud-init lands correctly the first time), but its actual logic is unchanged.
- `instaclaw/app/api/cron/reconcile-fleet/route.ts` — drift-repair scheduler. Unchanged.
- `instaclaw/app/api/cron/health-check/route.ts` — VM health probe, billing-cache, watchdog v1. Mostly unchanged; the bits that interlocked with process-pending's `configure_failed` state simplify (no `configure_failed` state to defend against).
- `instaclaw/app/api/cron/suspend-check/route.ts` — past_due hibernation. Unchanged.
- `instaclaw/app/api/cron/wake-paid-hibernating/route.ts` — wake-on-billing-recovery. May fold into health-check, but the logic stays.
- `instaclaw/lib/vm-freeze-thaw.ts` (`thawVM`) — frozen → respawn-from-snapshot. Unchanged path. (Could be consolidated with `createUserVM` in a future PRD; out of scope here.)
- `instaclaw/lib/bankr-provision.ts` (`provisionBankrWallet`) — wallet provisioning. Idempotent by user_id; called from `createUserVM` exactly like today's webhook calls it.
- `instaclaw/lib/wake-vm.ts` (`wakeIfHibernating`) — wake hibernating VM. Unchanged.
- `instaclaw/lib/auth-cache.ts` (`clearStaleAuthCacheForUser`) — billing-recovery cache clear. Unchanged.
- `instaclaw/lib/billing-status.ts` — billing classification (Rule 14 SoT). Unchanged.
- All VM-side scripts (strip-thinking.py, vm-watchdog.py, silence-watchdog.py, push-heartbeat.sh, auto-approve-pairing.py). They're baked into the snapshot and installed via cron. Unchanged.
- All skills (`instaclaw/skills/*`). Deployed via cloud-init now instead of SSH, but the skill content is unchanged.
- The dashboard, `/connect`, `/plan`, `/deploying`, `/dashboard` pages. UI unchanged.
- The reconciler's strict mode (`STRICT_RECONCILE_VM_IDS` env). Unchanged.
- The Linode account / API token / firewall / SSH key. Unchanged.
- The snapshot baking process (CLAUDE.md "Snapshot Creation Process"). Unchanged.

---

## 9. The provisioning flow — step-by-step with timestamps

This is the new happy path. Compare against §2.1 today's flow.

```
T+0.000s    User clicks "Subscribe" on /plan
T+0.500s    Stripe checkout session created, user redirected to Stripe
T+30.000s   User completes Stripe payment
T+30.500s   Stripe sends checkout.session.completed webhook to /api/billing/webhook
T+30.600s   Webhook handler verifies signature
T+30.700s   Webhook handler calls processEvent() via `after()` (existing pattern)
            → Response 200 to Stripe (within Stripe's 20s window)
T+30.800s   processEvent() reads session metadata → userId, tier, apiMode
T+30.900s   Subscription row upserted (existing logic)
T+31.000s   createUserVM(userId, params) called:
              ↓
T+31.100s   Fetch user profile from DB (partner, gmail summary, world_id, timezone)
T+31.200s   Fetch pending_users row (telegram_bot_token, telegram_bot_username, etc.)
T+31.300s   provisionBankrWallet({ userId, ... }) — returns wallet address (existing logic, idempotent)
T+32.500s   Generate gateway token (randomBytes(32) → hex)
T+32.600s   Build userdata string via buildCloudInitUserdata(...)
            (synchronous, pure function, ~5ms)
T+32.700s   Call linodeProvider.createServer({ name, userData })
              → Linode API receives POST /linode/instances
              → Linode allocates VM, returns 200 with instance ID + IP
T+34.000s   linodeProvider.createServer returns
T+34.100s   INSERT instaclaw_vms with status="provisioning", assigned_to=userId, all per-user fields
T+34.200s   UPDATE instaclaw_pending_users SET consumed_at = now()
T+34.300s   UPDATE instaclaw_users SET onboarding_complete = true
T+34.400s   createUserVM returns
T+34.500s   billing/webhook processEvent() returns (response already sent at T+30.700)

[Meanwhile, on the VM]
T+34.000s   Linode begins booting the new VM from snapshot
T+45.000s   VM is "running" per Linode API (snapshot boot is ~10-15s)
T+45.500s   cloud-init begins executing user_data
T+48.000s   SSH personalization phase complete (SSH host keys regenerated)
T+50.000s   ~/.openclaw/openclaw.json written with per-user values
T+52.000s   ~/.openclaw/agents/main/agent/auth-profiles.json written
T+54.000s   .env written (GATEWAY_TOKEN, BANKR_WALLET_ADDRESS, partner tokens)
T+58.000s   Workspace files written (SOUL.md, CAPABILITIES.md, MEMORY.md, etc.)
T+60.000s   AgentBook wallet generated, address computed
T+62.000s   Partner-gated skill installed (Edge City skill clone if partner=edge_city)
T+64.000s   Cron jobs installed (idempotent, marker-based)
T+65.000s   systemctl --user start openclaw-gateway
T+72.000s   Gateway emits [gateway] ready
T+72.500s   curl localhost:18789/health returns 200
T+72.600s   cloud-init POSTs /api/vm/cloud-init-callback with userId, agentbookAddr, status="healthy"
T+72.700s   /api/vm/cloud-init-callback authenticates via gateway token, writes:
              health_status="healthy", gateway_url, agentbook_wallet_address
T+72.800s   cloud-init touches /tmp/.instaclaw-ready and exits 0

[Meanwhile, the user is on /deploying]
T+35.000s   User redirected to /deploying after Stripe success
T+36.000s   /deploying polls /api/vm/status → status="provisioning"
T+41.000s   /deploying polls /api/vm/status → status="provisioning"
T+46.000s   /deploying polls /api/vm/status → status="provisioning"
... (polling every 5s)
T+73.000s   /deploying polls /api/vm/status → status="healthy", gateway_url set
T+74.500s   /deploying redirects user to /dashboard

[Belt-and-suspenders: cloud-init-poll cron]
T+90.000s   cloud-init-poll cron tick (running independently every 2 min)
              → reads VMs WHERE status="provisioning"
              → in this case, the VM is already "healthy" from cloud-init-callback
              → no-op (idempotent)

[If cloud-init-callback failed for any reason]
T+90.000s   cloud-init-poll cron SSHes into the VM
              → tests for /tmp/.instaclaw-ready
              → if present: probes localhost:18789/health
              → if 200: writes health_status="healthy" (recovery path)
              → if /tmp/.instaclaw-failed present: marks failed, schedules respawn

[Total user-perceived latency]
Stripe payment → working Telegram bot in /dashboard: T+30.000 → T+74.500 = ~44.5 seconds.

Today's equivalent (pool-assign + SSH configure): ~75-120 seconds.

User experience is FASTER, not slower, because we don't wait for the SSH round-trip dance.
```

The two callbacks (cloud-init-callback and cloud-init-poll) provide defense-in-depth. The webhook is the fast path (~73s end-to-end); the cron is the recovery path if the webhook didn't reach us (e.g., the VM was behind NAT, the firewall blocked the outbound POST, our server was briefly down). Idempotent on both sides.

---

## 10. Migration plan for existing 200+ users

**The principle: don't migrate.** The persistent dedicated VM is the product. Migrating existing VMs to a new provisioning path destroys the user's accumulated state, which is exactly what the brand promises NOT to happen.

### 10.0 Both paths run live throughout Phase 1 — do NOT regress the old path

Throughout Phase 1A–1E, **process-pending continues to run on its full 5-min cadence with all 7 passes intact**. Specifically:

- The **khomenko89 fix** (commit `a527f867`, 2026-05-12) — Pass 0's pre-fetch of `assignedUserIds`, `.not("user_id","in",...)` filter, `ORDER BY instaclaw_users(partner) DESC NULLS LAST`, `count:"exact"` queue-depth observability, dynamic batch sizing — **stays untouched** through the entire rollout. Cooper's "two paths are live during rollout, don't accidentally regress the old path" is a hard constraint.
- The **Rule 33 critical-failure gate** in `vm/configure/route.ts:408-525` stays untouched. Old-path signups still hit this gate.
- The **Rule 34 telegram-token reconciler** (`stepTelegramTokenVerify` in `vm-reconcile.ts`) stays untouched. Runs on every VM regardless of provisioning path.
- The **release-and-clear-tokens path** in process-pending Pass 2c stays untouched (this session's per-user state clears on release).
- The **replenish-pool cron** stays running with current settings (POOL_FLOOR=10, POOL_TARGET=15) until Phase 1E. Don't drop the pool prematurely.
- The **`reconcile-fleet` cron** stays running on its current cadence (every 3 min, batch=3). The new VMs from on-demand provisioning land at `config_version = VM_MANIFEST.version` and the candidate query (`config_version < VM_MANIFEST.version`) skips them — no extra reconciler load.

**Why this matters:** if we touch the old path during the build-out, the canary cohort (Phase 1B-D) compares apples to bruised apples. We need to know that the new path's metrics are because of the new path, not because we accidentally regressed the old. Cooper has flagged this as the most common class of bug during dual-path migrations.

**Concrete enforcement:**

- Phase 1A code changes are NET-ADD only. No edits to `process-pending/route.ts`, `replenish-pool/route.ts`, `cloud-init-poll/route.ts` (except the new failure-handler logic that ONLY activates for VMs created via the new path — gated on `vm.created_via = "on_demand"` column).
- All process-pending pass behavior is identical for `vm.created_via IS NULL` (old-path) and `vm.created_via = "on_demand"` (new-path) VMs unless an explicit branch is documented in this PRD.
- The CI test suite includes a "regression assertion" run against the old-path flow: synthesize a Stripe webhook, walk the existing path, verify a working bot lands in <120s. This test must pass on every PR during Phase 1.

**Migration of process-pending semantics into the new world (deferred to Phase 2):**

- Pass 0 (orphan recovery) → Phase 2 reviews whether any orphan class still exists with on-demand. The on-demand path's "createUserVM is the only writer" property eliminates the bulk of orphans, but edge cases (Stripe webhook delivered, our DB write fails, retry happens with a stale state) may still need a Pass-0-style backstop. Decision deferred.
- Pass 1 (pending_users no-VM) → eliminated by on-demand (no separate "pending row exists but no VM" state; createUserVM atomically writes both).
- Pass 2 / 2b (configure retry) → eliminated by on-demand (no separate configure step to retry; respawn handles total-failure cases).
- Pass 2c (release exhausted) → replaced by respawn in §5.4.
- Pass 3 / 3b (auto-config orphans / catch-all) → eliminated.
- Pass 4 (stale pending cleanup) → folds into createUserVM's atomic consume.
- Pass 5 (purge consumed) → kept as a 24h cleanup cron, independent of provisioning path.

Phase 2 (next PRD) is when process-pending shrinks. Phase 1 is when both paths run side-by-side.

### 10.1 The migration that does NOT happen

- We do NOT re-provision existing VMs through `createUserVM`. They were provisioned via the old path; they continue to live their lives. Each is a unique snowflake with months of MEMORY.md, sessions, installed packages, browser sessions. Touching them via "reprovision through the new path" would wipe all of that.
- We do NOT delete the old code paths until ALL of the 200+ existing VMs have either (a) churned naturally (canceled subscription, fully terminated, reclaimed) or (b) been migrated voluntarily by the user (via a dashboard "fresh start" button, separate feature).
- We do NOT change the reconciler's behavior toward existing VMs. They continue to receive manifest drift updates as today.

### 10.2 What does happen

1. **Phase 1A — implementation behind a flag (2 weeks):** Build `buildCloudInitUserdata`, `createUserVM`, `cloud-init-callback`, `respawnVM`, the updated `cloud-init-poll`. Ship behind `USE_ON_DEMAND_PROVISIONING=false` (default off). The new path is dormant; nothing changes for users.

2. **Phase 1B — canary on Cooper's test account (2-3 days):** Set `USE_ON_DEMAND_PROVISIONING=true` for `userId IN (cooper_test_user_id)`. Cooper creates a new test signup, walks the entire flow, verifies the VM ends up correctly configured. Compare end-state to a parallel old-path test signup. Verify Telegram works, Bankr wallet works, AgentBook wallet works, partner skill (if applicable) works, MEMORY.md is initialized correctly, all 7 mandatory crons are installed, gateway health is green.

3. **Phase 1C — partner canary (Edge City, 1 week):** `USE_ON_DEMAND_PROVISIONING=true` for `partner = "edge_city"` signups. Edge City has the highest-stakes signups (event-specific, time-sensitive) so we get fast feedback. Monitor: provisioning success rate, time-to-healthy, cloud-init log errors, reconciler queue depth (should stay near zero for new VMs).

4. **Phase 1D — full new-signup cohort (1 week):** `USE_ON_DEMAND_PROVISIONING=true` for all new signups. Old VMs continue on the old path (the reconciler picks them up for drift but they don't go through `createUserVM`). Pool is allowed to drain naturally (no replenishment) over the next 24-48h.

5. **Phase 1E — pool retirement (1 week):** Replenish-pool cron disabled (DELETE from `vercel.json` cron schedule). Remaining ready VMs (~15) sit unused; they're terminated manually or via a one-off script after observation. Total Linode savings: ~$435/mo.

6. **Phase 2 — code deletion (next PRD, after 30 days of green metrics):** Delete the dead code per §6 once we're confident the new path handles every case the old path handled. The dead code stays in place for 30 days post-cutover for fast rollback.

### 10.3 Webhook branching — the full conditional chain

`billing/webhook` `checkout.session.completed` is the entry point. There are SEVEN distinct user-state scenarios. Most webhook bugs in InstaClaw's history (vm-773 wipe, dual-account partner drift, Doug Rathell wake, Carter onboarding loop) have lived inside this chain. Getting it right is non-negotiable.

**Decision tree (executed in order; the FIRST matching branch wins):**

```
checkout.session.completed
  ↓
Look up userId, tier, apiMode from session.metadata
  ↓
SELECT * FROM instaclaw_vms WHERE assigned_to = userId LIMIT 1
  ↓
Branch on (existingVm + its state):
```

| Branch | Detection query | Reactivation path | Notes |
|---|---|---|---|
| **A. No existing VM — true new user** | `existingVm IS NULL` AND no row with `last_assigned_to = userId` | Call `createUserVM(userId, params)` (new path, gated on `USE_ON_DEMAND_PROVISIONING`). Old path fallback: `assignVMWithSSHCheck` + retry-loop `/api/vm/configure`. | The 95% case today. The 100% case for net-new-user signups via /signup or /edge-city. |
| **B. Existing VM, status='healthy', health_status='healthy'** | `existingVm.status='healthy' AND health_status IN ('healthy','unknown')` | No-op. Log "VM already assigned, skipping webhook assignment" (existing line `billing/webhook/route.ts:453`). | Stripe webhook retries can land here harmlessly. |
| **C. Existing VM, health_status='suspended' (gateway stopped)** | `health_status='suspended'` | `auditVMConfig(vm, {strict:false})` → `restartGateway(vm)` if audit didn't already restart. Set `health_status='unknown'`, clear `suspended_at`, bump `config_version` if audit clean. **DO NOT call `configureOpenClaw`** — that triggers the privacy-guard wipe path (vm-773 incident). | Existing path in `billing/webhook/route.ts:351-451`. Unchanged by this PRD. |
| **D. Existing VM, health_status='hibernating' (suspend-check past_due)** | `health_status='hibernating'` | `wakeIfHibernating(supabase, userId, "billing/webhook:checkout.session.completed")` + `clearStaleAuthCacheForUser(supabase, userId, ...)`. | Same shape as suspended; just a different naming convention from a different cron (Rule 15). The two states are operationally identical. |
| **E. Existing VM, status='frozen' (Linode deleted, snapshot only)** | `existingVm.status='frozen' AND frozen_image_id IS NOT NULL` | `thawVM(supabase, userId, false, runId)`. Re-provisions a fresh Linode VM from the user's personal snapshot. | Existing path in `billing/webhook/route.ts:674-727`. Unchanged by this PRD. |
| **F. Existing VM, status='terminated/failed/destroyed' (reclaimed)** | `existingVm.status IN ('terminated','failed','destroyed')` | **Old path**: `assignVMWithSSHCheck` allocates a fresh VM from the pool, the existing terminated row is left as historical record. **New path**: `createUserVM(userId, params)`. The terminated row stays as audit trail; a new row is INSERT'd. | This is the case for users whose VM was reclaimed (after 90 days of canceled sub + no resub, per vm-lifecycle cron). The user is essentially a returning-but-fresh signup. Memory portability (edgeclaw §4.17) would restore their MEMORY.md if implemented; without it, they start fresh. |
| **G. last_assigned_to match but NO current VM (data migration path)** | `existingVm IS NULL` AND `SELECT id FROM instaclaw_vms WHERE last_assigned_to = userId LIMIT 1` returns a row | **Old path**: webhook continues to Branch A's `assignVMWithSSHCheck` (allocates fresh VM); `configureOpenClaw` runs `migrateUserData` from the `last_assigned_to` source to the new VM. **New path**: `createUserVM(userId, params)` first, then the reconciler's first cycle picks up the `last_assigned_to` reference and triggers `migrateUserData` (new step needed in the reconciler — see §10.3.1 below). | The "I had a VM, I cancelled, my VM got reclaimed but the row survived with `last_assigned_to=userId`, now I'm resubscribing" case. Today's `vm/configure/route.ts:585-619` runs migration synchronously inside the configure endpoint. We need to move that into a reconciler step (or a separate background job) because cloud-init doesn't have access to the old VM's filesystem. |

#### 10.3.1 New reconciler step: `stepMigrateFromLastVm` (proposed)

Branch G needs a new reconciler step because:
- Today, `vm/configure` (the endpoint) calls `migrateUserData(previousVm, vm)` AFTER `configureOpenClaw` finishes. The endpoint has direct SSH access to both VMs.
- Tomorrow, cloud-init runs on the new VM by itself — it doesn't know about the old VM, and we don't want to expose old-VM credentials in userdata.

The migration moves to the reconciler:

```typescript
// in vm-reconcile.ts (new step, slotted after stepBootstrapState)
async function stepMigrateFromLastVm(vm: VMRow, ctx: ReconcileContext): Promise<StepResult> {
  // Look up source VM via last_assigned_to.
  const sourceVm = await getSupabase()
    .from("instaclaw_vms")
    .select("*")
    .eq("last_assigned_to", vm.assigned_to)
    .neq("id", vm.id)
    .limit(1)
    .single();

  if (!sourceVm.data) return { alreadyCorrect: true, label: "migrate_from_last_vm: no source" };

  // Existing migrateUserData() function handles the SSH copy.
  // Runs once per VM at most — sets last_assigned_to=NULL on source after success.
  try {
    await migrateUserData(sourceVm.data, vm);
    await getSupabase().from("instaclaw_vms").update({ last_assigned_to: null }).eq("id", sourceVm.data.id);
    return { fixed: true, label: "migrate_from_last_vm: copied user data" };
  } catch (err) {
    return { errors: [...], label: "migrate_from_last_vm: failed" };
  }
}
```

This step is idempotent: on success it clears `last_assigned_to` on the source so the next reconciler cycle no-ops.

#### 10.3.2 Branch-execution diagram

```
checkout.session.completed
  │
  ├─ branch A (no VM, no last_assigned_to)
  │   └─ createUserVM(userId, params)  [new path]
  │   OR assignVMWithSSHCheck(userId)  [old path, feature-flagged]
  │
  ├─ branch B (existing healthy)
  │   └─ no-op
  │
  ├─ branch C (suspended)
  │   └─ auditVMConfig + restartGateway
  │
  ├─ branch D (hibernating)
  │   └─ wakeIfHibernating + clearStaleAuthCacheForUser
  │
  ├─ branch E (frozen)
  │   └─ thawVM
  │
  ├─ branch F (terminated/failed/destroyed)
  │   └─ createUserVM(userId, params)  [new path]
  │   OR assignVMWithSSHCheck(userId)  [old path]
  │   (terminated row remains as audit trail)
  │
  └─ branch G (no VM, but last_assigned_to row exists)
      └─ createUserVM(userId, params)  [new path]
         + reconciler's stepMigrateFromLastVm fires on first cycle
      OR assignVMWithSSHCheck + configureOpenClaw which calls migrateUserData  [old path]
```

#### 10.3.3 Failure-mode tests for the chain (Rule 31)

`scripts/_test-webhook-branching.ts` must include one test per branch:

1. **A — net-new signup:** synthesize `checkout.session.completed`, verify Branch A is taken, VM provisioned, telegram bot working, MEMORY.md initialized, user redirected to dashboard.
2. **B — webhook replay:** call `checkout.session.completed` twice with same userId, verify the second call is no-op (no second VM created).
3. **C — suspended reactivation:** seed VM in `health_status='suspended'`, fire webhook, verify gateway restarted, no privacy wipe.
4. **D — hibernating reactivation:** seed VM in `health_status='hibernating'`, fire webhook, verify wake fires, auth cache cleared.
5. **E — frozen thaw:** seed VM in `status='frozen'` with `frozen_image_id`, fire webhook, verify `thawVM` triggered, new Linode provisioned from snapshot.
6. **F — terminated reclaim:** seed VM in `status='terminated'` with `last_assigned_to=userId`, fire webhook, verify fresh VM is created, terminated row preserved.
7. **G — last_assigned_to migration:** seed source VM in `status='ready', last_assigned_to=userId` with some workspace files, no current VM. Fire webhook, verify Branch A creates a fresh VM, reconciler's first cycle copies workspace files via `stepMigrateFromLastVm`.

These tests are mandatory before Phase 1B canary fires.

#### 10.3.4 Forced reconfigure (admin emergency reset)

Today, `vm/configure?force=true` is the admin's emergency button to wipe-and-rebuild a misbehaving VM. After this PRD, the equivalent action is `respawnVM(vmId)` — destroy the Linode VM, create a fresh one with `createUserVM`. Per-user data is gone (which is the whole point of a forced reset — same as today's `force=true` behavior, which calls `configureOpenClaw` with the privacy-guard wipe enabled). The respawn-circuit-breaker (§5.4.1) protects against admin-tooling mistakes (e.g., a script that loops over every VM calling respawn).

#### 10.3.5 Tier change (upgrade/downgrade)

Today, the webhook updates `instaclaw_subscriptions.tier` and `instaclaw_vms.tier`. The on-disk `openclaw.json` may have a tier-dependent setting (e.g., `agents.defaults.tier`) — the reconciler heals it on the next cycle. Unchanged by this PRD. The new provisioning path doesn't see tier changes; they're handled by the existing `customer.subscription.updated` webhook event handler.

### 10.4 User-facing communication

None required. The change is invisible to users. Time-to-first-message gets *slightly faster* on average. The product they're paying for (persistent dedicated VM with accumulated memory) is unchanged.

---

## 11. Risk analysis

### 11.1 Risk: cloud-init userdata exceeds Linode's 65 KB limit

- **Likelihood:** Medium. Current estimate is ~40-55 KB, which is comfortable but not generous.
- **Impact:** High. If userdata is too large, the Linode API rejects the create-server call, and we can't provision the VM.
- **Mitigation:** (a) Strict size budget in `buildCloudInitUserdata` — assert `userdata.length < 60_000` before passing to Linode; emit a build-time error if any individual template grows past its budget. (b) For very large blobs (e.g., SOUL.md if it ever exceeds ~10 KB), the userdata fetches them from a server-controlled URL at first boot rather than embedding inline. We already do this for skill repos via `git clone`; the same pattern extends to workspace templates. (c) Failure-mode test per Rule 31: synthesize the largest possible params (all partner flags on, longest gmail summary, etc.) and verify the userdata stays under budget.

### 11.2 Risk: cloud-init failure leaves the VM in an indeterminate state

- **Likelihood:** Medium. Cloud-init can fail for reasons we don't fully control (npm install network blip, apt-get hang, etc.).
- **Impact:** Medium. The VM exists on Linode (charging us $29/mo) but isn't usable.
- **Mitigation:** (a) `cloud-init-poll` has a 30-min timeout; VMs past that are auto-destroyed (saves the $29/mo and clears the failed slot for respawn). (b) `respawnVM(vmId)` rebuilds from a fresh Linode VM — clean slate, no carry-over from the failed attempt. (c) Capture the cloud-init log via SSH before destruction for postmortem (we keep the log for 30 days in our admin observability table).

### 11.3 Risk: respawn races with a user who eventually unblocked the original VM

- **Likelihood:** Low. The 30-min timeout is long enough that genuine boot delays resolve themselves first.
- **Impact:** Medium. A user could see "your VM is provisioning" for 30 min, the system gives up and respawns, but by then the original VM finally came healthy. Now we have two VMs charging us.
- **Mitigation:** `respawnVM` first checks if the VM has reached `status="healthy"` in the last 60 seconds. If yes, no-op. Belt-and-suspenders: the new VM goes into the row and the OLD VM's Linode instance is force-deleted before the new one is created (one VM per user, always).

### 11.4 Risk: cloud-init-callback fails because of network / firewall / our server briefly down

- **Likelihood:** Medium. Long-tail network issues happen.
- **Impact:** Low. The cron-based recovery path (`cloud-init-poll` SSHing in to detect the sentinel) catches this within 2 minutes.
- **Mitigation:** Same as today's `cloud-init-poll`. Defense-in-depth is built in.

### 11.5 Risk: per-user secrets leak into cloud-init userdata logs

- **Likelihood:** Medium. cloud-init logs to `/var/log/cloud-init.log` and `/var/log/instaclaw-cloud-init.log`. Both are root-readable on the VM.
- **Impact:** Medium. Gateway token + telegram bot token are sensitive. If a VM gets passed to a different user (which we explicitly DON'T do in the new architecture — see §11.3), they could see the previous user's tokens.
- **Mitigation:** (a) In the new architecture, VMs are 1:1 with users for life (or until destroyed entirely). No pool, no re-assignment. So the only person who can read these logs is the user themselves, and they're free to inspect their own tokens. (b) The cloud-init script truncates `/var/log/instaclaw-cloud-init.log` at the end of execution (`> /var/log/instaclaw-cloud-init.log` to nullify content while preserving the file). (c) Auditable: a security review can confirm no other paths write secrets to logs.

### 11.6 Risk: the new path has a hidden race with the reconciler

- **Likelihood:** Low. Cloud-init writes `config_version = VM_MANIFEST.version` directly, so new VMs aren't in the reconciler's candidate query (`config_version < VM_MANIFEST.version` is false).
- **Impact:** Low. Even if a race occurred, the reconciler's writes are idempotent + drift-repair-only; worst case is some duplicate work.
- **Mitigation:** Verify via integration test that a brand-new cloud-init-provisioned VM is NOT selected by `reconcile-fleet` for at least 24 hours after creation (i.e., until a future manifest bump rolls it in).

### 11.7 Risk: existing 200+ VMs become orphaned by the new code

- **Likelihood:** None. We don't migrate existing VMs; the old code stays in place for them.
- **Impact:** Hypothetical.
- **Mitigation:** Feature flag `USE_ON_DEMAND_PROVISIONING` only affects NEW signups. Existing VMs are routed via the old `assignVMWithSSHCheck` path until they're voluntarily reprovisioned by the user or churn out.

### 11.8 Risk: cloud-init introduces a new failure surface (userdata bug = fleet bug)

- **Likelihood:** Medium. A buggy userdata template would affect every new VM provisioned thereafter.
- **Impact:** High. Bad userdata could brick every new signup.
- **Mitigation:** (a) Canary cohort gating (§10.2) — start with one test VM, then partner-only, then full new-signup. (b) Failure-mode tests per Rule 31: a `scripts/_test-cloud-init-userdata.ts` that runs every possible combination of params through `buildCloudInitUserdata` and validates the output (lints with `bash -n`, has all expected sentinels, fits in 65 KB, no syntax errors). (c) Sentinels per Rule 23: `requiredSentinels = ["systemctl --user start openclaw-gateway", "/tmp/.instaclaw-ready"]` enforced as a build-time assertion on the template.

### 11.9 Risk: edgeclaw partner gating breaks under the new path

- **Likelihood:** Low. The gate is `params.partner === "edge_city"` (a string equality check), passed through the same function call shape. Edge City skill install becomes a conditional bash block in userdata instead of a conditional SSH call. End state identical.
- **Impact:** High if it breaks (partner users land without the skill installed).
- **Mitigation:** (a) Phase 1C canary specifically uses Edge City signups. (b) Verify post-cloud-init that `~/.openclaw/skills/edge-esmeralda/` exists with a `SKILL.md` for every edge_city VM. (c) Automated assertion in the cloud-init-poll cron: for partner=edge_city VMs, require the skill dir to exist before flipping to `healthy`. (d) Cross-reference with edgeclaw-partner-integration.md §4.4: the install pattern (clone repo to `~/.openclaw/skills/edge-esmeralda/`) is identical, just moved to userdata.

### 11.10 Risk: the new path interacts badly with concurrent webhook retries

- **Likelihood:** Low. Stripe's webhook retry pattern is "fire again with same payload if we didn't get 200 within 20s." Today this can produce double-VM-creation if webhook retries fire before the inline configure completes (we've seen it cause name collisions).
- **Impact:** Medium. Double-VM = wasted money + ambiguous state.
- **Mitigation:** `createUserVM` is idempotent via a check at the top: `SELECT id FROM instaclaw_vms WHERE assigned_to = userId LIMIT 1`. If a VM exists, the function returns the existing row without creating another. This idempotency is far simpler than today's `existingVm` branch in the webhook (~120 lines).

---

## 12. Rollback plan

The new path lives behind a single feature flag: `USE_ON_DEMAND_PROVISIONING` (string env var, default off, set per user-cohort via DB lookup).

### 12.1 Rollback triggers

Any of these triggers immediate rollback:
1. Two or more new-path provisioning failures in a 1-hour window without an obvious root cause.
2. Cloud-init log shows a systemic error (e.g., a template bug, an npm install failure across all VMs).
3. Reconciler queue depth for new VMs increases (indicating cloud-init is leaving drift).
4. Customer report of "agent doesn't work after signup" on a new-path VM.
5. Linode API error rate for `createServer` exceeds 5% over 15 minutes.

### 12.2 Rollback procedure

```bash
# Step 1: Disable the new path immediately
# Set USE_ON_DEMAND_PROVISIONING=false in Vercel dashboard
# (Takes ~30s to propagate; the change is per-request, not deploy)

# Step 2: Re-enable the pool replenishment
# Set REPLENISH_POOL_DISABLED=false in Vercel dashboard
# (replenish-pool cron resumes on next 5-min tick)

# Step 3: Re-enable process-pending passes
# Set PROCESS_PENDING_DISABLED=false in Vercel dashboard
# (process-pending cron resumes on next 5-min tick)

# Step 4: Verify rollback
curl -X POST $TEST_SIGNUP_URL → walks the old path
# expect: pool-assign within 1s, SSH configure within 60s, working bot
```

The rollback takes ~5 minutes end-to-end. The old code is still in place; we never deleted it during Phase 1. The new-path VMs already created continue to work — they don't need to be migrated back (they're healthy, just provisioned via a different path).

### 12.3 Post-rollback investigation

A rollback triggers an immediate postmortem:
1. Capture cloud-init logs from the failed VM(s) via the admin observability table.
2. Determine root cause (userdata template bug? Linode API hiccup? Network partition?).
3. Fix the cause in a separate PR.
4. Re-canary on Cooper's test account before re-enabling broadly.
5. Document the failure mode in CLAUDE.md if it's a class we want to prevent in the future.

### 12.4 Permanent rollback

If after 60 days of attempted rollouts we cannot get the new path stable, we delete `lib/cloud-init-userdata.ts` and `lib/create-user-vm.ts`, leave the old path running, and write a postmortem PRD explaining why this approach didn't work for InstaClaw specifically. This is the nuclear option — it's listed here so we have an explicit "we tried, it didn't work" exit ramp rather than letting the new path linger in a half-implemented state for a year.

---

## 13. Implementation plan

### Phase 0: PRD review + implementation map (2026-05-12 → 2026-05-13)

Cooper reviewed this document on 2026-05-12. Revisions 1-8 applied. Revised again 2026-05-12 (second pass) to aggressive pre-Edge timeline.

**Pre-implementation gate (per §1.0.1):** `docs/cloud-init-implementation-map.md` must be written, committed, and Cooper-reviewed before any line of `lib/cloud-init-userdata.ts` is written. The map covers the 9-item deep study listed in §1.0.1 — every file/config/command `configureOpenClaw` writes, every skill's deploy mechanism, every manifest entry, every workspace template's static-vs-per-user split, every reconciler step's a/b/c categorization, every cron source, every per-user generator, the full dependency graph.

**Deliverable:** `docs/cloud-init-implementation-map.md` exists and is approved by Cooper. Zero lines of implementation code written before this gate clears.

### Phase 1A — Build (2026-05-13 → 2026-05-24, 12 days)

Assumes Phase 0 cleared 2026-05-13 morning.

- **Day 1-2 (May 13-14):** Supabase migration. `cloud_init_callback_token`, `cloud_init_callback_consumed_at`, `created_via`, `event_buffer_tag` columns. `instaclaw_cloud_init_outcomes` + `instaclaw_circuit_breakers` tables. Migration tested in preview env. Type definitions updated.
- **Day 3-4 (May 15-16):** `lib/cloud-init-userdata.ts` skeleton. Pure-function `buildCloudInitUserdata(params)` + sub-builders. Unit tests on every output. **Rule 31 failure-mode test passes (`_test-cloud-init-userdata.ts`): largest realistic param combination produces <40 KB pre-base64.**
- **Day 5 (May 17):** `lib/cloud-init-userdata.ts` fully implemented for all 7 webhook branches' first-time-create cases. Partner gating (edge_city) wired. AgentBook wallet generation inline. Per-user .env + openclaw.json + auth-profiles.json generation.
- **Day 6 (May 18):** `lib/create-user-vm.ts`. Wraps `provisionBankrWallet`, `buildCloudInitUserdata`, `linodeProvider.createServer`, the atomic DB row insert. Generates `gateway_token` + one-time `callback_token`. Idempotent check at top (existing VM = no-op).
- **Day 7 (May 19):** `app/api/vm/cloud-init-callback/route.ts`. Atomic claim-and-invalidate UPDATE per §5.3.1. Threat-model tests (replay, fabricated token, wrong VM userId, already-claimed).
- **Day 8 (May 20):** `app/api/cron/cloud-init-poll/route.ts` modifications. Failure handler: VMs at `provisioning` >30 min get destroyed + respawned. SSH-capture cloud-init log to `instaclaw_cloud_init_outcomes`. Gated on `created_via='on_demand'` so old-path VMs untouched.
- **Day 9 (May 21):** `lib/respawn-vm.ts`. Fleet-wide circuit breaker per §5.4.1. Per-user 3-attempt cap. `instaclaw_circuit_breakers` row writes on trip.
- **Day 10 (May 22):** `app/api/billing/webhook/route.ts` modifications. Add `createUserVM` branch behind `USE_ON_DEMAND_PROVISIONING` env. The 7-branch decision tree (§10.3.2) wired. Old code path unchanged when flag is off.
- **Day 11 (May 23):** `_test-webhook-branching.ts` — all 7 branch tests written and passing. CI regression assertion for the old path must still pass.
- **Day 12 (May 24):** Buffer day. Final cleanup, end-to-end smoke test against a preview-env signup with flag enabled for a synthetic test userId. All PRs merged to `main` with flag OFF.

**Deliverable:** All code merged, `USE_ON_DEMAND_PROVISIONING=false` by default. Nothing changes for any user. CI is green. Smoke test in preview env validates the new path produces a working VM end-to-end.

### Phase 1B — Cooper self-test (2026-05-25 → 2026-05-27, 3 days)

- **Day 1 (May 25):** Flag enabled for `userId IN (cooper_test_user_ids)`. Cooper creates **5 fresh-user test signups** at distinct email addresses. Each one walks the full path. Verify on each VM:
  - Telegram bot responds within 90s of signup completion
  - Bankr wallet provisioned and visible in `instaclaw_vms.bankr_evm_address`
  - AgentBook wallet generated on-VM, address echoed in `agentbook_wallet_address`
  - MEMORY.md exists with initial template content
  - All 7 mandatory crons present in `crontab -l`
  - `config_version = VM_MANIFEST.version` (no reconciler drift on first cycle)
  - `cloud_init_callback_consumed_at IS NOT NULL` (callback fired exactly once)
  - Replay attempt: re-curl the callback URL with the same token; verify 401
  - Reconciler's first cycle finishes with `result.fixed = []` (no patches needed)
- **Day 2 (May 26):** Parallel old-path signup. Use a separate test userId with flag OFF. Diff every column of `instaclaw_vms` row, every on-disk file under `~/.openclaw/`, every crontab entry. Document divergences. Any divergence is a P0 fix before continuing.
- **Day 3 (May 27):** Fix anything that diverged. Re-canary all 5 Cooper-test signups. Sleep on it.

**Deliverable:** 5 of 5 Cooper-test signups produce VMs indistinguishable from the old path's output. Zero divergences. Cooper personally confident in the new path.

### Phase 1C — Edge City partner canary (2026-05-28 → 2026-05-29, 2 days)

- **Day 1 (May 28):** Flag enabled for `partner = "edge_city"` on new signups. Old path stays on for everyone else (incl. non-edge_city signups). The 5 existing edge_city VMs are untouched.
- **Day 1 evening:** First early-arrival Edge attendees (Timour's team, scouts) signup. Cooper watches `instaclaw_cloud_init_outcomes` table in real time. Any failure → admin alert → flip flag back to false for next signup → diagnose.
- **Day 2 (May 29):** Hold. Watch the canary cohort all day. Verify reconciler queue depth doesn't grow (new VMs should land at current manifest version).

**Deliverable:** All Phase 1C signups successful. `instaclaw_cloud_init_outcomes` shows 100% success rate on Phase 1C cohort. No P0 incidents.

### Phase 1D — Edge opens, new path live for all new signups (2026-05-30)

- **Day 0 (May 30):** Edge Esmeralda opens. If Phase 1B + 1C are clean, flag flipped to ON for all new signups (global). Old path REMAINS live as fallback — Stripe webhook still has the conditional. Pool stays at `POOL_TARGET=15` through Edge for fallback warmth.
- **Day 0+ (May 30 onward):** Monitor `instaclaw_cloud_init_outcomes`, `instaclaw_circuit_breakers`, the existing admin alerts, customer reports. Any single P0 → flag back off → diagnose → re-canary.

**Deliverable:** Edge Esmeralda's first day of signups runs through the new on-demand provisioning path. Old path is the warm fallback.

### Phase 1E — Pool retirement (post-2026-06-27, after Edge closes)

Only after Edge Esmeralda has ended cleanly:
- Disable `replenish-pool` cron (remove from `vercel.json`). Do NOT delete the handler.
- Pool drains naturally. Manually terminate remaining ready VMs.

**Deliverable:** Permanent rolling pool retired. ~$435/mo recovered. Event-buffer scripts (`_provision-event-buffer.ts`, `_terminate-event-buffer.ts`) become the new "burst insurance" pattern (§14 Q5/Q6) for future events.

### Phase 2 — Code deletion (2026-07-15+, separate PRD)

After 30+ days of green metrics on the new path post-Edge, delete the dead code per §6 in a separate PRD.

**Deliverable:** Net ~2,650 lines of code deleted. Single provisioning code path.

---

### Critical-path summary

| Date | Event | Status if-clean | Status if-broken |
|---|---|---|---|
| 2026-05-13 | Implementation map (`docs/cloud-init-implementation-map.md`) reviewed | Phase 1A begins | Phase 1A blocked; map needs more work |
| 2026-05-24 | All code in main, flag OFF | Phase 1B begins | Phase 1A extended; ship date slips |
| 2026-05-27 | Cooper-test signups validated | Phase 1C begins | Investigation + fix; if not fixable by 5/28, abandon aggressive timeline and revert to post-Edge plan |
| 2026-05-29 | edge_city canary clean | Phase 1D begins | Flag stays OFF for Edge; old path runs Edge; post-Edge attempt |
| 2026-05-30 | Edge opens, new path live | Edge runs on new path | Flag flipped OFF; Edge runs on old path; no user impact |
| 2026-06-27+ | Edge closes | Phase 1E begins | n/a |
| 2026-07-15+ | Phase 2 deletion | Separate PRD | n/a |

The aggressive timeline's only credible failure mode is "Phase 1C reveals a class of bug that can't be fixed in 24 hours." In that case, the flag stays OFF for Edge — same outcome as the original post-Edge plan, with two weeks of code now sitting behind the flag waiting for post-Edge canary. No user impact in either case.

---

## 14. Open questions

1. **Userdata fetch-from-URL pattern.** Should very large templates (full SOUL.md, big skill repos) be fetched from a URL during cloud-init, or embedded inline in userdata? Inline is simpler but constrains size. URL-fetch is more flexible but adds a network dependency at first boot. *Recommend inline for now; revisit when SOUL.md grows past ~15 KB.*

2. **Cloud-init-callback authentication.** The proposal authenticates via the gateway token (which the cloud-init userdata generates and is therefore known to both the VM and the webhook). Should we use a separate "first-boot token" that's purpose-built for this single callback? *Recommend gateway token reuse; it's already in our security model and the callback is one-shot.*

3. **Deterministic VM naming.** What's the right shape for the per-VM Linode label? Options:
   - `instaclaw-vm-${vmCount}` (today's pattern, requires counter) — breaks without a pool
   - `instaclaw-vm-${userId.slice(0,8)}` (deterministic, derives from userId)
   - `instaclaw-vm-${randomUUID().slice(0,8)}` (random, no collision risk)
   *Recommend the third option. UUIDs avoid any collision class, and we don't need the name to be human-meaningful (vmId in the DB is the user-facing identifier anyway).*

4. **Respawn rate limit.** How many consecutive respawn failures before we give up and mark the user as "stuck" requiring manual intervention? *Recommend 3, mirroring today's `MAX_CONFIGURE_ATTEMPTS`. Same constant, same semantic.*

5. **Emergency event buffer for burst signups.** **YES — kept.** Distinct from the permanent rolling pool (which is eliminated). The buffer is:
   - **Manually provisioned** before a known burst event (Edge Esmeralda, partner launch days, a public announcement).
   - **Small** (3-5 VMs, not 15+). The intent is "insurance against Linode API hiccups during the first hour of signups," not "ongoing pool floor."
   - **No replenish-pool cron.** Buffer is provisioned once via a one-off admin script (`scripts/_provision-event-buffer.ts`). It does not auto-refill.
   - **Terminated after the event** via a second one-off script. We do not maintain the buffer indefinitely.
   - **`assigned_to = NULL` until claimed.** `billing/webhook` Branch A's `createUserVM` first checks if there's a buffer-tagged VM available (`status='healthy' AND event_buffer_tag = current_event_tag AND assigned_to IS NULL`); if yes, attach it to the new user. If no, fall through to `createUserVM` (provision-on-demand). This means the buffer accelerates signup latency from 60s to <1s for the first N users of a burst — and once the buffer drains, subsequent signups go through the normal on-demand path with no degradation.
   - **Cost:** 5 VMs × $29/mo × ~7-day event window = ~$33/event. Edge Esmeralda's 4-week duration = ~$135. Cooper's framing: $145/mo insurance against API hiccups during the burst window. We pay for the buffer to exist during the event; we tear it down after.

   This is fundamentally different from the permanent rolling pool we're eliminating. The rolling pool is a cron-driven steady-state cost of $435/mo (POOL_TARGET=15) running 365 days/year. The event buffer is a one-shot, manually-managed, time-bounded insurance policy.

6. **Edge City pre-event burst — what kind of pool is it really?** Be precise:
   - **The permanent rolling pool with `replenish-pool` cron** = ELIMINATED. That's the one this PRD retires. No more cron at all, no `POOL_TARGET`, no `POOL_FLOOR`, no `MAX_PER_RUN`, no name-collision defense across pool batches.
   - **The Edge Esmeralda emergency buffer** = KEPT. Manually provisioned, 3-5 VMs, terminated after the event. It IS a pool in the strict sense (multiple `assigned_to=NULL` VMs sitting healthy waiting for users to be attached). Calling it anything else would be dishonest — it's a pool, with a different operational shape (no cron, no replenishment, no permanence). The pool/no-pool distinction this PRD makes is: **no cron-driven self-replenishing pool, ever.** Manually-provisioned event buffers are fine.
   - **Pre-provisioning a specific cohort** = SEPARATE (and orthogonal). If we wanted to pre-create VMs for 50 specific Edge attendees before the event (e.g., based on RSVPs), we'd loop `createUserVM(userId, params)` over the 50 userIds. Those VMs ARE assigned to specific users from creation; they're not in a pool. This is the pattern the "scale follow-ups" doc in CLAUDE.md F2 hints at.

   Operationally, only the second of these three matters for daily flow. The first is dead, the third is a per-event runbook decision.

7. **Should we consolidate `thawVM` into `createUserVM` now or later?** *Later. `thawVM` is its own beast (snapshot-from-user's-personal-image instead of fleet-snapshot); merging them adds complexity without clear benefit in this PRD. Separate PRD when memory portability (edgeclaw §4.17) lands.*

8. **Observability for the new path.** What admin dashboard / metric do we need on day 1? *Recommend a `cloud_init_outcomes` table with one row per provisioning attempt: `vm_id, user_id, started_at, finished_at, status (healthy/failed/timeout), cloud_init_log_excerpt`. Surfaces in a simple admin view. Lets us watch the canary cohort's success rate in real time.*

9. **What if the snapshot is stale (per CLAUDE.md Rule 7 "Snapshot Refresh")?** *The reconciler still handles this. New VMs land at `config_version = VM_MANIFEST.version` (the current code in cloud-init writes this directly). If a manifest bump happens AFTER snapshot bake, new VMs land with the right `config_version` but their on-disk state may have stale baseline (from the snapshot). The reconciler's drift-repair detects and fixes this on its next cycle (3 min), exactly as today.*

10. **The reconciler's "first-time configure" steps.** The Explore agent found that some of the reconciler's heal steps (stepBootstrapState, stepShmCleanupCron, stepDispatchServer) are patching configureOpenClaw's silent omissions. After this PRD, those omissions should not happen (cloud-init is atomic). Should we delete those heal steps? *Not in this PRD. Keep them as defense-in-depth for now. Revisit after 90 days of green metrics on the new path — if those heal steps never fire on new-path VMs, they can be conditionally disabled (matched against `vm.created_via = "on_demand"` to keep the safety net for old VMs).*

---

## 15. Decision matrix — Cooper's review (2026-05-12)

| Question | Recommendation | Cooper |
|---|---|---|
| Approve the on-demand provisioning approach in principle? | Yes | **APPROVED** |
| Approve the migration plan (new-signups-only, no migration of existing 200+)? | Yes | **APPROVED** |
| Approve the rollback plan (feature flag + dead-code retention for 30 days)? | Yes | **APPROVED** |
| Approve the timeline | Yes | **REVISED — post-Edge work only. Phase 1A starts ≥2026-06-05. §1.0 + §13 updated.** |
| Approve the deletion list in §6 (Phase 2 only, per stated plan)? | Yes | **APPROVED** |
| Approve the new-files list in §7? | Yes | **APPROVED (revised with callback_token + event-buffer + circuit-breaker additions)** |

### 15.1 Cooper's 8 revisions — applied in this version

| # | Revision | Where applied | Status |
|---|---|---|---|
| 1 | Timeline: explicit "does NOT ship before Edge Esmeralda" | §1.0 (new section) + §13 Phase −1 + Phase 1A start date | ✓ |
| 2 | Userdata size budget: concrete per-section measurement, fetch-from-URL failure analysis if over 50 KB | §4.3 fully rewritten with measured byte breakdown (subtotal ~14.5-21 KB pre-base64) + explicit non-list of what stays in snapshot + fetch-from-URL as contingency only with failure-mode analysis | ✓ |
| 3 | cloud-init-callback security: one-time-use nonce, separate from gateway token | §5.1 (createUserVM steps 4+5), §5.3 (userdata calls callback_token, not gateway_token), §5.3.1 (new section — full endpoint + threat model), §7 (new files list updated) | ✓ |
| 4 | Emergency pool for burst events (keep $145/mo insurance for known bursts) | §14 Q5 rewritten — YES, kept; explicit distinction from permanent rolling pool | ✓ |
| 5 | Process-pending stays fully functional through Phase 1A-1E rollout | §10.0 (new section) — process-pending and khomenko89 fix preserved throughout rollout; CI regression assertion mandatory | ✓ |
| 6 | Webhook branching: full conditional chain with all 7 user-state scenarios | §10.3 expanded — 7 branches enumerated (A-G), `stepMigrateFromLastVm` proposed for Branch G, branch-execution diagram, mandatory Rule 31 test per branch | ✓ |
| 7 | Respawn circuit breaker: fleet-wide rate limit (>10/hour halts respawns) | §5.4 expanded + §5.4.1 (new section) — implementation, thresholds, schema for `instaclaw_circuit_breakers` and `instaclaw_cloud_init_outcomes` | ✓ |
| 8 | Q6 honesty: call the event buffer a "pool" (because it is one) | §14 Q5/Q6 rewritten — explicit naming: permanent rolling pool ELIMINATED, manually-provisioned event buffer KEPT and IS a pool by definition | ✓ |

### 15.2 Open questions Cooper has NOT yet ruled on

These are inherited from §14's Q1-Q10. Cooper's review covered Q5 and Q6; the remainder still need answers before Phase 1A kickoff (≥2026-06-05):

- **Q3 — deterministic VM naming.** Recommended: random UUIDs. Decision pending.
- **Q4 — respawn rate limit per user.** Recommended: 3 attempts, mirrors `MAX_CONFIGURE_ATTEMPTS`. Decision pending.
- **Q7 — consolidate `thawVM` into `createUserVM`?** Recommended: later, separate PRD. Decision pending.
- **Q9 — snapshot staleness behavior under the new arch.** Recommended: rely on reconciler drift-repair (current behavior). Decision pending.
- **Q10 — should the reconciler's heal steps be conditional on `vm.created_via`?** Recommended: not in this PRD; keep heal steps as defense-in-depth. Decision pending.

---

## 16. What this PRD does NOT do

For clarity, the following are explicit non-goals (re-stated from §1's non-goals plus additional clarifications):

- **Does not change unit economics.** Per-VM cost is still ~$29/mo Linode dedicated. Cost-down is a separate Phase 2 conversation (Hetzner migration, separate PRD).
- **Does not change the brand promise.** Each agent still gets its own dedicated, persistent, always-on Linux environment. Files accumulate. Memory grows. Browser sessions persist. The "residents not tourists" position holds.
- **Does not migrate existing 200+ VMs.** They run as-is forever. Old path stays in place for them.
- **Does not change the snapshot baking process.** The CLAUDE.md "Snapshot Creation Process" is unchanged. Snapshots are baked the same way; cloud-init does per-user overlay on top.
- **Does not change the reconciler's behavior.** Same 43 steps, same drift-repair semantics, same cadence. Just runs less often per VM because cloud-init landed correctly.
- **Does not change customer-facing UI.** Same `/connect`, `/plan`, `/deploying`, `/dashboard`. Same flows.
- **Does not implement memory portability.** That's edgeclaw §4.17, separate work. This PRD makes it more valuable as a precondition for clean respawn but doesn't ship it.
- **Does not consolidate thawVM with createUserVM.** Separate, future PRD.
- **Does not address the 200+ existing VMs' eventual sunset.** They cycle out naturally via cancellations. If/when a user voluntarily clicks "start fresh" (a hypothetical future feature), they'd go through the new path.

---

**End of PRD. Awaiting Cooper's review per §15.**
