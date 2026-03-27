import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Valid state transitions (matches web app exactly)
const VALID_TRANSITIONS: Record<string, string[]> = {
  queued: ["in_progress", "completed"],
  in_progress: ["completed", "failed"],
  completed: ["queued"],
  failed: ["queued", "active"],
  active: ["completed", "paused"],
  paused: ["active"],
};

/** GET /api/tasks/[id] — Fetch a single task */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requireSession();
    const { id } = await params;

    const { data: task } = await supabase()
      .from("instaclaw_tasks")
      .select("*")
      .eq("id", id)
      .eq("user_id", session.userId)
      .single();

    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    return NextResponse.json({ task });
  } catch (err) {
    if (err instanceof Error && err.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to fetch task" }, { status: 500 });
  }
}

/** PATCH /api/tasks/[id] — Update task (status, title, etc.) */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requireSession();
    const { id } = await params;
    const body = await req.json();

    // Verify ownership
    const { data: task } = await supabase()
      .from("instaclaw_tasks")
      .select("*")
      .eq("id", id)
      .eq("user_id", session.userId)
      .single();

    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    const update: Record<string, unknown> = {};

    // Status change with validation
    if (body.status && body.status !== task.status) {
      const allowed = VALID_TRANSITIONS[task.status] || [];
      if (!allowed.includes(body.status)) {
        return NextResponse.json(
          { error: `Cannot transition from ${task.status} to ${body.status}` },
          { status: 400 }
        );
      }
      update.status = body.status;

      // Resume logic: reset failures, set next_run_at
      if (body.status === "active" && (task.status === "failed" || task.status === "paused")) {
        update.consecutive_failures = 0;
        update.error_message = null;
        update.next_run_at = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      }
    }

    // Title update
    if (body.title !== undefined) {
      update.title = body.title.slice(0, 60);
    }

    // Result update
    if (body.result !== undefined) {
      update.result = body.result;
    }

    // Recurring fields
    if (body.is_recurring !== undefined) {
      update.is_recurring = body.is_recurring;
    }
    if (body.frequency !== undefined) {
      update.frequency = body.frequency;
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ task });
    }

    update.updated_at = new Date().toISOString();

    const { data: updated, error } = await supabase()
      .from("instaclaw_tasks")
      .update(update)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: "Failed to update task" }, { status: 500 });
    }

    return NextResponse.json({ task: updated });
  } catch (err) {
    if (err instanceof Error && err.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to update task" }, { status: 500 });
  }
}

/** DELETE /api/tasks/[id] — Delete a task */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requireSession();
    const { id } = await params;

    const { error } = await supabase()
      .from("instaclaw_tasks")
      .delete()
      .eq("id", id)
      .eq("user_id", session.userId);

    if (error) {
      return NextResponse.json({ error: "Failed to delete task" }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    if (err instanceof Error && err.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to delete task" }, { status: 500 });
  }
}
