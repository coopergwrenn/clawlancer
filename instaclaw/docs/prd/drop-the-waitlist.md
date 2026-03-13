# InstaClaw: Drop the Waitlist — PRD

## Frictionless Onboarding & Auto-Scaling VM Pool

**Date:** March 13, 2026
**Author:** Cooper Wrenn
**Company:** Wild West Bots LLC

---

## 1. Overview

InstaClaw currently gates new users behind a waitlist + invite code system. Of 3,173 waitlist entries, 3,168 have already been invited — the waitlist is functionally dead. Every step of friction between a visitor and a deployed agent costs conversions. This PRD covers removing the waitlist entirely, enabling one-click frictionless signup from the landing page, and building an auto-scaling VM pool to support open registration without over-provisioning.

### 1.1 Goals

- Eliminate all signup friction: visitor → deployed agent in under 5 minutes
- Replace waitlist email capture with a direct "Get Started" button
- Remove the invite code gate from the signup flow
- Auto-scale the VM pool so there are always ready VMs without manual provisioning
- Enhance the existing real-time spots counter with urgency color tiers
- Preserve ambassador referral tracking (?ref=CODE)
- Zero downtime — existing users and active VMs unaffected

### 1.2 Non-Goals

- Changing the onboarding wizard (bot name, Telegram token, model selection)
- Changing the pricing/plan selection flow
- Changing Stripe billing or trial mechanics
- Migrating existing users or waitlist data

---

## 2. Current State

### 2.1 Current Signup Flow

| Step | Page | What Happens |
|------|------|-------------|
| 1 | Landing page | Enter email → join waitlist → shown position in line |
| 2 | Wait for invite | Admin sends batch invites from waitlist by position (FIFO) |
| 3 | /signup | Enter invite code (XXXX-XXXX-XXXX) → validate → store in cookie |
| 4 | /signup | Click "Continue with Google" → Google OAuth |
| 5 | lib/auth.ts | Read invite cookie, re-validate, create user, consume invite, send welcome email |
| 6 | /connect | Enter Telegram bot token, select model, configure channels |
| 7 | /plan | Select tier (Starter $29 / Pro $99), 3-day free trial |
| 8 | Stripe | Payment → redirect to /deploying. VM assigned immediately (even on trial). |
| 9 | /deploying | Polls every 2s for gateway health. 3-min timeout. Auto-redirect to /dashboard. |

**Total steps:** 9 (including wait time for invite email)
**Friction points:** Email capture, wait for invite, enter invite code, cookie-based invite validation

### 2.2 Current VM Pool Management

- Auto-provisioning cron (pool-monitor): runs every 15 min
- MIN_POOL_SIZE = 2, MAX_AUTO_PROVISION = 3 per cycle
- MAX_TOTAL_VMS = 20 in .env.local (stale — 137 Linode instances exist)
- Fresh Linode cloud-init provisioning: 6–10 minutes to "ready"
- Cloud-init-poll runs every 2 min to check sentinel file
- VM cost: $24/mo per VM (Linode g6-standard-2, 4GB RAM, 2 vCPU)
- Current ready (unassigned) VMs: varies, often as low as 2–3
- Total count query in pool-monitor does NOT filter by status — includes terminated/failed VMs

### 2.3 Existing Spots Counter

A spots counter and API route already exist in production:

- **API:** `app/api/spots/route.ts` — public, returns `{ available: N }` with 30s cache
- **Component:** `components/landing/spots-counter.tsx` — renders "X Spots Open" pill with glass orb animation
- **Rendered in:** `components/landing/hero.tsx` line 117
- **Limitation:** No color tiers, no zero-state messaging, no Linode provider filter

### 2.4 Waitlist Status

- Total entries: 3,173
- Already invited: 3,168
- Not yet invited: 5

**Conclusion:** The waitlist has served its purpose and is now pure friction.

---

## 3. New Signup Flow

### 3.1 New Flow Overview

| Step | Page | What Happens |
|------|------|-------------|
| 1 | Landing page | Click "Get Started" button → redirect to /signup |
| 2 | /signup | Google OAuth (no invite code). ?ref=CODE preserved in cookie if present. |
| 3 | lib/auth.ts | Create user directly (no invite validation). Apply referral if present. |
| 4 | /connect | Enter Telegram bot token, select model, configure channels (unchanged) |
| 5 | /plan | Select tier, 3-day free trial (unchanged) |
| 6 | Stripe | Payment → /deploying. VM assigned immediately (unchanged). |
| 7 | /deploying | Polls for gateway health. Auto-redirect to /dashboard (unchanged). |

**Total steps:** 7 (down from 9, no wait time)
**Friction removed:** Email waitlist, invite code entry, invite email wait, cookie-based validation

### 3.2 Landing Page Hero Changes

**File:** `components/landing/hero.tsx`

**Current layout (top to bottom):**
1. `SpotsCounter` — "X Spots Open" pill (line 117)
2. Headline — "Your Personal AI Agent. Live in Minutes." (line 128)
3. Subtext (line 141)
4. `WaitlistForm` — email input + "Get Early Access" button (line 200)
5. "Already have an invite code? Sign up here" link (line 211)

**New layout:**
1. `SpotsCounter` — enhanced with color tiers (see Section 5)
2. Headline (unchanged)
3. Subtext (unchanged)
4. **"Get Started" button** → links to `/signup` (replaces WaitlistForm)
5. Remove the "Already have an invite code?" link entirely

**Additional changes in hero.tsx:**
- Line 7: Remove `import { WaitlistForm } from "./waitlist-form"`
- Lines 77-84: The top-right "Sign Up" button currently scrolls to `#waitlist-email`. Change to a direct link to `/signup`.
- Lines 46-64: Session-aware nav already shows "Dashboard" for logged-in users. The new "Get Started" button must also use this session check — if logged in, link to `/dashboard` instead of `/signup`.
- Preserve `?ref=CODE` detection: if URL has `?ref=`, store in localStorage before redirecting to `/signup`

### 3.3 Signup Page Changes (/signup)

**File:** `app/(auth)/signup/page.tsx`

The current page has three views:
1. **Waitlist view** (lines 191-263) — shown when `?ref=` present. Email input → POST `/api/waitlist`
2. **Invite code gate** (lines 264-302) — default view. Code input → validate → store cookie
3. **Post-validation** (lines 303-404) — Google OAuth button + optional referral code input

**New page:** Single view — Google OAuth directly.

