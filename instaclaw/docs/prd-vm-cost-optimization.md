# PRD — VM Cost Optimization

**Author**: Cooper Wrenn (drafted with Claude)
**Date**: 2026-04-27
**Status**: Phase 1 complete. Phases 2 & 3 awaiting approval before implementation.

---

## TL;DR

Cost audit on 2026-04-27 found **$3,910/mo of waste** out of a $7,670/mo Linode bill (51% of every dollar going to infra that wasn't serving paying users). This PRD organizes the cleanup into three phases:

| phase | scope | status | $/mo saved | $/yr |
|---|---|---|---|---|
| **1. Orphan deletion (one-shot)** | 57 abandoned/never-tracked VMs | ✅ **DONE 2026-04-27** | $1,638 | $19,656 |
| **2. vm-lifecycle cron fix** | Stop the leak — prevent future orphan accumulation | ⏳ awaiting approval | (preventive) | (preventive) |
| **3. Freeze/thaw pattern** | Suspend → snapshot → delete; restore on reactivation. ~70 currently-paid-for-but-idle VMs. Net of ~$37/mo image storage. | ⏳ awaiting approval | $1,993 | $23,916 |
| **4. Drift detection / monitoring** | Daily cost-audit cron + alerting. Prevents recurrence — no direct savings, makes the savings sticky. | ⏳ awaiting approval | (preventive) | (preventive) |
| **Combined** | | | **~$3,631/mo** | **~$43,572/yr** |

---

## Critical safety rules — apply to ALL phases

These are non-negotiable. A violation = a paying user has their agent destroyed. The rules:

1. **NEVER delete, freeze, snapshot, or modify ANY VM with an active or trialing Stripe subscription.** Re-check Stripe status immediately before every action — never trust cached state in the DB.
2. **NEVER touch ANY VM with user activity in the last 7 days.** Activity = messages in `instaclaw_chat_messages`, proxy hits in `instaclaw_vms.last_proxy_call_at`, telegram message activity in session files, heartbeat events, OR SSH-detected activity in `~/.openclaw/agents/main/sessions/` or `~/.openclaw/workspace/` files. Use the union of all these signals — any one is enough to skip.
3. **NEVER touch ANY VM whose user has WLD credit balance > 0.** This is World mini app users with paid balance — they're effectively pre-paying customers.
4. **For freeze/thaw: ALWAYS snapshot BEFORE deleting.** If the snapshot fails for ANY reason, SKIP the VM entirely. Never delete without a verified `image.status === "available"`.
5. **NEVER freeze ANY VM that owns an active Bankr token launch** (i.e., `bankr_token_address IS NOT NULL` AND token still trading). The user's Bankr private key lives in `~/.openclaw/.env` on the VM disk — freezing temporarily blocks fee claims. Either (a) require a 7-day "we're about to freeze your token-bearing agent" warning email and explicit user opt-in, or (b) skip these VMs entirely until policy is set. Default: skip.
6. **NEVER freeze ANY VM in `status='provisioning'` or `status='configuring'`.** Mid-flight VMs have inconsistent disk state — snapshot would be unrecoverable. Wait until status stabilizes.
7. **NEVER use one user's frozen image to provision another user's VM.** Personal images are STRICTLY per-user (the disk contains their workspace, sessions, encrypted credentials). Cross-contamination = catastrophic data leak. The thaw code must filter by `assigned_to=user_id` AND verify the image label matches the expected user before booting.
8. **Log every action with full audit trail**: user_id, user email, VM name, linode ID, action taken, reason, timestamp, decision-maker (script name + git SHA + run UUID). Append-only — never UPDATE log rows. Store in `instaclaw_vm_lifecycle_log` (existing table — extend its schema if needed).
9. **Dry-run EVERYTHING before execute.** No `--execute` flag without a preceding `--dry-run` review. CLAUDE.md Rule 4 already mandates this; reaffirming for emphasis.
10. **Per-VM lifecycle lock during freeze/thaw operations.** Add `lifecycle_locked_at` column to `instaclaw_vms`. SET to NOW() before starting freeze/thaw, CLEAR on completion. Skip any VM with a non-null `lifecycle_locked_at` < 15 minutes old (in flight) or alert if > 15 min (stuck — investigate). Prevents race between vm-lifecycle freezing and a Stripe webhook thawing simultaneously.
11. **When in doubt, SKIP.** We can always clean up more later. We can never un-delete a paying user's data.

These rules supersede any optimization goal. Saving money is worth zero if it costs us a customer.

---

## Phase 1 — Orphan deletion (DONE)

### What we deleted

57 VMs across 2 categories, all verified silent and abandoned:

**Category 1 — DB_DEAD_LINODE_ALIVE (26 VMs, $739/mo)**

DB row explicitly said `status='terminated'` or `'failed'`, but Linode kept billing us. These are leftovers from past `assignVMWithSSHCheck()` rejection paths and `health-check.ts` ghost-VM detection that marked DB rows abandoned but never called Linode DELETE.

15 of the 26 had `health_status='configure_failed'` — provisioning attempts from ~21 days ago that the configureOpenClaw script bailed on partway through. Linode had already created the instance, billing started, and we never cleaned up.

**Category 2 — NOT_IN_DB (31 VMs, $899/mo)**

Linode billing for VMs with no `instaclaw_vms` row at all. All `instaclaw-vm-NNN` labelled, all 18-21 days old, all with the `instaclaw` tag. Looks like a botched bulk-provision wave around 2026-04-05 to 2026-04-10 that created Linodes but never inserted DB rows. SSH check confirmed: 30 of 31 silent (no recent session/workspace activity); 1 unable to authenticate at all (snapshot keys broken).

The 3 protected infra VMs (clob-proxy Toronto, clob-proxy Osaka, instaclaw-monitoring) were correctly identified and skipped.

### Final results

```
DONE: deleted=57   failed=0   skipped_infra=3   saved=$1,638/mo
Total Linode bill: $7,670/mo → $6,032/mo (21% reduction)
Annualized: $19,656 saved/yr
Full log:      /tmp/cleanup-2026-04-27/execute.log
Script:        instaclaw/scripts/_cleanup-orphan-vms.ts
Executed:      2026-04-27
```

No paying users affected. No support tickets generated.

---

## Phase 2 — vm-lifecycle cron fix (PREVENTIVE)

### Problem

The current `app/api/cron/vm-lifecycle/route.ts` (runs every 6h) has three structural defects that allowed Phase 1's $1,638/mo of waste to accumulate over weeks:

**Bug 1: Query is one-directional (DB → Linode only).**
```typescript
.from("instaclaw_vms")
.eq("health_status", "suspended")
.not("suspended_at", "is", null);
```
Cron only finds VMs *already marked suspended in the DB*. It cannot discover:
- VMs where DB says `terminated`/`failed` but Linode still alive (Cat 1 from Phase 1 — invisible)
- VMs with no DB row at all (Cat 2 from Phase 1 — invisible)
- Suspended VMs with NULL `suspended_at` (filter explicitly excludes them)

**Bug 2: `world_id_verified` blanket-skip protects cancelled users forever.**
```typescript
if (user?.world_id_verified || user?.world_wallet_address) {
  report.pass1_skipped_safety++;
  continue;
}
```
Since AgentBook integration shipped (March 2026), the majority of users have `world_id_verified=true`. This blanket-protects them from cleanup even after their subscription is cancelled. Suspended VMs accumulate monotonically.

**Bug 3: Grace period (3-7 days) is moot because protections fire first.**
Even with a tighter grace, the World ID + credit-balance + WLD-delegation skips kill 80%+ of suspended VMs before grace check matters.

### Solution

Three changes to `app/api/cron/vm-lifecycle/route.ts`:

**Change 1: Add Pass -1 (Linode → DB reconciliation, runs FIRST).**

Pseudocode:
```typescript
// Pass -1: List every running Linode, find any without a healthy DB row.
const allLinodes = await listAllLinodeInstances();
for (const linode of allLinodes) {
  const dbRow = vmsByProviderServerId.get(String(linode.id));

  if (PROTECTED_INFRA_LINODE_IDS.has(String(linode.id))) continue;

  // Sub-case A: DB row exists but says terminated/failed → Linode is the orphan
  if (dbRow && ["terminated", "failed", "destroyed"].includes(dbRow.status)) {
    if (await passesSafetyChecks(dbRow)) {
      await deleteLinode(linode.id);
      await markDbDestroyed(dbRow.id);
      log({ action: "delete_db_dead_orphan", ... });
    }
    continue;
  }

  // Sub-case B: No DB row at all → strict SSH activity check before delete
  if (!dbRow) {
    const sshActive = await sshHasRecentActivity(linode, 7); // 7-day window
    if (sshActive) {
      log({ action: "skip_orphan_active", ... });
      continue;
    }
    await deleteLinode(linode.id);
    log({ action: "delete_no_db_orphan", ... });
    continue;
  }

  // Sub-case C: DB row healthy → existing passes handle it
}
```

The protected-infra list lives in a constant (or, better, a new table `instaclaw_protected_resources` for runtime control without redeploy).

**Change 2: Drop the `world_id_verified` blanket-skip for suspended VMs.**

Replace lines 244-256 of `vm-lifecycle/route.ts` with: only skip if subscription is `active` or `trialing`. World ID verification status is no longer a deletion blocker — it shouldn't be (verifying doesn't pay our hosting bill).

