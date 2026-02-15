/**
 * GET /api/cron/recurring-tasks
 *
 * Vercel cron handler that executes ONE overdue recurring task per invocation.
 * Runs every 5 minutes. Processes the single most overdue task to stay well
 * within Vercel's 60s execution limit.
 *
 * Architecture:
 *   - Telegram bot runs on user's VM via OpenClaw long-polling
 *   - Bot token stored in instaclaw_vms (persisted during configure)
 *   - Chat ID discovered lazily via getUpdates on first delivery
 *   - Delivery failures never block task execution
 *
 * Processing lock:
 *   - processing_started_at is set immediately when a task is picked up
 *   - Stale locks (>5 min) are recovered automatically
 *   - Lock is always released in the finally block
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import {
  executeRecurringTask,
  handleRecurringTaskFailure,
  type TaskRecord,
  type UserRecord,
  type VmRecord,
} from "@/lib/recurring-executor";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const startTime = Date.now();

  // Authenticate cron request
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY not configured" },
      { status: 500 }
    );
  }

  console.log(
    JSON.stringify({
      event: "cron_recurring_tasks",
      action: "start",
      timestamp: new Date().toISOString(),
    })
  );

  const supabase = getSupabase();
  let pickedTaskId: string | null = null;

  try {
    // Find the single most overdue recurring task
    const { data: tasks, error: findError } = await supabase
      .from("instaclaw_tasks")
      .select("*")
      .eq("is_recurring", true)
      .eq("status", "active")
      .lte("next_run_at", new Date().toISOString())
      .lt("consecutive_failures", 5)
      .or(
        `processing_started_at.is.null,processing_started_at.lt.${new Date(Date.now() - 5 * 60 * 1000).toISOString()}`
      )
      .order("next_run_at", { ascending: true })
      .limit(1);

    if (findError || !tasks || tasks.length === 0) {
      console.log(
        JSON.stringify({
          event: "cron_recurring_tasks",
          action: "no_overdue_tasks",
          timestamp: new Date().toISOString(),
        })
      );
      return NextResponse.json({
        processed: 0,
        message: "No overdue tasks",
      });
    }

    const task = tasks[0] as TaskRecord;
    pickedTaskId = task.id;

    console.log(
      JSON.stringify({
        event: "cron_recurring_tasks",
        action: "processing_task",
        taskId: task.id,
        userId: task.user_id,
        title: task.title,
        frequency: task.frequency,
        overdueBy: `${Math.round((Date.now() - new Date(task.next_run_at!).getTime()) / 60000)} minutes`,
      })
    );

    // Set processing lock immediately
    await supabase
      .from("instaclaw_tasks")
      .update({ processing_started_at: new Date().toISOString() })
      .eq("id", task.id);

    // Load user profile
    const { data: user } = await supabase
      .from("instaclaw_users")
      .select("id, name, gmail_profile_summary, gmail_insights")
      .eq("id", task.user_id)
      .single();

    if (!user) {
      throw new Error(`User ${task.user_id} not found`);
    }

    // Load VM data
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select(
        "id, default_model, system_prompt, telegram_bot_token, telegram_chat_id"
      )
      .eq("assigned_to", task.user_id)
      .single();

    if (!vm) {
      throw new Error(`No VM found for user ${task.user_id}`);
    }

    // Execute the task (55s timeout to leave 5s buffer)
    const result = await executeRecurringTask(
      supabase,
      task,
      user as UserRecord,
      vm as VmRecord,
      apiKey,
      55_000
    );

    const duration = Date.now() - startTime;

    console.log(
      JSON.stringify({
        event: "cron_recurring_tasks",
        action: "task_complete",
        taskId: task.id,
        status: "succeeded",
        executionTimeMs: duration,
        newStreak: result.newStreak,
        nextRunAt: result.nextRunAt,
        telegramDelivered: result.deliveryStatus === "delivered",
      })
    );

    return NextResponse.json({
      processed: 1,
      taskId: task.id,
      status: "succeeded",
      executionTimeMs: duration,
      nextRunAt: result.nextRunAt,
    });
  } catch (err) {
    const duration = Date.now() - startTime;
    const errorMessage =
      err instanceof Error ? err.message : String(err);

    console.error(
      JSON.stringify({
        event: "cron_recurring_tasks",
        action: "task_failed",
        taskId: pickedTaskId,
        error: errorMessage.slice(0, 500),
        executionTimeMs: duration,
      })
    );

    // Handle failure: update consecutive_failures, schedule retry
    if (pickedTaskId) {
      try {
        const { data: failedTask } = await supabase
          .from("instaclaw_tasks")
          .select("*")
          .eq("id", pickedTaskId)
          .single();

        const { data: failedVm } = await supabase
          .from("instaclaw_vms")
          .select(
            "id, default_model, system_prompt, telegram_bot_token, telegram_chat_id"
          )
          .eq("assigned_to", failedTask?.user_id)
          .single();

        if (failedTask) {
          await handleRecurringTaskFailure(
            supabase,
            failedTask as TaskRecord,
            (failedVm || {}) as VmRecord,
            errorMessage
          );
        }
      } catch {
        // Best-effort failure handling
      }
    }

    return NextResponse.json({
      processed: 1,
      taskId: pickedTaskId,
      status: "failed",
      executionTimeMs: duration,
      error: errorMessage.slice(0, 200),
    });
  } finally {
    // ALWAYS release the processing lock, even on unexpected errors
    if (pickedTaskId) {
      try {
        await supabase
          .from("instaclaw_tasks")
          .update({ processing_started_at: null })
          .eq("id", pickedTaskId);
      } catch {
        // Last resort — stale lock recovery will handle this after 5 min
      }
    }
  }
}
