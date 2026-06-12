/**
 * Partner-secret verifier framework — P1-9.
 *
 * Problem this solves: the 2026-05-14 EDGEOS_BEARER_TOKEN incident. A wrong
 * partner secret in Vercel env (a 64-char hex copy-pasted from EDGEOS_API_KEY
 * into the BEARER_TOKEN slot) silently 401'd every authenticated EdgeOS call
 * from every edge_city VM for 34 days. The Stripe-style "the call succeeded
 * because no error fired" mental model produced zero alert signals; nobody
 * noticed until Cooper independently tested attendee-directory queries and
 * realized they were empty.
 *
 * Framework shape:
 *   - One verifier per partner secret, registered in SECRET_VERIFIERS below.
 *   - Each verifier issues a SMOKE-TEST call to the partner API (GET-style,
 *     idempotent, smallest meaningful response). No writes.
 *   - Common return shape so a caller can iterate uniformly:
 *       { ok, status, http_code?, error? }
 *     where `status` is one of:
 *       "ok"             — verified, partner API responded successfully
 *       "not_configured" — env var is empty/missing (not an error — keys
 *                          gated to a partner that we don't have yet)
 *       "shape_invalid"  — value present but obviously wrong format
 *                          (e.g. EDGEOS_BEARER_TOKEN doesn't start with "eyJ"
 *                          — that's a JWT prefix check that catches the
 *                          hex-string-in-JWT-slot bug from day one)
 *       "auth_failed"    — partner API returned 401/403 (key is WRONG)
 *       "unreachable"    — network error / timeout (no signal on key validity)
 *       "endpoint_5xx"   — partner-side outage (no signal on key validity)
 *       "endpoint_other" — unexpected status code
 *
 * Usage:
 *   - `scripts/_verify-partner-secrets.ts` — operator runs after rotating
 *     a value in Vercel env. Iterates ALL verifiers and reports pass/fail.
 *     This is the load-bearing piece: per CLAUDE.md operations checklist,
 *     adding a new partner secret to Vercel MUST be paired with a verifier
 *     entry here + running this script BEFORE marking the secret deployed.
 *
 *   - `cron/probe-partner-secrets` (sibling to probe-edge-calendar) —
 *     hourly cron that runs all verifiers, alerts on failures (deduped 6h
 *     via instaclaw_admin_alert_log).
 *
 *   - Programmatic use in the reconciler is OPTIONAL and intentionally not
 *     wired up by default — the per-tick cost (4+ external API calls per
 *     VM per reconcile) would be wasteful. The cron handles the global
 *     "is everything still valid" sweep without per-VM duplication.
 */

import { logger } from "./logger";
import { verifyToolRouterApiKey } from "./toolrouter-client";
import { mintTravalaToken } from "./travala-mcp";

const PROBE_TIMEOUT_MS = 10_000;

export type VerifierStatus =
  | "ok"
  | "not_configured"
  | "shape_invalid"
  | "auth_failed"
  | "unreachable"
  | "endpoint_5xx"
  | "endpoint_other";

export interface VerifierResult {
  ok: boolean;
  status: VerifierStatus;
  http_code?: number;
  error?: string;
  /** Optional body excerpt for diagnostics (first ~200 chars). */
  body_prefix?: string;
}

interface SecretVerifier {
  /** Env var name as it appears in Vercel + ~/.openclaw/.env. */
  envKey: string;
  /** Human-readable description for log/alert text. */
  label: string;
  /** Optional gating: only verify when partner-gated and we actually use it. */
  partnerGate?: string;
  /** The verifier function. Receives the env var's current value. */
  verify: (value: string) => Promise<VerifierResult>;
}

// ────────────────────────────────────────────────────────────────────────────
// Per-secret verifier implementations
// ────────────────────────────────────────────────────────────────────────────

/**
 * GBRAIN_ANTHROPIC_API_KEY — Anthropic project key for the gbrain agent.
 * Verify by hitting `/v1/models` with the key. That endpoint is the cheapest
 * authenticated GET in the Anthropic API; success means the key is live and
 * the project is in good standing.
 */
