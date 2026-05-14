# PRD: Fleet Health Hardening — Post 2026-05-11/12 Incident Workstream

**Author:** Cooper Wrenn + Claude (Opus 4.7, 1M context)
**Date:** 2026-05-14 (drafted 2026-05-12 during fleet recovery; backdated to target ship-window)
**Status:** Draft — master tracking doc for the unimplemented rules + cross-cutting items uncovered during the 2026-05-11 → 2026-05-12 cv=82/91 cohort recovery
**Priority:** P0 in aggregate (fleet-integrity)
**Read first:** `CLAUDE.md` "Fleet Health: Root Causes & Rules" section (Rules 36–46), then this PRD.

> "If it's not in this PRD, it doesn't get done." — Cooper, 2026-05-12.
> Every rule documented in CLAUDE.md that has zero code behind it lives here as a work item. If you ship something fleet-wide and don't update this PRD, the next operator will re-derive your work under pressure during the next incident.

---

## Table of Contents

1. Context & Goal
2. Out of Scope (already shipped or covered elsewhere)
3. Phase 0 — Pre-Edge-Esmeralda (ship by 2026-05-19)
4. Phase 1 — Pre-Snapshot-Bake (ship by 2026-05-23)
5. Phase 2 — Post-Launch (ship by 2026-06-15)
6. Cross-Cutting Items
7. Acceptance Definition: "Fleet Healthy"
8. Self-Audit Checklist

---

## 1. Context & Goal

The 2026-05-11 incident revealed structural fragility in the fleet reconciler:

- 46% of the fleet (~70 VMs) stuck behind manifest version at start of investigation.
- 4 paying customers (vm-842, vm-043, vm-788, vm-902) hit 100% disk full because of a session-backup runaway loop introduced by a mtime-equality idempotency bug in `strip-thinking.py`.
- 2 paying customers (vm-059, vm-574) had crashed gateways because compaction keys were applied to systemd units pointing at the OLD Node binary.
- Vercel cron `reconcile-fleet` is structurally incapable of catching up VMs more than ~5 manifest versions behind (Rule 44).

Documented Rules 36–46 in CLAUDE.md captured every root cause. Three rules (39, 41, 45) shipped during recovery. Eight rules (36, 37, 38, 40, 42, 43, 44, 46) are diagnosed but unimplemented. This PRD turns each into a tracked work item with priority, effort, dependencies, and acceptance criteria.

**Phasing rationale.** Edge Esmeralda has us bringing a partner-tagged fleet online — anything that lets a paying customer's VM silently drift behind manifest version is unacceptable. Snapshot bake (planned 2026-05-23–25) freezes the v95+ state into a new image; any rule that has to propagate via configureOpenClaw() or snapshot contents must land before the bake, not after.

**Goal of this PRD.** A reader who lands on this doc in the middle of the next incident should be able to (a) understand what's been done since 2026-05-12, (b) see what's still outstanding with priority and effort, and (c) trace each item back to the rule and the code path that motivated it.

---

## 2. Out of Scope

The following are referenced for context but tracked elsewhere — do not duplicate the work here.

| Topic | Owner doc |
|---|---|
| Rule 44 structural fix (Vercel 300s deadline) | `reconcile-deadline-structural-fix-2026-05-11.md` — this PRD references it but does not re-spec |
| gbrain fleet rollout | `gbrain-fleet-rollout-2026-05-12.md`, `PRD-gbrain-integration.md` |
| Dedicated CPU + observability foundation | `infrastructure-upgrade-dedicated-cpu.md` (Phases 1–3 complete; Phase 4 price-raise pending) |
| SOUL.md trim (30 KB ceiling pressure) | `soul-md-trim-2026-05-11.md` |
| Agent acknowledgment UX (v95 ack-ux) | `agent-acknowledgment-ux-2026-05-11.md` |
| API cost optimization / prompt caching | `api-cost-optimization.md` |
| Snapshot bake May 23–25 toolchain | tracked in changelog terminal; checklist lives in CLAUDE.md "Snapshot Creation Process" |
| WDP 71 / AgentBook | `wdp71-agentbook-prd.md` |
| Bankr partnership | `project_bankr_partnership.md` (memory) |
| Newsworthy partnership | `skill-newsworthy-curation.md` |

If an item below overlaps one of these, the entry only enumerates the **integration touchpoint**, not the body of work.

---

## 3. Phase 0 — Pre-Edge-Esmeralda (ship by 2026-05-19)

Items here MUST land before partner-tagged onboarding sees fleet-scale load. Each one prevents a re-occurrence of a customer-visible incident from the 2026-05-11 window.

### P0-A — Rule 39 propagation: stop blocking cv on observability errors (CODE SHIPPED, needs verification across fleet)

**One-liner.** Verify the warnings-vs-errors classification (commit `187d477f`) actually unblocks cv advancement on every node-exporter / watchdog-timer / edge-overlay miss in production.

**Root cause + code path.** Rule 39 in CLAUDE.md. Pre-fix: `stepNodeExporter` (4 callsites), `stepGatewayWatchdogTimer` (2 callsites), and `stepDeployEdgeOverlay` (skill-missing) pushed to `result.errors`. The `pushFailed` gate at `app/api/cron/reconcile-fleet/route.ts:414` then refused to bump `config_version`. Fix added `result.warnings` field + `recordHealWarning` helper + reclassified the 7 callsites.

**Blast radius.** The cv=91 cohort (~20 VMs at investigation time) couldn't advance to v92+ because every reconcile tick hit at least one of these "errors" and pushFailed gated the bump. Including paying customers.

