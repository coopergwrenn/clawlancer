#!/usr/bin/env tsx
/**
 * Tests for lib/openai-oauth-db.ts — the DB helper layer that backs the
 * /api/auth/openai/* routes and the kill-switch cron.
 *
 * Strategy: programmable Supabase mock that captures every method call
 * into a log, plus fixture responses keyed by (table, method) pairs.
 * No real network, no real Supabase. Real encryption (lib/openai-oauth-encryption
 * with test keys).
 *
 * Run: npx tsx instaclaw/scripts/_test-openai-oauth-db.ts
 */

// Set env BEFORE importing modules that read it at top level.
process.env.OPENAI_OAUTH_KEY_CURRENT = "v1";
process.env.OPENAI_OAUTH_KEY_V1 = "a".repeat(64);

import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptSecret } from "../lib/openai-oauth-encryption";
import type { DeviceCodePoll, DeviceCodeStart } from "../lib/openai-oauth";
import {
  createOrReuseDeviceFlow,
  disconnectUser,
  getConnectedSummary,
  getDeviceFlow,
  getFreshPendingFlow,
  markDeviceFlowCompleted,
  markDeviceFlowFailed,
  storeOAuthTokens,
} from "../lib/openai-oauth-db";

// ─── Test harness ────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
const failures: string[] = [];

