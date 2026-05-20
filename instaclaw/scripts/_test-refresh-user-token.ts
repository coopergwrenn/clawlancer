#!/usr/bin/env tsx
/**
 * Tests for refreshUserToken — Day 16-18.
 *
 * Mock supabase + mock fetchImpl (for refreshAccessToken) + mock
 * lock acquire/release. Exercises the 7 main paths:
 *
 *   1. Lock contention → skipped_locked
 *   2. No refresh token → skipped_no_token
 *   3. Decrypt failure → decrypt_failure (no state change, no OpenAI call)
 *   4. Refresh succeeds → refreshed, version bumped, tokens encrypted+stored
 *   5. Refresh returns reused → lockout_disconnected (PERMANENT — Rule 53)
 *   6. Refresh returns revoked → lockout_disconnected, disconnectUser called
 *   7. Refresh returns other (transient) → transient_failure (no disconnect)
 *   8. Refresh succeeds BUT account_mismatch → lockout_disconnected
 *   9. Empty decrypted refresh token → decrypt_failure
 *
 * Run: npx tsx instaclaw/scripts/_test-refresh-user-token.ts
 */

const TEST_KEY = "a".repeat(64);
process.env.OPENAI_OAUTH_KEY_CURRENT = "v1";
process.env.OPENAI_OAUTH_KEY_V1 = TEST_KEY;

import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptSecret, decryptSecret } from "../lib/openai-oauth-encryption";
import { refreshUserToken } from "../lib/openai-oauth-db";

// ─── Harness ────────────────────────────────────────────────────────────

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

// ─── Mock Supabase (chainable enough for our calls) ─────────────────────

interface UserRow {
  id: string;
  openai_token_version?: number;
  openai_oauth_refresh_token?: string | null;
  openai_oauth_access_token?: string | null;
  openai_oauth_account_id?: string | null;
  openai_oauth_id_token_claims?: Record<string, unknown> | null;
}

interface MockSbOpts {
  user?: UserRow;
  userReadError?: { message: string };
  userUpdateError?: { message: string };
  vmUpdateError?: { message: string };
  /**
   * For the P1 disconnect-mid-refresh race test. When true, the user
   * UPDATE returns 0 rows (matches what PostgREST returns when the
   * `.not("openai_oauth_access_token", "is", null)` filter excludes
   * the row because disconnectUser nulled it between our read + write).
   */
  userUpdateReturnsZeroRows?: boolean;
}