async function verifyAnthropicApiKey(value: string): Promise<VerifierResult> {
  if (!value) return { ok: false, status: "not_configured" };
  // Anthropic keys start with "sk-ant-" — quick shape check before network.
  if (!value.startsWith("sk-ant-")) {
    return { ok: false, status: "shape_invalid", error: "Anthropic keys start with sk-ant-" };
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": value,
        // 2023-06-01 is Anthropic's long-stable API version (per
        // docs.anthropic.com); won't change without warning.
        "anthropic-version": "2023-06-01",
      },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: "auth_failed", http_code: res.status };
    }
    if (res.status >= 500) {
      return { ok: false, status: "endpoint_5xx", http_code: res.status };
    }
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      return {
        ok: false,
        status: "endpoint_other",
        http_code: res.status,
        body_prefix: bodyText.slice(0, 200),
      };
    }
    return { ok: true, status: "ok", http_code: res.status };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: "unreachable", error: msg.slice(0, 200) };
  }
}

/**
 * EDGEOS_BEARER_TOKEN — JWT for the EdgeOS citizen-portal attendee directory.
 *
 * Endpoint: `https://api-citizen-portal.simplefi.tech/applications/attendees_directory/8`
 * (`8` is the Edge Esmeralda 2026 application ID — verified by cloning
 * aromeoes/edge-agent-skill 2026-05-14 and reading SKILL.md).
 *
 * Shape check ALSO catches the original incident's failure mode: the hex-
 * string-from-API_KEY was 64 chars; a real JWT starts with "eyJ" (base64-
 * encoded `{"`). One static check would have caught the 34-day silent fail.
 */
async function verifyEdgeosBearer(value: string): Promise<VerifierResult> {
  if (!value) return { ok: false, status: "not_configured" };
  if (!value.startsWith("eyJ")) {
    return {
      ok: false,
      status: "shape_invalid",
      error: "EdgeOS bearer must be a JWT (starts with eyJ). Got " + value.slice(0, 8) + "…",
    };
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch(
      "https://api-citizen-portal.simplefi.tech/applications/attendees_directory/8?skip=0&limit=1",
      {
        headers: {
          Authorization: `Bearer ${value}`,
          Accept: "application/json",
        },
        signal: ctrl.signal,
      },
    );
    clearTimeout(t);
    if (res.status === 401 || res.status === 403) {
      const bodyText = await res.text().catch(() => "");
      return {
        ok: false,
        status: "auth_failed",
        http_code: res.status,
        body_prefix: bodyText.slice(0, 200),
      };
    }
    if (res.status >= 500) {
      return { ok: false, status: "endpoint_5xx", http_code: res.status };
    }
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      return {
        ok: false,
        status: "endpoint_other",
        http_code: res.status,
        body_prefix: bodyText.slice(0, 200),
      };
    }
    return { ok: true, status: "ok", http_code: res.status };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: "unreachable", error: msg.slice(0, 200) };
  }
}

