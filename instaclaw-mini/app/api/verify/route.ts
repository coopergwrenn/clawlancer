import { NextRequest, NextResponse } from "next/server";
import { verifyCloudProof } from "@worldcoin/minikit-js";
import { requireSession } from "@/lib/auth";
import {
  getUserByNullifier,
  markWorldIdVerified,
  linkWalletToUser,
  findPotentialExistingAgent,
  supabase,
} from "@/lib/supabase";
import { proxyToInstaclaw } from "@/lib/api";

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    const payload = await req.json();

    const appId = process.env.NEXT_PUBLIC_APP_ID as `app_${string}`;
    const action = "verify-instaclaw-agent";

    console.log("[Verify] App ID:", appId);
    console.log("[Verify] Action:", action);
    console.log("[Verify] Payload keys:", Object.keys(payload));
    console.log("[Verify] Payload:", JSON.stringify(payload));

    // Verify proof with World ID cloud
    let verifyRes: { success: boolean; [key: string]: unknown };
    try {
      verifyRes = await verifyCloudProof(payload, appId, action) as { success: boolean; [key: string]: unknown };
      console.log("[Verify] verifyCloudProof response:", JSON.stringify(verifyRes));
    } catch (cloudErr) {
      console.error("[Verify] verifyCloudProof threw:", cloudErr);
      return NextResponse.json(
        { error: "Cloud proof verification threw", detail: cloudErr instanceof Error ? cloudErr.message : JSON.stringify(cloudErr) },
        { status: 500 }
      );
    }

    // "max_verifications_reached" means the user IS verified — they already
    // proved they're human for this action. Treat it as a success.
    const isMaxReached = (verifyRes as Record<string, unknown>).code === "max_verifications_reached";

    if (!verifyRes.success && !isMaxReached) {
      console.error("[Verify] Proof invalid. Full response:", JSON.stringify(verifyRes));
      return NextResponse.json(
        {
          error: "Verification failed",
          detail: JSON.stringify(verifyRes),
          appId,
          action,
          payloadKeys: Object.keys(payload),
        },
        { status: 400 }
      );
    }

    if (isMaxReached) {
      console.log("[Verify] max_verifications_reached — treating as already verified");
    }

    const nullifierHash =
      payload.nullifier_hash || payload.nullifier || "";

    // Account linking: check if this nullifier already belongs to an existing user
    const existingUser = await getUserByNullifier(nullifierHash);

    if (existingUser && existingUser.id !== session.userId) {
      // Merge: link wallet to existing user, switch session to existing account
      try {
        console.log("[Verify] Merging accounts:", session.userId, "→", existingUser.id);

        // Link wallet to existing user
        await linkWalletToUser(existingUser.id, session.walletAddress);

        // Delete the orphan row created during walletAuth (non-fatal if fails)
        try {
          await supabase()
            .from("instaclaw_users")
            .delete()
            .eq("id", session.userId);
        } catch (delErr) {
          console.error("[Verify] Orphan delete failed (non-fatal):", delErr);
        }

        // Mark verified on the existing user
        await markWorldIdVerified(
          existingUser.id,
          nullifierHash,
          payload.verification_level || "orb"
        );

        // Update the session cookie to point to the existing user
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
        }).catch(() => {});

        // Propagate World ID (fire-and-forget, delayed)
        setTimeout(() => {
          proxyToInstaclaw("/api/auth/world-id/propagate", existingUser.id, {
            method: "POST",
            body: JSON.stringify({ proofJson: payload }),
          }).catch(() => {});
        }, 15000);

        return NextResponse.json({
          verified: true,
          merged: true,
          userId: existingUser.id,
        });
      } catch (mergeErr) {
        console.error("[Verify] Account merge failed:", mergeErr);
        // Merge failed — but the user IS verified. Mark current account verified
        // and let them proceed rather than 500ing.
        await markWorldIdVerified(
          session.userId,
          nullifierHash,
          payload.verification_level || "orb"
        );
        return NextResponse.json({
          verified: true,
          merged: false,
          mergeError: "Account linking failed. You can use this account independently.",
        });
      }
    }

    // No merge needed — just mark verified on current user
    await markWorldIdVerified(
      session.userId,
      nullifierHash,
      payload.verification_level || "orb"
    );

    // Store the full proof JSON for future Cloudflare integration
    try {
      await supabase()
        .from("instaclaw_users")
        .update({ world_id_proof_json: payload })
        .eq("id", session.userId);
    } catch { /* non-fatal */ }

    // Check for duplicate VM before provisioning
    const existingAgent = await findPotentialExistingAgent(
      session.userId,
      nullifierHash,
      null // email checked during login, nullifier is the stronger signal here
    );

    if (existingAgent) {
      // Found a potential duplicate — return it so the client can prompt
      return NextResponse.json({
        verified: true,
        merged: false,
        potentialDuplicate: {
          matchedBy: existingAgent.matchedBy,
        },
      });
    }

    // No duplicate — trigger agent provisioning in background
    proxyToInstaclaw("/api/vm/configure", session.userId, {
      method: "POST",
      body: JSON.stringify({ userId: session.userId }),
    }).catch(() => {}); // fire-and-forget

    // Propagate World ID verification to VM + marketplace (fire-and-forget)
    // Runs after VM provisioning starts — the propagate endpoint waits for the VM to exist
    setTimeout(() => {
      proxyToInstaclaw("/api/auth/world-id/propagate", session.userId, {
        method: "POST",
        body: JSON.stringify({ proofJson: payload }),
      }).catch(() => {}); // fire-and-forget
    }, 15000); // 15s delay to let VM provisioning complete

    return NextResponse.json({ verified: true, merged: false });
  } catch (err) {
    console.error("Verify error:", err);
    return NextResponse.json(
      { error: "Verification failed" },
      { status: 500 }
    );
  }
}