Compromise: keep the credit-balance > 0 skip (legit — those users paid for credits even if their sub lapsed). Keep WLD delegation confirmed skip (legit per legal/compliance discussion when WDP 71 shipped). Keep Cooper's protected-user list. Drop only the World ID skip.

**Change 3: Tighten grace period to 30 days uniformly.**

Replace `CANCELED_GRACE_DAYS=3, PAST_DUE_GRACE_DAYS=7, NO_SUB_GRACE_DAYS=3` with `GRACE_DAYS=30` for all three cases. This matches the data preservation window we communicate to users and removes confusing per-status branching.

Optional 4th change: when Pass -1 deletes a Linode without a DB row, write a forensic log entry to a new `instaclaw_orphan_deletion_log` table including the Linode `created` timestamp and tags so we can investigate why no DB row was ever inserted. This catches the bug class instead of just papering over it.

### Implementation plan

Branch name: `phase2-vm-lifecycle-fix`

Commits (one per logical change):
1. `feat(vm-lifecycle): add Linode → DB reconciliation pass for orphan detection`
2. `fix(vm-lifecycle): drop world_id_verified blanket-skip; tighten grace to 30d uniform`
3. `feat(vm-lifecycle): write orphan-deletion forensic logs to new audit table`
4. (Migration) `add instaclaw_orphan_deletion_log table`

