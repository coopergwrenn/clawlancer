/**
 * VM Freeze / Thaw — preserves user data while eliminating idle VM cost.
 *
 * FREEZE: snapshot the VM disk to a personal Linode image, delete the
 *   instance. Cost drops from ~$29/mo (running) to ~$0.50/mo (image storage).
 *
 * THAW:  provision a new Linode from that personal image, delete the image.
 *   The user gets their data back exactly as they left it.
 *
 * Triggered by:
 *   - Cron Pass 1 v2 (vm-lifecycle/route.ts) when a VM has been suspended >=30d
 *     or hibernating >=90d
 *   - Stripe webhook on subscription.resumed/created (thaw)
 *   - Admin endpoint /api/admin/thaw-vm (manual thaw)
 *
 * ALL safety rules from prd-vm-cost-optimization.md apply, especially:
 *   1. Re-check Stripe LIVE before every freeze (not cached DB state)
 *   2. Re-check 7-day SSH activity before every freeze
 *   3. Skip if credit_balance > 0 (paid credits)
 *   4. Skip if bankr_token_address IS NOT NULL (active token launch)
 *   5. ALWAYS verify image.status === "available" before deleting instance
 *   6. Per-VM lifecycle_locked_at lock to prevent freeze/thaw races
 *   7. NEVER use one user's image to provision another user's VM
 *
 * Order of operations is critical. See freezeVM() comments.
 */

import { logger } from "./logger";
import { connectSSH, type VMRecord } from "./ssh";
import {
  sshHasRecentActivity,
  userHasLiveSubscription,
  vmHasCredits,
} from "./vm-lifecycle-helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

// ─── Constants ────────────────────────────────────────────────────────────

/**
 * Per-cron-run cap on freeze operations. Linode rate-limits image creation
 * at ~50/hour per account. Worst-case freeze ≈ 90s shutdown + 600s image
 * wait = 690s. With route maxDuration=900s, two freezes serial fits with
 * margin (1380s would not). Cap is 2/run × 4 runs/day = 8/day; 70-VM
 * backlog clears in ~9 days at this rate, but safety > speed.
 */
export const MAX_FREEZE_PER_RUN = 2;

/** Suspended VMs eligible for freeze after this many days post-suspension. */
export const FREEZE_GRACE_SUSPENDED_DAYS = 3;

/** Hibernating VMs eligible for freeze after this many days post-pause. */
export const FREEZE_GRACE_HIBERNATING_DAYS = 90;

/** How long to wait for a Linode to power off cleanly before giving up. */
const POWER_OFF_TIMEOUT_MS = 90_000;

/** How long to wait for an image to reach status=available. */
const IMAGE_AVAILABLE_TIMEOUT_MS = 600_000;

/** How long to wait for a thawed instance to reach status=running. */
const INSTANCE_RUNNING_TIMEOUT_MS = 180_000;

/** Maximum lifecycle_locked_at age before considered stuck. */
const LIFECYCLE_LOCK_STALE_MINUTES = 15;

/** Total time to wait for SSH to come up on a thawed instance. */
const SSH_VERIFY_TOTAL_MS = 90_000;

/** Per-attempt SSH check interval during pollSshAlive(). */
const SSH_VERIFY_INTERVAL_MS = 10_000;

/** SSH-deploy key label — must exist in the Linode profile. */
const LINODE_SSH_KEY_LABEL = "instaclaw-deploy";

/** Default region for thawed instances if region missing on the row. */
const LINODE_DEFAULT_REGION = "us-east";

/** Default type for thawed instances. */
const LINODE_DEFAULT_TYPE = "g6-dedicated-2";

// ─── Types ────────────────────────────────────────────────────────────────

export interface FreezeCandidate {
  id: string;
  name: string | null;
  ip_address: string;
  ssh_port: number;
  ssh_user: string;
  provider_server_id: string | null;
  assigned_to: string | null;
  health_status: string | null;
  status: string | null;
  suspended_at: string | null;
  credit_balance: number | null;
  bankr_token_address: string | null;
  region: string | null;
  lifecycle_locked_at: string | null;
}

