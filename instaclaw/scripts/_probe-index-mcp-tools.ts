/**
 * Probe the Index Network MCP server to enumerate the tools it exposes.
 *
 * Mcp transport: streamable-http (per Yanek's signup response;
 * mcp.servers.index.transport = 'streamable-http'). Endpoint:
 * https://protocol.dev.index.network/mcp. Auth: x-api-key header with the
 * per-user key.
 *
 * Protocol: standard MCP over HTTP. We do the minimum:
 *   1. POST /mcp with JSON-RPC initialize
 *   2. POST /mcp with JSON-RPC tools/list
 *   3. Print the tool manifest
 *
 * No introspection helper is in @modelcontextprotocol/sdk surfaced by our
 * codebase right now, so we hand-roll the JSON-RPC.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

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

async function mcpCall(
  apiKey: string,
  body: object,
  sessionId?: string,
): Promise<{ status: number; sessionId?: string; data: any; raw: string }> {
  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  const sid = res.headers.get("mcp-session-id") ?? undefined;
  let data: any = null;
  // SSE vs JSON detection
  if (raw.startsWith("event:") || raw.includes("\ndata: ")) {
    // SSE — extract the data: line(s)
    const m = raw.match(/data:\s*(\{[\s\S]*\})/);
    if (m) {
      try {
        data = JSON.parse(m[1]);
      } catch {
        data = { _raw: m[1].slice(0, 500) };
      }
    } else {
      data = { _raw: raw.slice(0, 500), _format: "sse_no_data_line" };
    }
  } else {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { _raw: raw.slice(0, 500), _format: "non_json" };
    }
  }
  return { status: res.status, sessionId: sid, data, raw };
}

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { data: vm } = await sb
    .from("instaclaw_vms")
    .select("name, index_api_key")
    .eq("name", "instaclaw-vm-050")
    .single();

  if (!vm?.index_api_key) {
    console.error("✗ vm-050 has no index_api_key");
    process.exit(1);
  }

  console.log(`MCP URL: ${MCP_URL}`);
  console.log(`Using key: ${vm.index_api_key.slice(0, 8)}…\n`);

  // ── 1. Initialize ──
  console.log("=== Step 1: initialize ===");
  const initId = crypto.randomUUID();
  const init = await mcpCall(vm.index_api_key as string, {
    jsonrpc: "2.0",
    id: initId,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      clientInfo: { name: "instaclaw-probe", version: "0.0.1" },
    },
  });
  console.log(`status: ${init.status}`);
  console.log(`session: ${init.sessionId ?? "(none)"}`);
  console.log("response:");
  console.log(JSON.stringify(init.data, null, 2).slice(0, 1500));
  console.log();

  if (init.status !== 200) {
    console.error("✗ initialize failed; cannot continue");
    process.exit(2);
  }

  // ── 2. tools/list ──
  console.log("=== Step 2: tools/list ===");
  const toolsListResp = await mcpCall(
    vm.index_api_key as string,
    {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/list",
      params: {},
    },
    init.sessionId,
  );
  console.log(`status: ${toolsListResp.status}`);
  const tools = toolsListResp.data?.result?.tools ?? toolsListResp.data?.tools;
  if (Array.isArray(tools)) {
    console.log(`\nFound ${tools.length} tools:\n`);
    for (const t of tools) {
      console.log(`──────────────────────────────────────────────────────`);
      console.log(`name: ${t.name}`);
      console.log(`description: ${(t.description ?? "").slice(0, 400)}`);
      if (t.inputSchema) {
        const props = t.inputSchema.properties ?? {};
        const required = t.inputSchema.required ?? [];
        console.log(`inputSchema.required: ${JSON.stringify(required)}`);
        console.log(`inputSchema.properties keys: ${Object.keys(props).join(", ")}`);
      }
    }
  } else {
    console.log("response (raw):");
    console.log(JSON.stringify(toolsListResp.data, null, 2).slice(0, 2000));
  }
}

main().catch((e) => {
  console.error("✗ probe threw:", e);
  process.exit(99);
});