Verification:
- TypeScript: `npx tsc --noEmit` clean
- Manual dry-run: add `?dryRun=1` query param to the cron route; hit it with `CRON_SECRET` and inspect the response. Should show what it WOULD delete on the next real fire.
- Vercel preview: push branch, wait for preview URL, hit `/api/cron/vm-lifecycle?dryRun=1`, verify expected counts.
- Approval gate: do not merge to main until Cooper reviews the dry-run output.

Rollback: revert the merge commit. The new audit table and forensic log columns are additive.

---

## Phase 3 — Freeze/thaw pattern (BIGGEST SAVINGS)

### Problem

After Phase 1 there are still:
- 52 suspended VMs (cancelled subs) = $1,508/mo
- 18 hibernating VMs (paused subs) = $522/mo
- **Total: 70 VMs × ~$29/mo = ~$2,030/mo paid for users not actively using their agent**

Linode charges for instance-hours regardless of CPU activity. Powering off does NOT save money — only deletion does. So as long as we keep these 70 VMs alive "just in case the user comes back," we burn $2,030/mo.

The vm-lifecycle cron (even after Phase 2 fix) will ultimately delete suspended VMs after 30 days. But that deletes their **data** along with the instance. The user can't reactivate — they have to start over.

### Solution: snapshot before delete; restore on reactivation

Per-user **personal snapshots** preserve the user's VM disk state (workspace files, sessions, skills, encrypted Bankr credentials, agent-named configuration) at a fraction of the cost:

| state | monthly cost per user |
|---|---|
| Running VM (g6-dedicated-2) | $29.00 |
| Linode private image storage (avg ~5GB compressed) | ~$0.50 |
| **Savings per frozen user** | **~$28.50** |

70 users × ~$28.50/mo ≈ **$1,995/mo saved**.

### Architecture

```
       FREEZE                             THAW
  ┌──────────────────┐         ┌──────────────────────┐
  │ User cancels /   │         │ User reactivates    │
  │ pauses sub       │         │ (Stripe webhook)    │
  └────────┬─────────┘         └────────┬─────────────┘
           ▼                            ▼
  ┌─────────────────┐          ┌─────────────────────┐
  │ vm-lifecycle    │          │ Reactivation route  │
  │ identifies VM   │          │ checks for          │
  │ for freeze      │          │ frozen_image_id     │
  └────────┬────────┘          └────────┬────────────┘
           ▼                            ▼
  ┌─────────────────┐          ┌─────────────────────┐
  │ POST /v4/images │          │ POST /v4/linode/    │
  │ disk_id=...     │          │ instances           │
  │ → image_id      │          │ image=frozen_image  │
  └────────┬────────┘          └────────┬────────────┘
           ▼                            ▼
  ┌─────────────────┐          ┌─────────────────────┐
  │ Wait status=    │          │ Wait running        │
  │ available       │          │ Verify SSH alive    │
  └────────┬────────┘          │ Update DB:          │
           ▼                   │  status=assigned    │
  ┌─────────────────┐          │  health=healthy     │
  │ DB.update:      │          │  frozen_image_id    │
  │  status=frozen  │          │   →NULL             │
  │  health=frozen  │          │ Delete the image    │
  │  frozen_image_id│          │ (no longer needed)  │
  │   = image_id    │          └─────────────────────┘
  │  frozen_at=now()│
  └────────┬────────┘
           ▼
  ┌─────────────────┐
  │ DELETE /v4/     │
  │ linode/         │
  │ instances/{id}  │
  └─────────────────┘
```

### DB schema additions

`instaclaw_vms` gains 3 columns:

