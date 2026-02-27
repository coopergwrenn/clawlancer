/**
 * acp-api.ts — Pure HTTP client for Virtuals Protocol ACP endpoints.
 *
 * Stateless functions that call ACP APIs directly via fetch.
 * No SSH, no VM knowledge, no CLI dependency.
 */

import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ACP_AUTH_BASE = "https://acpx.virtuals.io";
export const ACP_API_BASE = "https://claw-api.virtuals.io";
export const POLL_INTERVAL_MS = 5_000;
export const DEFAULT_TIMEOUT_MS = 600_000;        // 10 min
export const AUTH_REQUEST_LIFETIME_MS = 1_740_000; // 29 min (refresh before 30-min expiry)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export class AcpApiError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number | null,
    public readonly responseBody: string | null,
  ) {
    super(message);
    this.name = "AcpApiError";
  }
}

export interface AcpAgent {
  id: string;
  name: string;
  apiKey: string;
  walletAddress?: string;
  [key: string]: unknown;
}

export interface AcpAgentProfile {
  id: string;
  name: string;
  walletAddress: string;
  tokenAddress?: string;
  token?: { name: string; symbol: string };
  jobs?: unknown[];
  offeringCount: number;
  [key: string]: unknown;
}

export interface AcpOffering {
  name: string;
  description: string;
  price: number;
  priceV2: { type: string; value: number };
  slaMinutes: number;
  deliverable: string;
  requiredFunds: boolean;
  requirement: {
    type: string;
    properties: Record<string, unknown>;
    required: string[];
  };
}

