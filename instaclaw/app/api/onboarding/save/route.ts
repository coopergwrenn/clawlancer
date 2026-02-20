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

    const supabase = getSupabase();

    // Fetch existing pending record to support partial updates.
    // The Connect page saves token+channels first, then the Plan page
    // updates tier — we must not overwrite the token with null.
    const { data: existing } = await supabase
      .from("instaclaw_pending_users")
      .select("telegram_bot_token, telegram_bot_username, discord_bot_token, api_mode, api_key, tier, default_model")
      .eq("user_id", session.user.id)
      .single();

    // Merge: prefer incoming values, fall back to existing record
    const enabledChannels: string[] = channels ?? (existing?.telegram_bot_token ? ["telegram"] : []);
    if (enabledChannels.length === 0 && !existing) {
      return NextResponse.json(
        { error: "At least one channel must be selected" },
        { status: 400 }
      );
    }

    // Resolve token: incoming > existing
    const finalBotToken = (enabledChannels.includes("telegram") && botToken)
      ? botToken
      : existing?.telegram_bot_token ?? null;
    const finalDiscordToken = (enabledChannels.includes("discord") && discordToken)
      ? discordToken
      : existing?.discord_bot_token ?? null;

    // Validate Telegram bot token — must be valid if telegram is enabled
    // and we don't already have one saved
    if (enabledChannels.includes("telegram")) {
      if (!finalBotToken || !BOT_TOKEN_RE.test(finalBotToken)) {
        return NextResponse.json(
          { error: "Invalid Telegram bot token format" },
          { status: 400 }
        );
      }
    }

    // Validate Discord token if Discord is enabled and no existing token
    if (enabledChannels.includes("discord") && !finalDiscordToken) {
      return NextResponse.json(
        { error: "Discord bot token is required when Discord is enabled" },
        { status: 400 }
      );
    }

    // Validate api mode
    const finalApiMode = apiMode ?? existing?.api_mode ?? "all_inclusive";
    if (!["all_inclusive", "byok"].includes(finalApiMode)) {
      return NextResponse.json(
        { error: "apiMode must be 'all_inclusive' or 'byok'" },
        { status: 400 }
      );
    }

    // Validate BYOK key
    if (finalApiMode === "byok" && !apiKey && !existing?.api_key) {
      return NextResponse.json(
        { error: "API key is required for BYOK mode" },
        { status: 400 }
      );
    }

    // Tier is optional on initial save (Connect page), required for checkout (Plan page)
    const finalTier = tier ?? existing?.tier ?? "pro";
    if (!["starter", "pro", "power"].includes(finalTier)) {
      return NextResponse.json(
        { error: "tier must be 'starter', 'pro', or 'power'" },
        { status: 400 }
      );
    }

    // Validate model (optional, default to sonnet)
    const resolvedModel =
      (model && ALLOWED_MODELS.includes(model))
        ? model
        : existing?.default_model ?? "claude-sonnet-4-5-20250929";

    // Call Telegram getMe to resolve bot username (if we have a new token)
    let botUsername: string | null = existing?.telegram_bot_username ?? null;
    if (enabledChannels.includes("telegram") && botToken && BOT_TOKEN_RE.test(botToken)) {
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

    // Encrypt API key if BYOK (only if a new key is provided)
    const encryptedKey = (finalApiMode === "byok" && apiKey)
      ? await encryptApiKey(apiKey)
      : existing?.api_key ?? null;

    // Upsert into instaclaw_pending_users (unique on user_id)
    const { data, error } = await supabase
      .from("instaclaw_pending_users")
      .upsert(
        {
          user_id: session.user.id,
          telegram_bot_token: finalBotToken,
          telegram_bot_username: botUsername,
          discord_bot_token: finalDiscordToken,
          api_mode: finalApiMode,
          api_key: encryptedKey,
          tier: finalTier,
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
