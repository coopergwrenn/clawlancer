import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

// Prevent Vercel CDN from caching per-user responses
export const dynamic = "force-dynamic";

const GMAIL_TOKEN_COOKIE = "ic_gmail_token";
const GMAIL_STATE_COOKIE = "ic_gmail_state";
const TOKEN_MAX_AGE_SECONDS = 300;

/**
 * GET /api/gmail/callback
 *
 * Handles the OAuth callback after the user grants gmail.readonly scope
 * from the dashboard popup. Exchanges the authorization code for tokens,
 * stores them in the database for future use, sets a short-lived httpOnly
 * cookie for the immediate insights fetch, and redirects to the dashboard.
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(new URL("/signin", req.url));
  }

  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");
  const state = searchParams.get("state");

  // ── CSRF validation ───────────────────────────────────────────────
  const stateCookie = req.cookies.get(GMAIL_STATE_COOKIE)?.value;
  if (!state || !stateCookie || state !== stateCookie) {
    logger.error("Gmail OAuth CSRF mismatch", {
      hasState: !!state,
      hasCookie: !!stateCookie,
      userId: session.user.id,
      route: "gmail/callback",
    });
    const res = NextResponse.redirect(
      new URL("/dashboard?gmail_error=csrf", req.url)
    );
    res.cookies.set(GMAIL_STATE_COOKIE, "", { maxAge: 0, path: "/" });
    return res;
  }

  // User denied the permission
  if (error) {
    logger.warn("Gmail OAuth denied", {
      error,
      userId: session.user.id,
      route: "gmail/callback",
    });
    const res = NextResponse.redirect(new URL("/dashboard", req.url));
    res.cookies.set(GMAIL_STATE_COOKIE, "", { maxAge: 0, path: "/" });
    return res;
  }

  if (!code) {
    logger.error("Gmail OAuth callback missing code", {
      userId: session.user.id,
      route: "gmail/callback",
    });
    const res = NextResponse.redirect(new URL("/dashboard", req.url));
    res.cookies.set(GMAIL_STATE_COOKIE, "", { maxAge: 0, path: "/" });
    return res;
  }

  try {
    // Exchange authorization code for tokens
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: `${process.env.NEXTAUTH_URL}/api/gmail/callback`,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      logger.error("Gmail token exchange failed", {
        status: tokenRes.status,
        body: errBody,
        route: "gmail/callback",
      });
      const res = NextResponse.redirect(
        new URL("/dashboard?gmail_error=token_exchange", req.url)
      );
      res.cookies.set(GMAIL_STATE_COOKIE, "", { maxAge: 0, path: "/" });
      return res;
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token;

    if (!accessToken) {
      logger.error("Gmail token exchange returned no access_token", {
        route: "gmail/callback",
      });
      const res = NextResponse.redirect(
        new URL("/dashboard?gmail_error=no_token", req.url)
      );
      res.cookies.set(GMAIL_STATE_COOKIE, "", { maxAge: 0, path: "/" });
      return res;
    }

    // Store tokens in database for future use
    const supabase = getSupabase();
    const { error: dbError } = await supabase
      .from("instaclaw_users")
      .update({
        gmail_access_token: accessToken,
        gmail_refresh_token: refreshToken || null,
        gmail_connected_at: new Date().toISOString(),
      })
      .eq("id", session.user.id);

    if (dbError) {
      logger.error("Failed to store Gmail tokens", {
        error: String(dbError),
        userId: session.user.id,
        route: "gmail/callback",
      });
      // Non-fatal: continue with cookie-based flow
    }

    // Store access token in httpOnly cookie for immediate insights fetch
    const res = NextResponse.redirect(
      new URL("/dashboard?gmail_ready=1", req.url)
    );
    res.cookies.set(GMAIL_TOKEN_COOKIE, accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: TOKEN_MAX_AGE_SECONDS,
      path: "/",
    });
    res.cookies.set(GMAIL_STATE_COOKIE, "", { maxAge: 0, path: "/" });
    return res;
  } catch (err) {
    logger.error("Gmail callback error", {
      error: String(err),
      route: "gmail/callback",
    });
    const res = NextResponse.redirect(
      new URL("/dashboard?gmail_error=callback_failed", req.url)
    );
    res.cookies.set(GMAIL_STATE_COOKIE, "", { maxAge: 0, path: "/" });
    return res;
  }
}
