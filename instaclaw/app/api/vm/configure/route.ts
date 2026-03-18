import { NextRequest, NextResponse, after } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { configureOpenClaw, migrateUserData, testProxyRoundTrip, setupTLSBackground } from "@/lib/ssh";
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
    const routeStart = Date.now();
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

    // Idempotency guard: skip configure if VM is already healthy and was
    // configured recently. Prevents redundant reconfigures from billing
    // webhooks, process-pending cron, and health cron auto-migration
    // from accidentally racing and wiping tokens.
    const isForced = body.force === true;
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    const lastConfigured = vm.last_health_check ? new Date(vm.last_health_check).getTime() : 0;

    if (
      !isForced &&
      vm.health_status === "healthy" &&
      vm.gateway_url &&
      lastConfigured > fiveMinutesAgo
    ) {
      logger.info("Configure skipped — VM already healthy and recently configured", {
        route: "vm/configure",
        userId,
        vmId: vm.id,
        healthStatus: vm.health_status,
        lastConfigured: new Date(lastConfigured).toISOString(),
      });
      return NextResponse.json({ configured: true, healthy: true, skipped: true });
    }

    // Get pending user config (may not exist — e.g. user paid but didn't
    // finish the onboarding wizard). Fall back to sensible defaults.
    const { data: pending } = await supabase
      .from("instaclaw_pending_users")
      .select("*")
      .eq("user_id", userId)
      .is("consumed_at", null) // Skip already-consumed records
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
    let effectiveModel = pending?.default_model ?? vm.default_model ?? "claude-sonnet-4-6";
    // Guard: never configure a VM with haiku as primary — intelligent routing handles model selection
    if (effectiveModel.includes("haiku")) {
      logger.warn("Configure endpoint: overriding haiku model to sonnet", {
        route: "vm/configure", userId, vmId: vm.id, originalModel: effectiveModel,
      });
      effectiveModel = "claude-sonnet-4-6";
    }
    // Preserve existing tokens when reconfiguring (pending record is deleted after first setup)
    const effectiveTelegramToken = pending?.telegram_bot_token ?? vm.telegram_bot_token ?? undefined;
    const effectiveDiscordToken = pending?.discord_bot_token ?? vm.discord_bot_token ?? undefined;

    // Determine channels — preserve any existing channels (slack, whatsapp) too
    const channels: string[] = [];
    if (effectiveTelegramToken) channels.push("telegram");
    if (effectiveDiscordToken) channels.push("discord");
    const existingChannels: string[] = vm.channels_enabled ?? [];
    for (const ch of existingChannels) {
      if (!channels.includes(ch)) channels.push(ch);
    }
    // No channels is fine — gateway runs without messaging, user adds later

    // Fetch Gmail personality profile if user connected Gmail during onboarding
    let gmailProfileSummary: string | undefined;
    const { data: userProfile } = await supabase
      .from("instaclaw_users")
      .select("gmail_profile_summary, gmail_insights, user_timezone")
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

    // Acquire configure lock — prevents concurrent configures on the same VM.
    // The lock expires after 5 minutes as a safety net.
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: lockResult, error: lockError } = await supabase
      .from("instaclaw_vms")
      .update({ configure_lock_at: new Date().toISOString() })
      .eq("id", vm.id)
      .eq("assigned_to", userId)
      .or(`configure_lock_at.is.null,configure_lock_at.lt.${fiveMinAgo}`)
      .select("id");

    // Handle lock acquisition errors gracefully.
    // If PostgREST schema cache is stale (column exists but not cached), skip the
    // lock and proceed — the lock is a safety net, not a hard requirement.
    if (lockError) {
      const errMsg = lockError.message || "";
      if (errMsg.includes("does not exist") || lockError.code === "42703") {
        logger.warn("Configure lock column not visible to PostgREST — skipping lock (schema cache stale)", {
          route: "vm/configure",
          userId,
          vmId: vm.id,
          dbError: errMsg,
        });
        // Proceed without lock — column exists in DB but PostgREST cache is stale.
        // Run: NOTIFY pgrst, 'reload schema' in Supabase SQL editor to fix permanently.
      } else {
        // Other DB errors — log and fail loudly
        logger.error("Configure lock query failed", {
          route: "vm/configure",
          userId,
          vmId: vm.id,
          dbError: errMsg,
          dbCode: lockError.code,
        });
        return NextResponse.json(
          { error: "Configure lock query failed", detail: errMsg },
          { status: 500 }
        );
      }
    } else if (!lockResult?.length) {
      logger.warn("Configure lock not acquired — concurrent configure in progress", {
        route: "vm/configure",
        userId,
        vmId: vm.id,
      });
      return NextResponse.json(
        { error: "VM is already being configured. Please wait." },
        { status: 409 }
      );
    }

    // Configure OpenClaw on the VM
    const configureStart = Date.now();
    const result = await configureOpenClaw(vm, {
      telegramBotToken: effectiveTelegramToken,
      apiMode: effectiveApiMode,
      apiKey: decryptedApiKey,
      tier: effectiveTier,
      model: effectiveModel,
      discordBotToken: effectiveDiscordToken,
      channels,
      gmailProfileSummary,
    }, userId);

    // ── Post-configure ownership re-verification ──
    // Verify the VM is still ours before writing supplemental updates, consuming
    // pending records, or sending emails. This is the final safety net.
    const { data: postConfigVm } = await supabase
      .from("instaclaw_vms")
      .select("assigned_to")
      .eq("id", vm.id)
      .single();

    if (postConfigVm?.assigned_to !== userId) {
      logger.error("CRITICAL: VM ownership changed during configure — aborting post-configure steps", {
        route: "vm/configure",
        userId,
        vmId: vm.id,
        currentOwner: postConfigVm?.assigned_to,
      });
      sendAdminAlertEmail(
        "CRITICAL: VM Ownership Race Condition Detected",
        `VM ${vm.id} was being configured for user ${userId} but is now assigned to ${postConfigVm?.assigned_to}.\n\nPost-configure steps (pending consumption, email) were NOT executed.`
      ).catch(() => {});
      return NextResponse.json(
        { error: "VM ownership changed during configuration" },
        { status: 403 }
      );
    }

    // ── Supplemental DB updates (configureOpenClaw already wrote the critical fields) ──
    // configureOpenClaw's atomic update already wrote: gateway_url, gateway_token,
    // health_status "healthy", telegram_bot_token, discord_bot_token, channels_enabled,
    // default_model, api_mode, tier. We only add fields not covered there.
    // Only write user-configured fields when a real value exists — never null-overwrite.
    const supplementalUpdate: Record<string, unknown> = {
      configure_attempts: 0,
    };
    // Only include configure_lock_at if the lock was successfully acquired earlier
    if (!lockError) {
      supplementalUpdate.configure_lock_at = null;
    }
    const effectiveUsername = pending?.telegram_bot_username ?? vm.telegram_bot_username;
    if (effectiveUsername) {
      supplementalUpdate.telegram_bot_username = effectiveUsername;
    }
    const effectiveTimezone = userProfile?.user_timezone ?? vm.user_timezone;
    if (effectiveTimezone) {
      supplementalUpdate.user_timezone = effectiveTimezone;
    }
    await supabase
      .from("instaclaw_vms")
      .update(supplementalUpdate)
      .eq("id", vm.id)
      .eq("assigned_to", userId);

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
      // Soft-consume instead of hard-delete — keeps the record available for
      // 24h in case a second configure fires and needs to re-read token data.
      // Consumed records are cleaned up by process-pending cron after 24h.
      await supabase
        .from("instaclaw_pending_users")
        .update({ consumed_at: new Date().toISOString() })
        .eq("user_id", userId);
    }

    // ── Background TLS setup (runs after response is sent) ──
    // configureOpenClaw() now returns HTTP URLs for instant completion.
    // TLS (GoDaddy DNS + Caddy) upgrades to HTTPS in the background.
    const tlsHostname = `${vm.id}.vm.instaclaw.io`;
    after(async () => {
      await setupTLSBackground(vm, tlsHostname);
    });

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

    // configureOpenClaw() verified the gateway with a localhost health ping
    // and wrote health_status accordingly (healthy or unhealthy).

    // ── Background validation (runs after response is sent) ──
    {
      const capturedGatewayToken = result.gatewayToken;
      const capturedVmId = vm.id;
      const capturedUserId = userId!;
      const capturedApiMode = effectiveApiMode;

      // Proxy round-trip test (all-inclusive only) + deployment email
      after(async () => {
        // Validate proxy chain if all-inclusive
        if (capturedApiMode === "all_inclusive") {
          const proxyResult = await testProxyRoundTrip(capturedGatewayToken);
          if (!proxyResult.success) {
            logger.error("Proxy round-trip test failed after configure", {
              route: "vm/configure",
              userId: capturedUserId,
              vmId: capturedVmId,
              error: proxyResult.error,
            });
            sendAdminAlertEmail(
              "Proxy Round-Trip Failed After Configure",
              `VM ${capturedVmId} (user: ${capturedUserId}) passed local health check but failed proxy round-trip.\n\nError: ${proxyResult.error}\n\nThe health cron will auto-restart the gateway on the next cycle.`
            ).catch(() => {});
          }
        }

        // Send deployment success email
        const sb = getSupabase();
        const { data: user } = await sb
          .from("instaclaw_users")
          .select("email")
          .eq("id", capturedUserId)
          .single();
        if (user?.email) {
          try {
            await sendVMReadyEmail(user.email, `${process.env.NEXTAUTH_URL}/dashboard`);
          } catch (emailErr) {
            logger.error("Failed to send VM ready email", {
              error: String(emailErr),
              route: "vm/configure",
              userId: capturedUserId,
            });
          }
        }
      });
    }

    // Log route-level configure timeline
    const routeEnd = Date.now();
    logger.info("Configure route timeline", {
      route: "vm/configure",
      userId,
      vmId: vm.id,
      durations: {
        route_setup: `${configureStart - routeStart}ms`,
        configureOpenClaw: `${Date.now() - configureStart}ms`,
        route_total: `${routeEnd - routeStart}ms`,
      },
    });

    return NextResponse.json({
      configured: true,
      healthy: result.gatewayVerified, // based on localhost health ping inside VM
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const isOwnershipChanged = errMsg.includes("OWNERSHIP_CHANGED");

    logger.error("VM configure error", {
      error: errMsg,
      route: "vm/configure",
      userId,
      isOwnershipChanged,
    });

    // Clear configure lock on error (best-effort)
    if (userId) {
      try {
        const sb = getSupabase();
        // Use separate calls so a stale PostgREST cache for configure_lock_at
        // doesn't prevent the configure_attempts increment from landing.
        await sb
          .from("instaclaw_vms")
          .update({ configure_lock_at: null })
          .eq("assigned_to", userId)
          .then(() => {}, () => {}); // Ignore column-not-found errors
      } catch {
        // Best-effort — PostgREST schema cache may be stale
      }
    }

    // OWNERSHIP_CHANGED: return 403, alert admin, do NOT mark as configure_failed
    if (isOwnershipChanged) {
      sendAdminAlertEmail(
        "CRITICAL: VM Ownership Race Condition (OWNERSHIP_CHANGED)",
        `Configure for user ${userId} failed: ${errMsg}\n\nThis indicates a race condition where a VM was reassigned during configuration.`
      ).catch(() => {});
      return NextResponse.json(
        { error: "VM ownership changed during configuration", detail: errMsg },
        { status: 403 }
      );
    }

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

    return NextResponse.json(
      { error: "Failed to configure VM", detail: errMsg },
      { status: 500 }
    );
  }
}
