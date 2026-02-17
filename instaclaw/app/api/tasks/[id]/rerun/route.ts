import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { buildSystemPrompt, TASK_EXECUTION_SUFFIX } from "@/lib/system-prompt";
import { saveToLibrary } from "@/lib/library";
import { sanitizeAgentResult } from "@/lib/sanitize-result";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS = 4096;
const GATEWAY_TIMEOUT_MS = 120_000;

/**
 * POST /api/tasks/[id]/rerun
 * Re-executes a completed or failed task.
 * Proxies through the VM gateway when healthy for full tool access.
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
      { error: "Task execution is not configured on this environment." },
      { status: 500 }
    );
  }

  const { id } = await params;
  const supabase = getSupabase();

  // Get existing task + verify ownership
  const { data: task } = await supabase
    .from("instaclaw_tasks")
    .select("*")
    .eq("id", id)
    .eq("user_id", session.user.id)
    .single();

  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  // Reset task state
  const { data: updated, error: updateError } = await supabase
    .from("instaclaw_tasks")
    .update({
      status: "in_progress",
      title: "Processing...",
      result: null,
      error_message: null,
    })
    .eq("id", id)
    .select()
    .single();

  if (updateError) {
    return NextResponse.json({ error: "Failed to reset task" }, { status: 500 });
  }

  // Get VM with gateway details
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id, default_model, system_prompt, gateway_url, gateway_token, health_status")
    .eq("assigned_to", session.user.id)
    .single();

  if (!vm) {
    await supabase
      .from("instaclaw_tasks")
      .update({ status: "failed", error_message: "No agent configured." })
      .eq("id", id);
    return NextResponse.json(
      { error: "No agent configured yet." },
      { status: 422 }
    );
  }

  // Return immediately, execute in background
  const response = NextResponse.json({ task: updated });

  executeRerun(id, session.user.id, task.description, vm, apiKey).catch(
    (err) => {
      logger.error("Task rerun failed", {
        error: String(err),
        taskId: id,
        userId: session.user.id,
      });
    }
  );

  return response;
}

/* ─── Background re-execution ────────────────────────────── */

