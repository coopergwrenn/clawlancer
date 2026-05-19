# gbrain fleet rollout — canary plan

**Date**: 2026-05-19
**Status**: Plan. Implementation begins immediately after this doc lands on main.
**Goal**: Get gbrain to every InstaClaw user via phased rollout, starting with a 17-VM Pro/Power canary cohort.
**Esmeralda window**: 11 days from today (May 30 kickoff). Plan must complete fleet-wide rollout by May 25 for a 5-day buffer.

---

## 1. Context

**Today's state.**
- 146 healthy+assigned VMs across the fleet
- 9 edge_city VMs running gbrain v0.36.3.0 (deployed today, ~6h soak)
- 137 non-edge VMs without gbrain (137 = 99 starter + 23 pro + 13 power + 2 misc)
- All 146 VMs at cv=105 (about 24 already at cv=106 from the manifest bump today)
- `GBRAIN_PARTNER_ALLOWLIST = {"edge_city"}` is the current gate

**Why canary now, not big bang.**
- gbrain v0.36.3.0 has 6 hours of fleet evidence on 9 edge VMs. That's not enough soak.
- Non-edge Pro/Power VMs may have different system load profiles than edge_city (different agent personas, different MCP server mixes, different user message patterns).
- A 17-VM canary surfaces 90% of likely issues with 10% of the blast radius. If something breaks, we have 17 paying customers to triage instead of 146.
- Cooper's explicit call: phased, not big-bang.

**Why now, not after Esmeralda.**
- Every InstaClaw user benefits from persistent memory — the entire product becomes more useful when "remember my birthday" actually works the next session.
- Rolling out during the Esmeralda window means gbrain becomes a Esmeralda feature for non-edge users too (anyone signing up because of Esmeralda buzz gets the feature on day one).
- Waiting until after Esmeralda is the conservative choice but loses ~3 weeks of fleet-wide memory utility for no gain (the canary signal will be as clean now as in 3 weeks).

---

## 2. Canary cohort (17 VMs)

### Selection criteria

All filters applied (AND):
- `partner IS NULL` (not edge_city, which already has gbrain)
- `health_status = 'healthy'` AND `status = 'assigned'`
- `config_version >= 105` (current or current−1, has TasksMax bump etc.)
- `tier IN ('pro', 'power')` (active users + revenue weighting → fastest signal)
- `last_proxy_call_at` within last 24h (proves proxy + heartbeat infrastructure are alive)
- `watchdog_quarantined_at IS NULL` (no known issues)
- `suspended_at IS NULL` (not in grace/freeze flow)
- `frozen_image_id IS NULL` (not pending thaw)
- `reconcile_consecutive_failures = 0` (clean reconcile history)

### Cohort split

| Subset | Count | Selection rationale |
|---|---|---|
| Active (prior `last_user_activity_at` set) | 12 | Behavior signal — these users have used the agent before, more likely to message again and exercise gbrain |
| Dormant (`last_user_activity_at` NULL) | 5 | Broader coverage — paying Pro/Power customers who haven't engaged yet; tests "fresh-eyes" reaction if/when they return |
| **Total** | **17** | |

### The 17 VMs

**Active subset (12 — Power: 6, Pro: 6):**