export interface PollOptions {
  timeoutMs?: number;
  onAuthUrl?: (newUrl: string, newRequestId: string) => void;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function assertOk(
  res: Response,
  context: string,
): Promise<void> {
  if (res.ok) return;
  const body = await res.text().catch(() => "(unreadable)");
  throw new AcpApiError(
    `${context}: HTTP ${res.status}`,
    res.status,
    body,
  );
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Check if an existing ACP API key is valid.
 * Returns `false` on any failure (network, 401, etc.) — it's a check, not an action.
 */
export async function validateAcpApiKey(apiKey: string): Promise<boolean> {
  try {
    const res = await fetch(`${ACP_API_BASE}/acp/me`, {
      headers: { "x-api-key": apiKey },
    });
    logger.info("validateAcpApiKey", { status: res.status, valid: res.ok });
    return res.ok;
  } catch (err) {
    logger.warn("validateAcpApiKey failed", { error: String(err) });
    return false;
  }
}

/**
 * Generate a browser authentication URL for ACP.
 * User opens this URL, authenticates, then we poll for completion.
 */
export async function getAcpAuthUrl(): Promise<{
  authUrl: string;
  requestId: string;
  generatedAt: number;
}> {
  const res = await fetch(`${ACP_AUTH_BASE}/api/auth/lite/auth-url`);
  await assertOk(res, "getAcpAuthUrl");
  const raw = await res.json();
  // API may wrap response in { data: { ... } }
  const data = raw.data ?? raw;
  const authUrl: string = data.authUrl ?? data.url ?? "";
  const requestId: string = data.requestId ?? data.request_id ?? "";
  if (!authUrl || !requestId) {
    throw new AcpApiError(
      `getAcpAuthUrl: missing authUrl/requestId in response: ${JSON.stringify(raw)}`,
      null,
      JSON.stringify(raw),
    );
  }
  logger.info("getAcpAuthUrl", { requestId });
  return { authUrl, requestId, generatedAt: Date.now() };
}

/**
 * Poll until the user completes browser authentication.
 *
 * - Polls every 5s, 10-min overall timeout.
 * - Proactive refresh: if requestId is >29 min old, generates new auth URL.
 * - Reactive refresh: on 410/404 (expired/gone), generates new URL immediately.
 * - Fires `onAuthUrl` callback with new URL so caller can present it to the user.
 */
export async function pollAcpAuthStatus(
  requestId: string,
  opts: PollOptions = {},
): Promise<{ sessionToken: string }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  let currentRequestId = requestId;
  let requestGeneratedAt = Date.now();

  while (Date.now() < deadline) {
    // Proactive refresh: regenerate if approaching 30-min expiry
    if (Date.now() - requestGeneratedAt > AUTH_REQUEST_LIFETIME_MS) {
      logger.info("pollAcpAuthStatus: proactive refresh (approaching expiry)");
      const fresh = await getAcpAuthUrl();
      currentRequestId = fresh.requestId;
      requestGeneratedAt = fresh.generatedAt;
      opts.onAuthUrl?.(fresh.authUrl, fresh.requestId);
    }

    const res = await fetch(
      `${ACP_AUTH_BASE}/api/auth/lite/auth-status?requestId=${encodeURIComponent(currentRequestId)}`,
    );

    // Reactive refresh: expired or gone
    if (res.status === 410 || res.status === 404) {
      logger.warn("pollAcpAuthStatus: request expired/gone, refreshing");
      const fresh = await getAcpAuthUrl();
      currentRequestId = fresh.requestId;
      requestGeneratedAt = fresh.generatedAt;
      opts.onAuthUrl?.(fresh.authUrl, fresh.requestId);
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }

    if (res.ok) {
      const raw = await res.json();
      // API may wrap response in { data: { ... } }
      const data = raw.data ?? raw;
      const token: string | undefined =
        data.sessionToken ?? data.session_token ?? data.token;
      if (token) {
        logger.info("pollAcpAuthStatus: authenticated");
        return { sessionToken: token };
      }
      // Authenticated but no token yet — keep polling
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new AcpApiError(
    `pollAcpAuthStatus: timed out after ${timeoutMs}ms`,
    null,
    null,
  );
}

/**
 * List the user's ACP agents using a session token.
 */
export async function fetchAcpAgents(
  sessionToken: string,
): Promise<AcpAgent[]> {
  const res = await fetch(`${ACP_AUTH_BASE}/api/auth/lite/agents`, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  await assertOk(res, "fetchAcpAgents");
  const raw = await res.json();
  // API may wrap response in { data: { ... } } or { data: [...] }
  const data = raw.data ?? raw;
  const agents: AcpAgent[] = Array.isArray(data) ? data : data.agents ?? [];
  logger.info("fetchAcpAgents", { count: agents.length });
  return agents;
}

/**
 * Create a new ACP agent.
 */
export async function createAcpAgent(
  sessionToken: string,
  name: string,
): Promise<AcpAgent> {
  const res = await fetch(`${ACP_AUTH_BASE}/api/auth/lite/agents`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name }),
  });
  await assertOk(res, "createAcpAgent");
  const raw = await res.json();
  // API may wrap response in { data: { ... } }
  const agent: AcpAgent = raw.data ?? raw;
  logger.info("createAcpAgent", { agentId: agent.id, name: agent.name });
  return agent;
}

/**
 * Register a service offering on ACP.
 *
 * Runtime-validates that `jobFee` is numeric (defense against the known
 * string-vs-number bug where "1.00" was sent instead of 1).
 */
export async function registerAcpOffering(
  apiKey: string,
  offering: AcpOffering,
): Promise<void> {
  if (typeof offering.price !== "number") {
    throw new AcpApiError(
      `registerAcpOffering: price must be a number, got ${typeof offering.price} (${JSON.stringify(offering.price)})`,
      null,
      null,
    );
  }

  const res = await fetch(`${ACP_API_BASE}/acp/job-offerings`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    },
    // API expects body wrapped in { data: { ... } }
    body: JSON.stringify({ data: offering }),
  });
  await assertOk(res, "registerAcpOffering");
  logger.info("registerAcpOffering: registered", { name: offering.name });
}

/**
 * Fetch the full agent profile including offering count.
 */
export async function getAcpAgentProfile(
  apiKey: string,
): Promise<AcpAgentProfile> {
  const res = await fetch(`${ACP_API_BASE}/acp/me`, {
    headers: { "x-api-key": apiKey },
  });
  await assertOk(res, "getAcpAgentProfile");
  const raw = await res.json();
  // API wraps response in { data: { ... } }
  const data = raw.data ?? raw;
  const profile: AcpAgentProfile = {
    ...data,
    offeringCount: Array.isArray(data.jobs) ? data.jobs.length : 0,
  };
  logger.info("getAcpAgentProfile", {
    name: profile.name,
    wallet: profile.walletAddress,
    offerings: profile.offeringCount,
  });
  return profile;
}
