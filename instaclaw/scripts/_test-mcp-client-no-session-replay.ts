/**
 * Mechanical test of lib/index-mcp-client.ts post 2026-05-19 fix.
 *
 * Verifies via a fetch mock that:
 *
 *   1. The initialize request does NOT include `mcp-session-id` header.
 *   2. The tools/call request does NOT include `mcp-session-id` header,
 *      even when the initialize response included one. This is the
 *      load-bearing assertion — pre-fix the class would have captured
 *      the response header and replayed it on tools/call, which is the
 *      shape Yanek's server rejects with "Invalid API key".
 *   3. The `x-api-key` header is present on both requests.
 *   4. Success response shape preserves `sessionId: null` (interface
 *      contract held; field always null post-fix).
 *
 * Doesn't hit Yanek's endpoint — pure local mock. Faster and
 * deterministic vs scripts/_probe-mcp-auth-variants.ts variant 6
 * (which is gated on Yanek's dev environment uptime).
 *
 * If this ever starts to fail, it means someone re-introduced the
 * session-id replay (likely without realizing it). Re-read
 * lib/index-mcp-client.ts file-header comment before "fixing" the
 * assertion.
 */
import { IndexMcpClient } from "../lib/index-mcp-client";

// ── Fetch mock ──────────────────────────────────────────────────────
//
// Captures every outgoing fetch call so we can assert on headers.
// Returns a canned response: initialize → 200 + mcp-session-id header,
// tools/call → 200 + SSE-shaped body.

interface CapturedFetch {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

const captured: CapturedFetch[] = [];

const realFetch = globalThis.fetch;
let callCount = 0;

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? String(init.body) : "";
  const headersRecord: Record<string, string> = {};
  const headers = (init?.headers ?? {}) as Record<string, string>;
  for (const k of Object.keys(headers)) {
    headersRecord[k.toLowerCase()] = headers[k];
  }
  captured.push({ url, method: init?.method ?? "GET", headers: headersRecord, body });
  callCount++;

  // First call is initialize. Return a session id in the response header.
  if (callCount === 1) {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: "init-id", result: { protocolVersion: "2025-03-26" } }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "mcp-session-id": "synthetic-session-id-from-server-mock",
      },
    });
  }

  // Second call is tools/call. Return a successful tool result (SSE-shaped).
  const sseBody = [
    "event: message",
    `data: ${JSON.stringify({ jsonrpc: "2.0", id: "call-id", result: { content: [{ type: "text", text: "ok" }], isError: false } })}`,
    "",
  ].join("\n");
  return new Response(sseBody, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
    },
  });
}) as typeof globalThis.fetch;

// ── Test ────────────────────────────────────────────────────────────

async function main() {
  let pass = 0;
  let fail = 0;
  const assert = (cond: boolean, msg: string) => {
    if (cond) { pass++; console.log(`  ✓ ${msg}`); }
    else { fail++; console.log(`  ✗ ${msg}`); }
  };

  console.log("\n=== MCP client no-session-replay test ===\n");

  const client = new IndexMcpClient({ apiKey: "test-key-xyz" });
  const res = await client.callTool("read_intents", {});

  assert(captured.length === 2, `2 fetch calls captured (got ${captured.length})`);

  const [initCall, toolsCall] = captured;

  console.log("\n--- initialize request ---");
  assert(initCall.headers["x-api-key"] === "test-key-xyz", "initialize has x-api-key header");
  assert(!("mcp-session-id" in initCall.headers), "initialize does NOT have mcp-session-id header");
  assert(initCall.method === "POST", "initialize is POST");
  assert(initCall.body.includes('"method":"initialize"'), "initialize body has method=initialize");

  console.log("\n--- tools/call request ---");
  assert(toolsCall.headers["x-api-key"] === "test-key-xyz", "tools/call has x-api-key header");
  assert(
    !("mcp-session-id" in toolsCall.headers),
    "tools/call does NOT have mcp-session-id header (CRITICAL — this is the fix)",
  );
  assert(toolsCall.method === "POST", "tools/call is POST");
  assert(toolsCall.body.includes('"method":"tools/call"'), "tools/call body has method=tools/call");

  console.log("\n--- response shape ---");
  assert(res.ok === true, "callTool returned ok=true");
  if (res.ok) {
    assert(res.sessionId === null, "sessionId is null (interface preserved, value always null post-fix)");
    const content = (res.result as { content?: Array<{ text?: string }> })?.content;
    assert(content?.[0]?.text === "ok", `result.content[0].text === "ok" (got ${JSON.stringify(content)})`);
  }

  // Restore real fetch (defensive — process exits anyway)
  globalThis.fetch = realFetch;

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("✗ test threw:", e);
  process.exit(99);
});