```sql
ALTER TABLE instaclaw_vms
  ADD COLUMN frozen_image_id TEXT,        -- e.g. "private/38458138"; NULL when not frozen
  ADD COLUMN frozen_at TIMESTAMPTZ,        -- when the freeze happened
  ADD COLUMN frozen_image_size_mb INT;    -- for cost tracking + verification
```

Status taxonomy:

| current | new |
|---|---|
| `status='assigned'` + `health='suspended'` | (unchanged — entry state) |
| (no equivalent) | `status='frozen'` + `health='frozen'` + `frozen_image_id=...` |
| `status='terminated'` | (terminal — no frozen image; data lost) |

### Freeze flow (in `vm-lifecycle/route.ts`)

```typescript
async function freezeVM(vm: VMRow): Promise<{ success: boolean; reason: string }> {
  // 1. Re-check Stripe — never freeze if sub went active
  if (await userHasActiveSubscription(vm.assigned_to)) {
    return { success: false, reason: "active subscription" };
  }
  // 2. Re-check 7-day activity — never freeze if user came back
  if (await hadActivityIn7d(vm)) {
    return { success: false, reason: "recent activity" };
  }
  // 3. Re-check WLD credit balance > 0
  if (await wldCreditBalance(vm.assigned_to) > 0) {
    return { success: false, reason: "WLD credits" };
  }

  // 4. Get the disk ID
  const disks = await linode.getDisks(vm.provider_server_id);
  const ext4 = disks.find(d => d.filesystem === "ext4");
  if (!ext4) return { success: false, reason: "no ext4 disk" };

  // 5. Power off (required for clean snapshot)
  await linode.shutdown(vm.provider_server_id);
  await linode.waitForOffline(vm.provider_server_id, 60_000);

  // 6. Create the snapshot
  const image = await linode.createImage({
    disk_id: ext4.id,
    label: `instaclaw-frozen-${vm.name}-${Date.now()}`,
    description: `Frozen VM for ${vm.name} (user ${vm.assigned_to}). Created by vm-lifecycle freeze pass on ${new Date().toISOString()}.`,
  });
  await linode.waitForImageAvailable(image.id, 600_000);

  // 7. CRITICAL: verify the image is actually available before deleting the instance
  const verify = await linode.getImage(image.id);
  if (verify.status !== "available") {
    // Snapshot failed — do NOT delete the VM. Restart it instead.
    await linode.boot(vm.provider_server_id);
    return { success: false, reason: `snapshot status=${verify.status}, NOT deleting` };
  }

  // 8. Update DB FIRST — record the frozen state before destruction
  await db.update(vm.id, {
    status: "frozen",
    health_status: "frozen",
    frozen_image_id: image.id,
    frozen_at: new Date().toISOString(),
    frozen_image_size_mb: verify.size,
  });

  // 9. NOW it's safe to delete the instance
  await linode.deleteInstance(vm.provider_server_id);

  // 10. Audit log
  await auditLog({
    action: "freeze_complete",
    user_email: await getUserEmail(vm.assigned_to),
    vm_name: vm.name,
    linode_id: vm.provider_server_id,
    image_id: image.id,
    image_size_mb: verify.size,
    reason: vm.health_status === "suspended" ? "30d post-suspend" : "30d post-hibernate",
  });

  return { success: true, reason: "frozen" };
}
```

Critical safety: **steps 6-8 are ordered carefully.** We update the DB to point at the new image BEFORE deleting the instance. If anything throws between image creation and instance deletion, the image still exists and the VM still exists — we lose nothing, just have a duplicate image to clean up later. We never delete a VM whose snapshot we haven't verified `status='available'`.

### Thaw flow (in subscription-reactivation handler)

When Stripe webhook fires `invoice.paid` (re-subscription) or `customer.subscription.resumed`:

```typescript
async function thawUserVM(userId: string): Promise<{ success: boolean; vmId?: string }> {
  // Find the user's frozen VM
  const { data: frozen } = await db.from("instaclaw_vms")
    .select("*")
    .eq("assigned_to", userId)
    .eq("status", "frozen")
    .not("frozen_image_id", "is", null)
    .single();

  if (!frozen) return { success: false }; // No frozen VM — issue a fresh one

  // Provision a new instance from the user's PERSONAL snapshot (not the fleet base)
  const newInstance = await linode.createInstance({
    label: frozen.name,
    region: frozen.region,
    type: "g6-dedicated-2",
    image: frozen.frozen_image_id,   // ← personal image, not fleet snapshot
    root_pass: generateRootPass(),
    authorized_keys: [INSTACLAW_DEPLOY_KEY],
    booted: true,
    tags: ["instaclaw"],
  });

  // Wait for SSH-reachable
  await waitForRunning(newInstance.id);
  const sshOk = await waitForSSH(newInstance.ipv4[0], 180_000);
  if (!sshOk) {
    // Thaw failed mid-flight — DO NOT clean up the snapshot, leave for retry
    return { success: false };
  }

  // Update DB — VM is back, clear the frozen state
  await db.update(frozen.id, {
    status: "assigned",
    health_status: "healthy",
    provider_server_id: String(newInstance.id),
    ip_address: newInstance.ipv4[0],
    frozen_image_id: null,
    frozen_at: null,
    frozen_image_size_mb: null,
  });

  // ONLY NOW delete the personal image — VM is verified back online
  await linode.deleteImage(frozen.frozen_image_id);

  // Audit log
  await auditLog({
    action: "thaw_complete",
    user_email: await getUserEmail(userId),
    vm_name: frozen.name,
    linode_id_old: frozen.provider_server_id,
    linode_id_new: String(newInstance.id),
    image_id: frozen.frozen_image_id,
    duration_ms: ...,
  });

  return { success: true, vmId: frozen.id };
}
```

