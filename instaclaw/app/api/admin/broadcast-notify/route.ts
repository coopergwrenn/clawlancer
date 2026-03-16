import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAdmin } from "@/lib/admin";
import { getSupabase } from "@/lib/supabase";
import { getResend, FROM, REPLY_TO, UNSUB_HEADERS, buildWaitlistOverHtml, buildWaitlistOverText } from "@/lib/email";
import { logger } from "@/lib/logger";

const BATCH_SIZE = 100; // Resend batch limit

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isAdmin(session?.user?.email)) {
    const apiKey = req.headers.get("x-api-key");
    if (apiKey !== process.env.ADMIN_API_KEY) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const body = await req.json().catch(() => ({}));
  const dryRun = body.dryRun === true;
  const sourceFilter = body.source as string | undefined; // optional: "waitlist", "active_user", "invite"

  const supabase = getSupabase();

  // Fetch all notification signups (optionally filtered by source)
  let query = supabase
    .from("instaclaw_notification_signups")
    .select("id, email, source")
    .order("created_at", { ascending: true });

  if (sourceFilter) {
    query = query.eq("source", sourceFilter);
  }

  const { data: entries, error } = await query;

  if (error) {
    logger.error("Failed to fetch notification signups", { error: error.message });
    return NextResponse.json({ error: "Failed to fetch recipients" }, { status: 500 });
  }

  if (!entries?.length) {
    return NextResponse.json({ sent: 0, message: "No recipients found." });
  }

  if (dryRun) {
    const bySource: Record<string, number> = {};
    for (const e of entries) {
      bySource[e.source] = (bySource[e.source] || 0) + 1;
    }
    return NextResponse.json({
      dryRun: true,
      wouldSend: entries.length,
      batches: Math.ceil(entries.length / BATCH_SIZE),
      bySource,
      sampleRecipients: entries.slice(0, 5).map((e) => e.email),
    });
  }

  const resend = getResend();
  const html = buildWaitlistOverHtml();
  const text = buildWaitlistOverText();
  let totalSent = 0;
  const failedEmails: string[] = [];

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);

    const payloads = batch.map((entry) => ({
      from: FROM,
      replyTo: REPLY_TO,
      to: entry.email,
      subject: "The waitlist is over. You're in.",
      html,
      text,
      headers: UNSUB_HEADERS,
    }));

    try {
      const { error: batchError } = await resend.batch.send(payloads);

      if (batchError) {
        logger.error("Broadcast batch error", {
          error: String(batchError),
          route: "admin/broadcast-notify",
          batchIndex: i / BATCH_SIZE,
        });
        failedEmails.push(...batch.map((e) => e.email));
        continue;
      }

      totalSent += batch.length;

      logger.info("Broadcast batch sent", {
        route: "admin/broadcast-notify",
        batchIndex: i / BATCH_SIZE,
        count: batch.length,
      });
    } catch (err) {
      logger.error("Broadcast batch failed", {
        error: String(err),
        route: "admin/broadcast-notify",
        batchIndex: i / BATCH_SIZE,
      });
      failedEmails.push(...batch.map((e) => e.email));
    }
  }

  return NextResponse.json({
    sent: totalSent,
    failed: failedEmails.length,
    total: entries.length,
    ...(failedEmails.length > 0 ? { failedEmails } : {}),
  });
}
