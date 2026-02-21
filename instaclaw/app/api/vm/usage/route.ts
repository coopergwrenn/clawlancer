import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

// Prevent Vercel CDN from caching per-user responses
export const dynamic = "force-dynamic";

const TIER_LIMITS: Record<string, number> = {
  starter: 600,
  pro: 1000,
  power: 2500,
};

const NO_CACHE_HEADERS = {
  "Cache-Control": "private, no-store, no-cache, must-revalidate",
  "Vary": "Cookie",
};

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_CACHE_HEADERS });
  }

  const supabase = getSupabase();
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id, tier, credit_balance, user_timezone")
    .eq("assigned_to", session.user.id)
    .single();

  if (!vm) {
    return NextResponse.json({
      today: 0,
      week: 0,
      month: 0,
      dailyLimit: 600,
      creditBalance: 0,
    }, { headers: NO_CACHE_HEADERS });
  }

  try {
    const userTz = vm.user_timezone || "America/New_York";
    const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: userTz });

    // 7 days ago (in user's timezone)
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekAgoStr = weekAgo.toLocaleDateString("en-CA", { timeZone: userTz });

    // 30 days ago (in user's timezone)
    const monthAgo = new Date();
    monthAgo.setDate(monthAgo.getDate() - 30);
    const monthAgoStr = monthAgo.toLocaleDateString("en-CA", { timeZone: userTz });

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
    const dailyLimit = TIER_LIMITS[tier] ?? 600;
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
    }, { headers: NO_CACHE_HEADERS });
  } catch (err) {
    logger.error("Usage stats error", { error: String(err), route: "vm/usage" });
    return NextResponse.json({
      today: 0,
      week: 0,
      month: 0,
      dailyLimit: TIER_LIMITS[vm.tier || "starter"] ?? 600,
      creditBalance: 0,
    }, { headers: NO_CACHE_HEADERS });
  }
}
