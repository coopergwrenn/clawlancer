import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { getUserVm } from "@/lib/get-user-vm";
import { logger } from "@/lib/logger";

const MAX_CONFIGURE_ATTEMPTS = 3;

export async function POST() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();

    // Get user's VM. Terminal rows are excluded — retry on a destroyed
    // Linode would just burn through MAX_CONFIGURE_ATTEMPTS for nothing.
    const vm = await getUserVm<{
      id: string;
      health_status: string | null;
      configure_attempts: number | null;
      gateway_url: string | null;
      created_via: string | null;
    }>(supabase, session.user.id, {
      columns: "id, health_status, configure_attempts, gateway_url, created_via",
    });

    if (!vm) {
      return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
    }

    // ── Cloud-init guard (2026-05-16) ──
    // Cloud-init VMs (created_via='on_demand') handle configure ON-VM via
    // setup.sh, which runs T+2-8min after Linode boot and fires the
    // /api/vm/cloud-init-callback endpoint when done. Invoking the
    // pool-path /api/vm/configure here would SSH to the VM and clobber
    // setup.sh's in-progress writes (~/.openclaw/openclaw.json, .env,
    // restart gateway). The deploying page's auto-retry at T+60s would
    // otherwise trigger this race on every cloud-init signup.
    //
    // Return 200 with retried:false so the caller (page or operator)
    // understands the retry was deliberately skipped, not a 4xx error.
    if (vm.created_via === "on_demand") {
      logger.info("retry-configure: skipped (cloud-init VM — configure runs on-VM via setup.sh)", {
        route: "vm/retry-configure",
        vmId: vm.id,
        userId: session.user.id,
      });
      return NextResponse.json({
        retried: false,
        reason: "cloud-init-on-vm",
        message: "Cloud-init VMs configure on-VM via setup.sh; retry is not applicable.",
      });
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
