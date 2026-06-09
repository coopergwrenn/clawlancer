import { NextRequest, NextResponse } from "next/server";
import { createHmac, randomUUID } from "crypto";
import { createHiggsfieldClient } from "@higgsfield/client/v2";
import { lookupVMByGatewayToken } from "@/lib/gateway-auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import {
  HF_MODELS,
  DEFAULT_MODEL,
  estimateVideoCredits,
  validateInput,
  freeCapForTier,
  VIDEO_DAILY_CREDIT_CEILING,
  FRESH_PENDING_TTL_MS,
  utcDayStartISO,
} from "@/lib/higgsfield-models";

export const runtime = "nodejs";
export const maxDuration = 300; // Rule 11 — LLM/slow-API routes

/**
 * Higgsfield Cloud API gateway proxy — GUARDRAIL #1: pre-call credit gate.
 *
 * Flow (Frontier-mirrored hold/settle):
 *   gateway token → VM → VALIDATE (Cloud allowlist + per-model params, pre-submit)
 *   → ESTIMATE (measured cost table) → RESERVE (atomic hold; free-then-paid)
 *   → SUBMIT (only after a successful hold) → return request_id.
 * Completion + SETTLE/RELEASE happen at the sibling webhook route.
 *
 * The §6 calibration passthrough is GONE: there is no arbitrary endpoint/input
 * path. Only allowlisted models with validated, sanitized params reach
 * Higgsfield — closing the "API silently coerces+bills bad params" hole.
 *
 * Auth: the Cloud key (KEY_ID:KEY_SECRET) lives ONLY in process.env.
 * HIGGSFIELD_CLOUD_KEY (never on a VM). VMs auth to THIS proxy with their
 * per-VM GATEWAY_TOKEN.
 *
 * Billing idempotency: we generate our OWN request_id (UUID) as the hold key
 * BEFORE submit (we can't use Higgsfield's id — it only comes back FROM submit),
 * and sign it into the tamper-proof webhook `d` payload so the webhook settles
 * by it. Higgsfield's request_id is used only to re-fetch authoritative status.
 */

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

/** Map a reserve-denial reason to a user-safe message + HTTP status. */
function denialResponse(reason: string, info: Record<string, unknown>) {
  switch (reason) {
    case "insufficient_balance":
      return NextResponse.json(
        { error: "insufficient_credits", message: "You're out of video credits. Top up to keep creating.", ...info },
        { status: 402 },
      );
    case "free_exhausted":
      return NextResponse.json(
        { error: "free_exhausted", message: "You've used your free videos for today. Top up to make more.", ...info },
        { status: 402 },
      );
    case "exceeds_daily_ceiling":
      return NextResponse.json(
        { error: "daily_limit", message: "You've hit today's video limit. It resets at midnight UTC.", ...info },
        { status: 429 },
      );
    case "no_cap_provided":
      // Should be impossible — the route always passes a real cap. Fail closed.
      return NextResponse.json(
        { error: "config_error", message: "Video generation is temporarily unavailable." },
        { status: 503 },
      );
    case "duplicate_request_id":
      return NextResponse.json(
        { error: "duplicate", message: "That request is already in progress." },
        { status: 409 },
      );
    case "invalid_vm":
      return NextResponse.json({ error: "invalid_vm" }, { status: 400 });
    default:
      return NextResponse.json(
        { error: "reserve_denied", message: "Couldn't start that video right now — try again shortly." },
        { status: 503 },
      );
  }
}