### Edge cases & gotchas

**1. What if the user's data in workspace is sensitive (Bankr keys, etc.)?**
Snapshot includes the entire ext4 disk including `~/.openclaw/.env` and skill credentials. These are ALREADY on the Linode disk in the running state — freezing doesn't change exposure. The image inherits the same encryption-at-rest as the running disk. No additional risk.

**2. What if freeze fails partway? (snapshot created but DELETE instance fails)**
Acceptable failure mode — VM stays running, we have a wasted image that costs $0.50/mo. The next vm-lifecycle pass will try again. Audit log catches it for cleanup.

**3. What if thaw fails? (image gone, image corrupt, etc.)**
This is the scariest case. Mitigation:
- Pre-flight check: when freezing, verify `image.status === 'available'` before proceeding to delete.
- Image retention: do NOT delete the image until thaw VERIFIES the new instance is SSH-reachable AND configureOpenClaw confirms healthy.
- Fallback: if thaw fails, leave the image in place for manual recovery. Send admin alert.
- Email user: "Welcome back! We're restoring your agent. This usually takes 3-5 minutes." Set expectations.

**4. Linode image storage limits**
Linode allows 6 user-created images by default per account, with paid storage at $0.10/GB/mo. We need to confirm our quota is high enough for ~70 frozen images. **OPEN QUESTION** — Cooper to verify with Linode.

