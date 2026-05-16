/**
 * Synthetic test for lib/createUserVM.ts::assignOrProvisionUserVm.
 *
 * Tests cover:
 *   1. Flag off → pool path (calls injected pool fn, returns path="pool")
 *   2. Flag off + pool empty → returns null
 *   3. Flag on + complete pending_users → cloud-init path (calls createUserVM)
 *   4. Flag on + missing pending_users row → throws with clear error
 *   5. Flag on + pending exists but telegram_bot_token NULL → throws
 *   6. Flag on + pending exists but telegram_bot_username NULL → throws
 *   7. Flag on + partner set on instaclaw_users → propagates to createUserVM params
 *   8. Flag on + createUserVM throws → wrapper re-throws (caller's try/catch handles)
 *   9. Uniform result shape (path discriminator, vm.id, vm.ip_address) across both paths
 *
 * No real Linode / Supabase calls — all deps injected.
 *
 * Run: npx tsx scripts/_test-assignOrProvisionUserVm.ts
 */
import { readFileSync } from "fs";

// ── Env loading (Rule 18) — defensive; tests pass flag explicitly via deps ──
for (const f of ["/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local"]) {
  try {
    const env = readFileSync(f, "utf-8");
    for (const l of env.split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch { /* skip */ }
}
// CRITICAL: tests inject flagOverride; clear any inherited value so the
// "flag off" tests don't accidentally pick up a CI environment that has
// CLOUD_INIT_ONDEMAND_ENABLED=true set.
delete process.env.CLOUD_INIT_ONDEMAND_ENABLED;
process.env.NEXTAUTH_URL = process.env.NEXTAUTH_URL || "https://instaclaw.io";
// Stub Supabase env so module-load doesn't choke even though we inject
// our own client via deps.
if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://stub.supabase.co";
}
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";
}

import {
  assignOrProvisionUserVm,
  type AssignedVmShape,
  type CreateUserVMParams,
  type CreateUserVMResult,
  type SupabaseLike,
} from "../lib/createUserVM";

