# PRD: Automated VM Lifecycle Management

**Author:** Cooper Wrenn + Claude  
**Date:** April 2, 2026  
**Status:** Draft — awaiting approval before implementation  
**Priority:** P0 (cost savings of ~$4,500/mo)

---

## 1. Problem Statement

Linode bills hourly for every VM that exists, whether running or powered off. Only **deleted** VMs stop billing. Our current lifecycle never deletes VMs from Linode — it recycles them into a ready pool or marks them "failed" in the DB while the Linode instance keeps running and billing.

**Current fleet (as of April 2, 2026):**

| Status | VMs | Monthly Cost | Notes |
|--------|-----|-------------|-------|
| assigned | 228 | $5,472 | Includes 43 unhealthy + ~133 churned users |
| failed | 68 | $1,632 | Dead VMs nobody is using |
| ready | 16 | $384 | Pool for fast onboarding |
| **Billing total** | **312** | **$7,488/mo** | Everything not yet deleted from Linode |
| terminated (in DB) | 286 | $0 | Already deleted from Linode by ghost detection |

**Paying users:** 95 active/trialing Stripe subscribers + 4 confirmed WLD payers = ~99 paying users.

**The waste:** 312 billing VMs - 99 paying users - 16 ready pool = **~197 VMs serving no paying user = ~$4,728/mo waste.**

## 2. Goal

Every VM on Linode must be justified:
1. Assigned to a paying user (active/trialing Stripe OR confirmed WLD credits > 0), OR
2. In the ready pool (capped, auto-scaled), OR
3. Deleted from Linode

Target state: ~99 assigned (paying) + ~20 ready pool = ~119 VMs = **$2,856/mo** (62% cost reduction).

---

## 3. VM Lifecycle State Machine

### 3.1 States

| State | Meaning | Billing? |
|-------|---------|----------|
| `provisioning` | Cloud-init running, not ready yet | Yes |
| `ready` | In pool, awaiting user assignment | Yes |
| `assigned` | User is using this VM | Yes |
| `failed` | SSH/gateway dead, needs intervention | Yes |
| `terminated` | Deleted from Linode via API | **No** |

**Removed concept:** `suspended` is no longer a meaningful state. Previously, suspended VMs had their gateway stopped but kept billing. Under the new model, a suspended VM should be **deleted** after its grace period expires.

### 3.2 State Transitions

```
                    [PROVISIONING]
                          |
                   success (cloud-init-poll)
                          |
                          v
                      [READY]  <--- pool-monitor provisions new VMs
                        |
                  assignVMWithSSHCheck()
                        |
                        v
                    [ASSIGNED]
                     /    |    \
                    /     |     \
          healthy   unhealthy   churn detected
          (stay)    (heal)      (lifecycle cron)
                                    |
                              grace period
                                    |
                              wipe + delete
                                    |
                                    v
                              [TERMINATED]
                          (deleted from Linode)

                    [FAILED]
                        |
                  recovery attempts (health cron)
                   /              \
              recovered         unrecoverable
                  |                   |
                  v                   v
              [ASSIGNED]        [TERMINATED]
              (restored)     (wipe + delete from Linode)
```

### 3.3 Transition Rules

| From | To | Trigger | Grace Period |
|------|----|---------|-------------|
| provisioning | ready | Cloud-init-poll confirms OpenClaw installed | None |
| provisioning | failed | Cloud-init timeout (30 min) | None |
| ready | assigned | `instaclaw_assign_vm()` RPC | None |
| assigned | terminated | Lifecycle cron: user churned past grace | See Section 5 |
| assigned | failed | Health cron: 6 consecutive SSH + HTTP failures | None |
| failed | assigned | Health cron: auto-recovery succeeds | None |
| failed | terminated | Lifecycle cron: no paying user + unrecoverable | 48 hours |
| ready | terminated | Pool auto-scaler: pool exceeds maximum | None |

---

## 4. Ready Pool Strategy

### 4.1 Auto-Scaling Rules

