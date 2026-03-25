import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getWldUsdPrice } from "@/lib/api";
import { supabase, getAgentStatus } from "@/lib/supabase";

const TIERS = {
  try_it: { wld: 25, credits: 150, durationDays: 3 },
  starter: { wld: 15, credits: 500, durationDays: 7 },
  full_month: { wld: 50, credits: 2000, durationDays: 30 },
} as const;

export async function POST(req: NextRequest) {
  try {
    console.log("[Delegate/Initiate] Starting...");

    const session = await requireSession();
    console.log("[Delegate/Initiate] Session userId:", session.userId);

    const body = await req.json();
    const tier = body.tier || "try_it";
    console.log("[Delegate/Initiate] Tier:", tier);

    const tierConfig = TIERS[tier as keyof typeof TIERS];
    if (!tierConfig) {
      return NextResponse.json({ error: "Invalid tier" }, { status: 400 });
    }

    let wldPrice: number;
    try {
      wldPrice = await getWldUsdPrice();
      console.log("[Delegate/Initiate] WLD price:", wldPrice);
    } catch (priceErr) {
      console.error("[Delegate/Initiate] Price fetch failed:", priceErr);
      wldPrice = 0.33; // fallback
    }

    const amountUsd = tierConfig.wld * wldPrice;

    let agent;
    try {
      agent = await getAgentStatus(session.userId);
      console.log("[Delegate/Initiate] Agent:", agent?.id ?? "none");
    } catch (agentErr) {
      console.error("[Delegate/Initiate] Agent lookup failed:", agentErr);
      agent = null;
    }

    const reference = crypto.randomUUID();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + tierConfig.durationDays);

    console.log("[Delegate/Initiate] Inserting delegation record...");
    const { error: insertErr } = await supabase().from("instaclaw_wld_delegations").insert({
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

    if (insertErr) {
      console.error("[Delegate/Initiate] DB insert failed:", JSON.stringify(insertErr));
      return NextResponse.json(
        { error: "DB insert failed", detail: `${insertErr.code}: ${insertErr.message} | ${insertErr.details}` },
        { status: 500 }
      );
    }

    // WLD has 18 decimals. Compute token_amount as a string.
    // tokenToDecimals from minikit-js may not work server-side, so do it manually.
    const tokenAmount = (BigInt(tierConfig.wld) * BigInt(10 ** 18)).toString();
    console.log("[Delegate/Initiate] tokenAmount:", tokenAmount);

    return NextResponse.json({
      reference,
      tier,
      wldAmount: tierConfig.wld,
      credits: tierConfig.credits,
      tokenAmount,
    });
  } catch (err) {
    const msg = err instanceof Error ? `${err.message}\n${err.stack}` : JSON.stringify(err);
    console.error("[Delegate/Initiate] Unhandled:", msg);
    return NextResponse.json(
      { error: "Failed to initiate delegation", detail: msg },
      { status: 500 }
    );
  }
}
