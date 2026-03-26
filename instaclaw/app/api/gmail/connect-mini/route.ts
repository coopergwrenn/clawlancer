import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const MINI_USER_COOKIE = "ic_gmail_mini_user";

/**
 * GET /api/gmail/connect-mini?token=xxx
 *
 * Bridge endpoint for World Mini App users to connect Gmail.
 * Validates the mini-app proxy token, stores the userId in a cookie,
 * then redirects to Google OAuth consent screen.
 *
 * This runs in the system browser (not the WebView) because Google
 * blocks OAuth in embedded WebViews.
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token) {
    return new NextResponse("Missing token", { status: 400 });
  }

  // Validate the mini-app proxy token
  const { validateMiniAppToken } = await import("@/lib/security");

  // Create a fake request with the token as a header for validation
  const fakeHeaders = new Headers();
  fakeHeaders.set("x-mini-app-token", token);
  const fakeReq = new NextRequest(req.url, { headers: fakeHeaders });
  const userId = await validateMiniAppToken(fakeReq);

  if (!userId) {
    logger.error("Gmail connect-mini: invalid token", { route: "gmail/connect-mini" });
    return new NextResponse(
      `<html><body style="font-family:system-ui;text-align:center;padding:4rem">
        <h2>Link expired</h2>
        <p>Go back to World App and try again.</p>
      </body></html>`,
      { status: 401, headers: { "Content-Type": "text/html" } }
    );
  }

  // Generate CSRF state
  const state = crypto.randomUUID();

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: `${process.env.NEXTAUTH_URL}/api/gmail/callback`,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state,
  });

  const res = NextResponse.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
  );

  // Store userId in cookie so the callback knows who this is
  res.cookies.set(MINI_USER_COOKIE, userId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600, // 10 minutes — enough for OAuth flow
    path: "/",
  });

  // Store CSRF state
  res.cookies.set("ic_gmail_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });

  logger.info("Gmail OAuth initiated from mini app", {
    userId,
    route: "gmail/connect-mini",
  });

  return res;
}
