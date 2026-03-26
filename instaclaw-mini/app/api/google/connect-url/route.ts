import { NextResponse } from "next/server";
import { requireSession, signProxyToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/google/connect-url
 *
 * Returns a signed URL that opens instaclaw.io's Gmail OAuth flow
 * in the system browser (Google blocks OAuth in WebViews).
 */
export async function GET() {
  try {
    const session = await requireSession();
    const token = await signProxyToken(session.userId);

    const baseUrl = process.env.INSTACLAW_API_URL || "https://instaclaw.io";
    const url = `${baseUrl}/api/gmail/connect-mini?token=${encodeURIComponent(token)}`;

    return NextResponse.json({ url });
  } catch (err) {
    if (err instanceof Error && err.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to generate connect URL" }, { status: 500 });
  }
}
