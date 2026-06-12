# Vercel cron liveness — the last truly silent path

**Status:** captured backlog (not built). Surfaced by the 2026-06-10 May-11-P0
verification. Owner: TBD. Priority: P2 (no active customer impact, but it is the
one remaining "reconcile never runs → zero signal" path).

## The gap

Silent-path table from the 2026-06-10 verification:

| Silent path | Detected? |
|---|---|
| (a) reconcile **throws** | ✅ `catch(err)` → `recordReconcileFailure` (counter + K=10 quarantine + alert) |
| (b) reconcile **succeeds-but-did-nothing** | ✅ stale-bundle halt (`verifyManifestFreshness`) + Rule 10 verify-after-set |
| (c) reconcile **never runs because the Vercel cron died** | ❌ **no direct monitor** |

`/api/cron/db-job-health` watches **pg_cron** jobs (`cron.job_run_details`).
Nothing watches the **Vercel** crons (`reconcile-fleet`, `file-drift`,
`health-check`, `process-pending`, `watchdog`, `vm-lifecycle`, the
fleet-health-notify delivery cron, etc.). If a Vercel cron silently stops
firing — bad `vercel.json` edit, a deploy that drops a cron entry, a Vercel
platform incident, a route that 500s on every invocation before doing work —
there is no alarm. We find out via the downstream symptom (VMs drift, customers
complain), which is exactly the days-late discovery the May 11 work set out to
eliminate.

The fleet-health detector (now drift-proof as of `20260610200000`) is a
*partial* backstop for the reconcile-fleet case: a dead reconcile-fleet cron
means healthy VMs pile up below the manifest version → `check_fleet_health`
count climbs → alert within ~90 min. But that only covers the ONE cron whose
job is reflected in `config_version`. The other Vercel crons (health-check,
process-pending, watchdog, vm-lifecycle, fleet-health-notify) have no such
downstream metric — a dead one is invisible until its specific failure mode
manifests.

## Why it's structurally hard

Vercel crons are HTTP GETs the platform issues on a schedule. There is no
Vercel API that says "cron X last fired at T" that we poll cheaply. The
liveness signal has to be **self-reported**: each cron stamps a heartbeat when
it runs, and a watcher alerts when a heartbeat goes stale. The watcher itself
must run somewhere that does NOT depend on the thing it watches.

## Shape of the fix (when picked up)

1. **Heartbeat table.** Reuse `instaclaw_app_settings` (shipped 2026-06-10) or a
   dedicated `instaclaw_cron_heartbeats (cron_name TEXT PK, last_run_at TIMESTAMPTZ,
   last_status TEXT, updated_at TIMESTAMPTZ)`. Every Vercel cron route UPSERTs its
   heartbeat as its first or last action (first = "started", last = "completed";
   completed is the better signal — proves it ran to the end).

2. **The watcher must be independent of Vercel cron.** This is the load-bearing
   design choice. A Vercel cron watching Vercel crons dies with them. Put the
   watcher in **pg_cron** (already independent, already proven by the fleet-health
   job, already monitored by db-job-health). A `check_cron_liveness()` pg_cron job
   (hourly) reads `instaclaw_cron_heartbeats`, and for each expected cron whose
   `last_run_at` is older than `expected_interval × 3` (a few missed fires),
   INSERTs into a `*_alerts` table that `fleet-health-notify` (or a sibling
   delivery cron) emails. Expected intervals live in the heartbeat table or a
   settings row so they don't drift (same discipline as the manifest_version fix).

3. **Bootstrapping / new-cron registration.** A cron that has NEVER run has no
   heartbeat row → the watcher must know the expected set. Seed the expected
   cron names + intervals from `vercel.json` (parse at deploy, or maintain a
   checked-in list). A cron in the expected set with no heartbeat row, or a
   stale one, both alert. A cron NOT in the expected set that heartbeats is
   informational (probably fine; log it).

4. **Avoid false positives on intentional pauses.** If a cron is intentionally
   disabled (commented out in `vercel.json` during an incident), the watcher
   would alert. Either remove it from the expected set when pausing, or add a
   `paused_until` column the watcher respects.

## References / precedents in-repo

- `supabase/migrations/20260513170100_fleet_health_pgcron.sql` — the pg_cron
  job + state-table + alert-table + delivery-cron pattern to mirror.
- `app/api/cron/db-job-health/route.ts` — how pg_cron job health is surfaced today.
- `app/api/cron/fleet-health-notify/route.ts` — the alert-delivery cron to extend
  or sibling.
- `lib/cron-lock.ts` — distributed lock pattern if the watcher needs one.
- `20260610200000_fleet_health_manifest_settings.sql` — the "settings row written
  by Node, read by pg_cron, drift-proof by construction" pattern, directly
  reusable for expected-interval config.

## Acceptance criteria (for the eventual build)

- Killing any one Vercel cron (e.g., remove `reconcile-fleet` from `vercel.json`
  on a preview) produces an admin email within `interval × 3`.
- The watcher survives the death of every Vercel cron (it's in pg_cron).
- Re-enabling the cron clears the alert (recovery signal, like fleet-health).
- New crons added to `vercel.json` are auto-covered (or the PR that adds them
  also adds them to the expected set — documented as a checklist item).
