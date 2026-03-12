import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { isAgentRegistered, getNextNonce } from "@/lib/agentbook";
import type { Address } from "viem";

export const dynamic = "force-dynamic";

/**
 * GET /api/agentbook/pre-register
 *
 * Returns AgentBook pre-registration data for verified users who haven't
 * registered yet. Used by the dashboard to show Step 2 (AgentBook widget).
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();

  // Check World ID verification
  const { data: user } = await supabase
    .from("instaclaw_users")
    .select("world_id_verified")
    .eq("id", session.user.id)
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
    .eq("assigned_to", session.user.id)
    .single();

  if (!vm?.agentbook_wallet_address) {
    return NextResponse.json(
      { error: "No VM with wallet found" },
      { status: 404 }
    );
  }

  // Check on-chain status
  const alreadyRegistered = vm.agentbook_registered ||
    await isAgentRegistered(vm.agentbook_wallet_address as Address);

  let nonce: string | null = null;
  if (!alreadyRegistered) {
    const n = await getNextNonce(vm.agentbook_wallet_address as Address);
    nonce = n.toString();
  }

  return NextResponse.json({
    walletAddress: vm.agentbook_wallet_address,
    nonce,
    alreadyRegistered,
  });
}
