---
name: travala
description: >-
  Travel Agent — book AND cancel real hotels and stays end to end. Use when the
  user wants to BOOK or RESERVE a hotel/stay (not just look one up): "book me a
  hotel in Lisbon", "reserve that room"; or to CANCEL / look up a booking they
  made through you: "cancel my hotel", "what's my booking". Discovery is free;
  booking spends real USDC and always requires the user's explicit confirmation;
  cancelling requires a code Travala emails to the booking address. Hotels and
  stays only (no flights). Routes payment through the platform's proven x402 rail
  — never invent payment logic, never sign a transfer yourself.
---

## STOP — What Booking Actually Needs (the money is gated, not the door)

Searching is free for every user, always: no setup, no wallet, no plan. Never tell
a user to enable anything before searching, and never pre-screen them yourself —
attempt the flow, and relay the platform's answer at the moment it appears. The
platform gates the MONEY, and it speaks through the booking script's narrations.
The real requirements, each asked at the moment it matters:

1. **A paid plan (Pro or Power) for autonomous booking.** Searching and quoting
   stay free for everyone, including Starter. If a booking attempt is denied for
   the plan, the script's narration IS the moment: it is proud of the search it
   just did, honest that autonomous booking starts at Pro, and names the upgrade
   path. Relay it as-is. Never apologize for it, never say "unfortunately".
2. **Autonomous spending turned on** (one-time, dashboard → Spending settings).
   The `spend_not_enabled` narration names the path. Relay as-is.
3. **A funded agent wallet** (USDC on Base). The `would_drain_wallet` narration
   gives the exact amount needed and the full wallet address. Relay as-is.
4. **A one-tap dashboard approval for THIS booking** — every booking, every time.
   That tap is the consent; a chat "yes" is never enough (see Rule 2).

A `gated` response now means exactly one thing: the operator paused booking
platform-wide (an emergency stop). Relay plainly and suggest trying later.

**NEVER** build your own Travala client, sign a USDC transfer, call `travala_book`
directly, write `.env` files, or construct an X-PAYMENT by hand. The platform
manages the OAuth token (off your VM), the payment rail, and the consent gate.
Improvising here moves real money incorrectly.

---

# Travel Agent (Travala) — discover free, book with consent

```yaml
name: travala            # internal skill id
display: Travel Agent    # what the user sees
version: 0.1.0
updated: 2026-06-10
author: InstaClaw / Wild West Bots
triggers:
  keywords: [book hotel, reserve, booking, travala, stay, lodging, accommodation, check in, check out, nights]
  phrases: ["book me a hotel", "reserve that room", "book the trip", "book a stay", "reserve a hotel in"]
  NOT: [just looking, what's the weather, flight status only, "how much is a hotel" (that's a search, see below)]
```

## MANDATORY RULES — read before any booking

**Rule 0 — Use the platform scripts. Never improvise payments.**
The skill's scripts live at `~/.openclaw/skills/travala/scripts/`:
- `travala-search.mjs` — find hotels/packages (free, public, no money).
- `travala-book.mjs` — book one (routes through the frontier x402 rail + consent).
- `travala-manage.mjs` — look up a booking's details + cancellation policy (read-only).
- `travala-cancel.mjs` — cancel a booking the user made through you (two-step, email code).

You MUST use these. NEVER call the Travala MCP `travala_book` / `travala_cancel_booking`
/ `travala_manage_bookings` tools directly — they are intentionally not wired as native
tools on your VM so you cannot pay or cancel around the platform's gates. NEVER sign a
transfer or build an X-PAYMENT yourself.

**Rule 1 — Two steps, never one: SEARCH, then (with consent) BOOK.**
Discovery and booking are separate on purpose. A search returns a `packageId` +
`sessionId`. You may search freely. You may book ONLY after the user explicitly
confirms the specific option, price, and guest details.

**Rule 2 — Consent is ALWAYS required, and the user approves it from their dashboard (one tap).**
A chat "yes" is NOT enough to spend money on a booking — the platform requires an
unforgeable browser-session approval (so a confused or hijacked agent can never
spend on its own). The flow:
- You present the booking summary: hotel/package, dates, guests, total price, and
  cancellation policy.
- You run `travala-book.mjs`. It returns an **approval link** (`approval_url`).
- You give the user the link and say: *"approve this $X booking from your dashboard
  — one tap."*
- The user taps it (in their logged-in browser). Then you finish the booking.
Never assume approval. Never claim a booking is done before the user has tapped.
One booking = one dashboard tap.

**Rule 3 — The price you charge is the on-chain price, not the sticker price.**
The platform authorizes and signs against the booking's `maxAmountRequired` (the
exact USDC amount), which can be a few cents above the displayed price (fees).
The script handles this — never hand-edit an amount.

**Rule 4 — Refundable first, and tell the user the policy.**
Prefer refundable inventory and always state the cancellation policy in your
confirmation. The user is spending real money on a real reservation.

**Rule 5 — You CAN cancel a booking the user made through you. Refunds are Travala
credit, never crypto back to the wallet — never say otherwise.**
You can cancel and look up bookings made through you (see "How to cancel", below).
Two hard truths you must always tell the user honestly:
- **Refunds are Travala Travel Credit, not USDC.** When a booking is cancelled,
  any refund posts as **Travala travel credit to their account, ~7 business days
  later — it does NOT come back on-chain to their wallet.** The crypto payment is
  final. NEVER promise USDC back, a wallet refund, or an on-chain reversal. Say
  "expected as Travala credit", never "refunded" as if it's done and in-wallet.
- **You can't change dates or rooms — that's cancel-and-rebook.** Travala has no
  modify/amend tool. If the user wants different dates or a different room, the
  only path is: cancel the existing booking (within its policy, possibly with a
  fee) and book a new one. Tell them that plainly; don't imply an in-place change.

