# D14/D15 — Village Dual-Channel Migration Apply

**Phase 1 (applied 2026-05-16):** `instaclaw/supabase/migrations/20260516200000_village_dual_channel_broadcast.sql` — `agent_positions` table only. Status: ✅ applied to production via Supabase Studio SQL Editor on 2026-05-16 (build pipeline was blocked by `verify-migrations.ts` until apply; recovery via `vercel redeploy` of last Error deployment).

**Phase 2 (pending):** `instaclaw/supabase/pending_migrations/20260516210000_village_dual_channel_triggers.sql` — village schema, anonymize helper, `village_attendees_public` view, four broadcast trigger functions, four triggers. Status: PARKED in `pending_migrations/` per CLAUDE.md Rule 56. **Owner approval required** before applying to staging or production.

> **Why split:** during the Phase 1 commit, all of Phase 2 was bundled into the same file. The build pipeline went down because `agent_positions` didn't exist in prod yet — `verify-migrations.ts` blocked every Vercel build until Cooper hand-pasted the table. To prevent a re-occurrence, Phase 2 was extracted to `pending_migrations/` (excluded from the verify-migrations scan); it can be reviewed and merged without re-triggering the gate.

## What Phase 2 does

Per `edgeclaw-village/docs/village-direction-2026-05-15.md` § A11 and Topic 6 of the village technical research:

1. Creates the `village` schema + `village.anonymize_user_id(uuid) → text` helper.
2. Creates two anonymized public VIEWs:
   - `public.village_attendees_public` — anon-readable attendee list. Exposes `agent_id` (anonymized), `description`, `larry_atlas_index`, `home_tile_x`, `home_tile_y`, `spectator_visible`. Filtered `WHERE spectator_visible = true`. Read by `serverGame.ts:loadAttendees()` when `mode === 'spectator'`.
   - `public.agent_positions_public` — anon-readable position snapshot. Exposes `agent_id` (anonymized), tile/facing/state columns. INNER JOIN with `village_attendees` filters out opted-out users (defense in depth — `user_id` never appears in the view). Read by `serverGame.ts:loadInitialPositions()` when `mode === 'spectator'`.
3. Defines four `AFTER INSERT/UPDATE` trigger functions, one per emitter table — each emits TWO `realtime.send()` broadcasts:
   - `village:edge-esmeralda-2026` (private/auth, full identity)
   - `village-public:edge-esmeralda-2026` (public/anon, `agent_NNNN` labels only)

| Trigger | Table | Private payload | Public payload |
|---|---|---|---|
| `trg_matchpool_outcomes_dual_broadcast` | `matchpool_outcomes` | outcome + user_ids + scores | anon pair + match_engine |
| `trg_negotiation_threads_dual_broadcast` | `negotiation_threads` | thread + xmtp addrs + topic | anon pair + state + current_turn |
| `trg_instaclaw_vms_dual_broadcast` | `instaclaw_vms` | VM + name + telegram handle | anon owner + health_status |
| `trg_agent_positions_dual_broadcast` | `agent_positions` (NEW) | user_id + position + flags | anon agent + position + flags |

**Identity stripping happens at publish time in the trigger.** The public channel cannot leak identity even if a malicious subscriber tries — the leak-capable fields never enter a `village-public:*` message.

## Safety review (re-read 2026-05-16)

- **Idempotent.** Every CREATE uses `IF NOT EXISTS` / `OR REPLACE`; every DROP TRIGGER uses `IF EXISTS`. Safe to re-run.
- **No data mutations on existing rows.** Only adds schema/functions/triggers + creates one new empty table. Existing `matchpool_outcomes`, `negotiation_threads`, `instaclaw_vms` rows are untouched.
- **No backfill.** Triggers fire on INSERT/UPDATE going forward. Historical rows do NOT replay into the channel — by design.
- **Self-throttled on `instaclaw_vms`.** The trigger short-circuits on UPDATEs that don't change `health_status` (config_version bumps, last_health_check ticks, etc.). Won't flood the channel.
- **VMs with `assigned_to IS NULL` are skipped.** Pre-assignment lifecycle events don't render anyway.
- **`realtime.send()` is async** on the row write. p99 added write latency should be sub-millisecond (jsonb construction + two PERFORMs).
- **No `DELETE` triggers.** Walk events are emitted by application code BEFORE the row commit; the AFTER INSERT/UPDATE path is for state-snapshot resync, not motion. DELETE would never be a village-relevant event.

