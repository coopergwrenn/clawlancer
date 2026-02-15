import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { buildSystemPrompt } from "@/lib/system-prompt";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS = 4096;

/**
 * POST /api/tasks/[id]/refine
 *
 * Refines an existing task result using natural language instructions.
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

  // Get VM + user profile for system prompt
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id, default_model, system_prompt")
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

  const userMessage = `Original task: ${task.description}

Previous result:
${task.result}

The user wants you to modify the result with this instruction:
${instruction}

Please produce an updated version of the result that incorporates the user's requested changes. Keep everything that was good about the original, and modify only what the user asked for.

Return ONLY the updated result content. Do NOT include any TASK_META block — just the refined content.`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

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
        messages: [{ role: "user", content: userMessage }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      logger.error("Anthropic API error in task refinement", {
        status: anthropicRes.status,
        error: errText.slice(0, 500),
        taskId: id,
        userId: session.user.id,
      });
      return NextResponse.json(
        { error: "Your agent encountered an error. Please try again." },
        { status: 502 }
      );
    }

    const data = await anthropicRes.json();
    const newResult =
      data.content
        ?.filter((b: { type: string }) => b.type === "text")
        .map((b: { text: string }) => b.text)
        .join("") || "";

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
