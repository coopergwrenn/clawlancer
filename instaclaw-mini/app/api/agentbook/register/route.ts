import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { supabase } from "@/lib/supabase";
import { proxyToInstaclaw } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/agentbook/register
 *
 * Registers the agent on AgentBook via direct contract call on World Chain.
 * The user already verified via MiniKit.commandsAsync.verify() in the frontend.
 *
 * Flow:
 *   1. Frontend: MiniKit.verify() → gets proof
 *   2. Frontend sends proof here
 *   3. This route proxies to instaclaw.io /api/agentbook/register-direct
 *   4. instaclaw.io SSHes into the VM
 *   5. VM calls AgentBook.register() on World Chain using agent's private key
 *   6. Confirms on-chain, updates DB
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

    // Proxy to instaclaw.io which has SSH access to the VM
    const res = await proxyToInstaclaw(
      "/api/agentbook/register-direct",
      session.userId,
      {
        method: "POST",
        body: JSON.stringify({
          proof,
          merkle_root,
          nullifier_hash,
          verification_level,
        }),
      }
    );

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      return NextResponse.json(
        { error: data.error || "Registration failed" },
        { status: res.status }
      );
    }

    return NextResponse.json(data);
  } catch (err) {
    if (err instanceof Error && err.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("[AgentBook/Register] Error:", err);
    return NextResponse.json({ error: "Registration failed" }, { status: 500 });
  }
}
