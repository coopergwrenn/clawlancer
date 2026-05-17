# INC-20260517-vm911: 4-day silent customer outage on vm-911

**Severity:** P1 (one paying customer down for 98+ hours, undetected)
**Detected:** 2026-05-17 ~00:13 UTC (via opportunistic "silent-down sweep" during v101 fleet-drain monitoring)
**Resolved:** 2026-05-17 00:23:43 UTC (gateway restored from `.clobbered` backup, `/health=200`)
**Duration:** ~98h from corruption (2026-05-12 21:52 UTC) to detection; ~10 min from detection to recovery

---

## 1. Summary

`vm-911` (assigned to `afshinieyesi@gmail.com`) had a **zero-byte `~/.openclaw/openclaw.json`** from a likely past ENOSPC event on 2026-05-12 21:52 UTC. The gateway crash-looped for 98 hours: every 10 seconds, systemd attempted to start the gateway, the gateway tried to parse the empty config, `JSON5 parse failed: SyntaxError: JSON5: invalid end of input at 1:1`, exited status 1, systemd waited the `RestartSec=10` cooldown, repeated. Forever.

Despite `health_fail_count` reaching **153** (153 consecutive failed health checks across the 98-hour window), zero admin alerts surfaced in a way operators could see. The customer's agent did not respond to a single Telegram message for 4 days, and we found out only by accident during an unrelated monitoring sweep.

This is two distinct failures composed together:

1. **The break**: an old (untraceable in the journal — rotated out) ENOSPC event left `openclaw.json` truncated to 0 bytes during OpenClaw's own atomic-rename config-write path. Disk has been fine since (currently 22%), but the corruption never self-healed. Identical to the failure mode Rule 46 (`stepDiskGuard` + `.tmp` cleanup) was added to *prevent* — but vm-911 stuck at `cv=91` (pre-Rule-46) never got the fix.

2. **The detection gap**: every existing monitoring layer either fired-once-then-silenced (`SUSTAINED_UNHEALTHY_THRESHOLD=6`, `AUTO_RECOVERY_THRESHOLD=10` capped at 1/24h), tried a `systemctl restart` that couldn't fix the underlying config corruption (auto-recovery), or explicitly excluded unhealthy VMs from the recovery loop (`reconcile-fleet/route.ts:264` `health_status='healthy'` filter added 2026-05-09). No layer escalated "still broken after 24h" to a fresh, attention-getting alert.

Fix shipped in this commit: new cron `/api/cron/stuck-unhealthy-customer-alert` runs every 30 min, queries paying-customer VMs unhealthy/unknown for >1h, dedups via 6-hour rotating bucket (so the same VM re-alerts ~16 times over a 4-day window instead of once), pages an admin email with paste-ready diagnostic + restoration commands.

---

## 2. Timeline (UTC)

