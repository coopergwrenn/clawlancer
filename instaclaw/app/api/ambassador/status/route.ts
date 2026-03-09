import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("instaclaw_ambassadors")
    .select("*")
    .eq("user_id", session.user.id)
    .single();

  if (error && error.code !== "PGRST116") {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // PGRST116 = no rows found — user has not applied
  if (!data) {
    return NextResponse.json({ ambassador: null });
  }

  // Fetch referral breakdown stats
  let referral_stats = {
    waitlist_count: 0,
    signup_count: 0,
    paid_count: 0,
    pending_earnings: 0,
  };

  try {
    const [waitlist, signups, paid, earnings] = await Promise.all([
      supabase
        .from("instaclaw_ambassador_referrals")
        .select("*", { count: "exact", head: true })
        .eq("ambassador_id", data.id)
        .not("waitlisted_at", "is", null),
      supabase
        .from("instaclaw_ambassador_referrals")
        .select("*", { count: "exact", head: true })
        .eq("ambassador_id", data.id)
        .not("signed_up_at", "is", null),
      supabase
        .from("instaclaw_ambassador_referrals")
        .select("*", { count: "exact", head: true })
        .eq("ambassador_id", data.id)
        .not("paid_at", "is", null),
      supabase
        .from("instaclaw_ambassador_referrals")
        .select("commission_amount")
        .eq("ambassador_id", data.id)
        .eq("commission_status", "pending"),
    ]);

    referral_stats = {
      waitlist_count: waitlist.count ?? 0,
      signup_count: signups.count ?? 0,
      paid_count: paid.count ?? 0,
      pending_earnings: (earnings.data ?? []).reduce(
        (sum, r) => sum + Number(r.commission_amount ?? 0),
        0
      ),
    };
  } catch {
    // Non-critical — return zeros if referrals table doesn't exist yet
  }

  return NextResponse.json({ ambassador: data, referral_stats });
}