export interface FreezeResult {
  success: boolean;
  reason: string;
  imageId?: string | null;
  imageSizeMb?: number | null;
}

export interface ThawResult {
  success: boolean;
  reason: string;
  vmId?: string;
  newProviderServerId?: string;
  newIp?: string;
}

interface LinodeDisk {
  id: number;
  label: string;
  filesystem: string;
  size: number;
  status: string;
}

interface LinodeImage {
  id: string;
  label: string;
  status: string;
  size: number; // MB
  created: string;
}

interface LinodeInstanceState {
  id: number;
  status: string;
  ipv4: string[];
}

// ─── Linode API helpers (image lifecycle) ────────────────────────────────

async function linodeFetch(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`https://api.linode.com/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.LINODE_API_TOKEN}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok && res.status !== 200 && res.status !== 204) {
    const body = await res.text().catch(() => "");
    throw new Error(`Linode ${init?.method ?? "GET"} ${path} → HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function getInstanceDisks(instanceId: string): Promise<LinodeDisk[]> {
  const d = (await linodeFetch(`/linode/instances/${instanceId}/disks`)) as { data?: LinodeDisk[] };
  return d.data ?? [];
}

async function getInstanceState(instanceId: string): Promise<LinodeInstanceState> {
  return (await linodeFetch(`/linode/instances/${instanceId}`)) as LinodeInstanceState;
}

async function shutdownInstance(instanceId: string): Promise<void> {
  await linodeFetch(`/linode/instances/${instanceId}/shutdown`, { method: "POST" });
}

async function bootInstance(instanceId: string): Promise<void> {
  await linodeFetch(`/linode/instances/${instanceId}/boot`, { method: "POST" });
}

async function deleteInstance(instanceId: string): Promise<void> {
  await linodeFetch(`/linode/instances/${instanceId}`, { method: "DELETE" });
}

async function waitForInstanceStatus(
  instanceId: string,
  desired: "offline" | "running",
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await getInstanceState(instanceId);
    if (state.status === desired) return true;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return false;
}

async function createImage(diskId: number, label: string, description: string): Promise<LinodeImage> {
  return (await linodeFetch(`/images`, {
    method: "POST",
    body: JSON.stringify({ disk_id: diskId, label, description }),
  })) as LinodeImage;
}

async function getImage(imageId: string): Promise<LinodeImage> {
  return (await linodeFetch(`/images/${imageId}`)) as LinodeImage;
}

async function deleteImage(imageId: string): Promise<void> {
  await linodeFetch(`/images/${imageId}`, { method: "DELETE" });
}

async function waitForImageAvailable(imageId: string, timeoutMs: number): Promise<LinodeImage | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const img = await getImage(imageId);
    if (img.status === "available") return img;
    if (img.status === "creating" || img.status === "pending_upload") {
      await new Promise((r) => setTimeout(r, 10000));
      continue;
    }
    // Any other status (deleted, failed, etc.) — bail
    return img;
  }
  return null; // timed out
}

async function getSshKeyForProvision(): Promise<string> {
  // Pull the deploy key from Linode profile by label.
  const d = (await linodeFetch(`/profile/sshkeys`)) as { data?: Array<{ id: number; label: string; ssh_key: string }> };
  const match = (d.data ?? []).find((k) => k.label.includes(LINODE_SSH_KEY_LABEL));
  if (!match) throw new Error(`No Linode SSH key with label containing "${LINODE_SSH_KEY_LABEL}"`);
  return match.ssh_key;
}

async function createInstanceFromImage(opts: {
  label: string;
  region: string;
  type: string;
  imageId: string;
}): Promise<{ id: number; ipv4: string[]; status: string }> {
  const sshKey = await getSshKeyForProvision();
  // Random root password — we never use it (ssh key is the path in)
  const rootPass = require("node:crypto").randomBytes(24).toString("base64");
  return (await linodeFetch(`/linode/instances`, {
    method: "POST",
    body: JSON.stringify({
      label: opts.label,
      region: opts.region,
      type: opts.type,
      image: opts.imageId,
      root_pass: rootPass,
      authorized_keys: [sshKey],
      booted: true,
      tags: ["instaclaw"],
    }),
  })) as { id: number; ipv4: string[]; status: string };
}

