# InstaClaw — Project Notes

## Quick Commands

- **"spots N"** or **"provision N VMs"** — Provision N new dedicated CPU VMs for the ready pool. Use the exact specs below. NEVER deviate.

## VM Provisioning Standard (MANDATORY)

ALL new VMs must use these exact specs:

- **Provider:** Linode ONLY (never Hetzner or DigitalOcean)
- **Type:** `g6-dedicated-2` (Dedicated 4GB — 2 dedicated vCPU, 4GB RAM, 80GB disk)
- **Region:** `us-east`
- **Snapshot:** `private/38458138` (instaclaw-base-v62-bankr-cli-0.3.1 — baked 2026-04-27 from v58 base. OpenClaw v2026.4.5, **@bankr/cli@0.3.1** (was 0.2.15 in v58 — bumped for direct claim API target POST /token-launches/:tokenAddress/fees/claim). All other v58 contents preserved: v58 manifest scripts at canonical SHAs, full concatenated SOUL.md, workspace files at canonical v58, Chromium 147, ffmpeg, Xvfb, x11vnc, websockify, node_exporter, jq, both SSH deploy keys, 7/7 crons, exec-approvals.json security=full. 5296 MB. 7/7 verified.)
- **Cost:** $29/mo per VM (negotiated Linode rate)
- **DB status:** `provisioning` (cloud-init-poll cron auto-marks as `ready` in ~3-5 min)

NEVER use old snapshots (private/36895419, private/38069990, private/38111101 (v58), or any pre-v62 image). NEVER provision shared CPU (g6-standard-2). NEVER provision on Hetzner or DigitalOcean.

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

**The 2026-05-02 vm-780 incident.** Cooper sent "Build me a 3-day AI itinerary for Consensus." The agent web-fetched cryptonomads.org instead of using the on-disk consensus skill (root cause: SOUL.md directive too soft). The 403 response carried a Cloudflare anti-injection wrapper. Sonnet returned an empty response, retried empty, failed over to Haiku, retried empty — 4 empties in a single user turn. `strip-thinking.py:check_session_quality()` flagged `"empty_responses"` (threshold = 3). The handler `os.remove()`d the active jsonl + removed the entry from `sessions.json`. Cooper's next message hit a brand-new session: the agent responded "Hey Cooper! What's up?" with zero memory of the prior conversation.

The crash-loop-prevention rationale was sound (gateway reloads bloated session → empty responses → flagged → no progress). The implementation was too aggressive. **One bad turn from one user prompt = full memory wipe = "an agent that forgets you after one error is not an agent."**

**The fix (deployed 2026-05-02):** the `empty_responses` path now calls `trim_failed_turns(jsonl_file)` which **walks the trajectory backward, drops only trailing empty assistant messages, and atomic-rewrites the jsonl in place.** User's prior conversation is preserved; only the failed retries are removed. On the next gateway tick the model sees a healthy trajectory and the user's next prompt proceeds normally. Force-archive remains in place for the `error_loop` branch (5+ messages containing literal "SIGKILL"/"OOM"/"empty response") because that's a different signal — multiple user prompts all failing — and represents a real session-level crash.

**Banned patterns** in any cron, hook, watchdog, reconciler step, or admin script that touches session/memory state:

- `os.remove(jsonl_file)` to "clean up" sessions that produced an error in the most recent turn
- Removing entries from `sessions.json` so the gateway treats the next message as a fresh session
- Wholesale rewrite of MEMORY.md (use marker-based `inject_memory_section` / `remove_memory_section`)
- Any "force restart" path that loses live conversation buffers (gateway restart that re-reads from disk is fine; one that nukes the on-disk session is not)
- "Crash-loop prevention" via deletion when trim or compaction would suffice

**Required patterns:**

1. **Trim over nuke.** If the trailing N turns are bad, rewrite the jsonl without those N turns. Anthropic's API requires every `tool_use` to have a matching `tool_result`; if you drop an assistant `tool_use` block, also drop the orphaned `tool_result` in the next turn (and vice versa). Empty-content assistants (`[]`, `""`, `None`, `[{}]`) by definition have no `tool_use`, so they're always safe to drop standalone — but anything more complex demands the orphan check.
2. **Backup before destructive ops.** `_backup_session_file(jsonl_file)` to `~/.openclaw/session-backups/<ts>-<sessionId>.jsonl` BEFORE any modification. Backup retention is `SESSION_BACKUP_RETENTION_DAYS` (currently 7). This is the recovery path of last resort; never bypass it.
3. **Atomic writes.** Always write to `<path>.tmp` and `os.replace()`. Never leave a session jsonl half-written — that's worse than the original problem.
4. **Document the recovery procedure.** For any cron/script that archives sessions, the same script (or a sibling) MUST have a documented "restore session for vm-X" path. If you can't say in one sentence how to undo what your code did, you don't get to ship it.

**Known follow-up that violates this rule and needs the same treatment:** the size-based archival path (`if file_size > MAX_SESSION_BYTES`, currently 200 KB) **still nukes**. A user whose session organically grows past 200 KB loses everything. Fix: compact instead of archive — strip thinking blocks (already done), strip tool results older than the last N turns, prune image base64 from older turns, keep last K healthy turns intact, leave the file in place. Track this as a P1 follow-up.

**Detection rule:** any `os.remove`, `shutil.rmtree`, or file deletion in a script that touches `~/.openclaw/sessions/`, `~/.openclaw/workspace/`, or anything under `~/.openclaw/agents/main/sessions/` (excluding the backups dir cleanup) is a code-review red flag. Justify why trim/compact wasn't sufficient. Default-no.

**Why this is rule 22 and not rule 30-something:** it's the most expensive class of bug in this product. A crashed agent is recoverable (user retries, error message, etc.). A *forgetful* agent destroys the relationship — paying users assume their agent is a persistent companion, and the product's whole value proposition collapses if a single error wipes that. Treat session preservation as a load-bearing feature, not a side-concern.

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
