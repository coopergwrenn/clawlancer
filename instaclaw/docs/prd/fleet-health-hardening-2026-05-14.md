# PRD: Fleet Health Hardening — Post 2026-05-11/12 Incident Workstream

**Author:** Cooper Wrenn + Claude (Opus 4.7, 1M context)
**Date:** 2026-05-14
**Status:** Active — master tracking doc for the unimplemented rules + cross-cutting items uncovered during the 2026-05-11 → 2026-05-12 cv=82/91 cohort recovery + the 2026-05-14 prometh-audit fallout.
**Priority:** P0 in aggregate (fleet-integrity)
**Read first:** `CLAUDE.md` "Fleet Health: Root Causes & Rules" section (Rules 36–46), then this PRD.

> "If it's not in this PRD, it doesn't get done." — Cooper, 2026-05-12.

This PRD is the source of truth for every rule, finding, and remediation that came out of the May incident sequence. If you ship something fleet-wide and don't update this file, the next operator will re-derive the work under pressure during the next outage.

---

## Phase Numbering (read this first)

Phases are organized by **milestone dependency**, not by chronological ship-date. Phase 2 ships first on the calendar; Phase 1 has the broader partner-launch surface area.

| Phase | Ship-by | What goes here |
|---|---|---|
| **Phase 1 — Pre-Edge-Esmeralda** | **2026-05-30** | Partner-readiness, customer-visible reliability, anything a paying customer (or Edge Esmeralda attendee) could notice |
| **Phase 2 — Pre-Snapshot-Bake** | **2026-05-23 → 25** | Anything that must be baked into the v96+ snapshot (in-VM scripts, crons, default config, ufw rules) |
| **Phase 3 — Post-Launch** | **2026-06-15** | Long-cycle structural work, observability polish, test surface |

Phase 2 has the harder deadline. Phase 1's deadline is softer (a missed item gets hot-patched), but the surface is larger (any partner-visible bug counts).

---

## Table of Contents

1. Context & Goal
2. Shipped Items (DONE — 2026-05-14)
3. Recovery Operations (one-time fixes already executed)
4. Out of Scope (tracked in other PRDs)
5. Phase 1 — Pre-Edge-Esmeralda (ship by 2026-05-30)
6. Phase 2 — Pre-Snapshot-Bake (ship by 2026-05-23 → 25)
7. Phase 3 — Post-Launch (ship by 2026-06-15)
8. Cross-Cutting Items
9. Acceptance Definition: "Fleet Healthy"
10. Self-Audit Checklist

---

## 1. Context & Goal

The 2026-05-11 → 2026-05-14 incident sequence revealed structural fragility across the fleet reconciler, the in-VM monitoring stack, and partner-onboarding state machines:

- **46% of the fleet (~70 VMs) stuck behind manifest version** at start of investigation.
- **6 paying customers (vm-842, vm-043, vm-788, vm-902, vm-568, vm-375) hit 100% disk full** from the session-backup runaway loop (`strip-thinking.py` mtime idempotency bug; fixed in `eaf5617a`).
- **2 paying customers (vm-059, vm-574) had crashed gateways** because compaction keys were applied to systemd units pointing at the OLD Node binary (fixed via `stepExecStartAlignment`, commit `c4b84156`).
- **Vercel cron `reconcile-fleet` is structurally incapable of catching up VMs more than ~5 manifest versions behind** (Rule 44; the 180s strict deadline + 300s Vercel function ceiling). Tracked in `reconcile-deadline-structural-fix-2026-05-11.md`.
- **The prometh-terminal audit (2026-05-14)** surfaced 8 ADDITIONAL disk-critical VMs invisible to monitoring: 2 paying healthy (vm-902 re-fill, vm-912), 2 unhealthy (vm-748, vm-911), 1 hibernating (vm-908), 3 suspended (vm-881, vm-886, vm-629). These were invisible because **ufw firewall blocked Prometheus scrape**, not because node_exporter was missing — the 149-VM "no metrics" cohort was a firewall problem, not a binary-missing problem. This corrects a misdiagnosis from the earlier audit.
- **EDGEOS_BEARER_TOKEN was wrong for 34 days** on every edge_city VM. The bearer token in Vercel env was a hex string duplicated from EDGEOS_API_KEY at variable-creation time and never updated to the JWT Francisco actually sent. Every authenticated EdgeOS API call from any agent silently failed for the entire Edge Esmeralda pre-launch window. Fixed in `42a1c8d8` + Vercel env update.

Documented Rules 36–46 in CLAUDE.md captured every root cause. **Four rules and one token incident shipped during recovery** (39, 41, 45 + EDGEOS_BEARER_TOKEN; see §2). **Seven rules (36, 37, 38, 40, 42, 43, 44, 46) plus the prometh-audit follow-ups plus the Timour partner-feedback items are diagnosed but unimplemented.** This PRD turns each into a tracked work item with priority, effort, dependencies, and acceptance criteria.

**Goal.** A reader who lands on this doc in the middle of the next incident should be able to (a) understand what's been done since 2026-05-11, (b) see what's still outstanding with priority and effort, (c) trace each item to the rule + code path that motivated it.

---

## 2. Shipped Items (DONE — 2026-05-14)

These shipped during the incident response. Listed for memory + so future operators don't re-investigate root causes that are already fixed in code.

### DONE-1 — Rule 39: warnings vs errors classification

**Commit.** `187d477f` (feat: `result.warnings` vs `result.errors` reclassification). Companion changelog auto-update: `70de80e7`.

**What shipped.** Added `result.warnings: string[]` to `ReconcileResult`. New `recordHealWarning` helper. Reclassified `stepNodeExporter` (4 callsites), `stepGatewayWatchdogTimer` (2 callsites), and `stepDeployEdgeOverlay` (skill-missing path) from `result.errors` (cv-blocking) to `result.warnings` (non-blocking, audit-only). `pushFailed` gate at `app/api/cron/reconcile-fleet/route.ts:414` only inspects `errors`, so warnings no longer prevent cv advancement.

**Remaining work (carried as P1-1).** Verify the reclassification actually unblocks cv on the cv=91 cohort. Spot-check via SSH + audit log.

---

### DONE-2 — Rule 41: assigned-VM-must-have-gateway-token CHECK constraint

**Commit.** `fa0f9a85` (feat(rule-41): CHECK constraint — assigned VMs must have gateway_token). Plus Supabase migration applied.

**What shipped.** DB-layer constraint that refuses to commit any row where `status='assigned' AND assigned_to IS NOT NULL AND gateway_token IS NULL`. Catches the vm-918 trap-state class (Rule 33). One paying customer (khomenko89@gmail.com) was in this state for 6 days before discovery; fixed via manual `resyncGatewayToken`.

**Remaining work.** None. Constraint is enforced at the DB layer; new bad-state inserts are now impossible.

---

### DONE-3 — Rule 45: session-backup cooldown (code shipped; fleet propagation tracked separately)

**Commit.** `eaf5617a` (fix(strip-thinking): cooldown-based session-backup idempotency + count cap).

**What shipped.** `lib/ssh.ts:STRIP_THINKING_SCRIPT` updated: replaced mtime-equality idempotency with wall-clock cooldown (`SESSION_BACKUP_COOLDOWN_SEC=300`) and per-session count cap (`SESSION_BACKUP_MAX_PER_SESSION=50`). Worst-case bound: 50 × N sessions × ~250KB ≈ ~300 MB max vs the observed 58 GB on vm-788. CLAUDE.md Rule 45 documents the failure mode.

**Remaining work (carried as P1-2).** Propagation. The fix is in the embedded template; every VM still needs the new `strip-thinking.py` deployed via the reconciler's `stepFiles` (content-hash drift detection). For VMs at `cv >= 95`, the cron's `lt("config_version", VM_MANIFEST.version)` filter excludes them — those VMs need a manifest version bump OR a one-shot fleet-push to receive the fix. Coverage script + sentinel-grep tracked in P1-2.

---

### DONE-4 — EDGEOS_BEARER_TOKEN: enrolled in `stepEnvVarPush` (edge_city gate)

**Commit.** `42a1c8d8` (fix(reconcile): enroll EDGEOS_BEARER_TOKEN in stepEnvVarPush).

