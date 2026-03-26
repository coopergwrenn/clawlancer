import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * GET /api/vm/dispatch-pair/:code — Redeem a pairing code.
 * Returns { token, vmAddress } if valid. Marks code as used (one-time).
 * No auth required — the code IS the auth.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  try {
    const { code } = await params;

    if (!code || code.length < 8) {
      return NextResponse.json({ error: "Invalid pairing code" }, { status: 400 });
    }

    const supabase = getSupabase();

    // Look up the code
    const { data: pairing } = await supabase
      .from("instaclaw_dispatch_pairing_codes")
      .select("code, gateway_token, vm_address, expires_at, used_at")
      .eq("code", code.toUpperCase())
      .maybeSingle();

    if (!pairing) {
      return NextResponse.json({ error: "Invalid or expired pairing code" }, { status: 404 });
    }

    if (pairing.used_at) {
      return NextResponse.json({ error: "Pairing code already used" }, { status: 410 });
    }

    if (new Date(pairing.expires_at) < new Date()) {
      return NextResponse.json({ error: "Pairing code expired" }, { status: 410 });
    }

    // Mark as used
    await supabase
      .from("instaclaw_dispatch_pairing_codes")
      .update({ used_at: new Date().toISOString() })
      .eq("code", pairing.code);

    logger.info("Pairing code redeemed", { code: pairing.code });

    return NextResponse.json({
      token: pairing.gateway_token,
      vmAddress: pairing.vm_address,
    });
  } catch (err) {
    logger.error("Pairing code redemption error", { error: String(err) });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
