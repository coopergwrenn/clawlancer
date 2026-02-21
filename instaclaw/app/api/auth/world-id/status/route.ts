import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

// Prevent Vercel CDN from caching per-user responses
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();

    // Get user's world_id fields
    const { data: user } = await supabase
      .from("instaclaw_users")
      .select(
        "id, world_id_verified, world_id_verification_level, world_id_verified_at, world_id_banner_dismissed_at"
      )
      .eq("id", session.user.id)
      .single();

    // Count total verified users for social proof
    const { count } = await supabase
      .from("instaclaw_users")
      .select("id", { count: "exact", head: true })
      .eq("world_id_verified", true);

    // Banner dismissed = dismissed_at exists AND is within the last 7 days
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const dismissedAt = user?.world_id_banner_dismissed_at
      ? new Date(user.world_id_banner_dismissed_at).getTime()
      : null;
    const bannerDismissed =
      dismissedAt !== null && Date.now() - dismissedAt < SEVEN_DAYS_MS;

    return NextResponse.json({
      userId: user?.id ?? session.user.id,
      verified: user?.world_id_verified ?? false,
      verification_level: user?.world_id_verification_level ?? null,
      verified_at: user?.world_id_verified_at ?? null,
      banner_dismissed: bannerDismissed,
      total_verified_count: count ?? 0,
    });
  } catch (err) {
    logger.error("World ID status error", {
      error: String(err),
      route: "world-id/status",
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
