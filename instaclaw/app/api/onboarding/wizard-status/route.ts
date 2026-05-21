import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { getUserVm } from "@/lib/get-user-vm";

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

  // Check for pending onboarding record (pre-checkout)
  const { data: pending } = await supabase
    .from("instaclaw_pending_users")
    .select("telegram_bot_token, telegram_bot_username, discord_bot_token, api_mode, tier, default_model")
    .eq("user_id", session.user.id)
    .is("consumed_at", null)
    .single();

  // Get VM info for bot username and chat_id. Terminal rows are filtered
  // so a terminated VM doesn't keep the wizard locked into a stale state.
  const vm = await getUserVm<{
    telegram_bot_username: string | null;
    telegram_bot_token: string | null;
    telegram_chat_id: string | null;
  }>(supabase, session.user.id, {
    columns: "telegram_bot_username, telegram_bot_token, telegram_chat_id",
  });

  // No VM assigned yet — don't show wizard (still in deploy flow)
  if (!vm) {
    return NextResponse.json({ shouldShow: false, pending: pending ?? undefined });
  }

  // Kill-switch: set GMAIL_POPUP_DISABLED=true in Vercel env to suppress the
  // "Personalize your agent" auto-popup fleet-wide. Used when the Google OAuth
  // client is blocked/suspended and the popup would route every new user into
  // a dead-end "This app is blocked" screen. Forces gmailPopupDismissed=true
  // so the popup early-outs and the onboarding wizard treats this step done.
  const gmailPopupKilled = process.env.GMAIL_POPUP_DISABLED === "true";

  return NextResponse.json({
    shouldShow: true,
    currentStep: user.onboarding_wizard_step ?? 0,
    telegramBotUsername: vm.telegram_bot_username ?? null,
    botConnected: !!vm.telegram_chat_id,
    gmailPopupDismissed: gmailPopupKilled ? true : (user.gmail_popup_dismissed ?? false),
    gmailConnected: !!user.gmail_connected,
    pending: pending ?? undefined,
  });
}
