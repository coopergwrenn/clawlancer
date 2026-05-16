# INC-20260516-stale-bundle: 23-hour silent reconcile-fleet halt

**Severity:** P1 (silent cron outage; multiple paying customers affected; no customer downtime but platform changes stalled)
**Detected:** 2026-05-16 ~21:42 UTC (during a separate Rule 39 follow-on diagnostic)
**Resolved:** 2026-05-16 ~22:10 UTC (commit `f49b4e68` deployed, cron resumed within one tick)
**Duration:** ~23 hours from first manifestation (2026-05-15 22:38 UTC) to resolution

---

## 1. Summary

The `reconcile-fleet` cron (every 3 min) was silently halting on a `stale_bundle` integrity-gate false positive for ~23 hours. The platform-side reconciler did NO work during this window: no `config_version` advancements, no manifest changes propagated, no DB bookkeeping updates. Three customers' VMs sat at `cv=0` (never reconciled since first pool-assignment) and one VM (vm-356) sat at `cv=99` waiting for the Rule 39 fix that landed earlier in the day. Customer-facing agents continued running (gateways unchanged) but platform-side improvements (v100 RuntimeMaxSec removal, Rule 39 step-classification, etc.) were stranded.

The root cause was a parser bug in `lib/manifest-integrity.ts:parseCronMarkers`: it claimed to "skip comments" in its docstring but the implementation didn't. A commented-out cron-template entry in `vm-manifest.ts` (kept as documentation for a re-enable runbook) added a phantom `marker:` match, producing a +1 cronMarkers diff between the runtime fingerprint and the parsed-from-GitHub-raw fingerprint. The integrity gate fired `halted: stale_bundle` and the cron exited 503 every tick.

Three deduped admin alerts DID fire at 05:54, 11:57, and 19:27 UTC. They were drowned in the volume of `heartbeat_staleness_sweep` alerts (≈30/day) and went unnoticed until a downstream investigation surfaced the bookkeeping anomaly.

The fix: added a string-literal-aware `stripJsComments` helper and ran the marker source-slice through it before regex extraction. ~80 LOC in one file. SHAs match post-fix; cron resumed within one tick.

---

## 2. Timeline (UTC)

