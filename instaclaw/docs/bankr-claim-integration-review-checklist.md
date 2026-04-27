# Bankr Claim API — Integration Review Checklist

**Draft:** 2026-04-22 (pre-docs).
**Reviewed:** 2026-04-24 — populated against live docs at
https://docs.bankr.bot/token-launching/api-reference/claim-token-launch-fees
and associated pages (`claiming-fees`, `partnership/api-keys`,
`wallet-api/overview`, `partnership/api-reference/generate-api-key`,
`token-launching/api-reference/overview`).
**Re-reviewed:** 2026-04-27 — Sinaver pinged on 2026-04-24 saying
"changes should be live, docs updated too" + "you should be able to
enable gas sponsorship in the dashboard, and integrate the direct claim
api". Re-fetched docs (claim endpoint, claiming-fees, partnership/api-keys,
api-reference/overview, wallet-api/overview, wallet-api/sign,
wallet-api/submit, get-token-fees, /cli, npm) to see what new info
landed. Answers + remaining gaps in updated section J.

---

## TL;DR for Cooper (read this first)

**Five findings reshape the integration plan:**

1. **The new endpoint is user-key auth, not partner-key.** `POST /token-launches/:tokenAddress/fees/claim` accepts `Authorization: Bearer <bk_usr_*>` or `X-API-Key: <bk_usr_*>`, NOT our `X-Partner-Key` header. Every VM already has a `bk_usr_*` key from `provisionBankrWallet()`. The partner key we were planning around is irrelevant for claims.

2. **Gas sponsorship is automatic, not a toggle.** The "API authenticated" path is sponsored by Bankr. No `sponsorGas: true` flag. No partner-funded gas budget we have to top up. Cap is **10 sponsored transactions per wallet per day** across all sponsored paths (web UI + API + `bankr fees claim` CLI share the cap).

3. **Response is synchronous.** `{transactionHash, status, signer, chainId, description}` returned in one call. No async job, no claimId polling, no webhook. Our earlier assumption of a relayer queue was wrong.

4. **The prior two-call flow is already deprecated.** `/user/doppler/claim`, `/user/doppler/execute-claim`, `/clanker/claim`, `/agent/doppler/claim` all emit `Deprecation` and `Sunset` response headers. Our current `@bankr/cli@0.2.15` almost certainly uses one of these under the hood. **A CLI version bump is the minimum required action** — otherwise claims break at Bankr's sunset date.

5. **We may already be getting gas sponsorship today.** Our VMs run `bankr fees claim` which is explicitly documented as the sponsored path. If the CLI targets the new endpoint after a version bump, zero application-code changes are needed. Our `CLAIM_WALLET_UNFUNDED` copy in `lib/bankr-messages.ts` is likely obsolete (no pre-funding needed) for the default path.

**Biggest remaining unknown:** which `@bankr/cli` version targets the new endpoint. Needs a Sinaver ping or CLI changelog read.

**Proposed PR shape (minimal, below):** CLI version bump + reconciler push + deprecate the "fund wallet first" message. ~20 lines changed. No new helper needed. **No `lib/bankr-claim.ts`.** Detailed rationale in section "Integration proposal" at the bottom.

---

## What we knew before docs landed (baseline — unchanged)

- Partner key format: `bk_ptr_...`. Used for wallet provisioning via
  `x-partner-key` header in `lib/bankr-provision.ts`.
- Per-user API keys from `POST /partner/wallets` come back as `bk_usr_...`,
  stored on each VM and used by `@bankr/cli`.
- VM-side claim flow: user says "claim my fees" in chat → agent runs
  `bankr fees claim --yes` → CLI authenticates with `bk_usr_*`.
- Empirical proof from prior session: CLI + prod-org + pre-funded ETH via
  `POST /partner/wallets/:id/fund` → claim yielded WETH. $CLITEST test,
  tx `0x905c81bf...`.
