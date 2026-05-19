# Autonomous Bake System — Design Document

**Date**: 2026-05-19
**Status**: Design only. NO code yet. Awaiting Cooper review.
**Goal**: After implementation, any terminal can run "bake a snapshot" and the system handles everything end-to-end. No manual checklist walking, no operator double-checking pins, no stale-value risk.
**Target deploy**: Before next bake after May 23 (so the May 23 bake is a proof point but not the test driver — May 23 still runs the manual checklist as a backstop).

---

## Executive summary

The bake pipeline is already 80% automated. Four existing scripts (`_pre-bake-check.ts`, `_prebake-cleanup.sh`, `_postbake-validation.ts`, `install-gbrain.sh` — ~4.2K lines combined) cover pre-flight gates, per-VM cleanup, post-bake verification, and gbrain install respectively. The 20% gap is **orchestration** (which script runs when), **Linode API calls** (provision / shutdown / imagize / delete), and **5 manual checklist steps** that exist as shell EOF blocks in the markdown rather than as code.

Recommendation: ship a single TypeScript orchestrator (`scripts/_autonomous-bake.ts`) that **calls the existing scripts in sequence**, **fills the Linode API gap**, **automates the 5 remaining manual steps**, and **verifies every transition with structured pre/post conditions**. The orchestrator is **idempotent + resumable** (state persisted to disk per run), **source-of-truth-driven** (pins read live from `lib/vm-reconcile.ts`), and **drift-aware** (alerts on unfamiliar env vars or reconciler-step changes since the last bake).

Net effect: `npx tsx scripts/_autonomous-bake.ts` becomes the canonical bake command. Existing manual checklist demoted to a "recovery / forensics" reference. Cooper retains a single P0 gate (the post-soak production cutover — Vercel env update). Every other gate is automated with explicit go/no-go output.

The existing manual checklist v105 is sufficient as a fallback for the May 23 bake. **Don't block May 23 on this work.** Build it for the June bake cycle.

---

## Phase 1: Deep audit

### 1.1 Pipeline files inventory

| File | Lines | Role | Already callable from a script? |
|---|---|---|---|
| `instaclaw/docs/snapshot-bake-v105-checklist.md` | 1,097 | Manual checklist (38 checkboxes) | No — markdown |
| `instaclaw/docs/snapshot-bake-runbook.md` | 822 | Reference doc (rationale, manual flow) | No — markdown |
| `instaclaw/scripts/_pre-bake-check.ts` | 964 | Pre-flight: HEAD alignment, env vars, pin alignment, Linode reachable, fleet health, alerts | **Yes** — `npx tsx`; returns exit 0/1/2 |
| `instaclaw/scripts/_prebake-cleanup.sh` | 631 | Per-VM cleanup, 20 sections (secrets, sessions, partner state, history, logs, caches, /tmp, cloud-init) | **Yes** — `--dry-run` / `--confirm` |
| `instaclaw/scripts/_postbake-validation.ts` | 1,088 | 110 checks (60 P0 + 44 P1 + 6 P2) across 30+ sections in `bake` or `test` mode | **Yes** — `--vm-ip=<IP> --mode=bake\|test` |
| `instaclaw/scripts/install-gbrain.sh` | 1,549 | Gbrain install phases A→I (Bun, repo, patch, install, service start, MCP verify, gateway wire, CHECKPOINT cron) | **Yes** — runs via SSH with env-var inputs |
| `instaclaw/scripts/provision-batch.ts` | ~200 | Reference for provider-API-driven batch VM provisioning (Hetzner, not Linode) | **Yes** — but not for Linode bake VM |
| `instaclaw/scripts/_probe-snapshot-inventory.ts` | ~400 | Read-only SSH probe to reconcile cloud-init expectations vs filesystem | **Yes** — diagnostic, not bake-blocker |
| `instaclaw/lib/vm-reconcile.ts` (`reconcileVM`) | 8,175 | 50+ reconciler steps; the §3.3 catch-up calls this | **Yes** — via `auditVMConfig` in `lib/ssh.ts` |
| `instaclaw/lib/vm-manifest.ts` (`VM_MANIFEST`) | 2,449 | Manifest source-of-truth: version, configSettings, files[], cronJobs[], skills | Read-only constant |
| `instaclaw/lib/ssh.ts` (`auditVMConfig`, `configureOpenClaw`) | 12,187 | High-level VM operations | **Yes** — TS imports |
| `instaclaw/vercel.json` (crons) | 168 | Production cron schedule (23 entries) | Config; read-only at bake-time |

**Implication**: orchestrator can be a thin layer over these scripts. Don't reinvent verification logic.

### 1.2 Checklist step-by-step gap analysis

Every numbered section of the v105 checklist mapped to automation state. **A = already automated by an existing script.** **B = can be automated trivially (just needs orchestrator to invoke).** **C = requires new code in the orchestrator.** **D = manual; cannot/should not be automated.**

