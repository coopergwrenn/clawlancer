import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import crypto from "crypto";

export const dynamic = "force-dynamic";

function generatePairingCode(): string {
  // 8 chars: 4 alpha + 4 numeric, like "ABCD-1234"
  const alpha = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // No I, O (ambiguous)
  const numeric = "23456789"; // No 0, 1 (ambiguous)
  let code = "";
  for (let i = 0; i < 4; i++) code += alpha[crypto.randomInt(alpha.length)];
  code += "-";
  for (let i = 0; i < 4; i++) code += numeric[crypto.randomInt(numeric.length)];
  return code;
}

/**
 * POST /api/vm/dispatch-pair — Generate a pairing code for dispatch CLI.
 * GET /api/vm/dispatch-pair — Get the user's current active pairing code (or generate new one).
 */
export async function GET() {
  return handlePairing();
}

export async function POST() {
  return handlePairing();
}

async function handlePairing() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();

    // Get user's VM
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, gateway_token, name")
      .eq("assigned_to", session.user.id)
      .eq("status", "assigned")
      .single();

    if (!vm) {
      return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
    }

    // Try Supabase table for pairing codes (may not exist yet if migration hasn't run)
    try {
      // Check for existing unexpired, unused code
      const { data: existing } = await supabase
        .from("instaclaw_dispatch_pairing_codes")
        .select("code, expires_at")
        .eq("user_id", session.user.id)
        .is("used_at", null)
        .gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existing) {
        const expiresIn = Math.round((new Date(existing.expires_at).getTime() - Date.now()) / 1000);
        return NextResponse.json({ code: existing.code, expiresIn, vmName: vm.name });
      }

      // Generate new code
      const code = generatePairingCode();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      const { error: insertError } = await supabase
        .from("instaclaw_dispatch_pairing_codes")
        .insert({
          code,
          user_id: session.user.id,
          vm_id: vm.id,
          gateway_token: vm.gateway_token,
          vm_address: vm.ip_address,
          expires_at: expiresAt,
        });

      if (!insertError) {
        // Cleanup old expired codes
        await supabase
          .from("instaclaw_dispatch_pairing_codes")
          .delete()
          .eq("user_id", session.user.id)
          .lt("expires_at", new Date().toISOString());

        return NextResponse.json({ code, expiresIn: 600, vmName: vm.name });
      }
    } catch {
      // Table doesn't exist yet — fall through to fallback
    }

    // Fallback: return the full command directly (table not yet migrated)
    return NextResponse.json({
      code: null,
      fallbackCommand: `npx @instaclaw/dispatch --token ${vm.gateway_token} --vm ${vm.ip_address}`,
      vmName: vm.name,
    });
  } catch (err) {
    logger.error("Pairing code error", { error: String(err) });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
