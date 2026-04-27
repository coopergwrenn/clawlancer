import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { validateAdminKey } from "@/lib/security";
import { thawVM } from "@/lib/vm-freeze-thaw";
import { logger } from "@/lib/logger";
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";
// Worst case: provision new Linode (~60-120s) + wait running (~30-60s) + SSH check.
// 300s gives us comfortable margin.
export const maxDuration = 300;

/**
 * POST /api/admin/thaw-vm
 *
 * Manual thaw — provision a new Linode from a user's frozen image, restore
 * DB pointers, delete the personal image. Use cases:
 *   - User reactivated subscription but the Stripe webhook auto-thaw failed
 *   - Customer support escalation (user wants their VM back early)
 *   - Migrating a frozen VM to a new region
 *
 * Auth: X-Admin-Key (same as other admin endpoints).
 *
 * Body: { user_id: string; dry_run?: boolean }
 *
 * Returns the ThawResult — { success, reason, vmId?, newProviderServerId?, newIp? }.
 *
 * Safety: thawVM() enforces PRD rule 7 (only this user's image used to thaw
 * this user's VM). If multiple frozen VMs exist for the user, the call
 * refuses and requires manual investigation.
 */
export async function POST(req: NextRequest) {
  if (!validateAdminKey(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { user_id?: string; dry_run?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { user_id: userId, dry_run: dryRun = false } = body;
  if (!userId || typeof userId !== "string") {
    return NextResponse.json({ error: "user_id required" }, { status: 400 });
  }

  const supabase = getSupabase();
  const runId = randomUUID();
  const startMs = Date.now();

  try {
    const result = await thawVM(supabase, userId, dryRun, runId);
    const durationMs = Date.now() - startMs;

    logger.info("admin/thaw-vm: done", {
      route: "admin/thaw-vm",
      runId,
      userId,
      dryRun,
      success: result.success,
      reason: result.reason,
      vmId: result.vmId,
      durationMs,
    });

    return NextResponse.json({
      ...result,
      runId,
      durationMs,
    }, { status: result.success ? 200 : 422 });
  } catch (err) {
    const durationMs = Date.now() - startMs;
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("admin/thaw-vm: threw", {
      route: "admin/thaw-vm",
      runId,
      userId,
      error: msg,
      durationMs,
    });
    return NextResponse.json(
      { error: msg, runId, durationMs },
      { status: 500 },
    );
  }
}
