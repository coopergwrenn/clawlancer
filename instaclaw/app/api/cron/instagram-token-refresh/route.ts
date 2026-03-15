import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { encryptApiKey, decryptApiKey } from "@/lib/security";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/cron/instagram-token-refresh
 * Refreshes Instagram long-lived tokens that expire within 7 days.
 * Long-lived tokens last ~60 days. Refresh endpoint returns a new token
 * with a fresh 60-day validity.
 *
 * Only tokens that are between 1 day and 90 days old can be refreshed.
 * Tokens that have already expired cannot be refreshed.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();

  // Find tokens expiring within 7 days that are still active
  const sevenDaysFromNow = new Date(
    Date.now() + 7 * 24 * 60 * 60 * 1000
  ).toISOString();

  const { data: integrations } = await supabase
    .from("instaclaw_instagram_integrations")
    .select("id, user_id, access_token, token_expires_at, instagram_username")
    .eq("status", "active")
    .lt("token_expires_at", sevenDaysFromNow)
    .gt("token_expires_at", new Date().toISOString());

  if (!integrations?.length) {
    return NextResponse.json({ refreshed: 0, total: 0 });
  }

  let refreshed = 0;
  let failed = 0;

  for (const integration of integrations) {
    try {
      const currentToken = await decryptApiKey(integration.access_token);

      const res = await fetch(
        `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${currentToken}`
      );
      const data = await res.json();

      if (!data.access_token) {
        logger.error("Instagram token refresh failed", {
          route: "cron/instagram-token-refresh",
          userId: integration.user_id,
          username: integration.instagram_username,
          response: JSON.stringify(data).slice(0, 300),
        });
        failed++;

        // If token is actually expired, mark as expired
        if (data.error?.code === 190) {
          await supabase
            .from("instaclaw_instagram_integrations")
            .update({ status: "token_expired" })
            .eq("id", integration.id);
        }
        continue;
      }

      const newExpiresAt = new Date(
        Date.now() + (data.expires_in ?? 5184000) * 1000
      ).toISOString();

      const encryptedToken = await encryptApiKey(data.access_token);

      await supabase
        .from("instaclaw_instagram_integrations")
        .update({
          access_token: encryptedToken,
          token_expires_at: newExpiresAt,
        })
        .eq("id", integration.id);

      refreshed++;

      logger.info("Instagram token refreshed", {
        route: "cron/instagram-token-refresh",
        userId: integration.user_id,
        username: integration.instagram_username,
        newExpiresAt,
      });
    } catch (err) {
      failed++;
      logger.error("Instagram token refresh error", {
        route: "cron/instagram-token-refresh",
        userId: integration.user_id,
        error: String(err),
      });
    }
  }

  // Clean up rate limit records older than 24 hours
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await supabase
    .from("instaclaw_instagram_rate_limits")
    .delete()
    .lt("hour_bucket", oneDayAgo);

  return NextResponse.json({
    refreshed,
    failed,
    total: integrations.length,
  });
}
