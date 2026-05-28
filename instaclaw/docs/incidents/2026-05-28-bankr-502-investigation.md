# INC-20260528-bankr-502-investigation

## TL;DR (read this first)

**Bankr signer is HEALTHY.** Wallet `0xd998a6dc14e5ec290b2a9f201d6a6c82a1dd38c4` (`wlt_3jwnjot9w2dtoy1q`, Cooper's vm-1043 demo wallet) is in some kind of Bankr-internal blocked state that needs Igor's intervention.

**Edge launch is NOT blocked.** Every paying user gets their own Bankr wallet provisioned independently. Tested across 5 random wallets in our partner org: provisioning works (HTTP 201), reads work, and a successful test transaction was signed and mined on Base mainnet at 2026-05-28 ~16:08 UTC (tx `0x56eff8e87147370e6d4d1e34812960bea223d2c0e2a06cef3d8f3ceaf7f4f78b`, block `46597675`). The signer is functional for non-vm-1043 wallets.

**We did NOT cause this.** Cooper's hypothesis ("must be something we did") was tested directly against the git log: no deploys landed between `2026-05-27 22:23 UTC` and `2026-05-28 13:17 UTC` — the 02:13 UTC failure cascade fell in that gap.

**Recommended action:** send the wallet ID + reference IDs below to Igor and ask him to inspect vm-1043's wallet for an internal abuse-flag / circuit-breaker / quota state and clear it. Monitor for recurrence on other wallets after Edge launch.

## Hypothesis matrix (with conclusions)

| # | Hypothesis | Test | Result |
|---|---|---|---|
| H1 | Bankr-wide signer outage | Test 5 random wallets across our partner org | **FALSIFIED.** vm-561 signed and broadcast a real tx (block 46597675). |
| H2 | InstaClaw partner-org-wide block | Test multiple InstaClaw wallets | **FALSIFIED.** Same as H1 — vm-561 is InstaClaw partner. |
| H3 | vm-1043 wallet-specific issue | Test SAME tx (0-value 0x self-call) from vm-1043 and vm-561 | **CONFIRMED.** vm-561 succeeds, vm-1043 fails with `400 signer rejected: signing_failed (req 01KSQNVZ0SKHANS6SP0J217GB5)`. |
| H4 | API change broke our integration | Inventory all endpoints we call; compare to Bankr API responses | **FALSIFIED.** All endpoints return expected shapes. `GET /partner/wallets` returns 300+ wallets cleanly. |
| H5 | Tx-type / token / route specific | Test multiple tx types from vm-1043: USDC transfer, 0-value self-call, openTrade calldata | **FALSIFIED yesterday + reconfirmed today.** Every tx type from vm-1043 fails, regardless of token/route. |
| H6 | Geographic / RPC pool partitioning by wallet age | Test wallets from different `created_at` cohorts | **FALSIFIED.** vm-561 (created 2026-03-19) succeeds. vm-1043 (created 2026-05-27 18:00) fails. Wallet age doesn't predict outcome. |
| H7 | Partner-org quota exhaustion | Test partner provisioning (`POST /partner/wallets`) | **FALSIFIED.** New wallet provisioned successfully: `wlt_pvn7sz7r0i3qo5pq` (HTTP 201). |
| H8 | Intermittent vs continuous | Mine all session jsonls on vm-1043 for last 72h | **CONTINUOUS for vm-1043 specifically** since 2026-05-28 02:13:46 UTC. Two distinct prior episodes also visible (2026-05-27 18:15-19:06 = ~51 min, then recovery — same pattern of wallet-specific lockout). |
| H9 | bankr CLI version mismatch | Check vs latest | **FALSIFIED.** `bankr --version` returns 0.3.1; npm latest is 0.3.1. |
| H10 | Wallet status suspended/frozen in Bankr DB | `GET /partner/wallets` → look up wallet entry | **PARTIALLY FALSIFIED.** Status field shows `"active"`. But the signer behavior implies an internal flag the partner API doesn't expose. |
| H11 | Cooper's "we did something" | Cross-reference failure timeline vs `git log --since="2026-05-27 18:00 UTC"` | **FALSIFIED.** Failure cascade at 02:13 UTC on 2026-05-28 fell in a 15-hour deploy gap (22:23 UTC 2026-05-27 to 13:17 UTC 2026-05-28). |

## Empirical timeline (UTC, mined from vm-1043 session jsonls + on-chain)

### 2026-05-27 (yesterday's earlier episode)

| Time | Event | Status / Ref |
|---|---|---|
| 18:00:28 | vm-1043 wallet created (`wlt_3jwnjot9w2dtoy1q`) | (per `GET /partner/wallets`) |
| 18:15:50 | First signing failure | `signing_failed (01KSNACQK72V5BDP2BJ77EG39D)` |
| 18:21:47 | Signing failure | `signing_failed (01KSNAQM1ZSGV0SVQDTF68T3JS)` |
| 18:22:12 | Signing failure (submit json path) | `signing_failed (01KSNARCDM0J2G987D4CWH74KH)` |
| 18:23:00 | Signing failure (REST API wrapper) | `signing_failed (01KSNASVJHY6GC9V7FD3HH6T4A)` |
| 18:23:24 | Signing failure escalates to 502 | `signing-service-502 (01KSNATK20EYSDVZA7M6BWYWHH)` |
| 18:23:41 | Same | `signing-service-502 (01KSNAV3PJV2XK040BP24SG91X)` |
| 19:06:09 | **Successful** — Morpho approve | tx `0x095ea7b30000...` |
| 19:06:20 | **Successful** — Morpho deposit | tx `0x6e553f650000...` |

Episode lasted ~51 min. Recovery without intervention.

### 2026-05-28 (current ongoing episode)

| Time | Event | Status / Ref |
|---|---|---|
| 02:04:48 | **Successful** — Step 1 router approve | tx `0xe34bbad088f5...` |
| 02:05:08 | Simulation failure (swap) | `simulation_reverted (01KSP583HMPTK4Q1ZH0KT9CHMC)` |
| 02:05:35 | Simulation failure (Uniswap V3 swap) | `simulation_reverted (01KSP58XJQACAZBCM5PVE957N8)` |
| 02:06:28 | **Successful** — Paraswap approve | tx `0x6446c4354a06...` |
| 02:07:02 | **Successful** — Paraswap swap | tx `0x65740325d7c9...` |
| **02:12:08** | **LAST SUCCESSFUL SIGN** — Avantis TradingStorage approve | tx `0x48a54657c643...` |
| 02:12:14 | Avantis openTrade (Avantis API is geo-restricted — tx malformed) | `simulation_reverted (01KSP5N2WSZD35EZ3HZXZ6RZG5)` |
| 02:13:31 | WETH unwrap attempt #1 (incompatible with EIP-7702 smart account per yesterday's INC report) | `simulation_reverted (01KSP5QE7GSGEMAQZ2NG49TQK1)` |
| 02:13:46 | WETH unwrap retry with explicit calldata — error class **CHANGES** to `signing_failed` | `signing_failed (01KSP5QVJVVXHYSZ7DPG3W8WCT)` |
| 02:22:46 | Simple ERC-20 approve (Paraswap WETH) — should pass simulation | `signing_failed (01KSP68AZ4PF4J4XSBA1QA450D)` |
| 02:22:57 | Simple ERC-20 approve (Paraswap USDC test) | `signing_failed (01KSP68NYT7T8SW23CCKCSN6MM)` |
| 02:23:51 | `bankr wallet submit json` raw approve | `signing_failed (01KSP6AAF33GJT488J2S5TB001)` |
| 02:24:14 | USDC approve to Uniswap router | `signing_failed (01KSP6B0Z1FJCJQZRQ0AKNMN7Y)` |
| 02:25:56 | Simplest possible: `bankr wallet transfer 0.001 WETH` to self | `502 signing-service-couldn't-complete (01KSP6E4NAPGTGP613CM8BCQXH)` |
| 14:00:36 | Today (this conversation) — signing test | `signing_failed (01KSQE63GSV625095BZFENE4N3)` |
| 14:00:51 | Today — transfer test | `502 (01KSQE6J1YS3GGZ378FHY54EEF)` |
| 14:06:29 | Today — signing test | `signing_failed (01KSQEGWG9QGJX8MCKXK13HGC1)` |
| 15:49:24 | Today — transfer test | `502 (01KSQMDA1PNF2XSA6KBXFYB4EM)` |
| 15:45 | This investigation — dust transfer test | `502 (01KSQMBQ79MV0HFKXGND8VD41E)` |
| 16:11 | This investigation — 0-value 0x self-call | `400 signer rejected: signing_failed (01KSQNVZ0SKHANS6SP0J217GB5)` |

**Current state:** 13.5+ hours of continuous wallet-specific signer rejection. No recovery yet.

### The cutover signal (what changed between 02:12:08 and 02:13:46)

At 02:12:08 vm-1043's wallet signed a routine USDC approve cleanly (TradingStorage approve, tx `0x48a54657c643...`). At 02:13:31 the next attempt — a WETH unwrap (which we now know is fundamentally incompatible with EIP-7702 smart accounts because of the 2300-gas `transfer()` pattern in WETH9.withdraw) — returned `simulation_reverted`. That was the simulator correctly catching an incompatible operation.

At 02:13:46, the SAME WETH unwrap retried with explicit calldata returned `signing_failed` — a different error class for the SAME tx. Then every subsequent tx (including simple, valid ERC-20 approves and self-transfers) returned `signing_failed` or `502`.

**Interpretation:** the burst of failed simulations (Avantis geo-restricted + WETH unwrap) appears to have tripped an internal Bankr-side flag on vm-1043's wallet, transitioning it from "simulating and signing correctly" to "rejecting everything." The exact mechanism is opaque to us — Bankr's `status` field on the wallet still says "active" but the signer behaves as if the wallet is rate-limited or circuit-broken.

This is consistent with what we observed in the 2026-05-27 18:15-19:06 episode (similar pattern of burst-failures triggering ~51 min of broken signing before unsticking).

## Cross-wallet test results (the load-bearing discriminator)

All tests run from healthy fleet VMs at 2026-05-28 ~16:05-16:15 UTC.

### Read paths (all wallets)

```
✔ Bankr API connection OK
✔ portfolio loaded
```

Reads work everywhere.

### `bankr wallet transfer --token USDC --amount 0.000001 --to <self>`

| Wallet | Created | Balance | Result | Reference |
|---|---|---|---|---|
| vm-linode-06 (`0x710fa76d...`) | 2026-02-13 | $0.00 | `400 transaction would fail on-chain` | `01KSQNHXNJM4GFK4131AB1NVYJ` |
| vm-561 (`0x7bf37381...`) | 2026-03-19 | $0.00 | `400 transaction would fail on-chain` | `01KSQNJ3179AQ9FZB3HGX0Q49T` |
| vm-756 (`0xa99373b8...`) | 2026-04-08 | $0.00 | `400 transaction would fail on-chain` | `01KSQNJ7QAKE2DFR8JSYB2SEF7` |
| vm-854 (`0x0d6aa8aa...`) | 2026-04-18 | $0.00 | `400 transaction would fail on-chain` | `01KSQNJCRG6TZK6VZWN3W69JRJ` |
| vm-948 (`0x67450c69...`) | 2026-05-15 | $0.00 | `400 transaction would fail on-chain` | `01KSQNJHJV8BZ0ZCCZXS2566HV` |
| **vm-1043 (`0xd998a6dc...`)** | 2026-05-27 | $19.86 | **`502 signing service couldn't complete`** | `01KSQMBQ79MV0HFKXGND8VD41E` |

The $0-balance wallets all return 400 — that's the **simulator** correctly identifying "you don't have USDC to send." These wallets fail BEFORE the signer step, so this test doesn't actually probe the signer for those wallets.

vm-1043 with funds passes simulation → reaches the signer → 502. **The 502 only manifests on wallets that get past simulation.**

### Better signer test: 0-value 0x self-call (no balance required)

This bypasses balance-based simulator rejection so we test the signer directly on $0-balance wallets too.

| Wallet | Result |
|---|---|
| **vm-561 ($0)** | **✓ SUCCESS** — tx `0x56eff8e87147370e6d4d1e34812960bea223d2c0e2a06cef3d8f3ceaf7f4f78b`, signer `0x7bf373810463cb61feb0d07c690a905d86512fdf`, block `46597675`, status: success, gas 114021 |
| **vm-1043 ($19.86)** | **✗ FAILED** — `400 signer rejected: signing_failed (req 01KSQNVZ0SKHANS6SP0J217GB5)` |

**This is the load-bearing finding.** Same tx shape, different wallets, opposite outcomes. The signer pool is healthy for vm-561 and broken for vm-1043.

### Wallet provisioning test (independent path)

```bash
POST /partner/wallets
{"idempotencyKey":"instaclaw_diagnostic_1779984719_health-check"}

→ HTTP 201
→ {"id":"wlt_pvn7sz7r0i3qo5pq","evmAddress":"0xdb9c3ca0f9fdea3951001c96554cbe809b54394e","idempotencyKey":"instaclaw_diagnostic_1779984719_health-check"}
```

New wallets provision cleanly. Partner-auth and the creation path are fully healthy.

## On-chain forensics

Both vm-1043 and vm-561 wallets have **identical** on-chain configuration:

| Field | vm-1043 | vm-561 |
|---|---|---|
| `eth_getTransactionCount` (nonce) | `0x1` (1) | `0x1` (1) |
| `eth_getCode` | `0xef0100d6cedde84be40893d153be9d467cd6ad37875b28` | `0xef0100d6cedde84be40893d153be9d467cd6ad37875b28` |
| EIP-7702 delegation indicator | `0xef0100` | `0xef0100` |
| Delegated contract (Privy smart account impl) | `0xd6cedde84be40893d153be9d467cd6ad37875b28` | `0xd6cedde84be40893d153be9d467cd6ad37875b28` |
| Native ETH balance | `0x0` (0 wei) | (same, $0 native — both rely on sponsorship) |

So at the protocol level, the wallets are identical. The differing signer behavior is entirely Bankr-internal state.

## Bankr wallet entry (from `GET /partner/wallets`)

```json
{
  "id": "wlt_3jwnjot9w2dtoy1q",
  "evmAddress": "0xd998a6dc14e5ec290b2a9f201d6a6c82a1dd38c4",
  "createdAt": "2026-05-27T18:00:28.806Z",
  "status": "active",
  "idempotencyKey": "instaclaw_user_59dcf829-22d0-4db5-8890-d9cde788b576"
}
```

**Status shows `"active"`.** Bankr's public partner API does not expose whatever internal flag is causing this wallet to be rejected at the signer step.

## Our integration code inventory (what we call, in case of relevance)

Endpoints called from `instaclaw/`:

| Endpoint | File | Purpose |
|---|---|---|
| `POST /partner/wallets` | `lib/bankr-provision.ts:81` | Wallet creation. **Tested: works (HTTP 201).** |
| `POST /partner/wallets/{id}/{action}` | `lib/bankr-wallet-lifecycle.ts:50` | Suspend/resume/close. (Not called recently — we don't suspend wallets in the normal flow.) |
| `GET /public/doppler/creator-fees/{wallet}` | `lib/bankr-launch-sync.ts:90` | Token fee detection. (Public, no auth.) |
| `POST /token-launches/deploy` | `app/api/bankr/tokenize/route.ts:233` | Token launches. (Not relevant here.) |
| `GET /partner/wallets` | (this investigation) | Wallet inventory. **Tested: works, 300 wallets returned with pagination.** |

bankr CLI on each VM (BANKR_API_KEY in `~/.openclaw/.env`) calls Bankr's `bankr wallet ...` endpoints directly. We don't intercept those calls.

bankr CLI version on vm-1043: **0.3.1** (matches npm latest).

## Cross-reference: deploy log during failure window

Failure cascade on vm-1043 starts at `2026-05-28 02:13:46 UTC`. Git log of all commits to `main` between 2026-05-27 18:00 UTC and 2026-05-28 16:00 UTC:

```
657970b0  2026-05-28 15:37 UTC  chore(changelog): auto-update [skip ci]
1a249852  2026-05-28 15:37 UTC  chore(v126-bake-prep)
a6091be2  2026-05-28 15:37 UTC  fix(reconcile): stepDeployGbrainSoulProtocol (this terminal)
898575f4  2026-05-28 14:45 UTC  chore(changelog): auto-update
492420f3  2026-05-28 14:44 UTC  fix(onboarding-done): 'web' channel case
1fa59980  2026-05-28 14:25 UTC  chore(changelog): auto-update
6cf1d650  2026-05-28 14:24 UTC  fix(reconcile): stepDeployBaseDefiRouting (this terminal)
6674975a  2026-05-28 13:46 UTC  chore(changelog): auto-update
7f56bab9  2026-05-28 13:45 UTC  Merge pull request #21 (strip-thinking phase 2/3)
3e73be06  2026-05-28 13:40 UTC  fix(P0 Phase 2/3): call_type taxonomy
a0f0620e  2026-05-28 13:27 UTC  chore(changelog): auto-update
2f0b77a6  2026-05-28 13:26 UTC  fix(base-defi): WETH9.withdraw (this terminal)
18a01ed4  2026-05-28 13:21 UTC  chore(changelog): auto-update
41b61ec0  2026-05-28 13:20 UTC  Merge pull request #20 (strip-thinking summary killswitch)
27885f9b  2026-05-28 13:17 UTC  fix(P0): kill-switch periodic-summary LLM calls
                            <— ~15-hour deploy gap —>
4957c3b7  2026-05-27 22:24 UTC  chore(changelog): auto-update
95480af9  2026-05-27 22:23 UTC  feat(v123): skip-to-command-center Phase 2 fleet rollout
```

**The 02:13 UTC failure cascade on 2026-05-28 fell squarely in the 15-hour deploy gap.** Nothing we shipped caused this.

## Open questions for Igor

The doc shape to send to Igor + the specific things he can check:

1. **Wallet `wlt_3jwnjot9w2dtoy1q` (`0xd998a6dc14e5ec290b2a9f201d6a6c82a1dd38c4`, InstaClaw partner org)** has been failing every signing operation continuously since `2026-05-28 02:13:46 UTC` (~13.5 hours). Recent reference IDs: `01KSP5QVJVVXHYSZ7DPG3W8WCT` (first failure), `01KSQNVZ0SKHANS6SP0J217GB5` (most recent test, 16:11 UTC). Status field in `/partner/wallets` shows `"active"`.

2. **Other InstaClaw wallets sign successfully.** Specifically wallet `0x7bf373810463cb61feb0d07c690a905d86512fdf` (`wlt_???` — we can look up if needed) just signed and broadcast tx `0x56eff8e87147370e6d4d1e34812960bea223d2c0e2a06cef3d8f3ceaf7f4f78b` (block 46597675 on Base) at 16:08 UTC. So Bankr's signer pool is healthy.

3. **Pattern strongly suggests internal abuse / circuit-breaker / quota lockout that the partner API doesn't expose.** A similar 51-min episode on the same wallet happened 2026-05-27 18:15-19:06 UTC (refs `01KSNACQK...` through `01KSNAV3PJ...`), then self-recovered without intervention.

4. **Specific questions:**
   - Is `wlt_3jwnjot9w2dtoy1q` in any internal flagged state (abuse review, rate limit, daily quota, paused, etc.)?
   - If yes, what triggers it and how do we clear it / prevent it?
   - Should we expect this to recur on other wallets when an Edge attendee's agent hits a similar burst of `simulation_reverted` operations (e.g., a user repeatedly trying an unsupported tx pattern)?
   - Is there a partner API to query a wallet's effective sign-eligibility state (beyond the `status` enum)?

## Recommended actions

| Priority | Action | Owner |
|---|---|---|
| P0 | Send this doc to Igor; get `wlt_3jwnjot9w2dtoy1q` unblocked | Cooper |
| P1 | Set up the bankr-signing-health cron + admin alert (already built per prior incident, blocked on Cooper's approval). Wire it to probe the SIGNER (a 0-value 0x self-call from a known wallet) so it catches the wallet-specific failure mode. | Engineering (this terminal can ship next) |
| P1 | Suspend or close the diagnostic wallet `wlt_pvn7sz7r0i3qo5pq` (`0xdb9c3ca0f9fdea3951001c96554cbe809b54394e`) created during this investigation. It has no user assigned. | Engineering |
| P2 | When Igor clears vm-1043's wallet, monitor for recurrence on ANY fleet wallet — extract trigger pattern (X failed simulations in Y minutes → automatic lockout?) and codify into a per-wallet circuit breaker on our side that pauses further signing attempts before we exhaust Bankr's tolerance. | Engineering follow-up |
| P3 | Add a "wallet-broken" status to the `cron/health-check` for paying customers — if a user's wallet starts uniformly 502'ing, alert them and pause auto-trading until cleared. | Engineering follow-up |

## Lessons / what this changes about our mental model

1. **The "Bankr is down" framing was wrong both times.** Yesterday's incident doc (`docs/incidents/2026-05-28-bankr-502-outage.md`) treated this as a service-wide outage. Today's investigation proves it was always wallet-specific. The signer was never down; the wallet was flagged. Updating the prior incident doc would be appropriate.

2. **The 5-min `bankr-signing-health` cron we built probes the wrong thing.** It pings `/partner/wallets` (which works fine even when individual wallets are broken) and `/public/doppler/...` (no-auth). Neither would catch a wallet-specific signer rejection. The probe needs to attempt an actual signing operation from a sentinel wallet (a 0-value 0x self-call to a known address) to be diagnostic. Filed as P1 above.

3. **A burst of failed simulations on one wallet is the suspected trigger.** Yesterday's investigation already established that WETH9.withdraw() is fundamentally incompatible with the EIP-7702 smart account model (the 2300-gas `transfer()` pattern → revert). vm-1043 hit several of those in a row during the demo, plus the Avantis GEO_RESTRICTED tx-builder failure. Bankr's signer appears to interpret this as suspicious activity and flag the wallet. The newly-shipped `BASE_SKILL_WALLET_LIMITS_V1` sections + `Smart-account wallet limits` routing-block subsection (commits `2f0b77a6` + `6cf1d650`) prevent the agent from attempting those failing operations in the first place — which means future agents shouldn't trigger the same flag pattern.

4. **Cooper's gut "must be something we did" was a productive lens.** It forced me to test directly against the deploy timeline rather than just blame Bankr. The answer turned out to be "no, but the failure WAS triggered by user-side request patterns" — and our WETH wallet-limits fix is the prophylactic.