/**
 * EDGEOS_EVENTS_BEARER_TOKEN — JWT for the EdgeOS world events/calendar API.
 *
 * Endpoint: `https://api.edgeos.world/api/v1/api-keys`
 * Tenant header: X-Tenant-Id: 6018917b-3bce-4333-9870-c29aae915038 (Edge City prod).
 *
 * CRITICAL distinction from EDGEOS_BEARER_TOKEN (verifyEdgeosBearer above):
 *
 *   EDGEOS_BEARER_TOKEN          EDGEOS_EVENTS_BEARER_TOKEN
 *   ─────────────────────        ───────────────────────────
 *   citizen-portal JWT           EdgeOS world JWT
 *   api-citizen-portal.simplefi  api.edgeos.world
 *   Attendees directory only     Events + calendar + api-keys
 *   citizen_id-scoped payload    EdgeOS-user-scoped payload
 *
 * They are two different services that share the "EdgeOS" brand. Each
 * has its own auth namespace. The 2026-05-20 D3 incident confirmed
 * empirically: the citizen-portal JWT returns 401 against
 * api.edgeos.world. They are NOT interchangeable.
 *
 * This bearer is obtained by running:
 *   npx tsx scripts/_test-edgeos-auth-chain.ts --prod --email <edgeos-account-email>
 * and capturing the JWT from the OTP exchange.
 *
 * `mintOrReuseApiKey` in lib/vm-reconcile.ts:stepEdgeOSApiKey + the same
 * call in lib/ssh.ts:configureOpenClaw read this env var to mint per-VM
 * `eos_live_*` keys for the Edge Esmeralda 2026 calendar.
 *
 * The list-api-keys probe is idempotent + tests the exact auth path
 * stepEdgeOSApiKey uses (POST /api/v1/api-keys with the same bearer +
 * tenant header). If list returns 200 with a JSON array, mint will too.
 */
async function verifyEdgeosEventsBearer(value: string): Promise<VerifierResult> {
  if (!value) return { ok: false, status: "not_configured" };
  if (!value.startsWith("eyJ")) {
    return {
      ok: false,
      status: "shape_invalid",
      error:
        "EDGEOS_EVENTS_BEARER_TOKEN must be a JWT (starts with eyJ). Got " +
        value.slice(0, 8) +
        "…",
    };
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch("https://api.edgeos.world/api/v1/api-keys", {
      headers: {
        Authorization: `Bearer ${value}`,
        "X-Tenant-Id": "6018917b-3bce-4333-9870-c29aae915038",
        Accept: "application/json",
      },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (res.status === 401 || res.status === 403) {
      const bodyText = await res.text().catch(() => "");
      return {
        ok: false,
        status: "auth_failed",
        http_code: res.status,
        body_prefix: bodyText.slice(0, 200),
      };
    }
    if (res.status >= 500) {
      return { ok: false, status: "endpoint_5xx", http_code: res.status };
    }
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      return {
        ok: false,
        status: "endpoint_other",
        http_code: res.status,
        body_prefix: bodyText.slice(0, 200),
      };
    }
    return { ok: true, status: "ok", http_code: res.status };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: "unreachable", error: msg.slice(0, 200) };
  }
}

/**
 * INDEX_NETWORK_ID — UUID of the Edge City experiment network.
 *
 * No network call — this is a static value defined when the network was
 * created in the Index dashboard. Shape check (36-char UUID v4 format with
 * hyphens) is the only validation that makes sense locally; if the UUID is
 * shape-valid but points at a non-existent network, the
 * INDEX_NETWORK_MASTER_KEY verifier will catch that via 403 on signup.
 *
 * Empirical: the Edge City network ID is fee18edc-1e60-4b13-b8c8-20e6f6ed1acb
 * (verified in PRD §6 and the partner-handoff doc 2026-05-18). Shape check
 * accepts ANY valid UUID — we don't pin the exact value here to keep this
 * file partner-agnostic for the future Eclipse / Devcon / etc. expansions.
 */
async function verifyIndexNetworkId(value: string): Promise<VerifierResult> {
  if (!value) return { ok: false, status: "not_configured" };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return {
      ok: false,
      status: "shape_invalid",
      error: "INDEX_NETWORK_ID must be a UUID. Got " + value.slice(0, 12) + "…",
    };
  }
  return { ok: true, status: "ok" };
}

/**
 * INDEX_NETWORK_MASTER_KEY — master x-api-key for /api/networks/:id/signup.
 *
 * Verify by hitting `/api/networks/<id>/signup` with a deliberately invalid
 * email (no `@`). That triggers Index's 400 "invalid email" path BEFORE the
 * auth check on a valid request — but the auth check fires FIRST in Index's
 * stack, so a wrong master key returns 401/403 immediately and a right
 * master key returns 400 (invalid body). We treat 400 as auth-pass.
 *
 * Why we don't just use a real email: signup with a real email rotates the
 * apiKey for that user, per Yanek's idempotency contract. We'd burn the
 * agent's working key on every verifier run. Sending a deliberately bad
 * email avoids that side effect while still exercising the auth layer.
 *
 * Master keys don't have a canonical prefix per Yanek's guide — they're
 * issued at network-creation time and stored once. The shape check is just
 * "non-empty + non-whitespace".
 */
