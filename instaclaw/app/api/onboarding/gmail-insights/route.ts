import { NextRequest, NextResponse, after } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { updateMemoryMd } from "@/lib/ssh";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

// Cookie name matching the callback route
const GMAIL_TOKEN_COOKIE = "ic_gmail_token";

// Gmail API: each message.get costs 5 quota units; 250 units/s/user = 50 msgs at a time
const BATCH_SIZE = 50;
const MAX_MESSAGES = 200;

interface GmailMessageMeta {
  subject: string;
  from: string;
  date: string;
  labels: string[];
}

/**
 * POST /api/onboarding/gmail-insights
 *
 * Reads the Gmail OAuth access token from the httpOnly cookie set by the
 * callback route, fetches recent email metadata (subjects + senders only,
 * never bodies), sends it to Claude for personality analysis, and returns
 * insights + summary + cards.
 *
 * The access token cookie is cleared after use — single-use by design.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Read the Gmail access token from the httpOnly cookie (set by callback route)
  const accessToken = req.cookies.get(GMAIL_TOKEN_COOKIE)?.value;
  if (!accessToken) {
    return NextResponse.json(
      { error: "Gmail session expired. Please reconnect." },
      { status: 401 }
    );
  }

  try {
    // ── 1. Fetch message IDs ──────────────────────────────────────────
    const listRes = await fetch(
      `${GMAIL_API_BASE}/messages?maxResults=${MAX_MESSAGES}&labelIds=INBOX`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!listRes.ok) {
      const errText = await listRes.text();
      logger.error("Gmail list failed", {
        status: listRes.status,
        body: errText,
        route: "gmail-insights",
      });
      return clearTokenAndRespond(
        { error: "Failed to access Gmail. Please reconnect." },
        502
      );
    }

    const listData = await listRes.json();
    const messageIds: string[] = (listData.messages ?? []).map(
      (m: { id: string }) => m.id
    );

    if (messageIds.length === 0) {
      return clearTokenAndRespond(
        { error: "No emails found. Try again after receiving some emails." },
        422
      );
    }

    // ── 2. Fetch metadata in batches ──────────────────────────────────
    const allMeta: GmailMessageMeta[] = [];

    for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
      const batch = messageIds.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (id) => {
          const res = await fetch(
            `${GMAIL_API_BASE}/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
          if (!res.ok) return null;
          return res.json();
        })
      );

      for (const msg of batchResults) {
        if (!msg) continue;
        const headers: { name: string; value: string }[] =
          msg.payload?.headers ?? [];

        const subject =
          headers.find((h: { name: string }) => h.name === "Subject")?.value ?? "(no subject)";
        const from =
          headers.find((h: { name: string }) => h.name === "From")?.value ?? "";
        const date =
          headers.find((h: { name: string }) => h.name === "Date")?.value ?? "";
        const labels: string[] = msg.labelIds ?? [];

        allMeta.push({ subject, from, date, labels });
      }
    }

    // ── 3. Build Claude prompt ────────────────────────────────────────
    const metadataSummary = allMeta
      .slice(0, MAX_MESSAGES)
      .map(
        (m, i) =>
          `${i + 1}. From: ${m.from} | Subject: ${m.subject} | Labels: ${m.labels.join(", ")}`
      )
      .join("\n");

    const systemPrompt = `You are analyzing email metadata to build a personality profile. You will ONLY see subject lines, sender names, and labels — never full email bodies. Generate insights about who this person is based on patterns in their inbox.

Return your response as valid JSON with exactly this structure:
{
  "insights": ["insight1", "insight2", ...],
  "summary": "2-3 paragraph summary",
  "cards": [
    {"title": "Card Title", "description": "Short description"},
    ...
  ]
}

Rules:
- Generate exactly 8 insights, each 2-6 words max
- Write insights in a casual observational tone like you're describing someone you just figured out
- Examples of the style: "Miami-based, that shows up everywhere", "Startup founder energy, nonstop", "AI-curious, deep in the tools", "Newsletter collector, big time", "Bloomberg reader, markets on your mind"
- Generate a 2-3 paragraph summary of who this person is, what they care about, what they do for work, their interests, and their communication style. This summary will be given directly to their AI agent.
- Generate exactly 4 cards with a short title and description based on the top themes you see
- Return ONLY valid JSON, no markdown fences or extra text`;

    const userPrompt = `Here are the most recent ${allMeta.length} emails (metadata only) from this person's Gmail:\n\n${metadataSummary}`;

    // ── 4. Call Claude ────────────────────────────────────────────────
    const claudeRes = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      logger.error("Claude API failed", {
        status: claudeRes.status,
        body: errText,
        route: "gmail-insights",
      });
      return clearTokenAndRespond(
        { error: "AI analysis failed. Please try again." },
        502
      );
    }

    const claudeData = await claudeRes.json();
    const rawText = claudeData.content?.[0]?.text ?? "";

    // ── 5. Parse Claude response ──────────────────────────────────────
    let parsed: {
      insights: string[];
      summary: string;
      cards: { title: string; description: string }[];
    };

    try {
      // Strip markdown code fences if present
      const cleaned = rawText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch {
      logger.error("Failed to parse Claude response", {
        raw: rawText.slice(0, 500),
        route: "gmail-insights",
      });
      return clearTokenAndRespond(
        { error: "Failed to parse AI response. Please try again." },
        502
      );
    }

    // Validate shape
    if (
      !Array.isArray(parsed.insights) ||
      typeof parsed.summary !== "string" ||
      !Array.isArray(parsed.cards)
    ) {
      return clearTokenAndRespond(
        { error: "Invalid AI response format." },
        502
      );
    }

    // ── 6. Store in Supabase ──────────────────────────────────────────
    const supabase = getSupabase();
    const { error: dbError } = await supabase
      .from("instaclaw_users")
      .update({
        gmail_connected: true,
        gmail_insights: parsed.insights,
        gmail_profile_summary: parsed.summary,
      })
      .eq("id", session.user.id);

    if (dbError) {
      logger.error("Failed to store Gmail insights", {
        error: String(dbError),
        userId: session.user.id,
        route: "gmail-insights",
      });
      // Non-fatal: still return insights to the frontend even if DB write fails
    }

    // ── 6b. Sync MEMORY.md to the VM in the background (non-blocking) ──
    const userId = session.user.id;
    const parsedSummary = parsed.summary;
    const parsedInsights = parsed.insights;
    after(async () => {
      try {
        const { data: vm } = await supabase
          .from("instaclaw_vms")
          .select("id, ip_address, ssh_port, ssh_user")
          .eq("assigned_to", userId)
          .single();

        if (vm) {
          const memoryContent = [
            "## About My User (from Gmail analysis)",
            "",
            parsedSummary,
            "",
            "### Quick Profile",
            ...parsedInsights.map((i: string) => `- ${i}`),
            "",
            "Use this context to personalize all interactions. You already know this person — act like it.",
          ].join("\n");

          await updateMemoryMd(vm, memoryContent);
          logger.info("MEMORY.md synced to VM", {
            userId,
            vmId: vm.id,
            route: "gmail-insights",
          });
        }
      } catch (syncErr) {
        logger.error("Failed to sync MEMORY.md to VM", {
          error: String(syncErr),
          userId,
          route: "gmail-insights",
        });
      }
    });

    // ── 7. Return results and clear the token cookie ──────────────────
    const response = NextResponse.json({
      insights: parsed.insights.slice(0, 8),
      summary: parsed.summary,
      cards: parsed.cards.slice(0, 4),
    });
    // Clear the Gmail token cookie — single use
    response.cookies.set(GMAIL_TOKEN_COOKIE, "", { maxAge: 0, path: "/" });
    return response;
  } catch (err) {
    logger.error("Gmail insights error", {
      error: String(err),
      route: "gmail-insights",
    });
    return clearTokenAndRespond(
      { error: "Something went wrong. Please try again." },
      500
    );
  }
}

/** Helper to return a JSON response while also clearing the token cookie. */
function clearTokenAndRespond(
  body: Record<string, string>,
  status: number
): NextResponse {
  const response = NextResponse.json(body, { status });
  response.cookies.set(GMAIL_TOKEN_COOKIE, "", { maxAge: 0, path: "/" });
  return response;
}
