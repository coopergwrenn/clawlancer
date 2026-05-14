/**
 * EdgeOS API-key management — second half of the per-user mint chain.
 *
 * Use these AFTER obtaining an OAuth2 bearer via lib/edgeos-auth.ts. The
 * bearer is the user's session credential — short-lived in spirit, even
 * if not technically expiring — so the typical flow is:
 *
 *   1. requestOTP(email) → emails the 6-digit code
 *   2. authenticateOTP(email, code) → returns access_token (bearer)
 *   3. createApiKey(bearer, { name, scopes }) → returns eos_live_* (persistent)
 *   4. store the eos_live_* in the user's VM .env as EDGEOS_EVENTS_TOKEN
 *   5. discard the bearer — we never need it again
 *
 * The eos_live_* is the long-lived credential; the bearer is intermediate.
 * Never persist the bearer; only the eos_live_*.
 *
 * Idempotency strategy:
 *   The spec doesn't enforce uniqueness on `name`, so a repeat
 *   createApiKey() with the same name would create a second key. To stay
 *   idempotent on retries, callers should listApiKeys() first and look for
 *   an active (revoked_at == null) key matching the deterministic name
 *   (e.g. "instaclaw-edge-vm-050"). If present, reuse rather than
 *   re-create — though we never have the raw `key` again after creation,
 *   so reuse only works if we ALSO persisted `key` at create time.
 *
 *   The pragmatic v0 pattern:
 *     - createApiKey() with name = "instaclaw-edge-{vmName}"
 *     - on success, write the returned .key to user's .env immediately
 *     - if the write fails, immediately revokeApiKey() to clean up
 *     - on retry: skip if the .env already has a valid-looking eos_live_*
 */

import {
  buildHeaders,
  fetchWithTimeout,
  maskToken,
  type EdgeOSEnv,
} from "./edgeos-auth";

const DEFAULT_API_BASE =
  process.env.EDGEOS_API_BASE || "https://api.dev.edgeos.world";

// ─── types ────────────────────────────────────────────────────────────────

export type ApiKeyScope =
  | "events:read"
  | "events:write"
  | "rsvp:write"
  | "venues:write";

export const ALL_SCOPES: ApiKeyScope[] = [
  "events:read",
  "events:write",
  "rsvp:write",
  "venues:write",
];

/** Default scopes for InstaClaw agents at v0 — read-only for safety, until
 * the agent earns user trust via confirmation-before-write UX. */
export const DEFAULT_SCOPES: ApiKeyScope[] = ["events:read"];

export type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
};

/** Only returned from createApiKey — `.key` is the raw eos_live_*, shown
 * once and not recoverable. */
export type CreatedApiKey = ApiKey & { key: string };

// ─── createApiKey ─────────────────────────────────────────────────────────

export type CreateApiKeyInput = {
  /** 1–100 chars (server-side validated). Use a deterministic name like
   * "instaclaw-edge-{vmName}" so idempotency probes work. */
  name: string;
  /** Defaults to ["events:read"] for v0 safety. */
  scopes?: ApiKeyScope[];
  /** Optional ISO 8601 expiry. v0 omits (keys live until revoked). */
  expiresAt?: string;
};

export type CreateApiKeyFailureStatus =
  | "unauthorized" // 401 — bearer expired or wrong
  | "name_conflict" // 409 or 422-with-"exists"/"duplicate" — key with this name already exists
  | "validation_error" // 422 — bad scopes, bad name, bad expires_at (and NOT a name-conflict)
  | "rate_limited" // 429
  | "network"
  | "unknown";

export type CreateApiKeyResult =
  | { ok: true; apiKey: CreatedApiKey }
  | {
      ok: false;
      status: CreateApiKeyFailureStatus;
      httpStatus?: number;
      raw?: string;
      /**
       * Hint to the caller that retrying with the same input is NOT safe —
       * the request may have reached EdgeOS and a duplicate key could be
       * minted. Set on `network` (in-flight timeout / connection drop).
       * The mintOrReuseApiKey helper in lib/edgeos-mint.ts knows to do
       * a list-after-network-fail probe before retrying.
       */
      retryUnsafe?: boolean;
    };