let pass = 0;
let fail = 0;
function assert(cond: boolean, label: string): void {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}`); fail++; }
}

// ════════════════════════════════════════════════════════════════════════
// §1. Mock builders
// ════════════════════════════════════════════════════════════════════════

interface PendingRow {
  tier: string | null;
  api_mode: string | null;
  api_key: string | null;
  default_model: string | null;
  telegram_bot_token: string | null;
  telegram_bot_username: string | null;
  discord_bot_token: string | null;
}

interface UserRow {
  partner: string | null;
  user_timezone: string | null;
}

interface SupabaseStubOpts {
  pending?: PendingRow | null;
  pendingError?: { message: string };
  user?: UserRow | null;
  userError?: { message: string };
}

function makeSupabaseStub(opts: SupabaseStubOpts = {}): SupabaseLike {
  return {
    from(table: string) {
      let _columns = "";
      let _filterValue: string | undefined;
      const chain = {
        select(cols: string) { _columns = cols; return chain; },
        eq(_col: string, val: string) { _filterValue = val; return chain; },
        order() { return chain; },
        limit() { return chain; },
        maybeSingle() {
          void _columns;
          void _filterValue;
          if (table === "instaclaw_pending_users") {
            if (opts.pendingError) return Promise.resolve({ data: null, error: opts.pendingError });
            return Promise.resolve({ data: opts.pending ?? null, error: null });
          }
          if (table === "instaclaw_users") {
            if (opts.userError) return Promise.resolve({ data: null, error: opts.userError });
            return Promise.resolve({ data: opts.user ?? null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
      return chain;
    },
  };
}

interface CreateUserVMFnLog {
  calls: Array<{ params: CreateUserVMParams; deps?: unknown }>;
}

function makeCreateUserVMFn(opts: { throwsOn?: boolean; vmId?: string; vmName?: string; ip?: string } = {}): {
  fn: (p: CreateUserVMParams, deps?: unknown) => Promise<CreateUserVMResult>;
  log: CreateUserVMFnLog;
} {
  const log: CreateUserVMFnLog = { calls: [] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = (async (p: CreateUserVMParams, deps?: unknown) => {
    log.calls.push({ params: p, deps });
    if (opts.throwsOn) throw new Error("mock createUserVM: Linode rate-limit (HTTP 429)");
    return {
      vmId: opts.vmId ?? "vm-uuid-mock",
      vmName: opts.vmName ?? "instaclaw-vm-200",
      providerServerId: "99999",
      ipAddress: opts.ip ?? "172.20.0.50",
      configToken: "deadbeef".repeat(8),
      callbackToken: "feedface".repeat(8),
    } satisfies CreateUserVMResult;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
  return { fn, log };
}

interface PoolAssignLog {
  calls: string[];
}

function makePoolAssignFn(opts: { returnVm?: AssignedVmShape | null } = {}): {
  fn: (userId: string) => Promise<AssignedVmShape | null>;
  log: PoolAssignLog;
} {
  const log: PoolAssignLog = { calls: [] };
  const fn = async (userId: string): Promise<AssignedVmShape | null> => {
    log.calls.push(userId);
    return opts.returnVm ?? null;
  };
  return { fn, log };
}

// ════════════════════════════════════════════════════════════════════════
// §2. Tests
// ════════════════════════════════════════════════════════════════════════

const USER_ID = "e3a32936-fe22-42c9-a53f-72e4c297ce9d";

async function test1_FlagOff_PoolPath() {
  console.log("\n─── TEST 1: flag off → pool path ───");
  const sb = makeSupabaseStub();
  const poolMock = makePoolAssignFn({
    returnVm: {
      id: "pool-vm-id",
      ip_address: "172.20.0.99",
      name: "instaclaw-vm-150",
      telegram_bot_username: "poolbot1",
    },
  });
  const createMock = makeCreateUserVMFn();
  const result = await assignOrProvisionUserVm(USER_ID, {
    supabase: sb,
    poolAssignFn: poolMock.fn,
    createUserVMFn: createMock.fn,
    flagOverride: "",
  });
  assert(result !== null, "result is not null");
  assert(result?.path === "pool", `result.path === "pool" (got ${result?.path})`);
  assert(result?.vmId === "pool-vm-id", "vmId from pool RPC");
  assert(result?.ipAddress === "172.20.0.99", "ipAddress from pool RPC");
  assert(poolMock.log.calls.length === 1, "pool assignFn called once");
  assert(poolMock.log.calls[0] === USER_ID, "pool assignFn called with userId");
  assert(createMock.log.calls.length === 0, "createUserVM NOT called when flag off");
  assert(result?.vm.telegram_bot_username === "poolbot1", "result.vm.telegram_bot_username carried from pool RPC");
}

async function test2_FlagOff_PoolEmpty_ReturnsNull() {
  console.log("\n─── TEST 2: flag off + pool empty → returns null ───");
  const sb = makeSupabaseStub();
  const poolMock = makePoolAssignFn({ returnVm: null });
  const createMock = makeCreateUserVMFn();
  const result = await assignOrProvisionUserVm(USER_ID, {
    supabase: sb,
    poolAssignFn: poolMock.fn,
    createUserVMFn: createMock.fn,
    flagOverride: "",
  });
  assert(result === null, "returns null when pool is empty");
  assert(poolMock.log.calls.length === 1, "pool assignFn was attempted");
  assert(createMock.log.calls.length === 0, "createUserVM NOT called");
}

async function test3_FlagOn_HappyPath() {
  console.log("\n─── TEST 3: flag on + complete pending_users → cloud-init path ───");
  const sb = makeSupabaseStub({
    pending: {
      tier: "pro",
      api_mode: "all_inclusive",
      api_key: null,
      default_model: "anthropic/claude-sonnet-4-6",
      telegram_bot_token: "12345:botFatherToken",
      telegram_bot_username: "cooperbot1",
      discord_bot_token: null,
    },
    user: { partner: null, user_timezone: "America/New_York" },
  });
  const poolMock = makePoolAssignFn();
  const createMock = makeCreateUserVMFn({ vmId: "ondemand-vm-id", ip: "172.20.0.200" });
  const result = await assignOrProvisionUserVm(USER_ID, {
    supabase: sb,
    poolAssignFn: poolMock.fn,
    createUserVMFn: createMock.fn,
    flagOverride: "true",
    nextauthUrl: "https://instaclaw.io",
  });

  assert(result !== null, "result is not null");
  assert(result?.path === "cloud-init", `result.path === "cloud-init" (got ${result?.path})`);
  assert(result?.vmId === "ondemand-vm-id", "vmId from createUserVM");
  assert(result?.ipAddress === "172.20.0.200", "ipAddress from createUserVM");
  assert(poolMock.log.calls.length === 0, "pool assignFn NOT called");
  assert(createMock.log.calls.length === 1, "createUserVM called once");

  const callParams = createMock.log.calls[0].params;
  assert(callParams.userId === USER_ID, "createUserVM called with correct userId");
  assert(callParams.tier === "pro", "tier persisted from pending_users");
  assert(callParams.apiMode === "all_inclusive", "apiMode persisted");
  assert(callParams.defaultModel === "anthropic/claude-sonnet-4-6", "defaultModel persisted");
  assert(callParams.telegramBotToken === "12345:botFatherToken", "telegramBotToken persisted");
  assert(callParams.telegramBotUsername === "cooperbot1", "telegramBotUsername persisted");
  assert(callParams.userTimezone === "America/New_York", "userTimezone persisted from instaclaw_users");
  assert(result?.vm.telegram_bot_username === "cooperbot1", "result.vm.telegram_bot_username set for cloud-init");
}

async function test4_FlagOn_NoPendingRow_Throws() {
  console.log("\n─── TEST 4: flag on + no pending_users row → throws ───");
  const sb = makeSupabaseStub({ pending: null });
  let threw = false;
  let errMsg = "";
  try {
    await assignOrProvisionUserVm(USER_ID, { supabase: sb, flagOverride: "true" });
  } catch (e) {
    threw = true;
    errMsg = (e as Error).message;
  }
  assert(threw, "throws when pending_users row missing");
  assert(/no pending_users row/i.test(errMsg), "error message mentions missing pending_users");
  assert(errMsg.includes(USER_ID), "error message includes userId for forensics");
}

async function test5_FlagOn_MissingTelegramBotToken_Throws() {
  console.log("\n─── TEST 5: flag on + pending exists but telegram_bot_token NULL → throws ───");
  const sb = makeSupabaseStub({
    pending: {
      tier: "starter", api_mode: "all_inclusive", api_key: null, default_model: null,
      telegram_bot_token: null, telegram_bot_username: "willthrow", discord_bot_token: null,
    },
  });
  let threw = false;
  let errMsg = "";
  try {
    await assignOrProvisionUserVm(USER_ID, { supabase: sb, flagOverride: "true" });
  } catch (e) {
    threw = true;
    errMsg = (e as Error).message;
  }
  assert(threw, "throws on missing telegram_bot_token");
  assert(/telegram_bot_token NULL/.test(errMsg), "error message names telegram_bot_token");
  assert(/no sane fallback/i.test(errMsg), "error message explains why no fallback");
  assert(/process-pending will retry/i.test(errMsg), "error message tells caller next cycle retries");
}

async function test6_FlagOn_MissingTelegramBotUsername_Throws() {
  console.log("\n─── TEST 6: flag on + pending exists but telegram_bot_username NULL → throws ───");
  const sb = makeSupabaseStub({
    pending: {
      tier: "starter", api_mode: "all_inclusive", api_key: null, default_model: null,
      telegram_bot_token: "abc:token", telegram_bot_username: null, discord_bot_token: null,
    },
  });
  let threw = false;
  let errMsg = "";
  try {
    await assignOrProvisionUserVm(USER_ID, { supabase: sb, flagOverride: "true" });
  } catch (e) {
    threw = true;
    errMsg = (e as Error).message;
  }
  assert(threw, "throws on missing telegram_bot_username");
  assert(/telegram_bot_username NULL/.test(errMsg), "error message names telegram_bot_username");
}

async function test7_FlagOn_PartnerPropagates() {
  console.log("\n─── TEST 7: flag on + partner set on instaclaw_users → propagates ───");
  const sb = makeSupabaseStub({
    pending: {
      tier: "pro", api_mode: "all_inclusive", api_key: null, default_model: "anthropic/claude-sonnet-4-6",
      telegram_bot_token: "tok", telegram_bot_username: "edgebot1", discord_bot_token: null,
    },
    user: { partner: "edge_city", user_timezone: "America/Los_Angeles" },
  });
  const createMock = makeCreateUserVMFn();
  await assignOrProvisionUserVm(USER_ID, {
    supabase: sb, createUserVMFn: createMock.fn, flagOverride: "true",
  });
  assert(createMock.log.calls.length === 1, "createUserVM called");
  const params = createMock.log.calls[0].params;
  assert(params.partner === "edge_city", "partner='edge_city' propagated to createUserVM");
  assert(params.userTimezone === "America/Los_Angeles", "user_timezone propagated");
}

async function test8_FlagOn_CreateUserVMThrows_PropagatesError() {
  console.log("\n─── TEST 8: flag on + createUserVM throws → wrapper re-throws ───");
  const sb = makeSupabaseStub({
    pending: {
      tier: "starter", api_mode: "all_inclusive", api_key: null, default_model: null,
      telegram_bot_token: "tok", telegram_bot_username: "throwsbot", discord_bot_token: null,
    },
    user: { partner: null, user_timezone: null },
  });
  const createMock = makeCreateUserVMFn({ throwsOn: true });
  let threw = false;
  let errMsg = "";
  try {
    await assignOrProvisionUserVm(USER_ID, {
      supabase: sb, createUserVMFn: createMock.fn, flagOverride: "true",
    });
  } catch (e) {
    threw = true;
    errMsg = (e as Error).message;
  }
  assert(threw, "createUserVM error propagates through wrapper");
  assert(/Linode rate-limit/.test(errMsg), "error message includes original cause from createUserVM");
}

async function test9_FlagOn_FallbackChain() {
  console.log("\n─── TEST 9: flag on + pending fields NULL → fallback defaults applied ───");
  // pending_users exists but tier/api_mode/default_model are NULL — wrapper
  // mirrors /api/vm/configure's fallback chain: "starter" / "all_inclusive" /
  // "anthropic/claude-sonnet-4-6". This protects users whose signup wizard
  // bug left fields blank but who DID populate the telegram_bot_* fields.
  const sb = makeSupabaseStub({
    pending: {
      tier: null, api_mode: null, api_key: null, default_model: null,
      telegram_bot_token: "tok", telegram_bot_username: "fallback_bot", discord_bot_token: null,
    },
    user: null,
  });
  const createMock = makeCreateUserVMFn();
  await assignOrProvisionUserVm(USER_ID, {
    supabase: sb, createUserVMFn: createMock.fn, flagOverride: "true",
  });
  const params = createMock.log.calls[0].params;
  assert(params.tier === "starter", "tier fallback === 'starter'");
  assert(params.apiMode === "all_inclusive", "apiMode fallback === 'all_inclusive'");
  assert(params.defaultModel === "anthropic/claude-sonnet-4-6", "defaultModel fallback === 'anthropic/claude-sonnet-4-6'");
  assert(params.partner === null, "partner null when user row missing");
  assert(params.userTimezone === null, "userTimezone null when user row missing");
}

async function test10_FlagOn_PendingLookupErrorPropagates() {
  console.log("\n─── TEST 10: flag on + pending_users SELECT errors → wrapper throws ───");
  const sb = makeSupabaseStub({
    pendingError: { message: "PostgREST: transient connection lost" },
  });
  let threw = false;
  let errMsg = "";
  try {
    await assignOrProvisionUserVm(USER_ID, { supabase: sb, flagOverride: "true" });
  } catch (e) {
    threw = true;
    errMsg = (e as Error).message;
  }
  assert(threw, "PostgREST error propagates as throw");
  assert(/pending_users lookup failed/i.test(errMsg), "error message names the failed lookup");
  assert(/transient connection lost/.test(errMsg), "underlying error message preserved");
}

async function test11_FlagDefault_DefaultsToPoolPath() {
  console.log("\n─── TEST 11: flag undefined → defaults to pool path ───");
  // Explicitly clear process.env to verify default-off behavior.
  delete process.env.CLOUD_INIT_ONDEMAND_ENABLED;
  const poolMock = makePoolAssignFn({ returnVm: { id: "default-pool", ip_address: "10.0.0.1" } });
  const createMock = makeCreateUserVMFn();
  const result = await assignOrProvisionUserVm(USER_ID, {
    poolAssignFn: poolMock.fn,
    createUserVMFn: createMock.fn,
    // NO flagOverride → wrapper reads process.env (which is unset)
  });
  assert(result?.path === "pool", "default behavior is pool path when env unset");
  assert(poolMock.log.calls.length === 1, "pool assignFn called");
  assert(createMock.log.calls.length === 0, "createUserVM NOT called");
}

async function test12_FlagOn_UniformResultShape() {
  console.log("\n─── TEST 12: both paths return uniform result shape ───");
  // Pool result
  const poolSb = makeSupabaseStub();
  const poolMock = makePoolAssignFn({
    returnVm: { id: "p-id", ip_address: "1.1.1.1", telegram_bot_username: "p_bot", name: "instaclaw-vm-1" },
  });
  const poolResult = await assignOrProvisionUserVm(USER_ID, {
    supabase: poolSb, poolAssignFn: poolMock.fn, flagOverride: "",
  });
  // Cloud-init result
  const ciSb = makeSupabaseStub({
    pending: {
      tier: "starter", api_mode: "all_inclusive", api_key: null, default_model: null,
      telegram_bot_token: "tok", telegram_bot_username: "ci_bot", discord_bot_token: null,
    }, user: null,
  });
  const ciCreate = makeCreateUserVMFn({ vmId: "ci-id", ip: "2.2.2.2" });
  const ciResult = await assignOrProvisionUserVm(USER_ID, {
    supabase: ciSb, createUserVMFn: ciCreate.fn, flagOverride: "true",
  });
  // Both must have the same top-level keys.
  const poolKeys = Object.keys(poolResult!).sort().join(",");
  const ciKeys = Object.keys(ciResult!).sort().join(",");
  assert(poolKeys === ciKeys, `top-level keys identical (pool=${poolKeys} ci=${ciKeys})`);
  // Both must expose vmId, ipAddress, path, vm.{id, ip_address}.
  for (const r of [poolResult, ciResult]) {
    assert(typeof r?.vmId === "string", "vmId is string");
    assert(typeof r?.ipAddress === "string", "ipAddress is string");
    assert(r?.path === "pool" || r?.path === "cloud-init", "path is discriminator");
    assert(typeof r?.vm.id === "string", "vm.id present");
    assert(typeof r?.vm.ip_address === "string", "vm.ip_address present");
  }
}

// ════════════════════════════════════════════════════════════════════════
// §3. Main
// ════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log("════════════════════════════════════════════════════════");
  console.log("assignOrProvisionUserVm synthetic tests");
  console.log("════════════════════════════════════════════════════════");

  await test1_FlagOff_PoolPath();
  await test2_FlagOff_PoolEmpty_ReturnsNull();
  await test3_FlagOn_HappyPath();
  await test4_FlagOn_NoPendingRow_Throws();
  await test5_FlagOn_MissingTelegramBotToken_Throws();
  await test6_FlagOn_MissingTelegramBotUsername_Throws();
  await test7_FlagOn_PartnerPropagates();
  await test8_FlagOn_CreateUserVMThrows_PropagatesError();
  await test9_FlagOn_FallbackChain();
  await test10_FlagOn_PendingLookupErrorPropagates();
  await test11_FlagDefault_DefaultsToPoolPath();
  await test12_FlagOn_UniformResultShape();

  console.log("\n════════════════════════════════════════════════════════");
  if (fail === 0) {
    console.log(`ALL PASS (${pass} assertions)`);
    console.log("════════════════════════════════════════════════════════");
    process.exit(0);
  } else {
    console.log(`FAILED: ${fail}/${pass + fail} assertions`);
    console.log("════════════════════════════════════════════════════════");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Test error:", e);
  process.exit(1);
});