- Existing call sites:
  - `instaclaw/lib/bankr-provision.ts` — `provisionBankrWallet()`
  - `instaclaw/lib/bankr-wallet-lifecycle.ts` — suspend/resume/close
  - `instaclaw/lib/ssh.ts` — `BANKR_CLI_PINNED_VERSION = "0.2.15"` +
    CLI install block in `configureOpenClaw`
  - `instaclaw/lib/bankr-messages.ts` — `CLAIM_WALLET_UNFUNDED` string

---

## A. Endpoints & methods

| # | Question | Expected (our guess) | Observed | Surprise? |
|---|---|---|---|---|
| A1 | Claim endpoint path? | `POST /partner/wallets/:id/claim` | **`POST /token-launches/:tokenAddress/fees/claim`** (path is token-address-centric, wallet identified implicitly via the user key) | **YES** — we guessed wallet-ID style, reality is token-address style |
| A2 | Separate endpoint for "claim + sponsor gas" vs plain claim? | Single endpoint with `sponsorGas: true` flag | **No toggle.** Two DIFFERENT endpoints: sponsored path = `POST /token-launches/:tokenAddress/fees/claim` (auto-sponsored); self-signed path = `POST /public/doppler/build-claim` (user pays gas, returns unsigned tx for external signers) | **YES** — dichotomy not a flag |
| A3 | Does it replace the CLI, or layer beneath it? | New API layer; CLI updates | **Both co-exist.** `bankr fees claim` (CLI) and the HTTP endpoint are peers; both hit the sponsored path. `bankr fees claim-wallet` is the CLI command for the self-signed path | As expected (partial) |
| A4 | Async status / poll endpoint? | Yes — `GET /partner/claims/:claimId` | **No.** Response is synchronous: `{transactionHash, status, signer, chainId, description}` returned in one call | **YES** — sync, not async |
| A5 | Read-side endpoint for list-claimable / preview? | Yes — `GET /partner/wallets/:id/claimable` | **Yes, but shape differs:** `GET /token-launches/:tokenAddress/fees` — unauthenticated, per-token, returns "Per-token claimable + claimed fees". Caller loops over their tokens to enumerate | Shape surprise: token-centric, not wallet-centric |

## B. Authentication

| # | Question | Expected | Observed | Surprise? |
|---|---|---|---|---|
| B1 | Same `x-partner-key` header as existing endpoints? | Yes | **No.** `Authorization: Bearer <bk_usr_*>` OR `X-API-Key: <bk_usr_*>`. Partner key explicitly excluded from Bearer per docs. | **YES** — biggest architectural surprise |
| B2 | New scope / permission bit required? | `claim_enabled` or similar | **`walletApiEnabled` on the user key, AND `walletApi` capability on the partner org.** Org-level capability is config'd by Bankr team ("configured via Bankr team"), not self-serve | **YES** — two-level gating, org-level dependency on Sinaver |
| B3 | Does per-user `bk_usr_*` accept the new endpoint? | Partner-only | **User-key ONLY.** Partner key is documented as *not supported* on Bearer auth | **YES** — inverse of our guess |
| B4 | IP allowlist requirements? | Same as today — per-key `allowedIps` | Same pattern: `allowedIps` on the user key. Supports individual IPs + CIDR (`/24` minimum for IPv4). IPv6-mapped IPv4 auto-normalized. Mismatch → 403 "IP address not allowed for this partner API key" | As expected |

## C. Request shape

