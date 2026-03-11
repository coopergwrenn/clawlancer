import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { isAgentRegistered } from "@/lib/agentbook";
import { logger } from "@/lib/logger";
import type { Address } from "viem";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/agentbook/register
 *
 * Called after a VM agent completes AgentBook registration via the CLI.
 * Records the registration result in instaclaw_vms and propagates
 * to Clawlancer via runtime API call (Rule #3: never direct DB write).
 *
 * Body: { walletAddress, txHash }
 */
export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { walletAddress, txHash } = body;

    if (!walletAddress || typeof walletAddress !== "string") {
      return NextResponse.json(
        { error: "walletAddress is required" },
        { status: 400 }
      );
    }

    const supabase = getSupabase();

    // Get user's VM
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id")
      .eq("assigned_to", session.user.id)
      .single();

    if (!vm) {
      return NextResponse.json(
        { error: "No VM assigned to this user" },
        { status: 404 }
      );
    }

    // Verify on-chain that the wallet is actually registered in AgentBook
    let verified = false;
    try {
      verified = await isAgentRegistered(walletAddress as Address);
    } catch (err) {
      logger.warn("AgentBook on-chain verification failed, storing anyway", {
        error: String(err),
        walletAddress,
        route: "agentbook/register",
      });
      // Store the claim even if RPC fails — we can re-verify later
    }

    // Update instaclaw_vms with registration data
    const { error: updateError } = await supabase
      .from("instaclaw_vms")
      .update({
        agentbook_registered: verified,
        agentbook_wallet_address: walletAddress,
        agentbook_tx_hash: txHash ?? null,
        agentbook_registered_at: new Date().toISOString(),
      })
      .eq("id", vm.id);

    if (updateError) {
      logger.error("Failed to update VM with AgentBook registration", {
        error: updateError.message,
        vmId: vm.id,
        route: "agentbook/register",
      });
      return NextResponse.json(
        { error: "Failed to save registration" },
        { status: 500 }
      );
    }

    logger.info("AgentBook registration recorded", {
      userId: session.user.id,
      vmId: vm.id,
      walletAddress,
      verified,
      route: "agentbook/register",
    });

    // Rule #3: Propagate to Clawlancer via runtime API, not direct DB
    propagateToClawlancer(walletAddress, verified).catch((err) =>
      logger.warn("Failed to propagate AgentBook to Clawlancer (non-fatal)", {
        error: String(err),
        walletAddress,
        route: "agentbook/register",
      })
    );

    return NextResponse.json({
      registered: verified,
      walletAddress,
      txHash: txHash ?? null,
    });
  } catch (err) {
    logger.error("AgentBook register error", {
      error: String(err),
      route: "agentbook/register",
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * Propagate AgentBook registration to Clawlancer via API.
 * Rule #3: MUST use runtime API call, never direct Supabase write.
 */
async function propagateToClawlancer(
  walletAddress: string,
  verified: boolean
): Promise<void> {
  const clawlancerBase = "https://clawlancer.ai";

  // Use internal admin key if available, otherwise skip
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
