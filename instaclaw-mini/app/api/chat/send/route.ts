import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getAgentStatus, supabase } from "@/lib/supabase";

/**
 * POST /api/chat/send — Send a message to the user's agent via the OpenClaw gateway.
 * Body: { message, conversation_id?, stream?, toggles? }
 *
 * If conversation_id is provided, saves messages to that conversation.
 * If null, auto-creates a new conversation.
 * Returns: SSE stream if stream=true, otherwise { response, conversation_id }
 */
export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    const body = await req.json();
    const { message, conversation_id, stream: wantStream, toggles } = body;

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

    // Auto-create conversation if not provided
    let convId = conversation_id;
    if (!convId) {
      const { data: newConv } = await supabase()
        .from("instaclaw_conversations")
        .insert({
          user_id: session.userId,
          title: message.slice(0, 50),
        })
        .select()
        .single();
      convId = newConv?.id;
    }

    // Save user message to DB
    if (convId) {
      await supabase().from("instaclaw_chat_messages").insert({
        user_id: session.userId,
        conversation_id: convId,
        role: "user",
        content: message,
      });
    }

    // Build the gateway request
    // OpenClaw gateway requires model: "openclaw" — it routes to the configured model internally
    const gatewayBody: Record<string, unknown> = {
      model: "openclaw",
      messages: [{ role: "user", content: message }],
      stream: !!wantStream,
    };

    if (toggles?.webSearch) gatewayBody.web_search = true;
    if (toggles?.deepResearch) gatewayBody.deep_research = true;

    // Retry logic: if agent returns 400 "busy" (processing a heartbeat or
    // previous request), wait 3s and retry once. OpenClaw processes one
    // request at a time — this handles the occasional collision.
    let gatewayRes: Response | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      gatewayRes = await fetch(`${vmData.gateway_url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${vmData.gateway_token}`,
        },
        body: JSON.stringify(gatewayBody),
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
      const errText = await gatewayRes!.text().catch(() => "");
      // Distinguish credit exhaustion from gateway errors
      if (gatewayRes!.status === 402 || errText.includes("exhausted") || errText.includes("credit")) {
        return NextResponse.json(
          { error: "credits_exhausted", detail: "You're out of credits. Add more to keep chatting." },
          { status: 402 }
        );
      }
      return NextResponse.json(
        { error: "agent_unavailable", detail: errText },
        { status: 502 }
      );
    }

    // Streaming response — pipe through, save assistant message after
    if (wantStream && gatewayRes.body) {
      // For streaming, we can't easily save the response to DB mid-stream.
      // The client will need to call a separate endpoint to save after stream completes,
      // OR we pipe and accumulate. For now, pipe directly and let client save.
      const headers = new Headers({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      if (convId) {
        headers.set("X-Conversation-Id", convId);
      }
      return new Response(gatewayRes.body, { headers });
    }

    // Non-streaming — save assistant response to DB
    const data = await gatewayRes.json();
    const response = data.choices?.[0]?.message?.content || "No response";

    if (convId) {
      await supabase().from("instaclaw_chat_messages").insert({
        user_id: session.userId,
        conversation_id: convId,
        role: "assistant",
        content: response,
      });

      // Update conversation preview + count
      await supabase()
        .from("instaclaw_conversations")
        .update({
          last_message_preview: response.slice(0, 100),
          message_count: await supabase()
            .from("instaclaw_chat_messages")
            .select("id", { count: "exact", head: true })
            .eq("conversation_id", convId)
            .then((r) => r.count || 0),
          updated_at: new Date().toISOString(),
        })
        .eq("id", convId);
    }

    return NextResponse.json({ response, conversation_id: convId });
  } catch (err) {
    console.error("[Chat/Send] Error:", err);
    return NextResponse.json(
      { error: "Chat failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