async function verifyIndexMasterKey(value: string): Promise<VerifierResult> {
  if (!value || value.trim().length < 16) {
    return value
      ? { ok: false, status: "shape_invalid", error: "INDEX master key suspiciously short" }
      : { ok: false, status: "not_configured" };
  }
  const networkId = process.env.INDEX_NETWORK_ID;
  if (!networkId) {
    // Can't run the auth probe without the network ID. Shape-only pass is
    // the best we can do; verifyIndexNetworkId reports the missing pair.
    return { ok: true, status: "ok" };
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    // Mirror the runtime base-URL resolution from lib/index-network-client.ts
    // so dev-env credentials probe against the dev host rather than prod.
    const apiBase = (process.env.INDEX_NETWORK_API_URL?.trim() || "https://protocol.index.network").replace(/\/+$/, "");
    const res = await fetch(
      `${apiBase}/api/networks/${networkId}/signup`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": value,
        },
        // Deliberately invalid: no `@`. Triggers 400 on a valid master key,
        // 401/403 on an invalid one (auth checked before body validation).
        body: JSON.stringify({ email: "verify-probe-not-real" }),
        signal: ctrl.signal,
      },
    );
    clearTimeout(t);
    if (res.status === 401 || res.status === 403) {
      const bodyText = await res.text().catch(() => "");
      return {
        ok: false,
        status: "auth_failed",
        http_code: res.status,
        body_prefix: bodyText.slice(0, 200),
      };
    }
    if (res.status === 400) {
      // Auth passed, body rejected (as designed). Master key is valid.
      return { ok: true, status: "ok", http_code: res.status };
    }
    if (res.status >= 500) {
      return { ok: false, status: "endpoint_5xx", http_code: res.status };
    }
    if (res.status === 200 || res.status === 201) {
      // Unexpected success on a deliberately invalid email — Index may have
      // changed their validation order. Not a hard failure (auth obviously
      // worked) but worth surfacing so we know to update the probe.
      return {
        ok: true,
        status: "ok",
        http_code: res.status,
        body_prefix: "(unexpected 2xx on probe — check Index API changelog)",
      };
    }
    const bodyText = await res.text().catch(() => "");
    return {
      ok: false,
      status: "endpoint_other",
      http_code: res.status,
      body_prefix: bodyText.slice(0, 200),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: "unreachable", error: msg.slice(0, 200) };
  }
}

/**
 * BANKR_PARTNER_KEY — Bankr's partner-API key for wallet provisioning.
 *
 * Placeholder: when Igor (Bankr) delivers the real partner key, replace
 * the smoke-test below with a call to Bankr's actual auth-check endpoint.
 * For now: shape check only (Bankr keys start with `bk_ptr_` per
 * existing convention in lib/bankr-provision.ts).
 */
/**
 * INDEX_WEBHOOK_SECRET — shared secret for HMAC-SHA256 verification of
 * inbound Index Network `opportunity.accepted` webhooks at
 * `/api/webhook/index-encounter`.
 *
 * Shape-only check: there's no live endpoint to probe — we OWN the
 * receiver. Defense limited to:
 *   - non-empty
 *   - ≥32 chars (so a typo or accidental partial paste fails fast)
 *   - alphanumeric / base64 / hex chars only (catches trailing-newline
 *     Rule-6-style corruption since `\n` would fail the regex)
 *
 * Real verification = the test harness at scripts/_test-index-webhook.ts
 * which signs a synthetic payload with this secret and POSTs to the
 * deployed route. If the route returns 200, the secret is live and the
 * receiver code is wired.
 */
