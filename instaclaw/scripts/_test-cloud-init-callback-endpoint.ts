/**
 * Synthetic test for /api/vm/cloud-init-callback route handler.
 *
 * Covers EARLY-RETURN paths (no DB mocking needed):
 *   1. Missing X-Cloud-Init-Callback-Token header → 401
 *   2. Malformed callback token (not hex, wrong length) → 401
 *   3. Invalid JSON body → 400
 *   4. Missing body fields (userId / vmName / status) → 400
 *   5. Malformed body fields (non-UUID userId, bad vmName) → 400
 *   6. Unsupported status (not "healthy") → 400
 *   7. Non-empty malformed agentbookAddress (not EVM shape) → 400
 *   8. Empty-string agentbookAddress is accepted (passes shape validation)
 *      — verified via reaching the DB call site without 400 (with stubbed
 *      Supabase returning a not-found error, we'd get 401 instead of 400).
 *
 * Run: npx tsx scripts/_test-cloud-init-callback-endpoint.ts
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
    /* file may not exist in CI; tests below don't need DB env */
  }
}

// Stub envs the route's imports might read at module-load.
if (!process.env.NEXTAUTH_URL) process.env.NEXTAUTH_URL = "https://instaclaw.io";
if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://stub.supabase.co";
}
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";
}

import { POST } from "../app/api/vm/cloud-init-callback/route";

let pass = 0;
let fail = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
    pass++;
  } else {
    console.log(`  ✗ ${label}`);
    fail++;
  }
}

interface MakeReqOpts {
  token?: string;
  body?: unknown;
  bodyRaw?: string;
}
function makeReq(opts: MakeReqOpts): import("next/server").NextRequest {
  const url = "https://instaclaw.io/api/vm/cloud-init-callback";
  const headers = new Headers();
  if (opts.token !== undefined) {
    headers.set("X-Cloud-Init-Callback-Token", opts.token);
  }
  headers.set("Content-Type", "application/json");
  const body =
    opts.bodyRaw !== undefined
      ? opts.bodyRaw
      : opts.body !== undefined
        ? JSON.stringify(opts.body)
        : undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Request(url, { method: "POST", headers, body }) as any;
}

const goodToken = "deadbeef".repeat(8); // 64 hex chars
const goodUserId = "e3a32936-fe22-42c9-a53f-72e4c297ce9d";
const goodVmName = "instaclaw-vm-918";
const goodBody = { userId: goodUserId, vmName: goodVmName, agentbookAddress: "", status: "healthy" };

async function main(): Promise<void> {
  console.log("════════════════════════════════════════════════════════");
  console.log("cloud-init-callback endpoint early-return tests");
  console.log("════════════════════════════════════════════════════════\n");

  // ── 1. Missing header → 401 ──
  console.log("─── (1) Missing X-Cloud-Init-Callback-Token header ───");
  {
    const res = await POST(makeReq({ body: goodBody }));
    assert(res.status === 401, "no header → 401");
    const body = await res.text();
    assert(body === "unauthorized", "body == 'unauthorized'");
  }

  // ── 2. Malformed token ──
  console.log("\n─── (2) Malformed callback token ───");
  {
    for (const bad of [
      "",                  // empty
      "short",             // too short
      "g".repeat(64),      // non-hex
      "ab".repeat(15),     // too short (30 chars)
      "ab".repeat(70),     // too long (140 chars)
      "abc def",           // whitespace
    ]) {
      const res = await POST(makeReq({ token: bad, body: goodBody }));
      assert(res.status === 401, `malformed token "${bad.slice(0, 20)}..." → 401`);
    }
  }

  // ── 3. Invalid JSON ──
  console.log("\n─── (3) Invalid JSON body ───");
  {
    const res = await POST(makeReq({ token: goodToken, bodyRaw: "{not-json" }));
    assert(res.status === 400, "invalid JSON → 400");
    const body = await res.text();
    assert(body === "invalid json", "body == 'invalid json'");
  }

  // ── 4. Missing body fields ──
  console.log("\n─── (4) Missing body fields ───");
  {
    const res1 = await POST(makeReq({
      token: goodToken,
      body: { vmName: goodVmName, status: "healthy" }, // missing userId
    }));
    assert(res1.status === 400, "missing userId → 400");

    const res2 = await POST(makeReq({
      token: goodToken,
      body: { userId: goodUserId, status: "healthy" }, // missing vmName
    }));
    assert(res2.status === 400, "missing vmName → 400");

    const res3 = await POST(makeReq({
      token: goodToken,
      body: { userId: goodUserId, vmName: goodVmName }, // missing status
    }));
    assert(res3.status === 400, "missing status → 400");
  }

  // ── 5. Malformed body fields ──
  console.log("\n─── (5) Malformed body fields ───");
  {
    // Malformed userId
    for (const badUser of [
      "not-a-uuid",
      "12345678",
      "e3a32936-fe22-42c9-a53f-72e4c297ce9d-extra",
    ]) {
      const res = await POST(makeReq({
        token: goodToken,
        body: { ...goodBody, userId: badUser },
      }));
      assert(res.status === 400, `malformed userId "${badUser}" → 400`);
    }
    // Malformed vmName
    for (const badVm of [
      "instaclaw-vm-",
      "instaclaw-foo-123",
      "vm-123",
      "instaclaw-vm-918;rm -rf /",
    ]) {
      const res = await POST(makeReq({
        token: goodToken,
        body: { ...goodBody, vmName: badVm },
      }));
      assert(res.status === 400, `malformed vmName "${badVm}" → 400`);
    }
  }

  // ── 6. Unsupported status ──
  console.log("\n─── (6) Unsupported status (not 'healthy') ───");
  {
    for (const bad of ["failed", "pending", "ok", "ready", ""]) {
      const res = await POST(makeReq({
        token: goodToken,
        body: { ...goodBody, status: bad },
      }));
      assert(res.status === 400, `unsupported status "${bad}" → 400`);
    }
  }

  // ── 7. Malformed (non-empty) agentbookAddress ──
  console.log("\n─── (7) Malformed agentbookAddress (non-empty + not EVM) ───");
  {
    for (const bad of [
      "0xshort",
      "not-prefixed-1234567890123456789012345678901234567890",
      "0xZZZZ567890123456789012345678901234567890",
      "undefined",                       // the literal-undefined bug
      "0x123",                           // too short
      "0x" + "a".repeat(41),             // too long
    ]) {
      const res = await POST(makeReq({
        token: goodToken,
        body: { ...goodBody, agentbookAddress: bad },
      }));
      assert(res.status === 400, `malformed agentbookAddress "${bad.slice(0, 30)}" → 400`);
    }
  }

  // ── 8. Empty agentbookAddress is accepted (passes shape) ──
  // We can't fully test happy-path success without DB mocks, but we CAN
  // verify the route doesn't 400 on empty agentbookAddress. With our stub
  // Supabase, the .update().select().single() chain will return an error
  // (no matching row) — the route returns 401 in that case. Either way,
  // we expect 401 (DB-side failure), NOT 400 (shape-side rejection).
  // Stub-env behavior may differ, so we allow 401 OR 500 as both indicate
  // "got past shape validation".
  console.log("\n─── (8) Empty agentbookAddress passes shape validation ───");
  {
    const res = await POST(makeReq({
      token: goodToken,
      body: { ...goodBody, agentbookAddress: "" },
    }));
    assert(
      res.status === 401 || res.status === 500,
      `empty agentbookAddress reaches DB layer (got ${res.status} — 401 or 500 means past shape gates)`,
    );
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

main().catch((e) => {
  console.error("Test error:", e);
  process.exit(1);
});
