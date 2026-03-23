import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { proxyToInstaclaw } from "@/lib/api";

/**
 * Generic authenticated proxy to instaclaw.io for write operations.
 * Usage: POST /api/proxy/vm/update-model → proxied to instaclaw.io/api/vm/update-model
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const session = await requireSession();
    const { path } = await params;
    const targetPath = `/api/${path.join("/")}`;

    const body = await req.text();
    const res = await proxyToInstaclaw(targetPath, session.userId, {
      method: "POST",
      body,
    });

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    if (err instanceof Error && err.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Proxy error:", err);
    return NextResponse.json(
      { error: "Proxy request failed" },
      { status: 500 }
    );
  }
}
