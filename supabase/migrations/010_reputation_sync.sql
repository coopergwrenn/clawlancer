-- Migration 010: Reputation Sync
-- Function to recalculate agent stats from actual transaction data
-- Trigger to auto-update stats when transaction state changes to RELEASED

-- ============================================
-- FUNCTION: Recalculate single agent's stats
-- ============================================
CREATE OR REPLACE FUNCTION sync_agent_reputation(agent_uuid UUID)
RETURNS VOID AS $$
DECLARE
  completed_as_seller INT;
  completed_as_buyer INT;
  total_completed INT;
  total_non_pending INT;
  earned_wei NUMERIC(78);
  spent_wei NUMERIC(78);
  calc_success_rate NUMERIC(5,2);
  calc_tier TEXT;
BEGIN
  -- Count completed transactions as seller
  SELECT COUNT(*) INTO completed_as_seller
  FROM transactions
  WHERE seller_agent_id = agent_uuid AND state = 'RELEASED';

  -- Count completed transactions as buyer
  SELECT COUNT(*) INTO completed_as_buyer
  FROM transactions
  WHERE buyer_agent_id = agent_uuid AND state = 'RELEASED';

  total_completed := completed_as_seller + completed_as_buyer;

  -- Count total non-pending transactions (for success rate)
  SELECT COUNT(*) INTO total_non_pending
  FROM transactions
  WHERE (buyer_agent_id = agent_uuid OR seller_agent_id = agent_uuid)
    AND state IN ('RELEASED', 'REFUNDED', 'DISPUTED');

  -- Calculate total earned (as seller)
  SELECT COALESCE(SUM(amount_wei), 0) INTO earned_wei
  FROM transactions
  WHERE seller_agent_id = agent_uuid AND state = 'RELEASED';

  -- Calculate total spent (as buyer)
  SELECT COALESCE(SUM(amount_wei), 0) INTO spent_wei
  FROM transactions
  WHERE buyer_agent_id = agent_uuid AND state = 'RELEASED';

  -- Calculate success rate
  IF total_non_pending > 0 THEN
    calc_success_rate := (total_completed::NUMERIC / total_non_pending::NUMERIC) * 100;
  ELSE
    calc_success_rate := 100.00;
  END IF;

  -- Determine reputation tier based on completed transactions
  IF total_completed >= 50 THEN
    calc_tier := 'VETERAN';
  ELSIF total_completed >= 20 THEN
    calc_tier := 'TRUSTED';
  ELSIF total_completed >= 5 THEN
    calc_tier := 'RELIABLE';
  ELSE
    calc_tier := 'NEWCOMER';
  END IF;

  -- Update the agent record
  UPDATE agents SET
    transaction_count = total_completed,
    total_earned_wei = earned_wei,
    total_spent_wei = spent_wei,
    success_rate = calc_success_rate,
    reputation_tier = calc_tier
  WHERE id = agent_uuid;

END;
$$ LANGUAGE plpgsql;

-- ============================================
-- FUNCTION: Sync all agents' stats
-- ============================================
CREATE OR REPLACE FUNCTION sync_all_agent_reputations()
RETURNS TABLE(agent_id UUID, agent_name TEXT, old_count INT, new_count INT) AS $$
DECLARE
  agent_record RECORD;
  old_tx_count INT;
BEGIN
  FOR agent_record IN SELECT id, name, transaction_count FROM agents LOOP
    old_tx_count := agent_record.transaction_count;

    -- Sync this agent's stats
    PERFORM sync_agent_reputation(agent_record.id);

    -- Return the result
    agent_id := agent_record.id;
    agent_name := agent_record.name;
    old_count := old_tx_count;

    SELECT transaction_count INTO new_count FROM agents WHERE id = agent_record.id;

    RETURN NEXT;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- TRIGGER: Auto-sync when transaction RELEASED
-- ============================================
CREATE OR REPLACE FUNCTION trigger_sync_reputation_on_release()
RETURNS TRIGGER AS $$
BEGIN
  -- Only trigger when state changes to RELEASED
  IF NEW.state = 'RELEASED' AND (OLD.state IS NULL OR OLD.state != 'RELEASED') THEN
    -- Sync both buyer and seller stats
    PERFORM sync_agent_reputation(NEW.buyer_agent_id);
    PERFORM sync_agent_reputation(NEW.seller_agent_id);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing trigger if exists
DROP TRIGGER IF EXISTS reputation_sync_trigger ON transactions;

-- Create the trigger
CREATE TRIGGER reputation_sync_trigger
  AFTER UPDATE ON transactions
  FOR EACH ROW
  EXECUTE FUNCTION trigger_sync_reputation_on_release();

-- ============================================
-- RUN INITIAL SYNC FOR ALL AGENTS
-- ============================================
-- This runs once when the migration is applied
SELECT sync_all_agent_reputations();
