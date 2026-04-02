import { NextRequest, NextResponse } from "next/server";
import { requireSession, signProxyToken } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    const token = await signProxyToken(session.userId);
    const baseUrl = process.env.INSTACLAW_API_URL || "https://instaclaw.io";
    const body = await req.json();

    const res = await fetch(`${baseUrl}/api/agentbook/register-direct`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-mini-app-token": token,
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    if (err instanceof Error && err.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Proxy failed" }, { status: 500 });
  }
}
