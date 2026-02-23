import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { buildSystemPrompt } from "@/lib/system-prompt";
import { isAnthropicModel } from "@/lib/models";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MAX_HISTORY = 40; // messages to include for context
const MAX_TOKENS = 4096;
const GATEWAY_TIMEOUT_MS = 90_000;

/**
 * POST /api/chat/send
 *
 * Sends a message to the user's agent and streams the response.
 * When the VM has a healthy gateway, messages are proxied through the
 * OpenClaw gateway on the VM — giving Command Center chat the same
 * tool access (Brave Search, browser, etc.) as Telegram.
 * Falls back to direct Anthropic API if the gateway is unreachable.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.error("ANTHROPIC_API_KEY not set", { route: "chat/send" });
    return NextResponse.json(
      { error: "Chat is not configured on this environment." },
      { status: 500 }
    );
  }

  let message: string;
  let conversationId: string | undefined;
  let toggles: { deepResearch?: boolean; webSearch?: boolean; styleMatch?: boolean } = {};
  try {
    const body = await req.json();
    message = body.message;
    conversationId = body.conversation_id;
    if (body.toggles && typeof body.toggles === "object") {
      toggles = body.toggles;
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!message || typeof message !== "string" || message.trim().length === 0) {
    return NextResponse.json({ error: "Message is required" }, { status: 400 });
  }
  message = message.trim();

  const supabase = getSupabase();

  // Resolve conversation_id: use provided, find most recent, or create one
  if (!conversationId) {
    const { data: recent } = await supabase
      .from("instaclaw_conversations")
      .select("id")
      .eq("user_id", session.user.id)
      .eq("is_archived", false)
      .order("updated_at", { ascending: false })
      .limit(1)
      .single();

    if (recent) {
      conversationId = recent.id;
    } else {
      const { data: newConv } = await supabase
        .from("instaclaw_conversations")
        .insert({ user_id: session.user.id, title: "New Chat" })
        .select("id")
        .single();
      conversationId = newConv?.id;
    }
  }

  if (!conversationId) {
    return NextResponse.json({ error: "Failed to resolve conversation" }, { status: 500 });
  }

  // Get VM info (model, system_prompt, gateway details)
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

  // Get user profile for personalization
  const { data: user } = await supabase
    .from("instaclaw_users")
    .select("name, gmail_profile_summary, gmail_insights")
    .eq("id", session.user.id)
    .single();

  // Build system prompt
  const basePrompt = buildSystemPrompt(
    vm.system_prompt,
    user?.name,
    user?.gmail_profile_summary,
    user?.gmail_insights
  );

  // Determine if we can proxy through the VM gateway
  const canUseGateway = !!(vm.gateway_url && vm.gateway_token && vm.health_status === "healthy");

  // Build the Command Center system prompt suffix
  let commandCenterSuffix: string;

  if (canUseGateway) {
    // Gateway mode: agent has full tool access
    commandCenterSuffix =
      "\n\nYou're currently chatting through the web Command Center. " +
      "You have full tool access — web search, browser automation, file operations, and all your usual capabilities work here just like on Telegram. " +
      "Use your tools proactively when they'd help answer the user's question.";

    // Add toggle-specific instructions
    const toggleInstructions: string[] = [];
    if (toggles.deepResearch) {
      toggleInstructions.push(
        "The user has enabled DEEP RESEARCH mode. Perform thorough, multi-step research — break the question down, search broadly using web search, cross-reference multiple sources, and provide a comprehensive answer with citations."
      );
    }
    if (toggles.webSearch) {
      toggleInstructions.push(
        "The user has enabled WEB SEARCH. Prioritize using web search to find current, up-to-date information. Cite your sources."
      );
    }
    if (toggles.styleMatch) {
      toggleInstructions.push(
        "The user has enabled STYLE MATCH. Match the user's personal writing style based on their email patterns and previous messages."
      );
    }
    if (toggleInstructions.length > 0) {
      commandCenterSuffix += "\n\n" + toggleInstructions.join("\n");
    }
  } else {
    // Fallback mode: no gateway, direct Anthropic (no tools)
    commandCenterSuffix =
      "\n\nIMPORTANT — You're currently chatting through the web Command Center. " +
      "Your agent VM is currently offline, so tool access (web search, browser, etc.) is temporarily unavailable. " +
      "You can still help with conversation, planning, writing, analysis, and brainstorming. " +
      "For tasks requiring tools, let the user know their agent needs to be online — they can check the dashboard for status.";
  }

  commandCenterSuffix += " Never output raw XML tags or fake tool calls. Just respond naturally.";

  const systemPrompt = basePrompt + commandCenterSuffix;

  // Get recent chat history scoped to this conversation
  const { data: history } = await supabase
    .from("instaclaw_chat_messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(MAX_HISTORY);

  const messages = [
    ...(history ?? []).reverse(),
    { role: "user", content: message },
  ];

  // Save the user message immediately
  await supabase.from("instaclaw_chat_messages").insert({
    user_id: session.user.id,
    conversation_id: conversationId,
    role: "user",
    content: message,
  });

  // Get current conversation metadata for auto-title check
  const { data: convMeta } = await supabase
    .from("instaclaw_conversations")
    .select("message_count")
    .eq("id", conversationId)
    .single();

  const wasEmpty = (convMeta?.message_count ?? 0) === 0;

  const model = vm.default_model || "claude-haiku-4-5-20251001";

  // ── Try gateway first, fall back to direct Anthropic ──────────

  let upstreamRes: Response;
  let isGatewayResponse = false;

  if (canUseGateway) {
    try {
      const gatewayUrl = vm.gateway_url!.replace(/\/+$/, "");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);

      // Gateway uses OpenAI chat completions format
      const gatewayBody = JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: "system", content: systemPrompt },
          ...messages,
        ],
        stream: true,
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
        logger.warn("Gateway returned error, falling back to direct Anthropic", {
          status: upstreamRes.status,
          error: errText.slice(0, 300),
          route: "chat/send",
          vmId: vm.id,
          userId: session.user.id,
        });
        // Fall through to direct Anthropic below
        upstreamRes = null!;
      } else {
        isGatewayResponse = true;
        logger.info("Chat proxied through gateway", {
          route: "chat/send",
          vmId: vm.id,
          userId: session.user.id,
        });
      }
    } catch (gwErr) {
      logger.warn("Gateway unreachable, falling back to direct Anthropic", {
        error: String(gwErr),
        route: "chat/send",
        vmId: vm.id,
        gatewayUrl: vm.gateway_url,
        userId: session.user.id,
      });
      upstreamRes = null!;
    }
  } else {
    upstreamRes = null!;
  }

  // Fallback: direct Anthropic API (no tools)
  if (!upstreamRes) {
    // Non-Anthropic models (e.g. MiniMax) can only run through the gateway
    if (!isAnthropicModel(model)) {
      logger.warn("Non-Anthropic model requires gateway", {
        model,
        route: "chat/send",
        userId: session.user.id,
      });
      return NextResponse.json(
        { error: `${model} requires your agent to be online. Check your dashboard for status.` },
        { status: 502 }
      );
    }

    const anthropicBody = JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages,
      stream: true,
    });

    try {
      upstreamRes = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: anthropicBody,
      });

      if (!upstreamRes.ok) {
        const errText = await upstreamRes.text();
        logger.error("Anthropic API error in chat", {
          status: upstreamRes.status,
          error: errText.slice(0, 500),
          route: "chat/send",
          userId: session.user.id,
        });
        return NextResponse.json(
          { error: "Your agent encountered an error. Please try again." },
          { status: 502 }
        );
      }
    } catch (err) {
      logger.error("Chat send error", {
        error: String(err),
        route: "chat/send",
        userId: session.user.id,
      });
      return NextResponse.json(
        { error: "Your agent is currently offline. Check your dashboard for status." },
        { status: 502 }
      );
    }
  }

  // ── Stream response back to client ────────────────────────────

  const userId = session.user.id;
  const convId = conversationId;
  const vmId = vm.id;
  const vmTimezone = vm.user_timezone || "America/New_York";
  const reader = upstreamRes.body?.getReader();
  if (!reader) {
    return NextResponse.json({ error: "No response stream" }, { status: 502 });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const decoder = new TextDecoder();
      let fullText = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // Forward raw SSE bytes to client
          controller.enqueue(value);

          // Parse out text deltas for saving
          // Gateway (OpenAI format): choices[0].delta.content
          // Anthropic format: content_block_delta with delta.text
          const chunk = decoder.decode(value, { stream: true });
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6);
            if (data === "[DONE]") continue;
            try {
              const event = JSON.parse(data);
              // OpenAI SSE format (gateway)
              if (event.choices?.[0]?.delta?.content) {
                fullText += event.choices[0].delta.content;
              }
              // Anthropic SSE format (direct fallback)
              else if (
                event.type === "content_block_delta" &&
                event.delta?.type === "text_delta"
              ) {
                fullText += event.delta.text;
              }
            } catch {
              // Not valid JSON — skip
            }
          }
        }

        // Save the complete assistant response + update conversation metadata
        if (fullText.length > 0) {
          const db = getSupabase();

          // Save assistant message
          db.from("instaclaw_chat_messages")
            .insert({
              user_id: userId,
              conversation_id: convId,
              role: "assistant",
              content: fullText,
            })
            .then(({ error }) => {
              if (error) {
                logger.error("Failed to save assistant message", {
                  error: String(error),
                  route: "chat/send",
                  userId,
                });
              }
            });

          // Track usage for direct Anthropic fallback (gateway proxied calls
          // are tracked by the proxy route — this covers the bypass path)
          if (!isGatewayResponse) {
            db.rpc("instaclaw_increment_usage", {
              p_vm_id: vmId,
              p_model: model,
              p_is_heartbeat: false,
              p_timezone: vmTimezone,
            }).then(({ error: incErr }) => {
              if (incErr) {
                logger.error("Failed to track usage for direct Anthropic fallback", {
                  error: String(incErr),
                  route: "chat/send",
                  userId,
                  vmId,
                });
              }
            });
          }

          // Update conversation metadata
          const preview = fullText.slice(0, 100);
          const updateFields: Record<string, unknown> = {
            last_message_preview: preview,
            updated_at: new Date().toISOString(),
          };

          // Auto-title from first user message if conversation was empty
          if (wasEmpty) {
            const words = message.split(/\s+/);
            let title = "";
            for (const word of words) {
              if ((title + " " + word).trim().length > 50) break;
              title = (title + " " + word).trim();
            }
            updateFields.title = title || message.slice(0, 50);
          }

          // Update metadata + increment message_count
          db.from("instaclaw_conversations")
            .select("message_count")
            .eq("id", convId)
            .single()
            .then(({ data: conv }) => {
              db.from("instaclaw_conversations")
                .update({
                  ...updateFields,
                  message_count: ((conv?.message_count ?? 0) + 2),
                })
                .eq("id", convId)
                .then(() => {});
            });
        }
      } catch (err) {
        logger.error("Stream processing error", {
          error: String(err),
          route: "chat/send",
          userId,
        });
      } finally {
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
