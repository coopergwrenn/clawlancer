import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAdmin } from "@/lib/admin";
import { getSupabase } from "@/lib/supabase";
import { sendWaitlistUpdateEmail, getResend } from "@/lib/email";
import { logger } from "@/lib/logger";

const BATCH_SIZE = 100; // Resend batch limit

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isAdmin(session?.user?.email)) {
    // Also allow admin API key for cURL/script usage
    const apiKey = req.headers.get("x-api-key");
    if (apiKey !== process.env.ADMIN_API_KEY) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const body = await req.json().catch(() => ({}));
  const scheduledAt = body.scheduledAt as string | undefined; // ISO 8601
  const dryRun = body.dryRun === true;

  const supabase = getSupabase();

  // Fetch all waitlist emails that haven't been notified yet
  const { data: entries, error } = await supabase
    .from("instaclaw_waitlist")
    .select("id, email")
    .is("notified_at", null)
    .order("position", { ascending: true });

  if (error) {
    logger.error("Failed to fetch waitlist", { error: error.message, route: "admin/broadcast-waitlist" });
    return NextResponse.json({ error: "Failed to fetch waitlist" }, { status: 500 });
  }

  if (!entries?.length) {
    return NextResponse.json({ sent: 0, message: "No un-notified waitlist entries." });
  }

  if (dryRun) {
    return NextResponse.json({
      dryRun: true,
      wouldSend: entries.length,
      batches: Math.ceil(entries.length / BATCH_SIZE),
      scheduledAt: scheduledAt ?? "immediate",
    });
  }

  const resend = getResend();
  let totalSent = 0;
  const failedEmails: string[] = [];

  // Send in batches of 100
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);

    const emailPayloads = await Promise.all(
      batch.map((entry) => sendWaitlistUpdateEmail(entry.email))
    );

    // Add scheduledAt if provided
    const payloadsWithSchedule = emailPayloads.map((payload) => ({
      ...payload,
      ...(scheduledAt ? { scheduledAt } : {}),
    }));

    try {
      const { data, error: batchError } = await resend.batch.send(payloadsWithSchedule);

      if (batchError) {
        logger.error("Batch send error", {
          error: String(batchError),
          route: "admin/broadcast-waitlist",
          batchIndex: i / BATCH_SIZE,
        });
        failedEmails.push(...batch.map((e) => e.email));
        continue;
      }

      // Mark as notified
      const ids = batch.map((e) => e.id);
      await supabase
        .from("instaclaw_waitlist")
        .update({ notified_at: new Date().toISOString() })
        .in("id", ids);

      totalSent += batch.length;

      logger.info("Broadcast batch sent", {
        route: "admin/broadcast-waitlist",
        batchIndex: i / BATCH_SIZE,
        count: batch.length,
        scheduled: scheduledAt ?? "immediate",
      });
    } catch (err) {
      logger.error("Broadcast batch failed", {
        error: String(err),
        route: "admin/broadcast-waitlist",
        batchIndex: i / BATCH_SIZE,
      });
      failedEmails.push(...batch.map((e) => e.email));
    }
  }

  return NextResponse.json({
    sent: totalSent,
    failed: failedEmails.length,
    total: entries.length,
    scheduledAt: scheduledAt ?? "immediate",
    ...(failedEmails.length > 0 ? { failedEmails } : {}),
  });
}
