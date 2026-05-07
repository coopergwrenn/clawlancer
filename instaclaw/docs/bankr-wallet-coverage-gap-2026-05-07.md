# Bankr Wallet Coverage Gap — Diagnosis + Plan

**Author:** Claude (deep audit triggered by Doug Rathell's launch failure)
**Date:** 2026-05-07
**Status:** Pending Cooper approval before execution

---

## TL;DR

Doug Rathell isn't a bug — he's a representative case. **166 of 211 paying VMs (79%)** have no InstaClaw-provisioned Bankr wallet. Every one of those users will hit the same wall the moment they try to launch a token: bankr fields all NULL in DB, no `BANKR_API_KEY` in the VM's `.env`, agent improvises with `bankr login` against the user's personal account → 403 from Bankr API → agent hallucinates "VM fork limits" as the reason.

There are **two distinct root causes**, both still active:

1. **Stripe cohort, pre-2026-04-09.** Webhook path was already calling `provisionBankrWallet`, but `BANKR_PARTNER_KEY` was missing or the helper was returning null silently. Result: every paying VM assigned before that date is missing its wallet — that's most of the historical fleet, including Doug.

2. **World mini-app path, ongoing.** Mini-app onboarding calls `/api/agent/provision` → `/api/vm/assign` and **never invokes `provisionBankrWallet`**. The Stripe webhook is the *only* place in the codebase that ever calls the helper (verified: `grep -rn provisionBankrWallet app/ → only billing/webhook/route.ts:492`). So every World-mini-app signup creates a broken VM. The most-recent broken VM is from today (2026-05-07).

---

## Diagnosis: Doug Rathell (`vm-725`, `afd359@gmail.com`)

### Symptoms

- User report: agent refuses to launch tokens, claiming "launch got blocked by VM fork limits"
- Initial hypothesis (Cooper): SOUL.md identity patch missing → confirmed half-true (V1 marker was missing) but the SOUL.md fix alone doesn't unblock the launch
- Second hypothesis (Cooper): `TasksMax` cgroup limit → confirmed false (set to 120, current 12, massive headroom)

### Actual chain

1. VM assigned **2026-04-08**. Stripe webhook fired. `provisionBankrWallet` was called. Helper hit a `null` return path silently (almost certainly `BANKR_PARTNER_KEY` was missing — that env var was confirmed live in our 2026-05-04 work, not before). DB Bankr fields stayed NULL.

2. `configureOpenClaw()` runs the BANKR `.env` injection only if `config.bankrApiKey && config.bankrEvmAddress` (lib/ssh.ts:4661). Both were null → no `BANKR_API_KEY` written to `~/.openclaw/.env`. Agent has zero Bankr credentials.

3. Doug asked his agent to launch a token. Agent (post-bankr-skill) knew `bankr` CLI exists, tried it, got "no API key configured." Agent prompted Doug to authenticate. Doug did `bankr login` via OTP — using *his personal Bankr account*. Now `~/.bankr/config.json` carries a `bk_usr_aPKhMRVL_*****` (user-account key, not partner key).

4. Agent ran `bankr launch` with that user-key. Bankr returned **403** because user-keys lack the token-launch permissions our partner-key has (`bk_ptr_FVU6...`). The launch failed.

5. Agent had no good explanation for the 403. Wrote "blocked by VM fork limits" into `memory/session-log.md` once. Subsequent sessions read the log, treated "VM fork limits" as a known fact, and re-applied it as the explanation for **every** subsequent failure — including 5+ later attempts. Memory poisoning compounded over weeks.

6. The SOUL.md V1 patch I just deployed (V2 actually — INSTACLAW_PLATFORM_V2 marker, with the new "Token launches are a core feature" directive) addresses the *symptom* of refusal, but the underlying 403 will still happen because the wrong API key is being used.

### Evidence (verified live via SSH + DB)

| Check | Result |
|---|---|
| `~/.openclaw/workspace/SOUL.md` had `INSTACLAW_PLATFORM_V1` marker | ❌ no (now patched to V2 in this session) |
| Doug's `bankr_wallet_id` in DB | NULL |
| Doug's `bankr_evm_address` in DB | NULL |
| Doug's `bankr_api_key_encrypted` in DB | NULL |
| `BANKR_*` lines in `~/.openclaw/.env` | none |
| `~/.bankr/config.json` (user-CLI auth) | exists, key `bk_usr_aPKhMRVL_*****` |
| `bankr whoami` exit | success, prints user-account info |
| `TasksMax` on gateway cgroup | 120 (current 12) |
| Gateway journal "fork" / "EAGAIN" / "ENOMEM" entries | zero in last 2h |
| `memory/session-log.md` "VM fork limits" mentions | 9 distinct sessions over weeks |

---

## Fleet sizing

**Cohort A — Stripe pre-2026-04-09 (provisioning failed):**
The earliest working VM with `bankr_wallet_id` set was assigned **2026-04-09T18:17 (vm-767)**. Anything assigned before that and still status=`assigned` is in this cohort.

**Cohort B — World mini-app path (provisioning never called):**
Mini-app onboarding (`/api/agent/provision`) doesn't invoke `provisionBankrWallet`. Every mini-app paying user has a broken VM.

**Numbers:**
- 211 total VMs at status=`assigned`
- 45 have `bankr_wallet_id` set (working) — assigned 2026-04-09 → 2026-05-07
- 166 have `bankr_wallet_id` NULL (broken) — assigned 2026-02-14 → 2026-05-07
- Most-recent broken: **vm-900, assigned 2026-05-07** (today). World mini-app user.

**Severity:** every one of these 166 users hits Doug's wall the moment they try to launch. Cooper's announcement just made "launch a token" the headline feature. This is a sleeper P0.

---

## Plan

### Phase 1 — Fix Doug specifically (now, after Cooper approval)

**Goal:** Doug can launch RFT5 (Rafters5) on Base via the InstaClaw dashboard within minutes.

1. Run `provisionBankrWallet({ vmId: 'f6d90080-913b-456e-ac2a-8a0142a4c406', userId: '5689bff7-7a5e-402f-b5c3-a9fb87875c5f', vmIp: '45.33.74.65', idempotencyKey: 'instaclaw_user_5689bff7-7a5e-402f-b5c3-a9fb87875c5f' })`. This:
   - POSTs to Bankr `/partner/wallets` with our partner key
   - Returns `{ id, evmAddress, apiKey }`
   - UPDATEs `instaclaw_vms` with `bankr_wallet_id`, `bankr_evm_address`, `bankr_api_key_encrypted`
   - Idempotent: 409 from Bankr on retry returns the existing wallet's info
2. SSH to vm-725 and write `BANKR_API_KEY` + `BANKR_WALLET_ADDRESS` to `~/.openclaw/.env` (decrypt the encrypted key first, mirror the `configureOpenClaw` lib/ssh.ts:4661–4672 logic).
3. SSH to vm-725 and **rename `~/.bankr/config.json`** to `~/.bankr/config.json.predoug-personal-bak`. This forces the bankr CLI to fall back to env-var auth (`BANKR_API_KEY`) instead of Doug's personal user-key. Renamed instead of deleted so we have a recovery path.
4. Edit `memory/session-log.md` and `MEMORY.md` to remove the "VM fork limits" sentences. Replace with a one-line note: "2026-05-07: bankr-launch issue resolved by InstaClaw — wallet provisioned, agent now has correct API key."
5. Restart gateway (`systemctl --user restart openclaw-gateway`), verify active + health 200.
6. **Tell Doug**: "go to instaclaw.io/dashboard, click Launch Token. We handle gas. RFT5 will deploy."

**Success gate:** Doug confirms in chat he sees the Launch Token button and can click through the form.

### Phase 2 — Fleet backfill (after Doug succeeds)

**Goal:** every paying VM has an InstaClaw-provisioned Bankr wallet within 24h.

Build `scripts/_backfill-bankr-wallets.ts`:

1. Query: `select id, assigned_to, ip_address from instaclaw_vms where status='assigned' and bankr_wallet_id is null`
2. For each row, call `provisionBankrWallet({ vmId, userId, vmIp, idempotencyKey: 'instaclaw_user_${userId}' })`. Idempotent — safe to retry forever.
3. After successful provision, SSH to write BANKR_API_KEY + BANKR_WALLET_ADDRESS to `.env` (separate from configureOpenClaw to avoid touching anything else).
4. Concurrency=3 (matches CLAUDE.md fleet rules). 166 VMs at 3 concurrent ≈ ~10 min wallclock at ~10s/VM.
5. Pause gates:
   - **--dry-run flag** (CLAUDE.md Rule 4) prints would-do plan without acting
   - **--test-first flag** (CLAUDE.md Rule 3) runs the first VM only and stops for approval
6. Output: per-VM result row (provisioned/already_provisioned/failed/skipped). Failed VMs go to a follow-up queue.

### Phase 3 — Plug the leak (mini-app provisioning) — REAL CODE FIX

**Goal:** new World mini-app signups get a Bankr wallet auto-provisioned, like Stripe signups do.

The right fix is to call `provisionBankrWallet` from `/api/vm/assign` so **both** payment paths (Stripe webhook AND mini-app proxy) hit it. That makes assignment the single owner of "this user now has a wallet," which is what they expect.

Add the call after the existing post-assignment ownership re-check (mirrors the Stripe webhook safety pattern at `webhook/route.ts:469-487`):

```ts
// In app/api/vm/assign/route.ts, after VM is assigned:
if (vm) {
  // ... existing ownership re-check ...

  // Provision Bankr wallet (idempotent via instaclaw_user_${userId} key).
  // Single owner now — both Stripe webhook and mini-app proxy hit this path.
  // Non-fatal: returns null on Bankr API hiccup; backfill cron catches it.
  await provisionBankrWallet({
    vmId: vm.id,
    userId,
    vmIp: vm.ip_address,
    idempotencyKey: `instaclaw_user_${userId}`,
  });
}
```

Then **remove the call from the Stripe webhook** so we don't double-provision (the idempotency key would dedup, but it's cleaner to have one owner).

