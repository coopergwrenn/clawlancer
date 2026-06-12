# Travala booking — reference (read on demand)

Detailed mechanics behind the two scripts. The agent does not need this for a
normal booking; consult it for edge cases, errors, and recovery.

## The three gates (why a booking can be refused)

A booking proceeds only if ALL of these hold. The scripts surface the exact
reason; relay it to the user, don't improvise around it.

(History, so stale errors don't confuse you: the per-VM `travala_booking_enabled`
card toggle was retired from the booking path 2026-06-12, and booking was
decoupled from the `frontier_spend_enabled` "autonomous spending" switch the same
day — booking is human-approved spending, not autonomous spending, so neither
switch gates it. The gates that remain are the meaningful ones.)

1. **Operator kill switches** — emergency stops, fleet-wide, fail-closed.
   Reasons: `travala_booking_kill_switch`, `spend_kill_switch` (+ their
   `_unverifiable` variants when the platform can't read its own brake).
2. **Frontier spend gate** (`/api/agent-economy/authorize`, category `travel`) —
   travel is a SESSION-REQUIRED category: the spend must be within the user's
   travel ceiling ($1200/booking, $3000/day) AND the user must approve it from
   their **browser session** (the dashboard tap). A chat "yes" / the forgeable
   `human_approved` bool does NOT authorize travel — by design (a hijacked agent
   can't forge it). `outcome:"deny"` = over the ceiling / category switched off
   in the user's Spending category controls (can't override); `outcome:"ask_first"`
   / `reason:"needs_session_approval"` = the script returns an `approval_url` for
   the user to tap, then you resume with `--retry --request-id <id>`.
3. **Funded Bankr USDC wallet** — the on-chain transfer needs USDC on Base. An
   underfunded wallet is refused BEFORE the tap is ever requested
   (`would_drain_wallet` — the narration carries the exact amount + address).

## What happens under the hood (you never do these by hand)

1. **Quote** — the backend mints a short-lived Travala OAuth token (kept OFF your
   VM), calls `travala_book`, and returns the x402 `402`'s `next_action`
   (`baseURL` + `path` + `body`) and `paymentRequirements`. The payment is USDC on
   Base via Coinbase, `exact` scheme.
2. **Authorize via session approval** — the script reads the on-chain amount
   (`maxAmountRequired`, not the sticker price) and calls the frontier gate as
   `category:"travel"`. The first call returns `ask_first` + an `approval_url`; the
   user taps it in their dashboard (single-use, 15-min TTL, bound to this exact
   spend); a re-authorize with the same `request_id` then returns authorized
   (`reason:"human_approved_session"`) and reserves the spend hold.
3. **Pay** — the platform's Bankr wallet signs the EIP-3009 transfer (no key on
   your VM) and POSTs the `X-PAYMENT` to Travala's pay endpoint
   (`payment-mcp.travala.com/m2m-payment/book`). That `X-PAYMENT` header is the
   SOLE authorization for the pay leg — no Bearer (the OAuth token gates only the
   quote step, not the payment). The settlement transaction hash comes back in the
   `payment-response` header.
4. **Settle** — the spend hold is flipped and the outcome recorded.

## Recovery (never double-charge)

If a payment fails or times out, the script has recorded a spend hold. To resume:

```bash
node ~/.openclaw/skills/travala/scripts/travala-book.mjs \
  --retry --request-id <the request_id from the awaiting_approval or failed run> \
  --package-id <same> --session-id <same> --customer '<same>' \
  --max-usd <same> --json
```

`--retry` is BOTH the "resume after the user tapped the approval" path AND the
"a pay failed, try again" path. It calls `book-status` FIRST — if the booking
already went through, it reports the existing booking and does NOT pay again.
Otherwise it re-authorizes the same `request_id` (now session-approved → reserves
the hold) and pays. Always keep the same `request_id` for one quote — the user's
approval is bound to that exact spend.

## Errors you may see

| reason | meaning | what to tell the user |
|---|---|---|
| `travala_booking_not_enabled` | card toggle off | "Turn on the Travel Agent card + fund your wallet." |
| `travala_booking_kill_switch` | operator stop | "Booking is paused right now; try later." |
| `awaiting_approval` (+ `approval_url`) | needs the dashboard tap | "Approve this $X booking from your dashboard — one tap: <approval_url>. Then tell me to continue." (resume with `--retry --request-id`) |
| `outcome:"deny"` | over the travel ceiling | "That's above your travel spending limit — raise it in your dashboard to book." |
| `approval_identity_mismatch` | the quote changed since the last approval | "The price changed — let me re-quote and ask you to approve the new total." (search again, fresh request_id) |
| `over_max:...` | quote exceeds `--max-usd` | Re-quote or raise the cap with the user's OK. |
| `pay_http_401` (or other `pay_http_NNN`) | Travala pay endpoint rejected the X-PAYMENT | The pay leg is X-PAYMENT-only (no Bearer — confirmed 2026-06-10). A 401 here is unexpected; re-run with `--retry --request-id` (book-status guards against a double charge). |
| `bankr_not_configured` | wallet not set up | "Your wallet isn't set up yet — contact support." |

## Search arguments

`travala-search.mjs --type hotel|package --args '<json>'`. Common hotel args:
`location`, `checkIn` (YYYY-MM-DD), `checkOut`, `guests`. The result includes,
per option, a `packageId` and `sessionId` you carry into the booking.
