import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

// Prevent Vercel CDN from caching per-user responses
export const dynamic = "force-dynamic";

/**
 * GET /api/chat/conversations
 * List conversations for the authenticated user (non-archived, newest first).
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("instaclaw_conversations")
    .select("id, title, created_at, updated_at, is_archived, last_message_preview, message_count")
    .eq("user_id", session.user.id)
    .eq("is_archived", false)
    .order("updated_at", { ascending: false })
    .limit(100);

  if (error) {
    return NextResponse.json({ error: "Failed to fetch conversations" }, { status: 500 });
  }

  return NextResponse.json({ conversations: data ?? [] });
}

/**
 * POST /api/chat/conversations
 * Create a new conversation.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let title = "New Chat";
  try {
    const body = await req.json();
    if (body.title && typeof body.title === "string") {
      title = body.title.trim().slice(0, 100) || "New Chat";
    }
  } catch {
    // Use default title
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("instaclaw_conversations")
    .insert({ user_id: session.user.id, title })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: "Failed to create conversation" }, { status: 500 });
  }

  return NextResponse.json({ conversation: data });
}
