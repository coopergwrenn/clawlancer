-- Guard 2: Soft-consume pending records instead of deleting immediately.
-- Allows re-reading token data if a second configure fires before cleanup.
ALTER TABLE instaclaw_pending_users ADD COLUMN consumed_at TIMESTAMPTZ DEFAULT NULL;
