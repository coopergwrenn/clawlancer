import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { sendAdminAlertEmail } from "@/lib/email";
import { trackProxy401, resetProxy401Count } from "@/lib/proxy-alert";
import { repairCorruptedSession, type VMRecord } from "@/lib/ssh";
import { routeModel, extractLastUserMessage, computeTierBudget, type RoutingContext, type RoutingDecision } from "@/lib/model-router";
import { TASK_EXECUTION_SUFFIX } from "@/lib/system-prompt";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MINIMAX_API_URL = "https://api.minimax.io/anthropic/v1/messages";

/**
 * Estimated cost per message unit in dollars (haiku-equivalent).
 * With intelligent routing, some units cost 3.75x (Sonnet) or 18.75x (Opus)
 * more than Haiku. The safety factor compensates for the actual model mix
 * so the circuit breaker doesn't underestimate real API spend.
 */
const COST_PER_UNIT = 0.004;
const COST_SAFETY_FACTOR = 2.5;

/**
 * The RPC returns a 'source' field that tells the proxy how to handle
 * each call:
 *   'daily_limit' — within display limit, normal usage
 *   'credits'     — over display limit but user has credit pack balance
 *   'buffer'      — over display limit, no credits, within heartbeat buffer
 *   null          — hard block, everything exhausted
 *
 * Display limits: Starter=600, Pro=1000, Power=2500
 * Internal limits (display + 200 buffer): Starter=800, Pro=1200, Power=2700
 *
 * Notification dedup is stored in the DB (instaclaw_vms.limit_notified_date)
 * so it survives Vercel cold starts.
 */

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
 * Return a valid but empty assistant response (no content).
 * OpenClaw treats this as "nothing to say" and won't forward to Telegram.
 */
