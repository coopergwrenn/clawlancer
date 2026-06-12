-- instaclaw_frontier_spend_approvals -- the pending-approvals table for the
-- human_approved hardening (Model C tiered, phased). Surface 1 of the build.
--
-- WHY: /api/agent-economy/authorize is gateway-token-authed, which authenticates
-- the VM, not the human's intent (the token is readable by the agent). A hostile
-- prompt could set human_approved:true in the body and lift the earned-budget gate.
-- This table is the unforgeable channel: a spend the gate bounces to ask_first mints
-- a pending_approval row capturing the EXACT proposed spend (server-side, from the
-- authed authorize call); the human approves THAT row from their NextAuth browser
-- session (the one channel a VM-resident agent cannot emit on); the agent's
-- re-authorize then finds the approved row and proceeds. Consent is a channel
-- property, not a payload (the committed design's core principle).
--
-- One row per spend, keyed (vm_id, request_id). Captured identity (amount, category,
-- counterparty) is matched on re-authorize so the agent cannot get $1 approved and
-- then spend $100 on the same request_id (anti-amount-swap).
--
-- State machine: pending_approval -[session approve]-> approved -[authorize honors]-> consumed.
--   pending_approval -[session deny]-> denied. pending_approval/approved -[15min TTL]-> expired.
-- Terminal: consumed (single-use), denied, expired.
--
-- RLS (Rule 60): deny-all baseline. Service-role (the authorize route + the confirm
-- endpoint) bypasses RLS; the confirm endpoint scopes every read/write by
-- owner_id = session.user.id IN CODE. No anon/authenticated policies -- a fresh-DB
-- replay (pg_restore / supabase db push / disaster recovery) is RLS-on by the file,
-- not by an operator's Studio click.
--
-- Rule 56: has a CREATE TABLE, so it lives in pending_migrations/ until Cooper
-- applies it to prod, then git-mv to migrations/. verify-migrations.ts gates the
-- build on this CREATE TABLE once it's in migrations/.

CREATE TABLE IF NOT EXISTS public.instaclaw_frontier_spend_approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vm_id         uuid NOT NULL,
  owner_id      uuid NOT NULL,           -- = instaclaw_vms.assigned_to; the ONLY identity that may approve
  request_id    text NOT NULL,           -- the agent's spend idempotency key (single-use)
  amount_usd    numeric(14,6) NOT NULL,  -- the exact proposed amount; re-authorize MUST match
  category      text,                    -- spend identity (display + match)
  counterparty  text,                    -- display + match (address / endpoint / vm-id, whichever supplied)
  status        text NOT NULL DEFAULT 'pending_approval'
                  CHECK (status IN ('pending_approval','approved','denied','expired','consumed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,    -- created_at + 15min; a stale approval URL cannot be used later
  approved_at   timestamptz,             -- when the session approved
  consumed_at   timestamptz,             -- when the authorize route honored it (single-use)
  CONSTRAINT uq_fsa_vm_request UNIQUE (vm_id, request_id)
);

-- Row Level Security -- load-bearing. Deny-all to anon + authenticated; service-role
-- bypasses. Idempotent -- no-op on re-run.
ALTER TABLE public.instaclaw_frontier_spend_approvals ENABLE ROW LEVEL SECURITY;

-- The confirm endpoint lists a user's pending approvals by owner; the authorize
-- route looks up by (vm_id, request_id) which the UNIQUE constraint already indexes.
CREATE INDEX IF NOT EXISTS idx_fsa_owner_status
  ON public.instaclaw_frontier_spend_approvals (owner_id, status);

COMMENT ON TABLE public.instaclaw_frontier_spend_approvals IS
  'Frontier human_approved hardening: unforgeable session-rooted approval for a specific agent spend. Keyed (vm_id, request_id). RLS deny-all; service-role only.';
