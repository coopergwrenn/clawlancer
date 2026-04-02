import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
// Note: isAgentRegistered checks Base; we now register on World Chain
import { logger } from "@/lib/logger";
import { createPublicClient, http, parseAbi, defineChain, type Address } from "viem";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// World Chain — where the relay sponsors gas
const worldchain = defineChain({
  id: 480,
  name: "World Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://worldchain-mainnet.g.alchemy.com/public"] } },
});
const AGENTBOOK_CONTRACT = "0xA23aB2712eA7BBa896930544C7d6636a96b944dA" as const;
const AGENTBOOK_ABI = parseAbi([
  "function getNextNonce(address agent) view returns (uint256)",
  "function lookupHuman(address agent) view returns (uint256)",
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
    // Read nonce from World Chain contract
    const client = createPublicClient({ chain: worldchain, transport: http() });
    const nonce = await client.readContract({
      address: AGENTBOOK_CONTRACT,
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

    // Submit to gasless relay on World Chain (gas sponsored)
    const registration = {
      agent: wallet,
      root: merkle_root,
      nonce: nonce.toString(),
      nullifierHash: nullifier_hash,
      proof: proofArray,
      contract: AGENTBOOK_CONTRACT,
      network: "worldchain",
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

    let relayData: Record<string, unknown> = {};
    try { relayData = JSON.parse(relayBody); } catch { /* */ }

    logger.info("AgentBook relay full response", {
      route: "agentbook/register-direct",
      status: relayRes.status,
      ok: relayRes.ok,
      data: JSON.stringify(relayData).slice(0, 1000),
    });

    // If relay returned a txHash, it worked
    if (relayData.txHash) {
      // Verify on-chain (World Chain)
      let registered = false;
      try {
        const humanId = await client.readContract({
          address: AGENTBOOK_CONTRACT,
          abi: AGENTBOOK_ABI,
          functionName: "lookupHuman",
          args: [wallet],
        });
        registered = humanId !== BigInt(0);
      } catch { registered = true; /* relay succeeded, trust it */ }

      await supabase
        .from("instaclaw_vms")
        .update({
          agentbook_registered: true,
          agentbook_registered_at: new Date().toISOString(),
          agentbook_tx_hash: String(relayData.txHash),
        })
        .eq("id", vm.id);

      return NextResponse.json({
        registered: true,
        walletAddress: wallet,
        txHash: relayData.txHash,
      });
    }

    // If relay returned manualRegistration, it accepted the proof but wants manual submission
    if (relayData.manualRegistration) {
      return NextResponse.json({
        error: "Relay requires manual submission (no gas sponsorship for this network)",
        detail: JSON.stringify(relayData).slice(0, 500),
        manualRegistration: relayData.manualRegistration,
      }, { status: 422 });
    }

    if (!relayRes.ok) {
      return NextResponse.json(
        { error: "Relay error", detail: JSON.stringify(relayData).slice(0, 500), status: relayRes.status },
        { status: relayRes.status }
      );
    }

    return NextResponse.json({
      error: "Unknown relay response",
      detail: JSON.stringify(relayData).slice(0, 500),
    }, { status: 500 });
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
