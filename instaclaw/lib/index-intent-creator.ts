/**
 * createIndexIntent — high-level wrapper for expressing a user's intent
 * to Index Network via MCP.
 *
 * Caller passes:
 *   - userId: OUR user_id (uuid in instaclaw_users.id)
 *   - description: free-text intent ("I'm building a retrieval-augmented
 *     code assistant and want to meet researchers working on dense
 *     embeddings", "I'm looking for cofounders for an agentic browser
 *     startup", etc.)
 *
 * This function:
 *   1. Looks up the user's per-agent Index credentials via
 *      instaclaw_vms.{index_user_id, index_api_key} keyed by assigned_to.
 *   2. Calls the Index `create_intent` MCP tool against
 *      protocol.dev.index.network/mcp (or prod, when we flip) using the
 *      per-user x-api-key.
 *   3. Passes the Edge City network UUID as `networkId` so the intent is
 *      scoped to that index automatically. (Otherwise Index would
 *      auto-assign across all indexes the user belongs to.)
 *   4. Returns a structured result tagged with `recorded`, `skipped`, or
 *      `error`.
 *
 * Idempotency:
 *
 *   Index's create_intent does NOT have a "same description = same row"
 *   contract — sending the same description twice creates two intent
 *   rows. We don't dedup here. Callers that want dedup should call
 *   read_intents first and skip duplicates. For V1 (Edge Esmeralda
 *   onboarding flow), the assumption is users describe their intents once
 *   at signup; we accept the rare duplicate.
 *
 * Use sites:
 *   - /api/edge/express-intent (when we ship the dashboard form input)
 *   - Optionally from an admin tool for ops manual testing
 *   - scripts/_test-intent-creation.ts (smoke test harness)
 *
 * Logging:
 *   logger.info on success with truncated description prefix + intent id.
 *   logger.warn on user_id lookup miss. logger.error on MCP failure.
 *
 * Returns a tagged union — callers pattern-match on .status.
 */
import crypto from "crypto";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

// Edge City network id (Yanek-confirmed). Hard-coded because we have
// exactly one partner network today; if we add more (Eclipse, Devcon, etc)
// this becomes a lookup against the partner record.
const EDGE_CITY_NETWORK_ID = "fee18edc-1e60-4b13-b8c8-20e6f6ed1acb";

export type CreateIndexIntentResult =
  | {
      status: "created";
      intentId: string;
      indexUserId: string;
      description: string;
    }
  | {
      status: "skipped";
      reason: "no_index_credentials" | "user_not_found" | "missing_description";
      detail?: string;
    }
  | {
      status: "error";
      reason: string;
      detail?: string;
    };

