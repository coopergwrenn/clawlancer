import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

// Prevent Vercel CDN from caching per-user responses
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();

  // Get user wizard state
  const { data: user } = await supabase
    .from("instaclaw_users")
    .select(
      "onboarding_wizard_completed, onboarding_wizard_step, gmail_popup_dismissed, gmail_connected"
    )
    .eq("id", session.user.id)
    .single();

  if (!user) {
    return NextResponse.json({ shouldShow: false });
  }

  // Already completed — don't show
  if (user.onboarding_wizard_completed) {
    return NextResponse.json({ shouldShow: false });
  }

  // Get VM info for bot username and chat_id
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("telegram_bot_username, telegram_bot_token, telegram_chat_id")
    .eq("assigned_to", session.user.id)
    .single();

  // No VM assigned yet — don't show wizard (still in deploy flow)
  if (!vm) {
    return NextResponse.json({ shouldShow: false });
  }

  return NextResponse.json({
    shouldShow: true,
    currentStep: user.onboarding_wizard_step ?? 0,
    telegramBotUsername: vm.telegram_bot_username ?? null,
    botConnected: !!vm.telegram_chat_id,
    gmailPopupDismissed: user.gmail_popup_dismissed ?? false,
    gmailConnected: !!user.gmail_connected,
  });
}
