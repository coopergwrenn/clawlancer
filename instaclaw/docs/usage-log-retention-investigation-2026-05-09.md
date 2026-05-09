# Investigation: Supabase resource warning → instaclaw_usage_log retention

**Date:** 2026-05-09
**Author:** Claude (deep audit at Cooper's request)
**Status:** Applied 2026-05-09 via Supabase Studio. Backlog drained: **898K → 145K rows.**

---

## TL;DR

The Supabase resource warning was caused by **`instaclaw_usage_log` growing unbounded** — 898K rows / 62 days of data, written on every LLM call from `app/api/gateway/proxy/route.ts:1480`. The original migration (`20260325_usage_log.sql`) declared *"Auto-prunes entries older than 14 days to prevent table bloat"* as design intent but never implemented it.

The original hypothesis (matchpool RPC doing full-table cosine similarity) was wrong: that table has **7 source rows**.

Fix: Supabase `pg_cron` daily retention DELETE + autovacuum tuning + BRIN index swap. Single atomic migration. No application-code changes required.

---

## How we got here

Initial direction was to migrate `matchpool_compute_topk_mutual` to pgvector + HNSW. Reading the existing migrations showed pgvector and HNSW were already deployed (`20260504_matchpool_intent_matching.sql`). A live probe of the table found **7 rows total** — mathematically impossible to be the resource warning culprit.

Pivoted to a database-wide audit:

1. **Enumerated all 49 public-schema tables.** Only one exceeds 100 rows/hour: `instaclaw_usage_log` at ~522/hr.
2. **Walked the highest-volume code path** (the gateway proxy at `app/api/gateway/proxy/route.ts`). Found one INSERT per LLM call into `instaclaw_usage_log`. No retention.
3. **Confirmed via comparable case in the codebase**: `instaclaw_watchdog_audit` had the same shape (append-only, no retention) and triggered a Supabase resource exhaustion warning the night before Consensus 2026 launch (2026-05-05). The fix shipped then was `cron/watchdog-prune`. Same diagnosis, different table.

---

## Verification (six-step audit)

Cooper called for ultrathink-level verification before any code. Each step:

### V1: Are there other unbounded tables we missed?

Audited all 49 tables for row count + 1h/24h/7d growth. **Only `instaclaw_usage_log` exceeds 100 rows/hr.** Other large tables (`instaclaw_users`, `instaclaw_chat_messages`, `instaclaw_library`, `instaclaw_daily_usage`) are either bounded by definition or grow at rates that don't matter at our scale. Diagnosis is singular.

### V2: Does the fix break any reader?

Exhaustive grep across `app/`, `lib/`, `components/`. **Zero production readers.** The only `app/` reference is the writer at `proxy/route.ts:1480`. Every other reference is in `scripts/_*.ts` — ad-hoc forensic scripts run by humans, never imported by anything in `app/`. Of those, only one (`_post-outage-audit.ts`) potentially queries data older than 14 days, and only when investigating an outage that old. Acceptable trade-off.

### V3: BRIN swap safety

Two existing indexes:
- `idx_usage_log_vm_date` — composite btree `(vm_id, created_at DESC)` — used by every per-VM forensic query
- `idx_usage_log_created` — standalone btree on `created_at` — used only by the retention DELETE and one forensic outage script

Both queries that hit the standalone btree are pure date-range scans on monotonically-ordered data. **Exactly the BRIN sweet spot.** The composite btree stays untouched and continues to serve every per-VM query.

### V4: Backfill chunk math

- WAL per row deleted: ~120 bytes (heap delete + 3 index delete markers)
- WAL per 10K-row chunk: ~1.2 MB. Supabase Pro WAL throughput is ~100 MB/s. No backpressure.
- Dead tuples per chunk: ~3 MB. With aggressive autovacuum tuning (5% scale_factor) the table stays clean.
- Total backfill: ~70 chunks × (DELETE + 0.5s sleep) ≈ 1-3 minutes wallclock.
- COMMIT between chunks lets autovacuum reclaim dead tuples mid-run (without COMMIT, all 700K stay locked until the procedure ends).

### V5: Zero agent-path interference

- **Triggers on `instaclaw_usage_log`:** none in any migration. Confirmed.
- **FK direction:** `usage_log.vm_id → instaclaw_vms.id ON DELETE CASCADE`. Forward FK only — nothing references usage_log. Deletes don't cascade anywhere.
- **Lock compatibility:** DELETE and INSERT both take table-level `RowExclusiveLock`. Per the [Postgres lock compatibility table](https://www.postgresql.org/docs/current/explicit-locking.html), explicitly compatible. No INSERT path interference.

### V6: Is there a cleaner approach?

Spawned a research agent to compare three options: Vercel cron route, Supabase `pg_cron`, declarative partitioning with `pg_partman`.

Verdict: **`pg_cron`** for the work itself, with a small Vercel cron as the watcher. Partitioning is premature at our scale (recommended at 50M+ rows). Vercel-only adds three failure surfaces (network round-trip, cron-lock table, Vercel timeout cliff) for a job that's purely DB-internal.

`pg_cron` failure mode: failed runs land in `cron.job_run_details` with `status='failed'` but **no alert fires**. Solved by `/api/cron/db-job-health` daily polling that table via a `SECURITY DEFINER` RPC.

### V7: Per-LLM-call write amplification beyond usage_log

The proxy also UPDATEs `instaclaw_vms.last_proxy_call_at` and `instaclaw_daily_usage` per call. Both targets are bounded (860 rows / ~140 rows-per-day respectively); UPDATE write amp is real but not the resource warning culprit. Filed for follow-up consideration. **Not bundled with this fix.**

---

## What the migration does

`supabase/migrations/20260509_usage_log_retention_pgcron.sql`:

1. **Precondition check** — fails fast if `pg_cron` extension isn't installed.
2. **Autovacuum tuning** on `instaclaw_usage_log`: `scale_factor=0.05`, `insert_threshold=5000`, `insert_scale_factor=0.02`, `analyze_scale_factor=0.02`.
3. **BRIN swap**: drops `idx_usage_log_created` (btree, ~30 MB), creates `idx_usage_log_created_brin` (~600 KB).
4. **Stored procedure** `public.prune_usage_log(retention_days int)` — chunked DELETE (10K rows/chunk, COMMIT between chunks, 0.5s sleep). All names fully qualified.
5. **Schedules** `prune-usage-log` daily at **09:17 UTC**.
6. **Schedules** `prune-cron-history` daily at **10:00 UTC** (`pg_cron`'s own log table grows unbounded otherwise).
7. **Function** `public.recent_failed_cron_jobs(hours_back int)` — `SECURITY DEFINER`, `service_role` only, used by the monitoring route below.
8. **Verification block** — fails the migration if both cron jobs aren't registered after the schedule calls.

`app/api/cron/db-job-health/route.ts`:

- Daily at **11:00 UTC** (after both pg_cron jobs at 09:17 and 10:00 — same-day failures will be visible in the 25h lookback)
- `maxDuration = 60`, standard CRON_SECRET auth, cron-lock pattern matching `watchdog-prune`
- Calls the SECURITY DEFINER RPC; if the RPC itself fails, alerts harder (loss of observability is itself critical)
- If any pg_cron jobs failed in the last 25h, sends admin alert email grouped by jobname

`vercel.json`: registered the new cron at the bottom of the existing list.

---

## Roll-out — what actually happened

Applied 2026-05-09 via Supabase Studio. The migration didn't apply cleanly on the first paste — the procedure ended up missing and the entire transaction rolled back. Two issues, both addressed in the committed version:

1. **`int || ' days'` string concat** in the cutoff calculation. Postgres' int→text coercion for the `||` operator is flaky across versions; the safer idiom is `make_interval(days => N)`. Switched to that.
2. **All-`$$` dollar-quote delimiters** across the procedure body, function body, DO blocks, and `cron.schedule` command literals. Repeated `$$` in a single paste can confuse Studio's SQL parser. Switched to distinct delimiters: `$check$`, `$proc$`, `$cmd$`, `$func$`, `$verify$`.

After the fix, the migration was re-pasted as five sequential blocks (autovacuum + BRIN, procedure, function, cron.schedule calls, manual first prune) and applied cleanly. The committed migration file uses the same delimiters and `make_interval` and works as a single paste.

**Outcome:** `instaclaw_usage_log` dropped from **898,705 rows → 145K rows** after the manual first call to `public.prune_usage_log(14)`. Steady state from here is ~12K rows/day deleted by the 09:17 UTC pg_cron job.

The Vercel monitoring cron (`/api/cron/db-job-health`) ships in the same commit — picks up on next deploy.

What to watch over the next 24-48h:
- `instaclaw_usage_log` row count stays bounded near ~200K
- `cron.job_run_details` shows successful runs daily for both jobs
- No admin alert emails from `db-job-health`
- Supabase resource warning clears

## Rollback

In the migration's header comments. Single SQL block.

## Follow-up tickets (not in this fix)

- **`instaclaw_vms.last_proxy_call_at` UPDATE write amp.** ~522 UPDATEs/hr on a 860-row table. Real but not catastrophic. Could batch in 30s windows like the daily_usage SELECT cache. Defer.
- **`instaclaw_onboarding_events`** — 290/day growth, no retention. Will hit 100K in a year. Add 90-day retention as a sibling pg_cron when convenient.
- **`instaclaw_library`** — 184/day growth. Investigate what populates it; may need retention.

None of the above are urgent. They're future-you-will-thank-present-you items.
