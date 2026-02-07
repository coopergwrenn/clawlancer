import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { getStripe, TIER_DISPLAY, Tier, ApiMode } from "@/lib/stripe";
import { logger } from "@/lib/logger";

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
        "id, ip_address, gateway_url, control_ui_url, status, health_status, last_health_check, assigned_at, telegram_bot_username, configure_attempts, default_model, api_mode, system_prompt, channels_enabled, discord_bot_token, brave_api_key"
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

      // Build billing info
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

        // Try to get current_period_end from Stripe for accurate renewal date
        let renewalDate = sub.current_period_end;
        if (!renewalDate && sub.stripe_subscription_id) {
          try {
            const stripe = getStripe();
            const stripeSub = await stripe.subscriptions.retrieve(
              sub.stripe_subscription_id
            );
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const periodEnd = (stripeSub as any).current_period_end as number | undefined;
            if (periodEnd) {
              renewalDate = new Date(periodEnd * 1000).toISOString();
            }
          } catch {
            // Non-fatal
          }
        }

        billing = {
          tier: sub.tier,
          tierName: tierDisplay?.name ?? sub.tier,
          apiMode,
          price,
          status: sub.status,
          paymentStatus: sub.payment_status ?? "current",
          renewalDate,
          trialEndsAt: sub.trial_ends_at ?? null,
        };
      }

      // Fetch World ID verification status
      const { data: userProfile } = await supabase
        .from("instaclaw_users")
        .select("world_id_verified, world_id_verification_level, world_id_verified_at")
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
          worldIdVerified: userProfile?.world_id_verified ?? false,
          worldIdVerificationLevel: userProfile?.world_id_verification_level ?? null,
          worldIdVerifiedAt: userProfile?.world_id_verified_at ?? null,
        },
        billing,
      });
    }

    // Check if user is pending
    const { data: pending } = await supabase
      .from("instaclaw_pending_users")
      .select("created_at")
      .eq("user_id", session.user.id)
      .single();

    if (pending) {
      return NextResponse.json({
        status: "pending",
        since: pending.created_at,
      });
    }

    // Check subscription status
    const { data: sub } = await supabase
      .from("instaclaw_subscriptions")
      .select("status, tier")
      .eq("user_id", session.user.id)
      .single();

    if (sub?.status === "active") {
      return NextResponse.json({
        status: "awaiting_config",
        tier: sub.tier,
      });
    }

    return NextResponse.json({ status: "no_subscription" });
  } catch (err) {
    logger.error("VM status error", { error: String(err), route: "vm/status" });
    return NextResponse.json(
      { error: "Failed to check VM status" },
      { status: 500 }
    );
  }
}
