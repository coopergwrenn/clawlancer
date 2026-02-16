import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { sendAdminAlertEmail } from "@/lib/email";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

/** Estimated cost per message unit in dollars (haiku-equivalent). */
const COST_PER_UNIT = 0.004;

/**
 * Hidden buffer added to each tier's internal RPC limit.
 * Covers automated heartbeat/background calls that shouldn't consume
 * the user's visible quota. The RPC limits include this buffer:
 *   Starter internal = 500 = 400 display + 100 buffer
 *   Pro     internal = 800 = 700 display + 100 buffer
 *   Power   internal = 2600 = 2500 display + 100 buffer
 *
 * Behaviour:
 *   0 → displayLimit      : normal — user sees usage counting up
 *   displayLimit+1 → internal : buffer zone — calls still go through,
 *                                user sees "0 remaining", NO Telegram spam
 *   internal+1 →           : hard block — RPC denies, proxy returns error
 */
const HEARTBEAT_BUFFER = 100;

/**
 * Global daily spend cap in dollars. If total platform-wide usage exceeds
 * this threshold, only starter-tier (haiku) requests are allowed through.
 * Configurable via DAILY_SPEND_CAP_DOLLARS env var.
 */
const DAILY_SPEND_CAP =
  parseFloat(process.env.DAILY_SPEND_CAP_DOLLARS ?? "100");

/** Track whether we've already sent a circuit-breaker alert today. */
let circuitBreakerAlertDate = "";

/**
 * Track which VMs have already been shown the daily-limit message today.
 * Key: "vmId:YYYY-MM-DD", Value: true.
 * Prevents the limit message from being sent to Telegram hundreds of times.
 * The friendly message is sent ONCE, then all subsequent calls get a 429.
 * Memory resets on cold start, so worst case the user sees it a few times.
 */
const limitNotifiedToday = new Map<string, boolean>();

/** Extract the model family from a full model id (e.g. "claude-sonnet-4-5-..." → "sonnet"). */
function modelFamily(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes("opus")) return "opus";
  if (lower.includes("sonnet")) return "sonnet";
  if (lower.includes("haiku")) return "haiku";
  return "unknown";
}

/**
 * Build a valid Anthropic Messages API response containing a friendly text
 * message. OpenClaw treats this as a normal assistant reply, so the user
 * sees a natural chat message instead of a raw error.
 */
function friendlyAssistantResponse(text: string, model: string, stream: boolean) {
  if (stream) {
    return friendlyStreamResponse(text, model);
  }
  return NextResponse.json(
    {
      id: "msg_limit_" + Date.now(),
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      model,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    { status: 200 }
  );
}

/**
 * Build a valid Anthropic SSE stream containing a friendly text message.
 * Required when the OpenClaw gateway sends stream:true — returning plain
 * JSON to a streaming request causes "request ended without sending any chunks".
 */
function friendlyStreamResponse(text: string, model: string) {
  const msgId = "msg_limit_" + Date.now();
  const events = [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: msgId, type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ];

  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) {
        controller.enqueue(encoder.encode(event));
      }
      controller.close();
    },
  });

  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}

/**
 * Gateway proxy for all-inclusive VMs.
 *
 * The OpenClaw gateway on each VM calls this endpoint instead of Anthropic
 * directly. This gives us centralized rate limiting per tier:
 *   - Starter: 400 units/day  (internal limit 500 incl. heartbeat buffer)
 *   - Pro:     700 units/day  (internal limit 800)
 *   - Power:  2500 units/day  (internal limit 2600)
 *
 * The 100-unit buffer lets automated heartbeats continue even after the
 * user's visible quota is exhausted, without spamming "out of credits"
 * messages to Telegram. Hard block only at the internal limit.
 *
 * All tiers have access to all models. Cost weights handle fairness:
 * Haiku=1, Sonnet=4, Opus=19 (reflects actual Anthropic pricing ratios).
 *
 * Auth: x-api-key header (gateway token, sent by Anthropic SDK on VMs).
 */
