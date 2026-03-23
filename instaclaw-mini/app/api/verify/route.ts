import { NextRequest, NextResponse } from "next/server";
import { verifyCloudProof } from "@worldcoin/minikit-js";
import { requireSession } from "@/lib/auth";
import {
  getUserByNullifier,
  markWorldIdVerified,
  linkWalletToUser,
  supabase,
} from "@/lib/supabase";
import { proxyToInstaclaw } from "@/lib/api";

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    const payload = await req.json();

    // Verify proof with World ID cloud
    const appId = process.env.NEXT_PUBLIC_APP_ID as `app_${string}`;
    const verifyRes = await verifyCloudProof(
      payload,
      appId,
      "instaclaw-verify-human"
    );

    if (!verifyRes.success) {
      return NextResponse.json(
        { error: "Verification failed" },
        { status: 400 }
      );
    }

    const nullifierHash =
      payload.nullifier_hash || payload.nullifier || "";

    // Account linking: check if this nullifier already belongs to an existing user
    const existingUser = await getUserByNullifier(nullifierHash);

    if (existingUser && existingUser.id !== session.userId) {
      // Merge: link wallet to existing user, delete the new row we created during walletAuth
      await linkWalletToUser(
        existingUser.id,
        session.walletAddress
      );
      // Delete the orphan row created during walletAuth
      await supabase()
        .from("instaclaw_users")
        .delete()
        .eq("id", session.userId);

      // Mark verified on the existing user
      await markWorldIdVerified(
        existingUser.id,
        nullifierHash,
        payload.verification_level || "orb"
      );

      // Update the session cookie to point to the existing user
      // (client will re-fetch /api/auth/me)
      const { createSession: makeSession } = await import("@/lib/auth");
      const { cookies } = await import("next/headers");
      const cookieStore = await cookies();
      const token = await makeSession({
        userId: existingUser.id,
        walletAddress: session.walletAddress,
      });
      cookieStore.set("session", token, {
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        maxAge: 7 * 24 * 60 * 60,
        path: "/",
      });

      // Trigger agent provisioning if they already have a VM
      proxyToInstaclaw("/api/vm/configure", existingUser.id, {
        method: "POST",
        body: JSON.stringify({ userId: existingUser.id }),
      }).catch(() => {}); // fire-and-forget

      return NextResponse.json({
        verified: true,
        merged: true,
        userId: existingUser.id,
      });
    }

    // No merge needed — just mark verified on current user
    await markWorldIdVerified(
      session.userId,
      nullifierHash,
      payload.verification_level || "orb"
    );

    // Trigger agent provisioning in background
    proxyToInstaclaw("/api/vm/configure", session.userId, {
      method: "POST",
      body: JSON.stringify({ userId: session.userId }),
    }).catch(() => {}); // fire-and-forget

    return NextResponse.json({ verified: true, merged: false });
  } catch (err) {
    console.error("Verify error:", err);
    return NextResponse.json(
      { error: "Verification failed" },
      { status: 500 }
    );
  }
}
