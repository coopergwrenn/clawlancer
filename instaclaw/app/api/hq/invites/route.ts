import { NextResponse } from "next/server";
import { verifyHQAuth } from "@/lib/hq-auth";
import { getSupabase } from "@/lib/supabase";

// Prevent Vercel CDN from caching per-user responses
export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await verifyHQAuth())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const supabase = getSupabase();
    const now = new Date();

    // Fetch all invites
    const { data: allInvites, error: invErr } = await supabase
      .from("instaclaw_invites")
      .select("code, email, is_active, times_used, created_at, expires_at, created_by")
      .order("created_at", { ascending: true });

    if (invErr) throw new Error(invErr.message);
    const invites = allInvites ?? [];

    // Bucket invites
    const redeemed = invites.filter((i) => i.times_used > 0);
    const activeUnused = invites.filter(
      (i) => i.is_active && i.times_used === 0 && new Date(i.expires_at) > now
    );
    const expired = invites.filter(
      (i) => i.is_active && i.times_used === 0 && new Date(i.expires_at) <= now
    );
    const deactivated = invites.filter(
      (i) => !i.is_active && i.times_used === 0
    );

    const conversionRate =
      invites.length > 0
        ? Number(((redeemed.length / invites.length) * 100).toFixed(1))
        : 0;

    // Urgency buckets for active unredeemed
    function daysLeft(dateStr: string): number {
      return Math.max(
        0,
        Math.ceil(
          (new Date(dateStr).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
        )
      );
    }

    const urgent = activeUnused.filter((i) => daysLeft(i.expires_at) <= 2);
    const moderate = activeUnused.filter((i) => {
      const d = daysLeft(i.expires_at);
      return d > 2 && d <= 5;
    });
    const fresh = activeUnused.filter((i) => daysLeft(i.expires_at) > 5);

    // Follow-up details with email + days remaining
    const followUpDetails = activeUnused.map((i) => ({
      email: i.email,
      daysLeft: daysLeft(i.expires_at),
      createdAt: i.created_at,
    }));

    // Active users + VM assignments
    const { data: users, error: usrErr } = await supabase
      .from("instaclaw_users")
      .select("id, email, created_at")
      .order("created_at", { ascending: false });

    if (usrErr) throw new Error(usrErr.message);

    const { data: assignedVMs, error: vmErr } = await supabase
      .from("instaclaw_vms")
      .select("assigned_to, name, health_status")
      .eq("status", "assigned");

    if (vmErr) throw new Error(vmErr.message);

    const userVMMap = new Map(
      (assignedVMs ?? []).map((v) => [v.assigned_to, v])
    );

    const activeUsers = (users ?? []).map((u) => {
      const vm = userVMMap.get(u.id);
      return {
        email: u.email,
        createdAt: u.created_at,
        vmName: vm?.name ?? null,
        healthStatus: vm?.health_status ?? null,
      };
    });

    // Fleet counts
    const { count: readyVMs } = await supabase
      .from("instaclaw_vms")
      .select("id", { count: "exact", head: true })
      .eq("status", "ready");

    const { count: totalVMs } = await supabase
      .from("instaclaw_vms")
      .select("id", { count: "exact", head: true });

    const { count: failedVMs } = await supabase
      .from("instaclaw_vms")
      .select("id", { count: "exact", head: true })
      .eq("status", "failed");

    // Waitlist counts
    const { count: totalWaitlist } = await supabase
      .from("instaclaw_waitlist")
      .select("id", { count: "exact", head: true });

    const { count: waitlistInvited } = await supabase
      .from("instaclaw_waitlist")
      .select("id", { count: "exact", head: true })
      .not("invite_sent_at", "is", null);

    const { count: waitlistNotInvited } = await supabase
      .from("instaclaw_waitlist")
      .select("id", { count: "exact", head: true })
      .is("invite_sent_at", null);

    const headroom = (readyVMs ?? 0) - activeUnused.length;

    return NextResponse.json({
      funnel: {
        total: invites.length,
        redeemed: redeemed.length,
        activeUnused: activeUnused.length,
        expired: expired.length,
        deactivated: deactivated.length,
        conversionRate,
      },
      urgency: {
        urgent: urgent.length,
        moderate: moderate.length,
        fresh: fresh.length,
        details: followUpDetails,
      },
      activeUsers,
      fleet: {
        total: totalVMs ?? 0,
        ready: readyVMs ?? 0,
        assigned: assignedVMs?.length ?? 0,
        failed: failedVMs ?? 0,
        headroom,
      },
      waitlist: {
        total: totalWaitlist ?? 0,
        invited: waitlistInvited ?? 0,
        notInvited: waitlistNotInvited ?? 0,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
