import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/agentbook/sign-request
 *
 * Generates rp_context for IDKit v4 verification.
 * Uses the WASM-based signRequest from idkit-core for correct signature format.
 */
export async function GET() {
  try {
    await requireSession();

    const signingKey = process.env.RP_SIGNING_KEY;
    const rpId = process.env.RP_ID || process.env.NEXT_PUBLIC_RP_ID;

    if (!signingKey || !rpId) {
      return NextResponse.json({ error: "RP credentials not configured" }, { status: 500 });
    }

    // Use the real signRequest from idkit-core (WASM-based, correct algorithm)
    const { signRequest } = await import("@worldcoin/idkit-core");

    const rpContext = signRequest(signingKey, 300, "agentbook-registration");

    return NextResponse.json({
      rp_id: rpId,
      nonce: rpContext.nonce,
      created_at: rpContext.created_at,
      expires_at: rpContext.expires_at,
      signature: rpContext.signature,
    });
  } catch (err) {
    if (err instanceof Error && err.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("[sign-request] Error:", err);
    return NextResponse.json({ error: `Sign request failed: ${String(err).slice(0, 200)}` }, { status: 500 });
  }
}
