import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { supabase } from "@/lib/supabase";

export const maxDuration = 30;

const GASLESS_RELAY_URL = "https://x402-worldchain.vercel.app/register";

/**
 * POST /api/agentbook/register
 *
 * Accepts a MiniKit World ID proof and submits it to the AgentBook gasless relay.
 * The user already verified via MiniKit.commandsAsync.verify() in the frontend.
 *
 * Body: { proof, merkle_root, nullifier_hash, verification_level }
 */
export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    const body = await req.json();
    const { proof, merkle_root, nullifier_hash, verification_level } = body;

    if (!proof || !nullifier_hash) {
      return NextResponse.json({ error: "Missing proof data" }, { status: 400 });
    }

    // Get the agent's wallet address
    const { data: vm } = await supabase()
      .from("instaclaw_vms")
      .select("id, agentbook_wallet_address, agentbook_registered")
      .eq("assigned_to", session.userId)
      .single();

    if (!vm?.agentbook_wallet_address) {
      return NextResponse.json({ error: "No agent wallet found" }, { status: 404 });
    }

    if (vm.agentbook_registered) {
      return NextResponse.json({ error: "Already registered", registered: true }, { status: 409 });
    }

    // Submit to gasless relay — match exact format from web app's register-proof endpoint
    const relayBody = {
      proof,
      walletAddress: vm.agentbook_wallet_address,
      app_id: process.env.AGENTBOOK_APP_ID || "app_a7c3e2b6b83927251a0db5345bd7146a",
    };
    console.log("[AgentBook/Register] Relay body:", JSON.stringify(relayBody));

    const relayRes = await fetch(GASLESS_RELAY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(relayBody),
    });

    const relayData = await relayRes.json().catch(() => ({}));

    if (!relayRes.ok) {
      console.error("[AgentBook/Register] Relay error:", relayRes.status, relayData);
      return NextResponse.json({
        error: relayData.error || relayData.message || "On-chain registration failed",
        detail: relayData,
      }, { status: relayRes.status });
    }

    // Mark as registered in DB
    await supabase()
      .from("instaclaw_vms")
      .update({
        agentbook_registered: true,
        agentbook_registered_at: new Date().toISOString(),
      })
      .eq("id", vm.id);

    return NextResponse.json({
      registered: true,
      walletAddress: vm.agentbook_wallet_address,
      txHash: relayData.txHash ?? null,
    });
  } catch (err) {
    if (err instanceof Error && err.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("[AgentBook/Register] Error:", err);
    return NextResponse.json({ error: "Registration failed" }, { status: 500 });
  }
}
