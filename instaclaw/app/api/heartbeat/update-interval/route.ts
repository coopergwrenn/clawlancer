import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { updateHeartbeatInterval } from "@/lib/ssh";
import { logger } from "@/lib/logger";

const ALLOWED_INTERVALS = ["1h", "3h", "6h", "12h", "off"];

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { interval } = await req.json();

    if (!interval || !ALLOWED_INTERVALS.includes(interval)) {
      return NextResponse.json(
        {
          error:
            "Invalid interval. Must be one of: " + ALLOWED_INTERVALS.join(", "),
        },
        { status: 400 }
      );
    }

    const supabase = getSupabase();

    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("*")
      .eq("assigned_to", session.user.id)
      .single();

    if (!vm) {
      return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
    }

    // SSH into VM and update heartbeat config
    const success = await updateHeartbeatInterval(vm, interval);

    if (!success) {
      return NextResponse.json(
        { error: "Failed to update heartbeat interval on VM" },
        { status: 500 }
      );
    }

    // Compute next heartbeat time
    const intervalMs: Record<string, number> = {
      "1h": 3_600_000,
      "3h": 10_800_000,
      "6h": 21_600_000,
      "12h": 43_200_000,
    };
    const now = new Date();
    const nextAt =
      interval === "off"
        ? null
        : new Date(now.getTime() + (intervalMs[interval] ?? 10_800_000));

    // Update DB record
    await supabase
      .from("instaclaw_vms")
      .update({
        heartbeat_interval: interval,
        heartbeat_status: interval === "off" ? "paused" : "active",
        heartbeat_next_at: nextAt?.toISOString() ?? null,
      })
      .eq("id", vm.id);

    return NextResponse.json({ updated: true, interval });
  } catch (err) {
    logger.error("Update heartbeat interval error", {
      error: String(err),
      route: "heartbeat/update-interval",
    });
    return NextResponse.json(
      { error: "Failed to update heartbeat interval" },
      { status: 500 }
    );
  }
}
