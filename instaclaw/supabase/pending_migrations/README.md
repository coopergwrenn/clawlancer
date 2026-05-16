# `pending_migrations/` — staging area for unapplied migrations

This directory holds Supabase migrations that have been **written but not yet applied to production**. It is excluded from `scripts/verify-migrations.ts`, which only scans `migrations/`. Committing a file here will NOT block builds.

See CLAUDE.md **Rule 56** for the discipline this directory exists to enforce.

## Why this exists

`verify-migrations.ts` runs as the first command of `npm run build` (wired in `package.json`). It exits 1 if any `CREATE TABLE` or `ALTER TABLE ... ADD COLUMN` statement in `migrations/` references an object that doesn't exist in production Supabase. That gate is correct (it prevents shipping app code that references non-existent columns), but it has a cost: **the moment a migration with new schema lands in `migrations/`, the build pipeline goes down until the schema is applied in prod.**

The 2026-05-16 incident: two terminals committed migrations to `migrations/` within 30 minutes — neither had applied the SQL to prod — and the build pipeline was frozen for ~1 hour. Unrelated hotfixes during that window would have been blocked too. See Rule 56 for the full timeline.

This directory breaks the coupling. You can stage a migration file, share it with collaborators, run code review, and update companion docs — all without touching the build gate.

## When to use this directory

Use `pending_migrations/` for any migration that:

1. Contains `CREATE TABLE` (new table), OR
2. Contains `ALTER TABLE ... ADD COLUMN` (new column on existing table), OR
3. Is part of a larger multi-step rollout where some steps need to land in prod before later steps can be applied.

You do **NOT** need to use this directory for:

- Trigger / function / view-only migrations (`CREATE TRIGGER`, `CREATE FUNCTION`, `CREATE VIEW`) — `verify-migrations.ts` doesn't parse those object types.
- Migrations entirely in non-public schemas (`village.*`, `research.*`, etc.) — `verify-migrations.ts` explicitly skips non-public schemas (see `scripts/verify-migrations.ts:189-193`).
- Pure DROP migrations (drops always reach prod fine).
- Renames / RLS-policy adjustments where the underlying schema is unchanged.

When in doubt, stage here. Promoting later is cheap; recovering from a build-gate outage is not.

## Promotion procedure (pending → applied)

Once the migration is ready to apply:

1. **Verify prerequisites match**: cross-check column names against production via `psql` or the Supabase Studio table editor. The migration's column references must match the actual schema. See `instaclaw/docs/village-dual-channel-migration-apply.md` for an example pre-flight check.

2. **Apply the SQL to staging** (if a staging Supabase exists), or paste directly into the Supabase Studio SQL Editor for production. Use the apply runbook documented in the migration file's companion `.md`.

3. **Run post-apply verification queries** documented in the migration file. Confirm objects exist, RLS is enabled, triggers fire on synthetic test rows.

4. **Move the file** to `migrations/`:
   ```bash
   git mv instaclaw/supabase/pending_migrations/<file>.sql \
          instaclaw/supabase/migrations/<file>.sql
   ```

5. **Commit and push** with apply-evidence in the message:
   ```
   db: promote <migration-name> after apply to prod 2026-MM-DD

   Applied via Supabase Studio SQL Editor against production at HH:MM UTC.
   Post-apply verification queries returned expected output (see migration
   file's verification section). Privacy probe passed (no PII in
   village-public:* payloads).
   ```

6. **Watch the next Vercel build**. `verify-migrations.ts` will now scan the file — since the schema is already in prod, it should pass. If it fails, you have a column name mismatch; revert the file move and investigate.

## What lives here right now

| File | Promotion blocker | Companion doc |
|---|---|---|
| `20260516210000_village_dual_channel_triggers.sql` | Awaiting "apply to staging" approval per the village dual-channel runbook. End-to-end privacy probe must pass before promotion. | `instaclaw/docs/village-dual-channel-migration-apply.md` |

When the table is empty, this directory is doing its job (no pending work).
