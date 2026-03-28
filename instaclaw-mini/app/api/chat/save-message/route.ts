import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { supabase } from "@/lib/supabase";

/**
 * POST /api/chat/save-message — Save an assistant message after streaming completes.
 * Body: { conversation_id, content }
 */
export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    const { conversation_id, content } = await req.json();

    if (!conversation_id || !content) {
      return NextResponse.json({ error: "conversation_id and content required" }, { status: 400 });
    }

    // Save assistant message
    await supabase().from("instaclaw_chat_messages").insert({
      user_id: session.userId,
      conversation_id,
      role: "assistant",
      content,
    });

    // Update conversation preview
    const { count } = await supabase()
      .from("instaclaw_chat_messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", conversation_id);

    await supabase()
      .from("instaclaw_conversations")
      .update({
        last_message_preview: content.slice(0, 100),
        message_count: count || 0,
        updated_at: new Date().toISOString(),
      })
      .eq("id", conversation_id);

    return NextResponse.json({ success: true });
  } catch (err) {
    if (err instanceof Error && err.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
