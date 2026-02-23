import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { buildSystemPrompt, TASK_EXECUTION_SUFFIX } from "@/lib/system-prompt";
import { saveToLibrary } from "@/lib/library";
import { sanitizeAgentResult } from "@/lib/sanitize-result";
import { isAnthropicModel } from "@/lib/models";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS = 4096;
const GATEWAY_TIMEOUT_MS = 120_000;

/**
 * POST /api/tasks/create
 *
 * Creates a task, returns it immediately, then executes it in the background.
 * When the VM gateway is healthy, tasks are proxied through it for full tool
 * access (Brave Search, browser, etc.) — same capabilities as Telegram.
 * Falls back to direct Anthropic API if the gateway is unreachable.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.error("ANTHROPIC_API_KEY not set", { route: "tasks/create" });
    return NextResponse.json(
      { error: "Task execution is not configured on this environment." },
      { status: 500 }
    );
  }

  let message: string;
  try {
    const body = await req.json();
    message = body.message;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!message || typeof message !== "string" || message.trim().length === 0) {
    return NextResponse.json({ error: "Message is required" }, { status: 400 });
  }
  message = message.trim();

  const supabase = getSupabase();

  // Check user has a VM — fetch gateway details too
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id, default_model, system_prompt, gateway_url, gateway_token, health_status, user_timezone")
    .eq("assigned_to", session.user.id)
    .single();

  if (!vm) {
    return NextResponse.json(
      { error: "No agent configured yet. Complete setup from your dashboard." },
      { status: 422 }
    );
  }

  // Create task immediately
  const { data: task, error: insertError } = await supabase
    .from("instaclaw_tasks")
    .insert({
      user_id: session.user.id,
      description: message,
      title: "Processing...",
      status: "in_progress",
    })
    .select()
    .single();

  if (insertError || !task) {
    logger.error("Failed to create task", {
      error: String(insertError),
      route: "tasks/create",
      userId: session.user.id,
    });
    return NextResponse.json({ error: "Failed to create task" }, { status: 500 });
  }

  // Return task immediately — execute in background
  const response = NextResponse.json({ task });

  // Fire-and-forget background execution
  executeTask(task.id, session.user.id, message, vm, apiKey).catch((err) => {
    logger.error("Background task execution failed", {
      error: String(err),
      taskId: task.id,
      route: "tasks/create",
      userId: session.user.id,
    });
  });

  return response;
}

/* ─── Background Task Execution ──────────────────────────── */

