/**
 * Sendblue outbound iMessage client.
 *
 * Owns the lifecycle of a single outbound message: validate input,
 * call Sendblue's `/send-message` endpoint, retry on 5xx with
 * exponential backoff, surface errors via SendblueError so callers
 * can branch on status.
 *
 * Used by:
 *   - app/api/imessage/inbound/route.ts (Welcome 1+2+3 burst)
 *   - lib/m-return-dispatch.ts (the dedicated agent's first message)
 *   - any future re-engagement flow
 *
 * What this library deliberately does NOT do:
 *   - Manage retry across process restarts (no durable queue here;
 *     for webhook contexts the caller's request handler is the
 *     retry boundary; for cron contexts we accept best-effort).
 *   - Format phone numbers from arbitrary input (callers pass
 *     already-E.164 strings; the helpers here validate, they don't
 *     parse).
 *   - Track outbound message handles for delivery confirmation
 *     (Sendblue posts status callbacks to a separate webhook; that's
 *     a different module).
 *
 * Env vars required:
 *   SENDBLUE_API_KEY_ID     — public key id from sendblue.co dashboard
 *   SENDBLUE_API_SECRET_KEY — secret key (rotate via Sendblue dashboard
 *                             and re-set in Vercel using `printf`,
 *                             per CLAUDE.md Rule 6)
 *   SENDBLUE_FROM_PHONE     — our Sendblue line's E.164 phone (required
 *                             in the request body per the real Sendblue
 *                             API; without it, /send-message returns 400)
 *
 * Per CLAUDE.md Rule 49 (partner secrets actively verified): see
 * lib/partner-secrets.ts for the periodic verifier that confirms the
 * Sendblue credentials work end-to-end against /accounts/me.
 */

import { logger } from "@/lib/logger";

// Override at deploy time (e.g., SENDBLUE_API_BASE_URL=https://sandbox.sendblue.co/api)
// so local + preview testing doesn't hit production credentials. Falls back to the
// documented production base.
const SENDBLUE_API_BASE =
  process.env.SENDBLUE_API_BASE_URL || "https://api.sendblue.co/api";

const E164_REGEX = /^\+[1-9]\d{1,14}$/;

// Sendblue's documented max is 18996 chars per message. We cap at 5000
// defensively — anything we send (welcome bursts, M_RETURN, agent
// replies) is well under that. Bumping closer to 18996 doesn't help us
// and increases the blast radius of a runaway prompt that accidentally
// ships its full context as an SMS body.
const MAX_BODY_LENGTH = 5000;

// Default retry policy. 5xx-only. Total wall-clock <= ~1.5s for 2 retries.
const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_BASE_MS = 500;

export interface SendblueSendResponse {
  message_handle?: string;
  status?: string;
  error_code?: string;
  error_message?: string;
  number?: string;
  content?: string;
}

export interface SendblueSendOptions {
  retries?: number;
  backoffBaseMs?: number;
}

export class SendblueError extends Error {
  public readonly status: number;
  public readonly response?: SendblueSendResponse;

  constructor(message: string, status: number, response?: SendblueSendResponse) {
    super(message);
    this.name = "SendblueError";
    this.status = status;
    this.response = response;
  }
}

/**
 * E.164 validation. iMessage requires E.164 format (+1XXXXXXXXXX for US).
 * Sendblue rejects malformed numbers with a 4xx; pre-validating saves a
 * network round-trip and gives callers a cleaner error.
 */
export function isValidE164(phone: string): boolean {
  return typeof phone === "string" && E164_REGEX.test(phone);
}

/**
 * Reads Sendblue credentials from env. Throws if either is missing.
 * Separate function so callers can do lazy validation (e.g., feature
 * flag the iMessage flow off cleanly when credentials aren't set).
 */
export function getSendblueCredentials(): {
  apiKeyId: string;
  apiSecretKey: string;
  fromPhone: string | undefined;
} {
  const apiKeyId = process.env.SENDBLUE_API_KEY_ID;
  const apiSecretKey = process.env.SENDBLUE_API_SECRET_KEY;
  if (!apiKeyId || !apiSecretKey) {
    throw new Error(
      "Sendblue credentials not configured: SENDBLUE_API_KEY_ID and SENDBLUE_API_SECRET_KEY must both be set.",
    );
  }
  return {
    apiKeyId,
    apiSecretKey,
    fromPhone: process.env.SENDBLUE_FROM_PHONE,
  };
}

