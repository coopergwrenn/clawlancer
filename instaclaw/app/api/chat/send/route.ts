import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { buildSystemPrompt } from "@/lib/system-prompt";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MAX_HISTORY = 40; // messages to include for context
const MAX_TOKENS = 2048;

/**
 * POST /api/chat/send
 *
 * Sends a message to the user's agent and streams the response.
 * The system prompt comes from the VM's config + user profile data.
 * Chat history is stored in Supabase, scoped by conversation_id.
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
  try {
    const body = await req.json();
    message = body.message;
    conversationId = body.conversation_id;
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

  // Get VM info (for model + system_prompt)
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id, default_model, system_prompt")
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

  // Build system prompt — append Command Center chat constraint
  // (the shared prompt mentions tools that only exist on the VM via Telegram)
  const basePrompt = buildSystemPrompt(
    vm.system_prompt,
    user?.name,
    user?.gmail_profile_summary,
    user?.gmail_insights
  );
  const systemPrompt =
    basePrompt +
    "\n\nIMPORTANT — Command Center Chat context: In this web chat interface you do NOT have access to tools, web search, browser automation, code execution, or any external capabilities. " +
    "Never output XML tags, tool calls, or pretend to search the web. Respond directly using your knowledge. " +
    "If the user asks for something that requires real-time data or tool access, let them know you can handle it as a task instead.";

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

  // Call Anthropic with streaming
  const model = vm.default_model || "claude-haiku-4-5-20251001";

  try {
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
        messages,
        stream: true,
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      logger.error("Anthropic API error in chat", {
        status: anthropicRes.status,
        error: errText.slice(0, 500),
        route: "chat/send",
        userId: session.user.id,
      });
      return NextResponse.json(
        { error: "Your agent encountered an error. Please try again." },
        { status: 502 }
      );
    }

    // Pipe the SSE stream through and accumulate the full response
    // so we can save it to the database when done
    const userId = session.user.id;
    const convId = conversationId;
    const reader = anthropicRes.body?.getReader();
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
            const chunk = decoder.decode(value, { stream: true });
            for (const line of chunk.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              const data = line.slice(6);
              if (data === "[DONE]") continue;
              try {
                const event = JSON.parse(data);
                if (
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