// ─── Lifecycle lock ───────────────────────────────────────────────────────

/**
 * Atomically acquire the lifecycle lock for a VM. Uses a conditional UPDATE
 * (only sets the lock if it's currently NULL) so two concurrent freeze/thaw
 * operations can't both think they hold it.
 *
 * Returns true if we acquired it, false otherwise. Any pre-existing lock
 * older than LIFECYCLE_LOCK_STALE_MINUTES is treated as stuck and forcibly
 * cleared before retry.
 */
async function tryAcquireLock(supabase: SupabaseClient, vmId: string): Promise<boolean> {
  // Try the conditional update first — only sets the lock if no one holds it.
  const nowIso = new Date().toISOString();
  const { data: rows, error } = await supabase
    .from("instaclaw_vms")
    .update({ lifecycle_locked_at: nowIso })
    .eq("id", vmId)
    .is("lifecycle_locked_at", null)
    .select("id");
  if (error) {
    logger.error("freeze-thaw: lock acquire UPDATE failed", { vmId, error: error.message });
    return false;
  }
  if (rows && rows.length > 0) return true;

  // Stuck-lock takeover MUST be conditional in SQL — not a TOCTOU read+update.
  // Two concurrent callers seeing the same 16-min-old lock would both win an
  // unconditional UPDATE; only an UPDATE ... WHERE lifecycle_locked_at < cutoff
  // can guarantee that exactly one caller takes over the stuck lock.
  const staleCutoffIso = new Date(
    Date.now() - LIFECYCLE_LOCK_STALE_MINUTES * 60_000,
  ).toISOString();
  const { data: takeoverRows, error: takeoverErr } = await supabase
    .from("instaclaw_vms")
    .update({ lifecycle_locked_at: nowIso })
    .eq("id", vmId)
    .lt("lifecycle_locked_at", staleCutoffIso)
    .select("id");
  if (takeoverErr) {
    logger.error("freeze-thaw: stale-lock takeover UPDATE failed", { vmId, error: takeoverErr.message });
    return false;
  }
  if (takeoverRows && takeoverRows.length > 0) {
    logger.warn("freeze-thaw: cleared stuck lifecycle lock and took over", {
      vmId, staleCutoff: staleCutoffIso,
    });
    return true;
  }
  // Either lock is fresh or row vanished — give up; next tick retries.
  return false;
}

async function releaseLock(supabase: SupabaseClient, vmId: string): Promise<void> {
  try {
    await supabase
      .from("instaclaw_vms")
      .update({ lifecycle_locked_at: null })
      .eq("id", vmId);
  } catch (err) {
    logger.error("freeze-thaw: lock release threw (non-fatal)", { vmId, error: String(err) });
  }
}

// ─── Freeze ──────────────────────────────────────────────────────────────

/**
 * Freeze a single VM: snapshot disk → wait for image=available → update DB →
 * delete instance. ORDER MATTERS: DB is updated to point at the image BEFORE
 * the instance is deleted so we never lose the link to the snapshot.
 *
 * Safety checks (in order — any failure → skip, leave VM running):
 *   - lifecycle lock held → skip
 *   - active Stripe sub → skip
 *   - SSH activity in last 7 days → skip
 *   - credit_balance > 0 → skip
 *   - bankr_token_address NOT NULL → skip
 *   - status='provisioning'/'configuring' → skip
 *
 * If the image doesn't reach status='available' within 10 min, the instance
 * is BOOTED BACK UP and we return failure. Never deletes an instance whose
 * image isn't verified available.
 */