### Phase 4 — Continuous safety net

Add `/api/cron/provision-missing-bankr-wallets` (every 30 min):
- Scans for `status='assigned' AND bankr_wallet_id IS NULL` VMs
- Calls `provisionBankrWallet` for each
- Same idempotency pattern
- Catches any future regression where the assign-time call fails silently

### Phase 5 — Memory hygiene fleet patch

The "VM fork limits" hallucination compounded in Doug's memory because the agent's session-log mechanism doesn't sanity-check the explanations it writes. This is a separate broader problem (an agent caching false explanations forever), but for this specific phrase: a one-shot fleet patch could grep `memory/session-log.md` and `MEMORY.md` for "VM fork limits" and replace with a corrective entry, so any other agent that's also been blaming this doesn't carry the lie forward.

Lower priority than Phase 1–4. Optional.

### Phase 6 — v90 SOUL.md fleet patch (the dashboard directive)

The `INSTACLAW_PLATFORM_V2` block I shipped to vm-725 has the "do not refuse token launches" directive. The fleet equivalent should:

1. Bump `INSTACLAW_PLATFORM_V1` → `V2` in `lib/vm-reconcile.ts:stepInstaClawIdentityPatch`
2. Add an idempotent re-patch step that strips the existing V1 block and inserts V2
3. Bump manifest version to v90
4. Roll across the fleet via reconciler