function makeMockSb(opts: MockSbOpts) {
  const updates: { table: string; payload: Record<string, unknown> }[] = [];
  const sb = {
    from(table: string) {
      // method tracks the OPERATION kind (select / update / delete).
      // `.select()` after `.update()` is a returns-rows modifier, not
      // an operation switch — don't let it overwrite the locked-in
      // mutation method. Same pattern as the DB test mock.
      let method: "select" | "update" = "select";
      let methodLocked = false;
      const builder: Record<string, unknown> = {
        select() {
          if (!methodLocked) method = "select";
          return builder;
        },
        update(payload: Record<string, unknown>) {
          method = "update";
          methodLocked = true;
          updates.push({ table, payload });
          return builder;
        },
        eq() {
          return builder;
        },
        like() {
          return builder;
        },
        not() {
          return builder;
        },
        async single() {
          if (table === "instaclaw_users" && method === "select") {
            if (opts.userReadError) return { data: null, error: opts.userReadError };
            return { data: opts.user ?? null, error: opts.user ? null : { message: "no rows" } };
          }
          return { data: null, error: null };
        },
        then(resolve: (v: unknown) => void) {
          if (table === "instaclaw_users" && method === "update") {
            if (opts.userUpdateError) {
              return Promise.resolve({ data: null, error: opts.userUpdateError }).then(resolve);
            }
            // Conditional UPDATE with .select("id") returns array. When
            // the WHERE filter matches (no race), return [{id}]. When the
            // race lost (disconnect won), return [].
            const data = opts.userUpdateReturnsZeroRows ? [] : [{ id: opts.user?.id ?? "x" }];
            return Promise.resolve({ data, error: null }).then(resolve);
          }
          if (table === "instaclaw_vms" && method === "update") {
            if (opts.vmUpdateError) {
              return Promise.resolve({ data: null, error: opts.vmUpdateError }).then(resolve);
            }
            return Promise.resolve({ data: null, error: null }).then(resolve);
          }
          return Promise.resolve({ data: null, error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
  return { sb: sb as unknown as SupabaseClient, updates };
}

// ─── Helper — build a fake OpenAI /oauth/token response body ────────────

function buildJwtClaims(payload: object): string {
  // OpenAI's id_token format: header.body.sig with body being a JSON of
  // `{ "https://api.openai.com/auth": { ... } }` shape. parseJwtClaims
  // reads from that nested key. Construct a JWT that matches.
  const header = Buffer.from('{"alg":"RS256","typ":"JWT"}').toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": payload,
      exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    }),
  ).toString("base64url");
  return `${header}.${body}.sig`;
}

function makeRefreshSuccessFetch(opts: {
  accessToken: string;
  refreshToken: string;
  accountId?: string;
  planType?: string;
  expiresInSec?: number;
}): typeof fetch {
  return ((async () => {
    const idToken = buildJwtClaims({
      chatgpt_account_id: opts.accountId ?? "acct_default",
      chatgpt_plan_type: opts.planType ?? "pro",
      chatgpt_user_id: "user_default",
    });
    return new Response(
      JSON.stringify({
        access_token: opts.accessToken,
        refresh_token: opts.refreshToken,
        id_token: idToken,
        expires_in: opts.expiresInSec ?? 28 * 24 * 60 * 60,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown) as typeof fetch;
}

function makeRefreshFailFetch(errorCode: string): typeof fetch {
  return ((async () =>
    new Response(JSON.stringify({ error: { code: errorCode } }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    })) as unknown) as typeof fetch;
}

// ─── Lock stubs ─────────────────────────────────────────────────────────

function makeLockAcquired() {
  return {
    acquireLockImpl: async () => true,
    releaseLockImpl: async () => undefined,
  };
}
function makeLockDenied() {
  return {
    acquireLockImpl: async () => false,
    releaseLockImpl: async () => undefined,
  };
}

const USER_ID = "user-00000000-0000-0000-0000-000000000001";

// ─── Tests ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n=== refreshUserToken test suite ===\n");

  // 1. Lock contention
  console.log("1. Lock contention → skipped_locked:");
  {
    const { sb } = makeMockSb({});
    const result = await refreshUserToken(USER_ID, sb, makeLockDenied());
    assert(result.status === "skipped_locked", "status=skipped_locked");
  }

  // 2. No refresh token
  console.log("\n2. No refresh token → skipped_no_token:");
  {
    const { sb } = makeMockSb({
      user: { id: USER_ID, openai_oauth_refresh_token: null },
    });
    const result = await refreshUserToken(USER_ID, sb, makeLockAcquired());
    assert(result.status === "skipped_no_token", "status=skipped_no_token");
  }

  // 3. Decrypt failure (AAD mismatch — token encrypted under different userId)
  console.log("\n3. Decrypt failure → decrypt_failure:");
  {
    const wrongAadToken = encryptSecret("real-refresh-token", "different-user-id");
    const { sb } = makeMockSb({
      user: { id: USER_ID, openai_oauth_refresh_token: wrongAadToken },
    });
    const result = await refreshUserToken(USER_ID, sb, makeLockAcquired());
    assert(result.status === "decrypt_failure", "status=decrypt_failure");
    if (result.status === "decrypt_failure") {
      assert(result.message.includes("DecryptError"), "error message names DecryptError");
    }
  }

  // 4. Refresh succeeds → tokens stored, version bumped
  console.log("\n4. Refresh succeeds → refreshed:");
  {
    const NEW_ACCESS = "new.access.token";
    const NEW_REFRESH = "new.refresh.token";
    const oldRefresh = encryptSecret("old-refresh", USER_ID);
    const { sb, updates } = makeMockSb({
      user: {
        id: USER_ID,
        openai_token_version: 3,
        openai_oauth_refresh_token: oldRefresh,
        openai_oauth_account_id: "acct_x",
        // Use the SAME chatgpt_user_id as the fetch returns ("user_default")
        // so detectAccountMismatch doesn't fire on a non-mismatch case.
        // The actual mismatch path is exercised by test 8.
        openai_oauth_id_token_claims: { chatgpt_user_id: "user_default" },
      },
    });
    const result = await refreshUserToken(USER_ID, sb, {
      ...makeLockAcquired(),
      fetchImpl: makeRefreshSuccessFetch({
        accessToken: NEW_ACCESS,
        refreshToken: NEW_REFRESH,
        accountId: "acct_x",
        planType: "pro",
      }),
    });
    assert(result.status === "refreshed", "status=refreshed");
    if (result.status === "refreshed") {
      assert(result.newVersion === 4, "newVersion = 3 + 1 = 4");
      assert(result.planType === "pro", "planType=pro from id_token");
    }
    const userUpdate = updates.find((u) => u.table === "instaclaw_users");
    assert(!!userUpdate, "user row updated");
    if (userUpdate) {
      const newAccessEnc = userUpdate.payload.openai_oauth_access_token as string;
      const newRefreshEnc = userUpdate.payload.openai_oauth_refresh_token as string;
      assert(
        decryptSecret(newAccessEnc, USER_ID) === NEW_ACCESS,
        "new access token encrypted+stored with userId AAD",
      );
      assert(
        decryptSecret(newRefreshEnc, USER_ID) === NEW_REFRESH,
        "new refresh token encrypted+stored with userId AAD",
      );
      assert(userUpdate.payload.openai_token_version === 4, "openai_token_version set to 4");
      assert(userUpdate.payload.chatgpt_plan_type === "pro", "plan_type denormalized");
    }
  }

  // 5. Reused → PERMANENT lockout, disconnectUser called
  console.log("\n5. Refresh returns reused → lockout_disconnected (PERMANENT):");
  {
    const refresh = encryptSecret("refresh-bytes", USER_ID);
    const { sb, updates } = makeMockSb({
      user: {
        id: USER_ID,
        openai_token_version: 2,
        openai_oauth_refresh_token: refresh,
      },
    });
    const result = await refreshUserToken(USER_ID, sb, {
      ...makeLockAcquired(),
      fetchImpl: makeRefreshFailFetch("refresh_token_reused"),
    });
    assert(result.status === "lockout_disconnected", "status=lockout_disconnected");
    if (result.status === "lockout_disconnected") {
      assert(result.reason === "reused", "reason=reused");
    }
    // disconnectUser was called → expect user nullification updates
    const userNullUpdate = updates.find(
      (u) =>
        u.table === "instaclaw_users" &&
        u.payload.openai_oauth_access_token === null,
    );
    assert(!!userNullUpdate, "disconnectUser nullified user tokens");
  }

  // 6. Revoked → lockout_disconnected
  console.log("\n6. Refresh returns revoked → lockout_disconnected:");
  {
    const refresh = encryptSecret("rev-refresh", USER_ID);
    const { sb, updates } = makeMockSb({
      user: { id: USER_ID, openai_token_version: 1, openai_oauth_refresh_token: refresh },
    });
    const result = await refreshUserToken(USER_ID, sb, {
      ...makeLockAcquired(),
      fetchImpl: makeRefreshFailFetch("refresh_token_invalidated"),
    });
    assert(result.status === "lockout_disconnected", "status=lockout_disconnected");
    if (result.status === "lockout_disconnected") {
      assert(result.reason === "revoked", "reason=revoked");
    }
    assert(
      !!updates.find(
        (u) => u.table === "instaclaw_users" && u.payload.openai_oauth_access_token === null,
      ),
      "user disconnected on revoke",
    );
  }

  // 7. Other transient → transient_failure, no disconnect
  console.log("\n7. Refresh returns other → transient_failure (no disconnect):");
  {
    const refresh = encryptSecret("trans-refresh", USER_ID);
    const { sb, updates } = makeMockSb({
      user: { id: USER_ID, openai_token_version: 1, openai_oauth_refresh_token: refresh },
    });
    const result = await refreshUserToken(USER_ID, sb, {
      ...makeLockAcquired(),
      fetchImpl: makeRefreshFailFetch("rate_limited"),
    });
    assert(result.status === "transient_failure", "status=transient_failure");
    if (result.status === "transient_failure") {
      assert(result.reason === "other", "reason=other");
    }
    assert(
      !updates.find(
        (u) => u.table === "instaclaw_users" && u.payload.openai_oauth_access_token === null,
      ),
      "NO disconnect on transient (user keeps tokens, retry next cycle)",
    );
  }

  // 8. Success BUT account_mismatch → lockout_disconnected
  console.log("\n8. Refresh succeeds but account changed → lockout_disconnected:");
  {
    const oldRefresh = encryptSecret("old-refresh", USER_ID);
    const { sb, updates } = makeMockSb({
      user: {
        id: USER_ID,
        openai_token_version: 4,
        openai_oauth_refresh_token: oldRefresh,
        // Cached account on the user record
        openai_oauth_account_id: "acct_OLD",
        openai_oauth_id_token_claims: { chatgpt_user_id: "user_old" },
      },
    });
    const result = await refreshUserToken(USER_ID, sb, {
      ...makeLockAcquired(),
      // Refresh succeeds but with a DIFFERENT account_id in the id_token
      fetchImpl: makeRefreshSuccessFetch({
        accessToken: "new.access",
        refreshToken: "new.refresh",
        accountId: "acct_NEW", // mismatch!
        planType: "pro",
      }),
    });
    assert(result.status === "lockout_disconnected", "status=lockout_disconnected");
    if (result.status === "lockout_disconnected") {
      assert(result.reason === "account_mismatch", "reason=account_mismatch");
    }
    // disconnectUser called — user's tokens nulled
    assert(
      !!updates.find(
        (u) => u.table === "instaclaw_users" && u.payload.openai_oauth_access_token === null,
      ),
      "user disconnected on account mismatch",
    );
    // Critically: the NEW tokens should NOT have been stored (we got
    // new tokens from OpenAI but they belong to a different account,
    // we throw them away rather than store them).
    const storeUpdate = updates.find(
      (u) =>
        u.table === "instaclaw_users" &&
        typeof u.payload.openai_oauth_access_token === "string" &&
        u.payload.openai_oauth_access_token !== null,
    );
    assert(!storeUpdate, "NEW tokens from mismatched account NOT stored");
  }

  // 9. Empty decrypted refresh token → decrypt_failure
  console.log("\n9. Empty decrypted refresh token → decrypt_failure:");
  {
    const emptyRefresh = encryptSecret("", USER_ID); // valid encrypt of empty string
    const { sb } = makeMockSb({
      user: { id: USER_ID, openai_oauth_refresh_token: emptyRefresh },
    });
    const result = await refreshUserToken(USER_ID, sb, makeLockAcquired());
    assert(result.status === "decrypt_failure", "status=decrypt_failure");
    if (result.status === "decrypt_failure") {
      assert(result.message.includes("empty"), "error message mentions empty");
    }
  }

  // ─── Test 10: P1 race — disconnect won mid-refresh ─────────────────────
  // Trace: cron locks user, reads refresh_token X, calls OpenAI, gets new
  // tokens Y. Meanwhile user clicks Disconnect via modal (NOT gated on
  // cron lock — disconnect must always work). disconnectUser nulls
  // user.access_token. Cron tries to UPDATE with the new tokens, but
  // WHERE openai_oauth_access_token IS NOT NULL excludes the row (now
  // null) → 0 rows affected → return skipped_disconnected_mid_refresh.
  // New tokens are orphaned at OpenAI — acceptable (user wanted to
  // disconnect).
  console.log("\n10. Disconnect won race mid-refresh → skipped_disconnected_mid_refresh:");
  {
    const oldRefresh = encryptSecret("about-to-be-orphaned", USER_ID);
    const { sb, updates } = makeMockSb({
      user: {
        id: USER_ID,
        openai_token_version: 5,
        openai_oauth_refresh_token: oldRefresh,
        openai_oauth_account_id: "acct_default",
        openai_oauth_id_token_claims: { chatgpt_user_id: "user_default" },
      },
      userUpdateReturnsZeroRows: true, // simulates the race: disconnect won
    });
    const result = await refreshUserToken(USER_ID, sb, {
      ...makeLockAcquired(),
      fetchImpl: makeRefreshSuccessFetch({
        accessToken: "new.but.orphaned.access",
        refreshToken: "new.but.orphaned.refresh",
        accountId: "acct_default",
        planType: "pro",
      }),
    });
    assert(
      result.status === "skipped_disconnected_mid_refresh",
      "status=skipped_disconnected_mid_refresh — orphaned tokens NOT stored",
    );
    // disconnectUser should NOT have been called (the user already
    // disconnected themselves; calling disconnectUser again would be a
    // no-op but wasteful). Verify: the only update in flight is the
    // conditional one that returned 0 rows.
    const disconnectUpdate = updates.find(
      (u) =>
        u.table === "instaclaw_users" && u.payload.openai_oauth_access_token === null,
    );
    assert(
      !disconnectUpdate,
      "disconnectUser NOT called (user already disconnected themselves)",
    );
  }

  // ─── Test 11: P3 edge — account_mismatch with NULL new claims ──────────
  // detectAccountMismatch handles a degenerate id_token correctly: if
  // newClaims is null OR returns no chatgpt_user_id/account_id fields,
  // it returns null (no mismatch) rather than triggering a false
  // disconnect. Verifies the guard at lines 696, 702, 705 of openai-oauth.ts.
  console.log("\n11. Refresh succeeds but id_token has NO claims fields → no false mismatch:");
  {
    const oldRefresh = encryptSecret("ok-refresh", USER_ID);
    const { sb, updates } = makeMockSb({
      user: {
        id: USER_ID,
        openai_token_version: 1,
        openai_oauth_refresh_token: oldRefresh,
        openai_oauth_account_id: "acct_old",
        openai_oauth_id_token_claims: { chatgpt_user_id: "user_old" },
      },
    });
    // Build a fetchImpl that returns a SUCCESS body but with an id_token
    // whose claims are completely empty (no account_id, no user_id).
    // detectAccountMismatch should return null (graceful), and the
    // refresh should succeed.
    const fetchImpl = ((async () => {
      const header = Buffer.from('{"alg":"RS256","typ":"JWT"}').toString("base64url");
      const body = Buffer.from(
        JSON.stringify({
          "https://api.openai.com/auth": {}, // empty claims
          exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        }),
      ).toString("base64url");
      const idToken = `${header}.${body}.sig`;
      return new Response(
        JSON.stringify({
          access_token: "new.access.empty.claims",
          refresh_token: "new.refresh.empty.claims",
          id_token: idToken,
          expires_in: 30 * 24 * 60 * 60,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown) as typeof fetch;
    const result = await refreshUserToken(USER_ID, sb, { ...makeLockAcquired(), fetchImpl });
    assert(
      result.status === "refreshed",
      "status=refreshed — empty claims should NOT trigger false mismatch",
    );
    // Verify the cached account_id was preserved (newClaims had no
    // chatgptAccountId, our fallback to cachedAccountId fires).
    const userUpdate = updates.find((u) => u.table === "instaclaw_users");
    assert(
      !!userUpdate && userUpdate.payload.openai_oauth_account_id === "acct_old",
      "cached account_id preserved when new id_token has no chatgpt_account_id",
    );
  }

  // ─── Summary ───────────────────────────────────────────────────────────
  console.log(`\n=== Results ===`);
  console.log(`PASS: ${pass}`);
  console.log(`FAIL: ${fail}`);
  if (failures.length > 0) {
    console.log(`\nFailures:`);
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("UNCAUGHT:", err);
  process.exit(1);
});
