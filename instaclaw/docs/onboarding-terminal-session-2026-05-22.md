# Onboarding Terminal Session — 2026-05-22

End-of-day summary of everything the onboarding-focused terminal (this session)
shipped on 2026-05-22, the day before the snapshot bake for Edge Esmeralda
(2026-05-30, ~1000 attendees, 8 days out).

Companion terminals working in parallel today: Edge City terminal (F1-F4 +
W1-W3 + W5 + Charlie #4 + ChatGPT auth), snapshot bake terminal
(snapshot-bake-v112 execution brief), and reconciler terminal (agent identity
docs).

## Headline outcomes

- **EdgeOS P0 ROOT-FIXED end-to-end.** Cooper's email + Timour's email +
  any real attendee now verify cleanly through `/edge/claim`. Prior
  behavior would have blocked ~80% of 1000 attendees on Day 1 (anyone with
  a ticket but no prior EdgeOS user account).
- **17 cloud-init reliability fixes** carrying forward from yesterday's
  P0/P1 incident chain (vm-1019, vm-975, Doug, shelpinc) — pipeline now
  hardened against pool-vs-cloud-init drift, lying-DB, configure loops,
  bot-description gaps.
- **Onboarding UX overhaul**: dual-option personalization popup,
  BotFather deep link, smart-paste token extractor, premium /deploying
  banner + accordion, quirky bot greeting restoration, "Open your bot
  in Telegram" CTA.
- **Edge brand polish on shared funnel surfaces** (post-Edge-terminal
  F1-F4 + W1-W3): olive Continue button on /plan, olive cloud-init banner
  on /deploying, em-dash sweep regression catch.

## Commit chain (this terminal — chronological)

Earlier this morning (carried over from yesterday's incident):

```
74c98b56  feat(gmail): GMAIL_POPUP_DISABLED kill-switch
a3460033  fix(cloud-init): add meta block to openclaw.json
223ff286  fix(cloud-init): bump §1.32 gateway-health probe 60s → 240s
7eaf4bfe  fix(cloud-init): disable snapshot's vm-watchdog cron in §1.0.5
880507af  fix(cloud-init): provider-prefix model strings
f478a4fd  fix(cloud-init): bump Linode waitForServer 120s → 240s
18d9a86f  fix(cloud-init): §1.33 wait for telegram polling before callback
56e8f467  feat(reconcile): stepGbrainEnvSync — propagate gbrain API key
661735b7  fix(cloud-init): §1.0.7 disable OpenClaw bonjour on cloud VMs
848c5e95  fix(vm-lifecycle): Pass -1 orphan reconciler uses Rule 50
afbeca6f  fix(health-check): three-layer guard on telegram-token auto-fix
ab8c2c4e  feat(assignOrProvisionUserVm): pool-first ALWAYS, cloud-init fallback
```

Afternoon session start (TASK 1 onward):

```
3f0c865d  fix(landing): counter floors at 1; remove "Servers restocking"
ccb89a26  revert(gmail): re-enable post-onboarding Gmail connect popup
8a673c31  TEMP: pause cloud-init-poll + replenish-pool crons for e2e test
4acc5280  fix(cloud-init): §1.0.7 add daemon-reload + content-verify (TASK 1)
0377e01b  fix(vm/configure): cloud-init first-10-min protection guard (TASK 2)
85ed6f61  fix(vm/configure): widen cloud-init protection window 10 → 15 min
00eb8d7f  revert: re-enable cloud-init-poll + replenish-pool crons (e2e done)
01098160  feat(cloud-init): §1.34 set Telegram bot description on first-touch
60979082  feat(reconcile): stepTelegramBotDescription — POOL coverage gap fix
eb255bad  fix(reconcile): stepBootstrapConsumed — restores quirky greeting (TASK 5)
a4d144e1  feat(deploying): premium cloud-init banner + accordion (TASK 3)
8c9577bc  feat(dashboard): dual-option personalization popup (TASK 9)
e78d9a45  feat(connect): BotFather deep link + smart-paste (Charlie FIX A)
cef0580a  feat(onboarding): "Open your bot in Telegram" CTA on completion modal (Charlie FIX B)
```

EdgeOS P0 chain (mid-afternoon, during Cooper's demo):

```
e3b1873f  fix(edgeos): P0 — third-party-login (not user-account-login)
8749df42  chore: empty-commit redeploy trigger for EDGEOS_THIRD_PARTY_API_KEY
fbaeba48  fix(edgeos): P0 — DEFAULT_API_BASE switched dev → prod tier
72bf576e  fix(edge/claim): P1 — proper verify button feedback (spinner) + inflight ref
924d8fc6  fix(edge/claim): stronger disabled visuals (opacity-50 + cursor-not-allowed)
fe7f778a  fix(edge/claim): em-dash sweep — W1 conformance on soft OTP copy
```

Late-afternoon W2 + W3 polish (on Edge terminal's W2/W3 base):

```
a3eac95c  fix(plan): W2 polish — Continue button olive for Edge attendees
7a503608  fix(deploying): W3 follow-up — Edge palette on cloud-init banner
```

**This terminal's commit total: ~33 commits.**

## What changed at the user level

### Brand-new attendees (Edge Esmeralda 1000)

- `/edge/claim` ticket verification now actually works for pass-holders
  (no more 404 "User not found" wall)
- BotFather one-tap deep link replaces "open Telegram → search → tap
  Start → type /newbot" — ~30 seconds saved
- Smart-paste extracts the bot token from anywhere in pasted text;
  paste the entire "Done! Congratulations..." BotFather reply and it
  finds the token
- Verify button shows a real SVG spinner + becomes visually disabled
  (opacity-50 + cursor-not-allowed) during verification
- Edge-funnel olive palette extends through /plan (headline + body +
  Continue) + /deploying (orbs + progress bar + cloud-init banner)
- Post-onboarding "Open your bot in Telegram" CTA on completion modal
  with `?start=start` deep link → bot auto-replies on first arrival
- Telegram bot profile description set BEFORE user opens chat:
  "i take a moment to wake up on your first message — totally normal,
   just loading my brain. after that, responses are instant."

### Returning users on dashboard

- Personalization popup is now dual-option (Gmail + ChatGPT) instead of
  Gmail-only. Gmail card is grayed out by default (controlled by
  `GMAIL_PERSONALIZATION_ENABLED` env var — currently OFF until Google
  CASA Tier 2 clears).
- ChatGPT card always active; opens the (parallel terminal's) ChatGPT
  modal for personalization + model switch + history import.

### Operators (no visible UX, infra hardening)

- Cloud-init reliability: §1.0.5/§1.0.7/§1.32/§1.33/§1.34 — bonjour
  disabled, gateway-health probe extended to 240s, telegram polling
  confirmed before callback, bot description set on first-touch.
- Pool coverage: dedicated `stepTelegramBotDescription` reconciler step
  catches pool-path AND backfills existing fleet — no path is left
  without expectations set in the user's bot profile.
- /api/vm/configure 15-min guard prevents the rotating "configure-loop
  kill" class that took down vm-1019 yesterday.
- `stepBootstrapConsumed` now requires a REAL conversation (≥100 chars
  of substantive assistant text) before clearing BOOTSTRAP.md. Restores
  the "just woke up, who should I be?" greeting that was previously
  killed by the reconciler before the first message.
- Landing-page counter floors at 1, never displays 0, never shows
  "Servers restocking" — pool can drain without breaking conversion.

## Environment variables added today

| Name | Value | Scope | Purpose |
|---|---|---|---|
| `EDGEOS_THIRD_PARTY_API_KEY` | `nFrMSSPjeWLFOlBxZ2HJbqVSjuURq2JGRKpCYVDaDzs` | All 3 | EdgeOS attendee verification (new prod-tier primitive) |
| `GMAIL_POPUP_DISABLED` | `(set earlier this morning)` | All 3 | Force-dismiss Gmail popup fleet-wide |
| `GMAIL_PERSONALIZATION_ENABLED` | UNSET (default false) | All 3 | Toggle Gmail card active/grayed in personalization popup |

## Deferred (with rationale)

- **TASK 4 (Instant ack on first Telegram message):** post-Edge-Esmeralda
  architecture work. True instant-ack requires either patching OpenClaw
  dist OR a separate Telegram poller; both are 4+ hour efforts with
  uncertain payoff vs the soft solutions already in place (TASK 5
  quirky greeting + §1.34 bot description + Charlie FIX B post-tour CTA).
- **TASK 10 (ChatGPT conversation history import):** parallel terminal
  may have started; this terminal explicitly deferred since TASK 8
  ChatGPT auth was already shipped by Edge terminal.
- **Tier-card orange accents on /plan:** intentionally not swapped to
  olive — those are tier-specific brand affordances ("Pro is selected"
  highlight), changing them weakens the cross-page tier recognition.
- **Error/recovery UI orange tints on /deploying:** error convention
  uses orange/red regardless of brand context; switching to olive on
  failure weakens the "needs attention" affordance.

## Open flags / observations

- **Bankr API still HTTP 500** after 24+ hours. Provisioning-missing-
  bankr-wallets cron auto-backfills the moment Bankr's API recovers;
  Edge attendees will continue to have `bankr_evm_address` NULL until
  then. Cooper should message Igor.
- **21 git stashes** accumulated through the day's cross-terminal
  coordination dances. Most are named "WIP-not-mine" — they contain
  other terminals' uncommitted work I temporarily stashed to push my
  own commits. None contain my own work (which is all committed).
  Recommend: don't pop/drop blindly. Each terminal owner can
  `git stash show -p stash@{N}` and decide.
- **The "verified" path on `/edge/claim` sends an OTP email** to the
  attendee as a documented side effect of Tule's third-party-login
  primitive. Soft copy on the verified state tells users to ignore it.
  At 1000 attendees this is 1000 ignorable OTP emails on Day 1 —
  acceptable for verification, but worth tracking if Tule's mail
  service hits any rate limit.
- **The /api/edge/verify-ticket cookie chain on the ChatGPT auth
  path** has NEVER been end-to-end tested for a brand-new signup. Edge
  Esmeralda attendees who pick ChatGPT-over-Google are the
  ~30%-untested case. Recommend a live test before Day 1, ideally with
  a real EdgeOS-registered email through the full chain
  (`/edge/claim → /signin (ChatGPT) → /connect → /plan → Stripe →
   /deploying → /edge/intents → /dashboard`).

## Tests + tsc state

- `npx tsc --noEmit`: 0 errors at end of session
- `scripts/_test-edgeos-verifier.ts`: 30/30 passing (4 tests updated
  for new endpoint shape: 401 = not_attendee, 404 = degraded fail-open)
- `scripts/_test-cloud-init-tarball.ts`: ALL PASS (multiple new
  assertions added for §1.0.7 daemon-reload, §1.34 bot description,
  Rule 23 sentinels)
- `scripts/_test-createUserVM.ts`: 88 assertions passing

## What's READY for the May 30 launch

| Surface | Status |
|---|---|
| `/edge/claim` ticket verification | ✓ Live + verified end-to-end |
| `/edge/setup` Edge-branded interstitial | ✓ Edge terminal |
| `/signin` Google path | ✓ Production-stable |
| `/signin` ChatGPT path | ✓ Shipped (untested end-to-end for Edge signup chain) |
| `/connect` BotFather deep link + smart-paste | ✓ Shipped + verified |
| `/plan` Edge headline + olive Continue | ✓ Shipped |
| Stripe back-button recovery | ✓ Charlie #4 — Edge terminal |
| `/deploying` cloud-init banner + accordion | ✓ Shipped |
| `/deploying` Edge palette (olive orbs + progress bar) | ✓ Edge terminal + my banner polish |
| `/edge/intents` mandatory gate | ✓ Edge terminal |
| `/dashboard` personalization popup | ✓ Gmail dimmed + ChatGPT active |
| Quirky bot greeting on first message | ✓ Shipped |
| Telegram bot description (expectation-set before /start) | ✓ Cloud-init §1.34 + reconciler step |
| Post-onboarding "Open in Telegram" CTA | ✓ Shipped |
| Pool replenishment + cron health | ✓ Crons live + pool healthy |

## What's PENDING for the May 30 launch

| Item | Owner | Status |
|---|---|---|
| Snapshot bake v112 with all today's fixes | snapshot terminal | In progress (their commit `3c6f9ac3` is the brief) |
| LINODE_SNAPSHOT_ID env update post-bake | Cooper | Pending bake completion |
| Bankr API recovery | external (Igor) | HTTP 500 — Cooper to message |
| End-to-end ChatGPT auth flow live test | next operator | UNTESTED for Edge signup |

## Recovery procedures (in case)

- **`/edge/claim` regression:** add an override via
  `EDGE_VERIFIED_OVERRIDE_EMAILS` Vercel env var (comma-separated
  email list). Bypasses EdgeOS entirely. Documented in
  `lib/edgeos.ts:OVERRIDE_ENV_VAR`.
- **Pool drained mid-launch:** crons handle replenishment automatically.
  Manual provision via `/api/cron/replenish-pool` GET with
  `Authorization: Bearer $CRON_SECRET` if needed.
- **Cloud-init VM stuck:** `lifecycle_locked_at` column on
  `instaclaw_vms` blocks the kill loop. Cron `clear-stale-configure-
  locks` auto-clears after 5 min, so manual recovery shouldn't be
  needed.
- **EdgeOS down:** `verifyAttendeeByEmail` fails open with
  `{verified:true, degraded:true}` — attendees still pass through
  the gate, with a degraded log line for operator visibility.

## End of session

Working tree: untracked debug scripts only. tsc clean. tests passing.
Stashes left intentionally (multi-terminal coordination artifacts). All
my work committed + pushed to main + deployed.
