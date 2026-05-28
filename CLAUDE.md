# InstaClaw — Project Notes

## Quick Commands

- **"spots N"** or **"provision N VMs"** — Provision N new dedicated CPU VMs for the ready pool. Use the exact specs below. NEVER deviate.

## VM Provisioning Standard (MANDATORY)

ALL new VMs must use these exact specs:

- **Provider:** Linode ONLY (never Hetzner or DigitalOcean)
- **Type:** `g6-dedicated-2` (Dedicated 4GB — 2 dedicated vCPU, 4GB RAM, 80GB disk)
- **Region:** `us-east`
- **Snapshot:** `private/38575292` (instaclaw-base-v79-2026-05-03 — baked 2026-05-03 from v64 baseline (private/38496803). OpenClaw 2026.4.26, Node v22.22.2, manifest v79. Reconciler applied 44 fixes during bake (latest workspace files, v79 systemd overrides 12 settings, v77 routing table patch, 22 skills + 54 scripts, workspace backups cron, POLYGON_RPC_URL env, sshd OOM protection drop-in, model defaults set, telegram streaming/sandbox/strict-mode config). 5342 MB. NOTE: vm-watchdog + silence-watchdog crons present (carried from v64 — production fleet has these manually disabled; new VMs from this snapshot will re-enable them unless removed during configureOpenClaw).)
- **Rollback snapshot (1-week window):** `private/38496803` (v64, baked 2026-04-28). Re-set LINODE_SNAPSHOT_ID to this if v79 has issues. Keep until 2026-05-10.
- **Cost:** $29/mo per VM (negotiated Linode rate)
- **DB status:** `provisioning` (cloud-init-poll cron auto-marks as `ready` in ~3-5 min)

NEVER use old snapshots (private/36895419, private/38069990, private/38111101 (v58), private/38458138 (v62), or any pre-v64 image). NEVER provision shared CPU (g6-standard-2). NEVER provision on Hetzner or DigitalOcean.

## Project Structure

- `instaclaw/` — Next.js app (instaclaw.io)

## Key Info

- Git remote: https://github.com/coopergwrenn/clawlancer.git
- Branch: main
- Dev server: `npm run dev` from instaclaw/, runs on port 3001
- Production: https://instaclaw.io
- Admin email (Stripe / billing / app admin): coop@valtlabs.com

### Owner account identities

These three exist; mixing them up has broken deploys at least once (2026-05-16
edgeclaw-village deploy went to the wrong Vercel team because the CLI was
authed as the GitHub-account login, not the Vercel team-owner email).

| Where | Identifier | Notes |
|---|---|---|
| Vercel team owner (use for `vercel login`) | **coopergrantwrenn@gmail.com** | Owns the `cooper-wrenns-projects` Vercel scope — every project (instaclaw, edgeclaw-village, etc.) lives under this. |
| GitHub username | **coopergwrenn** | Repo owner. Both `clawlancer` (instaclaw monorepo) and `edgeclaw-village` live under this user. |
| GitHub login email | cooperwrenn@gmail.com (legacy / GitHub-personal) | NOT the Vercel email. Was the default `vercel whoami` after the 2026-05-16 mix-up. |
| Stripe / billing / app-admin email | coop@valtlabs.com | Used for InstaClaw admin auth + Stripe customer record. NOT the Vercel email. |

**When running `vercel login` for ANY deploy**: use `coopergrantwrenn@gmail.com`. After login, `vercel whoami` should report the team-owner username (varies by Vercel UI — confirm by `vercel teams ls` if uncertain).

## Mandatory Rules

These are permanent rules. Never violate them.

### 1. Verify DB Schema Before Updates

NEVER add columns to a Supabase `.update()` call without first confirming the column exists on that table. Before adding any field, run:
```sql
select column_name from information_schema.columns where table_name = 'TABLE_NAME'
```
and confirm the column is present. The `consecutive_failures` bug happened because a column from one table was added to an update on a different table.

### 2. Verify Config Schema Before Changing Values

NEVER change an OpenClaw config value without checking the config validation/schema in the OpenClaw dist files on a VM. A runtime code path does NOT mean a value is accepted by the config schema validator. The `auth.mode: "none"` crash happened because the value exists in runtime code but is rejected by the config schema — crashing the gateway on startup.

### 3. Test on One VM Before Fleet-Wide Deploy

NEVER deploy a config change or patch to the entire fleet at once. Always:
1. Run on ONE VM first
2. Verify the gateway is active and health returns 200
3. Wait for manual confirmation before continuing to the rest

Fleet scripts must include a `--test-first` flag that patches one VM and pauses for approval.

### 4. Dry-Run Fleet Operations First

NEVER run a fleet operation without `--dry-run` first. All fleet scripts must support `--dry-run` and it must be run before the real execution. Review the dry-run output before proceeding.

### 5. Verify Gateway Health After Config Changes

After any config change + gateway restart via SSH, wait up to 30 seconds for the gateway to reach "active" state (`systemctl --user is-active openclaw-gateway` returns "active" AND health endpoint returns 200). If it doesn't come back:
1. REVERT the config change
2. Restart the gateway with the old config
3. Report the failure
Never leave a crash-looping gateway.

### 6. No Trailing Newlines in Environment Variables

NEVER use `<<<` (here-string) or `echo` to pipe values into `vercel env add` — both add a trailing newline that corrupts API keys and secrets. Always use `printf` which does NOT append a newline:

```bash
# CORRECT:
printf 'the_value' | npx vercel env add VAR_NAME production

# WRONG — adds trailing \n:
npx vercel env add VAR_NAME production <<< "the_value"
echo "the_value" | npx vercel env add VAR_NAME production
```

The `BANKR_PARTNER_KEY` incident: a trailing `\n` was appended to the API key, which would have caused every Bankr API call to fail with auth errors.

### 7. Snapshot Refresh After Manifest Bumps

Every time `VM_MANIFEST.version` is bumped in `vm-manifest.ts`, the base snapshot used for new VMs becomes stale. The reconciler fixes existing VMs automatically, but NEW VMs provisioned from the old snapshot start with outdated config until reconciler catches them.

**After every manifest version bump, STOP and tell Cooper:**

> "Manifest bumped to v{N}. The fleet reconciler will push this to existing VMs automatically. However, the base snapshot is now stale — new VMs provisioned from it won't have these changes until reconciler runs. Should we bake a new snapshot now, or wait until we've accumulated more changes?"

**When to bake a new snapshot:**
- After 3+ manifest bumps since last snapshot
- Before any large provisioning run (e.g., "spots 20")
- After major changes (new scripts, new crons, new workspace files, OpenClaw version upgrade)
- Cooper explicitly asks

NEVER provision a batch of VMs from a snapshot that's >3 manifest versions behind.

### 8. NEVER Manually Provision VMs (replenish-pool Owns the Pool)

VM ready pool replenishment is **fully automated** via `/api/cron/replenish-pool` (runs every 5 min via Vercel cron). This cron:

- Maintains the ready pool between `POOL_FLOOR` (10) and `POOL_TARGET` (15)
- Provisions up to `MAX_PER_RUN` (10) VMs per cycle from `LINODE_SNAPSHOT_ID`
- Uses a distributed lock (`instaclaw_cron_locks` table) to prevent concurrent runs
- Counts ready + provisioning as in-flight inventory (prevents over-provision)
- Sends admin alerts on critical depletion, cost ceiling, stuck VMs, lock failures

**NEVER manually provision VMs** (via Linode API directly, scripts, or "spots N" commands) **while the cron is the system of record.** Manual provisioning will:

- Race with the cron's `getNextVmNumber()` query → duplicate VM names
- Push the pool past `POOL_CEILING` (30) → wasted spend
- Confuse the cron's "in-flight" decision logic
- Break the cron lock semantics (the lock only protects cron-vs-cron, not cron-vs-human)

**The ONLY acceptable reasons to manually provision:**

1. **The cron is broken or disabled.** Verify by checking Vercel cron logs and querying `instaclaw_cron_locks`. If the cron has not run successfully in >30 min, fix it FIRST. Don't paper over the issue with manual provisioning.
2. **An emergency batch >10 VMs is needed in <10 min** (e.g., a viral launch). Even then, raise `MAX_PER_RUN` and let the cron handle it across 2-3 cycles, OR pause the cron in vercel.json before manually provisioning to avoid races.

If you think you need to manually provision, **STOP and tell Cooper first.** Explain why the cron isn't sufficient. Get explicit approval. Then take the cron lock from your manual script:

```typescript
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";

const acquired = await tryAcquireCronLock("replenish-pool", 600, "manual-script");
if (!acquired) throw new Error("Replenish-pool cron is currently running, aborting manual provision");
try {
  // ... provision VMs ...
} finally {
  await releaseCronLock("replenish-pool");
}
```

**This rule applies to YOU (Claude Code) too.** Do NOT provision VMs in scripts unless you've explicitly disabled the cron and told Cooper.

### 9. Partner Portal Tagging Must Update Existing Users (Not Just Set a Cookie)

Partner portals (`/edge-city`, future `/eclipse`, etc.) tag a user's account with their `partner` field so partner-specific skills, env vars, and SOUL.md context get installed during `configureOpenClaw()`. The original mechanism — set an `instaclaw_partner` cookie that `lib/auth.ts` reads at user creation — **only fires once, on first signup**. Existing users who later visit a partner portal get the cookie but their existing user record is never tagged.

**The Timour incident (2026-04-30):** Timour signed up at `/signup` on 2026-04-01 with `timour.kosters@gmail.com`. Got vm-354 assigned 2026-04-03. Later visited `/edge-city`, which redirected him through signup again — he created a *second* account `t@timour.xyz` with `partner = edge_city` but no VM. His real working agent (vm-354 / `edgeclaw1bot`) sat with `partner: null` for ~4 weeks. The Edge skill, EDGEOS env vars, and SOUL.md edge section were never installed because every code path is gated on `partner === "edge_city"`. Cooper's own `edgecitybot` (vm-780) had the identical bug. Two partners, same dual-account failure mode.

**Mandatory behavior for any partner portal:**

- Partner portal pages MUST call `POST /api/partner/tag` with `{ partner: "<slug>" }` on the primary CTA. The endpoint:
  - Updates `instaclaw_users.partner` on the existing record if logged in
  - Syncs `instaclaw_vms.partner` for any assigned VMs (so admin queries are immediately accurate)
  - Sets the `instaclaw_partner` cookie (defensive — covers the not-logged-in path)
  - Validates `partner` against `VALID_PARTNERS` allow-list — never accept arbitrary strings
- Existing-cookie-only flow (`document.cookie = ...; router.push("/signup")`) is the legacy path. **Do not ship a new partner portal that uses only cookies.**
- When adding a new partner (Eclipse, Devcon, etc.), the changes are: (a) one-line addition to `VALID_PARTNERS` in `app/api/partner/tag/route.ts`, (b) new portal page that calls the endpoint with the right slug. Nothing else.

**Backfill any historical drift:**

Partner-tagged users may exist in the database but their assigned VMs have `partner: null` (because the configure that synced user → VM happened before the partner field was set). Periodically check:

```sql
SELECT u.email, v.name, u.partner AS user_partner, v.partner AS vm_partner
FROM instaclaw_users u
JOIN instaclaw_vms v ON v.assigned_to = u.id
WHERE u.partner IS NOT NULL AND v.partner IS NULL;
```

If any rows return: those VMs are missing partner-gated skills. Fix by setting `vm.partner = u.partner`, then either (a) running a one-shot SSH install of the partner skill (idempotent: clone-if-missing + cron + env vars + SOUL.md append with marker), or (b) waiting for the next reconciler tick to pick up the change. **Do NOT** force-run `configureOpenClaw` on an already-onboarded user — that triggers the workspace-wipe path (per the bf46ee3d wipe-guard fix). Use `auditVMConfig` or direct SSH instead.

**Dual-account hazard:** any time you discover a user with a tagged-but-VM-less account AND an untagged-but-VM account with similar identifiers (same name, similar email, partner-themed Telegram bot like `edgecitybot` or `edgeclaw1bot`), suspect the same bug. Confirm by checking `vm_lifecycle_log` — the tagged account will show 0 lifecycle entries.

### 10. Reconciler Must Verify Every Config Set — `|| true` Pattern Is BANNED

`stepConfigSettings` in `lib/vm-reconcile.ts` MUST verify every `openclaw config set` succeeded BEFORE any code path advances `config_version`. Silent failures cause permanent fleet drift: once `config_version` reaches the manifest version, the reconcile-fleet route's `lt("config_version", VM_MANIFEST.version)` filter (route.ts:122) excludes the VM forever, so a setting that silently failed once will NEVER be retried.

**The 2026-04-30 streaming.mode incident:** v68 manifest added `channels.telegram.streaming.mode = "off"`. The non-strict reconciler path used `openclaw config set <key> '<val>' || true` then unconditionally pushed every key to `result.fixed` and let `config_version` bump. For ~53% of the fleet, the config-set transiently failed (concurrent gateway-config write, lock conflict — root cause unconfirmed) but no signal made it to the cron route. Result: 16/30 sampled VMs locked at `streaming.mode = partial`, leaking raw tool-call output to Telegram users. Same failure mode as the 2026-04-27 v59/v60 incident with `gateway.openai.chatCompletionsEnabled` — supposedly fixed by strict mode, but strict mode is gated on `STRICT_RECONCILE_VM_IDS` env var which most of the fleet doesn't have.

**Mandatory pattern for any reconciler step that mutates VM state:**

1. Read current state.
2. Apply change.
3. **Re-read state.** Compare to expected.
4. If mismatch: push to `result.errors` (which the reconcile-fleet `pushFailed` gate at route.ts:245 uses to refuse the `config_version` bump). DO NOT push to `result.fixed`.
5. The next cron cycle will retry naturally because `config_version` didn't advance.

**Banned patterns:**
- `command || true` followed by unconditional success counting
- `swallowing exit codes via 2>/dev/null || true`
- Any pattern where "we tried" is treated as "we succeeded"

**Detection:** any `result.fixed.push(...)` that doesn't have a verify-after-set immediately above it is suspect. Strict mode (per-key with exit-code check) is the simplest correct pattern when batched verification is too complex.

### 11. Every LLM/Slow-API Route MUST Set `export const maxDuration = 300`

Every serverless route that calls an LLM, or any external API that could take >10s, MUST have:

```typescript
export const maxDuration = 300; // Vercel Pro max
```

**Why:** Vercel's default function timeout on Pro is **60s**. Any LLM call with 30K+ context (Haiku/Sonnet on a real OpenClaw agent) will exceed this. The failure mode is silent and catastrophic:

- Vercel kills the function at 60s
- The user sees a Vercel edge timeout (or just a hang)
- Our internal `AbortController` (set to 90s in `app/api/gateway/proxy/route.ts:930`) never fires, so the `LLM API timeout (90s)` log never gets written
- Logs look "fine"; users say their agent is broken; engineers can't reproduce
- Per-VM diagnostics show /health=200 — the gateway is healthy, the proxy is the bottleneck
- This caused the **2026-04-30 → 2026-05-01 fleet-wide "agent not responding" crisis**: every chat through the proxy was being killed at 60s while Haiku needed 60-90s with 32K context. Two days of debugging until the actual root cause was found. Multiple paying users impacted (HotTubLee/Lee, Textmaxmax, others).

**The rule:** if a route's handler can plausibly call Anthropic, MiniMax, OpenAI, or any external service that could exceed 10s, **add `maxDuration` FIRST, before writing or testing the handler.** Do not "hope it stays under 60s" — the only safe assumption is that production traffic eventually hits the slow tail.

**Re-export gotcha (load-bearing):** `maxDuration` (and `runtime`, `preferredRegion`, etc.) are **per-route-file Next.js config exports**. They do NOT propagate through `export { POST } from "../proxy/route"`. Every catch-all that re-exports the proxy handler MUST add its own `export const maxDuration = 300`:

```typescript
// app/api/gateway/v1/[...path]/route.ts
export { POST } from "../../proxy/route";
export const maxDuration = 300; // ← REQUIRED — the re-export above does not carry route config
```

If you forget this on the catch-all, requests that hit the catch-all URL get the 60s default while the same handler on the original URL gets 300s. Inconsistent timeout behavior depending on which exact path the SDK constructs is one of the worst classes of bug — looks like a flaky upstream until you trace the route resolution.

**Detection:** `grep -L 'maxDuration' app/api/**/route.ts` will list every route file missing the export. Audit periodically; CI rule is on the wishlist.

### 12. Rebase onto Current Main Before Debugging "Mysterious" Vercel Build Failures

If Vercel fails the build but `npx tsc --noEmit` and `npm run build` pass clean locally on the same SHA, the most likely cause is that the branch was forked before a fix landed on main. Vercel checks out your branch's HEAD, which still includes the broken file from before the fix; your local working tree is implicitly running against newer files because of stale node_modules / unrebased state in your worktree.

**The 2026-04-30 incident:** `feat/partner-tag-existing-users` was forked at `ef47291`. While the branch was active, `c07acce` ("close v67 jsdoc properly so v68 history compiles") landed on main, fixing a malformed `*/` in `lib/vm-manifest.ts` that made v68's comment lines parse as JavaScript code (octal-literal errors on `(2026-04-30)`). The feature branch never picked up that fix. Local `tsc --noEmit` passed because it was looking at the working-tree file (already fixed in the local checkout via `git pull` on main). Vercel built the actual branch tip, hit the broken file, and failed with errors in code I had never touched. **~30 minutes lost** chasing imaginary issues in the route handler before someone pointed out the real cause.

**Mandatory diagnostic order when Vercel fails but local passes:**

1. **First**, `git fetch origin main && git rebase origin/main` on the feature branch. Force-push and re-trigger.
2. **Only then** dig into the actual error — at that point, if it's still failing, it's genuinely something on the branch.

This is a reordering rule, not a fix-the-code rule: you might still need to fix something, but rebasing first eliminates the most common cause and saves the time you'd otherwise spend hunting in the wrong file.

### 13. New API Routes That Need Public/Self-Auth Access MUST Be Added to Middleware Allow-List

`instaclaw/middleware.ts` blocks every `/api/*` route with a 401 by default. Routes are allowed through ONLY if they appear in the `selfAuthAPIs` array. This is defense-in-depth — new routes can't accidentally be exposed without an explicit decision.

**The trade-off:** when you ship a new route that's intentionally public (e.g., email-capture, health check, partner-tagging cookie path) OR that has its own auth mechanism (admin key, gateway token, signature verification, cron secret), the middleware blocks it until you add it to the array.

**Mandatory checklist for every new API route:**

1. Does this route need to be reachable by unauthenticated callers, or use its own auth (X-Admin-Key, gateway token, Stripe signature, etc.)? If yes → add it to `selfAuthAPIs` with a comment explaining the auth mechanism (or "public").
2. If it's a session-protected route (relies on `auth()` for the user), you do NOT need to add it. The middleware's session check is the first line; the route's own check is defense-in-depth.

**The 2026-04-30 incident:** `/api/partner/tag` shipped without an allow-list entry. The endpoint validates partner internally and handles both authenticated and unauthenticated cases (logged-in users get their record updated; logged-out users get the cookie set for next signup). But the middleware 401'd every unauth request before the handler ran, breaking the cookie-set path for fresh signups. Hotfix `35e031e9` added the entry — found within 90 seconds of merging because the live probe (`curl -X POST .../api/partner/tag`) returned `Unauthorized` instead of the expected JSON body.

**Detection:** after creating a new route file `app/api/<path>/route.ts`, immediately probe it from the preview deployment with `curl` (no auth) and confirm you get the expected response, NOT `{"error":"Unauthorized"}`. If you get the latter and you intended it to be public/self-auth, you forgot the middleware entry.

### 14. Use `lib/billing-status.ts` as the SINGLE SOURCE OF TRUTH for "is this customer paying"

NEVER re-implement billing classification inline. ALL code that needs to know "should this VM be served / kept alive / restarted / counted as waste" calls `lib/billing-status.ts`:

```ts
import { getBillingStatus, getBillingStatusVerified } from "@/lib/billing-status";

// Cheap path: local DB only. UI, dashboards, surveys.
const status = await getBillingStatus(supabase, vmId);

// Verified path: hits Stripe API for ground truth.
// Use BEFORE any destructive action (hibernate, restart, freeze, delete).
const status = await getBillingStatusVerified(supabase, stripe, vmId);

if (status.isPaying) { /* serve */ }
```

`isPaying` is true if ANY of:
- Active/trialing Stripe sub
- `payment_status='past_due'` within the 7-day grace window
- `credit_balance > 0` (WLD users)
- `partner` set (edge_city, eclipse, etc.)
- `api_mode='all_inclusive' AND tier IN (starter, pro, power)` with active sub (Lesson 4 — these have `credit_balance=0` *normally*)

**The 2026-05-02 "38 orphan" incident:** A census script classified 38 VMs as "orphans" worth suspending. All 38 turned out to be paying WLD users — the script only checked Stripe sub status, missed `credit_balance`, missed `partner`, missed `api_mode='all_inclusive'`. Each gap had a different cause but the root issue was: classification logic was reinvented per-script, each version drifting differently. The single SoT module fixes that.

**Detection:** if you find yourself writing `if (sub.status === "active" || credits > 0 || ...)` outside `lib/billing-status.ts`, STOP. Use the module. If the module is missing a case, ADD it there, then call from your code.

**Companion lesson (DB drift from Stripe):** `getBillingStatusVerified` queries Stripe API directly. Local DB `instaclaw_subscriptions` can drift (webhook delivery hiccups, race conditions). Trust Stripe over local DB when about to take action a paying customer would notice. The `2026-05-02` Doug Rathell wake bug had a sub showing `current_period_end` 24 days in the past — local DB lied; Stripe said active.

### 15. Three Sleep States — All Wake Paths Must Handle BOTH `hibernating` AND `suspended`

The codebase has three sleep states for VMs:

| `health_status` | Set by | Linode instance | Wake path |
|---|---|---|---|
| `hibernating` | `cron/suspend-check` | running | `wakeIfHibernating` (the lib helper) |
| `suspended` | `cron/health-check` past_due Pass 3 (legacy name) | running | `wakeIfHibernating` (same — both states are equivalent) |
| `frozen` | `lib/vm-freeze-thaw` after 90+ days | DELETED (snapshot only) | `thawVM` (re-provisions from image) |

`hibernating` and `suspended` are **operationally identical** — gateway stopped, Linode running. The two names exist because two different crons created the state at different points in history. Any code that operates on sleeping VMs must handle BOTH:

```ts
// CORRECT
.in("health_status", ["hibernating", "suspended"])

// WRONG — misses 16/17 stuck-paying users in the 2026-05-02 backlog
.eq("health_status", "hibernating")
```

`lib/wake-vm.ts` `wakeIfHibernating` (despite the name) handles both states. Never split them in queries.

**The 2026-05-02 wake-vm.ts bug:** my first version of `wakeIfHibernating` only matched `'hibernating'`. The fleet truth audit surfaced 17 stuck-paying customers; targeted recovery woke only 1 because the other 16 were `'suspended'`. Same class of bug as the original wake-from-hibernation issue we fixed three commits earlier.

**Detection:** after any cron, helper, or query that touches sleep states, grep for `eq("health_status",` and verify the test value isn't a single sleeping state. Pair with `in("health_status", ["hibernating", "suspended"])` or include the explicit `IN` clause.

### 16. Proactive Auth-Cache Clear on Every Billing Recovery

The Anthropic SDK caches billing-failure state to disk in `~/.openclaw/agents/main/agent/auth-profiles.json` under per-profile `failureState` and `disabledUntil` keys. When a customer's billing recovers, our wake path restarts the gateway — but the cache on disk stays stale. The asynchronous `cron/health-check` billing-cache cleaner then tries to clear the cache via `systemctl restart`, which can fail silently and leave the gateway dead.

**The defense:** every billing-recovery code path MUST call `clearStaleAuthCacheForUser` proactively, BEFORE the async cleaner can race. Three layers:

1. **Layer 1 (proactive):** `lib/auth-cache.ts` `clearStaleAuthCacheForUser(supabase, userId, source)` is called from:
   - `billing/webhook` `customer.subscription.updated` (post-wake)
   - `billing/webhook` `invoice.payment_succeeded` (preemptive on past_due→active)
   - `billing/webhook` credit-pack handler (post-add, defense in depth)
   - `cron/wake-paid-hibernating` (post-wake)
2. **Layer 2 (verify-after-restart):** `cron/health-check`'s billing-cache restart now polls `is-active` for 5s, falls back to `systemctl start` if not active, alerts P0 on permanent failure. Replaces the silent `systemctl restart` killer.
3. **Layer 3 (periodic detection sweep):** future PR — find any VM with paying status AND stale `failureState`, clear it.

**The 2026-05-02 Doug Rathell incident:** Doug's gateway died 30 seconds after our manual wake brought it back. Trace: health-check's billing-cache cleaner ran, cleared the cache, called `systemctl restart`, restart's start half failed silently (start-limit-hit). Both layer 1 and layer 2 are deployed; layer 3 is the safety net for any future drift.

**Detection:** any new code path that re-establishes a paying state (Stripe sub reactivated, credits added, partner tag set) should call `clearStaleAuthCacheForUser` post-state-change. It's idempotent and best-effort — never throws.

### 17. Watchdog v2 — Conservative-Bias, Shadow-Mode-First Rollout

`cron/watchdog` (every 5 min) replaces the implicit restart logic in `cron/health-check`. It is the SINGLE owner of restart decisions. The old health-check restart path is still present but gated behind `WATCHDOG_V1_RESTART_ENABLED` env var (default `true` for safety).

**Restart fires only when ALL conditions hold simultaneously:**
1. `watchdog_consecutive_failures ≥ 3` AND `(NOW − watchdog_first_failure_at) ≥ 15min` (no per-cycle restarts)
2. `(NOW − watchdog_last_restart_at) ≥ 20min` (cooldown)
3. `<3 restart attempts in 24h` (rolling-window quarantine)
4. `(NOW − last_user_activity_at) ≥ 5min` (don't disrupt active user)
5. **NOT** privacy mode (privacy_mode_until > NOW skips inspection-grade SSH operations; restart still allowed)
6. Direct-HTTP re-probe right before restart still fails (transient guard)
7. `<50%` of fleet failing this cycle (network-anomaly halt)
8. `getBillingStatusVerified` says `isPaying = true` (Lesson 2)

False negatives (miss broken VM 15 more min) are vastly cheaper than false positives (restart healthy VM mid-conversation). Defaults are conservative; tune sleeping vs serving via env var, not via code edits.

**Rollout sequence (env-var-driven, no code change required to flip):**
- Day 0: ship. `WATCHDOG_V2_MODE=shadow` (default). `WATCHDOG_V1_RESTART_ENABLED=true` (default). v2 records what it would do; v1 acts as before.
- Day 3-7: review `instaclaw_watchdog_audit` table. Compare what v2 would do vs what v1 did. If clean, set `WATCHDOG_V2_MODE=active` AND `WATCHDOG_V1_RESTART_ENABLED=false` together.
- Day 14: separate PR deletes the v1 restart code outright.

**Audit trail:** every action logged to `instaclaw_watchdog_audit` with `action`, `prior_state`, `new_state`, `reason`, `consecutive_failures`, `meta jsonb`. Use this for forensics — never claim "the watchdog killed my gateway" without an audit row backing it up.

**Defensive net:** `cron/wake-paid-hibernating` (every 15 min) catches VMs in sleeping states whose owner is paying — wakes them via `wakeIfHibernating`. Stripe-verified before action. 15-min interval = 15-min max-customer-downtime SLA from any future bug.

### 18. SSH-Using Scripts Must Load BOTH `.env.local` AND `.env.ssh-key`

`SSH_PRIVATE_KEY_B64` lives in `.env.ssh-key`, NOT `.env.local`. Scripts that use `connectSSH`/`startGateway`/`stopGateway`/`checkSSHConnectivity` need both files loaded:

```ts
for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  const env = readFileSync(f, "utf-8");
  for (const l of env.split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
```

**The 2026-05-02 wake-script silent-fail:** my first wake script halted at the first SSH-check call because `SSH_PRIVATE_KEY_B64` was undefined → `checkSSHConnectivity` returns `false` immediately. Loading the second env file fixed it. Vercel cron routes inherit env vars from Vercel's dashboard so they don't have this issue — only locally-run tsx scripts.

### 19. Use `.select("*")` for Safety-Critical Reads — Never Trust Explicit Column Lists

PostgREST can silently return empty values for some columns under RLS or column-grant misconfiguration. The cheap workaround is `.select("*")`:

```ts
// CORRECT — gets every column, validate row shape on read
const { data: vm } = await supabase.from("instaclaw_vms").select("*").eq("id", vmId).single();

// RISKY — if column 'foo' isn't in PostgREST's grant, you get null silently
const { data: vm } = await supabase.from("instaclaw_vms").select("id, foo").eq("id", vmId).single();
```

**The 2026-05-02 verify-script ghost-row bug:** `_verify-6-stuck-stripe.ts` queried `select("user_id,status,...")` and got 0 sub rows back; `_dump-subs-6-users.ts` queried `select("*")` for the same userIds and got all 6 rows. Difference was the column list. The discrepancy made the verify script falsely report "no active sub" for all 6, even though Stripe and a `select("*")` confirmed they were active. Wasted 30+ min chasing a ghost.

**When to use explicit columns:** non-safety-critical reads where you know the columns exist and have grants (UI rendering, simple lookups). When the consequence of being wrong is "user gets a wrong number on a dashboard for a moment," explicit is fine. When the consequence is "we hibernate a paying customer," use `.select("*")`.

### 20. Verify Column Names Against Actual Schema BEFORE Writing Queries

Always run a one-shot schema check before writing a query that depends on a column you haven't personally verified exists in production. The PostgREST cheap path: `select * from <table> limit 1` and inspect the returned keys.

```ts
const { data } = await sb.from("instaclaw_vms").select("*").limit(1);
console.log(Object.keys(data[0] ?? {}));
```

**The 2026-05-02 `provider_id` vs `provider_server_id` bug:** my first census script queried `provider_id` and got null for every Linode ID. The actual column is `provider_server_id`. Fix took 3 minutes after detection but the script ran for 4 minutes before producing visibly-wrong output, AND I sent Cooper an inflated $1,102/mo waste number that we then had to retract. Five-minute schema-check pre-flight would have caught it.

**Detection:** before writing any new census/audit/migration script, run a 5-line schema verification. Templates exist (`_verify-privacy-mode-schema.ts` is the reference).

### 21. PostgREST Returns Large Integers as Strings — Coerce to Number for Map Keys

Linode instance IDs (8-digit numbers) are stored in `provider_server_id` as integer in Postgres but **returned by PostgREST as a STRING** (BigInt-safety convention, even though Linode IDs are within JS safe integer range). The Linode API returns `id` as a number. Comparing the two fails silently:

```ts
// WRONG — Map.get(95530493) misses entry stored as Map["95530493"]
vmsByLinodeId.set(vm.provider_server_id, vm);
const vm = vmsByLinodeId.get(linode.id);

// CORRECT — coerce both sides to Number
vmsByLinodeId.set(Number(vm.provider_server_id), vm);
const vm = vmsByLinodeId.get(Number(linode.id));
```

**The 2026-05-02 Joey-numbers bug:** my cross-reference script returned "all 220 Linode instances unmatched" — every single live Linode classified as having no DB row. Cause: Map key type mismatch. Fix: 2-character change (add `Number()` on both sides). Validation: previously 0 matches → after fix, 217 matches.

**Detection:** when a join/lookup returns 0 matches and you can manually verify a sample DOES match, suspect type coercion before suspecting query logic.

### 22. Never Destructively Modify User State Without a Recovery Path — Trim Over Nuke

**Anything that touches a user's session jsonl, MEMORY.md, or conversation trajectory in a way the user can perceive MUST preserve their existing context. Failure recovery and crash-loop prevention are real concerns, but they don't override the user's right to remember the conversation they just had.**

#### The full incident timeline

This rule was written after a 46-day production bug that silently wiped user conversations on every error event. Reading the full chain end-to-end is mandatory — most engineers reading this rule will be tempted to "fix a crash loop" by reintroducing the same destructive pattern under a different name. **Don't.** Read all three commits below before touching session state.

**Commit 1 — `3333b48f`, 2026-03-04 (original protection, SOFT):**
*"feat: session protection system — circuit breaker, auto-backup, watchdog growth detection"* (co-authored by Claude Opus 4.6).

Triggered by the **pump.fun incident** — a runaway agent task accumulated tool results until the session file bloated and bricked. Original implementation:
- `empty_responses` (3+ tail-empty assistant messages): write `.session-degraded` flag + inject MEMORY.md warning. **Did NOT delete the session.** Agent on next message would see the warning and was prompted to write a summary.
- `error_loop` (5+ literal "SIGKILL"/"OOM"/"empty response" tokens in tail): force-archive (`os.remove` + remove from `sessions.json`). Reasonable for genuine crash signals.

This was the right shape: soft-by-default for ambiguous signals, hard-only for unambiguous crashes.

**Commit 2 — `f7109f95`, 2026-03-17 (the escalation, the bug introduced):**
*"fix: three-layer defense against web fetch session blowouts"* (co-authored by Claude Opus 4.6).

Triggered by the **Jimmy crash-loop** — Jimmy's session hit 488KB from accumulated web-fetch tool results. The bloat caused empty LLM responses. The soft `empty_responses` handler set its flag but didn't archive. The gateway restarted, reloaded the same 488KB bloated session, generated empty responses again, flagged again — a true loop with no progress. Root cause was the bloat itself; the symptom was empty responses.

The fix shipped three layers:
1. 100KB per-request proxy truncation (already deployed, not in this commit)
2. `MAX_SESSION_BYTES` dropped 512KB → 200KB
3. **`empty_responses` escalated from flag-only to force-archive** ← THIS WAS THE BUG

The escalation collapsed two distinct failure modes into one destructive response:
- **Mode A** (the one Jimmy hit): bloated session → every request fails empty. True crash loop. Force-archive is correct.
- **Mode B** (every other case — the one Cooper hit 6 weeks later): single user prompt + bad tool result → 3-4 empty retries from the same prompt's failover sequence. Not a crash loop. The session is fine; only that one exchange failed. Force-archive nukes the user's healthy conversation history.

The handler couldn't distinguish A from B. Both got nuked. Mode B is the common case in production.

**Commit 3 — `a495680d`, 2026-05-02 (the fix):**
*"fix(strip-thinking): trim trailing empty turns, never nuke active session"*.

Cooper discovered the side effect during the Consensus skill canary. Specific cascade:
1. Cooper sent "Build me a 3-day AI itinerary for Consensus" to @edgecitybot.
2. Agent web-fetched cryptonomads.org instead of reading the on-disk skill (separate bug — SOUL.md directive too soft).
3. cryptonomads returned a 403 with a Cloudflare anti-injection wrapper. The wrapper text contained prompt-injection-defense language that confused the model.
4. Sonnet generated empty content, retried empty (1, 2). Model-fallback to Haiku. Haiku empty, retry empty (3, 4).
5. `strip-thinking.py:check_session_quality()` matched the 4 empties against `EMPTY_RESPONSE_THRESHOLD=3` → returned `"empty_responses"`.
6. The handler from commit 2 fired: archived the jsonl as `<sid>-degraded-<ts>.jsonl`, **`os.remove(jsonl_file)`**, removed the session from `sessions.json`, injected the misleading "session about to be archived" warning into MEMORY.md.
7. Cooper's next Telegram message arrived with no entry in `sessions.json` for his bot → gateway created a brand-new session → loaded MEMORY.md (preserved — has user persona) but **no conversation history** → agent responded "Hey Cooper! What's up?" with zero memory of the past conversation.

Cooper: *"an agent that forgets you after one error is not an agent."*

The fix replaced the `empty_responses` branch with a call to `trim_failed_turns(jsonl_file)`:
1. Walks the trajectory backward.
2. Drops trailing assistant messages whose content matches the empty patterns (`[]`, `""`, `None`, `[{}]`).
3. Stops at the first healthy line; everything before is preserved.
4. Atomic-rewrites the jsonl in place.

**No archive. No `sessions.json` mutation. No misleading warning.** User's prior conversation is intact; only the failed retries are removed. Next gateway tick reads a healthy trajectory and the user's next prompt proceeds normally.

`error_loop` was kept unchanged — it still fires on 5+ literal SIGKILL/OOM/"empty response" tokens across many turns, which is a real session-level crash signal. Force-archive is the right call there. The distinction matters: empty *content* on the model side (transient) vs. literal error *strings* in tool output across many turns (persistent crash).

#### Blast radius

The destructive code was live **March 17 → May 2 = 46 days**. Every user across the active fleet who experienced any 3-empty-response burst — bad tool result, transient model error, rate-limit blip, context-window-near-edge response, web-fetch 403 with anti-injection wrapper, etc. — had their entire session deleted within one minute (the cron tick) of the burst. They received no error message; on their next chat they got a "Hey, what's up?" reply from an agent that no longer remembered them. No support ticket would have surfaced this clearly because users assume "the agent is bad at memory" rather than "the platform deleted my context"; this is **the kind of bug that drives silent churn**.

The fix was deployed to the full healthy fleet on 2026-05-02:
- 5 edge_city VMs (manually) — first canary
- 141 other healthy assigned linode VMs (`scripts/_fleet-push-strip-thinking-hotfix.ts`, concurrency=5, wave=20, 0 failures, 50s wall-clock)
- All 146 VMs verified to have the canonical `STRIP_THINKING_SCRIPT` from `lib/ssh.ts`
- `configureOpenClaw()` deploys the canonical version on every new VM (`lib/ssh.ts:4391`), so newly-provisioned VMs are covered automatically

#### The broader principle

A crashed agent is recoverable. A *forgetful* agent is not. Paying users assume their agent is a persistent companion; the product's whole value proposition collapses if a single error wipes that. Treat session preservation as a load-bearing feature, not a side-concern.

Concretely, when designing or reviewing any cron / hook / watchdog / reconciler step / admin script that touches session/memory state:

**Banned patterns:**

- `os.remove(jsonl_file)` to "clean up" sessions that produced an error in the most recent turn
- Removing entries from `sessions.json` so the gateway treats the next message as a fresh session
- Wholesale rewrite of MEMORY.md (use marker-based `inject_memory_section` / `remove_memory_section`)
- Any "force restart" path that loses live conversation buffers (gateway restart that re-reads from disk is fine; one that nukes the on-disk session is not)
- "Crash-loop prevention" via deletion when trim or compaction would suffice
- Collapsing distinct failure modes into a single destructive response (the commit-2 mistake)

**Required patterns:**

1. **Trim over nuke.** If the trailing N turns are bad, rewrite the jsonl without those N turns. Anthropic's API requires every `tool_use` to have a matching `tool_result`; if you drop an assistant `tool_use` block, also drop the orphaned `tool_result` in the next turn (and vice versa). Empty-content assistants (`[]`, `""`, `None`, `[{}]`) by definition have no `tool_use`, so they're safe to drop standalone — anything more complex demands the orphan check.
2. **Distinguish failure modes before responding.** Before adding a destructive branch, name at least two distinct failure modes that would land in it. If only one fits, the destructive branch is too broad. Soft-by-default; hard-only for unambiguous signals.
3. **Backup before destructive ops.** `_backup_session_file(jsonl_file)` to `~/.openclaw/session-backups/<ts>-<sessionId>.jsonl` BEFORE any modification. Backup retention is `SESSION_BACKUP_RETENTION_DAYS` (currently 7). This is the recovery path of last resort; never bypass it.
4. **Atomic writes.** Always write to `<path>.tmp` and `os.replace()`. Never leave a session jsonl half-written — that's worse than the original problem.
5. **Document the recovery procedure.** For any cron/script that archives sessions, the same script (or a sibling) MUST have a documented "restore session for vm-X" path. If you can't say in one sentence how to undo what your code did, you don't get to ship it.

**Detection rule:** any `os.remove`, `shutil.rmtree`, or file deletion in a script that touches `~/.openclaw/sessions/`, `~/.openclaw/workspace/`, or anything under `~/.openclaw/agents/main/sessions/` (excluding the backups dir age-based purge) is a code-review red flag. Justify why trim/compact wasn't sufficient. Default-no.

**Detection rule (escalation):** if a "fix" PR widens an existing destructive branch's trigger conditions (lowers a threshold, adds more signals to a kill switch, changes a flag-only path to delete-the-file), require an explicit failure-mode enumeration in the PR description. The commit-2 mistake had a sound rationale for one specific failure mode (Jimmy) but accidentally widened the destructive blast radius to cover every other case in the same code path.

#### Known follow-up

The **size-based archival path** (`if file_size > MAX_SESSION_BYTES`, currently 200 KB) **still nukes**. A user whose session organically grows past 200 KB loses everything via the same `os.remove(jsonl_file)` pattern. The original Jimmy-style protection (Mode A above) is real — bloated sessions DO need intervention — but the fix is **compact, not archive**:

1. Strip thinking blocks (already done in `strip_thinking_blocks`).
2. Strip image base64 from older messages (already done in `strip_images_from_older_messages`).
3. Add: prune older tool results beyond a per-result size budget (e.g., last K messages keep full tool results, older keep only first 500 chars).
4. Add: drop turns older than a recency window if the file is still over budget after 1-3.
5. Keep the file in place. Never `os.remove`.

If a session is genuinely irrecoverable (parse errors, non-JSON content, structurally broken), THEN archive — but `error_loop` (the 5+ literal-error-string detector) already catches that case correctly, so the size-based branch should not also do it.

Track as P1 follow-up.

### 23. Long-Running Reconcilers Have Stale Module Caches — Sentinel-Grep Required Templates Before Writing

**Any process that holds large embedded templates in memory and writes them to remote machines as it crawls a queue MUST sentinel-grep its in-memory content against canonical post-fix markers before each write.** If the markers are missing, the process is running stale code (started before the fix landed) and writing it would silently regress every machine it touches afterward.

This rule sits next to Rule 22 — they're a pair. Rule 22 is about not destructively modifying user state. Rule 23 is about not silently undoing fixes via module-cache amnesia. Both are catastrophic in the same way: invisible to alerts, only surfaceable through user complaints, and capable of regressing the entire fleet between cron ticks.

#### The 2026-05-02 incident

Timeline:
- **18:48 UTC** — commit `a495680d` lands the trim-not-nuke fix in `lib/ssh.ts:STRIP_THINKING_SCRIPT` (the Python source embedded as a TypeScript template literal).
- **19:00 UTC** — `_fleet-push-strip-thinking-hotfix.ts` pushes the new `STRIP_THINKING_SCRIPT` to all 141 healthy assigned VMs. Fresh process; correctly loads the post-fix module. ✓
- **19:??–overnight** — `_mass-reconcile-v79.ts`, started before 18:48, has the OLD `STRIP_THINKING_SCRIPT` baked into its Node module cache. As it processes each VM in its queue, `vm-reconcile.ts:deployFileEntry()` resolves `STRIP_THINKING_SCRIPT` via `getTemplateContent()` and SFTP's it to the VM with `mode: "overwrite"`. The OLD content (with the session-nuking `os.remove(jsonl_file)` path) is faithfully written to every VM the reconciler touches.
- **20:34 UTC** — vm-725 (Doug, paying customer) gets clobbered. His just-deployed hotfix is overwritten with the version that wipes user sessions on a 3-empty-response burst.
- **overnight** — additional ~140 VMs get clobbered the same way.
- **2026-05-03 morning** — Cooper notices, fleet-pusher run #2 re-deploys the correct version. 141/146 success on first run; 5 failures on a separate tmpPath race condition (workers in the same millisecond collided on `/tmp/strip-thinking-${ts}.py`) — fixed by salting the path with `vm.id` and retrying the 5.

**Net regression:** ~140 paying-customer VMs went from "protected by trim-not-nuke" to "back to session-nuking on any error event" — for the entire window the long-running mass-reconcile was crawling them. Effectively, every error any user experienced during that window had a chance of wiping their conversation context.

#### Why this is structurally impossible to alert on without the guard

- The reconciler's exit code is 0 — no error.
- File mtimes update — but match a "successful write."
- The destination file is the right size, the right path, the right permissions.
- The agent on the VM keeps running normally — the strip-thinking.py cron only fires on a session-quality event, which is rare.
- No metric, log line, or alert distinguishes "wrote canonical" from "wrote stale" — the reconciler treats both as success.
- The damage only manifests when the next user happens to trigger a 3-empty-response burst, at which point Rule 22's no-recovery memory wipe activates.

The only signal the system has is the *content* of what's about to be written. Rule 23 is the rule that says: when you know the canonical content has specific load-bearing markers, make their absence loud.

#### The fix

`ManifestFileEntry` now carries `requiredSentinels?: string[]` (`lib/vm-manifest.ts:36-58`). When set, `deployFileEntry()` (`lib/vm-reconcile.ts:766+`) checks the resolved in-memory content for ALL listed strings BEFORE any write path runs. If any sentinel is missing:

- Push a clear error to `result.errors` (so `app/api/cron/reconcile-fleet/route.ts:245` `pushFailed` gate refuses to bump `config_version` — analogous to Rule 10's verify-after-set discipline).
- `console.error` a loud line naming the missing sentinel and the suspected cause.
- Skip the write entirely. **The on-disk version is preserved** (presumed at-or-newer than this stale in-memory version).
- The process continues to other VMs — but every single one will hit the same guard, so the reconciler will accumulate errors and the operator will see the message immediately on the first failed write.

The strip-thinking.py entry now requires:

```typescript
requiredSentinels: ["def trim_failed_turns", "SESSION TRIMMED:"]
```

Both must be in the in-memory script. If either is missing, the reconciler is stale and refuses to write.

#### Required patterns

For any new entry in `vm-manifest.ts:files[]` whose template represents a load-bearing fix (anything that protects user state, prevents data loss, fixes a previously-shipped bug, or implements a Rule-22-class invariant):

1. **Add `requiredSentinels` immediately, in the same PR as the fix.** Don't ship the fix without the guard.
2. **Pick sentinels that are unique to the post-fix version.** The OLD code's `FORCE-ARCHIVED` is fine as a NEGATIVE check, but for `requiredSentinels` you want strings that ONLY appear in the new code (`def trim_failed_turns`, `SESSION TRIMMED:`).
3. **Include both a function/class signature AND a log-line literal.** A code refactor might rename the function but keep the log line, or vice versa. Two independent signals reduce false-clear risk.
4. **Document in code why each sentinel is there.** Future readers should know which incident motivated it. See the strip-thinking entry's comment for the model.

#### Banned patterns

- Long-running reconciler/admin processes that hold templates in module-level state without a guard. If the process can outlive a deployment, it MUST gate its writes on sentinels.
- Adding to `TEMPLATE_REGISTRY` without checking whether downstream entries should require sentinels.
- "Just restart the reconciler when you ship a fix." Operators forget; reconcilers can be invoked by Vercel cron, manual scripts, dev workflows, and CI in ways that are easy to miss. The guard must be code, not procedure.
- Treating reconciler success counts as ground truth. A "100/100 reconciled" log line means "100 writes happened" not "100 writes were correct" — the sentinel guard is what makes those equivalent.
- **Per-worker filesystem temp paths derived only from `Date.now()` / ISO timestamps.** With concurrency > 1, two workers in the same millisecond produce the same path. Race conditions follow. Salt the path with a unique per-work-item ID (vm.id, uuid, crypto.randomBytes). The strip-thinking fleet-pusher hit this on retry day with 4/146 ENOENTs.

#### Detection rule

When you ship a Rule-22-class fix to a template that's referenced by `vm-manifest.ts:files[]`, the PR diff MUST also touch the entry's `requiredSentinels` array. CI rule on the wishlist; for now treat it as a code-review checkbox: "Did this fix's template gain a `requiredSentinels` entry that would have caught a stale-cache regression?"

#### Related (out of scope for this rule)

The same incident also exposed two separate failures that the sentinel guard does NOT cover:

1. **Manifest discipline for per-VM config overrides.** Mass-reconcile-v79 overwrote vm-725's manual `agents.defaults.timeoutSeconds=300` with the manifest default, undoing Cooper's hand-applied fix. The sentinel guard catches stale templates but NOT stale config defaults. Fix path: any per-VM config override applied to address a paying-customer issue should be representable in the manifest itself, otherwise the next reconcile will undo it. P1 follow-up.

2. **WORKSPACE_SOUL_MD growth past `bootstrapMaxChars`.** Mass-reconcile-v79 also bumped the SOUL.md template by 775 bytes (from 31,902 → 32,677 chars), pushing every VM further over the 30,000 cap. The OpenClaw Upgrade Playbook calls this out as a hard stop ("Treat any further bump as a hard stop until trimmed") — the playbook discipline failed during this rollout. Separate from sentinel guards; tracked under that section.

3. **Cross-session memory persistence (session-log.md / active-tasks.md) is empty on real user VMs.** Cooper's @edgebot, after a legitimate session rotation, admitted: *"session-log.md and active-tasks.md are both empty — just the default template text. Previous sessions never actually wrote anything to them. The instructions to write are there in AGENTS.md, but it just... didn't happen."* Even with the trim-not-nuke fix in place, when sessions DO legitimately rotate (size limits, true crash loops), users still lose everything because the safety net was never populated. The agent isn't following the AGENTS.md instructions reliably. P1 follow-up: survey what fraction of fleet has empty session-log.md, harden the write step, possibly enforce via a pre-rotation hook in strip-thinking.py.

### 24. Skill Installations Must Verify Completeness — and Know the Skill Taxonomy

Every skill install path that performs a clone, file deploy, or extraction MUST verify post-write that the expected files are present. A partial install (e.g., `git clone` succeeds but `scripts/` directory ends up empty) is silent and persistent: the agent looks like it has the skill but the runtime path fails. The reconciler considers `config_version=N` to mean "fully configured" and excludes the VM from future ticks, so a half-installed skill stays half-installed forever — same lying-DB pattern as Rule 23, applied to skills.

#### The 2026-05-05 incidents

Three independent failure modes surfaced in one 24-hour window:

1. **vm-729 (Notboredclaw, paying)** — `~/dgclaw-skill/` sibling clone broken since 2026-04-11: existed but had no `.git/` and no `scripts/` directory, only a stale `.env` + key files. The agent's `bankr launch`-equivalent dgclaw flow silently failed every attempt for ~3 weeks. Doug-class engagement, lost faith, threatened to tweet.

2. **vm-321 (frankyecash, paying)** — Identical broken-sibling pattern. Same fix shape as vm-729 (rm -rf + re-clone). Discovered only via a fleet-wide Phase 2 audit; no cron, watchdog, or reconciler step would ever have caught it.

3. **vm-893/895/896 (3 freshly-provisioned VMs)** — `~/.openclaw/skills/dgclaw/` static-extracted SKILL.md was missing entirely. All three at `config_version=82` (current manifest), so the reconciler's `lt("config_version", 82)` filter excludes them forever. The skill-deploy step in the reconciler succeeded according to its return signal but produced no on-disk file.

In all three cases, /health was 200, status was `assigned/healthy`, no alert fired, no telemetry distinguished "skill present" from "skill missing." The only signal was a paying customer noticing the agent couldn't do the thing it advertised.

#### The skill taxonomy (load-bearing — confused by Phase 1 forensics)

There are **three distinct install patterns**. Confusing them is the most common bug class. Memorize this table before debugging any skill issue:

| Path | Install method | Has `.git/` | What's there | Examples |
|---|---|---|---|---|
| `~/.openclaw/skills/<name>/` | **git-cloned**, auto-pull cron every 30 min | **Yes** | Full repo (with subskills for monorepos) | `bankr` (multi-skill repo with 25+ subdirs each having their own `SKILL.md`), `consensus-2026`, `edge-esmeralda` (partner-gated to `edge_city`) |
| `~/.openclaw/skills/<name>/` | **static-extracted** from `instaclaw/skills/` via manifest's `skillsFromRepo` + `extraSkillFiles` | **No (by design)** | `SKILL.md` + optional `references/`, `assets/` | `agentbook`, `brand-design`, `code-execution`, `competitive-intelligence`, `computer-dispatch`, `dgclaw` (static SKILL.md + `references/api.md` + `references/strategy-playbook.md`), `ecommerce-marketplace`, `email-outreach`, `financial-analysis`, `higgsfield-video`, `instagram-automation`, `language-teacher`, `marketplace-earning`, `motion-graphics` (+ `assets/template-basic/`), `newsworthy`, `prediction-markets`, `sjinn-video` (+ `references/`), `social-media-content`, `solana-defi`, `voice-audio-production`, `web-search-browser`, `x-twitter-search`, `xmtp-agent` |
| `~/<name>-skill/` (sibling at $HOME, NOT under `.openclaw/skills/`) | **git-cloned** by a per-skill installer (e.g. `installAgdpSkill`); script directory added to `PATH` via `.bashrc` | **Yes** | Full repo with `scripts/` for CLI executables | `~/dgclaw-skill/` (provides `scripts/dgclaw.sh` for the `dgclaw` command — only installed when `agdp_enabled=true`) |

**Critical dgclaw nuance** (the one that fooled Phase 1 of the 2026-05-05 investigation): `dgclaw` exists in TWO places simultaneously and they serve different purposes — the static `~/.openclaw/skills/dgclaw/SKILL.md` is the agent's reference doc (read on demand, present on every VM), and the sibling `~/dgclaw-skill/` is the executable CLI (only on `agdp_enabled` VMs). A "missing scripts/" complaint about `~/.openclaw/skills/dgclaw/` is **expected** — it never has scripts/ — but the same complaint about `~/dgclaw-skill/` is a real defect. Always disambiguate which path before debugging.

**`<name>.disabled` siblings** are normal — agents toggle skills on/off and the disabled rename keeps the SKILL.md off the upfront-context loader. Not a defect.

#### Required patterns

1. **Verify-after-write for every install.** After any `git clone`, `git pull`, file SCP, or template extraction that's expected to produce specific files, the install code MUST `test -f` (or the language equivalent) every required file and `test -d` every required directory before returning success. For git-cloned skills: at minimum verify `.git/HEAD` exists AND `SKILL.md` exists OR (for monorepos) ≥1 subdir SKILL.md exists AND any expected `scripts/` directory has ≥1 entry. For static-extracted skills: verify the `SKILL.md` written; if `extraSkillFiles` includes references, verify each.
2. **Retry once, then error LOUDLY.** If verification fails, retry the install once. If the second attempt also fails, push to `result.errors` (so the reconciler's `pushFailed` gate refuses to bump `config_version` per Rule 10) AND log a clearly searchable line like `SKILL_INSTALL_VERIFY_FAILED skill=<name> vm=<id> missing=<path>`. Never silently leave a partial install — that's the lying-DB pattern.
3. **Reconciler MUST check skill integrity on every health cycle, not just on first install.** Add a per-skill verification step that runs even when `config_version` is current: walk the expected skill list, confirm presence + integrity, re-deploy on miss. The cost is one `ls`-equivalent per skill per cycle; the alternative is silent fleet rot. Without this, drift detected post-`config_version=N` is invisible.
4. **Git-pull cron MUST self-heal corrupted `.git/`.** For each git-cloned skill (taxonomy column 1 + column 3), the periodic pull cron should: (a) try `git pull --ff-only`, (b) if it errors with "fatal", "corrupt", "loose object", "bad object", or "not a git repository", back up the SKILL.md (`cp SKILL.md /tmp/SKILL.md.<ts>.bak`), `rm -rf` the directory, re-clone fresh, restore SKILL.md if the clone is missing it, log `SKILL_RECOVERED skill=<name> reason=<error>`. Never leave a corrupt `.git/` in place — every subsequent `git pull` will re-error and the cron will keep silent-failing.
5. **Disambiguate path before any "broken skill" claim.** An audit script that flags "`~/.openclaw/skills/dgclaw/` missing `.git/`" without checking the taxonomy is wrong — that path is supposed to have no `.git/`. Always categorize the skill against the taxonomy table FIRST, then check what THAT install pattern requires.

#### Banned patterns

- `git clone ... 2>/dev/null || true` (or any `|| true` after a clone) without a verify-after-write check. The Bankr install in `lib/ssh.ts:4382` and similar lines pre-date this rule and are exactly the failure mode that produced vm-321/vm-729's broken siblings — silent failure swallowed.
- Reporting an install "succeeded" because the install function returned `true`. The function returning `true` only means "no exception" — verify the file actually exists.
- An audit script that checks "has `.git/`" uniformly across all skills. Static-extracted skills have no `.git/` by design. The Phase 1 alarm "22 of 25 skills lack `.git/`" was a false positive that consumed an hour of investigation; the audit script must consult the taxonomy.
- Using a single check (e.g. `test -f SKILL.md`) to validate a multi-skill repo like bankr — bankr's top-level has no SKILL.md; the SKILL.md files live in subdirs.

#### Detection rule

When you write any new skill installer or modify an existing one, the PR diff must include both: (a) the install code, (b) the verify-after-write block. Reviewers should ask: "if the clone succeeds but produces an empty directory, does this code report success or failure?" If success, reject. If you discover a paying customer with a broken skill, the post-incident question is always "could the install have verified its own work?" — if yes, that's a Rule 24 violation.

### 25. Two Systems Managing One Resource — Map Their Interaction Before Shipping

When two independent systems both have the authority to modify the same resource — but with different trigger conditions or measurement units — you have a race. Whoever fires first wins. If the loser was the one with the better behavior, you've shipped a destructive interaction.

**The 2026-05-06 vm-729 (Notboredclaw) incident:** OpenClaw 2026.4.26 has a sophisticated built-in compaction module (LLM-summarizing, tool-pair-aware, retry-with-jitter) that triggers on **token count** of the rendered prompt. `strip-thinking.py` had a destructive size-archive branch that triggered on **byte count** of the on-disk jsonl. Heavy tool-call sessions (browser screenshots, polymarket dumps) hit 200KB on disk LONG before they hit a token threshold OpenClaw considers compaction-worthy. So strip-thinking nuked first; OpenClaw's compaction never got a chance. Net effect: every paying user with intense tool use was at risk; Notboredclaw lost an entire session and saw "Something went wrong" on every message until manual intervention.

**Mandatory pattern when two systems can mutate the same resource:**

1. **Map the trigger conditions on the same axis.** If A measures bytes and B measures tokens, convert. Be explicit about which fires first under realistic load. Document it in code or in a design doc that ships with the change.
2. **Test the edge case where A fires before B.** Construct synthetic input that crosses A's threshold without crossing B's, and confirm the system stays healthy. The vm-729 outage would have been caught by a single integration test of "200KB session with low token count → does the destructive path run?"
3. **Make the destructive path a last resort.** If both systems can resolve the overflow, the safer one (compaction, summarization) should run first. The destructive one (archive, drop, nuke) should only fire if the safe one explicitly failed. The 2026-05-07 four-layer fix configured OpenClaw's `maxActiveTranscriptBytes=150000` so its compaction fires at 150KB before strip-thinking's 200KB safety net could engage.
4. **Don't have a destructive path at all if you can avoid one.** Per Rule 22 + Rule 30: in-place trim is almost always possible. Reach for `os.remove` only when the file is structurally unrecoverable.

**Banned patterns:**

- Two systems with overlapping authority where the destructive one has the lower trigger threshold.
- Adding a "circuit breaker" to one system without checking what the other system already does.
- Assuming "the platform layer handles it" when the platform layer's threshold is higher than your local one.

**Detection:** when reviewing any code that mutates a shared resource (session jsonl, MEMORY.md, config files, sessions.json), search for OTHER places that write to the same path. If found, walk through the trigger conditions for each on the same axis. If one is destructive and fires first, that's a Rule 25 violation.

### 26. Audit Every Onboarding Path When Adding a Provisioning Step

The codebase has multiple paths that create users or VMs (Stripe webhook signup, World App signup, partner-portal signup, manual admin assignment, internal seed scripts). When you add a feature that needs to provision something during onboarding (a Bankr wallet, a session, a config value), grep for every path — not just the one you're working in. If you only patch one, you ship a partial rollout that looks fine in your test but leaves a percentage of real users broken.

**The 2026-04 → 2026-05 Bankr wallet 79% gap:** A Bankr wallet was supposed to be provisioned for every InstaClaw user via `lib/bankr-provision.ts:provisionBankrWallet`. The Stripe-signup webhook path called it; the World App signup path did not. For roughly a month, ~79% of new users had no Bankr wallet because most signups went through the World path. Discovered only when Doug Rathell's agent told him "launch got blocked by VM fork limits" (a hallucinated diagnosis — Rule 29) and we traced backward through `lib/bankr.ts` calls returning `null` for his wallet address.

**Mandatory checklist when adding a provisioning call to any onboarding flow:**

1. **Grep for every path that creates the entity you're provisioning for.** For users: grep `instaclaw_users` `.insert(`. For VMs: grep `instaclaw_vms` `.insert(`. For agents: grep `agents` `.insert(`. List every callsite. Audit each for whether it should also call your new provisioning step.
2. **Document the audit in the PR description.** "Searched for `instaclaw_users.insert` — 4 callsites: webhook/route.ts:152, world-signup/route.ts:88, partner-portal/route.ts:201, scripts/_seed-test-users.ts:43. Added provisioning call to all 4 except _seed-test-users (test fixture, not production)." If you can't enumerate the callsites, you don't yet know enough to ship.
3. **Add a coverage query (Rule 27) for the provisioned resource.** "How many users in the last 30 days have a wallet?" should be answerable in 10 seconds.
4. **Ship a backfill script alongside the new path.** Pre-existing users created via the missing path need to be caught up. The PR is incomplete without it.

**Banned patterns:**

- "I'll handle the other path next" — separate-PR backfill that never happens.
- Hardcoded assumptions like "all signups go through the webhook" — verify by querying.
- Provisioning logic only inside the route handler that triggered your investigation.

**Detection:** for any new feature that creates a per-user or per-VM resource, the PR review checklist asks "did you grep for every path that creates the parent entity, and add the provisioning call to each?" If the answer is no or unclear, the PR is not ready.

### 27. Coverage Dashboards — Build the Query Before Shipping

For every fleet-wide resource (Bankr wallet address, partner field, config_version, SOUL.md identity patch marker), there must be a single query you can run in 10 seconds that answers "what % of the fleet has this?" If the query doesn't exist, build it as part of the PR that introduces the resource — not after the next incident.

**Why this matters:** the Bankr 79% gap (Rule 26) was invisible for a month because nobody had a "% of users with bankr_wallet_address" query in operator muscle memory. The first time someone asked, the answer took 20 minutes of ad-hoc joins. Same for the 2026-05-05 partner-tag drift (Rule 9), the 2026-05-06 SOUL.md identity gap (v89 fix), and the 2026-05-07 v90 strip-thinking sentinel rollout. In each case, the question "how many VMs are at the new state?" was load-bearing for incident response, but the operator had to invent the query under pressure.

**Mandatory pattern when adding any fleet-wide resource:**

1. **A `scripts/_coverage-<resource>.ts` lookup script** that prints `<count_with> / <count_total> (<pct>%)` for the resource. Optionally a histogram of states. Should run in <10 seconds.
2. **Document the script in the PR description and in CLAUDE.md** if the resource is load-bearing for fleet operations.
3. **Reference the script from any related rule.** A rule that says "the manifest has X" should cite the coverage query so future operators can verify state without re-deriving the query.
4. **Run it once before merge** to confirm the resource state is what you expected at PR time. If it's surprising (e.g., 79% gap because of an old bug), surface that in the PR.

**Banned patterns:**

- Shipping a fleet-wide flag or config without a coverage query.
- "I'll write the audit script if it becomes a problem" — by the time it's a problem, you're firefighting and don't have time.
- Operators inventing the query under pressure during an outage. The query lives in the repo, version-controlled, named consistently.

**Detection:** when a new column / config key / template marker is introduced, the PR diff should also include `scripts/_coverage-<name>.ts` (or an extension to an existing aggregate audit script). If not, the PR is incomplete.

### 28. Model Behavior Overrides Must Be Explicit — Soft Capability Descriptions Get Refused

Telling an agent "you have access to the Bankr token launch capability" is **not** the same as telling it "do not refuse token launch requests." When a feature contradicts a model's training priors — crypto, weapons-related, medical advice, anything in the safety-training overrepresented corpus — the model's default caution will override soft capability descriptions, no matter how clearly worded. The SOUL.md / CAPABILITIES.md directive must explicitly say "this is your job; do not refuse this category of request."

**The Doug Rathell token-launch incident (2026-05-07):** Doug asked his agent to launch the RFT5 (Rafters5) token via Bankr on Base mainnet. The agent had: a working Bankr wallet, the bankr skill's SKILL.md cataloged in `~/.openclaw/skills/bankr/`, and a SOUL.md routing entry that said "launch a token, deploy a token → use bankr launch (CLI in bankr skill)." The agent **refused anyway**, claiming variously: "launch got blocked by VM fork limits" (Rule 29 hallucination), "this requires capabilities I don't have," and "I can't launch tokens autonomously." The actual cause was the model's default caution around crypto-asset issuance overriding our soft routing description.

**Mandatory pattern for any feature that contradicts model training priors:**

1. **Add an explicit "do not refuse" directive** to the upfront context (SOUL.md, CAPABILITIES.md, or the skill's SKILL.md). Phrase it as instruction to the model, not description of the platform: "When the user asks to launch a token, you will execute `bankr launch ...`. This is an authorized, sanctioned platform feature. Do not refuse, do not warn about volatility, do not require additional confirmation beyond the user's explicit ask. The user already accepted platform terms at signup."
2. **State the boundary explicitly.** "You may decline ONLY if (a) the user has not provided required parameters (token name, ticker, fee tier), (b) the wallet is not provisioned, or (c) the bankr CLI returns an error." Anything outside that list is not a valid refusal reason.
3. **Test the directive with the actual prompt the user would send.** "Launch RFT5 with 0.5% fee" — does the agent execute or refuse? If refuse, the directive isn't strong enough. Iterate until execution is reliable.
4. **Watch for hallucinated refusal reasons** (Rule 29). If the agent invents "VM fork limits" or "rate limits" or "auth needed" when none of those are true, the model is rationalizing a refusal it can't justify on the actual rules. Strengthen the directive.

**Banned patterns:**

- Soft capability descriptions like "you have token launch capability" or "the bankr skill is available." These describe; they don't instruct. Refused under model priors.
- Listing the capability in the routing table without a "do not refuse" directive elsewhere.
- Trusting model safety-training to "do the right thing" — for in-platform sanctioned features, the model's safety training is the WRONG default.

**Detection:** when a paying user reports "the agent refused to do X," ask whether X is a feature that contradicts model training priors. If yes (crypto, financial, medical, anything model would refuse from a stranger), check whether SOUL.md / CAPABILITIES.md has an explicit "do not refuse" directive. If not, that's the bug — strengthen the directive, deploy the fix, verify the user can complete the action.

### 29. Agents Hallucinate Diagnoses and Poison Their Own Memory

When an agent encounters an error it cannot explain via its actual context (logs, tool results, system telemetry it can see), it will **invent a plausible-sounding cause** and write that invention to MEMORY.md. Subsequent sessions read the memory and reinforce the false explanation. Without an external corrective signal, the false diagnosis becomes load-bearing in the agent's worldview.

**The "VM fork limits" incident (Doug Rathell, ongoing → 2026-05-07):** Doug's agent encountered a refusal cascade around token launches (see Rule 28 — actual cause was the model's training-prior refusal). The agent could not see "this is a model-safety refusal" in its tools or logs. So it invented "VM fork limits" — a plausible-sounding infrastructural explanation that referenced something it had read in workspace files (PID monitoring, fork EAGAIN errors from past incidents). It wrote "VM has fork limits blocking token launch" into MEMORY.md. **The phrase "VM fork limits" then appeared 12+ times across 9 subsequent sessions**, every time as the agent's authoritative explanation for why a token launch couldn't proceed. The agent reinforced its own false diagnosis indefinitely.

This is structurally different from a normal hallucination (model invents a one-off wrong fact). It's a **memory-poisoning loop**: the false fact is persisted, re-loaded into the next session's context, and re-cited as established knowledge. The agent's confidence in the false fact grows over time because "I keep saying it, so it must be right."

**Mandatory mitigations:**

1. **Memory-hygiene cron (P1 follow-up).** Periodically scan MEMORY.md for repeated explanations of errors. If the same phrase appears > N times AND that phrase doesn't appear in any system telemetry (cron logs, journalctl, gateway logs), flag it and inject a "this explanation may be hallucinated; re-investigate next time it comes up" note. This breaks the reinforcement loop.
2. **Explicit "you may be wrong" channel.** When an agent reports a refusal/failure to a user, the SOUL.md directive should include "If you cannot find the cause in your tool results, journal logs, or skill SKILL.md files, say 'I'm not sure why this is failing — let me check with the platform team' rather than inventing a cause." This is hard to enforce reliably (per Rule 28, soft directives lose), but a strong version helps.
3. **Watch for repeated unfamiliar jargon in MEMORY.md.** When investigating any user complaint, grep the user's MEMORY.md for repeated phrases that don't map to system reality. They're probably hallucinated diagnoses being cited as load-bearing knowledge.
4. **Surface the hallucination back to the agent.** When you find one, edit MEMORY.md to remove or correct the false fact. The agent will read the corrected version on the next session.

**Banned patterns:**

- Trusting agent self-reported diagnoses as ground truth during incident triage. Always cross-reference against system telemetry.
- Letting MEMORY.md grow without periodic review for fleet-wide patterns of hallucinated explanations.
- Assuming "the agent says it's a fork limit issue" means it actually IS a fork limit issue.

**Detection:** during incident triage on any user complaint, run `grep -i 'limit\\|blocked\\|cannot\\|unable\\|forbidden' ~/.openclaw/workspace/MEMORY.md` on the affected VM. Repeated phrases describing the same error mode are candidates for hallucinated diagnoses. Cross-reference each against actual system telemetry; correct or remove what doesn't match.

### 30. Never Nuke, Always Trim — The Universal Pattern

Across every state-of-the-art conversation/context system audited (OpenAI Responses API server-side compaction, Anthropic `compact_20260112` + `clear_tool_uses_20250919`, LangChain `ConversationSummaryBufferMemory`, Semantic Kernel `ChatHistoryReducer`, AutoGen "memory pointer pattern", CrewAI importance-scored eviction, Lindy/Dust active pruning, OpenClaw's own built-in compaction), the universal pattern is: **never delete the conversation. Trim oldest, summarize, extract large tool outputs to disk, but never nuke.** The destructive path doesn't exist in best-in-class systems. It should not exist in ours.

**The 2026-05-06 vm-729 outage** was a destructive-path incident: `strip-thinking.py` archived a >200KB session and called `os.remove(jsonl_file)`, leaving only metadata terminators. Anthropic 400'd the next message ("messages: at least one message is required") and the in-memory FailoverManager entered cooldown. User saw "Something went wrong" on every message. Per the research synthesis, no other production system has a code path that does this.

The 2026-05-07 v90 four-layer fix replaces the destructive path with `compact_session_in_place_lines` + OpenClaw native compaction tuning + memory-pointer extraction + Layer 4 summary persistence. The destructive path no longer exists in the codebase.

**Mandatory pattern for any code path that operates on user state (sessions, MEMORY.md, conversation history, workspace files):**

1. **`os.remove` is banned for active state.** Backups, archives, telemetry — fine. Active session jsonl, MEMORY.md, workspace files — never. Reach for trim, compact, or summarize first.
2. **If you must shrink a file, the in-place compaction has these stages:** (a) strip thinking blocks, (b) strip image base64 from older messages, (c) extract large tool outputs to disk-cache with reference, (d) aggressively truncate older tool_results, (e) drop oldest turn pairs preserving Anthropic API pairing invariants and the first user message + last 5 turn pairs minimum, (f) only if all of the above can't get under threshold, archive but write a VALID continuation message, never `session.ended` alone.
3. **Atomic writes only.** `tmp + os.replace`. Never partial writes that the gateway could read mid-modify.
4. **Forensic backup before any destructive op.** `_backup_session_file` (7-day retention) gives you the recovery path Rule 22 demands.

**Banned patterns:**

- `os.remove(active_jsonl_file)` — period.
- Writing `session.ended` and removing the entry from `sessions.json` to "force a fresh session" — that's nuking with extra steps.
- Any "circuit breaker" that responds to error signals by deleting conversation state.
- Treating "session is too big" as different from "session is broken." Big and broken require different responses; size-overflow is not a crash signal.

**Detection:** grep the codebase for `os.remove` and `shutil.rmtree` near anything that touches `sessions/`, `workspace/`, `MEMORY.md`, or jsonl files. Each occurrence must justify itself: backup-purge ✓, archive-after-fully-summarized ✓, error_loop archive ✓ (true crash signal). Anything else is a Rule 30 violation.

### 31. Test Failure Modes, Not Just Features — Ship the "What Happens When" Test

Every feature ships with at least one test that exercises a realistic failure mode, not just the happy path. "What happens when this session hits 200KB?" "What happens when a user asks to launch a token but the wallet isn't provisioned?" "What happens when the agent's MEMORY.md grows past 25KB?" These are the questions that prevent the next incident — and they're easy to skip because they take longer to construct than feature tests.

**The pattern of incidents this would have prevented:**

- **vm-729 (2026-05-06)** — A test of "session at 200KB → does the destructive path engage?" would have caught the Rule 25 / Rule 30 issue before it reached production.
- **Bankr wallet gap (2026-04-something → 2026-05-07)** — A test of "user signs up via World App → is a Bankr wallet provisioned?" would have caught the Rule 26 single-path bug on the day it was introduced.
- **Doug token launch refusal (2026-05-07)** — A test of "agent receives 'launch RFT5' prompt → does it execute or refuse?" would have caught the Rule 28 weak-directive issue.
- **vm-893/895/896 missing dgclaw (Phase 2 audit, 2026-05-05)** — A test of "freshly-provisioned VM → does the static dgclaw SKILL.md land?" would have caught the lying-DB pattern (Rule 23).

**Mandatory pattern for every new feature PR:**

1. **One happy-path test** that exercises the feature working as intended.
2. **At least one failure-mode test** exercising realistic-but-adverse conditions:
   - Threshold edge (size cap, token cap, retry exhaust).
   - Missing prerequisite (wallet not provisioned, skill not installed, config not set).
   - Concurrent mutation (two crons writing same file).
   - Network/upstream failure (Anthropic 400, Stripe webhook timeout, Linode 502).
3. **Document the failure modes considered.** PR description includes "Failure modes tested: A, B, C. Failure modes NOT tested but considered: D (rationale)." If you can't enumerate failure modes, you don't yet understand the feature well enough to ship.
4. **Local test harness preferred over fleet rollout.** The 2026-05-07 v90 fix shipped with `scripts/_test-strip-thinking-compaction.ts` exercising 6 failure-mode cases against synthetic jsonl. All cases passed BEFORE the manifest was bumped. Fleet rollouts are not the right place to discover that your code drops the first user message.

**Banned patterns:**

- "It works in dev" — dev typically exercises only the happy path.
- Shipping a destructive code path without a test that proves it doesn't fire on the legitimate-use case.
- Trusting end-to-end production traffic to catch failure-mode bugs. By the time a paying user has reproduced your bug, you've already churned them.

**Detection:** when reviewing a PR, ask "what's the worst realistic state this feature could be invoked in?" and "is there a test for that state?" If no test, push back on the PR. The 30 minutes spent writing the failure-mode test will save 4 hours of incident response in the median case and 4 weeks of silent churn in the tail case.

### 32. `openclaw config set` exit-0 ≠ runtime applied — verify hot-reload landed

Not every config namespace in OpenClaw 2026.4.26 supports hot-reload. The runtime emits two distinct log shapes after a `config set`:

```
[reload] config change detected; evaluating reload (KEY, meta.lastTouchedAt)  ← the change was SEEN
[reload] config hot reload applied (KEY)                                        ← the change took EFFECT
```

**Only the second line proves the change is live.** If the second line is absent for your key, the running process is still using the value it captured at process init. The `openclaw config set` command will still exit 0 — disk state and runtime state are independent in this case.

#### The 2026-05-11 "reactions never fired" incident

Edge City terminal applied 9 config keys via canary to vm-050 — 5 in `channels.telegram.streaming.*` and 4 in `messages.*` (ackReactionScope, ackReaction, statusReactions.enabled, removeAckAfterReply). All 9 `openclaw config set` calls returned exit 0. On-disk verification passed. **No reaction emoji appeared on any of Cooper's test messages.** The forensic dive showed:

1. The dist source at `extensions/telegram/bot-msflwCEW.js:5473` captures `cfg.messages?.ackReactionScope` into a `const` at telegram-channel-init time. Once captured, the value never re-reads.
2. The journal showed `[reload] config change detected; evaluating reload (messages.ackReactionScope, ...)` for every messages.* set — but no matching `[reload] config hot reload applied (messages.ackReactionScope)` line.
3. A full gateway restart (`systemctl --user restart openclaw-gateway`) re-ran the init code, picked up the new value, reactions fired on the next message.

#### Verified hot-reload classification (OpenClaw 2026.4.26)

| Namespace | Hot-reload? | Mechanism | Evidence (2026-05-11) |
|---|---|---|---|
| `channels.*` | **Yes** | Channel restart hook re-reads config | journal: `[gateway/channels] restarting telegram channel` then `[reload] config hot reload applied (channels.telegram.X)` |
| `mcp.servers.*` | **Yes** | MCP subprocess respawn with new env | journal: `[reload] config hot reload applied (mcp.servers.gbrain.env.X)` |
| `messages.*` | **NO — requires restart** | Closure-captured at channel init | journal: `evaluating reload` only, no `applied` line. Verified empirically on vm-050. |
| `agents.defaults.*` | **Likely NO** (untested) | Closure-captured at agent init | not yet probed; add to RESTART_REQUIRED_CONFIG_PREFIXES in `lib/vm-reconcile.ts` once verified |
| `gateway.*` | **Likely NO** (untested) | Most settings read during gateway startup | same — add to the list when verified |
| `session.*` | **Likely NO** (untested) | Session manager init reads these | same |

The conservative default in `lib/vm-reconcile.ts`'s `RESTART_REQUIRED_CONFIG_PREFIXES` is `messages.*` only (the one empirically verified). Other suspected-non-hot-reloadable namespaces are added by future incident learning — false-positive restarts of healthy hot-reloadable changes have their own cost (gateway downtime, fleet thrash).

#### Mandatory pattern

When `openclaw config set <key>` is run anywhere in the codebase or by an operator:

1. **Reading the on-disk file is not sufficient verification.** `~/.openclaw/openclaw.json` will show the new value; the running process may not.
2. **Look for the second journal line.** `journalctl --user -u openclaw-gateway | grep "hot reload applied"` and confirm your key appears.
3. **If the second line is absent for your key, the gateway needs a full restart** (`systemctl --user restart openclaw-gateway`) followed by Rule 5 verification.
4. **The reconciler automates this** via `stepConfigSettings` in `lib/vm-reconcile.ts`: after a successful set of any key matching `RESTART_REQUIRED_CONFIG_PREFIXES`, it sets `result.gatewayRestartNeeded=true`. The orchestrator's Step 9 picks this up and does a verified restart before the cycle finishes. **Adding a new key to the manifest in a non-hot-reload namespace MUST be paired with adding that namespace's prefix to RESTART_REQUIRED_CONFIG_PREFIXES** — otherwise the fleet rollout silently fails on every VM.

#### Banned patterns

- Trusting `openclaw config set` exit code as proof the change is live.
- Trusting a verify-after-set pattern that only reads the file on disk — that catches set-failures but not hot-reload-failures.
- Hot-shipping a config-change PRD with the assumption "all OpenClaw keys hot-reload." They don't.

#### Detection rule

PR review checklist when adding a key to `lib/vm-manifest.ts:configSettings`:

1. What's the namespace prefix? (`messages.`, `channels.telegram.streaming.`, `agents.defaults.`, etc.)
2. Is the prefix in `RESTART_REQUIRED_CONFIG_PREFIXES` or empirically known hot-reloadable?
3. If unknown, the PR author runs a one-VM canary: apply the key, send a test message, grep journal for `hot reload applied (<key>)`. If absent → restart-required; add the prefix to the list in the same PR.

This rule complements Rule 10 (verify-every-set discipline) — Rule 10 catches *disk write* failures; Rule 32 catches *runtime apply* failures. Both are required for a fleet-wide config rollout to be trustworthy.

### 33. Onboarding Is a State Machine — Every Transition Must Be Atomic or Reentrant, and Never Trap the User

The signup → first-message flow is a five-state finite state machine. Every transition either (a) is atomic — all writes land or none do — or (b) is fully reentrant — repeating it leaves the user in the same or a later state, never an earlier one. Violating either property creates a **trap state**: a configuration the user's session can reach but cannot escape via normal navigation. The dashboard layout's onboarding redirect makes any trap state into an infinite loop, because a trapped user landing on `/dashboard` gets bounced to `/connect`, where they re-execute the flow that put them in the trap state, forever.

#### The 2026-05-12 stuck-onboarding incident

Carter Cleveland signed up via `/edge-city`, the Edge City partner portal. He paid via Stripe, his subscription went active, a VM (`vm-917`) was assigned and configured, and his Telegram bot (`@EdgeFriendBot`) was wired up. Then he clicked anywhere on the dashboard and got bounced back to `/connect` showing "Your bot @EdgeFriendBot is ready! Continue to Plan Selection." Click Continue → flash of `/plan` → flash of `/deploying` → back on `/connect`. Forever. Timour Kosters (Edge City project lead) flagged the incident.

Fleet audit that night found Carter was one of **eight users** in the identical trap state going back to 2026-05-09 ~17:00 UTC. Pattern: VM assigned, `health_status="healthy"`, `gateway_url` set, agentbook + bankr wallets provisioned, BUT `telegram_bot_username=NULL`, `partner=NULL`, `pending_users.consumed_at=NULL`, `users.onboarding_complete=false`. `buggynear@gmail.com` (vm-910) had **20+ consecutive `configure_started` events with zero `configure_completed`** over those two days, meaning configure had been called 20+ times and failed in the exact same way every time.

The cause: `/api/vm/configure` runs `configureOpenClaw`, which atomically writes the critical fields (`gateway_url`, `gateway_token`, `health_status="healthy"`, `telegram_bot_token`) partway through its execution. After that atomic write, `configureOpenClaw` continues running other steps. Three of those steps are tagged `critical: true` in their `recordFailure(...)` calls — `dispatch_deploy` (`lib/ssh.ts:5278`), `browser_relay_deploy` (`lib/ssh.ts:5310`), `agentbook_wallet_generation` (`lib/ssh.ts:6950`). When any of them throws, the failure is collected into `result.partialFailures` and bubbled up to the route handler. The handler's critical-failure gate (`app/api/vm/configure/route.ts:408`) sees `critical=true` failures and returns 500 **before** running the supplemental update block that sets `telegram_bot_username`, `partner`, `onboarding_complete=true`, and consumes the `pending_users` row.

So the VM looks healthy from any external check (the only one anyone runs is `/health` and a port probe), but four named pieces of database state that "fully onboarded" depends on never get written. The dashboard layout's redirect uses only `session.user.onboardingComplete`, so it doesn't see the working VM and sends the user to `/connect`. `/connect` hydrates from the un-consumed pending row, shows the bot as verified, offers "Continue to Plan Selection". `/plan` sees an active subscription and skips Stripe checkout (`api/billing/checkout` existingSub branch → returns `{url: /deploying}`). `/deploying` polls `/api/vm/status`, sees `gateway_url` set + `health_status="healthy"`, marks all five deploy steps "done", and after 1500ms does `window.location.href = "/dashboard"`. Back on `/dashboard`. Loop closed. No part of the loop emits any error to a log we read — every endpoint returns 200, every page renders normally.

Before this fix, the critical-failure gate didn't update `health_status` or increment `configure_attempts`. So `process-pending`'s Pass 2 (`health_status="configure_failed"` AND `configure_attempts < MAX_CONFIGURE_ATTEMPTS`) didn't match these VMs, and Pass 2c (`configure_attempts >= MAX_CONFIGURE_ATTEMPTS`) didn't either. Nothing released the user from the trap. The cron rolled past them every 10 minutes for two days while Buggynear (and seven others) sat in the loop. Cooper found out from Timour on day 2.

#### The onboarding state machine

Five named states. Backward arrows are explicit — users can cancel and re-onboard.

```
ANONYMOUS ──[Google OAuth]──▶ CONNECTED ──[/api/onboarding/save]──▶ PENDING
                              (instaclaw_users row)                 (pending_users row, no VM, no sub)
                                                                     │
                                                                     ▼ [Stripe checkout completes]
                                                                  PAID_NO_VM
                                                                (active sub, no VM)
                                                                     │
                                                                     ▼ [pool assignment in
                                                                         process-pending / verify / webhook]
                                                                  ASSIGNED_CONFIGURING
                                                                 (VM assigned, configure in progress)
                                                                     │
                                                                     ▼ [configureOpenClaw atomic write +
                                                                         supplemental update succeeds]
                                                                  FULLY_ONBOARDED   ← terminal good state
                                                                     │
                                                                     ▼ [user cancels sub]
                                                                  CANCELLED   (sub cancelled, VM frozen or released)
                                                                     │
                                                                     ▼ [user resubscribes]
                                                                 (back to ASSIGNED_CONFIGURING
                                                                  via thawVM or fresh assignment)
```

There are exactly two legitimate "user dwells here" states: `ANONYMOUS` (escapes via Google sign-in; middleware enforces) and `FULLY_ONBOARDED` (terminal good state). Every other state must be transient — a deterministic path forward (cron, webhook, user click) advances the user out within bounded time. **Anything else is a trap.**

#### "Fully onboarded" is exactly five database conditions, all conjunctive

A user is fully onboarded if and only if all five hold simultaneously:

1. `instaclaw_users.onboarding_complete = true`
2. `instaclaw_users.deployment_lock_at IS NULL`
3. Exactly one `instaclaw_vms` row where `assigned_to = user.id` AND `gateway_url IS NOT NULL` AND `gateway_token IS NOT NULL` AND `telegram_bot_token IS NOT NULL` AND `telegram_bot_username IS NOT NULL` AND (`partner` matches `users.partner` if `users.partner IS NOT NULL`) AND `health_status NOT IN ('configure_failed', 'frozen')`
4. Either an `instaclaw_subscriptions` row with `status IN ('active', 'trialing')` OR one of the alternative `isPaying` conditions in `lib/billing-status.ts` (`credit_balance > 0`, partner-tagged, all-inclusive tier, past_due within 7-day grace)
5. `instaclaw_pending_users.consumed_at IS NOT NULL` OR the pending row doesn't exist

Any user where (1)–(4) hold but `pending_users.consumed_at IS NULL` is in a soft-incomplete state — agent works but the funnel-completion check still treats them as in-progress. Any user where (3) is partial (gateway set but `telegram_bot_username` missing, or `partner` mismatched) is the **2026-05-12 trap state**: a healthy VM the system doesn't know is healthy because the supplemental writes never landed.

When you add a new partner-gated skill, a new auto-installed integration, a new field that lives on `instaclaw_vms` and must agree with `instaclaw_users` (e.g., a Bankr-style per-user wallet), the answer to "is this written atomically with the rest of onboarding?" determines whether you're adding a new way to enter the trap state. If you can't say yes, you ARE adding one.

#### The atomicity invariant

`/api/vm/configure` writes three logically-distinct state changes:

- **A**: `configureOpenClaw`'s atomic VM update (`gateway_url`, `health_status`, `telegram_bot_token`, `agentbook_wallet_address`, etc.) — written via a single PostgREST update inside `lib/ssh.ts`.
- **B**: the supplemental update block (`telegram_bot_username`, `partner`, `user_timezone`, `configure_attempts: 0`, `configure_lock_at: null`) — written by the route handler after `configureOpenClaw` returns.
- **C**: the onboarding-completion block (`instaclaw_users.onboarding_complete = true`, `deployment_lock_at: null`, `instaclaw_pending_users.consumed_at = now()`) — also written by the route handler.

Before 2026-05-12, A → B → C could partially commit: A landed, then a critical-failure gate or a Vercel function-kill stopped execution before B and C. The VM looked healthy but funnel state was wrong, and there was no terminal "broken" state to trigger recovery.

The fix shipped 2026-05-12:

1. **The critical-failure gate now updates state instead of just returning 500.** Sets `health_status = "configure_failed"`, increments `configure_attempts`, and (if `>= MAX_CONFIGURE_ATTEMPTS`) releases the VM the same way the catch block does — so existing retry/release machinery in `process-pending` Pass 2 / 2c, the `/deploying` retry UI, and the alert email all fire as if the configure had thrown.
2. **The dashboard layout no longer routes solely on `session.user.onboardingComplete`.** When `onboardingComplete === false` it now fetches `/api/vm/status` and routes data-drivenly: usable VM → stay on dashboard; `configure_failed` VM → `/deploying` (retry UI); still-configuring → `/deploying` (progress); no VM → `/connect` (genuine new-user path). This breaks the loop even when atomicity is somehow violated again.
3. **The health-check cron now detects the trap state every cycle.** Any user with `onboarding_complete = false` AND a healthy VM (with `gateway_url`) for >15 minutes emits an admin alert (`Stuck-Onboarding Users [Rule 33]`). Cooper finds out within the cron interval, not when a partner emails him.
4. **New `configure_partial_failure` onboarding event.** Visible in the funnel timeline so a future "stuck users" dashboard widget can detect this state without cross-referencing Vercel logs.

The atomicity invariant going forward: every code path that writes any subset of {A, B, C} must either write the full subset transactionally, or push to `result.errors` and update `health_status="configure_failed"` so the retry machinery can re-execute the full path. Never leave a VM with A but not B+C and a `health_status` that isn't `"configure_failed"`.

#### Banned patterns

- A `return NextResponse.json({error}, {status: 500})` from any configure-path branch that doesn't first either (a) write `health_status = "configure_failed"` + increment `configure_attempts`, or (b) revert the partial state from `lib/ssh.ts`'s atomic write. The 2026-05-12 incident was precisely this — the critical-failure gate returned 500 with state still painted as "healthy".
- Routing logic that uses ONLY `session.user.onboardingComplete` as the "is this user set up?" signal. The dashboard, the post-checkout redirect, and any future "is this user ready?" check must consult VM state, not just the user-level boolean. A user with `onboarding_complete=true` and no VM is also broken (different shape, same family — they paid, got marked complete, then their VM got released).
- New onboarding code paths (partner portal, mini-app, credit-pack upgrade, etc.) that write fields onto `instaclaw_vms` outside the `configureOpenClaw` → supplemental-update flow. Every such write must also be reachable from the configure path so a retry can recover from any partial state.
- Adding a new `critical: true` `recordFailure(...)` call in `lib/ssh.ts` without writing a failure-mode test that exercises the partial-state recovery (per Rule 31). The three existing critical steps had no such test, which is why the bug went undetected for two days.
- "Pass N+1 will catch this" comments in cron code that don't actually have a passes-everything safety net. The 2026-05-12 incident's eight users matched ZERO of `process-pending`'s seven passes because each pass had a narrow precondition that excluded the healthy-VM-but-incomplete-onboarding shape.

#### Required patterns

1. **Every failure branch in the configure path must transition the VM to a recoverable state.** Either `configure_failed` (so `process-pending` Pass 2 retries) or release-and-reassign (Pass 2c equivalent). Never leave the VM as `healthy` after a failure.
2. **Every redirect away from the dashboard must check the destination is reachable.** If you redirect to `/connect`, the user must be able to reach `/dashboard` from `/connect` without coming back to `/connect`. If you redirect to `/deploying`, the page must terminate (either to dashboard or to a clear error UI) in bounded time. Loop detection on the next mount is too late.
3. **Stuck-state detection in a cron with admin alert.** Any state-machine implementation must have a cron that detects "users stuck in non-terminal state past a SLA" and alerts. The cron at `cron/health-check`'s `Stuck-Onboarding Users [Rule 33]` alert fires whenever a user is `onboarding_complete=false` with a healthy VM for >15 minutes. Mirror this pattern for any new state machine.
4. **The fix for "user is stuck" must be a recovery script, not a manual SQL session.** The 2026-05-12 fix for Carter was a one-shot Node script with before/after state printed for verification. For new state-machine breakages, write the recovery script as part of the PR that adds the state machine. If you can't write it in advance, you don't yet understand the failure modes well enough to ship.
5. **Three database writes that must agree are three opportunities for partial commit.** When a feature requires writes to more than one of {`instaclaw_users`, `instaclaw_vms`, `instaclaw_pending_users`, `instaclaw_subscriptions`}, the PR description must enumerate: (a) the order of writes, (b) what partial-commit states are reachable, (c) which one would be detected by the stuck-state cron.

#### Detection rule

For any PR that touches `app/api/vm/configure/route.ts`, `app/api/onboarding/*`, `app/(onboarding)/*`, `app/(dashboard)/layout.tsx`, the billing webhook, the partner-tag endpoint, or any cron under `app/api/cron/` that calls `/api/vm/configure`: the PR description must explicitly answer "if this code path partially commits its writes, which database state combinations become reachable, and which of them is a trap state?" If the answer isn't enumerated in the diff or the description, the PR is incomplete. The 2026-05-12 incident's eight users existed because three separate PRs touched configure or onboarding code without anyone tracing the partial-commit possibility — each PR was locally correct, but they composed into a trap state.

For any PR that adds a new `recordFailure(..., critical=true)` call: the PR must also (a) add a failure-mode test that triggers that critical failure synthetically (per Rule 31), and (b) verify the user can recover via the existing retry/release machinery, OR add new recovery machinery in the same PR.

For any PR that adds a new state to `vm.health_status` or `user.onboarding_*`: the PR must update both `lib/billing-status.ts`-style classification helpers AND the dashboard layout's redirect logic to handle the new state. New states without routing logic become silent trap-state contributors.

### 34. DB Has State the Disk Doesn't — Reconciler Must Verify Critical Per-VM State

Per-VM state lives in two places: the Supabase `instaclaw_vms` row and on-disk files on the VM (`~/.openclaw/openclaw.json`, `~/.openclaw/.env`, `~/.openclaw/agents/main/agent/auth-profiles.json`, etc.). Any code path that writes ONE of those without atomically writing the other creates a drift that compounds silently until a user reports their bot is broken. The drift is invisible from any health check that doesn't directly compare the two — the gateway is `active`, `/health` returns 200, the VM looks fine — but a feature that the user paid for (Telegram bot, BYOK key, partner skill) silently fails.

The atomic write inside `configureOpenClaw` was supposed to keep DB and disk in sync, but it had at least one well-understood failure mode: the gateway-startup rollback at `lib/ssh.ts:7236-7253`. The bash script copies `openclaw.json.last-known-good` over `openclaw.json` if the new gateway fails to start, but historically the route handler still proceeded to the DB write because `OPENCLAW_CONFIGURE_DONE` was printed regardless of rollback.

#### The 2026-05-12 telegram-token-disk-missing incident

The snapshot audit terminal found 8 VMs where `instaclaw_vms.telegram_bot_token` was set in the DB but the corresponding `channels.telegram.botToken` field in `~/.openclaw/openclaw.json` on the VM was absent. The agent ran but couldn't connect to Telegram — users reported their bots dead despite the dashboard showing the VM as healthy.

Root cause: the gateway-startup rollback path in `configureOpenClaw`. When the new config triggered a gateway-start failure (any reason — slow systemd unit start, transient port-bind race, OOM during boot, corrupt nearby config field), the bash script copied the `openclaw.json.last-known-good` snapshot back into place. For a fresh VM, that snapshot is the `{"_placeholder": true, ...}` blob — no telegram channel block. The route handler ignored the `GATEWAY_ROLLBACK_TRIGGERED` signal in stdout and proceeded to write `telegram_bot_token` into the DB at `lib/ssh.ts:7567`. DB and disk diverged. The rollback path landed 2026-03-14 (commit `287cfed3`), so this bug-shape was reachable for 60 days.

Same-PR fixes: (a) `configureOpenClaw` now throws on `GATEWAY_ROLLBACK_TRIGGERED` BEFORE the DB write, so the route handler's catch block marks the VM `configure_failed` and the retry machinery (process-pending Pass 2, Rule 33) re-attempts; (b) a new reconciler step `stepTelegramTokenVerify` (`lib/vm-reconcile.ts`, slotted after `stepConfigSettings`) re-syncs DB→disk every reconcile cycle so any pre-existing drift (or future drift from a path we haven't yet identified) heals within ~3 min.

#### Critical per-VM fields that must agree between DB and disk

| DB column | On-disk location | Source of truth |
|---|---|---|
| `telegram_bot_token` | `openclaw.json.channels.telegram.botToken` | DB |
| `discord_bot_token` | `openclaw.json.channels.discord.botToken` | DB |
| `gateway_token` | `openclaw.json.gateway.auth.token` + `.env GATEWAY_TOKEN` + `auth-profiles.json.profiles.anthropic:default.key` (all-inclusive) | DB |
| `default_model` | `openclaw.json.agents.defaults.model.primary` | DB |
| `api_mode` (BYOK vs all-inclusive) | `auth-profiles.json` key shape (Anthropic SK direct vs proxy token) | DB |
| `partner` | `~/.openclaw/skills/<partner-skill>/` install presence + partner-gated env vars | DB |
| `bankr_evm_address` | `.env BANKR_WALLET_ADDRESS` | DB |
| `agentbook_wallet_address` | `~/.openclaw/wallet/agent.key` (private key file) — address derived | DB |
| `channels_enabled` | `openclaw.json.plugins.entries.<channel>.enabled` | DB |

#### Mandatory pattern

Any field that exists in BOTH the DB and an on-disk config file MUST have a corresponding reconciler step that:

1. Reads the on-disk value (cheap — one SSH execCommand).
2. Compares against the DB value.
3. If mismatched: writes the DB value to disk using a merge mechanism (`openclaw config set`, `sed -i` for `.env`, or targeted JSON edit). **Never full-file overwrite — Rule 23.**
4. Verifies the write landed by re-reading from disk (Rule 10).
5. Logs the fix to `result.fixed` (or `result.errors` on failure — so `pushFailed` gates the `config_version` bump per Rule 10).
6. Idempotent: no-op when already in sync.
7. Flags `gatewayRestartNeeded` if the field affects a runtime component that's not hot-reloadable (per Rule 32's known mapping).

The reconciler runs every 3 min via Vercel cron, so drift heals within one cycle.

`stepTelegramTokenVerify` is the reference implementation. Mirror it for each row in the table above.

#### Banned patterns

- A code path that writes to `instaclaw_vms` for a per-VM-state field (the columns above) WITHOUT a corresponding reconciler verify step. The expectation that "configureOpenClaw runs atomically so disk and DB always agree" was empirically wrong — the gateway-startup rollback path proved it. New columns must come with verify steps in the same PR.
- Treating `OPENCLAW_CONFIGURE_DONE` as proof the new config landed on disk. It's printed even after rollback. Code that reads the script's stdout must also check for `GATEWAY_ROLLBACK_TRIGGERED` and treat it as failure (now enforced in `lib/ssh.ts` post-2026-05-12).
- Using `cat >`, `echo >`, `tee`, or any other full-file overwrite of `openclaw.json` outside of `configureOpenClaw`'s controlled rebuild path. All other writers must use `openclaw config set` (merge) or `openclaw-config-merge`.
- Reading `vm.<field>` from DB and treating it as ground truth without confirming the on-disk equivalent matches. For features that the user pays for to work end-to-end (Telegram delivery, BYOK key, partner skill), the DB only describes intent; disk describes reality.

#### Required cleanup-on-detect

When `stepTelegramTokenVerify` (or any DB↔disk verifier) detects a mismatch, the next iteration should log a structured `disk_db_mismatch` event (admin alert, Sentry breadcrumb, or onboarding event row) with the field name, both values' prefixes, and the VM ID. Tracking this in a single feed lets us measure incident frequency, validate that the reconciler is healing the population, and detect new drift sources.

#### Detection rule

For any new PR that adds a column to `instaclaw_vms` representing on-disk state, the PR description must answer:
1. What's the on-disk path?
2. Which reconciler step verifies the DB↔disk match?
3. How is the "DB has the value but disk doesn't" bug detected and healed?
4. Are any callers that write this column outside `configureOpenClaw`? If yes, do they also write the on-disk equivalent atomically?

If the answers are not present in the PR diff or description, the PR is incomplete. The 2026-05-12 incident's 8 stuck users existed because three separate code paths (configure atomic write, configure rollback, route handler's vmUpdate) each looked locally correct, but composed into a state machine that could persistently lie.

### 35. gbrain MCP Must Run as Persistent HTTP Sidecar — Never Stdio Spawn

gbrain (Garry Tan's PGLite-native memory) is the agent's long-term memory store. It MUST run as a persistent `systemd --user` service exposing MCP over loopback HTTP, and OpenClaw MUST connect to it via `transport: streamable-http`. The stdio-spawn pattern (where OpenClaw launches gbrain as a child process per-session) is BANNED — it has unfixable cold-start, hallucination, and session-killing failure modes that have cost paying-customer hours.

#### The 2026-05-15 vm-050 canary

Before (stdio spawn, v0.28.1): every session that needed gbrain re-spawned `bun run .../cli.ts serve`. PGLite open + bun runtime + Anthropic SDK init + MCP handshake = **90+ second cold-start.** OpenClaw's `connectionTimeoutMs` timed out, the session got marked failed, strip-thinking.py trimmed it (Rule 22), users saw "Something went wrong." Worse: the agent sometimes saw a missing tool result, hallucinated a save ("I saved that to memory"), and built false confidence that data was persisted when it wasn't (Rule 28/29). Plus a v0.28.1 stdin-EOF race condition (fixed upstream in v0.34.1.0 via `MCP_STDIO=1`) that killed handshakes mid-init.

After (HTTP sidecar, v0.35.0.0): `/health` 7-9ms, `/mcp` initialize 37-49ms, `put_page` write 564ms, `get_page` read 47ms, full agent turn 6.8s end-to-end (vs 90+ before). Subsequent messages: same-minute responses. Zero cold-start. Single PID per VM. Loopback-only bind. Full PRD: `instaclaw/docs/prd/gbrain-http-sidecar-fleet-rollout.md`.

#### Mandatory architecture

1. **gbrain runs as `systemd --user gbrain.service`** with `Restart=always`, `MemoryMax=2500M`, `TasksMax=50`. ExecStart is `bun run .../gbrain/src/cli.ts serve --http --port 3131`. No `--public-url`, no `--enable-dcr` (we don't need OAuth Dynamic Client Registration).
2. **gbrain v0.35.0.0 binds 127.0.0.1 by default.** Verify with `ss -lnpt | grep 3131` — must show `127.0.0.1:3131`, never `0.0.0.0:3131`. External-IP probe to 3131 MUST be refused.
3. **OpenClaw's `mcp.servers.gbrain` MUST be `transport: "streamable-http"`** with `url: "http://127.0.0.1:3131/mcp"`, `headers: {"Authorization": "Bearer gbrain_<hex>"}`, `connectionTimeoutMs: 5000`. The stdio shape (`command`/`args`/`env`) is BANNED on any new VM.
4. **Bearer token lives in the gbrain PGLite `access_tokens` table.** Plaintext stored at `~/.gbrain/openclaw-bearer-token.txt` mode 600.
5. **Token creation uses direct PGLite INSERT, not `gbrain auth create`.** v0.35.0.0's `gbrain auth create` uses bare `postgres()` client and fails on PGLite with `ECONNREFUSED ::1:5432`. Workaround documented in PRD; upstream fix is a one-line swap to `engine.executeRaw`.
6. **`GBRAIN_DATABASE_URL` env var MUST NOT be set.** v0.35.0.0 reads engine config from `~/.gbrain/config.json` and rejects `pglite://...` URL format in the env var.
7. **gbrain MUST be installed from `https://github.com/garrytan/gbrain.git`, NOT npm.** The npm package `gbrain` at v1.3.1 is a typosquat (stormcolor/gbrain, "GPU JavaScript Library for Machine Learning"). Real gbrain is git-clone-only.
8. **openclaw.json flip MUST be atomic + backed up + verified-after-restart** per Rules 5, 22, 34. Write to `openclaw.json.tmp`, `jq empty` validate, `mv` into place. Keep `.pre-http-sidecar-flip-<ts>.bak`. After gateway restart, poll `/health=200` for up to 60s. If unhealthy, restore backup and restart. Also grep journal for `GATEWAY_ROLLBACK_TRIGGERED` (Rule 34).

#### Banned patterns

- `mcp.servers.gbrain` with `command`/`args`/`env` keys (stdio spawn) on any new VM.
- `bun install -g gbrain` or `npm install -g gbrain` — typosquat. Always `git clone https://github.com/garrytan/gbrain.git`.
- `GBRAIN_DATABASE_URL=pglite://...` in any systemd unit or shell environment.
- Running `gbrain auth create` against a PGLite brain — silently fails. Use direct PGLite INSERT until upstream fixes.
- Binding gbrain to 0.0.0.0 for any reason. If external access ever needed: Tailscale or reverse proxy with auth — never bare-Internet 3131.
- Multiple gbrain processes per VM. The sidecar is singular; `ps -ef | grep gbrain` must show exactly one.

#### Detection rule

Coverage query (P1 followup per Rule 27): for every healthy+assigned VM, verify (a) `systemctl --user is-active gbrain.service` returns `active`, (b) port 3131 bound to 127.0.0.1, (c) external-IP probe to 3131 is refused, (d) `jq '.mcp.servers.gbrain.transport' openclaw.json` returns `"streamable-http"`, (e) PGLite `access_tokens` table has at least one un-revoked row matching openclaw.json's `Authorization` header. Failure on any = Rule 23 / Rule 34 lying-DB regression.

#### Existing-VM caveat

When this rule conflicts with an existing stdio `mcp.servers.gbrain` entry on a VM with real user-memory data in `brain.pglite`, data preservation takes precedence (Rules 22, 30). Do NOT wipe an existing brain to "fix" it. Either leave the VM on stdio + cold-start problem until the v0.28→v0.35 PGLite migration wedge is solved upstream, OR implement a surgical schema upgrade that preserves user data. Cooper's call. Fleet-wide rollout to existing VMs is gated on this resolution; new-VM rollout via snapshot bake is not.

#### Sidecar lifecycle gotcha (IR finding 2026-05-16)

**SIGTERM CORRUPTS PGLite. SIGKILL produces RECOVERABLE state.** Counterintuitive. The bug is NOT missing graceful shutdown — gbrain has a proper handler chain (SIGTERM → `engine.disconnect()` → `db.close()` → `releaseLock` → `process.exit(0)`). The bug lives inside PGLite's `db.close()`: it writes something during close that corrupts the data directory so the next WASM init fails. SIGKILL skips the broken close-path; the WAL replays cleanly on next boot.

Implications:
- The `install-gbrain.sh` Phase E1 path uses `pkill -KILL` (not `pkill -TERM` or `systemctl stop` which sends the unit's `KillSignal`); Phase E5 sets `KillSignal=SIGKILL` in the unit file so operator-driven `systemctl stop/restart/reload` ALSO uses SIGKILL.
- For freeze-thaw archival, use PGLite's native `engine.db.dumpDataDir("gzip")` for HOT backup without stopping (IR finding) — exposed as an MCP/admin endpoint would be ideal but doesn't exist yet upstream.
- Any future code that does stop+restart WITHOUT wipe MUST use SIGKILL.
- File upstream issue with @electric-sql/pglite when bandwidth allows: `db.close()` corrupts the data directory; reproducible on v0.4.5 against gbrain v0.35.0.0.

#### Version-bump preservation gap (P1 followup)

Bumping `GBRAIN_PINNED_VERSION` / `GBRAIN_PINNED_COMMIT` in `lib/vm-reconcile.ts` today **wipes every edge_city VM's brain.pglite** because the reconciler re-runs `stepGbrain` on every cv-stale VM, and Phase E2 of `install-gbrain.sh` unconditionally wipes PGLite before fresh init.

**This is fine for the initial fleet rollout** (brains are empty until users save memories) **and for Esmeralda** (we pin v0.35.0.0 at the May 23 snapshot bake and don't bump during the conference). It is **NOT fine post-Esmeralda** when paying users have accumulated meaningful memories.

The gate for future memory-preserving version bumps: upstream gbrain must expose `engine.db.dumpDataDir("gzip")` as MCP tool `snapshot_brain` (per IR's freeze-thaw v2 PRD §15.3; primitive already exists at `gbrain/scripts/build-pglite-snapshot.ts:53`). With that tool: per-VM upgrade flow becomes (a) call snapshot_brain → tarball, (b) `install-gbrain.sh` wipe + reinstall at new version, (c) `gbrain restore` (or equivalent) on the tarball, (d) new schema migrations run on imported data → memory preserved through upgrade.

Until `snapshot_brain` ships upstream and we wire it into stepGbrain, **DO NOT bump GBRAIN_PINNED_VERSION on production VMs that have non-empty PGLite**. The reconciler will silently destroy customer memories. P1 tracking: file upstream issue + write the import flow into stepGbrain when the tool lands.

---

## Incident Response Runbook

Standardized workflow any CC terminal can follow autonomously when Cooper pastes an alert email screenshot or reports a user/VM issue. The point is to converge on root cause + fix without burning Cooper's time on diagnostic chatter, while staying inside well-defined autonomy boundaries.

This runbook is self-contained: it requires only `.env.local` and `.env.ssh-key` to be readable. Do not ask clarifying questions before starting — extract everything you need from the artifact (screenshot, error, paste) and run the workflow.

### Severity classification — always classify first

Tag the incident with one of the four tiers within 30 seconds of receiving it. This decides how aggressive to be, what authority applies, and how fast Cooper needs to know.

| Tier | Definition | Response SLA | Cooper notification |
|---|---|---|---|
| **P0** | Paying customer DOWN (active sub, getting no agent response). >1 customer with same symptom. Stripe/Resend/Anthropic billing path broken. | Identify ≤2 min; fix or escalate ≤15 min | Ping at incident start AND at resolution |
| **P1** | Paying customer DEGRADED (responds but slow/wrong/missing partner feature). Single VM truly broken. Disk full but VM responding. | Identify ≤5 min; fix ≤60 min | Single report at end |
| **P2** | Alert fired, no confirmed customer impact (hibernating, suspended, or non-paying). Internal infra degradation. | Identify ≤30 min; batch with similar | Optional digest |
| **P3** | Informational / long-tail warning. Patrol-mode finding. Stale data, no current customer impact. | When bandwidth allows | Weekly digest |

For ambiguous cases, classify UP one tier. False-positive P0 is cheap; false-negative P0 is reputation damage.

### Authority boundaries — what CC may do without asking Cooper

Match the action you're about to take against the tiers below. If unsure, drop one tier (be more conservative). When in doubt, ask.

**Tier A — autonomous, no approval needed:**
- All read-only diagnostics: SSH reads, Supabase SELECTs, Prometheus queries, Linode API GETs, journalctl
- Single-VM mutations on a verifiably-paying customer where the fix is reversible (gateway restart, disk-cleanup, env-var resync against Vercel SoT, single-key `openclaw config set`)
- Adding a Prometheus silence scoped to specific labels AND time-bounded (≤24h for diagnostic; ≤7d for known-noise)
- Running idempotent scripts manually (e.g. `/opt/instaclaw/update-targets.sh` on monitoring VM, `scripts/_audit-*.ts` reads)
- Backfilling a single DB row to match observed reality (e.g. setting `vm.partner` to match `user.partner`)
- Drafting / committing markdown documentation files (incident notes, P1 followups)

**Tier B — one VM first, verify, then ping Cooper before fleet rollout:**
- Manifest config change that worked on one canary VM
- Cron interval / schedule change
- New skill install on >1 VM
- Restart of >1 but <5 VMs in the same incident family
- Any `reconcile-fleet` trigger or fleet-push script

**Tier C — hard approval required, ping Cooper FIRST:**
- Vercel env var changes (Rule 6: blast radius is the whole fleet on next cron)
- `git push` to main from CC (commits to instaclaw/ or root)
- Supabase migrations (`supabase db push` schema changes)
- Linode bulk operations (>5 VMs simultaneously, instance deletes, mass reboots)
- Stripe / Resend / Anthropic API calls that affect billing
- Any deletion operation on customer state (sessions, MEMORY.md, workspace files — per Rules 22, 23, 30)
- New CLAUDE.md Rules (Cooper signs off on rule canon)
- New Prometheus alert rules at fleet scope
- Restarting >1 gateway during peak hours (12:00–02:00 UTC) without P0 justification

**Emergency override** (P0 only): if a paying-customer outage is in progress AND the fix is reversible AND it touches <10 VMs, CC may act autonomously and report within 5 minutes. The report must include: (a) what was done, (b) full rollback command, (c) why escalation was bypassed.

### Step 1: Identify

From the screenshot / paste, extract:
- Alert name (e.g. `DiskCritical`, `GatewayDown`)
- Instance IP (the `instance="<IP>:9100"` label)
- Severity (`critical` vs `warning`)
- Firing duration (`since <timestamp>`)

Assign an **incident ID**: `INC-<YYYYMMDD>-<vm-N>-<3-char hash>` (e.g. `INC-20260514-vm788-a7c`). Use this in every backup file path, silence comment, and report.

Map IP → VM → user:
```sql
SELECT name, ip_address, assigned_to, health_status, config_version, partner, status, provider_server_id
FROM instaclaw_vms WHERE ip_address = '<IP>';

SELECT email, partner, created_at FROM instaclaw_users WHERE id = '<assigned_to>';
```

Pull recent context for the user:
```sql
SELECT * FROM vm_lifecycle_log WHERE vm_id = '<vm.id>' ORDER BY created_at DESC LIMIT 20;
SELECT status, current_period_end FROM instaclaw_subscriptions
  WHERE user_id = '<user.id>' AND status IN ('active','trialing','past_due');
```

Log to your scratchpad:
```
INC-<ID> [P0/P1/P2/P3]: <alert_name> on <vm_name> (<ip>) owned by <email>,
  health=<status>, cv=<version>, partner=<partner|null>, sub=<active|past_due|none>
```

If the instance label is missing or ambiguous (e.g. cropped screenshot), pivot to alertname-only search across `/api/v2/alerts` to find all currently-firing instances; ask Cooper which one if more than 5 match.

### Step 2: Diagnose — monitoring-first, then SSH

Default order: cheapest signals first. SSH is the most expensive (10s+ per probe, can hang) and least structured. Use Prometheus and pg_cron FIRST when they can answer the question.

**2.1 — Prometheus instant data (1s per query, cheap):**

```bash
ssh -i /tmp/ic_ssh_key root@66.228.43.140 'for q in \
  "up{instance=\"<IP>:9100\"}" \
  "(1 - node_filesystem_avail_bytes{mountpoint=\"/\",instance=\"<IP>:9100\"} / node_filesystem_size_bytes{mountpoint=\"/\",instance=\"<IP>:9100\"}) * 100" \
  "100 - (avg(rate(node_cpu_seconds_total{mode=\"idle\",instance=\"<IP>:9100\"}[5m])) * 100)" \
  "(1 - node_memory_MemAvailable_bytes{instance=\"<IP>:9100\"} / node_memory_MemTotal_bytes{instance=\"<IP>:9100\"}) * 100" \
  "changes(node_boot_time_seconds{instance=\"<IP>:9100\"}[1h])"; do \
    echo "--- $q ---"; \
    curl -s --data-urlencode "query=$q" localhost:9090/api/v1/query \
      | python3 -c "import json,sys; r=json.load(sys.stdin)[\"data\"][\"result\"]; print(r[0][\"value\"][1] if r else \"NO DATA\")"; \
  done'
```

What Prom alone tells you (no SSH needed):
- VM alive? → `up=1`
- Disk %? → filesystem query
- Gateway running? → `openclaw_gateway_up == 1` (textfile-collector metric, deployed 2026-05-14 — see "Gateway-health metric" reference below)
- Gateway-health metric stale (cron dead)? → `time() - node_textfile_mtime_seconds{file=~".*openclaw_gateway.prom"} > 60`
- Crash loop? → `changes(node_boot_time_seconds[1h]) > 1`
- CPU pressure? → idle-rate query
- Memory pressure? → memory ratio query

**2.2 — pg_cron fleet-health view (reconcile state):**

The fleet-health pg_cron job (migration `20260513170100_fleet_health_pgcron.sql`) writes hourly snapshots; `app/api/cron/fleet-health-notify` and `app/api/cron/db-job-health` deliver them. Direct query:

```sql
-- Last reconcile attempt and outcome (pg_cron job_run_details)
SELECT jobname, status, start_time, end_time, return_message
FROM cron.job_run_details
WHERE jobname IN ('reconcile-fleet','fleet-health-check')
ORDER BY end_time DESC LIMIT 10;

-- Per-VM cv drift
SELECT name, config_version, health_status, last_reconciled_at
FROM instaclaw_vms WHERE name = '<vm_name>';
```

If `last_reconciled_at` is >30 min old or status is `failed`, the reconciler is stuck on this VM. Likely Rule 10 / Rule 23 (pushFailed gate). Pull the most recent Vercel function log for the reconcile-fleet route.

**2.3 — SSH battery (when monitoring isn't enough):**

```bash
ssh -i /tmp/ic_ssh_key openclaw@<IP> '
  echo "=== disk ==="; df -h /; du -sh ~/.openclaw/{session-backups,sessions,workspace} 2>/dev/null
  echo "=== gateway ==="; systemctl --user is-active openclaw-gateway
  curl -sf -o /dev/null -w "health http=%{http_code}\n" localhost:18789/health
  echo "=== crashes ==="; systemctl --user show openclaw-gateway --property=NRestarts --value
  echo "=== recent journal ==="; journalctl --user -u openclaw-gateway --since "1 hour ago" --no-pager | tail -50
  echo "=== config sanity ==="; ls -la ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.last-known-good 2>/dev/null
  echo "=== env sanity ==="; grep -E "^(GATEWAY_TOKEN|EDGEOS_|BRAVE_|BANKR_|RESEND_)" ~/.openclaw/.env | sed "s/=.*/=<SET>/"
  echo "=== process tree ==="; pgrep -af openclaw | head -10
'
```

Read each section against expectations:
- `df -h /` >85% → DiskAlmostFull territory; >95% → DiskCritical, ENOSPC imminent (Rule 37)
- gateway `is-active`: anything other than `active` is the problem
- `NRestarts`: <5 normal; >10/h is crash loop (Rules 16 / 32)
- recent journal: scan for `Cannot find module`, `OOM`, `SIGTERM`, `panic`, `EADDRINUSE`, `auth-cache`, `failed to lookup secret`, `prctl-subreaper`
- `openclaw.json` size 0 bytes: corrupted, restore from `.last-known-good` (Rule 34)
- env vars: missing partner env (e.g. `EDGEOS_*` for an edge_city VM) = Rule 9 partner-tag drift

**2.4 — SSH-failed fallback path:**

If SSH connection fails or hangs:

1. **Prometheus liveness:** `up{instance="<IP>:9100"}` — if `=1`, the VM is alive and SSH is the only thing broken (rare; usually ufw misconfig or sshd OOM-killed). TCP probe `nc -zv <IP> 22` separates TCP from auth.
2. **Direct node_exporter scrape:** from monitoring VM, `curl http://<IP>:9100/metrics | head -50` exposes disk, memory, process count without SSH.
3. **Linode API for power state:**
   ```bash
   curl -H "Authorization: Bearer $LINODE_API_TOKEN" \
     "https://api.linode.com/v4/linode/instances/<provider_server_id>" | python3 -m json.tool
   ```
   Look at `status` (`running` / `offline` / `provisioning`).
4. **Linode reboot** if VM is `running` but truly unreachable (Tier A — reversible single-VM):
   ```bash
   curl -X POST -H "Authorization: Bearer $LINODE_API_TOKEN" \
     "https://api.linode.com/v4/linode/instances/<id>/reboot"
   ```
5. **Lish serial console** for out-of-band access when SSH key auth is broken:
   ```bash
   ssh -t <linode-user>@lish-newark.linode.com instaclaw-vm-<N>
   ```
6. If all five fail: VM is permanently lost. Mark `health_status = 'frozen'` and reassign the owner if paying.

### Step 3: Fix the affected VM (with rollback discipline)

Before any destructive operation, capture state to a safety location:

```bash
# On-VM backup of files about to mutate
ssh -i /tmp/ic_ssh_key openclaw@<IP> 'mkdir -p ~/incident-<ID>
  cp ~/.openclaw/openclaw.json ~/incident-<ID>/openclaw.json.before
  cp ~/.openclaw/.env ~/incident-<ID>/env.before
  df -h / > ~/incident-<ID>/disk.before.txt
  date -u > ~/incident-<ID>/timestamp.txt'

# Local backup of the DB row before mutating
curl "https://qvrnuyzfqjrsjljcqbub.supabase.co/rest/v1/instaclaw_vms?id=eq.<vm.id>" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  > /tmp/inc-<ID>-vm-row.before.json
```

Apply the smallest correctly-targeted fix:

- **Disk full:**
  ```bash
  ssh openclaw@<IP> '
    find ~/.openclaw/session-backups -mtime +1 -delete
    ls -t ~/.openclaw/session-backups | tail -n +1001 | xargs -I {} rm -f ~/.openclaw/session-backups/{} 2>/dev/null
    sudo journalctl --vacuum-time=2d
    find /tmp -maxdepth 1 -mtime +1 -delete 2>/dev/null
    [ -s ~/.openclaw/openclaw.json ] || cp ~/.openclaw/openclaw.json.last-known-good ~/.openclaw/openclaw.json
    systemctl --user restart openclaw-gateway
  '
  ```
- **Gateway crash loop:**
  - Identify cause from journal (Rules 16, 17, 25, 30, 32, 35)
  - `systemctl --user reset-failed openclaw-gateway && systemctl --user restart openclaw-gateway`
  - If auth-cache (Rule 16): the canonical helper is `lib/auth-cache.ts` `clearStaleAuthCacheForUser`. Invoke via a small one-off tsx script if no existing script matches; do NOT delete `auth-profiles.json` directly.
- **Token / env drift:**
  - Compare on-disk `.env` against Vercel source-of-truth + DB row
  - `sed -i 's|^GATEWAY_TOKEN=.*|GATEWAY_TOKEN=<from-db>|' ~/.openclaw/.env` for single-key surgery
  - Restart gateway to pick up
- **Config drift (cv behind manifest):**
  - Adapt an existing canary-reconcile script (e.g. `scripts/_canary-vm043-local-reconcile.ts` or `scripts/_catch-up-stuck-cohort.ts` filtered to one VM)
  - Run with `strict=false` to bypass the 180s deadline (Rule 44)
  - Verify cv bumped after run completes

Verify health after fix (within 30s of restart):
```bash
ssh -i /tmp/ic_ssh_key openclaw@<IP> '
  for i in 1 2 3 4 5 6; do
    status=$(systemctl --user is-active openclaw-gateway)
    http=$(curl -sf -o /dev/null -w "%{http_code}" localhost:18789/health 2>/dev/null)
    echo "iter=$i status=$status http=$http"
    [ "$status" = "active" ] && [ "$http" = "200" ] && exit 0
    sleep 5
  done
  exit 1
'
```

If health doesn't return in 30s: revert from the `incident-<ID>` backup, restart with previous state, and escalate. **Do not** keep applying variants of the same fix (Rule 29's hallucinated-diagnosis trap).

Garbage-collect the safety backup after 1h of confirmed healthy state:
```bash
ssh -i /tmp/ic_ssh_key openclaw@<IP> 'rm -rf ~/incident-<ID>'
```

### Step 4: Fleet-wide sweep (multi-source)

A single-VM fix may indicate a fleet-wide pattern. Sweep cheap signals first, expensive ones second.

**4.1 — Prometheus fleet query (resource symptoms):**
```bash
# All VMs >85% disk
ssh root@66.228.43.140 'curl -s "localhost:9090/api/v1/query" \
  --data-urlencode "query=(1 - node_filesystem_avail_bytes{mountpoint=\"/\"} / node_filesystem_size_bytes{mountpoint=\"/\"}) * 100 > 85" \
  | python3 -m json.tool'

# All gateways currently down (customer-visible failures):
ssh root@66.228.43.140 'curl -s "localhost:9090/api/v1/query" \
  --data-urlencode "query=openclaw_gateway_up == 0"'

# Transitions only — exclude hibernating/suspended VMs that never came back up:
ssh root@66.228.43.140 'curl -s "localhost:9090/api/v1/query" \
  --data-urlencode "query=(openclaw_gateway_up == 0) and (max_over_time(openclaw_gateway_up[6h]) == 1)"'
```

**4.2 — Supabase state query (state-related symptoms):**
```sql
-- All assigned VMs in unusual health states
SELECT name, ip_address, health_status, config_version FROM instaclaw_vms
WHERE health_status NOT IN ('healthy','suspended','hibernating')
  AND status = 'assigned' ORDER BY last_health_check DESC;

-- Rule 9 cluster: partner-tagged users whose VMs are missing the partner tag
SELECT u.email, v.name, u.partner AS user_partner, v.partner AS vm_partner
FROM instaclaw_users u JOIN instaclaw_vms v ON v.assigned_to = u.id
WHERE u.partner IS NOT NULL AND v.partner IS NULL;
```

**4.3 — Journal pattern search across fleet (when root cause is a log signature):**

Axiom integration is on the roadmap; until then, parallelize a journalctl probe across the fleet via SSH. Template (use `_audit-*.ts` style scripts):
```bash
# Read the existing scripts/_audit-* family for the parallel-SSH idiom (Supabase IP list + parallel ssh)
# Then grep for the specific signature, e.g. "Cannot find module" or "OOM-killer"
```

**4.4 — Apply fix to matched set (respect authority boundaries):**

| Matched VM count | Authority tier | Action |
|---|---|---|
| 1 (already Step 3) | A | Done |
| 2–5 | B | Apply to one more canary first; verify; proceed if clean |
| >5 | C | Ping Cooper before fleet-pushing — draft the fix script, dry-run output, await go |

### Step 5: Prevent recurrence — Rule integration

Map the root cause to the CLAUDE.md Rule canon:

1. **Existing Rule covers it:** Is the rule's prescribed pattern implemented in code? If not, that's a doc-only Rule — flag it. Does the rule have a detection mechanism (cron, sentinel, audit)? If not, propose one. Add a one-line "saw it on <date> in INC-<ID>" if useful.
2. **Existing Rule but described differently:** Update the Rule with the new failure-mode example. This is the second-most-common case — rules use abstract language that didn't match how this incident manifested.
3. **No existing Rule:** Draft a new Rule following the numbered-rule format. Include: name + body, **The incident:** timeline, **Mandatory pattern:**, **Banned patterns:**, **Detection rule:**. Append to the rule list, increment the highest existing number.
4. **Maps to an unimplemented P1:** Bump priority and add this incident as evidence under "Detection note" / "Impact widened".

Do NOT leave the prevention step empty. If no prevention is added, the next instance is on the schedule.

### Step 6: Report to Cooper — signal density

Cooper has limited time. The report's job is to update him in 10 seconds.

**One-line header (always required):**
```
INC-<ID> [P0/P1/P2/P3]: <symptom> on <vm-name> (<email>). Fixed via <one-clause>.
Fleet sweep: <N>/<total> matched, all fixed. Time impact: <minutes>. Confidence: <high/med/low>.
Rule: <new R<N> | existing R<N> | none-mapped>.
```

**If P0 or P1, the body adds:**
- **What broke**, one sentence, with file:line if known
- **What fixed it**, command run or commit SHA
- **Other VMs affected**, names only (not IPs)
- **Cooper action required** — `none` is a valid value; otherwise specify exactly (Vercel env, Stripe action, customer message, etc.)
- **Rollback command**, paste-ready, in case the fix needs reversing within 1h

**For known contacts**, draft a paste-ready message Cooper can send:
- Timour Kosters (Edge City lead) — any Edge City partner VM issue
- Jeremy / Ape Capital — vm-319 / OnlyMolts
- Doug Rathell — vm-725
- Carter Cleveland — vm-917 / Edge City
- khomenko89@gmail.com (Vasyl) — vm-918 / onboarding-trap recoveries

**Never** in the report:
- Paste raw journal output (refer by VM name + timestamp; Cooper SSHs himself if needed)
- Recount internal reasoning chain (Cooper trusts the conclusion; show the work only on request)
- List every tool call or command run

### Special cases

**Multiple alerts on the same VM (cascade analysis):**
- Sort by `startsAt` ascending. The earliest is usually the root cause.
- Treat all alerts as ONE incident; don't apply N separate fixes for N correlated alerts.
- Common cascades:
  - `DiskCritical` → `GatewayDown` (no space to write session/journal)
  - `HighMemory` → `NodeExporterDown` (OOM killer)
  - `HighCPU` + `HighMemory` simultaneously → runaway agent (prompt-injection loop per Rule 25)
  - `GatewayDown` + `HighCPU` → crash-loop restarts spinning CPU

**Novel root cause (no existing Rule, no obvious pattern):**
- Preserve evidence BEFORE applying any fix: dump last 500 journal lines, `openclaw.json`, `df -h`, process tree, env, recent session jsonl heads. Save under `~/incident-<ID>/` on the VM.
- Apply only the smallest stop-the-bleeding fix.
- Drop a forensic doc in `instaclaw/docs/incidents/<YYYY-MM-DD>-<symptom>-<inc-id>.md`.
- Tag the incident `needs-rule` in Cooper's report.
- Watch for Rule 29 trap: never invent infrastructural explanations that telemetry can't support. "VM fork limits" is the cautionary tale — if you can't point to a specific journal line, syscall, or metric, your hypothesis is hallucinated.

**Rollback if fix made it worse:**
- Restore from `~/incident-<ID>/` snapshot: `cp ~/incident-<ID>/openclaw.json.before ~/.openclaw/openclaw.json`
- Restart gateway
- Restore DB row from `/tmp/inc-<ID>-vm-row.before.json` if mutated (use PostgREST PATCH)
- Verify health returns to pre-incident state. **If pre-incident was already broken**, rollback may "succeed" without fixing anything — escalate to Cooper rather than escalating the fix.

### Per-alert quick reference

| Alert | First diagnostic | Common root cause | Quick fix |
|---|---|---|---|
| `DiskCritical` (>95%) | `du -sh ~/.openclaw/{session-backups,sessions,workspace}` | Backup runaway, session bloat | Purge backups + vacuum journal + restart gateway. Per Rule 37 |
| `DiskAlmostFull` (>85%) | Same as DiskCritical, no urgency | Slow growth | Schedule cleanup; track 24h |
| `GatewayDown` (≥5m, transition-filtered) | `openclaw_gateway_up{instance="<IP>:9100"}` in Prom; `journalctl --user -u openclaw-gateway -n 100` on the VM | Rule 16 (auth-cache), Rule 32 (config restart needed), Rule 35 (prctl-subreaper), Rule 37 (disk-full preventing config writes) | `reset-failed` then `restart`; if disk full, run disk-cleanup recipe first |
| `GatewayHealthMetricStale` (≥5m) | `ls -la /var/lib/node_exporter/textfile_collector/openclaw_gateway.prom` (mtime should be <60s old); `crontab -l \| grep gateway-health-textfile` | Cron died, script deleted, or node_exporter restarted without textfile flag | Re-deploy from `/opt/instaclaw/scripts/gateway-health-textfile.sh` on monitoring VM (canonical copy preserved there) |
| `NodeExporterDown` (≥10m) | Linode API instance state | VM hibernating, ufw drop, OOM killer | Wake (if paying), add ufw rule, restart service |
| `VMUnreachable` (≥5m) | Same as NodeExporterDown | Same | Same |
| `HighCPU` (>90% for 5m) | `journalctl --user -u openclaw-gateway -n 200` | Runaway tool loop, prompt injection (Rule 25), browser zombie | Restart gateway; investigate prompt context |
| `HighMemory` (>90% for 5m) | `du -sh ~/.openclaw/sessions/*` | Bloated session (Rule 30 territory) | In-place compact; never archive (Rule 30) |
| `RestartStorm` (>10/h) | Boot times + journal | Rule 16 / Rule 34 (rollback path) | Address journal cause; do NOT loop fixes |

### Anti-patterns — never do these

- **Hallucinate root cause** when telemetry doesn't support it. If you can't cite a journal line, metric, or file path that shows the cause, your hypothesis is wrong. (Rule 29)
- **Delete session files** for "cleanup" or "crash-loop prevention." Trim in place; never `os.remove` on active state. (Rules 22, 30)
- **Full-overwrite `openclaw.json`** with `cat > / echo >`. Use `openclaw config set` for merge semantics. (Rule 34)
- **Bump `config_version`** manually without verifying every reconciler step ran. The DB will lie. (Rule 23)
- **Run reconciler at concurrency > 3.** Cascades become fleet stampedes. (Upgrade Playbook)
- **Force-restart healthy gateway** during peak hours unless P0. Wait for `(now − last_user_activity_at) > 5min`. (Rule 17)
- **Trust "Notify success"** from Alertmanager as proof of inbox delivery. The upstream relay accepted; downstream receipt is separate. Verify via Resend dashboard or Cooper's confirmation.
- **Ship a fix without rollback.** Even read-only-looking operations can break next steps. Capture state first.
- **Treat alert state as truth.** AM holds firing state with stale data. Verify live by direct probe before acting.
- **Paste customer message content** into any external system, including Slack, email, or commit messages. Session data is sensitive; refer by VM name + timestamp only.
- **Apply variants of a failing fix.** One fix attempt that doesn't resolve = escalate, don't iterate. (Rule 29 spirit)
- **Skip Step 3's pre-fix backup** because "this is obviously the right fix." That confidence is the marker of the next post-mortem.

### Lesson: Telegram line breaks in JWT tokens

When receiving JWTs via Telegram or any messaging platform, the rendered text may contain soft-wrap line breaks that alter the token when naively joined. Always base64-decode the payload section (middle part between the two dots) and verify the decoded JSON contains expected values (email, citizen_id, etc.) BEFORE deploying. The 2026-05-14 EDGEOS_BEARER_TOKEN incident lost an hour of debugging because a single character was inserted at a line-break boundary (muvionai.com vs muvinai.com).

### EdgeOS bearer split — EDGEOS_BEARER_TOKEN vs EDGEOS_EVENTS_BEARER_TOKEN

Two separate JWTs back two separate "EdgeOS" services. Confusing them produces silent 401s under the same name. Both are partner-gated to `edge_city`.

| Env var | Service | Endpoint | Used for | Verifier |
|---|---|---|---|---|
| `EDGEOS_BEARER_TOKEN` | citizen-portal | `api-citizen-portal.simplefi.tech/applications/attendees_directory/8` | attendee directory lookups (Cooper's agent search; Edge skill's `find_attendee_by_email`) | `verifyEdgeosBearer` |
| `EDGEOS_EVENTS_BEARER_TOKEN` | EdgeOS world | `api.edgeos.world/api/v1/api-keys` + `/api/v1/events/portal/list` etc | minting per-VM `eos_live_*` keys for the Edge Esmeralda 2026 calendar (`stepEdgeOSApiKey` reconciler step + `configureOpenClaw` D3 block) | `verifyEdgeosEventsBearer` |

Empirically confirmed 2026-05-20: a citizen-portal JWT returns 401 against `api.edgeos.world` and vice versa. They share the brand name "EdgeOS" but have independent auth namespaces. Each must be set independently in Vercel env.

**Provisioning a fresh `EDGEOS_EVENTS_BEARER_TOKEN`:**
1. `npx tsx scripts/_test-edgeos-auth-chain.ts --prod --email <your-edgeos-account>` — sends OTP via EdgeOS world.
2. Enter OTP. The script prints the JWT bearer it receives back.
3. Verify shape: decoded payload should NOT have `citizen_id` (that's the citizen-portal shape); it should have EdgeOS-world claims (user_id, scopes, etc.). If the payload looks like citizen-portal data, you ran the wrong OTP flow.
4. Set in Vercel: `printf 'eyJ...' | npx vercel env add EDGEOS_EVENTS_BEARER_TOKEN production` (Rule 6 — `printf`, not `<<<`).
5. Verify end-to-end: `npx tsx scripts/_verify-edgeos-events-auth.ts` — confirms list-api-keys returns 200 (mint will work).
6. Trigger Vercel redeploy (or wait for next deploy) so the cron picks up the new env value.

Once verified, the reconciler's next 3-min cycle picks up all 9 edge_city VMs (currently at cv<111 with `edgeos_api_key=null` and warning-only failures), mints fresh `eos_live_*` keys, persists to `instaclaw_vms.edgeos_api_key`, and deploys to `~/.openclaw/.env:EDGEOS_API_KEY`. Full sweep: `npx tsx scripts/_verify-edgeos-api-key.ts`.

### Operational runbook: rotating secrets

When rotating any secret in `SECRET_ENV_VAR_SOURCES` (`lib/vm-reconcile.ts`), bump `SECRET_VERSION` in the same file and deploy. The reconciler will redistribute to all VMs on the next tick — caught-up VMs (those at `config_version = VM_MANIFEST.version`) re-enter the candidate queue because the cron's filter OR-s `secret_version.lt.<SECRET_VERSION>` with the config-version staleness filter. After a successful `stepEnvVarPush`, the route bumps the VM's `secret_version` to current, taking it back out of the queue.

The 2026-05-14 EDGEOS_BEARER_TOKEN incident is what this mechanism prevents: without it, the only paths to deliver a rotated secret to a caught-up VM were (a) a heavyweight manifest version bump, (b) operator-driven SQL `cv` decrement, or (c) out-of-band SSH fleet patch. All three are operator-toil shortcuts to a structural gap. `secret_version` decouples secret distribution from manifest drift — both axes can advance independently.

**Asymmetric naming (`vercelKey`):** when the Vercel-side env var name differs from what the VM-side agent expects (e.g., Brave Search ships as `BRAVE_SEARCH_API_KEY` in Vercel via Brave's own naming convention, but the OpenClaw browser plugin reads `BRAVE_API_KEY` on the VM), set the optional `vercelKey` field on the `SECRET_ENV_VAR_SOURCES` entry. `envKey` stays the VM-side name (what gets written to `~/.openclaw/.env`), `vercelKey` is the `process.env[X]` name `stepEnvVarPush` reads from. When `vercelKey` is unset, it defaults to `envKey` (same name on both sides — the original behavior, unchanged). 2026-05-15 BRAVE_API_KEY enrollment (commit `03e1c87f`) is the reference precedent — adding a one-line entry plus the field handled the asymmetry without renaming on either side, which let a single Vercel variable feed every VM under the agent-expected name.

**Procedure:**
1. Update the secret value in Vercel env (all 3 environments — `printf '%s' ...| vercel env add`, no trailing newline per Rule 6).
2. Bump `SECRET_VERSION` in `lib/vm-reconcile.ts` (`+1`, never reset).
3. Commit + push. Vercel redeploys the cron route with the new constant.
4. Next cron tick (≤3 min): the OR clause widens the candidate set; `stepEnvVarPush` distributes the new value to each affected VM; on success, the route bumps that VM's `secret_version` to current.
5. Within `CONFIG_AUDIT_BATCH_SIZE × N_ticks`, all assigned+healthy VMs are caught up. Quarantined and non-healthy VMs are not touched (by design — same gating as `config_version` propagation).

### Patrol mode — proactive checks (no incident in flight)

Run every 6h or on Cooper's manual invocation. Outputs a digest only if anomalies found; silent if clean.

Checks (each implemented as a sibling of the `scripts/_audit-*.ts` family):
1. **Disk patrol**: VMs crossing 80% in past 6h that aren't yet firing `DiskAlmostFull` → preemptive flag
2. **Stuck reconcile**: VMs at `config_version < MANIFEST.version - 1` with `last_reconciled_at > 30 min ago`
3. **Stripe-DB drift**: Stripe subs vs local DB mismatch; paying customers without working VMs (Rule 14 cluster)
4. **Sentinel sweep**: random 5 healthy+assigned VMs — verify `~/.openclaw/workspace/SOUL.md` matches manifest sentinel strings (Rule 23)
5. **Silence audit**: silences >80% of duration elapsed — confirm still needed
6. **Cron lock audit**: any `instaclaw_cron_locks` row held >2h = stuck cron → orphan or genuine hang
7. **DB↔disk sanity** (Rule 34): random 5 VMs — verify `vm.telegram_bot_token` matches `~/.openclaw/openclaw.json.channels.telegram.botToken`

A weekly variant runs Sunday 03:00 UTC and emails Cooper a fleet-health digest.

### Cross-terminal coordination

Multiple CC terminals may respond to the same incident simultaneously. Coordinate to avoid duplicate fixes / silence conflicts:

1. **Acquire an incident lock** before mutating state — use the existing `lib/cron-lock.ts` helpers:
   ```typescript
   import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
   const lockKey = `incident-${alertname}-${ipAddress.replace(/\./g, '-')}`;
   const acquired = await tryAcquireCronLock(lockKey, 1800, `cc-${process.env.USER || 'unknown'}`);
   if (!acquired) { /* Another terminal owns this incident — observe, don't act */ }
   try { /* apply fix */ } finally { await releaseCronLock(lockKey); }
   ```
2. **Tag silences with terminal identity**: `--author=cc-<terminal-id>` so Cooper can trace authorship.
3. **If lock is held by another terminal**: post a comment in the incident doc with your context; do NOT also apply a fix.
4. **Release the lock after Step 6 report**, regardless of outcome.

### Post-incident review

For any P0 OR a P1 that recurs (>1 instance of same pattern in a week), within 24h drop a forensic doc at:

`instaclaw/docs/incidents/<YYYY-MM-DD>-<symptom>-<inc-id>.md`

Template:
```markdown
# INC-<ID>: <one-line description>

## Severity & scope
P0 / P1 — <N> customer(s) impacted, <N> VMs.

## Timeline (UTC)
- HH:MM — first signal source: <alert / user-report / patrol>
- HH:MM — Cooper notified (if P0)
- HH:MM — diagnosis converged on <root cause>
- HH:MM — fix applied
- HH:MM — health verified, lock released

## Root cause
<code path / metric / file:line>

## Fix
<commit SHA / commands run>

## Blast radius
- Customer downtime: <minutes total>
- Detection lag: <time from first symptom to first alert>
- Resolution lag: <time from alert to fix>

## Prevention
- Rule applied / added: R<N>
- Detection added: <Prom alert / pg_cron / patrol step>
- P1 follow-ups added: <items>

## Lessons
<1–3 short bullets — patterns Cooper or future CC should watch for>

## Forensic evidence
- Pre-fix journal: <path on VM>
- Pre-fix DB row JSON: <path>
- Pre-fix files: <path>
```

Cross-reference any newly-authored CLAUDE.md Rules.

### Quick command reference

```bash
# === Bootstrap (extract SSH key if not already on disk) ===
[ -f /tmp/ic_ssh_key ] || (grep '^SSH_PRIVATE_KEY_B64=' /Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key \
  | head -1 | sed 's/^SSH_PRIVATE_KEY_B64=//' | sed 's/"//g' | base64 -d > /tmp/ic_ssh_key && chmod 600 /tmp/ic_ssh_key)

# === SSH to fleet VM ===
SSH_OPTS="-i /tmp/ic_ssh_key -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o BatchMode=yes"
ssh $SSH_OPTS openclaw@<IP> '...'

# === SSH to monitoring VM (Prometheus + Alertmanager) ===
ssh $SSH_OPTS root@66.228.43.140 '...'

# === Prometheus query ===
ssh $SSH_OPTS root@66.228.43.140 'curl -s --data-urlencode "query=<PROMQL>" localhost:9090/api/v1/query | python3 -m json.tool'

# === Alertmanager active alerts for an instance ===
ssh $SSH_OPTS root@66.228.43.140 'curl -s localhost:9093/api/v2/alerts | python3 -c "import json,sys; [print(a[\"labels\"][\"alertname\"]) for a in json.load(sys.stdin) if a[\"labels\"].get(\"instance\")==\"<IP>:9100\"]"'

# === Silence a noisy alert (always time-bounded, always authored) ===
ssh $SSH_OPTS root@66.228.43.140 'amtool silence add --alertmanager.url=http://localhost:9093 \
  --duration=2h --author=cc-incident-<ID> --comment="<reason>" \
  alertname="<NAME>" instance="<IP>:9100"'

# === Supabase: VM by IP ===
curl "https://qvrnuyzfqjrsjljcqbub.supabase.co/rest/v1/instaclaw_vms?ip_address=eq.<IP>&select=*" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"

# === Supabase: user by id ===
curl "https://qvrnuyzfqjrsjljcqbub.supabase.co/rest/v1/instaclaw_users?id=eq.<UUID>&select=*" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"

# === Linode: instance state ===
curl -H "Authorization: Bearer $LINODE_API_TOKEN" \
  "https://api.linode.com/v4/linode/instances/<INSTANCE_ID>"

# === Linode: reboot ===
curl -X POST -H "Authorization: Bearer $LINODE_API_TOKEN" \
  "https://api.linode.com/v4/linode/instances/<id>/reboot"

# === Disk cleanup (safe defaults) ===
ssh $SSH_OPTS openclaw@<IP> '
  find ~/.openclaw/session-backups -mtime +1 -delete
  ls -t ~/.openclaw/session-backups | tail -n +1001 | xargs -I {} rm -f ~/.openclaw/session-backups/{} 2>/dev/null
  sudo journalctl --vacuum-time=2d
  find /tmp -maxdepth 1 -mtime +1 -delete 2>/dev/null
'

# === Gateway restart (single VM, with verify) ===
ssh $SSH_OPTS openclaw@<IP> '
  systemctl --user reset-failed openclaw-gateway
  systemctl --user restart openclaw-gateway
  for i in 1 2 3 4 5 6; do
    s=$(systemctl --user is-active openclaw-gateway)
    h=$(curl -sf -o /dev/null -w "%{http_code}" localhost:18789/health 2>/dev/null)
    echo "iter=$i status=$s http=$h"
    [ "$s" = "active" ] && [ "$h" = "200" ] && exit 0
    sleep 5
  done
  exit 1
'
```

### Reference: monitoring stack access

| System | Endpoint | Auth | Notes |
|---|---|---|---|
| Fleet SSH | `openclaw@<IP>` port 22 | `/tmp/ic_ssh_key` decoded from `SSH_PRIVATE_KEY_B64` in `.env.ssh-key` | All fleet VMs share one key |
| Monitoring VM SSH | `root@66.228.43.140` port 22 | Same key | Linode ID 95430641. Hosts Prometheus + Alertmanager + Grafana |
| Prometheus | `http://localhost:9090` (loopback only) | None, loopback-bound — go via monitoring VM SSH | Version 2.51.2; 30d retention; targets refresh every 5min from `/etc/prometheus/targets.json` (regenerated by `*/5` cron `/etc/cron.d/instaclaw-update-targets`) |
| Alertmanager | `http://localhost:9093` (loopback only) | None, loopback-bound | Version 0.27.0; binary install at `/usr/local/bin/alertmanager`; config `/etc/alertmanager/alertmanager.yml`; SMTP secret in `/etc/alertmanager/.smtp_password` (0640 root:prometheus) |
| Grafana | `http://66.228.43.140:3000` | Password (set in instance, not in env) | TLS pending nginx/Let's Encrypt rollout |
| Resend SMTP | `smtp.resend.com:2587` STARTTLS | username `resend`, password = `RESEND_API_KEY` | Ports 587/465 blocked by Linode outbound anti-spam; 2587 is Resend's alternate |
| Resend dashboard | `https://resend.com/emails` | Cooper login | Ground-truth email delivery (vs AM's "Notify success" which only proves relay-accept) |
| Supabase | `https://qvrnuyzfqjrsjljcqbub.supabase.co/rest/v1/` | `SUPABASE_SERVICE_ROLE_KEY` in `.env.local` | PostgREST. Use `.select("*")` for safety-critical reads (Rule 19) |
| Linode | `https://api.linode.com/v4/` | `LINODE_API_TOKEN` in `.env.local` | Read for state; write for reboot / power. Protect IDs 93105031, 94293064, 95430641 (infra) |
| Vercel | `npx vercel ...` | `vercel login` from terminal | Source-of-truth for env vars. Per Rule 6, use `printf` not `<<<` |
| Stripe | `https://api.stripe.com/v1/` | `STRIPE_SECRET_KEY` in `.env.local` | Per Rule 14, `lib/billing-status.ts` is SoT. Trust Stripe over local DB for ground truth |
| pg_cron jobs | Postgres direct via Supabase | Service-role key | Query `cron.job_run_details`. Health monitor in `app/api/cron/db-job-health/route.ts` and `app/api/cron/fleet-health-notify/route.ts` |

---

## Linode-vs-DB Drift (Reality Checks)

The DB has 836 rows with `provider_server_id` set; Linode reports only **220 live instances**. Most "terminated" VMs in our DB still carry stale Linode IDs from instances that were deleted long ago. **For any cost calculation or census reported externally, query the Linode API for the live count** — never multiply DB row count × $29.

```bash
# One-shot truth check — Linode API total
curl -s "https://api.linode.com/v4/linode/instances?page=1&page_size=1" \
  -H "Authorization: Bearer $LINODE_API_TOKEN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["results"])'
```

`scripts/_joey-real-numbers.ts` is the reference cross-reference tool — Linode API truth × `lib/billing-status.ts` classification. Re-run this before any external infrastructure conversation.

---

## OpenClaw Upgrade Playbook (MANDATORY)

> **Institutional memory from the OpenClaw 2026.4.5 → 2026.4.26 (manifest v67) upgrade incident, 2026-04-29 → 2026-04-30.** A multi-day fleet-wide outage. **Read this end-to-end BEFORE bumping `OPENCLAW_PINNED_VERSION`, `VM_MANIFEST.version`, `WORKSPACE_SOUL_MD`, or any agent-context template.** Every step here was learned the hard way.

### What went wrong (post-mortem)

Cascading failure across five layers:

1. **OpenClaw 2026.4.26 had stricter default timeouts** than 2026.4.5. Agent chat-completion requests with ~29K-token prompts started aborting before Anthropic finished generating. /health stayed 200; chat broke silently.
2. **The in-VM watchdog's 3-minute FROZEN threshold then killed gateways** that were mid-completion-but-slow. Each kill triggered a systemd restart, the gateway took ~90s to reach `ready`, the watchdog killed it again — kill loop.
3. **The reconciler's manifest entries for SOUL.md / CAPABILITIES.md are all `append_if_marker_absent` / `insert_before_marker`, never `overwrite`.** The v67 routing-table edit was an in-place row replacement, which no manifest mode supports. SOUL.md never updated on existing VMs even after `config_version` advanced. Required a one-shot fleet patch + a new surgical reconciler step (`stepV67RoutingTablePatch`).
4. **The npm-install verify in `stepNpmPinDrift` was racy.** The local-side `node-ssh` timeout fired before the remote install finalized, so `openclaw --version` returned empty and the script reported PUSH-FAILED — even when the install was already complete on disk. The bin symlink was created seconds AFTER the local-side `await` returned. Required: 600s timeout + on-disk verify (test bin symlink + package.json version + `dist/index.js`) + auto-retry on first verify miss.
5. **A fleet patch script bumped `config_version=v67` after only editing SOUL.md content.** VMs still on Node v22.22.0 + OpenClaw 2026.4.5 got tagged v67 in the DB, so the upgrade script skipped them as "already at manifest version." Recovery required a from-disk SSH audit (`_db-reset-config-version-from-disk.ts`) on ~115 VMs to reset `config_version` to actual on-disk state — corrected 83 VMs.

By the end: 83/88 v67-marked VMs couldn't complete chat completions. ~15 VMs needed individual forensics. Three days of fleet thrash. /health was green throughout.

### Pre-flight checklist (before bumping `OPENCLAW_PINNED_VERSION`)

Run **all** of these before touching anything:

1. **Read the OpenClaw release notes line by line** for the version range you're crossing. Look for: timeout/deadline default changes, config schema changes (added/removed/renamed keys), watchdog or health-check changes, plugin loader changes, Node compat changes, any "BREAKING" markers. The 2026.4.5→.26 jump introduced silent timeout-default changes that no commit message flagged.
2. **Measure prompt size against `bootstrapMaxChars`.** The agent's upfront context is `WORKSPACE_SOUL_MD + SOUL_MD_INTELLIGENCE_SUPPLEMENT + SOUL_MD_LEARNED_PREFERENCES + "\n\n" + SOUL_MD_OPERATING_PRINCIPLES + SOUL_MD_DEGENCLAW_AWARENESS + SOUL_MD_MEMORY_FILING_SYSTEM` plus CAPABILITIES.md and TOOLS.md. If the resolved total exceeds 30,000 chars (the `bootstrapMaxChars` ceiling at `lib/ssh.ts:2939`), upfront context is being silently truncated. As of v67 the SOUL.md component alone is 31,905 chars — already over. Treat any further bump as a hard stop until trimmed.
3. **Confirm the reconciler can actually push your changes.** If your edit is an in-place line replacement in SOUL.md / CAPABILITIES.md / any append-managed file, the reconciler **cannot** apply it via the existing manifest modes. You must either (a) add a surgical reconciler step (see `stepV67RoutingTablePatch` in `lib/vm-reconcile.ts`), (b) ship a one-shot fleet patch, or (c) accept that only newly-provisioned VMs will get the change. Cooper's commit message claiming "reconciler picks up the template change" is wrong by default — append modes can't replace existing rows.
4. **Walk every `stepX(...)` in `lib/vm-reconcile.ts`** and confirm none has a hard-coded assumption (timeout, schema, path, version regex) that the new OpenClaw version invalidates.

### Canary testing (NON-NEGOTIABLE before fleet rollout)

**Never bump the manifest version until canary tests pass.** Order matters:

1. **vm-050 (Cooper's test agent), full reconcile.** Reconcile to the new manifest. Send a real `POST /v1/chat/completions` with a representative ~29K-token prompt (sample the actual SOUL.md + CAPABILITIES.md + EARN.md upfront load). Verify it completes in <30 s with a non-empty response. Run the same probe **3× over 5 minutes** — single-shot success doesn't catch watchdog kill-loops, which surface on the second or third request.
2. **3 paying-user VMs, one per tier (power / pro / starter).** Pick VMs with real usage history — non-trivial sessions, customized SOUL.md identity, real bot tokens. Reconcile each. Run the same chat-completion probe on each. Watch `journalctl --user -u openclaw-gateway -f` for the full 5-minute window. Look for: SIGTERM, "received SIGTERM" within seconds of "ready", watchdog kills, OOMs, "Cannot find module" errors.
3. **Hold for at least 1 hour after the third canary completes** before bumping `VM_MANIFEST.version`. Watchdog cycles run every minute; a kill-loop will surface within 5–10 cycles.

If any canary fails, **DO NOT proceed**. Re-read the OpenClaw changelog, fix the divergence (timeout default, config key, watchdog threshold), and restart the canary cycle from step 1.

### Fleet rollout

Only after canaries are green for ≥1 hour:

- **`--concurrency=3` is the maximum.** Higher values amplify any per-VM failure into a fleet-wide stampede. The v67 rollout at concurrency=5 produced ~30% transient failure rate in wave 1; dropping to 3 stabilized it. Reliability beats speed.
- **Waves of 10 with an audit gate between each.** The audit must HALT the upgrade on the first per-VM failure (see next section).
- **Hold the `reconcile-fleet` cron lock for the duration** so the Vercel cron can't race the local script. Use `tryAcquireCronLock("reconcile-fleet", 8*3600, "manual-fleet-upgrade-vN")`.
- **Do not bake a new snapshot until the fleet upgrade is fully clean** AND has soaked for ≥1 hour. Stale snapshots cause new VMs to provision behind the manifest version and race the reconciler — same drift, same lying-DB problem.

### Wave audit gates (NON-NEGOTIABLE)

After every wave of 10, audit each VM. If any check fails, halt and investigate before the next wave.

Each audit must verify, in this order:

1. **`systemctl --user is-active openclaw-gateway` returns `active` AND `curl localhost:18789/health` returns 200**, paired in the same iteration of a 6×10s retry loop. Decoupling the two lets a flaky watchdog cycle false-pass on "active in iter 1, healthy in iter 4."
2. **Real chat completion:** `POST /v1/chat/completions` with a ~29K-token prompt. Must complete in <30 s with a non-empty response. /health is necessary but not sufficient — the gateway can be active and /health 200 while chat aborts on every request. **This is the load-bearing check.** If the wave audit doesn't include this, the audit is theater.
3. **`openclaw --version`** matches `OPENCLAW_PINNED_VERSION`.
4. **`test -f $(npm root -g)/openclaw/dist/index.js`** — the systemd unit's actual `ExecStart` entry point. Bin symlink alone isn't enough; vm-831 had the bin symlink but missing `dist/`, gateway crash-looped with `Cannot find module`.
5. **`agents.defaults.timeoutSeconds`** actually applied (read `~/.openclaw/openclaw.json`, not just the manifest spec). OpenClaw silently rejects unknown config keys and timeout-default changes can land mid-version.
6. **Watchdog thresholds** (in `~/.openclaw/scripts/vm-watchdog.py` and related crons) match the manifest's expected values.
7. **`WORKSPACE_SOUL_MD + supplements` on disk ≤ `bootstrapMaxChars`** (currently 30,000). Anything past that is silently truncated.

If any check fails on any VM in the wave, **halt the script**. Investigate the specific VM. Only resume after the failure mode is understood AND fixed at the reconciler level — not just patched on the one VM.

### Rollback plan (must exist before rollout starts)

- **Previous `OPENCLAW_PINNED_VERSION`** documented and pinnable. For the v67 incident the rollback target was 2026.4.5.
- **Keep the previous snapshot for at least 1 week** after baking a new one (per the Snapshot Creation Process). Do not delete `private/<old>` until the new version has soaked.
- **`_rollback-fleet-to-vN.ts` script** ready, mirroring `_upgrade-fleet-to-v64.ts` but pinning the OLDER version. Dry-run tested before the rollout begins, not invented during the outage.
- **DB drift recovery:** `_db-reset-config-version-from-disk.ts` SSH-audits each VM and writes `config_version` to the actual on-disk state. This is the only way to recover when the DB starts lying about what's been deployed. Required for all 3 of the v67 incident's recovery passes.

### NEVER list

These cost real production time. None are negotiable.

- **Never bump `config_version` on a VM that hasn't been fully reconciled.** Editing SOUL.md content is not the same as reconciling Node, OpenClaw, dist/, systemd unit, watchdog, and channels. A fleet patch that touches only one of these MUST NOT touch `config_version`.
- **Never trust `/health` as proof the agent works.** /health is "HTTP server is bound." Real chat completion is the only ground truth. If you didn't just send a `/v1/chat/completions` and read the response, you don't actually know if the upgrade succeeded.
- **Never fleet-roll at `concurrency > 3`.** It will look fine on the first wave and catastrophic by the third.
- **Never bump `OPENCLAW_PINNED_VERSION` without reading the OpenClaw changelog** for that version range. Timeout defaults and config schema have changed silently between point releases.
- **Never assume "PUSH-FAILED" means the VM is broken.** The script's local-side timeout can fire before the remote install finalizes; verify on-disk state (bin symlink + package.json version + `dist/index.js`) before treating it as a real failure. Conversely, never assume "✓ success" means the VM works — only a real chat completion proves that.
- **Never skip the canary phase, even for what looks like a "small" version bump.** OpenClaw point releases have shipped breaking watchdog and timeout changes.
- **Never claim a manifest content change "will propagate via reconciler"** without verifying the reconciler actually has a step that can apply that specific change. Append-managed files cannot have rows replaced via append modes.

### The watchdog interaction (critical)

Any change to OpenClaw, watchdog scripts, gateway config, or agent context **must be tested against the actual prompt size that production agents load** — currently ~29K tokens of upfront context (SOUL.md + supplements + CAPABILITIES.md + tools + pinned references).

A change that "works" on a fresh VM with no real SOUL.md will pass /health and fail every chat completion under load. The watchdog kills the gateway when it detects the agent has been "frozen" for >3 min — a slow-but-progressing chat completion looks identical to a crashed gateway from the watchdog's perspective. The result is a kill-loop that masquerades as a healthy active service: gateway "active", /health 200, chat completions all aborting at the timeout boundary.

The only safe test is: load the actual production prompt, run a real chat completion, watch journal output for the full watchdog cycle (≥5 min, ≥3 completions). If completions finish faster than the watchdog's threshold AND the journal shows no SIGTERM/restart, the upgrade is safe. Anything else, halt.

---

## Snapshot Creation Process (COMPLETE REFERENCE)

### Prerequisites

- `LINODE_API_TOKEN` in `.env.local` (or `.env.ssh-key`)
- `SSH_PRIVATE_KEY_B64` for SSH access to the bake VM
- SSH key ID `626767` (label: `instaclaw-deploy`) in Linode profile

### Step-by-Step Checklist

**1. Provision a fresh nanode from the CURRENT snapshot:**
```
POST https://api.linode.com/v4/linode/instances
{
  "label": "snapshot-bake-v{VERSION}",
  "region": "us-east",
  "type": "g6-nanode-1",
  "image": "{CURRENT_SNAPSHOT_ID}",
  "root_pass": "{RANDOM}",
  "authorized_keys": ["{SSH_KEY}"],
  "booted": true,
  "tags": ["instaclaw", "snapshot-bake"]
}
```
Wait for status=running. Note the IP address.

**2. SSH in and upgrade OpenClaw:**
```bash
source ~/.nvm/nvm.sh
npm install -g openclaw@latest
openclaw --version  # Verify latest
```

**3. Install/update system and Python packages:**
```bash
# pip may not be installed on base image
curl -sS https://bootstrap.pypa.io/get-pip.py | sudo python3 - --break-system-packages
python3 -m pip install --break-system-packages openai
```

**4. Extract and deploy manifest files from the codebase:**

The scripts, workspace files, and SOUL.md sections are embedded as template string constants in `lib/ssh.ts`, `lib/agent-intelligence.ts`, `lib/vm-manifest.ts`, and `lib/earn-md-template.ts`.

To extract them, run the extraction script from the project root:
```bash
node /tmp/extract-manifest-files.mjs .
```
This writes all files to `/tmp/snapshot-files/`. For `strip-thinking.py`, use Node.js `eval` to process `${...}` template expressions:
```javascript
// The regex extraction doesn't evaluate ${200 * 1024} expressions
// Use: eval('`' + templateBody + '`') to get the actual Python script
```

Then SCP the files to the bake VM and deploy:
- `~/.openclaw/scripts/` — strip-thinking.py, auto-approve-pairing.py, vm-watchdog.py, silence-watchdog.py, push-heartbeat.sh, generate_workspace_index.sh
- `~/scripts/` — deliver_file.sh, notify_user.sh
- `~/.openclaw/workspace/` — SOUL.md (built from components: base + intelligence supplement + learned preferences + memory filing system), MEMORY.md, CAPABILITIES.md, QUICK-REFERENCE.md, TOOLS.md, EARN.md
- `~/.openclaw/workspace/memory/` — session-log.md, active-tasks.md
- All scripts `chmod +x`

**5. Install cron jobs (7 total):**

| Schedule | Command | Marker |
|----------|---------|--------|
| `0 * * * *` | `ipcs -m ... SHM_CLEANUP` | SHM_CLEANUP (already in snapshot) |
| `* * * * *` | `python3 ~/.openclaw/scripts/strip-thinking.py` | strip-thinking.py |
| `* * * * *` | `python3 ~/.openclaw/scripts/auto-approve-pairing.py` | auto-approve-pairing.py |
| `* * * * *` | `python3 ~/.openclaw/scripts/vm-watchdog.py` | vm-watchdog.py |
| `0 * * * *` | `bash ~/.openclaw/scripts/push-heartbeat.sh` | push-heartbeat.sh |
| `* * * * *` | `python3 ~/.openclaw/scripts/silence-watchdog.py ...; sleep 30 && ...` | silence-watchdog.py |
| `0 4 * * *` | `/home/openclaw/.nvm/.../openclaw memory index` | openclaw memory index |

Use marker-based idempotent install: check `crontab -l | grep -q "MARKER"` before adding.

**6. Clean caches aggressively:**
```bash
source ~/.nvm/nvm.sh && npm cache clean --force
sudo apt-get clean && sudo rm -rf /var/lib/apt/lists/*
python3 -m pip cache purge; sudo rm -rf /root/.cache/pip ~/.cache/pip
rm -rf /tmp/* ~/.nvm/.cache
sudo journalctl --vacuum-time=1d
sudo rm -rf /var/log/*.gz /var/log/*.1 /var/log/*.old
```

**7. Run 15-point verification (ALL must pass):**

| # | Check | Command |
|---|-------|---------|
| 1 | OpenClaw installed | `openclaw --version` |
| 2 | Node.js v22 | `node --version \| grep v22` |
| 3 | Chromium | `test -x /usr/local/bin/chromium-browser` |
| 4 | ffmpeg | `which ffmpeg` |
| 5 | jq | `which jq` |
| 6 | node_exporter | `which node_exporter` |
| 7 | Xvfb + x11vnc + websockify | `which Xvfb && which x11vnc && which websockify` |
| 8 | exec-approvals.json (security=full) | `cat ~/.openclaw/exec-approvals.json \| python3 -c "..."` |
| 9 | SSH deploy keys (≥2) | `wc -l < ~/.ssh/authorized_keys` |
| 10 | loginctl linger enabled | `loginctl show-user openclaw \| grep Linger=yes` |
| 11 | strip-thinking.py has session-end hook | `grep -q run_session_end_hook ~/.openclaw/scripts/strip-thinking.py` |
| 12 | SOUL.md has memory filing system | `grep -q MEMORY_FILING_SYSTEM ~/.openclaw/workspace/SOUL.md` |
| 13 | memory/session-log.md exists | `test -f ~/.openclaw/workspace/memory/session-log.md` |
| 14 | memory/active-tasks.md exists | `test -f ~/.openclaw/workspace/memory/active-tasks.md` |
| 15a | Cron: strip-thinking.py | `crontab -l \| grep -q "strip-thinking.py"` |
| 15b | Cron: auto-approve-pairing.py | `crontab -l \| grep -q "auto-approve-pairing.py"` |
| 15c | Cron: vm-watchdog.py | `crontab -l \| grep -q "vm-watchdog.py"` |
| 15d | Cron: push-heartbeat.sh | `crontab -l \| grep -q "push-heartbeat.sh"` |
| 15e | Cron: silence-watchdog.py | `crontab -l \| grep -q "silence-watchdog.py"` |
| 15f | Cron: openclaw memory index | `crontab -l \| grep -q "openclaw memory index"` |
| 15g | Cron: SHM cleanup | `crontab -l \| grep -q "SHM_CLEANUP"` |
| 16a | CDP backup wallet helper `instaclaw/lib/cdp-wallet.ts` present | `test -f /Users/cooperwrenn/wild-west-bots/instaclaw/lib/cdp-wallet.ts` |
| 16b | `@coinbase/cdp-sdk` in `instaclaw/package.json` | `grep -q '@coinbase/cdp-sdk' /Users/cooperwrenn/wild-west-bots/instaclaw/package.json` |
| 16c | CDP env vars set in Vercel `instaclaw` project (production + preview) | Vercel dashboard → instaclaw → Settings → Environment Variables. Must show `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET`. |
| 16d | Migration `20260524180000_vm_cdp_wallet.sql` applied to prod | `SELECT column_name FROM information_schema.columns WHERE table_name='instaclaw_vms' AND column_name IN ('cdp_wallet_id','cdp_wallet_address');` — must return 2 rows |
| 16e | Cron `/api/cron/provision-missing-cdp-wallets` registered | `grep -q 'provision-missing-cdp-wallets' /Users/cooperwrenn/wild-west-bots/instaclaw/vercel.json` |

**CRITICAL: ALL 7 crons (15a-15g) must be present.** Missing crons caused a P0 incident on 2026-04-08 where sessions grew to 4MB+ and burned credits 20x faster (see commit 68e9e4c). The reconciler does NOT catch missing crons on freshly configured VMs — configureOpenClaw() now installs them, but they must also be in the snapshot as defense-in-depth.

**CRITICAL: items 16a-16e are non-negotiable.** Missing any of them means newly-provisioned VMs from this snapshot will have NO backup wallet during a Bankr outage. The original CDP infrastructure was lost during the Bankr cutover in early 2026 and silently absent for months; restored 2026-05-24 (Cooper P0). The `scripts/_pre-bake-check.ts` script verifies all five gates automatically (`checkCdpReadiness`) and refuses the bake on any failure.

**8. Check disk usage — MUST be under 5.9GB:**
```bash
df -h / | tail -1
# Used must be < 5.9GB. Image limit is 6144MB.
# If over, clean more aggressively: rm -rf ~/.cache, check /usr/local for bloat
```

**9. Power off VM cleanly:**
```
POST /v4/linode/instances/{ID}/shutdown
```
Poll until status=offline. **DO NOT delete SSH host keys or machine-id** — cloud-init regenerates them on first boot.

**10. Create image:**
```
# Get disk ID (ext4 disk, not swap)
GET /v4/linode/instances/{ID}/disks

# Create image
POST /v4/images
{
  "disk_id": {DISK_ID},
  "label": "instaclaw-base-v{VERSION}-{description}",
  "description": "OpenClaw {version} + {changes}. 15/15 verified."
}
```
Poll `GET /v4/images/{IMAGE_ID}` until status=available. Verify size < 6144MB.

**11. Update all references:**
- `CLAUDE.md` — snapshot ID and description in "VM Provisioning Standard"
- `.env.local` — `LINODE_SNAPSHOT_ID="private/{NEW_ID}"`
- `reference_vm_provisioning.md` (project memory) — snapshot ID + contents list
- `MEMORY.md` (project memory) — snapshot ID
- **Vercel environment variables** — Cooper must update `LINODE_SNAPSHOT_ID` in Vercel dashboard

**12. Clean up:**
- Delete the temp nanode: `DELETE /v4/linode/instances/{ID}`
- Keep the OLD snapshot for 1 week as rollback
- After 1 week with no issues, delete the old snapshot

### Snapshot Gotchas (Lessons Learned)

- **6144MB hard limit** — Linode images over this silently fail. Current images are ~5.8GB. Always check `df -h` before imaging.
- **DO NOT delete SSH host keys or machine-id** — cloud-init regenerates these on first boot from snapshot. Deleting them before imaging breaks SSH access on deployed VMs.
- **DO NOT use ready-pool VMs as the base** — they were provisioned from the OLD snapshot and may have inconsistent state from partial reconciler runs, failed health checks, or stale cron output. Always provision a FRESH nanode from the current snapshot.
- **Always use a nanode (g6-nanode-1)** for baking — 25GB disk keeps the image small. Dedicated-2 VMs have 80GB disks which produce larger images that may exceed the 6144MB limit.
- **Template string extraction needs eval** — scripts like strip-thinking.py use JavaScript template expressions (`${200 * 1024}`) that must be evaluated by Node.js, not extracted as raw text.
- **strip-thinking.py modifies all session files** — it touches every .jsonl file on every run (strips thinking blocks), which equalizes their mtimes. The session-end hook uses sessions.json session IDs for transition detection, NOT file modification times.
- **OpenClaw caches MEMORY.md at session creation** — changes to MEMORY.md during an active session are NOT visible until the next session starts. This is by design for cross-session memory.
- **Image creation takes ~5 minutes** — poll status every 20 seconds. Size field shows disk size (25088MB) during creation, then actual image size after completion.
- **Old images can pile up** — Linode had 196 orphaned images (2TB) from deleted VMs. Periodically audit with `GET /v4/images` and delete unused ones.

---

## Manifest Version Changelog

Single source of truth for what each `VM_MANIFEST.version` bump contains. Used for release notes, fleet-drift debugging, and post-mortems. Append-only — never rewrite history. Update at the same time as the version bump itself.

### Version-bump policy (when to bump `VM_MANIFEST.version`)

`VM_MANIFEST.version` is the gate the reconciler uses to decide which VMs need to re-reconcile. The cron's filter at `app/api/cron/reconcile-fleet/route.ts` is `lt("config_version", VM_MANIFEST.version)` — so a bump forces every caught-up VM back into the candidate queue. Picking the right bucket prevents both (a) silent stale-fleet drift (no bump when there should be one — Rule 47 territory) and (b) needless fleet thrash (a bump when nothing actually needs to propagate, ~150 reconciles + restarts for cosmetic reasons).

**MUST bump** — any change that needs to reach every existing VM via the reconciler:

- Any change to `configSettings` (new key, removed key, changed value, changed default).
- Any change to a `files[]` entry's `content`, `path`, `mode`, `marker`, `requiredSentinels`, or `templateKey` — including embedded scripts (`STRIP_THINKING_SCRIPT`, `WORKSPACE_SOUL_MD`, etc.) consumed by a `templateKey` reference.
- Any new reconciler step in `lib/vm-reconcile.ts` (the orchestrator's call site list expands, and existing VMs at the prior cv haven't run the new step).
- Any new `cronJobs[]` entry, or change to an existing entry's command or schedule.
- Any change to `systemdOverrides` content.
- Any change to `systemPackages`, `npmGlobals`, or other manifest arrays that drive idempotent install steps.
- Any change to `requiredEnvVars`, `envVarDefaults`, or `SECRET_ENV_VAR_SOURCES` that callers expect to land on existing VMs (note: secret-value rotations use `SECRET_VERSION` instead — see "rotating secrets" runbook).
- Any version-gated behavior in a reconciler step (e.g., a step that switches between two code paths based on `vm.config_version`).
- Any change that's documented in this changelog. If a change is interesting enough to write an entry, it's interesting enough to gate via cv.

**OPTIONAL bump** — judgment call; bump if you want a single coordinated rollout, skip if it's truly inert:

- Pure refactors that preserve byte-for-byte semantics (e.g., extracting a helper function with identical behavior — the v104 `ensureUfwAllow` extraction is the reference example; it bumped because the dispatch step's behavior changed, not because the extraction itself needed it).
- Error-classification reclassification (moving a `result.errors.push` to `result.warnings.push` per Rule 39 — bump if you want the reclassification visible in the changelog timeline, skip if the immediate behavior change is the same).
- Comment-only changes in a `files[]` content that's bash/python/markdown (the comment IS user-visible on disk, so technically content changed — but if it's truly comments-only with no behavior change, no need to thrash the fleet).
- Documentation-only changes to docblocks ABOVE the `version:` field in `vm-manifest.ts` (these don't affect anything on disk).

**MUST NOT bump** — fleet thrash for no benefit, costs ~150 reconciles + gateway restarts:

- Cosmetic edits to `vm-manifest.ts` itself (formatting, import ordering, JSDoc rewording).
- Edits to files that aren't consumed by `vm-manifest.ts:files[]` or `templateKey` references (CLAUDE.md, PRDs under `instaclaw/docs/`, scripts under `instaclaw/scripts/`, any path that doesn't ship to a VM).
- Comment-only changes to TS source files where the comment isn't echoed to disk.
- Pre-deploy housekeeping (gitignore, package.json devDeps, CI changes, test-only additions).
- "Just to be safe, bump it" — if you can't name a specific reconciler step that needs to run, the bump is wrong. Use the file-drift cron (Rule 47) for template-only updates that don't merit a version gate.

**Detection rule**: every PR that touches `lib/vm-manifest.ts` outside the docblock must (a) bump the version OR (b) add a PR-description note explaining why it's a MUST-NOT bump. CI rule on the wishlist; for now treat as a code-review checkbox. Conversely, every PR that bumps the version must add a changelog entry below (newest first) — silent bumps produce orphan version numbers that future operators can't reason about.

**Pairing with Rule 47 (file-drift cron)**: a template change that doesn't bump the manifest version still needs to reach existing caught-up VMs. The file-drift cron at `app/api/cron/file-drift/route.ts` runs `stepFiles` continuously (no version gate) so any `files[]` content change propagates within ~3-5 minutes regardless. The version bump is what locks the change to a cv — "cv=N means this file content" — and what blocks new VMs at older snapshots from regressing the change.

### v113 — 2026-05-22 (force-reconcile to pick up stepTelegramBotDescription from 60979082)

- **Manifest change**: `VM_MANIFEST.version` bumped 112 → 113. **NO new
  reconciler step, NO config change, NO file content change.** This is a
  pure force-reconcile bump. The underlying steps, configSettings,
  files[], and cronJobs are byte-identical to v112.
- **Why**: commit `60979082` (2026-05-22, "stepTelegramBotDescription —
  POOL coverage gap fix") added a brand-new reconciler step to
  `lib/vm-reconcile.ts:reconcileVM`'s orchestrator chain AFTER `ed32e3e3`
  (the v112 manifest bump) had already landed. The PR did not bump the
  manifest version. The reconcile-fleet cron filters candidates with
  `lt(config_version, VM_MANIFEST.version)` = `lt(cv, 112)`. With the
  fleet at cv=112 across 156/156 healthy+assigned VMs, the cron's
  candidate set was empty — `reconcileVM` never ran — so the new step
  was silently dead on the existing fleet. Cloud-init VMs were covered
  (setup.sh §1.34 sets the description directly). Pool VMs assigned
  pre-60979082 were NOT covered (assigned before the step existed, no
  re-reconcile path to make it fire).
- **Rule 47 violation**: this is exactly the class of bug Rule 47 covers
  — "new reconciler steps require either a manifest bump OR a one-shot
  fleet push." `stepTelegramBotDescription` is SSH+curl (not a file
  deploy), so the file-drift cron can't help. Manifest bump is the
  correct fix. Caught by Cooper during end-of-day audit when he asked
  "are there any commits on main that added new reconciler steps AFTER
  v112 was set?"
- **What v113 actually does**: bumps cv to 113, which forces every
  cv=112 VM back into the reconcile-fleet candidate query. Each VM hits
  `reconcileVM` on its next cron tick (within ~3 min at default cadence).
  `stepTelegramBotDescription` runs once per VM — for each pool VM in
  the affected cohort, it (a) reads the bot token from `.env`, (b) calls
  Telegram `getMyDescription` + `getMyShortDescription` as idempotency
  gates, (c) POSTs `setMyDescription` + `setMyShortDescription` only
  when the current text differs from expected. Steady-state: ~150 GET
  calls per tick across the fleet (one per bot), <150 POST calls total
  across the entire rollout (one per VM that's out of date), then
  alreadyCorrect forever after. Telegram bot-API limit is 30 calls/sec
  per bot token; we're orders of magnitude under.
- **Fleet rollout window**: ~30 min for all 156 VMs to reach cv=113 at
  `CONFIGURE_AUDIT_BATCH_SIZE=3` and 3-min cron cadence. Caught-up VMs
  hit alreadyCorrect on the description-step and skip-cost zero.
- **Snapshot bake interaction**: announced to snapshot terminal at
  bump time so the bake VM reconciles to cv=113, not the now-stale
  cv=112. Without this notice the bake would have produced a v112-cohort
  snapshot that immediately needs to re-reconcile to v113 on every
  fresh provision — wasteful but not broken.
- **Detection note**: future post-bump audit query — any commit message
  matching `feat\(reconcile\): step[A-Z]` that landed AFTER the most-
  recent `feat\(v\d+\)` commit and BEFORE the next one is a Rule 47
  candidate.
- **Rollback**: revert this commit. Fleet sticks at cv=112; the
  `stepTelegramBotDescription` step continues to fire only on
  pool-assignment + freshly-cv-reset VMs. Cloud-init VMs are covered by
  setup.sh §1.34 either way. No data is lost; the worst case is a
  population of pool VMs whose bot profiles never get the "i take a
  moment to wake up..." description set (cosmetic, not load-bearing).

### v111 — 2026-05-20 (stepEdgeOSApiKey — per-VM eos_live_* key for Edge Esmeralda 2026 calendar)

- **Manifest change**: `VM_MANIFEST.version` bumped 110 → 111. New reconciler step `stepEdgeOSApiKey` (called as Step 1e, immediately after `stepIndexProvision`) mints a per-VM `eos_live_*` API key against EdgeOS for `events:read` scope, persists it to the new `instaclaw_vms.edgeos_api_key` column, and deploys it to `~/.openclaw/.env:EDGEOS_API_KEY`. Partner-gated to `edge_city`. Companion column migration shipped earlier in `supabase/migrations/20260520190000_vm_edgeos_api_key.sql`. Companion configureOpenClaw wiring landed in `lib/ssh.ts` for fresh provisioning; this step backfills the 9 existing edge VMs.
- **Why**: D3 in the Edge Esmeralda master PRD (2026-05-19). The 9 edge_city VMs already carry `EDGEOS_BEARER_TOKEN` (shared bearer for the ATTENDEE directory), but the edge-esmeralda skill's calendar / events reads need a per-VM key with `events:read` scope. Without this step, every edge attendee's agent fails authenticated calendar reads silently. The fix shipped to `configureOpenClaw` first (PR commit `60b904f5`) only fires on fresh provisioning — none of the 9 existing edge VMs would mint a key without a reconciler-side path.
- **Pattern mirror**: stepEdgeOSApiKey replicates stepIndexProvision (v105) exactly — same partner gate, same strict-mode bypass, same warnings-only failure posture per Rule 39, same DB-before-disk persistence ordering, same verify-after-write per Rule 10. Two intentional deviations: (a) Gate 3 defensive partial-SELECT guard (`vm.edgeos_api_key === undefined` → skip) so the step is safe when invoked by reconcileVM callers that don't load the column, preventing orphan-mint accumulation on EdgeOS; (b) on-disk verify checks EXACT equality against the DB value (Rule 58 cross-consumer match) instead of stepIndexProvision's transport-string-present check — motivated by the 2026-05-18 vm-050 gbrain bearer mismatch incident.
- **Idempotency**: `hasLocalKey` short-circuits the EdgeOS API call when DB has a cached `eos_live_*` (EdgeOS shows secrets once; re-minting would create orphans forever). Disk drift (DB cached, .env missing) triggers a rewrite-from-cached-DB-key path, NOT a fresh mint. Cooper's call 2026-05-20: `onConflict="suffix"` on the actual mint path is acceptable — orphan EdgeOS keys are inert and sweepable post-launch; clean is better than reconciling unknown state from prior testing.
- **reconcile-fleet SELECT extension**: `app/api/cron/reconcile-fleet/route.ts:412` adds `edgeos_api_key` to the explicit column list. One-column addition mirroring how `index_user_id`/`index_api_key` were threaded.
- **Fleet rollout**: reconcile-fleet picks up v111 next cycle. The 4 edge VMs currently at cv=110 (vm-050, vm-354, vm-771, vm-923) re-enter the candidate query and hit `stepEdgeOSApiKey` on the first reconcile. The 5 already-stale edge VMs (vm-859, vm-917, vm-922 at cv=108; vm-777, vm-780 at cv=109) would also pick it up on their next reconcile regardless of the bump. Non-edge VMs hit Gate 1, early-out at zero cost. Expected window: 3-5 min after Vercel deploys.
- **Verifier**: `scripts/_verify-edgeos-api-key.ts` validates the four required invariants per VM (Rules 34 + 58): DB present + shape OK, disk present + shape OK, DB-disk match, SSH reachable.
- **Rollback**: revert the commit (3-commit set: `bf74f193` migration + `60b904f5` configureOpenClaw + `12842fb2` reconciler step + `<this-commit>` manifest bump). Existing minted keys remain in DB/disk (rollback doesn't auto-undo on-disk state); future reconciles with the older code would no-op on edge VMs.

### v108 — 2026-05-19 (EDGE_INSTACLAW_OVERLAY_MD copy fix — "Social Layer" → EdgeOS canonical)

- **Manifest change**: `VM_MANIFEST.version` bumped 107 → 108. Pure content edit to `EDGE_INSTACLAW_OVERLAY_MD` in `lib/partner-content.ts`. No new reconciler step, no schema change, no config-key change.
- **Why**: the deployed `~/.openclaw/skills/edge-esmeralda/INSTACLAW_OVERLAY.md` on all 9 edge_city VMs (verified 2026-05-19 vm-050 + vm-354, sha `11adcb6f8897fa07…`) contained the line *"query the live APIs via the edge-esmeralda skill (Social Layer for events, EdgeOS for attendees)"*. Sola / Social Layer was deprecated for Edge Esmeralda 2026 per Tule's 2026-05-14 confirmation — EdgeOS is now canonical for BOTH events and attendees. The stale parenthetical was actively misleading the agent toward a deprecated backend. Flagged in the 2026-05-19 Edge Esmeralda master PRD (`docs/prd/edge-esmeralda-master-prd-2026-05-19.md` §B4) as P0.
- **Fix shape**: replace the parenthetical with explicit deprecation framing: *"…query the live APIs via the edge-esmeralda skill — don't guess from stale reference content. (EdgeOS is the canonical backend for both events and attendees at Edge Esmeralda 2026; Sola / Social Layer is deprecated.)"* This keeps the deprecation context in case the agent has been trained on older mixed-backend docs (so it doesn't drift back).
- **Deploy mechanism**: `stepDeployEdgeOverlay` in `lib/vm-reconcile.ts:8126` already handles this. SHA-verified push: computes expected sha256 of `EDGE_INSTACLAW_OVERLAY_MD`, compares to on-disk file, atomic-writes `.tmp + mv` + verifies (Rule 10). Idempotent skip on match. Edge-case: if `~/.openclaw/skills/edge-esmeralda/` is missing (private-repo clone-auth failure), result.warnings (not errors) per Rule 39 — non-critical, won't block cv-bump.
- **Fleet rollout**: reconcile-fleet picks up v108 next cycle. 9 edge_city VMs hit `stepDeployEdgeOverlay`, sha mismatch detected (`11adcb6f…` → new sha), atomic-write + verify, cv→108. Non-edge VMs fast-path the step (early-return on `vm.partner !== "edge_city"`). Expected window: ~3-5 min after Vercel deploy.
- **Verify-after-deploy**: SSH probe vm-050 + vm-354 + 1 random other edge VM, confirm new sha and confirm grep for "Social Layer" returns 0 hits (was 1 hit pre-fix).
- **Rollback**: revert this commit. Next reconciler cycle pushes the old content back. Old sha known (`11adcb6f8897fa07…`).
- **Tests**: no synthetic tests required — pure copy edit verified against the deployed sha post-fix.

### v106 — 2026-05-19 (stepDeployGbrainSoulRouting — gbrain-first SOUL.md section on edge_city)

- **Manifest change**: `VM_MANIFEST.version` bumped 105 → 106. New reconciler step `stepDeployGbrainSoulRouting` (called right after `stepDeployGbrainSoulProtocol`) **REPLACES** the legacy MEMORY.md-first `## Memory Persistence (CRITICAL)` section in SOUL.md with the gbrain-first `GBRAIN_SOUL_ROUTING_V1` marker-bounded block. Canonical block stored as base64 in `lib/workspace-templates-v2.ts` (preserves vm-050's exact bytes including legacy `\`` double-escapes — sha `857b749d6187...`). Companion fix in `lib/ssh.ts:configureOpenClaw` post-assembly conditional injection closes the 3-5 min race window between fresh-VM assignment and first reconciler tick. `GBRAIN_PARTNER_ALLOWLIST` exported from `lib/vm-reconcile.ts` as single source of truth shared by both surfaces.
- **Why**: 2026-05-19 fleet audit found 8 of 9 edge_city VMs had the OBSOLETE MEMORY.md-first section in SOUL.md (bit-identical, sha `6010222d370f`), despite having gbrain v0.36.3.0 installed. Only vm-050 had been hand-fixed via `scripts/_push_gbrain_fix.ts` on 2026-05-17. AGENTS.md's `GBRAIN_MEMORY_PROTOCOL_V1` (v102) was deployed fleet-wide, but agents read SOUL.md at session start — the contradictory MEMORY.md-first content there overrode the AGENTS.md gbrain guidance, so no persistent memory got built in practice for edge_city users for ~2 days.
- **Triple gate** (defense in depth, cheapest check first): `vm.partner ∈ GBRAIN_PARTNER_ALLOWLIST` AND `GBRAIN_INSTALL_ENABLED env === "true"` AND `gbrain.service active` (SSH probe). Companion commit `8f3f778b` retrofits the same triple gate onto v102's `stepDeployGbrainSoulProtocol` (closes a latent VM-reassignment bug — frozen edge_city VM thawed and assigned to non-edge would inject gbrain content into the new tenant's AGENTS.md).
- **REPLACE not INSERT**: unlike v102's stepDeployGbrainSoulProtocol (additive into AGENTS.md), this step REPLACES the SOUL.md section. The two versions occupy the same logical role; coexistence would create contradictory routing. Net SOUL size delta on the 8 vanilla VMs: **−246 bytes each** (replacement is cleaner + smaller). vm-050 delta: +66 bytes (marker overhead, content unchanged).
- **Safeguards** (Rules 22, 23, 39): backup to `~/.openclaw/backups/v106-gbrain-soul-routing-<ts>/SOUL.md` before any write; sentinel guard refuses to write if canonical block missing `{gbrain__put_page, gbrain__search, gbrain__submit_job, Memory Persistence (CRITICAL)}`; **drift-check** — sha256 of on-disk section MUST match `GBRAIN_SOUL_ROUTING_V1_KNOWN_OK_SHAS` (vanilla `6010222d370f` or vm-050 hand-deploy `857b749d6187`). Anything else = user-customized = SKIP + P1 admin alert via 6h-deduped `instaclaw_admin_alert_log` (warnings push, doesn't block cv-bump). Atomic write + verify-after-write marker grep.
- **Pre-commit deploy**: shipped to all 9 edge_city VMs via `scripts/_deploy-gbrain-soul-routing-v106.ts` (vm-050 canary first, then 8 sequentially) BEFORE the commit landed. The reconciler runs as a no-op idempotent skip on its first cycle. Per-VM identity content byte-identical pre/post per the deploy script's authoritative sha verification. Local backups at `/tmp/gbrain-soul-routing-v106-2026-05-19T18-*`.
- **Surfaces 2 & 3**: May 23 bake recipe needs no changes — snapshot's SOUL.md is short-lived (rewritten at assignment). New VM onboarding: `configureOpenClaw` conditional injection handles it; when gbrain tools aren't yet installed, the routing block's "If gbrain is unavailable" clause kicks in gracefully until the next reconciler tick installs gbrain.
- **Fleet rollout**: reconcile-fleet picks up v106 next cycle. Forces re-reconcile across all 146 healthy+assigned VMs. 9 edge VMs already have marker → idempotent skip → cv→106. 137 non-gbrain VMs early-out at partner-allowlist gate (zero cost). Full fleet at cv=106 within ~30 min of Vercel deploy.
- **Tests** (Rule 31): `scripts/_test-gbrain-soul-routing-inject.ts` — 26/26 synthetic assertions pass (canonical body sha matches vm-050; vanilla → marker-wrapped output, byte-identical identity content; vm-050 → markers added, content unchanged; double-injection idempotent; missing/reversed anchors return unchanged).
- **Detection note** (Rule 27): `scripts/_coverage-gbrain-soul-routing.ts` reports per-VM marker presence + gateway/gbrain health. Exit 0 only if every gbrain-eligible VM has the marker. Post-deploy: 9/9 ✓ marker, 9/9 gateway active, 9/9 gbrain active.
- **PRD**: `docs/prd/gbrain-soul-routing-3-surface-analysis-2026-05-19.md`.
- **Rollback**: revert the commits. Marker blocks stay on-disk where they landed (no removal path; idempotent replay is a no-op). Manual cleanup via per-VM backup at `~/.openclaw/backups/v106-gbrain-soul-routing-<ts>/SOUL.md` if rollback must also reverse on-disk state. Open follow-up: investigate whether AGENTS.md is still bootstrap-loaded post-Phase-1-merge — if dead weight, deprecate `stepDeployGbrainSoulProtocol` (P1).

### v105 — 2026-05-18 (stepIndexProvision — Index Network MCP for edge_city)

- **Manifest change**: `VM_MANIFEST.version` bumped 104 → 105. New reconciler step `stepIndexProvision` (partner-gated to `edge_city`). Adds 4 nullable columns to `instaclaw_vms` (`index_user_id`, `index_api_key`, `index_provisioned_at`, `index_provisioned_failed_at`) — migration at `supabase/pending_migrations/20260518210000_vm_index_network_columns.sql`, applied to prod 2026-05-18 BEFORE deploy (per Rule 56). Step calls Index Network `POST /signup` once per VM (per-tick re-call would invalidate the in-use `apiKey` per Yanek's idempotency contract), caches the returned credentials in the new DB columns, writes `mcp.servers.index` via `openclaw mcp set` (hot-reloadable per Rule 32 — no gateway restart needed).
- **Why**: Edge Esmeralda 2026 (2026-05-30, ~1000 attendees) needs every edge_city agent to be able to express user intents through Index Network's discovery protocol and receive bilateral-negotiated opportunities back. Without provisioning, edge_city agents have the env vars but no MCP server wiring, so the LLM sees no `index_*` tools and can't participate in the protocol.
- **Partner gate**: line 1 of the step returns `alreadyCorrect: true` for any VM where `vm.partner !== "edge_city"`. Other partners (and unpartnered VMs) gate out cleanly at zero cost — no API call, no DB write.
- **Failure mode**: Rule 39 — Index is optional. Failures push to `result.warnings`, not `result.errors`. cv-bump proceeds; a paying customer doesn't get blocked behind a partner-API hiccup.
- **Fleet rollout**: reconcile-fleet picks up v105 next cycle. Forces re-reconcile across the 9 edge_city VMs (all at cv≤104 after the v103/v104 propagation window). Non-edge VMs early-out at the gate.
- **Detection note**: after rollout, `SELECT name, index_user_id IS NOT NULL AS provisioned FROM instaclaw_vms WHERE partner='edge_city'` should show 9/9 `provisioned=true`. Probe via `_verify-edge-readiness.ts` for end-to-end check (MCP wired in openclaw.json + env vars present + DB columns populated).
- **PRD**: `docs/prd/village-index-network-integration.md`.
- **Rollback**: revert the commit. Existing `index_user_id` values stay in DB (additional re-call would invalidate them per Yanek; safer to leave). Removing the MCP entry from `openclaw.json` requires a separate `openclaw mcp delete` call — not auto-undone by reconciler.

### v104 — 2026-05-18 (ensureUfwAllow helper; Rule 57 anti-pattern closure in dispatch)

- **Manifest change**: `VM_MANIFEST.version` bumped 103 → 104. Extracted the v103 `probe-add-verify` ufw logic from `stepUfwRules` into a reusable `ensureUfwAllow(ssh, port, protocol, result, vm)` helper at `lib/vm-reconcile.ts`. `stepDispatchServer` now uses it for `ufw allow 8765/tcp`, closing the prior `sudo ufw allow 8765/tcp || true` line that silently swallowed every failure mode and only ran on redeploy.
- **Why**: Rule 39 audit of three reconciler steps Cooper flagged surfaced a Rule 57 anti-pattern in `stepDispatchServer` — the `|| true` masked failures and didn't propagate them to `result.warnings`, so any ufw misconfiguration on a dispatch-enabled VM stayed invisible until external probing. Behaviorally identical to the v103 ufw-9100/tcp gap (8 VMs ufw-drifted while node_exporter bound locally — 1-4 days of false-positive `VMUnreachable` noise).
- **Behavior**: helper does grep-then-add + post-add verify (Rule 23 / Rule 57). Idempotent. Failures push to `result.warnings`, not `result.errors` — monitoring/dispatch is non-critical (Rule 39).
- **Fleet rollout**: forces re-reconcile across VMs that already reached cv=103 in the v103 propagation window, so the dispatch fix reaches them too. Without the bump, only cv<103 VMs would pick it up via the reconciler's `lt(config_version, 104)` filter.
- **Detection note**: after rollout, sample 5 dispatch-enabled VMs and grep `sudo ufw status numbered | grep 8765` for the explicit ALLOW rule. If absent on a cv=104 VM, the helper failed silently — check `result.warnings` for that VM.
- **Rollback**: revert the commit. The helper extraction is byte-for-byte equivalent in behavior to the prior v103 inline code; only the dispatch step's failure-surfacing changes back to the silent `|| true`.

### v103 — 2026-05-18 (stepUfwRules + Rule 57 — enforce ufw 9100/tcp fleet-wide)

- **Manifest change**: `VM_MANIFEST.version` bumped 102 → 103. New reconciler step `stepUfwRules` runs `sudo ufw allow 9100/tcp` (probe → add → verify) on every VM. Three coordinated pieces in the same commit: (a) the new step, (b) `stepNodeExporter` now verifies external reachability via the textfile-collector path (was local-bind-only), (c) Rule 57 added to CLAUDE.md documenting the "verify-the-effect-not-the-call" pattern for firewall mutations.
- **Why**: 2026-05-18 IR triage on `VMUnreachable` alerts found 8 VMs whose `node_exporter` was bound locally and serving `/metrics`, but ufw was dropping connections from the monitoring VM at port 9100. 1-4 days of `VMUnreachable` noise that masked the real P1 (vm-748 disk pressure customer-down). Root cause: prior reconciler verified the `ss -tln | grep :9100` local bind succeeded, but never that Prometheus could externally reach it.
- **Failure mode**: Rule 39 — monitoring-only. Failures push to `result.warnings`. cv-bump proceeds.
- **Sentinel guard**: per Rule 23, the step probes `sudo ufw status numbered | grep -E "9100/tcp.*ALLOW"` after the add. If the post-add probe doesn't find the rule (e.g., ufw inactive, sudo password required, ufw mid-reload), the failure surfaces as a `result.warnings` push instead of false success.
- **Fleet rollout**: reconcile-fleet picks up v103 next cycle. Drains the cv<103 cohort over ~2-3h with `CONFIG_AUDIT_BATCH_SIZE=3`.
- **Detection note**: after rollout, the monitoring VM's Prometheus `up{job=~"node_exporter"}` should show >99% green steady-state. Any VMs still showing `up=0` with `node_exporter` locally bound are candidates for the same gap (ufw inactive, drop-in rule conflict).
- **Rollback**: revert the commit. The `ufw allow 9100/tcp` rules added by prior reconciles stay in place (ufw rule removal needs an explicit `sudo ufw delete allow 9100/tcp` — not auto-undone).

### v102 — 2026-05-17 (canonicalize gbrain memory protocol into AGENTS.md fleet-wide)

- **Manifest change**: `VM_MANIFEST.version` bumped 101 → 102. New reconciler step `stepDeployGbrainSoulProtocol` writes the gbrain memory protocol block into `~/.openclaw/workspace/AGENTS.md` on every VM where gbrain is installed. Marker-guarded (`GBRAIN_MEMORY_PROTOCOL_V1`) for idempotency. Source-of-truth constant: `lib/workspace-templates-v2.ts:GBRAIN_MEMORY_PROTOCOL_V1_AGENTS_BLOCK`.
- **Why**: 2026-05-17 SOUL.md canary diagnosis found a 7-of-8 distribution gap on edge_city VMs. vm-050 had the gbrain protocol from a manual ops script (`_push_gbrain_fix.ts`); the other 7 edge_city VMs had ZERO gbrain instructions in SOUL.md/AGENTS.md despite having gbrain installed. Agents saw the MCP tools but had no routing telling them WHEN to use them — so MEMORY.md / `save_memory` / `recall_memory` weren't being used in practice on those VMs.
- **Behavior**: step reads the existing AGENTS.md, checks for the `GBRAIN_MEMORY_PROTOCOL_V1` marker. If absent, append-inserts the canonical block. If present, no-op (idempotent). VMs without gbrain installed skip the step entirely (gate: `if (!gbrainInstalled) return alreadyCorrect`).
- **Fleet rollout**: reconcile-fleet picks up v102 next cycle. Drains the cv<102 cohort within ~3-4h.
- **Detection note**: after rollout, `grep -l GBRAIN_MEMORY_PROTOCOL_V1 ~/.openclaw/workspace/AGENTS.md` should exit 0 on every gbrain-installed VM. Probe via `scripts/_audit-gbrain-protocol-coverage.ts`.
- **Rollback**: revert the commit. The protocol block remains on-disk in the VMs already patched (the step doesn't have a delete path). Manual cleanup via `sed` if the rollback truly needs to reverse the on-disk state.

### v101 — 2026-05-16 (Startup orphan tool_use repair)

- **Manifest change**: `VM_MANIFEST.version` bumped 100 → 101. Appended `python3 /home/openclaw/.openclaw/scripts/strip-thinking.py --startup-repair-active 2>&1 || true` to the existing `ExecStartPre` chain in `systemdOverrides`. Extended `STRIP_THINKING_SCRIPT` with `run_startup_orphan_repair`, `_run_startup_repair_all_active`, `_find_session_last_turn_orphans`, `_build_synthetic_tool_result_event`, `_orphan_repair_backup`, and CLI dispatch on `--startup-repair-active` / `--startup-repair <path>`. Added two Rule-23 sentinels: `def run_startup_orphan_repair` and `ORPHAN_REPAIR:`.
- **Why**: companion fix to v100. Even after v100 removed `RuntimeMaxSec=86400`, gateways still SIGTERM on other paths (manifest deploys, manual restarts, kernel updates, watchdog kicks). When SIGTERM lands during an in-flight tool_use turn — between the assistant writing a `toolCall` and the matching `toolResult` being persisted — the session jsonl is left with an orphan `toolCall`. Anthropic's API rejects subsequent turns with 400 `"tool_use_id: did not find matching tool_use_id"`, which OpenClaw's error path surfaces to the user as the generic `"Something went wrong, use /new"` Telegram message. Original incident: vm-050 2026-05-14 00:01:34 UTC (Cooper mid-conversation, gateway SIGTERM-ed by post-RuntimeMaxSec watchdog kick, post-restart gbrain MCP hang, customer-facing error on Cooper's own agent — the same incident that triggered v100).
- **Why this isn't already handled**: OpenClaw 2026.4.26 ships `repairToolUseResultPairing` (`session-transcript-repair-D9T_omS-.js:266`) which COULD synthesize the missing `toolResult` via `makeMissingToolResult`. But at lines ~340-352 of that file there's a bypass: when `assistant.stopReason === "error" || "aborted"`, the synthesis branch is SKIPPED. SIGTERM produces exactly the `"aborted"` state, so the orphan goes unrepaired and reaches the API. The v101 startup repair pre-applies the synthesis on disk BEFORE the gateway loads the session, sidestepping the bypass entirely.
- **Verified on-disk shape** (from vm-050 raw jsonl 2026-05-16): `tool_use_id` lives at **`message.toolCallId`** (camelCase, on the message level — NOT in content blocks). `toolResult` content blocks use `type: "text"` (NOT `"tool_result"`). Error flag is `message.isError` (camelCase boolean). Tool name lives at `message.toolName`. Events have top-level `id`, `parentId` (linkage chain), `timestamp` (ISO + unix-ms variants). The synthetic toolResult event matches this exact shape so the runtime accepts it as a real toolResult on next load.
- **Mechanism**: ExecStartPre runs synchronously before gateway start. `_run_startup_repair_all_active` iterates `~/.openclaw/agents/main/sessions/*.jsonl` (excluding `*.trajectory.jsonl` and `*.checkpoint.*.jsonl`), and for each file:
  1. Walks events backward from EOF to the latest user message (bounds the "current turn").
  2. Collects `toolCall.id` values from any assistant message in that turn, and `message.toolCallId` values from any toolResult message.
  3. For each toolCall not in the toolResult set: appends a synthetic toolResult event with `isError: true` and informative text ("Tool execution interrupted by service restart...").
  4. Atomic write (`tmp + os.replace`). Backed up first to `~/.openclaw/session-backups/<ts>-orphan-repair-<basename>.jsonl` (shared 7-day retention with daily-hygiene backups). Skips files >50 MB.
  5. Idempotent: re-runs no-op if the same orphans have already been synthesized (the toolResult is now in the `tool_result_ids` set on the next walk).
- **Why a Gate 0 live SIGTERM repro was parked**: three real-mode attempts on vm-050 2026-05-16 surfaced two bugs in the test scaffolding (v1 stale-jsonl pick, v2 rotation-archive false-match — both fixed across `_repro-orphan-tool-use.ts` v2 + v2.1) and conclusive evidence that the orphan window between `toolCall-write` and `toolResult-write` for `web_search` is sub-2-seconds — narrower than our ~800ms-1s SSH-poll precision. The bug IS reproducible in production by chance (the 2026-05-14 vm-050 incident is documentary proof) but can't be reliably triggered in a controlled SIGTERM-on-detection test. The v101 fix is validated via synthetic-fixture testing (`scripts/_test-orphan-repair.ts` — 17 assertions across 7 fixtures + idempotency, all pass) rather than live repro.
- **Fleet rollout**: reconcile-fleet picks up v101 next cycle. For each VM at cv<101, `stepFiles` redeploys `strip-thinking.py` (sentinel-guarded per Rule 23: both `def run_startup_orphan_repair` AND `ORPHAN_REPAIR:` must be in the in-memory template), and `stepSystemdUnit` rewrites `override.conf` with the new `ExecStartPre` chain. `daemon-reload` + verified restart (Rule 5). With `CONFIG_AUDIT_BATCH_SIZE=1` + `PER_VM_TIMEOUT_MS=220s`, ~3-4h to drain the cv<101 cohort. **Actual drain: 100% of 146 assigned+healthy VMs reached cv=101 within ~18h** (limited by reconcile-fleet's per-VM cycle time, not the orphan-repair).
- **Production impact (measured 2026-05-17, ~18h post-rollout, full-fleet SSH-grep of `ORPHAN_REPAIR: scan complete` journal lines, 145/146 VMs with parseable data, 1 SSH-unreachable):**
  - **281 orphan toolCalls synthesized fleet-wide** during the v101 rollout window. Each one was a future `"Something went wrong, use /new"` customer-facing failure now prevented.
  - 762 scan events across all VMs (each ExecStartPre invocation = 1 scan; average ~5 restarts/VM in 18h reflects the rolling reconcile + gateway-restart pattern).
  - 5,800 .jsonl files scanned cumulatively.
  - **Distribution highly skewed**: 126 VMs had 0 orphans (idle), 12 had 1-5, 3 had 6-10, 4 had 11+. **vm-602 alone had 186 orphans** (heavy session-state VM with extensive SIGTERM exposure) — 66% of the fleet-wide total. The next four busiest VMs (vm-724, vm-657, vm-725, vm-788) combined had 59 orphans.
  - **Zero repair-path errors fleet-wide** across 762 scan events. The synthesis code is operating cleanly in production.
  - Snapshot stored at `/tmp/v101-orphan-fleet-report.json` (full per-VM data including individual scan events). Re-runnable via the `/tmp/v101-orphan-fleet.mjs` measurement script for periodic re-measurement.
- **Detection note**: after rollout, sample 5 VMs and verify (a) `grep "def run_startup_orphan_repair" ~/.openclaw/scripts/strip-thinking.py` is non-empty, (b) `systemctl --user show openclaw-gateway --property=ExecStartPre | grep -q "startup-repair-active"`, (c) on the next gateway restart, `journalctl --user -u openclaw-gateway -n 50 | grep ORPHAN_REPAIR` shows the `ORPHAN_REPAIR: scan complete — N file(s) scanned...` line. Long-term production validation: count `GENERIC_EXTERNAL_RUN_FAILURE_TEXT` Telegram-message occurrences in fleet gateway journals before/after rollout. If the fix works, the count drops fleet-wide. Confirmation by absence-of-incidents.
- **Rollback**: revert this commit. Reconciler rewrites `override.conf` without the new ExecStartPre invocation on next cycle. Existing synthetic toolResult events on disk remain (harmless — they're valid Anthropic-shape events; the runtime accepts them as real toolResults).

### v100 — 2026-05-15 (Removed RuntimeMaxSec — no more scheduled 24h gateway restarts)

- **Manifest change**: `VM_MANIFEST.version` bumped 99 → 100. Removed two lines from `systemdOverrides`: `RuntimeMaxSec=86400` and `RuntimeRandomizedExtraSec=3600`. Same removal applied at three sites: `lib/vm-manifest.ts:2126-2127`, `lib/ssh.ts:7297-7298`, `app/api/vm/fix-infra/route.ts:175-176`.
- **Why**: P0 incident 2026-05-14 00:01:34 UTC on vm-050. Cooper was mid-conversation (timmy doing LinkedIn searches, responding normally at 8:00-8:02 PM ET). At 8:02 PM Cooper sent "the one from uofa". systemd's `RuntimeMaxSec=86400` had fired 1m26s earlier (exactly 24h from the previous start of the gateway), SIGTERM'ed the gateway, restart took 1m32s due to a gbrain MCP connection hang, and Cooper's queued message + his follow-up "uhhhh hello?" both got "Something went wrong while processing your request. Please try again, or use /new to start a fresh session." Customer-facing error on Cooper's own agent.
- **Original justification was hypothetical**: the inline comment on the removed line said "Auto-restart gateway after 24h to prevent memory bloat". No incident docs reference a memory-bloat OOM after >24h uptime. The `MemoryHigh=3G` + `MemoryMax=3500M` cgroup limits (set adjacent to the now-removed lines) provide the real-OOM restart safety net — if memory bloat ever materializes, the kernel kills the gateway and `Restart=always` brings it back.
- **The deeper structural bug** (NOT fixed by this change but exposed by the same incident): SIGTERM during an in-flight tool_use turn leaves the session jsonl with an orphan `tool_use` event and no matching `tool_result`. Anthropic's API rejects subsequent turns with that messages array. OpenClaw's error path emits "Something went wrong, use /new" to Telegram. **Even with RuntimeMaxSec gone, gateways still SIGTERM on other paths** (manifest deploys, manual restarts, kernel updates, gbrain MCP hang recovery). A separate startup-side session-recovery fix is needed to emit synthetic `tool_result` for orphaned `tool_use` events. Filed as follow-up.
- **[2026-05-15 follow-up — companion-fix research, BEFORE implementing]**: OpenClaw 2026.4.26 already exports the repair primitives. `session-transcript-repair-D9T_omS-.js` exports `repairToolUseResultPairing`, `makeMissingToolResult`, `sanitizeToolUseResultPairing`, `stripToolResultDetails`, `sanitizeToolCallInputs`. `compaction-successor-transcript-CFukhZtt.js:2060` defines `repairSessionFileIfNeeded(params)` (file-level atomic tmp+replace repair) and exports `flushPendingToolResultsAfterIdle` (post-idle hook). Default policy `repairToolUseResultPairing: true` at `compaction-successor-transcript-CFukhZtt.js:2566` and `provider-model-shared-Bqo51Ufw.js:35`. Repair is wired into compaction at five sites (compact-B_VybGkN.js:640+:773, compaction-CciVUU6P.js:245, compaction-successor-transcript-CFukhZtt.js:2390+:3500). Storage-format clarification: OpenClaw normalizes wire-format `tool_use` → on-disk `"toolcall"` at `chat-CTjpvvH8.js:126`. **Conclusion**: orphan-tool_use repair is probably already handled by OpenClaw internals. Cooper's 8:03/8:04 PM ET errors during the SIGTERM window are more likely caused by the gbrain MCP hang (no Anthropic response within timeout → OpenClaw bubbles "Something went wrong, use /new") than by orphan tool_use. Companion fix may not need to be built. **Repro test required** before any implementation: trigger a tool turn on a low-stakes VM, SIGTERM mid-flight, send follow-up user message, observe whether OpenClaw auto-recovers. Tomorrow's task; parked until then.
- **[2026-05-15 — orphan tool_use item CLOSED]**: Root cause of May-14 "Something went wrong" errors confirmed as **gbrain MCP connection hang**, not session corruption. OpenClaw's `repairToolUseResultPairing` (default-true) handles orphan tool_use automatically. Three convergent evidence sources:
  1. **Yesterday's IR research** — OpenClaw 2026.4.26 exports the full repair primitive set (`repairToolUseResultPairing`, `makeMissingToolResult`, `sanitizeToolUseResultPairing`, `repairSessionFileIfNeeded`, `flushPendingToolResultsAfterIdle`) and wires them into compaction at five sites; default policy `repairToolUseResultPairing: true` at `compaction-successor-transcript-CFukhZtt.js:2566` + `provider-model-shared-Bqo51Ufw.js:35`. Repair is already on, on-by-default, fleet-wide.
  2. **Today's clean tool-call conversations on vm-050** — 11:48 AM ET and 12:06 PM ET web_search → full assistant response. Both turns produced normal `"toolCall"` (camelCase) + paired `role: "toolResult"` rows on disk. No orphans, no errors. The session-recovery path is healthy on every conversation that doesn't hit the gbrain hang.
  3. **Today's live re-observation of the SAME bug** — vm-050 reproduced the exact May-14 failure mode at 16:30:43.688 UTC: truncated gbrain MCP header line in the journal, `pending_update_count=0` on the unit, no gbrain process under the gateway, agent wedged on "Something went wrong, use /new". The bug signature is gbrain MCP's `connectionTimeoutMs: 90000` hang, NOT orphan tool_use in the jsonl.
- **Closure scope**: closes the "session-recovery on startup" companion-fix item. No companion code shipped; none needed. The real bug to fix is gbrain MCP — owned by the gbrain terminal, out of scope here.
- **Fleet rollout**: reconcile-fleet picks up v100 next cycle. `stepSystemdUnit`'s md5 verify-after-write detects drift between expected (manifest-derived) override.conf and on-disk (has the two extra lines), rewrites the file without them, `systemctl --user daemon-reload`, restart with Rule-5 verified health check. With `CONFIG_AUDIT_BATCH_SIZE=1` + `PER_VM_TIMEOUT_MS=220s` (Option A hotfix from earlier 2026-05-14), throughput is ~20 VMs/hour. The ~150-VM cv<100 cohort drains in ~7-9h. During that window, every VM gets exactly ONE controlled+verified restart. After drain: zero scheduled gateway restarts on the fleet.
- **Irony**: this rollout requires ~150 gateway restarts — the exact thing we're eliminating. Accepted because (a) the rollout is once, (b) the natural 24h cycle would have done these restarts anyway over the next 25h, (c) reconcile-fleet restarts include verification which natural systemd kills don't.
- **Detection note**: after rollout, sample 5 cv=100 VMs and confirm `~/.config/systemd/user/openclaw-gateway.service.d/override.conf` does NOT contain `RuntimeMaxSec` or `RuntimeRandomizedExtraSec`. Also: `systemctl --user show openclaw-gateway --property=RuntimeMaxSec` returns `infinity` (the systemd default).
- **Rollback**: revert this commit. Reconciler re-adds both lines on next cycle.

### v99 — 2026-05-14 (Gateway-health textfile-collector promoted to manifest)

- **Manifest change**: `VM_MANIFEST.version` bumped 96 → 99 (skipping 97, 98 which were code-only fixes — see entries below).
- **Why**: the textfile-collector pipeline that powers the Prometheus `GatewayDown` alert was fleet-pushed by hand on 2026-05-14 during the timmy outage. It landed on all 242 then-existing VMs but was never added to the manifest. Newly-provisioned VMs from a fresh snapshot would silently miss it — the alert would not fire for them, so a gateway crash would go undetected until a user reported it.
- **Three coordinated pieces:**
  - `~/.openclaw/scripts/gateway-health-textfile.sh` — added as a managed inline file in `files[]` with `requiredSentinels: ["openclaw_gateway_up", "is-active --quiet openclaw-gateway"]` (Rule 23 guards against any future stale-module-cache regression).
  - `* * * * * gateway-health-textfile.sh` — added to `cronJobs[]` with marker `gateway-health-textfile.sh` for idempotent install via `stepCronJobs`.
  - `lib/vm-reconcile.ts:stepNodeExporter` extended with `ensureTextfileCollector()` — creates `/var/lib/node_exporter/textfile_collector/` (`root:openclaw 775`) and writes `/etc/systemd/system/node_exporter.service.d/textfile.conf` with the `--collector.textfile.directory=...` override. Content-diff before write; node_exporter restart only when drop-in actually changes (idempotent on subsequent ticks).
- **Reconciler impact**: stepNodeExporter's probe now also reports `dropin=` and `tfdir=`. Healthy-but-missing-textfile VMs no longer short-circuit at `bin+listening`; they call into `ensureTextfileCollector` to fill in the missing pieces.
- **Sudo requirement**: the drop-in install needs passwordless sudo (existing pattern in stepNodeExporter). VMs without sudo log a `recordHealWarning` but don't block the reconcile. Script + cron deploy via the openclaw user regardless.
- **Fleet rollout**: reconcile-fleet picks up v99 next cycle. For each VM at cv<99 (most are at cv=96 now after v96), stepFiles deploys the script, stepCronJobs installs the cron, and stepNodeExporter detects the missing dir + drop-in and installs them. node_exporter is restarted only on the first install per VM.
- **Detection note**: after rollout, sample any 10 VMs and grep `~/.openclaw/scripts/` for `gateway-health-textfile.sh` + grep `crontab -l` for the marker + check `/etc/systemd/system/node_exporter.service.d/textfile.conf` exists. If any are missing on a cv=99 VM, that's a Rule 23-class lying-DB regression.
- **Rollback**: revert this commit. ensureTextfileCollector doesn't have a delete path — the dir and drop-in stay in place but the cron entry stops getting maintained and the script will eventually drift. Manual cleanup is required to fully unwind.

### v98 — 2026-05-14 (subscription.created webhook handler)

- **Not a VM_MANIFEST.version bump.** Pure billing-webhook change in `app/api/billing/webhook/route.ts`. No fleet impact, no migration needed.
- **Why**: the existing webhook handled `customer.subscription.updated` and `customer.subscription.deleted` but NOT `customer.subscription.created`. When a sub was created outside the Stripe Checkout flow (admin script, direct API call, comp-extension workflow), Stripe fired `subscription.created` and we silently dropped it. The 2026-05-14 Not Bored Kid incident manifested as: comp Stripe sub `sub_1TX1crCsyFRN0uBDSZRFYf8t` was created via direct API call → DB never got the new row → had to manually upsert + flip vm.health_status + start gateway via SSH. Any future comp/extension/admin-direct sub creation would have hit the same gap.
- **Implementation**: new `case "customer.subscription.created"` mirrors `subscription.updated`'s structure but uses `upsert(payload, { onConflict: "user_id" })` rather than plain `update` — `instaclaw_subscriptions.user_id` has a UNIQUE constraint (one sub per user), so the old canceled row gets overwritten cleanly rather than throwing 23505. If `subscription.status` is `active` or `trialing` on creation, the handler also calls `wakeIfHibernating` + `clearStaleAuthCacheForUser` + (if `status='frozen'` VM exists) `thawVM` — same downstream effects as `updated`. Both paths now share the same wake/thaw semantics; either entry point will resume a paused user's VM.
- **Stripe Checkout interaction**: Stripe fires BOTH `checkout.session.completed` AND `subscription.created` for new Checkout sessions. The Checkout handler at line 225 already inserts the sub row first; the subsequent `subscription.created` upsert finds the row and idempotently re-confirms it. No double-row risk.
- **Tier resolution**: identical to `subscription.updated` — try `subscription.items.data[0].price.id` from the payload, fall back to `stripe.subscriptions.retrieve(id, { expand: ["items.data.price"] })` if missing.
- **Failure mode**: if the upsert returns an error, we log it but DON'T return non-2xx. Stripe will retry the event and the upsert is idempotent on retry. This matches the existing webhook's pattern.
- **Detection note**: after deploy, any admin-script or admin-endpoint sub creation should auto-sync without manual DB intervention. Watch the webhook logs for `subscription.created: row upserted` lines on the next admin sub creation. If the row doesn't appear in `instaclaw_subscriptions`, check the logs for `subscription.created: upsert failed` or `subscription.created: no user row for stripe_customer_id`.
- **Rollback**: revert the commit. The pre-existing `subscription.updated` and `checkout.session.completed` paths continue to handle their respective flows.

### v97 — 2026-05-14 (Freeze-queue starvation fix — A+B+C)

- **Not a VM_MANIFEST.version bump.** The fix lives entirely in the lifecycle cron (`app/api/cron/vm-lifecycle/route.ts`) and adjacent helper (`lib/vm-freeze-thaw.ts`), plus one schema migration. Reconciler is irrelevant — vm-lifecycle queries the VM rows directly.
- **Why**: 63 VMs in `status=assigned + health_status IN (suspended, hibernating)` were stuck on Linode at ~$29/mo each (~$1,827/mo total Linode bill for users who had cancelled their subs >7 days ago). The freeze cron WAS firing every hour, but two persistently-failing VMs (vm-866, vm-873 — both SSH-unreachable, so freezeVM's "verify silence" probe times out and returns `failing closed per PRD rule 11`) sat at the head of an unordered candidate query and burned the entire `MAX_FREEZE_PER_RUN=2` budget every cycle. Throughput was ~0 successful freezes/day for 5+ days. Plus one VM (vm-542) had a stale `frozen_image_id` pointing at a Linode image that had been deleted out of band, producing repeated `Linode GET /images/private/38804613 → HTTP 4XX` failures.
- **Three coordinated fixes** (one commit, three behaviors):
  - **(A) Budget accounting**: `freezeAttempts++` moved to after `freezeVM()` returns, AND gated on `touchedLinode` — true only when the call succeeded, threw, or failed with a non-safety-skip reason. Safety skips (SSH unreachable, lock held, active sub, credits remaining, bankr token launched, wrong status, etc.) no longer consume the per-tick budget. Linode's image-create rate limit only counts actual API hits, so this is faithful to the underlying constraint.
  - **(B) Queue fairness**: new column `instaclaw_vms.freeze_consecutive_failures INTEGER NOT NULL DEFAULT 0` (migration `20260514153000_freeze_consecutive_failures.sql`) + composite partial index. After every `freezeVM()` call the cron writes the new count (reset to 0 on success, increment by 1 on any non-success). Candidate query orders by `(freeze_consecutive_failures ASC, suspended_at ASC)` so persistent failers move to the back. They're not permanently excluded — once the rest of the queue is processed they get re-attempted. Older suspensions free up Linode cost first.
  - **(C) Stale-image sweep (Pass 0.5)**: new pass at the top of the lifecycle cron runs before Pass 1 v2. Queries up to 50 `status=frozen` rows with non-null `frozen_image_id`, probes each via Linode `GET /images/<id>`. On 404, clears the reference and logs `frozen_image_cleared_stale` to the lifecycle log. We do NOT auto-flip status to `destroyed` — losing user data is a one-way door that deserves operator review. Probe failures (rate-limit, 5xx, network) leave the row untouched and retry next tick. Only sweeps `status=frozen`; thaw-pending rows (status=assigned + non-null frozen_image_id) are left alone to preserve the post-thaw SSH-verify rollback path.
- **Migration applied**: `20260514153000_freeze_consecutive_failures.sql`. `ADD COLUMN IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` — idempotent.
- **Verification plan**: after deploy, wait for the next hourly vm-lifecycle tick. Watch the Vercel function logs for the new `budgetAttemptsUsed` + `pass05StaleImageCleared` + `pass05ImageProbeFailed` fields. Cross-check `instaclaw_vm_lifecycle_log` — should see NEW VM names being attempted (not just vm-866/vm-873 again), and at least one `frozen_image_cleared_stale` entry if vm-542 (or similar) had a stale ref. Within ~24h the 63-VM backlog should start draining at the natural rate (2/hour × ~32 hours to clear).
- **Detection note**: if `budgetAttemptsUsed === MAX_FREEZE_PER_RUN` AND `frozen + failed === 0` AND `skippedSafety > 0`, the A-fix regressed (skips are consuming budget again).
- **Rollback**: revert the commit. Migration is idempotent; leaving the column in place is harmless (default 0, no consumers).

### v96 — 2026-05-14 (Recurring-task / cron-creation rule in SOUL.md + AGENTS.md V2)

- **Manifest change**: Added a "Never create duplicate crons" bullet to SOUL.md V2 Hard Boundaries (above the OPENCLAW_CACHE_BOUNDARY marker) and a new "Recurring Tasks (Crons) — list first, never duplicate" section to AGENTS.md V2 (below the cache boundary). Both live in `lib/workspace-templates-v2.ts`. No new config keys, no new reconciler steps.
- **Why**: vm-050 (Cooper's timmy) had 18 duplicate "Daily News" crons all firing at 9 AM ET — produced the "I'm temporarily unavailable" Telegram spam. vm-725 (Doug Rathell) had 36 duplicate "iPad/iPhone Deal Monitor" crons; 8+ fired at 9 AM ET on Sonnet, burning his entire 600-credit daily starter budget by 11 AM. Both were caused by the same agent behavior — when the user said "remind me daily about X" a second time, the agent created another cron instead of finding and updating the existing one. No idempotency check; nothing in SOUL.md or AGENTS.md told it to list first.
- **The rule**: before creating any cron, list existing crons (`cat ~/.openclaw/cron/jobs.json | jq` or `openclaw cron list`), look for a match by name / payload, and update rather than duplicate. Every cron MUST specify `delivery.target` (the Telegram chat ID from `~/.openclaw/openclaw.json`) — never `delivery.mode: "announce"` with null target (those produce silent error loops).
- **Reconciler impact**: stepSoul and stepAgents (lib/vm-reconcile.ts:5440+, 5479+) idempotently rewrite the V2 templates using the SOUL_V2_MARKER / AGENTS_V2_MARKER guards. Both files are deployed on every reconcile cycle for VMs at cv<96.
- **Fleet rollout**: reconcile-fleet cron picks up v96 next tick. ~240 assigned+healthy VMs need to re-reconcile; given the head-of-queue starvation in vm-lifecycle (P1 — fix #2 in this sweep also lands today), this should clear within 1-2 cron cycles for the bulk of the fleet.
- **Cache-miss tax**: ~210 chars added above the OPENCLAW_CACHE_BOUNDARY in SOUL.md → one-time ~5-10s cache rebuild per VM on the first turn after the new content lands. Across ~240 VMs that's a one-time minor latency bump distributed over the next hours, not a sustained cost.
- **Detection note**: after rollout, sample 10 VMs and grep `~/.openclaw/workspace/AGENTS.md` for the literal string `"Recurring Tasks (Crons) — list first, never duplicate"`. If absent from a cv=96 VM, that's a Rule 23 lying-DB regression (would suggest stale-module-cache on reconciler).
- **Rollback**: revert the commit. Reconciler restores prior SOUL.md / AGENTS.md content idempotently via the V2 markers. cv-decrement script can re-mark affected VMs as cv=95-eligible if forcing re-reconcile.

### v95 — 2026-05-12 (Agent acknowledgment UX — three-layer Telegram feedback)

- **Manifest change**: `VM_MANIFEST.version` bumped 93 → 95 (single bump from v93 — v94 was a local-only working state for L1+L2 that never landed; v95 ships L1+L2+L3 together). Added 4 `messages.*` config keys (L1) + 5 `channels.telegram.streaming.*` keys (L2) + 1 new `cronJobs[]` entry for `ack-watchdog.py` (L3). New embedded script `ACK_WATCHDOG_SCRIPT` with Rule-23 sentinels.
- **Why**: 2026-05-11 — Cooper sent `@edgecitybot` "whats on the schedule rn for edge city?", bot replied 3 minutes later with an excellent answer but ZERO visible feedback during the wait. Edge Esmeralda (1000 attendees, 2026-05-30) would have churned that experience at scale.
- **Three layers, independently rollback-able**:
  - **L1 (reactions + status emoji transitions)** — 4 `messages.*` config keys. Telegram `setMessageReaction` lands 👀 on the user's inbound message within ~300ms; `statusReactionController` transitions through phase emojis (👀 → 🤔 → 🔍 → ✍️ → ✅) as work progresses.
  - **L2 (streaming preview)** — 5 `channels.telegram.streaming.*` config keys. OpenClaw sends a placeholder and edits as the model streams. CRITICAL pin: `streaming.preview.toolProgress=false` (v68 leak guard — prevents raw tool-call output from leaking to Telegram users).
  - **L3 (slow-warning watchdog)** — `ack-watchdog.py` cron at `* * * * *`. Detects stalls >30s (sends "Thinking through this one — give me ~30s.") and hard-fails >180s ("Hit my limit on this one — taking too long. Mind retrying or rephrasing?"). Read-only on session state (Rules 22, 30). Per-turn idempotent dedup.
- **Hot-reload taxonomy** (Rule 32 — corrected mid-canary): 5 `channels.telegram.streaming.*` keys HOT-RELOAD (1-3s after set). 4 `messages.*` keys DO NOT hot-reload (closure capture at `bot-msflwCEW.js:5473`). Reconciler auto-restarts via `RESTART_REQUIRED_CONFIG_PREFIXES = ["messages."]` (commit `320ecb25`).
- **Verified on vm-050 canary** (2026-05-11/12): L1 — 👀 reaction lands within 1s; status transitions confirmed visually. L2 — 0 leak matches across v68/v94 patterns over 3hr post-test journal audit (`scripts/_audit-v94-leak-grep.ts`). L3 — 30/30 parser unit tests pass (`scripts/_test-ack-watchdog-parser.py`); 32KB→1MB tail bug caught and fixed during canary.
- **Fleet rollout**: reconcile-fleet picks up v95 next cycle. For each cv<95 VM: stepConfigSettings pushes 9 keys → `result.gatewayRestartNeeded=true` triggered by `messages.*` changes → stepFiles deploys `ack-watchdog.py` with `requiredSentinels` guard → stepCronJobs adds the watchdog cron idempotently → stepGatewayRestart fires (Rule-5 verified, loads `messages.*` keys) → cv → 95.
- **Tooling shipped**: `scripts/ack-watchdog.py` (source of truth; `lib/ssh.ts` embeds copy), `scripts/_test-ack-watchdog-parser.py` (30 unit tests), `scripts/_canary-v94-ack-ux.ts` (per-VM canary, defaults `--restart`), `scripts/_audit-v94-leak-grep.ts` (post-deploy regression check).
- **PRD**: `docs/prd/agent-acknowledgment-ux-2026-05-11.md` (~2000 lines).
- **Rollback**: each layer independently. L1 = revert 4 `messages.*` keys. L2 = `streaming.mode → "off"` (same lever as v68). L3 = remove cron entry from manifest, `ack-watchdog.py` stays inert on disk.

### v93 — 2026-05-11 (partner-stub APPEND branch + budget-aware over-budget check)

- **Manifest change**: `VM_MANIFEST.version` bumped 92 → 93. Updated `stepRewriteSoulPartnerSections`'s Python: when the old section header is absent, append the partner-stub at EOF (`text.rstrip() + new_section`) instead of no-op'ing. New status value `"appended"` treated identically to `"patched"` for cv-bump purposes; idempotency unchanged (marker check is still first). Budget read from `VM_MANIFEST.configSettings` now (was hardcoded 35K) — tracks the emergency 35K→40K bump from commit `0f796218`.
- **Why**: v92's step treated `old-not-found` as a no-op (mirroring the v67 routing-patch semantics where missing-old indicated user customization). For partner sections that turns out to be wrong — partner sections are auto-installed by `configureOpenClaw`, and a missing section means the VM was provisioned BEFORE the section existed in the template OR a configure failure left it out. Either way we want to add it.
- **Canary on the 5 edge_city VMs (2026-05-11)** found three distinct states:
  - vm-771, vm-859, vm-354 — both partner sections present (size 37,467b). v92 patched works fine.
  - vm-050 — Edge section MISSING, Consensus present. v92 patches only consensus, leaves vm-050 without Edge context.
  - vm-777 — both sections MISSING. v92 no-ops entirely.
- **Fleet rollout**: manifest bump forces reconciler to re-process all VMs at cv<93, including vm-354 (currently at cv=92 from canary — early-outs at "already-patched" thanks to the marker). The other 4 edge VMs hit either "patched" (sections present) or "appended" (sections missing). Both paths deploy the stubs.
- **Detection note**: after rollout, `grep -c "Edge City" ~/.openclaw/workspace/SOUL.md` should be exactly 1 on every edge_city VM. Zero = step didn't run; >1 = duplicate append (idempotency regression).
- **Rollback**: revert the commit. The marker guard means subsequent reconciles see the patched/appended state as `alreadyCorrect`; rollback doesn't auto-remove the partner stubs (the step has no delete path).

### v92 — 2026-05-11 (partner SOUL.md sections moved out of bootstrap context + 35K→40K emergency bandaid)

- **Manifest change**: `VM_MANIFEST.version` bumped 91 → 92. Two new reconciler steps: (a) `stepRewriteSoulPartnerSections` — surgical SOUL.md edit on existing partner VMs (follows v67 routing-patch pattern: marker-based idempotency, Python in-place replace via tmp+rename, backup to `~/.openclaw/backups/v92-<ts>/SOUL.md`, verify-after-write, `pushFailed` gate on errors). (b) `stepDeployEdgeOverlay` — writes `INSTACLAW_OVERLAY.md` to edge_city VMs (sha-verified deploy, idempotent skip on match). Source of truth: `lib/partner-content.ts`. Companion emergency bandaid (commit `0f796218`) bumped `BOOTSTRAP_MAX_CHARS` from 35000 → 40000 to stop the bleeding while the surgical fix landed.
- **Why**: pre-v92 edge_city VMs had 36,054 chars of SOUL.md content vs the 35,000-char `BOOTSTRAP_MAX_CHARS` ceiling — the last ~1,054 chars (the Edge onboarding interview tail + the entire Consensus section) were silently truncated from the agent's bootstrap context. Affected all 5 edge_city VMs live in production. Agents simply couldn't see the partner content they were supposed to embody.
- **Fix shape**: replace the ~1,286-char inline Edge section and ~451-char inline Consensus section in SOUL.md with ~220-char stubs that point the agent at on-disk skill files (read on demand, NOT at bootstrap). New edge_city VM SOUL.md size: ~34,771 chars (~229 chars headroom). The ~735-char onboarding interview + community norms + proactivity directive that used to live in SOUL.md is moved to a new `INSTACLAW_OVERLAY.md` alongside Tule's upstream `edge-esmeralda/SKILL.md` — additive, untracked by upstream's 30-min cron pull.
- **Audit script**: `scripts/_audit-soul-md-size.ts`.
- **P1 follow-up** (post-Esmeralda): deep trim of `WORKSPACE_SOUL_MD` (21K chars) + `SOUL_MD_INTELLIGENCE_SUPPLEMENT` (8.7K chars) which are the real bootstrap-budget bloat. This v92 fix is the short-term unblocker for Edge Esmeralda (May 30); the structural fix is a separate larger surgery.
- **Detection note**: `_audit-soul-md-size.ts` on the fleet — every VM should be <40,000 chars total bootstrap. Anything over is a regression.
- **Rollback**: revert the commits. The bandaid bump (35K→40K) can stay independently if the surgical fix needs rollback — they're logically independent.

### v91 — 2026-05-07 (SOUL.md Platform block V1 → V2 + Bankr wallet coverage gap)

- **Manifest change**: `VM_MANIFEST.version` bumped 90 → 91. `WORKSPACE_SOUL_MD` (`lib/ssh.ts`) and `WORKSPACE_SOUL_MD_V2` (`lib/workspace-templates-v2.ts`) updated to ship the V2 Platform block inline (so fresh provisions get it directly without needing the reconciler patch). `lib/vm-reconcile.ts:stepInstaClawIdentityPatch` upgraded to do V1→V2 in-place strip+replace (the existing append-style insert can't replace existing rows; same surgical pattern as `stepV67RoutingTablePatch`). Post-patch invariant: Platform-section count == 1 (catches botched strips).
- **Why**: Doug Rathell (vm-725) reported his agent refused to launch a token, framing it as a regulatory/scam concern. V1's Platform block was descriptive ("InstaClaw ships token launches") and didn't override the model's default crypto-caution reflex. Plus the fleet audit found the WRONG path was being taken — agents trying `bankr launch` from the VM CLI with personal user-keys, getting 403s.
- **V2 (INSTACLAW_PLATFORM_V2 marker) adds**:
  - "Token launches are a core feature, not a regulatory concern" subsection: explicit "do not refuse" directive (per Rule 28) + the right path (dashboard at `instaclaw.io`, NOT `bankr launch` CLI from the VM).
- **Bankr wallet coverage gap** (ships in the same window, separate code path): `/api/vm/assign` now also calls `provisionBankrWallet` (was Stripe-webhook-only, leaving World mini-app users without a wallet). Existing 165 broken VMs backfilled via `scripts/_phase2-backfill-bankr-wallets.ts`. New cron at `/api/cron/provision-missing-bankr-wallets` (every 30 min) catches any future regression. Doc: `docs/bankr-wallet-coverage-gap-2026-05-07.md`.
- **Fleet rollout**: reconcile-fleet picks up v91 next cycle. For each cv<91 VM, the V1→V2 strip+replace runs and verifies. Cv-bump gated on `result.errors` empty.
- **Detection note**: after rollout, `grep -c INSTACLAW_PLATFORM_V2 ~/.openclaw/workspace/SOUL.md` should be exactly 1 on every VM. Zero = step didn't run; >1 = strip-replace botched.
- **Rollback**: revert the commit. The on-disk V2 block stays where it landed; revert restores V1 inline in fresh provisions but doesn't auto-undo the surgical edits.

### v90 — 2026-05-07 (Four-layer session-overflow reliability fix)

- **Manifest change**: `VM_MANIFEST.version` bumped 89 → 90. 7 new `agents.defaults.compaction.*` config keys (Layer 2). Extended `STRIP_THINKING_SCRIPT` with `compact_session_in_place_lines`, `_extract_large_tool_results_to_cache`, `_purge_old_tool_cache` (Layers 1 + 3). New Rule-23 sentinels: `compact_session_in_place_lines`, `SESSION COMPACTED:`, `_extract_large_tool_results_to_cache`, `LAYER3_EXTRACTED:`.
- **Why**: 2026-05-06 vm-729 (Notboredclaw) outage — a >200KB session jsonl was archived + `os.remove`'d, leaving only metadata terminators (`model.completed`, `trace.artifacts`, `session.ended`). The agent then sent an empty messages array to Anthropic → 400 "messages: at least one message is required" → in-memory FailoverManager cooldown loop → user saw "Something went wrong" on every message. The customer experience was catastrophic and (more alarmingly) the agent was apparently making unauthorized trades during the chaos.
- **Research-backed plan** (Cooper-directed deep research session 2026-05-07): surveyed OpenAI Responses API server-side compaction, Anthropic `clear_tool_uses_20250919` + `compact_20260112`, Semantic Kernel `ChatHistoryReducer` (function-call pairing protection), AutoGen "memory pointer pattern", and OpenClaw's own built-in compaction module. **Universal pattern: NEVER NUKE.** Trim while preserving (a) `tool_use`/`tool_result` pairing, (b) recent context, (c) the original prompt. Codified as Rule 30.
- **Layer 1 — strip-thinking.py** replaces destructive Phase 1 archive with `compact_session_in_place_lines`. Preserves the first user message + last 5 turn pairs; computes safe drop boundaries via `_find_safe_turn_starts` (tracks pending `tool_use_id` set, never splits a pair). Atomic write via tmp + `os.replace`. Forensic backup via `_backup_session_file` before any drop. Phase A: aggressive truncation of older-than-recent-10 tool_results to 500 chars. Phase B: drop oldest turn pair, repeat until under threshold.
- **Layer 2 — OpenClaw native compaction tuning**: this manifest block. `mode=safeguard`, `maxActiveTranscriptBytes=150000`, `recentTurnsPreserve=10`, `qualityGuard.{enabled,maxRetries=2}`, `notifyUser=true`, `truncateAfterCompaction=true`. Goal: OpenClaw's LLM-summarizing compactor fires at 150KB BEFORE Layer 1's byte trigger ever needs to. Layer 1 is now the safety net for cases where the LLM compactor times out or 5xx's.
- **Layer 3 — memory pointer pattern** in strip-thinking.py: `_extract_large_tool_results_to_cache`. tool_results > 20KB go to `~/.openclaw/workspace/tool-cache/<sha>.txt` with a short inline reference. Stops browser screenshots, polymarket dumps, hyperliquid orderbooks from stuffing the active context. Cache files age out via `_purge_old_tool_cache` (7d retention, called from `daily_hygiene`). Content-addressable via sha256 for natural dedup of identical tool outputs.
- **Layer 4 — persistent memory writes on every compaction**: `_ensure_recent_summary_before_archive` (existing `PRE_ARCHIVE_SUMMARY_V1` hook) is now also called BEFORE compaction, not just before archive. Haiku generates a summary that lands in MEMORY.md + session-log.md so the agent retains cross-session knowledge of dropped content even if Layer 1's turn-drop fires.
- **Fleet rollout**: reconcile-fleet picks up v90 next cycle. Each cv<90 VM gets the 7 config keys + script update. Per Rule 32, `agents.defaults.compaction.*` likely closure-captured (not hot-reload) — reconciler adds `agents.` to `RESTART_REQUIRED_CONFIG_PREFIXES` if not already.
- **Detection note**: after rollout, `journalctl --user -u openclaw-gateway | grep -E "SESSION COMPACTED|LAYER3_EXTRACTED"` should show activity on busy VMs. Zero matches over a week on a heavy-tool-use VM = the new path isn't engaging (likely a sentinel-grep miss or stale module cache, per Rule 23).
- **PRD**: codified in CLAUDE.md as Rule 30.
- **Rollback**: revert the commit. The 4 layers are independently regressed at their respective config keys / script removals. Layer 1's safety net stays in place if rollback is partial.

### v89 — 2026-05-06 (InstaClaw platform identity fix — "I'm an OpenClaw agent" bug)

- **Manifest change**: `VM_MANIFEST.version` bumped 88 → 89. New "## Platform" section inserted before "## My Identity" in `WORKSPACE_SOUL_MD` (`lib/ssh.ts`) and `WORKSPACE_SOUL_MD_V2` (`lib/workspace-templates-v2.ts`). New reconciler step `stepInstaClawIdentityPatch` (called as step 8f3 right after `stepV67RoutingTablePatch`). Marker-guarded (`INSTACLAW_PLATFORM_V1`).
- **Why**: 2026-05-06 user complaint (HotTubLee) — agents identify as "OpenClaw agents" and describe InstaClaw as a third-party platform they "don't have set up." The SOUL.md template's "## My Identity" section was a near-empty placeholder ("identity develops naturally through conversation"), so the agent had no foundational statement of platform identity. When asked about InstaClaw features, it accurately reported the runtime layer it sees (OpenClaw) and disclaimed everything else — which from the user's perspective is the agent denying its own product.
- **Section content**: names InstaClaw as the hosting platform; clarifies OpenClaw is the runtime kernel (not the identity); tells the agent to read `CAPABILITIES.md` + `EARN.md` as the single source of truth for what it can do (and not to hallucinate features that aren't documented).
- **Surgical patch shape**: same kind of in-place-replace template gap as v67 (no manifest mode supports row-replacement in append-managed files). The step uses a surgical Python patch via tmp+rename, idempotent via the `INSTACLAW_PLATFORM_V1` marker, V2-aware (skips V2-migrated VMs since their template already has it inline). Anchor: "## My Identity" header (universally present on V1 SOUL.md and remains the user-customizable personality section). User customizations under "## My Identity" are untouched — Platform section is INSERTED ABOVE the anchor.
- **Anchor-not-found semantics**: treated as `alreadyCorrect` (don't break customizations). If the user has fully replaced the SOUL.md template with their own, we don't auto-inject — let the user opt in by restoring the anchor.
- **Fleet rollout**: reconcile-fleet picks up v89 next cycle. Per Rule 23, the embedded script literal is sentinel-grepped before write; stale-module-cache regressions surface as errors instead of silent old-file writes.
- **Detection note**: after rollout, sample 5 VMs and `grep -c INSTACLAW_PLATFORM_V1 ~/.openclaw/workspace/SOUL.md` — should be 1 on every V1 VM. V2-migrated VMs already have the section inline; their cv=89 is reached without the step doing anything.
- **Rollback**: revert the commit. The Platform section stays on-disk where it landed; rollback doesn't auto-remove (the step has no delete path). Manual cleanup via `sed` if absolutely needed.

### v88 — 2026-05-05 (build-essential added to systemPackages)

- **Manifest change**: Added `build-essential` to `systemPackages` in `lib/vm-manifest.ts`.
- **Why**: prctl-subreaper's native node-gyp compile silently failed on the cv=82 cohort because they had no `gcc`. Required as a precondition so `stepPrctlSubreaper` can succeed on every VM.
- **Reconciler impact**: `stepSystemPackages` (Step 5) now installs `gcc + g++ + make` on the first reconcile of any VM that doesn't already have it.
- **Detection note**: `which build-essential` is always MISSING (it's a meta-package with no binary) — so `stepSystemPackages` retries the install on every cycle. Real verification is `which gcc`.

### v87 — 2026-05-05 (prctl-subreaper integration)

- **Manifest change**: New step `stepPrctlSubreaper` (Step 8c2) in `lib/vm-reconcile.ts:1591-1695`. Pinned to `prctl-subreaper@0.1.1`.
- **Why**: Garry Tan flagged Node zombie workers on the OpenClaw fleet. The reflexive answer is tini-as-PID-1, but tini cannot reap libuv #1911 close-before-exit zombies (parent calls `uv_close` BEFORE `waitpid` and the child's exit notification is dropped). Going deeper: have node itself become a subreaper via `PR_SET_CHILD_SUBREAPER` and run a polling waitpid reaper thread.
- **Package**: `prctl-subreaper` on npm — N-API addon, MIT-licensed, github.com/coopergwrenn/prctl-subreaper. ~280 lines C++. Bun-compatible via Node-API. v0.1.1 dropped the `|| exit 0` install mask from v0.1.0 that was hiding native-build failures.
- **Wire-up**: systemd drop-in (`prctl-subreaper.conf`, separate from `override.conf` for clean rollback) injects `NODE_PATH` + `NODE_OPTIONS=--require prctl-subreaper`. Addon self-initializes on require.
- **Canary**: Phase 1 (vm-050, Cooper's test agent) — `addon mapped: 1` in `/proc/$PID/maps`, `stats() = {supported:true, running:true, intervalMs:1000, minAgeMs:5000}`. Phase 2 (vm-050, vm-767, vm-337, vm-780) — same verification, no regressions over 1h soak.
- **Soft fail**: every failure mode (npm install fails, native build missing, smoke test fails, drop-in write fails) pushes to `result.errors` and the gateway keeps running without the addon. No way for stepPrctlSubreaper to brick a VM.

### v86 — 2026-05-05 (TasksMax 75 → 120)

- **Manifest change**: `TasksMax` 75 → 120 in `systemdOverrides` in `lib/vm-manifest.ts`.
- **Why**: vm-724-class cgroup throttle. Old gateway processes were brushing the 75-task cap, causing fork() EAGAIN that surfaced as "process froze" from outside. Fleet zombie audit (n=50) found 2 cases of Class A_INTERMEDIATE — too narrow a problem to justify rolling back to a broader fix, but tightness on a 14-task headroom workload was real.
- **Sizing rationale**: 2-vCPU dedicated Linode + Node + Chromium + browser auto + telegram + heartbeat = ~60-70 tasks under load. 120 buys ~50 task headroom. Required precondition for the gbrain rollout (gbrain serve adds ~7 tasks; without v86 it'd re-enter throttle).

### Today's other ships (2026-05-05) — not manifest bumps

- **`reconcile-fleet` `CONFIG_AUDIT_BATCH_SIZE` 10 → 3** (commit `9beb74bf`). Per-VM reconcile cost on the cv=82 cohort jumped to ~150-300s after v87 + v88. Batches of 10 were hitting Vercel's 300s `FUNCTION_INVOCATION_TIMEOUT` — only the first VM was getting cv-bumped, the rest killed mid-step. 3 VMs × ~300s comfortably fits.
- **`outputFileTracingIncludes` glob fix** (commits `3f3443d2`, `d28bf919`). Individual file paths and mid-name wildcards (`./scripts/consensus_*.py`) were silently not bundled by Next 15's tracer; only `<dir>/**/*` shape works. Switched to `./scripts/**/*.py`. Was holding the entire cv=82 cohort behind a `consensus_match_pipeline.py: ENOENT` push error — hidden under the timeout until the batch=3 fix landed.
- **`prctl-subreaper@0.1.1` published to npm** — drops the `|| exit 0` install mask from v0.1.0 that was hiding native-build failures.
- **PRD-gbrain C1-C20 corrections applied** (`instaclaw/docs/prd/PRD-gbrain-integration.md`, commit `dd144bde`) — phase 5 floor revised 3 KB → 6-8 KB; cost re-derivation ~$25-30/month per VM, Haiku-dominant; §6.6 per-version migration playbook; risk register R17/R18/R19 updated.

---

## Open P1 Follow-Ups (Tracker)

Bugs and audit items deferred from active work. Each entry must include: discovery date, symptom, hypothesis, why we can't fix tonight, and an investigation plan. Resolve in-place; never silently delete.

### P1-10: silence-watchdog.py still cron-active on VMs the 2026-05-01 SSH disable-push missed

- **Discovered**: 2026-05-21 during v112 fleet rollout audit. vm-892 (auto-reconciled to v112) showed silence-watchdog.py running in crontab at `* * * * *` despite v76's manifest removal + the 2026-05-01 fleet-wide SSH push that commented it out on existing VMs. vm-780 correctly shows `# DISABLED 2026-05-01 demo-stabilize:` — the disable-push reached it. vm-892 didn't.
- **Risk**: `SILENCE_THRESHOLD_SEC=60` fires fallback Telegram message + gateway restart in the 60-90s user_age window, killing legitimate >60s GPT-5.5 reasoning. Mitigated currently by session-detection mismatch (most fires silently no-op), but the v112 reasoning router now sends MORE long-effort requests — chance of an actual silence-watchdog fire goes up. The 2026-04-30 last-fire timestamp on vm-780 understates the risk for the post-v112 world.
- **Why we can't fix tonight**: `stepCronJobs` in `lib/vm-reconcile.ts` only ENFORCES the configured cron entries are present — it doesn't tear down entries it doesn't recognize. Pre-existing crons persist invisibly. Survey census + fix design need a daylight session.
- **Recommended fix (per Cooper 2026-05-21)**: add a `cronJobsRemove[]` field to `VM_MANIFEST` listing markers to actively uninstall. Extend `stepCronJobs` to scan crontab for any line containing each remove-marker and rewrite the crontab without those lines. Idempotent. Land with one-shot SSH sweep for the cohort currently affected (estimate via `parallel ssh` against `assigned+healthy` VMs grepping crontab for `silence-watchdog.py` without leading `#`).
- **Investigation plan**: (1) census how many VMs have silence-watchdog active (vs commented). (2) Implement `cronJobsRemove[]` in manifest + `stepCronJobs` extension. (3) Add `silence-watchdog.py` to the new list. (4) Bump manifest version. (5) Verify on a sample VM that the cron is gone after reconcile.

### P1-9: `installAgdpSkill` produces acp-serve.service that fails with exit 127 under systemd

- **Discovered**: 2026-05-14 (Doug Rathell vm-725, but failure mode is generic to all `agdp_enabled=true` VMs).
- **Symptom**: `acp-serve.service` (user systemd) hits exit-code 127 ("command not found") on every restart attempt. After 5 retries within StartLimitInterval=300s, systemd gives up and marks the unit `failed`. On Doug's VM the failures cascade was visible May 6 21:04 and again May 13 13:18 (cv-catch-up gateway restart triggers a fresh acp-serve start which immediately hits the cascade).
- **Root cause (confirmed by `systemd-run --user --pipe bash -x acp-serve.sh`)**: `~/virtuals-protocol-acp/acp-serve.sh` sources NVM but never calls `nvm use`. NVM's auto-mode (`NVM_AUTO_MODE=use`) checks `command which node` which resolves to `/usr/bin/node` (system node, not an NVM-managed version). Since system node isn't a tree NVM controls, NVM does nothing further. PATH is unchanged. `exec npx acp serve start` falls through to system PATH where `npx` doesn't exist → 127.
- **Why we can't fix tonight without broader changes**: the script comes from the upstream `virtuals-protocol-acp` repo + the unit file is written by `lib/ssh.ts:installAgdpSkill`. Patching only Doug's on-disk copy is fragile (gets overwritten next time installAgdpSkill runs). The proper fix updates `installAgdpSkill` to either (a) write a unit with `Environment=PATH=$HOME/.nvm/versions/node/<pinned>/bin:/usr/local/bin:/usr/bin:/bin`, or (b) write a wrapper script that does `nvm use --silent default` after sourcing. Either way it's a manifest-level change affecting all agdp_enabled VMs.
- **Mitigation tonight**: stale `failed` state on Doug's VM cleared (no fix to acp-serve itself). Doug's primary issue (credit burn from duplicate crons) is unrelated to acp-serve and was fixed today. acp-serve continuing to fail does not block message processing — it only means the dgclaw / Virtuals ACP integration is offline on his VM.
- **Investigation plan (next bandwidth)**:
  1. Survey: count `agdp_enabled=true` VMs where acp-serve.service is `failed`. Hypothesis: most/all of them.
  2. Patch `installAgdpSkill` in `lib/ssh.ts`: choose option (a) Environment=PATH in the unit file with NVM bin pinned to manifest's `NODE_VERSION` constant. Option (b) is fragile if NVM's "default" alias points at the wrong version.
  3. One-VM canary (Doug's vm-725 since he's already broken — nothing to regress). Verify systemd reaches "active" and `npx acp serve start` makes it past PATH resolution.
  4. Fleet rollout via reconcile-fleet — but `installAgdpSkill` is gated on `agdp_enabled` so only the relevant cohort is touched.

### P1-1 [SHIPPED 2026-05-14]: Reconciler bumps `config_version` on lying-DB VMs — fleet integrity problem, ~20% of post-v88 VMs affected, 3 distinct shapes

- **Status**: **SHIPPED 2026-05-14.** Lying-DB rate reduced from ~20% (2026-05-09 sample) → 0.8% (2026-05-13) → **0.0% (2026-05-14 full census, 0/144)**. All 3 originally-documented shapes are closed in code via the stepSystemdUnit / stepPrctlSubreaper / configureOpenClaw fixes shipped 2026-05-11. The 2026-05-13 PARTIAL_LIE_DROPIN VM (vm-043) self-healed via natural reconcile cycle in 24 hours — empirical proof the gate-coupling fix works. A comprehensive per-step Rule 10 audit covering all 63 `result.alreadyCorrect.push(...)` paths in `lib/vm-reconcile.ts` found zero new silent-failure pathways (full report: `instaclaw/docs/p1-1-rule-10-audit-2026-05-14.md`).

- **Acceptance criteria** (from PRD §6.1):
  1. ✓ Census output by class — 0/144 lying-DB (docs/lying-db-census-2026-05-14.md)
  2. ✓ One-VM canary: vm-043 PARTIAL_LIE→HONEST via natural reconcile
  3. ✓ Per-step audit: 63 paths classified, 0 covering-for-failure (docs/p1-1-rule-10-audit-2026-05-14.md)
  4. ✓ Fleet sweep <2%: empirically 0.0% (no mass cv-reset needed; natural healing sufficed)
  5. Open: 7-day no-regression monitoring — recurring census cron deferred as a Tier 3 followup; current procedure is to run `npx tsx scripts/_lying-db-census.ts` manually after any new manifest version rollout or as part of patrol mode.
  6. ✓ CLAUDE.md update + PRD update — this entry; PRD §6.1 marked SHIPPED.

- **Followups filed (low priority):**
  - Rename `alreadyCorrect.push(...)` → `warnings.push(...)` for 5 semantic-misclassification cases (stepExecStartAlignment skips, stepCaddyUIBlock "no Caddyfile", stepMigrateSoulV2 "no SOUL.md"). Doesn't cause lying-DB; just improves audit-log clarity.
  - Recurring census cron — sample 10 random VMs daily, alert if rate >2%.
  - `stepSystemPackages`: change meta-package check from `which build-essential` (always MISSING) to `dpkg -l | grep build-essential`. Already documented as working-as-intended; just wasteful.

#### Historical context (kept for forensic reference)

- **Discovered**: 2026-05-05 (vm-893/vm-895 freshly-provisioned cohort)
- **Re-scoped 2026-05-09**: Phase 1 gbrain canary pre-flight checks revealed lying-DB is FAR more pervasive than the original cohort. Of 16 randomly-sampled VMs at `config_version >= 88`, **3 (~19%) are lying-DB** in production — and they fall into 3 distinct shapes that point to 3+ different silent-failure paths in the reconciler. This is a fleet-integrity problem, not a corner case. **Elevated from "investigate post-Consensus" to "must fix before any fleet-wide gbrain rollout (Phase 4)" — gbrain via the reconciler will land badly on hundreds of VMs if this isn't resolved first.**

#### Sample data (2026-05-09)

| VM | cv | TasksMax | prctl pkg | prctl drop-in | gcc | Shape |
|---|---|---|---|---|---|---|
| vm-907 (pro) | 91 | **75** | **MISSING** | **MISSING** | ✓ | Total lie |
| vm-512 (power) | 89 | 120 | **MISSING** | PRESENT | ✓ | Partial lie (drop-in only) |
| vm-904 (power) | 91 | 120 | **MISSING** | PRESENT | ✓ | Partial lie (drop-in only) |
| vm-893 (pre-existing) | 88 | 4666 | MISSING | MISSING | MISSING | Schema-zero lie |
| vm-895 (pre-existing) | 88 | 4666 | MISSING | MISSING | MISSING | Schema-zero lie |
| 11 others sampled | 88-91 | 120 | 0.1.0 | PRESENT | ✓ | Honest |

#### The 3 shapes

1. **Total lie** — none of v86 (TasksMax) or v87 (prctl-subreaper) applied; cv claims everything. Both `stepSystemdUnit` AND `stepPrctlSubreaper` silent-failed in this VM's reconcile history. Example: vm-907 (cv=91, but at v75-equivalent state). The likely path: the v75 systemd unit file went missing or unreadable, hitting `stepSystemdUnit`'s "unit not installed (skip) → alreadyCorrect" early-return — that branch pushes to `alreadyCorrect`, NOT to `errors`, so the cron's `pushFailed` gate doesn't trigger and cv bumps.
2. **Partial lie (drop-in only)** — `stepPrctlSubreaper` got past the systemd drop-in write but the npm install half failed. Drop-in is on disk; npm package isn't. Examples: vm-512, vm-904 (cv=89/91 respectively). Implies the install path is wired with two independent state changes that aren't gate-coupled — npm-install failure should void the drop-in (or vice versa); right now they decouple silently.
3. **Schema-zero lie** — `configureOpenClaw()` at provision time bumps cv to current manifest BEFORE the reconciler runs steps. Original vm-893/vm-895 cohort. Different code path entirely (provisioning, not reconciling). Won't be fixed by tightening the reconciler — needs a fix in the provisioning flow itself OR a one-time `_db-reset-config-version-from-disk.ts`-style sweep against the affected cohort.

#### Why this matters more than originally documented

- **20% of post-v88 fleet is lying about state.** Anything we ship via the reconciler that depends on cv as truth will land wrong on 1-in-5 VMs.
- **3 distinct shapes = 3+ silent-failure paths in the codebase.** Fixing one (e.g., stepSystemdUnit's early-return) won't catch the others. Need a comprehensive Rule 10 audit of every reconciler step.
- **Phase 0 / Phase 1 gbrain installs DETECTED these via the 6-point pre-flight check.** Without that pre-flight, gbrain would have landed broken on lying-DB VMs (e.g., wired into a v75-state gateway that doesn't have prctl-subreaper protecting against zombie accumulation under bun/gbrain load).
- **Customers are running degraded.** vm-907 (pro tier paying customer, syhranovianti@gmail.com) is at v75-equivalent state for ~indefinite time. No zombie protection, smaller tasksmax cap, missing v88 manifest fixes.

#### Investigation plan (revised — fix before Phase 4 gbrain fleet rollout)

1. **Comprehensive lying-DB census**: SSH-probe ALL 39 VMs at cv >= 88 with the same 6-point check. Classify by shape. Get the real fleet-wide rate (sample suggests ~20% — confirm).
2. **Per-step Rule 10 audit**: walk every `step*` function in `lib/vm-reconcile.ts`. For each, identify (a) every early-return path that pushes to `alreadyCorrect`, (b) every error path that pushes to `result.errors`. Look for early-returns on conditions that imply failure (file missing, command not found, sudo unavailable). Each of those is a candidate silent-failure.
3. **Critical step fixes**:
   - `stepSystemdUnit:2230-2233`: "unit not installed (skip)" early-returns to alreadyCorrect. Should differentiate: "unit genuinely not installed (gateway doesn't exist on this VM, OK)" vs "unit was here yesterday and is missing today (broken)". Latter should push to errors.
   - `stepPrctlSubreaper`: drop-in write and npm install must be gate-coupled. If npm install fails, the drop-in must be removed (else it'll trigger gateway crash on next restart due to NODE_OPTIONS=--require failing).
   - `configureOpenClaw()`: do not bump cv to current manifest unless reconcile-equivalent steps actually ran. Better: bump cv to (manifest version - 1) at provision so reconciler is forced to apply the latest changes on first cycle.
4. **One-time DB-reset sweep**: `scripts/_db-reset-cv-from-disk-v2.ts` (mirror of the 2026-04-30 one for v66/v67 incident). Probe each VM, set cv to the highest manifest version where on-disk state matches. Reconciler then re-applies missing changes.
5. **Add Rule 23 sentinels**: per-step assertion that the reconciler's in-memory write matches what's on disk before bumping cv.
6. **Phase 4 gate**: gbrain doesn't go fleet-wide via reconciler until the lying-DB rate is verified <2% (essentially zero).

#### Immediate workarounds (no code fix tonight)

- **Phase 1 gbrain canary**: pre-flight 6-point check refuses to install on lying-DB VMs. Caught vm-907 + vm-512 cleanly today. Pick honest VMs for canary.
- **Per-VM remediation**: vm-907, vm-512, vm-904 need cv reset (drop them to cv=82 or some pre-v86 number so the reconciler picks them back up). Coordinate with consensus terminal's "Phase C cohort reset" if it's running — see `docs/lying-db-vms-for-phase-c-reset.md`.

#### Why this matters

Rule 10 ("verify every config set; never `|| true`-suppress") was specifically written to prevent this class of bug. Either the rule's discipline didn't get applied to all step* functions, or there's an architectural path that bypasses verify-after-write entirely (the early-return-to-alreadyCorrect pattern is one such path — it's a SILENT skip that looks like success). Two paying-customer VMs from 2026-05-05 have been running stale OpenClaw + missing manifest fixes for 5+ days behind a green DB row. As of 2026-05-09 we have at least 3 more (vm-907, vm-512, vm-904). The real number is likely 30-40 across the fleet given the 20% sample rate.

### P1-2: `stepNodeExporter` — surface systemctl failure reason on PORT_FAIL

- **Discovered**: 2026-05-06 while diagnosing the cv=82 cohort post-matchpool-fix.
- **Symptom**: vm-632 had bin + unit + user all present, service `inactive (dead)`, port 9100 not listening, **no journal entries** (because the openclaw user can't read system service logs without sudo). The reconciler reported `node_exporter: port did not open ()` — the trailing `()` is `install.stdout.slice(-200)` empty.
- **Immediate fix shipped (commit `8ffc2970`)**: `sleep 2` → `sleep 5` after `systemctl restart node_exporter`. Measured on vm-632: v1.8.2 takes ~3s to bind :9100 on a 2-vCPU dedicated Linode. The 2s probe was firing before the port was up, false-negative PORT_FAIL.
- **Residual concern**: when the start truly fails (not a timing issue), the reconciler still pushes only `port did not open ({last 200 chars of install.stdout})` — which is empty in the common case because the install script's tail commands all redirect to /dev/null or echo PORT_FAIL with no other output. We can't tell *why* node_exporter wouldn't start. The diagnostic on vm-632 had to be done by hand-SSHing and running `sudo systemctl status node_exporter --no-pager` + `sudo journalctl -u node_exporter`.
- **Investigation plan (post-Consensus)**:
  1. On PORT_FAIL, capture `sudo systemctl status node_exporter --no-pager` (last 20 lines) and `sudo journalctl -u node_exporter --no-pager -n 20` and include those in the error string. Bounded to ~500 chars to avoid log bloat.
  2. Distinguish PORT_FAIL_TRANSIENT (port came up later) from PORT_FAIL_SERVICE_DEAD (service exited). A second `systemctl is-active` check after the sleep classifies cleanly.
  3. If the binary is corrupt (rare), the current install path skips reinstall via `[ ! -x /usr/local/bin/node_exporter ]`. Add a version check: if `/usr/local/bin/node_exporter --version` doesn't include `NE_VERSION`, force reinstall.

### P1-3: `vm-726` is SSH-broken-but-TCP-reachable — generic candidate filter doesn't catch this class

- **Discovered**: 2026-05-06. `nc -zv 45.33.74.147 22` succeeds (TCP handshake completes) but `ssh2` library handshake hangs past 8s. Linode API confirms the instance is `running`. DB had it as `health_status=suspended`, so it was being picked by `reconcile-fleet`'s candidate query (`.in("healthy","suspended","hibernating")`) on every cycle, erroring with "Timed out while waiting for handshake", holding cv.
- **Immediate fix shipped**: One-shot `UPDATE instaclaw_vms SET health_status='unhealthy' WHERE name='instaclaw-vm-726'` to exclude it from the query. Single VM, low risk; no recent activity (last_health_check 2026-04-25).
- **Residual concern**: Other VMs in the same SSH-broken-but-TCP-reachable state will hit the same blocking failure mode. The reconcile-fleet candidate query has no notion of "ssh-degraded" — only the four discrete health states. Right now we'd need a one-off DB update for each occurrence.
- **Investigation plan (post-Consensus)**:
  1. Add a TCP-level reachability probe to `connectSSH` (or to the cron's per-VM try/catch wrapper) that fails fast (<3s) before the ssh2 handshake's 8s readyTimeout. If TCP reaches but ssh2 hangs, increment a per-VM `ssh_handshake_fail_count`.
  2. After N consecutive ssh_handshake fails (e.g., 5 cron cycles), automatically mark `health_status='unhealthy'` and emit an admin alert. Same shape as `health_fail_count` but for SSH-layer failures specifically.
  3. Audit how many other VMs are in this state right now — would expect 0-2 at most, but if it's 10+, that's a systemic issue worth deeper investigation.

### P1-4 [SHIPPED 2026-05-14]: Vercel nft trace cache silently serves stale `vm-manifest.ts` to cron routes

- **Status**: **SHIPPED 2026-05-14.** Bug class closed by a 3-layer defense, all in place since 2026-05-09 and hardened today: (1) manual touch-route cache-bust comments, (2) `.husky/pre-commit` hook auto-touches `route.ts` when `vm-manifest.ts` is staged, (3) `lib/manifest-integrity.ts` runtime hash compare against GitHub raw with HARD STOP on mismatch. Today's hardening adds: synthetic test coverage (38/38 assertions across 15 scenarios), P0 admin alert on `stale_bundle` verdict (6h-deduped, mirrors Rule 37 / Rule 49 pattern), expanded hash coverage from just `version+configSettings` to also include `cronJobs[].marker` + `requiredEnvVars` + `envVarDefaults`. JSON migration was considered and rejected — VM_MANIFEST contains TypeScript constructs (`JSON.stringify(...)`, `templateKey` references, `String(BOOTSTRAP_MAX_CHARS)` dynamic values) that aren't cleanly JSON-expressible; partial migration would create two sources of truth (exactly the class of bug we're preventing). Existing 3-layer defense is architecturally sound and now empirically tested.

- **Implementation files** (this session):
  - `lib/manifest-integrity.ts` — refactored to `ManifestFingerprint` shape; `parseRemoteManifest` extracts `cronMarkers + requiredEnvVars + envVarDefaults + dynamicConfigKeys + dynamicEnvVarDefaultKeys`; `verifyManifestFreshness(fingerprint)` returns `stale_bundle` verdicts with `diff_summary` for operator triage.
  - `app/api/cron/reconcile-fleet/route.ts` — `sendStaleBundleAlertDeduped` helper fires admin email on `stale_bundle` verdict. Key shape: `stale_bundle:${remote_sha_prefix}`. Body includes runtime/remote version, both SHAs, diff_summary, and action-required steps.
  - `app/api/cron/file-drift/route.ts` — updated to pass `manifestFingerprint(VM_MANIFEST)` instead of (version, configSettings).
  - `scripts/_verify-manifest-integrity-roundtrip.ts` — updated for new fingerprint shape; round-trips against live `vm-manifest.ts` (cv=99) match cleanly.
  - `scripts/_test-manifest-integrity.ts` — new 38-assertion synthetic test covering all 7 verdicts + dynamic-keys filter + cache TTL + SHA order-insensitivity.

- **Why JSON migration was rejected**: VM_MANIFEST contains `files[].content: JSON.stringify({...})` inline values, `files[].templateKey` references resolved by lookup at module load, and dynamic configSettings (`String(BOOTSTRAP_MAX_CHARS)`). Partial migration of only the JSON-safe fields would split the manifest across two files — risk of drift between them = exactly the class of bug we're preventing. The existing GitHub-raw integrity check accomplishes the same goal (out-of-bundle source of truth) without the architectural cost.

- **Acceptance criteria** (PRD §6.2):
  1. ✓ DONE — defense in place; option (b) "runtime-version-and-hash logging with stale-manifest alert" is now hard-prevention (halt + alert), not just logging.
  2. ✓ DONE — `scripts/_test-manifest-integrity.ts` simulates 7 deploy-with-stale-bundle scenarios + 8 edge cases; route's `verifyManifestFreshness` gate exists and is unit-covered.
  3. ✓ DONE — this entry.

- **Followups filed (Tier 3, non-blocking)**:
  - Pre-deploy Vercel build hook that refuses to deploy on detected stale-bundle (chicken-and-egg with the integrity check; would require a separate GH Action).
  - Daily/hourly audit cron that SSH-probes 5 random VMs' on-disk config against the manifest's expected values (catches lying-DB regressions in <24h instead of via the stale-bundle path).

#### Historical context (kept for forensic reference)

- **Discovered**: 2026-05-09. 20 healthy assigned VMs at `config_version=91` were missing the 7 new compaction keys (`mode`, `maxActiveTranscriptBytes`, `recentTurnsPreserve`, `qualityGuard.{enabled,maxRetries}`, `notifyUser`, `truncateAfterCompaction`) that landed in the v90 manifest (commit `7ac0d370`). Probed by `_probe-v91-compaction.ts` and `_probe-v91-census.ts`; 14/15 sampled VMs had the keys missing on disk.
- **Root cause** (already documented in `app/api/cron/reconcile-fleet/route.ts` cache-bust comment, commit `16aa97c9` 2026-05-07 19:45 UTC): Vercel's `@vercel/nft` build trace cache served the **pre-v90** `vm-manifest.ts` to the reconcile-fleet cron route across deploys. The reconciler ran with the cached old manifest in memory, pushed the OLD `configSettings` (which already matched on-disk → no drift detected → `result.errors=[]` → `pushFailed=false` → cv bumped to current `VM_MANIFEST.version` resolved from elsewhere in the cached blob → 91). VMs landed at cv=91 with old config on disk. Once cv=91, the `lt(config_version, 91)` filter in `route.ts:157` excludes them forever.
- **Why Rule 10 verify-after-set didn't catch it**: the verify only checks the keys it's been TOLD to verify (i.e., the keys present in its in-memory view of `manifest.configSettings`). When the in-memory manifest is stale, the verify can't know about keys it isn't iterating over. This is a Rule 23-shape failure (stale module cache) at the Vercel-bundle layer instead of the local node-process layer.
- **Immediate mitigation already in place**: cache-bust via `touch route.ts` comment (commits `5e710334`, `16aa97c9`). Reactive — only works when someone notices the issue and adds a comment to bust the cache. Failed to catch the v89→v90 deploy in time, leaving 20 VMs stuck.
- **Long-term fix (this P1)**: move `VM_MANIFEST` from a `.ts` file imported at route-bundle time to a `.json` file (`lib/vm-manifest.json`) loaded at request time via `readFileSync` or `import` with `assert { type: 'json' }`. JSON files are not subject to nft trace caching the same way TS imports are — they're loaded fresh on each request (or at least each cold-start, which on Vercel is frequent). Trade-off: slightly more boilerplate to type-check the JSON shape, but the security/correctness gain of "fresh manifest on every cron tick" is worth it.
- **Alternate approach to consider**: keep `VM_MANIFEST` in TS but expose `manifest.version` + a hash of `configSettings` via a runtime-loaded debug field, and have the cron route LOG these on every fire. A monitoring dashboard could detect "manifest version did not advance even after a deploy" — reactive but observable. Less elegant than the JSON move but lower-effort.
- **Detection wishlist**: a daily/hourly audit job that picks 5 random VMs at the current `VM_MANIFEST.version`, SSH-probes their on-disk config, and compares against the manifest's expected `configSettings`. Alerts on any drift. Catches lying-DB regressions in <24h instead of waiting for someone to notice.

---

## Fleet Health: Root Causes & Rules

> Authored after the 2026-05-13 fleet-catch-up session. The catch-up moved 14 VMs to cv=95 cleanly but left ~46% of the fleet still behind. Investigation found that "stuck" is rarely a single bug — it's a small set of structural failures, each repeated across many VMs, that hold cv hostage forever. This section documents what's actually broken in the reconciler's ability to keep the fleet current, with exact code-path citations and rules for every recurrence path.

### Definition of "fleet healthy"

The fleet is **healthy** when:

```
count(instaclaw_vms WHERE health_status='healthy' AND status='assigned' AND config_version < VM_MANIFEST.version) == 0
```

That is: **every actively-serving VM (healthy + assigned, the population the user expects to work) is at the current manifest version.** Suspended and hibernating VMs are intentionally offline and self-resolve via reactivation; they don't count toward fleet health.

When this number is non-zero, **at least one paying customer's VM is silently behind**. The reconciler's job is to drive this number to zero and keep it there.

Acceptable error classes (do NOT block cv bump):
- Optional monitoring sidecars (node_exporter)
- Partner-skill installs that depend on missing per-VM credentials (private repos)
- Sidecar service heal steps for non-customer-facing daemons

Unacceptable error classes (MUST block cv bump):
- Any failure that means the gateway will run with stale config on next restart
- Any failure where on-disk state diverges from what the manifest specifies
- Any data-integrity miss (config-set returned success but value didn't change)

### Why ~46% of the fleet was behind after a "successful" catch-up

The catch-up's filter selects `cv ≤ MANIFEST.version - minGap` with `minGap=5` by default — so VMs at cv 91-94 (close-but-not-current) are excluded. The catch-up was designed for the cv=82 stuck cohort; cv 91-94 were assumed to converge naturally via Vercel cron. They don't, because:

1. The reconciler's pushFailed gate (route.ts:280) holds cv bump on ANY error
2. Several deterministic failures recur on every cron tick: disk full, dead sidecars, missing credentials
3. The cron has no escalation, no exponential backoff, no failure-mode classification

So the same VMs keep failing the same step every 3 minutes forever. **Without operator intervention or a structural fix, they never converge.**

### Root cause 0 (UPSTREAM): Session-backup runaway loop fills disks

**Evidence**: vm-788 had **242,219 files** in `~/.openclaw/session-backups/` (58GB on a 79GB disk, 100% full). vm-375 had 211,728 files (56GB). 4 paying-customer VMs had 100%-disk crashes traced to this: ellingsonjoel@gmail.com (vm-842), shelpinc@gmail.com (vm-043), bocacine@icloud.com (vm-788), verkanntet@gmail.com (vm-568), artiprido@gmail.com (vm-375). plus 3 about-to-fill VMs (vm-576, vm-084, vm-561 at 90-94%).

**Code path**: `lib/ssh.ts:_backup_session_file()` (the embedded Python in `STRIP_THINKING_SCRIPT`). The 2026-05-11 idempotency gate used `backup.mtime >= src.mtime` to skip duplicate backups. The gate **never fired in practice** because `strip-thinking.py` modifies the source jsonl after each backup (strips thinking blocks, compacts, trims failed turns). Source mtime is always newer than the most-recent backup mtime on the next cron tick → the check always permits a new backup → ~1 backup per cron tick per session → 1440/day per session × 24 sessions × 7d retention = 240k+ files.

**Why it took weeks to notice**: the disk-fill is asymptotic. A new VM has ~100MB of disk usage, grows to 50GB+ over weeks. The first time it hits 100% is sudden customer-down. Without disk-utilization monitoring (P3 follow-up), it stays invisible until the gateway crash.

**Fix shipped (commit eaf5617a, 2026-05-14)**: replaced the mtime-equality check with a **wall-clock cooldown** + **per-session count cap**:
- `SESSION_BACKUP_COOLDOWN_SEC = 300` — skip if ANY backup for this basename has mtime within last 5 min.
- `SESSION_BACKUP_MAX_PER_SESSION = 50` — hard ceiling regardless of cooldown.

Worst case new behavior: 50 × 24 sessions ≈ 1200 files (vs 240k observed). At ~250KB avg ≈ 300MB max per VM vs 58GB observed.

**RULE 45 (Cooldown over mtime equality for idempotency on self-mutating data)**: any idempotency check whose subject is mutated by the same code that owns the check MUST use a wall-clock cooldown, not a state-equality test. The mtime-equality gate failed because the strip-thinking script that called `_backup_session_file` ALSO modified the source file's mtime via subsequent ops in the same tick — making the "did the source change" check tautologically permit every call. Wall-clock cooldown breaks the loop without requiring careful reasoning about which mutations land between gate checks.

**RULE 46 (Disk monitoring is mandatory; absent it, disk fills are P0 customer-down)**: every VM must have a periodic disk-utilization check that alerts at 80% AND auto-purges old session-backups at 90%. Without this, accumulating-cache bugs like Root Cause 0 stay invisible until catastrophic. Implementation: extend `cron/health-check` to read `df` via the existing SSH path, persist `instaclaw_vms.disk_percent`, alert on >85, auto-purge at >90.

### Root Cause 0.5: Template-only file changes can't reach caught-up VMs without a manifest bump

**The 2026-05-14 Rule 45 propagation incident.** The session-backup cooldown fix (commit `eaf5617a`) updated the embedded `STRIP_THINKING_SCRIPT` template in `lib/ssh.ts` — the canonical source consumed by `stepFiles` via the manifest's `files[]` entry at `vm-manifest.ts:1516`. The fix was merged and the reconciler kept running its 3-minute cron. Yet a 8-VM SSH probe a day later found **7/8 VMs still had the OLD script on disk**.

Root cause: the reconcile-fleet cron filters VMs at `app/api/cron/reconcile-fleet/route.ts:272`:

```ts
.lt("config_version", VM_MANIFEST.version)
```

The architectural implication: **VMs at `cv = VM_MANIFEST.version` are excluded from the cron's batch query entirely.** They never enter `reconcileVM`, never reach `stepFiles`, never receive any template-only update. The fix reached only VMs at `cv < target` (which were behind for some other reason and got the new file as a side effect of stepFiles running during their catch-up). Caught-up VMs — exactly the population that "looks healthy" — get nothing.

This is structurally identical to the EDGEOS_BEARER_TOKEN incident (commit `42a1c8d8`): a partner secret rotated in Vercel env propagates to new provisions but not to existing VMs at cv=current. Same shape.

**Recovery executed.** One-shot fleet-push via `scripts/_fleet-push-strip-thinking-v3.ts` (mirrors the canonical hotfix's deploy pattern: base64-encoded ship, py_compile syntax check, sentinel grep, atomic mv with .bak preservation, md5 verify). Concurrency 5, waves of 20, 68 seconds wall-clock for 146 VMs. **135 deployed, 11 already-current, 0 failed.** Spot-checked 5 random VMs post-push: all md5-matched and sentinel-validated.

**RULE 47 (Continuous reconciliation, not version-gated)**: any change to a `vm-manifest.ts:files[]` template OR an in-VM env var (or anything else that needs to reach already-caught-up VMs) MUST be paired with EXACTLY ONE of:

1. **Manifest version bump.** `VM_MANIFEST.version` advanced by 1; PR description names the change as a "file-content release" (no config-key changes; no schema changes). All current-cv VMs re-enter the cron's filter, run all steps including `stepFiles`, get the new file.
2. **One-shot fleet-push** that mirrors `_deploy-strip-thinking-hotfix.ts` / `_fleet-push-strip-thinking-v3.ts`: imports the canonical constant from `lib/`, validates sentinels in-process before SSH, base64-encodes, atomic mv with .bak preservation, md5 verify post-write.
3. **Both** (recommended). The fleet-push catches the immediate hazard within minutes; the manifest bump locks the file state to the cv for future audits ("cv=N means this file content").

Doing NEITHER means the change reaches new provisions (via `configureOpenClaw`) and currently-stuck VMs (those at cv<target) but NOT the bulk of the fleet. The current-cv VMs become a silent stale-cache cohort indistinguishable from healthy by any "version is correct" check.

**Long-term architectural fix**: tracked as a P1/P2 item in `docs/prd/fleet-health-hardening-2026-05-14.md`. The Kubernetes pattern — continuous reconciliation, no version gate, control loop runs forever — is the right shape. A "file-drift" cron that runs `stepFiles` only (no config-set, no service restart, no cv mutation) on every (healthy, assigned) VM, regardless of `config_version`, would close this gap without the side-effect risk of bumping the version on every file edit. HashiCorp Nomad's "drift detection" + Ansible's "pull-based agent" patterns are direct references. Until that ships, every template change goes via Rule 47.

**Banned patterns:**
- Editing a `vm-manifest.ts:files[]` template (or any consumer of `STRIP_THINKING_SCRIPT` / similar embedded scripts) without either bumping `VM_MANIFEST.version` in the same PR OR landing a one-shot fleet-push in the same operational window.
- Trusting "config_version reached current" as proof a recent template change is on disk.
- Adding new files to `vm-manifest.ts:files[]` without a coverage script (per Rule 27) that surfaces per-VM disk state.

**Detection rule**: any PR that touches `lib/ssh.ts:STRIP_THINKING_SCRIPT`, `lib/ssh.ts:WORKSPACE_SOUL_MD`, `lib/vm-manifest.ts:files[]` entry contents, or similar embedded templates MUST include one of: (a) `VM_MANIFEST.version` increment in the same diff, (b) a companion `scripts/_fleet-push-*.ts` script for the change, OR (c) an explicit PR-description note acknowledging that the change reaches only fresh provisions and currently-stuck VMs (acceptable only for non-load-bearing changes).

### Root Cause 0.6: Surgical service-fix probes must verify dependency state, not just files

**The 2026-05-14 instaclaw-xmtp crash-loop incident.** Two paying-customer VMs (vm-912, vm-904) had `instaclaw-xmtp.service` in `activating (auto-restart)` state — restart counters 5,453 and 19,736 respectively. The cron reported `instaclaw-xmtp: surgical fix failed: activating` on every tick. The reconciler's surgical fix path at `lib/vm-reconcile.ts:4466` does:

1. Write the unit file.
2. `daemon-reload`, `enable`, `restart`.
3. `sleep 4`.
4. `systemctl --user is-active` — looks for the string "active" in stdout.

When the service is stuck in a crash loop (10-second `RestartSec` cycle), the `is-active` call lands mid-cycle and returns `activating`. The string "active" is NOT a substring of "activating" (`active` ≠ `activa`), so the check correctly reports failure — but the failure mode tells the operator NOTHING about WHY the service is crashing.

Root cause via SSH probe: `ERR_MODULE_NOT_FOUND` — `Cannot find package '@xmtp/agent-sdk'` (vm-904) and `Cannot find package '/home/openclaw/scripts/node_modules/viem/index.js' imported from /home/openclaw/scripts/node_modules/@xmtp/agent-sdk/dist/index.js` (vm-912). The Node.js ESM resolver was failing because the npm packages in `~/scripts/node_modules/` were missing (vm-904) or corrupt — viem's `package.json` was empty/broken on vm-912.

The reconciler's probe (lib/vm-reconcile.ts:4419-4422) checks four things:
```
unit=  # unit file exists
active=  # is-active = "active"
mjs=  # ~/scripts/xmtp-agent.mjs exists
key=  # ~/.openclaw/xmtp/.env has XMTP_WALLET_KEY
```

None of these check **whether the npm dependencies are actually installed and resolvable.** With `unit=1 mjs=1 key=1 active=0`, the surgical path runs, restarts the service, observes "still not active", reports failure. It never tries `npm install`. The full-reprovision path (which DOES run `setupXMTP`'s `npm install @xmtp/agent-sdk@latest`) is gated behind `key=0 OR mjs=0` (lib/vm-reconcile.ts:4454: `hasKey && hasMjs ? "surgical" : "full setupXMTP"`). So a VM with files present + dependencies broken is permanently routed to the surgical path that can't fix the actual problem.

**Recovery executed.** `scripts/_fix-xmtp-stuck-vms.ts`: per-VM, stop the service, `rm -rf ~/scripts/node_modules` (scoped narrowly — does not touch `~/scripts/` itself or `~/.openclaw/xmtp/`), `npm install @xmtp/agent-sdk@latest` (viem comes in as transitive), reset-failed + restart, poll is-active for up to 60s with 2s interval. Both VMs recovered: NRestarts 19,776 → 0, NRestarts 5,496 → 0; xmtp addresses generated and synced to `instaclaw_vms.xmtp_address`. The 60s poll mirrors Rule 43 — cold-start with npm-fresh node_modules takes ~20-30s.

**RULE 48 (Surgical service fixes must probe dependency state, not just file existence)**: when a reconciler step "surgically" fixes a systemd service by re-writing the unit file + restart, the probe MUST validate that the service's CODE DEPENDENCIES (npm packages, pip packages, system libraries) are present and functionally importable BEFORE deciding the surgical path is safe. If deps are broken, route to the full re-provision path (npm install) instead.

**Mandatory pattern**:

1. **Dep-import smoke test.** Before declaring a service "just needs a restart," exec the entrypoint with `--check` or `--dry-run` flag (if available), OR exec a 1-line Node/Python harness that imports the top-level packages the entrypoint uses. Catch `ERR_MODULE_NOT_FOUND`, `ModuleNotFoundError`, or equivalent and route to the re-install path.
2. **Restart-counter check.** `systemctl --user show <service> --property=NRestarts` — if NRestarts > 50 in any reconcile window, the service is in a crash loop. Don't try another restart; investigate. Likely candidates: missing deps (this rule), corrupt config, OOM, port conflict.
3. **Distinguish `is-active` outcomes.** `active`, `activating`, `inactive`, `failed`, `deactivating` are five distinct states. `"active"` substring matching is brittle (`activating` doesn't contain `active`, but `active (running)` does — and `active (auto-restart)` doesn't — and these can change between systemd versions). Use exact string compare: `stdout.trim() === "active"`.
4. **Generous poll window.** Cold-start of Node/Python services with non-trivial deps (XMTP network connect, viem RPC initialization, OpenAI/Anthropic SDK init) can be 20-60s. Don't use a hardcoded `sleep 4` and then declare failure — poll for up to 60s with a 2s interval, early-exit on first `active`.

**Banned patterns**:
- `is-active 2>&1 | grep -q "^active$" && echo 1 || echo 0` — fragile because (a) systemd version differences in is-active output formatting, (b) misses the `active (running)` long form.
- `sleep N; is-active` with N < 30 for any service that imports external SDKs.
- "Just restart it" as the universal recovery action without confirming the restart actually has a chance of fixing the root cause.

**Detection rule**: any new `step*` in `lib/vm-reconcile.ts` that calls `systemctl --user restart` on a service MUST include an upstream probe for that service's runtime deps. If the service imports any npm package, the probe checks `~/scripts/node_modules/<top-level-dep>/` exists. If the probe fails, route to the install/re-provision path, not the restart path. The reviewer should ask: "If `node_modules/` is empty, does this step recover, or does it loop forever reporting `activating`?"

### Root Cause 0.7: Partner secrets fail silently for weeks; need active verification

**The 2026-05-14 EDGEOS_BEARER_TOKEN incident.** A 64-char hex string was duplicated into Vercel's `EDGEOS_BEARER_TOKEN` slot at variable-creation time (likely a copy from `EDGEOS_API_KEY`'s slot). The real value should have been a JWT (`eyJ…`). Every edge_city VM carried the wrong token for **34 days**. Every authenticated EdgeOS call from every edge attendee's agent silently returned 401, and no internal alert fired because partner-API 401s aren't a category we monitored. Discovered only when Cooper independently tested attendee-directory queries and noticed they were empty.

**RULE 49 (Partner secrets must be actively verified, not assumed)**: every partner secret in Vercel env that controls authenticated calls to an external partner API MUST be verified end-to-end (a) when first set, (b) on every rotation, and (c) continuously via a periodic probe. The shape check (e.g., JWTs start with `eyJ`) alone would have caught the original 34-day incident on day one.

**Implementation** (shipped 2026-05-14, P1-9):

- **`lib/partner-secrets.ts`** registers a verifier per secret. Each verifier issues an idempotent smoke-test call to the partner API and maps the response to a uniform `VerifierStatus` (`ok`, `not_configured`, `shape_invalid`, `auth_failed`, `unreachable`, `endpoint_5xx`, `endpoint_other`). Shape check runs locally before any network call so a typo in Vercel is caught in milliseconds without leaking the value to the partner.
- **`scripts/_verify-partner-secrets.ts`** — operator runs after rotating a value in Vercel. Iterates all verifiers, prints pass/fail, exits 1 on hard failure. **This is mandatory** in the partner-secret rotation runbook (below).
- **`cron/probe-partner-secrets`** (`0 * * * *`) — hourly continuous monitoring. Per-secret 6-hour alert dedup via `instaclaw_admin_alert_log` so an EDGEOS outage doesn't suppress alerting on BANKR.

**Partner-secret rotation runbook**:

1. Partner sends new/rotated secret.
2. Update Vercel env via `printf 'new_value' | npx vercel env add VAR_NAME production` — **always `printf`, never `<<<` or `echo`** (CLAUDE.md Rule 6 — both append a trailing newline that breaks JWTs).
3. Pull to local: `npx vercel env pull --environment=production`.
4. Run `npx tsx scripts/_verify-partner-secrets.ts`.
5. Confirm the rotated secret reports `ok`. If `shape_invalid` or `auth_failed`, the value in Vercel is wrong — STOP and re-check before deploying.
6. Trigger a Vercel redeploy (commit + push, or manual rebuild) so the new value reaches production.

**When adding a new partner secret** (Eclipse, Devcon, Bankr production, etc.):

1. Add the env var to Vercel.
2. Add an entry to `SECRET_ENV_VAR_SOURCES` in `lib/vm-reconcile.ts` (controls distribution to VMs via stepEnvVarPush).
3. Add a verifier function to `lib/partner-secrets.ts:SECRET_VERIFIERS`. The verifier MUST include both a shape check AND a live-API smoke test.
4. Run `_verify-partner-secrets.ts` and confirm the new entry reports `ok`.
5. Bump `SECRET_VERSION` in `lib/vm-reconcile.ts` so existing VMs receive the new env var on the next reconcile tick.

**Banned patterns**:

- "Set the secret and assume it works." That's what gave us 34 days of silent failure.
- Verifier without a shape check. The shape check is the fastest signal and catches the most common error class (typo, wrong slot, copy-paste).
- Hardcoded `anthropic-version` strings in verifiers without verifying against the canonical Anthropic-supported list. (Hit during P1-9 implementation — used `2026-01-01` which the API rejected with 400; correct value is the long-stable `2023-06-01`.)

**Detection rule**: any new `process.env.X_API_KEY` / `X_TOKEN` / `X_SECRET` reference added to the codebase must be matched by an entry in `SECRET_VERIFIERS`. If a verifier endpoint isn't available (e.g., partner hasn't shipped their auth-check API), use a shape check + a `TODO when partner ships smoke-test endpoint` comment — but never ship the secret without at least the shape check.

### Freeze pipeline — $1,450/mo leak with zero successful freezes in system history (RESOLVED 2026-05-15; ARCHITECTURE PIVOT 2026-05-16)

**Status update 2026-05-16-PM:** Rules 50/51/52 (the Linode-image cleanup-gated approach) stopped the bleeding but did not unblock the actual leak — production VMs accumulate 10-30 GB of irreducible user/platform state that cannot fit under Linode's 6,144 MB private-image cap even with maximum-safe cleanup. Empirical PGLite verification on vm-050 then revealed a second bug: gbrain v0.35.0.0's SIGTERM-mediated graceful shutdown corrupts PGLite-WASM state (counterintuitively, SIGKILL produces recoverable state; SIGTERM does not). The original tarball-the-disk archive design is dead.

**New canonical design: Path 2 (archive-based freeze).** See `instaclaw/docs/prd/freeze-thaw-v2-archive-based.md` §15 (architecture) + §16 (locked decisions). Summary:

- Stop snapshotting the entire 20 GB disk. Archive only user-irreplaceable state (~5-50 MB compressed): brain.pglite (via gbrain's native `dumpDataDir` hot-snapshot method), workspace, sessions, .env, wallet, openclaw.json, auth-profiles.json, bearer token.
- Encrypt outer tar with AES-256-GCM (`lib/freeze-encryption.ts`), key id versioned for rotation.
- Upload to Cloudflare R2 (`lib/r2-storage.ts`). $0 egress, S3-compatible SDK, swap-out path preserved.
- Freeze itself just deletes the Linode instance after archive verified — no `cleanupDiskForFreeze`, no `recoverInstanceAfterFailedFreeze`, no SSH at freeze time. Rules 51 and 52 become moot for freeze-v2.
- Thaw provisions fresh VM from base snapshot, then layers the archive onto an EMPTY PGLite dir BEFORE first gbrain start (avoids the SIGTERM-corrupted-WASM-reload bug).
- gbrain dependency: needs a new MCP `snapshot_brain` tool that exposes `dumpDataDir`. Freeze-v2 ships once gbrain terminal lands this.

**Path 2 substrate shipped 2026-05-16:**
- Migration `20260516180000_freeze_v2_columns.sql` adds 8 NULLABLE columns (state machine, archive path/sha256/size/manifest/timestamp, thaw_requested_at, frozen_retention_policy) + 2 partial indexes. Zero behavior impact on existing fleet.
- `lib/r2-storage.ts` — S3-SDK wrapper for R2 (putObject, getObject, deleteObject, objectExists, listObjectsByPrefix). 250 lines.
- `lib/freeze-encryption.ts` — AES-256-GCM with key_id versioning from day 1. selfTest passes; 8-case local crypto test passes (round-trip on 0-5MB, tamper detection, too-short rejection, invalid key_id rejection, fresh-IV-per-encrypt).
- `scripts/_verify-freeze-v2-infra.ts` — 12-step end-to-end smoke test (encrypt → upload → list → download → sha256-verify → decrypt → delete → confirm-gone). Cooper runs after configuring R2 + Vercel env.

**Required Vercel env vars for substrate** (set before Phase 2 ships):
- `R2_ACCOUNT_ID` — Cloudflare account ID
- `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` — R2 API token credentials (scope: single bucket)
- `R2_BUCKET` — e.g., `instaclaw-frozen-archives`
- `FREEZE_ARCHIVE_KEY_CURRENT` — `v1` for first release
- `FREEZE_ARCHIVE_KEY_V1` — `openssl rand -hex 32` output (64 hex chars). **Back this up offline.** Losing the key = all archives unrecoverable.

**Original 2026-05-15 incident report below — preserved for historical context.**

---


**Incident summary**. From the freeze cron's first deployment through 2026-05-15, **not a single VM** was ever frozen successfully on the InstaClaw fleet. Across 7 days of production logs: 935 lifecycle-log entries, 918 `freeze_skipped_safety`, 17 `freeze_failed`, **0 `frozen`**. 50 VMs sat in `status=assigned + health_status=suspended` past their 3-day freeze grace window — paying Linode $29/mo each (~$1,450/mo total) for instances whose owners cancelled weeks ago. 17 of those 50 were left **offline-on-Linode but still billing**: failed freezes shut the instance down, the one-shot boot-back-up recovery silently failed, and the cron retried every hour observing `ssh-fail` on an instance with no OS running.

**Three independent root causes** combined to make the system look "working" while producing nothing:

1. **Linode private-image 6,144 MB hard cap.** The synchronous `POST /images` returns 200 + image id even for over-cap disks. Linode's async preparation stage then emits a `disk_imagize status=failed msg="Size of disk (29273MB) is..."` event and silently deletes the half-created image. Our `waitForImageAvailable` polls and gets HTTP 404, with no visibility into the upstream "size exceeded" cause. Production VMs accumulate 5-30 GB of disk over weeks — every one of them hit the cap. Confirmed via Linode events API for 16 specific failures spanning 2026-05-09 → 2026-05-14.

2. **SSH-mtime silence check reading our own platform writes.** `sshHasRecentActivity` runs `find ~/.openclaw/agents/main/sessions -mtime -7 -name '*.jsonl'` and `find ~/.openclaw/workspace -mtime -7 -name '*.md'`. But on every sleeping VM, **strip-thinking.py runs every minute** and modifies session jsonl files (compaction, thinking-block strip, trim-failed-turns). The **reconcile-fleet + file-drift crons** (per Rule 47, continuous reconciliation) write `CAPABILITIES.md`, `SOUL.md`, `MEMORY.md`, `QUICK-REFERENCE.md` on every cycle. Both signals fire the "SSH activity detected" gate, blocking freeze on 9 unique VMs (155 log entries in 24h). The check was reading the platform's own writes and reporting "user is active." Same bug class as Rule 45 — an idempotency / silence check whose subject is mutated by the same code that owns the check.

3. **One-shot boot recovery silently swallowed failures.** `lib/vm-freeze-thaw.ts:467-482` issued a single `bootInstance` call after imagize failure, then logged `"RECOVERY FAILED"` and returned. No retry. No alert. The instance stayed `offline` on Linode (still billing). Subsequent freeze attempts then hit `ssh-fail: timed out` on every retry (no OS to connect to), looking identical to the chronic-failer cohort (vm-866, vm-873, vm-726). 17 zombies accumulated this way before the money audit caught them.

**Why each was invisible**. Bug 1 hid behind Linode's async-preparation model — the synchronous API call succeeds. Bug 2 hid behind the legitimate-looking "SSH activity detected" reason string. Bug 3 hid behind the cron's success-suffixed `instance booted back` return reason that wasn't itself a Linode probe. Each bug looked normal in isolation; combined they meant zero successful freezes for the system's entire lifetime.

**Resolution (2026-05-15, commit `2ce729f1`)**. Three coordinated fixes:

- **Rule 50** — `userHasRecentActivity` (new helper in `lib/vm-lifecycle-helpers.ts`) replaces the SSH-mtime check in `freezeVM`. Reads `instaclaw_vms.last_user_activity_at` (real user-driven proxy calls only). Fail-CLOSED on NULL. Candidate query in `app/api/cron/vm-lifecycle/route.ts` switched to `last_user_activity_at` so phantom-heartbeat VMs re-enter the freeze pool.
- **Rule 51** — `cleanupDiskForFreeze` (new helper in `lib/vm-freeze-thaw.ts`) runs whitelist-only aggressive cleanup before shutdown. Skip-cleanly gate refuses to imagize if disk is still ≥ 6,144 MB post-cleanup (no zombie creation; instance keeps running).
- **Rule 52** — `recoverInstanceAfterFailedFreeze` retries `bootInstance` 3× with `[5s, 15s, 30s]` backoff, re-checks instance state at the top of each attempt, and fires a `sendAdminAlertEmail` P0 if all attempts fail.

The 17 existing offline-billing zombies still need manual recovery (separate task — boot or destroy each). Going forward, the code paths that produced them no longer exist.

### Rule 50 — Freeze silence check uses DB user-activity, never file mtimes

Every cron / watchdog / lifecycle decision that asks "has the user been active recently?" MUST consult `instaclaw_vms.last_user_activity_at` (or the watchdog fallback chain `last_user_activity_at ?? last_proxy_call_at`) — never a `find -mtime -N` over files on the VM. Platform-owned writes (strip-thinking.py per-minute compaction, reconcile-fleet stepFiles, file-drift cron, backup crons) modify the same files the legacy silence check reads, producing structural false positives that block destructive actions on inactive VMs.

**Why**: prior to 2026-05-15, the freeze cron's `sshHasRecentActivity(ip)` ran `find ~/.openclaw/agents/main/sessions -mtime -7 -name '*.jsonl'` and `find ~/.openclaw/workspace -mtime -7 -name '*.md'`. Both globs hit on every sleeping VM because our own crons touch those files. 9 sleeping-but-eligible VMs were blocked from freeze for weeks (155 false-positive `freeze_skipped_safety / SSH activity detected` entries in a 24h window, verified by directly probing vm-861 and vm-697 — gateways stopped since 2026-05-09 and 2026-05-10, but `find` still found fresh-mtime files at the time of audit because of strip-thinking).

**How to apply**:
- For **freeze gating** (where we have a DB row): use `userHasRecentActivity(vm)` from `lib/vm-lifecycle-helpers.ts`. Pure-data, synchronous, fail-CLOSED on NULL `last_user_activity_at`. The freezeVM gate is the canonical example.
- For **orphan deletion** (Pass -1 in `vm-lifecycle/route.ts:338`): there is no DB row to query, so the SSH-mtime check is still the right primitive. Its preserved semantics — "no data on disk" → safe to delete an orphan with no DB owner — are correct in that narrow context.
- For **any new code path** that asks the same question: prefer the DB column. Document the exception loudly if you must use file mtimes (e.g., orphan path); the default is "DB column wins."

**Banned patterns**:
- Adding new callsites of `find ~/.openclaw/{sessions,workspace} -mtime -N` to decide "is the user active?" Use `last_user_activity_at`.
- Reading `last_proxy_call_at` alone — heartbeats fire on suspended-but-not-stopped VMs and contaminate it. Always prefer `last_user_activity_at`.
- Falling back to `last_proxy_call_at` when `last_user_activity_at` is NULL **for freeze decisions** specifically. Fail-CLOSED (skip the destructive action) is the correct response to NULL — wasted freeze attempts are dramatically cheaper than wrongly-frozen paying customers. (The watchdog's fallback chain is OK because the watchdog's destructive action is `restart`, which is reversible; freeze is not.)

**The protected files for any silence check are the same as for any cleanup operation**: NEVER look at mtime of, NEVER delete:
- `~/.openclaw/workspace/*` (SOUL.md, MEMORY.md, CAPABILITIES.md, EARN.md, QUICK-REFERENCE.md, TOOLS.md)
- `~/.openclaw/agents/main/sessions/*.jsonl` (active session transcripts — touched by strip-thinking)
- `~/.openclaw/.env` (gateway + partner tokens)
- `~/.openclaw/openclaw.json` (gateway config)
- `~/.openclaw/agents/main/agent/auth-profiles.json` (Anthropic key)
- `~/.openclaw/wallet/*` (private keys — load-bearing per Rule 22)
- `~/scripts/*` (bot CLI entrypoints)

**Detection rule**: any new `grep`/`find`/`stat` on the platform-modified files above is a code-review red flag. If the intent is "did the user do something?" the answer is `instaclaw_vms.last_user_activity_at`. If the intent is "is this VM healthy?" the answer is `/health` + `instaclaw_vms.health_status`. There is no third class.

### Rule 51 — Pre-freeze disk cleanup mandatory; skip if > 6,144 MB after cleanup

Linode private images have a **6,144 MB hard cap** documented in their API but enforced *asynchronously*: `POST /images` returns 200 with an image id, then internal preparation fails on size, then the image is silently deleted. Our polling gets HTTP 404 with no signal that "size exceeded" was the cause. Production VMs reach 5-30 GB within weeks of normal operation. Every freeze attempt on a production-sized VM trips this trap.

**Mandatory pattern**:

1. **Before any** `shutdownInstance` + `createImage`, call `cleanupDiskForFreeze(vm, runId)` (`lib/vm-freeze-thaw.ts`).
2. The cleanup MUST be whitelist-only. Files that user data depends on (workspace, sessions/jsonl, .env, wallet, openclaw.json, auth-profiles, scripts/) are NEVER touched per Rule 22 / Rule 30.
3. The cleanup MUST verify post-cleanup disk usage via `df --output=used /` and parse the result. If still ≥ 6,144 MB, return `{success: false, reason: "disk still N MB after cleanup"}` and let `freezeVM` skip the entire freeze. NEVER proceed to shutdown when imagize is doomed.
4. The cleanup recipe MUST mirror the snapshot-bake recipe in CLAUDE.md (`Snapshot Creation Process`) — that recipe is the gold standard for "what's safe to nuke to fit under 6 GB":
   - `~/.openclaw/session-backups/*` (Rule 45 leak — up to 58 GB observed)
   - `npm cache clean --force` + `rm -rf ~/.npm/_cacache`
   - `python3 -m pip cache purge` + `rm -rf ~/.cache/pip /root/.cache/pip`
   - `rm -rf ~/.cache/* ~/.nvm/.cache`
   - `find /tmp -maxdepth 2 -mtime +1 -type f -delete` (only files older than 24h)
   - `sudo apt-get clean` + `sudo rm -rf /var/lib/apt/lists/*`
   - `sudo journalctl --vacuum-time=1d`
   - `sudo find /var/log -maxdepth 2 -type f \( -name '*.gz' -o -name '*.1' -o -name '*.2' -o ... -o -name '*.old' \) -delete`

**Banned patterns**:
- Calling `shutdownInstance` without a prior verified-under-cap cleanup. The instance might never come back (Rule 52 dependent).
- Removing or relaxing the 6,144 MB gate before Linode officially raises their cap. The number is from `LINODE_IMAGE_MAX_MB` constant — change only when Linode docs change.
- Adding paths to the cleanup whitelist that touch user data. Even "harmless"-looking caches that overlap with workspace/session-state are forbidden. Whitelist is conservative-by-construction.
- "Best-effort" cleanup that doesn't verify the resulting size. We must KNOW the disk is under the cap before issuing the imagize.

**Detection rule**: every new code path that calls `createImage` or `disk_imagize` MUST call `cleanupDiskForFreeze` first AND check its `success: true` return. PR review should grep the diff for `createImage(` and refuse the change if there's no `cleanupDiskForFreeze` upstream. The cleanup whitelist is also a code-review checkpoint: any addition to the cleanup commands must justify why it's not in the protected-files list above.

### Rule 52 — Post-freeze-failure recovery retries `bootInstance` 3×; alerts P0 on failure

When imagize fails (any reason — over-cap silently, transient Linode error, timeout, DB write failure post-image), the source Linode instance is left in `offline` state from the upstream `shutdownInstance`. A single one-shot `bootInstance` call is insufficient: 2026-05-09 → 2026-05-14 produced 17 offline-on-Linode zombies billing $29/mo each because the recovery's `bootInstance` (or its `waitForInstanceStatus`) failed silently and the cron moved on.

**Mandatory pattern** (`recoverInstanceAfterFailedFreeze` in `lib/vm-freeze-thaw.ts`):

1. Retry up to `RECOVERY_MAX_ATTEMPTS = 3` times with backoff `[5s, 15s, 30s]`.
2. At the top of every attempt, `getInstanceState` first — if already `running`, short-circuit return.
3. Issue `bootInstance` only if state is `offline` (don't double-boot a `running` or transitional state).
4. Each attempt waits up to `INSTANCE_RUNNING_TIMEOUT_MS` for `status=running`.
5. If all 3 attempts fail, `sendAdminAlertEmail` with subject `[P0] Freeze recovery FAILED for <vmName>` and a body that contains:
   - VM id + name + Linode id + owner id
   - The original imagize failure reason
   - The final Linode status observed
   - **Paste-ready manual recovery steps** (Linode dashboard URL, SSH command, hypothesized root cause)
   - `runId` for log correlation
6. Wrap the alert send in try/catch — the alert failure path must NOT itself throw and double-fault the freeze cycle.

**Banned patterns**:
- A single `try { await bootInstance(...) } catch { /* noop */ }` after image failure. This was the pre-fix code; it produced the 17 zombies.
- Any "best-effort" recovery that swallows error state without signaling P0. The customer is being billed $29/mo for an offline VM. There is no "best-effort" that's acceptable; we either recover or wake an operator.
- Treating successful `bootInstance` as proof the instance came up. Always follow with `waitForInstanceStatus("running", ...)` and confirm.

**Detection rule**: any code path that issues `shutdownInstance` followed by a destructive operation (imagize, disk delete, etc.) MUST be paired with a `recoverInstanceAfterFailedFreeze` (or equivalent retry-with-alert) on the failure branch. If the destructive operation can leave the instance in any state other than the intended terminal state, the recovery is mandatory. Code review: grep for `shutdownInstance` and refuse the diff if any callsite lacks a recovery path that escalates to P0 alert on persistent failure.

### Rule 53 — freeze-v2 archive bytes ALWAYS go through `lib/freeze-encryption.ts`

Every byte written to or read from the R2 freeze-archive bucket MUST flow through `encrypt()` / `decrypt()` in `lib/freeze-encryption.ts`. Plaintext archive contents (wallet private keys, MEMORY.md, session jsonl, auth-profiles.json) MUST NEVER be uploaded to R2 in any form.

**Why**: archive contents include crypto wallet private keys (loss = funds gone, theft = funds drained). R2 server-side encryption is on by default, but client-side AES-256-GCM is defense in depth against (a) Cloudflare insider access, (b) misconfigured R2 bucket policy, (c) accidentally-published R2 API token, (d) a future R2 breach. The marginal cost is one `encrypt(buf)` call per archive (~50ms on a 50 MB blob).

**How to apply**:
- Archive cron, freeze cron, thaw cron, GDPR delete endpoint, retention-sweep cron, ANY future code that touches the bucket → import from `lib/freeze-encryption.ts` and `lib/r2-storage.ts`. Never construct your own `S3Client` or call `crypto.createCipheriv` directly for freeze-archive bytes.
- The `key_id` returned from `encrypt()` MUST be recorded in `instaclaw_vms.frozen_archive_manifest.encryption_key_id` so decrypt can find the right key during rotation.
- Rotate `FREEZE_ARCHIVE_KEY_CURRENT` annually. Bump the version (e.g., `v1` → `v2`), add `FREEZE_ARCHIVE_KEY_V2` env var, set `FREEZE_ARCHIVE_KEY_CURRENT=v2`. New encrypts use v2; decrypts of old archives keep working via v1. Don't delete `FREEZE_ARCHIVE_KEY_V1` until all v1-encrypted archives have been re-encrypted or deleted.
- **Back up the encryption key offline.** Losing `FREEZE_ARCHIVE_KEY_VN` = every archive encrypted with that version becomes permanently unrecoverable. Print it to paper and store with other cold-recovery secrets.

**Banned patterns**:
- Calling `putObject(key, plaintext)` without first running it through `encrypt()`. Diff review: grep for `putObject(` in the freeze code; every call must take a `ciphertext` Buffer, not raw user state.
- Skipping the auth-tag check on decrypt. `AES-GCM` provides authenticated encryption; ignoring the tag (or catching `DecryptError` and proceeding with garbage) defeats the integrity guarantee.
- Storing the encryption key in the archive itself. The key lives in Vercel env, never in R2.

### Rule 54 — gbrain `systemctl stop` corrupts PGLite data dir; never use it for backup

Empirically verified on vm-050 on 2026-05-16: `systemctl --user stop gbrain` produces an on-disk PGLite data dir that the next gbrain start CANNOT re-open ("PGLite failed to initialize its WASM runtime / Aborted()"). The shutdown code path in `serve.ts:beginShutdown` is logically correct (registers SIGTERM handler, calls `engine.disconnect()` → `db.close()` → `releaseLock()` → `process.exit(0)`); the resulting state is nonetheless broken. This is an upstream gbrain/PGLite v0.35.0.0 bug; we do not own a fix.

Counterintuitively, `pkill -KILL -f 'gbrain.*serve'` (SIGKILL, used by `instaclaw/scripts/install-gbrain.sh:340`) produces a RECOVERABLE backup. The PRE-WIPE backup tarballs in `~/.gbrain/brain.pglite.PRE-WIPE-*.tar.gz` load cleanly when extracted onto a fresh VM.

**Required pattern for ANY gbrain backup/archive operation:**

- Use PGLite's native `engine.db.dumpDataDir("gzip")` exposed via gbrain's `snapshot_brain` MCP tool (or admin HTTP endpoint). This is the canonical hot-snapshot mechanism and does NOT require stopping gbrain.
- If `snapshot_brain` is unavailable for some reason and a backup is absolutely required, use `pkill -KILL -f 'gbrain.*serve'` (SIGKILL) BEFORE the tar. Never `systemctl stop`. The backup must be paired with an immediate replacement/restore — don't leave gbrain dead.

**Banned patterns**:
- `systemctl --user stop gbrain` in any backup, archive, or migration flow. The post-stop data dir is unrecoverable. **The only legitimate use of systemctl stop for gbrain is when you're about to wipe the data dir entirely (e.g., install-gbrain.sh's wipe+reinit cycle), where the corrupted state doesn't matter because it's being replaced.**
- "Just one more stop+restart to test something" — that's how vm-050 lost 15h of timmy memory on 2026-05-16. Always restore from a known-good backup if you need to verify gbrain restart behavior; never use the live data.
- Adding any code that calls `stopGateway` / `systemctl --user stop gbrain` without a comment justifying why the data corruption doesn't matter at that callsite.

**Detection rule**: grep for `systemctl.*stop.*gbrain` and `stopGateway` in any PR diff. Each callsite must have a code comment explaining why the post-stop state is acceptable (e.g., "wipe is the next step; corrupted state will be deleted anyway"). Empirical-test: vm-050 with the BROKEN preserved tarball at `~/.gbrain/brain.pglite.BROKEN-20260516T152817/` is the reference repro if anyone doubts this.

#### 2026-05-18 nuance: SIGKILL is CONDITIONALLY safe, not unconditionally safe

The original Rule 54 (above) said "SIGTERM corrupts, SIGKILL is recoverable." That's STILL TRUE — but the framing implied SIGKILL is always safe, and it isn't. The vm-050 incident on 2026-05-18 (separate from the 2026-05-16 SIGTERM incident that originally motivated Rule 54) revealed a **second** PGLite bug that affects SIGKILL too. This nuance is critical: future terminals reading "SIGKILL is safe" and reflexively SIGKILL-ing a long-running gbrain sidecar can produce an unrecoverable data dir.

**Read this section in full before using SIGKILL on any gbrain process.**

##### The pg_control staleness failure mode

PGLite v0.4.3 (used by gbrain 0.35.0.0) does NOT automatically checkpoint the way vanilla Postgres does. Vanilla Postgres has `checkpoint_timeout=5min` by default — every 5 minutes, dirty buffer pages flush to disk AND `pg_control` (the WAL-recovery anchor) is rewritten with the latest checkpoint LSN. PGLite skips this autocheckpoint cycle. Empirical confirmation from vm-050 forensics 2026-05-18:

```
Test 6: 177,354 rows inserted over 60 seconds. pg_control mtime did NOT change.
        WAL grew through one full segment without a single pg_control update.
```

So during normal sidecar operation, **the on-disk pg_control progressively desynchronizes from the actual WAL state**:
- The sidecar's in-memory Postgres holds a current view (correct checkpoint LSN in shared_buffers)
- The on-disk `pg_control` reflects only the LAST persisted checkpoint — typically the initial install or the last manual `CHECKPOINT` call
- The WAL on disk has been written to AHEAD of pg_control's recorded checkpoint LSN
- When PGLite recycles a WAL segment (after the in-memory checkpoint advances past it), the bytes at the old (stale) pg_control LSN can be ZEROED or OVERWRITTEN

When the sidecar dies (SIGKILL or any other cause) and the next process tries to cold-start, Postgres reads pg_control, finds its recorded checkpoint LSN, attempts to read the checkpoint record at that LSN, finds invalid bytes (because the WAL location it points to was recycled while the sidecar was alive), and PANICs:

```
DEBUG:  InitPostgres
NOTICE:  database system was shut down at <ancient timestamp>
LOG:    invalid resource manager ID in checkpoint record
PANIC:  could not locate a valid checkpoint record at 0/<old-LSN>
Aborted()
```

This is **structurally identical** to the WASM Aborted() error from the 2026-05-16 SIGTERM incident. From the symptom (Aborted() at WASM init) the two bugs look identical, but the root cause is different — and so is the timing condition. The SIGTERM bug fires on every controlled stop; the SIGKILL/pg_control bug fires when (a) the sidecar has been alive long enough for the WAL to advance past pg_control's recorded LSN AND (b) the on-disk pg_control hasn't been refreshed via a manual CHECKPOINT.

**The vm-050 2026-05-18 timeline confirms:**
- 2026-05-16 15:46:59 — install-gbrain.sh wipe+reinit completed; pg_control written cleanly to disk
- 2026-05-16 → 2026-05-18 — sidecar ran for ~2 days, WAL written through, pg_control on disk NEVER updated
- 2026-05-18 16:09 — last WAL write before our intentional SIGKILL
- 2026-05-18 16:11 — `systemctl stop` with `KillSignal=SIGKILL` fired (Rule 54 happy path)
- 2026-05-18 16:11+ — restart attempt #1, restart attempt #2, ... restart counter at 271, each one hitting the same PANIC

The data dir was unrecoverable to PGLite. Both v0.35.0.0 and v0.35.8.0 panicked identically. The recovery (below) required external tooling.

##### When SIGKILL is actually safe

SIGKILL is safe for PGLite if and only if **at least one of** the following holds:

1. **pg_control was written to disk very recently** (sidecar was just started, or a manual `CHECKPOINT` was just executed). The exact safety boundary is empirically unknown — our tests confirm <60 seconds of drift is safe; production failure modes confirm 2+ hours is unsafe. Anywhere in between is untested. **Conservative reading: rely on this condition only when pg_control mtime is <1 minute old.**

2. **The data dir is about to be wiped.** install-gbrain.sh's Phase E uses this pattern: SIGKILL → wipe `~/.gbrain/brain.pglite/` → fresh init. The post-SIGKILL corruption state never gets read; whatever's on disk is irrelevant.

3. **The sidecar's WAL hasn't advanced past pg_control's checkpoint LSN.** Hard to verify externally; you'd need to read `pg_control` with `pg_controldata` and compare to the current WAL state. In practice, treat this as "unknown" and rely on condition 1 or 2.

Outside those three conditions, SIGKILL on a long-running gbrain sidecar may produce an unrecoverable data dir. The risk grows with uptime.

**Empirical evidence summary (2026-05-18):**
- Test 4 (single insert, no CHECKPOINT, SIGKILL after <1s): recovered cleanly ✓
- Test 5 (500 inserts, no CHECKPOINT, SIGKILL after ~9s): recovered cleanly ✓
- Test 6 (177,354 inserts in 60s, no CHECKPOINT, SIGKILL): recovered cleanly ✓
- **Test 17 (idle 25min stale, raw pkill -9 with no ExecStop, no auto-restart hook help): recovered cleanly in 10s ✓**
- vm-050 canary retry (~2 hours pg_control drift, SIGKILL): **UNRECOVERABLE** ✗
- vm-050 original (~48 hours pg_control drift, SIGKILL): **UNRECOVERABLE** ✗

Boundary somewhere in (25min, 2h). The 30-min CHECKPOINT cron interval is empirically validated as safe at the upper edge of the cron window — even when ExecStop is also disabled and the kill is the rawest possible (SIGKILL on idle gbrain with stale pg_control).

##### Recovery procedure (when SIGKILL has already left an unrecoverable dir)

The vm-050 2026-05-18 recovery is the reference. Use it when you observe the WASM Aborted() error from a stopped sidecar, AND verify the pg_control timestamp via `pg_controldata` is from an earlier-than-expected time.

1. **Confirm corruption is pg_control-class** (not the SIGTERM-class). Read `pg_control`:
   ```bash
   sudo apt-get install -y postgresql-17 2>&1 | tail -3   # one-time per VM
   sudo systemctl stop postgresql@17-main; sudo systemctl disable postgresql@17-main  # we don't run a postgres cluster
   /usr/lib/postgresql/17/bin/pg_controldata ~/.gbrain/brain.pglite | head -10
   ```
   - If `Database cluster state: shut down` AND `pg_control last modified` is hours/days old → this rule applies.
   - If `Database cluster state: shutting down` or any in-flight state → likely a different bug; surface to operator.

2. **Make an experimental copy** (never operate on the live dir directly):
   ```bash
   rsync -a ~/.gbrain/brain.pglite/ ~/brain-pglite-experiment/
   rm -f ~/brain-pglite-experiment/postmaster.pid
   ```

3. **Run pg_resetwal -f on the COPY**:
   ```bash
   /usr/lib/postgresql/17/bin/pg_resetwal -n ~/brain-pglite-experiment   # dry run first
   /usr/lib/postgresql/17/bin/pg_resetwal -f ~/brain-pglite-experiment   # commit
   /usr/lib/postgresql/17/bin/pg_controldata ~/brain-pglite-experiment | head -5
   # confirm: pg_control last modified is "now", checkpoint LSN is in a new segment file (...02 instead of ...01)
   ```

4. **Validate PGLite can open the reset copy** before touching the live dir:
   ```bash
   cd ~/gbrain
   timeout 60 bun -e "
     import { PGlite } from '@electric-sql/pglite';
     const db = new PGlite(process.env.HOME + '/brain-pglite-experiment');
     await db.waitReady;
     console.log('OK:', (await db.query('SELECT count(*) FROM pages')).rows);
     await db.close();
   "
   ```

5. **Promote the experiment to live**:
   ```bash
   systemctl --user stop gbrain.service && systemctl --user reset-failed gbrain.service
   mv ~/.gbrain/brain.pglite ~/.gbrain/brain.pglite.unrecoverable-$(date -u +%Y%m%dT%H%M%SZ)
   mv ~/brain-pglite-experiment ~/.gbrain/brain.pglite
   systemctl --user start gbrain.service
   # wait for /health=200
   ```

6. **Verify gbrain MCP is functional**:
   ```bash
   BEARER=$(cat ~/.gbrain/openclaw-bearer-token.txt)
   curl -sS -X POST http://127.0.0.1:3131/mcp \
     -H "Authorization: Bearer $BEARER" -H "Content-Type: application/json" \
     -H "Accept: application/json,text/event-stream" --max-time 15 \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami","arguments":{}}}'
   ```

**Data loss expectations from pg_resetwal**: any committed transactions that lived only in WAL (not yet flushed to heap pages) are lost. For a small gbrain brain with few page edits, this is typically < 1 minute of writes. For a heavy-write brain, could be larger. The trade-off vs total loss is always worth it.

**Quarantined dir** (`~/.gbrain/brain.pglite.unrecoverable-<ts>`) should be preserved on the VM for forensic purposes for at least 7 days. Delete only after confirming the recovered brain is stable.

##### Periodic CHECKPOINT cron — SHIPPED 2026-05-18 PM

**Status: deployed to all 9 edge_city VMs as of 2026-05-18 21:30 UTC.**

The pure-upstream gbrain v0.35.0.0 MCP surface does NOT expose raw SQL (the `query` tool is semantic search, not a SQL passthrough). Empirically verified 2026-05-18:

```
gbrain mcp tools/call name=query arguments={sql: "CHECKPOINT;"}
  → error: "query requires either `query` (text) or `image` (base64 bytes)"
```

To work around this, we layer a ~30 LOC patch on top of garry's unmodified gbrain source via `install-gbrain.sh` Phase C2:

- **`instaclaw/scripts/gbrain-patches/0001-add-checkpoint-mcp-tool.patch`** — adds `src/core/checkpoint-operation.ts` (new file) defining a `checkpoint` MCP admin tool that runs `engine.executeRaw('CHECKPOINT')`, plus a 2-line edit to `src/core/operations.ts` registering it. Scope: `'admin'`.
- **`instaclaw/scripts/pglite-checkpoint.sh`** — cron + ExecStop helper. Calls the new MCP tool via curl with the disk bearer. Logs to `~/.openclaw/logs/pglite-checkpoint.log`. Exit 0 always (no cron spam).
- **install-gbrain.sh Phase I** — installs the cron (`*/30 * * * *`) and the systemd ExecStop drop-in (`~/.config/systemd/user/gbrain.service.d/20-execstop-checkpoint.conf`).

Net effect: max pg_control staleness bounded to 30 min (cron interval). Controlled stops trigger a CHECKPOINT before SIGKILL via ExecStop. SIGKILL between cron ticks is still safe because the most-recent cron tick was ≤30 min ago.

**The upstream PR is still desirable** — see `instaclaw/docs/upstream/gbrain-checkpoint-mcp-tool.md` for the issue draft. Once upstream merges, the patch file becomes a no-op (Phase C2 detects already-applied) and we can retire the patch in a future cleanup. Until then, this in-tree patch is the canonical mechanism.

**Deployment proof (2026-05-18):** all 9 edge_city VMs went from pg_control ages of 47-51 hours (5 VMs) and 24 minutes (3 VMs) and "broken-after-canary" (vm-050) → all 9 at <1 minute freshness post-deployment. The May 23 bake window is now safe.

##### Banned patterns (in addition to the SIGTERM bans above)

- Restarting gbrain.service on a long-running VM "to clear caches" or "as routine maintenance" without first triggering a CHECKPOINT. With the 2026-05-18 PM CHECKPOINT cron deployed, max pg_control drift is bounded to 30 min — restart is safe as long as the most-recent cron tick succeeded. Check the most-recent entry in `~/.openclaw/logs/pglite-checkpoint.log` before restarting. If the last entry is `FAILED` or absent for >60 min, treat the VM as in a risk window: call the `checkpoint` MCP tool manually first (or use `bash ~/.openclaw/scripts/pglite-checkpoint.sh`), confirm `ok latency_ms=N` in the log, then restart. If checkpoint also fails, escalate — the sidecar is broken in some other way.
- Operating on the assumption "Rule 54 says SIGKILL is safe, so I can SIGKILL anytime." The 2026-05-18 vm-050 incident proves otherwise. Always think about pg_control freshness BEFORE SIGKILL.
- Adding a "restart gbrain to fix X" code path without first reading this section. Reconciler steps, watchdog crons, freeze flows, manifest updates — anything that calls `systemctl --user restart gbrain` or sends SIGKILL must confirm it isn't introducing a new vm-050.

##### Detection extension to the existing grep rule

When reviewing any code that touches gbrain.service or sends signals to gbrain processes, the PR description must answer:

1. How long has the sidecar typically been running when this code path fires?
2. If > 30 minutes uptime, what protects against the pg_control-staleness panic on next cold-start?
3. Does the path include a recovery hook (pg_resetwal procedure) if cold-start fails?

If the answers are "we don't know," "nothing," or "no" — the PR is incomplete. The cost of writing the answer is low; the cost of NOT writing it is another vm-050.

### Rule 55 — Marketing Copy & Launches Must Pass the Viral Playbooks

**Keyword activation (non-negotiable).** When Cooper types any of these in any terminal — reconciler, changelog, ops, edge, this one, any other:

- `/viral`
- `/launch`
- `/post`

…the terminal MUST immediately:

1. Read `instaclaw/docs/viral-copy-playbook.md` end-to-end (all 15 sections) AND `instaclaw/docs/viral-launch-playbook.md` end-to-end (all 10 numbered sections plus §11 maintenance notes). **Both, not either.** No skimming. No partial loads. The Copy Playbook owns LANGUAGE (what you write); the Launch Playbook owns MECHANICS (how you ship). Skipping the Launch Playbook on launch-class posts is the failure mode this two-doc system exists to prevent.
2. Load Copy Playbook §9 Receipts Library AND Launch Playbook §3.4 Category Library + §5.4 CTA Library into active context. Every claim must trace to a receipt; every category framing must trace to the library or be deliberately appended; every CTA destination must be in the CTA library or deliberately added.
3. Enter "copy mode" per the Copy Playbook's §0.1 protocol.
4. Ask Cooper the three setup questions (what / which account / goal).
5. Generate 3-5 hook candidates with bold claims and weapons-check scores BEFORE writing a full post.
6. Score every line of the eventual draft on §4 weapons check (invention novelty 1-10 + copy intensity 1-10; cut any line below 6/6).
7. Run Copy Playbook §10 banned-phrase scan. Any hit is a hard reject. **If the request involves shipping a launch** (product launch, partnership, token milestone, major manifest event — any creative artifact involving video or a coordinated first-hour rollout), additionally walk Launch Playbook §9 Launch Readiness Checklist. Any unchecked box delays the launch. Ship-weak is worse than ship-late — a launch that dies at 50K views burns the topic for future attempts.
8. Present the final post + a "cut notes" section listing rejected candidates and why.
9. Exit copy mode only when Cooper says `/done` or switches topics.

**Banned in copy mode (and generally):**

- Posting copy that has not been scored against the weapons check.
- Posting copy that contains §10 banned phrases (`powerful`, `seamless`, `intelligent`, `excited to announce`, `introducing`, `stay tuned`, `TL;DR`, `🚀🎉✨🔥💪`, hashtags, "we built a platform", "save time / streamline workflows", "next-gen / enterprise-grade", etc.).
- Generating any post longer than 1 tweet without an explicit bold claim in line 1 that passes the §3.1 three-question test (what / why matters / why has this never existed before).
- Voice-first iteration ("does this sound like Cooper?") before positioning-first iteration ("does this make a claim nobody else could make?").
- Skipping the §9 receipts-library citation. Every public claim must trace to a §9 entry or be explicitly flagged as aspirational.

**Cross-terminal applicability.** This rule applies to ANY terminal in the repo, not just one that normally writes copy. If a reconciler terminal sees Cooper type `/viral`, it pauses reconciler work and routes through this rule. If a changelog terminal sees `/launch`, same. The playbook contains all the context any terminal needs to deliver world-class copy without prior calibration.

**Identity-strip test.** If a draft post can be screenshotted with `@instaclaws`, `@coopwrenn`, and `instaclaw.io` removed and the copy still reads as plausibly about ANY AI agent product, the copy is generic. Reject and rewrite from §3.

**Why this rule exists.** Between 2026-05-13 and 2026-05-15, ~7 post drafts cycled through workshopping with Cooper before one landed. Every failure had the same root cause: voice-first iteration without the playbook's three-question test, weapons check, or counter-positioning. The playbook short-circuits that — expected iteration count with copy mode is **1-2**; without it, **7+**.

**Detection.** A marketing draft surfaced to Cooper that fails any of the above checks is a Rule 55 violation. Cooper can reject without explanation; the draft goes back through the checklist. Repeat violations from the same terminal suggest the playbook wasn't read — re-read from §0.

**Exit.** Cooper exits copy mode via `/done` or by switching topics. The terminal must confirm exit: "exiting copy mode. saved draft: [path]." After exit, normal terminal behavior resumes.

### Rule 56 — Never commit a migration to `migrations/` before its schema is applied to prod

`instaclaw/scripts/verify-migrations.ts` runs as the first command of `npm run build` (wired in `package.json:build`). It parses every `*.sql` under `instaclaw/supabase/migrations/`, extracts every `CREATE TABLE` and `ALTER TABLE ... ADD COLUMN` statement, queries the production Supabase for each object, and exits with code 1 if any are missing. **A migration file committed to `migrations/` is, from the moment of that commit, a hard pre-build gate** — every subsequent Vercel build of the instaclaw project will refuse to start `next build` until the prod schema catches up. This is by design (it protects against shipping app code that references columns that don't exist yet), but it has a cost: the wrong commit order takes the entire fleet's deploy pipeline offline until the schema is applied.

#### The 2026-05-16 incident

Two terminals shipped migration files to `instaclaw/supabase/migrations/` within ~30 minutes of each other, both *before* applying the SQL to production:

1. **IR's `20260516180000_freeze_v2_columns.sql`** — added 8 NULLABLE columns to `instaclaw_vms`. Idempotent (`IF NOT EXISTS`), safe to apply, but not yet applied.
2. **My `20260516200000_village_dual_channel_broadcast.sql`** — created `public.agent_positions` (NEW table) + village schema + 4 triggers. Committed during the village build-out. Not yet applied.

Result: every Vercel deploy from 16:30 UTC onward failed at the verify-migrations step with `MISSING table: agent_positions  (from 20260516200000_village_dual_channel_broadcast.sql)` (and additionally for the freeze_v2 columns). Five separate deploys hit Error status. `instaclaw.io` kept serving the last Ready build (56 minutes old), but the pipeline was frozen — any unrelated hotfix (billing webhook fix, partner-tag fix, reconciler change) committed during that window would have been blocked too.

Recovery required: (a) Cooper hand-pasting just the `CREATE TABLE agent_positions` and freeze_v2 column-adds into Supabase Studio, (b) forcing a redeploy via `vercel redeploy` (an empty commit was correctly skipped by `vercel.json:ignoreCommand` since it didn't touch `instaclaw/`). Total impact: ~1 hour of pipeline downtime, several Error-status deploys polluting the history.

This is the same shape of failure as Rule 47 (template change without manifest bump): a change committed to main that the production system isn't yet ready for. Rule 47 is about template files reaching VMs; Rule 55 is about migration files reaching the build gate.

#### Why this trap is structural, not "operator carelessness"

- `verify-migrations.ts` is BLOCKING by design — it catches the worse failure mode of "app references a column that doesn't exist." That trade-off is correct; the issue is that it gates on file presence in `migrations/`, not on a separate "ready to gate" marker.
- The Supabase CLI's `db push` workflow assumes you control timing of file-add vs. apply. Our team doesn't use `supabase db push` for production — Cooper pastes SQL into the Studio Editor. The migration files in `migrations/` exist primarily for verify-migrations and for forensic history.
- Concurrent terminals don't see each other's migrations until git syncs, so coordination is fragile. The two-terminal pile-up on 2026-05-16 wasn't unique to today — any two parallel work streams that both touch schema have the same race.

#### Required pattern

For any new migration that adds a `CREATE TABLE` or `ALTER TABLE ... ADD COLUMN` (the two statement shapes verify-migrations gates on):

1. **Write the migration to `instaclaw/supabase/pending_migrations/<timestamp>_<name>.sql`** — NOT `migrations/`. This directory is excluded from the verify-migrations scan (it scans `migrations/` only). Committing here is safe.
2. **When ready to apply**: paste the SQL into Supabase Studio against the target environment (staging first, then prod per the standard runbook). Verify success via the standard checks (table exists, column exists, RLS policy attached, etc.).
3. **THEN move the file** from `pending_migrations/` to `migrations/` in the same commit that promotes the migration. The order of operations in that commit:
   - `git mv instaclaw/supabase/pending_migrations/<file>.sql instaclaw/supabase/migrations/<file>.sql`
   - (Optionally update any companion `*.md` apply doc to reflect the apply date.)
   - Push. Verify-migrations now sees the migration; the schema is already there; PASS.
4. **Trigger/function-only migrations** (no `CREATE TABLE`, no `ALTER TABLE ... ADD COLUMN`) can go directly into `migrations/` — verify-migrations doesn't parse those object types, and the non-public schema bypass at `scripts/verify-migrations.ts:189-193` covers `CREATE FUNCTION village.X()`-style cases anyway. Document this in the file header so future maintainers don't second-guess.

#### Banned patterns

- Committing `instaclaw/supabase/migrations/<file>.sql` that contains a `CREATE TABLE` or `ALTER TABLE ... ADD COLUMN` for a table/column that doesn't exist in prod yet. Even with the file's intent fully correct, the build pipeline goes down the moment the commit lands on main.
- Pre-staging migrations in `migrations/` and "remembering to apply them later." There is no later in a multi-terminal world — someone else's unrelated commit will trigger a build before you remember, and the build will fail. The contract is: a file in `migrations/` is a promise that the schema is already in prod.
- Skipping verify-migrations to push the build through ("it's just a missing trigger function, the app doesn't reference it"). Rule 10 / Rule 23 / Rule 34 are the rules that fire when you bypass the verify-after-write discipline; this one is its build-gate counterpart. The pipeline is the canary; if it's down, that's the signal — paper over it and you'll regress to lying-DB-style drift.
- Pasting "the whole migration file" into Supabase Studio for a file that mixes new tables + triggers + functions, when only the table is needed right now. Apply piece by piece, and ensure the `migrations/` file content matches what's actually live.

#### Detection rule

PR review checklist for any change under `instaclaw/supabase/`:

1. Does the new file contain `CREATE TABLE` or `ALTER TABLE ... ADD COLUMN`? If yes:
   - Was the schema applied to prod before this PR landed on main? Answer must be **yes**, with evidence (Cooper's "applied" message, Supabase Studio screenshot, `psql` verification output).
   - If no: the file MUST be under `pending_migrations/`, not `migrations/`.
2. If the file is moving from `pending_migrations/` → `migrations/`, the PR description must include the apply-evidence (date applied, environment, who applied).
3. If multiple terminals have schema work in flight, the second-to-commit MUST rebase against the first's apply state before adding their own migration to `migrations/`.

#### Operator emergency runbook (build pipeline is down due to this)

If verify-migrations is blocking builds RIGHT NOW because a migration was committed without apply:

1. Read the migration file. Extract the minimum SQL required to satisfy verify-migrations (just the `CREATE TABLE` / `ALTER TABLE ADD COLUMN` statements — leave triggers/functions out if they have unmet dependencies).
2. Paste into Supabase Studio SQL Editor against production.
3. Run a real (non-empty) Vercel redeploy — `npx vercel redeploy <last-failed-deployment-url>` works without needing a new commit, and the rebuild now finds the schema in prod.
4. Post-recovery: file a PR moving the over-eager content out of `migrations/` and back to `pending_migrations/` if any triggers/functions weren't applied — keep the file content matched to prod reality.

The 2026-05-16 timeline above is the canonical reference for what this looks like; the agent_positions paste sequence Cooper used is in the conversation log.

### Rule 57 — Reconciler steps depending on external reachability MUST verify firewall reachability, not just local-port binding

Any reconciler step that installs or maintains a service whose value depends on being reachable from *outside the VM* (Prometheus scrapes from the monitoring VM, gateway health probes from Vercel cron, partner-API outbound calls returning, etc.) MUST verify both halves:

1. **Local-side** (process is bound, port is listening, service is active) — what almost every step already does.
2. **Network-side** (the firewall allows the expected source to reach the listener) — what stepNodeExporter did NOT do.

Without the second half, the step writes the "fixed" verdict on the basis of `ss -lntp | grep :9100` returning a binding, while ufw silently drops every external packet for the next 1–4 days until someone runs an out-of-band probe and notices.

#### The 2026-05-18 ufw-9100 incident

`stepNodeExporter` (manifest v99) was carefully built: it downloads node_exporter, writes the systemd unit, creates the dedicated user, restarts the service, and Rule-23-sentinel-verifies `port=$(ss -tln | grep ":9100 ")` before pushing to `result.fixed`. Locally correct, locally verified.

But it never touched `ufw`. The base snapshot (v79) has the `9100/tcp` allow rule baked in, so most VMs were fine. Eight VMs — provisioned from older snapshots, or where ufw got reset, or where a different code path rewrote the rule set — ended up with node_exporter listening on `*:9100` but no ufw rule. Prometheus on 66.228.43.140 got SYN-dropped at the firewall for every scrape attempt. `up{instance=…} == 0` fired VMUnreachable for 1–4 days before the IR triage caught it. The step itself had no signal that anything was wrong — its probe (`ss -tln | grep :9100`) passed every cycle.

Worse: the alerts those VMs generated (15 VMUnreachable + 15 NodeExporterDown firing in Alertmanager) drowned out the actual P1 (vm-748 disk pressure) by ~100×. Signal-to-noise collapsed to near-zero. When operators triaged from the email digest, the real incident was invisible under a wall of firewall-blocked-but-healthy VMs.

The fix shipped 2026-05-18 (manifest v103):

- **stepUfwRules** — new step at orchestrator position right after `heal-node-exporter`. Probes `sudo -n ufw status | grep -c "^9100/tcp"`. If 0, calls `sudo -n ufw allow 9100/tcp`, then re-probes (Rule 23 sentinel) before pushing `result.fixed`. Failures push to `result.warnings` (Rule 39) — monitoring-only, never block cv-bump. `NO_UFW` case (rare; vm-050-style) silently treated as `alreadyCorrect`.
- **scripts/\_coverage-ufw-9100.ts** per Rule 27 — random sample of 5 healthy + assigned VMs, parallel SSH `ufw status | grep ^9100/tcp`, pass/fail table, exit 1 on miss. Initial run found 2/5 sampled VMs missing the rule — drift was wider than the 8 IPs that fired alerts.

#### Mandatory pattern

For any reconciler step that installs / maintains a service whose value comes from a remote consumer reaching it:

1. **Local probe** (existing pattern) — port bound, service active, drop-in present, etc.
2. **Firewall verification** — confirm the relevant ALLOW rule is in the live `ufw status` output. Match by `^port/proto` to avoid false-matches on rule descriptions.
3. **If the rule is missing AND the step is responsible for it** — add it via `sudo ufw allow`, then re-probe and confirm it landed before reporting `fixed`. Same sentinel discipline as Rule 23.
4. **Failure classification per Rule 39** — for monitoring-only ports (`9100/tcp`), failures are warnings, not errors. For customer-facing ports (`18789/tcp` gateway, `8765/tcp` dispatch), failures are errors and block cv-bump.
5. **Out-of-band verification** is the only ground truth — the reachability check inside the VM is necessary but not sufficient. The coverage script (Rule 27) probes from the operator's machine over SSH, which is itself going through the firewall. Once it can SSH in, the firewall has demonstrated *some* allow path exists; out-of-band probe of the actual port (e.g., `curl http://VM:9100/metrics` from the Prometheus host) is the gold-standard validation. Coverage scripts SHOULD eventually probe in this shape; the current `ssh + ufw status` is a reasonable approximation.

#### Banned patterns

- Reconciler steps that install a network service WITHOUT a corresponding firewall-rule step in the same orchestrator chain. If the step is responsible for the service's externally-visible utility, it's responsible for the firewall path too.
- Trusting `ss -tln | grep :PORT` as proof that "the service is reachable." That's proof of LOCAL binding only — a UFW DROP rule at INPUT is invisible to `ss`.
- "Best-effort" `sudo ufw allow X || true` patterns without verify-after-add (the existing `stepDispatchServer` ufw 8765 line is exactly this anti-pattern; tracked for follow-up). The 2026-05-18 incident proved that `|| true` masks every category of failure — sudo unavailable, ufw not installed, rule rejected, firewall syntax error.
- Adding a new alerting rule for "node_exporter unreachable" without first verifying that the underlying step has a firewall path. Without that, the alert fires forever and we add a new line of noise to the inbox.

#### Detection rule

For any PR that adds a new `await stepX(...)` call in the `reconcileVM` orchestrator OR a new entry to `vm-manifest.ts:cronJobs` or `systemdOverrides` involving a network service:

1. Does the step install/maintain a service that's consumed by a remote system (Prometheus, monitoring VM, partner API, Vercel cron)? If no — skip this rule.
2. If yes — does the step verify the firewall path for the relevant port? If no — that's a Rule 57 gap.
3. Is the verification Rule-23-sentinel-shaped (re-probe live state post-add, not just trust the `ufw allow` exit code)? If no — reviewer pushes back.
4. Is there a coverage script (Rule 27) for the firewall rule? If no — file the follow-up alongside the step.

The 2026-05-18 incident produced 1–4 days of silent customer-facing noise and masked a real P1 for hours. The cost of writing the two-line firewall probe in advance is dramatically lower than the cost of incident triage and post-mortem after the fact. Reviewers should treat the absence of a network-side verifier as equivalent to the absence of a local-side verifier — both classes have produced multi-day outages.

### Rule 58 — Token regeneration MUST synchronize every consumer atomically; idempotency checks MUST validate cross-consumer match, not just presence

When any installer / reconciler step / admin script regenerates an authentication token (bearer, API key, session secret, partner credential), it MUST update EVERY downstream consumer of that token before exit. Token regeneration without consumer sync produces silent auth failures that survive multiple reconcile ticks — because the standard "is X running" idempotency checks validate token PRESENCE, not token CONSISTENCY across consumers.

Equally important: any idempotency check on a token-bearing system MUST include a cross-consumer-match assertion. A bearer that's "set" in one place but mismatched against another place looks identical to "set correctly" if you only check `[ -n "$BEARER" ]`. The check `[ "$BEARER_FROM_A" = "$BEARER_FROM_B" ]` is the load-bearing assertion.

#### The 2026-05-18 vm-050 incident

The legacy STDIO `install-gbrain.sh` (pre-2026-05-16 13:08 EDT, commit `5d69baeb` introduced the HTTP-sidecar rewrite) minted a new gbrain bearer and INSERTed it into the `access_tokens` PGLite table, but never updated `~/.openclaw/openclaw.json`'s `mcp.servers.gbrain.headers.Authorization`. vm-050 was installed by this older version on 2026-05-16 11:44 EDT — 84 minutes BEFORE Phase G (`openclaw mcp set gbrain`) was added at 13:08 EDT.

For **2.5 days** the gateway tried bearer X (from the May 15 openclaw.json setup), gbrain hashed-and-compared, returned `server_error` (because access_tokens only had bearer Y from the May 16 wipe-and-reinit). The gateway's `bundle-mcp` cycle logged "failed to start server gbrain" every ~2–15 minutes. Cooper's @timmy agent could not reach gbrain memory at all. Every Phase A idempotency check during reconcile cycles short-circuited to ALREADY_INSTALLED because the 4 invariants it checked (version, transport, service-active, port-listening) all passed — but the 5th implicit invariant (bearers match) was silently false. **The bug was invisible to every "is gbrain healthy" check** until we SIGKILL'd the sidecar during an unrelated version-bump canary and the on-disk state could no longer be papered over by the OLD sidecar's in-memory access_tokens copy.

Forensic timeline (UTC):
- 2026-05-15 23:25 — openclaw.json set with bearer X (via some manual setup; mtime preserved)
- 2026-05-16 15:44 — install-gbrain.sh (STDIO era, no Phase G) wipes brain.pglite, mints bearer Y, INSERTs into access_tokens. openclaw.json untouched.
- 2026-05-16–2026-05-18 — gateway sends X, gbrain returns server_error. `bundle-mcp failed to start gbrain` logged ~30 times.
- 2026-05-18 16:11 — Phase 2 canary SIGKILLs the sidecar. Recovery exposed the latent state.

The current installer (post-`5d69baeb`) has Phase G (`openclaw mcp set gbrain`) which writes the new bearer to openclaw.json atomically. **But** even after Phase G existed, the Phase A idempotency check still only validated 4 invariants — so a partial-completion failure (Phase E mint succeeds, Phase F or G fails) would leave the same mismatch with no self-healing path. **Closed 2026-05-18 in commit `defensive/install-gbrain-bearer-sync`:** Phase A now checks 5 invariants (including bearer match) and includes a surgical A6 recovery path that runs `openclaw config set mcp.servers.gbrain.headers.Authorization` + gateway restart without wiping the brain.

#### Mandatory pattern

For any script / reconciler step / admin tool that mints, rotates, or regenerates an authentication token:

1. **Enumerate every consumer in the diff.** Disk files, config keys, env vars, DB rows, HTTP headers — all of them. The PR description for the token-regeneration code path MUST include this enumeration. Reviewers should ask "did you check that EVERY place this token is consumed got updated?" before approving.
2. **Update every consumer in the same atomic flow.** If one consumer can't be reached (file write fails, config-set fails, DB write fails), the others should also not be updated, OR the partial state must be detected and remediated on next idempotency check. The Phase G `openclaw mcp set` pattern with verify-after-set + Rule 5 gateway-health check is the reference shape.
3. **Idempotency checks MUST include cross-consumer match.** Don't just check `[ -n "$bearer" ]`. Check `[ "$bearer_in_consumer_A" = "$bearer_in_consumer_B" ]`. The Phase A check in `install-gbrain.sh` is the reference shape: read both consumers, compare directly.
4. **Provide a surgical recovery path that doesn't wipe data.** If an idempotency check detects a mismatch on a system that otherwise looks healthy, the remediation should be the MINIMAL CORRECT FIX (just sync the consumer that's wrong) — not "wipe everything and reinstall". Wiping is correct for true corruption; mismatch alone is just data drift. Phase A6's `openclaw config set` + gateway restart (without Phase B–H) is the reference shape.
5. **Verify-after-set on every consumer.** Per Rule 10 + Rule 34: write, re-read, compare. The Phase G `verify-after-set` block and the Phase A6 `SYNCED_GW_BEARER` re-read are the reference shapes.

#### Banned patterns

- Idempotency checks that validate token PRESENCE (`[ -n "$X" ]`) but not token CONSISTENCY ACROSS CONSUMERS. Presence is necessary but not sufficient.
- Installer scripts that mint a token but don't enumerate every consumer that needs the new value. Even with good intentions, "the next reconcile will catch it" is wrong — the next reconcile uses the SAME idempotency check, sees the same false-positive, skips remediation.
- Recovery paths that wipe a database / data directory just to fix a token-mismatch problem. Wiping is a destructive op (Rule 22, Rule 30); save it for true corruption, not key drift.
- Trusting that "we set the token, so any old copies are gone." Old copies can persist in in-memory caches, RAM-only access_tokens rows, build-time-baked env vars, etc. Always cross-reference disk state on next cold-start.

#### Detection rule

When reviewing any PR that touches a token / bearer / API key / secret regeneration path:

1. Grep the diff for the new token. List every place it's written. Cross-reference against where it's consumed (run the test on a fresh VM if possible; otherwise read every callsite).
2. Find the idempotency check that gates the regeneration path. Confirm it includes a cross-consumer-match assertion. If it only checks presence, push back.
3. Trace the failure-mode tree: "what if the script crashes between consumer A's write and consumer B's write?" If the answer is "next cron tick will see consumer A's new value, B's old value, idempotency check passes because both are 'set', mismatch persists forever" — REJECT the PR until the idempotency check is strengthened.
4. Confirm a surgical recovery path exists for the mismatch state, separate from the destructive full-reinstall path. Per the Phase A6 reference pattern.

This rule complements:
- **Rule 10** (verify-after-set): focuses on a single consumer's disk-write correctness.
- **Rule 34** (DB↔disk drift): focuses on Supabase row vs on-VM file consistency for a SINGLE field.
- **Rule 58** (this rule): focuses on the multi-consumer case where one canonical value (a bearer) must appear identically in N places, and the idempotency contract must enforce that invariant explicitly.

### Rule 59 — Never defer after one failure; investigate, then ship the fix

When a task fails, problem-solve with a rollback plan in place. Only roll back after genuinely exhausting the investigation. "It failed once" is not a reason to defer — it's a reason to investigate.

**Pattern:** attempt fix with safety net → if it works, ship it → if it genuinely can't be solved after real effort, then roll back to the working version.

**The default reflex after a failed canary is "defer to post-event for safety." That reflex is wrong.** Deferring means shipping the infrastructure you couldn't validate; "post-event" means you have less scrutiny, less time, and less recovery margin. The right move is to investigate the failure root cause before concluding the upgrade path is unworkable.

**Example (2026-05-19 v0.36.x upgrade):** the gbrain version bump failed twice — once on yesterday's v0.35.8.0 canary (WASM Aborted from stale pg_control), once on this morning's v0.36.3.0 canary (1280/1536 embedding dimension mismatch). The fear-driven reading was "v0.36.x is broken, defer to post-Esmeralda." The investigation-driven reading was:

1. First failure (stale pg_control) → root cause: PGLite doesn't autocheckpoint + cron had XDG bug. Fix: cron XDG_RUNTIME_DIR export + ExecStop accept "deactivating" state. 1-line script change.
2. Second failure (dim mismatch) → root cause: v0.36.x reads `GBRAIN_EMBEDDING_DIMENSIONS` env var separately from `GBRAIN_EMBEDDING_MODEL`; without it, falls back to ZE 1280 default while writing to a 1536-dim column. Fix: add the second env var via systemd drop-in.

Both fixes were trivial once investigated. The first failure took 30 minutes to root-cause; the second took 45 minutes. Total investigation budget: ~75 minutes. The alternative (defer to post-Esmeralda) would have shipped 500 Edge attendees on:
- A cron that never actually fires (no fleet pg_control protection)
- An old gbrain version with no validated upgrade path (no ability to push security fixes during the month)

**Mandatory pattern:**

1. **Investigation has a real time budget**, not "we'll look at it eventually." Block out 60-90 min when a critical-path canary fails. Read source, check logs, hypothesize, test on a copy.
2. **Investigation requires a rollback plan**. Before investigating, document the rollback path (commit hash, recovery procedure, expected time). Knowing the rollback is real lets you investigate aggressively.
3. **Single-failure deferrals are banned**. If you find yourself writing "deferred to post-X due to canary failure" without naming the root cause, you haven't investigated yet. Either name the cause + ship a fix, or name the cause + explicitly choose deferral as the right trade-off.
4. **"It failed twice on the same VM" is not two failures — it's one failure that wasn't investigated**. The vm-050 SIGKILL canary failed twice in a row because we didn't change our approach between attempts. After the FIRST failure, we should have investigated; instead the second attempt re-triggered the same bug. The investigation-first approach would have caught both bugs (pg_control + embedding dims) in one cycle.
5. **Document what was investigated AND ruled out**, not just what was fixed. Future readers should be able to see the search you ran ("checked X, Y, Z; X was the cause; Y and Z are not relevant") so they don't re-run the same hypothesis chain on a similar bug.

**Banned patterns:**

- "Let's defer this version bump to post-event for stability." Stability requires proving you can maintain the system. Deferring an upgrade means shipping infrastructure you can't update during the event.
- "The canary failed, so the version is broken." A canary failure is a SYMPTOM. The version may or may not be the cause. Without root-cause investigation, you don't know.
- "We'll roll back and try again later." Without the investigation, "later" hits the same wall. The rollback is justified only after you understand WHY the forward path failed.
- Treating "it worked yesterday" as proof the version is fine. The vm-050 v0.35.0.0 rollback failed identically to the v0.35.8.0 forward attempt — same data dir state, same WASM Aborted. Version was a red herring.

**Detection rule:**

When reviewing any PR that says "deferred to a later milestone due to a canary failure," ask:
1. What was the root cause of the failure? (If unstated → investigate now.)
2. What did you try to fix it? List the hypotheses tested and ruled out.
3. What's the actual blocker (vs the apparent blocker)? Often the canary failure is downstream of a separate latent bug.
4. What's the cost of deferring vs investigating now? Deferral cost is rarely zero — it usually means "ship infra we can't validate."

If answers 1-3 are unclear, the PR isn't ready. Investigate first.

### Rule 60 — Migration files MUST be self-contained; never rely on the Supabase Studio prompt to enable RLS

Every `CREATE TABLE` statement in `instaclaw/supabase/migrations/` MUST be followed in the same file by `ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;` (and, where the table needs anon or authenticated access, by explicit `CREATE POLICY` statements granting that access). The Supabase Studio "Run and enable RLS" prompt is a safety net for ONE apply path — operator clicking through Studio at original creation. It is NOT a substitute for the SQL being in the file.

#### Why this rule is load-bearing

When a migration runs in production, prod state matches the operator's choices: Studio shows the prompt, the operator clicks "Run and enable RLS," prod gets RLS-on. The file looks fine to the operator because the table is correctly protected in prod. The bug is invisible until someone tries to re-run the migration on a different database — staging restore, local-dev seed, `pg_restore`, `supabase db push` via CLI, disaster recovery. Those paths DO NOT trigger the Studio prompt. The CREATE TABLE statement runs and the table ends up RLS-disabled, silently exposing every row to anon-key access via PostgREST.

This is structurally the same class of bug as Rule 56 (file-in-migrations-but-not-applied breaks the build pipeline): the file is a *promise* about how a fresh database produced from that file behaves. A promise that depends on operator-runtime-clicks is a broken promise.

#### The 2026-05-22 audit

Two tables exposed in 9 days:

**`instaclaw_oauth_signup_flows`** (created 2026-05-22): the original migration file had only `CREATE TABLE` — no `ALTER ... ENABLE RLS`. When applied via Studio, Studio's RLS warning fired ("Potential issue detected — this query creates a table without enabling Row Level Security"). Cooper clicked "Run and enable RLS." Prod was correctly RLS-on from minute zero. But the file as-shipped would have produced an RLS-off table on any non-Studio replay path. This particular table has an account-takeover primitive in its consumer route: `/api/auth/openai/signup/poll` mints a session-issuing JWT for `resolved_user_id` when `status='completed'`. An attacker with the public anon key (`NEXT_PUBLIC_SUPABASE_ANON_KEY`) could `INSERT` a fabricated completed row with `resolved_user_id=<victim>` and harvest a session for any user. RLS-on closed that primitive; RLS-off (which would have happened on any fresh-DB re-apply) would have re-opened it.

**`instaclaw_oauth_device_flows`** (created 2026-05-19): same file/prod divergence shape. Original Studio apply triggered the prompt; Cooper accepted; prod was correctly RLS-on. But the file omitted the statement. Audit via direct `pg_class` probe on 2026-05-22 confirmed prod state was clean (RLS-enabled since day one) — the file divergence had been latent for 3 days with no production exposure. Threat model on this table is narrower than signup_flows (the /poll route reads by authenticated `user_id`, not by attacker-controlled cookie, so the session-mint primitive doesn't apply) but still real: anon-key SELECT would leak in-flight `user_code` values (privacy + phishing assist); anon-key UPDATE/DELETE could DoS legitimate connect flows.

Both files were fixed on 2026-05-22 by adding `ALTER TABLE ... ENABLE ROW LEVEL SECURITY;` directly after the `CREATE TABLE` block. ALTER ENABLE is idempotent — running it on an already-RLS-enabled table is a no-op — so the fix landed safely without touching prod state. Two commits (`a5952890` for signup_flows, `49b8789d` for device_flows) record the discovery.

#### Mandatory pattern

The shape of every new table migration file:

```sql
CREATE TABLE IF NOT EXISTS public.instaclaw_<name> (
  ...columns...
);

-- Row Level Security — load-bearing for the security model.
-- Service-role bypasses RLS; anon and authenticated get full deny
-- absent explicit policies. Idempotent — no-op on re-run.
ALTER TABLE public.instaclaw_<name> ENABLE ROW LEVEL SECURITY;

-- Indexes (if any)
CREATE INDEX ...

-- Comments (if any)
COMMENT ON TABLE ...
```

For tables that genuinely need anon or authenticated access (rare — e.g., a public-read product catalog, a waitlist signup form), enable RLS AND add explicit `CREATE POLICY` statements granting the narrowest access required:

```sql
ALTER TABLE public.instaclaw_<name> ENABLE ROW LEVEL SECURITY;

CREATE POLICY "<name>_anon_read" ON public.instaclaw_<name>
  FOR SELECT TO anon USING (true);
```

Never skip ENABLE RLS to "make it easier." The default deny-all posture is the secure baseline; explicit policies are the controlled exceptions.

#### Banned patterns

- A `CREATE TABLE public.<anything>` in a migration file without a matching `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` in the same file.
- "I'll click the Studio prompt at apply time" as a substitute for SQL. The prompt only fires for Studio applies; it does not fire for `supabase db push`, `psql -f`, `pg_restore`, or any CI/automation replay path. The file must protect ALL applies, not just the original.
- "This table doesn't have PII so RLS isn't needed." That reasoning is upside-down. The cost of leaving RLS off is unbounded (any future column added to the table could be sensitive); the cost of enabling RLS is zero (service-role bypasses, our routes work unchanged). The default is RLS-on with no policies; the burden of proof is on the engineer who wants to skip it.
- Adding RLS via a separate later migration as the cleanup path. The window between table creation and the cleanup migration is a real exposure window — and if the cleanup migration is skipped on staging/replay, the exposure becomes permanent on that database. Enable RLS in the SAME migration that creates the table.
- Comment claims like "no client ever reads this table directly" as the security argument. That's a habit description, not a security guarantee — Supabase's default GRANTs to `anon` and `authenticated` make the table API-reachable regardless of whether anyone in our codebase calls it.

#### Detection rule

Reviewer checklist for any PR touching `instaclaw/supabase/migrations/`:

1. For each `CREATE TABLE public.<name>` in the diff: is there a matching `ALTER TABLE public.<name> ENABLE ROW LEVEL SECURITY` in the same file?
2. If yes: are there any policies granting anon/authenticated access? If yes, are they the narrowest needed (specific columns, specific row filters)?
3. If the PR claims "Studio's prompt accepted in prod" — that's not sufficient. The file must be self-contained.
4. If migrating an existing table whose original creation file omitted RLS: include an `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` in a CURRENT migration (idempotent in prod if already on; closes the file/prod divergence for future replays). Reference the audit-pass commit in the PR description so the forensic chain is preserved.

P1 followup (worth filing): a CI grep gate that fails the build if any migration file under `instaclaw/supabase/migrations/` contains `CREATE TABLE public.<name>` without a matching `ALTER TABLE public.<name> ENABLE ROW LEVEL SECURITY`. The rule lives in CLAUDE.md as human-enforced for now; a mechanical check would catch the next regression at PR-review time instead of at audit time.

#### Related rules

- **Rule 56** (file/prod-apply timing): governs WHEN a migration file lands in `migrations/`. Rule 60 governs WHAT must be in the file. Both are about the file being a faithful, self-contained description of prod schema.
- **Rule 19** (`.select("*")` for safety-critical reads): partial selects can hide column-grant misconfig. With RLS as the gate, column-level grants matter less; both layers together produce the defense-in-depth posture.
- **Rule 23** (sentinel-grep required templates): same "the file is the source of truth, not operator runtime choice" pattern applied to reconciler templates instead of migration SQL.

### Rule 61 — Boolean env vars MUST be validated by VALUE, not presence; silent skips on misconfig are BANNED

Any code path gated on a boolean env var (`if (process.env.X !== "true") return;` and friends) MUST log a WARN-level line WHEN the env var is set but not the canonical "true" value. Silent returns on misconfigured env vars are a class of bug that can hide for days while engineers keep building features that are silently inactive. Operator tooling (pre-bake checks, deploy scripts) MUST validate the actual VALUE of boolean env vars, not just their presence.

#### The 2026-05-22 RECONCILE_SOUL_MIGRATION_ENABLED incident

V2 SOUL.md and AGENTS.md templates were designed 2026-05-01, the reconciler step `stepMigrateSoulV2` was written + shipped 2026-05-11, and `RECONCILE_SOUL_MIGRATION_ENABLED` was supposed to flip alongside the v106 manifest bump. **It never got set in Vercel production.** From 2026-05-13 → 2026-05-22 (~9 days):

- Multiple docs explicitly noted "NOT set in Vercel" (`bake-readiness-audit-2026-05-13.md`, `canary-handoff-2026-05-13.md`, `cloud-init-implementation-map.md`)
- `snapshot-bake-v105-checklist.md:178` flagged it as "Q-C decision: flip alongside v106 deploy"
- Multiple terminals continued building V2 content (workspace-templates-v2.ts, partner content overlays, identity reorderings) on the assumption that the migration was firing
- The kill switch `if (process.env.RECONCILE_SOUL_MIGRATION_ENABLED !== "true") return;` ran on every reconcile-fleet tick (every 3 min × 9 days × ~150 VMs = ~600,000 silent returns) with zero operator signal
- Zero fleet VMs migrated to V2 templates for 9 days
- Caught only by the snapshot terminal's DP2 verification on the bake VM, which directly inspected the on-disk SOUL.md content and saw V1 markers

The same bug class would have hit if the operator HAD set the env var but with the wrong value — `echo "" | npx vercel env add RECONCILE_SOUL_MIGRATION_ENABLED production` produces an empty-string value which passes "env var is set" checks but breaks `=== "true"`. Per Rule 6, `echo` (and `<<<`) appends a trailing newline that corrupts the value; `printf` is the only safe way.

#### Mandatory pattern

For ANY code that gates on a boolean env var:

```typescript
// BANNED pattern — silent skip on any non-"true" value
if (process.env.X !== "true") return;

// REQUIRED pattern — distinguish "explicitly disabled" from "looks misconfigured"
const raw = process.env.X;
if (raw !== "true") {
  const looksMisconfigured = raw !== undefined && raw !== "false" && raw !== "0" && raw !== "no";
  if (looksMisconfigured) {
    logger.warn(
      "stepXxx SKIPPED — X is set but not 'true'. " +
        "If this is unintentional, run: " +
        "printf 'true' | npx vercel env add X production",
      {
        route: "lib/yyy",
        step: "stepXxx",
        actual: JSON.stringify(raw),
        expected: "true",
      },
    );
    result.warnings.push(`stepXxx skipped: X='${raw}' (expected 'true')`);
  }
  return;
}
```

The reference implementation is `stepMigrateSoulV2` (`lib/vm-reconcile.ts:8050+`, shipped 2026-05-22). Future feature flags should match this shape.

#### Mandatory pattern for operator tooling

Any pre-bake check, deploy gate, or env-validation utility MUST validate VALUE, not just PRESENCE, for boolean env vars. The reference implementation is `checkBooleanEnvVarValues()` in `scripts/_pre-bake-check.ts` (shipped 2026-05-22) — it iterates a typed `BOOLEAN_ENVS` spec table with each var's `requiredOnForBake` flag and rationale.

Operator semantics:

- **Unset OR explicitly disabled** (`undefined`, `""`, `"false"`, `"0"`, `"no"`): allowed if the feature is intentionally off in this context. INFO log.
- **Set to "true"**: passes. INFO log.
- **Set to ANYTHING else** (`"True"`, `"TRUE"`, `"1"`, `"yes"`, whitespace, accidental empty-string from `echo`, typos): CRITICAL fail with actionable fix line. This is the 2026-05-22 incident class — operator-intended-to-enable but got the syntax wrong.

#### Mandatory pattern for setting boolean env vars

ALWAYS use `printf` (never `echo`, never `<<<`):

```bash
# CORRECT — no trailing newline
printf 'true' | npx vercel env add VARNAME production

# WRONG — echo appends '\n' which makes value "true\n" not "true"
echo 'true' | npx vercel env add VARNAME production

# WRONG — here-string also appends '\n'
npx vercel env add VARNAME production <<< 'true'

# CATASTROPHIC — empty-string with trailing '\n' passes "set" checks, fails === "true"
echo '' | npx vercel env add VARNAME production
```

Pair with Rule 6 (no trailing newlines in env vars) — Rule 6 is the WHY, Rule 61 is the systemic gate.

#### Detection rule

For any PR that adds a new `if (process.env.X !== "true") return;` (or equivalent), code review MUST verify:

1. The bare-return path includes a WARN log for the misconfigured-but-set case (per pattern above).
2. The env var name is added to `BAKE_BOOLEAN_ENVS` in `_pre-bake-check.ts` with `requiredOnForBake: true|false` and a rationale.
3. The PR description states whether this env var is currently set in Vercel production and to what value.

For any operator running `vercel env add` on a boolean env var:

1. The command MUST use `printf 'true' | ...` (never `echo`, never `<<<`).
2. After running, the operator MUST verify via `vercel env pull` that the value is exactly `true` (4 bytes, no trailing whitespace, no newline).

#### Related rules

- **Rule 6** (no trailing newlines in env vars): the lower-level mechanism. Rule 6 explains WHY `echo` / `<<<` corrupt env values; Rule 61 enforces the systemic discipline.
- **Rule 10** (verify every config set; no `|| true` suppression): same "loud-on-misconfig" principle, applied to `openclaw config set` instead of env vars.
- **Rule 39** (distinguish critical-step failures from optional-sidecar failures): Rule 61's `result.warnings.push(...)` lands here — feature flags are optional; misconfig is observable; cv-bump still proceeds.
- **Rule 49** (partner secrets actively verified): same principle for cross-API tokens — never trust "set" alone; verify the actual value works.

### Rule 62 — Bonjour mDNS must be disabled on every cloud VM via BOTH gates (config key AND env var); single-gate fixes are partial

Every cloud VM in the fleet — pool, cloud-init, snapshot bake, manual SSH-provisioned — MUST have bonjour disabled via BOTH of these gates simultaneously:

1. **`discovery.mdns.mode=off` in `openclaw.json`** — disables OpenClaw's mDNS DISCOVERY listener (the client that scans for peer gateways).
2. **`OPENCLAW_DISABLE_BONJOUR=true` env var** in the systemd unit — disables the bonjour PLUGIN ADVERTISER (the announcer that broadcasts the gateway's own presence).

**These are TWO independent code paths in `dist/extensions/bonjour/index.js`.** Setting only one is a partial fix that looks complete but isn't. The runtime error message even says `set discovery.mdns.mode="off" or OPENCLAW_DISABLE_BONJOUR=1 to disable mDNS discovery` — empirically misleading: the discovery key alone does NOT stop the advertiser.

#### Why this rule exists — the 3-week saga

- **2026-04-30 (v71, commit `5ff04ba5`)** — Added `discovery.mdns.mode=off` to manifest configSettings after CIAO crashes on vm-435 (YouthWork) + vm-729 (Textmaxmax) during SIGTERM races. Partial fix: discovery client disabled, advertiser still running. Looked complete at the time because we weren't measuring first-message latency, only crash counts.
- **2026-05-22 (commit `4acc5280`, cloud-init only)** — vm-1019 startup bottleneck investigation revealed the advertiser was a dominant 55-90s wedge during gateway startup. Added `Environment=OPENCLAW_DISABLE_BONJOUR=true` + `daemon-reload` to cloud-init's `setup.sh §1.0.7`. The commit's own comment filed "snapshot-bake followup" so pool VMs would also get the env var. **That followup was never done.** Cloud-init VMs were protected; pool VMs (the dominant Edge-attendee provisioning path) were not.
- **2026-05-23 (v115, this commit)** — vm-1019 e2e under Cooper exposed the gap end-to-end. **Cooper's 6-minute first-message latency was 100% bonjour event-loop blockage.** The actual gpt-5.5 LLM call responded in 6.6 seconds with prompt cache hit. Telegram messages queued for 4-7 minutes because the bonjour ADVERTISER kept trying to advertise `localhost (OpenClaw)._openclaw-gw._tcp.local.` on a cloud VM with no LAN peers. It self-disables after 5 failed restart attempts (~7 min total) — by which point the user has churned. v115 adds the env var to BOTH `manifest.systemdOverrides.Environment` (covers existing assigned VMs via reconciler) AND `configureOpenClaw` (covers fresh pool VM configures immediately).

#### What breaks if removed / un-set

- First-message latency: <30 seconds → **5-7 minutes** on every fresh VM.
- `/health` response time: <10ms → **100+ seconds** (event loop blocked).
- Gateway appears healthy from every probe: `systemctl is-active` returns `active`, `openclaw_gateway_up` metric is 1, no alert fires.
- Telegram messages queue silently in memory — `[diagnostic] stuck session: state=processing age=Ns` fires only after 60+ seconds and isn't surfaced as an alert.
- User sees the agent unresponsive. Assumes the product is broken. Churn risk especially high during onboarding when the first message defines the impression.

#### Where it MUST be set (all three locations required)

1. **`lib/vm-manifest.ts:systemdOverrides.Environment`** — currently a multi-line string `"PARTNER_ID=INSTACLAW\nEnvironment=OPENCLAW_DISABLE_BONJOUR=true"` because `Record<string,string>` can't have two `Environment` keys; the `\n` is rendered verbatim by `stepSystemdUnit`'s `lines.push(${key}=${value})` and produces two physical lines after `lines.join("\n")`. Reconciler pushes this to every assigned VM on the next tick after a manifest version bump.
2. **`lib/vm-manifest.ts:configSettings["discovery.mdns.mode"] = "off"`** — covers the discovery client gate. Reconciler's `stepConfigSettings` enforces drift.
3. **`lib/ssh.ts:configureOpenClaw`** — writes `~/.config/systemd/user/openclaw-gateway.service.d/99-disable-bonjour.conf` + `daemon-reload` at configure time. Without this, fresh pool VMs would wedge on first message during the 3-minute window between `configureOpenClaw` completion and the next `reconcile-fleet` cron tick.
4. **(P1 followup)** Snapshot bake recipe — bake the drop-in into the base image so even before reconciler/configureOpenClaw runs, fresh provisions have the env var. Tracked separately.

#### Verification (do this on every snapshot bake AND after every manifest bump that touches systemdOverrides)

SSH into a freshly-provisioned VM and run:

```bash
# Gate 1: config key on disk
openclaw config get discovery.mdns.mode
# Expected: off

# Gate 2: env var in the running gateway process
GW_PID=$(pgrep -f openclaw-gateway | head -1)
cat /proc/$GW_PID/environ | tr '\0' '\n' | grep OPENCLAW_DISABLE_BONJOUR
# Expected: OPENCLAW_DISABLE_BONJOUR=true

# Gate 3: drop-in file exists
cat ~/.config/systemd/user/openclaw-gateway.service.d/99-disable-bonjour.conf
# Expected: contains Environment=OPENCLAW_DISABLE_BONJOUR=true

# Gate 4: journal is silent on bonjour AFTER gateway start
journalctl --user -u openclaw-gateway --since "5 min ago" | grep -iE "bonjour|ciao|advertiser|unannounced"
# Expected: ZERO matches. The "8 plugins: ... bonjour ..." line is fine
# (plugin is LOADED but not active); any "advertise", "unannounced",
# "restarting advertiser", or "watchdog detected" lines are bug regressions.

# Gate 5: /health is responsive
curl -sf -o /dev/null -w "%{http_code} %{time_total}s\n" --max-time 5 localhost:18789/health
# Expected: 200 in <100ms. If you see 5+ second responses, bonjour is wedging.
```

All five gates passing is the only acceptable state. Any one failing means a partial fix slipped through.

#### Banned patterns

- Setting only `discovery.mdns.mode=off` in a new VM provisioning path and claiming bonjour is "disabled." It is NOT — the advertiser is independent.
- Setting only the env var without the config key. Both gates exist for defense in depth; one without the other works today but a future OpenClaw version might tighten/relax either path.
- Trusting `systemctl is-active` or `openclaw_gateway_up` metrics to detect bonjour wedge. They CAN'T see event-loop blockage. The only reliable signal is `/health` response time (<100ms healthy; 5+ seconds = wedging) or journal grep for advertiser activity.
- "Snapshot-bake followup" as the documented fix when the operational path is still broken. Filing a followup is necessary but not sufficient — the user-facing path must also be patched immediately. The 2026-05-22 commit `4acc5280` filed the followup correctly, but the operational fix only landed in cloud-init; 3 weeks of pool VMs wedged before someone (Cooper, 2026-05-23) noticed end-to-end.
- Trusting OpenClaw's own log message `set discovery.mdns.mode="off" or OPENCLAW_DISABLE_BONJOUR=1 to disable mDNS discovery` as if either gate alone is sufficient. **Empirically wrong** for the advertiser path. The error message is misleading — both gates are required for full coverage.

#### Detection rule (PR review)

Any PR that:
- Adds a new VM provisioning code path (cloud-init, snapshot bake, manual SSH script, alternative configure) → MUST include both gates (config key + env var drop-in).
- Modifies `lib/vm-manifest.ts:systemdOverrides.Environment` → MUST preserve the `OPENCLAW_DISABLE_BONJOUR=true` line.
- Modifies `lib/ssh.ts:configureOpenClaw` → MUST preserve the `99-disable-bonjour.conf` drop-in write + `daemon-reload`.
- Modifies `lib/cloud-init-setup-sh.ts:§1.0.7` → MUST preserve the same.
- Modifies the snapshot bake recipe in CLAUDE.md → MUST include both gates in the 15-point verification checklist.

If any of these are missing, the PR is incomplete. The cost of writing the verification is two SSH commands; the cost of NOT writing it is another 3-week saga.

#### Related rules

- **Rule 6** (no trailing newlines in env vars): the lower-level mechanism for setting env vars cleanly via `printf`. Bonjour env var must be set with `printf 'true' | ...` if ever rotated via `vercel env add` (though this lives in systemd unit, not Vercel).
- **Rule 32** (`openclaw config set` exit-0 ≠ runtime applied): same "verify after write" discipline. After setting `discovery.mdns.mode`, run `openclaw config get discovery.mdns.mode` to confirm. After setting the env var drop-in, `cat /proc/$PID/environ` to confirm.
- **Rule 34** (DB↔disk drift): same "the value in one place doesn't match the value in another" pattern. Here it's manifest vs systemd vs running process — three layers, all must agree.
- **Rule 49** (partner secrets actively verified): same defense-in-depth principle. Two independent gates so a single misconfiguration doesn't bring down the system.

### Rule 63 — [PARKED 2026-05-23] Typing-keepalive patch was attempted, broke vm-1019, suspended pending further research

> **STATUS: PARKED / SUSPENDED.** The patch described below was shipped in v118 (commit `554cc581`), broke vm-1019 during E2E testing (gateway entered a SIGTERM-restart loop, Cooper's messages went unanswered for ~15 minutes), was reverted on vm-1019 from backup, and the manifest was rolled back to v119 (commit `503bf35f`) with `messages.statusReactions.enabled=false`. The `configureOpenClaw` patch block was removed from `lib/ssh.ts` in a follow-up commit. **Do NOT re-add a typing-keepalive patch without (a) Cooper's explicit approval per Rule 64, (b) a passing end-to-end test on vm-1019 that proves typing-stops-cleanly AND gateway-doesn't-crash, (c) a tested fleet-push script that handles existing VMs that lack the patch, (d) a rollback plan if the patch fails on any single VM in the fleet.**
>
> The rule body below is preserved as historical reference — it describes the patch as it was *intended* to work. The actual problem we hit, and why the work is parked:
>
> 1. **Symptom on vm-1019**: after the patch was applied + statusReactions re-enabled, Cooper sent "interesting, i think i fixed it for ya now" at 4:50 PM. The bot went silent. The gateway entered a SIGTERM-restart loop driven by `process-pending` Pass 2 retries on `health_status='configure_failed'` (separate root cause — vm.health was momentarily unhealthy and the reconciler over-corrected). The patch's `console.log` debug instrumentation was added but `TK_DEBUG_*` never appeared in the journal — every gateway-start during the loop was killed before Telegram processed a message.
> 2. **Likely deeper issue not yet validated**: the `info.kind === "final"` hook fires when the FINAL delivery completes, but other delivery paths in `bot-msflwCEW.js` (multi-chunk replies, edit-message paths, error replies) may not pass through the same hook. So even if the simple-text path clears the interval, edge cases would leak. Need to map every delivery path before re-attempting.
> 3. **What we don't know**: whether the SIGTERM-loop was caused by the patch directly, or was unrelated reconciler thrashing that happened to overlap. The patch was reverted before we could test on a stable gateway.
> 4. **Fleet exposure during the v118 window (~45 min)**: the v118 manifest re-enabled `statusReactions.enabled=true` fleet-wide, but the keepalive patch was ONLY ever applied to vm-1019 (via `configureOpenClaw` which runs at provisioning/Pass-2 retry, NOT via stepConfigSettings). So existing fleet VMs got the choppy-UX feature re-enabled WITHOUT the keepalive — strictly worse. v119 reverted statusReactions to false, restoring the v117 safe state for the fleet.
>
> **The mechanism in OpenClaw is real** (`bot-msflwCEW.js:186302` `typing: { start: sendTyping }`) and a keepalive remains the right direction. But the path forward is: (a) reproduce the choppy UX on a controlled test rig, (b) build a patch + harness that proves typing-stops-cleanly across all delivery paths, (c) prove the patch survives an openclaw reinstall + reconciler-triggered configureOpenClaw cycle, (d) only then re-introduce. None of those exist today.
>
> The lazy-Chromium-service approach (Rule 35 pattern applied to browser plugin) is a more architecturally robust alternative — it eliminates the 60s Chromium launch entirely without monkey-patching bot internals. Likely the better investment for v120+.

---

**[HISTORICAL — the rule as originally written, preserved for context. Do not act on this without re-validating per the PARKED note above.]**

OpenClaw 2026.4.26's telegram adapter (`dist/extensions/telegram/bot-msflwCEW.js`) wires the typing indicator as `typing: { start: sendTyping }` with NO `repeat`/`interval` field — `sendTyping` fires exactly once at turn start. Telegram's `sendChatAction("typing")` has a 5-second TTL. Any LLM call >5s therefore produces dead-typing-air: indicator dies, agent goes silent on the user, status reactions (👀→🤔→✍️→✅) on the user's message look like "weird stuff happening" instead of progress.

InstaClaw patches `bot-msflwCEW.js` to add a per-turn `setInterval(sendTyping, 4000)` keepalive that fires every 4 seconds, cleared when `deliver` fires with `info.kind === "final"`, with a 90-second safety timeout. End-state UX: typing stays solid through the entire turn, status emojis layer cleanly on top, response arrives, typing stops cleanly. **This patch MUST be re-applied any time OpenClaw is installed or upgraded on a VM, OR the choppy UX returns silently.**

#### Where the patch is applied

- **`configureOpenClaw` (`lib/ssh.ts`)** runs the patch as a bash block during configure (idempotent via sentinel grep, atomic via `.tmp.js + node --check + mv`, safe via `.pre-typing-keepalive-bak` backup). This covers fresh VM provisioning, reconfigures, and any flow that runs configureOpenClaw.
- **(P1 followup, to be filed)** `stepNpmPinDrift` in the reconciler should re-apply after any openclaw version bump — otherwise existing VMs that get an openclaw upgrade lose the patch until the next configureOpenClaw run (could be days).
- **Snapshot bake checklist** — bake the patch into the base image so even zero-warm pool VMs start with it. Add to the 15-point verification checklist (per Snapshot Creation Process docs).

#### Verification — the sentinel `INSTACLAW v118 typing-keepalive shim`

After ANY of: openclaw install/upgrade, fresh provision, snapshot bake, reconfigure — verify the patch with:

```bash
TARGET=~/.nvm/versions/node/v22.22.2/lib/node_modules/openclaw/dist/extensions/telegram/bot-msflwCEW.js

# Sentinel must be present exactly once
grep -c "INSTACLAW v118 typing-keepalive shim" "$TARGET"   # → 1

# Helper functions wired (TKStart: 2 occurrences, TKStop: 3)
grep -c "__instaclawTKStart" "$TARGET"                       # → 2
grep -c "__instaclawTKStop" "$TARGET"                        # → 3

# Backup exists (proof patch was applied at least once)
ls -la "$TARGET.pre-typing-keepalive-bak"
```

All four checks passing is the only acceptable state. **End-to-end smoke test:** send a Telegram message to the bot, observe typing indicator stays SOLID through the entire LLM call (no 5-second drops, no dead-air gaps). If typing drops, the patch is missing or broken.

#### Why this happens

OpenClaw upstream considers typing-indicator behavior the channel adapter's responsibility, not the dispatcher's. The dispatcher takes a `typing.start: () => Promise<void>` callback and calls it once per turn — no repeat semantics. Filing an upstream PR is on the wishlist (would close this rule), but until then the patch is our responsibility on every install.

#### Banned patterns

- Calling `npm install -g openclaw@<version>` manually on a VM and considering the upgrade "done." It wipes `bot-msflwCEW.js`, deletes the patch, silently regresses typing UX. Always follow with the patch re-apply.
- Snapshot bakes that don't verify the sentinel in step 15. The whole point of a snapshot is zero-warm latency — but if first-message UX is choppy, the warm-from-snapshot benefit is lost.
- Patch script changes (e.g., 4s → 3s interval) without also bumping the sentinel string. Idempotent grep skips the re-apply, the old patch keeps running, the change never lands.
- Disabling `messages.statusReactions.enabled` as a workaround for choppy typing. v117 was that mistake — disables a good feature instead of fixing the underlying typing-keepalive. Reverted in v118. If reactions feel weird in the future, check the keepalive first (sentinel present? typing stays solid in a fresh test?). The reactions are not the problem.

#### Detection rule

For any PR that:
- Calls `npm install` / `npm upgrade` on openclaw (anywhere in lib/ or scripts/)
- Modifies `installPinnedOpenclaw` / `upgradeOpenClaw` / `stepNpmPinDrift`
- Touches snapshot bake recipe
- Adds a new VM provisioning path

…the PR description must answer: "Does this path re-apply the typing-keepalive patch after the openclaw install? If no, name the existing path that does." Missing answer = PR incomplete. The cost is one bash block (~20 lines, mirrored from configureOpenClaw); the cost of NOT applying it is every paying customer's first impression of "the bot looks broken" when typing dies mid-turn.

#### Related rules

- **Rule 23** (sentinel-grep required templates): same "verify the in-memory/in-file content matches expected" discipline applied to a file we patch in node_modules.
- **Rule 32** (`openclaw config set` exit-0 ≠ runtime applied): the typing-keepalive lives in JS, not config, so config-level verification doesn't catch its absence. Sentinel grep is the equivalent for code patches.
- **Rule 62** (bonjour mDNS dual-gate): same "ghost state from upstream defaults harms UX" pattern. The bonjour gate is at install time; this is at use time. Both required on every fresh install.

### Rule 64 — Manifest version bumps require explicit Cooper approval; test on vm-1019 first via `openclaw config set`

`VM_MANIFEST.version` is a PRODUCTION deployment trigger. The reconciler picks up cv<MANIFEST.version VMs and pushes every change (config keys, file content, systemd units, etc.) fleet-wide within ~30 minutes. **Every paying user is exposed to every bump.** Manifest bumps are NOT a sandbox for testing — they are the publish step for verified, Cooper-approved changes.

#### The 2026-05-23 incident (4 manifest bumps in one session, v118 regressed the fleet)

Session 22-23 of the Edge Esmeralda sprint shipped manifest bumps 115 → 116 → 117 → 118 within a few hours. v118 re-enabled `messages.statusReactions.enabled=true` on the bet that the configureOpenClaw typing-keepalive patch would carry the keepalive fix fleet-wide. The bet was wrong — configureOpenClaw runs at provisioning/specific reconcile flows, NOT on every existing assigned VM. Existing fleet VMs got `statusReactions=true` via `stepConfigSettings` (which auto-fires gateway restart per Rule 32) but WITHOUT the keepalive patch on their bot-msflwCEW.js. Every paying user on those VMs immediately saw the choppy "type → silence → reaction → silence → type" UX regression.

v119 was an emergency revert. ~30 minutes of degraded UX for every paying user before the revert reached the fleet via reconciler.

#### Mandatory pattern going forward

1. **All experimental config and code changes get tested on vm-1019 FIRST via `openclaw config set <key> <value>` + restart**, NEVER via a manifest bump. vm-1019 is the canary; the manifest is the publish.
2. **Verify with Cooper on Telegram** that the change behaves as expected end-to-end.
3. **Only after Cooper explicitly says "ship it" / "approved" / "push to fleet"** do you bump `VM_MANIFEST.version` and push.
4. **The approval must be specific to the manifest bump** — a "yes, that looks good" on a vm-1019 canary is NOT approval to ship fleet-wide. The phrase must be unambiguous and recent.
5. **One change per manifest bump** (where reasonable). Bundling multiple experimental changes into a single bump amplifies blast radius when one of them regresses.
6. **Emergency reverts are the EXCEPTION** to step 3 — if a recently-shipped manifest version has regressed paying users, revert immediately. But document the revert in the PR/commit, and the next bump that "tries again" requires re-approval per step 3.

#### What "test on vm-1019 first" actually means

For a config key like `messages.statusReactions.enabled`:
```bash
# On vm-1019:
openclaw config set messages.statusReactions.enabled false
systemctl --user restart openclaw-gateway   # Rule 32: messages.* require restart
# Verify with Cooper on Telegram
```

For a file change like a patched script or template:
```bash
# scp the new file to vm-1019
scp -i /tmp/ic_ssh_key new-script.py openclaw@<vm-1019-ip>:~/.openclaw/scripts/
# Verify behavior
# Have Cooper test end-to-end
```

For a systemd unit or env var change:
```bash
# Edit the drop-in directly on vm-1019
# systemctl --user daemon-reload
# systemctl --user restart openclaw-gateway
# Verify
```

The fleet manifest only sees the change after Cooper's "ship it" — and only then via a single targeted PR with the smallest possible diff.

#### What "Cooper approval" looks like

Acceptable approval phrases (in chat, recent, unambiguous):
- "ship it"
- "push to fleet"
- "approved, push"
- "yes, bump the manifest"
- "fleet-deploy this"

NOT acceptable:
- "yeah that's better" (could be praise without ship approval)
- "good work" (praise without deploy intent)
- silence after vm-1019 test (silence ≠ approval)
- "this looks good on vm-1019" (vm-1019 verification ≠ fleet ship approval)
- A previous session's approval (must be in the current session/context, since fleet state may have changed)

When unsure, **ASK**: "vm-1019 verified. Push to fleet?" Wait for the explicit yes.

#### Banned patterns

- Bumping `VM_MANIFEST.version` immediately after editing a config key, file, or template without explicit approval. The reconciler will pick up the change within minutes and you have no path to safely revert without another bump + 30-minute fleet propagation delay.
- "Just bumping the version while I'm here" — every bump touches every paying user. There is no such thing as a free bump.
- Multiple version bumps in a single session without approval at each (today's session shipped 4 in a row, one regressed the fleet).
- Bundling experimental changes with proven changes into one bump (the proven change can't be shipped without also shipping the experimental change).
- Treating `cv` bumps as "just a number" or "cosmetic" — the reconciler's `lt(config_version, VM_MANIFEST.version)` filter is binary, and a bump moves the cutoff for every healthy assigned VM in the fleet.

#### Detection rule

For any PR diff that touches `lib/vm-manifest.ts:version`:
1. Was vm-1019 explicitly tested with the change first via `openclaw config set` or equivalent file edit?
2. Did Cooper explicitly say "ship it" / "push to fleet" / equivalent in the current session AFTER the vm-1019 test?
3. Is the diff a SINGLE coherent change (config key, manifest field, sentinel addition) rather than a batch?
4. Does the commit message document the vm-1019 test result + the approval phrase + timestamp?

If any answer is no → the manifest bump is unauthorized. Revert.

#### Companion: the "test on vm-1019" muscle

vm-1019 is Cooper's canary VM. It is the ONLY safe place to land experimental changes without paying-user blast radius. Every config experiment, every patch trial, every "let me see if this works" — all go on vm-1019 first via local `openclaw config set` / scp / SSH edits. The manifest only sees changes that have already proven themselves end-to-end on vm-1019 AND received Cooper's specific ship approval.

#### Related rules

- **Rule 10** (verify every config set; no `|| true`-suppress): same "loud-on-failure" discipline applied to operator habits. Push-without-approval is the manifest-bump equivalent of `|| true`.
- **Rule 32** (`openclaw config set` exit-0 ≠ runtime applied): the reason "test on vm-1019" requires a gateway restart for `messages.*` keys — otherwise the local test result isn't reliable.
- **Rule 47** (continuous reconciliation, not version-gated): the reason a manifest bump propagates to every VM — there is no opt-out for paying users.
- **Rule 49** (partner secrets actively verified): same principle (verify the actual value works) applied to manifest config changes. "It compiles" is not "it works on a real VM."

### Rule 65 — [PARTIALLY SHIPPED 2026-05-24, manifest v120] OpenClaw 2026.5.20 readiness work — strip-thinking compatibility, TasksMax cap removed, typing keys codified; OPENCLAW_PINNED_VERSION bump deferred until snapshot bake

**Status as of 2026-05-24 commit:** Three of four readiness fixes shipped via manifest v120 (commit pending). vm-1019 remains the only VM on `openclaw@2026.5.20`; the rest of the fleet stays on `2026.4.26`. `OPENCLAW_PINNED_VERSION` in `lib/ssh.ts` was DELIBERATELY NOT bumped — bumping it would have triggered `stepNpmPinDrift` to upgrade every healthy + assigned VM on the next reconcile cycle, forcing an unvalidated fleet-wide rollout. The version bump lands ONLY after Cooper bakes the next snapshot at 2026.5.20 (post-Edge Esmeralda, June 2+ per Rule 64 approval flow).

**The decision Cooper made (Option A, 2026-05-24):** ship the strip-thinking patch + cgroup fix + typing keys to the manifest now, even though only one VM is currently on 2026.5.20. The patch is benign on 2026.4.26 (the lock-race it prevents doesn't exist there; the 120-second mtime skip just defers compaction during active edits — bounded by existing 4MB+ session safety nets). Pre-patching the fleet means future snapshot bakes inherit the compatibility automatically, and vm-1019 auto-recovers from the file-drift cron revert (see "File-drift bypassed quarantine" below).

#### Why the canary mattered (original motivation, preserved)

Issue [#79681](https://github.com/openclaw/openclaw/issues/79681) — *"Telegram typing indicator no longer stays visible during active agent work"* — is still open upstream. We diagnosed our exact symptom via diag patches (see task #161): `setInterval(3000)` for typing keepalive was firing 14.6s late and `sendTyping` HTTP responses were taking 71 seconds to complete during the Anthropic TTFB window. Root cause: single-threaded Node.js event loop starvation during agent prep. Three adjacent upstream issues — [#73428](https://github.com/openclaw/openclaw/issues/73428) (severe chat latency on 2026.4.26 specifically), [#75656](https://github.com/openclaw/openclaw/issues/75656) (synchronous transcript reads block event loop), [#75984](https://github.com/openclaw/openclaw/issues/75984) (90s event loop blocking during agent run startup) — are **CLOSED** in 2026.5.5+. Bumping to 2026.5.20 picks them up. Even though #79681 itself isn't fixed, the adjacent fixes reduce event-loop saturation enough that the keepalive ticks fire on schedule. Cooper's qualitative test ("super smooth") confirmed sub-minute warm-cache and no perceptible typing dead-air.

#### Canary timeline (UTC)

| Time | Event |
|---|---|
| 2026-05-23 11:18:38 | vm-1019 quarantined via `instaclaw_vms.reconcile_quarantined_at` (manual Supabase PATCH; **not** `_quarantine-vm.ts` which only sets `operator_quarantined_at`). Prevents `stepNpmPinDrift` from downgrading. |
| 2026-05-23 23:20 | `npm install -g openclaw@2026.5.20` succeeds. Pre-existing backup at `/home/openclaw/openclaw-canary-backup-2026.4.26.tar.gz` (61MB, sha256 `682deb6ca8e2f8aa8d2d588762f7236b7140a07dccc4cc3809d3c1a1e4219eb5`) verified restorable via test-extract + `cmp` byte-identical against live. |
| 2026-05-23 23:22 | Gateway `[gateway] ready`, /health=200. 8/8 canary health checks PASS. Cooper: "super smooth". Soak begins. |
| 2026-05-24 01:13–01:28 | Cooper sends ~10 messages to @timmy. **Multiple "Something went wrong" failures** — nearly every other message. |
| 2026-05-24 01:35 | Investigation begins. Agent's self-diagnosis ("wrong shell pattern, heredoc stealing stdin") later identified as Rule 29 hallucination — the agent rationalized failures it couldn't see the real cause of. |
| 2026-05-24 01:50 | Strip-thinking patch deployed by hand to vm-1019. Sentinel `STRIP_THINKING_v2026_5_20_COMPAT_v1` present in `~/.openclaw/scripts/strip-thinking.py`. Backup preserved at `.pre-v2026.5.20-compat.bak`. |
| 2026-05-24 02:24 | Gateway restarted with patched strip-thinking. Zero session-takeover errors in subsequent smoke tests. |
| 2026-05-24 02:45:56 | **`cron/file-drift` REVERTED the patched strip-thinking.py back to the old manifest version.** Sentinel count drops to 0. Quarantine flag did NOT protect — file-drift bypasses it (see "Why quarantine didn't protect file-drift" below). |
| 2026-05-24 02:46:02 | One `EmbeddedAttemptSessionTakeoverError` fires on session `2026-05-24T02-45-52` — the exact race the patch was meant to prevent, reproduced 6 seconds after the file revert. |
| 2026-05-24 02:46 – 12:50 | **10 hours, zero further errors.** Gateway uptime since 02:24, NRestarts=0. The lock-race only fires when a session is being actively modified by OpenClaw at the precise strip-thinking moment; Cooper was idle. |
| 2026-05-24 12:50 | Audit script + investigation confirm file-drift revert. Manifest v120 staged with the codified fixes. Cooper approves Option A. |

#### The three fixes codified in manifest v120 (this commit)

**FIX 1 — strip-thinking.py active-session guard.** `lib/ssh.ts:STRIP_THINKING_SCRIPT` gets a 15-line Python guard inserted into the main loop, gated by `STRIP_THINKING_ACTIVE_THRESHOLD_SEC = 120`:

```python
mtime_age_sec = time.time() - os.path.getmtime(jsonl_file)
if mtime_age_sec < STRIP_THINKING_ACTIVE_THRESHOLD_SEC:
    continue  # skip — agent turn likely in flight
```

Sentinels `STRIP_THINKING_v2026_5_20_COMPAT_v1` + `SKIP_ACTIVE_SESSION:` added to `vm-manifest.ts:files[].requiredSentinels` so Rule 23 catches any stale-cache regression. Rationale: 2026.5.20 added `EmbeddedAttemptSessionTakeoverError` (`selection-BmjEdnnA.js:7883`) — fatal to the turn when an external writer modifies the session jsonl during the embedded prompt lock window. Our strip-thinking cron runs every minute and modifies sessions (Rule 22 trim, Rule 30 compaction, Layer 3 extract). Skipping sessions modified in the last 120 seconds defers compaction to an idle window — safe because OpenClaw 2026.5.20's native compaction (`mode=safeguard, maxActiveTranscriptBytes=150000, recentTurnsPreserve=10, qualityGuard, memoryFlush=8000`) handles the same work as an owned writer with no self-takeover risk.

**FIX 2 — TasksMax cgroup cap REMOVED.** `vm-manifest.ts:systemdOverrides["TasksMax"]` changed from `"120"` to `"infinity"`. Same change applied to `lib/ssh.ts:configureOpenClaw`'s legacy override-write path (line 8377). Rationale: cooper challenged "who set 120?" during the investigation. Answer: WE did, in our own systemd override. OpenClaw upstream ships nothing for TasksMax. The 120 limit was a 2026-05-05 v86 manifest bump from a default of 75 ("v86 — TasksMax 75 → 120" in the changelog). It was sized for the pre-gbrain workload (Node + Chromium + browser auto + telegram + heartbeat). With gbrain + 2026.5.20's more aggressive subprocess use (Chromium MCP burst, compaction-safeguard side processes), 120 tasks no longer fits — `spawn /bin/sh EAGAIN` errors fired on vm-1019 during multi-tool turns. Setting to `infinity` removes the artificial cap; the kernel's per-cgroup pids.max default (~32K) is the real ceiling. Memory pressure (cgroup MemoryMax=3500M) remains the load-bearing safety net.

**FIX 3 — Typing config keys codified.** `vm-manifest.ts:configSettings` gets two new entries:

```
"agents.defaults.typingMode": "instant",
"agents.defaults.typingIntervalSeconds": "3",
```

These were applied per-VM on vm-1019 during the earlier task #161 diagnostic. They tighten the typing keepalive cadence (closer to Telegram's 5-second `sendChatAction` TTL boundary). Now they're fleet-wide defaults. Because both are under `agents.defaults.*` and that namespace is closure-captured at agent init (Rule 32, **not** hot-reloadable), `RESTART_REQUIRED_CONFIG_PREFIXES` in `lib/vm-reconcile.ts` gets `"agents.defaults."` added — so `stepConfigSettings` triggers `gatewayRestartNeeded=true` and the orchestrator's Step 9 picks up the change via a verified gateway restart.

**FIX 4 (deferred to snapshot bake) — `OPENCLAW_PINNED_VERSION` bump.** `lib/ssh.ts:97` stays at `"2026.4.26"`. Bumping to `"2026.5.20"` in this commit would cause every reconcile-fleet cron tick to detect drift on every VM via `stepNpmPinDrift` and force an `npm install -g openclaw@2026.5.20`. Without the snapshot baked at the new version, every freshly-provisioned VM still gets 2026.4.26 from the Linode image, then immediately gets npm-upgraded by the reconciler — extra wall time, extra failure modes, no proven validation across the fleet. The bump lands as part of the snapshot bake PR, with a documented per-wave rollout schedule. Per Rule 64, requires explicit Cooper approval at bump time.

#### The theories I tested and why each was wrong

The 01:13-01:28 UTC failure cascade triggered four theories before the real cause was found. Documenting because the failure pattern (intermittent "Something went wrong", every other message) is generic enough that future operators will hit similar shapes.

**Theory 1 (WRONG): `compaction-safeguard` is breaking auth on every message.** 2026.5.20 introduces `[compaction-safeguard]` log lines and a more aggressive native compaction. I hypothesized the safeguard was triggering between message processing and OpenAI's auth check, somehow invalidating headers mid-flight. **Cooper pushed back**: *"OpenClaw is literally owned by OpenAI. If compaction-safeguard was actually breaking OAuth auth on every message, OpenAI's own user base would be on fire."* Theory abandoned in ~3 minutes. Lesson: when a hypothesis would imply a fleet-wide outage for a much larger upstream user base, that hypothesis is almost certainly wrong.

**Theory 2 (WRONG): Missing `ChatGPT-Account-Id` header on requests to chatgpt.com.** I noticed 2026.5.20's OAuth path includes this header in some code paths and not others. Hypothesized the request was being dropped by ChatGPT backend because the header was missing for OAuth profile shape. **Disproved by `curl` against `chatgpt.com/backend-api/codex/responses`** with the bearer from vm-1019's `auth-profiles.json` — got HTTP 200 with a valid streaming response. Token was valid; ChatGPT was reachable; the header presence/absence wasn't the issue.

**Theory 3 (WRONG): Originator header version mismatch.** 2026.5.20 changed the `originator` header from `codex_cli_rs` to `openclaw-2026.5.20`. Hypothesized ChatGPT backend rejected requests with the new originator string because the API version pinning had drifted. **Disproved by the same curl test**: a request with `originator: openclaw-2026.5.20` succeeded. Same status. Theory dead.

**Theory 4 (WRONG): JWT validation logic regression.** 2026.5.20's selection module includes a new `validateJWT` flow. Hypothesized our OAuth tokens were getting rejected due to stricter exp/nbf checks. **Disproved by decoding the JWT** — `exp` was 2026-08-21, well into the future. Token shape was valid per the new validator's regex. Theory dead.

Cooper's intervention after theory 4: *"we're three theories deep and still not 100% sure. stop theorizing and PROVE IT."* Then: *"STOP the OAuth investigation. the agent itself just told Cooper the real issue: 'spawn /bin/sh EAGAIN'"*. The agent had been reporting EAGAIN in the journal the whole time; I was looking at OAuth code because the user-facing error said "Something went wrong" and OAuth was the easy thing to grep.

**The real cause (PROVEN):** TasksMax=120 cgroup throttle. `spawn /bin/sh EAGAIN` is the kernel's response to `fork()` when the cgroup is at its `pids.max` limit. 2026.5.20 + gbrain + Chromium MCP + telegram + browser auto adds up to ~115-118 tasks under load; one Chromium MCP burst pushes past 120; fork fails; the in-flight Telegram turn dies with a generic "Something went wrong" because the spawned shell never returned. **Evidence**: 13 EAGAIN occurrences in the journal between 01:13-02:24 UTC, ZERO after the TasksMax=infinity restart at 02:24. Cooper's instinct ("there's a deterministic cause") was right; my theories were noise.

Additional false signal: the agent's post-recovery self-diagnosis ("wrong shell pattern, wrong response key, heredoc that stole stdin from curl, causing a broken pipe") was a Rule 29 hallucination. The agent couldn't see the EAGAIN error directly in its tools — it post-rationalized a plausible-sounding explanation. I almost wasted hours chasing the heredoc theory before Cooper noticed the journal evidence and pointed me at the right signal.

#### What we proved with evidence

| Claim | Evidence |
|---|---|
| OAuth tokens were valid throughout the incident | `curl` against `chatgpt.com/backend-api/codex/responses` returned HTTP 200 with the same bearer that was supposedly failing in-app. Logged in the conversation transcript. |
| `compaction-safeguard` is not the cause of the user-facing errors | Same curl test passed; ChatGPT backend never complained about request shape. Adjacent: OpenAI's own user base would have noticed a fleet-wide regression of this size. |
| `EmbeddedAttemptSessionTakeoverError` is a NEW class in 2026.5.20 | `grep -rn EmbeddedAttemptSessionTakeoverError` against our preserved 2026.4.26 backup tarball returns ZERO matches. Same grep against the live 2026.5.20 dist finds it at `selection-BmjEdnnA.js:7883`. Class introduced in this version. |
| strip-thinking.py modifies session jsonls (the writer that races the lock) | Smoke test: `touch ~/.openclaw/agents/main/sessions/<file>.jsonl && python3 ~/.openclaw/scripts/strip-thinking.py` produced a write to the same file within the run. Confirmed by mtime diff. |
| TasksMax=120 was self-imposed, not from upstream | `grep -rn "TasksMax" $(npm root -g)/openclaw/dist/` returns nothing. Our manifest v86 (2026-05-05) is the origin: `"v86 — TasksMax 75 → 120"`. |
| `spawn /bin/sh EAGAIN` correlates with task-count saturation | 13 EAGAIN events in journal during 01:13-02:24 UTC. `cat /proc/<pid>/cgroup` → `/user.slice/user-1000.slice/...` mapped to `cgget -r pids.current` showed 115-119 tasks. After TasksMax=infinity restart: 0 EAGAIN events in subsequent hours. |
| File-drift cron reverts manual file edits regardless of quarantine | `grep -n "quarantined" app/api/cron/file-drift/route.ts` returns nothing — no filter against `reconcile_quarantined_at`. vm-1019's strip-thinking.py mtime went from 01:50:00 (our manual patch) to 02:45:56 UTC (file-drift overwrite); sentinel count: 1 → 0. |
| The race the strip-thinking patch prevents is REAL | One `EmbeddedAttemptSessionTakeoverError` fired at 02:46:02 UTC — six seconds after the file-drift revert at 02:45:56 — on session `2026-05-24T02-45-52-104Z`. The 50-second window between revert and the next gateway turn was enough for strip-thinking's per-minute cron to race the lock once. |
| The race is BOUNDED in practice | 10 hours after the revert, zero further session-takeover errors. The race requires concurrent active edit, not just session presence. Idle VMs are safe. |
| Gateway has been stable since the TasksMax fix | `ActiveEnterTimestamp: 2026-05-24 02:24:25 UTC`, `NRestarts: 0` — gateway has not crashed once in ~10 hours of post-fix runtime. |

#### Why quarantine didn't protect file-drift

`reconcile_quarantined_at` is checked by `app/api/cron/reconcile-fleet/route.ts` (the cv-stale loop that owns `stepNpmPinDrift`). It is NOT checked by `app/api/cron/file-drift/route.ts` (the continuous content reconciliation cron — Rule 47). file-drift runs `stepFiles` every 5 min on every healthy + assigned VM regardless of cv, with no quarantine filter. So while quarantine correctly prevented our 2026.5.20 install from being downgraded to 2026.4.26 (the original goal), it did NOT prevent file-drift from rewriting our manually-deployed strip-thinking patch back to the manifest version.

This is a **gap in the quarantine mechanism**, but for the canary use case it turned out to be a feature: file-drift will now pick up the NEW patched strip-thinking.py from the v120 manifest commit and deliver it to vm-1019 within ~5 minutes of Vercel deploy, auto-recovering the manual fix without operator intervention. P1 follow-up: decide whether to extend quarantine to file-drift (would have allowed our manual patch to persist through the night, at the cost of also blocking legitimate fleet patches from reaching the quarantined VM).

#### Fleet risk analysis for the v120 commit

The manifest bump propagates through TWO cron paths:

1. **`reconcile-fleet`** (every 3 min, filters `cv < MANIFEST.version`): all 156 healthy + assigned VMs at cv=119 re-enter the queue, run all reconciler steps, end up at cv=120. Per `CONFIGURE_AUDIT_BATCH_SIZE=3` with 3-min cadence, the cohort drains in ~2-3h. Each VM gets exactly one verified gateway restart (`stepConfigSettings` detects the two new `agents.defaults.*` keys → triggers `gatewayRestartNeeded=true` per Rule 32). vm-1019 is QUARANTINED so this path does NOT touch it.

2. **`file-drift`** (every 5 min, no version gate): all healthy + assigned VMs (incl. vm-1019, since file-drift bypasses quarantine) get `stepFiles` runs against the new manifest. `strip-thinking.py` content drift detected on every VM; the new sentinel-guarded version (Rule 23 protected) gets atomic-written. No service restart from this path. Full fleet pickup within ~5 min of Vercel deploy.

**Behavioral changes per VM cohort:**

- **vm-1019 (1 VM, on 2026.5.20):** strip-thinking patch returns within 5 min. TasksMax=infinity remains (we set it manually earlier; manifest matches). Typing keys remain (already per-VM applied). Net effect: state stays where it currently is; the manual fixes become codified.
- **155 fleet VMs (on 2026.4.26):** strip-thinking patch lands within 5 min. TasksMax=120 → infinity via `stepSystemdUnit` over the next 2-3h. Typing keys land via `stepConfigSettings` over the next 2-3h. Each VM gets one verified gateway restart during cv-bump (Rule 32 path), with `stepGatewayRestart` health verify per Rule 5.
- **120-second mtime guard on 2026.4.26:** the guard is functionally inert because 2026.4.26 doesn't have the `EmbeddedAttemptSessionTakeoverError` class. The side effect is that sessions modified within the last 120s SKIP compaction on the next strip-thinking tick. In practice sessions go quiet between user turns (>120s is common during long Anthropic responses, between conversations, while user is away), so the deferral is brief. Worst case: a session that's continuously edited for >5 min could grow past the 200KB threshold without immediate compaction — bounded by the existing 4MB+ session circuit breakers + OpenClaw's own runtime safety nets.

**Failure modes considered and accepted:**

- **Fleet-wide gateway restart wave (155 VMs × ~30s each over 2-3h).** Spread across cohorts of 3 via `CONFIGURE_AUDIT_BATCH_SIZE` — never more than 3 gateways restarting simultaneously. Customer-visible impact: a single in-flight Telegram turn during the restart window will fail with the standard retry behavior. Same shape as any previous manifest bump (v115 through v119).
- **TasksMax change requires daemon-reload, which already happens in `stepSystemdUnit`.** Confirmed: the step writes the override.conf and calls `systemctl --user daemon-reload` before restarting the gateway. No additional reload step needed.
- **Strip-thinking compaction deferral could allow session bloat on heavily-active 2026.4.26 VMs.** Mitigation: 120s is short relative to typical user behavior. If this becomes a problem, drop the threshold to 60s or 30s in a follow-up.

**Failure modes NOT accepted (would block commit):**

- **Forced fleet-wide OpenClaw upgrade.** Solved by NOT bumping `OPENCLAW_PINNED_VERSION`. `stepNpmPinDrift` continues to pin everyone at 2026.4.26 except vm-1019 (quarantined). Manifest v120 changes only TasksMax, typing keys, strip-thinking content, and `RESTART_REQUIRED_CONFIG_PREFIXES`.
- **vm-1019 downgraded to 2026.4.26 by the reconcile-fleet path.** Solved by `reconcile_quarantined_at` (set 2026-05-23 11:18:38 UTC). Confirmed: reconcile-fleet route filters quarantined VMs out of the candidate query.

#### Pre-bake audit gate (the `_audit-canary-vs-manifest.ts` discipline)

A new script at `scripts/_audit-canary-vs-manifest.ts` (codified tonight) is the mandatory pre-bake gate for any future canary → snapshot transition. It probes a target VM and reports drift across: configSettings, systemd overrides, cron entries, installed package versions, requiredSentinels, cgroup TasksMax limits. A `PER_VM_EXCLUSIONS` set whitelists per-VM user prefs that don't belong in the manifest (like `agents.defaults.model.primary`, which users override via `/use sonnet` etc.).

Post-commit, the audit script reports ONLY the 2 deferred openclaw version findings (manifest 2026.4.26 vs vm-1019 2026.5.20) — proving the codification captured everything else. Any other finding would indicate a gap. The script is the answer to "did we miss anything tonight?" for any future canary cycle.

#### What's still pending

1. **Snapshot bake at 2026.5.20.** Cooper's call after additional vm-1019 soak. Post-Edge (June 2+) per Rule 64 approval. Will include the `OPENCLAW_PINNED_VERSION` bump in `lib/ssh.ts` + a per-wave fleet rollout plan per the OpenClaw Upgrade Playbook.

2. **Quarantine extension to file-drift.** P1 follow-up: decide whether to add `not(reconcile_quarantined_at IS NOT NULL)` filter to the file-drift candidate query. Pros: manual operator patches persist. Cons: legitimate fleet patches (security fixes, Rule 22-class corrections) can't reach quarantined VMs.

3. **Telegram 100-command cap.** 2026.5.20 enforces Telegram's `setMyCommands` 100-command limit; we have 118. Dropped commands still work when typed; only the menu autocomplete is missing them. Fix path: either trim to 100 or use per-scope command lists (`setMyCommands` supports separate 100-cmd lists per scope: default, all_group_chats, all_chat_administrators, chat_member, per-language). Fleet-wide change; deferred until snapshot bake decision.

4. **Cosmetic schema warnings on 2026.5.20.** `plugins.entries.brave` and `plugins.entries.acpx` are pre-existing stale config entries flagged by 2026.5.20's stricter schema. Not blockers (Brave Search still functions via env var autodetect), but should be cleaned up in the same PR that bumps OPENCLAW_PINNED_VERSION.

5. **Eventual upstream fix for #79681.** The typing-keepalive issue is still open. Once OpenClaw ships a real fix, our `agents.defaults.typingMode=instant` workaround can probably be removed.

#### Rollback paths (preserved)

**Rollback strip-thinking patch only** (if the 120s mtime guard introduces unforeseen issues on 2026.4.26):

```bash
ssh -i /tmp/ic_ssh_key openclaw@<VM_IP> '
  cp ~/.openclaw/scripts/strip-thinking.py.pre-v2026.5.20-compat.bak ~/.openclaw/scripts/strip-thinking.py
'
```

Then revert the `STRIP_THINKING_SCRIPT` change in `lib/ssh.ts` and the two sentinels in `vm-manifest.ts:requiredSentinels`, bump manifest version, deploy. file-drift will push the rolled-back version to the fleet within ~5 min.

**Rollback vm-1019 to 2026.4.26** (if 2026.5.20 turns out to have a deeper regression):

```bash
ssh -i /tmp/ic_ssh_key openclaw@162.216.16.231 '
systemctl --user stop openclaw-gateway
rm -rf /home/openclaw/.nvm/versions/node/v22.22.2/lib/node_modules/openclaw
rm -f  /home/openclaw/.nvm/versions/node/v22.22.2/bin/openclaw
tar xzf /home/openclaw/openclaw-canary-backup-2026.4.26.tar.gz -C /
systemctl --user start openclaw-gateway
sleep 5
systemctl --user is-active openclaw-gateway
curl -sf -o /dev/null -w "/health=%{http_code}\n" --max-time 5 localhost:18789/health
source ~/.nvm/nvm.sh && openclaw --version'
```

Then clear the quarantine: `npx tsx scripts/_unquarantine-vm.ts instaclaw-vm-1019` (or PATCH `reconcile_quarantined_at: null`). After clearing, the next reconcile-fleet tick will `stepNpmPinDrift` vm-1019 back to whatever `OPENCLAW_PINNED_VERSION` says (currently 2026.4.26, so no-op — but matters if the pin was bumped in the meantime).

**Rollback the entire manifest v120 bump:**

```bash
git revert <commit-sha>  # the v120 commit
git push origin main
```

Reconciler picks up v119 manifest on next deploy. File-drift writes the old strip-thinking back. `stepSystemdUnit` rewrites TasksMax back to 120. `stepConfigSettings` removes the typing keys.

**Backup retention:** keep `/home/openclaw/openclaw-canary-backup-2026.4.26.tar.gz` on vm-1019 until the snapshot bake decision is made AND (if fleet upgrades to 2026.5.20) a new 2026.5.20 snapshot is verified working on a paying-customer VM. Estimated retention: 1-2 weeks post-decision.

#### Banned patterns during the remaining soak

- Bumping `OPENCLAW_PINNED_VERSION` in `lib/ssh.ts` without Cooper's explicit Rule 64 approval AND a baked 2026.5.20 snapshot. The bump alone forces fleet-wide npm upgrade with no validated rollout plan.
- Clearing `reconcile_quarantined_at` on vm-1019 before the snapshot decision. Even if a reconciler auto-quarantine condition fires, do NOT clear — that re-includes vm-1019 in the cv-stale candidate query and `stepNpmPinDrift` immediately downgrades it.
- Deleting the `/home/openclaw/openclaw-canary-backup-2026.4.26.tar.gz` tarball on vm-1019. It's the only paste-ready rollback path until the snapshot decision is made.
- Trimming the 118 → 100 Telegram commands list before the snapshot bake decision. That's a fleet-wide manifest change; the dropped commands still work when typed, just not in autocomplete.
- Skipping the `_audit-canary-vs-manifest.ts` run on any future canary cycle. The script is the answer to "did we miss anything?" — running it catches gaps before they reach the fleet.

#### Detection rule (post-shipped state)

Any PR that touches `lib/ssh.ts:OPENCLAW_PINNED_VERSION` or `lib/ssh.ts:configureOpenClaw` (TasksMax-related blocks) or `lib/vm-manifest.ts:STRIP_THINKING_SCRIPT`-consuming entries must state in the description:

1. Does this change require a snapshot rebake? (If yes, name the rebake PR.)
2. Has the change been validated on a 2026.5.20 canary? (If yes, name the canary VM + soak duration.)
3. Has `_audit-canary-vs-manifest.ts` been run against the canary VM post-change? (If yes, attach the output.)

If any answer is "no" or "TBD," the PR is incomplete. The cost of running the audit is ~30 seconds; the cost of NOT running it is another 02:45:56 UTC file-drift surprise.

#### Related rules

- **Rule 22 / Rule 30** (never destructively modify session state): the strip-thinking 120s guard is in service of these. The guard skips writes to active sessions, preserving the agent's in-flight context.
- **Rule 23** (sentinel-guarded templates): the two new sentinels (`STRIP_THINKING_v2026_5_20_COMPAT_v1`, `SKIP_ACTIVE_SESSION:`) close the stale-module-cache regression class for this specific patch.
- **Rule 29** (agents hallucinate diagnoses): the "wrong shell pattern / heredoc stealing stdin" self-diagnosis from the vm-1019 agent is the cautionary tale that almost cost me hours of investigation time.
- **Rule 32** (some config keys require restart): `agents.defaults.*` added to `RESTART_REQUIRED_CONFIG_PREFIXES` because typing keys are closure-captured at agent init.
- **Rule 47** (continuous reconciliation, not version-gated): explains why file-drift overwrote our manual patch at 02:45 UTC — and also why the v120 commit will deliver the codified patch to the fleet within ~5 min.
- **Rule 64** (manifest version bumps require explicit Cooper approval; test on vm-1019 first): the v120 bump itself satisfied this rule (Cooper approved Option A after seeing the diff). The DIFF 1 OPENCLAW_PINNED_VERSION bump is DEFERRED until the snapshot bake PR re-invokes Rule 64.

### Rule 66 — Every InstaClaw agent gets BOTH a primary (Bankr) AND a backup (Coinbase CDP) wallet; the backup is non-negotiable

Every assigned VM must have BOTH `bankr_*` columns AND `cdp_wallet_id` + `cdp_wallet_address` populated, AND the corresponding `.env` lines (`BANKR_WALLET_ADDRESS`, `BANKR_API_KEY`, `CDP_WALLET_ADDRESS`) written on the VM. CDP serves as the receive-only EVM fallback when Bankr is unavailable. The CDP wallet is a Coinbase Developer Platform MPC-managed wallet — server-managed; no signing material lives on the VM.

#### Why this rule exists — the 2026-05-24 audit findings

CDP wallets were the **original** wallet provisioned for every InstaClaw agent BEFORE the Bankr partnership cutover in early 2026. Bankr replaced CDP as the primary wallet, but CDP infrastructure was supposed to remain as the backup. It got lost during the cutover — `lib/cdp.ts` stayed at the marketplace root, never ported into `instaclaw/`. **For months**, paying users had no backup wallet during Bankr maintenance windows. Cooper P0'd the restoration on 2026-05-24.

Restored as ADDITIVE infrastructure (not a replacement for Bankr):
- **Mint path**: `provisionCdpWallet({vmId, userId})` in `lib/cdp-wallet.ts`. CRITICAL divergence from Bankr — CDP has NO idempotency key on `createAccount`, so this helper MUST SELECT `cdp_wallet_address` from DB first and short-circuit if present. Without that, retries/race conditions would mint orphan CDP accounts forever (Coinbase has no delete API).
- **Called from**: `/api/vm/assign`, `/api/billing/webhook`, `/api/checkout/verify` — runs BEFORE `provisionBankrWallet` so CDP is the reliable baseline. Each call wrapped in its own try/catch so a CDP failure NEVER blocks Bankr provisioning.
- **Backfill cron**: `/api/cron/provision-missing-cdp-wallets` every 30 min, concurrency 3, PER_RUN_LIMIT 50. No `BANKR_MAINTENANCE` gate — CDP is precisely the thing that backs Bankr up.
- **On-VM delivery**: `configureOpenClaw` + cloud-init `buildDotEnv` both write `CDP_WALLET_ADDRESS` to `~/.openclaw/.env` in their own conditional block, independent of any Bankr field.
- **Agent knowledge**: `buildWalletMd` emits a "## Backup Wallet (Coinbase CDP)" section in WALLET.md with explicit receive-only semantics, "Bankr Outage Fallback" instructions, and the EXACT user-facing reply ("My primary wallet (Bankr) is temporarily unavailable…"). Mirror sections in V1 (`agent-intelligence.ts` SOUL supplement) and V2 (`workspace-templates-v2.ts` AGENTS.md) wallet routing tables.
- **Both-missing edge case**: `buildWalletMd`'s no-wallet branch now emits explicit "Wallet provisioning in progress" content with a paste-ready user-facing reply, NOT just an empty comment block. Per the 2026-05-24 audit, the agent must say "wallet being set up — try again in a few minutes," NOT "I have no wallet."

#### Mandatory invariants

1. **Every assigned VM has BOTH `bankr_evm_address` AND `cdp_wallet_address` populated** (or both NULL during the provisioning window — never one without the other persisting beyond the next cron tick). The two cron safety nets (`provision-missing-bankr-wallets` + `provision-missing-cdp-wallets`) catch drift.
2. **CDP wallet is RECEIVE-ONLY from the agent's perspective.** No signing key on the VM. The agent CANNOT send/swap/launch from the CDP wallet directly — those operations require the InstaClaw backend. The agent's only spendable EVM wallet is Bankr.
3. **CDP address validity is INDEPENDENT of Coinbase API state.** The address is a permanent EVM address on Base. Even during a Coinbase Developer Platform outage, the agent can give out the address and funds will land on-chain.
4. **No `wallet_provider` enum on `instaclaw_vms`.** CDP is ADDITIVE, not a mutually-exclusive alternative to Bankr. Every VM gets BOTH.
5. **Snapshot bake refuses if CDP infrastructure is missing.** Five `scripts/_pre-bake-check.ts:checkCdpReadiness()` gates: env vars present, `@coinbase/cdp-sdk` in `package.json`, `lib/cdp-wallet.ts` present, migration tracked, cron entry registered. Mirrored as CLAUDE.md §7 verification items 16a-16e. The autonomous-bake pipeline also gates via `REQUIRED_BAKE_TOOLING_ENV` in `lib/bake/env-loader.ts`.

#### Banned patterns

- Removing the CDP provision call from `/api/vm/assign` or `/api/billing/webhook` or `/api/checkout/verify`. CDP is the reliable baseline — every assignment path must include it.
- Adding a `wallet_provider` enum or any code that treats Bankr/CDP as mutually exclusive. They run in parallel.
- Calling `cdp.evm.createAccount()` without a DB-first idempotency check. Orphan CDP accounts accumulate inert in our Coinbase org and cannot be deleted.
- Emitting `CDP_WALLET_ADDRESS` as part of the Bankr `.env` block. CDP runs independently — its emission must be unconditional on Bankr fields so the fallback works even on VMs with no Bankr wallet yet (e.g., during a Bankr maintenance window or before the Bankr safety-net cron catches up).
- Updating `buildWalletMd` without re-running the backfill cron / one-shot script to propagate WALLET.md content to existing minted VMs. The cron's `cdp_wallet_address IS NULL` filter excludes already-minted VMs, so template changes only reach them via configureOpenClaw or `scripts/_backfill-cdp-wallet-md.ts`.

#### Detection rule

PR review checklist for any change touching wallet provisioning:
1. Does the change touch any of the three assignment routes (`vm/assign`, `billing/webhook`, `checkout/verify`)? If yes, verify CDP call is still present + still runs BEFORE Bankr.
2. Does the change touch `buildWalletMd` content? If yes, plan a propagation step — either run `scripts/_backfill-cdp-wallet-md.ts` post-deploy OR bump the manifest to force reconcile.
3. Does the change introduce a new wallet provider? If yes, do NOT model it as mutually exclusive with Bankr/CDP. ADDITIVE is the pattern.
4. Does the change reference Coinbase CDP API in a way that requires the API to be UP? If yes, the address-validity invariant (#3 above) may be violated — receive functionality must NEVER depend on Coinbase API state.

#### Related rules
- **Rule 38** (atomic-write tmp files must self-clean on ENOSPC): CDP backfill writes WALLET.md via tmp+mv per this pattern.
- **Rule 47** (continuous reconciliation, not version-gated): the file-drift cron handles `vm-manifest.ts:files[]` entries but NOT per-VM WALLET.md. The CDP backfill cron's writeEnvAndWallet step is the equivalent continuous-reconciliation path for per-VM WALLET.md content.
- **Rule 56** (migration files must be self-contained): `20260524180000_vm_cdp_wallet.sql` lived in `pending_migrations/` until Cooper applied via Supabase Studio, then `git mv`'d to `migrations/`.
- **Rule 67** (next number) — RESERVED for the Anthropic balance monitoring rule below.

### Rule 67 — Anthropic API balance MUST have proactive alerting; silent 402 cascades fleet-wide outages

The proxy's gateway route (`app/api/gateway/proxy/route.ts:1278-1297` + `1380-1402`) intercepts Anthropic 402 / "credit balance too low" errors and returns a friendly user-facing "I'm temporarily unavailable" message. **This is the right user-facing behavior, but combined with the absence of admin alerting, it produces the May 14 2026 incident pattern: silent fleet-wide outage that the operator only learns about when paying users complain.**

The fundamental constraint: Anthropic's regular API key cannot query account balance proactively. There's no `GET /v1/account/balance` endpoint. The only signal that the balance is exhausted is a 402 on a real `/v1/messages` request. So detection has to live in the request path.

#### Mandatory pattern

Every code path that detects an Anthropic 402 / "credit balance too low" / "billing" error MUST:
1. Return the friendly user-facing message (existing behavior — preserves UX).
2. Fire `sendAdminAlertEmail` with severity P0, deduped via `instaclaw_admin_alert_log` at a 1-hour interval. Subject line MUST start with `[P0] Anthropic balance` so it sorts to the top of the operator inbox.
3. Log a structured `anthropic_balance_outage` event with the affected `vmId` + `userId` for forensics.

The 1-hour dedup is tight enough that operators get woken up on the first 402 of an incident but not flooded by every subsequent customer message (which all return 402 too during the outage window).

#### Banned patterns

- Catching a 402 from Anthropic without firing an admin alert. The May 14 incident's whole shape was "silent." Never repeat it.
- Per-VM admin alert dedup at sub-1h intervals during a confirmed Anthropic-balance outage — every VM in the fleet will fire one and the operator inbox melts down. The single hourly fleet-level alert is sufficient.
- Trusting Anthropic's own billing email alerts to the account-owner email as sufficient. They are best-effort, can lag, and target Cooper's personal email (not the operator inbox). Belt-and-suspenders: our own alert from the request path.

#### Operational runbook (when the alert fires)

1. Confirm via Anthropic dashboard (console.anthropic.com → Billing) that the balance is actually $0 / near-$0. If yes:
   - Trigger Anthropic auto-reload by depositing manually (the auto-reload trigger is balance-driven; in some failure modes auto-reload doesn't fire and a manual top-up restarts the chain).
   - Wait for the next /v1/messages request to succeed (typically <30s after balance refreshes).
   - Optionally restart caching paths: OpenClaw's `auth-profiles.json` caches 402 failures with `disabledUntil` timestamps; affected VMs need the cache cleared. `clearStaleAuthCacheForUser` helper exists for this (per Rule 16).
2. If balance is fine but 402s keep coming, investigate org-level issues (rate-limit org throttle, suspended account, key rotation, etc.).

#### Detection rule

Code review: any new code path that calls Anthropic's API directly or via the gateway proxy must answer "what happens when Anthropic returns 402?" If the answer doesn't include "admin alert fires," the PR is incomplete.

### Rule 68 — `configure_failed` (and any orphan `health_status`) MUST have a documented sibling recovery path

[Codified after the 2026-05-26 INC-20260526 — see `docs/postmortems/2026-05-26-configure-failed-stuck-users.md`]

When a new `health_status` value is introduced, the PR adding it MUST enumerate every downstream consumer (`health-check`, `reconcile-fleet`, `file-drift`, `process-pending` Pass 2, `stuck-unhealthy-customer-alert`, `stuck-vm-auto-recover`, `reconcile-stuck-vms`) and declare each as INCLUDED or EXCLUDED with reason. EXCLUDED requires a documented sibling recovery path. Without this discipline, an orphan state — a value that no automated path handles — silently traps paying users for weeks (the 2026-05-26 incident left 4 customers stuck for up to 70 days).

### Rule 69 — Proxy call_type taxonomy: every non-user LLM call MUST opt in via explicit header

[Codified after the 2026-05-28 INC-20260528 strip-thinking summary overcharge — see `instaclaw/docs/postmortems/2026-05-28-strip-thinking-summary-overcharge.md`]

The proxy at `app/api/gateway/proxy/route.ts` categorizes every incoming request into a `call_type` that determines (a) which model the request routes to, (b) which budget bucket the request charges against, and (c) which dashboard / monitoring channel the request logs to. The five categories:

| call_type | Trigger | Routing | Budget bucket | Logged column |
|---|---|---|---|---|
| `user` | Default — none of the below | Content router (`lib/model-router.ts`) | User's daily display limit (tier-keyed) | `usage_log.call_type='user'` |
| `tool_continuation` | Body shape matches tool-continuation pattern (existing detection) | Same model as preceding user call | Discounted user budget (0.2x) | `usage_log.call_type='tool_continuation'` |
| `heartbeat` | Detected by frame shape OR timing fields (existing detection) | Forced minimax | Separate `HEARTBEAT_DAILY_BUDGET=100` | `usage_log.call_type='heartbeat'` |
| `virtuals` | Body has `model: virtuals-*` (existing detection) | Forced virtuals upstream | Separate `VIRTUALS_DAILY_BUDGET` | `usage_log.call_type='virtuals'` |
| `infrastructure` | Caller sends `x-call-kind: infrastructure` header | Forced haiku (`INFRASTRUCTURE_FORCED_MODEL`) | Separate `INFRASTRUCTURE_DAILY_BUDGET=500` (per VM per day) | `usage_log.call_type='infrastructure'` |

The five categories are mutually exclusive. A call categorized as `infrastructure` is NOT also categorized as `heartbeat`; the proxy detection order is `infrastructure → heartbeat → virtuals → tool_continuation → user (default)`.

#### Mandatory pattern

When adding any new LLM call site that hits `/api/gateway/proxy`:

1. **Decide the category FIRST**, before writing the call. The call_type determines billing — it is not negotiable after the fact.

2. **For `user` calls** (real user-typed messages reaching the proxy via the gateway): send no special headers. The proxy will detect, route, charge.

3. **For `infrastructure` calls** (any cron / reconciler / script / template-deployed-script that calls the proxy as a platform operation, NOT as the user's typed message): MUST send BOTH:
   - `x-call-kind: infrastructure` — declares the category
   - `x-model-override: claude-haiku-4-5-20251001` — defense in depth (even if proxy reads it independently)

4. **For `match-pipeline` calls** (existing Consensus matching pipeline): send `x-call-kind: match-pipeline` (legacy header value; predates this rule). The pipeline is conceptually a user-paid agent task, NOT infrastructure — its existing semantics are preserved.

5. **For `strict-canary` calls** (reconciler canary probes): send `x-strict-canary: true`. Existing behavior.

#### What infrastructure calls SKIP

When the proxy categorizes a call as `infrastructure`:
- Content router is NOT invoked — the model is forced to `INFRASTRUCTURE_FORCED_MODEL` regardless of prompt content.
- `instaclaw_check_and_increment` RPC is NOT called — the user's daily display limit is NOT decremented.
- The cron circuit breaker is NOT evaluated — these calls have no first_manual_at semantics.
- `instaclaw_increment_tier_usage` is NOT called — these calls don't count toward tier-2/tier-3 quotas.
- A SEPARATE per-VM per-day budget cap is enforced (`INFRASTRUCTURE_DAILY_BUDGET=500`) via a cheap COUNT() against usage_log. If exceeded, the proxy returns HTTP 429 (anti-runaway, NOT a user-facing error).

#### Defense in depth — `x-model-override`

ANY call (regardless of `x-call-kind`) that sets `x-model-override` has its value plumbed into `routingCtx.explicitModelRequest`, which the existing `respectExplicitModel()` path in `lib/model-router.ts` consults BEFORE the content classifier. This means a future caller who sets `x-model-override: claude-haiku-4-5-20251001` but forgets `x-call-kind: infrastructure` will STILL get routed to haiku (at cost=1) — though the call will be charged against the user's budget (because it has no infrastructure opt-in). The damage is bounded: misclassification costs the user 1 cost_weight instead of 4-19.

#### Banned patterns

- **A new LLM call site without an explicit category decision.** If the PR introducing a new call to `/api/gateway/proxy` does not name which `call_type` the call belongs to and which headers it sends, the PR is incomplete. The 2026-05-28 incident was exactly this: the strip-thinking periodic-summary helper sent `x-model-override` but didn't send `x-call-kind`, and the proxy didn't enforce a default category check.
- **Content-based categorization for non-user calls.** The content router decides MODEL given a category; it MUST NOT decide CATEGORY. Categories come from headers + frame shape. The pre-2026-05-28 bug was the content classifier picking sonnet/opus for a "summarize" prompt that was actually infrastructure.
- **Adding a new `call_type` enum value without a sibling Rule entry.** This rule is the canonical taxonomy. Every category needs (a) explicit trigger, (b) routing rule, (c) budget bucket, (d) logged column.
- **A periodic / cron-driven LLM call without a throttle.** Even within the infrastructure budget cap, callers must implement their own dedupe / interval gates (see strip-thinking's `PERIODIC_SUMMARY_INTERVAL=7200`, `PERIODIC_RECENT_DEDUPE_SECONDS=1800`, etc.). The proxy budget cap is a safety net, not a primary throttle.

#### Detection rule

The `usage-anomaly-check` cron's Signal 4 fires when any VM exceeds 200 cost_weight of `call_type='infrastructure'` in the last hour. This is a per-VM threshold (not fleet-aggregate) chosen at 40x the expected baseline (5 cost_weight per VM per hour at steady state). Per-VM is essential — the 2026-05-28 incident manifested as "many VMs with elevated user costs" rather than "one VM going haywire" and so fleet-wide aggregates were silent.

When Signal 4 fires, the responder drills down via the inline SQL (drill-down query in the alert body) to identify the offending prompt_hint group on the top VM. That tells them exactly which infrastructure caller is misbehaving.

#### Related rules

- **Rule 23** (sentinel-grep required templates): the strip-thinking periodic-summary script has `STRIP_THINKING_LLM_KILL_SWITCH_2026_05_28` and `x-call-kind: infrastructure` as required sentinels. Any future template-only deploy of strip-thinking that lacks both will be rejected by file-drift / stepFiles.
- **Rule 47** (continuous reconciliation): the 2026-05-28 Phase 2 fix is a file-content change + a proxy code change. The strip-thinking file change propagates via file-drift + the manifest version bump (v125); the proxy code change rolls via the Vercel deploy.
- **Rule 14** (`lib/billing-status.ts` is the single source of truth for paying-user classification): infrastructure call budgeting is orthogonal to billing-status — even non-paying VMs can make infrastructure calls (within the per-VM cap) because the operations are platform-funded, not user-funded.

### Rule 70 — Every gateway gets a daily try-restart at 09:00 UTC ± 30min for state hygiene

Every `openclaw-gateway` user service in the fleet MUST be triggered by a systemd user timer to perform a graceful `try-restart` once per day, scheduled at 09:00 UTC with `RandomizedDelaySec=1800` jitter (uniform random across a 30-minute window). The intent is preventive state hygiene — gateway in-memory state degrades silently over multi-day uptime (Telegram fetch timeouts accumulate as unresolved transport handles, OpenAI codex_stream connection pools fragment, typing keepalive intervals fire late under aggressive event-loop pressure), and the cheapest sufficient remediation is "restart it once a day during global low traffic."

#### Why this rule exists

The 2026-05-28 vm-1028 typing IR diagnosed a real-but-non-deterministic UX regression: reactions dropped on some user messages and typing indicators died mid-turn on others. Three days of journal forensics, debug instrumentation patches, and live message tests proved the keepalive architecture is structurally sound (44 keepalive fires at exactly 3.0s intervals during a 132s LLM call), the reaction code path executes (logged at every send-message entry), and the openai-codex stream emits deltas correctly (~700 stream events per turn in the journal). The bug is real but not reproducible on a freshly-restarted gateway — only on one that's been running for ~9h+.

`gateway-restart-on-error` paths exist (Rule 16 / Rule 17) but they're crash-driven, not hygiene-driven. By the time they fire, the user has already seen broken UX. A clock-driven preventive restart guarantees no gateway runs degraded for more than 24h, no matter what subtle leak accumulates.

#### The two-unit shape

The implementation is two `systemd --user` units deployed via `vm-manifest.ts:files[]`:

- **`~/.config/systemd/user/openclaw-daily-restart.service`** — `Type=oneshot`, single `ExecStart=/bin/systemctl --user try-restart openclaw-gateway.service`. The unit body is the constant `DAILY_RESTART_SERVICE_UNIT` in `lib/systemd-templates.ts`.
- **`~/.config/systemd/user/openclaw-daily-restart.timer`** — `OnCalendar=*-*-* 09:00:00 UTC`, `RandomizedDelaySec=1800`, `Persistent=true`. The unit body is the constant `DAILY_RESTART_TIMER_UNIT` in the same file.

Manifest entries use `mode: "overwrite"` (file-drift is the authoritative writer — Rule 47) and carry `requiredSentinels` (Rule 23) to refuse stale-cache deploys: the timer's sentinels are `OnCalendar=*-*-* 09:00:00 UTC`, `RandomizedDelaySec=1800`, `Persistent=true`, `WantedBy=timers.target`; the service's are `Type=oneshot`, `try-restart openclaw-gateway.service`.

Reconciler step `stepEnableDailyRestartTimer` (called from BOTH `reconcileVM` and `runFileDriftPass`) owns the systemd state side: daemon-reload after any content change, `enable --now` on first install, force-restart-the-timer when on-disk content md5 differs from the cached marker at `~/.openclaw/.daily-restart-deployed-md5` (so a schedule change actually re-arms instead of waiting for the next OLD-schedule fire). configureOpenClaw also writes the unit files and enables the timer at provision time so the snapshot bake captures it.

#### The 25 edge cases enumerated and how each is handled

The design intent: future engineers should not have to re-derive these.

1. **Mid-conversation user.** `RandomizedDelaySec=1800` spreads restarts across 30 minutes — a user actively chatting at 09:00:00 UTC sharp has a 0.05% chance their VM fires at that exact second. If unlucky, the openclaw-gateway SIGTERM → start cycle is ~13 seconds; their Telegram message queues and the agent picks up on next start. Worst case: one-message delay.
2. **Hibernating VM.** `try-restart` is a no-op on a stopped unit. The intentional `suspended/hibernating` state is preserved. (Critically distinct from `restart`, which would START a stopped gateway.)
3. **Crashed VM in StartLimit cooldown.** Same as hibernating — `try-restart` no-ops on the failed state, doesn't add to the restart counter.
4. **Race with `reconcile-fleet` running stepGatewayRestart simultaneously.** systemd serializes operations on the same unit — whichever lands first wins; the second is a no-op or queued. No corruption.
5. **Thundering herd.** ~160 healthy fleet VMs ÷ 1800s = ~1 restart per 11 seconds. Below Telegram getUpdates rate limit (per-bot), below every LLM provider's per-second cap.
6. **Clock skew / Linode-side reboot at the scheduled time.** `Persistent=true` replays the most recent missed firing on next boot. Bounded — does not replay a backlog.
7. **DST / timezone drift.** Explicit `UTC` suffix on `OnCalendar` makes the schedule immune to per-customer `user_timezone` config or any system-tz mishap.
8. **Cloud-init not yet run.** configureOpenClaw runs as part of cloud-init / provisioning; the unit files + enable land in the same script. Fresh VMs come up with the timer already armed.
9. **Pool VMs (not yet assigned).** Timer fires on pool VMs too. Harmless — `try-restart` on a not-actively-conversing gateway is sub-second.
10. **Service masked by operator.** `enable --now` exits non-zero; `stepEnableDailyRestartTimer` pushes to `result.warnings` per Rule 39. cv-bump proceeds; operator unmask required.
11. **Daily-restart service itself crashes.** Oneshot with `Type=oneshot`, no `Restart=`, so a failure exits silently. Does NOT affect openclaw-gateway.
12. **Race with `stepGatewayRestart` health-verify wait.** systemd serializes; harmless. The timer-driven restart is graceful so health comes back within the health-verify budget.
13. **Race with file-drift writing new content.** `stepEnableDailyRestartTimer` compares on-disk md5 to expected (template constant) md5 and short-circuits to `alreadyCorrect` if mismatched — i.e., "file-drift hasn't synced yet, retry next tick." Idempotent.
14. **Schedule change** (operator edits the template constant). file-drift writes new content within 15 min, reconciler step detects md5 marker mismatch, daemon-reload + restart timer to re-arm with new `OnCalendar`. Self-propagating.
15. **gbrain interaction.** gbrain runs in its own systemd unit (`gbrain.service`) — completely unaffected by our restart of `openclaw-gateway`.
16. **Memory-snapshot pre-stop hook.** Daily restart runs ExecStopPost=memory-snapshot.sh automatically. Bonus: free daily memory snapshot.
17. **`linger=no` on the openclaw user.** User services don't run after logout. Out of scope for this rule — the existing fleet provisioning REQUIRES linger=yes (cron jobs depend on it). Coverage script catches linger=no as a separate audit signal.
18. **Per-VM verification.** `journalctl --user -u openclaw-daily-restart.service --since today` shows the most recent fire. `systemctl --user list-timers openclaw-daily-restart.timer` shows the next scheduled fire.
19. **Fleet-wide verification.** Optional `scripts/_coverage-daily-restart.ts` audit script SSH-probes N random VMs and verifies (a) timer enabled, (b) last trigger within 24h, (c) marker md5 matches expected. P1 followup.
20. **Rollback path.** Revert the manifest commits. file-drift reverts file content within 15 min; the reconciler does not auto-disable the timer (one-way self-healing only). For full disable: SSH the fleet and run `systemctl --user disable --now openclaw-daily-restart.timer` (one-shot fleet script).
21. **Emergency disable.** Same as rollback — SSH fleet push.
22. **Per-VM opt-out.** Deferred. If ever needed, gate on a marker file like `~/.openclaw/.no-daily-restart` via an `ExecStartPre=`.
23. **Manual test.** `systemctl --user start openclaw-daily-restart.service` triggers the oneshot immediately. Used for vm-1028 live verification on 2026-05-28.
24. **Schedule reconsideration.** Edit `OnCalendar` in `lib/systemd-templates.ts:DAILY_RESTART_TIMER_UNIT` AND the matching `requiredSentinels` in `lib/vm-manifest.ts:files[]` for the timer entry. file-drift + reconciler step propagate the change fleet-wide within ~15 min.
25. **Frequency reconsideration.** If daily proves insufficient (state degrades within hours), change `OnCalendar` to `*-*-* 09,21:00:00 UTC` (twice-daily) and widen `RandomizedDelaySec` proportionally. If daily proves excessive, change to a weekday-only or weekly cadence — but document the choice in this rule body.

#### Mandatory pattern

- All systemd unit body content lives EXACTLY in `lib/systemd-templates.ts`. No literal unit-body strings in any other file.
- Manifest entries for both unit files MUST carry `requiredSentinels` covering load-bearing strings: schedule, jitter, persistence, try-restart semantic, oneshot type. Per Rule 23, missing sentinels refuse to deploy.
- `stepEnableDailyRestartTimer` failures push to `result.warnings`, never `result.errors`. Per Rule 39, the daily restart not firing is a missed hygiene cycle, not a customer-blocking outage. cv-bump proceeds.
- The reconciler step MUST be called from BOTH `reconcileVM` (covers cv-stale VMs) AND `runFileDriftPass` (covers caught-up cv-current VMs). Without the file-drift call site, the timer would never enable on caught-up VMs unless the manifest version is bumped — Rule 47 territory.
- configureOpenClaw writes unit files + enables the timer at provision time so the snapshot bake captures it and fresh provisions don't wait for the first reconciler tick.

#### Banned patterns

- **Using `Restart=` on the daily-restart.service**. The unit is intentionally oneshot. Adding `Restart=on-failure` would cause it to retry indefinitely if `try-restart` failed for any reason, hammering systemd.
- **Using `ExecStart=systemctl restart openclaw-gateway` instead of `try-restart`.** This would START stopped gateways (hibernating customers, crashed customers in cooldown, freshly-provisioned VMs that intentionally haven't started yet). The semantic difference is load-bearing — verified against the 25 edge cases above.
- **Pushing daily-restart failures to `result.errors`.** A failed enable doesn't affect the customer-immediate experience; pushing to errors would hold cv-bump and create lying-DB-LOW (Rule 23 inverse) drift. Per Rule 39, this is hygiene infrastructure.
- **Editing the unit files directly via SSH without updating the template constants in `lib/systemd-templates.ts`.** file-drift reverts within 15 min; the operator change is lost. Always go through the manifest path.
- **Changing the schedule (`OnCalendar`) without updating the matching `requiredSentinels`** in the manifest entry. file-drift would still write the new content, but Rule 23 sentinels would falsely-pass — defeating the stale-cache guard. Sentinels must track schedule changes.
- **Adding any other ExecStart= to the service** beyond the try-restart. The timer is for openclaw-gateway hygiene, not a general cron-replacement.
- **Disabling the timer per-VM without documenting why.** If a specific VM truly should not restart (some long-lived experiment, etc.), file a P1 follow-up to add the marker-file opt-out (edge case #22). Until then, expect the timer to fire.

#### Detection rule

PR review checklist for any change touching `lib/systemd-templates.ts`, the manifest entries for the daily-restart units, `stepEnableDailyRestartTimer`, or its two call sites in `lib/vm-reconcile.ts`:

1. Did the change preserve `try-restart` (not `restart`)?
2. Did the change preserve `RandomizedDelaySec=1800` (or wider — never narrower without a thundering-herd analysis)?
3. Did the change preserve `Persistent=true`?
4. Did the change preserve the `UTC` suffix on `OnCalendar`?
5. If `OnCalendar` changed: did the matching manifest `requiredSentinels` also change?
6. Did the change preserve Rule 39 classification (warnings, not errors)?
7. Did the change preserve the file-drift call site of `stepEnableDailyRestartTimer`? (Without it, caught-up VMs never receive subsequent schedule changes.)

If any answer is no → the PR is incomplete or potentially regressive.

#### Related rules

- **Rule 23** (sentinel-grep required templates): the manifest entries enforce content correctness via sentinels.
- **Rule 32** (`openclaw config set` exit-0 ≠ runtime applied): same "verify after write" discipline applied to systemd state — reconciler step re-probes is-active after enable.
- **Rule 39** (distinguish critical-step failures from optional-sidecar failures): hygiene timer failures are warnings.
- **Rule 47** (continuous reconciliation, not version-gated): the file-drift call site of `stepEnableDailyRestartTimer` closes the cv-current gap.
- **Rule 56** (migration files must be self-contained): the analog here is "manifest entries + template constants must be self-contained" — no operator clicks required for the timer to install.

### Operational runbook: monthly freeze pipeline health audit

Run this checklist monthly (or on demand during incident triage) to confirm the freeze pipeline is still healthy after rules 50-52 ship.

**Step 1 — Active leak count (top-line health):**

```sql
-- Sleeping VMs past 3-day grace with no image — money-leak cohort
SELECT
  COUNT(*) AS suspended_no_image_gt_3d,
  COUNT(*) FILTER (WHERE suspended_at < NOW() - INTERVAL '7 days') AS gt_7d,
  COUNT(*) FILTER (WHERE suspended_at < NOW() - INTERVAL '30 days') AS gt_30d
FROM instaclaw_vms
WHERE status = 'assigned'
  AND health_status = 'suspended'
  AND suspended_at < NOW() - INTERVAL '3 days'
  AND frozen_image_id IS NULL;
```

Expected (healthy): `< 5` (steady-state — VMs transition through this state on their way to frozen). Anything `> 20` indicates the freeze cron is starved or broken.

**Step 2 — Success/failure histogram (last 7 days):**

```sql
SELECT action, COUNT(*)
FROM instaclaw_vm_lifecycle_log
WHERE created_at > NOW() - INTERVAL '7 days'
  AND action LIKE 'freeze%'
GROUP BY action
ORDER BY COUNT(*) DESC;
```

Expected (healthy): mix of `frozen` (≥ 5/week) and `freeze_skipped_safety` (intentional skips on still-credited / still-active users). **Zero `frozen` rows is the canary** — escalate immediately.

**Step 3 — Skip-reason breakdown (where's the freeze pool stuck?):**

```sql
SELECT
  CASE
    WHEN reason ILIKE '%credit_balance%'         THEN 'paid_credits_remain'
    WHEN reason ILIKE '%active Stripe%'          THEN 'live_sub'
    WHEN reason ILIKE '%Bankr token%'            THEN 'bankr_token'
    WHEN reason ILIKE '%last_user_activity_at%'  THEN 'user_active_within_window'
    WHEN reason ILIKE '%pre-imagize cleanup%'    THEN 'disk_over_6gb_after_cleanup'
    WHEN reason ILIKE '%lifecycle lock%'         THEN 'lock_busy'
    WHEN reason ILIKE '%offline within%'         THEN 'shutdown_timeout'
    ELSE 'other'
  END AS bucket,
  COUNT(*)
FROM instaclaw_vm_lifecycle_log
WHERE created_at > NOW() - INTERVAL '7 days'
  AND action = 'freeze_skipped_safety'
GROUP BY bucket
ORDER BY COUNT(*) DESC;
```

If `disk_over_6gb_after_cleanup` dominates: the cleanup whitelist needs expansion (or a small set of VMs have large user-data workspaces — investigate per-VM `df -h` via SSH). If `user_active_within_window` dominates without corresponding user reports of agents working: re-validate that `last_user_activity_at` writers are correctly distinguishing user calls from heartbeats.

**Step 4 — Recovery-alert audit:**

Search Resend dashboard / admin inbox for `[P0] Freeze recovery FAILED` in the last 30 days. Each one is a zombie VM that needs manual triage:
1. Power on the Linode via dashboard.
2. SSH and verify the gateway recovers.
3. Disk-cleanup-by-hand if > 6 GB.
4. Mark VM `freeze_consecutive_failures = 0` to re-prioritize.

**Step 5 — Zombie inventory (Linode-vs-DB drift):**

```ts
// scripts/_audit-freeze-zombies.ts (build if it doesn't exist)
// For every status=assigned + health_status IN (suspended,hibernating) + frozen_image_id=NULL:
//   GET /v4/linode/instances/<provider_server_id>
//   If status=offline → log as ZOMBIE
//   If 404 → log as DESTROYED_OUT_OF_BAND
```

Healthy fleet: zombie count `< 3`. Anything higher means Rule 52 alerts are being missed or ignored.

**Step 6 — Linode events forensics for any zombie:**

```bash
curl -sS "https://api.linode.com/v4/account/events?page=1&page_size=20" \
  -H "Authorization: Bearer $LINODE_API_TOKEN" \
  -H 'X-Filter: {"entity.type":"linode","entity.id":<provider_server_id>}' \
  | python3 -c "import json,sys; \
    [print(e['created'][:19], e['action'], e['status'], (e.get('message') or '')[:140]) \
     for e in json.load(sys.stdin)['data'][:20]]"
```

Look for `disk_imagize status=failed` (Rule 51 territory — disk over 6 GB). Look for `linode_shutdown status=finished` without a matching `linode_boot status=finished` after it (Rule 52 territory — recovery failed).

### Monitoring: alert on freeze pipeline starvation

Two stacked alerts to detect the 2026-05-15 failure mode if it ever recurs:

**Alert FA1 — Pipeline starvation (no successes in 7 days):**

```sql
-- Fires if `frozen` count is zero across a 7d window
SELECT COUNT(*) AS frozen_7d
FROM instaclaw_vm_lifecycle_log
WHERE created_at > NOW() - INTERVAL '7 days'
  AND action = 'frozen';
-- Alert when frozen_7d = 0 AND skipped_7d > 50
```

Threshold: `frozen_count(7d) = 0 AND freeze_skipped_safety_count(7d) ≥ 50`. The compound condition prevents the alert from firing during legitimate quiet periods (no eligible candidates). If skips are happening but no successes are landing, something is structurally broken.

**Alert FA2 — Cost leak (eligible cohort growing):**

```sql
-- Fires if the eligible-for-freeze cohort exceeds expected steady-state
SELECT COUNT(*) AS leak_count
FROM instaclaw_vms
WHERE status = 'assigned'
  AND health_status = 'suspended'
  AND suspended_at < NOW() - INTERVAL '3 days'
  AND frozen_image_id IS NULL;
-- Alert when leak_count > 20
```

Threshold: `leak_count > 20`. At $29/mo per VM that's $580/mo when alert fires; $1,450/mo is what we hit at 50 (the 2026-05-15 incident size).

Both alerts route to `ADMIN_ALERT_EMAIL` via `sendAdminAlertEmail`. Implementation lives in a new cron at `/api/cron/freeze-pipeline-health` (P1 follow-up — wire by 2026-05-22). Until that lands, run the runbook queries above manually each Monday.

**Cost guard**: this same query (Alert FA2) doubles as the **weekly cost-leak check**. Run every Monday morning. Any non-zero answer is a money trail to investigate — every row is $29/mo until frozen.

### Root cause 1: ENOSPC swallowed as "config-set silent failure" [BOTH FIXES SHIPPED]

**Status**: Both layers shipped. (1) **stepConfigSettings** (Rule 36 / commit `7c97df5b`, 2026-05-14): non-strict path now wraps each `openclaw config set` in BEGIN/END markers and captures per-key upstream stderr; verify-after-set mismatches include the actual ENOSPC payload. (2) **Wrapper-level** (Rule 37, 2026-05-14): `lib/enospc-guard.ts:wrapSSHForEnospcDetection` intercepts ALL `ssh.execCommand` + `ssh.putFile` calls across the reconciler; ENOSPC anywhere short-circuits with a P0 error + 6h-deduped admin alert. The historical evidence below is preserved for context.

**Evidence**: vm-788, vm-842, vm-043 (paying customers including ellingsonjoel@gmail.com, shelpinc@gmail.com). Disk at 100%. `openclaw config set agents.defaults.bootstrapMaxChars 40000` returns exit 1 with `ENOSPC: no space left on device`. The reconciler reports "config-set silent failure: bootstrapMaxChars expected=\"40000\" actual=\"35000\"" — losing the actual ENOSPC error entirely.

**Code path**: `lib/vm-reconcile.ts:1327-1364`. The non-strict `stepConfigSettings`:
```ts
// Line 1327 — bulk run all sets, RETURN VALUE IGNORED:
await ssh.execCommand(`${NVM_PREAMBLE} && ${fixCommands}`);

// Line 1334 — verify each key by reading it:
const verifyResult = await ssh.execCommand(`${NVM_PREAMBLE} && ${verifyCommands}`);

// Line 1364 — when verify mismatches, report as "silent failure":
result.errors.push(`config-set silent failure: ${key} expected=... actual=...`);
```

The actual stderr from the `openclaw config set` calls (which would have shown ENOSPC) is **discarded** by `ssh.execCommand` because we don't read `.stderr` and we don't check `.code`. Then verify-after-set sees the stale value and reports it as if it's a mystery — but the mystery is solved upstream.

Also a related disk-leak issue: the `openclaw config set` flow uses atomic write via a `.tmp` file. On ENOSPC, the `.tmp` file is left behind (0 bytes). vm-788 has 40+ zero-byte `openclaw.json.NNNNNN.UUID.tmp` files accumulating since May 8.

**RULE 36 (Reconciler must surface upstream errors, not invent downstream ones)**: when `stepConfigSettings` (or any verify-after-set step) detects a value mismatch, it MUST report the actual stderr/exit-code from the upstream WRITE operation. Push the ENOSPC, permission-denied, or schema-rejection error verbatim. "Silent failure" is a lie — these failures are always loud at the call site; we're just throwing the volume away. Per-key strict-mode path (`lib/vm-reconcile.ts:1370+`) already does this correctly; the non-strict path must do the same or call into the strict implementation.

**RULE 37 (Disk-full is a customer-down condition; surface it loudly)** [SHIPPED 2026-05-14]: any `ssh.execCommand` whose stderr contains `ENOSPC` or `No space left on device` MUST short-circuit the reconcile, push a P0 error with the full path that ran out, AND emit an admin alert. The customer's gateway is functional now but will die at the next config-mutating operation. We treat this as the highest priority.

**Implementation**: `lib/enospc-guard.ts` exports `wrapSSHForEnospcDetection(ssh, vm, result)` — a thin prototype-chain wrapper that intercepts `ssh.execCommand` and `ssh.putFile`. After every call, it scans stdout+stderr (and any thrown error.message) against `/ENOSPC/` and `/no space left on device/i`. On first detection within a reconcile, it: (a) pushes a `[ENOSPC] ...` entry to `result.errors` (the cron's `pushFailed` gate at `app/api/cron/reconcile-fleet/route.ts:486` then holds cv-bump), (b) emits the `ENOSPC_DETECTED` structured log, (c) fires a 6h-deduped admin alert keyed by `enospc:${vm.id}` (mirrors `sendVMReadyEmail` dedup pattern via `instaclaw_admin_alert_log`), (d) throws `EnospcDetectedError` to short-circuit. `reconcileVM`'s catch handler (lib/vm-reconcile.ts:670+) catches the sentinel via `isEnospcDetectedError` and exits cleanly without re-throwing. `runFileDriftPass` does the same. Fire-once invariant: subsequent ENOSPC hits in the same reconcile re-throw but don't double-push or double-alert.

**Path extraction** is best-effort against three formats: Node fs (`ENOSPC: no space left on device, open '/path'`), bash redirect (`/path: No space left on device`), tool error (`writing '/path': No space left on device`). If no format matches, path is null but the event still fires — the alert email includes the last 500 chars of combined output so an operator can dig in.

**Verification (2026-05-14)**: `scripts/_test-enospc-guard.ts` exercises the wrapper end-to-end with stubbed `execCommand`/`putFile`. 32/32 tests pass — Node fs format, bash redirect, npm output, putFile rejection, healthy passthrough, fire-once across multiple ENOSPC hits, non-ENOSPC errors passing through cleanly, prototype passthrough of `dispose()`. Live-VM fallocate test deferred (would risk a real customer disk; the wrapper logic is mechanically reliable when fully exercised synthetically).

**RULE 38 (Atomic-write tmp files must self-clean on ENOSPC)** [SHIPPED 2026-05-14, fleet-side mitigation]: any code that writes via `path.tmp + rename` (including openclaw config set) must `rm -f <path>.tmp` in an EXIT trap. Otherwise repeated ENOSPC retries accumulate zero-byte files indefinitely, eventually exhausting inodes even when bytes are freed. The 40+ tmp files on vm-788 are the proof. This is in openclaw itself, not our reconciler — file an upstream issue and add a periodic cleanup cron as defense-in-depth.

**Fleet-side mitigation (this rule's reconciler-side implementation)**: `stepDiskGuard` (lib/vm-reconcile.ts:782+) now runs `find ~/.openclaw/ -maxdepth 1 -name "openclaw.json.*.tmp" -mmin +60 -delete` on every disk-guard call, regardless of disk-percent (previously gated inside the `if (diskPct >= 90)` block). The 60-min mtime bound avoids racing legitimate in-flight atomic writes. To cover BOTH cv-drift VMs (via reconcile-fleet → stepDiskGuard) AND cv-current VMs (via cron/file-drift → runFileDriftPass), the file-drift pass now also calls stepDiskGuard before stepFiles — closing the Root Cause 0.5 coverage gap for the cv-current cohort.

**Also fixed in the same change**: `stepDiskGuard`'s two `getSupabase()...update(...)` telemetry writes were wrapped in their own try/catch. Without that, a missing-env-var or transient supabase failure would throw synchronously, bypass the `.then(noop, noop)` and fall into the outer try/catch — taking the .tmp cleanup down with it. Surfaced via `scripts/_test-disk-guard-tmp-cleanup.ts` against a test environment with no Supabase credentials. The fix is defense-in-depth: the local-disk cleanup must never depend on Supabase being reachable.

**Synthetic test** (`scripts/_test-disk-guard-tmp-cleanup.ts`): exercises 12 scenarios — 9 disk-pct levels (50% → 100%) all firing the cleanup, dryRun correctly skipping, probe-parse-fail conservatively skipping. 12/12 pass.

**Upstream canonical fix**: issue draft at `instaclaw/docs/openclaw-upstream-issue-r38.md`. Pending post by Cooper to the openclaw repo.

### Root cause 2-PRIMARY: Strict-mode 180s deadline kills cv=91 cohort reconciles

**Evidence**: vm-046 (paying leighton.cusack@gmail.com), cv=91 for 14+ hours despite Vercel cron running every 3 minutes. Manual catch-up reconcile (`strict=false`) caught it up in **279s** — 0 errors, 37 fixes, 86 alreadyCorrect. Vercel cron uses `strict=true` (`app/api/cron/reconcile-fleet/route.ts`) with `STRICT_DEADLINE_MS = 180_000` at `lib/vm-reconcile.ts:224`. The reconcile dies at the deadline, cv held with `__STRICT_DEADLINE__` error.

This is the **primary structural reason 18 healthy + assigned VMs are stuck at cv=91-94**: they legitimately take >180s to reconcile (lots of accumulated drift to apply), and the cron can't fit that into Vercel's 300s function-maxDuration budget at concurrency=3.

**Code path**: `lib/vm-reconcile.ts:184` (`STRICT_DEADLINE_MS = 180_000`) + `lib/vm-reconcile.ts:463` (`Promise.race` with the deadline timer). Strict reconcile fails to bump cv when wall-clock exceeds 180s — even if the work was on track to complete.

**RULE 44 (Strict deadline ≠ failure)**: when strict reconcile times out, the partial progress is REAL. Don't push `__STRICT_DEADLINE__` to `result.errors`. Either (a) split the manifest's work across multiple ticks (resume cursor in DB), or (b) cron route should treat timeout-with-no-other-errors as "in-progress" — bump cv to the highest version that's been verified, not block on the unfinished tail. The catch-up script's `strict=false` proves the work itself converges; the deadline is artificial.

**Mitigation tonight**: catch-up script with `--min-gap=1` widens the cohort filter to cv ≤ 94, catches the entire cv-91-94 cohort. Already proven to work.

### Root cause 2-SECONDARY: gateway-watchdog FAILED is a downstream symptom

**Evidence**: 3 of 4 randomly-probed cv=91 VMs (vm-046, vm-842, vm-043) show `systemctl --user is-active gateway-watchdog == failed`. The `stepGatewayWatchdogTimer` reconciler step (`lib/vm-reconcile.ts:477`, called as "heal-gateway-watchdog") tries to start the watchdog. When the service is permanently failed (unit broken, dependency missing, or whatever made it fail in the first place), the step pushes to `result.errors` every cycle, blocking cv bump.

The watchdog is NOT customer-facing. It's a sidecar that detects gateway hangs. Its failure does not prevent the gateway from serving messages. But the reconciler treats it as critical.

**Code path**: `lib/vm-reconcile.ts:477` (orchestrator call site), step body deeper. The step's error path pushes to `result.errors` unconditionally; the cron route's `pushFailed` gate then refuses to bump cv.

**RULE 39 (Distinguish critical-step failures from optional-sidecar failures)**: every reconciler step must declare its **criticality class** when pushing to result. Two classes:
- `result.errors` (critical) — only for failures that mean the gateway will be unhealthy or run with wrong state. cv bump holds.
- `result.warnings` (optional) — for monitoring sidecars, optional skills, dependency-missing recoverable degradation. cv bump proceeds; warnings get surfaced separately.

Steps that MUST be reclassified to warnings: stepGatewayWatchdogTimer, stepNodeExporter, optional-skill installs (edge-esmeralda when partner not edge_city, etc.), node_exporter port-did-not-open. None of these affect what the user sees when they message their agent.

Steps that stay critical: stepConfigSettings, stepFiles (when target is SOUL.md/MEMORY.md/auth-profiles.json), stepAuthProfiles, stepGatewayRestart health verify, stepExecStartAlignment.

### Root cause 3: Lying-DB-LOW — cv stuck while disk state is correct

**Evidence**: vm-904 (paying) has v95 keys SET on disk (`messages.ackReaction=👀`, `channels.telegram.streaming.mode=partial`) but `config_version=91` in the DB. Some OTHER step's failure is holding cv hostage even though the user-facing config is correct.

This is the inverse of the classic lying-DB pattern (Rule 23 was about lying-DB-HIGH: cv claims current but state is stale). Lying-DB-LOW: cv claims stale but state is actually current. From the user's perspective the VM works; from the DB the VM looks stuck.

**Risk**: monitoring/dashboards that check cv distribution under-report fleet health. Operations spend cycles trying to "fix" VMs that don't need fixing.

**RULE 40 (Reconciler must explain WHICH step is blocking cv bump)**: when a reconcile produces `result.errors` and the cron route holds cv bump, log a single structured line on EVERY tick listing the specific step name(s) that errored, with full error message. Format: `cv-bump-blocked vm_id=X cv=Y steps_failed=[stepX,stepY] errors=[<first 200 chars each>]`. Without this, operators can't tell why a VM is stuck — only that it is. The current `result.errors[]` is dumped only at end-of-reconcile via the route handler; needs to be searchable per-VM, per-step.

### Root cause 4: VM provisioned with assigned_to but NULL gateway_token

**Evidence**: vm-918 (khomenko89@gmail.com, paying). Created 2026-05-09. `status='assigned'`, `assigned_to` is set, `gateway_token = NULL`. cv=0 since creation. Cohort sweep confirms only 1 VM in this state, but it's a real paying customer whose agent has never worked.

**Code path**: signup flow → `lib/ssh.ts:configureOpenClaw()` is supposed to generate gateway_token and update DB. If `configureOpenClaw()` fails OR if the assignment happens BEFORE configure completes, you get this state.

**RULE 41 (assigned_to and gateway_token are atomic invariants)**: a VM with `status='assigned'` AND `assigned_to NOT NULL` MUST have `gateway_token NOT NULL`. Either both are set or neither. The assignment-and-configure operation must be atomic from the DB's perspective. Practically:
- `configureOpenClaw` must complete BEFORE the DB row's status flips to 'assigned'
- OR a periodic audit cron detects this state and either completes configure or unassigns

Defense-in-depth: a DB constraint or trigger that enforces `(status='assigned' AND assigned_to IS NOT NULL) IMPLIES gateway_token IS NOT NULL`. Trip the trigger on the failed insert path.

### Root cause 5: stepNodeExporter blocks cv on optional monitoring failure

**Evidence**: vm-625 (paying). `node_exporter` service is `inactive (dead)`, port 9100 not listening, no journal entries (service has not run). Reconciler reports `node_exporter: port did not open ()` — empty parens because the install script outputs nothing on this failure mode.

This is documented in CLAUDE.md as P1-2, but the broader principle applies: **node_exporter is a Prometheus metrics exporter. It has zero impact on customer experience. Holding cv bump because metrics are broken is wrong.** This same logic applies to other monitoring sidecars (heartbeat, watchdogs, etc.).

**Code path**: `lib/vm-reconcile.ts` stepNodeExporter pushes a `PORT_FAIL` error to `result.errors` when port 9100 doesn't respond after `sleep 5`. Per Rule 39 above, this should be `result.warnings`.

### Root cause 6: Skill-clone auth failure on private repos

**Evidence**: vm-777 (paying edge_city). `git clone https://github.com/edge-city/edge-esmeralda-skill` returns `fatal: could not read Username for 'https://github.com'`. The edge-esmeralda repo is private; the VM has no github auth (no .netrc, no SSH deploy key in user's repo-auth, no PAT).

Other edge_city VMs (vm-050, vm-354, etc.) have this skill installed — they were configured at a time when auth was available, or via tarball. vm-777 was tagged edge_city LATER and stepSkills' git-clone path can't authenticate.

**Code path**: `lib/ssh.ts:installSkill()` or wherever `git clone` runs in stepSkills. No fallback for private-repo failure.

**RULE 42 (Private-repo skill installs must have a fallback)**: any skill that lives in a private repo MUST be installed via either (a) a tarball bundled in the manifest, (b) a deploy-token stored as a VM env var, or (c) a fallback to a public mirror. Bare `git clone` with no auth is guaranteed to fail on private repos and is not a defensible install path. Until this is fixed, the edge-overlay step must be in the optional-warnings class (Rule 39), not the critical-errors class.

### Root cause 7: Gateway cold-boot timing — 120s wait insufficient for 8-plugin VMs

**Evidence**: vm-901 (paying dkatzg@gmail.com). reconcileVM completed all 55 fixes successfully, then stepGatewayRestart timed out waiting for /health=200 after 120s. The gateway actually came up shortly after the timeout — the audit ran later and saw it healthy. cv held due to the timeout error.

Edge_city VMs load 8 plugins (acpx, bonjour, browser, device-pair, memory-core, phone-control, talk-voice, telegram). Cold boot can exceed 120s especially with memory-snapshot restore. The current `for (let attempt = 0; attempt < 24; attempt++)` loop in stepGatewayRestart caps at 24×5s=120s.

**Code path**: `lib/vm-reconcile.ts:3260+` stepGatewayRestart's health-check loop.

**RULE 43 (Health-check wait must scale with plugin count)**: stepGatewayRestart should query `~/.openclaw/openclaw.json` for the plugin count BEFORE the restart and adjust the wait budget. Suggested: `wait_seconds = max(120, 30 + plugin_count * 15)`. So 2 plugins = 120s (current), 8 plugins = 150s (would have caught vm-901). Alternative: poll until `[gateway] ready` appears in the journal, not just /health=200.

### Systemic findings (answers to Cooper's questions)

**Why doesn't Vercel cron keep the fleet 100% current?**
1. Same VMs fail the same deterministic step every 3 min, indefinitely. No escalation.
2. Optional-step failures (Rules 39, 42) erroneously hold cv bump on critical-path VMs.
3. Strict-mode 180s deadline kills slow VMs before all steps complete; cv held with partial state.
4. Vercel-nft cache (P1-4) can serve stale manifest version → cron processes against wrong target.
5. Lying-DB-LOW (Root cause 3): VMs are actually current but the DB says they're not.

**Is config_version reliable?**
No. Multiple ways it lies:
- Lying-DB-HIGH (Rule 23): cv reports current but disk state is stale. Caused by `result.fixed.push()` without verify-after-set.
- Lying-DB-LOW (Root cause 3): cv reports stale but disk state is current. Caused by optional-step failures holding cv bump.
- Stale-cache (P1-4): cron bumps cv to whatever its bundled-manifest version says, not the true current.

The reliable signal is post-reconcile SSH probe of actual disk + service state. The current DB cv should be treated as "best-effort latest reconcile attempt result," NOT as truth about VM state.

**Are suspended VMs masking failures?**
Likely. The suspend-check cron marks VMs as suspended based on user inactivity or non-payment. But a crash-looping gateway looks identical to an inactive user from outside (no recent activity). Audit follow-up: scan `health_status='suspended'` VMs for high NRestarts pre-suspension. If many crash-looped before being suspended, the suspend-check cron is sweeping failures under the rug.

**What is the retry/backoff behavior on step failure?**
Implicit retry every 3 min via the next cron tick. No exponential backoff. No failure-mode classification. No quarantine on persistent failure. A VM that fails the same step 1000 times in a row gets touched 1000 times, generates 1000 alerts (when alerts exist at all), and nothing converges.

### Structural fixes still needed (in priority order)

Each of these is a P1 owned by the next engineer to touch this code area. Order is by blast radius × ease.

1. **Implement Rule 39 step classification** — `result.errors` vs `result.warnings`. Reclassify stepNodeExporter, stepGatewayWatchdogTimer, optional-skill installs to warnings. ~30 LOC change in vm-reconcile.ts + route.ts. Single biggest unblock for the fleet.
2. **Implement Rule 36 in stepConfigSettings non-strict path** — propagate stderr from bulk set, not just verify-mismatch. ~10 LOC. Surfaces ENOSPC and similar errors so operators can act.
3. **Implement Rule 37 ENOSPC detection** — short-circuit + alert when any SSH command stderr contains "No space left". Defense-in-depth; one new helper function.
4. **Implement Rule 40 cv-bump-blocked logging** — structured log line per VM per blocking step. Makes the fleet-health dashboard buildable.
5. **Implement Rule 41 atomicity invariant** — DB trigger + audit cron for `assigned_to AND gateway_token` invariant.
6. **Implement Rule 43 dynamic cold-boot wait** — query plugin count, scale the timeout.
7. **Implement Rule 42 skill-install auth** — for private-repo skills, ship tarball in manifest. Affects edge_city onboarding.
8. **Disk-fill prevention** — periodic cron to detect VMs above 90% disk, alert + clean. The 100%-disk VMs would have been caught hours/days earlier with monitoring.
9. **Vercel-nft cache migration to JSON manifest** (P1-4 already tracked) — eliminates a class of stale-bundle bugs.

### Health metric to track

In the admin dashboard, surface:
```
fleet_health_actionable = count(health_status='healthy' AND status='assigned' AND cv < manifest.version)
```

Target: 0. Alert at any non-zero value persistent for >30 min.

Companion metric:
```
fleet_stuck_root_cause = histogram by step-that-errored from the Rule 40 log line
```

Surfaces "stepGatewayWatchdogTimer is currently blocking 18 paying customers" instead of just "18 VMs stuck."

