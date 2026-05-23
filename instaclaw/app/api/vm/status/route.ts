import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { getUserVm } from "@/lib/get-user-vm";
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

    // Check if user has an assigned VM. getUserVm filters out terminal rows
    // so the dashboard layout (Rule 33) doesn't keep routing users to
    // /deploying for a VM whose Linode was destroyed.
    const vm = await getUserVm<{
      id: string;
      ip_address: string | null;
      gateway_url: string | null;
      control_ui_url: string | null;
      gateway_token: string | null;
      status: string;
      health_status: string | null;
      last_health_check: string | null;
      assigned_at: string | null;
      telegram_bot_username: string | null;
      configure_attempts: number | null;
      default_model: string | null;
      api_mode: string | null;
      system_prompt: string | null;
      channels_enabled: string[] | null;
      discord_bot_token: string | null;
      brave_api_key: string | null;
      agdp_enabled: boolean | null;
      bankr_wallet_id: string | null;
      bankr_evm_address: string | null;
      bankr_token_address: string | null;
      bankr_token_symbol: string | null;
      bankr_token_image_url: string | null;
      tokenization_platform: string | null;
      created_via: string | null;
    }>(supabase, session.user.id, {
      columns:
        "id, ip_address, gateway_url, control_ui_url, gateway_token, status, health_status, last_health_check, assigned_at, telegram_bot_username, configure_attempts, default_model, api_mode, system_prompt, channels_enabled, discord_bot_token, brave_api_key, agdp_enabled, bankr_wallet_id, bankr_evm_address, bankr_token_address, bankr_token_symbol, bankr_token_image_url, tokenization_platform, created_via",
    });

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

      // Fetch World ID verification status + Gmail connection status +
      // index_last_intent_at (used by the dashboard layout's Edge intent gate
      // for live-DB verification — see the 2026-05-23 fix to layout.tsx
      // for why the gate can't trust session.user.indexLastIntentAt alone).
      const { data: userProfile } = await supabase
        .from("instaclaw_users")
        .select("world_id_verified, world_id_verification_level, world_id_verified_at, gmail_connected, gmail_popup_dismissed, index_last_intent_at")
        .eq("id", session.user.id)
        .single();

      // Kill-switch: GMAIL_POPUP_DISABLED=true forces gmailPopupDismissed=true
      // fleet-wide. Mirrors the same gate in /api/onboarding/wizard-status.
      // Used when Google OAuth is blocked and the popup would dead-end new users.
      const gmailPopupKilled = process.env.GMAIL_POPUP_DISABLED === "true";

      // 2026-05-22 TASK 9 feature flag: GMAIL_PERSONALIZATION_ENABLED gates
      // whether the Gmail card in the dual-option personalization popup is
      // clickable. Defaults to false (Gmail grayed out with "temporarily
      // unavailable - back soon" tag) so we never accidentally surface the
      // unverified-app warning if Google OAuth verification status changes.
      // ChatGPT card stays fully active regardless. Independent of
      // GMAIL_POPUP_DISABLED above (that controls whether the popup
      // appears AT ALL; this controls whether the Gmail OPTION within
      // the popup is interactive).
      const gmailPersonalizationEnabled =
        process.env.GMAIL_PERSONALIZATION_ENABLED === "true";

      // 🟧 SMOKING-GUN (2026-05-23) — capture EXACT server-side computation
      // of gmailPopupDismissed for Cooper's debug. Logs to Vercel function logs.
      const gmailPopupDismissedComputed = gmailPopupKilled
        ? true
        : (userProfile?.gmail_popup_dismissed ?? false);
      console.log("🟧 STATUS_ROUTE_GMAIL_DISMISSED", {
        userId: session.user.id?.slice(0, 8),
        rawDbValue: userProfile?.gmail_popup_dismissed,
        rawDbType: typeof userProfile?.gmail_popup_dismissed,
        envKillSwitchRaw: JSON.stringify(process.env.GMAIL_POPUP_DISABLED),
        gmailPopupKilled,
        computedReturn: gmailPopupDismissedComputed,
        ts: new Date().toISOString(),
      });

      return NextResponse.json({
        status: "assigned",
        // 2026-05-23: top-level `user` payload for live-DB verification of
        // session-cached fields. The dashboard layout's Edge intent gate
        // reads `user.indexLastIntentAt` to bypass stale session state
        // after `/edge/intents` submission — without this, the gate
        // bounces the user back to /edge/intents (whose server component
        // then redirects back to /dashboard since intent IS set in DB)
        // in an infinite loop. See layout.tsx intent-gate useEffect.
        user: {
          indexLastIntentAt: userProfile?.index_last_intent_at ?? null,
        },
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
          gmailPopupDismissed: gmailPopupKilled ? true : (userProfile?.gmail_popup_dismissed ?? false),
          gmailPersonalizationEnabled,
          bankrWalletId: vm.bankr_wallet_id ?? null,
          bankrEvmAddress: vm.bankr_evm_address ?? null,
          bankrTokenAddress: liveTokenAddress ?? null,
          bankrTokenSymbol: liveTokenSymbol ?? null,
          bankrTokenImageUrl: vm.bankr_token_image_url ?? null,
          tokenizationPlatform: liveTokenizationPlatform ?? null,
          // 2026-05-16: surfaces the cloud-init discriminator so the deploying
          // page can apply cloud-init-aware thresholds (longer soft-timeout
          // window because setup.sh runs T+2-8min, vs pool-path's <60s).
          createdVia: vm.created_via ?? null,
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