function assert(cond: boolean, label: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  ✗ ${label}`);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ─── Mock Supabase ───────────────────────────────────────────────────────

interface MockCall {
  table: string;
  method: string;
  args: unknown[];
}

type Responder = (call: MockCall, allCalls: MockCall[]) =>
  | { data?: unknown; error?: { code?: string; message: string } | null }
  | Promise<{ data?: unknown; error?: { code?: string; message: string } | null }>;

function makeMockSupabase(responders: Record<string, Responder>) {
  const calls: MockCall[] = [];

  function makeBuilder(table: string): unknown {
    // `method` tracks the OPERATION kind (insert/update/delete/select).
    // PostgREST builder chains like `.insert(p).select("*").single()` have
    // the OPERATION set by .insert(), with .select() just declaring what
    // to return. So .select() must NOT overwrite a prior mutation.
    let method = "select";
    let methodLocked = false;
    const args: unknown[] = [];
    const builder: Record<string, unknown> = {
      select(...a: unknown[]) {
        if (!methodLocked) method = "select";
        args.push({ select: a });
        return builder;
      },
      insert(...a: unknown[]) {
        method = "insert";
        methodLocked = true;
        args.push({ insert: a });
        return builder;
      },
      update(...a: unknown[]) {
        method = "update";
        methodLocked = true;
        args.push({ update: a });
        return builder;
      },
      delete(...a: unknown[]) {
        method = "delete";
        methodLocked = true;
        args.push({ delete: a });
        return builder;
      },
      eq(...a: unknown[]) {
        args.push({ eq: a });
        return builder;
      },
      gt(...a: unknown[]) {
        args.push({ gt: a });
        return builder;
      },
      like(...a: unknown[]) {
        args.push({ like: a });
        return builder;
      },
      limit(...a: unknown[]) {
        args.push({ limit: a });
        return builder;
      },
      single() {
        const call: MockCall = { table, method, args: [...args, { _terminator: "single" }] };
        calls.push(call);
        const responder = responders[`${table}.${method}`] ?? defaultEmpty;
        return Promise.resolve(responder(call, calls));
      },
      maybeSingle() {
        const call: MockCall = { table, method, args: [...args, { _terminator: "maybeSingle" }] };
        calls.push(call);
        const responder = responders[`${table}.${method}`] ?? defaultEmpty;
        return Promise.resolve(responder(call, calls));
      },
      then(resolve: (v: unknown) => void) {
        // Some chains terminate on `.eq()` or `.like()` (update statements
        // without a select/single). Resolve as { error: null } by default.
        const call: MockCall = { table, method, args };
        calls.push(call);
        const responder = responders[`${table}.${method}`] ?? defaultEmpty;
        return Promise.resolve(responder(call, calls)).then(resolve);
      },
    };
    return builder;
  }

  function defaultEmpty(): { data: null; error: null } {
    return { data: null, error: null };
  }

  const sb = {
    from(table: string) {
      return makeBuilder(table);
    },
  } as unknown as SupabaseClient;

  return { sb, calls };
}

// ─── Tests ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {

console.log("\n=== openai-oauth-db test suite ===\n");

const USER_ID = "user-abc-123";

// 1. storeOAuthTokens — round-trip encryption, all fields, version bump
console.log("1. storeOAuthTokens:");
{
  const completed: Extract<DeviceCodePoll, { status: "completed" }> = {
    status: "completed",
    tokens: {
      accessToken: "eyJ.access.JWT.value.bytes",
      refreshToken: "rt_secret_refresh_value_bytes",
      idToken: "eyJ.id.JWT.value",
      expiresAtMs: Date.now() + 28 * 24 * 60 * 60 * 1000,
    },
    claims: {
      email: "test@example.com",
      chatgptPlanType: "pro",
      chatgptAccountId: "acct_abc",
      chatgptUserId: "user_xyz",
      exp: Math.floor(Date.now() / 1000) + 28 * 24 * 60 * 60,
    },
  };

  let captured: Record<string, unknown> | null = null;
  const { sb, calls } = makeMockSupabase({
    "instaclaw_users.select": () => ({
      data: { id: USER_ID, openai_token_version: 5, openai_oauth_originator: null },
      error: null,
    }),
    "instaclaw_users.update": (call) => {
      // First arg in args[] is { update: [payload] }; capture for assertions.
      const updateArg = (call.args[0] as { update: [Record<string, unknown>] }).update[0];
      captured = updateArg;
      return { data: null, error: null };
    },
  });

  const result = await storeOAuthTokens(USER_ID, completed, sb);
  assert(result.tokenVersion === 6, "version bumped from 5 to 6");
  assert(result.planType === "pro", "plan type returned");
  assert(captured !== null, "user update captured");
  assert(
    typeof (captured as Record<string, unknown>).openai_oauth_access_token === "string" &&
      (captured as Record<string, unknown>).openai_oauth_access_token !== completed.tokens.accessToken,
    "access token is encrypted (not stored plaintext)",
  );
  assert(
    String((captured as Record<string, unknown>).openai_oauth_access_token).startsWith("v1$"),
    "access token has v1 key-version prefix",
  );
  const decryptedAccess = decryptSecret(
    String((captured as Record<string, unknown>).openai_oauth_access_token),
  );
  assert(decryptedAccess === completed.tokens.accessToken, "access token decrypts to original");
  const decryptedRefresh = decryptSecret(
    String((captured as Record<string, unknown>).openai_oauth_refresh_token),
  );
  assert(decryptedRefresh === completed.tokens.refreshToken, "refresh token decrypts to original");
  assert(
    (captured as Record<string, unknown>).chatgpt_plan_type === "pro",
    "denormalized plan_type written",
  );
  assert(
    (captured as Record<string, unknown>).openai_oauth_account_id === "acct_abc",
    "denormalized account_id written",
  );
  assert(
    (captured as Record<string, unknown>).openai_token_version === 6,
    "openai_token_version persisted as 6",
  );
  const claimsJson = (captured as Record<string, unknown>).openai_oauth_id_token_claims as Record<
    string,
    unknown
  >;
  assert(claimsJson.chatgpt_plan_type === "pro", "JSONB claims use snake_case (chatgpt_plan_type)");
  assert(claimsJson.email === "test@example.com", "JSONB claims include email");
  assert(claims_has_originator(captured as Record<string, unknown>), "originator computed when null");
  assert(calls.length === 2, "exactly one read + one update (no extra queries)");
}

function claims_has_originator(p: Record<string, unknown>): boolean {
  const v = p.openai_oauth_originator;
  return typeof v === "string" && v.startsWith("instaclaw-") && v.length > "instaclaw-".length;
}

// 2. storeOAuthTokens — throws on read failure
console.log("\n2. storeOAuthTokens read failure:");
{
  const completed: Extract<DeviceCodePoll, { status: "completed" }> = {
    status: "completed",
    tokens: {
      accessToken: "a",
      refreshToken: "r",
      idToken: "i",
      expiresAtMs: Date.now() + 1000,
    },
    claims: null,
  };
  const { sb } = makeMockSupabase({
    "instaclaw_users.select": () => ({ data: null, error: { message: "RLS denied" } }),
  });
  let threw: string | null = null;
  try {
    await storeOAuthTokens(USER_ID, completed, sb);
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  assert(threw !== null, "throws when user read fails");
  assert(threw?.includes("RLS denied") ?? false, "error message preserves underlying cause");
}

// 3. createOrReuseDeviceFlow — happy path INSERT
console.log("\n3. createOrReuseDeviceFlow happy path:");
{
  const started: DeviceCodeStart = {
    userCode: "92PM-PLU8N",
    deviceAuthId: "dauth_abc",
    verificationUri: "https://auth.openai.com/codex/device",
    intervalMs: 5000,
    expiresInMs: 15 * 60 * 1000,
  };
  let insertPayload: Record<string, unknown> | null = null;
  const { sb } = makeMockSupabase({
    "instaclaw_oauth_device_flows.insert": (call) => {
      insertPayload = (call.args[0] as { insert: [Record<string, unknown>] }).insert[0];
      return {
        data: {
          id: "flow-uuid-1",
          user_id: USER_ID,
          provider: "openai_codex",
          device_auth_id: started.deviceAuthId,
          user_code: started.userCode,
          verification_uri: started.verificationUri,
          interval_seconds: 5,
          expires_at: new Date(Date.now() + started.expiresInMs).toISOString(),
          status: "pending",
          status_message: null,
          completed_at: null,
          created_at: new Date().toISOString(),
        },
        error: null,
      };
    },
  });

  const row = await createOrReuseDeviceFlow(USER_ID, started, sb);
  assert(row.id === "flow-uuid-1", "returns inserted row");
  assert(row.status === "pending", "row status is pending");
  assert(insertPayload !== null, "insert called");
  assert(
    (insertPayload as Record<string, unknown>).interval_seconds === 5,
    "interval_seconds = round(intervalMs/1000)",
  );
  assert(
    (insertPayload as Record<string, unknown>).user_id === USER_ID,
    "user_id included in insert",
  );
}

// 4. createOrReuseDeviceFlow — 23505 race, fallback to SELECT
console.log("\n4. createOrReuseDeviceFlow 23505 race fallback:");
{
  const started: DeviceCodeStart = {
    userCode: "ABCD-1234",
    deviceAuthId: "dauth_race",
    verificationUri: "https://auth.openai.com/codex/device",
    intervalMs: 5000,
    expiresInMs: 15 * 60 * 1000,
  };
  const existingRow = {
    id: "flow-existing",
    user_id: USER_ID,
    provider: "openai_codex",
    device_auth_id: "dauth_existing",
    user_code: "EXIS-TING0",
    verification_uri: started.verificationUri,
    interval_seconds: 5,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    status: "pending" as const,
    status_message: null,
    completed_at: null,
    created_at: new Date(Date.now() - 60_000).toISOString(),
  };
  const { sb } = makeMockSupabase({
    "instaclaw_oauth_device_flows.insert": () => ({
      data: null,
      error: { code: "23505", message: "duplicate key value violates unique constraint" },
    }),
    "instaclaw_oauth_device_flows.select": () => ({ data: existingRow, error: null }),
  });

  const row = await createOrReuseDeviceFlow(USER_ID, started, sb);
  assert(row.id === "flow-existing", "returns existing pending row on race");
  assert(row.device_auth_id === "dauth_existing", "preserves existing device_auth_id (not the new one)");
}

// 5. createOrReuseDeviceFlow — non-23505 insert error throws
console.log("\n5. createOrReuseDeviceFlow non-race error:");
{
  const started: DeviceCodeStart = {
    userCode: "x",
    deviceAuthId: "x",
    verificationUri: "x",
    intervalMs: 5000,
    expiresInMs: 1000,
  };
  const { sb } = makeMockSupabase({
    "instaclaw_oauth_device_flows.insert": () => ({
      data: null,
      error: { code: "42P01", message: "relation does not exist" },
    }),
  });
  let threw: string | null = null;
  try {
    await createOrReuseDeviceFlow(USER_ID, started, sb);
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  assert(threw !== null, "throws on non-unique error");
  assert(threw?.includes("relation does not exist") ?? false, "preserves underlying error");
}

// 6. getFreshPendingFlow — found
console.log("\n6. getFreshPendingFlow found:");
{
  const fresh = {
    id: "flow-fresh",
    user_id: USER_ID,
    provider: "openai_codex",
    device_auth_id: "d",
    user_code: "U",
    verification_uri: "v",
    interval_seconds: 5,
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    status: "pending" as const,
    status_message: null,
    completed_at: null,
    created_at: new Date().toISOString(),
  };
  const { sb, calls } = makeMockSupabase({
    "instaclaw_oauth_device_flows.select": () => ({ data: fresh, error: null }),
  });
  const row = await getFreshPendingFlow(USER_ID, sb);
  assert(row !== null, "returns row when fresh");
  assert(row?.id === "flow-fresh", "correct row id");
  // Confirm the .gt filter was applied (Phase 1 contract: must filter expires_at > now).
  const selectCall = calls.find((c) => c.method === "select");
  const hasGt = selectCall?.args.some(
    (a) => typeof a === "object" && a !== null && "gt" in a,
  );
  assert(!!hasGt, "select chain includes .gt() for expires_at");
}

// 7. getFreshPendingFlow — not found (PostgREST returns null)
console.log("\n7. getFreshPendingFlow not found:");
{
  const { sb } = makeMockSupabase({
    "instaclaw_oauth_device_flows.select": () => ({ data: null, error: null }),
  });
  const row = await getFreshPendingFlow(USER_ID, sb);
  assert(row === null, "returns null when no pending flow");
}

// 8. getDeviceFlow — scoped to user_id
console.log("\n8. getDeviceFlow scopes by user_id:");
{
  let capturedEqs: unknown[] = [];
  const { sb } = makeMockSupabase({
    "instaclaw_oauth_device_flows.select": (call) => {
      capturedEqs = call.args.filter(
        (a) => typeof a === "object" && a !== null && "eq" in (a as object),
      );
      return { data: null, error: null };
    },
  });
  await getDeviceFlow("flow-abc", USER_ID, sb);
  const hasIdEq = capturedEqs.some((a) => deepEqual(a, { eq: ["id", "flow-abc"] }));
  const hasUserEq = capturedEqs.some((a) => deepEqual(a, { eq: ["user_id", USER_ID] }));
  assert(hasIdEq, "filters on id");
  assert(hasUserEq, "filters on user_id (ownership scoping)");
}

// 9. markDeviceFlowCompleted — writes correct fields
console.log("\n9. markDeviceFlowCompleted:");
{
  let updatePayload: Record<string, unknown> | null = null;
  const { sb } = makeMockSupabase({
    "instaclaw_oauth_device_flows.update": (call) => {
      updatePayload = (call.args[0] as { update: [Record<string, unknown>] }).update[0];
      return { data: null, error: null };
    },
  });
  await markDeviceFlowCompleted("flow-1", sb);
  assert((updatePayload as Record<string, unknown> | null)?.status === "completed", "status=completed");
  assert(
    typeof (updatePayload as Record<string, unknown> | null)?.completed_at === "string",
    "completed_at is set",
  );
  assert(
    (updatePayload as Record<string, unknown> | null)?.status_message === null,
    "status_message cleared",
  );
}

// 10. markDeviceFlowFailed — expired status
console.log("\n10. markDeviceFlowFailed expired:");
{
  let updatePayload: Record<string, unknown> | null = null;
  const { sb } = makeMockSupabase({
    "instaclaw_oauth_device_flows.update": (call) => {
      updatePayload = (call.args[0] as { update: [Record<string, unknown>] }).update[0];
      return { data: null, error: null };
    },
  });
  await markDeviceFlowFailed("flow-2", "expired", null, sb);
  assert((updatePayload as Record<string, unknown> | null)?.status === "expired", "status=expired");
  assert(
    (updatePayload as Record<string, unknown> | null)?.status_message === null,
    "no message for expired",
  );
}

// 11. markDeviceFlowFailed — error with message
console.log("\n11. markDeviceFlowFailed error with message:");
{
  let updatePayload: Record<string, unknown> | null = null;
  const { sb } = makeMockSupabase({
    "instaclaw_oauth_device_flows.update": (call) => {
      updatePayload = (call.args[0] as { update: [Record<string, unknown>] }).update[0];
      return { data: null, error: null };
    },
  });
  await markDeviceFlowFailed("flow-3", "error", "OpenAI returned 500", sb);
  assert((updatePayload as Record<string, unknown> | null)?.status === "error", "status=error");
  assert(
    (updatePayload as Record<string, unknown> | null)?.status_message === "OpenAI returned 500",
    "status_message preserved",
  );
}

// 12. disconnectUser — three writes in order
console.log("\n12. disconnectUser three-step:");
{
  const writeLog: string[] = [];
  let userUpdatePayload: Record<string, unknown> | null = null;
  const { sb } = makeMockSupabase({
    "instaclaw_vms.update": (call) => {
      const payload = (call.args[0] as { update: [Record<string, unknown>] }).update[0];
      if (payload.api_mode === "all_inclusive") writeLog.push("vm.api_mode");
      if (payload.default_model === "claude-sonnet-4-6") writeLog.push("vm.default_model");
      return { data: null, error: null };
    },
    "instaclaw_users.select": () => ({
      data: { openai_token_version: 7 },
      error: null,
    }),
    "instaclaw_users.update": (call) => {
      userUpdatePayload = (call.args[0] as { update: [Record<string, unknown>] }).update[0];
      writeLog.push("user.nullify");
      return { data: null, error: null };
    },
  });

  await disconnectUser(USER_ID, sb);
  assert(writeLog[0] === "vm.api_mode", "step 1: VM api_mode reset");
  assert(writeLog[1] === "vm.default_model", "step 2: VM default_model reset");
  assert(writeLog[2] === "user.nullify", "step 3: user fields nullified");
  assert(
    (userUpdatePayload as Record<string, unknown> | null)?.openai_oauth_access_token === null,
    "access_token nulled",
  );
  assert(
    (userUpdatePayload as Record<string, unknown> | null)?.openai_oauth_refresh_token === null,
    "refresh_token nulled",
  );
  assert(
    (userUpdatePayload as Record<string, unknown> | null)?.openai_token_version === 8,
    "version bumped from 7 to 8",
  );
  assert(
    (userUpdatePayload as Record<string, unknown> | null)?.chatgpt_plan_type === null,
    "plan_type cleared",
  );
}

// 13. disconnectUser — error in any step aborts (vm api_mode failure)
console.log("\n13. disconnectUser aborts on vm error:");
{
  const { sb } = makeMockSupabase({
    "instaclaw_vms.update": () => ({
      data: null,
      error: { message: "constraint violation" },
    }),
  });
  let threw: string | null = null;
  try {
    await disconnectUser(USER_ID, sb);
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  assert(threw !== null, "throws on vm update failure");
  assert(threw?.includes("constraint violation") ?? false, "error preserved");
}

// 14. getConnectedSummary — connected
console.log("\n14. getConnectedSummary connected:");
{
  const { sb } = makeMockSupabase({
    "instaclaw_users.select": () => ({
      data: {
        openai_oauth_access_token: "v1$some-encrypted",
        openai_oauth_expires_at: "2026-12-31T00:00:00Z",
        openai_oauth_id_token_claims: { email: "x@y.com" },
        openai_oauth_account_id: "acct_42",
        chatgpt_plan_type: "pro",
      },
      error: null,
    }),
  });
  const s = await getConnectedSummary(USER_ID, sb);
  assert(s.connected === true, "connected when access_token set");
  assert(s.email === "x@y.com", "email from claims");
  assert(s.planType === "pro", "plan_type denormalized field");
  assert(s.accountId === "acct_42", "accountId from row");
}

// 15. getConnectedSummary — not connected
console.log("\n15. getConnectedSummary not connected:");
{
  const { sb } = makeMockSupabase({
    "instaclaw_users.select": () => ({
      data: {
        openai_oauth_access_token: null,
        openai_oauth_expires_at: null,
        chatgpt_plan_type: null,
      },
      error: null,
    }),
  });
  const s = await getConnectedSummary(USER_ID, sb);
  assert(s.connected === false, "connected=false when access_token NULL");
  assert(s.email === undefined, "no email when not connected");
  assert(s.planType === undefined, "no plan when not connected");
}

// ─── Summary ─────────────────────────────────────────────────────────────
console.log(`\n=== Results ===`);
console.log(`PASS: ${pass}`);
console.log(`FAIL: ${fail}`);
if (failures.length > 0) {
  console.log(`\nFailures:`);
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail === 0 ? 0 : 1);

} // end main

main().catch((err) => {
  console.error("Unhandled error in test main:", err);
  process.exit(1);
});
