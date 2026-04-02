import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { isAgentRegistered } from "@/lib/agentbook";
import { logger } from "@/lib/logger";
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { base } from "viem/chains";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const AGENTBOOK_BASE = "0xE1D1D3526A6FAa37eb36bD10B933C1b77f4561a4" as const;
const AGENTBOOK_ABI = parseAbi([
  "function getNextNonce(address agent) view returns (uint256)",
]);
const RELAY_URL = "https://x402-worldchain.vercel.app/register";

/**
 * POST /api/agentbook/register-direct
 *
 * Takes a World ID proof from MiniKit.verify() and submits it to the
 * gasless relay for on-chain registration. No SSH, no gas needed.
 *
 * Body: { proof, merkle_root, nullifier_hash, verification_level }
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  let userId = session?.user?.id;
  if (!userId) {
    const { validateMiniAppToken } = await import("@/lib/security");
    userId = (await validateMiniAppToken(req)) ?? undefined;
  }
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();
  const body = await req.json();
  const { proof, merkle_root, nullifier_hash } = body;

  if (!proof || !merkle_root || !nullifier_hash) {
    return NextResponse.json({ error: "Missing proof fields" }, { status: 400 });
  }

  // Get user's VM + wallet
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id, agentbook_wallet_address, agentbook_registered")
    .eq("assigned_to", userId)
    .single();

  if (!vm?.agentbook_wallet_address) {
    return NextResponse.json({ error: "No agent wallet found" }, { status: 404 });
  }
  if (vm.agentbook_registered) {
    return NextResponse.json({ error: "Already registered", registered: true }, { status: 409 });
  }

  const wallet = vm.agentbook_wallet_address as Address;

  try {
    // Read nonce from Base mainnet contract
    const client = createPublicClient({ chain: base, transport: http() });
    const nonce = await client.readContract({
      address: AGENTBOOK_BASE,
      abi: AGENTBOOK_ABI,
      functionName: "getNextNonce",
      args: [wallet],
    });

    // Normalize proof to array format expected by relay
    let proofArray: string[];
    if (typeof proof === "string" && proof.startsWith("0x")) {
      const hex = proof.slice(2);
      proofArray = [];
      for (let i = 0; i < 8; i++) {
        proofArray.push("0x" + hex.slice(i * 64, (i + 1) * 64));
      }
    } else if (Array.isArray(proof)) {
      proofArray = proof;
    } else {
      return NextResponse.json({ error: "Invalid proof format" }, { status: 400 });
    }

    // Submit to gasless relay (same as agentkit-cli --auto)
    const registration = {
      agent: wallet,
      root: merkle_root,
      nonce: nonce.toString(),
      nullifierHash: nullifier_hash,
      proof: proofArray,
      contract: AGENTBOOK_BASE,
      network: "base",
    };

    logger.info("Submitting to AgentBook relay", {
      route: "agentbook/register-direct",
      wallet,
      nonce: nonce.toString(),
      relay: RELAY_URL,
    });

    const relayRes = await fetch(RELAY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registration),
    });

    const relayBody = await relayRes.text();
    logger.info("AgentBook relay response", {
      route: "agentbook/register-direct",
      status: relayRes.status,
      body: relayBody.slice(0, 500),
    });

    if (!relayRes.ok) {
      return NextResponse.json(
        { error: "Relay rejected", detail: relayBody.slice(0, 300) },
        { status: relayRes.status }
      );
    }

    let relayData: { txHash?: string } = {};
    try { relayData = JSON.parse(relayBody); } catch { /* */ }

    // Verify on-chain
    const registered = await isAgentRegistered(wallet);

    if (registered) {
      await supabase
        .from("instaclaw_vms")
        .update({
          agentbook_registered: true,
          agentbook_registered_at: new Date().toISOString(),
          agentbook_tx_hash: relayData.txHash || null,
        })
        .eq("id", vm.id);

      return NextResponse.json({
        registered: true,
        walletAddress: wallet,
        txHash: relayData.txHash,
      });
    }

    // Relay accepted but not confirmed yet — return optimistically
    return NextResponse.json({
      registered: true,
      walletAddress: wallet,
      txHash: relayData.txHash,
      pending: true,
    });
  } catch (err) {
    logger.error("AgentBook register-direct error", {
      error: String(err),
      vmId: vm.id,
      route: "agentbook/register-direct",
    });
    return NextResponse.json(
      { error: "Registration failed", detail: String(err).slice(0, 300) },
      { status: 500 }
    );
  }
}
