import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { OPENCLAW_PINNED_VERSION } from "@/lib/ssh";
import { sendAdminAlertEmail } from "@/lib/email";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const current = OPENCLAW_PINNED_VERSION;

    // Fetch latest version from npm registry
    const res = await fetch("https://registry.npmjs.org/openclaw/latest", {
      headers: { Accept: "application/json" },
      next: { revalidate: 0 },
    });
    if (!res.ok) {
      throw new Error(`npm registry returned ${res.status}`);
    }
    const pkg = await res.json();
    const latest = pkg.version as string;

    // No update available — short-circuit before DB query
    if (current === latest) {
      return NextResponse.json({
        current,
        latest,
        updateAvailable: false,
        notified: false,
      });
    }

    // Check if we already notified about this version
    const supabase = getSupabase();
    const { data: state } = await supabase
      .from("instaclaw_update_state")
      .select("last_notified_version")
      .eq("id", 1)
      .single();

    if (state?.last_notified_version === latest) {
      return NextResponse.json({
        current,
        latest,
        updateAvailable: true,
        notified: false,
        reason: "already_notified",
      });
    }

    // Send email notification
    await sendAdminAlertEmail(
      `OpenClaw Update Available: ${latest}`,
      `A new OpenClaw version is available.\n\n` +
        `Current pinned version: ${current}\n` +
        `Latest npm version: ${latest}\n\n` +
        `Deploy it from the fleet upgrade page:\n` +
        `https://instaclaw.io/hq/fleet-upgrade`
    );

    // Record that we notified about this version
    await supabase
      .from("instaclaw_update_state")
      .update({
        last_notified_version: latest,
        notified_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", 1);

    logger.info("OpenClaw update notification sent", {
      route: "cron/openclaw-update-check",
      current,
      latest,
    });

    return NextResponse.json({
      current,
      latest,
      updateAvailable: true,
      notified: true,
    });
  } catch (err) {
    logger.error("OpenClaw update check failed", {
      route: "cron/openclaw-update-check",
      error: String(err),
    });
    return NextResponse.json(
      { error: `Update check failed: ${String(err)}` },
      { status: 500 }
    );
  }
}
