import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { lookupVMByGatewayToken } from "@/lib/gateway-auth";
import { logger } from "@/lib/logger";

const SJINN_AGENT_QUERY_URL = "https://sjinn.ai/api/un-api/query_agent_task_status";
const SJINN_TOOL_QUERY_URL = "https://sjinn.ai/api/un-api/query_tool_task_status";

/**
 * POST /api/gateway/sjinn/refund
 *
 * Refund a failed Sjinn video generation. Verifies the job actually failed
 * before decrementing the daily video count.
 *
 * Body: { request_id: string, api?: "agent" | "tool" }
 */
export async function POST(req: NextRequest) {
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
        { status: 401 },
      );
    }

    const vm = await lookupVMByGatewayToken(
      gatewayToken,
      "id, user_timezone",
    );

    if (!vm) {
      return NextResponse.json(
        { error: "Invalid gateway token" },
        { status: 401 },
      );
    }

    const sjinnApiKey = process.env.SJINN_API_KEY;
    if (!sjinnApiKey) {
      return NextResponse.json(
        { error: "Video generation not configured" },
        { status: 500 },
      );
    }

    const body = await req.json();
    const requestId: string | undefined = body.request_id;
    const api: string = body.api || "agent";

    if (!requestId) {
      return NextResponse.json(
        { error: "request_id is required" },
        { status: 400 },
      );
    }

    // --- Verify the job actually failed by querying Sjinn ---
    const queryUrl =
      api === "agent" ? SJINN_AGENT_QUERY_URL : SJINN_TOOL_QUERY_URL;
    const queryBody =
      api === "agent"
        ? { chat_id: requestId }
        : { task_id: requestId };

    let jobFailed = false;

    try {
      const sjinnRes = await fetch(queryUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sjinnApiKey}`,
        },
        body: JSON.stringify(queryBody),
      });
      const sjinnData = await sjinnRes.json();

      // Sjinn status: 0=processing, 1=completed, 2=failed
      if (sjinnData.data?.status === 2) {
        jobFailed = true;
      }

      // Also check success:false with error messages
      if (sjinnData.success === false) {
        jobFailed = true;
      }

      // If job is still processing or completed, don't refund
      if (!jobFailed) {
        return NextResponse.json(
          {
            error: "refund_denied",
            message:
              sjinnData.data?.status === 1
                ? "This video completed successfully — no refund available."
                : "This video is still processing — wait for it to finish before requesting a refund.",
            sjinn_status: sjinnData.data?.status,
          },
          { status: 400 },
        );
      }
    } catch {
      // If we can't reach Sjinn to verify, also try the other API type
      try {
        const fallbackUrl =
          api === "agent" ? SJINN_TOOL_QUERY_URL : SJINN_AGENT_QUERY_URL;
        const fallbackBody =
          api === "agent"
            ? { task_id: requestId }
            : { chat_id: requestId };

        const fallbackRes = await fetch(fallbackUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${sjinnApiKey}`,
          },
          body: JSON.stringify(fallbackBody),
        });
        const fallbackData = await fallbackRes.json();

        if (fallbackData.data?.status === 2 || fallbackData.success === false) {
          jobFailed = true;
        }
      } catch {
        // Can't verify — deny refund to be safe
      }

      if (!jobFailed) {
        return NextResponse.json(
          {
            error: "verification_failed",
            message:
              "Unable to verify job status with Sjinn. Please try again.",
          },
          { status: 503 },
        );
      }
    }

    // --- Job confirmed failed — issue refund ---
    const supabase = getSupabase();
    const userTz = vm.user_timezone || "America/New_York";

    const { data: refundResult, error: refundError } = await supabase.rpc(
      "instaclaw_refund_video_usage",
      {
        p_vm_id: vm.id,
        p_sjinn_request_id: requestId,
        p_timezone: userTz,
      },
    );

    if (refundError) {
      logger.error("Video refund RPC failed", {
        route: "gateway/sjinn/refund",
        vmId: vm.id,
        requestId,
        error: String(refundError),
      });
      return NextResponse.json(
        { error: "Refund failed — please contact support." },
        { status: 500 },
      );
    }

    if (!refundResult?.refunded) {
      return NextResponse.json({
        refunded: false,
        message:
          "No matching usage record found for today. It may have already been refunded.",
      });
    }

    logger.info("Video usage refunded", {
      route: "gateway/sjinn/refund",
      vmId: vm.id,
      requestId,
      newCount: refundResult.new_count,
    });

    return NextResponse.json({
      refunded: true,
      new_count: refundResult.new_count,
      message: `Refund applied. You now have ${refundResult.new_count} videos used today.`,
    });
  } catch (err) {
    logger.error("Sjinn refund error", {
      error: String(err),
      route: "gateway/sjinn/refund",
    });
    return NextResponse.json({ error: "Refund error" }, { status: 500 });
  }
}