export async function createIndexIntent(args: {
  userId: string;
  description: string;
  /**
   * Override the network id. Defaults to Edge City. Pass null to let
   * Index auto-assign across all indexes the user belongs to.
   */
  networkId?: string | null;
}): Promise<CreateIndexIntentResult> {
  const desc = (args.description ?? "").trim();
  if (!desc) {
    return { status: "skipped", reason: "missing_description" };
  }
  if (desc.length > 2000) {
    // Defensive — Index will likely reject anything past their limit; this
    // surface the issue here with a clean reason instead of an opaque MCP
    // error.
    return {
      status: "skipped",
      reason: "missing_description",
      detail: "description exceeds 2000 chars",
    };
  }

  const sb = getSupabase();

  // Look up the user's Index credentials via their assigned VM.
  // We require BOTH index_user_id (for logging / future use) and
  // index_api_key (the actual auth token for the MCP call).
  const { data: vm, error: vmErr } = await sb
    .from("instaclaw_vms")
    .select("id, name, index_user_id, index_api_key, partner")
    .eq("assigned_to", args.userId)
    .eq("partner", "edge_city")
    .not("index_api_key", "is", null)
    .maybeSingle();

  if (vmErr || !vm) {
    logger.warn("[index-intent-creator] user lookup failed", {
      userIdPrefix: args.userId.slice(0, 8),
      error: vmErr?.message,
    });
    return {
      status: "skipped",
      reason: "user_not_found",
      detail: "user not in edge_city cohort or has no Index credentials",
    };
  }

  if (!vm.index_api_key || !vm.index_user_id) {
    return { status: "skipped", reason: "no_index_credentials" };
  }

  // Build args for create_intent. Schema (probed 2026-05-19):
  //   required: ["description"]
  //   optional: networkId (UUID), autoApprove (bool)
  // Default to Edge City network; pass autoApprove=false (the default
  // Index workflow expects).
  const networkId = args.networkId === null ? undefined : (args.networkId ?? EDGE_CITY_NETWORK_ID);
  const toolArgs: Record<string, unknown> = { description: desc };
  if (networkId) toolArgs.networkId = networkId;

  // TODO(P1, 2026-05-19): Inline MCP call — workaround for IndexMcpClient
  // class bug (see lib/index-mcp-client.ts file header for repro).
  // Replace this inline call with IndexMcpClient once the bug is rooted out.
  // Same workaround duplicated in scripts/_test-intent-creation.ts.
  const mcpRes = await inlineMcpToolCall(
    vm.index_api_key as string,
    "create_intent",
    toolArgs,
  );

  if (!mcpRes.ok) {
    logger.error("[index-intent-creator] MCP create_intent failed", {
      vm: vm.name,
      indexUserIdPrefix: (vm.index_user_id as string).slice(0, 8),
      error: mcpRes.error,
      detail: mcpRes.detail?.slice(0, 200),
    });
    return {
      status: "error",
      reason: mcpRes.error,
      detail: mcpRes.detail,
    };
  }

  // Parse the result. MCP tools/call result envelope:
  //   { content: [ { type: "text", text: "<JSON-encoded intent object>" } ], isError: false }
  // The text typically contains JSON describing the created intent.
  const result = mcpRes.result as
    | { content?: Array<{ type?: string; text?: string }> }
    | null;
  const textBlocks =
    result?.content?.filter((c) => c.type === "text").map((c) => c.text ?? "") ?? [];
  const concatenated = textBlocks.join("\n");

  // Extract an intent id from the text content (best-effort — the exact
  // format depends on Yanek's tool implementation). Patterns we try, in
  // order of specificity:
  //   1. JSON object with `id` or `intentId` field
  //   2. UUID anywhere in the text
  let intentId: string | undefined;
  try {
    const parsed = JSON.parse(concatenated);
    intentId =
      (parsed.id as string) ??
      (parsed.intentId as string) ??
      (parsed.intent?.id as string) ??
      (parsed.intent_id as string);
  } catch {
    /* fall through to regex */
  }
  if (!intentId) {
    const uuidMatch = concatenated.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
    intentId = uuidMatch?.[0];
  }

  if (!intentId) {
    // Tool returned 200 but we couldn't extract an intent id. Surface as
    // success because the create likely succeeded — but log a warning so
    // we can update the parser if Yanek's response shape changes.
    logger.warn("[index-intent-creator] could not extract intent id from MCP response", {
      vm: vm.name,
      responsePreview: concatenated.slice(0, 300),
    });
    intentId = "(unknown — response parser miss)";
  }

  logger.info("[index-intent-creator] intent created", {
    vm: vm.name,
    indexUserIdPrefix: (vm.index_user_id as string).slice(0, 8),
    intentId: intentId.slice(0, 16),
    descPrefix: desc.slice(0, 80),
  });

  return {
    status: "created",
    intentId,
    indexUserId: vm.index_user_id as string,
    description: desc,
  };
}

