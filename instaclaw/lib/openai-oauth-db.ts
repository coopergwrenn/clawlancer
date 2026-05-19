/**
 * DB layer for the ChatGPT-OAuth feature.
 *
 * Two tables touched:
 *   - instaclaw_users: holds the encrypted token store + cached id-token claims
 *   - instaclaw_oauth_device_flows: in-flight device-code polling state
 *
 * Three callers depend on this module:
 *   - /api/auth/openai/device-code/start  (createOrReuseDeviceFlow)
 *   - /api/auth/openai/device-code/poll   (getDeviceFlow + storeOAuthTokens + mark*)
 *   - /api/auth/openai/disconnect         (disconnectUser)
 *   - /api/cron/openai-oauth-graceful-downgrade (disconnectUser — same helper)
 *
 * Design contracts:
 *   - All encrypts go through lib/openai-oauth-encryption (Rule 53 — versioned key id,
 *     never plaintext on disk). Never log full token values — prefix-only in any
 *     diagnostic line.
 *   - .select("*") for safety-critical reads per Rule 19.
 *   - Idempotent where possible. Re-clicking "Connect" returns the existing pending
 *     flow rather than minting a new one (race-protected by the partial-unique-index
 *     on (user_id, status='pending') from the migration).
 *   - disconnectUser is the SINGLE source of truth for "tear down a user's OAuth
 *     state." The dashboard's Disconnect button and the kill-switch graceful-downgrade
 *     cron both go through it — guaranteed identical behavior.
 *   - Version-bump pattern: read current openai_token_version, write +1. The
 *     reconciler step compares user.openai_token_version against
 *     vm.openai_token_version_synced (per Day 1 migration) to detect drift.
 *     Concurrent read-modify-write is acceptable because we only need the value
 *     to CHANGE — exact monotonicity isn't load-bearing for cache invalidation.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  encryptSecret,
} from "./openai-oauth-encryption";
import type {
  DeviceCodePoll,
  DeviceCodeStart,
  IdTokenClaims,
} from "./openai-oauth";

// ─── Types ───────────────────────────────────────────────────────────────

/**
 * The DB row shape for instaclaw_oauth_device_flows.
 * Mirrors the migration columns exactly.
 */
export interface DeviceFlowRow {
  id: string;
  user_id: string;
  provider: string;
  device_auth_id: string;
  user_code: string;
  verification_uri: string;
  interval_seconds: number;
  expires_at: string; // ISO timestamp
  status: "pending" | "completed" | "expired" | "denied" | "error";
  status_message: string | null;
  completed_at: string | null;
  created_at: string;
}

/**
 * Public-safe summary of a user's OAuth connection state.
 * No tokens, no internal IDs — suitable for return from API routes
 * the user's browser can see.
 */
export interface ConnectedSummary {
  connected: boolean;
  expiresAt?: string;
  planType?: string | null;
  email?: string | null;
  accountId?: string | null;
}

// ─── Device-flow CRUD ────────────────────────────────────────────────────

/**
 * Insert a new device-code flow row, OR reuse the existing pending row if
 * the user has one already (race protection — clicking "Connect" twice in
 * quick succession should resolve to one flow, not two).
 *
 * The migration's partial-unique-index on (user_id) WHERE status='pending'
 * is what makes this safe. The first INSERT wins; the second hits 23505
 * (unique_violation) and we fall back to SELECT.
 *
 * @param userId  authenticated user id
 * @param started result from openai-oauth.startDeviceFlow()
 * @param supabase service-role client
 */