| VM | Tier | cv | Region | IP | Last user activity | Last proxy call |
|---|---|---|---|---|---|---|
| instaclaw-vm-602 | power | 106 | us-east | 45.79.150.118 | 2026-05-02T14:22 | 2026-05-19T19:47 |
| instaclaw-vm-517 | pro   | 106 | us-east | 45.79.173.214 | 2026-05-02T13:01 | 2026-05-19T19:44 |
| instaclaw-vm-320 | pro   | 105 | us-east | 45.79.160.199 | 2026-05-02T13:42 | 2026-05-19T19:42 |
| instaclaw-vm-295 | pro   | 106 | us-ord  | 172.237.157.159 | 2026-05-02T14:07 | 2026-05-19T19:32 |
| instaclaw-vm-073 | power | 105 | us-west | 45.33.110.94 | 2026-05-02T12:14 | 2026-05-19T18:14 |
| instaclaw-vm-733 | power | 105 | us-east | 172.104.15.146 | 2026-05-02T12:45 | 2026-05-19T17:46 |
| instaclaw-vm-880 | power | 105 | us-east | 45.33.72.245 | 2026-05-02T11:31 | 2026-05-19T17:31 |
| instaclaw-vm-855 | power | 105 | us-east | 96.126.106.246 | 2026-05-02T13:12 | 2026-05-19T17:31 |
| instaclaw-vm-872 | pro   | 105 | us-east | 192.155.91.129 | 2026-05-02T13:12 | 2026-05-19T17:31 |
| instaclaw-vm-634 | pro   | 105 | us-east | 69.164.210.237 | 2026-05-02T14:09 | 2026-05-19T17:26 |
| instaclaw-vm-561 | pro   | 105 | us-east | 45.56.105.25 | 2026-05-02T12:00 | 2026-05-19T16:38 |
| instaclaw-vm-912 | power | 106 | us-east | 173.255.227.194 | (epoch zero — effectively never) | 2026-05-19T20:00 |

**Dormant subset (5 — Power: 3, Pro: 2):**

| VM | Tier | cv | Region | IP | Last user activity | Last proxy call |
|---|---|---|---|---|---|---|
| instaclaw-vm-929 | power | 106 | us-east | 50.116.54.202 | never | 2026-05-19T20:00 |
| instaclaw-vm-913 | pro   | 106 | us-east | 173.255.227.211 | never | 2026-05-19T20:00 |
| instaclaw-vm-893 | pro   | 106 | us-east | 45.56.109.213 | never | 2026-05-19T20:00 |
| instaclaw-vm-935 | power | 106 | us-east | 173.255.229.222 | never | 2026-05-19T19:59 |
| instaclaw-vm-904 | power | 105 | us-east | 172.104.24.104 | never | 2026-05-19T17:31 |

### Cohort diversity

| Dimension | Distribution |
|---|---|
| Tier | Power: 9, Pro: 8 |
| Region | us-east: 15, us-ord: 1, us-west: 1 |
| Server type | g6-dedicated-2: 16, g6-standard-4: 1 |
| cv (pre-deploy) | 106: 8, 105: 9 |

The us-east concentration is a fleet-wide bias, not a cohort selection bias. The single us-ord (vm-295) and us-west (vm-073) provide minimal geographic diversity; not enough to detect region-specific issues at this scale, but enough to flag obvious cross-region problems.

vm-872 on `g6-standard-4` (shared CPU) is the only non-dedicated server in the cohort. Useful: tests whether gbrain works on the legacy shared-CPU instance type.

### Why not include starter tier in canary

Starter tier is 99 of 137 = 72% of the non-edge fleet. They WILL get gbrain eventually. Excluded from canary because:
1. Lower revenue per VM = lower incentive to verify if canary reveals issues
2. Less likely to actively use the agent (lower-tier engagement pattern)
3. Larger pool = canary effort would dilute across less-actionable signal

Phase 2 (post-canary) will include starter tier in the broader cohort.

---

## 3. Gating mechanism

### Decision: new `gbrain_enabled BOOLEAN` column + `isGbrainEligibleForVM(vm)` helper

Evaluated alternatives:
- **Widen `GBRAIN_PARTNER_ALLOWLIST` to include `null`** — too broad. Hits all 137 non-edge VMs at once. Not a canary.
- **VM name allowlist in code** — brittle. Every cohort change requires a code commit + Vercel deploy. Doesn't scale past a few cohort iterations.
- **Env var with comma-separated VM names** — same brittleness as code allowlist, less reviewable.
- **Cohort tag (new partner-style label like "gbrain_canary")** — semantic overload of the partner field. Pollutes the partner concept which has meaningful integrations (Edge Esmeralda skill, Consensus stub, etc.).
- **Separate cohort table** — overkill for a single boolean.

### Why column + helper wins

