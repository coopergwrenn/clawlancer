/**
 * High-level EdgeOS api-key minting helper.
 *
 * This is the function `configureOpenClaw` (and any per-VM provisioning
 * path) actually wants. It composes the low-level primitives in
 * lib/edgeos-auth.ts + lib/edgeos-api-keys.ts and applies the
 * conflict-handling + retry-safety policy in one place.
 *
 * Behavioral contract:
 *
 *   1. Try to mint a key named `instaclaw-edge-{vmName}` (deterministic).
 *   2. On 200/201 → return the freshly minted full key (`eos_live_*`)
 *      and the prefix. Caller MUST persist the full key immediately;
 *      it is shown once and never recoverable.
 *   3. On `name_conflict` (409, or defensively 422-with-"exists"):
 *      a. List existing keys.
 *      b. Look for an ACTIVE (revoked_at == null) key matching the
 *         deterministic name.
 *      c. Apply the configured `onConflict` strategy:
 *           - "return_existing" (default): return the prefix-only record
 *             of the existing key. Caller is expected to have the full
 *             key in DB / env; they compare prefixes to verify and reuse.
 *           - "suffix": mint a fresh key with name
 *             `instaclaw-edge-{vmName}-{Date.now()}`. Caller persists
 *             the new full key. Old key is left in place — caller
 *             can revoke at their leisure (or via a separate sweep).
 *           - "revoke_and_remint": revoke the existing key by id, then
 *             retry the mint with the deterministic name. Caller
 *             persists the new full key. Risk: if the existing key was
 *             still in use by a partner-skill SDK on the VM, that SDK
 *             will start 401-ing until the new key is plumbed in.
 *             Use only when you're confident the existing key isn't live.
 *   4. On network error mid-create (retryUnsafe=true): probe via
 *      listApiKeys to see whether the request landed before retrying.
 *      Same conflict-handling pattern from step 3 applies if so.
 *   5. All other errors propagate unchanged.
 *
 * Telemetry hook: callers can pass `onTelemetry` for structured logging.
 * The default is silent.
 *
 * This is intentionally NOT wired into configureOpenClaw yet — Cooper
 * wants the wiring in a separate PR after the first successful sandbox
 * end-to-end run validates the assumptions encoded here.
 */

import {
  EDGEOS_TENANT_EDGECITY_PROD,
  EDGEOS_TENANT_DEMO_SANDBOX,
  type EdgeOSEnv,
} from "./edgeos-auth";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  deterministicKeyName,
  DEFAULT_SCOPES,
  type ApiKey,
  type ApiKeyScope,
  type CreatedApiKey,
} from "./edgeos-api-keys";

export type MintConflictStrategy =
  | "return_existing"
  | "suffix"
  | "revoke_and_remint";

export type MintOrReuseInput = {
  /** Bearer obtained from authenticateOTP. */
  bearer: string;
  /** InstaClaw VM name (e.g. "instaclaw-vm-050"). Used to build the
   *  deterministic key name. */
  vmName: string;
  /** Scopes for the key. Default ["events:read"]. */
  scopes?: ApiKeyScope[];
  /** Behavior when the deterministic name is already taken. */
  onConflict?: MintConflictStrategy;
};

export type MintTelemetryEvent = {
  op:
    | "create_attempted"
    | "created"
    | "conflict_detected"
    | "list_probed"
    | "existing_returned"
    | "suffix_minted"
    | "revoke_then_remint"
    | "network_probe"
    | "failed";
  vmName: string;
  attempt: number;
  details?: string;
};

export type MintOrReuseResult =
  | {
      ok: true;
      /** "created" → fresh mint, `fullKey` is present. "existing" → key
       *  was already there; `fullKey` is null (we never see existing
       *  secrets). "suffix" → fresh mint under a suffixed name to avoid
       *  the conflict, `fullKey` is present. "revoke_remint" → existing
       *  key was revoked then a fresh one minted under the deterministic
       *  name, `fullKey` is present. */
      mode: "created" | "existing" | "suffix" | "revoke_remint";
      apiKey: Omit<ApiKey, "key"> & { name: string };
      /** The `eos_live_*` raw key — ONLY when we just minted it.
       *  Null when we returned an existing key (we never see existing
       *  secrets in EdgeOS — they're shown once at create time). */
      fullKey: string | null;
    }
  | {
      ok: false;
      status:
        | "unauthorized"
        | "validation_error"
        | "rate_limited"
        | "network"
        | "conflict_unresolvable"
        | "unknown";
      detail?: string;
      httpStatus?: number;
    };