export async function createOrReuseDeviceFlow(
  userId: string,
  started: DeviceCodeStart,
  supabase: SupabaseClient,
): Promise<DeviceFlowRow> {
  const expiresAt = new Date(Date.now() + started.expiresInMs).toISOString();
  const intervalSeconds = Math.max(1, Math.round(started.intervalMs / 1000));

  const insertPayload = {
    user_id: userId,
    provider: "openai_codex",
    device_auth_id: started.deviceAuthId,
    user_code: started.userCode,
    verification_uri: started.verificationUri,
    interval_seconds: intervalSeconds,
    expires_at: expiresAt,
    status: "pending" as const,
  };

  const { data: inserted, error: insertErr } = await supabase
    .from("instaclaw_oauth_device_flows")
    .insert(insertPayload)
    .select("*")
    .single();

  if (!insertErr && inserted) {
    return inserted as DeviceFlowRow;
  }

  // 23505 = unique_violation — the partial-unique-index fired. User already
  // has a pending flow. Return that one so the UI keeps polling against it.
  // Any other error is a real failure.
  const isUniqueViolation =
    insertErr?.code === "23505" ||
    /duplicate key value/i.test(insertErr?.message ?? "");
  if (!isUniqueViolation) {
    throw new Error(
      `createOrReuseDeviceFlow: insert failed: ${insertErr?.message ?? "unknown"}`,
    );
  }

  const { data: existing, error: readErr } = await supabase
    .from("instaclaw_oauth_device_flows")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "pending")
    .single();

  if (readErr || !existing) {
    throw new Error(
      `createOrReuseDeviceFlow: insert hit unique-violation but no pending row found: ${readErr?.message ?? "no rows"}`,
    );
  }
  return existing as DeviceFlowRow;
}

/**
 * Find the user's currently-pending device-code flow, if any, that
 * hasn't passed its expires_at deadline. Used by the start route to
 * avoid minting a new OpenAI device code when the user already has a
 * fresh one in flight.
 *
 * Returns null if no fresh pending flow exists. The partial-unique-index
 * on (user_id) WHERE status='pending' guarantees at most one match.
 */
export async function getFreshPendingFlow(
  userId: string,
  supabase: SupabaseClient,
): Promise<DeviceFlowRow | null> {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("instaclaw_oauth_device_flows")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "pending")
    .gt("expires_at", nowIso)
    .maybeSingle();
  if (error) {
    throw new Error(`getFreshPendingFlow: ${error.message}`);
  }
  return (data as DeviceFlowRow | null) ?? null;
}

/**
 * Look up a device-flow row by id, scoped to user_id (so a user can't
 * peek at another user's flow even if they guess the id).
 *
 * Returns null on not-found (caller should 404). Throws on real errors.
 */
export async function getDeviceFlow(
  flowId: string,
  userId: string,
  supabase: SupabaseClient,
): Promise<DeviceFlowRow | null> {
  const { data, error } = await supabase
    .from("instaclaw_oauth_device_flows")
    .select("*")
    .eq("id", flowId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(`getDeviceFlow: ${error.message}`);
  }
  return (data as DeviceFlowRow | null) ?? null;
}

/**
 * Transition a device-flow row to a terminal non-success state.
 * Used for: expired, denied, error.
 *
 * Idempotent — re-marking a row that's already in a terminal state is a no-op.
 * Race-tolerant — we filter on status='pending' so a concurrent poll that
 * already wrote 'completed' isn't overwritten.
 */
export async function markDeviceFlowFailed(
  flowId: string,
  status: "expired" | "denied" | "error",
  message: string | null,
  supabase: SupabaseClient,
): Promise<void> {
  const { error } = await supabase
    .from("instaclaw_oauth_device_flows")
    .update({
      status,
      status_message: message,
      completed_at: new Date().toISOString(),
    })
    .eq("id", flowId)
    .eq("status", "pending");
  if (error) {
    throw new Error(`markDeviceFlowFailed: ${error.message}`);
  }
}

/**
 * Transition a device-flow row to status='completed'.
 *
 * Called by the poll route AFTER storeOAuthTokens has successfully
 * persisted the tokens on instaclaw_users. Order matters: we want
 * tokens-on-disk before flow-marked-completed, so a partial failure
 * leaves the flow recoverable on the next poll.
 *
 * Race-tolerant via .eq("status", "pending") filter — concurrent
 * markDeviceFlowCompleted calls converge to a single 'completed' row.
 */
