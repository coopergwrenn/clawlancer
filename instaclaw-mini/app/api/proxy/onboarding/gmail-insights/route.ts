import { NextResponse } from "next/server";
import { requireSession, signProxyToken } from "@/lib/auth";

export const maxDuration = 60;

/**
 * POST /api/proxy/onboarding/gmail-insights
 *
 * Proxies the gmail-insights request to instaclaw.io with a signed token.
 * The instaclaw.io endpoint reads Gmail metadata, analyzes with Claude,
 * generates insights, stores them, and syncs MEMORY.md to the VM.
 */
export async function POST() {
  try {
    const session = await requireSession();
    const token = await signProxyToken(session.userId);
    const baseUrl = process.env.INSTACLAW_API_URL || "https://instaclaw.io";

    const res = await fetch(`${baseUrl}/api/onboarding/gmail-insights`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-mini-app-token": token,
      },
      body: "{}",
    });

    const data = await res.json();

    if (!res.ok) {
      return NextResponse.json(data, { status: res.status });
    }

    return NextResponse.json(data);
  } catch (err) {
    if (err instanceof Error && err.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("[Proxy/GmailInsights] Error:", err);
    return NextResponse.json({ error: "Failed to fetch insights" }, { status: 500 });
  }
}
