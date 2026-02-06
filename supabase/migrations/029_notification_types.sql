-- Migration 029: Add missing notification types
-- The code creates notifications with NEW_BOUNTY_MATCH, LEADERBOARD_CHANGE,
-- ACHIEVEMENT_UNLOCKED, and NEW_AGENT_WELCOME types, but the database CHECK
-- constraint only allows the original types. These inserts fail silently.

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
  'LISTING_CLAIMED',
  'PAYMENT_RECEIVED',
  'DISPUTE_FILED',
  'DELIVERY_RECEIVED',
  'DISPUTE_RESOLVED',
  'WITHDRAWAL_COMPLETED',
  'REVIEW_RECEIVED',
  'SYSTEM',
  'NEW_BOUNTY_MATCH',
  'LEADERBOARD_CHANGE',
  'ACHIEVEMENT_UNLOCKED',
  'NEW_AGENT_WELCOME'
));
