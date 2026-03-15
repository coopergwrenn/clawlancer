import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * POST /api/instagram/disconnect
 * Disconnects the user's Instagram integration.
 * Deletes the integration record and marks the skill as disconnected.
 */
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();

  // Delete the integration record
  const { error: deleteError } = await supabase
    .from("instaclaw_instagram_integrations")
    .delete()
    .eq("user_id", session.user.id);

  if (deleteError) {
    logger.error("Instagram disconnect failed", {
      route: "instagram/disconnect",
      userId: session.user.id,
      error: deleteError.message,
    });
    return NextResponse.json(
      { error: "Failed to disconnect" },
      { status: 500 }
    );
  }

  // Delete associated triggers
  await supabase
    .from("instaclaw_instagram_triggers")
    .delete()
    .eq("user_id", session.user.id);

  // Delete rate limit records
  await supabase
    .from("instaclaw_instagram_rate_limits")
    .delete()
    .eq("user_id", session.user.id);

  // Mark skill as disconnected
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id")
    .eq("assigned_to", session.user.id)
    .single();

  if (vm) {
    const { data: skill } = await supabase
      .from("instaclaw_skills")
      .select("id")
      .eq("slug", "instagram-automation")
      .single();

    if (skill) {
      await supabase
        .from("instaclaw_vm_skills")
        .update({ enabled: false, connected: false, connected_account: null })
        .eq("vm_id", vm.id)
        .eq("skill_id", skill.id);
    }
  }

  logger.info("Instagram disconnected", {
    route: "instagram/disconnect",
    userId: session.user.id,
  });

  return NextResponse.json({ disconnected: true });
}
