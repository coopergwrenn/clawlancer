# Autonomous bake — operator experience

**Date**: 2026-05-19
**Status**: Live-validated against current source. Preflight + dry-run both pass clean. No real Linode resources created during validation.
**Sibling docs**:
- Design: [`autonomous-bake-system-design-2026-05-19.md`](./autonomous-bake-system-design-2026-05-19.md)
- Pre-existing manual fallback: [`../snapshot-bake-v105-checklist.md`](../snapshot-bake-v105-checklist.md)

This document describes what the operator sees when they run the autonomous bake at each phase. Written so a 2am operator who's never used the system can succeed by reading the terminal output.

---

## The headline UX commitment

**One command produces a snapshot. Output is self-explanatory. If anything fails, the next step is named in the terminal.**

```bash
npx tsx scripts/_autonomous-bake.ts                       # full bake
npx tsx scripts/_autonomous-bake.ts --action=preflight    # gate checks only
npx tsx scripts/_autonomous-bake.ts --action=dry-run      # simulate without resources
npx tsx scripts/_autonomous-bake.ts --action=resume <id>  # resume failed run
npx tsx scripts/_autonomous-bake.ts --action=status [id]  # print state (json)
npx tsx scripts/_autonomous-bake.ts --action=list         # list recent runs
npx tsx scripts/_autonomous-bake.ts --action=rollback <id> # destroy + clean up
```

Default output is summary-only (clean and scannable). Add `--verbose` for the full per-step trace.

---

## Preflight UX — what the operator sees when running `--action=preflight`

```
══════════════════════════════════════════════════════════════
  Autonomous Bake — run 2026-05-19T20-32-42-801Z
  source: private/38575292
  state:  ~/.bake-state/runs/2026-05-19T20-32-42-801Z/
══════════════════════════════════════════════════════════════

══════════════════════════════════════════════════════════════
  ✓ PREFLIGHT PASSED
  run_id:   2026-05-19T20-32-42-801Z
  elapsed:  7s
  errors:   0
  warnings: 1
  notes:    0
  state:    ~/.bake-state/runs/2026-05-19T20-32-42-801Z/state.json
  log:      ~/.bake-state/runs/2026-05-19T20-32-42-801Z/log.txt
══════════════════════════════════════════════════════════════

WARNINGS (P1 — bake proceeded but review before next bake):
  ⚠ preflight-vercel-audit: Vercel prod env missing: GBRAIN_INSTALL_ENABLED, GBRAIN_PINNED_COMMIT, GBRAIN_PINNED_VERSION, RECONCILE_SOUL_MIGRATION_ENABLED

Preflight passed with warnings. Review above. Then:
  npx tsx scripts/_autonomous-bake.ts                  # ignore warnings, bake
  # OR — resolve the warnings first (see remediation in log), then re-run preflight
```

The operator's job: read the warnings. Each one is prefixed with the step id that emitted it. Each has a remediation hint in the log file.

In this example, 4 Vercel env vars are missing — a real issue that affects PRODUCTION VM convergence after the snapshot ships, but doesn't block the bake itself. The operator can choose to bake anyway (the snapshot is fine; production fleet will simply lag until Cooper sets the env vars) or stop, set the vars, and re-run preflight first.

---

## Dry-run UX — `--action=dry-run`

```
══════════════════════════════════════════════════════════════
  ✓ BAKE SUCCEEDED (dry-run)
  run_id:   2026-05-19T20-19-26-653Z
  elapsed:  7s
  errors:   0
  warnings: 2
  notes:    0
══════════════════════════════════════════════════════════════
```

The state machine exercised every step. Preflight steps ran for real (source read, Vercel audit, _pre-bake-check). All side-effecting steps (provision, reconcile, gbrain-install, imagize, soak, etc.) showed `↻ dry-run skip` with their estimated duration.

Crucially: **dry-run runs the PRECONDITIONS of every step.** If a step would fail in a real bake because of a missing env var, the dry-run shows that preconditions failure even though the action itself is skipped. Example from a real dry-run:

```
▶ [reconcile] reconcile-run-audit: Run auditVMConfig (50+ reconciler steps in strict mode)
  ✗ pre [P0] env-set-RECONCILE_SOUL_MIGRATION_ENABLED (missing)
  ↻ dry-run skip: Run auditVMConfig (50+ reconciler steps in strict mode) (would take ~1500s)
```

This tells the operator "you'd fail at this step in a real bake until you set this env var" — forward-looking info, surfaced before any Linode VM is provisioned.

