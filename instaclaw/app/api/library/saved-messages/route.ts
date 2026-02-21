import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

// Prevent Vercel CDN from caching per-user responses
export const dynamic = "force-dynamic";

/**
 * GET /api/library/saved-messages
 * Returns the set of chat message IDs that are already saved to the library.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("instaclaw_library")
    .select("source_chat_message_id")
    .eq("user_id", session.user.id)
    .not("source_chat_message_id", "is", null);

  if (error) {
    return NextResponse.json({ ids: [] });
  }

  const ids = (data ?? [])
    .map((d) => d.source_chat_message_id)
    .filter(Boolean);

  return NextResponse.json({ ids });
}
