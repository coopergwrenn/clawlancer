/**
 * ToolRouter helper module — PRD §7.1 Task A.
 *
 * Mirrors `lib/index-network-client.ts` for the partner-MCP wiring pattern.
 * The wrapper function `callToolRouter` (with optimistic-concurrency consume
 * semantics per PRD §5.3.5) lands in Task K.4 — not exported from this
 * module at v1. This module ships:
 *
 *   - getToolRouterEnv()           reads TOOLROUTER_API_KEY/URL, null on miss
 *   - buildToolRouterMcpConfig()   disk shape for mcp.servers.toolrouter
 *   - verifyToolRouterApiKey()     Rule 49 verifier (shape + smoke-test)
 *
 * The verifier hits TWO endpoints in sequence (defense in depth):
 *   1. GET /health — Andy-confirmed liveness probe (no auth required).
 *      Returns 200 when the service is up. Lets us distinguish "key bad"
 *      from "service down" in alerts.
 *   2. GET /v1/endpoints — Bearer-authed catalog read. Returns 200 +
 *      JSON {endpoints: [...]} for valid keys, 401/403 for invalid.
 *      Sourced from apps/api/src/routes/status.routes.ts:24.
 * Neither endpoint burns credits.
 *
 * PRD §1.5 catalog classification, §1.6 execution paths, and the §5.3.7
 * endpoint weight table are documented in lib/toolrouter-credits.ts (Task K.2).
 */

import { logger } from "./logger";

const TOOLROUTER_API_BASE_DEFAULT = "https://toolrouter.world";
const VERIFY_TIMEOUT_MS = 10_000;

/**
 * Bearer-token shape: tr_ prefix + 16+ alphanumeric/safe chars. Real keys
 * are random base62-ish; this regex rejects empty values, accidental
 * placeholders containing spaces or special characters, and obvious typos
 * before any network call.
 *
 * Generous enough to accept any value `POST /v1/api-keys` would mint, strict
 * enough to catch the EDGEOS_BEARER_TOKEN-class incident (Rule 49: a hex
 * string copy-pasted into the wrong slot would fail this check).
 */
const TOOLROUTER_API_KEY_SHAPE = /^tr_[A-Za-z0-9_-]{16,}$/;

export type ToolRouterTransport = "stdio" | "streamable-http";

export type ToolRouterPath =
  | "agentkit"
  | "agentkit_to_x402"
  | "x402"
  | "dev_stub"
  | "timeout";

export interface ToolRouterEnv {
  apiKey: string;
  apiUrl: string;
}

export interface ToolRouterMcpConfigStdio {
  // K.4: command can be either "toolrouter" (v1 direct shape, no
  // wrapper) or "node" (wrapper-pointed shape — OpenClaw spawns
  // node <wrapperPath> and the wrapper spawns the toolrouter binary
  // as its child). buildToolRouterMcpConfig picks based on the
  // wrapperConfig argument.
  command: "toolrouter" | "node";
  args: string[];
  // env carries TOOLROUTER_API_KEY + TOOLROUTER_API_URL for both
  // shapes (the wrapper forwards them to the child binary, which
  // reads them from process.env per the binary's startStdioServer
  // signature). The wrapper shape ALSO carries:
  //   - GATEWAY_TOKEN — wrapper authenticates to InstaClaw's
  //     /api/agent/toolrouter/record-usage endpoint
  //   - INSTACLAW_API_URL — where to POST
  //   - TOOLROUTER_WRAPPER_CHILD_CMD — the child binary name
  //     ("toolrouter" by default; overridable for tests)
  env: Record<string, string>;
}

export interface ToolRouterMcpConfigStreamableHttp {
  transport: "streamable-http";
  url: string;
  headers: {
    Authorization: string;
  };
  connectionTimeoutMs: number;
}

export type ToolRouterMcpConfig =
  | ToolRouterMcpConfigStdio
  | ToolRouterMcpConfigStreamableHttp;

export type VerifyToolRouterStatus =
  | "ok"
  | "not_configured"
  | "shape_invalid"
  | "auth_failed"
  | "unreachable"
  | "endpoint_5xx"
  | "endpoint_other";

export interface VerifyToolRouterResult {
  ok: boolean;
  status: VerifyToolRouterStatus;
  http_code?: number;
  error?: string;
  body_prefix?: string;
}

/**
 * Resolve TOOLROUTER_API_KEY + TOOLROUTER_API_URL from process.env. Returns
 * null when EITHER the key is unset/empty OR the key fails the shape check.
 * Trailing-newline corruption (Rule 6) would fail the regex and bounce here.
 *
 * Callers should treat null as "ToolRouter integration not configured for
 * this environment" and skip cleanly with no error. v1 ships with this env
 * unset in production until Cooper completes the self-serve signup at
 * toolrouter.world (see PRD §4.8a "Cooper-side onboarding").
 */
