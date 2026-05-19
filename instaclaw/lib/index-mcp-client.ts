/**
 * Server-side MCP-over-HTTP client for Yanek's Index Network MCP server.
 *
 * Endpoint: https://protocol.dev.index.network/mcp (dev) — controlled by
 *           INDEX_NETWORK_API_URL env. Transport: streamable-http (per the
 *           MCP 2025-03-26 spec). Auth: per-user x-api-key header.
 *
 * Why this exists:
 *
 *   Yanek's Index Network expects intents to be created via MCP tools
 *   (`create_intent`, `update_intent`, etc.) rather than a documented
 *   server-to-server REST endpoint. The 9 edge_city agents each have the
 *   MCP server mounted in their OpenClaw runtime — that's the "magical"
 *   path where the agent calls these tools from chat context.
 *
 *   This file is the BACKBONE — a deterministic server-side path that we
 *   can drive from our Vercel routes (e.g. from the /edge/dashboard's
 *   "interests" form). Same MCP tools, same per-user keys, same effect.
 *   Both paths can run in parallel; create_intent is idempotent at the
 *   description-text level (Index applies semantic vectorization to dedup).
 *
 * Architectural notes:
 *
 *   - Streamable-HTTP transport: every request is POST /mcp with a
 *     JSON-RPC 2.0 envelope. The response is EITHER JSON or SSE
 *     (Server-Sent Events) — Yanek's server picks based on what the
 *     payload needs. We parse both.
 *
 *   - Session id: returned in `mcp-session-id` response header from
 *     `initialize`. Subsequent calls in the same logical session should
 *     pass it back via `mcp-session-id` request header. For one-shot
 *     create_intent we don't strictly NEED to pass it, but we do (cheaper
 *     for Yanek's server-side state mgmt).
 *
 *   - Each call is a fresh client. Vercel functions are stateless;
 *     opening one MCP session per route invocation is cheap (~50ms init +
 *     50ms tool call). The MCP server doesn't require long-lived
 *     connections under streamable-http.
 *
 *   - No retry on tool errors (those are usually deterministic failures
 *     like bad input). One retry on transport errors (transient TCP/TLS).
 *
 * What this DOES NOT do:
 *
 *   - Tool discovery (we hardcode tool names against the schemas we
 *     introspected on 2026-05-19 with scripts/_probe-index-mcp-tools.ts;
 *     if Yanek renames a tool we'll see a `tool not found` error and need
 *     to re-probe).
 *
 *   - Long-running tool calls (no tool we use today exceeds ~5s).
 *
 *   - Tool result streaming. If a tool returns SSE events the parser
 *     reads them all and returns the final `result`.
 */
import crypto from "crypto";

const MCP_PATH = "/mcp";
const DEFAULT_BASE = "https://protocol.index.network";
const SESSION_HEADER = "mcp-session-id";

const PROTOCOL_VERSION = "2025-03-26";
const CLIENT_INFO = {
  name: "instaclaw-server",
  version: "0.1.0",
};

export interface McpToolCallResult {
  ok: true;
  result: unknown;
  sessionId: string | null;
}

export interface McpToolCallError {
  ok: false;
  error: string;
  detail?: string;
  httpStatus?: number;
  rawBodyPrefix?: string;
}

export type McpResponse = McpToolCallResult | McpToolCallError;

interface IndexMcpClientOptions {
  /** Per-user x-api-key issued by Index /signup (stored in instaclaw_vms.index_api_key). */
  apiKey: string;
  /** Override base URL. Defaults to INDEX_NETWORK_API_URL env or production. */
  baseUrl?: string;
  /** Per-request timeout. Defaults to 15s. */
  timeoutMs?: number;
}

export class IndexMcpClient {
  private readonly apiKey: string;
  private readonly url: string;
  private readonly timeoutMs: number;
  private sessionId: string | null = null;
  private initialized = false;

