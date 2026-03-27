import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * GET /api/vm/dispatch-pair/:code — Redeem a pairing code.
 * Returns { token, vmAddress } if valid and not expired.
 *
 * Codes are reusable within their 10-minute TTL window.
 * This is intentional — macOS kills Terminal when granting Accessibility,
 * forcing the user to reopen Terminal and re-run the command.
 * The code only truly expires after the TTL, not after first use.
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

    // Look up the code — allow reuse within TTL
    const { data: pairing } = await supabase
      .from("instaclaw_dispatch_pairing_codes")
      .select("code, gateway_token, vm_address, expires_at, used_at")
      .eq("code", code.toUpperCase())
      .maybeSingle();

    if (!pairing) {
      return NextResponse.json({ error: "Invalid or expired pairing code" }, { status: 404 });
    }

    if (new Date(pairing.expires_at) < new Date()) {
      return NextResponse.json({ error: "Pairing code expired. Generate a new one at instaclaw.io/settings." }, { status: 410 });
    }

    // Mark as used (for tracking), but allow re-redemption within TTL
    if (!pairing.used_at) {
      await supabase
        .from("instaclaw_dispatch_pairing_codes")
        .update({ used_at: new Date().toISOString() })
        .eq("code", pairing.code);
    }

    logger.info("Pairing code redeemed", { code: pairing.code, reuse: !!pairing.used_at });

    return NextResponse.json({
      token: pairing.gateway_token,
      vmAddress: pairing.vm_address,
    });
  } catch (err) {
    logger.error("Pairing code redemption error", { error: String(err) });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
