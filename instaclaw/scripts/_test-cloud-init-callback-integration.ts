/**
 * Happy-path integration test for /api/vm/cloud-init-callback.
 *
 * Closes the Phase 5 risk-assessment gap (2026-05-16):
 *   "No happy-path integration test exists. All my changes pass 186 shape-
 *    validation assertions but no test exercises the full callback UPDATE
 *    payload. The self-test is the integration test."
 *
 * What this test exercises end-to-end (where the existing endpoint test only
 * exercises early-return shape validation):
 *   1. The pre-claim ip_address peek (Step 3 of the route)
 *   2. The atomic claim UPDATE — full payload assertion including all the
 *      column gaps we closed (gateway_url, control_ui_url, assigned_at,
 *      heartbeat_next_at, heartbeat_interval, heartbeat_cycle_calls,
 *      last_health_check, last_gateway_restart, ssh_fail_count,
 *      health_fail_count, status, health_status, cloud_init_callback_
 *      consumed_at, agentbook_wallet_address if applicable)
 *   3. The Rule 33 supplemental writes — instaclaw_users.onboarding_complete=
 *      true + deployment_lock_at=null, and instaclaw_pending_users.consumed_at=
 *      now
 *   4. The idempotent-retry path — when claim returns 0 rows AND prior-
 *      success-state row exists for the same token+user+vm, returns 200
 *      with body { ok: true, idempotent: true }
 *   5. The agentbookAddress write-when-present semantics
 *   6. P0-A fix correctness — gateway_url has the exact http://{ip}:18789
 *      shape from the pre-claim peek's ip_address
 *
 * What this test does NOT exercise:
 *   - The Next.js after() background TLS upgrade block. after() registers a
 *     callback with the Next.js runtime, which is absent in a synthetic test.
 *     The callback either no-ops or logs a stack — either way the test
 *     completes before any TLS code path runs. Live TLS behavior remains
 *     exercised manually via Cooper's self-test against a real Linode VM.
 *
 * Mock architecture: substitute the supabase client via the
 * `__setSupabaseForTests` escape hatch in lib/supabase.ts (added 2026-05-16).
 * The mock implements the supabase-js fluent chain (.from().select()/.update()/
 * .eq()/.is()/.not()/.maybeSingle()/.single()), records every call's table +
 * payload + filters, and returns programmed responses in FIFO order per
 * (table, primary-op) tuple.
 *
 * Run: npx tsx scripts/_test-cloud-init-callback-integration.ts
 */
import { readFileSync } from "fs";

// ── Env loading (CLAUDE.md Rule 18) ──
for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
]) {
  try {
    const env = readFileSync(f, "utf-8");
    for (const l of env.split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* file may not exist in CI */
  }
}
if (!process.env.NEXTAUTH_URL) process.env.NEXTAUTH_URL = "https://instaclaw.io";
if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://stub.supabase.co";
}
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";
}

import { __setSupabaseForTests } from "@/lib/supabase";
import { POST } from "../app/api/vm/cloud-init-callback/route";

// ════════════════════════════════════════════════════════════════════════
// Mock supabase
// ════════════════════════════════════════════════════════════════════════

interface RecordedOp {
  m: string;
  args: unknown[];
}
interface RecordedQuery {
  table: string;
  ops: RecordedOp[];
}
interface ProgrammedResponse {
  data: unknown;
  error: { message: string; code?: string } | null;
}

class MockQuery {
  table: string;
  ops: RecordedOp[] = [];
  private parent: MockSupabase;
  constructor(table: string, parent: MockSupabase) {
    this.table = table;
    this.parent = parent;
  }
  select(...args: unknown[]): this { this.ops.push({ m: "select", args }); return this; }
  update(...args: unknown[]): this { this.ops.push({ m: "update", args }); return this; }
  insert(...args: unknown[]): this { this.ops.push({ m: "insert", args }); return this; }
  eq(...args: unknown[]): this { this.ops.push({ m: "eq", args }); return this; }
  is(...args: unknown[]): this { this.ops.push({ m: "is", args }); return this; }
  not(...args: unknown[]): this { this.ops.push({ m: "not", args }); return this; }
  limit(...args: unknown[]): this { this.ops.push({ m: "limit", args }); return this; }
  order(...args: unknown[]): this { this.ops.push({ m: "order", args }); return this; }

