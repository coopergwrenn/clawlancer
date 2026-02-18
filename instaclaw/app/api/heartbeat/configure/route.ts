import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { updateHeartbeatInterval } from "@/lib/ssh";
import { logger } from "@/lib/logger";

/** Validate: "off" or decimal hours 0.5–24 like "1h", "2.5h", "12h" */
function isValidInterval(interval: string): boolean {
  if (interval === "off") return true;
  const match = interval.match(/^(\d+(?:\.\d+)?)h$/);
  if (!match) return false;
  const hours = parseFloat(match[1]);
  return hours >= 0.5 && hours <= 24;
}

const SYSTEM_PROMPT = `You parse natural language heartbeat configuration requests for an AI agent.
The user wants to change how often their agent checks in (heartbeats).

The interval can be any value from 0.5h to 24h (e.g. "1h", "2h", "4.5h", "12h") or "off" to pause.
Common presets: 1h, 3h, 6h, 12h — but any decimal between 0.5 and 24 is valid.

Respond with ONLY valid JSON (no markdown, no code fences):
{
  "interval": "<a value like 1h, 2.5h, 6h, etc. or off>",
  "response": "<short friendly confirmation, 1-2 sentences>"
}

Examples:
- "check in every hour" → {"interval":"1h","response":"Got it! I'll check in every hour now."}
- "check in more often" → {"interval":"1h","response":"Bumped it up! I'll check in every hour now."}
- "every 2 hours" → {"interval":"2h","response":"Set to every 2 hours."}
- "stop checking in" → {"interval":"off","response":"Heartbeats paused. I won't check in until you turn them back on."}
- "less frequent please" → {"interval":"6h","response":"Slowing down to every 6 hours."}
- "slow down" → {"interval":"6h","response":"Slowing down to every 6 hours."}
- "twice a day" → {"interval":"12h","response":"Set to twice a day."}
- "pause" → {"interval":"off","response":"Heartbeats paused."}

IMPORTANT: Always choose a specific interval that best matches the user's intent. Do NOT default to 3h unless the user explicitly asks for 3 hours. If the user says "more often", go to 1h. If they say "less often" or "slow down", go to 6h or 12h.`;

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
    let text =
      aiResponse.content?.[0]?.type === "text" ? aiResponse.content[0].text : "";

    // Strip markdown code fences if the AI wrapped its response
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

    // Also try extracting JSON from within the text if there's surrounding prose
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) text = jsonMatch[0];

    let parsed: { interval: string; response: string };
    try {
      parsed = JSON.parse(text);
    } catch {
      logger.error("Failed to parse AI response", { text, route: "heartbeat/configure" });
      return NextResponse.json({
        interval: vm.heartbeat_interval,
        response: "Sorry, I couldn't understand that. Try something like 'check in every hour' or 'pause heartbeats'.",
        updated: false,
      });
    }

    // Validate the parsed interval
    if (!isValidInterval(parsed.interval)) {
      return NextResponse.json({
        interval: vm.heartbeat_interval,
        response: `I couldn't set that interval. Try a value between 0.5h and 24h, or 'off' to pause.`,
        updated: false,
      });
    }

    // Skip SSH if it's already the current interval
    if (parsed.interval === vm.heartbeat_interval) {
      return NextResponse.json({
        interval: parsed.interval,
        response: parsed.response,
        updated: true,
      });
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

    // Compute next heartbeat time from interval
    const now = new Date();
    let nextAt: Date | null = null;
    if (parsed.interval !== "off") {
      const hMatch = parsed.interval.match(/^(\d+(?:\.\d+)?)h$/);
      const ms = hMatch ? parseFloat(hMatch[1]) * 3_600_000 : 10_800_000;
      nextAt = new Date(now.getTime() + ms);
    }

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
