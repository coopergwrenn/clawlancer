import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { encryptApiKey } from "@/lib/security";
import { logger } from "@/lib/logger";

const BOT_TOKEN_RE = /^\d+:[A-Za-z0-9_-]+$/;
const ALLOWED_MODELS = [
  "minimax-m2.5",
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-5-20250820",
  "claude-opus-4-6",
];

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { botToken, discordToken, channels, apiMode, apiKey, tier, model } = await req.json();

    // Validate channels
    const enabledChannels: string[] = channels ?? ["telegram"];
    if (enabledChannels.length === 0) {
      return NextResponse.json(
        { error: "At least one channel must be selected" },
        { status: 400 }
      );
    }

    // Validate Telegram bot token if Telegram is enabled
    if (enabledChannels.includes("telegram")) {
      if (!botToken || !BOT_TOKEN_RE.test(botToken)) {
        return NextResponse.json(
          { error: "Invalid Telegram bot token format" },
          { status: 400 }
        );
      }
    }

    // Validate Discord token if Discord is enabled
    if (enabledChannels.includes("discord") && (!discordToken || typeof discordToken !== "string")) {
      return NextResponse.json(
        { error: "Discord bot token is required when Discord is enabled" },
        { status: 400 }
      );
    }

    // Validate api mode
    if (!apiMode || !["all_inclusive", "byok"].includes(apiMode)) {
      return NextResponse.json(
        { error: "apiMode must be 'all_inclusive' or 'byok'" },
        { status: 400 }
      );
    }

    // Validate BYOK key
    if (apiMode === "byok" && (!apiKey || typeof apiKey !== "string")) {
      return NextResponse.json(
        { error: "API key is required for BYOK mode" },
        { status: 400 }
      );
    }

    // Validate tier
    if (!tier || !["starter", "pro", "power"].includes(tier)) {
      return NextResponse.json(
        { error: "tier must be 'starter', 'pro', or 'power'" },
        { status: 400 }
      );
    }

    // Validate model (optional, default to sonnet)
    const resolvedModel =
      model && ALLOWED_MODELS.includes(model)
        ? model
        : "claude-sonnet-4-5-20250929";

    // Call Telegram getMe to resolve bot username (if Telegram enabled)
    let botUsername: string | null = null;
    if (enabledChannels.includes("telegram") && botToken) {
      try {
        const tgRes = await fetch(
          `https://api.telegram.org/bot${botToken}/getMe`
        );
        if (tgRes.ok) {
          const tgData = await tgRes.json();
          if (tgData.ok && tgData.result?.username) {
            botUsername = tgData.result.username;
          }
        }
      } catch {
        logger.warn("Failed to resolve Telegram bot username via getMe", { route: "onboarding/save" });
      }
    }

    // Encrypt API key if BYOK
    const encryptedKey =
      apiMode === "byok" ? await encryptApiKey(apiKey) : null;

    const supabase = getSupabase();

    // Upsert into instaclaw_pending_users (unique on user_id)
    const { data, error } = await supabase
      .from("instaclaw_pending_users")
      .upsert(
        {
          user_id: session.user.id,
          telegram_bot_token: enabledChannels.includes("telegram") ? botToken : null,
          telegram_bot_username: botUsername,
          discord_bot_token: enabledChannels.includes("discord") ? discordToken : null,
          api_mode: apiMode,
          api_key: encryptedKey,
          tier,
          default_model: resolvedModel,
        },
        { onConflict: "user_id" }
      )
      .select("id")
      .single();

    if (error) {
      logger.error("Failed to save onboarding config", { error: String(error), route: "onboarding/save" });
      return NextResponse.json(
        { error: "Failed to save configuration" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      saved: true,
      id: data.id,
      botUsername,
      channels: enabledChannels,
    });
  } catch (err) {
    logger.error("Onboarding save error", { error: String(err), route: "onboarding/save" });
    return NextResponse.json(
      { error: "Something went wrong" },
      { status: 500 }
    );
  }
}