  private resolve(): Promise<ProgrammedResponse> {
    this.parent.recordedQueries.push({ table: this.table, ops: [...this.ops] });
    // Determine primary op (the one that decides what data shape to return)
    const primaryOp =
      this.ops.find((o) => ["update", "insert"].includes(o.m))?.m ??
      this.ops.find((o) => o.m === "select")?.m ??
      "select";
    const key = `${this.table}:${primaryOp}`;
    const queue = this.parent.programmedResponses.get(key);
    if (!queue || queue.length === 0) {
      return Promise.resolve({
        data: null,
        error: { message: `MockSupabase: no programmed response for "${key}" (call #${this.parent.recordedQueries.length})` },
      });
    }
    return Promise.resolve(queue.shift()!);
  }
  maybeSingle(): Promise<ProgrammedResponse> { return this.resolve(); }
  single(): Promise<ProgrammedResponse> { return this.resolve(); }
  // For bare-await (returns array of rows in real supabase-js)
  then<TResult1 = ProgrammedResponse, TResult2 = never>(
    onFulfilled?: ((value: ProgrammedResponse) => TResult1 | PromiseLike<TResult1>) | null | undefined,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null | undefined,
  ): Promise<TResult1 | TResult2> {
    return this.resolve().then(onFulfilled, onRejected);
  }
}

class MockSupabase {
  recordedQueries: RecordedQuery[] = [];
  programmedResponses: Map<string, ProgrammedResponse[]> = new Map();
  from(table: string): MockQuery { return new MockQuery(table, this); }
  program(tableOp: string, response: ProgrammedResponse): void {
    if (!this.programmedResponses.has(tableOp)) this.programmedResponses.set(tableOp, []);
    this.programmedResponses.get(tableOp)!.push(response);
  }
  reset(): void {
    this.recordedQueries = [];
    this.programmedResponses.clear();
  }
}

// ════════════════════════════════════════════════════════════════════════
// Test scaffolding
// ════════════════════════════════════════════════════════════════════════

let pass = 0;
let fail = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    console.log(`    ✓ ${label}`);
    pass++;
  } else {
    console.log(`    ✗ ${label}`);
    fail++;
  }
}

interface MakeReqOpts { token?: string; body?: unknown; bodyRaw?: string }
function makeReq(opts: MakeReqOpts): import("next/server").NextRequest {
  const url = "https://instaclaw.io/api/vm/cloud-init-callback";
  const headers = new Headers();
  if (opts.token !== undefined) headers.set("X-Cloud-Init-Callback-Token", opts.token);
  headers.set("Content-Type", "application/json");
  const body = opts.bodyRaw !== undefined ? opts.bodyRaw : opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Request(url, { method: "POST", headers, body }) as any;
}

const VM_ID = "11111111-2222-3333-4444-555555555555";
const VM_NAME = "instaclaw-vm-999";
const USER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const TOKEN = "abcdef01".repeat(8); // 64-char hex
const IP = "203.0.113.42"; // RFC5737 documentation prefix
const EXPECTED_GATEWAY_URL = `http://${IP}:18789`;

// Helper to find a specific recorded query by table + primary op
function findQuery(mock: MockSupabase, table: string, primaryOp: string): RecordedQuery | undefined {
  return mock.recordedQueries.find((q) => {
    if (q.table !== table) return false;
    const primary = q.ops.find((o) => ["update", "insert"].includes(o.m))?.m ??
      q.ops.find((o) => o.m === "select")?.m;
    return primary === primaryOp;
  });
}

function updatePayload(q: RecordedQuery): Record<string, unknown> {
  return (q.ops.find((o) => o.m === "update")?.args[0] ?? {}) as Record<string, unknown>;
}

// ════════════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════════════

