# Deep audit: lib/edgeos-auth.ts + lib/edgeos-api-keys.ts

**Date:** 2026-05-14
**Modules audited:** `instaclaw/lib/edgeos-auth.ts` (commit `2bb7a6ef`), `instaclaw/lib/edgeos-api-keys.ts` (commit `2bb7a6ef`)
**Scope:** every line. Edge cases requested by Cooper: OTP expiry mid-chain, 409 on createApiKey, bearer expiry between calls, network timeout behavior, retry safety.

Findings are tagged P0 (must fix before wiring into configureOpenClaw), P1 (fix in same PR as wiring), P2 (deferred / nice-to-have).

---

## TL;DR

The modules are correct on the happy path and have well-categorized error handling for the failure modes I've empirically observed. Three real gaps need fixing before production:

1. **[P0] No `X-Tenant-Id` plumbing.** The frontend interceptor sends `X-Tenant-Id` on every request universally. The auth endpoints empirically don't need it, but `/api/v1/api-keys` and `/api/v1/events/portal/events` very likely do. Without it, the wire-up will 422 on `createApiKey` and we won't know which header it's complaining about.
2. **[P0] No 409 (`name_conflict`) status on `createApiKey`.** Falls through to `"unknown"`. The deterministic name strategy (`instaclaw-edge-<vmName>`) WILL hit 409 on the second run for the same VM. Caller has no first-class signal to switch to "look up existing and reuse" — they have to inspect `httpStatus === 409` themselves.
3. **[P1] Non-idempotent network timeout on `createApiKey`.** If the request reaches EdgeOS but the response takes >15s, our AbortController fires and we return `network` error. A retry creates a duplicate key. This is a real risk on the EdgeOS sandbox per Tule's "glitchy until Tuesday" warning.

Other findings (P2) are documented below for completeness but don't block wire-up.

---

## edgeos-auth.ts

### A1 [P2] `DEFAULT_API_BASE` resolved at module load

```ts
const DEFAULT_API_BASE = process.env.EDGEOS_API_BASE || "https://api.dev.edgeos.world";
```

Evaluated once when the module is first imported. In Next.js serverless contexts and `tsx` scripts, this is fine — env vars are populated by the time imports resolve. In hot-reload dev contexts the constant won't refresh on env changes, but that's standard Node behavior and not worth fixing.

The `env: { apiBase }` per-call override lets callers bypass the default explicitly. Good escape hatch. The test script's `--prod` flag uses this. Solid.

### A2 [P1] Hard-coded `NETWORK_TIMEOUT_MS = 15_000`

Not configurable per call. The `EdgeOSEnv` only accepts `apiBase`. For the wire-up into `configureOpenClaw` we may want to set this lower (5s) so a hanging OTP send doesn't extend the configure window beyond the configure-deadline (Rule 44's 180s strict deadline) — or higher (30s) for the OTP send when EdgeOS sandbox is in its glitchy phase.

**Fix:** add `timeoutMs?: number` to `EdgeOSEnv` (both modules). Default stays at 15_000.

### A3 [P2] Email lowercase + trim

```ts
const trimmed = email.trim().toLowerCase();
```

Defensible. Gmail (and ~every modern provider) is case-insensitive on the local part. EdgeOS almost certainly is too — but unconfirmed. If a user signed up as `Cooper@gmail.com` and we lowercase to `cooper@gmail.com`, they'd both work in practice. Leaving as-is.

### A4 [OK] Pre-flight email validation is intentionally minimal

```ts
if (!trimmed || !trimmed.includes("@")) {
  return { ok: false, status: "validation_error", raw: "email is empty or missing @" };
}
```

Correct — we short-circuit only the obvious zero-cost cases (empty, no `@`) and let the server be the source of truth for everything else (reserved TLDs, malformed local parts, etc.). The smoke test confirmed the live API returns 422 for things like `example-nonexistent.test` and we surface that cleanly. No duplicate validation needed.

### A5 [OK] `JSON.stringify` body

No injection risk — single-field payload of trusted email. Standard.

### A6 [P2] 200 with empty body → `ok: true` with null fields

```ts
if (res.ok) {
  let parsed = ...;
  return {
    ok: true,
    email: parsed.email ?? trimmed,
    expiresInMinutes: parsed.expires_in_minutes ?? null,
    message: parsed.message ?? null,
  };
}
```

A 200 with no body still returns `ok: true`. Semantically correct (server says "accepted, OTP dispatched") but a future EdgeOS implementation could conceivably return 200 with `{ status: "no_op_email_blocked" }` and we'd treat it as success.

**Fix (low priority):** if `parsed.message` contains substrings like "blocked", "denied", "limit", treat as failure. Defer until empirical observation.

