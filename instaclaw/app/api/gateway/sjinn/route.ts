import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

const SJINN_AGENT_CREATE_URL = "https://sjinn.ai/api/un-api/create_agent_task";
const SJINN_AGENT_QUERY_URL = "https://sjinn.ai/api/un-api/query_agent_task_status";
const SJINN_TOOL_CREATE_URL = "https://sjinn.ai/api/un-api/create_tool_task";
const SJINN_TOOL_QUERY_URL = "https://sjinn.ai/api/un-api/query_tool_task_status";

/**
 * Determine generation_type from the request body.
 * Agent API is always video production. Tool API depends on tool_type.
 */
function resolveGenerationType(
  api: string,
  toolType?: string
): "video" | "image" | "audio" {
  if (api === "agent") return "video";
  if (!toolType) return "video";

  const t = toolType.toLowerCase();
  if (t.includes("video")) return "video";
  if (t.includes("lipsync")) return "video";
  if (t.includes("image") || t.includes("banana")) return "image";
  return "video";
}

/**
 * Gateway proxy for Sjinn AI video/image/audio generation.
 *
 * Same auth pattern as the LLM proxy (app/api/gateway/proxy/route.ts):
 * gateway token → VM lookup → limit check → forward to Sjinn → increment usage.
 *
 * Unlike the LLM proxy, both all-inclusive AND BYOK users have access
 * (we pay Sjinn for all users). SJINN_API_KEY stays server-side only.
 *
 * Two actions via query param:
 *   ?action=create — Submit a new generation (checks daily limit)
 *   ?action=query  — Poll status of an existing generation (no limit check)
 */