async function test_happyPath_emptyAgentbookAddress(): Promise<void> {
  console.log("\n─── (1) Happy path: empty agentbookAddress ───");
  const mock = new MockSupabase();
  __setSupabaseForTests(mock);

  // Program: pre-claim peek returns ip_address
  mock.program("instaclaw_vms:select", { data: { ip_address: IP }, error: null });
  // Program: atomic claim returns the post-claim row (now includes telegram_bot_username)
  mock.program("instaclaw_vms:update", {
    data: { id: VM_ID, name: VM_NAME, partner: null, agentbook_wallet_address: null, gateway_url: EXPECTED_GATEWAY_URL, telegram_bot_username: "test_agent_bot" },
    error: null,
  });
  // Program: instaclaw_users update success
  mock.program("instaclaw_users:update", { data: null, error: null });
  // Program: instaclaw_pending_users update success
  mock.program("instaclaw_pending_users:update", { data: null, error: null });
  // Program: instaclaw_users select for email (sendVMReadyEmail prep)
  mock.program("instaclaw_users:select", { data: { email: "test+integration@instaclaw.io" }, error: null });

  const res = await POST(makeReq({
    token: TOKEN,
    body: { userId: USER_ID, vmName: VM_NAME, agentbookAddress: "", status: "healthy" },
  }));

  assert(res.status === 200, "response status 200");
  const body = (await res.json()) as { ok?: boolean; idempotent?: boolean };
  assert(body.ok === true, "body.ok === true");
  assert(body.idempotent === undefined, "body.idempotent NOT set (this is a first-success, not a retry)");

  // ── Assert the atomic claim's UPDATE payload — P0-A + P0-C + 8 column gaps ──
  const claimQuery = findQuery(mock, "instaclaw_vms", "update");
  assert(!!claimQuery, "instaclaw_vms.update was called");
  if (!claimQuery) return;
  const payload = updatePayload(claimQuery);

  // P0-A — gateway_url + control_ui_url constructed from ip_address
  assert(payload.gateway_url === EXPECTED_GATEWAY_URL, `payload.gateway_url === "${EXPECTED_GATEWAY_URL}"`);
  assert(payload.control_ui_url === EXPECTED_GATEWAY_URL, "payload.control_ui_url === gateway_url");

  // State transitions
  assert(payload.status === "assigned", "payload.status === 'assigned'");
  assert(payload.health_status === "healthy", "payload.health_status === 'healthy'");
  assert(typeof payload.cloud_init_callback_consumed_at === "string", "payload.cloud_init_callback_consumed_at is ISO string");

  // Column-gap closures (pool-path parity)
  assert(typeof payload.assigned_at === "string", "payload.assigned_at is ISO string (pool RPC parity)");
  assert(typeof payload.last_health_check === "string", "payload.last_health_check set");
  assert(typeof payload.last_gateway_restart === "string", "payload.last_gateway_restart set");
  assert(payload.ssh_fail_count === 0, "payload.ssh_fail_count === 0 (configureOpenClaw parity)");
  assert(payload.health_fail_count === 0, "payload.health_fail_count === 0");
  assert(typeof payload.heartbeat_next_at === "string", "payload.heartbeat_next_at set (CRITICAL — PROVISIONING_BLOCKED guard)");
  assert(payload.heartbeat_interval === "3h", "payload.heartbeat_interval === '3h'");
  assert(payload.heartbeat_cycle_calls === 0, "payload.heartbeat_cycle_calls === 0");

  // Should NOT include agentbook_wallet_address (empty string was sent → skipped per spec)
  assert(!("agentbook_wallet_address" in payload), "payload does NOT include agentbook_wallet_address (empty input → skip)");

  // ── Assert heartbeat_next_at is roughly NOW + 3h ──
  const heartbeatAt = new Date(payload.heartbeat_next_at as string).getTime();
  const nowMs = Date.now();
  const expectedHeartbeatMs = nowMs + 10_800_000; // 3h
  const heartbeatDelta = Math.abs(heartbeatAt - expectedHeartbeatMs);
  assert(heartbeatDelta < 10_000, `heartbeat_next_at within 10s of NOW+3h (delta=${heartbeatDelta}ms)`);

  // ── Assert P0-C: instaclaw_users.onboarding_complete=true ──
  const userQuery = findQuery(mock, "instaclaw_users", "update");
  assert(!!userQuery, "instaclaw_users.update was called");
  if (userQuery) {
    const userPayload = updatePayload(userQuery);
    assert(userPayload.onboarding_complete === true, "users.onboarding_complete === true (Rule 33 fix)");
    assert(userPayload.deployment_lock_at === null, "users.deployment_lock_at === null");
    // Check that WHERE clause is by userId
    const eqOp = userQuery.ops.find((o) => o.m === "eq");
    assert(eqOp?.args[0] === "id" && eqOp?.args[1] === USER_ID, "users WHERE id = userId");
  }

  // ── Assert P0-C: pending_users.consumed_at set ──
  const pendingQuery = findQuery(mock, "instaclaw_pending_users", "update");
  assert(!!pendingQuery, "instaclaw_pending_users.update was called");
  if (pendingQuery) {
    const pendingPayload = updatePayload(pendingQuery);
    assert(typeof pendingPayload.consumed_at === "string", "pending.consumed_at set to ISO string");
    const eqOp = pendingQuery.ops.find((o) => o.m === "eq");
    assert(eqOp?.args[0] === "user_id" && eqOp?.args[1] === USER_ID, "pending WHERE user_id = userId");
  }

  // ── Atomic claim filters ──
  if (claimQuery) {
    const eqOps = claimQuery.ops.filter((o) => o.m === "eq");
    const isOps = claimQuery.ops.filter((o) => o.m === "is");
    assert(eqOps.some((o) => o.args[0] === "cloud_init_callback_token" && o.args[1] === TOKEN), "claim filters by token");
    assert(eqOps.some((o) => o.args[0] === "assigned_to" && o.args[1] === USER_ID), "claim filters by user");
    assert(eqOps.some((o) => o.args[0] === "name" && o.args[1] === VM_NAME), "claim filters by vmName");
    assert(eqOps.some((o) => o.args[0] === "status" && o.args[1] === "provisioning"), "claim filters status='provisioning'");
    assert(isOps.some((o) => o.args[0] === "cloud_init_callback_consumed_at" && o.args[1] === null), "claim filters consumed_at IS NULL");
  }

  // ── Assert sendVMReadyEmail prep: instaclaw_users select for email ──
  // (the email itself is sent in after(), which is unreachable in synthetic tests)
  const emailSelectQuery = mock.recordedQueries.find((q) =>
    q.table === "instaclaw_users" &&
    q.ops.some((o) => o.m === "select" && (o.args[0] as string)?.includes("email")),
  );
  assert(!!emailSelectQuery, "instaclaw_users.select('email') was called for VM-ready notification");
  if (emailSelectQuery) {
    const eqOp = emailSelectQuery.ops.find((o) => o.m === "eq");
    assert(eqOp?.args[0] === "id" && eqOp?.args[1] === USER_ID, "email select WHERE id = userId");
  }

  __setSupabaseForTests(null);
}