- **Reversible per-VM** without code change. `UPDATE instaclaw_vms SET gbrain_enabled = false WHERE name = 'instaclaw-vm-X'` disables canary on one VM during incident triage.
- **Scales cleanly**. Phase 2 adds 30 more VMs by `UPDATE instaclaw_vms SET gbrain_enabled = true WHERE ... AND name IN (...)`. Phase 3 adds the rest by `UPDATE instaclaw_vms SET gbrain_enabled = true WHERE health_status = 'healthy' AND status = 'assigned' AND partner IS NULL AND gbrain_enabled IS NULL`.
- **Collapses to "everyone" with one statement**. When ready for the final mile: change the helper's default predicate from "partner allowlist only" to "all healthy+assigned" — single PR. The column stays as the per-VM opt-out mechanism for any VM we explicitly disable (e.g., one that has a hardware issue).
- **Survives existing fleet operations**. Existing `partner` checks in stepGbrain stay correct (edge_city always eligible). Adding a column doesn't break any existing query.
- **Auditable**. We can always query "which VMs were in the canary" by `WHERE gbrain_enabled = true`. Doing this with VM name lists is messy.

### Column schema

```sql
ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS gbrain_enabled BOOLEAN DEFAULT NULL;

CREATE INDEX IF NOT EXISTS instaclaw_vms_gbrain_enabled_partial
  ON instaclaw_vms (id)
  WHERE gbrain_enabled = true;
```

Three states (intentional, per Rule 22-style preserve-options thinking):
- `NULL` (default) — "follow the partner allowlist" (current behavior for non-edge VMs: skip; for edge_city: install)
- `true` — "explicitly enable" (canary cohort)
- `false` — "explicitly disable" (rollback hatch for specific VMs)

Partial index on `gbrain_enabled = true` keeps the canary lookup cheap without bloating the index on the null majority.

### Helper function

```typescript
// lib/vm-reconcile.ts
export function isGbrainEligibleForVM(
  vm: VMRecord & { partner?: string | null; gbrain_enabled?: boolean | null },
): boolean {
  // Explicit overrides take precedence over partner-allowlist default.
  if (vm.gbrain_enabled === false) return false;  // explicit disable (rollback hatch)
  if (vm.gbrain_enabled === true) return true;    // explicit enable (canary)
  // NULL → fall back to partner allowlist (current behavior preserved)
  return Boolean(vm.partner && GBRAIN_PARTNER_ALLOWLIST.has(vm.partner));
}
```

### Refactor — 4 callsites

| Callsite | Current gate | After |
|---|---|---|
| `stepGbrain` (line 1626) | `!vm.partner \|\| !GBRAIN_PARTNER_ALLOWLIST.has(vm.partner)` | `!isGbrainEligibleForVM(vm)` |
| `stepDeployGbrainSoulProtocol` (line 7619) | partner-allowlist check (added today, commit `44815460`) | `!isGbrainEligibleForVM(vm)` |
| `stepDeployGbrainSoulRouting` (line 7868) | partner-allowlist check (v106 today) | `!isGbrainEligibleForVM(vm)` |
| `configureOpenClaw` (lib/ssh.ts:6113) | partner-allowlist check (v106 today) | `isGbrainEligibleForVM(vm)` |

All 4 callsites change identically. The new helper centralizes the policy.

### Manifest version bump v106 → v107

Required per Rule 47: "Any version-gated behavior in a reconciler step". The new helper changes step behavior for VMs at any cv (gates are evaluated at every reconcile). For VMs already at cv=106 (24 fleet-wide, 8 in our canary cohort), the reconciler's `lt("config_version", VM_MANIFEST.version)` filter excludes them; without a bump, the canary cohort wouldn't be re-reconciled to install gbrain.

After v107 bump: all 146 VMs re-enter the candidate queue. For the 17 canary VMs (gbrain_enabled=true), stepGbrain installs gbrain. For the 120 non-canary non-edge VMs (gbrain_enabled NULL, partner NULL), helper returns false → no-op skip. For the 9 edge VMs (gbrain_enabled NULL, partner=edge_city), helper returns true → idempotent marker skip.

Net cost of v107: ~120 reconcile cycles do nothing (cheap), ~9 idempotent-skip, ~17 install gbrain.

---

## 4. Implementation plan

### Sequence

