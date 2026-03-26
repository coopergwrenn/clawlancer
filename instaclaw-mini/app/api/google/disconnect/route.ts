import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * POST /api/google/disconnect
 *
 * Disconnects Google from the user's account by clearing Gmail fields.
 */
export async function POST() {
  try {
    const session = await requireSession();

    const { error } = await supabase()
      .from("instaclaw_users")
      .update({
        gmail_connected: false,
        gmail_access_token: null,
        gmail_refresh_token: null,
        gmail_connected_at: null,
      })
      .eq("id", session.userId);

    if (error) {
      console.error("[Google Disconnect] DB error:", error);
      return NextResponse.json({ error: "Failed to disconnect" }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    if (err instanceof Error && err.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to disconnect" }, { status: 500 });
  }
}
