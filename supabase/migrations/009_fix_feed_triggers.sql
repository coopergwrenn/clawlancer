-- Migration 009: Fix Feed Event Triggers
-- Only create feed events when transactions are actually funded/completed
-- Use correct event_type values that match the frontend

-- Drop existing trigger first
DROP TRIGGER IF EXISTS transaction_feed_trigger ON transactions;

-- Create improved trigger function
CREATE OR REPLACE FUNCTION create_transaction_feed_event()
RETURNS TRIGGER AS $$
DECLARE
  buyer_name TEXT;
  seller_name TEXT;
BEGIN
  -- Get agent names
  SELECT name INTO buyer_name FROM agents WHERE id = NEW.buyer_agent_id;
  SELECT name INTO seller_name FROM agents WHERE id = NEW.seller_agent_id;

  -- Only create TRANSACTION_CREATED event when state becomes FUNDED (not on insert)
  IF TG_OP = 'UPDATE' AND OLD.state = 'PENDING' AND NEW.state = 'FUNDED' THEN
    INSERT INTO feed_events (
      event_type, agent_id, agent_name, related_agent_id, related_agent_name,
      amount_wei, currency, description, metadata
    ) VALUES (
      'TRANSACTION_CREATED',
      NEW.buyer_agent_id,
      buyer_name,
      NEW.seller_agent_id,
      seller_name,
      NEW.amount_wei,
      NEW.currency,
      NEW.description,
      jsonb_build_object('transaction_id', NEW.id)
    );
  END IF;

  -- Create TRANSACTION_RELEASED event when state becomes RELEASED
  IF TG_OP = 'UPDATE' AND OLD.state != 'RELEASED' AND NEW.state = 'RELEASED' THEN
    INSERT INTO feed_events (
      event_type, agent_id, agent_name, related_agent_id, related_agent_name,
      amount_wei, currency, description, metadata
    ) VALUES (
      'TRANSACTION_RELEASED',
      NEW.buyer_agent_id,
      buyer_name,
      NEW.seller_agent_id,
      seller_name,
      NEW.amount_wei,
      NEW.currency,
      NEW.description,
      jsonb_build_object('transaction_id', NEW.id)
    );
  END IF;

  -- Create TRANSACTION_REFUNDED event when state becomes REFUNDED
  IF TG_OP = 'UPDATE' AND OLD.state != 'REFUNDED' AND NEW.state = 'REFUNDED' THEN
    INSERT INTO feed_events (
      event_type, agent_id, agent_name, related_agent_id, related_agent_name,
      amount_wei, currency, description, metadata
    ) VALUES (
      'TRANSACTION_REFUNDED',
      NEW.buyer_agent_id,
      buyer_name,
      NEW.seller_agent_id,
      seller_name,
      NEW.amount_wei,
      NEW.currency,
      NEW.description,
      jsonb_build_object('transaction_id', NEW.id)
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Attach the new trigger (only on UPDATE, not INSERT)
CREATE TRIGGER transaction_feed_trigger
  AFTER UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION create_transaction_feed_event();

-- Also fix listing trigger to use correct event type
DROP TRIGGER IF EXISTS listing_feed_trigger ON listings;

CREATE OR REPLACE FUNCTION create_listing_feed_event()
RETURNS TRIGGER AS $$
DECLARE
  agent_name_val TEXT;
BEGIN
  SELECT name INTO agent_name_val FROM agents WHERE id = NEW.agent_id;

  INSERT INTO feed_events (
    event_type, agent_id, agent_name, related_agent_id, related_agent_name,
    amount_wei, currency, description, metadata
  ) VALUES (
    'LISTING_CREATED',
    NEW.agent_id,
    agent_name_val,
    NULL,
    NULL,
    NEW.price_wei,
    NEW.currency,
    NEW.title,
    jsonb_build_object('listing_id', NEW.id, 'listing_type', NEW.listing_type)
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER listing_feed_trigger
  AFTER INSERT ON listings
  FOR EACH ROW EXECUTE FUNCTION create_listing_feed_event();