function silentEmptyResponse(model: string, stream: boolean) {
  if (stream) {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        const msgId = `msg_limit_${Date.now()}`;
        controller.enqueue(encoder.encode(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: msgId, type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`));
        controller.enqueue(encoder.encode(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } })}\n\n`));
        controller.enqueue(encoder.encode(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  }
  return NextResponse.json(
    {
      id: `msg_limit_${Date.now()}`,
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    { status: 200 }
  );
}

/**
 * Gateway proxy for all-inclusive VMs.
 *
 * The OpenClaw gateway on each VM calls this endpoint instead of Anthropic
 * directly. This gives us centralized rate limiting per tier:
 *   - Starter: 600 units/day  (internal limit 800 incl. 200 heartbeat buffer)
 *   - Pro:    1000 units/day  (internal limit 1200)
 *   - Power:  2500 units/day  (internal limit 2700)
 *
 * Flow after display limit:
 *   1. Credits kick in first — if the user has a credit pack, they keep chatting
 *   2. No credits → buffer zone (heartbeats/system only, user messages blocked)
 *   3. Buffer exhausted → hard block on everything
 *
 * All tiers have access to all models. Cost weights handle fairness:
 * MiniMax=0.2, Haiku=1, Sonnet=4, Opus=19.
 *
 * Auth: x-api-key header (gateway token, sent by Anthropic SDK on VMs).
 */
export async function POST(req: NextRequest) {
  try {
    // --- Authenticate via gateway token ---
    // Accept from x-gateway-token (legacy), x-api-key (Anthropic SDK),
    // or Authorization: Bearer <token> (OpenAI SDK / openai-responses format)
    const authHeader = req.headers.get("authorization");
    const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const gatewayToken =
      req.headers.get("x-gateway-token") || req.headers.get("x-api-key") || bearerToken;
    if (!gatewayToken) {
      return NextResponse.json(
        { error: "Missing authentication" },
        { status: 401 }
      );
    }

    const supabase = getSupabase();

    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, ssh_port, ssh_user, gateway_token, api_mode, tier, default_model, limit_notified_date, heartbeat_next_at, heartbeat_last_at, heartbeat_interval, heartbeat_cycle_calls, user_timezone")
      .eq("gateway_token", gatewayToken)
      .single();

    if (!vm) {
      // Track proxy 401 for alerting — find VM by IP and alert if repeated
      trackProxy401(gatewayToken, req).catch(() => {});
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
    let parsedBody: Record<string, unknown> | null = null;
    try {
      parsedBody = JSON.parse(body);
      requestedModel = (parsedBody!.model as string) || vm.default_model || "minimax-m2.5";
      isStreaming = parsedBody!.stream === true;
    } catch {
      requestedModel = vm.default_model || "minimax-m2.5";
    }

    // --- Strip thinking blocks from conversation history ---
    // OpenClaw's promoteThinkingTagsToBlocks() converts MiniMax reasoning
    // tags into type:"thinking" blocks without valid Anthropic signatures.
    // When these get replayed, the API rejects with "Invalid signature in
    // thinking block". Strip them at the proxy level to prevent this permanently.
    if (parsedBody?.messages && Array.isArray(parsedBody.messages)) {
      let thinkingStripped = false;
      for (const msg of parsedBody.messages as Array<{ role?: string; content?: unknown }>) {
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          const filtered = (msg.content as Array<{ type?: string }>).filter(
            (block) => block.type !== "thinking"
          );
          if (filtered.length !== (msg.content as Array<unknown>).length) {
            msg.content = filtered.length > 0 ? filtered : [{ type: "text", text: "" }];
            thinkingStripped = true;
          }
        }
      }
      if (thinkingStripped) {
        logger.info("Stripped thinking blocks from conversation history", {
          route: "gateway/proxy",
          vmId: vm.id,
        });
      }
    }

    // --- Global daily spend circuit breaker (always UTC) ---
    const todayStr = new Date().toISOString().split("T")[0];

    // --- User's local date for per-user limit checks ---
    const userTz = vm.user_timezone || "America/New_York";
    const userTodayStr = new Date().toLocaleDateString("en-CA", { timeZone: userTz });
    const { data: totalUsageRows } = await supabase
      .from("instaclaw_daily_usage")
      .select("message_count")
      .eq("usage_date", todayStr);

    const totalUnitsToday = (totalUsageRows ?? []).reduce(
      (sum: number, row: { message_count: number }) => sum + row.message_count,
      0
    );
    const estimatedSpend = totalUnitsToday * COST_PER_UNIT * COST_SAFETY_FACTOR;

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
        "Hey! The platform is at capacity for today. Service resets at midnight. In the meantime, you can switch to Haiku for basic tasks — just ask me to \"use Haiku\" and I'll switch models.\n\nSorry about the wait!",
        requestedModel,
        isStreaming
      );
    }

    // --- Detect Virtuals ACP calls (separate credit budget) ---
    const isVirtuals = req.headers.get("x-source") === "virtuals-acp";

    // --- Detect heartbeat vs user call ---
    // Heartbeats fire on a schedule and produce a burst of API calls.
    // If a heartbeat is due (next_at in the past) or recently fired (last_at
    // within 5 minutes), classify this call as a heartbeat. Heartbeat calls
    // draw from a separate 100-unit daily budget and never touch the user's quota.
    const now = new Date();
    const hbNextAt = vm.heartbeat_next_at ? new Date(vm.heartbeat_next_at) : null;
    const hbLastAt = vm.heartbeat_last_at ? new Date(vm.heartbeat_last_at) : null;
    const heartbeatDue = hbNextAt && now >= hbNextAt;
    const heartbeatRecent = hbLastAt && (now.getTime() - hbLastAt.getTime()) < 5 * 60 * 1000;
    const isHeartbeat = !!(heartbeatDue || heartbeatRecent);

    // --- Heartbeat model override: always use minimax-m2.5 for background tasks ---
    // Users shouldn't burn Sonnet/Opus credits on heartbeat check-ins.
    if (isHeartbeat && !requestedModel.toLowerCase().includes("minimax")) {
      requestedModel = "minimax-m2.5";
      if (parsedBody) {
        parsedBody.model = "minimax-m2.5";
      }
    }

    // --- Per-cycle heartbeat cap (max 10 API calls per heartbeat cycle) ---
    // Each heartbeat cycle should be a quick check-in, not 50-60 LLM calls.
    // This hard cap prevents runaway heartbeats from burning budget.
    const HEARTBEAT_CYCLE_CAP = 10;
    if (isHeartbeat) {
      const cycleCallsSoFar = vm.heartbeat_cycle_calls ?? 0;

      if (heartbeatDue) {
        // New cycle starting — reset the counter (happens in timing update below)
      } else if (cycleCallsSoFar >= HEARTBEAT_CYCLE_CAP) {
        // Current cycle already hit the cap — silently drop
        logger.info("Heartbeat cycle cap reached", {
          route: "gateway/proxy",
          vmId: vm.id,
          cycleCallsSoFar,
          cap: HEARTBEAT_CYCLE_CAP,
        });
        return silentEmptyResponse(requestedModel, isStreaming);
      }
    }

    // --- Check daily usage limit (read-only, no increment) ---
    // The merged RPC also returns tier budget (tier_2_calls, tier_3_calls,
    // sonnet_remaining, opus_remaining) for non-heartbeat calls, eliminating
    // the need for a separate instaclaw_check_tier_budget call.
    // Uses the original model for cost weight — routing may change it, but
    // the 200-unit buffer absorbs any weight difference. The increment RPC
    // always uses the final routed model for correct cost tracking.
    const { data: limitResult, error: limitError } = await supabase.rpc(
      "instaclaw_check_limit_only",
      { p_vm_id: vm.id, p_tier: tier, p_model: requestedModel, p_is_heartbeat: isHeartbeat, p_timezone: userTz, p_is_virtuals: isVirtuals }
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

    // Tier-correct fallback: NEVER default to 600 (starter) when the VM is on a higher tier.
    // If the RPC returns null for display_limit (race condition, timeout, etc.),
    // use the tier's actual limit instead of a hardcoded 600.
    const TIER_DISPLAY_LIMITS: Record<string, number> = {
      starter: 600,
      pro: 1000,
      power: 2500,
      internal: 5000,
    };
    const tierFallbackLimit = TIER_DISPLAY_LIMITS[tier] ?? 600;
    const displayLimit = limitResult?.display_limit ?? tierFallbackLimit;
    const currentCount = limitResult?.count ?? 0;
    const source: string | null = limitResult?.source ?? null;

    // Diagnostic: log limit check results for debugging
    logger.info("Limit check result", {
      route: "gateway/proxy",
      vmId: vm.id,
      tier,
      displayLimit,
      currentCount,
      source,
      allowed: limitResult?.allowed,
      rpcRaw: JSON.stringify(limitResult),
    });

    // --- Heartbeat budget exhausted: silently drop + log ---
    if (source === "heartbeat_exhausted") {
      logger.info("Heartbeat skipped: daily limit reached", {
        route: "gateway/proxy",
        vmId: vm.id,
        source,
      });
      return silentEmptyResponse(requestedModel, isStreaming);
    }

    // --- Virtuals budget exhausted: return 429 so handler returns polite message ---
    if (source === "virtuals_exhausted") {
      logger.info("Virtuals job rejected: daily virtuals limit reached", {
        route: "gateway/proxy",
        vmId: vm.id,
        virtualsCount: limitResult?.virtuals_count ?? 0,
        virtualsLimit: limitResult?.virtuals_limit ?? 0,
      });
      return friendlyAssistantResponse(
        "This agent has reached its daily Virtuals Protocol capacity. Please try again tomorrow.",
        requestedModel,
        isStreaming
      );
    }

    // --- Hard block: everything exhausted (RPC denied) ---
    // User messages always get the upsell response — never silence.
    // Heartbeats never reach here (handled by heartbeat_exhausted above).
    if (limitResult && !limitResult.allowed) {
      // Log once per day for monitoring
      if (vm.limit_notified_date !== userTodayStr) {
        supabase
          .from("instaclaw_vms")
          .update({ limit_notified_date: userTodayStr })
          .eq("id", vm.id)
          .then(() => {});
        logger.info("User hit hard block — daily limit exhausted", {
          route: "gateway/proxy",
          vmId: vm.id,
          displayLimit,
          currentCount,
        });
      }

      return friendlyAssistantResponse(
        `You've hit your daily message limit (${displayLimit}/${displayLimit}). Want to keep going? Grab more credits or upgrade your plan here:\n\nhttps://instaclaw.io/dashboard/billing`,
        requestedModel,
        isStreaming
      );
    }

    // --- Buffer zone: over display limit, no credits, within internal limit ---
    // User messages always get the upsell response — never silence.
    // Heartbeats never land here — they have their own budget path above.
    if (source === "buffer") {
      // Log once per day for monitoring
      if (vm.limit_notified_date !== userTodayStr) {
        supabase
          .from("instaclaw_vms")
          .update({ limit_notified_date: userTodayStr })
          .eq("id", vm.id)
          .then(() => {});
        logger.info("User hit buffer zone — daily limit reached", {
          route: "gateway/proxy",
          vmId: vm.id,
          displayLimit,
          currentCount,
        });
      }

      return friendlyAssistantResponse(
        `You've hit your daily message limit (${displayLimit}/${displayLimit}). Want to keep going? Grab more credits or upgrade your plan here:\n\nhttps://instaclaw.io/dashboard/billing`,
        requestedModel,
        isStreaming
      );
    }

    // --- Normal zone or credits: forward to Anthropic ---
    // source === 'daily_limit' (within display limit) or 'credits' (user paid)

    // Compute usage warnings (only for daily_limit source, not credits)
    let usageWarning = "";
    if (source === "daily_limit") {
      const displayCount = Math.round(Math.min(currentCount, displayLimit));
      const usagePct = (displayCount / displayLimit) * 100;

      if (usagePct >= 90) {
        usageWarning = `\n\n---\n⚠️ You've used ${displayCount} of ${displayLimit} daily units. Running low — credit packs available at instaclaw.io/dashboard?buy=credits`;
      } else if (usagePct >= 80) {
        usageWarning = `\n\n---\n⚡ You've used ${displayCount} of ${displayLimit} daily units.`;
      }
    }

    // --- Intelligent model routing ---
    // Route the request to the optimal model tier based on content analysis,
    // toggles, and per-tier budget (returned by the merged limit check RPC).
    // Advisory only — if routing throws, we proceed with the original model.
    let routingDecision: RoutingDecision | null = null;
    if (!isHeartbeat && !isVirtuals) {
      try {
        // Read tier budget from the merged limit check result
        const tierBudget = computeTierBudget(tier, limitResult ? {
          tier_2_calls: limitResult.tier_2_calls ?? 0,
          tier_3_calls: limitResult.tier_3_calls ?? 0,
        } : null);

        // Extract routing signals from the request body
        const messages = (parsedBody?.messages as Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>) ?? [];
        const systemPrompt = typeof parsedBody?.system === "string" ? parsedBody.system as string : "";
        const userMessage = extractLastUserMessage(messages);
        const isTaskExecution = systemPrompt.includes("TASK EXECUTION MODE");
        const isRecurringTask = systemPrompt.includes("RECURRING TASK");
        const hasDeepResearch = systemPrompt.includes("DEEP RESEARCH");
        const hasWebSearch = systemPrompt.includes("WEB SEARCH");

        const routingCtx: RoutingContext = {
          userMessage,
          messageCount: messages.length,
          systemPrompt,
          isHeartbeat: false,
          isTaskExecution,
          isRecurringTask,
          toggles: { deepResearch: hasDeepResearch, webSearch: hasWebSearch },
          tierBudget,
        };

        routingDecision = routeModel(routingCtx);

        // Apply the routing decision
        if (routingDecision.model !== requestedModel) {
          logger.info("Model routed", {
            route: "gateway/proxy",
            vmId: vm.id,
            requestedModel,
            routedModel: routingDecision.model,
            tier: routingDecision.tier,
            reason: routingDecision.reason,
          });
          requestedModel = routingDecision.model;
          if (parsedBody) {
            parsedBody.model = routingDecision.model;
          }
        } else {
          // Log confirmations at debug level for routing distribution visibility
          logger.debug("Model routing confirmed", {
            route: "gateway/proxy",
            vmId: vm.id,
            model: requestedModel,
            tier: routingDecision.tier,
            reason: routingDecision.reason,
          });
        }
      } catch (routeErr) {
        // Router is advisory — never block a request
        logger.warn("Model routing failed, using original model", {
          route: "gateway/proxy",
          vmId: vm.id,
          error: String(routeErr),
          model: requestedModel,
        });
      }
    }

    // Reset proxy 401 counter on successful auth (fire-and-forget)
    resetProxy401Count(vm.id).catch(() => {});

    // --- Route to the correct provider ---
    const isMinimax = requestedModel.toLowerCase().includes("minimax");
    let providerUrl: string;
    let providerHeaders: Record<string, string>;
    let providerBody: string;

    if (isMinimax) {
      const minimaxKey = process.env.MINIMAX_API_KEY;
      if (!minimaxKey) {
        logger.error("MINIMAX_API_KEY not set for proxy", { route: "gateway/proxy" });
        return NextResponse.json(
          { error: "MiniMax API key not configured" },
          { status: 500 }
        );
      }
      providerUrl = MINIMAX_API_URL;
      providerHeaders = {
        "content-type": "application/json",
        "authorization": `Bearer ${minimaxKey}`,
        "anthropic-version": req.headers.get("anthropic-version") || "2023-06-01",
      };
      // Rewrite model name to what MiniMax's API expects
      if (parsedBody) {
        parsedBody.model = "MiniMax-M2.5";
        providerBody = JSON.stringify(parsedBody);
      } else {
        providerBody = body;
      }
    } else {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        logger.error("ANTHROPIC_API_KEY not set for proxy", { route: "gateway/proxy" });
        return NextResponse.json(
          { error: "Platform API key not configured" },
          { status: 500 }
        );
      }
      providerUrl = ANTHROPIC_API_URL;
      providerHeaders = {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": req.headers.get("anthropic-version") || "2023-06-01",
      };
      // Use parsedBody if model was rewritten by the router
      providerBody = parsedBody ? JSON.stringify(parsedBody) : body;
    }

    const providerRes = await fetch(providerUrl, {
      method: "POST",
      headers: providerHeaders,
      body: providerBody,
    });

    // --- On provider error (4xx/5xx): DON'T increment usage, log and return ---
    // But first: try Sonnet→Opus auto-retry if the router suggested it.
    let finalProviderRes = providerRes;
    let finalModel = requestedModel;

    if (providerRes.status >= 400 && routingDecision?.retryOnFailure && !isMinimax) {
      const errBody = await providerRes.text();
      const retryModel = routingDecision.retryOnFailure;

      // Only retry on server errors (5xx) or overloaded (529), not client errors
      if (providerRes.status >= 500 || providerRes.status === 529) {
        logger.warn("Model auto-retry: escalating to higher tier", {
          route: "gateway/proxy",
          vmId: vm.id,
          originalModel: requestedModel,
          retryModel,
          originalStatus: providerRes.status,
        });

        // Rewrite model in body for retry
        if (parsedBody) {
          parsedBody.model = retryModel;
        }
        const retryBody = parsedBody ? JSON.stringify(parsedBody) : body;

        try {
          const retryRes = await fetch(providerUrl, {
            method: "POST",
            headers: providerHeaders,
            body: retryBody,
          });

          if (retryRes.ok) {
            // Retry succeeded — use this response instead
            finalProviderRes = retryRes;
            finalModel = retryModel;
            // Update routingDecision tier for usage tracking
            routingDecision = { ...routingDecision, model: retryModel, tier: 3, reason: "auto-retry escalation" };
          } else {
            // Retry also failed — return original error
            logger.error("Auto-retry also failed", {
              route: "gateway/proxy",
              vmId: vm.id,
              retryModel,
              retryStatus: retryRes.status,
            });
            return new NextResponse(errBody, {
              status: providerRes.status,
              headers: {
                "content-type": providerRes.headers.get("content-type") || "application/json",
              },
            });
          }
        } catch (retryErr) {
          logger.error("Auto-retry fetch error", {
            route: "gateway/proxy",
            vmId: vm.id,
            error: String(retryErr),
          });
          return new NextResponse(errBody, {
            status: providerRes.status,
            headers: {
              "content-type": providerRes.headers.get("content-type") || "application/json",
            },
          });
        }
      } else {
        // Client error (4xx other than 529) — no retry, handle normally
        // Re-assign errBody since we already consumed it
        logger.error("Provider API error — usage NOT incremented", {
          route: "gateway/proxy",
          vmId: vm.id,
          provider: isMinimax ? "minimax" : "anthropic",
          status: providerRes.status,
          response: errBody.slice(0, 500),
          model: requestedModel,
        });

        if (errBody.includes("Invalid signature in thinking block")) {
          logger.warn("Corrupted thinking block detected — repairing session", {
            route: "gateway/proxy",
            vmId: vm.id,
          });
          repairCorruptedSession(vm as VMRecord).then((ok) => {
            if (ok) {
              logger.info("Corrupted session removed (other sessions preserved)", {
                route: "gateway/proxy",
                vmId: vm.id,
              });
            } else {
              logger.error("Failed to repair corrupted session", {
                route: "gateway/proxy",
                vmId: vm.id,
              });
            }
          }).catch(() => {});
          return friendlyAssistantResponse(
            "I ran into a conversation error and had to reset. Let's start fresh — what can I help you with?",
            requestedModel,
            isStreaming
          );
        }

        return new NextResponse(errBody, {
          status: providerRes.status,
          headers: {
            "content-type": providerRes.headers.get("content-type") || "application/json",
          },
        });
      }
    } else if (finalProviderRes.status >= 400) {
      const errBody = await finalProviderRes.text();
      logger.error("Provider API error — usage NOT incremented", {
        route: "gateway/proxy",
        vmId: vm.id,
        provider: isMinimax ? "minimax" : "anthropic",
        status: finalProviderRes.status,
        response: errBody.slice(0, 500),
        model: requestedModel,
      });

      // --- Auto-recover from corrupted thinking block signatures ---
      if (errBody.includes("Invalid signature in thinking block")) {
        logger.warn("Corrupted thinking block detected — repairing session", {
          route: "gateway/proxy",
          vmId: vm.id,
        });
        repairCorruptedSession(vm as VMRecord).then((ok) => {
          if (ok) {
            logger.info("Corrupted session removed (other sessions preserved)", {
              route: "gateway/proxy",
              vmId: vm.id,
            });
          } else {
            logger.error("Failed to repair corrupted session", {
              route: "gateway/proxy",
              vmId: vm.id,
            });
          }
        }).catch(() => {});
        return friendlyAssistantResponse(
          "I ran into a conversation error and had to reset. Let's start fresh — what can I help you with?",
          requestedModel,
          isStreaming
        );
      }

      return new NextResponse(errBody, {
        status: finalProviderRes.status,
        headers: {
          "content-type": finalProviderRes.headers.get("content-type") || "application/json",
        },
      });
    }

    // --- Success (2xx): increment usage AFTER confirmed provider response ---
    supabase
      .rpc("instaclaw_increment_usage", {
        p_vm_id: vm.id,
        p_model: finalModel,
        p_is_heartbeat: isHeartbeat,
        p_timezone: userTz,
        p_is_virtuals: isVirtuals,
      })
      .then(({ error: incError }) => {
        if (incError) {
          logger.error("Failed to increment usage after successful API call", {
            route: "gateway/proxy",
            vmId: vm.id,
            error: String(incError),
            isHeartbeat,
          });
        }
      });

    // --- Increment tier usage (fire-and-forget) ---
    if (routingDecision && !isHeartbeat) {
      const costWeight = routingDecision.tier === 1 ? 1 : routingDecision.tier === 2 ? 4 : 19;
      supabase
        .rpc("instaclaw_increment_tier_usage", {
          p_vm_id: vm.id,
          p_tier_level: routingDecision.tier,
          p_cost_weight: costWeight,
          p_timezone: userTz,
        })
        .then(({ error: tierErr }) => {
          if (tierErr) {
            logger.error("Failed to increment tier usage", {
              route: "gateway/proxy",
              vmId: vm.id,
              error: String(tierErr),
              tier: routingDecision!.tier,
            });
          }
        });
    }

    // Update heartbeat timing + cycle counter (fire-and-forget)
    if (isHeartbeat) {
      if (heartbeatDue) {
        // New cycle: reset cycle counter to 1 (this call), update timing
        const interval = vm.heartbeat_interval ?? "3h";
        const hMatch = interval.match(/^(\d+(?:\.\d+)?)h$/);
        const nextMs = hMatch ? parseFloat(hMatch[1]) * 3_600_000 : 10_800_000;
        supabase
          .from("instaclaw_vms")
          .update({
            heartbeat_last_at: now.toISOString(),
            heartbeat_next_at: new Date(now.getTime() + nextMs).toISOString(),
            heartbeat_cycle_calls: 1,
          })
          .eq("id", vm.id)
          .then(() => {});
      } else {
        // Continuing cycle: increment cycle counter
        supabase
          .from("instaclaw_vms")
          .update({
            heartbeat_cycle_calls: (vm.heartbeat_cycle_calls ?? 0) + 1,
          })
          .eq("id", vm.id)
          .then(() => {});
      }
    }

    // If streaming or no usage warning needed, pass through the response directly.
    // Streaming responses are SSE text that can't be JSON-parsed, so we never
    // try to buffer/modify them — that was causing "request ended without sending
    // any chunks" when the buffered SSE was returned as a single JSON blob.
    if (isStreaming || !usageWarning) {
      return new NextResponse(finalProviderRes.body, {
        status: finalProviderRes.status,
        headers: {
          "content-type": finalProviderRes.headers.get("content-type") || "application/json",
          "x-ic-tier": tier,
          "x-ic-display-limit": String(displayLimit),
          "x-ic-count": String(currentCount),
          "x-ic-source": source ?? "null",
          "x-ic-allowed": String(limitResult?.allowed ?? "null"),
        },
      });
    }

    // Non-streaming: append usage warning to the AI response
    const resText = await finalProviderRes.text();
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
        status: finalProviderRes.status,
      });
    } catch {
      // If parsing fails, return original response without warning
      return new NextResponse(resText, {
        status: finalProviderRes.status,
        headers: {
          "content-type": finalProviderRes.headers.get("content-type") || "application/json",
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
