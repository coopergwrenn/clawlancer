import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

const MUAPI_BASE = "https://api.muapi.ai";

/**
 * Determine credit weight from the Muapi endpoint path and request body.
 *
 * Credit weights reflect actual Muapi costs with margin:
 *   Images: 10-40, Video: 80-250, Audio: 30-60, Editing: 50-100
 */
function determineCreditWeight(path: string, body: Record<string, unknown>): number {
  const p = path.replace(/^\/+/, "");
  const duration = Number(body?.duration) || 5;

  // ── Status checks and file uploads are free ───────────────────────────────
  if (p.includes("predictions/") || p.includes("upload_file")) return 0;

  // ── Images ────────────────────────────────────────────────────────────────
  if (p.includes("flux-schnell")) return 10;
  if (p.includes("flux-dev") || p.includes("flux-pro")) return 20;
  if (p.includes("ideogram") || p.includes("seedream") || p.includes("gpt4o") ||
      p.includes("gpt-image") || p.includes("midjourney") || p.includes("recraft") ||
      p.includes("google-imagen") || p.includes("reve-text-to-image")) return 40;

  // ── Video T2V ─────────────────────────────────────────────────────────────
  if (p.includes("text-to-video") || p.includes("-t2v")) {
    if (duration >= 20) return 250;
    if (duration >= 10) return 150;
    return 80;
  }

  // ── Video I2V ─────────────────────────────────────────────────────────────
  if (p.includes("image-to-video") || p.includes("-i2v") || p.includes("reference-to-video")) {
    if (duration >= 10) return 180;
    return 100;
  }

  // ── Effects / editing ─────────────────────────────────────────────────────
  if (p.includes("effects") || p.includes("style-transfer") || p.includes("soul-image")) return 60;
  if (p.includes("extend")) return 80;
  if (p.includes("upscale")) return 50;
  if (p.includes("face-swap")) return 100;
  if (p.includes("translate")) return 80;

  // ── Audio ─────────────────────────────────────────────────────────────────
  if (p.includes("suno") || p.includes("music")) return 40;
  if (p.includes("mmaudio") || p.includes("sfx")) return 30;
  if (p.includes("video-to-audio")) return 50;
  if (p.includes("lipsync")) return 60;

  // ── Image editing (I2I models) ────────────────────────────────────────────
  if (p.includes("edit") || p.includes("image-to-image") || p.includes("-i2i")) return 20;

  // ── Wan/Hunyuan image generation ──────────────────────────────────────────
  if (p.includes("text-to-image") || p.includes("hunyuan-image")) return 40;

  // Fallback: safe default
  return 40;
}

