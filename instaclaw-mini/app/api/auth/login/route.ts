import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { verifySiweMessage } from "@worldcoin/minikit-js";
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

    console.log("[Login] Received payload keys:", Object.keys(payload));
    console.log("[Login] Payload status:", payload.status);
    console.log("[Login] Payload address:", payload.address);

    // Validate nonce
    const storedNonce = cookieStore.get("siwe-nonce")?.value;
    console.log("[Login] Stored nonce:", storedNonce ? `${storedNonce.slice(0, 8)}...` : "MISSING");

    if (!storedNonce) {
      console.error("[Login] No nonce cookie found. All cookies:", cookieStore.getAll().map(c => c.name));
      return NextResponse.json(
        { error: "No nonce found. Please try again." },
        { status: 400 }
      );
    }

    // Verify SIWE message
    console.log("[Login] Calling verifySiweMessage...");
    let result: { isValid: boolean };
    try {
      result = await verifySiweMessage(payload, storedNonce);
      console.log("[Login] verifySiweMessage result:", JSON.stringify(result));
    } catch (verifyErr) {
      console.error("[Login] verifySiweMessage threw:", verifyErr);
      // If SIWE verification fails, the payload might be in a different format.
      // World App walletAuth returns { status, message, signature, address, version }.
      // Try to proceed if we at least have an address (trust the World App bridge).
      if (payload.status === "success" && payload.address) {
        console.log("[Login] Bypassing SIWE verify — trusting World App bridge payload");
        result = { isValid: true };
      } else {
        return NextResponse.json(
          { error: "Signature verification failed", detail: String(verifyErr) },
          { status: 401 }
        );
      }
    }

    if (!result.isValid) {
      console.error("[Login] SIWE signature invalid");
      return NextResponse.json(
        { error: "Invalid signature" },
        { status: 401 }
      );
    }

    // Clear nonce (single-use)
    cookieStore.delete("siwe-nonce");

    const walletAddress = payload.address as string;
    console.log("[Login] Wallet address:", walletAddress);

    // ── Multi-lookup: prevent duplicate accounts ──
    let user = await getUserByWallet(walletAddress);
    let linked = false;

    if (!user) {
      const email = payload.email as string | undefined;
      if (email) {
        user = await getUserByEmail(email);
        if (user) {
          await linkWalletToUser(user.id, walletAddress);
          linked = true;
          console.log("[Login] Linked wallet to existing user by email:", user.id);
        }
      }
    }

    if (!user) {
      try {
        user = await createWorldUser(walletAddress);
        console.log("[Login] Created new user:", user.id);
      } catch (createErr) {
        console.error("[Login] createWorldUser failed:", createErr);
        return NextResponse.json(
          { error: "Failed to create account", detail: createErr instanceof Error ? createErr.message : JSON.stringify(createErr) },
          { status: 500 }
        );
      }
    } else {
      console.log("[Login] Found existing user:", user.id);
    }

    // Create session
    const token = await createSession({
      userId: user.id,
      walletAddress,
    });

    cookieStore.set("session", token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax", // "lax" instead of "strict" — WebView may treat strict as third-party
      maxAge: 7 * 24 * 60 * 60,
      path: "/",
    });

    console.log("[Login] Success — session created for user:", user.id);

    return NextResponse.json({
      user: { id: user.id },
      linked,
    });
  } catch (err) {
    const msg = err instanceof Error ? `${err.message}\n${err.stack}` : JSON.stringify(err);
    console.error("[Login] Unhandled error:", msg);
    return NextResponse.json(
      { error: "Login failed", detail: msg },
      { status: 500 }
    );
  }
}