1. Check URL/localStorage for `?ref=CODE`. If present, auto-validate referral via `/api/ambassador/validate-referral` (existing logic, lines 38-56 — keep this).
2. If referral valid, show "25% off your first month — referred by {name}" banner.
3. Optional referral code input for users without a `?ref=` param (keep existing input, lines 318-364).
4. POST to `/api/invite/store` with referral code only (no invite code) to set the `instaclaw_referral_code` cookie before OAuth redirect.
5. Show "Continue with Google" button immediately — no invite gate.

**Remove entirely:**
- Waitlist view (lines 191-263)
- Invite code gate (lines 264-302)
- `handleValidate()` function (lines 64-87)
- `handleWaitlistSubmit()` function (lines 122+)
- Bottom toggle link between waitlist/invite views (lines 406-441)
- All waitlist-related state: `showWaitlist`, `waitlistEmail`, `waitlistState`, `waitlistPosition`, `waitlistError`
- Invite code state: `code`, `validated`

### 3.4 Auth Changes (lib/auth.ts)

**File:** `lib/auth.ts`

The signIn callback has two phases:
1. **Existing user check** (lines 17-33): Query by `google_id`. If found, `return true`. This runs first and is NOT tangled with invite logic. **No change needed.**
2. **New user creation** (lines 42-206): Currently enforces invite code. This is what changes.

**Remove (lines 42-69):**
```typescript
// Line 44 — cookie read
const inviteCode = cookieStore.get("instaclaw_invite_code")?.value;

// Lines 49-52 — redirect if no invite
if (!inviteCode) {
  return "/auth-error?error=NoAccount";
}

// Lines 54-69 — re-validate invite against DB
const normalizedCode = decodeURIComponent(inviteCode).trim().toUpperCase();
const { data: invite } = await supabase...
if (!invite || !invite.is_active || ...) {
  return false;
}
```

**Keep (line 72-81):** Referral code cookie read + user creation. Change `invited_by` to `null`:
```typescript
const referralCode = cookieStore.get("instaclaw_referral_code")?.value ?? null;

const { error } = await supabase.from("instaclaw_users").insert({
  email: user.email?.toLowerCase(),
  name: user.name,
  google_id: account.providerAccountId,
  invited_by: null,  // was: inviteCode ? decodeURIComponent(inviteCode) : null
  referred_by: referralCode ? decodeURIComponent(referralCode).trim().toLowerCase() : null,
});
```

**Keep (lines 91-163):** Ambassador referral logic — reads `instaclaw_referral_code` cookie, creates referral record, links to ambassador. Untouched.

**Keep (lines 166-170):** Welcome email send. Review copy for waitlist/invite references (see Section 6.7).

**Remove (lines 172-206):** Invite code consumption (`times_used` increment, `used_by` array update). No invite to consume.

**Net change:** ~55 lines removed from signIn callback. User creation flow is otherwise identical.

**Returning users (Section 6.6 edge case):** Already handled. Lines 17-33 check `google_id` before any new-user logic runs. If the user exists, `return true` — they proceed to their session. The dashboard layout redirect (`app/(dashboard)/layout.tsx` lines 68-75) handles routing based on `onboarding_complete`. No additional code needed.

### 3.5 Invite Store Changes (/api/invite/store)

**File:** `app/api/invite/store/route.ts`

Currently requires `code` (invite code) in request body. Modify to make invite code optional — only set the `instaclaw_referral_code` cookie if `referralCode` is provided. Skip the `instaclaw_invite_code` cookie entirely (or set it to empty).

This is the simplest approach — reuse the existing endpoint as a referral cookie setter rather than building a new one.

---

## 4. Auto-Scaling VM Pool

### 4.1 New Pool Parameters

| Parameter | Current | New | Notes |
|-----------|---------|-----|-------|
| MIN_POOL_SIZE | 2 | 20 | Env var, not hardcoded |
| MAX_AUTO_PROVISION | 3 per cycle | 10 per cycle | Env var |
| MAX_TOTAL_VMS | 20 (stale) | 250 | Env var. Note: total count query includes terminated/failed VMs — either filter query or set ceiling accordingly |
| Cron frequency | Every 15 min | Every 5 min | vercel.json change |
| REPLENISH_THRESHOLD | N/A | 10 (triggers burst) | New env var |

### 4.2 Auto-Scaling Logic

**File:** `app/api/cron/pool-monitor/route.ts`

The pool-monitor cron becomes a two-tier system:

**Tier 1: Steady-State Replenishment (every 5 min)**
- Count ready (unassigned, status='ready', provider='linode') VMs
- If count < MIN_POOL_SIZE (20): provision up to MAX_AUTO_PROVISION (10) VMs to bring pool back to 20
- If count >= MIN_POOL_SIZE: do nothing

**Tier 2: Burst Detection (same cron)**
- If ready count < REPLENISH_THRESHOLD (10): treat as burst, provision MAX_AUTO_PROVISION (10) immediately
- Since Vercel crons can't self-trigger a second pass, the 5-min cycle handles sustained bursts naturally — at 10 VMs per cycle, the pool recovers 10 VMs every 5 minutes

**Fix total count query:** The existing total count (line 36-38) queries ALL rows with no status filter. Change to exclude `terminated` and `destroyed` statuses:
```typescript
const { count: totalCount } = await supabase
  .from("instaclaw_vms")
  .select("*", { count: "exact", head: true })
  .not("status", "in", "(terminated,destroyed)");
```

**Vercel function timeout consideration:** `maxDuration = 120` (line 20). At 10 VMs per cycle with sequential Linode API calls (~10s each for create + wait), this is ~100s. Tight but feasible. If needed, reduce MAX_AUTO_PROVISION to 8 or parallelize creation.

For extreme bursts (Product Hunt, etc.), pre-provision manually with `scripts/open-spots.sh 50` before the event.

### 4.3 Environment Variable Migration

All pool parameters should become env vars (currently hardcoded):

```typescript
const MIN_POOL_SIZE = parseInt(process.env.MIN_POOL_SIZE ?? "20", 10);
const MAX_AUTO_PROVISION = parseInt(process.env.MAX_AUTO_PROVISION ?? "10", 10);
const MAX_TOTAL_VMS = parseInt(process.env.MAX_TOTAL_VMS ?? "250", 10);
const REPLENISH_THRESHOLD = parseInt(process.env.REPLENISH_THRESHOLD ?? "10", 10);
```

