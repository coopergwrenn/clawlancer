import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getAgentStatus, supabase } from "@/lib/supabase";

export const maxDuration = 120;

/**
 * POST /api/tasks/[id]/refine — Refine a task result with additional instruction.
 * Body: { instruction: string }
 * Sends: original task + previous result + instruction to gateway.
 * Updates only the result field (preserves title, status, recurring flag).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await requireSession();
    const { id } = await params;
    const { instruction } = await req.json();

    if (!instruction || typeof instruction !== "string") {
      return NextResponse.json({ error: "Instruction required" }, { status: 400 });
    }

    const { data: task } = await supabase()
      .from("instaclaw_tasks")
      .select("*")
      .eq("id", id)
      .eq("user_id", session.userId)
      .single();

    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    if (!task.result) {
      return NextResponse.json({ error: "No result to refine" }, { status: 400 });
    }

    const agent = await getAgentStatus(session.userId);
    if (!agent) {
      return NextResponse.json({ error: "No agent assigned" }, { status: 404 });
    }

    const { data: vmData } = await supabase()
      .from("instaclaw_vms")
      .select("gateway_url, gateway_token")
      .eq("id", agent.id)
      .single();

    if (!vmData?.gateway_url || !vmData?.gateway_token) {
      return NextResponse.json({ error: "Agent not configured" }, { status: 503 });
    }

    // Build refinement prompt: original task + previous result + instruction
    const refinementPrompt = [
      `Original task: ${task.description}`,
      "",
      `Previous result:`,
      task.result,
      "",
      `Refinement instruction: ${instruction}`,
      "",
      "Please provide an updated result incorporating the refinement instruction. Do not include any TASK_META blocks.",
    ].join("\n");

    const gatewayRes = await fetch(`${vmData.gateway_url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${vmData.gateway_token}`,
      },
      body: JSON.stringify({
        model: "openclaw",
        messages: [{ role: "user", content: refinementPrompt }],
      }),
    });

    if (!gatewayRes.ok) {
      return NextResponse.json({ error: "Gateway error" }, { status: 502 });
    }

    const data = await gatewayRes.json();
    const refinedResult = data.choices?.[0]?.message?.content || "";

    if (refinedResult) {
      await supabase()
        .from("instaclaw_tasks")
        .update({
          result: refinedResult,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
    }

    const { data: updated } = await supabase()
      .from("instaclaw_tasks")
      .select("*")
      .eq("id", id)
      .single();

    return NextResponse.json({ task: updated });
  } catch (err) {
    if (err instanceof Error && err.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to refine task" }, { status: 500 });
  }
}
