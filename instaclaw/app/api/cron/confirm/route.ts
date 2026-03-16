import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { verifyConfirmToken } from "@/lib/cron-guard";
import { logger } from "@/lib/logger";

const CONFIRM_SECRET = process.env.CRON_CONFIRM_SECRET || process.env.CRON_SECRET || "cron-guard-default-secret";

/**
 * GET /api/cron/confirm?vm=X&job=Y&token=Z
 *
 * Clickable confirmation link sent in Telegram suppression messages.
 * When the user taps the link, this endpoint:
 *   1. Verifies the HMAC token
 *   2. Marks the job as confirmed in instaclaw_cron_guard
 *   3. The VM-side cron-guard.py picks up the confirmation on its next cycle
 *      and re-enables the job in jobs.json
 *
 * Returns a simple HTML page confirming the action.
 */
export async function GET(req: NextRequest) {
  const vmId = req.nextUrl.searchParams.get("vm");
  const jobName = req.nextUrl.searchParams.get("job");
  const token = req.nextUrl.searchParams.get("token");

  if (!vmId || !jobName || !token) {
    return htmlResponse(
      "Missing Parameters",
      "This confirmation link is incomplete. Please use the link from your Telegram message.",
      400,
    );
  }

  // Verify HMAC token
  if (!verifyConfirmToken(vmId, jobName, token, CONFIRM_SECRET)) {
    return htmlResponse(
      "Invalid Link",
      "This confirmation link is invalid or expired. Please request a new one.",
      403,
    );
  }

  const supabase = getSupabase();

  // Check that the guard row exists and is suppressed
  const { data: guardRow, error: fetchErr } = await supabase
    .from("instaclaw_cron_guard")
    .select("id, suppressed, confirmed")
    .eq("vm_id", vmId)
    .eq("job_name", jobName)
    .maybeSingle();

  if (fetchErr || !guardRow) {
    logger.warn("Cron confirm: guard row not found", {
      route: "cron/confirm",
      vmId,
      jobName,
      error: fetchErr?.message,
    });
    return htmlResponse(
      "Job Not Found",
      `The cron job "${jobName}" was not found. It may have been removed or already confirmed.`,
      404,
    );
  }

  if (guardRow.confirmed) {
    return htmlResponse(
      "Already Confirmed",
      `The cron job "${jobName}" is already confirmed and running. No action needed.`,
      200,
    );
  }

  // Mark as confirmed
  const { error: updateErr } = await supabase
    .from("instaclaw_cron_guard")
    .update({
      confirmed: true,
      suppressed: false,
      confirmed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", guardRow.id);

  if (updateErr) {
    logger.error("Cron confirm: failed to update guard row", {
      route: "cron/confirm",
      vmId,
      jobName,
      error: updateErr.message,
    });
    return htmlResponse(
      "Error",
      "Something went wrong. Please try again or contact support.",
      500,
    );
  }

  logger.info("Cron job confirmed via link", {
    route: "cron/confirm",
    vmId,
    jobName,
  });

  return htmlResponse(
    "Cron Job Enabled!",
    `Your cron job "${jobName}" has been confirmed and will be re-enabled on the next guard cycle (within 60 seconds).\n\nYou can close this page.`,
    200,
  );
}

function htmlResponse(title: string, message: string, status: number) {
  const isSuccess = status === 200;
  const emoji = isSuccess ? "&#9989;" : status === 400 || status === 403 ? "&#10060;" : "&#9888;&#65039;";
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — InstaClaw</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; background: #0a0a0a; color: #e5e5e5; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 16px; }
    .card { background: #1a1a1a; border-radius: 12px; padding: 32px; max-width: 420px; text-align: center; border: 1px solid #333; }
    .emoji { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 20px; margin: 0 0 12px; }
    p { color: #999; line-height: 1.6; margin: 0; white-space: pre-line; }
    .badge { display: inline-block; margin-top: 20px; padding: 6px 16px; background: #222; border-radius: 20px; font-size: 12px; color: #666; }
  </style>
</head>
<body>
  <div class="card">
    <div class="emoji">${emoji}</div>
    <h1>${title}</h1>
    <p>${message}</p>
    <div class="badge">instaclaw.io</div>
  </div>
</body>
</html>`;
  return new NextResponse(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
