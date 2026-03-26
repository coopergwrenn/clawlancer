import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getGoogleStatus } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await requireSession();
    const status = await getGoogleStatus(session.userId);
    return NextResponse.json(status);
  } catch (err) {
    if (err instanceof Error && err.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ connected: false, connectedAt: null });
  }
}
