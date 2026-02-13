import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

const TIER_LIMITS: Record<string, number> = {
  starter: 400,
  pro: 700,
  power: 2500,
};

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id, tier, credit_balance")
    .eq("assigned_to", session.user.id)
    .single();

  if (!vm) {
    return NextResponse.json({
      today: 0,
      week: 0,
      month: 0,
      dailyLimit: 400,
      creditBalance: 0,
    });
  }

  try {
    const now = new Date();
    const todayStr = now.toISOString().split("T")[0];

    // 7 days ago
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekAgoStr = weekAgo.toISOString().split("T")[0];

    // 30 days ago
    const monthAgo = new Date(now);
    monthAgo.setDate(monthAgo.getDate() - 30);
    const monthAgoStr = monthAgo.toISOString().split("T")[0];

    // Fetch all three ranges in parallel
    const [todayRes, weekRes, monthRes] = await Promise.all([
      supabase
        .from("instaclaw_daily_usage")
        .select("message_count")
        .eq("vm_id", vm.id)
        .eq("usage_date", todayStr)
        .single(),
      supabase
        .from("instaclaw_daily_usage")
        .select("message_count")
        .eq("vm_id", vm.id)
        .gte("usage_date", weekAgoStr),
      supabase
        .from("instaclaw_daily_usage")
        .select("message_count")
        .eq("vm_id", vm.id)
        .gte("usage_date", monthAgoStr),
    ]);

    const tier = vm.tier || "starter";
    const dailyLimit = TIER_LIMITS[tier] ?? 400;
    // Cap displayed usage at the display limit — internal buffer usage is hidden
    const today = Math.min(todayRes.data?.message_count ?? 0, dailyLimit);
    const week = (weekRes.data ?? []).reduce(
      (sum: number, row: { message_count: number }) => sum + row.message_count,
      0
    );
    const month = (monthRes.data ?? []).reduce(
      (sum: number, row: { message_count: number }) => sum + row.message_count,
      0
    );

    return NextResponse.json({
      today,
      week,
      month,
      dailyLimit,
      creditBalance: vm.credit_balance ?? 0,
    });
  } catch (err) {
    logger.error("Usage stats error", { error: String(err), route: "vm/usage" });
    return NextResponse.json({
      today: 0,
      week: 0,
      month: 0,
      dailyLimit: TIER_LIMITS[vm.tier || "starter"] ?? 400,
      creditBalance: 0,
    });
  }
}
