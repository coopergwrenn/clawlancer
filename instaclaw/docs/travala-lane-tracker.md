# Travala lane — ship-after tracker

Source: the 2026-06-11 full-lane audit (3-pass: freshness / robustness / excellence),
ruled by Cooper 2026-06-11. Items 1–3 (GAP-1 deny narrations + settle-response read,
GAP-2 already_cancelled state fix, runbook prose) SHIPPED same night. These are the
held follow-ups — Rule 72: update status here in the same work that ships each.

## PRIORITY — #6 free-cancellation deadline reminders
**The standout product differentiator.** `instaclaw_travala_bookings.free_cancellation_until_utc`
is already persisted per booking (captured from the search snapshot at record time).
An agent that proactively tells its user "your free-cancellation window on the Lisbon
hotel ends tomorrow — want to keep it or cancel?" is a feature no OTA chatbot does
well, and we get it nearly free: a cron (or agent-heartbeat hook) scanning
`status='confirmed' AND free_cancellation_until_utc BETWEEN now() AND now()+interval '36h'`,
deduped per booking, delivering through the agent's normal channel. Design note: the
message must come FROM the agent in-voice (not a platform email) — that's the
differentiator. Status: HELD.

## #4 — booking→spend inverse reconciliation
The cron cross-refs spend→booking only (`.in("status",["success","disputed"])`,
reconcile-travala-bookings/route.ts:44). Two blind spots: (a) a paid booking whose
script died between pay-response and settle leaves an expired hold the cron never
scans — detectable from the booking side (`booking rows whose hold_id is not in a
money-moved terminal state`); (b) the revoked-but-paid collision — precise signal is
`frontier_spend_events.reason='settle_on_revoked_hold'` (carries tx_hash), join hold
→ travala tag → cross-ref booking row. Add both as a second pass in the same cron.
Status: HELD.

## #5 — Travala OAuth token cache
`mintTravalaToken` mints per call; tokens live 3600s. First thing to break at 10x is
the token endpoint (rate-limit risk + latency tax on every op). Module-level cache
keyed by scope with expiry guard (mirror `_tokenEndpointCache`), minting only on
miss/near-expiry. Touches the money path → full ceremony + tests when shipped.
Status: HELD.

## #7 — structured logs on cancel/manage upstream errors
`upstream_error`/`invalid_input` outcomes return to the VM but write no server-side
structured line. One `console.error` with `{op, vm_id, booking_id, state, message:
text.slice(0,300)}` per non-ok manage/cancel outcome = the 2am fields. Status: HELD.

## #8 — `--snapshot` parse-fail warning
travala-book.mjs silently degrades a bad `--snapshot` JSON to undefined (catch →
undefined) — the booking records without policy/deadline and nobody is told. Emit a
`snapshot_ignored: true` field + one narration clause so the agent knows the deadline
wasn't saved. Status: HELD.

## #9 — surface Travala's cancellation reference
`cancel_raw` stores the full step-2 response. Once the canary shows the real
cancelled-body shape, extract any cancellation/confirmation reference and add it to
the cancelled narration ("cancellation ref X — keep it"). OTA-standard receipt
behavior. Status: HELD (shape is canary-observed first).

## #10 — per-VM quote rate cap (auto-on hardening)
With the door open (Q2) any VM can fire book-quotes; volume abuse risks Travala
rate-limiting our shared OAuth client fleet-wide. Cheap cap: per-VM counter on
book-quote (N/hour) returning a calm 429. Found by the 2026-06-12 philosophy
stress-test; was claimed "noted in the tracker" but never added — caught by the
bird's-eye audit (a silently-dropped item, now restored). Status: HELD.

## Documented-only (ruled not-worth-building, 2026-06-11)
- booking_id-squat griefing (needs the victim's live packageId+sessionId; Travala's
  OTP-to-booking-email backstop holds; degrade-to-ref-less already contains it).
- double-failure pay edge (paid + Travala lost the booking + retry reverts on the
  consumed nonce) — monitor via `frontier_spend_events`; no code.
- whoami/logout exposure — skipped with stated reasons in the Part-1 inventory.

## 2026-06-12 PM — Trips discovery reversal: BUILT + APPROVED, push HELD, COUPLED to the fleet flip

Cooper ruled (2026-06-12 PM): the Trips sidebar item shows for EVERYONE (presence
gate removed) and the /trips zero-bookings state is a first-run discovery surface
(hero + tappable example prompts that seed the composer + 4-step trust loop +
demoted ghost receipt). Design APPROVED as-is; copy locked.

**The change is committed LOCALLY ONLY** — worktree `wild-west-bots-travala`,
branch `feat/travala-x402-booking`, commit `3c19f5d7` (pure code: sidebar-shell,
trips-presence-link, trips/page, trips-first-run component, trips API comment,
dev harness `/trips-first-run-preview`). It is DELIBERATELY NOT PUSHED.

**COUPLING RULE (Cooper ruling, 2026-06-12 PM): `3c19f5d7` rides the Rule-64
fleet-flip deploy — the manifest bump that ships the travel skill fleet-wide.
The Trips link and the agent-side capability go live together or not at all.**
Pushing it earlier creates the exact dead-promise the un-gate exists to avoid:
a visible Trips link whose prompts reach an agent that doesn't have the skill
yet (skill files are inert until the bump; `frontier_spend_enabled` is per-VM
opt-in). Do NOT push this commit outside that deploy window.

Fleet-flip deploy-day checklist (same window as the manifest bump):
1. Rebase `3c19f5d7` onto current main (no tracker conflict — this entry lives
   on main, the held commit is code-only). Rule-84 tsc gate, then push.
2. **Prod-verify, mandatory before announce:** mint a zero-booking session →
   the Trips sidebar item is visible; /trips renders the first-run surface
   live (hero, chips, trust loop, ghost) on the real theme; 390px holds.
   Capture the proof (screenshots), not just local renders.
3. Update this entry to SHIPPED with the final SHA (Rule 72).
