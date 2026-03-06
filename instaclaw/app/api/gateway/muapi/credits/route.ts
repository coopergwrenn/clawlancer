import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

/**
 * Credit weight lookup for pre-generation checks.
 * Maps generation type + model + duration to credit cost.
 */
function lookupCreditWeight(
  type: string,
  model?: string,
  duration?: string
): number {
  const t = (type || "").toLowerCase();
  const m = (model || "").toLowerCase();
  const d = duration || "5";

  // Images
  if (t === "image") {
    if (m.includes("flux") && m.includes("schnell")) return 10;
    if (m.includes("flux")) return 20;
    return 40; // Ideogram, Recraft, Seedream, GPT Image
  }

  // Video
  if (t === "video" || t === "text-to-video") {
    if (d === "20") return 250;
    return d === "10" ? 150 : 80;
  }
  if (t === "image-to-video" || t === "i2v") {
    return d === "10" ? 180 : 100;
  }

  // Audio
  if (t === "music") return 40;
  if (t === "sfx") return 30;
  if (t === "video-to-audio" || t === "sync") return 50;
  if (t === "lipsync") return 60;

  // Editing
  if (t === "effects" || t === "style-transfer" || t === "style") return 60;
  if (t === "extend") return 80;
  if (t === "upscale") return 50;
  if (t === "face-swap") return 100;
  if (t === "translate") return 80;

  // Multi-shot
  if (t === "story") return 400;

  return 40; // safe default
}

/**
 * GET /api/gateway/muapi/credits?type=video&model=kling-3.0&duration=5
 *
 * Pre-generation credit check. Returns credit cost and availability.
 */
export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization");
    const bearerToken = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;
    const gatewayToken =
      req.headers.get("x-gateway-token") ||
      req.headers.get("x-api-key") ||
      bearerToken;

    if (!gatewayToken) {
      return NextResponse.json(
        { error: "Missing authentication" },
        { status: 401 }
      );
    }

    const supabase = getSupabase();

    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, tier, user_timezone")
      .eq("gateway_token", gatewayToken)
      .single();

    if (!vm) {
      return NextResponse.json(
        { error: "Invalid gateway token" },
        { status: 401 }
      );
    }

    const type = req.nextUrl.searchParams.get("type") || "video";
    const model = req.nextUrl.searchParams.get("model") || undefined;
    const duration = req.nextUrl.searchParams.get("duration") || undefined;
    const userTz = vm.user_timezone || "America/New_York";

    const creditsRequired = lookupCreditWeight(type, model, duration);

    // Get current usage
    const { data: limitResult, error: limitError } = await supabase.rpc(
      "instaclaw_check_limit_only",
      {
        p_vm_id: vm.id,
        p_tier: vm.tier || "starter",
        p_model: "haiku",
        p_is_heartbeat: false,
        p_timezone: userTz,
        p_is_virtuals: false,
        p_is_tool_continuation: false,
      }
    );

    if (limitError) {
      logger.error("Muapi credit check failed", {
        route: "gateway/muapi/credits",
        vmId: vm.id,
        error: String(limitError),
      });
      return NextResponse.json(
        { error: "Usage check temporarily unavailable" },
        { status: 503 }
      );
    }

    const dailyRemaining = Math.max(
      0,
      (limitResult?.display_limit || 600) - (limitResult?.count || 0)
    );
    const creditBalance = limitResult?.credits_remaining || 0;
    const creditsAvailable = dailyRemaining + creditBalance;
    const canGenerate = creditsAvailable >= creditsRequired;

    // Midnight reset (approximate)
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(5, 0, 0, 0);

    const typeLabel =
      type === "image"
        ? "image"
        : type === "video" || type === "text-to-video"
          ? "video"
          : type;

    if (canGenerate) {
      return NextResponse.json({
        credits_required: creditsRequired,
        credits_available: Math.floor(creditsAvailable),
        daily_remaining: Math.floor(dailyRemaining),
        credit_balance: Math.floor(creditBalance),
        can_generate: true,
        resets_at: tomorrow.toISOString(),
        message: `This ${typeLabel} will use about ${creditsRequired} credits. You have ${Math.floor(creditsAvailable)} remaining.`,
      });
    }

    return NextResponse.json({
      credits_required: creditsRequired,
      credits_available: Math.floor(creditsAvailable),
      daily_remaining: Math.floor(dailyRemaining),
      credit_balance: Math.floor(creditBalance),
      can_generate: false,
      resets_at: tomorrow.toISOString(),
      message: `This would use ${creditsRequired} credits but you have ${Math.floor(creditsAvailable)} left. Your credits reset at midnight — or grab a credit pack to keep going.`,
      packs_url: "/billing/credit-packs",
    });
  } catch (err) {
    logger.error("Muapi credits check error", {
      error: String(err),
      route: "gateway/muapi/credits",
    });
    return NextResponse.json(
      { error: "Credit check failed" },
      { status: 500 }
    );
  }
}
