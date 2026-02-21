import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

// Prevent Vercel CDN from caching per-user responses
export const dynamic = "force-dynamic";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ suggestions: null });
  }

  const supabase = getSupabase();

  const { data: user } = await supabase
    .from("instaclaw_users")
    .select("name, gmail_profile_summary, gmail_insights")
    .eq("id", session.user.id)
    .single();

  if (!user?.gmail_profile_summary) {
    return NextResponse.json({ suggestions: null });
  }

  try {
    const insightsText = user.gmail_insights?.length
      ? user.gmail_insights.join(", ")
      : "";

    const { data: recentTasks } = await supabase
      .from("instaclaw_tasks")
      .select("title, description")
      .eq("user_id", session.user.id)
      .eq("status", "completed")
      .order("created_at", { ascending: false })
      .limit(10);

    const recentTasksText = recentTasks?.length
      ? recentTasks.map((t) => `- ${t.title}`).join("\n")
      : "None yet";

    const res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        messages: [
          {
            role: "user",
            content: `Based on this user's profile and task history, generate exactly 6 personalized quick action suggestions for their AI agent. These are chip labels + prefill text that appear below the chat input.

User: ${user.name || "Unknown"}
Profile: ${user.gmail_profile_summary}
Insights: ${insightsText}

Recently completed tasks (do NOT re-suggest these):
${recentTasksText}

Rules:
- Labels must be under 25 characters (short chip text)
- Prefills are the full instruction to the AI agent (1-2 sentences)
- Mix of one-off tasks and recurring/scheduled tasks
- Make them feel personally relevant based on the profile, not generic
- No emojis
- No em dashes
- Suggestions should be diverse (research, writing, monitoring, scheduling, etc.)
- IMPORTANT: Generate completely DIFFERENT suggestions each time. Be creative and varied. Random seed: ${Date.now()}

Respond in this exact JSON format, nothing else:
[
  {"label": "short label", "prefill": "Full instruction to the agent..."},
  {"label": "short label", "prefill": "Full instruction to the agent..."},
  {"label": "short label", "prefill": "Full instruction to the agent..."},
  {"label": "short label", "prefill": "Full instruction to the agent..."},
  {"label": "short label", "prefill": "Full instruction to the agent..."},
  {"label": "short label", "prefill": "Full instruction to the agent..."}
]`,
          },
        ],
      }),
    });

    if (!res.ok) {
      return NextResponse.json({ suggestions: null });
    }

    const data = await res.json();
    let text =
      data.content?.[0]?.type === "text" ? data.content[0].text : "";
    // Strip markdown code fences if Haiku wraps the response
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    const suggestions = JSON.parse(text);

    return NextResponse.json({ suggestions }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ suggestions: null });
  }
}
