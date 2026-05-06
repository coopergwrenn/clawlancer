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
- Admin email: coop@valtlabs.com

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

**CRITICAL: ALL 7 crons (15a-15g) must be present.** Missing crons caused a P0 incident on 2026-04-08 where sessions grew to 4MB+ and burned credits 20x faster (see commit 68e9e4c). The reconciler does NOT catch missing crons on freshly configured VMs — configureOpenClaw() now installs them, but they must also be in the snapshot as defense-in-depth.

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

### P1-1: Reconciler bumps `config_version` on lying-DB VMs (multiple silent-no-op steps)

- **Discovered**: 2026-05-05 during the v88 rollout audit.
- **Symptom**: vm-893 and vm-895 (both from the 2026-04-30 freshly-provisioned cohort) have `config_version=88` in `instaclaw_vms` but are missing the corresponding artifacts:
  - vm-893: OpenClaw 2026.4.5 (manifest wants 2026.4.26), `TasksMax=4666` (manifest wants 120), no prctl-subreaper package/binary/drop-in, no `consensus_match_*.py` scripts.
  - vm-895: same shape — TasksMax=4666, no `gcc` (build-essential not installed), no prctl-subreaper artifacts.
- **Hypothesis**: At least one of these reconciler steps reports success (no `result.errors.push`) without actually applying changes:
  1. `stepSystemdUnit` — `override.conf` write or `daemon-reload` succeeded by exit code but didn't take effect.
  2. `stepSystemPackages` — `apt-get install build-essential` returned `INSTALLED` but didn't actually install gcc.
  3. `stepNpmPinDrift` — openclaw upgrade succeeded by exit code but didn't actually advance the binary.
  4. `stepPrctlSubreaper` — early-return on stale `npm-ls` match without verifying the .node binary exists.
  5. `configureOpenClaw()` initial-setup path bumps `config_version` to current manifest BEFORE the reconciler runs (or instead of running it).
- **Why we can't diagnose tonight**: The cv=82 cohort (86 VMs) is blocked by the matchpool ENOENT bug — once that frees up (consensus_*.py glob fix in commit `d28bf919`), real bumps will start happening and we can audit the on-disk state of any VM that bumps in real-time.
- **Investigation plan (post-Consensus)**:
  1. Pick 3 VMs that bump from cv=82 → cv=88 in the next 24h after the matchpool fix lands. Capture their `result.fixed`/`result.errors`/`result.alreadyCorrect` from the cron logs.
  2. SSH-audit each VM immediately after the bump. Compare on-disk state (gcc, openclaw --version, TasksMax via systemctl show, prctl-subreaper artifacts, override.conf content) vs what the manifest claims at v88.
  3. For every step where on-disk doesn't match manifest but no `result.errors` were pushed, that's a Rule 10 violation. Add a verify-after-write block.
  4. Likely candidates per the 2026-05-05 evidence: `stepSystemdUnit` (TasksMax not landing on freshly-provisioned VMs), `stepNpmPinDrift` (OpenClaw 2026.4.26 not advancing past 2026.4.5), `stepSystemPackages` (`build-essential` reporting INSTALLED but `gcc` still absent — most likely a `which build-essential` always-MISSING quirk hiding the real failure).
  5. Add Rule 23 sentinel guards to `stepPrctlSubreaper` (binary present + `Environment=NODE_OPTIONS` line in drop-in) and `stepSystemdUnit` (TasksMax line in override.conf) so the reconciler refuses to bump cv if its own writes didn't land.
- **Why this matters**: Rule 10 was specifically written to prevent this class of bug. Either the rule's discipline didn't get applied to all steps, or there's a path that bypasses verify-after-write entirely. Two paying-customer VMs (vm-893 freshly-provisioned; vm-895 freshly-provisioned) have been running stale OpenClaw + missing matchpool scripts for 5 days behind a green DB row.

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