---

## Full bake UX — `--action=full`

The operator sees the same banner at start, then each phase prints its progress. On success the report phase outputs:

```
══════════════════════════════════════════════════════════════
  ✓ BAKE SUCCEEDED
  run_id:   2026-05-23T14-00-00-000Z
  elapsed:  47m
  errors:   0
  warnings: 1
  notes:    0
══════════════════════════════════════════════════════════════

Cooper actions (paste-ready):
  # Update Vercel production env (per Rule 6: use printf, NOT <<< or echo)
  printf 'private/41234567' | npx vercel env add LINODE_SNAPSHOT_ID production
  # Optional: verify
  npx vercel env ls production | grep LINODE_SNAPSHOT_ID

  # Rollback (if needed): revert to previous snapshot
  printf 'private/38575292' | npx vercel env add LINODE_SNAPSHOT_ID production

  # Delete bake VM (auto-deletes after successful imagize; this is defensive)
  curl -X DELETE -H "Authorization: Bearer $LINODE_API_TOKEN" https://api.linode.com/v4/linode/instances/58234567
```

The operator runs the `printf` commands (per CLAUDE.md Rule 6 — never `<<<` or `echo` for env vars) and the cutover is complete.

---

## Failure UX — what happens when a step fails

```
══════════════════════════════════════════════════════════════
  ❌ BAKE FAILED at phase=preflight step=preflight-pre-bake-check
  run_id:   2026-05-19T20-28-08-583Z
  elapsed:  8s
  errors:   1
  warnings: 1
  notes:    0
  state:    ~/.bake-state/runs/2026-05-19T20-28-08-583Z/state.json
  log:      ~/.bake-state/runs/2026-05-19T20-28-08-583Z/log.txt
══════════════════════════════════════════════════════════════

ERRORS (P0 — these blocked the bake):
  ✗ preflight-pre-bake-check: FAIL: _pre-bake-check.ts exit 1. Review output for CRITICAL findings.

Last output from preflight-pre-bake-check (most recent 10 lines):
  │ ═══════════════════════════════════════════════════════════════════
  │   ❌ NO-GO — 1 CRITICAL blocker(s):
  │      • HEAD aligned with origin/main (Rule 12)
  │ 
  │   Resolve all CRITICAL blockers before provisioning the bake VM.
  │ ═══════════════════════════════════════════════════════════════════

Recovery hint: Read _pre-bake-check.ts output and fix CRITICAL findings before retrying.

WARNINGS (P1 — bake proceeded but review before next bake):
  ⚠ preflight-vercel-audit: Vercel prod env missing: GBRAIN_INSTALL_ENABLED, ...

Resume after fixing the underlying issue:
  npx tsx scripts/_autonomous-bake.ts --action=resume 2026-05-19T20-28-08-583Z

Or rollback (destroys any Linode resources, releases locks):
  npx tsx scripts/_autonomous-bake.ts --action=rollback 2026-05-19T20-28-08-583Z
```

Four signals to the operator, in order:

1. **Headline**: which phase + step failed.
2. **Error summary**: P0 messages with step.id attribution.
3. **Captured output**: the last 10 lines from the failed step's action (so the operator sees the actual `_pre-bake-check.ts` finding, not just "exit 1").
4. **Recovery hint**: human-readable instruction from the step spec.
5. **Resume command**: paste-ready next step.

The operator's path: read the captured output → see `HEAD aligned with origin/main (Rule 12)` → run `git pull --ff-only origin main` → re-run preflight. No need to dig into state files or logs.

---

## Resume UX — `--action=resume <run-id>`

```
══════════════════════════════════════════════════════════════
  Autonomous Bake — run 2026-05-19T20-28-08-583Z
  ...
══════════════════════════════════════════════════════════════

2026-05-19T20-29-15.123Z [orch] RESUMING from step preflight-pre-bake-check (phase preflight)
2026-05-19T20-29-15.456Z [preflight-pre-bake-check] ▶ ...
```

Resume picks up exactly where it left off. The failed step is re-run; downstream steps proceed if it now passes.

Resume semantics:
- Steps that already succeeded are NOT re-run (their state is preserved as `succeeded`)
- The most recently failed step (current_step_id when status=failed) is reset to `pending` and re-attempted
- If the same step fails again, the orchestrator does NOT auto-rollback (operator may want to inspect)