### A7 [P1] 401 and 404 conflated as `no_account`

```ts
if (res.status === 404 || res.status === 401) {
  return { ok: false, status: "no_account", ... };
}
```

Empirically 404 is "User not found." 401 on an unauthenticated endpoint is unusual — could mean the account is *blocked*, not *missing*. We can't distinguish from this code alone.

**Fix:** split — 404 stays `no_account`, 401 becomes `unknown` (or add new `account_blocked` status). Low priority since neither case is recoverable client-side — both demand operator action.

### A8 [P2] `rate_limited` doesn't expose `Retry-After`

Tule said rate limits aren't implemented yet, so this is currently dead code. When they ship them, callers will want to know the back-off duration.

**Fix:** add `retryAfterSeconds?: number` to the `rate_limited` variant; parse from `res.headers.get("Retry-After")`. Defer until rate limits actually exist.

### A9 [OK] Network errors caught broadly

```ts
catch (err) {
  return { ok: false, status: "network", raw: err instanceof Error ? err.message : String(err) };
}
```

Standard. The `raw` carries enough to debug (DNS failure vs TLS vs abort vs ECONNRESET will all be distinguishable from the message).

### A10 [OK] Six-digit regex matches OpenAPI spec exactly

`/^\d{6}$/` mirrors the server-side validation. No bypass risk.

### A11 [P1] 401 on `authenticateOTP` conflates wrong-code, expired-code, replay

**This is Cooper's "OTP expires mid-chain" question.** Today the user gets `invalid_code` for any of:
- typo
- expired (OTP timed out)
- already used (replay)
- email/code mismatch

We can't distinguish. The UX consequence: a chat flow can't say "your code expired — let me send a new one" automatically.

**Fix:** post-mortem the `raw` body. If `bodyText` contains `"expired"` (case-insensitive), return `expired` status; if `"already used"` or `"replay"`, return `code_used`; default `invalid_code`. This is best-effort — depends on what EdgeOS actually returns. **Need to empirically observe an expired-code response before committing the parsing strings.** Open follow-up after the first real test run.

### A12 [P2] Missing access_token: `raw` doesn't include body

```ts
if (!parsed.access_token) {
  return { ok: false, status: "unknown", httpStatus: res.status, raw: "200 response missing access_token" };
}
```

Future debugging would benefit from `raw: \`200 response missing access_token: ${bodyText.slice(0,200)}\``. Trivial fix.

### A13 [OK] No bearer logging anywhere

`maskToken` helper exists for callers. Bearer is returned in the `accessToken` field but never written to console/log inside the module. Credential hygiene clean.

### A14 [OK] Chain is stateless on our side

No `session_id` to thread between `requestOTP` and `authenticateOTP`. Correlation is the `(email, code)` pair. Good — no resumability bugs possible.

### A15 [OK] Double-requestOTP semantics

If a user calls `requestOTP` twice, the second OTP presumably invalidates the first (standard behavior). If they then submit the FIRST code, they get `invalid_code`. We don't guard against double-request; callers might legitimately want to "send me a new code". Document in the SKILL.md (already done), no code change.

---

## edgeos-api-keys.ts

### B1, B2 [OK] Mirrors auth module patterns

Same `DEFAULT_API_BASE`, `NETWORK_TIMEOUT_MS`, `DEFAULT_SCOPES = ["events:read"]`. All sound.

### B3 [P2] `ALL_SCOPES` is hard-coded

If EdgeOS adds a new scope (`tickets:write`, etc.), we need to update the constant. Could be derived from the OpenAPI at build time but overkill for v0. Fine.

### B4 [OK] Bearer emptiness check

`if (!bearer) return { status: "unauthorized" }`. Correct — bypasses a wasted network call.

A user-visible nit: "bearer never set" and "bearer expired" both surface as `unauthorized`. That's correct semantically — caller's response is the same (re-OTP). Fine.

### B5 [OK] Name length validation 1-100

Matches OpenAPI spec exactly.

### B6 [P0] **No 409 (`name_conflict`) status**

**Cooper's explicit question.** Current `categorizeFailure`:

```ts
function categorizeFailure(httpStatus, raw) {
  if (httpStatus === 401 || 403) → "unauthorized"
  if (httpStatus === 422) → "validation_error"
  if (httpStatus === 429) → "rate_limited"
  if (httpStatus === 404) → "not_found"
  return → "unknown"
}
```

A 409 from `createApiKey` falls through to `"unknown"` with `httpStatus: 409` in the result. The caller (the future `configureOpenClaw` wiring) gets:

```js
{ ok: false, status: "unknown", httpStatus: 409, raw: "..." }
```

To handle the idempotency case, the caller has to inspect `httpStatus === 409` *AND* status `"unknown"`. That's fragile — adds an outside-the-discriminated-union check, and forgets the type-system's help.

