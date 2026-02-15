import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

/**
 * GET /api/tasks/[id]
 * Returns a single task by ID (for polling status updates).
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

  const { data: task, error } = await supabase
    .from("instaclaw_tasks")
    .select("*")
    .eq("id", id)
    .eq("user_id", session.user.id)
    .single();

  if (error || !task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  return NextResponse.json({ task });
}

/**
 * PATCH /api/tasks/[id]
 * Partial update: { status?, title?, is_recurring?, frequency?, result? }
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
    .from("instaclaw_tasks")
    .select("id, status")
    .eq("id", id)
    .eq("user_id", session.user.id)
    .single();

  if (!existing) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  // Build safe update object
  const update: Record<string, unknown> = {};

  if (typeof body.status === "string") {
    const validTransitions: Record<string, string[]> = {
      queued: ["in_progress", "completed"],
      in_progress: ["completed", "failed"],
      completed: ["queued"],
      failed: ["queued", "active"],
      active: ["completed", "paused"],
      paused: ["active"],
    };
    const allowed = validTransitions[existing.status] ?? [];
    if (!allowed.includes(body.status)) {
      return NextResponse.json(
        { error: `Cannot transition from '${existing.status}' to '${body.status}'` },
        { status: 400 }
      );
    }
    update.status = body.status;

    // Resume logic: reset failures and recalculate next_run_at
    if (
      body.status === "active" &&
      (existing.status === "failed" || existing.status === "paused")
    ) {
      update.consecutive_failures = 0;
      update.error_message = null;
      // Schedule next run in 5 minutes (gives the scheduler time to pick it up)
      update.next_run_at = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    }
  }

  if (typeof body.title === "string") update.title = body.title;
  if (typeof body.result === "string") update.result = body.result;
  if (typeof body.is_recurring === "boolean") update.is_recurring = body.is_recurring;
  if (typeof body.frequency === "string" || body.frequency === null) {
    update.frequency = body.frequency;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const { data: task, error } = await supabase
    .from("instaclaw_tasks")
    .update(update)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: "Failed to update task" }, { status: 500 });
  }

  return NextResponse.json({ task });
}

/**
 * DELETE /api/tasks/[id]
 * Hard delete the task record.
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
    .from("instaclaw_tasks")
    .delete()
    .eq("id", id)
    .eq("user_id", session.user.id);

  if (error) {
    return NextResponse.json({ error: "Failed to delete task" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
