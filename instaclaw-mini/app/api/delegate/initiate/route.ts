import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getWldUsdPrice } from "@/lib/api";
import { supabase, getAgentStatus } from "@/lib/supabase";
import { tokenToDecimals, Tokens } from "@worldcoin/minikit-js";

const TIERS = {
  try_it: { wld: 5, credits: 150, durationDays: 3 },
  starter: { wld: 15, credits: 500, durationDays: 7 },
  full_month: { wld: 50, credits: 2000, durationDays: 30 },
} as const;

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    const { tier = "try_it" } = await req.json();

    const tierConfig = TIERS[tier as keyof typeof TIERS];
    if (!tierConfig) {
      return NextResponse.json({ error: "Invalid tier" }, { status: 400 });
    }

    const wldPrice = await getWldUsdPrice();
    const amountUsd = tierConfig.wld * wldPrice;

    const agent = await getAgentStatus(session.userId);

    const reference = crypto.randomUUID();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + tierConfig.durationDays);

    const { error } = await supabase().from("instaclaw_wld_delegations").insert({
      user_id: session.userId,
      vm_id: agent?.id ?? null,
      amount_wld: tierConfig.wld,
      amount_usd: amountUsd,
      wld_usd_rate: wldPrice,
      credits_granted: tierConfig.credits,
      status: "pending",
      expires_at: expiresAt.toISOString(),
      transaction_id: reference,
    });

    if (error) throw error;

    return NextResponse.json({
      reference,
      tier,
      wldAmount: tierConfig.wld,
      credits: tierConfig.credits,
      tokenAmount: tokenToDecimals(tierConfig.wld, Tokens.WLD),
    });
  } catch (err) {
    console.error("Delegate initiate error:", err);
    return NextResponse.json(
      { error: "Failed to initiate delegation" },
      { status: 500 }
    );
  }
}
