import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { isAgentRegistered, lookupHuman } from "@/lib/agentbook";
import { logger } from "@/lib/logger";
import type { Address } from "viem";

export const dynamic = "force-dynamic";

/**
 * GET /api/agentbook/check-registration
 *
 * Polls on-chain AgentBook contract to check if the user's agent wallet
 * has been registered. Called by the frontend every 5s after the bridge
 * URL is displayed.
 */
export async function GET(req: NextRequest) {
  try {
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
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, agentbook_wallet_address, agentbook_registered")
      .eq("assigned_to", userId)
      .single();

    if (!vm) {
      return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
    }

    // Already recorded as registered in DB
    if (vm.agentbook_registered) {
      return NextResponse.json({ registered: true });
    }

    if (!vm.agentbook_wallet_address) {
      return NextResponse.json({ registered: false });
    }

    const wallet = vm.agentbook_wallet_address as Address;

    // Check on-chain — try both World Chain (v0.1.8+) and Base (v0.1.3)
    let registered = await isAgentRegistered(wallet, "worldchain");
    if (!registered) {
      registered = await isAgentRegistered(wallet, "base");
    }
    if (!registered) {
      return NextResponse.json({ registered: false });
    }

    // Registered! Get nullifier and update DB
    let nullifierHash: string | null = null;
    try {
      const nullifier = await lookupHuman(wallet);
      if (nullifier !== null) {
        nullifierHash = nullifier.toString();
      }
    } catch {
      // Non-fatal — we know it's registered
    }

    const { error: updateError } = await supabase
      .from("instaclaw_vms")
      .update({
        agentbook_registered: true,
        agentbook_registered_at: new Date().toISOString(),
        agentbook_nullifier_hash: nullifierHash,
      })
      .eq("id", vm.id);

    if (updateError) {
      logger.error("Failed to update VM with AgentBook registration", {
        error: updateError.message,
        vmId: vm.id,
        route: "agentbook/check-registration",
      });
    }

    logger.info("AgentBook registration confirmed on-chain", {
      vmId: vm.id,
      wallet: vm.agentbook_wallet_address,
      nullifierHash,
      route: "agentbook/check-registration",
    });

    // Propagate to Clawlancer (fire-and-forget)
    propagateToClawlancer(vm.agentbook_wallet_address, true).catch((err) =>
      logger.warn("Failed to propagate AgentBook to Clawlancer (non-fatal)", {
        error: String(err),
        wallet: vm.agentbook_wallet_address,
        route: "agentbook/check-registration",
      })
    );

    return NextResponse.json({ registered: true });
  } catch (err) {
    logger.error("check-registration error", {
      error: String(err),
      route: "agentbook/check-registration",
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

async function propagateToClawlancer(
  walletAddress: string,
  verified: boolean
): Promise<void> {
  const clawlancerBase = "https://clawlancer.ai";
  const adminKey = process.env.CLAWLANCER_ADMIN_KEY;
  if (!adminKey) return;

  await fetch(`${clawlancerBase}/api/agents/agentbook-status`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminKey}`,
    },
    body: JSON.stringify({
      wallet_address: walletAddress,
      agentbook_registered: verified,
    }),
  });
}