export function isSendblueConfigured(): boolean {
  return !!(process.env.SENDBLUE_API_KEY_ID && process.env.SENDBLUE_API_SECRET_KEY);
}

/**
 * Send a single iMessage to the given E.164 phone number.
 *
 * Throws SendblueError on 4xx (caller's fault — bad number, content
 * violation, auth) or after exhausting retries on 5xx (Sendblue's
 * fault). 2xx returns the response payload (includes message_handle
 * for status callback correlation).
 */
export async function sendImessage(
  to: string,
  body: string,
  opts: SendblueSendOptions = {},
): Promise<SendblueSendResponse> {
  // Input validation — fail fast, don't waste a round-trip.
  //
  // Privacy note: we deliberately do NOT include the phone value in the
  // error message. If this error propagates to a client (via
  // safeSendImessage → caller's response body), the unvalidated input
  // would leak. Describe by type/length instead.
  if (!isValidE164(to)) {
    const shape =
      typeof to === "string" ? `${to.length}-char string` : typeof to;
    throw new SendblueError(`Invalid E.164 phone number (got ${shape})`, 400);
  }
  if (typeof body !== "string" || body.length === 0) {
    throw new SendblueError("Message body must be a non-empty string", 400);
  }
  if (body.length > MAX_BODY_LENGTH) {
    throw new SendblueError(
      `Message body exceeds ${MAX_BODY_LENGTH} char limit (got ${body.length})`,
      400,
    );
  }

  const { apiKeyId, apiSecretKey, fromPhone } = getSendblueCredentials();
  if (!fromPhone) {
    throw new SendblueError(
      "SENDBLUE_FROM_PHONE env var is required (Sendblue's /send-message endpoint requires from_number in the body)",
      0,
    );
  }
  if (!isValidE164(fromPhone)) {
    throw new SendblueError(
      `SENDBLUE_FROM_PHONE is not a valid E.164 phone (length ${fromPhone.length})`,
      0,
    );
  }
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const backoffBaseMs = opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;

  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff with full jitter: 0 to 2^attempt * base.
      // Prevents thundering-herd on Sendblue's 5xx recovery.
      const jitter = Math.random() * backoffBaseMs * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, jitter));
    }

    let response: Response;
    try {
      response = await fetch(`${SENDBLUE_API_BASE}/send-message`, {
        method: "POST",
        headers: {
          "sb-api-key-id": apiKeyId,
          "sb-api-secret-key": apiSecretKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        // from_number is REQUIRED per Sendblue's API docs. Without it,
        // /send-message returns 400. number = recipient, content = body.
        body: JSON.stringify({
          from_number: fromPhone,
          number: to,
          content: body,
        }),
      });
    } catch (err) {
      // Network error (DNS, connection refused, timeout). Retry.
      lastErr = err;
      if (attempt < retries) continue;
      logger.error("[sendblue] network error after retries", {
        to: to.slice(0, 6) + "***",
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new SendblueError(
        `Sendblue network error after ${retries + 1} attempts: ${err instanceof Error ? err.message : String(err)}`,
        0,
      );
    }

    let data: SendblueSendResponse;
    try {
      data = (await response.json()) as SendblueSendResponse;
    } catch {
      data = {};
    }

    if (response.ok) {
      logger.info("[sendblue] sent", {
        to: to.slice(0, 6) + "***",
        messageHandle: data.message_handle,
        bodyLength: body.length,
        attempt: attempt + 1,
      });
      return data;
    }

    // 4xx — caller's fault. Do NOT retry; surface immediately.
    if (response.status >= 400 && response.status < 500) {
      logger.warn("[sendblue] 4xx — not retrying", {
        to: to.slice(0, 6) + "***",
        status: response.status,
        errorCode: data.error_code,
        errorMessage: data.error_message,
      });
      throw new SendblueError(
        `Sendblue rejected message (${response.status}): ${data.error_message || data.error_code || response.statusText}`,
        response.status,
        data,
      );
    }

    // 5xx — Sendblue's fault. Retry.
    lastErr = new SendblueError(
      `Sendblue 5xx (${response.status}): ${data.error_message || response.statusText}`,
      response.status,
      data,
    );
    if (attempt < retries) {
      logger.warn("[sendblue] 5xx — retrying", {
        to: to.slice(0, 6) + "***",
        status: response.status,
        attempt: attempt + 1,
        retriesLeft: retries - attempt,
      });
      continue;
    }
  }

  // Exhausted retries. lastErr should be a SendblueError from the last
  // 5xx attempt; if not (defensive), wrap it.
  if (lastErr instanceof SendblueError) throw lastErr;
  throw new SendblueError(
    `Sendblue failed after ${retries + 1} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    0,
  );
}

/**
 * Send N messages to the same recipient in sequence, with a delay
 * between each. Used for Welcome 1+2+3 burst — the gap gives the
 * recipient time to read each bubble in order.
 *
 * If any single message throws, the burst stops and the error
 * propagates. The caller should NOT retry the whole burst on partial
 * failure (would re-send earlier messages); instead inspect the
 * returned array length to know how many landed.
 */
export async function sendImessageBurst(
  to: string,
  bodies: string[],
  gapMs: number = 900,
): Promise<SendblueSendResponse[]> {
  const responses: SendblueSendResponse[] = [];
  for (let i = 0; i < bodies.length; i++) {
    if (i > 0 && gapMs > 0) {
      await new Promise((r) => setTimeout(r, gapMs));
    }
    const res = await sendImessage(to, bodies[i]);
    responses.push(res);
  }
  return responses;
}

/**
 * Best-effort send. Catches all errors and returns a result type so
 * the caller can decide whether to surface or log-and-continue. Use
 * this in webhook handlers where you must return 200 to the upstream
 * (Sendblue, Telegram) even if a downstream send failed.
 */
export async function safeSendImessage(
  to: string,
  body: string,
  opts: SendblueSendOptions = {},
): Promise<
  | { ok: true; data: SendblueSendResponse }
  | { ok: false; error: string; status: number }
> {
  try {
    const data = await sendImessage(to, body, opts);
    return { ok: true, data };
  } catch (err) {
    if (err instanceof SendblueError) {
      return { ok: false, error: err.message, status: err.status };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      status: 0,
    };
  }
}

/**
 * Health check: ping Sendblue's `/accounts/me` endpoint to verify the
 * credentials work and the API is reachable. Used by the Rule 49
 * partner-secrets verifier (lib/partner-secrets.ts) and any
 * operational tooling that needs to confirm Sendblue is wired up.
 *
 * Returns a result-typed value so the caller can branch cleanly on
 * specific failure modes (auth vs network vs other).
 */
export async function sendblueAccountInfo(): Promise<
  | { ok: true; from?: string }
  | { ok: false; status: number; error: string }
> {
  if (!isSendblueConfigured()) {
    return { ok: false, status: 0, error: "not_configured" };
  }

  const { apiKeyId, apiSecretKey } = getSendblueCredentials();

  let response: Response;
  try {
    response = await fetch(`${SENDBLUE_API_BASE}/accounts/me`, {
      method: "GET",
      headers: {
        "sb-api-key-id": apiKeyId,
        "sb-api-secret-key": apiSecretKey,
        Accept: "application/json",
      },
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: `network: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: response.status === 401 ? "auth_failed" : `http_${response.status}`,
    };
  }

  // Parse the response best-effort to extract the line's phone number,
  // which we can cross-check against SENDBLUE_FROM_PHONE for drift.
  let from: string | undefined;
  try {
    const data = (await response.json()) as Record<string, unknown>;
    // Sendblue's /accounts/me shape varies by tier; common fields are
    // "number" or "phone_number". Best-effort extraction.
    const candidate =
      (data?.number as string | undefined) ||
      (data?.phone_number as string | undefined);
    if (candidate && typeof candidate === "string") {
      from = candidate;
    }
  } catch {
    // Body parse failed; that's okay — the 2xx is the signal.
  }

  return { ok: true, from };
}