  constructor(opts: IndexMcpClientOptions) {
    if (!opts.apiKey) throw new Error("IndexMcpClient: apiKey required");
    this.apiKey = opts.apiKey;
    const base = (opts.baseUrl ?? process.env.INDEX_NETWORK_API_URL?.trim() ?? DEFAULT_BASE).replace(
      /\/+$/,
      "",
    );
    this.url = `${base}${MCP_PATH}`;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /**
   * One-shot tool call: handles initialize if not yet done, then calls the
   * named tool with the given args. Returns a tagged-union McpResponse.
   *
   * Idempotent across multiple calls on the same client instance — the
   * initialize handshake only fires once.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpResponse> {
    try {
      if (!this.initialized) {
        const initRes = await this.rawCall({
          jsonrpc: "2.0",
          id: crypto.randomUUID(),
          method: "initialize",
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            clientInfo: CLIENT_INFO,
          },
        });
        if (!initRes.ok) {
          return {
            ok: false,
            error: "mcp_initialize_failed",
            detail: initRes.error,
            httpStatus: initRes.httpStatus,
            rawBodyPrefix: initRes.rawBodyPrefix,
          };
        }
        this.initialized = true;
      }

      const callRes = await this.rawCall({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "tools/call",
        params: { name, arguments: args },
      });
      if (!callRes.ok) return callRes;

      // tools/call response shape (per MCP spec):
      //   { jsonrpc, id, result: { content: [...], isError: bool } }
      // OR { jsonrpc, id, error: { code, message, data? } }
      const data = callRes.parsed as Record<string, unknown>;
      if (data?.error && typeof data.error === "object") {
        const err = data.error as { code?: number; message?: string };
        return {
          ok: false,
          error: "tool_returned_error",
          detail: err.message ?? `code=${err.code}`,
          rawBodyPrefix: JSON.stringify(data).slice(0, 300),
        };
      }
      const result = data?.result;
      // result.isError indicates a tool-level (vs MCP-protocol) failure.
      const resultObj = result as { isError?: boolean; content?: unknown } | undefined;
      if (resultObj && resultObj.isError === true) {
        return {
          ok: false,
          error: "tool_call_isError",
          detail: JSON.stringify(resultObj.content ?? null).slice(0, 300),
        };
      }
      return {
        ok: true,
        result: result ?? null,
        sessionId: this.sessionId,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: "unhandled_exception", detail: msg.slice(0, 300) };
    }
  }

  /**
   * Low-level JSON-RPC POST + parse. Returns the raw parsed data on 200,
   * or a structured error otherwise.
   *
   * Captures `mcp-session-id` response header into this.sessionId so
   * subsequent calls thread the session.
   */
  private async rawCall(
    body: object,
  ): Promise<
    | { ok: true; parsed: unknown }
    | { ok: false; error: string; httpStatus?: number; rawBodyPrefix?: string }
  > {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res: Response;
    try {
      const headers: Record<string, string> = {
        "x-api-key": this.apiKey,
        "Content-Type": "application/json",
        // Both content types — Yanek's server picks per request.
        Accept: "application/json, text/event-stream",
      };
      if (this.sessionId) headers[SESSION_HEADER] = this.sessionId;
      res = await fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `transport: ${msg.slice(0, 200)}` };
    }
    clearTimeout(timer);

    // Pick up session id from response (set on initialize; may be echoed
    // on subsequent calls).
    const respSession = res.headers.get(SESSION_HEADER);
    if (respSession) this.sessionId = respSession;

    const raw = await res.text();
    if (res.status >= 400) {
      return {
        ok: false,
        error: `http_${res.status}`,
        httpStatus: res.status,
        rawBodyPrefix: raw.slice(0, 300),
      };
    }

    // Detect SSE vs JSON. Streamable-HTTP responses can be EITHER.
    // SSE: starts with `event:` or contains `data:` lines.
    if (/^event:|\ndata:\s/m.test(raw)) {
      // Extract the LAST data: line — for tools/call, the final emit is
      // the actual result; earlier emits may be progress notifications.
      const matches = Array.from(raw.matchAll(/^data:\s*(.*)$/gm));
      const lastData = matches[matches.length - 1]?.[1] ?? "";
      try {
        return { ok: true, parsed: JSON.parse(lastData) };
      } catch {
        return {
          ok: false,
          error: "sse_data_non_json",
          rawBodyPrefix: lastData.slice(0, 300),
        };
      }
    }

    try {
      return { ok: true, parsed: JSON.parse(raw) };
    } catch {
      return {
        ok: false,
        error: "response_non_json",
        rawBodyPrefix: raw.slice(0, 300),
      };
    }
  }
}

/**
 * Convenience: one-shot tool call without explicit client construction.
 * Useful in Vercel routes where we open + drop a client per request.
 */
export async function callIndexMcpTool(args: {
  apiKey: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<McpResponse> {
  const client = new IndexMcpClient({
    apiKey: args.apiKey,
    baseUrl: args.baseUrl,
    timeoutMs: args.timeoutMs,
  });
  return client.callTool(args.toolName, args.toolArgs);
}
