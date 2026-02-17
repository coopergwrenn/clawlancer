import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { updateHeartbeatInterval } from "@/lib/ssh";
import { logger } from "@/lib/logger";

/** Parse an interval string like "3h" or "1.5h" into milliseconds. Returns null for "off". */
function intervalToMs(interval: string): number | null {
  if (interval === "off") return null;
  const match = interval.match(/^(\d+(?:\.\d+)?)h$/);
  if (!match) return null;
  return parseFloat(match[1]) * 3_600_000;
}

/** Validate interval: "off" or decimal hours between 0.5 and 24. */
function isValidInterval(interval: string): boolean {
  if (interval === "off") return true;
  const match = interval.match(/^(\d+(?:\.\d+)?)h$/);
  if (!match) return false;
  const hours = parseFloat(match[1]);
  return hours >= 0.5 && hours <= 24;
}

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { interval } = await req.json();

    if (!interval || typeof interval !== "string" || !isValidInterval(interval)) {
      return NextResponse.json(
        { error: "Invalid interval. Use 'off' or a value between 0.5h and 24h (e.g. '3h', '1.5h')." },
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
    const ms = intervalToMs(interval);
    const now = new Date();
    const nextAt = ms ? new Date(now.getTime() + ms) : null;

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