export async function markDeviceFlowCompleted(
  flowId: string,
  supabase: SupabaseClient,
): Promise<void> {
  const { error } = await supabase
    .from("instaclaw_oauth_device_flows")
    .update({
      status: "completed",
      status_message: null,
      completed_at: new Date().toISOString(),
    })
    .eq("id", flowId)
    .eq("status", "pending");
  if (error) {
    throw new Error(`markDeviceFlowCompleted: ${error.message}`);
  }
}

/**
 * Options for markDeviceFlowCompletedWithRetry. Tests pass backoffMs=0
 * for fast execution; production callers should leave defaults alone.
 */
export interface MarkCompletedRetryOpts {
  /** Total attempts before giving up. Default 3. */
  maxAttempts?: number;
  /** Sleep between attempts (linear, not exponential). Default 1000ms. */
  backoffMs?: number;
}

/**
 * Retry wrapper around markDeviceFlowCompleted. Audit finding P1-D —
 * Day 2 silently logged a warning if the mark-completed update failed
 * (e.g., transient Supabase blip), leaving the row in `pending` while
 * tokens were already stored on the user record. The next poll would
 * read status=pending, call OpenAI, get 403 (auth code already redeemed),
 * map to {status:"pending"}, and the user would appear stuck until
 * clock-side expiry fired.
 *
 * Retry semantics:
 *   - Total attempts: maxAttempts (default 3)
 *   - Backoff between attempts: backoffMs (default 1000ms)
 *   - On any attempt's success: returns {success: true, attempts: N}
 *   - On all attempts failing: returns {success: false, attempts: max, lastError}
 *
 * Never throws — caller decides whether to surface failure or fall back
 * to the connected-state safety net (also added in P1-D).
 */
export async function markDeviceFlowCompletedWithRetry(
  flowId: string,
  supabase: SupabaseClient,
  opts: MarkCompletedRetryOpts = {},
): Promise<{ success: boolean; attempts: number; lastError?: string }> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const backoffMs = opts.backoffMs ?? 1000;
  let lastError: string | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await markDeviceFlowCompleted(flowId, supabase);
      return { success: true, attempts: attempt };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < maxAttempts && backoffMs > 0) {
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }
  return { success: false, attempts: maxAttempts, lastError };
}

// ─── Token storage ───────────────────────────────────────────────────────

/**
 * Take a successful poll result and persist its tokens (encrypted) on the
 * user record. Bumps openai_token_version so the reconciler will push the
 * new token to every VM owned by this user on the next tick.
 *
 * SENSITIVE — token values are encrypted via encryptSecret BEFORE storage.
 * Never log them. The status_message we attach to the flow row uses prefix
 * only (first 12 chars) for forensic correlation without leaking.
 *
 * The id_token claims are stored TWO ways for ease of use:
 *   - openai_oauth_id_token_claims (JSONB) — full snake_case dump for
 *     debugging / future use
 *   - chatgpt_plan_type, openai_oauth_account_id — denormalized for cheap
 *     indexed lookups in dashboard UI and billing checks
 */
