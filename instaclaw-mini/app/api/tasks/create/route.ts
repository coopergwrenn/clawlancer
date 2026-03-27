import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getAgentStatus, supabase } from "@/lib/supabase";

export const maxDuration = 120;

/**
 * POST /api/tasks/create — Create a task and execute it via the gateway directly.
 * Body: { message: string }
 *
 * Unlike proxying through instaclaw.io (which times out on serverless),
 * this calls the gateway directly — same pattern as /api/chat/send.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    const { message } = await req.json();

    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "Message required" }, { status: 400 });
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

    // 1. Create the task in Supabase immediately
    const { data: task, error: insertErr } = await supabase()
      .from("instaclaw_tasks")
      .insert({
        user_id: session.userId,
        title: "Processing...",
        description: message.slice(0, 500),
        status: "in_progress",
        processing_started_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (insertErr || !task) {
      console.error("[Tasks/Create] Insert failed:", insertErr);
      return NextResponse.json({ error: "Failed to create task" }, { status: 500 });
    }

    // 2. Return the task immediately so the UI can show it
    // Then execute in the background via gateway
    const taskId = task.id;

    // Use a promise that resolves after gateway call to keep the function alive
    const executePromise = (async () => {
      try {
        const gatewayRes = await fetch(`${vmData.gateway_url}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${vmData.gateway_token}`,
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            messages: [{ role: "user", content: message }],
          }),
        });

        if (!gatewayRes.ok) {
          const errText = await gatewayRes.text().catch(() => "");
          console.error("[Tasks/Create] Gateway error:", gatewayRes.status, errText);
          await supabase()
            .from("instaclaw_tasks")
            .update({
              status: "failed",
              error_message: `Gateway error: ${gatewayRes.status}`,
              processing_started_at: null,
            })
            .eq("id", taskId);
          return;
        }

        const data = await gatewayRes.json();
        const result = data.choices?.[0]?.message?.content || "";

        if (!result) {
          await supabase()
            .from("instaclaw_tasks")
            .update({
              status: "failed",
              error_message: "No response from agent",
              processing_started_at: null,
            })
            .eq("id", taskId);
          return;
        }

        // Parse TASK_META if present
        let title = message.slice(0, 60);
        let isRecurring = false;
        let frequency: string | null = null;
        const toolsUsed: string[] = [];

        const metaMatch = result.match(/---TASK_META---([\s\S]*?)---END_META---/);
        if (metaMatch) {
          const meta = metaMatch[1];
          const titleMatch = meta.match(/title:\s*(.+)/i);
          const recurringMatch = meta.match(/recurring:\s*(true|false)/i);
          const frequencyMatch = meta.match(/frequency:\s*(.+)/i);
          const toolsMatch = meta.match(/tools:\s*(.+)/i);

          if (titleMatch) title = titleMatch[1].trim().slice(0, 60);
          if (recurringMatch) isRecurring = recurringMatch[1].toLowerCase() === "true";
          if (frequencyMatch) frequency = frequencyMatch[1].trim();
          if (toolsMatch) {
            toolsUsed.push(...toolsMatch[1].split(",").map((t: string) => t.trim()).filter(Boolean));
          }
        }

        // Clean result (remove TASK_META block from displayed result)
        const cleanResult = result.replace(/---TASK_META---[\s\S]*?---END_META---/, "").trim();

        await supabase()
          .from("instaclaw_tasks")
          .update({
            title,
            status: isRecurring ? "active" : "completed",
            result: cleanResult,
            is_recurring: isRecurring,
            frequency,
            tools_used: toolsUsed,
            processing_started_at: null,
            last_run_at: new Date().toISOString(),
          })
          .eq("id", taskId);

      } catch (err) {
        console.error("[Tasks/Create] Execution error:", err);
        await supabase()
          .from("instaclaw_tasks")
          .update({
            status: "failed",
            error_message: err instanceof Error ? err.message : "Execution failed",
            processing_started_at: null,
          })
          .eq("id", taskId);
      }
    })();

    // Wait for execution to complete before returning
    // (Vercel Edge/Node functions stay alive for the full maxDuration)
    await executePromise;

    // Fetch the final task state
    const { data: finalTask } = await supabase()
      .from("instaclaw_tasks")
      .select("*")
      .eq("id", taskId)
      .single();

    return NextResponse.json({ task: finalTask || task });
  } catch (err) {
    console.error("[Tasks/Create] Error:", err);
    if (err instanceof Error && err.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to create task" }, { status: 500 });
  }
}
