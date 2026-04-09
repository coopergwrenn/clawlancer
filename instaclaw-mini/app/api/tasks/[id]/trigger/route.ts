import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getAgentStatus, supabase } from "@/lib/supabase";

export const maxDuration = 120;

const TASK_SUFFIX = `

TASK EXECUTION MODE:
After completing the task, append this metadata block at the END of your response:

---TASK_META---
title: [A concise title for this task, max 60 characters]
recurring: [true/false - is this something that should repeat on a schedule?]
frequency: [If recurring: daily/weekly/hourly. If not recurring: none]
tools: [Comma-separated list of tools you used, e.g.: web_search, code_execution, email]
---END_META---

Put your full task result BEFORE the TASK_META block.`;

/**
 * POST /api/tasks/[id]/trigger — Manually trigger a recurring task.
 * Re-executes via the gateway, same as initial creation.
 */
export async function POST(
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

    if (!task.is_recurring || !["active", "failed"].includes(task.status)) {
      return NextResponse.json({ error: "Only active/failed recurring tasks can be triggered" }, { status: 400 });
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

    // Mark as processing
    await supabase()
      .from("instaclaw_tasks")
      .update({
        processing_started_at: new Date().toISOString(),
        consecutive_failures: 0,
      })
      .eq("id", id);

    // Execute via gateway — retry once if agent is busy (processing a heartbeat)
    try {
      let gatewayRes: Response | null = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        gatewayRes = await fetch(`${vmData.gateway_url}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${vmData.gateway_token}`,
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            messages: [{ role: "user", content: task.description + TASK_SUFFIX }],
          }),
        });

        if (gatewayRes.status === 400 && attempt < 3) {
          const peek = await gatewayRes.clone().text().catch(() => "");
          if (peek.includes("busy")) {
            // Exponential backoff: 5s, 10s, 15s — covers 20s+ response times
            await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
            continue;
          }
        }
        break;
      }

      if (!gatewayRes!.ok) {
        await supabase()
          .from("instaclaw_tasks")
          .update({ status: "failed", error_message: `Agent is busy (${gatewayRes!.status}). Tap Re-run to try again.`, processing_started_at: null })
          .eq("id", id);
        return NextResponse.json({ error: "Gateway error" }, { status: 502 });
      }

      const data = await gatewayRes!.json();
      const result = data.choices?.[0]?.message?.content || "";
      const cleanResult = result.replace(/---TASK_META---[\s\S]*?---END_META---/, "").trim();

      // Calculate next run
      let nextRunAt: string | null = null;
      if (task.frequency) {
        const now = Date.now();
        if (task.frequency.includes("hour")) nextRunAt = new Date(now + 3600000).toISOString();
        else if (task.frequency.includes("week")) nextRunAt = new Date(now + 7 * 86400000).toISOString();
        else nextRunAt = new Date(now + 86400000).toISOString(); // default: daily
      }

      await supabase()
        .from("instaclaw_tasks")
        .update({
          result: cleanResult || task.result,
          status: "active",
          processing_started_at: null,
          last_run_at: new Date().toISOString(),
          next_run_at: nextRunAt,
          streak: (task.streak || 0) + 1,
        })
        .eq("id", id);

    } catch (err) {
      await supabase()
        .from("instaclaw_tasks")
        .update({
          status: "failed",
          error_message: err instanceof Error ? err.message : "Execution failed",
          processing_started_at: null,
        })
        .eq("id", id);
    }

    // Return updated task
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
    return NextResponse.json({ error: "Failed to trigger task" }, { status: 500 });
  }
}
