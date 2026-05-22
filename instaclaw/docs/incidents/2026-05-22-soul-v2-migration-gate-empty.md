# INC-20260522-soul-v2-migration-gate-empty

## Severity & scope

**Severity: P0** — entire fleet stuck on V1 templates for 9 days.
**Scope:** all 156+ healthy+assigned fleet VMs (and every reconciler tick during the window).
**Customer-visible impact:** zero direct customer impact (V2 was an internal-quality improvement, not a feature). **Engineering-cost impact:** ~2 days of V2 content work (workspace templates, partner overlays, agent identity reordering, AGENTS.md restructuring) was building atop an inactive substrate.

## Timeline (UTC)

| When | Event |
|---|---|
| 2026-05-01 | V2 architecture designed (`prd-soul-restructure.md`). |
| 2026-05-11 | `stepMigrateSoulV2` written + shipped to code (`lib/vm-reconcile.ts:8050+`). Kill switch: `if (process.env.RECONCILE_SOUL_MIGRATION_ENABLED !== "true") return;` (silent return). |
| 2026-05-13 | `bake-readiness-audit-2026-05-13.md` notes "RECONCILE_SOUL_MIGRATION_ENABLED is NOT set in Vercel." Treated as Q-C decision pending Cooper. |
| 2026-05-13 | `canary-handoff-2026-05-13.md` says "required, currently NOT set in Vercel." |
| 2026-05-13 | `cloud-init-implementation-map.md` confirms V1 canonical, V2 canary-only. |
| 2026-05-13 → 2026-05-22 | **9 days of silent skips.** Reconcile-fleet cron tick fires every 3 min × ~150 VMs × 9 days ≈ 600,000 silent `stepMigrateSoulV2` returns. Zero operator signal. |
| 2026-05-13 → 2026-05-22 | Multiple terminals (onboarding, edge, snapshot, reconciler) continue building V2 content (`lib/workspace-templates-v2.ts`, partner overlays, agent identity reordering, AGENTS.md restructuring) assuming the migration is firing. |
| 2026-05-22 (afternoon) | Snapshot terminal runs DP2 verification on the bake VM. Direct on-disk inspection of `~/.openclaw/workspace/SOUL.md` reveals V1 markers (the `\`\`\` markers of `WORKSPACE_SOUL_MD` instead of `WORKSPACE_SOUL_MD_V2`). Incident discovered. |
| 2026-05-22 ~17:30 UTC | Cooper sets `RECONCILE_SOUL_MIGRATION_ENABLED=true` in Vercel production via `vercel env add ... --no-sensitive --value 'true'`. |
| 2026-05-22 ~17:35 UTC | Vercel cron picks up the new value; next reconcile-fleet tick begins migrating fleet VMs to V2. |
| 2026-05-22 ~18:00 UTC | Cooper notifies onboarding terminal (this terminal) of the incident + requests systemic fix. |
| 2026-05-22 ~18:30 UTC | Defensive code fix shipped: `stepMigrateSoulV2` now logs WARN + pushes to `result.warnings` when env var is set but not "true" (commit `bb6d42f1`). |
| 2026-05-22 ~18:45 UTC | Pre-bake check value validation shipped: `checkBooleanEnvVarValues()` in `scripts/_pre-bake-check.ts` (commit `8554c339`). |
| 2026-05-22 ~19:00 UTC | CLAUDE.md Rule 61 (boolean env vars validated by VALUE, not presence) shipped (commit `d10b84d2`). |

## Root cause

**Two-layer failure:**

1. **The code's silent-skip pattern.** `stepMigrateSoulV2`'s kill switch was the textbook bad shape:
   ```typescript
   if (process.env.RECONCILE_SOUL_MIGRATION_ENABLED !== "true") {
     return;
   }
   ```
   No log. No `result.errors` push. No `result.warnings` push. No operator signal of any kind. The step's name + body never appeared in any reconcile-fleet output, alert, or admin email when the env var was missing.

2. **The operator-tooling gap.** `_pre-bake-check.ts` had a `checkEnvVarsPresent()` function that validated PRESENCE of `LINODE_API_TOKEN`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SSH_PRIVATE_KEY_B64` — but not `RECONCILE_SOUL_MIGRATION_ENABLED`. Even if it had been in the list, the check was for "is it set" not "is it set to the correct value." An empty-string value would have passed.

The root question: *why was a Q-C decision left dangling in operator documentation while multiple terminals built atop it?* Three contributing factors:

- **No CI-level enforcement.** The docs flagged the gap but no script ran daily/per-commit to catch it.
- **No reconcile-fleet operator summary surfacing.** The cron's per-cycle summary email lists `result.errors` and `result.warnings` but not silent-skipped steps. There was no "what didn't run today" signal.
- **Terminals worked in parallel without a shared gate.** Each terminal saw V2 work landing in commits and assumed it was deploying. None ran `_pre-bake-check.ts` (which would have validated env state) outside of bake context.

## Fix

Shipped 2026-05-22:

1. **Vercel env corrected.** `RECONCILE_SOUL_MIGRATION_ENABLED=true` set in production via `vercel env add ... --no-sensitive --value 'true'` (avoids the echo-newline trap per Rule 6). Fleet migration to V2 began on the next reconcile tick.
2. **Defensive WARN log** in `stepMigrateSoulV2` (commit `bb6d42f1`). Distinguishes "explicitly disabled" (unset, `"false"`, `"0"`, `"no"` → silent OK) from "looks misconfigured" (anything else — empty string, `"True"`, `"1"`, typo → WARN log + `result.warnings.push`). The warning surfaces in every reconcile-fleet operator summary, making a re-occurrence of this bug class loud instead of silent.
3. **Pre-bake check value validation** in `scripts/_pre-bake-check.ts` (commit `8554c339`). New `checkBooleanEnvVarValues()` function validates that critical boolean env vars are actually `"true"`, not just present. `RECONCILE_SOUL_MIGRATION_ENABLED` and `GBRAIN_INSTALL_ENABLED` flagged as CRITICAL-required-on-for-bake.
4. **CLAUDE.md Rule 61** (commit `d10b84d2`). Codifies the discipline:
   - BANNED: bare `if (env !== "true") return;` with no log
   - REQUIRED: distinguish disabled vs misconfigured, log on the latter
   - REQUIRED operator pattern: `printf 'true' | npx vercel env add ...` (never `echo`, never `<<<`)
   - REQUIRED tooling: pre-bake checks validate VALUE not PRESENCE

## Prevention

| Class of bug | Mitigation shipped |
|---|---|
| Silent skip on misconfigured env var | Reference pattern in `stepMigrateSoulV2`; Rule 61 in CLAUDE.md |
| Pre-bake check passes broken env state | `checkBooleanEnvVarValues()` in `_pre-bake-check.ts` |
| Operator typos when setting env vars | `printf '...' | vercel env add` mandatory pattern in Rule 61 |
| Q-C decision documented but never wired | (deferred — see Known follow-up) |

## Known follow-ups

1. **Reconcile-fleet operator summary should list silently-skipped feature-flagged steps.** Even with the new WARN log, an operator who doesn't read the cron's email log won't see misconfig. A `result.skippedSteps` array surfaced in the summary email would close this.
2. **CI grep gate.** A pre-commit / CI rule that fails the build if any new `if (process.env.X !== "true") return;` lands without a WARN log. Currently human-enforced via Rule 61.
3. **Vercel-side value probe.** `_pre-bake-check.ts` validates LOCAL `.env.local`, not Vercel production. A `--check-vercel` flag that runs `vercel env pull` + re-validates would close the LOCAL-vs-VERCEL drift gap.
4. **Q-C decisions tracker.** Document-flagged "Q-C decision pending" items should land in a tracked tickets list, not just in standalone markdown files. Otherwise they sit in audit docs while parallel work builds atop the assumption that they're resolved.
5. **CLOUD_INIT_ONDEMAND_ENABLED `=== "true"` positive-gate inconsistency.** Deep-audit (2026-05-22) found that `CLOUD_INIT_ONDEMAND_ENABLED` (`lib/createUserVM.ts:517`) uses `=== "true"` positive-check instead of the `!== "true"` silent-skip pattern. Same operator-side risk class (empty-string → feature inactive) but excluded from `BAKE_BOOLEAN_ENVS` per the narrow criterion. Future operator-side risk would surface as a missed-flip on cloud-init fallback. Consider broadening the pre-bake check's `BAKE_BOOLEAN_ENVS` criterion to include positive-gate vars in a future PR.

## Operational note — fleet convergence ETA

**Correction to earlier estimate (2026-05-22 evening deep-audit):** initial deployment notes after v113 bump said "~30 min full fleet convergence." Actual observed rate after the bump was **~1 VM converging from cv=112 → cv=113 every ~5 min** (7 → 8 VMs converged across 5 min observation window).

Math: 1 VM / 5 min × 145 cv=112 VMs ≈ **12 hours total wall-clock to fleet-wide cv=113**. Not 30 min.

Root cause: `CONFIGURE_AUDIT_BATCH_SIZE` was reduced from default 3 to 1 in the 2026-05-14 secret-version starvation hotfix (`PER_VM_TIMEOUT_MS` bumped 120s → 220s alongside). The cron's per-tick budget allows only 1 VM at a time, not 3. The bottleneck is the batch size, not the cron cadence.

**For future operators:** when a manifest bump lands, expect:
- 30-min estimate: only valid if `CONFIGURE_AUDIT_BATCH_SIZE >= 3`
- 12-hour estimate: realistic if `CONFIGURE_AUDIT_BATCH_SIZE = 1` (current value, post-2026-05-14 hotfix)

The V2 migration was firing correctly on the converging VMs (verified via SSH probe on vm-837, vm-835, vm-788 — all 3 showed `<!-- INSTACLAW_SOUL_V2 -->` and `<!-- INSTACLAW_AGENTS_V2 -->` markers). Throughput-limited, not stuck.

P2 followup (NOT blocking 2026-05-30 launch): revisit `CONFIGURE_AUDIT_BATCH_SIZE = 3` once the per-step deadline PR (reconcile-deadline §3.2) lands and makes 220s/VM safer at concurrency.

## Lessons

1. **Operator documentation is not a substitute for code-level signaling.** The docs correctly flagged the gap; nothing in the code surfaced it. By the time DP2 caught it, 9 days of work had built atop the gap.
2. **Silent returns on misconfigured feature flags are a class of bug that compounds.** This wasn't a single-bug incident; it was a CLASS — at least 5 other env vars in the codebase have the same `!== "true"` pattern. Rule 61 + the pre-bake check + the WARN-log pattern address all of them at once.
3. **Cross-terminal parallel work needs a shared verification gate.** When multiple agents work concurrently on V2 content, each assumes the foundation is firing because every PR lands cleanly. A daily `_pre-bake-check.ts` run (or its `checkBooleanEnvVarValues` slice) catches divergence before it compounds.
4. **DP2-style direct verification is load-bearing.** The snapshot terminal's DP2 step caught this by reading on-disk content of the bake VM and comparing against expected markers. Without that direct verification, the bug would have shipped in the May 23 snapshot, then propagated to every new pool VM provisioned from it for the next ~30 days.
5. **9 days is the worst-case latency for silently-skipped feature flags.** Cooper noticed during a bake DP2 step. If V2 had been a customer-visible feature that nobody happened to test directly, latency could have been much longer.

## Forensic evidence

- Pre-fix `stepMigrateSoulV2` kill switch: `lib/vm-reconcile.ts:8057` at commit `60979082` (last commit before today's fix)
- Pre-fix `_pre-bake-check.ts`: `scripts/_pre-bake-check.ts` at commit `f49b4e68` (last commit before today's fix)
- DP2 discovery: see snapshot terminal's session log for 2026-05-22
- Vercel env-history: `RECONCILE_SOUL_MIGRATION_ENABLED` created 2026-05-22 ~17:30 UTC (not present prior). Verifiable via `npx vercel env ls`.

## Cross-reference

- **Rule 6** (no trailing newlines in env vars): same forensic ancestor as the `BANKR_PARTNER_KEY` incident. Rule 6 is WHY echo/`<<<` corrupt; Rule 61 is the systemic gate.
- **Rule 10** (verify every config set; no `|| true` suppression): same "loud-on-misconfig" principle, applied to `openclaw config set` instead of env vars.
- **Rule 23** (sentinel-grep required templates): same "stale state of operator-tooling cache" class.
- **Rule 39** (distinguish critical-step failures from optional-sidecar failures): Rule 61's `result.warnings.push(...)` lands here.
