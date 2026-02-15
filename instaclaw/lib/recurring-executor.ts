/**
 * Shared recurring task executor.
 * Used by BOTH the cron handler (/api/cron/recurring-tasks)
 * and the manual trigger (/api/tasks/[id]/trigger).
 */
import { SupabaseClient } from "@supabase/supabase-js";
import { buildSystemPrompt } from "@/lib/system-prompt";
import { saveToLibrary } from "@/lib/library";
import {
  sendTelegramTaskResult,
  sendTelegramNotification,
  discoverTelegramChatId,
} from "@/lib/telegram";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS = 4096;

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface TaskRecord {
  id: string;
  user_id: string;
  title: string;
  description: string;
  status: string;
  is_recurring: boolean;
  frequency: string | null;
  streak: number;
  last_run_at: string | null;
  next_run_at: string | null;
  consecutive_failures: number;
  preferred_run_hour: number | null;
  preferred_run_minute: number | null;
  user_timezone: string;
  [key: string]: any;
}

export interface UserRecord {
  id: string;
  name: string | null;
  gmail_profile_summary: string | null;
  gmail_insights: string[] | null;
  [key: string]: any;
}

export interface VmRecord {
  id: string;
  default_model: string | null;
  system_prompt: string | null;
  telegram_bot_token: string | null;
  telegram_chat_id: string | null;
  [key: string]: any;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface ExecutionResult {
  success: boolean;
  result?: string;
  error?: string;
  newStreak: number;
  nextRunAt: string;
  deliveryStatus: "delivered" | "delivery_failed" | "no_channel";
}

/**
 * Execute a recurring task: call Anthropic, update DB, save to Library, deliver to Telegram.
 * This function handles the ENTIRE lifecycle of a single recurring task execution.
 *
 * @param timeoutMs - Execution timeout for Anthropic call (default 55s for cron, 120s for manual)
 */
export async function executeRecurringTask(
  supabase: SupabaseClient,
  task: TaskRecord,
  user: UserRecord,
  vm: VmRecord,
  apiKey: string,
  timeoutMs = 55_000
): Promise<ExecutionResult> {
  const newStreak = task.streak + 1;

  // Build system prompt WITHOUT TASK_EXECUTION_SUFFIX (recurring tasks don't need meta parsing)
  const systemPrompt =
    buildSystemPrompt(
      vm.system_prompt,
      user.name,
      user.gmail_profile_summary,
      user.gmail_insights
    ) +
    `\n\nRECURRING TASK EXECUTION:
This is an automated recurring execution (run #${newStreak}) of a task the user previously configured.
Frequency: ${task.frequency || "daily"}. Last run: ${task.last_run_at || "first automated run"}.
Execute the task with the LATEST available information.
Be thorough and provide current, actionable content.
Return ONLY the result content — do NOT include any TASK_META block.`;

  const model = vm.default_model || "claude-haiku-4-5-20251001";

  // Call Anthropic
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let resultContent: string;

  try {
    const anthropicRes = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: "user", content: task.description }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      throw new Error(
        `Anthropic API error ${anthropicRes.status}: ${errText.slice(0, 300)}`
      );
    }

    const data = await anthropicRes.json();
    resultContent =
      data.content
        ?.filter((b: { type: string }) => b.type === "text")
        .map((b: { text: string }) => b.text)
        .join("") || "";

    if (!resultContent) {
      throw new Error("Agent returned an empty response.");
    }
  } catch (err) {
    clearTimeout(timeout);
    const isTimeout = err instanceof Error && err.name === "AbortError";
    throw new Error(
      isTimeout
        ? "Task timed out during execution."
        : err instanceof Error
          ? err.message
          : String(err)
    );
  }

  // Calculate next_run_at with drift prevention
  const nextRunAt = computeNextRunWithDriftPrevention(task);

  // If preferred_run_hour wasn't set, save it from the task's created_at
  const preferredUpdates: Record<string, unknown> = {};
  if (
    task.preferred_run_hour === null &&
    task.frequency &&
    !task.frequency.toLowerCase().includes("hour")
  ) {
    const createdAt = new Date(task.created_at || Date.now());
    preferredUpdates.preferred_run_hour = createdAt.getUTCHours();
    preferredUpdates.preferred_run_minute = createdAt.getUTCMinutes();
  }

  // Update task record
  const now = new Date().toISOString();
  await supabase
    .from("instaclaw_tasks")
    .update({
      result: resultContent,
      last_run_at: now,
      next_run_at: nextRunAt,
      streak: newStreak,
      consecutive_failures: 0,
      error_message: null,
      processing_started_at: null, // release lock
      updated_at: now,
      ...preferredUpdates,
    })
    .eq("id", task.id);

  // Save to Library (non-blocking, never throws)
  try {
    await saveToLibrary(supabase, {
      userId: task.user_id,
      title: task.title,
      content: resultContent,
      sourceTaskId: task.id,
      runNumber: newStreak,
    });
  } catch {
    // Library save failure is non-fatal
  }

  // Deliver to Telegram
  let deliveryStatus: "delivered" | "delivery_failed" | "no_channel" =
    "no_channel";
  try {
    deliveryStatus = await deliverToTelegram(
      supabase,
      vm,
      task,
      resultContent,
      newStreak
    );
  } catch {
    deliveryStatus = "delivery_failed";
  }

  // Update delivery status
  await supabase
    .from("instaclaw_tasks")
    .update({ last_delivery_status: deliveryStatus })
    .eq("id", task.id);

  return {
    success: true,
    result: resultContent,
    newStreak,
    nextRunAt,
    deliveryStatus,
  };
}