export async function freezeVM(
  supabase: SupabaseClient,
  vm: FreezeCandidate,
  dryRun: boolean,
  runId: string,
): Promise<FreezeResult> {
  const log = (level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}) => {
    logger[level](`freezeVM: ${msg}`, {
      route: "lib/vm-freeze-thaw",
      runId,
      vmId: vm.id,
      vmName: vm.name,
      dryRun,
      ...extra,
    });
  };

  // ── Pre-flight safety: status must be a valid freeze candidate ──
  if (vm.status !== "assigned") {
    return { success: false, reason: `wrong status: ${vm.status} (expected 'assigned')` };
  }
  if (!["suspended", "hibernating"].includes(vm.health_status ?? "")) {
    return { success: false, reason: `wrong health_status: ${vm.health_status}` };
  }
  if (!vm.provider_server_id) {
    return { success: false, reason: "no provider_server_id (already frozen?)" };
  }

  // ── Safety check 1: live Stripe subscription? ──
  // userHasLiveSubscription fails CLOSED on errors (returns true). Safe.
  if (await userHasLiveSubscription(supabase, vm.assigned_to)) {
    return { success: false, reason: "active Stripe subscription — refuse" };
  }

  // ── Safety check 2: credit_balance > 0 (PRD rule 3) ──
  if (vmHasCredits(vm.credit_balance)) {
    return { success: false, reason: `credit_balance=${vm.credit_balance} > 0 — paid credits remain` };
  }

  // ── Safety check 3: active Bankr token launch (PRD rule 5) ──
  // The user's Bankr private key lives in ~/.openclaw/.env on disk. Freezing
  // doesn't lose the key (it's in the snapshot) but blocks fee claims for the
  // freeze window. Conservatively skip until policy is set.
  if (vm.bankr_token_address) {
    return { success: false, reason: `active Bankr token ${vm.bankr_token_address.slice(0, 10)}... — refuse` };
  }

  // ── Safety check 4: SSH activity in last 7 days (PRD rule 2) ──
  // sshHasRecentActivity returns active=false on connect failure (designed
  // for orphan reconciliation where SSH-down implies dead VM). For freeze,
  // we don't have that luxury: an unreachable VM is one we CANNOT prove is
  // silent. PRD rule 11 ("when in doubt, SKIP") says fail closed. We only
  // proceed if we successfully connected and saw NO recent files.
  const activity = await sshHasRecentActivity(vm.ip_address);
  if (activity.active) {
    return { success: false, reason: `SSH activity detected: ${activity.reason}` };
  }
  if (
    activity.reason === "no-ipv4" ||
    activity.reason.startsWith("ssh-fail")
  ) {
    return { success: false, reason: `cannot verify silence (${activity.reason}) — failing closed per PRD rule 11` };
  }
  // Only the "silent" reason proves we successfully connected and saw no
  // recent files — that's the only safe path forward.
  if (activity.reason !== "silent") {
    return { success: false, reason: `unexpected activity-check result: ${activity.reason} — failing closed` };
  }

  // ── Dry-run early-return (must be BEFORE lock acquire) ──
  // Acquiring the lock has DB side effects (sets lifecycle_locked_at) and a
  // crash before the finally would leak a lock for 15 min. Dry-runs should
  // be pure-read; bail here once all read-only safety checks have passed.
  if (dryRun) {
    log("info", "dry-run: would freeze");
    return { success: true, reason: "dry-run: would freeze" };
  }

  // ── Safety check 5: lifecycle lock (live runs only) ──
  const locked = await tryAcquireLock(supabase, vm.id);
  if (!locked) {
    return { success: false, reason: "could not acquire lifecycle lock (another op in flight)" };
  }

  // We hold the lock now — release in finally.
  try {

    // ── Get the ext4 disk to snapshot ──
    const disks = await getInstanceDisks(vm.provider_server_id);
    const ext4 = disks.find((d) => d.filesystem === "ext4");
    if (!ext4) {
      return { success: false, reason: "no ext4 disk on instance" };
    }
    log("info", "found ext4 disk", { diskId: ext4.id, sizeMb: ext4.size });

    // ── Power off cleanly (required for clean snapshot) ──
    log("info", "shutting down instance");
    await shutdownInstance(vm.provider_server_id);
    const offline = await waitForInstanceStatus(vm.provider_server_id, "offline", POWER_OFF_TIMEOUT_MS);
    if (!offline) {
      return { success: false, reason: `instance did not reach offline within ${POWER_OFF_TIMEOUT_MS / 1000}s` };
    }

    // ── Create image. Label ≤ 50 chars: frozen-<vmId-prefix>-<unix-secs> ──
    const label = `frozen-${vm.id.slice(0, 8)}-${Math.floor(Date.now() / 1000)}`;
    const description = `Frozen VM for ${vm.name ?? "?"} (user ${vm.assigned_to ?? "?"}). Created by vm-lifecycle freeze pass on ${new Date().toISOString()}. runId=${runId}.`;
    log("info", "creating image", { label });
    const image = await createImage(ext4.id, label, description);
    log("info", "image creation initiated", { imageId: image.id, initialStatus: image.status });

    // ── Wait for image=available, then VERIFY (PRD rule 4) ──
    const finalImage = await waitForImageAvailable(image.id, IMAGE_AVAILABLE_TIMEOUT_MS);
    if (!finalImage || finalImage.status !== "available") {
      // Snapshot didn't complete cleanly. BOOT THE INSTANCE BACK UP and abort.
      log("error", "image did not reach available — recovering by booting instance back", {
        finalStatus: finalImage?.status ?? "<timeout>",
      });
      try {
        await bootInstance(vm.provider_server_id);
        await waitForInstanceStatus(vm.provider_server_id, "running", INSTANCE_RUNNING_TIMEOUT_MS);
      } catch (bootErr) {
        log("error", "RECOVERY FAILED: instance is offline AND image is not available", {
          error: String(bootErr),
        });
      }
      return { success: false, reason: `image status=${finalImage?.status ?? "timeout"} — instance booted back` };
    }

    // ── Update DB BEFORE deleting instance ──
    // If anything below this fails, we have an orphan image but no lost data.
    // If we update DB AFTER, a crash would leave us with a DB row pointing
    // at a live instance that's about to be destroyed → user data lost.
    log("info", "image verified available — updating DB", { imageId: finalImage.id, sizeMb: finalImage.size });
    const { error: updateErr } = await supabase
      .from("instaclaw_vms")
      .update({
        status: "frozen",
        health_status: "frozen",
        frozen_image_id: finalImage.id,
        frozen_image_size_mb: finalImage.size,
        frozen_at: new Date().toISOString(),
        // Clear references to the soon-to-be-deleted Linode instance.
        provider_server_id: null,
        ip_address: "0.0.0.0", // ip_address is NOT NULL in schema; placeholder
      })
      .eq("id", vm.id);
    if (updateErr) {
      // DB update failed. Image exists but not tracked. Boot the instance
      // back up and fail. The orphan image needs manual cleanup.
      log("error", "DB update failed — booting instance back, image will be orphaned", {
        imageId: finalImage.id, error: updateErr.message,
      });
      try { await bootInstance(vm.provider_server_id); } catch { /* noop */ }
      return { success: false, reason: `DB update failed (image ${finalImage.id} may need cleanup): ${updateErr.message}` };
    }

    // ── NOW delete the instance ──
    log("info", "deleting instance");
    try {
      await deleteInstance(vm.provider_server_id);
    } catch (delErr) {
      // Instance delete failed but DB says frozen. The instance is still
      // billing us. Log loudly — Pass 1 v2 next cycle will retry the delete
      // (it scans for status=frozen rows with no provider_server_id; if
      // their image_id matches a stuck instance, retry).
      log("error", "instance delete failed — will retry next cycle", {
        instanceId: vm.provider_server_id, error: String(delErr),
      });
      // Don't fail the freeze — the user data is preserved in the image.
      return {
        success: true,
        reason: "frozen but instance delete deferred (will retry)",
        imageId: finalImage.id,
        imageSizeMb: finalImage.size,
      };
    }

    log("info", "freeze complete", { imageId: finalImage.id, sizeMb: finalImage.size });
    return {
      success: true,
      reason: "frozen successfully",
      imageId: finalImage.id,
      imageSizeMb: finalImage.size,
    };
  } finally {
    await releaseLock(supabase, vm.id);
  }
}