This allows tuning without code deploys.

### 4.4 Cost Analysis

| Scenario | Monthly Idle Cost |
|----------|------------------|
| 20 ready VMs (steady state) | $480/mo ($24 x 20) |
| 10 ready VMs (after burst, before replenish) | $240/mo |
| 30 ready VMs (after replenish overshoot) | $720/mo (temporary, normalizes to 20) |

**Expected steady-state idle cost:** $480/mo for 20 ready VMs. This is the cost of zero-friction onboarding. At $29/mo minimum per user, 17 new paying users per month covers the buffer cost entirely.

### 4.5 Linode Account Limit

Current Linode account has 137 instances (limit has been raised above default 100). Before launch, contact Linode support to confirm the current ceiling and request an increase to 300+ if needed. This is a 5-minute support ticket.

### 4.6 Snapshot-Based Provisioning (Fast-Follow)

Fresh cloud-init takes 6-10 minutes. Snapshot-based provisioning is near-instant. After launch:

1. Create a golden snapshot of a fully configured, clean VM (OpenClaw installed, Node 22, SSH hardened, all skills deployed)
2. Set LINODE_SNAPSHOT_ID in env
3. Pool-monitor uses snapshot for all new VMs → "ready" in under 2 minutes

This is a high-priority fast-follow, not a launch blocker.

---

## 5. Spots Counter Enhancement

### 5.1 Existing Infrastructure

The spots counter already exists in production:

- **API Route:** `app/api/spots/route.ts` — public endpoint, 30s cache, returns `{ available: N }`
- **Component:** `components/landing/spots-counter.tsx` — fetches from `/api/spots`, renders glass orb pill
- **Middleware:** `/api/spots` is already in the `selfAuthAPIs` list (public, no auth)

No new route or component needs to be created. Both are modified in place.

### 5.2 API Route Changes

**File:** `app/api/spots/route.ts`

Current query counts all ready VMs regardless of provider. Add Linode filter to match pool-monitor:

```typescript
const { count: available } = await supabase
  .from("instaclaw_vms")
  .select("*", { count: "exact", head: true })
  .eq("status", "ready")
  .eq("provider", "linode");
```

Keep existing 30s cache header. Add rate limit comment for documentation but the cache header effectively rate-limits at the CDN level.

### 5.3 Component Display Logic Changes

**File:** `components/landing/spots-counter.tsx`

Add color tiers based on available count:

| Available Count | Display | Style |
|----------------|---------|-------|
| > 50 | Hide counter entirely | — |
| 10-50 | "X Spots Open" | Current style (neutral) |
| 3-9 | "X Spots Open" | Amber orb, amber text tint |
| 1-2 | "Almost gone — X Spots Open" | Red orb, pulsing animation |
| 0 | "Servers restocking — check back shortly" | Gray orb, muted text. "Get Started" button still works — VM provisions on-demand. |

### 5.4 Overlap with /api/vm/pool-status

A separate route `app/api/vm/pool-status/route.ts` also returns ready VM count. This is an admin-facing endpoint. Keep both — `/api/spots` is public-facing with caching, `/api/vm/pool-status` is admin-facing without caching. No merge needed.

---

## 6. Edge Cases & Failure Modes

### 6.1 Zero Ready VMs at Signup

If a user completes Stripe checkout and no ready VMs exist, `assignVMWithSSHCheck()` will fail after 5 retry attempts. Current behavior: deployment times out after 3 minutes on the /deploying page.

**New behavior for launch:** Extend the /deploying page timeout from 3 minutes to 10 minutes. Show "Setting up your server — this may take a few extra minutes" after 3 minutes. The process-pending cron (every 10 min) will catch unassigned users and retry assignment as VMs become ready.

**Mitigation:** The auto-scaling pool is designed so this should virtually never happen. At MIN_POOL_SIZE=20 with burst detection at 10, the pool would need 20+ simultaneous signups in a 5-minute window to exhaust.

**Fast-follow (not launch blocker):** On-demand emergency provisioning — if assignment fails, trigger a Linode API call to provision a VM specifically for this user, with the /deploying page polling until it's ready. This adds significant complexity and is deferred.

### 6.2 Linode API Outage

If Linode's API is down, pool-monitor can't provision new VMs. The existing buffer of 20 ready VMs provides a runway. At current signup rates, 20 VMs covers several days of organic growth. If the buffer drops below 5 and Linode API is unreachable, alert Cooper via the existing AlertCollector system.

### 6.3 Burst Signups (Product Hunt, Viral Post)

Scenario: 50+ signups in 1 hour.

- 20 ready VMs absorb the first wave immediately
- Burst detection triggers at count < 10, provisioning 10 more
- 5-min cron cycle = up to 10 new VMs provisioned every 5 minutes
- Worst case: users 21-30 may wait 6-10 minutes on the /deploying page while their on-demand VM provisions
- Users 30+ see "Servers restocking" but can still complete checkout — their VM will be assigned as soon as one becomes ready

**For planned viral moments** (Product Hunt launch, etc.): manually run `scripts/open-spots.sh 50` to pre-provision before the event.

### 6.4 Ambassador Referrals After Waitlist Removal

Ambassador links (`instaclaw.io?ref=CODE`) must continue working. New flow:

1. Landing page detects `?ref=CODE` in URL params
2. Stores ref_code in localStorage (existing logic in `waitlist-form.tsx` line 29 — migrate to hero or a shared utility)
3. When user clicks "Get Started" → /signup, the signup page reads ref_code from URL params or localStorage
4. Auto-validates referral via `/api/ambassador/validate-referral` (existing logic, `signup/page.tsx` lines 38-56)
5. Sets `instaclaw_referral_code` cookie via modified `/api/invite/store` (referral-only, no invite code)
6. `lib/auth.ts` reads referral cookie during user creation (existing logic, unchanged)
7. `/api/billing/checkout` applies 25% discount for referred users (existing logic, unchanged)

### 6.5 Existing Invite Codes

Outstanding unused invite codes will no longer be required but will still exist in the database. No migration needed — they simply become inert. The `instaclaw_invites` table stays as-is for historical records. Any user who visits /signup with an old invite code bookmark will see the new frictionless flow instead.

### 6.6 Returning Users Clicking "Get Started"

Already handled by existing code — no changes needed.

