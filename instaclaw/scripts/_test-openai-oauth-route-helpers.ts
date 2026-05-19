#!/usr/bin/env tsx
/**
 * Tests for lib/openai-oauth-route-helpers.ts:
 *   - validatePollRequestBody (P1-A body guard)
 *   - decideStartAction (P1-B decision order)
 *
 * Strategy: pure functions for body validation (no DB), programmable
 * Supabase mock for the decision tree. Mirrors the mock pattern from
 * _test-openai-oauth-db.ts but more focused (only 2 helpers under test).
 *
 * Run: npx tsx instaclaw/scripts/_test-openai-oauth-route-helpers.ts
 */

// Set encryption env before any module load (decideStartAction's downstream
// helpers don't actually use encryption, but storeOAuthTokens is in the
// same module and gets type-checked at import time — not at call time, so
// this is defensive only).
process.env.OPENAI_OAUTH_KEY_CURRENT = "v1";
process.env.OPENAI_OAUTH_KEY_V1 = "a".repeat(64);

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  validatePollRequestBody,
  decideStartAction,
} from "../lib/openai-oauth-route-helpers";

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

// Minimal supabase-client mock that supports the chain shape used by
// getConnectedSummary + getFreshPendingFlow. Lifted from
// _test-openai-oauth-db.ts in pattern. Tightened: only handles the
// methods the helpers under test actually call.
type Responder = () => { data?: unknown; error?: { code?: string; message: string } | null };
function makeMockSupabase(responders: Record<string, Responder>): SupabaseClient {
  function makeBuilder(table: string): unknown {
    let method = "select";
    let methodLocked = false;
    const builder: Record<string, unknown> = {
      select() {
        if (!methodLocked) method = "select";
        return builder;
      },
      insert() {
        method = "insert";
        methodLocked = true;
        return builder;
      },
      update() {
        method = "update";
        methodLocked = true;
        return builder;
      },
      eq() {
        return builder;
      },
      gt() {
        return builder;
      },
      like() {
        return builder;
      },
      limit() {
        return builder;
      },
      single() {
        const responder = responders[`${table}.${method}`] ?? (() => ({ data: null, error: null }));
        return Promise.resolve(responder());
      },
      maybeSingle() {
        const responder = responders[`${table}.${method}`] ?? (() => ({ data: null, error: null }));
        return Promise.resolve(responder());
      },
      then(resolve: (v: unknown) => void) {
        const responder = responders[`${table}.${method}`] ?? (() => ({ data: null, error: null }));
        return Promise.resolve(responder()).then(resolve);
      },
    };
    return builder;
  }
  return { from: (table: string) => makeBuilder(table) } as unknown as SupabaseClient;
}

const USER_ID = "user-decide-test";

// ─── Tests ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {

console.log("\n=== openai-oauth-route-helpers test suite ===\n");

// ─── validatePollRequestBody (P1-A) ──────────────────────────────────────
console.log("1. validatePollRequestBody — null/undefined:");
{
  const r = validatePollRequestBody(null);
  assert(r.ok === false, "null body → ok=false");
  if (!r.ok) assert(/null|undefined/i.test(r.message), "null body → message mentions null");
}
{
  const r = validatePollRequestBody(undefined);
  assert(r.ok === false, "undefined body → ok=false");
}

console.log("\n2. validatePollRequestBody — wrong types:");
{
  const r = validatePollRequestBody([1, 2, 3]);
  assert(r.ok === false, "array body → ok=false");
  if (!r.ok) assert(/array/i.test(r.message), "array body → message mentions array");
}
{
  const r = validatePollRequestBody("just a string");
  assert(r.ok === false, "string body → ok=false");
  if (!r.ok) assert(/string/.test(r.message), "string body → message mentions string");
}
{
  const r = validatePollRequestBody(42);
  assert(r.ok === false, "number body → ok=false");
}
{
  const r = validatePollRequestBody(true);
  assert(r.ok === false, "boolean body → ok=false");
}

console.log("\n3. validatePollRequestBody — missing/bad flow_id:");
{
  const r = validatePollRequestBody({});
  assert(r.ok === false, "missing flow_id → ok=false");
  if (!r.ok) assert(/flow_id.*required/i.test(r.message), "missing flow_id → helpful message");
}
{
  const r = validatePollRequestBody({ flow_id: 12345 });
  assert(r.ok === false, "non-string flow_id → ok=false");
  if (!r.ok) assert(/flow_id.*string/i.test(r.message), "non-string flow_id → message mentions string");
}
{
  const r = validatePollRequestBody({ flow_id: "" });
  assert(r.ok === false, "empty flow_id → ok=false");
  if (!r.ok) assert(/non-empty/i.test(r.message), "empty flow_id → message says non-empty");
}
{
  const r = validatePollRequestBody({ flow_id: null });
  assert(r.ok === false, "null flow_id → ok=false");
}