/**
 * Muapi proxy — catch-all route.
 *
 * Auth: gateway token → VM lookup → credit check → forward to Muapi → increment usage.
 * Supports all HTTP methods (POST for generation, GET for status polling).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return handleProxy(req, await params, "POST");
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return handleProxy(req, await params, "GET");
}

async function handleProxy(
  req: NextRequest,
  { path }: { path: string[] },
  method: string
) {
  try {
    // --- Authenticate via gateway token ---
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

    // --- Validate MUAPI_API_KEY is configured server-side ---
    const muapiKey = process.env.MUAPI_API_KEY;
    if (!muapiKey) {
      logger.error("MUAPI_API_KEY not set for Muapi proxy", {
        route: "gateway/muapi",
      });
      return NextResponse.json(
        { error: "Media generation not configured" },
        { status: 500 }
      );
    }

    const upstreamPath = "/" + path.join("/");
    const userTz = vm.user_timezone || "America/New_York";

    // Parse body for POST requests
    let body: Record<string, unknown> = {};
    if (method === "POST") {
      try {
        body = await req.json();
      } catch {
        // Empty body is OK for some endpoints
      }
    }

    const creditWeight = determineCreditWeight(upstreamPath, body);

    // --- Check credits before generation (skip for free operations) ---
    if (creditWeight > 0) {
      const { data: limitResult, error: limitError } = await supabase.rpc(
        "instaclaw_check_limit_only",
        {
          p_vm_id: vm.id,
          p_tier: vm.tier || "starter",
          p_model: "haiku", // Use haiku weight=1 as baseline; actual weight is creditWeight
          p_is_heartbeat: false,
          p_timezone: userTz,
          p_is_virtuals: false,
          p_is_tool_continuation: false,
        }
      );

      if (limitError) {
        logger.error("Muapi credit check failed", {
          route: "gateway/muapi",
          vmId: vm.id,
          error: String(limitError),
        });
        return NextResponse.json(
          { error: "Usage check temporarily unavailable. Please retry." },
          { status: 503 }
        );
      }

      if (limitResult && !limitResult.allowed) {
        // Calculate reset time (midnight in user's timezone)
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
        tomorrow.setUTCHours(5, 0, 0, 0); // Approximate midnight ET

        return NextResponse.json(
          {
            error: "credits_exhausted",
            message:
              "Your credits reset at midnight — or grab a credit pack to keep going.",
            credits_required: creditWeight,
            credits_available: Math.max(
              0,
              (limitResult.display_limit || 0) -
                (limitResult.count || 0) +
                (limitResult.credits_remaining || 0)
            ),
            resets_at: tomorrow.toISOString(),
            packs_url: "/billing/credit-packs",
          },
          { status: 429 }
        );
      }

      // Check if the specific credit weight would exceed remaining
      const available =
        Math.max(
          0,
          (limitResult?.display_limit || 600) - (limitResult?.count || 0)
        ) + (limitResult?.credits_remaining || 0);

      if (available < creditWeight) {
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
        tomorrow.setUTCHours(5, 0, 0, 0);

        return NextResponse.json(
          {
            error: "insufficient_credits",
            message: `This would use ${creditWeight} credits but you have ${Math.floor(available)} left. Your credits reset at midnight — or grab a credit pack to keep going.`,
            credits_required: creditWeight,
            credits_available: Math.floor(available),
            resets_at: tomorrow.toISOString(),
            packs_url: "/billing/credit-packs",
          },
          { status: 429 }
        );
      }
    }

    // --- Forward to Muapi ---
    const muapiUrl = `${MUAPI_BASE}${upstreamPath}`;
    const muapiHeaders: Record<string, string> = {
      "x-api-key": muapiKey,
      "Content-Type": "application/json",
    };

    const fetchOptions: RequestInit = {
      method,
      headers: muapiHeaders,
    };

    if (method === "POST" && Object.keys(body).length > 0) {
      fetchOptions.body = JSON.stringify(body);
    }

    const muapiRes = await fetch(muapiUrl, fetchOptions);
    const muapiData = await muapiRes.json();

    if (!muapiRes.ok) {
      logger.error("Muapi upstream error", {
        route: "gateway/muapi",
        vmId: vm.id,
        status: muapiRes.status,
        path: upstreamPath,
        response: JSON.stringify(muapiData).slice(0, 500),
      });
      return NextResponse.json(muapiData, {
        status: muapiRes.status >= 400 ? muapiRes.status : 502,
      });
    }

    // --- Success: increment usage (fire and forget) ---
    if (creditWeight > 0) {
      supabase
        .rpc("instaclaw_increment_media_usage", {
          p_vm_id: vm.id,
          p_credit_weight: creditWeight,
          p_timezone: userTz,
        })
        .then(({ error: incError }) => {
          if (incError) {
            logger.error("Failed to increment media usage", {
              route: "gateway/muapi",
              vmId: vm.id,
              creditWeight,
              error: String(incError),
            });
          }
        });

      logger.info("Muapi generation proxied", {
        route: "gateway/muapi",
        vmId: vm.id,
        path: upstreamPath,
        creditWeight,
      });
    }

    return NextResponse.json(muapiData);
  } catch (err) {
    logger.error("Muapi proxy error", {
      error: String(err),
      route: "gateway/muapi",
    });
    return NextResponse.json({ error: "Proxy error" }, { status: 500 });
  }
}
