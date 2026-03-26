import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getSubscriptionStatus } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await requireSession();
    const status = await getSubscriptionStatus(session.userId);
    return NextResponse.json(status);
  } catch (err) {
    if (err instanceof Error && err.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({
      hasSubscription: false,
      tier: null,
      status: null,
      paymentStatus: null,
      currentPeriodEnd: null,
      dailyLimit: 0,
      dailyUsed: 0,
    });
  }
}