// ── Internal: minimal inline MCP-over-HTTP tool call. ───────────────────
//
// Yanek's Index Network MCP is streamable-http transport. We POST a
// JSON-RPC envelope (initialize, then tools/call) with x-api-key for auth.
// Response is SSE-shaped: lines of `event: ...` then `data: <json>`.
//
// Includes a retry-once-with-delay on the SPECIFIC "Invalid API key"
// tool_call_isError shape. Empirically (2026-05-19 testing), Yanek's MCP
// returns that error transiently when called in burst (>1-2 calls/sec
// across multiple sessions). A 1.5s pause + retry consistently recovers.
// The retry is bounded to ONE attempt so we don't infinite-loop on a
// permanently-bad key. See _test-all-keys-mcp.ts for the empirical basis:
// all 9 keys succeeded with 200ms pauses; burst calls failed.
//
// This bypasses the lib/index-mcp-client.ts client class (which has an
// open bug where its tools/call returns "Invalid API key" despite the
// same inputs working inline). When that's debugged, swap this back.
async function inlineMcpToolCall(
  apiKey: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
  attempt: number = 1,
): Promise<
  | { ok: true; result: unknown }
  | { ok: false; error: string; detail?: string }
> {
  const base = (
    process.env.INDEX_NETWORK_API_URL?.trim() || "https://protocol.index.network"
  ).replace(/\/+$/, "");
  const url = `${base}/mcp`;
  const headers = {
    "x-api-key": apiKey,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };

  // Step 1: initialize (required handshake per MCP spec).
  try {
    const initRes = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          clientInfo: { name: "instaclaw", version: "0.1.0" },
        },
      }),
    });
    if (initRes.status !== 200) {
      const body = await initRes.text().catch(() => "");
      return {
        ok: false,
        error: `init_http_${initRes.status}`,
        detail: body.slice(0, 200),
      };
    }
    // Drain the body — don't need to parse the init result, just confirm
    // it succeeded.
    await initRes.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: "init_transport", detail: msg.slice(0, 200) };
  }

  // Step 2: tools/call.
  let callRes: Response;
  try {
    callRes = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "tools/call",
        params: { name: toolName, arguments: toolArgs },
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: "call_transport", detail: msg.slice(0, 200) };
  }
  const raw = await callRes.text();
  if (callRes.status !== 200) {
    return {
      ok: false,
      error: `call_http_${callRes.status}`,
      detail: raw.slice(0, 200),
    };
  }

  // Parse SSE or JSON response. SSE format:
  //   event: message
  //   data: <json>
  let parsed: unknown;
  if (/^event:|\ndata:\s/m.test(raw)) {
    const matches = Array.from(raw.matchAll(/^data:\s*(.*)$/gm));
    const lastData = matches[matches.length - 1]?.[1] ?? "";
    try {
      parsed = JSON.parse(lastData);
    } catch {
      return {
        ok: false,
        error: "sse_non_json",
        detail: lastData.slice(0, 200),
      };
    }
  } else {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        error: "response_non_json",
        detail: raw.slice(0, 200),
      };
    }
  }

  const data = parsed as { result?: { content?: unknown; isError?: boolean }; error?: { code?: number; message?: string } };
  if (data?.error) {
    return {
      ok: false,
      error: "json_rpc_error",
      detail: `${data.error.code}: ${data.error.message}`.slice(0, 200),
    };
  }
  if (data?.result?.isError === true) {
    const content = data.result.content;
    const contentStr = JSON.stringify(content ?? null);
    // Retry once on the burst-rate-limit signature ("Invalid API key" inside
    // a tool result that the SAME key succeeded with seconds earlier).
    if (
      attempt === 1 &&
      /Invalid API key/.test(contentStr)
    ) {
      logger.warn("[index-intent-creator] burst-rate-limit retry", {
        toolName,
        delayMs: 1500,
      });
      await new Promise((r) => setTimeout(r, 1500));
      return inlineMcpToolCall(apiKey, toolName, toolArgs, attempt + 1);
    }
    return {
      ok: false,
      error: "tool_call_isError",
      detail: contentStr.slice(0, 200),
    };
  }
  return { ok: true, result: data?.result ?? null };
}
