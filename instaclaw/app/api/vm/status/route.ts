import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { TIER_DISPLAY, Tier, ApiMode } from "@/lib/stripe";
import { logger } from "@/lib/logger";

// This endpoint is polled every 2s by the deploying page. Keep it fast —
// Supabase queries only, NO external API calls (Stripe, Telegram, etc.).
// Prevent Vercel CDN from caching per-user responses
export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();

    // Check if user has an assigned VM
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select(
        "id, ip_address, gateway_url, control_ui_url, status, health_status, last_health_check, assigned_at, telegram_bot_username, configure_attempts, default_model, api_mode, system_prompt, channels_enabled, discord_bot_token, brave_api_key, agdp_enabled"
      )
      .eq("assigned_to", session.user.id)
      .single();

    if (vm) {
      // Fetch subscription info for billing display
      const { data: sub } = await supabase
        .from("instaclaw_subscriptions")
        .select("tier, status, payment_status, current_period_end, stripe_subscription_id, trial_ends_at")
        .eq("user_id", session.user.id)
        .single();

      // Build billing info — use only Supabase data, never call Stripe here.
      // The renewal date is synced to current_period_end by the
      // customer.subscription.updated webhook. If it's missing, return null.
      // This endpoint is polled every 2s during deployment — calling Stripe
      // on each poll would hit rate limits (100 req/s) with ~67 concurrent users.
      let billing = null;
      if (sub) {
        const tierKey = sub.tier as Tier;
        const tierDisplay = TIER_DISPLAY[tierKey];
        const apiMode = (vm.api_mode ?? "all_inclusive") as ApiMode;
        const price = tierDisplay
          ? apiMode === "byok"
            ? tierDisplay.byok
            : tierDisplay.allInclusive
          : null;

        billing = {
          tier: sub.tier,
          tierName: tierDisplay?.name ?? sub.tier,
          apiMode,
          price,
          status: sub.status,
          paymentStatus: sub.payment_status ?? "current",
          renewalDate: sub.current_period_end ?? null,
          trialEndsAt: sub.trial_ends_at ?? null,
        };
      }

      // Fetch World ID verification status + Gmail connection status
      const { data: userProfile } = await supabase
        .from("instaclaw_users")
        .select("world_id_verified, world_id_verification_level, world_id_verified_at, gmail_connected, gmail_popup_dismissed")
        .eq("id", session.user.id)
        .single();

      return NextResponse.json({
        status: "assigned",
        vm: {
          id: vm.id,
          gatewayUrl: vm.gateway_url,
          controlUiUrl: vm.control_ui_url,
          healthStatus: vm.health_status,
          lastHealthCheck: vm.last_health_check,
          assignedAt: vm.assigned_at,
          telegramBotUsername: vm.telegram_bot_username,
          configureAttempts: vm.configure_attempts ?? 0,
          model: vm.default_model ?? null,
          apiMode: vm.api_mode ?? null,
          systemPrompt: vm.system_prompt ?? null,
          channelsEnabled: vm.channels_enabled ?? ["telegram"],
          hasDiscord: !!vm.discord_bot_token,
          hasBraveSearch: !!vm.brave_api_key,
          agdpEnabled: vm.agdp_enabled ?? false,
          worldIdVerified: userProfile?.world_id_verified ?? false,
          worldIdVerificationLevel: userProfile?.world_id_verification_level ?? null,
          worldIdVerifiedAt: userProfile?.world_id_verified_at ?? null,
          gmailConnected: userProfile?.gmail_connected ?? false,
          gmailPopupDismissed: userProfile?.gmail_popup_dismissed ?? true,
        },
        billing,
      });
    }

    // Check if user is pending
    const { data: pending } = await supabase
      .from("instaclaw_pending_users")
      .select("created_at, stripe_session_id")
      .eq("user_id", session.user.id)
      .single();

    if (pending) {
      return NextResponse.json({
        status: "pending",
        since: pending.created_at,
        stripeSessionId: pending.stripe_session_id,
      });
    }

    // No VM, no pending user - shouldn't happen but handle it
    return NextResponse.json({ status: "no_user" });
  } catch (err) {
    logger.error("VM status error", { error: String(err), route: "vm/status" });
    return NextResponse.json(
      { error: "Failed to check VM status" },
      { status: 500 }
    );
  }
}
