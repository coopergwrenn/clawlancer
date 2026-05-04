import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { TIER_DISPLAY, Tier, ApiMode } from "@/lib/stripe";
import { logger } from "@/lib/logger";
import { syncBankrLaunchForVm } from "@/lib/bankr-launch-sync";

// This endpoint is polled every 2s by the deploying page. Keep it fast —
// Supabase queries only, NO external API calls (Stripe, Telegram, etc.).
//
// One narrow exception: when a VM has a Bankr wallet but no recorded
// token, we ping Bankr's public creator-fees endpoint to detect chat-driven
// launches. The check is bounded to that one population (excludes deploy-
// page pollers, who have no wallet yet) and the result is cached implicitly
// — once the token is set, this branch never fires again for that VM.
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
        "id, ip_address, gateway_url, control_ui_url, gateway_token, status, health_status, last_health_check, assigned_at, telegram_bot_username, configure_attempts, default_model, api_mode, system_prompt, channels_enabled, discord_bot_token, brave_api_key, agdp_enabled, bankr_wallet_id, bankr_evm_address, bankr_token_address, bankr_token_symbol, tokenization_platform"
      )
      .eq("assigned_to", session.user.id)
      .single();

    if (vm) {
      // ── Path B detection: chat-driven Bankr token launches ────────────
      // If this VM has a wallet but no recorded token, ask Bankr whether
      // the agent ran `bankr launch` outside our /api/bankr/tokenize flow.
      // syncBankrLaunchForVm is idempotent and race-safe; it returns
      // updated:true exactly when this call performed the DB write that
      // discovered the launch — that's the celebration trigger.
      //
      // Wrapped defensively: any failure (Bankr API down, DB hiccup) must
      // not block the status response. We log and move on.
      let freshLaunch: { tokenAddress: string; tokenSymbol: string; launchNumber?: number } | null = null;
      let liveTokenAddress = vm.bankr_token_address;
      let liveTokenSymbol = vm.bankr_token_symbol;
      let liveTokenizationPlatform = vm.tokenization_platform;
      // DISABLE_BANKR_PATH_B_SYNC: temporary kill-switch used during the
      // 2026-05-04 announcement-record window. When Cooper needs to re-launch
      // his demo agent, his TESTER token still exists on-chain so Bankr's
      // creator-fees API rediscovers it within ~1s and writes back the old
      // address before he can click. Setting this env to "true" pauses the
      // on-demand sync inside /api/vm/status. Cron sync still runs.
      const disablePathBSync = process.env.DISABLE_BANKR_PATH_B_SYNC === "true";
      if (!disablePathBSync && vm.bankr_wallet_id && !vm.bankr_token_address && !vm.tokenization_platform) {
        try {
          const sync = await syncBankrLaunchForVm(vm.id);
          if (sync.updated && sync.tokenAddress && sync.tokenSymbol) {
            freshLaunch = {
              tokenAddress: sync.tokenAddress,
              tokenSymbol: sync.tokenSymbol,
              launchNumber: sync.launchNumber,
            };
            liveTokenAddress = sync.tokenAddress;
            liveTokenSymbol = sync.tokenSymbol;
            liveTokenizationPlatform = "bankr";
            logger.info("vm/status: discovered chat-driven launch on demand", {
              userId: session.user.id,
              vmId: vm.id,
              tokenAddress: sync.tokenAddress,
              launchNumber: sync.launchNumber,
            });
          }
        } catch (syncErr) {
          logger.error("vm/status: bankr launch sync threw", {
            route: "vm/status",
            vmId: vm.id,
            error: syncErr instanceof Error ? syncErr.message : String(syncErr),
          });
        }
      }

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
          gatewayToken: vm.gateway_token ?? null,
          worldIdVerified: userProfile?.world_id_verified ?? false,
          worldIdVerificationLevel: userProfile?.world_id_verification_level ?? null,
          worldIdVerifiedAt: userProfile?.world_id_verified_at ?? null,
          gmailConnected: userProfile?.gmail_connected ?? false,
          gmailPopupDismissed: userProfile?.gmail_popup_dismissed ?? true,
          bankrWalletId: vm.bankr_wallet_id ?? null,
          bankrEvmAddress: vm.bankr_evm_address ?? null,
          bankrTokenAddress: liveTokenAddress ?? null,
          bankrTokenSymbol: liveTokenSymbol ?? null,
          tokenizationPlatform: liveTokenizationPlatform ?? null,
        },
        billing,
        freshLaunch,
      });
    }

    // Check if user is pending
    const { data: pending } = await supabase
      .from("instaclaw_pending_users")
      .select("created_at, stripe_session_id")
      .eq("user_id", session.user.id)
      .is("consumed_at", null)
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
