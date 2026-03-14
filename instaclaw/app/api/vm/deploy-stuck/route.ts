import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { sendHealthAlertEmail } from "@/lib/email";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

// Rate limit: 1 alert per user per hour (in-memory, resets on deploy)
const rateLimitMap = new Map<string, number>();
const RATE_LIMIT_MS = 60 * 60 * 1000; // 1 hour

export async function POST() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userId = session.user.id;

    // Rate limit check
    const lastFired = rateLimitMap.get(userId);
    if (lastFired && Date.now() - lastFired < RATE_LIMIT_MS) {
      return NextResponse.json({ ok: true, throttled: true });
    }
    rateLimitMap.set(userId, Date.now());

    const supabase = getSupabase();

    // Look up user's VM
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, name, ip_address, health_status, assigned_to")
      .eq("assigned_to", userId)
      .not("status", "in", '("failed","destroyed","terminated")')
      .limit(1)
      .single();

    // Look up user email
    const { data: user } = await supabase
      .from("instaclaw_users")
      .select("email")
      .eq("id", userId)
      .single();

    const vmName = vm?.name ?? vm?.id ?? "unknown";
    const vmIp = vm?.ip_address ?? "unknown";
    const vmHealth = vm?.health_status ?? "unknown";
    const userEmail = user?.email ?? "unknown";

    logger.error("Deploy stuck alert fired", {
      route: "api/vm/deploy-stuck",
      userId,
      vmId: vm?.id,
      vmName,
      vmIp,
      vmHealth,
      userEmail,
    });

    // Send admin alert
    const adminEmail = process.env.ADMIN_ALERT_EMAIL;
    if (adminEmail) {
      try {
        await sendHealthAlertEmail(
          adminEmail,
          `DEPLOY STUCK: ${vmName} (IP: ${vmIp}, health: ${vmHealth}, user: ${userEmail})`
        );
      } catch (emailErr) {
        logger.error("Failed to send deploy-stuck admin alert", {
          error: String(emailErr),
          route: "api/vm/deploy-stuck",
        });
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error("deploy-stuck endpoint error", {
      error: String(err),
      route: "api/vm/deploy-stuck",
    });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
