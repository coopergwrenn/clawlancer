import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { isAgentRegistered, getNextNonce } from "@/lib/agentbook";
import type { Address } from "viem";

export const dynamic = "force-dynamic";

/**
 * GET /api/agentbook/pre-register
 *
 * Returns AgentBook pre-registration data for verified users who haven't
 * registered yet. Supports both NextAuth session and mini app proxy token.
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  let userId = session?.user?.id;
  if (!userId) {
    const { validateMiniAppToken } = await import("@/lib/security");
    userId = await validateMiniAppToken(req) ?? undefined;
  }
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();

  // Check World ID verification
  const { data: user } = await supabase
    .from("instaclaw_users")
    .select("world_id_verified")
    .eq("id", userId)
    .single();

  if (!user?.world_id_verified) {
    return NextResponse.json(
      { error: "World ID verification required first" },
      { status: 403 }
    );
  }

  // Get VM wallet address
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("agentbook_wallet_address, agentbook_registered")
    .eq("assigned_to", userId)
    .single();

  if (!vm?.agentbook_wallet_address) {
    return NextResponse.json(
      { error: "No VM with wallet found" },
      { status: 404 }
    );
  }

  // Check on-chain status — both World Chain and Base
  const wallet = vm.agentbook_wallet_address as Address;
  const alreadyRegistered = vm.agentbook_registered ||
    await isAgentRegistered(wallet, "worldchain") ||
    await isAgentRegistered(wallet, "base");

  let nonce: string | null = null;
  if (!alreadyRegistered) {
    // Nonce from World Chain (v0.1.8+ target)
    const n = await getNextNonce(wallet, "worldchain");
    nonce = n.toString();
  }

  return NextResponse.json({
    walletAddress: vm.agentbook_wallet_address,
    nonce,
    alreadyRegistered,
  });
}