async function verifyIndexWebhookSecret(value: string): Promise<VerifierResult> {
  if (!value) return { ok: false, status: "not_configured" };
  if (value.length < 32) {
    return {
      ok: false,
      status: "shape_invalid",
      error: "INDEX_WEBHOOK_SECRET suspiciously short (< 32 chars)",
    };
  }
  if (!/^[A-Za-z0-9_\-=+/.]+$/.test(value)) {
    return {
      ok: false,
      status: "shape_invalid",
      error: "INDEX_WEBHOOK_SECRET contains unexpected characters — Rule 6 trailing-newline corruption?",
    };
  }
  return { ok: true, status: "ok" };
}

async function verifyBankrPartnerKey(value: string): Promise<VerifierResult> {
  if (!value) return { ok: false, status: "not_configured" };
  if (!value.startsWith("bk_ptr_")) {
    return {
      ok: false,
      status: "shape_invalid",
      error: "Bankr partner keys start with bk_ptr_. Got " + value.slice(0, 8) + "…",
    };
  }
  // TODO when Bankr ships their partner key: replace this with a real
  // smoke-test call (e.g. GET /partner/me or similar). Until then, the
  // shape check is the only validation we can do.
  return { ok: true, status: "ok" };
}

/**
 * TRAVALA_OAUTH_CLIENT_SECRET — the confidential OAuth client secret for the
 * Travala booking MCP (client_credentials grant). Pairs with
 * TRAVALA_OAUTH_CLIENT_ID. The secret is NON-EXPIRING (Travala issues
 * `client_secret_expires_at:0`), so rotation is a deliberate operator action —
 * see the rotation runbook below.
 *
 * Verify = shape check (opaque, non-empty, no whitespace — Rule 6 trailing-\n
 * corruption is the classic failure) + a LIVE client_credentials mint smoke
 * test (expect a 200 Bearer scoped mcp:book). The mint reads the client_id from
 * env and the secret under test as the override, so this proves the
 * (client_id, secret) pair actually works against Travala right now.
 *
 * ROTATION (the secret can't be deleted — Travala issued no RFC 7592 mgmt
 * token; the procedure executed 2026-06-10 is the reference):
 *   1. Register a fresh DCR client at https://travel-mcp.travala.com/oauth/register
 *      (scopes mcp:read mcp:book, contacts help@instaclaw.io).
 *   2. printf '<new_secret>' | npx vercel env add TRAVALA_OAUTH_CLIENT_SECRET production
 *      printf '<new_client_id>' | npx vercel env add TRAVALA_OAUTH_CLIENT_ID production
 *      (Rule 6 — printf, never echo/<<<, both append a corrupting newline.)
 *   3. Re-add the PREVIEW env vars too (the P0 CLI add didn't take for preview).
 *   4. npx tsx scripts/_verify-partner-secrets.ts → confirm TRAVALA_* reports ok.
 *   5. Redeploy so the new value reaches prod. The old client is orphaned-inert.
 */
