# Travala x402 booking lane — CANARY RUNBOOK

**Purpose:** the single controlled run that turns "very likely" into "proven" — an
agent books a real, refundable, sub-$100 hotel room with crypto, records it,
looks it up, cancels it, and we watch where the refund lands. **The bar: pure
execution. Every decision is made here, on paper, in advance — because an
in-the-moment decision during a real charge is where money gets lost.**

**Holds for Cooper's explicit GO. Do not run any money stage without it.**

Subject VM (the canary): **vm-1043**
- `id` = `0f64ac86-69d2-45f4-ac2d-a488714c4d0d`
- IP = `45.33.95.220`, user `openclaw`, health `healthy`, cv `128`
- wallet (`bankr_evm_address`, the EIP-3009 `from`) = `0xd998a6dc14e5ec290b2a9f201d6a6c82a1dd38c4`
- `assigned_to` = `59dcf829-22d0-4db5-8890-d9cde788b576`
- the money gate currently **OFF** (`frontier_spend_enabled=false`; the per-VM booking toggle was retired 2026-06-12 — spend opt-in + the per-booking tap are the gates)

Operator access (CLAUDE.md bootstrap):
```bash
[ -f /tmp/ic_ssh_key ] || (grep '^SSH_PRIVATE_KEY_B64=' /Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key \
  | head -1 | sed 's/^SSH_PRIVATE_KEY_B64=//; s/"//g' | base64 -d > /tmp/ic_ssh_key && chmod 600 /tmp/ic_ssh_key)
SSH_OPTS="-i /tmp/ic_ssh_key -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o BatchMode=yes"
SRK=$(grep -m1 '^SUPABASE_SERVICE_ROLE_KEY=' /Users/cooperwrenn/wild-west-bots/instaclaw/.env.local | sed 's/^[^=]*=//; s/^"//; s/"$//')
SB="https://qvrnuyzfqjrsjljcqbub.supabase.co/rest/v1"
```

---

## PRECONDITIONS — verify ALL before the GO (none are money moves)

1. **Code is on main + deployed.** Backend ops (`book-record/manage-booking/cancel-booking`)
   live (verified: `cancel-booking` no-auth → `401`; gated → `{"ok":false,"gated":true,"reason":"not_your_booking"}`).
   Nonce fix on main at `3c6bdaf6`.
2. **Cooper's Travala-account email** is the email used as `customer.email` at book time —
   it is BOTH the cancellation-OTP destination AND where the refund credit lands. Use a
   real inbox Cooper controls. **Decide the email now; it is not a runtime choice.**
3. **Wallet funded.** Send ~**$60 USDC on Base** to `0xd998…38c4` (covers a sub-$50 room +
   the few-cent x402 `maxAmountRequired` margin; EIP-3009 transfer is gasless for the wallet,
   the facilitator pays gas). Verify on Basescan before arming.