- `lib/auth.ts` lines 17-33: Checks `google_id` BEFORE any new-user logic. If user exists, `return true` immediately.
- `hero.tsx` lines 46-64: Session-aware nav shows "Dashboard" link instead of "Sign In"/"Sign Up" for logged-in users.
- `app/(dashboard)/layout.tsx` lines 68-75: Redirects to `/connect` if `onboarding_complete=false`.

The new "Get Started" button should also use the session check — if logged in, link to `/dashboard`.

### 6.7 Welcome Email Copy

The welcome email is sent on user creation in `lib/auth.ts` line 166-170 via `sendWelcomeEmail()`. Review the template in `lib/email.ts` for any references to invite codes, waitlist position, or "you've been invited" language. Update copy to reflect the new open-registration flow.

### 6.8 Vercel Function Timeout

`pool-monitor/route.ts` has `maxDuration = 120` (2 minutes). Provisioning 10 VMs sequentially:
- Linode `createServer()`: ~2-5s per call
- Linode `waitForServer()`: polls every 5s, up to 120s — but we only wait for the server to start, not for cloud-init

If `waitForServer()` takes the full 120s for even one VM, the function will timeout. Mitigation:
- Reduce wait timeout per VM to 30s (server should be "running" quickly, cloud-init happens separately)
- If a VM doesn't reach "running" in 30s, skip it and move to the next
- cloud-init-poll cron handles the rest

---

## 7. Implementation: Files to Modify

### 7.1 Codebase Changes

| File | Action | Details |
|------|--------|---------|
| `components/landing/hero.tsx` | MODIFY | Replace WaitlistForm with Get Started button. Update top-right nav "Sign Up" button from scroll-to-email to `/signup` link. Session-aware: show "Dashboard" if logged in. Remove `WaitlistForm` import. |
| `components/landing/waitlist-form.tsx` | DELETE | No longer needed. |
| `components/landing/spots-counter.tsx` | MODIFY | Add color tiers (green/amber/red/gray), zero-state "restocking" message, hide above 50. |
| `app/(auth)/signup/page.tsx` | MODIFY | Remove invite code gate (lines 264-302), waitlist view (lines 191-263), related state and handlers. Show Google OAuth directly with optional referral input. |
| `lib/auth.ts` | MODIFY | Remove invite cookie read + validation (lines 42-69). Remove invite consumption (lines 172-206). Set `invited_by: null`. Keep referral logic and welcome email. |
| `app/api/invite/store/route.ts` | MODIFY | Make invite code optional. Keep referral code cookie functionality. |
| `app/api/spots/route.ts` | MODIFY | Add `.eq("provider", "linode")` filter to match pool-monitor. |
| `app/api/cron/pool-monitor/route.ts` | MODIFY | Read MIN_POOL_SIZE, MAX_AUTO_PROVISION, REPLENISH_THRESHOLD from env vars. Fix total count query to exclude terminated/destroyed. |
| `instaclaw/vercel.json` | MODIFY | Change pool-monitor cron from `*/15 * * * *` to `*/5 * * * *`. |
| `app/(onboarding)/deploying/page.tsx` | MODIFY | Extend timeout from 3 min to 10 min. Add "extra minutes" messaging after 3 min. |
| `app/api/waitlist/route.ts` | MODIFY | Return 410 Gone for any new submissions. Keep route for backwards compatibility. |
| `lib/email.ts` | REVIEW | Check welcome email template for waitlist/invite references. Update copy if needed. |

### 7.2 Environment Variables

| Variable | Value | Scope | Notes |
|----------|-------|-------|-------|
| MAX_TOTAL_VMS | 250 | Vercel Production | Up from 20 (stale). Ceiling for auto-provisioning. Update in Vercel env vars. |
| MIN_POOL_SIZE | 20 | Vercel Production | New env var. Up from hardcoded 2. |
| MAX_AUTO_PROVISION | 10 | Vercel Production | New env var. Up from hardcoded 3. |
| REPLENISH_THRESHOLD | 10 | Vercel Production | New env var. Triggers burst provisioning. |

### 7.3 Files NOT Changed

| File | Reason |
|------|--------|
| `app/(onboarding)/connect/page.tsx` | Onboarding wizard unchanged |
| `app/(onboarding)/plan/page.tsx` | Plan selection unchanged |
| `app/api/billing/checkout/route.ts` | Stripe checkout unchanged (referral discount logic stays) |
| `app/api/billing/webhook/route.ts` | VM assignment logic unchanged |
| `lib/ssh.ts` | `assignVMWithSSHCheck()` unchanged |
| `app/api/vm/configure/route.ts` | VM configuration unchanged |
| `middleware.ts` | `/api/spots` already in selfAuthAPIs. No route name changes. |
| `app/api/invite/validate/route.ts` | Leave in place (dead code). Clean up in fast-follow. |
| `app/api/invite/generate/route.ts` | Leave in place (admin tool). Clean up in fast-follow. |
| `instaclaw_invites` table | No migration. Table stays for historical records. |
| `instaclaw_waitlist` table | No migration. Table stays for historical records. |

---

## 8. Rollout Plan

### 8.1 Pre-Launch (Do First)

1. Contact Linode support — confirm VM limit, request increase to 300+
2. Set env vars on Vercel: `MAX_TOTAL_VMS=250`, `MIN_POOL_SIZE=20`, `MAX_AUTO_PROVISION=10`, `REPLENISH_THRESHOLD=10`
3. Deploy pool-monitor changes first (cron frequency + env var reads)
4. Wait for pool to build up to 20 ready VMs (~30-60 min with 5-min cycles provisioning 10 at a time)
5. Verify 20 ready VMs exist in Supabase before proceeding to frontend changes

### 8.2 Deploy

1. Push all frontend + auth changes in a single commit to preview branch
2. Verify on Vercel preview URL:
   - Landing page shows "Get Started" button (no email input)
   - Spots counter shows real number with correct color tier
   - `/signup` goes straight to Google OAuth (no invite code gate)
   - `?ref=CODE` referral flow works end-to-end
3. Complete one full test signup: landing page → Get Started → OAuth → /connect → /plan → /deploying → /dashboard
4. Verify ambassador referral: test with `?ref=CODE` and confirm discount appears in Stripe checkout
5. Merge to main after preview approval

### 8.3 Post-Launch Monitoring

- Watch pool-monitor logs for first 24 hours — confirm replenishment triggers correctly
- Monitor ready VM count in Supabase — should hover between 15-25
- Set up alert if pool drops below 5 (via existing AlertCollector)
- Track signup conversion rate before/after to quantify the friction reduction
- Monitor `/api/spots` response times and cache hit rates

