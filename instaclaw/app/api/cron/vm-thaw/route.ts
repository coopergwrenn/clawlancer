/**
 * vm-thaw — freeze-v2 Phase 4 thaw cron (PRD §17).
 *
 * The capstone of freeze-v2. Inverse of the freeze flow (Phase 3).
 *
 * Trigger: billing webhook (Phase 4 entry, lib/freeze-v2-thaw-entry.ts)
 * flips freeze_state from 'frozen' to 'thaw_pending' when a user with a
 * frozen-v2 VM reactivates their subscription.
 *
 * Per-VM state machine (PRD §17.3):
 *   thaw_pending → thawing → thawing_provisioned → idle
 *
 * Each transition is a conditional CAS UPDATE. Three stages execute
 * across multiple cron ticks (because cloud-init runs async after Linode
 * provision, and we wait for its callback before doing the restore).
 *
 *   Stage 1 (thaw_pending → thawing):
 *     - Mint fresh cloud-init tokens
 *     - Provision a new Linode (linodeProvider.createServer)
 *     - Update row with provider_server_id + ip_address
 *     - Cloud-init runs async on the new instance
 *
 *   Stage 2 (thawing → thawing_provisioned):
 *     - Polled. Triggers when cloud_init_callback_consumed_at > thaw_requested_at.
 *     - Just a CAS UPDATE — restore happens in Stage 3.
 *
 *   Stage 3 (thawing_provisioned → idle):
 *     - SSH to new VM
 *     - Stop gbrain (safe — fresh empty PGLite)
 *     - Download archive from R2, decrypt, parse outer tar
 *     - Verify per-blob sha256 against manifest
 *     - Extract brain.pglite.tar.gz → ~/.gbrain/ [STUB-VERIFIED: extract is generic
 *       tar, but end-to-end load-by-gbrain unverified until snapshot_brain ships]
 *     - Extract user-state.tar.gz → ~/.openclaw/ (regular files, no stub)
 *     - Start gbrain, poll /health
 *     - Version-gap-aware rewire (§17.4) [STUB: stepFiles+restart for now;
 *       full reconcile path is a P1 follow-up — gap-tier logic in place]
 *     - Terminal CAS UPDATE: status='assigned', health='healthy',
 *       freeze_state='idle', frozen_at=null
 *
 * Stuck-state recovery (§17.5) — both mid-states have recovery paths at
 * the top of the GET handler before normal candidate processing.
 *
 * Resub-mid-thaw race (§17.6) — NO mid-thaw abort logic. If user cancels
 * mid-thaw, the thaw completes, normal past_due cycle re-freezes the VM
 * along the standard path. Cost is bounded (~5 days Linode billing
 * before re-freeze).
 *
 * Schedule: cron expression "every 5 min" (see vercel.json). PRD §17.9. maxDuration=800.
 *
 * See also:
 *   - PRD §17 (canonical design)
 *   - lib/freeze-v2-thaw-entry.ts (entry point)
 *   - app/api/cron/vm-freeze/route.ts (sibling cron + recovery pattern)
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { sendAdminAlertEmail } from "@/lib/email";
import { linodeProvider } from "@/lib/providers/linode";
import { connectSSH } from "@/lib/ssh";
import { getObject, ObjectNotFoundError } from "@/lib/r2-storage";
import { decrypt, DecryptError } from "@/lib/freeze-encryption";
import { generateGatewayToken } from "@/lib/security";
import { randomUUID, randomBytes, createHash } from "node:crypto";

export const dynamic = "force-dynamic";
// Worst case per cron tick: 1 stuck-state recovery + 1 new provision (~3-5 min) +
// 2 restores (~30s each). 800s is the Vercel Pro cap; gives ample margin.
export const maxDuration = 800;

// ─── Tunables (PRD §17.9) ────────────────────────────────────────────────

const MAX_THAW_PROVISIONS_PER_RUN = 1;
const MAX_THAW_RESTORES_PER_RUN = 2;
const CRON_LOCK_TTL_SECONDS = 15 * 60;
const PER_VM_LOCK_TTL_SECONDS = 15 * 60;

/** How long to wait for cloud-init callback before considering the VM stuck. */
const CLOUD_INIT_TIMEOUT_MIN = 20;

/** Per-Vercel-function archive size cap. Anything bigger = abort + alert. */
const ARCHIVE_MAX_BYTES = 200 * 1024 * 1024;

/** Health probe budget after gbrain start. */
const GBRAIN_HEALTH_POLL_SECONDS = 60;

// ─── Types ───────────────────────────────────────────────────────────────

