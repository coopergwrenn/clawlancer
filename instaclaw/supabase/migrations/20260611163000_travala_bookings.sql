-- instaclaw_travala_bookings — THE index of a user's Travala trips.
--
-- WHY THIS TABLE EXISTS (load-bearing, per the 2026-06-11 prep): the Travala MCP
-- has NO list-all-bookings tool (manage_bookings is single-lookup by bookingId),
-- and nothing in the booking flow persists a booking today — extractBookQuote
-- never sees a bookingId, and travala-book.mjs only parses a fragile ref via
-- regex over the x402 pay-response. So this is the ONLY record a booking ever
-- happened. cancel/manage both require {bookingId,lastName,email}; gate-2
-- ownership requires {vm_id}; and the free-cancellation deadline is irretrievable
-- once the search session expires. Capture-now-or-lose-forever.
--
-- WRITE POLICY: persist-on-confirmed-pay only (NOT at quote) — avoids orphan
-- "quoted-but-never-paid" rows; the frontier ledger already records attempts.
--
-- §9 LEDGER SEAM (standing ruling): the USDC spend is PERMANENT (x402/EIP-3009,
-- no reversal). A cancellation refunds as Travala Travel Credit to the account
-- ~7 business days later, OFF our ledger (no webhook). The refund_* columns here
-- are an INFORMATIONAL SNAPSHOT of what cancel_booking RETURNED (expected) —
-- never a confirmed receipt, and this lane NEVER credits the frontier budget or
-- calls the seller-side refund route. refund_destination is 'travala_credit',
-- never 'wallet'.
--
-- RLS (Rule 60): service-role only. The /api/travala route uses getSupabase()
-- (service role, which bypasses RLS). No anon/authenticated policies — default
-- deny. Rule 56: this file lives in pending_migrations/ until applied in Studio,
-- then git-mv'd to migrations/.

CREATE TABLE IF NOT EXISTS public.instaclaw_travala_bookings (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ── identity + ownership (gate-2 + the manage/cancel call inputs) ──
  vm_id                       uuid NOT NULL,           -- ownership gate: only this VM may manage/cancel
  user_id                     uuid NOT NULL,           -- the assigned user
  booking_id                  text,                    -- Travala bookingId (e.g. MN5V9DWQ); NULL if ref-parse failed
  last_name                   text NOT NULL,           -- required by manage_bookings + cancel_booking
  email                       text NOT NULL,           -- OTP destination + cancel secondary verification

  -- ── booking content (impossible to recover later; from search/book) ──
  hotel_name                  text,
  check_in                    date,
  check_out                   date,
  room                        text,
  display_price               numeric(12,2),           -- sticker price shown to the user
  currency                    text DEFAULT 'USD',
  cancellation_policy_string  text,                    -- human-readable policy snapshot
  free_cancellation_until_utc timestamptz,             -- THE deadline — gone once the search session expires
  is_refundable               boolean,

  -- ── spend linkage (frontier cross-ref; READ-ONLY reference, never a refund) ──
  amount_usd_paid             numeric(12,2),           -- on-chain USDC actually paid
  tx_hash                     text,                    -- x402 settlement tx
  hold_id                     uuid,                    -- frontier hold (from /authorize)
  request_id                  text,                    -- frontier request_id
  package_id                  text,                    -- Travala packageId (also lets book-status re-poll)
  session_id                  text,                    -- Travala sessionId (re-poll; may expire)
  booking_ref_raw             text,                    -- raw pay-response snippet the ref was parsed from (forensics)

  -- ── status + cancel snapshot ──
  status                      text NOT NULL DEFAULT 'confirmed', -- confirmed | cancel_requested | cancelled | cancel_failed
  cancel_requested_at         timestamptz,             -- when step-1 OTP was sent
  cancelled_at                timestamptz,
  refund_amount               numeric(12,2),           -- what cancel_booking RETURNED (expected, not confirmed-received)
  cancellation_fee            numeric(12,2),
  refund_destination          text DEFAULT 'travala_credit', -- NEVER 'wallet' (§9 standing ruling)
  cancel_raw                  jsonb,                   -- raw cancel_booking response (forensics)

  -- ── extensibility + timestamps ──
  meta                        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT instaclaw_travala_bookings_status_chk
    CHECK (status IN ('confirmed','cancel_requested','cancelled','cancel_failed'))
);

-- Row Level Security — load-bearing for the security model (Rule 60).
-- Service-role bypasses RLS; anon + authenticated get full deny (no policies).
-- Idempotent: no-op if already enabled.
ALTER TABLE public.instaclaw_travala_bookings ENABLE ROW LEVEL SECURITY;

-- gate-2 ownership lookups (the hot path on every manage/cancel).
CREATE INDEX IF NOT EXISTS instaclaw_travala_bookings_vm_id_idx
  ON public.instaclaw_travala_bookings (vm_id);

-- manage/cancel lookups by ref + a guard against double-recording one booking.
CREATE UNIQUE INDEX IF NOT EXISTS instaclaw_travala_bookings_booking_id_uidx
  ON public.instaclaw_travala_bookings (booking_id)
  WHERE booking_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS instaclaw_travala_bookings_user_id_idx
  ON public.instaclaw_travala_bookings (user_id);

COMMENT ON TABLE public.instaclaw_travala_bookings IS
  'The index of a user''s Travala trips (the MCP has no list-all). Persist-on-confirmed-pay. refund_* = informational snapshot of cancel_booking''s return; the USDC spend is permanent and refunds post as Travala credit off-ledger. RLS: service-role only.';
COMMENT ON COLUMN public.instaclaw_travala_bookings.free_cancellation_until_utc IS
  'Free-cancellation deadline from the search/book cancellation object. Irretrievable once the search session expires — capture at book time.';
COMMENT ON COLUMN public.instaclaw_travala_bookings.refund_destination IS
  'Always travala_credit, never wallet. The agent must say "expected as Travala credit ~7 business days", never "refunded to your wallet".';
COMMENT ON COLUMN public.instaclaw_travala_bookings.booking_id IS
  'Travala bookingId for manage/cancel. NULL when the pay-response ref-parse failed — booking_ref_raw holds the raw text for manual recovery.';
