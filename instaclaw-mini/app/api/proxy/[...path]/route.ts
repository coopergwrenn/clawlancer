import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { proxyToInstaclaw } from "@/lib/api";

/**
 * Generic authenticated proxy to instaclaw.io.
 * GET /api/proxy/tasks/suggestions → proxied to instaclaw.io/api/tasks/suggestions
 * POST /api/proxy/vm/update-model → proxied to instaclaw.io/api/vm/update-model
 */

async function handleProxy(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
  method: "GET" | "POST"
) {
  try {
    const session = await requireSession();
    const { path } = await params;
    const targetPath = `/api/${path.join("/")}`;

    const options: RequestInit = { method };
    if (method === "POST") {
      options.body = await req.text();
    }

    const res = await proxyToInstaclaw(targetPath, session.userId, options);
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    if (err instanceof Error && err.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Proxy error:", err);
    return NextResponse.json({ error: "Proxy request failed" }, { status: 500 });
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return handleProxy(req, ctx, "GET");
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return handleProxy(req, ctx, "POST");
}