| § | Step | State | Failure mode if skipped | Pre-imagize verification? |
|---|---|---|---|---|
| 2.1 | vm-050 canary install proof | D (Cooper certifies) | Bake from unproven install path | No |
| 2.2 | Install script bug-fixes landed in main | A (`_pre-bake-check.ts` `checkHeadAlignedWithMain` + `checkIntegrityFixLanded`) | Bake against stale code | Yes (exit non-zero) |
| 2.3 | Pre-bake snapshot verifications (snapshot ID match, install script syntax, pin alignment) | A (`_pre-bake-check.ts` `checkLinodeSnapshotMatch` + `checkGbrainPinnedAlignment` + `checkGbrainInstallScriptsSyntax`) | Wrong snapshot baseline; stale pins; broken script | Yes |
| 2.4 | Anthropic $300/mo cap | D (Cooper-only access to console.anthropic.com) | Cost overrun if gbrain agent burns embeddings | No (operator confirms) |
| 2.5 | No critical alerts in 24h | A (`_pre-bake-check.ts` `checkAdminAlerts`) | Bake during an active incident | Yes |
| 2.6 | Gbrain SOUL.md protocol pre-bake gate (post-§3.5 marker verification) | C (new orchestrator code; mirrors existing pattern) | Snapshot missing gbrain protocol → 3-min unhelpful agent on every new edge VM | Yes (post-§3.5 grep) |
| 2.6.5 | Reconciler env-var gates (Family A bake-tooling, Family B install-gbrain.sh args, Family C Vercel prod) | A (`_pre-bake-check.ts` `checkEnvVarsPresent`) + B (new check for `RECONCILE_SOUL_MIGRATION_VM_IDS` unset) | V2 templates don't deploy; install-gbrain.sh fails; production VMs miss config | Partial — Family C is Vercel-side, can be auto-checked via `vercel env ls` |
| 2.6.6 | v106 landing contingency (Path A vs Path B) | C (new orchestrator code; auto-detect via git log + grep for `stepDeployGbrainSoulRouting`) | Operator confusion about expected SOUL.md state | Yes (sets expected state for §3.8) |
| 2.7 | Run `_pre-bake-check.ts` | A (already a script) | Pre-flight gate bypassed | Yes |
| 2.8 | Workspace bootstrap-file sizes | A (`_postbake-validation.ts` §4) | Per-file > 40K silent truncation | Yes |
| 3.1 | Provision bake VM (Linode API POST) | C (new orchestrator code; `provision-clob-proxy.sh` is reference pattern) | No bake VM | n/a (precondition) |
| 3.2 | Upgrade OpenClaw + system packages | B (SSH command sequence; can script) | Bake VM at old OpenClaw → stale snapshot | Yes (post-step grep + version check) |
| 3.2.5 | Lock down nodejs (apt hold) | B (SSH command) | Future nodejs auto-upgrade breaks reconcile | Yes (`apt-mark showhold`) |
| 3.3 | Reconcile bake VM via `auditVMConfig` (synthetic VM record) | A (auditVMConfig exists) + B (orchestrator constructs the synthetic VM record + acquires cron lock) | Snapshot misses every manifest config since v82 | Yes (`r.errors` + `r.strictErrors` empty) |
| 3.4 | Install all crons | A (stepCronJobs runs inside §3.3) + B (orchestrator verifies via `crontab -l`) | Missing crons → no session compaction, no heartbeat, no CHECKPOINT | Yes (grep crontab) |
| 3.5 | Install gbrain HTTP sidecar | A (`install-gbrain.sh`) + B (orchestrator SCPs script + invokes with current pins) | No gbrain on snapshot → 3-min boot lag on edge VMs | Yes (`PHASE_X_OK` markers in stdout) |
| 3.5.5 | Phase C2 patch + Phase I CHECKPOINT install verification | C (new orchestrator code) | Inert CHECKPOINT cron → Rule 54 corruption on SIGKILL on long-uptime VMs | Yes (5 explicit checks + trial CHECKPOINT call) |
| 3.6 | Strip bearer token + disable service + scrub openclaw.json | C (currently a manual EOF block in checklist — extract to `lib/bake/strip-bearer.ts`) | Snapshot ships with per-VM bearer → bearer reuse across VMs is a Rule 58 security violation | Yes (`is-active = inactive`, file absent, mcp entry absent) |
| 3.6.5 | Run `_prebake-cleanup.sh --confirm` | A (script exists) + B (orchestrator invokes) | Snapshot ships with per-VM contamination | Yes (`_postbake-validation.ts` catches what cleanup missed) |
| 3.7 | Clean caches (extra beyond §3.6.5 §16) | B (additional SSH commands per existing checklist) | Snapshot exceeds 6,144 MB image cap | Yes (`df -h`) |
| 3.8 | Run `_postbake-validation.ts --mode=bake` | A (script exists) + B (orchestrator invokes) | Bake-blocker bugs ship to production | Yes (110 checks; all P0 must pass) |
| 3.9 | Disk usage < 6.0 GB | A (`_postbake-validation.ts` §22) + B (orchestrator explicit gate) | Imagize fails (Linode silently deletes the image) | Yes |
| 3.10 | Power off + bake image (Linode API) | C (new orchestrator code) | Bake never completes | Yes (poll image status=available) |
| 3.11 | Update `LINODE_SNAPSHOT_ID` references | D (Cooper-only — Vercel env update) | New snapshot not used; replenish-pool keeps using old | Yes (orchestrator outputs the `printf` command for Cooper) |
| 3.12 | Cleanup (delete bake VM) | B (Linode API DELETE) | Bake VM costs $5/mo forever | Yes |
| 4 | Soak (provision test VM, reconcile, verify converge) | A (`_postbake-validation.ts --mode=test`) + B (orchestrator provisions new VM from new image, reconciles, runs test mode) | Production cutover with broken snapshot | Yes |
| 5 | Production cutover (Vercel env update) | D (Cooper retains gate per Rule 6) | n/a — manual | n/a |
| 6 | Rollback plan | D (reference doc) | n/a | n/a |
| 7 | Cooper-action checklist | D | n/a | n/a |

**Summary**:
- 38 checkboxes total
- **20 already A (existing automation)**
- **7 are B (trivial-to-automate; just call existing automation in sequence)**
- **6 are C (new orchestrator code; not currently automated anywhere)**
- **5 are D (must stay manual — Cooper-only credentials or strategic decisions)**

Gap = 6 C-class steps. Everything else is plumbing.

### 1.3 Env vars / pins / flags / gates inventory

For each: where defined, where consumed, default, automated check exists, what breaks if wrong.

#### Source-controlled pins (in `lib/`)

| Name | Defined | Consumed | Default | Auto-check | Failure mode |
|---|---|---|---|---|---|
| `GBRAIN_PINNED_COMMIT` | `lib/vm-reconcile.ts:136` | install-gbrain.sh env arg | `1d5f69f` (today) | `_pre-bake-check.ts:checkGbrainPinnedAlignment` | Wrong commit installed |
| `GBRAIN_PINNED_VERSION` | `lib/vm-reconcile.ts:137` | install-gbrain.sh env arg | `0.36.3.0` | `checkGbrainPinnedAlignment` | Wrong version installed |
| `OPENCLAW_PINNED_VERSION` | `lib/vm-manifest.ts` | reconciler step | (read live) | `_postbake-validation.ts §2` | Wrong OpenClaw runtime |
| `NODE_VERSION` | `lib/vm-manifest.ts` | reconciler step | `v22.22.2` | `_postbake-validation.ts §2` | Wrong Node binary |
| `BOOTSTRAP_MAX_CHARS` | `lib/vm-manifest.ts:468` | configSettings | `40000` | `_postbake-validation.ts §4` | Silent truncation |
| `VM_MANIFEST.version` | `lib/vm-manifest.ts:614` | reconciler cron filter | `105` (today) | `_pre-bake-check.ts:checkManifestVersion` | Reconciler ignores correct VMs |
| `SECRET_VERSION` | `lib/vm-reconcile.ts` | reconciler secret-rotation gate | `2` (today) | Manifest changelog tracking | Old secrets persist |
| `GBRAIN_PARTNER_ALLOWLIST` | `lib/vm-reconcile.ts:128` | stepGbrain gate | `["edge_city"]` | None today | Non-edge VMs don't get gbrain |

#### Bake-tooling env (in `.env.local` of operator's machine)