| Parameter | Value | Env Var |
|-----------|-------|---------|
| Minimum pool size | 10 | `MIN_POOL_SIZE` |
| Maximum pool size | 30 | `MAX_POOL_SIZE` |
| Provision batch | 10 per cycle | `MAX_AUTO_PROVISION` |
| Delete batch | 5 per cycle | `MAX_AUTO_DELETE` |
| Scale-up trigger | ready < MIN_POOL_SIZE | — |
| Scale-down trigger | ready > MAX_POOL_SIZE | — |

### 4.2 Scale-Up Flow (existing, minor changes)

When `ready_count < MIN_POOL_SIZE`:
1. Calculate `needed = MIN_POOL_SIZE - ready_count`
2. Cap at `MAX_AUTO_PROVISION` per cycle
3. Provision via Linode API (snapshot-based for speed)
4. New VMs enter `provisioning` → `ready` via cloud-init-poll

### 4.3 Scale-Down Flow (NEW)

When `ready_count > MAX_POOL_SIZE`:
1. Calculate `excess = ready_count - MAX_POOL_SIZE`
2. Cap at `MAX_AUTO_DELETE` per cycle (circuit breaker)
3. Pick oldest ready VMs first (`ORDER BY created_at ASC`)
4. For each: call Linode `DELETE /linode/instances/{id}`
5. On success: update DB `status = 'terminated'`
6. Log: VM name, IP, age, reason "pool_excess"

### 4.4 Cost Impact

| Pool Size | Monthly Cost | Onboarding Latency |
|-----------|-------------|-------------------|
| 10 VMs | $240/mo | ~0s (instant from pool) |
| 20 VMs | $480/mo | ~0s |
| 30 VMs | $720/mo | ~0s |
| 0 VMs | $0/mo | ~3-5 min (provision on demand) |

**Recommendation:** MIN=10, MAX=30. This gives us buffer for signup spikes while keeping idle cost under $720/mo. If signups consistently exceed 10/day, raise MIN.

---

## 5. Churn Detection & Grace Periods

### 5.1 When Is a User "Churned"?

A user is churned if ALL of the following are true:
1. Stripe subscription status is `canceled` OR (`past_due` for > 7 days)
2. AND no confirmed WLD delegation in the last 30 days
3. AND VM credit_balance = 0 (no remaining WLD overflow credits)

### 5.2 Grace Periods

| Scenario | Grace Period | Rationale |
|----------|-------------|-----------|
| Stripe canceled | 3 days after cancellation | User might re-subscribe; Stripe often has end-of-period access |
| Stripe past_due | 7 days after `past_due_since` | Payment may auto-retry; give user time to fix card |
| WLD credits exhausted | 7 days after credits hit 0 | User may top up |
| No subscription ever + no credits | 3 days after `assigned_at` | Mini app users who paid WLD but credits ran out |
| Failed VM (no paying user) | 48 hours after `status = 'failed'` | Give health cron time to auto-recover |
| Failed VM (paying user) | Never auto-delete | Auto-migrate to new VM instead |

### 5.3 Safety: Who Is NEVER Deleted?

A VM must **never** be deleted if ANY of the following are true:
- Subscription status = `active` or `trialing`
- Confirmed WLD delegation with `confirmed_at` in last 30 days
- VM `credit_balance > 0`
- User was active (sent a message) in the last 7 days regardless of subscription status

---

## 6. Deletion Flow

### 6.1 Pre-Deletion Checklist (ALL must pass)

```
1. ✅ Churn confirmed (Section 5.1 criteria met)
2. ✅ Grace period expired (Section 5.2)
3. ✅ NOT in safety exclusion list (Section 5.3)
4. ✅ Circuit breaker not tripped (< MAX_DELETIONS_PER_CYCLE)
5. ✅ Dry-run logged (if --dry-run mode)
```

### 6.2 Deletion Sequence