const MAX_ATTEMPTS = 2;

export async function mintOrReuseApiKey(
  input: MintOrReuseInput,
  env: EdgeOSEnv = {},
  onTelemetry: (e: MintTelemetryEvent) => void = () => {}
): Promise<MintOrReuseResult> {
  const { bearer, vmName } = input;
  const scopes = input.scopes ?? DEFAULT_SCOPES;
  const onConflict: MintConflictStrategy = input.onConflict ?? "return_existing";
  const name = deterministicKeyName(vmName);

  if (!bearer) {
    return { ok: false, status: "unauthorized", detail: "bearer is empty" };
  }
  if (!vmName) {
    return { ok: false, status: "validation_error", detail: "vmName is empty" };
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    onTelemetry({ op: "create_attempted", vmName, attempt });
    const create = await createApiKey(bearer, { name, scopes }, env);

    if (create.ok) {
      onTelemetry({ op: "created", vmName, attempt, details: `id=${create.apiKey.id}` });
      return toResult(create.apiKey, "created", create.apiKey.key);
    }

    // Pure unauthorized / validation_error / rate_limited → no recovery
    // path inside this helper; surface to caller.
    if (
      create.status === "unauthorized" ||
      create.status === "validation_error" ||
      create.status === "rate_limited"
    ) {
      onTelemetry({ op: "failed", vmName, attempt, details: create.status });
      return {
        ok: false,
        status: create.status,
        detail: create.raw,
        httpStatus: create.httpStatus,
      };
    }

    // Network — the request may have landed. Probe before retrying.
    if (create.status === "network") {
      onTelemetry({ op: "network_probe", vmName, attempt, details: create.raw });
      const probe = await probeForExisting(bearer, name, env);
      if (probe.kind === "found") {
        // The minting actually succeeded server-side before our timeout
        // fired locally. Apply onConflict strategy as if 409.
        onTelemetry({ op: "conflict_detected", vmName, attempt, details: `via_network_probe id=${probe.existing.id}` });
        return applyConflictStrategy({
          bearer,
          name,
          scopes,
          env,
          existing: probe.existing,
          strategy: onConflict,
          vmName,
          attempt,
          onTelemetry,
        });
      }
      if (probe.kind === "not_found" && attempt < MAX_ATTEMPTS) {
        // Server didn't receive the request OR rolled it back. Retry.
        continue;
      }
      // Probe itself failed, or we've exhausted attempts. Bail.
      return {
        ok: false,
        status: "network",
        detail: probe.kind === "list_failed" ? `network failure + list probe failed: ${probe.detail}` : create.raw,
      };
    }

    // name_conflict — list and apply strategy.
    if (create.status === "name_conflict") {
      onTelemetry({ op: "conflict_detected", vmName, attempt, details: `http=${create.httpStatus}` });
      const probe = await probeForExisting(bearer, name, env);
      if (probe.kind === "found") {
        return applyConflictStrategy({
          bearer,
          name,
          scopes,
          env,
          existing: probe.existing,
          strategy: onConflict,
          vmName,
          attempt,
          onTelemetry,
        });
      }
      // 409 returned but list doesn't show the key — possible race with
      // someone else revoking it between create and our probe. Retry.
      if (attempt < MAX_ATTEMPTS) continue;
      return {
        ok: false,
        status: "conflict_unresolvable",
        detail: `name_conflict on create but key not present in list — possible concurrent revoke. ${probe.kind === "list_failed" ? probe.detail : ""}`,
      };
    }

    // unknown — surface
    onTelemetry({ op: "failed", vmName, attempt, details: `unknown: ${create.raw}` });
    return {
      ok: false,
      status: "unknown",
      detail: create.raw,
      httpStatus: create.httpStatus,
    };
  }

  return { ok: false, status: "unknown", detail: "exhausted retries without resolution" };
}

