/**
 * Diagnose the MCP tools/call "Invalid API key" inconsistency by trying
 * variants of headers/cookies/sessions.
 *
 * Observed: `initialize` and `tools/list` succeed with x-api-key header.
 * tools/call (for any tool, read or write) returns isError + "Invalid API
 * key" with the SAME header. Tests:
 *
 *   1. Authorization: Bearer <key> instead of x-api-key
 *   2. Both x-api-key AND Authorization: Bearer
 *   3. Pass mcp-session-id from initialize back on tools/call
 *   4. Cookie-based session (include cookies from initialize)
 *
 * Each variant tries the simplest tool call: read_intents (no params).
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
import { callIndexMcpTool } from "../lib/index-mcp-client";

for (const l of readFileSync(
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "utf-8",
).split("\n")) {
  const m = l.match(/^([^#=]+)=(.*)$/);
  if (m && !process.env[m[1].trim()]) {
    process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const MCP_URL = `${(process.env.INDEX_NETWORK_API_URL?.trim() || "https://protocol.dev.index.network").replace(/\/+$/, "")}/mcp`;

async function send(headers: Record<string, string>, body: object): Promise<{ status: number; respHeaders: Record<string, string>; body: string }> {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
  const respHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => { respHeaders[k] = v; });
  return { status: res.status, respHeaders, body: await res.text() };
}

async function initAndCall(label: string, apiKey: string, variant: (initRespHeaders: Record<string, string>, baseHeaders: Record<string, string>) => Record<string, string>) {
  // 1. initialize
  const initBaseHeaders = { "x-api-key": apiKey };
  const init = await send(initBaseHeaders, {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, clientInfo: { name: "probe", version: "0.0.1" } },
  });
  console.log(`  [${label}] init status=${init.status}`);
  console.log(`  [${label}] init resp headers (interesting): ${JSON.stringify({ sid: init.respHeaders["mcp-session-id"], cookie: init.respHeaders["set-cookie"]?.slice(0, 80) })}`);

  // 2. tools/call read_intents
  const callHeaders = variant(init.respHeaders, initBaseHeaders);
  const call = await send(callHeaders, {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "tools/call",
    params: { name: "read_intents", arguments: {} },
  });
  const isErrorMatch = call.body.match(/"isError":\s*(true|false)/);
  const errorPayload = call.body.match(/data:.*?(\{.*?"text":"[^"]*"[^}]*\})/)?.[1];
  console.log(`  [${label}] tools/call status=${call.status}, isError=${isErrorMatch?.[1] ?? "?"}, payload preview: ${(errorPayload ?? call.body.slice(0, 150)).slice(0, 200)}`);
  console.log();
}

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: vm } = await sb.from("instaclaw_vms").select("name, index_api_key").eq("name", "instaclaw-vm-050").single();
  if (!vm?.index_api_key) { console.error("vm-050 has no key"); process.exit(1); }
  const apiKey = vm.index_api_key as string;
  console.log(`Testing with vm-050 key prefix=${apiKey.slice(0, 8)}…\n`);

  await initAndCall("variant 1: x-api-key only", apiKey, (init, base) => base);
  await initAndCall("variant 2: Authorization Bearer only", apiKey, (init, base) => ({ Authorization: `Bearer ${apiKey}` }));
  await initAndCall("variant 3: both headers", apiKey, (init, base) => ({ ...base, Authorization: `Bearer ${apiKey}` }));
  await initAndCall("variant 4: x-api-key + mcp-session-id", apiKey, (init, base) => init["mcp-session-id"] ? { ...base, "mcp-session-id": init["mcp-session-id"] } : base);

  // Variant 5: try with the cookies the server might've set during initialize
  const initBase = { "x-api-key": apiKey };
  const init5 = await send(initBase, { jsonrpc: "2.0", id: "i", method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, clientInfo: { name: "p", version: "0" } } });
  const setCookie = init5.respHeaders["set-cookie"] ?? "";
  console.log(`  [variant 5: replay set-cookie] set-cookie from init: ${setCookie.slice(0, 120) || "(empty)"}`);
  if (setCookie) {
    // Convert set-cookie to a cookie header for the next request
    const cookieValue = setCookie.split(";")[0]; // name=value
    const call5 = await send({ ...initBase, Cookie: cookieValue }, { jsonrpc: "2.0", id: "c", method: "tools/call", params: { name: "read_intents", arguments: {} } });
    console.log(`  [variant 5] tools/call status=${call5.status} body preview: ${call5.body.slice(0, 200)}`);
  }

  // Variant 6 (added 2026-05-19): IndexMcpClient class via callIndexMcpTool
  // helper. Proves the class works post session-id-replay fix. Pre-fix this
  // variant would have failed identically to variant 4 because the class
  // was sending mcp-session-id on tools/call. Post-fix it should match
  // variant 1's success.
  console.log(`\n  [variant 6: IndexMcpClient class] calling read_intents through lib/index-mcp-client.ts`);
  const v6 = await callIndexMcpTool({ apiKey, toolName: "read_intents", toolArgs: {} });
  if (v6.ok) {
    const text = (v6.result as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? "";
    console.log(`  [variant 6] ✓ PASS — result preview: ${text.slice(0, 150).replace(/\n/g, " ")}`);
  } else {
    console.log(`  [variant 6] ✗ FAIL — error=${v6.error} detail=${(v6.detail ?? "").slice(0, 200)}`);
  }
}

main();
