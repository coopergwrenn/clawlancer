import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/instagram
 * Initiates the Instagram OAuth flow by redirecting to Meta's consent screen.
 * Uses Instagram Login (not Facebook Login) with the new mandatory scopes.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clientId = process.env.INSTAGRAM_APP_ID;
  const redirectUri = process.env.NEXT_PUBLIC_APP_URL
    ? `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/instagram/callback`
    : "https://instaclaw.io/api/auth/instagram/callback";

  if (!clientId) {
    return NextResponse.json(
      { error: "INSTAGRAM_APP_ID not configured" },
      { status: 500 }
    );
  }

  const scopes = [
    "instagram_business_basic",
    "instagram_business_manage_messages",
    "instagram_business_manage_comments",
  ].join(",");

  // "Instagram API with Instagram Login" flow — standalone Instagram OAuth
  // Uses api.instagram.com (NOT www.instagram.com which is Business Login via Facebook)
  const authUrl = new URL("https://api.instagram.com/oauth/authorize");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scopes);
  authUrl.searchParams.set("state", session.user.id);

  return NextResponse.redirect(authUrl.toString());
}
