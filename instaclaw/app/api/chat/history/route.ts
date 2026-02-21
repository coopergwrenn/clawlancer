import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

// Prevent Vercel CDN from caching per-user responses
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;

/**
 * GET /api/chat/history
 *
 * Returns the user's chat history, ordered by created_at ascending.
 * Supports ?limit=N and optional ?conversation_id= for multi-chat.
 * If no conversation_id, returns the most recent conversation's messages.
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limitParam = req.nextUrl.searchParams.get("limit");
  const limit = Math.min(
    Math.max(1, parseInt(limitParam ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT),
    200
  );

  const conversationId = req.nextUrl.searchParams.get("conversation_id");
  const supabase = getSupabase();

  let query = supabase
    .from("instaclaw_chat_messages")
    .select("id, role, content, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (conversationId) {
    query = query.eq("conversation_id", conversationId);
  } else {
    // Backward compat: find most recent conversation for this user
    const { data: recent } = await supabase
      .from("instaclaw_conversations")
      .select("id")
      .eq("user_id", session.user.id)
      .eq("is_archived", false)
      .order("updated_at", { ascending: false })
      .limit(1)
      .single();

    if (recent) {
      query = query.eq("conversation_id", recent.id);
    } else {
      query = query.eq("user_id", session.user.id);
    }
  }

  const { data: messages, error } = await query;

  if (error) {
    return NextResponse.json(
      { error: "Failed to fetch chat history" },
      { status: 500 }
    );
  }

  // Reverse to get chronological order (we fetched newest-first for the LIMIT to work correctly)
  return NextResponse.json({
    messages: (messages ?? []).reverse(),
  });
}