| Time | Event |
|---|---|
| 2026-05-09 21:42-21:52 | vm-911 normal operation. Multiple `openclaw.json.clobbered.*` files written (OpenClaw's self-rescue saved-aside-bad-versions; ironically these turned out to be the only valid recovery sources). cv=91 manifest era. |
| 2026-05-12 21:52 | `~/.openclaw/openclaw.json` truncated to 0 bytes. Suspected cause: ENOSPC during atomic-rename inside OpenClaw's own config-write path (matches `vm-842` 0-byte pattern from Rule 46 incident; gateway version 2026.4.5 is pre-Rule-46 fix). Disk now fine but the corrupted file persists. |
| 2026-05-12 21:52 → 2026-05-13 ~12:43 | Gateway in undetected crash loop. **Journal entries from this window have been rotated out** (systemd journal default retention). First crash-loop entry we can recover is 2026-05-14 12:43:03. |
| 2026-05-12 → 2026-05-16 | `instaclaw_vms.health_fail_count` accumulates to 153. `health_check` cron's once-at-threshold alerts fire and dedup. `reconcile-fleet` cron's `health_status='healthy'` filter (route.ts:264) excludes vm-911 from candidates → `reconcile_consecutive_failures=0` for the entire window (never attempted). cv stays pinned at 91 while fleet advances 92 → 93 → ... → 101. |
| 2026-05-16 ~21:00 | v101 manifest deploys to fleet. vm-911 is excluded by the eligibility filter; never gets the new `ExecStartPre` chain. |
| 2026-05-17 00:13:10 | `_silent-down-sweep.mjs` (opportunistic operator script run during v101 fleet-drain monitoring) detects vm-911 — `db_status=unhealthy`, `last_health_check=98h39m ago`, gateway shows `active=activating health=000`. |
| 2026-05-17 00:19:51 | SSH-side investigation: journal reveals `JSON5 parse failed: invalid end of input at 1:1`. `stat` confirms `openclaw.json` is 0 bytes since May 12 21:52. |
| 2026-05-17 00:22:13 | Recovery: zero-byte file backed up to `openclaw.json.zero-byte.recovery-bak.2026-05-17`. Latest valid `.clobbered` file (3157 bytes from 2026-05-09T21:52:38) copied into place. `systemctl --user reset-failed openclaw-gateway` to clear `StartLimitBurst=10` cooldown. `systemctl --user restart openclaw-gateway`. |
| 2026-05-17 00:22:18 | systemd starts gateway. ExecStartPre clean (this VM is at cv=91, no v101 orphan-repair invocation yet). |
| 2026-05-17 00:22:25 | Gateway reads restored config. `Config overwrite: ... missing-meta-before-write` — runtime normalizes the restored config, adds missing metadata, writes new sha + backup at `openclaw.json.bak`. Auto-enables Telegram + Anthropic model + browser plugins from the restored entries. |
| 2026-05-17 00:22:34 | HTTP server listening (8 plugins, 11.5s plugin load). |
| 2026-05-17 00:23:43 | `[gateway] ready`. `/health` returns `{"ok":true,"status":"live"}`. NRestarts=0 on the new MainPID. |
| 2026-05-17 00:24:?? | DB updated: `health_status` → `healthy`, `last_health_check` → now. |

---

## 3. Root cause

### 3a. The break (RCA #1)

`openclaw.json` was truncated to 0 bytes at 2026-05-12 21:52 UTC. The journal from that day has been rotated out so we cannot identify the exact trigger event with byte-level certainty, but the file's mtime + size + the pattern matches Rule 46's documented ENOSPC failure mode exactly:

> "vm-842 0-byte-config-file incident, 2026-05-13. The `openclaw.json.NNNNNN.UUID.tmp + rename` atomic write pattern leaves a 0-byte file if ENOSPC fires mid-rename."

Supporting evidence:
- vm-911 OpenClaw version is `v2026.4.5` (per systemd unit description) — pre-dates the Rule 46 / `stepDiskGuard` fixes that auto-clean `.tmp` leftovers.
- Filesystem-level corruption pattern: the file *exists* and is *writable* and has correct ownership/mode (`-rw------- 1 openclaw openclaw 0`), it is simply *empty*. This is the signature of a successful `rename(tmp, target)` where the source `tmp` was 0 bytes — exactly what ENOSPC produces mid-write.
- The disk is now at 22% (fine), but the failure persisted because nothing reconciled the corrupted state. OpenClaw's runtime can detect parse errors but treats them as fatal-on-startup, not as triggers for self-repair.

Multiple `openclaw.json.clobbered.<ISO-timestamp>` files were created on 2026-05-09 21:42-21:52 (a separate earlier failure event where OpenClaw saved aside what it thought was an invalid config). One of these (`.clobbered.2026-05-09T21-52-38-641Z`, 3157 bytes) was the recovery source — it parses cleanly and contains all the critical fields (`gateway.auth.token`, `channels.telegram.botToken`, plugins enabled list).

### 3b. The detection gap (RCA #2)

Six layers of monitoring should have caught a 4-day customer outage. None did, in this specific order of failure:

1. **`health-check` cron — initial alert (line 765)**: `if (newFailCount === ALERT_THRESHOLD)` where `ALERT_THRESHOLD=3`. Fires ONCE at exactly fail_count=3. Likely fired in the first 10 minutes of the outage and got buried in regular email noise.

2. **`health-check` cron — periodic alert (line 685)**: `if (newFailCount >= ALERT_THRESHOLD && newFailCount % ALERT_THRESHOLD === 0)`. Fires every 3 failures while sustained (fail_count=3,6,9,12,...). With `health_fail_count=153`, this should have fired ~50 times. Either it did and got drowned in volume, or `AlertCollector` batching suppressed all but the first few. Without alert-log forensics we cannot tell which — but neither outcome is "actionable signal to operator."

3. **`health-check` cron — sustained-unhealthy escalation (line 783)**: `if (newFailCount === SUSTAINED_UNHEALTHY_THRESHOLD)` where threshold=6. Fires ONCE at exactly fail_count=6. By design this is the "VM has been broken ~30 min" page. Fires once and never again.

4. **`health-check` cron — auto-recovery (line 795)**: `if (newFailCount === AUTO_RECOVERY_THRESHOLD)` where threshold=10, capped at **1 attempt per VM per 24h** via `instaclaw_admin_alert_log`. Attempted `systemctl restart openclaw-gateway` at fail_count=10 (~50 min in). The restart fails because the underlying config is corrupted — `systemctl restart` doesn't fix `JSON5 parse failed`. The dedup key locks further auto-recovery attempts for 24h. No escalation when the auto-recovery itself fails.

5. **`reconcile-fleet` cron**: explicitly filters `health_status='healthy'` (route.ts:264, added 2026-05-09 to fix throughput collapse caused by 45 stale suspended VMs head-of-line blocking). vm-911's `health_status='unhealthy'` excluded it from candidacy. The reconciler **never touched vm-911 in the 98-hour window**. `reconcile_consecutive_failures` stayed at 0 because the reconciler never tried — making `reconcile_quarantined_at`-based escalations unreachable.

6. **`watchdog` cron (Rule 17)**: also uses the same recovery primitives (gateway restart) that don't fix config corruption. Even if it engaged, the underlying issue persists.

No layer answered the question: "Has this VM been unhealthy for 24h despite recovery attempts? Escalate."

### 3c. The cv=91 lag (RCA #3)

Directly downstream of RCA #2: the `health_status='healthy'` filter at `reconcile-fleet/route.ts:264` made vm-911 invisible to the reconciler from the moment it went unhealthy. Across the 98-hour window the fleet advanced cv=92 → cv=101 (10 manifest versions). vm-911 received none of these. This includes:
- v100's `RuntimeMaxSec` removal (would have helped — though wouldn't have fixed the underlying corruption)
- v101's orphan-repair `ExecStartPre` chain (ironically, this fix WOULD have detected and run on each gateway restart attempt, surfacing more diagnostic data)

