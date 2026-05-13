/**
 * POST /api/admin/privacy-override
 *
 * Admin kill switch for Maximum Privacy Mode. Force-nulls
 * instaclaw_users.privacy_mode_until immediately, regardless of the 24h
 * auto-revert window. The next operator SSH through the privacy bridge
 * (or the next internal check API call) will see privacy off and behave
 * accordingly within `CACHE_TTL_SECONDS` (30s, bridge-side cache).
 *
 * Purpose: legal compliance. If a subpoena or law-enforcement request
 * lands and we need to disable a user's privacy mode IMMEDIATELY (not
 * wait up to 24h for the timer), this endpoint is the action.
 *
 * Body: { user_id: string, reason: string } — reason is REQUIRED and
 * logged to instaclaw_operator_audit_log with decision='admin_override'.
 *
 * Auth: X-Admin-Key header (same as other /api/admin/* endpoints).
 * Added to middleware.ts selfAuthAPIs allow-list.
 *
 * Audit trail:
 *   - operator_audit_log row with command='/api/admin/privacy-override',
 *     decision='admin_override', reason=<provided>,
 *     privacy_mode_active=<state-before>, vm_id=<user's most recent VM>.
 *   - logger.warn with the same shape, for Vercel logs.
 *
 * Effect timing:
 *   - DB update is immediate.
 *   - Bridge sees the new state on its next probe (cache TTL 30s) — so
 *     within ~30s, all operator SSH calls will see privacy off.
 *   - To accelerate, the bridge cache can be invalidated by SSH'ing in
 *     via the bypass key and `rm ~/.openclaw/cache/privacy-mode.json`,
 *     but this is rarely necessary.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

interface OverrideBody {
  user_id: string;
  reason: string;
}

export async function POST(req: NextRequest) {
  // ── Auth ──
  const adminKey = req.headers.get("x-admin-key");
  if (!adminKey || adminKey !== process.env.ADMIN_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── Body parse + validation ──
  let body: OverrideBody;
  try {
    body = (await req.json()) as OverrideBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.user_id || typeof body.user_id !== "string") {
    return NextResponse.json(
      { error: "Body must include { user_id: string }" },
      { status: 400 }
    );
  }
  if (!body.reason || typeof body.reason !== "string" || body.reason.trim().length === 0) {
    // Reason is REQUIRED. The whole point of the endpoint is auditable
    // compliance overrides; an unexplained override defeats that.
    return NextResponse.json(
      { error: "Body must include { reason: string } (non-empty)" },
      { status: 400 }
    );
  }
  if (body.reason.length > 2000) {
    return NextResponse.json(
      { error: "reason too long (max 2000 chars)" },
      { status: 400 }
    );
  }

  const supabase = getSupabase();

  // ── Snapshot current state (for audit + before/after diff in response) ──
  // .select("*") per Rule 19 — safety-critical read; we're about to take
  // destructive action.
  const { data: user, error: userErr } = await supabase
    .from("instaclaw_users")
    .select("*")
    .eq("id", body.user_id)
    .single();

  if (userErr || !user) {
    return NextResponse.json(
      { error: "User not found", details: userErr?.message },
      { status: 404 }
    );
  }

  const wasActive =
    user.privacy_mode_until !== null &&
    new Date(user.privacy_mode_until as string).getTime() > Date.now();

  // ── Look up the user's most recent VM for the audit-log row ──
  // The audit log's vm_id is NOT NULL. For admin overrides we use the
  // user's most recent assigned VM (best-effort attribution — the action
  // affects bridge behavior on that VM). If the user has no VM, skip the
  // audit-log row and rely on the logger.warn (the DB action is still
  // recorded; the cron sample-operator-audit just won't include it).
  const { data: vms } = await supabase
    .from("instaclaw_vms")
    .select("id")
    .eq("assigned_to", body.user_id)
    .order("created_at", { ascending: false })
    .limit(1);
  const vmId = vms?.[0]?.id ?? null;

  // ── Perform the override (idempotent — no-op if already null) ──
  const { error: updErr } = await supabase
    .from("instaclaw_users")
    .update({ privacy_mode_until: null })
    .eq("id", body.user_id);

  if (updErr) {
    logger.error("admin/privacy-override: update failed", {
      userId: body.user_id,
      reason: body.reason,
      error: updErr.message,
      route: "admin/privacy-override",
    });
    return NextResponse.json(
      { error: "Update failed", details: updErr.message },
      { status: 500 }
    );
  }

  // ── Audit-log row (best-effort; logging failure does NOT roll back) ──
  if (vmId) {
    const { error: auditErr } = await supabase
      .from("instaclaw_operator_audit_log")
      .insert({
        vm_id: vmId,
        user_id: body.user_id,
        command: "POST /api/admin/privacy-override",
        decision: "admin_override",
        privacy_mode_active: wasActive,
        reason: body.reason.trim(),
      });
    if (auditErr) {
      // Non-fatal — the override itself succeeded. Log loudly.
      logger.error("admin/privacy-override: audit-log insert failed (override succeeded)", {
        userId: body.user_id,
        vmId,
        reason: body.reason,
        error: auditErr.message,
        route: "admin/privacy-override",
      });
    }
  }

  // ── Vercel-side log of the override (always, regardless of audit-log) ──
  logger.warn("admin/privacy-override applied", {
    userId: body.user_id,
    vmId,
    wasActive,
    reason: body.reason.trim(),
    route: "admin/privacy-override",
  });

  return NextResponse.json({
    ok: true,
    user_id: body.user_id,
    privacy_was_active: wasActive,
    privacy_mode_until_now: null,
    audit_logged: !!vmId,
    note: vmId
      ? "Bridge cache TTL is 30s; effect lands on next operator SSH within ~30s."
      : "No VM assigned to user; audit-log row skipped (override still applied). Bridge effect is moot if there's no VM.",
  });
}