console.log("\n4. validatePollRequestBody — happy path:");
{
  const r = validatePollRequestBody({ flow_id: "abc-uuid-123" });
  assert(r.ok === true, "valid flow_id → ok=true");
  if (r.ok) assert(r.flowId === "abc-uuid-123", "valid flow_id → flowId preserved");
}
{
  // Extra fields are ignored — don't reject the request just because the
  // browser sent extra data along with flow_id.
  const r = validatePollRequestBody({ flow_id: "abc", extra_data: "ignored" });
  assert(r.ok === true, "extra fields ignored");
}

// ─── decideStartAction (P1-B) ────────────────────────────────────────────
console.log("\n5. decideStartAction — connected wins over pending:");
{
  // THE specific scenario P1-B exists to fix: user has tokens AND a
  // pending flow row (orphan from a previous mark-completed failure).
  // Connected must win, regardless of the pending row.
  const sb = makeMockSupabase({
    "instaclaw_users.select": () => ({
      data: {
        openai_oauth_access_token: "v1$encrypted-bytes",
        openai_oauth_expires_at: "2027-01-01T00:00:00Z",
        openai_oauth_id_token_claims: { email: "user@example.com" },
        openai_oauth_account_id: "acct_x",
        chatgpt_plan_type: "pro",
      },
      error: null,
    }),
    "instaclaw_oauth_device_flows.select": () => ({
      data: {
        id: "orphan-flow-id",
        user_id: USER_ID,
        provider: "openai_codex",
        device_auth_id: "d",
        user_code: "U",
        verification_uri: "v",
        interval_seconds: 5,
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        status: "pending",
        status_message: null,
        completed_at: null,
        created_at: new Date().toISOString(),
      },
      error: null,
    }),
  });
  const result = await decideStartAction(USER_ID, sb);
  assert(result.kind === "already_connected", "connected + pending → already_connected (P1-B)");
  if (result.kind === "already_connected") {
    assert(result.summary.connected === true, "summary.connected is true");
    assert(result.summary.email === "user@example.com", "summary includes email");
    assert(result.summary.planType === "pro", "summary includes plan type");
  }
}

console.log("\n6. decideStartAction — connected only:");
{
  const sb = makeMockSupabase({
    "instaclaw_users.select": () => ({
      data: {
        openai_oauth_access_token: "v1$encrypted",
        openai_oauth_id_token_claims: { email: "u@y.com" },
      },
      error: null,
    }),
    // No pending row.
    "instaclaw_oauth_device_flows.select": () => ({ data: null, error: null }),
  });
  const result = await decideStartAction(USER_ID, sb);
  assert(result.kind === "already_connected", "connected only → already_connected");
}

console.log("\n7. decideStartAction — pending only (not connected):");
{
  const sb = makeMockSupabase({
    "instaclaw_users.select": () => ({
      // No access token.
      data: { openai_oauth_access_token: null },
      error: null,
    }),
    "instaclaw_oauth_device_flows.select": () => ({
      data: {
        id: "fresh-flow",
        user_id: USER_ID,
        provider: "openai_codex",
        device_auth_id: "d",
        user_code: "U",
        verification_uri: "v",
        interval_seconds: 5,
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        status: "pending",
        status_message: null,
        completed_at: null,
        created_at: new Date().toISOString(),
      },
      error: null,
    }),
  });
  const result = await decideStartAction(USER_ID, sb);
  assert(result.kind === "reuse_pending", "pending only → reuse_pending");
  if (result.kind === "reuse_pending") {
    assert(result.flow.id === "fresh-flow", "returns the existing pending flow");
  }
}

console.log("\n8. decideStartAction — neither (mint new):");
{
  const sb = makeMockSupabase({
    "instaclaw_users.select": () => ({
      data: { openai_oauth_access_token: null },
      error: null,
    }),
    "instaclaw_oauth_device_flows.select": () => ({ data: null, error: null }),
  });
  const result = await decideStartAction(USER_ID, sb);
  assert(result.kind === "mint_new", "neither connected nor pending → mint_new");
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
  console.error("UNCAUGHT:", err);
  process.exit(1);
});
