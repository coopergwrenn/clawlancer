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

## 2026-06-12 PM — THE TRAVEL DECOUPLE: booking freed from frontier_spend_enabled (SHIPPED)

Cooper ruled + GO'd same day: **hotel booking is not autonomous spending** — the
user taps approve on the exact room and price before a dollar moves, so the
autonomous-spend mandate (`frontier_spend_enabled`, the §8.7 opt-in) added zero
protection to travel and only blocked funded users. Proven first (full gate
trace + airtight tap proof), then shipped:

- `spendMandateSatisfied(vm, category)` (lib/frontier-spend-optin.ts) — the gate
  exemption, keyed on the SAME `SESSION_REQUIRED_CATEGORIES` SoT that drives the
  unforgeable-tap requirement, so exemption and guarantee cannot drift apart.
- `blocksUnmandatedReserve` (lib/frontier-authz.ts) — belt-and-braces: without
  the standing mandate, only mode AND reason both saying human-approved-session
  may reserve (field agreement = second independent guard). Graceful: re-mints
  the tap instead of erroring.
- Load-bearing invariant documented at the SoT (frontier-policy.ts): every
  session-required category MUST have a $0-just-do-it band layer. Guarded by
  `scripts/_test-frontier-session-decouple.ts` — 133 assertions: the invariant
  under adversarial overrides, the full behavior matrix (incl. ceiling/privacy/
  drain-with-tap, daily ceiling, category-override exclusion), the lying-agent
  discrimination test C1–C11, the belt-and-braces futures D1–D6.
- **Fresh-eyes find (decouple consequence, fixed in the same change):**
  revoke-spend's already-off early return skipped interdiction — post-decouple a
  never-opted-in VM CAN hold a live tapped travel hold, so the panic link would
  have falsely said "no action was needed." Now ALWAYS interdicts, honest copy.
- Agent brain: SKILL.md down to TWO requirements (funded wallet + the tap) with
  an explicit "never send a user to Spending settings to book a hotel";
  booking-flow.md gate list rewritten (3 real gates + history note);
  spend_not_enabled narration honest-generic (unreachable post-decouple), the
  every-deny-says-nothing-was-charged invariant kept (the nonce suite enforces it).
- Dashboard card API: prereqsMet = wallet only; the stale "Pro/Power + autonomous
  spend" message corrected. spend-settings docblock updated for accuracy.
- Hold metadata `mandate: "standing_optin" | "session_only"` — Rule-27
  observability for the decoupled population in frontier_transactions.metadata.
- Canary runbook Stage 1 RETIRED for the booking leg, with the **abort-lever
  change documented loudly**: flag-disarm no longer stops travel; the levers are
  the kill switch, the per-VM category override (Gate-1 hard deny), and
  revoke-link interdiction (which now works on the already-off path).
- Proven unchanged: every other category still requires the opt-in
  (per-category asserted: exemption ⟺ session-required); hard denies bind even
  with a tap; empty wallet → the funding ask before any tap is requested.
- Ceremony: tsc clean + 7 suites / 376 assertions green (direct exit codes).

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
