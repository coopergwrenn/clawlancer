import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { configureOpenClaw, waitForHealth } from "@/lib/ssh";
import { validateAdminKey } from "@/lib/security";
import { logger } from "@/lib/logger";

// SSH + configure-vm.sh + health check can take 60-90s
export const maxDuration = 120;

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

    // Get pending user config
    const { data: pending } = await supabase
      .from("instaclaw_pending_users")
      .select("*")
      .eq("user_id", userId)
      .single();

    if (!pending) {
      return NextResponse.json(
        { error: "No pending configuration" },
        { status: 404 }
      );
    }

    // Determine channels
    const channels: string[] = [];
    if (pending.telegram_bot_token) channels.push("telegram");
    if (pending.discord_bot_token) channels.push("discord");
    if (channels.length === 0) channels.push("telegram");

    // Configure OpenClaw on the VM
    const result = await configureOpenClaw(vm, {
      telegramBotToken: pending.telegram_bot_token,
      apiMode: pending.api_mode,
      apiKey: pending.api_key,
      tier: pending.tier,
      model: pending.default_model,
      discordBotToken: pending.discord_bot_token ?? undefined,
      channels,
    });

    // ── Critical DB updates first (before any health check) ──
    // This ensures gateway info is persisted even if the function times out
    // during the health check phase.
    await supabase
      .from("instaclaw_vms")
      .update({
        health_status: "configuring",
        last_health_check: new Date().toISOString(),
        telegram_bot_username: pending.telegram_bot_username ?? null,
        discord_bot_token: pending.discord_bot_token ?? null,
        channels_enabled: channels,
        configure_attempts: 0,
        default_model: pending.default_model ?? "claude-sonnet-4-5-20250929",
        api_mode: pending.api_mode,
        tier: pending.tier,
      })
      .eq("id", vm.id);

    // Mark user as onboarding complete + clean up pending record.
    // Do this BEFORE the health check so it's saved even if we time out.
    await supabase
      .from("instaclaw_users")
      .update({ onboarding_complete: true })
      .eq("id", userId);

    await supabase
      .from("instaclaw_pending_users")
      .delete()
      .eq("user_id", userId);

    // ── Quick health check (3 attempts × 3s = 9s max) ──
    // If the gateway comes up fast, the user sees instant completion.
    // If not, the health-check cron will upgrade "configuring" → "healthy".
    const healthy = await waitForHealth(vm, result.gatewayToken, 3, 3000);

    if (healthy) {
      await supabase
        .from("instaclaw_vms")
        .update({
          health_status: "healthy",
          last_health_check: new Date().toISOString(),
        })
        .eq("id", vm.id);
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