## Pre-apply checklist

Before running on staging, verify:

```bash
# 1. Confirm column names match (CLAUDE.md Rule 1 — verify DB schema before queries)
psql "$STAGING_DATABASE_URL" -c "
  SELECT column_name FROM information_schema.columns
   WHERE table_schema='public'
     AND table_name IN ('matchpool_outcomes','negotiation_threads','instaclaw_vms','instaclaw_users')
   ORDER BY table_name, ordinal_position;
"

# Must include (at minimum):
#   matchpool_outcomes:    outcome_id, source_user_id, candidate_user_id, match_engine, rrf_score, mutual_score, deliberation_score
#   negotiation_threads:   id, initiator_user_id, receiver_user_id, initiator_xmtp_address, receiver_xmtp_address, state, current_turn, topic, deliberation_score
#   instaclaw_vms:         id, name, assigned_to, health_status, tier, api_mode, partner, telegram_bot_username
#   instaclaw_users:       id (PK)

# 2. Confirm realtime.send() exists on the target (Supabase Realtime v2 extension)
psql "$STAGING_DATABASE_URL" -c "
  SELECT routine_name FROM information_schema.routines
   WHERE routine_schema='realtime' AND routine_name='send';
"
# Must return exactly one row.
```

If either check fails, **STOP**. The migration will throw on apply.

## Apply commands

### Staging (recommended first)

```bash
cd /Users/cooperwrenn/wild-west-bots/instaclaw

# Verify the link points at staging (NOT production)
supabase status   # should show your STAGING project ref, not the prod one
# If wrong:  supabase link --project-ref <STAGING_REF>

# Dry-check what would apply
supabase db diff --schema public,village --use-migra
supabase migration list   # confirms 20260516200000... is "pending"

# Apply
supabase db push --include-all
```

Alternative direct-psql path (if `supabase` CLI is not available):

```bash
psql "$STAGING_DATABASE_URL" \
  -f instaclaw/supabase/migrations/20260516200000_village_dual_channel_broadcast.sql
```

### Production (only AFTER staging is verified)

```bash
cd /Users/cooperwrenn/wild-west-bots/instaclaw
supabase link --project-ref <PRODUCTION_REF>   # ← double-check this is prod
supabase status                                  # confirm
supabase db push --include-all
```

## Post-apply verification (run on staging)

```bash
# 1. All four triggers present
psql "$STAGING_DATABASE_URL" -c "
  SELECT trigger_name, event_object_table
    FROM information_schema.triggers
   WHERE trigger_name LIKE 'trg_%_dual_broadcast'
   ORDER BY event_object_table;
"
# Expected output: 4 rows (agent_positions / instaclaw_vms / matchpool_outcomes / negotiation_threads)

# 2. Anonymization deterministic
psql "$STAGING_DATABASE_URL" -c "
  SELECT village.anonymize_user_id('00000000-0000-0000-0000-000000000001');
"
# Run 3 times — output MUST be identical across calls.

# 3. End-to-end privacy probe (CRITICAL — do not skip)
# In one terminal, subscribe to the public channel via the Supabase Realtime Inspector:
#    https://supabase.com/dashboard/project/<staging>/realtime/inspector
#    Channel: village-public:edge-esmeralda-2026
# In another terminal, insert a synthetic test row:
psql "$STAGING_DATABASE_URL" -c "
  INSERT INTO matchpool_outcomes (source_user_id, candidate_user_id, match_engine, rrf_score)
  VALUES (
    '<staging_test_user_a>'::uuid,
    '<staging_test_user_b>'::uuid,
    'staging-probe', 0.5
  );
"
# In the Realtime Inspector, you should see a message land with payload:
#   { "table":"matchpool_outcomes", "op":"INSERT",
#     "record": { "agent_a":"agent_NNNN", "agent_b":"agent_NNNN", "match_engine":"staging-probe" } }
# The payload MUST contain ONLY those three keys. If ANY user_id / score / rrf / xmtp / token
# appears in the public message: REVERT IMMEDIATELY (see rollback below).

# 4. p99 write latency
# Insert 100 synthetic matchpool_outcomes rows and measure p99 INSERT latency.
# Before-migration baseline and after-migration measurement should differ by <5ms.
# (jsonb construction + 2 realtime.send PERFORMs are the only added cost.)
```

