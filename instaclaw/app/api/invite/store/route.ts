import { NextRequest, NextResponse } from "next/server";

/**
 * Stores the referral code in an HttpOnly server-set cookie.
 * Called from the signup page right before the Google OAuth redirect.
 * Server-set cookies survive OAuth redirects more reliably than
 * client-side document.cookie.
 */
export async function POST(req: NextRequest) {
  const { referralCode } = await req.json();

  const res = NextResponse.json({ ok: true });

  // Store ambassador referral code if provided (survives OAuth redirect)
  if (referralCode && typeof referralCode === "string") {
    res.cookies.set("instaclaw_referral_code", referralCode.trim().toLowerCase(), {
      path: "/",
      maxAge: 3600,
      sameSite: "lax",
      secure: true,
      httpOnly: true,
    });
  }

  return res;
}