export async function createApiKey(
  bearer: string,
  input: CreateApiKeyInput,
  env: EdgeOSEnv = {}
): Promise<CreateApiKeyResult> {
  const apiBase = env.apiBase ?? DEFAULT_API_BASE;

  if (!bearer) return { ok: false, status: "unauthorized", raw: "bearer is empty" };
  if (!input.name || input.name.length < 1 || input.name.length > 100) {
    return { ok: false, status: "validation_error", raw: "name must be 1–100 chars" };
  }

  const body: Record<string, unknown> = {
    name: input.name,
    scopes: input.scopes ?? DEFAULT_SCOPES,
  };
  if (input.expiresAt) body.expires_at = input.expiresAt;

  let res: Response;
  try {
    res = await fetchWithTimeout(`${apiBase}/api/v1/api-keys`, {
      method: "POST",
      headers: buildHeaders({
        contentType: "application/json",
        tenantId: env.tenantId,
        bearer,
      }),
      body: JSON.stringify(body),
      timeoutMs: env.timeoutMs,
    });
  } catch (err) {
    // Network failure: the request MAY have reached EdgeOS. Caller MUST
    // probe via listApiKeys before retrying, otherwise a duplicate key
    // could be minted. retryUnsafe=true is the contract.
    return {
      ok: false,
      status: "network",
      raw: err instanceof Error ? err.message : String(err),
      retryUnsafe: true,
    };
  }

  const bodyText = await res.text().catch(() => "");

  if (res.ok) {
    let parsed: Partial<{
      id: string;
      name: string;
      prefix: string;
      scopes: ApiKeyScope[];
      created_at: string;
      expires_at: string | null;
      revoked_at: string | null;
      last_used_at: string | null;
      key: string;
    }> = {};
    try {
      parsed = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      return { ok: false, status: "unknown", httpStatus: res.status, raw: bodyText.slice(0, 500) };
    }
    if (!parsed.id || !parsed.key) {
      return {
        ok: false,
        status: "unknown",
        httpStatus: res.status,
        raw: "response missing id or key — possible spec drift",
      };
    }
    return {
      ok: true,
      apiKey: {
        id: parsed.id,
        name: parsed.name ?? input.name,
        prefix: parsed.prefix ?? "",
        scopes: parsed.scopes ?? (input.scopes ?? DEFAULT_SCOPES),
        createdAt: parsed.created_at ?? new Date().toISOString(),
        expiresAt: parsed.expires_at ?? null,
        revokedAt: parsed.revoked_at ?? null,
        lastUsedAt: parsed.last_used_at ?? null,
        key: parsed.key,
      },
    };
  }

  return categorizeFailure(res.status, bodyText) as CreateApiKeyResult;
}

// ─── listApiKeys ──────────────────────────────────────────────────────────

export type ListApiKeysResult =
  | { ok: true; apiKeys: ApiKey[] }
  | {
      ok: false;
      status: "unauthorized" | "rate_limited" | "network" | "unknown";
      httpStatus?: number;
      raw?: string;
    };

export async function listApiKeys(
  bearer: string,
  env: EdgeOSEnv = {}
): Promise<ListApiKeysResult> {
  const apiBase = env.apiBase ?? DEFAULT_API_BASE;

  if (!bearer) return { ok: false, status: "unauthorized", raw: "bearer is empty" };

  let res: Response;
  try {
    res = await fetchWithTimeout(`${apiBase}/api/v1/api-keys`, {
      method: "GET",
      headers: buildHeaders({ tenantId: env.tenantId, bearer }),
      timeoutMs: env.timeoutMs,
    });
  } catch (err) {
    return {
      ok: false,
      status: "network",
      raw: err instanceof Error ? err.message : String(err),
    };
  }

  const bodyText = await res.text().catch(() => "");

  if (res.ok) {
    try {
      const parsed = bodyText ? JSON.parse(bodyText) : [];
      // Tolerate either a bare array or { results: [...] } shape (the spec
      // didn't fully specify the list response schema). Normalize.
      const rows: Array<Record<string, unknown>> = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { results?: unknown[] }).results)
          ? (parsed as { results: Array<Record<string, unknown>> }).results
          : [];
      return {
        ok: true,
        apiKeys: rows.map((r) => ({
          id: String(r.id ?? ""),
          name: String(r.name ?? ""),
          prefix: String(r.prefix ?? ""),
          scopes: (r.scopes as ApiKeyScope[]) ?? [],
          createdAt: String(r.created_at ?? ""),
          expiresAt: (r.expires_at as string | null) ?? null,
          revokedAt: (r.revoked_at as string | null) ?? null,
          lastUsedAt: (r.last_used_at as string | null) ?? null,
        })),
      };
    } catch {
      return { ok: false, status: "unknown", httpStatus: res.status, raw: bodyText.slice(0, 500) };
    }
  }

  return categorizeFailure(res.status, bodyText) as ListApiKeysResult;
}

