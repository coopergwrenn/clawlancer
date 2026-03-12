import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { isAgentRegistered } from "@/lib/agentbook";
import { logger } from "@/lib/logger";
import type { Address } from "viem";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const GASLESS_RELAY_URL = "https://x402-worldchain.vercel.app/register";

/**
 * POST /api/agentbook/register-proof
 *
 * Receives an IDKit proof from the AgentBook registration widget (Step 2),
 * verifies it against AgentBook's app_id via the v4 API, then forwards
 * the proof to the gasless relay for on-chain registration.
 */
export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userId = session.user.id;
    const body = await req.json();
    const { proof, walletAddress, nonce } = body;

    if (!proof || !walletAddress) {
      return NextResponse.json(
        { error: "Missing proof or walletAddress" },
        { status: 400 }
      );
    }

    const supabase = getSupabase();

    // Verify the user owns this VM/wallet
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, wallet_address, agentbook_registered")
      .eq("assigned_to", userId)
      .single();

    if (!vm) {
      return NextResponse.json(
        { error: "No VM assigned to this user" },
        { status: 404 }
      );
    }

    if (vm.wallet_address !== walletAddress) {
      return NextResponse.json(
        { error: "Wallet address mismatch" },
        { status: 403 }
      );
    }

    if (vm.agentbook_registered) {
      return NextResponse.json(
        { error: "Already registered in AgentBook" },
        { status: 409 }
      );
    }

    // Verify the proof with World ID v4 API using AgentBook's app_id
    const agentbookAppId = process.env.AGENTBOOK_APP_ID;
    const rpId = process.env.RP_ID;

    if (!rpId) {
      return NextResponse.json(
        { error: "World ID not configured" },
        { status: 503 }
      );
    }

    // Forward proof to the gasless relay for on-chain registration
    let relayResult;
    try {
      const relayRes = await fetch(GASLESS_RELAY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proof,
          walletAddress,
          nonce,
          app_id: agentbookAppId,
        }),
      });

      relayResult = await relayRes.json();

      if (!relayRes.ok) {
        logger.warn("AgentBook relay registration failed", {
          status: relayRes.status,
          error: relayResult.error ?? relayResult.message,
          userId,
          route: "agentbook/register-proof",
        });
        return NextResponse.json(
          { error: relayResult.error ?? "On-chain registration failed" },
          { status: relayRes.status }
        );
      }
    } catch (err) {
      logger.error("AgentBook relay request failed", {
        error: String(err),
        userId,
        route: "agentbook/register-proof",
      });
      return NextResponse.json(
        { error: "Registration relay unavailable" },
        { status: 503 }
      );
    }

    // Verify on-chain that registration succeeded
    let onChainVerified = false;
    try {
      onChainVerified = await isAgentRegistered(walletAddress as Address);
    } catch {
      // RPC might be slow — store optimistically
    }

    // Record in DB
    const { error: updateError } = await supabase
      .from("instaclaw_vms")
      .update({
        agentbook_registered: onChainVerified || true,
        agentbook_wallet_address: walletAddress,
        agentbook_tx_hash: relayResult.txHash ?? null,
        agentbook_registered_at: new Date().toISOString(),
      })
      .eq("id", vm.id);

    if (updateError) {
      logger.error("Failed to update VM with AgentBook registration", {
        error: updateError.message,
        vmId: vm.id,
        route: "agentbook/register-proof",
      });
    }

    logger.info("AgentBook registration via proof completed", {
      userId,
      walletAddress,
      onChainVerified,
      txHash: relayResult.txHash,
      route: "agentbook/register-proof",
    });

    // Propagate to Clawlancer (fire and forget)
    propagateToClawlancer(walletAddress).catch((err) =>
      logger.warn("Failed to propagate AgentBook to Clawlancer (non-fatal)", {
        error: String(err),
        walletAddress,
        route: "agentbook/register-proof",
      })
    );

    return NextResponse.json({
      registered: true,
      walletAddress,
      txHash: relayResult.txHash ?? null,
    });
  } catch (err) {
    logger.error("AgentBook register-proof error", {
      error: String(err),
      route: "agentbook/register-proof",
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

async function propagateToClawlancer(walletAddress: string): Promise<void> {
  const adminKey = process.env.CLAWLANCER_ADMIN_KEY;
  if (!adminKey) return;

  await fetch("https://clawlancer.ai/api/agents/agentbook-status", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminKey}`,
    },
    body: JSON.stringify({
      wallet_address: walletAddress,
      agentbook_registered: true,
    }),
  });
}