4. **Travel ceiling ≥ booking amount.** The `/authorize` §6 travel per-tx ceiling must allow
   the amount, else authorize hard-denies (`outcome:"deny"`). Confirm the ceiling for vm-1043.
   Full hard-deny set (tonight's main): limit-class (ceiling/banned/drain/privacy), operator
   kill (`spend_kill_switch`, `_unverifiable`), `spend_not_enabled`, `request_id_consumed`
   (revoked/settled id) — the script narrates the TRUE cause + remedy per class.
5. **Kill switches clear.** `instaclaw_admin_settings.travala_booking_kill_switch` absent or
   `bool_value=false`; `frontier_spend_kill_switch` likewise.
   ```bash
   curl -s "$SB/instaclaw_admin_settings?select=setting_key,bool_value&setting_key=in.(travala_booking_kill_switch,frontier_spend_kill_switch)" -H "apikey: $SRK" -H "Authorization: Bearer $SRK"
   ```
   Expect `[]` (absent = clear) or rows with `bool_value:false`.

---

## SEAMS LEDGER — what each open question is, where it resolves, and the decision NOW

| Seam | Resolves at | SUCCESS signature | FAILURE signature | Decision / on-fail action |
|---|---|---|---|---|
| **Q1b — machine-client email match** (the showstopper candidate). Our `client_credentials` token has no signed-in email; does Travala's `X-Travala-User-Email` match the booking's `authorized_email`? | **Stage 4 (manage step-1)** — the FIRST machine-client call against the REAL booking. | `{ok:true, state:"ok", step:1, ...}` — "Travala emailed a 6-digit code…". The machine client got past the email wall; OTP sent. | `{ok:false, state:"upstream_error", message:"…Unauthorized… / not signed in / does not own…"}`. | **If FAIL: STOP the cancel half.** Agent-driven manage/cancel via the machine client is not possible. Fall back: agent tells the user the stored cancellation policy + deadline and hands them the travala.com manage link (Cooper IS the booking-email owner, so HE can cancel there). Escalate to Igor/Travala for an m2m manage/cancel path. The booking is still cancellable by Cooper directly — no money trapped. |
| **m2m refund destination** | **Stage 7 (refund-watch)** + the `refund_amount` echoed at Stage 6. | Value appears as **Travala Travel Credit** on Cooper's Travala account (~7 business days). | Value appears anywhere else (wallet, original card) — or never appears. | ASSUMED `travala_credit` (research on direct-crypto Travala refunds). **Observe the actual landing.** The code already says "expected as Travala credit, not to your wallet" — if reality differs, update the skill copy. |
| **Step-2 timeout idempotency** | **Stage 6 (cancel step-2)** | step-2 returns `{ok:true, state:"cancelled"}`. | step-2 **times out / no response** → our row → `cancel_failed` (backend `markCancelFailed`). Booking state UNKNOWN. | **DECIDED NOW: do NOT blindly re-submit step-2** (the OTP is single-use/expired — a re-submit fails or, worse, ambiguously double-acts). Instead: run **Stage 4 (manage)** to read the booking's live status. If manage shows **cancelled** → the timeout's cancel DID land; PATCH our row `status='cancelled'` manually. If manage shows **active** → run **Stage 5 → 6 again** (fresh OTP). |
| **Stale-session behavior** (earlier ruling: observe) | **Stage 2 (book)** | book proceeds normally with a fresh `sessionId`. | If `sessionId` expired between search and book → `quote_failed` (Travala rejects `travala_book`) **or** the X-PAYMENT pay leg is rejected (expired) → `paid:false`. | No money is lost either way (fail-closed). **Observation: if Cooper takes >a few minutes between search and book, note whether the session expires and which error appears.** Don't deliberately stale it. |
| **book-status freshness** (the old B-window assumption; the nonce fix made it non-load-bearing) | **Stage 3 (record)** + the forced-retry | `book-status` reports `completed` quickly after pay. | `book-status` lags (`in_progress`) for an extended window post-settle. | **Observe + record the timing** (how long until `completed`). It no longer gates correctness (the deterministic nonce is the on-chain guard), but the data informs the `--retry` poll tuning. |
| **Nonce on-chain idempotency** | **Mid-run forced --retry** (after Stage 2 pays) | `{ok:true, already_booked:true, …}` — "This booking already went through — not charging again." NO second charge. | Any second on-chain transfer / a second `tx_hash` / a second debit on Basescan. | **Proof is the quoted no-op output below** + the unit-tested determinism (`nonceForRequest` same `request_id`→same nonce) + USDC `authorizationState` (a 2nd submit of a used nonce reverts). |

---

## STAGE 0 — Scoped deploy (NO money; reversible)

Push the lane's VM-side files to **vm-1043 only** (not the fleet; manifest stays v128).
Includes the **updated `frontier-spend-core.mjs`** (the deterministic-nonce fix — vm-1043's
copy is the old random-nonce version and MUST be replaced before any pay).

```bash
cd /Users/cooperwrenn/wild-west-bots-travala/instaclaw
ssh $SSH_OPTS openclaw@45.33.95.220 'mkdir -p ~/.openclaw/skills/travala/scripts'
scp $SSH_OPTS skills/travala/SKILL.md            openclaw@45.33.95.220:~/.openclaw/skills/travala/SKILL.md
scp $SSH_OPTS skills/travala/scripts/travala-search.mjs skills/travala/scripts/travala-book.mjs \
              skills/travala/scripts/travala-cancel.mjs  skills/travala/scripts/travala-manage.mjs \
              openclaw@45.33.95.220:~/.openclaw/skills/travala/scripts/
scp $SSH_OPTS skills/frontier/scripts/frontier-spend-core.mjs \
              openclaw@45.33.95.220:~/.openclaw/skills/frontier/scripts/frontier-spend-core.mjs
ssh $SSH_OPTS openclaw@45.33.95.220 'chmod +x ~/.openclaw/skills/travala/scripts/*.mjs'
```

**Verify (must pass before Stage 1):**
```bash
ssh $SSH_OPTS openclaw@45.33.95.220 '
  echo "core has the nonce fix:"; grep -c "export function nonceForRequest" ~/.openclaw/skills/frontier/scripts/frontier-spend-core.mjs
  echo "travala scripts present:"; ls ~/.openclaw/skills/travala/scripts/
  echo "core parses:"; node --check ~/.openclaw/skills/frontier/scripts/frontier-spend-core.mjs && echo ok
  echo "book parses:"; node --check ~/.openclaw/skills/travala/scripts/travala-book.mjs && echo ok'
```
**Expected:** `core has the nonce fix: 1` · 4 scripts listed (`travala-book.mjs travala-cancel.mjs travala-manage.mjs travala-search.mjs`) · two `ok`.

**Abort here:** files exist but are dormant (gates still OFF → no booking possible).
**Blast radius:** vm-1043 now runs the *new* `frontier-spend-core.mjs` for ALL its frontier
spends — this is a strict improvement (deterministic idempotent nonce, backward-compatible),
so it is safe to leave. **Cleanup (optional):** `rm -rf ~/.openclaw/skills/travala` (the core
stays). No DB state touched.
**Seams observed:** none.

---

## STAGE 1 — Arm (NO money yet; flips the two gates ON)

A flag-only update — it does NOT trip the F4 lifecycle trigger (that fires on
`assigned_to`/`status` change, not pure-column writes).

```bash
curl -s -X PATCH "$SB/instaclaw_vms?id=eq.0f64ac86-69d2-45f4-ac2d-a488714c4d0d" \
  -H "apikey: $SRK" -H "Authorization: Bearer $SRK" -H "Content-Type: application/json" -H "Prefer: return=representation" \
  -d '{"frontier_spend_enabled": true}' | python3 -m json.tool
```
**Expected:** the row echoed back with `"frontier_spend_enabled": true`. (The travala
toggle is retired — one flag arms the canary; the per-booking tap stays the consent.)

**Abort here:** disarm (below) — instantly removes the booking capability.
**Blast radius:** vm-1043 can now book + spend until disarmed. No money moved yet.
**Cleanup / DISARM (also the abort lever for every later pre-pay stage):**
```bash
curl -s -X PATCH "$SB/instaclaw_vms?id=eq.0f64ac86-69d2-45f4-ac2d-a488714c4d0d" \
  -H "apikey: $SRK" -H "Authorization: Bearer $SRK" -H "Content-Type: application/json" \
  -d '{"frontier_spend_enabled": false}'
```
**Seams observed:** none.

> **GLOBAL EMERGENCY ABORT (any stage, instant, fleet-wide, no deploy):** engage the kill switch.
> ```sql
> INSERT INTO instaclaw_admin_settings (setting_key, bool_value, notes)
> VALUES ('travala_booking_kill_switch', true, 'canary abort')
> ON CONFLICT (setting_key) DO UPDATE SET bool_value=true, updated_at=now(), notes=EXCLUDED.notes;
> ```
> Stops every `book-quote` immediately (fail-closed). Note: cancel BYPASSES this (cancel is the
> protection) — so engaging the kill does NOT block you from cancelling an already-paid booking.
>
> **MID-FLIGHT ABORT (strongest lever DURING the pay window — the revoke interdiction,
> cf3dd963):** terminalize the pending hold so the spend can never settle on our ledger:
> ```sql
> UPDATE instaclaw_vms SET frontier_spend_enabled=false
>   WHERE id='0f64ac86-69d2-45f4-ac2d-a488714c4d0d';
> UPDATE frontier_transactions SET status='revoked'
>   WHERE vm_id='0f64ac86-69d2-45f4-ac2d-a488714c4d0d' AND direction='spend' AND status='pending';
> ```
> (Exactly what the one-tap revoke route does: future-gate flip + `runInterdiction` on
> `status='pending'` holds.) Caveat: an X-PAYMENT already submitted on-chain cannot be recalled —
> if the pay lands anyway, settle returns 409 `hold is now revoked` and the script narrates the
> collision ("your revoke arrived after payment was already in flight — I can cancel it for you").
> A subsequent `--retry` of that request_id gets an honest `request_id_consumed` deny, no re-charge.

---

## STAGE 2 — Book (the FIRST real charge; the irreversible boundary)

Run the scripts on vm-1043 over SSH for a controlled, deterministic run (the same scripts the
agent invokes). Cooper taps the approval within the in-turn window.

**2a. Search (free, no money):**
```bash
ssh $SSH_OPTS openclaw@45.33.95.220 'node ~/.openclaw/skills/travala/scripts/travala-search.mjs --type hotel \
  --args "{\"location\":\"Lisbon\",\"checkIn\":\"<+14d>\",\"checkOut\":\"<+16d>\",\"rooms\":[\"2\"]}" --json'
```
**Expected (PROVEN — search-hotel returned real inventory live):** `{"ok":true,"result":{…}}` whose
result carries a `sessionId` and `hotels[]`, each hotel with a `packageId` and a `cancellation`
object: `free_cancellation_until_utc`, `is_cancellable_now`, `time_remaining_seconds`.
**Pick a REFUNDABLE option: `is_cancellable_now:true` and `free_cancellation_until_utc` in the
future.** Record its `packageId`, the `sessionId`, the policy string, the deadline, and the price —
these become `--snapshot`.

**2b. Book (kicks approval, then pays, then records):**
```bash
ssh $SSH_OPTS openclaw@45.33.95.220 'node ~/.openclaw/skills/travala/scripts/travala-book.mjs \
  --package-id <packageId> --session-id <sessionId> \
  --customer "{\"firstName\":\"Cooper\",\"lastName\":\"Wrenn\",\"email\":\"<COOPER_REAL_EMAIL>\",\"phone\":\"+1...\"}" \
  --max-usd 80 --why "Lisbon canary" \
  --snapshot "{\"hotelName\":\"…\",\"checkIn\":\"<+14d>\",\"checkOut\":\"<+16d>\",\"room\":\"…\",\"displayPrice\":<price>,\"currency\":\"USD\",\"cancellationPolicy\":\"<policy>\",\"freeCancellationUntilUtc\":\"<deadline>\",\"refundable\":true}" \
  --json'
```
**First response (PROVEN shape — travala is session-required, F2; quoted from travala-book.mjs):**
`{"ok":true,"paid":false,"awaiting_approval":true,"approval_url":"https://instaclaw.io/…","request_id":"<id>","amount_usd":<X>,` and narration:
> `One tap to confirm — approve this $<X> booking from your dashboard:\n<approval_url>\nThen tell me to continue and I'll book it. (The link expires in 15 min; I'll send a fresh one if it does.)`

**→ Cooper taps `approval_url` in his logged-in dashboard.** Then re-run the SAME command with
`--request-id <id>` appended (resumes the same approval+spend; the deterministic nonce binds to
that `request_id`). (If Cooper taps within ~75s of the first run, that first invocation pays in
place — no re-run needed.)

**Paid + recorded response (quoted from travala-book.mjs):**
`{"ok":true,"paid":true,"recorded":true,"hold_id":"…","tx_hash":"0x…","amount_usd":<X>,"booking_ref":"<REF>",…}` and:
> `Booked. $<X> paid in USDC on Base (tx 0x…). Booking ref <REF>. Saved to your trips — ask me to cancel it anytime (refunds come back as Travala credit, not to your wallet).`

**Record `request_id`, `booking_ref` (<REF>), `tx_hash`, `hold_id`.** Verify the debit on Basescan
for `0xd998…38c4` (exactly ONE transfer of `<X>` USDC).

**If `recorded:false`** (paid but record failed): the response narrates the truth ("…I couldn't
save it to my cancellation list… keep your Travala confirmation… ask me to retry recording"). The
`book-record` route already fired a `[P1]` admin alert, and the hourly reconciler cron will too.
**Action:** run Stage 3's `--retry` to re-record before cancelling.

**Abort here — TWO cases (this is THE money boundary):**
- **Before the pay response (approval not yet tapped / `awaiting_approval`):** no money spent. The
  `/authorize` created a **pending hold** in `frontier_transactions`. **Blast radius:** one
  reserved-but-unspent budget hold. **Cleanup:** it auto-frees at the budget-reserve TTL; to free
  now, leave it (harmless) or settle it `failed`. Disarm (Stage 1) to prevent further bookings.
- **After `paid:true`:** **money is committed — a real reservation exists.** **Blast radius:** a
  paid hotel booking on Cooper's email. **Cleanup:** to recover the value, CANCEL it (Stages 5–6 →
  Travala credit). It is a real, valid reservation until cancelled. If `recorded:false`, the
  reconciler cron + `--retry` recover the row so it's cancellable.
**Seams observed:** stale-session (2a→2b gap), the irreversibility boundary.

---

## MID-RUN — Nonce verification (forced --retry; proves no double-charge on a REAL charge)

Immediately after `paid:true`, deliberately force a retry of the SAME payment:
```bash
ssh $SSH_OPTS openclaw@45.33.95.220 'node ~/.openclaw/skills/travala/scripts/travala-book.mjs \
  --retry --request-id <id> --package-id <packageId> --session-id <sessionId> \
  --customer "{…same…}" --max-usd 80 --json'
```
**Expected (quoted from travala-book.mjs `--retry` block):**
`{"ok":true,"already_booked":true,"recorded":true,"booking_ref":"<REF>",…}` and:
> `This booking already went through — not charging again. Ref <REF>. It's saved to your trips — ask me to cancel anytime.`

**Proof:** NO second `tx_hash`, NO second Basescan debit. The `--retry` polled `book-status` to
`confirmed` and short-circuited (the book-status terminal-poll). The deterministic nonce is the
on-chain backstop beneath it: the same `request_id` re-derives the identical nonce, and USDC's
`authorizationState` would revert a second submit even if the poll were bypassed (unit-proven
determinism + contract semantics).
**(If `book-status` still reads `in_progress`** the retry returns `{ok:false,paid:false,pending:true,…}`
— "…still processing… I have NOT re-charged you." — also a no-op. Record the freshness timing.)
**Abort:** n/a (read-only / no-op by construction). **Seams observed:** nonce idempotency, book-status freshness.

---

## STAGE 3 — Record (verify the booking is in our table — required before cancel)

`book-record` ran inside Stage 2 already. Confirm the row exists (cancel's gate-2 ownership needs it):
```bash
curl -s "$SB/instaclaw_travala_bookings?booking_id=eq.<REF>&select=booking_id,vm_id,status,last_name,email,free_cancellation_until_utc,amount_usd_paid,hold_id" \
  -H "apikey: $SRK" -H "Authorization: Bearer $SRK" | python3 -m json.tool
```
**Expected:** one row, `status:"confirmed"`, `vm_id:"0f64ac86-…"`, `last_name/email` = the customer,
`free_cancellation_until_utc` populated (the snapshot), `hold_id` = the frontier hold.
**If absent:** Stage 2 didn't record — run the `--retry` (Stage 3a) which re-checks book-status and
re-records; the reconciler cron also alerts. Do NOT proceed to cancel without a row (gate-2 would
reject `not_your_booking`).
**Abort:** n/a (read). **Blast radius:** n/a. **Seams observed:** book-status freshness (the
`ref_source` in `meta` shows whether the bookingId came from book_status or the regex fallback).

---

## STAGE 4 — Manage (Q1b RESOLVES HERE; read-only)

The first machine-client call against the real booking. **This is the showstopper test.**
```bash
ssh $SSH_OPTS openclaw@45.33.95.220 'node ~/.openclaw/skills/travala/scripts/travala-manage.mjs --booking-id <REF> --json'
```
**SUCCESS (Q1b PASS) — quoted from travala-manage.mjs:** `{"ok":true,"state":"ok","step":1,"booking_id":"<REF>",…}` and:
> `To pull up that booking's details, Travala emailed a 6-digit code to the booking email. Read it back to me and I'll show you the status, dates, price, and cancellation policy.`

**FAILURE (Q1b FAIL):** `{"ok":false,"state":"upstream_error",…,"message":"…Unauthorized… / not signed in…"}`.
→ **STOP the cancel half** (see the seams ledger Q1b row). Disarm; the booking remains
cancellable by Cooper on travala.com; escalate to Travala for an m2m path.

**On PASS — Cooper reads the 6-digit code from his email, then:**
```bash
ssh $SSH_OPTS openclaw@45.33.95.220 'node ~/.openclaw/skills/travala/scripts/travala-manage.mjs --booking-id <REF> --otp <CODE> --json'
```
**Expected:** `{"ok":true,"state":"ok","step":2,"details":"…","booking_id":"<REF>"}` — the live booking
details + cancellation policy. (Exact body shape is **canary-observed** — record it; it informs
how we surface policy to users.)
**Abort:** n/a (read-only; the only side effect is an OTP email Cooper ignores).
**Blast radius:** nil. **Seams observed:** **Q1b (resolves here)**, the real manage step-2 body shape.

---

## STAGE 5 — Cancel step-1 (sends the cancellation OTP)

```bash
ssh $SSH_OPTS openclaw@45.33.95.220 'node ~/.openclaw/skills/travala/scripts/travala-cancel.mjs --booking-id <REF> --json'
```
**Expected (quoted from travala-cancel.mjs):** `{"ok":true,"state":"otp_sent","step":1,"booking_id":"<REF>","email":"<COOPER_EMAIL>",…}` and:
> `To cancel, Travala just emailed a 6-digit verification code to <email>. Read it back to me and I'll finish the cancellation. (Heads up: any refund comes back as Travala credit, not to your wallet.)`

Our row is now `status:"cancel_requested"` (`cancel_requested_at` set).
**Abort here:** the booking is **still active** (cancel only completes at step-2). **Blast radius:**
the row says `cancel_requested` but the reservation is valid — to keep the booking, simply do not
run step-2. To cancel, continue. No money state changed. **Cleanup:** none required.
**Seams observed:** the real step-1 OTP-sent body (vs the Gate-0 fake-id "failed to send OTP").

---

## STAGE 6 — Cancel step-2 (completes the cancellation)

Cooper reads the cancellation code from his email, then:
```bash
ssh $SSH_OPTS openclaw@45.33.95.220 'node ~/.openclaw/skills/travala/scripts/travala-cancel.mjs --booking-id <REF> --otp <CODE> --json'
```
**Expected (quoted from travala-cancel.mjs):** `{"ok":true,"state":"cancelled","step":2,"booking_id":"<REF>","refund_amount":<R>,"cancellation_fee":<F>,"refund_destination":"travala_credit",…}` and:
> `Done — your booking is cancelled. A refund of $<R> [(after a $<F> cancellation fee)] is expected as Travala travel credit on your account, typically within ~7 business days — not to your wallet.`

Our row is now `status:"cancelled"` (`cancelled_at`, `refund_amount`, `cancellation_fee`,
`refund_destination='travala_credit'`, `cancel_raw`). Since we booked a free-cancellation option
within its window, expect `refund_amount` ≈ the paid amount and `cancellation_fee` ≈ 0 (**observe
the actual `refund_amount`/`fee` — `parseCancelOutcome`'s regex is canary-validated here**).

**Step-2 TIMEOUT (decided on paper — do not improvise):** if this call times out / returns
`{ok:false,state:"upstream_error"|"not_found"}`, the row is `cancel_failed` and the booking state is
UNKNOWN. **Run Stage 4 (manage) to read the live status.** If manage shows cancelled → PATCH the row
`status='cancelled'` manually:
```bash
curl -s -X PATCH "$SB/instaclaw_travala_bookings?booking_id=eq.<REF>" -H "apikey: $SRK" -H "Authorization: Bearer $SRK" -H "Content-Type: application/json" -d '{"status":"cancelled","cancelled_at":"<nowISO>"}'
```
If manage shows still-active → run Stage 5 → 6 again (fresh OTP). **Never blindly re-submit step-2
with the old OTP** (single-use/expired).
**Abort:** n/a (this IS the terminal action). **Blast radius:** the booking is cancelled; the refund
is in motion. **Seams observed:** step-2 idempotency (on timeout), the real cancelled+refund body, the refund amount.

---

## STAGE 7 — Refund-watch (where does the value actually land?)

**Action:** Cooper signs in to travala.com with the booking email and checks his **account /
travel-credit balance** over the next ~7 business days. Do **not** watch the wallet — the on-chain
USDC spend is permanent; the refund is Travala credit.
**Expected (ASSUMED — this is the m2m-refund-destination seam):** a Travala travel credit of ≈ the
paid amount appears on the account within ~7 business days.
**Observe + RECORD:** the credit amount, where it landed, and the elapsed time. **If it lands
anywhere other than Travala credit, that's a finding** — update the skill copy + tell Cooper.
**Abort:** n/a (observational). **Blast radius:** nil. **Seams observed:** **m2m refund destination (resolves here).**

---

## POST-RUN — disarm + record

1. **Disarm** vm-1043 (Stage 1 DISARM) unless Cooper wants it left on.
2. **Record the findings** against the seams ledger: Q1b PASS/FAIL + the exact body, the refund
   destination + amount + timing, the step-2 path taken, the book-status freshness timing, the
   nonce no-op confirmation, any stale-session observation.
3. If Q1b PASSED and the refund landed as credit → the lane is **proven**; proceed to the
   manifest-bump + interactive-card flip (Phase 4, a separate explicit GO) and the fleet rollout.
4. The `travala_bookings` composite-unique migration (`pending_migrations/20260611170000…`) still
   awaits Cooper's batched Studio apply — independent of the canary.

---

## RUNBOOK SELF-AUDIT (against deployed code @ `3c6bdaf6`)

- File paths verified against the repo: `skills/travala/{SKILL.md,scripts/{travala-search,travala-book,travala-cancel,travala-manage}.mjs}`, `skills/frontier/scripts/frontier-spend-core.mjs`. ✓
- `CORE_PATH` in travala-book.mjs = `~/.openclaw/skills/frontier/scripts/frontier-spend-core.mjs` — the Stage-0 dest matches. ✓
- `INSTACLAW_API_BASE` default = `https://instaclaw.io` (the live backend with the new ops). ✓
- Quoted narrations are verbatim from the committed scripts (awaiting_approval, paid+recorded,
  --retry already_booked/pending, cancel otp_sent/cancelled, manage step-1/step-2). Backend JSON
  (`gated/not_your_booking`, `state:otp_sent/cancelled`, `refund_destination:travala_credit`) is
  from the committed route. ✓
- Proven-live outputs (search ok, gated, 400, no-auth 401) are real probe results; **canary-only
  shapes are explicitly marked "observe"** (manage step-2 body, cancel cancelled+refund body, the
  OTP-sent real body, the refund landing). ✓
- Kill-switch SQL matches `lib/travala-kill-switch.ts` (`instaclaw_admin_settings.setting_key`,
  `bool_value`, ON CONFLICT). ✓
- Arm is a flag-only PATCH (does not trip the F4 lifecycle trigger). ✓
</content>
