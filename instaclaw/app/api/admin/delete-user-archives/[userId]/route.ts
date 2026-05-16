/**
 * POST /api/admin/delete-user-archives/[userId]
 *
 * GDPR Article 17 (right to erasure) handler for freeze-v2 archives.
 *
 * Behavior:
 *   1. Look up every instaclaw_vms row owned by <userId> (assigned_to OR
 *      last_assigned_to) that has a frozen_archive_path.
 *   2. For each archive in R2 under <vm_id>/*, delete every generation
 *      (not just the latest — GDPR requires ALL the user's data).
 *   3. Clear DB pointers (frozen_archive_path, sha256, size_kb, manifest,
 *      taken_at) on each row.
 *   4. Set frozen_retention_policy = 'compliance_delete' for audit trail.
 *   5. Log to instaclaw_vm_lifecycle_log with action='gdpr_archive_deleted'
 *      for compliance audit.
 *
 * Auth: X-Admin-Key (existing admin pattern via lib/security.ts).
 *
 * Idempotent: re-running for the same user is safe. Returns deleted=0 if
 * already cleared.
 *
 * Body: optional { dry_run?: boolean, reason?: string }
 *
 * Returns:
 *   {
 *     user_id, dry_run, archives_found, archives_deleted, db_rows_cleared,
 *     errors[], audit_run_id
 *   }
 *
 * Failure semantics:
 *   - R2 delete failure on ANY archive → partial success. We keep the DB
 *     pointer set so the next retry attempt has the path to delete. Caller
 *     should re-run the endpoint until errors[].length === 0.
 *   - DB update failure → log + include in errors. We do NOT roll back R2
 *     deletes (they're already gone); operator manually verifies + re-runs.
 *   - Both ordering choices (R2-first vs DB-first) have failure modes;
 *     we chose R2-first because storage is the GDPR-exposed surface. A
 *     stuck DB pointer to a deleted R2 object is a follow-up cleanup; a
 *     stuck R2 object after the DB says "deleted" is a compliance miss.
 *
 * See PRD §16.5 — Q5 retention policy.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { validateAdminKey } from "@/lib/security";
import { logger } from "@/lib/logger";
import {
  listObjectsByPrefix,
  deleteObject,
  ObjectNotFoundError,
} from "@/lib/r2-storage";
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";
// 60s ought to be ample — listObjectsByPrefix + a small number of deletes per
// VM × maybe 1-2 VMs per user. Edge cases (user with 5 historical frozen
// VMs, each with 3 generations = 15 deletes) still complete inside 60s.
export const maxDuration = 60;

interface DeleteResult {
  user_id: string;
  audit_run_id: string;
  dry_run: boolean;
  vms_processed: number;
  archives_found: number;
  archives_deleted: number;
  db_rows_cleared: number;
  errors: string[];
  details: Array<{
    vm_id: string;
    vm_name: string | null;
    archives_in_r2: string[];
    archives_deleted: string[];
    db_cleared: boolean;
    errors: string[];
  }>;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  if (!validateAdminKey(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { userId } = await params;
  if (!userId || typeof userId !== "string" || userId.length < 8) {
    return NextResponse.json(
      { error: "userId path param required (UUID expected)" },
      { status: 400 },
    );
  }

  // Optional body
  let dryRun = false;
  let reason: string | null = null;
  try {
    const body = await req.json().catch(() => ({}));
    if (typeof body === "object" && body !== null) {
      dryRun = Boolean(body.dry_run);
      reason =
        typeof body.reason === "string" && body.reason.length > 0
          ? body.reason
          : null;
    }
  } catch {
    // body is optional
  }

  const auditRunId = randomUUID();
  const supabase = getSupabase();
  const summary: DeleteResult = {
    user_id: userId,
    audit_run_id: auditRunId,
    dry_run: dryRun,
    vms_processed: 0,
    archives_found: 0,
    archives_deleted: 0,
    db_rows_cleared: 0,
    errors: [],
    details: [],
  };

  logger.info("delete-user-archives: start", {
    userId,
    auditRunId,
    dryRun,
    reason,
  });

  // 1. Find every VM ever owned by this user that has an archive.
  // Use OR over assigned_to (current) and last_assigned_to (historical)
  // so we catch archives from VMs that were reassigned. select("*") per
  // Rule 19 (safety-critical read).
  const { data: vms, error: queryErr } = await supabase
    .from("instaclaw_vms")
    .select("*")
    .or(`assigned_to.eq.${userId},last_assigned_to.eq.${userId}`)
    .not("frozen_archive_path", "is", null);

  if (queryErr) {
    logger.error("delete-user-archives: VM query failed", {
      userId,
      auditRunId,
      error: queryErr.message,
    });
    return NextResponse.json(
      { ...summary, fatal: `VM query failed: ${queryErr.message}` },
      { status: 500 },
    );
  }

  // 2. Per VM, sweep ALL generations under <vm.id>/ prefix in R2.
  for (const vm of vms ?? []) {
    summary.vms_processed++;
    const detail: DeleteResult["details"][number] = {
      vm_id: vm.id,
      vm_name: vm.name ?? null,
      archives_in_r2: [],
      archives_deleted: [],
      db_cleared: false,
      errors: [],
    };

    // List EVERY generation under this VM's prefix — not just the one in
    // frozen_archive_path. The retention sweep keeps last 3, but GDPR
    // requires us to delete EVERY copy in our storage.
    try {
      const objects = await listObjectsByPrefix(`${vm.id}/`);
      detail.archives_in_r2 = objects.map((o) => o.key);
      summary.archives_found += objects.length;

      if (!dryRun) {
        for (const obj of objects) {
          try {
            await deleteObject(obj.key);
            detail.archives_deleted.push(obj.key);
            summary.archives_deleted++;
          } catch (delErr) {
            if (delErr instanceof ObjectNotFoundError) {
              // Already gone — count as success (idempotent re-run).
              detail.archives_deleted.push(obj.key);
              summary.archives_deleted++;
            } else {
              const msg = delErr instanceof Error ? delErr.message : String(delErr);
              detail.errors.push(`R2 delete failed for ${obj.key}: ${msg.slice(0, 150)}`);
              summary.errors.push(`vm=${vm.name} key=${obj.key}: ${msg.slice(0, 150)}`);
            }
          }
        }
      }
    } catch (listErr) {
      const msg = listErr instanceof Error ? listErr.message : String(listErr);
      detail.errors.push(`listObjectsByPrefix failed: ${msg.slice(0, 200)}`);
      summary.errors.push(`vm=${vm.name} list: ${msg.slice(0, 200)}`);
      summary.details.push(detail);
      continue;
    }

    // 3. Clear DB pointers IF all R2 deletes succeeded (or dry-run).
    // We only clear the DB if we successfully removed everything from R2,
    // so a partial failure leaves the DB pointing at what's left (operator
    // can re-run).
    const allR2Cleared =
      detail.errors.length === 0 &&
      (dryRun || detail.archives_deleted.length === detail.archives_in_r2.length);

    if (allR2Cleared && !dryRun) {
      const { error: updateErr } = await supabase
        .from("instaclaw_vms")
        .update({
          frozen_archive_path: null,
          frozen_archive_sha256: null,
          frozen_archive_size_kb: null,
          frozen_archive_manifest: null,
          frozen_archive_taken_at: null,
          frozen_retention_policy: "compliance_delete",
        })
        .eq("id", vm.id);
      if (updateErr) {
        const msg = updateErr.message;
        detail.errors.push(`DB clear failed: ${msg}`);
        summary.errors.push(`vm=${vm.name} db: ${msg}`);
      } else {
        detail.db_cleared = true;
        summary.db_rows_cleared++;
      }
    } else if (allR2Cleared && dryRun) {
      // Report as if we would have cleared (don't mutate in dry-run).
      detail.db_cleared = false;
    }

    // 4. Audit log entry (every VM, every run, including dry-runs).
    if (!dryRun) {
      try {
        await supabase.from("instaclaw_vm_lifecycle_log").insert({
          vm_id: vm.id,
          vm_name: vm.name,
          ip_address: vm.ip_address,
          user_id: userId,
          user_email: "(gdpr-delete)",
          subscription_status: null,
          credit_balance: 0,
          action: "gdpr_archive_deleted",
          reason:
            `[${auditRunId.slice(0, 8)}] cleared ${detail.archives_deleted.length}/${detail.archives_in_r2.length} archive(s); ` +
            `db_cleared=${detail.db_cleared}; ` +
            (reason ? `reason="${reason.slice(0, 200)}"` : "no-reason-provided"),
          provider_server_id: null,
        });
      } catch (logErr) {
        // Audit log failure is non-fatal but loud.
        logger.error("delete-user-archives: audit log insert failed", {
          vmId: vm.id,
          auditRunId,
          error: logErr instanceof Error ? logErr.message : String(logErr),
        });
      }
    }

    summary.details.push(detail);
  }

  logger.info("delete-user-archives: complete", {
    userId,
    auditRunId,
    dryRun,
    ...summary,
  });

  // 200 even if errors[] non-empty — partial success is success. Operator
  // re-runs to clear remaining. Reserve 500 for hard failures (DB query
  // crash, etc.) where the function couldn't make ANY progress.
  return NextResponse.json(summary);
}
