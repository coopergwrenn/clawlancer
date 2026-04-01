import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { proxyToInstaclaw } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/agent/retry-configure
 *
 * Re-triggers VM configuration for users stuck on provisioning.
 * Called from the provisioning timeout retry button.
 */
export async function POST() {
  try {
    const session = await requireSession();

    const res = await proxyToInstaclaw("/api/vm/configure", session.userId, {
      method: "POST",
      body: JSON.stringify({ userId: session.userId }),
    });

    const data = await res.json().catch(() => ({}));

    return NextResponse.json({
      success: true,
      configured: data.configured,
      healthy: data.healthy,
    });
  } catch (err) {
    if (err instanceof Error && err.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("[retry-configure] Error:", err);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
