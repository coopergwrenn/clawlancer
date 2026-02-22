import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import {
  executeRecurringTask,
  handleRecurringTaskFailure,
  type TaskRecord,
  type UserRecord,
  type VmRecord,
} from "@/lib/recurring-executor";

/**
 * POST /api/tasks/[id]/trigger
 *
 * Manually trigger the next scheduled execution of a recurring task.
 * Unlike "rerun", this updates next_run_at, streak, and delivers to Telegram —
 * exactly as if the cron ran it.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Task execution is not configured." },
      { status: 500 }
    );
  }

  const { id } = await params;
  const supabase = getSupabase();

  // Verify ownership + recurring + active
  const { data: task } = await supabase
    .from("instaclaw_tasks")
    .select("*")
    .eq("id", id)
    .eq("user_id", session.user.id)
    .single();

  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  if (!task.is_recurring) {
    return NextResponse.json(
      { error: "Task is not recurring. Use rerun instead." },
      { status: 400 }
    );
  }

  if (task.status !== "active" && task.status !== "failed") {
    return NextResponse.json(
      { error: `Cannot trigger task with status '${task.status}'` },
      { status: 400 }
    );
  }

  // Load user
  const { data: user } = await supabase
    .from("instaclaw_users")
    .select("id, name, gmail_profile_summary, gmail_insights")
    .eq("id", session.user.id)
    .single();

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Load VM
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select(
      "id, default_model, system_prompt, telegram_bot_token, telegram_chat_id, gateway_url, gateway_token, health_status"
    )
    .eq("assigned_to", session.user.id)
    .single();

  if (!vm) {
    return NextResponse.json(
      { error: "No agent configured." },
      { status: 422 }
    );
  }

  // Set processing lock + reset to in_progress
  await supabase
    .from("instaclaw_tasks")
    .update({
      status: "active",
      processing_started_at: new Date().toISOString(),
      result: null,
      error_message: null,
    })
    .eq("id", id);

  // Return immediately, execute in background
  const response = NextResponse.json({
    task: { ...task, status: "active", result: null, error_message: null },
  });

  // Fire-and-forget
  (async () => {
    try {
      await executeRecurringTask(
        supabase,
        task as TaskRecord,
        user as UserRecord,
        vm as VmRecord,
        apiKey,
        120_000 // longer timeout for manual trigger
      );

      // Fetch final state and reset consecutive_failures on manual trigger
      await supabase
        .from("instaclaw_tasks")
        .update({ consecutive_failures: 0 })
        .eq("id", id);
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : String(err);
      logger.error("Manual trigger execution failed", {
        error: errorMessage,
        taskId: id,
        userId: session.user.id,
      });

      try {
        await handleRecurringTaskFailure(
          supabase,
          task as TaskRecord,
          vm as VmRecord,
          errorMessage
        );
      } catch {
        // Best-effort
      }
    } finally {
      // Release lock
      try {
        await supabase
          .from("instaclaw_tasks")
          .update({ processing_started_at: null })
          .eq("id", id);
      } catch {
        // Stale lock recovery will handle
      }
    }
  })().catch((err) => {
    logger.error("Trigger background task uncaught", {
      error: String(err),
      taskId: id,
    });
  });

  return response;
}
