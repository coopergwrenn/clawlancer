import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();

  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("bankr_wallet_id, bankr_evm_address, bankr_token_address, bankr_token_symbol, bankr_token_launched_at")
    .eq("assigned_to", session.user.id)
    .single();

  if (!vm) {
    return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
  }

  // Fetch credit earnings from Bankr trading fees
  let bankrCreditsEarned = 0;
  if (vm.bankr_wallet_id) {
    const { data: vmId } = await supabase
      .from("instaclaw_vms")
      .select("id")
      .eq("assigned_to", session.user.id)
      .single();

    if (vmId) {
      const { data: earnings } = await supabase
        .from("instaclaw_credit_ledger")
        .select("amount")
        .eq("vm_id", vmId.id)
        .eq("source", "bankr_trading_fee");

      if (earnings) {
        bankrCreditsEarned = earnings.reduce((sum, row) => sum + (row.amount ?? 0), 0);
      }
    }
  }

  return NextResponse.json({
    wallet_id: vm.bankr_wallet_id,
    evm_address: vm.bankr_evm_address,
    token_address: vm.bankr_token_address,
    token_symbol: vm.bankr_token_symbol,
    token_launched_at: vm.bankr_token_launched_at,
    credits_earned_from_trading: bankrCreditsEarned,
  });
}
