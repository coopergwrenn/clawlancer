import { NextRequest, NextResponse } from "next/server";

/**
 * Stores the validated invite code in an HttpOnly server-set cookie.
 * Called from the signup page right before the Google OAuth redirect.
 * Server-set cookies survive OAuth redirects more reliably than
 * client-side document.cookie.
 */
export async function POST(req: NextRequest) {
  const { code, referralCode } = await req.json();

  if (!code || typeof code !== "string") {
    return NextResponse.json({ error: "Missing code" }, { status: 400 });
  }

  const normalized = code.trim().toUpperCase();
  const res = NextResponse.json({ ok: true });

  res.cookies.set("instaclaw_invite_code", normalized, {
    path: "/",
    maxAge: 3600,
    sameSite: "lax",
    secure: true,
    httpOnly: true,
  });

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
