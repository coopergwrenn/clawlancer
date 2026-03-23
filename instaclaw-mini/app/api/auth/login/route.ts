import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { verifySiweMessage, MiniKit } from "@worldcoin/minikit-js";
import { createSession } from "@/lib/auth";
import {
  getUserByWallet,
  getUserByEmail,
  createWorldUser,
  linkWalletToUser,
} from "@/lib/supabase";

export async function POST(req: NextRequest) {
  try {
    const payload = await req.json();
    const cookieStore = await cookies();

    // Validate nonce
    const storedNonce = cookieStore.get("siwe-nonce")?.value;
    if (!storedNonce) {
      return NextResponse.json(
        { error: "No nonce found. Please try again." },
        { status: 400 }
      );
    }

    // Verify SIWE message
    const result = await verifySiweMessage(payload, storedNonce);
    if (!result.isValid) {
      return NextResponse.json(
        { error: "Invalid signature" },
        { status: 401 }
      );
    }

    // Clear nonce (single-use)
    cookieStore.delete("siwe-nonce");

    const walletAddress = payload.address as string;

    // ── Multi-lookup: prevent duplicate accounts ──
    // Priority: wallet address → email → create new
    let user = await getUserByWallet(walletAddress);
    let linked = false;

    if (!user) {
      // Try email match — World App may provide email via payload or MiniKit.user
      const email = payload.email as string | undefined;
      if (email) {
        user = await getUserByEmail(email);
        if (user) {
          // Found by email — link wallet to existing Google-auth account
          await linkWalletToUser(user.id, walletAddress);
          linked = true;
        }
      }
    }

    if (!user) {
      // No match found — create new user
      user = await createWorldUser(walletAddress);
    }

    // Create session
    const token = await createSession({
      userId: user.id,
      walletAddress,
    });

    cookieStore.set("session", token, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60, // 7 days
      path: "/",
    });

    return NextResponse.json({
      user: { id: user.id },
      linked,
    });
  } catch (err) {
    console.error("Login error:", err);
    return NextResponse.json(
      { error: "Login failed" },
      { status: 500 }
    );
  }
}