```
Step 1: VERIFY — Re-check subscription + WLD + credits + activity
  └─ If ANY safety condition now true → SKIP, log "safety_abort"

Step 2: WIPE — SSH into VM, run full privacy wipe
  └─ Same wipe as configureOpenClaw privacy guard
  └─ Delete: sessions, memory, workspace, browser data, bash_history
  └─ If SSH fails → SKIP deletion, log "wipe_failed", retry next cycle

Step 3: DB CLEANUP — Call instaclaw_reclaim_vm() RPC
  └─ Clears: assigned_to, gateway_token, channels, credits, usage data
  └─ Sets: status = 'terminated'

Step 4: LINODE DELETE — Call DELETE /linode/instances/{provider_server_id}
  └─ If API returns 200/204 → success
  └─ If API returns 404 → already deleted, mark terminated anyway
  └─ If API returns 5xx → RETRY up to 3 times with 5s backoff
  └─ If all retries fail → log "linode_delete_failed", leave as 'failed' status
  └─ NEVER mark terminated in DB unless Linode confirms deletion or 404

Step 5: LOG — Write audit record
  └─ vm_id, vm_name, ip_address, user_email, subscription_status,
     last_active_date, reason, deletion_timestamp
```

### 6.3 Error Handling

| Error | Action |
|-------|--------|
| SSH wipe fails | Skip deletion, retry next cycle |
| Linode API 5xx | Retry 3x with backoff, then skip |
| Linode API 404 | VM already gone — mark terminated |
| DB update fails | Log error, skip (will retry next cycle) |
| Safety check fails mid-flow | Abort immediately, log reason |

### 6.4 What If a User Comes Back After Deletion?

- User re-subscribes or buys WLD credits
- They go through normal onboarding: new VM from ready pool
- configureOpenClaw runs fresh setup
- Previous VM's data is gone (was wiped before deletion)
- This is the expected flow — no different from a new user

---

## 7. The Lifecycle Cron

### 7.1 Overview

**Endpoint:** `POST /api/cron/vm-lifecycle`  
**Schedule:** Every 6 hours (`0 */6 * * *`)  
**Auth:** CRON_SECRET bearer token  
**maxDuration:** 300 seconds  

Separate from health-check cron. Health cron monitors gateway health. Lifecycle cron manages VM cost optimization.

### 7.2 Cron Passes

**Pass 1: Delete Churned User VMs**
```
Query: instaclaw_vms WHERE status = 'assigned'
  JOIN instaclaw_subscriptions ON user_id
  LEFT JOIN instaclaw_wld_delegations ON user_id
For each VM:
  - Check churn criteria (Section 5.1)
  - Check grace period (Section 5.2)
  - Check safety exclusions (Section 5.3)
  - If all pass → run deletion flow (Section 6.2)
  - Cap: MAX_DELETIONS_PER_CYCLE (default 20)
```

**Pass 2: Delete Unrecoverable Failed VMs**
```
Query: instaclaw_vms WHERE status = 'failed'
  AND created_at < NOW() - INTERVAL '48 hours'
  AND (assigned_to IS NULL OR user has no active sub)
For each VM:
  - Skip if assigned to paying user (auto-migration handles those)
  - Run deletion flow (Section 6.2) — skip SSH wipe (VM is dead anyway)
  - Cap: MAX_DELETIONS_PER_CYCLE (shared with Pass 1)
```

**Pass 3: Scale Ready Pool Down**
```
Count: instaclaw_vms WHERE status = 'ready' AND provider = 'linode'
If count > MAX_POOL_SIZE:
  - excess = count - MAX_POOL_SIZE
  - Pick oldest VMs first
  - Delete from Linode, mark terminated
  - Cap: MAX_AUTO_DELETE (default 5 per cycle)
```

**Pass 4: Report**
```
Return JSON:
{
  pass1_deleted: N,
  pass1_skipped_safety: N,
  pass2_deleted: N,
  pass3_pool_trimmed: N,
  fleet_total: N,
  fleet_assigned_paying: N,
  fleet_assigned_churned: N,
  fleet_ready: N,
  fleet_failed: N,
  estimated_monthly_cost: N
}
```

### 7.3 Circuit Breaker

If `pass1_deleted + pass2_deleted > MAX_DELETIONS_PER_CYCLE`:
- STOP all further deletions this cycle
- Send admin alert: "Lifecycle cron circuit breaker tripped — {N} deletions attempted"
- Next cycle will resume

**MAX_DELETIONS_PER_CYCLE default: 20** (env configurable)

This prevents a bug or bad query from mass-deleting the fleet.

---

## 8. Cost Model