**Root cause (preserve for lesson — see P1-9).** EDGEOS_BEARER_TOKEN in Vercel env was set to a hex string that was duplicated from EDGEOS_API_KEY at variable-creation time. **It was never updated to the JWT bearer that Francisco sent.** Every signed EdgeOS API call from any edge_city VM silently 401'd for 34 days (2026-04-10 → 2026-05-14). No alerting fired because the EdgeOS API treats 401 as a normal client response, and no agent error path surfaced the failure to the user — they just got empty calendar data and assumed Edge Esmeralda hadn't published events yet.

**What shipped.** (a) Updated the value in Vercel env to the actual JWT. (b) Enrolled `EDGEOS_BEARER_TOKEN` in `stepEnvVarPush` so future rotations propagate to existing VMs the same way EDGEOS_API_KEY does. (c) Cloud-init tarball updated by the onboarding terminal to include the bearer in `.env` at provision time for new edge_city VMs.

**Remaining work.** The cloud-init tarball update is owned by the onboarding terminal — listed as P1-10 integration touchpoint here so we don't double-ship. The **lesson** ("never copy-paste between env-var names; verify partner-supplied secrets render correctly in a real outgoing request before considering provisioned") is captured as P1-9.

---

## 3. Recovery Operations (one-time fixes already executed)

These are operational interventions, not engineering work. Tracked here so they're reproducible if the same shape recurs.

### REC-1 — Disk-cleanup batch 1 (2026-05-13)

**Targets.** vm-842, vm-043, vm-788, vm-902, vm-568, vm-375.

**Script.** `scripts/_clean-disk-full-vms.ts` (7-day retention purge) + `scripts/_clean-disk-aggressive.ts` (24h + 1000-file cap fallback).

**Outcome.** All 6 recovered to <80% disk and gateway-healthy within 60 minutes of script execution.

---

### REC-2 — Disk-cleanup batch 2 (2026-05-14, post-prometh-audit)

**Targets.** P0: vm-902 (re-fill), vm-912 (paying healthy). P1: vm-748, vm-911 (unhealthy), vm-908 (hibernating), vm-881, vm-886, vm-629 (suspended).

**Why visible only after prometh fix.** ufw firewall was blocking Prometheus from scraping 149 fleet VMs. After the firewall was opened to the monitoring VM (66.228.43.140), the actual disk usage for these 8 VMs became visible — they had been at 100% for an unknown duration without any signal reaching us.

**Script.** `scripts/_clean-disk-batch2.ts` (same strategies as REC-1, plus diagnostic disk-breakdown output + Rule 45 sentinel check for SESSION_BACKUP_COOLDOWN_SEC).

**Outcome.** [To be filled in by current run; checkpoint reached at PRD-write time.]

---

### REC-3 — vm-902 re-fill investigation (RESOLVED)

**Finding.** vm-902 was cleaned in REC-1 and re-filled within ~30 minutes. Diagnostic output from `_clean-disk-batch2.ts` confirmed the root cause: **session-backups was the dominant consumer (57 GB / 8,183 files on vm-902)** AND the strip-thinking.py grep on the 8-VM sample showed **7/8 still on the OLD version without `SESSION_BACKUP_COOLDOWN_SEC`**. This is the Rule 45 propagation gap — see REC-4.

---

### REC-4 — Strip-thinking.py fleet-push (Rule 45 propagation, 2026-05-14)

**Targets.** All 146 (healthy, assigned) VMs.

**Script.** `scripts/_fleet-push-strip-thinking-v3.ts` — mirrors the canonical hotfix pattern (base64 transport, py_compile syntax check, sentinel grep, atomic mv with .bak preservation, md5 verify post-write). Concurrency 5, waves of 20, per-VM hard timeout 60s.

**Outcome.** 135 deployed + 11 already-current + 0 failed in 68 seconds wall-clock. Spot-check of 5 random VMs confirmed `md5=cd0037d2e959da405fa2c6396c159c7b` and `SESSION_BACKUP_COOLDOWN_SEC` sentinel-hits=3 on each.

**Architectural finding.** This is the surface symptom of a deeper gap, captured as **Rule 47 (Continuous reconciliation, not version-gated)** in CLAUDE.md (Root Cause 0.5 section). The reconcile-fleet cron filter at `route.ts:272` excludes VMs at `cv = VM_MANIFEST.version` from the batch query entirely; any template-only change reaches new provisions + currently-stuck VMs but **never** caught-up VMs. Until the long-term continuous-reconciliation fix lands (see new P1-11 below), every template change requires either a manifest version bump OR a one-shot fleet-push.

---

### REC-5 — XMTP crash-loop recovery (vm-912, vm-904, 2026-05-14)

**Targets.** vm-912 (cv=85, paying), vm-904 (cv=91, paying). Both stuck in `instaclaw-xmtp.service: activating (auto-restart)` with restart counters 5,453 and 19,736 respectively.

**Root cause.** Missing/corrupt npm dependencies in `~/scripts/node_modules/`:
- vm-904: `@xmtp/agent-sdk` and `viem` both absent.
- vm-912: directories present but `~/scripts/node_modules/viem/package.json` was empty/broken — Node ESM resolver could not find `viem/index.js`.

The reconciler's surgical-fix path (`lib/vm-reconcile.ts:4466`) only rewrites the unit file + restarts. It does NOT verify node_modules health. With `key=1 mjs=1 active=0`, the surgical path runs forever and never repairs deps. Full re-provision (which DOES run `npm install`) is gated behind `key=0 OR mjs=0`. So these VMs were architecturally trapped: surgical path can't help, full path is gated off.

**Script.** `scripts/_fix-xmtp-stuck-vms.ts` — stops the service, `rm -rf ~/scripts/node_modules` (scoped narrowly; does not touch `~/scripts/` or `~/.openclaw/xmtp/`), `npm install @xmtp/agent-sdk@latest` (viem comes in transitive), reset-failed + restart, poll `is-active` for up to 60s with 2s interval.

**Outcome.** Both VMs recovered cleanly. NRestarts → 0. XMTP wallet addresses generated: vm-904 → `0x8407421ca9f509bf4c8c4d1a9e56f71f25223df1`, vm-912 → `0x054531013b9edae5947e164a0d1da42f603b3fd4`. DB `instaclaw_vms.xmtp_address` synced.

**Architectural finding.** Captured as **Rule 48 (Surgical service fixes must probe dependency state)** in CLAUDE.md (Root Cause 0.6 section). The systemic fix is tracked as new P1-12 below.

---

## 4. Out of Scope

These items overlap topics covered here but are tracked in dedicated PRDs. **Do not re-spec them in this PRD.**

| Topic | Owner doc |
|---|---|
| Rule 44 structural fix (Vercel 300s deadline) | `reconcile-deadline-structural-fix-2026-05-11.md` |
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

## 5. Phase 1 — Pre-Edge-Esmeralda (ship by 2026-05-30)

Partner-readiness, customer-visible reliability. Anything a paying customer or Edge Esmeralda attendee could notice.

### P1-1 — Rule 39 propagation verification (post-ship)

**One-liner.** Verify the Rule 39 reclassification (commit `187d477f`) actually unblocks cv advancement across the cv=91 cohort and the freshly-classified node_exporter / watchdog-timer / edge-overlay miss cases.

**Root cause + code path.** Rule 39. Pre-fix: optional-step failures pushed to `result.errors`. The `pushFailed` gate at `app/api/cron/reconcile-fleet/route.ts:414` then refused to bump `config_version`. Fix shipped in `187d477f`.

**Blast radius.** ~20 VMs at investigation time. Including paying customers.

**Implementation spec.**
- Run a coverage query hourly for 48h post-deploy. Expect cv distribution to flatten toward current `VM_MANIFEST.version`.
- Pick 5 random VMs that had `recent_reconcile_warnings` populated; SSH-probe each and confirm `config_version` advanced after the next cron tick.
- Backstop: if any (healthy, assigned) VM stays stuck at the same cv for >12 cron ticks (36 min) AND its only reconcile errors map to a reclassified warning site, flag as Rule-39 regression.

**Acceptance criteria.**
- ≥95% of (healthy, assigned) VMs at current `VM_MANIFEST.version` within 48h of v96 manifest bump.
- Zero VMs blocked exclusively on `node_exporter port did not open` / `watchdog timer not enabled` / `edge overlay skill missing`.

**Priority.** P1 (verification of shipped code).
**Dependencies.** None.
**Effort.** 1–2 hours of querying + spot-SSH.

---

### P1-2 — Rule 45 propagation: session-backup cooldown must reach every VM

**One-liner.** The session-backup runaway-loop fix (`eaf5617a`) lives in `lib/ssh.ts:STRIP_THINKING_SCRIPT`. Every VM needs the new script on disk; reconciler's `stepFiles` should auto-deploy via content-hash drift, but the cv=95 filter excludes VMs already at current cv from cron processing.