| Name | Required value | Where consumed | Auto-check | Failure mode |
|---|---|---|---|---|
| `LINODE_API_TOKEN` | (operator's) | Linode API calls | `_pre-bake-check.ts:checkLinodeReachable` | Can't provision |
| `LINODE_SNAPSHOT_ID` | `private/<id>` | bake VM provision source | `checkLinodeSnapshotMatch` | Bake from wrong baseline |
| `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | (operator's) | Synthetic VM row for reconcile | `checkSupabaseReachable` | Can't query/insert VMs |
| `SSH_PRIVATE_KEY_B64` | (operator's) | SSH to bake VM | None today | Can't SSH |
| `RECONCILE_SOUL_MIGRATION_ENABLED` | `"true"` | reconcileVM → stepMigrateSoulV2 | New (§2.6.5 just added) | V2 templates don't deploy on bake VM |
| `RECONCILE_SOUL_MIGRATION_VM_IDS` | (unset or `"bake-vm"`) | stepMigrateSoulV2 canary scope | New (just added) | V2 migration skipped silently |
| `GBRAIN_INSTALL_ENABLED` | `"true"` (for prod) | stepGbrain gate | New (just added) | Production fleet doesn't converge post-bake |

#### Vercel production env

| Name | Required value | Auto-check | Failure mode |
|---|---|---|---|
| `LINODE_SNAPSHOT_ID` | NEW snapshot id post-cutover | None today — needs `npx vercel env ls production` check | replenish-pool uses old snapshot |
| `GBRAIN_INSTALL_ENABLED` | `"true"` | None today | Edge VMs from new snapshot don't re-install gbrain on reconcile |
| `GBRAIN_PINNED_COMMIT` / `_VERSION` | Same as source pins | None today | Reconciler can't run install-gbrain.sh on prod |
| `RECONCILE_SOUL_MIGRATION_ENABLED` | `"true"` (Q-C decision) | None today | V2 migration skipped in prod cron |
| Various secret env vars | per `SECRET_ENV_VAR_SOURCES` | None today | Secrets don't propagate to fresh VMs |

**Gap**: there's no Vercel-side env audit today. The orchestrator should add one.

#### Reconciler feature flags (env-var gated paths in `lib/vm-reconcile.ts`)

Per `grep -nE "process\.env\." lib/vm-reconcile.ts`:

| Flag | Line | Effect | Auto-check |
|---|---|---|---|
| `process.env.GBRAIN_INSTALL_ENABLED !== "true"` | 1629 | stepGbrain skip | New gate added in §2.6.5 |
| `process.env.VERCEL_ENV === "production"` | 1901 | Production-only behavior | n/a (orchestrator runs locally) |
| `process.env.NEXTAUTH_URL` | 4274 | Gateway URL construction | Operator's `.env.local` |
| `process.env.RECONCILE_SOUL_MIGRATION_ENABLED !== "true"` | 6906 | stepMigrateSoulV2 skip | New gate |
| `process.env.RECONCILE_SOUL_MIGRATION_VM_IDS` | 6911 | Canary whitelist | New gate |

The orchestrator should `grep -nE "process\.env\." lib/vm-reconcile.ts` at runtime and report any **NEW** env-var references not in its known list. This is the **future-proofing pattern**: when a future terminal adds `process.env.NEW_FLAG`, the bake either picks it up automatically (if the orchestrator knows how) or refuses to proceed (forcing the operator to update the orchestrator's env-var knowledge).

### 1.4 Reconciler step inventory

Reconciler orchestrator runs 50+ steps. Each gets executed once during §3.3 catch-up. Full list at `lib/vm-reconcile.ts:418-769`:

```
disk-guard, backup, placeholder, workspace-integrity, execstart-alignment,
config-settings, telegram-token-verify, env-var-push, gbrain, index,
files, soul-v2-migration, bootstrap-consumed, rename-video-skill,
fix-blank-identity, remove-duplicate-skills, skills, remotion-deps,
node-pin-drift, npm-pin-drift, model-primary-pin, cron-jobs,
system-packages, python-packages, env-vars, auth-profiles,
clear-provider-cooldown, systemd-unit, prctl-subreaper, sshd-protection,
clean-stale-memory, caddy-ui-block, v67-routing-patch,
instaclaw-identity-patch, v92-partner-stub-rewrite, gbrain-soul-protocol,
gbrain-soul-routing, edge-overlay-deploy, heal-bootstrap-state,
heal-shm-cleanup, heal-skill-dirs, heal-external-skills,
heal-gateway-watchdog, heal-dispatch-server, heal-instaclaw-xmtp,
heal-node-exporter, heal-ufw-rules, privacy-bridge-deploy,
gateway-restart, canary, done
```

The bake VM runs through ALL of them. The orchestrator's §3.3 wrapper just needs to (a) construct a synthetic VM record, (b) acquire the reconcile-fleet cron lock, (c) call `auditVMConfig`, (d) verify `errors` + `strictErrors` empty, (e) release the lock.

**Drift detection**: the orchestrator should hash the body of `reconcileVM` (lines 418-769) and persist it. On the next bake, if the hash differs (new step added or old step changed), alert. This catches the class of bug where a future terminal adds a step but doesn't update the bake docs.

### 1.5 What's already automated (existing scripts)

Restating succinctly, what works today:

- **Pre-flight**: HEAD alignment, integrity-fix landed, LINODE_SNAPSHOT_ID match, GBRAIN_PINNED alignment, install-gbrain syntax, env-vars present, manifest version, Supabase reachable, Linode reachable, fleet cv distribution, quarantined VMs, stale cron locks, admin alerts, fleet disk usage, gbrain edge_city coverage. → `_pre-bake-check.ts` (CRITICAL/WARNING/INFO).
- **Cleanup**: 20 sections covering secrets, sessions, partner state, history, logs, caches, /tmp, cloud-init artifacts. → `_prebake-cleanup.sh --confirm`.
- **Validation**: 110 checks (60 P0 + 44 P1 + 6 P2) across 30+ sections covering machine identity, infrastructure, systemd overrides, sshd protection, workspace files (presence + size), secrets absent, user memory absent, browser state, partner state, Telegram state, locks, scripts, backups, crontab, history, logs, caches, /tmp, manifest scripts, gbrain (binary + MCP + env), gateway state, config keys, disk usage, skills, sudoers, cloud-init state, snapshot-bake-mode marker, SNAPSHOT_BAKED gap-fills, Caddy /vnc, bun-in-PATH, recent-incident gates. → `_postbake-validation.ts --mode=bake`.
- **Gbrain install**: 9 phases (Bun, repo clone + patch, install, version verify, service + bearer + start, MCP verify, gateway wire, round-trip put_page test, CHECKPOINT cron + ExecStop). → `install-gbrain.sh`.

### 1.6 What's NOT automated (the gaps)

**6 C-class steps** plus orchestration:

1. **Orchestration itself**: no script knows the order or owns the state machine.
2. **Linode API: provision bake VM** (§3.1). `provision-clob-proxy.sh` is a reference pattern; `lib/providers/hetzner.ts` exists for Hetzner. No equivalent for Linode bake VM.
3. **Linode API: shutdown + imagize + poll** (§3.10). New code.
4. **Linode API: delete bake VM** (§3.12). New code.
5. **Synthetic VM record construction** (§3.3). Inline TypeScript in the checklist; extract to a helper.
6. **Bearer-token strip block** (§3.6). Currently a complex EOF shell block. Extract to a script `lib/bake/strip-bearer.ts` or `scripts/_bake-strip-bearer.sh`.
7. **Phase C2 + Phase I verification** (§3.5.5 — just added). Currently a 6-check SSH heredoc. Extract to a function.
8. **V106 landing contingency detection** (§2.6.6). Currently a git-log + grep that operator runs manually.
9. **Vercel-side env audit** (no checklist section today, but Family C in §2.6.5 implies it). New code.
10. **Soak orchestration** (§4). Manually provision test VM, run `_postbake-validation.ts --mode=test`. Extract to a function.

All 10 are mechanically straightforward. The hard part is **structure**: state machine + step taxonomy + verification framework + resume semantics.

---

## Phase 2: Autonomous bake system design

### 2.1 Goals + non-goals

**Goals**:

1. **One-command bake**: `npx tsx scripts/_autonomous-bake.ts` runs the full pipeline from preflight to soak. Outputs a go/no-go recommendation.
2. **Idempotent + resumable**: each step is safe to re-run. State persisted to disk per bake run. Resume from last successful step on failure.
3. **Source-of-truth-driven**: pins, manifest version, env vars all read at runtime. Never hardcoded.
4. **Self-discovering**: detects new env vars, new reconciler steps, new pin values since the last bake. Alerts on unfamiliar changes.
5. **Verification-gated**: every step has explicit pre/post conditions. P0 failure = abort. P1 = warn. P2 = note.
6. **Cost-safe**: bake VM auto-destroyed on failure (before imagize) so $ doesn't burn. Snapshot retained for 1 week on success per CLAUDE.md.
7. **Audit trail**: every run produces a structured log + state file. Post-mortems via `--action=status <run-id>`.

**Non-goals**:

1. Replace Cooper's Vercel-env-update gate (Rule 6: Cooper retains `printf` discipline). Orchestrator outputs the commands; Cooper runs them.
2. Replace the Anthropic console.anthropic.com $300 cap check (Cooper-only credentials).
3. Replace the v106 decision (gbrain terminal owns; orchestrator just detects).
4. Build a Packer/HCL-style declarative spec from scratch. We use a thin TypeScript orchestrator that calls existing scripts.
5. Multi-cloud (Linode only — no Hetzner/AWS).
6. Replace the checklist doc. Checklist stays as human-readable reference; orchestrator is the source of truth for execution.

### 2.2 Architecture overview

```
┌──────────────────────────────────────────────────────────────┐
│ scripts/_autonomous-bake.ts (NEW orchestrator)              │
│   ├── action: full | preflight | resume | status | dry-run  │
│   ├── state: ~/.bake-state/<run-id>/                        │
│   └── log:   ~/.bake-state/<run-id>/log.txt                 │
└──────────────────────────────────────────────────────────────┘
            │
            │ calls:
            ▼
┌──────────────────────────────────────────────────────────────┐
│ EXISTING scripts (unchanged):                                │
│   ├── _pre-bake-check.ts        → preflight gate            │
│   ├── _prebake-cleanup.sh       → cleanup phase             │
│   ├── _postbake-validation.ts   → validation gate           │
│   └── install-gbrain.sh         → gbrain install phase      │
└──────────────────────────────────────────────────────────────┘
            │
            │ supported by:
            ▼
┌──────────────────────────────────────────────────────────────┐
│ NEW library modules:                                         │
│   ├── lib/bake/linode-api.ts        → provision/shutdown/   │
│   │                                    imagize/poll/delete  │
│   ├── lib/bake/state.ts             → state machine + persist │
│   ├── lib/bake/source-of-truth.ts   → live pin/manifest read │
│   ├── lib/bake/step-spec.ts         → BakeStep type + helpers │
│   ├── lib/bake/verifications.ts     → reusable check helpers │
│   ├── lib/bake/strip-bearer.ts      → §3.6 automation       │
│   ├── lib/bake/checkpoint-verify.ts → §3.5.5 automation     │
│   ├── lib/bake/v106-detect.ts       → §2.6.6 path detect    │
│   ├── lib/bake/synthetic-vm.ts      → §3.3 synthetic VM record │
│   └── lib/bake/vercel-env-audit.ts  → §2.6.5 Family C check │
└──────────────────────────────────────────────────────────────┘
```

### 2.3 Step taxonomy + state machine

```typescript
type BakePhase =
  | "preflight"
  | "provision"
  | "upgrade-os"
  | "reconcile"
  | "gbrain-install"
  | "checkpoint-verify"
  | "strip-bearer"
  | "cleanup"
  | "validate"
  | "disk-check"
  | "imagize"
  | "soak"
  | "report";

type BakeStep = {
  id: string;                              // unique, kebab-case
  phase: BakePhase;
  description: string;                     // human-readable
  preconditions: Verification[];
  action: (state: BakeState) => Promise<StepResult>;
  postconditions: Verification[];
  rollback: (state: BakeState) => Promise<void>;
  retryable: boolean;                      // safe to re-run after failure?
  recovery_hint: string;                   // what operator should do if this fails
};

type BakeState = {
  run_id: string;                          // ISO timestamp
  started_at: string;
  current_phase: BakePhase;
  current_step_id: string;
  bake_vm: {
    linode_id?: number;
    ip_address?: string;
    label: string;
  };
  source_pins: {                           // captured at start
    gbrain_commit: string;
    gbrain_version: string;
    manifest_version: number;
    openclaw_version: string;
    node_version: string;
  };
  v106_path: "A" | "B";                    // resolved at preflight
  step_results: Record<string, StepResult>;
  warnings: string[];                      // P1 collector
  notes: string[];                         // P2 collector
  errors: string[];                        // P0 collector
};
```

**State machine**:

```
init ──→ preflight ──→ provision ──→ upgrade-os ──→ reconcile ──→
  gbrain-install ──→ checkpoint-verify ──→ strip-bearer ──→
  cleanup ──→ validate ──→ disk-check ──→ imagize ──→ soak ──→ report

On any P0 failure:
  - Mark current step failed in state
  - Write state to disk
  - If pre-imagize: trigger rollback (destroy bake VM)
  - If post-imagize: keep snapshot, mark as failed, recommend manual review
  - Exit non-zero with structured error
```

**Resume semantics**:
- `--action=resume <run-id>` reads state file, jumps to the failed step, re-runs (steps are designed idempotent — re-running a successful step is a no-op).
- Resume MUST re-validate preconditions before retrying the failed action. If preconditions changed (e.g., the bake VM was destroyed by operator), resume restarts from a sensible earlier step.

### 2.4 Source-of-truth-driven configuration

The orchestrator reads everything at runtime — no hardcoded values:

```typescript
// lib/bake/source-of-truth.ts
export async function readSourcePins(): Promise<SourcePins> {
  const reconcileSrc = readFileSync('lib/vm-reconcile.ts', 'utf-8');
  const manifestSrc = readFileSync('lib/vm-manifest.ts', 'utf-8');

  return {
    gbrain_commit: extractConst(reconcileSrc, 'GBRAIN_PINNED_COMMIT'),
    gbrain_version: extractConst(reconcileSrc, 'GBRAIN_PINNED_VERSION'),
    manifest_version: extractManifestVersion(manifestSrc),
    bootstrap_max_chars: extractConst(manifestSrc, 'BOOTSTRAP_MAX_CHARS'),
    secret_version: extractConst(reconcileSrc, 'SECRET_VERSION'),
    gbrain_partner_allowlist: extractSet(reconcileSrc, 'GBRAIN_PARTNER_ALLOWLIST'),
    // ...
  };
}

export async function detectEnvVarReferences(): Promise<EnvVarRef[]> {
  // grep for process.env.X in vm-reconcile.ts + install-gbrain.sh + ssh.ts
  // Return list of (name, file, line) tuples
}

export async function detectReconcilerStepHash(): Promise<string> {
  // Hash the body of reconcileVM() function. Persist across bakes.
  // Alert if hash changed since last bake.
}
```

The orchestrator's `preflight` step uses these to verify alignment between:
- Pin values in source vs `_pre-bake-check.ts`'s expected values
- Env vars in source vs `.env.local`
- Reconciler step hash vs the hash stored from the last successful bake

If anything has drifted since the last bake, the orchestrator flags it with a remediation hint.

### 2.5 Verification framework

```typescript
type Verification = {
  id: string;
  severity: "P0" | "P1" | "P2";
  description: string;
  check: (ctx: BakeContext) => Promise<{ ok: boolean; detail: string }>;
  remediation?: string;  // what to do if it fails
};

// Reusable check helpers — composable building blocks
export const verifications = {
  envVarSet: (name: string, expected?: string): Verification => ({ ... }),
  fileGrep: (path: string, pattern: RegExp, ssh?: SSHConnection): Verification => ({ ... }),
  sshCommandReturnsExit: (cmd: string, expected: number, ssh: SSHConnection): Verification => ({ ... }),
  linodeInstanceStatus: (id: number, expected: string): Verification => ({ ... }),
  dbRecordExists: (table: string, where: object): Verification => ({ ... }),
  pinMatches: (name: string, expected: string): Verification => ({ ... }),
};
```

Each `BakeStep` declares its preconditions (run before action) and postconditions (run after action). Failures abort the step.

### 2.6 Error handling + rollback

| Failure point | Behavior |
|---|---|
| Preflight P0 fail | Abort. Print failed check + remediation. No VM provisioned. |
| Provision P0 fail | Linode API error. Retry 3× with 30s backoff. If all fail, abort. |
| Upgrade-OS / Reconcile / Gbrain-install / Checkpoint-verify / Strip-bearer / Cleanup / Validate / Disk-check P0 fail | Pre-imagize → rollback path destroys bake VM. State saved for forensics. |
| Imagize P0 fail | Snapshot creation failed in Linode. Bake VM kept running for diagnostic. State saved. |
| Post-imagize (during soak) P0 fail | New snapshot exists but is broken. Do NOT delete bake VM. Recommend manual review + rollback (revert `LINODE_SNAPSHOT_ID` to previous). |
| Soak P0 fail | Same as post-imagize. Snapshot retained for review. |
| Any P1 | Logged to warnings array. Bake proceeds. Reported in final summary. |
| Any P2 | Logged to notes array. Bake proceeds. |

**Rollback module**:

```typescript
// lib/bake/rollback.ts
export async function rollbackBake(state: BakeState): Promise<void> {
  if (state.bake_vm.linode_id) {
    if (state.imagize_completed) {
      // Snapshot exists — don't destroy VM (operator may want to investigate)
      console.log("Bake VM preserved for forensics. Delete manually via Linode CLI.");
    } else {
      // Pre-imagize — safe to destroy
      await linode.deleteInstance(state.bake_vm.linode_id);
    }
  }
  if (state.synthetic_vm_inserted) {
    await sb.from("instaclaw_vms").delete().eq("id", state.synthetic_vm_id);
  }
  await releaseCronLock("reconcile-fleet");
}
```

### 2.7 Future-proofing (drift detection)

The orchestrator catches **structural drift** since the last successful bake:

| Drift type | Detection mechanism | Action |
|---|---|---|
| New env var added to vm-reconcile.ts | Grep for `process.env.X` and compare to known list | Alert: "New env var `X` detected — does it need to be set during bake? Update lib/bake/source-of-truth.ts:KNOWN_ENV_VARS" |
| Pin value changed | Compare current source value to last-bake-recorded value | Alert: "Pin `GBRAIN_PINNED_VERSION` changed: 0.36.3.0 → 0.37.0.0 since last bake. Confirm install-gbrain.sh is compatible." |
| Reconciler step added | Hash of `reconcileVM` function body changed | Alert: "Reconciler orchestrator changed since last bake. New step likely. Re-run preflight." |
| Manifest version bumped | `VM_MANIFEST.version` changed | Auto: the bake proceeds against the current version. Recorded in state. |
| New file in `vm-manifest.ts:files[]` | Diff of files[] entries | Auto: stepFiles handles it during §3.3 reconcile. |
| New script in `scripts/` matching `_*-bake-*` or `install-*.sh` | Glob | Alert: "Possibly bake-relevant script `X` added — review whether it should be in the orchestrator." |

**Last-bake fingerprint** stored at `~/.bake-state/last-bake-fingerprint.json`:

```json
{
  "completed_at": "2026-05-23T14:30:00Z",
  "source_pins": { ... },
  "reconciler_hash": "sha256-abcd...",
  "known_env_vars": ["LINODE_API_TOKEN", "GBRAIN_INSTALL_ENABLED", ...],
  "manifest_files_count": 23,
  "snapshot_id": "private/41234567"
}
```

Each new bake compares against this and reports the delta.

### 2.8 Operator interface (CLI)

```bash
# Full pipeline: preflight → provision → ... → soak → report
npx tsx scripts/_autonomous-bake.ts

# Custom variants
npx tsx scripts/_autonomous-bake.ts --action=full              # default
npx tsx scripts/_autonomous-bake.ts --action=preflight         # just gate checks
npx tsx scripts/_autonomous-bake.ts --action=dry-run           # simulate everything; no state mutation
npx tsx scripts/_autonomous-bake.ts --action=resume <run-id>   # resume failed run
npx tsx scripts/_autonomous-bake.ts --action=status <run-id>   # print current state
npx tsx scripts/_autonomous-bake.ts --action=rollback <run-id> # destroy VM, clean up state
npx tsx scripts/_autonomous-bake.ts --action=list              # list recent runs

# Options
--label=<custom>          # custom snapshot label (default: instaclaw-base-v<N>-<date>)
--region=us-east          # Linode region (default: us-east)
--skip-soak               # skip soak phase (faster but riskier)
--soak-duration=1h        # soak duration (default: 1h)
--auto-confirm            # don't prompt; useful for CI
--bake-from=<snapshot>    # override LINODE_SNAPSHOT_ID source
```

**Output format** (stdout):

```
══ Autonomous Bake — run 2026-05-23T14:00:00Z ══

[preflight] ────────────────────────────────────
  ✓ HEAD aligned with origin/main
  ✓ Pin alignment: GBRAIN_PINNED_COMMIT=1d5f69f matches lib/vm-reconcile.ts:136
  ✓ Pin alignment: GBRAIN_PINNED_VERSION=0.36.3.0 matches lib/vm-reconcile.ts:137
  ✓ Manifest version: 106 (read from VM_MANIFEST.version)
  ✓ V106 landing path: A (stepDeployGbrainSoulRouting present)
  ✓ Linode reachable (account: ...)
  ✓ Supabase reachable
  ✓ env-vars present (12 required, 12 found)
  ⚠ P1: gbrain edge_city coverage 8/9 — vm-923 missing gbrain (see Cooper-action #4)
  ✓ No P0/P1 alerts in 24h

[provision] ────────────────────────────────────
  → Creating linode instance: label=snapshot-bake-v106-2026-05-23, region=us-east, type=g6-nanode-1, image=private/38575292
  → linode_id=58234567 created, status=provisioning
  → polling: status=running (after 67s)
  → polling: SSH ready (after 92s — host keys regenerated)
  → bake_vm.ip_address=172.105.83.114

[upgrade-os] ─────────────────────────────────────
  ...
```

If any P0 fails:

```
✗ [reconcile] auditVMConfig returned errors:
    - npm-pin-drift: openclaw module install failed (exit 1)
    - <full error detail>
  
  ⚠ ABORTING — pre-imagize step failed
  
  Rollback:
    - Bake VM linode_id=58234567 will be destroyed
    - Synthetic VM record will be removed from instaclaw_vms
    - reconcile-fleet cron lock will be released
  
  Run rollback? [y/N] (or --action=rollback to skip prompt)
```

### 2.9 Test strategy

| Layer | Test type | Tooling |
|---|---|---|
| Unit | Each verification helper (envVarSet, fileGrep, etc.) | Vitest; synthetic inputs |
| Integration | Each step's action against a mocked SSH/Linode/Supabase | Vitest + mocks |
| Live | Full bake against a Linode test account / staging Supabase | Manual; `--action=dry-run` first |
| Smoke | After successful bake, run `_postbake-validation.ts --mode=test` against a fresh VM from new image | Already exists |

**Self-test mode** (`--action=self-test`): runs the orchestrator's verification logic against the CURRENT production fleet's state, not against a bake VM. This catches:
- Orchestrator code that has its own bugs (e.g., regex doesn't match real pin values)
- New env vars / pins / reconciler steps that the orchestrator doesn't know about
- Drift since the last bake

Run weekly via cron or before each bake.

---

## Phase 3: Implementation plan

### 3.1 Files to create

**Orchestrator** (P0 — minimum viable):
- `scripts/_autonomous-bake.ts` (~600 lines) — main entry point, state machine, step runner

**Library modules** (P0):
- `lib/bake/linode-api.ts` (~250 lines) — Linode API client wrapper (provision, shutdown, imagize, poll, delete)
- `lib/bake/state.ts` (~150 lines) — BakeState persistence + resume
- `lib/bake/step-spec.ts` (~100 lines) — BakeStep + BakePhase types + helpers
- `lib/bake/verifications.ts` (~200 lines) — reusable verification helpers
- `lib/bake/source-of-truth.ts` (~150 lines) — runtime pin/manifest/env-var extraction

**Library modules** (P0 — gap-fillers):
- `lib/bake/synthetic-vm.ts` (~80 lines) — construct + insert + cleanup the synthetic VM record for §3.3 reconcile
- `lib/bake/strip-bearer.ts` (~120 lines) — §3.6 automation (replaces manual EOF block)
- `lib/bake/checkpoint-verify.ts` (~80 lines) — §3.5.5 automation (5 checks + trial CHECKPOINT)
- `lib/bake/v106-detect.ts` (~50 lines) — §2.6.6 Path A vs B detection
- `lib/bake/vercel-env-audit.ts` (~100 lines) — Family C Vercel-side check via `vercel env ls production`

**Tests** (P1):
- `scripts/_test-autonomous-bake.ts` — synthetic test harness (mock Linode/SSH/Supabase)

**Total new code estimate**: ~1,900 lines TypeScript. Most of which is plumbing around existing scripts.

### 3.2 Files to modify

**Light touches** (P0):
- `scripts/_pre-bake-check.ts` — add `--json` flag for orchestrator consumption (parseable result instead of stdout text)
- `scripts/_postbake-validation.ts` — already has `--mode=bake|test`; add `--json` flag
- `instaclaw/docs/snapshot-bake-v105-checklist.md` — add §0.1 "Quickstart: autonomous bake" pointing at the new orchestrator; demote the manual walk to "advanced/recovery" section
- `instaclaw/docs/snapshot-bake-runbook.md` — same demote

**No changes**:
- `_prebake-cleanup.sh` (already CLI-friendly)
- `install-gbrain.sh` (already CLI-friendly)
- `lib/vm-reconcile.ts` (no changes — orchestrator wraps it)
- `lib/vm-manifest.ts` (no changes)
- `lib/ssh.ts` (no changes)

### 3.3 Order of operations (full bake walkthrough)

```
1. preflight
   1.1 Read source pins (lib/bake/source-of-truth.ts)
   1.2 Run _pre-bake-check.ts --json
       ├─ Critical fails → abort
       └─ Warnings collected
   1.3 Verify env-vars (Family A bake-tooling)
   1.4 Detect v106 landing path (lib/bake/v106-detect.ts)
   1.5 Audit Vercel prod env (lib/bake/vercel-env-audit.ts)
   1.6 Detect drift since last bake (env vars / pins / reconciler hash)
   1.7 Print plan + (unless --auto-confirm) prompt operator

2. provision
   2.1 Linode API: POST /v4/linode/instances (g6-nanode-1, image=LINODE_SNAPSHOT_ID)
   2.2 Poll status=running (60-90s)
   2.3 Poll SSH ready (host keys regenerated)
   2.4 Insert synthetic VM record into instaclaw_vms (id=bake-vm-<run-id>, partner=null)

3. upgrade-os
   3.1 SSH: source NVM, npm install -g openclaw@latest
   3.2 SSH: apt-mark hold nodejs

4. reconcile
   4.1 Acquire reconcile-fleet cron lock (4h TTL)
   4.2 Call auditVMConfig({ id: synthetic, ip_address: bake_vm_ip, partner: null, ... }, { strict: true })
   4.3 Verify errors=[] strictErrors=[]
   4.4 Verify gateway-restart succeeded (if needed)

5. gbrain-install
   5.1 SCP install-gbrain.sh + verify-gbrain-mcp.py + pglite-checkpoint.sh + gbrain-patches/*.patch
   5.2 SSH invoke: GBRAIN_PINNED_COMMIT=<from-source> GBRAIN_PINNED_VERSION=<from-source> bash /tmp/install-gbrain.sh
   5.3 Verify stdout contains: PHASE_A_OK PHASE_B_OK PHASE_C_OK PHASE_C2_OK PHASE_D_OK PHASE_E_OK PHASE_F_OK PHASE_G_OK PHASE_H_OK PHASE_I_OK INSTALL_COMPLETE
   5.4 Verify gbrain.service active + port 3131 listening

6. checkpoint-verify (NEW per §3.5.5)
   6.1 Verify ~/gbrain/src/core/checkpoint-operation.ts exists
   6.2 Verify ~/gbrain/src/core/operations.ts references checkpoint
   6.3 Verify crontab has pglite-checkpoint entry
   6.4 Verify ExecStop drop-in at ~/.config/systemd/user/gbrain.service.d/20-execstop-checkpoint.conf
   6.5 Verify pglite-checkpoint.sh executable
   6.6 Trial CHECKPOINT call returns "ok latency_ms=<N>"

7. v102-protocol-verify (NEW per §2.6)
   7.1 Verify ~/.openclaw/workspace/AGENTS.md has GBRAIN_MEMORY_PROTOCOL_V1 marker (count=2)
   7.2 Verify AGENTS.md size grew from baseline (sanity check)
   7.3 Verify Rule 28 anti-hallucination directive present

8. strip-bearer (NEW per §3.6)
   8.1 SSH: CHECKPOINT via direct PGLite
   8.2 SSH: systemctl --user kill --signal=SIGKILL gbrain.service
   8.3 SSH: systemctl --user stop gbrain.service
   8.4 SSH: DELETE access_tokens + final CHECKPOINT
   8.5 SSH: DELETE pages WHERE slug='_gbrain-install-verify' + CHECKPOINT
   8.6 SSH: rm -f ~/.gbrain/openclaw-bearer-token.txt
   8.7 SSH: systemctl --user disable gbrain.service
   8.8 SSH: jq 'del(.mcp.servers.gbrain)' openclaw.json (atomic write)
   8.9 Verify: bearer file absent, mcp entry absent, service inactive + disabled, access_tokens count=0

9. cleanup
   9.1 SCP _prebake-cleanup.sh
   9.2 SSH: touch ~/.snapshot-bake-mode
   9.3 SSH: bash _prebake-cleanup.sh --dry-run (capture output to log)
   9.4 SSH: sudo -v && bash _prebake-cleanup.sh --confirm
   9.5 Verify exit code 0

10. validate
    10.1 SCP _postbake-validation.ts
    10.2 SSH: npx tsx _postbake-validation.ts --vm-ip=$BAKE_VM_IP --mode=bake --json
    10.3 Parse JSON: all P0 must pass; P1/P2 logged
    10.4 If any P0 fail: abort + recover

11. disk-check
    11.1 SSH: df --output=used / | tail -1
    11.2 Must be < 5,900 MB (target) and < 6,144 MB (hard cap)
    11.3 If over: abort + suggest additional cleanup

12. imagize
    12.1 Release reconcile-fleet cron lock
    12.2 Linode API: POST /v4/linode/instances/<id>/shutdown
    12.3 Poll status=offline (30-90s)
    12.4 Linode API: GET /v4/linode/instances/<id>/disks → find ext4 disk
    12.5 Linode API: POST /v4/images { disk_id, label, description }
    12.6 Poll: GET /v4/images/<new_id> until status=available (5-10 min)
    12.7 Capture new image ID; persist to state

13. soak
    13.1 Linode API: provision NEW VM from new image (g6-nanode-1)
    13.2 Wait status=running + SSH ready
    13.3 Insert synthetic VM record
    13.4 Call auditVMConfig (this VM should converge in <60s — most steps no-op)
    13.5 SCP + SSH: npx tsx _postbake-validation.ts --vm-ip=$SOAK_VM_IP --mode=test --bake-vm-fingerprint=<from earlier> --json
    13.6 All P0 must pass
    13.7 Delete soak VM + synthetic record

14. report
    14.1 Print summary: passed steps, warnings, notes, total time
    14.2 Output Vercel env update commands (operator runs):
         printf 'private/<new_id>' | npx vercel env add LINODE_SNAPSHOT_ID production
         (and similar for any rotated secrets)
    14.3 Output cleanup commands (delete bake VM, archive state file)
    14.4 Persist last-bake-fingerprint.json
    14.5 Exit 0
```

### 3.4 What stays manual and why

| Item | Why manual | What the orchestrator does instead |
|---|---|---|
| Anthropic $300/mo cap | Cooper-only access to console.anthropic.com | Preflight `cooperActionReminders` includes a checklist item |
| Vercel env update post-soak | Rule 6 — Cooper retains `printf` discipline; Vercel CLI auth is per-user | Orchestrator outputs the exact `printf '<value>' \| npx vercel env add <name> production` commands |
| v106 PR landing | Gbrain terminal owns | Orchestrator auto-detects Path A vs B and adapts |
| Snapshot retention (delete old after 1 week) | Operator judgment + audit value | Orchestrator outputs a "delete-after" timestamp in the report |
| Customer-facing announcement | Strategic / partner-coordination | n/a |

---

## Research

### Industry patterns

**HashiCorp Packer** — declarative HCL/JSON spec → builds AMIs/snapshots. Key concepts borrowed:

- **Builders + provisioners + post-processors**: each step has a defined role. Our equivalent: BakeStep with phase classification.
- **Communicator pattern** (SSH/WinRM): consistent interface to remote machine. We already have `connectSSH` in `lib/ssh.ts`.
- **Provisioner retries with backoff**: industry standard. Add to orchestrator's Linode API calls.
- **Manifest output**: produce a JSON manifest of what was built. Mirror with our `last-bake-fingerprint.json`.
- **`packer validate` before run**: syntax-check the spec without actually building. Our equivalent: `--action=dry-run`.

Why we DON'T adopt Packer directly:
- Our existing scripts (4.2K lines) are tightly coupled to TypeScript + Supabase + our custom reconciler. Wrapping them as Packer provisioners adds a layer without removing complexity.
- Packer is generic; we have specific knowledge (synthetic VM record, reconcile-fleet cron lock, Phase I CHECKPOINT verification) that's easier to express in TypeScript.
- Single-cloud (Linode) — Packer's multi-cloud abstraction is unused weight.

**AWS EC2 Image Builder** — pipeline-based, similar to Packer. Not applicable (different cloud).

**Cloud-init testing** — we already use cloud-init for boot setup. `systemd-analyze` for validation. Our `_postbake-validation.ts` §25 checks cloud-init state cleared.

**Docker buildkit** — layer-based caching. Not applicable for OS-level images. But the "atomic commit" pattern (build is reversible until you tag) is borrowed: bake VM destroyed if pre-imagize fails.

**Vagrant** — dev-image-focused, less relevant.

**Kubernetes image pipelines** (e.g., Spinnaker) — too heavy. Single-snapshot-per-month doesn't justify the infrastructure.

**Our pattern (after design)** — TypeScript orchestrator + idempotent steps + verification gates + state persistence. Closest analog: Packer in spirit, lightweight in execution.

### Linode API gotchas

Documented quirks to handle in `lib/bake/linode-api.ts`:

| Gotcha | Behavior | Handling |
|---|---|---|
| Image creation is **async** | POST /v4/images returns 200 with id, but actual prep is async. Failures silently delete the image. | Poll `GET /v4/images/<id>` for status=available. Treat 404 as failure (image was rejected and deleted). |
| **6,144 MB disk size hard cap** | Imagize fails if disk exceeds. Failure mode: image rejected during async prep, 404 on poll. | Pre-imagize check: `df --output=used /` must report < 5,900 MB. |
| Concurrent image limit per account | Linode caps images-in-progress per account. Exceeding returns 4xx. | Pre-flight check: query `/v4/images?page=1&page_size=100` for any with status=creating. Wait or abort. |
| **Shutdown must complete before imagize** | If you POST /v4/images on a running disk, fails. | Poll `GET /v4/linode/instances/<id>` for status=offline. |
| Image label uniqueness | Labels must be unique within account. Reuse fails. | Generate label with timestamp: `instaclaw-base-v106-2026-05-23-1430-utc`. |
| Disk ID changes per VM | `/v4/linode/instances/<id>/disks` returns multiple disks (swap + ext4). | Filter by `filesystem === "ext4"`. |
| **Linode region for image storage** | Images are tied to a region. Provisioning from an image in a different region requires a clone (extra time). | Bake in same region as production (us-east). |
| Account-level image storage quota | Linode has limits on total private image storage. | Pre-flight check: `GET /v4/images` count + recommend deleting > 1-week-old images. |
| **Rate limits** | API rate-limits at 800 req/min per token. | Plenty for bake-time use. No special handling needed. |
| Cloud-init regeneration | On first boot from a snapshot, cloud-init re-runs the regeneration phase (SSH host keys, machine-id). Takes ~30-60s. | Poll SSH ready in the provision step. |
| `tags` field | Used to label instances. Useful for filtering bake VMs. | Always tag bake VMs with `["instaclaw", "snapshot-bake", "auto"]`. |

---

## Decision matrix — Cooper's call vs determined from code

| Decision | Who | My recommendation |
|---|---|---|
| Build now or wait until post-Esmeralda | **Cooper** | **Post-Esmeralda** (June first week). May 23 bake uses the existing manual checklist (already updated to v106) as a backstop. Don't rush a new automation system into Esmeralda window. |
| Auto-cutover after soak passes | **Cooper** | **Manual** — Vercel env is the prod gate. Orchestrator outputs commands; Cooper runs `printf`. |
| Auto-delete bake VM on success | Determined | **Yes** — saves $. Snapshot retains the state. |
| Auto-delete bake VM on failure | Determined | **Pre-imagize: yes. Post-imagize: no** (operator may want to investigate). |
| Soak duration | **Cooper** | **1h synthetic test** for the orchestrator's `--action=full` default. **24h human-monitored** for production cutover (separate gate, operator-driven). |
| Resume policy (after failure) | Determined | **Re-run failed step** (idempotent steps no-op). Operator can `--action=rollback` to abort. |
| Notification on failure | **Cooper** | Start with **exit non-zero + stderr + state file**. Add email/Slack later if needed. |
| Multi-region bake | **Cooper** | **No** — bake in us-east only. If we ever ship to a second region, address then. |
| Bake from prod main vs feature branch | **Cooper** | **main only** (Rule 12 already enforced). Orchestrator refuses if HEAD ≠ origin/main. |
| Capture `gbrain` Anthropic spend in preflight | Determined | **Yes** — orchestrator can query Anthropic API for current month's spend (if API allows). P1 add. |
| Self-test cron (weekly drift detection) | **Cooper** | **Yes** — adds it to vercel.json crons. Catches new env vars / pins / steps before the next bake. P1. |
| Migrate `provision-batch.ts` to use the orchestrator's Linode API helper | Determined | **Yes** — they share patterns. Refactor opportunity. P2. |

---

## Implementation phases (P0 / P1 / P2)

**P0 — minimum viable autonomous bake** (target: 1 engineer-week)

1. `lib/bake/linode-api.ts` — Linode operations
2. `lib/bake/state.ts` — state persistence + resume
3. `lib/bake/source-of-truth.ts` — runtime pin/manifest reading
4. `lib/bake/step-spec.ts` + `lib/bake/verifications.ts` — framework
5. `lib/bake/synthetic-vm.ts` — §3.3 helper
6. `lib/bake/strip-bearer.ts` — §3.6 automation
7. `lib/bake/checkpoint-verify.ts` — §3.5.5 automation
8. `lib/bake/v106-detect.ts` — §2.6.6 path detect
9. `scripts/_autonomous-bake.ts` — main orchestrator
10. Light touches to `_pre-bake-check.ts` + `_postbake-validation.ts` (`--json` output)
11. Run a live dry-run against existing snapshot
12. Run a live full bake; compare snapshot against May 23 manual bake

Exit criteria: one full bake completes end-to-end without human intervention.

**P1 — operational hardening** (target: 1 additional engineer-week, post-Esmeralda)

1. `lib/bake/vercel-env-audit.ts` — Family C check
2. `scripts/_test-autonomous-bake.ts` — synthetic test harness
3. Drift detection (last-bake-fingerprint persistence + delta detection)
4. Self-test cron (weekly)
5. Linode storage quota check (image count + total size)
6. Resume semantics tested for every step
7. Rollback paths tested for every step
8. Documentation: archive snapshot-bake-v105-checklist.md as `legacy/`; create `snapshot-bake-quickstart.md` pointing at the orchestrator

Exit criteria: drift in source pins / env vars / reconciler steps is caught BEFORE the bake fails.

**P2 — nice-to-haves** (target: when bandwidth)

1. Anthropic API spend query in preflight
2. Email/Slack notification on completion
3. Multi-region bake support (if ever needed)
4. `provision-batch.ts` Linode migration
5. Soak duration parameter + delayed cutover
6. Bake VM "warm pool" (pre-provisioned ready VMs that can be promoted to bake VM faster)
7. Automated old-snapshot deletion (delete snapshots > 1 week old that aren't `LINODE_SNAPSHOT_ID`)

---

## Open questions for Cooper

1. **Build now or post-Esmeralda?** My strong rec: **post-Esmeralda**. The May 23 bake uses the manual checklist (just hardened today). Building autonomous infra under Esmeralda time pressure is the recipe for a buggy P0. Post-Esmeralda, do it deliberately.

2. **Soak duration default?** Synthetic 1h is enough for the orchestrator to validate. Production cutover should still have a human-driven 24h soak. My rec: **two phases — `--action=full` runs 1h synthetic soak, `--action=cutover` is a separate manual call after Cooper's 24h confidence window.**

3. **Where does the bake state live?** `~/.bake-state/<run-id>/` is operator-local. If Cooper wants multi-operator coordination, persist to S3/Supabase. My rec: **start local; add cloud sync as P2 if/when relevant.**

4. **What's the rollback story for a failed cutover?** If the new snapshot ships to Vercel and turns out to be broken (e.g., produces a VM that fails first reconcile), how do we revert?
   - Vercel env rollback: `printf '<old_snapshot_id>' | npx vercel env add LINODE_SNAPSHOT_ID production` + redeploy.
   - Already documented in `snapshot-bake-v105-checklist.md` §6.
   - Orchestrator outputs this command pre-emptively so Cooper has it ready.

5. **Should the orchestrator read the checklist doc itself and verify each checkbox?** Interesting idea but probably over-engineering. The orchestrator's step list IS the source of truth for execution; the checklist becomes the human-readable reflection. If they drift, code wins.

6. **What happens during gbrain pin bumps mid-bake?** If the gbrain terminal bumps `GBRAIN_PINNED_VERSION` between preflight and gbrain-install steps:
   - Preflight captured the old value into state.
   - gbrain-install uses the captured value (not re-read).
   - On next bake, preflight catches the drift.
   - This is the right behavior — a bake is a point-in-time artifact.

7. **What if `auditVMConfig` introduces a new error class not in `errors[]` or `strictErrors[]`?** Right now the §3.3 gate checks both arrays. If a new error class is added (e.g., `result.criticalErrors`), the gate misses it. Mitigation: orchestrator should also fail if `r.success !== true` or if any non-empty `result.*` array exists outside the known list.

8. **Should `_autonomous-bake.ts` be runnable from a Vercel function?** No — Linode operations + SSH require persistent state and long timeouts. Run from operator's machine.

---

## Confidence assessment

| Component | Confidence | Why |
|---|---|---|
| Architecture | HIGH | Pattern is well-established (Packer-style); thin layer over proven scripts |
| Step taxonomy | HIGH | Maps 1:1 to existing checklist sections |
| Source-of-truth reading | MEDIUM | Regex extraction of pin values works but is fragile to refactors; backup: dynamic `import` of TS files |
| Verification framework | HIGH | Reuses `_pre-bake-check.ts` + `_postbake-validation.ts` patterns |
| Linode API | HIGH | Reference patterns in `provision-clob-proxy.sh` + `_audit-freeze-zombies.ts` |
| Synthetic VM record | MEDIUM | `auditVMConfig` accepts the synthetic record per the §3.3 inline TS, but edge cases (e.g., what if synthetic record violates a DB constraint?) need testing |
| Strip-bearer automation | HIGH | Direct port of the existing manual EOF block |
| Resume semantics | MEDIUM | Step idempotency claims need to be tested for every step. The reconcile step is naturally idempotent (it re-runs all sub-steps and no-ops on already-correct). gbrain-install is idempotent via Phase A early-exit. But §3.6 strip-bearer is NOT naturally idempotent (DELETE access_tokens is fine, but the `disable gbrain.service` step would fail if service is already disabled). Need per-step idempotency review. |
| Drift detection | HIGH | Hash + diff against last-bake-fingerprint is straightforward |
| Linode imagize gotchas | HIGH | Documented gotchas covered |
| Test strategy | MEDIUM | Unit tests are easy; full integration test against Linode is expensive (~$0.10/bake). Maybe one staging bake per month. |
| Documentation drift | LOW | Checklist + runbook + design doc need to stay in sync. Mitigation: orchestrator is source of truth; docs reflect; weekly diff alert. |

**Recommended next action**: Cooper reviews this doc. Resolves Q1-Q8. If go for post-Esmeralda build, I (or any terminal) writes P0 starting first week of June.

---

## What this protects

After implementation, the following risk classes are eliminated or reduced to near-zero:

| Risk | Today | Post-autonomous-bake |
|---|---|---|
| Operator forgets to set env var | High (just happened on §2.6.5) | Zero (orchestrator checks at preflight) |
| Operator uses stale pin value | High (just caught a stale `baf1a47` reference) | Zero (orchestrator reads live from source) |
| Operator skips a checklist step | High (38 checkboxes) | Zero (orchestrator runs every step) |
| New reconciler step added without updating bake | High (no detection today) | Low (drift detection alerts) |
| New env var added without updating bake | High | Low (drift detection alerts) |
| Bake VM not destroyed after failure | Low (operator notices Linode bill) | Zero (rollback path runs automatically) |
| Bake VM not destroyed after success | Medium (operator forgets) | Zero (auto-delete in report phase) |
| Imagize fails silently (Linode 404 quirk) | Medium | Zero (orchestrator polls + retries + alerts) |
| Disk over 6,144 MB cap | Medium | Zero (disk-check step aborts) |
| Manual EOF block executes wrong commands | Medium | Zero (replaced by tested TS code) |
| Vercel env unset / wrong | Low (Cooper checks manually) | Zero (orchestrator outputs the exact `printf` commands) |
| v106 contingency confusion | Medium | Zero (auto-detected) |
| Soak skipped or done wrong | Medium | Zero (synthetic soak built in) |

The system becomes **fire-and-forget** with **machine-checked correctness at every transition**. The human attention budget shifts from "did I remember every step?" to "what does the orchestrator's go/no-go report say?"

That's the protection.