### 8.1 Current State (April 2, 2026)

| Category | VMs | Cost/mo | Justified? |
|----------|-----|---------|-----------|
| Assigned to active/trialing sub | ~95 | $2,280 | Yes |
| Assigned to confirmed WLD payer | ~4 | $96 | Yes |
| Ready pool | 16 | $384 | Yes |
| Assigned to canceled users | ~85 | $2,040 | **No** |
| Assigned to past_due users | ~44 | $1,056 | Partial (7-day grace) |
| Failed VMs | 68 | $1,632 | **No** |
| **Total billing** | **312** | **$7,488/mo** | |

### 8.2 Target State (After Lifecycle Cron)

| Category | VMs | Cost/mo |
|----------|-----|---------|
| Assigned to paying users | ~99 | $2,376 |
| Ready pool (MIN=10, MAX=30) | ~20 | $480 |
| Recently churned (in grace period) | ~10 | $240 |
| **Total billing** | **~129** | **~$3,096/mo** |

### 8.3 Savings

| Metric | Before | After | Savings |
|--------|--------|-------|---------|
| Billing VMs | 312 | ~129 | 183 fewer |
| Monthly cost | $7,488 | ~$3,096 | **$4,392/mo** |
| Annual cost | $89,856 | ~$37,152 | **$52,704/yr** |

### 8.4 At Scale (1,000 paying users)

| Metric | Without lifecycle mgmt | With lifecycle mgmt |
|--------|----------------------|-------------------|
| Total VMs | ~1,500+ (history of churn) | ~1,050 (paying + pool) |
| Monthly cost | $36,000+ | $25,200 |
| Waste | $12,000+/mo | <$1,000/mo |

---

## 9. Migration Plan (Current State → New State)

### Phase 0: Audit (before any deletions)

1. Run the lifecycle cron in **dry-run mode** first
2. Review every VM it would delete
3. Verify: zero paying users in the delete list
4. Save audit log to `instaclaw_vm_lifecycle_log` table

### Phase 1: Delete Failed VMs (lowest risk)

- 68 failed VMs, none assigned to paying users
- These have dead gateways, no user is being served
- Delete from Linode in batches of 20
- **Savings: ~$1,632/mo immediately**

### Phase 2: Delete Churned Assigned VMs (medium risk)

- ~85 VMs assigned to canceled users (confirmed in audit)
- ~44 VMs assigned to past_due users (apply 7-day grace)
- Wipe each VM before deletion (privacy)
- Delete in batches of 20, review after each batch
- **Savings: ~$2,040-3,096/mo**

### Phase 3: Enable Automated Lifecycle Cron

- Deploy the lifecycle cron with circuit breaker (max 20/cycle)
- Monitor for 1 week
- Adjust grace periods if needed
- **Ongoing savings: prevents future waste accumulation**

### Phase 4: Pool Auto-Scaling

- Reduce MAX_POOL_SIZE from 20 to 30 (with auto-scale down)
- Monitor onboarding latency
- Adjust MIN/MAX based on signup patterns

---

## 10. Safety Rails

### 10.1 Hard Rules (NEVER violate)

1. **NEVER delete a VM where the assigned user has `subscription.status` = `active` or `trialing`**
2. **NEVER delete a VM where the assigned user has a confirmed WLD delegation (`status = 'confirmed'`) with `confirmed_at` in the last 30 days**
3. **NEVER delete a VM where `credit_balance > 0`**
4. **NEVER delete a VM where the user sent a message in the last 7 days** (check `instaclaw_daily_usage` for `message_count > 0`)
5. **ALWAYS wipe user data before deletion** (SSH wipe + DB cleanup via RPC)
6. **ALWAYS log every deletion** with: vm_id, vm_name, ip, user_email, sub_status, reason, timestamp
7. **Circuit breaker: max 20 deletions per cron cycle** (configurable via env)
8. **Dry-run mode must be run before first live execution**

### 10.2 Audit Table