**Root cause + code path.** Rule 45. The pre-fix mtime-equality idempotency in `strip-thinking.py`'s `_backup_session_file` failed because the same script mutates the source jsonl. Fix uses wall-clock cooldown + count cap.

**Blast radius.** Any (assigned, healthy) VM running the old `strip-thinking.py` is one heavy session away from another disk-full crash. The 8 batch-2 VMs (REC-2) prove this is ongoing — vm-902 was cleaned 30 min before re-filling because the fix hadn't landed on disk.

**Implementation spec.**
1. **Add `requiredSentinels` to `strip-thinking.py` entry in `vm-manifest.ts:files[]`** (Rule 23): `["SESSION_BACKUP_COOLDOWN_SEC", "SESSION_BACKUP_MAX_PER_SESSION"]`. Without sentinels a stale-cached reconciler could re-deploy the OLD version (2026-05-02 commit-3 incident pattern).
2. **Bump `VM_MANIFEST.version` to v96** so the reconciler picks up VMs currently at cv=95 and pushes the new file.
3. **Coverage script `scripts/_coverage-strip-thinking-cooldown.ts`**: SSH-greps `~/.openclaw/scripts/strip-thinking.py` for `SESSION_BACKUP_COOLDOWN_SEC` on a 25-VM random sample. Reports `<count_with_fix> / 25 (<pct>%)`. Run hourly post-deploy.
4. **One-shot fleet-push fallback**: if coverage <95% after 4 hours of cron rolling, run `scripts/_fleet-push-strip-thinking-v2.ts` (mirror of the 2026-05-02 `_fleet-push-strip-thinking-hotfix.ts` pattern; concurrency=5, wave=20).

**Acceptance criteria.**
- 100% of (healthy, assigned) VMs at `cv >= 96` have the new strip-thinking.py on disk.
- Zero `disk_pct >= 90` alerts in 7-day soak.
- The 50-files/session cap is observable on a heavy-use VM (e.g., vm-050) by `ls ~/.openclaw/session-backups | wc -l` not exceeding 50 × active_sessions.

**Priority.** P1.
**Dependencies.** Rule 23 sentinels added in `vm-manifest.ts:files[]`.
**Effort.** 3–4 hours.

---

### P1-3 — Rule 36: surface upstream errors in non-strict reconciler runs

**One-liner.** The non-strict catch-up path swallows step-level errors. Catch-up "wave success" reports lie about what actually advanced — exactly what bit us during the 2026-05-12 recovery.

**Root cause + code path.** Rule 36. In `lib/vm-reconcile.ts`, the non-strict `stepConfigSettings` path catches per-key errors locally and bumps `result.fixed` even when keys failed to apply. Catch-up script `scripts/_catch-up-stuck-cohort.ts` runs non-strict by design (the strict deadline is the whole reason it exists).

**Blast radius.** ~30 min of triage confusion during 2026-05-12 because wave outputs claimed success while cv-distribution queries showed VMs frozen mid-catch-up. Future recoveries will hit the same illusion at worse times.

**Implementation spec.**
- In `lib/vm-reconcile.ts`, every non-strict path that catches an error from `openclaw config set` (or any verify-after-set) must `result.errors.push(...)` exactly as the strict path does. Remove any `try/catch` that swallows without re-pushing.
- Strict vs non-strict distinction is ONLY about the `pushFailed` gate (refuse cv bump vs bump-anyway-but-record-errors).
- In `scripts/_catch-up-stuck-cohort.ts`, per-VM summary prints `errors=<n>` alongside `fixed=<n>`. Wave-end summary reads `5/5 advanced cv (errors observed on N VMs, see audit log)` so the operator can't miss it.
- ~15–25 LOC across reconciler + script.

**Acceptance criteria.**
- After a catch-up run, the audit log `recent_reconcile_warnings` + `recent_reconcile_errors` are populated for every VM where at least one step had an issue.
- The catch-up script's stdout never reports wave success without also surfacing per-wave error count.
- Spot test: inject a verify-after-set failure on one VM, run catch-up, observe (a) cv still advances, (b) error is in audit log, (c) script output flags it.