**Fix (P0):**
- Add `"name_conflict"` to `CreateApiKeyFailureStatus`.
- In `categorizeFailure`, add `if (httpStatus === 409) → "name_conflict"`.
- Caller pattern becomes the standard switch: `case "name_conflict": listApiKeys(...).then(matchByName).then(reuseOrRevokeAndRetry)`.

**Open question:** does EdgeOS actually return 409 on duplicate names, or 422, or 200-with-same-id-as-existing? We don't know empirically. The OpenAPI spec is silent on uniqueness — meaning the field likely IS unique (server-side index) and 409 is the canonical response, but it could also be 422 (server treats it as validation). **The first real test will tell us.** Add `name_conflict` for 409 AND ensure 422 with `raw` containing "exists"/"duplicate" also surfaces — defensive against either backend behavior.

### B7 [OK] CreateApiKey response shape tolerance

Strict on `id` + `key` (must-haves). Lenient on metadata fields with fallbacks. Right balance.

### B8 [OK] `.key` returned exactly once

Caller MUST persist immediately. The module's docstring is clear about this. Test script handles it (or `--keep` flag).

### B9 [OK] No automatic idempotency probe

The docstring describes the strategy; the code doesn't auto-implement it. Correct separation — the module is a thin wrapper, the caller owns the idempotency policy. The `deterministicKeyName(vmName)` helper enables the caller's strategy.

### B10 [OK] List response shape duality

`Array.isArray(parsed)` OR `parsed.results` — tolerates both. Good.

### B11 [P2] No pagination on list

Returns whatever fits in the first response. For our usage (a test user with <10 keys) this is fine. For long-lived service users with hundreds of keys we'd need to add `?skip=N` pagination. Defer.

### B12 [OK] `encodeURIComponent(keyId)` on revoke

Prevents path traversal. Good.

### B13 [OK] `res.ok` covers 200 and 204

Whatever EdgeOS returns for delete is accepted.

### B14 [OK] 404 on revoke → `not_found`

Caller can treat "already revoked" as effectively success. Good.

### B15 [OK] Discriminated union per status

Each failure variant carries `httpStatus` + `raw`. Good for caller switches.

### B16 [P0] Same 409 gap as B6 — listApiKeys and revokeApiKey

`listApiKeys` shouldn't hit 409 (it's a GET). But if it does, falls through to unknown. Acceptable.

`revokeApiKey` shouldn't hit 409 either. Acceptable.

### B17 [OK] `fetchWithTimeout` clears timer in finally

```ts
} finally {
  clearTimeout(t);
}
```

Prevents the timer firing post-resolution. Good.

### B18 [P1] **No retry; network timeout = duplicate-key risk on `createApiKey`**

**Cooper's "network timeout behavior" question + "retry safety" question.**

`fetch` aborts at 15s. If EdgeOS RECEIVED the request and started processing, but the response takes >15s, our AbortController fires and we return `{ status: "network" }`. A caller that retries on `network` → creates a duplicate key. Real risk on Tule's "glitchy until Tuesday" sandbox.

Three possible mitigations:

(a) **Idempotency-Key header (preferred but not supported by EdgeOS).** Standard pattern — caller generates a UUID per logical operation, server dedupes by it. The OpenAPI spec shows no such parameter. Out.

(b) **List-then-Create pattern in the caller.** Before retrying, the caller does `listApiKeys` to check if the deterministic name already exists; if so, reuse (or revoke + retry). Already documented in the module's docstring as the right pattern. This is what `configureOpenClaw` integration must do.

(c) **Longer timeout + explicit "retry not safe on this status" flag.** Bump timeout to 30s for `createApiKey` specifically; add a `retryUnsafe: true` boolean on the `network` failure variant so callers know not to blindly retry.

**Fix (P1):** implement (c) as a defense, AND document (b) as the canonical caller pattern. The wire-up PR enforces (b) via a helper.

### B19 [P2] `maskToken` mask reveals format-prefix only

`token.slice(0, 8)` of a JWT yields `eyJ0eXAi` — same for every JWT. For `eos_live_*`, yields `eos_live` — same prefix. Useful as a "yes, the token is set" smoke-test, useless as a fingerprint.

**Fix (low priority):** include a hash digest fingerprint like `${token.slice(0,8)}…#${sha256(token).slice(0,6)}…(${token.length})`. Then the same token reuses the same fingerprint across logs. Defer.

---

## Cooper's specific questions — answers

### Q1: What if the OTP expires mid-chain?

Currently: user gets `invalid_code` on `authenticateOTP`. They can't tell expired from typo. They re-run; gets a new OTP and tries again. Functionally recoverable, just sub-optimal UX.