async function test_happyPath_withAgentbookAddress(): Promise<void> {
  console.log("\n─── (2) Happy path: valid EVM agentbookAddress ───");
  const evmAddr = "0xabcdef0123456789abcdef0123456789abcdef01";
  const mock = new MockSupabase();
  __setSupabaseForTests(mock);

  mock.program("instaclaw_vms:select", { data: { ip_address: IP }, error: null });
  mock.program("instaclaw_vms:update", {
    data: { id: VM_ID, name: VM_NAME, partner: null, agentbook_wallet_address: evmAddr, gateway_url: EXPECTED_GATEWAY_URL },
    error: null,
  });
  mock.program("instaclaw_users:update", { data: null, error: null });
  mock.program("instaclaw_pending_users:update", { data: null, error: null });

  const res = await POST(makeReq({
    token: TOKEN,
    body: { userId: USER_ID, vmName: VM_NAME, agentbookAddress: evmAddr, status: "healthy" },
  }));

  assert(res.status === 200, "response status 200");
  const claimQuery = findQuery(mock, "instaclaw_vms", "update");
  if (claimQuery) {
    const payload = updatePayload(claimQuery);
    assert(payload.agentbook_wallet_address === evmAddr, "payload.agentbook_wallet_address === provided EVM address");
  }

  __setSupabaseForTests(null);
}

async function test_idempotentRetry(): Promise<void> {
  console.log("\n─── (3) Idempotent retry — atomic claim returns 0 rows, prior-success row exists ───");
  const mock = new MockSupabase();
  __setSupabaseForTests(mock);

  // 1. Pre-claim peek finds ip_address (the row still exists, just past the consumed_at gate)
  mock.program("instaclaw_vms:select", { data: { ip_address: IP }, error: null });
  // 2. Atomic claim returns 0 rows — `.single()` resolves with no-rows error
  mock.program("instaclaw_vms:update", { data: null, error: { message: "no rows updated", code: "PGRST116" } });
  // 3. Idempotency-check SELECT finds the prior-success row (callback already succeeded)
  mock.program("instaclaw_vms:select", {
    data: {
      id: VM_ID, name: VM_NAME, partner: null,
      agentbook_wallet_address: null,
      cloud_init_callback_consumed_at: "2026-05-16T18:00:00.000Z",
      gateway_url: EXPECTED_GATEWAY_URL,
    },
    error: null,
  });

  const res = await POST(makeReq({
    token: TOKEN,
    body: { userId: USER_ID, vmName: VM_NAME, agentbookAddress: "", status: "healthy" },
  }));

  assert(res.status === 200, "idempotent retry returns 200 (not 401)");
  const body = (await res.json()) as { ok?: boolean; idempotent?: boolean };
  assert(body.ok === true, "body.ok === true");
  assert(body.idempotent === true, "body.idempotent === true (distinguishes from first-success)");

  // Should NOT have written to instaclaw_users on idempotent retry (that already happened on first success)
  const userQuery = findQuery(mock, "instaclaw_users", "update");
  assert(!userQuery, "instaclaw_users.update was NOT called on idempotent retry");

  __setSupabaseForTests(null);
}