**Priority.** P1 (directly enables P1-1 — without honest error surfacing we can't tell if cv-blocking unblocks worked).
**Dependencies.** None.
**Effort.** 2–3 hours.

---

### P1-4 — Rule 46: disk monitoring + auto-purge at 90% (preventative)

**One-liner.** The 14 paying-customer disk-full incidents (6 in REC-1 + 2 P0 in REC-2) all happened invisibly until customer complaints. Need active monitoring + auto-purge before VMs hit 100% and corrupt atomic-write files (the vm-842 ENOSPC 0-byte-openclaw.json shape).

**Root cause + code path.** Rule 46. node_exporter exposes `node_filesystem_avail_bytes` BUT (a) ufw firewall blocked Prometheus scrape on 149 VMs (now fixed; see P2-5), (b) no alertmanager rule at >85%, (c) no auto-action that purges, (d) the reconciler has no disk-aware step.

**Blast radius.** Every paying customer whose session size grows organically. Without monitoring, the next vm-788-class crash is invisible until the customer messages support.

**Implementation spec.**
- **Reconciler step `stepDiskGuard` (NEW)**, runs as Step -1 (before any other writes):
  - SSH `df / | awk 'NR==2{print $5}' | tr -d %`.
  - ≥90%: invoke purge inline — `find ~/.openclaw/session-backups -mtime +1 -delete`, retry df, repeat with stricter retention if still ≥90%.
  - ≥95% emergency path: keep only 1000 newest backups (mirror REC-2 strategy 2).
  - If still ≥90% after both passes: push `result.errors` (cv-blocking) AND fire admin alert via `lib/admin-alerts.ts` with severity `P0`.
  - 80–89%: push `result.warnings` entry (audit-log only).
  - Idempotent: never deletes files <24h old except in the >95% emergency path.
- **Alertmanager rule** (see §6.B.2): `DiskAlmostFull` >85% for 10 min (P1); `DiskCritical` >95% for 2 min (P0).
- **Coverage script `scripts/_coverage-disk-pct.ts`**: histogram of disk usage across fleet. Run weekly.

**Acceptance criteria.**
- Synthetic test: fill a test VM to 92% via `fallocate -l 5G ~/.openclaw/session-backups/test.bin`, run reconciler, observe stepDiskGuard purges (or alerts if file is <24h old AND disk <95%).
- Zero VMs at >85% disk in the fleet for >24h continuously.
- Alertmanager fires on staging fill-test within 12 min.

**Priority.** P1.
**Dependencies.** P2-5 (ufw fleet sweep — without it, monitoring can't see the disk). stepDiskGuard can ship with admin-alert fallback if alertmanager isn't ready.
**Effort.** 4–6 hours (reconciler step + coverage script + synthetic test). Alertmanager rule is separate.

---

### P1-5 — Rule 40: per-VM per-tick "cv-bump-blocked" structured logging

**One-liner.** When the cron skips a cv bump for a VM, we don't get a structured log of WHY. Investigators reconstruct from `result.errors` jsonb. Slowest part of incident triage today.

**Root cause + code path.** Rule 40. The `pushFailed` gate at `app/api/cron/reconcile-fleet/route.ts:414` only `console.log`s a generic message. Structured "VM X stayed at cv N because steps [Y, Z] errored" lives only in per-VM audit jsonb.

**Blast radius.** ~30 min lost during 2026-05-12 SSH-probing individual VMs to figure out why cv hadn't advanced. With a structured emit, the answer is one SQL query.

**Implementation spec.**
- At the `pushFailed=true` branch in `route.ts`, emit:
  ```
  CV_BUMP_BLOCKED vm=<name> cv_current=<n> cv_target=<n> errors_count=<k> failing_steps=<comma_sep_step_names> sample_error=<first_err.slice(0,200)>
  ```
- Also write to a new `instaclaw_reconcile_blocked` table (or extend `instaclaw_reconcile_audit` with a `blocked_reason` column). Retention: 7 days; auto-purge cron at midnight.
- Coverage query: "VMs blocked on the same step for >6 ticks" auto-alerts (structural problem).

**Acceptance criteria.**
- Next cron tick emits structured `CV_BUMP_BLOCKED` log lines readable in Vercel logs.
- SQL query against new table returns "top 5 step names failing across the fleet right now" in <1s.
- Tested by manually blocking cv on one VM and observing the trace.

**Priority.** P1.
**Dependencies.** P1-3 (Rule 36 — non-strict path must accurately populate `result.errors`).
**Effort.** 3–4 hours.

---

### P1-6 — Timour #4: deployment lock visibility + `configure_lock_at` race

**One-liner.** Two sub-problems Timour flagged: (a) when the `reconcile-fleet` distributed lock is held, his diagnostic scripts can't tell who's holding it; (b) the per-user `configure_lock_at` (deployment lock) can outlive a Stripe back-nav, trapping a user with a "deployment in progress" state when no deployment is actually running.

**Root cause + code path.**
- (a) The `instaclaw_cron_locks` table is queryable but there's no public endpoint exposing it. Partner diagnostic tools have to be granted DB read, which is a much bigger ask than read-only HTTP.
- (b) `configure_lock_at` on `instaclaw_users` gets set when `/api/vm/configure` starts. If the user navigates back from Stripe checkout before the configure completes (Rule 33 partial-commit family), the lock can persist past the actual cleanup. Same lying-DB shape as the vm-918 invariant fix (DONE-2 / Rule 41), but for a different column.

**Blast radius.** Timour-class partner diagnostics get blocked. End-user impact of (b) is a user who looks "stuck deploying" forever; manual SQL clear is required. Estimated low single-digit incidence pre-Edge-Esmeralda, will scale with partner sign-up volume.

**Implementation spec.**
- **(a) Public lock-status endpoint.** New `/api/admin/lock-status` (no auth needed for read; partner-safe). Returns:
  ```
  { name, holder, acquired_at, expires_at, ttl_seconds_remaining }
  ```
  for every row in `instaclaw_cron_locks`. Document the endpoint in CLAUDE.md.
- **(b) `configure_lock_at` TTL guard.** Cron `cron/clear-stale-configure-locks` (every 10 min): `UPDATE instaclaw_users SET configure_lock_at = NULL WHERE configure_lock_at < NOW() - INTERVAL '15 minutes'`. Emits an admin alert if any rows are updated (signal that a configure path failed without releasing the lock — see Rule 33). Concurrency: this is a no-op if the configure path completes normally because the success path already clears the lock.

**Acceptance criteria.**
- `curl https://instaclaw.io/api/admin/lock-status` returns lock state in <500ms; Timour confirms his scripts can poll it.
- A user who Stripe-back-navs mid-configure has their `configure_lock_at` cleared within 15 min and can re-initiate deployment.

**Priority.** P1.
**Dependencies.** None.
**Effort.** (a) 2 hours. (b) 3 hours. Total 5.

---

### P1-7 — Timour #6: `BotVerification.tsx:55` auto-advance 1500ms

**One-liner.** Timour observed that the bot-verification step auto-advances after 1500ms regardless of whether the verification actually succeeded. This produces a race where a partner-tagged user can hit the next step with `telegram_bot_username=NULL` if the verification API is slow.

**Root cause + code path.** `instaclaw/app/(onboarding)/connect/BotVerification.tsx:55` has a `setTimeout(() => router.push("/plan"), 1500)` fired on mount, intended as "show success state for a beat before advancing." But the success state is shown optimistically before `/api/vm/configure` completes; the 1500ms timer wins the race on slow-Anthropic days.

This is the same family as Rule 33's trap-state cascade — a step that paints "complete" before the underlying writes are durable.

**Blast radius.** Same surface as the 2026-05-12 stuck-onboarding incident (Carter Cleveland + 7 others, Edge City). For Edge Esmeralda, with elevated partner-sign-up volume, this is highly likely to produce trap-state users at scale.

**Implementation spec.**
- Replace the unconditional 1500ms timer with: poll `/api/vm/status` until `telegram_bot_username !== null` AND `gateway_url !== null` AND `health_status === 'healthy'`, max 30 polls × 1s = 30s. On success → advance. On timeout → show explicit "still configuring, please wait" UX and surface a "Restart deployment" button (mirrors the `/deploying` retry pattern).
- The route handler at `app/api/vm/configure/route.ts` already returns `health_status` accurately post-Rule 33 fix; the client just needs to poll it.

**Acceptance criteria.**
- BotVerification.tsx no longer advances until `telegram_bot_username` is populated AND `health_status='healthy'`.
- Synthetic test: slow-mock `/api/vm/configure` to 10s; observe page waits, shows progress, advances on completion.
- Zero new trap-state users from this code path in a 7-day soak.

**Priority.** P1.
**Dependencies.** None.
**Effort.** 3–4 hours.

---

### P1-8 — Sola deprecation comment is misleading (lib/ssh.ts:5281-5285)

**One-liner.** A comment in `lib/ssh.ts:5281-5285` says "Sola integration is deprecated dead code" but **the edge-esmeralda skill still routes 100% of calendar reads through `api.sola.day`**. Only the env var is deprecated; the skill is fully active. If Sola stops serving Edge Esmeralda data before 2026-06-27, every Edge attendee's agent will report empty calendars and we won't know why.

**Root cause + code path.** Audit `instaclaw/skills/edge-esmeralda/scripts/calendar.sh` (or equivalent — the skill that reads Edge Esmeralda calendar data). Every fetch goes to `api.sola.day` with no fallback. The 2026-04-xx PR that "deprecated" Sola only removed the env-var override path; the skill's hardcoded base URL remained untouched.

**Blast radius.** Every edge_city VM (~30 at investigation time, will grow with Edge Esmeralda). If Sola goes offline or changes API, Edge attendees see empty calendars across the board. Rule 28-shape: agent then hallucinates a refusal ("I can't access calendar data right now"), users blame InstaClaw.

**Implementation spec.**
- **Audit.** Grep for `api.sola.day` across the skill + scripts. Document every callsite.
- **Fix the comment.** Either (a) remove the misleading "deprecated dead code" line and replace with "**LIVE INTEGRATION** — every Edge Esmeralda calendar read flows through Sola; Sola going down = calendar data outage", or (b) actually deprecate Sola by routing through EdgeOS directly (the proper partner-API path that Francisco intended).
- **Risk mitigation.** Add a fallback path: if Sola returns 5xx or 404, fall through to a direct EdgeOS query (now functional post-DONE-4). The agent should never see "empty calendar" when one of two upstreams is healthy.
- **Monitoring.** New synthetic-probe cron `cron/probe-edge-calendar` (every 30 min during Edge Esmeralda window): hits both Sola and EdgeOS for a known event, alerts P1 if either fails or if data diverges.

**Acceptance criteria.**
- The misleading comment is removed or corrected.
- A Sola outage during a synthetic-probe test triggers a fallback to EdgeOS and the agent successfully returns calendar data.
- An admin alert fires within 30 min of either upstream going down during Edge Esmeralda.

**Priority.** P1 (specifically because Edge Esmeralda starts May 30 and the partner-promised calendar feature has zero redundancy today).
**Dependencies.** DONE-4 (EDGEOS_BEARER_TOKEN must work — required for the fallback path).
**Effort.** 6–8 hours (audit + fallback + probe cron). Lower if we only fix the comment + add monitoring, defer the fallback to P3.

---

### P1-9 — Lesson: partner-supplied secrets must render correctly in a live request before being marked provisioned

**One-liner.** EDGEOS_BEARER_TOKEN was the wrong value for 34 days because the variable was created from a copy-paste of EDGEOS_API_KEY's value. Nothing in our provisioning path verified that the bearer actually authenticated with EdgeOS.

**Root cause + code path.** DONE-4 covers the fix. This entry captures the process gap so it doesn't happen with the next partner secret (Eclipse, Devcon, future Bankr token, etc.).

**Blast radius.** Every partner-secret rotation. We have at least 5 partner secrets today (EDGEOS_API_KEY, EDGEOS_BEARER_TOKEN, BANKR_PARTNER_KEY placeholder, NEWSWORTHY_API_KEY when it arrives, future Eclipse key) and the count grows with each partner. Any one of them silently failing is a 34-day-class incident.

**Implementation spec.**
- **Verification step in `lib/partner-secrets.ts` (NEW)**: for each partner secret, the module exports a `verify_<partner>_<secret>()` function that issues a smoke-test request to the partner API. Returns `{ ok: bool, response_excerpt: string }`. Called by:
  - A one-shot `scripts/_verify-partner-secrets.ts` that runs every secret's verifier and reports.
  - The reconciler's new `stepPartnerSecretsHealth` step (runs once per hour, not every tick — cost-bounded). On failure, push `result.warnings` (non-blocking) AND emit admin alert.
- **Onboarding checklist** in CLAUDE.md operations section: "When a partner sends a new secret, (1) add the verifier function, (2) update Vercel env, (3) run `_verify-partner-secrets.ts <partner>`, (4) only mark provisioned after verifier returns ok."

**Acceptance criteria.**
- Adding a new partner secret in Vercel without a verifier function trips a CI check (or pre-merge review prompt).
- A wrong-value secret is detected by `_verify-partner-secrets.ts` in <60s.
- Synthetic test: set EDGEOS_BEARER_TOKEN back to the old hex string; verifier reports failure and stepPartnerSecretsHealth fires an alert within an hour.

**Priority.** P1.
**Dependencies.** None.
**Effort.** 4–6 hours.

---

### P1-11 — Continuous file reconciliation (closes Rule 47 architectural gap)

**One-liner.** The reconcile-fleet cron's `cv < VM_MANIFEST.version` filter (`app/api/cron/reconcile-fleet/route.ts:272`) means caught-up VMs NEVER receive template-only updates. We hot-patched this for Rule 45 with `_fleet-push-strip-thinking-v3.ts` (REC-4), but every future file-content change has the same gap. Need a structural fix.

**Root cause + code path.** Rule 47 in CLAUDE.md (Root Cause 0.5). The reconciler is "version-gated" — it only runs `stepFiles` when cv is behind. Modern infra (Kubernetes control loops, HashiCorp Nomad drift detection, Ansible pull agents) does **continuous reconciliation** — every cycle compares desired vs actual state regardless of "version". The gate prematurely terminates reconciliation for the population that most needs continuous validation (paying customers running steady-state).

**Blast radius.** Every template change since the version-gated filter shipped. Currently known: the entire fleet was running the OLD strip-thinking.py with the session-backup runaway loop fix landed-but-undeployed for some unknown window before REC-4 caught it. Future shape: ANY file change in `vm-manifest.ts:files[]` or any embedded template in `lib/ssh.ts` propagates only to fresh provisions until a manual fleet-push or version bump.

**Implementation spec.** Two viable approaches:

**Option A (preferred): File-drift cron, separate from reconcile-fleet.**
- New route `app/api/cron/file-drift/route.ts`, schedule every 15 min.
- Iterates over ALL (healthy, assigned) VMs — no cv filter.
- Runs ONLY `stepFiles` (no config-set, no service restart, no cv mutation, no auth-profile work).
- Per-VM hard timeout 30s. Concurrency 5.
- Holds its own cron lock (`instaclaw_cron_locks` row, key="file-drift").
- Logs per-VM drift detection + repair to `instaclaw_reconcile_audit` with `kind="file-drift"`.

**Option B: Remove the cv filter from reconcile-fleet, no-op when already correct.**
- Drop `lt("config_version", VM_MANIFEST.version)` from the batch query.
- Trust each `step*` to no-op cheaply on already-correct state (most already do via verify-before-write).
- Bigger surface area; higher risk of side effects on already-healthy VMs.

Option A is the cleaner choice — it isolates the file-drift concern, has narrower blast radius, and is easier to throttle/disable independently.

**Acceptance criteria.**
- After Option A ships: a synthetic test that overwrites `~/.openclaw/scripts/strip-thinking.py` on one (healthy, assigned, cv=current) VM with junk content auto-recovers within 15 min of the next file-drift cron tick.
- Zero VMs in the fleet have stale embedded templates after 7-day soak (verified via coverage script per Rule 27).
- The file-drift cron never bumps cv — its work is invisible to the cv invariant.

**Priority.** P1 (closes the gap that caused REC-4; without it, every future template change is a manual fleet-push or a manifest bump).
**Dependencies.** None — does not depend on Rule 44 structural fix (P2-7), can ship independently.
**Effort.** 6–10 hours.

**Competitor inspiration.** Kubernetes control-loop pattern (continuous reconcile, no version gate); HashiCorp Nomad's drift detection; Ansible pull-based agents; AWS Systems Manager State Manager.

---

### P1-12 — Harden xmtp surgical fix per Rule 48 (dep probe before restart-only path)

**One-liner.** The `instaclaw-xmtp` surgical fix at `lib/vm-reconcile.ts:4466` rewrites the unit file + restarts but doesn't verify npm deps. vm-912 and vm-904 each crashed >5,000 times in the auto-restart cycle while the reconciler reported "surgical fix failed: activating" every tick.

**Root cause + code path.** Rule 48 in CLAUDE.md (Root Cause 0.6). The probe at `lib/vm-reconcile.ts:4419-4422` checks `unit/active/mjs/key` but not `node_modules`. A VM with `mjs=1 key=1 active=0` is permanently routed to the restart-only surgical path, which can't fix dep corruption.

**Blast radius.** All edge_city VMs (with XMTP partner messaging skill) are exposed. Today: vm-902, vm-912, vm-904 fixed via REC-5. Future shape: any npm package removal/corruption on `~/scripts/node_modules/` (e.g., partial disk-full ENOSPC during install) traps the VM in the same loop.

**Implementation spec.**
- Extend the probe at `lib/vm-reconcile.ts:4419-4422` with:
  ```
  deps=$([ -d ~/scripts/node_modules/@xmtp/agent-sdk ] && [ -f ~/scripts/node_modules/viem/package.json ] && echo 1 || echo 0)
  ```
- Route on `unit + mjs + key + deps`:
  - `unit=1 mjs=1 key=1 deps=1 active=0` → surgical (restart only).
  - `unit=? mjs=1 key=1 deps=0` → **dep-repair path**: `cd ~/scripts && npm install @xmtp/agent-sdk@latest`; if success, restart; route as surgical from there.
  - `mjs=0 OR key=0` → full setupXMTP (existing).
- Update `is-active` check: poll for 60s with 2s interval (matches Rule 43 + REC-5 outcome), exact-string compare `stdout.trim() === "active"` (NOT substring match).
- Detect crash-loop: `systemctl --user show <svc> --property=NRestarts`. If >50, log a loud warning even if eventually `active` — that signals an underlying issue worth investigating.

**Acceptance criteria.**
- Synthetic test: `rm -rf ~/scripts/node_modules` on a staging edge_city VM, run reconciler, observe dep-repair path runs npm install and service comes back active within 90s.
- Zero VMs stuck in `activating (auto-restart)` for >30 min across a 7-day soak.
- The same probe shape generalizes to other services that import npm packages (e.g., dispatch-server, browser-relay) — document as the pattern.

**Priority.** P1.
**Dependencies.** None.
**Effort.** 4–6 hours.

---

### P1-10 — Cloud-init tarball must include `EDGEOS_BEARER_TOKEN` for edge_city partner VMs (integration touchpoint)

**One-liner.** Owned by the onboarding terminal. Tracked here so the snapshot bake doesn't ship without it.

**What's expected.** `lib/cloud-init-tarball.ts` (the modified file in the working tree right now) writes `EDGEOS_BEARER_TOKEN` into `.env` at provision time for new edge_city VMs. Without this, new VMs would launch with the bearer missing until first reconciler tick — partner agents would 401 on every EdgeOS call for the first few minutes of their existence.

**Acceptance criteria for this PRD.**
- Confirm the onboarding terminal's change has merged before the snapshot bake (2026-05-23).
- Add a verify-after-provision check (one-shot SSH-probe) that confirms a freshly-provisioned edge_city VM has `EDGEOS_BEARER_TOKEN` in its `.env` and that the value matches Vercel.

**Priority.** P1 (must ship before partner onboarding scales).
**Dependencies.** Onboarding terminal's PR.
**Effort.** 1 hour of verification on this PRD's side; the actual work is in the onboarding terminal.

---

## 6. Phase 2 — Pre-Snapshot-Bake (ship by 2026-05-23 → 25)

Items here MUST be in the v96+ snapshot. The snapshot bake (planned 2026-05-23–25) freezes a new base image; anything that lives in-VM (scripts, crons, default config, firewall rules) cannot wait for post-launch hot-patches.

**Phase 2 ships first on the calendar (May 23-25 < May 30).**

### P2-1 — Rule 38: atomic-write `.tmp` files must self-clean on ENOSPC

**One-liner.** vm-842 corrupted openclaw.json incident: ENOSPC during `openclaw config set`'s atomic-write left .tmp at 0 bytes, then `os.replace` truncated source. 30+ stale .tmp files found during disk-full cleanup.

**Root cause + code path.** Rule 38. `openclaw config set` does `<path>.tmp + os.replace()`. On ENOSPC, .tmp is left partial. Next call doesn't clean, `.tmp` files accumulate, partial-`.replace` truncates source.

**Blast radius.** Every VM running `openclaw config set` (i.e., every VM) is one disk-full event away from a corrupted openclaw.json that requires `.last-known-good` restoration.

**Implementation spec.**
- **`stepEnospcCleanup` (NEW reconciler step, runs as Step -2 before stepDiskGuard)**: SSH `find ~/.openclaw/ -maxdepth 2 -name "*.tmp" -mtime +0 -size -1M -delete` (only <1MB AND >24h old).
- **Verify after each `openclaw config set` in `stepConfigSettings`**: after `set`, check no `<key path>.tmp` is left behind. If found, delete and re-run set (one retry, then push to errors).
- **Upstream issue with OpenClaw** to make `config set` self-clean its .tmp on EXIT. Track in `project_openclaw_retry_budget_backlog.md` or sibling.

**Acceptance criteria.**
- Synthetic test: fill disk to 100%, attempt `openclaw config set foo bar`, observe .tmp does NOT remain after the failed write.
- Audit: SSH-probe 10 random VMs for `find ~/.openclaw/ -name "*.tmp"`; expect 0 results.

**Priority.** P2.
**Dependencies.** P1-4 (stepDiskGuard).
**Effort.** 3–4 hours.

---

### P2-2 — Rule 37: ENOSPC detection + P0 alerting

**One-liner.** When ENOSPC fires anywhere on a VM, we currently only learn post-mortem. Need real-time signal embedded in the snapshot's in-VM watchdog.

**Root cause + code path.** Rule 37. Multiple log paths surface ENOSPC (gateway journal, strip-thinking.py stderr, openclaw config set stderr). Each is invisible to the cron — by next cron tick the VM may already be in the corrupted state.

**Implementation spec.** Two in-VM layers:
1. **`~/.openclaw/scripts/vm-watchdog.py` (already runs every minute)**: add `disk_pct` field to heartbeat POST. If ≥90%, also POST a P0 alert to `/api/admin/alert`.
2. **`~/.openclaw/scripts/enospc-watch.py` (NEW, every minute)**: tail journal for ENOSPC, on match POST alert immediately.

Both scripts embedded in `vm-manifest.ts` with `requiredSentinels` (Rule 23). Both in the snapshot for new VMs (mandatory; without it, new VMs ship without the safety net).

**Acceptance criteria.**
- Synthetic test: trigger ENOSPC on staging VM; admin alert email/Slack fires within 2 min.
- Coverage: 100% of (healthy, assigned) VMs have `enospc-watch.py` cron entry.

**Priority.** P2.
**Dependencies.** P1-4 (stepDiskGuard); P2-1 (ENOSPC cleanup).
**Effort.** 5–6 hours.

---

### P2-3 — Rule 43: cold-boot health-check wait must scale with plugin count

**One-liner.** edge_city VMs (8 plugins) take ~90s to reach `is-active=active && /health=200` after restart. Hardcoded 120s waits work today but break with more plugins or slower hardware.

**Root cause + code path.** Rule 43. `auditVm` in `scripts/_catch-up-stuck-cohort.ts` has `MAX_AUDIT_RETRIES=12, INTERVAL_MS=10000` = 120s. Plugins each add ~5–10s. Edge VMs are 8 plugins ≈ 60s plugin-load + ~30s baseline = ~90s typical, tail above 120s.

**Implementation spec.**
- Query plugin count at audit start (`openclaw plugins list | wc -l`).
- Compute `audit_timeout_seconds = max(120, 30 + plugin_count * 15)`.
- Cap at per-VM script budget — don't infinitely extend.
- Same logic in `lib/vm-reconcile.ts:stepGatewayRestart` after-restart wait.

**Acceptance criteria.**
- 8-plugin edge_city VM passes audit on first try after restart.
- Stress test: synthetic 10-plugin VM, audit succeeds in ≤165s.

**Priority.** P2.
**Dependencies.** None.
**Effort.** 2–3 hours.

---

### P2-4 — Rule 42: private-repo skill auth fallback (tarball or deploy token)

**One-liner.** Skills installed via `git clone` from private repos depend on in-VM SSH key access. Transient auth blip → broken-sibling state (Rule 24 / vm-729 incident).

**Root cause + code path.** Rule 42. `installAgdpSkill` / `installBankrSkill` / similar in `lib/ssh.ts` shell out to `git clone <ssh-url>`. No fallback to tarball or deploy-token HTTP.

**Implementation spec.**
- 3-tier install order per skill installer:
  1. `git clone <ssh-url>` (primary).
  2. On failure: `git clone https://<deploy-token>@<host>/<repo>` (deploy token in Vercel env).
  3. On failure: `curl -L -H "Authorization: token <PAT>" -o /tmp/skill.tar.gz <archive-url> && tar -xzf`.
- Verify-after-write per Rule 24: `.git/HEAD` OR `SKILL.md` exists, AND for skills with scripts, `scripts/<expected>.sh` exists.
- Deploy token rotation procedure documented in CLAUDE.md.

**Acceptance criteria.**
- Block primary SSH-clone via firewall on staging; observe fallback to deploy-token clone succeeds.
- Run `scripts/_audit-skill-integrity.ts`; expect 100% of expected skills present on (healthy, assigned) VMs.

**Priority.** P2.
**Dependencies.** Deploy tokens provisioned for each private skill repo.
**Effort.** 5–7 hours.

---

### P2-5 — ufw firewall fleet sweep (replaces "node_exporter coverage" framing)

**One-liner.** 149 VMs were invisible to Prometheus because **their ufw firewall blocked the monitoring VM's scrape**, not because node_exporter was missing. The fleet-push script that landed the fix was a `ufw allow` from `66.228.43.140`, not a binary install. This re-frames the misdiagnosis from the 2026-05-11 audit.

**Root cause + code path.** Snapshot baseline ufw config did not include an inbound allow rule for the monitoring VM's IP on port 9100. New VMs ship with ufw enabled by default + a restrictive ruleset. node_exporter was installed and running; just unreachable from outside the VM. Misdiagnosed as "stepNodeExporter ran but didn't land" because the only signal available was "Prometheus target DOWN."

**Blast radius.** Until the 2026-05-14 ufw sweep, every VM's disk-fill / gateway-down / cpu-spike was invisible to monitoring. The 8 batch-2 disk-critical VMs (REC-2) are direct evidence — they'd been at 100% for an unknown duration with no alerting.

**Implementation spec.**
- **Verify the 2026-05-14 fleet-push.** Coverage script: SSH-probe 25 random VMs, run `ufw status | grep 66.228.43.140`. Expect 100%.
- **Bake into snapshot.** Update `lib/vm-manifest.ts` ufw setup step (or the cloud-init tarball) so new VMs ship with the rule. **Without this, every snapshot bake re-creates the 149-VM invisibility problem.**
- **Reconciler verify step.** Add to `stepUfw` (or new `stepUfwScrapeAllow`): verify the allow rule is present, re-add if absent. Push `result.warnings` on miss (non-cv-blocking — monitoring liveness is observability, not service-affecting, per Rule 39).
- **Document the misdiagnosis** in this PRD (already done above) so future operators don't re-derive "missing node_exporter" when the actual diagnosis is firewall.

**Acceptance criteria.**
- 100% of (healthy, assigned) VMs reachable on port 9100 from the monitoring VM.
- Snapshot bake includes the ufw rule by default; freshly-provisioned VM is immediately scrape-visible.
- A wiped VM ufw state self-heals within one reconciler tick.

**Priority.** P2 (must be in snapshot; without it the prometh terminal's investment is fragile).
**Dependencies.** None.
**Effort.** 4–6 hours.

---

### P2-6 — Linode SMTP outbound port note (infra)

**One-liner.** Linode blocks outbound TCP on ports 25, 465, 587 (their default abuse-prevention policy). We use `smtp.resend.com:2587` for transactional email. Document this so the next operator doesn't waste a day debugging "SMTP doesn't work on Linode."

**Root cause + code path.** Linode network policy. Documented in Linode's "Restricted Ports" KB article. Resend exposes 2587 as an alternative for exactly this reason.

**Blast radius.** Any new email-sending feature on the fleet (transactional, alerting, partner notifications). Without the note, someone WILL waste cycles trying ports 25/465/587 before finding 2587.

**Implementation spec.**
- **Add to CLAUDE.md "Infrastructure Notes" section**: an explicit one-paragraph note covering the blocked ports + our Resend-2587 path + the SMTP_RELAY_HOST env var that should always be used (no hardcoded port 587 anywhere in the codebase).
- **Grep the codebase** for any hardcoded `587`, `:465`, `:25`. Replace each with `process.env.SMTP_RELAY_PORT || 2587` or just remove the line.
- **Probe**: a one-shot `scripts/_verify-smtp-egress.ts` that SSH-probes a random VM and confirms `nc -zv smtp.resend.com 2587` succeeds. Run during snapshot-bake verification.

**Acceptance criteria.**
- CLAUDE.md "Infrastructure Notes" has the SMTP-port note.
- No hardcoded SMTP ports outside that note + env var.
- Snapshot bake's verify step confirms outbound 2587 works.

**Priority.** P2 (in snapshot — once it's in CLAUDE.md it lives on; only needs to ship before someone next touches email).
**Dependencies.** None.
**Effort.** 1–2 hours.

---

### P2-7 — Rule 44 (structural fix integration touchpoint)

**One-liner.** Integration tracking for `reconcile-deadline-structural-fix-2026-05-11.md`. Do not re-spec the structural fix here.

**Body.** Vercel cron's 300s function maxDuration is a hard ceiling. The reconciler's 180s strict deadline + per-VM step costs at v95 mean any VM >5 manifest versions behind cannot catch up via cron. Structural fix options:
- (a) Split reconciler into two routes: "single-version step" (cv→cv+1) 5-min cadence + "deep catch-up" 1-hour cadence with longer deadline.
- (b) Queue-based worker (Inngest, Trigger.dev) outside Vercel's function timeout.
- (c) Per-VM resumable reconciliation (checkpoint state mid-tick, resume next tick).

**Integration acceptance criteria for this PRD.**
- Approach chosen + documented in `reconcile-deadline-structural-fix-2026-05-11.md` with a decision date.
- Chosen approach ships before any future manifest bump that would push cv distribution >5 versions wide.
- If still undecided by snapshot bake (May 23), the snapshot-bake checklist must note "fleet drift can recur until structural fix lands" so the team doesn't bake under false assumption of cron-driven recovery.

**Priority.** P2 (structurally, P0 — but tracked by the other PRD's owner).
**Dependencies.** Cooper decision.
**Effort.** Days to weeks depending on approach.

---

### P2-8 — `gbrain` rollout integration touchpoint

**One-liner.** gbrain installation lives in `gbrain-fleet-rollout-2026-05-12.md`. This PRD tracks integration with fleet-health rules.

**Integration acceptance criteria for this PRD.**
- `stepGbrain` (committed in `b1741db5`) must be a no-op for non-allowlisted VMs. Verified via SSH probe.
- gbrain install failures map to `result.warnings` (Rule 39); never block cv.
- Before bumping any manifest version with `stepGbrain` in step order, run coverage script to confirm 100% allowlisted-VM install success rate ≥98%.

**Priority.** P2.
**Dependencies.** Cooper's $300/mo Anthropic spending cap set; GBRAIN_ANTHROPIC_API_KEY in Vercel env all environments.
**Effort.** 0 for this PRD (work in other PRD). Verification: 1 hour.

---

## 7. Phase 3 — Post-Launch (ship by 2026-06-15)

Long-cycle quality-of-life and structural items. Less acute, still real.

### P3-1 — Rule 23 sentinel coverage audit across `vm-manifest.ts:files[]`

**One-liner.** Rule 23 requires `requiredSentinels` on any template entry representing a load-bearing fix. Today only `strip-thinking.py` will have them (after P1-2). Every other template (~30+ entries) is unguarded against stale-cache regression.

**Implementation spec.**
- Walk each entry in `vm-manifest.ts:files[]`. Evaluate whether the template content has any post-fix marker.
- Candidates: `vm-watchdog.py`, `auto-approve-pairing.py`, `push-heartbeat.sh`, `silence-watchdog.py`, SOUL.md components, CAPABILITIES.md components.
- 1–2 unique post-fix sentinels per file (function/class signature + log-line literal per Rule 23).
- Verify the reconciler's pre-write check trips on artificially-stale content.

**Acceptance criteria.**
- ≥80% of `files[]` entries have `requiredSentinels`. Remaining 20% have a one-line comment explaining why no sentinel is appropriate.

**Priority.** P3.
**Dependencies.** None.
**Effort.** 4–6 hours.

---

### P3-2 — `_coverage-*` script suite consolidation

**One-liner.** Rule 27 requires a coverage query for every fleet-wide resource. Consolidate the accumulated scripts into one umbrella with sub-commands.

**Implementation spec.**
- `scripts/_coverage.ts <subcommand>` single entry point.
- Sub-commands: `config-version`, `session-backup`, `disk-pct`, `strip-thinking`, `prctl-subreaper`, `partner-tag`, `bankr-wallet`, `skill:<name>`, `ufw-scrape-allow`, `partner-secrets`.
- Each prints `<count_with> / <count_total> (<pct>%)` + optional histogram.
- Document in CLAUDE.md "Coverage Queries" section.

**Acceptance criteria.**
- During an incident, operator answers "what % of fleet has X" in <30 seconds via one command.

**Priority.** P3.
**Dependencies.** P1-1, P1-2 (those PRs add the first batch of coverage scripts).
**Effort.** 3–4 hours.

---

### P3-3 — Self-healing crons for the in-VM watchdog stack

**One-liner.** If a cron is removed (manual edit, package upgrade, drift), no one finds out until something else breaks. Meta-cron re-installs missing crons.

**Implementation spec.**
- `~/.openclaw/scripts/self-heal-crons.py` every 10 min.
- Canonical list of 7 crons (per Snapshot Creation Process Step 5). For each missing, re-add idempotently via marker pattern.
- Logs `~/.openclaw/logs/self-heal-crons.log`. Reports anomalies via heartbeat.

**Acceptance criteria.**
- Synthetic: manually delete `vm-watchdog.py` cron line; observe self-heal re-adds within 10 min.

**Priority.** P3.
**Dependencies.** Should ship inside the new snapshot.
**Effort.** 3–4 hours.

---

### P3-4 — Coverage dashboard (consolidated UI)

**One-liner.** Coverage is currently "run a script and read stdout." A simple admin page at `/admin/fleet-coverage` aggregates and shows on one screen.

**Implementation spec.**
- Next.js page at `app/admin/fleet-coverage/page.tsx`.
- Calls each `_coverage-*` subcommand server-side (or queries DB directly); renders table: `Resource | Coverage % | Last Updated`.
- 1-min refresh interval. Admin-only (Cooper's email).

**Acceptance criteria.**
- Page loads in <3s, shows all coverage queries.
- Each row links to per-resource detail page with histogram + list of missing VMs.

**Priority.** P3.
**Dependencies.** P3-2 (consolidated coverage script).
**Effort.** 6–8 hours.

---

### P3-5 — Memory-hygiene cron (Rule 29 follow-up)

**One-liner.** "VM fork limits" memory-poisoning incident showed agents persistently re-cite hallucinated diagnoses. Cron that scans MEMORY.md for repeated unfamiliar jargon and flags.

**Implementation spec.**
- `~/.openclaw/scripts/memory-hygiene.py` weekly.
- For each MEMORY.md, count repeated phrases matching `r'(limit|blocked|cannot|unable|forbidden)[^.]{5,100}'`.
- If a phrase appears >5 times AND isn't in system telemetry, inject `<!-- MEMORY_HYGIENE_FLAG: this explanation may be hallucinated; re-investigate next time -->` at the relevant section.
- Optional: surface flagged memories on admin fleet-coverage dashboard.

**Acceptance criteria.**
- Synthetic: inject "VM fork limits" 6 times into staging MEMORY.md; observe the hygiene cron flags within a week.

**Priority.** P3.
**Dependencies.** Cooper's go-ahead (touches user memory; Rule 22 applies — marker comment only, no destructive rewrite).
**Effort.** 5–6 hours.

---

### P3-6 — Session-log + active-tasks write enforcement

**One-liner.** CLAUDE.md "Open P1 Follow-Ups" #3: cross-session memory files (`session-log.md`, `active-tasks.md`) are empty on real user VMs despite SOUL.md instructions. Surface fleet-wide rate; harden if widespread.

**Implementation spec.**
- `scripts/_coverage-session-log.ts`: SSH-probes 25 random VMs, counts how many have non-template content.
- If <50%: harden via strip-thinking.py hook that checks "did session-log.md grow in the last session?" — if not, inject one-time MEMORY.md note prompting the agent.
- Do NOT enforce via destructive rewrite (Rule 22).

**Acceptance criteria.**
- Coverage script returns ground truth; if <50%, harden ships.

**Priority.** P3.
**Dependencies.** None.
**Effort.** 4–6 hours (coverage + diagnosis), more if harden ships.

---

## 8. Cross-Cutting Items

### §8.A — Prometheus / Grafana / Alertmanager stack hardening

#### §8.A.1 — node_exporter coverage (FIX FRAMING — see P2-5)

The 2026-05-11 audit framed this as "149 VMs without node_exporter." Post-2026-05-14, that framing was wrong: node_exporter was installed and running on those VMs; ufw was blocking scrape. P2-5 carries this work.

This entry remains as a placeholder pointer to P2-5 so future readers don't re-derive the misdiagnosis.

---

#### §8.A.2 — Alertmanager + alert routing

**Implementation spec.**
- Wire Alertmanager to PagerDuty (or email/Slack) for P0; Slack for P1; nothing for P2.
- Initial rules: `DiskAlmostFull` (>85% 10m, P1), `DiskCritical` (>95% 2m, P0), `GatewayDown` (no /health 200 for 15m on assigned VM, P0), `ENOSPC` (P2-2 hook, P0), `CronStale` (replenish-pool or reconcile-fleet not run in 30m, P1), `PartnerSecretFailing` (P1-9 hook, P1).
- Source-controlled `monitoring/alertmanager.yml`. No console-edited routes.

**Acceptance criteria.**
- Synthetic alert from each rule fires the correct receiver in <2 min.
- On-call runbook section in CLAUDE.md lists each alert + response procedure.

**Priority.** P2.
**Dependencies.** §8.A.1 / P2-5 (must have scrape coverage first).
**Effort.** 6–8 hours.

---

#### §8.A.3 — Grafana TLS + auth hardening

**Implementation spec.**
- Caddy or Traefik in front of Grafana on monitoring VM (66.228.43.140) terminating TLS via Let's Encrypt.
- Move Grafana to `metrics.instaclaw.io` (CNAME → monitoring VM).
- Grafana OAuth (Google) — only @valtlabs.com / @instaclaw.io accounts.
- Rotate Grafana admin password.

**Acceptance criteria.**
- `https://metrics.instaclaw.io` serves Grafana over TLS, OAuth-protected.
- Plain `http://66.228.43.140:3000` redirects to HTTPS or is firewalled off.

**Priority.** P2 (security posture; the OAuth + TLS work is a discrete chunk).
**Dependencies.** DNS access; Google OAuth client.
**Effort.** 4–6 hours.

---

### §8.B — Test infrastructure (Rule 31 backfill)

**One-liner.** Rule 31 mandates failure-mode tests. Test surface is thin. Pick the highest-impact 3–4 failure modes to harness, then expand.

**Implementation spec.**
- `instaclaw/scripts/test/` directory + Vitest config (or simple tsx runners).
- Three priority tests:
  1. `test_strip_thinking_cooldown.ts` — synthetic session > 200KB, observe Rule 22/30 trim-not-nuke + Rule 45 cooldown bound.
  2. `test_reconciler_strict_vs_nonstrict.ts` — inject verify-after-set failure; observe strict path refuses cv bump AND non-strict path still bumps but logs error (P1-3 acceptance).
  3. `test_disk_guard.ts` — synthetic 92% disk; observe stepDiskGuard purges (P1-4 acceptance).
- CI rule (future): on every PR touching `lib/vm-reconcile.ts` or `lib/ssh.ts`, these tests run.

**Acceptance criteria.**
- Three tests pass locally and (eventually) in CI.
- Test setup time <5 min for a new contributor.

**Priority.** P2.
**Dependencies.** Test fixtures.
**Effort.** 8–10 hours.

---

## 9. Acceptance Definition: "Fleet Healthy"

Per CLAUDE.md, fleet-healthy invariant:

```sql
SELECT count(*)
FROM instaclaw_vms
WHERE health_status = 'healthy'
  AND status = 'assigned'
  AND config_version < (SELECT version FROM vm_manifest_meta);
-- Expected: 0
```

For this PRD to be "done": after all Phase 1 + Phase 2 items ship, that count returns 0 within 12h of any manifest version bump and stays at 0 modulo legitimate transient state (cold-boot, in-flight reconcile).

Secondary invariants:
- Zero VMs at `disk_pct >= 90` for >24h continuously.
- Zero VMs blocked exclusively on a Rule-39-reclassified warning step.
- Auto-advance auto-converges drift within 12h with no human intervention.
- Zero partner secrets failing their verifier (P1-9).
- Edge Esmeralda calendar reads succeed even with Sola down (P1-8 fallback).

---

## 10. Self-Audit Checklist

Before declaring this PRD shipped:

**Shipped items captured with commit hashes:**
- [x] Rule 39 → `187d477f` (DONE-1)
- [x] Rule 41 → `fa0f9a85` + Supabase CHECK constraint (DONE-2)
- [x] Rule 45 → `eaf5617a` (DONE-3; propagation tracked as P1-2)
- [x] EDGEOS_BEARER_TOKEN → `42a1c8d8` + Vercel env update (DONE-4)

**Unimplemented rules covered:**
- [x] Rule 36 → P1-3
- [x] Rule 37 → P2-2
- [x] Rule 38 → P2-1
- [x] Rule 40 → P1-5
- [x] Rule 42 → P2-4
- [x] Rule 43 → P2-3
- [x] Rule 44 → P2-7 (integration with `reconcile-deadline-structural-fix-2026-05-11.md`)
- [x] Rule 46 → P1-4

**New items from 2026-05-14 session:**
- [x] EDGEOS_BEARER_TOKEN root-cause lesson → P1-9 (verifier framework for future partner secrets)
- [x] Sola deprecation comment misleading → P1-8
- [x] 8 additional disk-critical VMs → REC-2 (operational record)
- [x] Linode SMTP outbound port note → P2-6
- [x] ufw firewall (not node_exporter) was the actual blocker → P2-5
- [x] Cloud-init tarball EDGEOS_BEARER_TOKEN inclusion → P1-10 (integration touchpoint)
- [x] Rule 45 propagation gap (vm-902 refill investigation) → REC-3 + REC-4 (resolved via fleet-push)
- [x] Rule 47 architectural gap (template-only updates can't reach caught-up VMs) → P1-11 (continuous reconciliation cron)
- [x] Rule 48 architectural gap (xmtp surgical fix doesn't probe deps) → REC-5 + P1-12 (dep-probe in reconciler)

**Timour partner-feedback items with exact code paths:**
- [x] Timour #4 deployment-lock visibility + `configure_lock_at` race → P1-6
- [x] Timour #6 `BotVerification.tsx:55` 1500ms auto-advance → P1-7
- [x] Timour #14 EdgeOS env-token mismatch → DONE-4 (shipped via `42a1c8d8`)

**Cross-cutting:**
- [x] Prometheus/Grafana/Alertmanager → §8.A (three sub-items; node_exporter framing corrected via P2-5)
- [x] Test infrastructure → §8.B
- [x] Rule 23 backfill (sentinels) → P3-1 (P1-2 mandates it for strip-thinking entry specifically)
- [x] Rule 27 coverage scripts → P3-2 (P1-1, P1-2, P1-4 add the first batch)
- [x] Rule 29 memory hygiene → P3-5
- [x] Self-healing crons → P3-3
- [x] Coverage UI → P3-4
- [x] Session-log enforcement → P3-6

**Process:**
- [x] Phase numbering matches Cooper's spec (Phase 1 = pre-Edge-Esmeralda May 30, Phase 2 = pre-snapshot-bake May 23-25, Phase 3 = post-launch)
- [x] Phase 2 ships first chronologically; explicitly noted at top of doc
- [x] Each item has 8 fields (priority, root cause + code path, blast radius, spec, acceptance criteria, dependencies, effort, one-liner)
- [x] Items ordered by priority within each phase
- [x] Phases gated by external milestones (Edge Esmeralda May 30, snapshot bake May 23-25)
- [x] Cross-references existing PRDs (Rule 44, gbrain, infra upgrade, soul-md-trim, agent-ack-ux, api-cost) — §4 + integration touchpoints
- [x] No duplication with existing PRDs (each cross-reference is to a tracking owner, not a re-spec)

If any checkbox above is unchecked, this PRD is not ready to ship.
