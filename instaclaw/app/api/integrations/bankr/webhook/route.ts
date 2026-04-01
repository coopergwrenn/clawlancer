import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import crypto from "crypto";

export const maxDuration = 15;

// HMAC-SHA256 signature verification for Bankr webhooks
function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(signature, "hex"),
    Buffer.from(expected, "hex")
  );
}

// Convert USDC amount to InstaClaw credits
function usdcToCredits(amountUsdc: string): number {
  const creditsPerDollar = parseInt(process.env.BANKR_CREDITS_PER_DOLLAR ?? "250", 10);
  const usdcValue = parseFloat(amountUsdc);
  if (isNaN(usdcValue) || usdcValue <= 0) return 0;
  return Math.floor(usdcValue * creditsPerDollar);
}

interface BankrWebhookEvent {
  event: string;
  wallet_id: string;
  amount_usdc: string;
  trade_id: string;
  token_address?: string;
  timestamp: string;
}

export async function POST(req: NextRequest) {
  const webhookSecret = process.env.BANKR_WEBHOOK_SECRET;
  if (!webhookSecret) {
    logger.error("BANKR_WEBHOOK_SECRET not configured");
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
  }

  // Read raw body for signature verification
  const rawBody = await req.text();
  const signature = req.headers.get("x-bankr-signature") ?? "";

  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }

  // Verify HMAC signature
  try {
    if (!verifySignature(rawBody, signature, webhookSecret)) {
      logger.warn("Bankr webhook signature mismatch");
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  } catch {
    logger.warn("Bankr webhook signature verification error");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let event: BankrWebhookEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Route by event type
  switch (event.event) {
    case "trading_fee": {
      return handleTradingFee(event);
    }
    default: {
      // Acknowledge unknown events gracefully (Bankr may add new event types)
      logger.info("Bankr webhook: unknown event type", { event: event.event });
      return NextResponse.json({ received: true });
    }
  }
}

async function handleTradingFee(event: BankrWebhookEvent) {
  const { wallet_id, amount_usdc, trade_id } = event;

  if (!wallet_id || !amount_usdc || !trade_id) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const credits = usdcToCredits(amount_usdc);
  if (credits <= 0) {
    return NextResponse.json({ received: true, credits: 0 });
  }

  const supabase = getSupabase();

  // Look up VM by Bankr wallet ID
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id, assigned_to")
    .eq("bankr_wallet_id", wallet_id)
    .single();

  if (!vm) {
    logger.warn("Bankr webhook: no VM found for wallet", { wallet_id });
    return NextResponse.json({ error: "Wallet not found" }, { status: 404 });
  }

  // Idempotent credit injection — reference_id prevents double-crediting
  const referenceId = `bankr_fee_${trade_id}`;
  const { data: newBalance, error } = await supabase.rpc("instaclaw_add_credits", {
    p_vm_id: vm.id,
    p_credits: credits,
    p_reference_id: referenceId,
    p_source: "bankr_trading_fee",
  });

  if (error) {
    logger.error("Bankr webhook: credit injection failed", {
      vm_id: vm.id,
      trade_id,
      error: error.message,
    });
    return NextResponse.json({ error: "Credit injection failed" }, { status: 500 });
  }

  logger.info("Bankr trading fee credited", {
    vm_id: vm.id,
    trade_id,
    amount_usdc,
    credits,
    new_balance: newBalance,
  });

  return NextResponse.json({
    received: true,
    credits,
    new_balance: newBalance,
  });
}