async function test_preClaimPeekFails(): Promise<void> {
  console.log("\n─── (4) Pre-claim peek finds nothing → 401 (no DB mutation) ───");
  const mock = new MockSupabase();
  __setSupabaseForTests(mock);

  // Pre-claim peek returns nothing (token doesn't match any row)
  mock.program("instaclaw_vms:select", { data: null, error: null });

  const res = await POST(makeReq({
    token: TOKEN,
    body: { userId: USER_ID, vmName: VM_NAME, agentbookAddress: "", status: "healthy" },
  }));

  assert(res.status === 401, "auth-fail returns 401");
  assert(mock.recordedQueries.length === 1, "ONLY the pre-claim peek ran (no UPDATE attempted)");

  __setSupabaseForTests(null);
}

async function test_preClaimPeekReturnsNullIp(): Promise<void> {
  console.log("\n─── (5) Pre-claim peek returns row with NULL ip_address → 401 (corrupt provision) ───");
  const mock = new MockSupabase();
  __setSupabaseForTests(mock);

  // Pre-claim peek returns a row but ip_address is missing
  mock.program("instaclaw_vms:select", { data: { ip_address: null }, error: null });

  const res = await POST(makeReq({
    token: TOKEN,
    body: { userId: USER_ID, vmName: VM_NAME, agentbookAddress: "", status: "healthy" },
  }));

  assert(res.status === 401, "NULL ip_address rejected (cannot build gateway_url)");
  assert(mock.recordedQueries.length === 1, "ONLY the pre-claim peek ran (no UPDATE attempted)");

  __setSupabaseForTests(null);
}

async function test_userUpdateFailureNonFatal(): Promise<void> {
  console.log("\n─── (6) instaclaw_users update failure does NOT block 200 response ───");
  const mock = new MockSupabase();
  __setSupabaseForTests(mock);

  mock.program("instaclaw_vms:select", { data: { ip_address: IP }, error: null });
  mock.program("instaclaw_vms:update", {
    data: { id: VM_ID, name: VM_NAME, partner: null, agentbook_wallet_address: null, gateway_url: EXPECTED_GATEWAY_URL },
    error: null,
  });
  // Simulate instaclaw_users update FAILURE
  mock.program("instaclaw_users:update", { data: null, error: { message: "users update failed (synthetic)" } });
  // pending_users still succeeds
  mock.program("instaclaw_pending_users:update", { data: null, error: null });

  const res = await POST(makeReq({
    token: TOKEN,
    body: { userId: USER_ID, vmName: VM_NAME, agentbookAddress: "", status: "healthy" },
  }));

  // Per the code comments: "Best-effort: catch + log on either UPDATE failure,
  //  but return 200 so setup.sh doesn't retry the callback"
  assert(res.status === 200, "users update failure does NOT block 200 response (setup.sh idempotency)");

  __setSupabaseForTests(null);
}

// ════════════════════════════════════════════════════════════════════════
// Run
// ════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log("════════════════════════════════════════════════════════");
  console.log("cloud-init-callback HAPPY-PATH integration tests");
  console.log("════════════════════════════════════════════════════════");

  try {
    await test_happyPath_emptyAgentbookAddress();
    await test_happyPath_withAgentbookAddress();
    await test_idempotentRetry();
    await test_preClaimPeekFails();
    await test_preClaimPeekReturnsNullIp();
    await test_userUpdateFailureNonFatal();
  } catch (e) {
    console.error("\nTest threw unexpectedly:", e);
    fail++;
  }

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

main();