export function getToolRouterEnv(): ToolRouterEnv | null {
  const apiKey = process.env.TOOLROUTER_API_KEY?.trim();
  if (!apiKey) return null;
  if (!TOOLROUTER_API_KEY_SHAPE.test(apiKey)) return null;
  const apiUrl = (process.env.TOOLROUTER_API_URL?.trim() || TOOLROUTER_API_BASE_DEFAULT).replace(/\/+$/, "");
  return { apiKey, apiUrl };
}

/**
 * Build the on-disk shape for `mcp.servers.toolrouter` in
 * ~/.openclaw/openclaw.json. PRD §2.3 documents both transport shapes; v1
 * ships with stdio (Path C) per Cooper's PM directive. streamable-http is
 * the v1.5 ask of Andy (Q2) — when he ships it, we flip TOOLROUTER_TRANSPORT
 * to "streamable-http" via vercel env and the reconciler rewrites
 * mcp.servers.toolrouter on the next tick. No on-VM code changes.
 *
 * Hot-reloadable per Rule 32 (`mcp.servers.*` is in the verified
 * hot-reloadable set — see lib/vm-reconcile.ts:117).
 */
/**
 * K.4 wrapper config — when present, the stdio MCP shape points OpenClaw at
 * our wrapper script (.command="node", .args=[wrapperPath]) instead of the
 * raw `toolrouter` binary. The wrapper observes every MCP tools/call response
 * and POSTs the structuredContent (charged, trace_id, path) to InstaClaw for
 * allocation enforcement. See lib/toolrouter-wrapper-script.ts.
 *
 * - wrapperPath: absolute path on the VM where the wrapper .mjs lives.
 *   Conventionally /home/openclaw/.openclaw/scripts/toolrouter-wrapper.mjs;
 *   deployed via stepFiles from the manifest's files[] entry.
 * - gatewayToken: the per-VM gateway_token (used by the wrapper to authenticate
 *   to /api/agent/toolrouter/record-usage). Sourced from instaclaw_vms.gateway_token.
 * - instaclawApiUrl: base URL for the record-usage POST. Defaults to
 *   https://instaclaw.io when undefined.
 *
 * If wrapperConfig is omitted (or null), buildToolRouterMcpConfig falls back to
 * the v1 direct-toolrouter shape — useful for tests and the v1.5 streamable-http
 * transport (which doesn't spawn a subprocess on the VM at all).
 */
export interface ToolRouterWrapperConfig {
  wrapperPath: string;
  gatewayToken: string;
  instaclawApiUrl?: string;
}

export function buildToolRouterMcpConfig(
  apiKey: string,
  transport: ToolRouterTransport,
  apiUrl: string = TOOLROUTER_API_BASE_DEFAULT,
  wrapperConfig: ToolRouterWrapperConfig | null = null,
): ToolRouterMcpConfig {
  if (!TOOLROUTER_API_KEY_SHAPE.test(apiKey)) {
    throw new Error(`buildToolRouterMcpConfig: apiKey failed shape check (prefix=${apiKey.slice(0, 5)}, len=${apiKey.length})`);
  }
  const normalizedUrl = apiUrl.replace(/\/+$/, "");
  if (transport === "streamable-http") {
    return {
      transport: "streamable-http",
      url: `${normalizedUrl}/mcp`,
      headers: { Authorization: `Bearer ${apiKey}` },
      connectionTimeoutMs: 5000,
    };
  }
  // K.4 wrapper-pointed shape: OpenClaw spawns `node <wrapper.mjs>`, which
  // spawns the real `toolrouter` binary as a child and observes the
  // bidirectional MCP traffic. The wrapper inherits the env we set here:
  //   - TOOLROUTER_API_KEY + TOOLROUTER_API_URL flow through to the child
  //   - GATEWAY_TOKEN + INSTACLAW_API_URL feed the wrapper's record-usage POST
  //   - TOOLROUTER_WRAPPER_CHILD_CMD pins the child binary name
  if (wrapperConfig) {
    const instaclawUrl = (wrapperConfig.instaclawApiUrl ?? "https://instaclaw.io").replace(/\/+$/, "");
    return {
      command: "node",
      args: [wrapperConfig.wrapperPath],
      env: {
        TOOLROUTER_API_KEY: apiKey,
        TOOLROUTER_API_URL: normalizedUrl,
        TOOLROUTER_WRAPPER_CHILD_CMD: "toolrouter",
        GATEWAY_TOKEN: wrapperConfig.gatewayToken,
        INSTACLAW_API_URL: instaclawUrl,
      },
    };
  }
  // Back-compat fallback: direct toolrouter shape, unobserved. Used by tests
  // and by transports where the wrapper makes no sense (streamable-http).
  return {
    command: "toolrouter",
    args: [],
    env: {
      TOOLROUTER_API_KEY: apiKey,
      TOOLROUTER_API_URL: normalizedUrl,
    },
  };
}