The filter was added for good reason (vm-726-class SSH-broken-but-TCP-reachable VMs were eating cron budget and starving healthy VMs). The right answer is not to revert the filter — it's to add a separate, lower-frequency recovery path for stuck-unhealthy paying VMs.

---

## 4. Blast radius

- **Customers impacted (direct):** 1 (`afshinieyesi@gmail.com`)
- **Duration:** 98h 39m (2026-05-12 21:52 → 2026-05-17 00:31, end-to-end including DB cleanup)
- **Lost messages:** unknown (no Telegram-side logs accessible from this terminal). Likely double-digit user messages went silently undelivered.
- **Other VMs in same failure mode:** Zero confirmed. Fleet-wide SSH sweep of 249 VMs found 0 other zero-byte openclaw.json files. vm-911 was unique. The post-Rule-46 fleet (cv≥92) is protected; vm-911 was uniquely vulnerable because it never got the v92+ updates.
- **Sibling false-positive caught during the sweep:** `vm-921` (msgduel@gmail.com) had `health_status='unhealthy'` for 26h despite the gateway being healthy for 23h with 0 restarts. DB lie, not customer impact. Cleaned up in the same recovery cycle.

---

## 5. Detection gap explained in one sentence

Every existing monitor either fires **once and dedups**, or **tries a recovery that can't fix this specific failure mode**, or **explicitly excludes unhealthy VMs from the recovery loop** — and no layer escalates "still broken after 24h despite recovery attempts."

---

## 6. Fix

### Shipped this commit

New cron: **`/api/cron/stuck-unhealthy-customer-alert`** — runs every 30 minutes.

```
1. Query: paying-customer VMs (status='assigned', provider='linode',
   health_status IN ('unhealthy','unknown'), last_health_check < now()-1h,
   assigned_to IS NOT NULL).
2. For each: compute hours_stuck. Tag as P1-shape if ≥24h.
3. Dedup via instaclaw_admin_alert_log with key
   `stuck_unhealthy:<vm-id>:<6h-bucket>`. Across a 4-day outage this fires
   ~16 alerts — impossible to miss as a class even if individual emails
   get buried.
4. Send admin alert email with VM info, customer email, paste-ready
   diagnostic SSH commands, and the vm-911 recovery recipe inline (so
   the next operator who sees this doesn't have to re-derive it).
```

File: `app/api/cron/stuck-unhealthy-customer-alert/route.ts`
Schedule: `*/30 * * * *` (registered in `vercel.json`)
Email template: uses existing `sendAdminAlertEmail` from `lib/email.ts`.
Dedup: `instaclaw_admin_alert_log` (existing table, existing pattern).

### Shipped same-day (2026-05-17): auto-recovery cron

**`/api/cron/stuck-vm-auto-recover`** ships in the same session as a sibling to the alert cron.