export async function POST(req: NextRequest) {
  try {
    // --- Authenticate via gateway token (same pattern as LLM proxy) ---
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
      .select("id, tier, api_mode, user_timezone")
      .eq("gateway_token", gatewayToken)
      .single();

    if (!vm) {
      return NextResponse.json(
        { error: "Invalid gateway token" },
        { status: 401 }
      );
    }

    // --- Validate SJINN_API_KEY is configured server-side ---
    const sjinnApiKey = process.env.SJINN_API_KEY;
    if (!sjinnApiKey) {
      logger.error("SJINN_API_KEY not set for Sjinn proxy", {
        route: "gateway/sjinn",
      });
      return NextResponse.json(
        { error: "Video generation not configured" },
        { status: 500 }
      );
    }

    const action = req.nextUrl.searchParams.get("action");
    const body = await req.json();
    const api: string = body.api || "agent";
    const userTz = vm.user_timezone || "America/New_York";

    // ────────────────────────────────────────────────────────
    // ACTION: create — Submit a new generation
    // ────────────────────────────────────────────────────────
    if (action === "create") {
      const generationType = resolveGenerationType(api, body.tool_type);

      // --- Check daily limit ---
      const { data: limitResult, error: limitError } = await supabase.rpc(
        "instaclaw_check_video_limit",
        {
          p_vm_id: vm.id,
          p_generation_type: generationType,
          p_timezone: userTz,
        }
      );

      if (limitError) {
        logger.error("Video limit check failed", {
          route: "gateway/sjinn",
          vmId: vm.id,
          error: String(limitError),
        });
        return NextResponse.json(
          { error: "Usage check temporarily unavailable. Please retry." },
          { status: 503 }
        );
      }

      if (limitResult && !limitResult.approved) {
        return NextResponse.json(
          {
            error: "video_limit_reached",
            message: `You've hit your daily ${generationType} limit (${limitResult.used}/${limitResult.limit}). Resets at midnight.`,
            used: limitResult.used,
            limit: limitResult.limit,
          },
          { status: 429 }
        );
      }

      // --- Forward to Sjinn ---
      let sjinnUrl: string;
      let sjinnBody: Record<string, unknown>;

      if (api === "agent") {
        sjinnUrl = SJINN_AGENT_CREATE_URL;
        sjinnBody = {
          message: body.message,
          ...(body.template_id && { template_id: body.template_id }),
          ...(body.quality && { quality: body.quality }),
        };
      } else {
        sjinnUrl = SJINN_TOOL_CREATE_URL;
        sjinnBody = {
          tool_type: body.tool_type,
          input: body.input,
        };
      }

      let sjinnRes = await fetch(sjinnUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sjinnApiKey}`,
        },
        body: JSON.stringify(sjinnBody),
      });

      let sjinnData = await sjinnRes.json();
      let actualApi = api;

      // ── Auto-fallback: if Agent API fails, retry with Tool API ──
      // Sjinn Agent API can return success:false ("Start Agent Failed")
      // while Tool API still works. Fall back to veo3 via Tool API.
      if (
        api === "agent" &&
        sjinnData.success === false &&
        !body.template_id // Templates are Agent API only — can't fall back
      ) {
        const fallbackToolType = "veo3-text-to-video-fast-api";
        const fallbackBody = {
          tool_type: fallbackToolType,
          input: {
            prompt: body.message,
            aspect_ratio: body.aspect_ratio || body.input?.aspect_ratio || "16:9",
          },
        };

        logger.info("Agent API failed, falling back to Tool API", {
          route: "gateway/sjinn",
          vmId: vm.id,
          agentError: sjinnData.errorMsg,
          fallbackTool: fallbackToolType,
        });

        const fallbackRes = await fetch(SJINN_TOOL_CREATE_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${sjinnApiKey}`,
          },
          body: JSON.stringify(fallbackBody),
        });
        const fallbackData = await fallbackRes.json();

        if (fallbackData.success === true) {
          sjinnRes = fallbackRes;
          sjinnData = fallbackData;
          actualApi = "tool";
        }
      }

      // --- Handle Sjinn errors ---
      if (!sjinnRes.ok || sjinnData.code === 100 || sjinnData.code === 101) {
        // 100 = insufficient Sjinn balance, 101 = membership required
        // Never expose internal billing to the user
        if (sjinnData.code === 100 || sjinnData.code === 101) {
          logger.error("Sjinn billing error", {
            route: "gateway/sjinn",
            vmId: vm.id,
            code: sjinnData.code,
          });
          return NextResponse.json(
            {
              error: "service_unavailable",
              message:
                "Video generation is temporarily at capacity. Please try again later.",
            },
            { status: 503 }
          );
        }

        logger.error("Sjinn API error", {
          route: "gateway/sjinn",
          vmId: vm.id,
          status: sjinnRes.status,
          response: JSON.stringify(sjinnData).slice(0, 500),
        });
        return NextResponse.json(
          {
            error: "sjinn_error",
            message: "Video generation failed. Please try again.",
            details: sjinnData,
          },
          { status: sjinnRes.status >= 400 ? sjinnRes.status : 502 }
        );
      }

      // If success:false persists even after fallback (e.g. template-only request)
      if (sjinnData.success === false) {
        const isAgentDown = sjinnData.errorMsg?.includes("Start Agent Failed");
        logger.error("Sjinn create failed", {
          route: "gateway/sjinn",
          vmId: vm.id,
          api: actualApi,
          errorMsg: sjinnData.errorMsg,
          isAgentDown,
          hadTemplate: !!body.template_id,
        });
        return NextResponse.json(
          {
            error: "sjinn_error",
            message: isAgentDown
              ? "The video Agent API is temporarily unavailable. Single-shot videos via Tool API still work — try requesting a specific model (Veo3 or Sora2) instead of a multi-shot template."
              : "Video generation failed. Please try again.",
            details: sjinnData,
          },
          { status: 502 }
        );
      }

      // --- Success: increment usage ---
      const sjinnRequestId =
        actualApi === "agent"
          ? sjinnData.data?.chat_id
          : sjinnData.data?.task_id;

      supabase
        .rpc("instaclaw_increment_video_usage", {
          p_vm_id: vm.id,
          p_generation_type: generationType,
          p_sjinn_api: actualApi,
          p_sjinn_request_id: sjinnRequestId || null,
          p_sjinn_tool_type: body.tool_type || (actualApi !== api ? "veo3-text-to-video-fast-api" : null),
        })
        .then(({ error: incError }) => {
          if (incError) {
            logger.error("Failed to increment video usage", {
              route: "gateway/sjinn",
              vmId: vm.id,
              error: String(incError),
            });
          }
        });

      logger.info("Sjinn generation submitted", {
        route: "gateway/sjinn",
        vmId: vm.id,
        api: actualApi,
        requestedApi: api !== actualApi ? api : undefined,
        generationType,
        toolType: body.tool_type || (actualApi !== api ? "veo3-text-to-video-fast-api" : null),
        requestId: sjinnRequestId,
        remaining: limitResult?.remaining ?? "unknown",
      });

      // If we fell back from Agent→Tool, tell the agent which API to poll with
      if (actualApi !== api) {
        sjinnData._corrected_api = actualApi;
      }

      return NextResponse.json(sjinnData);
    }

    // ────────────────────────────────────────────────────────
    // ACTION: query — Poll status of existing generation
    // ────────────────────────────────────────────────────────
    if (action === "query") {
      // Accept ID from either field — agents sometimes mix up api types
      const queryId = body.chat_id || body.task_id;

      let sjinnUrl: string;
      let sjinnBody: Record<string, unknown>;

      if (api === "agent") {
        sjinnUrl = SJINN_AGENT_QUERY_URL;
        sjinnBody = {
          chat_id: queryId,
          ...(body.tool_names && { tool_names: body.tool_names }),
        };
      } else {
        sjinnUrl = SJINN_TOOL_QUERY_URL;
        sjinnBody = {
          task_id: queryId,
        };
      }

      const sjinnRes = await fetch(sjinnUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sjinnApiKey}`,
        },
        body: JSON.stringify(sjinnBody),
      });

      let sjinnData = await sjinnRes.json();

      if (!sjinnRes.ok) {
        logger.error("Sjinn query error", {
          route: "gateway/sjinn",
          vmId: vm.id,
          status: sjinnRes.status,
          response: JSON.stringify(sjinnData).slice(0, 500),
        });
        return NextResponse.json(sjinnData, {
          status: sjinnRes.status >= 400 ? sjinnRes.status : 502,
        });
      }

      // ── Auto-fallback: if "not found", try the other API type ──
      // Agents sometimes create with Tool API but query with Agent API
      // (or vice versa). Sjinn returns HTTP 200 with success:false.
      if (
        queryId &&
        sjinnData.success === false &&
        (sjinnData.errorMsg?.toLowerCase().includes("not found") ||
          !sjinnData.data)
      ) {
        const fallbackApi = api === "agent" ? "tool" : "agent";
        const fallbackUrl =
          fallbackApi === "agent"
            ? SJINN_AGENT_QUERY_URL
            : SJINN_TOOL_QUERY_URL;
        const fallbackBody =
          fallbackApi === "agent"
            ? { chat_id: queryId, ...(body.tool_names && { tool_names: body.tool_names }) }
            : { task_id: queryId };

        const fallbackRes = await fetch(fallbackUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${sjinnApiKey}`,
          },
          body: JSON.stringify(fallbackBody),
        });
        const fallbackData = await fallbackRes.json();

        if (fallbackData.success === true && fallbackData.data) {
          logger.info("Sjinn query auto-corrected API type", {
            route: "gateway/sjinn",
            vmId: vm.id,
            requestedApi: api,
            correctedApi: fallbackApi,
            queryId,
          });
          sjinnData = fallbackData;
        }
      }

      // ── Normalize: ensure data.video_url is always present ──
      // Agent API puts URLs in data.tool_results[].result[]
      // Tool API puts URLs in data.output_urls[] or data.output.video_url
      // We add data.video_url so agents can always use one extraction path.
      if (sjinnData.success && sjinnData.data && sjinnData.data.status === 1) {
        if (!sjinnData.data.video_url) {
          // Agent API format: find composed video or last .mp4 in tool_results
          const toolResults = sjinnData.data.tool_results;
          if (Array.isArray(toolResults) && toolResults.length > 0) {
            const composed = toolResults.find(
              (t: { name: string }) => t.name === "ffmpeg_full_compose"
            );
            const lastVideo = [...toolResults]
              .reverse()
              .find(
                (t: { result: unknown }) =>
                  Array.isArray(t.result) &&
                  t.result.some((r: string) => typeof r === "string" && r.endsWith(".mp4"))
              );
            const source = composed || lastVideo;
            if (source && Array.isArray(source.result)) {
              sjinnData.data.video_url = source.result[0];
            }
          }

          // Tool API format: output.video_url or output_urls[]
          if (!sjinnData.data.video_url && sjinnData.data.output?.video_url) {
            sjinnData.data.video_url = sjinnData.data.output.video_url;
          }
          if (
            !sjinnData.data.video_url &&
            Array.isArray(sjinnData.data.output_urls) &&
            sjinnData.data.output_urls.length > 0
          ) {
            sjinnData.data.video_url =
              sjinnData.data.output_urls.find((u: string) => u.endsWith(".mp4")) ||
              sjinnData.data.output_urls[0];
          }
        }
      }

      return NextResponse.json(sjinnData);
    }

    // --- Unknown action ---
    return NextResponse.json(
      {
        error: "invalid_action",
        message: 'Use ?action=create or ?action=query',
      },
      { status: 400 }
    );
  } catch (err) {
    logger.error("Sjinn proxy error", {
      error: String(err),
      route: "gateway/sjinn",
    });
    return NextResponse.json({ error: "Proxy error" }, { status: 500 });
  }
}
