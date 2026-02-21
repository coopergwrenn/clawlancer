import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

// Prevent Vercel CDN from caching per-user responses
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;

/**
 * GET /api/chat/conversations/[id]/messages
 * Returns messages for a specific conversation (chronological order).
 * Supports ?before=<iso> cursor for pagination.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: conversationId } = await params;
  const supabase = getSupabase();

  // Verify conversation belongs to user
  const { data: conv, error: convErr } = await supabase
    .from("instaclaw_conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("user_id", session.user.id)
    .single();

  if (convErr || !conv) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  const before = req.nextUrl.searchParams.get("before");
  const limitParam = req.nextUrl.searchParams.get("limit");
  const limit = Math.min(
    Math.max(1, parseInt(limitParam ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT),
    200
  );

  let query = supabase
    .from("instaclaw_chat_messages")
    .select("id, role, content, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (before) {
    query = query.lt("created_at", before);
  }

  const { data: messages, error } = await query;

  if (error) {
    return NextResponse.json({ error: "Failed to fetch messages" }, { status: 500 });
  }

  // Reverse to chronological order
  return NextResponse.json({
    messages: (messages ?? []).reverse(),
  });
}