### 8.4 Fast-Follow (Priority Order)

1. **Linode snapshot** for near-instant provisioning — create golden image, set LINODE_SNAPSHOT_ID
2. **On-demand emergency provisioning** — if assignVMWithSSHCheck fails, trigger Linode API to create a VM specifically for that user
3. **Email capture secondary CTA** — "Get updates" for visitors not ready to sign up (newsletter-style, separate from primary flow)
4. **Dead code cleanup** — remove `/api/waitlist`, `/api/invite/validate`, `/api/invite/generate`, `waitlist-form.tsx` (already deleted but verify no other imports)
5. **Welcome email copy review** — update any waitlist/invite language

---

## 9. Success Metrics

| Metric | Target |
|--------|--------|
| Landing page → signup conversion rate | > 15% (up from ~5% with waitlist) |
| Time from landing page to deployed agent | < 5 minutes |
| Ready VM count (steady state) | 15-25 VMs |
| Zero-VM incidents per month | 0 |
| Monthly idle VM cost | < $600 |
| Pool replenishment time (10 → 20 VMs) | < 15 min (3 cron cycles) |

---

## 10. Build Reference

### 10.1 Key File Paths (Absolute)

**Frontend:**
- `/Users/cooperwrenn/wild-west-bots/instaclaw/components/landing/hero.tsx` (225 lines)
- `/Users/cooperwrenn/wild-west-bots/instaclaw/components/landing/waitlist-form.tsx` (133 lines) — DELETE
- `/Users/cooperwrenn/wild-west-bots/instaclaw/components/landing/spots-counter.tsx` (87 lines)
- `/Users/cooperwrenn/wild-west-bots/instaclaw/app/(auth)/signup/page.tsx` (445 lines)
- `/Users/cooperwrenn/wild-west-bots/instaclaw/app/(onboarding)/deploying/page.tsx`

**Auth:**
- `/Users/cooperwrenn/wild-west-bots/instaclaw/lib/auth.ts` (235 lines)
- `/Users/cooperwrenn/wild-west-bots/instaclaw/app/api/invite/store/route.ts` (39 lines)

**Pool Management:**
- `/Users/cooperwrenn/wild-west-bots/instaclaw/app/api/cron/pool-monitor/route.ts` (205 lines)
- `/Users/cooperwrenn/wild-west-bots/instaclaw/app/api/spots/route.ts` (30 lines)
- `/Users/cooperwrenn/wild-west-bots/instaclaw/instaclaw/vercel.json` (cron schedule)

**Deprecate:**
- `/Users/cooperwrenn/wild-west-bots/instaclaw/app/api/waitlist/route.ts` (133 lines)

**Reference (unchanged but relevant):**
- `/Users/cooperwrenn/wild-west-bots/instaclaw/lib/providers/linode.ts` (284 lines)
- `/Users/cooperwrenn/wild-west-bots/instaclaw/app/api/billing/webhook/route.ts` (VM assignment)
- `/Users/cooperwrenn/wild-west-bots/instaclaw/middleware.ts` (`/api/spots` already public)
- `/Users/cooperwrenn/wild-west-bots/instaclaw/lib/email.ts` (welcome email template)

### 10.2 Key Line References

| What | File | Lines |
|------|------|-------|
| Existing user check (keep) | lib/auth.ts | 17-33 |
| Invite cookie read (remove) | lib/auth.ts | 42-52 |
| Invite re-validation (remove) | lib/auth.ts | 54-69 |
| Referral cookie read (keep) | lib/auth.ts | 72 |
| User creation (modify invited_by) | lib/auth.ts | 75-81 |
| Ambassador referral logic (keep) | lib/auth.ts | 91-163 |
| Welcome email send (keep, review copy) | lib/auth.ts | 166-170 |
| Invite consumption (remove) | lib/auth.ts | 172-206 |
| WaitlistForm render in hero | hero.tsx | 200 |
| WaitlistForm import in hero | hero.tsx | 7 |
| "Sign Up" scroll-to-email button | hero.tsx | 77-84 |
| SpotsCounter render | hero.tsx | 117 |
| "Already have invite?" link | hero.tsx | 211-218 |
| Session-aware nav (dashboard vs sign in) | hero.tsx | 46-64 |
| Invite code gate UI | signup/page.tsx | 264-302 |
| Waitlist view UI | signup/page.tsx | 191-263 |
| Post-validation Google OAuth | signup/page.tsx | 303-404 |
| handleGoogleSignIn (calls /api/invite/store) | signup/page.tsx | 89-120 |
| Referral auto-validate from ?ref= | signup/page.tsx | 38-56 |
| Pool constants (hardcoded) | pool-monitor/route.ts | 22-24 |
| Total count query (needs status filter) | pool-monitor/route.ts | 36-38 |
| Ready count query (Linode filter exists) | pool-monitor/route.ts | 64-69 |
| Provision loop | pool-monitor/route.ts | 82-84 |
| maxDuration = 120 | pool-monitor/route.ts | 20 |
| Spots query (no provider filter) | spots/route.ts | 12-15 |
| Pool-monitor cron schedule | vercel.json | 14-16 |

---

## Appendix A: Exact Code Changes (Before/After)

### A.1 hero.tsx — Full Replacement

**BEFORE (lines 7, 77-84, 194-219):**
```tsx
// Line 7
import { WaitlistForm } from "./waitlist-form";

// Lines 77-84 — top-right "Sign Up" button scrolls to waitlist email
<button
  onClick={() => {
    const el = document.getElementById("waitlist-email");
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(() => el.focus(), 400);
    }
  }}
  className="px-4 py-2 rounded-lg text-sm font-medium cursor-pointer transition-all"
  style={{ /* glass styles */ }}
>
  Sign Up
</button>

// Lines 194-219 — WaitlistForm + "Already have an invite?" link
{/* Waitlist CTA */}
<motion.div ...>
  <WaitlistForm />
</motion.div>

{/* Already have an invite? */}
<motion.p ...>
  Already have an invite code?{" "}
  <Link href="/signup" ...>Sign up here</Link>
</motion.p>
```