Pipeline:
- Alert cron (every 30 min) pages humans at 1h-stuck.
- Auto-recovery cron (every 15 min) waits another hour (2h-stuck total) before attempting automated fix.
- Recovery is SCOPED to the 0-byte `openclaw.json` pattern only (this incident's signature). Any other failure mode → skip (`AUTO_RECOVERY_SKIP_NOT_ZERO_BYTE`); the alert cron continues paging humans.

Recovery recipe (validated against vm-911 manual recovery 2026-05-17 00:22 UTC, embedded as a single atomic bash command via SSH):

1. Confirm `openclaw.json` is exactly 0 bytes (false-positive guard).
2. Find latest `openclaw.json.clobbered.<ISO-timestamp>` with size ≥100 bytes AND parses as valid JSON.
3. Backup current 0-byte → `openclaw.json.zero-byte-bak.<ts>`.
4. Copy clobbered → openclaw.json.
5. `systemctl --user reset-failed openclaw-gateway` (clear `StartLimitBurst` cooldown).
6. `systemctl --user restart openclaw-gateway`.
7. Poll `is-active=active` AND `/health=200` for up to 120s.
8. On success: update DB `health_status='healthy'`, page admin success email.
9. On failure: page admin with specific failure code + remediation guidance.

Safety: 1 attempt per VM per 24h via `instaclaw_admin_alert_log` dedup. MAX_VMS_PER_RUN=3 caps blast radius per cron tick. Backup is created BEFORE any mutation. The `connectSSH` duplicate-IP guard prevents writing to the wrong VM.

End-to-end timing improvement:
- vm-911 (manual): 98h to detection + 10min to recovery = **98h 10min total**
- Post-fix: 2h to first recovery attempt + ~90s SSH-side execution = **~2h 1.5min worst case** (50× improvement on resolution time)

### Out of scope (separate follow-ups)
- **Reconciler should attempt unhealthy paying-customer VMs** — separate parallel pass at lower frequency (e.g., once/hour, max 5 VMs per run, with longer per-VM timeout). Lifts the route.ts:264 filter for a narrow subset without re-introducing the throughput collapse the filter was designed to prevent.
- **Watchdog escalation when restart attempts repeatedly fail** — current `cron/watchdog` retries restart but does not page when the restart itself doesn't recover the gateway. Should emit a distinct alert: "watchdog attempted N restarts on vm-X across N hours, none succeeded."

---

## 7. Lessons

1. **Once-per-incident alerts are a detection-gap pattern.** If an alert fires at fail_count=6 and never again, a sustained failure looks identical to a transient blip after the dedup window. Use rotating-bucket dedup (re-alert every N hours while still broken) for any condition that represents customer impact. Applied here via the 6-hour bucket key.

2. **Recovery actions must escalate on repeated failure.** `cron/health-check`'s auto-recovery is capped at 1 attempt per VM per 24h. That is correct for noise control but WRONG when paired with no escalation-on-failure. Either (a) increase retry frequency with backoff, OR (b) emit a paging alert when the capped attempt didn't succeed.

3. **Eligibility filters that exclude unhealthy state from auto-fix loops need a sibling "stuck unhealthy" sweep.** `reconcile-fleet/route.ts:264` (`health_status='healthy'` filter) was the right call for throughput, but the filter created a class of VMs the reconciler is *prohibited from helping*. Every such filter needs a documented sibling recovery path for the excluded subset. The new cron is that sibling for `unhealthy + paying customer`.

4. **`systemctl restart` is not a universal recovery primitive.** It fixes transient gateway crashes, hung-on-init processes, and OOM-killed daemons. It cannot fix corrupted on-disk state. Auto-recovery should detect failure-mode signatures BEFORE choosing a recovery action — e.g., "if `journalctl -u openclaw-gateway` contains `JSON5 parse failed`, restart will not help; restore from `.clobbered` instead."

5. **The cv=91 isolation is a load-bearing signal.** Any VM 5+ versions behind the manifest is either quarantined, broken, or excluded by some filter. Operators should treat `cv < MANIFEST.version - 5` as a tier-1 signal for investigation. A periodic `_coverage-cv-distribution.ts`-style sweep would surface this.

6. **The detection gap was found by accident, not by monitoring.** vm-911 was discovered during an opportunistic silent-down sweep run by an operator (me) who was checking a different thing. Production fleet observability should not depend on operators going looking. The new cron makes "did anything go unhealthy for 1h" a paged event, not a stumbled-upon one.

---

## 8. Forensic evidence

Preserved on `vm-911` (`66.175.210.93`) until purge:
- `/home/openclaw/.openclaw/openclaw.json.zero-byte.recovery-bak.2026-05-17` — the 0-byte file as it was at recovery time
- `/home/openclaw/.openclaw/openclaw.json.clobbered.2026-05-09T21-52-38-641Z` — the recovery source (3157 bytes, valid JSON)
- `journalctl --user -u openclaw-gateway --since "2026-05-14"` — the crash-loop journal entries that survived rotation

DB state (preserved by the row itself until updated):
- `instaclaw_vms.health_fail_count = 153` (visible to anyone querying this VM)
- `instaclaw_vms.reconcile_consecutive_failures = 0` (the smoking gun: reconciler never tried)
- `instaclaw_vms.config_version = 91` (10 versions behind fleet)
