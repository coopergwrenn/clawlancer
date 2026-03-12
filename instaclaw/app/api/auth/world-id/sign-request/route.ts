import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { signRequest } from "@worldcoin/idkit/signing";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/world-id/sign-request
 *
 * Generates a signed RP context for IDKitRequestWidget (World ID 4.0).
 * Must be called server-side to keep the RP signing key secret.
 */
export async function GET() {
  try {
    const rpId = process.env.RP_ID?.trim();
    const signingKey = process.env.RP_SIGNING_KEY?.trim();

    if (!rpId || !signingKey) {
      logger.warn("World ID 4.0 sign-request: missing env vars", {
        hasRpId: !!rpId,
        hasSigningKey: !!signingKey,
        route: "world-id/sign-request",
      });
      return NextResponse.json(
        { error: "World ID 4.0 not configured" },
        { status: 503 }
      );
    }

    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    logger.info("sign-request: calling signRequest()", {
      rpId,
      route: "world-id/sign-request",
    });

    // Strip 0x prefix and any trailing whitespace/newline artifacts from env var
    const cleanKey = signingKey.replace(/^0x/i, "").replace(/[\s\\n]+$/g, "").trim();

    const { sig, nonce, createdAt, expiresAt } = signRequest(
      "verify-instaclaw-agent",
      cleanKey
    );

    logger.info("sign-request: success", {
      userId: session.user.id,
      createdAt,
      expiresAt,
      route: "world-id/sign-request",
    });

    return NextResponse.json({
      rp_context: {
        rp_id: rpId,
        nonce,
        created_at: createdAt,
        expires_at: expiresAt,
        signature: sig,
      },
    });
  } catch (err) {
    logger.error("sign-request: unhandled error", {
      error: String(err),
      stack: err instanceof Error ? err.stack : undefined,
      route: "world-id/sign-request",
    });
    return NextResponse.json(
      { error: "Failed to generate signed request", detail: String(err) },
      { status: 500 }
    );
  }
}