// ─── revokeApiKey ─────────────────────────────────────────────────────────

export type RevokeApiKeyResult =
  | { ok: true }
  | {
      ok: false;
      status: "unauthorized" | "not_found" | "rate_limited" | "network" | "unknown";
      httpStatus?: number;
      raw?: string;
    };

export async function revokeApiKey(
  bearer: string,
  keyId: string,
  env: EdgeOSEnv = {}
): Promise<RevokeApiKeyResult> {
  const apiBase = env.apiBase ?? DEFAULT_API_BASE;

  if (!bearer) return { ok: false, status: "unauthorized", raw: "bearer is empty" };
  if (!keyId) return { ok: false, status: "not_found", raw: "keyId is empty" };

  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${apiBase}/api/v1/api-keys/${encodeURIComponent(keyId)}`,
      {
        method: "DELETE",
        headers: buildHeaders({ tenantId: env.tenantId, bearer }),
        timeoutMs: env.timeoutMs,
      }
    );
  } catch (err) {
    return {
      ok: false,
      status: "network",
      raw: err instanceof Error ? err.message : String(err),
    };
  }

  if (res.ok) return { ok: true };

  const bodyText = await res.text().catch(() => "");
  if (res.status === 404) {
    return { ok: false, status: "not_found", httpStatus: 404, raw: bodyText.slice(0, 500) };
  }
  return categorizeFailure(res.status, bodyText) as RevokeApiKeyResult;
}

// ─── helpers ──────────────────────────────────────────────────────────────
// (fetchWithTimeout + buildHeaders imported from edgeos-auth.ts to avoid drift)

/**
 * Substrings that signal "key name already exists" inside an error body.
 * Used defensively in case EdgeOS returns 422 (validation) instead of the
 * canonical 409 (conflict) — we'd rather catch a name-collision and let
 * the caller branch correctly than mis-categorize it as "bad input".
 */
const NAME_CONFLICT_HINTS = ["already exists", "duplicate", "name in use", "unique constraint"];

function categorizeFailure(
  httpStatus: number,
  raw: string
):
  | { ok: false; status: "unauthorized"; httpStatus: number; raw: string }
  | { ok: false; status: "name_conflict"; httpStatus: number; raw: string }
  | { ok: false; status: "validation_error"; httpStatus: number; raw: string }
  | { ok: false; status: "rate_limited"; httpStatus: number; raw: string }
  | { ok: false; status: "not_found"; httpStatus: number; raw: string }
  | { ok: false; status: "unknown"; httpStatus: number; raw: string } {
  const short = raw.slice(0, 500);
  const rawLower = short.toLowerCase();
  const looksLikeNameConflict = NAME_CONFLICT_HINTS.some((h) => rawLower.includes(h));
  if (httpStatus === 401 || httpStatus === 403) {
    return { ok: false, status: "unauthorized", httpStatus, raw: short };
  }
  if (httpStatus === 409) {
    return { ok: false, status: "name_conflict", httpStatus, raw: short };
  }
  if (httpStatus === 422) {
    if (looksLikeNameConflict) {
      // Defensive: EdgeOS uses 422 (Unprocessable Entity) for some constraint
      // violations. If the body talks about uniqueness, surface as the more
      // specific name_conflict so callers can switch correctly.
      return { ok: false, status: "name_conflict", httpStatus, raw: short };
    }
    return { ok: false, status: "validation_error", httpStatus, raw: short };
  }
  if (httpStatus === 429) {
    return { ok: false, status: "rate_limited", httpStatus, raw: short };
  }
  if (httpStatus === 404) {
    return { ok: false, status: "not_found", httpStatus, raw: short };
  }
  return { ok: false, status: "unknown", httpStatus, raw: short };
}

/**
 * Build the deterministic key name we use across InstaClaw. Stable across
 * retries so an idempotency probe (listApiKeys + filter by name) can detect
 * an existing key.
 */
export function deterministicKeyName(vmName: string): string {
  // Max 100 chars; expect vmName like "instaclaw-vm-050" (~16 chars).
  return `instaclaw-edge-${vmName}`.slice(0, 100);
}

// Re-export the token-masker so callers don't have to import from auth lib.
export { maskToken };
