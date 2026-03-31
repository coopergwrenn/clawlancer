import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { supabase } from "@/lib/supabase";
import { proxyToInstaclaw } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/xmtp/init-chat
 *
 * Initiates a World Chat conversation by having the agent send the
 * first message to the user's wallet address. This establishes the
 * XMTP DM so the user can then reply.
 *
 * Called before MiniKit.commandsAsync.chat() opens World Chat.
 */
export async function POST() {
  try {
    const session = await requireSession();

    // Get user's wallet address and agent's XMTP address
    const { data: vm } = await supabase()
      .from("instaclaw_vms")
      .select("id, xmtp_address")
      .eq("assigned_to", session.userId)
      .single();

    if (!vm?.xmtp_address) {
      return NextResponse.json(
        { error: "Agent doesn't have World Chat enabled yet" },
        { status: 404 }
      );
    }

    // Send initial message from agent to user via production API
    const res = await proxyToInstaclaw("/api/admin/xmtp-send-to-user", session.userId, {
      method: "POST",
      body: JSON.stringify({
        vmId: vm.id,
        targetAddress: session.walletAddress,
        message: "Hey! I'm your InstaClaw agent. You can chat with me right here in World Chat — same AI, same skills, same memory as Telegram and the mini app.",
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error("[XMTP/init-chat] Failed:", res.status, errText);
      return NextResponse.json(
        { error: "Failed to initialize chat" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      xmtpAddress: vm.xmtp_address,
    });
  } catch (err) {
    if (err instanceof Error && err.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("[XMTP/init-chat] Error:", err);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