That's a normal manifest bump, follows the Rule 7 snapshot-refresh dance (CLAUDE.md), no new infrastructure needed.

---

## Risks + edge cases

### What if `provisionBankrWallet` fails for some VMs in Phase 2?

`bankr-provision.ts` returns `null` on:
- Missing `BANKR_PARTNER_KEY` — won't happen, verified set
- Bankr API non-2xx (excluding 409) — possible if Bankr is rate-limiting at scale
- Network exception — possible

Mitigation: backfill script should log per-VM result. Failed VMs go to a follow-up queue. The Phase 4 cron will retry them indefinitely.

### What if Bankr rate-limits us at 166 VMs in 10 minutes?

We don't know Bankr's rate limit. Conservative: drop concurrency to 1 with 500ms sleep between calls = 166 × ~10s = ~28 min wallclock. Acceptable.

Better: just run with concurrency=3 first, see if any 429s come back. If so, drop to 1.

### Doug's personal `bankr login` — am I sure renaming `~/.bankr/config.json` is right?

Yes for this case:
- His agent only used the personal account because we never gave it the InstaClaw one
- The intended flow goes through dashboard, not VM CLI
- `bankr fees claim` and other CLI commands the agent might run later should use the InstaClaw-provisioned wallet (so fees flow correctly to the right place)
- We rename rather than delete so Doug can recover his personal config if he ever wants it

