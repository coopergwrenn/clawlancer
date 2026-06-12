> ## ⚠️ RECONCILIATION — 2026-06-12 (read this before any § below)
> This PRD predates four ruled changes; trust the canon below over any conflicting
> section. Found UNTRACKED on 2026-06-12 by the bird's-eye audit (written 06-10,
> referenced by §-number from 6+ committed code comments, never committed) —
> rescued into version control in the same pass.
>
> 1. **The per-VM `travala_booking_enabled` gate is DEAD** (Q2, 2026-06-12).
>    book-quote is gated by the operator kill switch ONLY; the column is inert;
>    the user's pause lever is the frontier revoke. Any § describing the "Travel
>    Agent card toggle" / "two deliberate opt-ins" (items F, J; §5, §14-F) is
>    historical.
> 2. **Travel booking is open to ALL TIERS, starter included** (Q1 REVERSED,
>    2026-06-12). No tier gate anywhere in the lane; `frontier-policy.ts` allows
>    travel in every tier's default; the tier-independent travel ceiling
>    ($1200/tx, $3000/day) + the per-booking session tap are the protections.
> 3. **Cancel/manage shipped** (2026-06-11): manage-booking + cancel-booking ops
>    (two-step Travala OTP), `instaclaw_travala_bookings` as the system of record
>    (persist-on-confirmed-pay), reconciler cron + record-failure alert, the
>    deterministic EIP-3009 nonce (on-chain exactly-once retries), honest deny
>    narrations (the funding ask; refunds are Travala credit, never wallet).
> 4. **The Trips surface shipped** (2026-06-12): /trips + TripCard (4 states),
>    presence-gated sidebar entry, ?prefill= chat handoff (seed, never send).
> Living docs: `docs/travala-canary-runbook.md` (the canary, holds for GO) and
> `docs/travala-lane-tracker.md` (ship-afters #4-#10). The canary seams (Q1b
> machine-client email match, m2m refund destination, step-2 idempotency) remain
> the open questions this PRD's §14 anticipated.

# Travala x402 Booking Integration — Design PRD