| # | Question | Expected | Observed | Surprise? |
|---|---|---|---|---|
| C1 | What identifies the wallet? | `walletId` in body | **Implicit via auth key.** No wallet identifier in request. The `bk_usr_*` key IS scoped to one wallet (docs: "scoped to a single provisioned wallet") | **YES** — auth-implicit |
| C2 | How is the token specified? | `tokenAddress` in body OR `tokenAddresses: []` batch | **Single `:tokenAddress` in URL path.** No batch. | **YES** — no batch support |
| C3 | Is amount specified or always "all claimable"? | Always all | All claimable per the claim (matches) — but no body params to override | As expected |
| C4 | Beneficiary routing — different EOA? | No | **Confirmed no.** Only the "current fee beneficiary" can claim, to their own wallet. Beneficiary can be transferred separately; that's a different operation | As expected |
| C5 | Idempotency key? | 24h window, header or body | **NOT DOCUMENTED anywhere.** No `Idempotency-Key` header mentioned, no body field. On-chain tx inherently provides "don't double-spend" but client-side retry safety is undocumented | **YES** — gap, see section F |
| C6 | Gas sponsorship toggle shape? | `sponsorGas: true` | **No toggle. Sponsored implicitly on this endpoint.** See section G | **YES** — no toggle |

**Observed request body per the docs' curl example:** `-d '{}'` (empty JSON object). No body fields documented at all.

## D. Response shape — success

| # | Question | Expected | Observed | Surprise? |
|---|---|---|---|---|
| D1 | Sync or async? | Async | **Synchronous.** Per docs: "Signs and broadcasts the transaction server-side and returns the final receipt in one call" | **YES** |
| D2 | Success response top-level keys? | `{claimId, status, estimatedConfirmationTime, sponsored}` | **`{transactionHash, status, signer, chainId, description}`** per verbatim curl example | **YES** — shape differs |
| D3 | claimId → txHash mapping? | `GET /partner/claims/:claimId` | **N/A** — tx hash is returned directly. No claimId concept | As expected given D1 |
| D4 | What does response say about amounts claimed? | Per-position array `[{tokenAddress, amount, symbol}]` | **NOT DOCUMENTED on the claim endpoint response.** Per-token amounts live on `GET /token-launches/:tokenAddress/fees` (claimable + claimed). Post-claim reconciliation requires a follow-up GET | **YES** — partial info |
| D5 | Unwrap-to-ETH option? | WETH only, user unwraps | **Confirmed WETH.** Fees arrive as WETH + the token itself, accumulated in the Uniswap V4 liquidity pool and claimed together. No auto-unwrap. Matches Pattern B from prior session | As expected |

## E. Error surfaces

| # | Question | Expected | Observed | Surprise? |
|---|---|---|---|---|
| E1 | HTTP codes documented? | 404 / 409 / 402 / 403 | **200 / 400 / 401 / 403 / 404 documented.** 400 = "malformed token address or upstream submission failed". 401 = "Missing or invalid authentication". 403 = "Caller is not permitted to claim fees for this token" (not the fee beneficiary). 404 = "Token was not launched via Bankr". | Partial surprise — 402/409/429 NOT documented |
| E2 | 409 "already claimed" semantics? | Idempotency replay | **Not explicitly documented.** "Already claimed" covered as "fees might have already been claimed" under the troubleshooting 400 bucket. Behavior on a second POST — unclear | **YES** — gap |
| E3 | Rate limits? | ~100/min partner burst | **NOT DOCUMENTED.** No per-key, per-wallet, per-partner, or per-endpoint limits on any page I read | **YES** — major gap |
| E4 | Error shape when sponsorship budget exhausted? | 402 Payment Required `{code: "gas_budget_exhausted"}` | **NOT DOCUMENTED.** 10 tx/day/wallet cap is mentioned in concepts doc but no error body shape for hitting it. Might fall through to a 400 or silently switch to user-funded — undetermined | **YES** — launch-blocking gap, see surprises below |
| E5 | `Retry-After` header on 429/402? | Yes | **NOT DOCUMENTED.** | Unknown |

**Observed common error body shape:** not documented on any page. The only shown response shape is the success case.

## F. Idempotency