// ─── helpers ──────────────────────────────────────────────────────────────

type ProbeResult =
  | { kind: "found"; existing: ApiKey }
  | { kind: "not_found" }
  | { kind: "list_failed"; detail: string };

async function probeForExisting(
  bearer: string,
  name: string,
  env: EdgeOSEnv
): Promise<ProbeResult> {
  const list = await listApiKeys(bearer, env);
  if (!list.ok) {
    return {
      kind: "list_failed",
      detail: `list status=${list.status} http=${list.httpStatus ?? "?"} ${list.raw ?? ""}`.slice(0, 300),
    };
  }
  const match = list.apiKeys.find((k) => k.name === name && k.revokedAt === null);
  return match ? { kind: "found", existing: match } : { kind: "not_found" };
}

async function applyConflictStrategy(args: {
  bearer: string;
  name: string;
  scopes: ApiKeyScope[];
  env: EdgeOSEnv;
  existing: ApiKey;
  strategy: MintConflictStrategy;
  vmName: string;
  attempt: number;
  onTelemetry: (e: MintTelemetryEvent) => void;
}): Promise<MintOrReuseResult> {
  const { bearer, name, scopes, env, existing, strategy, vmName, attempt, onTelemetry } = args;

  if (strategy === "return_existing") {
    onTelemetry({ op: "existing_returned", vmName, attempt, details: `id=${existing.id} prefix=${existing.prefix}` });
    return toResult(existing, "existing", null);
  }

  if (strategy === "suffix") {
    const suffixed = `${name}-${Date.now()}`.slice(0, 100);
    const create = await createApiKey(bearer, { name: suffixed, scopes }, env);
    if (create.ok) {
      onTelemetry({ op: "suffix_minted", vmName, attempt, details: `id=${create.apiKey.id} name=${suffixed}` });
      return toResult(create.apiKey, "suffix", create.apiKey.key);
    }
    return {
      ok: false,
      status: create.status === "unauthorized" || create.status === "validation_error" || create.status === "rate_limited" || create.status === "network" ? create.status : "unknown",
      detail: `suffix-mint failed: ${create.raw}`,
      httpStatus: create.httpStatus,
    };
  }

  // revoke_and_remint
  const revoke = await revokeApiKey(bearer, existing.id, env);
  if (!revoke.ok) {
    // Revoke failed — caller would be stuck. Surface as conflict_unresolvable.
    return {
      ok: false,
      status: "conflict_unresolvable",
      detail: `revoke-then-remint: revoke failed status=${revoke.status} ${revoke.raw ?? ""}`.slice(0, 300),
      httpStatus: revoke.httpStatus,
    };
  }
  const create = await createApiKey(bearer, { name, scopes }, env);
  if (create.ok) {
    onTelemetry({ op: "revoke_then_remint", vmName, attempt, details: `revoked=${existing.id} created=${create.apiKey.id}` });
    return toResult(create.apiKey, "revoke_remint", create.apiKey.key);
  }
  // Catastrophe: revoked the existing key but couldn't mint a fresh one.
  // Caller has neither key. Surface clearly.
  return {
    ok: false,
    status: "conflict_unresolvable",
    detail: `revoke-then-remint: revoked existing=${existing.id} but mint failed: ${create.raw}`,
    httpStatus: create.httpStatus,
  };
}

function toResult(
  k: ApiKey | CreatedApiKey,
  mode: "created" | "existing" | "suffix" | "revoke_remint",
  fullKey: string | null
): MintOrReuseResult {
  return {
    ok: true,
    mode,
    apiKey: {
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      scopes: k.scopes,
      createdAt: k.createdAt,
      expiresAt: k.expiresAt,
      revokedAt: k.revokedAt,
      lastUsedAt: k.lastUsedAt,
    },
    fullKey,
  };
}

// Re-export the known tenant constants so callers can `import from edgeos-mint`
// without also importing from edgeos-auth.
export { EDGEOS_TENANT_EDGECITY_PROD, EDGEOS_TENANT_DEMO_SANDBOX };