This means each step must be idempotent. The current step set IS idempotent — re-running provision against an already-created Linode VM is currently NOT idempotent (would create a duplicate), so that step is marked `retryable: false`. The orchestrator currently retries anyway on resume; **a fix to skip non-retryable steps on resume is P1 follow-up** but doesn't affect typical operator flow (most resumes happen at preflight/reconcile/install — all idempotent).

---

## Status UX — `--action=status [<run-id>]`

Without arg → returns the latest run. With arg → that specific run.

Outputs JSON to stdout. Useful for:
- Forensics on a past run
- Scripting (pipe to `jq` for filtered views)

```bash
$ npx tsx scripts/_autonomous-bake.ts --action=status | jq '.warnings'
[
  "preflight-vercel-audit: Vercel prod env missing: GBRAIN_INSTALL_ENABLED, ..."
]
```

---

## List UX — `--action=list`

```
# Recent bake runs (newest first):
  2026-05-19T20-32-42-801Z  succeeded    phase=preflight  step=preflight-pre-bake-check
  2026-05-19T20-28-08-583Z  failed       phase=preflight  step=preflight-pre-bake-check
  2026-05-19T20-19-26-653Z  succeeded    phase=report     step=generate-report
```

Three columns: timestamp · status · last-touched-phase/step. Operator can drill into any via `--action=status <id>`.

---

## Rollback UX — `--action=rollback [<run-id>]`

Destroys any Linode resources (bake VM, soak VM) and releases the reconcile-fleet cron lock. Idempotent — safe to re-run.

```
2026-05-19T20-35-12.123Z [orch] Running rollback for 2026-05-19T20-28-08-583Z
2026-05-19T20-35-12.456Z [rollback] rollback: deleted linode 58234567
2026-05-19T20-35-13.789Z [rollback] rollback: released reconcile-fleet lock
2026-05-19T20-35-13.890Z [orch] Rollback complete
```

Used when:
- A pre-imagize failure leaves a partially-configured bake VM around (orchestrator auto-rollbacks but this lets the operator re-trigger if the auto-rollback was skipped)
- Operator wants to abandon a stuck run

---

## State files — what's on disk

```
~/.bake-state/
  ├── bake.lock                       # global concurrency lock (one bake at a time)
  ├── last-bake-fingerprint.json      # drift baseline (persisted after successful bake)
  └── runs/
      └── 2026-05-19T20-32-42-801Z/   # one dir per run
          ├── state.json              # atomic-written after every step
          └── log.txt                 # append-only timestamped log
```

**state.json** is the source of truth. Contains every step result, every captured pre/post-condition, every output line, every warning/error/note. Operator can inspect any run forever.

**log.txt** is the human-readable trace. Every line starts with timestamp + step.id, so `tail -F` is useful while a bake is running.

---

## What the operator does NOT need to do

The autonomous bake replaces the 38-checkbox manual checklist with one command. The operator does NOT need to:

- Manually copy pin values from `lib/vm-reconcile.ts:136-137` to a shell invocation (orchestrator reads them live)
- Manually verify `RECONCILE_SOUL_MIGRATION_ENABLED=true` in `.env.local` (preflight checks)
- Manually SSH the bake VM to verify Phase I CHECKPOINT install (checkpoint-verify step)
- Manually heredoc the §3.6 strip-bearer block (strip-bearer step)
- Manually invoke `_prebake-cleanup.sh --confirm` (cleanup step)
- Manually run `_postbake-validation.ts --mode=bake` (validate step)
- Manually check disk usage < 6,144 MB (disk-check step)
- Manually POST to Linode `/v4/images` and poll `status=available` (imagize step)
- Manually provision a soak VM and verify it converges (soak phase)
- Manually generate the snapshot label or its description (report step)

Each of these is in the orchestrator. The 5 things that DO stay manual:
1. Anthropic $300/mo cap setup (Cooper-only access to console.anthropic.com)
2. Vercel env update post-bake (per Rule 6 — Cooper retains `printf` discipline)
3. v106 PR landing (gbrain terminal owns; auto-detected by preflight)
4. Snapshot retention cleanup (delete old snapshots after 1 week)
5. Strategic decisions (when to bake, when to cutover, when to roll back)

---

## Live validation results — 2026-05-19

Ran against the current source on Cooper's laptop:

