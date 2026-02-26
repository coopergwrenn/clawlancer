import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { encryptApiKey } from "@/lib/security";
import { updateSystemPrompt, updateApiKey, updateChannelToken, installAgdpSkill, uninstallAgdpSkill, connectSSH } from "@/lib/ssh";
import { logger } from "@/lib/logger";

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { action } = body;

    const supabase = getSupabase();

    // Get user's VM
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("*")
      .eq("assigned_to", session.user.id)
      .single();

    if (!vm) {
      return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
    }

    switch (action) {
      case "update_system_prompt": {
        const { systemPrompt } = body;
        if (typeof systemPrompt !== "string") {
          return NextResponse.json(
            { error: "systemPrompt must be a string" },
            { status: 400 }
          );
        }
        if (systemPrompt.length > 2000) {
          return NextResponse.json(
            { error: "System prompt must be 2000 characters or less" },
            { status: 400 }
          );
        }

        // SSH to VM and update system prompt file
        await updateSystemPrompt(vm, systemPrompt);

        // Update DB
        await supabase
          .from("instaclaw_vms")
          .update({ system_prompt: systemPrompt || null })
          .eq("id", vm.id);

        return NextResponse.json({ updated: true });
      }

      case "rotate_api_key": {
        const { apiKey } = body;
        if (!apiKey || typeof apiKey !== "string") {
          return NextResponse.json(
            { error: "apiKey is required" },
            { status: 400 }
          );
        }

        if (vm.api_mode !== "byok") {
          return NextResponse.json(
            { error: "API key rotation is only available for BYOK mode" },
            { status: 400 }
          );
        }

        // SSH to VM and update the API key
        await updateApiKey(vm, apiKey);

        // Re-encrypt and store in pending_users (in case of re-configure)
        const encrypted = await encryptApiKey(apiKey);
        await supabase
          .from("instaclaw_pending_users")
          .update({ api_key: encrypted })
          .eq("user_id", session.user.id);

        return NextResponse.json({ updated: true });
      }

      case "update_telegram_token": {
        const { telegramToken } = body;
        if (!telegramToken || typeof telegramToken !== "string") {
          return NextResponse.json(
            { error: "telegramToken is required" },
            { status: 400 }
          );
        }

        // Validate the token by calling Telegram's getMe API
        let botUsername: string;
        try {
          const getMeRes = await fetch(`https://api.telegram.org/bot${telegramToken}/getMe`);
          const getMeData = await getMeRes.json();
          if (!getMeData.ok || !getMeData.result?.username) {
            return NextResponse.json(
              { error: "Invalid Telegram bot token" },
              { status: 400 }
            );
          }
          botUsername = getMeData.result.username;
        } catch {
          return NextResponse.json(
            { error: "Failed to validate Telegram bot token" },
            { status: 400 }
          );
        }

        await updateChannelToken(vm, "telegram", { botToken: telegramToken });

        // Update DB
        const tgChannels: string[] = vm.channels_enabled ?? ["telegram"];
        if (!tgChannels.includes("telegram")) {
          tgChannels.push("telegram");
        }

        await supabase
          .from("instaclaw_vms")
          .update({
            telegram_bot_token: telegramToken,
            telegram_bot_username: botUsername,
            telegram_chat_id: null,
            channels_enabled: tgChannels,
          })
          .eq("id", vm.id);

        return NextResponse.json({ updated: true, botUsername });
      }

      case "update_discord_token": {
        const { discordToken } = body;
        if (!discordToken || typeof discordToken !== "string") {
          return NextResponse.json(
            { error: "discordToken is required" },
            { status: 400 }
          );
        }

        await updateChannelToken(vm, "discord", { botToken: discordToken });

        // Update DB
        const currentChannels: string[] = vm.channels_enabled ?? ["telegram"];
        if (!currentChannels.includes("discord")) {
          currentChannels.push("discord");
        }

        await supabase
          .from("instaclaw_vms")
          .update({
            discord_bot_token: discordToken,
            channels_enabled: currentChannels,
          })
          .eq("id", vm.id);

        return NextResponse.json({ updated: true });
      }

      case "update_slack_token": {
        const { slackToken, slackSigningSecret } = body;
        if (!slackToken || typeof slackToken !== "string") {
          return NextResponse.json(
            { error: "slackToken is required" },
            { status: 400 }
          );
        }

        await updateChannelToken(vm, "slack", {
          botToken: slackToken,
          ...(slackSigningSecret ? { signingSecret: slackSigningSecret } : {}),
        });

        const slackChannels: string[] = vm.channels_enabled ?? ["telegram"];
        if (!slackChannels.includes("slack")) {
          slackChannels.push("slack");
        }

        await supabase
          .from("instaclaw_vms")
          .update({ channels_enabled: slackChannels })
          .eq("id", vm.id);

        return NextResponse.json({ updated: true });
      }

      case "update_whatsapp_token": {
        const { whatsappToken, whatsappPhoneId } = body;
        if (!whatsappToken || typeof whatsappToken !== "string") {
          return NextResponse.json(
            { error: "whatsappToken is required" },
            { status: 400 }
          );
        }

        await updateChannelToken(vm, "whatsapp", {
          accessToken: whatsappToken,
          ...(whatsappPhoneId ? { phoneNumberId: whatsappPhoneId } : {}),
        });

        const waChannels: string[] = vm.channels_enabled ?? ["telegram"];
        if (!waChannels.includes("whatsapp")) {
          waChannels.push("whatsapp");
        }

        await supabase
          .from("instaclaw_vms")
          .update({ channels_enabled: waChannels })
          .eq("id", vm.id);

        return NextResponse.json({ updated: true });
      }

      case "update_tool_permissions": {
        const { tools } = body;
        if (!tools || typeof tools !== "object") {
          return NextResponse.json(
            { error: "tools object is required" },
            { status: 400 }
          );
        }

        const { updateToolPermissions } = await import("@/lib/ssh");
        await updateToolPermissions(vm, tools);
        return NextResponse.json({ updated: true });
      }

      case "sync_timezone": {
        const { timezone } = body;
        if (!timezone || typeof timezone !== "string") {
          return NextResponse.json(
            { error: "timezone is required" },
            { status: 400 }
          );
        }

        // Validate IANA timezone string
        let validatedTz: string;
        try {
          Intl.DateTimeFormat(undefined, { timeZone: timezone });
          validatedTz = timezone;
        } catch {
          return NextResponse.json(
            { error: "Invalid timezone" },
            { status: 400 }
          );
        }

        // Skip if already correct on both user and VM
        const { data: currentUser } = await supabase
          .from("instaclaw_users")
          .select("user_timezone")
          .eq("id", session.user.id)
          .single();

        if (currentUser?.user_timezone === validatedTz && vm.user_timezone === validatedTz) {
          return NextResponse.json({ updated: false, reason: "already_correct" });
        }

        // Update user record
        await supabase
          .from("instaclaw_users")
          .update({ user_timezone: validatedTz })
          .eq("id", session.user.id);

        // Update VM record
        await supabase
          .from("instaclaw_vms")
          .update({ user_timezone: validatedTz })
          .eq("id", vm.id);

        logger.info("Timezone synced from browser", {
          route: "settings/update",
          userId: session.user.id,
          vmId: vm.id,
          oldUserTz: currentUser?.user_timezone,
          oldVmTz: vm.user_timezone,
          newTz: validatedTz,
        });

        return NextResponse.json({ updated: true, timezone: validatedTz });
      }

      case "update_polymarket_risk": {
        const { riskConfig: rc } = body;
        if (!rc || typeof rc !== "object") {
          return NextResponse.json({ error: "riskConfig object is required" }, { status: 400 });
        }

        // Validate fields
        if (typeof rc.enabled !== "boolean") {
          return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
        }
        const numFields = ["dailySpendCapUSDC", "confirmationThresholdUSDC", "dailyLossLimitUSDC", "maxPositionSizeUSDC"] as const;
        for (const field of numFields) {
          if (typeof rc[field] !== "number" || rc[field] < 1) {
            return NextResponse.json({ error: `${field} must be a positive number` }, { status: 400 });
          }
        }

        // Enforce hard limits
        const sanitized = {
          enabled: rc.enabled,
          dailySpendCapUSDC: Math.min(500, rc.dailySpendCapUSDC),
          confirmationThresholdUSDC: Math.min(500, rc.confirmationThresholdUSDC),
          dailyLossLimitUSDC: Math.min(500, rc.dailyLossLimitUSDC),
          maxPositionSizeUSDC: Math.min(500, rc.maxPositionSizeUSDC),
          updatedAt: new Date().toISOString(),
        };

        // Write to VM via SSH
        const riskSsh = await connectSSH(vm);
        try {
          const riskB64 = Buffer.from(JSON.stringify(sanitized, null, 2), "utf-8").toString("base64");
          await riskSsh.execCommand(
            `mkdir -p "$HOME/.openclaw/polymarket" && echo '${riskB64}' | base64 -d > "$HOME/.openclaw/polymarket/risk-config.json" && chmod 600 "$HOME/.openclaw/polymarket/risk-config.json"`
          );
        } finally {
          riskSsh.dispose();
        }

        logger.info("Polymarket risk config updated", {
          route: "settings/update",
          userId: session.user.id,
          enabled: sanitized.enabled,
        });

        return NextResponse.json({ updated: true, riskConfig: sanitized });
      }

      case "setup_polymarket_wallet": {
        const walletSsh = await connectSSH(vm);
        try {
          const result = await walletSsh.execCommand(
            'bash "$HOME/scripts/setup-polymarket-wallet.sh" 2>&1'
          );
          if (result.code !== 0) {
            // Check if wallet already exists (not an error, just already set up)
            if (result.stdout?.includes("already exists") || result.stderr?.includes("already exists")) {
              const addrResult = await walletSsh.execCommand(
                'bash "$HOME/scripts/setup-polymarket-wallet.sh" address 2>&1'
              );
              return NextResponse.json({
                updated: true,
                address: addrResult.stdout?.trim(),
                message: "Wallet already exists",
              });
            }
            return NextResponse.json(
              { error: result.stderr || result.stdout || "Wallet setup failed" },
              { status: 500 }
            );
          }

          // Extract address from output
          const addressMatch = result.stdout?.match(/Wallet created: (0x[a-fA-F0-9]+)/);
          const address = addressMatch?.[1] ?? null;

          logger.info("Polymarket wallet created", {
            route: "settings/update",
            userId: session.user.id,
            address,
          });

          return NextResponse.json({ updated: true, address });
        } finally {
          walletSsh.dispose();
        }
      }

      case "toggle_agdp": {
        const { enabled } = body;
        if (typeof enabled !== "boolean") {
          return NextResponse.json(
            { error: "enabled must be a boolean" },
            { status: 400 }
          );
        }

        if (enabled) {
          const result = await installAgdpSkill(vm);
          await supabase
            .from("instaclaw_vms")
            .update({ agdp_enabled: enabled })
            .eq("id", vm.id);
          return NextResponse.json({
            updated: true,
            authUrl: result.authUrl,
            serving: result.serving,
          });
        } else {
          await uninstallAgdpSkill(vm);
          await supabase
            .from("instaclaw_vms")
            .update({ agdp_enabled: enabled })
            .eq("id", vm.id);
          return NextResponse.json({ updated: true });
        }
      }

      default:
        return NextResponse.json(
          { error: "Unknown action" },
          { status: 400 }
        );
    }
  } catch (err) {
    logger.error("Settings update error", { error: String(err), route: "settings/update" });
    return NextResponse.json(
      { error: "Failed to update settings" },
      { status: 500 }
    );
  }
}
