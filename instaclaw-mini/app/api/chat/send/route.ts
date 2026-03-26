import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getAgentStatus } from "@/lib/supabase";

/**
 * POST /api/chat/send — Send a message to the user's agent via the OpenClaw gateway.
 * Body: { message: string }
 * Returns: { response: string }
 *
 * This bypasses XMTP/World Chat entirely — sends directly to the gateway HTTP API
 * using the same /v1/chat/completions endpoint. Gives us full control of the UX.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    const { message } = await req.json();

    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "Message required" }, { status: 400 });
    }

    // Get the user's agent to find the gateway URL and token
    const agent = await getAgentStatus(session.userId);
    if (!agent) {
      return NextResponse.json({ error: "No agent assigned" }, { status: 404 });
    }

    // The gateway URL is stored in the VM record — construct from the VM's gateway URL
    // Format: https://{vm-id}.vm.instaclaw.io
    // We need the gateway token too — fetch it from Supabase
    const { supabase } = await import("@/lib/supabase");
    const { data: vmData } = await supabase()
      .from("instaclaw_vms")
      .select("gateway_url, gateway_token")
      .eq("id", agent.id)
      .single();

    if (!vmData?.gateway_url || !vmData?.gateway_token) {
      return NextResponse.json({ error: "Agent not configured" }, { status: 503 });
    }

    // Forward to OpenClaw gateway (OpenAI-compatible format)
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
      console.error("[Chat/Send] Gateway error:", gatewayRes.status, errText);
      return NextResponse.json(
        { error: "Agent unavailable", detail: errText },
        { status: 502 }
      );
    }

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
