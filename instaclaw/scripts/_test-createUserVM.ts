/**
 * Synthetic test for lib/createUserVM.ts.
 *
 * Tests cover three layers:
 *   1. Pure validation — boundary checks via validateCreateUserVMParams
 *      (no DB, no Linode).
 *   2. Full-flow happy path — mocked Supabase + mocked CloudProvider.
 *      Verifies row insert content, user_data construction, IP update.
 *   3. Failure modes — vmName collision retries, Linode createServer
 *      throw, IP-update throw.
 *
 * Run: npx tsx scripts/_test-createUserVM.ts
 */
import { readFileSync } from "fs";

// ── Env loading (Rule 18) ──
for (const f of ["/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local"]) {
  try {
    const env = readFileSync(f, "utf-8");
    for (const l of env.split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch { /* tests below pass nextauthUrl explicitly via deps */ }
}
process.env.NEXTAUTH_URL = process.env.NEXTAUTH_URL || "https://instaclaw.io";

import {
  createUserVM,
  validateCreateUserVMParams,
  type CreateUserVMParams,
  type CreateUserVMDeps,
  type SupabaseLike,
} from "../lib/createUserVM";
import type { CloudProvider, ServerResult } from "../lib/providers/types";

let pass = 0;
let fail = 0;
function assert(cond: boolean, label: string): void {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}`); fail++; }
}

// ════════════════════════════════════════════════════════════════════════
// §1. Mock builders
// ════════════════════════════════════════════════════════════════════════

interface MockSupabaseLog {
  inserts: Array<{ table: string; row: Record<string, unknown> }>;
  updates: Array<{ table: string; values: Record<string, unknown>; whereId?: string }>;
  selects: Array<{ table: string; columns: string; orderBy?: string; limitN?: number }>;
}

interface MockSupabaseOpts {
  /** Names to return from the SELECT(name) lookup in allocateVmName. */
  existingNames?: string[];
  /** If set: the Nth insert (0-indexed) returns this UNIQUE-violation error. */
  insertCollisionOn?: number;
  /** If set: every insert returns this generic error (non-recoverable). */
  insertError?: { code: string; message: string };
  /** If set: every update returns this error. */
  updateError?: { message: string };
  /** Generated vm.id for successful inserts. */
  vmId?: string;
}

function makeMockSupabase(opts: MockSupabaseOpts = {}): { sb: SupabaseLike; log: MockSupabaseLog } {
  const log: MockSupabaseLog = { inserts: [], updates: [], selects: [] };
  let insertCallCount = 0;

  const sb = {
    from(table: string) {
      let _columns = "";
      let _orderBy: string | undefined;
      let _limit: number | undefined;
      let _whereId: string | undefined;
      let _updateValues: Record<string, unknown> | null = null;
      let _insertRow: Record<string, unknown> | null = null;

      const chain = {
        select(cols: string) {
          _columns = cols;
          // Differentiate read-select from insert/update result-select.
          if (_insertRow !== null) {
            return chain;
          }
          if (_updateValues !== null) {
            return chain;
          }
          log.selects.push({ table, columns: cols });
          return chain;
        },
        order(col: string, optsArg?: { ascending?: boolean }) {
          _orderBy = `${col} ${optsArg?.ascending ? "asc" : "desc"}`;
          return chain;
        },
        limit(n: number) {
          _limit = n;
          // Materialize the SELECT here (terminal).
          const sel = log.selects[log.selects.length - 1];
          if (sel) {
            sel.orderBy = _orderBy;
            sel.limitN = _limit;
          }
          // If this is the allocateVmName lookup, return the canned existing names
          if (_columns === "name") {
            return Promise.resolve({
              data: (opts.existingNames ?? []).map((n) => ({ name: n })),
              error: null,
            });
          }
          return Promise.resolve({ data: [], error: null });
        },
        insert(row: Record<string, unknown>) {
          _insertRow = row;
          log.inserts.push({ table, row });
          return chain;
        },
        update(values: Record<string, unknown>) {
          _updateValues = values;
          return chain;
        },
        eq(col: string, val: string) {
          if (col === "id") _whereId = val;
          // For update chain, terminal when followed by no .select (or
          // when awaiting the chain).
          if (_updateValues !== null) {
            log.updates.push({ table, values: _updateValues, whereId: _whereId });
            const err = opts.updateError ? { message: opts.updateError.message } : null;
            return Promise.resolve({ data: null, error: err });
          }
          return chain;
        },
        single() {
          // Terminal for insert + select-after-insert.
          if (_insertRow !== null) {
            const idx = insertCallCount++;
            if (opts.insertError) {
              return Promise.resolve({ data: null, error: opts.insertError });
            }
            if (opts.insertCollisionOn === idx) {
              return Promise.resolve({
                data: null,
                error: { code: "23505", message: "duplicate key value violates unique constraint" },
              });
            }
            const newName = _insertRow.name as string;
            return Promise.resolve({
              data: { id: opts.vmId ?? "vm-uuid-mock", name: newName },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
      return chain;
    },
  };

  return { sb, log };
}

interface MockProviderOpts {
  /** If true, createServer throws. */
  createThrows?: boolean;
  /** If true, waitForServer throws. */
  waitThrows?: boolean;
  /** providerId returned from createServer. */
  providerId?: string;
  /** ip returned from waitForServer. */
  ip?: string;
}

function makeMockProvider(opts: MockProviderOpts = {}): { provider: CloudProvider; log: { creates: Array<{ name: string; userData?: string }>; waits: string[] } } {
  const log = { creates: [] as Array<{ name: string; userData?: string }>, waits: [] as string[] };
  const provider: CloudProvider = {
    name: "linode",
    isConfigured: () => true,
    deleteServer: async () => {},
    async createServer(config) {
      log.creates.push({ name: config.name, userData: config.userData });
      if (opts.createThrows) throw new Error("mock: createServer failed");
      const r: ServerResult = {
        providerId: opts.providerId ?? "12345678",
        provider: "linode",
        ip: "",
        name: config.name,
        region: "us-east",
        serverType: "g6-dedicated-2",
        status: "provisioning",
      };
      return r;
    },
    async waitForServer(providerId) {
      log.waits.push(providerId);
      if (opts.waitThrows) throw new Error("mock: waitForServer timeout");
      const r: ServerResult = {
        providerId,
        provider: "linode",
        ip: opts.ip ?? "172.20.0.10",
        name: "test",
        region: "us-east",
        serverType: "g6-dedicated-2",
        status: "running",
      };
      return r;
    },
  };
  return { provider, log };
}

// ════════════════════════════════════════════════════════════════════════
// §2. Tests — validation
// ════════════════════════════════════════════════════════════════════════

const baseParams: CreateUserVMParams = {
  userId: "e3a32936-fe22-42c9-a53f-72e4c297ce9d",
  tier: "starter",
  apiMode: "all_inclusive",
  defaultModel: "anthropic/claude-sonnet-4-6",
  telegramBotToken: "8634795530:AAE17w_5R28NHvYhqohSBfwwhxkCLTWtHYQ",
  telegramBotUsername: "testbot1",
};

async function test1_Validation() {
  console.log("\n─── TEST 1: validateCreateUserVMParams rejection cases ───");
  type Case = [Partial<CreateUserVMParams> & Record<string, unknown>, string];
  const cases: Case[] = [
    [{ userId: "" }, "userId empty"],
    [{ userId: "not-a-uuid" }, "userId not UUID"],
    [{ userId: "e3a32936" }, "userId truncated"],
    [{ tier: "" }, "tier empty"],
    [{ tier: undefined as unknown as string }, "tier undefined"],
    [{ apiMode: "magic" as unknown as "byok" }, "apiMode invalid"],
    [{ apiMode: "byok", apiKey: null }, "byok without apiKey"],
    [{ defaultModel: "" }, "defaultModel empty"],
    [{ telegramBotToken: "" }, "telegramBotToken empty"],
    [{ telegramBotUsername: "" }, "telegramBotUsername empty"],
    [{ telegramBotUsername: "ab" }, "telegramBotUsername too short"],
    [{ telegramBotUsername: "has space" }, "telegramBotUsername has space"],
    [{ channels: [] }, "channels empty array"],
    [{ channels: ["discord"], discordBotToken: null }, "discord without token"],
  ];
  for (const [override, label] of cases) {
    const p = { ...baseParams, ...override } as CreateUserVMParams;
    let threw = false;
    try { validateCreateUserVMParams(p); } catch { threw = true; }
    assert(threw, `rejected: ${label}`);
  }

  // Positive: byok with apiKey is OK
  let okThrew = false;
  try {
    validateCreateUserVMParams({ ...baseParams, apiMode: "byok", apiKey: "sk-ant-test" });
  } catch { okThrew = true; }
  assert(!okThrew, "accepted: byok with apiKey");

  // Positive: discord channel with token is OK
  okThrew = false;
  try {
    validateCreateUserVMParams({ ...baseParams, channels: ["telegram", "discord"], discordBotToken: "discord-token" });
  } catch { okThrew = true; }
  assert(!okThrew, "accepted: discord channel with token");
}

// ════════════════════════════════════════════════════════════════════════
// §3. Tests — full flow (happy path with mocks)
// ════════════════════════════════════════════════════════════════════════

async function test2_HappyPath() {
  console.log("\n─── TEST 2: full-flow happy path ───");
  const { sb, log: sbLog } = makeMockSupabase({ existingNames: ["instaclaw-vm-100"], vmId: "vm-uuid-abc" });
  const { provider, log: provLog } = makeMockProvider({ providerId: "99999", ip: "172.20.0.42" });
  const result = await createUserVM(baseParams, {
    supabase: sb,
    provider,
    nextauthUrl: "https://instaclaw.io",
  });

  // Result shape
  assert(result.vmId === "vm-uuid-abc", "vmId from row insert");
  assert(/^instaclaw-vm-\d+$/.test(result.vmName), "vmName matches naming pattern");
  assert(result.providerServerId === "99999", "providerServerId from Linode");
  assert(result.ipAddress === "172.20.0.42", "ipAddress from waitForServer");
  assert(/^[a-f0-9]{64}$/.test(result.configToken), "configToken is 64-char hex");
  assert(/^[a-f0-9]{64}$/.test(result.callbackToken), "callbackToken is 64-char hex");
  assert(result.configToken !== result.callbackToken, "configToken and callbackToken are distinct");

  // Row insert contents
  const insert = sbLog.inserts[0]!;
  const row = insert.row;
  assert(row.assigned_to === baseParams.userId, "row.assigned_to == userId");
  assert(row.status === "provisioning", "row.status == provisioning");
  assert(row.created_via === "on_demand", "row.created_via == on_demand");
  assert(row.cloud_init_config_token === result.configToken, "row.cloud_init_config_token persisted");
  assert(row.cloud_init_callback_token === result.callbackToken, "row.cloud_init_callback_token persisted");
  assert(row.provider === "linode", "row.provider == linode");
  assert(row.tier === baseParams.tier, "row.tier persisted");
  assert(row.api_mode === baseParams.apiMode, "row.api_mode persisted");
  assert(row.default_model === baseParams.defaultModel, "row.default_model persisted");
  assert(row.telegram_bot_token === baseParams.telegramBotToken, "row.telegram_bot_token persisted");
  assert(row.telegram_bot_username === baseParams.telegramBotUsername, "row.telegram_bot_username persisted");
  assert(Array.isArray(row.channels_enabled) && (row.channels_enabled as string[])[0] === "telegram", "row.channels_enabled default ['telegram']");
  assert(row.region === "us-east", "row.region default us-east");
  assert(row.ssh_user === "openclaw", "row.ssh_user == openclaw");
  assert(row.ssh_port === 22, "row.ssh_port == 22");
  assert(!("ip_address" in row), "row insert does NOT include ip_address (set in Phase C)");
  assert(!("provider_server_id" in row), "row insert does NOT include provider_server_id (set later)");

  // Linode createServer call
  assert(provLog.creates.length === 1, "Linode createServer called once");
  assert(provLog.creates[0].name === result.vmName, "createServer.name == result.vmName");
  assert(typeof provLog.creates[0].userData === "string", "createServer.userData is a string");
  assert(provLog.creates[0].userData!.includes(result.configToken), "user_data embeds configToken");
  assert(provLog.creates[0].userData!.includes(result.vmName), "user_data embeds vmName");
  assert(provLog.creates[0].userData!.includes(baseParams.userId), "user_data embeds userId");
  assert(!provLog.creates[0].userData!.includes(result.callbackToken), "user_data does NOT contain callbackToken (callback_token is in tarball only)");

  // waitForServer
  assert(provLog.waits.length === 1, "waitForServer called once");
  assert(provLog.waits[0] === "99999", "waitForServer called with providerId");

  // Row updates: provider_server_id stamp, then IP
  assert(sbLog.updates.length === 2, "two row updates (provider_server_id stamp + IP)");
  assert(sbLog.updates[0].values.provider_server_id === "99999", "first update stamps provider_server_id");
  assert(sbLog.updates[1].values.ip_address === "172.20.0.42", "second update sets ip_address");
  assert(sbLog.updates[1].values.server_type === "g6-dedicated-2", "second update sets server_type (from waitForServer result)");
}

// ════════════════════════════════════════════════════════════════════════
// §4. Tests — failure modes
// ════════════════════════════════════════════════════════════════════════

async function test3_NameCollisionRetry() {
  console.log("\n─── TEST 3: vmName UNIQUE-collision retry ───");
  const { sb } = makeMockSupabase({ existingNames: ["instaclaw-vm-100"], insertCollisionOn: 0, vmId: "vm-uuid-retry" });
  const { provider } = makeMockProvider({ providerId: "11111", ip: "172.20.0.100" });
  let threw = false;
  let result;
  try {
    result = await createUserVM(baseParams, { supabase: sb, provider, nextauthUrl: "https://instaclaw.io" });
  } catch { threw = true; }
  assert(!threw, "first-attempt 23505 collision triggers retry, NOT throw");
  assert(result !== undefined && result.vmId === "vm-uuid-retry", "retry succeeds and returns the row");
}

async function test4_NameCollisionExhaustion() {
  console.log("\n─── TEST 4: vmName collision exhausts retries → throws ───");
  // Every insert collides — should exhaust retries after 3 attempts.
  const collidingSupabase: SupabaseLike = {
    from() {
      return {
        select() { return this; },
        order() { return this; },
        limit() { return Promise.resolve({ data: [{ name: "instaclaw-vm-100" }], error: null }); },
        insert() { return this; },
        single() {
          return Promise.resolve({
            data: null,
            error: { code: "23505", message: "duplicate key value violates unique constraint" },
          });
        },
      };
    },
  };
  const { provider } = makeMockProvider();
  let threw = false;
  let errMsg = "";
  try {
    await createUserVM(baseParams, { supabase: collidingSupabase, provider, nextauthUrl: "https://instaclaw.io" });
  } catch (e) {
    threw = true;
    errMsg = (e as Error).message;
  }
  assert(threw, "createUserVM throws after exhausting collision retries");
  assert(/vmName allocation failed after 3 attempts/i.test(errMsg), "error message mentions retry exhaustion");
}

async function test5_NonRecoverableInsertError() {
  console.log("\n─── TEST 5: non-23505 insert error fails immediately (no retry) ───");
  const { sb } = makeMockSupabase({
    existingNames: ["instaclaw-vm-100"],
    insertError: { code: "23503", message: "foreign key violation" },
  });
  const { provider } = makeMockProvider();
  let threw = false;
  let errMsg = "";
  try {
    await createUserVM(baseParams, { supabase: sb, provider, nextauthUrl: "https://instaclaw.io" });
  } catch (e) {
    threw = true;
    errMsg = (e as Error).message;
  }
  assert(threw, "non-23505 error throws");
  assert(/row insert failed.*foreign key/i.test(errMsg), "error message includes the underlying message");
}

async function test6_LinodeCreateFails() {
  console.log("\n─── TEST 6: Linode createServer throws — row stays provisioning, error propagates ───");
  const { sb, log: sbLog } = makeMockSupabase({ existingNames: ["instaclaw-vm-100"], vmId: "vm-uuid-stuck" });
  const { provider } = makeMockProvider({ createThrows: true });
  let threw = false;
  try {
    await createUserVM(baseParams, { supabase: sb, provider, nextauthUrl: "https://instaclaw.io" });
  } catch { threw = true; }
  assert(threw, "Linode createServer throw propagates");
  // Row was inserted (Phase A succeeded) but no IP update happened (Phase C never reached).
  assert(sbLog.inserts.length === 1, "row insert succeeded before Linode failure");
  assert(sbLog.updates.length === 0, "no row UPDATE after Linode createServer failure (row stays provisioning)");
}

async function test7_WaitForServerFails() {
  console.log("\n─── TEST 7: waitForServer throws — provider_server_id IS stamped before throw ───");
  const { sb, log: sbLog } = makeMockSupabase({ existingNames: ["instaclaw-vm-100"], vmId: "vm-uuid-wait" });
  const { provider } = makeMockProvider({ providerId: "77777", waitThrows: true });
  let threw = false;
  try {
    await createUserVM(baseParams, { supabase: sb, provider, nextauthUrl: "https://instaclaw.io" });
  } catch { threw = true; }
  assert(threw, "waitForServer throw propagates");
  // provider_server_id should still be stamped (best-effort) so operator
  // can locate the Linode for cleanup.
  assert(sbLog.updates.length === 1, "provider_server_id was stamped before waitForServer throw");
  assert(sbLog.updates[0].values.provider_server_id === "77777", "stamp value matches Linode response");
}

async function test8_NextauthUrlMissing() {
  console.log("\n─── TEST 8: NEXTAUTH_URL missing — throws BEFORE any DB write ───");
  const { sb, log: sbLog } = makeMockSupabase({ existingNames: ["instaclaw-vm-100"] });
  const { provider } = makeMockProvider();
  let threw = false;
  let errMsg = "";
  try {
    await createUserVM(baseParams, { supabase: sb, provider, nextauthUrl: "" });
  } catch (e) {
    threw = true;
    errMsg = (e as Error).message;
  }
  assert(threw, "missing nextauthUrl throws");
  assert(/NEXTAUTH_URL not set/.test(errMsg), "error mentions NEXTAUTH_URL");
  assert(sbLog.inserts.length === 0, "no DB inserts on missing-nextauth (early-return BEFORE Phase A)");
}

// ════════════════════════════════════════════════════════════════════════
// §5. Main
// ════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log("════════════════════════════════════════════════════════");
  console.log("createUserVM synthetic tests (validation + flow + failures)");
  console.log("════════════════════════════════════════════════════════");

  await test1_Validation();
  await test2_HappyPath();
  await test3_NameCollisionRetry();
  await test4_NameCollisionExhaustion();
  await test5_NonRecoverableInsertError();
  await test6_LinodeCreateFails();
  await test7_WaitForServerFails();
  await test8_NextauthUrlMissing();

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