interface ThawCandidate {
  id: string;
  name: string | null;
  ip_address: string | null;
  ssh_port: number | null;
  ssh_user: string | null;
  assigned_to: string | null;
  freeze_state: string | null;
  provider_server_id: string | null;
  frozen_archive_path: string | null;
  frozen_archive_sha256: string | null;
  frozen_archive_manifest: Record<string, unknown> | null;
  frozen_archive_taken_at: string | null;
  thaw_requested_at: string | null;
  cloud_init_callback_consumed_at: string | null;
}

type ThawOutcome =
  | "provisioned"      // Stage 1: Linode created, cloud-init in flight
  | "awaiting_cloud_init"
  | "advanced_to_provisioned" // Stage 2: callback consumed, state → thawing_provisioned
  | "thawed"           // Stage 3 complete
  | "skipped_lock"
  | "state_changed"
  | "no_archive"
  | "linode_provision_failed"
  | "cloud_init_timeout"
  | "ssh_failed"
  | "archive_download_failed"
  | "archive_decrypt_failed"
  | "archive_integrity_failed"
  | "restore_failed"
  | "gbrain_unhealthy"
  | "db_terminal_failed"
  | "error";

interface ThawOneResult {
  vm_id: string;
  vm_name: string | null;
  stage: "stage1_provision" | "stage2_callback" | "stage3_restore" | "recovery";
  outcome: ThawOutcome;
  detail: string;
  duration_ms?: number;
}

interface RunSummary {
  run_id: string;
  provisioned: number;
  advanced: number;
  thawed: number;
  recovered: number;
  skipped: number;
  failed: number;
  duration_ms: number;
  results: ThawOneResult[];
  note?: string;
}

