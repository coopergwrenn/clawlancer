/**
 * Index Network signup client.
 *
 * Wraps `POST https://protocol.index.network/api/networks/<NETWORK_ID>/signup`
 * per `indexnetwork/index:docs/guides/edgeclaw-instaclaw-integration.md`.
 *
 * IMPORTANT — idempotency contract (READ before adding callers):
 *
 *   Yanek's guide: "Same email always returns the same user. A FRESH API key
 *   is issued on every call; the previous key for this user+network pair is
 *   REVOKED."
 *
 *   This means the Index API itself has no idempotency layer. Calling signup
 *   twice for the same email INVALIDATES the first call's apiKey. The local
 *   cache (instaclaw_vms.index_user_id + .index_api_key) IS the idempotency
 *   layer — callers MUST short-circuit when those columns are populated.
 *   stepIndexProvision does this. Other callers (admin scripts, rotation
 *   utilities) must do the same explicitly. The only correct reason to call
 *   signup when a key already exists is intentional rotation (e.g., key leak).
 *
 * Error classification:
 *   400/401/403 → IndexSignupError(hard) — never retry; configuration is wrong.
 *   500 + network failures → IndexSignupError(retryable) — caller may retry once.
 *
 * Env contract:
 *   INDEX_NETWORK_ID         — UUID of the Edge City experiment network.
 *   INDEX_NETWORK_MASTER_KEY — Master x-api-key issued at network creation.
 *
 *   Both are read from process.env at module init so the failure mode for a
 *   missing key is a clear startup throw, not a silent 401 on first call.
 */

export interface IndexSignupRequest {
  email: string;
  name?: string;
  bio?: string;
  location?: string;
  socials?: Array<{ label: string; value: string }>;
}

export interface IndexSignupResponse {
  user: {
    id: string;
    email: string;
  };
  apiKey: string; // "ix_..."
  mcpServer: {
    name: string; // "index"
    url: string; // "https://protocol.index.network/mcp"
    headers: { "x-api-key": string };
  };
}

export class IndexSignupError extends Error {
  constructor(
    public readonly status: number,
    public readonly bodyPrefix: string,
    public readonly retryable: boolean,
  ) {
    super(`Index signup failed (status=${status}, retryable=${retryable}): ${bodyPrefix}`);
    this.name = "IndexSignupError";
  }
}

const INDEX_API_BASE = "https://protocol.index.network";
const SIGNUP_TIMEOUT_MS = 15_000;

/**
 * Call POST /api/networks/<NETWORK_ID>/signup.
 *
 * @throws IndexSignupError on any non-2xx response (or transport failure).
 * @returns The parsed response (user + apiKey + mcpServer).
 */
export async function callIndexSignup(
  req: IndexSignupRequest,
  opts: { networkId: string; masterKey: string },
): Promise<IndexSignupResponse> {
  const url = `${INDEX_API_BASE}/api/networks/${opts.networkId}/signup`;

  // AbortController so we don't hang indefinitely on a slow Index instance.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SIGNUP_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": opts.masterKey,
      },
      body: JSON.stringify({
        email: req.email,
        // Spread only defined fields — Yanek's spec rejects oversized fields
        // and the only required field is email. Omit > send-undefined-as-null.
        ...(req.name !== undefined && { name: req.name }),
        ...(req.bio !== undefined && { bio: req.bio }),
        ...(req.location !== undefined && { location: req.location }),
        ...(req.socials !== undefined &&
          req.socials.length > 0 && { socials: req.socials }),
      }),
      signal: ac.signal,
    });
  } catch (err: unknown) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    // Transport-level: DNS, TCP, TLS, abort. Always retryable.
    throw new IndexSignupError(0, msg.slice(0, 300), true);
  } finally {
    clearTimeout(timer);
  }

  const bodyText = await res.text();

  if (!res.ok) {
    // 5xx is retryable; 4xx is a configuration error (bad network id, bad
    // master key, malformed body) and won't get better with retry.
    const retryable = res.status >= 500;
    throw new IndexSignupError(res.status, bodyText.slice(0, 300), retryable);
  }

  // Parse and validate response shape — the contract is load-bearing for
  // stepIndexProvision (DB write + MCP-config write both depend on these
  // fields).
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch (e: unknown) {
    throw new IndexSignupError(
      res.status,
      `non-JSON 2xx response: ${bodyText.slice(0, 200)}`,
      false,
    );
  }

  if (!isValidSignupResponse(parsed)) {
    throw new IndexSignupError(
      res.status,
      `unexpected response shape: ${bodyText.slice(0, 200)}`,
      false,
    );
  }

  return parsed;
}

function isValidSignupResponse(v: unknown): v is IndexSignupResponse {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (!o.user || typeof o.user !== "object") return false;
  const user = o.user as Record<string, unknown>;
  if (typeof user.id !== "string" || typeof user.email !== "string") return false;
  if (typeof o.apiKey !== "string" || !o.apiKey.startsWith("ix_")) return false;
  if (!o.mcpServer || typeof o.mcpServer !== "object") return false;
  const mcp = o.mcpServer as Record<string, unknown>;
  if (typeof mcp.name !== "string" || typeof mcp.url !== "string") return false;
  if (!mcp.headers || typeof mcp.headers !== "object") return false;
  return true;
}

/**
 * Build the MCP server config block that gets written into the agent's
 * `~/.openclaw/openclaw.json` under `mcp.servers.index`.
 *
 * IMPORTANT: OpenClaw's MCP transport for HTTP-style servers is
 * `streamable-http` (same as gbrain v0.35.0.0 — see CLAUDE.md Rule 35). The
 * shape that goes ON DISK is NOT identical to what Index returns. Index
 * returns `{name, url, headers}`; OpenClaw expects `{transport, url, headers,
 * connectionTimeoutMs}`. This helper bridges the two.
 *
 * Hot-reload behavior (Rule 32): `mcp.servers.*` IS in the empirically-
 * verified hot-reloadable set. After `openclaw config set mcp.servers.index
 * '<json>'`, the runtime picks up the new server without a gateway restart.
 * We still verify via journal grep in stepIndexProvision per Rule 32 §3.
 */
export function buildIndexMcpConfig(apiKey: string): {
  transport: "streamable-http";
  url: string;
  headers: { "x-api-key": string };
  connectionTimeoutMs: number;
} {
  return {
    transport: "streamable-http",
    url: `${INDEX_API_BASE}/mcp`,
    headers: { "x-api-key": apiKey },
    connectionTimeoutMs: 5000,
  };
}

/**
 * Resolve env-var pair INDEX_NETWORK_ID + INDEX_NETWORK_MASTER_KEY from
 * process.env. Returns `null` when either is missing — callers should treat
 * a null result as "Index integration not configured on this Vercel
 * environment" and skip cleanly (no error, no warning).
 *
 * Local dev / staging may legitimately have neither set; production has both.
 */
export function getIndexEnv(): { networkId: string; masterKey: string } | null {
  const networkId = process.env.INDEX_NETWORK_ID;
  const masterKey = process.env.INDEX_NETWORK_MASTER_KEY;
  if (!networkId || !masterKey) return null;
  if (!/^[0-9a-f-]{36}$/i.test(networkId)) {
    // Shape check up front — Rule 49's "shape check first" pattern. If the
    // env var was set to a typo or the wrong slot, this fails locally in
    // milliseconds instead of leaking the master key to the partner.
    return null;
  }
  return { networkId, masterKey };
}
