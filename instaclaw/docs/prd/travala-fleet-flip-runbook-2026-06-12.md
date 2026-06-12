# Travel fleet flip — THE authoritative runbook (2026-06-12)

The single source of truth for taking travel FULLY live: the Trips link visible
for everyone, the skill on every VM, booking working end-to-end for any user
with a funded wallet. Every claim in §0 was PROVEN against prod/code on
2026-06-12 (the proof method is named per row — re-prove, don't trust, if days
have passed). Rule 72: update this doc in the same work that executes each step.

Companion docs: `docs/travala-canary-runbook.md` (the per-stage canary
procedure), `docs/travala-lane-tracker.md` (held follow-ups + the coupling
records), `docs/prd/travala-x402-booking-2026-06-10.md` (the lane PRD).

---

## §0 — PROVEN CURRENT STATE (as of 2026-06-12, ~19:30 UTC)

| # | Thing | State | Proof method |
|---|---|---|---|
| 1 | **The decouple** (booking freed from `frontier_spend_enabled`) | **LIVE on prod.** `081f8955` is an ancestor of origin/main; production deploy Ready built `a852afd` which descends from it; authorize route probed alive (401 unauth). | `git merge-base --is-ancestor` + `vercel inspect --logs` (Cloning … Commit: a852afd) + curl |
| 2 | **Trips un-gate + first-run surface** | **HELD, unpushed.** Local commit `84cfbf86` (travala worktree, branch `feat/travala-x402-booking`, parent `081f8955`); `git branch -r --contains 84cfbf86` → 0 remote refs. Prod sidebar still presence-gated (hidden at 0 bookings); /trips + its API are live but reachable only by direct URL. | git ref containment + prior prod walkthrough |
| 3 | **Travel skill on the fleet** | **NOT fleet-wide — but NOT zero (see Finding F1).** Full-fleet SSH census of all 151 healthy+assigned VMs for `~/.openclaw/skills/travala/scripts/travala-book.mjs`: **144 NO · 4 YES · 3 SSH-unreachable.** Manifest `version: 128` (unbumped); travala in `extraSkillFiles` (vm-manifest.ts:2840-2846) + SKILL.md via `skillsFromRepo: true`. | parallel SSH census (`/tmp/census-results.txt` shape; re-runnable) |
| 4 | **The canary** (vm-1043 live booking) | **NOT RUN.** Stages 2–7 of the canary runbook (first real charge → record → manage/Q1b → cancel ×2 → refund-watch) have never executed. The refund leg and the Q1b machine-client email-match are UNOBSERVED. **The canary gate is OPEN.** | canary runbook stage ledger; no booking rows exist (instaclaw_travala_bookings table count = 0, proven during the Trips work) |
| 5 | DB dependencies | **ALL APPLIED.** `instaclaw_frontier_spend_approvals` → 200; `frontier_spend_events` → 200; `frontier_reserve_spend` RPC → functional (probed with real signature + impossible VM → `{reserved:false, reason:"invalid_counterparty"}`, HTTP 200 — note: Rule 56's build gate does NOT cover functions, so this live probe, not file location, is the proof); travala bookings tables + composite-unique applied earlier. Nothing travel/frontier left in `pending_migrations/`. | PostgREST probes + dir listing |
| 6 | Env | `TRAVALA_OAUTH_CLIENT_ID` + `TRAVALA_OAUTH_CLIENT_SECRET` present in Vercel production. | `vercel env ls production` |
| 7 | Kill switches | Both CLEAR: `frontier_spend_kill_switch` row exists `bool_value:false`; `travala_booking_kill_switch` row ABSENT (= clear; engage creates it). | admin_settings query |
| 8 | The approval tap surface | `/economy/approve` page exists (dashboard, session-authed); approve API owner-scoped. | file presence + prior code read |
| 9 | Fleet size | **151** healthy+assigned VMs. | PostgREST count |

### ⚠ FINDING F1 — four VMs can already book, pre-canary (the early-skill leak)

`stepSkills` (lib/vm-reconcile.ts:5820) deploys **every** `skills/<dir>/SKILL.md`
in the bundle plus every on-disk `extraSkillFiles` entry, with no per-skill gate
— the only gates are (a) the cv filter (`cv < 128`, so caught-up VMs are
excluded) and (b) the same extraction at provision/configure time. Because
`skills/travala/` has been on main since the lane's earlier pushes, any VM that
was configured fresh or re-reconciled from `cv<128` after that point received
the skill. The census found exactly that cohort:

- **`instaclaw-vm-1107`, `vm-777`, `vm-950`, `vm-956` have `travala-book.mjs` TODAY** —
  and at least vm-1107 has book+search WITHOUT cancel/manage (the
  "announce-verb-false" hazard: can book, can't cancel from chat).
- `vm-626`, `vm-771`, `vm-917` were SSH-unreachable during the census (unknown
  state; vm-771/vm-917 are edge_city — re-probe before the flip).
- With the decouple live, those users' only path to money is still the funded
  wallet + their own session tap (consent is intact) — but they'd be booking
  through the UNPROVEN legs (Q1b email-match, refund shape) on a skill version
  missing cancel.

**RECOMMENDED IMMEDIATE TOURNIQUET (Step 0 below): engage
`travala_booking_kill_switch`.** It blocks `book-quote` (the only path to a
payable 402) fleet-wide, instantly, server-side, reversibly — zero impact on
anything announced (the feature is dark), search stays free, cancel/manage stay
up (they're deliberately not kill-gated: cancel IS the user's protection).

---

## §1 — STEP 0 (NOW, pre-canary): close the F1 window

**Action** (Supabase Studio or service-role SQL):
```sql
INSERT INTO instaclaw_admin_settings (setting_key, bool_value, notes)
VALUES ('travala_booking_kill_switch', true, 'fleet-flip runbook step 0: hold booking dark until the canary passes — F1 early-skill cohort (vm-1107/777/950/956)')
ON CONFLICT (setting_key) DO UPDATE SET bool_value = true, updated_at = now(), notes = EXCLUDED.notes;
```
**Expected:** every `book-quote` returns `{ok:false, gated:true, reason:"travala_booking_kill_switch"}`;
the agent narration says booking is paused by the operator. Search/cancel/manage unaffected.
**Proof:** curl book-quote via any gateway token → gated; spot-message one F1 VM's agent.
**Abort/undo:** `UPDATE instaclaw_admin_settings SET bool_value=false, updated_at=now() WHERE setting_key='travala_booking_kill_switch';`
**Release condition:** §4 step 4 (the flip window), or temporarily during the §2 canary window.

### ✅ STEP 0 EXECUTED — 2026-06-12 23:11:28 UTC

- **F1 re-proven immediately before engaging** (fresh census regenerated from the
  live VM list): 151 VMs → 144 NO · **4 YES (vm-1107, vm-777, vm-950, vm-956 —
  identical cohort)** · 3 ERR (vm-626, vm-771, vm-917, same three).
- **No-in-flight proof on the cohort:** 0 pending holds, **0 holds EVER**
  (frontier_transactions), 0 approvals (any status), 0 rows in
  instaclaw_travala_bookings table-wide. Nothing stranded by the block.
- **Tourniquet ruling — GLOBAL switch over per-VM category overrides**, because:
  (a) the F1 cohort GROWS — every freshly-configured VM extracts the skill
  (stepSkills is ungated per-skill), so a surgical override would need to chase
  new VMs forever (guaranteed drift; the Rule-14-class partial-fix trap);
  (b) the per-VM override writes platform-operator state into the USER's policy
  surface (ownership pollution + a lift that must merge around genuine user
  prefs); (c) the 147 NO-VMs need no protection — "surgical" protects nothing
  the global switch doesn't; (d) the switch is purpose-built (fail-closed,
  zero user-surface footprint, one-row lift).
- **Engaged** via admin_settings upsert (notes name this runbook + the cohort).
- **Verified live:** book-quote (canary VM gateway token) →
  `{"ok":false,"gated":true,"reason":"travala_booking_kill_switch"}`;
  search-hotel NOT gated (reached Travala's MCP); cancel/manage ungated by
  design (code-verified; no live probe possible at 0 bookings).
- **THE LIFT (for the §2 canary window, and §4 step 4):**
  ```sql
  UPDATE instaclaw_admin_settings SET bool_value=false, updated_at=now(),
    notes='canary window lift (re-engage on any stage failure)'
  WHERE setting_key='travala_booking_kill_switch';
  ```
  Re-engage = the §1 upsert above. During a canary lift the F1 cohort is
  bookable — keep the window short and operator-attended; optionally re-census
  first so the watched set is current.

---

## §2 — GATE A: the canary (MUST pass before any flip)

Owner: Cooper GO + operator. Procedure: `docs/travala-canary-runbook.md`
(Stage 1 is retired — no flag arming; the wallet + the tap are the arming).

**Kill-switch interplay:** the canary needs book-quote OPEN. The window is:
lift the switch (the §1 undo) → run the stages with the operator watching →
**re-engage immediately** if any stage fails or the session ends without the
flip. The F1 cohort is technically bookable during this window — acceptable
because the window is short and operator-attended.

**The canary gate is MET only when ALL of these are observed (not inferred):**
1. Stage 2: a real charge lands; booking confirmed with a Travala ref; tx hash on Base.
2. Stage 3: our `instaclaw_travala_bookings` row records it (book-record).
3. Stage 4: **Q1b resolves** — the machine client passes Travala's email-match
   on a REAL booking (manage works for the booking email).
4. Stages 5–6: cancel step-1 (OTP) + step-2 complete; cancelled state lands in
   our row; the cancellation-reference shape captured (tracker #9 input).
5. Stage 7: **refund-watch** — where the value actually lands (expected: Travala
   travel credit, ~7 business days; observe and record the truth).
   Per Cooper's standing classification this leg is ship-and-harden — the GATE
   for the flip is stages 1–4 + the cancel mechanics; stage 7's full 7-day
   window may complete post-flip, but it must be ARMED (watch scheduled,
   booking email monitored) before announce.
6. Seams ledger updated in the canary runbook; `refundView`/narration stubs
   refined if the observed shapes allow (tracker #9).

**If any stage fails:** re-engage the kill switch (instant), diagnose per the
canary runbook's per-stage abort levers, do NOT proceed to §4. Rule 59:
investigate before deferring.

---

## §3 — GATE B: flip-day preflight (same day as §4, before the push)

1. `git fetch origin main` — re-prove §0 rows 1/2/3 still hold (the lane moves fast).
2. Re-probe the 3 SSH-unreachable VMs (vm-626/771/917) for the skill; add any
   YES to the F1 ledger (no action needed — the switch covers them).
3. Regression at flip-day HEAD (Rule 84 — direct exit codes):
   `tsc --noEmit` + the 7 suites (`_test-frontier-authz`, `-categories`,
   `-policy`, `-session-decouple`, `_test-travala-cancel`,
   `_test-x402-nonce-idempotency`, `_test-trip-card-logic`). All green or stop.
4. `vercel env ls production | grep TRAVALA` — creds still present.
5. Confirm no new pending_migrations entries block the build (Rule 56).
6. **Cooper's explicit Rule-64 approval for the manifest bump**, in-session,
   unambiguous ("ship it" / "push to fleet"). This runbook is the plan, not the
   approval.

---

## §4 — THE FLIP (one window, strict order — a coupled thing never ships before its dependency)

> The ordering principle: **server code first (already live), then the skill +
> the link together, then the gate opens.** The Trips link must never be
> visible while the skill is absent (dead promise), and booking must never be
> reachable before the canary proved it (the kill switch holds until last).

**Step 1 — rebase + gate the held Trips commit.**
```bash
cd /Users/cooperwrenn/wild-west-bots-travala
git fetch origin main && git rebase origin/main        # held commit rides to a new SHA — record it
cd instaclaw && npx tsc --noEmit > /tmp/tsc.out 2>&1; echo "exit=$?"   # must be 0
```
Expected: clean rebase (the commit is code-only by design — the coupling docs
live on main). Proof: tsc exit 0. Abort: nothing pushed yet.

**Step 2 — the manifest bump (ships the skill fleet-wide).**
- Edit `lib/vm-manifest.ts`: `version: 128` → `129`.
- Add the changelog entry in CLAUDE.md's Manifest Version Changelog (v129 —
  travel skill fleet-wide: travala SKILL.md + references via skillsFromRepo,
  4 scripts via extraSkillFiles; no config keys, no systemd changes, **no
  gateway restarts required** — a pure-content bump; the reconciler's other
  steps run idempotently).
- Commit on the same branch, ON TOP of the rebased Trips commit.

**Step 3 — ONE push, both commits (the coupling made atomic).**
```bash
git push origin HEAD:main
```
Expected: Vercel builds; deploy → Ready (~3 min). Proof:
`vercel inspect <deploy-url> --logs | grep Cloning` shows the pushed SHA (or a
descendant changelog commit); `git merge-base --is-ancestor <trips-sha> origin/main`.
**From this moment:** the Trips link renders for every dashboard user → the
first-run surface is the promise. The skill begins reaching VMs on the next
reconcile tick. Booking is STILL dark (kill switch).
Abort lever: `git revert` both commits + push (the link disappears again;
cv-129 VMs that already got files keep them — harmless inert files while the
switch is engaged).

**Step 4 — release the kill switch (booking goes live).**
Only after step 3's deploy is Ready AND the skill drain has begun:
```sql
UPDATE instaclaw_admin_settings SET bool_value=false, updated_at=now(),
  notes='fleet flip 2026-06-1X: canary passed, travel live'
WHERE setting_key='travala_booking_kill_switch';
```
Expected: book-quote serves 402 quotes again. Proof: one quote through the
canary VM. Re-engage = the same UPDATE with `true` (the instant rollback for
ANY booking-side failure from here on).

**Step 5 — watch the drain (skill → 151 VMs).**
reconcile-fleet picks up `cv<129` next tick; `CONFIG_AUDIT_BATCH_SIZE=3` at
3-min cadence → expect **~2–3h** to drain. Proof (the coverage gate, Rule 27):
re-run the §0 census script — expect 151/151 YES for `travala-book.mjs` AND
spot-check 5 VMs for **all four** scripts + SKILL.md containing
"exactly two" (the post-decouple requirements section — proves current content,
not a stale early copy). Any VM stuck >4h: standard reconcile triage
(cv-bump-blocked logs, Rule 40).

**Step 6 — the MANDATORY prod-verify gate (screenshots, not assumptions).**
1. Mint a zero-booking session (the trips walkthrough harness) → screenshot:
   the **Trips item in the live sidebar**; **/trips renders the first-run
   surface** (hero, chips, trust loop, ghost) on the real theme; **390px** holds.
2. **One real end-to-end booking** on a designated VM (vm-1043 or Cooper's):
   ask → quote → tap at /economy/approve → paid → booking ref → the receipt
   ROW appears on /trips (screenshot the live card). This is the only proof
   the whole chain (skill → decoupled authorize → tap → pay → record → Trips)
   composes in production for a normal user.
3. Empty-wallet UX spot-check on a $0 wallet VM: the funding-ask narration
   (exact amount + full address). No tap should be offered before funding.
If ANY of these fail → step 4's re-engage (booking dark again) while the link
stays up — the first-run surface stands on its own (search is free) — fix, then
re-release. The link-without-booking state is degraded but honest (search
works); if the failure is in the SURFACE instead, revert the Trips commit.

**Step 7 — post-flip hygiene.**
- Rule 7 snapshot prompt to Cooper (manifest bumped → base snapshot stale).
- Update this doc + the lane tracker: flip date, final SHAs, census result,
  prod-verify screenshot refs (Rule 72).
- vm-1043 cleanup per canary runbook Stage 0 (optional).
- Re-probe vm-626/771/917 (the census ERRs).

**Step 8 — announce (ONLY after step 6 passes).**
Launch copy goes through Rule 55 (`/launch` — both viral playbooks, receipts,
weapons check). Recommended pre-announce fast-follow from the tracker:
**#10 per-VM quote rate cap** (auto-on hardening — cheap, protects the shared
Travala OAuth client at announce-driven volume) and **#7 structured
cancel/manage error logs** (the 2am fields for launch week).

---

## §5 — ROLLBACK MATRIX (which lever for which failure)

| Failure | Lever | Scope | Command/where |
|---|---|---|---|
| Anything booking-side (bad quotes, pay failures, Travala-side trouble, refund surprise) | **`travala_booking_kill_switch`** | Fleet, instant, reversible; search/cancel/manage unaffected | §1 SQL (engage) |
| Spend-rail-wide emergency (any category) | `frontier_spend_kill_switch` | Fleet, denies EVERY spend | CLAUDE.md frontier IR §stop-the-bleeding |
| One user/VM must stop booking (others fine) | **per-VM category override excluding `travel`** | Single VM; Gate-1 hard deny no tap overrides | `/api/agent-economy/policy` / `instaclaw_frontier_policy_overrides` |
| A live tapped-but-unpaid hold must die | **revoke link / revoke-spend** — interdicts pending holds (works on never-opted-in VMs post-decouple) | Single VM's pending holds; settle CAS blocks the pay | the revoke surface |
| The Trips surface itself is broken | `git revert <trips-sha>` + push | Link disappears; booking unaffected | git |
| The skill content is broken on VMs | revert the offending file + manifest bump (or file-drift for files[] content; skills go via the next cv bump) | Fleet, ~2-3h drain | git + manifest |
| The decouple itself must come back out | `git revert 081f8955` + push (restores the opt-in gate for travel; the 12 opted-in VMs keep working) | Server-side, next deploy | git |
| Paid-but-Travala-lost / disputes | non-custodial: reconcile against chain + Travala support with our records | per-booking | frontier IR runbook S3 + booking rows |

**What no lever can do:** recall an X-PAYMENT already broadcast (EIP-3009 is
final). Everything pre-pay is reversible; that's why the kill switch sits at
book-quote (before any 402 exists) and the tap sits before any signature.

---

## §6 — Known companions / not-forgotten ledger

- **The Travel Agent skill card** (skills grid) is still the PRESENTATIONAL
  version with a fake off-switch — post-flip it under-sells a live feature.
  The interactive Phase-4 swap is a held design task; at minimum flip the copy
  at announce time. (Polish, not a blocker — the discovery surface is /trips.)
- The `?presence=1` API shape stays as an ops probe (no UI consumer post-flip).
- `travala_booking_enabled` column is inert (no migration to run; card API only).
- Tracker ship-afters #4–#10 ride post-flip (priority: #10 + #7 pre-announce,
  #6 deadline reminders = the flagship fast-follow, #9 fed by canary stage 6).
- Held-commit coupling records (tracker + memory) must be updated to the FINAL
  Trips SHA after the step-1 rebase (the SHA changes again — same discipline as
  3c19f5d7 → 84cfbf86).