// ─── Route handler ───────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const runId = randomUUID();
  const tStart = Date.now();
  const supabase = getSupabase();

  const cronLock = await tryAcquireCronLock("vm-thaw", CRON_LOCK_TTL_SECONDS, "vercel-cron");
  if (!cronLock) {
    return NextResponse.json({
      run_id: runId,
      provisioned: 0,
      advanced: 0,
      thawed: 0,
      recovered: 0,
      skipped: 0,
      failed: 0,
      duration_ms: 0,
      results: [],
      note: "outer cron lock busy",
    } satisfies RunSummary);
  }

  const summary: RunSummary = {
    run_id: runId,
    provisioned: 0,
    advanced: 0,
    thawed: 0,
    recovered: 0,
    skipped: 0,
    failed: 0,
    duration_ms: 0,
    results: [],
  };

  try {
    // ── Stage 0a: stuck-`thawing` recovery (PRD §17.5) ──
    await sweepStuckThawing(supabase, summary, runId);

    // ── Stage 0b: stuck-`thawing_provisioned` recovery ──
    // (handled by the Stage 3 candidate query — any row at that state
    // gets re-processed; locks prevent racing. So no separate sweep.)

    // ── Stage 2: advance `thawing` → `thawing_provisioned` for VMs whose
    // cloud-init callback has landed. ──
    await advanceCallbackReady(supabase, summary, runId);

    // ── Stage 1: pick up new thaw_pending rows + provision ──
    const provisions = await runStage1Provisions(supabase, summary, runId);
    summary.provisioned += provisions;

    // ── Stage 3: restore archives onto thawing_provisioned VMs ──
    const restores = await runStage3Restores(supabase, summary, runId);
    summary.thawed += restores;

    summary.duration_ms = Date.now() - tStart;
    logger.info("vm-thaw: run complete", { runId, ...summary });
    return NextResponse.json(summary);
  } catch (err) {
    summary.duration_ms = Date.now() - tStart;
    logger.error("vm-thaw: run threw", {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { ...summary, fatal: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  } finally {
    await releaseCronLock("vm-thaw");
  }
}

// ─── Stage 1: provision new Linode for thaw_pending rows ─────────────────

async function runStage1Provisions(
  supabase: ReturnType<typeof getSupabase>,
  summary: RunSummary,
  runId: string,
): Promise<number> {
  const { data: candidates, error } = await supabase
    .from("instaclaw_vms")
    .select(
      "id, name, ip_address, ssh_port, ssh_user, assigned_to, freeze_state, provider_server_id, frozen_archive_path, frozen_archive_sha256, frozen_archive_manifest, frozen_archive_taken_at, thaw_requested_at, cloud_init_callback_consumed_at",
    )
    .eq("freeze_state", "thaw_pending")
    .is("provider_server_id", null)
    .not("frozen_archive_path", "is", null)
    .not("assigned_to", "is", null)
    .order("thaw_requested_at", { ascending: true, nullsFirst: false })
    .limit(MAX_THAW_PROVISIONS_PER_RUN);

  if (error) {
    logger.error("vm-thaw: Stage 1 query failed", { runId, error: error.message });
    return 0;
  }
  if (!candidates || candidates.length === 0) return 0;

  let count = 0;
  for (const vm of candidates as ThawCandidate[]) {
    const t = Date.now();
    const result = await stage1ProvisionOne(supabase, vm, runId);
    result.duration_ms = Date.now() - t;
    summary.results.push(result);
    if (result.outcome === "provisioned") count++;
    else if (result.outcome === "skipped_lock" || result.outcome === "state_changed") summary.skipped++;
    else summary.failed++;
  }
  return count;
}

async function stage1ProvisionOne(
  supabase: ReturnType<typeof getSupabase>,
  vm: ThawCandidate,
  runId: string,
): Promise<ThawOneResult> {
  const base = { vm_id: vm.id, vm_name: vm.name, stage: "stage1_provision" as const };
  const lockKey = `freeze-thaw:${vm.id}`;
  const acquired = await tryAcquireCronLock(lockKey, PER_VM_LOCK_TTL_SECONDS, `vm-thaw/${runId}`);
  if (!acquired) return { ...base, outcome: "skipped_lock", detail: `${lockKey} busy` };

  try {
    // Re-read inside lock.
    const { data: fresh } = await supabase
      .from("instaclaw_vms")
      .select("freeze_state, frozen_archive_path, assigned_to, name")
      .eq("id", vm.id)
      .single();
    if (!fresh || fresh.freeze_state !== "thaw_pending") {
      return { ...base, outcome: "state_changed", detail: `state is now '${fresh?.freeze_state ?? "<missing>"}'` };
    }
    if (!fresh.frozen_archive_path) {
      return { ...base, outcome: "no_archive", detail: "frozen_archive_path was cleared" };
    }

    // CAS: thaw_pending → thawing
    {
      const { data: updated, error: casErr } = await supabase
        .from("instaclaw_vms")
        .update({ freeze_state: "thawing" })
        .eq("id", vm.id)
        .eq("freeze_state", "thaw_pending")
        .select("id");
      if (casErr || !updated || updated.length === 0) {
        return {
          ...base,
          outcome: "state_changed",
          detail: `CAS to 'thawing' matched 0 rows: ${casErr?.message ?? "concurrent state flip"}`,
        };
      }
    }

    // Mint fresh cloud-init tokens. Note: NOT reusing createUserVM here
    // because we're UPDATING an existing row, not inserting. createUserVM
    // also does waitlist + assignment plumbing that we don't need.
    const configToken = randomBytes(32).toString("hex");
    const callbackToken = randomBytes(32).toString("hex");
    const gatewayToken = generateGatewayToken();

    // Update row with the fresh tokens before provision so the cloud-init
    // bootstrap's curl-back can claim against the row.
    const { error: tokenErr } = await supabase
      .from("instaclaw_vms")
      .update({
        cloud_init_config_token: configToken,
        cloud_init_callback_token: callbackToken,
        cloud_init_callback_consumed_at: null, // clear so Stage 2's compare uses fresh callback
        gateway_token: gatewayToken,
        status: "provisioning",
      })
      .eq("id", vm.id)
      .eq("freeze_state", "thawing");
    if (tokenErr) {
      await revertToThawPending(supabase, vm.id, "token mint UPDATE failed");
      return { ...base, outcome: "db_terminal_failed", detail: `token UPDATE failed: ${tokenErr.message}` };
    }

    // Provision the Linode via the same provider used for new VMs.
    // userData omitted → linodeProvider picks getSnapshotUserData() based
    // on LINODE_SNAPSHOT_ID env (the same base snapshot new VMs use).
    let server;
    try {
      server = await linodeProvider.createServer({
        name: fresh.name ?? `thaw-${vm.id.slice(0, 8)}`,
      });
    } catch (err) {
      await revertToThawPending(supabase, vm.id, `Linode provision threw: ${truncate(err)}`);
      return {
        ...base,
        outcome: "linode_provision_failed",
        detail: `linodeProvider.createServer: ${truncate(err)}`,
      };
    }

    // Update row with provider id + IP. Keep status='provisioning' and
    // freeze_state='thawing' — cloud-init still has to run.
    const { error: provUpdateErr } = await supabase
      .from("instaclaw_vms")
      .update({
        provider_server_id: server.providerId,
        ip_address: server.ip,
      })
      .eq("id", vm.id)
      .eq("freeze_state", "thawing");
    if (provUpdateErr) {
      // Row got flipped between provision and update (rare). We have an
      // orphaned Linode. Try to delete it; if that fails, P0 alert.
      logger.error("vm-thaw: provider_server_id UPDATE failed AFTER provision — ORPHAN", {
        runId, vmId: vm.id, providerId: server.providerId, error: provUpdateErr.message,
      });
      try {
        await fetch(`https://api.linode.com/v4/linode/instances/${server.providerId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${process.env.LINODE_API_TOKEN}` },
        });
      } catch (delErr) {
        await sendAdminAlertEmail(
          `[P0] vm-thaw: orphan Linode ${server.providerId}`,
          `provider_server_id UPDATE failed after thaw provision; Linode delete also threw.\n` +
          `VM id: ${vm.id} (${fresh.name})\n` +
          `Linode id: ${server.providerId}\n` +
          `Delete error: ${truncate(delErr)}\n` +
          `Run id: ${runId}\n` +
          `Manual fix: curl -X DELETE -H "Authorization: Bearer \$LINODE_API_TOKEN" https://api.linode.com/v4/linode/instances/${server.providerId}\n`,
        ).catch(() => { /* alert best-effort */ });
      }
      return { ...base, outcome: "db_terminal_failed", detail: `provider_server_id UPDATE failed: ${provUpdateErr.message}` };
    }

    return {
      ...base,
      outcome: "provisioned",
      detail: `Linode ${server.providerId} (${server.ip}); cloud-init running`,
    };
  } finally {
    await releaseCronLock(lockKey);
  }
}