> **Status**: Design draft — fork points open, awaiting Cooper rulings. **No code yet** (STOP-before-build stands).
> **Date**: 2026-06-10 (same-day as Base's @base "Agents can handle your travel now too" / Travala tweet).
> **Owner**: Cooper. Drafted by the toolrouter terminal.
> **Mode**: no-clock. The deliverable is understanding + a decision-ready shape, not code.
> **Companion docs**: `base-mcp-integration.md` (v1 shipped, v1.5 paper), `base-mcp-integration-addendum.md` (freshness/vision). Frontier files referenced are **frontier-terminal-owned — this doc proposes, it never edits them.**

---

## 0. TL;DR

The intersection Cooper suspected is **real**, and most of it already exists in production:

- **The hard part — paying an external x402 merchant from an agent — is already built and proven live.** `skills/frontier/scripts/frontier-spend.mjs` does the full payer dance (probe → 402 → EIP-3009 `transferWithAuthorization` → Bankr `/wallet/sign` → X-PAYMENT → settlement tx) against a real x402 merchant on Base mainnet. *"the buyer needs no facilitator proxy … proven live"* (`frontier-spend.mjs:14-15,42-43`). Travala is, to that rail, **another x402 merchant** — pending one canary-time scheme check.
- **The consent model Travala's own protocol assumes — "final payment authorization still requires manual approval from the traveler" (Cointelegraph) — maps one-to-one onto our shipped `human_approved` consent surface** (`frontier-authz.ts`, `agent-economy/settings/route.ts`, shipped to main 2026-06-03). No new consent UI is needed.
- **StableTravel plans; it has never booked.** Travala is the missing BOOK leg. This integration is the thing that makes the *shipped* public claim — *"Booking end to end coming soon"* (`premium-tools-skill-card.tsx:92`, origin/main) — TRUE.

**The one thing that does not exist and is mandatory:** the frontier spend gate **hard-denies hotel-scale spends ($100-500) before consent can even be applied** (`frontier-authz.ts:106-122` — Gate 1 hard-deny runs *before* `human_approved`). So a frontier-policy change — a new category-scoped travel ceiling — is a **named dependency on the frontier terminal**, spelled out in §6 ready to implement. Until it lands, no booking can complete on any tier except a Power-tier $INSTACLAW staker, and staking isn't live.

**Recommended v1 shape:** a new `travala` skill that uses Travala's free search tools for discovery and routes the `travala_book` x402 payment through the *existing proven* `frontier.spend()` rail, gated by (a) the new travel category, (b) consent-always via `human_approved`, (c) a fail-closed Travala kill switch. Consent-always by construction; autonomous-within-limits is explicitly a later phase (double-gated on v1.5 Sub Account + a deliberate band raise).

---

## 1. The full chain (drawn end to end)

```
  USER ("book me 2 nights in Lisbon under $400, near Alfama")
    │
    ▼
  [1] ToolRouter research / planning        ── EXISTS. StableTravel (search-only) +
      (dates, area, prefs, budget)              brave/exa research. ToolRouter-credit rail.
    │                                           lib/toolrouter-credits.ts, workspace-templates-v2.ts:306
    ▼
  [2] Travala search + quote                 ── NEW. travala_search_hotel → travala_search_package.
      (real bookable inventory + price)         Travala MCP/HTTP, FREE (assumed; canary-verify).
    │                                           github.com/travala/travel-mcp
    ▼
  [3] Frontier AUTHORIZE  (consent moment)   ── EXISTS as a surface; REQUIRES the §6 travel-category
      hotel price → ask_first → human            policy change to not hard-deny. Consent = human_approved:true
      confirms (Telegram / suggest-link)         re-call. app/api/agent-economy/authorize/route.ts, frontier-authz.ts
    │                                           settings/route.ts + economy-policy-controls.tsx (suggest/confirm)
    ▼
  [4] x402 PAY via proven Bankr rail         ── EXISTS & PROVEN. frontier-spend.mjs: 402 → EIP-3009 →
      (travala_book 402 → X-PAYMENT)             Bankr /wallet/sign → X-PAYMENT → settlement tx.
    │                                           NEW glue: bridge travala_book's 402 → frontier-spend-core.
    ▼
  [5] Confirmation delivered to user         ── NEW (thin). travala_book success → booking ref + tx hash →
      (booking ref, dates, cancel policy)        Telegram reply. travala_book_status for recovery.
    │
    ▼
  [6] SETTLE + ledger                        ── EXISTS. /agent-economy/settle closes the hold, records
      (hold→settled, tx_hash, standing)          tx_hash/result_used. app/api/agent-economy/settle/route.ts
                                              ── Cancellation → refund maps to /agent-economy/refund (design item §9).
```

**Every leg except [2] and the [3]→[4] glue already exists.** The integration is: a Travala discovery+book skill ([2], [5]), a small bridge from Travala's 402 into the proven payer ([3]→[4] glue), and one frontier-owned policy dependency ([3] ceiling).

---

## 2. Phase-1 corrected internal state (self-contained summary; full evidence in the Phase-1 STOP)

| Thread | Reality (cite) |
|---|---|
| Base MCP **v1** | **Shipped & live.** 6 `base-*/SKILL.md` on the fleet (vm-050 cv=128), `BASE_DEFI_ROUTING_V1` in AGENTS.md, `stepBaseSkills`/`stepDeployBaseDefiRouting` in `vm-reconcile.ts:482,984`. Pattern = DeFi *calldata-prepare*, Bankr-signed. **Different shape from Travala (pay-an-invoice).** |
| Base MCP **v1.5** (autonomous Sub Account) | **Entirely paper.** No `lib/base-sub-account.ts`, no migration, no cron, no `BASE_SUB_ACCOUNT_ADDRESS` on disk. **⇒ Bankr is the only signing wallet that exists today.** |
| x402 **payer rail** | **Built & proven live.** `frontier-spend.mjs` + `frontier-spend-core.mjs`; Bankr `/wallet/sign` EIP-3009; Base mainnet (`eip155:8453`), USDC, `exact` scheme; buyer needs no facilitator proxy. The seller-side facilitator proxy (`app/api/x402/facilitator/[op]/route.ts`) is for when *we* are the resource server (earn), not needed to pay. |
| ToolRouter **StableTravel** | **Search-only**, World-ID-gated, billed on the **ToolRouter-credit** rail (not frontier x402): `stabletravel.{locations,google_flights_search,hotels_list,hotels_search,flightaware_flights}` (`toolrouter-credits.ts:88-92`). No booking primitive. Agent fallback: *"i can dig up direct URLs you'd book yourself"* (`workspace-templates-v2.ts:369`). |
| Frontier **spend gate** | 3 gates, strict precedence (`frontier-authz.ts`): **(1) hard-deny — absolute, human cannot override per-spend** → (3) `human_approved` lifts only the autonomy band → (2) autonomy = policy band ∩ earned budget. Ceilings (`frontier-policy.ts:47-50`): Starter $10 / Pro $50 / Power $200 per-tx (staker 2×). No travel category; hotels → `"other"`, allowed only on Power (`:274-279`). |
| Frontier **consent surface** | **Shipped to main 2026-06-03** (commit `cdc519e6`): `frontier-settings-monotonic.ts` + `agent-economy/settings/route.ts`. Loosenings never auto-apply; agent gets a `?suggest=field:value` deep link; only a NextAuth-session **Save** (`agent-economy/policy/route.ts`) applies it. Per-spend consent = `human_approved:true` re-call. (Absent only from the stale `premium-tools-grid-card` branch — they are live.) |

**The $300-hotel verdict (definitive):** hard-denied today on Starter, Pro, and non-staker Power — and `human_approved:true` **cannot** override a hard deny (`frontier-authz.ts:107` runs before `:114`). Only a Power-tier $INSTACLAW staker (neverPerTx $400) clears the deny into `ask_first`. Staking is not live (`is_staker` always false). **⇒ Net: nobody can book a hotel today. §6 is mandatory.**

---

## 3. What Travala actually shipped (Phase-2, primary + corroborated; UNKNOWN where unproven)

**Primary source:** `github.com/travala/travel-mcp` (updated 2026-06-02) + `github.com/travala/travel-skills`. Press corroboration: Cointelegraph, The Block (paywalled), Bitget — all dated ~Jun 4-5; Base amplified Jun 10.

| Question | Finding | Source / confidence |
|---|---|---|
| What is it? | A **mix**: a remote **MCP server** at `https://travel-mcp.travala.com/mcp` (`transport: type:"http"`) + an **x402-gated HTTP API** + a `SKILL.md`. **Not** a Base launch-seven skill-plugin; standalone. | README (primary) — HIGH |
| Tool set | `travala_search_hotel`, `travala_search_package`, `travala_book`, `travala_book_status`, `travala_manage_bookings`, `travala_cancel_booking` | README — HIGH |
| Booking flow | search_hotel → search_package → **book (returns HTTP 402 + x402 payment details)** → pay → confirm; `book_status` for recovery; `manage_bookings`/`cancel_booking` after | README — HIGH |
| Payment standard | x402, HTTP 402 PAYMENT-REQUIRED; README mandates `@coinbase/payments-mcp` (the generic Coinbase x402 client) | README — HIGH |
| **Exact EVM scheme** (the crux) | **UNKNOWN from README.** Press says x402 on Base USDC. README does not name `exact`/EIP-3009. `@coinbase/payments-mcp` does the standard `exact` dance, which our Bankr-signed EIP-3009 produces — **likely compatible, NOT proven.** | README UNKNOWN / press indirect — **#1 canary gate** |
| Chain + currency | **Base mainnet + USDC.** README itself UNKNOWN (says rewardWallet="any EVM address on Base", cbBTC giveback); press (Cointelegraph: *"USDC on layer-2 blockchain Base"*) corroborates. | Press HIGH / README UNKNOWN — exact USDC contract = canary-verify |
| ERC-7715 session keys | **The END-USER consent/wallet layer, not a payer requirement.** Cointelegraph: *"allowing the AI agent to request a payment while keeping final signing authority inside the traveler's wallet."* README never mentions it. ⇒ It's the Coinbase/Claude-desktop consumer pattern; a standard x402 `exact` X-PAYMENT from our Bankr wallet should satisfy the endpoint. **Confirm at canary by inspecting `accepts[]`.** | Cointelegraph + README-silence — MED-HIGH |
| Human-in-the-loop | **Required by Travala's own model**: *"final payment authorization still requires manual approval from the traveler"* (Cointelegraph). | Press HIGH — **aligns with consent-always** |
| Auth / account | No Travala account explicitly required for calls; guest details (name/email/phone) at book time. **API key UNKNOWN. KYC UNKNOWN.** Optional agent registration at `8004scan.io/agents` → `agentId` + `rewardWallet` for the **10% cbBTC dev rebate**. | README — account/KYC = **UNKNOWN, Cooper-action to confirm** |
| Cancellation / refund | `travala_cancel_booking` returns "cancellation status, refund amount, cancellation fee, policy summary." **Specific %/timelines UNKNOWN.** Reward payout only after booking `completed` (≥ check-in, subject to refund window). | README — specifics UNKNOWN |
| Cost | **$0.01 = x402 protocol/transaction fee, NOT the room price** (Cointelegraph). Room price ($100-500) is the spend the frontier gate sees. | Press HIGH |
| Clients | Claude Desktop named; "outside developers able to integrate." | Press HIGH |
| Scope | Hotels now (2.2M listings incl. Marriott/Hilton/IHG); **flights = future.** | Press HIGH |

**Relationship to StableTravel (Phase-2 Q6):** *complement, with hotel-overlap.* For **hotels**, Travala supersedes — it searches the *bookable* catalog and books, which StableTravel's `hotels_search` cannot. For **flights**, StableTravel remains the only option (Travala flights are future). Honest answer: **StableTravel plans (esp. flights + quick lookups); Travala searches+books hotels.** See fork (b).

---

## 4. Recommended integration shape

### 4.1 The decision: frontier-mediated, NOT MCP-auto-pay

Two ways to wire Travala. Only one fits our architecture.

- **Option A — wire `travala-mcp` as an MCP server and let `@coinbase/payments-mcp` pay.** Rejected. It needs a local signer/private key (we sign remotely via Bankr; **no key on a VM** is a load-bearing invariant), and it **bypasses `frontier.spend()`** — no authorize gate, no consent, no ledger, no kill switch. For a real-money external merchant this is unacceptable and violates frontier SKILL.md Rule 0 (*"NEVER sign USDC transfers manually. Use `frontier.spend()`"*).
- **Option B — frontier-mediated (RECOMMENDED).** Use Travala's **free search tools** for discovery; route the **`travala_book` payment through the proven `frontier.spend()` rail**. Frontier stays the single money rail: authorize gate → consent → Bankr-signed EIP-3009 X-PAYMENT → settle/ledger. The only novel code is a **bridge** that takes `travala_book`'s 402 `accepts[]` and feeds it into `frontier-spend-core.mjs`'s existing `selectPaymentRequirement` / `buildAuthorization`.

### 4.2 Where each leg's code lives (today vs new)

| Leg | Code | Status |
|---|---|---|
| Research/plan | StableTravel + brave/exa, ToolRouter rail | EXISTS |
| Travala search/quote | NEW `travala` skill calls `travala_search_hotel` / `travala_search_package` (MCP-over-HTTP tools/call, or the HTTP API) | NEW (thin) |
| Authorize/consent | `app/api/agent-economy/authorize/route.ts` + `frontier-authz.ts` + `settings`/`policy` consent surface | EXISTS (needs §6 policy dep) |
| x402 pay | `frontier-spend.mjs` / `frontier-spend-core.mjs` (Bankr EIP-3009) | EXISTS & PROVEN |
| **402→spend bridge** | NEW: parse Travala MCP `travala_book` 402 → `accepts[]` → `selectPaymentRequirement` → pay; resend X-PAYMENT through the MCP tool-call | NEW — **the real engineering** |
| Confirmation | NEW thin: format booking ref + tx + cancel policy → Telegram | NEW (thin) |
| Settle/refund | `app/api/agent-economy/settle/route.ts` (+ `/refund` for cancellations — §9) | EXISTS (refund mapping = design item) |

**Open design sub-fork (e1):** Travala's 402 is returned *inside an MCP tool-call response* (MCP-over-HTTP at `/mcp`), whereas `frontier-spend.mjs` drives plain HTTP GET/POST→402. The bridge must either (i) speak MCP JSON-RPC `tools/call` to `travala_book`, capture the 402 from the MCP envelope, pay, and re-call; or (ii) call Travala's **direct x402 HTTP API** if one is exposed separately (README says the system *includes* an "x402-gated HTTP API" — whether it's callable outside the MCP framing is **UNKNOWN**; canary-probe). Path (ii) is simpler and fits the proven rail unchanged; path (i) needs an MCP-aware payer. **Probe which exists at canary before committing the bridge shape.**

### 4.3 Where the skill lands + how it rolls

- **New skill `instaclaw/skills/travala/`** (`SKILL.md` + `references/` + a wrapper script), static-extracted pattern per Rule 24 (no `.git/`). NOT an extension of `base-*` (different shape).
- **Rolls via source/manifest only** — `vm-manifest.ts:skillsFromRepo` + a manifest version bump (or file-drift per Rule 47 for content). **NEVER on-disk edits** — the file-drift/integrity cron reverts them within minutes (proven by the higgsfield-canary hole, and by the v1 base-skills file-drift deploy). Rule 23 `requiredSentinels` on the wrapper + SKILL.md.
- **Consent surface unchanged** — the skill instructs the agent to call `frontier.spend()` for the book leg, which already produces the `ask_first` → `human_approved` → suggest/confirm flow. No new UI primitive (per Cooper ruling 2).

---

## 5. Kill switch (fail-closed, day one)

Compose two layers — do NOT invent a third consent path:

1. **Global frontier kill switch (EXISTS, reuse as-is).** `frontier-kill-switch.ts`: `instaclaw_admin_settings.frontier_spend_kill_switch`, read by `/authorize` every call, **overrides even `human_approved`**, fail-OPEN (emergency stop). Because Travala pays through `frontier.spend()`→authorize, **this already halts Travala** when engaged. No work.
2. **NEW Travala-specific feature gate (fail-CLOSED — the higgsfield-gate precedent).** A sibling row `instaclaw_admin_settings.travala_booking_enabled` (default **absent/false ⇒ disabled**), checked by the `travala` skill's book wrapper *before* it ever calls `frontier.spend()` for a booking. **Fail-closed**: read error or absent → treat as OFF. Unlike the global switch (fail-open because it's an operator-engaged emergency stop), a brand-new real-money external merchant must be **OFF until explicitly turned on and the read succeeds.**

Net: a Travala booking proceeds only if `travala_booking_enabled === true` AND global kill switch not engaged AND privacy-mode off AND authorize returns `human_approved`. Four independent fail-safes; three of them already exist.

---

## 6. MANDATORY DEPENDENCY — frontier-policy travel category (frontier-terminal-owned; proposed diff, do NOT edit their files)

> **✅ RESOLVED 2026-06-10 (both halves + a red-team hardening shipped).** The original §6 dependency landed in two commits and then got tightened: (1) `f8b79d9e` added the **category-scoped travel ceiling** (live-probed $100 travel→ask_first, $1300→deny) — the gate is now real; (2) `d1577583` (red-team F2) made travel a **SESSION-REQUIRED category** — the forgeable `human_approved` bool NEVER authorizes travel; only an unforgeable browser-session approval (the dashboard tap) does. So the booking lane is UNBLOCKED, and the consent model is stronger than this PRD originally specced: not "agent claims the user said yes" but "the user taps from their own session." `travala-book.mjs` step 3 is reworked to that contract (see §14 P2-complete-v2). The original STOP is cleared.

The shipped ceilings hard-deny hotels before consent. Per Cooper ruling 1 (GO, all tiers, consent-always), here is the **exact ready-to-implement proposal** for the frontier terminal. Numbers are proposals; final call is Cooper's (fork a).

**Category name: `"travel"`** (not `"commerce"`). Justification: the high category ceiling is a real exposure surface; the *narrowest* category that solves the immediate need keeps that exposure smallest (fail-closed ethos). `"commerce"` would let any commerce-tagged spend inherit the $1200 ceiling. Start narrow; generalize to `"commerce"` only when a second vetted real-world-purchase vertical actually arrives.

**Proposed change to `lib/frontier-policy.ts` (frontier owns this file):**

1. Add `"travel"` to the `SpendCategory` union (`:233`).
2. Add a tag rule mapping `hotel|flight|booking|travala|lodging|reservation` → `"travel"` in `TAG_CATEGORY_RULES` (`:248`).
3. **Category-scoped band override (the structural piece).** Today bands are global per tier. Introduce a per-category ceiling override applied in `evaluateSpend` when `ctx.category === "travel"`:
   ```
   CATEGORY_BANDS.travel = {
     justDoItPerTx: 0,        // never autonomous — every booking is ask_first by construction
     justDoItPerDay: 0,
     neverPerTx:  1200,       // hard ceiling: covers the vast majority of single bookings
     neverPerDay: 3000,       // a consented session cannot fire unbounded bookings/day (~2-3 max)
   }
   ```
   Applied **tier-independently** — because the *human's explicit authority* backs a travel spend, not the agent's earned standing (Cooper ruling 1). Same ceilings for Starter/Pro/Power.
4. Add `"travel"` to `DEFAULT_ALLOWED_CATEGORIES_BY_TIER` for all tiers (`:274`) — otherwise the category gate (`:190`) hard-denies before consent. **Sub-fork (a1):** default-on (recommended — consent-always makes it safe) vs opt-in-per-user via the dashboard (more conservative; one extra friction step). 
5. Preserve monotonic-clamp composition (`frontier-settings-monotonic.ts`): a user may **tighten** the travel ceiling (lower than $1200) but never loosen beyond it.

**Why these numbers:** a 3-4 night 4-star is ~$400-900; luxury/longer up to ~$1200. `$1200/tx` covers the realistic single-booking long tail; anything above hard-denies and forces either a deliberate policy raise or splitting (acceptable — a >$1200 hotel night is a "call Cooper" event). `$3000/day` bounds a compromised-or-confused-session blast radius to ~2-3 bookings. `$0` just-do-it makes every booking `ask_first` → `human_approved` with zero autonomous path — exactly the ruling.

**Interaction with the keystone earned-budget line** (`frontier-authz.ts:139`): irrelevant here. `human_approved:true` is checked at `:114` *before* the earned-budget gate at `:139`, so a consented booking does not need earned budget. The travel category only has to clear Gate-1 hard-deny (ceiling + category-allowed); consent does the rest.

**This is the single thing that blocks v1.** Everything else composes around it. Coordinate with the frontier terminal; this doc is the spec.

---

## 7. Fork points for Cooper's ruling

- **(a) Ceiling/category — RULED (GO, all tiers, consent-always).** Open sub-decisions: category **name** (`travel` proposed — §6), **$1200/tx** ceiling, **$3000/day** cap, **default-on vs opt-in** allowlist (a1). Set the numbers or accept proposals.
- **(b) StableTravel's fate.** Recommend **keep** (flights + quick lookups), route hotel *booking* through Travala. Sub-fork: also retire StableTravel `hotels_search` in favor of Travala's bookable search, or keep both? (Recommend keep both v1; Travala search is the booking path, StableTravel a cheap pre-check.)
- **(c) Canary VM — OPEN (per your ruling).** vm-1019 is **down/unhealthy (cv=114)**; vm-1043 is the base-skills canary precedent; vm-050 is booked for the higgsfield e2e today. You rule with the doc in front of you. Whichever VM: it needs a **Bankr wallet funded with real USDC on Base** for the live booking.
- **(d) v1 = consent-always — RULED yes.** Autonomous-within-limits deferred to a later phase, **double-gated**: needs both v1.5 Sub Account (paper) AND a deliberate travel just-do-it band raise (which §6 sets to $0 on purpose). Don't build it now.
- **(e) NEW — surfaced by research:**
  - **(e1) 402→spend bridge shape** — MCP-tool-call 402 vs direct x402 HTTP endpoint (§4.2). Canary-probe which exists.
  - **(e2) Scheme-compatibility (#1 risk)** — confirm `travala_book` accepts a standard `exact`/EIP-3009 X-PAYMENT from our Bankr wallet (not an ERC-7715-only flow). Canary gate, fail the integration loudly if it's ERC-7715-required (that would route us back to the paper v1.5 Sub Account).
  - **(e3) ERC-8004 reward registration** — register our fleet agents at `8004scan.io/agents` for the **10% cbBTC rebate** on bookings? Free revenue, but ties to ERC-8004 (v3 = paper). Could be a standalone tiny win: one `rewardWallet` (Cooper's, or per-user). Your call.
  - **(e4) Search-tool cost assumption** — assumed `travala_search_*` are free (no 402). If they're paid, they need their own (small) frontier path. Canary-verify.
- **(f) Counterparty trust** — Travala is a merchant, not an agentbook-verified agent; pay with `requireVerifiedCounterparty:false` (the policy already anticipates this — `frontier-policy.ts:95-96`). Not a blocker; flagging the setting.
- **(g) Staged overclaim copy — RULED HOLD.** Named precisely: the **`premium-tools-grid-card` branch working tree** carries an edit to `instaclaw/components/dashboard/premium-tools-skill-card.tsx` changing the StableTravel line from the shipped *"…Booking end to end coming soon."* (origin/main `:92`) to *"Books real flights and hotels end to end, not just links you finish yourself."* **Do not let it ride along in any promote until a real e2e booking is proven.** (Confirm commit-vs-dirty status with that branch's owner; this doc only flags it.)

---

## 8. Honest sizing per phase, blocked-on named

| Phase | Scope | Size | Blocked on |
|---|---|---|---|
| **P0 — scheme/flow canary probe** | From a VM, drive `travala_book` to its 402, dump `accepts[]` (scheme/network/asset/payTo) + confirm a Bankr-signed `exact` X-PAYMENT is accepted; determine MCP-vs-HTTP 402 path (e1) | 0.5-1 day | **Travala account/API-key/KYC = UNKNOWN (Cooper action to confirm)**; a funded test wallet |
| **P1 — frontier travel-category policy** | §6 diff, frontier-terminal-owned | 1-2 days (their side) | **Frontier terminal** (coordinate); Cooper sets numbers (fork a) |
| **P2 — `travala` skill + bridge + kill switch** | SKILL.md + wrapper (search + frontier-mediated book), 402→`frontier-spend-core` bridge, `travala_booking_enabled` fail-closed gate, manifest/reconcile/coverage (Rules 23/24/27/47) | 3-5 days | P0 result (bridge shape), P1 (policy live) |
| **P3 — canary + e2e proof** | Named VM, real consent + real USDC, one booking start→confirm→settle, exercise cancel/refund | 1-2 days | Canary VM (fork c), funded Bankr USDC wallet, Rule 64 approval |
| **P4 — autonomous-within-limits (LATER)** | Raise travel just-do-it band + v1.5 Sub Account | n/a | v1.5 Sub Account (**paper**) — explicitly deferred |

**Loud Cooper-actions:** (1) Confirm whether Travala requires an account/API-key/KYC for the payer — UNKNOWN, may need Cooper to create an account. (2) The frontier travel-category change is a dependency on the frontier terminal — coordinate. (3) Fund a Bankr USDC wallet on the canary VM for the real booking.

---

## 9. Design item — cancellation/refund mapping (named, not assumed)

`travala_cancel_booking` returns refund amount / fee / policy. Our `app/api/agent-economy/refund/route.ts` exists but is **not yet read by this terminal** — I will not assert its shape. P2 task: read it, map a Travala cancellation → a frontier ledger refund/settle adjustment (a booking is a settled spend; a cancellation is a partial/full reversal). Dispute path: `settle` already records `disputed`. Flag if the refund route doesn't support an external-merchant partial reversal — that's a gap, not an invention.

---

## 10. Future rails (strategy layer, per Cooper ruling 5 — one paragraph, no build implications)

The x402 payment leg is drawn as a **pluggable rail behind the frontier authorize/settle interface**, not welded to x402. The second-rail candidate is **Mastercard Agent Pay for Merchants (AP4M)**, launched today (2026-06-10): agent-initiated payments spanning cards and stablecoins with on-chain agent permissions including on Base, partner-gated now with broader access later in 2026. The design intent: a booking's payment leg resolves through `frontier.spend()` against a *rail adapter* (x402 today; AP4M or others later) so that the authorize gate, consent moment, ledger, and kill switch are rail-agnostic. No code now — this is a layering note so P2's bridge is written as "frontier-spend → rail adapter," not "frontier-spend → x402-only."

---

## 11. Marketing note (editorial call is Cooper's)

- **The Base MCP announcement hold stands untouched** — held until v1.5 autonomous signing is in beta (per the standing rule). This integration does not change that.
- **A Travala-specific moment may be separately viable** once a *real e2e booking is proven* (P3): the honest hook is *"last week our travel tool said booking end-to-end was coming soon. As of today it's not coming — it's here. We booked a real hotel, agent-to-merchant, paid in USDC on Base, human-confirmed, while the user did nothing but say yes."* It makes the *shipped* "coming soon" copy true — the cleanest possible counter to vaporware skepticism. Triggered via `/launch` per Rule 55, not generated here.
- **Do not** ship the §7(g) overclaim copy ahead of the proof; the post and the copy flip should land together, after P3.

---

## 12. ADDENDUM — Cooper rulings + Phase-0 probe results (2026-06-10, post-probe)

### 12.1 Fork rulings (locked)

- **(a)** GO. `travel` category, **$1200/tx**, **$3000/day** cap, **$0 just-do-it**. **OPT-IN at v1, not default-on** — a brand-new real-money merchant earns default-on with a track record; the user flipping the switch is a free extra consent layer. The §6 diff stays the frontier terminal's named dependency (untouched here); §6's sub-fork (a1) is hereby resolved to **opt-in**.
- **(b)** StableTravel keeps **both legs** at v1 (flights aren't in Travala v1; its hotel search stays until Travala's inventory proves better with real bookings). Routing: *StableTravel plans, Travala books.* Revisit retirement post-e2e.
- **(c)** Canary = **vm-1043** (healthy, cv=128, IP 45.33.95.220; vm-050 booked, vm-1019 down).
- **(e1)** Bridge shape (MCP-tool-402 vs direct-HTTP) decided by the probe, not on paper — carry both until the 402 is actually read.
- **(e3)** **DEFER** 8004scan reward registration (day-one third-party site tied to unshipped ERC-8004 — not a launch-week move). Parked.

### 12.2 P0 probe results — READ-ONLY, from vm-1043, no spend, no booking created

Endpoint `https://travel-mcp.travala.com/mcp` (`travala-mcp-server v1.0.21`, MCP 2025-06-18, SSE, stateless). Evidence quoted:

1. **8 tools live (README listed 6):** the 6 + `travala_whoami` (*"Requires login"*) + `travala_logout`. The connector is identity-aware.
2. **Search is PUBLIC.** `travala_search_hotel` unauth returned real inventory (Lisbon, 2026-06-24→26: "Lis Apartments" $370.58 USD refundable, packageId `qekuyjnOICYmdUP7`, sessionId `tON2jOn8uWGPajSG`). Our discovery leg works headless, free.
3. **🔴 BOOKING IS OAuth-2.1-GATED — the Bearer wall is hit BEFORE the x402 402.** `travala_book` unauth (valid package + dummy guest) → `HTTP/2 401`, `www-authenticate: Bearer error="invalid_token", error_description="Bearer token required", resource_metadata="https://travel-mcp.travala.com/.well-known/oauth-protected-resource"`. `travala_whoami` unauth → 401. This is exactly the headless-OAuth problem base-mcp PRD §2.1 flagged.
4. **The escape hatch — `client_credentials` is supported (headless, no browser).** Auth-server metadata: `grant_types_supported: [authorization_code, refresh_token, client_credentials]`; DCR at `/oauth/register`; scopes `mcp:read` (public/search) / `mcp:book` / `mcp:cancel`; PKCE S256; `token_endpoint_auth_methods: [client_secret_basic, client_secret_post, none]`; issuer = Travala itself. ⇒ A machine path exists: register one InstaClaw confidential OAuth client, mint short-lived `mcp:book` tokens via `client_credentials` backend-side. **This is NOT the v1.5 Sub-Account reroute.**
5. **Payment confirmed from PRIMARY tool text** (not just press): `travala_book` desc — *"Payment: USDC on Base (use Base Sepolia testnet when in test environments) via Coinbase."* 402 returns a `next_action` consumed by `payments-mcp:make_http_request_with_x402`.
6. **Consent-always confirmed from PRIMARY:** `travala_book` MANDATES a booking summary + verbatim privacy/T&C consent text + explicit *"Do you confirm and wish to proceed with booking using USDC via Coinbase?"* before the tool may be called. Their model is consent-always; maps to our `human_approved`.
7. **🟡 SCHEME-COMPAT (EIP-3009 vs ERC-7715) STILL UNKNOWN — it is behind the Bearer wall.** The 402 `accepts[]` is only revealed after `mcp:book` auth. The original P0 objective is blocked by a prior gate we didn't know existed. The probe succeeded: it found the real first blocker.

### 12.3 Design impact — a new OAuth pre-leg (bounded, solvable)

Two gates now sit between us and a booking, in order: **(1) OAuth `mcp:book` Bearer** → **(2) x402 payment.** New design leg, inserted before [4] in §1's chain:

> **[3.5] OAuth token (machine):** backend registers ONE InstaClaw confidential client (DCR, one-time), mints a short-lived `mcp:book` token via `client_credentials`, hands a **restricted token to the VM per booking** — client_secret stays **off-VM** (Vercel/backend), mirroring the `X402_PROXY_SECRET` / "platform manages restricted-key minting" pattern in the frontier SKILL.md. Per Rule 49, the client_secret gets a partner-secret verifier.

Everything else in §4 holds. The x402 payer rail is unchanged in concept; it just runs *after* the token is attached. **Open question carried forward:** under `client_credentials`, are bookings owned by the single InstaClaw client identity (with the `customer` object as the real guest + email-OTP for manage/cancel)? Almost certainly yes — confirm when we first mint a token and read the 402.

### 12.4 STOP — what I did NOT do, and why

I stopped at the OAuth wall. Registering an InstaClaw OAuth client (`/oauth/register`) is a **state-creating action on a third party** and ties to your flagged "Travala account/KYC" action — not a unilateral read-only probe. Per ruling 6's spirit (a probe finding that reroutes the design = STOP-and-tell), I report rather than proceed. **To finish P0 (read the real 402 `accepts[]`) we need a `mcp:book` token, which needs the client registration — your call.**

### 12.5 Revised sizing for P0

- **P0a — OAuth client provisioning (Cooper action / decision):** register the InstaClaw confidential client via DCR; decide single-platform-client vs per-user. Surfaces the account/KYC answer. ~0.5 day once greenlit.
- **P0b — token + read the 402 (read-only, no pay):** mint `mcp:book` via client_credentials, retry `travala_book`, dump `accepts[]` (scheme/network/asset/payTo), decide bridge shape (e1), and finally answer scheme-compat (e2). ~0.5 day.
- Then P1 (frontier travel category) + P2 (skill+bridge+OAuth token plumbing+kill switch) + P3 (canary e2e) as before. Note P2 now also includes the OAuth token-minting backend piece.

### 12.6 P0a + P0b RESULTS — 🟢 GREEN. EIP-3009 / exact / Base / USDC confirmed. Build queue unlocked.

**P0a — OAuth client registered (DCR, self-service, no KYC/ToS gate):** `POST /oauth/register` → 201. `client_id=mcpd_a391f260c2399f8063a7c590`, scopes **`mcp:read mcp:book`** (no `mcp:cancel`), grant `client_credentials`, `client_secret_basic`, `client_secret_expires_at:0` (non-expiring → rotation policy needed). DCR required a non-empty `redirect_uris` even for client_credentials (used `https://instaclaw.io/oauth/travala/callback`, unused by the grant). **Contact corrected (2026-06-10):** re-registered with `help@instaclaw.io`. ⚠️ Travala DCR returns `contacts:None` for every client (the field isn't echoed) — **server-side persistence of the contact is unverifiable from the API.** **Active client_id: `mcpd_8fdb46b578356430a3ad0553`**; Vercel-prod `TRAVALA_OAUTH_CLIENT_ID/SECRET` overwritten with it; token mint re-confirmed. Old client `mcpd_a391f260c2399f8063a7c590` is **orphaned-but-inert** — Travala issued no RFC 7592 management token (`registration_access_token`/`registration_client_uri` absent), so it cannot be deleted; we stopped using it.

**Secret handling (ruling 2 satisfied):** `TRAVALA_OAUTH_CLIENT_ID` + `TRAVALA_OAUTH_CLIENT_SECRET` stored in **Vercel `instaclaw` project, Production** (verified via `vercel env ls production`), via stdin/`printf` (no argv, no trailing newline, Rule 6). **Never on a VM.** Local temp copies shredded. Open items: (i) **preview env** add didn't take via CLI — re-add in P2; (ii) **Rule 49 partner-secret verifier** for `TRAVALA_OAUTH_CLIENT_SECRET` — TODO in P2 (`lib/partner-secrets.ts`).

**P0b — token minted + real 402 read (read-only, zero spend):** `client_credentials` → `Bearer`, `scope=mcp:read mcp:book`, `expires_in=3600`. Authenticated `travala_book` cleared the OAuth wall and returned the 402. Verbatim `paymentRequirements[0]`:

```
scheme:            "exact"                                          ← x402 exact = EIP-3009 transferWithAuthorization
network:           "eip155:8453"                                    ← Base MAINNET
asset:             "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"     ← canonical Circle USDC on Base
extra:             { name: "USD Coin", version: "2" }               ← EIP-712 domain (name/version) for the typed data
payTo:             "0x0617973b64A7cEE9d9a0D66C53f1aecc312BB3ff"      ← Travala receiver
maxAmountRequired: "370630000"                                       ← 370.63 USDC (6dp); slightly > displayed $370.58 (~$0.05 fee)
maxTimeoutSeconds: 300                                               ← EIP-3009 validBefore window
```

**Every field maps 1:1 to `frontier-spend-core.mjs`** (`selectPaymentRequirement` → `buildAuthorization({to:payTo, amountAtomic:maxAmountRequired, maxTimeoutSeconds})` → `buildTransferTypedData({asset, name:extra.name, version:extra.version})` → Bankr `/wallet/sign`). **Scheme-compat (e2) RESOLVED GREEN.** ERC-7715 confirmed = consumer-only layer, absent from the machine payer path.

**Fork (e1) RESOLVED by the data:** the 402's `next_action` directs payment to a **direct HTTP POST** — `baseURL:"https://payment-mcp.travala.com"`, `path:"/m2m-payment/book"`, `method:"POST"`, `body:{package_id, session_id, contact}` — i.e. a **plain-HTTP x402 endpoint** our rail handles natively. The OAuth-gated MCP `travala_book` is used only to *obtain* the 402+next_action; the pay leg is plain HTTP. **Booking-ownership (P0b-4a) confirmed:** caller = the InstaClaw OAuth client; guest = the `contact` object → single-platform-identity model.

**Wrinkles to handle in the bridge (P2):** (i) `resource` field comes back malformed as `"undefined/m2m-payment/book"` (Travala server bug) — construct the resource from `baseURL+path` in the X-PAYMENT envelope, don't trust their value; (ii) the agent must authorize against `maxAmountRequired` (370.63), **not** the displayed price (370.58) — the gate amount is the on-chain amount; (iii) **RESOLVED 2026-06-10 (doc research, no longer a canary detail):** the `payment-mcp.travala.com/m2m-payment/book` pay POST is authorized by the **X-PAYMENT header ALONE — no OAuth Bearer.** See §16.

**Testnet dress-rehearsal lane (P0b-4b) — UNKNOWN / not available on our client.** The live 402 is `eip155:8453` (mainnet) and the description forbids testnet references for this client/env. The tool text mentions "Base Sepolia testnet when in test environments," but our DCR client returned mainnet-only. **Open P3 item:** find a testnet path (separate test endpoint / client / flag) for a no-real-dollar dress rehearsal, OR accept a small real-USDC mainnet first booking as the canary. Cooper to weigh.

**BUILD QUEUE (officially unlocked per ruling 5, still STOPPED pending the frontier dependency + Cooper go):**
1. **Frontier travel category** (§6 diff — frontier terminal). *Blocking gate for any booking.*
2. **P2** — `travala` skill + 402→`frontier-spend` bridge + OAuth token plumbing (backend mints restricted `mcp:book` token, hands to VM per booking) + fail-closed `travala_booking_enabled` kill switch + Rule 49 verifier + coverage.
3. **P3** — canary on **vm-1043** (funded Bankr USDC wallet; testnet lane TBD).

## 13. Decision log

- **2026-06-10**: Drafted post-Phase-1 (5 contradictions corrected) + Phase-2 (Travala primary-source research). Recommended shape: frontier-mediated `travala` skill on the proven Bankr x402 payer rail, consent-always, fail-closed kill switch. Mandatory dependency: frontier travel-category policy (§6).
- **2026-06-10 (rulings)**: fork (a) GO $1200/$3000/$0/`travel`, **opt-in**; (b) keep both StableTravel legs; (c) canary vm-1043; (e1) bridge shape probe-decided; (e3) defer 8004scan.
- **2026-06-10 (P0 probe)**: **Booking is OAuth-2.1-gated (Bearer before 402) — NEW blocker upstream of the payment scheme.** Mitigant: `client_credentials` grant supported → headless machine path exists (not the v1.5 reroute). Payment USDC/Base/Coinbase + consent-always confirmed from primary tool text. Scheme-compat (EIP-3009 vs ERC-7715) still unread, behind the token. STOPPED at the OAuth wall (registering a client is a Cooper-action). Design gains an OAuth pre-leg [3.5]; rest holds. Build remains stopped.
- **2026-06-10 (P0a/P0b, Cooper-greenlit)**: Registered InstaClaw DCR client (mcp:read+book, no KYC gate); secret stored in Vercel Production only. Minted `client_credentials` token, read the live `travala_book` 402: **`exact`/`eip155:8453`/USDC `0x8335…2913` — maps 1:1 to the proven Bankr payer rail. GREEN.** Pay leg = direct HTTP POST to `payment-mcp.travala.com/m2m-payment/book` (fork e1 resolved). Build queue unlocked (frontier travel category → P2 skill+bridge → P3 vm-1043 canary); build still STOPPED pending the frontier dependency + Cooper go. Zero spend; local secrets shredded.
- **2026-06-10 (contact fix)**: Re-registered client with `help@instaclaw.io` (active `mcpd_8fdb46b578356430a3ad0553`); old `mcpd_a391f260…` orphaned-inert (no RFC 7592 mgmt token). Vercel prod creds overwritten. Travala DCR doesn't echo `contacts` — persistence unverifiable. Testnet lane abandoned per ruling 3; P3 = a small (<$100) **refundable** real-mainnet booking. Sequencing: build stays stopped until frontier's `human_approved` smoke test is green, then Cooper greenlights the travel-category diff, then P2 starts. P2 breakdown written below (§14) to start hot.
- **2026-06-10 (P2-complete)**: Built all non-authorize P2 items + stubbed D against the (then-believed) ceiling-gated contract. 13 files, tsc clean, 28/28 tests.
- **2026-06-10 (P2-complete-v2, post-rebase)**: Cooper caught a Rule-12 staleness — the branch (off `4db1a85b`) was two frontier ships behind. Rebased onto current `origin/main`; both `f8b79d9e` (ceiling live) and `d1577583` (F2 travel session-required) are now on the branch. Read the SHIPPED `frontier-authz.decideAuthorization` + authorize route: travel sets `disallowForgeableApproval` → the forgeable `human_approved` bool is sealed; `ask_first` mints an `approval_url` (single-use, 15-min TTL, identity-bound); re-authorize same `request_id` after the dashboard tap → `human_approved_session`. **Reworked D** in `travala-book.mjs` step 3 to that loop (bounded in-turn poll + `awaiting_approval` resume + re-mint-on-expiry + hard-deny path), updated SKILL.md / references / card-copy framing ("you approve from your dashboard — one tap"), and added 11 `decideAuthorization` contract tests (39/39). The forgeable consent is gone; the dashboard tap is the only travel consent. STOPPED at P2-complete-v2; P3 canary still a separate Cooper go.

---

## 14. P2 build-hot task breakdown (write-ahead; build starts the moment the frontier travel category lands)

**Owner**: this terminal. **Precondition**: frontier travel category live (§6) + Cooper go. **Standing rules**: source/manifest only, never on-disk edits (Rule 47); secrets off-VM (Rule 49); verify-after-write (Rule 10); sentinels (Rule 23); coverage (Rule 27); failure-mode tests (Rule 31).

### §14 — P2 BUILD STATUS (2026-06-10, branch `feat/travala-x402-booking`, **rebased onto current `origin/main`**)

All items BUILT on the feature branch (unmerged → nothing on the fleet; "build-not-deploy" satisfied by not merging + not bumping the manifest version). `npx tsc --noEmit` clean; `scripts/_test-travala-failure-modes.ts` **39/39 pass**.

**P2-complete-v2 (post-rebase rework, 2026-06-10).** The branch was forked at `4db1a85b`; frontier shipped TWICE while P2 built, so the branch was rebased onto current `origin/main` and D reworked:
- **§6 ceiling is LIVE** (`f8b79d9e`, live-probed $100→ask_first / $1300→deny). The "ceiling-gated" framing is **dead** — D's authorize path is exercisable now.
- **Travel is SESSION-REQUIRED** (`d1577583`, red-team F2): the forgeable `human_approved` bool NEVER authorizes a travel spend, at any amount. D was wired to that sealed path; it is **reworked** to the real contract: authorize → `ask_first`/`needs_session_approval` + `approval_url` → user taps in their dashboard → re-authorize same `request_id` → `human_approved_session` → pay. Single-use, 15-min TTL, re-mint-on-expiry, identity-bound. This is the better product — the card copy ("you approve it") is now literally unforgeable.

| Item | Status | Where |
|---|---|---|
| A — skill + references + routing | **BUILT** | `instaclaw/skills/travala/SKILL.md` + `references/booking-flow.md`; routing row in `lib/workspace-templates-v2.ts` |
| B — search wrapper (HTTP-in-wrapper, no native auto-pay tool) | **BUILT** | `skills/travala/scripts/travala-search.mjs` → backend `search-hotel`/`search-package` |
| C — 402→frontier-spend bridge (backend mints token, VM signs) | **BUILT** | `app/api/travala/[op]/route.ts` + `lib/travala-mcp.ts` (OAuth mint + MCP + 402 extract) + `skills/travala/scripts/travala-book.mjs`. Both P0 wrinkles handled: resource rebuilt from baseURL+path; amount = `maxAmountRequired` |
| D — frontier authorize (`category:"travel"`, **session-required consent**) | **BUILT (reworked for F2)** | `travala-book.mjs` step 3 — authorize → `ask_first`/`needs_session_approval` + `approval_url`; bounded ~75s in-turn poll catches a fast tap, else exits `awaiting_approval` for the agent to resume via `--retry --request-id`; re-authorize after the dashboard tap → `human_approved_session` → pay. Hard deny (over §6 ceiling) reported, can't override. The contract is locked by 11 `decideAuthorization` tests. `human_approved` is sent `false` (sealed for travel) |
| E — `TRAVALA_OAUTH_CLIENT_SECRET` Rule 49 verifier + rotation note | **BUILT** | `lib/partner-secrets.ts:verifyTravalaOAuthClientSecret` (shape + live mint) + registry entry; rotation runbook in the docblock. Preview-env re-add = operator action (noted) |
| F — kill switch (fail-closed) | **BUILT** | `lib/travala-kill-switch.ts` — per-VM `travala_booking_enabled` (fail-CLOSED) + global `travala_booking_kill_switch` (fail-OPEN emergency stop). Both checked in `book-quote`. **Correction to original §14-F**: the per-VM toggle is the `instaclaw_vms.travala_booking_enabled` COLUMN (the card switch), not an `instaclaw_admin_settings` row; the admin-settings row is the separate global kill |
| G — confirmation + recovery (book-status before retry) | **BUILT** | `travala-book.mjs` `--retry` calls backend `book-status` first; won't re-pay a confirmed booking |
| H — settle/ledger | **BUILT** (reuses existing) | `travala-book.mjs` step 5 → existing `/api/agent-economy/settle`; no new settle route |
| I — coverage + failure-mode tests | **BUILT** | `scripts/_coverage-travala.ts` (Rule 27) + `scripts/_test-travala-failure-modes.ts` (**39/39 pass** — incl. 11 F2 session-approval contract tests + malformed-resource/amount-discipline/shape-drift/gate/verifier) |
| J — Travel Agent card | **BUILT-NOT-WIRED** | `components/dashboard/travel-agent-skill-card.tsx` + session-authed `app/api/skills/travala-booking/route.ts`. Card is NOT added to the skills grid — wiring it is the P3 deploy action. Starter = greyed + upgrade CTA (Cooper's lean, justified in the component docblock) |

**DB dependency**: `instaclaw_vms.travala_booking_enabled` column — migration written to `supabase/pending_migrations/20260610190000_vm_travala_booking_enabled.sql` (Rule 56: stays there until Cooper applies to prod via Studio, THEN git-mv to `migrations/`). Fail-closed `DEFAULT false`.

**Plumbing**: `/api/travala` added to `middleware.ts:selfAuthAPIs` (Rule 13). Travala script entries added to `vm-manifest.ts:extraSkillFiles` — **manifest version deliberately NOT bumped** (fleet deploy gated on Cooper approval + the frontier ceiling per Rule 64).

**Canary-VM setup (P2 deliverable, FLAGGED to Cooper — his action)**: vm-1043 needs (1) `frontier_spend_enabled=true` (DB flag), (2) `travala_booking_enabled=true` (after the column migration applies), (3) a **funded Bankr USDC wallet on Base** — funding is real money, Cooper's to move, and (4) Cooper logged into the dashboard in a browser to tap the approval link (the booking now genuinely needs a session tap — there's no autonomous path for travel). The ceiling is live, so a funded under-ceiling booking will authorize-on-tap at P3.

**A — `travala` skill (`instaclaw/skills/travala/`).** Static-extracted (Rule 24): `SKILL.md` + `references/`. Teaches: discover via search → present summary + Travala's verbatim consent text → book ONLY via the frontier-mediated path (Rule 0: never call an auto-pay tool, never sign manually). `requiredSentinels` on the wrapper. Routing block into `lib/workspace-templates-v2.ts`: *StableTravel plans, Travala books* (both StableTravel legs stay, ruling b).

**B — search wiring (free, public).** `travala_search_hotel`/`travala_search_package` are `mcp:read`/public (no token). Sub-decision to settle in P2: MCP-wire them (`mcp.servers.travala` http) vs call via HTTP in the wrapper. Lean: HTTP-in-wrapper, so the agent never has a native `travala_book` tool that could auto-pay around the gate.

**C — the 402→frontier-spend bridge (core).** Recommended split that keeps the OAuth token **fully backend-side**:
  - **Backend** (`/api/travala/*`, self-auth like the x402 proxy): reads `TRAVALA_OAUTH_CLIENT_*` from Vercel, mints a short-lived `mcp:book` token via `client_credentials`, calls MCP `travala_book` to obtain the **402 `next_action`**, returns `{baseURL, path, method, body, paymentRequirements}` to the VM. **Token never touches the VM.**
  - **VM (frontier.spend)**: consume `paymentRequirements[0]` → `buildAuthorization({to:payTo, amountAtomic:maxAmountRequired, maxTimeoutSeconds})` → `buildTransferTypedData({asset, name:extra.name, version:extra.version})` → Bankr `/wallet/sign` → POST X-PAYMENT to `baseURL+path` (`payment-mcp.travala.com/m2m-payment/book`) with `next_action.body`.
  - **Resource-field workaround**: build the X-PAYMENT envelope `resource` from `baseURL+path`, NOT Travala's malformed `"undefined/m2m-payment/book"`.
  - **Amount discipline**: authorize + sign against `maxAmountRequired` (370630000 = $370.63), NOT the display price ($370.58). The frontier gate amount = the on-chain amount.

**D — frontier authorize integration (consent-always).** Book path calls `/api/agent-economy/authorize` with `category:"travel"`, `amount_usd` = maxAmountRequired-in-USD, `requireVerifiedCounterparty:false` (merchant, per `frontier-policy.ts:95-96`), proceeds only on `human_approved` via the shipped suggest/confirm surface. No parallel consent path.

**E — token plumbing + secret (Rule 49 + rotation).** Add a `TRAVALA_OAUTH_CLIENT_SECRET` verifier to `lib/partner-secrets.ts`: shape check + a live `client_credentials` mint smoke test (expect 200 Bearer w/ `mcp:book`). **Rotation note in the runbook**: the secret is non-expiring; rotation = re-register a fresh client → overwrite Vercel prod (stdin) → abandon old (the exact procedure executed 2026-06-10). Re-add the **preview** env var here (didn't take via CLI in P0).

**F — kill switch (fail-closed, day one).** New `instaclaw_admin_settings.travala_booking_enabled` (absent/false ⇒ disabled). The book wrapper checks it before paying; the global `frontier_spend_kill_switch` (fail-open emergency stop) already covers the spend via authorize. Both must pass.

**G — confirmation + recovery.** On pay success → format Travala booking ref/dates/cancel-policy to the user. On failure/timeout → `travala_book_status` (read-only recovery, same packageId/sessionId) BEFORE any retry, to avoid double-charge.

**H — settle/ledger.** After pay → `/api/agent-economy/settle` (hold→settled, tx_hash). Cancellation/refund mapping deferred (we did NOT request `mcp:cancel`; the manage/cancel leg is a later phase — §9).

**I — coverage + tests.** `scripts/_coverage-travala.ts` (Rule 27): sampled VMs have the skill + routing + kill-switch read path. Failure-mode tests (Rule 31): amount display-vs-maxAmountRequired mismatch, kill-switch-off, privacy-mode, token-mint-fail, malformed `resource`, 402-shape drift.

## 15a. ✅ P2 BLOCKER RESOLVED (2026-06-10) — ceiling shipped + travel made session-required

The 2026-06-10 blocker (travel category shipped without its ceiling) is **closed**. The branch was forked at `4db1a85b`; frontier then shipped the ceiling (`f8b79d9e`) and, separately, the F2 session-required hardening (`d1577583`) — both verified by re-reading the SHIPPED `frontier-authz.ts` / authorize route after rebasing the branch onto current `origin/main`:
- **Ceiling LIVE** — live-probed $100 travel → `ask_first`, $1300 → `deny`. The booking lane authorizes under the per-tx ceiling and hard-denies above it.
- **Travel SESSION-REQUIRED** — `decideAuthorization` sets `disallowForgeableApproval` for travel, so the forgeable `human_approved` bool returns `ask_first`/`needs_session_approval` at any amount; only a matching `instaclaw_frontier_spend_approvals` row (the dashboard tap, 15-min TTL, single-use, identity-bound) flips it to `human_approved_session`. The catch Cooper flagged was correct: my first D wired the sealed forgeable path. **D is reworked** to the session-approval loop (§14 P2-complete-v2). The new failure-mode tests (11 `decideAuthorization` contract assertions) lock the behavior so a future frontier change to the travel contract trips them.

## 15. P3 canary constraints (ruling 3)

- VM = **vm-1043**; needs a Bankr wallet **funded with real USDC on Base mainnet**.
- First booking = **smallest REFUNDABLE package, hard ceiling $100.** Refundable is mandatory (cancel-to-recover is the safety net). **If no refundable inventory under $100 exists, STOP and report the floor to Cooper.**
- (The pay-leg auth unknown is NO LONGER a canary dependency — resolved by doc research 2026-06-10, see §16. The canary now confirms the END-TO-END flow, not the auth contract.)
- This single booking is both the dress rehearsal and the e2e proof (no separate testnet lane — ruling 3).

## 16. RESOLVED — pay-leg auth contract (doc research, 2026-06-10)

**The question:** does the pay POST to `payment-mcp.travala.com/m2m-payment/book` require an `Authorization: Bearer` (the OAuth `mcp:book` token), or is the x402 `X-PAYMENT` header alone sufficient?

**The answer (CONFIRMED): X-PAYMENT alone. No Bearer on the pay leg.** The two auth points are distinct and must not be conflated:
- **Quote/read step (OAuth Bearer required — already proven):** the `travala_book` MCP tool on `travel-mcp.travala.com` is OAuth-gated (`mcp:book` scope). This produces the 402 + `next_action`.
- **Pay step (X-PAYMENT only — now confirmed):** the POST to `payment-mcp.travala.com/m2m-payment/book` carrying the signed EIP-3009 `X-PAYMENT` is a standard x402 settlement. The payment header IS the authorization; no Bearer/API key.

**Evidence (primary sources, 2026-06-10):**
- **x402 protocol (Stripe x402 docs, a primary implementer):** *"the payment header itself is the sole authorization mechanism for x402 endpoints. The paid request uses the payment header to authenticate access, not an Authorization Bearer token or API key."* Corroborated by the Coinbase x402 spec (`github.com/coinbase/x402` — paid retry carries `PAYMENT-SIGNATURE`/`X-PAYMENT`; endpoints require "no accounts, subscriptions, or API keys by default") and the x402-mcp / `@coinbase/payments-mcp` pattern (the wrapper "sends the request with the `PAYMENT-SIGNATURE` header" — no Bearer added).
- **Travala-specific (Travala's own repo, `github.com/travala/travel-mcp`, updated 2026-06-02):** `travala_book` returns x402 payment instructions and **"requires the `@coinbase/payments-mcp` MCP installed to handle the HTTP 402 response."** Travala delegates the entire pay step to Coinbase's standard payments-mcp client, which is X-PAYMENT-only. **If the pay endpoint required OAuth, Travala's own documented flow (use @coinbase/payments-mcp) could not work** — this self-consistency is the clincher.

**Honest caveat (proven-vs-assuming):** Travala's public README does not contain a single literal sentence about the `m2m-payment/book` URL's headers (it's a runtime `next_action` target, not separately documented). The confirmation rests on (a) the x402 protocol mandating payment-header-only auth, and (b) Travala documenting that the pay step uses the standard X-PAYMENT-only Coinbase client. That is a strong, self-consistent, documented contract — NOT "the docs are silent." Confidence: **high.**

**Code impact:** `travala-book.mjs` step 4 now codes the one real contract — POST the dual `PAYMENT-SIGNATURE`/`X-PAYMENT` headers (x402-canonical, both names), **no Bearer**. The prior defensive `payment_endpoint_requires_auth` 401 special-case + "route through the backend" fork is **removed**; a 401 is now a normal `pay_http_401` error (and would be an unexpected protocol violation, not a "needs a Bearer" signal). The references error-table row is updated accordingly.