/**
 * Handle a failed recurring task execution.
 * Updates consecutive_failures, sets retry time, sends notifications.
 */
export async function handleRecurringTaskFailure(
  supabase: SupabaseClient,
  task: TaskRecord,
  vm: VmRecord,
  errorMessage: string
): Promise<void> {
  const newFailureCount = task.consecutive_failures + 1;
  const now = new Date().toISOString();
  const retryAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 min

  if (newFailureCount >= 5) {
    // Auto-pause after 5 consecutive failures
    await supabase
      .from("instaclaw_tasks")
      .update({
        status: "failed",
        error_message:
          "Paused after 5 consecutive failures. Click Re-run to restart.",
        consecutive_failures: newFailureCount,
        last_run_at: now,
        processing_started_at: null,
        updated_at: now,
      })
      .eq("id", task.id);

    // Notify via Telegram
    await tryTelegramNotification(
      supabase,
      vm,
      `⚠️ Your recurring task "${task.title}" has been paused after 5 consecutive failures. Open Command Center to resume it.`
    );
  } else {
    // Keep active, schedule retry
    await supabase
      .from("instaclaw_tasks")
      .update({
        error_message: errorMessage.slice(0, 500),
        consecutive_failures: newFailureCount,
        last_run_at: now,
        next_run_at: retryAt,
        processing_started_at: null,
        updated_at: now,
      })
      .eq("id", task.id);

    // Notify on failure #1 and #3
    if (newFailureCount === 1 || newFailureCount === 3) {
      await tryTelegramNotification(
        supabase,
        vm,
        `⚠️ Your task "${task.title}" failed to run (attempt ${newFailureCount}/5). I'll retry in 15 minutes.`
      );
    }
  }
}

/* ─── Internal helpers ─────────────────────────────────────── */

async function deliverToTelegram(
  supabase: SupabaseClient,
  vm: VmRecord,
  task: TaskRecord,
  result: string,
  streak: number
): Promise<"delivered" | "delivery_failed" | "no_channel"> {
  if (!vm.telegram_bot_token) return "no_channel";

  let chatId = vm.telegram_chat_id;

  // Lazy chat_id discovery
  if (!chatId) {
    chatId = await discoverTelegramChatId(vm.telegram_bot_token);
    if (chatId) {
      // Cache it for future deliveries
      await supabase
        .from("instaclaw_vms")
        .update({ telegram_chat_id: chatId })
        .eq("id", vm.id);
    } else {
      return "no_channel";
    }
  }

  const { success } = await sendTelegramTaskResult(
    vm.telegram_bot_token,
    chatId,
    {
      title: task.title,
      frequency: task.frequency || "recurring",
      streak,
      result,
    }
  );

  return success ? "delivered" : "delivery_failed";
}

async function tryTelegramNotification(
  supabase: SupabaseClient,
  vm: VmRecord,
  message: string
): Promise<void> {
  if (!vm.telegram_bot_token) return;

  let chatId = vm.telegram_chat_id;
  if (!chatId) {
    chatId = await discoverTelegramChatId(vm.telegram_bot_token);
    if (chatId) {
      await supabase
        .from("instaclaw_vms")
        .update({ telegram_chat_id: chatId })
        .eq("id", vm.id);
    }
  }
  if (!chatId) return;

  await sendTelegramNotification(vm.telegram_bot_token, chatId, message);
}

/**
 * Compute next_run_at with drift prevention for daily/weekly tasks.
 * Hourly tasks just add 1 hour from now.
 * Daily/weekly tasks anchor to the preferred run time.
 */
function computeNextRunWithDriftPrevention(task: TaskRecord): string {
  const now = new Date();
  const freq = (task.frequency || "daily").toLowerCase();

  if (freq.includes("hour") || freq === "always_on") {
    // Hourly or always-on: just add 1 hour
    return new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  }

  // Daily or weekly: anchor to preferred time
  const hour = task.preferred_run_hour ?? now.getUTCHours();
  const minute = task.preferred_run_minute ?? now.getUTCMinutes();

  // Start from today at the preferred time
  const next = new Date(now);
  next.setUTCHours(hour, minute, 0, 0);

  if (freq.includes("week")) {
    // Add 7 days from now, anchored to preferred time
    next.setUTCDate(next.getUTCDate() + 7);
    // If that's somehow in the past (shouldn't happen), add another week
    while (next.getTime() <= now.getTime()) {
      next.setUTCDate(next.getUTCDate() + 7);
    }
  } else {
    // Daily: next occurrence of preferred time
    if (next.getTime() <= now.getTime()) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
  }

  return next.toISOString();
}