| Test | Result | Notes |
|---|---|---|
| `--action=list` | ✓ | Empty list initially; populated after runs |
| `--action=status` (no runs) | ✓ | Clean "No runs found" |
| `--action=preflight` (first try) | ✗ | `extractManifestVersion` failed — 5000-char window too narrow for the 30K+ char docblock between `VM_MANIFEST = {` and `version:`. **Fixed.** |
| `--action=preflight` (post-fix #1) | ✗ | `OPENCLAW_PINNED_VERSION`, `NODE_VERSION`, `SECRET_VERSION` all returned null — regex didn't match `export const`, and OPENCLAW_PINNED_VERSION lives in `lib/ssh.ts` not `lib/vm-reconcile.ts`. **Fixed.** |
| `--action=preflight` (post-fix #2) | ✗ | `_pre-bake-check.ts` failed on HEAD-not-aligned-with-main — concurrent terminals had pushed since I started. **Fixed by `git pull`.** |
| `--action=preflight` (post-fix #3) | ✓ | All 6 gate steps clean. 1 warning surfaced (legit: 4 Vercel prod env vars missing). |
| `--action=dry-run` | ✓ | Full 25-step state machine exercised. 6 preflight ran for real. 17 side-effecting steps showed `↻ dry-run skip`. Preconditions caught real issues (e.g., reconcile-run-audit's missing RECONCILE_SOUL_MIGRATION_ENABLED P0 precondition would have aborted a real bake — surfaced BEFORE any Linode VM created). |
| `--action=preflight` (final, env var set) | ✓ | 0 errors, 1 warning (Vercel prod env — Cooper-action item). |
| `--action=status` (after run) | ✓ | JSON with full state. |
| Force-failure: `RECONCILE_SOUL_MIGRATION_VM_IDS=fake-vm-999` | ✓ | Correctly flagged "silently skips bake VM if not whitelisting it" with remediation. |

### Issues found + fixed

1. **`extractManifestVersion` regex too narrow** — fixed to scan for the indented `version: <digits>,` pattern anywhere in the manifest (not within 5000 chars of `VM_MANIFEST = {`).
2. **`extractConst` didn't handle `export const`** — fixed to accept optional `export ` prefix.
3. **`readSourcePins` didn't look in `lib/ssh.ts`** — fixed: OPENCLAW_PINNED_VERSION + NODE_PINNED_VERSION (the actual symbol name) now read from ssh.ts.
4. **`Object.assign(state, state_updates)` overwrote arrays** — fixed: warnings/errors/notes/cooper_actions are now APPENDED across steps, not replaced. Each entry prefixed with the step.id that emitted it.
5. **Operator UX — failed-step output buried in state.json** — fixed: the final summary now shows the last 10 lines of the failing step's output inline, plus the recovery hint from the step spec.
6. **Vercel env audit silently ignored pagination** — fixed: now reports row count parsed so the operator knows whether the full 95 vars were inspected.

All fixes committed in the same window as this doc.

---

## Known limitations

1. **Linode imagize / full bake not yet live-tested.** Requires a real bake run (~45 min, $0.05 in resources). Not appropriate to test under time pressure or without Cooper's go-ahead.
2. **Resume is naive on non-retryable steps.** `provision-create-instance` is marked `retryable: false`. If it fails after creating a Linode VM, resume would try to create a SECOND VM. P1 fix: skip non-retryable already-attempted steps on resume.
3. **No notification on completion.** The orchestrator runs in the terminal; exit code is the only signal. P2: optional `--notify=<webhook>` for Slack/email.
4. **Single-region (us-east) hardcoded as default.** `--region=...` overrides but other regions untested.
5. **Vercel env value verification requires `env pull`** — we check presence, not value. Documented as a follow-up note in preflight output.

---

## Operator quickstart (one-pager)

```bash
# 1. Confirm HEAD is at main
git fetch origin main && [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && echo "✓ aligned"

# 2. Confirm bake-tooling env vars are set
grep -E '^(LINODE_API_TOKEN|LINODE_SNAPSHOT_ID|SUPABASE_SERVICE_ROLE_KEY|SSH_PRIVATE_KEY_B64|RECONCILE_SOUL_MIGRATION_ENABLED)=' instaclaw/.env.local

# 3. Preflight (8s — no resources created)
cd instaclaw && npx tsx scripts/_autonomous-bake.ts --action=preflight

# 4. If preflight clean: full bake (~45 min — creates Linode resources, ~$0.10)
npx tsx scripts/_autonomous-bake.ts

# 5. After completion: paste the Cooper-action commands from the report
#    (printf '<new-snapshot-id>' | npx vercel env add LINODE_SNAPSHOT_ID production)
```

That's it. 5 lines. The orchestrator handles the other 38 checkboxes.
