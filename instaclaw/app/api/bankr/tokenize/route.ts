import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { token_name, token_symbol } = await req.json();

  if (!token_name || typeof token_name !== "string" || token_name.length > 32) {
    return NextResponse.json({ error: "Invalid token name (max 32 chars)" }, { status: 400 });
  }
  if (!token_symbol || typeof token_symbol !== "string" || token_symbol.length > 10) {
    return NextResponse.json({ error: "Invalid token symbol (max 10 chars)" }, { status: 400 });
  }

  const supabase = getSupabase();

  // Look up user's VM with Bankr wallet
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id, bankr_wallet_id, bankr_evm_address, bankr_token_address")
    .eq("assigned_to", session.user.id)
    .single();

  if (!vm) {
    return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
  }

  if (!vm.bankr_wallet_id) {
    return NextResponse.json({ error: "No Bankr wallet provisioned" }, { status: 400 });
  }

  if (vm.bankr_token_address) {
    return NextResponse.json({ error: "Agent already tokenized" }, { status: 409 });
  }

  // TODO: Call Bankr token launch API when available
  // The token launch endpoint is not in the current partner provisioning spec.
  // When Bankr ships it, wire it up here:
  //
  // const partnerKey = process.env.BANKR_PARTNER_KEY;
  // const res = await fetch(`https://api.bankr.bot/partner/wallets/${vm.bankr_wallet_id}/token-launch`, {
  //   method: "POST",
  //   headers: {
  //     "x-partner-key": partnerKey,
  //     "Content-Type": "application/json",
  //   },
  //   body: JSON.stringify({ name: token_name, symbol: token_symbol }),
  // });
  // const data = await res.json();
  // const tokenAddress = data.tokenAddress;

  logger.info("Bankr tokenize requested (API not yet available)", {
    user_id: session.user.id,
    vm_id: vm.id,
    wallet_id: vm.bankr_wallet_id,
    token_name,
    token_symbol,
  });

  return NextResponse.json(
    {
      error: "Token launch API not yet available — coming soon from Bankr team",
      requested: { token_name, token_symbol, wallet_id: vm.bankr_wallet_id },
    },
    { status: 503 }
  );
}
