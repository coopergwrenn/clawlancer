import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { createSession } from "@/lib/auth";
import { getUserByWallet, getAgentStatus } from "@/lib/supabase";

/**
 * GET /api/auth/auto-login?wallet=0x...
 *
 * Wallet-based auto-login for returning World App users.
 * MiniKit.walletAddress is trusted (authenticated by World App WebView).
 * Rate limited: 5 requests per wallet per 60 seconds.
 */

// Simple in-memory rate limiter (resets on cold start, which is fine for Vercel)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(wallet: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(wallet);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(wallet, { count: 1, resetAt: now + 60000 });
    return true;
  }

  if (entry.count >= 5) {
    return false;
  }

  entry.count++;
  return true;
}

export async function GET(req: NextRequest) {
  try {
    const wallet = req.nextUrl.searchParams.get("wallet")?.trim().toLowerCase();

    if (!wallet || !wallet.startsWith("0x") || wallet.length < 42) {
      return NextResponse.json({ user: null }, { status: 400 });
    }

    // Rate limit: 5 requests per wallet per minute
    if (!checkRateLimit(wallet)) {
      return NextResponse.json(
        { user: null, error: "Too many requests" },
        { status: 429 }
      );
    }

    // Lookup user by wallet address
    const user = await getUserByWallet(wallet);
    if (!user) {
      return NextResponse.json({ user: null });
    }

    // Create session
    const token = await createSession({
      userId: user.id,
      walletAddress: wallet,
    });

    const cookieStore = await cookies();
    cookieStore.set("session", token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60,
      path: "/",
    });

    // Check if they have an agent
    let hasAgent = false;
    try {
      const agent = await getAgentStatus(user.id);
      hasAgent = !!agent;
    } catch { /* no agent */ }

    return NextResponse.json({
      user: {
        id: user.id,
        walletAddress: wallet,
        hasAgent,
        worldIdVerified: user.world_id_verified ?? false,
        hasEmail: !!user.email,
      },
    });
  } catch (err) {
    console.error("[Auto-login] Error:", err);
    return NextResponse.json({ user: null, error: "Auto-login failed" }, { status: 500 });
  }
}