export async function storeOAuthTokens(
  userId: string,
  completed: Extract<DeviceCodePoll, { status: "completed" }>,
  supabase: SupabaseClient,
): Promise<{ tokenVersion: number; planType: string | null }> {
  const { tokens, claims } = completed;

  // Encrypt before write (Rule 53). The current key version is encoded
  // into the ciphertext prefix so future decryption Just Works after
  // rotation. AAD = userId — binds each ciphertext to its owner
  // cryptographically (per the Day 2.5 audit P2-B finding); a DB-write
  // attacker who copies user A's encrypted token into user B's row
  // cannot decrypt it under B's id.
  const encryptedAccess = encryptSecret(tokens.accessToken, userId);
  const encryptedRefresh = encryptSecret(tokens.refreshToken, userId);

  // Build the snake_case claims dump for the JSONB column.
  const claimsForDb = claims ? camelToSnakeClaims(claims) : null;

  // Read current version (separate query — race-tolerant per the module-doc).
  // Use .select("*") per Rule 19 even though we only need one field; the cost
  // is one row of bytes and we get safety against column-grant misconfig.
  const { data: u, error: readErr } = await supabase
    .from("instaclaw_users")
    .select("*")
    .eq("id", userId)
    .single();
  if (readErr || !u) {
    throw new Error(`storeOAuthTokens: user read failed: ${readErr?.message ?? "no rows"}`);
  }
  const currentVersion = (u.openai_token_version as number | undefined) ?? 0;
  const nextVersion = currentVersion + 1;

  const expiresAtIso = new Date(tokens.expiresAtMs).toISOString();
  const planType = claims?.chatgptPlanType ?? null;

  const { error: writeErr } = await supabase
    .from("instaclaw_users")
    .update({
      openai_oauth_access_token: encryptedAccess,
      openai_oauth_refresh_token: encryptedRefresh,
      openai_oauth_id_token_claims: claimsForDb,
      openai_oauth_expires_at: expiresAtIso,
      openai_oauth_last_refresh_at: new Date().toISOString(),
      openai_oauth_account_id: claims?.chatgptAccountId ?? null,
      openai_oauth_originator: getOrComputeOriginator(u),
      openai_token_version: nextVersion,
      chatgpt_plan_type: planType,
      chatgpt_plan_last_seen_at: planType ? new Date().toISOString() : null,
    })
    .eq("id", userId);

  if (writeErr) {
    throw new Error(`storeOAuthTokens: user write failed: ${writeErr.message}`);
  }

  return { tokenVersion: nextVersion, planType };
}

/**
 * Stable per-user originator string. OpenAI's OAuth spec optionally allows
 * sending an originator/install-fingerprint with the device-code request;
 * keeping it stable across rotations lets OpenAI's observability link
 * sessions for the same install.
 *
 * Use the existing value if set; otherwise derive a deterministic string
 * from the user_id (truncated UUID) so it's stable for the lifetime of
 * the user record. NOT cryptographically random — the value is essentially
 * a UA-style identifier, not a secret.
 */
function getOrComputeOriginator(u: Record<string, unknown>): string {
  const existing = u.openai_oauth_originator;
  if (typeof existing === "string" && existing.length > 0) return existing;
  const userId = String(u.id ?? "unknown");
  return `instaclaw-${userId.slice(0, 8)}`;
}

/**
 * Translate the camelCase IdTokenClaims (our type) into the snake_case
 * shape the rest of the world uses (the wire format from OpenAI and the
 * shape we want in the JSONB column for human readability).
 */
function camelToSnakeClaims(c: IdTokenClaims): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (c.email !== undefined) out.email = c.email;
  if (c.chatgptPlanType !== undefined) out.chatgpt_plan_type = c.chatgptPlanType;
  if (c.chatgptAccountId !== undefined) out.chatgpt_account_id = c.chatgptAccountId;
  if (c.chatgptUserId !== undefined) out.chatgpt_user_id = c.chatgptUserId;
  if (c.chatgptAccountIsFedramp !== undefined) {
    out.chatgpt_account_is_fedramp = c.chatgptAccountIsFedramp;
  }
  if (c.exp !== undefined) out.exp = c.exp;
  if (c.iat !== undefined) out.iat = c.iat;
  if (c.iss !== undefined) out.iss = c.iss;
  if (c.aud !== undefined) out.aud = c.aud;
  return out;
}

// ─── User-state queries ──────────────────────────────────────────────────

/**
 * Return a public-safe summary of the user's connection state. Used by
 * the start route to decide "show fresh flow" vs "already connected" UX.
 */
