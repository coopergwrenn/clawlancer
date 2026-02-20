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

    // Get user's VM
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, health_status, configure_attempts, gateway_url")
      .eq("assigned_to", session.user.id)
      .single();

    if (!vm) {
      return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
    }

    // Allow retry from failed, configuring, or unknown states.
    // Also allow retry when gateway_url is missing — this handles the case
    // where the initial configure request was aborted (e.g. Vercel freeze)
    // and the VM still shows stale health_status from a previous config.
    const retryableStates = ["configure_failed", "configuring", "unknown", "unhealthy"];
    const needsConfigure = !vm.gateway_url;
    if (!needsConfigure && !retryableStates.includes(vm.health_status ?? "unknown")) {
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

    // Pending config is optional — the configure endpoint handles missing
    // pending records by falling back to subscription/VM defaults. This is
    // important because a previous partial configure attempt may have already
    // consumed (deleted) the pending record.

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