1. **Migration** — `supabase/pending_migrations/20260519220000_vm_gbrain_enabled.sql`. Apply to prod BEFORE merging the code (Rule 56). Idempotent `ADD COLUMN IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`.
2. **Code change** — helper in `lib/vm-reconcile.ts` + 4 callsite refactors + manifest bump v106→v107 + changelog docblock entry.
3. **Move migration** — `git mv pending_migrations/...sql migrations/...sql` (per Rule 56 only after prod-applied).
4. **Commit + push** — single coordinated commit. Wait for Vercel deploy (~5 min).
5. **Pre-flight probe** — SSH the 17 cohort VMs, verify they have all gbrain prerequisites (bun installable, sudo, disk space, etc.).
6. **Enable canary** — `UPDATE instaclaw_vms SET gbrain_enabled = true WHERE name IN (...)`.
7. **Monitor** — first monitoring tick within 5 min of UPDATE to catch any immediate failures. Then every 1h for 48h.
8. **Daily report** — `_monitor-gbrain-canary.ts` produces structured JSON + human summary, saved to `/tmp/canary-day-N.json` for diff over time.

### Pre-flight probe

Before the UPDATE, run a script across the cohort to verify:
- gbrain.service NOT already present (no stale install)
- bun NOT already pinned to a wrong version
- disk free > 5 GB (gbrain install + bun + brain.pglite need ~500 MB)
- memory free > 1 GB
- TasksMax=120 confirmed (should be from v86; verify on disk)
- openclaw.json exists and isn't malformed
- sudo passwordless works (needed for systemd drop-ins)
- /health = 200 (gateway alive)

Any VM failing the pre-flight: skip + log. Replace with a backup candidate or proceed with N-1.

### Migration content

```sql
-- 20260519220000_vm_gbrain_enabled.sql
-- Add gbrain_enabled column for fleet rollout canary mechanism.
-- See docs/prd/gbrain-fleet-rollout-canary-2026-05-19.md.

ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS gbrain_enabled BOOLEAN DEFAULT NULL;

CREATE INDEX IF NOT EXISTS instaclaw_vms_gbrain_enabled_partial
  ON instaclaw_vms (id)
  WHERE gbrain_enabled = true;

COMMENT ON COLUMN instaclaw_vms.gbrain_enabled IS
  'Three-state gbrain canary opt-in. NULL = follow partner allowlist (default); true = canary enable; false = explicit disable (rollback hatch). See isGbrainEligibleForVM in lib/vm-reconcile.ts.';
```

---

## 5. Monitoring plan

### Signals to watch (24/48h soak)

| Signal | Source | Healthy | Alert threshold |
|---|---|---|---|
| gbrain.service state | `systemctl --user is-active` | active | any non-active for >5min |
| gbrain.service NRestarts | `systemctl --user show ... NRestarts` | stays at initial | +1 within 24h |
| gbrain /health | `curl http://127.0.0.1:3131/health` | 200 + JSON | non-200 for >2 consecutive ticks |
| pg_control freshness | `stat -c %Y brain.pglite/global/pg_control` | mtime < 60 min old | >60 min stale → checkpoint cron broken |
| pg_control cron log | `tail ~/.openclaw/logs/pglite-checkpoint.log` | recent `ok latency_ms=` lines | recent `FAILED` lines |
| Gateway /health | `curl http://localhost:18789/health` | 200 | non-200 (always was the regression signal) |
| Gateway latency | tail of journal proxy timings | unchanged from pre-gbrain baseline | p95 delta > 30% |
| System memory | `free -m` (or node_exporter `node_memory_MemAvailable_bytes`) | > 1GB free | < 500MB free |
| Disk usage | `df -h /` | < 80% | > 85% |
| CPU idle % | node_exporter `node_cpu_seconds_total{mode=idle}` | > 50% sustained | < 30% sustained for >10min |
| gbrain MCP page count | `tools/call name=list_pages` count | grows over time (proof of utility) | static for 24h on active-subset VMs |

### Build the monitoring script

`scripts/_monitor-gbrain-canary.ts` — parallel SSH probe (concurrency 5) across the cohort. For each VM:

