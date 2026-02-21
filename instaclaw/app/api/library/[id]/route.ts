import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

// Prevent Vercel CDN from caching per-user responses
export const dynamic = "force-dynamic";

const VALID_TYPES = ["research", "draft", "report", "analysis", "code", "post", "other"];

/**
 * GET /api/library/[id]
 * Returns a single library item with full content.
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

  const { data: item, error } = await supabase
    .from("instaclaw_library")
    .select(
      "id, user_id, title, type, content, preview, source_task_id, source_chat_message_id, run_number, tags, is_pinned, created_at, updated_at"
    )
    .eq("id", id)
    .single();

  if (error || !item) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (item.user_id !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json({ item });
}

/**
 * PATCH /api/library/[id]
 * Partial update: { title?, is_pinned?, tags?, type? }
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
  const supabase = getSupabase();

  // Verify ownership
  const { data: existing } = await supabase
    .from("instaclaw_library")
    .select("id, user_id")
    .eq("id", id)
    .single();

  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (existing.user_id !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const update: Record<string, unknown> = {};

  if (typeof body.title === "string") update.title = body.title;
  if (typeof body.is_pinned === "boolean") update.is_pinned = body.is_pinned;
  if (Array.isArray(body.tags)) update.tags = body.tags;
  if (typeof body.type === "string" && VALID_TYPES.includes(body.type)) {
    update.type = body.type;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const { data: item, error } = await supabase
    .from("instaclaw_library")
    .update(update)
    .eq("id", id)
    .select(
      "id, user_id, title, type, content, preview, source_task_id, source_chat_message_id, run_number, tags, is_pinned, created_at, updated_at"
    )
    .single();

  if (error) {
    return NextResponse.json({ error: "Failed to update" }, { status: 500 });
  }

  return NextResponse.json({ item });
}

/**
 * DELETE /api/library/[id]
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
    .from("instaclaw_library")
    .delete()
    .eq("id", id)
    .eq("user_id", session.user.id);

  if (error) {
    return NextResponse.json({ error: "Failed to delete" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
