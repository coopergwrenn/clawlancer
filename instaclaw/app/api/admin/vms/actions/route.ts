import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAdmin } from "@/lib/admin";
import { getSupabase } from "@/lib/supabase";
import { resetAgentMemory, restartGateway } from "@/lib/ssh";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isAdmin(session?.user?.email)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { action, vmId, userId } = await req.json();
  const supabase = getSupabase();

  switch (action) {
    case "destroy": {
      // Delete VM record (Hetzner deletion is separate)
      await supabase.from("instaclaw_vms").delete().eq("id", vmId);
      return NextResponse.json({ success: true });
    }

    case "reclaim": {
      // Unassign VM from user
      await supabase
        .from("instaclaw_vms")
        .update({
          assigned_to: null,
          status: "ready",
          gateway_url: null,
          control_ui_url: null,
          telegram_bot_username: null,
          health_status: "unknown",
        })
        .eq("id", vmId);
      return NextResponse.json({ success: true });
    }

    case "reconfigure": {
      // Trigger reconfigure for the VM
      const { data: vm } = await supabase
        .from("instaclaw_vms")
        .select("assigned_to")
        .eq("id", vmId)
        .single();

      if (!vm?.assigned_to) {
        return NextResponse.json(
          { error: "VM not assigned" },
          { status: 400 }
        );
      }

      const configRes = await fetch(
        `${process.env.NEXTAUTH_URL}/api/vm/configure`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Admin-Key": process.env.ADMIN_API_KEY ?? "",
          },
          body: JSON.stringify({ userId: vm.assigned_to }),
        }
      );

      return NextResponse.json({ success: configRes.ok });
    }

    case "reset_agent": {
      // Clear corrupted session files + restart gateway
      const { data: resetVm } = await supabase
        .from("instaclaw_vms")
        .select("*")
        .eq("id", vmId)
        .single();

      if (!resetVm) {
        return NextResponse.json({ error: "VM not found" }, { status: 404 });
      }

      const resetResult = await resetAgentMemory(resetVm);

      if (resetResult.success) {
        await supabase
          .from("instaclaw_vms")
          .update({
            status: "assigned",
            health_status: "unknown",
            last_health_check: new Date().toISOString(),
          })
          .eq("id", vmId);
      }

      return NextResponse.json(resetResult);
    }

    case "restart_gateway": {
      // Just restart the gateway (clears in-memory state)
      const { data: restartVm } = await supabase
        .from("instaclaw_vms")
        .select("*")
        .eq("id", vmId)
        .single();

      if (!restartVm) {
        return NextResponse.json({ error: "VM not found" }, { status: 404 });
      }

      const restarted = await restartGateway(restartVm);

      if (restarted) {
        await supabase
          .from("instaclaw_vms")
          .update({
            status: "assigned",
            health_status: "unknown",
            last_health_check: new Date().toISOString(),
          })
          .eq("id", vmId);
      }

      return NextResponse.json({ success: restarted });
    }

    case "cancel_subscription": {
      if (!userId)
        return NextResponse.json(
          { error: "userId required" },
          { status: 400 }
        );

      const { data: sub } = await supabase
        .from("instaclaw_subscriptions")
        .select("stripe_subscription_id")
        .eq("user_id", userId)
        .single();

      if (sub?.stripe_subscription_id) {
        const { getStripe } = await import("@/lib/stripe");
        const stripe = getStripe();
        await stripe.subscriptions.cancel(sub.stripe_subscription_id);
      }

      return NextResponse.json({ success: true });
    }

    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
}
