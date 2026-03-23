import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { supabase, getAgentStatus } from "@/lib/supabase";

const PACKS = {
  "50": { credits: 50, priceUsdc: 5 },
  "200": { credits: 200, priceUsdc: 15 },
  "500": { credits: 500, priceUsdc: 30 },
} as const;

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    const { pack } = await req.json();

    const packConfig = PACKS[pack as keyof typeof PACKS];
    if (!packConfig) {
      return NextResponse.json({ error: "Invalid pack" }, { status: 400 });
    }

    const agent = await getAgentStatus(session.userId);
    const reference = crypto.randomUUID();

    const { error } = await supabase().from("instaclaw_world_payments").insert({
      user_id: session.userId,
      vm_id: agent?.id ?? null,
      reference,
      pack,
      credits: packConfig.credits,
      amount_usdc: packConfig.priceUsdc,
      token: "USDC",
      status: "pending",
    });

    if (error) throw error;

    return NextResponse.json({
      reference,
      amount: packConfig.priceUsdc,
      credits: packConfig.credits,
      token: "USDC",
    });
  } catch (err) {
    console.error("Pay initiate error:", err);
    return NextResponse.json(
      { error: "Failed to initiate payment" },
      { status: 500 }
    );
  }
}