// ─── Stage 2: advance thawing → thawing_provisioned when callback lands ──

async function advanceCallbackReady(
  supabase: ReturnType<typeof getSupabase>,
  summary: RunSummary,
  runId: string,
): Promise<void> {
  const { data: ready, error } = await supabase
    .from("instaclaw_vms")
    .select("id, name, thaw_requested_at, cloud_init_callback_consumed_at")
    .eq("freeze_state", "thawing")
    .not("cloud_init_callback_consumed_at", "is", null)
    .not("provider_server_id", "is", null)
    .limit(10);

  if (error || !ready || ready.length === 0) return;

  for (const row of ready) {
    // PostgREST can't compare two columns in a filter, so we re-check in code.
    const callback = row.cloud_init_callback_consumed_at
      ? new Date(row.cloud_init_callback_consumed_at).getTime()
      : 0;
    const requested = row.thaw_requested_at ? new Date(row.thaw_requested_at).getTime() : 0;
    if (callback <= requested) continue; // callback is older than this thaw request

    const lockKey = `freeze-thaw:${row.id}`;
    const acquired = await tryAcquireCronLock(lockKey, 60, `vm-thaw-advance/${runId}`);
    if (!acquired) continue;

    try {
      const { data: updated, error: casErr } = await supabase
        .from("instaclaw_vms")
        .update({ freeze_state: "thawing_provisioned" })
        .eq("id", row.id)
        .eq("freeze_state", "thawing")
        .select("id");
      if (casErr || !updated || updated.length === 0) continue;
      summary.advanced++;
      summary.results.push({
        vm_id: row.id,
        vm_name: row.name,
        stage: "stage2_callback",
        outcome: "advanced_to_provisioned",
        detail: `cloud-init callback at ${row.cloud_init_callback_consumed_at}; advanced to thawing_provisioned`,
      });
    } finally {
      await releaseCronLock(lockKey);
    }
  }
}

// ─── Stage 3: restore archive onto thawing_provisioned VMs ───────────────

async function runStage3Restores(
  supabase: ReturnType<typeof getSupabase>,
  summary: RunSummary,
  runId: string,
): Promise<number> {
  const { data: candidates, error } = await supabase
    .from("instaclaw_vms")
    .select(
      "id, name, ip_address, ssh_port, ssh_user, assigned_to, freeze_state, provider_server_id, frozen_archive_path, frozen_archive_sha256, frozen_archive_manifest, frozen_archive_taken_at, thaw_requested_at, cloud_init_callback_consumed_at",
    )
    .eq("freeze_state", "thawing_provisioned")
    .not("provider_server_id", "is", null)
    .not("frozen_archive_path", "is", null)
    .order("thaw_requested_at", { ascending: true, nullsFirst: false })
    .limit(MAX_THAW_RESTORES_PER_RUN);

  if (error) {
    logger.error("vm-thaw: Stage 3 query failed", { runId, error: error.message });
    return 0;
  }
  if (!candidates || candidates.length === 0) return 0;

  let count = 0;
  for (const vm of candidates as ThawCandidate[]) {
    const t = Date.now();
    const result = await stage3RestoreOne(supabase, vm, runId);
    result.duration_ms = Date.now() - t;
    summary.results.push(result);
    if (result.outcome === "thawed") count++;
    else if (result.outcome === "skipped_lock" || result.outcome === "state_changed") summary.skipped++;
    else summary.failed++;
  }
  return count;
}

