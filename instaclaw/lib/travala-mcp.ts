/**
 * Travala MCP + OAuth client — the backend-only half of the booking bridge.
 *
 * Travala's booking connector is a remote MCP server at
 * `https://travel-mcp.travala.com/mcp` (MCP-over-HTTP, streamable, SSE,
 * stateless; protocol 2025-06-18). Two of its tools matter to us:
 *   - travala_search_hotel / travala_search_package — PUBLIC (scope mcp:read,
 *     no token needed; verified P0b: real Lisbon inventory returned unauth).
 *   - travala_book — OAuth-2.1-GATED (Bearer wall hit BEFORE the x402 402). It
 *     returns the 402 `next_action` that directs payment to a plain-HTTP x402
 *     endpoint (`payment-mcp.travala.com/m2m-payment/book`).
 *
 * THE SECRET BOUNDARY (Cooper's hard rule + the X402_PROXY_SECRET precedent):
 * the OAuth client_secret lives ONLY in Vercel env (TRAVALA_OAUTH_CLIENT_SECRET).
 * It NEVER reaches a VM. The backend mints a short-lived `mcp:book` token via
 * client_credentials, calls travala_book to obtain the 402 `next_action`, and
 * hands the VM only `{baseURL, path, method, body, paymentRequirements}` — never
 * the token, never the secret. The VM signs + pays with its own Bankr wallet.
 *
 * P0 findings encoded here (instaclaw/docs/prd/travala-x402-booking-2026-06-10.md
 * §12): active client `mcpd_8fdb46b578356430a3ad0553`; scopes `mcp:read mcp:book`;
 * `client_secret_basic`; non-expiring secret (→ rotation policy, see §14-E +
 * lib/partner-secrets.ts). The pay leg is `exact`/`eip155:8453`/USDC
 * `0x8335…2913` — maps 1:1 to frontier-spend-core.
 */

export const TRAVALA_MCP_URL =
  process.env.TRAVALA_MCP_URL || "https://travel-mcp.travala.com/mcp";

/** Issuer base for OAuth (Travala is its own auth server). */
const TRAVALA_ISSUER =
  process.env.TRAVALA_OAUTH_ISSUER || "https://travel-mcp.travala.com";

/** RFC 8414 metadata path; falls back to the conventional /oauth/token. */
const TRAVALA_TOKEN_ENDPOINT_FALLBACK = `${TRAVALA_ISSUER}/oauth/token`;

/** Plain-HTTP x402 pay host the booking 402's next_action points at. */
export const TRAVALA_PAYMENT_HOST =
  process.env.TRAVALA_PAYMENT_HOST || "https://payment-mcp.travala.com";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const OAUTH_TIMEOUT_MS = 12_000;
const MCP_TIMEOUT_MS = 30_000;

// ── token-endpoint discovery (cached per process; RFC 8414 with fallback) ──
let _tokenEndpointCache: string | null = null;

export async function getTravalaTokenEndpoint(): Promise<string> {
  if (_tokenEndpointCache) return _tokenEndpointCache;
  try {
    const res = await fetch(
      `${TRAVALA_ISSUER}/.well-known/oauth-authorization-server`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS) },
    );
    if (res.ok) {
      const meta = (await res.json().catch(() => ({}))) as { token_endpoint?: unknown };
      if (typeof meta.token_endpoint === "string" && meta.token_endpoint.startsWith("https://")) {
        _tokenEndpointCache = meta.token_endpoint;
        return _tokenEndpointCache;
      }
    }
  } catch {
    /* discovery is best-effort; fall through to the conventional endpoint */
  }
  _tokenEndpointCache = TRAVALA_TOKEN_ENDPOINT_FALLBACK;
  return _tokenEndpointCache;
}

export interface TravalaTokenResult {
  ok: boolean;
  access_token?: string;
  scope?: string;
  expires_in?: number;
  /** Failure classification, parallel to the partner-secret verifier vocab. */
  status: "ok" | "not_configured" | "auth_failed" | "endpoint_5xx" | "endpoint_other" | "unreachable";
  http_code?: number;
  error?: string;
}

/**
 * Mint a short-lived Travala access token via client_credentials
 * (client_secret_basic). Reads TRAVALA_OAUTH_CLIENT_ID / _SECRET from Vercel env.
 * `scope` defaults to "mcp:read mcp:book" (booking). Never logs the secret.
 *
 * Used by BOTH the backend route (book-quote / book-status) and the Rule 49
 * verifier (lib/partner-secrets.ts) so there is a single mint code path.
 */