**AFTER:**
```tsx
// Line 7 — remove WaitlistForm import entirely
// (SpotsCounter import stays)

// Lines 77-84 — replace scroll-to-email with direct /signup link
<Link
  href="/signup"
  className="px-4 py-2 rounded-lg text-sm font-medium transition-all"
  style={{ /* same glass styles as before */ }}
>
  Get Started
</Link>

// Lines 194-219 — replace WaitlistForm + invite link with Get Started button
{/* Get Started CTA */}
<motion.div
  initial={{ opacity: 0, y: 20 }}
  animate={{ opacity: 1, y: 0 }}
  transition={{ delay: 0.7, duration: 0.7, ease: SNAPPY }}
>
  <div className="relative max-w-md mx-auto w-full">
    <div className="glow-wrap" style={{ width: "auto" }}>
      <div className="glow-border" style={{ width: "auto" }}>
        <div className="glow-spinner" />
        <div className="glow-content" style={{ background: "transparent" }}>
          <Link
            href={session ? "/dashboard" : "/signup"}
            className="block w-full px-8 py-4 text-base font-semibold text-center transition-all rounded-lg"
            style={{
              background: "var(--accent)",
              color: "#ffffff",
            }}
          >
            {session ? "Go to Dashboard" : "Get Started"}
          </Link>
        </div>
      </div>
    </div>
  </div>
</motion.div>

// Remove the "Already have an invite code?" block entirely
```

**Key details:**
- The "Get Started" button reuses the `glow-wrap`/`glow-border`/`glow-spinner` animation from the old WaitlistForm submit button, maintaining visual consistency.
- Session check: if user is logged in, button says "Go to Dashboard" and links to `/dashboard`.
- The `?ref=CODE` localStorage logic currently lives in `waitlist-form.tsx` lines 24-36. This must be migrated to the hero or to a `useEffect` in the landing page. Simplest approach: add a `useEffect` in `hero.tsx` that checks `searchParams.get("ref")` and stores to localStorage.

### A.2 spots-counter.tsx — Add Color Tiers

**BEFORE (line 81):**
```tsx
{spots} {spots === 1 ? "Spot" : "Spots"} Open
```

**AFTER:**
```tsx
// Add helper function at top of component:
function getSpotStyle(count: number) {
  if (count === 0) return { orbColor: "gray", text: "Servers restocking — check back shortly" };
  if (count <= 2) return { orbColor: "red", text: `Almost gone — ${count} ${count === 1 ? "Spot" : "Spots"} Open` };
  if (count <= 9) return { orbColor: "amber", text: `${count} Spots Open` };
  if (count <= 50) return { orbColor: "default", text: `${count} Spots Open` };
  return { orbColor: "hidden", text: "" }; // > 50: hide entirely
}

// In the component:
const style = getSpotStyle(spots);
if (style.orbColor === "hidden") return null;

// Orb radial-gradient colors by tier:
// "default" → current orange (rgba(220,103,67,...))
// "amber"   → rgba(245,158,11,...) — Tailwind amber-500
// "red"     → rgba(239,68,68,...) — Tailwind red-500, add CSS pulsing animation
// "gray"    → current gray (rgba(140,140,140,...))

// Display text:
{style.text}
```

### A.3 signup/page.tsx — Simplified

**BEFORE:** 445 lines with 3 views (waitlist, invite gate, post-validation)

**AFTER:** ~150 lines with 1 view (Google OAuth directly)

```tsx
"use client";

import { useState, useEffect, Suspense } from "react";
import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import Image from "next/image";
import Link from "next/link";

export default function SignupPage() {
  return (
    <Suspense>
      <SignupInner />
    </Suspense>
  );
}

function SignupInner() {
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Referral code (optional)
  const [referralCode, setReferralCode] = useState("");
  const [referralValid, setReferralValid] = useState<boolean | null>(null);
  const [referralName, setReferralName] = useState("");

  // Pre-fill referral code from ?ref= or localStorage
  useEffect(() => {
    const ref = searchParams.get("ref");
    if (ref) {
      setReferralCode(ref);
      try { localStorage.setItem("instaclaw_ref", ref); } catch {}
    } else {
      try {
        const stored = localStorage.getItem("instaclaw_ref");
        if (stored) setReferralCode(stored);
      } catch {}
    }
  }, [searchParams]);

  // Auto-validate referral if present
  useEffect(() => {
    if (!referralCode) return;
    fetch("/api/ambassador/validate-referral", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: referralCode }),
    })
      .then((r) => r.json())
      .then((d) => {
        setReferralValid(d.valid);
        if (d.ambassadorName) setReferralName(d.ambassadorName);
      })
      .catch(() => {});
  }, [referralCode]);

  async function handleGoogleSignIn() {
    setLoading(true);
    setError("");

    try {
      // Store referral code in cookie (if present) before OAuth redirect
      if (referralCode.trim()) {
        const res = await fetch("/api/invite/store", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ referralCode: referralCode.trim() }),
        });
        if (!res.ok) {
          // Non-fatal — referral won't apply but signup can proceed
        }
      }

      await signIn("google", { callbackUrl: "/connect" });
    } catch {
      setError("Network error. Please try again.");
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4"
      style={{ background: "#F5F0EB" }}>
      <div className="w-full max-w-sm space-y-8">
        {/* Logo */}
        <div className="text-center">
          <Link href="/" className="inline-flex items-center gap-1">
            <Image src="/logo.png" alt="Instaclaw" width={44} height={44}
              unoptimized style={{ imageRendering: "pixelated" }} />
          </Link>
        </div>

        {/* Header */}
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight"
            style={{ color: "#333334", fontFamily: "var(--font-serif)" }}>
            Create your account
          </h1>
          <p className="text-base" style={{ color: "#6b6b6b" }}>
            Deploy your personal AI agent in minutes.
          </p>
        </div>

        {/* Referral banner (if valid) */}
        {referralValid === true && referralName && (
          <div className="px-5 py-4 rounded-lg text-center text-sm"
            style={{ background: "#ffffff", border: "2px solid #22c55e", color: "#22c55e" }}>
            ✓ 25% off your first month — referred by {referralName}
          </div>
        )}

        {/* Optional referral input (if no ?ref= auto-filled) */}
        {!searchParams.get("ref") && (
          <div>
            <label className="block text-sm mb-1.5" style={{ color: "#6b6b6b" }}>
              Referral code <span style={{ opacity: 0.6 }}>(optional)</span>
            </label>
            <input
              type="text"
              placeholder="e.g. renata-1"
              value={referralCode}
              onChange={(e) => {
                setReferralCode(e.target.value);
                setReferralValid(null);
                setReferralName("");
              }}
              onBlur={() => {
                if (!referralCode.trim()) return;
                fetch("/api/ambassador/validate-referral", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ code: referralCode.trim() }),
                })
                  .then((r) => r.json())
                  .then((d) => {
                    setReferralValid(d.valid);
                    if (d.ambassadorName) setReferralName(d.ambassadorName);
                  })
                  .catch(() => setReferralValid(false));
              }}
              className="w-full px-4 py-3 rounded-lg text-sm outline-none transition-colors"
              style={{
                background: "#ffffff",
                border: `1px solid ${referralValid === true ? "#22c55e" : referralValid === false ? "#ef4444" : "rgba(0,0,0,0.1)"}`,
                color: "#333334",
              }}
            />
            {referralValid === true && (
              <p className="text-xs mt-1.5" style={{ color: "#22c55e" }}>
                ✓ 25% off your first month{referralName ? ` — referred by ${referralName}` : ""}
              </p>
            )}
            {referralValid === false && referralCode.trim() && (
              <p className="text-xs mt-1.5" style={{ color: "#ef4444" }}>
                Referral code not found
              </p>
            )}
          </div>
        )}

        {error && (
          <p className="text-sm text-center" style={{ color: "#ef4444" }}>{error}</p>
        )}

        {/* Google sign-in — primary CTA */}
        <button
          onClick={handleGoogleSignIn}
          disabled={loading}
          className="w-full px-6 py-4 rounded-lg text-base font-semibold transition-all
            cursor-pointer disabled:opacity-50 flex items-center justify-center gap-3"
          style={{ background: "#ffffff", color: "#333334", border: "1px solid rgba(0,0,0,0.1)" }}
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24">
            {/* Google G icon paths — same as existing */}
          </svg>
          {loading ? "Redirecting..." : "Continue with Google"}
        </button>

        {/* Sign in link */}
        <p className="text-sm text-center" style={{ color: "#6b6b6b" }}>
          Already have an account?{" "}
          <Link href="/signin" className="underline transition-opacity hover:opacity-70"
            style={{ color: "#333334" }}>
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
```