**5. Thaw latency**
Provisioning a new instance from an image takes ~3-5 minutes. During that window, the user thinks "their agent is broken." Mitigations:
- Pre-warm: when Stripe webhook fires, start the thaw immediately (don't wait for the user to send a message).
- UX: dashboard shows "Reactivating your agent... ~5 min" with a progress indicator.
- Telegram: send a message via the bot token when ready: "Hey, I'm back! Thanks for reactivating."

**6. Re-freezing a thawed user**
If a thawed user re-cancels, the cycle repeats. No issue — each freeze creates a new image at that moment's state.

**7. Hibernating users get the same treatment as suspended?**
No — slightly different. Suspended = subscription cancelled (we expect them gone). Hibernating = user explicitly paused, planning to come back. Same freeze mechanism BUT thaw is automatic (on subscription resume) AND we keep the image longer (90 days vs 30 days for suspended). After 90 days hibernating, transition to suspended → eventually delete image too.

**8. Migration of existing 52 suspended + 18 hibernating**
For each existing target VM: run freeze flow as if vm-lifecycle just identified them. Already documented above. Initial batch: dry-run + manual review + approval. Subsequent steady-state: vm-lifecycle handles automatically.

### Implementation plan

Branch name: `phase3-freeze-thaw`

Commits:
1. `feat(db): add frozen_image_id, frozen_at, frozen_image_size_mb to instaclaw_vms`
2. `feat(linode): add createImage, deleteImage, getImage, waitForImageAvailable provider methods`
3. `feat(vm-lifecycle): freeze pass — snapshot + delete after grace period`
4. `feat(stripe-webhook): thaw on customer.subscription.resumed and invoice.paid`
5. `feat(scripts): _freeze-existing-vms.ts dry-run for the 70-VM initial batch`
6. `feat(audit): instaclaw_vm_lifecycle_log gains action='freeze' and 'thaw' rows`

Verification:
- TypeScript clean
- Migration applied to a fresh Supabase preview branch
- Dry-run script: `npx tsx scripts/_freeze-existing-vms.ts` — outputs the 70-VM target list with safety-rule passes/fails
- Manual single-VM test: pick ONE non-paying test VM (Cooper's old throwaway), freeze it, verify image created, verify instance gone, verify DB updated, then thaw it and verify the agent is back
- Approval gate: do not run on real users' VMs until single-VM end-to-end test passes AND Cooper reviews the dry-run target list

Rollback: revert the merge commit. Pre-existing frozen VMs remain frozen until manually thawed via admin endpoint. The frozen_image_id columns are nullable, harmless when unused.

### Open questions for Cooper

1. **Linode image quota**: do we need to upgrade the per-account image limit to handle ~70 frozen images? Need confirmation before we start freezing.
2. **Hibernation policy**: 90 days hibernating before transitioning to suspended? Or shorter?
3. **Thaw notification UX**: in-app banner only, or also push a Telegram message? (Telegram may not work if bot token rotated since freeze.)
4. **Image cost accounting**: at scale (e.g. 1000 frozen users), $500/mo of image storage is real money. Worth tracking in a dashboard.
5. **What about VMs whose users have been gone for 12+ months?** At what point do we delete the snapshot too and accept data loss? Suggest: 365 days frozen → email user warning "we're going to delete your agent's data in 30 days unless you reactivate" → delete image after 395 days. Make this explicit policy.

---

## Phase 4 — Drift detection & cost monitoring (PREVENTS RECURRENCE)

The reason Phase 1's $1,638/mo of waste accumulated for weeks was *we didn't know it was happening*. The vm-lifecycle cron logged silently to nowhere humans look. No alert fires when actual Linode burn diverges from expected.

### What we need

**1. Daily reconciliation cron** (`/api/cron/cost-audit`, runs 0 9 \* \* \* — once daily at 9 AM EST):
- List all running Linodes from API
- Categorize against DB exactly like the cleanup script
- Compute expected burn = (active assigned + ready pool + protected infra) × tier cost
- Compute actual burn = sum(cost(vm.type) for all running)
- If `actual > expected * 1.10` (10% drift), send admin email
- Always write a `instaclaw_cost_audit_daily` row with the breakdown for trend graphs

**2. Real-time alerting** (in-line with existing `AlertCollector`):
- vm-lifecycle freeze pass fails for 3+ VMs in one cron run → admin alert
- Image storage quota approaches 80% of Linode account limit → admin alert
- Frozen image age exceeds policy (e.g. >365 days) → admin alert + email user

**3. Dashboard page** (`/admin/vm-costs`, defer to a later sprint):
- Live count by category (active, ready pool, frozen, hibernating, suspended within window)
- Monthly-burn rollup, ideally with a 30-day trend graph
- Drill-down per category showing oldest VMs

**4. Image-integrity audit** (monthly, opt-in):
- Sample 1% of frozen images
- Attempt thaw to a sandbox VM (deletes itself after 60s)
- If thaw fails, alert + flag the original VM for investigation
- Keeps us honest that frozen images are actually restorable, not corrupt placeholders

This is the smallest amount of monitoring we need to *guarantee* this PRD's savings persist. Without it, in 6 months we'll be doing another $20k/yr cleanup.

### Implementation plan

Defer until after Phase 2 + Phase 3 are stable. Branch name: `phase4-cost-monitoring`. Scope is moderate (~300 LOC), low risk (read-only + alerting).

Estimated savings: \$0 directly, but **prevents** future drift. Worth it.

---

## Edge cases, gotchas, and decisions

A non-exhaustive list of things this PRD's implementation must handle correctly. Each maps to a specific code-path requirement.

### Freeze flow

1. **Image creation can fail asynchronously** even after the API returns 200. The image enters `pending_upload`/`creating` state and sometimes gets stuck. Always poll `image.status` until `available` (timeout: 10 min) or `pending_upload`/`creating` (continue waiting) — never proceed to delete the instance otherwise.

2. **Linode label limits**: image labels max 50 chars. `instaclaw-frozen-${vm.name}-${ts}` may exceed for long timestamps. Use a short hash instead: `frozen-${vm.id.slice(0,8)}-${unix_seconds}`. Document the format so future code can decode.

3. **Idempotency**: if vm-lifecycle is interrupted mid-freeze and re-runs, do not create a duplicate image. Check before creating: query `images?label=frozen-${vm.id.slice(0,8)}*` first. If exactly one exists with `status=available`, use it. If any exist with `status=creating`, wait for it. If none, create.

4. **Disk identification**: a Linode with a snapshot-cloned image has 2 disks (ext4 + swap). Snapshot the ext4 only. Verify via `disks?filesystem=eq.ext4` before creating image.

5. **Power-state requirement**: Linode imaging requires the source instance to be powered off OR have the disk attached read-only. Power off cleanly first; if shutdown fails, use a read-only attachment (more complex). Document the timeout for waitForOffline (~60s typical, 180s ceiling).

6. **Instance vs. disk image vs. backup**: Linode has 3 different concepts. We want **disk images** (the `/images` API), not Linode Backups (separate paid feature). Confirm with `type: 'manual'` on the image after creation.

7. **What if a VM was created from a base snapshot AND has been customized?** Most of our VMs are this. The base snapshot is the v62 fleet image, then configureOpenClaw layered user data on top. Personal images capture the **whole disk including the base layer**, so they're self-contained and work even if the base snapshot is deleted later. (Worth testing.)

8. **Rate limiting**: Linode allows ~50 image-create calls per hour per account. 70-VM initial freeze must spread over ~2 hours. Add a per-cron-run cap (`MAX_FREEZE_PER_RUN = 5`) and let the cron schedule handle the rest over time.

### Thaw flow

9. **Provisioning from a personal image**: behaves like provisioning from any image. Same cloud-init regeneration, same SSH host key reset, same machine-id regeneration. Verify cloud-init runs on the cloned VM (some images skip user_data).

10. **VM-name reuse**: when a user reactivates and we provision from their personal image, the new Linode instance gets a NEW `provider_server_id` but we keep the original `name` (`instaclaw-vm-NNN`). Update the row to point at the new ID. The old `provider_server_id` is gone.

11. **Telegram bot polling**: bot tokens are preserved in the snapshot's `~/.openclaw/.env`. When the gateway boots on the thawed VM, it should re-establish polling. **Risk**: Telegram may have tagged the bot session as stale. Test on first thaw — if it fails, run `deleteWebhook` + `getUpdates` reset programmatically before the agent starts.

12. **Stripe webhook race**: if `customer.subscription.resumed` fires while vm-lifecycle is concurrently mid-freezing the VM, both operations would conflict. The lifecycle lock (`lifecycle_locked_at`) protects against this. Additionally, the thaw code must check the VM is `status='frozen'` before attempting; if it's still `status='assigned'` (freeze hadn't started or aborted), nothing to thaw.

13. **Thaw failure recovery**: if thaw fails mid-flight, do NOT delete the personal image. Leave it for retry. Set `lifecycle_locked_at = NULL` so a next pass can retry. Send admin alert. The user gets a "still working on it" email; only worst-case ~2 hours additional latency.

14. **Pre-warm on Stripe webhook**: Stripe webhook for `customer.subscription.resumed` fires immediately. Don't wait for the user to send a message; start thaw as soon as the webhook arrives. By the time the user opens the dashboard, the VM is back. This reduces user-perceived latency from "I cancelled, why is my agent broken" to a 2-3 minute "reactivating" banner.

### Data preservation policy

15. **Hibernation vs. suspension**:
    - **Hibernating** (`health_status='hibernating'`): user paused via `/pause` or "pause subscription" button. Intends to come back. Kept frozen 90 days. After 90 days, transitions to `suspended` automatically (existing logic in vm-lifecycle Pass 0).
    - **Suspended** (`health_status='suspended'`): subscription cancelled (or never existed; e.g., trial expired). Kept frozen 30 days. After 30 days, send "we're about to delete your data in 7 days" email. After 37 days total, delete the personal image and mark `status='destroyed'`.

16. **Communication touchpoints** (Resend emails):
    - **On freeze**: "Your agent is paused. Data preserved for [30/90] days. Click to reactivate."
    - **7 days before image deletion**: "Final notice: we're deleting your agent data in 7 days unless you reactivate."
    - **On image deletion**: "Your agent's data has been permanently deleted per your subscription cancellation [date]."
    - **On thaw**: "Welcome back! Your agent is being restored — usually takes ~3 minutes."

17. **Bankr key destruction at final delete**: when we delete the image after 37 days, the Bankr private key in the user's snapshot is destroyed too. **Important**: the user can still control their on-chain Bankr wallet via Bankr's app directly (it's their wallet, not ours). Make sure the email at step 16 mentions: "if you launched a token, your Bankr wallet is preserved at bankr.bot — you can claim trading fees there directly even though your InstaClaw agent is gone."

18. **What about VMs with active Bankr tokens that miss the warning email?** Bankr tokens generate trading fees over time, claimable by the wallet. If we delete a wallet's image and the user hadn't claimed fees, they LOSE access to those fees (unless they have the seed phrase backed up elsewhere). We should:
    - At freeze time: ALWAYS send a Bankr-specific email if the VM has a token launch.
    - At final-delete time: ALWAYS confirm the user got the Bankr email and acknowledged.
    - If user never responded, default to NOT deleting and instead alert admin for manual review.

### Migration of existing VMs

19. **Existing 52 suspended + 18 hibernating**: not all of them have explicit `suspended_at`. Some are NULL. For the initial batch:
    - VMs with `suspended_at >= 30 days ago` → freeze candidate (run safety checks then freeze)
    - VMs with `suspended_at IS NULL` AND `assigned_at >= 60 days ago` → backfill `suspended_at = updated_at` then freeze candidate
    - VMs with `suspended_at IS NULL` AND `assigned_at < 60 days ago` → flag for manual review (we don't know how long they've been suspended)

20. **Initial-batch dry-run output**: the migration script must show, for each of the 70 candidates: user email, VM name, suspended_at, days suspended, all 11 safety checks (PASS/FAIL/SKIP), final action. Cooper reviews this before any execution. Same approval pattern as Phase 1.

### Operational

21. **Linode image quota**: as of 2026-04, Linode allows 6 free user images per account; beyond that, $0.10/GB/mo. We need to confirm whether our account has been upgraded to allow ~70+ images, or if we need to opt into paid storage explicitly. **OPEN QUESTION** — see Phase 3 questions.

22. **Cost of frozen images**: average compressed image size from the recent v62 bake was 5.3 GB. 70 images × 5.3 GB × $0.10/GB = ~$37/mo in image storage. Subtract from gross savings: $2,030 - $37 = $1,993/mo net. Still huge.

23. **Stripe-DB consistency drift**: subscription status in `instaclaw_subscriptions` can lag the actual Stripe state (webhook delays, missed events). All freeze/thaw decisions must call the Stripe API directly to get authoritative status, not trust `instaclaw_subscriptions`.

24. **Concurrent admin operations**: an admin doing a manual VM op (e.g. force-restart, troubleshoot) could collide with vm-lifecycle. The lifecycle lock covers this. Document for admin tooling: "if `lifecycle_locked_at` is set, an automated job is mid-flight; back off."

25. **Audit log retention**: `instaclaw_vm_lifecycle_log` rows are forever. Add a partitioning or archival strategy if it grows past ~1M rows. Defer for now (we have <1k rows lifetime).

26. **Test infrastructure**: before any freeze runs against a real user, we need a non-production test cycle:
    - Provision a dedicated test VM under a Cooper-owned test account (not in `instaclaw_users` production)
    - Add some workspace files, MEMORY.md content, fake skill credentials
    - Run freeze flow end-to-end
    - Wait, then run thaw flow end-to-end
    - Verify all original files present, gateway reaches `active`, can send a test message
    - Document the test in `instaclaw/scripts/_test-freeze-thaw-cycle.ts`

27. **Cooper protected list**: existing `isProtectedUser()` covers cooper@valtlabs.com and coopgwrenn@gmail.com. Add coop@instaclaw.io explicitly. Triple-check that lookup happens before any destructive action. Add a unit test against the real ID list.

### Long-term retention policy

28. **365-day frozen images** (suspended users who never came back): final cleanup policy needs Cooper's call. Default proposal:
    - Day 30 (suspended → frozen)
    - Day 60 (warning email)
    - Day 67 (image deleted, marked `status=destroyed`)
    - VS hibernation: same +60 days (so 90/120/127)
    - Total active retention window: 67 days suspended, 127 days hibernating
    - Anything older: delete unconditionally

29. **What about user account deletion?** GDPR / "right to be forgotten" requests. If a user requests full deletion, we must delete:
    - Their VM (running OR frozen image)
    - Their `instaclaw_users` row
    - Their `instaclaw_vm_lifecycle_log` rows? (or anonymize? legal call)
    - Any other PII rows
    - This is out-of-scope for this PRD but worth noting that the freeze pattern complicates deletion: must delete BOTH the running instance AND the personal image.

---

## Approval gates

| gate | what | who approves |
|---|---|---|
| ✅ Phase 1 — orphan deletion plan | dry-run output reviewed | Cooper (done 2026-04-27) |
| ✅ Phase 1 — execute | 57 VMs deleted, $1,638/mo saved | Cooper (done 2026-04-27) |
| ⏳ Phase 2 — implementation plan | this PRD | Cooper |
| ⏳ Phase 2 — preview deploy | branch + Vercel preview URL | Cooper |
| ⏳ Phase 2 — merge to main | dry-run cron output reviewed | Cooper |
| ⏳ Phase 3 — implementation plan | this PRD | Cooper |
| ⏳ Phase 3 — preview deploy | branch + Vercel preview URL | Cooper |
| ⏳ Phase 3 — single-VM test | one throwaway test VM end-to-end | Cooper |
| ⏳ Phase 3 — initial 70-VM batch | dry-run + spot check | Cooper |
| ⏳ Phase 3 — execute initial batch | freeze the 70 | Cooper |
| ⏳ Phase 3 — merge thaw to main | thaw flow goes live | Cooper |
| ⏳ Phase 4 — implementation plan | this PRD | Cooper |
| ⏳ Phase 4 — preview deploy | branch + Vercel preview URL | Cooper |
| ⏳ Phase 4 — daily audit cron live | merge to main | Cooper |

Each gate is hard. No phase advances without explicit approval.

---

## Open the conversation

Before any code:
1. Read this PRD end-to-end
2. Push back on anything that's wrong, missing, or risky
3. Call out the open questions above
4. Confirm the safety rules are complete (am I missing one?)
5. Then I'll start Phase 2 on its branch

I will not write a single line of Phase 2 or Phase 3 code until you say "approved, start phase 2."