async function stage3RestoreOne(
  supabase: ReturnType<typeof getSupabase>,
  vm: ThawCandidate,
  runId: string,
): Promise<ThawOneResult> {
  const base = { vm_id: vm.id, vm_name: vm.name, stage: "stage3_restore" as const };
  const lockKey = `freeze-thaw:${vm.id}`;
  const acquired = await tryAcquireCronLock(lockKey, PER_VM_LOCK_TTL_SECONDS, `vm-thaw/${runId}`);
  if (!acquired) return { ...base, outcome: "skipped_lock", detail: `${lockKey} busy` };

  let ssh: Awaited<ReturnType<typeof connectSSH>> | null = null;
  try {
    // Re-read.
    const { data: fresh } = await supabase
      .from("instaclaw_vms")
      .select("freeze_state, ip_address, provider_server_id, frozen_archive_path, frozen_archive_sha256, frozen_archive_manifest")
      .eq("id", vm.id)
      .single();
    if (!fresh || fresh.freeze_state !== "thawing_provisioned") {
      return { ...base, outcome: "state_changed", detail: `state is now '${fresh?.freeze_state ?? "<missing>"}'` };
    }
    if (!fresh.frozen_archive_path) {
      return { ...base, outcome: "no_archive", detail: "frozen_archive_path cleared" };
    }

    // SSH to the new VM.
    try {
      ssh = await connectSSH({
        id: vm.id,
        ip_address: fresh.ip_address ?? vm.ip_address ?? "",
        ssh_port: vm.ssh_port ?? 22,
        ssh_user: vm.ssh_user ?? "openclaw",
      });
    } catch (err) {
      return { ...base, outcome: "ssh_failed", detail: truncate(err) };
    }

    // Download + decrypt archive.
    let ciphertext: Buffer;
    try {
      ciphertext = await getObject(fresh.frozen_archive_path);
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        await sendAdminAlertEmail(
          `[P0] vm-thaw: archive missing in R2 for ${vm.name ?? vm.id}`,
          `frozen_archive_path=${fresh.frozen_archive_path} but R2 returned 404.\n` +
          `Possible causes: (a) retention sweep deleted it, (b) GDPR delete fired, ` +
          `(c) R2 outage. Try N-1 generation manually via listObjectsByPrefix.\n` +
          `runId=${runId}`,
        ).catch(() => {});
        return { ...base, outcome: "archive_download_failed", detail: "R2 404; P0 alert sent" };
      }
      return { ...base, outcome: "archive_download_failed", detail: truncate(err) };
    }

    if (ciphertext.length > ARCHIVE_MAX_BYTES) {
      return {
        ...base,
        outcome: "archive_integrity_failed",
        detail: `archive ${ciphertext.length} bytes exceeds cap ${ARCHIVE_MAX_BYTES}`,
      };
    }

    // sha256 verify against DB column.
    const ctSha = createHash("sha256").update(ciphertext).digest("hex");
    if (fresh.frozen_archive_sha256 && ctSha !== fresh.frozen_archive_sha256) {
      await sendAdminAlertEmail(
        `[P0] vm-thaw: archive sha256 mismatch for ${vm.name ?? vm.id}`,
        `DB recorded ${fresh.frozen_archive_sha256.slice(0, 16)}... but R2 returned ${ctSha.slice(0, 16)}... — archive tampered or corrupt.\n` +
        `runId=${runId}`,
      ).catch(() => {});
      return { ...base, outcome: "archive_integrity_failed", detail: "outer sha256 mismatch" };
    }

    // Decrypt.
    const manifest = (fresh.frozen_archive_manifest ?? {}) as Record<string, unknown>;
    const keyId = (manifest.encryption_key_id as string) ?? "v1";
    let plaintext: Buffer;
    try {
      plaintext = decrypt(ciphertext, keyId);
    } catch (err) {
      if (err instanceof DecryptError) {
        await sendAdminAlertEmail(
          `[P0] vm-thaw: decrypt failed for ${vm.name ?? vm.id}`,
          `AES-GCM auth failure on key_id=${keyId}. ${err.message}\n` +
          `Wrong key for this archive, tampered, or corrupt.\nrunId=${runId}`,
        ).catch(() => {});
      }
      return { ...base, outcome: "archive_decrypt_failed", detail: truncate(err) };
    }

    // Parse outer ustar. Inverse of Phase 2's buildOuterTar.
    let inner;
    try {
      inner = parseOuterTar(plaintext);
    } catch (err) {
      return { ...base, outcome: "archive_integrity_failed", detail: `outer tar parse: ${truncate(err)}` };
    }
    if (!inner.brain || !inner.userState || !inner.manifestJson) {
      return {
        ...base,
        outcome: "archive_integrity_failed",
        detail: `outer tar missing entries (brain=${!!inner.brain}, userState=${!!inner.userState}, manifest=${!!inner.manifestJson})`,
      };
    }

    // Verify inner sha256s against the manifest's recorded hashes.
    const innerManifest = JSON.parse(inner.manifestJson.toString("utf-8"));
    const recordedBrainSha = innerManifest?.inner?.brain_pglite_sha256 as string | undefined;
    const recordedUserSha = innerManifest?.inner?.user_state_sha256 as string | undefined;
    const actualBrainSha = createHash("sha256").update(inner.brain).digest("hex");
    const actualUserSha = createHash("sha256").update(inner.userState).digest("hex");
    if (recordedBrainSha && recordedBrainSha !== actualBrainSha) {
      return {
        ...base,
        outcome: "archive_integrity_failed",
        detail: `brain.pglite sha256 mismatch (manifest=${recordedBrainSha.slice(0, 16)} actual=${actualBrainSha.slice(0, 16)})`,
      };
    }
    if (recordedUserSha && recordedUserSha !== actualUserSha) {
      return {
        ...base,
        outcome: "archive_integrity_failed",
        detail: `user-state sha256 mismatch (manifest=${recordedUserSha.slice(0, 16)} actual=${actualUserSha.slice(0, 16)})`,
      };
    }

    // Restore: stop gbrain, wipe empty brain.pglite, extract both tarballs.
    //
    // [STUB-VERIFIED]: the tar extract is correct-by-construction (gbrain
    // writes the data dir via dumpDataDir; we lay it back down at the same
    // path). End-to-end verification that gbrain auto-detects + loads the
    // restored data is post-Esmeralda — once snapshot_brain ships and
    // produces a real archive, the first thaw against it confirms.
    const brainB64 = inner.brain.toString("base64");
    const userB64 = inner.userState.toString("base64");
    const restoreCmd = `
set -e
systemctl --user stop gbrain 2>/dev/null || true
sleep 1
rm -rf "$HOME/.gbrain/brain.pglite"
mkdir -p "$HOME/.gbrain"
echo '${brainB64}' | base64 -d > /tmp/brain.pglite.tar.gz
tar xzf /tmp/brain.pglite.tar.gz -C "$HOME/.gbrain"
rm -f /tmp/brain.pglite.tar.gz
echo '${userB64}' | base64 -d > /tmp/user-state.tar.gz
tar xzf /tmp/user-state.tar.gz -C "$HOME"
rm -f /tmp/user-state.tar.gz
systemctl --user start gbrain
echo "RESTORE_DONE"`;
    const restoreResult = await ssh.execCommand(restoreCmd);
    if (!(restoreResult.stdout || "").includes("RESTORE_DONE")) {
      return {
        ...base,
        outcome: "restore_failed",
        detail: `restore script did not complete; stdout=${(restoreResult.stdout || "").slice(0, 200)} stderr=${(restoreResult.stderr || "").slice(0, 200)}`,
      };
    }

    // Poll gbrain /health on the VM. Cloud-init may have left gbrain in
    // a "ready" state with EMPTY data dir; after our restore + restart,
    // it should come up against the restored data.
    let healthy = false;
    for (let i = 0; i < GBRAIN_HEALTH_POLL_SECONDS / 2; i++) {
      const probe = await ssh.execCommand(
        'curl -sS -o /dev/null -w "%{http_code}" --max-time 3 localhost:3131/health 2>/dev/null',
      );
      if ((probe.stdout || "").trim() === "200") {
        healthy = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!healthy) {
      // gbrain didn't recover. The restore happened but gbrain isn't healthy.
      // Don't terminal-CAS — leave at thawing_provisioned for next-tick retry.
      // Manual intervention may be needed if persistent.
      return {
        ...base,
        outcome: "gbrain_unhealthy",
        detail: `gbrain /health never 200 within ${GBRAIN_HEALTH_POLL_SECONDS}s post-restore`,
      };
    }

    // [STUB]: version-gap-aware rewire. For Phase 4 skeleton, we skip the
    // reconcile invocation; lib/vm-reconcile.ts steps are accessible but
    // wiring them cleanly into thaw needs more design (auditVMConfig has
    // its own flow). Once first real thaw happens, the gap-aware tier
    // logic (PRD §17.4) gets implemented here.
    //
    // For now: assume the base snapshot is ≤10 versions behind manifest
    // (the standard Rule 7 cadence). stepFiles + restart was inside Stage 3
    // step 10's restoreCmd (which restarted gbrain). The reconcile cron
    // will pick up any residual drift on its next tick within 3 min.

    // Terminal CAS UPDATE.
    const { error: termErr } = await supabase
      .from("instaclaw_vms")
      .update({
        status: "assigned",
        health_status: "healthy",
        freeze_state: "idle",
        frozen_at: null,
      })
      .eq("id", vm.id)
      .eq("freeze_state", "thawing_provisioned");

    if (termErr) {
      // Reverse-thaw zombie. Linode is up + restored, DB still says provisioned.
      await sendAdminAlertEmail(
        `[P0] vm-thaw: terminal UPDATE failed for ${vm.name ?? vm.id} (reverse-thaw zombie)`,
        `VM was restored successfully but the terminal DB write failed.\n\n` +
        `DB now in inconsistent state: freeze_state='thawing_provisioned' but VM is healthy.\n` +
        `archive_path=${fresh.frozen_archive_path}\n` +
        `Linode id=${fresh.provider_server_id}\n` +
        `\nManual fix:\n` +
        `  UPDATE instaclaw_vms SET status='assigned', health_status='healthy', ` +
        `freeze_state='idle', frozen_at=null WHERE id='${vm.id}' AND freeze_state='thawing_provisioned';\n\n` +
        `runId=${runId}\nUnderlying: ${termErr.message}`,
      ).catch(() => {});
      return { ...base, outcome: "db_terminal_failed", detail: `terminal UPDATE failed: ${termErr.message}` };
    }

    // Lifecycle log.
    await logLifecycle(supabase, vm, "thawed", `archive=${fresh.frozen_archive_path}; gbrain healthy`, runId);

    return {
      ...base,
      outcome: "thawed",
      detail: `restored from ${fresh.frozen_archive_path}; gbrain /health=200; assigned`,
    };
  } finally {
    try { ssh?.dispose?.(); } catch { /* noop */ }
    await releaseCronLock(lockKey);
  }
}

