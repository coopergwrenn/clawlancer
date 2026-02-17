import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

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

    // Check if user has an assigned VM
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id")
      .eq("assigned_to", session.user.id)
      .single();

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
