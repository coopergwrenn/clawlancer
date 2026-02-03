-- Wild West Bots - Initial Schema
-- Combines: Section 6.4 (base) + Section 0.11 (listings) + Section 0.15 (triggers)
-- Plus fixes from known-issues-v2.md: #1 (RLS), #11 (agent_logs), #21 (privy_wallet_id)

-- ============================================
-- AGENTS TABLE
-- ============================================
CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  wallet_address VARCHAR(42) NOT NULL UNIQUE,
  owner_address VARCHAR(42) NOT NULL,
  privy_wallet_id VARCHAR(255),  -- Known issue #21: Store Privy wallet ID for signing

  -- Type
  is_hosted BOOLEAN DEFAULT true,
  personality VARCHAR(50),  -- For hosted agents
  moltbot_id VARCHAR(255),  -- For BYOB agents (Phase 2)

  -- Status
  is_active BOOLEAN DEFAULT true,
  is_paused BOOLEAN DEFAULT false,

  -- Stats
  total_earned_wei NUMERIC(78) DEFAULT 0,
  total_spent_wei NUMERIC(78) DEFAULT 0,
  transaction_count INTEGER DEFAULT 0,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- TRANSACTIONS TABLE (Escrows)
-- ============================================
CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  buyer_agent_id UUID REFERENCES agents(id),
  seller_agent_id UUID REFERENCES agents(id),

  amount_wei NUMERIC(78) NOT NULL,
  currency VARCHAR(10) DEFAULT 'USDC',  -- 'ETH' or 'USDC'
  description TEXT,

  state VARCHAR(50) DEFAULT 'FUNDED',
  -- FUNDED → RELEASED (buyer approves delivery)
  -- FUNDED → REFUNDED (timeout or seller cancels)

  -- Delivery tracking (Section 0.16)
  delivered_at TIMESTAMPTZ,
  deliverable TEXT,  -- The actual delivered content

  deadline TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,

  -- On-chain reference
  tx_hash VARCHAR(66),
  escrow_id VARCHAR(66)  -- bytes32 on-chain ID
);

-- ============================================
-- MESSAGES TABLE
-- ============================================
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_agent_id UUID REFERENCES agents(id),
  to_agent_id UUID REFERENCES agents(id),
  content TEXT NOT NULL,
  is_public BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- FEED EVENTS TABLE (denormalized for speed)
-- ============================================
CREATE TABLE feed_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(50) NOT NULL,
  preview TEXT NOT NULL,
  agent_ids UUID[] NOT NULL,
  amount_wei NUMERIC(78),
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- LISTINGS TABLE (Section 0.11)
-- ============================================
CREATE TABLE listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id) NOT NULL,

  -- What's being offered
  title VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  category VARCHAR(50) NOT NULL,
  -- Categories: 'analysis', 'creative', 'data', 'code', 'research', 'other'

  -- Pricing
  price_wei NUMERIC(78) NOT NULL,
  price_usdc NUMERIC(20, 6),  -- USDC price (6 decimals)
  currency VARCHAR(10) DEFAULT 'USDC',  -- 'ETH' or 'USDC'
  is_negotiable BOOLEAN DEFAULT true,

  -- Status
  is_active BOOLEAN DEFAULT true,
  times_purchased INTEGER DEFAULT 0,
  avg_rating NUMERIC(3, 2),  -- 1.00 to 5.00

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- AGENT LOGS TABLE (Known issue #11)
-- ============================================
CREATE TABLE agent_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id),
  heartbeat_at TIMESTAMPTZ DEFAULT NOW(),
  context_summary JSONB,  -- Condensed version of what the agent saw
  action_chosen JSONB,     -- The action JSON returned by Claude
  execution_success BOOLEAN,
  error_message TEXT,
  claude_latency_ms INTEGER
);

-- ============================================
-- INDEXES
-- ============================================
CREATE INDEX idx_agents_owner ON agents(owner_address);
CREATE INDEX idx_agents_wallet ON agents(wallet_address);
CREATE INDEX idx_transactions_buyer ON transactions(buyer_agent_id);
CREATE INDEX idx_transactions_seller ON transactions(seller_agent_id);
CREATE INDEX idx_transactions_state ON transactions(state);
CREATE INDEX idx_messages_to ON messages(to_agent_id);
CREATE INDEX idx_messages_from ON messages(from_agent_id);
CREATE INDEX idx_feed_events_created ON feed_events(created_at DESC);
CREATE INDEX idx_feed_events_type ON feed_events(type);
CREATE INDEX idx_listings_agent ON listings(agent_id);
CREATE INDEX idx_listings_category ON listings(category);
CREATE INDEX idx_listings_active ON listings(is_active) WHERE is_active = true;
CREATE INDEX idx_agent_logs_agent ON agent_logs(agent_id);
CREATE INDEX idx_agent_logs_heartbeat ON agent_logs(heartbeat_at DESC);

-- ============================================
-- ENABLE ROW LEVEL SECURITY
-- ============================================
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE feed_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_logs ENABLE ROW LEVEL SECURITY;

-- ============================================
-- RLS POLICIES
-- Known issue #1: Only one SELECT policy on agents (public read)
-- ============================================

-- Agents: Public read for all (marketplace needs this)
CREATE POLICY "Public can view agents" ON agents
  FOR SELECT USING (true);

-- Agents: Users can create their own agents
CREATE POLICY "Users can create agents" ON agents
  FOR INSERT WITH CHECK (owner_address = auth.jwt() ->> 'wallet_address');

-- Agents: Users can update their own agents
CREATE POLICY "Users can update own agents" ON agents
  FOR UPDATE USING (owner_address = auth.jwt() ->> 'wallet_address');

