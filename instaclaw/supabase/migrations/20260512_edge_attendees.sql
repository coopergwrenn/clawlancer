-- ============================================
-- Edge Esmeralda 2026 — verified ticket holders
-- ============================================
-- Source of truth for "this user has an Edge ticket". Populated from
-- Timour's CSV via scripts/_ingest-edge-attendees.ts (idempotent upsert).
-- The signIn callback (lib/auth.ts) reads this table on Edge claim and
-- mirrors the result into instaclaw_users.is_edge_attendee for cheap
-- lookups on hot paths (/connect skip-button routing, dashboard gating).
--
-- Lookup key is `email`, always lowercased + trimmed at write time. A
-- CHECK constraint forbids uppercase emails so a misbehaving caller
-- can't break the unique-index dedup.
--
-- claimed_at is set when the attendee signs up and links to a user row
-- (either via the ingest script's backfill or the signIn helper). It is
-- informational — the unique key is email, not claimed_at.

CREATE TABLE IF NOT EXISTS instaclaw_edge_attendees (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT NOT NULL,
  ticket_id    TEXT,
  claimed_at   TIMESTAMPTZ,
  user_id      UUID REFERENCES instaclaw_users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT instaclaw_edge_attendees_email_lower_chk
    CHECK (email = LOWER(email))
);

CREATE UNIQUE INDEX IF NOT EXISTS instaclaw_edge_attendees_email_key
  ON instaclaw_edge_attendees (email);

-- Partial index — only attendees who have actually claimed (not the long
-- tail of un-linked rows). Used by admin queries like "how many tickets
-- have been claimed so far?".
CREATE INDEX IF NOT EXISTS idx_instaclaw_edge_attendees_user_id
  ON instaclaw_edge_attendees (user_id)
  WHERE user_id IS NOT NULL;

COMMENT ON TABLE instaclaw_edge_attendees IS
  'Verified Edge Esmeralda 2026 ticket holders. Ingested from Timour''s ticket CSV via scripts/_ingest-edge-attendees.ts. Email is the lookup key (always lowercased + trimmed; enforced by CHECK constraint). user_id + claimed_at are set when the attendee signs up — either by the ingest backfill (for users who signed up before the CSV landed) or by the signIn callback in lib/auth.ts (for users who sign up after).';

COMMENT ON COLUMN instaclaw_edge_attendees.ticket_id IS
  'Edge-side ticket identifier from the CSV. Nullable — some CSV exports may not include it. Informational only; we do not validate against Edge''s ticketing system at runtime.';

COMMENT ON COLUMN instaclaw_edge_attendees.claimed_at IS
  'When the attendee linked to a user account. NULL while still un-claimed (ticket holder hasn''t signed up yet).';

-- ============================================
-- Denormalized cache on instaclaw_users
-- ============================================
-- The attendees table is the source of truth. This boolean is the cache
-- so hot-path checks (e.g., should /connect''s skip-button route to
-- /dashboard?) don''t need an attendees-table join. Maintained by:
--   • lib/edge-attendees.ts:linkEdgeAttendeeByEmail (signIn time, per user)
--   • scripts/_ingest-edge-attendees.ts (CSV ingest, bulk backfill)
--
-- If the cache and the attendees table ever drift, the attendees table
-- is correct. The cache can be rebuilt by running the ingest script with
-- the latest CSV.

ALTER TABLE instaclaw_users
  ADD COLUMN IF NOT EXISTS is_edge_attendee BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_instaclaw_users_is_edge_attendee
  ON instaclaw_users (is_edge_attendee)
  WHERE is_edge_attendee = true;

COMMENT ON COLUMN instaclaw_users.is_edge_attendee IS
  'Denormalized cache: true iff the user''s email appears in instaclaw_edge_attendees. Maintained by lib/edge-attendees.ts and the ingest script. The attendees table is the source of truth; this column exists for cheap lookups on hot paths.';
