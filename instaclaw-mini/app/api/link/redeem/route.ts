import { NextRequest, NextResponse } from "next/server";
import { requireSession, createSession } from "@/lib/auth";
import { redeemLinkingCode } from "@/lib/supabase";
import { cookies } from "next/headers";

/**
 * POST /api/link/redeem — Redeem a linking code from instaclaw.io
 * Body: { code: string }
 * Links the current World wallet to the instaclaw.io account that generated the code.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    const { code } = await req.json();

    if (!code || typeof code !== "string") {
      return NextResponse.json({ error: "Code required" }, { status: 400 });
    }

    const result = await redeemLinkingCode(code, session.walletAddress);

    if (!result.success) {
      return NextResponse.json(
        { error: result.error },
        { status: 400 }
      );
    }

    // Re-issue session with the linked account's userId
    if (result.userId && result.userId !== session.userId) {
      const token = await createSession({
        userId: result.userId,
        walletAddress: session.walletAddress,
      });
      const cookieStore = await cookies();
      cookieStore.set("session", token, {
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        maxAge: 7 * 24 * 60 * 60,
        path: "/",
      });
    }

    return NextResponse.json({
      success: true,
      linked: true,
      userId: result.userId,
    });
  } catch (err) {
    console.error("Link redeem error:", err);
    return NextResponse.json(
      { error: "Failed to redeem code" },
      { status: 500 }
    );
  }
}
