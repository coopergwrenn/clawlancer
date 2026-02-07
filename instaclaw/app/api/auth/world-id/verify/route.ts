import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { verifyCloudProof, type IVerifyResponse } from "@worldcoin/idkit-core/backend";

// In-memory rate limiting: max 5 attempts per user per hour
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export async function POST(req: Request) {
  try {
    const WORLD_APP_ID = process.env.WORLD_APP_ID;
    if (!WORLD_APP_ID) {
      return NextResponse.json(
        { error: "World ID verification not yet configured" },
        { status: 503 }
      );
    }

    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userId = session.user.id;

    // Rate limiting
    const now = Date.now();
    const rl = rateLimitMap.get(userId);
    if (rl && now < rl.resetAt) {
      if (rl.count >= RATE_LIMIT_MAX) {
        return NextResponse.json(
          { error: "Too many verification attempts. Try again later." },
          { status: 429 }
        );
      }
      rl.count++;
    } else {
      rateLimitMap.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    }

    const body = await req.json();
    const { merkle_root, nullifier_hash, proof, verification_level } = body;

    if (!merkle_root || !nullifier_hash || !proof) {
      return NextResponse.json(
        { error: "Missing required proof fields" },
        { status: 400 }
      );
    }

    const supabase = getSupabase();

    // Check if user is already verified
    const { data: user } = await supabase
      .from("instaclaw_users")
      .select("world_id_verified")
      .eq("id", userId)
      .single();

    if (user?.world_id_verified) {
      return NextResponse.json(
        { error: "Already verified" },
        { status: 409 }
      );
    }

    // Check if nullifier_hash is already linked to another user
    const { data: existing } = await supabase
      .from("instaclaw_users")
      .select("id")
      .eq("world_id_nullifier_hash", nullifier_hash)
      .single();

    if (existing && existing.id !== userId) {
      return NextResponse.json(
        { error: "This World ID is already linked to another account" },
        { status: 409 }
      );
    }

    // Verify proof with World ID cloud API via official SDK helper
    let verifyResult: IVerifyResponse;
    try {
      verifyResult = await verifyCloudProof(
        { merkle_root, nullifier_hash, proof, verification_level: verification_level ?? "orb" },
        WORLD_APP_ID as `app_${string}`,
        "verify-instaclaw-agent",
        userId
      );
    } catch (err) {
      logger.warn("World ID cloud verify call failed", {
        error: String(err),
        userId,
        route: "world-id/verify",
      });
      return NextResponse.json(
        { error: "Verification service temporarily unavailable" },
        { status: 503 }
      );
    }

    if (!verifyResult.success) {
      logger.warn("World ID verification failed", {
        code: verifyResult.code,
        detail: verifyResult.detail,
        userId,
        route: "world-id/verify",
      });
      return NextResponse.json(
        { error: verifyResult.detail ?? "Verification failed" },
        { status: 400 }
      );
    }

    // Update user record
    const { error: updateError } = await supabase
      .from("instaclaw_users")
      .update({
        world_id_verified: true,
        world_id_nullifier_hash: nullifier_hash,
        world_id_verified_at: new Date().toISOString(),
        world_id_verification_level: verification_level ?? "orb",
      })
      .eq("id", userId);

    if (updateError) {
      logger.error("Failed to update World ID verification", {
        error: String(updateError),
        userId,
        route: "world-id/verify",
      });
      return NextResponse.json(
        { error: "Failed to save verification" },
        { status: 500 }
      );
    }

    logger.info("World ID verification successful", {
      userId,
      verification_level: verification_level ?? "orb",
      route: "world-id/verify",
    });

    return NextResponse.json({
      verified: true,
      verification_level: verification_level ?? "orb",
    });
  } catch (err) {
    logger.error("World ID verify error", {
      error: String(err),
      route: "world-id/verify",
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