export async function getConnectedSummary(
  userId: string,
  supabase: SupabaseClient,
): Promise<ConnectedSummary> {
  const { data: u, error } = await supabase
    .from("instaclaw_users")
    .select("*")
    .eq("id", userId)
    .single();
  if (error || !u) {
    throw new Error(`getConnectedSummary: user read failed: ${error?.message ?? "no rows"}`);
  }
  const accessToken = u.openai_oauth_access_token as string | null | undefined;
  if (!accessToken) {
    return { connected: false };
  }
  const expiresAt = u.openai_oauth_expires_at as string | null | undefined;
  const claims = u.openai_oauth_id_token_claims as Record<string, unknown> | null | undefined;
  return {
    connected: true,
    expiresAt: expiresAt ?? undefined,
    planType: (u.chatgpt_plan_type as string | null | undefined) ?? null,
    email: typeof claims?.email === "string" ? claims.email : null,
    accountId: (u.openai_oauth_account_id as string | null | undefined) ?? null,
  };
}

// ─── Disconnect (shared by API route + kill-switch cron) ─────────────────

/**
 * Tear down a user's OAuth state completely.
 *
 * Three coordinated writes (each idempotent — re-running is a no-op):
 *   1. UPDATE instaclaw_vms SET api_mode='all_inclusive' for any VM the
 *      user owns that's currently in 'chatgpt_oauth' mode. (Safe baseline
 *      — user can manually re-elect byok later if that was their prior.)
 *   2. UPDATE instaclaw_vms SET default_model='claude-sonnet-4-6' for any
 *      VM whose default_model is an openai-codex/* model. (We don't touch
 *      VMs configured to a non-codex model post-connect.)
 *   3. UPDATE instaclaw_users — NULL all openai_oauth_* fields + bump
 *      openai_token_version. The bump signals the reconciler to remove the
 *      openai-codex:default profile from each VM's auth-profiles.json.
 *
 * Order: VM-side cleanup BEFORE user-side cleanup. If user-side fails, the
 * reconciler's next tick reads NULL on user.openai_oauth_access_token and
 * removes the profile from VMs regardless. If VM-side fails, retry: the
 * user record is still in chatgpt_oauth state and a re-call recovers.
 *
 * Throws on any failure. Caller is responsible for retry semantics.
 */
export async function disconnectUser(
  userId: string,
  supabase: SupabaseClient,
): Promise<void> {
  // Step 1: VM api_mode reset
  const { error: apiModeErr } = await supabase
    .from("instaclaw_vms")
    .update({ api_mode: "all_inclusive" })
    .eq("assigned_to", userId)
    .eq("api_mode", "chatgpt_oauth");
  if (apiModeErr) {
    throw new Error(`disconnectUser: vm api_mode update failed: ${apiModeErr.message}`);
  }

  // Step 2: VM default_model reset (only for openai-codex models)
  const { error: modelErr } = await supabase
    .from("instaclaw_vms")
    .update({ default_model: "claude-sonnet-4-6" })
    .eq("assigned_to", userId)
    .like("default_model", "openai-codex/%");
  if (modelErr) {
    throw new Error(`disconnectUser: vm default_model update failed: ${modelErr.message}`);
  }

  // Step 3: user fields + version bump
  const { data: u, error: readErr } = await supabase
    .from("instaclaw_users")
    .select("openai_token_version")
    .eq("id", userId)
    .single();
  if (readErr) {
    throw new Error(`disconnectUser: user read failed: ${readErr.message}`);
  }
  const currentVersion = (u?.openai_token_version as number | undefined) ?? 0;

  const { error: nullErr } = await supabase
    .from("instaclaw_users")
    .update({
      openai_oauth_access_token: null,
      openai_oauth_refresh_token: null,
      openai_oauth_id_token_claims: null,
      openai_oauth_expires_at: null,
      openai_oauth_last_refresh_at: null,
      openai_oauth_account_id: null,
      openai_oauth_originator: null,
      chatgpt_plan_type: null,
      chatgpt_plan_last_seen_at: null,
      openai_token_version: currentVersion + 1,
    })
    .eq("id", userId);
  if (nullErr) {
    throw new Error(`disconnectUser: user nullify failed: ${nullErr.message}`);
  }
}
