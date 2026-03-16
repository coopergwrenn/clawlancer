import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { encryptApiKey } from "@/lib/security";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const GRAPH_API_VERSION = "v21.0";

/**
 * GET /api/auth/instagram/callback
 * Handles the OAuth callback from Instagram Login.
 *
 * Flow:
 * 1. Exchange authorization code for short-lived token
 * 2. Exchange short-lived token for long-lived token (~60 days)
 * 3. Fetch Instagram user profile (id, username)
 * 4. Store encrypted token + account info in Supabase
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(
      new URL("/settings?ig_error=unauthorized", req.url)
    );
  }

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const error = req.nextUrl.searchParams.get("error");

  if (error) {
    logger.warn("Instagram OAuth denied", {
      route: "auth/instagram/callback",
      userId: session.user.id,
      error,
      errorReason: req.nextUrl.searchParams.get("error_reason"),
    });
    return NextResponse.redirect(
      new URL("/settings?ig_error=denied", req.url)
    );
  }

  if (!code) {
    return NextResponse.redirect(
      new URL("/settings?ig_error=no_code", req.url)
    );
  }

  // CSRF check — state must match current user
  if (state !== session.user.id) {
    return NextResponse.redirect(
      new URL("/settings?ig_error=state_mismatch", req.url)
    );
  }

  const clientId = process.env.META_APP_ID!;
  const clientSecret = process.env.META_APP_SECRET!;
  const redirectUri = process.env.NEXT_PUBLIC_APP_URL
    ? `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/instagram/callback`
    : "https://instaclaw.io/api/auth/instagram/callback";

  try {
    // Step 1: Exchange code for short-lived token
    const tokenRes = await fetch(
      "https://api.instagram.com/oauth/access_token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
          code,
        }),
      }
    );

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      logger.error("Instagram token exchange failed", {
        route: "auth/instagram/callback",
        userId: session.user.id,
        response: JSON.stringify(tokenData).slice(0, 500),
      });
      return NextResponse.redirect(
        new URL("/settings?ig_error=token_exchange", req.url)
      );
    }

    const shortLivedToken = tokenData.access_token;
    const igUserId = String(tokenData.user_id);

    // Step 2: Exchange for long-lived token (~60 days)
    const longLivedRes = await fetch(
      `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${clientSecret}&access_token=${shortLivedToken}`
    );
    const longLivedData = await longLivedRes.json();

    if (!longLivedData.access_token) {
      logger.error("Instagram long-lived token exchange failed", {
        route: "auth/instagram/callback",
        userId: session.user.id,
        response: JSON.stringify(longLivedData).slice(0, 500),
      });
      return NextResponse.redirect(
        new URL("/settings?ig_error=long_lived_token", req.url)
      );
    }

    const longLivedToken = longLivedData.access_token;
    const expiresIn = longLivedData.expires_in ?? 5184000; // default 60 days
    const tokenExpiresAt = new Date(
      Date.now() + expiresIn * 1000
    ).toISOString();

    // Step 3: Fetch user profile
    const profileRes = await fetch(
      `https://graph.instagram.com/${GRAPH_API_VERSION}/me?fields=user_id,username&access_token=${longLivedToken}`
    );
    const profileData = await profileRes.json();
    const username = profileData.username ?? null;

    // Step 4: Encrypt token and store in Supabase
    const encryptedToken = await encryptApiKey(longLivedToken);
    const supabase = getSupabase();

    const { error: upsertError } = await supabase
      .from("instaclaw_instagram_integrations")
      .upsert(
        {
          user_id: session.user.id,
          instagram_user_id: igUserId,
          instagram_username: username,
          access_token: encryptedToken,
          token_expires_at: tokenExpiresAt,
          scopes: [
            "instagram_business_basic",
            "instagram_business_manage_messages",
            "instagram_business_manage_comments",
          ],
          status: "active",
          connected_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );

    if (upsertError) {
      logger.error("Instagram integration save failed", {
        route: "auth/instagram/callback",
        userId: session.user.id,
        error: upsertError.message,
      });
      return NextResponse.redirect(
        new URL("/settings?ig_error=save_failed", req.url)
      );
    }

    // Mark the skill as connected in instaclaw_vm_skills
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id")
      .eq("assigned_to", session.user.id)
      .single();

    if (vm) {
      const { data: skill } = await supabase
        .from("instaclaw_skills")
        .select("id")
        .eq("slug", "instagram-automation")
        .single();

      if (skill) {
        await supabase
          .from("instaclaw_vm_skills")
          .upsert(
            {
              vm_id: vm.id,
              skill_id: skill.id,
              enabled: true,
              connected: true,
              connected_account: username ? `@${username}` : igUserId,
            },
            { onConflict: "vm_id,skill_id" }
          );
      }
    }

    logger.info("Instagram connected", {
      route: "auth/instagram/callback",
      userId: session.user.id,
      igUserId,
      username,
    });

    return NextResponse.redirect(
      new URL("/settings?ig_connected=true", req.url)
    );
  } catch (err) {
    logger.error("Instagram OAuth callback error", {
      route: "auth/instagram/callback",
      userId: session.user.id,
      error: String(err),
    });
    return NextResponse.redirect(
      new URL("/settings?ig_error=unknown", req.url)
    );
  }
}