/**
 * Rule 49 verifier — exported for lib/partner-secrets.ts to register in
 * SECRET_VERIFIERS (Task D). Two-stage check:
 *
 *   1. Shape check (local, no network): TOOLROUTER_API_KEY_SHAPE regex.
 *   2. Liveness check: GET /health (no auth). 5xx → endpoint_5xx
 *      (service down, key not the problem). Andy-confirmed endpoint.
 *   3. Auth check: GET /v1/endpoints with Bearer auth. 401/403 →
 *      auth_failed (key is wrong). 200 → ok. Distinguishes a bad key
 *      from a bad service — important for Rule 67-style alerting.
 *
 * The shape check alone catches the most common operator-error class
 * (typo, paste into wrong slot, trailing newline from echo per Rule 6).
 * The smoke test catches the rarer "key was valid but got revoked" case.
 */
export async function verifyToolRouterApiKey(value: string): Promise<VerifyToolRouterResult> {
  if (!value) return { ok: false, status: "not_configured" };
  if (!TOOLROUTER_API_KEY_SHAPE.test(value)) {
    return {
      ok: false,
      status: "shape_invalid",
      error: `TOOLROUTER_API_KEY must match /^tr_[A-Za-z0-9_-]{16,}$/. Got prefix=${value.slice(0, 5)} len=${value.length}`,
    };
  }
  const apiBase = (process.env.TOOLROUTER_API_URL?.trim() || TOOLROUTER_API_BASE_DEFAULT).replace(/\/+$/, "");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), VERIFY_TIMEOUT_MS);
  try {
    // Step 2: liveness check (no auth). 5xx means the service is down,
    // which we want to distinguish from "key bad" in observability.
    const healthRes = await fetch(`${apiBase}/health`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (healthRes.status >= 500) {
      return { ok: false, status: "endpoint_5xx", http_code: healthRes.status };
    }
    // 4xx on /health is unusual but treat as "service in weird state."
    if (!healthRes.ok && healthRes.status !== 401 && healthRes.status !== 403) {
      const bodyText = await healthRes.text().catch(() => "");
      return {
        ok: false,
        status: "endpoint_other",
        http_code: healthRes.status,
        body_prefix: bodyText.slice(0, 200),
      };
    }
    // Step 3: auth check (Bearer). 401/403 → key is wrong (or revoked).
    const authRes = await fetch(`${apiBase}/v1/endpoints`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${value}`,
        Accept: "application/json",
      },
      signal: ctrl.signal,
    });
    if (authRes.status === 401 || authRes.status === 403) {
      const bodyText = await authRes.text().catch(() => "");
      return {
        ok: false,
        status: "auth_failed",
        http_code: authRes.status,
        body_prefix: bodyText.slice(0, 200),
      };
    }
    if (authRes.status >= 500) {
      return { ok: false, status: "endpoint_5xx", http_code: authRes.status };
    }
    if (!authRes.ok) {
      const bodyText = await authRes.text().catch(() => "");
      return {
        ok: false,
        status: "endpoint_other",
        http_code: authRes.status,
        body_prefix: bodyText.slice(0, 200),
      };
    }
    return { ok: true, status: "ok", http_code: authRes.status };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn("verifyToolRouterApiKey: network error", { error: msg.slice(0, 200) });
    return { ok: false, status: "unreachable", error: msg.slice(0, 200) };
  } finally {
    clearTimeout(t);
  }
}

// ─── Wrapper (Task K.4) — call-first, decrement-after ────────────────
//
// PRD §5.3.5 + §7.11 Task K.4. Critical: HTTP call FIRST, decrement
// AFTER. Reverse order would lose user allocation on network failures
// (the original Issue 4 data-loss bug from the PRD review).
//
// Three return shapes (binding — every caller must handle all three):
//   { toolrouter_unavailable: true } — HTTP failed; agent silently uses
//                                       free tools, no upsell shown
//   { allowed: true, response, ... } — call succeeded; allocation
//                                       reflected in balance_after
//   {} (never) — the legacy upsell_required shape was REMOVED. Upsell
//                fires from the agent's pre-call TOOLROUTER_BALANCE
//                read, not from this wrapper. Wrapper never blocks at
//                request time.

const WRAPPER_DEFAULT_TIMEOUT_MS = 30_000;
const WRAPPER_BROWSERBASE_TIMEOUT_MS = 60_000;

export interface CallToolRouterParams {
  userId: string;
  vmId?: string | null;
  endpointId: string;
  input: Record<string, unknown>;
  weight: number;
  /**
   * Optional override for timeout. If unset, picks based on endpointId
   * (Browserbase = 60s, others = 30s). Async endpoints (manus/parallel
   * .task) return immediately from _start with a task_id; caller polls.
   */
  timeoutMs?: number;
  /**
   * RPC caller — passes the consume-RPC implementation. Defaults to
   * the canonical Supabase RPC at instaclaw_consume_toolrouter_searches.
   * Tests override this. The shape must match the SQL RPC's return JSON.
   */
  consumeRpc?: ConsumeRpcFn;
  /**
   * Logger — defaults to the canonical instaclaw_toolrouter_call_log
   * insert. Tests override.
   */
  logCall?: LogCallFn;
}

export type ConsumeRpcResult =
  | {
      allowed: true;
      balance_after: number | null;
      topup_after?: number | null;
      allocation_source: "sponsored_agentkit" | "sponsored_paid" | "topup_paid";
      hit_80pct: boolean;
    }
  | { allowed: false; balance_after: number | null; allocation_source: "blocked"; weight_required: number; note?: string };

export type ConsumeRpcFn = (args: {
  user_id: string;
  weight: number;
  endpoint_id: string;
  charged: boolean;
  trace_id: string | null;
}) => Promise<ConsumeRpcResult>;

export type LogCallFn = (entry: {
  user_id: string;
  vm_id?: string | null;
  endpoint_id: string;
  path: ToolRouterPath | "unknown";
  charged: boolean;
  amount_usd: number | null;
  weight: number;
  allocation_source: string;
  http_code: number | null;
  latency_ms: number | null;
  error_class: string | null;
  trace_id: string | null;
}) => Promise<void>;

export interface WrapperResultUnavailable {
  toolrouter_unavailable: true;
  error?: string;
  http_code?: number;
  fallback: "free_tools";
}

export type WrapperAllocationSource =
  | "sponsored_agentkit"
  | "sponsored_paid"
  | "topup_paid"
  | "post_hoc_exceeded";

export interface WrapperResultOk {
  allowed: true;
  response: Record<string, unknown>;
  allocation_source: WrapperAllocationSource;
  balance_after: number | null;
  hit_80pct: boolean;
  warning?: "allocation_overrun_absorbed";
}

export type WrapperResult = WrapperResultUnavailable | WrapperResultOk;

function pickTimeout(endpointId: string): number {
  if (endpointId === "browserbase.session") return WRAPPER_BROWSERBASE_TIMEOUT_MS;
  return WRAPPER_DEFAULT_TIMEOUT_MS;
}

export async function callToolRouter(params: CallToolRouterParams): Promise<WrapperResult> {
  const { userId, vmId, endpointId, input, weight, consumeRpc, logCall } = params;
  const env = getToolRouterEnv();
  if (!env) {
    // Env not set — treat as service-unavailable from the agent's
    // perspective. The reconciler step's gate already silent-skipped at
    // configure time; this branch fires only if a caller invokes the
    // wrapper directly without the env in place.
    if (logCall) {
      await logCall({
        user_id: userId,
        vm_id: vmId ?? null,
        endpoint_id: endpointId,
        path: "unknown",
        charged: false,
        amount_usd: null,
        weight,
        allocation_source: "toolrouter_unavailable",
        http_code: null,
        latency_ms: null,
        error_class: "no_env",
        trace_id: null,
      });
    }
    return { toolrouter_unavailable: true, error: "TOOLROUTER_API_KEY not configured", fallback: "free_tools" };
  }

  const started = Date.now();
  const timeoutMs = params.timeoutMs ?? pickTimeout(endpointId);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${env.apiUrl}/v1/requests`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ endpoint_id: endpointId, input }),
      signal: ctrl.signal,
    });
  } catch (err: unknown) {
    clearTimeout(t);
    const msg = err instanceof Error ? err.message : String(err);
    if (logCall) {
      await logCall({
        user_id: userId,
        vm_id: vmId ?? null,
        endpoint_id: endpointId,
        path: "unknown",
        charged: false,
        amount_usd: null,
        weight,
        allocation_source: "toolrouter_unavailable",
        http_code: null,
        latency_ms: Date.now() - started,
        error_class: "network",
        trace_id: null,
      });
    }
    return { toolrouter_unavailable: true, error: msg.slice(0, 200), fallback: "free_tools" };
  } finally {
    clearTimeout(t);
  }

  if (response.status >= 500) {
    if (logCall) {
      await logCall({
        user_id: userId,
        vm_id: vmId ?? null,
        endpoint_id: endpointId,
        path: "unknown",
        charged: false,
        amount_usd: null,
        weight,
        allocation_source: "toolrouter_unavailable",
        http_code: response.status,
        latency_ms: Date.now() - started,
        error_class: "http_5xx",
        trace_id: null,
      });
    }
    return { toolrouter_unavailable: true, http_code: response.status, fallback: "free_tools" };
  }

  let body: Record<string, unknown>;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch (e: unknown) {
    return { toolrouter_unavailable: true, error: "non-JSON response", fallback: "free_tools" };
  }

  const responsePath = (body.path as ToolRouterPath | undefined) ?? "unknown";
  const responseCharged = body.charged === true;
  const amountUsd =
    typeof body.amount_usd === "number"
      ? body.amount_usd
      : body.amount_usd === undefined || body.amount_usd === null
        ? null
        : Number(body.amount_usd);
  const traceId = (body.trace_id as string | undefined) ?? null;

  // charged=false → sponsored. No allocation decrement. Log + return.
  if (!responseCharged && responsePath === "agentkit") {
    if (logCall) {
      await logCall({
        user_id: userId,
        vm_id: vmId ?? null,
        endpoint_id: endpointId,
        path: responsePath,
        charged: false,
        amount_usd: amountUsd,
        weight,
        allocation_source: "sponsored_agentkit",
        http_code: response.status,
        latency_ms: Date.now() - started,
        error_class: null,
        trace_id: traceId,
      });
    }
    return {
      allowed: true,
      response: body,
      allocation_source: "sponsored_agentkit",
      balance_after: null,
      hit_80pct: false,
    };
  }

  // charged=true → post-hoc consume. Wrapper paid the platform credit balance;
  // now atomically decrement the user's allocation. {allowed: false} = race
  // (allocation hit zero between agent's pre-check and this call). We
  // ALWAYS deliver the result; platform absorbs the cost when this fires.
  if (!consumeRpc) {
    // RPC injection not provided — log as platform-absorbed and return.
    if (logCall) {
      await logCall({
        user_id: userId,
        vm_id: vmId ?? null,
        endpoint_id: endpointId,
        path: responsePath,
        charged: true,
        amount_usd: amountUsd,
        weight,
        allocation_source: "post_hoc_exceeded",
        http_code: response.status,
        latency_ms: Date.now() - started,
        error_class: "no_rpc_injected",
        trace_id: traceId,
      });
    }
    return {
      allowed: true,
      response: body,
      allocation_source: "post_hoc_exceeded",
      balance_after: null,
      hit_80pct: false,
      warning: "allocation_overrun_absorbed",
    };
  }

  const consume = await consumeRpc({
    user_id: userId,
    weight,
    endpoint_id: endpointId,
    charged: true,
    trace_id: traceId,
  });

  if (!consume.allowed) {
    if (logCall) {
      await logCall({
        user_id: userId,
        vm_id: vmId ?? null,
        endpoint_id: endpointId,
        path: responsePath,
        charged: true,
        amount_usd: amountUsd,
        weight,
        allocation_source: "post_hoc_exceeded",
        http_code: response.status,
        latency_ms: Date.now() - started,
        error_class: "allocation_overrun",
        trace_id: traceId,
      });
    }
    return {
      allowed: true,
      response: body,
      allocation_source: "post_hoc_exceeded",
      balance_after: consume.balance_after,
      hit_80pct: false,
      warning: "allocation_overrun_absorbed",
    };
  }

  if (logCall) {
    await logCall({
      user_id: userId,
      vm_id: vmId ?? null,
      endpoint_id: endpointId,
      path: responsePath,
      charged: true,
      amount_usd: amountUsd,
      weight,
      allocation_source: consume.allocation_source,
      http_code: response.status,
      latency_ms: Date.now() - started,
      error_class: null,
      trace_id: traceId,
    });
  }
  return {
    allowed: true,
    response: body,
    allocation_source: consume.allocation_source,
    balance_after: consume.balance_after,
    hit_80pct: consume.hit_80pct,
  };
}

export const _testing = {
  TOOLROUTER_API_KEY_SHAPE,
  TOOLROUTER_API_BASE_DEFAULT,
  VERIFY_TIMEOUT_MS,
};
