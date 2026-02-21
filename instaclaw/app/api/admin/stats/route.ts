import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAdmin } from "@/lib/admin";
import { getSupabase } from "@/lib/supabase";

// Prevent Vercel CDN from caching per-user responses
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!isAdmin(session?.user?.email)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();
  const type = req.nextUrl.searchParams.get("type");

  if (type === "users") {
    const { data: users } = await supabase
      .from("instaclaw_users")
      .select("id, email, name, created_at, onboarding_complete")
      .order("created_at", { ascending: false });

    // Get VM status for each user
    const usersWithVMs = await Promise.all(
      (users ?? []).map(async (user) => {
        const { data: vm } = await supabase
          .from("instaclaw_vms")
          .select("status")
          .eq("assigned_to", user.id)
          .single();

        return { ...user, vm_status: vm?.status ?? null };
      })
    );

    return NextResponse.json({ users: usersWithVMs });
  }

  if (type === "waitlist") {
    const { data: waitlist } = await supabase
      .from("instaclaw_waitlist")
      .select("id, email, position, created_at, invite_sent_at, invite_code")
      .order("position", { ascending: true });

    return NextResponse.json({ waitlist: waitlist ?? [] });
  }

  // Default: overview stats
  const { data: pool } = await supabase.rpc("instaclaw_get_pool_stats");

  const { count: waitlistCount } = await supabase
    .from("instaclaw_waitlist")
    .select("*", { count: "exact", head: true });

  const { count: userCount } = await supabase
    .from("instaclaw_users")
    .select("*", { count: "exact", head: true });

  return NextResponse.json({
    pool: pool?.[0] ?? {
      total_vms: 0,
      ready_vms: 0,
      assigned_vms: 0,
      failed_vms: 0,
      pending_users: 0,
    },
    waitlist: waitlistCount ?? 0,
    users: userCount ?? 0,
  });
}
