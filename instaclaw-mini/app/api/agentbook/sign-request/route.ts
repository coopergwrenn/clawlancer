import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { createHmac } from "crypto";

export const dynamic = "force-dynamic";

/**
 * GET /api/agentbook/sign-request
 *
 * Generates rp_context for IDKit v4 verification request.
 * Signs with our RP key for the agentbook-registration action.
 */
export async function GET() {
  try {
    await requireSession();

    const signingKey = process.env.RP_SIGNING_KEY;
    const rpId = process.env.RP_ID || process.env.NEXT_PUBLIC_RP_ID;

    if (!signingKey || !rpId) {
      return NextResponse.json({ error: "RP credentials not configured" }, { status: 500 });
    }

    const now = Math.floor(Date.now() / 1000);
    const ttl = 300; // 5 minutes
    const nonce = `0x${createHmac("sha256", signingKey).update(String(now)).digest("hex").slice(0, 40)}`;

    // Sign: HMAC-SHA256(signing_key, rp_id + nonce + created_at + expires_at + action)
    const created_at = now;
    const expires_at = now + ttl;
    const action = "agentbook-registration";

    const message = `${rpId}${nonce}${created_at}${expires_at}${action}`;
    const signature = `0x${createHmac("sha256", Buffer.from(signingKey, "hex")).update(message).digest("hex")}`;

    return NextResponse.json({
      rp_id: rpId,
      nonce,
      created_at,
      expires_at,
      signature,
    });
  } catch (err) {
    if (err instanceof Error && err.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("[sign-request] Error:", err);
    return NextResponse.json({ error: String(err).slice(0, 200) }, { status: 500 });
  }
}
