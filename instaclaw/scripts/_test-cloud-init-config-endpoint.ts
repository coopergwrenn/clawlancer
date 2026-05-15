/**
 * Synthetic test for /api/vm/cloud-init-config route handler.
 *
 * Covers the EARLY-RETURN paths (no DB or tarball-builder mocking needed):
 *   1. Missing X-Cloud-Init-Config-Token header → 401
 *   2. Malformed config token (not hex, too short) → 401
 *   3. Missing userId or vmName query param → 400
 *   4. Malformed userId (not UUID) → 400
 *   5. Malformed vmName (doesn't match VM_NAME_RE) → 400
 *
 * Happy path + atomic-claim + tarball-build error paths require Supabase
 * mocks that the buildParamsFromVmRow code path also exercises through
 * dependency injection — those are best tested as a separate integration
 * test against a preview Supabase environment (Day 13 in the plan).
 *
 * Run: npx tsx scripts/_test-cloud-init-config-endpoint.ts
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

// Provide a stub NEXTAUTH_URL so route imports don't crash on missing env
// (the early-return paths don't touch this, but the route's imports might).
if (!process.env.NEXTAUTH_URL) process.env.NEXTAUTH_URL = "https://instaclaw.io";
// Provide a dummy SUPABASE_* so the lazy getSupabase() doesn't blow up at
// import time. We don't actually call supabase in the early-return paths.
if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://stub.supabase.co";
}
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";
}

import { GET } from "../app/api/vm/cloud-init-config/route";

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

function makeReq(opts: {
  token?: string;
  userId?: string;
  vmName?: string;
}): import("next/server").NextRequest {
  const base = "https://instaclaw.io/api/vm/cloud-init-config";
  const qp: string[] = [];
  if (opts.userId !== undefined) qp.push(`userId=${encodeURIComponent(opts.userId)}`);
  if (opts.vmName !== undefined) qp.push(`vmName=${encodeURIComponent(opts.vmName)}`);
  const url = qp.length > 0 ? `${base}?${qp.join("&")}` : base;
  const headers = new Headers();
  if (opts.token !== undefined) headers.set("X-Cloud-Init-Config-Token", opts.token);
  // NextRequest constructor accepts a Request-compatible init. The
  // implementation accepts a standard Web Request; tests construct one
  // directly via the global Request.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Request(url, { method: "GET", headers }) as any;
}

async function main() {
  console.log("════════════════════════════════════════════════════════");
  console.log("cloud-init-config endpoint early-return tests");
  console.log("════════════════════════════════════════════════════════\n");

  // ── 1. Missing header → 401 ──
  console.log("─── (1) Missing X-Cloud-Init-Config-Token header ───");
  {
    const res = await GET(makeReq({ userId: "e3a32936-fe22-42c9-a53f-72e4c297ce9d", vmName: "instaclaw-vm-918" }));
    assert(res.status === 401, "no header → 401");
    const body = await res.text();
    assert(body === "unauthorized", "body == 'unauthorized'");
  }

  // ── 2. Malformed token ──
  console.log("\n─── (2) Malformed config token ───");
  {
    for (const bad of [
      "",
      "short",
      "g".repeat(64), // non-hex
      "ab".repeat(15), // too short (only 30 chars)
      "ab".repeat(70), // too long (140 chars)
      "abc def", // whitespace
    ]) {
      const res = await GET(makeReq({
        token: bad,
        userId: "e3a32936-fe22-42c9-a53f-72e4c297ce9d",
        vmName: "instaclaw-vm-918",
      }));
      assert(res.status === 401, `malformed token "${bad.slice(0, 20)}..." → 401`);
    }
  }

  // ── 3. Missing query params ──
  console.log("\n─── (3) Missing query params ───");
  {
    const goodToken = "deadbeef".repeat(8); // 64 hex chars
    const res1 = await GET(makeReq({ token: goodToken, vmName: "instaclaw-vm-918" }));
    assert(res1.status === 400, "missing userId → 400");
    const body1 = await res1.text();
    assert(body1 === "missing params", "body == 'missing params'");

    const res2 = await GET(makeReq({ token: goodToken, userId: "e3a32936-fe22-42c9-a53f-72e4c297ce9d" }));
    assert(res2.status === 400, "missing vmName → 400");
  }

  // ── 4. Malformed userId ──
  console.log("\n─── (4) Malformed userId ───");
  {
    const goodToken = "deadbeef".repeat(8);
    for (const bad of [
      "not-a-uuid",
      "12345678",
      "e3a32936-fe22-42c9-a53f-72e4c297ce9d-extra", // trailing
      "e3a32936fe2242c9a53f72e4c297ce9d", // no dashes
    ]) {
      const res = await GET(makeReq({ token: goodToken, userId: bad, vmName: "instaclaw-vm-918" }));
      assert(res.status === 400, `malformed userId "${bad}" → 400`);
    }
  }

  // ── 5. Malformed vmName ──
  console.log("\n─── (5) Malformed vmName ───");
  {
    const goodToken = "deadbeef".repeat(8);
    const goodUserId = "e3a32936-fe22-42c9-a53f-72e4c297ce9d";
    for (const bad of [
      "instaclaw-vm-",      // empty suffix
      "instaclaw-foo-123",  // wrong prefix
      "vm-123",             // wrong prefix
      "instaclaw-vm-918;rm -rf /", // shell-meta injection attempt
      "instaclaw-vm-918 ",  // trailing whitespace
    ]) {
      const res = await GET(makeReq({ token: goodToken, userId: goodUserId, vmName: bad }));
      assert(res.status === 400, `malformed vmName "${bad}" → 400`);
    }
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