**Fix:** A11 — parse `raw` for "expired" substring, surface as distinct status.

### Q2: createApiKey returns 409 (key name already exists)?

Currently: `{ ok: false, status: "unknown", httpStatus: 409, raw: ... }`. Caller has to know to inspect `httpStatus === 409` manually.

**Fix:** B6 — add `name_conflict` status. P0.

### Q3: Bearer expires between authenticateOTP and createApiKey?

Currently: createApiKey returns `unauthorized`. Caller must re-run requestOTP + authenticateOTP from scratch. The chain is fully recoverable.

**Open:** we don't know how long the bearer lasts. Spec doesn't say. If it's <60s, the wire-up needs to authenticate-and-create-key in tight succession (no waiting for user input between). If it's hours, no issue. Need empirical observation.

### Q4: Network timeout behavior?

15s AbortController. Caught as `network` status. **Real duplicate-key risk** on `createApiKey` if the request reached EdgeOS but the response was slow.

**Fix:** B18 — caller MUST use list-before-create pattern; module exposes `retryUnsafe` flag.

### Q5: Retry safety?

| Operation | Safe to retry? |
|---|---|
| `requestOTP` | Yes (invalidates prior OTP) |
| `authenticateOTP` | Yes (idempotent on (email,code)) |
| `createApiKey` | **No** — creates duplicate. List-first is mandatory. |
| `listApiKeys` | Yes |
| `revokeApiKey` | Yes (revoking-already-revoked = `not_found` = effectively success) |

---

## Concrete proposed patches

In order of priority:

### Patch 1 [P0] — `X-Tenant-Id` plumbing

Add to `EdgeOSEnv`:
```ts
export type EdgeOSEnv = {
  apiBase?: string;
  tenantId?: string;
};
```

In every `fetchWithTimeout` call, build headers conditionally:
```ts
const headers: Record<string, string> = { "Content-Type": "application/json" };
if (env.tenantId) headers["X-Tenant-Id"] = env.tenantId;
// ... merge with Authorization
```

For `lib/edgeos-api-keys.ts` — same plumbing. Default tenant from `process.env.EDGEOS_TENANT_ID` if set.

### Patch 2 [P0] — `name_conflict` status

`CreateApiKeyFailureStatus` adds `"name_conflict"`. `categorizeFailure` adds 409 mapping. `Patch 4` (caller helper) uses it.

### Patch 3 [P1] — Configurable timeout + `retryUnsafe` flag

`EdgeOSEnv` adds `timeoutMs?: number`. The `network` failure variant on `createApiKey` adds `retryUnsafe: true` so callers know.

### Patch 4 [P1] — Caller helper `mintOrReuseApiKey(bearer, vmName, env)`

A higher-level helper that:
1. Calls `listApiKeys(bearer, env)`.
2. Looks for active (non-revoked) key with name `deterministicKeyName(vmName)`.
3. If present BUT we don't have the raw `.key` cached → revoke it + create a new one (since we can't reuse a key whose secret we never saw).
4. If not present → create.
5. Returns the active `eos_live_*` ready to persist.

This is the function `configureOpenClaw` actually wants. Lives in a new `lib/edgeos-mint.ts` (separate file — high-level orchestration vs low-level HTTP).

### Patch 5 [P2] — Test script asserts events-list returned non-empty

`scripts/_test-edgeos-auth-chain.ts` adds an explicit assertion + prints first event title for visual confirmation. Otherwise an unapproved-popup case looks like silent success.

### Patch 6 [P2] — Parse "expired" from authenticateOTP `raw`

After observing what EdgeOS actually returns for an expired OTP, add parsing logic. Until then, ship as-is.

---

## Recommended ship order

1. **First real sandbox test run** (operator: Cooper, runbook: `instaclaw/docs/edgeos-sandbox-test-setup.md`). Empirical observation tells us:
   - Does `/api/v1/api-keys` need `X-Tenant-Id`?
   - What does an expired OTP body look like?
   - How long does a bearer last?
   - What's the actual 409 response shape?
2. **One patch PR** that applies Patches 1, 2, 3 and updates the test script (Patch 5). Includes any empirical findings from step 1.
3. **Patch 4 (`mintOrReuseApiKey`)** lands in the `configureOpenClaw` wire-up PR — separate from this module.
4. **Patch 6** lands ad-hoc when we observe an expired OTP in production logs.

---

## Files touched by this audit

- `instaclaw/lib/edgeos-auth.ts` — no code changes proposed yet (audit only)
- `instaclaw/lib/edgeos-api-keys.ts` — no code changes proposed yet (audit only)
- `instaclaw/docs/edgeos-auth-audit-2026-05-14.md` — this file (NEW)
