-- AgentBook hat banner — state-driven hat-claim tracking + state-scoped
-- dismissal.
--
-- Adds two columns to instaclaw_users:
--
-- 1) hat_claimed_at TIMESTAMPTZ NULL
--    When the user's free $100 hat was marked as claimed. Set by the
--    admin-only endpoint POST /api/admin/agentbook/mark-hat-claimed
--    (off-platform fulfillment for now). NULL = no hat claimed yet.
--    Hat ownership is per-ACCOUNT (not per-VM) per Cooper — multi-VM
--    users get one hat between them.
--
-- 2) agentbook_banner_dismissed_state TEXT NULL
--    Replaces the prior time-based dismissal pattern (which used
--    agentbook_banner_dismissed_at + 30-day TTL window) with state-
--    scoped dismissal. Stores ONE OF the discriminated banner states:
--      'nudge_verify'   — user not yet World-ID-verified
--      'nudge_register' — verified, has wallet, not yet registered in AgentBook
--      'nudge_claim'    — registered, hat not yet claimed
--    The banner-state API checks: if dismissed_state === current_state,
--    hide. If state has advanced (e.g., user registered → state moved
--    from 'nudge_register' to 'nudge_claim'), banner re-emerges with
--    the new state's copy. Lets the user dismiss noise from one stage
--    without permanently silencing the actionable next-stage CTA.
--
-- The legacy agentbook_banner_dismissed_at column from
-- 20260509_agentbook_banner_dismissal.sql is kept in place for backward
-- compat (no migration cost) but will be ignored by the new logic.
--
-- Idempotent: re-running is safe via IF NOT EXISTS.

ALTER TABLE instaclaw_users
  ADD COLUMN IF NOT EXISTS hat_claimed_at TIMESTAMPTZ;

ALTER TABLE instaclaw_users
  ADD COLUMN IF NOT EXISTS agentbook_banner_dismissed_state TEXT;

COMMENT ON COLUMN instaclaw_users.hat_claimed_at IS
  'When the user clicked "Claim my hat" on the banner — at which point they were redirected to https://humanrequired.shop/products/human-in-the-loop-hat for actual fulfillment. We optimistically record the click here so the banner stops nagging; humanrequired.shop is the authoritative source for whether a hat actually shipped. NULL = no click yet.';

COMMENT ON COLUMN instaclaw_users.agentbook_banner_dismissed_state IS
  'Banner state at which the user clicked dismiss. One of: nudge_verify | nudge_register | nudge_claim. Banner re-emerges when state advances to a different one (state-scoped dismissal, not blanket).';

-- Lightweight index for the sold-out count query
-- (SELECT count(*) FROM instaclaw_users WHERE hat_claimed_at IS NOT NULL).
-- At most 500 rows, but the partial index keeps it cheap regardless of
-- table growth.
CREATE INDEX IF NOT EXISTS instaclaw_users_hat_claimed_idx
  ON instaclaw_users (hat_claimed_at)
  WHERE hat_claimed_at IS NOT NULL;