export async function mintTravalaToken(
  scope = "mcp:read mcp:book",
  overrideSecret?: string,
): Promise<TravalaTokenResult> {
  const clientId = process.env.TRAVALA_OAUTH_CLIENT_ID;
  const clientSecret = overrideSecret ?? process.env.TRAVALA_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return { ok: false, status: "not_configured" };

  const tokenEndpoint = await getTravalaTokenEndpoint();
  const basic = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
  try {
    const res = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({ grant_type: "client_credentials", scope }).toString(),
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403 || res.status === 400) {
      const body = await res.text().catch(() => "");
      return { ok: false, status: "auth_failed", http_code: res.status, error: body.slice(0, 200) };
    }
    if (res.status >= 500) return { ok: false, status: "endpoint_5xx", http_code: res.status };
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, status: "endpoint_other", http_code: res.status, error: body.slice(0, 200) };
    }
    const j = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      scope?: string;
      expires_in?: number;
    };
    if (!j.access_token) {
      return { ok: false, status: "endpoint_other", http_code: res.status, error: "no access_token in response" };
    }
    return { ok: true, status: "ok", http_code: res.status, access_token: j.access_token, scope: j.scope, expires_in: j.expires_in };
  } catch (e) {
    return { ok: false, status: "unreachable", error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
}

// ── MCP-over-HTTP tools/call (SSE-aware) ──

export interface McpCallResult {
  ok: boolean;
  /** The JSON-RPC `result` object (tool output) when ok. */
  result?: unknown;
  /** JSON-RPC error, or a transport error classification. */
  error?: string;
  http_code?: number;
}

/**
 * Parse a streamable-http MCP response body. The server may answer with either
 * a single JSON object (Content-Type: application/json) or an SSE stream
 * (text/event-stream) whose `data:` lines carry the JSON-RPC frames. We extract
 * the LAST `data:` JSON object that carries a matching `id` result/error.
 */
function parseMcpBody(raw: string, contentType: string): unknown | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (contentType.includes("application/json") || trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* maybe it's actually SSE with a JSON-looking first line; fall through */
    }
  }
  // SSE: collect every `data:` payload, return the last one that parses to an
  // object with a `result` or `error` (the tool-call frame).
  let last: unknown | null = null;
  for (const line of trimmed.split("\n")) {
    const m = line.match(/^data:\s?(.*)$/);
    if (!m) continue;
    const payload = m[1].trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const obj = JSON.parse(payload) as Record<string, unknown>;
      if (obj && (("result" in obj) || ("error" in obj))) last = obj;
    } catch {
      /* skip non-JSON data lines (e.g. keepalive comments) */
    }
  }
  return last;
}

/**
 * Call one MCP tool. `token` is the Bearer for gated tools (travala_book);
 * pass null for public tools (travala_search_*). Stateless server → no
 * initialize handshake needed for tools/call (P0: 2025-06-18, stateless).
 */
export async function mcpToolsCall(
  token: string | null,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(TRAVALA_MCP_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
      signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
  }
  const ct = res.headers.get("content-type") || "";
  const raw = await res.text().catch(() => "");
  if (!res.ok && res.status !== 200) {
    // 401 = the OAuth wall (book without/with-bad token); surface it cleanly.
    return { ok: false, http_code: res.status, error: raw.slice(0, 300) };
  }
  const frame = parseMcpBody(raw, ct) as { result?: unknown; error?: { message?: string } } | null;
  if (!frame) return { ok: false, http_code: res.status, error: "unparseable MCP response" };
  if (frame.error) return { ok: false, http_code: res.status, error: frame.error.message || "mcp tool error" };
  return { ok: true, http_code: res.status, result: frame.result };
}

// ── booking-402 extraction ──

export interface TravalaNextAction {
  baseURL: string;
  path: string;
  method: string;
  body: Record<string, unknown>;
}

export interface TravalaBookQuote {
  ok: boolean;
  next_action?: TravalaNextAction;
  /** The x402 accepts[] array (paymentRequirements). */
  paymentRequirements?: unknown[];
  x402Version?: number;
  /** Raw assembled-resource we will sign against (baseURL+path) — the malformed
   * Travala `resource` field is intentionally ignored (P0 wrinkle i). */
  resource?: string;
  error?: string;
}

/**
 * Pull {next_action, paymentRequirements} out of a travala_book MCP result.
 * The 402 payload may live in `structuredContent` (preferred) or be JSON inside
 * a `content[].text` block — handle both shapes defensively (MCP servers differ).
 * Builds the canonical `resource` from baseURL+path, NOT Travala's malformed
 * "undefined/m2m-payment/book" (P0 wrinkle i).
 */
export function extractBookQuote(mcpResult: unknown): TravalaBookQuote {
  const candidates: unknown[] = [];
  const r = mcpResult as Record<string, unknown> | null;
  if (r && typeof r === "object") {
    if (r.structuredContent) candidates.push(r.structuredContent);
    if (Array.isArray(r.content)) {
      for (const block of r.content as Array<Record<string, unknown>>) {
        if (block?.type === "text" && typeof block.text === "string") {
          try {
            candidates.push(JSON.parse(block.text));
          } catch {
            /* not JSON; ignore */
          }
        }
      }
    }
    // Some servers put next_action directly on the result.
    candidates.push(r);
  }

  for (const c of candidates) {
    const obj = c as Record<string, unknown> | null;
    if (!obj || typeof obj !== "object") continue;
    const na = (obj.next_action ?? obj.nextAction) as Record<string, unknown> | undefined;
    const pr =
      (obj.paymentRequirements as unknown[] | undefined) ??
      (na?.paymentRequirements as unknown[] | undefined) ??
      ((na?.accepts as unknown[] | undefined));
    if (na && typeof na.baseURL === "string" && typeof na.path === "string" && Array.isArray(pr) && pr.length > 0) {
      const baseURL = (na.baseURL as string).replace(/\/$/, "");
      const path = na.path as string;
      const x402Version =
        typeof obj.x402Version === "number"
          ? obj.x402Version
          : typeof (na.x402Version as number) === "number"
            ? (na.x402Version as number)
            : 1;
      return {
        ok: true,
        next_action: {
          baseURL,
          path,
          method: typeof na.method === "string" ? (na.method as string) : "POST",
          body: (na.body as Record<string, unknown>) ?? {},
        },
        paymentRequirements: pr,
        x402Version,
        resource: `${baseURL}${path.startsWith("/") ? "" : "/"}${path}`, // P0 wrinkle i: rebuild, don't trust Travala's value
      };
    }
  }
  return { ok: false, error: "no next_action/paymentRequirements in travala_book result" };
}
