import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { configureOpenClaw, waitForHealth, migrateUserData, testProxyRoundTrip } from "@/lib/ssh";
import { validateAdminKey, decryptApiKey } from "@/lib/security";
import { logger } from "@/lib/logger";
import { sendVMReadyEmail, sendAdminAlertEmail } from "@/lib/email";

// SSH + configure-vm.sh + health check + optional data migration can take 60-150s
export const maxDuration = 180;

export async function POST(req: NextRequest) {
  // This endpoint is called internally by the billing webhook and cron jobs.
  // Require an admin API key for authentication.
  if (!validateAdminKey(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let userId: string | undefined;

  try {
    const body = await req.json();
    userId = body.userId;

    if (!userId || typeof userId !== "string") {
      return NextResponse.json({ error: "userId required" }, { status: 400 });
    }

    const supabase = getSupabase();

    // Get user's VM
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("*")
      .eq("assigned_to", userId)
      .single();

    if (!vm) {
      return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
    }

    // Rate limiting: max 3 configure attempts per 10 minutes
    const configureAttempts = vm.configure_attempts ?? 0;
    const lastConfigureTime = vm.last_health_check
      ? new Date(vm.last_health_check).getTime()
      : 0;
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;

    if (configureAttempts >= 3 && lastConfigureTime > tenMinutesAgo) {
      logger.warn("Configure rate limit exceeded", {
        route: "vm/configure",
        userId,
        attempts: configureAttempts,
      });
      return NextResponse.json(
        {
          error: "Too many configuration attempts. Please wait 10 minutes and try again.",
          retryAfter: Math.ceil((lastConfigureTime + 10 * 60 * 1000 - Date.now()) / 1000),
        },
        { status: 429 }
      );
    }

    // Get pending user config (may not exist — e.g. user paid but didn't
    // finish the onboarding wizard). Fall back to sensible defaults.
    const { data: pending } = await supabase
      .from("instaclaw_pending_users")
      .select("*")
      .eq("user_id", userId)
      .single();

    // If no pending config, build defaults from subscription + VM data
    const { data: subscription } = !pending
      ? await supabase
          .from("instaclaw_subscriptions")
          .select("tier, status")
          .eq("user_id", userId)
          .single()
      : { data: null };

    const effectiveTier = pending?.tier ?? subscription?.tier ?? vm.tier ?? "starter";
    const effectiveApiMode = pending?.api_mode ?? vm.api_mode ?? "all_inclusive";
    const effectiveModel = pending?.default_model ?? vm.default_model ?? "claude-sonnet-4-5-20250929";
    const effectiveTelegramToken = pending?.telegram_bot_token ?? undefined;
    const effectiveDiscordToken = pending?.discord_bot_token ?? undefined;

    // Determine channels
    const channels: string[] = [];
    if (effectiveTelegramToken) channels.push("telegram");
    if (effectiveDiscordToken) channels.push("discord");
    // No channels is fine — gateway runs without messaging, user adds later

    // Fetch Gmail personality profile if user connected Gmail during onboarding
    let gmailProfileSummary: string | undefined;
    const { data: userProfile } = await supabase
      .from("instaclaw_users")
      .select("gmail_profile_summary, gmail_insights")
      .eq("id", userId)
      .single();

    if (userProfile?.gmail_profile_summary) {
      const insights: string[] = userProfile.gmail_insights ?? [];
      gmailProfileSummary = [
        "## About My User (from onboarding)",
        "",
        userProfile.gmail_profile_summary,
        "",
        "### Quick Profile",
        ...insights.map((i: string) => `- ${i}`),
        "",
        "Use this context to personalize all interactions. You already know this person — act like it.",
      ].join("\n");
    }

    if (!pending) {
      logger.info("No pending config — configuring VM with defaults", {
        route: "vm/configure",
        userId,
        tier: effectiveTier,
        apiMode: effectiveApiMode,
        channels,
      });
    }

    // Decrypt BYOK API key if present (stored encrypted in DB)
    const decryptedApiKey = pending?.api_key
      ? await decryptApiKey(pending.api_key)
      : undefined;

    // Configure OpenClaw on the VM
    const result = await configureOpenClaw(vm, {
      telegramBotToken: effectiveTelegramToken,
      apiMode: effectiveApiMode,
      apiKey: decryptedApiKey,
      tier: effectiveTier,
      model: effectiveModel,
      discordBotToken: effectiveDiscordToken,
      channels,
      gmailProfileSummary,
    });

    // ── Critical DB updates first (before any health check) ──
    // This ensures gateway info is persisted even if the function times out
    // during the health check phase.
    await supabase
      .from("instaclaw_vms")
      .update({
        health_status: "configuring",
        last_health_check: new Date().toISOString(),
        telegram_bot_username: pending?.telegram_bot_username ?? null,
        telegram_bot_token: effectiveTelegramToken ?? null,
        discord_bot_token: effectiveDiscordToken ?? null,
        channels_enabled: channels,
        configure_attempts: 0,
        default_model: effectiveModel,
        api_mode: effectiveApiMode,
        tier: effectiveTier,
      })
      .eq("id", vm.id);

    // Mark user as onboarding complete + clean up pending record + clear deployment lock.
    // Do this BEFORE the health check so it's saved even if we time out.
    await supabase
      .from("instaclaw_users")
      .update({
        onboarding_complete: true,
        deployment_lock_at: null, // Clear deployment lock
      })
      .eq("id", userId);

    if (pending) {
      await supabase
        .from("instaclaw_pending_users")
        .delete()
        .eq("user_id", userId);
    }

    // ── Migrate user data from previous VM (best-effort) ──
    // If the user previously had a VM (cancelled + re-subscribed), copy their
    // workspace, sessions, media, and subagents to the new VM.
    const { data: previousVm } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, ssh_port, ssh_user")
      .eq("last_assigned_to", userId)
      .neq("id", vm.id)
      .limit(1)
      .single();

    if (previousVm) {
      try {
        const migrationResult = await migrateUserData(previousVm, vm);
        logger.info("User data migrated from previous VM", {
          route: "vm/configure",
          userId,
          sourceVm: previousVm.id,
          targetVm: vm.id,
          ...migrationResult,
        });
        // Clear last_assigned_to after successful migration
        await supabase
          .from("instaclaw_vms")
          .update({ last_assigned_to: null })
          .eq("id", previousVm.id);
      } catch (migErr) {
        logger.error("Migration failed (non-blocking)", {
          route: "vm/configure",
          userId,
          sourceVm: previousVm.id,
          targetVm: vm.id,
          error: String(migErr),
        });
      }
    }

    // ── Quick health check (3 attempts × 3s = 9s max) ──
    // If the gateway comes up fast, the user sees instant completion.
    // If not, the health-check cron will upgrade "configuring" → "healthy".
    const healthy = await waitForHealth(vm, result.gatewayToken, 3, 3000);

    if (healthy) {
      // Proxy round-trip test: verify the full chain (gateway token → proxy → Anthropic)
      // Only for all-inclusive VMs that route through our proxy
      let proxyOk = true;
      if (effectiveApiMode === "all_inclusive") {
        const proxyResult = await testProxyRoundTrip(result.gatewayToken);
        proxyOk = proxyResult.success;

        if (!proxyOk) {
          logger.error("Proxy round-trip test failed after configure", {
            route: "vm/configure",
            userId,
            vmId: vm.id,
            error: proxyResult.error,
          });

          await supabase
            .from("instaclaw_vms")
            .update({
              health_status: "unhealthy",
              last_health_check: new Date().toISOString(),
            })
            .eq("id", vm.id);

          sendAdminAlertEmail(
            "Proxy Round-Trip Failed After Configure",
            `VM ${vm.id} (user: ${userId}) passed local health check but failed proxy round-trip.\n\nError: ${proxyResult.error}\n\nThe health cron will auto-restart the gateway on the next cycle.`
          ).catch(() => {});
        }
      }

      if (proxyOk) {
        await supabase
          .from("instaclaw_vms")
          .update({
            health_status: "healthy",
            last_health_check: new Date().toISOString(),
          })
          .eq("id", vm.id);

        // Send deployment success email
        const { data: user } = await supabase
          .from("instaclaw_users")
          .select("email")
          .eq("id", userId)
          .single();

        if (user?.email) {
          try {
            await sendVMReadyEmail(user.email, `${process.env.NEXTAUTH_URL}/dashboard`);
          } catch (emailErr) {
            logger.error("Failed to send VM ready email", {
              error: String(emailErr),
              route: "vm/configure",
              userId,
            });
          }
        }
      }
    }

    return NextResponse.json({
      configured: true,
      healthy,
    });
  } catch (err) {
    logger.error("VM configure error", { error: String(err), route: "vm/configure", userId });

    // Mark VM as configure_failed so cron and user retry can pick it up
    if (userId) {
      try {
        const sb = getSupabase();
        const { data: failedVm } = await sb
          .from("instaclaw_vms")
          .select("id, configure_attempts")
          .eq("assigned_to", userId)
          .single();

        if (failedVm) {
          await sb
            .from("instaclaw_vms")
            .update({
              health_status: "configure_failed",
              configure_attempts: (failedVm.configure_attempts ?? 0) + 1,
              last_health_check: new Date().toISOString(),
            })
            .eq("id", failedVm.id);
        }
      } catch {
        // Best-effort — don't mask the original error
      }
    }

    const errMsg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to configure VM", detail: errMsg },
      { status: 500 }
    );
  }
}