| Time | Event |
|---|---|
| 2026-05-15 ~22:38 | First `stale_bundle` halt (vm-356's `reconcile_first_failure_at` was set just before the halt; no further activity from this VM's perspective after) |
| 2026-05-16 05:54:12 | Stale-bundle alert #1 fires (P0 email, deduped by `stale_bundle:9a4afc5c8d0e5348`). 1:54 AM ET — overnight, missed by Cooper |
| 2026-05-16 10:35 | vm-948 created in pool (still cv=0) |
| 2026-05-16 10:55 | vm-950 created in pool (still cv=0) |
| 2026-05-16 11:57:12 | Stale-bundle alert #2 fires (6h dedup expired). Lost in heartbeat-staleness alert volume |
| 2026-05-16 ~17:30-21:30 | Significant unrelated work shipped to main (Rule 39 audit + conversions, disk 80% alert, dynamic cold-boot wait, coverage script, snapshot_brain upstream issue). All of it bundled correctly; none of it deployed to the fleet via reconcile-fleet because cron was halted |
| 2026-05-16 19:27:40 | Stale-bundle alert #3 fires (6h dedup expired). Lost again in volume |
| 2026-05-16 ~21:42 | I noticed during a Rule 39 ground-truth query: vm-356 stuck at cv=99 (Rule 39 hadn't taken effect after 25 min) AND vm-948/vm-950/vm-953 at cv=0 with NO failure history (never even reached `reconcileVM`) |
| 2026-05-16 ~21:50 | Walked the candidate query — vm-950 was position #1 in the batch; should have been picked up every tick. Concluded the cron must be exiting before per-VM processing |
| 2026-05-16 ~21:55 | Found the manifest-integrity gate at `app/api/cron/reconcile-fleet/route.ts:273-326`. Ran the integrity verifier locally → reported `stale_bundle` with `cronMarkers: +1/-0` |
| 2026-05-16 ~22:00 | Traced the +1 to a commented-out cron entry at `lib/vm-manifest.ts:2125-2129` — the disable-template for `consensus_match_pipeline.py` kept for the re-enable runbook |
| 2026-05-16 ~22:05 | Wrote `stripJsComments` helper + plumbed into `parseCronMarkers`. Local re-verify: SHAs match, `fresh: true` |
| 2026-05-16 ~22:10 | Pushed fix (commit `f49b4e68`). Vercel deployed within ~2 min |
| 2026-05-16 ~22:15 | vm-950 bumped 0 → 100; secret_version 0 → 2. First proof cron resumed |
| 2026-05-16 ~22:30 | vm-953 bumped 0 → 100. Two of three cv=0 VMs cleared |
| 2026-05-16 ~22:35 | Backlog draining at ~1-2 VMs per tick (CONFIG_AUDIT_BATCH_SIZE=3, per-VM cost dominated by fresh-VM provisioning steps) |

---

## 3. Root cause

### 3.1 The parser bug

`lib/manifest-integrity.ts:parseCronMarkers` (pre-fix):

```typescript
/**
 * Extract `marker: "..."` literals from a cronJobs array body. Skips
 * comments and dynamic markers ...
 */
function parseCronMarkers(body: string): string[] {
  const markers: string[] = [];
  const re = /marker:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    markers.push(m[1]);
  }
  return markers;
}
```

The docstring promised "Skips comments" but the code didn't — it just regex-matched `marker:\s*"..."` against the raw source slice. The companion parser for `envVarDefaults` 50 lines above (line 415-417) DID skip `// `-prefixed lines:

```typescript
if (trimmed.startsWith("//") || trimmed.length === 0) continue;
```

So the pattern was known and applied in one parser but not the other. Drift between docstring intent and implementation, where the docstring described the correct behavior but the code regressed.

### 3.2 The trigger

`lib/vm-manifest.ts:2107-2129` contains a documented disable-template for the consensus matching pipeline cron:

```typescript
// ── Consensus matching pipeline ── DISABLED 2026-05-15 ──
// Removed from the manifest so the reconciler stops re-installing the
// cron line after `scripts/_disable-consensus-pipeline-cron.ts` cleared
// it across the fleet. ...
//
// RE-ENABLE: do not improvise. Follow the runbook from start to finish:
//   instaclaw/docs/intent-matchmaking-reenable-runbook.md
// ...
//
// {
//   schedule: "*/30 * * * *",
//   command: "python3 ~/.openclaw/scripts/consensus_match_pipeline.py >> /tmp/consensus_match.log 2>&1",
//   marker: "consensus_match_pipeline.py",
// },
```

The commented-out object literal is intentional — it's the "uncomment to re-enable" template the runbook references. It was added 2026-05-15 alongside the disable script.

The parser's regex matched `marker: "consensus_match_pipeline.py"` inside the comment. Runtime walk (`m.cronJobs.map(j => j.marker)`) correctly ignored the commented entry. Mismatch: 9 markers runtime, 10 markers parser. Fingerprint SHAs diverged. Integrity gate fired.

### 3.3 The integrity gate behavior (correct, as designed)

`app/api/cron/reconcile-fleet/route.ts:294-325` (working as intended given the false-positive input):

```typescript
const integrity = await verifyManifestFreshness(manifestFingerprint(VM_MANIFEST));
if (integrity.ok && !integrity.fresh) {
  // ... log error, fire deduped alert, release lock, return 503 halted
}
```

The integrity check fetches `vm-manifest.ts` from GitHub raw, computes a fingerprint, compares against the bundled-runtime fingerprint. Mismatch = "Vercel-nft cache served stale manifest" → refuse to bump cv (per Rule 23 / Rule 47 — don't propagate work from a manifest that doesn't match production source-of-truth).

The gate is correct in principle. It exists specifically because the Vercel-nft trace cache has shipped stale manifests in the past (commits `5e710334`, `16aa97c9`, `e30c6a78` cite this exact bug). The false positive arose from the parser asymmetry between runtime and source-parsing paths.

---

## 4. Blast radius

**VMs directly stranded by the cron halt:**

| VM | State at detection | Customer impact |
|---|---|---|
| vm-356 (coastalstu@gmail.com) | cv=99 since 2026-05-15 22:38; Rule 39 fix didn't reach | Continued running on v99 systemd unit (had `RuntimeMaxSec=86400`). SIGTERM risk on 24h cycle. No customer-perceived issue but elevated risk |
| vm-948 (kaifahmad32936@gmail.com) | cv=0 since 2026-05-16 ~05:30 | None — agent functional (XMTP / non-Telegram path), 2 cycle calls, BECME token launched, agentbook-registered |
| vm-950 (aulonbehrami3@gmail.com) | cv=0 since 2026-05-16 ~15:20 | None — agent actively used, 10 cycle calls, BECME token launched, AGDP-enabled |
| vm-953 (jonlcadel@gmail.com) | cv=0 since 2026-05-16 ~20:00 | None — agent functional, 7 cycle calls, Telegram-paired |

**Fleet-wide deferred deliverables:**

The following platform changes landed on main but did not propagate to the fleet during the halt window:

- v100 manifest: RuntimeMaxSec removed (prevents scheduled 24h gateway restarts that can SIGTERM in-flight tool turns)
- Rule 39 conversions: 9 result.errors.push sites moved to recordHealWarning (would have unstuck vm-356 in ~6 min if cron were running)
- Rule 43: dynamic cold-boot wait
- Rule 46 phase 1: disk 80% early warning
- snapshot_brain upstream issue doc (no fleet impact)
- gbrain-coverage migration applied + promoted to migrations/ (cron didn't need to deliver — migration was operator-applied)
- HTTP-sidecar coverage script (operator-tool, no fleet delivery)
- gbrain-deep-check cron registered (didn't fire — gated by `GBRAIN_DEEP_CHECK_ENABLED` env)

**What did NOT break (notable):**

- Customer-facing agents — gateways stayed running, message paths unaffected. The cron is a state-propagation worker, not the message path.
- Other crons — `health-check`, `heartbeat-staleness-sweep`, `gbrain-coverage-check`, `vm-lifecycle`, `process-pending` all continued normal operation. The halt was scoped to `reconcile-fleet`.
- Newly-provisioned VMs (vm-948/950/953) successfully completed cloud-init + assignment paths. They just couldn't get cv bumped to current manifest, and so missed every manifest change since 2026-05-15 22:38.

**Net customer downtime:** zero. Net customer experience degradation: zero (none of the deferred changes were customer-visible — they were platform hygiene).

**Net platform impact:** 23h of stalled progress on a critical control loop. Had a customer-down bug landed in the manifest during this window and not been hot-patchable, it could have stayed broken for that full window.

---

## 5. Fix

**Commit:** `f49b4e68` (instaclaw/lib/manifest-integrity.ts, +74/-6 LOC)

**Change shape:**

1. Added `stripJsComments(src: string): string` helper — a string-literal-aware state machine that strips `//` line comments and `/* */` block comments while preserving string/template literal contents. The state-machine approach (rather than regex) is required because the manifest legitimately contains `//` inside command strings (e.g., `curl https://example.com` in cron commands) — naive regex stripping would damage those.

2. Modified `parseCronMarkers` to call `stripJsComments` before regex-extracting markers:

```typescript
function parseCronMarkers(body: string): string[] {
  const markers: string[] = [];
  const cleaned = stripJsComments(body);  // ← new
  const re = /marker:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    markers.push(m[1]);
  }
  return markers;
}
```

3. Docstring on the new helper documents this incident as the motivating case.

**Verification before push:**

- `npx tsc --noEmit` clean
- Local `verifyManifestFreshness(manifestFingerprint(VM_MANIFEST))` → `{ok: true, fresh: true, reason: "verified"}` (was `{ok: true, fresh: false, reason: "stale_bundle", diff_summary: "cronMarkers: +1/-0"}`)
- SHAs identical between runtime fingerprint and remote-source parse

**Verification post-deploy:**

- vm-950 advanced 0 → 100 within one cron tick of the deploy
- vm-953 advanced 0 → 100 in the following tick
- vm-948 remained at cv=0 only because it's behind vm-953 in the batch sort order; expected to drain over the next 1-2 ticks

---

## 6. Detection gap

**What fired:**

```
2026-05-16T05:54:12 stale_bundle:9a4afc5c8d0e5348  diff=cronMarkers: +1/-0
2026-05-16T11:57:12 stale_bundle:9a4afc5c8d0e5348  diff=cronMarkers: +1/-0
2026-05-16T19:27:40 stale_bundle:9a4afc5c8d0e5348  diff=cronMarkers: +1/-0
```

Three P0 alerts over 23 hours, exactly at the 6h dedup boundary (the dedup key is `stale_bundle:${remote_sha}` and the remote SHA was constant throughout the outage).

**Why the alerts weren't acted on:**

1. **Volume drown.** In the same 24h window, the inbox received ~28 `heartbeat_staleness_sweep` alerts (every 30 min, mix of p1/p2/log_only). The volume normalized inbox response. Three stale-bundle alerts at 6h intervals were lost in the noise.

2. **Bad timing.** First alert at 05:54 UTC = 01:54 AM ET. Cooper was asleep. Standard inbox triage at morning would have seen one stale_bundle line among ~12 other overnight alert lines.

3. **No urgency-channel escalation.** Stale-bundle alerts go to email only. No Slack ping, no PagerDuty, no SMS. Email alone for a slow-burn issue gets missed when other email noise is high.

4. **The alert body doesn't surface the cost.** The alert text says "Vercel has cached a stale vm-manifest.ts. Force a redeploy ..." — operator-actionable but doesn't convey "the entire reconciler has been silent for N hours, X VMs stranded."

**Why we caught it eventually:**

Stumbled into it during a separate investigation. The Rule 39 fix (also shipped today) should have unstuck vm-356 within ~6 min. When it didn't, I queried per-VM reconcile timestamps and noticed `reconcile_last_failure_at = 23h ago`. That was the trigger to investigate "is the cron even running?" — which led to the integrity gate finding.

**Detection-gap class:** silent-failure-with-deduped-alert. The signal existed but lacked the volume/urgency to break through baseline noise.

---

## 7. Recommended monitoring improvements

Cooper called out two options in the directive. Both are recommended (defense in depth).

### Option A (quick) — Shorter dedup window for stale_bundle

**Change:** `lib/email.ts:COOLDOWN_HOURS` is currently 6 hours fleet-wide. The stale-bundle alert specifically should have a shorter window, since the trigger is structural (will persist until fix deploys) and the cost of silence is high.

**Proposal:** parameterize cooldown per alert class. Stale-bundle: 30 min (≈10 alerts per shift). Sustained outage shows up as a steady drumbeat that's harder to drown.

**Trade-off:** more inbox volume during outages, but stale_bundle is RARE (this is the second documented instance after the pre-v90 incident in late April). Inbox cost is paid only when there's actually a problem.

**Effort:** ~20 LOC. Add an optional `cooldown_hours_override` parameter to `sendAdminAlertEmail` or to the dedup helper, plumb a 0.5-hour value through stale-bundle's call site.

**Risk:** very low. Cap at 30 min so cooldown still suppresses tight retries.

### Option B (structural) — Heartbeat-based "cron hasn't done real work in N hours" alert

**Change:** add a global "work-done" heartbeat per cron. Separate from the existing cron-lock plumbing (which only tracks lock-acquire / lock-release — doesn't distinguish "cron ran successfully" from "cron ran but did nothing").

**Why this catches what Option A misses:** Option A still relies on the cron's OWN error path to emit a signal. If a cron silently no-ops (e.g., because the candidate query returns 0 rows for an unexpected reason, or because the cron exits early through a code path that doesn't alert), Option A produces no signal. Option B detects ABSENCE of work.

**Proposed shape:**

```typescript
// New schema (migration):
//   instaclaw_cron_health (cron_name TEXT PK, last_work_done_at TIMESTAMPTZ NOT NULL,
//                          last_work_units INTEGER, updated_at TIMESTAMPTZ DEFAULT now())

// In every cron, on successful completion-with-work:
async function recordCronWork(cronName: string, workUnits: number) {
  await getSupabase().from("instaclaw_cron_health").upsert({
    cron_name: cronName,
    last_work_done_at: new Date().toISOString(),
    last_work_units: workUnits,
  }, { onConflict: "cron_name" });
}

// Call from reconcile-fleet's per-VM success branch:
//   if (audited > 0) await recordCronWork("reconcile-fleet", audited);

// New cron OR extension to health-check:
async function checkCronHeartbeats() {
  const expectations = [
    { cron: "reconcile-fleet", max_silence_min: 30 },
    { cron: "process-pending", max_silence_min: 60 },
    { cron: "health-check", max_silence_min: 10 },
    { cron: "vm-lifecycle", max_silence_min: 90 },
    // ... per-cron schedule × tolerance factor
  ];
  for (const { cron, max_silence_min } of expectations) {
    const { data } = await getSupabase()
      .from("instaclaw_cron_health")
      .select("last_work_done_at")
      .eq("cron_name", cron)
      .single();
    if (!data || new Date(data.last_work_done_at).getTime() < Date.now() - max_silence_min * 60_000) {
      // Dedup per (cron, date) — at most 1 alert per cron per day
      await sendAdminAlertEmailDeduped(
        `cron-silent:${cron}:${new Date().toISOString().slice(0,10)}`,
        `[P0] cron silent — ${cron} has done no work for >${max_silence_min}m`,
        `... what to check ...`,
      );
    }
  }
}
```

**Why dedup-by-date works here:** a sustained outage fires exactly 1 alert per cron per day, which is the right urgency level. Cooper's inbox sees "cron-silent:reconcile-fleet:2026-05-16" once, takes action, and doesn't get spammed.

**Trade-off:** requires schema + per-cron instrumentation + a new monitoring cron. The instrumentation is the largest cost — every cron's success path needs a one-line `recordCronWork` call. ~10 crons × 1 line + 1 new monitoring cron + schema migration = ~3 hours of focused work.

**Risk:** medium. The instrumentation could be missed on new crons (operator must remember to add the call). Mitigation: add it to the cron-template / wrap the cron-lock helper so it's automatic when `tryAcquireCronLock` is paired with `releaseCronLockWithWork(work_units)`.

### Implementation order

1. **Ship A this week** (quick, low risk, immediately useful for the next stale_bundle event)
2. **Schedule B for May-23 snapshot bake week** as a P1 task — there's natural infrastructure-work bandwidth then
3. **After B lands, audit existing alerts** for similar "alert exists but lost in volume" patterns. Some can migrate from per-event alerts to heartbeat-style absence-of-event alerts.

---

## 8. Lessons / prevention

### Lesson 1: docstring-vs-implementation drift is its own bug class

The parser claimed to "skip comments" in its docstring. A reviewer reading the code would expect that behavior. The bug was the gap between intent and implementation. **Prevention:** for parser-like code, write a roundtrip test that constructs both commented and uncommented inputs and asserts the parser handles them identically. The asymmetry between `parseCronMarkers` and `envVarDefaults` (the latter correctly stripping `//` lines) would have been caught immediately by such a test.

### Lesson 2: deduped alerts for structural failures need a sustaining drumbeat

A 6h dedup window is right for incidents that auto-resolve (transient API error → retry succeeds 5 min later → no point re-alerting). It's wrong for incidents that DON'T auto-resolve (stale bundle persists until operator action). Differentiate the two classes: transient errors get long dedup; structural errors get short dedup.

### Lesson 3: cron-halt detection requires measuring ABSENCE of work, not presence of errors

Every monitoring approach in our stack measures things that happen: errors fire, alerts dedup, lifecycle events log. We have no signal for "the thing that was supposed to happen, didn't." Option B above is the missing piece. **Prevention rule (CLAUDE.md candidate):** every cron with a critical responsibility (cv propagation, lifecycle, secret rotation, partner-state-sync) MUST emit a "work-done" heartbeat AND a corresponding `cron-silent` alert must exist.

### Lesson 4: don't trust "no alerts means no problem" for slow-burn crons

This is the meta-lesson. Cooper had 3 P0 alerts in his inbox over 23 hours but they were buried in 28 other alerts of similar volume. The signal was there; the priority queue was wrong. **Prevention rule:** rank alert types by severity AND scarcity. A rare alert (stale_bundle: 2 occurrences ever) deserves louder treatment than a common alert (heartbeat_staleness_sweep: ~30/day baseline).

---

## 9. Related rules / follow-up rule candidates

- **Existing Rule 23** (Long-Running Reconcilers Have Stale Module Caches — Sentinel-Grep Required Templates Before Writing) — the same shape of concern (in-memory state diverging from on-disk truth) applies to the manifest-integrity gate itself. The gate exists to catch one direction (Vercel-nft cache serving stale TS); this incident exposed the OTHER direction (parser-asymmetry false positive).
- **Existing Rule 47** (Continuous reconciliation, not version-gated) — when reconciliation pauses, the file-drift cron (which runs continuously for cv-current VMs) keeps working. That partial coverage is what kept the fleet mostly-functional during the 23h window.
- **Candidate new rule** ("Parser docstring matches parser behavior — round-trip test required for parser-like code") — pulled from Lesson 1. Worth elevating if this class of bug recurs.
- **Candidate new rule** ("Critical-cron heartbeat alerts are mandatory") — pulled from Lesson 3. Should ship alongside Option B implementation.

---

## 10. Forensic evidence

**Code state at incident:**
- `lib/manifest-integrity.ts:296-312` (pre-fix `parseCronMarkers` — commit `2b586409` ancestor)
- `lib/vm-manifest.ts:2107-2129` (commented-out cron template — added in some commit between v95 and v100)
- `app/api/cron/reconcile-fleet/route.ts:273-326` (integrity gate — correct as designed; the false positive came from upstream)

**DB state evidence (captured during diagnosis):**
- `reconcile-fleet` cron-lock row: not held (the route releases the lock on stale_bundle exit per route.ts:315)
- vm-356 `reconcile_first_failure_at = reconcile_last_failure_at = 2026-05-15T22:38:26` (one failure, never followed by another touch)
- vm-948/950/953 `reconcile_first_failure_at = NULL` (never reached the per-VM reconcile loop)
- 3 `stale_bundle:9a4afc5c8d0e5348` rows in `instaclaw_admin_alert_log` at 6h intervals

**Post-fix evidence:**
- vm-950: `config_version` 0 → 100, `secret_version` 0 → 2 within first cron tick post-deploy
- vm-953: same shape, following tick
- Local integrity check: `runtime_sha == remote_sha` post-fix

---

## 11. P1 follow-ups (track separately)

- [ ] **Implement Option A** — per-alert-class dedup window override. Stale-bundle: 30 min. (~20 LOC, low risk.)
- [ ] **Implement Option B** — `instaclaw_cron_health` schema + `recordCronWork` helper + `cron-silent:*` alert path. (~3 hours focused work.)
- [ ] **Audit other parsers in `lib/manifest-integrity.ts`** — `parseStringArrayField` and the `envVarDefaults` parser may have similar comment-handling asymmetries. Round-trip test all of them.
- [ ] **Reassess Rule 33 stuck-onboarding heuristic** — the NULL `telegram_bot_token` signal isn't reliable as a trap indicator anymore (XMTP / mini-app / AGDP interfaces don't use Telegram). The user-level `onboarding_complete` flag is the correct signal. Audit any code that uses `vm.telegram_bot_token IS NULL` as a trap indicator.
- [ ] **Add Lesson-3 rule to CLAUDE.md** ("Critical-cron heartbeat alerts are mandatory") if Option B ships and proves the pattern.
