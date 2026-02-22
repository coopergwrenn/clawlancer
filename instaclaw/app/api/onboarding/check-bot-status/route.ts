import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { discoverTelegramChatId } from "@/lib/telegram";

// Prevent Vercel CDN from caching per-user responses
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();

  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id, telegram_bot_token, telegram_bot_username, telegram_chat_id, gateway_url, health_status")
    .eq("assigned_to", session.user.id)
    .single();

  if (!vm || !vm.telegram_bot_token) {
    return NextResponse.json({ connected: false, botUsername: null });
  }

  // Already have a chat_id — bot is connected
  if (vm.telegram_chat_id) {
    return NextResponse.json({
      connected: true,
      botUsername: vm.telegram_bot_username,
    });
  }

  // If gateway is running, do NOT call getUpdates — it conflicts with
  // the gateway's own long-polling on the same bot token, causing
  // "[telegram] getUpdates conflict" errors.
  const gatewayActive = !!(vm.gateway_url && vm.health_status === "healthy");
  if (gatewayActive) {
    // Gateway is long-polling — assume bot is connected but we can't discover chat_id right now.
    // It will be discovered when the user sends their first message via Telegram.
    return NextResponse.json({
      connected: true,
      botUsername: vm.telegram_bot_username,
    });
  }

  // Gateway is not active — safe to call getUpdates for chat_id discovery
  const chatId = await discoverTelegramChatId(vm.telegram_bot_token);

  if (chatId) {
    // Save it so we don't need to poll again
    await supabase
      .from("instaclaw_vms")
      .update({ telegram_chat_id: chatId })
      .eq("id", vm.id);

    return NextResponse.json({
      connected: true,
      botUsername: vm.telegram_bot_username,
    });
  }

  return NextResponse.json({
    connected: false,
    botUsername: vm.telegram_bot_username,
  });
}