```sql
CREATE TABLE instaclaw_vm_lifecycle_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  vm_id UUID NOT NULL,
  vm_name TEXT,
  ip_address TEXT,
  user_id UUID,
  user_email TEXT,
  subscription_status TEXT,
  wld_confirmed_last_30d BOOLEAN DEFAULT FALSE,
  credit_balance INTEGER DEFAULT 0,
  last_message_date DATE,
  action TEXT NOT NULL, -- 'deleted', 'skipped_safety', 'skipped_grace', 'wipe_failed', 'linode_delete_failed'
  reason TEXT,
  provider_server_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 10.3 Alerting

| Event | Alert |
|-------|-------|
| Circuit breaker tripped | Admin email immediately |
| Linode API delete failed 3x | Admin email |
| Paying user VM almost deleted (caught by safety rail) | Admin email + Slack |
| Monthly cost exceeds threshold | Admin email |

---

## 11. Rollback Plan

**Linode deletion is permanent. There is no undo.**

This is why the safety rails (Section 10) are critical. The rollback plan is:

1. **If a paying user's VM is accidentally deleted:** They get a new VM from the ready pool on next login. configureOpenClaw runs fresh setup. Their agent memory/sessions are lost (was wiped before deletion). This is the worst-case scenario — equivalent to a fresh start.

2. **If too many VMs deleted (bug in cron):** Circuit breaker limits damage to 20 VMs per cycle. Ready pool auto-provisions to maintain MIN_POOL_SIZE. New users can still onboard.

3. **If Linode API is down:** Deletion flow retries 3x then skips. VM stays in DB as 'failed'. Next cron cycle retries. No data loss.

4. **Emergency stop:** Set `MAX_DELETIONS_PER_CYCLE=0` in env vars to immediately stop all deletions without code deploy.

---

## 12. Implementation Checklist

- [ ] Create `instaclaw_vm_lifecycle_log` audit table (migration)
- [ ] Build `/api/cron/vm-lifecycle` endpoint with all 4 passes
- [ ] Add `MAX_POOL_SIZE`, `MAX_AUTO_DELETE`, `MAX_DELETIONS_PER_CYCLE` env vars
- [ ] Add dry-run mode flag
- [ ] Add pool scale-down logic to pool-monitor (or lifecycle cron)
- [ ] Update `instaclaw_reclaim_vm()` RPC to set `status = 'terminated'` instead of `'provisioning'`
- [ ] Add vercel.json cron entry (`0 */6 * * *`)
- [ ] Add to middleware allowlist
- [ ] Run Phase 0 audit (dry-run)
- [ ] Execute Phase 1 (delete failed VMs)
- [ ] Execute Phase 2 (delete churned VMs)
- [ ] Enable Phase 3 (automated cron)
- [ ] Monitor for 1 week, adjust thresholds
- [ ] Execute Phase 4 (pool auto-scaling)

---

## Appendix A: Existing Code Reference

| Component | File | Current Behavior | Change Needed |
|-----------|------|-----------------|---------------|
| Suspension cron | `app/api/cron/suspend-check/route.ts` | Stops gateway, marks suspended | Replace with deletion after grace |
| Pool monitor | `app/api/cron/pool-monitor/route.ts` | Only provisions, never deletes | Add scale-down (delete excess) |
| Reclaim script | `scripts/_reclaim-safe-vms.ts` | Marks VM as `ready` for reuse | Change to `terminated` + Linode delete |
| Linode provider | `lib/providers/linode.ts` | Has `deleteServer()` but only called manually | Called by lifecycle cron |
| Health cron | `app/api/cron/health-check/route.ts` | Marks failed, never deletes | No change (lifecycle cron handles deletion) |
| VM assignment | `lib/ssh.ts` `assignVMWithSSHCheck()` | Picks from ready pool | No change |
| Cloud-init poll | `app/api/cron/cloud-init-poll/route.ts` | Marks ready or failed | No change |

## Appendix B: Linode API Reference

```
POST   /linode/instances          — Create instance ($0.043/hr from creation)
DELETE /linode/instances/{id}     — Delete instance (billing stops immediately)
POST   /linode/instances/{id}/reboot — Reboot (still billing)
GET    /linode/instances/{id}     — Check status (404 if deleted)
```

**Key fact from Linode meeting:** Powered-off instances still bill. Only deletion stops billing. There is no "hibernate" or "stop billing" state.
