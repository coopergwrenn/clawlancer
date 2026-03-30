import { NextRequest, NextResponse } from "next/server";
import { lookupVMByGatewayToken } from "@/lib/gateway-auth";
import { getSupabase } from "@/lib/supabase";
import { getAddress } from "viem";

/**
 * GET /api/vm/identity — Returns the agent's identity (wallet address, VM name).
 * PUT /api/vm/identity — Sets the agent's wallet address (one-time, stored on VM record).
 *
 * Auth: Bearer GATEWAY_TOKEN.
 * No Clawlancer dependency — everything is within InstaClaw's domain.
 */
export async function GET(req: NextRequest) {
  const vm = await authenticateVM(req);
  if (!vm) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  return NextResponse.json({
    vm_name: vm.name,
    wallet_address: vm.agentbook_wallet_address ?? null,
    agentbook_registered: vm.agentbook_registered ?? false,
  });
}

export async function PUT(req: NextRequest) {
  const vm = await authenticateVM(req);
  if (!vm) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json();
  const { wallet_address } = body;

  if (!wallet_address || typeof wallet_address !== "string" || !wallet_address.startsWith("0x")) {
    return NextResponse.json({ error: "wallet_address required (0x...)" }, { status: 400 });
  }

  // Always store checksummed (EIP-55) — gasless relay requires it
  let checksummed: string;
  try {
    checksummed = getAddress(wallet_address);
  } catch {
    return NextResponse.json({ error: "Invalid Ethereum address" }, { status: 400 });
  }

  const supabase = getSupabase();
  const { error } = await supabase
    .from("instaclaw_vms")
    .update({ agentbook_wallet_address: checksummed })
    .eq("id", vm.id);

  if (error) {
    return NextResponse.json({ error: "Failed to save wallet" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, wallet_address: checksummed });
}

async function authenticateVM(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  return lookupVMByGatewayToken(token, "id, name, agentbook_wallet_address, agentbook_registered");
}