### What if Doug's existing personal Bankr account has funds we should know about?

Not our concern — that's his personal Bankr wallet, separate from the agent's InstaClaw-managed wallet. He keeps it.

### Why not just apply the fix Doug-only and skip Phase 2–4?

Because there are 165 other paying users who are about to hit the same wall. Cooper's announcement made "launch a token" the headline feature; every one of those users is a complaint waiting to happen. Doug-only is technical debt with a 165-event activation queue.

### What about Doug's stale `current_period_end: 2026-04-20`?

His Stripe subscription period ended 2026-04-20 in our DB but status is still active. Either Stripe is still billing him on a renewed period and our DB didn't update, OR his subscription actually expired and we're serving him the agent for free. Worth investigating but **not blocking** the Bankr fix. Logged as separate follow-up.

---

## Execution order — pause points

After PRD approval:

1. ✋ **Cooper approves Phase 1 plan** → I run the Doug-specific fix and report success/failure
2. ✋ **Cooper approves Phase 2 plan + I run --dry-run + --test-first** → I run the backfill on 1 VM and pause
3. ✋ **Cooper reviews test-first result** → I run the rest of the fleet
4. ✋ **Cooper approves Phase 3 (mini-app code fix)** → I write a PR, type-check, deploy preview
5. ✋ **Phase 4 cron** is ship-anytime once Phase 3 lands
6. **Phase 5 + 6** are separate workstreams, lower priority

I'll execute one phase at a time, report results, and pause for go/no-go before each next step.

---

## Files I'll touch in execution

### Phase 1 (Doug-specific):
- `instaclaw/scripts/_fix-doug-bankr.ts` (new) — runs provision + .env write + bankr-config rename + memory cleanup + restart, all in one auditable script

### Phase 2 (fleet backfill):
- `instaclaw/scripts/_backfill-bankr-wallets.ts` (new) — fleet-wide backfill with --dry-run + --test-first + concurrency=3

### Phase 3 (mini-app fix):
- `instaclaw/app/api/vm/assign/route.ts` — add `provisionBankrWallet` call after assignment
- `instaclaw/app/api/billing/webhook/route.ts` — remove the now-duplicate call

### Phase 4 (cron):
- `instaclaw/app/api/cron/provision-missing-bankr-wallets/route.ts` (new)
- `instaclaw/vercel.json` — register cron

### Phase 5 (memory hygiene):
- `instaclaw/scripts/_fleet-clean-vm-fork-limits-myth.ts` (new) — one-shot fleet patch

### Phase 6 (SOUL.md v90):
- `instaclaw/lib/vm-reconcile.ts` — `stepInstaClawIdentityPatch` upgrade to V2
- `instaclaw/lib/ssh.ts` — `WORKSPACE_SOUL_MD` includes V2 platform block
- `instaclaw/lib/workspace-templates-v2.ts` — `WORKSPACE_SOUL_MD_V2` updated
- `instaclaw/lib/vm-manifest.ts` — version bump to v90

---

## Decision requested from Cooper

1. **Approve Phase 1 (Doug)?** Y/N
2. **Approve Phase 2 (fleet backfill, 166 VMs)?** Y/N or "show me dry-run first"
3. **Approve Phase 3 (mini-app code fix)?** Y/N
4. Any constraints I should know about (e.g., don't touch certain users, time window restrictions, etc.)?