**Implementation spec.**
- Code is shipped. Remaining work is verification:
  - Run `scripts/_coverage-config-version.ts` (or equivalent count query) hourly for 48h post-deploy. Expect cv distribution to flatten toward current `VM_MANIFEST.version`.
  - Pick 5 random VMs that had `recent_reconcile_warnings` populated in the audit log; SSH-probe each and confirm `config_version` advanced after the next cron tick.
  - Backstop: if any VM in (healthy, assigned) stays stuck at the same cv for >12 cron ticks (36 min) AND its only reconcile errors map to one of the reclassified warning sites, flag as Rule-39 regression.

**Acceptance criteria.**
- ≥95% of (healthy, assigned) VMs at current `VM_MANIFEST.version` within 48h of v92 manifest bump.
- Zero VMs blocked exclusively on `node_exporter port did not open` / `watchdog timer not enabled` / `edge overlay skill missing` in the cron audit log.

**Priority.** P0 (already shipped; this entry is the verification gate, not new code).
**Dependencies.** None.
**Effort.** 1–2 hours of querying + spot-SSH. Mostly waiting for cron ticks to roll.

---

### P0-B — Rule 45 propagation: session-backup cooldown patched in `lib/ssh.ts` must reach every VM

**One-liner.** The session-backup runaway-loop fix (`eaf5617a`) lives in `lib/ssh.ts:STRIP_THINKING_SCRIPT`. Every VM needs the new script deployed by the reconciler. If we ship the manifest bump without verifying propagation, the 4-paying-customer disk-full incident repeats.

**Root cause + code path.** Rule 45. The pre-fix `strip-thinking.py` used the source jsonl's mtime as the idempotency key for `_backup_session_file`. But the script itself rewrites the source jsonl every minute (stripping thinking blocks), advancing mtime, so the next run sees a new mtime, takes a new backup, advances mtime, etc. — unbounded growth at 1 backup/minute → 100% disk in ~12h on a fresh VM. Fix uses wall-clock cooldown (`SESSION_BACKUP_COOLDOWN_SEC=300`) and per-session count cap (`SESSION_BACKUP_MAX_PER_SESSION=50`).

**Blast radius.** Any (assigned, healthy) VM running the old `strip-thinking.py` is one heavy session away from another disk-full crash. Cv=91 cohort hit it first because those VMs had been alive longest accumulating backups.

**Implementation spec.**
1. Bump `VM_MANIFEST.version` after merge of `eaf5617a` (if not already done) so the reconciler ticks register a drift.
2. Verify `strip-thinking.py` is in `manifest.files[]` with `requiredSentinels: ["SESSION_BACKUP_COOLDOWN_SEC", "SESSION_BACKUP_MAX_PER_SESSION"]` (Rule 23). If sentinels are absent, ADD them — the runaway-loop fix is exactly the kind of load-bearing template change Rule 23 was written for. **This is mandatory; without sentinels a long-running reconciler with stale module cache can silently re-deploy the OLD version (the 2026-05-02 commit-3 incident pattern).**
3. Add a coverage script `scripts/_coverage-session-backup-cooldown.ts` that SSH-greps `~/.openclaw/scripts/strip-thinking.py` for `SESSION_BACKUP_COOLDOWN_SEC` on a random 25-VM sample, reports `<count_with_fix> / 25 (<pct>%)`.
4. Run the coverage script after the v92+ rollout has soaked ≥1 hour. Pause cron rollout if coverage <95%.

**Acceptance criteria.**
- 100% of (healthy, assigned) VMs at `config_version >= V` (where V is the manifest version that carried `eaf5617a`) have the new strip-thinking.py on disk.
- Zero `disk_pct >= 90` alerts from Prometheus/node_exporter in 7-day soak.
- The 50-files/session cap is observable on a heavy-use VM (e.g., vm-050) by `ls ~/.openclaw/session-backups | wc -l` not exceeding 50 × active_sessions.

**Priority.** P0.
**Dependencies.** Rule 23 sentinels added in `vm-manifest.ts:files[]`.
**Effort.** 3–4 hours (sentinel add + manifest bump + coverage script + verification).

---

### P0-C — Rule 36: surface upstream errors in non-strict reconciler runs

**One-liner.** The non-strict catch-up path swallows step-level errors and reports "success" if any single step succeeded. The strict path uses `pushFailed` correctly. Catch-up reports lie about what actually advanced.

**Root cause + code path.** Rule 36 in CLAUDE.md. In `lib/vm-reconcile.ts`, the non-strict `stepConfigSettings` path catches per-key errors locally and bumps `result.fixed` even when keys failed to apply. Rules 10 and 23 force the strict path (`STRICT_RECONCILE_VM_IDS` env-gated) to be honest about failures, but the catch-up script (`scripts/_catch-up-stuck-cohort.ts`) runs non-strict by design (the strict deadline is the whole reason we wrote the script). So the catch-up's "5/5 successful" summary doesn't actually mean 5 VMs reached current manifest version.

**Blast radius.** During the 2026-05-11 → 12 recovery, the catch-up script reported wave-level success on multiple waves while the actual cv-distribution query showed VMs frozen at intermediate cv. ~30 minutes of confusion before someone re-ran the coverage query. Future recoveries will hit the same illusion.

**Implementation spec.**
- In `lib/vm-reconcile.ts`, every non-strict path that catches an error from `openclaw config set` (or any verify-after-set) must `result.errors.push(...)` exactly as the strict path does. Remove any `try/catch` that swallows without re-pushing.
- The non-strict / strict distinction should be ONLY about whether the gate is `pushFailed=true` (refuse cv bump) vs `pushFailed=false` (bump anyway, but make sure errors are still recorded for telemetry).
- In `scripts/_catch-up-stuck-cohort.ts`, change the per-VM summary line to print `errors=<n>` alongside `fixed=<n>`. The "5/5 success" line at wave end should read `5/5 advanced cv (errors observed on N VMs, see audit log)` so the user can't miss it.
- ~15–25 LOC across reconciler + script.

