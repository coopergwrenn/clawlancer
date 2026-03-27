import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getAgentStatus } from "@/lib/supabase";

/**
 * POST /api/chat/send — Send a message to the user's agent via the OpenClaw gateway.
 * Body: { message: string, stream?: boolean, toggles?: { webSearch, deepResearch } }
 * Returns: SSE stream if stream=true, otherwise { response: string }
 */
export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    const body = await req.json();
    const { message, stream: wantStream, toggles } = body;

    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "Message required" }, { status: 400 });
    }

    const agent = await getAgentStatus(session.userId);
    if (!agent) {
      return NextResponse.json({ error: "No agent assigned" }, { status: 404 });
    }

    const { supabase } = await import("@/lib/supabase");
    const { data: vmData } = await supabase()
      .from("instaclaw_vms")
      .select("gateway_url, gateway_token")
      .eq("id", agent.id)
      .single();

    if (!vmData?.gateway_url || !vmData?.gateway_token) {
      return NextResponse.json({ error: "Agent not configured" }, { status: 503 });
    }

    // Build the gateway request
    const gatewayBody: Record<string, unknown> = {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: message }],
      stream: !!wantStream,
    };

    // Pass toggles if provided
    if (toggles?.webSearch) gatewayBody.web_search = true;
    if (toggles?.deepResearch) gatewayBody.deep_research = true;

    const gatewayRes = await fetch(`${vmData.gateway_url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${vmData.gateway_token}`,
      },
      body: JSON.stringify(gatewayBody),
    });

    if (!gatewayRes.ok) {
      const errText = await gatewayRes.text().catch(() => "");
      console.error("[Chat/Send] Gateway error:", gatewayRes.status, errText);
      return NextResponse.json(
        { error: "Agent unavailable", detail: errText },
        { status: 502 }
      );
    }

    // Streaming response — pipe SSE through
    if (wantStream && gatewayRes.body) {
      return new Response(gatewayRes.body, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    // Non-streaming fallback
    const data = await gatewayRes.json();
    const response = data.choices?.[0]?.message?.content || "No response";
    return NextResponse.json({ response });
  } catch (err) {
    console.error("[Chat/Send] Error:", err);
    return NextResponse.json(
      { error: "Chat failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