async function executeTask(
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
    user_timezone: string | null;
  },
  apiKey: string
) {
  const supabase = getSupabase();
  const vmTimezone = vm.user_timezone || "America/New_York";

  try {
    // Get user profile for personalization
    const { data: user } = await supabase
      .from("instaclaw_users")
      .select("name, gmail_profile_summary, gmail_insights")
      .eq("id", userId)
      .single();

    // Build system prompt with task execution suffix
    const systemPrompt =
      buildSystemPrompt(
        vm.system_prompt,
        user?.name,
        user?.gmail_profile_summary,
        user?.gmail_insights
      ) + TASK_EXECUTION_SUFFIX;

    const model = vm.default_model || "claude-haiku-4-5-20251001";
    const canUseGateway = !!(vm.gateway_url && vm.gateway_token && vm.health_status === "healthy");

    // ── Try gateway first, fall back to direct Anthropic ──────

    let upstreamRes: Response | null = null;
    let usedGateway = false;

    if (canUseGateway) {
      try {
        const gatewayUrl = vm.gateway_url!.replace(/\/+$/, "");
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);

        // Gateway uses OpenAI chat completions format (non-streaming for tasks)
        const gatewayBody = JSON.stringify({
          model,
          max_tokens: MAX_TOKENS,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: description },
          ],
          stream: false,
        });

        upstreamRes = await fetch(`${gatewayUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "authorization": `Bearer ${vm.gateway_token!}`,
          },
          body: gatewayBody,
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!upstreamRes.ok) {
          const errText = await upstreamRes.text();
          logger.warn("Gateway error in task execution, falling back to direct Anthropic", {
            status: upstreamRes.status,
            error: errText.slice(0, 300),
            route: "tasks/create",
            vmId: vm.id,
            taskId,
            userId,
          });
          upstreamRes = null;
        } else {
          usedGateway = true;
          logger.info("Task proxied through gateway", {
            route: "tasks/create",
            vmId: vm.id,
            taskId,
            userId,
          });
        }
      } catch (gwErr) {
        logger.warn("Gateway unreachable for task, falling back to direct Anthropic", {
          error: String(gwErr),
          route: "tasks/create",
          vmId: vm.id,
          gatewayUrl: vm.gateway_url,
          taskId,
          userId,
        });
        upstreamRes = null;
      }
    }

    // Fallback: direct Anthropic API (no tools)
    if (!upstreamRes) {
      // Non-Anthropic models can only run through the gateway
      if (!isAnthropicModel(model)) {
        logger.warn("Non-Anthropic model requires gateway for task", { model, taskId, userId });
        await supabase
          .from("instaclaw_tasks")
          .update({
            status: "failed",
            error_message: `${model} can only run when your agent is online (non-Anthropic models don't support direct API fallback). Check your dashboard for agent status, or switch to an Anthropic model for offline fallback.`,
          })
          .eq("id", taskId);
        return;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);

      upstreamRes = await fetch(ANTHROPIC_API_URL, {
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
          messages: [{ role: "user", content: description }],
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);
    }

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      logger.error("API error in task execution", {
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
    // OpenAI format: choices[0].message.content
    // Anthropic format: content[].text
    const rawResponse = usedGateway
      ? (data.choices?.[0]?.message?.content || "")
      : (data.content
          ?.filter((b: { type: string }) => b.type === "text")
          .map((b: { text: string }) => b.text)
          .join("") || "");

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

    // Parse structured response and sanitize
    const parsed = parseTaskResponse(rawResponse);
    parsed.result = sanitizeAgentResult(parsed.result);
    const now = new Date().toISOString();

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
        streak: 1,
        ...(parsed.recurring && parsed.frequency
          ? { next_run_at: computeNextRun(parsed.frequency) }
          : {}),
      })
      .eq("id", taskId);

    // Track usage for direct Anthropic fallback (gateway-proxied calls
    // are tracked by the proxy route — this covers the bypass path)
    if (!usedGateway) {
      supabase
        .rpc("instaclaw_increment_usage", {
          p_vm_id: vm.id,
          p_model: model,
          p_is_heartbeat: false,
          p_timezone: vmTimezone,
        })
        .then(({ error: incErr }) => {
          if (incErr) {
            logger.error("Failed to track usage for direct Anthropic task fallback", {
              error: String(incErr),
              route: "tasks/create",
              userId,
              vmId: vm.id,
            });
          }
        });
    }

    // Auto-save to library (non-blocking, failure won't affect task)
    if (parsed.result) {
      await saveToLibrary(supabase, {
        userId,
        title: parsed.title,
        content: parsed.result,
        sourceTaskId: taskId,
        runNumber: 1,
      });
    }
  } catch (err) {
    const isTimeout =
      err instanceof Error && err.name === "AbortError";
    const errorMessage = isTimeout
      ? "Task timed out — your agent may still be processing. Try again or check chat."
      : String(err);

    logger.error("Task execution error", {
      error: errorMessage,
      taskId,
      userId,
    });

    try {
      await supabase
        .from("instaclaw_tasks")
        .update({
          status: "failed",
          error_message: errorMessage,
        })
        .eq("id", taskId);
    } catch {
      // Best-effort update
    }
  }
}

/* ─── Response Parser ────────────────────────────────────── */

function parseTaskResponse(rawResponse: string): {
  title: string;
  recurring: boolean;
  frequency: string | null;
  tools: string[];
  result: string;
} {
  const metaMatch = rawResponse.match(
    /---TASK_META---([\s\S]*?)---END_META---/
  );

  if (metaMatch) {
    const metaBlock = metaMatch[1];
    const title =
      metaBlock
        .match(/title:\s*(.+)/)?.[1]
        ?.trim()
        .slice(0, 60) || "Task completed";
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

    return {
      title,
      recurring,
      frequency: recurring ? frequency : null,
      tools,
      result,
    };
  }

  // Fallback: agent didn't format correctly — don't lose the work
  return {
    title:
      rawResponse.slice(0, 60).replace(/\s+\S*$/, "") || "Task completed",
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
    // Default: daily
    now.setDate(now.getDate() + 1);
  }
  return now.toISOString();
}