1. Capture all signals above as a JSON record
2. Compare to previous snapshot at `/tmp/canary-baseline.json` (saved at deploy moment)
3. Compute deltas, flag any over threshold
4. Output human summary + machine-readable diff
5. Exit code: 0 if all green, 1 if any threshold breached

Runs from operator laptop (or future Vercel cron). Idempotent. No state on the VMs.

### Existing infrastructure leverage

- **Prometheus + node_exporter on 66.228.43.140**: already collects memory, disk, CPU. Use existing scrapes — no new agents.
- **Alertmanager rules**: already covers `DiskCritical`, `GatewayDown`, `HighMemory`, `HighCPU`, `NodeExporterDown`. These fire fleet-wide; canary VMs benefit automatically.
- **textfile-collector openclaw_gateway.prom**: per-VM gateway health metric (deployed 2026-05-14). Existing `GatewayDown` alert fires if any VM's gateway stops.
- **fleet-health pg_cron job** (`fleet-health-check`): hourly snapshot of cv-distribution, health-status counts. Already in place.
- **pglite-checkpoint cron + ExecStop hook** (v0.36.3.0): already deployed on edge_city VMs; will land on canary VMs the moment gbrain installs.

What we're ADDING is the canary-specific monitor script — a thin layer over existing infrastructure that aggregates signals per-VM and computes deltas vs baseline.

### Notification on alert breach

The monitoring script doesn't need its own alerting — Prometheus/Alertmanager handles fleet-wide alerts. For canary-specific signals (page_count, gbrain /health, checkpoint cron freshness), the script emits a structured log line that an operator reviews on each tick:

```
CANARY_ALERT vm=instaclaw-vm-602 signal=gbrain_service_state value=failed threshold=active baseline=active
```

Initial cadence: operator runs the script manually after the UPDATE, then every ~6h for the first 24h, then ~daily through the soak. Future iteration: wire into a Vercel cron that runs every 1h and pages on threshold breach.

---

## 6. Rollback plan

### Per-VM rollback (one VM showing issues)

Fast path (~30 seconds):

```sql
UPDATE instaclaw_vms SET gbrain_enabled = false WHERE name = 'instaclaw-vm-X';
```

Then SSH to the VM:

```bash
systemctl --user stop gbrain.service
systemctl --user disable gbrain.service
# Brain.pglite stays on disk — recoverable later if we want to re-enable
# DO NOT wipe brain.pglite — Rule 22 / Rule 54 preserve user data
```

