import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

const MAX_CONFIGURE_ATTEMPTS = 3;

export async function POST() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();

    // Get user's VM — must be in configure_failed state
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, health_status, configure_attempts")
      .eq("assigned_to", session.user.id)
      .single();

    if (!vm) {
      return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
    }

    // Allow retry from failed, configuring, or unknown states
    const retryableStates = ["configure_failed", "configuring", "unknown", "unhealthy"];
    if (!retryableStates.includes(vm.health_status ?? "unknown")) {
      return NextResponse.json(
        { error: "VM is not in a retryable state" },
        { status: 400 }
      );
    }

    if ((vm.configure_attempts ?? 0) >= MAX_CONFIGURE_ATTEMPTS) {
      return NextResponse.json(
        { error: "Maximum retry attempts reached. Please contact support." },
        { status: 400 }
      );
    }

    // Verify pending config exists
    const { data: pending } = await supabase
      .from("instaclaw_pending_users")
      .select("id")
      .eq("user_id", session.user.id)
      .single();

    if (!pending) {
      return NextResponse.json(
        { error: "No pending configuration found" },
        { status: 404 }
      );
    }

    // Fire-and-forget the configure call.
    // Returns immediately so the deploying page can resume polling.
    fetch(
      `${process.env.NEXTAUTH_URL}/api/vm/configure`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Admin-Key": process.env.ADMIN_API_KEY ?? "",
        },
        body: JSON.stringify({ userId: session.user.id }),
      }
    ).catch((err) => {
      logger.error("Retry configure fire-and-forget failed", { error: String(err), route: "vm/retry-configure" });
    });

    return NextResponse.json({ retried: true });
  } catch (err) {
    logger.error("VM retry-configure error", { error: String(err), route: "vm/retry-configure" });
    return NextResponse.json(
      { error: "Failed to retry configuration" },
      { status: 500 }
    );
  }
}