export async function POST(req: NextRequest) {
  try {
    // --- Authenticate via gateway token; pull tier for the free allowance. ---
    const authHeader = req.headers.get("authorization");
    const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const gatewayToken =
      req.headers.get("x-gateway-token") || req.headers.get("x-api-key") || bearer;
    if (!gatewayToken) {
      return NextResponse.json({ error: "Missing authentication" }, { status: 401 });
    }

    const vm = await lookupVMByGatewayToken(gatewayToken, "id, tier");
    if (!vm) {
      return NextResponse.json({ error: "Invalid gateway token" }, { status: 401 });
    }

    // --- Server-side credentials must be configured. ---
    const cloudKey = process.env.HIGGSFIELD_CLOUD_KEY;
    const webhookSecret = process.env.HIGGSFIELD_WEBHOOK_SECRET;
    if (!cloudKey || !webhookSecret) {
      logger.error("Higgsfield proxy not configured", {
        route: "gateway/higgsfield",
        hasCloudKey: !!cloudKey,
        hasWebhookSecret: !!webhookSecret,
      });
      return NextResponse.json({ error: "Video generation not configured" }, { status: 500 });
    }

    const action = req.nextUrl.searchParams.get("action");
    if (action !== "create") {
      return NextResponse.json(
        { error: "invalid_action", message: "Only ?action=create is supported." },
        { status: 400 },
      );
    }

    const body = (await req.json().catch(() => ({}))) as {
      endpoint?: string;
      image_url?: unknown;
      prompt?: unknown;
      duration?: unknown;
      chat_id?: string | number;
    };

    const chatId = body.chat_id != null ? String(body.chat_id) : undefined;
    if (!chatId) {
      return NextResponse.json(
        { error: "missing_params", message: "chat_id is required." },
        { status: 400 },
      );
    }

    // --- 1. VALIDATE model (allowlist) — NO arbitrary endpoint passthrough. ---
    const endpoint = (typeof body.endpoint === "string" && body.endpoint) || DEFAULT_MODEL;
    const model = HF_MODELS[endpoint];
    if (!model) {
      return NextResponse.json(
        { error: "unsupported_model", message: "That video model isn't available." },
        { status: 400 },
      );
    }

    // --- 1b. VALIDATE params (pre-submit; only sanitized fields reach HF). ---
    const validated = validateInput(model, {
      image_url: body.image_url,
      prompt: body.prompt,
      duration: body.duration,
    });
    if (!validated.ok) {
      return NextResponse.json(
        { error: "invalid_params", message: validated.error },
        { status: 400 },
      );
    }
    const input = validated.input;

    // --- 2. ESTIMATE our video-credit cost (held == charged; flat per model). ---
    const est = estimateVideoCredits(model);

    // --- 3. RESERVE (atomic hold) BEFORE any submit. Free-then-paid. ---
    const supabase = getSupabase();
    const internalRequestId = randomUUID(); // OUR billing idempotency key
    const windowStart = utcDayStartISO();
    const freshPendingCutoff = new Date(Date.now() - FRESH_PENDING_TTL_MS).toISOString();
    const freeCap = freeCapForTier(vm.tier);
    const metadata = { endpoint, chat_id: chatId, tier: vm.tier ?? null };

    async function reserve(isFree: boolean) {
      return supabase.rpc("instaclaw_video_reserve_spend", {
        p_vm_id: vm.id,
        p_request_id: internalRequestId,
        p_endpoint: endpoint,
        p_est_credits: est,
        p_hf_cost_credits: model.hfCostCredits,
        p_is_free: isFree,
        p_free_cap_daily: freeCap,
        // ALWAYS a real cap — never NULL (hole #2 fix at the route layer).
        p_cap_daily: VIDEO_DAILY_CREDIT_CEILING,
        p_window_start: windowStart,
        p_fresh_pending_cutoff: freshPendingCutoff,
        p_metadata: metadata,
      });
    }

    // Free-eligible models try the free allowance first; on exhaustion (which
    // does NOT insert a row), fall through to a paid hold with the SAME id.
    let reserved: { reserved?: boolean; reason?: string; free?: boolean; [k: string]: unknown } | null = null;
    let usedFree = false;

    if (model.freeEligible) {
      const { data, error } = await reserve(true);
      if (error) {
        logger.error("video reserve (free) RPC error", {
          route: "gateway/higgsfield", vmId: vm.id, error: error.message,
        });
        return NextResponse.json({ error: "reserve_failed" }, { status: 503 });
      }
      reserved = data;
      if (reserved?.reserved) {
        usedFree = true;
      } else if (reserved?.reason === "free_exhausted") {
        reserved = null; // fall through to paid
      } else {
        return denialResponse(String(reserved?.reason ?? "unknown"), reserved ?? {});
      }
    }

    if (!reserved?.reserved) {
      const { data, error } = await reserve(false);
      if (error) {
        logger.error("video reserve (paid) RPC error", {
          route: "gateway/higgsfield", vmId: vm.id, error: error.message,
        });
        return NextResponse.json({ error: "reserve_failed" }, { status: 503 });
      }
      reserved = data;
      if (!reserved?.reserved) {
        // DENIED → no submit, no spend.
        logger.info("video reserve denied", {
          route: "gateway/higgsfield", vmId: vm.id, reason: reserved?.reason, endpoint,
        });
        return denialResponse(String(reserved?.reason ?? "unknown"), reserved ?? {});
      }
    }

    // --- 4. Hold secured. Sign the delivery target + our request_id, then submit. ---
    const payload = Buffer.from(
      JSON.stringify({ v: vm.id, c: chatId, t: Date.now(), r: internalRequestId }),
    ).toString("base64url");
    const sig = sign(payload, webhookSecret);
    const origin = process.env.HIGGSFIELD_WEBHOOK_BASE || req.nextUrl.origin;
    const webhookUrl = `${origin}/api/gateway/higgsfield/webhook?d=${payload}&s=${sig}`;

    const client = createHiggsfieldClient({ credentials: cloudKey });
    let submit: { request_id?: string; status?: string };
    try {
      submit = await client.subscribe(endpoint, {
        input,
        withPolling: false,
        webhook: { url: webhookUrl, secret: webhookSecret },
      });
    } catch (err) {
      // Submit failed → RELEASE the hold immediately so the user is never charged
      // and the balance availability isn't pinned by an orphaned hold.
      await supabase
        .rpc("instaclaw_video_release", {
          p_vm_id: vm.id,
          p_request_id: internalRequestId,
          p_reason: "submit_failed",
        })
        .then(undefined, () => {}); // best-effort; TTL is the backstop
      logger.error("Higgsfield submit failed; hold released", {
        route: "gateway/higgsfield",
        vmId: vm.id,
        errorName: err instanceof Error ? err.name : undefined,
        error: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json(
        {
          error: "service_unavailable",
          message: "Video generation is temporarily at capacity. Please try again shortly.",
        },
        { status: 503 },
      );
    }

    logger.info("Higgsfield generation submitted", {
      route: "gateway/higgsfield",
      vmId: vm.id,
      requestId: submit?.request_id,
      internalRequestId,
      endpoint,
      held: usedFree ? 0 : est,
      free: usedFree,
    });

    return NextResponse.json({
      request_id: submit?.request_id ?? null,
      status: submit?.status ?? "queued",
      held: usedFree ? 0 : est,
      free: usedFree,
    });
  } catch (err) {
    logger.error("Higgsfield proxy error", {
      route: "gateway/higgsfield",
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Proxy error" }, { status: 500 });
  }
}
