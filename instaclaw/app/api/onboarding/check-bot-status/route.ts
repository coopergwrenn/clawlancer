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
    .select("id, telegram_bot_token, telegram_bot_username, telegram_chat_id")
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

  // Try to discover chat_id via getUpdates
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