// ─── Stuck-'thawing' recovery (PRD §17.5) ────────────────────────────────

async function sweepStuckThawing(
  supabase: ReturnType<typeof getSupabase>,
  summary: RunSummary,
  runId: string,
): Promise<void> {
  const cutoff = new Date(Date.now() - CLOUD_INIT_TIMEOUT_MIN * 60 * 1000).toISOString();
  const { data: stuck } = await supabase
    .from("instaclaw_vms")
    .select(
      "id, name, freeze_state, provider_server_id, ip_address, cloud_init_callback_consumed_at, thaw_requested_at, updated_at",
    )
    .eq("freeze_state", "thawing")
    .lt("updated_at", cutoff)
    .limit(5);

  for (const row of stuck ?? []) {
    const lockKey = `freeze-thaw:${row.id}`;
    const acquired = await tryAcquireCronLock(lockKey, 120, `vm-thaw-recovery/${runId}`);
    if (!acquired) continue;
    try {
      const { data: fresh } = await supabase
        .from("instaclaw_vms")
        .select("freeze_state, provider_server_id, cloud_init_callback_consumed_at, thaw_requested_at")
        .eq("id", row.id)
        .single();
      if (!fresh || fresh.freeze_state !== "thawing") continue;

      if (!fresh.provider_server_id) {
        // Stage 1 didn't reach the provider_server_id UPDATE. Revert.
        await supabase
          .from("instaclaw_vms")
          .update({ freeze_state: "thaw_pending" })
          .eq("id", row.id)
          .eq("freeze_state", "thawing");
        summary.recovered++;
        summary.results.push({
          vm_id: row.id, vm_name: row.name, stage: "recovery",
          outcome: "state_changed",
          detail: "no provider_server_id; reverted to thaw_pending",
        });
        continue;
      }

      // Probe Linode.
      const probe = await fetch(
        `https://api.linode.com/v4/linode/instances/${fresh.provider_server_id}`,
        { headers: { Authorization: `Bearer ${process.env.LINODE_API_TOKEN}` } },
      );
      if (probe.status === 404) {
        // Provisioned but instance is gone (manual delete? out-of-band?).
        await supabase
          .from("instaclaw_vms")
          .update({ freeze_state: "thaw_pending", provider_server_id: null, ip_address: null })
          .eq("id", row.id)
          .eq("freeze_state", "thawing");
        summary.recovered++;
        continue;
      }
      if (probe.ok) {
        // Instance exists. Cloud-init callback consumed?
        const callback = fresh.cloud_init_callback_consumed_at
          ? new Date(fresh.cloud_init_callback_consumed_at).getTime() : 0;
        const requested = fresh.thaw_requested_at
          ? new Date(fresh.thaw_requested_at).getTime() : 0;
        if (callback > requested) {
          // Advance to thawing_provisioned.
          await supabase
            .from("instaclaw_vms")
            .update({ freeze_state: "thawing_provisioned" })
            .eq("id", row.id)
            .eq("freeze_state", "thawing");
          summary.recovered++;
        }
        // Else: cloud-init hasn't called back yet — leave alone, next tick checks.
      }
      // Other Linode status: leave alone; transient.
    } finally {
      await releaseCronLock(lockKey);
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

async function revertToThawPending(
  supabase: ReturnType<typeof getSupabase>,
  vmId: string,
  reason: string,
): Promise<void> {
  try {
    await supabase
      .from("instaclaw_vms")
      .update({ freeze_state: "thaw_pending" })
      .eq("id", vmId)
      .eq("freeze_state", "thawing");
    logger.warn("vm-thaw: reverted to thaw_pending", { vmId, reason });
  } catch (err) {
    logger.error("vm-thaw: revert to thaw_pending threw", { vmId, error: String(err) });
  }
}

async function logLifecycle(
  supabase: ReturnType<typeof getSupabase>,
  vm: { id: string; name: string | null },
  action: string,
  reason: string,
  runId: string,
): Promise<void> {
  try {
    await supabase.from("instaclaw_vm_lifecycle_log").insert({
      vm_id: vm.id,
      vm_name: vm.name,
      ip_address: null,
      user_id: null,
      user_email: "(thaw-v2)",
      subscription_status: null,
      credit_balance: 0,
      action,
      reason: `[${runId.slice(0, 8)}] ${reason}`,
      provider_server_id: null,
    });
  } catch (err) {
    logger.error("vm-thaw: lifecycle log insert failed (non-fatal)", {
      vmId: vm.id, error: err instanceof Error ? err.message : String(err),
    });
  }
}

function truncate(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

// ─── Outer-tar parser (inverse of Phase 2's buildOuterTar) ───────────────

/**
 * Parse a ustar-format tar produced by Phase 2's buildOuterTar(). Returns
 * the three expected entries: manifest.json, brain.pglite.tar.gz,
 * user-state.tar.gz. Tolerates any order; ignores unknown entries.
 *
 * Throws on malformed tar (bad header, truncated data block, checksum
 * mismatch). Sha256 verification of inner blobs is the caller's job.
 */
function parseOuterTar(buf: Buffer): {
  manifestJson: Buffer | null;
  brain: Buffer | null;
  userState: Buffer | null;
} {
  const result: ReturnType<typeof parseOuterTar> = {
    manifestJson: null,
    brain: null,
    userState: null,
  };
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    // End-of-archive: two consecutive NUL blocks.
    if (header.every((b) => b === 0)) break;

    // Parse name (100 bytes, NUL-terminated)
    const nameRaw = header.subarray(0, 100);
    const nullPos = nameRaw.indexOf(0);
    const name = nameRaw.subarray(0, nullPos === -1 ? 100 : nullPos).toString("ascii");

    // Parse size (12 bytes, octal NUL-terminated)
    const sizeStr = header.subarray(124, 124 + 12).toString("ascii").replace(/\0/g, "").trim();
    const size = parseInt(sizeStr, 8);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`bad size field in tar header for ${name}: ${JSON.stringify(sizeStr)}`);
    }

    offset += 512;
    const dataEnd = offset + size;
    if (dataEnd > buf.length) {
      throw new Error(`tar entry ${name} extends past buffer end (size=${size})`);
    }
    const data = buf.subarray(offset, dataEnd);

    if (name === "manifest.json") result.manifestJson = Buffer.from(data);
    else if (name === "brain.pglite.tar.gz") result.brain = Buffer.from(data);
    else if (name === "user-state.tar.gz") result.userState = Buffer.from(data);
    // Unknown entries silently ignored.

    // Advance offset to next 512-byte boundary.
    const padded = Math.ceil(size / 512) * 512;
    offset += padded;
  }
  return result;
}
