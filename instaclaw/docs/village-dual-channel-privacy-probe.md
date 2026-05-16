# D14/D15 Phase 2 — Privacy Probe (paste-ready)

**Companion runbook to:** `instaclaw/docs/village-dual-channel-migration-apply.md`
**Validates:** `instaclaw/supabase/pending_migrations/20260516210000_village_dual_channel_triggers.sql`

This probe verifies that when the Phase 2 dual-channel triggers fire, the
`village-public:edge-esmeralda-2026` channel emits payloads containing
**ONLY** anonymized fields — no real user_ids, scores, xmtp addresses,
telegram handles, or other identity-revealing data.

The probe focuses on `matchpool_outcomes` (mandatory) because its trigger
exercises the highest-risk fields: two real user_id FKs (anonymization
test) and three numeric scores (whitelist test). The same `realtime.send(
v_public, ...)` pattern is implemented identically in the other three
trigger functions; if matchpool_outcomes passes, the privacy guarantee
holds across the migration. Optional secondary probes for
`negotiation_threads` and `agent_positions` are included at the bottom
for defense-in-depth.

---

## Prerequisites

1. **Phase 2 migration applied to production.** The 4 trigger functions
   and 4 triggers exist on production Supabase
   (project `qvrnuyzfqjrsjljcqbub`). Confirm via:

   ```sql
   SELECT trigger_name, event_object_table
     FROM information_schema.triggers
    WHERE trigger_name LIKE 'trg_%_dual_broadcast'
    ORDER BY event_object_table;
   -- Expected 4 rows: agent_positions / instaclaw_vms / matchpool_outcomes / negotiation_threads
   ```

2. **`village.anonymize_user_id()` returns deterministic output.** Run 3×;
   each call MUST return the same string:

   ```sql
   SELECT village.anonymize_user_id('00000000-0000-0000-0000-000000000001');
   -- Expected: same "agent_NNNN" value all three runs
   ```

3. **Supabase Realtime Inspector open in another browser tab**,
   subscribed to **both** channels (one tab each, for side-by-side
   payload inspection):

   - `village-public:edge-esmeralda-2026` ← the public channel (this is
     where leaks would manifest)
   - `village:edge-esmeralda-2026` ← the private channel (sanity check
     that the full payload still goes here)

   Inspector URL:
   `https://supabase.com/dashboard/project/qvrnuyzfqjrsjljcqbub/realtime/inspector`

4. **Two distinct `instaclaw_users.id` UUIDs** to use as
   `source_user_id` and `candidate_user_id`. They must:

   - Both exist in `instaclaw_users` (FK constraint)
   - Be different from each other (the matching engine likely has a
     `CHECK source != candidate` constraint; even if not, a self-match
     row is semantically meaningless)

   Find two candidates:

   ```sql
   SELECT id, email FROM instaclaw_users
    ORDER BY created_at DESC
    LIMIT 5;
   -- Pick any two distinct id values. Cooper's own user_id is fine for
   -- one slot; an admin/test account is fine for the other. The
   -- anonymized labels (`agent_NNNN`) won't reveal which users you
   -- picked — that's the whole point of the anonymization.
   ```

---

## Step 1 — Synthetic INSERT (triggers the broadcast)

Replace `<UUID_A>` and `<UUID_B>` with the two UUIDs from prerequisite 4,
then paste into Supabase SQL Editor and run.

```sql
INSERT INTO matchpool_outcomes (
    source_user_id,
    candidate_user_id,
    match_engine,
    rrf_score,
    mutual_score,
    deliberation_score
) VALUES (
    '<UUID_A>'::uuid,
    '<UUID_B>'::uuid,
    'privacy-probe-2026-05-16',   -- distinctive marker for cleanup grep
    99.99,                         -- intentionally out-of-band so any
    99.99,                         -- leak shows up obviously in the
    99.99                          -- public payload
)
RETURNING outcome_id,
          source_user_id,
          candidate_user_id,
          match_engine,
          rrf_score;
```

**Expected:** one row returned, with the auto-generated `outcome_id`,
the two real user_ids, the marker `match_engine`, and `99.99` scores.
This is the data on the *private* channel side; we're about to verify
that NONE of it leaks to the public side.

If the INSERT fails with a NOT NULL constraint error on a column not
listed above (e.g., `action_type`, `created_at`), add that column to
the INSERT list with a sane value (e.g., `action_type => 'probe'`).
Don't infer the schema by guessing — the error message names the
missing column directly.

---

## Step 2 — Inspect the broadcast payloads

Within 1–2 seconds of the INSERT committing, **two** messages should
arrive in the Realtime Inspector, one in each subscribed tab.

### A. `village-public:edge-esmeralda-2026` tab

**Expected payload shape:**

```json
{
  "type": "broadcast",
  "event": "INSERT",
  "payload": {
    "table": "matchpool_outcomes",
    "op": "INSERT",
    "record": {
      "agent_a": "agent_NNNN",
      "agent_b": "agent_NNNN",
      "match_engine": "privacy-probe-2026-05-16"
    }
  }
}
```

**Privacy criteria — the `payload.record` object MUST contain exactly
these three keys and nothing else:**