### A.4 lib/auth.ts — Exact Lines to Remove

**Remove lines 35-69 (invite check block):**
```typescript
// REMOVE: lines 35-41 (debug log about falling through to invite check)
logger.error("AUTH_DEBUG: user not found — falling through to invite check", { ... });

// REMOVE: lines 42-52 (cookie read + NoAccount redirect)
const cookieStore = await cookies();
const inviteCode = cookieStore.get("instaclaw_invite_code")?.value;
if (!inviteCode) {
  logger.warn("Sign-in with unregistered email", { ... });
  return "/auth-error?error=NoAccount";
}

// REMOVE: lines 54-69 (invite re-validation)
const normalizedCode = decodeURIComponent(inviteCode).trim().toUpperCase();
const { data: invite } = await supabase...
if (!invite || !invite.is_active || ...) {
  return false;
}
```

**Replace with:**
```typescript
// New user — create account directly
const cookieStore = await cookies();
```

**Modify line 79:**
```typescript
// BEFORE:
invited_by: inviteCode ? decodeURIComponent(inviteCode) : null,

// AFTER:
invited_by: null,
```

**Remove lines 172-206 (invite consumption):**
```typescript
// REMOVE: entire block that reads invite, increments times_used, updates used_by
const { data: inviteToConsume } = await supabase...
await supabase.from("instaclaw_invites").update({
  times_used: (inviteToConsume.times_used ?? 0) + 1,
  used_by: [...(inviteToConsume.used_by ?? []), newUserId],
})...
```

### A.5 pool-monitor/route.ts — Exact Changes

**Replace lines 22-24:**
```typescript
// BEFORE:
const MIN_POOL_SIZE = 2;
const MAX_AUTO_PROVISION = 3;
const MAX_TOTAL_VMS = parseInt(process.env.MAX_TOTAL_VMS ?? "20", 10);

// AFTER:
const MIN_POOL_SIZE = parseInt(process.env.MIN_POOL_SIZE ?? "20", 10);
const MAX_AUTO_PROVISION = parseInt(process.env.MAX_AUTO_PROVISION ?? "10", 10);
const MAX_TOTAL_VMS = parseInt(process.env.MAX_TOTAL_VMS ?? "250", 10);
const REPLENISH_THRESHOLD = parseInt(process.env.REPLENISH_THRESHOLD ?? "10", 10);
```

**Replace lines 36-38 (total count query):**
```typescript
// BEFORE:
const { count: totalCount } = await supabase
  .from("instaclaw_vms")
  .select("*", { count: "exact", head: true });

// AFTER:
const { count: totalCount } = await supabase
  .from("instaclaw_vms")
  .select("*", { count: "exact", head: true })
  .not("status", "in", "(terminated,destroyed,failed)");
```

### A.6 /api/invite/store/route.ts — Exact Changes

**BEFORE (inferred from behavior):**
Requires `code` in request body, sets both `instaclaw_invite_code` and `instaclaw_referral_code` cookies.

**AFTER:**
Make `code` optional. If not provided, skip the invite cookie. Always set referral cookie if `referralCode` provided.

### A.7 vercel.json — Cron Schedule Change

**BEFORE (line 14-16):**
```json
{
  "path": "/api/cron/pool-monitor",
  "schedule": "*/15 * * * *"
}
```

**AFTER:**
```json
{
  "path": "/api/cron/pool-monitor",
  "schedule": "*/5 * * * *"
}
```

### A.8 /api/spots/route.ts — Add Provider Filter

**BEFORE (lines 12-15):**
```typescript
const { count: available } = await supabase
  .from("instaclaw_vms")
  .select("*", { count: "exact", head: true })
  .eq("status", "ready");
```

**AFTER:**
```typescript
const { count: available } = await supabase
  .from("instaclaw_vms")
  .select("*", { count: "exact", head: true })
  .eq("status", "ready")
  .eq("provider", "linode");
```

### A.9 /api/waitlist/route.ts — Deprecation

**BEFORE:** Accepts POST, validates email, inserts into waitlist.

**AFTER:** Return 410 Gone immediately.
```typescript
export async function POST() {
  return NextResponse.json(
    { error: "The waitlist is no longer active. Visit instaclaw.io to get started." },
    { status: 410 }
  );
}
```

