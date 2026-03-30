import { NextResponse } from "next/server";
import { requireSession, signProxyToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const session = await requireSession();
    const token = await signProxyToken(session.userId);
    const baseUrl = process.env.INSTACLAW_API_URL || "https://instaclaw.io";

    const res = await fetch(`${baseUrl}/api/agentbook/start-registration`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-mini-app-token": token,
      },
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
