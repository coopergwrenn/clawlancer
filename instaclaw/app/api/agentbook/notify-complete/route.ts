import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { isAgentRegistered } from "@/lib/agentbook";
import { logger } from "@/lib/logger";
import type { Address } from "viem";

export const dynamic = "force-dynamic";

const WORLD_APP_ID = process.env.NEXT_PUBLIC_APP_ID || "app_a4e2de774b1bda0426e78cda2ddb8cfd";
const NOTIFICATION_API = "https://developer.worldcoin.org/api/v2/minikit/send-notification";

/**
 * GET /api/agentbook/notify-complete?wallet=0x...
 *
 * Called by the CLI launcher script after successful registration.
 * Verifies on-chain, updates DB, and sends push notification.
 */
export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet");
  if (!wallet) {
    return NextResponse.json({ error: "Missing wallet" }, { status: 400 });
  }

  const supabase = getSupabase();

  try {
    // Verify on-chain (World Chain)
    const registered = await isAgentRegistered(wallet as Address, "worldchain");
    if (!registered) {
      // Maybe still pending — check again in a moment
      return NextResponse.json({ registered: false, message: "Not yet on-chain" });
    }

    // Get VM + user info
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, assigned_to, agentbook_registered")
      .eq("agentbook_wallet_address", wallet)
      .single();

    if (!vm) {
      return NextResponse.json({ error: "VM not found for wallet" }, { status: 404 });
    }

    // Update DB if not already marked
    if (!vm.agentbook_registered) {
      await supabase
        .from("instaclaw_vms")
        .update({
          agentbook_registered: true,
          agentbook_registered_at: new Date().toISOString(),
        })
        .eq("id", vm.id);
    }

    // Get user's World App wallet address for notification
    let notified = false;
    if (vm.assigned_to) {
      const { data: user } = await supabase
        .from("instaclaw_users")
        .select("world_wallet_address")
        .eq("id", vm.assigned_to)
        .single();

      const worldWallet = user?.world_wallet_address;
      if (worldWallet) {
        notified = await sendNotification(worldWallet);
      } else {
        logger.warn("No world_wallet_address for notification", {
          userId: vm.assigned_to,
          route: "agentbook/notify-complete",
        });
      }
    }

    logger.info("AgentBook registration complete", {
      wallet,
      vmId: vm.id,
      notified,
      route: "agentbook/notify-complete",
    });

    return NextResponse.json({ registered: true, notified });
  } catch (err) {
    logger.error("notify-complete error", {
      error: String(err),
      wallet,
      route: "agentbook/notify-complete",
    });
    return NextResponse.json({ error: String(err).slice(0, 200) }, { status: 500 });
  }
}

async function sendNotification(walletAddress: string): Promise<boolean> {
  const apiKey = process.env.DEV_PORTAL_API_KEY;
  if (!apiKey) {
    logger.warn("DEV_PORTAL_API_KEY not set — skipping notification");
    return false;
  }

  try {
    const res = await fetch(NOTIFICATION_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        app_id: WORLD_APP_ID,
        wallet_addresses: [walletAddress],
        title: "Agent Registered!",
        message: "Your agent is now verified in AgentBook. Tap to see your badge.",
        mini_app_path: `worldapp://mini-app?app_id=${WORLD_APP_ID}`,
      }),
    });

    const data = await res.json().catch(() => ({}));
    logger.info("Notification API response", {
      status: res.status,
      data: JSON.stringify(data).slice(0, 500),
      walletAddress,
      route: "agentbook/notify-complete",
    });
    return res.ok;
  } catch (err) {
    logger.warn("Failed to send notification (non-fatal)", {
      error: String(err),
      route: "agentbook/notify-complete",
    });
    return false;
  }
}