async function executeRerun(
  taskId: string,
  userId: string,
  description: string,
  vm: {
    id: string;
    default_model: string | null;
    system_prompt: string | null;
    gateway_url: string | null;
    gateway_token: string | null;
    health_status: string | null;
  },
  apiKey: string
) {
  const supabase = getSupabase();

  try {
    const { data: user } = await supabase
      .from("instaclaw_users")
      .select("name, gmail_profile_summary, gmail_insights")
      .eq("id", userId)
      .single();

    const systemPrompt =
      buildSystemPrompt(
        vm.system_prompt,
        user?.name,
        user?.gmail_profile_summary,
        user?.gmail_insights
      ) + TASK_EXECUTION_SUFFIX;

    const model = vm.default_model || "claude-haiku-4-5-20251001";
    const canUseGateway = !!(vm.gateway_url && vm.gateway_token && vm.health_status === "healthy");

    const requestBody = JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: "user", content: description }],
    });

    // ── Try gateway first, fall back to direct Anthropic ──────

    let upstreamRes: Response | null = null;

    if (canUseGateway) {
      try {
        const gatewayUrl = vm.gateway_url!.replace(/\/+$/, "");
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);

        upstreamRes = await fetch(`${gatewayUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": vm.gateway_token!,
            "anthropic-version": "2023-06-01",
          },
          body: requestBody,
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!upstreamRes.ok) {
          const errText = await upstreamRes.text();
          logger.warn("Gateway error in task rerun, falling back", {
            status: upstreamRes.status,
            error: errText.slice(0, 300),
            route: "tasks/rerun",
            taskId,
            userId,
          });
          upstreamRes = null;
        } else {
          logger.info("Task rerun proxied through gateway", {
            route: "tasks/rerun",
            vmId: vm.id,
            taskId,
          });
        }
      } catch (gwErr) {
        logger.warn("Gateway unreachable for task rerun, falling back", {
          error: String(gwErr),
          route: "tasks/rerun",
          taskId,
          userId,
        });
        upstreamRes = null;
      }
    }

    // Fallback: direct Anthropic
    if (!upstreamRes) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);

      upstreamRes = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: requestBody,
        signal: controller.signal,
      });

      clearTimeout(timeout);
    }

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      logger.error("API error in task rerun", {
        status: upstreamRes.status,
        error: errText.slice(0, 500),
        taskId,
        userId,
      });
      await supabase
        .from("instaclaw_tasks")
        .update({
          status: "failed",
          error_message: "Your agent encountered an error. Please try again.",
        })
        .eq("id", taskId);
      return;
    }

    const data = await upstreamRes.json();
    const rawResponse =
      data.content
        ?.filter((b: { type: string }) => b.type === "text")
        .map((b: { text: string }) => b.text)
        .join("") || "";

    if (!rawResponse) {
      await supabase
        .from("instaclaw_tasks")
        .update({
          status: "failed",
          error_message: "Agent returned an empty response.",
        })
        .eq("id", taskId);
      return;
    }

    const parsed = parseTaskResponse(rawResponse);
    parsed.result = sanitizeAgentResult(parsed.result);
    const now = new Date().toISOString();

    // Fetch current streak to increment
    const { data: current } = await supabase
      .from("instaclaw_tasks")
      .select("streak")
      .eq("id", taskId)
      .single();
    const newStreak = (current?.streak ?? 0) + 1;

    await supabase
      .from("instaclaw_tasks")
      .update({
        title: parsed.title,
        status: parsed.recurring ? "active" : "completed",
        is_recurring: parsed.recurring,
        frequency: parsed.frequency,
        result: parsed.result,
        tools_used: parsed.tools,
        error_message: null,
        last_run_at: now,
        streak: newStreak,
        ...(parsed.recurring && parsed.frequency
          ? { next_run_at: computeNextRun(parsed.frequency) }
          : {}),
      })
      .eq("id", taskId);

    // Auto-save to library (non-blocking)
    if (parsed.result) {
      await saveToLibrary(supabase, {
        userId,
        title: parsed.title,
        content: parsed.result,
        sourceTaskId: taskId,
        runNumber: newStreak,
      });
    }
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    try {
      await supabase
        .from("instaclaw_tasks")
        .update({
          status: "failed",
          error_message: isTimeout
            ? "Task timed out — your agent may still be processing."
            : String(err),
        })
        .eq("id", taskId);
    } catch {
      // Best-effort update
    }
  }
}

/* ─── Response Parser (same as create) ───────────────────── */

function parseTaskResponse(rawResponse: string) {
  const metaMatch = rawResponse.match(
    /---TASK_META---([\s\S]*?)---END_META---/
  );

  if (metaMatch) {
    const metaBlock = metaMatch[1];
    const title =
      metaBlock.match(/title:\s*(.+)/)?.[1]?.trim().slice(0, 60) ||
      "Task completed";
    const recurring =
      metaBlock.match(/recurring:\s*(true|false)/)?.[1] === "true";
    const frequency =
      metaBlock.match(/frequency:\s*(.+)/)?.[1]?.trim() || null;
    const tools =
      metaBlock
        .match(/tools:\s*(.+)/)?.[1]
        ?.split(",")
        .map((t) => t.trim())
        .filter(Boolean) || [];
    const result = rawResponse
      .replace(/---TASK_META---[\s\S]*?---END_META---/, "")
      .trim();

    return { title, recurring, frequency: recurring ? frequency : null, tools, result };
  }

  return {
    title: rawResponse.slice(0, 60).replace(/\s+\S*$/, "") || "Task completed",
    recurring: false,
    frequency: null,
    tools: [],
    result: rawResponse,
  };
}

/* ─── Next Run Calculator ────────────────────────────────── */

function computeNextRun(frequency: string): string {
  const now = new Date();
  const lower = frequency.toLowerCase();
  if (lower.includes("hour")) {
    now.setHours(now.getHours() + 1);
  } else if (lower.includes("daily") || lower === "day") {
    now.setDate(now.getDate() + 1);
  } else if (lower.includes("week")) {
    now.setDate(now.getDate() + 7);
  } else {
    now.setDate(now.getDate() + 1);
  }
  return now.toISOString();
}