## Rollback (if privacy probe fails or anything looks wrong)

```sql
-- Drop the triggers first (stops new broadcasts immediately)
DROP TRIGGER IF EXISTS trg_matchpool_outcomes_dual_broadcast ON public.matchpool_outcomes;
DROP TRIGGER IF EXISTS trg_negotiation_threads_dual_broadcast ON public.negotiation_threads;
DROP TRIGGER IF EXISTS trg_instaclaw_vms_dual_broadcast ON public.instaclaw_vms;
DROP TRIGGER IF EXISTS trg_agent_positions_dual_broadcast ON public.agent_positions;

-- Drop the trigger functions
DROP FUNCTION IF EXISTS village.emit_matchpool_outcome();
DROP FUNCTION IF EXISTS village.emit_negotiation_thread();
DROP FUNCTION IF EXISTS village.emit_vm_lifecycle();
DROP FUNCTION IF EXISTS village.emit_agent_position();
DROP FUNCTION IF EXISTS village.anonymize_user_id(uuid);

-- Optionally drop the schema (only if no future migrations will reuse it)
-- DROP SCHEMA IF EXISTS village;

-- Drop the new table (only if you also want to drop position state)
-- DROP TABLE IF EXISTS public.agent_positions;
```

`agent_positions` may have data — if you intend to keep position state for future re-enable, **do not drop the table**.

## Approval

Reply `apply to staging` to get the staging deploy. After staging is clean for 24h and the privacy probe passes, reply `apply to prod` for production.

## Promotion after apply

Once Phase 2 is applied (in BOTH staging and production), promote the file per Rule 56:

```bash
git mv instaclaw/supabase/pending_migrations/20260516210000_village_dual_channel_triggers.sql \
       instaclaw/supabase/migrations/20260516210000_village_dual_channel_triggers.sql

# Commit with apply-evidence:
git commit -m "db: promote village dual-channel triggers after apply to prod 2026-MM-DD

Phase 2 of D14/D15 dual-channel broadcast. Triggers fire on
matchpool_outcomes / negotiation_threads / instaclaw_vms / agent_positions
INSERTs and UPDATEs. Public payloads identity-stripped at the trigger level.

Applied to staging 2026-MM-DD HH:MM UTC. Privacy probe passed.
Applied to production 2026-MM-DD HH:MM UTC. Post-apply verification:
  - 4/4 trg_*_dual_broadcast triggers present
  - village.anonymize_user_id() returns stable output across 3 calls
  - village_attendees_public readable to anon role
  - End-to-end privacy probe via Realtime Inspector — payload contained
    only whitelisted fields (no user_id, no scores, no xmtp_address)
"
```

`verify-migrations.ts` will then scan the file. The only `CREATE` statements it parses are `CREATE TABLE` and `ALTER TABLE ... ADD COLUMN` — the file contains neither. Build passes.

If the file's `CREATE VIEW` ever expands to include a `CREATE TABLE` (e.g., the `village_attendees_public` view is replaced with a materialized table), the promotion sequence MUST re-verify the schema is in prod before moving the file. Rule 56 again.