export async function POST(req: NextRequest) {
  try {
    // --- Authenticate via gateway token ---
    // Accept from x-gateway-token (legacy) or x-api-key (Anthropic SDK compat)
    const gatewayToken =
      req.headers.get("x-gateway-token") || req.headers.get("x-api-key");
    if (!gatewayToken) {
      return NextResponse.json(
        { error: "Missing authentication" },
        { status: 401 }
      );
    }

    const supabase = getSupabase();

    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, gateway_token, api_mode, tier, default_model")
      .eq("gateway_token", gatewayToken)
      .single();

    if (!vm) {
      return NextResponse.json(
        { error: "Invalid gateway token" },
        { status: 401 }
      );
    }

    // --- Reject VMs with no api_mode set (misconfigured) ---
    if (!vm.api_mode) {
      logger.error("VM has null api_mode — blocking request", {
        route: "gateway/proxy",
        vmId: vm.id,
      });
      return NextResponse.json(
        {
          type: "error",
          error: {
            type: "forbidden",
            message:
              "Your instance is not fully configured. Please contact support or retry setup at instaclaw.io.",
          },
        },
        { status: 403 }
      );
    }

    // Only all-inclusive VMs should use the proxy
    if (vm.api_mode !== "all_inclusive") {
      return NextResponse.json(
        { error: "BYOK users should call Anthropic directly" },
        { status: 403 }
      );
    }

    // --- Fail-safe: if tier is null, default to starter ---
    const tier = vm.tier || "starter";
    if (!vm.tier) {
      logger.warn("VM has null tier — defaulting to starter", {
        route: "gateway/proxy",
        vmId: vm.id,
      });
    }

    // --- Parse request body to extract model and stream flag ---
    const body = await req.text();
    let requestedModel: string;
    let isStreaming = false;
    try {
      const parsed = JSON.parse(body);
      requestedModel = parsed.model || vm.default_model || "claude-haiku-4-5-20251001";
      isStreaming = parsed.stream === true;
    } catch {
      requestedModel = vm.default_model || "claude-haiku-4-5-20251001";
    }

    // --- Global daily spend circuit breaker ---
    const todayStr = new Date().toISOString().split("T")[0];
    const { data: totalUsageRows } = await supabase
      .from("instaclaw_daily_usage")
      .select("message_count")
      .eq("usage_date", todayStr);

    const totalUnitsToday = (totalUsageRows ?? []).reduce(
      (sum: number, row: { message_count: number }) => sum + row.message_count,
      0
    );
    const estimatedSpend = totalUnitsToday * COST_PER_UNIT;

    if (estimatedSpend >= DAILY_SPEND_CAP && tier !== "starter") {
      logger.error("Circuit breaker tripped — daily spend cap exceeded", {
        route: "gateway/proxy",
        estimatedSpend,
        cap: DAILY_SPEND_CAP,
        totalUnits: totalUnitsToday,
        vmId: vm.id,
        tier,
      });

      // Send alert email once per day
      if (circuitBreakerAlertDate !== todayStr) {
        circuitBreakerAlertDate = todayStr;
        sendAdminAlertEmail(
          "Circuit Breaker Tripped — Daily Spend Cap Exceeded",
          `Estimated daily API spend: $${estimatedSpend.toFixed(2)}\nCap: $${DAILY_SPEND_CAP}\nTotal units today: ${totalUnitsToday}\n\nAll non-starter requests are being paused. Starter (Haiku) requests still allowed.\n\nAdjust via DAILY_SPEND_CAP_DOLLARS env var.`
        ).catch(() => {});
      }

      return friendlyAssistantResponse(
        "Hey! The platform is at capacity for today. Service resets at midnight UTC. In the meantime, you can switch to Haiku for basic tasks — just ask me to \"use Haiku\" and I'll switch models.\n\nSorry about the wait!",
        requestedModel,
        isStreaming
      );
    }

    // --- Check daily usage limit (with model cost weights) ---
    // The RPC uses internal limits (display + buffer). It returns:
    //   allowed: true/false, count: current usage, limit: internal limit
    const { data: limitResult, error: limitError } = await supabase.rpc(
      "instaclaw_check_daily_limit",
      { p_vm_id: vm.id, p_tier: tier, p_model: requestedModel }
    );

    if (limitError) {
      logger.error("Usage limit check failed", { error: String(limitError), route: "gateway/proxy", vmId: vm.id });
      return NextResponse.json(
        {
          type: "error",
          error: {
            type: "rate_limit_error",
            message: "Usage check temporarily unavailable. Please retry in a moment.",
          },
        },
        { status: 503 }
      );
    }

    // Derive display limit from the RPC's internal limit
    const internalLimit = limitResult?.limit ?? 1;
    const displayLimit = Math.max(1, internalLimit - HEARTBEAT_BUFFER);
    const currentCount = limitResult?.count ?? 0;

    // --- Hard block: internal limit exceeded (RPC denied) ---
    // Send a friendly "daily limit" message ONCE so the user knows why the
    // bot stopped, then return 429 for all subsequent calls so OpenClaw
    // backs off instead of spamming Telegram with hundreds of copies.
    if (limitResult && !limitResult.allowed) {
      const notifyKey = `${vm.id}:${todayStr}`;

      if (!limitNotifiedToday.has(notifyKey)) {
        // First time hitting limit today — send the friendly message once
        limitNotifiedToday.set(notifyKey, true);
        return friendlyAssistantResponse(
          `You've hit your daily limit (${displayLimit}/${displayLimit} units). Your limit resets at midnight UTC.\n\nWant to keep going? Grab a credit pack — they kick in instantly:\n\nhttps://instaclaw.io/dashboard?buy=credits`,
          requestedModel,
          isStreaming
        );
      }

      // Already notified — return 429 so OpenClaw backs off silently
      return NextResponse.json(
        {
          type: "error",
          error: {
            type: "rate_limit_error",
            message: `Daily limit reached (${displayLimit}/${displayLimit} units). Resets at midnight UTC.`,
          },
        },
        {
          status: 429,
          headers: {
            "retry-after": "3600",
          },
        }
      );
    }

    // --- Buffer zone: count > displayLimit but < internalLimit ---
    // Calls still go through (RPC said allowed=true), but we skip usage
    // warnings so the user doesn't see confusing counts above their limit.
    // Heartbeats that fire after the user's visible quota is exhausted
    // land here silently.
    const inBufferZone = currentCount > displayLimit;

    // --- Compute usage warning thresholds (only in normal zone) ---
    let usageWarning = "";
    if (!inBufferZone) {
      const displayCount = Math.min(currentCount, displayLimit);
      const usagePct = (displayCount / displayLimit) * 100;

      if (usagePct >= 90) {
        usageWarning = `\n\n---\n⚠️ You've used ${displayCount} of ${displayLimit} daily units. Running low — credit packs available at instaclaw.io/dashboard?buy=credits`;
      } else if (usagePct >= 80) {
        usageWarning = `\n\n---\n⚡ You've used ${displayCount} of ${displayLimit} daily units.`;
      }
    }

    // --- Proxy to Anthropic ---
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      logger.error("ANTHROPIC_API_KEY not set for proxy", { route: "gateway/proxy" });
      return NextResponse.json(
        { error: "Platform API key not configured" },
        { status: 500 }
      );
    }

    const anthropicRes = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": req.headers.get("anthropic-version") || "2023-06-01",
      },
      body,
    });

    // If streaming or no usage warning needed, pass through the response directly.
    // Streaming responses are SSE text that can't be JSON-parsed, so we never
    // try to buffer/modify them — that was causing "request ended without sending
    // any chunks" when the buffered SSE was returned as a single JSON blob.
    if (isStreaming || !usageWarning) {
      return new NextResponse(anthropicRes.body, {
        status: anthropicRes.status,
        headers: {
          "content-type": anthropicRes.headers.get("content-type") || "application/json",
        },
      });
    }

    // Non-streaming: append usage warning to the AI response
    const resText = await anthropicRes.text();
    try {
      const resBody = JSON.parse(resText);
      if (resBody.content && Array.isArray(resBody.content)) {
        // Find last text block and append warning
        for (let i = resBody.content.length - 1; i >= 0; i--) {
          if (resBody.content[i].type === "text") {
            resBody.content[i].text += usageWarning;
            break;
          }
        }
      }
      return NextResponse.json(resBody, {
        status: anthropicRes.status,
      });
    } catch {
      // If parsing fails, return original response without warning
      return new NextResponse(resText, {
        status: anthropicRes.status,
        headers: {
          "content-type": anthropicRes.headers.get("content-type") || "application/json",
        },
      });
    }
  } catch (err) {
    logger.error("Gateway proxy error", { error: String(err), route: "gateway/proxy" });
    return NextResponse.json(
      { error: "Proxy error" },
      { status: 500 }
    );
  }
}