| Key | Type | Notes |
|---|---|---|
| `agent_a` | string | starts with `agent_`, anonymized `<UUID_A>` |
| `agent_b` | string | starts with `agent_`, anonymized `<UUID_B>`, ≠ `agent_a` |
| `match_engine` | string | exactly `"privacy-probe-2026-05-16"` |

**FAIL conditions — if ANY of these appear in `payload.record`, the
trigger has a privacy bug:**

| Key | Why it's forbidden |
|---|---|
| `source_user_id` | real UUID leak |
| `candidate_user_id` | real UUID leak |
| `outcome_id` | UUID identifies the match record |
| `rrf_score` / `mutual_score` / `deliberation_score` | 99.99 values — any score leak |
| any field not in the 3-key whitelist above | the trigger added a column without an audit |

If ANY fail condition triggers → run the **Emergency Rollback** at the
bottom of this file, leave the synthetic row in place for forensics,
and report.

### B. `village:edge-esmeralda-2026` tab (sanity check)

**Expected payload shape** — the full private record with all 7 fields:

```json
{
  "type": "broadcast",
  "event": "INSERT",
  "payload": {
    "table": "matchpool_outcomes",
    "op": "INSERT",
    "record": {
      "outcome_id": "<auto-gen UUID>",
      "source_user_id": "<UUID_A>",
      "candidate_user_id": "<UUID_B>",
      "match_engine": "privacy-probe-2026-05-16",
      "rrf_score": 99.99,
      "mutual_score": 99.99,
      "deliberation_score": 99.99
    }
  }
}
```

This confirms authenticated subscribers still get the full payload —
the migration didn't accidentally strip the private side too. If this
payload is missing fields, the private channel is regressed.

---

## Step 3 — Cleanup (delete the synthetic row)

After both payloads have been inspected and the public side passes:

```sql
DELETE FROM matchpool_outcomes
 WHERE match_engine = 'privacy-probe-2026-05-16'
 RETURNING outcome_id;
-- Expected: 1 row returned (the test row's UUID)
```

**Note:** the DELETE does NOT fire a broadcast — the trigger is
`AFTER INSERT OR UPDATE` only. The realtime.messages row from the
INSERT remains in the realtime ledger (retained ~24h by default,
auto-pruned). That's harmless — the payload it contains is already
proven to be anonymized.

---

## Step 4 — Verify clean

```sql
SELECT COUNT(*) AS leftover_probe_rows
  FROM matchpool_outcomes
 WHERE match_engine LIKE 'privacy-probe-%';
-- Expected: 0
```

If non-zero, repeat Step 3 until it returns 0.

---

## Step 5 — Report results back to Claude

In Slack/chat, paste:

```
Phase 2 privacy probe: PASS
- Public payload contained ONLY agent_a / agent_b / match_engine ✓
- Private payload contained full record ✓
- Cleanup confirmed 0 leftover probe rows ✓
```

Claude will then `git mv pending_migrations/20260516210000_*.sql →
migrations/20260516210000_*.sql` and commit with the apply-evidence.

If PROBE FAIL: paste the actual offending public payload (with
specific user_ids redacted/truncated) so the trigger function can be
audited and the offending `jsonb_build_object(...)` field located.

---

## Optional Secondary Probes (defense-in-depth)

The primary probe above validates the dual-channel pattern. The other
three trigger functions implement the same pattern, so they're highly
likely to pass given primary passes. But for full coverage:

### Secondary A — `negotiation_threads` (tests xmtp_address leak path)

This is the **highest-stakes secondary** because xmtp addresses are
real wallet identifiers — leaking them to a public channel would
compromise user identity on-chain.

```sql
-- Pre-flight: confirm the table accepts the values we'll use
SELECT column_name, is_nullable, data_type
  FROM information_schema.columns
 WHERE table_schema='public' AND table_name='negotiation_threads'
   AND column_name IN ('initiator_user_id', 'receiver_user_id',
                       'initiator_xmtp_address', 'receiver_xmtp_address',
                       'state', 'current_turn', 'topic', 'deliberation_score')
 ORDER BY ordinal_position;

-- Insert a synthetic thread (replace UUIDs as before; xmtp_addresses
-- are arbitrary 0x… strings here — they're test sentinels)
INSERT INTO negotiation_threads (
    initiator_user_id,
    receiver_user_id,
    initiator_xmtp_address,
    receiver_xmtp_address,
    state,
    current_turn,
    topic,
    deliberation_score
) VALUES (
    '<UUID_A>'::uuid,
    '<UUID_B>'::uuid,
    '0xprivacyprobe11111111111111111111111111aa',  -- distinctive xmtp marker
    '0xprivacyprobe22222222222222222222222222bb',
    'proposed',
    'initiator',
    'privacy-probe-topic-2026-05-16',
    99.99
)
RETURNING id;
```

**Public payload should contain ONLY:**
- `agent_initiator`, `agent_receiver` (anonymized)
- `state`, `current_turn`

