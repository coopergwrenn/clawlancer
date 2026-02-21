import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

// Prevent Vercel CDN from caching per-user responses
export const dynamic = "force-dynamic";

const HEARTBEAT_BUFFER = 200;

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();

    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select(
        "id, heartbeat_interval, heartbeat_last_at, heartbeat_next_at, heartbeat_credits_used_today, heartbeat_status, heartbeat_custom_schedule, status"
      )
      .eq("assigned_to", session.user.id)
      .single();

    if (!vm) {
      return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
    }

    // Derive health status from last heartbeat time + interval
    let healthStatus: "healthy" | "unhealthy" | "paused" = "healthy";
    if (vm.heartbeat_status === "paused" || vm.heartbeat_interval === "off") {
      healthStatus = "paused";
    } else if (vm.heartbeat_last_at) {
      const intervalMs: Record<string, number> = {
        "1h": 3_600_000,
        "3h": 10_800_000,
        "6h": 21_600_000,
        "12h": 43_200_000,
      };
      const expectedMs = intervalMs[vm.heartbeat_interval] ?? 10_800_000;
      const lastAt = new Date(vm.heartbeat_last_at).getTime();
      const now = Date.now();
      // Unhealthy if more than 2x the expected interval has passed
      if (now - lastAt > expectedMs * 2) {
        healthStatus = "unhealthy";
      }
    }

    return NextResponse.json({
      interval: vm.heartbeat_interval,
      lastAt: vm.heartbeat_last_at,
      nextAt: vm.heartbeat_next_at,
      creditsUsedToday: vm.heartbeat_credits_used_today,
      bufferTotal: HEARTBEAT_BUFFER,
      status: vm.heartbeat_status,
      healthStatus,
      vmStatus: vm.status,
    });
  } catch (err) {
    logger.error("Heartbeat status error", {
      error: String(err),
      route: "heartbeat/status",
    });
    return NextResponse.json(
      { error: "Failed to fetch heartbeat status" },
      { status: 500 }
    );
  }
}
