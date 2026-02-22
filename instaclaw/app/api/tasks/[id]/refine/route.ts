import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { buildSystemPrompt } from "@/lib/system-prompt";
import { isAnthropicModel } from "@/lib/models";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS = 4096;
const GATEWAY_TIMEOUT_MS = 120_000;

/**
 * POST /api/tasks/[id]/refine
 *
 * Refines an existing task result using natural language instructions.
 * Proxies through the VM gateway when healthy for full tool access.
 * Does NOT re-parse TASK_META — title, recurring status, etc. stay the same.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "AI refinement is not configured on this environment." },
      { status: 500 }
    );
  }

  let instruction: string;
  try {
    const body = await req.json();
    instruction = body.instruction;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!instruction || typeof instruction !== "string" || instruction.trim().length === 0) {
    return NextResponse.json({ error: "Instruction is required" }, { status: 400 });
  }
  instruction = instruction.trim();

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

  if (!task.result) {
    return NextResponse.json(
      { error: "No result to refine — task has not completed yet." },
      { status: 400 }
    );
  }

  // Get VM with gateway details + user profile
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id, default_model, system_prompt, gateway_url, gateway_token, health_status")
    .eq("assigned_to", session.user.id)
    .single();

  if (!vm) {
    return NextResponse.json(
      { error: "No agent configured yet." },
      { status: 422 }
    );
  }

  const { data: user } = await supabase
    .from("instaclaw_users")
    .select("name, gmail_profile_summary, gmail_insights")
    .eq("id", session.user.id)
    .single();

  const systemPrompt = buildSystemPrompt(
    vm.system_prompt,
    user?.name,
    user?.gmail_profile_summary,
    user?.gmail_insights
  );

  const model = vm.default_model || "claude-haiku-4-5-20251001";
  const canUseGateway = !!(vm.gateway_url && vm.gateway_token && vm.health_status === "healthy");

  const userMessage = `Original task: ${task.description}

Previous result:
${task.result}

The user wants you to modify the result with this instruction:
${instruction}

Please produce an updated version of the result that incorporates the user's requested changes. Keep everything that was good about the original, and modify only what the user asked for.

Return ONLY the updated result content. Do NOT include any TASK_META block — just the refined content.`;

  try {
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
            { role: "user", content: userMessage },
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
          logger.warn("Gateway error in task refine, falling back", {
            status: upstreamRes.status,
            error: errText.slice(0, 300),
            route: "tasks/refine",
            taskId: id,
            userId: session.user.id,
          });
          upstreamRes = null;
        } else {
          usedGateway = true;
          logger.info("Task refine proxied through gateway", {
            route: "tasks/refine",
            vmId: vm.id,
            taskId: id,
          });
        }
      } catch (gwErr) {
        logger.warn("Gateway unreachable for task refine, falling back", {
          error: String(gwErr),
          route: "tasks/refine",
          taskId: id,
          userId: session.user.id,
        });
        upstreamRes = null;
      }
    }

    // Fallback: direct Anthropic
    if (!upstreamRes) {
      if (!isAnthropicModel(model)) {
        logger.warn("Non-Anthropic model requires gateway for refine", {
          model,
          taskId: id,
          userId: session.user.id,
        });
        return NextResponse.json(
          { error: `${model} requires your agent to be online. Check your dashboard for status.` },
          { status: 502 }
        );
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
          messages: [{ role: "user", content: userMessage }],
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);
    }

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      logger.error("API error in task refinement", {
        status: upstreamRes.status,
        error: errText.slice(0, 500),
        taskId: id,
        userId: session.user.id,
      });
      return NextResponse.json(
        { error: "Your agent encountered an error. Please try again." },
        { status: 502 }
      );
    }

    const data = await upstreamRes.json();
    // OpenAI format: choices[0].message.content
    // Anthropic format: content[].text
    const newResult = usedGateway
      ? (data.choices?.[0]?.message?.content || "")
      : (data.content
          ?.filter((b: { type: string }) => b.type === "text")
          .map((b: { text: string }) => b.text)
          .join("") || "");

    if (!newResult) {
      return NextResponse.json(
        { error: "Agent returned an empty response." },
        { status: 502 }
      );
    }

    // Update the task result — do NOT overwrite title, status, recurring, etc.
    const { data: updated, error: updateError } = await supabase
      .from("instaclaw_tasks")
      .update({ result: newResult })
      .eq("id", id)
      .select()
      .single();

    if (updateError) {
      return NextResponse.json(
        { error: "Failed to save refined result." },
        { status: 500 }
      );
    }

    return NextResponse.json({ task: updated });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    logger.error("Task refinement error", {
      error: String(err),
      taskId: id,
      userId: session.user.id,
    });
    return NextResponse.json(
      {
        error: isTimeout
          ? "Refinement timed out. Please try again."
          : "Failed to refine task result.",
      },
      { status: 502 }
    );
  }
}