| # | Question | Expected | Observed | Surprise? |
|---|---|---|---|---|
| F1 | Required, optional, or unsupported? | Optional, recommended | **Unsupported / undocumented.** Neither the claim endpoint nor any of the partnership/wallet-api pages document an `Idempotency-Key` header or body field | **YES** — gap |
| F2 | Key format? | ≤128 chars string | N/A | — |
| F3 | Collision behavior? | 409 | N/A | — |
| F4 | Call-site key pattern? | `instaclaw_claim_${walletId}_${epochHour}` | Not applicable — no key to send. **Retry safety relies on on-chain semantics** (claiming an already-claimed position either no-ops or 400s at the contract level). Risky for client-side retry | **YES** — retry story different than we planned |

**Retry implication:** no idempotency means a client retry after a transient timeout can submit a duplicate tx. Bankr likely guards server-side (no double-claim is possible on-chain anyway — the beneficiary gets whatever's claimable at claim-time, zero on the second call), but this isn't stated. We should retry ONLY on 5xx/network errors, NEVER on 4xx responses.

## G. Gas sponsorship economics

| # | Question | Expected | Observed | Surprise? |
|---|---|---|---|---|
| G1 | Who funds gas pool? | Separate `POST /partner/gas-budget/fund` | **Bankr platform funds it.** No partner-funded budget endpoint exists. It's a platform subsidy, not a partner-billed service | **YES** — simpler than expected |
| G2 | Per-call / per-user / per-day cap? | Per-partner daily USD cap | **10 sponsored transactions per wallet per day, across all sponsored paths** (web UI + API + CLI share the cap). No dollar cap. No per-partner aggregate cap documented | **YES** — per-wallet tx cap, not dollar |
| G3 | Observability of remaining budget? | `GET /partner/gas-budget` | **NOT DOCUMENTED.** No endpoint to query remaining sponsored-tx count today. User can only infer from "did my call 200 or 402" | **YES** — observability gap |
| G4 | Failure mode when budget exhausted? | 402 before submission | **NOT DOCUMENTED.** Unclear whether the endpoint errors, silently falls through to user-funded, or switches-to-402 | **YES** — gap (most important) |
| G5 | Markup / pricing? | Pass-through + fee | Not applicable — sponsored = free to partner. Implicit: Bankr absorbs 100% of sponsored gas costs. Base L2 is cheap enough that this is sustainable for Bankr | **YES** — simpler |

## H. Existing call-site integration

| # | Question | Expected integration shape | Observed (given new facts) | Surprise? |
|---|---|---|---|---|
| H1 | New helper `lib/bankr-claim.ts`? | Yes — `initiateClaim()` returning `{claimId, status} \| null` | **Probably NO.** The sponsored path is already reached via the CLI (`bankr fees claim`) which our VMs already run. Writing an HTTP helper duplicates the CLI's job unless we want a Vercel-side (non-VM) claim trigger for comp/admin use cases | **YES** — likely don't need it |
| H2 | Where do we call it from? | New chat intent or skill | **Nowhere new.** The existing chat path ("claim my fees" → agent → `bankr fees claim`) keeps working IF the CLI targets the new endpoint. No new surface | **YES** — scope shrinks |
| H3 | `@bankr/cli` version bump? | Yes — new CLI to target new API | **Yes, this is now the critical action.** Current pin: `0.2.15`. Need to confirm which CLI version uses the new endpoint and bump `BANKR_CLI_PINNED_VERSION`. Sinaver/CLI-changelog ping required | **YES** — THE central change |
| H4 | `CLAIM_WALLET_UNFUNDED` obsolete? | Yes — sponsored removes pre-funding | **Yes, for sponsored path (default).** The only time a user still needs ETH is the self-signed build-claim path (Safe/hardware wallets). Since our VMs use the sponsored CLI path, the message should be deleted or reworded for edge cases only | **YES — as guessed** |
| H5 | Suspended/closed wallet + claims? | Suspended: no; closed: no | **NOT DOCUMENTED for claim specifically.** Wallet lifecycle docs imply suspend blocks transfers — unclear if it blocks claims too. Safest assumption: same behavior | Mostly as expected |

## I. Surfaces that DID surprise us (updated list)

From the original "potential surprises," actual state:

- **✓ New partner key required:** NOT APPLICABLE. User key is what's used; partner key stays for provisioning only. No grandfathering question.
- **⚠ Breaking CLI change:** LIKELY. Current `0.2.15` probably targets a deprecated endpoint (one of the four on the sunset list). A CLI version exists that targets the new endpoint — need to identify it.
- **NEW: Walk-before-run unknowns:**
  - **Gas-cap exhaustion behavior unknown.** At 11th claim of a day, does the endpoint 402, succeed at user's expense, or fail silently? Could corner users who are active traders.
  - **No idempotency.** Client retries of transient timeouts can submit duplicate txs — likely safe on-chain (second call claims zero, no-op) but unverified.
  - **No rate-limit docs.** If Bankr has per-key or per-org limits, we'd hit them during fleet-wide probes and not know why.
  - **No webhook on claim completion.** Response says `status: "success"` but unclear if this is post-confirmation or just submission. If submission-only, we might celebrate a claim that reverts on-chain.
- **NOT A CONCERN (given sponsored-sync model):**
  - ~~Async relayer failure mode~~ — sync response, n/a
  - ~~Webhook signing secret~~ — no webhooks, n/a
  - ~~Bankr gas markup~~ — sponsored, n/a
- **STILL A CONCERN:**
  - **Token list restrictions for sponsorship.** Sponsorship may apply to Doppler/Clanker launches only (the two mentioned by the 404 "not launched via Bankr"). Tokens launched elsewhere would return 404 even if the user's wallet holds fees. Check: what if a user deploys via `bankr deploy` but gets a token that's not Bankr-registered?
  - **IP pinning on partner keys:** our Vercel IPs rotate. The `allowedIps` constraint on partner keys is enforced; we'd need to confirm our current allowlist still covers Vercel's egress.
  - **Org-level `walletApi` capability gating.** Confirmed as a real gate. Need Sinaver to confirm our org (`valtlabs` / `instaclaw`) has `walletApi` enabled.

## J. Pre-integration checklist — STATUS 2026-04-27

### Answered (or partially answered) by docs since last review:

- [~] **Q1: which `@bankr/cli` version targets the new claim endpoint?**
  - **Likely 0.3.1** — npm registry shows `@bankr/cli@0.3.1` published 2026-04-22, the same week Sinaver said the change is live. The 0.2 → 0.3 minor bump aligns with a breaking endpoint switch. Prior pinned version (0.2.15) was published 2026-04-19, before the new endpoint went live.
  - **Still need explicit Sinaver confirmation** that 0.3.1 is the version and that no 0.3.x patches are inbound that would change the target.
  - Lower-cost alternative: pin 0.3.1, canary it on one VM, verify `bankr fees claim` produces a tx hash against the new endpoint pattern. If it works, we're done; if it 404s on the old path, we know more.

- [✓] **Q2 (resolved): is `walletApi` capability enabled on our partner org?**
  - **The bankr.bot/api dashboard is the partner self-serve toggle.** `wallet-api/overview` page now reads: *"Enable Wallet & Agent API at [bankr.bot/api](https://bankr.bot/api)."*
  - This is what Sinaver was referring to in his "you should be able to enable gas sponsorship in the dashboard" message. Cooper just needs to log in to the dashboard with the partner account and confirm both **Wallet API** and (if separately listed) **Gas Sponsorship** are toggled on for our org.
  - **Action item for Cooper:** visit bankr.bot/api → confirm/enable.

- [~] **Q4: behavior on hitting the 10-tx/day sponsorship cap?**
  - **Still undocumented.** Re-read `claiming-fees` and the claim endpoint page; both quote the cap (*"Gas sponsorship covers up to 10 transactions per day per wallet across all sponsored paths"*) but neither documents the failure mode at the 11th call. Same gap as before.

- [✗] **Q3: did existing keys come with walletApiEnabled?** — Still not documented anywhere.
- [✗] **Q5: rate limits?** — Still not documented anywhere.
- [✗] **Q6: status="success" — confirmation or submission?** — Still ambiguous in docs ("submitted-tx receipt" vs "submitted and confirmed" in different places).
- [✗] **Q7: sunset date for deprecated endpoints?** — Still no concrete date documented.

### Code-side checks (unchanged):

- [ ] **Code:** `BANKR_CLI_PINNED_VERSION` bumped from `0.2.15` → `0.3.1`; `VM_MANIFEST.version` bumped to trigger reconciler.
- [ ] **Code:** canary test CLI upgrade on ONE VM, run `bankr fees claim --yes` against a test wallet with claimable fees, verify it 200s and yields a tx hash. THEN fleet roll.
- [ ] **Code:** `CLAIM_WALLET_UNFUNDED` deleted (or reworded for the rare self-signed `claim-wallet` edge case).
- [ ] **Decide:** Vercel-side admin claim endpoint? Still NO — out of scope unless we ever bulk-comp users from the dashboard.
- [ ] **Memory:** `project_bankr_partnership.md` is 25 days old. Refresh after this PR to capture: user-key auth (not partner-key), sponsored-default (no pre-fund), sync response, 10-tx/day cap, dashboard self-serve at bankr.bot/api, target endpoint `POST /token-launches/:tokenAddress/fees/claim`.

### Remaining hard blockers before merge:

1. Cooper logs into bankr.bot/api → confirms Wallet API + gas sponsorship enabled for our org.
2. Sinaver confirms (or we empirically verify on one VM) that `@bankr/cli@0.3.1` targets the new endpoint.
3. Q4 (cap exhaustion behavior) — useful to know for graceful agent messaging, but NOT a hard merge blocker. We can ship without it and add detection if/when we see it in prod.

Q3, Q5, Q6, Q7 are nice-to-have but don't block the CLI bump.

---

## Integration proposal — "PR Bankr-1 (minimal)" (updated 2026-04-27)

Given the facts above and the 2026-04-27 docs re-review, the integration is
**still ~20 lines** — the scope did NOT change with the new docs/dashboard
toggle. CLI bump remains the central action.

### Scope

1. **`lib/ssh.ts`** — bump `BANKR_CLI_PINNED_VERSION` from `"0.2.15"` to `"0.3.1"` (latest published, almost certainly the new-endpoint target — Sinaver to confirm or canary verifies).
2. **`lib/vm-manifest.ts`** — bump `VM_MANIFEST.version` so the reconciler re-runs `configureOpenClaw` across the fleet, which reinstalls `@bankr/cli` at the new pin.
3. **`lib/bankr-messages.ts`** — delete `CLAIM_WALLET_UNFUNDED` (or rework — it's a holdover from the pre-sponsorship assumption). Verify no other callers.
4. **Reconciler push** — staged: canary 1 VM → 20 → fleet. Each step: verify `bankr fees claim` still works end-to-end against a wallet with claimable fees.

### What about the new "direct claim API"?

Sinaver mentioned "integrate the direct claim api" alongside the dashboard.
The "direct claim API" IS the `POST /token-launches/:tokenAddress/fees/claim`
endpoint. We're already getting it for free via the CLI bump — the CLI talks
to it under the hood. **No separate `lib/bankr-claim.ts`, no Vercel endpoint,
no HTTP helper.** This was true before the docs update and remains true after.

The only reason we'd build an HTTP helper directly is if we wanted Vercel-side
admin claims (Cooper-initiated bulk claim across N user accounts). Still
deferred to a hypothetical phase-bankr-2.

### Order of operations (must do in this order)

1. **Cooper:** log into bankr.bot/api dashboard → confirm/enable Wallet API + gas sponsorship for our partner org. Capture screenshots for the PR description so we know the toggle was on at merge time.
2. **Sinaver:** confirm 0.3.1 is the target CLI version. If awkward to wait, skip and verify empirically in step 4.
3. **Code:** PR with the 3 file changes above + manifest bump.
4. **Canary:** push to 1 VM (Cooper's main bot or a known-claimable test wallet). Run `bankr fees claim` and verify it 200s with a tx hash. If 404 → roll back, ping Sinaver.
5. **Fleet:** reconciler rolls out across the fleet over normal ~hours.

### Risk

**Low** if dashboard is enabled before merge. Failure modes:

- CLI 0.3.1 still uses old endpoint internally → claims silently keep working until Bankr's sunset date. Detection: 200s but Bankr-side metrics show traffic on old path. Mitigation: ping Sinaver before merge.
- Dashboard toggle not enabled → first claim 401s with "walletApi capability not enabled". Detection: canary test catches it on VM 1. Mitigation: enable, retry.
- 10-tx/day cap exhaustion behavior unknown → high-volume agents (rare) might hit it; failure mode undocumented. Mitigation: not blocking, add detection if/when we see it.

### Rationale — why no `lib/bankr-claim.ts`

I originally planned a Vercel-side HTTP helper. Given:
- Sponsored path is reached via the CLI, which already runs on every VM
- Response is sync and contains `transactionHash` — no polling state to persist
- User flow is chat-driven ("claim my fees") → agent → CLI → Bankr → done

Writing a Vercel-side helper would duplicate the CLI's job without adding user-visible surface. **Unless** we later want an admin-initiated bulk claim (e.g., Cooper triggers claims across N user accounts for a comp campaign), there's no reason to build it. Deferred to phase-bankr-2 if that use case appears.

### What this PR does NOT do

- No new DB tables
- No new Vercel endpoints
- No modifications to `lib/bankr-provision.ts` (unless Sinaver confirms we need to pass `walletApiEnabled: true` at key creation — TBD)
- No modifications to `lib/bankr-wallet-lifecycle.ts`
- No webhook handler

### What could still grow PR scope

Only if Sinaver's answers change the picture:
- If pre-existing user keys lack `walletApiEnabled` → we add a rotation migration (one-time: loop through `instaclaw_vms`, rotate each key with walletApi scope). Adds ~1 script.
- If the 10-tx/day cap exhaustion returns an unusual error shape → we add detection/handling in the proxy layer or chat response. Adds ~10 lines.
- If new provisioning needs `walletApiEnabled: true` → 1-line change to `lib/bankr-provision.ts` request body.

### Risk

**Low.** This is essentially a dependency version bump with validation. The reconciler fleet-rollout discipline (staged canary → fleet) we already use for any `VM_MANIFEST.version` bump covers it.

### What I need from you

1. Ping Sinaver with the 7 "Ask Sinaver" bullets above.
2. When answers come back, I update this doc + propose the actual version pin.
3. Review this doc for anything I mis-read from Bankr's pages.

---

## Pages I read (traceability)

- https://docs.bankr.bot/token-launching/api-reference/claim-token-launch-fees (target endpoint)
- https://docs.bankr.bot/token-launching/api-reference/get-token-fees (read endpoint)
- https://docs.bankr.bot/token-launching/api-reference/overview (api-ref overview)
- https://docs.bankr.bot/token-launching/claiming-fees (concept / flows)
- https://docs.bankr.bot/partnership/api-keys (key architecture)
- https://docs.bankr.bot/partnership/api-reference/generate-api-key (key creation)
- https://docs.bankr.bot/wallet-api/overview (wallet-api scope)
- https://docs.bankr.bot/ (nav structure)

**Pages I did NOT read** (worth checking if the above left gaps):
- `/wallet-api/sign`, `/wallet-api/submit` — might document gas handling for signed flows
- `/agent-api/authentication` — might document org capabilities in more detail
- `/partnership/wallet-provisioning` — might document `walletApiEnabled` default at provision time
- `/cli` — might document which CLI versions target which endpoints
- `/webhooks/overview` — I confirmed none on claims, but could double-check

If Cooper wants me to plug any gap specifically, tell me which and I'll fetch.
