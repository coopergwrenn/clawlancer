import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

const REPAIR_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

export async function POST() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();

    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, health_status, last_health_check, configure_attempts")
      .eq("assigned_to", session.user.id)
      .single();

    if (!vm) {
      return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
    }

    // Rate limit: max 1 repair per 10 minutes
    const lastCheck = vm.last_health_check
      ? new Date(vm.last_health_check).getTime()
      : 0;
    if (Date.now() - lastCheck < REPAIR_COOLDOWN_MS) {
      const retryAfter = Math.ceil(
        (lastCheck + REPAIR_COOLDOWN_MS - Date.now()) / 1000
      );
      return NextResponse.json(
        {
          error: "Repair was recently triggered. Please wait before trying again.",
          retryAfter,
        },
        { status: 429 }
      );
    }

    // Set health_status to "unknown" so dashboard shows repairing state
    await supabase
      .from("instaclaw_vms")
      .update({
        health_status: "unknown",
        last_health_check: new Date().toISOString(),
      })
      .eq("id", vm.id);

    // Fire-and-forget the configure call (same pattern as retry-configure)
    fetch(`${process.env.NEXTAUTH_URL}/api/vm/configure`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Key": process.env.ADMIN_API_KEY ?? "",
      },
      body: JSON.stringify({ userId: session.user.id }),
    }).catch((err) => {
      logger.error("Repair configure fire-and-forget failed", {
        error: String(err),
        route: "vm/repair",
      });
    });

    logger.info("Repair triggered by user", {
      route: "vm/repair",
      userId: session.user.id,
      vmId: vm.id,
      previousStatus: vm.health_status,
    });

    return NextResponse.json({ repaired: true });
  } catch (err) {
    logger.error("VM repair error", {
      error: String(err),
      route: "vm/repair",
    });
    return NextResponse.json(
      { error: "Failed to start repair" },
      { status: 500 }
    );
  }
}