// ─── Thaw ────────────────────────────────────────────────────────────────

interface ThawableVM {
  id: string;
  name: string | null;
  assigned_to: string | null;
  region: string | null;
  frozen_image_id: string | null;
}

/**
 * Thaw a single user's frozen VM. Provisions a new Linode from their
 * personal snapshot, restores DB pointers, deletes the snapshot.
 *
 * SAFETY (PRD rule 7): the personal image is looked up by joining on
 * assigned_to — we NEVER use one user's image to provision another's VM.
 *
 * Returns failure (with image preserved) if anything goes wrong. Manual
 * recovery steps logged.
 */
export async function thawVM(
  supabase: SupabaseClient,
  userId: string,
  dryRun: boolean,
  runId: string,
): Promise<ThawResult> {
  const log = (level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}) => {
    logger[level](`thawVM: ${msg}`, { route: "lib/vm-freeze-thaw", runId, userId, dryRun, ...extra });
  };

  // ── Find this user's frozen VM (PRD rule 7: only THIS user's image) ──
  const { data: candidates, error: queryErr } = await supabase
    .from("instaclaw_vms")
    .select("id, name, assigned_to, region, frozen_image_id, status, health_status")
    .eq("assigned_to", userId)
    .eq("status", "frozen")
    .not("frozen_image_id", "is", null);
  if (queryErr) {
    log("error", "thaw query failed", { error: queryErr.message });
    return { success: false, reason: `DB query failed: ${queryErr.message}` };
  }
  if (!candidates || candidates.length === 0) {
    return { success: false, reason: "no frozen VM for this user" };
  }
  if (candidates.length > 1) {
    // Multiple frozen VMs for one user — shouldn't happen but defend.
    log("error", "multiple frozen VMs for one user — refusing to auto-thaw", {
      vmIds: candidates.map((c) => c.id),
    });
    return { success: false, reason: "multiple frozen VMs (manual investigation required)" };
  }

  const frozen = candidates[0] as ThawableVM;
  if (!frozen.frozen_image_id) {
    return { success: false, reason: "frozen_image_id is null (DB inconsistency)" };
  }

  if (dryRun) {
    log("info", "dry-run: would thaw");
    return { success: true, reason: "dry-run: would thaw", vmId: frozen.id };
  }

  // ── Acquire lifecycle lock ──
  const locked = await tryAcquireLock(supabase, frozen.id);
  if (!locked) {
    return { success: false, reason: "could not acquire lifecycle lock — try again in 15 min" };
  }

  try {
    // ── Provision new Linode from THIS user's image ──
    log("info", "provisioning from personal image", { imageId: frozen.frozen_image_id });
    const newInstance = await createInstanceFromImage({
      label: frozen.name ?? `instaclaw-vm-thaw-${Date.now()}`,
      region: frozen.region ?? LINODE_DEFAULT_REGION,
      type: LINODE_DEFAULT_TYPE,
      imageId: frozen.frozen_image_id,
    });
    log("info", "instance created", { instanceId: newInstance.id, ipv4: newInstance.ipv4 });

    // ── Wait for running ──
    const running = await waitForInstanceStatus(String(newInstance.id), "running", INSTANCE_RUNNING_TIMEOUT_MS);
    if (!running) {
      log("error", "instance did not reach running — leaving image intact for retry");
      // Don't delete the image — user data is still preserved there.
      // Manual cleanup: kill the broken Linode, retry thaw later.
      return { success: false, reason: `instance ${newInstance.id} did not reach running` };
    }

    // ── Verify SSH-reachable BEFORE deleting the snapshot (PRD rule 4 spirit) ──
    // The image is the user's only data backup. We must NOT delete it until
    // we've proven the new instance is actually usable. Cloud-init can lag
    // for tens of seconds regenerating host keys, so poll with retries.
    const ip = newInstance.ipv4?.[0];
    if (!ip) {
      return { success: false, reason: "no ipv4 on new instance" };
    }
    const sshOk = await pollSshAlive(ip, SSH_VERIFY_TOTAL_MS, SSH_VERIFY_INTERVAL_MS);
    log(sshOk ? "info" : "warn", sshOk ? "SSH verified alive" : "SSH did not verify in 90s — preserving image as recovery backup", { ip });

    // ── Update DB: point at new instance regardless of SSH outcome ──
    // The user benefits from getting a VM either way (slow cloud-init resolves
    // itself in ~minutes). But: only clear frozen_image_id when SSH verified.
    // While frozen_image_id remains set after status='assigned', the row is
    // a "thaw-pending-verification" record — image preserved as backup until
    // ops confirms the new instance is fully working.
    log("info", "updating DB to point at new instance", { sshVerified: sshOk });
    const dbUpdate: Record<string, unknown> = {
      status: "assigned",
      health_status: "healthy",
      provider_server_id: String(newInstance.id),
      ip_address: ip,
      frozen_at: null,
      frozen_image_size_mb: null,
      // Only clear frozen_image_id when SSH verified — see comment above.
      ...(sshOk ? { frozen_image_id: null } : {}),
    };
    const { error: updateErr } = await supabase
      .from("instaclaw_vms")
      .update(dbUpdate)
      .eq("id", frozen.id);
    if (updateErr) {
      // DB failed but new instance is up. Don't delete the image yet — that
      // would cause permanent data loss if we retry. Manual recovery needed.
      log("error", "DB update failed — instance up but DB still says frozen", {
        instanceId: newInstance.id, error: updateErr.message,
      });
      return { success: false, reason: `DB update failed: ${updateErr.message} — manual recovery needed` };
    }

    // ── Delete personal image ONLY when SSH verified (PRD rule 4 + safety) ──
    if (sshOk) {
      try {
        await deleteImage(frozen.frozen_image_id);
        log("info", "personal image deleted");
      } catch (delErr) {
        // Image delete failed but VM is back and SSH-verified. Storage cost
        // is small — log and move on. A retention sweep cleans up later.
        log("warn", "image delete failed — will leak a few MB until cleanup", {
          imageId: frozen.frozen_image_id, error: String(delErr),
        });
      }
      return {
        success: true,
        reason: "thawed and SSH-verified",
        vmId: frozen.id,
        newProviderServerId: String(newInstance.id),
        newIp: ip,
      };
    }

    // SSH not verified within 90s — image is preserved on the row. Return
    // success (user has a VM) but flag that verification is pending.
    return {
      success: true,
      reason: "thawed but SSH unverified — image preserved for recovery",
      vmId: frozen.id,
      newProviderServerId: String(newInstance.id),
      newIp: ip,
    };
  } finally {
    await releaseLock(supabase, frozen.id);
  }
}

async function sshAlive(ip: string): Promise<boolean> {
  const vmRecord: VMRecord = { id: ip, ip_address: ip, ssh_port: 22, ssh_user: "openclaw" };
  try {
    const ssh = await connectSSH(vmRecord, { skipDuplicateIPCheck: true });
    try {
      const r = await ssh.execCommand("echo ok");
      return (r.stdout || "").includes("ok");
    } finally {
      try { ssh.dispose?.(); } catch { /* noop */ }
    }
  } catch {
    return false;
  }
}

/**
 * Poll sshAlive() repeatedly until SSH responds OK or the budget is exhausted.
 * Cloud-init regenerates host keys on first boot from snapshot, which can
 * delay SSH responsiveness by 30-60s. A single sshAlive() call would race
 * cloud-init and falsely report "not alive".
 */
async function pollSshAlive(ip: string, maxMs: number, intervalMs: number): Promise<boolean> {
  const start = Date.now();
  while (true) {
    if (await sshAlive(ip)) return true;
    if (Date.now() - start + intervalMs >= maxMs) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