If a booking wasn't made through you (no record on this agent), you can't cancel it
— tell them to use travala.com or their Travala confirmation email.

## How to book (the flow)

1. **Search** (free):
   ```bash
   node ~/.openclaw/skills/travala/scripts/travala-search.mjs --type hotel \
     --args '{"location":"Lisbon","checkIn":"2026-06-24","checkOut":"2026-06-26","rooms":["2"]}' --json
   ```
   Present 1–3 good options with price + cancellation policy. Note each option's
   `packageId` and `sessionId`.

2. **Summarize for the user.** The chosen option, price, dates, guests, and cancel
   policy. (No chat "yes" needed yet — the real consent is the dashboard tap.)

3. **Book** (kicks off approval, then pays, then saves the booking so you can cancel it later):
   ```bash
   node ~/.openclaw/skills/travala/scripts/travala-book.mjs \
     --package-id <packageId> --session-id <sessionId> \
     --customer '{"firstName":"...","lastName":"...","email":"...","phone":"..."}' \
     --max-usd <a-cap-at-or-above-the-quote> --why "Lisbon hotel, Jun 24–26" \
     --snapshot '{"hotelName":"...","checkIn":"2026-06-24","checkOut":"2026-06-26","room":"...","displayPrice":219.00,"currency":"USD","cancellationPolicy":"<the policy string from search>","freeCancellationUntilUtc":"<the deadline from search, if any>","refundable":true}' \
     --json
   ```
   **Always pass `--snapshot`** with the chosen option's details *from the search
   result* (hotel name, dates, room, price, the cancellation policy string, and
   the free-cancellation deadline). This is saved with the booking and is what
   lets you tell the user their real cancellation deadline later — it is
   impossible to recover once the search session expires. Use the customer's
   REAL email: it's where Travala sends the cancellation code if they ever cancel.
   Possible outcomes:
   - **`awaiting_approval: true`** (the normal first response) — the script returns
     an `approval_url` and a `request_id`. Give the user the link: *"approve this $X
     booking from your dashboard — one tap: <approval_url>"*. When they tell you
     they've tapped it, **resume the SAME booking** by re-running with
     `--retry --request-id <that request_id>` (plus the same `--package-id`,
     `--session-id`, `--customer`, `--max-usd`). The link expires in 15 minutes; if
     it does, the resume returns a fresh `approval_url` — just relay the new one.
   - **`paid: true`** — done. Report the booking ref, dates, total paid, tx hash,
     and cancel policy.
   - **`outcome: "deny"`** — the script's narration already explains the TRUE cause:
     over the travel limit, spending paused by the operator, autonomous spending
     turned off, or a booking attempt that was already finalized/revoked. Relay that
     narration as-is — it names the real remedy. Do not retry or improvise.
   - **`gated`** — the operator paused booking platform-wide (emergency stop; see
     the STOP section). Relay plainly and suggest trying later.

4. **Recovery / status** is built in: any `--retry` checks `book-status` first, so a
   booking that already went through is never charged twice. Always resume with
   `--retry --request-id <id>`; never start a fresh `request_id` for the same quote
   (the user's approval is bound to that exact spend).

## How to cancel (or look up) a booking

You can cancel or look up any booking the user made **through you** (it's saved in
your trips with a booking ref). Cancellation is protected by a code Travala emails
to the booking address — so it's a **two-step** flow, and you can't skip it.

1. **(Recommended first) Show the booking + its cancellation policy** so the user
   sees the deadline and any fee before they decide:
   ```bash
   node ~/.openclaw/skills/travala/scripts/travala-manage.mjs --booking-id <ref> --json
   ```
   This returns "I emailed a code…" — ask the user to read back the 6 digits, then:
   ```bash
   node ~/.openclaw/skills/travala/scripts/travala-manage.mjs --booking-id <ref> --otp <code> --json
   ```
   Now you can state the real status, dates, price, and cancellation policy.

2. **Cancel (two steps):**
   ```bash
   node ~/.openclaw/skills/travala/scripts/travala-cancel.mjs --booking-id <ref> --json
   ```
   - Returns **`otp_sent`** → tell the user: *"Travala just emailed a 6-digit code
     to the booking email — read it back to me and I'll finish the cancellation."*
     Do NOT guess the code. Wait for the user (it's fine if they take a while — the
     flow resumes whenever they come back with the code).
   - When they give you the code:
     ```bash
     node ~/.openclaw/skills/travala/scripts/travala-cancel.mjs --booking-id <ref> --otp <code> --json
     ```
   - **`cancelled`** → it's done. Report any refund honestly: *"Cancelled. A refund
     of $X (after any fee) is **expected as Travala travel credit**, usually within
     ~7 business days — not back to your wallet."* If no amount came back, say the
     refund "will come back as Travala credit; check your Travala account."
   - **`bad_otp`** → the code was wrong or expired. Offer to send a fresh one
     (re-run step 2 without `--otp`).
   - **`not_your_booking`** → you have no record of it; they must use travala.com.

**Never** tell the user a refund is going back to their wallet or on-chain. **Never**
claim a cancellation is done before the `cancelled` state comes back. **Never** invent
a way to change dates in place — that's cancel-and-rebook (Rule 5).

## Routing — StableTravel plans, Travala books

- "find / compare / how much is a hotel or flight" → **StableTravel** search
  (planning, no money). This is the default for any non-booking travel question.
- "book / reserve / pay for that hotel" → **Travala** (this skill, real money,
  consent-always).

If booking is denied (plan, spending, funding — STOP section), you can still plan the whole trip with
StableTravel and hand the user direct links to book themselves.

<!-- SKILL_SENTINEL: travala-book.mjs consent-always frontier-rail -->
