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
export async function GET(req: Request) {
  // Temporary diagnostic mode: ?diag=1 skips auth to test signRequest() in production
  const url = new URL(req.url);
  const isDiag = url.searchParams.get("diag") === "1";

  try {
    const rpId = process.env.RP_ID;
    const signingKey = process.env.RP_SIGNING_KEY;

    if (!rpId || !signingKey) {
      logger.warn("World ID 4.0 sign-request: missing env vars", {
        hasRpId: !!rpId,
        hasSigningKey: !!signingKey,
        route: "world-id/sign-request",
      });
      return NextResponse.json(
        { error: "World ID 4.0 not configured", hasRpId: !!rpId, hasSigningKey: !!signingKey },
        { status: 503 }
      );
    }

    if (!isDiag) {
      const session = await auth();
      if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    logger.info("sign-request: calling signRequest()", {
      rpId,
      keyPrefix: signingKey.substring(0, 6),
      isDiag,
      route: "world-id/sign-request",
    });

    const { sig, nonce, createdAt, expiresAt } = signRequest(
      "verify-instaclaw-agent",
      signingKey
    );

    logger.info("sign-request: success", {
      createdAt,
      expiresAt,
      isDiag,
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