async function verifyTravalaOAuthClientSecret(value: string): Promise<VerifierResult> {
  if (!value) return { ok: false, status: "not_configured" };
  if (/\s/.test(value) || value.length < 16) {
    return {
      ok: false,
      status: "shape_invalid",
      error:
        "TRAVALA_OAUTH_CLIENT_SECRET must be an opaque ≥16-char string with no " +
        "whitespace (a trailing newline from echo/<<< is the usual culprit — Rule 6).",
    };
  }
  if (!process.env.TRAVALA_OAUTH_CLIENT_ID) {
    return {
      ok: false,
      status: "shape_invalid",
      error: "TRAVALA_OAUTH_CLIENT_ID is not set — the secret can't be verified without its client_id pair.",
    };
  }
  // Live smoke test: mint a token with this exact secret. mintTravalaToken maps
  // transport/auth failures to a parallel vocabulary; translate to VerifierStatus.
  const r = await mintTravalaToken("mcp:read mcp:book", value);
  if (r.ok && r.access_token) {
    return { ok: true, status: "ok", http_code: r.http_code };
  }
  switch (r.status) {
    case "auth_failed":
      return { ok: false, status: "auth_failed", http_code: r.http_code, body_prefix: r.error };
    case "endpoint_5xx":
      return { ok: false, status: "endpoint_5xx", http_code: r.http_code };
    case "not_configured":
      return { ok: false, status: "not_configured" };
    case "unreachable":
      return { ok: false, status: "unreachable", error: r.error };
    default:
      return { ok: false, status: "endpoint_other", http_code: r.http_code, body_prefix: r.error };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Registry
// ────────────────────────────────────────────────────────────────────────────

/**
 * The single source of truth for which secrets to verify. Adding a new
 * partner secret to `SECRET_ENV_VAR_SOURCES` in `lib/vm-reconcile.ts`?
 * Add a matching entry here AND run `scripts/_verify-partner-secrets.ts`
 * to confirm the value is live.
 */
export const SECRET_VERIFIERS: SecretVerifier[] = [
  {
    envKey: "GBRAIN_ANTHROPIC_API_KEY",
    label: "gbrain Anthropic project key",
    verify: verifyAnthropicApiKey,
  },
  {
    envKey: "EDGEOS_BEARER_TOKEN",
    label: "EdgeOS attendee directory JWT (citizen-portal)",
    partnerGate: "edge_city",
    verify: verifyEdgeosBearer,
  },
  {
    envKey: "EDGEOS_EVENTS_BEARER_TOKEN",
    label: "EdgeOS world events/api-keys JWT (api.edgeos.world)",
    partnerGate: "edge_city",
    verify: verifyEdgeosEventsBearer,
  },
  {
    envKey: "BANKR_PARTNER_KEY",
    label: "Bankr partner-API key (shape only — endpoint TBD)",
    verify: verifyBankrPartnerKey,
  },
  {
    envKey: "INDEX_NETWORK_ID",
    label: "Index Network — Edge City experiment network UUID",
    partnerGate: "edge_city",
    verify: verifyIndexNetworkId,
  },
  {
    envKey: "INDEX_NETWORK_MASTER_KEY",
    label: "Index Network — master signup x-api-key",
    partnerGate: "edge_city",
    verify: verifyIndexMasterKey,
  },
  {
    envKey: "INDEX_WEBHOOK_SECRET",
    label: "Index Network — HMAC shared secret for opportunity.accepted webhook (shape only — we own the receiver)",
    partnerGate: "edge_city",
    verify: verifyIndexWebhookSecret,
  },
  {
    envKey: "TOOLROUTER_API_KEY",
    label: "ToolRouter platform API key (shape + /health + /v1/endpoints smoke test)",
    verify: verifyToolRouterApiKey,
  },
  {
    envKey: "TRAVALA_OAUTH_CLIENT_SECRET",
    label: "Travala booking OAuth client secret (shape + live client_credentials mcp:book mint)",
    verify: verifyTravalaOAuthClientSecret,
  },
];

/**
 * Run every registered verifier with its current `process.env` value.
 * Returns one result per entry, in declaration order, with the envKey
 * attached so callers can correlate.
 *
 * Never throws — exceptions inside individual verifiers are caught and
 * mapped to `status: "unreachable"`.
 */
export async function verifyAllPartnerSecrets(): Promise<
  Array<VerifierResult & { envKey: string; label: string }>
> {
  const results: Array<VerifierResult & { envKey: string; label: string }> = [];
  for (const v of SECRET_VERIFIERS) {
    const value = process.env[v.envKey] ?? "";
    try {
      const result = await v.verify(value);
      results.push({ ...result, envKey: v.envKey, label: v.label });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error("partner-secret verify threw", { envKey: v.envKey, error: msg });
      results.push({
        ok: false,
        status: "unreachable",
        error: `verifier threw: ${msg.slice(0, 200)}`,
        envKey: v.envKey,
        label: v.label,
      });
    }
  }
  return results;
}
