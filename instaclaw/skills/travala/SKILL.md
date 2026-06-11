---
name: travala
description: >-
  Travel Agent — book real flights, hotels, and lodging end to end. Use when the
  user wants to BOOK or RESERVE a hotel/stay/trip (not just look one up): "book me
  a hotel in Lisbon", "reserve that room", "book the trip". Discovery is free;
  booking spends real USDC and ALWAYS requires the user's explicit confirmation.
  Routes payment through the platform's proven x402 rail — never invent payment
  logic, never sign a transfer yourself.
---

## STOP — Is This Skill Set Up?

Booking spends the user's real money, so it is OFF by default and double-gated.
Before attempting a booking, know these two switches (you cannot flip them):

1. **The "Travel Agent" card toggle** (`travala_booking_enabled`, per agent) must
   be ON. If a `book-quote` comes back `gated / travala_booking_not_enabled`, tell
   the user: *"Booking isn't enabled for me yet — turn on the Travel Agent card at
   instaclaw.io and make sure your wallet's funded, then I can book."* Do NOT try
   to work around it.
2. **Autonomous spend** (the frontier gate) must allow a travel-sized charge. A
   booking that returns `authorized:false / outcome:"deny"` means the spend ceiling
   for travel isn't open yet — tell the user plainly; do not retry or improvise.

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

You MUST use these. NEVER call the Travala MCP `travala_book` tool directly — it is
intentionally not wired as a native tool on your VM so you cannot pay around the
consent gate. NEVER sign a transfer or build an X-PAYMENT yourself.

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

**Rule 5 — You can't cancel or change a booking yet — don't pretend you can.**
This skill only searches and books; it has no cancel or modify capability. If the
user asks to cancel, change dates, or get a refund AFTER booking, do NOT invent a
tool, do NOT claim you've cancelled, and do NOT try to "undo" the payment. Say so
plainly and point them to the real path: *"I can't cancel or change a booking
through me yet — use the manage-booking link in your Travala confirmation email,
or sign in at travala.com, within the cancellation window I told you about."* When
the cancellation window matters, restate the policy you gave at booking. (A real
on-chain refund, when it happens, comes back to your wallet from Travala directly —
nothing for you to do.)

## How to book (the flow)

1. **Search** (free):
   ```bash
   node ~/.openclaw/skills/travala/scripts/travala-search.mjs --type hotel \
     --args '{"location":"Lisbon","checkIn":"2026-06-24","checkOut":"2026-06-26","guests":2}' --json
   ```
   Present 1–3 good options with price + cancellation policy. Note each option's
   `packageId` and `sessionId`.

2. **Summarize for the user.** The chosen option, price, dates, guests, and cancel
   policy. (No chat "yes" needed yet — the real consent is the dashboard tap.)

3. **Book** (kicks off approval, then pays):
   ```bash
   node ~/.openclaw/skills/travala/scripts/travala-book.mjs \
     --package-id <packageId> --session-id <sessionId> \
     --customer '{"firstName":"...","lastName":"...","email":"...","phone":"..."}' \
     --max-usd <a-cap-at-or-above-the-quote> --why "Lisbon hotel, Jun 24–26" --json
   ```
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
   - **`outcome: "deny"`** — over the user's travel spending limit; relay the reason
     plainly. Do not retry or improvise (they'd raise the limit in their dashboard).
   - **`gated`** — booking isn't enabled for this agent / paused fleet-wide (see the
     STOP section). Relay plainly.

4. **Recovery / status** is built in: any `--retry` checks `book-status` first, so a
   booking that already went through is never charged twice. Always resume with
   `--retry --request-id <id>`; never start a fresh `request_id` for the same quote
   (the user's approval is bound to that exact spend).

## Routing — StableTravel plans, Travala books

- "find / compare / how much is a hotel or flight" → **StableTravel** search
  (planning, no money). This is the default for any non-booking travel question.
- "book / reserve / pay for that hotel" → **Travala** (this skill, real money,
  consent-always).

If booking isn't enabled (STOP section), you can still plan the whole trip with
StableTravel and hand the user direct links to book themselves.

<!-- SKILL_SENTINEL: travala-book.mjs consent-always frontier-rail -->
