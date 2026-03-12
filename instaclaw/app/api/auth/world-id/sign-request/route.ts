import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { signRequest } from "@worldcoin/idkit/signing";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/world-id/sign-request
 *
 * Generates a signed RP context for IDKitRequestWidget (World ID 4.0).
 * Must be called server-side to keep the RP signing key secret.
 */
export async function GET() {
  const rpId = process.env.RP_ID;
  const signingKey = process.env.RP_SIGNING_KEY;

  if (!rpId || !signingKey) {
    return NextResponse.json(
      { error: "World ID 4.0 not configured" },
      { status: 503 }
    );
  }

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { sig, nonce, createdAt, expiresAt } = signRequest(
    "verify-instaclaw-agent",
    signingKey
  );

  return NextResponse.json({
    rp_context: {
      rp_id: rpId,
      nonce,
      created_at: createdAt,
      expires_at: expiresAt,
      signature: sig,
    },
  });
}
