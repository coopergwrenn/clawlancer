import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { getUserVm } from "@/lib/get-user-vm";

// Prevent Vercel CDN from caching per-user responses
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();

    const { data: sub } = await supabase
      .from("instaclaw_subscriptions")
      .select("tier, status, payment_status")
      .eq("user_id", session.user.id)
      .single();

    if (!sub) {
      return NextResponse.json({ subscription: null });
    }

    // Check if user has an assigned live VM. Terminal rows are excluded
    // so the billing card doesn't claim "you have an agent" for a dead one.
    const vm = await getUserVm<{ id: string }>(supabase, session.user.id, {
      columns: "id",
    });

    return NextResponse.json({
      subscription: {
        tier: sub.tier,
        status: sub.status,
        paymentStatus: sub.payment_status ?? "current",
        hasVm: !!vm,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to check billing status" },
      { status: 500 }
    );
  }
}