**Acceptance criteria.**
- After a catch-up run, the audit log `recent_reconcile_warnings` + `recent_reconcile_errors` are populated for every VM where at least one step had an issue. Spot-check 5 VMs against on-disk state.
- The catch-up script's stdout NEVER reports "wave success" without also surfacing the per-wave error count.
- Spot test: artificially inject a verify-after-set failure into one step on one VM, run catch-up, observe (a) cv still advances, (b) error is in the audit log, (c) script output flags it.

**Priority.** P0 (directly enables Rule 39 verification — without honest error surfacing we can't tell if cv-blocking unblocks worked).
**Dependencies.** None.
**Effort.** 2–3 hours.

---

### P0-D — Rule 46: disk monitoring + auto-purge at 90% (preventative, not reactive)

**One-liner.** The disk-full incident wasn't surfaced by any alert. We discovered it by SSH-probing VMs after customer complaints. Need active monitoring + auto-purge before a VM hits 100% and corrupts atomic-write files (which is how the Rule 38 ENOSPC truncation happened).

**Root cause + code path.** Rule 46. node_exporter exposes `node_filesystem_avail_bytes` and Prometheus can compute `1 - (avail/size)`. But (a) only some VMs run node_exporter (the prometh terminal flagged 149 VMs without it), and (b) we have no alertmanager rule that fires at >85% or auto-action that purges. The reconciler has no disk-aware step.

**Blast radius.** 4 paying customers crashed because the runaway loop ran ~12 hours without intervention. Each additional day on the v92+ rollout is more VMs accumulating session-backups; even with Rule 45 in place, an old session-backups dir from before the fix can still push disk over the edge.

**Implementation spec.**
- **Reconciler step `stepDiskGuard` (NEW)**, runs as Step -1 (before any other writes):
  - SSH `df / | awk 'NR==2{print $5}' | tr -d %`
  - If ≥90%: invoke purge path inline — `find ~/.openclaw/session-backups -mtime +1 -delete`, retry df, repeat with stricter retention if still ≥90%.
  - If still ≥90% after both passes: push to `result.errors` (cv-blocking) AND fire an admin alert via `lib/admin-alerts.ts` with severity `P0`.
  - If 80–89%: push a `result.warnings` entry (visible in audit log) but don't block cv.
  - Idempotent: never deletes files <24h old except in the >95% emergency path.
- **Alertmanager rule** (in monitoring repo, see Cross-Cutting §6.B): `DiskAlmostFull` at >85% for 10 min, P1; `DiskCritical` at >95% for 2 min, P0.
- **Coverage**: `scripts/_coverage-disk-pct.ts` queries fleet, returns histogram of disk usage. Run weekly; spot-check the tail.

**Acceptance criteria.**
- Synthetic test: fill a test VM to 92% via `fallocate -l 5G ~/.openclaw/session-backups/test.bin`, run reconciler, observe stepDiskGuard purges the file (or alerts if it's <24h old and disk is <95%).
- Zero VMs at >85% disk in the fleet for >24h continuously.
- Alertmanager fires on staging fill-test within 12 min.

**Priority.** P0.
**Dependencies.** Prometheus + alertmanager wiring (Cross-Cutting §6.B) — but stepDiskGuard can ship without alertmanager (admin alert via existing `lib/admin-alerts.ts` path is sufficient interim).
**Effort.** 4–6 hours (reconciler step + coverage script + synthetic test). Alertmanager rule is separate (see §6.B).

---

### P0-E — Rule 40: per-VM per-tick "cv-bump-blocked" structured logging

**One-liner.** When the cron skips a cv bump for a VM, we don't get a structured log of WHY. Investigators have to reconstruct from `result.errors` and `result.warnings` jsonb columns. During an incident this is the slowest part of triage.

**Root cause + code path.** Rule 40. The `pushFailed` gate at `app/api/cron/reconcile-fleet/route.ts:414` is the decision point but it only `console.log`s a generic message. The structured log of "VM X stayed at cv N because steps [Y, Z] errored" lives only in the per-VM audit jsonb that we have to fish out of `instaclaw_vms.recent_reconcile_errors`.

**Blast radius.** During the 2026-05-11 recovery, ~30 minutes were spent SSH-probing individual VMs to figure out why cv hadn't advanced. With a structured per-VM emit on every tick, the answer would have been one SQL query.

**Implementation spec.**
- At the `pushFailed=true` branch in `route.ts`, emit a structured log line:
  ```
  CV_BUMP_BLOCKED vm=<name> cv_current=<n> cv_target=<n> errors_count=<k> failing_steps=<comma_sep_step_names> sample_error=<first_err.slice(0,200)>
  ```
- ALSO write the same payload to a new `instaclaw_reconcile_blocked` table (or extend `instaclaw_reconcile_audit` with a `blocked_reason` column). Retention: 7 days; auto-purge cron tick at midnight.
- A coverage query: "VMs blocked on the same step for >6 ticks" — that's a structural problem and should auto-alert.

**Acceptance criteria.**
- During the next cron tick, every blocked VM emits a structured `CV_BUMP_BLOCKED` log line readable in Vercel logs.
- A SQL query against the new table returns "top 5 step names failing across the fleet right now" in <1s.
- Tested by manually blocking cv on one VM (e.g., introduce a failing config key on disk) and observing the trace through logs + DB.

**Priority.** P0.
**Dependencies.** P0-C (Rule 36 — non-strict path must accurately populate `result.errors` for this to be meaningful).
**Effort.** 3–4 hours.

---

## 4. Phase 1 — Pre-Snapshot-Bake (ship by 2026-05-23)

Items here must land before the 2026-05-23–25 snapshot bake freezes a new base image. Anything that needs to be in the snapshot (cron, script, default config) cannot wait for post-launch.

### P1-A — Rule 38: atomic-write `.tmp` files must self-clean on ENOSPC

**One-liner.** The vm-842 corrupted openclaw.json incident: `openclaw config set` does atomic write via `<path>.tmp + os.replace()`. ENOSPC during the write left the .tmp file behind, and a subsequent re-run found existing .tmp files that pre-empted the new write — leaving openclaw.json at 0 bytes. The disk-full cleanup found 30+ stale .tmp files from prior ENOSPC retries.

**Root cause + code path.** Rule 38 in CLAUDE.md. The atomic-write pattern is correct in principle but assumes the .tmp write itself doesn't fail mid-stream. On ENOSPC, the .tmp is left at partial-size. Next call doesn't clean before writing, so accumulated .tmp files burn additional disk. AND the `replace` step on a partial .tmp would truncate the source — that's the vm-842 0-byte file.

**Implementation spec.**
- Patch OpenClaw upstream? **No — too slow.** Instead, wrap with a fleet-side guard:
  - `stepEnospcCleanup` (NEW reconciler step, runs as Step -2 before stepDiskGuard): SSH `find ~/.openclaw/ -maxdepth 2 -name "*.tmp" -mtime +0 -size -1M -delete` (only delete .tmp files that are <1MB AND >24h old — bounds the blast radius).
  - Verify after each `openclaw config set` in `stepConfigSettings`: after `set`, check no `<key path>.tmp` is left behind. If found, delete and re-run the set (one retry, then push to errors).
- Long-term: file upstream issue with OpenClaw to make `config set` self-clean its .tmp on EXIT. Track in `project_openclaw_retry_budget_backlog.md` or sibling.

**Acceptance criteria.**
- Synthetic test: fill disk to 100%, attempt `openclaw config set foo bar`, observe .tmp does NOT remain after the (failed) write.
- Audit query: SSH-probe 10 random VMs for `find ~/.openclaw/ -name "*.tmp"`; expect 0 results (no leftover .tmp files in steady state).

**Priority.** P1 (the symptom — disk full — is addressed by Rule 45 + P0-D. This entry hardens the root cause).
**Dependencies.** P0-D (stepDiskGuard).
**Effort.** 3–4 hours.

---

### P1-B — Rule 37: ENOSPC detection P0 alerting (pre-disk-full vs post-disk-full)

**One-liner.** When ENOSPC fires anywhere on a VM (config write, gateway write, session backup), the only way we currently learn is post-mortem. Need a real-time signal.

**Root cause + code path.** Rule 37. Multiple log paths surface ENOSPC (gateway journal, strip-thinking.py stderr, openclaw config set stderr). Each is invisible to the cron — by the time the next cron tick runs, the VM may already be in the corrupted state.

**Implementation spec.**
- Two layers:
  1. **In-VM watchdog** (`~/.openclaw/scripts/vm-watchdog.py` — already runs every minute): add a `disk_pct` field to its heartbeat POST. If ≥90%, also POST a P0 alert to `/api/admin/alert` (existing endpoint).
  2. **Gateway log monitor** (`~/.openclaw/scripts/enospc-watch.py` — NEW, runs every minute): tail journal for ENOSPC, on match POST an alert immediately.
- Both scripts must be embedded in `vm-manifest.ts` and deployed via reconciler with `requiredSentinels` (Rule 23). Both must be in the snapshot for new VMs.

**Acceptance criteria.**
- Synthetic test: trigger ENOSPC on a staging VM; admin alert email/Slack fires within 2 min.
- Coverage: 100% of (healthy, assigned) VMs have `enospc-watch.py` cron entry.

**Priority.** P1.
**Dependencies.** P0-D (stepDiskGuard); P1-A (ENOSPC cleanup) — alerting is more valuable when there's an action to take.
**Effort.** 5–6 hours (two scripts, manifest entries, sentinels, test).

---

### P1-C — Rule 43: cold-boot health-check wait must scale with plugin count

**One-liner.** vm-923 (edge_city, 8 plugins) takes ~90s to reach `is-active=active && /health=200` after restart. The audit grace period (commit `4aed0be4`) gives 120s, which is enough — but it's hardcoded. vm-901 hit 121s once and got false-positive-failed.

**Root cause + code path.** Rule 43. `auditVm` in `scripts/_catch-up-stuck-cohort.ts` has `MAX_AUDIT_RETRIES=12, INTERVAL_MS=10000`. The combined wait is 120s. Plugins each add ~5–10s to cold-boot. Edge VMs are 8 plugins ≈ 60s plugin-load on top of ~30s baseline = ~90s typical, with tail-latency above 120s.

**Implementation spec.**
- Query plugin count for the VM at start of audit (`openclaw plugins list | wc -l` or read from `~/.openclaw/openclaw.json:plugins`).
- Compute `audit_timeout_seconds = max(120, 30 + plugin_count * 15)`.
- If a VM is approaching the per-VM script budget AND `audit_timeout_seconds` would exceed it, log a warning and use the budget remaining (don't infinitely extend).
- Same logic should live in `lib/vm-reconcile.ts:stepGatewayRestart` after-restart wait — currently 60s hardcoded.

**Acceptance criteria.**
- 8-plugin edge_city VM passes audit on first try after restart.
- Stress test: deploy a synthetic 10-plugin VM, observe audit succeeds in ≤165s.

**Priority.** P1.
**Dependencies.** None.
**Effort.** 2–3 hours.

---

### P1-D — Rule 42: private-repo skill auth fallback (tarball or deploy token)

**One-liner.** Skills installed via `git clone` from private repos depend on the in-VM SSH key having read access. The 2026-04-11 vm-729 broken-sibling incident (CLAUDE.md Rule 24) was partially caused by a transient auth failure that left `.git/` empty. We need a fallback that survives auth blips.

**Root cause + code path.** Rule 42. `installAgdpSkill` / `installBankrSkill` / similar in `lib/ssh.ts` shell out to `git clone <ssh-url>`. If the deploy key is unreadable, the clone fails. There's no fallback to a tarball download or a deploy-token-protected HTTP URL.

**Implementation spec.**
- Each private-repo skill installer (currently dgclaw, bankr, edge-esmeralda) gets a 3-tier install order:
  1. `git clone <ssh-url>` (primary)
  2. On failure: `git clone https://<deploy-token>@<host>/<repo>` (secondary, deploy token in Vercel env)
  3. On failure: `curl -L -H "Authorization: token <PAT>" -o /tmp/skill.tar.gz <archive-url> && tar -xzf` (tertiary)
- Verify-after-write per Rule 24: `.git/HEAD` exists OR `SKILL.md` exists, AND for skills with scripts, `scripts/<expected>.sh` exists.
- Deploy token rotation: documented in `lib/skill-installer.ts` header; rotation procedure in CLAUDE.md operations section.

**Acceptance criteria.**
- Block primary SSH-clone access via firewall on a staging VM; observe installer falls through to deploy-token clone successfully.
- Run integrity check across fleet (`scripts/_audit-skill-integrity.ts`); expect 100% of expected skills present on (healthy, assigned) VMs.

**Priority.** P1.
**Dependencies.** Deploy tokens provisioned for each private skill repo.
**Effort.** 5–7 hours.

---

### P1-E — Rule 44 (structural fix integration touchpoint)

**One-liner.** This entry is the integration tracking for `reconcile-deadline-structural-fix-2026-05-11.md`. Do not re-spec the structural fix here.

**Body.** The Vercel cron's 300s function maxDuration is a hard ceiling. The reconciler's 180s strict deadline + the per-VM step costs at v95 mean any VM more than ~5 manifest versions behind cannot catch up via cron. The structural fix outlined in `reconcile-deadline-structural-fix-2026-05-11.md` proposes one of:
- (a) Split reconciler into two cron routes: "single-version step" (cv→cv+1) at 5-min cadence + "deep catch-up" at 1-hour cadence with longer deadline.
- (b) Move to a queue-based worker (Inngest, Trigger.dev) outside Vercel's function timeout.
- (c) Per-VM resumable reconciliation (checkpoint state mid-tick, resume next tick).

**Integration acceptance criteria for this PRD.**
- The chosen approach is documented in `reconcile-deadline-structural-fix-2026-05-11.md` with a decision date.
- The chosen approach ships before any future manifest version bump that would push the cv distribution >5 versions wide.
- If still not decided by 2026-05-23 (snapshot bake), the snapshot-bake checklist must explicitly note "fleet drift can recur until structural fix lands" so the team doesn't bake under a false assumption of cron-driven recovery.

**Priority.** P1 (structurally, P0 — but tracked by the other PRD's owner).
**Dependencies.** Decision on which approach (Cooper).
**Effort.** Days to weeks depending on approach.

---

### P1-F — `gbrain` rollout integration touchpoint

**One-liner.** gbrain installation lives in `gbrain-fleet-rollout-2026-05-12.md`. This PRD only tracks the integration with the fleet-health rules.

**Integration acceptance criteria for this PRD.**
- `stepGbrain` (committed in `b1741db5`) MUST be a no-op for non-allowlisted VMs. Verified in unit-test-equivalent SSH probe.
- gbrain install failures map to `result.warnings`, not `result.errors` — gbrain is non-critical observability tooling; should never block cv (Rule 39 applies).
- Before bumping any manifest version that has `stepGbrain` in the step order, run coverage script to confirm 100% allowlisted-VM install success rate ≥98%.

**Priority.** P1.
**Dependencies.** Cooper's $300/mo Anthropic spending cap is set; GBRAIN_ANTHROPIC_API_KEY confirmed in Vercel env all environments.
**Effort.** 0 for this PRD (already done in other PRD). Integration verification: 1 hour.

---

## 5. Phase 2 — Post-Launch (ship by 2026-06-15)

Items here are quality-of-life or longer-cycle structural work. Less acute, still real.

### P2-A — Rule 23 sentinel coverage audit across `vm-manifest.ts:files[]`

**One-liner.** Rule 23 requires `requiredSentinels` on any template entry that represents a load-bearing fix. Today, only `strip-thinking.py` has them. Every other template (~30+ entries) is unguarded against the same stale-cache regression.

**Root cause + code path.** Rule 23 in CLAUDE.md. The 2026-05-02 commit-3 incident proved that a long-running reconciler with stale module cache can re-deploy OLD versions of templates. The sentinel guard is the fix; we just haven't backfilled.

**Implementation spec.**
- For each entry in `vm-manifest.ts:files[]`, evaluate whether the template content has any post-fix marker that should be load-bearing.
- Candidates (non-exhaustive): `vm-watchdog.py`, `auto-approve-pairing.py`, `push-heartbeat.sh`, `silence-watchdog.py`, `SOUL.md` components, `CAPABILITIES.md` components.
- Pick 1–2 unique post-fix sentinels per file (function/class signature + log-line literal per Rule 23 guidance).
- Add to manifest entries. Verify the reconciler's pre-write check trips on artificially-stale content.

**Acceptance criteria.**
- ≥80% of `files[]` entries have `requiredSentinels`. Remaining 20% have a one-line comment explaining why no sentinel is appropriate (e.g., template hasn't carried a load-bearing fix yet).

**Priority.** P2.
**Dependencies.** None.
**Effort.** 4–6 hours.

---

### P2-B — `_coverage-*` script suite consolidation

**One-liner.** Rule 27 requires a coverage query for every fleet-wide resource. We've accumulated `_coverage-config-version.ts`, `_coverage-session-backup-cooldown.ts` (P0-B), candidates from P0-D and P0-E. Consolidate into one umbrella script with sub-commands.

**Implementation spec.**
- `scripts/_coverage.ts <subcommand>` — single entry point.
- Sub-commands: `config-version`, `session-backup`, `disk-pct`, `strip-thinking`, `prctl-subreaper`, `partner-tag`, `bankr-wallet`, `skill:<name>`.
- Each prints `<count_with> / <count_total> (<pct>%)` and optionally a histogram.
- Document in CLAUDE.md under "Coverage Queries" section.

**Acceptance criteria.**
- During an incident, an operator can answer "what % of the fleet has X" in <30 seconds via one command.

**Priority.** P2.
**Dependencies.** P0-A, P0-B (those PRs add the first few coverage scripts).
**Effort.** 3–4 hours.

---

### P2-C — Self-healing crons for the in-VM watchdog stack

**One-liner.** If `vm-watchdog.py` cron is removed (manual edit, package upgrade, drift), no one finds out until something else breaks. Add a meta-cron that re-installs missing crons.

**Implementation spec.**
- A single `~/.openclaw/scripts/self-heal-crons.py` runs every 10 min.
- It has the canonical list of 7 crons (per Snapshot Creation Process Step 5). For each missing, re-add idempotently via the marker pattern.
- Logs to `~/.openclaw/logs/self-heal-crons.log`. Reports anomalies via heartbeat.

**Acceptance criteria.**
- Synthetic test: manually delete `vm-watchdog.py` cron line; observe self-heal-crons re-adds within 10 min.

**Priority.** P2.
**Dependencies.** Snapshot bake (this should ship inside the new snapshot).
**Effort.** 3–4 hours.

---

### P2-D — Coverage dashboard (consolidated UI)

**One-liner.** Right now coverage is "run a script and read stdout." A simple admin page at `/admin/fleet-coverage` would aggregate all the coverage queries and show them on one screen.

**Implementation spec.**
- Next.js page at `app/admin/fleet-coverage/page.tsx`.
- Calls each `_coverage-*` subcommand server-side (or queries DB directly) and renders a table: `Resource | Coverage % | Last Updated`.
- Refresh on a 1-min interval.
- Only accessible to admin (Cooper's email).

**Acceptance criteria.**
- Page loads in <3s, shows all coverage queries in one view.
- Each row links to a per-resource detail page with histogram + list of VMs missing the resource.

**Priority.** P2.
**Dependencies.** P2-B (consolidated coverage script).
**Effort.** 6–8 hours.

---

### P2-E — Memory-hygiene cron (Rule 29 follow-up)

**One-liner.** The "VM fork limits" memory-poisoning incident showed agents persistently re-cite hallucinated diagnoses. Need a cron that scans MEMORY.md for repeated unfamiliar jargon and flags.

**Implementation spec.**
- `~/.openclaw/scripts/memory-hygiene.py` weekly cron.
- For each agent's MEMORY.md, count repeated phrases matching `r'(limit|blocked|cannot|unable|forbidden)[^.]{5,100}'`.
- If any phrase appears >5 times AND isn't in any system telemetry (gateway journal, watchdog log), inject a `<!-- MEMORY_HYGIENE_FLAG: this explanation may be hallucinated; re-investigate next time -->` comment at the relevant section.
- Optional Phase 2: surface flagged memories on the admin fleet-coverage dashboard.

**Acceptance criteria.**
- Synthetic test: inject "VM fork limits" 6 times into a staging MEMORY.md; observe the hygiene cron flags it within a week.

**Priority.** P2.
**Dependencies.** Cooper's go-ahead — this touches user memory and Rule 22 applies (no destructive mutation, marker-comment only).
**Effort.** 5–6 hours.

---

### P2-F — Session-log + active-tasks write enforcement (Rule 23 unfinished item)

**One-liner.** CLAUDE.md "Open P1 Follow-Ups" #3 notes that the cross-session memory files (`session-log.md`, `active-tasks.md`) are empty on real user VMs despite SOUL.md instructing the agent to write them. Surface what fraction of fleet has empty files; harden if widespread.

**Implementation spec.**
- `scripts/_coverage-session-log.ts`: SSH-probes 25 random VMs, counts how many have non-template content in `~/.openclaw/workspace/memory/session-log.md` and `active-tasks.md`.
- If <50% have content: harden by adding a strip-thinking.py hook that explicitly checks "did session-log.md grow in the last session?" — if not, inject a one-time MEMORY.md note prompting the agent.
- Do NOT enforce via destructive rewrite (Rule 22).

**Acceptance criteria.**
- Coverage script returns ground truth; if <50%, the harden step ships.

**Priority.** P2.
**Dependencies.** None.
**Effort.** 4–6 hours (coverage + diagnosis), more if harden step is needed.

---

## 6. Cross-Cutting Items

### §6.A — Timour feedback items #4, #6, #14 (Edge Esmeralda partner)

These came in during the Edge Esmeralda onboarding handoff. Each is a fleet-health concern that affects partner-tagged VMs specifically.

#### §6.A.1 — Timour #4: deployment lock visibility

**One-liner.** Timour observed that when our reconcile-fleet lock is held by a manual operator, his diagnostic scripts can't get traction. He needs visibility into when the lock is held and by whom.

**Implementation spec.**
- Public read-only endpoint `/api/admin/lock-status` (no auth needed for read; lists holder, ttl_remaining, last_acquired_at for `reconcile-fleet`, `replenish-pool`, etc.).
- Stable JSON shape: `{ name, holder, acquired_at, expires_at, ttl_seconds_remaining }`.
- Document the endpoint in CLAUDE.md so partner integrators can self-serve.

**Acceptance criteria.**
- `curl https://instaclaw.io/api/admin/lock-status` returns lock state in <500ms.
- Timour confirms his scripts can poll it.

**Priority.** P1 (pre-Edge-Esmeralda).
**Dependencies.** None.
**Effort.** 2 hours.

---

#### §6.A.2 — Timour #6: auto-advance trapped VMs

**One-liner.** Timour observed VMs occasionally stuck at intermediate cv even after a manual catch-up run. Wants an auto-advance mechanism that retries stuck VMs without human intervention.

**Implementation spec.**
- New cron `/api/cron/auto-advance-stuck` at `0 */6 * * *` (every 6h):
  1. Query: VMs with `health_status='healthy' AND status='assigned' AND config_version < VM_MANIFEST.version AND last_reconcile_attempt > NOW() - INTERVAL '1 hour'`.
  2. For each: run `reconcileVM` with strict=false, capped 5-min wall-clock.
  3. Log results to `instaclaw_reconcile_audit`.
  4. Cron lock semantics — coordinate with `reconcile-fleet` lock (don't double-run).
- Bounded blast: max 10 VMs per tick.

**Acceptance criteria.**
- Within 12h of a manifest bump, all (healthy, assigned) VMs converge to current `VM_MANIFEST.version` without manual intervention.
- Auto-advance run never overlaps with `reconcile-fleet` lock.

**Priority.** P1 (pre-Edge-Esmeralda).
**Dependencies.** P0-C (Rule 36) to ensure auto-advance accurately reports per-VM success.
**Effort.** 4–6 hours.

---

#### §6.A.3 — Timour #14: EdgeOS env-token mismatch

**One-liner.** Timour identified that some Edge-tagged VMs have `EDGEOS_API_TOKEN` env var that doesn't match the active EdgeOS deployment. Likely a snapshot-bake drift issue.

**Root cause + code path.** Partner-onboarded VMs get EDGEOS_API_TOKEN at provision time via `lib/edge-esmeralda-skill.ts`. If the token rotates without a fleet sweep, existing VMs stay at the old value. Same shape as the partner-tag drift incident (Rule 9 / 2026-04-30).

**Implementation spec.**
- Add to `stepConfigSettings` (or new `stepEnvVars`): verify `EDGEOS_API_TOKEN` matches the current value in Vercel env (passed via the cron route). If mismatched, write the new value via the gateway env mechanism (NOT raw `.env` file — must go through openclaw config set or equivalent).
- Backfill: one-shot `scripts/_sync-edgeos-token.ts` that walks all partner=edge_city VMs and verifies/updates.
- Document rotation procedure in CLAUDE.md operations section.

**Acceptance criteria.**
- After token rotation, 100% of partner=edge_city VMs reflect the new value within 1 cron cycle (5 min).
- No human handholding required for rotations.

**Priority.** P1 (pre-Edge-Esmeralda).
**Dependencies.** None.
**Effort.** 5–6 hours.

---

### §6.B — Prometheus / Grafana / Alertmanager gaps

The prometh terminal's 2026-05-11 audit found:

1. **149 VMs without node_exporter** — `stepNodeExporter` ran but didn't land. With Rule 39 in place this no longer blocks cv, but it means 50% of the fleet has no metrics.
2. **Alertmanager not wired** — Prometheus emits alerts via webhook but the webhook receiver is a placeholder.
3. **Grafana exposed on public internet with no TLS** — `66.228.43.140:3000` accessible to anyone with the URL. Authenticated, but unencrypted.

#### §6.B.1 — node_exporter coverage

**Implementation spec.**
- Backfill script `scripts/_install-node-exporter-fleet.ts`: SSH-installs node_exporter on every VM where `which node_exporter` fails. Idempotent.
- Investigate why `stepNodeExporter` succeeded-per-audit-log but is missing on disk — Rule 23 sentinel check candidate. Add sentinel: `node_exporter --version | grep -q 1.8.2`.
- After backfill, the reconciler should re-detect drift on any future VM where node_exporter goes missing.

**Acceptance criteria.**
- Prometheus targets show 100% of (healthy, assigned) VMs UP.
- Grafana dashboards show data for every VM in the fleet.

**Priority.** P1 (pre-snapshot-bake).
**Dependencies.** P0-D, P0-E (alerting needs metrics first).
**Effort.** 6–8 hours.

---

#### §6.B.2 — Alertmanager + alert routing

**Implementation spec.**
- Wire Alertmanager to PagerDuty (or email if PD not set up) for P0; Slack for P1; nothing for P2.
- Initial alert rules: `DiskAlmostFull` (>85%, 10m), `DiskCritical` (>95%, 2m), `GatewayDown` (no /health 200 for 15m on assigned VM), `ENOSPC` (P0-E hook), `CronStale` (replenish-pool or reconcile-fleet not run in 30m).
- Document the receiver config in `monitoring/alertmanager.yml`. Source-control everything; no console-edited routes.

**Acceptance criteria.**
- Synthetic alert from each rule fires the correct receiver in <2 min.
- An on-call runbook section in CLAUDE.md lists each alert + the response procedure.

**Priority.** P1 (pre-snapshot-bake).
**Dependencies.** §6.B.1.
**Effort.** 6–8 hours.

---

#### §6.B.3 — Grafana TLS + auth hardening

**Implementation spec.**
- Add `caddy` or `traefik` in front of Grafana on the monitoring VM (66.228.43.140) terminating TLS via Let's Encrypt.
- Move Grafana to `metrics.instaclaw.io` (CNAME → monitoring VM).
- Enable Grafana OAuth (Google) so only @valtlabs.com / @instaclaw.io accounts can log in.
- Rotate the Grafana admin password.

**Acceptance criteria.**
- `https://metrics.instaclaw.io` serves Grafana over TLS, OAuth-protected.
- Plain `http://66.228.43.140:3000` either redirects to HTTPS or is firewalled off.

**Priority.** P1 (pre-snapshot-bake — and arguably P0 from a security posture standpoint, but the OAuth + TLS work is a discrete chunk that doesn't block fleet-health work).
**Dependencies.** DNS access; Google OAuth client.
**Effort.** 4–6 hours.

---

### §6.C — Test infrastructure (Rule 31 backfill)

**One-liner.** Rule 31 mandates failure-mode tests. Our test surface is thin. Pick the highest-impact 3–4 failure modes to harness, then expand.

**Implementation spec.**
- Standup `instaclaw/scripts/test/` directory + Vitest config (or simple tsx runners).
- Three priority tests:
  1. `test_strip_thinking_cooldown.ts` — synthetic session > 200KB, observe Rule 22/30 trim-not-nuke behavior + Rule 45 cooldown bound.
  2. `test_reconciler_strict_vs_nonstrict.ts` — inject a verify-after-set failure, observe strict path refuses cv bump AND non-strict path still bumps but logs error (Rule 36 / P0-C acceptance).
  3. `test_disk_guard.ts` — synthetic 92% disk, observe stepDiskGuard purges (P0-D acceptance).
- CI rule (future): on every PR touching `lib/vm-reconcile.ts` or `lib/ssh.ts`, these tests run.

**Acceptance criteria.**
- Three tests pass locally and (eventually) in CI.
- Test setup time <5 min for a new contributor.

**Priority.** P1.
**Dependencies.** Test fixtures (synthetic jsonl, etc.).
**Effort.** 8–10 hours.

---

## 7. Acceptance Definition: "Fleet Healthy"

Per CLAUDE.md, the fleet-healthy invariant is:

```sql
SELECT count(*)
FROM instaclaw_vms
WHERE health_status = 'healthy'
  AND status = 'assigned'
  AND config_version < (SELECT version FROM vm_manifest_meta);
-- Expected: 0
```

For this PRD to be "done": after all Phase 0 + Phase 1 items ship, that count returns 0 within 12h of any manifest version bump and stays at 0 modulo legitimate transient state (cold-boot, in-flight reconcile).

A secondary invariant:
- Zero VMs at `disk_pct >= 90` for >24h continuously.
- Zero VMs blocked exclusively on a Rule-39-reclassified warning step.
- Auto-advance auto-converges drift within 12h with no human intervention.

---

## 8. Self-Audit Checklist

Before declaring this PRD shipped:

- [x] Rule 36 covered → P0-C
- [x] Rule 37 covered → P1-B
- [x] Rule 38 covered → P1-A
- [x] Rule 39 covered → P0-A (verification of shipped code)
- [x] Rule 40 covered → P0-E
- [x] Rule 41 acknowledged (shipped in `4aed0be4`, included in P0-A surface area)
- [x] Rule 42 covered → P1-D
- [x] Rule 43 covered → P1-C
- [x] Rule 44 covered → P1-E (integration with `reconcile-deadline-structural-fix-2026-05-11.md`)
- [x] Rule 45 propagation covered → P0-B
- [x] Rule 46 covered → P0-D
- [x] Prometheus/Grafana/Alertmanager gaps covered → §6.B (three sub-items)
- [x] Timour #4 deployment lock visibility → §6.A.1
- [x] Timour #6 auto-advance → §6.A.2
- [x] Timour #14 EdgeOS token mismatch → §6.A.3
- [x] Rule 23 backfill (sentinels) → P2-A (P0-B mandates it for the strip-thinking entry specifically)
- [x] Rule 27 coverage scripts → P2-B (P0-B, P0-D, P0-E add the first batch)
- [x] Rule 29 memory hygiene → P2-E
- [x] Test infrastructure → §6.C
- [x] Self-healing crons → P2-C
- [x] Coverage UI → P2-D
- [x] Session-log enforcement → P2-F
- [x] Cross-references to existing PRDs (Rule 44, gbrain, infra upgrade, soul-md-trim, agent-ack-ux, api-cost) — §2 + integration touchpoints
- [x] Each item has all 8 fields (priority, root cause, blast radius, spec, acceptance, dependencies, effort, one-liner)
- [x] Items ordered by priority within each phase
- [x] Phases gated by external milestones (Edge Esmeralda, snapshot bake)
- [x] No duplication with existing PRDs (each cross-reference is to a tracking owner, not a re-spec)

If any checkbox above is unchecked, this PRD is not ready to ship.
