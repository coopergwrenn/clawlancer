import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

/**
 * GET /api/chat/conversations/[id]
 * Fetch a single conversation's metadata, scoped to the owner. Returns archived
 * rows too (delete is a soft-archive), so the sidebar Sessions index can:
 *   (a) hydrate a deep-linked / pinned session whose row is outside the 100-item
 *       conversations list (Race-3 hydration), and
 *   (b) detect an archived pin to self-heal (drop the dead pin).
 * Returns 404 when the conversation doesn't exist or isn't owned by the caller.
 * Session-authed (no middleware allow-list entry needed — Rule 13).
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("instaclaw_conversations")
    .select(
      "id, title, created_at, updated_at, is_archived, last_message_preview, message_count"
    )
    .eq("id", id)
    .eq("user_id", session.user.id)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: "Failed to fetch conversation" }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ conversation: data });
}

/**
 * PATCH /api/chat/conversations/[id]
 * Rename or archive a conversation.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  let body: { title?: string; is_archived?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};
  if (typeof body.title === "string") {
    updates.title = body.title.trim().slice(0, 100) || "Untitled";
  }
  if (typeof body.is_archived === "boolean") {
    updates.is_archived = body.is_archived;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("instaclaw_conversations")
    .update(updates)
    .eq("id", id)
    .eq("user_id", session.user.id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: "Failed to update conversation" }, { status: 500 });
  }

  return NextResponse.json({ conversation: data });
}

/**
 * DELETE /api/chat/conversations/[id]
 * Soft-delete (archive) a conversation.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const supabase = getSupabase();

  const { error } = await supabase
    .from("instaclaw_conversations")
    .update({ is_archived: true })
    .eq("id", id)
    .eq("user_id", session.user.id);

  if (error) {
    return NextResponse.json({ error: "Failed to archive conversation" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
