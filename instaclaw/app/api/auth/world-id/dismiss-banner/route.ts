import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

export async function POST() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();

    const { error } = await supabase
      .from("instaclaw_users")
      .update({ world_id_banner_dismissed_at: new Date().toISOString() })
      .eq("id", session.user.id);

    if (error) {
      logger.error("Failed to dismiss World ID banner", {
        error: String(error),
        userId: session.user.id,
        route: "world-id/dismiss-banner",
      });
      return NextResponse.json(
        { error: "Failed to dismiss" },
        { status: 500 }
      );
    }

    return NextResponse.json({ dismissed: true });
  } catch (err) {
    logger.error("Dismiss banner error", {
      error: String(err),
      route: "world-id/dismiss-banner",
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
