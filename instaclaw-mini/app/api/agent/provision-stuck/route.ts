import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { supabase } from "@/lib/supabase";

/**
 * POST /api/agent/provision-stuck
 *
 * Fired when the provisioning-status component hits 180s timeout.
 * Sends an admin alert so paying users never go unnoticed.
 */
export async function POST() {
  try {
    const session = await requireSession();

    const { data: user } = await supabase()
      .from("instaclaw_users")
      .select("email")
      .eq("id", session.userId)
      .single();

    const { data: vm } = await supabase()
      .from("instaclaw_vms")
      .select("id, name, health_status, ip_address")
      .eq("assigned_to", session.userId)
      .eq("status", "assigned")
      .single();

    // Send admin email
    const adminEmail = process.env.ADMIN_ALERT_EMAIL;
    if (adminEmail) {
      const subject = `URGENT: Mini app user stuck in provisioning`;
      const body = [
        `User: ${user?.email || session.userId}`,
        `VM: ${vm?.name || "not assigned"}`,
        `Health: ${vm?.health_status || "unknown"}`,
        `IP: ${vm?.ip_address || "unknown"}`,
        `Time: ${new Date().toISOString()}`,
        "",
        "User has been waiting 3+ minutes after paying. Check immediately.",
      ].join("\n");

      // Use instaclaw.io API to send the alert (has email infrastructure)
      const apiUrl = process.env.INSTACLAW_API_URL || "https://instaclaw.io";
      await fetch(`${apiUrl}/api/admin/alert`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Mini-App-Token": process.env.MINI_APP_PROXY_SECRET || "",
        },
        body: JSON.stringify({ subject, body, channel: "provision-stuck" }),
      }).catch(() => {});
    }

    // Also try auto-retry configure as a self-healing attempt
    await fetch(`${process.env.INSTACLAW_API_URL || "https://instaclaw.io"}/api/vm/retry-configure`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Mini-App-Token": process.env.MINI_APP_PROXY_SECRET || "",
        "X-User-Id": session.userId,
      },
    }).catch(() => {});

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
