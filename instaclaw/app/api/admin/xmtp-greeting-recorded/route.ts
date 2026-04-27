import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/xmtp-greeting-recorded
 *
 * Called by the on-VM xmtp-agent.mjs immediately after a successful
 * `dm.sendText(greeting)`. Marks the user as having received the proactive
 * World Chat greeting so subsequent VM re-provisions don't double-greet.
 *
 * Auth: Bearer <gateway_token> — same scheme as /api/vm/files/delivered.
 * The gateway_token is per-VM and looks up the VM record, from which we
 * derive the assigned user_id.
 *
 * Idempotent: only writes the timestamp if it's currently NULL. Subsequent
 * calls are no-ops.
 */
export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization");
    const token = authHeader?.replace("Bearer ", "");
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();

    // Look up the VM by gateway token
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, name, assigned_to")
      .eq("gateway_token", token)
      .single();

    if (!vm || !vm.assigned_to) {
      logger.warn("xmtp-greeting-recorded: token did not resolve to an assigned VM", {
        route: "admin/xmtp-greeting-recorded",
      });
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }

    // Update only if currently NULL — keeps the FIRST successful delivery time.
    const { data: updated, error } = await supabase
      .from("instaclaw_users")
      .update({ xmtp_greeting_sent_at: new Date().toISOString() })
      .eq("id", vm.assigned_to)
      .is("xmtp_greeting_sent_at", null)
      .select("id, xmtp_greeting_sent_at");

    if (error) {
      logger.error("xmtp-greeting-recorded: DB update failed", {
        route: "admin/xmtp-greeting-recorded",
        vmId: vm.id,
        vmName: vm.name,
        userId: vm.assigned_to,
        error: String(error),
      });
      return NextResponse.json({ error: "Update failed" }, { status: 500 });
    }

    const wasNew = (updated?.length ?? 0) > 0;
    logger.info(`xmtp-greeting-recorded: ${wasNew ? "first delivery recorded" : "no-op (already recorded)"}`, {
      route: "admin/xmtp-greeting-recorded",
      vmId: vm.id,
      vmName: vm.name,
      userId: vm.assigned_to,
      wasNew,
    });

    return NextResponse.json({ recorded: wasNew });
  } catch (err) {
    logger.error("xmtp-greeting-recorded: unexpected error", {
      route: "admin/xmtp-greeting-recorded",
      error: String(err),
    });
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