Next reconciler tick: `isGbrainEligibleForVM` returns false → stepGbrain, stepDeployGbrainSoulProtocol, stepDeployGbrainSoulRouting all gate-skip. SOUL.md marker block stays (no removal logic; agent gracefully degrades per the routing block's "If gbrain is unavailable" clause). cv stays at v107.

User experience: agent reads SOUL.md → tries `gbrain__put_page` → MCP error → "I tried to save that but my memory tool is down" fallback message. Slight degradation, but agent stays functional.

### Cohort-wide rollback (canary fails)

```sql
UPDATE instaclaw_vms SET gbrain_enabled = false 
  WHERE name IN (
    'instaclaw-vm-602', 'instaclaw-vm-517', 'instaclaw-vm-320',
    'instaclaw-vm-295', 'instaclaw-vm-073', 'instaclaw-vm-733',
    'instaclaw-vm-880', 'instaclaw-vm-855', 'instaclaw-vm-872',
    'instaclaw-vm-634', 'instaclaw-vm-561', 'instaclaw-vm-912',
    'instaclaw-vm-929', 'instaclaw-vm-913', 'instaclaw-vm-893',
    'instaclaw-vm-935', 'instaclaw-vm-904'
  );
```

Then parallel SSH stop+disable across the 17. Same shape as per-VM rollback.

### PGLite corruption recovery (per Rule 54)

If a canary VM hits the WASM Aborted() error on gbrain restart:

1. Probe `pg_controldata ~/.gbrain/brain.pglite | head -10` for staleness
2. If pg_control age indicates the staleness corruption (the 2026-05-18 vm-050 class): use the pg_resetwal -f procedure documented in Rule 54
3. If brain is irrecoverable: rm -rf brain.pglite, re-init gbrain (loses memory data, but rare for a canary VM with little accumulated data)

The fix gbrain v0.36.3.0 includes:
- 30-min CHECKPOINT cron (bounds pg_control staleness)
- ExecStop hook (graceful checkpoint before SIGKILL)
- XDG_RUNTIME_DIR export for cron context

These should prevent the pg_control corruption class. But the canary IS the test of whether they prevent it under non-edge load patterns too.

### Code rollback (if v107 itself broke something)

Revert the commit. `gbrain_enabled` column stays in DB (harmless — default NULL). Reconciler reverts to v106 behavior (partner-allowlist gating only). 17 canary VMs that had gbrain installed keep it running (no uninstall) but stop receiving updates.

---

## 7. Success criteria

### "Canary passed" — all of these for 48h:

1. **0 gbrain.service crashes** (NRestarts unchanged from initial value across all 17)
2. **0 PGLite corruption events** (no WASM Aborted on restart, pg_control freshness < 60 min across all 17)
3. **100% checkpoint cron success rate** (no `FAILED` or `skip:` entries beyond expected `skip: gbrain.service not active` during deploy install window)
4. **0 gateway regressions** (gateway /health stays 200 across all 17; p50 proxy latency delta < 10% vs pre-gbrain baseline)
5. **0 customer complaints** (operator-side check via support inbox, Telegram bot, etc.)
6. **No fleet-wide alert breaches** (existing Alertmanager rules quiet for the 17)
7. **Disk + memory headroom maintained** (free memory > 1 GB, disk free > 5 GB on every VM)

### Bonus signals (positive evidence, not pass/fail)

- **≥1 successful `put_page` event** across cohort by hour 24 (proves the routing block is being used, agent IS calling the right tool)
- **≥3 distinct slugs stored** across cohort by hour 48 (proves multi-fact memory works)
- **page_count grows monotonically** on active-subset VMs (proves session-over-session persistence)

### Abort criteria (any of these → rollback)

- Any gbrain.service crash within 6h (could be intermittent, but unacceptable on a canary)
- Any PGLite Aborted() on any VM (Rule 54 corruption signal — abort fleet-wide, investigate)
- Gateway p95 latency increases > 50% on any VM
- Memory pressure: free < 500 MB on any VM
- Disk pressure: > 85% on any VM
- Any agent regression report from a real user
- Any fleet-wide Alertmanager rule fires for a canary VM

---

## 8. Phasing timeline

| Phase | Day | VMs | Soak | Cumulative |
|---|---|---|---|---|
| Phase 0 (already done) | -1 (May 19) | 9 edge_city | ~6h evidence | 9 / 146 (6%) |
| **Phase 1 (canary)** | **Day 0 (May 20)** | **17 (this plan)** | **48h** | **26 / 146 (18%)** |
| Phase 2 (broader) | Day 3 (May 22) | +30 (mix of all tiers) | 48h | 56 / 146 (38%) |
| Phase 3 (fleet-wide) | Day 5 (May 24) | remaining ~90 | 48h | 146 / 146 (100%) |
| Buffer | Day 7-10 (May 26-29) | — | — | 100%, stabilizing |
| Esmeralda kickoff | Day 11 (May 30) | — | — | 100% |

### Compression options if a phase fails

If Phase 1 fails: investigate, fix, restart Phase 1. Add 24-48h. Esmeralda buffer shrinks.
If Phase 2 fails: investigate, fix, restart Phase 2. Same compression.
If Phase 3 fails: stop. Don't ship fleet-wide before Esmeralda. Edge_city still works; non-edge users get gbrain post-Esmeralda.

The plan is designed to ABORT GRACEFULLY at any phase. No phase is a point of no return.

---

## 9. Open risks + mitigations

### Risk: gbrain install hits a class of failure unique to Pro/Power non-edge VMs

What might be different on these VMs vs edge_city:
- Different SOUL.md content (no edge partner stub)
- Different skill mix (no edge-esmeralda skill clone)
- Different bot configuration (no Tule's coordination cron)
- Possibly different OpenClaw config drift (some VMs may have user-customized openclaw.json edits)

Mitigation: pre-flight probe catches the most likely failures. Canary on 17 VMs (vs 1) means we'll see if the failure is universal or rare. Per-VM rollback fast.

### Risk: pre-flight probe missed a prerequisite

Mitigation: stepGbrain itself runs comprehensive idempotency checks (Phase A of install-gbrain.sh's 5-invariant check). If a prerequisite is missing, install fails loudly with a known exit code. No silent partial installs.

### Risk: gbrain runtime overhead degrades the user experience

bun + gbrain serve = ~200 MB resident memory. On a 4 GB VM, that's 5%. CPU overhead is ~0.5% during a `put_page` write. Should be invisible to users.

Mitigation: monitoring script tracks memory + CPU. If we see > 10% memory delta or > 5% CPU delta, that's a real overhead concern and we'd investigate (likely a misconfigured PGLite limit or runaway query).

### Risk: agent confused by gbrain content + tries to put MEMORY.md content into gbrain

The new SOUL routing tells agent to use `gbrain__put_page` for user facts. But the routing also says MEMORY.md is READ-ONLY (platform-curated). An agent reading SOUL.md should not put MEMORY.md content into gbrain — that would be duplicating data.

Mitigation: this is a behavior question. We'll observe it in Phase 1. If we see agents writing weird duplicative content, refine the SOUL routing for v108 (or whatever the next manifest version is).

### Risk: 17 canary VMs send admin alerts simultaneously if something breaks

The drift-check admin alert is 6h-deduped per VM. If 17 VMs all hit the same issue simultaneously, that's 17 emails in 6h. Manageable but noisy.

Mitigation: the alert mechanism stays per-VM (good for triage). If the noise becomes excessive, we'd add a fleet-wide rate limiter (P2 follow-up, not blocking this rollout).

### Risk: Esmeralda starts mid-rollout

If Phase 3 takes longer than expected and we're still rolling out on May 30: we'd freeze rollout at Phase 2's stable state. Esmeralda kickoff doesn't depend on non-edge VMs having gbrain — edge_city is already done.

Mitigation: design timeline has 5-day buffer. We can absorb some slip.

---

## 10. Acceptance criteria

This plan is COMPLETE when:

1. Code: helper + 4 callsite refactors + manifest v107 + changelog entry → committed to main
2. Migration: applied to prod (Rule 56 — before code lands)
3. Pre-flight: 17/17 cohort VMs pass health probe
4. UPDATE: `gbrain_enabled = true` on the 17 cohort VMs
5. Vercel deploy: v107 reconciler picks up the canary cohort
6. Within 1 hour: 17/17 cohort VMs have gbrain.service active + /health 200
7. Within 6 hours: 17/17 cohort VMs have GBRAIN_SOUL_ROUTING_V1 marker in SOUL.md
8. Within 48 hours: all "Canary passed" criteria met → proceed to Phase 2

Single decision point at hour 48: GO (proceed to Phase 2) or NO-GO (rollback, investigate).

---

## 11. Open questions for future iterations

Not blocking this plan, but worth noting:

1. **When to deprecate `GBRAIN_PARTNER_ALLOWLIST`?** Once `gbrain_enabled = true` for all VMs, the partner check becomes dead code. We could remove the allowlist entirely and make the helper just check the column. P2 cleanup.
2. **Should the canary monitor become a Vercel cron?** Currently designed as operator-run. If the canary mechanism becomes ongoing (multiple rollouts), wire into a cron. P2.
3. **Should we backfill `gbrain_enabled = true` on the 9 edge_city VMs?** Currently they're `gbrain_enabled = NULL` and rely on partner. Cleaner to make them explicit. P2 cosmetic.

---

## Sign-off

Plan author: Claude Opus 4.7 (1M context), 2026-05-19, in collaboration with Cooper.
Authority basis: Cooper's "unpark, next phase: gbrain fleet-wide rollout via canary cohort" + explicit delegation of design decisions.
Implementation begins immediately after this doc commits to main.