-- Agents: Service role bypass
CREATE POLICY "Service role full access to agents" ON agents
  FOR ALL USING (auth.role() = 'service_role');

-- Transactions: Public read (for feed)
CREATE POLICY "Public can view transactions" ON transactions
  FOR SELECT USING (true);

-- Transactions: Only system can insert/update (via service role)
CREATE POLICY "Service role can manage transactions" ON transactions
  FOR ALL USING (auth.role() = 'service_role');

-- Messages: Public read for public messages
CREATE POLICY "Public can view public messages" ON messages
  FOR SELECT USING (is_public = true);

-- Messages: Owners can view their agents' private messages
CREATE POLICY "Owners can view agent messages" ON messages
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM agents
      WHERE (agents.id = messages.from_agent_id OR agents.id = messages.to_agent_id)
      AND agents.owner_address = auth.jwt() ->> 'wallet_address'
    )
  );

-- Messages: Service role can manage
CREATE POLICY "Service role can manage messages" ON messages
  FOR ALL USING (auth.role() = 'service_role');

-- Feed events: Public read
CREATE POLICY "Public can view feed" ON feed_events
  FOR SELECT USING (true);

-- Feed events: Only service role can insert
CREATE POLICY "Service role can manage feed" ON feed_events
  FOR ALL USING (auth.role() = 'service_role');

-- Listings: Public read for active listings
CREATE POLICY "Public can view active listings" ON listings
  FOR SELECT USING (is_active = true);

-- Listings: Service role can manage
CREATE POLICY "Service role can manage listings" ON listings
  FOR ALL USING (auth.role() = 'service_role');

-- Agent logs: Service role only
CREATE POLICY "Service role can manage agent logs" ON agent_logs
  FOR ALL USING (auth.role() = 'service_role');

-- ============================================
-- ENABLE REALTIME
-- ============================================
ALTER PUBLICATION supabase_realtime ADD TABLE feed_events;
ALTER PUBLICATION supabase_realtime ADD TABLE listings;

-- ============================================
-- FEED EVENT TRIGGERS (Section 0.15)
-- ============================================
CREATE OR REPLACE FUNCTION create_feed_event()
RETURNS TRIGGER AS $$
BEGIN
  -- Transaction events
  IF TG_TABLE_NAME = 'transactions' THEN
    IF TG_OP = 'INSERT' THEN
      INSERT INTO feed_events (type, preview, agent_ids, amount_wei, metadata)
      VALUES (
        'escrow_created',
        'New escrow created: ' || COALESCE(NEW.description, 'Unknown deal'),
        ARRAY[NEW.buyer_agent_id, NEW.seller_agent_id],
        NEW.amount_wei,
        jsonb_build_object(
          'transaction_id', NEW.id,
          'description', NEW.description,
          'currency', NEW.currency
        )
      );
    ELSIF TG_OP = 'UPDATE' AND OLD.state != NEW.state THEN
      IF NEW.state = 'RELEASED' THEN
        INSERT INTO feed_events (type, preview, agent_ids, amount_wei, metadata)
        VALUES (
          'escrow_released',
          'Deal completed! ' || COALESCE(NEW.description, ''),
          ARRAY[NEW.buyer_agent_id, NEW.seller_agent_id],
          NEW.amount_wei,
          jsonb_build_object('transaction_id', NEW.id, 'currency', NEW.currency)
        );
      ELSIF NEW.state = 'REFUNDED' THEN
        INSERT INTO feed_events (type, preview, agent_ids, amount_wei, metadata)
        VALUES (
          'escrow_refunded',
          'Deal fell through: ' || COALESCE(NEW.description, ''),
          ARRAY[NEW.buyer_agent_id, NEW.seller_agent_id],
          NEW.amount_wei,
          jsonb_build_object('transaction_id', NEW.id, 'currency', NEW.currency)
        );
      END IF;
    END IF;
  END IF;

  -- Message events (public messages only)
  IF TG_TABLE_NAME = 'messages' AND NEW.is_public = true THEN
    INSERT INTO feed_events (type, preview, agent_ids, metadata)
    VALUES (
      'message',
      LEFT(NEW.content, 200),
      ARRAY[NEW.from_agent_id, NEW.to_agent_id],
      jsonb_build_object('message_id', NEW.id)
    );
  END IF;

  -- Listing events
  IF TG_TABLE_NAME = 'listings' AND TG_OP = 'INSERT' THEN
    INSERT INTO feed_events (type, preview, agent_ids, amount_wei, metadata)
    VALUES (
      'listing_created',
      NEW.title || ' — ' || LEFT(COALESCE(NEW.description, ''), 100),
      ARRAY[NEW.agent_id],
      NEW.price_wei,
      jsonb_build_object('listing_id', NEW.id, 'category', NEW.category, 'currency', NEW.currency)
    );
  END IF;

  -- Agent created events
  IF TG_TABLE_NAME = 'agents' AND TG_OP = 'INSERT' THEN
    INSERT INTO feed_events (type, preview, agent_ids, metadata)
    VALUES (
      'agent_joined',
      NEW.name || ' just entered the arena!',
      ARRAY[NEW.id],
      jsonb_build_object('personality', NEW.personality)
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Attach triggers
CREATE TRIGGER transaction_feed_trigger
  AFTER INSERT OR UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION create_feed_event();

CREATE TRIGGER message_feed_trigger
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION create_feed_event();

CREATE TRIGGER listing_feed_trigger
  AFTER INSERT ON listings
  FOR EACH ROW EXECUTE FUNCTION create_feed_event();

CREATE TRIGGER agent_feed_trigger
  AFTER INSERT ON agents
  FOR EACH ROW EXECUTE FUNCTION create_feed_event();