Keep the GET handler if one exists (for admin stats). Only deprecate POST.

### A.10 deploying/page.tsx — Timeout Extension

**BEFORE (line 15):**
```typescript
const MAX_POLL_ATTEMPTS = 180; // 180 seconds at 1s intervals
```

**AFTER:**
```typescript
const MAX_POLL_ATTEMPTS = 600; // 10 minutes at 1s intervals
```

**BEFORE (line 18):**
```typescript
const SOFT_TIMEOUT_THRESHOLD = 90; // Show recovery UI at 90s
```

**AFTER:**
```typescript
const SOFT_TIMEOUT_THRESHOLD = 180; // Show "taking longer" message at 3 min
```

Add messaging after soft timeout:
```tsx
{softTimeout && (
  <p style={{ color: "#888" }}>
    Setting up your server — this may take a few extra minutes.
  </p>
)}
```

---

## Appendix B: Visual Mockup — New Hero Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│  [Logo] Instaclaw                              Blog  Sign In  [Get Started] │
│                                                                      │
│                                                                      │
│                        ● 18 Spots Open                               │
│                                                                      │
│                   Your Personal AI Agent.                            │
│                     Live in Minutes.                                 │
│                                                                      │
│          A personal AI that works for you around the clock.          │
│          It handles your tasks, remembers everything, and            │
│          gets smarter every day. Set it up in minutes.               │
│          No technical experience required.                           │
│                                                                      │
│                   ╔═══════════════════╗                              │
│                   ║   Get Started     ║  ← glow animation border    │
│                   ╚═══════════════════╝                              │
│                                                                      │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘

When logged in:
- Top-right: "Blog  [Dashboard]" (no Sign In / Get Started)
- CTA button: "Go to Dashboard" linking to /dashboard

Spots counter color tiers:
- 10-50: neutral (current orange orb)
- 3-9:   amber orb, amber tint
- 1-2:   red orb, pulsing, "Almost gone — X Spots Open"
- 0:     gray orb, "Servers restocking — check back shortly"
- >50:   hidden entirely
```

---

## Appendix C: Localhost Verification Checklist

Run `npm run dev` from `instaclaw/` (port 3001). Verify each item before pushing to preview.

### C.1 Landing Page (localhost:3001)

- [ ] No email input visible anywhere in hero
- [ ] No "Get Early Access" button
- [ ] No "Already have an invite code?" link
- [ ] "Get Started" button visible, styled with glow animation
- [ ] Clicking "Get Started" navigates to `/signup`
- [ ] Spots counter shows real number from `/api/spots` (may be 0 in dev — verify API returns JSON)
- [ ] Top-right nav shows "Blog | Sign In | Get Started" for unauthenticated users
- [ ] If logged in: top-right shows "Blog | Dashboard", CTA shows "Go to Dashboard"
- [ ] Visit `localhost:3001/?ref=test-code` → verify ref stored in localStorage (`instaclaw_ref`)
- [ ] Page loads without console errors
- [ ] All animations play (spots counter, headline, subtext, CTA)
- [ ] Mobile responsive: check at 375px width

### C.2 Signup Page (localhost:3001/signup)

- [ ] No invite code input visible
- [ ] No waitlist email input visible
- [ ] No "Join the Waitlist" button
- [ ] No "Have an invite code? Enter it here" toggle
- [ ] Google OAuth button visible immediately ("Continue with Google")
- [ ] Optional referral code input visible (with "optional" label)
- [ ] Visit `/signup?ref=test-code` → referral auto-populates and validates
- [ ] Entering a valid ambassador referral code shows "25% off" message on blur
- [ ] Entering an invalid code shows "Referral code not found" on blur
- [ ] Clicking "Continue with Google" initiates OAuth flow
- [ ] Page loads without console errors

### C.3 Auth Flow (requires Google OAuth configured in dev)

- [ ] New user (no existing account): OAuth → user created in `instaclaw_users` → redirect to `/connect`
- [ ] `invited_by` column is NULL for new user
- [ ] `referred_by` column has referral code if one was provided
- [ ] Welcome email fires (check Resend logs or local email trap)
- [ ] Existing user: OAuth → redirect to dashboard (no duplicate user created)
- [ ] User with `?ref=CODE`: referral cookie set, applied during user creation

### C.4 Pool Monitor (verify in dev via curl)

- [ ] `curl localhost:3001/api/cron/pool-monitor -H "Authorization: Bearer $CRON_SECRET"` returns JSON
- [ ] Response includes `MIN_POOL_SIZE`, `MAX_AUTO_PROVISION` from env vars (not hardcoded 2/3)
- [ ] Total count excludes terminated/destroyed/failed VMs

### C.5 Spots API

- [ ] `curl localhost:3001/api/spots` returns `{ "available": N }`
- [ ] Response has `Cache-Control: public, s-maxage=30, stale-while-revalidate=60` header
- [ ] Query filters by `provider = 'linode'`

### C.6 Waitlist Deprecation

- [ ] `curl -X POST localhost:3001/api/waitlist -H "Content-Type: application/json" -d '{"email":"test@test.com"}'` returns 410 Gone

### C.7 Build Check

- [ ] `npm run build` completes clean (no TypeScript errors)
- [ ] No unused imports (especially `WaitlistForm` in hero.tsx)
- [ ] No references to deleted `waitlist-form.tsx`

### C.8 Regression Checks

- [ ] `/signin` page still works (existing users can sign in)
- [ ] `/dashboard` loads for authenticated users
- [ ] `/connect` onboarding page loads
- [ ] `/plan` page loads
- [ ] Ambassador `/ambassador` page still works
- [ ] Admin `/admin/invites` page still loads (invite system is legacy but shouldn't crash)

---

## Appendix D: Welcome Email Audit

**File:** `lib/email.ts` lines 391-423 (`sendWelcomeEmail`)

**Current copy (verified clean):**
- Subject: "Welcome to InstaClaw!"
- Body: "Your InstaClaw account has been created. You're one step away from deploying your own personal AI agent."
- CTA: "Start Setup" → links to `/connect`
- Footer: "All plans include a 3-day free trial."

**No invite/waitlist references found.** No copy changes needed. The welcome email is already written for the frictionless flow.

The separate `buildInviteEmailHtml()` (line 49) and `sendWaitlistUpdateEmail()` (line 485+) functions remain in `email.ts` as dead code. They are not called from any active flow after this change. Clean up in fast-follow.
