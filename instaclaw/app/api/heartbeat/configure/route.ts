import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { updateHeartbeatInterval } from "@/lib/ssh";
import { logger } from "@/lib/logger";

const ALLOWED_INTERVALS = ["1h", "3h", "6h", "12h", "off"];

const SYSTEM_PROMPT = `You parse natural language heartbeat configuration requests for an AI agent.
The user wants to change how often their agent checks in (heartbeats).

Available intervals: 1h, 3h, 6h, 12h, off

Respond with ONLY valid JSON (no markdown, no code fences):
{
  "interval": "<one of: 1h, 3h, 6h, 12h, off>",
  "response": "<short friendly confirmation, 1-2 sentences>"
}

Examples:
- "check in every hour" → {"interval":"1h","response":"Got it! I'll check in every hour now."}
- "stop checking in" → {"interval":"off","response":"Heartbeats paused. I won't check in until you turn them back on."}
- "less frequent please" → {"interval":"6h","response":"Slowing down to every 6 hours."}
- "only during mornings" → {"interval":"3h","response":"I'll keep checking in every 3 hours. (Custom time-window schedules are coming soon!)"}

If the request is unclear, default to 3h and explain in the response.`;

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { message } = await req.json();

    if (!message || typeof message !== "string" || message.length > 500) {
      return NextResponse.json(
        { error: "Message is required (max 500 chars)" },
        { status: 400 }
      );
    }

    const supabase = getSupabase();

    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("*")
      .eq("assigned_to", session.user.id)
      .single();

    if (!vm) {
      return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
    }

    // Use Haiku to parse NL — direct Anthropic call, not proxied through user credits
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Platform API key not configured" },
        { status: 500 }
      );
    }

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 256,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: message }],
      }),
    });

    if (!aiRes.ok) {
      logger.error("Anthropic API error", { status: aiRes.status, route: "heartbeat/configure" });
      return NextResponse.json(
        { error: "AI parsing failed", response: "Sorry, I couldn't understand that. Try something like 'check in every hour'." },
        { status: 500 }
      );
    }

    const aiResponse = await aiRes.json();
    const text =
      aiResponse.content?.[0]?.type === "text" ? aiResponse.content[0].text : "";
    let parsed: { interval: string; response: string };
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { interval: "3h", response: "I'll keep checking in every 3 hours." };
    }

    // Validate the parsed interval
    if (!ALLOWED_INTERVALS.includes(parsed.interval)) {
      parsed.interval = "3h";
    }

    // Apply via SSH
    const success = await updateHeartbeatInterval(vm, parsed.interval);

    if (!success) {
      return NextResponse.json(
        {
          error: "Failed to apply config on VM",
          response: "Sorry, I couldn't update the config right now. Try again in a moment.",
        },
        { status: 500 }
      );
    }

    // Update DB
    const intervalMs: Record<string, number> = {
      "1h": 3_600_000,
      "3h": 10_800_000,
      "6h": 21_600_000,
      "12h": 43_200_000,
    };
    const now = new Date();
    const nextAt =
      parsed.interval === "off"
        ? null
        : new Date(
            now.getTime() + (intervalMs[parsed.interval] ?? 10_800_000)
          );

    await supabase
      .from("instaclaw_vms")
      .update({
        heartbeat_interval: parsed.interval,
        heartbeat_status: parsed.interval === "off" ? "paused" : "active",
        heartbeat_next_at: nextAt?.toISOString() ?? null,
      })
      .eq("id", vm.id);

    return NextResponse.json({
      interval: parsed.interval,
      response: parsed.response,
      updated: true,
    });
  } catch (err) {
    logger.error("Heartbeat configure error", {
      error: String(err),
      route: "heartbeat/configure",
    });
    return NextResponse.json(
      { error: "Failed to configure heartbeat" },
      { status: 500 }
    );
  }
}
