import { NextRequest, NextResponse } from "next/server";

// Prevent Vercel CDN from caching per-user responses
export const dynamic = "force-dynamic";

/**
 * Legacy redirect: Gmail OAuth callback moved to /api/gmail/callback.
 * This route preserves backwards compatibility with any existing
 * Google Cloud Console redirect URIs.
 */
export async function GET(req: NextRequest) {
  const { search } = new URL(req.url);
  return NextResponse.redirect(
    new URL(`/api/gmail/callback${search}`, req.url)
  );
}
