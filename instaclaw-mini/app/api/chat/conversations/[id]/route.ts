import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/** GET /api/chat/conversations/[id] — Get messages for a conversation */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requireSession();
    const { id } = await params;

    // Verify ownership
    const { data: conv } = await supabase()
      .from("instaclaw_conversations")
      .select("id")
      .eq("id", id)
      .eq("user_id", session.userId)
      .single();

    if (!conv) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const { data: messages } = await supabase()
      .from("instaclaw_chat_messages")
      .select("id, role, content, created_at")
      .eq("conversation_id", id)
      .order("created_at", { ascending: true })
      .limit(200);

    return NextResponse.json({ messages: messages || [] });
  } catch (err) {
    if (err instanceof Error && err.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to fetch messages" }, { status: 500 });
  }
}

/** PATCH /api/chat/conversations/[id] — Rename or archive */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requireSession();
    const { id } = await params;
    const body = await req.json();

    const update: Record<string, unknown> = {};
    if (body.title !== undefined) update.title = body.title;
    if (body.is_archived !== undefined) update.is_archived = body.is_archived;
    update.updated_at = new Date().toISOString();

    const { data, error } = await supabase()
      .from("instaclaw_conversations")
      .update(update)
      .eq("id", id)
      .eq("user_id", session.userId)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: "Failed to update" }, { status: 500 });
    }

    return NextResponse.json({ conversation: data });
  } catch (err) {
    if (err instanceof Error && err.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to update" }, { status: 500 });
  }
}

/** DELETE /api/chat/conversations/[id] — Archive (soft delete) */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requireSession();
    const { id } = await params;

    await supabase()
      .from("instaclaw_conversations")
      .update({ is_archived: true, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", session.userId);

    return NextResponse.json({ success: true });
  } catch (err) {
    if (err instanceof Error && err.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to delete" }, { status: 500 });
  }
}
