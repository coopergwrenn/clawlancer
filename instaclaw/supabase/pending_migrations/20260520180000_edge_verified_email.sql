-- EdgeOS ticket pre-validation: enforce 1-agent-per-verified-email FOR EDGE
-- ATTENDEES ONLY. This column protects the sponsor-funded inference budget
-- during the 28-day Edge Esmeralda 2026 village (2026-05-30 → 2026-06-27).
--
-- IMPORTANT: This is an EDGE-SPECIFIC constraint. The main InstaClaw signup
-- flow MUST continue to support multi-agent users (one user → many agents,
-- a feature being designed for post-Edge). Do NOT generalize this constraint
-- to the existing `email` column or any other surface — it ONLY applies to
-- the verified-via-EdgeOS-directory path.
--
-- Mechanism:
--   1. /edge/claim takes an email, calls EdgeOS attendees-directory API.
--   2. On verified hit, /api/edge/verify-ticket writes the email here
--      (either via the session-tied path, or via lib/auth.ts signIn
--      callback that reads the signed `edge_verified_email` cookie).
--   3. Partial UNIQUE index below blocks a second user record from
--      claiming the same EdgeOS email. NULL values are allowed
--      indefinitely so non-Edge signups never hit this constraint.
--
-- Schema:
--   `edge_verified_email TEXT NULL`
--     - The email that matched in the EdgeOS attendees directory.
--     - Stored separately from `email` because:
--       (a) the user's signin email (Google account) may differ from
--           the email they registered with for Edge Esmeralda
--       (b) Edge-specific lifecycle (we may need to nullify post-village
--           per Rule 22 data-handling, without touching the user's auth
--           email)
--   `users_edge_verified_email_uniq` (partial UNIQUE index, WHERE NOT NULL)
--     - Catches dual-claim at the DB level: if two paths somehow both
--       try to write the same edge_verified_email value, the second
--       INSERT/UPDATE fails with 23505 and the API surfaces "already
--       claimed" cleanly.
--     - Partial-on-NOT-NULL is critical: a full UNIQUE would treat
--       multiple NULLs as a constraint violation in some Postgres
--       configurations (Postgres allows multiple NULLs, but some ORMs
--       trip on it). Explicit partial avoids that.
--
-- Operator escape hatch: EDGE_VERIFIED_OVERRIDE_EMAILS env var bypasses
-- the EdgeOS API call (not this constraint). Even override-list emails
-- get written here on successful tag so the UNIQUE catches dual-attempts.

ALTER TABLE instaclaw_users
  ADD COLUMN IF NOT EXISTS edge_verified_email TEXT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_edge_verified_email_uniq
  ON instaclaw_users (edge_verified_email)
  WHERE edge_verified_email IS NOT NULL;

COMMENT ON COLUMN instaclaw_users.edge_verified_email IS
  'Email that matched in EdgeOS attendees directory at /edge/claim. UNIQUE-on-not-null. EDGE-ONLY — do not generalize.';