**Public payload MUST NOT contain:**
- `initiator_user_id`, `receiver_user_id` (real UUIDs)
- `initiator_xmtp_address`, `receiver_xmtp_address` (the `0xprivacyprobe...` markers — easy to spot if leaked)
- `topic`, `deliberation_score`
- `id`

**Cleanup:**

```sql
DELETE FROM negotiation_threads
 WHERE topic = 'privacy-probe-topic-2026-05-16'
 RETURNING id;
```

### Secondary B — `agent_positions` (tests position-snapshot path)

Position data is spatial, NOT identity — the public payload *does*
intentionally include tile coordinates. But the user_id MUST be
anonymized to `agent_id`.

```sql
-- Flip is_thinking on an existing agent_positions row. The trigger
-- fires on UPDATE; this flip is a no-op state change but exercises
-- the dual-broadcast.

-- Find a row first
SELECT user_id, is_thinking
  FROM agent_positions
 LIMIT 1;
-- Copy the user_id

UPDATE agent_positions
   SET is_thinking = NOT is_thinking,
       updated_at = now()
 WHERE user_id = '<COPIED_USER_ID>'::uuid
 RETURNING user_id, is_thinking, updated_at;
-- Then flip it back to restore original state
UPDATE agent_positions
   SET is_thinking = NOT is_thinking,
       updated_at = now()
 WHERE user_id = '<COPIED_USER_ID>'::uuid;
```

**Public payload should contain:**
- `agent_id` (anonymized, NOT the real user_id)
- `tile_x`, `tile_y`, `facing_dx`, `facing_dy`
- `is_moving`, `is_thinking`, `is_speaking`
- `activity_emoji`, `activity_until`

**Public payload MUST NOT contain:**
- `user_id` (raw UUID leak — this is the load-bearing check)

### Secondary C — `instaclaw_vms` (production-risk; SKIP unless necessary)

Probing this trigger requires flipping `health_status` on a real VM
row, which is shared with the gateway / watchdog / reconciler. The
trigger short-circuits on `OLD.health_status IS NOT DISTINCT FROM
NEW.health_status`, so a no-op UPDATE won't fire. To force a broadcast,
you'd have to actually transition a VM's health_status — which has
real customer impact.

**Recommendation: SKIP.** The trigger function source is identical in
structure to the other three; if primary + secondaries A and B pass,
this one passes too. If you need a true probe later, pick a `frozen`
or `destroyed` VM (no customer attached) and flip its status.

---

## Emergency Rollback (use ONLY if primary probe FAILS)

If the public payload contains ANY forbidden field, run this
immediately:

```sql
-- Stop all four triggers from firing on subsequent writes
DROP TRIGGER IF EXISTS trg_matchpool_outcomes_dual_broadcast ON public.matchpool_outcomes;
DROP TRIGGER IF EXISTS trg_negotiation_threads_dual_broadcast ON public.negotiation_threads;
DROP TRIGGER IF EXISTS trg_instaclaw_vms_dual_broadcast ON public.instaclaw_vms;
DROP TRIGGER IF EXISTS trg_agent_positions_dual_broadcast ON public.agent_positions;

-- Drop the trigger functions
DROP FUNCTION IF EXISTS village.emit_matchpool_outcome();
DROP FUNCTION IF EXISTS village.emit_negotiation_thread();
DROP FUNCTION IF EXISTS village.emit_vm_lifecycle();
DROP FUNCTION IF EXISTS village.emit_agent_position();

-- The anonymize helper + village schema are harmless to leave in place
-- (no behavior without the triggers). Drop only if doing a full
-- migration reset:
-- DROP FUNCTION IF EXISTS village.anonymize_user_id(uuid);
-- DROP SCHEMA IF EXISTS village;
```

After rollback, verify:

```sql
SELECT COUNT(*) AS active_triggers
  FROM information_schema.triggers
 WHERE trigger_name LIKE 'trg_%_dual_broadcast';
-- Expected: 0
```

Leave the synthetic probe row in `matchpool_outcomes` for forensics
(or DELETE it if you've already captured the leaked payload to
report). The triggers are gone; subsequent writes won't broadcast.

Report the offending payload to Claude with the specific forbidden
field(s) named. The fix is almost certainly a typo in the
`jsonb_build_object(...)` call of the offending trigger function in
`pending_migrations/20260516210000_village_dual_channel_triggers.sql`
— compare line by line against the public-branch whitelist documented
in the file header.

---

## Why Synthetic Data, Not Real Match Traffic

You could wait for a real match to fire the trigger and observe its
broadcast. The probe doesn't do that because:

1. **Determinism.** A real match's `rrf_score` is whatever the matching
   engine computed; if it accidentally leaked, you'd see a score that
   looks plausible. The `99.99` sentinel is out-of-band — any leak is
   immediately obvious in the payload.

2. **Cleanup.** Real matches don't get DELETE'd. The probe must clean
   up after itself; only synthetic rows are safe to remove.

3. **No timing dependency.** A real match might not happen for hours.
   The probe runs on demand.

4. **Distinctive grep.** `match_engine = 'privacy-probe-2026-05-16'`
   uniquely identifies the test row in cleanup AND in the broadcast
   inspector, even if other matches happen during the probe window.
